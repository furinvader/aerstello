import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import { buildCompletionTransition } from './completion.mjs';

test('completion builder preserves exact gate, error, and resulting state', () => {
  const cwd = harness.repo();
  const prepared = harness.ready(harness.init(cwd));
  const requested = harness.buildReviewRequestTransition(
    prepared, harness.request(prepared), harness.external(cwd, prepared),
  );
  const reviewed = harness.buildReviewOutcomeTransition(requested, harness.outcome(requested));
  const validated = harness.buildCiValidationTransition(reviewed, harness.ciEvidence(reviewed));
  const external = harness.external(cwd, validated);
  assert.deepEqual(
    buildCompletionTransition(validated, external),
    harness.buildCompletionTransition(validated, external),
  );
  assert.throws(
    () => buildCompletionTransition(reviewed, harness.external(cwd, reviewed)),
    (error) => error.code === 'REVIEW_CYCLE_INCOMPLETE'
      && error.message.startsWith('Review cycle is not complete:'),
  );
});

test('completion transition module performs no I/O or ambient clock work', () => {
  const source = readFileSync(new URL('./completion.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock',
    'atomicWrite', 'process.', 'new Date']) assert.equal(source.includes(forbidden), false, forbidden);
});
