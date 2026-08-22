import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import { MAX_NODES, MAX_PAGES } from './client.mjs';
import {
  readLiveSnapshot,
  readPullRequestChecks,
  readPullRequestMetadata,
  readRequestReactions,
  readReviewThreads,
  readReviews,
  readThreadComments,
  readTopLevelComments,
} from './pull-request-reader.mjs';

const HEAD = 'a'.repeat(40);

function expectWorkflowError(error, code, message) {
  assert.ok(error instanceof GitHubWorkflowError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  return true;
}

function result(data) {
  return { data: { rateLimit: { cost: 1, remaining: 10 }, ...data } };
}

function connection(nodes, hasNextPage = false, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function checkResult({
  nodes = [], hasNextPage = false, endCursor = null, rollupState = 'SUCCESS',
  statusCheckRollup, pr = {}, commitOid = HEAD,
} = {}) {
  const rollup = statusCheckRollup === undefined
    ? { state: rollupState, contexts: connection(nodes, hasNextPage, endCursor) }
    : statusCheckRollup;
  return result({
    repository: {
      pullRequest: {
        id: 'PR_node',
        number: 41,
        state: 'OPEN',
        isDraft: false,
        headRefOid: HEAD,
        commits: { nodes: [{ commit: { oid: commitOid, statusCheckRollup: rollup } }] },
        ...pr,
      },
    },
  });
}

test('readPullRequestMetadata preserves request variables and result shape', async () => {
  const calls = [];
  const pullRequest = {
    id: 'PR_node', number: 41, url: 'https://example.test/pr/41',
    headRefOid: HEAD, state: 'OPEN', isDraft: false,
  };
  const viewer = { login: 'viewer', id: 'U_viewer' };
  const client = {
    async graphql(request) {
      calls.push(request);
      return result({ repository: { pullRequest }, viewer });
    },
  };

  assert.deepEqual(await readPullRequestMetadata(client, 'owner/repo', 41), { ...pullRequest, viewer });
  assert.equal(calls[0].name, 'PullRequestMetadata');
  assert.deepEqual(calls[0].variables, { owner: 'owner', repo: 'repo', pr: 41 });
});

test('readPullRequestMetadata fails closed for invalid repository and incomplete metadata', async () => {
  const unusedClient = { graphql: async () => assert.fail('GraphQL must not be called') };
  for (const repository of [null, '', 'owner', 'owner/repo/extra']) {
    await assert.rejects(
      readPullRequestMetadata(unusedClient, repository, 41),
      (error) => expectWorkflowError(error, 'INVALID_REPOSITORY', 'State repository must be owner/name'),
    );
  }

  const valid = {
    repository: {
      pullRequest: { id: 'PR', number: 41, headRefOid: HEAD, state: 'OPEN', isDraft: false },
    },
    viewer: { login: 'viewer', id: 'U' },
  };
  const malformed = [
    {},
    { ...valid, repository: { pullRequest: { ...valid.repository.pullRequest, number: 42 } } },
    { ...valid, repository: { pullRequest: { ...valid.repository.pullRequest, state: 'UNKNOWN' } } },
    { ...valid, viewer: { login: 'viewer' } },
  ];
  for (const data of malformed) {
    const client = { graphql: async () => result(data) };
    await assert.rejects(
      readPullRequestMetadata(client, 'owner/repo', 41),
      (error) => expectWorkflowError(
        error,
        'GRAPHQL_TRUNCATED',
        'Pull request metadata is incomplete',
      ),
    );
  }
});

test('connection readers preserve operation names, variables, pagination, and node order', async () => {
  const cases = [
    [readTopLevelComments, 'PullRequestComments', 'comments', ['owner/repo', 41]],
    [readReviews, 'PullRequestReviews', 'reviews', ['owner/repo', 41]],
    [readReviewThreads, 'PullRequestThreads', 'reviewThreads', ['owner/repo', 41]],
    [readThreadComments, 'ReviewThreadComments', 'comments', ['thread-1']],
    [readRequestReactions, 'RequestReactions', 'reactions', ['comment-1']],
  ];
  for (const [reader, name, field, args] of cases) {
    const calls = [];
    const client = {
      async graphql(request) {
        calls.push(request);
        const page = calls.length === 1
          ? connection([{ id: `${name}-1` }], true, 'next')
          : connection([{ id: `${name}-2` }]);
        return result(name.startsWith('PullRequest')
          ? { repository: { pullRequest: { [field]: page } } }
          : { node: { [field]: page } });
      },
    };

    assert.deepEqual(await reader(client, ...args), [{ id: `${name}-1` }, { id: `${name}-2` }]);
    assert.deepEqual(calls.map((call) => call.name), [name, name]);
    const baseVariables = name.startsWith('PullRequest')
      ? { owner: 'owner', repo: 'repo', pr: 41 }
      : name === 'ReviewThreadComments' ? { threadId: 'thread-1' } : { commentId: 'comment-1' };
    assert.deepEqual(calls.map((call) => call.variables), [
      { ...baseVariables, cursor: null },
      { ...baseVariables, cursor: 'next' },
    ]);
  }
});

test('pull-request connection readers distinguish missing PRs from truncated connections', async () => {
  const missingPr = { graphql: async () => result({ repository: { pullRequest: null } }) };
  await assert.rejects(
    readTopLevelComments(missingPr, 'owner/repo', 41),
    (error) => expectWorkflowError(error, 'PR_NOT_FOUND', 'Pull request was not found'),
  );

  const missingConnection = {
    graphql: async () => result({ repository: { pullRequest: { comments: null } } }),
  };
  await assert.rejects(
    readTopLevelComments(missingConnection, 'owner/repo', 41),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_TRUNCATED',
      'PullRequestComments returned a truncated connection',
    ),
  );
});

test('readPullRequestChecks aggregates stable rollup pages in order', async () => {
  const calls = [];
  const first = { __typename: 'CheckRun', name: 'Full validation', status: 'COMPLETED' };
  const second = { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' };
  const client = {
    async graphql(request) {
      calls.push(request);
      return calls.length === 1
        ? checkResult({ nodes: [first], hasNextPage: true, endCursor: 'next' })
        : checkResult({ nodes: [second] });
    },
  };

  assert.deepEqual(await readPullRequestChecks(client, 'owner/repo', 41, HEAD), {
    headSha: HEAD,
    rollupState: 'SUCCESS',
    contexts: [first, second],
  });
  assert.deepEqual(calls.map((call) => call.variables), [
    { owner: 'owner', repo: 'repo', pr: 41, cursor: null },
    { owner: 'owner', repo: 'repo', pr: 41, cursor: 'next' },
  ]);
});

test('readPullRequestChecks returns the exact empty shape for a null rollup', async () => {
  const client = { graphql: async () => checkResult({ statusCheckRollup: null }) };
  assert.deepEqual(await readPullRequestChecks(client, 'owner/repo', 41, HEAD), {
    headSha: HEAD,
    rollupState: null,
    contexts: [],
  });
});

test('readPullRequestChecks preserves metadata, readiness, and head error ordering', async () => {
  const cases = [
    [
      checkResult({ pr: { id: null, state: 'CLOSED', isDraft: true, headRefOid: 'wrong' } }),
      {}, 'GRAPHQL_TRUNCATED', 'Check rollup pull request metadata was truncated',
    ],
    [
      checkResult({ pr: { state: 'CLOSED', isDraft: true, headRefOid: 'wrong' } }),
      {}, 'PR_NOT_OPEN', 'Pull request is closed or merged',
    ],
    [
      checkResult({ pr: { isDraft: true, headRefOid: 'wrong' } }),
      {}, 'PR_DRAFT', 'Pull request is still a draft',
    ],
    [
      checkResult({ pr: { headRefOid: 'wrong' } }),
      {}, 'CI_HEAD_MISMATCH', 'Check rollup does not apply to the expected PR HEAD',
    ],
    [
      checkResult({ commitOid: 'wrong' }),
      {}, 'CI_HEAD_MISMATCH', 'Check rollup does not apply to the expected PR HEAD',
    ],
  ];
  for (const [response, options, code, message] of cases) {
    const client = { graphql: async () => response };
    await assert.rejects(
      readPullRequestChecks(client, 'owner/repo', 41, HEAD, options),
      (error) => expectWorkflowError(error, code, message),
    );
  }

  const draftClient = { graphql: async () => checkResult({ pr: { isDraft: true } }) };
  assert.deepEqual(
    await readPullRequestChecks(draftClient, 'owner/repo', 41, HEAD, { requireReady: false }),
    { headSha: HEAD, rollupState: 'SUCCESS', contexts: [] },
  );
});

test('readPullRequestChecks fails closed for truncated rollups and contexts', async () => {
  const missingRollup = checkResult();
  delete missingRollup.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup;
  const malformed = [
    [missingRollup, 'Commit status check rollup was truncated'],
    [checkResult({ statusCheckRollup: {} }), 'Commit status check rollup is missing or truncated'],
    [checkResult({ nodes: [{ __typename: 'CheckRun', name: 'check' }] }), 'Commit status context was truncated'],
    [checkResult({ nodes: [{ __typename: 'Unknown' }] }), 'Commit status context was truncated'],
  ];
  for (const [response, message] of malformed) {
    const client = { graphql: async () => response };
    await assert.rejects(
      readPullRequestChecks(client, 'owner/repo', 41, HEAD),
      (error) => expectWorkflowError(error, 'GRAPHQL_TRUNCATED', message),
    );
  }
});

test('readPullRequestChecks rejects rollup-state and cursor races', async () => {
  for (const race of ['state', 'cursor']) {
    let calls = 0;
    const client = {
      async graphql() {
        calls += 1;
        if (race === 'state') {
          return calls === 1
            ? checkResult({ hasNextPage: true, endCursor: 'next', rollupState: 'PENDING' })
            : checkResult({ rollupState: 'SUCCESS' });
        }
        return calls === 1
          ? checkResult({ hasNextPage: true, endCursor: 'same' })
          : checkResult({ hasNextPage: true, endCursor: 'same' });
      },
    };
    const expected = race === 'state'
      ? ['CI_EVIDENCE_AMBIGUOUS', 'Commit status check rollup changed during pagination']
      : ['GRAPHQL_TRUNCATED', 'PullRequestChecks pagination cursor is missing or repeated'];
    await assert.rejects(
      readPullRequestChecks(client, 'owner/repo', 41, HEAD),
      (error) => expectWorkflowError(error, ...expected),
    );
  }
});

test('readPullRequestChecks enforces exact node and page bounds', async () => {
  const nodeClient = {
    graphql: async () => checkResult({
      nodes: Array.from({ length: MAX_NODES + 1 }, () => ({
        __typename: 'StatusContext', context: 'check', state: 'SUCCESS',
      })),
    }),
  };
  await assert.rejects(
    readPullRequestChecks(nodeClient, 'owner/repo', 41, HEAD),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_TRUNCATED',
      'PullRequestChecks exceeded the node limit',
    ),
  );

  let calls = 0;
  const pageClient = {
    graphql: async () => checkResult({ hasNextPage: true, endCursor: `cursor-${calls += 1}` }),
  };
  await assert.rejects(
    readPullRequestChecks(pageClient, 'owner/repo', 41, HEAD),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_TRUNCATED',
      'PullRequestChecks exceeded the page limit',
    ),
  );
  assert.equal(calls, MAX_PAGES);
});

function snapshotClient(rawThreads, threadComments, events = []) {
  const metadata = {
    id: 'PR', number: 41, url: 'https://example.test/pr/41', headRefOid: HEAD,
    state: 'OPEN', isDraft: false,
  };
  return {
    async graphql(request) {
      events.push(`${request.name}:${request.variables.threadId ?? request.variables.commentId ?? ''}`);
      switch (request.name) {
        case 'PullRequestMetadata':
          return result({ repository: { pullRequest: metadata }, viewer: { login: 'viewer', id: 'U' } });
        case 'PullRequestComments':
          return result({ repository: { pullRequest: { comments: connection([{ id: 'comment' }]) } } });
        case 'PullRequestReviews':
          return result({ repository: { pullRequest: { reviews: connection([{ id: 'review' }]) } } });
        case 'PullRequestThreads':
          return result({ repository: { pullRequest: { reviewThreads: connection(rawThreads) } } });
        case 'RequestReactions':
          return result({ node: { reactions: connection([{ id: 'reaction' }]) } });
        case 'ReviewThreadComments':
          return result({ node: { comments: connection(threadComments[request.variables.threadId]) } });
        default:
          return assert.fail(`Unexpected operation ${request.name}`);
      }
    },
  };
}

test('readLiveSnapshot preserves metadata-first, concurrent connection, and sequential thread topology', async () => {
  const events = [];
  const rawThreads = [{ id: 'thread-2', isResolved: false }, { id: 'thread-1', isResolved: true }];
  const roots = {
    'thread-2': [{ id: 'root-2', replyTo: null, author: { login: 'codex' } }],
    'thread-1': [{ id: 'root-1', replyTo: null, author: { login: 'other' } }],
  };
  const actors = [];
  const snapshot = await readLiveSnapshot(
    snapshotClient(rawThreads, roots, events),
    { repository: 'owner/repo', prNumber: 41 },
    {
      reactionsFor: 'request-comment',
      isCanonicalActor(actor) {
        actors.push(actor);
        return actor.login === 'codex';
      },
    },
  );

  assert.deepEqual(events, [
    'PullRequestMetadata:',
    'PullRequestComments:',
    'PullRequestReviews:',
    'PullRequestThreads:',
    'RequestReactions:request-comment',
    'ReviewThreadComments:thread-2',
    'ReviewThreadComments:thread-1',
  ]);
  assert.deepEqual(actors, [{ login: 'codex' }, { login: 'other' }]);
  assert.deepEqual(snapshot.comments, [{ id: 'comment' }]);
  assert.deepEqual(snapshot.reviews, [{ id: 'review' }]);
  assert.deepEqual(snapshot.reactions, [{ id: 'reaction' }]);
  assert.deepEqual(snapshot.threads, [
    { ...rawThreads[0], comments: roots['thread-2'], root: roots['thread-2'][0], canonical: true },
    { ...rawThreads[1], comments: roots['thread-1'], root: roots['thread-1'][0], canonical: false },
  ]);
  assert.equal(snapshot.metadata.viewer.id, 'U');
});

test('readLiveSnapshot omits the reaction read when no comment is supplied', async () => {
  const events = [];
  const snapshot = await readLiveSnapshot(
    snapshotClient([], {}, events),
    { repository: 'owner/repo', prNumber: 41 },
    { isCanonicalActor: () => false },
  );
  assert.deepEqual(snapshot.reactions, []);
  assert.equal(events.some((event) => event.startsWith('RequestReactions:')), false);
});

test('readLiveSnapshot initiates all independent connection reads concurrently', async () => {
  const pending = [];
  const responseFor = (name) => {
    if (name === 'PullRequestComments') {
      return result({ repository: { pullRequest: { comments: connection([]) } } });
    }
    if (name === 'PullRequestReviews') {
      return result({ repository: { pullRequest: { reviews: connection([]) } } });
    }
    if (name === 'PullRequestThreads') {
      return result({ repository: { pullRequest: { reviewThreads: connection([]) } } });
    }
    return result({ node: { reactions: connection([]) } });
  };
  const client = {
    async graphql(request) {
      if (request.name === 'PullRequestMetadata') {
        return result({
          repository: {
            pullRequest: {
              id: 'PR', number: 41, headRefOid: HEAD, state: 'OPEN', isDraft: false,
            },
          },
          viewer: { login: 'viewer', id: 'U' },
        });
      }
      return new Promise((resolve) => {
        pending.push({ name: request.name, resolve });
        if (pending.length === 4) {
          for (const item of pending) item.resolve(responseFor(item.name));
        }
      });
    },
  };

  const snapshot = await readLiveSnapshot(
    client,
    { repository: 'owner/repo', prNumber: 41 },
    { reactionsFor: 'request', isCanonicalActor: () => false },
  );
  assert.deepEqual(pending.map((item) => item.name), [
    'PullRequestComments',
    'PullRequestReviews',
    'PullRequestThreads',
    'RequestReactions',
  ]);
  assert.deepEqual(snapshot, {
    metadata: {
      id: 'PR', number: 41, headRefOid: HEAD, state: 'OPEN', isDraft: false,
      viewer: { login: 'viewer', id: 'U' },
    },
    comments: [], reviews: [], threads: [], reactions: [],
  });
});

test('readLiveSnapshot rejects missing, duplicated, and ambiguous root identities', async () => {
  const cases = [
    [
      [{ id: '' }], {},
      'Review thread identity is missing or duplicated',
    ],
    [
      [{ id: 'same' }, { id: 'same' }], { same: [{ id: 'root', replyTo: null }] },
      'Review thread identity is missing or duplicated',
    ],
    [
      [{ id: 'thread' }], { thread: [] },
      'Thread thread does not have one explicit root',
    ],
    [
      [{ id: 'thread' }], { thread: [{ id: 'one', replyTo: null }, { id: 'two', replyTo: null }] },
      'Thread thread does not have one explicit root',
    ],
  ];
  for (const [rawThreads, comments, message] of cases) {
    await assert.rejects(
      readLiveSnapshot(
        snapshotClient(rawThreads, comments),
        { repository: 'owner/repo', prNumber: 41 },
        { isCanonicalActor: () => false },
      ),
      (error) => expectWorkflowError(error, 'ROOT_IDENTITY_AMBIGUOUS', message),
    );
  }
});
