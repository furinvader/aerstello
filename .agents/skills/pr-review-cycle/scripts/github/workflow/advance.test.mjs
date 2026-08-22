import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAdvanceUseCase } from './advance.mjs';
import { createCollectUseCase } from './collect.mjs';
import { createCollectCiUseCase } from './collect-ci.mjs';
import { createCompletionUseCases } from './complete.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  AT, BOT, FakeClient, OTHER_HEAD, VIEWER, canonicalReview, completedState, fakeGit,
  fakeJournal, fakeState, findingsState, fullValidationCheck, passedCiEvidence,
  pendingState, stateFixture,
} from '../test-support/workflow-harness.mjs';

function seedRecordedRequest(client, state) {
  client.comments.push({
    id: state.reviewRequest.id,
    databaseId: state.reviewRequest.databaseId,
    url: state.reviewRequest.url,
    body: state.reviewRequest.body,
    createdAt: state.reviewRequest.at,
    lastEditedAt: null,
    author: { ...VIEWER, login: state.reviewRequest.authorLogin, id: state.reviewRequest.authorNodeId },
  });
}

function directAdvance(initial, client = new FakeClient()) {
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client,
    state: stateAdapter,
    git: fakeGit(),
    clock: { now: () => AT },
    journal: fakeJournal(client.events),
    archiveStore: { async list() { throw new Error('advance must not read archives'); } },
  });
  const completion = createCompletionUseCases(context);
  const operations = {
    ...completion,
    collect: createCollectUseCase(context),
    collectCi: createCollectCiUseCase(context),
  };
  return { client, stateAdapter, advance: createAdvanceUseCase(context, operations) };
}

test('advance owner returns waiting without request or archive side effects', async () => {
  const setup = directAdvance(stateFixture());
  const result = await setup.advance(2);
  assert.equal(result.terminal, 'waiting');
  assert.equal(result.waiting, true);
  assert.deepEqual(result.performedTransitions, []);
  assert.deepEqual(setup.stateAdapter.calls, []);
  assert.deepEqual(setup.client.events, []);
});

test('advance owner revalidates Done twice without claiming any transition', async () => {
  const initial = completedState({
    phase: 'complete',
    ciValidationStatus: passedCiEvidence(),
    ciValidationHistory: [passedCiEvidence()],
  });
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const setup = directAdvance(initial, client);
  const result = await setup.advance(2);
  assert.equal(result.terminal, 'done');
  assert.deepEqual(result.performedTransitions, []);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestChecks').length, 2);
  assert.deepEqual(setup.stateAdapter.calls, []);
});

test('advance owner performs collect, authoritative CI, and completion only', async () => {
  const initial = pendingState('discovery');
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const setup = directAdvance(initial, client);
  const result = await setup.advance(2);
  assert.equal(result.terminal, 'done');
  assert.deepEqual(result.performedTransitions, [
    'review-outcome', 'ci-validation', 'cycle-completion',
  ]);
  assert.deepEqual(setup.stateAdapter.calls.map(({ name }) => name), [
    'checkpointReviewOutcome', 'checkpointCiValidation', 'checkpointCompletion',
  ]);
  assert.deepEqual(client.events, []);
});

test('advance owner waits on transient CI and records failed authoritative CI exactly once', async () => {
  const pendingInitial = pendingState('discovery');
  const pendingClient = new FakeClient({
    rollupState: 'PENDING',
    ciContexts: [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })],
  });
  seedRecordedRequest(pendingClient, pendingInitial);
  pendingClient.reviews.push(canonicalReview());
  const pending = directAdvance(pendingInitial, pendingClient);
  const pendingResult = await pending.advance(2);
  assert.equal(pendingResult.terminal, 'waiting');
  assert.deepEqual(pendingResult.performedTransitions, ['review-outcome']);
  assert.deepEqual(pending.stateAdapter.calls.map(({ name }) => name), ['checkpointReviewOutcome']);

  const failedInitial = pendingState('discovery');
  const failedClient = new FakeClient({
    rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ conclusion: 'FAILURE' })],
  });
  seedRecordedRequest(failedClient, failedInitial);
  failedClient.reviews.push(canonicalReview());
  const failed = directAdvance(failedInitial, failedClient);
  const failedResult = await failed.advance(2);
  assert.equal(failedResult.terminal, 'failure');
  assert.equal(failedResult.ciValidation.status, 'failed');
  assert.deepEqual(failedResult.performedTransitions, ['review-outcome', 'ci-validation']);
  assert.deepEqual(failed.stateAdapter.calls.map(({ name }) => name), [
    'checkpointReviewOutcome', 'checkpointCiValidation',
  ]);
});

test('advance owner escalates verification ambiguity without requesting or archiving', async () => {
  const initial = pendingState('verification');
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  client.reactions.set(initial.reviewRequest.id, [{
    id: 'REACTION_ambiguous', content: 'THUMBS_UP', createdAt: AT, user: BOT,
  }]);
  const setup = directAdvance(initial, client);
  const result = await setup.advance(2);
  assert.equal(result.terminal, 'escalation');
  assert.deepEqual(result.performedTransitions, ['verification-escalation']);
  assert.deepEqual(setup.stateAdapter.calls.map(({ name }) => name), [
    'checkpointVerificationEscalation',
  ]);
  assert.deepEqual(client.events, []);
});

test('advance owner double-observes exact findings and waits on stale live HEAD', async () => {
  const initial = findingsState();
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const setup = directAdvance(initial, client);
  const result = await setup.advance(2);
  assert.equal(result.terminal, 'triage');
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.equal(client.calls.some(({ name }) => name === 'PullRequestChecks'), false);
  assert.deepEqual(setup.stateAdapter.calls, []);

  const staleInitial = findingsState();
  const staleClient = new FakeClient({ metadata: { headRefOid: OTHER_HEAD } });
  seedRecordedRequest(staleClient, staleInitial);
  staleClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const stale = directAdvance(staleInitial, staleClient);
  const waiting = await stale.advance(2);
  assert.equal(waiting.terminal, 'waiting');
  assert.match(waiting.nextAction, /stale at the live PR head/u);
  assert.deepEqual(stale.stateAdapter.calls, []);
});
