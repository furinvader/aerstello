import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseTargetedValidationCommand, unionInitialValidationSelection, unionRequiredValidation,
  validateInitialValidationSelection, reviewRequestUsage,
} from '../../contracts/contracts.mjs';
import {
  atomicWriteJson, canonicalSerializedJson, readJsonSidecar, serializeJson,
} from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import { assertValidationBaseAncestry, gitSnapshot } from '../git-authority.mjs';
import { appendEvent } from '../journal.mjs';
import { stateDirectory, validationPlanPath } from '../locations.mjs';
import { migratePrReviewStateV2 } from '../migrations.mjs';
import { loadState, readStateDocument } from '../state-store.mjs';
import { loadBoundTaskPackets, readBoundTaskBindingProvenance } from './task-binding.mjs';
import { assertBoundTaskPacket, readTaskPacketSidecar, taskPacketDigest } from './task-packets.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
const VALIDATION_PLAN_LIMIT_BYTES = 64 * 1024;
const VALIDATION_AREAS = new Set(['api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration']);
const VALIDATION_PLANNING_PHASES = new Set(['recovering', 'ready-for-review', 'integrating', 'verifying', 'validating']);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
function utcNow() { return new Date().toISOString(); }
function sameEvidence(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function staleDiscoveryDispositionForRequest(state, requestId = state?.reviewRequest?.id) {
  const records = Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
  return records.find((item) => item.requestId === requestId) ?? null;
}
function materializeValidationArgv(command, argv, state, headSha) {
  const parsed = parseTargetedValidationCommand(command);
  if (!parsed) return null;
  if (command !== 'git diff --check') {
    return JSON.stringify(argv) === JSON.stringify(parsed) ? [...argv] : null;
  }
  if (!SHA.test(state.baseSha ?? '') || !SHA.test(headSha ?? '')) return null;
  const expected = ['git', 'diff', '--check', state.baseSha, headSha, '--'];
  return JSON.stringify(argv) === JSON.stringify(parsed)
      || JSON.stringify(argv) === JSON.stringify(expected) ? expected : null;
}
function readBoundPacketWithProvenance(cwd, state, task, options = {}) {
  const packet = readTaskPacketSidecar(cwd, state, task, options);
  readBoundTaskBindingProvenance(cwd, state, task, packet);
  return packet;
}

export function relatedE2EMetadata(argv) {
  if (argv.slice(0, 4).join(' ') !== 'npm run test:e2e:related --') return null;
  const selectors = [];
  const projects = [];
  for (let index = 4; index < argv.length; index += 1) {
    const [option, inlineValue] = argv[index].split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (option === '--project') projects.push(value);
    else if (option === '--id') {
      const normalized = value.replace(/^@/u, '');
      selectors.push(normalized.startsWith('id-') ? normalized : `id-${normalized}`);
    } else if (option === '--tag') selectors.push(value.replace(/^@/u, ''));
  }
  return { selectors, projects: projects.length > 0 ? projects : ['tablet-chromium'] };
}

export function validateValidationPlan(plan, state) {
  const errors = [];
  const fields = ['schemaVersion', 'prNumber', 'stateRevision', 'headSha', 'taskIds', 'affectedAreas', 'commands', 'createdAt', 'updatedAt'];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['plan must be a JSON object'];
  for (const field of fields) if (!Object.prototype.hasOwnProperty.call(plan, field)) errors.push(`plan.${field} is required`);
  for (const field of Object.keys(plan)) if (!fields.includes(field)) errors.push(`plan.${field} is not allowed`);
  if (plan.schemaVersion !== 1) errors.push('plan.schemaVersion must be 1');
  if (plan.prNumber !== state.prNumber) errors.push('plan.prNumber must match active state');
  if (plan.stateRevision !== state.revision) errors.push('plan.stateRevision is stale');
  if (plan.headSha !== state.currentIntegrationHeadSha) errors.push('plan.headSha is stale');
  if (!Array.isArray(plan.taskIds)
      || plan.taskIds.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(plan.taskIds).size !== plan.taskIds.length) errors.push('plan.taskIds must be unique nonempty strings');
  if (!Array.isArray(plan.affectedAreas) || plan.affectedAreas.some((area) => !VALIDATION_AREAS.has(area))
      || new Set(plan.affectedAreas).size !== plan.affectedAreas.length) errors.push('plan.affectedAreas must be unique strings');
  if (!Array.isArray(plan.commands) || plan.commands.length === 0) errors.push('plan.commands must not be empty');
  else {
    const seen = new Set();
    for (const [index, entry] of plan.commands.entries()) {
      const prefix = `plan.commands[${index}]`;
      const entryFields = ['kind', 'command', 'reason', 'selectors', 'projects', 'argv', 'status', 'exitCode', 'summary', 'completedAt'];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      for (const field of entryFields) if (!Object.prototype.hasOwnProperty.call(entry, field)) errors.push(`${prefix}.${field} is required`);
      for (const field of Object.keys(entry)) if (!entryFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
      const executionArgv = materializeValidationArgv(entry.command, entry.argv, state, plan.headSha);
      if (!executionArgv) errors.push(`${prefix} is not a supported exact command`);
      if (!['unit', 'system'].includes(entry.kind)) errors.push(`${prefix}.kind is invalid`);
      if (typeof entry.reason !== 'string' || entry.reason.length < 1 || entry.reason.length > 1000) errors.push(`${prefix}.reason is invalid`);
      for (const field of ['selectors', 'projects']) {
        if (!Array.isArray(entry[field]) || entry[field].some((item) => typeof item !== 'string')
            || new Set(entry[field]).size !== entry[field].length) errors.push(`${prefix}.${field} is invalid`);
      }
      const e2eMetadata = executionArgv ? relatedE2EMetadata(executionArgv) : null;
      if (entry.kind === 'unit' && (entry.selectors?.length > 0 || entry.projects?.length > 0)) errors.push(`${prefix} unit metadata must be empty`);
      if (entry.kind === 'system' && e2eMetadata === null && (entry.selectors?.length > 0 || entry.projects?.length > 0)) errors.push(`${prefix} non-E2E metadata must be empty`);
      if (entry.kind === 'system' && e2eMetadata !== null
          && (JSON.stringify(entry.selectors) !== JSON.stringify(e2eMetadata.selectors)
            || JSON.stringify(entry.projects) !== JSON.stringify(e2eMetadata.projects))) errors.push(`${prefix} E2E metadata must match command scope`);
      if (seen.has(entry.command)) errors.push(`${prefix}.command is duplicated`);
      seen.add(entry.command);
      if (!['pending', 'passed', 'failed'].includes(entry.status)) errors.push(`${prefix}.status is invalid`);
      if (entry.status === 'pending') {
        if (entry.exitCode !== null || entry.summary !== null || entry.completedAt !== null) errors.push(`${prefix} pending result must be empty`);
      } else {
        if (!Number.isInteger(entry.exitCode) || entry.exitCode < 0) errors.push(`${prefix}.exitCode is invalid`);
        if (typeof entry.summary !== 'string' || entry.summary.length < 1 || entry.summary.length > 500) errors.push(`${prefix}.summary is invalid`);
        if (typeof entry.completedAt !== 'string' || !Number.isFinite(Date.parse(entry.completedAt))) errors.push(`${prefix}.completedAt is invalid`);
        if ((entry.status === 'passed') !== (entry.exitCode === 0)) errors.push(`${prefix}.status contradicts exitCode`);
      }
    }
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof plan[field] !== 'string' || !Number.isFinite(Date.parse(plan[field]))) errors.push(`plan.${field} is invalid`);
  }
  return errors;
}

export function readValidationPlan(cwd, state) {
  const path = validationPlanPath(cwd, state.prNumber);
  if (!existsSync(path)) throw new StateError(`No saved targeted validation plan at ${path}`, 'VALIDATION_PLAN_NOT_FOUND');
  let plan;
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > VALIDATION_PLAN_LIMIT_BYTES) throw new Error('plan exceeds 64 KiB');
    plan = JSON.parse(source);
  } catch (error) {
    throw new StateError(`Unable to read targeted validation plan: ${error.message}`, 'INVALID_VALIDATION_PLAN');
  }
  const errors = validateValidationPlan(plan, state);
  if (errors.length > 0) throw new StateError(`Invalid targeted validation plan:\n- ${errors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
  return plan;
}

function assertCleanExactIntegrationCheckout(state) {
  const actual = gitSnapshot(state.integrationWorktree);
  if (actual.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('Integration HEAD differs from active state; checkpoint Git metadata first', 'VALIDATION_PLAN_STALE');
  }
  if (actual.dirty) throw new StateError('Integration checkout must be clean for targeted validation', 'VALIDATION_CHECKOUT_DIRTY');
  return actual;
}

export function actionableIntegratedTaskIds(state) {
  return state.tasks.filter((task) => task.disposition === 'actionable' && task.status === 'integrated')
    .map((task) => task.id).sort();
}

export function actionablePacketValidationTaskIds(state) {
  return state.tasks.filter((task) => task.disposition === 'actionable'
    && (task.status === 'integrated'
      || (task.status === 'completed' && typeof task.taskPacketDigest === 'string')))
    .map((task) => task.id).sort();
}

export function isPristineTasklessValidationSelection(state, expectedIds) {
  return state.reviewRound === 0 && state.reviewRequest === null && state.reviewHistory.length === 0
    && state.tasks.length === 0 && expectedIds.length === 0;
}

export function isCleanTasklessReviewValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const headSha = state.currentIntegrationHeadSha;
  return state.phase === 'validating'
    && state.tasks.length === 0 && expectedIds.length === 0
    && request !== null && outcome?.outcome === 'clean' && latest !== undefined
    && sameEvidence(latest.request, request) && sameEvidence(latest.outcome, outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === headSha && state.reviewedHeadSha === headSha
    && request.headSha === headSha && outcome.headSha === headSha;
}

export function hasRemainingReviewAllowance(state) {
  return !reviewRequestUsage(state).exhausted;
}

export function isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && state.phase === 'recovering'
    && state.tasks.length === 0 && expectedIds.length === 0
    && request !== null
    && outcome?.outcome === 'clean' && latest !== undefined
    && sameEvidence(latest.request, request) && sameEvidence(latest.outcome, outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === priorHeadSha
    && outcome.headSha === priorHeadSha
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && hasRemainingReviewAllowance(state);
}

export function isNativeTasklessPendingReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const disposition = staleDiscoveryDispositionForRequest(state, request?.id);
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && ['recovering', 'ready-for-review'].includes(state.phase)
    && state.tasks.length === 0 && expectedIds.length === 0
    && request !== null && latest !== undefined
    && state.reviewOutcome === null && latest.outcome === null
    && sameEvidence(latest.request, request)
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === null
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && (disposition === null
      || (disposition.liveHeadSha === state.currentIntegrationHeadSha
        && disposition.requestHeadSha === priorHeadSha
        && disposition.evidence?.requestId === request.id));
}

export function readV2CompletedTaskValidationRecoveryEvidence(cwd, state, expectedIds) {
  if (!['recovering', 'validating'].includes(state.phase) || state.validationStatus.status !== 'not-run'
      || expectedIds.length !== 0 || state.tasks.length === 0
      || state.tasks.some((task) => task.status !== 'completed'
        || task.disposition === 'needs-human-decision')
      || state.blockedReasons.length !== 0 || state.verificationEscalation !== null) return null;
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath)) return null;
  try {
    const legacy = readStateDocument(backupPath);
    if (legacy.schemaVersion !== 2 || !['awaiting-review', 'ready-for-review', 'complete'].includes(legacy.phase)
        || legacy.validationStatus?.status !== 'passed'
        || legacy.validationStatus.headSha !== state.currentIntegrationHeadSha
        || !Array.isArray(legacy.validationStatus.checks) || legacy.validationStatus.checks.length === 0
        || typeof legacy.validationStatus.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(legacy.validationStatus.updatedAt))
        || !Array.isArray(legacy.tasks) || legacy.tasks.length === 0
        || legacy.tasks.some((task) => task.status !== 'completed')) return null;
    const migrated = migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
    return { legacyPhase: legacy.phase, migrated };
  } catch {
    return null;
  }
}

export function assertCleanExactIntegrationHead(state) {
  assertValidationBaseAncestry(
    state.integrationWorktree,
    state.baseSha,
    state.currentIntegrationHeadSha,
  );
  assertCleanExactIntegrationCheckout(state);
}


export function buildTargetedValidationPlanUnlocked({
  cwd, prNumber, taskPackets, initialSelection, replace, now = utcNow,
  completedTaskRecoveryAuthorized = false,
}) {
  const state = loadState(cwd, prNumber);
  if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (!VALIDATION_PLANNING_PHASES.has(state.phase)) {
    throw new StateError(`Cannot plan targeted validation while phase is ${state.phase}`, 'VALIDATION_PLAN_PHASE_BLOCKED');
  }
  if (state.validationStatus.status !== 'not-run') {
    throw new StateError('Targeted validation proof must be reset before planning', 'TARGETED_VALIDATION_RESET_REQUIRED');
  }
  assertCleanExactIntegrationCheckout(state);
  const initialMode = initialSelection !== undefined && initialSelection !== null;
  const expectedIds = initialMode
    ? actionableIntegratedTaskIds(state) : actionablePacketValidationTaskIds(state);
  if (initialMode && Array.isArray(taskPackets) && taskPackets.length > 0) {
    throw new StateError('Initial selection and task packets are mutually exclusive', 'INVALID_VALIDATION_PLAN');
  }
  let validationInputs;
  let packetIds;
  if (initialMode) {
    const selectionErrors = validateInitialValidationSelection(initialSelection);
    if (selectionErrors.length > 0) {
      throw new StateError(`Invalid initial validation selection:\n- ${selectionErrors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
    }
    const pristineSelection = isPristineTasklessValidationSelection(state, expectedIds);
    const cleanReviewRecovery = isCleanTasklessReviewValidationRecovery(state, expectedIds);
    const headDriftRecovery = isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds);
    const pendingHeadDriftRecovery = isNativeTasklessPendingReviewHeadDriftValidationRecovery(
      state, expectedIds,
    );
    if (!pristineSelection && !cleanReviewRecovery && !headDriftRecovery
        && !pendingHeadDriftRecovery && completedTaskRecoveryAuthorized !== true) {
      throw new StateError(
        'Taskless validation selection requires a pristine cycle, guarded stale-review recovery, or proven v2 completed-task recovery',
        'INITIAL_VALIDATION_NOT_ALLOWED',
      );
    }
    if (initialSelection.headSha !== state.currentIntegrationHeadSha) {
      throw new StateError('Initial validation selection does not match the integration HEAD', 'VALIDATION_PLAN_STALE');
    }
    validationInputs = [{
      affectedAreas: initialSelection.affectedAreas,
      requiredValidation: initialSelection.requiredValidation,
    }];
    packetIds = [];
  } else {
    const missingBinding = state.tasks.find((task) => task.disposition === 'actionable'
      && ['integrated', 'completed'].includes(task.status)
      && typeof task.taskPacketDigest !== 'string');
    if (missingBinding) {
      throw new StateError(`Task ${missingBinding.id} has not been durably bound`, 'TASK_PACKET_NOT_BOUND');
    }
    const sortedPackets = loadBoundTaskPackets(cwd, state, { statuses: ['integrated', 'completed'] })
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    packetIds = sortedPackets.map((packet) => packet.taskId);
    if (new Set(packetIds).size !== packetIds.length || JSON.stringify(packetIds) !== JSON.stringify(expectedIds)) {
      throw new StateError('Task packets must exactly cover current actionable Integrated or Resolved tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
    }
    if (Array.isArray(taskPackets) && taskPackets.length > 0) {
      const supplied = [...taskPackets].sort((left, right) => left.taskId.localeCompare(right.taskId));
      if (JSON.stringify(supplied.map((packet) => packet.taskId)) !== JSON.stringify(expectedIds)) {
        throw new StateError('Task packets must exactly cover current actionable Integrated or Resolved tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
      }
      if (canonicalSerializedJson(supplied) !== canonicalSerializedJson(sortedPackets)) {
        throw new StateError('Supplied packets differ from durable task packet sidecars', 'TASK_PACKET_CONFLICT');
      }
    }
    sortedPackets.forEach((packet) => assertBoundTaskPacket(state, packet, cwd));
    validationInputs = sortedPackets;
  }
  assertValidationBaseAncestry(
    state.integrationWorktree,
    state.baseSha,
    state.currentIntegrationHeadSha,
  );
  const validationUnion = initialMode
    ? unionInitialValidationSelection(validationInputs[0])
    : unionRequiredValidation(validationInputs);
  const commands = [
    ...validationUnion.unit.map((entry) => ({ ...entry, kind: 'unit', selectors: [], projects: [] })),
    ...validationUnion.system.map((entry) => ({ ...entry, kind: 'system' })),
  ];
  if (commands.length === 0) throw new StateError('Targeted validation union must not be empty', 'INVALID_VALIDATION_PLAN');
  const affectedAreas = [...new Set(validationInputs.flatMap((input) => input.affectedAreas))].sort();
  const plannedCommands = commands.map((entry) => ({
    ...entry,
    argv: materializeValidationArgv(
      entry.command,
      parseTargetedValidationCommand(entry.command),
      state,
      state.currentIntegrationHeadSha,
    ),
  }));
  const immutableCommandDefinition = (entry) => ({
    command: entry.command,
    reason: entry.reason,
    kind: entry.kind,
    selectors: entry.selectors,
    projects: entry.projects,
    argv: entry.argv,
  });
  const path = validationPlanPath(cwd, state.prNumber);
  if (existsSync(path)) {
    let existing;
    try {
      existing = readValidationPlan(cwd, state);
    } catch (error) {
      if (error.code !== 'INVALID_VALIDATION_PLAN') throw error;
      try {
        existing = JSON.parse(readFileSync(path, 'utf8'));
      } catch (parseError) {
        throw new StateError(`Unable to read targeted validation plan: ${parseError.message}`, 'INVALID_VALIDATION_PLAN');
      }
      const historicalErrors = validateValidationPlan(existing, {
        ...state, revision: existing?.stateRevision, currentIntegrationHeadSha: existing?.headSha,
      });
      if (historicalErrors.length > 0) {
        throw new StateError(`Invalid targeted validation plan:\n- ${historicalErrors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
      }
    }
    const comparableDefinition = (entry) => ({
      ...immutableCommandDefinition(entry),
      argv: materializeValidationArgv(
        entry.command, entry.argv, state, state.currentIntegrationHeadSha,
      ),
    });
    const sameDefinition = JSON.stringify({
      taskIds: existing.taskIds,
      affectedAreas: existing.affectedAreas,
      commands: existing.commands.map(comparableDefinition),
    }) === JSON.stringify({
      taskIds: packetIds,
      affectedAreas,
      commands: plannedCommands.map(comparableDefinition),
    });
    if (!replace && sameDefinition && existing.commands.every((entry) => entry.status === 'pending')) return existing;
    if (!replace) throw new StateError('A saved validation plan already exists; use --replace to start a fresh plan', 'VALIDATION_PLAN_REPLACE_REQUIRED');
  }
  const timestamp = now();
  const plan = {
    schemaVersion: 1,
    prNumber: state.prNumber,
    stateRevision: state.revision,
    headSha: state.currentIntegrationHeadSha,
    taskIds: packetIds,
    affectedAreas,
    commands: plannedCommands.map((entry) => ({
      ...entry, status: 'pending', exitCode: null, summary: null, completedAt: null,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const errors = validateValidationPlan(plan, state);
  if (errors.length > 0) throw new StateError(`Invalid targeted validation plan:\n- ${errors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
  if (Buffer.byteLength(serializeJson(plan), 'utf8') > VALIDATION_PLAN_LIMIT_BYTES) {
    throw new StateError('Targeted validation plan exceeds 64 KiB', 'VALIDATION_PLAN_TOO_LARGE');
  }
  atomicWriteJson(path, plan);
  appendEvent(cwd, state.prNumber, { type: 'targeted-validation-planned', summary: `Saved ${commands.length} targeted checks for ${state.currentIntegrationHeadSha}` });
  return plan;
}

export function executeTargetedValidationFacts({
  cwd, state, plan, runCommand, now = () => new Date().toISOString(), beforeCommand,
  onCommandRecorded,
}) {
  assertCleanExactIntegrationHead(state);
  let currentPlan = plan;
  for (let index = 0; index < currentPlan.commands.length; index += 1) {
    const entry = currentPlan.commands[index];
    if (entry.status !== 'pending') continue;
    beforeCommand?.(entry, currentPlan);
    let result;
    const executionArgv = materializeValidationArgv(entry.command, entry.argv, state, plan.headSha);
    if (!executionArgv) throw new StateError('Validation command range is malformed or stale', 'INVALID_VALIDATION_PLAN');
    try { result = runCommand(executionArgv, state.integrationWorktree); } catch (error) { result = { status: 1, error }; }
    assertValidationBaseAncestry(
      state.integrationWorktree,
      state.baseSha,
      plan.headSha,
    );
    const exitCode = Number.isInteger(result?.status) && result.status >= 0 ? result.status : 1;
    const completedAt = now();
    const summary = exitCode === 0 ? 'Passed.'
      : `Failed with exit code ${exitCode}${result?.error?.message ? `: ${String(result.error.message).slice(0, 400)}` : '.'}`;
    currentPlan = { ...currentPlan, commands: currentPlan.commands.map((item, itemIndex) => itemIndex === index
      ? { ...item, status: exitCode === 0 ? 'passed' : 'failed', exitCode, summary, completedAt } : item), updatedAt: completedAt };
    atomicWriteJson(validationPlanPath(cwd, state.prNumber), currentPlan);
    onCommandRecorded?.(entry.command, currentPlan);
  }
  return currentPlan;
}
