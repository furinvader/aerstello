import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  buildReviewRequestLimitTransition,
  reviewLimitNextAction,
} from './review-policy.mjs';

test('review limit projection preserves request kinds and exact exhausted guidance', () => {
  const cwd = harness.repo();
  const state = harness.ready(harness.init(cwd));
  const limited = buildReviewRequestLimitTransition(state, { reviewRequestLimit: 1 });
  assert.equal(limited.reviewRequestLimit, 1);
  assert.equal(limited.nextAction, 'Request canonical discovery review.');

  const requested = harness.buildReviewRequestTransition(
    limited, harness.request(limited), harness.external(cwd, limited),
  );
  assert.match(reviewLimitNextAction(requested), /limit 1 is exhausted after 1 durable requests/u);
  assert.throws(
    () => buildReviewRequestLimitTransition(requested, {
      reviewRequestLimit: 1, outstandingRequestIntent: true,
    }),
    (error) => error.code === 'REVIEW_REQUEST_INTENT_PENDING',
  );
});

test('raising the limit resumes a historical findings outcome for triage', () => {
  const cwd = harness.repo();
  const ready = harness.ready(harness.init(cwd));
  const requested = harness.buildReviewRequestTransition(
    ready, harness.request(ready), harness.external(cwd, ready),
  );
  const evidence = { ...harness.outcome(requested), outcome: 'findings' };
  const findings = harness.buildReviewOutcomeTransition(requested, evidence);
  const waiting = {
    ...findings,
    phase: 'awaiting-human-decision',
    blockedReasons: [],
    verificationEscalation: null,
  };
  const resumed = buildReviewRequestLimitTransition(waiting, { reviewRequestLimit: 3 });
  assert.equal(resumed.phase, 'triaging');
  assert.equal(resumed.nextAction, 'Triage the applicable canonical review findings.');
});

test('review policy projection performs no I/O or ambient work', () => {
  const source = readFileSync(new URL('./review-policy.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock', 'atomicWrite',
    'process.', 'new Date',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(reviewLimitNextAction({
    reviewRequestLimit: null, reviewHistory: [], prNumber: 1, revision: 0,
  }), /discovery/u);
});
