import assert from 'node:assert/strict';
import test from 'node:test';

import { deterministicReply, intentFor } from '../threads/replies.mjs';
import {
  journalThreadMutationIntent,
  lookupThreadMutationIntent,
  postThreadReply,
  resolveThread,
  threadOperationId,
} from './thread-reply-resolve.mjs';

const HEAD = 'a'.repeat(40);
const AT = '2026-08-22T00:00:00Z';
const VIEWER = { id: 'VIEWER_ID', login: 'viewer' };

function state() {
  return {
    prNumber: 2,
    currentIntegrationHeadSha: HEAD,
    integrationWorktree: '/tmp/integration',
    validationStatus: { checks: ['npm run check'] },
  };
}

function entry() {
  return {
    thread: {
      id: 'THREAD_1',
      isResolved: false,
      root: { id: 'ROOT_1' },
      comments: [],
    },
    tasks: [{ id: 'task-one', integratedCommitSha: HEAD }],
  };
}

function journal(events, { existing = null } = {}) {
  return {
    async ensureIntent(intent) {
      events.push(`journal:${intent.type}`);
      return existing ?? { ...intent, isNew: true };
    },
    async lookupIntent(operationId) {
      events.push(`lookup:${operationId}`);
      return existing;
    },
  };
}

test('thread operation IDs and journal records retain deterministic correlation', async () => {
  const active = state();
  const operationId = threadOperationId('reply', active, 'THREAD:/opaque');
  assert.equal(operationId, `reply:2:THREAD:/opaque:${HEAD}`);
  const events = [];
  const persisted = await journalThreadMutationIntent(journal(events), 'reply', operationId, AT);
  assert.deepEqual(persisted, { ...intentFor('reply', operationId, AT), isNew: true });
  assert.deepEqual(events, ['journal:reply']);

  const existing = { ...intentFor('resolve', `resolve:2:THREAD_1:${HEAD}`, AT), isNew: false };
  assert.deepEqual(
    await lookupThreadMutationIntent(journal(events, { existing }), 'resolve', existing.operationId),
    existing,
  );
  await assert.rejects(() => lookupThreadMutationIntent(
    journal([], { existing: { ...existing, clientMutationId: 'wrong' } }),
    'resolve',
    existing.operationId,
  ), { code: 'JOURNAL_FAILED' });
});

test('reply mutation journals, re-queries, dispatches, and proves the exact live reply in order', async () => {
  const events = [];
  const active = state();
  const planned = entry();
  const liveThread = structuredClone(planned.thread);
  const readSnapshot = async () => {
    events.push('read');
    return { metadata: { viewer: VIEWER }, threads: [structuredClone(liveThread)] };
  };
  const result = await postThreadReply({
    client: {},
    journal: journal(events),
    clock: { now: () => AT },
    state: active,
    git: {},
    entry: planned,
    assertCurrent: async () => { events.push('revision'); },
    readSnapshot,
    assertReady: async () => { events.push('ready'); },
    execute: async (_client, name, variables, field) => {
      events.push(`mutation:${name}:${field}`);
      liveThread.comments.push({
        id: 'REPLY_1',
        url: 'https://example.test/reply',
        author: VIEWER,
        replyTo: { id: liveThread.root.id },
        body: variables.body,
      });
    },
  });
  assert.equal(result.reply.id, 'REPLY_1');
  assert.equal(result.reply.body, deterministicReply(active, planned, result.operationId));
  assert.deepEqual(events, [
    'journal:reply', 'read', 'ready', 'revision',
    'mutation:AddThreadReply:addPullRequestReviewThreadReply', 'read', 'read',
  ]);
});

test('reply recovery never dispatches after a persisted intent loses its unique live marker', async () => {
  const active = state();
  const operationId = threadOperationId('reply', active, 'THREAD_1');
  const events = [];
  await assert.rejects(() => postThreadReply({
    client: {},
    journal: journal(events, { existing: { ...intentFor('reply', operationId, AT), isNew: false } }),
    clock: { now: () => AT },
    state: active,
    git: {},
    entry: entry(),
    assertCurrent: async () => { events.push('revision'); },
    readSnapshot: async () => ({ metadata: { viewer: VIEWER }, threads: [entry().thread] }),
    assertReady: async () => { events.push('ready'); },
    execute: async () => { events.push('mutation'); },
  }), { code: 'REPLY_RECOVERY_MISSING' });
  assert.deepEqual(events, ['journal:reply', 'ready']);
});

test('resolve mutation journals before dispatch and trusts only a live re-query', async () => {
  const events = [];
  const active = state();
  const planned = entry();
  let resolved = false;
  const readSnapshot = async () => {
    events.push('read');
    return {
      metadata: { viewer: VIEWER },
      threads: [{ ...structuredClone(planned.thread), isResolved: resolved }],
    };
  };
  const reply = { id: 'REPLY_1' };
  const result = await resolveThread({
    client: {},
    journal: journal(events),
    clock: { now: () => AT },
    state: active,
    git: {},
    entry: planned,
    reply,
    assertCurrent: async () => { events.push('revision'); },
    readSnapshot,
    assertReady: async () => { events.push('ready'); },
    execute: async (_client, name, _variables, field) => {
      events.push(`mutation:${name}:${field}`);
      resolved = true;
    },
  });
  assert.deepEqual(result.evidence, { reply, resolvedAt: AT, resolvedBy: VIEWER.login });
  assert.deepEqual(events, [
    'read', 'ready', 'journal:resolve', 'read', 'ready', 'revision',
    'mutation:ResolveThread:resolveReviewThread', 'read',
  ]);
});

test('resolve recovery records a journaled resolution observed before dispatch', async () => {
  const events = [];
  const active = state();
  const planned = entry();
  let reads = 0;
  const result = await resolveThread({
    client: {},
    journal: journal(events),
    clock: { now: () => AT },
    state: active,
    git: {},
    entry: planned,
    reply: { id: 'REPLY_1' },
    assertCurrent: async () => { events.push('revision'); },
    readSnapshot: async () => {
      reads += 1;
      events.push('read');
      return {
        metadata: { viewer: VIEWER },
        threads: [{ ...structuredClone(planned.thread), isResolved: reads > 1 }],
      };
    },
    assertReady: async () => { events.push('ready'); },
    execute: async () => { events.push('mutation'); },
  });
  assert.equal(result.thread.isResolved, true);
  assert.deepEqual(events, ['read', 'ready', 'journal:resolve', 'read', 'ready']);
});
