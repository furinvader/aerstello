import { reviewRequestUsage } from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

function emptyTargetedValidation() {
  return {
    source: 'orchestrator', scope: 'targeted', status: 'not-run',
    headSha: null, checks: [], updatedAt: null,
  };
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function staleDiscoveryDispositionForRequest(state, requestId = state?.reviewRequest?.id) {
  const records = Array.isArray(state?.staleDiscoveryDispositions)
    ? state.staleDiscoveryDispositions : [];
  return records.find((item) => item.requestId === requestId) ?? null;
}

function hasRemainingReviewAllowance(state) {
  return !reviewRequestUsage(state).exhausted;
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

function isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  return state.schemaVersion === 3 && state.legacyReviewProvenance === null
    && state.phase === 'recovering' && state.tasks.length === 0 && expectedIds.length === 0
    && request !== null && outcome?.outcome === 'clean' && latest !== undefined
    && sameEvidence(latest.request, request) && sameEvidence(latest.outcome, outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === priorHeadSha
    && outcome.headSha === priorHeadSha && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && hasRemainingReviewAllowance(state);
}

function isNativeTasklessPendingReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const disposition = staleDiscoveryDispositionForRequest(state, request?.id);
  return state.schemaVersion === 3 && state.legacyReviewProvenance === null
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

export function buildTaskPacketReplanTransition(state, taskId) {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new StateError(`Task ${taskId} was not found`, 'TASK_PACKET_REPLAN_NOT_ALLOWED');
  const { taskPacketDigest: _digest, execution: _execution, ...withoutBinding } = task;
  const nextTask = task.status === 'integrated' ? withoutBinding : {
    ...withoutBinding,
    status: 'proposed',
    integratedCommitSha: null,
    resolutionSummary: null,
    execution: {
      dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
      workerCommitSha: null, validationSummaries: [], lastError: null,
    },
  };
  return {
    ...state,
    phase: 'recovering',
    tasks: state.tasks.map((candidate) => candidate.id === taskId ? nextTask : candidate),
    validationStatus: emptyTargetedValidation(),
    nextAction: `Create an explicit schema-v3 specialist plan and bind a new packet for task ${taskId}.`,
  };
}

export function buildTaskPacketBindingTransition(state, taskId, digest) {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.disposition !== 'actionable') {
    throw new StateError('Task packet must match an actionable durable task', 'TASK_PACKET_NOT_BOUND');
  }
  if (task.taskPacketDigest === digest) return state;
  return {
    ...state,
    tasks: state.tasks.map((candidate) => candidate.id === taskId
      ? { ...candidate, taskPacketDigest: digest } : candidate),
  };
}

export function buildWorkerResultTransition(state, {
  taskId, envelope, result, backfill = false, validationSummaries,
}) {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new StateError('Worker result does not match a durable task', 'TASK_PACKET_NOT_BOUND');
  const nextTask = backfill ? { ...task, workerResultDigest: envelope.resultDigest } : {
    ...task,
    status: 'implemented',
    workerResultDigest: envelope.resultDigest,
    execution: {
      ...task.execution,
      workerCommitSha: result.commitSha,
      validationSummaries,
      lastError: null,
    },
  };
  return {
    ...state,
    tasks: state.tasks.map((candidate) => candidate.id === taskId ? nextTask : candidate),
  };
}

export function buildTargetedValidationResetTransition(state) {
  if (state.validationStatus.status === 'not-run') return state;
  const expectedIds = state.tasks.filter((task) => task.disposition === 'actionable'
    && task.status === 'integrated').map((task) => task.id).sort();
  if (state.validationStatus.status === 'passed'
      && (isCleanTasklessReviewValidationRecovery(state, expectedIds)
        || isNativeTasklessReviewHeadDriftValidationRecovery(state, expectedIds)
        || isNativeTasklessPendingReviewHeadDriftValidationRecovery(state, expectedIds))) {
    throw new StateError(
      'Taskless review recovery cannot discard existing targeted-validation proof',
      'INITIAL_VALIDATION_NOT_ALLOWED',
    );
  }
  return {
    ...state,
    validationStatus: emptyTargetedValidation(),
    ...(state.phase === 'ready-for-review' ? {
      phase: 'recovering',
      nextAction: 'Run the saved targeted validation plan before requesting review.',
    } : {}),
  };
}
