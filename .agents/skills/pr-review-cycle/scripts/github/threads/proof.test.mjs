import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertExistingThreadProof,
  assertLiveThreadProof,
  assertRecordedReply,
  assertRecordedThreadsLive,
  buildThreadProof,
} from './proof.mjs';
import { deterministicReply, replyMarker } from './replies.mjs';

const HEAD = 'a'.repeat(40);
const PRIOR_HEAD = 'b'.repeat(40);
const AT = '2026-08-22T00:00:00Z';
const VIEWER = { id: 'VIEWER_ID', login: 'viewer' };

function task(overrides = {}) {
  return {
    id: 'task-one',
    sourceIds: ['thread:THREAD_1'],
    sourceType: 'github-thread',
    disposition: 'actionable',
    status: 'integrated',
    integratedCommitSha: HEAD,
    ...overrides,
  };
}

function emptyStatus(overrides = {}) {
  return {
    status: 'not-run',
    headSha: null,
    threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    localVerification: { status: 'passed', headSha: HEAD, taskIds: ['local-one'], updatedAt: AT },
    updatedAt: null,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    prNumber: 2,
    currentIntegrationHeadSha: HEAD,
    validationStatus: { status: 'passed', headSha: HEAD, checks: ['npm run check'] },
    tasks: [task()],
    threadResolutionStatus: emptyStatus(),
    ...overrides,
  };
}

function liveThread(active, { resolved = true, body = null, reply = null } = {}) {
  const thread = {
    id: 'THREAD_1',
    canonical: true,
    isResolved: resolved,
    root: { id: 'ROOT_1', databaseId: 41 },
    comments: [],
  };
  const entry = { thread, tasks: active.tasks.filter((item) => item.sourceType === 'github-thread') };
  const operationId = `reply:${active.prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
  thread.comments.push(reply ?? {
    id: 'REPLY_1',
    url: 'https://example.test/reply/1',
    createdAt: AT,
    lastEditedAt: null,
    author: VIEWER,
    replyTo: { id: thread.root.id },
    body: body ?? deterministicReply(active, entry, operationId),
  });
  return { metadata: { viewer: VIEWER }, threads: [thread] };
}

test('thread proof is built only from an exact live reply and resolution evidence', () => {
  const active = state();
  const live = liveThread(active);
  const reply = live.threads[0].comments[0];
  const proof = buildThreadProof(active, live, new Map([['THREAD_1', {
    reply, resolvedAt: AT, resolvedBy: VIEWER.login,
  }]]), AT);
  assert.deepEqual(proof, {
    status: 'passed',
    headSha: HEAD,
    threads: [{
      threadNodeId: 'THREAD_1',
      rootCommentNodeId: 'ROOT_1',
      rootCommentDatabaseId: 41,
      taskIds: ['task-one'],
      disposition: 'fixed',
      replyId: 'REPLY_1',
      replyUrl: 'https://example.test/reply/1',
      isResolved: true,
      resolvedAt: AT,
      resolvedBy: VIEWER.login,
      observedHeadSha: HEAD,
    }],
    threadlessVerification: active.threadResolutionStatus.threadlessVerification,
    localVerification: active.threadResolutionStatus.localVerification,
    updatedAt: AT,
  });

  const durable = state({ threadResolutionStatus: proof });
  assert.doesNotThrow(() => assertLiveThreadProof(durable, live));
  assert.doesNotThrow(() => assertRecordedThreadsLive(durable, live));
});

test('existing proof fails closed on root, task, disposition, resolution, and reply-pair drift', () => {
  const active = state();
  const live = liveThread(active);
  const entry = { thread: live.threads[0], tasks: active.tasks };
  const base = {
    threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_1', rootCommentDatabaseId: 41,
    taskIds: ['task-one'], disposition: 'fixed', replyId: 'REPLY_1',
    replyUrl: 'https://example.test/reply/1', isResolved: true,
    resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
  };
  for (const changed of [
    { ...base, rootCommentNodeId: 'ROOT_other' },
    { ...base, taskIds: ['task-other'] },
    { ...base, disposition: 'stale' },
    { ...base, replyUrl: null },
  ]) {
    assert.throws(() => assertExistingThreadProof(active, live, entry, changed), {
      code: 'THREAD_PROOF_STALE',
    });
  }
  live.threads[0].isResolved = false;
  assert.throws(() => assertExistingThreadProof(active, live, entry, base), {
    code: 'THREAD_PROOF_STALE',
  });
});

test('resolved historical proof preserves immutable evidence across a later integration head', () => {
  const historicalTask = task({ integratedCommitSha: PRIOR_HEAD });
  const current = state({
    currentIntegrationHeadSha: HEAD,
    tasks: [historicalTask],
    validationStatus: { status: 'passed', headSha: HEAD, checks: ['new check'] },
  });
  const operationId = `reply:2:THREAD_1:${PRIOR_HEAD}`;
  const body = [
    `Aerstello review resolution at ${PRIOR_HEAD}.`,
    'Tasks:',
    `- task-one: ${PRIOR_HEAD}`,
    'Validation: old check.',
    replyMarker(operationId),
  ].join('\n');
  const live = liveThread(current, { body });
  const old = {
    threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_1', rootCommentDatabaseId: 41,
    taskIds: ['task-one'], disposition: 'fixed', replyId: 'REPLY_1',
    replyUrl: 'https://example.test/reply/1', isResolved: true,
    resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: PRIOR_HEAD,
  };
  current.threadResolutionStatus = emptyStatus({ status: 'passed', headSha: HEAD, threads: [old], updatedAt: AT });
  assert.deepEqual(buildThreadProof(current, live, new Map(), '2026-08-22T01:00:00Z').threads, [old]);
});

test('archive provenance requires exact keys, body hash, aggregate bytes, and viewer identity', () => {
  const historicalTaskId = 'archived-task';
  const operationId = `reply:2:THREAD_1:${PRIOR_HEAD}`;
  const body = [
    `Aerstello review resolution at ${PRIOR_HEAD}.`,
    'Tasks:',
    `- ${historicalTaskId}: ${PRIOR_HEAD}`,
    'Validation: archived check.',
    replyMarker(operationId),
  ].join('\n');
  const active = state();
  const live = liveThread(active, { body });
  const entry = { thread: live.threads[0], tasks: active.tasks };
  const provenance = {
    schemaVersion: 1,
    historicalTaskId,
    historicalDisposition: 'fixed',
    historicalIntegratedCommitSha: PRIOR_HEAD,
    replyBodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    authorityFingerprint: 'c'.repeat(64),
  };
  const proof = {
    replyId: 'REPLY_1', replyUrl: 'https://example.test/reply/1', isResolved: true,
    resolvedBy: VIEWER.login, observedHeadSha: PRIOR_HEAD, archiveProvenance: provenance,
  };
  assert.equal(assertRecordedReply(active, live, entry, proof).id, 'REPLY_1');
  assert.throws(() => assertRecordedReply(active, live, entry, {
    ...proof, archiveProvenance: { ...provenance, extra: true },
  }), { code: 'THREAD_PROOF_STALE' });
  assert.throws(() => assertRecordedReply(active, live, entry, {
    ...proof, archiveProvenance: { ...provenance, replyBodySha256: '0'.repeat(64) },
  }), { code: 'THREAD_PROOF_STALE' });
});

test('resolved live roots cannot acquire a weaker proof without fresh durable evidence', () => {
  const active = state();
  const live = liveThread(active);
  assert.throws(() => buildThreadProof(active, live, new Map(), AT), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.throws(() => assertLiveThreadProof(active, live), { code: 'THREAD_PROOF_STALE' });
});
