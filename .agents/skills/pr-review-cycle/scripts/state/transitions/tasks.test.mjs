import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import { completeIntegratedTasks } from './tasks.mjs';

test('task completion builder preserves exact local verifier transformation', () => {
  const cwd = harness.repo();
  const state = harness.integratedTasks(cwd, ['local-one']);
  const proof = {
    status: 'passed', headSha: state.currentIntegrationHeadSha, threads: [],
    threadlessVerification: harness.emptyThreadless(), updatedAt: harness.AT,
    localVerification: harness.emptyLocalVerification(),
  };
  const input = { threadResolutionStatus: proof, verifiedLocalTaskIds: ['local-one'] };
  assert.deepEqual(
    completeIntegratedTasks(state, input),
    harness.completeIntegratedTasks(state, input),
  );
  assert.throws(
    () => completeIntegratedTasks(state, { ...input, verifiedLocalTaskIds: ['missing'] }),
    (error) => error.code === 'INVALID_TASK_COMPLETION'
      && error.message === 'Verified local task missing was not found',
  );
});

test('task transition module performs no I/O or ambient clock work', () => {
  const source = readFileSync(new URL('./tasks.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock',
    'atomicWrite', 'process.', 'new Date']) assert.equal(source.includes(forbidden), false, forbidden);
});
