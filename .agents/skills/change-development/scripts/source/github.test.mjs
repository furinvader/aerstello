import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGhGraphqlAdapter } from './gh-adapter.mjs';
import { GithubSourceError, readGithubIssue } from './github.mjs';

const AT = '2026-08-17T00:00:00.000Z';
function issue(comments) {
  return { id: 'I_22', number: 22, url: 'https://github.test/issues/22', title: 'Plan', body: '- [ ] Work',
    state: 'OPEN', author: { login: 'owner', id: 'U_1' }, createdAt: AT, updatedAt: AT, comments };
}
function page(nodes, { hasNextPage = false, endCursor = null, remaining = 100 } = {}) {
  return { data: { rateLimit: { cost: 1, remaining }, repository: { issue: issue({ nodes,
    pageInfo: { hasNextPage, endCursor } }) } } };
}
function comment(id, body = id) {
  return { id, databaseId: Number(id.slice(1)), body, createdAt: AT, updatedAt: AT,
    author: { login: 'commenter', id: 'U_2' } };
}

test('GitHub issue reads every comment page and stores body receipts rather than raw comment bodies', async () => {
  const cursors = [];
  const adapter = { async readIssuePage({ cursor }) {
    cursors.push(cursor);
    return cursor === null ? page([comment('C1')], { hasNextPage: true, endCursor: 'next' }) : page([comment('C2')]);
  } };
  const result = await readGithubIssue({ repository: 'o/r', issueNumber: 22, adapter, capturedAt: AT });
  assert.deepEqual(cursors, [null, 'next']);
  assert.deepEqual(result.comments.map(({ id }) => id), ['C1', 'C2']);
  assert.match(result.comments[0].bodyDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(result.comments[0], 'body'), false);
  assert.equal(result.latestCommentIdentity, 'C2');
});

test('GitHub pagination fails closed for unsafe rate evidence and missing cursors', async () => {
  await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssuePage: async () => page([], { remaining: 1 }) } }),
  (error) => error instanceof GithubSourceError && error.code === 'GITHUB_RATE_LIMIT_UNSAFE');
  await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssuePage: async () => page([], { hasNextPage: true, endCursor: null }) } }),
  (error) => error instanceof GithubSourceError && error.code === 'GITHUB_CURSOR_INVALID');
});

test('GitHub pagination rejects non-adjacent cursor cycles', async () => {
  const nextByCursor = new Map([[null, 'cursor-a'], ['cursor-a', 'cursor-b'], ['cursor-b', 'cursor-a']]);
  await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssuePage: async ({ cursor }) => page([], {
      hasNextPage: true, endCursor: nextByCursor.get(cursor),
    }) } }), (error) => error instanceof GithubSourceError && error.code === 'GITHUB_CURSOR_INVALID');
});

test('GitHub pagination enforces a finite page bound', async () => {
  let calls = 0;
  await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssuePage: async () => {
      calls += 1;
      return page([], { hasNextPage: true, endCursor: `cursor-${calls}` });
    } } }), (error) => error instanceof GithubSourceError && error.code === 'GITHUB_PAGE_LIMIT');
  assert.equal(calls, 100);
});

test('connector-normalized comments with body digests are accepted without raw bodies', async () => {
  const result = await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssue: async () => ({ ...issue([{ ...comment('C1'), body: undefined,
      bodyDigest: `sha256:${'a'.repeat(64)}` }]), commentsComplete: true }) } });
  assert.equal(result.comments[0].bodyDigest, `sha256:${'a'.repeat(64)}`);
});

test('normalized connector arrays require explicit completeness proof', async () => {
  const incompleteIssues = [
    issue(undefined),
    issue([comment('C1')]),
    { ...issue([comment('C1')]), commentsComplete: false },
    { ...issue([comment('C1')]), commentsTotalCount: 2 },
    issue({ nodes: [comment('C1')] }),
    issue({ nodes: [comment('C1')], pageInfo: { hasNextPage: true, endCursor: 'next' } }),
  ];
  for (const incomplete of incompleteIssues) {
    await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
      adapter: { readIssue: async () => incomplete } }),
    (error) => error instanceof GithubSourceError && error.code === 'GITHUB_DATA_INCOMPLETE');
  }

  const completeArray = await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssue: async () => ({ ...issue([comment('C1')]), commentsTotalCount: 1 }) } });
  assert.deepEqual(completeArray.comments.map(({ id }) => id), ['C1']);

  const completeConnection = await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssue: async () => issue({ nodes: [comment('C1')],
      pageInfo: { hasNextPage: false, endCursor: null } }) } });
  assert.deepEqual(completeConnection.comments.map(({ id }) => id), ['C1']);
});

test('comment connection order is authoritative for latest identity', async () => {
  const opaque = [
    { ...comment('Z_OPAQUE'), databaseId: undefined },
    { ...comment('A_OPAQUE'), databaseId: undefined },
  ];
  const result = await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: AT,
    adapter: { readIssue: async () => ({ ...issue(opaque), commentsComplete: true }) } });
  assert.deepEqual(result.comments.map(({ id }) => id), ['Z_OPAQUE', 'A_OPAQUE']);
  assert.equal(result.latestCommentIdentity, 'A_OPAQUE');
});

test('issue, comment, and capture timestamps require strict RFC3339 date-times', async () => {
  const validOffset = { ...issue([]), commentsComplete: true,
    createdAt: '2026-08-17T02:00:00+02:00', updatedAt: '2026-08-17T02:01:00+02:00' };
  await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: '2026-08-17T00:00:00Z',
    adapter: { readIssue: async () => validOffset } });
  await readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt: '0000-01-01t00:00:00z',
    adapter: { readIssue: async () => validOffset } });

  const invalidCases = [
    { raw: { ...validOffset, createdAt: '2026-02-30T00:00:00Z' }, capturedAt: AT },
    { raw: { ...validOffset, updatedAt: '2026-08-17 00:00:00Z' }, capturedAt: AT },
    { raw: { ...validOffset, updatedAt: '2026-08-17T00:00:60Z' }, capturedAt: AT },
    { raw: { ...validOffset, comments: [{ ...comment('C1'), createdAt: '2026-08-17T00:00:00' }] }, capturedAt: AT },
    { raw: { ...validOffset, comments: [{ ...comment('C1'), updatedAt: '2026-08-17T00:00:00+24:00' }] }, capturedAt: AT },
    { raw: validOffset, capturedAt: '2026-08-17' },
  ];
  for (const { raw, capturedAt } of invalidCases) {
    await assert.rejects(readGithubIssue({ repository: 'o/r', issueNumber: 22, capturedAt,
      adapter: { readIssue: async () => raw } }),
    (error) => error instanceof GithubSourceError && error.code === 'GITHUB_DATA_INCOMPLETE');
  }
});

test('gh adapter issues only a GraphQL read and passes pagination cursor', async () => {
  let call;
  const adapter = createGhGraphqlAdapter({ execFile: async (...args) => {
    call = args;
    return { stdout: JSON.stringify(page([])) };
  } });
  await adapter.readIssuePage({ repository: 'o/r', issueNumber: 22, cursor: 'cursor-2' });
  assert.equal(call[0], 'gh');
  assert.deepEqual(call[1].slice(0, 2), ['api', 'graphql']);
  assert.ok(call[1].includes('cursor=cursor-2'));
  assert.equal(call[1].some((argument) => /mutation/iu.test(argument)), false);
});
