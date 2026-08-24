import {
  reviewRequestGate,
  reviewRequestUsage,
  validatePrReviewState,
} from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reviewLimitNextAction(state) {
  const usage = reviewRequestUsage(state);
  if (usage.exhausted) {
    return `Review request limit ${usage.limit} is exhausted after ${usage.used} durable requests; run npm run review:state -- set-review-limit --pr ${state.prNumber} --expected-revision ${state.revision + 1} --limit <higher-number> or --unlimited before the next request.`;
  }
  return `Request canonical ${usage.used < 3 ? 'discovery' : 'verification'} review.`;
}

function triageNextAction(state) {
  const action = 'Triage the applicable canonical review findings.';
  return reviewRequestUsage(state).exhausted ? `${action} ${reviewLimitNextAction(state)}` : action;
}

function staleDiscoveryDispositionForRequest(state, requestId = state?.reviewRequest?.id) {
  const records = Array.isArray(state?.staleDiscoveryDispositions)
    ? state.staleDiscoveryDispositions : [];
  return records.find((item) => item.requestId === requestId) ?? null;
}

function isNativeTasklessPendingReviewHeadDriftValidationRecovery(state, expectedIds) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const disposition = staleDiscoveryDispositionForRequest(state, request?.id);
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
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

function validateTransition(next, message, code) {
  const errors = validatePrReviewState(next);
  if (errors.length > 0) throw new StateError(`${message}:\n- ${errors.join('\n- ')}`, code);
  return next;
}

export function buildReviewRequestTransition(state, request, external) {
  if (state.reviewRequest?.id === request?.id) {
    if (!sameEvidence(state.reviewRequest, request)) {
      throw new StateError(
        'Review request ID was reused with different evidence',
        'REVIEW_EVIDENCE_CONFLICT',
      );
    }
    return state;
  }
  const gate = reviewRequestGate(state, external);
  if (!gate.allowed) {
    throw new StateError(
      `Review request is not allowed:\n- ${gate.reasons.join('\n- ')}`,
      'REVIEW_REQUEST_NOT_READY',
    );
  }
  if (request?.kind !== gate.kind || request?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError(
      'Review request kind and SHA must match the guarded transition',
      'INVALID_REVIEW_REQUEST',
    );
  }
  return validateTransition({
    ...state,
    phase: 'awaiting-review',
    requestedHeadSha: state.currentIntegrationHeadSha,
    reviewedHeadSha: null,
    reviewRound: gate.kind === 'discovery' ? state.reviewRound + 1 : state.reviewRound,
    verificationReviewUsed: gate.kind === 'verification' ? true : state.verificationReviewUsed,
    reviewRequest: request,
    reviewOutcome: null,
    reviewHistory: [...state.reviewHistory, { request, outcome: null }],
    nextAction: 'Collect the canonical Codex outcome for the exact requested SHA.',
  }, 'Invalid review request transition', 'INVALID_REVIEW_REQUEST');
}

export function buildReviewOutcomeTransition(state, outcome) {
  if (state.reviewOutcome?.id === outcome?.id) {
    if (!sameEvidence(state.reviewOutcome, outcome)) {
      throw new StateError(
        'Review outcome ID was reused with different evidence',
        'REVIEW_EVIDENCE_CONFLICT',
      );
    }
    return state;
  }
  const request = state.reviewRequest;
  if (state.phase !== 'awaiting-review' || !request || state.reviewOutcome !== null) {
    throw new StateError(
      'No pending canonical review request to collect',
      'REVIEW_OUTCOME_NOT_EXPECTED',
    );
  }
  if (outcome?.requestId !== request.id || outcome?.kind !== request.kind
      || outcome?.headSha !== request.headSha
      || outcome?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError(
      'Review outcome must bind to the pending request, kind, and SHA',
      'INVALID_REVIEW_OUTCOME',
    );
  }
  const phase = outcome.outcome === 'findings' ? 'triaging' : 'validating';
  const reviewHistory = state.reviewHistory.map((entry, index) => (
    index === state.reviewHistory.length - 1 ? { ...entry, outcome } : entry
  ));
  return validateTransition({
    ...state,
    phase,
    reviewedHeadSha: outcome.headSha,
    reviewOutcome: outcome,
    reviewHistory,
    nextAction: phase === 'validating'
      ? 'Confirm fresh local, pushed, and live PR heads, then complete the cycle.'
      : triageNextAction({ ...state, reviewHistory }),
  }, 'Invalid review outcome transition', 'INVALID_REVIEW_OUTCOME');
}

export function buildVerificationEscalationTransition(state, escalation) {
  if (state.verificationEscalation !== null) {
    if (!sameEvidence(state.verificationEscalation, escalation)) {
      throw new StateError(
        'Verification escalation is append-only evidence',
        'REVIEW_EVIDENCE_CONFLICT',
      );
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
  if (!(['awaiting-review', 'awaiting-human-decision'].includes(state.phase)
      || stalePendingRecovery)
      || request?.kind !== 'verification' || state.verificationReviewUsed !== true
      || state.reviewOutcome !== null || latest?.request?.id !== request.id
      || latest?.outcome !== null
      || (stalePendingRecovery && escalation?.reason === 'request-head-drift'
        && !stalePendingAmbiguity)) {
    throw new StateError(
      'No pending canonical verification collection to escalate',
      'VERIFICATION_ESCALATION_NOT_EXPECTED',
    );
  }
  if (escalation?.requestId !== request.id
      || escalation?.requestHeadSha !== request.headSha) {
    throw new StateError(
      'Verification escalation must bind to the pending request and exact SHA',
      'INVALID_VERIFICATION_ESCALATION',
    );
  }
  return validateTransition({
    ...state,
    phase: 'awaiting-human-decision',
    verificationEscalation: escalation,
    nextAction: 'Present the canonical verification collection escalation and evidence to a human.',
  }, 'Invalid verification escalation transition', 'INVALID_VERIFICATION_ESCALATION');
}
