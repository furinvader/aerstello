import assert from 'node:assert/strict';
import test from 'node:test';

import { intentFor, replyMarker } from './replies.mjs';
import {
  assertPriorHeadRecoveryLive,
  completedThreadlessRecoveryReady,
  journaledPriorHeadRecovery,
  priorHeadRecoveryCandidate,
} from './recovery.mjs';

const HEAD = 'a'.repeat(40);
const PRIOR_HEAD = 'b'.repeat(40);
const REPLY_INTENT_AT = '2026-08-22T00:00:00Z';
const REPLY_AT = '2026-08-22T00:00:01Z';
const RESOLVE_INTENT_AT = '2026-08-22T00:00:02Z';
const VIEWER = { id: 'VIEWER_ID', login: 'viewer' };

function fixture() {
  const selectedTask = {
    id: 'selected-task', sourceIds: ['thread:THREAD_1'], sourceType: 'github-thread',
    disposition: 'actionable', status: 'integrated', integratedCommitSha: PRIOR_HEAD,
  };
  const threadlessTask = {
    id: 'verified-threadless', sourceIds: ['review:one'], sourceType: 'github-threadless',
    disposition: 'actionable', status: 'completed', integratedCommitSha: HEAD,
  };
  const state = {
    prNumber: 2,
    currentIntegrationHeadSha: HEAD,
    integrationWorktree: '/tmp/integration',
    tasks: [selectedTask, threadlessTask],
    threadResolutionStatus: {
      status: 'not-run', headSha: null, threads: [], updatedAt: null,
      threadlessVerification: {
        status: 'passed', headSha: HEAD, taskIds: ['verified-threadless'], updatedAt: REPLY_INTENT_AT,
      },
    },
  };
  const replyOperationId = `reply:2:THREAD_1:${PRIOR_HEAD}`;
  const reply = {
    id: 'REPLY_1',
    url: 'https://example.test/reply/1',
    createdAt: REPLY_AT,
    author: VIEWER,
    replyTo: { id: 'ROOT_1' },
    body: [
      `Aerstello review resolution at ${PRIOR_HEAD}.`,
      'Tasks:',
      `- selected-task: ${PRIOR_HEAD}`,
      'Validation: npm run check.',
      replyMarker(replyOperationId),
    ].join('\n'),
  };
  const entry = {
    thread: {
      id: 'THREAD_1', canonical: true, isResolved: true,
      root: { id: 'ROOT_1', databaseId: 41 }, comments: [reply],
    },
    tasks: [selectedTask],
  };
  const live = { metadata: { viewer: VIEWER }, threads: [entry.thread] };
  return { state, selectedTask, entry, live, reply, replyOperationId };
}

function recoveryJournal(candidate, overrides = {}) {
  const intents = new Map([
    [candidate.replyOperationId, intentFor('reply', candidate.replyOperationId, REPLY_INTENT_AT)],
    [candidate.resolveOperationId, intentFor('resolve', candidate.resolveOperationId, RESOLVE_INTENT_AT)],
  ]);
  for (const [operationId, intent] of Object.entries(overrides)) intents.set(operationId, intent);
  return { async lookupIntent(operationId) { return intents.get(operationId) ?? null; } };
}

test('prior-head recovery requires completed exact-head threadless verification', () => {
  const { state } = fixture();
  assert.equal(completedThreadlessRecoveryReady(state), true);
  state.threadResolutionStatus.threadlessVerification.headSha = PRIOR_HEAD;
  assert.equal(completedThreadlessRecoveryReady(state), false);
  state.threadResolutionStatus.threadlessVerification.headSha = HEAD;
  state.tasks[1].status = 'integrated';
  assert.equal(completedThreadlessRecoveryReady(state), false);
});

test('prior-head recovery candidate retains exact reply and operation identities', () => {
  const setup = fixture();
  const candidate = priorHeadRecoveryCandidate(setup.state, setup.live, setup.entry, setup.selectedTask);
  assert.deepEqual(candidate, {
    priorHeadSha: PRIOR_HEAD,
    replyOperationId: setup.replyOperationId,
    resolveOperationId: `resolve:2:THREAD_1:${PRIOR_HEAD}`,
    reply: setup.reply,
    selectedTaskId: 'selected-task',
  });
  assert.equal(assertPriorHeadRecoveryLive(setup.state, setup.live, setup.entry, candidate), setup.reply);
});

test('journaled prior-head recovery proves ancestry and the ordered reply/resolve intent pair', async () => {
  const setup = fixture();
  const candidate = priorHeadRecoveryCandidate(setup.state, setup.live, setup.entry, setup.selectedTask);
  const result = await journaledPriorHeadRecovery(
    setup.state,
    setup.live,
    setup.entry,
    setup.selectedTask,
    recoveryJournal(candidate),
    { async isAncestor(ancestor, descendant, worktree) {
      assert.deepEqual([ancestor, descendant, worktree], [PRIOR_HEAD, HEAD, '/tmp/integration']);
      return true;
    } },
  );
  assert.equal(result.replyIntent.at, REPLY_INTENT_AT);
  assert.equal(result.resolveIntent.at, RESOLVE_INTENT_AT);
});

test('prior-head recovery fails closed on ambiguity, immutable reply drift, and ancestry loss', async () => {
  const ambiguous = fixture();
  ambiguous.entry.thread.comments.push({ ...ambiguous.reply, id: 'REPLY_2' });
  assert.throws(() => priorHeadRecoveryCandidate(
    ambiguous.state, ambiguous.live, ambiguous.entry, ambiguous.selectedTask,
  ), { code: 'REPLY_AMBIGUOUS' });

  const changed = fixture();
  const candidate = priorHeadRecoveryCandidate(changed.state, changed.live, changed.entry, changed.selectedTask);
  changed.reply.body = `${changed.reply.body}\naltered`;
  assert.throws(() => assertPriorHeadRecoveryLive(
    changed.state, changed.live, changed.entry, candidate,
  ), { code: 'REPLY_AMBIGUOUS' });

  const ancestry = fixture();
  await assert.rejects(() => journaledPriorHeadRecovery(
    ancestry.state, ancestry.live, ancestry.entry, ancestry.selectedTask,
    recoveryJournal(priorHeadRecoveryCandidate(
      ancestry.state, ancestry.live, ancestry.entry, ancestry.selectedTask,
    )),
    { async isAncestor() { return false; } },
  ), { code: 'MUTATION_NOT_READY' });
});

test('prior-head recovery rejects missing, malformed, or time-reversed journal evidence', async () => {
  for (const journal of [
    { async lookupIntent() { return null; } },
    null,
    'reversed',
  ]) {
    const setup = fixture();
    const candidate = priorHeadRecoveryCandidate(setup.state, setup.live, setup.entry, setup.selectedTask);
    const selectedJournal = journal === null
      ? { async lookupIntent(operationId) {
        return operationId === candidate.replyOperationId
          ? { ...intentFor('reply', operationId, REPLY_INTENT_AT), clientMutationId: 'wrong' }
          : intentFor('resolve', operationId, RESOLVE_INTENT_AT);
      } }
      : journal === 'reversed'
        ? recoveryJournal(candidate, {
          [candidate.resolveOperationId]: intentFor('resolve', candidate.resolveOperationId, '2026-08-21T23:59:59Z'),
        })
        : journal;
    await assert.rejects(() => journaledPriorHeadRecovery(
      setup.state, setup.live, setup.entry, setup.selectedTask,
      selectedJournal,
      { async isAncestor() { return true; } },
    ), (error) => ['RESOLUTION_PROOF_MISSING', 'JOURNAL_FAILED'].includes(error.code));
  }
});
