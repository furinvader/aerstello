import {
  staleDiscoveryDispositionId,
  taskHasCanonicalThreadCoverage,
  validatePrReviewState,
} from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

const VERIFIED_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyLocalVerification() {
  return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null };
}

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
  const dispositions = Array.isArray(state?.staleDiscoveryDispositions)
    ? state.staleDiscoveryDispositions : [];
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
    throw new StateError(
      'Thread resolution proof is required for task completion',
      'INVALID_TASK_COMPLETION',
    );
  }
  if (!Array.isArray(verifiedLocalTaskIds)
      || verifiedLocalTaskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
      || new Set(verifiedLocalTaskIds).size !== verifiedLocalTaskIds.length) {
    throw new StateError(
      'Verified local task IDs must be unique nonempty strings',
      'INVALID_TASK_COMPLETION',
    );
  }
  const verifiedLocalTasks = new Set(verifiedLocalTaskIds);
  for (const taskId of verifiedLocalTasks) {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new StateError(
        `Verified local task ${taskId} was not found`,
        'INVALID_TASK_COMPLETION',
      );
    }
    if (task.sourceType !== 'local') {
      throw new StateError(
        `Verified local task ${taskId} is not local`,
        'INVALID_TASK_COMPLETION',
      );
    }
    if (!taskIsEligibleForVerifierCompletion(task)) {
      throw new StateError(
        `Verified local task ${taskId} is not eligible for verifier completion`,
        'INVALID_TASK_COMPLETION',
      );
    }
  }
  const previousLocalVerification = state.threadResolutionStatus.localVerification
    ?? emptyLocalVerification();
  const { localVerification: _untrustedLocalVerification, ...threadProofWithoutLocal }
    = threadResolutionStatus;
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
  if (errors.length > 0) {
    throw new StateError(
      `Invalid integrated-to-completed transition:\n- ${errors.join('\n- ')}`,
      'INVALID_TASK_COMPLETION',
    );
  }
  return next;
}
