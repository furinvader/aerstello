import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkflowContext } from './context.mjs';
import { codexReviewStatus, createStatusUseCase, staleDiscoveryNextAction } from './status.mjs';
import {
  AT, FakeClient, VIEWER, fakeGit, fakeState, pendingState,
} from '../test-support/workflow-harness.mjs';

test('status owner preserves review-head classification and stale next actions', () => {
  const head = 'a'.repeat(40);
  const state = { currentIntegrationHeadSha: head, reviewRequest: null, reviewOutcome: null };
  assert.equal(codexReviewStatus(state, head), 'not-requested');
  state.reviewRequest = { headSha: head };
  assert.equal(codexReviewStatus(state, head), 'awaiting');
  state.reviewOutcome = { headSha: head, outcome: 'clean' };
  assert.equal(codexReviewStatus(state, head), 'clean');
  assert.equal(codexReviewStatus(state, 'b'.repeat(40)), 'stale');
  assert.match(staleDiscoveryNextAction({ category: 'ambiguous-human-decision' }, 'fallback'), /human/u);
});

test('status owner executes the complete read-only shape without checkpoints or mutations', async () => {
  const client = new FakeClient();
  client.metadata.isDraft = true;
  const initial = pendingState('discovery');
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
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const result = await createStatusUseCase(context)(2);
  assert.deepEqual(Object.keys(result), [
    'prNumber', 'statePhase', 'stateHeadSha', 'liveHeadSha', 'pullRequest',
    'reviewObservation', 'canonicalThreads', 'reviewCount', 'reviewRequests',
    'requestReactionCount', 'staleDiscoveryEvidence', 'codexReview', 'taskStatus',
    'targetedValidation', 'specialistReviews', 'recordedCiValidation',
    'liveCiValidation', 'openCodexThreads', 'nextAction',
  ]);
  assert.deepEqual(result.pullRequest, { state: 'OPEN', isDraft: true });
  assert.equal(result.reviewObservation.status, 'waiting');
  assert.deepEqual(stateAdapter.calls, []);
  assert.deepEqual(client.events, []);
});
