import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildStaleDiscoveryDisposition,
  staleDiscoveryDispositionId,
  validateReviewHistory,
  validateReviewOutcome,
  validateReviewRequest,
  validateStaleDiscoveryDispositions,
  validateVerificationEscalation,
} from './review-evidence.mjs';

const AT = '2026-08-05T00:00:00Z';
const REQUEST_HEAD = 'a'.repeat(40);
const LIVE_HEAD = 'b'.repeat(40);

function request(overrides = {}) {
  return {
    id: 'request-1', databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-101',
    headSha: REQUEST_HEAD, at: AT, kind: 'discovery', body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
    ...overrides,
  };
}

function outcome(overrides = {}) {
  return {
    id: 'review-1', databaseId: 102,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-102',
    headSha: REQUEST_HEAD, at: AT, requestId: 'request-1', kind: 'discovery', outcome: 'clean',
    evidenceType: 'review-submission', reviewerLogin: 'chatgpt-codex-connector',
    reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
    reactionContent: null, reactionCommentId: null,
    ...overrides,
  };
}

function errorsFrom(validate, ...args) {
  const errors = [];
  validate(...args, errors);
  return errors;
}

test('direct review request and outcome contracts retain closed shapes, bounds, and error order', () => {
  const reviewRequest = request();
  const reviewOutcome = outcome();
  assert.deepEqual(errorsFrom(validateReviewRequest, reviewRequest, '$.request'), []);
  assert.deepEqual(errorsFrom(validateReviewOutcome, reviewOutcome, '$.outcome'), []);
  assert.deepEqual(reviewRequest, request());
  assert.deepEqual(reviewOutcome, outcome());

  const invalidRequest = { ...reviewRequest, id: '', databaseId: 0, url: 'http://example.test', extra: true };
  assert.deepEqual(errorsFrom(validateReviewRequest, invalidRequest, '$.request'), [
    '$.request.extra is not supported',
    '$.request.id is invalid',
    '$.request.databaseId is invalid',
    '$.request.url must be an HTTPS URL',
  ]);
  const invalidOutcome = {
    ...reviewOutcome, evidenceType: 'request-reaction', outcome: 'findings',
    reactionContent: null, reactionCommentId: 'other',
  };
  assert.deepEqual(errorsFrom(validateReviewOutcome, invalidOutcome, '$.outcome'), [
    '$.outcome request-reaction evidence may only prove a clean outcome',
    '$.outcome.reactionContent must be THUMBS_UP',
    '$.outcome.reactionCommentId must equal requestId',
  ]);
});

test('direct review history and verification escalation preserve ordinal and exact-request bindings', () => {
  const history = Array.from({ length: 4 }, (_, index) => {
    const kind = index < 3 ? 'discovery' : 'verification';
    const id = `request-${index + 1}`;
    const historyRequest = request({ id, databaseId: 101 + index, kind });
    return {
      request: historyRequest,
      outcome: outcome({ id: `review-${index + 1}`, databaseId: 201 + index, requestId: id, kind }),
    };
  });
  assert.deepEqual(errorsFrom(validateReviewHistory, history, 0), []);
  const wrongOrdinal = structuredClone(history);
  wrongOrdinal[3].request.kind = 'discovery';
  wrongOrdinal[3].outcome.kind = 'discovery';
  assert.deepEqual(errorsFrom(validateReviewHistory, wrongOrdinal, 0), [
    '$.reviewHistory exceeds three discovery requests',
    '$.reviewHistory[3].request.kind must be verification at this durable request ordinal',
  ]);

  const verificationRequest = request({ kind: 'verification' });
  const escalation = {
    requestId: verificationRequest.id, requestHeadSha: REQUEST_HEAD, observedPrHeadSha: LIVE_HEAD,
    headRelation: 'changed', evidenceIds: ['review:PRR_1'], reason: 'request-head-drift', at: AT,
  };
  assert.deepEqual(errorsFrom(validateVerificationEscalation, escalation, verificationRequest), []);
  const contradictory = { ...escalation, reason: 'stale-canonical-evidence' };
  assert.deepEqual(errorsFrom(validateVerificationEscalation, contradictory, verificationRequest), [
    '$.verificationEscalation.headRelation must be same for stale-canonical-evidence',
  ]);
});

test('stale discovery identity retains golden canonical bytes and mutation sensitivity', () => {
  const reviewRequest = request();
  const evidence = outcome();
  const disposition = buildStaleDiscoveryDisposition({
    request: reviewRequest,
    liveHeadSha: LIVE_HEAD,
    evidence,
    responseFingerprint: 'd'.repeat(64),
    disposedAt: AT,
  });
  assert.equal(
    disposition.dispositionId,
    '22d8075a0c555be672f9a9cc5174f9d1e29a0a147d663255baee2ba818b770ff',
  );
  assert.equal(staleDiscoveryDispositionId(disposition), disposition.dispositionId);
  assert.equal(
    staleDiscoveryDispositionId(Object.fromEntries(Object.entries(disposition).reverse())),
    disposition.dispositionId,
  );
  assert.notEqual(staleDiscoveryDispositionId({ ...disposition, liveHeadSha: 'c'.repeat(40) }), disposition.dispositionId);
  assert.notEqual(staleDiscoveryDispositionId({
    ...disposition, evidence: { ...disposition.evidence, id: 'review-mutated' },
  }), disposition.dispositionId);

  const state = {
    legacyReviewProvenance: null,
    reviewHistory: [{ request: reviewRequest, outcome: null }],
  };
  assert.deepEqual(errorsFrom(validateStaleDiscoveryDispositions, [disposition], state), []);
  const tampered = structuredClone(disposition);
  tampered.evidence.id = 'review-mutated';
  assert.deepEqual(errorsFrom(validateStaleDiscoveryDispositions, [tampered], state), [
    '$.staleDiscoveryDispositions[0].dispositionId does not match its immutable evidence',
  ]);
});
