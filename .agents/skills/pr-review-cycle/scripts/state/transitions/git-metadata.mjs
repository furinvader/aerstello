import { reviewRequestUsage, validatePrReviewState } from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function validateTransition(next) {
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid Git metadata transition:\n- ${errors.join('\n- ')}`,
      'INVALID_GIT_METADATA',
    );
  }
  return next;
}

function reviewLimitNextAction(state) {
  const usage = reviewRequestUsage(state);
  if (usage.exhausted) {
    return `Review request limit ${usage.limit} is exhausted after ${usage.used} durable requests; run npm run review:state -- set-review-limit --pr ${state.prNumber} --expected-revision ${state.revision + 1} --limit <higher-number> or --unlimited before the next request.`;
  }
  return `Request canonical ${usage.used < 3 ? 'discovery' : 'verification'} review.`;
}

export function buildGitMetadataTransition(state, git) {
  const headChanged = git.headSha !== state.currentIntegrationHeadSha;
  const headSensitivePhases = new Set([
    'ready-for-review', 'awaiting-review', 'triaging', 'verifying', 'validating', 'complete',
  ]);
  let checkpointUpdate = {};
  if (headChanged) {
    const usage = reviewRequestUsage(state);
    checkpointUpdate = {
      validationStatus: emptyTargetedValidation(),
      ciValidationStatus: emptyCiValidation(),
      threadResolutionStatus: {
        ...state.threadResolutionStatus,
        status: 'not-run',
        headSha: null,
        updatedAt: null,
      },
      ...(state.scopeControl ? {
        scopeControl: {
          ...state.scopeControl,
          gate: state.scopeControl.returnDigest === null ? state.scopeControl.gate : 'resume-required',
          assessmentHeadSha: null,
          updatedAt: state.updatedAt,
        },
      } : {}),
      ...(state.phase === 'awaiting-review' ? {
        phase: 'recovering',
        nextAction: usage.exhausted
          ? `The review request became stale and explicit limit ${usage.limit} is exhausted; reconcile the new HEAD, then raise or remove the limit before requesting another review.`
          : 'The review request became stale; reconcile the new HEAD before requesting another review.',
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
      && state.nextAction
        === 'Clean the integration checkout and checkpoint Git metadata to restore review readiness.') {
    checkpointUpdate = { phase: 'ready-for-review', nextAction: reviewLimitNextAction(state) };
  }
  const next = {
    ...state,
    currentIntegrationHeadSha: git.headSha,
    git,
    ...checkpointUpdate,
  };
  return sameEvidence(state, next) ? state : validateTransition(next);
}
