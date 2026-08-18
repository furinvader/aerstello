import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { gitText, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { digestJson } from '../contracts/contracts.mjs';
import { implementationTaskDigest, validateImplementationTask } from '../implementation/contracts.mjs';
import {
  implementationTaskPacketPath,
  implementationWorktreeCreationIntentPath,
  implementationWorktreeManifestPath,
  implementationWorktreePath,
  implementationWorktreeRemovalIntentPath,
  implementationWorktreeRoot,
  implementationWorktreeTombstonePath,
  gitCommonDirectory,
  validateChangeId,
  validateTaskId,
} from '../paths.mjs';
import {
  atomicWriteJson, atomicWriteText, loadState, StateError, validateState, verifyReceipt,
} from '../state/state.mjs';

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const PACKET_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function stableId(value, label, validator) {
  try { return validator(value); }
  catch { throw new StateError(`${label} must be a lowercase-hyphen stable ID`, `INVALID_${label.toUpperCase()}_ID`); }
}

export function sanitizeTaskId(value) { return stableId(value, 'task', validateTaskId); }
function changeId(value) { return stableId(value, 'change', validateChangeId); }
function receiptPath(path) { return path.replace(/\.json$/u, '.sha256'); }
function sameIdentity(left, right) { return digestJson(left) === digestJson(right); }
function callCrash(crashStep, step) {
  if (typeof crashStep === 'function') crashStep(step);
  else if (crashStep === step) throw new StateError(`Simulated worktree interruption at ${step}`, 'SIMULATED_WORKTREE_CRASH');
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new StateError(`Invalid ${label}: ${error.message}`, 'INVALID_WORKTREE_EVIDENCE'); }
}

function readEvidence(path, label) {
  const json = existsSync(path); const receipt = existsSync(receiptPath(path));
  if (!json && !receipt) return null;
  if (!json || !receipt) throw new StateError(`${label} has incomplete receipt evidence`, 'INCOMPLETE_WORKTREE_EVIDENCE');
  return verifyReceipt(path, label);
}

function persistExactEvidence(path, value, label, { crashStep, afterJsonStep } = {}) {
  const json = existsSync(path); const receipt = existsSync(receiptPath(path));
  if (receipt && !json) throw new StateError(`${label} receipt exists without its JSON artifact`, 'INCOMPLETE_WORKTREE_EVIDENCE');
  if (json) {
    const existing = readJson(path, label);
    if (!sameIdentity(existing, value)) throw new StateError(`${label} conflicts with immutable evidence`, 'WORKTREE_EVIDENCE_COLLISION');
    if (!receipt) atomicWriteText(receiptPath(path), `${digestJson(existing)}\n`);
  } else {
    atomicWriteJson(path, value);
    callCrash(crashStep, afterJsonStep);
    atomicWriteText(receiptPath(path), `${digestJson(value)}\n`);
  }
  const verified = verifyReceipt(path, label);
  if (!sameIdentity(verified.value, value)) throw new StateError(`${label} does not equal the requested evidence`, 'WORKTREE_EVIDENCE_COLLISION');
  return verified;
}

function registeredWorktrees(cwd) {
  const records = []; let current = null;
  for (const line of gitText(['worktree', 'list', '--porcelain'], { cwd }).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: resolve(line.slice('worktree '.length)) };
    } else if (current && line.startsWith('HEAD ')) current.headSha = line.slice('HEAD '.length);
    else if (current && line.startsWith('branch ')) current.branchRef = line.slice('branch '.length);
    else if (current && line === 'detached') current.detached = true;
  }
  if (current) records.push(current);
  return records;
}

function branchTip(cwd, branch) {
  const ref = `refs/heads/${branch}`;
  const result = runGit(['show-ref', '--verify', '--quiet', ref], { cwd, allowFailure: true });
  if (result.status === 1) return null;
  if (result.status !== 0) throw new StateError(`Unable to inspect worktree branch ${branch}`, 'WORKTREE_GIT_INSPECTION_FAILED');
  return gitText(['rev-parse', '--verify', '--end-of-options', ref], { cwd });
}

function physicalState(cwd, identity) {
  const registrations = registeredWorktrees(cwd);
  const expectedPath = resolve(identity.path);
  const branchRef = `refs/heads/${identity.branch}`;
  return {
    pathExists: existsSync(expectedPath),
    branchTip: branchTip(cwd, identity.branch),
    pathRegistration: registrations.find((entry) => entry.path === expectedPath) ?? null,
    branchRegistration: registrations.find((entry) => entry.branchRef === branchRef) ?? null,
  };
}

function assertSafeIdentityPath(cwd, change, task, candidate) {
  const root = resolve(implementationWorktreeRoot(cwd));
  const expected = resolve(implementationWorktreePath(cwd, change, task));
  const fromRoot = relative(root, expected);
  if (!fromRoot || fromRoot.startsWith('..') || resolve(root, fromRoot) !== expected || resolve(candidate) !== expected) {
    throw new StateError('Worktree path is outside the canonical shared change-development location', 'UNSAFE_WORKTREE_PATH');
  }
  return expected;
}

function assertPhysicalCreating(identity, physical) {
  const expectedBranchRef = `refs/heads/${identity.branch}`;
  if (physical.pathExists !== Boolean(physical.pathRegistration)) {
    throw new StateError('Creating worktree has an unregistered path or missing registered path', 'WORKTREE_PARTIAL_COLLISION');
  }
  if (physical.pathRegistration && physical.pathRegistration.branchRef !== expectedBranchRef) {
    throw new StateError('Creating worktree path is registered on an unexpected branch', 'WORKTREE_REGISTRATION_MISMATCH');
  }
  if (physical.branchRegistration && physical.branchRegistration.path !== resolve(identity.path)) {
    throw new StateError('Creating worktree branch is registered at an unexpected path', 'WORKTREE_BRANCH_COLLISION');
  }
  if (physical.branchTip !== null && physical.branchTip !== identity.baseSha) {
    throw new StateError('Creating worktree branch does not point to the packet base', 'WORKTREE_BRANCH_COLLISION');
  }
  if (physical.pathRegistration && physical.pathRegistration.headSha !== identity.baseSha) {
    throw new StateError('Creating worktree registration does not point to the packet base', 'WORKTREE_REGISTRATION_MISMATCH');
  }
}

function assertPhysicalActive(identity, physical) {
  const expectedBranchRef = `refs/heads/${identity.branch}`;
  if (!physical.pathExists || !physical.pathRegistration
      || physical.pathRegistration.branchRef !== expectedBranchRef
      || physical.branchRegistration?.path !== resolve(identity.path)
      || physical.branchTip === null
      || physical.pathRegistration.headSha !== physical.branchTip) {
    throw new StateError('Active worktree path, branch, and registration do not match', 'WORKTREE_REGISTRATION_MISMATCH');
  }
}

function assertPhysicalRemoved(identity, physical) {
  if (physical.pathExists || physical.pathRegistration || physical.branchRegistration) {
    throw new StateError('Removed worktree identity still owns a path or registration', 'WORKTREE_TOMBSTONE_CONFLICT');
  }
}

function canonicalIdentity(cwd, change, task, baseSha, packetDigest) {
  const branch = `codex/change-${change}/${task}`;
  const path = assertSafeIdentityPath(cwd, change, task, implementationWorktreePath(cwd, change, task));
  return { schemaVersion: 1, repository: gitCommonDirectory(cwd), changeId: change, taskId: task,
    packetDigest, branch, path, baseSha };
}

function verifyApplicableTask(cwd, identity, allowedStatuses, errorCode, requirement) {
  validateState({ cwd, changeId: identity.changeId });
  const state = loadState(cwd, identity.changeId);
  if (state?.schemaVersion !== 2 || !state.execution) throw new StateError(requirement, errorCode);
  const task = state.execution.tasks.find((entry) => entry.id === identity.taskId);
  if (!task || !allowedStatuses.includes(task.status) || task.binding < 1
      || task.packetDigest !== identity.packetDigest || task.taskBaseSha !== identity.baseSha) {
    throw new StateError(requirement, errorCode);
  }
  const received = verifyReceipt(
    implementationTaskPacketPath(cwd, identity.changeId, identity.taskId, task.binding),
    `implementation packet ${identity.taskId}`,
  );
  const errors = validateImplementationTask(received.value);
  if (errors.length > 0 || received.value.changeId !== identity.changeId
      || received.value.taskId !== identity.taskId || received.value.taskBaseSha !== identity.baseSha
      || received.value.planDigest !== state.plan?.effectiveDigest
      || received.value.planDigest !== state.execution.planDigest
      || implementationTaskDigest(received.value) !== identity.packetDigest
      || received.digest !== identity.packetDigest) {
    throw new StateError('Bound implementation packet receipt does not match the worktree identity', 'WORKTREE_PACKET_MISMATCH');
  }
  return { state, task, packet: received.value };
}

function verifyBoundTask(cwd, identity) {
  return verifyApplicableTask(cwd, identity, ['bound'], 'WORKTREE_TASK_NOT_BOUND',
    'Worktree creation requires an exactly bound task in active development-state v2');
}

function verifyRecoverableTask(cwd, identity) {
  return verifyApplicableTask(cwd, identity, ['bound', 'scheduled', 'rejected'], 'WORKTREE_RECOVERY_NOT_APPLICABLE',
    'Worktree creation recovery requires the same bound, scheduled, or rejected task and immutable packet in active state');
}

function verifyRemovableTask(cwd, record) {
  validateState({ cwd, changeId: record.identity.changeId });
  const state = loadState(cwd, record.identity.changeId);
  const task = state?.schemaVersion === 2 && state.execution
    ? state.execution.tasks.find((entry) => entry.id === record.identity.taskId) : null;
  if (!task || !['integrated', 'no-change', 'rejected'].includes(task.status)
      || task.packetDigest !== record.identity.packetDigest
      || task.taskBaseSha !== record.identity.baseSha
      || (task.status !== 'rejected' && task.worktreeManifestDigest !== record.manifest?.digest)
      || (task.status === 'rejected' && task.worktreeManifestDigest !== null
        && task.worktreeManifestDigest !== record.manifest?.digest)) {
    throw new StateError('Worktree removal requires an integrated, no-change, or explicitly rejected task with the exact manifest binding', 'WORKTREE_REMOVAL_NOT_AUTHORIZED');
  }
  return { state, task };
}

function authorizedTerminalSha(task) {
  if (typeof task.workerCommit === 'string' && FULL_SHA.test(task.workerCommit)) return task.workerCommit;
  if (task.status === 'no-change') return task.taskBaseSha;
  if (task.status === 'rejected') return null;
  throw new StateError('Terminal task state does not identify its authorized worker commit', 'WORKTREE_TERMINAL_IDENTITY_MISMATCH');
}

function assertTerminalBranchTip(identity, physical, terminalSha) {
  if (terminalSha !== null && physical.branchTip !== terminalSha) {
    throw new StateError(
      `Worktree branch ${identity.branch} does not point to its receipt-authorized terminal commit`,
      'WORKTREE_TERMINAL_IDENTITY_MISMATCH',
    );
  }
}

function evidencePaths(cwd, change, task) {
  return {
    creation: implementationWorktreeCreationIntentPath(cwd, change, task),
    manifest: implementationWorktreeManifestPath(cwd, change, task),
    removal: implementationWorktreeRemovalIntentPath(cwd, change, task),
    tombstone: implementationWorktreeTombstonePath(cwd, change, task),
  };
}

function hasArtifact(path) { return existsSync(path) || existsSync(receiptPath(path)); }

function repairCreationEvidence(cwd, identity, crashStep) {
  const paths = evidencePaths(cwd, identity.changeId, identity.taskId);
  const creationValue = { ...identity, status: 'creating' };
  const creation = persistExactEvidence(paths.creation, creationValue, 'worktree creation intent', {
    crashStep, afterJsonStep: 'creation-after-intent-json',
  });
  if (hasArtifact(paths.manifest)) {
    persistExactEvidence(paths.manifest, {
      ...identity, status: 'active', creationIntentDigest: creation.digest,
    }, 'worktree manifest');
  }
  return loadRecord(cwd, identity.changeId, identity.taskId);
}

function loadRecord(cwd, change, task, { ignoreRemovalEvidence = false } = {}) {
  const paths = evidencePaths(cwd, change, task);
  const creation = readEvidence(paths.creation, 'worktree creation intent');
  const manifest = readEvidence(paths.manifest, 'worktree manifest');
  const removal = ignoreRemovalEvidence ? null : readEvidence(paths.removal, 'worktree removal intent');
  const tombstone = ignoreRemovalEvidence ? null : readEvidence(paths.tombstone, 'worktree tombstone');
  if (!creation) {
    if (manifest || removal || tombstone) throw new StateError('Worktree evidence exists without its creation intent', 'INCOMPLETE_WORKTREE_EVIDENCE');
    return null;
  }
  const identity = { ...creation.value }; delete identity.status;
  if (creation.value.status !== 'creating' || identity.changeId !== change || identity.taskId !== task
      || identity.repository !== gitCommonDirectory(cwd)) throw new StateError('Worktree creation intent identity is invalid', 'WORKTREE_IDENTITY_COLLISION');
  assertSafeIdentityPath(cwd, change, task, identity.path);
  const expectedManifest = { ...identity, status: 'active', creationIntentDigest: creation.digest };
  if (manifest && !sameIdentity(manifest.value, expectedManifest)) throw new StateError('Worktree manifest does not match its creation intent', 'WORKTREE_EVIDENCE_COLLISION');
  if (removal) {
    const expected = { ...identity, status: 'removing', manifestDigest: manifest?.digest ?? null, removedAt: removal.value.removedAt };
    if (!manifest || !sameIdentity(removal.value, expected)) throw new StateError('Worktree removal intent does not match its manifest', 'WORKTREE_EVIDENCE_COLLISION');
  }
  if (tombstone) {
    const expected = { ...identity, status: 'removed', manifestDigest: manifest?.digest ?? null,
      removalIntentDigest: removal?.digest ?? null, removedAt: removal?.value.removedAt ?? null };
    if (!manifest || !removal || !sameIdentity(tombstone.value, expected)) throw new StateError('Worktree tombstone does not match its removal intent', 'WORKTREE_TOMBSTONE_MISMATCH');
  }
  return { paths, identity, creation, manifest, removal, tombstone };
}

function repairRemovalEvidence(record, crashStep) {
  if (!record.manifest) return;
  const { paths, identity, manifest } = record;
  const removalJson = existsSync(paths.removal); const removalReceipt = existsSync(receiptPath(paths.removal));
  if (removalReceipt && !removalJson) throw new StateError('Removal intent receipt exists without JSON', 'INCOMPLETE_WORKTREE_EVIDENCE');
  let removal = null;
  if (removalJson) {
    const candidate = readJson(paths.removal, 'worktree removal intent');
    if (typeof candidate.removedAt !== 'string' || Number.isNaN(Date.parse(candidate.removedAt))
        || new Date(candidate.removedAt).toISOString() !== candidate.removedAt) {
      throw new StateError('Removal intent has an invalid canonical timestamp', 'WORKTREE_EVIDENCE_COLLISION');
    }
    const expected = { ...identity, status: 'removing', manifestDigest: manifest.digest,
      removedAt: candidate.removedAt };
    removal = persistExactEvidence(paths.removal, expected, 'worktree removal intent', {
      crashStep, afterJsonStep: 'removal-after-intent-json',
    });
  }
  const tombstoneJson = existsSync(paths.tombstone); const tombstoneReceipt = existsSync(receiptPath(paths.tombstone));
  if (tombstoneReceipt && !tombstoneJson) throw new StateError('Tombstone receipt exists without JSON', 'INCOMPLETE_WORKTREE_EVIDENCE');
  if (tombstoneJson) {
    if (!removal) throw new StateError('Tombstone exists without a complete removal intent', 'INCOMPLETE_WORKTREE_EVIDENCE');
    persistExactEvidence(paths.tombstone, { ...identity, status: 'removed', manifestDigest: manifest.digest,
      removalIntentDigest: removal.digest, removedAt: removal.value.removedAt }, 'worktree tombstone', {
      crashStep, afterJsonStep: 'removal-after-tombstone-json',
    });
  }
}

function publicRecord(record, status, physical) {
  const evidence = record.tombstone?.value ?? record.removal?.value ?? record.manifest?.value ?? record.creation.value;
  return { ...evidence, status, exists: physical.pathExists, registered: physical.pathRegistration,
    removedAt: record.removal?.value.removedAt ?? null };
}

function inspectRecord(cwd, record) {
  const physical = physicalState(cwd, record.identity);
  if (record.tombstone) {
    assertPhysicalRemoved(record.identity, physical);
    return publicRecord(record, 'removed', physical);
  }
  if (record.removal) {
    if (physical.pathExists || physical.pathRegistration || physical.branchRegistration) assertPhysicalActive(record.identity, physical);
    return publicRecord(record, 'removing', physical);
  }
  if (record.manifest) {
    assertPhysicalActive(record.identity, physical);
    return publicRecord(record, 'active', physical);
  }
  assertPhysicalCreating(record.identity, physical);
  return publicRecord(record, 'creating', physical);
}

function assertNoOrphanPhysical(cwd, identity) {
  const physical = physicalState(cwd, identity);
  if (physical.pathExists || physical.branchTip || physical.pathRegistration || physical.branchRegistration) {
    throw new StateError('Worktree path, branch, or registration exists without durable creation intent', 'WORKTREE_ORPHAN_COLLISION');
  }
}

function finishCreation(cwd, record, crashStep) {
  if (record.tombstone || record.removal) throw new StateError('Removed or removing worktree identity cannot be recreated', 'WORKTREE_REMOVED');
  if (record.manifest) return inspectRecord(cwd, record);
  let physical = physicalState(cwd, record.identity);
  assertPhysicalCreating(record.identity, physical);
  if (!physical.pathRegistration) {
    if (physical.branchTip === null) {
      runGit(['worktree', 'add', '-b', record.identity.branch, record.identity.path, record.identity.baseSha], { cwd });
    } else {
      runGit(['worktree', 'add', record.identity.path, record.identity.branch], { cwd });
    }
    physical = physicalState(cwd, record.identity);
    assertPhysicalCreating(record.identity, physical);
  }
  callCrash(crashStep, 'creation-after-worktree-add');
  const manifest = { ...record.identity, status: 'active', creationIntentDigest: record.creation.digest };
  persistExactEvidence(record.paths.manifest, manifest, 'worktree manifest', {
    crashStep, afterJsonStep: 'creation-after-manifest-json',
  });
  return inspectRecord(cwd, loadRecord(cwd, record.identity.changeId, record.identity.taskId));
}

export function createTaskWorktree({ cwd = process.cwd(), changeId: rawChangeId, taskId: rawTaskId,
  base, packetDigest, crashStep } = {}) {
  const change = changeId(rawChangeId); const task = sanitizeTaskId(rawTaskId);
  if (typeof base !== 'string' || !FULL_SHA.test(base)) throw new StateError('Worktree base must be an explicit full commit SHA', 'INVALID_WORKTREE_BASE');
  if (typeof packetDigest !== 'string' || !PACKET_DIGEST.test(packetDigest)) throw new StateError('Packet digest must be an explicit sha256 digest', 'INVALID_PACKET_DIGEST');
  const baseSha = resolveCommit(cwd, base);
  if (baseSha !== base) throw new StateError('Worktree base did not resolve to the supplied commit SHA', 'INVALID_WORKTREE_BASE');
  const identity = canonicalIdentity(cwd, change, task, baseSha, packetDigest);
  verifyBoundTask(cwd, identity);
  const paths = evidencePaths(cwd, change, task);
  if (hasArtifact(paths.creation)) {
    const record = repairCreationEvidence(cwd, identity, crashStep);
    if (!sameIdentity(record.identity, identity)) throw new StateError('Requested worktree identity conflicts with durable creation intent', 'WORKTREE_IDENTITY_COLLISION');
    return finishCreation(cwd, record, crashStep);
  }
  if ([paths.manifest, paths.removal, paths.tombstone].some(hasArtifact)) {
    throw new StateError('Worktree evidence exists without its creation intent', 'INCOMPLETE_WORKTREE_EVIDENCE');
  }
  assertNoOrphanPhysical(cwd, identity);
  const record = repairCreationEvidence(cwd, identity, crashStep);
  callCrash(crashStep, 'creation-after-intent');
  return finishCreation(cwd, record, crashStep);
}

export function recoverTaskWorktree({ cwd = process.cwd(), changeId: rawChangeId, taskId: rawTaskId,
  crashStep } = {}) {
  const change = changeId(rawChangeId); const task = sanitizeTaskId(rawTaskId);
  const paths = evidencePaths(cwd, change, task);
  if (!existsSync(paths.creation)) {
    if (existsSync(receiptPath(paths.creation))) throw new StateError('Creation intent receipt exists without JSON', 'INCOMPLETE_WORKTREE_EVIDENCE');
    throw new StateError('Unknown implementation worktree', 'UNKNOWN_WORKTREE');
  }
  const candidate = readJson(paths.creation, 'worktree creation intent');
  const candidateIdentity = { ...candidate }; delete candidateIdentity.status;
  if (candidate.status !== 'creating' || candidateIdentity.changeId !== change || candidateIdentity.taskId !== task
      || !FULL_SHA.test(candidateIdentity.baseSha ?? '') || !PACKET_DIGEST.test(candidateIdentity.packetDigest ?? '')) {
    throw new StateError('Creation intent cannot be recovered safely', 'WORKTREE_IDENTITY_COLLISION');
  }
  const expected = canonicalIdentity(cwd, change, task, candidateIdentity.baseSha, candidateIdentity.packetDigest);
  if (!sameIdentity(candidateIdentity, expected)) throw new StateError('Creation intent is not canonical for this repository', 'WORKTREE_IDENTITY_COLLISION');
  if (hasArtifact(paths.removal) || hasArtifact(paths.tombstone)) {
    return removeTaskWorktree({ cwd, changeId: change, taskId: task, crashStep });
  }
  verifyRecoverableTask(cwd, expected);
  if (existsSync(paths.manifest) && existsSync(receiptPath(paths.manifest))) {
    return inspectTaskWorktree({ cwd, changeId: change, taskId: task });
  }
  const record = repairCreationEvidence(cwd, expected, crashStep);
  return finishCreation(cwd, record, crashStep);
}

export function inspectTaskWorktree({ cwd = process.cwd(), changeId: rawChangeId, taskId: rawTaskId } = {}) {
  const change = changeId(rawChangeId); const task = sanitizeTaskId(rawTaskId);
  const record = loadRecord(cwd, change, task);
  if (!record) throw new StateError('Unknown implementation worktree', 'UNKNOWN_WORKTREE');
  return inspectRecord(cwd, record);
}

export function removeTaskWorktree({ cwd = process.cwd(), changeId: rawChangeId, taskId: rawTaskId,
  crashStep, clock } = {}) {
  const change = changeId(rawChangeId); const task = sanitizeTaskId(rawTaskId);
  const baseRecord = loadRecord(cwd, change, task, { ignoreRemovalEvidence: true });
  if (!baseRecord) throw new StateError('Unknown implementation worktree; refusing cleanup', 'UNKNOWN_WORKTREE');
  const terminal = verifyRemovableTask(cwd, baseRecord);
  const terminalSha = authorizedTerminalSha(terminal.task);
  assertTerminalBranchTip(baseRecord.identity, physicalState(cwd, baseRecord.identity), terminalSha);
  repairRemovalEvidence(baseRecord, crashStep);
  let record = loadRecord(cwd, change, task);
  if (record.tombstone) return inspectRecord(cwd, record);
  if (!record.manifest) throw new StateError('Creating worktree must be recovered before removal', 'WORKTREE_CREATION_INCOMPLETE');
  let physical = physicalState(cwd, record.identity);
  if (!record.removal) {
    assertPhysicalActive(record.identity, physical);
    if (gitText(['status', '--porcelain'], { cwd: record.identity.path })) throw new StateError(`Worktree ${record.identity.path} is dirty`, 'DIRTY_WORKTREE');
    const removal = { ...record.identity, status: 'removing', manifestDigest: record.manifest.digest,
      removedAt: (clock ? clock() : new Date()).toISOString() };
    persistExactEvidence(record.paths.removal, removal, 'worktree removal intent', {
      crashStep, afterJsonStep: 'removal-after-intent-json',
    });
    record = loadRecord(cwd, change, task);
    callCrash(crashStep, 'removal-after-intent');
  }
  physical = physicalState(cwd, record.identity);
  if (physical.pathExists || physical.pathRegistration || physical.branchRegistration) {
    assertPhysicalActive(record.identity, physical);
    if (gitText(['status', '--porcelain'], { cwd: record.identity.path })) throw new StateError(`Worktree ${record.identity.path} is dirty`, 'DIRTY_WORKTREE');
    assertTerminalBranchTip(record.identity, physical, terminalSha);
    runGit(['worktree', 'remove', record.identity.path], { cwd });
  }
  physical = physicalState(cwd, record.identity);
  assertPhysicalRemoved(record.identity, physical);
  callCrash(crashStep, 'removal-after-worktree-remove');
  assertTerminalBranchTip(record.identity, physical, terminalSha);
  const tombstone = { ...record.identity, status: 'removed', manifestDigest: record.manifest.digest,
    removalIntentDigest: record.removal.digest, removedAt: record.removal.value.removedAt };
  persistExactEvidence(record.paths.tombstone, tombstone, 'worktree tombstone', {
    crashStep, afterJsonStep: 'removal-after-tombstone-json',
  });
  return inspectRecord(cwd, loadRecord(cwd, change, task));
}

export const createImplementationWorktree = createTaskWorktree;
export const recoverImplementationWorktree = recoverTaskWorktree;
export const inspectImplementationWorktree = inspectTaskWorktree;
export const removeImplementationWorktree = removeTaskWorktree;
