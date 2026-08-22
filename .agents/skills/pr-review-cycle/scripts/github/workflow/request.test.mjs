import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRequestUseCase } from './request.mjs';
import { createRequestReviewUnlocked } from '../mutations/draft-review-request.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  AT, FakeClient, fakeGit, fakeJournal, fakeState, readyState,
} from '../test-support/workflow-harness.mjs';

test('request owner lock invokes the unlocked request exactly once', async () => {
  let entered = 0;
  let unlocked = 0;
  const request = createRequestUseCase({
    journal: { async withRequestOwner(callback) { entered += 1; return callback(); } },
  }, async (prNumber, kind) => { unlocked += 1; return { prNumber, kind }; });
  assert.deepEqual(await request(42, 'verification'), { prNumber: 42, kind: 'verification' });
  assert.equal(entered, 1);
  assert.equal(unlocked, 1);
});

test('request owner timeout before entry is an observational wait with no writes', async () => {
  const client = new FakeClient();
  const stateAdapter = fakeState(readyState());
  const journal = fakeJournal(client.events);
  journal.withRequestOwner = async () => {
    throw Object.assign(new Error('busy'), { code: 'STATE_LOCK_TIMEOUT' });
  };
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal,
  });
  const request = createRequestUseCase(context, createRequestReviewUnlocked(context));
  assert.deepEqual(await request(2), {
    requested: false, recovered: false, waiting: true,
    pullRequestReadiness: 'already-ready',
    nextAction: 'Wait, then rerun npm run review:github -- request --pr 2.',
  });
  assert.equal(client.calls.some(({ name }) => name === 'AddReviewRequest'), false);
  assert.deepEqual(stateAdapter.calls, []);
});

test('request owner never treats an entered lock timeout as a waiting observer', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'STATE_LOCK_TIMEOUT' });
  const request = createRequestUseCase({
    journal: { async withRequestOwner(callback) { return callback(); } },
  }, async () => { throw timeout; });
  await assert.rejects(() => request(42), (error) => error === timeout);
});
