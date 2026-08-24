import { reviewRequestUsage, validatePrReviewState } from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

function nextReviewKind(state) {
  return reviewRequestUsage(state).used < 3 ? 'discovery' : 'verification';
}

export function reviewLimitNextAction(state) {
  const usage = reviewRequestUsage(state);
  if (usage.exhausted) {
    return `Review request limit ${usage.limit} is exhausted after ${usage.used} durable requests; run npm run review:state -- set-review-limit --pr ${state.prNumber} --expected-revision ${state.revision + 1} --limit <higher-number> or --unlimited before the next request.`;
  }
  return `Request canonical ${nextReviewKind(state)} review.`;
}

export function triageNextAction(state) {
  const action = 'Triage the applicable canonical review findings.';
  return reviewRequestUsage(state).exhausted
    ? `${action} ${reviewLimitNextAction(state)}` : action;
}

export function buildReviewRequestLimitTransition(state, {
  reviewRequestLimit,
  outstandingRequestIntent = false,
} = {}) {
  if (!(reviewRequestLimit === null
      || (Number.isSafeInteger(reviewRequestLimit) && reviewRequestLimit > 0))) {
    throw new StateError(
      `Review request limit must be null or a positive safe integer up to ${Number.MAX_SAFE_INTEGER}`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
  const usage = reviewRequestUsage(state);
  if (reviewRequestLimit !== null && reviewRequestLimit < usage.used) {
    throw new StateError(
      `Review request limit ${reviewRequestLimit} is below ${usage.used} durable requests`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
  if (outstandingRequestIntent && reviewRequestLimit !== null
      && reviewRequestLimit <= usage.used) {
    throw new StateError(
      'Review request limit cannot exhaust the cycle while an exact next-request mutation intent is recoverable',
      'REVIEW_REQUEST_INTENT_PENDING',
    );
  }
  const latest = state.reviewHistory.at(-1);
  const resumesHistoricalFinding = state.phase === 'awaiting-human-decision'
    && state.verificationEscalation === null
    && state.blockedReasons.length === 0
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && state.reviewOutcome?.outcome === 'findings'
    && latest?.outcome?.id === state.reviewOutcome.id;
  const configured = { ...state, reviewRequestLimit };
  const next = {
    ...configured,
    ...(resumesHistoricalFinding ? {
      phase: 'triaging', nextAction: triageNextAction(configured),
    } : state.phase === 'triaging' ? {
      nextAction: triageNextAction(configured),
    } : state.phase === 'ready-for-review' ? {
      nextAction: reviewLimitNextAction(configured),
    } : {}),
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid review request limit transition:\n- ${errors.join('\n- ')}`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
  return next;
}
