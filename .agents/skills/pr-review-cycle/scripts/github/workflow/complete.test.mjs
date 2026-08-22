import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCompletionUseCases } from './complete.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  AT, FakeClient, VIEWER, addThread, canonicalReview, cleanIssueComment, completedState,
  fakeGit, fakeState, issueCommentCompletedState, passedCiEvidence,
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

test('complete owner repeats live and CI proof before its ordered CI and completion checkpoints', async () => {
  const initial = completedState();
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const { complete } = createCompletionUseCases(context);
  const result = await complete(2);
  assert.equal(result.completed, true);
  assert.equal(result.phase, 'complete');
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestChecks').length, 2);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), [
    'checkpointCiValidation', 'checkpointCompletion',
  ]);
  assert.deepEqual(client.events, []);
});

test('complete owner accepts only an equivalent concurrent completion winner', async () => {
  const initial = completedState();
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const stateAdapter = fakeState(initial);
  stateAdapter.setBeforeCheckpointForTest(({ current, replaceCurrent }) => {
    replaceCurrent({ ...current, revision: current.revision + 1, phase: 'complete' });
  }, 'checkpointCompletion');
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const result = await createCompletionUseCases(context).complete(2);
  assert.equal(result.performed, false);
  assert.equal(result.idempotent, true);
  assert.equal(result.phase, 'complete');
});

test('complete owner reuses durable CI without a second CI checkpoint', async () => {
  const evidence = passedCiEvidence();
  const initial = completedState({
    ciValidationStatus: evidence,
    ciValidationHistory: [evidence],
  });
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const result = await createCompletionUseCases(context).complete(2, { checkpointCi: false });
  assert.equal(result.completed, true);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointCompletion']);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestChecks').length, 2);
});

test('complete owner revalidates already-Done state twice without writes', async () => {
  const evidence = passedCiEvidence();
  const initial = completedState({
    phase: 'complete', ciValidationStatus: evidence, ciValidationHistory: [evidence],
  });
  const client = new FakeClient();
  seedRecordedRequest(client, initial);
  client.reviews.push(canonicalReview());
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  const result = await createCompletionUseCases(context).complete(2);
  assert.equal(result.idempotent, true);
  assert.equal(result.performed, false);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestChecks').length, 2);
  assert.deepEqual(stateAdapter.calls, []);
});

test('complete owner supports structural clean evidence and rejects unresolved roots before writes', async () => {
  const structural = issueCommentCompletedState();
  const structuralClient = new FakeClient();
  seedRecordedRequest(structuralClient, structural);
  structuralClient.comments.push(cleanIssueComment());
  const structuralState = fakeState(structural);
  const structuralContext = createWorkflowContext({
    client: structuralClient, state: structuralState, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  assert.equal((await createCompletionUseCases(structuralContext).complete(2)).phase, 'complete');

  const unresolved = completedState();
  const unresolvedClient = new FakeClient();
  seedRecordedRequest(unresolvedClient, unresolved);
  unresolvedClient.reviews.push(canonicalReview());
  addThread(unresolvedClient);
  const unresolvedState = fakeState(unresolved);
  const unresolvedContext = createWorkflowContext({
    client: unresolvedClient, state: unresolvedState, git: fakeGit(), clock: { now: () => AT }, journal: {},
  });
  await assert.rejects(() => createCompletionUseCases(unresolvedContext).complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
  assert.deepEqual(unresolvedState.calls, []);
});
