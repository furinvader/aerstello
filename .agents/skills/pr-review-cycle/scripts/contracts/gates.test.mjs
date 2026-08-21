import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  completedLocalTaskIds,
  completionGate,
  completionStateGate,
  localVerificationStateGate,
  reviewReadyStateGate,
  reviewRequestGate,
  reviewRequestStateGate,
  reviewRequestUsage,
  validateExternalHeads,
} from './gates.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function completedTask(overrides = {}) {
  return {
    id: 'task', sourceType: 'github-threadless', status: 'completed', disposition: 'actionable',
    integratedCommitSha: HEAD, ...overrides,
  };
}

function readyState(overrides = {}) {
  return {
    phase: 'ready-for-review', currentIntegrationHeadSha: HEAD,
    validationStatus: { status: 'passed', source: 'orchestrator', scope: 'targeted', headSha: HEAD },
    threadResolutionStatus: { status: 'passed', headSha: HEAD, threads: [] },
    git: { headSha: HEAD, dirty: false }, verificationEscalation: null,
    tasks: [], reviewHistory: [], blockedReasons: [], ...overrides,
  };
}

function freshExternal(overrides = {}) {
  return {
    localHeadSha: HEAD, pushedHeadSha: HEAD, prHeadSha: HEAD, localDirty: false,
    prState: 'OPEN', isDraft: false, isAncestor: () => true, ...overrides,
  };
}

function completeState(overrides = {}) {
  const reviewRequest = { id: 'request', headSha: HEAD, kind: 'discovery' };
  return {
    ...readyState(), requestedHeadSha: HEAD, reviewedHeadSha: HEAD, reviewRound: 1,
    verificationReviewUsed: false, reviewRequest,
    reviewOutcome: { outcome: 'clean', headSha: HEAD, requestId: 'request', kind: 'discovery' },
    ciValidationStatus: { status: 'passed', source: 'github-actions', scope: 'full', headSha: HEAD },
    ...overrides,
  };
}

test('request accounting retains exact finite and unlimited usage values', () => {
  assert.deepEqual(reviewRequestUsage({
    legacyReviewProvenance: { discoveryRounds: 2 }, reviewHistory: [{}, {}], reviewRequestLimit: 5,
  }), { used: 4, limit: 5, remaining: 1, exhausted: false });
  assert.deepEqual(reviewRequestUsage({
    legacyReviewProvenance: { discoveryRounds: 3 }, reviewHistory: [{}, {}], reviewRequestLimit: 5,
  }), { used: 5, limit: 5, remaining: 0, exhausted: true });
  assert.deepEqual(reviewRequestUsage({ reviewHistory: [{}, {}, {}], reviewRequestLimit: 0 }), {
    used: 3, limit: null, remaining: null, exhausted: false,
  });
});

test('completed-local readiness retains exact task selection and ordered proof reasons', () => {
  const state = readyState({
    tasks: [
      completedTask({ id: 'z-local', sourceType: 'local' }),
      completedTask({ id: 'ignored-integrated', sourceType: 'local', status: 'integrated' }),
      completedTask({ id: 'a-local', sourceType: 'local' }),
      completedTask({ id: 'ignored-github' }),
    ],
    threadResolutionStatus: {
      status: 'passed', headSha: HEAD, threads: [],
      localVerification: { status: 'failed', headSha: OTHER_HEAD, taskIds: ['z-local'] },
    },
  });
  assert.deepEqual(completedLocalTaskIds(state), ['a-local', 'z-local']);
  assert.deepEqual(localVerificationStateGate(state), [
    'local verifier proof must have passed',
    'local verifier proof HEAD must equal currentIntegrationHeadSha',
    'local verifier proof must cover exactly every completed local task',
  ]);
  delete state.threadResolutionStatus.localVerification;
  assert.deepEqual(localVerificationStateGate(state), [
    'completed local tasks require persisted local verifier proof',
  ]);
});

test('review-ready state retains fresh internal HEAD and readiness reason order', () => {
  const state = readyState({
    phase: 'validating',
    validationStatus: { status: 'failed', source: 'worker', scope: 'full', headSha: OTHER_HEAD },
    threadResolutionStatus: {
      status: 'failed', headSha: OTHER_HEAD, threads: [{ isResolved: false }],
    },
    git: { headSha: OTHER_HEAD, dirty: true }, verificationEscalation: { reason: 'ambiguous' },
    tasks: [completedTask({ status: 'integrated', disposition: 'needs-human-decision' })],
    blockedReasons: ['blocked'],
  });
  assert.deepEqual(reviewReadyStateGate(state), [
    'phase must be exactly ready-for-review',
    'validation must have passed',
    'validation must be targeted orchestrator evidence',
    'validation HEAD must equal currentIntegrationHeadSha',
    'thread proof HEAD must equal currentIntegrationHeadSha',
    'recorded local Git HEAD must equal currentIntegrationHeadSha',
    'thread resolution proof must have passed',
    'all canonical threads must be resolved',
    'integration checkout must be clean',
    'verification collection escalation requires human decision',
    'all prior tasks must be completed',
    'needs-human-decision findings require a human',
    'blocked reasons must be cleared',
  ]);
});

test('request limits append after readiness and select exact request kinds', () => {
  const state = readyState({ reviewHistory: [{}, {}, {}], reviewRequestLimit: 3 });
  assert.deepEqual(reviewRequestStateGate(state), {
    kind: 'verification',
    reasons: ['explicit review request limit 3 is exhausted after 3 durable requests'],
  });
  assert.deepEqual(reviewRequestGate(state, freshExternal()), {
    allowed: false, kind: null,
    reasons: ['explicit review request limit 3 is exhausted after 3 durable requests'],
  });
  assert.deepEqual(reviewRequestGate(readyState({ reviewHistory: [{}, {}] }), freshExternal()), {
    allowed: true, kind: 'discovery', reasons: [],
  });
});

test('external-head checks retain exact reason order and actionable ancestry checks', () => {
  const state = readyState({ tasks: [completedTask({ id: 'actionable-task' })] });
  const reasons = [];
  validateExternalHeads(state, {
    localHeadSha: OTHER_HEAD, pushedHeadSha: OTHER_HEAD, prHeadSha: OTHER_HEAD,
    localDirty: true, prState: 'CLOSED', isDraft: true, isAncestor: () => false,
  }, reasons);
  assert.deepEqual(reasons, [
    'fresh local HEAD must equal currentIntegrationHeadSha',
    'fresh pushed remote HEAD must equal currentIntegrationHeadSha',
    'fresh live PR HEAD must equal currentIntegrationHeadSha',
    'fresh integration checkout must be clean',
    'live pull request must be OPEN',
    'live pull request must not be a draft',
    'task actionable-task integrated commit must be an ancestor of currentIntegrationHeadSha',
  ]);
});

test('draft promotion preflight inverts only the live draft predicate', () => {
  assert.deepEqual(reviewRequestGate(
    readyState(), freshExternal({ isDraft: true }), { promotionPreflight: true },
  ), { allowed: true, kind: 'discovery', reasons: [] });
  assert.deepEqual(reviewRequestGate(
    readyState(), freshExternal(), { promotionPreflight: true },
  ), {
    allowed: false, kind: null,
    reasons: ['promotion preflight requires a live draft pull request'],
  });
});

test('completion state retains exact authorization booleans and ordered reasons', () => {
  assert.deepEqual(completionGate(completeState(), freshExternal()), { allowed: true, reasons: [] });

  const state = completeState({
    requestedHeadSha: OTHER_HEAD, reviewedHeadSha: OTHER_HEAD, reviewRound: 0,
    reviewRequest: { id: 'request', headSha: OTHER_HEAD, kind: 'verification' },
    reviewOutcome: {
      outcome: 'findings', headSha: OTHER_HEAD, requestId: 'other-request', kind: 'discovery',
    },
    validationStatus: { status: 'failed', source: 'worker', scope: 'full', headSha: OTHER_HEAD },
    threadResolutionStatus: { status: 'failed', headSha: OTHER_HEAD, threads: [] },
    ciValidationStatus: { status: 'failed', source: 'orchestrator', scope: 'targeted', headSha: OTHER_HEAD },
    verificationEscalation: { reason: 'ambiguous' }, git: { headSha: OTHER_HEAD, dirty: true },
    tasks: [completedTask({ status: 'integrated', disposition: 'needs-human-decision' })],
    blockedReasons: ['blocked'],
  });
  assert.deepEqual(completionStateGate(state), [
    'a clean canonical review outcome is required',
    'requested HEAD must equal currentIntegrationHeadSha',
    'reviewed HEAD must equal currentIntegrationHeadSha',
    'review request HEAD must equal currentIntegrationHeadSha',
    'review outcome HEAD must equal currentIntegrationHeadSha',
    'validation HEAD must equal currentIntegrationHeadSha',
    'thread proof HEAD must equal currentIntegrationHeadSha',
    'full CI HEAD must equal currentIntegrationHeadSha',
    'recorded local Git HEAD must equal currentIntegrationHeadSha',
    'outcome must bind to the current request',
    'outcome kind must match the current request',
    'at least one discovery round is required',
    'verification clean completion requires three discovery rounds and consumed verification',
    'validation must have passed',
    'full GitHub Actions validation must have passed',
    'validation must be targeted orchestrator evidence',
    'full validation must be GitHub Actions evidence',
    'thread proof must have passed',
    'verification collection escalation requires human decision',
    'integration checkout must be clean',
    'all tasks must be completed',
    'needs-human-decision findings require a human',
    'blocked reasons must be cleared',
  ]);
  const gate = completionGate(state, freshExternal({ isDraft: true }));
  assert.equal(gate.allowed, false);
  assert.equal(gate.reasons.at(-1), 'live pull request must not be a draft');
});
