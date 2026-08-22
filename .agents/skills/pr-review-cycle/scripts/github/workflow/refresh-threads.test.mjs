import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRefreshThreadsUseCase,
  samePendingResponseObservation,
  tasklessPendingReviewHeadDriftRefreshAllowed,
} from './refresh-threads.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  AT, FakeClient, HEAD, VIEWER, addThread, fakeGit, fakeState, proof,
  rootComment, stateFixture, tasklessPendingReviewHeadDriftState,
} from '../test-support/workflow-harness.mjs';

test('refresh owner preserves guarded pending-head drift and exact observations', () => {
  const state = tasklessPendingReviewHeadDriftState();
  assert.equal(tasklessPendingReviewHeadDriftRefreshAllowed(state), true);
  const observation = { status: 'none', evidenceIds: [], rootState: [] };
  assert.equal(samePendingResponseObservation(observation, structuredClone(observation)), true);
  assert.equal(samePendingResponseObservation(observation, { ...observation, status: 'stale' }), false);
});

test('refresh owner repeats live observation before its one empty-proof checkpoint', async () => {
  const initial = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, {
    id: 'THREAD_noncanonical_1', root: rootComment('THREAD_noncanonical_1', { author: VIEWER }),
  });
  addThread(client, {
    id: 'THREAD_noncanonical_2', root: rootComment('THREAD_noncanonical_2', { author: VIEWER }),
  });
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const result = await createRefreshThreadsUseCase(context)(2);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, proof('not-run').threadlessVerification);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestThreads').length, 4);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointTaskCompletion']);
  assert.deepEqual(client.events, []);
});
