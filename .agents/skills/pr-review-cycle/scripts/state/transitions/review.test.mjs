import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  buildReviewOutcomeTransition,
  buildReviewRequestTransition,
} from './review.mjs';

function assertPureModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock',
    'atomicWrite', 'process.', 'new Date']) assert.equal(source.includes(forbidden), false, forbidden);
}

test('review builders preserve request, outcome, errors, and idempotency', () => {
  const cwd = harness.repo();
  const state = harness.ready(harness.init(cwd));
  const evidence = harness.request(state);
  const external = harness.external(cwd, state);
  const expectedRequest = harness.buildReviewRequestTransition(state, evidence, external);
  const actualRequest = buildReviewRequestTransition(state, evidence, external);
  assert.deepEqual(actualRequest, expectedRequest);
  assert.equal(buildReviewRequestTransition(actualRequest, evidence, external), actualRequest);

  const result = harness.outcome(actualRequest);
  const expectedOutcome = harness.buildReviewOutcomeTransition(expectedRequest, result);
  const actualOutcome = buildReviewOutcomeTransition(actualRequest, result);
  assert.deepEqual(actualOutcome, expectedOutcome);
  assert.equal(buildReviewOutcomeTransition(actualOutcome, result), actualOutcome);

  assert.throws(
    () => buildReviewOutcomeTransition(state, result),
    (error) => error.code === 'REVIEW_OUTCOME_NOT_EXPECTED'
      && error.message === 'No pending canonical review request to collect',
  );
});

test('review transition module performs no I/O or ambient clock work', () => {
  assertPureModule('./review.mjs');
});
