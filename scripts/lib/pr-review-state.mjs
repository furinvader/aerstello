import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gitText, resolveCommit, runGit } from './git.mjs';
import { inspectReleaseState } from './release-state.mjs';
import {
  completionGate,
  parseTargetedValidationCommand,
  reviewRequestGate,
  taskHasCanonicalThreadCoverage,
  unionRequiredValidation,
  validateInitialValidationSelection,
  validateTaskPacket,
  validatePrReviewState,
  validatePrReviewStateV1,
  validatePrReviewStateV3,
} from './contracts.mjs';

export { completionGate, reviewRequestGate } from './contracts.mjs';

export const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const TRANSITION_AUTHORIZATION = Symbol('guarded PR review transition');

export class StateError extends Error {
  constructor(message, code = 'STATE_ERROR') {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export function assertReviewRequestAllowed(state, external) {
  const gate = reviewRequestGate(state, external);
  if (!gate.allowed) {
    throw new StateError(`Review request is not allowed:\n- ${gate.reasons.join('\n- ')}`, 'REVIEW_REQUEST_NOT_READY');
  }
  return gate.kind;
}

export function assertCompletionAllowed(state, external) {
  const gate = completionGate(state, external);
  if (!gate.allowed) {
    throw new StateError(`Review cycle is not complete:\n- ${gate.reasons.join('\n- ')}`, 'REVIEW_CYCLE_INCOMPLETE');
  }
}

export function gitAwareGateContext(state, { pushedHeadSha, prHeadSha, currentTime } = {}) {
  const cwd = state.integrationWorktree;
  const local = gitSnapshot(cwd);
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    prHeadSha,
    currentTime,
    isAncestor: (ancestor, descendant) => runGit(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, allowFailure: true },
    ).status === 0,
  };
}

function utcNow() {
  return new Date().toISOString();
}

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function assertTrustedTimestamp(value, label) {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new StateError(`${label} must be an RFC 3339 timestamp`, 'INVALID_HUMAN_FINAL_AUTHORIZATION');
  }
  return value;
}

function emptyLocalVerification() {
  return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null };
}

function emptyThreadProof() {
  return {
    status: 'not-run',
    headSha: null,
    threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    localVerification: emptyLocalVerification(),
    updatedAt: null,
  };
}

function emptyTargetedValidation() {
  return {
    source: 'orchestrator', scope: 'targeted', status: 'not-run',
    headSha: null, checks: [], updatedAt: null,
  };
}

function emptyCiValidation() {
  return {
    source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
    checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null,
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function gitCommonDirectory(cwd = process.cwd()) {
  return gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

export function repositoryRoot(cwd = process.cwd()) {
  return gitText(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd });
}

export function reviewRoot(cwd = process.cwd()) {
  return join(gitCommonDirectory(cwd), 'codex', 'pr-review');
}

export function stateDirectory(cwd, prNumber) {
  return join(reviewRoot(cwd), `pr-${parsePrNumber(prNumber)}`);
}

export function statePath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'state.json');
}

export function validationPlanPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'targeted-validation-plan.json');
}

export function activePointerPath(cwd = process.cwd()) {
  return join(reviewRoot(cwd), 'active.json');
}

function lockPath(cwd, prNumber) {
  return join(reviewRoot(cwd), 'locks', `pr-${parsePrNumber(prNumber)}.lock`);
}

function parsePrNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new StateError('PR number must be a positive integer', 'INVALID_PR_NUMBER');
  return number;
}

function serializeJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function atomicWriteText(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, data, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
    try {
      const directoryHandle = openSync(dirname(path), 'r');
      fsyncSync(directoryHandle);
      closeSync(directoryHandle);
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteText(path, serializeJson(value));
}

const VALIDATION_PLAN_LIMIT_BYTES = 64 * 1024;
const VALIDATION_AREAS = new Set(['api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration']);
const VALIDATION_PLANNING_PHASES = new Set(['recovering', 'ready-for-review', 'integrating', 'verifying', 'validating']);

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function taskPacketDigest(packet) {
  const errors = validateTaskPacket(packet);
  if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  return createHash('sha256').update(JSON.stringify(canonicalJson(packet))).digest('hex');
}

function relatedE2EMetadata(argv) {
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

function validateValidationPlan(plan, state) {
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
      const parsed = parseTargetedValidationCommand(entry.command);
      if (!parsed || JSON.stringify(parsed) !== JSON.stringify(entry.argv)) errors.push(`${prefix} is not a supported exact command`);
      if (!['unit', 'system'].includes(entry.kind)) errors.push(`${prefix}.kind is invalid`);
      if (typeof entry.reason !== 'string' || entry.reason.length < 1 || entry.reason.length > 1000) errors.push(`${prefix}.reason is invalid`);
      for (const field of ['selectors', 'projects']) {
        if (!Array.isArray(entry[field]) || entry[field].some((item) => typeof item !== 'string')
            || new Set(entry[field]).size !== entry[field].length) errors.push(`${prefix}.${field} is invalid`);
      }
      const e2eMetadata = parsed ? relatedE2EMetadata(parsed) : null;
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
  if (Array.isArray(plan.commands) && Array.isArray(plan.affectedAreas)) {
    const contractErrors = validateTaskPacket({
      schemaVersion: 2, taskId: 'saved-validation-plan', reviewedHeadSha: plan.headSha,
      finding: 'Saved integrated targeted-validation union.', evidence: 'Durable orchestrator plan.',
      affectedAreas: plan.affectedAreas, decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [],
      dependencies: [], acceptanceCriteria: ['All saved checks complete.'],
      requiredValidation: {
        unit: plan.commands.filter((entry) => entry?.kind === 'unit').map((entry) => ({ command: entry.command, reason: entry.reason })),
        system: plan.commands.filter((entry) => entry?.kind === 'system').map((entry) => ({
          command: entry.command, reason: entry.reason, selectors: entry.selectors, projects: entry.projects,
        })),
      },
    });
    errors.push(...contractErrors.map((error) => `plan command contract: ${error}`));
  }
  return errors;
}

function readValidationPlan(cwd, state) {
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

function assertCleanExactIntegrationHead(state) {
  const actual = gitSnapshot(state.integrationWorktree);
  if (actual.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('Integration HEAD differs from active state; checkpoint Git metadata first', 'VALIDATION_PLAN_STALE');
  }
  if (actual.dirty) throw new StateError('Integration checkout must be clean for targeted validation', 'VALIDATION_CHECKOUT_DIRTY');
  return actual;
}

function actionableIntegratedTaskIds(state) {
  return state.tasks.filter((task) => task.disposition === 'actionable' && task.status === 'integrated')
    .map((task) => task.id).sort();
}

function isPristineTasklessValidationSelection(state, expectedIds) {
  return state.reviewRound === 0 && state.reviewRequest === null && state.reviewHistory.length === 0
    && state.tasks.length === 0 && expectedIds.length === 0;
}

function isCleanTasklessReviewValidationRecovery(state, expectedIds) {
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

function hasRemainingReviewAllowance(state) {
  return (Number.isInteger(state.reviewRound) && state.reviewRound < 3)
    || (state.reviewRound === 3 && state.verificationReviewUsed === false);
}

function isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  return state.schemaVersion === 4
    && state.legacyReviewProvenance === null
    && state.phase === 'recovering'
    && state.tasks.length === 0 && expectedIds.length === 0
    && request !== null && request.kind === 'discovery'
    && outcome?.outcome === 'clean' && latest !== undefined
    && sameEvidence(latest.request, request) && sameEvidence(latest.outcome, outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === priorHeadSha
    && outcome.headSha === priorHeadSha
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && state.humanFinalReviewAuthorization === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && hasRemainingReviewAllowance(state);
}

function isV2CompletedTaskValidationRecovery(cwd, state, expectedIds) {
  if (!['recovering', 'validating'].includes(state.phase) || state.validationStatus.status !== 'not-run'
      || expectedIds.length !== 0 || state.tasks.length === 0
      || state.tasks.some((task) => task.status !== 'completed'
        || task.disposition === 'needs-human-decision')
      || state.blockedReasons.length !== 0 || state.verificationEscalation !== null) return false;
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath)) return false;
  try {
    const legacy = readStateDocument(backupPath);
    if (legacy.schemaVersion !== 2 || !['awaiting-review', 'ready-for-review', 'complete'].includes(legacy.phase)
        || legacy.validationStatus?.status !== 'passed'
        || legacy.validationStatus.headSha !== state.currentIntegrationHeadSha
        || !Array.isArray(legacy.validationStatus.checks) || legacy.validationStatus.checks.length === 0
        || typeof legacy.validationStatus.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(legacy.validationStatus.updatedAt))
        || !Array.isArray(legacy.tasks) || legacy.tasks.length === 0
        || legacy.tasks.some((task) => task.status !== 'completed')) return false;
    const migrated = migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
    let expected = migrated;
    if (legacy.phase === 'awaiting-review') {
      if (migrated.phase !== 'awaiting-review' || state.phase !== 'validating'
          || state.reviewOutcome?.outcome !== 'clean'
          || state.revision !== migrated.revision + 1) return false;
      expected = {
        ...buildReviewOutcomeTransition(migrated, state.reviewOutcome),
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
    }
    return JSON.stringify(canonicalJson(expected)) === JSON.stringify(canonicalJson(state));
  } catch {
    return false;
  }
}

function assertTaskPacketHead(state, task, packet, digest) {
  if (state.reviewedHeadSha !== null) {
    if (packet.reviewedHeadSha !== state.reviewedHeadSha) {
      throw new StateError(`Task packet ${packet.taskId} does not match the exact reviewed HEAD`, 'TASK_PACKET_HEAD_MISMATCH');
    }
  }
  const boundIntegratedTask = task.status === 'integrated'
    && typeof task.taskPacketDigest === 'string';
  if (boundIntegratedTask) {
    if (task.taskPacketDigest !== digest) {
      throw new StateError(`Task packet ${packet.taskId} differs from the accepted packet`, 'TASK_PACKET_CONFLICT');
    }
    if (typeof task.integratedCommitSha !== 'string' || task.integratedCommitSha.length === 0) {
      throw new StateError(
        `Task ${task.id} integration commit is not proven in the current integration history`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
    let ancestry;
    try {
      ancestry = runGit(
        ['merge-base', '--is-ancestor', task.integratedCommitSha, state.currentIntegrationHeadSha],
        { cwd: state.integrationWorktree, allowFailure: true },
      );
    } catch {
      throw new StateError(
        `Task ${task.id} integration ancestry could not be verified`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
    if (ancestry.status !== 0) {
      throw new StateError(
        `Task ${task.id} integration commit is not an ancestor of the current integration HEAD`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
    return;
  }
  if (state.reviewedHeadSha !== null) return;
  if (packet.reviewedHeadSha === state.currentIntegrationHeadSha) return;
  throw new StateError(`Task packet ${packet.taskId} does not match the exact reviewed HEAD`, 'TASK_PACKET_HEAD_MISMATCH');
}

function assertBoundTaskPacket(state, packet) {
  const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
  if (!task || task.disposition !== 'actionable') {
    throw new StateError(`Task packet ${packet.taskId} does not match an actionable durable task`, 'TASK_PACKET_NOT_BOUND');
  }
  const digest = taskPacketDigest(packet);
  assertTaskPacketHead(state, task, packet, digest);
  if (!task.taskPacketDigest) {
    throw new StateError(`Task packet ${packet.taskId} has not been durably bound`, 'TASK_PACKET_NOT_BOUND');
  }
  if (task.taskPacketDigest !== digest) {
    throw new StateError(`Task packet ${packet.taskId} differs from the accepted packet`, 'TASK_PACKET_CONFLICT');
  }
  return task;
}

export function assertTaskPacketBound(state, packet) {
  const errors = validateTaskPacket(packet);
  if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  return assertBoundTaskPacket(state, packet);
}

function buildTargetedValidationPlanUnlocked({ cwd, prNumber, taskPackets, initialSelection, replace, now }) {
  const state = loadState(cwd, prNumber);
  if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (!VALIDATION_PLANNING_PHASES.has(state.phase)) {
    throw new StateError(`Cannot plan targeted validation while phase is ${state.phase}`, 'VALIDATION_PLAN_PHASE_BLOCKED');
  }
  if (state.validationStatus.status !== 'not-run') {
    throw new StateError('Targeted validation proof must be reset before planning', 'TARGETED_VALIDATION_RESET_REQUIRED');
  }
  assertCleanExactIntegrationHead(state);
  const expectedIds = actionableIntegratedTaskIds(state);
  const initialMode = initialSelection !== undefined && initialSelection !== null;
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
    const completedTaskRecovery = isV2CompletedTaskValidationRecovery(cwd, state, expectedIds);
    if (!pristineSelection && !cleanReviewRecovery && !headDriftRecovery && !completedTaskRecovery) {
      throw new StateError(
        'Taskless validation selection requires a pristine cycle, guarded clean-review recovery, or proven v2 completed-task recovery',
        'INITIAL_VALIDATION_NOT_ALLOWED',
      );
    }
    if (initialSelection.headSha !== state.currentIntegrationHeadSha) {
      throw new StateError('Initial validation selection does not match the integration HEAD', 'VALIDATION_PLAN_STALE');
    }
    validationInputs = [{
      schemaVersion: 2,
      taskId: cleanReviewRecovery ? 'taskless-clean-review-validation-recovery'
        : headDriftRecovery ? 'taskless-review-head-drift-validation-recovery'
        : completedTaskRecovery ? 'v2-completed-task-validation-recovery' : 'initial-validation-selection',
      reviewedHeadSha: initialSelection.headSha,
      finding: cleanReviewRecovery ? 'Taskless targeted-validation recovery after a clean exact-head review.'
        : headDriftRecovery ? 'Taskless targeted-validation recovery after a clean historical review HEAD drifted.'
        : completedTaskRecovery ? 'Fresh targeted validation after schema-v2 completed-task migration.'
          : 'Initial pull-request validation selection.',
      evidence: cleanReviewRecovery ? 'Explicit orchestrator-selected validation for the preserved clean exact-head review.'
        : headDriftRecovery ? 'Explicit orchestrator-selected validation for the current HEAD while preserving prior clean review evidence.'
        : completedTaskRecovery ? 'Immutable schema-v2 backup authorizes fresh orchestrator-selected validation.'
          : 'Explicit orchestrator-selected validation before the first discovery review.',
      affectedAreas: initialSelection.affectedAreas,
      decisionIds: [],
      allowedPaths: ['scripts/**'],
      forbiddenPaths: [],
      dependencies: [],
      acceptanceCriteria: [cleanReviewRecovery ? 'The selected taskless recovery checks pass.'
        : headDriftRecovery ? 'The selected taskless current-HEAD recovery checks pass.'
        : completedTaskRecovery ? 'The selected completed-task migration recovery checks pass.'
          : 'The selected initial checks pass.'],
      requiredValidation: initialSelection.requiredValidation,
    }];
    packetIds = [];
  } else {
    if (!Array.isArray(taskPackets) || taskPackets.length === 0) {
      throw new StateError('At least one task packet is required', 'INVALID_VALIDATION_PLAN');
    }
    const packetErrors = taskPackets.flatMap((packet, index) => validateTaskPacket(packet).map((error) => `packet ${index}: ${error}`));
    if (packetErrors.length > 0) throw new StateError(`Invalid task packets:\n- ${packetErrors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
    const sortedPackets = [...taskPackets].sort((left, right) => left.taskId.localeCompare(right.taskId));
    packetIds = sortedPackets.map((packet) => packet.taskId);
    if (new Set(packetIds).size !== packetIds.length || JSON.stringify(packetIds) !== JSON.stringify(expectedIds)) {
      throw new StateError('Task packets must exactly cover current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
    }
    sortedPackets.forEach((packet) => assertBoundTaskPacket(state, packet));
    validationInputs = sortedPackets;
  }
  const validationUnion = unionRequiredValidation(validationInputs);
  const commands = [
    ...validationUnion.unit.map((entry) => ({ ...entry, kind: 'unit', selectors: [], projects: [] })),
    ...validationUnion.system.map((entry) => ({ ...entry, kind: 'system' })),
  ];
  if (commands.length === 0) throw new StateError('Targeted validation union must not be empty', 'INVALID_VALIDATION_PLAN');
  const affectedAreas = [...new Set(validationInputs.flatMap((input) => input.affectedAreas))].sort();
  const plannedCommands = commands.map((entry) => ({
    ...entry, argv: parseTargetedValidationCommand(entry.command),
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
    const sameDefinition = JSON.stringify({
      taskIds: existing.taskIds,
      affectedAreas: existing.affectedAreas,
      commands: existing.commands.map(immutableCommandDefinition),
    }) === JSON.stringify({
      taskIds: packetIds,
      affectedAreas,
      commands: plannedCommands.map(immutableCommandDefinition),
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

export function buildTargetedValidationPlan({
  cwd = process.cwd(), prNumber, taskPackets, initialSelection, replace = false, now = utcNow,
} = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const current = loadState(cwd, selectedPr);
  if (!VALIDATION_PLANNING_PHASES.has(current.phase)) {
    throw new StateError(`Cannot plan targeted validation while phase is ${current.phase}`, 'VALIDATION_PLAN_PHASE_BLOCKED');
  }
  if (initialSelection !== undefined && initialSelection !== null
      && current.validationStatus.status === 'passed'
      && (isCleanTasklessReviewValidationRecovery(current, actionableIntegratedTaskIds(current))
        || isNativeTasklessReviewHeadDriftValidationRecovery(current, actionableIntegratedTaskIds(current)))) {
    throw new StateError(
      'Taskless review recovery cannot replace existing targeted-validation proof',
      'INITIAL_VALIDATION_NOT_ALLOWED',
    );
  }
  if (current.validationStatus.status !== 'not-run' && !replace) {
    throw new StateError('Targeted validation proof already exists; use --replace to start a fresh plan', 'VALIDATION_PLAN_REPLACE_REQUIRED');
  }
  if (current.validationStatus.status !== 'not-run') {
    checkpointTargetedValidationReset({ cwd, prNumber: selectedPr, expectedRevision: current.revision });
  }
  return withStateLock(cwd, selectedPr, () => buildTargetedValidationPlanUnlocked({
    cwd, prNumber: selectedPr, taskPackets, initialSelection, replace, now,
  }));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockIsStale(path, staleMs) {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    const age = Date.now() - Date.parse(lock.createdAt);
    if (!Number.isFinite(age) || age <= staleMs) return false;
    if (lock.hostname === hostname()) return !processExists(lock.pid);
    return age > staleMs * 6;
  } catch {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  }
}

export function withStateLock(cwd, prNumber, callback, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_LOCK_MS,
} = {}) {
  const path = lockPath(cwd, prNumber);
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  const token = randomUUID();

  while (true) {
    try {
      const handle = openSync(path, 'wx', 0o600);
      writeFileSync(handle, serializeJson({ token, pid: process.pid, hostname: hostname(), createdAt: utcNow() }));
      fsyncSync(handle);
      closeSync(handle);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(path, staleMs)) {
        try { unlinkSync(path); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new StateError(`Timed out waiting for ${path}`, 'STATE_LOCK_TIMEOUT');
      sleep(25);
    }
  }

  try {
    return callback();
  } finally {
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8'));
      if (lock.token === token) unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function validateStateForWrite(state) {
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new StateError(`Invalid PR review state:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  const bytes = Buffer.byteLength(serializeJson(state), 'utf8');
  if (bytes > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError(`Active state is ${bytes} bytes; limit is ${ACTIVE_STATE_LIMIT_BYTES}`, 'STATE_TOO_LARGE');
  }
}

function readStateDocument(path) {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
      throw new StateError(
        `Active state exceeds ${ACTIVE_STATE_LIMIT_BYTES} bytes`,
        'STATE_TOO_LARGE',
      );
    }
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(`Unable to read ${path}: ${error.message}`, 'STATE_READ_FAILED');
  }
}

function parseState(path) {
  const document = readStateDocument(path);
  const state = document;
  if (state?.schemaVersion === 1) {
    const legacyErrors = validatePrReviewStateV1(state);
    if (legacyErrors.length > 0) {
      throw new StateError(`Invalid state at ${path}:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
    }
    throw new StateError(
      `State at ${path} uses schema v1; run the explicit migrate command`,
      'STATE_MIGRATION_REQUIRED',
    );
  }
  if (state?.schemaVersion === 2) {
    try { migratePrReviewStateV2(state); } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError(`Invalid state at ${path}: ${error.message}`, 'INVALID_STATE');
    }
    throw new StateError(
      `State at ${path} uses schema v2; run the explicit migrate command`,
      'STATE_MIGRATION_REQUIRED',
    );
  }
  if (state?.schemaVersion === 3) {
    const legacyErrors = validatePrReviewStateV3(state);
    if (legacyErrors.length > 0) {
      throw new StateError(`Invalid state at ${path}:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
    }
    throw new StateError(
      `State at ${path} uses schema v3; run the explicit migrate command`,
      'STATE_MIGRATION_REQUIRED',
    );
  }
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new StateError(`Invalid state at ${path}:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  return state;
}

export function activePrNumber(cwd = process.cwd()) {
  const path = activePointerPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const pointer = JSON.parse(readFileSync(path, 'utf8'));
    return parsePrNumber(pointer.prNumber);
  } catch (error) {
    throw new StateError(`Invalid active PR pointer at ${path}: ${error.message}`, 'INVALID_ACTIVE_POINTER');
  }
}

export function locateState(cwd = process.cwd(), prNumber) {
  const selected = prNumber === undefined || prNumber === null ? activePrNumber(cwd) : parsePrNumber(prNumber);
  if (selected === null) return null;
  const path = statePath(cwd, selected);
  if (!existsSync(path)) throw new StateError(`Active PR ${selected} has no state file at ${path}`, 'STATE_NOT_FOUND');
  return { prNumber: selected, path };
}

export function loadState(cwd = process.cwd(), prNumber) {
  const located = locateState(cwd, prNumber);
  return located ? parseState(located.path) : null;
}

function originRepository(cwd) {
  const result = runGit(['config', '--get', 'remote.origin.url'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const remote = String(result.stdout).trim();
  const match = remote.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  return match ? `${match[1]}/${match[2]}` : null;
}

function gitSnapshot(cwd) {
  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, allowFailure: true });
  return {
    branch: branchResult.status === 0 ? String(branchResult.stdout).trim() : null,
    headSha: resolveCommit(cwd, 'HEAD'),
    dirty: gitText(['status', '--porcelain'], { cwd }).length > 0,
  };
}

export function initializeState({
  cwd = process.cwd(),
  prNumber,
  repository,
  base = 'origin/main',
  head = 'HEAD',
  releaseRef = 'origin/main',
  orchestratorSessionId = null,
} = {}) {
  const selectedPr = parsePrNumber(prNumber);
  const repo = repository ?? originRepository(cwd);
  if (!repo) throw new StateError('Unable to derive owner/name from origin; pass --repository', 'REPOSITORY_REQUIRED');
  const root = repositoryRoot(cwd);
  const baseSha = resolveCommit(cwd, base);
  const currentIntegrationHeadSha = resolveCommit(cwd, head);
  const releaseState = inspectReleaseState({ cwd, base, head, releaseRef });
  if (releaseState.status === 'inconsistent') {
    throw new StateError('Release metadata is inconsistent; PR review state was not initialized', 'RELEASE_STATE_INCONSISTENT');
  }

  return withStateLock(cwd, selectedPr, () => {
    const existingActive = activePrNumber(cwd);
    if (existingActive !== null) throw new StateError(`PR ${existingActive} is already active`, 'ACTIVE_STATE_EXISTS');
    const path = statePath(cwd, selectedPr);
    if (existsSync(path)) throw new StateError(`State already exists for PR ${selectedPr}`, 'STATE_EXISTS');
    const state = {
      schemaVersion: 4,
      revision: 0,
      repository: repo,
      prNumber: selectedPr,
      phase: 'recovering',
      baseSha,
      requestedHeadSha: null,
      reviewedHeadSha: null,
      currentIntegrationHeadSha,
      reviewRound: 0,
      verificationReviewUsed: false,
      legacyReviewProvenance: null,
      releaseBaseline: releaseState.applicableRelease,
      decisions: [],
      tasks: [],
      reviewRequest: null,
      reviewOutcome: null,
      reviewHistory: [],
      verificationEscalation: null,
      humanFinalReviewAuthorization: null,
      threadResolutionStatus: emptyThreadProof(),
      blockedReasons: [],
      validationStatus: emptyTargetedValidation(),
      ciValidationStatus: emptyCiValidation(),
      ciValidationHistory: [],
      nextAction: 'Resolve the PR and pushed head metadata before requesting review.',
      integrationWorktree: root,
      orchestratorSessionId,
      abandonmentReason: null,
      git: gitSnapshot(root),
      updatedAt: utcNow(),
    };
    validateStateForWrite(state);
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 4, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, { type: 'initialized', summary: `Initialized PR ${selectedPr}` });
    return state;
  });
}

function unique(values) {
  return [...new Set(values)];
}

function inferLegacySourceType(task) {
  return task.sourceIds.some((id) => /(?:thread|discussion)/iu.test(id)) ? 'github-thread' : 'github-threadless';
}

function validateIntegrationMap(legacyState, integrationMap) {
  if (integrationMap === undefined || integrationMap === null) return {};
  if (typeof integrationMap !== 'object' || Array.isArray(integrationMap)) {
    throw new StateError('Integration map must be a JSON object from task ID to central SHA', 'INVALID_INTEGRATION_MAP');
  }
  const tasks = new Map(legacyState.tasks.map((task) => [task.id, task]));
  for (const [taskId, sha] of Object.entries(integrationMap)) {
    const task = tasks.get(taskId);
    if (!task) throw new StateError(`Integration map contains unknown task ${taskId}`, 'INVALID_INTEGRATION_MAP');
    if (!['integrated', 'completed'].includes(task.status)) {
      throw new StateError(`Integration map task ${taskId} is not a legacy integrated task`, 'INVALID_INTEGRATION_MAP');
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha)) {
      throw new StateError(`Integration map task ${taskId} has an invalid SHA`, 'INVALID_INTEGRATION_MAP');
    }
  }
  return integrationMap;
}

function migrateTaskV1(task, integrationMap) {
  const centralSha = integrationMap[task.id] ?? null;
  const wasIntegrated = ['integrated', 'completed'].includes(task.status);
  const status = wasIntegrated ? (centralSha ? 'integrated' : 'implemented') : task.status;
  const migrated = {
    id: task.id,
    sourceIds: unique(task.sourceIds),
    sourceType: inferLegacySourceType(task),
    fingerprint: task.fingerprint,
    summary: task.summary,
    severity: task.severity,
    disposition: task.disposition,
    status,
    integratedCommitSha: centralSha,
    resolutionSummary: status === 'integrated'
      ? task.validationSummaries[0] ?? 'Central integration reconciled; canonical thread verification remains pending.'
      : status === 'not-applicable' ? task.lastError ?? 'Preserved legacy non-applicable disposition.' : null,
  };
  if (['proposed', 'queued', 'running', 'implemented', 'blocked', 'failed'].includes(status)) {
    migrated.execution = {
      dependencies: unique(task.dependencies),
      ownedPaths: unique(task.ownedPaths),
      worker: task.worker,
      branch: task.branch,
      worktree: task.worktree,
      workerCommitSha: task.commitSha,
      validationSummaries: unique(task.validationSummaries),
      lastError: task.lastError,
    };
  }
  return migrated;
}

function migrateValidationProof(proof, head) {
  if (proof.status === 'passed' && proof.headSha === head && proof.checks.length > 0 && proof.updatedAt !== null) {
    return { source: 'orchestrator', scope: 'targeted', ...proof, checks: unique(proof.checks) };
  }
  if (proof.status === 'failed' && proof.headSha !== null && proof.updatedAt !== null) {
    return { source: 'orchestrator', scope: 'targeted', ...proof, checks: unique(proof.checks) };
  }
  return emptyTargetedValidation();
}

function migratePrReviewStateV2ToV3(legacyState, { migratedAt = utcNow() } = {}) {
  if (!legacyState || legacyState.schemaVersion !== 2) {
    throw new StateError('Expected schema v2 state', 'INVALID_STATE');
  }
  const normalized = Object.prototype.hasOwnProperty.call(legacyState, 'verificationEscalation')
    ? legacyState : { ...legacyState, verificationEscalation: null };
  for (const field of ['ciValidationStatus', 'ciValidationHistory']) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      throw new StateError(`Schema v2 state cannot contain ${field}`, 'INVALID_STATE');
    }
  }
  const wasComplete = normalized.phase === 'complete';
  const validationMustBeRebuilt = normalized.validationStatus?.status === 'passed';
  const latestReview = normalized.reviewHistory?.at(-1);
  const pendingReviewMustBePreserved = normalized.phase === 'awaiting-review'
    && normalized.reviewOutcome === null
    && latestReview?.outcome === null
    && normalized.reviewRequest?.id === latestReview.request?.id
    && latestReview.request?.headSha === normalized.currentIntegrationHeadSha;
  const mustRecover = wasComplete || (validationMustBeRebuilt && !pendingReviewMustBePreserved);
  const migrated = {
    ...normalized,
    schemaVersion: 3,
    revision: normalized.revision + 1,
    validationStatus: emptyTargetedValidation(),
    ciValidationStatus: emptyCiValidation(),
    ciValidationHistory: [],
    nextAction: pendingReviewMustBePreserved
      ? 'Collect the pending exact-head review, then reconfirm targeted validation and full GitHub Actions.'
      : wasComplete || validationMustBeRebuilt
        ? 'Reconfirm targeted validation, full GitHub Actions, and the exact review commit after schema v4 migration.'
      : normalized.nextAction,
    phase: mustRecover ? 'recovering' : normalized.phase,
    updatedAt: migratedAt,
  };
  const legacyCompletionPlaceholder = {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: normalized.currentIntegrationHeadSha,
    checks: ['schema-v2 completion invariant validation only'], workflowRunId: 1,
    workflowRunUrl: 'https://github.com/aerstello/schema-v2-migration-placeholder', updatedAt: migratedAt,
  };
  const legacyCompletedLocalTaskIds = (normalized.tasks ?? [])
    .filter((task) => task.sourceType === 'local' && task.status === 'completed')
    .map((task) => task.id).sort();
  const legacyCompletionThreadProof = legacyCompletedLocalTaskIds.length > 0
    && !Object.hasOwn(normalized.threadResolutionStatus, 'localVerification')
    ? {
        ...normalized.threadResolutionStatus,
        localVerification: {
          status: 'passed', headSha: normalized.currentIntegrationHeadSha,
          taskIds: legacyCompletedLocalTaskIds, updatedAt: migratedAt,
        },
      }
    : normalized.threadResolutionStatus;
  const validationCandidate = wasComplete ? {
    ...migrated,
    phase: 'complete',
    validationStatus: migrateValidationProof(normalized.validationStatus, normalized.currentIntegrationHeadSha),
    ciValidationStatus: legacyCompletionPlaceholder,
    ciValidationHistory: [legacyCompletionPlaceholder],
    // This proof exists only to validate the legacy Done invariant. The returned recovering
    // state never treats schema-v2 local completion as current verifier evidence.
    threadResolutionStatus: legacyCompletionThreadProof,
  } : migrated;
  const errors = validatePrReviewStateV3(validationCandidate);
  if (errors.length > 0) {
    throw new StateError(`Unable to migrate schema v2 state:\n- ${errors.join('\n- ')}`, 'STATE_MIGRATION_FAILED');
  }
  return migrated;
}

export function migratePrReviewStateV3(legacyState, { migratedAt = utcNow() } = {}) {
  const legacyErrors = validatePrReviewStateV3(legacyState);
  if (legacyErrors.length > 0) {
    throw new StateError(`Invalid schema v3 state:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
  }
  const migrated = {
    ...legacyState,
    schemaVersion: 4,
    revision: legacyState.revision + 1,
    humanFinalReviewAuthorization: null,
    updatedAt: migratedAt,
  };
  const errors = validatePrReviewState(migrated);
  if (errors.length > 0) {
    throw new StateError(`Unable to migrate schema v3 state:\n- ${errors.join('\n- ')}`, 'STATE_MIGRATION_FAILED');
  }
  return migrated;
}

export function migratePrReviewStateV2(legacyState, { migratedAt = utcNow() } = {}) {
  return migratePrReviewStateV3(
    migratePrReviewStateV2ToV3(legacyState, { migratedAt }),
    { migratedAt },
  );
}

export function migratePrReviewStateV1(legacyState, {
  migratedAt = utcNow(), integrationMap: suppliedIntegrationMap, isAncestor,
} = {}) {
  const legacyErrors = validatePrReviewStateV1(legacyState);
  if (legacyErrors.length > 0) {
    throw new StateError(`Invalid schema v1 state:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
  }
  const integrationMap = validateIntegrationMap(legacyState, suppliedIntegrationMap);
  if (Object.keys(integrationMap).length > 0 && typeof isAncestor !== 'function') {
    throw new StateError('A Git ancestry verifier is required for every nonempty integration map', 'INVALID_INTEGRATION_MAP');
  }
  if (typeof isAncestor === 'function') {
    for (const [taskId, sha] of Object.entries(integrationMap)) {
      if (!isAncestor(sha, legacyState.currentIntegrationHeadSha)) {
        throw new StateError(`Mapped central commit for ${taskId} is not an ancestor of integration HEAD`, 'INVALID_INTEGRATION_MAP');
      }
    }
  }
  const schemaV2 = {
    schemaVersion: 2,
    revision: legacyState.revision + 1,
    repository: legacyState.repository,
    prNumber: legacyState.prNumber,
    phase: 'recovering',
    baseSha: legacyState.baseSha,
    requestedHeadSha: null,
    reviewedHeadSha: null,
    currentIntegrationHeadSha: legacyState.currentIntegrationHeadSha,
    reviewRound: legacyState.reviewRound,
    verificationReviewUsed: false,
    legacyReviewProvenance: {
      schemaVersion: 1,
      discoveryRounds: legacyState.reviewRound,
      migratedAt,
    },
    releaseBaseline: legacyState.releaseBaseline,
    decisions: [...new Map(legacyState.decisions.map((decision) => [decision.id, decision])).values()],
    tasks: legacyState.tasks.map((task) => migrateTaskV1(task, integrationMap)),
    reviewRequest: null,
    reviewOutcome: null,
    reviewHistory: [],
    verificationEscalation: null,
    threadResolutionStatus: emptyThreadProof(),
    blockedReasons: unique(legacyState.blockedReasons),
    validationStatus: migrateValidationProof(legacyState.validationStatus, legacyState.currentIntegrationHeadSha),
    nextAction: 'Re-establish canonical review and structured thread evidence after schema v1 migration.',
    integrationWorktree: legacyState.integrationWorktree,
    orchestratorSessionId: legacyState.orchestratorSessionId,
    abandonmentReason: null,
    git: legacyState.git,
    updatedAt: migratedAt,
  };
  return migratePrReviewStateV2(schemaV2, { migratedAt });
}

export function migrateState({ cwd = process.cwd(), prNumber, integrationMap } = {}) {
  const activePr = activePrNumber(cwd);
  const selectedPr = prNumber === undefined || prNumber === null ? activePr : parsePrNumber(prNumber);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (activePr !== null && activePr !== selectedPr) {
    throw new StateError(`PR ${activePr} is active; refusing to migrate PR ${selectedPr}`, 'ACTIVE_POINTER_CONFLICT');
  }
  return withStateLock(cwd, selectedPr, () => {
    const lockedActivePr = activePrNumber(cwd);
    if (lockedActivePr !== null && lockedActivePr !== selectedPr) {
      throw new StateError(`PR ${lockedActivePr} is active; refusing to migrate PR ${selectedPr}`, 'ACTIVE_POINTER_CONFLICT');
    }
    const path = statePath(cwd, selectedPr);
    if (!existsSync(path)) throw new StateError(`No state file at ${path}`, 'STATE_NOT_FOUND');
    const legacySource = readFileSync(path, 'utf8');
    const legacy = readStateDocument(path);
    if (legacy.schemaVersion === 4) throw new StateError('State already uses schema v4', 'STATE_ALREADY_MIGRATED');
    const state = legacy.schemaVersion === 1
      ? migratePrReviewStateV1(legacy, {
          integrationMap,
          isAncestor: (ancestor, descendant) => runGit(
            ['merge-base', '--is-ancestor', ancestor, descendant],
            { cwd: legacy.integrationWorktree, allowFailure: true },
          ).status === 0,
        })
      : legacy.schemaVersion === 2
        ? migratePrReviewStateV2(legacy)
        : migratePrReviewStateV3(legacy);
    validateStateForWrite(state);
    const backupPath = join(stateDirectory(cwd, selectedPr), `state.v${legacy.schemaVersion}.backup.json`);
    if (existsSync(backupPath)) {
      const existingSource = readFileSync(backupPath, 'utf8');
      let semanticallyEqual = false;
      try { semanticallyEqual = JSON.stringify(JSON.parse(existingSource)) === JSON.stringify(legacy); } catch { /* fail closed */ }
      if (existingSource !== legacySource && !semanticallyEqual) {
        throw new StateError(`Migration backup differs from current v${legacy.schemaVersion} state at ${backupPath}`, 'MIGRATION_BACKUP_CONFLICT');
      }
    } else {
      atomicWriteText(backupPath, legacySource);
    }
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 4, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, {
      type: 'state-migrated',
      summary: `Migrated PR ${selectedPr} state from schema v${legacy.schemaVersion} to v4`,
    });
    return { state, backupPath };
  });
}

function prepareEvent({ type, summary, details } = {}) {
  if (typeof type !== 'string' || type.length < 1 || type.length > 128
      || typeof summary !== 'string' || summary.length < 1 || summary.length > 1000) {
    throw new StateError('Events require a concise type and summary', 'INVALID_EVENT');
  }
  const event = { schemaVersion: 1, type, summary, at: utcNow() };
  if (details !== undefined) {
    const serialized = JSON.stringify(details);
    if (serialized.length > 4000 || /(?:rawLog|stackTrace|transcript|fullDiff)/iu.test(serialized)) {
      throw new StateError('Event details must be concise and may not contain raw artifacts', 'INVALID_EVENT');
    }
    event.details = details;
  }
  return event;
}

export function appendEvent(cwd, prNumber, input = {}) {
  const event = prepareEvent(input);
  const directory = stateDirectory(cwd, prNumber);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'events.ndjson');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  atomicWriteText(path, `${existing}${JSON.stringify(event)}\n`);
}

function checkpointStateUnlocked({
  cwd, selectedPr, nextState, expectedRevision, event, eventWriter, transitionAuthorization,
}) {
  if (event) prepareEvent(event);
  const current = loadState(cwd, selectedPr);
  const expected = expectedRevision ?? nextState?.revision;
  if (expected !== current.revision) {
    throw new StateError(`State revision changed: expected ${expected}, found ${current.revision}`, 'STATE_REVISION_CONFLICT');
  }
  const immutable = ['repository', 'prNumber', 'baseSha', 'integrationWorktree'];
  for (const field of immutable) {
    if (nextState[field] !== current[field]) {
      throw new StateError(`${field} is immutable`, 'IMMUTABLE_STATE_IDENTITY');
    }
  }
  if (JSON.stringify(nextState.releaseBaseline) !== JSON.stringify(current.releaseBaseline)) {
    throw new StateError('releaseBaseline is immutable', 'IMMUTABLE_STATE_IDENTITY');
  }
  if (JSON.stringify(nextState.legacyReviewProvenance) !== JSON.stringify(current.legacyReviewProvenance)) {
    throw new StateError('legacyReviewProvenance is immutable', 'IMMUTABLE_STATE_IDENTITY');
  }
  if (nextState.reviewRound < current.reviewRound) {
    throw new StateError('reviewRound cannot decrease', 'INVALID_LIFECYCLE_TRANSITION');
  }
  if (current.verificationReviewUsed && !nextState.verificationReviewUsed) {
    throw new StateError('verificationReviewUsed is sticky', 'INVALID_LIFECYCLE_TRANSITION');
  }
  if (nextState.abandonmentReason !== null) {
    throw new StateError('abandonmentReason must remain null in active state', 'INVALID_LIFECYCLE_TRANSITION');
  }
  assertCheckpointProvenance(current, nextState, transitionAuthorization);
  const state = { ...nextState, revision: current.revision + 1, updatedAt: utcNow() };
  validateStateForWrite(state);
  atomicWriteJson(statePath(cwd, selectedPr), state);
  if (event) {
    try {
      eventWriter(cwd, selectedPr, event);
    } catch (error) {
      atomicWriteJson(statePath(cwd, selectedPr), current);
      throw new StateError(
        `Checkpoint event failed; state was rolled back: ${error.message}`,
        'CHECKPOINT_EVENT_FAILED',
      );
    }
  }
  return state;
}

export function checkpointState({
  cwd = process.cwd(), prNumber, nextState, expectedRevision, event, eventWriter = appendEvent,
  transitionAuthorization,
} = {}) {
  const selectedPr = prNumber ?? nextState?.prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => checkpointStateUnlocked({
    cwd, selectedPr, nextState, expectedRevision, event, eventWriter, transitionAuthorization,
  }));
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function protectedTransition(expectedState, kind) {
  return { token: TRANSITION_AUTHORIZATION, expectedState, kind };
}

function assertImmutableValue(current, next, label) {
  if (!sameEvidence(current, next)) {
    throw new StateError(`${label} is append-only provenance`, 'IMMUTABLE_STATE_PROVENANCE');
  }
}

function assertCheckpointProvenance(current, next, authorization) {
  const guardedKind = authorization?.token === TRANSITION_AUTHORIZATION ? authorization.kind : null;
  if (guardedKind !== null) {
    if (!sameEvidence(next, authorization.expectedState)) {
      throw new StateError('Guarded transition state does not match its authorization', 'INVALID_TRANSITION_AUTHORIZATION');
    }
  }
  if (guardedKind !== 'human-final-authorization') {
    assertImmutableValue(
      current.humanFinalReviewAuthorization,
      next.humanFinalReviewAuthorization,
      'humanFinalReviewAuthorization',
    );
  }
  if (guardedKind === null) {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
      'humanFinalReviewAuthorization',
    ]) assertImmutableValue(current[field], next[field], field);
    assertImmutableValue(current.ciValidationStatus, next.ciValidationStatus, 'ciValidationStatus');
    assertImmutableValue(current.ciValidationHistory, next.ciValidationHistory, 'ciValidationHistory');
    assertImmutableValue(current.validationStatus, next.validationStatus, 'validationStatus');
  } else if (guardedKind === 'review-request') {
    if (next.reviewHistory.length !== current.reviewHistory.length + 1) {
      throw new StateError('Review requests must append exactly one history entry', 'IMMUTABLE_STATE_PROVENANCE');
    }
    current.reviewHistory.forEach((entry, index) => assertImmutableValue(
      entry, next.reviewHistory[index], `reviewHistory[${index}]`,
    ));
    assertImmutableValue(current.verificationEscalation, next.verificationEscalation, 'verificationEscalation');
  } else if (guardedKind === 'review-outcome') {
    if (next.reviewHistory.length !== current.reviewHistory.length) {
      throw new StateError('Review outcomes cannot resize review history', 'IMMUTABLE_STATE_PROVENANCE');
    }
    current.reviewHistory.slice(0, -1).forEach((entry, index) => assertImmutableValue(
      entry, next.reviewHistory[index], `reviewHistory[${index}]`,
    ));
    assertImmutableValue(current.reviewHistory.at(-1)?.request, next.reviewHistory.at(-1)?.request, 'pending review request');
    if (current.reviewHistory.at(-1)?.outcome !== null) {
      assertImmutableValue(current.reviewHistory.at(-1)?.outcome, next.reviewHistory.at(-1)?.outcome, 'review outcome');
    }
    assertImmutableValue(current.verificationEscalation, next.verificationEscalation, 'verificationEscalation');
  } else if (guardedKind === 'verification-escalation') {
    if (current.verificationEscalation !== null || next.verificationEscalation === null) {
      throw new StateError('Verification escalation may be recorded exactly once', 'IMMUTABLE_STATE_PROVENANCE');
    }
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory',
    ]) assertImmutableValue(current[field], next[field], field);
    assertImmutableValue(
      current.humanFinalReviewAuthorization,
      next.humanFinalReviewAuthorization,
      'humanFinalReviewAuthorization',
    );
  } else if (guardedKind === 'human-final-authorization') {
    if (current.humanFinalReviewAuthorization !== null || next.humanFinalReviewAuthorization === null) {
      throw new StateError('Human-final authorization may be recorded exactly once', 'IMMUTABLE_STATE_PROVENANCE');
    }
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
    ]) assertImmutableValue(current[field], next[field], field);
  } else if (guardedKind === 'ci-validation') {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
      'humanFinalReviewAuthorization',
    ]) assertImmutableValue(current[field], next[field], field);
    const appended = next.ciValidationHistory.length === current.ciValidationHistory.length + 1;
    const restored = next.ciValidationHistory.length === current.ciValidationHistory.length
      && next.ciValidationHistory.some((entry) => sameEvidence(entry, next.ciValidationStatus));
    if (!appended && !restored) {
      throw new StateError(
        'CI validation must append one workflow-run record or restore an immutable historical record',
        'IMMUTABLE_STATE_PROVENANCE',
      );
    }
    current.ciValidationHistory.forEach((entry, index) => assertImmutableValue(
      entry, next.ciValidationHistory[index], `ciValidationHistory[${index}]`,
    ));
  } else if (guardedKind === 'targeted-validation') {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
      'humanFinalReviewAuthorization',
    ]) assertImmutableValue(current[field], next[field], field);
    assertImmutableValue(current.ciValidationStatus, next.ciValidationStatus, 'ciValidationStatus');
    assertImmutableValue(current.ciValidationHistory, next.ciValidationHistory, 'ciValidationHistory');
  } else if (guardedKind === 'git-metadata') {
    assertImmutableValue(
      current.humanFinalReviewAuthorization,
      next.humanFinalReviewAuthorization,
      'humanFinalReviewAuthorization',
    );
    assertImmutableValue(current.ciValidationHistory, next.ciValidationHistory, 'ciValidationHistory');
    if (!sameEvidence(current.ciValidationStatus, next.ciValidationStatus)) {
      assertImmutableValue(emptyCiValidation(), next.ciValidationStatus, 'invalidated ciValidationStatus');
    }
    if (!sameEvidence(current.validationStatus, next.validationStatus)) {
      assertImmutableValue(emptyTargetedValidation(), next.validationStatus, 'invalidated validationStatus');
    }
  } else {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
      'humanFinalReviewAuthorization',
    ]) assertImmutableValue(current[field], next[field], field);
  }
  if (!['targeted-validation', 'git-metadata'].includes(guardedKind)) {
    assertImmutableValue(current.validationStatus, next.validationStatus, 'validationStatus');
  }
  if (current.phase !== 'complete' && next.phase === 'complete' && guardedKind !== 'cycle-completion') {
    throw new StateError('Only the guarded completion checkpoint may enter complete', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (current.phase !== 'awaiting-review' && next.phase === 'awaiting-review' && guardedKind !== 'review-request') {
    throw new StateError('Only the guarded request checkpoint may enter awaiting-review', 'PROTECTED_TRANSITION_REQUIRED');
  }

  const nextTasks = new Map((next.tasks ?? []).map((task) => [task.id, task]));
  const currentTaskIds = new Set(current.tasks.map((task) => task.id));
  for (const task of next.tasks ?? []) {
    if (!currentTaskIds.has(task.id) && task.status !== 'proposed') {
      throw new StateError(`New task ${task.id} must begin as proposed`, 'IMMUTABLE_STATE_PROVENANCE');
    }
    if (!currentTaskIds.has(task.id) && task.taskPacketDigest) {
      throw new StateError(`New task ${task.id} packet binding requires a guarded transition`, 'PROTECTED_TRANSITION_REQUIRED');
    }
  }
  for (const task of current.tasks) {
    const updated = nextTasks.get(task.id);
    if (!updated) throw new StateError(`Task ${task.id} cannot be deleted`, 'IMMUTABLE_STATE_PROVENANCE');
    for (const field of ['id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition']) {
      assertImmutableValue(task[field], updated[field], `task ${task.id} ${field}`);
    }
    if (task.taskPacketDigest) {
      assertImmutableValue(task.taskPacketDigest, updated.taskPacketDigest, `task ${task.id} taskPacketDigest`);
    } else if (updated.taskPacketDigest && guardedKind !== 'task-packet-binding') {
      throw new StateError(`Task ${task.id} packet binding requires a guarded transition`, 'PROTECTED_TRANSITION_REQUIRED');
    }
    if (task.integratedCommitSha !== null) {
      assertImmutableValue(task.integratedCommitSha, updated.integratedCommitSha, `task ${task.id} integratedCommitSha`);
    }
    if (task.resolutionSummary !== null) {
      assertImmutableValue(task.resolutionSummary, updated.resolutionSummary, `task ${task.id} resolutionSummary`);
    }
    if (task.status === 'completed') assertImmutableValue(task, updated, `completed task ${task.id}`);
    if (task.status !== 'completed' && updated.status === 'completed' && guardedKind !== 'task-completion') {
      throw new StateError(`Task ${task.id} completion requires guarded proof`, 'PROTECTED_TRANSITION_REQUIRED');
    }
  }

  const nextDecisions = new Map((next.decisions ?? []).map((decision) => [decision.id, decision]));
  for (const decision of current.decisions) {
    assertImmutableValue(decision, nextDecisions.get(decision.id), `decision ${decision.id}`);
  }

  const currentThreads = current.threadResolutionStatus.threads ?? [];
  const nextThreads = next.threadResolutionStatus.threads ?? [];
  if (currentThreads.length > nextThreads.length || (currentThreads.length !== nextThreads.length && guardedKind !== 'task-completion')) {
    throw new StateError('Canonical threads may only be added by guarded task completion', 'IMMUTABLE_STATE_PROVENANCE');
  }
  const nextByNode = new Map(nextThreads.map((thread) => [thread.threadNodeId, thread]));
  for (const thread of currentThreads) {
    const updated = nextByNode.get(thread.threadNodeId);
    if (!updated) throw new StateError(`Thread ${thread.threadNodeId} cannot disappear`, 'IMMUTABLE_STATE_PROVENANCE');
    for (const field of [
      'threadNodeId', 'rootCommentNodeId', 'rootCommentDatabaseId', 'taskIds', 'disposition', 'observedHeadSha',
    ]) assertImmutableValue(thread[field], updated[field], `thread ${thread.threadNodeId} ${field}`);
    if (thread.replyId !== null) {
      assertImmutableValue(thread.replyId, updated.replyId, `thread ${thread.threadNodeId} replyId`);
      assertImmutableValue(thread.replyUrl, updated.replyUrl, `thread ${thread.threadNodeId} replyUrl`);
    } else if (updated.replyId !== null && guardedKind !== 'task-completion') {
      throw new StateError(`Thread ${thread.threadNodeId} reply evidence requires guarded persistence`, 'PROTECTED_TRANSITION_REQUIRED');
    }
    if (thread.isResolved) {
      assertImmutableValue(thread, updated, `resolved thread ${thread.threadNodeId}`);
    } else if (updated.isResolved && guardedKind !== 'task-completion') {
      throw new StateError(`Thread ${thread.threadNodeId} resolution requires guarded persistence`, 'PROTECTED_TRANSITION_REQUIRED');
    }
  }
  const oldThreadless = current.threadResolutionStatus.threadlessVerification;
  const newThreadless = next.threadResolutionStatus.threadlessVerification;
  if (guardedKind === null && oldThreadless.status === 'passed') {
    assertImmutableValue(oldThreadless, newThreadless, 'successful threadless task proof');
  }
  if (oldThreadless.status === 'passed') {
    if (newThreadless.status !== 'passed'
        || oldThreadless.taskIds.some((taskId) => !newThreadless.taskIds.includes(taskId))) {
      throw new StateError('Successful threadless task proof cannot regress', 'IMMUTABLE_STATE_PROVENANCE');
    }
  }
  if (oldThreadless.status !== 'passed' && newThreadless.status === 'passed' && guardedKind !== 'task-completion') {
    throw new StateError('Threadless proof may only pass through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (newThreadless.taskIds.some((taskId) => !oldThreadless.taskIds.includes(taskId)) && guardedKind !== 'task-completion') {
    throw new StateError('Threadless task proof may only grow through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  const oldLocal = current.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  const newLocal = next.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  if (guardedKind !== 'task-completion') {
    assertImmutableValue(oldLocal, newLocal, 'local verifier proof');
  }
  if (oldLocal.status === 'passed') {
    if (newLocal.status !== 'passed') {
      throw new StateError('Successful local verifier proof cannot regress', 'IMMUTABLE_STATE_PROVENANCE');
    }
    if (oldLocal.headSha === newLocal.headSha
        && oldLocal.taskIds.some((taskId) => !newLocal.taskIds.includes(taskId))) {
      throw new StateError(
        'Same-HEAD local verifier proof cannot lose task coverage',
        'IMMUTABLE_STATE_PROVENANCE',
      );
    }
  }
  if (oldLocal.status !== 'passed' && newLocal.status === 'passed' && guardedKind !== 'task-completion') {
    throw new StateError('Local verifier proof may only pass through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (current.threadResolutionStatus.status !== 'passed'
      && next.threadResolutionStatus.status === 'passed' && guardedKind !== 'task-completion') {
    throw new StateError('Aggregate thread proof may only pass through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (guardedKind === null && current.threadResolutionStatus.status === 'passed') {
    if (next.threadResolutionStatus.status === 'passed') {
      assertImmutableValue(current.threadResolutionStatus, next.threadResolutionStatus, 'successful aggregate thread proof');
    } else if (next.threadResolutionStatus.status === 'not-run') {
      assertImmutableValue(currentThreads, nextThreads, 'historical canonical thread evidence');
      assertImmutableValue(oldThreadless, newThreadless, 'historical threadless task proof');
      assertImmutableValue(oldLocal, newLocal, 'historical local verifier proof');
    } else {
      throw new StateError(
        'Successful aggregate thread proof may only be preserved or invalidated to not-run',
        'IMMUTABLE_STATE_PROVENANCE',
      );
    }
  }
}

export function buildHumanFinalReviewAuthorizationTransition(state, {
  decisionId, notBefore, summary, authorizedAt = utcNow(),
} = {}) {
  if (state.humanFinalReviewAuthorization !== null) {
    const expected = {
      ...state.humanFinalReviewAuthorization,
      decisionId,
      notBefore,
      summary,
    };
    if (!sameEvidence(state.humanFinalReviewAuthorization, expected)) {
      throw new StateError(
        'Human-final authorization is immutable and conflicts with the requested authorization',
        'HUMAN_FINAL_AUTHORIZATION_CONFLICT',
      );
    }
    return state;
  }
  assertTrustedTimestamp(authorizedAt, 'Trusted authorization time');
  assertTrustedTimestamp(notBefore, 'Human-final notBefore');
  if (typeof decisionId !== 'string' || decisionId.length < 1 || decisionId.length > 128
      || !state.decisions.some((decision) => decision.id === decisionId)) {
    throw new StateError(
      'Human-final authorization must bind an existing durable decision ID',
      'INVALID_HUMAN_FINAL_AUTHORIZATION',
    );
  }
  if (typeof summary !== 'string' || summary.length < 1 || summary.length > 1000
      || summary.trim() !== summary) {
    throw new StateError('Human-final authorization summary is invalid', 'INVALID_HUMAN_FINAL_AUTHORIZATION');
  }
  const latest = state.reviewHistory.at(-1);
  if (state.schemaVersion !== 4
      || state.phase !== 'awaiting-human-decision'
      || state.reviewRound !== 3
      || state.verificationReviewUsed !== true
      || state.reviewHistory.length !== 4
      || state.reviewHistory.filter((entry) => entry.request.kind === 'discovery').length !== 3
      || state.reviewHistory.filter((entry) => entry.request.kind === 'verification').length !== 1
      || state.reviewHistory.some((entry) => entry.request.kind === 'human-final')
      || state.reviewRequest?.id !== latest?.request?.id
      || state.reviewOutcome?.id !== latest?.outcome?.id
      || latest?.request?.kind !== 'verification'
      || latest?.outcome?.kind !== 'verification'
      || latest?.outcome?.outcome !== 'findings'
      || latest?.outcome?.requestId !== latest?.request?.id
      || latest?.outcome?.headSha !== latest?.request?.headSha
      || state.verificationEscalation !== null) {
    throw new StateError(
      'Human-final authorization requires the exact terminal 3+1 verification-findings state',
      'HUMAN_FINAL_AUTHORIZATION_NOT_ELIGIBLE',
    );
  }
  if (Date.parse(authorizedAt) < Date.parse(latest.outcome.at)) {
    throw new StateError(
      'Trusted authorization time cannot predate the verification outcome',
      'INVALID_HUMAN_FINAL_AUTHORIZATION',
    );
  }
  const authorization = {
    decisionId,
    source: 'operator-instruction',
    authorizedAt,
    verificationOutcomeId: latest.outcome.id,
    notBefore,
    summary,
  };
  const next = {
    ...state,
    humanFinalReviewAuthorization: authorization,
    nextAction: `Address the verification findings and request the one-shot human-final review no earlier than ${notBefore}.`,
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid human-final authorization transition:\n- ${errors.join('\n- ')}`,
      'INVALID_HUMAN_FINAL_AUTHORIZATION',
    );
  }
  return next;
}

export function buildReviewRequestTransition(state, request, external) {
  if (state.reviewRequest?.id === request?.id) {
    if (!sameEvidence(state.reviewRequest, request)) {
      throw new StateError('Review request ID was reused with different evidence', 'REVIEW_EVIDENCE_CONFLICT');
    }
    return state;
  }
  const kind = assertReviewRequestAllowed(state, external);
  if (request?.kind !== kind || request?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('Review request kind and SHA must match the guarded transition', 'INVALID_REVIEW_REQUEST');
  }
  if (kind === 'human-final') {
    const authorization = state.humanFinalReviewAuthorization;
    if (authorization === null
        || !Number.isFinite(Date.parse(request?.at))
        || Date.parse(request.at) < Date.parse(authorization.notBefore)
        || Date.parse(request.at) < Date.parse(authorization.authorizedAt)) {
      throw new StateError(
        'Human-final request evidence must be created at or after its authorization and notBefore time',
        'INVALID_REVIEW_REQUEST',
      );
    }
  }
  const next = {
    ...state,
    phase: 'awaiting-review',
    requestedHeadSha: state.currentIntegrationHeadSha,
    reviewedHeadSha: null,
    reviewRound: kind === 'discovery' ? state.reviewRound + 1 : state.reviewRound,
    verificationReviewUsed: kind === 'verification' ? true : state.verificationReviewUsed,
    reviewRequest: request,
    reviewOutcome: null,
    reviewHistory: [...state.reviewHistory, { request, outcome: null }],
    nextAction: 'Collect the canonical Codex outcome for the exact requested SHA.',
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid review request transition:\n- ${errors.join('\n- ')}`, 'INVALID_REVIEW_REQUEST');
  return next;
}

export function buildReviewOutcomeTransition(state, outcome) {
  if (state.reviewOutcome?.id === outcome?.id) {
    if (!sameEvidence(state.reviewOutcome, outcome)) {
      throw new StateError('Review outcome ID was reused with different evidence', 'REVIEW_EVIDENCE_CONFLICT');
    }
    return state;
  }
  const request = state.reviewRequest;
  if (state.phase !== 'awaiting-review' || !request || state.reviewOutcome !== null) {
    throw new StateError('No pending canonical review request to collect', 'REVIEW_OUTCOME_NOT_EXPECTED');
  }
  if (outcome?.requestId !== request.id || outcome?.kind !== request.kind
      || outcome?.headSha !== request.headSha || outcome?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('Review outcome must bind to the pending request, kind, and SHA', 'INVALID_REVIEW_OUTCOME');
  }
  const phase = ['verification', 'human-final'].includes(outcome.kind) && outcome.outcome === 'findings'
    ? 'awaiting-human-decision'
    : outcome.outcome === 'findings' ? 'triaging' : 'validating';
  const reviewHistory = state.reviewHistory.map((entry, index) => (
    index === state.reviewHistory.length - 1 ? { ...entry, outcome } : entry
  ));
  const next = {
    ...state,
    phase,
    reviewedHeadSha: outcome.headSha,
    reviewOutcome: outcome,
    reviewHistory,
    nextAction: phase === 'validating'
      ? 'Confirm fresh local, pushed, and live PR heads, then complete the cycle.'
      : phase === 'awaiting-human-decision'
        ? `Present ${outcome.kind} findings for human decision; no further automatic review is permitted.`
        : 'Triage the applicable canonical review findings.',
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid review outcome transition:\n- ${errors.join('\n- ')}`, 'INVALID_REVIEW_OUTCOME');
  return next;
}

export function buildVerificationEscalationTransition(state, escalation) {
  if (state.verificationEscalation !== null) {
    if (!sameEvidence(state.verificationEscalation, escalation)) {
      throw new StateError('Verification escalation is append-only evidence', 'REVIEW_EVIDENCE_CONFLICT');
    }
    return state;
  }
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  if (!['awaiting-review', 'awaiting-human-decision'].includes(state.phase)
      || !['verification', 'human-final'].includes(request?.kind) || state.verificationReviewUsed !== true
      || state.reviewOutcome !== null || latest?.request?.id !== request.id || latest?.outcome !== null) {
    throw new StateError(
      'No pending canonical terminal review collection to escalate',
      'VERIFICATION_ESCALATION_NOT_EXPECTED',
    );
  }
  if (escalation?.requestId !== request.id || escalation?.requestHeadSha !== request.headSha) {
    throw new StateError('Verification escalation must bind to the pending request and exact SHA', 'INVALID_VERIFICATION_ESCALATION');
  }
  const next = {
    ...state,
    phase: 'awaiting-human-decision',
    verificationEscalation: escalation,
    nextAction: `Present the canonical ${request.kind} collection escalation and evidence to a human.`,
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(`Invalid verification escalation transition:\n- ${errors.join('\n- ')}`, 'INVALID_VERIFICATION_ESCALATION');
  }
  return next;
}

export function buildCompletionTransition(state, external) {
  assertCompletionAllowed(state, external);
  const next = { ...state, phase: 'complete', nextAction: 'Archive the completed review cycle.' };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid completion transition:\n- ${errors.join('\n- ')}`, 'REVIEW_CYCLE_INCOMPLETE');
  return next;
}

export function buildCiValidationTransition(state, evidence) {
  if (evidence?.source !== 'github-actions' || evidence?.scope !== 'full'
      || !['passed', 'failed'].includes(evidence?.status)
      || typeof evidence?.checkRunId !== 'string' || evidence.checkRunId.length === 0
      || evidence?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('CI evidence must be full GitHub Actions validation for the current integration HEAD', 'INVALID_CI_VALIDATION');
  }
  const existing = state.ciValidationHistory.find((entry) => entry.checkRunId === evidence.checkRunId);
  if (existing && !sameEvidence(existing, evidence)) {
    throw new StateError('GitHub Actions check run ID was reused with different evidence', 'CI_EVIDENCE_CONFLICT');
  }
  if (existing && sameEvidence(state.ciValidationStatus, evidence)) return state;
  const next = {
    ...state,
    ciValidationStatus: evidence,
    ciValidationHistory: existing ? state.ciValidationHistory : [...state.ciValidationHistory, evidence],
    nextAction: evidence.status === 'passed'
      ? state.nextAction
      : 'Inspect the failed full GitHub Actions run, then record a new run for the same review commit.',
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid CI validation transition:\n- ${errors.join('\n- ')}`, 'INVALID_CI_VALIDATION');
  return next;
}

function buildTargetedValidationTransition(state, plan, timestamp = utcNow()) {
  const errors = validateValidationPlan(plan, state);
  if (errors.length > 0) throw new StateError(`Invalid targeted validation plan:\n- ${errors.join('\n- ')}`, 'INVALID_VALIDATION_PLAN');
  if (plan.commands.some((entry) => entry.status === 'pending')) {
    throw new StateError('Targeted validation plan still has pending commands', 'VALIDATION_PLAN_INCOMPLETE');
  }
  if (JSON.stringify([...plan.taskIds].sort()) !== JSON.stringify(actionableIntegratedTaskIds(state))) {
    throw new StateError('Targeted validation plan no longer covers current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
  }
  const status = plan.commands.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
  const next = {
    ...state,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status, headSha: plan.headSha,
      checks: plan.commands.map((entry) => entry.command), updatedAt: timestamp,
    },
    nextAction: status === 'passed'
      ? state.nextAction
      : 'Fix the failed targeted check, rebuild the validation plan, and run it again.',
  };
  const stateErrors = validatePrReviewState(next);
  if (stateErrors.length > 0) throw new StateError(`Invalid targeted validation transition:\n- ${stateErrors.join('\n- ')}`, 'INVALID_TARGETED_VALIDATION');
  return next;
}

export function checkpointTargetedValidationReset({ cwd = process.cwd(), prNumber, expectedRevision } = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (current.validationStatus.status === 'not-run') return current;
  if (current.validationStatus.status === 'passed'
      && (isCleanTasklessReviewValidationRecovery(current, actionableIntegratedTaskIds(current))
        || isNativeTasklessReviewHeadDriftValidationRecovery(current, actionableIntegratedTaskIds(current)))) {
    throw new StateError(
      'Taskless review recovery cannot discard existing targeted-validation proof',
      'INITIAL_VALIDATION_NOT_ALLOWED',
    );
  }
  const nextState = {
    ...current,
    validationStatus: emptyTargetedValidation(),
    ...(current.phase === 'ready-for-review' ? {
      phase: 'recovering', nextAction: 'Run the saved targeted validation plan before requesting review.',
    } : {}),
  };
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event: { type: 'targeted-validation-reset', summary: 'Reset targeted validation before creating a new plan' },
    transitionAuthorization: protectedTransition(nextState, 'targeted-validation'),
  });
}

function checkpointTargetedValidationUnlocked({ cwd, selectedPr, expectedRevision }) {
  const current = loadState(cwd, selectedPr);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  assertCleanExactIntegrationHead(current);
  const plan = readValidationPlan(cwd, current);
  const nextState = buildTargetedValidationTransition(current, plan);
  return checkpointStateUnlocked({
    cwd, selectedPr: current.prNumber, nextState, expectedRevision, eventWriter: appendEvent,
    event: {
      type: 'targeted-validation-recorded',
      summary: `Recorded ${nextState.validationStatus.status} targeted validation for ${current.currentIntegrationHeadSha}`,
    },
    transitionAuthorization: protectedTransition(nextState, 'targeted-validation'),
  });
}

export function checkpointTargetedValidation({ cwd = process.cwd(), prNumber, expectedRevision } = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => checkpointTargetedValidationUnlocked({
    cwd, selectedPr, expectedRevision,
  }));
}

export function executeTargetedValidationPlan({
  cwd = process.cwd(), prNumber, runCommand = (argv, commandCwd) => spawnSync(argv[0], argv.slice(1), {
    cwd: commandCwd, stdio: 'inherit', shell: false,
  }), now = utcNow, onCommandRecorded, onProofCheckpointed,
} = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    let state = loadState(cwd, selectedPr);
    if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    assertCleanExactIntegrationHead(state);
    let plan = readValidationPlan(cwd, state);
    if (JSON.stringify([...plan.taskIds].sort()) !== JSON.stringify(actionableIntegratedTaskIds(state))) {
      throw new StateError('Targeted validation plan no longer covers current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
    }
    for (let index = 0; index < plan.commands.length; index += 1) {
      const entry = plan.commands[index];
      if (entry.status !== 'pending') continue;
      state = loadState(cwd, state.prNumber);
      assertCleanExactIntegrationHead(state);
      if (state.currentIntegrationHeadSha !== plan.headSha || state.revision !== plan.stateRevision) {
        throw new StateError('Targeted validation plan is stale', 'VALIDATION_PLAN_STALE');
      }
      if (JSON.stringify([...plan.taskIds].sort()) !== JSON.stringify(actionableIntegratedTaskIds(state))) {
        throw new StateError('Targeted validation plan no longer covers current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
      }
      let result;
      try {
        result = runCommand([...entry.argv], state.integrationWorktree);
      } catch (error) {
        result = { status: 1, error };
      }
      const exitCode = Number.isInteger(result?.status) && result.status >= 0 ? result.status : 1;
      const completedAt = now();
      const summary = exitCode === 0
        ? 'Passed.'
        : `Failed with exit code ${exitCode}${result?.error?.message ? `: ${String(result.error.message).slice(0, 400)}` : '.'}`;
      plan = {
        ...plan,
        commands: plan.commands.map((item, itemIndex) => itemIndex === index ? {
          ...item, status: exitCode === 0 ? 'passed' : 'failed', exitCode, summary, completedAt,
        } : item),
        updatedAt: completedAt,
      };
      atomicWriteJson(validationPlanPath(cwd, state.prNumber), plan);
      onCommandRecorded?.(entry.command, plan);
    }
    const checkpointed = checkpointTargetedValidationUnlocked({
      cwd, selectedPr: state.prNumber, expectedRevision: state.revision,
    });
    onProofCheckpointed?.(checkpointed, plan);
    return { plan, state: checkpointed };
  });
}

const VERIFIED_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

function taskIsEligibleForVerifierCompletion(task) {
  const actionable = task.disposition === 'actionable'
    && ['integrated', 'completed'].includes(task.status)
    && Boolean(task.integratedCommitSha);
  const nonActionable = VERIFIED_NON_ACTIONABLE_DISPOSITIONS.has(task.disposition)
    && ['not-applicable', 'completed'].includes(task.status);
  return actionable || nonActionable;
}

export function completeIntegratedTasks(state, { threadResolutionStatus, verifiedLocalTaskIds = [] }) {
  if (!threadResolutionStatus || typeof threadResolutionStatus !== 'object'
      || Array.isArray(threadResolutionStatus)) {
    throw new StateError('Thread resolution proof is required for task completion', 'INVALID_TASK_COMPLETION');
  }
  if (!Array.isArray(verifiedLocalTaskIds)
      || verifiedLocalTaskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
      || new Set(verifiedLocalTaskIds).size !== verifiedLocalTaskIds.length) {
    throw new StateError('Verified local task IDs must be unique nonempty strings', 'INVALID_TASK_COMPLETION');
  }
  const verifiedLocalTasks = new Set(verifiedLocalTaskIds);
  for (const taskId of verifiedLocalTasks) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new StateError(`Verified local task ${taskId} was not found`, 'INVALID_TASK_COMPLETION');
    if (task.sourceType !== 'local') {
      throw new StateError(`Verified local task ${taskId} is not local`, 'INVALID_TASK_COMPLETION');
    }
    if (!taskIsEligibleForVerifierCompletion(task)) {
      throw new StateError(`Verified local task ${taskId} is not eligible for verifier completion`, 'INVALID_TASK_COMPLETION');
    }
  }
  const previousLocalVerification = state.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  const { localVerification: _untrustedLocalVerification, ...threadProofWithoutLocal } = threadResolutionStatus;
  let completionThreadProof = Object.hasOwn(state.threadResolutionStatus, 'localVerification')
    ? { ...threadProofWithoutLocal, localVerification: previousLocalVerification }
    : threadProofWithoutLocal;
  if (verifiedLocalTasks.size > 0) {
    if (threadResolutionStatus.status === 'not-run'
        || threadResolutionStatus.headSha !== state.currentIntegrationHeadSha
        || threadResolutionStatus.updatedAt === null) {
      throw new StateError(
        'Verified local tasks require a current-HEAD aggregate observation and timestamp',
        'INVALID_TASK_COMPLETION',
      );
    }
    const retainedIds = previousLocalVerification.status === 'passed'
        && previousLocalVerification.headSha === state.currentIntegrationHeadSha
      ? previousLocalVerification.taskIds : [];
    completionThreadProof = {
      ...threadProofWithoutLocal,
      localVerification: {
        status: 'passed',
        headSha: state.currentIntegrationHeadSha,
        taskIds: [...new Set([...retainedIds, ...verifiedLocalTasks])].sort(),
        updatedAt: threadResolutionStatus.updatedAt,
      },
    };
  }
  const tasks = state.tasks.map((task) => {
    const eligibleNotApplicable = task.status === 'not-applicable'
      && !['actionable', 'needs-human-decision'].includes(task.disposition);
    if (task.status !== 'integrated' && !eligibleNotApplicable) return task;
    const eligible = (task.sourceType === 'local' && verifiedLocalTasks.has(task.id))
      || (task.sourceType === 'github-thread'
        && taskHasCanonicalThreadCoverage(task, completionThreadProof.threads ?? []))
      || (task.sourceType === 'github-threadless'
        && completionThreadProof.threadlessVerification?.status === 'passed'
        && completionThreadProof.threadlessVerification.headSha === state.currentIntegrationHeadSha
        && completionThreadProof.threadlessVerification.taskIds.includes(task.id));
    return eligible ? { ...task, status: 'completed' } : task;
  });
  const next = { ...state, tasks, threadResolutionStatus: completionThreadProof };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid integrated-to-completed transition:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_COMPLETION');
  return next;
}

export function checkpointTaskPacketBinding({
  cwd = process.cwd(), prNumber, packet, expectedRevision, event,
} = {}) {
  const errors = validateTaskPacket(packet);
  if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const task = current.tasks.find((candidate) => candidate.id === packet.taskId);
  if (!task || task.disposition !== 'actionable') {
    throw new StateError('Task packet must match an actionable durable task', 'TASK_PACKET_NOT_BOUND');
  }
  const digest = taskPacketDigest(packet);
  assertTaskPacketHead(current, task, packet, digest);
  if (task.taskPacketDigest) {
    if (task.taskPacketDigest !== digest) {
      throw new StateError('Task packet differs from the accepted packet', 'TASK_PACKET_CONFLICT');
    }
    return current;
  }
  const nextState = {
    ...current,
    tasks: current.tasks.map((candidate) => candidate.id === packet.taskId
      ? { ...candidate, taskPacketDigest: digest }
      : candidate),
  };
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event: event ?? { type: 'task-packet-bound', summary: `Bound accepted packet for task ${packet.taskId}` },
    transitionAuthorization: protectedTransition(nextState, 'task-packet-binding'),
  });
}

export function checkpointHumanFinalReviewAuthorization({
  cwd = process.cwd(), prNumber, decisionId, notBefore, summary, authorizedAt, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildHumanFinalReviewAuthorizationTransition(current, {
    decisionId,
    notBefore,
    summary,
    authorizedAt: authorizedAt ?? utcNow(),
  });
  if (nextState === current) return current;
  return checkpointState({
    cwd,
    prNumber: current.prNumber,
    nextState,
    expectedRevision,
    event: event ?? {
      type: 'human-final-review-authorized',
      summary: `Authorized one human-final review no earlier than ${notBefore}`,
    },
    transitionAuthorization: protectedTransition(nextState, 'human-final-authorization'),
  });
}

export function checkpointReviewRequest({
  cwd = process.cwd(), prNumber, request, pushedHeadSha, prHeadSha, currentTime, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildReviewRequestTransition(
    current,
    request,
    gitAwareGateContext(current, { pushedHeadSha, prHeadSha, currentTime }),
  );
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'review-request'),
  });
}

export function checkpointReviewOutcome({
  cwd = process.cwd(), prNumber, outcome, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildReviewOutcomeTransition(current, outcome);
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'review-outcome'),
  });
}

export function checkpointVerificationEscalation({
  cwd = process.cwd(), prNumber, escalation, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildVerificationEscalationTransition(current, escalation);
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'verification-escalation'),
  });
}

export function checkpointCompletion({
  cwd = process.cwd(), prNumber, pushedHeadSha, prHeadSha, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildCompletionTransition(
    current,
    gitAwareGateContext(current, { pushedHeadSha, prHeadSha }),
  );
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'cycle-completion'),
  });
}

export function checkpointCiValidation({
  cwd = process.cwd(), prNumber, evidence, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildCiValidationTransition(current, evidence);
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'ci-validation'),
  });
}

export function checkpointTaskCompletion({
  cwd = process.cwd(), prNumber, threadResolutionStatus, verifiedLocalTaskIds = [], expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = completeIntegratedTasks(current, { threadResolutionStatus, verifiedLocalTaskIds });
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'task-completion'),
  });
}

export function reconcileState({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) return { state: null, warnings: [] };
  const warnings = [];
  let actual;
  try {
    actual = gitSnapshot(state.integrationWorktree);
    if (actual.headSha !== state.currentIntegrationHeadSha) {
      warnings.push(`Integration HEAD is ${actual.headSha}, recorded ${state.currentIntegrationHeadSha}`);
    }
    if (actual.dirty) warnings.push('Integration checkout has uncommitted changes');
  } catch (error) {
    warnings.push(`Unable to inspect integration checkout: ${error.message}`);
    actual = null;
  }
  return { state, actualGit: actual, warnings };
}

export function checkpointGitMetadata({ cwd = process.cwd(), sessionId, backup = false } = {}) {
  const selectedPr = activePrNumber(cwd);
  if (selectedPr === null) return { state: null, checkpointed: false, warning: null };
  return withStateLock(cwd, selectedPr, () => {
    const state = loadState(cwd, selectedPr);
    const currentRoot = repositoryRoot(cwd);
    if (resolve(currentRoot) !== resolve(state.integrationWorktree)) {
      return { state, checkpointed: false, warning: 'Skipped checkpoint outside the integration worktree' };
    }
    if (state.orchestratorSessionId && sessionId && state.orchestratorSessionId !== sessionId) {
      return { state, checkpointed: false, warning: 'Skipped checkpoint for a different session' };
    }
    const git = gitSnapshot(state.integrationWorktree);
    if (backup) atomicWriteJson(join(stateDirectory(cwd, state.prNumber), 'state.backup.json'), state);
    const headChanged = git.headSha !== state.currentIntegrationHeadSha;
    const headSensitivePhases = new Set([
      'ready-for-review',
      'awaiting-review',
      'triaging',
      'verifying',
      'validating',
      'complete',
    ]);
    let checkpointUpdate = {};
    if (headChanged) {
      checkpointUpdate = {
        validationStatus: emptyTargetedValidation(),
        ciValidationStatus: emptyCiValidation(),
        threadResolutionStatus: {
          ...state.threadResolutionStatus,
          status: 'not-run',
          headSha: null,
          updatedAt: null,
        },
        ...(state.phase === 'awaiting-review' ? {
          phase: ['verification', 'human-final'].includes(state.reviewRequest?.kind)
            ? 'awaiting-human-decision' : 'recovering',
          nextAction: ['verification', 'human-final'].includes(state.reviewRequest?.kind)
            ? `The ${state.reviewRequest.kind} request became stale; present the terminal stale-request decision to a human.`
            : 'The discovery request became stale; reconcile the new HEAD before requesting another review.',
        } : headSensitivePhases.has(state.phase) ? {
            phase: 'recovering',
            nextAction: 'Reconcile the changed integration checkout and re-establish exact-head proof.',
          } : {}),
      };
    } else if (git.dirty && state.phase === 'ready-for-review') {
      checkpointUpdate = {
        phase: 'recovering',
        nextAction: 'Clean the integration checkout and checkpoint Git metadata to restore review readiness.',
      };
    } else if (git.dirty && state.phase === 'complete') {
      checkpointUpdate = {
        phase: 'recovering',
        nextAction: 'Clean the integration checkout, checkpoint Git metadata, and re-run guarded completion.',
      };
    } else if (!git.dirty && state.phase === 'recovering'
      && state.nextAction === 'Clean the integration checkout and checkpoint Git metadata to restore review readiness.') {
      checkpointUpdate = { phase: 'ready-for-review', nextAction: 'Request canonical review.' };
    }
    const nextState = {
      ...state,
      currentIntegrationHeadSha: git.headSha,
      git,
      ...checkpointUpdate,
    };
    const warning = git.dirty ? 'Integration checkout is dirty' : null;
    if (sameEvidence(state, nextState)) return { state, checkpointed: false, warning };
    const updated = checkpointStateUnlocked({
      cwd,
      selectedPr: state.prNumber,
      nextState,
      expectedRevision: state.revision,
      event: { type: 'git-checkpoint', summary: `Checkpointed integration HEAD ${git.headSha}` },
      eventWriter: appendEvent,
      transitionAuthorization: protectedTransition(nextState, 'git-metadata'),
    });
    return { state: updated, checkpointed: true, warning };
  });
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function validationPlanRecoverySummary(cwd, state) {
  const path = validationPlanPath(cwd, state.prNumber);
  if (!existsSync(path)) return 'missing';
  try {
    const plan = readValidationPlan(cwd, state);
    const counts = Object.fromEntries(['pending', 'passed', 'failed'].map((status) => [
      status, plan.commands.filter((entry) => entry.status === status).length,
    ]));
    return `${plan.headSha}; pending ${counts.pending}, passed ${counts.passed}, failed ${counts.failed}`;
  } catch (error) {
    if (error.code !== 'INVALID_VALIDATION_PLAN') return `unavailable (${error.code ?? 'error'})`;
    try {
      const source = readFileSync(path, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > VALIDATION_PLAN_LIMIT_BYTES) return 'invalid';
      const plan = JSON.parse(source);
      const historicalErrors = validateValidationPlan(plan, {
        ...state, revision: plan?.stateRevision, currentIntegrationHeadSha: plan?.headSha,
      });
      if (historicalErrors.length > 0) return 'invalid';
      const counts = Object.fromEntries(['pending', 'passed', 'failed'].map((status) => [
        status, plan.commands.filter((entry) => entry.status === status).length,
      ]));
      const countSummary = `pending ${counts.pending}, passed ${counts.passed}, failed ${counts.failed}`;
      if (plan.headSha !== state.currentIntegrationHeadSha) {
        return `historical for ${plan.headSha}; ${countSummary}; current HEAD is ${state.currentIntegrationHeadSha}`;
      }
      const recordedStatus = plan.commands.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
      const proofMatches = counts.pending === 0
        && state.validationStatus.source === 'orchestrator'
        && state.validationStatus.scope === 'targeted'
        && state.validationStatus.status === recordedStatus
        && state.validationStatus.headSha === plan.headSha
        && JSON.stringify(state.validationStatus.checks) === JSON.stringify(plan.commands.map((entry) => entry.command));
      if (proofMatches) return `${plan.headSha}; completed; ${countSummary}; recorded proof ${recordedStatus}`;
      return `${plan.headSha}; historical; ${countSummary}; current proof not recorded`;
    } catch {
      return 'invalid';
    }
  }
}

export function renderRecoverySummary({ cwd = process.cwd(), prNumber, maxCharacters = 9000 } = {}) {
  const { state, warnings } = reconcileState({ cwd, prNumber });
  if (!state) return '';
  const release = state.releaseBaseline ? `${state.releaseBaseline.tag} (${state.releaseBaseline.commit})` : 'pre-release';
  const taskLines = state.tasks.slice(0, 30).map((task) => `- ${task.id} [${task.status}]: ${truncate(task.summary, 180)}`);
  const decisions = state.decisions.slice(0, 15).map((decision) => {
    const id = typeof decision === 'object' ? decision.id ?? 'decision' : 'decision';
    const summary = typeof decision === 'object' ? decision.summary ?? JSON.stringify(decision) : String(decision);
    return `- ${id}: ${truncate(summary, 180)}`;
  });
  const lines = [
    `PR review recovery: ${state.repository}#${state.prNumber}`,
    `Phase: ${state.phase}; round: ${state.reviewRound}`,
    `Release baseline: ${release}`,
    `Base: ${state.baseSha}`,
    `Requested/reviewed: ${state.requestedHeadSha ?? 'none'} / ${state.reviewedHeadSha ?? 'none'}`,
    `Verification escalation: ${state.verificationEscalation
      ? `${state.verificationEscalation.reason} at PR ${state.verificationEscalation.observedPrHeadSha}`
      : 'none'}`,
    `Human-final authorization: ${state.humanFinalReviewAuthorization
      ? `${state.humanFinalReviewAuthorization.decisionId}; not before ${state.humanFinalReviewAuthorization.notBefore}; verification outcome ${state.humanFinalReviewAuthorization.verificationOutcomeId}`
      : 'none'}`,
    `Integration HEAD: ${state.currentIntegrationHeadSha}`,
    `Targeted validation plan: ${validationPlanRecoverySummary(cwd, state)}`,
    'Tasks:',
    ...(taskLines.length > 0 ? taskLines : ['- none']),
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['- none']),
    `Blocked: ${state.blockedReasons.length > 0 ? state.blockedReasons.map((item) => truncate(item, 200)).join('; ') : 'none'}`,
    `Next action: ${truncate(state.nextAction, 500)}`,
    `Reconciliation warnings: ${warnings.length > 0 ? warnings.join('; ') : 'none'}`,
  ];
  return truncate(lines.join('\n'), maxCharacters);
}

export function archiveState({ cwd = process.cwd(), prNumber, abandonmentReason, onArchiveStep } = {}) {
  const requestedPr = prNumber ?? activePrNumber(cwd);
  if (requestedPr === null || requestedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const selectedPr = parsePrNumber(requestedPr);
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    const reason = typeof abandonmentReason === 'string' ? abandonmentReason.trim() : '';
    if (current.phase !== 'complete' && reason.length === 0) {
      throw new StateError(
        'Only a complete cycle may be archived without an explicit abandonment reason',
        'STATE_ARCHIVE_NOT_ALLOWED',
      );
    }
    if (reason.length > 1000) {
      throw new StateError('Abandonment reason must be at most 1000 characters', 'INVALID_ABANDONMENT_REASON');
    }
    const archivedState = reason.length > 0
      ? { ...current, abandonmentReason: reason, revision: current.revision + 1, updatedAt: utcNow() }
      : current;
    validateStateForWrite(archivedState);
    const suffix = utcNow().replace(/[:.]/gu, '-');
    const target = join(reviewRoot(cwd), 'archive', `pr-${selectedPr}-${suffix}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    mkdirSync(dirname(target), { recursive: true });
    try {
      cpSync(stateDirectory(cwd, selectedPr), temporary, { recursive: true, errorOnExist: true });
      atomicWriteJson(join(temporary, 'state.json'), archivedState);
      if (reason.length > 0) {
        const event = prepareEvent({ type: 'abandoned', summary: `Archived without completion: ${reason}` });
        const handle = openSync(join(temporary, 'events.ndjson'), 'a', 0o600);
        try {
          writeFileSync(handle, `${JSON.stringify(event)}\n`, 'utf8');
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
      }
      renameSync(temporary, target);
      onArchiveStep?.('archive-durable');
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const active = activePrNumber(cwd);
    if (active === selectedPr) unlinkSync(activePointerPath(cwd));
    onArchiveStep?.('pointer-cleared');
    rmSync(stateDirectory(cwd, selectedPr), { recursive: true });
    return target;
  });
}
