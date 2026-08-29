import { createHash } from 'node:crypto';

import { scopeClassificationMatchesTask, scopeGateForJournal } from '../contracts/contracts.mjs';
import { canonicalJson } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { assertIntegratedWorkerCommit } from './git-authority.mjs';
import {
  readTaskPacketSidecar as readBoundTaskPacketSidecar,
  taskPacketDigest,
} from './evidence/task-packets.mjs';
import { readAcceptedWorkerResult } from './evidence/worker-results.mjs';
import { readScopeJournal } from './evidence/scope-control.mjs';

const MAX_NODES = 10_000;
const PROTECTED_TRANSITION_KINDS = new Set([
  'archive-task-completion',
  'ci-validation',
  'cycle-completion',
  'git-metadata',
  'review-outcome',
  'review-request',
  'review-request-limit',
  'scope-authority',
  'scope-classification',
  'scope-decision',
  'scope-resume',
  'scope-return',
  'targeted-validation',
  'task-completion',
  'task-packet-binding',
  'task-packet-replan',
  'verification-escalation',
  'worker-result-acceptance',
  'worker-result-backfill',
]);

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function immutableSnapshot(value) {
  const snapshot = structuredClone(value);
  const pending = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue;
    pending.push(...Object.values(current));
    Object.freeze(current);
  }
  return snapshot;
}

function invalidAuthorization(message) {
  return new StateError(message, 'INVALID_TRANSITION_AUTHORIZATION');
}

function emptyLocalVerification() {
  return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null };
}

function isPristineVerification(proof) {
  return proof.status === 'not-run' && proof.headSha === null
    && proof.taskIds.length === 0 && proof.updatedAt === null;
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
    checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null,
    updatedAt: null,
  };
}

function staleDiscoveryDispositionList(state) {
  return Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
}

function assertImmutableValue(current, next, label) {
  if (!sameEvidence(current, next)) {
    throw new StateError(`${label} is append-only provenance`, 'IMMUTABLE_STATE_PROVENANCE');
  }
}

function archiveImportFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function exactObjectFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function canonicalImportedTaskRoots(task, rows) {
  const bySource = new Map();
  for (const row of rows) {
    for (const source of [
      `thread:${row.threadNodeId}`,
      `discussion:${row.rootCommentDatabaseId}`,
    ]) {
      if (bySource.has(source) && bySource.get(source) !== row.threadNodeId) return null;
      bySource.set(source, row.threadNodeId);
    }
  }
  const canonicalSources = task.sourceIds.filter((source) => /^(?:thread|discussion):/u.test(source));
  if (canonicalSources.length === 0) return null;
  const roots = new Set();
  for (const source of canonicalSources) {
    const root = bySource.get(source);
    if (root === undefined) return null;
    roots.add(root);
  }
  return [...roots].sort();
}

function bootstrapStateProjection(state) {
  return { tasks: state.tasks, threadResolutionStatus: state.threadResolutionStatus };
}

function assertVerifierBootstrapEnvelope(current, next, envelope) {
  const fields = [
    'schemaVersion', 'taskId', 'integratedCommitSha', 'headSha', 'proofLane',
    'archiveTaskId', 'roots', 'priorStateFingerprint', 'nextStateFingerprint',
  ];
  const rootFields = [
    'threadNodeId', 'rootCommentNodeId', 'rootCommentDatabaseId', 'isResolved', 'taskId',
  ];
  if (!exactObjectFields(envelope, fields)
      || envelope.schemaVersion !== 1
      || envelope.proofLane !== 'localVerification'
      || typeof envelope.taskId !== 'string' || envelope.taskId.length === 0
      || typeof envelope.integratedCommitSha !== 'string'
      || envelope.integratedCommitSha.length < 40
      || envelope.headSha !== current.currentIntegrationHeadSha
      || typeof envelope.archiveTaskId !== 'string' || envelope.archiveTaskId.length === 0
      || !/^[0-9a-f]{64}$/u.test(envelope.priorStateFingerprint ?? '')
      || !/^[0-9a-f]{64}$/u.test(envelope.nextStateFingerprint ?? '')
      || !Array.isArray(envelope.roots) || envelope.roots.length < 2
      || envelope.roots.length > MAX_NODES) {
    throw new StateError('Verifier bootstrap completion envelope is malformed', 'INVALID_ARCHIVE_IMPORT');
  }
  const sortedRoots = envelope.roots.slice().sort(
    (left, right) => String(left?.threadNodeId).localeCompare(String(right?.threadNodeId)),
  );
  if (!sameEvidence(envelope.roots, sortedRoots)
      || new Set(envelope.roots.map((root) => root?.threadNodeId)).size !== envelope.roots.length
      || new Set(envelope.roots.map((root) => root?.rootCommentNodeId)).size !== envelope.roots.length
      || new Set(envelope.roots.map((root) => root?.rootCommentDatabaseId)).size !== envelope.roots.length
      || envelope.roots.some((root) => !exactObjectFields(root, rootFields)
        || typeof root.threadNodeId !== 'string' || root.threadNodeId.length === 0
        || typeof root.rootCommentNodeId !== 'string' || root.rootCommentNodeId.length === 0
        || !Number.isSafeInteger(root.rootCommentDatabaseId) || root.rootCommentDatabaseId <= 0
        || typeof root.isResolved !== 'boolean'
        || typeof root.taskId !== 'string' || root.taskId.length === 0)) {
    throw new StateError('Verifier bootstrap roots are malformed or unordered', 'INVALID_ARCHIVE_IMPORT');
  }

  const task = current.tasks.find((candidate) => candidate.id === envelope.taskId);
  const nextTask = next.tasks.find((candidate) => candidate.id === envelope.taskId);
  const archiveTask = current.tasks.find((candidate) => candidate.id === envelope.archiveTaskId);
  if (!task || !nextTask || task.sourceType !== 'local' || task.disposition !== 'actionable'
      || task.status !== 'integrated' || task.integratedCommitSha !== envelope.integratedCommitSha
      || nextTask.status !== 'completed'
      || !archiveTask || archiveTask.sourceType !== 'github-thread'
      || archiveTask.disposition !== 'already-fixed' || archiveTask.status !== 'not-applicable'
      || archiveTask.integratedCommitSha !== null) {
    throw new StateError('Verifier bootstrap tasks do not match the authorized transition', 'INVALID_ARCHIVE_IMPORT');
  }
  for (const currentTask of current.tasks) {
    const updated = next.tasks.find((candidate) => candidate.id === currentTask.id);
    assertImmutableValue(
      currentTask.id === task.id ? { ...currentTask, status: 'completed' } : currentTask,
      updated,
      `verifier bootstrap task ${currentTask.id}`,
    );
  }
  const remediations = current.tasks.filter((candidate) => (
    ['local', 'github-threadless'].includes(candidate.sourceType)
      && candidate.disposition === 'actionable' && candidate.status === 'integrated'
      && typeof candidate.integratedCommitSha === 'string'
  ));
  if (remediations.length !== 1 || remediations[0].id !== task.id) {
    throw new StateError('Verifier bootstrap remediation is missing or ambiguous', 'INVALID_ARCHIVE_IMPORT');
  }
  const rootsByTask = new Map();
  for (const root of envelope.roots) {
    const roots = rootsByTask.get(root.taskId) ?? [];
    roots.push(root);
    rootsByTask.set(root.taskId, roots);
  }
  const archiveRoots = rootsByTask.get(archiveTask.id) ?? [];
  if (archiveRoots.length < 2 || archiveRoots.some((root) => !root.isResolved)) {
    throw new StateError('Verifier bootstrap archive task lacks its resolved multi-root topology', 'INVALID_ARCHIVE_IMPORT');
  }
  const mappedArchiveRoots = canonicalImportedTaskRoots(archiveTask, archiveRoots.map((root) => ({
    ...root, taskIds: [archiveTask.id], disposition: 'already-fixed',
  })));
  if (mappedArchiveRoots === null
      || !sameEvidence(mappedArchiveRoots, archiveRoots.map((root) => root.threadNodeId).sort())) {
    throw new StateError('Verifier bootstrap archive sources do not cover its roots', 'INVALID_ARCHIVE_IMPORT');
  }
  for (const [taskId, roots] of rootsByTask) {
    const mappedTask = current.tasks.find((candidate) => candidate.id === taskId);
    if (!mappedTask || taskId === task.id || (taskId !== archiveTask.id
        && (roots.some((root) => root.isResolved)
          || mappedTask.sourceType !== 'github-thread'
          || !((mappedTask.disposition === 'actionable'
            && ['integrated', 'completed'].includes(mappedTask.status)
            && typeof mappedTask.integratedCommitSha === 'string')
            || (mappedTask.disposition === 'already-fixed'
              && mappedTask.status === 'not-applicable'
              && mappedTask.integratedCommitSha === null))))) {
      throw new StateError('Verifier bootstrap contains an ineligible exclusive root mapping', 'INVALID_ARCHIVE_IMPORT');
    }
  }
  const aggregate = current.threadResolutionStatus;
  const nextAggregate = next.threadResolutionStatus;
  if (aggregate.status !== 'not-run' || aggregate.headSha !== null
      || aggregate.threads.length !== 0 || aggregate.updatedAt !== null
      || aggregate.threadlessVerification.status !== 'not-run'
      || aggregate.threadlessVerification.headSha !== null
      || aggregate.threadlessVerification.taskIds.length !== 0
      || aggregate.threadlessVerification.updatedAt !== null
      || (aggregate.localVerification ?? emptyLocalVerification()).status !== 'not-run'
      || nextAggregate.localVerification?.status !== 'passed'
      || nextAggregate.localVerification.headSha !== current.currentIntegrationHeadSha
      || !sameEvidence(nextAggregate.localVerification.taskIds, [task.id])
      || nextAggregate.localVerification.updatedAt === null) {
    throw new StateError('Verifier bootstrap requires the pristine local-only proof delta', 'INVALID_ARCHIVE_IMPORT');
  }
  const { localVerification: _oldLocal, ...oldWithoutLocal } = aggregate;
  const { localVerification: _newLocal, ...newWithoutLocal } = nextAggregate;
  if (!sameEvidence(oldWithoutLocal, newWithoutLocal)) {
    throw new StateError('Verifier bootstrap changed proof outside the local lane', 'INVALID_ARCHIVE_IMPORT');
  }
  const priorFingerprint = archiveImportFingerprint(bootstrapStateProjection(current));
  const nextFingerprint = archiveImportFingerprint(bootstrapStateProjection(next));
  if (priorFingerprint !== envelope.priorStateFingerprint
      || nextFingerprint !== envelope.nextStateFingerprint) {
    throw new StateError('Verifier bootstrap state delta does not match its envelope', 'INVALID_ARCHIVE_IMPORT');
  }
}

function assertArchiveImportEnvelope(current, next, envelope) {
  const envelopeFields = ['schemaVersion', 'taskId', 'authorityFingerprint', 'rows'];
  const rowFields = [
    'threadNodeId', 'replyId', 'replyBodySha256', 'provenanceFingerprint', 'rowFingerprint',
  ];
  if (!exactObjectFields(envelope, envelopeFields)
      || envelope.schemaVersion !== 1
      || typeof envelope.taskId !== 'string' || envelope.taskId.length === 0
      || !/^[0-9a-f]{64}$/u.test(envelope.authorityFingerprint ?? '')
      || !Array.isArray(envelope.rows) || envelope.rows.length < 2
      || envelope.rows.length > MAX_NODES) {
    throw new StateError('Archive import completion envelope is malformed', 'INVALID_ARCHIVE_IMPORT');
  }
  const sortedEnvelopeRows = envelope.rows.slice().sort(
    (left, right) => String(left?.threadNodeId).localeCompare(String(right?.threadNodeId)),
  );
  if (!sameEvidence(envelope.rows, sortedEnvelopeRows)
      || new Set(envelope.rows.map((row) => row?.threadNodeId)).size !== envelope.rows.length
      || envelope.rows.some((row) => !exactObjectFields(row, rowFields)
        || typeof row.threadNodeId !== 'string' || row.threadNodeId.length === 0
        || typeof row.replyId !== 'string' || row.replyId.length === 0
        || !/^[0-9a-f]{64}$/u.test(row.replyBodySha256 ?? '')
        || !/^[0-9a-f]{64}$/u.test(row.provenanceFingerprint ?? '')
        || !/^[0-9a-f]{64}$/u.test(row.rowFingerprint ?? ''))) {
    throw new StateError('Archive import completion rows are malformed or unordered', 'INVALID_ARCHIVE_IMPORT');
  }

  const currentTask = current.tasks.find((task) => task.id === envelope.taskId);
  const nextTask = next.tasks.find((task) => task.id === envelope.taskId);
  if (!currentTask || !nextTask || currentTask.sourceType !== 'github-thread'
      || currentTask.disposition !== 'already-fixed' || currentTask.integratedCommitSha !== null
      || !['not-applicable', 'completed'].includes(currentTask.status)
      || nextTask.status !== 'completed') {
    throw new StateError('Archive import task is not an eligible already-fixed transition', 'INVALID_ARCHIVE_IMPORT');
  }
  const remediations = current.tasks.filter((task) => (
    ['local', 'github-threadless'].includes(task.sourceType)
      && task.disposition === 'actionable'
      && ['integrated', 'completed'].includes(task.status)
  ));
  const remediation = remediations[0];
  const localProof = current.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  const selectedProof = remediation?.sourceType === 'local'
    ? localProof
    : current.threadResolutionStatus.threadlessVerification;
  const oppositeProof = remediation?.sourceType === 'local'
    ? current.threadResolutionStatus.threadlessVerification
    : localProof;
  if (remediations.length !== 1 || remediation?.status !== 'completed'
      || typeof remediation.integratedCommitSha !== 'string'
      || selectedProof.status !== 'passed'
      || selectedProof.headSha !== current.currentIntegrationHeadSha
      || !sameEvidence(selectedProof.taskIds, [remediation.id])
      || selectedProof.updatedAt === null
      || !isPristineVerification(oppositeProof)) {
    throw new StateError(
      'Archive import requires one source-matching current-head bootstrap proof',
      'INVALID_ARCHIVE_IMPORT',
    );
  }
  for (const task of current.tasks) {
    const updated = next.tasks.find((candidate) => candidate.id === task.id);
    if (task.id === envelope.taskId) {
      assertImmutableValue({ ...task, status: 'completed' }, updated, `archive import task ${task.id}`);
    } else {
      assertImmutableValue(task, updated, `archive import unrelated task ${task.id}`);
    }
  }

  const currentByRoot = new Map(current.threadResolutionStatus.threads.map(
    (row) => [row.threadNodeId, row],
  ));
  const nextByRoot = new Map(next.threadResolutionStatus.threads.map(
    (row) => [row.threadNodeId, row],
  ));
  const importedRows = [];
  for (const expected of envelope.rows) {
    const row = nextByRoot.get(expected.threadNodeId);
    const provenance = row?.archiveProvenance;
    if (!row || row.taskIds.length !== 1 || row.taskIds[0] !== envelope.taskId
        || row.disposition !== 'already-fixed' || row.isResolved !== true
        || row.replyId !== expected.replyId || row.replyUrl === null
        || row.resolvedAt === null || row.resolvedBy === null
        || provenance?.authorityFingerprint !== envelope.authorityFingerprint
        || provenance?.replyBodySha256 !== expected.replyBodySha256
        || archiveImportFingerprint(provenance) !== expected.provenanceFingerprint
        || archiveImportFingerprint(row) !== expected.rowFingerprint) {
      throw new StateError('Archive import row does not match its authorized evidence', 'INVALID_ARCHIVE_IMPORT');
    }
    importedRows.push(row);
  }
  const importedIds = new Set(importedRows.map((row) => row.threadNodeId));
  const provenanceRows = next.threadResolutionStatus.threads.filter(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  );
  if (provenanceRows.length !== importedRows.length
      || provenanceRows.some((row) => !importedIds.has(row.threadNodeId))) {
    throw new StateError('Archive import provenance exceeds its authorized root coverage', 'INVALID_ARCHIVE_IMPORT');
  }
  const canonicalRoots = canonicalImportedTaskRoots(currentTask, importedRows);
  if (canonicalRoots === null || canonicalRoots.length < 2
      || !sameEvidence(canonicalRoots, [...importedIds].sort())) {
    throw new StateError('Archive import task sources do not exactly cover its canonical roots', 'INVALID_ARCHIVE_IMPORT');
  }

  if (currentTask.status === 'not-applicable') {
    const newlyResolvedIds = next.threadResolutionStatus.threads.filter((row) => (
      row.isResolved === true && currentByRoot.get(row.threadNodeId)?.isResolved !== true
    )).map((row) => row.threadNodeId).sort();
    if (!sameEvidence(newlyResolvedIds, [...importedIds].sort())) {
      throw new StateError(
        'Archive import envelope must cover every newly resolved row exactly',
        'INVALID_ARCHIVE_IMPORT',
      );
    }
    if (current.threadResolutionStatus.status !== 'not-run'
        || current.threadResolutionStatus.headSha !== null
        || current.threadResolutionStatus.threads.length !== 0
        || current.threadResolutionStatus.updatedAt !== null
        || next.threadResolutionStatus.headSha !== current.currentIntegrationHeadSha) {
      throw new StateError('Archive import requires the exact pristine aggregate transition', 'INVALID_ARCHIVE_IMPORT');
    }
  } else if (!sameEvidence(current, next)) {
    throw new StateError('Archive import retry must be byte-identical', 'INVALID_ARCHIVE_IMPORT');
  }
  assertImmutableValue(
    current.threadResolutionStatus.threadlessVerification,
    next.threadResolutionStatus.threadlessVerification,
    'archive import threadless proof',
  );
  assertImmutableValue(
    current.threadResolutionStatus.localVerification ?? emptyLocalVerification(),
    next.threadResolutionStatus.localVerification ?? emptyLocalVerification(),
    'archive import local proof',
  );

  for (const row of provenanceRows) {
    const previous = currentByRoot.get(row.threadNodeId);
    if (previous && Object.hasOwn(previous, 'archiveProvenance')
        && !sameEvidence(previous, row)) {
      throw new StateError('Existing archive provenance is immutable', 'IMMUTABLE_STATE_PROVENANCE');
    }
  }
}

function assertStaleDiscoveryDispositionProvenance(current, next, guardedKind) {
  const currentPresent = Object.hasOwn(current, 'staleDiscoveryDispositions');
  const nextPresent = Object.hasOwn(next, 'staleDiscoveryDispositions');
  const currentDispositions = staleDiscoveryDispositionList(current);
  const nextDispositions = staleDiscoveryDispositionList(next);
  const appended = guardedKind === 'task-completion'
    && nextDispositions.length === currentDispositions.length + 1;
  if (!appended) {
    assertImmutableValue(
      { present: currentPresent, value: currentDispositions },
      { present: nextPresent, value: nextDispositions },
      'staleDiscoveryDispositions',
    );
    return;
  }
  currentDispositions.forEach((disposition, index) => assertImmutableValue(
    disposition, nextDispositions[index], `staleDiscoveryDispositions[${index}]`,
  ));
}

const SCOPE_TRANSITION_KINDS = new Set([
  'scope-authority', 'scope-classification', 'scope-decision', 'scope-resume', 'scope-return',
]);

function assertScopeControlProvenance(current, next, guardedKind, cwd) {
  const currentScope = current.scopeControl;
  const nextScope = next.scopeControl;
  if (guardedKind === 'scope-authority') {
    if (currentScope !== undefined || nextScope === undefined) {
      throw new StateError('Scope authority capture must initialize scope control exactly once', 'INVALID_SCOPE_TRANSITION');
    }
    return;
  }
  if (SCOPE_TRANSITION_KINDS.has(guardedKind)) {
    if (currentScope === undefined || nextScope === undefined) {
      throw new StateError('Guarded scope transition must preserve captured authority', 'IMMUTABLE_STATE_PROVENANCE');
    }
    if (currentScope.authorityDigest !== nextScope.authorityDigest) {
      if (!['scope-decision', 'scope-resume'].includes(guardedKind)) {
        throw new StateError('Only guarded decision or resume may advance scope authority', 'IMMUTABLE_STATE_PROVENANCE');
      }
      const journal = readScopeJournal(cwd, next).value;
      const amendment = journal.entries.findLast((entry) => entry.kind === 'amendment');
      if (!amendment || amendment.priorAuthorityDigest !== currentScope.authorityDigest
          || amendment.revisedAuthorityDigest !== nextScope.authorityDigest
          || journal.authorityDigest !== nextScope.authorityDigest) {
        throw new StateError('Scope authority advancement lacks its exact amendment chain', 'IMMUTABLE_STATE_PROVENANCE');
      }
    }
    if (currentScope.returnDigest !== nextScope.returnDigest
        && (guardedKind !== 'scope-decision'
          || nextScope.gate !== 'return-pending'
          || nextScope.returnDigest === null)) {
      throw new StateError(
        'Only a guarded returning decision may replace scope return identity',
        'IMMUTABLE_STATE_PROVENANCE',
      );
    }
    return;
  }
  if (guardedKind === 'git-metadata') {
    if (currentScope === undefined && nextScope === undefined) return;
    if (currentScope === undefined || nextScope === undefined
        || currentScope.authorityDigest !== nextScope.authorityDigest
        || currentScope.journalDigest !== nextScope.journalDigest
        || currentScope.returnDigest !== nextScope.returnDigest) {
      throw new StateError('Git reconciliation may only invalidate the compact scope applicability projection', 'IMMUTABLE_STATE_PROVENANCE');
    }
    return;
  }
  assertImmutableValue(currentScope, nextScope, 'scopeControl');
}

function scopeClassificationForTask(cwd, state, task, packet) {
  if (!state.scopeControl) return null;
  const journal = readScopeJournal(cwd, state).value;
  const expectedShape = `sha256:${taskPacketDigest(packet)}`;
  const classification = journal.entries.findLast((entry) => entry.kind === 'classification'
    && scopeClassificationMatchesTask(entry, task));
  return classification?.reviewHeadSha === packet.reviewedHeadSha
    && classification.authorityDigest === journal.authorityDigest
    && !classification.authorityAmendmentRequired
    && classification.remediationShapeDigest === expectedShape
    && ['within-scope-defect', 'unnecessary-mechanism-defect'].includes(classification.classification)
    ? classification : null;
}

function assertScopeTaskProgress(cwd, state, task) {
  if (!state.scopeControl) {
    throw new StateError(`Scope authority is insufficient for task ${task.id}`, 'SCOPE_AUTHORITY_REQUIRED');
  }
  const journalEvidence = readScopeJournal(cwd, state);
  if (journalEvidence.digest !== state.scopeControl.journalDigest
      || journalEvidence.value.authorityDigest !== state.scopeControl.authorityDigest) {
    throw new StateError(
      `Scope journal projection is not checkpointed for task ${task.id}`,
      'INVALID_SCOPE_EVIDENCE',
    );
  }
  const journal = journalEvidence.value;
  const gate = state.scopeControl.gate === 'ready'
    ? scopeGateForJournal(journal)
    : state.scopeControl.gate;
  if (gate !== 'ready') {
    throw new StateError(`Scope gate ${gate} blocks task ${task.id}`, 'SCOPE_TASK_BLOCKED');
  }
  const latestAmendment = journal.entries.findLast((entry) => entry.kind === 'amendment');
  const revisedAssessment = latestAmendment === undefined ? true : journal.entries.some(
    (entry) => entry.kind === 'classification'
      && entry.sequence > latestAmendment.sequence
      && entry.authorityDigest === journal.authorityDigest
      && !entry.authorityAmendmentRequired,
  );
  if (!revisedAssessment) {
    throw new StateError(`Scope authority amendment blocks task ${task.id}`, 'SCOPE_TASK_BLOCKED');
  }
  if (typeof task.taskPacketDigest !== 'string') {
    throw new StateError(`Task ${task.id} has no packet for scope classification`, 'SCOPE_CLASSIFICATION_REQUIRED');
  }
  const packet = readBoundTaskPacketSidecar(cwd, state, task);
  if (!scopeClassificationForTask(cwd, state, task, packet)) {
    throw new StateError(`Task ${task.id} lacks current exact-shape scope evidence`, 'SCOPE_CLASSIFICATION_REQUIRED');
  }
}

function assertCheckpointProvenance(current, next, guardedKind, evidence, cwd) {
  const completionKind = ['task-completion', 'archive-task-completion'].includes(guardedKind);
  const currentThreadByRoot = new Map(current.threadResolutionStatus.threads.map(
    (thread) => [thread.threadNodeId, thread],
  ));
  const introducedArchiveProvenance = next.threadResolutionStatus.threads.filter((thread) => (
    Object.hasOwn(thread, 'archiveProvenance')
      && !Object.hasOwn(currentThreadByRoot.get(thread.threadNodeId) ?? {}, 'archiveProvenance')
  ));
  if (introducedArchiveProvenance.length > 0 && guardedKind !== 'archive-task-completion') {
    throw new StateError(
      'Archive provenance may only be introduced by guarded archive import completion',
      'PROTECTED_ARCHIVE_IMPORT_REQUIRED',
    );
  }
  if (guardedKind === 'archive-task-completion') {
    const hasImport = evidence.archiveImportEnvelope !== undefined;
    const hasBootstrap = evidence.verifierBootstrapEnvelope !== undefined;
    if (hasImport === hasBootstrap) {
      throw new StateError(
        'Archive completion requires exactly one protected envelope',
        'INVALID_ARCHIVE_IMPORT',
      );
    }
    if (hasImport) assertArchiveImportEnvelope(current, next, evidence.archiveImportEnvelope);
    else assertVerifierBootstrapEnvelope(current, next, evidence.verifierBootstrapEnvelope);
  }
  if (guardedKind !== 'review-request-limit') {
    assertImmutableValue(
      { present: Object.hasOwn(current, 'reviewRequestLimit'), value: current.reviewRequestLimit ?? null },
      { present: Object.hasOwn(next, 'reviewRequestLimit'), value: next.reviewRequestLimit ?? null },
      'reviewRequestLimit',
    );
  }
  assertStaleDiscoveryDispositionProvenance(current, next, guardedKind);
  assertScopeControlProvenance(current, next, guardedKind, cwd);
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
    if (!currentTaskIds.has(task.id) && task.workerResultDigest) {
      throw new StateError(`New task ${task.id} worker-result binding requires a guarded transition`, 'PROTECTED_TRANSITION_REQUIRED');
    }
  }
  for (const task of current.tasks) {
    const updated = nextTasks.get(task.id);
    if (!updated) throw new StateError(`Task ${task.id} cannot be deleted`, 'IMMUTABLE_STATE_PROVENANCE');
    for (const field of ['id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition']) {
      assertImmutableValue(task[field], updated[field], `task ${task.id} ${field}`);
    }
    if (task.taskPacketDigest) {
      if (guardedKind !== 'task-packet-replan' || updated.taskPacketDigest) {
        assertImmutableValue(task.taskPacketDigest, updated.taskPacketDigest, `task ${task.id} taskPacketDigest`);
      }
    } else if (updated.taskPacketDigest && guardedKind !== 'task-packet-binding') {
      throw new StateError(`Task ${task.id} packet binding requires a guarded transition`, 'PROTECTED_TRANSITION_REQUIRED');
    }
    if (typeof task.workerResultDigest === 'string') {
      assertImmutableValue(task.workerResultDigest, updated.workerResultDigest, `task ${task.id} workerResultDigest`);
    } else if (typeof updated.workerResultDigest === 'string'
        && !['worker-result-acceptance', 'worker-result-backfill'].includes(guardedKind)) {
      throw new StateError(`Task ${task.id} worker-result binding requires a guarded transition`, 'PROTECTED_TRANSITION_REQUIRED');
    }
    const entersImplementedOrIntegrated = !['implemented', 'integrated', 'completed'].includes(task.status)
      && ['implemented', 'integrated'].includes(updated.status);
    const entersIntegrated = !['integrated', 'completed'].includes(task.status)
      && updated.status === 'integrated';
    const entersActiveExecution = !['queued', 'running', 'implemented', 'integrated', 'completed'].includes(task.status)
      && ['queued', 'running', 'implemented', 'integrated'].includes(updated.status);
    const advancesActiveExecution = task.status !== updated.status
      && ['queued', 'running', 'implemented'].includes(task.status)
      && ['queued', 'running', 'implemented', 'integrated'].includes(updated.status);
    if (advancesActiveExecution && updated.disposition === 'actionable') {
      assertScopeTaskProgress(cwd, next, updated);
    }
    if ((entersImplementedOrIntegrated || entersIntegrated) && task.disposition === 'actionable') {
      if (typeof task.taskPacketDigest !== 'string') {
        throw new StateError(
          `Task ${task.id} requires a receipt-valid packet before ${updated.status}`,
          'TASK_PACKET_NOT_BOUND',
        );
      }
      const packet = readBoundTaskPacketSidecar(cwd, current, task);
      const resultTask = guardedKind === 'worker-result-acceptance' ? updated : task;
      const acceptedResult = readAcceptedWorkerResult(cwd, current, resultTask, packet);
      if (entersIntegrated) {
        assertIntegratedWorkerCommit(cwd, current, updated, packet, acceptedResult.result);
      }
    }
    if (entersActiveExecution && updated.disposition === 'actionable') {
      assertScopeTaskProgress(cwd, next, updated);
    }
    if (task.integratedCommitSha !== null) {
      assertImmutableValue(task.integratedCommitSha, updated.integratedCommitSha, `task ${task.id} integratedCommitSha`);
    }
    if (task.resolutionSummary !== null) {
      assertImmutableValue(task.resolutionSummary, updated.resolutionSummary, `task ${task.id} resolutionSummary`);
    }
    if (task.status === 'completed') {
      if (guardedKind === 'worker-result-backfill' && typeof task.workerResultDigest !== 'string') {
        const { workerResultDigest: _workerResultDigest, ...updatedWithoutResult } = updated;
        assertImmutableValue(task, updatedWithoutResult, `completed task ${task.id}`);
      } else {
        assertImmutableValue(task, updated, `completed task ${task.id}`);
      }
    }
    if (task.status !== 'completed' && updated.status === 'completed' && !completionKind) {
      throw new StateError(`Task ${task.id} completion requires guarded proof`, 'PROTECTED_TRANSITION_REQUIRED');
    }
  }

  const nextDecisions = new Map((next.decisions ?? []).map((decision) => [decision.id, decision]));
  for (const decision of current.decisions) {
    assertImmutableValue(decision, nextDecisions.get(decision.id), `decision ${decision.id}`);
  }

  const currentThreads = current.threadResolutionStatus.threads ?? [];
  const nextThreads = next.threadResolutionStatus.threads ?? [];
  if (currentThreads.length > nextThreads.length
      || (currentThreads.length !== nextThreads.length && !completionKind)) {
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
    } else if (updated.replyId !== null && !completionKind) {
      throw new StateError(`Thread ${thread.threadNodeId} reply evidence requires guarded persistence`, 'PROTECTED_TRANSITION_REQUIRED');
    }
    if (thread.isResolved) {
      assertImmutableValue(thread, updated, `resolved thread ${thread.threadNodeId}`);
    } else if (updated.isResolved && !completionKind) {
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
  if (oldThreadless.status !== 'passed' && newThreadless.status === 'passed' && !completionKind) {
    throw new StateError('Threadless proof may only pass through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (newThreadless.taskIds.some((taskId) => !oldThreadless.taskIds.includes(taskId)) && !completionKind) {
    throw new StateError('Threadless task proof may only grow through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  const oldLocal = current.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  const newLocal = next.threadResolutionStatus.localVerification ?? emptyLocalVerification();
  if (!completionKind) assertImmutableValue(oldLocal, newLocal, 'local verifier proof');
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
  if (oldLocal.status !== 'passed' && newLocal.status === 'passed' && !completionKind) {
    throw new StateError('Local verifier proof may only pass through guarded completion', 'PROTECTED_TRANSITION_REQUIRED');
  }
  if (current.threadResolutionStatus.status !== 'passed'
      && next.threadResolutionStatus.status === 'passed' && !completionKind) {
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

export function createTransitionPolicy() {
  const authorizations = new WeakMap();

  function authorizeProtectedTransition(currentState, nextState, kind, evidence = {}) {
    if (!PROTECTED_TRANSITION_KINDS.has(kind)) {
      throw invalidAuthorization(`Unknown protected transition kind: ${kind}`);
    }
    const authorization = Object.freeze({});
    authorizations.set(authorization, {
      kind,
      currentState: immutableSnapshot(currentState),
      nextState: immutableSnapshot(nextState),
      evidence: immutableSnapshot(evidence),
    });
    return authorization;
  }

  function assertTransitionAllowed(currentState, nextState, authorization, cwd) {
    let kind = null;
    let evidence = {};
    if (authorization !== undefined) {
      const stored = authorization !== null && typeof authorization === 'object'
        ? authorizations.get(authorization) : undefined;
      if (!stored || !PROTECTED_TRANSITION_KINDS.has(stored.kind)
          || !sameEvidence(currentState, stored.currentState)
          || !sameEvidence(nextState, stored.nextState)) {
        throw invalidAuthorization('Protected transition authorization is forged, stale, mutated, or mismatched');
      }
      ({ kind, evidence } = stored);
    }
    assertCheckpointProvenance(currentState, nextState, kind, evidence, cwd);
  }

  return Object.freeze({ authorizeProtectedTransition, assertTransitionAllowed });
}
