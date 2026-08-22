import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  aggregateHistoricalReplyBody,
  deterministicReply,
  exactRepliesFor,
  intentFor,
  replyMarker,
} from './replies.mjs';

const HEAD = 'a'.repeat(40);
const VIEWER = { id: 'VIEWER_ID', login: 'viewer' };

function replyState() {
  return {
    prNumber: 2,
    currentIntegrationHeadSha: HEAD,
    validationStatus: { checks: ['npm run check', 'npm test', 'npm run lint', 'ignored'] },
  };
}

function entry(comments = []) {
  return {
    thread: { id: 'THREAD_1', root: { id: 'ROOT_1' }, comments },
    tasks: [
      { id: 'z-task', integratedCommitSha: 'b'.repeat(40) },
      { id: 'a-task', integratedCommitSha: null, disposition: 'already-fixed', resolutionSummary: 'Verified.' },
    ],
  };
}

test('reply identities and deterministic body bytes remain stable', () => {
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const token = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
  assert.deepEqual(intentFor('reply', operationId, '2026-08-22T00:00:00Z'), {
    type: 'reply', operationId, clientMutationId: `aerstello-${token}`, at: '2026-08-22T00:00:00Z',
  });
  assert.equal(deterministicReply(replyState(), entry(), operationId), [
    `Aerstello review resolution at ${HEAD}.`,
    'Tasks:',
    '- a-task: already-fixed — Verified.',
    `- z-task: ${'b'.repeat(40)}`,
    'Validation: npm run check, npm test, npm run lint.',
    `<!-- aerstello-review:${token} -->`,
  ].join('\n'));
});

test('aggregate historical replies require exact durable task and marker bytes', () => {
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const body = [
    `Aerstello review resolution at ${HEAD}.`,
    'Tasks:',
    `- task-one: ${'b'.repeat(40)}`,
    'Validation: npm run check.',
    replyMarker(operationId),
  ].join('\n');
  const options = {
    prNumber: 2,
    threadNodeId: 'THREAD_1',
    historicalHeadSha: HEAD,
    historicalTaskId: 'task-one',
    historicalDisposition: 'fixed',
    historicalIntegratedCommitSha: 'b'.repeat(40),
  };
  assert.deepEqual(aggregateHistoricalReplyBody(body, options), {
    historicalHeadSha: HEAD,
    expectedMarker: replyMarker(operationId),
  });
  assert.equal(aggregateHistoricalReplyBody(`${body}\naltered`, options), null);
  assert.equal(aggregateHistoricalReplyBody(body.replace('task-one', 'task\none'), {
    ...options, historicalTaskId: 'task\none',
  }), null);
});

test('exact replies require complete equality and the exact viewer identity', () => {
  const state = replyState();
  const base = entry();
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const body = deterministicReply(state, base, operationId);
  const exact = { id: 'REPLY_1', body, author: VIEWER, replyTo: { id: 'ROOT_1' } };
  assert.deepEqual(exactRepliesFor(state, { metadata: { viewer: VIEWER } }, entry([exact])).exact, [exact]);

  assert.throws(() => exactRepliesFor(state, { metadata: { viewer: VIEWER } }, entry([{
    ...exact, body: `${body}\naltered`,
  }])), { code: 'REPLY_AMBIGUOUS' });
  assert.throws(() => exactRepliesFor(state, { metadata: { viewer: VIEWER } }, entry([{
    ...exact, author: { id: 'OTHER', login: 'other' },
  }])), { code: 'REPLY_AMBIGUOUS' });
});
