import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { gitText, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { inspectReleaseState } from '../../../../../scripts/lib/release-state.mjs';
import {
  completionGate,
  parseTargetedValidationCommand,
  reviewRequestGate,
  reviewRequestUsage,
  taskHasCanonicalThreadCoverage,
  unionInitialValidationSelection,
  unionRequiredValidation,
  validateInitialValidationSelection,
  validateTaskPacket,
  validatePrReviewState,
  validatePrReviewStateV1,
} from '../contracts/contracts.mjs';
import {
  gitCommonDirectory,
  repositoryRoot,
  reviewRoot,
  specialistReviewDirectory,
  taskBindingProvenanceDirectory,
  taskPacketDirectory,
} from '../paths.mjs';
import {
  isSpecialistEvidenceApplicable,
  loadRegistry,
  requiredSpecialistIds,
  routeSpecialists,
  validateSpecialistEvidence,
} from '../../../aerstello-specialists/scripts/validate-registry.mjs';

export { completionGate, reviewRequestGate, reviewRequestUsage } from '../contracts/contracts.mjs';
export { gitCommonDirectory, repositoryRoot, reviewRoot } from '../paths.mjs';

export const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const PR_FINAL_VERIFIER_ID = 'integration_verifier';
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

export function gitAwareGateContext(state, { pushedHeadSha, prHeadSha } = {}) {
  const cwd = state.integrationWorktree;
  const local = gitSnapshot(cwd);
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    prHeadSha,
    isAncestor: (ancestor, descendant) => runGit(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, allowFailure: true },
    ).status === 0,
  };
}

function utcNow() {
  return new Date().toISOString();
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

export function stateDirectory(cwd, prNumber) {
  return join(reviewRoot(cwd), `pr-${parsePrNumber(prNumber)}`);
}

export function statePath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'state.json');
}

export function validationPlanPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'targeted-validation-plan.json');
}

export function taskPacketSidecarPath(cwd, prNumber, taskId) {
  const name = createHash('sha256').update(String(taskId)).digest('hex');
  return join(taskPacketDirectory(cwd, parsePrNumber(prNumber)), `${name}.json`);
}

export function taskBindingProvenancePath(cwd, prNumber, taskId) {
  const name = createHash('sha256').update(String(taskId)).digest('hex');
  return join(taskBindingProvenanceDirectory(cwd, parsePrNumber(prNumber)), `${name}.json`);
}

export function taskBindingProvenanceReceiptPath(cwd, prNumber, taskId) {
  const name = createHash('sha256').update(String(taskId)).digest('hex');
  return join(taskBindingProvenanceDirectory(cwd, parsePrNumber(prNumber)), `${name}.sha256`);
}

export function specialistReviewBundlePath(cwd, prNumber, headSha, revision) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headSha)) {
    throw new StateError('Specialist review HEAD must be a full commit SHA', 'INVALID_SPECIALIST_REVIEW');
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new StateError('Specialist review revision must be a non-negative integer', 'INVALID_SPECIALIST_REVIEW');
  }
  return join(specialistReviewDirectory(cwd, parsePrNumber(prNumber)), `${headSha}-r${revision}.json`);
}

export function specialistPlanReceiptPath(cwd, prNumber, headSha, revision) {
  return specialistReviewBundlePath(cwd, prNumber, headSha, revision).replace(/\.json$/u, '.plan.sha256');
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

function canonicalSerializedJson(value) {
  return serializeJson(canonicalJson(value));
}

export function taskPacketDigest(packet) {
  if (packet?.schemaVersion !== 2) {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  } else if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || typeof packet.taskId !== 'string' || packet.taskId.length === 0) {
    throw new StateError('Invalid historical schema-v2 task packet', 'INVALID_TASK_PACKET');
  }
  return createHash('sha256').update(JSON.stringify(canonicalJson(packet))).digest('hex');
}

function readJsonSidecar(path, label, limit = ACTIVE_STATE_LIMIT_BYTES) {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    return JSON.parse(source);
  } catch (error) {
    throw new StateError(`Unable to read ${label} at ${path}: ${error.message}`, 'INVALID_DURABLE_SIDECAR');
  }
}

function persistImmutableTaskPacketSidecar(cwd, state, packet, digest) {
  const path = taskPacketSidecarPath(cwd, state.prNumber, packet.taskId);
  const serialized = canonicalSerializedJson(packet);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Task packet sidecar exceeds 64 KiB', 'TASK_PACKET_SIDECAR_WRITE_FAILED');
  }
  if (existsSync(path)) {
    let existing;
    try {
      existing = readJsonSidecar(path, 'task packet sidecar');
    } catch (error) {
      throw new StateError(
        `Task ${packet.taskId} already has an invalid durable packet sidecar; explicitly replan the task`,
        'TASK_PACKET_REPLAN_REQUIRED',
      );
    }
    let existingDigest;
    try { existingDigest = taskPacketDigest(existing); } catch { existingDigest = null; }
    if (existing?.schemaVersion !== 3 || existingDigest !== digest
        || canonicalSerializedJson(existing) !== serialized) {
      throw new StateError(
        `Task ${packet.taskId} already has a different or invalid durable packet sidecar; explicitly replan the task`,
        'TASK_PACKET_REPLAN_REQUIRED',
      );
    }
    return path;
  }
  atomicWriteText(path, serialized);
  const persisted = readJsonSidecar(path, 'task packet sidecar');
  if (persisted?.schemaVersion !== 3 || taskPacketDigest(persisted) !== digest
      || canonicalSerializedJson(persisted) !== serialized) {
    throw new StateError(`Durable packet sidecar verification failed for task ${packet.taskId}`, 'TASK_PACKET_SIDECAR_WRITE_FAILED');
  }
  return path;
}

function readBoundTaskPacketSidecar(cwd, state, task, {
  suppliedPacket, verifyBindingProvenance = true,
} = {}) {
  const path = taskPacketSidecarPath(cwd, state.prNumber, task.id);
  if (!existsSync(path)) {
    if (task.status === 'completed' && suppliedPacket?.schemaVersion === 2
        && taskPacketDigest(suppliedPacket) === task.taskPacketDigest) return suppliedPacket;
    throw new StateError(
      `Task ${task.id} is bound without a valid schema-v3 packet sidecar; explicitly replan it`,
      'TASK_PACKET_REPLAN_REQUIRED',
    );
  }
  let packet;
  try {
    packet = readJsonSidecar(path, 'task packet sidecar');
    if (packet?.schemaVersion !== 3) throw new Error('sidecar packet must use schema v3');
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new Error(errors.join('; '));
    if (packet.taskId !== task.id || taskPacketDigest(packet) !== task.taskPacketDigest) {
      throw new Error('task ID or digest does not match active state');
    }
  } catch (error) {
    throw new StateError(
      `Task ${task.id} has a missing or tampered durable packet sidecar; explicitly replan it (${error.message})`,
      'TASK_PACKET_REPLAN_REQUIRED',
    );
  }
  if (verifyBindingProvenance) readBoundTaskBindingProvenance(cwd, state, task, packet);
  return packet;
}

function hasCompletedHistoricalV2TaskProof(cwd, state, task) {
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath) || task.status !== 'completed') return false;
  try {
    const legacy = readJsonSidecar(backupPath, 'schema-v2 migration backup');
    migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
    if (legacy.repository !== state.repository || legacy.prNumber !== state.prNumber
        || resolve(legacy.integrationWorktree) !== resolve(state.integrationWorktree)) return false;
    const legacyTask = legacy.tasks.find((candidate) => candidate.id === task.id);
    return legacyTask?.status === 'completed'
      && legacyTask.taskPacketDigest === task.taskPacketDigest;
  } catch {
    return false;
  }
}

export function loadBoundTaskPackets(cwd, state, { statuses } = {}) {
  return loadBoundTaskPacketEntries(cwd, state, { statuses }).map(({ packet }) => packet);
}

function specialistPlanningErrors(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
  const fields = ['schemaVersion', 'stage', 'headSha', 'tasks'];
  for (const field of fields) if (!Object.hasOwn(input, field)) errors.push(`input.${field} is required`);
  for (const field of Object.keys(input)) if (!fields.includes(field)) errors.push(`input.${field} is not allowed`);
  if (input.schemaVersion !== 1) errors.push('input.schemaVersion must be 1');
  if (!['pre-bind', 'post-integration'].includes(input.stage)) errors.push('input.stage is invalid');
  if (typeof input.headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.headSha)) errors.push('input.headSha is invalid');
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) errors.push('input.tasks must not be empty');
  else for (const [index, entry] of input.tasks.entries()) {
    const prefix = `input.tasks[${index}]`;
    const entryFields = input.stage === 'pre-bind' ? ['taskPacket', 'planningSignals'] : ['taskPacket'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${prefix} must be an object`); continue; }
    for (const field of entryFields) if (!Object.hasOwn(entry, field)) errors.push(`${prefix}.${field} is required`);
    for (const field of Object.keys(entry)) if (!entryFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
    errors.push(...validateTaskPacket(entry.taskPacket).map((error) => `${prefix}.taskPacket: ${error}`));
    if (input.stage === 'pre-bind') {
      const signals = entry.planningSignals;
      if (!signals || typeof signals !== 'object' || Array.isArray(signals)
          || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
          || typeof signals.browserVisible !== 'boolean'
          || typeof signals.testSelectionUncertain !== 'boolean') {
        errors.push(`${prefix}.planningSignals must contain exactly browserVisible and testSelectionUncertain booleans`);
      }
    }
  }
  return errors;
}

function specialistRouteFor(packet, planningSignals = {}) {
  loadRegistry();
  return routeSpecialists({
    specialization: packet.specialization,
    riskTags: packet.riskTags,
    browserVisible: planningSignals.browserVisible === true,
    testSelectionUncertain: planningSignals.testSelectionUncertain === true,
  });
}

function specialistPhaseForStage(stage) {
  return stage === 'post-integration' ? 'review' : 'planning';
}

function normalizedRequiredSpecialistIds(route, { stage }) {
  const ids = requiredSpecialistIds(route, { phase: specialistPhaseForStage(stage) });
  return [...new Set(ids)].sort();
}

function canonicalBundleTaskRoute(task, stage) {
  return specialistRouteFor(stage === 'pre-bind' ? task.taskPacket : task, task.planningSignals);
}

function specialistPlanDigest(bundle) {
  const {
    records: _records,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...immutablePlan
  } = bundle;
  return createHash('sha256').update(canonicalSerializedJson(immutablePlan)).digest('hex');
}

function verifySpecialistPlanReceipt(cwd, state, bundle) {
  const path = specialistPlanReceiptPath(cwd, state.prNumber, bundle.headSha, bundle.stateRevision);
  let recorded;
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    recorded = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StateError(`Unable to read specialist plan receipt at ${path}: ${error.message}`, 'INVALID_SPECIALIST_REVIEW');
  }
  const expected = `${specialistPlanDigest(bundle)}\n`;
  if (recorded !== expected) {
    throw new StateError('Specialist plan receipt does not match immutable bundle planning data', 'INVALID_SPECIALIST_REVIEW');
  }
  return path;
}

function persistSpecialistPlanReceipt(cwd, state, bundle) {
  const path = specialistPlanReceiptPath(cwd, state.prNumber, bundle.headSha, bundle.stateRevision);
  const expected = `${specialistPlanDigest(bundle)}\n`;
  if (existsSync(path)) {
    if (statSync(path).size > 128 || readFileSync(path, 'utf8') !== expected) {
      throw new StateError('A different specialist plan receipt already exists', 'SPECIALIST_PLAN_CONFLICT');
    }
    return path;
  }
  atomicWriteText(path, expected);
  return path;
}

function conciseSpecialistPayloadErrors({ status, summary, findings }, label) {
  const errors = [];
  if (!['clean', 'findings'].includes(status)) errors.push(`${label}.status is invalid`);
  if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 1000) {
    errors.push(`${label}.summary must be a non-empty string of at most 1000 characters`);
  }
  if (!Array.isArray(findings) || findings.length > 20) {
    errors.push(`${label}.findings must be an array with at most 20 entries`);
    return errors;
  }
  if ((status === 'clean' && findings.length !== 0)
      || (status === 'findings' && findings.length === 0)) {
    errors.push(`${label}.findings contradicts its status`);
  }
  if (JSON.stringify(findings).length > 8000) errors.push(`${label}.findings exceeds the concise evidence limit`);
  for (const [index, finding] of findings.entries()) {
    const prefix = `${label}.findings[${index}]`;
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const key of Object.keys(finding)) {
      if (key !== 'summary') errors.push(`${prefix}.${key} is not allowed`);
    }
    if (typeof finding.summary !== 'string' || finding.summary.trim() === '' || finding.summary.length > 1000) {
      errors.push(`${prefix}.summary must be a non-empty string of at most 1000 characters`);
    }
  }
  return errors;
}

function validateSpecialistBundle(bundle, state) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return ['bundle must be an object'];
  const fields = ['schemaVersion', 'stage', 'prNumber', 'headSha', 'stateRevision', 'tasks', 'records', 'createdAt', 'updatedAt'];
  for (const field of fields) if (!Object.hasOwn(bundle, field)) errors.push(`bundle.${field} is required`);
  for (const field of Object.keys(bundle)) if (!fields.includes(field)) errors.push(`bundle.${field} is not allowed`);
  if (bundle.schemaVersion !== 1) errors.push('bundle.schemaVersion must be 1');
  if (!['pre-bind', 'post-integration'].includes(bundle.stage)) errors.push('bundle.stage is invalid');
  if (bundle.prNumber !== state.prNumber) errors.push('bundle.prNumber does not match state');
  if (typeof bundle.headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(bundle.headSha)) {
    errors.push('bundle.headSha is invalid');
  }
  if (bundle.stage === 'post-integration' && bundle.headSha !== state.currentIntegrationHeadSha) {
    errors.push('bundle.headSha is stale for the integrated review stage');
  }
  if (bundle.stage === 'pre-bind' && state.reviewedHeadSha !== null
      && bundle.headSha !== state.reviewedHeadSha) {
    errors.push('bundle.headSha does not match the reviewed commit');
  }
  if (bundle.stateRevision !== state.revision) errors.push('bundle.stateRevision is stale');
  if (!Array.isArray(bundle.tasks) || bundle.tasks.length === 0) errors.push('bundle.tasks must not be empty');
  else {
    if (bundle.stage === 'pre-bind' && bundle.tasks.length !== 1) {
      errors.push('pre-bind bundles must contain exactly one task');
    }
    const ids = [];
    for (const [index, task] of bundle.tasks.entries()) {
      const prefix = `bundle.tasks[${index}]`;
      const taskFields = ['taskId', 'packetDigest', 'specialization', 'riskTags', 'planningSignals', 'route'];
      if (bundle.stage === 'pre-bind') taskFields.push('reviewedHeadSha', 'taskPacket');
      else taskFields.push('bindingProvenanceDigest');
      if (!task || typeof task !== 'object' || Array.isArray(task)) { errors.push(`${prefix} must be an object`); continue; }
      for (const field of taskFields) if (!Object.hasOwn(task, field)) errors.push(`${prefix}.${field} is required`);
      for (const field of Object.keys(task)) if (!taskFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
      if (typeof task.taskId !== 'string' || task.taskId.length === 0) errors.push(`${prefix}.taskId is invalid`);
      else ids.push(task.taskId);
      if (!/^[0-9a-f]{64}$/u.test(task.packetDigest ?? '')) errors.push(`${prefix}.packetDigest is invalid`);
      if (bundle.stage === 'post-integration'
          && !/^[0-9a-f]{64}$/u.test(task.bindingProvenanceDigest ?? '')) {
        errors.push(`${prefix}.bindingProvenanceDigest is invalid`);
      }
      if (typeof task.specialization !== 'string' || !Array.isArray(task.riskTags)) errors.push(`${prefix} specialization metadata is invalid`);
      if (bundle.stage === 'pre-bind') {
        const packetErrors = validateTaskPacket(task.taskPacket);
        errors.push(...packetErrors.map((error) => `${prefix}.taskPacket: ${error}`));
        if (packetErrors.length === 0) {
          if (task.taskPacket.taskId !== task.taskId
              || taskPacketDigest(task.taskPacket) !== task.packetDigest
              || task.taskPacket.reviewedHeadSha !== task.reviewedHeadSha
              || task.taskPacket.specialization !== task.specialization
              || canonicalSerializedJson(task.taskPacket.riskTags) !== canonicalSerializedJson(task.riskTags)) {
            errors.push(`${prefix}.taskPacket does not match its immutable planning metadata`);
          }
        }
        if (task.reviewedHeadSha !== bundle.headSha) {
          errors.push(`${prefix}.reviewedHeadSha must match the bundle reviewed commit`);
        }
      }
      const signals = task.planningSignals;
      if (!signals || typeof signals !== 'object' || Array.isArray(signals)
          || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
          || typeof signals.browserVisible !== 'boolean' || typeof signals.testSelectionUncertain !== 'boolean') {
        errors.push(`${prefix}.planningSignals is invalid`);
      }
      try {
        const canonicalRoute = canonicalBundleTaskRoute(task, bundle.stage);
        if (canonicalSerializedJson(task.route) !== canonicalSerializedJson(canonicalRoute)) {
          errors.push(`${prefix}.route does not match canonical specialist routing`);
        }
      } catch (error) {
        errors.push(`${prefix}.route cannot be recomputed: ${error.message}`);
      }
    }
    if (new Set(ids).size !== ids.length) errors.push('bundle task IDs must be unique');
  }
  if (!Array.isArray(bundle.records)) errors.push('bundle.records must be an array');
  else {
    const reviewers = [];
    const required = new Set(bundle.tasks?.flatMap((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })) ?? []);
    for (const record of bundle.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        errors.push('bundle record must be an object');
        continue;
      }
      const recordFields = [
        'schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'status',
        'summary', 'findings', 'recordedAt',
      ];
      for (const key of Object.keys(record)) {
        if (!recordFields.includes(key)) errors.push(`bundle record ${record.reviewerId ?? 'unknown'}.${key} is not allowed`);
      }
      if (typeof record?.reviewerId === 'string') reviewers.push(record.reviewerId);
      if (!required.has(record?.reviewerId)) errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} is not routed`);
      if (!isSpecialistEvidenceApplicable({
        evidence: record,
        subjectSha: bundle.headSha,
        phase: specialistPhaseForStage(bundle.stage),
      })) {
        errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} is stale`);
      }
      if (record?.schemaVersion !== 1 || record?.planRevision !== bundle.stateRevision) {
        errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} does not match the exact plan revision`);
      }
      errors.push(...conciseSpecialistPayloadErrors({
        status: record.status, summary: record.summary, findings: record.findings,
      }, `bundle record ${record.reviewerId ?? 'unknown'}`));
      if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
        errors.push(`bundle record ${record.reviewerId ?? 'unknown'}.recordedAt is invalid`);
      }
    }
    if (new Set(reviewers).size !== reviewers.length) errors.push('bundle reviewer records must be unique');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof bundle[field] !== 'string' || !Number.isFinite(Date.parse(bundle[field]))) errors.push(`bundle.${field} is invalid`);
  }
  return errors;
}

function readSpecialistBundle(cwd, state, { headSha = state.currentIntegrationHeadSha } = {}) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, headSha, state.revision);
  if (!existsSync(path)) throw new StateError(`No exact-HEAD specialist bundle at ${path}`, 'SPECIALIST_EVIDENCE_MISSING');
  const bundle = readJsonSidecar(path, 'specialist review bundle');
  if (bundle?.headSha !== headSha) {
    throw new StateError('Specialist bundle content does not match its exact-HEAD path', 'INVALID_SPECIALIST_REVIEW');
  }
  const errors = validateSpecialistBundle(bundle, state);
  if (errors.length > 0) throw new StateError(`Invalid specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
  verifySpecialistPlanReceipt(cwd, state, bundle);
  return bundle;
}

function writeNewSpecialistBundle(cwd, state, bundle) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, bundle.headSha, state.revision);
  const serialized = canonicalSerializedJson(bundle);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Specialist review bundle exceeds 64 KiB', 'INVALID_SPECIALIST_REVIEW');
  }
  if (existsSync(path)) {
    const existing = readJsonSidecar(path, 'specialist review bundle');
    const errors = validateSpecialistBundle(existing, state);
    if (errors.length > 0) {
      throw new StateError(`Invalid existing specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    }
    if (specialistPlanDigest(existing) !== specialistPlanDigest(bundle)) {
      throw new StateError('An exact-HEAD/revision specialist plan already exists', 'SPECIALIST_PLAN_CONFLICT');
    }
    verifySpecialistPlanReceipt(cwd, state, existing);
    return existing;
  }
  persistSpecialistPlanReceipt(cwd, state, bundle);
  atomicWriteText(path, serialized);
  return bundle;
}

function taskBindingProvenanceDigest(provenance) {
  return createHash('sha256').update(canonicalSerializedJson(provenance)).digest('hex');
}

function verifyTaskBindingProvenanceReceipt(cwd, state, task, provenance) {
  const path = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
  let recorded;
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    recorded = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StateError(
      `Unable to read task ${task.id} binding provenance receipt at ${path}: ${error.message}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  const expected = `${taskBindingProvenanceDigest(provenance)}\n`;
  if (recorded !== expected) {
    throw new StateError(
      `Task ${task.id} binding provenance receipt does not match its complete immutable evidence`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  return path;
}

function persistTaskBindingProvenanceReceipt(cwd, state, task, provenance) {
  const path = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
  const expected = `${taskBindingProvenanceDigest(provenance)}\n`;
  if (existsSync(path)) {
    try {
      if (statSync(path).size > 128 || readFileSync(path, 'utf8') !== expected) {
        throw new Error('receipt differs from the complete binding provenance');
      }
    } catch (error) {
      throw new StateError(
        `Task ${task.id} already has invalid immutable binding provenance receipt: ${error.message}`,
        'INVALID_TASK_BINDING_PROVENANCE',
      );
    }
    return path;
  }
  atomicWriteText(path, expected);
  return path;
}

function validateTaskBindingProvenance(provenance, state, task, packet) {
  const errors = [];
  const fields = [
    'schemaVersion', 'phase', 'prNumber', 'taskId', 'packetDigest', 'reviewedHeadSha',
    'planRevision', 'planReceiptDigest', 'planningSignals', 'route', 'behaviorMapperResult',
  ];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance must be an object'];
  }
  for (const field of fields) if (!Object.hasOwn(provenance, field)) errors.push(`provenance.${field} is required`);
  for (const field of Object.keys(provenance)) if (!fields.includes(field)) errors.push(`provenance.${field} is not allowed`);
  if (provenance.schemaVersion !== 1) errors.push('provenance.schemaVersion must be 1');
  if (provenance.phase !== 'pre-bind') errors.push('provenance.phase must be pre-bind');
  if (provenance.prNumber !== state.prNumber) errors.push('provenance.prNumber does not match state');
  if (provenance.taskId !== task.id || provenance.taskId !== packet.taskId) {
    errors.push('provenance.taskId does not match the durable task and packet');
  }
  const packetDigest = taskPacketDigest(packet);
  if (provenance.packetDigest !== packetDigest) errors.push('provenance.packetDigest does not match the packet');
  if (typeof task.taskPacketDigest === 'string' && task.taskPacketDigest !== provenance.packetDigest) {
    errors.push('provenance.packetDigest does not match active state');
  }
  if (provenance.reviewedHeadSha !== packet.reviewedHeadSha) {
    errors.push('provenance.reviewedHeadSha does not match the packet');
  }
  if (!Number.isInteger(provenance.planRevision) || provenance.planRevision < 0
      || provenance.planRevision > state.revision) {
    errors.push('provenance.planRevision is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(provenance.planReceiptDigest ?? '')) {
    errors.push('provenance.planReceiptDigest is invalid');
  }
  const signals = provenance.planningSignals;
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)
      || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
      || typeof signals.browserVisible !== 'boolean'
      || typeof signals.testSelectionUncertain !== 'boolean') {
    errors.push('provenance.planningSignals must contain exactly browserVisible and testSelectionUncertain booleans');
  }
  let canonicalRoute;
  try {
    canonicalRoute = specialistRouteFor(packet, signals);
    if (canonicalSerializedJson(provenance.route) !== canonicalSerializedJson(canonicalRoute)) {
      errors.push('provenance.route does not match canonical specialist routing');
    }
  } catch (error) {
    errors.push(`provenance.route cannot be recomputed: ${error.message}`);
  }
  let requiredPlanning = [];
  try {
    requiredPlanning = normalizedRequiredSpecialistIds(canonicalRoute ?? provenance.route, { stage: 'pre-bind' });
  } catch (error) {
    errors.push(`provenance planning reviewers are invalid: ${error.message}`);
  }
  if (requiredPlanning.some((reviewerId) => reviewerId !== 'behavior_mapper')) {
    errors.push('provenance contains an unsupported planning reviewer route');
  }
  const mapperRequired = requiredPlanning.includes('behavior_mapper');
  const mapperResult = provenance.behaviorMapperResult;
  if (!mapperRequired && mapperResult !== null) {
    errors.push('provenance.behaviorMapperResult is present when behavior mapping was not routed');
  } else if (mapperRequired) {
    if (!mapperResult || typeof mapperResult !== 'object' || Array.isArray(mapperResult)) {
      errors.push('provenance.behaviorMapperResult is required');
    } else {
      const mapperFields = ['phase', 'evidence'];
      for (const field of mapperFields) if (!Object.hasOwn(mapperResult, field)) errors.push(`provenance.behaviorMapperResult.${field} is required`);
      for (const field of Object.keys(mapperResult)) if (!mapperFields.includes(field)) errors.push(`provenance.behaviorMapperResult.${field} is not allowed`);
      if (mapperResult.phase !== 'planning') errors.push('provenance.behaviorMapperResult.phase must be planning');
      const evidence = mapperResult.evidence;
      const evidenceFields = [
        'schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'status',
        'summary', 'findings', 'recordedAt',
      ];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        errors.push('provenance.behaviorMapperResult.evidence must be an object');
      } else {
        for (const field of evidenceFields) if (!Object.hasOwn(evidence, field)) errors.push(`provenance.behaviorMapperResult.evidence.${field} is required`);
        for (const field of Object.keys(evidence)) if (!evidenceFields.includes(field)) errors.push(`provenance.behaviorMapperResult.evidence.${field} is not allowed`);
        if (evidence.schemaVersion !== 1 || evidence.planRevision !== provenance.planRevision
            || evidence.reviewerId !== 'behavior_mapper' || evidence.status !== 'clean') {
          errors.push('provenance behavior mapper evidence does not match its clean exact plan');
        }
        if (!isSpecialistEvidenceApplicable({
          evidence, subjectSha: provenance.reviewedHeadSha, phase: 'planning',
        })) {
          errors.push('provenance behavior mapper evidence is stale for the reviewed HEAD');
        }
        errors.push(...conciseSpecialistPayloadErrors({
          status: evidence.status, summary: evidence.summary, findings: evidence.findings,
        }, 'provenance behavior mapper evidence'));
        if (typeof evidence.recordedAt !== 'string' || !Number.isFinite(Date.parse(evidence.recordedAt))) {
          errors.push('provenance behavior mapper evidence.recordedAt is invalid');
        }
      }
    }
  }
  return errors;
}

function buildTaskBindingProvenance(state, packet, planning) {
  const mapper = planning.bundle.records.find((record) => record.reviewerId === 'behavior_mapper') ?? null;
  return canonicalJson({
    schemaVersion: 1,
    phase: 'pre-bind',
    prNumber: state.prNumber,
    taskId: packet.taskId,
    packetDigest: taskPacketDigest(packet),
    reviewedHeadSha: packet.reviewedHeadSha,
    planRevision: planning.bundle.stateRevision,
    planReceiptDigest: specialistPlanDigest(planning.bundle),
    planningSignals: planning.planned.planningSignals,
    route: planning.planned.route,
    behaviorMapperResult: mapper === null ? null : { phase: 'planning', evidence: mapper },
  });
}

function assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance) {
  const historicalState = {
    ...state,
    revision: provenance.planRevision,
    reviewedHeadSha: provenance.reviewedHeadSha,
  };
  let planning;
  try {
    const bundle = readSpecialistBundle(cwd, historicalState, { headSha: provenance.reviewedHeadSha });
    planning = assertBehaviorMapperBundleComplete(bundle, packet);
  } catch (error) {
    throw new StateError(
      `Task ${task.id} binding provenance source is invalid: ${error.message}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  if (specialistPlanDigest(planning.bundle) !== provenance.planReceiptDigest) {
    throw new StateError(
      `Task ${task.id} binding provenance does not match its specialist plan receipt`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  const expected = buildTaskBindingProvenance(state, packet, planning);
  if (canonicalSerializedJson(expected) !== canonicalSerializedJson(provenance)) {
    throw new StateError(
      `Task ${task.id} binding provenance differs from its receipt-verified historical pre-bind plan`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  return planning;
}

function persistImmutableTaskBindingProvenance(cwd, state, task, packet, provenance) {
  const path = taskBindingProvenancePath(cwd, state.prNumber, task.id);
  const errors = validateTaskBindingProvenance(provenance, state, task, packet);
  if (errors.length > 0) {
    throw new StateError(`Invalid task binding provenance:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_BINDING_PROVENANCE');
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance);
  const serialized = canonicalSerializedJson(provenance);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Task binding provenance exceeds 64 KiB', 'INVALID_TASK_BINDING_PROVENANCE');
  }
  if (existsSync(path)) {
    let existing;
    try { existing = readJsonSidecar(path, 'task binding provenance'); } catch (error) {
      throw new StateError(`Task ${task.id} has invalid immutable binding provenance: ${error.message}`, 'INVALID_TASK_BINDING_PROVENANCE');
    }
    const existingErrors = validateTaskBindingProvenance(existing, state, task, packet);
    if (existingErrors.length > 0 || canonicalSerializedJson(existing) !== serialized) {
      throw new StateError(
        `Task ${task.id} already has different or invalid immutable binding provenance`,
        'INVALID_TASK_BINDING_PROVENANCE',
      );
    }
    assertTaskBindingProvenanceSource(cwd, state, task, packet, existing);
    verifyTaskBindingProvenanceReceipt(cwd, state, task, existing);
    return existing;
  }
  persistTaskBindingProvenanceReceipt(cwd, state, task, provenance);
  atomicWriteText(path, serialized);
  const persisted = readJsonSidecar(path, 'task binding provenance');
  const persistedErrors = validateTaskBindingProvenance(persisted, state, task, packet);
  if (persistedErrors.length > 0 || canonicalSerializedJson(persisted) !== serialized) {
    throw new StateError(`Binding provenance verification failed for task ${task.id}`, 'TASK_BINDING_PROVENANCE_WRITE_FAILED');
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, persisted);
  verifyTaskBindingProvenanceReceipt(cwd, state, task, persisted);
  return persisted;
}

function readBoundTaskBindingProvenance(cwd, state, task, packet) {
  const path = taskBindingProvenancePath(cwd, state.prNumber, task.id);
  if (!existsSync(path)) {
    throw new StateError(
      `Task ${task.id} is bound without immutable pre-bind planning provenance`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  let provenance;
  try { provenance = readJsonSidecar(path, 'task binding provenance'); } catch (error) {
    throw new StateError(`Task ${task.id} has invalid immutable binding provenance: ${error.message}`, 'INVALID_TASK_BINDING_PROVENANCE');
  }
  const errors = validateTaskBindingProvenance(provenance, state, task, packet);
  if (errors.length > 0) {
    throw new StateError(
      `Task ${task.id} has invalid immutable binding provenance:\n- ${errors.join('\n- ')}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance);
  verifyTaskBindingProvenanceReceipt(cwd, state, task, provenance);
  return provenance;
}

function loadBoundTaskPacketEntries(cwd, state, { statuses } = {}) {
  const selected = state.tasks.filter((task) => task.disposition === 'actionable'
    && typeof task.taskPacketDigest === 'string'
    && (!statuses || statuses.includes(task.status)));
  return selected.map((task) => {
    const packet = readBoundTaskPacketSidecar(cwd, state, task, { verifyBindingProvenance: false });
    return { task, packet, provenance: readBoundTaskBindingProvenance(cwd, state, task, packet) };
  });
}

function assertPostIntegrationBundleCoverage(cwd, state, bundle) {
  if (bundle.stage !== 'post-integration') return null;
  const entries = loadBoundTaskPacketEntries(cwd, state, { statuses: ['integrated'] })
    .sort((a, b) => a.packet.taskId.localeCompare(b.packet.taskId));
  const expectedTasks = entries.map(({ packet, provenance }) => ({
    taskId: packet.taskId,
    packetDigest: taskPacketDigest(packet),
    specialization: packet.specialization,
    riskTags: packet.riskTags,
    bindingProvenanceDigest: taskBindingProvenanceDigest(provenance),
    planningSignals: provenance.planningSignals,
    route: specialistRouteFor(packet, provenance.planningSignals),
  }));
  const actualTasks = [...bundle.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (canonicalSerializedJson(actualTasks) !== canonicalSerializedJson(expectedTasks)) {
    throw new StateError(
      'Specialist bundle does not cover current Integrated packet sidecars',
      'SPECIALIST_PLAN_TASK_MISMATCH',
    );
  }
  return { entries, packets: entries.map(({ packet }) => packet), expectedTasks };
}

export function planSpecialists({ cwd = process.cwd(), prNumber, input, expectedRevision, now = utcNow } = {}) {
  const errors = specialistPlanningErrors(input);
  if (errors.length > 0) throw new StateError(`Invalid specialist planning input:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_PLAN');
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const state = loadState(cwd, selectedPr);
    if (expectedRevision !== state.revision) throw new StateError(`State revision changed: expected ${expectedRevision}, found ${state.revision}`, 'STATE_REVISION_CONFLICT');
    if (input.stage === 'pre-bind' && input.tasks.length !== 1) {
      throw new StateError('Pre-bind specialist planning accepts exactly one task per guarded revision', 'INVALID_SPECIALIST_PLAN');
    }
    const expectedHeadSha = input.stage === 'pre-bind'
      ? input.tasks[0].taskPacket.reviewedHeadSha
      : state.currentIntegrationHeadSha;
    if (input.headSha !== expectedHeadSha) {
      throw new StateError(
        `Specialist plan must bind to the exact ${input.stage === 'pre-bind' ? 'reviewed' : 'integrated'} HEAD`,
        'SPECIALIST_PLAN_STALE',
      );
    }
    let packets;
    let boundEntries = null;
    if (input.stage === 'pre-bind') {
      packets = input.tasks.map((entry) => entry.taskPacket);
      for (const packet of packets) {
        const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
        if (!task || task.disposition !== 'actionable' || task.taskPacketDigest) {
          throw new StateError(`Task ${packet.taskId} is not an unbound actionable task`, 'SPECIALIST_PLAN_TASK_MISMATCH');
        }
        assertTaskPacketHead(state, task, packet, taskPacketDigest(packet));
      }
    } else {
      assertCleanExactIntegrationHead(state);
      if (state.validationStatus.status !== 'passed' || state.validationStatus.headSha !== state.currentIntegrationHeadSha) {
        throw new StateError('Post-integration specialist planning requires passed exact-HEAD targeted validation', 'SPECIALIST_VALIDATION_REQUIRED');
      }
      boundEntries = loadBoundTaskPacketEntries(cwd, state, { statuses: ['integrated'] })
        .sort((a, b) => a.packet.taskId.localeCompare(b.packet.taskId));
      packets = boundEntries.map(({ packet }) => packet);
      const supplied = [...input.tasks].map((entry) => entry.taskPacket).sort((a, b) => a.taskId.localeCompare(b.taskId));
      if (canonicalSerializedJson(supplied) !== canonicalSerializedJson(packets)) {
        throw new StateError('Post-integration planning input must exactly cover durable Integrated packet sidecars', 'SPECIALIST_PLAN_TASK_MISMATCH');
      }
    }
    const timestamp = now();
    const tasks = packets.map((packet, index) => {
      const planningSignals = input.stage === 'pre-bind'
        ? input.tasks[index].planningSignals
        : boundEntries[index].provenance.planningSignals;
      return {
        taskId: packet.taskId,
        packetDigest: taskPacketDigest(packet),
        specialization: packet.specialization,
        riskTags: packet.riskTags,
        route: specialistRouteFor(packet, planningSignals),
        ...(input.stage === 'pre-bind' ? {
          reviewedHeadSha: packet.reviewedHeadSha,
          planningSignals,
          taskPacket: canonicalJson(packet),
        } : {
          bindingProvenanceDigest: taskBindingProvenanceDigest(boundEntries[index].provenance),
          planningSignals,
        }),
      };
    });
    const bundle = {
      schemaVersion: 1, stage: input.stage, prNumber: state.prNumber,
      headSha: input.headSha, stateRevision: state.revision,
      tasks, records: [], createdAt: timestamp, updatedAt: timestamp,
    };
    const bundleErrors = validateSpecialistBundle(bundle, state);
    if (bundleErrors.length > 0) throw new StateError(`Invalid specialist plan:\n- ${bundleErrors.join('\n- ')}`, 'INVALID_SPECIALIST_PLAN');
    return writeNewSpecialistBundle(cwd, state, bundle);
  });
}

function assertConciseSpecialistRecord(input) {
  const fields = ['schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'outcome', 'summary', 'findings'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StateError('Specialist record input must be an object', 'INVALID_SPECIALIST_REVIEW');
  for (const field of fields) if (!Object.hasOwn(input, field)) throw new StateError(`Specialist record input.${field} is required`, 'INVALID_SPECIALIST_REVIEW');
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw new StateError(`Specialist record input.${field} is not allowed`, 'INVALID_SPECIALIST_REVIEW');
  const payloadErrors = conciseSpecialistPayloadErrors({
    status: input.outcome, summary: input.summary, findings: input.findings,
  }, 'specialist record input');
  if (input.schemaVersion !== 1 || payloadErrors.length > 0) {
    throw new StateError(
      `Specialist record must contain one concise clean statement or concise findings${payloadErrors.length > 0 ? `:\n- ${payloadErrors.join('\n- ')}` : ''}`,
      'INVALID_SPECIALIST_REVIEW',
    );
  }
}

export function recordSpecialistReview({ cwd = process.cwd(), prNumber, input, expectedRevision, now = utcNow } = {}) {
  assertConciseSpecialistRecord(input);
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const state = loadState(cwd, selectedPr);
    if (expectedRevision !== state.revision || input.planRevision !== state.revision) {
      throw new StateError(`Specialist evidence revision must equal current revision ${state.revision}`, 'STATE_REVISION_CONFLICT');
    }
    const bundle = readSpecialistBundle(cwd, state, { headSha: input.headSha });
    if (bundle.stage === 'post-integration') {
      const checkoutError = currentSpecialistCheckoutError(state);
      if (checkoutError !== null) {
        throw new StateError(`Specialist evidence is stale: ${checkoutError}`, 'SPECIALIST_PLAN_STALE');
      }
      assertPostIntegrationBundleCoverage(cwd, state, bundle);
    }
    const required = new Set(bundle.tasks.flatMap((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })));
    if (!required.has(input.reviewerId)) throw new StateError(`Reviewer ${input.reviewerId} is not routed by this plan`, 'SPECIALIST_REVIEWER_MISMATCH');
    const evidence = {
      schemaVersion: 1, planRevision: input.planRevision, headSha: input.headSha,
      reviewerId: input.reviewerId, status: input.outcome, summary: input.summary,
      findings: input.findings, recordedAt: now(),
    };
    const phase = specialistPhaseForStage(bundle.stage);
    const route = bundle.tasks.find((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage }).includes(input.reviewerId)).route;
    const routeField = phase === 'planning' ? 'planningHelpers' : 'riskReviewers';
    const oneSpecialistRoute = {
      ...route,
      [routeField]: route[routeField].filter((specialist) => specialist.id === input.reviewerId),
    };
    const evidenceErrors = validateSpecialistEvidence({
      evidence: [evidence], route: oneSpecialistRoute, subjectSha: bundle.headSha, phase,
    });
    if (evidenceErrors.length > 0) {
      throw new StateError(`Invalid specialist reviewer evidence:\n- ${evidenceErrors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    }
    const existing = bundle.records.find((record) => record.reviewerId === input.reviewerId);
    if (existing) {
      const comparableExisting = {
        schemaVersion: existing.schemaVersion, planRevision: existing.planRevision, headSha: existing.headSha,
        reviewerId: existing.reviewerId, outcome: existing.status, summary: existing.summary, findings: existing.findings,
      };
      if (canonicalSerializedJson(comparableExisting) === canonicalSerializedJson(input)) return bundle;
      throw new StateError(`Reviewer ${input.reviewerId} already has different exact-plan evidence`, 'SPECIALIST_EVIDENCE_CONFLICT');
    }
    const updated = { ...bundle, records: [...bundle.records, evidence], updatedAt: evidence.recordedAt };
    const errors = validateSpecialistBundle(updated, state);
    if (errors.length > 0) throw new StateError(`Invalid specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    const serialized = canonicalSerializedJson(updated);
    if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
      throw new StateError('Specialist review bundle exceeds 64 KiB', 'INVALID_SPECIALIST_REVIEW');
    }
    atomicWriteText(specialistReviewBundlePath(cwd, state.prNumber, bundle.headSha, state.revision), serialized);
    return updated;
  });
}

function assertBehaviorMapperBundleComplete(bundle, packet) {
  const planned = bundle.stage === 'pre-bind' && bundle.tasks.length === 1 ? bundle.tasks[0] : null;
  if (!planned || planned.taskId !== packet.taskId || planned.packetDigest !== taskPacketDigest(packet)) {
    throw new StateError(`Task ${packet.taskId} does not match the exact pre-bind specialist plan`, 'SPECIALIST_PLAN_TASK_MISMATCH');
  }
  if (canonicalSerializedJson(planned.taskPacket) !== canonicalSerializedJson(packet)) {
    throw new StateError(`Task ${packet.taskId} differs from its exact pre-bind specialist packet`, 'SPECIALIST_PLAN_TASK_MISMATCH');
  }
  const required = normalizedRequiredSpecialistIds(planned.route, { stage: 'pre-bind' });
  if (required.includes('behavior_mapper')) {
    const mapper = bundle.records.find((record) => record.reviewerId === 'behavior_mapper');
    if (!mapper || mapper.status !== 'clean' || !isSpecialistEvidenceApplicable({
      evidence: mapper, subjectSha: packet.reviewedHeadSha, phase: 'planning',
    })) {
      throw new StateError('Behavior mapper must record a current-plan clean result before packet binding', 'BEHAVIOR_MAPPING_REQUIRED');
    }
    const hasExactRelatedE2E = packet.requiredValidation.system.some((entry) =>
      entry.command.startsWith('npm run test:e2e:related -- ')
      && entry.selectors.length > 0 && entry.projects.length > 0);
    if (!hasExactRelatedE2E) {
      throw new StateError(
        'Behavior-mapped work requires an exact related-E2E selector and browser-project selection before binding',
        'BEHAVIOR_TEST_SELECTION_REQUIRED',
      );
    }
  }
  return { bundle, planned };
}

function assertBehaviorMapperPlanningComplete(cwd, state, packet) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, packet.reviewedHeadSha, state.revision);
  if (!existsSync(path)) throw new StateError(`Task ${packet.taskId} requires a guarded pre-bind specialist plan`, 'SPECIALIST_PLAN_REQUIRED');
  const bundle = readSpecialistBundle(cwd, state, { headSha: packet.reviewedHeadSha });
  return assertBehaviorMapperBundleComplete(bundle, packet);
}

function recoverHistoricalTaskBindingPlanning(cwd, state, packet) {
  const directory = specialistReviewDirectory(cwd, state.prNumber);
  if (!existsSync(directory)) {
    throw new StateError(
      `Task ${packet.taskId} has no durable historical pre-bind specialist plan for provenance recovery`,
      'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED',
    );
  }
  const escapedHead = packet.reviewedHeadSha.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^${escapedHead}-r(\\d+)\\.json$`, 'u');
  const candidates = [];
  for (const name of readdirSync(directory).sort()) {
    const match = name.match(pattern);
    if (!match) continue;
    const revision = Number(match[1]);
    if (!Number.isInteger(revision) || revision > state.revision) continue;
    const historicalState = { ...state, revision, reviewedHeadSha: packet.reviewedHeadSha };
    let planning;
    try {
      const bundle = readSpecialistBundle(cwd, historicalState, { headSha: packet.reviewedHeadSha });
      planning = assertBehaviorMapperBundleComplete(bundle, packet);
    } catch {
      continue;
    }
    candidates.push(planning);
  }
  if (candidates.length !== 1) {
    throw new StateError(
      `Task ${packet.taskId} requires exactly one receipt-verified historical pre-bind plan; found ${candidates.length}`,
      'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED',
    );
  }
  return candidates[0];
}

function currentSpecialistCheckoutError(state) {
  try {
    const actual = gitSnapshot(state.integrationWorktree);
    if (actual.headSha !== state.currentIntegrationHeadSha) return 'integration HEAD changed without a guarded state checkpoint';
    if (actual.dirty) return 'integration checkout has uncommitted changes';
    return null;
  } catch (error) {
    return `integration checkout could not be inspected: ${error.message}`;
  }
}

export function specialistContext({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const checkoutError = currentSpecialistCheckoutError(state);
  if (checkoutError !== null) {
    throw new StateError(`Specialist evidence is stale: ${checkoutError}`, 'SPECIALIST_PLAN_STALE');
  }
  const bundle = readSpecialistBundle(cwd, state);
  if (bundle.stage !== 'post-integration') throw new StateError('Current specialist bundle is not a post-integration review plan', 'SPECIALIST_EVIDENCE_MISSING');
  const { entries, packets, expectedTasks } = assertPostIntegrationBundleCoverage(cwd, state, bundle);
  const required = [...new Set(bundle.tasks.flatMap((task) =>
    normalizedRequiredSpecialistIds(task.route, { stage: 'post-integration' })))].sort();
  const records = new Map(bundle.records.map((record) => [record.reviewerId, record]));
  const missing = required.filter((id) => !records.has(id));
  const stale = required.filter((id) => records.has(id)
    && !isSpecialistEvidenceApplicable({
      evidence: records.get(id), subjectSha: state.currentIntegrationHeadSha, phase: 'review',
    }));
  const findings = required.filter((id) => records.get(id)?.status === 'findings')
    .map((id) => records.get(id));
  const routes = expectedTasks.map(({ taskId, route }) => ({ phase: 'post-integration', taskId, route }));
  const finalVerificationPriority = expectedTasks.some(({ route }) =>
    route.finalVerificationPriority === 'high') ? 'high' : 'standard';
  const specialistResults = required.filter((id) => records.has(id)).map((id) => records.get(id));
  const preBindPlanning = entries.map(({ provenance }) => canonicalJson({
    phase: 'pre-bind',
    taskId: provenance.taskId,
    packetDigest: provenance.packetDigest,
    reviewedHeadSha: provenance.reviewedHeadSha,
    planRevision: provenance.planRevision,
    planReceiptDigest: provenance.planReceiptDigest,
    planningSignals: provenance.planningSignals,
    route: provenance.route,
    behaviorMapperResult: provenance.behaviorMapperResult,
  }));
  return {
    schemaVersion: 1,
    status: missing.length > 0 || stale.length > 0 ? 'incomplete' : findings.length > 0 ? 'findings' : 'clean',
    readyForIntegrationVerifier: missing.length === 0 && stale.length === 0 && findings.length === 0,
    headSha: state.currentIntegrationHeadSha,
    stateRevision: state.revision,
    packets: packets.map((packet) => canonicalJson(packet)),
    preBindPlanning,
    routes,
    finalVerification: {
      verifierId: PR_FINAL_VERIFIER_ID,
      priority: finalVerificationPriority,
    },
    requiredReviewerIds: required,
    missingReviewerIds: missing,
    staleReviewerIds: stale,
    specialistResults,
    findings,
    postIntegrationReview: {
      phase: 'review', headSha: state.currentIntegrationHeadSha, routes,
      requiredReviewerIds: required, specialistResults, findings,
    },
    targetedValidation: state.validationStatus,
  };
}

export function readSpecialistStatus({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) return { status: 'missing', headSha: null, stateRevision: null, bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [] };
  const checkoutError = currentSpecialistCheckoutError(state);
  if (checkoutError !== null) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [], error: 'SPECIALIST_PLAN_STALE',
    };
  }
  try {
    for (const task of state.tasks.filter((candidate) => candidate.disposition === 'actionable'
      && typeof candidate.taskPacketDigest === 'string')) {
      if (!existsSync(taskPacketSidecarPath(cwd, state.prNumber, task.id))
          && !existsSync(taskBindingProvenancePath(cwd, state.prNumber, task.id))
          && !existsSync(taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id))
          && hasCompletedHistoricalV2TaskProof(cwd, state, task)) continue;
      readBoundTaskPacketSidecar(cwd, state, task);
    }
  } catch (error) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [],
      error: error.code ?? 'INVALID_TASK_BINDING_PROVENANCE',
    };
  }
  const candidates = [...new Set([
    state.currentIntegrationHeadSha,
    ...(state.reviewedHeadSha === null ? [] : [state.reviewedHeadSha]),
  ])].map((headSha) => ({
    headSha,
    path: specialistReviewBundlePath(cwd, state.prNumber, headSha, state.revision),
  })).filter(({ path }) => existsSync(path));
  if (candidates.length === 0) {
    const directory = specialistReviewDirectory(cwd, state.prNumber);
    const orphanReceipts = [...new Set([
      state.currentIntegrationHeadSha,
      ...(state.reviewedHeadSha === null ? [] : [state.reviewedHeadSha]),
    ])].map((headSha) => specialistPlanReceiptPath(cwd, state.prNumber, headSha, state.revision))
      .filter((path) => existsSync(path));
    if (orphanReceipts.length > 0) {
      return {
        status: 'pending', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
        bundlePath: null, receiptPath: orphanReceipts[0], requiredReviewerIds: [], recordedReviewerIds: [],
        error: 'SPECIALIST_PLAN_INCOMPLETE',
      };
    }
    const hasHistorical = existsSync(directory) && readdirSync(directory)
      .some((name) => name.endsWith('.json') || name.endsWith('.plan.sha256'));
    return {
      status: hasHistorical ? 'stale' : 'missing', headSha: state.currentIntegrationHeadSha,
      stateRevision: state.revision, bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [],
    };
  }
  if (candidates.length !== 1) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [], error: 'AMBIGUOUS_SPECIALIST_REVIEW',
    };
  }
  const [{ headSha, path }] = candidates;
  try {
    const bundle = readSpecialistBundle(cwd, state, { headSha });
    assertPostIntegrationBundleCoverage(cwd, state, bundle);
    const required = [...new Set(bundle.tasks.flatMap((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })))].sort();
    const recorded = bundle.records.map((record) => record.reviewerId).sort();
    const missing = required.filter((id) => !recorded.includes(id));
    const stale = bundle.records.filter((record) => !isSpecialistEvidenceApplicable({
      evidence: record,
      subjectSha: bundle.headSha,
      phase: specialistPhaseForStage(bundle.stage),
    })).map((record) => record.reviewerId).sort();
    const findings = bundle.records.filter((record) => record.status === 'findings').map((record) => record.reviewerId).sort();
    return {
      status: stale.length > 0 ? 'stale' : missing.length > 0 ? 'pending' : findings.length > 0 ? 'finding' : 'clean',
      headSha: bundle.headSha, stateRevision: state.revision, bundlePath: path,
      stage: bundle.stage, requiredReviewerIds: required, recordedReviewerIds: recorded,
      missingReviewerIds: missing, staleReviewerIds: stale, findingReviewerIds: findings,
    };
  } catch (error) {
    return {
      status: 'stale', headSha, stateRevision: state.revision,
      bundlePath: path, requiredReviewerIds: [], recordedReviewerIds: [], error: error.code ?? 'INVALID_SPECIALIST_REVIEW',
    };
  }
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
  return !reviewRequestUsage(state).exhausted;
}

function isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds) {
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

function assertBoundTaskPacket(state, packet, cwd = state.integrationWorktree) {
  const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
  if (!task || task.disposition !== 'actionable') {
    throw new StateError(`Task packet ${packet.taskId} does not match an actionable durable task`, 'TASK_PACKET_NOT_BOUND');
  }
  const digest = taskPacketDigest(packet);
  if (!task.taskPacketDigest) {
    assertTaskPacketHead(state, task, packet, digest);
    throw new StateError(`Task packet ${packet.taskId} has not been durably bound`, 'TASK_PACKET_NOT_BOUND');
  }
  const durablePacket = readBoundTaskPacketSidecar(cwd, state, task, { suppliedPacket: packet });
  assertTaskPacketHead(state, task, packet, digest);
  if (task.taskPacketDigest !== digest) {
    throw new StateError(`Task packet ${packet.taskId} differs from the accepted packet`, 'TASK_PACKET_CONFLICT');
  }
  if (durablePacket.schemaVersion === 3
      && canonicalSerializedJson(durablePacket) !== canonicalSerializedJson(packet)) {
    throw new StateError(`Task packet ${packet.taskId} differs from its durable sidecar`, 'TASK_PACKET_CONFLICT');
  }
  return task;
}

export function assertTaskPacketBound(state, packet, { cwd = state.integrationWorktree } = {}) {
  if (packet?.schemaVersion !== 2) {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  }
  return assertBoundTaskPacket(state, packet, cwd);
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
      affectedAreas: initialSelection.affectedAreas,
      requiredValidation: initialSelection.requiredValidation,
    }];
    packetIds = [];
  } else {
    const missingBinding = state.tasks.find((task) => task.disposition === 'actionable'
      && task.status === 'integrated' && typeof task.taskPacketDigest !== 'string');
    if (missingBinding) {
      throw new StateError(`Task ${missingBinding.id} has not been durably bound`, 'TASK_PACKET_NOT_BOUND');
    }
    const sortedPackets = loadBoundTaskPackets(cwd, state, { statuses: ['integrated'] })
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
    packetIds = sortedPackets.map((packet) => packet.taskId);
    if (new Set(packetIds).size !== packetIds.length || JSON.stringify(packetIds) !== JSON.stringify(expectedIds)) {
      throw new StateError('Task packets must exactly cover current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
    }
    if (Array.isArray(taskPackets) && taskPackets.length > 0) {
      const supplied = [...taskPackets].sort((left, right) => left.taskId.localeCompare(right.taskId));
      if (JSON.stringify(supplied.map((packet) => packet.taskId)) !== JSON.stringify(expectedIds)) {
        throw new StateError('Task packets must exactly cover current actionable integrated tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
      }
      if (canonicalSerializedJson(supplied) !== canonicalSerializedJson(sortedPackets)) {
        throw new StateError('Supplied packets differ from durable task packet sidecars', 'TASK_PACKET_CONFLICT');
      }
    }
    sortedPackets.forEach((packet) => assertBoundTaskPacket(state, packet, cwd));
    validationInputs = sortedPackets;
  }
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
  reviewRequestLimit = null,
} = {}) {
  const selectedPr = parsePrNumber(prNumber);
  const repo = repository ?? originRepository(cwd);
  if (!repo) throw new StateError('Unable to derive owner/name from origin; pass --repository', 'REPOSITORY_REQUIRED');
  if (!(reviewRequestLimit === null
      || (Number.isSafeInteger(reviewRequestLimit) && reviewRequestLimit > 0))) {
    throw new StateError(
      `Review request limit must be null or a positive safe integer up to ${Number.MAX_SAFE_INTEGER}`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
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
      schemaVersion: 3,
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
      reviewRequestLimit,
      legacyReviewProvenance: null,
      releaseBaseline: releaseState.applicableRelease,
      decisions: [],
      tasks: [],
      reviewRequest: null,
      reviewOutcome: null,
      reviewHistory: [],
      verificationEscalation: null,
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
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 3, prNumber: selectedPr });
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

export function migratePrReviewStateV2(legacyState, { migratedAt = utcNow() } = {}) {
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
        ? 'Reconfirm targeted validation, full GitHub Actions, and the exact review commit after schema v3 migration.'
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
  const errors = validatePrReviewState(validationCandidate);
  if (errors.length > 0) {
    throw new StateError(`Unable to migrate schema v2 state:\n- ${errors.join('\n- ')}`, 'STATE_MIGRATION_FAILED');
  }
  return migrated;
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
    if (legacy.schemaVersion === 3) throw new StateError('State already uses schema v3', 'STATE_ALREADY_MIGRATED');
    const state = legacy.schemaVersion === 1
      ? migratePrReviewStateV1(legacy, {
          integrationMap,
          isAncestor: (ancestor, descendant) => runGit(
            ['merge-base', '--is-ancestor', ancestor, descendant],
            { cwd: legacy.integrationWorktree, allowFailure: true },
          ).status === 0,
        })
      : migratePrReviewStateV2(legacy);
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
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 3, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, {
      type: 'state-migrated',
      summary: `Migrated PR ${selectedPr} state from schema v${legacy.schemaVersion} to v3`,
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

function nextReviewKind(state) {
  return reviewRequestUsage(state).used < 3 ? 'discovery' : 'verification';
}

function reviewLimitNextAction(state) {
  const usage = reviewRequestUsage(state);
  if (usage.exhausted) {
    return `Review request limit ${usage.limit} is exhausted after ${usage.used} durable requests; run npm run review:state -- set-review-limit --pr ${state.prNumber} --expected-revision ${state.revision + 1} --limit <higher-number> or --unlimited before the next request.`;
  }
  return `Request canonical ${nextReviewKind(state)} review.`;
}

function triageNextAction(state) {
  const action = 'Triage the applicable canonical review findings.';
  return reviewRequestUsage(state).exhausted ? `${action} ${reviewLimitNextAction(state)}` : action;
}

function hasOutstandingReviewRequestIntent(cwd, state) {
  const path = join(stateDirectory(cwd, state.prNumber), 'events.ndjson');
  if (!existsSync(path)) return false;
  let events;
  try {
    events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    throw new StateError(`Unable to inspect GitHub mutation intent evidence: ${error.message}`, 'RECOVERY_EVIDENCE_INVALID');
  }
  const operationId = `request:${state.prNumber}:${nextReviewKind(state)}:${state.reviewHistory.length + 1}:${state.currentIntegrationHeadSha}`;
  return events.some((event) => event.type === 'github-mutation-intent'
    && event.details?.operationId === operationId);
}

export function checkpointReviewRequestLimit({
  cwd = process.cwd(), prNumber, reviewRequestLimit, expectedRevision,
} = {}) {
  if (!(reviewRequestLimit === null
      || (Number.isSafeInteger(reviewRequestLimit) && reviewRequestLimit > 0))) {
    throw new StateError(
      `Review request limit must be null or a positive safe integer up to ${Number.MAX_SAFE_INTEGER}`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    if (expectedRevision !== current.revision) {
      throw new StateError(
        `State revision changed: expected ${expectedRevision}, found ${current.revision}`,
        'STATE_REVISION_CONFLICT',
      );
    }
    const usage = reviewRequestUsage(current);
    if (reviewRequestLimit !== null && reviewRequestLimit < usage.used) {
      throw new StateError(
        `Review request limit ${reviewRequestLimit} is below ${usage.used} durable requests`,
        'INVALID_REVIEW_REQUEST_LIMIT',
      );
    }
    if (hasOutstandingReviewRequestIntent(cwd, current)
        && reviewRequestLimit !== null && reviewRequestLimit <= usage.used) {
      throw new StateError(
        'Review request limit cannot exhaust the cycle while an exact next-request mutation intent is recoverable',
        'REVIEW_REQUEST_INTENT_PENDING',
      );
    }
    const latest = current.reviewHistory.at(-1);
    const resumesHistoricalFinding = current.phase === 'awaiting-human-decision'
      && current.verificationEscalation === null
      && current.blockedReasons.length === 0
      && !current.tasks.some((task) => task.disposition === 'needs-human-decision')
      && current.reviewOutcome?.outcome === 'findings'
      && latest?.outcome?.id === current.reviewOutcome.id;
    const configured = { ...current, reviewRequestLimit };
    const nextState = {
      ...configured,
      ...(resumesHistoricalFinding ? {
        phase: 'triaging',
        nextAction: triageNextAction(configured),
      } : current.phase === 'triaging' ? {
          nextAction: triageNextAction(configured),
      } : current.phase === 'ready-for-review' ? {
          nextAction: reviewLimitNextAction(configured),
        } : {}),
    };
    const sameLimit = Object.hasOwn(current, 'reviewRequestLimit')
      && current.reviewRequestLimit === reviewRequestLimit;
    if (sameLimit && sameEvidence(current, nextState)) return current;
    return checkpointStateUnlocked({
      cwd,
      selectedPr,
      nextState,
      expectedRevision,
      event: {
        type: 'review-request-limit',
        summary: reviewRequestLimit === null
          ? 'Removed the explicit review request limit'
          : `Set the review request limit to ${reviewRequestLimit}`,
      },
      eventWriter: appendEvent,
      transitionAuthorization: protectedTransition(nextState, 'review-request-limit'),
    });
  });
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
  if (guardedKind !== 'review-request-limit') {
    assertImmutableValue(
      { present: Object.hasOwn(current, 'reviewRequestLimit'), value: current.reviewRequestLimit ?? null },
      { present: Object.hasOwn(next, 'reviewRequestLimit'), value: next.reviewRequestLimit ?? null },
      'reviewRequestLimit',
    );
  }
  if (guardedKind === null) {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
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
  } else if (guardedKind === 'review-request-limit') {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
      'legacyReviewProvenance', 'tasks', 'decisions', 'validationStatus', 'ciValidationStatus',
      'ciValidationHistory', 'threadResolutionStatus', 'blockedReasons',
    ]) assertImmutableValue(current[field], next[field], field);
  } else if (guardedKind === 'ci-validation') {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
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
    ]) assertImmutableValue(current[field], next[field], field);
    assertImmutableValue(current.ciValidationStatus, next.ciValidationStatus, 'ciValidationStatus');
    assertImmutableValue(current.ciValidationHistory, next.ciValidationHistory, 'ciValidationHistory');
  } else if (guardedKind === 'git-metadata') {
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
    ]) assertImmutableValue(current[field], next[field], field);
  }
  if (!['targeted-validation', 'git-metadata', 'task-packet-replan'].includes(guardedKind)) {
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
      if (guardedKind === 'task-packet-replan' && !updated.taskPacketDigest) {
        // The dedicated migration-only replan helper authorizes this one digest clear.
      } else {
        assertImmutableValue(task.taskPacketDigest, updated.taskPacketDigest, `task ${task.id} taskPacketDigest`);
      }
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
  const phase = outcome.outcome === 'findings' ? 'triaging' : 'validating';
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
      : triageNextAction({ ...state, reviewHistory }),
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
      || request?.kind !== 'verification' || state.verificationReviewUsed !== true
      || state.reviewOutcome !== null || latest?.request?.id !== request.id || latest?.outcome !== null) {
    throw new StateError('No pending canonical verification collection to escalate', 'VERIFICATION_ESCALATION_NOT_EXPECTED');
  }
  if (escalation?.requestId !== request.id || escalation?.requestHeadSha !== request.headSha) {
    throw new StateError('Verification escalation must bind to the pending request and exact SHA', 'INVALID_VERIFICATION_ESCALATION');
  }
  const next = {
    ...state,
    phase: 'awaiting-human-decision',
    verificationEscalation: escalation,
    nextAction: 'Present the canonical verification collection escalation and evidence to a human.',
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

const REPLANNABLE_EXECUTION_STATUSES = new Set(['proposed', 'blocked', 'failed']);
const REPLANNABLE_NEUTRAL_EXECUTION_FIELDS = ['worker', 'branch', 'worktree', 'workerCommitSha'];
const STABLE_TASK_IDENTITY_FIELDS = [
  'id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition',
];

function assertMigrationOriginV2Binding(cwd, state, task) {
  if (task.disposition !== 'actionable' || typeof task.taskPacketDigest !== 'string'
      || task.status === 'completed'
      || (!REPLANNABLE_EXECUTION_STATUSES.has(task.status) && task.status !== 'integrated')) {
    throw new StateError(
      `Task ${task.id} is not an eligible non-completed actionable v2 binding`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  if (REPLANNABLE_EXECUTION_STATUSES.has(task.status)
      && REPLANNABLE_NEUTRAL_EXECUTION_FIELDS.some((field) => task.execution?.[field] !== null)) {
    throw new StateError(
      `Task ${task.id} still has an active assignment or worker commit and cannot be replanned`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  if (existsSync(taskPacketSidecarPath(cwd, state.prNumber, task.id))
      || existsSync(taskBindingProvenancePath(cwd, state.prNumber, task.id))
      || existsSync(taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id))) {
    throw new StateError(
      `Task ${task.id} has schema-v3 sidecar evidence and cannot use legacy replanning`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath)) {
    throw new StateError(
      `Task ${task.id} has no immutable schema-v2 migration backup`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  let legacy;
  try {
    legacy = readStateDocument(backupPath);
    if (legacy.schemaVersion !== 2) throw new Error('backup is not schema v2');
    migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
  } catch (error) {
    throw new StateError(
      `Task ${task.id} schema-v2 migration backup is invalid: ${error.message}`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  if (legacy.repository !== state.repository || legacy.prNumber !== state.prNumber
      || legacy.baseSha !== state.baseSha
      || resolve(legacy.integrationWorktree) !== resolve(state.integrationWorktree)
      || !sameEvidence(legacy.releaseBaseline, state.releaseBaseline)
      || !sameEvidence(legacy.legacyReviewProvenance, state.legacyReviewProvenance)
      || state.revision < legacy.revision + 1) {
    throw new StateError(
      `Task ${task.id} schema-v2 migration backup does not match active state identity`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  const legacyTask = legacy.tasks.find((candidate) => candidate.id === task.id);
  if (!legacyTask || legacyTask.status === 'completed'
      || legacyTask.disposition !== 'actionable'
      || legacyTask.taskPacketDigest !== task.taskPacketDigest
      || STABLE_TASK_IDENTITY_FIELDS.some((field) => !sameEvidence(legacyTask[field], task[field]))) {
    throw new StateError(
      `Task ${task.id} binding is not proven by the immutable schema-v2 migration backup`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  return { backupPath, legacyTask };
}

function neutralReplannedTask(task) {
  const { taskPacketDigest: _taskPacketDigest, execution: _execution, ...withoutBinding } = task;
  if (task.status === 'integrated') return withoutBinding;
  return {
    ...withoutBinding,
    status: 'proposed',
    integratedCommitSha: null,
    resolutionSummary: null,
    execution: {
      dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
      workerCommitSha: null, validationSummaries: [], lastError: null,
    },
  };
}

export function checkpointTaskPacketReplan({
  cwd = process.cwd(), prNumber, taskId, expectedRevision, event,
} = {}) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new StateError('Task replanning requires one opaque nonempty task ID', 'INVALID_TASK_PACKET_REPLAN');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError('Task replanning requires an expected non-negative revision', 'INVALID_TASK_PACKET_REPLAN');
  }
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    if (expectedRevision !== current.revision) {
      throw new StateError(
        `State revision changed: expected ${expectedRevision}, found ${current.revision}`,
        'STATE_REVISION_CONFLICT',
      );
    }
    const task = current.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new StateError(`Task ${taskId} was not found`, 'TASK_PACKET_REPLAN_NOT_ALLOWED');
    assertMigrationOriginV2Binding(cwd, current, task);
    const nextTask = neutralReplannedTask(task);
    const nextState = {
      ...current,
      phase: 'recovering',
      tasks: current.tasks.map((candidate) => candidate.id === taskId ? nextTask : candidate),
      validationStatus: emptyTargetedValidation(),
      nextAction: `Create an explicit schema-v3 specialist plan and bind a new packet for task ${taskId}.`,
    };
    return checkpointStateUnlocked({
      cwd, selectedPr: current.prNumber, nextState, expectedRevision: current.revision,
      event: event ?? {
        type: 'task-packet-replan',
        summary: `Cleared migration-origin schema-v2 packet binding for task ${taskId}`,
      },
      eventWriter: appendEvent,
      transitionAuthorization: protectedTransition(nextState, 'task-packet-replan'),
    });
  });
}

export function checkpointTaskPacketBinding({
  cwd = process.cwd(), prNumber, packet, expectedRevision, event,
} = {}) {
  const errors = validateTaskPacket(packet);
  if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new StateError(`State revision changed: expected ${expectedRevision}, found ${current.revision}`, 'STATE_REVISION_CONFLICT');
    }
    const task = current.tasks.find((candidate) => candidate.id === packet.taskId);
    if (!task || task.disposition !== 'actionable') {
      throw new StateError('Task packet must match an actionable durable task', 'TASK_PACKET_NOT_BOUND');
    }
    const digest = taskPacketDigest(packet);
    if (task.taskPacketDigest) {
      const durablePacket = readBoundTaskPacketSidecar(cwd, current, task, {
        suppliedPacket: packet, verifyBindingProvenance: false,
      });
      assertTaskPacketHead(current, task, packet, digest);
      if (task.taskPacketDigest !== digest) {
        throw new StateError('Task packet differs from the accepted packet', 'TASK_PACKET_CONFLICT');
      }
      const provenancePath = taskBindingProvenancePath(cwd, current.prNumber, task.id);
      if (existsSync(provenancePath)) {
        readBoundTaskBindingProvenance(cwd, current, task, durablePacket);
      } else {
        const planning = recoverHistoricalTaskBindingPlanning(cwd, current, durablePacket);
        const provenance = buildTaskBindingProvenance(current, durablePacket, planning);
        persistImmutableTaskBindingProvenance(cwd, current, task, durablePacket, provenance);
      }
      return current;
    }
    assertTaskPacketHead(current, task, packet, digest);
    if (packet.schemaVersion !== 3) {
      throw new StateError('New task packet bindings require explicit schema v3 instructions', 'TASK_PACKET_V3_REQUIRED');
    }
    const planning = assertBehaviorMapperPlanningComplete(cwd, current, packet);
    const provenance = buildTaskBindingProvenance(current, packet, planning);
    persistImmutableTaskPacketSidecar(cwd, current, packet, digest);
    persistImmutableTaskBindingProvenance(cwd, current, task, packet, provenance);
    const nextState = {
      ...current,
      tasks: current.tasks.map((candidate) => candidate.id === packet.taskId
        ? { ...candidate, taskPacketDigest: digest }
        : candidate),
    };
    return checkpointStateUnlocked({
      cwd, selectedPr: current.prNumber, nextState, expectedRevision: current.revision,
      event: event ?? { type: 'task-packet-bound', summary: `Bound accepted packet for task ${packet.taskId}` },
      eventWriter: appendEvent,
      transitionAuthorization: protectedTransition(nextState, 'task-packet-binding'),
    });
  });
}

export function checkpointReviewRequest({
  cwd = process.cwd(), prNumber, request, pushedHeadSha, prHeadSha, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildReviewRequestTransition(
    current,
    request,
    gitAwareGateContext(current, { pushedHeadSha, prHeadSha }),
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
  const packetSidecars = [];
  const bindingProvenance = [];
  const evidenceErrors = [];
  const seenPacketPaths = new Set();
  const seenProvenancePaths = new Set();
  const seenProvenanceReceiptPaths = new Set();
  for (const task of state.tasks.filter((candidate) => typeof candidate.taskPacketDigest === 'string')) {
    const path = taskPacketSidecarPath(cwd, state.prNumber, task.id);
    const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, task.id);
    const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
    seenPacketPaths.add(path);
    seenProvenancePaths.add(provenancePath);
    seenProvenanceReceiptPaths.add(provenanceReceiptPath);
    if (!existsSync(path) && !existsSync(provenancePath) && !existsSync(provenanceReceiptPath)
        && hasCompletedHistoricalV2TaskProof(cwd, state, task)) {
      packetSidecars.push({ taskId: task.id, status: 'historical-v2', path: null });
      bindingProvenance.push({ taskId: task.id, status: 'historical-v2', path: null, receiptPath: null });
      continue;
    }
    let packet;
    try {
      packet = readBoundTaskPacketSidecar(cwd, state, task, { verifyBindingProvenance: false });
      packetSidecars.push({ taskId: task.id, status: 'valid', path });
    } catch (error) {
      packetSidecars.push({ taskId: task.id, status: 'invalid', path: existsSync(path) ? path : null, error: error.code });
      evidenceErrors.push(`Task ${task.id} packet sidecar: ${error.message}`);
    }
    if (packet) {
      try {
        readBoundTaskBindingProvenance(cwd, state, task, packet);
        bindingProvenance.push({
          taskId: task.id, status: 'valid', path: provenancePath,
          receiptPath: provenanceReceiptPath,
        });
      } catch (error) {
        bindingProvenance.push({
          taskId: task.id, status: 'invalid', path: existsSync(provenancePath) ? provenancePath : null,
          receiptPath: existsSync(provenanceReceiptPath) ? provenanceReceiptPath : null,
          error: error.code,
        });
        evidenceErrors.push(`Task ${task.id} binding provenance: ${error.message}`);
      }
    } else {
      bindingProvenance.push({
        taskId: task.id, status: 'unverifiable', path: existsSync(provenancePath) ? provenancePath : null,
        receiptPath: existsSync(provenanceReceiptPath) ? provenanceReceiptPath : null,
      });
    }
  }
  const packetDirectory = taskPacketDirectory(cwd, state.prNumber);
  if (existsSync(packetDirectory)) {
    for (const name of readdirSync(packetDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(packetDirectory, name);
      if (seenPacketPaths.has(path)) continue;
      try {
        const packet = readJsonSidecar(path, 'unbound task packet sidecar');
        const packetErrors = validateTaskPacket(packet);
        if (packetErrors.length > 0 || taskPacketSidecarPath(cwd, state.prNumber, packet.taskId) !== path) {
          throw new Error(packetErrors.join('; ') || 'sidecar filename does not match its hashed task ID');
        }
        const pendingTask = state.tasks.find((task) => task.id === packet.taskId && !task.taskPacketDigest);
        const status = pendingTask ? 'pending-binding' : 'orphan';
        packetSidecars.push({ taskId: packet.taskId, status, path });
        evidenceErrors.push(`Task ${packet.taskId} packet sidecar is ${status}`);
      } catch (error) {
        packetSidecars.push({ taskId: null, status: 'invalid', path, error: 'INVALID_DURABLE_SIDECAR' });
        evidenceErrors.push(`Unbound packet sidecar ${name} is invalid: ${error.message}`);
      }
    }
  }
  const provenanceDirectory = taskBindingProvenanceDirectory(cwd, state.prNumber);
  if (existsSync(provenanceDirectory)) {
    for (const name of readdirSync(provenanceDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(provenanceDirectory, name);
      if (seenProvenancePaths.has(path)) continue;
      try {
        const provenance = readJsonSidecar(path, 'unbound task binding provenance');
        if (typeof provenance?.taskId !== 'string'
            || taskBindingProvenancePath(cwd, state.prNumber, provenance.taskId) !== path) {
          throw new Error('provenance filename does not match its hashed task ID');
        }
        const receiptPath = taskBindingProvenanceReceiptPath(
          cwd, state.prNumber, provenance.taskId,
        );
        seenProvenanceReceiptPaths.add(receiptPath);
        const pendingTask = state.tasks.find((task) => task.id === provenance.taskId && !task.taskPacketDigest);
        const packetPath = taskPacketSidecarPath(cwd, state.prNumber, provenance.taskId);
        if (!pendingTask || !existsSync(packetPath)) {
          bindingProvenance.push({
            taskId: provenance.taskId, status: 'orphan', path,
            receiptPath: existsSync(receiptPath) ? receiptPath : null,
          });
          evidenceErrors.push(`Task ${provenance.taskId} binding provenance is orphaned`);
          continue;
        }
        const packet = readJsonSidecar(packetPath, 'pending task packet sidecar');
        const errors = validateTaskBindingProvenance(provenance, state, pendingTask, packet);
        if (errors.length > 0) throw new Error(errors.join('; '));
        assertTaskBindingProvenanceSource(cwd, state, pendingTask, packet, provenance);
        verifyTaskBindingProvenanceReceipt(cwd, state, pendingTask, provenance);
        bindingProvenance.push({
          taskId: provenance.taskId, status: 'pending-binding', path, receiptPath,
        });
        evidenceErrors.push(`Task ${provenance.taskId} binding provenance is pending state checkpoint`);
      } catch (error) {
        bindingProvenance.push({
          taskId: null, status: 'invalid', path, receiptPath: null,
          error: 'INVALID_TASK_BINDING_PROVENANCE',
        });
        evidenceErrors.push(`Unbound task binding provenance ${name} is invalid: ${error.message}`);
      }
    }
    for (const name of readdirSync(provenanceDirectory).filter((entry) => entry.endsWith('.sha256')).sort()) {
      const receiptPath = join(provenanceDirectory, name);
      if (seenProvenanceReceiptPaths.has(receiptPath)) continue;
      const pendingTask = state.tasks.find((task) => !task.taskPacketDigest
        && taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id) === receiptPath);
      const packetPath = pendingTask
        ? taskPacketSidecarPath(cwd, state.prNumber, pendingTask.id) : null;
      if (!pendingTask || !existsSync(packetPath)) {
        bindingProvenance.push({ taskId: pendingTask?.id ?? null, status: 'orphan', path: null, receiptPath });
        evidenceErrors.push(`Task binding provenance receipt ${name} is orphaned`);
        continue;
      }
      try {
        const packet = readJsonSidecar(packetPath, 'pending task packet sidecar');
        const planning = recoverHistoricalTaskBindingPlanning(cwd, state, packet);
        const provenance = buildTaskBindingProvenance(state, packet, planning);
        verifyTaskBindingProvenanceReceipt(cwd, state, pendingTask, provenance);
        bindingProvenance.push({
          taskId: pendingTask.id, status: 'pending-binding', path: null, receiptPath,
        });
        evidenceErrors.push(`Task ${pendingTask.id} binding provenance receipt is pending sidecar and state checkpoints`);
      } catch (error) {
        bindingProvenance.push({
          taskId: pendingTask.id, status: 'invalid', path: null, receiptPath,
          error: 'INVALID_TASK_BINDING_PROVENANCE',
        });
        evidenceErrors.push(`Task ${pendingTask.id} binding provenance receipt is invalid: ${error.message}`);
      }
    }
  }
  const specialist = readSpecialistStatus({ cwd, prNumber: state.prNumber });
  if (specialist.error && specialist.error !== 'SPECIALIST_PLAN_STALE') {
    evidenceErrors.push(`Specialist review bundle is invalid: ${specialist.error}`);
  }
  return {
    state, actualGit: actual, warnings, evidenceErrors, packetSidecars, bindingProvenance, specialist,
  };
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
          phase: 'recovering',
          nextAction: hasRemainingReviewAllowance(state)
            ? 'The review request became stale; reconcile the new HEAD before requesting another review.'
            : `The review request became stale and explicit limit ${reviewRequestUsage(state).limit} is exhausted; reconcile the new HEAD, then raise or remove the limit before requesting another review.`,
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
      checkpointUpdate = { phase: 'ready-for-review', nextAction: reviewLimitNextAction(state) };
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
  const {
    state, warnings, evidenceErrors, packetSidecars, bindingProvenance, specialist,
  } = reconcileState({ cwd, prNumber });
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
    `Review requests: ${reviewRequestUsage(state).used}; limit: ${reviewRequestUsage(state).limit ?? 'unlimited'}`,
    `Release baseline: ${release}`,
    `Base: ${state.baseSha}`,
    `Requested/reviewed: ${state.requestedHeadSha ?? 'none'} / ${state.reviewedHeadSha ?? 'none'}`,
    `Verification escalation: ${state.verificationEscalation
      ? `${state.verificationEscalation.reason} at PR ${state.verificationEscalation.observedPrHeadSha}`
      : 'none'}`,
    `Integration HEAD: ${state.currentIntegrationHeadSha}`,
    `Task packet sidecars: ${packetSidecars.length === 0 ? 'none' : packetSidecars.map((entry) => `${entry.taskId}=${entry.status}`).join(', ')}`,
    `Task binding provenance: ${bindingProvenance.length === 0 ? 'none' : bindingProvenance.map((entry) => `${entry.taskId ?? 'unknown'}=${entry.status}`).join(', ')}`,
    `Specialist evidence: ${specialist.status}${specialist.requiredReviewerIds.length > 0 ? `; required ${specialist.requiredReviewerIds.join(', ')}` : ''}`,
    `Targeted validation plan: ${validationPlanRecoverySummary(cwd, state)}`,
    'Tasks:',
    ...(taskLines.length > 0 ? taskLines : ['- none']),
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['- none']),
    `Blocked: ${state.blockedReasons.length > 0 ? state.blockedReasons.map((item) => truncate(item, 200)).join('; ') : 'none'}`,
    `Next action: ${truncate(state.nextAction, 500)}`,
    `Reconciliation warnings: ${warnings.length > 0 ? warnings.join('; ') : 'none'}`,
    `Recovery evidence errors: ${evidenceErrors.length > 0 ? evidenceErrors.map((item) => truncate(item, 240)).join('; ') : 'none'}`,
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
