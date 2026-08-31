import assert from 'node:assert/strict';
import { test } from 'node:test';

import { archiveTaskCheckpoint, createResolveUseCases } from './resolve.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  ARCHIVED_TASK_ID,
  AT,
  FakeClient,
  HEAD,
  PACKET_AGGREGATE_HEAD,
  PACKET_AGGREGATE_TASK_ID,
  PACKET_ARCHIVE_EVENTS_BASE64,
  PACKET_ARCHIVE_NAME,
  PACKET_ARCHIVE_STATE_BASE64,
  PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  PACKET_MIXED_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_STATE_BASE64,
  PACKET_PORTABILITY_TASK_ID,
  VIEWER,
  addThread,
  archiveAdoptionFixture,
  decodedPacketArchive,
  fakeGit,
  fakeJournal,
  fakeState,
  immutableArchiveStore,
  integratedNonThreadState,
  integratedThreadState,
  markerFor,
  packetAggregateAdoptionFixture,
  rootComment,
} from '../test-support/workflow-harness.mjs';

function addExactReply(client, state) {
  const threadId = 'THREAD_1';
  const root = rootComment(threadId);
  const operationId = `reply:2:${threadId}:${HEAD}`;
  const body = [
    `Aerstello review resolution at ${HEAD}.`,
    'Tasks:',
    `- task-thread: ${HEAD}`,
    `Validation: ${state.validationStatus.checks.slice(0, 3).join(', ')}.`,
    markerFor(operationId),
  ].join('\n');
  addThread(client, {
    id: threadId,
    root,
    replies: [{
      id: 'REPLY_exact', databaseId: 901,
      url: 'https://github.com/example/aerstello/pull/2#discussion_r901',
      body, createdAt: AT, lastEditedAt: null, author: VIEWER,
      replyTo: { id: root.id }, pullRequestReview: null,
    }],
  });
}

test('resolve owner keeps aggregate archive checkpoint fallback dedicated and cwd-bound', async () => {
  const calls = [];
  const checkpoint = archiveTaskCheckpoint({}, { integrationWorktree: '/tmp/exact-integration' }, async (input) => {
    calls.push(input);
    return { revision: 4 };
  });
  assert.deepEqual(await checkpoint({ prNumber: 2, expectedRevision: 3 }), { revision: 4 });
  assert.deepEqual(calls, [{ cwd: '/tmp/exact-integration', prNumber: 2, expectedRevision: 3 }]);
});

test('resolve owner performs repeated archive and live reads before one adoption checkpoint', async () => {
  const fixture = archiveAdoptionFixture();
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const stateAdapter = fakeState(fixture.active);
  const context = createWorkflowContext({
    client: fixture.client,
    state: stateAdapter,
    git: fakeGit(),
    clock: { now: () => AT },
    journal: fixture.journal,
    archiveStore,
  });
  const result = await createResolveUseCases(context).replyResolve(2, ARCHIVED_TASK_ID);
  assert.equal(archiveStore.calls, 2);
  assert.ok(fixture.client.calls.filter(({ name }) => name === 'PullRequestMetadata').length >= 2);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointTaskCompletion']);
  assert.equal(result.threadResolutionStatus.threads.filter(({ isResolved }) => isResolved).length, 2);
  assert.equal(fixture.client.events.length, 0);
});

test('resolve owner selects only the closed GitHub-thread attestation fallback', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME,
    PACKET_MIXED_ARCHIVE_STATE_BASE64,
    PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  const localTask = fixture.remediation;
  localTask.status = 'integrated';
  localTask.sourceType = 'local';
  localTask.sourceIds = ['orchestrator:integration-verifier'];
  const githubTask = fixture.active.tasks.find((task) => task.id === PACKET_PORTABILITY_TASK_ID);
  githubTask.disposition = 'actionable';
  githubTask.status = 'integrated';
  githubTask.integratedCommitSha = PACKET_AGGREGATE_HEAD;
  const archiveStore = immutableArchiveStore([oldArchive, mixedArchive]);
  const stateAdapter = fakeState(fixture.active);
  const context = createWorkflowContext({
    client: fixture.client,
    state: stateAdapter,
    git: fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    }),
    clock: { now: () => AT },
    journal: fixture.journal,
    archiveStore,
  });

  process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION = JSON.stringify({
    schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean',
    headSha: PACKET_AGGREGATE_HEAD, stateRevision: fixture.active.revision,
    scopeAuthorityDigest: fixture.active.scopeControl.authorityDigest,
    scopeJournalDigest: fixture.active.scopeControl.journalDigest, assertedAt: AT,
  });
  try {
    await createResolveUseCases(context).replyResolve(
      fixture.active.prNumber, PACKET_AGGREGATE_TASK_ID,
    );
  } finally {
    delete process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
  }

  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointArchiveTaskCompletion']);
  assert.equal(stateAdapter.calls[0].input.archiveImportEnvelope.schemaVersion, 2);
  assert.equal(stateAdapter.calls[0].input.verifierBootstrapEnvelope, undefined);
  assert.deepEqual(
    stateAdapter.calls[0].input.archiveImportEnvelope.attestation.scope.classifications
      .map((item) => item.taskId),
    [localTask.id, PACKET_AGGREGATE_TASK_ID, PACKET_PORTABILITY_TASK_ID],
  );
  assert.equal(fixture.client.calls.some(({ name }) => [
    'AddThreadReply', 'ResolveThread',
  ].includes(name)), false);
  assert.deepEqual(fixture.client.events, []);
});

test('resolve owner rejects absent, malformed, and stale verifier assertions before archive reads', async () => {
  for (const [label, assertion] of [
    ['absent', null],
    ['malformed', '{'],
    ['old revision', JSON.stringify({
      schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean',
      headSha: HEAD, stateRevision: 0,
      scopeAuthorityDigest: `sha256:${'a'.repeat(64)}`,
      scopeJournalDigest: `sha256:${'b'.repeat(64)}`, assertedAt: AT,
    })],
  ]) {
    const fixture = archiveAdoptionFixture();
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
    };
    const localTask = fixture.active.tasks.find(
      (task) => task.id === 'archive-adoption-remediation',
    );
    localTask.status = 'integrated';
    localTask.sourceType = 'local';
    localTask.sourceIds = ['orchestrator:integration-verifier'];
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const stateAdapter = fakeState(fixture.active);
    const context = createWorkflowContext({
      client: fixture.client, state: stateAdapter, git: fakeGit(),
      clock: { now: () => AT }, journal: fixture.journal, archiveStore,
    });
    if (assertion === null) delete process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
    else process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION = assertion;
    try {
      await assert.rejects(
        () => createResolveUseCases(context).replyResolve(2, ARCHIVED_TASK_ID),
        { code: 'TASK_NOT_READY' },
        label,
      );
    } finally {
      delete process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
    }
    assert.equal(archiveStore.calls, 0, label);
    assert.deepEqual(stateAdapter.calls, [], label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('verify-resolve owner repeats exact-head proof before one local completion checkpoint', async () => {
  const client = new FakeClient();
  const stateAdapter = fakeState(integratedNonThreadState());
  const context = createWorkflowContext({
    client,
    state: stateAdapter,
    git: fakeGit(),
    clock: { now: () => AT },
    journal: fakeJournal(client.events),
  });
  const verifyResolve = createResolveUseCases(context).verifyResolve;
  const result = await verifyResolve(2, ['task-local']);
  assert.equal(result.taskId, 'task-local');
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 2);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointTaskCompletion']);
  assert.deepEqual(stateAdapter.calls[0].input.verifiedLocalTaskIds, ['task-local']);
  const repeated = await verifyResolve(2, ['task-local']);
  assert.equal(repeated.stateRevision, result.stateRevision);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestMetadata').length, 4);
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointTaskCompletion']);
  assert.deepEqual(client.events, []);
});

test('resolve owner timestamps an executed resolve after mutation, not at intent creation', async () => {
  const initial = integratedThreadState();
  const client = new FakeClient();
  addExactReply(client, initial);
  const times = [
    '2026-08-22T10:00:00.000Z',
    '2026-08-22T10:00:01.000Z',
    '2026-08-22T10:00:02.000Z',
  ];
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => times.shift() },
    journal: fakeJournal(client.events),
  });
  const result = await createResolveUseCases(context).replyResolve(2, 'task-thread');
  assert.equal(result.threadResolutionStatus.threads[0].resolvedAt, '2026-08-22T10:00:01.000Z');
  assert.deepEqual(client.events, ['intent:resolve', 'mutation:ResolveThread']);
  assert.deepEqual(times, []);
});

test('resolve owner uses intent time when post-intent observation proves concurrent resolution', async () => {
  const initial = integratedThreadState();
  const client = new FakeClient();
  addExactReply(client, initial);
  const events = client.events;
  const journal = fakeJournal(events);
  const ensureIntent = journal.ensureIntent.bind(journal);
  journal.ensureIntent = async (intent) => {
    const persisted = await ensureIntent(intent);
    if (intent.type === 'resolve') client.threads[0].isResolved = true;
    return persisted;
  };
  const times = ['2026-08-22T11:00:00.000Z', '2026-08-22T11:00:01.000Z'];
  const stateAdapter = fakeState(initial);
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => times.shift() }, journal,
  });
  const result = await createResolveUseCases(context).replyResolve(2, 'task-thread');
  assert.equal(result.threadResolutionStatus.threads[0].resolvedAt, '2026-08-22T11:00:00.000Z');
  assert.deepEqual(events, ['intent:resolve']);
  assert.deepEqual(times, []);
});
