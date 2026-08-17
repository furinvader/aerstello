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
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { gitBuffer, gitText, listTree, readTreeFile, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import {
  digestJson,
  planReadiness,
  validateDevelopmentState,
  validateImplementationPlan,
} from '../contracts/contracts.mjs';
import {
  implementationTaskDigest,
  validateImplementationResult,
  validateImplementationResultAgainstTask,
  validateImplementationTask,
} from '../implementation/contracts.mjs';
import { compareChecklistMappings } from '../source/checklists.mjs';
import { captureSource, refreshSource as captureSourceRefresh } from '../source/source.mjs';
import { createGhGraphqlAdapter } from '../source/gh-adapter.mjs';
import { readGithubIssue } from '../source/github.mjs';
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

export function withChangeLock(cwd, changeId, callback, options = {}) {
  const release = acquireLock(changeLockPath(cwd, changeId), options);
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
  if (state.phase === 'integrated') return 'Continue with the separate integrated validation capability.';
  if (state.phase === 'recovering') return 'Run change:state recover to finish the exact interrupted transition.';
  if (state.phase === 'blocked') return state.execution?.activeWave.length
    ? 'Resolve the listed blocking evidence by accepting or finishing every active-wave task result, then reject/replan.'
    : state.execution?.tasks.some((task) => task.status === 'accepted')
      ? 'Integrate the next dependency-ready accepted task, then resolve the remaining blocked or failed work.'
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
  const errors = normalizeErrors(validateImplementationPlan(plan, {
    planningEvidence: evidence, sourceObservation, readPlanningFile,
  }));
  if (errors.length > 0) return errors;
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

function selectorsAtCommit(cwd, commit) {
  const selectors = new Map();
  for (const entry of listTree(cwd, commit, 'specs/features')) {
    if (entry.type !== 'blob' || !entry.path.endsWith('.feature')) continue;
    const contents = readTreeFile(cwd, commit, entry.path)?.toString('utf8') ?? '';
    for (const match of contents.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gmu)) {
      const paths = selectors.get(match[1]) ?? new Set();
      paths.add(entry.path);
      selectors.set(match[1], paths);
    }
  }
  return selectors;
}

function assertPacketSelectorsAtBase(cwd, packet) {
  const existing = selectorsAtCommit(cwd, packet.taskBaseSha);
  const planned = new Map((packet.plannedE2ESelectors ?? []).map((entry) => [entry.selector, entry.featurePath]));
  for (const selector of planned.keys()) {
    if (existing.has(selector)) throw new StateError(`Planned E2E selector ${selector} already exists at the exact task base`, 'PLANNED_E2E_SELECTOR_MISMATCH');
  }
  for (const validation of packet.requiredValidation.system) {
    for (const rawSelector of validation.selectors) {
      const selector = rawSelector.startsWith('@') ? rawSelector.slice(1) : rawSelector;
      if (!existing.has(selector) && !planned.has(selector)) {
        throw new StateError(`Required E2E selector ${selector} is unknown at the exact task base and is not planned`, 'PLANNED_E2E_SELECTOR_MISMATCH');
      }
    }
  }
}

function assertPlannedSelectorsRealized(cwd, packet, commit) {
  const realized = selectorsAtCommit(cwd, commit);
  for (const { selector, featurePath } of packet.plannedE2ESelectors ?? []) {
    if (!realized.get(selector)?.has(featurePath)) {
      throw new StateError(`Planned E2E selector ${selector} was not realized in ${featurePath} at the worker commit`, 'PLANNED_E2E_SELECTOR_MISMATCH');
    }
  }
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
    if (state.schemaVersion !== 1) throw new StateError('Only development-state v1 can be upgraded', 'STATE_ALREADY_CURRENT');
    if (!state.plan || !['ready-to-implement', 'blocked'].includes(state.phase)) {
      throw new StateError('State upgrade requires an accepted plan at the implementation boundary', 'INVALID_PHASE');
    }
    const current = gitObservation(root, clock);
    if (!current.clean || current.headSha !== state.git.headSha || current.branch !== state.git.branch) {
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
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
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
  const sharedSurface = (task) => task.anticipatedPaths.some((path) => /^(?:package(?:-lock)?\.json|\.agents\/|\.codex\/|\.github\/|packages\/shared\/src\/contracts\.ts|apps\/api\/src\/schema\.ts|apps\/api\/migrations\/|tests\/e2e\/fixtures(?:\/|$)|tests\/e2e\/(?:[^/]+\/)*[^/]+\.steps\.ts$)/u.test(path));
  if (sharedSurface(left) || sharedSurface(right)) return true;
  return false;
}

export function scheduleWave({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
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
    const wave = [];
    for (const task of eligible) if (wave.length < 3 && wave.every((other) => !tasksConflict(task, other))) {
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
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
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

function canonicalFailureReasons(cwd, state, execution, inFlight = null) {
  return execution.tasks.filter((task) => ['blocked', 'failed'].includes(task.status)).map((task) => {
    const result = inFlight?.taskId === task.id
      ? inFlight.result
      : verifyReceipt(join(changeDirectory(cwd, state.changeId), resultEvidencePath(task.id, task.attempt)), `implementation result ${task.id}`).value;
    if (objectDigest(result) !== task.resultDigest || result.taskId !== task.id || result.status !== task.status) {
      throw new StateError(`Task ${task.id} failure evidence does not match its execution summary`, 'TASK_RESULT_MISMATCH');
    }
    return `Task ${task.id} reported ${task.status}: ${result.summary}`;
  });
}

function nonTaskBlockers(cwd, state) {
  const taskFailures = new Map();
  for (const reason of canonicalFailureReasons(cwd, state, state.execution)) {
    taskFailures.set(reason, (taskFailures.get(reason) ?? 0) + 1);
  }
  const preserved = [];
  for (const reason of state.blockedReasons) {
    const remaining = taskFailures.get(reason) ?? 0;
    if (remaining > 0) taskFailures.set(reason, remaining - 1);
    else preserved.push(reason);
  }
  if ([...taskFailures.values()].some((remaining) => remaining !== 0)) {
    throw new StateError('Blocked state is missing receipt-backed task failure evidence', 'TASK_RESULT_MISMATCH');
  }
  return preserved;
}

export function acceptResult({ cwd = process.cwd(), changeId, result, workerCwd, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
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
    const preservedBlockers = nonTaskBlockers(root, state);
    const terminal = result.status === 'implemented' ? 'accepted' : result.status;
    const activeWave = state.execution.activeWave.filter((id) => id !== task.id);
    const execution = replaceExecutionTask(state, task.id, { status: terminal, resultDigest: objectDigest(result), workerCommit: result.workerCommit }, { activeWave });
    const failureReasons = canonicalFailureReasons(root, state, execution, { taskId: task.id, result });
    const blockedReasons = [...preservedBlockers, ...failureReasons];
    const nextPhase = blockedReasons.length ? 'blocked' : 'implementing';
    const next = revised(state, { phase: nextPhase, blockedReasons, execution }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'result-accepted', summary: `Accepted ${terminal} result for ${task.id}`, crashStep,
      pendingEvidence: [{ key: 'implementationResultDigest', path: resultEvidencePath(task.id, task.attempt), value: result, label: `implementation result ${task.id} attempt ${task.attempt}` }] });
  }, lockOptions);
}

function prepareIntegration({ root, selected, taskId, expectedRevision, clock, crashStep, lockOptions }) {
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected });
    if (!['implementing', 'blocked'].includes(state.phase) || state.execution.activeWave.length) throw new StateError('Integration requires implementing or failed-wave blocked state with no active wave', 'INVALID_PHASE');
    const task = executionTask(state, taskId);
    if (task.status !== 'accepted' || !task.workerCommit) throw new StateError(`Task ${taskId} has no accepted worker commit`, 'TASK_STATE_CONFLICT');
    if (!task.dependsOn.every((id) => ['integrated', 'no-change'].includes(executionTask(state, id).status))) {
      throw new StateError(`Task ${taskId} dependencies are not integrated`, 'DEPENDENCY_NOT_INTEGRATED');
    }
    const failureReasons = canonicalFailureReasons(root, state, state.execution);
    if (state.phase === 'blocked' && serialized(failureReasons) !== serialized(state.blockedReasons)) {
      throw new StateError('Integration from blocked state is limited to an accepted sibling of exact receipt-backed task failures', 'INVALID_PHASE');
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
    const state = loadState(root, selected); assertWritableV2(state);
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
    const failuresRemain = execution.tasks.some((entry) => ['blocked', 'failed'].includes(entry.status));
    const failureReasons = canonicalFailureReasons(root, state, execution);
    const next = revised(state, { phase: failuresRemain ? 'blocked' : 'implementing', execution, git: current,
      blockedReasons: failuresRemain ? failureReasons : [] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-integrated',
      summary: `Reconciled integrated task ${task.id} at ${current.headSha}`, crashStep });
  }, lockOptions);
}

export function reconcileIntegration({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  const state = loadState(root, selected); assertRevision(state, expectedRevision); validateState({ cwd: root, changeId: selected });
  if (state.phase === 'integrating' && state.execution?.integrationIntent) {
    const current = gitObservation(root, clock); const intent = state.execution.integrationIntent;
    if (current.branch !== state.git.branch || current.branch === '(detached)') throw new StateError('Integration reconciliation requires the exact owning central branch', 'CENTRAL_GIT_MISMATCH');
    if (current.clean && current.headSha === intent.centralBaseSha) {
      const result = runGit(['cherry-pick', '--no-edit', intent.workerCommit], { cwd: root, allowFailure: true });
      if (result.status !== 0) throw new StateError('Cherry-pick did not complete; durable integration intent remains for inspection', 'INTEGRATION_CHERRY_PICK_FAILED');
    }
  }
  return reconcileIntegrationLocked({ root, selected, expectedRevision, clock, crashStep, lockOptions });
}

export function integrateTask({ cwd = process.cwd(), changeId, taskId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  const intentState = prepareIntegration({ root, selected, taskId, expectedRevision, clock, crashStep, lockOptions });
  const intent = intentState.execution.integrationIntent;
  assertExactCentralObservation(gitObservation(root, clock), intentState, 'Integration cherry-pick');
  const result = runGit(['cherry-pick', '--no-edit', intent.workerCommit], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    throw new StateError('Cherry-pick did not complete; durable integration intent remains for inspection and reconciliation', 'INTEGRATION_CHERRY_PICK_FAILED');
  }
  return reconcileIntegrationLocked({ root, selected, expectedRevision: intentState.revision, clock, crashStep, lockOptions });
}

export function finalizeIntegration({ cwd = process.cwd(), changeId, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
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

export function rejectTask({ cwd = process.cwd(), changeId, taskId, reason, expectedRevision, clock, crashStep, lockOptions } = {}) {
  const root = repositoryRoot(cwd); const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, selected); assertWritableV2(state); assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: selected }); const task = executionTask(state, taskId);
    if (!nonemptyString(reason) || reason.length > 2000) throw new StateError('Task rejection requires a concise reason', 'INVALID_REJECTION');
    if (!['bound', 'scheduled', 'running', 'accepted', 'integration-pending', 'blocked', 'failed'].includes(task.status)) throw new StateError(`Task ${taskId} cannot be rejected from ${task.status}`, 'TASK_STATE_CONFLICT');
    const current = gitObservation(root, clock);
    const requiredHead = state.execution.integrationIntent?.taskId === taskId ? state.execution.integrationIntent.centralBaseSha : state.git.headSha;
    if (!current.clean || current.headSha !== requiredHead || current.branch !== state.git.branch || current.branch === '(detached)') throw new StateError('Rejecting work requires the exact clean owning branch at the pre-conflict base', 'CENTRAL_GIT_MISMATCH');
    const execution = replaceExecutionTask(state, taskId, { status: 'rejected' }, { activeWave: state.execution.activeWave.filter((id) => id !== taskId), integrationIntent: null });
    const next = revised(state, { phase: 'blocked', execution, git: current, blockedReasons: [`Task ${taskId} was explicitly rejected: ${reason}`] }, clock);
    return commitTransition({ cwd: root, previousState: state, nextState: next, type: 'task-rejected', summary: `Rejected implementation task ${taskId}`, crashStep,
      pendingEvidence: [{ key: 'taskRejectionDigest', path: `implementation/rejections/${taskId}/${String(next.revision).padStart(8, '0')}.json`,
        value: { schemaVersion: 1, changeId: state.changeId, taskId, binding: task.binding, reason, rejectedAt: next.updatedAt }, label: `task rejection ${taskId}` }] });
  }, lockOptions);
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

export async function refreshSource({ cwd = process.cwd(), changeId, expectedRevision, sourceAdapter, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  const before = loadState(root, selected);
  if (!before) throw new StateError('No active change state', 'STATE_NOT_FOUND');
  assertRevision(before, expectedRevision);
  validateState({ cwd: root, changeId: selected });
  if (!['planning', 'awaiting-decision', 'ready-to-implement'].includes(before.phase)) {
    throw new StateError(`Source refresh is not permitted in phase ${before.phase}`, 'INVALID_PHASE');
  }
  // The live read is intentionally outside the state lock.
  const previousObservation = readObservationByDigest(root, before);
  const refreshed = await captureSourceRefresh({
    cwd: root,
    planningSha: before.planningSha,
    descriptor: previousObservation.descriptor,
    previousObservation,
    githubReader: githubReaderFor(sourceAdapter),
    now: () => (clock ? clock() : new Date()),
  });
  const observation = refreshed.observation ?? refreshed.source ?? refreshed;
  const suppliedClassification = refreshed.classification ?? refreshed.drift;
  return withChangeLock(root, before.changeId, () => {
    const state = loadState(root, before.changeId);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    if (!['planning', 'awaiting-decision', 'ready-to-implement'].includes(state.phase)) {
      throw new StateError(`Source refresh is not permitted in phase ${state.phase}`, 'INVALID_PHASE');
    }
    const lockedGit = gitObservation(root, clock);
    if (!lockedGit.clean || lockedGit.headSha !== state.planningSha) {
      throw new StateError('Source refresh requires clean HEAD at the Planning SHA', 'PLANNING_SNAPSHOT_MISMATCH');
    }
    const observedClassification = classifyRefresh(state.source, observation, suppliedClassification);
    const classification = state.plan && state.source.classification === 'unreviewed-material'
      ? 'unreviewed-material'
      : state.plan && state.source.classification === 'progress-only' && observedClassification === 'unchanged'
        ? 'progress-only' : observedClassification;
    const timestamp = now(clock);
    const full = observation.fullDigest ?? observation.digest ?? observation.sourceDigest ?? objectDigest(observation);
    const material = observation.materialDigest ?? full;
    const progress = observation.progressDigest ?? full;
    const observationPath = `source/observations/${String(state.revision + 1).padStart(8, '0')}.json`;
    const observationDigest = objectDigest(observation);
    const planningBaseline = state.plan ? null : readInitialObservation(root, state);
    const planningComparison = planningBaseline ? compareChecklistMappings(
      planningBaseline.source?.checklist ?? [],
      observation.source?.checklist ?? [],
    ) : null;
    const next = revised(state, {
      phase: state.plan && classification === 'unreviewed-material' ? 'awaiting-decision' : state.phase,
      source: {
        ...state.source,
        latestDigest: full,
        fullDigest: full,
        materialDigest: material,
        progressDigest: progress,
        classification,
        observationDigest,
        latestCommentIdentity: observation.source?.latestCommentIdentity ?? observation.latestCommentIdentity ?? observation.latestObservedCommentId ?? state.source.latestCommentIdentity,
        refreshedAt: observation.capturedAt ?? timestamp,
      },
      checklist: state.plan
        ? refreshedChecklist(previousObservation, observation, refreshed.checklistComparison)
        : planningChecklist(planningBaseline, observation, planningComparison),
    }, () => new Date(timestamp));
    return commitTransition({
      cwd: root, previousState: state, nextState: next, type: 'source-refreshed',
      summary: `Source refresh classified ${classification}`, crashStep,
      pendingEvidence: [{ key: 'observationDigest', path: observationPath, value: observation, label: 'source observation' }],
    });
  }, lockOptions);
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
    if (retainPlan && (!currentGit.clean || currentGit.headSha !== state.planningSha)) {
      throw new StateError('retain-plan requires clean HEAD at the Planning SHA', 'PLANNING_SNAPSHOT_MISMATCH');
    }
    const timestamp = now(clock);
    const record = {
      schemaVersion: 1, ...decision, changeId: state.changeId,
      stateRevision: state.revision,
      sourceObservationDigest: state.source.observationDigest,
      sourceDigest: state.source.latestDigest,
      effectivePlanDigest: state.plan?.effectiveDigest ?? null,
      repositorySha: currentGit.headSha, recordedAt: timestamp,
    };
    const unresolved = state.unresolvedDecisionIds.filter((id) => id !== decision.id);
    const resolvedPhase = state.phase === 'awaiting-decision' && !retainPlan
      && unresolved.length === 0 && state.source.classification !== 'unreviewed-material'
      ? 'planning' : state.phase;
    const next = revised(state, {
      unresolvedDecisionIds: unresolved,
      phase: retainPlan && unresolved.length === 0 ? 'ready-to-implement' : resolvedPhase,
      source: retainPlan ? { ...state.source, classification: 'unchanged' } : state.source,
      git: currentGit,
      blockedReasons: retainPlan ? [] : state.blockedReasons,
    }, () => new Date(timestamp));
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

export function amendPlan({ cwd = process.cwd(), changeId, amendment, resultingPlan, planningEvidence = [], expectedRevision, clock, crashStep, lockOptions }) {
  const root = repositoryRoot(cwd);
  const selected = selectedChangeId(root, changeId);
  return withChangeLock(root, selected, () => {
    const state = loadState(root, changeId);
    if (!state?.plan) throw new StateError('An accepted plan is required before amendment', 'PLAN_NOT_ACCEPTED');
    assertRevision(state, expectedRevision);
    validateState({ cwd: root, changeId: state.changeId });
    if (!['ready-to-implement', 'awaiting-decision', 'implementing', 'blocked'].includes(state.phase)) {
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
    const errors = readinessErrors(resultingPlan, planningEvidence, sourceObservation,
      ({ planningSha, path }) => readTreeFile(root, planningSha, path));
    if (errors.length > 0) throw new StateError(`Amended plan is not ready:\n- ${errors.join('\n- ')}`, 'PLAN_NOT_READY');
    const prior = readEffectivePlan(root, state);
    if (objectDigest(prior) !== state.plan.effectiveDigest) throw new StateError('Effective plan receipt is inconsistent', 'PLAN_TAMPERED');
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
    const amendedExecution = state.schemaVersion === 2 ? executionFromPlan(resultingPlan, currentGit.headSha) : null;
    if (amendedExecution) amendedExecution.tasks = amendedExecution.tasks.map((task) => {
      const terminal = terminalTasks.find((entry) => entry.id === task.id); return terminal ? terminal : task;
    });
    const next = revised(state, {
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
      ...(state.schemaVersion === 2 ? { execution: amendedExecution } : {}),
    }, () => new Date(timestamp));
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
      || /^(?:source|plan|decisions|implementation)\//u.test(record?.path ?? '');
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
  const receiptRoots = ['source', 'plan', 'decisions', 'implementation'].map((name) => join(changeDirectory(root, state.changeId), name));
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
          if (packet.digest !== task.packetDigest || implementationTaskDigest(packet.value) !== task.packetDigest) throw new StateError(`Task ${task.id} packet summary/receipt mismatch`, 'TASK_PACKET_MISMATCH');
          const completed = ['integrated', 'no-change'].includes(task.status);
          assertPacketPlanBinding(packet.value, effective, state, task.taskBaseSha,
            completed ? packet.value.planDigest : state.plan.effectiveDigest,
            completed ? packet.value.planRevision : effective.planRevision);
          assertPacketMapperProvenance(root, state, packet.value);
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
        if (state.phase === 'integrated') verifiedWorkerTombstone(root, state, task);
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
  for (const name of ['source', 'plan', 'decisions', 'implementation']) visit(join(directory, name));
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
  for (const rootName of ['source', 'plan', 'decisions']) verifyReceiptTree(join(directory, rootName));
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
  const unresolved = predecessor.unresolvedDecisionIds.filter((id) => id !== record.id);
  const resolvedPhase = predecessor.phase === 'awaiting-decision' && !retainPlan
    && unresolved.length === 0 && predecessor.source.classification !== 'unreviewed-material'
    ? 'planning' : predecessor.phase;
  const expected = {
    ...predecessor,
    unresolvedDecisionIds: unresolved,
    phase: retainPlan && unresolved.length === 0 ? 'ready-to-implement' : resolvedPhase,
    source: retainPlan ? { ...predecessor.source, classification: 'unchanged' } : predecessor.source,
    git: intent.nextState.git,
    blockedReasons: retainPlan ? [] : predecessor.blockedReasons,
    revision: predecessor.revision + 1,
    updatedAt: record.recordedAt,
  };
  expected.nextAction = nextActionFor(expected);
  if (serialized(expected) !== serialized(intent.nextState)) {
    throw new StateError('Interrupted decision transition does not match its recorded operation', 'RECOVERY_EVIDENCE_INVALID');
  }
  return record.disposition;
}

const GIT_BLOCK_PREFIXES = [
  'Git observation is not clean at Planning SHA',
  'Central Git observation does not match exact clean durable identity',
];

function isGitBlock(reason) {
  return GIT_BLOCK_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

function restoredCheckpointPhase(state, finalizedIntegration) {
  if (state.source.classification === 'unreviewed-material') return 'awaiting-decision';
  if (!state.plan) return 'planning';
  if (!state.execution) return 'ready-to-implement';
  if (state.phase === 'integrated' || finalizedIntegration) return 'integrated';
  if (state.execution.tasks.every((task) => task.status === 'unbound')) return 'ready-to-implement';
  return 'implementing';
}

function deriveGitCheckpoint(predecessor, observed, updatedAt, { finalizedIntegration = false } = {}) {
  const executionActive = predecessor.schemaVersion === 2 && predecessor.execution !== null;
  const valid = executionActive
    ? observed.clean && observed.headSha === predecessor.git.headSha
      && observed.branch === predecessor.git.branch && observed.branch !== '(detached)'
    : observed.clean && observed.headSha === predecessor.planningSha;
  const gitBlock = valid ? null : executionActive
    ? `Central Git observation does not match exact clean durable identity ${predecessor.git.branch}@${predecessor.git.headSha}`
    : `Git observation is not clean at Planning SHA ${predecessor.planningSha}`;
  const nonGitReasons = predecessor.blockedReasons.filter((reason) => !isGitBlock(reason));
  const hadGitBlock = nonGitReasons.length !== predecessor.blockedReasons.length;
  const immutableTerminal = predecessor.phase === 'abandoned';
  const blockedReasons = immutableTerminal ? predecessor.blockedReasons
    : gitBlock ? [...nonGitReasons, gitBlock] : hadGitBlock ? nonGitReasons : predecessor.blockedReasons;
  const phase = immutableTerminal ? predecessor.phase
    : gitBlock || nonGitReasons.length > 0 ? 'blocked'
      : hadGitBlock ? restoredCheckpointPhase(predecessor, finalizedIntegration) : predecessor.phase;
  const expected = {
    ...predecessor,
    // An invalid execution observation is evidence, never a replacement for the durable integration identity.
    git: executionActive && !valid ? predecessor.git : observed,
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
  // Compatibility for checkpoints written before observation evidence was introduced.
  if (Object.keys(intent.evidence ?? {}).length === 0) return intent.nextState.git;
  return null;
}

function isSemanticGitCheckpoint(intent, predecessor, finalizedIntegration) {
  if (intent.type !== 'git-checkpoint' || !predecessor
      || intent.summary !== 'Checkpointed local Git observation before compaction') return false;
  const observed = checkpointObservation(intent);
  if (!observed) return false;
  return serialized(deriveGitCheckpoint(predecessor, observed, intent.nextState.updatedAt, { finalizedIntegration })) === serialized(intent.nextState);
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
    const finalizedIntegration = prefix.intents.some((item) => item.type === 'implementation-finalized');
    const semanticGitCheckpoint = isSemanticGitCheckpoint(intent, predecessor, finalizedIntegration);
    if (intent.type === 'git-checkpoint' && !semanticGitCheckpoint) {
      throw new StateError('Interrupted Git checkpoint is semantically inconsistent', 'RECOVERY_EVIDENCE_INVALID');
    }
    materializeIntentEvidence(root, selected, intent);
    const evidenceDigests = new Set();
    for (const name of ['source', 'plan', 'decisions', 'implementation']) verifyReceiptTree(join(changeDirectory(root, selected), name), evidenceDigests);
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
      'result-accepted', 'integration-intent', 'task-integrated', 'task-rejected', 'implementation-finalized'].includes(intent.type);
    const exactDecisionObservation = decisionDisposition === 'resolve';
    const recordedGit = semanticGitCheckpoint ? checkpointObservation(intent) : intent.nextState.git;
    const exactRecordedObservation = (semanticGitCheckpoint || semanticAbandonment || exactDecisionObservation || executionTransition)
      && currentGit.headSha === recordedGit.headSha
      && currentGit.branch === recordedGit.branch
      && currentGit.clean === recordedGit.clean;
    const recoveryGitInvalid = semanticGitCheckpoint || semanticAbandonment || exactDecisionObservation || executionTransition
      ? !exactRecordedObservation
      : !exactRecordedObservation && (!currentGit.clean || currentGit.headSha !== intent.nextState.planningSha);
    if (recoveryGitInvalid) {
      const requirement = semanticGitCheckpoint
        ? 'the exact branch, HEAD, and cleanliness recorded by the Git checkpoint'
        : semanticAbandonment
        ? 'the exact Git observation recorded by the abandonment transition'
        : exactDecisionObservation || executionTransition
          ? 'the exact Git observation recorded by the decision transition'
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
    const finalizedIntegration = eventHistory(root, state.changeId).some((event) => event.type === 'implementation-finalized');
    const next = deriveGitCheckpoint(state, observed, timestamp, { finalizedIntegration });
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
