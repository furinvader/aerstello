import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollectUseCase, sameRequestBoundOutcome } from './collect.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  AT, BOT, FakeClient, VIEWER, fakeGit, fakeJournal, fakeState, pendingState,
} from '../test-support/workflow-harness.mjs';

test('collect owner returns an exact already-recorded request-bound outcome without writes', async () => {
  const request = { id: 'REQUEST' };
  const outcome = { requestId: request.id, outcome: 'clean' };
  const state = {
    phase: 'ready-for-review', reviewRequest: request, reviewOutcome: outcome,
    reviewHistory: [{ request, outcome }],
  };
  assert.equal(sameRequestBoundOutcome(state, outcome), true);
  const collect = createCollectUseCase({ load: async () => structuredClone(state) });
  assert.deepEqual(await collect(42, { expectedOutcome: outcome }), {
    escalated: false, outcome, phase: state.phase, performed: false,
  });
});

function collectFixture() {
  const client = new FakeClient();
  const initial = pendingState('verification');
  client.comments.push({
    id: initial.reviewRequest.id,
    databaseId: initial.reviewRequest.databaseId,
    url: initial.reviewRequest.url,
    body: initial.reviewRequest.body,
    createdAt: initial.reviewRequest.at,
    lastEditedAt: null,
    author: {
      ...VIEWER,
      login: initial.reviewRequest.authorLogin,
      id: initial.reviewRequest.authorNodeId,
    },
  });
  client.reactions.set(initial.reviewRequest.id, [{
    id: 'REACTION_clean', content: 'THUMBS_UP', createdAt: AT, user: BOT,
  }]);
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal(client.events),
  });
  return { client, stateAdapter, collect: createCollectUseCase(context) };
}

test('collect owner repeats response observation before its one outcome checkpoint', async () => {
  const { client, stateAdapter, collect } = collectFixture();
  const result = await collect(2);
  assert.equal(result.outcome.evidenceType, 'request-reaction');
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointReviewOutcome']);
  assert.deepEqual(client.events, []);
});

test('collect owner reconciles an equivalent concurrent checkpoint without a second write', async () => {
  const { stateAdapter, collect } = collectFixture();
  stateAdapter.setBeforeCheckpointForTest(({ input, current, replaceCurrent }) => {
    replaceCurrent({
      ...current,
      revision: current.revision + 1,
      reviewedHeadSha: input.outcome.headSha,
      reviewOutcome: input.outcome,
      reviewHistory: current.reviewHistory.map((entry, index) => (
        index === current.reviewHistory.length - 1 ? { ...entry, outcome: input.outcome } : entry
      )),
      phase: 'validating',
    });
  }, 'checkpointReviewOutcome');
  const result = await collect(2);
  assert.equal(result.performed, false);
  assert.equal(result.outcome.outcome, 'clean');
  assert.deepEqual(stateAdapter.calls, []);
});
