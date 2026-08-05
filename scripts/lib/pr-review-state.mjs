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
import { randomUUID } from 'node:crypto';
import { gitText, resolveCommit, runGit } from './git.mjs';
import { inspectReleaseState } from './release-state.mjs';
import {
  completionGate,
  reviewRequestGate,
  taskHasCanonicalThreadCoverage,
  validatePrReviewState,
  validatePrReviewStateV1,
} from './contracts.mjs';

export { completionGate, reviewRequestGate } from './contracts.mjs';

export const ACTIVE_STATE_LIMIT_BYTES = 30 * 1024;
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

function emptyThreadProof() {
  return {
    status: 'not-run',
    headSha: null,
    threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    updatedAt: null,
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
  const state = readStateDocument(path);
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
      schemaVersion: 2,
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
      threadResolutionStatus: emptyThreadProof(),
      blockedReasons: [],
      validationStatus: { status: 'not-run', headSha: null, checks: [], updatedAt: null },
      nextAction: 'Resolve the PR and pushed head metadata before requesting review.',
      integrationWorktree: root,
      orchestratorSessionId,
      abandonmentReason: null,
      git: gitSnapshot(root),
      updatedAt: utcNow(),
    };
    validateStateForWrite(state);
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 2, prNumber: selectedPr });
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
    return { ...proof, checks: unique(proof.checks) };
  }
  if (proof.status === 'failed' && proof.headSha !== null && proof.updatedAt !== null) {
    return { ...proof, checks: unique(proof.checks) };
  }
  return { status: 'not-run', headSha: null, checks: [], updatedAt: null };
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
  const migrated = {
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
  const errors = validatePrReviewState(migrated);
  if (errors.length > 0) {
    throw new StateError(`Unable to migrate schema v1 state:\n- ${errors.join('\n- ')}`, 'STATE_MIGRATION_FAILED');
  }
  return migrated;
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
    if (legacy.schemaVersion === 2) throw new StateError('State already uses schema v2', 'STATE_ALREADY_MIGRATED');
    const state = migratePrReviewStateV1(legacy, {
      integrationMap,
      isAncestor: (ancestor, descendant) => runGit(
        ['merge-base', '--is-ancestor', ancestor, descendant],
        { cwd: legacy.integrationWorktree, allowFailure: true },
      ).status === 0,
    });
    validateStateForWrite(state);
    const backupPath = join(stateDirectory(cwd, selectedPr), 'state.v1.backup.json');
    if (existsSync(backupPath)) {
      const existingSource = readFileSync(backupPath, 'utf8');
      let semanticallyEqual = false;
      try { semanticallyEqual = JSON.stringify(JSON.parse(existingSource)) === JSON.stringify(legacy); } catch { /* fail closed */ }
      if (existingSource !== legacySource && !semanticallyEqual) {
        throw new StateError(`Migration backup differs from current v1 state at ${backupPath}`, 'MIGRATION_BACKUP_CONFLICT');
      }
    } else {
      atomicWriteText(backupPath, legacySource);
    }
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 2, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, {
      type: 'state-migrated',
      summary: `Migrated PR ${selectedPr} state from schema v1 to v2`,
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

export function checkpointState({
  cwd = process.cwd(), prNumber, nextState, expectedRevision, event, eventWriter = appendEvent,
  transitionAuthorization,
} = {}) {
  const selectedPr = prNumber ?? nextState?.prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (event) prepareEvent(event);
  return withStateLock(cwd, selectedPr, () => {
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
  if (guardedKind === null) {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
    ]) assertImmutableValue(current[field], next[field], field);
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
  } else {
    for (const field of [
      'requestedHeadSha', 'reviewedHeadSha', 'reviewRound', 'verificationReviewUsed',
      'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
    ]) assertImmutableValue(current[field], next[field], field);
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
  }
  for (const task of current.tasks) {
    const updated = nextTasks.get(task.id);
    if (!updated) throw new StateError(`Task ${task.id} cannot be deleted`, 'IMMUTABLE_STATE_PROVENANCE');
    for (const field of ['id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition']) {
      assertImmutableValue(task[field], updated[field], `task ${task.id} ${field}`);
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
  const phase = outcome.kind === 'verification' && outcome.outcome === 'findings'
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
        ? 'Present verification findings for human decision.'
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

export function completeIntegratedTasks(state, { threadResolutionStatus }) {
  const tasks = state.tasks.map((task) => {
    const eligibleNotApplicable = task.status === 'not-applicable'
      && !['actionable', 'needs-human-decision'].includes(task.disposition);
    if (task.status !== 'integrated' && !eligibleNotApplicable) return task;
    const eligible = task.sourceType === 'local'
      || (task.sourceType === 'github-thread'
        && taskHasCanonicalThreadCoverage(task, threadResolutionStatus.threads ?? []))
      || (task.sourceType === 'github-threadless'
        && threadResolutionStatus.threadlessVerification?.status === 'passed'
        && threadResolutionStatus.threadlessVerification.taskIds.includes(task.id));
    return eligible ? { ...task, status: 'completed' } : task;
  });
  const next = { ...state, tasks, threadResolutionStatus };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`Invalid integrated-to-completed transition:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_COMPLETION');
  return next;
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

export function checkpointTaskCompletion({
  cwd = process.cwd(), prNumber, threadResolutionStatus, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = completeIntegratedTasks(current, { threadResolutionStatus });
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
  const state = loadState(cwd);
  if (!state) return { state: null, checkpointed: false, warning: null };
  const currentRoot = repositoryRoot(cwd);
  if (resolve(currentRoot) !== resolve(state.integrationWorktree)) {
    return { state, checkpointed: false, warning: 'Skipped checkpoint outside the integration worktree' };
  }
  if (state.orchestratorSessionId && sessionId && state.orchestratorSessionId !== sessionId) {
    return { state, checkpointed: false, warning: 'Skipped checkpoint for a different session' };
  }
  const git = gitSnapshot(state.integrationWorktree);
  if (backup) atomicWriteJson(join(stateDirectory(cwd, state.prNumber), 'state.backup.json'), state);
  const proofInvalidated = git.headSha !== state.currentIntegrationHeadSha || git.dirty;
  const headSensitivePhases = new Set([
    'ready-for-review',
    'awaiting-review',
    'triaging',
    'verifying',
    'validating',
    'complete',
  ]);
  const nextState = {
    ...state,
    currentIntegrationHeadSha: git.headSha,
    git,
    ...(proofInvalidated ? {
      validationStatus: { status: 'not-run', headSha: null, checks: [], updatedAt: null },
      threadResolutionStatus: {
        ...state.threadResolutionStatus,
        status: 'not-run',
        headSha: null,
        updatedAt: null,
      },
      ...(state.phase === 'awaiting-review' ? {
        phase: state.reviewRequest?.kind === 'verification' ? 'awaiting-human-decision' : 'recovering',
        nextAction: state.reviewRequest?.kind === 'verification'
          ? 'A verification request became stale; present the stale-request decision to a human.'
          : 'The discovery request became stale; reconcile the new HEAD before requesting another review.',
      } : headSensitivePhases.has(state.phase) ? {
          phase: 'recovering',
          nextAction: 'Reconcile the changed integration checkout and re-establish exact-head proof.',
        } : {}),
    } : {}),
  };
  const updated = checkpointState({
    cwd,
    prNumber: state.prNumber,
    nextState,
    expectedRevision: state.revision,
    event: { type: 'git-checkpoint', summary: `Checkpointed integration HEAD ${git.headSha}` },
  });
  return { state: updated, checkpointed: true, warning: git.dirty ? 'Integration checkout is dirty' : null };
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
    `Integration HEAD: ${state.currentIntegrationHeadSha}`,
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
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
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
