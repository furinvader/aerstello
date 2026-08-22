import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubWorkflowError } from './errors.mjs';
import { readLiveSnapshot } from './snapshot.mjs';

const HEAD = 'a'.repeat(40);
const BOT = {
  __typename: 'Bot',
  login: 'chatgpt-codex-connector',
  id: 'BOT_codex',
  url: 'https://github.com/apps/chatgpt-codex-connector',
};

function result(data) {
  return { data: { rateLimit: { cost: 1, remaining: 10 }, ...data } };
}

function connection(nodes) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
}

function snapshotClient({ rootAuthor = BOT } = {}) {
  const calls = [];
  return {
    calls,
    async graphql(request) {
      calls.push(`${request.name}:${request.variables.commentId ?? request.variables.threadId ?? ''}`);
      switch (request.name) {
        case 'PullRequestMetadata':
          return result({
            repository: { pullRequest: {
              id: 'PR_node', number: 2, headRefOid: HEAD, state: 'OPEN', isDraft: false,
            } },
            viewer: { login: 'viewer', id: 'U_viewer' },
          });
        case 'PullRequestComments':
          return result({ repository: { pullRequest: { comments: connection([{ id: 'comment' }]) } } });
        case 'PullRequestReviews':
          return result({ repository: { pullRequest: { reviews: connection([{ id: 'review' }]) } } });
        case 'PullRequestThreads':
          return result({ repository: { pullRequest: {
            reviewThreads: connection([{ id: 'thread', isResolved: false }]),
          } } });
        case 'RequestReactions':
          return result({ node: { reactions: connection([{ id: 'reaction' }]) } });
        case 'ReviewThreadComments':
          return result({ node: { comments: connection([
            { id: 'root', replyTo: null, author: rootAuthor },
            { id: 'reply', replyTo: { id: 'root' }, author: { __typename: 'User', login: 'viewer', id: 'U_viewer' } },
          ]) } });
        default:
          return assert.fail(`Unexpected operation ${request.name}`);
      }
    },
  };
}

test('snapshot composes the bounded reader with the canonical actor classifier', async () => {
  const client = snapshotClient();
  const snapshot = await readLiveSnapshot(
    client,
    { repository: 'owner/repo', prNumber: 2 },
    { reactionsFor: 'request-comment' },
  );

  assert.deepEqual(client.calls, [
    'PullRequestMetadata:',
    'PullRequestComments:',
    'PullRequestReviews:',
    'PullRequestThreads:',
    'RequestReactions:request-comment',
    'ReviewThreadComments:thread',
  ]);
  assert.deepEqual(snapshot, {
    metadata: {
      id: 'PR_node', number: 2, headRefOid: HEAD, state: 'OPEN', isDraft: false,
      viewer: { login: 'viewer', id: 'U_viewer' },
    },
    comments: [{ id: 'comment' }],
    reviews: [{ id: 'review' }],
    threads: [{
      id: 'thread', isResolved: false,
      comments: [
        { id: 'root', replyTo: null, author: BOT },
        { id: 'reply', replyTo: { id: 'root' }, author: { __typename: 'User', login: 'viewer', id: 'U_viewer' } },
      ],
      root: { id: 'root', replyTo: null, author: BOT },
      canonical: true,
    }],
    reactions: [{ id: 'reaction' }],
  });
});

test('snapshot omits reaction reads by default and preserves noncanonical roots', async () => {
  const client = snapshotClient({
    rootAuthor: { __typename: 'Bot', login: 'other', id: 'BOT_other', url: 'https://example.test/apps/other' },
  });
  const snapshot = await readLiveSnapshot(client, { repository: 'owner/repo', prNumber: 2 });
  assert.deepEqual(snapshot.reactions, []);
  assert.equal(snapshot.threads[0].canonical, false);
  assert.equal(client.calls.some((entry) => entry.startsWith('RequestReactions:')), false);
});

test('snapshot fails closed when the canonical Bot actor lacks its node identity', async () => {
  const client = snapshotClient({ rootAuthor: { ...BOT, id: null } });
  await assert.rejects(
    readLiveSnapshot(client, { repository: 'owner/repo', prNumber: 2 }),
    (error) => {
      assert.ok(error instanceof GitHubWorkflowError);
      assert.equal(error.code, 'CANONICAL_ACTOR_INCOMPLETE');
      assert.equal(error.message, 'Canonical Bot actor has no node ID');
      return true;
    },
  );
});
