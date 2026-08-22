import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import {
  MAX_NODES,
  MAX_PAGES,
  MIN_GRAPHQL_REMAINING,
  assertGraphqlResult,
  execute,
  executeMutation,
  paginate,
} from './client.mjs';
import { OPERATIONS } from './operations.mjs';

function expectWorkflowError(error, code, message) {
  assert.ok(error instanceof GitHubWorkflowError);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  return true;
}

test('exports the exact GraphQL safety limits', () => {
  assert.equal(MAX_PAGES, 100);
  assert.equal(MAX_NODES, 10_000);
  assert.equal(MIN_GRAPHQL_REMAINING, 10);
});

test('GitHubWorkflowError preserves its stable name, message, and codes', () => {
  const defaultError = new GitHubWorkflowError('default');
  assert.equal(defaultError.name, 'GitHubWorkflowError');
  assert.equal(defaultError.message, 'default');
  assert.equal(defaultError.code, 'GITHUB_WORKFLOW_ERROR');

  const codedError = new GitHubWorkflowError('coded', 'CODED');
  assert.equal(codedError.code, 'CODED');
});

test('execute sends the named operation and variables and returns its data', async () => {
  const variables = { owner: 'owner', repo: 'repo', pr: 41 };
  const calls = [];
  const data = { rateLimit: { cost: 1, remaining: 10 }, repository: {} };
  const client = {
    async graphql(request) {
      calls.push(request);
      return { data };
    },
  };

  assert.equal(await execute(client, 'PullRequestMetadata', variables), data);
  assert.deepEqual(calls, [{
    name: 'PullRequestMetadata',
    query: OPERATIONS.PullRequestMetadata,
    variables,
  }]);
});

test('assertGraphqlResult preserves read failure ordering and error details', () => {
  for (const result of [null, {}, { errors: [{}] }, { data: null }]) {
    assert.throws(
      () => assertGraphqlResult(result, 'PullRequestMetadata'),
      (error) => expectWorkflowError(
        error,
        'GRAPHQL_READ_FAILED',
        'PullRequestMetadata returned GraphQL errors or no data',
      ),
    );
  }
});

test('execute validates the GraphQL result before the rate-limit proof', async () => {
  const client = { graphql: async () => ({ errors: [{}] }) };
  await assert.rejects(
    execute(client, 'PullRequestMetadata', {}),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_READ_FAILED',
      'PullRequestMetadata returned GraphQL errors or no data',
    ),
  );
});

test('execute rejects missing, non-finite, or low read rate-limit evidence', async () => {
  for (const rateLimit of [undefined, { cost: Number.NaN, remaining: 10 }, { cost: 1, remaining: 9 }]) {
    const client = { graphql: async () => ({ data: { rateLimit } }) };
    await assert.rejects(
      execute(client, 'PullRequestComments', {}),
      (error) => expectWorkflowError(
        error,
        'GRAPHQL_COST_UNSAFE',
        'PullRequestComments did not prove safe live rate-limit cost',
      ),
    );
  }
});

test('mutation operations bypass read rate-limit checks and preserve correlation', async () => {
  const cases = [
    ['AddReviewRequest', 'addComment'],
    ['AddThreadReply', 'addPullRequestReviewThreadReply'],
    ['MarkPullRequestReadyForReview', 'markPullRequestReadyForReview'],
    ['ResolveThread', 'resolveReviewThread'],
  ];
  for (const [name, payloadField] of cases) {
    const variables = { clientMutationId: `${name}-id` };
    const payload = { clientMutationId: variables.clientMutationId };
    const client = { graphql: async () => ({ data: { [payloadField]: payload } }) };
    assert.equal(await executeMutation(client, name, variables, payloadField), payload);
  }
});

test('executeMutation rejects lost client mutation correlation', async () => {
  const client = {
    graphql: async () => ({ data: { addComment: { clientMutationId: 'different' } } }),
  };
  await assert.rejects(
    executeMutation(client, 'AddReviewRequest', { clientMutationId: 'expected' }, 'addComment'),
    (error) => expectWorkflowError(
      error,
      'MUTATION_CORRELATION_FAILED',
      'AddReviewRequest lost clientMutationId correlation',
    ),
  );
});

test('paginate follows cursors in order and aggregates nodes', async () => {
  const calls = [];
  const pages = [
    { nodes: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'next' } },
    { nodes: [{ id: 2 }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const client = {
    async graphql(request) {
      calls.push(request.variables);
      return {
        data: {
          rateLimit: { cost: 1, remaining: 10 },
          connection: pages[calls.length - 1],
        },
      };
    },
  };

  assert.deepEqual(
    await paginate(client, 'PullRequestComments', { owner: 'owner' }, (data) => data.connection),
    [{ id: 1 }, { id: 2 }],
  );
  assert.deepEqual(calls, [
    { owner: 'owner', cursor: null },
    { owner: 'owner', cursor: 'next' },
  ]);
});

test('paginate rejects malformed connections and missing or repeated cursors', async () => {
  const malformedConnections = [
    null,
    { nodes: null, pageInfo: { hasNextPage: false } },
    { nodes: [], pageInfo: {} },
  ];
  for (const connection of malformedConnections) {
    const client = {
      graphql: async () => ({
        data: { rateLimit: { cost: 1, remaining: 10 }, connection },
      }),
    };
    await assert.rejects(
      paginate(client, 'PullRequestComments', {}, (data) => data.connection),
      (error) => expectWorkflowError(
        error,
        'GRAPHQL_TRUNCATED',
        'PullRequestComments returned a truncated connection',
      ),
    );
  }

  for (const endCursor of [null, 'same']) {
    let call = 0;
    const client = {
      graphql: async () => ({
        data: {
          rateLimit: { cost: 1, remaining: 10 },
          connection: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: call++ === 0 ? 'same' : endCursor },
          },
        },
      }),
    };
    await assert.rejects(
      paginate(client, 'PullRequestComments', {}, (data) => data.connection),
      (error) => expectWorkflowError(
        error,
        'GRAPHQL_TRUNCATED',
        'PullRequestComments pagination cursor is missing or repeated',
      ),
    );
  }
});

test('paginate enforces the node limit', async () => {
  const client = {
    graphql: async () => ({
      data: {
        rateLimit: { cost: 1, remaining: 10 },
        connection: {
          nodes: Array.from({ length: MAX_NODES + 1 }),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  };
  await assert.rejects(
    paginate(client, 'PullRequestComments', {}, (data) => data.connection),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_TRUNCATED',
      'PullRequestComments exceeded the node limit',
    ),
  );
});

test('paginate enforces the page limit after exactly one hundred pages', async () => {
  let calls = 0;
  const client = {
    graphql: async () => ({
      data: {
        rateLimit: { cost: 1, remaining: 10 },
        connection: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: `cursor-${calls += 1}` },
        },
      },
    }),
  };
  await assert.rejects(
    paginate(client, 'PullRequestComments', {}, (data) => data.connection),
    (error) => expectWorkflowError(
      error,
      'GRAPHQL_TRUNCATED',
      'PullRequestComments exceeded the page limit',
    ),
  );
  assert.equal(calls, MAX_PAGES);
});
