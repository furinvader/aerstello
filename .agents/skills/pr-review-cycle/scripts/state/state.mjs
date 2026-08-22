import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runGit } from '../../../../../scripts/lib/git.mjs';
import {
  completionGate,
  reviewRequestGate,
  reviewRequestUsage,
  staleDiscoveryDispositionId,
  taskHasCanonicalThreadCoverage,
  validateTaskPacket,
  workerResultDigest,
  validatePrReviewState,
} from '../contracts/contracts.mjs';
import { repositoryRoot } from '../paths.mjs';
import { StateError } from './errors.mjs';
import {
  stateDirectory,
  statePath,
  taskBindingProvenancePath,
  taskBindingProvenanceReceiptPath,
  taskPacketSidecarPath,
} from './locations.mjs';
import {
  atomicWriteJson,
  canonicalJson,
  canonicalSerializedJson,
  readJsonSidecar,
} from './atomic-io.mjs';
import { withStateLock } from './locks.mjs';
import { truncate as truncateSummary } from './recovery.mjs';
import {
  assertIntegratedWorkerCommit,
  gitSnapshot,
} from './git-authority.mjs';
import {
  appendEvent,
  claimGitHubMutationDispatch,
  ensureGitHubMutationIntent,
  prepareEvent,
} from './journal.mjs';
import {
  migratePrReviewStateV2,
} from './migrations.mjs';
import {
  activePrNumber,
  loadState,
  readStateDocument,
  validateStateForWrite,
} from './state-store.mjs';
import {
  assertBehaviorMapperPlanningComplete,
  buildTaskBindingProvenance,
  persistImmutableTaskBindingProvenance,
  readBoundTaskBindingProvenance,
  recoverHistoricalTaskBindingPlanning,
} from './evidence/task-binding.mjs';
import {
  assertTaskPacketHead,
  persistImmutableTaskPacketSidecar,
  readTaskPacketSidecar as readBoundTaskPacketSidecar,
  taskPacketDigest,
} from './evidence/task-packets.mjs';
import {
  persistWorkerResultEvidence,
  proveWorkerResultEvidence,
  readAcceptedWorkerResult,
} from './evidence/worker-results.mjs';
import {
  actionableIntegratedTaskIds,
  actionablePacketValidationTaskIds,
  assertCleanExactIntegrationHead,
  buildTargetedValidationPlanEvidence,
  executeTargetedValidationFacts,
  hasRemainingReviewAllowance,
  isCleanTasklessReviewValidationRecovery,
  isNativeTasklessPendingReviewHeadDriftValidationRecovery,
  isNativeTasklessReviewHeadDriftValidationRecovery,
  readValidationPlan,
  validateValidationPlan,
} from './evidence/validation-plans.mjs';

export { completionGate, reviewRequestGate, reviewRequestUsage } from '../contracts/contracts.mjs';
export { gitCommonDirectory, repositoryRoot, reviewRoot } from '../paths.mjs';
export { StateError } from './errors.mjs';
export {
  activePointerPath,
  specialistPlanReceiptPath,
  specialistReviewBundlePath,
  stateDirectory,
  statePath,
  taskBindingProvenancePath,
  taskBindingProvenanceReceiptPath,
  taskPacketSidecarPath,
  validationPlanPath,
  workerResultEnvelopePath,
  workerResultReceiptPath,
} from './locations.mjs';
export { atomicWriteJson } from './atomic-io.mjs';
export { inspectWorkerCommitAuthority } from './git-authority.mjs';
export { appendEvent, claimGitHubMutationDispatch, ensureGitHubMutationIntent } from './journal.mjs';
export { migratePrReviewStateV1, migratePrReviewStateV2, migrateState } from './migrations.mjs';
export { activePrNumber, initializeState, loadState, locateState } from './state-store.mjs';
export { archiveState } from './archive.mjs';
export { assertTaskPacketBound, loadBoundTaskPackets } from './evidence/task-binding.mjs';
export {
  planSpecialists, readSpecialistStatus, recordSpecialistReview, specialistContext,
} from './evidence/specialist-bundles.mjs';
export { taskPacketDigest } from './evidence/task-packets.mjs';
export { reconcileState } from './reconciliation.mjs';
export { renderRecoverySummary } from './recovery.mjs';
export {
  withGitHubRequestOwnerLock,
  withStateLock,
} from './locks.mjs';

export { ACTIVE_STATE_LIMIT_BYTES } from './state-store.mjs';
const MAX_NODES = 10_000;
const TRANSITION_AUTHORIZATION = Symbol('guarded PR review transition');

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

export function gitAwareGateContext(state, { pushedHeadSha, prHeadSha, prState, isDraft } = {}) {
  const cwd = state.integrationWorktree;
  const local = gitSnapshot(cwd);
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    prHeadSha,
    prState,
    isDraft,
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

function staleDiscoveryDispositionList(state) {
  return Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
}

function staleDiscoveryDispositionForRequest(state, requestId = state?.reviewRequest?.id) {
  return staleDiscoveryDispositionList(state)
    .find((disposition) => disposition.requestId === requestId) ?? null;
}

function activeReviewEvidenceHead(state) {
  return state.reviewedHeadSha
    ?? staleDiscoveryDispositionForRequest(state)?.evidence?.headSha
    ?? null;
}

export function buildTargetedValidationPlan({
  cwd = process.cwd(), prNumber, taskPackets, initialSelection, replace = false, now = utcNow,
} = {}) {
  return buildTargetedValidationPlanEvidence({
    cwd, prNumber, taskPackets, initialSelection, replace, now,
    resetTargetedValidation: checkpointTargetedValidationReset,
    buildReviewOutcome: buildReviewOutcomeTransition,
  });
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
  assertCheckpointProvenance(current, nextState, transitionAuthorization, cwd);
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

function protectedTransition(expectedState, kind, evidence = {}) {
  return { token: TRANSITION_AUTHORIZATION, expectedState, kind, ...evidence };
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
        || current.threadResolutionStatus.threadlessVerification.status !== 'passed'
        || current.threadResolutionStatus.threadlessVerification.headSha
          !== current.currentIntegrationHeadSha
        || current.threadResolutionStatus.threadlessVerification.taskIds.length === 0
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

function assertCheckpointProvenance(current, next, authorization, cwd) {
  const guardedKind = authorization?.token === TRANSITION_AUTHORIZATION ? authorization.kind : null;
  const completionKind = ['task-completion', 'archive-task-completion'].includes(guardedKind);
  if (guardedKind !== null) {
    if (!sameEvidence(next, authorization.expectedState)) {
      throw new StateError('Guarded transition state does not match its authorization', 'INVALID_TRANSITION_AUTHORIZATION');
    }
  }
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
    assertArchiveImportEnvelope(current, next, authorization.archiveImportEnvelope);
  }
  if (guardedKind !== 'review-request-limit') {
    assertImmutableValue(
      { present: Object.hasOwn(current, 'reviewRequestLimit'), value: current.reviewRequestLimit ?? null },
      { present: Object.hasOwn(next, 'reviewRequestLimit'), value: next.reviewRequestLimit ?? null },
      'reviewRequestLimit',
    );
  }
  assertStaleDiscoveryDispositionProvenance(current, next, guardedKind);
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
      if (guardedKind === 'task-packet-replan' && !updated.taskPacketDigest) {
        // The dedicated migration-only replan helper authorizes this one digest clear.
      } else {
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
  if (currentThreads.length > nextThreads.length || (currentThreads.length !== nextThreads.length && !completionKind)) {
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
  if (!completionKind) {
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
  const stalePendingRecovery = isNativeTasklessPendingReviewHeadDriftValidationRecovery(state, []);
  const stalePendingAmbiguity = stalePendingRecovery
    && escalation?.reason === 'request-head-drift'
    && Array.isArray(escalation?.evidenceIds)
    && escalation.evidenceIds.some((id) => id !== `request:${request?.id}`);
  if (!(['awaiting-review', 'awaiting-human-decision'].includes(state.phase) || stalePendingRecovery)
      || request?.kind !== 'verification' || state.verificationReviewUsed !== true
      || state.reviewOutcome !== null || latest?.request?.id !== request.id || latest?.outcome !== null
      || (stalePendingRecovery && escalation?.reason === 'request-head-drift'
        && !stalePendingAmbiguity)) {
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
  if (JSON.stringify([...plan.taskIds].sort()) !== JSON.stringify(actionablePacketValidationTaskIds(state))) {
    throw new StateError('Targeted validation plan no longer covers current actionable Integrated or Resolved tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
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
        || isNativeTasklessReviewHeadDriftValidationRecovery(current, actionableIntegratedTaskIds(current))
        || isNativeTasklessPendingReviewHeadDriftValidationRecovery(
          current, actionableIntegratedTaskIds(current),
        ))) {
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
    if (JSON.stringify([...plan.taskIds].sort()) !== JSON.stringify(actionablePacketValidationTaskIds(state))) {
      throw new StateError('Targeted validation plan no longer covers current actionable Integrated or Resolved tasks', 'VALIDATION_TASK_COVERAGE_MISMATCH');
    }
    plan = executeTargetedValidationFacts({
      cwd, state, plan, runCommand, now, onCommandRecorded,
      beforeCommand: (_entry, currentPlan) => {
        state = loadState(cwd, state.prNumber);
        assertCleanExactIntegrationHead(state);
        if (state.currentIntegrationHeadSha !== currentPlan.headSha
            || state.revision !== currentPlan.stateRevision) {
          throw new StateError('Targeted validation plan is stale', 'VALIDATION_PLAN_STALE');
        }
        if (JSON.stringify([...currentPlan.taskIds].sort())
            !== JSON.stringify(actionablePacketValidationTaskIds(state))) {
          throw new StateError(
            'Targeted validation plan no longer covers current actionable Integrated or Resolved tasks',
            'VALIDATION_TASK_COVERAGE_MISMATCH',
          );
        }
      },
    });
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

function appendStaleDiscoveryDisposition(state, disposition) {
  if (disposition === null || disposition === undefined) return state;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
    throw new StateError(
      'Stale discovery disposition must be a structured evidence record',
      'INVALID_STALE_DISCOVERY_DISPOSITION',
    );
  }
  const dispositions = staleDiscoveryDispositionList(state);
  const conflicting = dispositions.find((entry) => entry.dispositionId === disposition.dispositionId
    || entry.requestId === disposition.requestId
    || entry.evidence?.id === disposition.evidence?.id);
  if (conflicting) {
    if (sameEvidence(conflicting, disposition)) return state;
    throw new StateError(
      'Stale discovery disposition identity was reused with different evidence',
      'STALE_DISCOVERY_DISPOSITION_CONFLICT',
    );
  }
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  if (state.schemaVersion !== 3 || state.legacyReviewProvenance !== null
      || !['recovering', 'ready-for-review'].includes(state.phase)
      || state.tasks.length !== 0
      || request === null || request.kind !== 'discovery'
      || state.reviewOutcome !== null || latest?.outcome !== null
      || !sameEvidence(latest.request, request)
      || state.requestedHeadSha !== request.headSha || state.reviewedHeadSha !== null
      || request.headSha === state.currentIntegrationHeadSha
      || state.git.headSha !== state.currentIntegrationHeadSha || state.git.dirty !== false
      || state.validationStatus.status !== 'passed'
      || state.validationStatus.headSha !== state.currentIntegrationHeadSha
      || state.blockedReasons.length !== 0 || state.verificationEscalation !== null
      || state.tasks.some((task) => task.disposition === 'needs-human-decision')) {
    throw new StateError(
      'Only the latest native pending discovery request with exact current validation may be dispositioned',
      'STALE_DISCOVERY_DISPOSITION_NOT_ALLOWED',
    );
  }
  if (disposition.requestId !== request.id
      || disposition.requestHeadSha !== request.headSha
      || disposition.liveHeadSha !== state.currentIntegrationHeadSha
      || disposition.evidence?.requestId !== request.id
      || disposition.evidence?.kind !== 'discovery'
      || disposition.evidence?.headSha !== request.headSha
      || staleDiscoveryDispositionId(disposition) !== disposition.dispositionId) {
    throw new StateError(
      'Stale discovery disposition does not bind the exact request, prior HEAD, live HEAD, and response',
      'INVALID_STALE_DISCOVERY_DISPOSITION',
    );
  }
  const next = {
    ...state,
    staleDiscoveryDispositions: [...dispositions, disposition],
    ...(disposition.evidence.outcome === 'findings' ? {
      phase: 'triaging',
      threadResolutionStatus: {
        ...state.threadResolutionStatus,
        status: 'not-run',
        headSha: null,
        updatedAt: null,
      },
      nextAction: 'Triage the actionable findings from the dispositioned stale discovery response.',
    } : {}),
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid stale discovery disposition:\n- ${errors.join('\n- ')}`,
      'INVALID_STALE_DISCOVERY_DISPOSITION',
    );
  }
  return next;
}

export function completeIntegratedTasks(state, {
  threadResolutionStatus, verifiedLocalTaskIds = [], staleDiscoveryDisposition = null,
}) {
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
  const next = appendStaleDiscoveryDisposition(
    { ...state, tasks, threadResolutionStatus: completionThreadProof },
    staleDiscoveryDisposition,
  );
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

function checkpointWorkerResultEvidence({
  cwd, selectedPr, current, task, packet, result, expectedRevision, backfill, event, onStep,
}) {
  if (expectedRevision !== current.revision) {
    throw new StateError(`State revision changed: expected ${expectedRevision}, found ${current.revision}`, 'STATE_REVISION_CONFLICT');
  }
  const packetErrors = validateTaskPacket(packet);
  if (packetErrors.length > 0) throw new StateError(`Invalid task packet:\n- ${packetErrors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  if (task.disposition !== 'actionable' || task.taskPacketDigest !== taskPacketDigest(packet)) {
    throw new StateError('Worker result does not match the accepted packet binding', 'TASK_PACKET_CONFLICT');
  }
  const durablePacket = readBoundTaskPacketSidecar(cwd, current, task);
  if (canonicalSerializedJson(durablePacket) !== canonicalSerializedJson(packet)) {
    throw new StateError('Worker result packet differs from its durable sidecar', 'TASK_PACKET_CONFLICT');
  }
  const { envelope } = proveWorkerResultEvidence({ cwd, state: current, task, packet, result });
  if (typeof task.workerResultDigest === 'string') {
    if (backfill && !['integrated', 'completed'].includes(task.status)) {
      throw new StateError('Worker-result backfill requires an Integrated native schema-v3 task', 'WORKER_RESULT_BACKFILL_NOT_ALLOWED');
    }
    const existing = readAcceptedWorkerResult(cwd, current, task, packet);
    if (canonicalSerializedJson(existing) !== canonicalSerializedJson(envelope)) {
      throw new StateError(`Task ${task.id} already has different accepted worker evidence`, 'WORKER_RESULT_CONFLICT');
    }
    return current;
  }
  if (backfill) {
    if (!['integrated', 'completed'].includes(task.status)) {
      throw new StateError('Worker-result backfill requires an Integrated native schema-v3 task', 'WORKER_RESULT_BACKFILL_NOT_ALLOWED');
    }
    for (const version of [1, 2]) {
      const backupPath = join(stateDirectory(cwd, current.prNumber), `state.v${version}.backup.json`);
      if (!existsSync(backupPath)) continue;
      try {
        const legacy = readJsonSidecar(backupPath, `schema-v${version} migration backup`);
        if (legacy.tasks?.some((candidate) => candidate.id === task.id)) {
          throw new StateError(
            `Task ${task.id} originated in schema v${version}; migration cannot synthesize its result`,
            'WORKER_RESULT_BACKFILL_NOT_ALLOWED',
          );
        }
      } catch (error) {
        if (error instanceof StateError && error.code === 'WORKER_RESULT_BACKFILL_NOT_ALLOWED') throw error;
        throw new StateError(`Cannot prove task ${task.id} is native schema v3: ${error.message}`, 'WORKER_RESULT_BACKFILL_NOT_ALLOWED');
      }
    }
    assertIntegratedWorkerCommit(cwd, current, task, packet, result);
  } else {
    if (!['proposed', 'queued', 'running', 'implemented'].includes(task.status)) {
      throw new StateError(`Task ${task.id} cannot accept a worker result while ${task.status}`, 'WORKER_RESULT_ACCEPTANCE_NOT_ALLOWED');
    }
    if (task.status === 'implemented') {
      assertIntegratedWorkerCommit(cwd, current, task, packet, result);
    }
  }
  const nextTask = backfill ? { ...task, workerResultDigest: envelope.resultDigest } : {
    ...task,
    status: 'implemented',
    workerResultDigest: envelope.resultDigest,
    execution: {
      ...task.execution,
      workerCommitSha: result.commitSha,
      validationSummaries: result.validation.map((entry) => truncateSummary(
        `${entry.command}: ${entry.result} — ${entry.summary}`,
        1000,
      )),
      lastError: null,
    },
  };
  const nextState = {
    ...current,
    tasks: current.tasks.map((candidate) => candidate.id === task.id ? nextTask : candidate),
  };
  validateStateForWrite({ ...nextState, revision: current.revision + 1 });
  persistWorkerResultEvidence(cwd, current, task, envelope, onStep);
  const updated = checkpointStateUnlocked({
    cwd, selectedPr, nextState, expectedRevision: current.revision,
    event: event ?? {
      type: backfill ? 'worker-result-backfilled' : 'worker-result-accepted',
      summary: `${backfill ? 'Backfilled' : 'Accepted'} worker result for task ${task.id}`,
    },
    eventWriter: appendEvent,
    transitionAuthorization: protectedTransition(
      nextState, backfill ? 'worker-result-backfill' : 'worker-result-acceptance',
    ),
  });
  onStep?.('state-checkpointed');
  return updated;
}

export function checkpointWorkerResultAcceptance({
  cwd = process.cwd(), prNumber, packet, result, expectedRevision, event, onStep,
} = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    const task = current.tasks.find((candidate) => candidate.id === packet?.taskId);
    if (!task) throw new StateError('Worker result does not match a durable task', 'TASK_PACKET_NOT_BOUND');
    return checkpointWorkerResultEvidence({
      cwd, selectedPr: current.prNumber, current, task, packet, result,
      expectedRevision, backfill: false, event, onStep,
    });
  });
}

export function checkpointWorkerResultBackfill({
  cwd = process.cwd(), prNumber, packet, result, expectedRevision, event, onStep,
} = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    const task = current.tasks.find((candidate) => candidate.id === packet?.taskId);
    if (!task) throw new StateError('Worker result does not match a durable task', 'TASK_PACKET_NOT_BOUND');
    return checkpointWorkerResultEvidence({
      cwd, selectedPr: current.prNumber, current, task, packet, result,
      expectedRevision, backfill: true, event, onStep,
    });
  });
}

export function checkpointReviewRequest({
  cwd = process.cwd(), prNumber, request, pushedHeadSha, prHeadSha, prState, isDraft, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const nextState = buildReviewRequestTransition(
    current,
    request,
    gitAwareGateContext(current, { pushedHeadSha, prHeadSha, prState, isDraft }),
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
  if (expectedRevision !== current.revision) throw new StateError('State revision changed', 'STATE_REVISION_CONFLICT');
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
  if (expectedRevision !== current.revision) throw new StateError('State revision changed', 'STATE_REVISION_CONFLICT');
  const nextState = buildVerificationEscalationTransition(current, escalation);
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'verification-escalation'),
  });
}

export function checkpointCompletion({
  cwd = process.cwd(), prNumber, pushedHeadSha, prHeadSha, prState, isDraft, expectedRevision, event,
} = {}) {
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (expectedRevision !== current.revision) throw new StateError('State revision changed', 'STATE_REVISION_CONFLICT');
  if (current.phase === 'complete') return current;
  const nextState = buildCompletionTransition(
    current,
    gitAwareGateContext(current, { pushedHeadSha, prHeadSha, prState, isDraft }),
  );
  if (nextState === current) return current;
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
  if (expectedRevision !== current.revision) throw new StateError('State revision changed', 'STATE_REVISION_CONFLICT');
  const nextState = buildCiValidationTransition(current, evidence);
  if (nextState === current) return current;
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'ci-validation'),
  });
}

export function checkpointTaskCompletion(options = {}) {
  const {
    cwd = process.cwd(), prNumber, threadResolutionStatus, verifiedLocalTaskIds = [],
    staleDiscoveryDisposition = null, expectedRevision, event,
  } = options;
  if (Object.hasOwn(options, 'archiveImportEnvelope')) {
    throw new StateError(
      'Ordinary task completion cannot accept archive import authorization',
      'PROTECTED_ARCHIVE_IMPORT_REQUIRED',
    );
  }
  const current = loadState(cwd, prNumber);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const priorDispositionCount = staleDiscoveryDispositionList(current).length;
  let nextState = completeIntegratedTasks(current, {
    threadResolutionStatus, verifiedLocalTaskIds, staleDiscoveryDisposition,
  });
  const dispositionAppended = staleDiscoveryDispositionList(nextState).length === priorDispositionCount + 1;
  const recoveryDisposition = staleDiscoveryDispositionForRequest(nextState);
  if (dispositionAppended && recoveryDisposition.evidence.outcome === 'findings') {
    nextState = {
      ...nextState,
      phase: 'triaging',
      threadResolutionStatus: {
        ...nextState.threadResolutionStatus,
        status: 'not-run',
        headSha: null,
        updatedAt: null,
      },
      nextAction: 'Triage the actionable findings from the dispositioned stale discovery response.',
    };
  }
  const pendingHeadDriftReady = isNativeTasklessPendingReviewHeadDriftValidationRecovery(current, [])
    && current.validationStatus.status === 'passed'
    && current.validationStatus.headSha === current.currentIntegrationHeadSha
    && (recoveryDisposition === null || recoveryDisposition.evidence.outcome === 'clean')
    && nextState.threadResolutionStatus.status === 'passed'
    && nextState.threadResolutionStatus.headSha === current.currentIntegrationHeadSha
    && nextState.threadResolutionStatus.threads.length === 0;
  if (pendingHeadDriftReady) {
    nextState = {
      ...nextState,
      phase: 'ready-for-review',
      nextAction: reviewLimitNextAction(nextState),
    };
  }
  if (staleDiscoveryDisposition !== null && sameEvidence(current, nextState)) {
    const expected = expectedRevision ?? nextState.revision;
    return withStateLock(cwd, current.prNumber, () => {
      const locked = loadState(cwd, current.prNumber);
      if (locked === null || locked.revision !== expected || !sameEvidence(locked, current)) {
        throw new StateError(
          `State revision changed during idempotent disposition retry: expected ${expected}, `
            + `found ${locked?.revision ?? 'missing'}`,
          'STATE_REVISION_CONFLICT',
        );
      }
      return locked;
    });
  }
  return checkpointState({
    cwd, prNumber: current.prNumber, nextState, expectedRevision,
    event, transitionAuthorization: protectedTransition(nextState, 'task-completion'),
  });
}

export function checkpointArchiveTaskCompletion({
  cwd = process.cwd(), prNumber, threadResolutionStatus, archiveImportEnvelope,
  expectedRevision, event,
} = {}) {
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new StateError(
        'Archive import completion requires an explicit expected revision',
        'STATE_REVISION_CONFLICT',
      );
    }
    const expected = expectedRevision;
    if (expected !== current.revision) {
      throw new StateError(
        `State revision changed: expected ${expected}, found ${current.revision}`,
        'STATE_REVISION_CONFLICT',
      );
    }
    const nextState = completeIntegratedTasks(current, {
      threadResolutionStatus,
      verifiedLocalTaskIds: [],
      staleDiscoveryDisposition: null,
    });
    const authorization = protectedTransition(nextState, 'archive-task-completion', {
      archiveImportEnvelope,
    });
    if (sameEvidence(current, nextState)) {
      assertArchiveImportEnvelope(current, nextState, archiveImportEnvelope);
      return current;
    }
    return checkpointStateUnlocked({
      cwd,
      selectedPr,
      nextState,
      expectedRevision: expected,
      event,
      eventWriter: appendEvent,
      transitionAuthorization: authorization,
    });
  });
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
