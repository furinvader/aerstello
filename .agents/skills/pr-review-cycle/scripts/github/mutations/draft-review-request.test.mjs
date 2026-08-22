import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REQUEST_BODY,
  createRequestReviewUnlocked,
  exactViewerRequestCandidates,
  lookupOptionalMutationJournalIntent,
  requestAnchorObservation,
  requestRecoveryAtOrAfter,
} from './draft-review-request.mjs';
import { createWorkflowContext } from '../workflow/context.mjs';
import {
  AT, FakeClient, HEAD, VIEWER, fakeGit, fakeJournal, fakeState, priorIntent, readyState,
} from '../test-support/workflow-harness.mjs';

test('request mutation owner preserves body and represented request tolerance', () => {
  const anchor = '2026-08-22T10:00:01.000Z';
  assert.equal(REQUEST_BODY, '@codex review');
  assert.equal(requestRecoveryAtOrAfter('2026-08-22T10:00:00.000Z', anchor), true);
  assert.equal(requestRecoveryAtOrAfter('2026-08-22T09:59:59.999Z', anchor), false);
  const comment = {
    id: 'COMMENT', body: REQUEST_BODY, lastEditedAt: null,
    createdAt: '2026-08-22T10:00:00.000Z', author: VIEWER,
  };
  assert.deepEqual(
    exactViewerRequestCandidates([comment], VIEWER, { at: anchor }).map(({ id }) => id),
    ['COMMENT'],
  );
  assert.deepEqual(exactViewerRequestCandidates([comment], VIEWER, { at: anchor }, new Set(['COMMENT'])), []);
});

test('optional intent lookup deliberately rereads and validates the journal owner', async () => {
  const operationId = `ready:2:PR_NODE:${HEAD}`;
  const intent = priorIntent('ready', operationId);
  let reads = 0;
  const journal = { async lookupIntent() { reads += 1; return structuredClone(intent); } };
  assert.deepEqual(await lookupOptionalMutationJournalIntent(journal, 'ready', operationId), intent);
  assert.equal(reads, 2);
});

test('request anchors use the canonical actor observation projection', () => {
  const live = { comments: [{
    id: 'REQUEST', body: REQUEST_BODY, url: 'https://x/request', databaseId: 1,
    createdAt: AT, lastEditedAt: null, author: VIEWER,
  }] };
  assert.deepEqual(requestAnchorObservation(live, 'REQUEST').author, {
    type: VIEWER.__typename, login: VIEWER.login, id: VIEWER.id, url: VIEWER.url,
  });
});

test('request mutation preserves intent, claim, mutation, requery, and checkpoint order', async () => {
  const events = [];
  const client = new FakeClient({ events });
  const graphql = client.graphql.bind(client);
  let liveRead = 0;
  client.graphql = async (input) => {
    if (input.name === 'PullRequestMetadata') events.push(`live:${liveRead += 1}`);
    const result = await graphql(input);
    if (input.name === 'AddReviewRequest') {
      const comment = client.comments.at(-1);
      const body = comment.body;
      let candidateRead = 0;
      Object.defineProperty(comment, 'body', {
        configurable: true,
        enumerable: true,
        get() {
          events.push(`candidate:${candidateRead += 1}`);
          return body;
        },
      });
    }
    return result;
  };
  const stateAdapter = fakeState(readyState());
  const load = stateAdapter.load.bind(stateAdapter);
  stateAdapter.load = async (...args) => {
    events.push('revision:read');
    return load(...args);
  };
  const checkpointReviewRequest = stateAdapter.checkpointReviewRequest.bind(stateAdapter);
  stateAdapter.checkpointReviewRequest = async (input) => {
    events.push('checkpoint:request');
    return checkpointReviewRequest(input);
  };
  const journal = fakeJournal(events);
  const claimDispatch = journal.claimDispatch.bind(journal);
  journal.claimDispatch = async (...args) => {
    events.push('claim:request');
    return claimDispatch(...args);
  };
  const git = fakeGit({
    snapshot: async () => {
      events.push('readiness:local');
      return { headSha: HEAD, dirty: false };
    },
    pushedHead: async () => {
      events.push('readiness:pushed');
      return HEAD;
    },
  });
  const context = createWorkflowContext({
    client, state: stateAdapter, git, clock: { now: () => AT }, journal,
  });
  const result = await createRequestReviewUnlocked(context)(2);
  assert.equal(result.requested, true);
  assert.equal(result.recovered, false);
  assert.deepEqual(events, [
    'revision:read',
    'live:1',
    'readiness:local',
    'readiness:pushed',
    'live:2',
    'readiness:local',
    'readiness:pushed',
    'revision:read',
    'intent:request',
    'live:3',
    'readiness:local',
    'readiness:pushed',
    'revision:read',
    'claim:request',
    'mutation:AddReviewRequest',
    'live:4',
    'candidate:1',
    'live:5',
    'readiness:local',
    'readiness:pushed',
    'revision:read',
    'candidate:2',
    'checkpoint:request',
  ]);
  assert.equal(client.calls.filter(({ name }) => name === 'AddReviewRequest').length, 1);
  assert.ok(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length >= 5);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointReviewRequest']);
  assert.equal(stateAdapter.current.reviewHistory.length, 1);
});

test('a previously claimed request dispatch remains observational and never replays', async () => {
  const client = new FakeClient();
  const active = readyState();
  const operationId = `request:2:discovery:1:${HEAD}`;
  const journal = fakeJournal(client.events, [priorIntent('request', operationId)]);
  journal.claimDispatch = async () => ({ isNew: false });
  const stateAdapter = fakeState(active);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => AT }, journal,
  });
  const result = await createRequestReviewUnlocked(context)(2);
  assert.equal(result.waiting, true);
  assert.equal(result.requested, false);
  assert.equal(client.calls.some(({ name }) => name === 'AddReviewRequest'), false);
  assert.deepEqual(stateAdapter.calls, []);
});
