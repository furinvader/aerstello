import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import { buildGhGraphqlArgs, createDefaultGitHubClient } from './gh-cli.mjs';

test('builds shell-free gh GraphQL arguments in insertion order', () => {
  assert.deepEqual(buildGhGraphqlArgs('query Example { viewer { login } }', {
    owner: 'example',
    ignoredNull: null,
    pr: 17,
    ignoredUndefined: undefined,
    ready: false,
  }), [
    'api', 'graphql', '-f', 'query=query Example { viewer { login } }',
    '-f', 'owner=example', '-F', 'pr=17', '-F', 'ready=false',
  ]);
});

test('rejects unsupported queries and variables with the exact typed error', () => {
  for (const [run, message] of [
    [() => buildGhGraphqlArgs(null, {}), 'GraphQL query must be a string'],
    [() => buildGhGraphqlArgs('query X', { cursor: [] }),
      'GraphQL variable cursor has an unsupported value'],
    [() => buildGhGraphqlArgs('query X', { page: Number.POSITIVE_INFINITY }),
      'GraphQL variable page has an unsupported value'],
  ]) {
    assert.throws(run, (error) => {
      assert.ok(error instanceof GitHubWorkflowError);
      assert.equal(error.code, 'INVALID_GRAPHQL_VARIABLE');
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('invokes gh directly with exact stdio and decodes its JSON response', async () => {
  const calls = [];
  const client = createDefaultGitHubClient((file, args, options) => {
    calls.push({ file, args, options });
    return '{"data":{"viewer":{"login":"maintainer"}}}';
  });
  assert.deepEqual(await client.graphql({
    query: 'query Viewer { viewer { login } }',
    variables: { enabled: true },
  }), { data: { viewer: { login: 'maintainer' } } });
  assert.deepEqual(calls, [{
    file: 'gh',
    args: [
      'api', 'graphql', '-f', 'query=query Viewer { viewer { login } }',
      '-F', 'enabled=true',
    ],
    options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  }]);

  const malformed = createDefaultGitHubClient(() => 'not-json');
  await assert.rejects(() => malformed.graphql({ query: 'query X', variables: {} }), SyntaxError);
});
