import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { gitBuffer, gitText, listTree, readTreeFile, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import {
  digestJson,
  planReadiness,
  sourceChecklistBinding,
  validateDevelopmentState,
} from '../contracts/contracts.mjs';
import {
  implementationTaskDigest,
  pathMatchesOwnership,
  validateImplementationResult,
  validateImplementationResultAgainstTask,
  validateImplementationTask,
  validateImplementationTaskStructure,
} from '../implementation/contracts.mjs';
import { compareChecklistMappings } from '../source/checklists.mjs';
import { captureSource, refreshSource as captureSourceRefresh } from '../source/source.mjs';
import { createGhGraphqlAdapter } from '../source/gh-adapter.mjs';
import { readGithubIssue } from '../source/github.mjs';
import { requiredSpecialistIds, validateSpecialistEvidence } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import {
  affectedAreaCommands,
  assertValidationCommandCompatibility,
  captureReleaseEvidence,
  deriveValidationPlan,
  findingFingerprint,
  PROTECTED_RELEASE_REF,
  validateVerificationContract,
  validationPlanDigest,
} from '../verification/contracts.mjs';
import {
  activePointerPath,
  archiveDirectory,
  changeDirectory,
  changeRoot,
  gitCommonDirectory,
  implementationTaskPacketPath,
  implementationWorktreeCreationIntentPath,
  implementationWorktreeManifestPath,
  implementationWorktreePath,
  implementationWorktreeRemovalIntentPath,
  implementationWorktreeTombstonePath,
  repositoryRoot,
  validateChangeId,
} from '../paths.mjs';

export { activePointerPath, changeDirectory, changeRoot, gitCommonDirectory, repositoryRoot } from '../paths.mjs';

export const STATE_LIMIT_BYTES = 64 * 1024;
export const HOOK_CONTEXT_LIMIT = 9000;
const SIDECAR_LIMIT_BYTES = 4 * 1024 * 1024;
const TRANSITION_INTENT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const MODES = new Set(['plan-only', 'implement', 'full']);

export class StateError extends Error {
  constructor(message, code = 'STATE_ERROR') {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

function now(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function serialized(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function objectDigest(value) {
  if (typeof digestJson === 'function') return digestJson(value);
  return sha256(JSON.stringify(canonical(value)));
}

function fsyncDirectory(path) {
  try {
    const handle = openSync(path, 'r');
    fsyncSync(handle);
    closeSync(handle);
  } catch {
    // Some filesystems do not support directory fsync.
  }
}

export function atomicWriteText(path, contents, { beforeRename } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, contents, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    if (beforeRename) beforeRename(temporary);
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(path, value) {
  const text = serialized(value);
  if (Buffer.byteLength(text) > SIDECAR_LIMIT_BYTES) {
    throw new StateError(`JSON sidecar exceeds ${SIDECAR_LIMIT_BYTES} bytes`, 'SIDECAR_TOO_LARGE');
  }
  atomicWriteText(path, text);
}

function readJson(path, label = 'JSON', limit = SIDECAR_LIMIT_BYTES) {
  try {
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > limit) throw new Error(`exceeds ${limit} bytes`);
    return JSON.parse(text);
  } catch (error) {
    throw new StateError(`Unable to read ${label} at ${path}: ${error.message}`, 'INVALID_DURABLE_EVIDENCE');
  }
}

function writeImmutableJson(path, value, label, { limit = SIDECAR_LIMIT_BYTES, afterJson } = {}) {
  const text = serialized(value);
  if (Buffer.byteLength(text) > limit) {
    throw new StateError(`${label} exceeds ${limit} bytes`, 'SIDECAR_TOO_LARGE');
  }
  const digest = objectDigest(value);
  const receiptPath = path.replace(/\.json$/u, '.sha256');
  if (existsSync(path) || existsSync(receiptPath)) {
    if (!existsSync(path) || !existsSync(receiptPath)) {
      throw new StateError(`${label} has incomplete durable evidence`, 'IMMUTABLE_EVIDENCE_CONFLICT');
    }
    const existing = readJson(path, label);
    const receipt = readFileSync(receiptPath, 'utf8').trim();
    if (objectDigest(existing) !== digest || receipt !== digest || serialized(existing) !== text) {
      throw new StateError(`${label} already exists with different or tampered content`, 'IMMUTABLE_EVIDENCE_CONFLICT');
    }
    return digest;
  }
  atomicWriteText(path, text);
  if (afterJson) afterJson();
  atomicWriteText(receiptPath, `${digest}\n`);
  verifyReceipt(path, label, limit);
  return digest;
}

export function verifyReceipt(path, label = 'sidecar', limit = SIDECAR_LIMIT_BYTES) {
  const receiptPath = path.replace(/\.json$/u, '.sha256');
  if (!existsSync(path) || !existsSync(receiptPath)) {
    throw new StateError(`${label} or its receipt is missing`, 'RECEIPT_MISSING');
  }
  const value = readJson(path, label, limit);
  const expected = readFileSync(receiptPath, 'utf8').trim();
  const actual = objectDigest(value);
  if (!/^sha256:[0-9a-f]{64}$/u.test(expected) || expected !== actual) {
    throw new StateError(`${label} receipt does not match its canonical content`, 'RECEIPT_TAMPERED');
  }
  return { value, digest: actual };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function removeLock(path, token, { forceIncomplete = false } = {}) {
  const ownerPath = join(path, 'owner.json');
  if (existsSync(ownerPath)) {
    let owner;
    try { owner = readJson(ownerPath, 'lock owner', 4096); } catch { return false; }
    if (owner.token !== token) return false;
    try { unlinkSync(ownerPath); } catch { return false; }
  } else if (!forceIncomplete) return false;
  try { rmdirSync(path); return true; } catch { return false; }
}

function reclaimStaleLock(path, expectedToken = null) {
  let entries;
  try { entries = readdirSync(path); } catch { return false; }
  const temporary = [];
  for (const name of entries) {
    if (name === 'owner.json') continue;
    const match = name.match(/^\.owner\.json\.(\d+)\.[0-9a-f-]{36}\.tmp$/u);
    if (!match) return false;
    const pid = Number(match[1]);
    if (processAlive(pid)) return false;
    temporary.push(name);
  }
  const ownerPath = join(path, 'owner.json');
  if (expectedToken !== null) {
    let owner;
    try { owner = readJson(ownerPath, 'stale lock owner', 4096); } catch { return false; }
    if (owner.token !== expectedToken) return false;
  }
  try {
    for (const name of temporary) unlinkSync(join(path, name));
    if (existsSync(ownerPath)) unlinkSync(ownerPath);
    rmdirSync(path);
    return true;
  } catch { return false; }
}

function acquireLock(path, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, staleMs = DEFAULT_STALE_LOCK_MS, clock } = {}) {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  while (true) {
    try {
      mkdirSync(path);
      const token = randomUUID();
      atomicWriteJson(join(path, 'owner.json'), { token, pid: process.pid, hostname: hostname(), acquiredAt: now(clock) });
      return () => removeLock(path, token);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = readJson(join(path, 'owner.json'), 'lock owner', 4096);
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > staleMs && owner.hostname === hostname() && !processAlive(owner.pid)) {
          if (reclaimStaleLock(path, owner.token)) continue;
        }
      } catch {
        // An incomplete lock is reclaimed only after the stale threshold.
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          if (reclaimStaleLock(path)) continue;
        }
      }
      if (Date.now() >= deadline) throw new StateError(`Timed out waiting for lock ${path}`, 'LOCK_TIMEOUT');
      sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}

function lifecycleLockPath(cwd) {
  return join(changeRoot(cwd), 'locks', 'global', 'lifecycle.lock');
}

function changeLockPath(cwd, changeId) {
  return join(changeRoot(cwd), 'locks', `${validateChangeId(changeId)}.lock`);
}

function integrationOperationLockPath(cwd, changeId) {
  return join(changeRoot(cwd), 'locks', 'operations', `${validateChangeId(changeId)}.integration.lock`);
}

export function withChangeLock(cwd, changeId, callback, options = {}) {
  const release = acquireLock(changeLockPath(cwd, changeId), options);
  try { return callback(); } finally { release(); }
}

export function withIntegrationOperationLock(cwd, changeId, callback, options = {}) {
  const release = acquireLock(integrationOperationLockPath(cwd, changeId), options);
  try { return callback(); } finally { release(); }
}

function withLifecycleAndChangeLocks(cwd, changeId, callback, options = {}) {
  const releaseGlobal = acquireLock(lifecycleLockPath(cwd), options);
  try {
    const releaseChange = acquireLock(changeLockPath(cwd, changeId), options);
    try { return callback(); } finally { releaseChange(); }
  } finally { releaseGlobal(); }
}

export function gitObservation(cwd = process.cwd(), clock) {
  const root = repositoryRoot(cwd);
  const status = gitText(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root });
  return {
    headSha: resolveCommit(root, 'HEAD'),
    branch: gitText(['branch', '--show-current'], { cwd: root }) || '(detached)',
    clean: status === '',
    observedAt: now(clock),
  };
}

function worktreeIdentity(cwd) {
  return { gitDirectory: gitText(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: repositoryRoot(cwd) }) };
}

function normalizeErrors(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (result.valid === false) return result.errors ?? ['validation failed'];
  return [];
}

function assertValidState(state) {
  const errors = normalizeErrors(validateDevelopmentState(state));
  if (errors.length > 0) throw new StateError(`Invalid development state:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  const text = serialized(state);
  if (Buffer.byteLength(text) > STATE_LIMIT_BYTES) throw new StateError('Active state exceeds 64 KiB', 'STATE_TOO_LARGE');
}

function stateFile(cwd, changeId) { return join(changeDirectory(cwd, changeId), 'state.json'); }
function transitionDirectory(cwd, changeId, revision) {
  return join(changeDirectory(cwd, changeId), 'transitions', String(revision).padStart(8, '0'));
}

function callCrash(callback, step, details) {
  if (callback) callback(step, details);
}

function appendEvent(cwd, changeId, event, crashStep) {
  const path = join(changeDirectory(cwd, changeId), 'events.jsonl');
  const events = eventHistory(cwd, changeId);
  const text = `${[...events, event].map((item) => JSON.stringify(item)).join('\n')}\n`;
  atomicWriteText(path, text, {
    beforeRename: () => callCrash(crashStep, 'before-event-commit', { revision: event.revision }),
  });
}

function commitTransition({ cwd, previousState, nextState, type, summary, pendingEvidence = [], crashStep }) {
  assertValidState(nextState);
  if (previousState && nextState.revision !== previousState.revision + 1) {
    throw new StateError('Transition revision must increment exactly once', 'REVISION_CONFLICT');
  }
  if (!nonemptyString(type) || !nonemptyString(summary)) {
    throw new StateError('Transition type and summary must be nonempty strings', 'TRANSITION_CONFLICT');
  }
  const evidenceKeys = new Set();
  const evidencePathsSet = new Set();
  for (const record of pendingEvidence) {
    if (!nonemptyString(record.key) || !nonemptyString(record.path) || !nonemptyString(record.label)
        || evidenceKeys.has(record.key) || evidencePathsSet.has(record.path)
        || !record.path.endsWith('.json') || record.path.split('/').includes('..')) {
      throw new StateError('Transition evidence records require unique keys and safe JSON paths', 'TRANSITION_CONFLICT');
    }
    evidenceKeys.add(record.key);
    evidencePathsSet.add(record.path);
    const text = serialized(record.value);
    if (Buffer.byteLength(text) > SIDECAR_LIMIT_BYTES) {
      throw new StateError(`${record.label} exceeds ${SIDECAR_LIMIT_BYTES} bytes`, 'SIDECAR_TOO_LARGE');
    }
  }
  const evidence = Object.fromEntries(pendingEvidence.map(({ key, value }) => [key, objectDigest(value)]));
  const evidencePaths = Object.fromEntries(pendingEvidence.map(({ key, path }) => [key, path]));
  const authoritativeEvidence = Object.fromEntries(pendingEvidence.map(({ key, path, label, value }) => [key, {
    path, label, digest: evidence[key], value,
  }]));
  const intent = {
    schemaVersion: 1,
    changeId: nextState.changeId,
    revision: nextState.revision,
    type,
    summary,
    previousStateDigest: previousState ? objectDigest(previousState) : null,
    nextStateDigest: objectDigest(nextState),
    nextState,
    evidence,
    evidencePaths,
    authoritativeEvidence,
    createdAt: nextState.updatedAt,
  };
  const directory = transitionDirectory(cwd, nextState.changeId, nextState.revision);
  if (existsSync(directory)) throw new StateError(`Transition revision ${nextState.revision} already exists`, 'TRANSITION_CONFLICT');
  callCrash(crashStep, 'before-intent', { revision: nextState.revision });
  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.${basename(directory)}.${process.pid}.${randomUUID()}.pending`);
  mkdirSync(staging);
  try {
    writeImmutableJson(join(staging, 'intent.json'), intent, 'transition intent', { limit: TRANSITION_INTENT_LIMIT_BYTES });
    fsyncDirectory(staging);
    callCrash(crashStep, 'before-intent-commit', { revision: nextState.revision });
    renameSync(staging, directory);
    fsyncDirectory(parent);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  callCrash(crashStep, 'after-intent', { revision: nextState.revision });
  for (const record of pendingEvidence) {
    const digest = writeImmutableJson(
      join(changeDirectory(cwd, nextState.changeId), record.path), record.value, record.label,
      { afterJson: () => callCrash(crashStep, 'after-evidence-json', { revision: nextState.revision, key: record.key }) },
    );
    if (digest !== evidence[record.key]) throw new StateError(`Evidence digest changed for ${record.key}`, 'TRANSITION_CONFLICT');
  }
  callCrash(crashStep, 'after-evidence', { revision: nextState.revision });
  atomicWriteJson(stateFile(cwd, nextState.changeId), nextState);
  callCrash(crashStep, 'after-state', { revision: nextState.revision });
  const receipt = transitionReceiptFor(intent);
  writeImmutableJson(join(directory, 'receipt.json'), receipt, 'transition receipt', {
    afterJson: () => callCrash(crashStep, 'after-receipt-json', { revision: nextState.revision }),
  });
  callCrash(crashStep, 'after-receipt', { revision: nextState.revision });
  appendEvent(cwd, nextState.changeId, {
    revision: nextState.revision, type, summary, at: nextState.updatedAt,
  }, crashStep);
  callCrash(crashStep, 'after-event', { revision: nextState.revision });
  atomicWriteText(join(directory, 'complete'), `${objectDigest(receipt)}\n`);
  fsyncDirectory(directory);
  callCrash(crashStep, 'after-complete', { revision: nextState.revision });
  return nextState;
}

function descriptorKind(descriptor) { return descriptor?.kind ?? descriptor?.type; }

function descriptorReference(descriptor) {
  if (descriptor?.type === 'github-issue') return `${descriptor.repository}#${descriptor.issueNumber}`;
  return descriptor?.reference ?? descriptor?.path ?? descriptor?.repository
    ?? descriptor?.file ?? descriptor?.comparisonBase ?? null;
}

function sourceFields(observation, descriptor, timestamp, classification = 'unchanged') {
  const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
  const material = observation.materialDigest ?? full;
  const progress = observation.progressDigest ?? full;
  return {
    kind: observation.sourceType ?? observation.kind ?? descriptorKind(descriptor),
    reference: observation.reference ?? descriptorReference(descriptor),
    relationship: observation.relationship ?? descriptor.relationshipIntent ?? descriptor.relationship ?? 'reference-only',
    initialDigest: full,
    latestDigest: full,
    fullDigest: full,
    materialDigest: material,
    progressDigest: progress,
    classification,
    observationDigest: objectDigest(observation),
    latestCommentIdentity: observation.source?.latestCommentIdentity ?? observation.latestCommentIdentity ?? observation.latestObservedCommentId ?? null,
    refreshedAt: observation.capturedAt ?? timestamp,
  };
}

function githubReaderFor(adapter) {
  if (typeof adapter === 'function') return adapter;
  const selected = adapter ?? createGhGraphqlAdapter();
  return (options) => readGithubIssue({ ...options, adapter: selected });
}

function checklistState(observation) {
  const byId = new Map();
  for (const item of observation.source?.checklist ?? observation.checklist ?? observation.checklistEntries ?? []) {
    const id = item.checklistItemId ?? item.id ?? item.identity;
    const existing = byId.get(id);
    byId.set(id, {
      id,
      checked: existing ? existing.checked && item.checked === true : item.checked === true,
      status: existing || item.ambiguous ? 'ambiguous' : (item.removed ? 'removed' : 'current'),
      externalChange: existing?.externalChange === true || item.externalChange === true,
    });
  }
  return [...byId.values()];
}

function refreshedChecklist(previousObservation, observation, comparison) {
  const current = checklistState(observation);
  if (!comparison) return current;
  const previousRaw = previousObservation.source?.checklist ?? [];
  const currentRaw = observation.source?.checklist ?? [];
  const allRaw = [...previousRaw, ...currentRaw];
  const durableIdsFor = (internalId) => allRaw.filter((item) => item.id === internalId).map((item) => item.checklistItemId);
  const ambiguous = new Set(currentRaw.filter((item) => item.ambiguous).map((item) => item.checklistItemId));
  for (const item of comparison.ambiguous ?? []) {
    const matches = [
      ...durableIdsFor(item.id),
      ...currentRaw.filter((raw) => item.position !== undefined && raw.position === item.position).map((raw) => raw.checklistItemId),
    ];
    for (const id of matches.length > 0 ? matches : [item.id]) ambiguous.add(id);
  }
  const external = new Set();
  for (const change of comparison.changes ?? []) {
    const raw = change.after ?? change.before;
    const id = raw?.checklistItemId ?? durableIdsFor(change.id)[0] ?? change.id;
    if (change.kind !== 'progress') external.add(id);
    if ((change.kind === 'removed' || change.kind === 'legacy-removed') && raw
        && !current.some((item) => item.id === raw.checklistItemId)) {
      current.push({ id: raw.checklistItemId, checked: raw.checked === true, status: 'removed', externalChange: true });
    }
    if (change.kind === 'legacy-text-or-order-changed' && change.before
        && change.before.checklistItemId !== change.after?.checklistItemId
        && !current.some((item) => item.id === change.before.checklistItemId)) {
      current.push({ id: change.before.checklistItemId, checked: change.before.checked === true, status: 'removed', externalChange: true });
    }
  }
  return current.map((item) => ({
    ...item,
    status: item.status === 'removed' ? 'removed' : item.status === 'ambiguous' || ambiguous.has(item.id) ? 'ambiguous' : 'current',
    externalChange: item.externalChange || external.has(item.id) || ambiguous.has(item.id),
  }));
}

function planningChecklist(previousObservation, observation, comparison) {
  const compared = refreshedChecklist(previousObservation, observation, comparison);
  const previous = previousObservation.source?.checklist ?? [];
  const current = observation.source?.checklist ?? [];
  const stableIds = new Set([...previous, ...current].map((item) => item.stableId).filter(nonemptyString));
  const eligibleStableIds = new Set([...stableIds].filter((stableId) => {
    const before = previous.filter((item) => item.stableId === stableId);
    const after = current.filter((item) => item.stableId === stableId);
    return before.length <= 1 && after.length <= 1 && [...before, ...after].every((item) => item.ambiguous !== true);
  }));
  const unambiguousStableItemIds = new Set([...previous, ...current]
    .filter((item) => eligibleStableIds.has(item.stableId)).map((item) => item.checklistItemId));
  const currentStableItemIds = new Set(current
    .filter((item) => eligibleStableIds.has(item.stableId)).map((item) => item.checklistItemId));
  const latest = new Map(checklistState(observation).map((item) => [item.id, item]));
  return compared
    .filter((item) => !unambiguousStableItemIds.has(item.id) || currentStableItemIds.has(item.id))
    .map((item) => currentStableItemIds.has(item.id) ? latest.get(item.id) : item);
}

export function nextActionFor(state) {
  if (state.phase === 'initializing') return 'Complete source capture and enter planning.';
  if (state.phase === 'planning') return state.unresolvedDecisionIds.length > 0
    ? 'Record or resolve every unresolved decision before accepting the plan.'
    : 'Validate and accept an implementation plan.';
  if (state.phase === 'awaiting-decision') return 'Record a decision, then amend or retain the accepted plan explicitly.';
  if (state.phase === 'ready-to-implement') return state.mode === 'plan-only'
    ? 'Archive this completed plan-only change.'
    : state.schemaVersion === 1 ? 'Run change:state upgrade-state with the current expected revision.'
      : 'Continue with the implementation capability by binding the next dependency-ready task.';
  if (state.phase === 'implementing') {
    if (state.execution?.activeWave.length) return 'Start or accept results for every task in the active implementation wave.';
    if (state.execution?.tasks.some((task) => task.status === 'accepted')) return 'Integrate the next accepted task in dependency order.';
    if (state.execution?.tasks.every((task) => ['integrated', 'no-change'].includes(task.status))) return 'Remove every task worktree, then run change:state finalize-integration.';
    return 'Bind or schedule the next dependency-ready implementation task.';
  }
  if (state.phase === 'integrating') return 'Run change:state reconcile-integration for the exact persisted integration intent.';
  if (state.phase === 'integrated') return 'Run change:state validation-plan for the exact integrated HEAD.';
  if (state.phase === 'validating') return state.verification?.validationStatus === 'failed'
    ? 'Replace the failed validation plan for a transient rerun, or amend the plan from its exact failed-result receipt for corrective work.'
    : 'Run change:state run-validation to resume exact pending validation commands.';
  if (state.phase === 'specialist-review') return state.verification?.specialistPlanDigest
    ? 'Record every routed exact-HEAD specialist result.' : 'Run change:state specialist-plan.';
  if (state.phase === 'verifying') return state.verification?.verifierResultDigest
    ? 'Resolve findings or run change:state finalize-development.' : 'Generate verifier-context and record the final verifier result.';
  if (state.phase === 'development-ready') return 'Hand off the exact local HEAD to the separate PR preparation workflow.';
  if (state.phase === 'recovering') return 'Run change:state recover to finish the exact interrupted transition.';
  if (state.phase === 'blocked') return state.execution?.activeWave.length
    ? 'Resolve the listed blocking evidence by accepting or finishing every active-wave task result, then reject/replan.'
    : state.execution?.tasks.some((task) => task.status === 'accepted')
      ? 'Integrate the next dependency-ready accepted task, then resolve the remaining blocked or failed work.'
      : state.verification
        ? state.verification.humanDecisionRequiredFingerprints.length
          ? 'Record durable human authorization for the repeated verification finding before disposition or replanning.'
          : 'Disposition every exact-source verification finding, then amend the plan for all actionable findings or resume verification.'
        : 'Resolve the listed blocking evidence by rejecting/replanning the blocked work, or explicitly abandon the change.';
  if (state.phase === 'abandoned') return 'Archive the explicitly abandoned change.';
  return 'Inspect durable state.';
}

function buildInitialState({ changeId, mode, baseBranch, expectedPrBaseBranch, planningRef, planningSha, observation, descriptor, git, timestamp }) {
  const state = {
    schemaVersion: 2,
    changeId,
    mode,
    phase: 'planning',
    revision: 0,
    baseBranch,
    expectedPrBaseBranch: expectedPrBaseBranch ?? baseBranch,
    planningRef,
    planningSha,
    source: sourceFields(observation, descriptor, timestamp),
    plan: null,
    git,
    unresolvedDecisionIds: [],
    checklist: checklistState(observation),
    blockedReasons: [],
    abandonmentReason: null,
    execution: null,
    nextAction: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.nextAction = nextActionFor(state);
  return state;
}

function assertExactlyOneSource(source, sources) {
  const values = [source, ...Object.values(sources ?? {})].filter((value) => value !== undefined && value !== null);
  if (values.length !== 1 || !descriptorKind(values[0])) {
    throw new StateError('Initialization requires exactly one source descriptor', 'INVALID_SOURCE');
  }
  return values[0];
}

function lifecycleChangeIds(cwd) {
  const changes = join(changeRoot(cwd), 'changes');
  if (!existsSync(changes)) return [];
  return readdirSync(changes, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function readArchiveIntent(cwd) {
  const root = changeRoot(cwd);
  const path = join(root, 'archive-lifecycle.json');
  if (existsSync(join(root, 'archive-intent.json')) || existsSync(join(root, 'archive-intent.sha256'))) {
    throw new StateError('Obsolete or partial archive lifecycle evidence is present', 'ARCHIVE_CONFLICT');
  }
  if (!existsSync(path)) return null;
  const envelope = readJson(path, 'archive lifecycle envelope');
  if (serialized(Object.keys(envelope).sort()) !== serialized(['intent', 'intentDigest', 'schemaVersion'])
      || envelope.schemaVersion !== 1 || !envelope.intent || envelope.intentDigest !== objectDigest(envelope.intent)) {
    throw new StateError('Archive lifecycle envelope is invalid', 'ARCHIVE_CONFLICT');
  }
  return envelope.intent;
}

function writeArchiveIntent(cwd, intent) {
  const path = join(changeRoot(cwd), 'archive-lifecycle.json');
  if (existsSync(path)) throw new StateError('An archive lifecycle is already pending', 'ARCHIVE_CONFLICT');
  atomicWriteJson(path, { schemaVersion: 1, intent, intentDigest: objectDigest(intent) });
  const persisted = readArchiveIntent(cwd);
  if (serialized(persisted) !== serialized(intent)) throw new StateError('Archive lifecycle commit failed', 'ARCHIVE_CONFLICT');
}

function clearArchiveIntent(cwd) {
  const path = join(changeRoot(cwd), 'archive-lifecycle.json');
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

export async function initializeState({
  cwd = process.cwd(), changeId, mode, baseBranch, expectedPrBaseBranch, planningRef,
  source, sources, sourceAdapter, clock, crashStep, lockOptions,
}) {
  validateChangeId(changeId);
  if (!MODES.has(mode)) throw new StateError(`Unsupported mode ${mode}`, 'INVALID_MODE');
  if (!baseBranch || !planningRef) throw new StateError('baseBranch and explicit planningRef are required', 'INVALID_INITIALIZATION');
  const descriptor = assertExactlyOneSource(source, sources);
  const root = repositoryRoot(cwd);
  if (readArchiveIntent(root)) {
    throw new StateError('A pending archive lifecycle must be recovered before initialization', 'LIFECYCLE_RECOVERY_REQUIRED');
  }
  if (locateState(root)) throw new StateError('Another change-development session is active', 'ACTIVE_CHANGE_EXISTS');
  const planningSha = resolveCommit(root, planningRef);
  const baseSha = resolveCommit(root, baseBranch);
  resolveCommit(root, expectedPrBaseBranch ?? baseBranch);
  if (runGit(['merge-base', '--is-ancestor', baseSha, planningSha], { cwd: root, allowFailure: true }).status !== 0) {
    throw new StateError('baseBranch must resolve to an ancestor of the Planning SHA', 'INVALID_PLANNING_BASE');
  }
  const git = gitObservation(root, clock);
  if (git.headSha !== planningSha || !git.clean) {
    throw new StateError('Initialization requires clean HEAD exactly at the Planning SHA', 'PLANNING_SNAPSHOT_MISMATCH');
  }
  // Potentially networked source capture deliberately happens before any state lock.
  const observation = await captureSource({
    cwd: root, planningSha, descriptor, githubReader: githubReaderFor(sourceAdapter),
    now: () => (clock ? clock() : new Date()),
  });
  const timestamp = now(clock);
  const initial = buildInitialState({
    changeId, mode, baseBranch, expectedPrBaseBranch, planningRef, planningSha,
    observation, descriptor, git, timestamp,
  });
  return withLifecycleAndChangeLocks(root, changeId, () => {
    const lockedGit = gitObservation(root, clock);
    if (lockedGit.headSha !== planningSha || !lockedGit.clean) {
      throw new StateError('Planning snapshot changed during source capture', 'PLANNING_SNAPSHOT_MISMATCH');
    }
    initial.git = lockedGit;
    const active = activePointerPath(root);
    if (readArchiveIntent(root)) {
      throw new StateError('A pending archive lifecycle must be recovered before initialization', 'LIFECYCLE_RECOVERY_REQUIRED');
    }
    if (locateState(root)) throw new StateError('Another change-development session is active', 'ACTIVE_CHANGE_EXISTS');
    if (lifecycleChangeIds(root).length > 0) {
      throw new StateError('Existing pointerless, interrupted, or orphan change state must be recovered before initialization', 'LIFECYCLE_RECOVERY_REQUIRED');
    }
    const directory = changeDirectory(root, changeId);
    if (existsSync(directory) || existsSync(archiveDirectory(root, changeId))) {
      throw new StateError(`Change ${changeId} already has durable state`, 'CHANGE_EXISTS');
    }
    const worktree = worktreeIdentity(root);
    commitTransition({
      cwd: root, previousState: null, nextState: initial, type: 'initialized',
      summary: 'Captured source and entered planning', crashStep,
      pendingEvidence: [
        { key: 'observationDigest', path: 'source/initial.json', value: observation, label: 'initial source observation' },
        { key: 'worktreeDigest', path: 'worktree.json', value: worktree, label: 'owning worktree identity' },
      ],
    });
    atomicWriteJson(active, { schemaVersion: 1, changeId, statePath: stateFile(root, changeId), updatedAt: timestamp });
    return initial;
  }, lockOptions);
}

export function locateState(cwd = process.cwd(), changeId) {
  const root = repositoryRoot(cwd);
  const pointer = activePointerPath(root);
  if (!existsSync(pointer)) return null;
  const active = readJson(pointer, 'active change pointer', 8192);
  validateChangeId(active.changeId);
  if (changeId !== undefined && validateChangeId(changeId) !== active.changeId) {
    throw new StateError(`Named change ${changeId} is not the canonical active change ${active.changeId}`, 'ACTIVE_CHANGE_MISMATCH');
  }
  const expected = stateFile(root, active.changeId);
  if (active.statePath !== expected) throw new StateError('Active pointer does not name the canonical state path', 'ACTIVE_POINTER_INVALID');
  if (!existsSync(expected)) throw new StateError('Active pointer names a missing canonical state path', 'ACTIVE_POINTER_INVALID');
  return { changeId: active.changeId, path: expected };
}

function locateNamedStateForRecovery(cwd, changeId) {
  const root = repositoryRoot(cwd);
  const selected = validateChangeId(changeId);
  const path = stateFile(root, selected);
  return existsSync(path) ? { changeId: selected, path } : null;
}

function loadNamedStateForRecovery(cwd, changeId) {
  const located = locateNamedStateForRecovery(cwd, changeId);
  if (!located) return null;
  const state = readJson(located.path, 'development state', STATE_LIMIT_BYTES);
  assertValidState(state);
  return state;
}

export function loadState(cwd = process.cwd(), changeId) {
  const located = locateState(cwd, changeId);
  if (!located) return null;
  const state = readJson(located.path, 'development state', STATE_LIMIT_BYTES);
  assertValidState(state);
  return state;
}

function assertRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) {
    throw new StateError(`Expected revision ${expectedRevision}; active revision is ${state.revision}`, 'REVISION_CONFLICT');
  }
}

function selectedChangeId(cwd, changeId) {
  const located = locateState(cwd, changeId);
  if (!located) throw new StateError('No active change state', 'STATE_NOT_FOUND');
  return located.changeId;
}

function revised(state, changes, clock) {
  const next = { ...state, ...changes, revision: state.revision + 1, updatedAt: now(clock) };
  next.nextAction = nextActionFor(next);
  return next;
}

function readEffectivePlan(cwd, state) {
  if (!state.plan) return null;
  if (state.plan.amendmentCount === 0) return verifyReceipt(join(changeDirectory(cwd, state.changeId), 'plan', 'plan.json'), 'accepted plan').value;
  const name = `${String(state.plan.amendmentCount).padStart(4, '0')}.json`;
  return verifyReceipt(join(changeDirectory(cwd, state.changeId), 'plan', 'amendments', name), 'latest plan amendment').value.resultingPlan;
}

function executionFromPlan(plan, baseSha) {
  return {
    planDigest: objectDigest(plan),
    baseSha,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      dependsOn: [...task.dependsOn],
      anticipatedPaths: [...task.anticipatedPaths],
      produces: [...task.produces],
      consumes: task.consumes.map(({ artifactId }) => artifactId),
      status: 'unbound', binding: 0, attempt: 0, packetDigest: null, taskBaseSha: null,
      resultDigest: null, workerCommit: null, integratedCommit: null, workerId: null,
      worktreePath: null, branch: null, worktreeManifestDigest: null,
    })),
    activeWave: [],
    integrationIntent: null,
  };
}

function readInitialObservation(cwd, state) {
  const verified = verifyReceipt(
    join(changeDirectory(cwd, state.changeId), 'source', 'initial.json'),
    'initial source observation',
  );
  const observation = verified.value;
  const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
  if (full !== state.source.initialDigest) {
    throw new StateError('Initial source observation does not match state summary', 'SOURCE_OBSERVATION_INVALID');
  }
  return observation;
}

function readObservationByDigest(cwd, state) {
  const sourceDirectory = join(changeDirectory(cwd, state.changeId), 'source');
  const candidates = [join(sourceDirectory, 'initial.json')];
  const observations = join(sourceDirectory, 'observations');
  if (existsSync(observations)) {
    candidates.push(...readdirSync(observations)
      .filter((name) => name.endsWith('.json'))
      .sort().reverse().map((name) => join(observations, name)));
  }
  for (const path of candidates) {
    const verified = verifyReceipt(path, 'source observation');
    if (verified.digest === state.source.observationDigest) return verified.value;
  }
  throw new StateError('Latest source observation receipt cannot be located', 'SOURCE_OBSERVATION_MISSING');
}

function readinessErrors(plan, evidence, sourceObservation, readPlanningFile) {
  const gate = planReadiness(plan, { planningEvidence: evidence, sourceObservation, readPlanningFile });
  if (Array.isArray(gate)) return gate;
  if (gate?.ready === false || gate?.allowed === false) return gate.reasons ?? gate.errors ?? ['plan is not ready'];
  return [];
}

export function validatePlanStateIdentity(plan, state, { sourceCaptureDigest = state?.source?.latestDigest } = {}) {
  if (!state) return ['An active durable state is required to validate plan identity.'];
  const fields = [
    ['changeId', plan?.changeId, state.changeId],
    ['Planning SHA', plan?.planning?.planningSha, state.planningSha],
    ['base branch', plan?.planning?.baseBranch, state.baseBranch],
    ['expected PR base branch', plan?.expectedPrBaseBranch, state.expectedPrBaseBranch],
    ['source kind', plan?.source?.kind, state.source.kind],
    ['source reference', plan?.source?.reference, state.source.reference],
    ['source relationship', plan?.source?.relationship, state.source.relationship],
    ['source capture digest', plan?.source?.captureDigest, sourceCaptureDigest],
  ];
  return fields.filter(([, actual, expected]) => actual !== expected)
    .map(([label, actual, expected]) => `${label} does not match active state (received ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}).`);
}

function assertPlanStateIdentity(plan, state, options) {
  const errors = validatePlanStateIdentity(plan, state, options);
  if (errors.length > 0) throw new StateError(`Plan identity does not match active state:\n- ${errors.join('\n- ')}`, 'PLAN_STATE_MISMATCH');
}

export function loadLatestSourceObservation(cwd = process.cwd(), changeId) {
  const root = repositoryRoot(cwd);
  const state = loadState(root, changeId);
  if (!state) return null;
  return readObservationByDigest(root, state);
}

function assertNoLegacyPreacceptDecisionEvidence(cwd, state) {
  const directory = join(changeDirectory(cwd, state.changeId), 'decisions');
  if (!existsSync(directory)) return;
  const decisionIds = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  if (decisionIds.length === 0) return;
  throw new StateError(
    `Legacy pre-accept decision evidence (${decisionIds.sort().join(', ')}) must be reconciled into candidate plan decisions before acceptance; automatic prose reconciliation is not permitted`,
    'PREACCEPT_DECISION_RECONCILIATION_REQUIRED',
  );
}

export function acceptPlan({ cwd = process.cwd(), changeId, plan, planningEvidence = [], expectedRevision, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, changeId);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    if (state.plan) throw new StateError('The accepted plan is immutable; use amend-plan', 'PLAN_ALREADY_ACCEPTED');
    if (!['planning', 'awaiting-decision'].includes(state.phase)) throw new StateError(`Cannot accept a plan in ${state.phase}`, 'INVALID_PHASE');
    assertNoLegacyPreacceptDecisionEvidence(root, state);
    assertPlanStateIdentity(plan, state);
    const currentGit = gitObservation(root, clock);
    if (!currentGit.clean || currentGit.headSha !== state.planningSha) {
      throw new StateError('Plan acceptance requires clean HEAD at the Planning SHA', 'PLANNING_SNAPSHOT_MISMATCH');
    }
    if (['implement', 'full'].includes(state.mode) && currentGit.branch === '(detached)') {
      throw new StateError('Implementation plan acceptance requires a named central branch', 'CENTRAL_BRANCH_REQUIRED');
    }
    const sourceObservation = readObservationByDigest(root, state);
    const errors = readinessErrors(plan, planningEvidence, sourceObservation,
      ({ planningSha, path }) => readTreeFile(root, planningSha, path));
    if (errors.length > 0) throw new StateError(`Plan is not implementation-ready:\n- ${errors.join('\n- ')}`, 'PLAN_NOT_READY');
    const stateChecklist = new Map(state.checklist.map((item) => [item.id, item]));
    if (plan.checklistMappings.length !== stateChecklist.size || plan.checklistMappings.some((mapping) => {
      const item = stateChecklist.get(mapping.id);
      return !item || item.checked !== mapping.checked || item.status !== mapping.status
        || item.externalChange !== mapping.externalChange;
    })) throw new StateError('Plan checklist mappings must exactly match the latest source observation', 'PLAN_CHECKLIST_MISMATCH');
    preflightVerifierCapacity({ originalPlan: plan, planningEvidence, sourceDigest: state.source.observationDigest,
      featureDirectory: join(root, 'specs', 'features') });
    const planDigest = objectDigest(plan);
    const timestamp = now(clock);
    const next = revised(state, {
      phase: 'ready-to-implement',
      plan: {
        revision: plan.planRevision,
        originalDigest: planDigest,
        effectiveDigest: planDigest,
        sourceCaptureDigest: plan.source.captureDigest,
        amendmentCount: 0,
        acceptedAt: timestamp,
      },
      unresolvedDecisionIds: [],
      source: { ...state.source, classification: 'unchanged' },
      blockedReasons: [],
      git: currentGit,
      ...(state.schemaVersion === 2 ? { execution: executionFromPlan(plan, currentGit.headSha) } : {}),
    }, () => new Date(timestamp));
    return commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'plan-accepted',
      summary: 'Accepted immutable implementation plan', crashStep,
      pendingEvidence: [
        { key: 'planDigest', path: 'plan/plan.json', value: plan, label: 'accepted plan' },
        { key: 'planningEvidenceDigest', path: 'plan/planning-evidence.json', value: planningEvidence, label: 'planning evidence' },
      ],
    });
  }, lockOptions);
}

function assertWritableV2(state) {
  if (state.schemaVersion !== 2) {
    throw new StateError('Execution writes require development-state v2; run upgrade-state first', 'STATE_UPGRADE_REQUIRED');
  }
}

function assertImplementationMode(state, operation) {
  if (!['implement', 'full'].includes(state.mode)) {
    throw new StateError(`${operation} requires implement or full mode`, 'IMPLEMENTATION_MODE_REQUIRED');
  }
}

function executionTask(state, taskId) {
  const task = state.execution?.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new StateError(`Unknown implementation task ${taskId}`, 'TASK_NOT_FOUND');
  return task;
}

function replaceExecutionTask(state, taskId, changes, executionChanges = {}) {
  return {
    ...state.execution,
    ...executionChanges,
    tasks: state.execution.tasks.map((task) => task.id === taskId ? { ...task, ...changes } : task),
  };
}

function taskEvidencePath(taskId, binding) { return `implementation/tasks/${validateChangeId(taskId)}/${String(binding).padStart(4, '0')}.json`; }
function resultEvidencePath(taskId, attempt) { return `implementation/results/${validateChangeId(taskId)}/${String(attempt).padStart(4, '0')}.json`; }

function registeredWorktrees(cwd) {
  const records = []; let current = null;
  for (const line of gitText(['worktree', 'list', '--porcelain'], { cwd }).split('\n')) {
    if (line.startsWith('worktree ')) { if (current) records.push(current); current = { path: resolve(line.slice(9)) }; }
    else if (current && line.startsWith('HEAD ')) current.headSha = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branchRef = line.slice(7);
    else if (current && line === 'detached') current.detached = true;
  }
  if (current) records.push(current); return records;
}
function verifiedWorkerManifest(cwd, state, task) {
  const received = verifyReceipt(implementationWorktreeManifestPath(cwd, state.changeId, task.id), `worktree manifest ${task.id}`);
  const manifest = received.value;
  const expectedPath = resolve(implementationWorktreePath(cwd, state.changeId, task.id));
  if (manifest.schemaVersion !== 1 || manifest.repository !== gitCommonDirectory(cwd) || manifest.changeId !== state.changeId
      || manifest.taskId !== task.id || manifest.packetDigest !== task.packetDigest || manifest.baseSha !== task.taskBaseSha
      || manifest.status !== 'active' || resolve(manifest.path) !== expectedPath
      || manifest.branch !== `codex/change-${state.changeId}/${task.id}`) {
    throw new StateError(`Worktree manifest for ${task.id} does not match its canonical task binding`, 'WORKTREE_MANIFEST_MISMATCH');
  }
  const registration = registeredWorktrees(cwd).find((entry) => entry.path === expectedPath);
  if (!registration || registration.branchRef !== `refs/heads/${manifest.branch}`) throw new StateError(`Worktree ${task.id} is not registered on its exact branch`, 'WORKTREE_REGISTRATION_MISMATCH');
  return { manifest, manifestDigest: received.digest, registration };
}
function verifiedSchedulableWorktree(cwd, state, task) {
  const creation = verifyReceipt(implementationWorktreeCreationIntentPath(cwd, state.changeId, task.id), `worktree creation intent ${task.id}`);
  const active = verifiedWorkerManifest(cwd, state, task);
  const identityFields = ['schemaVersion', 'repository', 'changeId', 'taskId', 'packetDigest', 'branch', 'path', 'baseSha'];
  if (creation.value.status !== 'creating' || active.manifest.creationIntentDigest !== creation.digest
      || identityFields.some((field) => creation.value[field] !== active.manifest[field])) {
    throw new StateError(`Worktree ${task.id} creation evidence is incomplete or inconsistent`, 'WORKTREE_NOT_READY');
  }
  return active;
}
function assertExactCentralObservation(current, state, operation) {
  if (!current.clean || current.headSha !== state.git.headSha || current.branch !== state.git.branch
      || current.branch === '(detached)') {
    throw new StateError(`${operation} requires the exact clean owning central branch and durable HEAD`, 'CENTRAL_GIT_MISMATCH');
  }
}

function selectorEvidenceAtCommit(cwd, commit) {
  const all = new Map();
  const runnable = new Map();
  const scenarios = [];
  for (const entry of listTree(cwd, commit, 'specs/features')) {
    if (entry.type !== 'blob' || !entry.path.endsWith('.feature')) continue;
    const contents = readTreeFile(cwd, commit, entry.path)?.toString('utf8') ?? '';
    let featureTags = [];
    let pendingTags = [];
    for (const line of contents.split(/\r?\n/u)) {
      const trimmed = line.trim();
      const lineTags = [];
      if (trimmed.startsWith('@')) for (const token of trimmed.split(/\s+/u)) {
        const match = /^@([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(token);
        if (!match) continue;
        lineTags.push(match[1]);
        const paths = all.get(match[1]) ?? new Set();
        paths.add(entry.path);
        all.set(match[1], paths);
      }
      if (lineTags.length > 0) {
        pendingTags.push(...lineTags);
        continue;
      }
      if (/^Feature:/u.test(trimmed)) {
        featureTags = [...pendingTags];
        pendingTags = [];
        continue;
      }
      if (/^Scenario(?: Outline)?:/u.test(trimmed)) {
        const scenarioTags = [...pendingTags];
        const stableIds = scenarioTags.filter((selector) => /^id-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(selector));
        const tags = new Set([...featureTags, ...scenarioTags]);
        scenarios.push({ path: entry.path, tags, stableIds });
        if (stableIds.length === 1) {
          for (const selector of tags) {
            const paths = runnable.get(selector) ?? new Set();
            paths.add(entry.path);
            runnable.set(selector, paths);
          }
        }
        pendingTags = [];
        continue;
      }
      if (trimmed && !trimmed.startsWith('#')) pendingTags = [];
    }
  }
  return { all, runnable, scenarios };
}

function assertValidScenarioCatalog(catalog) {
  const malformed = catalog.scenarios.filter(({ stableIds }) => stableIds.length !== 1);
  if (malformed.length > 0) {
    const paths = [...new Set(malformed.map(({ path }) => path))];
    throw new StateError(`Related E2E catalog contains runnable scenarios without exactly one directly attached stable ID: ${paths.join(', ')}`,
      'RELATED_E2E_CATALOG_INVALID');
  }
}


const BROWSER_PROJECT_TAGS = Object.freeze([
  ['browser-webkit', 'mobile-webkit'],
  ['browser-firefox', 'desktop-firefox'],
]);

function assertValidationCatalog(catalog, validation, allowedUnknown = new Set()) {
  const selectors = validation.selectors.map((raw) => raw.startsWith('@') ? raw.slice(1) : raw);
  for (const selector of selectors) {
    if (!catalog.runnable.has(selector) && !allowedUnknown.has(selector)) {
      throw new StateError(`Required E2E selector ${selector} is unknown in the exact Git tree`, 'PLANNED_E2E_SELECTOR_MISMATCH');
    }
  }
  const matching = catalog.scenarios.filter(({ tags }) => selectors.some((selector) => tags.has(selector)));
  const requiredProjects = BROWSER_PROJECT_TAGS
    .filter(([tag]) => matching.some(({ tags }) => tags.has(tag)))
    .map(([, project]) => project);
  const missing = requiredProjects.filter((project) => !validation.projects.includes(project));
  if (missing.length > 0) {
    throw new StateError(`Related E2E validation is missing required browser projects: ${missing.join(', ')}`, 'RELATED_E2E_PROJECT_MISMATCH');
  }
}

function assertPacketSelectorsAtBase(cwd, packet) {
  const existing = selectorEvidenceAtCommit(cwd, packet.taskBaseSha);
  if (packet.requiredValidation.system.some(({ selectors }) => selectors.length > 0)) assertValidScenarioCatalog(existing);
  const planned = new Map((packet.plannedE2ESelectors ?? []).map((entry) => [entry.selector, entry.featurePath]));
  for (const selector of planned.keys()) {
    if (existing.all.has(selector)) throw new StateError(`Planned E2E selector ${selector} already exists at the exact task base`, 'PLANNED_E2E_SELECTOR_MISMATCH');
  }
  for (const validation of packet.requiredValidation.system) {
    assertValidationCatalog(existing, validation, new Set(planned.keys()));
  }
}

function assertPlannedSelectorsRealized(cwd, packet, commit) {
  const catalog = selectorEvidenceAtCommit(cwd, commit);
  if (packet.requiredValidation.system.some(({ selectors }) => selectors.length > 0)) assertValidScenarioCatalog(catalog);
  for (const { selector, featurePath } of packet.plannedE2ESelectors ?? []) {
    if (!catalog.runnable.get(selector)?.has(featurePath)) {
      throw new StateError(`Planned E2E selector ${selector} was not realized in ${featurePath} at the worker commit`, 'PLANNED_E2E_SELECTOR_MISMATCH');
    }
  }
  for (const validation of packet.requiredValidation.system) assertValidationCatalog(catalog, validation);
}
function verifiedWorkerTombstone(cwd, state, task) {
  const received = verifyReceipt(implementationWorktreeTombstonePath(cwd, state.changeId, task.id), `worktree tombstone ${task.id}`);
  if (received.value.status !== 'removed' || received.value.manifestDigest !== task.worktreeManifestDigest
      || received.value.changeId !== state.changeId || received.value.taskId !== task.id || received.value.packetDigest !== task.packetDigest) {
    throw new StateError(`Worktree tombstone for ${task.id} does not bind its task/manifest`, 'WORKTREE_TOMBSTONE_MISMATCH');
  }
  if (existsSync(task.worktreePath) || registeredWorktrees(cwd).some((entry) => entry.path === resolve(task.worktreePath))) {
    throw new StateError(`Removed worktree ${task.id} is still present or registered`, 'ACTIVE_WORKER_REMAINS');
  }
  return received.value;
}

export function upgradeState({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected);
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    assertImplementationMode(state, 'State upgrade');
    if (state.schemaVersion !== 1) throw new StateError('Only development-state v1 can be upgraded', 'STATE_ALREADY_CURRENT');
    if (!state.plan || !['ready-to-implement', 'blocked'].includes(state.phase)) {
      throw new StateError('State upgrade requires an accepted plan at the implementation boundary', 'INVALID_PHASE');
    }
    const current = gitObservation(root, clock);
    if (!current.clean || current.headSha !== state.git.headSha || current.branch !== state.git.branch
        || current.branch === '(detached)') {
      throw new StateError('State upgrade requires the exact clean central Git observation recorded by v1 state', 'CENTRAL_GIT_MISMATCH');
    }
    const plan = readEffectivePlan(root, state);
    const next = revised(state, {
      schemaVersion: 2,
      git: current,
      execution: executionFromPlan(plan, current.headSha),
    }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'state-upgraded',
      summary: 'Upgraded durable development state from v1 to v2', crashStep });
  }, lockOptions);
}

function assertPacketPlanBinding(packet, plan, state, currentSha, expectedPlanDigest = state.plan.effectiveDigest, expectedPlanRevision = plan.planRevision) {
  const planned = plan.tasks.find((task) => task.id === packet.taskId);
  if (!planned) throw new StateError(`Packet task ${packet.taskId} is absent from the effective plan`, 'PACKET_PLAN_MISMATCH');
  const expected = {
    changeId: state.changeId, planRevision: expectedPlanRevision, planDigest: expectedPlanDigest,
    planningSha: state.planningSha, taskBaseSha: currentSha,
    specialization: planned.specialization.specialization,
    riskTags: planned.specialization.riskTags,
    affectedAreas: planned.specialization.affectedAreas,
    planningSignals: { browserVisible: planned.specialization.browserVisible,
      relatedTestSelectionUncertain: planned.specialization.relatedTestSelectionUncertain },
    specialistRoute: planned.specialization.route, objective: planned.objective,
    decisionIds: planned.decisionIds,
    decisionContext: planned.decisionIds.map((id) => ({ id, resolution: plan.decisions.find((decision) => decision.id === id)?.resolution })),
    acceptanceCriteriaIds: planned.criterionIds,
    acceptanceCriteria: planned.criterionIds.map((id) => ({ id, description: plan.criteria.find((criterion) => criterion.id === id)?.description })),
    dependencies: planned.dependsOn,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (serialized(packet[field]) !== serialized(value)) throw new StateError(`Packet ${field} does not exactly match the effective plan/current base`, 'PACKET_PLAN_MISMATCH');
  }
  for (const path of packet.allowedPaths) {
    const owned = path.replace(/\/\*\*$/u, '');
    if (!planned.anticipatedPaths.some((plannedPath) => owned === plannedPath || owned.startsWith(`${plannedPath}/`))) {
      throw new StateError(`Packet allowed path is not covered by anticipated plan paths: ${path}`, 'PACKET_PLAN_MISMATCH');
    }
  }
}

function acceptedPlanningEvidence(cwd, state, planRevision, planDigest) {
  const directory = join(changeDirectory(cwd, state.changeId), 'plan');
  const original = verifyReceipt(join(directory, 'plan.json'), 'accepted plan');
  if (original.value.planRevision === planRevision && original.digest === planDigest) {
    return verifyReceipt(join(directory, 'planning-evidence.json'), 'accepted-plan planning evidence').value;
  }
  for (let number = 1; number <= state.plan.amendmentCount; number += 1) {
    const stem = join(directory, 'amendments', String(number).padStart(4, '0'));
    const amendment = verifyReceipt(`${stem}.json`, `plan amendment ${number}`).value;
    if (amendment.resultingPlan.planRevision === planRevision && amendment.newDigest === planDigest) {
      return verifyReceipt(`${stem}.evidence.json`, `plan amendment ${number} evidence`).value;
    }
  }
  throw new StateError('Task packet plan revision/digest has no receipt-protected accepted planning evidence', 'TASK_PROVENANCE_MISMATCH');
}

function assertPacketMapperProvenance(cwd, state, packet) {
  const evidence = acceptedPlanningEvidence(cwd, state, packet.planRevision, packet.planDigest);
  const accepted = evidence.filter((entry) => entry.reviewerId === 'behavior_mapper');
  if (packet.behaviorMapperEvidence === null) return;
  if (accepted.length !== 1 || serialized(accepted[0]) !== serialized(packet.behaviorMapperEvidence)) {
    throw new StateError('Task packet behavior-mapper evidence does not exactly match its receipt-protected plan revision and digest', 'TASK_PROVENANCE_MISMATCH');
  }
}

export function bindTask({ cwd = process.cwd(), changeId, packet, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Task binding'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (!['ready-to-implement', 'implementing'].includes(state.phase)) throw new StateError(`Cannot bind a task in ${state.phase}`, 'INVALID_PHASE');
    const task = executionTask(state, packet?.taskId);
    if (task.status !== 'unbound') throw new StateError(`Task ${task.id} is already bound or executed`, 'TASK_STATE_CONFLICT');
    if (!task.dependsOn.every((id) => ['integrated', 'no-change'].includes(executionTask(state, id).status))) {
      throw new StateError(`Task ${task.id} cannot be bound until every dependency is integrated`, 'DEPENDENCY_NOT_INTEGRATED');
    }
    const errors = validateImplementationTask(packet);
    if (errors.length) throw new StateError(`Invalid implementation task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
    const current = gitObservation(root, clock);
    assertExactCentralObservation(current, state, 'Task binding');
    const plan = readEffectivePlan(root, state); assertPacketPlanBinding(packet, plan, state, current.headSha);
    assertPacketMapperProvenance(root, state, packet);
    assertPacketSelectorsAtBase(root, packet);
    const authoritativePackets = state.execution.tasks
      .filter((entry) => entry.binding > 0 && entry.status !== 'rejected')
      .map((entry) => verifyReceipt(implementationTaskPacketPath(root, state.changeId, entry.id, entry.binding),
        `authoritative task packet ${entry.id}`).value);
    try { assertValidationCommandCompatibility([...authoritativePackets, packet], { featureDirectory: join(root, 'specs', 'features') }); }
    catch (error) { throw new StateError(error.message, 'VALIDATION_COMMAND_CONFLICT'); }
    assertStateVerifierCapacity(root, state, { packet });
    const packetDigest = implementationTaskDigest(packet); const binding = task.binding + 1;
    const next = revised(state, { phase: 'implementing', git: current,
      execution: replaceExecutionTask(state, task.id, { status: 'bound', binding, packetDigest, taskBaseSha: packet.taskBaseSha }) }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-bound',
      summary: `Bound immutable implementation packet for ${task.id}`, crashStep,
      pendingEvidence: [
        { key: 'taskPacketDigest', path: taskEvidencePath(task.id, binding), value: packet, label: `task packet ${task.id}` },
        { key: 'taskProvenanceDigest', path: `implementation/provenance/${task.id}/${String(binding).padStart(4, '0')}.json`, value: {
          changeId: packet.changeId, taskId: packet.taskId, planRevision: packet.planRevision, planDigest: packet.planDigest,
          planningSha: packet.planningSha, taskBaseSha: packet.taskBaseSha, decisionContext: packet.decisionContext,
          acceptanceCriteria: packet.acceptanceCriteria,
        }, label: `task provenance ${task.id}` },
        { key: 'taskPlanningSignalsDigest', path: `implementation/planning-signals/${task.id}/${String(binding).padStart(4, '0')}.json`, value: packet.planningSignals, label: `task planning signals ${task.id}` },
        { key: 'taskSpecialistRouteDigest', path: `implementation/specialist-routes/${task.id}/${String(binding).padStart(4, '0')}.json`, value: packet.specialistRoute, label: `task specialist route ${task.id}` },
        ...(packet.behaviorMapperEvidence === null ? [] : [{ key: 'taskBehaviorMapperDigest', path: `implementation/behavior-mapper/${task.id}/${String(binding).padStart(4, '0')}.json`, value: packet.behaviorMapperEvidence, label: `task behavior mapper ${task.id}` }]),
      ] });
  }, lockOptions);
}

function pathsOverlap(left, right) {
  const normalize = (path) => path.replace(/\/\*\*$/u, '');
  const a = normalize(left); const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function tasksConflict(left, right) {
  if (left.anticipatedPaths.some((a) => right.anticipatedPaths.some((b) => pathsOverlap(a, b)))) return true;
  if (left.produces.some((id) => right.consumes.includes(id) || right.produces.includes(id)) || right.produces.some((id) => left.consumes.includes(id))) return true;
  const sharedSurface = (task) => task.anticipatedPaths.some((path) => /^(?:(?:[^/]+\/)*package(?:-lock)?\.json$|\.agents(?:\/|$)|\.codex(?:\/|$)|\.github(?:\/|$)|packages\/shared\/src\/contracts\.ts$|apps\/api\/src\/schema\.ts$|apps\/api\/migrations(?:\/|$)|tests\/e2e\/fixtures(?:\/|$)|tests\/e2e\/(?:[^/]+\/)*[^/]+\.steps\.ts$)/u.test(path));
  if (sharedSurface(left) || sharedSurface(right)) return true;
  return false;
}

export function scheduleWave({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Wave scheduling'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'implementing' || state.execution.activeWave.length) throw new StateError('Scheduling requires implementing with no active wave', 'INVALID_PHASE');
    if (state.execution.tasks.some((task) => task.status === 'accepted')) {
      throw new StateError('Integrate every accepted result before scheduling another wave', 'TASK_STATE_CONFLICT');
    }
    const current = gitObservation(root, clock);
    assertExactCentralObservation(current, state, 'Wave scheduling');
    const complete = new Set(state.execution.tasks.filter((task) => ['integrated', 'no-change'].includes(task.status)).map(({ id }) => id));
    const dependencyReady = state.execution.tasks.filter((task) => task.status === 'bound' && task.dependsOn.every((id) => complete.has(id)));
    const stale = dependencyReady.find((task) => task.taskBaseSha !== current.headSha);
    if (stale) throw new StateError(`Task ${stale.id} packet base is not current central HEAD; stale immutable packets cannot be rebound`, 'TASK_BASE_STALE');
    const eligible = dependencyReady.filter((task) => task.taskBaseSha === current.headSha);
    const packets = new Map();
    const selectorOwners = new Map();
    for (const task of eligible) {
      const receipt = verifyReceipt(implementationTaskPacketPath(root, state.changeId, task.id, task.binding), `task packet ${task.id}`);
      if (validateImplementationTaskStructure(receipt.value).length > 0
          || receipt.digest !== task.packetDigest || implementationTaskDigest(receipt.value) !== task.packetDigest) {
        throw new StateError(`Task ${task.id} packet summary/receipt mismatch`, 'TASK_PACKET_MISMATCH');
      }
      assertPacketSelectorsAtBase(root, receipt.value);
      packets.set(task.id, receipt.value);
      for (const { selector } of receipt.value.plannedE2ESelectors ?? []) {
        if (!selectorOwners.has(selector)) selectorOwners.set(selector, task.id);
      }
    }
    const wave = [];
    for (const task of eligible) if (wave.length < 3
        && (packets.get(task.id).plannedE2ESelectors ?? []).every(({ selector }) => selectorOwners.get(selector) === task.id)
        && wave.every((other) => !tasksConflict(task, other))) {
      verifiedSchedulableWorktree(root, state, task);
      wave.push(task);
    }
    if (!wave.length) throw new StateError('No dependency-ready bound task can be scheduled', 'NO_READY_TASKS');
    const ids = wave.map(({ id }) => id);
    const execution = { ...state.execution, activeWave: ids,
      tasks: state.execution.tasks.map((task) => ids.includes(task.id) ? { ...task, status: 'scheduled' } : task) };
    const next = revised(state, { execution, git: current }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'wave-scheduled',
      summary: `Scheduled implementation wave: ${ids.join(', ')}`, crashStep });
  }, lockOptions);
}

export function startTask({ cwd = process.cwd(), changeId, taskId, workerId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Task start'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected }); const task = executionTask(state, taskId);
    if (task.status !== 'scheduled' || !state.execution.activeWave.includes(taskId)) throw new StateError(`Task ${taskId} is not scheduled`, 'TASK_STATE_CONFLICT');
    validateChangeId(workerId);
    const { manifest, manifestDigest, registration } = verifiedWorkerManifest(root, state, task);
    if (registration.headSha !== task.taskBaseSha) throw new StateError('Worker worktree must start exactly at the packet base', 'WORKTREE_HEAD_MISMATCH');
    const workerGit = gitObservation(manifest.path, clock);
    if (!workerGit.clean || workerGit.headSha !== task.taskBaseSha || workerGit.branch !== manifest.branch) {
      throw new StateError('Worker worktree must be exact, clean, and on its registered packet branch before start', 'WORKTREE_GIT_MISMATCH');
    }
    const next = revised(state, { execution: replaceExecutionTask(state, taskId, { status: 'running', attempt: task.attempt + 1,
      workerId, worktreePath: manifest.path, branch: manifest.branch, worktreeManifestDigest: manifestDigest }) }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-started', summary: `Started implementation task ${taskId}`, crashStep });
  }, lockOptions);
}

function nulChangedPaths(cwd, baseSha, commitSha) {
  const bytes = gitBuffer(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseSha, commitSha, '--'], { cwd });
  return bytes.toString('utf8').split('\0').filter(Boolean);
}

function rejectionEvidence(cwd, state, task, inFlight = null) {
  const evidence = inFlight?.taskId === task.id ? inFlight.rejection : null;
  let record = evidence;
  if (!record) {
    const directory = join(changeDirectory(cwd, state.changeId), 'implementation', 'rejections', task.id);
    const candidates = existsSync(directory)
      ? readdirSync(directory).filter((name) => /^\d{8}\.json$/u.test(name))
      : [];
    if (candidates.length !== 1) {
      throw new StateError(`Task ${task.id} must have exactly one receipt-backed rejection record`, 'TASK_REJECTION_MISMATCH');
    }
    record = verifyReceipt(join(directory, candidates[0]), `task rejection ${task.id}`).value;
  }
  if (record.schemaVersion !== 1 || record.changeId !== state.changeId || record.taskId !== task.id
      || record.binding !== task.binding || !nonemptyString(record.reason) || !nonemptyString(record.rejectedAt)) {
    throw new StateError(`Task ${task.id} rejection evidence does not match its execution summary`, 'TASK_REJECTION_MISMATCH');
  }
  return record;
}

const BLOCKER_CODE_POINT_LIMIT = 2000;
const BLOCKER_TRUNCATION_MARKER = '… [truncated; full evidence retained]';

function boundedTaskBlocker(prefix, prose) {
  const complete = `${prefix}${prose}`;
  const points = Array.from(complete);
  if (points.length <= BLOCKER_CODE_POINT_LIMIT) return complete;
  const marker = Array.from(BLOCKER_TRUNCATION_MARKER);
  return `${points.slice(0, BLOCKER_CODE_POINT_LIMIT - marker.length).join('')}${BLOCKER_TRUNCATION_MARKER}`;
}

function canonicalTaskBlockers(cwd, state, execution, inFlight = null) {
  return execution.tasks.flatMap((task) => {
    if (['blocked', 'failed'].includes(task.status)) {
      const result = inFlight?.taskId === task.id
        ? inFlight.result
        : verifyReceipt(join(changeDirectory(cwd, state.changeId), resultEvidencePath(task.id, task.attempt)), `implementation result ${task.id}`).value;
      if (objectDigest(result) !== task.resultDigest || result.taskId !== task.id || result.status !== task.status) {
        throw new StateError(`Task ${task.id} failure evidence does not match its execution summary`, 'TASK_RESULT_MISMATCH');
      }
      return [boundedTaskBlocker(`Task ${task.id} reported ${task.status}: `, result.summary)];
    }
    if (task.status === 'rejected') {
      const rejection = rejectionEvidence(cwd, state, task, inFlight);
      return [boundedTaskBlocker(`Task ${task.id} was explicitly rejected: `, rejection.reason)];
    }
    return [];
  });
}

function nonTaskBlockers(cwd, state) {
  const taskBlockers = new Map();
  for (const reason of canonicalTaskBlockers(cwd, state, state.execution)) {
    taskBlockers.set(reason, (taskBlockers.get(reason) ?? 0) + 1);
  }
  const preserved = [];
  for (const reason of state.blockedReasons) {
    const remaining = taskBlockers.get(reason) ?? 0;
    if (remaining > 0) taskBlockers.set(reason, remaining - 1);
    else preserved.push(reason);
  }
  if ([...taskBlockers.values()].some((remaining) => remaining !== 0)) {
    throw new StateError('Blocked state is missing receipt-backed task blocker evidence', 'TASK_RESULT_MISMATCH');
  }
  return preserved;
}

export function acceptResult({ cwd = process.cwd(), changeId, result, workerCwd, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Result acceptance'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    const shapeErrors = validateImplementationResult(result);
    if (shapeErrors.length) throw new StateError(`Invalid implementation result:\n- ${shapeErrors.join('\n- ')}`, 'INVALID_IMPLEMENTATION_RESULT');
    const task = executionTask(state, result.taskId);
    if (task.status !== 'running') throw new StateError(`Task ${task.id} is not running`, 'TASK_STATE_CONFLICT');
    const packetReceipt = verifyReceipt(implementationTaskPacketPath(root, state.changeId, task.id, task.binding), `task packet ${task.id}`);
    if (packetReceipt.digest !== task.packetDigest) throw new StateError('Task summary packet digest does not match canonical receipt', 'TASK_PACKET_MISMATCH');
    const packet = packetReceipt.value;
    if (!workerCwd || resolve(workerCwd) !== resolve(task.worktreePath) || gitCommonDirectory(workerCwd) !== gitCommonDirectory(root)) {
      throw new StateError('Result must come from the exact receipt-bound owned worktree', 'WORKTREE_IDENTITY_MISMATCH');
    }
    const manifest = verifiedWorkerManifest(root, state, task);
    if (manifest.manifestDigest !== task.worktreeManifestDigest || manifest.manifest.path !== task.worktreePath || manifest.manifest.branch !== task.branch) {
      throw new StateError('Task worker summary does not match the canonical worktree manifest', 'WORKTREE_MANIFEST_MISMATCH');
    }
    const workerGit = gitObservation(workerCwd, clock);
    if (!workerGit.clean || workerGit.branch !== task.branch) throw new StateError('Worker result requires its exact clean registered branch', 'WORKTREE_GIT_MISMATCH');
    let actualPaths;
    if (result.status === 'implemented') {
      const workerCommit = resolveCommit(workerCwd, result.workerCommit);
      if (workerGit.headSha !== workerCommit) throw new StateError('Worker worktree HEAD must equal the reported commit', 'WORKTREE_HEAD_MISMATCH');
      const parentRecord = gitText(['rev-list', '--parents', '-n', '1', workerCommit], { cwd: workerCwd }).split(/\s+/u);
      if (runGit(['merge-base', '--is-ancestor', task.taskBaseSha, workerCommit], { cwd: workerCwd, allowFailure: true }).status !== 0
          || Number(gitText(['rev-list', '--count', `${task.taskBaseSha}..${workerCommit}`], { cwd: workerCwd })) !== 1
          || parentRecord.length !== 2 || parentRecord[1] !== task.taskBaseSha) {
        throw new StateError('Worker result must name exactly one descendant commit of the packet base', 'WORKER_COMMIT_INVALID');
      }
      actualPaths = nulChangedPaths(workerCwd, task.taskBaseSha, workerCommit);
      assertPacketSelectorsAtBase(workerCwd, packet);
      assertPlannedSelectorsRealized(workerCwd, packet, workerCommit);
    } else {
      if (workerGit.headSha !== task.taskBaseSha) throw new StateError(`${result.status} result requires worker HEAD at the packet base`, 'WORKTREE_HEAD_MISMATCH');
      if (result.status === 'no-change' && result.unexpectedDependencies.length) throw new StateError('No-change cannot conceal unexpected dependencies; report blocked', 'INVALID_IMPLEMENTATION_RESULT');
    }
    const errors = validateImplementationResultAgainstTask(packet, result, actualPaths);
    if (errors.length) throw new StateError(`Implementation result does not match its packet/Git evidence:\n- ${errors.join('\n- ')}`, 'INVALID_IMPLEMENTATION_RESULT');
    assertStateVerifierCapacity(root, state, { result });
    const preservedBlockers = nonTaskBlockers(root, state);
    const terminal = result.status === 'implemented' ? 'accepted' : result.status;
    const activeWave = state.execution.activeWave.filter((id) => id !== task.id);
    const execution = replaceExecutionTask(state, task.id, { status: terminal, resultDigest: objectDigest(result), workerCommit: result.workerCommit }, { activeWave });
    const taskBlockers = canonicalTaskBlockers(root, state, execution, { taskId: task.id, result });
    const blockedReasons = [...preservedBlockers, ...taskBlockers];
    const nextPhase = blockedReasons.length ? 'blocked' : 'implementing';
    const next = revised(state, { phase: nextPhase, blockedReasons, execution }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'result-accepted', summary: `Accepted ${terminal} result for ${task.id}`, crashStep,
      pendingEvidence: [{ key: 'implementationResultDigest', path: resultEvidencePath(task.id, task.attempt), value: result, label: `implementation result ${task.id} attempt ${task.attempt}` }] });
  }, lockOptions);
}

function prepareIntegration({ root, selected, taskId, expectedRevision, clock, crashStep, lockOptions }) {
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Task integration'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (!['implementing', 'blocked'].includes(state.phase) || state.execution.activeWave.length) throw new StateError('Integration requires implementing or failed-wave blocked state with no active wave', 'INVALID_PHASE');
    const task = executionTask(state, taskId);
    if (task.status !== 'accepted' || !task.workerCommit) throw new StateError(`Task ${taskId} has no accepted worker commit`, 'TASK_STATE_CONFLICT');
    if (!task.dependsOn.every((id) => ['integrated', 'no-change'].includes(executionTask(state, id).status))) {
      throw new StateError(`Task ${taskId} dependencies are not integrated`, 'DEPENDENCY_NOT_INTEGRATED');
    }
    const taskBlockers = canonicalTaskBlockers(root, state, state.execution);
    if (state.phase === 'blocked' && serialized(taskBlockers) !== serialized(state.blockedReasons)) {
      throw new StateError('Integration from blocked state is limited to an accepted sibling of exact receipt-backed task blockers', 'INVALID_PHASE');
    }
    const current = gitObservation(root, clock);
    assertExactCentralObservation(current, state, 'Integration');
    const intent = { taskId, workerCommit: task.workerCommit, centralBaseSha: current.headSha };
    const execution = replaceExecutionTask(state, taskId, { status: 'integration-pending' }, { integrationIntent: intent });
    const next = revised(state, { phase: 'integrating', execution, git: current, blockedReasons: [] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'integration-intent',
      summary: `Persisted integration intent for ${taskId}`, crashStep });
  }, lockOptions);
}

function reconcileIntegrationLocked({ root, selected, expectedRevision, clock, crashStep, lockOptions }) {
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Integration reconciliation');
    if (expectedRevision !== undefined) assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'integrating' || !state.execution.integrationIntent) throw new StateError('No persisted integration intent exists', 'INTEGRATION_INTENT_MISSING');
    const intent = state.execution.integrationIntent; const current = gitObservation(root, clock);
    if (!current.clean) throw new StateError('Central checkout is dirty during integration reconciliation; inspect the cherry-pick before continuing', 'INTEGRATION_DIRTY');
    if (current.branch !== state.git.branch || current.branch === '(detached)') throw new StateError('Integration reconciliation requires the exact owning central branch', 'CENTRAL_GIT_MISMATCH');
    if (current.headSha === intent.centralBaseSha) throw new StateError('Persisted integration intent has not yet been applied', 'INTEGRATION_NOT_APPLIED');
    const parent = gitText(['rev-parse', `${current.headSha}^`], { cwd: root });
    const task = executionTask(state, intent.taskId);
    const workerDelta = gitBuffer(['diff', '--raw', '--no-renames', '-z', task.taskBaseSha, intent.workerCommit, '--'], { cwd: root });
    const integratedDelta = gitBuffer(['diff', '--raw', '--no-renames', '-z', intent.centralBaseSha, current.headSha, '--'], { cwd: root });
    if (parent !== intent.centralBaseSha || !workerDelta.equals(integratedDelta)) {
      throw new StateError('Central HEAD contains unrelated or non-equivalent work for the persisted integration intent', 'INTEGRATION_HEAD_MISMATCH');
    }
    const execution = replaceExecutionTask(state, task.id, { status: 'integrated', integratedCommit: current.headSha }, { integrationIntent: null });
    const taskBlockers = canonicalTaskBlockers(root, state, execution);
    const next = revised(state, { phase: taskBlockers.length ? 'blocked' : 'implementing', execution, git: current,
      blockedReasons: taskBlockers }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-integrated',
      summary: `Reconciled integrated task ${task.id} at ${current.headSha}`, crashStep });
  }, lockOptions);
}

export function reconcileIntegration({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withIntegrationOperationLock(root, selected, () => {
    const state = withChangeLock(root, selected, () => {
      const currentState = loadState(root, selected); assertWritableV2(currentState);
      assertImplementationMode(currentState, 'Integration reconciliation'); assertRevision(currentState, expectedRevision);
      validateState({ cwd: root, changeId: selected });
      return currentState;
    }, lockOptions);
    if (state.phase === 'integrating' && state.execution?.integrationIntent) {
      const current = gitObservation(root, clock); const intent = state.execution.integrationIntent;
      if (current.branch !== state.git.branch || current.branch === '(detached)') throw new StateError('Integration reconciliation requires the exact owning central branch', 'CENTRAL_GIT_MISMATCH');
      if (current.clean && current.headSha === intent.centralBaseSha) {
        callCrash(crashStep, 'integration-operation-before-reconcile-cherry-pick', { taskId: intent.taskId });
        const result = runGit(['cherry-pick', '--no-edit', intent.workerCommit], { cwd: root, allowFailure: true });
        if (result.status !== 0) throw new StateError('Cherry-pick did not complete; durable integration intent remains for inspection', 'INTEGRATION_CHERRY_PICK_FAILED');
      }
    }
    return reconcileIntegrationLocked({ root, selected, expectedRevision, clock, crashStep, lockOptions });
  }, lockOptions);
}

export function integrateTask({ cwd = process.cwd(), changeId, taskId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withIntegrationOperationLock(root, selected, () => {
    const intentState = prepareIntegration({ root, selected, taskId, expectedRevision, clock, crashStep, lockOptions });
    const intent = intentState.execution.integrationIntent;
    callCrash(crashStep, 'integration-operation-after-intent', { taskId: intent.taskId });
    assertExactCentralObservation(gitObservation(root, clock), intentState, 'Integration cherry-pick');
    const result = runGit(['cherry-pick', '--no-edit', intent.workerCommit], { cwd: root, allowFailure: true });
    if (result.status !== 0) {
      throw new StateError('Cherry-pick did not complete; durable integration intent remains for inspection and reconciliation', 'INTEGRATION_CHERRY_PICK_FAILED');
    }
    return reconcileIntegrationLocked({ root, selected, expectedRevision: intentState.revision, clock, crashStep, lockOptions });
  }, lockOptions);
}

export function finalizeIntegration({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Integration finalization'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'implementing' || state.execution.activeWave.length || state.execution.integrationIntent
        || !state.execution.tasks.every((task) => ['integrated', 'no-change'].includes(task.status))) {
      throw new StateError('Finalization requires every task terminal with no active wave or integration intent', 'IMPLEMENTATION_NOT_COMPLETE');
    }
    for (const task of state.execution.tasks) verifiedWorkerTombstone(root, state, task);
    const current = gitObservation(root, clock);
    assertExactCentralObservation(current, state, 'Integration finalization');
    const next = revised(state, { phase: 'integrated', git: current }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'implementation-finalized',
      summary: 'Finalized integrated implementation after every worker worktree was removed', crashStep });
  }, lockOptions);
}

function verificationRoundDirectory(cwd, state, round = state.verification?.round ?? 1) {
  return join(changeDirectory(cwd, state.changeId), 'verification', 'rounds', String(round).padStart(4, '0'));
}

function validationPlanPath(cwd, state, round) { return join(verificationRoundDirectory(cwd, state, round), 'validation-plan.json'); }
function specialistPlanPath(cwd, state) { return join(verificationRoundDirectory(cwd, state), 'specialist-plan.json'); }
function specialistResultPath(cwd, state, reviewerId) { return join(verificationRoundDirectory(cwd, state), 'specialists', `${reviewerId}.json`); }
function verifierResultPath(cwd, state) { return join(verificationRoundDirectory(cwd, state), 'verifier-result.json'); }

function nextVerificationRound(cwd, state) {
  const rounds = join(changeDirectory(cwd, state.changeId), 'verification', 'rounds');
  if (!existsSync(rounds)) return 1;
  const numbers = readdirSync(rounds).filter((name) => /^\d{4}$/u.test(name)).map(Number);
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

function repeatedFindingFingerprints(cwd, state, sourceKind, sourceRole, fingerprints) {
  if (state.verification.round < 2 || fingerprints.length === 0) return [];
  for (let round = state.verification.round - 1; round >= 1; round -= 1) {
    const previousDirectory = verificationRoundDirectory(cwd, state, round);
    const path = sourceKind === 'verifier' ? join(previousDirectory, 'verifier-result.json')
      : join(previousDirectory, 'specialists', `${sourceRole}.json`);
    if (!existsSync(path)) continue;
    const previous = verifyReceipt(path, `previous applicable round ${sourceRole} result`).value;
    const prior = new Set(previous.findings.map((finding) => findingFingerprint({ sourceKind, sourceRole, finding })));
    return fingerprints.filter((fingerprint) => prior.has(fingerprint));
  }
  return [];
}

function integrationReceiptForTask(cwd, state, task) {
  if (task.status === 'no-change') return { integrationReceipt: null, integrationReceiptDigest: null };
  const directories = readdirSync(join(changeDirectory(cwd, state.changeId), 'transitions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}$/u.test(entry.name)).map((entry) => entry.name).sort();
  const matches = [];
  for (const name of directories) {
    const directory = join(changeDirectory(cwd, state.changeId), 'transitions', name);
    const transition = verifyCompleteTransition(directory);
    if (transition.intent.type !== 'task-integrated') continue;
    const nextTask = transition.intent.nextState?.execution?.tasks?.find((entry) => entry.id === task.id);
    if (nextTask?.status !== 'integrated' || nextTask.integratedCommit !== task.integratedCommit) continue;
    const priorRevision = transition.intent.revision - 1;
    if (priorRevision < 0) continue;
    const priorDirectory = transitionDirectory(cwd, state.changeId, priorRevision);
    if (!existsSync(priorDirectory)) continue;
    const prior = verifyCompleteTransition(priorDirectory);
    const priorTask = prior.intent.nextState?.execution?.tasks?.find((entry) => entry.id === task.id);
    const integrationIntent = prior.intent.nextState?.execution?.integrationIntent;
    const exactPair = prior.intent.type === 'integration-intent'
      && transition.intent.previousStateDigest === prior.intent.nextStateDigest
      && priorTask?.status === 'integration-pending'
      && priorTask.integratedCommit === null
      && serialized(nextTask) === serialized({ ...priorTask, status: 'integrated', integratedCommit: task.integratedCommit })
      && serialized(nextTask) === serialized(task)
      && nextTask.workerCommit === priorTask.workerCommit
      && integrationIntent?.taskId === task.id
      && integrationIntent.workerCommit === nextTask.workerCommit
      && integrationIntent.centralBaseSha === prior.intent.nextState.git.headSha
      && transition.intent.nextState.execution.integrationIntent === null
      && transition.intent.nextState.git.headSha === task.integratedCommit;
    if (exactPair) matches.push({ integrationReceipt: transition.receipt,
      integrationReceiptDigest: objectDigest(transition.receipt) });
  }
  if (matches.length === 0) throw new StateError(`Integrated task ${task.id} has no exact receipt-valid integration intent/transition pair`, 'INTEGRATION_RECEIPT_MISSING');
  if (matches.length > 1) throw new StateError(`Integrated task ${task.id} has multiple receipt-valid integration intent/transition pairs`, 'INTEGRATION_RECEIPT_AMBIGUOUS');
  return matches[0];
}

function terminalTaskEvidenceForTask(cwd, state, task) {
  if (!['integrated', 'no-change'].includes(task.status) || task.binding < 1 || task.attempt < 1) {
    throw new StateError(`Task ${task.id} is not receipt-valid terminal validation input`, 'VALIDATION_TASK_SET_INVALID');
  }
  const packet = verifyReceipt(implementationTaskPacketPath(cwd, state.changeId, task.id, task.binding), `task packet ${task.id}`);
  const suffix = `${task.id}/${String(task.binding).padStart(4, '0')}.json`;
  const provenance = verifyReceipt(join(changeDirectory(cwd, state.changeId), 'implementation', 'provenance', suffix), `task provenance ${task.id}`);
  const result = verifyReceipt(join(changeDirectory(cwd, state.changeId), resultEvidencePath(task.id, task.attempt)), `task result ${task.id}`);
  if (packet.digest !== task.packetDigest || result.digest !== task.resultDigest) throw new StateError(`Task ${task.id} summary does not match immutable evidence`, 'VALIDATION_TASK_SET_INVALID');
  const integration = integrationReceiptForTask(cwd, state, task);
  return { packet: packet.value, packetDigest: packet.digest, provenance: provenance.value,
    provenanceDigest: provenance.digest, result: result.value, resultDigest: result.digest,
    binding: task.binding, terminalStatus: task.status, integratedCommit: task.integratedCommit, ...integration };
}

function terminalTaskEvidence(cwd, state) {
  return state.execution.tasks.map((task) => terminalTaskEvidenceForTask(cwd, state, task));
}

function assertVerificationHead(cwd, state, clock, operation) {
  const current = gitObservation(cwd, clock);
  if (!current.clean || current.branch !== state.git.branch || current.headSha !== state.git.headSha
      || (state.verification && current.headSha !== state.verification.headSha)) {
    throw new StateError(`${operation} requires the exact clean verification HEAD`, 'VERIFICATION_HEAD_MISMATCH');
  }
  return current;
}

export function mergeLifecycleValidationCommands(partials) {
  const commands = [];
  for (const candidate of partials.flatMap(({ commands: entries }) => entries)) {
    const existing = commands.find(({ argv }) => serialized(argv) === serialized(candidate.argv));
    if (!existing) { commands.push(structuredClone(candidate)); continue; }
    if (existing.kind !== candidate.kind || serialized(existing.selectors) !== serialized(candidate.selectors)
        || serialized(existing.projects) !== serialized(candidate.projects)) {
      throw new StateError(`Conflicting validation metadata for ${candidate.argv.join(' ')}`, 'VALIDATION_COMMAND_CONFLICT');
    }
    existing.reasons = [...new Set([...existing.reasons, ...candidate.reasons])];
    existing.taskIds = [...new Set([...existing.taskIds, ...candidate.taskIds])];
  }
  return commands;
}

function deriveLifecycleValidationPlan({ changeId, effectivePlanDigest, headSha, taskEvidence, createdAt, releaseEvidence }) {
  const groups = new Map();
  for (const evidence of taskEvidence) {
    const digest = evidence.packet.planDigest;
    groups.set(digest, [...(groups.get(digest) ?? []), evidence]);
  }
  const partials = [...groups].map(([boundPlanDigest, evidence]) => {
    const needsRelease = evidence.some(({ packet }) => packet.affectedAreas.some((area) => ['release', 'migration'].includes(area)));
    return deriveValidationPlan({ changeId, effectivePlanDigest: boundPlanDigest, headSha, taskEvidence: evidence,
      createdAt, releaseEvidence: needsRelease ? releaseEvidence : null });
  });
  if (partials.length === 1 && partials[0].effectivePlanDigest === effectivePlanDigest) return partials[0];
  const tasks = partials.flatMap(({ tasks: entries }) => entries);
  const commands = mergeLifecycleValidationCommands(partials);
  const plan = { schemaVersion: 1, changeId, effectivePlanDigest, headSha, createdAt,
    taskSetDigest: objectDigest(tasks), tasks, commands, releaseEvidence };
  const errors = validateVerificationContract('validationPlan', plan);
  if (errors.length) throw new StateError(`Aggregate validation plan is invalid: ${errors.join('; ')}`, 'VALIDATION_PLAN_INVALID');
  return plan;
}

export function createValidationPlan({ cwd = process.cwd(), changeId, expectedRevision, replace = false, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertImplementationMode(state, 'Validation planning'); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    const replaceable = state.phase === 'validating' && state.verification?.validationStatus === 'failed';
    if (replace && !replaceable) throw new StateError('Validation plan replacement is allowed only for an existing failed plan', 'INVALID_PHASE');
    if (state.phase !== 'integrated' && !(replace && replaceable)) throw new StateError('Validation planning requires integrated state or explicit failed-plan replacement', 'INVALID_PHASE');
    const current = assertVerificationHead(root, state, clock, 'Validation planning');
    const taskEvidence = terminalTaskEvidence(root, state);
    const affectedAreas = new Set(taskEvidence.flatMap(({ packet }) => packet.affectedAreas));
    const releaseEvidence = affectedAreas.has('release') || affectedAreas.has('migration')
      ? captureReleaseEvidence({ cwd: root, base: PROTECTED_RELEASE_REF, head: current.headSha, releaseRef: PROTECTED_RELEASE_REF }) : null;
    const round = nextVerificationRound(root, state);
    const plan = deriveLifecycleValidationPlan({ changeId: state.changeId, effectivePlanDigest: state.plan.effectiveDigest,
      headSha: current.headSha, taskEvidence, createdAt: now(clock), releaseEvidence });
    assertStateVerifierCapacity(root, state, { validationPlan: plan, verificationRound: round });
    const semanticDigest = validationPlanDigest(plan);
    const verification = { round, headSha: current.headSha, taskSetDigest: plan.taskSetDigest,
      validationPlanDigest: semanticDigest, validationStatus: 'pending', validationResultDigests: [], specialistPlanDigest: null,
      requiredReviewerIds: [], specialistResultDigests: [], contextDigest: null, verifierResultDigest: null,
      unresolvedFindingFingerprints: [], humanDecisionRequiredFingerprints: [], humanDecisionAuthorizations: [] };
    const next = revised(state, { phase: 'validating', verification, blockedReasons: [], git: current }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: replace ? 'validation-plan-replaced' : 'validation-planned',
      summary: `Persisted exact-HEAD validation plan round ${round}`, crashStep,
      pendingEvidence: [{ key: 'validationPlanReceiptDigest', path: relative(changeDirectory(root, state.changeId), validationPlanPath(root, state, round)), value: plan, label: `validation plan round ${round}` }] });
  }, lockOptions);
}

function existingCommandResults(cwd, state, plan) {
  const directory = join(verificationRoundDirectory(cwd, state), 'validation-results');
  const byId = new Map();
  if (!existsSync(directory)) return byId;
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const receipt = verifyReceipt(join(directory, name), `validation result ${name}`);
    const errors = validateVerificationContract('validationResult', receipt.value);
    if (errors.length || receipt.value.planDigest !== state.verification.validationPlanDigest || receipt.value.headSha !== plan.headSha) {
      throw new StateError(`Validation result ${name} is malformed or stale`, 'VALIDATION_RESULT_INVALID');
    }
    const command = plan.commands.find(({ id }) => id === receipt.value.commandId);
    const intent = command ? existingCommandIntent(cwd, state, command) : null;
    if (!command || !intent || serialized(receipt.value.argv) !== serialized(command.argv)
        || receipt.value.attempt !== intent.attempt || receipt.value.startedAt !== intent.startedAt) {
      throw new StateError(`Validation result ${name} does not match its immutable command intent`, 'VALIDATION_RESULT_INVALID');
    }
    if (byId.has(receipt.value.commandId)) throw new StateError(`Validation command ${receipt.value.commandId} has duplicate terminal results`, 'VALIDATION_RESULT_INVALID');
    byId.set(receipt.value.commandId, receipt);
  }
  return byId;
}

function existingCommandIntent(cwd, state, command) {
  const path = join(verificationRoundDirectory(cwd, state), 'validation-intents', `${command.id}.json`);
  if (!existsSync(path)) return null;
  const receipt = verifyReceipt(path, `validation intent ${command.id}`);
  const value = receipt.value;
  if (value.planDigest !== state.verification.validationPlanDigest || value.headSha !== state.verification.headSha
      || value.taskSetDigest !== state.verification.taskSetDigest || value.commandId !== command.id
      || serialized(value.argv) !== serialized(command.argv)) throw new StateError(`Validation intent ${command.id} is stale`, 'VALIDATION_INTENT_INVALID');
  return value;
}

function runValidationLocked({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions, runner = spawnSync } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  let state = withChangeLock(root, selected, () => {
    const current = loadState(root, selected); assertRevision(current, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (current.phase !== 'validating' || current.verification.validationStatus === 'failed') throw new StateError('Validation execution requires a pending validation plan', 'INVALID_PHASE');
    assertVerificationHead(root, current, clock, 'Validation execution'); return current;
  }, lockOptions);
  const plan = verifyReceipt(validationPlanPath(root, state), 'validation plan').value;
  if (validationPlanDigest(plan) !== state.verification.validationPlanDigest || plan.taskSetDigest !== state.verification.taskSetDigest) throw new StateError('Validation plan identity is stale', 'VALIDATION_PLAN_STALE');
  let results = existingCommandResults(root, state, plan);
  for (const command of plan.commands) {
    if (results.has(command.id)) continue;
    let intent = existingCommandIntent(root, state, command);
    if (!intent) {
      intent = { schemaVersion: 1, planDigest: state.verification.validationPlanDigest, headSha: plan.headSha,
        taskSetDigest: plan.taskSetDigest, commandId: command.id, argv: command.argv, attempt: 1, startedAt: now(clock) };
      state = withChangeLock(root, selected, () => {
        const current = loadState(root, selected); assertVerificationHead(root, current, clock, 'Validation command intent');
        if (current.verification.validationPlanDigest !== intent.planDigest || current.verification.taskSetDigest !== intent.taskSetDigest) throw new StateError('Validation inputs changed before execution', 'VALIDATION_PLAN_STALE');
        const next = revised(current, {}, clock);
        return commitTransition({ cwd: root, previousState: current, nextState: next, type: 'validation-command-intent', summary: `Persisted validation intent ${command.id}`, crashStep,
          pendingEvidence: [{ key: 'validationCommandIntentDigest', path: `verification/rounds/${String(current.verification.round).padStart(4, '0')}/validation-intents/${command.id}.json`, value: intent, label: `validation command intent ${command.id}` }] });
      }, lockOptions);
    }
    const intentRevision = state.revision;
    const executed = runner(command.argv[0], command.argv.slice(1), { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const completedAt = now(clock); const startedAt = intent.startedAt;
    const status = executed.status === 0 && !executed.signal && !executed.error ? 'passed' : 'failed';
    const output = `${executed.stdout ?? ''}${executed.stderr ?? ''}${executed.error?.message ?? ''}`;
    const outputDigest = objectDigest(output);
    const result = { schemaVersion: 1, planDigest: state.verification.validationPlanDigest, headSha: plan.headSha,
      commandId: command.id, argv: command.argv, attempt: 1, status, startedAt, completedAt,
      exitCode: Number.isInteger(executed.status) ? executed.status : null, signal: executed.signal ?? null,
      summary: status === 'passed' ? 'Passed.' : `Failed with exit ${executed.status ?? 'none'} and signal ${executed.signal ?? 'none'}; output ${outputDigest}.`,
      outputDigest };
    state = withChangeLock(root, selected, () => {
      const current = loadState(root, selected); assertRevision(current, intentRevision); assertVerificationHead(root, current, clock, 'Validation result recording');
      const errors = validateVerificationContract('validationResult', result);
      if (errors.length) throw new StateError(`Invalid validation result: ${errors.join('; ')}`, 'VALIDATION_RESULT_INVALID');
      assertStateVerifierCapacity(root, current, { validationResult: result });
      const digests = [...current.verification.validationResultDigests, objectDigest(result)];
      const verification = { ...current.verification, validationStatus: status === 'failed' ? 'failed' : current.verification.validationStatus,
        validationResultDigests: digests };
      const next = revised(current, { phase: status === 'failed' ? 'validating' : current.phase, verification,
        blockedReasons: [] }, clock);
      return commitTransition({ cwd: root, previousState: current, nextState: next, type: 'validation-command-result', summary: `Recorded ${status} validation result ${command.id}`, crashStep,
        pendingEvidence: [{ key: 'validationCommandResultDigest', path: `verification/rounds/${String(current.verification.round).padStart(4, '0')}/validation-results/${command.id}.json`, value: result, label: `validation command result ${command.id}` }] });
    }, lockOptions);
    if (status === 'failed') return state;
    results = existingCommandResults(root, state, plan);
  }
  const completionRevision = state.revision;
  return withChangeLock(root, selected, () => {
    const current = loadState(root, selected); assertRevision(current, completionRevision);
    if (current.phase !== 'validating' || current.verification.validationStatus !== 'pending') throw new StateError('Validation completion requires the same pending validation phase', 'INVALID_PHASE');
    assertVerificationHead(root, current, clock, 'Validation completion');
    const complete = existingCommandResults(root, current, plan);
    if (plan.commands.some(({ id }) => complete.get(id)?.value.status !== 'passed')) throw new StateError('Validation result set is incomplete', 'VALIDATION_RESULT_INCOMPLETE');
    const verification = { ...current.verification, validationStatus: 'passed' };
    const next = revised(current, { phase: 'specialist-review', verification, blockedReasons: [] }, clock);
    return commitTransition({ cwd: root, previousState: current, nextState: next, type: 'validation-completed', summary: 'Completed exact-HEAD targeted validation', crashStep });
  }, lockOptions);
}

export function runValidation(options = {}) {
  const root = repositoryRoot(options.cwd ?? process.cwd()); const selected = selectedChangeId(root, options.changeId);
  return withIntegrationOperationLock(root, selected,
    () => runValidationLocked({ ...options, cwd: root, changeId: selected }), options.lockOptions);
}

function routedReviewPlan(cwd, state) {
  const reviewerOrder = ['security_reviewer', 'offline_realtime_reviewer'];
  const reviewerReasons = new Map(); const planningHelpers = new Map(); const supplemental = new Map();
  const routeReceiptDigests = []; let finalVerificationPriority = 'standard';
  for (const task of state.execution.tasks) {
    const path = join(changeDirectory(cwd, state.changeId), 'implementation', 'specialist-routes', task.id,
      `${String(task.binding).padStart(4, '0')}.json`);
    const route = verifyReceipt(path, `stored specialist route ${task.id}`);
    routeReceiptDigests.push(route.digest);
    if (route.value.finalVerificationPriority === 'high') finalVerificationPriority = 'high';
    for (const entry of route.value.planningHelpers) planningHelpers.set(entry.id,
      [...new Set([...(planningHelpers.get(entry.id) ?? []), ...entry.reasons])]);
    for (const id of requiredSpecialistIds(route.value, { phase: 'review' })) {
      const entry = route.value.riskReviewers.find((candidate) => candidate.id === id);
      reviewerReasons.set(id, [...new Set([...(reviewerReasons.get(id) ?? []), ...entry.reasons])]);
    }
    for (const entry of route.value.supplementalGuidance) supplemental.set(entry.id,
      [...new Set([...(supplemental.get(entry.id) ?? []), ...entry.reasons])]);
  }
  return { schemaVersion: 1, headSha: state.verification.headSha,
    validationPlanDigest: state.verification.validationPlanDigest,
    finalVerificationPriority, routeReceiptDigests,
    planningHelpers: [...planningHelpers].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, reasons]) => ({ id, reasons })),
    reviewers: reviewerOrder.filter((id) => reviewerReasons.has(id)).map((id) => ({ id, reasons: reviewerReasons.get(id) })),
    supplementalGuidance: [...supplemental].sort(([left], [right]) => left.localeCompare(right)).map(([id, reasons]) => ({ id, reasons })) };
}

export function createSpecialistPlan({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'specialist-review' || state.verification.validationStatus !== 'passed' || state.verification.specialistPlanDigest) throw new StateError('Specialist planning requires completed validation and no existing plan', 'INVALID_PHASE');
    assertVerificationHead(root, state, clock, 'Specialist planning');
    const plan = routedReviewPlan(root, state); const digest = objectDigest(plan);
    assertStateVerifierCapacity(root, state, { specialistPlan: plan });
    const verification = { ...state.verification, specialistPlanDigest: digest,
      requiredReviewerIds: plan.reviewers.map(({ id }) => id) };
    const nextPhase = plan.reviewers.length ? 'specialist-review' : 'verifying';
    const next = revised(state, { phase: nextPhase, verification }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'specialist-planned',
      summary: plan.reviewers.length ? `Routed ${plan.reviewers.length} exact-HEAD specialist reviewer(s)` : 'No reusable risk reviewer was routed', crashStep,
      pendingEvidence: [{ key: 'specialistPlanDigest', path: relative(changeDirectory(root, state.changeId), specialistPlanPath(root, state)), value: plan, label: 'specialist review plan' }] });
  }, lockOptions);
}

function assertSpecialistFingerprintCapacity(cwd, state, result, fingerprints) {
  const existing = new Set(state.verification.unresolvedFindingFingerprints);
  const newFingerprints = [...new Set(fingerprints)].filter((fingerprint) => !existing.has(fingerprint));
  const remainingReviewers = state.verification.requiredReviewerIds
    .filter((id) => !existsSync(specialistResultPath(cwd, state, id))).length;
  const available = SPECIALIST_FINDING_LIMIT - existing.size;
  const reservedShare = remainingReviewers > 0 ? Math.floor(available / remainingReviewers) : 0;
  if (newFingerprints.length > reservedShare) {
    throw new StateError(
      `Specialist ${result.reviewerId} contributes ${newFingerprints.length} distinct finding fingerprint(s); `
        + `${reservedShare} fit while reserving the remaining ${available} slot(s) across ${remainingReviewers} unrecorded reviewer(s)`,
      'SPECIALIST_FINDING_CAPACITY_EXCEEDED',
    );
  }
}

export function recordSpecialistResult({ cwd = process.cwd(), changeId, expectedRevision, result, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'specialist-review' || !state.verification.specialistPlanDigest) throw new StateError('Specialist result requires an active specialist plan', 'INVALID_PHASE');
    assertVerificationHead(root, state, clock, 'Specialist result');
    const errors = validateVerificationContract('specialistResult', result);
    if (errors.length || result.headSha !== state.verification.headSha || result.specialistPlanDigest !== state.verification.specialistPlanDigest
        || !state.verification.requiredReviewerIds.includes(result.reviewerId)) throw new StateError(`Specialist result is malformed, stale, or unrouted: ${errors.join('; ')}`, 'SPECIALIST_RESULT_INVALID');
    for (const task of state.execution.tasks) {
      const route = verifyReceipt(join(changeDirectory(root, state.changeId), 'implementation', 'specialist-routes', task.id,
        `${String(task.binding).padStart(4, '0')}.json`), `stored specialist route ${task.id}`).value;
      if (!requiredSpecialistIds(route, { phase: 'review' }).includes(result.reviewerId)) continue;
      const projectionRoute = { ...route, riskReviewers: route.riskReviewers.filter(({ id }) => id === result.reviewerId) };
      const reusableErrors = validateSpecialistEvidence({ evidence: [{ reviewerId: result.reviewerId, headSha: result.headSha,
        status: result.status, summary: result.summary }], route: projectionRoute, subjectSha: state.verification.headSha, phase: 'review' });
      if (reusableErrors.length) throw new StateError(`Specialist result violates reusable review evidence: ${reusableErrors.join('; ')}`, 'SPECIALIST_RESULT_INVALID');
    }
    const path = specialistResultPath(root, state, result.reviewerId);
    if (existsSync(path)) throw new StateError(`Specialist ${result.reviewerId} already has immutable evidence`, 'SPECIALIST_RESULT_DUPLICATE');
    const firstMissing = state.verification.requiredReviewerIds.find((id) => !existsSync(specialistResultPath(root, state, id)));
    if (result.reviewerId !== firstMissing) throw new StateError(`Specialist results must be recorded in canonical reviewer order; next is ${firstMissing}`, 'SPECIALIST_RESULT_ORDER');
    const digest = objectDigest(result);
    const specialistResultDigests = state.verification.requiredReviewerIds.slice(0,
      state.verification.specialistResultDigests.length + 1).map((id) => id === result.reviewerId
      ? digest : verifyReceipt(specialistResultPath(root, state, id), `specialist result ${id}`).digest);
    const fingerprints = result.findings.map((finding) => findingFingerprint({ sourceKind: 'specialist', sourceRole: result.reviewerId, finding }));
    const repeated = repeatedFindingFingerprints(root, state, 'specialist', result.reviewerId, fingerprints);
    assertSpecialistFingerprintCapacity(root, state, result, fingerprints);
    const capacityPending = { specialistResult: result,
      authorizationRequiredFingerprints: [...new Set([
        ...state.verification.humanDecisionRequiredFingerprints, ...repeated,
      ])] };
    assertStateVerifierCapacity(root, state, capacityPending);
    const allRecorded = specialistResultDigests.length === state.verification.requiredReviewerIds.length;
    const verification = { ...state.verification, specialistResultDigests,
      unresolvedFindingFingerprints: [...new Set([...state.verification.unresolvedFindingFingerprints, ...fingerprints])],
      humanDecisionRequiredFingerprints: [...new Set([...state.verification.humanDecisionRequiredFingerprints, ...repeated])] };
    const next = revised(state, { phase: allRecorded ? (verification.unresolvedFindingFingerprints.length ? 'blocked' : 'verifying') : 'specialist-review', verification,
      blockedReasons: allRecorded && verification.unresolvedFindingFingerprints.length ? [repeated.length
        ? `Human decision required: ${result.reviewerId} repeated ${repeated.length} semantic finding(s) in consecutive applicable rounds.`
        : 'Routed specialist review reported actionable findings.'] : [] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'specialist-result-recorded', summary: `Recorded ${result.status} result from ${result.reviewerId}`, crashStep,
      pendingEvidence: [{ key: 'specialistResultDigest', path: relative(changeDirectory(root, state.changeId), path), value: result, label: `specialist result ${result.reviewerId}` }] });
  }, lockOptions);
}

const VERIFIER_EVIDENCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FINDING_AUTHORIZATION_REASON_MAX_BYTES = 1024;
const FINDING_AUTHORIZATION_ACTOR_MAX_BYTES = 256;
const PROJECTED_GIT_SHA = 'f'.repeat(64);
const PROJECTED_INTEGRATION_REVISION = Number.MAX_SAFE_INTEGER;
const PROJECTED_VALIDATION_EXIT_CODE = Number.MIN_SAFE_INTEGER;
const PROJECTED_OUTPUT_DIGEST = `sha256:${'f'.repeat(64)}`;
const PROJECTED_RELEASE_VERSION_COMPONENT = '9'.repeat(128);
const PROJECTED_RELEASE_TAG = `v${PROJECTED_RELEASE_VERSION_COMPONENT}.${PROJECTED_RELEASE_VERSION_COMPONENT}.${PROJECTED_RELEASE_VERSION_COMPONENT}`;
const REMEDIATION_RESERVATION_SUMMARY_BYTES = 1800;
const SPECIALIST_FINDING_LIMIT = 100;
const IMPLEMENTATION_PLAN_TEXT_MAX_CODE_POINTS = 4000;

function authorizationReservationSummary() {
  return `Human authorization by ${'\u0000'.repeat(FINDING_AUTHORIZATION_ACTOR_MAX_BYTES)}: ${'\u0000'.repeat(FINDING_AUTHORIZATION_REASON_MAX_BYTES)}`;
}

function splitSemanticEvidence(source, maximumBytes) {
  const chunks = []; let chunk = ''; let chunkBytes = 0;
  for (const point of source) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (chunkBytes + pointBytes > maximumBytes) { chunks.push(chunk); chunk = point; chunkBytes = pointBytes; }
    else { chunk += point; chunkBytes += pointBytes; }
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function normalizedEvidenceId(item, { normalized, part, count }) {
  const suffix = count > 1 ? `-part-${part}` : '';
  if (!normalized) return `${item.id}${suffix}`;
  const hash = objectDigest({ kind: item.kind, id: item.id, digest: item.digest }).slice(7, 31);
  const available = 128 - hash.length - suffix.length - 1;
  const readable = String(item.id).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'evidence';
  const prefix = readable.slice(0, available).replace(/-+$/gu, '') || 'evidence'.slice(0, available);
  return `${prefix}-${hash}${suffix}`;
}

function semanticEvidenceChunks(item, maximumBytes = 1800) {
  const originalSummary = String(item.summary); let chunks = splitSemanticEvidence(originalSummary, maximumBytes);
  const longestSuffix = chunks.length > 1 ? `-part-${chunks.length}` : '';
  const normalized = !VERIFIER_EVIDENCE_ID.test(String(item.id)) || String(item.id).length + longestSuffix.length > 128;
  if (normalized) chunks = splitSemanticEvidence(`Evidence identity: ${item.id}\n${originalSummary}`, maximumBytes);
  return chunks.map((summary, index) => ({ ...item,
    id: normalizedEvidenceId(item, { normalized, part: index + 1, count: chunks.length }), summary }));
}

export function boundVerifierEvidence(items, maximum = 500) {
  const normalized = items.flatMap((item) => semanticEvidenceChunks(item));
  if (normalized.length > maximum) throw new StateError(`Complete verifier evidence requires ${normalized.length} items; maximum is ${maximum}`, 'VERIFIER_CONTEXT_TOO_LARGE');
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 256 * 1024) throw new StateError('Complete verifier evidence exceeds 256 KiB', 'VERIFIER_CONTEXT_TOO_LARGE');
  return normalized;
}

function verifierCapacityAmendments(cwd, state, pending = null) {
  const amendments = [];
  for (let number = 1; number <= (state.plan?.amendmentCount ?? 0); number += 1) {
    const stem = join(changeDirectory(cwd, state.changeId), 'plan', 'amendments', String(number).padStart(4, '0'));
    amendments.push({ number, record: verifyReceipt(`${stem}.json`, `plan amendment ${number}`),
      planningEvidence: verifyReceipt(`${stem}.evidence.json`, `plan amendment ${number} evidence`) });
  }
  if (pending) amendments.push({ number: amendments.length + 1,
    record: { value: pending.record, digest: objectDigest(pending.record) },
    planningEvidence: { value: pending.planningEvidence, digest: objectDigest(pending.planningEvidence) } });
  return amendments;
}

function verifierCapacityResults(cwd, state, pending = null) {
  const results = state.execution?.tasks.filter((task) => task.resultDigest).map((task) => {
    const receipt = verifyReceipt(join(changeDirectory(cwd, state.changeId), resultEvidencePath(task.id, task.attempt)),
      `implementation result ${task.id}`);
    return { taskId: task.id, value: receipt.value, digest: receipt.digest };
  }) ?? [];
  if (pending) {
    const index = results.findIndex(({ taskId }) => taskId === pending.taskId);
    const entry = { taskId: pending.taskId, value: pending, digest: objectDigest(pending) };
    if (index >= 0) results[index] = entry; else results.push(entry);
  }
  return results;
}

function projectedSpecialistPlan(effectivePlan, packetByTask, headSha, validationPlanDigestValue) {
  const reviewerOrder = ['security_reviewer', 'offline_realtime_reviewer'];
  const reviewerReasons = new Map(); const planningHelpers = new Map(); const supplemental = new Map();
  let finalVerificationPriority = 'standard';
  for (const task of effectivePlan.tasks) {
    const route = packetByTask.get(task.id)?.specialistRoute ?? task.specialization.route;
    if (route.finalVerificationPriority === 'high') finalVerificationPriority = 'high';
    route.planningHelpers.forEach((entry) => planningHelpers.set(entry.id,
      [...new Set([...(planningHelpers.get(entry.id) ?? []), ...entry.reasons])]));
    for (const id of requiredSpecialistIds(route, { phase: 'review' })) {
      const entry = route.riskReviewers.find((candidate) => candidate.id === id);
      reviewerReasons.set(id, [...new Set([...(reviewerReasons.get(id) ?? []), ...entry.reasons])]);
    }
    route.supplementalGuidance.forEach((entry) => supplemental.set(entry.id,
      [...new Set([...(supplemental.get(entry.id) ?? []), ...entry.reasons])]));
  }
  return { schemaVersion: 1, headSha, validationPlanDigest: validationPlanDigestValue,
    finalVerificationPriority, routeReceiptDigests: [],
    planningHelpers: [...planningHelpers].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, reasons]) => ({ id, reasons })),
    reviewers: reviewerOrder.filter((id) => reviewerReasons.has(id)).map((id) => ({ id, reasons: reviewerReasons.get(id) })),
    supplementalGuidance: [...supplemental].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, reasons]) => ({ id, reasons })) };
}

function minimumProjectedValidation(task) {
  const command = task.specialization.affectedAreas
    .flatMap((area) => affectedAreaCommands.get(area) ?? [])[0] ?? 'npm run check:workflow';
  return { unit: [{ command, reason: 'Schema-minimal targeted validation authority.' }], system: [] };
}

function minimumProjectedPacket(task, effectivePlan, effectivePlanDigest, behaviorMapperEvidence) {
  return {
    taskId: task.id, planRevision: effectivePlan.planRevision, planDigest: effectivePlanDigest,
    specialization: task.specialization.specialization,
    affectedAreas: task.specialization.affectedAreas, riskTags: task.specialization.riskTags,
    planningSignals: { browserVisible: task.specialization.browserVisible,
      relatedTestSelectionUncertain: task.specialization.relatedTestSelectionUncertain },
    specialistRoute: task.specialization.route, behaviorMapperEvidence,
    objective: task.objective, decisionIds: task.decisionIds,
    acceptanceCriteriaIds: task.criterionIds, allowedPaths: [task.anticipatedPaths[0]], forbiddenPaths: [],
    dependencies: task.dependsOn, requiredValidation: minimumProjectedValidation(task),
  };
}

function projectedChangedPath(packet) {
  for (const ownership of packet.allowedPaths) {
    const base = ownership.replace(/\/\*\*$/u, '');
    const candidate = ownership.endsWith('/**') ? `${base}/result` : base;
    if (!packet.forbiddenPaths.some((pattern) => pathMatchesOwnership(candidate, pattern))) return candidate;
  }
  return packet.allowedPaths[0].replace(/\/\*\*$/u, '');
}

function minimumProjectedResult(packet) {
  return {
    status: 'implemented', summary: 'x', changedPaths: [projectedChangedPath(packet)],
    validation: [...packet.requiredValidation.unit, ...packet.requiredValidation.system]
      .map(({ command }) => ({ command, result: 'passed' })),
    unexpectedDependencies: [],
  };
}

function projectedTaskRecords(effectivePlan, packets, results, planningEvidence) {
  const packetByTask = new Map(packets.map((packet) => [packet.taskId, packet]));
  const resultByTask = new Map(results.map((entry) => [entry.taskId, entry]));
  const effectivePlanDigest = objectDigest(effectivePlan);
  return effectivePlan.tasks.map((task) => {
    const packet = packetByTask.get(task.id) ?? null;
    const resultRecord = resultByTask.get(task.id) ?? null;
    const result = resultRecord?.value ?? resultRecord;
    const mapper = packet?.behaviorMapperEvidence
      ?? (task.specialization.route.planningHelpers.some(({ id }) => id === 'behavior_mapper')
        ? planningEvidence.find((entry) => entry.reviewerId === 'behavior_mapper'
          && entry.planRevision === effectivePlan.planRevision) ?? null : null);
    const authorityPacket = packet ?? minimumProjectedPacket(task, effectivePlan, effectivePlanDigest, mapper);
    return { task, packet, packetDigest: objectDigest(packet ?? task),
      provenanceDigest: objectDigest({ decisionIds: task.decisionIds, criterionIds: task.criterionIds }),
      result, resultDigest: resultRecord?.digest
        ?? objectDigest(result ?? { taskId: task.id, status: 'projected-terminal' }),
      authorityPacket, projectedResult: result ?? minimumProjectedResult(authorityPacket),
      requiresReplacement: ['blocked', 'failed'].includes(result?.status),
      reservesTaskReplacement: packet !== null,
      terminalStatus: result?.status === 'no-change' ? 'no-change' : 'integrated', integratedCommit: null,
      integrationReceipt: null, integrationReceiptDigest: objectDigest({ taskId: task.id, status: 'projected-integration' }),
      binding: packet ? 1 : 1, behaviorMapperEvidence: mapper };
  });
}

function dispositionAuthorityProjection(value) {
  return { sourceKind: value.sourceKind, sourceRole: value.sourceRole,
    findingId: value.findingId, fingerprint: value.fingerprint,
    disposition: value.disposition, reason: value.reason, amendmentId: value.amendmentId,
    replacementCriterionId: value.replacementCriterionId,
    replacementTaskId: value.replacementTaskId };
}

function dispositionAuthoritySummary(value) {
  return `Finding disposition authority:\n${serialized(dispositionAuthorityProjection(value))}`;
}

function minimumDispositionAuthority({ sourceKind, sourceRole, findingId, fingerprint }) {
  const maximumId = 'x'.repeat(128);
  return { sourceKind, sourceRole, findingId, fingerprint, disposition: 'actionable', reason: 'x',
    amendmentId: maximumId, replacementCriterionId: maximumId, replacementTaskId: maximumId };
}

function remediationReservationSummary(label) {
  const prefix = `Reserved schema-minimal viable remediation authority for ${label}.`;
  return `${prefix}${'x'.repeat(Math.max(0,
    REMEDIATION_RESERVATION_SUMMARY_BYTES - Buffer.byteLength(prefix, 'utf8')))}`;
}

function derivedRemediationId(seed, suffix) {
  const candidate = `${seed}-${suffix}`;
  if (candidate.length <= 128) return candidate;
  const digest = objectDigest({ seed, suffix }).slice('sha256:'.length, 'sha256:'.length + 24);
  const prefix = seed.slice(0, 128 - suffix.length - digest.length - 2).replace(/-+$/u, '');
  return `${prefix}-${digest}-${suffix}`;
}

function viableRemediationEvidence({ authority, seed, amendmentId, criterionId, taskId,
  checklistEvidence = [], invalidatedEvidence = [] }) {
  const identities = [
    ['criterion', criterionId],
    ['packet', taskId],
    ['packet', `${taskId}-ownership`],
    ['packet', `${taskId}-profile`],
    ['packet', `${taskId}-validation`],
    ['provenance', `${taskId}-provenance`],
    ['planning-helper', `${taskId}-behavior-mapper`],
    ['result', `${taskId}-result`],
    ['result', `${taskId}-result-validation`],
    ['result', `${taskId}-result-dependencies`],
    ['result', `${taskId}-path-authority`],
    ['integration', `${taskId}-integration`],
    ['amendment', amendmentId],
    ['provenance', `${amendmentId}-provenance`],
    ['provenance', `${amendmentId}-provenance-record-1`],
  ];
  return [...checklistEvidence, ...identities.map(([kind, id]) => ({ kind, id,
    digest: objectDigest({ authority, seed, kind, id }),
    summary: remediationReservationSummary(`${seed}:${id}${kind === 'amendment'
      ? `:invalidated-evidence:${invalidatedEvidence.join(',') || 'none'}` : ''}`) }))];
}

function actionableRemediationReservations(findingRecords, amendments) {
  const exactAmendmentIds = new Set(amendments.map(({ record }) => record.value.amendmentId));
  const groups = new Map();
  for (const record of findingRecords) {
    const disposition = record.disposition?.value;
    if (disposition?.disposition !== 'actionable' || exactAmendmentIds.has(disposition.amendmentId)) continue;
    groups.set(disposition.amendmentId, [...(groups.get(disposition.amendmentId) ?? []), disposition]);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([amendmentId, dispositions]) => ({
    amendmentId, dispositions: dispositions.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
  }));
}

function actionableRemediationEvidence(findingRecords, amendments) {
  const evidence = [];
  for (const { amendmentId, dispositions } of actionableRemediationReservations(findingRecords, amendments)) {
    for (const disposition of dispositions) {
      const identities = [
        ['criterion', disposition.replacementCriterionId],
        ['packet', disposition.replacementTaskId],
        ['packet', `${disposition.replacementTaskId}-ownership`],
        ['packet', `${disposition.replacementTaskId}-profile`],
        ['packet', `${disposition.replacementTaskId}-validation`],
        ['provenance', `${disposition.replacementTaskId}-provenance`],
        ['planning-helper', `${disposition.replacementTaskId}-behavior-mapper`],
        ['result', `${disposition.replacementTaskId}-result`],
        ['result', `${disposition.replacementTaskId}-result-validation`],
        ['result', `${disposition.replacementTaskId}-result-dependencies`],
        ['result', `${disposition.replacementTaskId}-path-authority`],
        ['integration', `${disposition.replacementTaskId}-integration`],
      ];
      for (const [kind, id] of identities) evidence.push({ kind, id,
        digest: objectDigest({ authority: 'viable-finding-remediation', amendmentId,
          fingerprint: disposition.fingerprint, kind, id }),
        summary: remediationReservationSummary(`${amendmentId}:${id}`) });
    }
    for (const [kind, id] of [['amendment', amendmentId], ['provenance', `${amendmentId}-provenance`],
      ['provenance', `${amendmentId}-provenance-record-1`]]) evidence.push({ kind, id,
      digest: objectDigest({ authority: 'viable-finding-remediation', amendmentId, kind, id }),
      summary: remediationReservationSummary(`${amendmentId}:${id}`) });
  }
  return evidence;
}

function taskReplacementEvidence(record) {
  const taskId = record.task.id;
  const replacementTaskId = derivedRemediationId(taskId, 'replacement-task');
  const amendmentId = derivedRemediationId(taskId, 'replacement-amendment');
  const criterionId = derivedRemediationId(taskId, 'replacement-criterion');
  const suffix = `${taskId}/${String(record.binding).padStart(4, '0')}.json`;
  const invalidatedEvidence = [
    `implementation/tasks/${suffix}`,
    `implementation/provenance/${suffix}`,
    `implementation/planning-signals/${suffix}`,
    `implementation/specialist-routes/${suffix}`,
  ];
  if ((record.packet ?? record.authorityPacket)?.behaviorMapperEvidence !== null) {
    invalidatedEvidence.push(`implementation/behavior-mapper/${suffix}`);
  }
  if (record.result) invalidatedEvidence.push(
    `implementation/results/${taskId}/${String(record.attempt ?? 1).padStart(4, '0')}.json`);
  return viableRemediationEvidence({ authority: 'viable-task-replacement', seed: taskId,
    amendmentId, criterionId, taskId: replacementTaskId, invalidatedEvidence });
}

function sourceDecisionAmendmentEvidence(decision, effectivePlan, sourceObservation) {
  const amendmentId = derivedRemediationId(decision.id, 'source-amendment');
  const criterionId = derivedRemediationId(decision.id, 'source-criterion');
  const taskId = derivedRemediationId(decision.id, 'source-task');
  const mapped = new Map(effectivePlan.checklistMappings.map((entry) => [entry.id, entry]));
  const checklistEvidence = (sourceObservation.source?.checklist ?? []).map((item) => {
    const binding = sourceChecklistBinding(item);
    const prior = mapped.get(binding.id);
    const entry = { ...binding,
      criterionIds: prior?.criterionIds ?? [criterionId],
      taskIds: prior?.taskIds ?? [taskId],
      relationship: effectivePlan.source.relationship };
    return { prior, entry };
  }).filter(({ prior, entry }) => serialized(prior) !== serialized(entry))
    .sort((left, right) => left.entry.id.localeCompare(right.entry.id))
    .map(({ entry }) => ({ kind: 'checklist', id: entry.id, digest: objectDigest(entry),
      summary: `${entry.capturedText} -> criteria ${entry.criterionIds.join(', ')}; tasks ${entry.taskIds.join(', ')}.` }));
  return viableRemediationEvidence({ authority: 'viable-source-amendment', seed: decision.id,
    amendmentId, criterionId, taskId, checklistEvidence });
}

function validationFailureRemediationEvidence(validationPlan, validationResults, amendments) {
  const resolved = new Set(amendments.map(({ record }) => record.value.trigger));
  const failed = [...validationResults.values()].find(({ value }) => value.status === 'failed');
  if (failed && resolved.has(`validation-failure:${failed.digest}`)) return [];
  const candidates = failed ? [{ receipt: failed, command: null }]
    : validationPlan.commands.filter(({ id }) => validationResults.get(id)?.value.status !== 'passed')
      .map((command) => ({ command, receipt: null }));
  const reservations = candidates.map(({ command, receipt }) => {
    const seed = receipt
      ? `validation-${receipt.digest.slice('sha256:'.length, 'sha256:'.length + 12)}`
      : `validation-${command.id}`;
    const evidence = viableRemediationEvidence({ authority: 'viable-validation-remediation', seed,
      amendmentId: derivedRemediationId(seed, 'amendment'),
      criterionId: derivedRemediationId(seed, 'criterion'),
      taskId: derivedRemediationId(seed, 'task') });
    const normalized = evidence.flatMap((item) => semanticEvidenceChunks(item));
    return { evidence, itemCount: normalized.length,
      byteCount: Buffer.byteLength(JSON.stringify(normalized), 'utf8') };
  });
  return reservations.sort((left, right) => right.itemCount - left.itemCount
    || right.byteCount - left.byteCount)[0]?.evidence ?? [];
}

function findingProjectionEvidence(record) {
  const { round, sourceKind, sourceRole, sourceDigest, finding, fingerprint } = record;
  const role = sourceKind === 'specialist' ? `-${sourceRole.replaceAll('_', '-')}` : '';
  const base = `round-${round}${role}-${finding.id}`;
  const evidence = [
    { kind: 'finding-disposition', id: `${base}-identity`, digest: fingerprint,
      summary: `Finding source ${sourceRole}; id ${finding.id}; fingerprint ${fingerprint}; priority ${finding.priority}; areas ${finding.affectedAreas.join(', ')}; specialization ${finding.recommendedSpecialization}; risks ${finding.riskTags.join(', ') || 'none'}; criteria ${finding.criterionIds.join(', ') || 'none'}; invariants ${finding.invariantIds.join(', ') || 'none'}.` },
    { kind: 'finding-disposition', id: `${base}-summary`, digest: fingerprint,
      summary: `Finding summary: ${finding.summary}` },
    { kind: 'finding-disposition', id: `${base}-evidence`, digest: sourceDigest,
      summary: `Finding evidence: ${finding.evidence}` },
  ];
  if (record.disposition) {
    const receipt = record.disposition;
    evidence.push({ kind: 'finding-disposition', id: base, digest: receipt.digest,
      summary: dispositionAuthoritySummary(receipt.value) });
  } else {
    const reserved = minimumDispositionAuthority({ sourceKind, sourceRole,
      findingId: finding.id, fingerprint });
    evidence.push({ kind: 'finding-disposition', id: base,
      digest: objectDigest({ sourceKind, sourceRole, fingerprint, authority: 'inevitable-disposition' }),
      summary: dispositionAuthoritySummary(reserved) });
  }
  if (record.authorization) {
    evidence.push({ kind: 'finding-disposition', id: `round-${round}-${fingerprint.slice(7, 19)}-authorization`,
      digest: record.authorization.digest,
      summary: `Human authorization by ${record.authorization.value.authorizedBy}: ${record.authorization.value.reason}` });
  } else if (record.authorizationRequired) {
    evidence.push({ kind: 'finding-disposition', id: `round-${round}-${fingerprint.slice(7, 19)}-authorization`,
      digest: objectDigest({ fingerprint, authority: 'inevitable-human-authorization' }),
      summary: authorizationReservationSummary() });
  }
  return evidence;
}

function projectedIntegrationSummary() {
  return `Integrated exact worker result at ${PROJECTED_GIT_SHA}; integration transition revision ${PROJECTED_INTEGRATION_REVISION}; status integrated.`;
}

function validationResultSummary(command, receipt) {
  return receipt
    ? `${command.argv.join(' ')} => ${receipt.value.status}; exit ${receipt.value.exitCode ?? 'none'}; output ${receipt.value.outputDigest}.`
    : `${command.argv.join(' ')} => failed; exit ${PROJECTED_VALIDATION_EXIT_CODE}; output ${PROJECTED_OUTPUT_DIGEST}.`;
}

function releaseEvidenceSummary(releaseEvidence) {
  return `Release state ${releaseEvidence.status}; base ${releaseEvidence.baseSha}; ref ${releaseEvidence.releaseRef} at ${releaseEvidence.releaseRefSha}; latest ${releaseEvidence.latestRelease ?? 'none'}; frozen migrations ${releaseEvidence.frozenMigrationCount}.`;
}

function projectedReleaseEvidence() {
  return { status: 'pre-release', baseSha: PROJECTED_GIT_SHA, releaseRef: PROTECTED_RELEASE_REF,
    releaseRefSha: PROJECTED_GIT_SHA, latestRelease: PROJECTED_RELEASE_TAG,
    frozenMigrationCount: Number.MAX_SAFE_INTEGER };
}

function composeVerifierProjection(input = {}) {
  const { originalPlan, originalPlanDigest = objectDigest(originalPlan),
  effectivePlan, effectivePlanDigest = objectDigest(effectivePlan), taskRecords, amendments = [],
  validationPlan, validationPlanReceiptDigest = objectDigest(validationPlan),
  validationPlanDigestValue = objectDigest(validationPlan), validationResults = new Map(),
  specialistPlan, specialistPlanReceiptDigest = objectDigest(specialistPlan), specialistResults = new Map(),
  findingRecords = [], specialistResultHistory = null,
  specialistReservationAllocation = null, specialistReservationOrdering = 'item',
  checkSpecialistAllocationBranches = true,
  sourceDigest = effectivePlan.source.captureDigest,
  headSha = effectivePlan.planning.planningSha, planningSha = effectivePlan.planning.planningSha,
  verificationRound = 1, taskSetDigest = objectDigest(effectivePlan.tasks),
  generatedAt = '2000-01-01T00:00:00.000Z', releaseApplicable = false,
  reservedEvidence = [] } = input;
  const allocationBranches = specialistReservationAllocations(specialistPlan, specialistResults,
    findingRecords, verificationRound);
  const defaultAllocation = allocationBranches.at(-1) ?? [];
  const selectedAllocation = specialistReservationAllocation ?? defaultAllocation;
  if (checkSpecialistAllocationBranches && specialistReservationAllocation === null) {
    const defaultFootprint = specialistReservationFootprint(remainingSpecialistFindingReservations(
      specialistPlan, specialistResults, findingRecords, verificationRound,
      specialistResultHistory, defaultAllocation, 'item'));
    const checked = new Set([serialized(defaultFootprint)]);
    for (const allocation of allocationBranches) {
      for (const ordering of ['item', 'byte']) {
        const reservations = remainingSpecialistFindingReservations(specialistPlan, specialistResults,
          findingRecords, verificationRound, specialistResultHistory, allocation, ordering);
        const footprint = specialistReservationFootprint(reservations);
        const identity = serialized(footprint);
        if (checked.has(identity)
            || (footprint.itemCount <= defaultFootprint.itemCount
              && footprint.byteCount <= defaultFootprint.byteCount)) continue;
        checked.add(identity);
        composeVerifierProjection({ ...input, specialistReservationAllocation: allocation,
          specialistReservationOrdering: ordering, checkSpecialistAllocationBranches: false });
      }
    }
  }
  const completeFindingRecords = [...findingRecords,
    ...remainingSpecialistFindingReservations(specialistPlan, specialistResults,
      findingRecords, verificationRound, specialistResultHistory, selectedAllocation,
      specialistReservationOrdering)];
  const evidence = [
    { kind: 'source', id: 'source-observation', digest: sourceDigest,
      summary: `${effectivePlan.source.kind}:${effectivePlan.source.reference}` },
    { kind: 'criterion', id: 'original-plan-objective', digest: originalPlanDigest,
      summary: `Original objective: ${originalPlan.objective}` },
    { kind: 'criterion', id: 'original-plan-scope',
      digest: objectDigest({ scope: originalPlan.scope, nonGoals: originalPlan.nonGoals }),
      summary: `Original scope: ${originalPlan.scope.join(', ')}; original non-goals: ${originalPlan.nonGoals.join(', ')}` },
    { kind: 'specialist-route', id: 'original-plan-profile', digest: objectDigest(originalPlan.specialization),
      summary: `Original specialization ${originalPlan.specialization.specialization}; profile ${originalPlan.specialization.route.profileGuidePath}; areas ${originalPlan.specialization.affectedAreas.join(', ')}; risks ${originalPlan.specialization.riskTags.join(', ') || 'none'}; priority ${originalPlan.specialization.route.finalVerificationPriority}` },
    { kind: 'checklist', id: 'original-plan-scenarios',
      digest: objectDigest({ scenarios: originalPlan.scenarios, disposition: originalPlan.productScenarioDisposition }),
      summary: `Original scenarios ${originalPlan.scenarios.map(({ id }) => id).join(', ') || 'none'}; disposition ${originalPlan.productScenarioDisposition.disposition}: ${originalPlan.productScenarioDisposition.rationale}` },
    { kind: 'criterion', id: 'effective-plan-objective', digest: effectivePlanDigest,
      summary: `Effective objective: ${effectivePlan.objective}` },
    { kind: 'criterion', id: 'effective-plan-scope',
      digest: objectDigest({ scope: effectivePlan.scope, nonGoals: effectivePlan.nonGoals }),
      summary: `Effective scope: ${effectivePlan.scope.join(', ')}; effective non-goals: ${effectivePlan.nonGoals.join(', ')}` },
    { kind: 'specialist-route', id: 'effective-plan-profile', digest: objectDigest(effectivePlan.specialization),
      summary: `Effective specialization ${effectivePlan.specialization.specialization}; profile ${effectivePlan.specialization.route.profileGuidePath}; areas ${effectivePlan.specialization.affectedAreas.join(', ')}; risks ${effectivePlan.specialization.riskTags.join(', ') || 'none'}; priority ${effectivePlan.specialization.route.finalVerificationPriority}; supplemental ${effectivePlan.specialization.route.supplementalGuidance.map(({ id }) => id).join(', ') || 'none'}` },
    { kind: 'checklist', id: 'effective-plan-scenarios',
      digest: objectDigest({ scenarios: effectivePlan.scenarios, disposition: effectivePlan.productScenarioDisposition }),
      summary: `Effective scenarios ${effectivePlan.scenarios.map(({ id }) => id).join(', ') || 'none'}; disposition ${effectivePlan.productScenarioDisposition.disposition}: ${effectivePlan.productScenarioDisposition.rationale}` },
    { kind: 'validation-plan', id: 'targeted-validation', digest: validationPlanReceiptDigest,
      summary: `${validationPlan.commands.length} exact command(s) on ${headSha}.` },
    { kind: 'specialist-route', id: 'integrated-route', digest: specialistPlanReceiptDigest,
      summary: `Reviewers: ${specialistPlan.reviewers.map(({ id }) => id).join(', ') || 'none'}; priority ${specialistPlan.finalVerificationPriority}.` },
  ];
  effectivePlan.criteria.forEach((entry) => evidence.push({ kind: 'criterion', id: entry.id,
    digest: objectDigest(entry), summary: `${entry.disposition}: ${entry.description}` }));
  effectivePlan.decisions.forEach((entry) => evidence.push({ kind: 'decision', id: entry.id,
    digest: objectDigest(entry), summary: `${entry.status}: ${entry.resolution ?? entry.rationale}` }));
  effectivePlan.checklistMappings.forEach((entry) => evidence.push({ kind: 'checklist', id: entry.id,
    digest: objectDigest(entry), summary: `${entry.capturedText} -> criteria ${entry.criterionIds.join(', ')}; tasks ${entry.taskIds.join(', ')}.` }));
  for (const [kind, prefix, entries] of [['criterion', 'original-plan-criterion', originalPlan.criteria],
    ['decision', 'original-plan-decision', originalPlan.decisions],
    ['checklist', 'original-plan-checklist', originalPlan.checklistMappings],
    ['packet', 'original-plan-task', originalPlan.tasks]]) {
    [...entries].sort((left, right) => left.id.localeCompare(right.id)).forEach((entry) => evidence.push({
      kind, id: `${prefix}-${entry.id}`, digest: objectDigest(entry),
      summary: `Original accepted-plan ${kind === 'packet' ? 'task' : kind}${kind === 'checklist' ? ' mapping' : ''} ${entry.id}:\n${serialized(entry)}` }));
  }
  for (const record of taskRecords) {
    const { task, packet, result } = record;
    const authorityPacket = packet ?? record.authorityPacket
      ?? minimumProjectedPacket(task, effectivePlan, effectivePlanDigest, record.behaviorMapperEvidence ?? null);
    const projectedResult = result ?? record.projectedResult ?? minimumProjectedResult(authorityPacket);
    const id = authorityPacket.taskId;
    const route = authorityPacket.specialistRoute;
    const affectedAreas = authorityPacket.affectedAreas;
    const riskTags = authorityPacket.riskTags;
    const validations = [...authorityPacket.requiredValidation.unit, ...authorityPacket.requiredValidation.system]
      .map(({ command }) => command).join('; ');
    evidence.push({ kind: 'packet', id, digest: record.packetDigest,
      summary: `Plan revision ${authorityPacket.planRevision}; plan ${authorityPacket.planDigest}; binding ${record.binding}; objective ${authorityPacket.objective}; dependencies ${authorityPacket.dependencies.join(', ') || 'none'}.` });
    evidence.push({ kind: 'packet', id: `${id}-ownership`, digest: objectDigest({
      allowedPaths: authorityPacket.allowedPaths, forbiddenPaths: authorityPacket.forbiddenPaths }),
    summary: `Allowed paths: ${authorityPacket.allowedPaths.join(', ')}; forbidden paths: ${authorityPacket.forbiddenPaths.join(', ') || 'none'}.` });
    evidence.push({ kind: 'packet', id: `${id}-profile`, digest: objectDigest({
      specialization: authorityPacket.specialization, affectedAreas, riskTags, route }),
    summary: `Specialization ${authorityPacket.specialization}; areas ${affectedAreas.join(', ')}; risks ${riskTags.join(', ') || 'none'}; profile ${route.profileGuidePath}; reviewers ${route.riskReviewers.map(({ id: reviewerId }) => reviewerId).join(', ') || 'none'}; supplemental ${route.supplementalGuidance.map(({ id: guideId }) => guideId).join(', ') || 'none'}.` });
    evidence.push({ kind: 'packet', id: `${id}-validation`,
      digest: objectDigest(authorityPacket.requiredValidation),
      summary: `Required validation: ${validations}; planning signals browser:${authorityPacket.planningSignals.browserVisible}, uncertain:${authorityPacket.planningSignals.relatedTestSelectionUncertain}.` });
    evidence.push({ kind: 'provenance', id: `${id}-provenance`, digest: record.provenanceDigest,
      summary: `Decision context ${authorityPacket.decisionIds.join(', ') || 'none'}; criteria ${authorityPacket.acceptanceCriteriaIds.join(', ')}.` });
    const mapper = authorityPacket.behaviorMapperEvidence ?? record.behaviorMapperEvidence;
    if (mapper) evidence.push({ kind: 'planning-helper', id: `${id}-behavior-mapper`,
      digest: objectDigest(mapper), summary: `Behavior mapper at ${mapper.headSha}; status ${mapper.status}; ${mapper.summary}` });
    evidence.push({ kind: 'result', id: `${id}-result`, digest: record.resultDigest,
      summary: result ? `${result.status}; ${result.summary}; changed paths ${result.changedPaths.join(', ') || 'none'}.`
        : `${projectedResult.status}; ${projectedResult.summary}; changed paths ${projectedResult.changedPaths.join(', ') || 'none'}.` });
    evidence.push({ kind: 'result', id: `${id}-result-validation`,
      digest: result ? objectDigest(result.validation) : record.resultDigest,
      summary: result ? `Worker validation: ${result.validation.map(({ command, result: outcome }) => `${command}:${outcome}`).join(', ')}.`
        : `Worker validation: ${projectedResult.validation.map(({ command, result: outcome }) => `${command}:${outcome}`).join(', ')}.` });
    evidence.push({ kind: 'result', id: `${id}-result-dependencies`,
      digest: result ? objectDigest(result.unexpectedDependencies) : record.resultDigest,
      summary: result ? `Unexpected dependencies: ${result.unexpectedDependencies.join(', ') || 'none'}.`
        : `Unexpected dependencies: ${projectedResult.unexpectedDependencies.join(', ') || 'none'}.` });
    const changedPaths = result?.changedPaths ?? projectedResult.changedPaths;
    evidence.push({ kind: 'result', id: `${id}-path-authority`,
      digest: objectDigest({ changedPaths, allowedPaths: authorityPacket.allowedPaths }),
      summary: `Changed-path authority: ${changedPaths.map((path) => { const allowed = authorityPacket.allowedPaths.filter((pattern) => pathMatchesOwnership(path, pattern)); const forbidden = authorityPacket.forbiddenPaths.filter((pattern) => pathMatchesOwnership(path, pattern)); return `${path}->${forbidden.length ? `forbidden:${forbidden.join('|')}` : allowed.length ? `allowed:${allowed.join('|')}` : 'unowned'}`; }).join(', ') || 'no changed paths'}.` });
    if (record.requiresReplacement || record.reservesTaskReplacement) {
      evidence.push(...taskReplacementEvidence(record));
    }
    else evidence.push({ kind: 'integration', id: `${id}-integration`,
        digest: record.integrationReceiptDigest ?? record.resultDigest,
        summary: record.integratedCommit ? `Integrated exact worker result at ${record.integratedCommit}; integration transition revision ${record.integrationReceipt.revision}; status ${record.terminalStatus}.`
          : record.terminalStatus === 'no-change' && result ? `Terminal receipt-valid no-change result; status ${record.terminalStatus}.`
            : projectedIntegrationSummary() });
  }
  evidence.push(...reservedEvidence);
  evidence.push(...validationFailureRemediationEvidence(validationPlan, validationResults, amendments));
  evidence.push(...actionableRemediationEvidence(completeFindingRecords, amendments));
  validationPlan.commands.forEach((command) => {
    const receipt = validationResults.get(command.id);
    evidence.push({ kind: 'validation-result', id: command.id,
      digest: receipt?.digest ?? objectDigest({ commandId: command.id, authority: 'inevitable-validation-result' }),
      summary: validationResultSummary(command, receipt) });
  });
  for (const { number, record, planningEvidence: provenance } of amendments) {
    const { resultingPlan, ...authority } = record.value;
    const authorityProjection = { amendmentNumber: number, receiptDigest: record.digest, ...authority,
      resultingPlanIdentity: { changeId: resultingPlan.changeId, planRevision: resultingPlan.planRevision,
        digest: objectDigest(resultingPlan) } };
    evidence.push({ kind: 'amendment', id: record.value.amendmentId, digest: record.digest,
      summary: `Complete amendment authority and resulting-plan identity:\n${serialized(authorityProjection)}` });
    evidence.push({ kind: 'provenance', id: `${record.value.amendmentId}-provenance`, digest: provenance.digest,
      summary: `Amendment provenance receipt ${provenance.digest}; record count ${provenance.value.length}.` });
    provenance.value.forEach((entry, index) => evidence.push({ kind: 'provenance',
      id: `${record.value.amendmentId}-provenance-record-${index + 1}`, digest: provenance.digest,
      summary: `Amendment provenance record ${index + 1} of ${provenance.value.length}:\n${serialized(entry)}` }));
  }
  if (validationPlan.releaseEvidence) evidence.push({ kind: 'release', id: 'release-state',
    digest: validationPlan.releaseEvidence.evidenceDigest,
    summary: releaseEvidenceSummary(validationPlan.releaseEvidence) });
  else if (releaseApplicable) evidence.push({ kind: 'release', id: 'release-state',
    digest: objectDigest({ authority: 'inevitable-protected-release-evidence' }),
    summary: releaseEvidenceSummary(projectedReleaseEvidence()) });
  specialistPlan.planningHelpers.forEach(({ id, reasons }) => evidence.push({ kind: 'planning-helper', id,
    digest: objectDigest({ id, reasons }), summary: reasons.join(', ') }));
  specialistPlan.supplementalGuidance.forEach(({ id, reasons }) => evidence.push({ kind: 'supplemental-guidance', id,
    digest: objectDigest({ id, reasons }), summary: reasons.join(', ') }));
  specialistPlan.reviewers.forEach(({ id }) => {
    const receipt = specialistResults.get(id);
    evidence.push({ kind: 'specialist-result', id: id.replaceAll('_', '-'),
      digest: receipt?.digest ?? objectDigest({ reviewerId: id, authority: 'inevitable-specialist-result' }),
      summary: receipt?.value.summary ?? `Reserved exact-HEAD result summary from ${id}.` });
  });
  completeFindingRecords.sort((left, right) => left.round - right.round
    || left.sourceRole.localeCompare(right.sourceRole) || left.finding.id.localeCompare(right.finding.id))
    .forEach((record) => evidence.push(...findingProjectionEvidence(record)));
  const boundedEvidence = boundVerifierEvidence(evidence);
  const validationResultDigests = validationPlan.commands.map((command) => validationResults.get(command.id)?.digest
    ?? objectDigest({ commandId: command.id, authority: 'inevitable-validation-result' }));
  const specialistResultDigests = specialistPlan.reviewers.map(({ id }) => specialistResults.get(id)?.digest
    ?? objectDigest({ reviewerId: id, authority: 'inevitable-specialist-result' }));
  const contextIdentity = { verifierId: 'development_integration_verifier', verificationRound,
    headSha, effectivePlanDigest, taskSetDigest, validationPlanDigest: validationPlanDigestValue,
    specialistResultDigests };
  const context = { schemaVersion: 1, verifierId: 'development_integration_verifier',
    finalVerificationPriority: specialistPlan.finalVerificationPriority, verificationRound,
    inputIdentityDigest: objectDigest(contextIdentity), changeId: effectivePlan.changeId,
    headSha, planningSha, originalPlanDigest, effectivePlanDigest, taskSetDigest,
    sourceIdentity: { kind: effectivePlan.source.kind, reference: effectivePlan.source.reference, digest: sourceDigest },
    validationPlanDigest: validationPlanDigestValue, validationResultDigests, specialistResultDigests,
    evidence: boundedEvidence, generatedAt };
  if (Buffer.byteLength(JSON.stringify(context), 'utf8') > 256 * 1024) {
    throw new StateError('Complete verifier context exceeds 256 KiB', 'VERIFIER_CONTEXT_TOO_LARGE');
  }
  const errors = validateVerificationContract('verifierContext', context);
  if (errors.length) throw new StateError(`Projected verifier context is invalid: ${errors.join('; ')}`, 'VERIFIER_CONTEXT_INVALID');
  return { context, evidence: boundedEvidence };
}

export function preflightVerifierCapacity({ originalPlan, effectivePlan = originalPlan, packets = [], results = [],
  amendments = [], planningEvidence = [], sourceDigest,
  featureDirectory, projection } = {}) {
  if (projection) return composeVerifierProjection(projection);
  const packetByTask = new Map(packets.map((packet) => [packet.taskId, packet]));
  const commandPackets = effectivePlan.tasks.map((task) => packetByTask.get(task.id) ?? {
    taskId: task.id, affectedAreas: task.specialization.affectedAreas,
    requiredValidation: minimumProjectedValidation(task),
  });
  const commands = commandPackets.length > 0
    ? assertValidationCommandCompatibility(commandPackets, { featureDirectory }) : [];
  const headSha = effectivePlan.planning.planningSha;
  const releaseApplicable = commandPackets.some(({ affectedAreas }) =>
    affectedAreas.some((area) => ['release', 'migration'].includes(area)));
  const validationPlan = { commands, headSha, releaseEvidence: null };
  const validationPlanDigestValue = objectDigest({ tasks: effectivePlan.tasks, commands });
  const specialistPlan = projectedSpecialistPlan(effectivePlan, packetByTask, headSha, validationPlanDigestValue);
  return composeVerifierProjection({ originalPlan, effectivePlan,
    taskRecords: projectedTaskRecords(effectivePlan, packets, results, planningEvidence), amendments,
    validationPlan, validationPlanDigestValue, specialistPlan, releaseApplicable,
    sourceDigest: sourceDigest ?? effectivePlan.source.captureDigest });
}

function findingProjectionRecords(cwd, state, pending = {}) {
  if (!state.verification && !pending.verificationRound) return [];
  const currentRound = pending.verificationRound ?? state.verification.round;
  const pendingFindingRound = pending.findingRound ?? currentRound;
  const pendingDispositions = new Map([
    ...(pending.dispositions ?? []), ...(pending.disposition ? [pending.disposition] : []),
  ].map((value) => [value.fingerprint, value]));
  const records = [];
  const pendingSources = [pending.specialistResult
    ? { sourceKind: 'specialist', sourceRole: pending.specialistResult.reviewerId,
      value: pending.specialistResult, digest: objectDigest(pending.specialistResult) } : null,
  pending.verifierResult ? { sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
    value: pending.verifierResult, digest: objectDigest(pending.verifierResult) } : null].filter(Boolean);
  for (let round = 1; round <= currentRound; round += 1) {
    const directory = verificationRoundDirectory(cwd, state, round);
    const sources = [];
    const specialists = join(directory, 'specialists');
    if (existsSync(specialists)) {
      for (const name of readdirSync(specialists).filter((entry) => entry.endsWith('.json')).sort()) {
        const receipt = verifyReceipt(join(specialists, name), `specialist finding source ${name} round ${round}`);
        sources.push({ sourceKind: 'specialist', sourceRole: receipt.value.reviewerId,
          value: receipt.value, digest: receipt.digest });
      }
    }
    const verifierPath = join(directory, 'verifier-result.json');
    if (existsSync(verifierPath)) {
      const receipt = verifyReceipt(verifierPath, `verifier finding source round ${round}`);
      sources.push({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
        value: receipt.value, digest: receipt.digest });
    }
    if (round === pendingFindingRound) for (const source of pendingSources) {
      if (!sources.some(({ sourceKind, sourceRole }) =>
        sourceKind === source.sourceKind && sourceRole === source.sourceRole)) sources.push(source);
    }
    sources.sort((left, right) => left.sourceRole.localeCompare(right.sourceRole));
    for (const source of sources) for (const finding of source.value.findings) {
      const fingerprint = findingFingerprint({ sourceKind: source.sourceKind,
        sourceRole: source.sourceRole, finding });
      const dispositionPath = findingDispositionPath(cwd, state, fingerprint, round);
      let disposition = existsSync(dispositionPath)
        ? verifyReceipt(dispositionPath, `finding disposition ${finding.id} round ${round}`) : null;
      if (round === pendingFindingRound && pendingDispositions.has(fingerprint)) {
        const value = pendingDispositions.get(fingerprint);
        disposition = { value, digest: objectDigest(value) };
      }
      const authorizationPath = join(changeDirectory(cwd, state.changeId), 'verification', 'authorizations',
        fingerprint.slice('sha256:'.length), `${String(round).padStart(4, '0')}.json`);
      let authorization = existsSync(authorizationPath)
        ? verifyReceipt(authorizationPath, `finding authorization ${finding.id} round ${round}`) : null;
      if (round === pendingFindingRound && pending.authorizationRecord?.fingerprint === fingerprint) {
        authorization = { value: pending.authorizationRecord, digest: objectDigest(pending.authorizationRecord) };
      }
      const authorizationRequired = authorization !== null
        || (round === pendingFindingRound && (pending.authorizationRequiredFingerprints ??
          state.verification?.humanDecisionRequiredFingerprints ?? []).includes(fingerprint));
      records.push({ round, sourceKind: source.sourceKind, sourceRole: source.sourceRole,
        sourceDigest: source.digest, finding, fingerprint, disposition, authorization,
        authorizationRequired });
    }
  }
  return records;
}

function specialistReservationAllocations(specialistPlan, specialistResults, findingRecords,
  verificationRound) {
  if (specialistResults.size === 0) return [[]];
  const occupied = new Set(findingRecords.filter(({ round, sourceKind }) =>
    round === verificationRound && sourceKind === 'specialist').map(({ fingerprint }) => fingerprint));
  const remainingReviewers = specialistPlan.reviewers.map(({ id }) => id)
    .filter((id) => !specialistResults.has(id));
  const allocations = [];
  const visit = (reviewerIndex, available, allocation) => {
    if (reviewerIndex === remainingReviewers.length) {
      allocations.push(allocation); return;
    }
    const reviewerCount = remainingReviewers.length - reviewerIndex;
    const share = Math.floor(available / reviewerCount);
    const values = share === 0 ? [0] : [0, share];
    for (const value of values) visit(reviewerIndex + 1, available - value,
      [...allocation, [remainingReviewers[reviewerIndex], value]]);
  };
  visit(0, Math.max(0, SPECIALIST_FINDING_LIMIT - occupied.size), []);
  return allocations;
}

function specialistReservationFootprint(records) {
  const evidence = records.flatMap((record) => findingProjectionEvidence(record))
    .flatMap((item) => semanticEvidenceChunks(item));
  return { itemCount: evidence.length,
    byteCount: Buffer.byteLength(JSON.stringify(evidence), 'utf8') };
}

function priorSpecialistResultHistory(cwd, state, verificationRound) {
  const history = [];
  for (let round = 1; round < verificationRound; round += 1) {
    const specialists = join(verificationRoundDirectory(cwd, state, round), 'specialists');
    if (!existsSync(specialists)) continue;
    for (const name of readdirSync(specialists).filter((entry) => entry.endsWith('.json')).sort()) {
      const receipt = verifyReceipt(join(specialists, name),
        `specialist applicability source ${name} round ${round}`);
      history.push({ round, sourceRole: receipt.value.reviewerId });
    }
  }
  return history;
}

function remainingSpecialistFindingReservations(specialistPlan, specialistResults, findingRecords,
  verificationRound, specialistResultHistory = null, specialistReservationAllocation = null,
  specialistReservationOrdering = 'item') {
  if (specialistResults.size === 0) return [];
  const occupied = new Set(findingRecords.filter(({ round, sourceKind }) =>
    round === verificationRound && sourceKind === 'specialist').map(({ fingerprint }) => fingerprint));
  const remainingReviewers = specialistPlan.reviewers.map(({ id }) => id)
    .filter((id) => !specialistResults.has(id));
  let available = Math.max(0, SPECIALIST_FINDING_LIMIT - occupied.size);
  const allocated = specialistReservationAllocation === null
    ? null : new Map(specialistReservationAllocation);
  const records = [];
  remainingReviewers.forEach((sourceRole, reviewerIndex) => {
    const reviewerCount = remainingReviewers.length - reviewerIndex;
    const reservedShare = allocated?.get(sourceRole) ?? Math.floor(available / reviewerCount);
    available -= reservedShare;
    const sourceDigest = objectDigest({ sourceRole, authority: 'inevitable-specialist-finding-result' });
    const priorByFingerprint = new Map();
    const applicableRound = specialistResultHistory === null ? verificationRound - 1
      : specialistResultHistory.filter(({ round, sourceRole: role }) =>
        round < verificationRound && role === sourceRole).sort((left, right) => right.round - left.round)[0]?.round;
    for (const record of findingRecords.filter(({ round, sourceKind, sourceRole: role }) =>
      round === applicableRound && sourceKind === 'specialist' && role === sourceRole)) {
      if (!priorByFingerprint.has(record.fingerprint)) priorByFingerprint.set(record.fingerprint, record);
    }
    const repeats = [...priorByFingerprint.values()].map((record) => {
      const finding = { ...record.finding, summary: 'x', evidence: 'x' };
      const reservation = { round: verificationRound, sourceKind: 'specialist', sourceRole,
        sourceDigest, finding, fingerprint: record.fingerprint,
        disposition: null, authorization: null, authorizationRequired: true };
      const normalized = findingProjectionEvidence(reservation)
        .flatMap((item) => semanticEvidenceChunks(item));
      return { reservation, itemCount: normalized.length,
        byteCount: Buffer.byteLength(JSON.stringify(normalized), 'utf8') };
    }).sort((left, right) => specialistReservationOrdering === 'byte'
      ? right.byteCount - left.byteCount || right.itemCount - left.itemCount
        || left.reservation.fingerprint.localeCompare(right.reservation.fingerprint)
      : right.itemCount - left.itemCount || right.byteCount - left.byteCount
        || left.reservation.fingerprint.localeCompare(right.reservation.fingerprint))
      .slice(0, reservedShare).map(({ reservation }) => reservation);
    records.push(...repeats);
    const usedIds = new Set([...priorByFingerprint.values()].map(({ finding }) => finding.id));
    let candidate = 1;
    while (records.filter(({ sourceRole: role, round }) =>
      role === sourceRole && round === verificationRound).length < reservedShare) {
      let id;
      do { id = `reserved-${String(candidate).padStart(3, '0')}`; candidate += 1; } while (usedIds.has(id));
      usedIds.add(id);
      const finding = { id, priority: 'P0',
        summary: 'x', evidence: 'x', affectedAreas: ['api'], recommendedSpecialization: 'api',
        riskTags: [], criterionIds: [], invariantIds: [] };
      records.push({ round: verificationRound, sourceKind: 'specialist', sourceRole,
        sourceDigest, finding,
        fingerprint: findingFingerprint({ sourceKind: 'specialist', sourceRole, finding }),
        disposition: null, authorization: null, authorizationRequired: false });
    }
  });
  return records;
}

function verifierProjectionFromState(cwd, state, pending = {}) {
  const originalReceipt = verifyReceipt(join(changeDirectory(cwd, state.changeId), 'plan', 'plan.json'),
    'accepted plan');
  const effectivePlan = pending.effectivePlan ?? readEffectivePlan(cwd, state);
  const effectivePlanDigest = pending.effectivePlanDigest ?? objectDigest(effectivePlan);
  const resetsVerification = Boolean(pending.effectivePlan || pending.validationPlan
    || pending.resetsVerification);
  const projectionRound = pending.verificationRound
    ?? (pending.effectivePlan ? nextVerificationRound(cwd, state)
      : state.verification?.round ?? nextVerificationRound(cwd, state));
  const amendments = pending.amendments ?? verifierCapacityAmendments(cwd, state);
  const planningEvidence = [
    ...verifyReceipt(join(changeDirectory(cwd, state.changeId), 'plan', 'planning-evidence.json'),
      'accepted-plan planning evidence').value,
    ...amendments.flatMap(({ planningEvidence: receipt }) => receipt.value),
  ];
  const packets = state.execution?.tasks.filter((task) => task.binding > 0 && task.status !== 'rejected')
    .map((task) => verifyReceipt(implementationTaskPacketPath(cwd, state.changeId, task.id, task.binding),
      `authoritative task packet ${task.id}`).value) ?? [];
  if (pending.packet) {
    const index = packets.findIndex(({ taskId }) => taskId === pending.packet.taskId);
    if (index >= 0) packets[index] = pending.packet; else packets.push(pending.packet);
  }
  const results = verifierCapacityResults(cwd, state, pending.result ?? null);
  const terminal = !pending.effectivePlan && state.execution?.tasks.length > 0
    && state.execution.tasks.every(({ status }) => ['integrated', 'no-change'].includes(status));
  const taskRecords = terminal ? terminalTaskEvidence(cwd, state)
    : projectedTaskRecords(effectivePlan, packets, results, planningEvidence);
  if (!terminal) for (const record of taskRecords) {
    const summary = state.execution?.tasks.find(({ id }) => id === record.task.id);
    if (pending.packet?.taskId === record.task.id) record.binding = (summary?.binding ?? 0) + 1;
    if (['blocked', 'failed', 'rejected'].includes(summary?.status)
        || pending.rejectedTaskId === record.task.id) record.requiresReplacement = true;
    if (!summary || summary.binding < 1 || summary.status === 'rejected') continue;
    if (['integrated', 'no-change'].includes(summary.status)
        && pending.packet?.taskId !== summary.id && pending.result?.taskId !== summary.id) {
      Object.assign(record, terminalTaskEvidenceForTask(cwd, state, summary));
      record.reservesTaskReplacement = false;
      continue;
    }
    const packet = verifyReceipt(implementationTaskPacketPath(cwd, state.changeId, summary.id, summary.binding),
      `authoritative task packet ${summary.id}`);
    const provenance = verifyReceipt(join(changeDirectory(cwd, state.changeId), 'implementation', 'provenance',
      `${summary.id}/${String(summary.binding).padStart(4, '0')}.json`), `task provenance ${summary.id}`);
    record.packetDigest = packet.digest; record.provenanceDigest = provenance.digest;
    record.binding = summary.binding; record.attempt = summary.attempt;
  }
  const packetByTask = new Map(packets.map((packet) => [packet.taskId, packet]));
  let validationPlanReceipt;
  if (pending.validationPlan) validationPlanReceipt = {
    value: pending.validationPlan, digest: objectDigest(pending.validationPlan),
  };
  else if (!resetsVerification && state.verification && existsSync(validationPlanPath(cwd, state))) {
    validationPlanReceipt = verifyReceipt(validationPlanPath(cwd, state), 'validation plan');
  } else {
    const commandPackets = effectivePlan.tasks.map((task) => packetByTask.get(task.id) ?? {
      taskId: task.id, affectedAreas: task.specialization.affectedAreas,
      requiredValidation: minimumProjectedValidation(task),
    });
    const commands = commandPackets.length > 0
      ? assertValidationCommandCompatibility(commandPackets, { featureDirectory: join(cwd, 'specs', 'features') }) : [];
    validationPlanReceipt = { value: { commands, headSha: state.git.headSha, releaseEvidence: null },
      digest: objectDigest({ commands, headSha: state.git.headSha }) };
  }
  const validationPlanValue = validationPlanReceipt.value;
  const validationPlanDigestValue = pending.validationPlan
    ? validationPlanDigest(pending.validationPlan)
    : (!resetsVerification ? state.verification?.validationPlanDigest : null) ?? objectDigest(validationPlanValue);
  const validationResults = state.verification && !resetsVerification
    ? existingCommandResults(cwd, state, validationPlanValue) : new Map();
  if (pending.validationResult) validationResults.set(pending.validationResult.commandId,
    { value: pending.validationResult, digest: objectDigest(pending.validationResult) });
  let specialistPlanReceipt;
  if (pending.specialistPlan) specialistPlanReceipt = {
    value: pending.specialistPlan, digest: objectDigest(pending.specialistPlan),
  };
  else if (!resetsVerification && state.verification?.specialistPlanDigest
      && existsSync(specialistPlanPath(cwd, state))) {
    specialistPlanReceipt = verifyReceipt(specialistPlanPath(cwd, state), 'specialist plan');
  } else {
    const value = projectedSpecialistPlan(effectivePlan, packetByTask,
      validationPlanValue.headSha, validationPlanDigestValue);
    specialistPlanReceipt = { value, digest: objectDigest(value) };
  }
  const specialistResults = new Map();
  if (!resetsVerification && state.verification?.round === projectionRound) for (const { id } of specialistPlanReceipt.value.reviewers) {
    const path = specialistResultPath(cwd, state, id);
    if (existsSync(path)) specialistResults.set(id, verifyReceipt(path, `specialist result ${id}`));
  }
  if (pending.specialistResult && (pending.findingRound ?? projectionRound) === projectionRound) {
    specialistResults.set(pending.specialistResult.reviewerId,
      { value: pending.specialistResult, digest: objectDigest(pending.specialistResult) });
  }
  const affectedAreas = new Set(effectivePlan.tasks.flatMap((task) =>
    packetByTask.get(task.id)?.affectedAreas ?? task.specialization.affectedAreas));
  const decisionSourceObservation = pending.sourceObservation
    ?? (pending.decisionResolution?.disposition === 'resolve'
      ? readObservationByDigest(cwd, state) : null);
  const sourceResolution = pending.decisionResolution?.disposition === 'resolve'
    ? pending.decisionResolution : pending.sourceObservation
      ? { id: 'x'.repeat(128), disposition: 'resolve' } : null;
  const specialistResultHistory = priorSpecialistResultHistory(cwd, state, projectionRound);
  if (pending.specialistResult && (pending.findingRound ?? projectionRound) < projectionRound) {
    specialistResultHistory.push({ round: pending.findingRound, sourceRole: pending.specialistResult.reviewerId });
  }
  return { originalPlan: originalReceipt.value, originalPlanDigest: originalReceipt.digest,
    effectivePlan, effectivePlanDigest, taskRecords, amendments,
    validationPlan: validationPlanValue, validationPlanReceiptDigest: validationPlanReceipt.digest,
    validationPlanDigestValue, validationResults, specialistPlan: specialistPlanReceipt.value,
    specialistPlanReceiptDigest: specialistPlanReceipt.digest, specialistResults,
    findingRecords: findingProjectionRecords(cwd, state, { ...pending, verificationRound: projectionRound }),
    specialistResultHistory,
    sourceDigest: pending.sourceObservation ? objectDigest(pending.sourceObservation)
      : state.source.observationDigest,
    headSha: validationPlanValue.headSha, planningSha: state.planningSha,
    verificationRound: projectionRound,
    taskSetDigest: pending.validationPlan?.taskSetDigest ?? state.verification?.taskSetDigest
      ?? objectDigest(effectivePlan.tasks), generatedAt: validationPlanValue.createdAt
      ?? '2000-01-01T00:00:00.000Z',
    reservedEvidence: sourceResolution
      ? sourceDecisionAmendmentEvidence(sourceResolution, effectivePlan,
        decisionSourceObservation) : [],
    releaseApplicable: affectedAreas.has('release') || affectedAreas.has('migration') };
}

function assertStateVerifierCapacity(cwd, state, pending = {}) {
  return preflightVerifierCapacity({ projection: verifierProjectionFromState(cwd, state, pending) });
}

export function preflightStateVerifierCapacity({ cwd = process.cwd(), changeId, pending = {} } = {}) {
  const root = repositoryRoot(cwd); const state = loadState(root, changeId);
  validateState({ cwd: root, changeId: state.changeId });
  return assertStateVerifierCapacity(root, state, pending);
}

export function buildVerifierContext({ cwd = process.cwd(), changeId } = {}) {
  const root = repositoryRoot(cwd); const state = loadState(root, changeId);
  if (!state || state.phase !== 'verifying' || state.verification.validationStatus !== 'passed') {
    throw new StateError('Verifier context requires clean targeted validation and specialist review', 'INVALID_PHASE');
  }
  assertVerificationHead(root, state, undefined, 'Verifier context');
  if (state.verification.requiredReviewerIds.length !== state.verification.specialistResultDigests.length) {
    throw new StateError('Verifier context requires every routed specialist result', 'SPECIALIST_RESULT_MISSING');
  }
  const projection = verifierProjectionFromState(root, state);
  validateState({ cwd: root, changeId: state.changeId });
  if (projection.validationPlan.commands.some((command) => !projection.validationResults.has(command.id))) {
    throw new StateError('Verifier context requires every exact validation result', 'VALIDATION_RESULT_INCOMPLETE');
  }
  if (projection.specialistPlan.reviewers.some(({ id }) => !projection.specialistResults.has(id))) {
    throw new StateError('Verifier context requires every routed specialist result', 'SPECIALIST_RESULT_MISSING');
  }
  if (projection.findingRecords.some(({ disposition }) => disposition === null)) {
    throw new StateError('Verifier context requires every historical finding disposition', 'FINDING_DISPOSITION_INVALID');
  }
  return preflightVerifierCapacity({ projection }).context;
}
export function recordVerifierResult({ cwd = process.cwd(), changeId, expectedRevision, result, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'verifying' || state.verification.verifierResultDigest) throw new StateError('Verifier result requires verifying phase with no prior result', 'INVALID_PHASE');
    assertVerificationHead(root, state, clock, 'Verifier result');
    const context = buildVerifierContext({ cwd: root, changeId: selected }); const contextDigest = objectDigest(context);
    const errors = validateVerificationContract('verificationResult', result);
    if (errors.length || result.headSha !== state.verification.headSha || result.contextDigest !== contextDigest) throw new StateError(`Verifier result is malformed or stale: ${errors.join('; ')}`, 'VERIFIER_RESULT_INVALID');
    const fingerprints = result.findings.map((finding) => findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier', finding }));
    const repeated = repeatedFindingFingerprints(root, state, 'verifier', 'development_integration_verifier', fingerprints);
    const capacityPending = { verifierResult: result,
      authorizationRequiredFingerprints: [...new Set([
        ...state.verification.humanDecisionRequiredFingerprints, ...repeated,
      ])] };
    assertStateVerifierCapacity(root, state, capacityPending);
    const verification = { ...state.verification, contextDigest, verifierResultDigest: objectDigest(result),
      unresolvedFindingFingerprints: [...new Set([...state.verification.unresolvedFindingFingerprints, ...fingerprints])],
      humanDecisionRequiredFingerprints: [...new Set([...state.verification.humanDecisionRequiredFingerprints, ...repeated])] };
    const next = revised(state, { phase: fingerprints.length ? 'blocked' : 'verifying', verification,
      blockedReasons: fingerprints.length ? [repeated.length
        ? `Human decision required: final verifier repeated ${repeated.length} semantic finding(s) in consecutive applicable rounds.`
        : 'Final development verifier reported actionable findings.'] : [] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'verifier-result-recorded', summary: `Recorded ${result.status} final development verification`, crashStep,
      pendingEvidence: [{ key: 'verifierContextDigest', path: `verification/rounds/${String(state.verification.round).padStart(4, '0')}/verifier-context.json`, value: context, label: 'development verifier context' },
        { key: 'verifierResultDigest', path: relative(changeDirectory(root, state.changeId), verifierResultPath(root, state)), value: result, label: 'development verifier result' }] });
  }, lockOptions);
}

function findingSourceReceipt(cwd, state, disposition) {
  if (disposition.sourceKind === 'verifier') return verifyReceipt(verifierResultPath(cwd, state), 'verifier finding source');
  return verifyReceipt(specialistResultPath(cwd, state, disposition.sourceRole), `specialist finding source ${disposition.sourceRole}`);
}

function findingDispositionPath(cwd, state, fingerprint, round = state.verification.round) {
  return join(verificationRoundDirectory(cwd, state, round), 'findings', `${fingerprint.slice('sha256:'.length)}.json`);
}

function assertActionableDispositionViability(cwd, state, disposition) {
  if (disposition.disposition !== 'actionable') return;
  const plan = readEffectivePlan(cwd, state);
  if (plan.criteria.some(({ id }) => id === disposition.replacementCriterionId)
      || plan.tasks.some(({ id }) => id === disposition.replacementTaskId)) {
    throw new StateError('Actionable finding replacement criterion and task IDs must be new', 'FINDING_DISPOSITION_INVALID');
  }
  if (verifierCapacityAmendments(cwd, state)
    .some(({ record }) => record.value.amendmentId === disposition.amendmentId)) {
    throw new StateError('Actionable finding amendment ID must be new', 'FINDING_DISPOSITION_INVALID');
  }
  const actionables = findingProjectionRecords(cwd, state)
    .filter(({ round, disposition: receipt }) => round === state.verification.round
      && receipt?.value.disposition === 'actionable')
    .map(({ disposition: receipt }) => receipt.value);
  if (actionables.some((entry) => entry.amendmentId !== disposition.amendmentId)) {
    throw new StateError('Every actionable finding in one round must share one remediation amendment', 'FINDING_DISPOSITION_INVALID');
  }
  if (actionables.some((entry) => entry.replacementCriterionId === disposition.replacementCriterionId
      || entry.replacementTaskId === disposition.replacementTaskId)) {
    throw new StateError('Actionable finding replacement IDs must be unique within the remediation amendment', 'FINDING_DISPOSITION_INVALID');
  }
}

export function recordFindingDisposition({ cwd = process.cwd(), changeId, expectedRevision, disposition, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'blocked' || !state.verification) throw new StateError('Finding disposition requires a blocked verification round', 'INVALID_PHASE');
    assertVerificationHead(root, state, clock, 'Finding disposition');
    const errors = validateVerificationContract('findingDisposition', disposition);
    const source = findingSourceReceipt(root, state, disposition);
    const finding = source.value.findings?.find(({ id }) => id === disposition.findingId);
    if (errors.length || source.digest !== disposition.sourceResultDigest || source.value.headSha !== disposition.headSha || !finding) {
      throw new StateError(`Finding disposition is malformed or does not name exact source evidence: ${errors.join('; ')}`, 'FINDING_DISPOSITION_INVALID');
    }
    const fingerprint = findingFingerprint({ sourceKind: disposition.sourceKind, sourceRole: disposition.sourceRole, finding });
    if (fingerprint !== disposition.fingerprint || !state.verification.unresolvedFindingFingerprints.includes(fingerprint)) throw new StateError('Finding disposition fingerprint is stale or unresolved evidence is missing', 'FINDING_DISPOSITION_INVALID');
    if (state.verification.humanDecisionRequiredFingerprints.includes(fingerprint)) {
      throw new StateError('Repeated finding requires a receipt-protected human authorization before any disposition', 'HUMAN_DECISION_REQUIRED');
    }
    const path = findingDispositionPath(root, state, fingerprint);
    if (existsSync(path)) throw new StateError('Finding already has an immutable disposition', 'FINDING_DISPOSITION_DUPLICATE');
    assertActionableDispositionViability(root, state, disposition);
    assertStateVerifierCapacity(root, state, { disposition });
    const completesNonActionableRound = disposition.disposition !== 'actionable'
      && state.verification.unresolvedFindingFingerprints.every((entry) => entry === fingerprint);
    if (completesNonActionableRound) assertStateVerifierCapacity(root, state, {
      disposition, findingRound: state.verification.round,
      verificationRound: nextVerificationRound(root, state), resetsVerification: true,
    });
    const unresolved = disposition.disposition === 'actionable' ? state.verification.unresolvedFindingFingerprints
      : state.verification.unresolvedFindingFingerprints.filter((entry) => entry !== fingerprint);
    const verification = { ...state.verification, unresolvedFindingFingerprints: unresolved,
      humanDecisionRequiredFingerprints: state.verification.humanDecisionRequiredFingerprints.filter((entry) => entry !== fingerprint) };
    const phase = unresolved.length ? 'blocked' : 'integrated';
    const next = revised(state, { phase, verification, blockedReasons: unresolved.length
      ? [disposition.disposition === 'actionable' ? 'Actionable finding requires its guarded plan amendment and ordinary remediation task.' : 'Verification findings remain unresolved.'] : [] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'finding-disposition-recorded', summary: `Recorded ${disposition.disposition} disposition for ${disposition.findingId}`, crashStep,
      pendingEvidence: [{ key: 'findingDispositionDigest', path: relative(changeDirectory(root, state.changeId), path), value: disposition, label: `finding disposition ${disposition.findingId}` }] });
  }, lockOptions);
}

export function authorizeRepeatedFinding({ cwd = process.cwd(), changeId, expectedRevision, authorization, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'blocked' || !state.verification || !isPlainObject(authorization)
        || !/^sha256:[0-9a-f]{64}$/u.test(authorization.fingerprint ?? '')
        || !nonemptyString(authorization.reason) || !nonemptyString(authorization.authorizedBy)
        || Buffer.byteLength(authorization.reason ?? '', 'utf8') > FINDING_AUTHORIZATION_REASON_MAX_BYTES
        || Buffer.byteLength(authorization.authorizedBy ?? '', 'utf8') > FINDING_AUTHORIZATION_ACTOR_MAX_BYTES
        || Object.keys(authorization).some((key) => !['fingerprint', 'reason', 'authorizedBy'].includes(key))
        || !state.verification.humanDecisionRequiredFingerprints.includes(authorization.fingerprint)) {
      throw new StateError('Human authorization must name one exact repeated finding with reason and authorizer', 'HUMAN_AUTHORIZATION_INVALID');
    }
    assertVerificationHead(root, state, clock, 'Finding authorization');
    const record = { schemaVersion: 1, ...authorization, changeId: state.changeId, headSha: state.verification.headSha,
      verificationRound: state.verification.round, recordedAt: now(clock) };
    assertStateVerifierCapacity(root, state, { authorizationRecord: record,
      authorizationRequiredFingerprints: state.verification.humanDecisionRequiredFingerprints });
    const digest = objectDigest(record);
    const verification = { ...state.verification,
      humanDecisionRequiredFingerprints: state.verification.humanDecisionRequiredFingerprints.filter((entry) => entry !== authorization.fingerprint),
      humanDecisionAuthorizations: [...state.verification.humanDecisionAuthorizations, { fingerprint: authorization.fingerprint, digest }] };
    const next = revised(state, { verification, blockedReasons: ['Human authorization recorded; disposition every exact-source finding before replanning.'] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'finding-human-authorized',
      summary: `Recorded human authorization for repeated finding ${authorization.fingerprint}`, crashStep,
      pendingEvidence: [{ key: 'findingAuthorizationDigest', path: `verification/authorizations/${authorization.fingerprint.slice('sha256:'.length)}/${String(state.verification.round).padStart(4, '0')}.json`,
        value: record, label: 'repeated finding human authorization' }] });
  }, lockOptions);
}

export async function finalizeDevelopment({ cwd = process.cwd(), changeId, expectedRevision, sourceAdapter, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  const before = loadState(root, selected); assertRevision(before, expectedRevision); validateState({ cwd: root, changeId: selected });
  if (before.phase !== 'verifying' || !before.verification?.verifierResultDigest) throw new StateError('Development-ready requires a recorded final verifier result', 'INVALID_PHASE');
  const previousObservation = readObservationByDigest(root, before);
  const refreshed = await captureSourceRefresh({ cwd: root, planningSha: before.planningSha,
    descriptor: previousObservation.descriptor, previousObservation, githubReader: githubReaderFor(sourceAdapter),
    requirePlanningCheckout: false,
    now: () => (clock ? clock() : new Date()) });
  const observation = refreshed.observation ?? refreshed.source ?? refreshed;
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
    if (state.phase !== 'verifying' || !state.verification?.verifierResultDigest) throw new StateError('Development-ready requires a recorded final verifier result', 'INVALID_PHASE');
    const current = assertVerificationHead(root, state, clock, 'Development-ready finalization');
    const timestamp = now(clock);
    assertRefreshChecklistRepresentable(observation);
    const { classification, next: refreshedState } = deriveSourceRefreshTransition(state, {
      previousObservation, observation, timestamp,
    });
    if (classification === 'unreviewed-material') {
      assertStateVerifierCapacity(root, state, { sourceObservation: observation,
        verificationRound: nextVerificationRound(root, state), resetsVerification: true });
    }
    const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
    const material = observation.materialDigest ?? full; const progress = observation.progressDigest ?? full;
    const observationPath = `source/observations/${String(state.revision + 1).padStart(8, '0')}.json`;
    const source = { ...state.source, latestDigest: full, fullDigest: full, materialDigest: material, progressDigest: progress,
      classification: classification === 'progress-only' ? 'unchanged' : classification, observationDigest: objectDigest(observation),
      latestCommentIdentity: observation.source?.latestCommentIdentity ?? observation.latestCommentIdentity ?? observation.latestObservedCommentId ?? state.source.latestCommentIdentity,
      refreshedAt: observation.capturedAt ?? timestamp };
    const checklist = refreshedChecklist(previousObservation, observation, refreshed.checklistComparison);
    if (classification !== 'unchanged') {
      return commitTransition({ cwd: root, previousState: state, nextState: { ...refreshedState, git: current }, type: 'source-refreshed',
        summary: `Final source gate classified ${classification}`, crashStep,
        pendingEvidence: [{ key: 'observationDigest', path: observationPath, value: observation, label: 'final source observation' }] });
    }
    const result = verifyReceipt(verifierResultPath(root, state), 'final verifier result');
    const invalid = state.verification.validationStatus !== 'passed'
      || state.verification.requiredReviewerIds.length !== state.verification.specialistResultDigests.length
      || state.verification.unresolvedFindingFingerprints.length > 0 || result.value.status !== 'clean'
      || state.blockedReasons.length > 0 || state.unresolvedDecisionIds.length > 0
      || state.source.classification !== 'unchanged'
      || state.checklist.some(({ status, externalChange }) => status !== 'current' || externalChange)
      || state.execution.activeWave.length > 0 || state.execution.integrationIntent
      || state.execution.tasks.some(({ status }) => !['integrated', 'no-change'].includes(status));
    if (invalid) throw new StateError('Development-ready gates require one clean exact HEAD and complete clean local evidence', 'DEVELOPMENT_NOT_READY');
    const next = revised(state, { phase: 'development-ready', git: current, source, checklist, blockedReasons: [] }, () => new Date(timestamp));
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'development-finalized',
      summary: `Proved Development-ready at exact HEAD ${current.headSha}`, crashStep,
      pendingEvidence: [{ key: 'observationDigest', path: observationPath, value: observation, label: 'final source observation' }] });
  }, lockOptions);
}

export function rejectTask({ cwd = process.cwd(), changeId, taskId, reason, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withIntegrationOperationLock(root, selected, () => withChangeLock(root, selected, () => {
      const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
      validateState({ cwd: root, changeId: selected }); const task = executionTask(state, taskId);
      if (!nonemptyString(reason)) throw new StateError('Task rejection requires a reason', 'INVALID_REJECTION');
      if (!['bound', 'scheduled', 'running', 'accepted', 'integration-pending', 'blocked', 'failed'].includes(task.status)) throw new StateError(`Task ${taskId} cannot be rejected from ${task.status}`, 'TASK_STATE_CONFLICT');
      const sequencer = runGit(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], { cwd: root, allowFailure: true });
      if (sequencer.status === 0) throw new StateError('Rejecting work requires explicit cherry-pick abort or skip cleanup first', 'CHERRY_PICK_IN_PROGRESS');
      if (sequencer.status !== 1) throw new StateError('Unable to inspect cherry-pick sequencer state', 'CENTRAL_GIT_MISMATCH');
      if (state.execution.integrationIntent && state.execution.integrationIntent.taskId !== taskId) {
        throw new StateError(`Task ${taskId} cannot be rejected while integration intent belongs to ${state.execution.integrationIntent.taskId}`,
          'INTEGRATION_INTENT_TASK_MISMATCH');
      }
      const current = gitObservation(root, clock);
      const requiredHead = state.execution.integrationIntent?.taskId === taskId ? state.execution.integrationIntent.centralBaseSha : state.git.headSha;
      if (!current.clean || current.headSha !== requiredHead || current.branch !== state.git.branch || current.branch === '(detached)') throw new StateError('Rejecting work requires the exact clean owning branch at the pre-conflict base', 'CENTRAL_GIT_MISMATCH');
      assertStateVerifierCapacity(root, state, { rejectedTaskId: taskId });
      // Persisting an integration intent is allowed only when blockers are the
      // exact receipt-backed task blockers, then deliberately clears the
      // mutable blocker list. Rejection of that intent owner regenerates those
      // blockers from receipts instead of treating the cleared list as loss.
      const preservedBlockers = state.execution.integrationIntent ? [] : nonTaskBlockers(root, state);
      const execution = replaceExecutionTask(state, taskId, { status: 'rejected' }, { activeWave: state.execution.activeWave.filter((id) => id !== taskId), integrationIntent: null });
      const timestamp = now(clock);
      const rejection = { schemaVersion: 1, changeId: state.changeId, taskId, binding: task.binding, reason, rejectedAt: timestamp };
      const taskBlockers = canonicalTaskBlockers(root, state, execution, { taskId, rejection });
      const next = revised(state, { phase: 'blocked', execution, git: current,
        blockedReasons: [...preservedBlockers, ...taskBlockers] }, () => new Date(timestamp));
      return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-rejected', summary: `Rejected implementation task ${taskId}`, crashStep,
        pendingEvidence: [{ key: 'taskRejectionDigest', path: `implementation/rejections/${taskId}/${String(next.revision).padStart(8, '0')}.json`,
          value: rejection, label: `task rejection ${taskId}` }] });
    }, lockOptions), lockOptions);
}

// Descriptive aliases keep the programmatic API explicit while the CLI uses
// the concise operator-facing command names.
export const bindImplementationTask = bindTask;
export const scheduleImplementationWave = scheduleWave;
export const startImplementationTask = startTask;
export const acceptImplementationResult = acceptResult;

function classifyRefresh(previous, observation, supplied) {
  if (supplied) return supplied;
  const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
  const material = observation.materialDigest ?? full;
  const progress = observation.progressDigest ?? full;
  if (full === previous.fullDigest) return 'unchanged';
  if (material === previous.materialDigest && progress !== previous.progressDigest) return 'progress-only';
  return 'unreviewed-material';
}

function deriveSourceRefreshTransition(state, { previousObservation, initialObservation = previousObservation,
  observation, timestamp, suppliedClassification } = {}) {
  const observedClassification = classifyRefresh(state.source, observation, suppliedClassification);
  const classification = state.plan && state.source.classification === 'unreviewed-material'
    ? 'unreviewed-material'
    : state.plan && state.source.classification === 'progress-only' && observedClassification === 'unchanged'
      ? 'progress-only' : observedClassification;
  const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
  const material = observation.materialDigest ?? full;
  const progress = observation.progressDigest ?? full;
  const comparison = compareChecklistMappings(
    previousObservation.source?.checklist ?? [], observation.source?.checklist ?? [],
  );
  const planningComparison = state.plan ? null : compareChecklistMappings(
    initialObservation.source?.checklist ?? [], observation.source?.checklist ?? [],
  );
  const late = ['integrated', 'validating', 'specialist-review', 'verifying'].includes(state.phase);
  const lateProgress = late && classification === 'progress-only';
  const next = revised(state, {
    phase: state.plan && classification === 'unreviewed-material' ? 'awaiting-decision' : lateProgress ? 'integrated' : state.phase,
    source: {
      ...state.source,
      latestDigest: full,
      fullDigest: full,
      materialDigest: material,
      progressDigest: progress,
      classification: lateProgress ? 'unchanged' : classification,
      observationDigest: objectDigest(observation),
      latestCommentIdentity: observation.source?.latestCommentIdentity ?? observation.latestCommentIdentity
        ?? observation.latestObservedCommentId ?? state.source.latestCommentIdentity,
      refreshedAt: observation.capturedAt ?? timestamp,
    },
    checklist: state.plan
      ? refreshedChecklist(previousObservation, observation, comparison)
      : planningChecklist(initialObservation, observation, planningComparison),
    ...(lateProgress ? { verification: null, blockedReasons: [] } : {}),
  }, () => new Date(timestamp));
  return { classification, late, next };
}

function assertRefreshChecklistRepresentable(observation) {
  for (const item of observation.source?.checklist ?? []) {
    const fields = [['capturedText', item.text]];
    if (item.identity?.kind === 'legacy-position') {
      fields.push(['legacy identity text', item.identity.text ?? item.text]);
    }
    for (const [field, value] of fields) {
      if (typeof value === 'string' && [...value].length > IMPLEMENTATION_PLAN_TEXT_MAX_CODE_POINTS) {
        throw new StateError(
          `Source checklist item ${item.checklistItemId ?? item.id ?? 'unknown'} ${field} exceeds the implementation-plan 4000-code-point limit`,
          'SOURCE_CHECKLIST_UNREPRESENTABLE',
        );
      }
    }
  }
}

export async function refreshSource({ cwd = process.cwd(), changeId, expectedRevision, sourceAdapter, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  const before = loadState(root, selected);
  if (!before) throw new StateError('No active change state', 'STATE_NOT_FOUND');
  assertRevision(before, expectedRevision);
  validateState({ cwd: root, changeId: selected });
  const refreshablePhases = ['planning', 'awaiting-decision', 'ready-to-implement', 'integrated', 'validating', 'specialist-review', 'verifying'];
  if (!refreshablePhases.includes(before.phase)) {
    throw new StateError(`Source refresh is not permitted in phase ${before.phase}`, 'INVALID_PHASE');
  }
  // The live read is intentionally outside the state lock.
  const previousObservation = readObservationByDigest(root, before);
  const refreshed = await captureSourceRefresh({
    cwd: root,
    planningSha: before.planningSha,
    requirePlanningCheckout: !['integrated', 'validating', 'specialist-review', 'verifying'].includes(before.phase),
    descriptor: previousObservation.descriptor,
    previousObservation,
    githubReader: githubReaderFor(sourceAdapter),
    now: () => (clock ? clock() : new Date()),
  });
  const observation = refreshed.observation ?? refreshed.source ?? refreshed;
  return withChangeLock(root, before.changeId, () => {
    const state = loadState(root, before.changeId);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    if (!refreshablePhases.includes(state.phase)) {
      throw new StateError(`Source refresh is not permitted in phase ${state.phase}`, 'INVALID_PHASE');
    }
    const lockedGit = gitObservation(root, clock);
    const late = ['integrated', 'validating', 'specialist-review', 'verifying'].includes(state.phase);
    const expectedHead = late ? state.git.headSha : state.planningSha;
    const expectedBranch = late ? state.git.branch : lockedGit.branch;
    if (!lockedGit.clean || lockedGit.headSha !== expectedHead || (late && lockedGit.branch !== expectedBranch)) {
      throw new StateError(late ? 'Late source refresh requires the exact clean integrated HEAD' : 'Source refresh requires clean HEAD at the Planning SHA',
        late ? 'VERIFICATION_HEAD_MISMATCH' : 'PLANNING_SNAPSHOT_MISMATCH');
    }
    const timestamp = now(clock);
    assertRefreshChecklistRepresentable(observation);
    const observationPath = `source/observations/${String(state.revision + 1).padStart(8, '0')}.json`;
    const planningBaseline = state.plan ? null : readInitialObservation(root, state);
    const { classification, next } = deriveSourceRefreshTransition(state, { previousObservation,
      initialObservation: planningBaseline ?? previousObservation, observation, timestamp });
    if (state.plan && classification === 'unreviewed-material') {
      assertStateVerifierCapacity(root, state, { sourceObservation: observation,
        verificationRound: nextVerificationRound(root, state), resetsVerification: true });
    }
    return commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'source-refreshed',
      summary: `Source refresh classified ${classification}`, crashStep,
      pendingEvidence: [{ key: 'observationDigest', path: observationPath, value: observation, label: 'source observation' }],
    });
  }, lockOptions);
}

function deriveDecisionTransition(state, decision, currentGit, timestamp) {
  const retainPlan = decision.disposition === 'retain-plan';
  const late = state.schemaVersion === 2
    && state.execution?.tasks.every((task) => ['integrated', 'no-change'].includes(task.status));
  const unresolved = state.unresolvedDecisionIds.filter((id) => id !== decision.id);
  const resolvedPhase = state.phase === 'awaiting-decision' && !retainPlan
    && unresolved.length === 0 && state.source.classification !== 'unreviewed-material'
    ? 'planning' : state.phase;
  return revised(state, {
    unresolvedDecisionIds: unresolved,
    phase: retainPlan && unresolved.length === 0 ? late ? 'integrated' : 'ready-to-implement' : resolvedPhase,
    source: retainPlan ? { ...state.source, classification: 'unchanged' } : state.source,
    git: currentGit,
    blockedReasons: retainPlan ? [] : state.blockedReasons,
    ...(retainPlan && late ? { verification: null } : {}),
  }, () => new Date(timestamp));
}

export function recordDecision({ cwd = process.cwd(), changeId, decision, expectedRevision, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, changeId);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    const allowedDecisionKeys = ['id', 'reason', 'authorization', 'trigger', 'disposition'];
    if (!isPlainObject(decision) || !allowedDecisionKeys.every((key) => nonemptyString(decision[key]))
        || Object.keys(decision).some((key) => !allowedDecisionKeys.includes(key))
        || !['resolve', 'retain-plan'].includes(decision.disposition)) {
      throw new StateError('Decision requires strict nonempty id, reason, authorization, trigger, and resolve|retain-plan disposition', 'INVALID_DECISION');
    }
    validateChangeId(decision.id);
    if (state.phase !== 'awaiting-decision' || !state.plan) {
      throw new StateError('record-decision requires an accepted plan in awaiting-decision', 'INVALID_PHASE');
    }
    const decisionPath = join(changeDirectory(root, state.changeId), 'decisions', `${decision.id}.json`);
    if (existsSync(decisionPath) || existsSync(decisionPath.replace(/\.json$/u, '.sha256'))) {
      throw new StateError(`Decision ID ${decision.id} already exists`, 'DECISION_ID_CONFLICT');
    }
    const retainPlan = decision.disposition === 'retain-plan';
    if (retainPlan && !(state.phase === 'awaiting-decision' && state.plan
        && state.source.classification === 'unreviewed-material' && state.blockedReasons.length === 0)) {
      throw new StateError('retain-plan requires accepted material drift in awaiting-decision', 'INVALID_DECISION');
    }
    const currentGit = gitObservation(root, clock);
    const late = state.schemaVersion === 2 && state.execution?.tasks.every((task) => ['integrated', 'no-change'].includes(task.status));
    const requiredHead = late ? state.git.headSha : state.planningSha;
    if (retainPlan && (!currentGit.clean || currentGit.headSha !== requiredHead
        || (late && currentGit.branch !== state.git.branch))) {
      throw new StateError(late ? 'Late retain-plan requires the exact clean integrated HEAD' : 'retain-plan requires clean HEAD at the Planning SHA',
        late ? 'VERIFICATION_HEAD_MISMATCH' : 'PLANNING_SNAPSHOT_MISMATCH');
    }
    if (!retainPlan) assertStateVerifierCapacity(root, state, { decisionResolution: decision,
      verificationRound: nextVerificationRound(root, state), resetsVerification: true });
    const timestamp = now(clock);
    const record = {
      schemaVersion: 1, ...decision, changeId: state.changeId,
      stateRevision: state.revision,
      sourceObservationDigest: state.source.observationDigest,
      sourceDigest: state.source.latestDigest,
      effectivePlanDigest: state.plan?.effectiveDigest ?? null,
      repositorySha: currentGit.headSha, recordedAt: timestamp,
    };
    const next = deriveDecisionTransition(state, decision, currentGit, timestamp);
    return commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'decision-recorded',
      summary: `Recorded decision ${decision.id}`, crashStep,
      pendingEvidence: [{ key: 'decisionDigest', path: `decisions/${decision.id}.json`, value: record, label: `decision ${decision.id}` }],
    });
  }, lockOptions);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validUniqueStrings(values) {
  return Array.isArray(values) && values.every(nonemptyString) && new Set(values).size === values.length;
}

function hasBoundResolveDecision(cwd, state, decisionId) {
  try { validateChangeId(decisionId); } catch { return false; }
  const relativePath = `decisions/${decisionId}.json`;
  const path = join(changeDirectory(cwd, state.changeId), relativePath);
  const receiptPath = path.replace(/\.json$/u, '.sha256');
  if (!existsSync(path) && !existsSync(receiptPath)) return false;
  const record = verifyReceipt(path, 'amendment prerequisite decision').value;
  const transition = verifyReceipt(join(changeDirectory(cwd, state.changeId), 'transitions',
    String(state.revision).padStart(8, '0'), 'intent.json'), 'decision transition intent', TRANSITION_INTENT_LIMIT_BYTES).value;
  return record.id === decisionId
    && record.changeId === state.changeId
    && record.disposition === 'resolve'
    && record.stateRevision === state.revision - 1
    && record.sourceObservationDigest === state.source.observationDigest
    && record.sourceDigest === state.source.latestDigest
    && record.effectivePlanDigest === state.plan.effectiveDigest
    && transition.type === 'decision-recorded'
    && transition.nextStateDigest === objectDigest(state)
    && Object.values(transition.evidencePaths ?? {}).includes(relativePath);
}

function hasBoundFailedValidation(cwd, state, trigger) {
  if (state.phase !== 'validating' || state.verification?.validationStatus !== 'failed'
      || !trigger.startsWith('validation-failure:')) return false;
  const digest = trigger.slice('validation-failure:'.length);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || !state.verification.validationResultDigests.includes(digest)) return false;
  const directory = join(verificationRoundDirectory(cwd, state), 'validation-results');
  return existsSync(directory) && readdirSync(directory).filter((name) => name.endsWith('.json')).some((name) => {
    const receipt = verifyReceipt(join(directory, name), `failed validation result ${name}`);
    return receipt.digest === digest && receipt.value.status === 'failed'
      && receipt.value.headSha === state.verification.headSha
      && receipt.value.planDigest === state.verification.validationPlanDigest;
  });
}

function deriveAmendedTransition(state, resultingPlan, currentGit, timestamp, number) {
  const terminalTasks = state.schemaVersion === 2
    ? state.execution.tasks.filter((task) => ['integrated', 'no-change'].includes(task.status)) : [];
  const amendedExecution = state.schemaVersion === 2 ? executionFromPlan(resultingPlan, currentGit.headSha) : null;
  if (amendedExecution) amendedExecution.tasks = amendedExecution.tasks.map((task) => {
    const terminal = terminalTasks.find((entry) => entry.id === task.id); return terminal ?? task;
  });
  const newDigest = objectDigest(resultingPlan);
  return revised(state, {
    phase: state.schemaVersion === 2 && state.mode !== 'plan-only' ? 'implementing' : 'ready-to-implement',
    plan: { ...state.plan, revision: resultingPlan.planRevision, effectiveDigest: newDigest, amendmentCount: number,
      sourceCaptureDigest: resultingPlan.source.captureDigest },
    source: { ...state.source, classification: 'unchanged' },
    git: currentGit,
    unresolvedDecisionIds: resultingPlan.decisions.filter((decision) => decision.status !== 'resolved').map((decision) => decision.id),
    checklist: resultingPlan.checklistMappings.map((mapping) => ({
      id: mapping.id, checked: mapping.checked, status: mapping.status, externalChange: mapping.externalChange,
    })),
    blockedReasons: [],
    ...(state.schemaVersion === 2 ? { execution: amendedExecution, verification: null } : {}),
  }, () => new Date(timestamp));
}

export function amendPlan({ cwd = process.cwd(), changeId, amendment, resultingPlan, planningEvidence = [], expectedRevision, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, changeId);
    if (!state?.plan) throw new StateError('An accepted plan is required before amendment', 'PLAN_NOT_ACCEPTED');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    if (!['ready-to-implement', 'awaiting-decision', 'implementing', 'validating', 'blocked'].includes(state.phase)) {
      throw new StateError(`Plan amendment is not permitted in phase ${state.phase}`, 'INVALID_PHASE');
    }
    if (!isPlainObject(amendment) || !['id', 'reason', 'authorization', 'trigger'].every((key) => nonemptyString(amendment[key]))
        || !isPlainObject(amendment.delta) || Object.keys(amendment.delta).length === 0
        || !validUniqueStrings(amendment.invalidatedEvidence)
        || Object.keys(amendment).some((key) => !['id', 'reason', 'authorization', 'trigger', 'delta', 'invalidatedEvidence'].includes(key))) {
      throw new StateError('Amendment requires strict id, reason, trigger, authorization, delta, and invalidatedEvidence', 'INVALID_AMENDMENT');
    }
    validateChangeId(amendment.id);
    if (state.phase === 'awaiting-decision' && !hasBoundResolveDecision(root, state, amendment.trigger)) {
      throw new StateError('Material-drift amendment trigger must name the bound resolve decision for the current source, plan, and revision', 'DECISION_REQUIRED');
    }
    for (let existingNumber = 1; existingNumber <= state.plan.amendmentCount; existingNumber += 1) {
      const existingPath = join(changeDirectory(root, state.changeId), 'plan', 'amendments', `${String(existingNumber).padStart(4, '0')}.json`);
      if (verifyReceipt(existingPath, `plan amendment ${existingNumber}`).value.amendmentId === amendment.id) {
        throw new StateError(`Amendment ID ${amendment.id} already exists`, 'AMENDMENT_ID_CONFLICT');
      }
    }
    const currentGit = gitObservation(root, clock);
    if (!currentGit.clean || currentGit.headSha !== state.git.headSha || currentGit.branch !== state.git.branch
        || resultingPlan.planning?.planningSha !== state.planningSha) {
      throw new StateError('Amendment requires a clean central checkout and must retain the immutable Planning SHA', 'PLANNING_SNAPSHOT_MISMATCH');
    }
    assertPlanStateIdentity(resultingPlan, state);
    if (resultingPlan.planRevision !== state.plan.revision + 1) {
      throw new StateError('Resulting plan revision must follow the effective plan revision', 'PLAN_STATE_MISMATCH');
    }
    const sourceObservation = readObservationByDigest(root, state);
    const prior = readEffectivePlan(root, state);
    if (objectDigest(prior) !== state.plan.effectiveDigest) throw new StateError('Effective plan receipt is inconsistent', 'PLAN_TAMPERED');
    const validationDriven = hasBoundFailedValidation(root, state, amendment.trigger);
    if (state.phase === 'validating' && !validationDriven) {
      throw new StateError('Failed-validation remediation trigger must name an exact receipt-bound failed result', 'INVALID_AMENDMENT');
    }
    const findingDriven = /^sha256:[0-9a-f]{64}$/u.test(amendment.trigger);
    const sourceDriven = state.phase === 'awaiting-decision';
    if (findingDriven && !state.verification) throw new StateError('Finding-driven amendment requires active verification evidence', 'INVALID_AMENDMENT');
    if (state.verification && !findingDriven && !validationDriven && !sourceDriven) throw new StateError('Verification-state amendments require exact finding, failed-validation, or source-decision authority', 'INVALID_AMENDMENT');
    let errors = readinessErrors(resultingPlan, planningEvidence, sourceObservation,
      ({ planningSha, path }) => readTreeFile(root, planningSha, path));
    if (findingDriven || validationDriven || sourceDriven) {
      if (serialized(resultingPlan.specialization) !== serialized(prior.specialization)) throw new StateError('Finding-driven amendment cannot reinterpret the completed change specialization', 'INVALID_AMENDMENT');
      const terminalIds = state.execution.tasks.filter(({ status }) => ['integrated', 'no-change'].includes(status)).map(({ id }) => id);
      const terminalLabels = terminalIds.map((id) => `task ${id}`);
      const remediationIds = new Set();
      for (const fingerprint of state.verification?.unresolvedFindingFingerprints ?? []) {
        const path = findingDispositionPath(root, state, fingerprint);
        if (!existsSync(path)) continue;
        const disposition = verifyReceipt(path, `finding disposition ${fingerprint}`).value;
        if (disposition.disposition === 'actionable' && disposition.amendmentId === amendment.id) remediationIds.add(disposition.replacementTaskId);
      }
      errors = errors.filter((error) => !(error.startsWith('global:') || error.startsWith('global.route')
        || error.startsWith('derived specialist aggregate') || terminalLabels.some((label) => error.startsWith(`${label}:`) || error.startsWith(`${label}.route`))
        || (() => {
          const match = /^tasks ([a-z0-9]+(?:-[a-z0-9]+)*) and ([a-z0-9]+(?:-[a-z0-9]+)*) have overlapping anticipated paths:/u.exec(error);
          if (!match) return false;
          const leftTerminal = terminalIds.includes(match[1]); const rightTerminal = terminalIds.includes(match[2]);
          return (leftTerminal && rightTerminal)
            || (leftTerminal && remediationIds.has(match[2]))
            || (rightTerminal && remediationIds.has(match[1]));
        })()));
    }
    if (errors.length > 0) throw new StateError(`Amended plan is not ready:\n- ${errors.join('\n- ')}`, 'PLAN_NOT_READY');
    if (validationDriven) {
      const newCriteria = resultingPlan.criteria.filter(({ id }) => !prior.criteria.some((entry) => entry.id === id));
      const newTasks = resultingPlan.tasks.filter(({ id }) => !prior.tasks.some((entry) => entry.id === id));
      if (newCriteria.length === 0 || !newTasks.some(({ criterionIds }) => criterionIds.some((id) => newCriteria.some((criterion) => criterion.id === id)))) {
        throw new StateError('Failed-validation remediation must add an ordinary owned criterion and linked task', 'INVALID_AMENDMENT');
      }
    }
    if (findingDriven) {
      const dispositionPath = findingDispositionPath(root, state, amendment.trigger);
      const disposition = verifyReceipt(dispositionPath, 'finding-driven amendment disposition').value;
      if (disposition.disposition !== 'actionable' || disposition.fingerprint !== amendment.trigger
          || disposition.amendmentId !== amendment.id
          || prior.criteria.some(({ id }) => id === disposition.replacementCriterionId)
          || prior.tasks.some(({ id }) => id === disposition.replacementTaskId)
          || !resultingPlan.criteria.some(({ id }) => id === disposition.replacementCriterionId)
          || !resultingPlan.tasks.some(({ id, criterionIds }) => id === disposition.replacementTaskId
            && criterionIds.includes(disposition.replacementCriterionId))) {
        throw new StateError('Finding-driven amendment must add the disposition-bound ordinary criterion and task', 'INVALID_AMENDMENT');
      }
      for (const fingerprint of state.verification?.unresolvedFindingFingerprints ?? []) {
        const siblingPath = findingDispositionPath(root, state, fingerprint);
        const sibling = verifyReceipt(siblingPath, `actionable finding disposition ${fingerprint}`).value;
        if (sibling.disposition !== 'actionable' || sibling.amendmentId !== amendment.id
            || prior.criteria.some(({ id }) => id === sibling.replacementCriterionId)
            || prior.tasks.some(({ id }) => id === sibling.replacementTaskId)
            || !resultingPlan.criteria.some(({ id }) => id === sibling.replacementCriterionId)
            || !resultingPlan.tasks.some(({ id, criterionIds }) => id === sibling.replacementTaskId
              && criterionIds.includes(sibling.replacementCriterionId))) {
          throw new StateError('Finding-driven amendment must cover every remaining actionable sibling finding', 'INVALID_AMENDMENT');
        }
      }
    }
    const repositorySha = currentGit.headSha;
    const newDigest = objectDigest(resultingPlan);
    const timestamp = now(clock);
    const record = {
      schemaVersion: 1,
      amendmentId: amendment.id,
      reason: amendment.reason,
      trigger: amendment.trigger ?? null,
      delta: amendment.delta,
      previousDigest: state.plan.effectiveDigest,
      newDigest,
      repositorySha,
      authorization: amendment.authorization,
      invalidatedEvidence: amendment.invalidatedEvidence ?? [],
      resultingPlan,
      createdAt: timestamp,
    };
    const number = state.plan.amendmentCount + 1;
    const terminalTasks = state.schemaVersion === 2 ? state.execution.tasks.filter((task) => ['integrated', 'no-change'].includes(task.status)) : [];
    for (const terminal of terminalTasks) {
      const before = prior.tasks.find((task) => task.id === terminal.id); const after = resultingPlan.tasks.find((task) => task.id === terminal.id);
      if (!before || !after || serialized(before) !== serialized(after)) throw new StateError(`Amendment cannot change or remove completed task ${terminal.id}`, 'EXECUTION_PLAN_IMMUTABLE');
      for (const id of before.decisionIds) if (serialized(prior.decisions.find((entry) => entry.id === id)) !== serialized(resultingPlan.decisions.find((entry) => entry.id === id))) throw new StateError(`Amendment cannot change completed task ${terminal.id} decision ${id}`, 'EXECUTION_PLAN_IMMUTABLE');
      for (const id of before.criterionIds) if (serialized(prior.criteria.find((entry) => entry.id === id)) !== serialized(resultingPlan.criteria.find((entry) => entry.id === id))) throw new StateError(`Amendment cannot change completed task ${terminal.id} criterion ${id}`, 'EXECUTION_PLAN_IMMUTABLE');
    }
    const rejectedTasks = state.schemaVersion === 2 ? state.execution.tasks.filter((task) => task.status === 'rejected') : [];
    for (const rejected of rejectedTasks) {
      if (resultingPlan.tasks.some((task) => task.id === rejected.id)) throw new StateError(`Amendment must replace rejected task ${rejected.id} with a new task ID`, 'EXECUTION_PLAN_IMMUTABLE');
      const creationPath = implementationWorktreeCreationIntentPath(root, state.changeId, rejected.id);
      const manifestPath = implementationWorktreeManifestPath(root, state.changeId, rejected.id);
      const removalPath = implementationWorktreeRemovalIntentPath(root, state.changeId, rejected.id);
      const tombstonePath = implementationWorktreeTombstonePath(root, state.changeId, rejected.id);
      const canonicalWorktreePath = resolve(implementationWorktreePath(root, state.changeId, rejected.id));
      const hasWorktreeEvidence = [creationPath, manifestPath, removalPath, tombstonePath]
        .some((path) => existsSync(path) || existsSync(path.replace(/\.json$/u, '.sha256')));
      const hasPhysicalWorktree = existsSync(canonicalWorktreePath)
        || registeredWorktrees(root).some((entry) => entry.path === canonicalWorktreePath);
      if (hasWorktreeEvidence || hasPhysicalWorktree) {
        const creation = verifyReceipt(creationPath, `rejected worktree creation intent ${rejected.id}`);
        const manifest = verifyReceipt(manifestPath, `rejected worktree manifest ${rejected.id}`);
        const removal = verifyReceipt(removalPath, `rejected worktree removal intent ${rejected.id}`);
        const tombstone = verifyReceipt(tombstonePath, `rejected worktree tombstone ${rejected.id}`).value;
        const identityMismatch = [creation.value, manifest.value, removal.value, tombstone].some((record) =>
          record.changeId !== state.changeId || record.taskId !== rejected.id
          || record.packetDigest !== rejected.packetDigest || record.baseSha !== rejected.taskBaseSha
          || resolve(record.path) !== canonicalWorktreePath || record.repository !== gitCommonDirectory(root));
        if (creation.value.status !== 'creating' || manifest.value.status !== 'active'
            || manifest.value.creationIntentDigest !== creation.digest || removal.value.status !== 'removing'
            || removal.value.manifestDigest !== manifest.digest || tombstone.status !== 'removed'
            || tombstone.manifestDigest !== manifest.digest || tombstone.removalIntentDigest !== removal.digest
            || tombstone.removedAt !== removal.value.removedAt || identityMismatch
            || tombstone.changeId !== state.changeId || tombstone.taskId !== rejected.id
            || tombstone.packetDigest !== rejected.packetDigest || hasPhysicalWorktree) {
          throw new StateError(`Rejected task ${rejected.id} worktree is not safely removed`, 'WORKTREE_TOMBSTONE_MISMATCH');
        }
      }
      const suffix = `${rejected.id}/${String(rejected.binding).padStart(4, '0')}.json`;
      const requiredInvalidations = [taskEvidencePath(rejected.id, rejected.binding), `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`];
      const rejectedPacket = verifyReceipt(implementationTaskPacketPath(root, state.changeId, rejected.id, rejected.binding), `rejected task packet ${rejected.id}`).value;
      if (rejectedPacket.behaviorMapperEvidence !== null) requiredInvalidations.push(`implementation/behavior-mapper/${suffix}`);
      if (rejected.resultDigest !== null) requiredInvalidations.push(resultEvidencePath(rejected.id, rejected.attempt));
      for (const path of requiredInvalidations) if (!amendment.invalidatedEvidence.includes(path)) throw new StateError(`Amendment invalidatedEvidence must name ${path}`, 'INVALID_AMENDMENT');
    }
    if (state.schemaVersion === 2 && state.execution.tasks.some((task) => !['unbound', 'integrated', 'no-change', 'rejected'].includes(task.status))) {
      throw new StateError('Reject active, accepted, blocked, or failed task evidence before amending the plan', 'EXECUTION_PLAN_IMMUTABLE');
    }
    assertStateVerifierCapacity(root, state, { effectivePlan: resultingPlan,
      effectivePlanDigest: newDigest, planningEvidence,
      amendments: verifierCapacityAmendments(root, state, { record, planningEvidence }) });
    const next = deriveAmendedTransition(state, resultingPlan, currentGit, timestamp, number);
    return commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'plan-amended',
      summary: `Appended plan amendment ${amendment.id}`, crashStep,
      pendingEvidence: [
        { key: 'amendmentDigest', path: `plan/amendments/${String(number).padStart(4, '0')}.json`, value: record, label: `plan amendment ${number}` },
        { key: 'planningEvidenceDigest', path: `plan/amendments/${String(number).padStart(4, '0')}.evidence.json`, value: planningEvidence,
          label: `plan amendment ${number} planning evidence` },
      ],
    });
  }, lockOptions);
}

function transitionInventory(cwd, changeId) {
  const root = join(changeDirectory(cwd, changeId), 'transitions');
  if (!existsSync(root)) return { committed: [], pending: [] };
  const entries = readdirSync(root, { withFileTypes: true });
  const stagingPattern = /^\.\d{8}\.\d+\.[0-9a-f-]{36}\.pending$/u;
  const unexpected = entries.find((entry) => !entry.isDirectory()
    || (!/^\d{8}$/u.test(entry.name) && !stagingPattern.test(entry.name)));
  if (unexpected) throw new StateError(`Unexpected transition evidence entry ${unexpected.name}`, 'RECOVERY_EVIDENCE_INVALID');
  return {
    committed: entries.filter((entry) => /^\d{8}$/u.test(entry.name)).map((entry) => join(root, entry.name)).sort(),
    pending: entries.filter((entry) => stagingPattern.test(entry.name)).map((entry) => join(root, entry.name)).sort(),
  };
}

function transitionEntries(cwd, changeId) {
  return transitionInventory(cwd, changeId).committed;
}

function cleanupUncommittedTransitionStaging(cwd, changeId) {
  const root = join(changeDirectory(cwd, changeId), 'transitions');
  if (!existsSync(root)) return 0;
  const stagingPattern = /^\.\d{8}\.\d+\.[0-9a-f-]{36}\.pending$/u;
  const staging = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && stagingPattern.test(entry.name));
  for (const entry of staging) {
    const directory = join(root, entry.name);
    const children = readdirSync(directory, { withFileTypes: true });
    const valid = children.every((child) => !child.isDirectory() && (child.name === 'intent.json' || child.name === 'intent.sha256'
      || /^\.intent\.(?:json|sha256)\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(child.name)));
    if (!valid) throw new StateError(`Uncommitted transition staging ${entry.name} contains unexpected evidence`, 'RECOVERY_EVIDENCE_INVALID');
    for (const child of children) unlinkSync(join(directory, child.name));
    rmdirSync(directory);
  }
  if (staging.length > 0) fsyncDirectory(root);
  return staging.length;
}

function isUncommittedTransitionShell(cwd, changeId) {
  const directory = changeDirectory(cwd, changeId);
  const root = join(directory, 'transitions');
  if (!existsSync(directory)) return false;
  const directoryEntries = readdirSync(directory);
  if (directoryEntries.length === 0) return true;
  if (!existsSync(root) || directoryEntries.some((name) => name !== 'transitions')) return false;
  const stagingPattern = /^\.\d{8}\.\d+\.[0-9a-f-]{36}\.pending$/u;
  return readdirSync(root, { withFileTypes: true }).every((entry) => {
    if (!entry.isDirectory() || !stagingPattern.test(entry.name)) return false;
    return readdirSync(join(root, entry.name), { withFileTypes: true }).every((child) => !child.isDirectory()
      && (child.name === 'intent.json' || child.name === 'intent.sha256'
        || /^\.intent\.(?:json|sha256)\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(child.name)));
  });
}

function cleanupAtomicEventTemps(cwd, changeId) {
  const directory = changeDirectory(cwd, changeId);
  if (!existsSync(directory)) return 0;
  const names = readdirSync(directory).filter((name) => /^\.events\.jsonl\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(name));
  for (const name of names) unlinkSync(join(directory, name));
  if (names.length > 0) fsyncDirectory(directory);
  return names.length;
}

function authoritativeEvidenceRecords(intent) {
  const records = intent.authoritativeEvidence;
  if (!records || typeof records !== 'object' || Array.isArray(records)
      || serialized(Object.keys(records).sort()) !== serialized(Object.keys(intent.evidence ?? {}).sort())) {
    throw new StateError(`Transition ${intent.revision} lacks authoritative pending evidence`, 'RECOVERY_EVIDENCE_INVALID');
  }
  const paths = new Set();
  for (const [key, record] of Object.entries(records)) {
    const segments = typeof record?.path === 'string' ? record.path.split('/') : [];
    const canonicalRoot = record?.path === 'worktree.json'
      || /^(?:source|plan|decisions|implementation|verification)\//u.test(record?.path ?? '');
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !nonemptyString(record.path) || !nonemptyString(record.label)
        || record.path !== intent.evidencePaths?.[key] || record.digest !== intent.evidence[key]
        || objectDigest(record.value) !== record.digest || paths.has(record.path)
        || !record.path.endsWith('.json') || !canonicalRoot || record.path.includes('\\')
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new StateError(`Transition ${intent.revision} authoritative evidence ${key} is inconsistent`, 'RECOVERY_EVIDENCE_INVALID');
    }
    paths.add(record.path);
  }
  return records;
}

function cleanupAtomicWriteTemps(path) {
  const name = basename(path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^\\.${name}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`, 'u');
  const directory = dirname(path);
  if (!existsSync(directory)) return;
  const temporary = readdirSync(directory).filter((entry) => pattern.test(entry));
  for (const entry of temporary) unlinkSync(join(directory, entry));
  if (temporary.length > 0) fsyncDirectory(directory);
}

function materializeIntentEvidence(cwd, changeId, intent) {
  const directory = changeDirectory(cwd, changeId);
  for (const [key, record] of Object.entries(authoritativeEvidenceRecords(intent))) {
    const path = join(directory, record.path);
    const receiptPath = path.replace(/\.json$/u, '.sha256');
    cleanupAtomicWriteTemps(path);
    cleanupAtomicWriteTemps(receiptPath);
    const hasJson = existsSync(path);
    const hasReceipt = existsSync(receiptPath);
    if (hasJson) {
      const value = readJson(path, `transition ${intent.revision} evidence ${key}`);
      if (serialized(value) !== serialized(record.value) || objectDigest(value) !== record.digest) {
        throw new StateError(`Transition ${intent.revision} evidence ${key} conflicts with its intent`, 'RECOVERY_EVIDENCE_INVALID');
      }
    }
    if (hasReceipt) {
      const receipt = readFileSync(receiptPath, 'utf8').trim();
      if (receipt !== record.digest) {
        throw new StateError(`Transition ${intent.revision} evidence ${key} receipt conflicts with its intent`, 'RECOVERY_EVIDENCE_INVALID');
      }
    }
    if (!hasJson) atomicWriteText(path, serialized(record.value));
    if (!hasReceipt) atomicWriteText(receiptPath, `${record.digest}\n`);
    verifyReceipt(path, `transition ${intent.revision} evidence ${key}`);
  }
}

function verifyCompleteTransition(directory) {
  const intent = verifyReceipt(join(directory, 'intent.json'), 'transition intent', TRANSITION_INTENT_LIMIT_BYTES).value;
  const receipt = verifyReceipt(join(directory, 'receipt.json'), 'transition receipt').value;
  const marker = readFileSync(join(directory, 'complete'), 'utf8').trim();
  if (!nonemptyString(intent.changeId) || !nonemptyString(intent.type) || !nonemptyString(intent.summary)
    || intent.nextState?.changeId !== intent.changeId || intent.nextState?.revision !== intent.revision
    || receipt.revision !== intent.revision || receipt.intentDigest !== objectDigest(intent) || receipt.stateDigest !== intent.nextStateDigest
    || serialized(receipt.evidence) !== serialized(intent.evidence)
    || receipt.completedAt !== intent.nextState.updatedAt
    || objectDigest(intent.nextState) !== intent.nextStateDigest || marker !== objectDigest(receipt)) {
    throw new StateError(`Transition evidence is tampered at ${directory}`, 'RECOVERY_EVIDENCE_INVALID');
  }
  assertValidState(intent.nextState);
  authoritativeEvidenceRecords(intent);
  return { intent, receipt };
}

export function validateState({ cwd = process.cwd(), changeId } = {}) {
  const root = repositoryRoot(cwd);
  const state = loadState(root, changeId);
  return validateLoadedState(root, state);
}

function validateLoadedState(root, state) {
  if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
  const inventory = transitionInventory(root, state.changeId);
  if (inventory.pending.length > 0) {
    throw new StateError('Uncommitted transition staging is pending; run recover', 'RECOVERY_REQUIRED');
  }
  const entries = inventory.committed;
  if (entries.length !== state.revision + 1) throw new StateError('Transition revisions are not contiguous with active state', 'RECOVERY_EVIDENCE_INVALID');
  let previousDigest = null;
  const transitionIntents = [];
  for (let index = 0; index < entries.length; index += 1) {
    const directory = entries[index];
    if (basename(directory) !== String(index).padStart(8, '0')) {
      throw new StateError('Transition revision sequence has a gap', 'RECOVERY_EVIDENCE_INVALID');
    }
    const children = new Set(readdirSync(directory));
    if (!children.has('intent.json')) throw new StateError(`Orphaned transition evidence at ${directory}`, 'RECOVERY_EVIDENCE_INVALID');
    if (children.has('complete')) {
      const verified = verifyCompleteTransition(directory);
      if (verified.intent.revision !== index || verified.intent.changeId !== state.changeId) throw new StateError('Transition intent identity does not match directory/state', 'RECOVERY_EVIDENCE_INVALID');
      if (verified.intent.previousStateDigest !== previousDigest) throw new StateError('Transition predecessor digest chain is broken', 'RECOVERY_EVIDENCE_INVALID');
      previousDigest = verified.intent.nextStateDigest;
      transitionIntents.push(verified.intent);
      if (index === entries.length - 1 && verified.intent.nextStateDigest !== objectDigest(state)) {
        throw new StateError('Latest transition does not produce active state', 'RECOVERY_STATE_CONFLICT');
      }
    }
    else if (children.has('receipt.json')) {
      const intent = verifyReceipt(join(directory, 'intent.json'), 'transition intent', TRANSITION_INTENT_LIMIT_BYTES).value;
      const receipt = verifyReceipt(join(directory, 'receipt.json'), 'transition receipt').value;
      if (receipt.revision !== intent.revision || receipt.intentDigest !== objectDigest(intent)
          || receipt.stateDigest !== intent.nextStateDigest
          || serialized(receipt.evidence) !== serialized(intent.evidence)
          || receipt.completedAt !== intent.nextState.updatedAt) {
        throw new StateError(`Interrupted transition receipt is invalid at ${directory}`, 'RECOVERY_EVIDENCE_INVALID');
      }
      throw new StateError(`Transition ${index} is incomplete; run recover`, 'RECOVERY_REQUIRED');
    } else throw new StateError(`Transition ${index} is incomplete; run recover`, 'RECOVERY_REQUIRED');
  }
  const receiptRoots = ['source', 'plan', 'decisions', 'implementation', 'verification'].map((name) => join(changeDirectory(root, state.changeId), name));
  const evidenceDigests = new Set();
  for (const receiptRoot of receiptRoots) verifyReceiptTree(receiptRoot, evidenceDigests);
  evidenceDigests.add(verifyReceipt(join(changeDirectory(root, state.changeId), 'worktree.json'), 'owning worktree identity').digest);
  const referencedPaths = new Set();
  for (const intent of transitionIntents) {
    for (const [key, digest] of Object.entries(intent.evidence ?? {})) {
      const evidencePath = intent.evidencePaths?.[key];
      if (typeof evidencePath !== 'string') throw new StateError(`Transition ${intent.revision} lacks a path for ${key}`, 'RECOVERY_EVIDENCE_INVALID');
      const absolute = join(changeDirectory(root, state.changeId), evidencePath);
      if (relative(changeDirectory(root, state.changeId), absolute).startsWith('..')) throw new StateError('Transition evidence path escapes change directory', 'RECOVERY_EVIDENCE_INVALID');
      if (verifyReceipt(absolute, `transition ${intent.revision} evidence ${key}`).digest !== digest) {
        throw new StateError(`Transition ${intent.revision} evidence ${key} digest differs`, 'RECOVERY_EVIDENCE_INVALID');
      }
      referencedPaths.add(evidencePath);
    }
  }
  for (const path of immutableEvidencePaths(root, state.changeId)) {
    if (!referencedPaths.has(path)) throw new StateError(`Immutable evidence is orphaned: ${path}`, 'RECOVERY_EVIDENCE_INVALID');
  }
  const latestObservation = readObservationByDigest(root, state);
  if ((latestObservation.digest ?? objectDigest(latestObservation)) !== state.source.latestDigest) {
    throw new StateError('Latest source observation does not match state summary', 'SOURCE_OBSERVATION_INVALID');
  }
  if (state.plan) {
    const original = verifyReceipt(join(changeDirectory(root, state.changeId), 'plan', 'plan.json'), 'accepted plan');
    if (original.digest !== state.plan.originalDigest) throw new StateError('Accepted plan digest does not match state', 'PLAN_TAMPERED');
    verifyReceipt(join(changeDirectory(root, state.changeId), 'plan', 'planning-evidence.json'), 'accepted-plan planning evidence');
    let priorDigest = original.digest;
    let effective = original.value;
    for (let number = 1; number <= state.plan.amendmentCount; number += 1) {
      const stem = join(changeDirectory(root, state.changeId), 'plan', 'amendments', String(number).padStart(4, '0'));
      const record = verifyReceipt(`${stem}.json`, `plan amendment ${number}`).value;
      verifyReceipt(`${stem}.evidence.json`, `plan amendment ${number} evidence`);
      if (record.previousDigest !== priorDigest || record.newDigest !== objectDigest(record.resultingPlan)
          || record.resultingPlan.planRevision !== original.value.planRevision + number) {
        throw new StateError(`Plan amendment ${number} does not replay from its predecessor`, 'AMENDMENT_CHAIN_INVALID');
      }
      priorDigest = record.newDigest;
      effective = record.resultingPlan;
    }
    if (objectDigest(effective) !== state.plan.effectiveDigest || priorDigest !== state.plan.effectiveDigest) {
      throw new StateError('Effective plan digest does not match amendment replay', 'PLAN_TAMPERED');
    }
    const identityErrors = validatePlanStateIdentity(effective, state, { sourceCaptureDigest: state.plan.sourceCaptureDigest });
    if (identityErrors.length > 0) throw new StateError(`Effective plan identity does not reconcile with active state:\n- ${identityErrors.join('\n- ')}`, 'PLAN_STATE_MISMATCH');
    if (state.schemaVersion === 2 && state.execution) {
      for (const task of state.execution.tasks) {
        let packetReceipt = null;
        const planned = effective.tasks.find((entry) => entry.id === task.id);
        if (!planned || serialized(task.dependsOn) !== serialized(planned.dependsOn)
            || serialized(task.anticipatedPaths) !== serialized(planned.anticipatedPaths)
            || serialized(task.produces) !== serialized(planned.produces)
            || serialized(task.consumes) !== serialized(planned.consumes.map(({ artifactId }) => artifactId))) {
          throw new StateError(`Execution summary ${task.id} does not match the effective plan`, 'EXECUTION_PLAN_MISMATCH');
        }
        if (task.packetDigest !== null) {
          packetReceipt = verifyReceipt(implementationTaskPacketPath(root, state.changeId, task.id, task.binding), `task packet ${task.id}`);
          const packet = packetReceipt;
          if (validateImplementationTaskStructure(packet.value).length > 0
              || packet.digest !== task.packetDigest || implementationTaskDigest(packet.value) !== task.packetDigest) throw new StateError(`Task ${task.id} packet summary/receipt mismatch`, 'TASK_PACKET_MISMATCH');
          const completed = ['integrated', 'no-change'].includes(task.status);
          assertPacketPlanBinding(packet.value, effective, state, task.taskBaseSha,
            completed ? packet.value.planDigest : state.plan.effectiveDigest,
            completed ? packet.value.planRevision : effective.planRevision);
          assertPacketMapperProvenance(root, state, packet.value);
          assertPacketSelectorsAtBase(root, packet.value);
          const suffix = `${task.id}/${String(task.binding).padStart(4, '0')}.json`;
          const provenance = verifyReceipt(join(changeDirectory(root, state.changeId), 'implementation/provenance', suffix), `task provenance ${task.id}`).value;
          if (provenance.planDigest !== packet.value.planDigest || provenance.taskBaseSha !== packet.value.taskBaseSha
              || serialized(provenance.decisionContext) !== serialized(packet.value.decisionContext)
              || serialized(provenance.acceptanceCriteria) !== serialized(packet.value.acceptanceCriteria)) throw new StateError(`Task ${task.id} provenance mismatch`, 'TASK_PROVENANCE_MISMATCH');
          if (serialized(verifyReceipt(join(changeDirectory(root, state.changeId), 'implementation/planning-signals', suffix), `task planning signals ${task.id}`).value) !== serialized(packet.value.planningSignals)
              || serialized(verifyReceipt(join(changeDirectory(root, state.changeId), 'implementation/specialist-routes', suffix), `task specialist route ${task.id}`).value) !== serialized(packet.value.specialistRoute)) throw new StateError(`Task ${task.id} specialist provenance mismatch`, 'TASK_PROVENANCE_MISMATCH');
          const mapperPath = join(changeDirectory(root, state.changeId), 'implementation/behavior-mapper', suffix);
          if (packet.value.behaviorMapperEvidence === null) {
            if (existsSync(mapperPath) || existsSync(mapperPath.replace(/\.json$/u, '.sha256'))) throw new StateError(`Task ${task.id} has unexpected behavior-mapper provenance`, 'TASK_PROVENANCE_MISMATCH');
          } else if (serialized(verifyReceipt(mapperPath, `task behavior mapper ${task.id}`).value) !== serialized(packet.value.behaviorMapperEvidence)) throw new StateError(`Task ${task.id} behavior-mapper provenance mismatch`, 'TASK_PROVENANCE_MISMATCH');
        }
        if (task.resultDigest !== null) {
          const result = verifyReceipt(join(changeDirectory(root, state.changeId), resultEvidencePath(task.id, task.attempt)), `implementation result ${task.id}`).value;
          if (objectDigest(result) !== task.resultDigest || result.taskId !== task.id || result.packetDigest !== task.packetDigest
              || result.workerCommit !== task.workerCommit) throw new StateError(`Task ${task.id} result summary mismatch`, 'TASK_RESULT_MISMATCH');
          let actualPaths;
          if (result.status === 'implemented') {
            const parent = gitText(['rev-list', '--parents', '-n', '1', result.workerCommit], { cwd: root }).split(/\s+/u);
            if (parent.length !== 2 || parent[1] !== task.taskBaseSha) throw new StateError(`Task ${task.id} worker commit is not the exact direct child of its base`, 'TASK_RESULT_MISMATCH');
            actualPaths = nulChangedPaths(root, task.taskBaseSha, result.workerCommit);
            assertPlannedSelectorsRealized(root, packetReceipt.value, result.workerCommit);
          }
          const replayErrors = validateImplementationResultAgainstTask(packetReceipt.value, result, actualPaths);
          if (replayErrors.length) throw new StateError(`Task ${task.id} result replay failed:\n- ${replayErrors.join('\n- ')}`, 'TASK_RESULT_MISMATCH');
          const coherent = result.status === 'implemented' ? ['accepted', 'integration-pending', 'integrated', 'rejected'].includes(task.status)
            : [result.status, 'rejected'].includes(task.status);
          if (!coherent) throw new StateError(`Task ${task.id} status is incoherent with its result`, 'TASK_RESULT_MISMATCH');
        }
        if (task.worktreeManifestDigest !== null) {
          const manifest = verifyReceipt(implementationWorktreeManifestPath(root, state.changeId, task.id), `worktree manifest ${task.id}`);
          if (manifest.digest !== task.worktreeManifestDigest || manifest.value.path !== task.worktreePath || manifest.value.branch !== task.branch) throw new StateError(`Task ${task.id} worktree summary mismatch`, 'WORKTREE_MANIFEST_MISMATCH');
        }
        if (['integrated', 'validating', 'specialist-review', 'verifying', 'development-ready'].includes(state.phase)) verifiedWorkerTombstone(root, state, task);
      }
      canonicalTaskBlockers(root, state, state.execution);
      if (state.phase === 'blocked') nonTaskBlockers(root, state);
    }
    if (state.verification) {
      if (!state.execution?.tasks.every(({ status }) => ['integrated', 'no-change'].includes(status))) throw new StateError('Verification summary requires a terminal implementation task set', 'VERIFICATION_EVIDENCE_INVALID');
      const plan = verifyReceipt(validationPlanPath(root, state), 'validation plan');
      if (validationPlanDigest(plan.value) !== state.verification.validationPlanDigest
          || plan.value.headSha !== state.verification.headSha || plan.value.taskSetDigest !== state.verification.taskSetDigest
          || plan.value.effectivePlanDigest !== state.plan.effectiveDigest) throw new StateError('Validation plan summary does not match immutable evidence', 'VERIFICATION_EVIDENCE_INVALID');
      const results = existingCommandResults(root, state, plan.value);
      if (results.size !== state.verification.validationResultDigests.length
          || [...results.values()].some(({ digest }) => !state.verification.validationResultDigests.includes(digest))) throw new StateError('Validation result summary does not match append-only evidence', 'VERIFICATION_EVIDENCE_INVALID');
      if (state.verification.validationStatus === 'passed' && plan.value.commands.some(({ id }) => results.get(id)?.value.status !== 'passed')) throw new StateError('Passing validation summary lacks complete passing evidence', 'VERIFICATION_EVIDENCE_INVALID');
      for (const authorization of state.verification.humanDecisionAuthorizations) {
        const receipt = verifyReceipt(join(changeDirectory(root, state.changeId), 'verification', 'authorizations',
          authorization.fingerprint.slice('sha256:'.length), `${String(state.verification.round).padStart(4, '0')}.json`), 'repeated finding authorization');
        if (receipt.digest !== authorization.digest || receipt.value.fingerprint !== authorization.fingerprint
            || receipt.value.headSha !== state.verification.headSha || receipt.value.verificationRound > state.verification.round) {
          throw new StateError('Repeated finding authorization summary does not match immutable evidence', 'VERIFICATION_EVIDENCE_INVALID');
        }
      }
      if (state.verification.specialistPlanDigest) {
        const specialist = verifyReceipt(specialistPlanPath(root, state), 'specialist plan');
        if (specialist.digest !== state.verification.specialistPlanDigest
            || serialized(specialist.value.reviewers.map(({ id }) => id)) !== serialized(state.verification.requiredReviewerIds)) throw new StateError('Specialist plan summary does not match immutable stored-route evidence', 'VERIFICATION_EVIDENCE_INVALID');
        const digests = state.verification.requiredReviewerIds.filter((id) => existsSync(specialistResultPath(root, state, id)))
          .map((id) => verifyReceipt(specialistResultPath(root, state, id), `specialist result ${id}`).digest);
        if (digests.length !== state.verification.specialistResultDigests.length
            || digests.some((digest) => !state.verification.specialistResultDigests.includes(digest))) throw new StateError('Specialist result summary does not match immutable evidence', 'VERIFICATION_EVIDENCE_INVALID');
      }
      if (state.verification.verifierResultDigest) {
        const context = verifyReceipt(join(verificationRoundDirectory(root, state), 'verifier-context.json'), 'verifier context');
        const result = verifyReceipt(verifierResultPath(root, state), 'verifier result');
        if (context.digest !== state.verification.contextDigest || result.digest !== state.verification.verifierResultDigest
            || result.value.contextDigest !== context.digest || result.value.headSha !== state.verification.headSha) throw new StateError('Verifier summary does not match exact immutable context/result evidence', 'VERIFICATION_EVIDENCE_INVALID');
      }
    }
  }
  verifyEventHistory(root, state.changeId, transitionIntents);
  const git = gitObservation(root);
  return {
    valid: true,
    state,
    git,
    gitDrift: git.headSha !== state.git.headSha || git.clean !== state.git.clean || git.branch !== state.git.branch,
  };
}

function verifyReceiptTree(root, digests = new Set()) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) verifyReceiptTree(path, digests);
    else if (entry.name.endsWith('.json')) {
      if (!existsSync(path.replace(/\.json$/u, '.sha256'))) {
        throw new StateError(`Orphaned immutable JSON sidecar at ${path}`, 'RECOVERY_EVIDENCE_INVALID');
      }
      digests.add(verifyReceipt(path, 'immutable evidence').digest);
    } else if (entry.name.endsWith('.sha256')) {
      const json = path.replace(/\.sha256$/u, '.json');
      if (!existsSync(json)) throw new StateError(`Orphaned receipt at ${path}`, 'RECOVERY_EVIDENCE_INVALID');
    }
  }
  return digests;
}

function immutableEvidencePaths(cwd, changeId) {
  const directory = changeDirectory(cwd, changeId);
  const result = [];
  function visit(root) {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json')) result.push(relative(directory, path));
    }
  }
  for (const name of ['source', 'plan', 'decisions', 'implementation', 'verification']) visit(join(directory, name));
  result.push('worktree.json');
  return result;
}

function verifyIntentEvidence(cwd, changeId, intent) {
  authoritativeEvidenceRecords(intent);
  for (const [key, digest] of Object.entries(intent.evidence ?? {})) {
    const evidencePath = intent.evidencePaths?.[key];
    if (typeof evidencePath !== 'string') throw new StateError(`Transition ${intent.revision} lacks evidence path ${key}`, 'RECOVERY_EVIDENCE_INVALID');
    const absolute = join(changeDirectory(cwd, changeId), evidencePath);
    if (relative(changeDirectory(cwd, changeId), absolute).startsWith('..')
        || verifyReceipt(absolute, `transition ${intent.revision} evidence ${key}`).digest !== digest) {
      throw new StateError(`Transition ${intent.revision} evidence ${key} is invalid`, 'RECOVERY_EVIDENCE_INVALID');
    }
  }
}

function verifyCompletedPrefix(cwd, changeId, entries, terminalIndex) {
  let previousDigest = null;
  const intents = [];
  for (let index = 0; index < terminalIndex; index += 1) {
    const directory = entries[index];
    if (basename(directory) !== String(index).padStart(8, '0') || !existsSync(join(directory, 'complete'))) {
      throw new StateError('Recovery predecessor transition sequence is incomplete', 'RECOVERY_EVIDENCE_INVALID');
    }
    const { intent } = verifyCompleteTransition(directory);
    if (intent.revision !== index || intent.changeId !== changeId || intent.previousStateDigest !== previousDigest) {
      throw new StateError(`Recovery predecessor ${index} is inconsistent`, 'RECOVERY_EVIDENCE_INVALID');
    }
    verifyIntentEvidence(cwd, changeId, intent);
    previousDigest = intent.nextStateDigest;
    intents.push(intent);
  }
  const events = eventHistory(cwd, changeId);
  if (events.length < intents.length || intents.some((intent, index) => serialized(events[index]) !== serialized(canonicalEvent(intent)))) {
    throw new StateError('Recovery predecessor event history is inconsistent', 'RECOVERY_EVIDENCE_INVALID');
  }
  return { previousDigest, intents, events };
}

function archiveReceiptFor(intent) {
  return {
    schemaVersion: 1,
    intentDigest: objectDigest(intent),
    changeId: intent.changeId,
    stateDigest: intent.stateDigest,
    archivedAt: intent.archivedAt,
  };
}

function transitionReceiptFor(intent) {
  return {
    schemaVersion: 1,
    revision: intent.revision,
    intentDigest: objectDigest(intent),
    stateDigest: intent.nextStateDigest,
    evidence: intent.evidence,
    completedAt: intent.nextState.updatedAt,
  };
}

function materializeTransitionReceipt(directory, intent) {
  const path = join(directory, 'receipt.json');
  const receiptPath = join(directory, 'receipt.sha256');
  cleanupAtomicWriteTemps(path);
  cleanupAtomicWriteTemps(receiptPath);
  const expected = transitionReceiptFor(intent);
  if (existsSync(path) && serialized(readJson(path, 'transition receipt')) !== serialized(expected)) {
    throw new StateError('Interrupted transition receipt conflicts with committed intent', 'RECOVERY_EVIDENCE_INVALID');
  }
  if (existsSync(receiptPath) && readFileSync(receiptPath, 'utf8').trim() !== objectDigest(expected)) {
    throw new StateError('Interrupted transition receipt digest conflicts with committed intent', 'RECOVERY_EVIDENCE_INVALID');
  }
  if (!existsSync(path)) atomicWriteText(path, serialized(expected));
  if (!existsSync(receiptPath)) atomicWriteText(receiptPath, `${objectDigest(expected)}\n`);
  verifyReceipt(path, 'transition receipt');
  return expected;
}

function materializeArchiveReceipt(path, intent) {
  const expected = archiveReceiptFor(intent);
  const receiptPath = path.replace(/\.json$/u, '.sha256');
  cleanupAtomicWriteTemps(path);
  cleanupAtomicWriteTemps(receiptPath);
  const hasJson = existsSync(path);
  const hasReceipt = existsSync(receiptPath);
  if (hasJson && serialized(readJson(path, 'archive receipt')) !== serialized(expected)) {
    throw new StateError('Archive receipt conflicts with lifecycle intent', 'ARCHIVE_CONFLICT');
  }
  if (hasReceipt && readFileSync(receiptPath, 'utf8').trim() !== objectDigest(expected)) {
    throw new StateError('Archive receipt digest conflicts with lifecycle intent', 'ARCHIVE_CONFLICT');
  }
  if (!hasJson) atomicWriteText(path, serialized(expected));
  if (!hasReceipt) atomicWriteText(receiptPath, `${objectDigest(expected)}\n`);
  verifyReceipt(path, 'archive receipt');
}

function archivedEventHistory(directory) {
  const path = join(directory, 'events.jsonl');
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { throw new StateError(`Archived event history is invalid: ${error.message}`, 'ARCHIVE_CONFLICT'); }
}

function validateArchivedTree(directory, intent) {
  const state = readJson(join(directory, 'state.json'), 'archived state', STATE_LIMIT_BYTES);
  assertValidState(state);
  if (state.changeId !== intent.changeId || objectDigest(state) !== intent.stateDigest) {
    throw new StateError('Archived state does not match archive intent', 'ARCHIVE_CONFLICT');
  }
  const transitionsRoot = join(directory, 'transitions');
  const entries = existsSync(transitionsRoot) ? readdirSync(transitionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}$/u.test(entry.name)).map((entry) => join(transitionsRoot, entry.name)).sort() : [];
  if (entries.length !== state.revision + 1) throw new StateError('Archived transition sequence is incomplete', 'ARCHIVE_CONFLICT');
  let previous = null;
  const intents = [];
  const referenced = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const { intent: transitionIntent } = verifyCompleteTransition(entries[index]);
    if (basename(entries[index]) !== String(index).padStart(8, '0') || transitionIntent.revision !== index
        || transitionIntent.changeId !== state.changeId || transitionIntent.previousStateDigest !== previous) {
      throw new StateError('Archived transition chain is inconsistent', 'ARCHIVE_CONFLICT');
    }
    for (const [key, digest] of Object.entries(transitionIntent.evidence ?? {})) {
      const relativePath = transitionIntent.evidencePaths?.[key];
      if (!nonemptyString(relativePath) || verifyReceipt(join(directory, relativePath), 'archived transition evidence').digest !== digest) {
        throw new StateError('Archived transition evidence is invalid', 'ARCHIVE_CONFLICT');
      }
      referenced.add(relativePath);
    }
    previous = transitionIntent.nextStateDigest;
    intents.push(transitionIntent);
  }
  if (previous !== objectDigest(state)) throw new StateError('Archived transitions do not produce archived state', 'ARCHIVE_CONFLICT');
  const events = archivedEventHistory(directory);
  if (events.length !== intents.length || events.some((event, index) => serialized(event) !== serialized(canonicalEvent(intents[index])))) {
    throw new StateError('Archived events do not match transition intents', 'ARCHIVE_CONFLICT');
  }
  for (const rootName of ['source', 'plan', 'decisions', 'implementation', 'verification']) verifyReceiptTree(join(directory, rootName));
  verifyReceipt(join(directory, 'worktree.json'), 'archived worktree identity');
  const sourceFiles = [];
  function collectJson(root, output) {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) collectJson(path, output);
      else if (entry.name.endsWith('.json')) output.push(path);
    }
  }
  collectJson(join(directory, 'source'), sourceFiles);
  const latestSource = sourceFiles.map((path) => verifyReceipt(path, 'archived source observation'))
    .find(({ digest }) => digest === state.source.observationDigest)?.value;
  if (!latestSource || latestSource.digest !== state.source.latestDigest) {
    throw new StateError('Archived latest source observation does not match state', 'ARCHIVE_CONFLICT');
  }
  if (state.plan) {
    const original = verifyReceipt(join(directory, 'plan', 'plan.json'), 'archived accepted plan');
    if (original.digest !== state.plan.originalDigest) throw new StateError('Archived accepted plan does not match state', 'ARCHIVE_CONFLICT');
    let effective = original.value;
    for (let number = 1; number <= state.plan.amendmentCount; number += 1) {
      effective = verifyReceipt(join(directory, 'plan', 'amendments', `${String(number).padStart(4, '0')}.json`), 'archived amendment').value.resultingPlan;
    }
    if (objectDigest(effective) !== state.plan.effectiveDigest || effective.source.captureDigest !== state.plan.sourceCaptureDigest) {
      throw new StateError('Archived effective plan does not match state', 'ARCHIVE_CONFLICT');
    }
  }
  const evidence = [];
  function visit(root) {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json')) evidence.push(relative(directory, path));
    }
  }
  for (const rootName of ['source', 'plan', 'decisions']) visit(join(directory, rootName));
  evidence.push('worktree.json');
  if (evidence.some((path) => !referenced.has(path))) throw new StateError('Archived tree contains orphan immutable evidence', 'ARCHIVE_CONFLICT');
  return state;
}

function eventHistory(cwd, changeId) {
  const path = join(changeDirectory(cwd, changeId), 'events.jsonl');
  if (!existsSync(path)) return [];
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { throw new StateError(`Event history is invalid: ${error.message}`, 'RECOVERY_EVIDENCE_INVALID'); }
}

function canonicalEvent(intent) {
  return { revision: intent.revision, type: intent.type, summary: intent.summary, at: intent.nextState.updatedAt };
}

function decisionDispositionForRecovery(intent, predecessor) {
  const decisionPaths = Object.values(intent.evidencePaths ?? {})
    .filter((path) => typeof path === 'string' && path.startsWith('decisions/'));
  if (intent.type !== 'decision-recorded') {
    if (decisionPaths.length > 0) {
      throw new StateError('Decision evidence is attached to a non-decision transition', 'RECOVERY_EVIDENCE_INVALID');
    }
    return null;
  }
  const records = authoritativeEvidenceRecords(intent);
  const record = records.decisionDigest?.value;
  const recordFields = [
    'schemaVersion', 'id', 'reason', 'authorization', 'trigger', 'disposition',
    'changeId', 'stateRevision', 'sourceObservationDigest', 'sourceDigest',
    'effectivePlanDigest', 'repositorySha', 'recordedAt',
  ];
  let validId = true;
  try { validateChangeId(record?.id); } catch { validId = false; }
  if (!predecessor || Object.keys(records).length !== 1 || decisionPaths.length !== 1
      || !isPlainObject(record) || serialized(Object.keys(record).sort()) !== serialized([...recordFields].sort())
      || record.schemaVersion !== 1 || !validId
      || !['id', 'reason', 'authorization', 'trigger'].every((key) => nonemptyString(record[key]))
      || !['resolve', 'retain-plan'].includes(record.disposition)
      || records.decisionDigest.path !== `decisions/${record.id}.json`
      || intent.summary !== `Recorded decision ${record.id}` || intent.createdAt !== record.recordedAt
      || record.changeId !== predecessor.changeId || record.stateRevision !== predecessor.revision
      || record.sourceObservationDigest !== predecessor.source.observationDigest
      || record.sourceDigest !== predecessor.source.latestDigest
      || record.effectivePlanDigest !== (predecessor.plan?.effectiveDigest ?? null)
      || record.repositorySha !== intent.nextState.git.headSha
      || predecessor.phase !== 'awaiting-decision' || !predecessor.plan) {
    throw new StateError('Interrupted decision transition is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
  }
  const retainPlan = record.disposition === 'retain-plan';
  if (retainPlan && !(predecessor.phase === 'awaiting-decision' && predecessor.plan
      && predecessor.source.classification === 'unreviewed-material'
      && predecessor.blockedReasons.length === 0)) {
    throw new StateError('Interrupted retain-plan decision is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
  }
  const lateRetain = retainPlan && predecessor.schemaVersion === 2
    && predecessor.execution?.tasks.every((task) => ['integrated', 'no-change'].includes(task.status));
  if (lateRetain && (intent.nextState.git.headSha !== predecessor.git.headSha
      || intent.nextState.git.branch !== predecessor.git.branch || intent.nextState.git.clean !== predecessor.git.clean)) {
    throw new StateError('Interrupted late retain-plan changed the integrated Git authority', 'RECOVERY_EVIDENCE_INVALID');
  }
  const expected = deriveDecisionTransition(predecessor, record, intent.nextState.git, record.recordedAt);
  if (serialized(expected) !== serialized(intent.nextState)) {
    throw new StateError('Interrupted decision transition does not match its recorded operation', 'RECOVERY_EVIDENCE_INVALID');
  }
  return record.disposition;
}

function sourceRefreshForRecovery(cwd, intent, predecessor) {
  const sourcePaths = Object.values(intent.evidencePaths ?? {})
    .filter((path) => typeof path === 'string' && path.startsWith('source/observations/'));
  if (intent.type !== 'source-refreshed') {
    if (sourcePaths.length > 0 && !['initialized', 'development-finalized'].includes(intent.type)) {
      throw new StateError('Source-observation evidence is attached to a non-refresh transition', 'RECOVERY_EVIDENCE_INVALID');
    }
    return null;
  }
  const records = authoritativeEvidenceRecords(intent);
  const observation = records.observationDigest?.value;
  const expectedPath = `source/observations/${String(intent.revision).padStart(8, '0')}.json`;
  if (!predecessor || Object.keys(records).length !== 1 || sourcePaths.length !== 1
      || records.observationDigest?.path !== expectedPath || !isPlainObject(observation)
      || intent.createdAt !== intent.nextState.updatedAt) {
    throw new StateError('Interrupted source refresh lacks exact authoritative evidence', 'RECOVERY_EVIDENCE_INVALID');
  }
  const previousObservation = readObservationByDigest(cwd, predecessor);
  const initialObservation = predecessor.plan ? previousObservation : readInitialObservation(cwd, predecessor);
  const derived = deriveSourceRefreshTransition(predecessor, {
    previousObservation, initialObservation, observation, timestamp: intent.createdAt,
  });
  const ordinarySummary = `Source refresh classified ${derived.classification}`;
  const finalSummary = `Final source gate classified ${derived.classification}`;
  if (![ordinarySummary, finalSummary].includes(intent.summary)
      || (intent.summary === finalSummary && predecessor.phase !== 'verifying')
      || serialized(derived.next) !== serialized(intent.nextState)) {
    throw new StateError('Interrupted source refresh is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
  }
  return { late: derived.late, classification: derived.classification };
}

function amendmentForRecovery(cwd, intent, predecessor) {
  const amendmentPaths = Object.values(intent.evidencePaths ?? {})
    .filter((path) => typeof path === 'string' && path.startsWith('plan/amendments/'));
  if (intent.type !== 'plan-amended') {
    if (amendmentPaths.length > 0) {
      throw new StateError('Amendment evidence is attached to a non-amendment transition', 'RECOVERY_EVIDENCE_INVALID');
    }
    return false;
  }
  const records = authoritativeEvidenceRecords(intent);
  const record = records.amendmentDigest?.value;
  const planningEvidence = records.planningEvidenceDigest?.value;
  const number = (predecessor?.plan?.amendmentCount ?? -1) + 1;
  const stem = `plan/amendments/${String(number).padStart(4, '0')}`;
  const fields = ['schemaVersion', 'amendmentId', 'reason', 'trigger', 'delta', 'previousDigest', 'newDigest',
    'repositorySha', 'authorization', 'invalidatedEvidence', 'resultingPlan', 'createdAt'];
  let validId = true;
  try { validateChangeId(record?.amendmentId); } catch { validId = false; }
  if (!predecessor?.plan || Object.keys(records).length !== 2 || amendmentPaths.length !== 2
      || records.amendmentDigest?.path !== `${stem}.json`
      || records.planningEvidenceDigest?.path !== `${stem}.evidence.json`
      || !isPlainObject(record) || serialized(Object.keys(record).sort()) !== serialized(fields.sort())
      || record.schemaVersion !== 1 || !validId || !nonemptyString(record.reason)
      || !nonemptyString(record.authorization) || !nonemptyString(record.trigger)
      || !isPlainObject(record.delta) || Object.keys(record.delta).length === 0
      || !validUniqueStrings(record.invalidatedEvidence) || !Array.isArray(planningEvidence)
      || record.previousDigest !== predecessor.plan.effectiveDigest
      || record.newDigest !== objectDigest(record.resultingPlan)
      || record.resultingPlan?.planRevision !== predecessor.plan.revision + 1
      || record.resultingPlan?.planning?.planningSha !== predecessor.planningSha
      || record.repositorySha !== intent.nextState.git.headSha
      || intent.nextState.git.headSha !== predecessor.git.headSha
      || intent.nextState.git.branch !== predecessor.git.branch
      || intent.nextState.git.clean !== predecessor.git.clean
      || record.createdAt !== intent.createdAt
      || intent.summary !== `Appended plan amendment ${record.amendmentId}`) {
    throw new StateError('Interrupted plan amendment lacks exact semantic authority', 'RECOVERY_EVIDENCE_INVALID');
  }
  if (predecessor.phase === 'awaiting-decision' && !hasBoundResolveDecision(cwd, predecessor, record.trigger)) {
    throw new StateError('Interrupted source-driven amendment lacks its bound resolve decision', 'RECOVERY_EVIDENCE_INVALID');
  }
  const expected = deriveAmendedTransition(predecessor, record.resultingPlan, intent.nextState.git, record.createdAt, number);
  if (serialized(expected) !== serialized(intent.nextState)) {
    throw new StateError('Interrupted plan amendment is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
  }
  return true;
}

const GIT_BLOCK_PREFIXES = [
  'Git observation is not clean at Planning SHA',
  'Central Git observation does not match exact clean durable identity',
];

function isGitBlock(reason) {
  return GIT_BLOCK_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function restoredCheckpointPhase(state, finalizedIntegration, finalizedDevelopment = false) {
  if (state.source.classification === 'unreviewed-material') return 'awaiting-decision';
  if (!state.plan) return 'planning';
  if (!state.execution) return 'ready-to-implement';
  if (finalizedDevelopment) return 'development-ready';
  if (state.verification) {
    if (state.verification.validationStatus !== 'passed') return 'validating';
    if (!state.verification.specialistPlanDigest
        || state.verification.specialistResultDigests.length < state.verification.requiredReviewerIds.length) return 'specialist-review';
    return 'verifying';
  }
  if (state.phase === 'integrated' || finalizedIntegration) return 'integrated';
  if (state.execution.tasks.every((task) => task.status === 'unbound')) return 'ready-to-implement';
  return 'implementing';
}

function deriveGitCheckpoint(predecessor, observed, updatedAt, { finalizedIntegration = false, finalizedDevelopment = false } = {}) {
  const executionActive = predecessor.schemaVersion === 2 && predecessor.execution !== null;
  const strictExecutionIdentity = executionActive && predecessor.mode !== 'plan-only';
  const valid = strictExecutionIdentity
    ? observed.clean && observed.headSha === predecessor.git.headSha
      && observed.branch === predecessor.git.branch && observed.branch !== '(detached)'
    : observed.clean && observed.headSha === predecessor.planningSha;
  const gitBlock = valid ? null : strictExecutionIdentity
    ? `Central Git observation does not match exact clean durable identity ${predecessor.git.branch}@${predecessor.git.headSha}`
    : `Git observation is not clean at Planning SHA ${predecessor.planningSha}`;
  const nonGitReasons = predecessor.blockedReasons.filter((reason) => !isGitBlock(reason));
  const hadGitBlock = nonGitReasons.length !== predecessor.blockedReasons.length;
  const immutableTerminal = predecessor.phase === 'abandoned';
  const blockedReasons = immutableTerminal ? predecessor.blockedReasons
    : gitBlock ? [...nonGitReasons, gitBlock] : hadGitBlock ? nonGitReasons : predecessor.blockedReasons;
  const phase = immutableTerminal ? predecessor.phase
    : gitBlock || nonGitReasons.length > 0 ? 'blocked'
      : hadGitBlock ? restoredCheckpointPhase(predecessor, finalizedIntegration, finalizedDevelopment) : predecessor.phase;
  const expected = {
    ...predecessor,
    // An invalid execution observation is evidence, never a replacement for the durable integration identity.
    git: strictExecutionIdentity && !valid ? predecessor.git : observed,
    phase,
    blockedReasons,
    revision: predecessor.revision + 1,
    updatedAt,
  };
  expected.nextAction = nextActionFor(expected);
  return expected;
}

function checkpointObservation(intent) {
  const record = intent.authoritativeEvidence?.gitCheckpointObservationDigest;
  if (record?.path === `implementation/git-checkpoints/${String(intent.revision).padStart(8, '0')}.json`
      && record.digest === intent.evidence?.gitCheckpointObservationDigest
      && objectDigest(record.value) === record.digest) return record.value;
  return null;
}

function isSemanticGitCheckpoint(intent, predecessor, finalizedIntegration, finalizedDevelopment = false) {
  if (intent.type !== 'git-checkpoint' || !predecessor
      || intent.summary !== 'Checkpointed local Git observation before compaction') return false;
  const observed = checkpointObservation(intent);
  if (!observed) return false;
  return serialized(deriveGitCheckpoint(predecessor, observed, intent.nextState.updatedAt, { finalizedIntegration, finalizedDevelopment })) === serialized(intent.nextState);
}

function verifyEventHistory(cwd, changeId, intentsOrLatestRevision) {
  const events = eventHistory(cwd, changeId);
  if (!Array.isArray(intentsOrLatestRevision)) {
    if (events.length !== intentsOrLatestRevision + 1) throw new StateError('Event count does not match revisions', 'RECOVERY_EVIDENCE_INVALID');
    return;
  }
  if (events.length !== intentsOrLatestRevision.length) throw new StateError('Event count does not match completed transitions', 'RECOVERY_EVIDENCE_INVALID');
  for (let index = 0; index < intentsOrLatestRevision.length; index += 1) {
    if (serialized(events[index]) !== serialized(canonicalEvent(intentsOrLatestRevision[index]))) {
      throw new StateError(`Event ${index} does not canonically match its transition intent`, 'RECOVERY_EVIDENCE_INVALID');
    }
  }
}

export function recoverState({ cwd = process.cwd(), changeId, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd);
  const pendingArchive = readArchiveIntent(root);
  const active = pendingArchive ? null : locateState(root);
  const selected = changeId ?? pendingArchive?.changeId ?? active?.changeId ?? recoverableChangeId(root);
  if (!selected) throw new StateError('No active change state', 'STATE_NOT_FOUND');
  return withLifecycleAndChangeLocks(root, selected, () => {
    const lockedArchiveIntent = readArchiveIntent(root);
    if (pendingArchive && (!lockedArchiveIntent || objectDigest(lockedArchiveIntent) !== objectDigest(pendingArchive))) {
      throw new StateError('Archive lifecycle changed while recovery waited for its lock', 'ARCHIVE_CONFLICT');
    }
    const lockedActive = lockedArchiveIntent ? null : locateState(root);
    if (lockedActive && lockedActive.changeId !== selected) {
      throw new StateError(`Recovery target ${selected} is not the canonical active change ${lockedActive.changeId}`, 'ACTIVE_CHANGE_MISMATCH');
    }
    if (lockedArchiveIntent) {
      if (lockedArchiveIntent.changeId !== selected) {
        throw new StateError('Archive intent conflicts with requested change', 'ARCHIVE_CONFLICT');
      }
      const source = changeDirectory(root, selected);
      const target = archiveDirectory(root, selected);
      if (existsSync(source) === existsSync(target)) throw new StateError('Archive recovery requires exactly one source or target directory', 'ARCHIVE_CONFLICT');
      if (existsSync(source)) {
        const archiveStateValue = loadNamedStateForRecovery(root, selected);
        validateLoadedState(root, archiveStateValue);
        if (objectDigest(archiveStateValue) !== lockedArchiveIntent.stateDigest) throw new StateError('Archive state does not match intent', 'ARCHIVE_CONFLICT');
        mkdirSync(dirname(target), { recursive: true });
        renameSync(source, target);
        fsyncDirectory(dirname(source));
        fsyncDirectory(dirname(target));
      }
      const archivedState = validateArchivedTree(target, lockedArchiveIntent);
      const pointer = activePointerPath(root);
      if (existsSync(pointer)) {
        const active = readJson(pointer, 'active change pointer', 8192);
        if (active.changeId !== selected) throw new StateError('Archive recovery would clear another active change', 'ARCHIVE_CONFLICT');
        unlinkSync(pointer);
        fsyncDirectory(dirname(pointer));
      }
      const archiveReceiptPath = join(target, 'archive-receipt.json');
      materializeArchiveReceipt(archiveReceiptPath, lockedArchiveIntent);
      clearArchiveIntent(root);
      return { recovered: true, archived: true, state: archivedState, path: target };
    }
    const stagedTransitions = cleanupUncommittedTransitionStaging(root, selected);
    cleanupAtomicEventTemps(root, selected);
    const entries = transitionEntries(root, selected);
    if (entries.length === 0) {
      const transitions = join(changeDirectory(root, selected), 'transitions');
      const rollbackOnlyShell = isUncommittedTransitionShell(root, selected);
      if (stagedTransitions === 0 && !rollbackOnlyShell) {
        throw new StateError('Change directory has no transition intent', 'RECOVERY_EVIDENCE_INVALID');
      }
      if (existsSync(transitions) && readdirSync(transitions).length === 0) rmdirSync(transitions);
      const directory = changeDirectory(root, selected);
      if (readdirSync(directory).length !== 0) {
        throw new StateError('Uncommitted transition staging has conflicting durable evidence', 'RECOVERY_EVIDENCE_INVALID');
      }
      rmdirSync(directory);
      fsyncDirectory(dirname(directory));
      return { recovered: true, rolledBack: true, state: null };
    }
    const incomplete = entries.filter((directory) => !existsSync(join(directory, 'complete')));
    if (incomplete.length === 0) {
      const state = loadNamedStateForRecovery(root, selected);
      if (!state) throw new StateError('Completed transitions have no matching durable state', 'RECOVERY_STATE_CONFLICT');
      const pointer = activePointerPath(root);
      if (!existsSync(pointer) && state?.revision === 0) {
        validateLoadedState(root, state);
        atomicWriteJson(pointer, { schemaVersion: 1, changeId: selected, statePath: stateFile(root, selected), updatedAt: now() });
        return { recovered: true, state };
      }
      if (!existsSync(pointer)) throw new StateError('Pointerless completed state is recoverable only at initialization revision 0', 'RECOVERY_STATE_CONFLICT');
      if (stagedTransitions > 0) {
        validateLoadedState(root, state);
        return { recovered: true, rolledBack: true, state };
      }
      return { recovered: false, state };
    }
    if (incomplete.length !== 1 || incomplete[0] !== entries.at(-1)) {
      throw new StateError('Recovery found orphaned or non-terminal incomplete transitions', 'RECOVERY_EVIDENCE_INVALID');
    }
    const directory = incomplete[0];
    if (!existsSync(join(directory, 'intent.json'))) throw new StateError('Interrupted transition has no intent', 'RECOVERY_EVIDENCE_INVALID');
    const intent = verifyReceipt(join(directory, 'intent.json'), 'transition intent', TRANSITION_INTENT_LIMIT_BYTES).value;
    const terminalIndex = entries.length - 1;
    const prefix = verifyCompletedPrefix(root, selected, entries, terminalIndex);
    if (basename(directory) !== String(terminalIndex).padStart(8, '0')
        || intent.revision !== terminalIndex || intent.changeId !== selected
        || intent.previousStateDigest !== prefix.previousDigest
        || intent.nextState?.revision !== intent.revision || intent.nextState?.changeId !== selected
        || !nonemptyString(intent.type) || !nonemptyString(intent.summary)
        || objectDigest(intent.nextState) !== intent.nextStateDigest) {
      throw new StateError('Interrupted transition intent is inconsistent', 'RECOVERY_EVIDENCE_INVALID');
    }
    assertValidState(intent.nextState);
    if (!lockedActive && terminalIndex > 0) {
      throw new StateError('Pointerless interrupted state beyond initialization cannot be recovered automatically', 'RECOVERY_STATE_CONFLICT');
    }
    const predecessor = prefix.intents.at(-1)?.nextState;
    if (predecessor) {
      for (const key of ['changeId', 'mode', 'baseBranch', 'expectedPrBaseBranch', 'planningRef', 'planningSha', 'createdAt']) {
        if (intent.nextState[key] !== predecessor[key]) throw new StateError(`Interrupted transition changed immutable ${key}`, 'RECOVERY_EVIDENCE_INVALID');
      }
      for (const key of ['kind', 'reference', 'relationship', 'initialDigest']) {
        if (intent.nextState.source[key] !== predecessor.source[key]) throw new StateError(`Interrupted transition changed immutable source.${key}`, 'RECOVERY_EVIDENCE_INVALID');
      }
    }
    const decisionDisposition = decisionDispositionForRecovery(intent, predecessor);
    const semanticSourceRefresh = sourceRefreshForRecovery(root, intent, predecessor);
    const semanticAmendment = amendmentForRecovery(root, intent, predecessor);
    const finalizedIntegration = prefix.intents.some((item) => item.type === 'implementation-finalized');
    const finalizedDevelopment = prefix.intents.some((item) => item.type === 'development-finalized');
    const semanticGitCheckpoint = isSemanticGitCheckpoint(intent, predecessor, finalizedIntegration, finalizedDevelopment);
    if (intent.type === 'git-checkpoint' && !semanticGitCheckpoint) {
      throw new StateError('Interrupted Git checkpoint is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
    }
    materializeIntentEvidence(root, selected, intent);
    const evidenceDigests = new Set();
    for (const name of ['source', 'plan', 'decisions', 'implementation', 'verification']) verifyReceiptTree(join(changeDirectory(root, selected), name), evidenceDigests);
    evidenceDigests.add(verifyReceipt(join(changeDirectory(root, selected), 'worktree.json'), 'owning worktree identity').digest);
    verifyIntentEvidence(root, selected, intent);
    const referencedPaths = new Set([...prefix.intents, intent].flatMap((item) => Object.values(item.evidencePaths ?? {})));
    for (const path of immutableEvidencePaths(root, selected)) {
      if (!referencedPaths.has(path)) throw new StateError(`Recovery found orphan immutable evidence ${path}`, 'RECOVERY_EVIDENCE_INVALID');
    }
    const currentGit = gitObservation(root);
    const semanticAbandonment = intent.type === 'abandoned' && predecessor !== undefined
      && intent.nextState.phase === 'abandoned' && nonemptyString(intent.nextState.abandonmentReason);
    const executionTransition = ['state-upgraded', 'task-bound', 'wave-scheduled', 'task-started',
      'result-accepted', 'integration-intent', 'task-integrated', 'task-rejected', 'implementation-finalized',
      'validation-planned', 'validation-plan-replaced', 'validation-command-intent', 'validation-command-result',
      'validation-completed', 'specialist-planned', 'specialist-result-recorded', 'verifier-result-recorded',
      'finding-human-authorized', 'finding-disposition-recorded', 'development-finalized'].includes(intent.type);
    const exactDecisionObservation = decisionDisposition === 'resolve';
    const exactLateRetain = decisionDisposition === 'retain-plan' && predecessor?.schemaVersion === 2
      && predecessor.execution?.tasks.every((task) => ['integrated', 'no-change'].includes(task.status));
    const recordedGit = semanticGitCheckpoint ? checkpointObservation(intent) : intent.nextState.git;
    const exactLateTransition = semanticSourceRefresh?.late === true || semanticAmendment;
    const exactRecordedObservation = (semanticGitCheckpoint || semanticAbandonment || exactDecisionObservation || exactLateRetain
      || exactLateTransition || executionTransition)
      && currentGit.headSha === recordedGit.headSha
      && currentGit.branch === recordedGit.branch
      && currentGit.clean === recordedGit.clean;
    const recoveryGitInvalid = semanticGitCheckpoint || semanticAbandonment || exactDecisionObservation || exactLateRetain
      || exactLateTransition || executionTransition
      ? !exactRecordedObservation
      : !exactRecordedObservation && (!currentGit.clean || currentGit.headSha !== intent.nextState.planningSha);
    if (recoveryGitInvalid) {
      const requirement = semanticGitCheckpoint
        ? 'the exact branch, HEAD, and cleanliness recorded by the Git checkpoint'
        : semanticAbandonment
        ? 'the exact Git observation recorded by the abandonment transition'
        : exactDecisionObservation || exactLateTransition || executionTransition
          ? 'the exact clean branch and HEAD recorded by the semantic transition'
        : 'clean HEAD at the transition Planning SHA';
      throw new StateError(`Recovery requires ${requirement}`, 'PLANNING_SNAPSHOT_MISMATCH');
    }
    let current = loadNamedStateForRecovery(root, selected);
    const currentDigest = current ? objectDigest(current) : null;
    if (currentDigest === intent.previousStateDigest) {
      atomicWriteJson(stateFile(root, selected), intent.nextState);
      current = intent.nextState;
    } else if (currentDigest !== intent.nextStateDigest) {
      throw new StateError('Current state matches neither side of interrupted transition', 'RECOVERY_STATE_CONFLICT');
    }
    const receipt = materializeTransitionReceipt(directory, intent);
    callCrash(crashStep, 'recovery-before-complete', { revision: intent.revision });
    const events = eventHistory(root, selected);
    if (events.length === prefix.intents.length) appendEvent(root, selected, canonicalEvent(intent));
    else if (events.length !== prefix.intents.length + 1
        || serialized(events.at(-1)) !== serialized(canonicalEvent(intent))) {
      throw new StateError('Interrupted transition event evidence is inconsistent', 'RECOVERY_EVIDENCE_INVALID');
    }
    atomicWriteText(join(directory, 'complete'), `${objectDigest(receipt)}\n`);
    const pointer = activePointerPath(root);
    if (!existsSync(pointer) && intent.revision === 0) {
      atomicWriteJson(pointer, { schemaVersion: 1, changeId: selected, statePath: stateFile(root, selected), updatedAt: now() });
    }
    return { recovered: true, state: current };
  }, lockOptions);
}

function assertCreatedWorktreesRemoved(cwd, state) {
  if (state.schemaVersion !== 2 || !state.execution) return;
  const registrations = registeredWorktrees(cwd);
  const taskById = new Map(state.execution.tasks.map((task) => [task.id, task]));
  const evidenceDirectories = [
    dirname(implementationWorktreeCreationIntentPath(cwd, state.changeId, 'evidence-probe')),
    dirname(implementationWorktreeTombstonePath(cwd, state.changeId, 'evidence-probe')),
  ];
  const evidenceTaskIds = new Set(evidenceDirectories.flatMap((directory) => existsSync(directory)
    ? readdirSync(directory).map((name) => name.replace(/\.sha256$/u, '.json'))
      .map((name) => name.replace(/\.(?:creation|removal)\.json$/u, '').replace(/\.json$/u, ''))
      .filter(nonemptyString) : []));
  for (const taskId of new Set([...taskById.keys(), ...evidenceTaskIds])) {
    const task = taskById.get(taskId) ?? { id: taskId, packetDigest: null, taskBaseSha: null };
    const paths = {
      creation: implementationWorktreeCreationIntentPath(cwd, state.changeId, taskId),
      manifest: implementationWorktreeManifestPath(cwd, state.changeId, taskId),
      removal: implementationWorktreeRemovalIntentPath(cwd, state.changeId, taskId),
      tombstone: implementationWorktreeTombstonePath(cwd, state.changeId, taskId),
    };
    const artifacts = Object.values(paths).some((path) => existsSync(path) || existsSync(path.replace(/\.json$/u, '.sha256')));
    const canonicalPath = resolve(implementationWorktreePath(cwd, state.changeId, taskId));
    const branchRef = `refs/heads/codex/change-${state.changeId}/${taskId}`;
    const physical = existsSync(canonicalPath)
      || registrations.some((entry) => entry.path === canonicalPath || entry.branchRef === branchRef);
    if (!artifacts && !physical) continue;
    const creation = verifyReceipt(paths.creation, `worktree creation intent ${taskId}`);
    const manifest = verifyReceipt(paths.manifest, `worktree manifest ${taskId}`);
    const removal = verifyReceipt(paths.removal, `worktree removal intent ${taskId}`);
    const tombstone = verifyReceipt(paths.tombstone, `worktree tombstone ${taskId}`).value;
    const expectedPacketDigest = task.packetDigest ?? creation.value.packetDigest;
    const expectedBaseSha = task.taskBaseSha ?? creation.value.baseSha;
    const identity = [creation.value, manifest.value, removal.value, tombstone];
    const mismatch = identity.some((record) => record.changeId !== state.changeId || record.taskId !== taskId
      || record.packetDigest !== expectedPacketDigest || record.baseSha !== expectedBaseSha
      || resolve(record.path) !== canonicalPath || record.repository !== gitCommonDirectory(cwd));
    if (creation.value.status !== 'creating' || manifest.value.status !== 'active'
        || manifest.value.creationIntentDigest !== creation.digest || removal.value.status !== 'removing'
        || removal.value.manifestDigest !== manifest.digest || tombstone.status !== 'removed'
        || tombstone.manifestDigest !== manifest.digest || tombstone.removalIntentDigest !== removal.digest
        || tombstone.removedAt !== removal.value.removedAt || mismatch || physical) {
      throw new StateError(`Task ${taskId} worktree must be receipt-valid and physically removed before abandonment`, 'WORKTREE_TOMBSTONE_MISMATCH');
    }
  }
}

export function archiveState({ cwd = process.cwd(), changeId, abandonReason, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withLifecycleAndChangeLocks(root, selected, () => {
    const pointerPath = activePointerPath(root);
    if (!existsSync(pointerPath) || readJson(pointerPath, 'active change pointer', 8192).changeId !== selected) {
      throw new StateError('Only the active change may be archived', 'ARCHIVE_NOT_ACTIVE');
    }
    let state = loadState(root, selected);
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    assertCreatedWorktreesRemoved(root, state);
    const normal = state.mode === 'plan-only' && state.phase === 'ready-to-implement';
    const alreadyAbandoned = state.phase === 'abandoned' && nonemptyString(state.abandonmentReason);
    if (!normal && !alreadyAbandoned && (!abandonReason || !abandonReason.trim())) {
      throw new StateError('Only completed plan-only state archives normally; abandonment requires a reason', 'ARCHIVE_NOT_ALLOWED');
    }
    if (!normal && !alreadyAbandoned) {
      const timestamp = now(clock);
      const next = revised(state, {
        phase: 'abandoned', abandonmentReason: abandonReason.trim(), blockedReasons: [], git: gitObservation(root, clock),
      }, () => new Date(timestamp));
      state = commitTransition({
        cwd: root, previousState: state, nextState: next, type: 'abandoned',
        summary: `Abandoned change: ${abandonReason.trim()}`, crashStep,
      });
    }
    const source = changeDirectory(root, selected);
    const target = archiveDirectory(root, selected);
    if (existsSync(target)) throw new StateError('Archive target already exists', 'ARCHIVE_CONFLICT');
    const archiveTimestamp = now(clock);
    const archiveIntent = {
      schemaVersion: 1, changeId: selected, stateDigest: objectDigest(state),
      createdAt: archiveTimestamp, archivedAt: archiveTimestamp,
    };
    writeArchiveIntent(root, archiveIntent);
    callCrash(crashStep, 'archive-after-intent', {});
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    fsyncDirectory(dirname(source));
    fsyncDirectory(dirname(target));
    callCrash(crashStep, 'archive-after-rename', {});
    if (existsSync(pointerPath)) { unlinkSync(pointerPath); fsyncDirectory(dirname(pointerPath)); }
    validateArchivedTree(target, archiveIntent);
    materializeArchiveReceipt(join(target, 'archive-receipt.json'), archiveIntent);
    clearArchiveIntent(root);
    return { archived: true, changeId: selected, path: target, state };
  }, lockOptions);
}

export function statusObject({ cwd = process.cwd(), changeId } = {}) {
  const root = repositoryRoot(cwd);
  const state = loadState(root, changeId);
  if (!state) return null;
  const git = gitObservation(root);
  const tasks = state.plan ? (readEffectivePlan(root, state)?.tasks ?? []) : [];
  return {
    changeId: state.changeId,
    source: `${state.source.kind}:${state.source.reference}`,
    phase: state.phase,
    revision: state.revision,
    planningSha: state.planningSha,
    currentHeadSha: git.headSha,
    gitClean: git.clean,
    gitDrift: git.headSha !== state.git.headSha || git.clean !== state.git.clean || git.branch !== state.git.branch,
    sourceDrift: state.source.classification,
    checklist: {
      current: state.checklist.filter((item) => item.status === 'current').length,
      ambiguous: state.checklist.filter((item) => item.status === 'ambiguous').length,
      removed: state.checklist.filter((item) => item.status === 'removed').length,
    },
    unresolvedDecisionIds: state.unresolvedDecisionIds,
    taskGraph: { tasks: tasks.length, dependencies: tasks.reduce((sum, task) => sum + (task.dependsOn?.length ?? 0), 0) },
    execution: state.execution ? {
      activeWave: [...state.execution.activeWave],
      statuses: Object.fromEntries([...new Set(state.execution.tasks.map(({ status }) => status))].sort()
        .map((status) => [status, state.execution.tasks.filter((task) => task.status === status).length])),
      integrationTaskId: state.execution.integrationIntent?.taskId ?? null,
    } : null,
    verification: state.verification ? {
      round: state.verification.round, headSha: state.verification.headSha,
      validationStatus: state.verification.validationStatus,
      validationResults: state.verification.validationResultDigests.length,
      requiredReviewers: [...state.verification.requiredReviewerIds],
      specialistResults: state.verification.specialistResultDigests.length,
      verifierRecorded: state.verification.verifierResultDigest !== null,
      unresolvedFindings: state.verification.unresolvedFindingFingerprints.length,
    } : null,
    nextAction: state.nextAction,
  };
}

export function renderStatus(options = {}) {
  const root = repositoryRoot(options.cwd ?? process.cwd());
  const pendingArchive = readArchiveIntent(root);
  let active;
  try {
    const canonicalActive = pendingArchive ? null : locateState(root);
    active = options.changeId ? locateState(root, options.changeId) : canonicalActive;
  }
  catch (error) {
    return boundedStatus([
      'Change: active pointer',
      'Phase: blocked',
      `Active pointer validation failed (${error.code ?? 'STATE_ERROR'}).`,
      'Next action: Inspect or restore the active pointer and its canonical state; automatic recovery is blocked.',
    ]);
  }
  const candidate = pendingArchive?.changeId ?? recoverableChangeId(root);
  if (candidate) {
    const orphaned = !pendingArchive && transitionEntries(root, candidate).length === 0
      && !isUncommittedTransitionShell(root, candidate);
    return boundedStatus([
    `Change: ${candidate}`,
    `Phase: ${orphaned ? 'blocked' : 'recovering'}`,
    orphaned ? 'Durable evidence exists without a transition intent.' : 'Durable transition evidence is incomplete.',
    orphaned ? 'Next action: Inspect the orphan durable evidence; automatic recovery is not permitted.'
      : `Next action: Run change:state recover --change-id ${candidate}.`,
    ]);
  }
  if (active) {
    try { validateState({ cwd: root, changeId: active.changeId }); }
    catch (error) {
      return boundedStatus([
        `Change: ${active.changeId}`,
        'Phase: blocked',
        `Durable evidence validation failed (${error.code ?? 'STATE_ERROR'}).`,
        'Next action: Inspect or restore the durable evidence; automatic recovery and archive are blocked.',
      ]);
    }
  }
  const status = statusObject(options);
  if (!status) return 'No active change-development state.';
  return boundedStatus([
    `Change: ${status.changeId} (${status.source})`,
    `Phase: ${status.phase}; revision: ${status.revision}`,
    `Planning SHA: ${status.planningSha}`,
    `Current HEAD: ${status.currentHeadSha} (${status.gitClean ? 'clean' : 'dirty'})`,
    `Git observation: ${status.gitDrift ? 'drifted from durable state' : 'matches durable state'}`,
    `Source drift: ${status.sourceDrift}`,
    `Checklist: ${status.checklist.current} current, ${status.checklist.ambiguous} ambiguous, ${status.checklist.removed} removed`,
    `Unresolved decisions: ${status.unresolvedDecisionIds.length ? status.unresolvedDecisionIds.join(', ') : 'none'}`,
    `Task graph: ${status.taskGraph.tasks} tasks, ${status.taskGraph.dependencies} dependencies`,
    ...(status.execution ? [`Execution: ${Object.entries(status.execution.statuses).map(([key, count]) => `${count} ${key}`).join(', ')}; active wave: ${status.execution.activeWave.join(', ') || 'none'}`] : []),
    ...(status.verification ? [`Verification round ${status.verification.round}: ${status.verification.validationStatus}; ${status.verification.validationResults} validation result(s); ${status.verification.specialistResults}/${status.verification.requiredReviewers.length} specialist result(s); verifier ${status.verification.verifierRecorded ? 'recorded' : 'pending'}; ${status.verification.unresolvedFindings} unresolved finding(s)`] : []),
    `Next action: ${status.phase === 'integrating' ? status.nextAction
      : status.gitDrift ? 'Run the local PreCompact checkpoint or reconcile Git before continuing.' : status.nextAction}`,
  ]);
}

export function boundedStatus(lines, limit = 2500) {
  const text = lines.join('\n');
  if (text.length <= limit) return text;
  const nextAction = lines.at(-1);
  const suffix = `\n[status truncated]\n${nextAction}`;
  return `${lines.slice(0, -1).join('\n').slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function recoverableChangeId(cwd) {
  const changes = join(changeRoot(cwd), 'changes');
  if (!existsSync(changes)) return null;
  const pointerExists = existsSync(activePointerPath(cwd));
  const candidates = readdirSync(changes, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .filter((changeId) => {
      const inventory = transitionInventory(cwd, changeId);
      if (inventory.pending.length > 0) return true;
      const entries = inventory.committed;
      if (entries.length === 0) return true;
      if (entries.some((directory) => !existsSync(join(directory, 'complete')))) return true;
      return !pointerExists && entries.length === 1 && existsSync(join(changeDirectory(cwd, changeId), 'state.json'));
    });
  if (candidates.length > 1) throw new StateError('Multiple interrupted changes require an explicit --change-id', 'RECOVERY_AMBIGUOUS');
  return candidates[0] ?? null;
}

export function renderRecoverySummary({ cwd = process.cwd(), maxCharacters = HOOK_CONTEXT_LIMIT } = {}) {
  const status = renderStatus({ cwd });
  if (status === 'No active change-development state.') return null;
  const prefix = 'Durable change-development recovery context:\n';
  const bounded = `${prefix}${status}`;
  return bounded.length <= maxCharacters ? bounded : `${bounded.slice(0, Math.max(0, maxCharacters - 15))}\n[truncated]`;
}

export function checkpointGitMetadata({ cwd = process.cwd(), clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd);
  const located = locateState(root);
  if (!located) return { checkpointed: false };
  // PreCompact is local-only: this function performs Git and filesystem reads only.
  return withChangeLock(root, located.changeId, () => {
    const state = loadState(root, located.changeId);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    validateState({ cwd: root, changeId: state.changeId });
    const owner = verifyReceipt(join(changeDirectory(root, state.changeId), 'worktree.json'), 'owning worktree identity').value;
    if (owner.gitDirectory !== worktreeIdentity(root).gitDirectory) {
      return { checkpointed: false, warning: 'Active change-development state belongs to another linked worktree; local Git metadata was not checkpointed.' };
    }
    if (state.phase === 'integrating') {
      return { checkpointed: false, warning: 'A persisted integration intent is active; run reconcile-integration before checkpointing Git metadata.' };
    }
    const observed = gitObservation(root, clock);
    const hasGitBlock = state.phase === 'blocked' && state.blockedReasons.some(isGitBlock);
    if (!hasGitBlock && observed.headSha === state.git.headSha && observed.branch === state.git.branch && observed.clean === state.git.clean) {
      return { checkpointed: false };
    }
    const timestamp = now(clock);
    const history = eventHistory(root, state.changeId);
    const finalizedIntegration = history.some((event) => event.type === 'implementation-finalized');
    const finalizedDevelopment = history.some((event) => event.type === 'development-finalized');
    const next = deriveGitCheckpoint(state, observed, timestamp, { finalizedIntegration, finalizedDevelopment });
    commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'git-checkpoint',
      summary: 'Checkpointed local Git observation before compaction',
      crashStep,
      pendingEvidence: [{
        key: 'gitCheckpointObservationDigest',
        path: `implementation/git-checkpoints/${String(next.revision).padStart(8, '0')}.json`,
        value: observed,
        label: `Git checkpoint observation ${next.revision}`,
      }],
    });
    return { checkpointed: true, state: next };
  }, { timeoutMs: 250, ...lockOptions });
}
