import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { reviewRequestGate, reviewRequestUsage } from '../../contracts/contracts.mjs';
import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import { stateDirectory } from '../locations.mjs';
import { activePrNumber, loadState } from '../state-store.mjs';
import { gitAwareGateContext } from './completion.mjs';
import {
  buildReviewOutcomeTransition,
  buildReviewRequestTransition,
  buildVerificationEscalationTransition,
} from '../transitions/review.mjs';
import { buildReviewRequestLimitTransition } from '../transitions/review-policy.mjs';

function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selected;
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nextReviewKind(state) {
  return reviewRequestUsage(state).used < 3 ? 'discovery' : 'verification';
}

function hasOutstandingReviewRequestIntent(cwd, state) {
  const path = join(stateDirectory(cwd, state.prNumber), 'events.ndjson');
  if (!existsSync(path)) return false;
  let events;
  try {
    events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new StateError(
      `Unable to inspect GitHub mutation intent evidence: ${error.message}`,
      'RECOVERY_EVIDENCE_INVALID',
    );
  }
  const operationId = `request:${state.prNumber}:${nextReviewKind(state)}:`
    + `${state.reviewHistory.length + 1}:${state.currentIntegrationHeadSha}`;
  return events.some((entry) => entry.type === 'github-mutation-intent'
    && entry.details?.operationId === operationId);
}

export function assertReviewRequestAllowed(state, external) {
  const gate = reviewRequestGate(state, external);
  if (!gate.allowed) {
    throw new StateError(
      `Review request is not allowed:\n- ${gate.reasons.join('\n- ')}`,
      'REVIEW_REQUEST_NOT_READY',
    );
  }
  return gate.kind;
}

export function checkpointReviewRequestLimit({
  cwd = process.cwd(), prNumber, reviewRequestLimit, expectedRevision,
} = {}) {
  return checkpointProtectedStateTransaction({
    cwd,
    prNumber: selectedPr(cwd, prNumber),
    expectedRevision,
    requireExpectedRevision: true,
    transitionKind: 'review-request-limit',
    transaction: (current) => {
      const nextState = buildReviewRequestLimitTransition(current, {
        reviewRequestLimit,
        outstandingRequestIntent: hasOutstandingReviewRequestIntent(cwd, current),
      });
      if (Object.hasOwn(current, 'reviewRequestLimit')
          && current.reviewRequestLimit === reviewRequestLimit
          && sameEvidence(current, nextState)) {
        return { nextState: current, result: current, noWrite: true };
      }
      return {
        nextState,
        event: {
          type: 'review-request-limit',
          summary: reviewRequestLimit === null
            ? 'Removed the explicit review request limit'
            : `Set the review request limit to ${reviewRequestLimit}`,
        },
      };
    },
  });
}

export function checkpointReviewRequest({
  cwd = process.cwd(), prNumber, request, pushedHeadSha, prHeadSha, prState, isDraft,
  expectedRevision, event,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  const observed = loadState(cwd, pr);
  if (!observed) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const proposal = buildReviewRequestTransition(
    observed,
    request,
    gitAwareGateContext(observed, { pushedHeadSha, prHeadSha, prState, isDraft }),
  );
  if (proposal === observed) return observed;
  return checkpointProtectedStateTransaction({
    cwd, prNumber: pr, expectedRevision, transitionKind: 'review-request',
    transaction: (current) => ({
      nextState: buildReviewRequestTransition(
        current,
        request,
        gitAwareGateContext(current, { pushedHeadSha, prHeadSha, prState, isDraft }),
      ),
      event,
    }),
  });
}

export function checkpointReviewOutcome({
  cwd = process.cwd(), prNumber, outcome, expectedRevision, event,
} = {}) {
  return checkpointProtectedStateTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    requireExpectedRevision: true,
    transitionKind: 'review-outcome',
    transaction: (current) => {
      const nextState = buildReviewOutcomeTransition(current, outcome);
      return nextState === current
        ? { nextState: current, result: current, noWrite: true }
        : { nextState, event };
    },
  });
}

export function checkpointVerificationEscalation({
  cwd = process.cwd(), prNumber, escalation, expectedRevision, event,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  return checkpointProtectedStateTransaction({
    cwd, prNumber: pr, expectedRevision,
    requireExpectedRevision: true,
    authorizeNoWrite: false,
    transitionKind: 'verification-escalation',
    transaction: (current) => {
      const nextState = buildVerificationEscalationTransition(current, escalation);
      return nextState === current
        ? { nextState: current, result: current, noWrite: true }
        : { nextState, event };
    },
  });
}
