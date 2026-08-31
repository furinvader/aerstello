import * as harness from '../test-support/workflow-harness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { buildCanonicalRootPlan } from '../threads/canonical-roots.mjs';
import {
  adoptArchiveBatch,
  archiveBatchAdoptionReady,
} from './adoption.mjs';

const {
  assert,
  spawnSync,
  createHash,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  join,
  test,
  createRepository,
  git,
  writeFiles,
  createGitHubReviewWorkflow,
  GitHubWorkflowError,
  githubReviewConstants,
  readTopLevelComments,
  withGitHubRequestOwnerLock,
  buildGhGraphqlArgs,
  createDefaultArchiveStore,
  createDefaultGitAdapter,
  createDefaultGitHubClient,
  renderHumanStatus,
  runCli,
  terminateOnFatalArchiveCwd,
  usage,
  HEAD,
  OTHER_HEAD,
  ADVANCED_HEAD,
  PRIOR_INTEGRATION_HEAD,
  SELECTED_TASK_HEAD,
  AT,
  GITHUB_CLI_MODULE_URL,
  BOT,
  VIEWER,
  darwinArchiveRuntime,
  trackedArchiveFileSystem,
  assertTrackedArchiveDescriptorsClosed,
  STRUCTURAL_COMMENT_BODY,
  ALTERNATE_STRUCTURAL_COMMENT_BODY,
  PACKET_MIXED_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_STATE_SHA256,
  PACKET_MIXED_ARCHIVE_EVENTS_SHA256,
  PACKET_MIXED_ARCHIVE_STATE_BASE64,
  PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  PACKET_ARCHIVE_NAME,
  PACKET_ARCHIVE_STATE_SHA256,
  PACKET_ARCHIVE_EVENTS_SHA256,
  PACKET_ARCHIVE_STATE_BASE64,
  PACKET_ARCHIVE_EVENTS_BASE64,
  withDuplicateReviewedCommitAnchor,
  proof,
  stateFixture,
  readyState,
  requestEvidence,
  pendingState,
  completedState,
  tasklessReviewHeadDriftState,
  cleanReviewEntry,
  tasklessPendingReviewHeadDriftState,
  tasklessPendingDiscoveryHeadDriftState,
  canonicalReview,
  cleanIssueComment,
  issueCommentCompletedState,
  findingsState,
  rootComment,
  connection,
  fullValidationCheck,
  passedCiEvidence,
  FakeClient,
  fakeGit,
  fakeJournal,
  racingRequestJournal,
  fakeState,
  workflow,
  addThread,
  markerFor,
  priorIntent,
  ARCHIVE_REPLY_INTENT_AT,
  ARCHIVE_REPLY_AT,
  ARCHIVE_RESOLVE_INTENT_AT,
  ARCHIVE_PROOF_RESOLVED_AT,
  ARCHIVE_STATE_AT,
  ARCHIVE_EVENT_AT,
  ARCHIVED_TASK_ID,
  ARCHIVE_REMEDIATION_ID,
  PACKET_ARCHIVE_LIVE_TIMES,
  PACKET_UNRESOLVED_THREAD_IDS,
  PACKET_AGGREGATE_HEAD,
  PACKET_AGGREGATE_TASK_ID,
  PACKET_PORTABILITY_TASK_ID,
  PACKET_PORTABILITY_THREAD_ID,
  PACKET_MIXED_LIVE_TIMES,
  archivedBatchTask,
  archiveIntentEvent,
  immutableArchiveStore,
  archiveAdoptionFixture,
  replayArchive,
  archiveBootstrapFixture,
  packetArchiveAdoptionFixture,
  decodedPacketArchive,
  packetAggregateAdoptionFixture,
  integratedThreadState,
  integratedNonThreadState,
  nonActionableNonThreadState,
  completedThreadlessDriftState,
} = harness;

test('adoption owner repeats immutable and live proof before one ordinary checkpoint', async () => {
  const fixture = archiveAdoptionFixture();
  const live = await readLiveSnapshot(fixture.client, fixture.active);
  const { selected, selectedPlan } = buildCanonicalRootPlan(
    fixture.active, live, ARCHIVED_TASK_ID,
  );
  const archiveStore = immutableArchiveStore([fixture.archive]);
  let liveReads = 0;
  let currentChecks = 0;
  let ordinaryCheckpoints = 0;
  let archiveCheckpoints = 0;

  assert.equal(archiveBatchAdoptionReady(fixture.active, selected, selectedPlan), true);
  const result = await adoptArchiveBatch({
    state: fixture.active,
    live,
    taskId: ARCHIVED_TASK_ID,
    selectedTask: selected,
    selectedPlan,
    archiveStore,
    git: fakeGit(),
    clock: { now: () => AT },
    readLiveSnapshot: async (state) => {
      liveReads += 1;
      return readLiveSnapshot(fixture.client, state);
    },
    assertMutationReady: async () => {},
    assertCurrent: async () => { currentChecks += 1; },
    checkpointArchiveTaskCompletion: async () => {
      archiveCheckpoints += 1;
      throw new Error('ordinary archive must not use the dedicated aggregate checkpoint');
    },
    checkpointTaskCompletion: async ({ threadResolutionStatus }) => {
      ordinaryCheckpoints += 1;
      return {
        ...fixture.active,
        revision: fixture.active.revision + 1,
        threadResolutionStatus,
      };
    },
  });

  assert.equal(archiveStore.calls, 2);
  assert.equal(liveReads, 1);
  assert.equal(currentChecks, 1);
  assert.equal(ordinaryCheckpoints, 1);
  assert.equal(archiveCheckpoints, 0);
  assert.equal(result.stateRevision, fixture.active.revision + 1);
});

test('completed threadless refresh permits mapped new roots and enables journal-backed resolution recovery', async () => {
  const state = completedThreadlessDriftState();
  state.tasks[0].integratedCommitSha = PRIOR_INTEGRATION_HEAD;
  const recordedTask = {
    ...integratedThreadState(['thread:THREAD_OLD']).tasks[0],
    id: 'task-thread-old', fingerprint: 'fp-thread-old', status: 'completed', integratedCommitSha: HEAD,
  };
  const pendingTask = {
    ...integratedThreadState(['thread:THREAD_1']).tasks[0],
    id: 'task-thread-new', fingerprint: 'fp-thread-new', integratedCommitSha: SELECTED_TASK_HEAD,
  };
  state.tasks.push(recordedTask, pendingTask);
  state.threadResolutionStatus.threads = [{
    threadNodeId: 'THREAD_OLD', rootCommentNodeId: 'ROOT_THREAD_OLD', rootCommentDatabaseId: 42,
    taskIds: ['task-thread-old'], disposition: 'fixed', replyId: 'REPLY_OLD', replyUrl: 'https://x/old-reply',
    isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
  }];

  function recoveryClient() {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const oldReplyOperation = `reply:2:THREAD_OLD:${HEAD}`;
    addThread(client, { id: 'THREAD_OLD', resolved: true, replies: [{
      id: 'REPLY_OLD', databaseId: 901, url: 'https://x/old-reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_OLD' }, pullRequestReview: null,
      body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread-old: ${HEAD}\nValidation: prior validation.\n${markerFor(oldReplyOperation)}`,
    }] });
    const newReplyOperation = `reply:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
    addThread(client, { id: 'THREAD_1', resolved: true, replies: [{
      id: 'REPLY_NEW', databaseId: 902, url: 'https://x/new-reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: `Aerstello review resolution at ${PRIOR_INTEGRATION_HEAD}.\nTasks:\n- task-thread-new: ${SELECTED_TASK_HEAD}\nValidation: prior validation.\n${markerFor(newReplyOperation)}`,
    }] });
    return client;
  }

  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const driftedClient = recoveryClient();
  driftedClient.threads.find((thread) => thread.id === 'THREAD_OLD').isResolved = false;
  const drifted = workflow(state, driftedClient, { git });
  await assert.rejects(() => drifted.api.verifyResolve(2, ['threadless-completed']), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(drifted.state.calls.length, 0);
  assert.equal(driftedClient.events.length, 0);

  const client = recoveryClient();
  const replyOperation = `reply:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
  const resolveOperation = `resolve:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
  const journalEvents = [];
  const journal = fakeJournal(journalEvents, [
    priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation),
  ]);
  const lookupOperations = [];
  const lookupRecoveryIntent = journal.lookupIntent.bind(journal);
  journal.lookupIntent = async (operationId) => {
    lookupOperations.push(operationId);
    return lookupRecoveryIntent(operationId);
  };
  const setup = workflow(state, client, { git, journal, clock: { now: () => '2026-08-05T00:01:00Z' } });
  const refreshed = await setup.api.verifyResolve(2, ['threadless-completed']);
  assert.equal(refreshed.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(refreshed.threadResolutionStatus.threads, state.threadResolutionStatus.threads);
  assert.equal(refreshed.threadResolutionStatus.threadlessVerification.headSha, OTHER_HEAD);
  assert.equal(client.events.length, 0);
  const postRefreshState = structuredClone(setup.state.current);

  const missingPairClient = recoveryClient();
  const missingPair = workflow(postRefreshState, missingPairClient, {
    git, journal: fakeJournal([], [priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => missingPair.api.replyResolve(2, 'task-thread-new'), {
    code: 'RESOLUTION_PROOF_MISSING',
  });
  assert.equal(missingPairClient.events.length, 0);

  const reversedPairClient = recoveryClient();
  const reversedPair = workflow(postRefreshState, reversedPairClient, {
    git,
    journal: fakeJournal([], [
      priorIntent('reply', replyOperation, '2026-08-05T00:00:01Z'),
      priorIntent('resolve', resolveOperation, AT),
    ]),
  });
  await assert.rejects(() => reversedPair.api.replyResolve(2, 'task-thread-new'), {
    code: 'RESOLUTION_PROOF_MISSING',
  });
  assert.equal(reversedPairClient.events.length, 0);

  const extraReplyClient = recoveryClient();
  extraReplyClient.threadComments.get('THREAD_1').push({
    id: 'REPLY_EXTRA', databaseId: 903, url: 'https://x/extra', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `extra\n${markerFor(`reply:2:THREAD_1:${HEAD}`)}`,
  });
  const extraReply = workflow(postRefreshState, extraReplyClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => extraReply.api.replyResolve(2, 'task-thread-new'), { code: 'REPLY_AMBIGUOUS' });
  assert.equal(extraReplyClient.events.length, 0);

  const resolutionFlipClient = recoveryClient();
  const resolutionFlipGraphql = resolutionFlipClient.graphql.bind(resolutionFlipClient);
  let threadSnapshots = 0;
  resolutionFlipClient.graphql = async (input) => {
    if (input.name === 'PullRequestThreads' && input.variables.cursor === null
        && ++threadSnapshots === 2) {
      resolutionFlipClient.threads.find((thread) => thread.id === 'THREAD_1').isResolved = false;
    }
    return resolutionFlipGraphql(input);
  };
  const resolutionFlip = workflow(postRefreshState, resolutionFlipClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => resolutionFlip.api.replyResolve(2, 'task-thread-new'), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(resolutionFlipClient.events.length, 0);

  const headDriftClient = recoveryClient();
  const headDriftGraphql = headDriftClient.graphql.bind(headDriftClient);
  let metadataSnapshots = 0;
  headDriftClient.graphql = async (input) => {
    if (input.name === 'PullRequestMetadata' && ++metadataSnapshots === 2) {
      headDriftClient.metadata.headRefOid = HEAD;
    }
    return headDriftGraphql(input);
  };
  const headDrift = workflow(postRefreshState, headDriftClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => headDrift.api.replyResolve(2, 'task-thread-new'), { code: 'MUTATION_NOT_READY' });
  assert.equal(headDriftClient.events.length, 0);

  const stateRaceClient = recoveryClient();
  const stateRaceJournal = fakeJournal([], [
    priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation),
  ]);
  const lookupIntent = stateRaceJournal.lookupIntent.bind(stateRaceJournal);
  let stateRace;
  let revisionAdvanced = false;
  stateRaceJournal.lookupIntent = async (operationId) => {
    const intent = await lookupIntent(operationId);
    if (!revisionAdvanced) {
      revisionAdvanced = true;
      await stateRace.state.checkpointTaskCompletion({
        prNumber: 2,
        expectedRevision: stateRace.state.current.revision,
        threadResolutionStatus: stateRace.state.current.threadResolutionStatus,
        verifiedLocalTaskIds: [],
      });
    }
    return intent;
  };
  stateRace = workflow(postRefreshState, stateRaceClient, { git, journal: stateRaceJournal });
  await assert.rejects(() => stateRace.api.replyResolve(2, 'task-thread-new'), {
    code: 'STATE_REVISION_CHANGED',
  });
  assert.equal(stateRaceClient.events.length, 0);

  const resolved = await setup.api.replyResolve(2, 'task-thread-new');
  assert.equal(resolved.threadResolutionStatus.status, 'passed');
  assert.deepEqual(
    resolved.threadResolutionStatus.threads.map((thread) => thread.threadNodeId),
    ['THREAD_1', 'THREAD_OLD'],
  );
  assert.equal(resolved.threadResolutionStatus.threadlessVerification.headSha, OTHER_HEAD);
  assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  assert.deepEqual(lookupOperations, [replyOperation, resolveOperation]);
  assert.deepEqual(journalEvents, []);
});

test('verify-resolve bootstraps only the exact archive-adoption topology before state-only batch adoption', async () => {
  const fixture = archiveBootstrapFixture();
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fixture.journal,
  });
  const pristine = structuredClone(fixture.active.threadResolutionStatus);

  const verified = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);

  assert.equal(archiveStore.calls, 0, 'bootstrap does not read archive evidence');
  assert.equal(setup.state.calls.length, 1);
  assert.deepEqual(setup.state.current.tasks.map((task) => [task.id, task.status]), [
    [ARCHIVED_TASK_ID, 'not-applicable'],
    [ARCHIVE_REMEDIATION_ID, 'completed'],
    ['current-thread-fix', 'integrated'],
  ]);
  assert.deepEqual(verified.threadResolutionStatus, {
    ...pristine,
    threadlessVerification: {
      status: 'passed', headSha: HEAD, taskIds: [ARCHIVE_REMEDIATION_ID], updatedAt: AT,
    },
  });
  for (const key of ['status', 'headSha', 'threads', 'updatedAt', 'localVerification']) {
    assert.deepEqual(verified.threadResolutionStatus[key], pristine[key], key);
  }
  assert.deepEqual(setup.state.calls[0].input.verifiedLocalTaskIds, []);
  assert.ok(fixture.client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 6);
  assert.equal(
    fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(fixture.client.events, []);

  const revision = setup.state.current.revision;
  const checkpoints = setup.state.calls.length;
  const guardedReads = fixture.client.calls.filter((call) => call.name === 'PullRequestThreads').length;
  const retried = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
  assert.equal(retried.stateRevision, revision);
  assert.equal(setup.state.calls.length, checkpoints);
  assert.equal(archiveStore.calls, 0);
  assert.ok(
    fixture.client.calls.filter((call) => call.name === 'PullRequestThreads').length >= guardedReads + 6,
  );

  const adopted = await setup.api.replyResolve(2, ARCHIVED_TASK_ID);
  assert.equal(archiveStore.calls, 2);
  assert.equal(setup.state.calls.length, 2);
  assert.equal(adopted.threadResolutionStatus.status, 'failed');
  assert.deepEqual(adopted.threadResolutionStatus.threadlessVerification,
    verified.threadResolutionStatus.threadlessVerification);
  assert.deepEqual(
    adopted.threadResolutionStatus.threads.filter((thread) => thread.isResolved)
      .map((thread) => thread.threadNodeId),
    ['THREAD_ARCHIVE_A', 'THREAD_ARCHIVE_B'],
  );
  assert.deepEqual(
    adopted.threadResolutionStatus.threads.filter((thread) => !thread.isResolved)
      .map((thread) => thread.threadNodeId),
    ['THREAD_CURRENT'],
  );
  assert.equal(
    fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(fixture.client.events, []);
});

test('local verifier bootstraps archive adoption through only its closed archive checkpoint lane', async () => {
  const fixture = archiveBootstrapFixture();
  const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
  remediation.sourceType = 'local';
  remediation.sourceIds = ['orchestrator:integration-verifier'];
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fixture.journal,
  });
  const pristine = structuredClone(fixture.active.threadResolutionStatus);

  const verified = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);

  assert.equal(archiveStore.calls, 0);
  assert.equal(setup.state.calls.length, 1);
  assert.equal(setup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(setup.state.calls[0].input.verifierBootstrapEnvelope.proofLane, 'localVerification');
  assert.equal(setup.state.calls[0].input.verifierBootstrapEnvelope.taskId, ARCHIVE_REMEDIATION_ID);
  assert.equal(setup.state.calls[0].input.verifierBootstrapEnvelope.archiveTaskId, ARCHIVED_TASK_ID);
  assert.equal(setup.state.calls[0].input.verifierBootstrapEnvelope.roots.length, 3);
  assert.deepEqual(verified.threadResolutionStatus.threadlessVerification,
    pristine.threadlessVerification);
  assert.deepEqual(verified.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: HEAD, taskIds: [ARCHIVE_REMEDIATION_ID], updatedAt: AT,
  });
  for (const key of ['status', 'headSha', 'threads', 'updatedAt']) {
    assert.deepEqual(verified.threadResolutionStatus[key], pristine[key], key);
  }
  assert.equal(fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(fixture.client.events, []);

  const checkpoints = setup.state.calls.length;
  const retry = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
  assert.equal(retry.stateRevision, verified.stateRevision);
  assert.equal(setup.state.calls.length, checkpoints);
  assert.equal(archiveStore.calls, 0);

  const adopted = await setup.api.replyResolve(2, ARCHIVED_TASK_ID);
  assert.equal(archiveStore.calls, 2);
  assert.equal(setup.state.calls.length, 2);
  assert.deepEqual(adopted.threadResolutionStatus.localVerification,
    verified.threadResolutionStatus.localVerification);
  assert.deepEqual(adopted.threadResolutionStatus.threadlessVerification,
    pristine.threadlessVerification);
  assert.deepEqual(fixture.client.events, []);
});

test('local archive bootstrap rejects mixed proof lanes and ambiguous cross-source remediations', async () => {
  for (const [label, mutate] of [
    ['mixed lanes', (fixture) => {
      fixture.active.threadResolutionStatus.threadlessVerification = {
        status: 'passed', headSha: HEAD, taskIds: ['foreign-threadless'], updatedAt: AT,
      };
    }],
    ['cross-source remediation', (fixture) => {
      const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
      fixture.active.tasks.push({
        ...structuredClone(remediation), id: 'foreign-threadless',
        sourceType: 'github-threadless', sourceIds: ['review:foreign-threadless'],
        fingerprint: 'foreign-threadless-fingerprint',
      });
    }],
  ]) {
    const fixture = archiveBootstrapFixture();
    const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
    remediation.sourceType = 'local';
    remediation.sourceIds = ['orchestrator:integration-verifier'];
    mutate(fixture);
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(
      () => setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(archiveStore.calls, 0, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive-adoption verifier bootstrap retries a discussion-only multi-root declaration', async () => {
  const fixture = archiveBootstrapFixture();
  fixture.active.tasks.find((task) => task.id === ARCHIVED_TASK_ID).sourceIds = [
    'discussion:510', 'discussion:511',
  ];
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fixture.journal,
  });

  await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const proof = structuredClone(setup.state.current.threadResolutionStatus);
  const guardedReads = fixture.client.calls.filter(
    (call) => call.name === 'PullRequestThreads',
  ).length;

  const retry = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);

  assert.equal(retry.stateRevision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.deepEqual(retry.threadResolutionStatus, proof);
  assert.ok(fixture.client.calls.filter(
    (call) => call.name === 'PullRequestThreads',
  ).length >= guardedReads + 6);
  assert.equal(archiveStore.calls, 0);
  assert.deepEqual(fixture.client.events, []);
});

test('archive-adoption verifier bootstrap retries mixed canonical root aliases', async () => {
  const fixture = archiveBootstrapFixture();
  fixture.active.tasks.find((task) => task.id === ARCHIVED_TASK_ID).sourceIds = [
    'thread:THREAD_ARCHIVE_A', 'discussion:511',
  ];
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fixture.journal,
  });

  await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const proof = structuredClone(setup.state.current.threadResolutionStatus);

  const retry = await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);

  assert.equal(retry.stateRevision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.deepEqual(retry.threadResolutionStatus, proof);
  assert.equal(archiveStore.calls, 0);
  assert.deepEqual(fixture.client.events, []);
});

test('completed retry counts thread and discussion aliases for one root only once', async () => {
  const state = completedThreadlessDriftState();
  state.threadResolutionStatus.threadlessVerification.headSha = OTHER_HEAD;
  state.threadResolutionStatus.localVerification = proof('not-run').localVerification;
  state.tasks.push({
    ...archivedBatchTask(),
    sourceIds: ['thread:THREAD_ARCHIVE_A', 'discussion:510'],
  });
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  addThread(client, {
    id: 'THREAD_ARCHIVE_A', resolved: true,
    root: rootComment('THREAD_ARCHIVE_A', { databaseId: 510 }),
  });
  const journal = {
    async lookupIntent() { throw new Error('ordinary retry must not read the mutation journal'); },
    async ensureIntent() { throw new Error('ordinary retry must not write the mutation journal'); },
  };
  const setup = workflow(state, client, {
    journal,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
  });

  const retry = await setup.api.verifyResolve(2, ['threadless-completed']);

  assert.equal(retry.stateRevision, state.revision);
  assert.equal(setup.state.calls.length, 0);
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 2);
  assert.deepEqual(client.events, []);
});

test('canonical multi-root retry rejects discussion-only and mixed-alias current-proof drift', async () => {
  const cases = [
    {
      label: 'discussion-only preflight drift',
      sourceIds: ['discussion:510', 'discussion:511'],
      code: 'TASK_NOT_READY',
      drift(fixture) {
        fixture.client.threads.find((thread) => thread.id === 'THREAD_ARCHIVE_B').isResolved = false;
      },
    },
    {
      label: 'mixed-alias second-snapshot drift',
      sourceIds: ['thread:THREAD_ARCHIVE_A', 'discussion:511'],
      code: 'THREAD_PROOF_STALE',
      drift(fixture) {
        const graphql = fixture.client.graphql.bind(fixture.client);
        let metadataReads = 0;
        fixture.client.graphql = async (input) => {
          if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
            fixture.client.threads.find(
              (thread) => thread.id === 'THREAD_ARCHIVE_B',
            ).isResolved = false;
          }
          return graphql(input);
        };
      },
    },
  ];

  for (const { label, sourceIds, code, drift } of cases) {
    const fixture = archiveBootstrapFixture();
    fixture.active.tasks.find((task) => task.id === ARCHIVED_TASK_ID).sourceIds = sourceIds;
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
    drift(fixture);

    await assert.rejects(
      () => setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]),
      { code },
      label,
    );
    assert.equal(setup.state.calls.length, 1, label);
    assert.equal(archiveStore.calls, 0, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive-adoption verifier bootstrap rejects inexact candidate and root topologies without writes', async () => {
  const cases = [
    ['unmapped root', (fixture) => {
      addThread(fixture.client, {
        id: 'THREAD_UNMAPPED', root: rootComment('THREAD_UNMAPPED', { databaseId: 777 }),
      });
    }],
    ['shared root', (fixture) => {
      const current = fixture.active.tasks.find((task) => task.id === 'current-thread-fix');
      fixture.active.tasks.push({
        ...structuredClone(current), id: 'shared-current-fix', fingerprint: 'fp-shared-current-fix',
      });
    }],
    ['singleton archive source', (fixture) => {
      fixture.active.tasks.find((task) => task.id === ARCHIVED_TASK_ID).sourceIds = ['thread:THREAD_ARCHIVE_A'];
      fixture.client.threads = fixture.client.threads.filter((thread) => thread.id !== 'THREAD_ARCHIVE_B');
      fixture.client.threadComments.delete('THREAD_ARCHIVE_B');
    }],
    ['additional remediation candidate', (fixture) => {
      const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
      fixture.active.tasks.push({
        ...structuredClone(remediation), id: 'archive-adoption-remediation-extra',
        sourceIds: ['orchestrator:archive-adoption-extra'],
        fingerprint: 'fp-archive-adoption-remediation-extra',
      });
    }],
    ['extra resolved root', (fixture) => {
      fixture.client.threads.find((thread) => thread.id === 'THREAD_CURRENT').isResolved = true;
    }],
    ['wrong selected disposition', (fixture) => {
      const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
      remediation.disposition = 'already-fixed';
      remediation.status = 'not-applicable';
      remediation.integratedCommitSha = null;
    }],
  ];

  for (const [label, mutate] of cases) {
    const fixture = archiveBootstrapFixture();
    mutate(fixture);
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(
      () => setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(archiveStore.calls, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive-adoption verifier bootstrap rejects non-pristine aggregate, threadless, or local proof', async () => {
  const cases = [
    ['aggregate proof', (fixture) => {
      fixture.active.threadResolutionStatus = proof();
    }],
    ['threadless proof', (fixture) => {
      const prior = {
        ...fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID),
        id: 'prior-threadless', sourceIds: ['review:prior-threadless'],
        fingerprint: 'fp-prior-threadless', status: 'completed',
      };
      fixture.active.tasks.push(prior);
      fixture.active.threadResolutionStatus.threadlessVerification = {
        status: 'passed', headSha: HEAD, taskIds: [prior.id], updatedAt: AT,
      };
    }],
    ['local proof', (fixture) => {
      const local = {
        ...integratedNonThreadState('local', 'prior-local').tasks[0], status: 'completed',
      };
      fixture.active.tasks.push(local);
      fixture.active.threadResolutionStatus.localVerification = {
        status: 'passed', headSha: HEAD, taskIds: [local.id], updatedAt: AT,
      };
    }],
  ];

  for (const [label, mutate] of cases) {
    const fixture = archiveBootstrapFixture();
    mutate(fixture);
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(
      () => setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(archiveStore.calls, 0, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive-adoption verifier bootstrap rejects second-snapshot root, head, and revision drift', async () => {
  for (const [label, race, code] of [
    ['root drift', (fixture) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          fixture.client.threads.find((thread) => thread.id === 'THREAD_CURRENT').isResolved = true;
        }
        return graphql(input);
      };
    }, 'THREAD_PROOF_STALE'],
    ['head drift', (fixture) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          fixture.client.metadata.headRefOid = OTHER_HEAD;
        }
        return graphql(input);
      };
    }, 'MUTATION_NOT_READY'],
    ['revision drift', (fixture, setupRef) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          setupRef.current.state.advanceRevisionForTest();
        }
        return graphql(input);
      };
    }, 'STATE_REVISION_CHANGED'],
  ]) {
    const fixture = archiveBootstrapFixture();
    const setupRef = { current: null };
    race(fixture, setupRef);
    const archiveStore = immutableArchiveStore([fixture.archive]);
    setupRef.current = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(
      () => setupRef.current.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]),
      { code },
      label,
    );
    assert.equal(setupRef.current.state.calls.length, 0, label);
    assert.equal(archiveStore.calls, 0, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive-adoption verifier bootstrap never weakens later archive evidence gates', async () => {
  const cases = [
    ['missing archive', (fixture) => ({ records: [] })],
    ['conflicting archive authority', (fixture) => {
      const conflicting = {
        ...structuredClone(fixture.archive), archiveId: 'pr-2-2026-08-05T00-02-00-000Z',
      };
      const intent = conflicting.events.find((event) => event.details?.type === 'reply');
      intent.details.at = '2026-08-04T23:58:31.000Z';
      intent.at = '2026-08-04T23:58:31.001Z';
      return { records: [fixture.archive, conflicting] };
    }],
    ['tampered archive', (fixture) => {
      const archive = structuredClone(fixture.archive);
      archive.state.threadResolutionStatus.threads[0].replyUrl = 'https://github.com/tampered';
      return { records: [archive] };
    }],
    ['non-ancestral archive', (fixture) => ({
      records: [fixture.archive],
      git: fakeGit({ isAncestor: async (ancestor) => ancestor !== OTHER_HEAD }),
    })],
    ['raced archive', (fixture) => ({
      records: [fixture.archive],
      onList(calls) {
        if (calls === 2) fixture.archive.events[0].at = AT;
      },
    })],
  ];

  for (const [label, configure] of cases) {
    const fixture = archiveBootstrapFixture();
    const configured = configure(fixture);
    const archiveStore = immutableArchiveStore(configured.records, configured.onList);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal, git: configured.git,
    });
    await setup.api.verifyResolve(2, [ARCHIVE_REMEDIATION_ID]);
    assert.equal(setup.state.calls.length, 1, label);
    assert.equal(archiveStore.calls, 0, label);

    await assert.rejects(
      () => setup.api.replyResolve(2, ARCHIVED_TASK_ID),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 1, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('reply-resolve attests one exact GitHub-thread aggregate with zero mutation', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME,
    PACKET_MIXED_ARCHIVE_STATE_BASE64,
    PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  const localImplementation = fixture.remediation;
  localImplementation.status = 'integrated';
  localImplementation.sourceType = 'local';
  localImplementation.sourceIds = ['orchestrator:integration-verifier'];
  const githubRemediation = fixture.active.tasks.find(
    (task) => task.id === PACKET_PORTABILITY_TASK_ID,
  );
  githubRemediation.disposition = 'actionable';
  githubRemediation.status = 'integrated';
  githubRemediation.integratedCommitSha = PACKET_AGGREGATE_HEAD;
  const archiveStore = immutableArchiveStore([oldArchive, mixedArchive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fakeJournal(fixture.client.events),
    git: fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    }),
  });

  process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION = JSON.stringify({
    schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean',
    headSha: PACKET_AGGREGATE_HEAD, stateRevision: fixture.active.revision,
    scopeAuthorityDigest: fixture.active.scopeControl.authorityDigest,
    scopeJournalDigest: fixture.active.scopeControl.journalDigest, assertedAt: AT,
  });
  let result;
  try {
    result = await setup.api.replyResolve(fixture.active.prNumber, PACKET_AGGREGATE_TASK_ID);
  } finally {
    delete process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
  }

  assert.equal(archiveStore.calls, 2);
  assert.equal(setup.state.calls.length, 1);
  assert.equal(setup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  const envelope = setup.state.calls[0].input.archiveImportEnvelope;
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.attestation.verifierAssertion.verifierId, 'integration_verifier');
  assert.equal(envelope.attestation.verifierAssertion.status, 'clean');
  assert.deepEqual(envelope.attestation.remediations, [{
    taskId: PACKET_PORTABILITY_TASK_ID, integratedCommitSha: PACKET_AGGREGATE_HEAD,
  }]);
  assert.deepEqual(envelope.attestation.scope.classifications.map((item) => item.taskId), [
    localImplementation.id, PACKET_AGGREGATE_TASK_ID, PACKET_PORTABILITY_TASK_ID,
  ]);
  assert.equal(envelope.attestation.roots.length, 10);
  assert.deepEqual(
    envelope.attestation.roots.filter((root) => !root.isResolved).map((root) => root.taskId),
    [PACKET_PORTABILITY_TASK_ID],
  );
  assert.equal(result.threadResolutionStatus.status, 'failed');
  assert.deepEqual(result.threadResolutionStatus.localVerification, proof('not-run').localVerification);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification,
    proof('not-run').threadlessVerification);
  assert.deepEqual(setup.state.current.tasks.map((task) => [task.id, task.status]), [
    [PACKET_AGGREGATE_TASK_ID, 'completed'],
    [localImplementation.id, 'integrated'],
    [PACKET_PORTABILITY_TASK_ID, 'integrated'],
  ]);
  assert.equal(fixture.client.calls.some((call) => [
    'AddThreadReply', 'ResolveThread',
  ].includes(call.name)), false);
  assert.deepEqual(fixture.client.events, []);

  const retry = await setup.api.replyResolve(fixture.active.prNumber, PACKET_AGGREGATE_TASK_ID);
  assert.equal(retry.stateRevision, result.stateRevision);
  assert.equal(setup.state.calls.length, 1, 'fresh exact retry is a protected no-op');

  await setup.api.verifyResolve(fixture.active.prNumber, [localImplementation.id]);
  assert.deepEqual(setup.state.current.tasks.map((task) => [task.id, task.status]), [
    [PACKET_AGGREGATE_TASK_ID, 'completed'],
    [localImplementation.id, 'completed'],
    [PACKET_PORTABILITY_TASK_ID, 'integrated'],
  ]);
  await setup.api.replyResolve(fixture.active.prNumber, PACKET_PORTABILITY_TASK_ID);
  assert.deepEqual(setup.state.current.tasks.map((task) => [task.id, task.status]), [
    [PACKET_AGGREGATE_TASK_ID, 'completed'],
    [localImplementation.id, 'completed'],
    [PACKET_PORTABILITY_TASK_ID, 'completed'],
  ]);
  assert.deepEqual(fixture.client.events, [
    'intent:reply', 'mutation:AddThreadReply', 'intent:resolve', 'mutation:ResolveThread',
  ]);
});

test('GitHub-thread attestation rejects second-snapshot archive, topology, head, scope, revision, and ancestry drift', async () => {
  for (const label of ['archive', 'topology', 'head', 'scope', 'revision', 'ancestry']) {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME,
      PACKET_MIXED_ARCHIVE_STATE_BASE64,
      PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.remediation.sourceType = 'local';
    fixture.remediation.sourceIds = ['orchestrator:integration-verifier'];
    const githubTask = fixture.active.tasks.find(
      (task) => task.id === PACKET_PORTABILITY_TASK_ID,
    );
    githubTask.disposition = 'actionable';
    githubTask.status = 'integrated';
    githubTask.integratedCommitSha = PACKET_AGGREGATE_HEAD;
    const records = [oldArchive, mixedArchive];
    let setup;
    let scopeSnapshot;
    const archiveStore = immutableArchiveStore(records, (calls) => {
      if (calls !== 2) return;
      if (label === 'archive') records[1].events[0].at = AT;
      if (label === 'topology') fixture.client.threads.find(
        (thread) => thread.id === PACKET_PORTABILITY_THREAD_ID,
      ).isResolved = true;
      if (label === 'head') fixture.client.metadata.headRefOid = HEAD;
      if (label === 'scope') setup.state.setScopeStatusForTest({
        ...scopeSnapshot,
        journal: { ...scopeSnapshot.journal, digest: `sha256:${'f'.repeat(64)}` },
      });
      if (label === 'revision') setup.state.advanceRevisionForTest();
    });
    let sameHeadAncestryChecks = 0;
    setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fakeJournal(fixture.client.events),
      git: fakeGit({
        snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
        pushedHead: async () => PACKET_AGGREGATE_HEAD,
        isAncestor: async (ancestor, descendant) => {
          if (ancestor === PACKET_AGGREGATE_HEAD && descendant === PACKET_AGGREGATE_HEAD) {
            sameHeadAncestryChecks += 1;
            if (label === 'ancestry' && sameHeadAncestryChecks >= 3) return false;
          }
          return true;
        },
      }),
    });
    scopeSnapshot = await setup.state.scopeStatus();
    process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION = JSON.stringify({
      schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean',
      headSha: PACKET_AGGREGATE_HEAD, stateRevision: fixture.active.revision,
      scopeAuthorityDigest: fixture.active.scopeControl.authorityDigest,
      scopeJournalDigest: fixture.active.scopeControl.journalDigest, assertedAt: AT,
    });
    try {
      await assert.rejects(
        () => setup.api.replyResolve(fixture.active.prNumber, PACKET_AGGREGATE_TASK_ID),
        GitHubWorkflowError,
        label,
      );
    } finally {
      delete process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
    }
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(fixture.client.calls.some((call) => [
      'AddThreadReply', 'ResolveThread',
    ].includes(call.name)), false, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('reply-resolve adopts one exact archived resolved-root batch with zero GitHub or journal writes', async () => {
  const fixture = archiveAdoptionFixture();
  const archiveStore = immutableArchiveStore([fixture.archive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore, journal: fixture.journal,
  });
  const originalThreadless = structuredClone(fixture.active.threadResolutionStatus.threadlessVerification);

  const result = await setup.api.replyResolve(2, ARCHIVED_TASK_ID);

  assert.equal(archiveStore.calls, 2);
  assert.equal(setup.state.calls.length, 1);
  assert.equal(setup.state.calls[0].name, 'checkpointTaskCompletion', 'valid ordinary carrier keeps the legacy checkpoint');
  assert.equal(result.threadResolutionStatus.status, 'failed');
  assert.equal(result.threadResolutionStatus.headSha, HEAD);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, originalThreadless);
  assert.deepEqual(
    setup.state.current.tasks.map((task) => [task.id, task.status]),
    [
      [ARCHIVED_TASK_ID, 'completed'],
      [ARCHIVE_REMEDIATION_ID, 'completed'],
      ['current-thread-fix', 'integrated'],
    ],
  );
  assert.deepEqual(
    result.threadResolutionStatus.threads.filter((thread) => thread.isResolved)
      .map((thread) => [thread.threadNodeId, thread.observedHeadSha]),
    [['THREAD_ARCHIVE_A', OTHER_HEAD], ['THREAD_ARCHIVE_B', OTHER_HEAD]],
  );
  assert.deepEqual(
    result.threadResolutionStatus.threads.filter((thread) => !thread.isResolved)
      .map((thread) => thread.threadNodeId),
    ['THREAD_CURRENT'],
  );
  assert.ok(fixture.client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 6);
  assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  assert.deepEqual(fixture.client.events, []);

  const archiveReads = archiveStore.calls;
  await setup.api.replyResolve(2, ARCHIVED_TASK_ID);
  assert.equal(archiveStore.calls, archiveReads, 'retry uses ordinary recorded proof instead of importing again');
  assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  assert.deepEqual(fixture.client.events, []);
});

test('bootstrap then reply-resolve adopts five byte-faithful Wc8 roots beside three unresolved ahn roots', async () => {
  const cwd = createRepository();
  try {
    const stateBytes = Buffer.from(PACKET_ARCHIVE_STATE_BASE64, 'base64');
    const eventBytes = Buffer.from(PACKET_ARCHIVE_EVENTS_BASE64, 'base64');
    assert.equal(createHash('sha256').update(stateBytes).digest('hex'), PACKET_ARCHIVE_STATE_SHA256);
    assert.equal(createHash('sha256').update(eventBytes).digest('hex'), PACKET_ARCHIVE_EVENTS_SHA256);
    const archiveDirectory = `.git/codex/pr-review/archive/${PACKET_ARCHIVE_NAME}`;
    writeFiles(cwd, {
      [`${archiveDirectory}/state.json`]: stateBytes,
      [`${archiveDirectory}/events.ndjson`]: eventBytes,
    });
    const defaultStore = createDefaultArchiveStore(cwd);
    const loaded = await defaultStore.list(35);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].archiveId, PACKET_ARCHIVE_NAME);
    const fixture = packetArchiveAdoptionFixture(loaded[0], {
      bootstrap: true,
      unresolvedThreadIds: PACKET_UNRESOLVED_THREAD_IDS,
    });
    const exactDistinctTimes = fixture.proofs.slice(1).map((proofRow) => {
      const resolveIntent = loaded[0].events.find((event) => (
        event.details?.operationId === `resolve:35:${proofRow.threadNodeId}:${proofRow.observedHeadSha}`
      ));
      return [proofRow.threadNodeId, resolveIntent.details.at, proofRow.resolvedAt];
    });
    assert.deepEqual(exactDistinctTimes, [
      ['PRRT_kwDOTqOdrM6aWc8k', '2026-08-19T15:32:17.575Z', '2026-08-19T15:32:29.007Z'],
      ['PRRT_kwDOTqOdrM6aWc8m', '2026-08-19T15:33:00.609Z', '2026-08-19T15:33:13.694Z'],
      ['PRRT_kwDOTqOdrM6aWc8q', '2026-08-19T15:33:44.118Z', '2026-08-19T15:33:56.008Z'],
      ['PRRT_kwDOTqOdrM6aWc8t', '2026-08-19T15:34:31.724Z', '2026-08-19T15:34:46.414Z'],
    ]);
    const intentTimeProof = fixture.proofs[0];
    const intentTimeResolveEvent = loaded[0].events.find((event) => (
      event.details?.operationId
        === `resolve:35:${intentTimeProof.threadNodeId}:${intentTimeProof.observedHeadSha}`
    ));
    assert.deepEqual(
      [intentTimeResolveEvent.details.at, intentTimeResolveEvent.at, intentTimeProof.resolvedAt],
      ['2026-08-19T15:31:34.892Z', '2026-08-19T15:31:34.897Z', '2026-08-19T15:31:34.892Z'],
      'intent-time recovery proof may precede its journal envelope by exact persistence latency',
    );
    let archiveReads = 0;
    const archiveStore = {
      async list(prNumber) {
        archiveReads += 1;
        return defaultStore.list(prNumber);
      },
    };
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
      clock: { now: () => '2026-08-19T16:40:00.000Z' },
    });
    const pristineAggregate = structuredClone(fixture.active.threadResolutionStatus);

    const verified = await setup.api.verifyResolve(35, [fixture.remediation.id]);

    const singletonThreadlessProof = {
      status: 'passed', headSha: HEAD, taskIds: [fixture.remediation.id],
      updatedAt: '2026-08-19T16:40:00.000Z',
    };
    assert.equal(archiveReads, 0, 'bootstrap does not read the byte-faithful archive');
    assert.equal(setup.state.calls.length, 1);
    assert.deepEqual(verified.threadResolutionStatus, {
      ...pristineAggregate,
      threadlessVerification: singletonThreadlessProof,
    }, 'bootstrap preserves the pristine aggregate and changes only singleton threadless proof');

    const result = await setup.api.replyResolve(35, fixture.archivedTask.id);

    assert.equal(archiveReads, 2);
    assert.equal(setup.state.calls.length, 2, 'bootstrap and adoption make exactly two checkpoints');
    assert.equal(result.threadResolutionStatus.status, 'failed');
    assert.equal(result.threadResolutionStatus.headSha, HEAD);
    assert.deepEqual(
      result.threadResolutionStatus.threadlessVerification,
      singletonThreadlessProof,
      'adoption preserves singleton threadless proof',
    );
    assert.deepEqual(
      result.threadResolutionStatus.threads.filter((proofRow) => proofRow.isResolved)
        .map((proofRow) => [proofRow.threadNodeId, proofRow.resolvedAt]),
      fixture.proofs.map((proofRow) => [proofRow.threadNodeId, proofRow.resolvedAt]),
      'adoption resolves exactly the five Wc8 roots with their durable timestamps',
    );
    assert.deepEqual(
      result.threadResolutionStatus.threads.filter((proofRow) => !proofRow.isResolved)
        .map((proofRow) => [
          proofRow.threadNodeId, proofRow.observedHeadSha, proofRow.replyId, proofRow.resolvedAt,
        ]),
      PACKET_UNRESOLVED_THREAD_IDS.map((threadId) => [threadId, HEAD, null, null]),
      'adoption retains exactly the three ahn roots as unresolved current-HEAD work',
    );
    assert.deepEqual(
      setup.state.current.tasks.map((task) => [task.id, task.status]),
      [
        [fixture.archivedTask.id, 'completed'],
        [fixture.remediation.id, 'completed'],
        ['pr-review-worker-commit-delta-integrity-r1', 'integrated'],
      ],
    );
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
    );
    assert.deepEqual(fixture.client.events, []);
    assert.deepEqual(readFileSync(join(cwd, archiveDirectory, 'state.json')), stateBytes);
    assert.deepEqual(readFileSync(join(cwd, archiveDirectory, 'events.ndjson')), eventBytes);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archive batch adoption accepts one canonical lineage across replay generations and equivalent origins', async () => {
  const cases = [
    ['one replay', (fixture) => [
      fixture.archive,
      replayArchive(fixture.archive),
    ]],
    ['multiple replay generations', (fixture) => [
      replayArchive(fixture.archive, {
        archiveId: 'pr-2-2026-08-05T00-03-00-000Z',
        stateAt: '2026-08-05T00:03:00.000Z',
        terminalAt: '2026-08-05T00:03:00.010Z',
      }),
      fixture.archive,
      replayArchive(fixture.archive),
    ]],
    ['equivalent complete origins', (fixture) => [
      { ...structuredClone(fixture.archive), archiveId: 'pr-2-2026-08-05T00-02-00-000Z' },
      fixture.archive,
    ]],
  ];

  for (const [label, recordsFor] of cases) {
    const fixture = archiveAdoptionFixture();
    const records = recordsFor(fixture);
    const originalRecords = structuredClone(records);
    let archiveReads = 0;
    const archiveStore = {
      async list() {
        archiveReads += 1;
        const order = archiveReads % 2 === 1 ? records : [...records].reverse();
        return structuredClone(order);
      },
    };
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });

    const result = await setup.api.replyResolve(2, ARCHIVED_TASK_ID);

    assert.equal(archiveReads, 2, label);
    assert.equal(setup.state.calls.length, 1, label);
    assert.equal(
      result.threadResolutionStatus.threads.filter((thread) => thread.isResolved).length,
      2,
      label,
    );
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
    assert.deepEqual(records, originalRecords, `${label} archive carriers remain immutable`);
  }
});

test('byte-faithful PR35 5+3+1 aggregate adoption retains nine roots before ordinary portability resolution', async () => {
  const oldStateBytes = Buffer.from(PACKET_ARCHIVE_STATE_BASE64, 'base64');
  const oldEventBytes = Buffer.from(PACKET_ARCHIVE_EVENTS_BASE64, 'base64');
  const mixedStateBytes = Buffer.from(PACKET_MIXED_ARCHIVE_STATE_BASE64, 'base64');
  const mixedEventBytes = Buffer.from(PACKET_MIXED_ARCHIVE_EVENTS_BASE64, 'base64');
  assert.equal(createHash('sha256').update(oldStateBytes).digest('hex'), PACKET_ARCHIVE_STATE_SHA256);
  assert.equal(createHash('sha256').update(oldEventBytes).digest('hex'), PACKET_ARCHIVE_EVENTS_SHA256);
  assert.equal(createHash('sha256').update(mixedStateBytes).digest('hex'), PACKET_MIXED_ARCHIVE_STATE_SHA256);
  assert.equal(createHash('sha256').update(mixedEventBytes).digest('hex'), PACKET_MIXED_ARCHIVE_EVENTS_SHA256);
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  let archiveReads = 0;
  const archiveStore = {
    async list() {
      archiveReads += 1;
      return structuredClone(archiveReads % 2 === 1
        ? [mixedArchive, oldArchive] : [oldArchive, mixedArchive]);
    },
  };
  const ancestry = [];
  const gitAdapter = fakeGit({
    snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
    pushedHead: async () => PACKET_AGGREGATE_HEAD,
    isAncestor: async (ancestorSha, descendantSha) => {
      ancestry.push([ancestorSha, descendantSha]);
      return true;
    },
  });
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore,
    git: gitAdapter,
    journal: fakeJournal(fixture.client.events),
    clock: { now: () => '2026-08-20T12:05:00.000Z' },
  });

  await setup.api.verifyResolve(35, [fixture.remediation.id]);
  assert.equal(archiveReads, 0, 'verifier bootstrap never reads archives');
  assert.equal(setup.state.calls.length, 1);

  const retained = await setup.api.replyResolve(35, fixture.aggregateTask.id);

  assert.equal(archiveReads, 2);
  assert.equal(setup.state.calls.length, 2, 'aggregate adoption adds one guarded checkpoint');
  assert.equal(setup.state.calls[1].name, 'checkpointArchiveTaskCompletion');
  assert.equal(setup.state.calls[1].input.archiveImportEnvelope.taskId, fixture.aggregateTask.id);
  assert.equal(setup.state.calls[1].input.archiveImportEnvelope.rows.length, 9);
  assert.equal(
    new Set(setup.state.calls[1].input.archiveImportEnvelope.rows.map(
      (row) => row.provenanceFingerprint,
    )).size,
    9,
  );
  assert.equal(retained.threadResolutionStatus.status, 'failed');
  const retainedRows = retained.threadResolutionStatus.threads
    .filter((row) => row.taskIds.includes(fixture.aggregateTask.id));
  assert.equal(retainedRows.length, 9);
  assert.equal(new Set(retainedRows.map((row) => row.archiveProvenance.authorityFingerprint)).size, 1);
  assert.deepEqual(
    [...new Set(retainedRows.map((row) => row.archiveProvenance.historicalTaskId))].sort(),
    [
      'archived-pr35-five-thread-fixes-r1',
      'pr-review-repeated-archive-proof-adoption-r1',
      'pr-review-worker-commit-delta-integrity-r1',
    ],
  );
  assert.deepEqual(
    retainedRows.map((row) => row.observedHeadSha).sort(),
    [
      ...Array(5).fill('9b170b10a21f19cc91fb52224955e75092268017'),
      ...Array(3).fill('a9452e42ea796eaf3e0b6ac757ab4f54c97a2db7'),
      '667a953217e7425cac90fc460631f4ce59e472d8',
    ].sort(),
  );
  assert.equal(
    fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(fixture.client.events, []);
  assert.ok(ancestry.filter(([ancestor, descendant]) => (
    ancestor === '09e6875bb7176e5841c6afd4038349632ae8e2a8'
      && descendant === 'a9452e42ea796eaf3e0b6ac757ab4f54c97a2db7'
  )).length >= 2, 'historical integration ancestry is rerun at final preflight');

  const archiveReadsBeforeOrdinaryResolution = archiveReads;
  const completed = await setup.api.replyResolve(35, fixture.portabilityTask.id);

  assert.equal(archiveReads, archiveReadsBeforeOrdinaryResolution, 'later live proof validation does not reread archives');
  assert.equal(completed.threadResolutionStatus.status, 'passed');
  assert.equal(completed.threadResolutionStatus.threads.length, 10);
  assert.equal(
    completed.threadResolutionStatus.threads.filter((row) => Object.hasOwn(row, 'archiveProvenance')).length,
    9,
  );
  const portabilityRow = completed.threadResolutionStatus.threads.find(
    (row) => row.threadNodeId === PACKET_PORTABILITY_THREAD_ID,
  );
  assert.equal(portabilityRow.isResolved, true);
  assert.equal(Object.hasOwn(portabilityRow, 'archiveProvenance'), false);
  assert.deepEqual(
    fixture.client.calls.filter((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name))
      .map((call) => call.name),
    ['AddThreadReply', 'ResolveThread'],
    'ordinary resolution mutates only the remaining portability root',
  );
});

test('aggregate origins retain immutable reply authority across terminal validation-plan drift only', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
  fixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
  };
  const liveReplyBodies = new Map(fixture.selectedThreadIds.map((threadId) => (
    [threadId, fixture.client.threadComments.get(threadId)[1].body]
  )));
  for (const archive of [oldArchive, mixedArchive]) {
    archive.state.validationStatus.checks = [
      'node --test later-terminal-plan.test.mjs',
      'npm run check:workflow',
      'git diff --check',
    ];
  }
  const records = [oldArchive, mixedArchive];
  const originalRecords = structuredClone(records);
  const archiveStore = immutableArchiveStore(records);
  const journal = fakeJournal(fixture.client.events);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore,
    git: fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    }),
    journal,
  });

  const retained = await setup.api.replyResolve(35, fixture.aggregateTask.id);

  const retainedRows = retained.threadResolutionStatus.threads.filter(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  );
  assert.equal(retainedRows.length, fixture.selectedThreadIds.length);
  for (const row of retainedRows) {
    assert.equal(
      row.archiveProvenance.replyBodySha256,
      createHash('sha256').update(liveReplyBodies.get(row.threadNodeId), 'utf8').digest('hex'),
      row.threadNodeId,
    );
  }
  assert.equal(setup.state.calls.length, 1);
  assert.equal(setup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(journal.intents.size, 0);
  assert.equal(
    fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(fixture.client.events, []);
  assert.deepEqual(records, originalRecords);

  const ordinary = archiveAdoptionFixture();
  ordinary.archive.state.validationStatus.checks = ['npm run later-terminal-plan'];
  const ordinarySetup = workflow(ordinary.active, ordinary.client, {
    archiveStore: immutableArchiveStore([ordinary.archive]), journal: ordinary.journal,
  });
  await assert.rejects(
    () => ordinarySetup.api.replyResolve(2, ARCHIVED_TASK_ID),
    { code: 'ARCHIVE_REPLY_MISMATCH' },
  );
  assert.equal(ordinarySetup.state.calls.length, 0);
});

test('validation-drift aggregate origins retain every strict live, proof, intent, time, and lineage gate', async () => {
  const cases = [
    ['wrong historical head', ({ reply, proofRow }) => {
      reply.body = reply.body.replace(proofRow.observedHeadSha, OTHER_HEAD);
    }],
    ['wrong historical task', ({ reply, historicalTask }) => {
      reply.body = reply.body.replace(`- ${historicalTask.id}:`, '- altered-historical-task:');
    }],
    ['wrong fixed commit', ({ reply, historicalTask }) => {
      reply.body = reply.body.replace(historicalTask.integratedCommitSha, OTHER_HEAD);
    }],
    ['wrong deterministic marker', ({ reply }) => {
      reply.body = reply.body.replace(
        /<!-- aerstello-review:[0-9a-f]{24} -->/u,
        `<!-- aerstello-review:${'f'.repeat(24)} -->`,
      );
    }],
    ['duplicate validation block', ({ reply }) => {
      reply.body = reply.body.replace('\n<!-- aerstello-review:', '\nValidation: duplicate.\n<!-- aerstello-review:');
    }],
    ['edited reply', ({ reply }) => { reply.lastEditedAt = '2026-08-20T12:20:00.000Z'; }],
    ['foreign reply actor', ({ reply }) => { reply.author = BOT; }],
    ['wrong reply parent', ({ reply }) => { reply.replyTo = { id: 'PRRC_wrong_parent' }; }],
    ['extra direct reply', ({ comments, reply }) => {
      comments.push({ ...structuredClone(reply), id: 'PRRC_extra_reply', databaseId: 9_900_040 });
    }],
    ['changed durable proof', ({ proofRow }) => { proofRow.replyId = 'PRRC_changed_reply'; }],
    ['missing reply intent', ({ records, proofRow }) => {
      const operationId = `reply:35:${proofRow.threadNodeId}:${proofRow.observedHeadSha}`;
      records[1].events = records[1].events.filter(
        (event) => event.details?.operationId !== operationId,
      );
    }],
    ['proof outside terminal time', ({ proofRow }) => {
      proofRow.resolvedAt = '2099-08-20T12:00:00.000Z';
    }],
    ['divergent full-carrier lineage', ({ records, historicalTask }) => {
      const divergent = structuredClone(records[1]);
      divergent.archiveId = 'pr-35-2026-08-20T10-00-59-000Z';
      divergent.state.tasks.find((task) => task.id === historicalTask.id).summary += ' Divergent.';
      records.push(divergent);
    }],
  ];

  for (const [label, tamper] of cases) {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    for (const archive of [oldArchive, mixedArchive]) {
      archive.state.validationStatus.checks = ['npm run later-terminal-plan'];
    }
    const records = [oldArchive, mixedArchive];
    const proofRow = mixedArchive.state.threadResolutionStatus.threads.find((row) => {
      const task = mixedArchive.state.tasks.find((candidate) => candidate.id === row.taskIds[0]);
      return task?.disposition === 'actionable';
    });
    const historicalTask = mixedArchive.state.tasks.find((task) => task.id === proofRow.taskIds[0]);
    const comments = fixture.client.threadComments.get(proofRow.threadNodeId);
    const reply = comments[1];
    tamper({ records, proofRow, historicalTask, comments, reply });
    const archiveStore = immutableArchiveStore(records);
    const journal = fakeJournal(fixture.client.events);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore,
      git: fakeGit({
        snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
        pushedHead: async () => PACKET_AGGREGATE_HEAD,
      }),
      journal,
    });
    const durableSnapshot = structuredClone(setup.state.current);

    await assert.rejects(
      () => setup.api.replyResolve(35, fixture.aggregateTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.deepEqual(setup.state.current, durableSnapshot, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('aggregate adoption canonicalizes discussion-only and mixed dual aliases while ignoring unrelated aliases', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  for (const archive of [oldArchive, mixedArchive]) {
    const proofByThread = new Map(archive.state.threadResolutionStatus.threads.map(
      (row) => [row.threadNodeId, row],
    ));
    for (const historicalTask of archive.state.tasks.filter(
      (task) => task.sourceType === 'github-thread',
    )) {
      historicalTask.sourceIds = historicalTask.sourceIds.map((source) => {
        const threadId = /^thread:(.+)$/u.exec(source)?.[1];
        const proofRow = proofByThread.get(threadId);
        return proofRow ? `discussion:${proofRow.rootCommentDatabaseId}` : source;
      });
    }
  }
  const unrelatedRow = mixedArchive.state.threadResolutionStatus.threads[0];
  mixedArchive.state.tasks.push({
    id: 'unrelated-discussion-alias-control',
    sourceIds: [`discussion:${unrelatedRow.rootCommentDatabaseId + 10_000_000}`],
    sourceType: 'github-thread',
    fingerprint: 'unrelated-discussion-alias-control-fingerprint',
    summary: 'An unrelated canonical alias remains outside selected authority.',
    severity: 'P3', disposition: 'already-fixed', status: 'not-applicable',
    integratedCommitSha: null, resolutionSummary: 'Unrelated and intentionally unproved.',
  });
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  fixture.aggregateTask.sourceIds = fixture.selectedThreadIds.flatMap((threadId, index) => {
    const root = fixture.client.threadComments.get(threadId)[0];
    if (index === 0) return [`thread:${threadId}`, `discussion:${root.databaseId}`];
    return [index % 2 === 0 ? `thread:${threadId}` : `discussion:${root.databaseId}`];
  });
  fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
  fixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
  };
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore: immutableArchiveStore([oldArchive, mixedArchive]),
    git: fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    }),
    journal: fakeJournal(fixture.client.events),
  });
  const retained = await setup.api.replyResolve(35, fixture.aggregateTask.id);
  assert.equal(retained.threadResolutionStatus.threads.filter(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  ).length, 9);
  assert.equal(setup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
});

test('64-hex historical heads survive aggregate adoption and every later live proof gate', async () => {
  const originalHead = '667a953217e7425cac90fc460631f4ce59e472d8';
  const longHead = '6'.repeat(64);
  const rewrite = (archive) => {
    const rewritten = JSON.parse(JSON.stringify(archive).replaceAll(originalHead, longHead));
    for (const event of rewritten.events) {
      if (event.details?.operationId?.includes(longHead)) {
        event.details.clientMutationId = `aerstello-${createHash('sha256')
          .update(event.details.operationId).digest('hex').slice(0, 24)}`;
      }
    }
    return rewritten;
  };
  const oldArchive = rewrite(decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  ));
  const mixedArchive = rewrite(decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  ));
  const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
  fixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
  };
  const archiveStore = immutableArchiveStore([oldArchive, mixedArchive]);
  const setup = workflow(fixture.active, fixture.client, {
    archiveStore,
    git: fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    }),
    journal: fakeJournal(fixture.client.events),
  });
  const retained = await setup.api.replyResolve(35, fixture.aggregateTask.id);
  assert.ok(retained.threadResolutionStatus.threads.some(
    (row) => row.observedHeadSha === longHead && Object.hasOwn(row, 'archiveProvenance'),
  ));
  const readsBeforeLaterGate = archiveStore.calls;
  const completed = await setup.api.replyResolve(35, fixture.portabilityTask.id);
  assert.equal(completed.threadResolutionStatus.status, 'passed');
  assert.equal(archiveStore.calls, readsBeforeLaterGate);
});

test('multiline already-fixed archive authority survives adoption and later live proof while tampering fails closed', async () => {
  const createSetup = () => {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const multilineSummary = 'Retained exact historical authority.\nSecond audited summary line.';
    for (const archive of [oldArchive, mixedArchive]) {
      archive.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      ).resolutionSummary = multilineSummary;
    }
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const archiveStore = immutableArchiveStore([oldArchive, mixedArchive]);
    const journal = fakeJournal(fixture.client.events);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore,
      git: fakeGit({
        snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
        pushedHead: async () => PACKET_AGGREGATE_HEAD,
      }),
      journal,
    });
    return { oldArchive, fixture, archiveStore, journal, setup };
  };

  const successful = createSetup();
  const retained = await successful.setup.api.replyResolve(35, successful.fixture.aggregateTask.id);
  assert.ok(retained.threadResolutionStatus.threads.some((row) => (
    row.archiveProvenance?.historicalTaskId === 'archived-pr35-five-thread-fixes-r1'
  )));
  const archiveReadsBeforeLaterGate = successful.archiveStore.calls;
  const completed = await successful.setup.api.replyResolve(35, successful.fixture.portabilityTask.id);
  assert.equal(completed.threadResolutionStatus.status, 'passed');
  assert.equal(successful.archiveStore.calls, archiveReadsBeforeLaterGate);

  const tampered = createSetup();
  await tampered.setup.api.replyResolve(35, tampered.fixture.aggregateTask.id);
  const multilineThreadId = tampered.oldArchive.state.threadResolutionStatus.threads[0].threadNodeId;
  tampered.fixture.client.threadComments.get(multilineThreadId)[1].body += '\ntampered';
  const durableSnapshot = structuredClone(tampered.setup.state.current);
  const checkpointCount = tampered.setup.state.calls.length;
  const mutationCount = tampered.fixture.client.calls.filter(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ).length;
  const archiveReads = tampered.archiveStore.calls;
  await assert.rejects(
    () => tampered.setup.api.replyResolve(35, tampered.fixture.portabilityTask.id),
    GitHubWorkflowError,
  );
  assert.equal(tampered.setup.state.calls.length, checkpointCount);
  assert.deepEqual(tampered.setup.state.current, durableSnapshot);
  assert.equal(tampered.archiveStore.calls, archiveReads);
  assert.equal(tampered.journal.intents.size, 0);
  assert.equal(tampered.fixture.client.calls.filter(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ).length, mutationCount);
  assert.deepEqual(tampered.fixture.client.events, []);
});

test('archive batch adoption rejects archive identity, task projection, and terminal-evidence ambiguity', async () => {
  const cases = [
    ['missing archive', (fixture) => []],
    ['foreign repository', (fixture) => [{
      ...fixture.archive,
      state: { ...fixture.archive.state, repository: 'other/aerstello' },
    }]],
    ['altered task identity', (fixture) => [{
      ...fixture.archive,
      state: {
        ...fixture.archive.state,
        tasks: [{ ...fixture.archive.state.tasks[0], summary: 'Altered archived summary.' }],
      },
    }]],
    ['nonterminal archive', (fixture) => [{
      ...fixture.archive,
      state: { ...fixture.archive.state, abandonmentReason: null },
      events: fixture.archive.events.filter((event) => event.type !== 'abandoned'),
    }]],
    ['conflicting archive authority', (fixture) => {
      const conflicting = {
        ...structuredClone(fixture.archive), archiveId: 'pr-2-2026-08-05T00-02-00-000Z',
      };
      const intent = conflicting.events.find((event) => event.details?.type === 'reply');
      intent.details.at = '2026-08-04T23:58:31.000Z';
      intent.at = '2026-08-04T23:58:31.001Z';
      return [fixture.archive, conflicting];
    }],
    ['duplicate archive identity', (fixture) => [fixture.archive, structuredClone(fixture.archive)]],
  ];

  for (const [label, records] of cases) {
    const fixture = archiveAdoptionFixture();
    const archiveStore = immutableArchiveStore(records(fixture));
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), GitHubWorkflowError, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('aggregate archive adoption fails closed for incomplete partitions, intent authority, lineage, and races', async () => {
  const offSelectionHistoricalCarrier = (archive, {
    archiveId, retainOtherPartitions,
  }) => {
    const moved = structuredClone(archive);
    moved.archiveId = archiveId;
    const historicalTaskId = 'archived-pr35-five-thread-fixes-r1';
    const historicalTask = moved.state.tasks.find((task) => task.id === historicalTaskId);
    const originalRows = moved.state.threadResolutionStatus.threads;
    const historicalRows = originalRows.filter((row) => row.taskIds[0] === historicalTaskId);
    const offSelectedThreadId = `${retainOtherPartitions ? 'PRRT_moved' : 'PRRT_pure'}_off_selected_history`;
    const offSelectedRow = {
      ...structuredClone(historicalRows[0]),
      threadNodeId: offSelectedThreadId,
      rootCommentNodeId: `${retainOtherPartitions ? 'PRRC_moved' : 'PRRC_pure'}_off_selected_history`,
      rootCommentDatabaseId: retainOtherPartitions ? 9_900_031 : 9_900_032,
      replyId: `${retainOtherPartitions ? 'PRRC_moved' : 'PRRC_pure'}_off_selected_history_reply`,
      replyUrl: `https://github.com/example/aerstello/pull/35#discussion_r${retainOtherPartitions ? 9900031 : 9900032}`,
    };
    historicalTask.sourceIds = [`thread:${offSelectedThreadId}`];
    if (!retainOtherPartitions) {
      moved.state.tasks = moved.state.tasks.filter(
        (task) => task.sourceType !== 'github-thread' || task.id === historicalTaskId,
      );
    }
    const removedRows = retainOtherPartitions ? historicalRows : originalRows;
    const removedThreadIds = new Set(removedRows.map((row) => row.threadNodeId));
    moved.state.threadResolutionStatus.threads = [
      ...originalRows.filter((row) => !removedThreadIds.has(row.threadNodeId)),
      offSelectedRow,
    ];
    moved.events = moved.events.filter((event) => {
      const serializedReferences = `${event.summary ?? ''}\n${event.details?.operationId ?? ''}`;
      for (const threadId of removedThreadIds) {
        if (serializedReferences.includes(threadId)) return false;
      }
      return true;
    });
    return moved;
  };

  const offSelectedActiveCarrier = (fixture, {
    archiveId, includeActiveTask, suffix,
  }) => {
    const threadNodeId = `PRRT_off_selected_active_${suffix}`;
    const tasks = fixture.active.tasks
      .filter((task) => includeActiveTask || task.id !== fixture.aggregateTask.id)
      .map((task) => task.id === fixture.aggregateTask.id ? {
        ...structuredClone(task), sourceIds: [`thread:${threadNodeId}`], status: 'completed',
      } : structuredClone(task));
    return {
      archiveId,
      state: {
        ...structuredClone(fixture.active),
        tasks,
        threadResolutionStatus: {
          status: 'passed',
          headSha: PACKET_AGGREGATE_HEAD,
          threads: [{
            threadNodeId,
            rootCommentNodeId: `PRRC_off_selected_active_${suffix}`,
            rootCommentDatabaseId: suffix === 'with_task' ? 9_900_025 : 9_900_026,
            taskIds: [fixture.aggregateTask.id],
            disposition: 'already-fixed',
            replyId: `PRRC_off_selected_active_${suffix}_reply`,
            replyUrl: `https://github.com/furinvader/aerstello/pull/35#discussion_r${suffix === 'with_task' ? 9900025 : 9900026}`,
            isResolved: true,
            resolvedAt: '2026-08-20T12:00:00.000Z',
            resolvedBy: 'furinvader',
            observedHeadSha: '9b170b10a21f19cc91fb52224955e75092268017',
            archiveProvenance: {
              schemaVersion: 1,
              historicalTaskId: 'off-selected-historical-task',
              historicalDisposition: 'already-fixed',
              historicalIntegratedCommitSha: null,
              replyBodySha256: '1'.repeat(64),
              authorityFingerprint: '2'.repeat(64),
            },
          }],
          threadlessVerification: structuredClone(
            fixture.active.threadResolutionStatus.threadlessVerification,
          ),
          localVerification: proof('not-run').localVerification,
          updatedAt: '2026-08-20T12:00:00.000Z',
        },
        abandonmentReason: 'Preserve an off-selected active carrier.',
        updatedAt: '2026-08-20T12:00:00.000Z',
      },
      events: [{
        schemaVersion: 1,
        type: 'abandoned',
        summary: 'Archived without completion: Preserve an off-selected active carrier.',
        at: '2026-08-20T12:00:00.010Z',
      }],
    };
  };

  const cases = [
    ['no full carrier', ({ oldArchive }) => ({ records: [oldArchive] })],
    ['partial historical partition', ({ oldArchive, mixedArchive }) => {
      const partial = structuredClone(mixedArchive);
      const task = partial.state.tasks.find((item) => item.id === 'pr-review-worker-commit-delta-integrity-r1');
      task.sourceIds.pop();
      return { records: [oldArchive, partial] };
    }],
    ['duplicate historical partition', ({ oldArchive, mixedArchive }) => {
      const duplicate = structuredClone(mixedArchive);
      const historicalTask = duplicate.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const duplicateTask = {
        ...structuredClone(historicalTask),
        id: 'duplicate-five-root-historical-partition',
        fingerprint: 'duplicate-five-root-historical-partition-fingerprint',
      };
      const duplicateRows = duplicate.state.threadResolutionStatus.threads
        .filter((row) => row.taskIds[0] === historicalTask.id)
        .map((row) => ({ ...structuredClone(row), taskIds: [duplicateTask.id] }));
      duplicate.state.tasks.push(duplicateTask);
      duplicate.state.threadResolutionStatus.threads.push(...duplicateRows);
      return { records: [oldArchive, duplicate] };
    }],
    ['overlapping historical cover', ({ oldArchive, mixedArchive }) => {
      const overlapping = structuredClone(mixedArchive);
      const firstTask = overlapping.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const secondTask = overlapping.state.tasks.find(
        (task) => task.id === 'pr-review-worker-commit-delta-integrity-r1',
      );
      firstTask.sourceIds.push(secondTask.sourceIds[0]);
      return { records: [oldArchive, overlapping] };
    }],
    ['alternate historical cover', ({ oldArchive, mixedArchive }) => {
      const alternate = structuredClone(mixedArchive);
      alternate.archiveId = 'pr-35-2026-08-20T10-00-10-000Z';
      const fromTask = alternate.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const toTask = alternate.state.tasks.find(
        (task) => task.id === 'pr-review-worker-commit-delta-integrity-r1',
      );
      const movedSource = fromTask.sourceIds[0];
      const movedThreadId = /^thread:(.+)$/u.exec(movedSource)[1];
      const movedRow = alternate.state.threadResolutionStatus.threads.find(
        (row) => row.threadNodeId === movedThreadId,
      );
      const toHead = alternate.state.threadResolutionStatus.threads.find(
        (row) => row.taskIds[0] === toTask.id,
      ).observedHeadSha;
      fromTask.sourceIds = fromTask.sourceIds.filter((source) => source !== movedSource);
      toTask.sourceIds.push(movedSource);
      movedRow.taskIds = [toTask.id];
      movedRow.observedHeadSha = toHead;
      return { records: [oldArchive, mixedArchive, alternate] };
    }],
    ['divergent historical partition task', ({ oldArchive, mixedArchive }) => {
      const divergent = structuredClone(oldArchive);
      divergent.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      ).summary += ' Divergent carrier projection.';
      return { records: [divergent, mixedArchive] };
    }],
    ['divergent historical partition row', ({ oldArchive, mixedArchive }) => {
      const divergent = structuredClone(oldArchive);
      divergent.state.threadResolutionStatus.threads[0].rootCommentDatabaseId += 1_000_000;
      return { records: [divergent, mixedArchive] };
    }],
    ['nonterminal aggregate full carrier', ({ oldArchive, mixedArchive }) => {
      const nonterminal = structuredClone(mixedArchive);
      nonterminal.state.abandonmentReason = null;
      nonterminal.events = nonterminal.events.filter((event) => event.type !== 'abandoned');
      return { records: [oldArchive, nonterminal] };
    }],
    ['nonterminal aggregate partition carrier', ({ oldArchive, mixedArchive }) => {
      const nonterminal = structuredClone(oldArchive);
      nonterminal.state.abandonmentReason = null;
      nonterminal.events = nonterminal.events.filter((event) => event.type !== 'abandoned');
      return { records: [nonterminal, mixedArchive] };
    }],
    ['wrong historical source', ({ oldArchive, mixedArchive }) => {
      const wrongSource = structuredClone(mixedArchive);
      wrongSource.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      ).sourceIds[0] = 'thread:PRRT_wrong_historical_source';
      return { records: [oldArchive, wrongSource] };
    }],
    ['wrong historical disposition', ({ oldArchive, mixedArchive }) => {
      const wrongDisposition = structuredClone(mixedArchive);
      const historicalTask = wrongDisposition.state.tasks.find(
        (task) => task.id === 'pr-review-repeated-archive-proof-adoption-r1',
      );
      historicalTask.disposition = 'duplicate';
      historicalTask.integratedCommitSha = null;
      for (const row of wrongDisposition.state.threadResolutionStatus.threads) {
        if (row.taskIds[0] === historicalTask.id) row.disposition = 'duplicate';
      }
      return { records: [oldArchive, wrongDisposition] };
    }],
    ['off-selection row naming an anchored historical task', ({ oldArchive, mixedArchive }) => {
      const hidden = structuredClone(mixedArchive);
      const source = hidden.state.threadResolutionStatus.threads.find(
        (row) => row.taskIds[0] === 'archived-pr35-five-thread-fixes-r1',
      );
      hidden.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: 'PRRT_hidden_anchored_historical_root',
        rootCommentNodeId: 'PRRC_hidden_anchored_historical_root',
        rootCommentDatabaseId: 9_900_001,
        replyId: 'PRRC_hidden_anchored_historical_reply',
        replyUrl: 'https://github.com/example/aerstello/pull/35#discussion_r9900001',
      });
      return { records: [oldArchive, hidden] };
    }],
    ['anchored historical task and proof moved wholly off selected roots', ({
      oldArchive, mixedArchive,
    }) => ({
      records: [
        oldArchive,
        mixedArchive,
        offSelectionHistoricalCarrier(mixedArchive, {
          archiveId: 'pr-35-2026-08-20T10-00-31-000Z',
          retainOtherPartitions: true,
        }),
      ],
    })],
    ['pure off-selected carrier still references anchored historical authority', ({
      oldArchive, mixedArchive,
    }) => ({
      records: [
        oldArchive,
        mixedArchive,
        offSelectionHistoricalCarrier(mixedArchive, {
          archiveId: 'pr-35-2026-08-20T10-00-32-000Z',
          retainOtherPartitions: false,
        }),
      ],
    })],
    ['pure off-selected provenance references anchored historical authority', ({
      oldArchive, mixedArchive,
    }) => {
      const carrier = offSelectionHistoricalCarrier(mixedArchive, {
        archiveId: 'pr-35-2026-08-20T10-00-33-000Z',
        retainOtherPartitions: false,
      });
      const historicalTaskId = 'archived-pr35-five-thread-fixes-r1';
      const ownerTask = carrier.state.tasks.find((task) => task.id === historicalTaskId);
      const ownerTaskId = 'pure-off-selected-provenance-owner';
      ownerTask.id = ownerTaskId;
      ownerTask.fingerprint = 'pure-off-selected-provenance-owner-fingerprint';
      const [ownerRow] = carrier.state.threadResolutionStatus.threads;
      ownerRow.taskIds = [ownerTaskId];
      ownerRow.archiveProvenance = {
        schemaVersion: 1,
        historicalTaskId,
        historicalDisposition: 'already-fixed',
        historicalIntegratedCommitSha: null,
        replyBodySha256: '3'.repeat(64),
        authorityFingerprint: '4'.repeat(64),
      };
      return { records: [oldArchive, mixedArchive, carrier] };
    }],
    ['relevant historical carrier cannot hide off-selected provenance authority', ({
      oldArchive, mixedArchive,
    }) => {
      const carrier = structuredClone(mixedArchive);
      carrier.archiveId = 'pr-35-2026-08-20T10-00-34-000Z';
      const source = carrier.state.threadResolutionStatus.threads.find(
        (row) => row.taskIds[0] === 'archived-pr35-five-thread-fixes-r1',
      );
      const ownerTaskId = 'historical-off-selected-provenance-owner';
      const offSelectedThreadId = 'PRRT_historical_off_selected_provenance_owner';
      carrier.state.tasks.push({
        id: ownerTaskId,
        sourceIds: [`thread:${offSelectedThreadId}`],
        sourceType: 'github-thread',
        fingerprint: 'historical-off-selected-provenance-owner-fingerprint',
        summary: 'Own a schema-valid off-selection provenance row.',
        severity: 'P2', disposition: 'already-fixed', status: 'completed',
        integratedCommitSha: null, resolutionSummary: 'Retain separate off-selection proof.',
      });
      carrier.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: offSelectedThreadId,
        rootCommentNodeId: 'PRRC_historical_off_selected_provenance_owner',
        rootCommentDatabaseId: 9_900_034,
        taskIds: [ownerTaskId],
        replyId: 'PRRC_historical_off_selected_provenance_owner_reply',
        replyUrl: 'https://github.com/example/aerstello/pull/35#discussion_r9900034',
        archiveProvenance: {
          schemaVersion: 1,
          historicalTaskId: 'archived-pr35-five-thread-fixes-r1',
          historicalDisposition: 'already-fixed',
          historicalIntegratedCommitSha: null,
          replyBodySha256: '5'.repeat(64),
          authorityFingerprint: '6'.repeat(64),
        },
      });
      return { records: [oldArchive, carrier] };
    }],
    ['unanchored task overlaps a selected root without proof', ({ oldArchive, mixedArchive }) => {
      const unanchored = structuredClone(mixedArchive);
      const sourceId = unanchored.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      ).sourceIds[0];
      unanchored.state.tasks.push({
        id: 'unanchored-selected-root-task',
        sourceIds: [sourceId],
        sourceType: 'github-thread',
        fingerprint: 'unanchored-selected-root-task-fingerprint',
        summary: 'Unanchored archive-local task overlaps one selected root.',
        severity: 'P2',
        disposition: 'already-fixed',
        status: 'not-applicable',
        integratedCommitSha: null,
        resolutionSummary: 'No historical partition proof belongs to this task.',
      });
      return { records: [oldArchive, unanchored] };
    }],
    ['discussion-only unanchored task overlaps a selected root', ({ oldArchive, mixedArchive }) => {
      const unanchored = structuredClone(mixedArchive);
      const selectedRow = unanchored.state.threadResolutionStatus.threads[0];
      unanchored.state.tasks.push({
        id: 'unanchored-discussion-alias-task',
        sourceIds: [`discussion:${selectedRow.rootCommentDatabaseId}`],
        sourceType: 'github-thread',
        fingerprint: 'unanchored-discussion-alias-task-fingerprint',
        summary: 'A discussion alias overlaps selected authority.',
        severity: 'P2',
        disposition: 'already-fixed',
        status: 'not-applicable',
        integratedCommitSha: null,
        resolutionSummary: 'No historical proof belongs to this task.',
      });
      return { records: [oldArchive, unanchored] };
    }],
    ['mixed thread and discussion aliases cannot hide an overlapping task', ({ oldArchive, mixedArchive }) => {
      const unanchored = structuredClone(mixedArchive);
      const selectedRow = unanchored.state.threadResolutionStatus.threads[0];
      unanchored.state.tasks.push({
        id: 'unanchored-mixed-alias-task',
        sourceIds: [
          `thread:${selectedRow.threadNodeId}`,
          `discussion:${selectedRow.rootCommentDatabaseId}`,
        ],
        sourceType: 'github-thread',
        fingerprint: 'unanchored-mixed-alias-task-fingerprint',
        summary: 'Mixed aliases overlap one selected authority root.',
        severity: 'P2',
        disposition: 'already-fixed',
        status: 'not-applicable',
        integratedCommitSha: null,
        resolutionSummary: 'No historical proof belongs to this task.',
      });
      return { records: [oldArchive, unanchored] };
    }],
    ['off-selected-only active carrier remains relevant', ({ oldArchive, mixedArchive, fixture }) => ({
      records: [oldArchive, mixedArchive, offSelectedActiveCarrier(fixture, {
        archiveId: 'pr-35-2026-08-20T10-00-25-000Z',
        includeActiveTask: true,
        suffix: 'with_task',
      })],
    })],
    ['off-selected active provenance row remains relevant without its task object', ({
      oldArchive, mixedArchive, fixture,
    }) => ({
      records: [oldArchive, mixedArchive, offSelectedActiveCarrier(fixture, {
        archiveId: 'pr-35-2026-08-20T10-00-26-000Z',
        includeActiveTask: false,
        suffix: 'without_task',
      })],
    })],
    ...[
      ['missing', (carrier) => { delete carrier.state.tasks; }],
      ['null', (carrier) => { carrier.state.tasks = null; }],
      ['object', (carrier) => { carrier.state.tasks = { malformed: true }; }],
    ].map(([shape, alterTasks]) => [
      `off-selected active provenance row remains relevant with ${shape} tasks`,
      ({ oldArchive, mixedArchive, fixture }) => {
        const carrier = offSelectedActiveCarrier(fixture, {
          archiveId: `pr-35-2026-08-20T10-00-${shape === 'missing' ? '27' : shape === 'null' ? '28' : '29'}-000Z`,
          includeActiveTask: false,
          suffix: `malformed_${shape}`,
        });
        alterTasks(carrier);
        return { records: [oldArchive, mixedArchive, carrier] };
      },
    ]),
    ['off-selected legacy row remains relevant with a malformed tasks collection', ({
      oldArchive, mixedArchive, fixture,
    }) => {
      const carrier = offSelectedActiveCarrier(fixture, {
        archiveId: 'pr-35-2026-08-20T10-00-30-000Z',
        includeActiveTask: false,
        suffix: 'malformed_legacy',
      });
      carrier.state.tasks = { malformed: true };
      delete carrier.state.threadResolutionStatus.threads[0].archiveProvenance;
      return { records: [oldArchive, mixedArchive, carrier] };
    }],
    ['aggregate replay classification cannot fall back to historical authority', ({
      oldArchive, mixedArchive, fixture,
    }) => {
      const disguisedReplay = structuredClone(mixedArchive);
      disguisedReplay.archiveId = 'pr-35-2026-08-20T10-00-20-000Z';
      const offSelectedThreadId = 'PRRT_off_selected_active_replay';
      disguisedReplay.state.tasks.push({
        ...structuredClone(fixture.aggregateTask),
        sourceIds: [`thread:${offSelectedThreadId}`],
        fingerprint: 'divergent-off-selected-active-replay-fingerprint',
        status: 'completed',
      });
      const source = disguisedReplay.state.threadResolutionStatus.threads.find(
        (row) => row.taskIds[0] === 'archived-pr35-five-thread-fixes-r1',
      );
      disguisedReplay.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: offSelectedThreadId,
        rootCommentNodeId: 'PRRC_off_selected_active_replay',
        rootCommentDatabaseId: 9_900_002,
        taskIds: [fixture.aggregateTask.id],
        disposition: 'already-fixed',
        replyId: 'PRRC_off_selected_active_replay_reply',
        replyUrl: 'https://github.com/example/aerstello/pull/35#discussion_r9900002',
        archiveProvenance: {
          schemaVersion: 1,
          historicalTaskId: 'archived-pr35-five-thread-fixes-r1',
          historicalDisposition: 'already-fixed',
          historicalIntegratedCommitSha: null,
          replyBodySha256: '1'.repeat(64),
          authorityFingerprint: '2'.repeat(64),
        },
      });
      return { records: [oldArchive, mixedArchive, disguisedReplay] };
    }],
    ['cumulative selected-root partition and carrier-role bound', ({
      oldArchive, mixedArchive, fixture,
    }) => {
      const records = [oldArchive, mixedArchive];
      const firstCarrierAt = Date.parse('2026-08-21T00:00:00.000Z');
      for (let index = 0; index < 9_998; index += 1) {
        const archiveAt = new Date(firstCarrierAt + index).toISOString().replaceAll(':', '-').replace('.', '-');
        records.push({
          ...mixedArchive,
          archiveId: `pr-35-${archiveAt}`,
        });
      }
      Object.defineProperty(records[0].state.tasks, 'filter', {
        value() { throw new Error('active carrier classification must not allocate task filters'); },
      });
      const activeCarrier = records[2];
      const activeTasks = [{ ...structuredClone(fixture.aggregateTask), status: 'completed' }];
      const activeRows = [{
        ...structuredClone(activeCarrier.state.threadResolutionStatus.threads[0]),
        taskIds: [fixture.aggregateTask.id],
        disposition: 'already-fixed',
        archiveProvenance: {},
      }];
      Object.defineProperty(activeTasks, 'filter', {
        value() { throw new Error('active carrier classification must not allocate task filters'); },
      });
      Object.defineProperty(activeRows, 'filter', {
        value() { throw new Error('active carrier classification must not allocate proof filters'); },
      });
      records[2] = {
        ...activeCarrier,
        state: {
          ...activeCarrier.state,
          tasks: activeTasks,
          threadResolutionStatus: {
            ...activeCarrier.state.threadResolutionStatus,
            threads: activeRows,
          },
        },
      };
      const lateCarrier = records[9_990];
      const lateStatus = { ...lateCarrier.state.threadResolutionStatus };
      Object.defineProperty(lateStatus, 'threads', {
        enumerable: true,
        get() { throw new Error('far-over-limit carrier projection must not be reached'); },
      });
      records[9_990] = {
        ...lateCarrier,
        state: { ...lateCarrier.state, threadResolutionStatus: lateStatus },
      };
      return {
        records, errorCode: 'ARCHIVE_EVIDENCE_INVALID', archiveReads: 1,
        largeInventory: true, rawInventory: true,
      };
    }],
    ['historical summary marker collision', ({ oldArchive, mixedArchive, fixture }) => {
      const summary = `Retained historical authority.\n<!-- aerstello-review:${'f'.repeat(24)} -->`;
      const historicalTask = oldArchive.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const priorSummary = historicalTask.resolutionSummary;
      for (const archive of [oldArchive, mixedArchive]) {
        archive.state.tasks.find(
          (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
        ).resolutionSummary = summary;
      }
      for (const proofRow of oldArchive.state.threadResolutionStatus.threads) {
        const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
        reply.body = reply.body.replace(priorSummary, summary);
      }
      return { records: [oldArchive, mixedArchive] };
    }],
    ['malformed additional marker anchor', ({ oldArchive, mixedArchive, fixture }) => {
      const historicalTask = oldArchive.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const priorSummary = historicalTask.resolutionSummary;
      const summary = `${priorSummary}\n<!-- aerstello-review:not-a-valid-token -->`;
      for (const archive of [oldArchive, mixedArchive]) {
        archive.state.tasks.find(
          (task) => task.id === historicalTask.id,
        ).resolutionSummary = summary;
      }
      for (const proofRow of oldArchive.state.threadResolutionStatus.threads) {
        const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
        reply.body = reply.body.replace(priorSummary, summary);
      }
      return { records: [oldArchive, mixedArchive] };
    }],
    ['malformed 39-hex historical reply header', ({ oldArchive, mixedArchive, fixture }) => {
      const proofRow = mixedArchive.state.threadResolutionStatus.threads.at(-1);
      const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
      reply.body = reply.body.replace(proofRow.observedHeadSha, proofRow.observedHeadSha.slice(0, -1));
      return { records: [oldArchive, mixedArchive] };
    }],
    ['uppercase historical reply header', ({ oldArchive, mixedArchive, fixture }) => {
      const proofRow = mixedArchive.state.threadResolutionStatus.threads.at(-1);
      const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
      reply.body = reply.body.replace(proofRow.observedHeadSha, proofRow.observedHeadSha.toUpperCase());
      return { records: [oldArchive, mixedArchive] };
    }],
    ['historical task ID with LF separator', ({ oldArchive, mixedArchive, fixture }) => {
      const priorId = 'archived-pr35-five-thread-fixes-r1';
      const nextId = `${priorId}\ncontinued`;
      for (const archive of [oldArchive, mixedArchive]) {
        archive.state.tasks.find((task) => task.id === priorId).id = nextId;
        for (const row of archive.state.threadResolutionStatus.threads) {
          if (row.taskIds[0] === priorId) row.taskIds = [nextId];
        }
      }
      for (const proofRow of oldArchive.state.threadResolutionStatus.threads) {
        const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
        reply.body = reply.body.replace(priorId, nextId);
      }
      return { records: [oldArchive, mixedArchive] };
    }],
    ['historical summary with U+2028 separator', ({ oldArchive, mixedArchive, fixture }) => {
      const historicalTask = oldArchive.state.tasks.find(
        (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
      );
      const priorSummary = historicalTask.resolutionSummary;
      const nextSummary = `${priorSummary}\u2028continued`;
      for (const archive of [oldArchive, mixedArchive]) {
        archive.state.tasks.find((task) => task.id === historicalTask.id).resolutionSummary = nextSummary;
      }
      for (const proofRow of oldArchive.state.threadResolutionStatus.threads) {
        const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
        reply.body = reply.body.replace(priorSummary, nextSummary);
      }
      return { records: [oldArchive, mixedArchive] };
    }],
    ['historical validation check with CR separator', ({ oldArchive, mixedArchive, fixture }) => {
      const priorCheck = oldArchive.state.validationStatus.checks[0];
      const nextCheck = `${priorCheck}\rcontinued`;
      oldArchive.state.validationStatus.checks[0] = nextCheck;
      for (const proofRow of oldArchive.state.threadResolutionStatus.threads) {
        const reply = fixture.client.threadComments.get(proofRow.threadNodeId)[1];
        reply.body = reply.body.replace(priorCheck, nextCheck);
      }
      return { records: [oldArchive, mixedArchive] };
    }],
    ['mixed head within historical task', ({ oldArchive, mixedArchive }) => {
      const mixedHead = structuredClone(mixedArchive);
      mixedHead.state.threadResolutionStatus.threads.find(
        (row) => row.threadNodeId === 'PRRT_kwDOTqOdrM6ahnOF',
      ).observedHeadSha = 'b'.repeat(40);
      return { records: [oldArchive, mixedHead] };
    }],
    ['replay-only root', ({ oldArchive, mixedArchive }) => {
      const replayOnly = structuredClone(mixedArchive);
      replayOnly.events = replayOnly.events.filter((event) => (
        !String(event.details?.operationId ?? '').includes('PRRT_kwDOTqOdrM6auUvO')
      ));
      return { records: [oldArchive, replayOnly] };
    }],
    ['partial intent pair', ({ oldArchive, mixedArchive }) => {
      const partial = structuredClone(mixedArchive);
      partial.events = partial.events.filter((event) => (
        event.details?.operationId
          !== 'resolve:35:PRRT_kwDOTqOdrM6auUvO:667a953217e7425cac90fc460631f4ce59e472d8'
      ));
      return { records: [oldArchive, partial] };
    }],
    ['intent outside carried partition', ({ oldArchive, mixedArchive }) => {
      const unrelated = structuredClone(oldArchive);
      unrelated.events.splice(-1, 0, structuredClone(mixedArchive.events.find((event) => (
        event.details?.operationId
          === 'reply:35:PRRT_kwDOTqOdrM6ahnN9:a9452e42ea796eaf3e0b6ac757ab4f54c97a2db7'
      ))));
      return { records: [unrelated, mixedArchive] };
    }],
    ['non-ancestor historical relation', ({ oldArchive, mixedArchive }) => ({
      records: [oldArchive, mixedArchive],
      rejectAncestor: '09e6875bb7176e5841c6afd4038349632ae8e2a8',
    })],
    ['live body tamper', ({ oldArchive, mixedArchive, fixture }) => {
      const comments = fixture.client.threadComments.get('PRRT_kwDOTqOdrM6ahnN9');
      comments[1].body += '\ntampered';
      return { records: [oldArchive, mixedArchive] };
    }],
    ['active-ID legacy downgrade', ({ oldArchive, mixedArchive, fixture }) => {
      const downgraded = structuredClone(mixedArchive);
      downgraded.archiveId = 'pr-35-2026-08-20T10-00-00-000Z';
      const selectedRows = downgraded.state.threadResolutionStatus.threads;
      downgraded.state.tasks.push({ ...structuredClone(fixture.aggregateTask), status: 'completed' });
      for (const row of selectedRows) {
        row.taskIds = [fixture.aggregateTask.id];
        row.disposition = 'already-fixed';
      }
      return { records: [oldArchive, mixedArchive, downgraded] };
    }],
  ];

  for (const [label, configure] of cases) {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const configured = configure({ oldArchive, mixedArchive, fixture });
    const originalRecords = configured.largeInventory
      ? configured.records.map((record) => record.archiveId)
      : structuredClone(configured.records);
    const archiveStore = immutableArchiveStore(
      configured.records, null, { clone: configured.rawInventory !== true },
    );
    const journal = fakeJournal(fixture.client.events);
    const gitAdapter = fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
      isAncestor: async (ancestorSha) => ancestorSha !== configured.rejectAncestor,
    });
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, git: gitAdapter, journal,
    });
    const durableSnapshot = structuredClone(setup.state.current);
    await assert.rejects(
      () => setup.api.replyResolve(35, fixture.aggregateTask.id),
      configured.errorCode ? { code: configured.errorCode } : GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.deepEqual(setup.state.current, durableSnapshot, label);
    assert.equal(journal.intents.size, 0, label);
    if (configured.largeInventory) {
      assert.equal(configured.records.length, originalRecords.length, label);
      for (const [index, record] of configured.records.entries()) {
        assert.equal(record.archiveId, originalRecords[index], label);
      }
    } else {
      assert.deepEqual(configured.records, originalRecords, label);
    }
    if (configured.archiveReads !== undefined) assert.equal(archiveStore.calls, configured.archiveReads, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }

  for (const [label, race] of [
    ['added carrier inventory', ({ records }) => records.push({
      ...structuredClone(records[0]), archiveId: 'pr-35-2026-08-20T10-01-00-000Z',
    })],
    ['removed carrier inventory', ({ records }) => records.pop()],
    ['altered carrier content', ({ records }) => { records[1].state.nextAction += ' raced'; }],
    ['live evidence race', ({ fixture }) => {
      fixture.client.threadComments.get('PRRT_kwDOTqOdrM6ahnN9')[1].body += '\nraced';
    }],
    ['live head race', ({ fixture }) => {
      fixture.client.metadata.headRefOid = 'b'.repeat(40);
    }],
    ['state revision race', ({ setup }) => {
      setup.state.advanceRevisionForTest();
    }],
  ]) {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const records = [oldArchive, mixedArchive];
    let setup;
    const archiveStore = immutableArchiveStore(records, (calls) => {
      if (calls === 2) race({ records, fixture, setup });
    });
    setup = workflow(fixture.active, fixture.client, {
      archiveStore,
      git: fakeGit({
        snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
        pushedHead: async () => PACKET_AGGREGATE_HEAD,
      }),
      journal: fakeJournal(fixture.client.events),
    });
    await assert.rejects(
      () => setup.api.replyResolve(35, fixture.aggregateTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
  }
});

test('authentic Issue 55 evidence binds compact 8-to-12 whole-partition replay', async () => {
  const authenticArchiveBase64 = [
    'eyJzY2hlbWFWZXJzaW9uIjozLCJyZXZpc2lvbiI6NTYsInJlcG9zaXRvcnkiOiJmdXJpbnZhZGVyL2FlcnN0ZWxsbyIsInByTnVtYmVyIjo2MCwicGhhc2UiOiJpbnRlZ3JhdGluZyIsImJhc2VTaGEiOiI2MDc0NGZlMjIxZGJlNGM4NjA5Y2RmMTY0N2QzY2UzN2ZiOWVjYmJlIiwicmVxdWVzdGVkSGVhZFNoYSI6IjNkNGMzN2NhZjFmY2NkNGFlYzVlMjVmNTA0MmFjM2ExODViNGYxYTQiLCJyZXZpZXdlZEhlYWRTaGEiOiIzZDRjMzdjYWYxZmNjZDRhZWM1ZTI1ZjUwNDJhYzNhMTg1YjRmMWE0IiwiY3VycmVudEludGVncmF0aW9uSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJyZXZpZXdSb3VuZCI6MSwidmVyaWZpY2F0aW9uUmV2aWV3VXNlZCI6ZmFsc2UsInJldmlld1JlcXVlc3RMaW1pdCI6bnVsbCwibGVnYWN5UmV2aWV3UHJvdmVuYW5jZSI6bnVsbCwicmVsZWFzZUJhc2VsaW5lIjpudWxsLCJkZWNpc2lvbnMiOltdLCJ0YXNrcyI6W3siaWQiOiJiaW5kLWFjdGl2ZS1zY29wZS1hdXRob3JpdHktcjEiLCJzb3VyY2VJZHMiOlsidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA4ciIsImRpc2N1c3Npb246Mzg4MzM5NzQ2OSIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOHoiLCJkaXNjdXNzaW9uOjM4ODMzOTc0NzkiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDgyIiwiZGlzY3Vzc2lvbjozODgzMzk3NDg4Il0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXJldmlldy1hdXRob3JpdHktaWRlbnRpdHktcjEiLCJzdW1tYXJ5IjoiQmluZCByZXR1cm4sIGRlY2lzaW9uLCBhbmQgaGFuZG9mZiBldmlkZW5jZSB0byB0aGUgZXhhY3QgYWN0aXZlIHNjb3BlIGF1dGhvcml0eS4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGJ5IGFyY2hpdmVkIHJlY2VpcHQtdmFsaWQgaW50ZWdyYXRpb24gMjUzY2FjYzMxYzNkM2E3MTEyYjc0MmQyZTQ3OTgxNWZkOGFlNjEyMiBhbmQgcHJlc2VudCBhdCByZWNvdmVyZWQgaW50ZWdyYXRpb24gSEVBRCA3MWFkYmNjNmQzZDdhMTVjN2FlM2E4MzA5NjU1NWJiNzQ0NGUzM2Q1OyBjdXJyZW50LWhlYWQgdmVyaWZpY2F0aW9uIGFuZCBHaXRIdWIgdGhyZWFkIHByb29mIHJlbWFpbiBwZW5kaW5nLiJ9LHsiaWQiOiJlbmZvcmNlLXNjb3BlLWFkbWlzc2lvbi1zZW1hbnRpY3MtcjEiLCJzb3VyY2VJZHMiOlsidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA4NSIsImRpc2N1c3Npb246Mzg4MzM5NzQ5MiIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwODkiLCJkaXNjdXNzaW9uOjM4ODMzOTc0OTciLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDlCIiwiZGlzY3Vzc2lvbjozODgzMzk3NTAzIl0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXJldmlldy1hZG1pc3Npb24tc2VtYW50aWNzLXIxIiwic3VtbWFyeSI6IkVuZm9yY2UgZXhhY3Qgc2VtYW50aWMgYXV0aG9yaXR5IGF0IHBsYW4gYWRtaXNzaW9uLCBhZG9wdGlvbiwgYW5kIHNwbGl0LWRlZmVyIGFtZW5kbWVudC4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGJ5IGFyY2hpdmVkIHJlY2VpcHQtdmFsaWQgaW50ZWdyYXRpb24gY2U5MGI3NDRjZmJjOGYwNmJhMGFlZmIwZWRhZGUxYmExMTJlZTM1ZiBhbmQgcHJlc2VudCBhdCByZWNvdmVyZWQgaW50ZWdyYXRpb24gSEVBRCA3MWFkYmNjNmQzZDdhMTVjN2FlM2E4MzA5NjU1NWJiNzQ0NGUzM2Q1OyBjdXJyZW50LWhlYWQgdmVyaWZpY2F0aW9uIGFuZCBHaXRIdWIgdGhyZWFkIHByb29mIHJlbWFpbiBwZW5kaW5nLiJ9LHsiaWQiOiJjbG9zZS1ib3VuZGVkLWFtZW5kbWVudC1hdXRob3JpdHktcjEiLCJzb3VyY2VJZHMiOlsidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA5SSIsImRpc2N1c3Npb246Mzg4MzM5NzUxMiIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOU8iLCJkaXNjdXNzaW9uOjM4ODMzOTc1MjIiXSwic291cmNlVHlwZSI6ImdpdGh1Yi10aHJlYWQiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtcmV2aWV3LWJvdW5kZWQtYW1lbmRtZW50cy1yMSIsInN1bW1hcnkiOiJSZXF1aXJlIGNvbXBsZXRlIGFkZGVkLXRhc2sgYXV0aG9yaXR5IGFuZCBhIHJlcHJlc2VudGFibGUgYW1lbmRtZW50IGhpc3RvcnkuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBieSBhcmNoaXZlZCByZWNlaXB0LXZhbGlkIGludGVncmF0aW9uIDhkZjdjYTA3NmFlYzRkZmE3M2FjNDdjNTI2NmU5YTFhMWNmMGU4NTIgYW5kIHByZXNlbnQgYXQgcmVjb3ZlcmVkIGludGVncmF0aW9uIEhFQUQgNzFhZGJjYzZkM2Q3YTE1YzdhZTNhODMwOTY1NTViYjc0NDRlMzNkNTsgY3VycmVudC1oZWFkIHZlcmlmaWNhdGlvbiBhbmQgR2l0SHViIHRocmVhZCBwcm9vZiByZW1haW4gcGVuZGluZy4ifSx7ImlkIjoiYWxpZ24taGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6aGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiXSwic291cmNlVHlwZSI6ImxvY2FsIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LWxvY2FsLXZlcmlmaWVyLWhhbmRvZmYtZm9sbG93dXAtZG9tYWluLXI0Iiwic3VtbWFyeSI6IkFsaWduIGhhbmRvZmYgZGVmZXJyZWQtZm9sbG93LXVwIGJvdW5kcyB3aXRoIHRoZSBjYW5vbmljYWwgbWluaW1hbC1jbG9zdXJlIGRvbWFpbi4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhY3Rpb25hYmxlIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6ImRiMmRjZjIyZTQyOTczZDY4NGVmM2MzMjMzYjYwMmM0ZTY2MTc2MTciLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkludGVncmF0ZWQgY2VudHJhbGx5OyB0YXJnZXRlZCB2YWxpZGF0aW9uIGFuZCBleGFjdC1oZWFkIHZlcmlmaWNhdGlvbiByZW1haW4uIiwidGFza1BhY2tldERpZ2VzdCI6IjcwODJmNDJjZjhkYjljNzU3ODI0MjI1ZTdhODM5NjgxN2VkMzEwZTY0MjBiZWM4YWJkZWVjNmJjOTM4ZmU2ZDciLCJ3b3JrZXJSZXN1bHREaWdlc3QiOiI4OTdlNjA4YTdjNmIzZDk5NmRjYzNmYmQ1MjY2M2Q5ZWQ5ZGIzYTFmZGZjMDVjMGE2MmU5NzVmOTA1Yjg3OTNiIn0seyJpZCI6ImVuZm9yY2UtZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0Iiwic291cmNlSWRzIjpbImxvY2FsOmludGVncmF0aW9uLXZlcmlmaWVyOmV4YWN0LW9wZXJhdG9yLWRlY2lzaW9uLWF1dGhvcml0eS1yNCJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtbG9jYWwtdmVyaWZpZXItZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0Iiwic3VtbWFyeSI6IkVuZm9yY2UgZXhhY3Qgb3JkZXJlZCBvcGVyYXRvci1kZWNpc2lvbiBhdXRob3JpdHkgYW5kIGdsb2JhbGx5IHVuaXF1ZSBkZWNpc2lvbiBJRHMuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWN0aW9uYWJsZSIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOiIwNmE2NDhmM2IzZjlhZjVkMjZjMWVkN2ZjODU5NjE3MWJlNDNhOTU2IiwicmVzb2x1dGlvblN1bW1hcnkiOiJJbnRlZ3JhdGVkIGNlbnRyYWxseTsgdGFyZ2V0ZWQgdmFsaWRhdGlvbiBhbmQgZXhhY3QtaGVhZCB2ZXJpZmljYXRpb24gcmVtYWluLiIsInRhc2tQYWNrZXREaWdlc3QiOiIyNzVkNzA1YzIzMDE1NDZhZGRjMzZkN2MxNjU4ODUyYjc0YWEyZTlhZmIxNmJhZGYxOTNmM2M3OWRjMDMzMTY0Iiwid29ya2VyUmVzdWx0RGlnZXN0IjoiYmVjM2M0MWQ3ZjRkN2I3ZTNjYjEzYmFmMmUzNjE2MDJkZjM5Y2E3MjRjNDA3NGQ3MTRlYzlmMmVhM2U4NjAzMiJ9LHsiaWQiOiJjbGFzc2lmeS1jdXJyZW50LXVuaW5jb3Jwb3JhdGVkLXNjb3BlLWRlY2lzaW9uLXI1Iiwic291cmNlSWRzIjpbImxvY2FsOmludGVncmF0aW9uLXZlcmlmaWVyOnVuaW5jb3Jwb3JhdGVkLWRlY2lzaW9uLXN0YXRlLXI1Il0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS11bmluY29ycG9yYXRlZC1kZWNpc2lvbi1zdGF0ZS1yNSIsInN1bW1hcnkiOiJDbGFzc2lmeSBvbmx5IHRoZSBleGFjdCBzdGlsbC1wZW5kaW5nIG1hdGVyaWFsIGRlY2lzaW9uIGFzIHVuaW5jb3Jwb3JhdGVkIGR1cmluZyBjbG9zdXJlIHJlcGxheS4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhY3Rpb25hYmxlIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6ImVmMzJiNDljZDE0Yjg5NjJmZWE3MDRkYWFmNTc4OGUyMzUwZTFlYTkiLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkludGVncmF0ZWQgY2VudHJhbGx5OyB0YXJnZXRlZCB2YWxpZGF0aW9uIGFuZCBleGFjdC1oZWFkIHZlcmlmaWNhdGlvbiByZW1haW4uIiwidGFza1BhY2tldERpZ2VzdCI6IjBkZjhjYmFjZDM0ZDM1Mzc4NDRlM2JiNmZmOThlZTkxYjNhZjhmMzVkZjA0ZGViOTM0YzhkM2M4ODE1ZDcwOGUiLCJ3b3JrZXJSZXN1bHREaWdlc3QiOiIxYTZjM2ZjM2FiMDZiYWQwNTRmZmUwNDdlNzVhZDMzYjg2OWJiZjIxNzhkZWQ4YmEyMzNlNWFhZTBjODcyOTU1In0seyJpZCI6InZhbGlkYXRlLXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LXNlbWFudGljcy1yNSIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjpzY29wZS1kZWNpc2lvbi1yZWNvdmVyeS1ub3Qtc2VtYW50aWMtcjUiXSwic291cmNlVHlwZSI6ImxvY2FsIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LW5vdC1zZW1hbnRpYy1yNSIsInN1bW1hcnkiOiJWYWxpZGF0ZSBpbnRlcnJ1cHRlZCBzY29wZS1kZWNpc2lvbiByZWNvdmVyeSBzZW1hbnRpY2FsbHkgYmVmb3JlIGR1cmFibGUgd3JpdGVzLiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFjdGlvbmFibGUiLCJzdGF0dXMiOiJpbnRlZ3JhdGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkludGVncmF0ZWQgY2VudHJhbGx5OyB0YXJnZXRlZCB2YWxpZGF0aW9uIGFuZCBleGFjdC1oZWFkIHZlcmlmaWNhdGlvbiByZW1haW4uIiwidGFza1BhY2tldERpZ2VzdCI6IjkzMTM5MWI5MmUwYTFiODUzNzUyMDkxYjY2ZDZiOTM2ZGE5OTk4N2NhNTVlZGQ3YTBhNDQ5Y2E2ZjljNzE5M2YiLCJ3b3JrZXJSZXN1bHREaWdlc3QiOiI0MTQ1YjljNDY2MDk1OWI4NmVjNmUzYTUxMTI3ODI0NmU0ZDFhOWFkY2I4YTdlMzJiMzk5ZmQxZjBjNTQ0ZTcxIn0seyJpZCI6ImFsaWduLWZvbGxvd3VwLWNvZGVwb2ludC1wYXJpdHktcjUiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6Zm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtZm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSIsInN1bW1hcnkiOiJBbGlnbiBkZWZlcnJlZCBmb2xsb3ctdXAgcmVmZXJlbmNlIGxlbmd0aCB3aXRoIEpTT04gU2NoZW1hIFVuaWNvZGUgY29kZS1wb2ludCBzZW1hbnRpY3MuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWN0aW9uYWJsZSIsInN0YXR1cyI6ImludGVncmF0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjoiMzZiMWJhNDBiYmY4MTNmODc3NjU1OTk5YjE4NjRjMGM3OWYyNjBkMCIsInJlc29sdXRpb25TdW1tYXJ5IjoiSW50ZWdyYXRlZCBjZW50cmFsbHk7IHRhcmdldGVkIHZhbGlkYXRpb24gYW5kIGV4YWN0LWhlYWQgdmVyaWZpY2F0aW9uIHJlbWFpbi4iLCJ0YXNrUGFja2V0RGlnZXN0IjoiYTQ4OWM3MDcxODg2MmRkYTJhYWJlYzRmN2U5OWVlNzFhZTcxOTgwZDc5OGY3NzA2NzljOWFlNDBhM2VmMjAzYiIsIndvcmtlclJlc3VsdERpZ2VzdCI6IjlmOTEzYzEwMWRhNGY0YjBlYjNjZmU3ZmEyMzExOTBiNzk5ZWE3OTkxMjEwMDhiMGM1ZTRmOWNiNDRjZjRlNGQifV0sInJldmlld1JlcXVlc3QiOnsiaWQiOiJJQ19rd0RPVHFPZHJNOEFBQUFCUlQ1ZXBnIiwiZGF0YWJhc2VJZCI6NTQ1NjY4MjY2MiwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjaXNzdWVjb21tZW50LTU0NTY2ODI2NjIiLCJoZWFkU2hhIjoiM2Q0YzM3Y2FmMWZjY2Q0YWVjNWUyNWY1MDQyYWMzYTE4NWI0ZjFhNCIsImF0IjoiMjAyNi0wOC0yOFQxOTowOTo1MVoiLCJraW5kIjoiZGlzY292ZXJ5IiwiYm9keSI6IkBjb2RleCByZXZpZXciLCJhdXRob3JMb2dpbiI6ImZ1cmludmFkZXIiLCJhdXRob3JOb2RlSWQiOiJNRFE2VlhObGNqUXlOall4TURjPSJ9LCJyZXZpZXdPdXRjb21lIjp7ImlkIjoiUFJSX2t3RE9UcU9kck04QUFBQUJMVU5tM0EiLCJkYXRhYmFzZUlkIjo1MDU0MzU5MjYwLCJ1cmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNwdWxscmVxdWVzdHJldmlldy01MDU0MzU5MjYwIiwiaGVhZFNoYSI6IjNkNGMzN2NhZjFmY2NkNGFlYzVlMjVmNTA0MmFjM2ExODViNGYxYTQiLCJhdCI6IjIwMjYtMDgtMjhUMTk6MTk6NTNaIiwicmVxdWVzdElkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJUNWVwZyIsImtpbmQiOiJkaXNjb3ZlcnkiLCJvdXRjb21lIjoiZmluZGluZ3MiLCJldmlkZW5jZVR5cGUiOiJyZXZpZXctc3VibWlzc2lvbiIsInJldmlld2VyTG9naW4iOiJjaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJldmlld2VyTm9kZUlkIjoiQk9UX2tnRE9DOThzX2ciLCJyZXZpZXdlclR5cGUiOiJCb3QiLCJyZXZpZXdlclVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9hcHBzL2NoYXRncHQtY29kZXgtY29ubmVjdG9yIiwicmVhY3Rpb25Db250ZW50IjpudWxsLCJyZWFjdGlvbkNvbW1lbnRJZCI6bnVsbH0sInJldmlld0hpc3RvcnkiOlt7InJlcXVlc3QiOnsiaWQiOiJJQ19rd0RPVHFPZHJNOEFBQUFCUlQ1ZXBnIiwiZGF0YWJhc2VJZCI6NTQ1NjY4MjY2MiwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjaXNzdWVjb21tZW50LTU0NTY2ODI2NjIiLCJoZWFkU2hhIjoiM2Q0YzM3Y2FmMWZjY2Q0YWVjNWUyNWY1MDQyYWMzYTE4NWI0ZjFhNCIsImF0IjoiMjAyNi0wOC0yOFQxOTowOTo1MVoiLCJraW5kIjoiZGlzY292ZXJ5IiwiYm9keSI6IkBjb2RleCByZXZpZXciLCJhdXRob3JMb2dpbiI6ImZ1cmludmFkZXIiLCJhdXRob3JOb2RlSWQiOiJNRFE2VlhObGNqUXlOall4TURjPSJ9LCJvdXRjb21lIjp7ImlkIjoiUFJSX2t3RE9UcU9kck04QUFBQUJMVU5tM0EiLCJkYXRhYmFzZUlkIjo1MDU0MzU5MjYwLCJ1cmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNwdWxscmVxdWVzdHJldmlldy01MDU0MzU5MjYwIiwiaGVhZFNoYSI6IjNkNGMzN2NhZjFmY2NkNGFlYzVlMjVmNTA0MmFjM2ExODViNGYxYTQiLCJhdCI6IjIwMjYtMDgtMjhUMTk6MTk6NTNaIiwicmVxdWVzdElkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJUNWVwZyIsImtpbmQiOiJkaXNjb3ZlcnkiLCJvdXRjb21lIjoiZmluZGluZ3MiLCJldmlkZW5jZVR5cGUiOiJyZXZpZXctc3VibWlzc2lvbiIsInJldmlld2VyTG9naW4iOiJjaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJldmlld2VyTm9kZUlkIjoiQk9UX2tnRE9DOThzX2ciLCJyZXZpZXdlclR5cGUiOiJCb3QiLCJyZXZpZXdlclVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9hcHBzL2NoYXRncHQtY29kZXgtY29ubmVjdG9yIiwicmVhY3Rpb25Db250ZW50IjpudWxsLCJyZWFjdGlvbkNvbW1lbnRJZCI6bnVsbH19XSwic3RhbGVEaXNjb3ZlcnlEaXNwb3NpdGlvbnMiOltdLCJ2ZXJpZmljYXRpb25Fc2NhbGF0aW9uIjpudWxsLCJ0aHJlYWRSZXNvbHV0aW9uU3RhdHVzIjp7InN0YXR1cyI6InBhc3NlZCIsImhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwidGhyZWFkcyI6W3sidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDgyIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRnciLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0ODgsInRhc2tJZHMiOlsiYmluZC1hY3RpdmUtc2NvcGUtYXV0aG9yaXR5LXIxIl0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0wZ0giLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MTM0MTUiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTozNzozMS4wNzJaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIn0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwODUiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GMCIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzQ5MiwidGFza0lkcyI6WyJlbmZvcmNlLXNjb3BlLWFkbWlzc2lvbi1zZW1hbnRpY3MtcjEiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTJhciIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcyMTI1OSIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjQxOjU5Ljg0MVoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEifSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA4OSIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0Y1Iiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NDk3LCJ0YXNrSWRzIjpbImVuZm9yY2Utc2NvcGUtYWRtaXNzaW9uLXNlbWFudGljcy1yMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tM0k2IiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzI0MjE4IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6NDI6NTkuNDcxWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDhyIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRmQiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0NjksInRhc2tJZHMiOlsiYmluZC1hY3RpdmUtc2NvcGUtYXV0aG9yaXR5LXIxIl0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0wOXoiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MTUzMTUiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTozODozMi41MThaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIn0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwOHoiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GbiIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzQ3OSwidGFza0lkcyI6WyJiaW5kLWFjdGl2ZS1zY29wZS1hdXRob3JpdHktcjEiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTFYYyIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcxNjk1NiIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjM5OjM3LjY5OFoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEifSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA5QiIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0ZfIiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NTAzLCJ0YXNrSWRzIjpbImVuZm9yY2Utc2NvcGUtYWRtaXNzaW9uLXNlbWFudGljcy1yMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tM24yIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzI2MTk4IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6NDM6NTcuODMwWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDlJIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfR0kiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc1MTIsInRhc2tJZHMiOlsiY2xvc2UtYm91bmRlZC1hbWVuZG1lbnQtYXV0aG9yaXR5LXIxIl0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm00Y0oiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3Mjk1NDUiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTo0NToxNi43OThaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIn0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwOU8iLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9HUyIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzUyMiwidGFza0lkcyI6WyJjbG9zZS1ib3VuZGVkLWFtZW5kbWVudC1hdXRob3JpdHktcjEiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTQwNiIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTczMTEzMCIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjQ2OjEzLjMxMFoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEifV0sInRocmVhZGxlc3NWZXJpZmljYXRpb24iOnsic3RhdHVzIjoibm90LXJ1biIsImhlYWRTaGEiOm51bGwsInRhc2tJZHMiOltdLCJ1cGRhdGVkQXQiOm51bGx9LCJ1cGRhdGVkQXQiOiIyMDI2LTA4LTI5VDA1OjU1OjI5LjQ4OVoiLCJsb2NhbFZlcmlmaWNhdGlvbiI6eyJzdGF0dXMiOiJwYXNzZWQiLCJoZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsInRhc2tJZHMiOlsiYWxpZ24taGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiLCJjbGFzc2lmeS1jdXJyZW50LXVuaW5jb3Jwb3JhdGVkLXNjb3BlLWRlY2lzaW9uLXI1IiwiZW5mb3JjZS1leGFjdC1vcGVyYXRvci1kZWNpc2lvbi1hdXRob3JpdHktcjQiXSwidXBkYXRlZEF0IjoiMjAyNi0wOC0yOVQwNTo1NToyOS40ODlaIn19LCJibG9ja2VkUmVhc29ucyI6W10sInZhbGlkYXRpb25TdGF0dXMiOnsic291cmNlIjoib3JjaGVzdHJhdG9yIiwic2NvcGUiOiJ0YXJnZXRlZCIsInN0YXR1cyI6InBhc3NlZCIsImhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2hlY2tzIjpbIm5vZGUgLS10ZXN0IC5hZ2VudHMvc2tpbGxzL2NoYW5nZS1kZXZlbG9wbWVudC9zY3JpcHRzL2hhbmRvZmYvY29udHJhY3RzLnRlc3QubWpzIC5hZ2VudHMvc2tpbGxzL3ByLXJldmlldy1jeWNsZS9zY3JpcHRzL2NvbnRyYWN0cy9zY29wZS1jb250cm9sLnRlc3QubWpzIiwibm9kZSAtLXRlc3QgLmFnZW50cy9za2lsbHMvcHItcmV2aWV3LWN5Y2xlL3NjcmlwdHMvc3RydWN0dXJlLnRlc3QubWpzIiwibm9kZSAtLXRlc3QgLmFnZW50cy9za2lsbHMvY2hhbmdlLWRldmVsb3BtZW50L3NjcmlwdHMvc3RhdGUvc3RhdGUudGVzdC5tanMiLCJucG0gcnVuIGNoZWNrOndvcmtmbG93Il0sInVwZGF0ZWRBdCI6IjIwMjYtMDgtMjlUMDU6MzA6MTUuMjY3WiJ9LCJjaVZhbGlkYXRpb25TdGF0dXMiOnsic291cmNlIjoiZ2l0aHViLWFjdGlvbnMiLCJzY29wZSI6ImZ1bGwiLCJzdGF0dXMiOiJub3QtcnVuIiwiaGVhZFNoYSI6bnVsbCwiY2hlY2tzIjpbXSwiY2hlY2tSdW5JZCI6bnVsbCwid29ya2Zsb3dSdW5JZCI6bnVsbCwid29ya2Zsb3dSdW5VcmwiOm51bGwsInVwZGF0ZWRBdCI6bnVsbH0sImNpVmFsaWRhdGlvbkhpc3RvcnkiOltdLCJuZXh0QWN0aW9uIjoiQ29udGludWUgb25seSB3aXRoIHJlbWVkaWF0aW9uIGJvdW5kIHRvIHRoZSBhcHBsaWNhYmxlIGNsYXNzaWZpZWQgc2hhcGUuIiwiaW50ZWdyYXRpb25Xb3JrdHJlZSI6Ii90bXAvYWVyc3RlbGxvLWlzc3VlNTUtcmVzdGFydC5jcXFCU1EvcmVwbyIsIm9yY2hlc3RyYXRvclNlc3Npb25JZCI6bnVsbCwiYWJhbmRvbm1lbnRSZWFzb24iOiJTdXBlcnNlZGVkIGFmdGVyIHRoZSBzY29wZS1jb250cm9sIGpvdXJuYWwgcmVhY2hlZCBpdHMgYm91bmRlZCBjYXBhY2l0eSBhbmQgdGhlIGxhc3Qgc2NoZW1hLXZhbGlkIGNvbXBhY3QgZXhhY3QtaGVhZCBwYWlyIHdhcyBmb3VuZCBub25jYW5vbmljYWwgYmVjYXVzZSBpdCBhZ2dyZWdhdGVkIHNlcGFyYXRlbHkgcmVxdWlyZWQgbWVjaGFuaXNtcyBhbmQgb21pdHRlZCByZWNvcmRlZCBtYXRlcmlhbCBpbnZlbnRvcnk7IHByZXNlcnZlIHJldmlzaW9uIDU1IGFzIGltbXV0YWJsZSByZWNvdmVyeSBldmlkZW5jZSBhbmQgcmVzdGFydCBhdCB1bmNoYW5nZWQgY2xlYW4gSEVBRCA1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIHdpdGggYSBmcmVzaCBjYW5vbmljYWwgam91cm5hbC4iLCJnaXQiOnsiYnJhbmNoIjoiYWdlbnQvaXNzdWUtNTUtbWluaW1hbC1zY29wZS1yMiIsImhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiZGlydHkiOmZhbHNlfSwidXBkYXRlZEF0IjoiMjAyNi0wOC0yOVQwNTo1NzozOS4wODBaIiwic2NvcGVDb250cm9sIjp7ImF1dGhvcml0eURpZ2VzdCI6InNoYTI1Njo4ZjU0ZDBjMjNkMDE0MWMxNjQwMDJjNTc1MDAxMTE1YzJkOGQ5MzgyMzE0ODRmNGY0MDQzYzk5MGIwZmRlOTI1Iiwiam91cm5hbERpZ2VzdCI6InNoYTI1Njo2MDVkMWMyOTAxNTlkYzE4NGMwZThhOWM2MGU0ODE4YTM3NDBiMWEzMjBmMWY0OTA1YmNlYmMyMzZkYWNlYmVkIiwicmV0dXJuRGlnZXN0IjpudWxsLCJnYXRlIjoicmVhZHkiLCJhc3Nlc3NtZW50SGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJ1cGRhdGVkQXQiOiIyMDI2LTA4LTI5VDA1OjU0OjM1LjkyMFoifX0K',
    'eyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiaW5pdGlhbGl6ZWQiLCJzdW1tYXJ5IjoiSW5pdGlhbGl6ZWQgUFIgNjAiLCJhdCI6IjIwMjYtMDgtMjlUMDM6MjY6MTAuNTA0WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhcmdldGVkLXZhbGlkYXRpb24tcGxhbm5lZCIsInN1bW1hcnkiOiJTYXZlZCA1IHRhcmdldGVkIGNoZWNrcyBmb3IgM2Q0YzM3Y2FmMWZjY2Q0YWVjNWUyNWY1MDQyYWMzYTE4NWI0ZjFhNCIsImF0IjoiMjAyNi0wOC0yOVQwMzoyNjoxNi4yNjVaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFyZ2V0ZWQtdmFsaWRhdGlvbi1yZWNvcmRlZCIsInN1bW1hcnkiOiJSZWNvcmRlZCBwYXNzZWQgdGFyZ2V0ZWQgdmFsaWRhdGlvbiBmb3IgM2Q0YzM3Y2FmMWZjY2Q0YWVjNWUyNWY1MDQyYWMzYTE4NWI0ZjFhNCIsImF0IjoiMjAyNi0wOC0yOVQwMzozNTowNi41MDJaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGhyZWFkLXByb29mLXJlY292ZXJlZCIsInN1bW1hcnkiOiJSZWNvdmVyZWQgdGhlIGV4YWN0IHByZS1yZXZpZXcgZW1wdHktdGhyZWFkIHByb29mIGZyb20gaW1tdXRhYmxlIFBSIDYwIHJlYWRpbmVzcyBldmlkZW5jZSIsImF0IjoiMjAyNi0wOC0yOVQwMzozNToyNi45NjZaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoicmVhZHktZm9yLXJldmlldy1yZWNvdmVyZWQiLCJzdW1tYXJ5IjoiUmVjb3ZlcmVkIGV4YWN0IGFyY2hpdmVkIFBSIDYwIFJldmlldy1jb21taXQgcmVhZGluZXNzIiwiYXQiOiIyMDI2LTA4LTI5VDAzOjM1OjM5Ljg5NVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJyZXZpZXctcmVxdWVzdC1yZWNvdmVyZWQiLCJzdW1tYXJ5IjoiUmVjb3ZlcmVkIGltbXV0YWJsZSBQUiA2MCBkaXNjb3ZlcnkgcmVxdWVzdCA1NDU2NjgyNjYyIGZyb20gYXJjaGl2ZWQgZXZpZGVuY2UiLCJhdCI6IjIwMjYtMDgtMjlUMDM6MzU6NTIuNjQ4WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InJldmlldy1vdXRjb21lLXJlY292ZXJlZCIsInN1bW1hcnkiOiJSZWNvdmVyZWQgaW1tdXRhYmxlIFBSIDYwIENvZGV4IGZpbmRpbmdzIG91dGNvbWUgNTA1NDM1OTI2MCBmcm9tIGFyY2hpdmVkIGV2aWRlbmNlIiwiYXQiOiIyMDI2LTA4LTI5VDAzOjM2OjAzLjk0NVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXQtY2hlY2twb2ludCIsInN1bW1hcnkiOiJDaGVja3BvaW50ZWQgaW50ZWdyYXRpb24gSEVBRCA3MWFkYmNjNmQzZDdhMTVjN2FlM2E4MzA5NjU1NWJiNzQ0NGUzM2Q1IiwiYXQiOiIyMDI2LTA4LTI5VDAzOjM2OjIwLjU5N1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0cmlhZ2UtcGxhbm5lZCIsInN1bW1hcnkiOiJSZWNvdmVyZWQgdGhyZWUgYXJjaGl2ZWQgR2l0SHViIGZpbmRpbmcgZ3JvdXBzIGFuZCB0d28gZm91cnRoLXJvdW5kIGxvY2FsIHJlcGFpcnMiLCJhdCI6IjIwMjYtMDgtMjlUMDM6MzY6NTcuNDkxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRyaWFnZS1yZWNvdmVyZWQiLCJzdW1tYXJ5IjoiUmVjb3JkZWQgdGhyZWUgYXJjaGl2ZWQgQ29kZXggZmluZGluZyBncm91cHMgYXMgYWxyZWFkeSBmaXhlZCBhdCB0aGUgcmVjb3ZlcmVkIGludGVncmF0aW9uIEhFQUQiLCJhdCI6IjIwMjYtMDgtMjlUMDM6Mzc6MjguMDM5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBoYW5kb2ZmLWZvbGxvd3VwLWRvbWFpbi1taXNtYXRjaC1yNCBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTI5VDAzOjM3OjM4Ljk4NFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgaW5leGFjdC1vcGVyYXRvci1kZWNpc2lvbi1hdXRob3JpdHktcjQgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0yOVQwMzozNzo0Ni44ODlaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1wYWNrZXQtYm91bmQiLCJzdW1tYXJ5IjoiQm91bmQgYWNjZXB0ZWQgcGFja2V0IGZvciB0YXNrIGFsaWduLWhhbmRvZmYtZm9sbG93dXAtZG9tYWluLXI0IiwiYXQiOiIyMDI2LTA4LTI5VDAzOjM4OjI5LjI5OFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXNrLXBhY2tldC1ib3VuZCIsInN1bW1hcnkiOiJCb3VuZCBhY2NlcHRlZCBwYWNrZXQgZm9yIHRhc2sgZW5mb3JjZS1leGFjdC1vcGVyYXRvci1kZWNpc2lvbi1hdXRob3JpdHktcjQiLCJhdCI6IjIwMjYtMDgtMjlUMDM6Mzg6NDIuNjM5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1zdGFydGVkIiwic3VtbWFyeSI6IlN0YXJ0ZWQgaXNvbGF0ZWQgd29ya2VyIGZvciBhbGlnbi1oYW5kb2ZmLWZvbGxvd3VwLWRvbWFpbi1yNCIsImF0IjoiMjAyNi0wOC0yOVQwMzo0MDo0Mi4wODlaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXN0YXJ0ZWQiLCJzdW1tYXJ5IjoiU3RhcnRlZCBpc29sYXRlZCB3b3JrZXIgZm9yIGVuZm9yY2UtZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0IiwiYXQiOiIyMDI2LTA4LTI5VDAzOjQwOjUxLjU1NloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ3b3JrZXItcmVzdWx0LWFjY2VwdGVkIiwic3VtbWFyeSI6IkFjY2VwdGVkIHdvcmtlciByZXN1bHQgZm9yIHRhc2sgYWxpZ24taGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiLCJhdCI6IjIwMjYtMDgtMjlUMDM6NDQ6MjEuOTY5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1yZXN1bHQtYWNjZXB0ZWQiLCJzdW1tYXJ5IjoiQWNjZXB0ZWQgd29ya2VyIHJlc3VsdCBmb3IgdGFzayBlbmZvcmNlLWV4YWN0LW9wZXJhdG9yLWRlY2lzaW9uLWF1dGhvcml0eS1yNCIsImF0IjoiMjAyNi0wOC0yOVQwNDowMzoxNC43MjBaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0LWNoZWNrcG9pbnQiLCJzdW1tYXJ5IjoiQ2hlY2twb2ludGVkIGludGVncmF0aW9uIEhFQUQgZGIyZGNmMjJlNDI5NzNkNjg0ZWYzYzMyMzNiNjAyYzRlNjYxNzYxNyIsImF0IjoiMjAyNi0wOC0yOVQwNDowMzozMi4zNTNaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1pbnRlZ3JhdGVkIiwic3VtbWFyeSI6IkludGVncmF0ZWQgZXhhY3Qgd29ya2VyIHBhdGNoIGZvciBhbGlnbi1oYW5kb2ZmLWZvbGxvd3VwLWRvbWFpbi1yNCIsImF0IjoiMjAyNi0wOC0yOVQwNDowMzo1MC4xOTdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0LWNoZWNrcG9pbnQiLCJzdW1tYXJ5IjoiQ2hlY2twb2ludGVkIGludGVncmF0aW9uIEhFQUQgMDZhNjQ4ZjNiM2Y5YWY1ZDI2YzFlZDdmYzg1OTYxNzFiZTQzYTk1NiIsImF0IjoiMjAyNi0wOC0yOVQwNDowNDoxMy42NDFaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1pbnRlZ3JhdGVkIiwic3VtbWFyeSI6IkludGVncmF0ZWQgZXhhY3Qgd29ya2VyIHBhdGNoIGZvciBlbmZvcmNlLWV4YWN0LW9wZXJhdG9yLWRlY2lzaW9uLWF1dGhvcml0eS1yNCIsImF0IjoiMjAyNi0wOC0yOVQwNDowNDoyMy40MzNaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFyZ2V0ZWQtdmFsaWRhdGlvbi1wbGFubmVkIiwic3VtbWFyeSI6IlNhdmVkIDQgdGFyZ2V0ZWQgY2hlY2tzIGZvciAwNmE2NDhmM2IzZjlhZjVkMjZjMWVkN2ZjODU5NjE3MWJlNDNhOTU2IiwiYXQiOiIyMDI2LTA4LTI5VDA0OjA0OjQxLjU5NVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXJnZXRlZC12YWxpZGF0aW9uLXJlY29yZGVkIiwic3VtbWFyeSI6IlJlY29yZGVkIHBhc3NlZCB0YXJnZXRlZCB2YWxpZGF0aW9uIGZvciAwNmE2NDhmM2IzZjlhZjVkMjZjMWVkN2ZjODU5NjE3MWJlNDNhOTU2IiwiYXQiOiIyMDI2LTA4LTI5VDA0OjIxOjI5LjMxOVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgaW5leGFjdC1vcGVyYXRvci1kZWNpc2lvbi1hdXRob3JpdHktcjQgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0yOVQwNDoyMjowNy40NjJaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidHJpYWdlLXBsYW5uZWQiLCJzdW1tYXJ5IjoiUmVjb3JkZWQgdGhyZWUgZmlmdGgtcm91bmQgZXhhY3QtaGVhZCB2ZXJpZmllciByZXBhaXJzIiwiYXQiOiIyMDI2LTA4LTI5VDA0OjM0OjUzLjc0NloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgdW5pbmNvcnBvcmF0ZWQtZGVjaXNpb24tc3RhdGUtcjUgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0yOVQwNDozNTowMy44OTdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIHNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LW5vdC1zZW1hbnRpYy1yNSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTI5VDA0OjM1OjA2Ljg1MFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgZm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTI5VDA0OjM1OjA5Ljg3NloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXNrLXBhY2tldC1ib3VuZCIsInN1bW1hcnkiOiJCb3VuZCBhY2NlcHRlZCBwYWNrZXQgZm9yIHRhc2sgY2xhc3NpZnktY3VycmVudC11bmluY29ycG9yYXRlZC1zY29wZS1kZWNpc2lvbi1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDozNTozOS40NjlaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1wYWNrZXQtYm91bmQiLCJzdW1tYXJ5IjoiQm91bmQgYWNjZXB0ZWQgcGFja2V0IGZvciB0YXNrIHZhbGlkYXRlLXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LXNlbWFudGljcy1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDozNTo1MC42OTZaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1wYWNrZXQtYm91bmQiLCJzdW1tYXJ5IjoiQm91bmQgYWNjZXB0ZWQgcGFja2V0IGZvciB0YXNrIGFsaWduLWZvbGxvd3VwLWNvZGVwb2ludC1wYXJpdHktcjUiLCJhdCI6IjIwMjYtMDgtMjlUMDQ6MzY6MDIuMjQ1WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1zdGFydGVkIiwic3VtbWFyeSI6IlN0YXJ0ZWQgaXNvbGF0ZWQgd29ya2VyIGZvciBjbGFzc2lmeS1jdXJyZW50LXVuaW5jb3Jwb3JhdGVkLXNjb3BlLWRlY2lzaW9uLXI1IiwiYXQiOiIyMDI2LTA4LTI5VDA0OjM2OjM3LjMyM1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ3b3JrZXItc3RhcnRlZCIsInN1bW1hcnkiOiJTdGFydGVkIGlzb2xhdGVkIHdvcmtlciBmb3IgYWxpZ24tZm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDozNjo0MC43MDlaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXJlc3VsdC1hY2NlcHRlZCIsInN1bW1hcnkiOiJBY2NlcHRlZCB3b3JrZXIgcmVzdWx0IGZvciB0YXNrIGFsaWduLWZvbGxvd3VwLWNvZGVwb2ludC1wYXJpdHktcjUiLCJhdCI6IjIwMjYtMDgtMjlUMDQ6Mzk6MzkuNjgxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdC1jaGVja3BvaW50Iiwic3VtbWFyeSI6IkNoZWNrcG9pbnRlZCBpbnRlZ3JhdGlvbiBIRUFEIDM2YjFiYTQwYmJmODEzZjg3NzY1NTk5OWIxODY0YzBjNzlmMjYwZDAiLCJhdCI6IjIwMjYtMDgtMjlUMDQ6NDA6MDguMDkzWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhc2staW50ZWdyYXRlZCIsInN1bW1hcnkiOiJJbnRlZ3JhdGVkIGV4YWN0IHdvcmtlciBwYXRjaCBmb3IgYWxpZ24tZm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDo0MDoyNS4yMDRaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXJlc3VsdC1hY2NlcHRlZCIsInN1bW1hcnkiOiJBY2NlcHRlZCB3b3JrZXIgcmVzdWx0IGZvciB0YXNrIGNsYXNzaWZ5LWN1cnJlbnQtdW5pbmNvcnBvcmF0ZWQtc2NvcGUtZGVjaXNpb24tcjUiLCJhdCI6IjIwMjYtMDgtMjlUMDQ6NTg6MjYuMDk5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdC1jaGVja3BvaW50Iiwic3VtbWFyeSI6IkNoZWNrcG9pbnRlZCBpbnRlZ3JhdGlvbiBIRUFEIGVmMzJiNDljZDE0Yjg5NjJmZWE3MDRkYWFmNTc4OGUyMzUwZTFlYTkiLCJhdCI6IjIwMjYtMDgtMjlUMDQ6NTg6NDYuMDE4WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhc2staW50ZWdyYXRlZCIsInN1bW1hcnkiOiJJbnRlZ3JhdGVkIGV4YWN0IHdvcmtlciBwYXRjaCBmb3IgY2xhc3NpZnktY3VycmVudC11bmluY29ycG9yYXRlZC1zY29wZS1kZWNpc2lvbi1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDo1ODo1Ni43MDZaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXN0YXJ0ZWQiLCJzdW1tYXJ5IjoiU3RhcnRlZCBpc29sYXRlZCB3b3JrZXIgZm9yIHZhbGlkYXRlLXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LXNlbWFudGljcy1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNDo1OToxNy4wNjRaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXJlc3VsdC1hY2NlcHRlZCIsInN1bW1hcnkiOiJBY2NlcHRlZCB3b3JrZXIgcmVzdWx0IGZvciB0YXNrIHZhbGlkYXRlLXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LXNlbWFudGljcy1yNSIsImF0IjoiMjAyNi0wOC0yOVQwNToxMjozNS40NzVaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0LWNoZWNrcG9pbnQiLCJzdW1tYXJ5IjoiQ2hlY2twb2ludGVkIGludGVncmF0aW9uIEhFQUQgNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNToxMjo1NC40MTdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFzay1pbnRlZ3JhdGVkIiwic3VtbWFyeSI6IkludGVncmF0ZWQgZXhhY3Qgd29ya2VyIHBhdGNoIGZvciB2YWxpZGF0ZS1zY29wZS1kZWNpc2lvbi1yZWNvdmVyeS1zZW1hbnRpY3MtcjUiLCJhdCI6IjIwMjYtMDgtMjlUMDU6MTM6MDIuNzQxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhcmdldGVkLXZhbGlkYXRpb24tcGxhbm5lZCIsInN1bW1hcnkiOiJTYXZlZCA0IHRhcmdldGVkIGNoZWNrcyBmb3IgNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNToxMzoxNS4wMDVaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFyZ2V0ZWQtdmFsaWRhdGlvbi1yZWNvcmRlZCIsInN1bW1hcnkiOiJSZWNvcmRlZCBwYXNzZWQgdGFyZ2V0ZWQgdmFsaWRhdGlvbiBmb3IgNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTozMDoxNS4yODJaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGZvbGxvd3VwLWNvZGVwb2ludC1wYXJpdHktcjUgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0yOVQwNTozMDo1NS45NzRaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGF1dGhvcml0eS1pZGVudGl0eS1nYXBzLXIxIGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMjlUMDU6MzQ6NDEuOTQ5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBzY29wZS1hZG1pc3Npb24tc2VtYW50aWNzLXIxIGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMjlUMDU6MzQ6NDIuNjAxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBib3VuZGVkLWFtZW5kbWVudC1hdXRob3JpdHktcjEgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0yOVQwNTozNDo0My4yMzJaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGJvdW5kZWQtYW1lbmRtZW50LWF1dGhvcml0eS1yMSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTI5VDA1OjM1OjI4LjM0MloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXBseSByZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwODI6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTozNjo0Mi4xOTNaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVwbHkiLCJvcGVyYXRpb25JZCI6InJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4Mjo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby1mMWY5NmVkYjRhZTVmYmY5MDJjNzc3NWEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6MzY6NDIuMTg2WiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXNvbHZlIHJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDgyOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6Mzc6MTUuMzA5WiIsImRldGFpbHMiOnsidHlwZSI6InJlc29sdmUiLCJvcGVyYXRpb25JZCI6InJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDgyOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWQ3MzBjMWJjYTczODNhNmNmNmViOTVlNiIsImF0IjoiMjAyNi0wOC0yOVQwNTozNzoxNS4zMDNaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlcGx5IHJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4cjo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjM3OjM4LjUyNVoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXBseSIsIm9wZXJhdGlvbklkIjoicmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDhyOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWNmMmFiMGM5Nzc1MDljYzcxNzRlOGUzMCIsImF0IjoiMjAyNi0wOC0yOVQwNTozNzozOC41MTlaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlc29sdmUgcmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOHI6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTozODoxMy40OThaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVzb2x2ZSIsIm9wZXJhdGlvbklkIjoicmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOHI6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tMzYwOGFhYWRkN2E0MWIyZTdjMjM0ZTVlIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjM4OjEzLjQ4OVoifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVwbHkgcmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDh6OjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6Mzg6MzkuMDYyWiIsImRldGFpbHMiOnsidHlwZSI6InJlcGx5Iiwib3BlcmF0aW9uSWQiOiJyZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOHo6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tMTVlNjk0Y2M3YzIwNzM2NjRhNzIxZWM1IiwiYXQiOiIyMDI2LTA4LTI5VDA1OjM4OjM5LjA1MloifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVzb2x2ZSByZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4ejo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjM5OjIxLjUwNloiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXNvbHZlIiwib3BlcmF0aW9uSWQiOiJyZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4ejo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby1lMjc1YmIyM2IwN2VkNjNhOTE2ZGUzN2IiLCJhdCI6IjIwMjYtMDgtMjlUMDU6Mzk6MjEuNDk5WiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXBseSByZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwODU6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTo0MTowNi42MzNaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVwbHkiLCJvcGVyYXRpb25JZCI6InJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4NTo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby1hN2RjNWYyNDFmMGNjYWUxNWVjNTQyMTIiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDE6MDYuNjIyWiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXNvbHZlIHJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDg1OjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDE6NDIuMDQzWiIsImRldGFpbHMiOnsidHlwZSI6InJlc29sdmUiLCJvcGVyYXRpb25JZCI6InJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDg1OjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWQzMzJkMmM4YjMxNWQ4MzQ4MzE4YTU0NCIsImF0IjoiMjAyNi0wOC0yOVQwNTo0MTo0Mi4wMzZaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlcGx5IHJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA4OTo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQyOjA4LjQyOVoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXBseSIsIm9wZXJhdGlvbklkIjoicmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDg5OjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWVjN2Y2YzVmOGY2NGVmZmMyNjRjNWZlYiIsImF0IjoiMjAyNi0wOC0yOVQwNTo0MjowOC40MjNaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlc29sdmUgcmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwODk6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTo0Mjo0Mi42NDdaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVzb2x2ZSIsIm9wZXJhdGlvbklkIjoicmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwODk6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tMmE5YjNiY2ZjNjVjMmMxZDZhZWNkYTRjIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQyOjQyLjYzOVoifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVwbHkgcmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDlCOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDM6MDcuODA0WiIsImRldGFpbHMiOnsidHlwZSI6InJlcGx5Iiwib3BlcmF0aW9uSWQiOiJyZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOUI6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tMDk3Yzg3MmM0YTNlYWQ5NGU0OGVlNDljIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQzOjA3Ljc5N1oifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVzb2x2ZSByZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkUjA5Qjo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQzOjQxLjU4NloiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXNvbHZlIiwib3BlcmF0aW9uSWQiOiJyZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkUjA5Qjo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby1iYTQwMDkwYzlmYWU0YWNkZWY3ZDU5MGQiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDM6NDEuNTgwWiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXBseSByZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOUk6NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTo0NDoyNy40NTlaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVwbHkiLCJvcGVyYXRpb25JZCI6InJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA5STo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby1mMzE4MTMyZTA4ZWQzMzI2MDBlNGJkMjYiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDQ6MjcuNDUyWiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXNvbHZlIHJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDlJOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDU6MDAuNjcxWiIsImRldGFpbHMiOnsidHlwZSI6InJlc29sdmUiLCJvcGVyYXRpb25JZCI6InJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDlJOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWZhZDI4Yzg1MDk2MjZhMzAyZTg4MmFjZSIsImF0IjoiMjAyNi0wOC0yOVQwNTo0NTowMC42NjRaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlcGx5IHJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkUjA5Tzo1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQ1OjI1LjAzOVoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXBseSIsIm9wZXJhdGlvbklkIjoicmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRSMDlPOjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLWI4NzUwNzkwOGVkNTE1M2YxNGY3ZTNiMCIsImF0IjoiMjAyNi0wOC0yOVQwNTo0NToyNS4wMzJaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlc29sdmUgcmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOU86NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImF0IjoiMjAyNi0wOC0yOVQwNTo0NTo1Ny40NTNaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVzb2x2ZSIsIm9wZXJhdGlvbklkIjoicmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZFIwOU86NWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tYzBkNDRhNTAzNjIzYjU1ZGFmMTY5MWZiIiwiYXQiOiIyMDI2LTA4LTI5VDA1OjQ1OjU3LjQ0NloifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGluZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMjlUMDU6NDk6MTUuNTY0WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBpbmV4YWN0LW9wZXJhdG9yLWRlY2lzaW9uLWF1dGhvcml0eS1yNCBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTI5VDA1OjU0OjM2LjE4M1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJhYmFuZG9uZWQiLCJzdW1tYXJ5IjoiQXJjaGl2ZWQgd2l0aG91dCBjb21wbGV0aW9uOiBTdXBlcnNlZGVkIGFmdGVyIHRoZSBzY29wZS1jb250cm9sIGpvdXJuYWwgcmVhY2hlZCBpdHMgYm91bmRlZCBjYXBhY2l0eSBhbmQgdGhlIGxhc3Qgc2NoZW1hLXZhbGlkIGNvbXBhY3QgZXhhY3QtaGVhZCBwYWlyIHdhcyBmb3VuZCBub25jYW5vbmljYWwgYmVjYXVzZSBpdCBhZ2dyZWdhdGVkIHNlcGFyYXRlbHkgcmVxdWlyZWQgbWVjaGFuaXNtcyBhbmQgb21pdHRlZCByZWNvcmRlZCBtYXRlcmlhbCBpbnZlbnRvcnk7IHByZXNlcnZlIHJldmlzaW9uIDU1IGFzIGltbXV0YWJsZSByZWNvdmVyeSBldmlkZW5jZSBhbmQgcmVzdGFydCBhdCB1bmNoYW5nZWQgY2xlYW4gSEVBRCA1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIHdpdGggYSBmcmVzaCBjYW5vbmljYWwgam91cm5hbC4iLCJhdCI6IjIwMjYtMDgtMjlUMDU6NTc6MzkuMTAzWiJ9Cg==',
    'eyJzY2hlbWFWZXJzaW9uIjozLCJyZXZpc2lvbiI6NDIsInJlcG9zaXRvcnkiOiJmdXJpbnZhZGVyL2FlcnN0ZWxsbyIsInByTnVtYmVyIjo2MCwicGhhc2UiOiJ0cmlhZ2luZyIsImJhc2VTaGEiOiI2MDc0NGZlMjIxZGJlNGM4NjA5Y2RmMTY0N2QzY2UzN2ZiOWVjYmJlIiwicmVxdWVzdGVkSGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJyZXZpZXdlZEhlYWRTaGEiOiJlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiY3VycmVudEludGVncmF0aW9uSGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJyZXZpZXdSb3VuZCI6MSwidmVyaWZpY2F0aW9uUmV2aWV3VXNlZCI6ZmFsc2UsInJldmlld1JlcXVlc3RMaW1pdCI6bnVsbCwibGVnYWN5UmV2aWV3UHJvdmVuYW5jZSI6bnVsbCwicmVsZWFzZUJhc2VsaW5lIjpudWxsLCJkZWNpc2lvbnMiOltdLCJ0YXNrcyI6W3siaWQiOiJhbGlnbi1oYW5kb2ZmLWZvbGxvd3VwLWRvbWFpbi1yNCIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjpoYW5kb2ZmLWZvbGxvd3VwLWRvbWFpbi1yNCJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtbG9jYWwtdmVyaWZpZXItaGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiLCJzdW1tYXJ5IjoiQWxpZ24gaGFuZG9mZiBkZWZlcnJlZC1mb2xsb3ctdXAgYm91bmRzIHdpdGggdGhlIGNhbm9uaWNhbCBtaW5pbWFsLWNsb3N1cmUgZG9tYWluLiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkFscmVhZHkgZml4ZWQgaW4gdGhlIElzc3VlICM1NSBpbXBsZW1lbnRhdGlvbiBhbmQgcHJlc2VudCBhdCBiNmUzN2VmNThlMzcyZWZiYzk3NTY4NWE4NTU1ZDNkMmIyOTE2OTFlOyBpbW11dGFibGUgcGFja2V0L3Jlc3VsdCBhbmQgdmVyaWZpZXIgZXZpZGVuY2UgcmVtYWluIHByZXNlcnZlZCBpbiBwci02MC0yMDI2LTA4LTMwVDA4LTM4LTM0LTg4M1ouIn0seyJpZCI6ImVuZm9yY2UtZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0Iiwic291cmNlSWRzIjpbImxvY2FsOmludGVncmF0aW9uLXZlcmlmaWVyOmV4YWN0LW9wZXJhdG9yLWRlY2lzaW9uLWF1dGhvcml0eS1yNCJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtbG9jYWwtdmVyaWZpZXItZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0Iiwic3VtbWFyeSI6IkVuZm9yY2UgZXhhY3Qgb3JkZXJlZCBvcGVyYXRvci1kZWNpc2lvbiBhdXRob3JpdHkgYW5kIGdsb2JhbGx5IHVuaXF1ZSBkZWNpc2lvbiBJRHMuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBpbiB0aGUgSXNzdWUgIzU1IGltcGxlbWVudGF0aW9uIGFuZCBwcmVzZW50IGF0IGI2ZTM3ZWY1OGUzNzJlZmJjOTc1Njg1YTg1NTVkM2QyYjI5MTY5MWU7IGltbXV0YWJsZSBwYWNrZXQvcmVzdWx0IGFuZCB2ZXJpZmllciBldmlkZW5jZSByZW1haW4gcHJlc2VydmVkIGluIHByLTYwLTIwMjYtMDgtMzBUMDgtMzgtMzQtODgzWi4ifSx7ImlkIjoiY2xhc3NpZnktY3VycmVudC11bmluY29ycG9yYXRlZC1zY29wZS1kZWNpc2lvbi1yNSIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjp1bmluY29ycG9yYXRlZC1kZWNpc2lvbi1zdGF0ZS1yNSJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtdW5pbmNvcnBvcmF0ZWQtZGVjaXNpb24tc3RhdGUtcjUiLCJzdW1tYXJ5IjoiQ2xhc3NpZnkgb25seSB0aGUgZXhhY3Qgc3RpbGwtcGVuZGluZyBtYXRlcmlhbCBkZWNpc2lvbiBhcyB1bmluY29ycG9yYXRlZCBkdXJpbmcgY2xvc3VyZSByZXBsYXkuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBpbiB0aGUgSXNzdWUgIzU1IGltcGxlbWVudGF0aW9uIGFuZCBwcmVzZW50IGF0IGI2ZTM3ZWY1OGUzNzJlZmJjOTc1Njg1YTg1NTVkM2QyYjI5MTY5MWU7IGltbXV0YWJsZSBwYWNrZXQvcmVzdWx0IGFuZCB2ZXJpZmllciBldmlkZW5jZSByZW1haW4gcHJlc2VydmVkIGluIHByLTYwLTIwMjYtMDgtMzBUMDgtMzgtMzQtODgzWi4ifSx7ImlkIjoidmFsaWRhdGUtc2NvcGUtZGVjaXNpb24tcmVjb3Zlcnktc2VtYW50aWNzLXI1Iiwic291cmNlSWRzIjpbImxvY2FsOmludGVncmF0aW9uLXZlcmlmaWVyOnNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LW5vdC1zZW1hbnRpYy1yNSJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtc2NvcGUtZGVjaXNpb24tcmVjb3Zlcnktbm90LXNlbWFudGljLXI1Iiwic3VtbWFyeSI6IlZhbGlkYXRlIGludGVycnVwdGVkIHNjb3BlLWRlY2lzaW9uIHJlY292ZXJ5IHNlbWFudGljYWxseSBiZWZvcmUgZHVyYWJsZSB3cml0ZXMuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBpbiB0aGUgSXNzdWUgIzU1IGltcGxlbWVudGF0aW9uIGFuZCBwcmVzZW50IGF0IGI2ZTM3ZWY1OGUzNzJlZmJjOTc1Njg1YTg1NTVkM2QyYjI5MTY5MWU7IGltbXV0YWJsZSBwYWNrZXQvcmVzdWx0IGFuZCB2ZXJpZmllciBldmlkZW5jZSByZW1haW4gcHJlc2VydmVkIGluIHByLTYwLTIwMjYtMDgtMzBUMDgtMzgtMzQtODgzWi4ifSx7ImlkIjoiYWxpZ24tZm9sbG93dXAtY29kZXBvaW50LXBhcml0eS1yNSIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjpmb2xsb3d1cC1jb2RlcG9pbnQtcGFyaXR5LXI1Il0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1mb2xsb3d1cC1jb2RlcG9pbnQtcGFyaXR5LXI1Iiwic3VtbWFyeSI6IkFsaWduIGRlZmVycmVkIGZvbGxvdy11cCByZWZlcmVuY2UgbGVuZ3RoIHdpdGggSlNPTiBTY2hlbWEgVW5pY29kZSBjb2RlLXBvaW50IHNlbWFudGljcy4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGluIHRoZSBJc3N1ZSAjNTUgaW1wbGVtZW50YXRpb24gYW5kIHByZXNlbnQgYXQgYjZlMzdlZjU4ZTM3MmVmYmM5NzU2ODVhODU1NWQzZDJiMjkxNjkxZTsgaW1tdXRhYmxlIHBhY2tldC9yZXN1bHQgYW5kIHZlcmlmaWVyIGV2aWRlbmNlIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQwOC0zOC0zNC04ODNaLiJ9LHsiaWQiOiJjb3JyZWxhdGUtaW1wb3J0ZWQtYXBwcm92ZWQtZGVjaXNpb24tYXV0aG9yaXR5LXIxMyIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjppbXBvcnRlZC1hcHByb3ZlZC1kZWNpc2lvbnMtcjEzIl0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1pbXBvcnRlZC1hcHByb3ZlZC1kZWNpc2lvbnMtcjEzIiwic3VtbWFyeSI6IkJpbmQgaW1wb3J0ZWQgYXBwcm92ZWQtZGVjaXNpb24gcmVjZWlwdHMgdG8gZXhhY3QgYXNzZXNzbWVudCBhdXRob3JpdHkuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBpbiB0aGUgSXNzdWUgIzU1IGltcGxlbWVudGF0aW9uIGFuZCBwcmVzZW50IGF0IGI2ZTM3ZWY1OGUzNzJlZmJjOTc1Njg1YTg1NTVkM2QyYjI5MTY5MWU7IGltbXV0YWJsZSBwYWNrZXQvcmVzdWx0IGFuZCB2ZXJpZmllciBldmlkZW5jZSByZW1haW4gcHJlc2VydmVkIGluIHByLTYwLTIwMjYtMDgtMzBUMDgtMzgtMzQtODgzWi4ifSx7ImlkIjoiYWxsb3ctbG9jYWwtYXJjaGl2ZS12ZXJpZmllci1ib290c3RyYXAtcjE0Iiwic291cmNlSWRzIjpbImxvY2FsOm9yY2hlc3RyYXRvcjphcmNoaXZlLWxvY2FsLWJvb3RzdHJhcC1yMTQiXSwic291cmNlVHlwZSI6ImxvY2FsIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LWxvY2FsLWFyY2hpdmUtYm9vdHN0cmFwLXIxNCIsInN1bW1hcnkiOiJQZXJtaXQgYSB0cnV0aGZ1bCBsb2NhbCB2ZXJpZmllciByZW1lZGlhdGlvbiB0byBib290c3RyYXAgcmVzb2x2ZWQtcm9vdCBhcmNoaXZlIGFkb3B0aW9uLiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkFscmVhZHkgZml4ZWQgaW4gdGhlIElzc3VlICM1NSBpbXBsZW1lbnRhdGlvbiBhbmQgcHJlc2VudCBhdCBiNmUzN2VmNThlMzcyZWZiYzk3NTY4NWE4NTU1ZDNkMmIyOTE2OTFlOyBpbW11dGFibGUgcGFja2V0L3Jlc3VsdCBhbmQgdmVyaWZpZXIgZXZpZGVuY2UgcmVtYWluIHByZXNlcnZlZCBpbiBwci02MC0yMDI2LTA4LTMwVDA4LTM4LTM0LTg4M1ouIn0seyJpZCI6ImFjY2VwdC1sb2NhbC1wcm9vZi1mb3ItcHJvZHVjdGlvbi1hcmNoaXZlLWltcG9ydC1yMTUiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6bG9jYWwtYXJjaGl2ZS1pbXBvcnQtcG9saWN5LXIxNSJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtcHJvZHVjdGlvbi1hcmNoaXZlLWltcG9ydC1sb2NhbC1wcm9vZi1yMTUiLCJzdW1tYXJ5IjoiQWNjZXB0IGV4YWN0bHkgb25lIHNvdXJjZS1tYXRjaGluZyBjdXJyZW50LUhFQUQgbG9jYWwgb3IgR2l0SHViLXRocmVhZGxlc3MgYm9vdHN0cmFwIHByb29mIGluIHRoZSBwcm9kdWN0aW9uIGFyY2hpdmUtaW1wb3J0IHRyYW5zaXRpb24gcG9saWN5LiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkFscmVhZHkgZml4ZWQgaW4gdGhlIElzc3VlICM1NSBpbXBsZW1lbnRhdGlvbiBhbmQgcHJlc2VudCBhdCBiNmUzN2VmNThlMzcyZWZiYzk3NTY4NWE4NTU1ZDNkMmIyOTE2OTFlOyBpbW11dGFibGUgcGFja2V0L3Jlc3VsdCBhbmQgdmVyaWZpZXIgZXZpZGVuY2UgcmVtYWluIHByZXNlcnZlZCBpbiBwci02MC0yMDI2LTA4LTMwVDA4LTM4LTM0LTg4M1ouIn0seyJpZCI6InJlY29nbml6ZS10ZXJtaW5hbC1wcm9vZmxlc3MtbGluZWFnZS1wcmVkZWNlc3NvcnMtcjE2Iiwic291cmNlSWRzIjpbImxvY2FsOm9yY2hlc3RyYXRvcjphcmNoaXZlLWxpbmVhZ2UtcHJvb2ZsZXNzLXByZWRlY2Vzc29yLXIxNiJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtYXJjaGl2ZS1saW5lYWdlLXByb29mbGVzcy1wcmVkZWNlc3Nvci1yMTYiLCJzdW1tYXJ5IjoiUmVjb2duaXplIGV4YWN0IHRlcm1pbmFsIHByb29mbGVzcyBwcmVkZWNlc3Nvci1vbmx5IGNhcnJpZXJzIHdpdGhvdXQgcmVsYXhpbmcgb2ZmLXNlbGVjdGlvbiBhcmNoaXZlIGFtYmlndWl0eS4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGluIHRoZSBJc3N1ZSAjNTUgaW1wbGVtZW50YXRpb24gYW5kIHByZXNlbnQgYXQgYjZlMzdlZjU4ZTM3MmVmYmM5NzU2ODVhODU1NWQzZDJiMjkxNjkxZTsgaW1tdXRhYmxlIHBhY2tldC9yZXN1bHQgYW5kIHZlcmlmaWVyIGV2aWRlbmNlIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQwOC0zOC0zNC04ODNaLiJ9LHsiaWQiOiJjbG9zZS1wcmVkZWNlc3Nvci1sYW5lLWFuZC1ib3VuZC1nYXBzLXIxNyIsInNvdXJjZUlkcyI6WyJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjpjcm9zcy1sYW5lLXByZWRlY2Vzc29yLWF1dGhvcml0eS1yMTciLCJsb2NhbDppbnRlZ3JhdGlvbi12ZXJpZmllcjpwcmVkZWNlc3Nvci1jdW11bGF0aXZlLW5vZGUtYm91bmQtcjE3Il0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1wcmVkZWNlc3Nvci1sYW5lLWFuZC1ib3VuZC1yMTciLCJzdW1tYXJ5IjoiQ2xvc2UgY3Jvc3MtbGFuZSBwcmVkZWNlc3NvciBkdXBsaWNhdGlvbiBhbmQgZXhhY3QgY2Fycmllci9yb290IG5vZGUgYWNjb3VudGluZy4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGluIHRoZSBJc3N1ZSAjNTUgaW1wbGVtZW50YXRpb24gYW5kIHByZXNlbnQgYXQgYjZlMzdlZjU4ZTM3MmVmYmM5NzU2ODVhODU1NWQzZDJiMjkxNjkxZTsgaW1tdXRhYmxlIHBhY2tldC9yZXN1bHQgYW5kIHZlcmlmaWVyIGV2aWRlbmNlIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQwOC0zOC0zNC04ODNaLiJ9LHsiaWQiOiJyZWplY3QtZXF1YWwtcHJlZGVjZXNzb3Itc3VjY2Vzc29yLWNvbW1pdC1yMTgiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6cHJlZGVjZXNzb3Itc3VjY2Vzc29yLWNvbW1pdC1kaXN0aW5jdG5lc3MtcjE4Il0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1wcmVkZWNlc3Nvci1zdWNjZXNzb3ItY29tbWl0LWRpc3RpbmN0bmVzcy1yMTgiLCJzdW1tYXJ5IjoiUmVqZWN0IGVxdWFsIHByZWRlY2Vzc29yIGFuZCBhbmNob3JlZCBzdWNjZXNzb3IgaW50ZWdyYXRpb24gY29tbWl0cy4iLCJzZXZlcml0eSI6IlAxIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGluIHRoZSBJc3N1ZSAjNTUgaW1wbGVtZW50YXRpb24gYW5kIHByZXNlbnQgYXQgYjZlMzdlZjU4ZTM3MmVmYmM5NzU2ODVhODU1NWQzZDJiMjkxNjkxZTsgaW1tdXRhYmxlIHBhY2tldC9yZXN1bHQgYW5kIHZlcmlmaWVyIGV2aWRlbmNlIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQwOC0zOC0zNC04ODNaLiJ9LHsiaWQiOiJkb2N1bWVudC1wcmVkZWNlc3Nvci1zdWNjZXNzb3ItY29tbWl0LWRpc3RpbmN0bmVzcy1yMTkiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6cHJlZGVjZXNzb3Itc3VjY2Vzc29yLWNvbnRyYWN0LWRvYy1yMTkiXSwic291cmNlVHlwZSI6ImxvY2FsIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXByZWRlY2Vzc29yLXN1Y2Nlc3Nvci1jb250cmFjdC1kb2MtcjE5Iiwic3VtbWFyeSI6IkRvY3VtZW50IGJvdGggcHJlZGVjZXNzb3IgY29tbWl0LWRpc3RpbmN0bmVzcyBjb25zdHJhaW50cy4iLCJzZXZlcml0eSI6IlAyIiwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVzb2x1dGlvblN1bW1hcnkiOiJBbHJlYWR5IGZpeGVkIGluIHRoZSBJc3N1ZSAjNTUgaW1wbGVtZW50YXRpb24gYW5kIHByZXNlbnQgYXQgYjZlMzdlZjU4ZTM3MmVmYmM5NzU2ODVhODU1NWQzZDJiMjkxNjkxZTsgaW1tdXRhYmxlIHBhY2tldC9yZXN1bHQgYW5kIHZlcmlmaWVyIGV2aWRlbmNlIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQwOC0zOC0zNC04ODNaLiJ9LHsiaWQiOiJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjIwIiwic291cmNlSWRzIjpbInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOHIiLCJkaXNjdXNzaW9uOjM4ODMzOTc0NjkiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDh6IiwiZGlzY3Vzc2lvbjozODgzMzk3NDc5IiwidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA4MiIsImRpc2N1c3Npb246Mzg4MzM5NzQ4OCIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwODUiLCJkaXNjdXNzaW9uOjM4ODMzOTc0OTIiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDg5IiwiZGlzY3Vzc2lvbjozODgzMzk3NDk3IiwidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA5QiIsImRpc2N1c3Npb246Mzg4MzM5NzUwMyIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOUkiLCJkaXNjdXNzaW9uOjM4ODMzOTc1MTIiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDlPIiwiZGlzY3Vzc2lvbjozODgzMzk3NTIyIl0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXJlc29sdmVkLWNvZGV4LXJvb3QtYWdncmVnYXRlLXIyMCIsInN1bW1hcnkiOiJSZWNvdmVyIHRoZSBlaWdodCBpbW11dGFibGUgYWxyZWFkeS1yZXNvbHZlZCBJc3N1ZSAjNTUgQ29kZXggcm9vdHMgYWZ0ZXIgdGhlIHZlcmlmaWVkIHIxOSBsaW5lYWdlIGNsb3N1cmUuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxsIGVpZ2h0IGNhbm9uaWNhbCByb290cyBhcmUgYWxyZWFkeSByZXNvbHZlZCB3aXRoIGltbXV0YWJsZSByZXBsaWVzLiBBZ2dyZWdhdGUgYWRvcHRpb24gYXdhaXRzIGV4YWN0IGxvY2FsIHZlcmlmaWNhdGlvbiBvZiB0aGUgc29sZSBQMiByZW1lZGlhdGlvbi4ifSx7ImlkIjoicmVqZWN0LW1hbGZvcm1lZC1hcHByb3ZlZC1kZWNpc2lvbi1jcmFzaC1yMTQiLCJzb3VyY2VJZHMiOlsibG9jYWw6aW50ZWdyYXRpb24tdmVyaWZpZXI6bWFsZm9ybWVkLWFwcHJvdmVkLWRlY2lzaW9ucy1yMTQiXSwic291cmNlVHlwZSI6ImxvY2FsIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LW1hbGZvcm1lZC1hcHByb3ZlZC1kZWNpc2lvbnMtcjE0Iiwic3VtbWFyeSI6IlJldHVybiBzdHJ1Y3R1cmVkIHZhbGlkYXRpb24gZXJyb3JzIGZvciBtYWxmb3JtZWQgYXBwcm92ZWQtZGVjaXNpb24gZW50cmllcy4iLCJzZXZlcml0eSI6IlAyIiwiZGlzcG9zaXRpb24iOiJhY3Rpb25hYmxlIiwic3RhdHVzIjoiY29tcGxldGVkIiwiaW50ZWdyYXRlZENvbW1pdFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkludGVncmF0ZWQgY2VudHJhbGx5OyB0YXJnZXRlZCB2YWxpZGF0aW9uIGFuZCBleGFjdC1oZWFkIHZlcmlmaWNhdGlvbiByZW1haW4uIiwidGFza1BhY2tldERpZ2VzdCI6ImI5MDQ4ZjA1ZDY4NDQ3MjljM2Q2ZTc2ODIyMmNkMDAyZjdkYzc5ZDBiYTkzN2YwYjMxN2EyMTA0YjZhOTI5NmIiLCJ3b3JrZXJSZXN1bHREaWdlc3QiOiI0OWYwMjU3MmVjMWQyYjIyMjY3MDljNmQ2OGM3NzkyNGViNTNiYmQwMDljYmFhOGJhMzQ3NGFmM2M3YjBlNjM2In1dLCJyZXZpZXdSZXF1ZXN0Ijp7ImlkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJlb2pqUSIsImRhdGFiYXNlSWQiOjU0Njc5Mzk3MjUsInVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2lzc3VlY29tbWVudC01NDY3OTM5NzI1IiwiaGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJhdCI6IjIwMjYtMDgtMzBUMDk6NDA6NDNaIiwia2luZCI6ImRpc2NvdmVyeSIsImJvZHkiOiJAY29kZXggcmV2aWV3IiwiYXV0aG9yTG9naW4iOiJmdXJpbnZhZGVyIiwiYXV0aG9yTm9kZUlkIjoiTURRNlZYTmxjalF5TmpZeE1EYz0ifSwicmV2aWV3T3V0Y29tZSI6eyJpZCI6IlBSUl9rd0RPVHFPZHJNOEFBQUFCTGFETVdRIiwiZGF0YWJhc2VJZCI6NTA2MDQ4MDA4OSwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjcHVsbHJlcXVlc3RyZXZpZXctNTA2MDQ4MDA4OSIsImhlYWRTaGEiOiJlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiYXQiOiIyMDI2LTA4LTMwVDA5OjUxOjIxWiIsInJlcXVlc3RJZCI6IklDX2t3RE9UcU9kck04QUFBQUJSZW9qalEiLCJraW5kIjoiZGlzY292ZXJ5Iiwib3V0Y29tZSI6ImZpbmRpbmdzIiwiZXZpZGVuY2VUeXBlIjoicmV2aWV3LXN1Ym1pc3Npb24iLCJyZXZpZXdlckxvZ2luIjoiY2hhdGdwdC1jb2RleC1jb25uZWN0b3IiLCJyZXZpZXdlck5vZGVJZCI6IkJPVF9rZ0RPQzk4c19nIiwicmV2aWV3ZXJUeXBlIjoiQm90IiwicmV2aWV3ZXJVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vYXBwcy9jaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJlYWN0aW9uQ29udGVudCI6bnVsbCwicmVhY3Rpb25Db21tZW50SWQiOm51bGx9LCJyZXZpZXdIaXN0b3J5IjpbeyJyZXF1ZXN0Ijp7ImlkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJlb2pqUSIsImRhdGFiYXNlSWQiOjU0Njc5Mzk3MjUsInVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2lzc3VlY29tbWVudC01NDY3OTM5NzI1IiwiaGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJhdCI6IjIwMjYtMDgtMzBUMDk6NDA6NDNaIiwia2luZCI6ImRpc2NvdmVyeSIsImJvZHkiOiJAY29kZXggcmV2aWV3IiwiYXV0aG9yTG9naW4iOiJmdXJpbnZhZGVyIiwiYXV0aG9yTm9kZUlkIjoiTURRNlZYTmxjalF5TmpZeE1EYz0ifSwib3V0Y29tZSI6eyJpZCI6IlBSUl9rd0RPVHFPZHJNOEFBQUFCTGFETVdRIiwiZGF0YWJhc2VJZCI6NTA2MDQ4MDA4OSwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjcHVsbHJlcXVlc3RyZXZpZXctNTA2MDQ4MDA4OSIsImhlYWRTaGEiOiJlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiYXQiOiIyMDI2LTA4LTMwVDA5OjUxOjIxWiIsInJlcXVlc3RJZCI6IklDX2t3RE9UcU9kck04QUFBQUJSZW9qalEiLCJraW5kIjoiZGlzY292ZXJ5Iiwib3V0Y29tZSI6ImZpbmRpbmdzIiwiZXZpZGVuY2VUeXBlIjoicmV2aWV3LXN1Ym1pc3Npb24iLCJyZXZpZXdlckxvZ2luIjoiY2hhdGdwdC1jb2RleC1jb25uZWN0b3IiLCJyZXZpZXdlck5vZGVJZCI6IkJPVF9rZ0RPQzk4c19nIiwicmV2aWV3ZXJUeXBlIjoiQm90IiwicmV2aWV3ZXJVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vYXBwcy9jaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJlYWN0aW9uQ29udGVudCI6bnVsbCwicmVhY3Rpb25Db21tZW50SWQiOm51bGx9fV0sInN0YWxlRGlzY292ZXJ5RGlzcG9zaXRpb25zIjpbXSwidmVyaWZpY2F0aW9uRXNjYWxhdGlvbiI6bnVsbCwidGhyZWFkUmVzb2x1dGlvblN0YXR1cyI6eyJzdGF0dXMiOiJwYXNzZWQiLCJoZWFkU2hhIjoiZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiIsInRocmVhZHMiOlt7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA4MiIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0Z3Iiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NDg4LCJ0YXNrSWRzIjpbInJlY292ZXItcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjAiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTBnSCIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcxMzQxNSIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjM3OjMxLjA3MloiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhcmNoaXZlUHJvdmVuYW5jZSI6eyJzY2hlbWFWZXJzaW9uIjoxLCJoaXN0b3JpY2FsVGFza0lkIjoiYmluZC1hY3RpdmUtc2NvcGUtYXV0aG9yaXR5LXIxIiwiaGlzdG9yaWNhbERpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsImhpc3RvcmljYWxJbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXBseUJvZHlTaGEyNTYiOiIyNTM5OWExNzk4YzU1MzQ0NTU0MDU4ZWU0ZGI0OGZmNmZjZmU0ZTYxZGUwMzhjYThhZjdkZjU4M2YxYTUzODdhIiwiYXV0aG9yaXR5RmluZ2VycHJpbnQiOiI3NzdlZWI2ZTY5YjQ0OGQwOTg4MzgwMDQyOTIxMTA1NTkzMzU1MTI0NGUzNGM5MWVjODJjNjdkODRmMGM1OWE2In19LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDg1Iiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRjAiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0OTIsInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyMCJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tMmFyIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzIxMjU5IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6NDE6NTkuODQxWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJlbmZvcmNlLXNjb3BlLWFkbWlzc2lvbi1zZW1hbnRpY3MtcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6IjNmNmJhYWE3N2NlMTAyZWNlNTczYjU1ZmMxZmQwOTJhMjYyMDNjOWQxYzZlZGU4YzI4YjIwNDIzYTE1ZTgwOTciLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwODkiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GNSIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzQ5NywidGFza0lkcyI6WyJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjIwIl0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0zSTYiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MjQyMTgiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTo0Mjo1OS40NzFaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXJjaGl2ZVByb3ZlbmFuY2UiOnsic2NoZW1hVmVyc2lvbiI6MSwiaGlzdG9yaWNhbFRhc2tJZCI6ImVuZm9yY2Utc2NvcGUtYWRtaXNzaW9uLXNlbWFudGljcy1yMSIsImhpc3RvcmljYWxEaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJoaXN0b3JpY2FsSW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVwbHlCb2R5U2hhMjU2IjoiZjlkNDRkOTU5M2Q4MDYzMmQ5MTQ3ZjczNmU1NTJmYjMzMjQ4YTY4ZDk1MzM3NGRlZDJkYjM2OWE4YjI4YmI0YyIsImF1dGhvcml0eUZpbmdlcnByaW50IjoiNzc3ZWViNmU2OWI0NDhkMDk4ODM4MDA0MjkyMTEwNTU5MzM1NTEyNDRlMzRjOTFlYzgyYzY3ZDg0ZjBjNTlhNiJ9fSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA4ciIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0ZkIiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NDY5LCJ0YXNrSWRzIjpbInJlY292ZXItcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjAiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTA5eiIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcxNTMxNSIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjM4OjMyLjUxOFoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhcmNoaXZlUHJvdmVuYW5jZSI6eyJzY2hlbWFWZXJzaW9uIjoxLCJoaXN0b3JpY2FsVGFza0lkIjoiYmluZC1hY3RpdmUtc2NvcGUtYXV0aG9yaXR5LXIxIiwiaGlzdG9yaWNhbERpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsImhpc3RvcmljYWxJbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXBseUJvZHlTaGEyNTYiOiJhMGZiMjA4ZjA1ODUwNjZjYjcyM2E0NzM3ZjJlNGExNzlkMmI4N2I0NjBkODUwMjViYTQ1NzdhZDkxYzk3OWYxIiwiYXV0aG9yaXR5RmluZ2VycHJpbnQiOiI3NzdlZWI2ZTY5YjQ0OGQwOTg4MzgwMDQyOTIxMTA1NTkzMzU1MTI0NGUzNGM5MWVjODJjNjdkODRmMGM1OWE2In19LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDh6Iiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRm4iLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0NzksInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyMCJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tMVhjIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzE2OTU2IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6Mzk6MzcuNjk4WiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJiaW5kLWFjdGl2ZS1zY29wZS1hdXRob3JpdHktcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6Ijg0OTA4ZWFjNTdhMWIxMmI2ZTEyNmU4ODliODU0MzYyN2M2M2IzNDkyZDc5NTY2OGQzODYyMmI0ZWFhYTkwZGYiLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwOUIiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GXyIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzUwMywidGFza0lkcyI6WyJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjIwIl0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0zbjIiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MjYxOTgiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTo0Mzo1Ny44MzBaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXJjaGl2ZVByb3ZlbmFuY2UiOnsic2NoZW1hVmVyc2lvbiI6MSwiaGlzdG9yaWNhbFRhc2tJZCI6ImVuZm9yY2Utc2NvcGUtYWRtaXNzaW9uLXNlbWFudGljcy1yMSIsImhpc3RvcmljYWxEaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJoaXN0b3JpY2FsSW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVwbHlCb2R5U2hhMjU2IjoiOTg5N2MwOWVhNDRmMDE2NGM3ZTVjMDFiZGY2NDM3NDBlYzc5NGRmZTQ3MGY0Njg4NTY5ODZhNzM4Nzc4MjIyMiIsImF1dGhvcml0eUZpbmdlcnByaW50IjoiNzc3ZWViNmU2OWI0NDhkMDk4ODM4MDA0MjkyMTEwNTU5MzM1NTEyNDRlMzRjOTFlYzgyYzY3ZDg0ZjBjNTlhNiJ9fSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA5SSIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0dJIiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NTEyLCJ0YXNrSWRzIjpbInJlY292ZXItcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjAiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTRjSiIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcyOTU0NSIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjQ1OjE2Ljc5OFoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhcmNoaXZlUHJvdmVuYW5jZSI6eyJzY2hlbWFWZXJzaW9uIjoxLCJoaXN0b3JpY2FsVGFza0lkIjoiY2xvc2UtYm91bmRlZC1hbWVuZG1lbnQtYXV0aG9yaXR5LXIxIiwiaGlzdG9yaWNhbERpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsImhpc3RvcmljYWxJbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXBseUJvZHlTaGEyNTYiOiIwZDI5NGI0ZTFjNzVkMWJlODM5NTVjZmM3NGVlODJjZDc4OTAwNmNhY2M1ZjA3ZjBiYzlkOGYxNDc2M2QzZGM3IiwiYXV0aG9yaXR5RmluZ2VycHJpbnQiOiI3NzdlZWI2ZTY5YjQ0OGQwOTg4MzgwMDQyOTIxMTA1NTkzMzU1MTI0NGUzNGM5MWVjODJjNjdkODRmMGM1OWE2In19LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDlPIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfR1MiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc1MjIsInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyMCJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tNDA2IiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzMxMTMwIiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6NDY6MTMuMzEwWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJjbG9zZS1ib3VuZGVkLWFtZW5kbWVudC1hdXRob3JpdHktcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6Ijg3NTczZGY2MDc1YmFkZDM3YjkwNjAxMmNjMWM2MWM0ODYwM2U3ZjZmNTRjM2YyYzQ5OGNkMzEwMjVlNWVkNzAiLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX1dLCJ0aHJlYWRsZXNzVmVyaWZpY2F0aW9uIjp7InN0YXR1cyI6Im5vdC1ydW4iLCJoZWFkU2hhIjpudWxsLCJ0YXNrSWRzIjpbXSwidXBkYXRlZEF0IjpudWxsfSwidXBkYXRlZEF0IjoiMjAyNi0wOC0zMFQwOTozNTo1Ni4yNTFaIiwibG9jYWxWZXJpZmljYXRpb24iOnsic3RhdHVzIjoicGFzc2VkIiwiaGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJ0YXNrSWRzIjpbImFjY2VwdC1sb2NhbC1wcm9vZi1mb3ItcHJvZHVjdGlvbi1hcmNoaXZlLWltcG9ydC1yMTUiLCJhbGlnbi1mb2xsb3d1cC1jb2RlcG9pbnQtcGFyaXR5LXI1IiwiYWxpZ24taGFuZG9mZi1mb2xsb3d1cC1kb21haW4tcjQiLCJhbGxvdy1sb2NhbC1hcmNoaXZlLXZlcmlmaWVyLWJvb3RzdHJhcC1yMTQiLCJjbGFzc2lmeS1jdXJyZW50LXVuaW5jb3Jwb3JhdGVkLXNjb3BlLWRlY2lzaW9uLXI1IiwiY2xvc2UtcHJlZGVjZXNzb3ItbGFuZS1hbmQtYm91bmQtZ2Fwcy1yMTciLCJjb3JyZWxhdGUtaW1wb3J0ZWQtYXBwcm92ZWQtZGVjaXNpb24tYXV0aG9yaXR5LXIxMyIsImRvY3VtZW50LXByZWRlY2Vzc29yLXN1Y2Nlc3Nvci1jb21taXQtZGlzdGluY3RuZXNzLXIxOSIsImVuZm9yY2UtZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0IiwicmVjb2duaXplLXRlcm1pbmFsLXByb29mbGVzcy1saW5lYWdlLXByZWRlY2Vzc29ycy1yMTYiLCJyZWplY3QtZXF1YWwtcHJlZGVjZXNzb3Itc3VjY2Vzc29yLWNvbW1pdC1yMTgiLCJyZWplY3QtbWFsZm9ybWVkLWFwcHJvdmVkLWRlY2lzaW9uLWNyYXNoLXIxNCIsInZhbGlkYXRlLXNjb3BlLWRlY2lzaW9uLXJlY292ZXJ5LXNlbWFudGljcy1yNSJdLCJ1cGRhdGVkQXQiOiIyMDI2LTA4LTMwVDA5OjM1OjU2LjI1MVoifX0sImJsb2NrZWRSZWFzb25zIjpbXSwidmFsaWRhdGlvblN0YXR1cyI6eyJzb3VyY2UiOiJvcmNoZXN0cmF0b3IiLCJzY29wZSI6InRhcmdldGVkIiwic3RhdHVzIjoicGFzc2VkIiwiaGVhZFNoYSI6ImU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJjaGVja3MiOlsibm9kZSAtLXRlc3QgLmFnZW50cy9za2lsbHMvcHItcmV2aWV3LWN5Y2xlL3NjcmlwdHMvY29udHJhY3RzL3Njb3BlLWNvbnRyb2wudGVzdC5tanMiLCJub2RlIC0tdGVzdCAuYWdlbnRzL3NraWxscy9jaGFuZ2UtZGV2ZWxvcG1lbnQvc2NyaXB0cy9oYW5kb2ZmL2NvbnRyYWN0cy50ZXN0Lm1qcyIsIm5wbSBydW4gY2hlY2s6d29ya2Zsb3ciXSwidXBkYXRlZEF0IjoiMjAyNi0wOC0zMFQwOTowODozOS43ODNaIn0sImNpVmFsaWRhdGlvblN0YXR1cyI6eyJzb3VyY2UiOiJnaXRodWItYWN0aW9ucyIsInNjb3BlIjoiZnVsbCIsInN0YXR1cyI6Im5vdC1ydW4iLCJoZWFkU2hhIjpudWxsLCJjaGVja3MiOltdLCJjaGVja1J1bklkIjpudWxsLCJ3b3JrZmxvd1J1bklkIjpudWxsLCJ3b3JrZmxvd1J1blVybCI6bnVsbCwidXBkYXRlZEF0IjpudWxsfSwiY2lWYWxpZGF0aW9uSGlzdG9yeSI6W10sIm5leHRBY3Rpb24iOiJUcmlhZ2UgdGhlIGFwcGxpY2FibGUgY2Fub25pY2FsIHJldmlldyBmaW5kaW5ncy4iLCJpbnRlZ3JhdGlvbldvcmt0cmVlIjoiL3RtcC9hZXJzdGVsbG8taXNzdWU1NS1yZXN0YXJ0LmNxcUJTUS9yZXBvIiwib3JjaGVzdHJhdG9yU2Vzc2lvbklkIjpudWxsLCJhYmFuZG9ubWVudFJlYXNvbiI6IlBSICM2MCBvZmZpY2lhbCByZXZpZXcgcm91bmQgMSBpcyBwcmVzZXJ2ZWQgYXQgZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiB3aXRoIGZvdXJ0ZWVuIGNvbXBsZXRlZCB0YXNrcywgZWlnaHQgYWRvcHRlZCBoaXN0b3JpY2FsIHRocmVhZCBwcm9vZnMsIHRhcmdldGVkIHZhbGlkYXRpb24sIGFuZCBpdHMgZXhhY3QgZm91ci1maW5kaW5nIG91dGNvbWUuIFRoZSByZWNlaXB0LWJhY2tlZCBzY29wZSBqb3VybmFsIHVzZXMgMjI2NDA0IG9mIDI2MjE0NCBieXRlcywgYW5kIGEgdHJ1dGhmdWwgdHdvLXJvb3QgcmVtZWRpYXRpb24gcGx1cyBmaW5hbCBpbnRlZ3JhdGVkLUhFQUQgYXNzZXNzbWVudCBjYW5ub3QgZml0LiBQcmVzZXJ2ZSB0aGlzIGN5Y2xlIGFuZCBhbGwgZXZpZGVuY2UgaW1tdXRhYmx5OyBjb250aW51ZSB0aGUgc2FtZSBQUiBhbmQgZXhhY3QgSEVBRCBpbiBhIGZyZXNoIGltcG9ydGVkLWF1dGhvcml0eSBjeWNsZSBmb3IgdGhlIGZvdXIgb2ZmaWNpYWwgc2NvcGUtY29udHJhY3QgZmluZGluZ3MuIiwiZ2l0Ijp7ImJyYW5jaCI6ImFnZW50L2lzc3VlLTU1LW1pbmltYWwtc2NvcGUtcjIiLCJoZWFkU2hhIjoiZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiIsImRpcnR5IjpmYWxzZX0sInVwZGF0ZWRBdCI6IjIwMjYtMDgtMzBUMTA6MjM6NDQuNzY1WiIsInNjb3BlQ29udHJvbCI6eyJhdXRob3JpdHlEaWdlc3QiOiJzaGEyNTY6ZjhmNzNmN2MyZmIxMDgwZGQ2NWYzZTJjNTM3NDIwYmY1ZjE1ZTA0YTk1N2NkNTYxZmM5YWY3ZTdhMDAyMjNjZCIsImpvdXJuYWxEaWdlc3QiOiJzaGEyNTY6OWE2ZWM0Mjk2YmM4NjkzYWQ0YjExYmRjM2YxOTVkMGJiM2RlYjdiM2E0NDU1OWFmZDY4ZWQ0MDkwNmEzYTkzNCIsInJldHVybkRpZ2VzdCI6bnVsbCwiZ2F0ZSI6InJlYWR5IiwiYXNzZXNzbWVudEhlYWRTaGEiOiJlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwidXBkYXRlZEF0IjoiMjAyNi0wOC0zMFQwOTozMToyMi4zNDRaIn19Cg==',
    'eyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiaW5pdGlhbGl6ZWQiLCJzdW1tYXJ5IjoiSW5pdGlhbGl6ZWQgUFIgNjAiLCJhdCI6IjIwMjYtMDgtMzBUMDg6NDE6MzQuODMzWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InJlY292ZXJlZC10YXNrcy1wcm9wb3NlZCIsInN1bW1hcnkiOiJSZWNvdmVyZWQgdHdlbHZlIGxvY2FsIGZpbmRpbmdzLCBvbmUgZnJlc2ggcmVzb2x2ZWQtcm9vdCBhZ2dyZWdhdGUsIGFuZCB0aGUgZGVmZXJyZWQgbWFsZm9ybWVkLWFwcHJvdmVkRGVjaXNpb25zIHJlcGFpciIsImF0IjoiMjAyNi0wOC0zMFQwODo0MTo1MC41MjBaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoicmVjb3ZlcmVkLXRhc2tzLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCB0d2VsdmUgcmV0YWluZWQgbG9jYWwgZmluZGluZ3MgYW5kIG9uZSByb290IGFnZ3JlZ2F0ZSBhcyBhbHJlYWR5IGZpeGVkLCByZXRhaW5pbmcgb25seSB0aGUgbWFsZm9ybWVkLWFwcHJvdmVkRGVjaXNpb25zIFAyIiwiYXQiOiIyMDI2LTA4LTMwVDA4OjQyOjA5LjU5OFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgbWFsZm9ybWVkLWFwcHJvdmVkLWRlY2lzaW9uLXNoYXBlLXIyMCBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDA4OjQzOjMxLjAwOFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXNrLXBhY2tldC1ib3VuZCIsInN1bW1hcnkiOiJCb3VuZCBhY2NlcHRlZCBwYWNrZXQgZm9yIHRhc2sgcmVqZWN0LW1hbGZvcm1lZC1hcHByb3ZlZC1kZWNpc2lvbi1jcmFzaC1yMTQiLCJhdCI6IjIwMjYtMDgtMzBUMDg6NDM6NTYuNTM2WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1zdGFydGVkIiwic3VtbWFyeSI6IlN0YXJ0ZWQgaXNvbGF0ZWQgd29ya2VyIGZvciByZWplY3QtbWFsZm9ybWVkLWFwcHJvdmVkLWRlY2lzaW9uLWNyYXNoLXIxNCIsImF0IjoiMjAyNi0wOC0zMFQwODo0NDoyMS41MjVaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoid29ya2VyLXJlc3VsdC1hY2NlcHRlZCIsInN1bW1hcnkiOiJBY2NlcHRlZCB3b3JrZXIgcmVzdWx0IGZvciB0YXNrIHJlamVjdC1tYWxmb3JtZWQtYXBwcm92ZWQtZGVjaXNpb24tY3Jhc2gtcjE0IiwiYXQiOiIyMDI2LTA4LTMwVDA4OjQ3OjEwLjMwMFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXQtY2hlY2twb2ludCIsInN1bW1hcnkiOiJDaGVja3BvaW50ZWQgaW50ZWdyYXRpb24gSEVBRCBlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiYXQiOiIyMDI2LTA4LTMwVDA4OjQ4OjE5LjkzMloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXNrLWludGVncmF0ZWQiLCJzdW1tYXJ5IjoiSW50ZWdyYXRlZCBleGFjdCB3b3JrZXIgcGF0Y2ggZm9yIHJlamVjdC1tYWxmb3JtZWQtYXBwcm92ZWQtZGVjaXNpb24tY3Jhc2gtcjE0IiwiYXQiOiIyMDI2LTA4LTMwVDA4OjQ4OjMxLjQ4NloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgbWFsZm9ybWVkLWFwcHJvdmVkLWRlY2lzaW9uLXNoYXBlLXIyMCBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDA4OjU5OjUyLjg5NFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjAgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTowMDozNS4zNTdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoidGFyZ2V0ZWQtdmFsaWRhdGlvbi1wbGFubmVkIiwic3VtbWFyeSI6IlNhdmVkIDMgdGFyZ2V0ZWQgY2hlY2tzIGZvciBlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiYXQiOiIyMDI2LTA4LTMwVDA5OjAwOjU3LjM0N1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXJnZXRlZC12YWxpZGF0aW9uLXJlY29yZGVkIiwic3VtbWFyeSI6IlJlY29yZGVkIHBhc3NlZCB0YXJnZXRlZCB2YWxpZGF0aW9uIGZvciBlOTFkYTJmZGRmMzUzNjczMjE1ZjkwMzQ3MzFlOTZlNzQwNTAzZWRiIiwiYXQiOiIyMDI2LTA4LTMwVDA5OjA4OjM5Ljc5N1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgaGFuZG9mZi1mb2xsb3d1cC1kb21haW4tbWlzbWF0Y2gtcjQgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTozMToxMy4wMzFaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGluZXhhY3Qtb3BlcmF0b3ItZGVjaXNpb24tYXV0aG9yaXR5LXI0IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTMuNzg0WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCB1bmluY29ycG9yYXRlZC1kZWNpc2lvbi1zdGF0ZS1yNSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDA5OjMxOjE0LjUzMloifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgc2NvcGUtZGVjaXNpb24tcmVjb3Zlcnktbm90LXNlbWFudGljLXI1IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTUuMjg5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBmb2xsb3d1cC1jb2RlcG9pbnQtcGFyaXR5LXI1IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTYuMDYxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBpbXBvcnRlZC1hcHByb3ZlZC1kZWNpc2lvbi1hdXRob3JpdHktcjEzIGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTYuODE5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBsb2NhbC1hcmNoaXZlLWJvb3RzdHJhcC1wcm9vZi1nYXAtcjE0IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTcuNjA3WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBwcm9kdWN0aW9uLWFyY2hpdmUtaW1wb3J0LWxvY2FsLXByb29mLWdhcC1yMTUgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTozMToxOC4zOTBaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIHRlcm1pbmFsLXByb29mbGVzcy1wcmVkZWNlc3Nvci1saW5lYWdlLWdhcC1yMTYgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTozMToxOS4xODdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIHByZWRlY2Vzc29yLWxhbmUtYW5kLWJvdW5kLWdhcHMtcjE3IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMDk6MzE6MTkuOTc0WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBwcmVkZWNlc3Nvci1zdWNjZXNzb3ItY29tbWl0LWRpc3RpbmN0bmVzcy1yMTggYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTozMToyMC43NzdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIHByZWRlY2Vzc29yLXN1Y2Nlc3Nvci1jb250cmFjdC1kb2N1bWVudGF0aW9uLXIxOSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDA5OjMxOjIxLjU5OFoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjAgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQwOTozMToyMi41MDdaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVxdWVzdCByZXF1ZXN0OjYwOmRpc2NvdmVyeToxOmU5MWRhMmZkZGYzNTM2NzMyMTVmOTAzNDczMWU5NmU3NDA1MDNlZGIiLCJhdCI6IjIwMjYtMDgtMzBUMDk6NDA6MjQuMjUyWiIsImRldGFpbHMiOnsidHlwZSI6InJlcXVlc3QiLCJvcGVyYXRpb25JZCI6InJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6ZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tYjllZDNjYTMxZGIwYzQ4MGY2NTMxNTFmIiwiYXQiOiIyMDI2LTA4LTMwVDA5OjQwOjEyLjUyMFoiLCJleGNsdWRlZENvbW1lbnRJZHMiOlsiSUNfa3dET1RxT2RyTThBQUFBQlJUNWVwZyJdfX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWRpc3BhdGNoIiwic3VtbWFyeSI6IkRpc3BhdGNoIHJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6ZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiIsImF0IjoiMjAyNi0wOC0zMFQwOTo0MDo0MS40MzZaIiwiZGV0YWlscyI6eyJvcGVyYXRpb25JZCI6InJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6ZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tYjllZDNjYTMxZGIwYzQ4MGY2NTMxNTFmIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImFiYW5kb25lZCIsInN1bW1hcnkiOiJBcmNoaXZlZCB3aXRob3V0IGNvbXBsZXRpb246IFBSICM2MCBvZmZpY2lhbCByZXZpZXcgcm91bmQgMSBpcyBwcmVzZXJ2ZWQgYXQgZTkxZGEyZmRkZjM1MzY3MzIxNWY5MDM0NzMxZTk2ZTc0MDUwM2VkYiB3aXRoIGZvdXJ0ZWVuIGNvbXBsZXRlZCB0YXNrcywgZWlnaHQgYWRvcHRlZCBoaXN0b3JpY2FsIHRocmVhZCBwcm9vZnMsIHRhcmdldGVkIHZhbGlkYXRpb24sIGFuZCBpdHMgZXhhY3QgZm91ci1maW5kaW5nIG91dGNvbWUuIFRoZSByZWNlaXB0LWJhY2tlZCBzY29wZSBqb3VybmFsIHVzZXMgMjI2NDA0IG9mIDI2MjE0NCBieXRlcywgYW5kIGEgdHJ1dGhmdWwgdHdvLXJvb3QgcmVtZWRpYXRpb24gcGx1cyBmaW5hbCBpbnRlZ3JhdGVkLUhFQUQgYXNzZXNzbWVudCBjYW5ub3QgZml0LiBQcmVzZXJ2ZSB0aGlzIGN5Y2xlIGFuZCBhbGwgZXZpZGVuY2UgaW1tdXRhYmx5OyBjb250aW51ZSB0aGUgc2FtZSBQUiBhbmQgZXhhY3QgSEVBRCBpbiBhIGZyZXNoIGltcG9ydGVkLWF1dGhvcml0eSBjeWNsZSBmb3IgdGhlIGZvdXIgb2ZmaWNpYWwgc2NvcGUtY29udHJhY3QgZmluZGluZ3MuIiwiYXQiOiIyMDI2LTA4LTMwVDEwOjIzOjQ0Ljc4NloifQo=',
    'eyJzY2hlbWFWZXJzaW9uIjozLCJyZXZpc2lvbiI6MjgsInJlcG9zaXRvcnkiOiJmdXJpbnZhZGVyL2FlcnN0ZWxsbyIsInByTnVtYmVyIjo2MCwicGhhc2UiOiJ0cmlhZ2luZyIsImJhc2VTaGEiOiI2MDc0NGZlMjIxZGJlNGM4NjA5Y2RmMTY0N2QzY2UzN2ZiOWVjYmJlIiwicmVxdWVzdGVkSGVhZFNoYSI6IjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJyZXZpZXdlZEhlYWRTaGEiOiIwYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiY3VycmVudEludGVncmF0aW9uSGVhZFNoYSI6IjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJyZXZpZXdSb3VuZCI6MSwidmVyaWZpY2F0aW9uUmV2aWV3VXNlZCI6ZmFsc2UsInJldmlld1JlcXVlc3RMaW1pdCI6bnVsbCwibGVnYWN5UmV2aWV3UHJvdmVuYW5jZSI6bnVsbCwicmVsZWFzZUJhc2VsaW5lIjpudWxsLCJkZWNpc2lvbnMiOltdLCJ0YXNrcyI6W3siaWQiOiJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjI1Iiwic291cmNlSWRzIjpbInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOHIiLCJkaXNjdXNzaW9uOjM4ODMzOTc0NjkiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDh6IiwiZGlzY3Vzc2lvbjozODgzMzk3NDc5IiwidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA4MiIsImRpc2N1c3Npb246Mzg4MzM5NzQ4OCIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwODUiLCJkaXNjdXNzaW9uOjM4ODMzOTc0OTIiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDg5IiwiZGlzY3Vzc2lvbjozODgzMzk3NDk3IiwidGhyZWFkOlBSUlRfa3dET1RxT2RyTTZkUjA5QiIsImRpc2N1c3Npb246Mzg4MzM5NzUwMyIsInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZFIwOUkiLCJkaXNjdXNzaW9uOjM4ODMzOTc1MTIiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRSMDlPIiwiZGlzY3Vzc2lvbjozODgzMzk3NTIyIl0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXJlc29sdmVkLWNvZGV4LXJvb3QtYWdncmVnYXRlLXIyNSIsInN1bW1hcnkiOiJSZWNvdmVyIHRoZSBlaWdodCBpbW11dGFibGUgYWxyZWFkeS1yZXNvbHZlZCBJc3N1ZSAjNTUgQ29kZXggcm9vdHMgdGhyb3VnaCBhIGdsb2JhbGx5IGZyZXNoIGFnZ3JlZ2F0ZSB0YXNrIGlkZW50aXR5LiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkVpZ2h0IGNhbm9uaWNhbCByb290cyByZW1haW4gcmVzb2x2ZWQgd2l0aCBpbW11dGFibGUgaGlzdG9yaWNhbCByZXBsaWVzOyBhZG9wdCB0aGVtIHRocm91Z2ggdGhlIGNhbm9uaWNhbCBhZ2dyZWdhdGUgYXJjaGl2ZSBwYXRoIGFmdGVyIGV4YWN0LUhFQUQgbG9jYWwgdmVyaWZpY2F0aW9uLiJ9LHsiaWQiOiJlbmZvcmNlLXNjb3BlLWJvdW5kYXJ5LXNlbWFudGljcy1hbmQtYWN0aXZlLXRyaWdnZXItcjIxIiwic291cmNlSWRzIjpbInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZGdMdmYiLCJkaXNjdXNzaW9uOjM4ODkwMzM4NTQiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRnTHZpIiwiZGlzY3Vzc2lvbjozODg5MDMzODU2Il0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LXNjb3BlLWJvdW5kYXJ5LXNlbWFudGljcy1hY3RpdmUtdHJpZ2dlci1yMjEiLCJzdW1tYXJ5IjoiRW5mb3JjZSBjYW5vbmljYWwgbGF0ZXItYm91bmRhcnkgc2NvcGUgc2VtYW50aWNzIGFuZCBleGFjdCBhY3RpdmUtZXZpZGVuY2UgYW1lbmRtZW50IHRyaWdnZXJzLiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkFscmVhZHkgZml4ZWQgYnkgaW1tdXRhYmxlIHJlY2VpcHQtdmFsaWQgaW50ZWdyYXRpb24gZmYzYTA3ZmU0ZDg2ZTU0Zjk3N2YzNzljNjgwYzYxYzFlY2U5MGE3MCBhbmQgcHJlc2VudCBhdCBleGFjdCBjdXJyZW50IEhFQUQgNzRiNTViMmI2YzRlMzA1YWE4ZTc2ZWEwMzNlNjllNzJkZGVjYmIxYjsgYXJjaGl2ZWQgcGFja2V0IDIxNDJlYThlM2IxY2E3MWYyZjVhZmVkMzA4ZjBhNzNjMzgxZGM5NzQ2MDU5NDRkZmUyMzU3YjY1MmI2N2Q0NzEgYW5kIHdvcmtlciByZXN1bHQgYTMzMGY3ZGY1N2E3MDRjZWNlNGRlMjE5NDJiMzhkODE4ZDU3ZmFmZDBhOGI5NDY5YzUyYTUzYmI4ODVmNWEyZSByZW1haW4gcHJlc2VydmVkIGluIHByLTYwLTIwMjYtMDgtMzBUMTQtMjYtMTItMDI1Wi4gUHJlc2VydmVkIGltbXV0YWJseSBpbiBwci02MC0yMDI2LTA4LTMwVDE1LTE0LTIwLTgxOVouIFByZXNlcnZlZCBpbW11dGFibHkgaW4gcHItNjAtMjAyNi0wOC0zMFQxNi0wNy0wOC0yNjhaLiJ9LHsiaWQiOiJhbGlnbi1leHBvcnRlZC1waGFzZS1hbmQtY3JpdGVyaWEtY2FwYWNpdHktcjIxIiwic291cmNlSWRzIjpbInRocmVhZDpQUlJUX2t3RE9UcU9kck02ZGdMdmsiLCJkaXNjdXNzaW9uOjM4ODkwMzM4NTgiLCJ0aHJlYWQ6UFJSVF9rd0RPVHFPZHJNNmRnTHZsIiwiZGlzY3Vzc2lvbjozODg5MDMzODU5Il0sInNvdXJjZVR5cGUiOiJnaXRodWItdGhyZWFkIiwiZmluZ2VycHJpbnQiOiJpc3N1ZTU1LWV4cG9ydGVkLXBoYXNlLWNyaXRlcmlhLWNhcGFjaXR5LXIyMSIsInN1bW1hcnkiOiJBbGlnbiBleHBvcnRlZCBkZXZlbG9wbWVudCBwaGFzZXMgYW5kIGltcGxlbWVudGF0aW9uLXBsYW4gY3JpdGVyaW9uIGNhcGFjaXR5IHdpdGggY2Fub25pY2FsIHNjaGVtYXMuIiwic2V2ZXJpdHkiOiJQMiIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBieSBpbW11dGFibGUgcmVjZWlwdC12YWxpZCBpbnRlZ3JhdGlvbiA0MmIwYTlmZjdkNzYxNjAyNTdhNmIyMTljYmU0N2NiMWUwYjRlZjEyIGFuZCBwcmVzZW50IGF0IGV4YWN0IGN1cnJlbnQgSEVBRCA3NGI1NWIyYjZjNGUzMDVhYThlNzZlYTAzM2U2OWU3MmRkZWNiYjFiOyBhcmNoaXZlZCBwYWNrZXQgMGQ1MzhmOTI1OWYyODEzZmExNzYxMGZhYmQ0NzczNjcxZjJlZmNlNGYzNjY4MDBhNzViOWU0NTk5Y2NiM2JlOCBhbmQgd29ya2VyIHJlc3VsdCBjZDE4M2JhMmEzMDBmMTMxNWI0MmFlOWJlOWVmNmU0N2M2MDIxZjI0NWY2YmE3YmQ3NDdhYjMwYzUwOTU4ZmI2IHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQxNC0yNi0xMi0wMjVaLiBQcmVzZXJ2ZWQgaW1tdXRhYmx5IGluIHByLTYwLTIwMjYtMDgtMzBUMTUtMTQtMjAtODE5Wi4gUHJlc2VydmVkIGltbXV0YWJseSBpbiBwci02MC0yMDI2LTA4LTMwVDE2LTA3LTA4LTI2OFouIn0seyJpZCI6ImZhaWwtY2xvc2VkLWFyY2hpdmUtYm9vdHN0cmFwLWZhbGx0aHJvdWdoLXIyMiIsInNvdXJjZUlkcyI6WyJsb2NhbDpvcmNoZXN0cmF0b3I6YXJjaGl2ZS1hZG9wdGlvbi1ib290c3RyYXAtZmFsbHRocm91Z2gtcjIyIl0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1hcmNoaXZlLWFkb3B0aW9uLWJvb3RzdHJhcC1mYWxsdGhyb3VnaC1yMjIiLCJzdW1tYXJ5IjoiRmFpbCBjbG9zZWQgd2hlbiBhZ2dyZWdhdGUgYXJjaGl2ZSBhZG9wdGlvbiBsYWNrcyBpdHMgbWFuZGF0b3J5IGN1cnJlbnQtSEVBRCB2ZXJpZmllciBib290c3RyYXAuIiwic2V2ZXJpdHkiOiJQMSIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBieSBpbW11dGFibGUgcmVjZWlwdC12YWxpZCBpbnRlZ3JhdGlvbiA3NGI1NWIyYjZjNGUzMDVhYThlNzZlYTAzM2U2OWU3MmRkZWNiYjFiIGFuZCBwcmVzZW50IGF0IGV4YWN0IGN1cnJlbnQgSEVBRCA3NGI1NWIyYjZjNGUzMDVhYThlNzZlYTAzM2U2OWU3MmRkZWNiYjFiOyBhcmNoaXZlZCBwYWNrZXQgYTRkNmUxMmIyNGYzZWExZWM5YzEyYTZmNDI0YjE1OGI4NzUwMGRiMDliOTEwMzE0M2FlNGI2Nzg2MjUwNzhmMSBhbmQgd29ya2VyIHJlc3VsdCA3ZjIzZWJiNGVmNzI1ZTBhMDZlNmJiY2RkMTNkOWQ4MTEwODBjYjQwMmRhZGU3OTYxZjgyYTQ1ZTZiMDQ2Y2QyIHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQxNC0yNi0xMi0wMjVaLiBQcmVzZXJ2ZWQgaW1tdXRhYmx5IGluIHByLTYwLTIwMjYtMDgtMzBUMTUtMTQtMjAtODE5Wi4gUHJlc2VydmVkIGltbXV0YWJseSBpbiBwci02MC0yMDI2LTA4LTMwVDE2LTA3LTA4LTI2OFouIn0seyJpZCI6ImFjY2VwdC10ZXJtaW5hbC1wcmlvci1hZ2dyZWdhdGUtcmVwbGF5LWNhcnJpZXItcjIzIiwic291cmNlSWRzIjpbImxvY2FsOm9yY2hlc3RyYXRvcjp0ZXJtaW5hbC1wcmlvci1hZ2dyZWdhdGUtcmVwbGF5LWNhcnJpZXItcjIzIl0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS10ZXJtaW5hbC1wcmlvci1hZ2dyZWdhdGUtcmVwbGF5LWNhcnJpZXItcjIzIiwic3VtbWFyeSI6IkF1dGhvcml6ZSBvbmUgZXhhY3QgdGVybWluYWwgcHJpb3ItYWdncmVnYXRlIHJlcGxheSBjYXJyaWVyIHRoYXQgbm9ybWFsaXplcyB0byBhIHVuaXF1ZSBvbGRlciBvcmRpbmFyeSBhZ2dyZWdhdGUgYXV0aG9yaXR5LiIsInNldmVyaXR5IjoiUDEiLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXNvbHV0aW9uU3VtbWFyeSI6IkFscmVhZHkgZml4ZWQgYnkgcmVjZWlwdC12YWxpZCBpbnRlZ3JhdGlvbiAxMTU4MTI0YWJmYjQxNzBhOTcyNjA1MDA5N2UxNDk2ZjMzMmQzYTViOyBwYWNrZXQgOTFmNWE5ZTZkMTcxM2FhYzQwODU3MTE3ZjYwNmU0OTE3Yzg5OTJjNTdlMDRiNDMwOTE1ZjI1NjhiNGQxYTUwZSBhbmQgd29ya2VyIHJlc3VsdCAyMDJmMTg1NzMyODEyY2ZiMDJhZjVjMTdlMTkyOGYwODhlMDJiZGQyOGYxMGI5Y2ZhYWY3M2Q4NzAyODA3OTY3IHJlbWFpbiBwcmVzZXJ2ZWQgaW4gcHItNjAtMjAyNi0wOC0zMFQxNS0xNC0yMC04MTlaLiBQcmVzZXJ2ZWQgaW1tdXRhYmx5IGluIHByLTYwLTIwMjYtMDgtMzBUMTYtMDctMDgtMjY4Wi4ifSx7ImlkIjoicHJvdmUtZnJlc2gtYWdncmVnYXRlLWlkLWFmdGVyLXByb29mbGVzcy13cmFwcGVyLXIyNCIsInNvdXJjZUlkcyI6WyJsb2NhbDpvcmNoZXN0cmF0b3I6ZnJlc2gtYWdncmVnYXRlLWlkLWFmdGVyLXByb29mbGVzcy13cmFwcGVyLXIyNCJdLCJzb3VyY2VUeXBlIjoibG9jYWwiLCJmaW5nZXJwcmludCI6Imlzc3VlNTUtZnJlc2gtYWdncmVnYXRlLWlkLXByb29mbGVzcy13cmFwcGVyLXIyNCIsInN1bW1hcnkiOiJQcm92ZSBhbmQgZG9jdW1lbnQgdGhhdCByZWNvdmVyeSBhZnRlciBhIHByb29mbGVzcyBhYmFuZG9uZWQgYWdncmVnYXRlIHVzZXMgYSBnZW51aW5lbHkgZnJlc2ggYWN0aXZlIHRhc2sgaWRlbnRpdHkuIiwic2V2ZXJpdHkiOiJQMiIsImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInN0YXR1cyI6ImNvbXBsZXRlZCIsImludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlc29sdXRpb25TdW1tYXJ5IjoiQWxyZWFkeSBmaXhlZCBieSByZWNlaXB0LXZhbGlkIGludGVncmF0aW9uIDJjZWNmZDM3M2ViNzA2ZmMwYzk4ODQwN2MxODU5ZjE5NjBmMWFjMjQ7IHBhY2tldCBhMzlhNjY2MGFlNWM5ZDBkNzViODExZjQxNjQ1MzFiOWZlY2Q2M2NlZTg1Yzk1ODE3ODMzMzBiZTRmMDA1ZTcxIGFuZCB3b3JrZXIgcmVzdWx0IGY3YWM4NTFjOGIzOGNhMjdmMzcwYTdlYWU1YWIyODljMDA2ODU3NDk4NzE2MDk5ZGNlOWM1Y2E3ZmE5YjliYTYgcmVtYWluIHByZXNlcnZlZCBpbiBwci02MC0yMDI2LTA4LTMwVDE2LTA3LTA4LTI2OFouIn0seyJpZCI6InByb3ZlLWdsb2JhbC1mcmVzaC1hZ2dyZWdhdGUtaWQtYWNyb3NzLXdyYXBwZXJzLXIyNSIsInNvdXJjZUlkcyI6WyJsb2NhbDpvcmNoZXN0cmF0b3I6Z2xvYmFsLWZyZXNoLWFnZ3JlZ2F0ZS1pZC1hY3Jvc3Mtd3JhcHBlcnMtcjI1Il0sInNvdXJjZVR5cGUiOiJsb2NhbCIsImZpbmdlcnByaW50IjoiaXNzdWU1NS1nbG9iYWwtZnJlc2gtYWdncmVnYXRlLWlkLWFjcm9zcy13cmFwcGVycy1yMjUiLCJzdW1tYXJ5IjoiUHJvdmUgYW5kIGRvY3VtZW50IHRoYXQgYWdncmVnYXRlIHJlY292ZXJ5IGlkZW50aXR5IGZyZXNobmVzcyBpcyBnbG9iYWwgYWNyb3NzIGV2ZXJ5IHNhbWUtUFIgYXJjaGl2ZSB3cmFwcGVyIGFuZCBwcm92ZW5hbmNlIGlkZW50aXR5LiIsInNldmVyaXR5IjoiUDIiLCJkaXNwb3NpdGlvbiI6ImFjdGlvbmFibGUiLCJzdGF0dXMiOiJjb21wbGV0ZWQiLCJpbnRlZ3JhdGVkQ29tbWl0U2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsInJlc29sdXRpb25TdW1tYXJ5IjoiSW50ZWdyYXRlZCBjZW50cmFsbHk7IHRhcmdldGVkIHZhbGlkYXRpb24gYW5kIGV4YWN0LWhlYWQgdmVyaWZpY2F0aW9uIHJlbWFpbi4iLCJ0YXNrUGFja2V0RGlnZXN0IjoiNDNkMTk4ZjM5YmYzMjkwMTI3MjdiNDc3MmQ5NjI0YmIzODNhMjQ1ZDFhYzNkNTU5ZWJlODlkMjllZTAwYzIxZiIsIndvcmtlclJlc3VsdERpZ2VzdCI6IjY5ZDNhZjM2ZGZlMTk0ZjU3YzYyOGNjNTc1N2IzYjFmZmZjNTRhOGFhYTUyNmNhODk4ZjYxNjY1ZGI2ZWU4NzQifV0sInJldmlld1JlcXVlc3QiOnsiaWQiOiJJQ19rd0RPVHFPZHJNOEFBQUFCUmd2NV9RIiwiZGF0YWJhc2VJZCI6NTQ3MDE1NzMwOSwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjaXNzdWVjb21tZW50LTU0NzAxNTczMDkiLCJoZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNzoyMTo0N1oiLCJraW5kIjoiZGlzY292ZXJ5IiwiYm9keSI6IkBjb2RleCByZXZpZXciLCJhdXRob3JMb2dpbiI6ImZ1cmludmFkZXIiLCJhdXRob3JOb2RlSWQiOiJNRFE2VlhObGNqUXlOall4TURjPSJ9LCJyZXZpZXdPdXRjb21lIjp7ImlkIjoiUFJSX2t3RE9UcU9kck04QUFBQUJMYV9lbkEiLCJkYXRhYmFzZUlkIjo1MDYxNDY3ODA0LCJ1cmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNwdWxscmVxdWVzdHJldmlldy01MDYxNDY3ODA0IiwiaGVhZFNoYSI6IjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTc6MzM6NTZaIiwicmVxdWVzdElkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJndjVfUSIsImtpbmQiOiJkaXNjb3ZlcnkiLCJvdXRjb21lIjoiZmluZGluZ3MiLCJldmlkZW5jZVR5cGUiOiJyZXZpZXctc3VibWlzc2lvbiIsInJldmlld2VyTG9naW4iOiJjaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJldmlld2VyTm9kZUlkIjoiQk9UX2tnRE9DOThzX2ciLCJyZXZpZXdlclR5cGUiOiJCb3QiLCJyZXZpZXdlclVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9hcHBzL2NoYXRncHQtY29kZXgtY29ubmVjdG9yIiwicmVhY3Rpb25Db250ZW50IjpudWxsLCJyZWFjdGlvbkNvbW1lbnRJZCI6bnVsbH0sInJldmlld0hpc3RvcnkiOlt7InJlcXVlc3QiOnsiaWQiOiJJQ19rd0RPVHFPZHJNOEFBQUFCUmd2NV9RIiwiZGF0YWJhc2VJZCI6NTQ3MDE1NzMwOSwidXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjaXNzdWVjb21tZW50LTU0NzAxNTczMDkiLCJoZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNzoyMTo0N1oiLCJraW5kIjoiZGlzY292ZXJ5IiwiYm9keSI6IkBjb2RleCByZXZpZXciLCJhdXRob3JMb2dpbiI6ImZ1cmludmFkZXIiLCJhdXRob3JOb2RlSWQiOiJNRFE2VlhObGNqUXlOall4TURjPSJ9LCJvdXRjb21lIjp7ImlkIjoiUFJSX2t3RE9UcU9kck04QUFBQUJMYV9lbkEiLCJkYXRhYmFzZUlkIjo1MDYxNDY3ODA0LCJ1cmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNwdWxscmVxdWVzdHJldmlldy01MDYxNDY3ODA0IiwiaGVhZFNoYSI6IjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTc6MzM6NTZaIiwicmVxdWVzdElkIjoiSUNfa3dET1RxT2RyTThBQUFBQlJndjVfUSIsImtpbmQiOiJkaXNjb3ZlcnkiLCJvdXRjb21lIjoiZmluZGluZ3MiLCJldmlkZW5jZVR5cGUiOiJyZXZpZXctc3VibWlzc2lvbiIsInJldmlld2VyTG9naW4iOiJjaGF0Z3B0LWNvZGV4LWNvbm5lY3RvciIsInJldmlld2VyTm9kZUlkIjoiQk9UX2tnRE9DOThzX2ciLCJyZXZpZXdlclR5cGUiOiJCb3QiLCJyZXZpZXdlclVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9hcHBzL2NoYXRncHQtY29kZXgtY29ubmVjdG9yIiwicmVhY3Rpb25Db250ZW50IjpudWxsLCJyZWFjdGlvbkNvbW1lbnRJZCI6bnVsbH19XSwic3RhbGVEaXNjb3ZlcnlEaXNwb3NpdGlvbnMiOltdLCJ2ZXJpZmljYXRpb25Fc2NhbGF0aW9uIjpudWxsLCJ0aHJlYWRSZXNvbHV0aW9uU3RhdHVzIjp7InN0YXR1cyI6InBhc3NlZCIsImhlYWRTaGEiOiIwYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwidGhyZWFkcyI6W3sidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRnTHZmIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bnpmSi0iLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODkwMzM4NTQsInRhc2tJZHMiOlsiZW5mb3JjZS1zY29wZS1ib3VuZGFyeS1zZW1hbnRpY3MtYW5kLWFjdGl2ZS10cmlnZ2VyLXIyMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN24zQWhMIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg5OTU2OTM5IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMzBUMTY6NTI6MzguOTg2WiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRnTHZpIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bnpmS0EiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODkwMzM4NTYsInRhc2tJZHMiOlsiZW5mb3JjZS1zY29wZS1ib3VuZGFyeS1zZW1hbnRpY3MtYW5kLWFjdGl2ZS10cmlnZ2VyLXIyMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN24zQjFGIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg5OTYyMzA5IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMzBUMTY6NTQ6MzQuNDYzWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRnTHZrIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bnpmS0MiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODkwMzM4NTgsInRhc2tJZHMiOlsiYWxpZ24tZXhwb3J0ZWQtcGhhc2UtYW5kLWNyaXRlcmlhLWNhcGFjaXR5LXIyMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN24zREFqIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg5OTY3MTM5IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMzBUMTY6NTY6NTMuMDM1WiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRnTHZsIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bnpmS0QiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODkwMzM4NTksInRhc2tJZHMiOlsiYWxpZ24tZXhwb3J0ZWQtcGhhc2UtYW5kLWNyaXRlcmlhLWNhcGFjaXR5LXIyMSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN24zRHhWIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg5OTcwMjYxIiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMzBUMTY6NTg6MjAuODQyWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCJ9LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDgyIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRnciLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0ODgsInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyNSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tMGdIIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzEzNDE1IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6Mzc6MzEuMDcyWiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJiaW5kLWFjdGl2ZS1zY29wZS1hdXRob3JpdHktcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6IjI1Mzk5YTE3OThjNTUzNDQ1NTQwNThlZTRkYjQ4ZmY2ZmNmZTRlNjFkZTAzOGNhOGFmN2RmNTgzZjFhNTM4N2EiLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwODUiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GMCIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzQ5MiwidGFza0lkcyI6WyJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjI1Il0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0yYXIiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MjEyNTkiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTo0MTo1OS44NDFaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXJjaGl2ZVByb3ZlbmFuY2UiOnsic2NoZW1hVmVyc2lvbiI6MSwiaGlzdG9yaWNhbFRhc2tJZCI6ImVuZm9yY2Utc2NvcGUtYWRtaXNzaW9uLXNlbWFudGljcy1yMSIsImhpc3RvcmljYWxEaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJoaXN0b3JpY2FsSW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVwbHlCb2R5U2hhMjU2IjoiM2Y2YmFhYTc3Y2UxMDJlY2U1NzNiNTVmYzFmZDA5MmEyNjIwM2M5ZDFjNmVkZThjMjhiMjA0MjNhMTVlODA5NyIsImF1dGhvcml0eUZpbmdlcnByaW50IjoiNzc3ZWViNmU2OWI0NDhkMDk4ODM4MDA0MjkyMTEwNTU5MzM1NTEyNDRlMzRjOTFlYzgyYzY3ZDg0ZjBjNTlhNiJ9fSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA4OSIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0Y1Iiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NDk3LCJ0YXNrSWRzIjpbInJlY292ZXItcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjUiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTNJNiIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcyNDIxOCIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjQyOjU5LjQ3MVoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhcmNoaXZlUHJvdmVuYW5jZSI6eyJzY2hlbWFWZXJzaW9uIjoxLCJoaXN0b3JpY2FsVGFza0lkIjoiZW5mb3JjZS1zY29wZS1hZG1pc3Npb24tc2VtYW50aWNzLXIxIiwiaGlzdG9yaWNhbERpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsImhpc3RvcmljYWxJbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXBseUJvZHlTaGEyNTYiOiJmOWQ0NGQ5NTkzZDgwNjMyZDkxNDdmNzM2ZTU1MmZiMzMyNDhhNjhkOTUzMzc0ZGVkMmRiMzY5YThiMjhiYjRjIiwiYXV0aG9yaXR5RmluZ2VycHJpbnQiOiI3NzdlZWI2ZTY5YjQ0OGQwOTg4MzgwMDQyOTIxMTA1NTkzMzU1MTI0NGUzNGM5MWVjODJjNjdkODRmMGM1OWE2In19LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDhyIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfRmQiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc0NjksInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyNSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tMDl6IiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzE1MzE1IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6Mzg6MzIuNTE4WiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJiaW5kLWFjdGl2ZS1zY29wZS1hdXRob3JpdHktcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6ImEwZmIyMDhmMDU4NTA2NmNiNzIzYTQ3MzdmMmU0YTE3OWQyYjg3YjQ2MGQ4NTAyNWJhNDU3N2FkOTFjOTc5ZjEiLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwOHoiLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9GbiIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzQ3OSwidGFza0lkcyI6WyJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjI1Il0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm0xWGMiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MTY5NTYiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTozOTozNy42OThaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXJjaGl2ZVByb3ZlbmFuY2UiOnsic2NoZW1hVmVyc2lvbiI6MSwiaGlzdG9yaWNhbFRhc2tJZCI6ImJpbmQtYWN0aXZlLXNjb3BlLWF1dGhvcml0eS1yMSIsImhpc3RvcmljYWxEaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJoaXN0b3JpY2FsSW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVwbHlCb2R5U2hhMjU2IjoiODQ5MDhlYWM1N2ExYjEyYjZlMTI2ZTg4OWI4NTQzNjI3YzYzYjM0OTJkNzk1NjY4ZDM4NjIyYjRlYWFhOTBkZiIsImF1dGhvcml0eUZpbmdlcnByaW50IjoiNzc3ZWViNmU2OWI0NDhkMDk4ODM4MDA0MjkyMTEwNTU5MzM1NTEyNDRlMzRjOTFlYzgyYzY3ZDg0ZjBjNTlhNiJ9fSx7InRocmVhZE5vZGVJZCI6IlBSUlRfa3dET1RxT2RyTTZkUjA5QiIsInJvb3RDb21tZW50Tm9kZUlkIjoiUFJSQ19rd0RPVHFPZHJNN25kX0ZfIiwicm9vdENvbW1lbnREYXRhYmFzZUlkIjozODgzMzk3NTAzLCJ0YXNrSWRzIjpbInJlY292ZXItcmVzb2x2ZWQtaXNzdWU1NS1jb2RleC1yb290cy1yMjUiXSwiZGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwicmVwbHlJZCI6IlBSUkNfa3dET1RxT2RyTTdubTNuMiIsInJlcGx5VXJsIjoiaHR0cHM6Ly9naXRodWIuY29tL2Z1cmludmFkZXIvYWVyc3RlbGxvL3B1bGwvNjAjZGlzY3Vzc2lvbl9yMzg4NTcyNjE5OCIsImlzUmVzb2x2ZWQiOnRydWUsInJlc29sdmVkQXQiOiIyMDI2LTA4LTI5VDA1OjQzOjU3LjgzMFoiLCJyZXNvbHZlZEJ5IjoiZnVyaW52YWRlciIsIm9ic2VydmVkSGVhZFNoYSI6IjVmNmExZWZhNjAxZWZiZjA4ZDU4Y2Q5ZTZiNWVkMzZhYmUwZWM3YmEiLCJhcmNoaXZlUHJvdmVuYW5jZSI6eyJzY2hlbWFWZXJzaW9uIjoxLCJoaXN0b3JpY2FsVGFza0lkIjoiZW5mb3JjZS1zY29wZS1hZG1pc3Npb24tc2VtYW50aWNzLXIxIiwiaGlzdG9yaWNhbERpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsImhpc3RvcmljYWxJbnRlZ3JhdGVkQ29tbWl0U2hhIjpudWxsLCJyZXBseUJvZHlTaGEyNTYiOiI5ODk3YzA5ZWE0NGYwMTY0YzdlNWMwMWJkZjY0Mzc0MGVjNzk0ZGZlNDcwZjQ2ODg1Njk4NmE3Mzg3NzgyMjIyIiwiYXV0aG9yaXR5RmluZ2VycHJpbnQiOiI3NzdlZWI2ZTY5YjQ0OGQwOTg4MzgwMDQyOTIxMTA1NTkzMzU1MTI0NGUzNGM5MWVjODJjNjdkODRmMGM1OWE2In19LHsidGhyZWFkTm9kZUlkIjoiUFJSVF9rd0RPVHFPZHJNNmRSMDlJIiwicm9vdENvbW1lbnROb2RlSWQiOiJQUlJDX2t3RE9UcU9kck03bmRfR0kiLCJyb290Q29tbWVudERhdGFiYXNlSWQiOjM4ODMzOTc1MTIsInRhc2tJZHMiOlsicmVjb3Zlci1yZXNvbHZlZC1pc3N1ZTU1LWNvZGV4LXJvb3RzLXIyNSJdLCJkaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJyZXBseUlkIjoiUFJSQ19rd0RPVHFPZHJNN25tNGNKIiwicmVwbHlVcmwiOiJodHRwczovL2dpdGh1Yi5jb20vZnVyaW52YWRlci9hZXJzdGVsbG8vcHVsbC82MCNkaXNjdXNzaW9uX3IzODg1NzI5NTQ1IiwiaXNSZXNvbHZlZCI6dHJ1ZSwicmVzb2x2ZWRBdCI6IjIwMjYtMDgtMjlUMDU6NDU6MTYuNzk4WiIsInJlc29sdmVkQnkiOiJmdXJpbnZhZGVyIiwib2JzZXJ2ZWRIZWFkU2hhIjoiNWY2YTFlZmE2MDFlZmJmMDhkNThjZDllNmI1ZWQzNmFiZTBlYzdiYSIsImFyY2hpdmVQcm92ZW5hbmNlIjp7InNjaGVtYVZlcnNpb24iOjEsImhpc3RvcmljYWxUYXNrSWQiOiJjbG9zZS1ib3VuZGVkLWFtZW5kbWVudC1hdXRob3JpdHktcjEiLCJoaXN0b3JpY2FsRGlzcG9zaXRpb24iOiJhbHJlYWR5LWZpeGVkIiwiaGlzdG9yaWNhbEludGVncmF0ZWRDb21taXRTaGEiOm51bGwsInJlcGx5Qm9keVNoYTI1NiI6IjBkMjk0YjRlMWM3NWQxYmU4Mzk1NWNmYzc0ZWU4MmNkNzg5MDA2Y2FjYzVmMDdmMGJjOWQ4ZjE0NzYzZDNkYzciLCJhdXRob3JpdHlGaW5nZXJwcmludCI6Ijc3N2VlYjZlNjliNDQ4ZDA5ODgzODAwNDI5MjExMDU1OTMzNTUxMjQ0ZTM0YzkxZWM4MmM2N2Q4NGYwYzU5YTYifX0seyJ0aHJlYWROb2RlSWQiOiJQUlJUX2t3RE9UcU9kck02ZFIwOU8iLCJyb290Q29tbWVudE5vZGVJZCI6IlBSUkNfa3dET1RxT2RyTTduZF9HUyIsInJvb3RDb21tZW50RGF0YWJhc2VJZCI6Mzg4MzM5NzUyMiwidGFza0lkcyI6WyJyZWNvdmVyLXJlc29sdmVkLWlzc3VlNTUtY29kZXgtcm9vdHMtcjI1Il0sImRpc3Bvc2l0aW9uIjoiYWxyZWFkeS1maXhlZCIsInJlcGx5SWQiOiJQUlJDX2t3RE9UcU9kck03bm00MDYiLCJyZXBseVVybCI6Imh0dHBzOi8vZ2l0aHViLmNvbS9mdXJpbnZhZGVyL2FlcnN0ZWxsby9wdWxsLzYwI2Rpc2N1c3Npb25fcjM4ODU3MzExMzAiLCJpc1Jlc29sdmVkIjp0cnVlLCJyZXNvbHZlZEF0IjoiMjAyNi0wOC0yOVQwNTo0NjoxMy4zMTBaIiwicmVzb2x2ZWRCeSI6ImZ1cmludmFkZXIiLCJvYnNlcnZlZEhlYWRTaGEiOiI1ZjZhMWVmYTYwMWVmYmYwOGQ1OGNkOWU2YjVlZDM2YWJlMGVjN2JhIiwiYXJjaGl2ZVByb3ZlbmFuY2UiOnsic2NoZW1hVmVyc2lvbiI6MSwiaGlzdG9yaWNhbFRhc2tJZCI6ImNsb3NlLWJvdW5kZWQtYW1lbmRtZW50LWF1dGhvcml0eS1yMSIsImhpc3RvcmljYWxEaXNwb3NpdGlvbiI6ImFscmVhZHktZml4ZWQiLCJoaXN0b3JpY2FsSW50ZWdyYXRlZENvbW1pdFNoYSI6bnVsbCwicmVwbHlCb2R5U2hhMjU2IjoiODc1NzNkZjYwNzViYWRkMzdiOTA2MDEyY2MxYzYxYzQ4NjAzZTdmNmY1NGMzZjJjNDk4Y2QzMTAyNWU1ZWQ3MCIsImF1dGhvcml0eUZpbmdlcnByaW50IjoiNzc3ZWViNmU2OWI0NDhkMDk4ODM4MDA0MjkyMTEwNTU5MzM1NTEyNDRlMzRjOTFlYzgyYzY3ZDg0ZjBjNTlhNiJ9fV0sInRocmVhZGxlc3NWZXJpZmljYXRpb24iOnsic3RhdHVzIjoibm90LXJ1biIsImhlYWRTaGEiOm51bGwsInRhc2tJZHMiOltdLCJ1cGRhdGVkQXQiOm51bGx9LCJ1cGRhdGVkQXQiOiIyMDI2LTA4LTMwVDE3OjIwOjMzLjcxNloiLCJsb2NhbFZlcmlmaWNhdGlvbiI6eyJzdGF0dXMiOiJwYXNzZWQiLCJoZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsInRhc2tJZHMiOlsiYWNjZXB0LXRlcm1pbmFsLXByaW9yLWFnZ3JlZ2F0ZS1yZXBsYXktY2Fycmllci1yMjMiLCJmYWlsLWNsb3NlZC1hcmNoaXZlLWJvb3RzdHJhcC1mYWxsdGhyb3VnaC1yMjIiLCJwcm92ZS1mcmVzaC1hZ2dyZWdhdGUtaWQtYWZ0ZXItcHJvb2ZsZXNzLXdyYXBwZXItcjI0IiwicHJvdmUtZ2xvYmFsLWZyZXNoLWFnZ3JlZ2F0ZS1pZC1hY3Jvc3Mtd3JhcHBlcnMtcjI1Il0sInVwZGF0ZWRBdCI6IjIwMjYtMDgtMzBUMTc6MjA6MzMuNzE2WiJ9fSwiYmxvY2tlZFJlYXNvbnMiOltdLCJ2YWxpZGF0aW9uU3RhdHVzIjp7InNvdXJjZSI6Im9yY2hlc3RyYXRvciIsInNjb3BlIjoidGFyZ2V0ZWQiLCJzdGF0dXMiOiJwYXNzZWQiLCJoZWFkU2hhIjoiMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImNoZWNrcyI6WyJub2RlIC0tdGVzdCAuYWdlbnRzL3NraWxscy9wci1yZXZpZXctY3ljbGUvc2NyaXB0cy9naXRodWIvYXJjaGl2ZS9hZG9wdGlvbi50ZXN0Lm1qcyIsIm5wbSBydW4gY2hlY2s6d29ya2Zsb3ciXSwidXBkYXRlZEF0IjoiMjAyNi0wOC0zMFQxNjo0Mjo1My4yNjZaIn0sImNpVmFsaWRhdGlvblN0YXR1cyI6eyJzb3VyY2UiOiJnaXRodWItYWN0aW9ucyIsInNjb3BlIjoiZnVsbCIsInN0YXR1cyI6Im5vdC1ydW4iLCJoZWFkU2hhIjpudWxsLCJjaGVja3MiOltdLCJjaGVja1J1bklkIjpudWxsLCJ3b3JrZmxvd1J1bklkIjpudWxsLCJ3b3JrZmxvd1J1blVybCI6bnVsbCwidXBkYXRlZEF0IjpudWxsfSwiY2lWYWxpZGF0aW9uSGlzdG9yeSI6W10sIm5leHRBY3Rpb24iOiJUcmlhZ2UgdGhlIGFwcGxpY2FibGUgY2Fub25pY2FsIHJldmlldyBmaW5kaW5ncy4iLCJpbnRlZ3JhdGlvbldvcmt0cmVlIjoiL3RtcC9hZXJzdGVsbG8taXNzdWU1NS1yZXN0YXJ0LmNxcUJTUS9yZXBvIiwib3JjaGVzdHJhdG9yU2Vzc2lvbklkIjpudWxsLCJhYmFuZG9ubWVudFJlYXNvbiI6IlBSICM2MCBvZmZpY2lhbCByZXZpZXcgcm91bmQgMSBpcyBwcmVzZXJ2ZWQgYXQgMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCB3aXRoIHNldmVuIGNvbXBsZXRlZCB0YXNrcywgdHdlbHZlIHJlc29sdmVkLXJvb3QgcHJvb2ZzLCBmb3VyIGxvY2FsIHZlcmlmaWVyIHByb29mcywgdGFyZ2V0ZWQgdmFsaWRhdGlvbiwgYW5kIHRoZSBleGFjdCB0aHJlZS1maW5kaW5nIG9mZmljaWFsIG91dGNvbWUuIFRoZSByZWNlaXB0LWJhY2tlZCBzY29wZSBqb3VybmFsIHVzZXMgMjI0MjA3IG9mIDI2MjE0NCBieXRlcywgYW5kIHRocmVlIGRpc3RpbmN0IHJlbWVkaWF0aW9uIGNsYXNzaWZpY2F0aW9ucyBwbHVzIGEgbmV3IGV4YWN0IGludGVncmF0ZWQtSEVBRCBwcm9vZiBjYW5ub3QgZml0IHNhZmVseS4gUHJlc2VydmUgdGhpcyBjeWNsZSBhbmQgYWxsIGV2aWRlbmNlIGltbXV0YWJseTsgY29udGludWUgdGhlIHNhbWUgUFIgYW5kIGV4YWN0IEhFQUQgaW4gZnJlc2ggaW1wb3J0ZWQtYXV0aG9yaXR5IHIyNi4iLCJnaXQiOnsiYnJhbmNoIjoiYWdlbnQvaXNzdWUtNTUtbWluaW1hbC1zY29wZS1yMiIsImhlYWRTaGEiOiIwYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiZGlydHkiOmZhbHNlfSwidXBkYXRlZEF0IjoiMjAyNi0wOC0zMFQxNzo0MTo1NC4xOTlaIiwic2NvcGVDb250cm9sIjp7ImF1dGhvcml0eURpZ2VzdCI6InNoYTI1Njo1YzMwMzIwNTgzYjQ5YmZmNDRmNjFjNDRhZDk5MzM0MWEzOTViNDUzYzU2ZjAxMmE4ZWMwZTI1YzU2NjE1MTcxIiwiam91cm5hbERpZ2VzdCI6InNoYTI1Njo4MGNmZWNlN2M0MjdiZTNiNzFmMzE1NGZiNjNhOTU3MWY0NThlMmQwMjIwMTgyOGEzMTFkZTk4ZTdhYzRlODA5IiwicmV0dXJuRGlnZXN0IjpudWxsLCJnYXRlIjoicmVhZHkiLCJhc3Nlc3NtZW50SGVhZFNoYSI6IjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJ1cGRhdGVkQXQiOiIyMDI2LTA4LTMwVDE3OjExOjUxLjgwNVoifX0K',
    'eyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiaW5pdGlhbGl6ZWQiLCJzdW1tYXJ5IjoiSW5pdGlhbGl6ZWQgUFIgNjAiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MTE6NDMuNTQwWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InJlY292ZXJlZC10YXNrcy1wcm9wb3NlZCIsInN1bW1hcnkiOiJQcm9wb3NlZCBnbG9iYWxseSBmcmVzaCByMjUgYWdncmVnYXRlIHJlY292ZXJ5LCBmaXZlIHByZXNlcnZlZCBvdXRjb21lcywgYW5kIG9uZSBib3VuZGVkIHJlZ3Jlc3Npb24gcmVtZWRpYXRpb24iLCJhdCI6IjIwMjYtMDgtMzBUMTY6MTE6NTYuMjc2WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InJlY292ZXJlZC10YXNrcy1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkZpbmFsaXplZCBnbG9iYWxseSBmcmVzaCByMjUgYWdncmVnYXRlIGFuZCBmaXZlIGFyY2hpdmUtcHJlc2VydmVkIG91dGNvbWVzOyByZXRhaW5lZCBvbmUgYWN0aW9uYWJsZSByZWdyZXNzaW9uIHJlbWVkaWF0aW9uIiwiYXQiOiIyMDI2LTA4LTMwVDE2OjExOjU5Ljk4OVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgZ2xvYmFsLWZyZXNoLWFnZ3JlZ2F0ZS1pZGVudGl0eS1yZWNvdmVyeS1wcm9vZi1nYXAtcjI1IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MTY6MTUuMDU0WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhc2stcGFja2V0LWJvdW5kIiwic3VtbWFyeSI6IkJvdW5kIGFjY2VwdGVkIHBhY2tldCBmb3IgdGFzayBwcm92ZS1nbG9iYWwtZnJlc2gtYWdncmVnYXRlLWlkLWFjcm9zcy13cmFwcGVycy1yMjUiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MTc6MDMuODM1WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1zdGFydGVkIiwic3VtbWFyeSI6IlN0YXJ0ZWQgaXNvbGF0ZWQgd29ya2VyIGZvciBwcm92ZS1nbG9iYWwtZnJlc2gtYWdncmVnYXRlLWlkLWFjcm9zcy13cmFwcGVycy1yMjUiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MTg6MDQuNDM1WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6Indvcmtlci1yZXN1bHQtYWNjZXB0ZWQiLCJzdW1tYXJ5IjoiQWNjZXB0ZWQgd29ya2VyIHJlc3VsdCBmb3IgdGFzayBwcm92ZS1nbG9iYWwtZnJlc2gtYWdncmVnYXRlLWlkLWFjcm9zcy13cmFwcGVycy1yMjUiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MzM6MTMuMDc4WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdC1jaGVja3BvaW50Iiwic3VtbWFyeSI6IkNoZWNrcG9pbnRlZCBpbnRlZ3JhdGlvbiBIRUFEIDBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MzM6MzguNDYyWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhc2staW50ZWdyYXRlZCIsInN1bW1hcnkiOiJJbnRlZ3JhdGVkIGV4YWN0IHdvcmtlciBwYXRjaCBmb3IgcHJvdmUtZ2xvYmFsLWZyZXNoLWFnZ3JlZ2F0ZS1pZC1hY3Jvc3Mtd3JhcHBlcnMtcjI1IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjMzOjUyLjA1OVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgZ2xvYmFsLWZyZXNoLWFnZ3JlZ2F0ZS1pZGVudGl0eS1yZWNvdmVyeS1wcm9vZi1nYXAtcjI1IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MzQ6MTYuMjIwWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCBsYXRlci1zY29wZS1ib3VuZGFyeS1hdXRob3JpdHktZ2Fwcy1yMjEgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQxNjozNDoyMC43OTNaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGRldmVsb3BtZW50LWNvbnRyYWN0LXNjaGVtYS1wYXJpdHktcjIxIGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MzQ6MjYuNTU5WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCByZXNvbHZlZC1pc3N1ZTU1LXJvb3RzLWFuZC1nbG9iYWwtZnJlc2gtYWdncmVnYXRlLWlkZW50aXR5LXIyNSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjM0OjMxLjczM1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJ0YXJnZXRlZC12YWxpZGF0aW9uLXBsYW5uZWQiLCJzdW1tYXJ5IjoiU2F2ZWQgMiB0YXJnZXRlZCBjaGVja3MgZm9yIDBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTY6MzQ6NTcuNDk3WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InRhcmdldGVkLXZhbGlkYXRpb24tcmVjb3JkZWQiLCJzdW1tYXJ5IjoiUmVjb3JkZWQgcGFzc2VkIHRhcmdldGVkIHZhbGlkYXRpb24gZm9yIDBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTY6NDI6NTMuMjgxWiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlcGx5IHJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkZ0x2ZjowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjUxOjIzLjY2MFoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXBseSIsIm9wZXJhdGlvbklkIjoicmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRnTHZmOjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLTFlNDMyNWM4Yzk2YjY0NTlhYzI5ODJhMiIsImF0IjoiMjAyNi0wOC0zMFQxNjo1MToyMy42NTNaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlc29sdmUgcmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdmY6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNjo1MjozOC45OTRaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVzb2x2ZSIsIm9wZXJhdGlvbklkIjoicmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdmY6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tNWNiMGY0MDVmNDNjMTQyNjRkYmYwNmQ2IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjUyOjM4Ljk4NloifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVwbHkgcmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRnTHZpOjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTY6NTM6MjMuODY3WiIsImRldGFpbHMiOnsidHlwZSI6InJlcGx5Iiwib3BlcmF0aW9uSWQiOiJyZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdmk6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tNzc0ZjEzMmNmZDdjN2MxY2I3MGNjNmE0IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjUzOjIzLjg2MFoifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWludGVudCIsInN1bW1hcnkiOiJJbnRlbnQgcmVzb2x2ZSByZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkZ0x2aTowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjU0OjAyLjU4OVoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXNvbHZlIiwib3BlcmF0aW9uSWQiOiJyZXNvbHZlOjYwOlBSUlRfa3dET1RxT2RyTTZkZ0x2aTowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby04ODdlMTkyNGNiM2RkZmE4MDZmNGM1OTMiLCJhdCI6IjIwMjYtMDgtMzBUMTY6NTQ6MDIuNTc5WiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXBseSByZXBseTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdms6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNjo1NTozMi4zNDlaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVwbHkiLCJvcGVyYXRpb25JZCI6InJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkZ0x2azowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby01ODJkZDUyYjkxOWU3ZmRhZWVkZjQ4NjgiLCJhdCI6IjIwMjYtMDgtMzBUMTY6NTU6MzIuMzEzWiJ9fQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXNvbHZlIHJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRnTHZrOjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJhdCI6IjIwMjYtMDgtMzBUMTY6NTY6MjguODM2WiIsImRldGFpbHMiOnsidHlwZSI6InJlc29sdmUiLCJvcGVyYXRpb25JZCI6InJlc29sdmU6NjA6UFJSVF9rd0RPVHFPZHJNNmRnTHZrOjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLTY4MWQwZGNmYmQ4MjU5MzAzN2VhZjg1NCIsImF0IjoiMjAyNi0wOC0zMFQxNjo1NjoyOC44MzBaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlcGx5IHJlcGx5OjYwOlBSUlRfa3dET1RxT2RyTTZkZ0x2bDowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiYXQiOiIyMDI2LTA4LTMwVDE2OjU3OjAzLjY2NFoiLCJkZXRhaWxzIjp7InR5cGUiOiJyZXBseSIsIm9wZXJhdGlvbklkIjoicmVwbHk6NjA6UFJSVF9rd0RPVHFPZHJNNmRnTHZsOjBhYTBiNjFlYWU5YmI4YWY5ZDk0N2M2YzUxMGNjNzc2OGI3Y2I1MDQiLCJjbGllbnRNdXRhdGlvbklkIjoiYWVyc3RlbGxvLTBhNWQyNDc2MWY5NTFlMzk1M2FjZjkyNSIsImF0IjoiMjAyNi0wOC0zMFQxNjo1NzowMy42NThaIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImdpdGh1Yi1tdXRhdGlvbi1pbnRlbnQiLCJzdW1tYXJ5IjoiSW50ZW50IHJlc29sdmUgcmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdmw6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNjo1Nzo1NS44OTNaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVzb2x2ZSIsIm9wZXJhdGlvbklkIjoicmVzb2x2ZTo2MDpQUlJUX2t3RE9UcU9kck02ZGdMdmw6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tOGJiNWYyNzdiM2VkODA5YzJlOTM5OTYwIiwiYXQiOiIyMDI2LTA4LTMwVDE2OjU3OjU1Ljg4N1oifX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGdpdGh1Yi10aHJlYWQtcmVtZWRpYXRpb24tYXJjaGl2ZS1ib290c3RyYXAtZ2FwLXIyMiBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDE3OjA5OjU2Ljg4M1oifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJzY29wZS1jbGFzc2lmaWVkIiwic3VtbWFyeSI6IkNsYXNzaWZpZWQgdGVybWluYWwtcHJpb3ItYWdncmVnYXRlLXJlcGxheS1jYXJyaWVyLWdhcC1yMjMgYXMgd2l0aGluLXNjb3BlLWRlZmVjdCIsImF0IjoiMjAyNi0wOC0zMFQxNzoxMDoxMy41NjNaIn0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoic2NvcGUtY2xhc3NpZmllZCIsInN1bW1hcnkiOiJDbGFzc2lmaWVkIGZyZXNoLWFnZ3JlZ2F0ZS1pZGVudGl0eS1yZWNvdmVyeS1wcm9vZi1nYXAtcjI0IGFzIHdpdGhpbi1zY29wZS1kZWZlY3QiLCJhdCI6IjIwMjYtMDgtMzBUMTc6MTA6MjMuNTg2WiJ9Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6InNjb3BlLWNsYXNzaWZpZWQiLCJzdW1tYXJ5IjoiQ2xhc3NpZmllZCByZXNvbHZlZC1pc3N1ZTU1LXJvb3RzLXJlYWRpbmVzcy1jbG9zdXJlLXIyNSBhcyB3aXRoaW4tc2NvcGUtZGVmZWN0IiwiYXQiOiIyMDI2LTA4LTMwVDE3OjExOjUyLjAxMVoifQp7InNjaGVtYVZlcnNpb24iOjEsInR5cGUiOiJnaXRodWItbXV0YXRpb24taW50ZW50Iiwic3VtbWFyeSI6IkludGVudCByZXF1ZXN0IHJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNzoyMTozNC4yNzNaIiwiZGV0YWlscyI6eyJ0eXBlIjoicmVxdWVzdCIsIm9wZXJhdGlvbklkIjoicmVxdWVzdDo2MDpkaXNjb3Zlcnk6MTowYWEwYjYxZWFlOWJiOGFmOWQ5NDdjNmM1MTBjYzc3NjhiN2NiNTA0IiwiY2xpZW50TXV0YXRpb25JZCI6ImFlcnN0ZWxsby00MTA1Yzc3YWIxNzFmZGM4Y2NkNDhkMWMiLCJhdCI6IjIwMjYtMDgtMzBUMTc6MjE6MjMuNTcxWiIsImV4Y2x1ZGVkQ29tbWVudElkcyI6WyJJQ19rd0RPVHFPZHJNOEFBQUFCUlQ1ZXBnIiwiSUNfa3dET1RxT2RyTThBQUFBQlJlb2pqUSJdfX0KeyJzY2hlbWFWZXJzaW9uIjoxLCJ0eXBlIjoiZ2l0aHViLW11dGF0aW9uLWRpc3BhdGNoIiwic3VtbWFyeSI6IkRpc3BhdGNoIHJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImF0IjoiMjAyNi0wOC0zMFQxNzoyMTo0NS40NDJaIiwiZGV0YWlscyI6eyJvcGVyYXRpb25JZCI6InJlcXVlc3Q6NjA6ZGlzY292ZXJ5OjE6MGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCIsImNsaWVudE11dGF0aW9uSWQiOiJhZXJzdGVsbG8tNDEwNWM3N2FiMTcxZmRjOGNjZDQ4ZDFjIn19Cnsic2NoZW1hVmVyc2lvbiI6MSwidHlwZSI6ImFiYW5kb25lZCIsInN1bW1hcnkiOiJBcmNoaXZlZCB3aXRob3V0IGNvbXBsZXRpb246IFBSICM2MCBvZmZpY2lhbCByZXZpZXcgcm91bmQgMSBpcyBwcmVzZXJ2ZWQgYXQgMGFhMGI2MWVhZTliYjhhZjlkOTQ3YzZjNTEwY2M3NzY4YjdjYjUwNCB3aXRoIHNldmVuIGNvbXBsZXRlZCB0YXNrcywgdHdlbHZlIHJlc29sdmVkLXJvb3QgcHJvb2ZzLCBmb3VyIGxvY2FsIHZlcmlmaWVyIHByb29mcywgdGFyZ2V0ZWQgdmFsaWRhdGlvbiwgYW5kIHRoZSBleGFjdCB0aHJlZS1maW5kaW5nIG9mZmljaWFsIG91dGNvbWUuIFRoZSByZWNlaXB0LWJhY2tlZCBzY29wZSBqb3VybmFsIHVzZXMgMjI0MjA3IG9mIDI2MjE0NCBieXRlcywgYW5kIHRocmVlIGRpc3RpbmN0IHJlbWVkaWF0aW9uIGNsYXNzaWZpY2F0aW9ucyBwbHVzIGEgbmV3IGV4YWN0IGludGVncmF0ZWQtSEVBRCBwcm9vZiBjYW5ub3QgZml0IHNhZmVseS4gUHJlc2VydmUgdGhpcyBjeWNsZSBhbmQgYWxsIGV2aWRlbmNlIGltbXV0YWJseTsgY29udGludWUgdGhlIHNhbWUgUFIgYW5kIGV4YWN0IEhFQUQgaW4gZnJlc2ggaW1wb3J0ZWQtYXV0aG9yaXR5IHIyNi4iLCJhdCI6IjIwMjYtMDgtMzBUMTc6NDE6NTQuMjE1WiJ9Cg==',
  ];
  const authenticStreams = authenticArchiveBase64.map((value) => Buffer.from(value, 'base64'));
  const authenticArchiveBytes = {
    origin: { state: authenticStreams[0], events: authenticStreams[1] },
    r20: { state: authenticStreams[2], events: authenticStreams[3] },
    r25: { state: authenticStreams[4], events: authenticStreams[5] },
  };
  const authenticIssue64Topology = {
    origin: {
      archiveId: 'pr-60-2026-08-29T05-57-39-081Z',
      stateSha256: '7a49de09a5d966b7e7514a56c6ea682dfc2123e975793f89b8accadf5024be32',
      eventsSha256: 'bbbece958e0056345103fa283d7e8305cb605c42a4af9f60e8b7072f797f754e',
    },
    slice: {
      archiveId: 'pr-60-2026-08-30T10-23-44-766Z',
      stateSha256: '06ad1e19ad6f481afffe3b0b33f7849739466b71609daaa0fc76527efac1ea96',
      eventsSha256: 'e0049a7936112a2ee2d7574327dc40e5e2f08d2d4d61e372e02543b270953645',
      ownerTaskId: 'recover-resolved-issue55-codex-roots-r20',
      partitions: {
        'bind-active-scope-authority-r1': [
          'PRRT_kwDOTqOdrM6dR08r', 'PRRT_kwDOTqOdrM6dR08z', 'PRRT_kwDOTqOdrM6dR082',
        ],
        'enforce-scope-admission-semantics-r1': [
          'PRRT_kwDOTqOdrM6dR085', 'PRRT_kwDOTqOdrM6dR089', 'PRRT_kwDOTqOdrM6dR09B',
        ],
        'close-bounded-amendment-authority-r1': [
          'PRRT_kwDOTqOdrM6dR09I', 'PRRT_kwDOTqOdrM6dR09O',
        ],
      },
    },
    complete: {
      archiveId: 'pr-60-2026-08-30T17-41-54-200Z',
      stateSha256: '83194277f5ec6851895261dc8b943977684136bd65d24b2e6f28046a5b9b788f',
      eventsSha256: 'c9b90cfb9a5a320c0ddfc695942a8035a37608a011d9ef9238a895babbafc133',
      laterRoots: [
        'PRRT_kwDOTqOdrM6dgLvf', 'PRRT_kwDOTqOdrM6dgLvi',
        'PRRT_kwDOTqOdrM6dgLvk', 'PRRT_kwDOTqOdrM6dgLvl',
      ],
    },
  };
  const authenticPartitionRoots = Object.values(authenticIssue64Topology.slice.partitions);
  const authenticSliceRoots = authenticPartitionRoots.flat();
  const authenticCompleteRoots = [
    ...authenticSliceRoots, ...authenticIssue64Topology.complete.laterRoots,
  ];
  const authenticDecoded = Object.fromEntries(Object.entries(authenticArchiveBytes).map(
    ([key, value]) => {
      const stateBytes = Buffer.from(value.state, 'base64');
      const eventBytes = Buffer.from(value.events, 'base64');
      return [key, {
        stateBytes,
        eventBytes,
        state: JSON.parse(stateBytes.toString('utf8')),
        events: eventBytes.toString('utf8').trim().split('\n').map(JSON.parse),
      }];
    },
  ));
  assert.equal(createHash('sha256').update(authenticDecoded.origin.stateBytes).digest('hex'),
    authenticIssue64Topology.origin.stateSha256);
  assert.equal(createHash('sha256').update(authenticDecoded.origin.eventBytes).digest('hex'),
    authenticIssue64Topology.origin.eventsSha256);
  assert.equal(createHash('sha256').update(authenticDecoded.r20.stateBytes).digest('hex'),
    authenticIssue64Topology.slice.stateSha256);
  assert.equal(createHash('sha256').update(authenticDecoded.r20.eventBytes).digest('hex'),
    authenticIssue64Topology.slice.eventsSha256);
  assert.equal(createHash('sha256').update(authenticDecoded.r25.stateBytes).digest('hex'),
    authenticIssue64Topology.complete.stateSha256);
  assert.equal(createHash('sha256').update(authenticDecoded.r25.eventBytes).digest('hex'),
    authenticIssue64Topology.complete.eventsSha256);
  const authenticSliceOwner = authenticDecoded.r20.state.tasks.find(
    (task) => task.id === authenticIssue64Topology.slice.ownerTaskId,
  );
  const authenticSliceRows = authenticDecoded.r20.state.threadResolutionStatus.threads;
  const authenticSliceTaskRoots = authenticSliceOwner.sourceIds.filter(
    (source) => source.startsWith('thread:'),
  ).map((source) => source.slice('thread:'.length)).sort();
  assert.equal(authenticSliceOwner.sourceType, 'github-thread');
  assert.equal(authenticSliceOwner.status, 'completed');
  assert.equal(authenticSliceOwner.disposition, 'already-fixed');
  assert.equal(authenticSliceOwner.integratedCommitSha, null);
  assert.deepEqual(authenticSliceTaskRoots, authenticSliceRoots.slice().sort());
  assert.deepEqual(authenticSliceRows.map((row) => row.threadNodeId).sort(),
    authenticSliceRoots.slice().sort());
  for (const [historicalTaskId, roots] of Object.entries(
    authenticIssue64Topology.slice.partitions,
  )) {
    assert.deepEqual(authenticSliceRows.filter(
      (row) => row.archiveProvenance?.historicalTaskId === historicalTaskId,
    ).map((row) => row.threadNodeId).sort(), roots.slice().sort());
  }
  const authenticCompleteRows = authenticDecoded.r25.state.threadResolutionStatus.threads;
  const authenticCompleteProvenanceRows = authenticCompleteRows.filter(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  );
  const authenticCompleteLaterRows = authenticCompleteRows.filter(
    (row) => !Object.hasOwn(row, 'archiveProvenance'),
  );
  assert.deepEqual(authenticCompleteRows.map((row) => row.threadNodeId).sort(),
    authenticCompleteRoots.slice().sort());
  assert.equal(authenticCompleteProvenanceRows.length, 8);
  assert.deepEqual(authenticCompleteLaterRows.map((row) => row.threadNodeId).sort(),
  authenticIssue64Topology.complete.laterRoots.slice().sort());
  assert.deepEqual(Object.values(Object.groupBy(
    authenticCompleteLaterRows,
    (row) => row.taskIds[0],
  )).map((rows) => rows.length).sort(), [2, 2]);
  assert.equal(authenticDecoded.r20.events.at(-1).type, 'abandoned');
  assert.equal(authenticDecoded.r25.events.at(-1).type, 'abandoned');
  assert.deepEqual(authenticPartitionRoots.map((roots) => roots.length).sort(), [2, 3, 3]);
  assert.equal(new Set(authenticSliceRoots).size, 8);
  assert.equal(new Set(authenticCompleteRoots).size, 12);
  assert.equal(authenticSliceRoots.every((root) => authenticCompleteRoots.includes(root)), true);
  assert.match(authenticIssue64Topology.slice.stateSha256, /^[0-9a-f]{64}$/u);
  assert.match(authenticIssue64Topology.slice.eventsSha256, /^[0-9a-f]{64}$/u);
  assert.match(authenticIssue64Topology.complete.stateSha256, /^[0-9a-f]{64}$/u);
  assert.match(authenticIssue64Topology.complete.eventsSha256, /^[0-9a-f]{64}$/u);

  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const fixtureOldArchive = structuredClone(oldArchive);
  const fixtureMixedArchive = structuredClone(mixedArchive);
  const firstFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  const authenticRecords = [
    {
      archiveId: authenticIssue64Topology.complete.archiveId,
      state: authenticDecoded.r25.state,
      events: authenticDecoded.r25.events,
    },
    {
      archiveId: authenticIssue64Topology.slice.archiveId,
      state: authenticDecoded.r20.state,
      events: authenticDecoded.r20.events,
    },
    {
      archiveId: authenticIssue64Topology.origin.archiveId,
      state: authenticDecoded.origin.state,
      events: authenticDecoded.origin.events,
    },
  ];
  const authenticRecordsSnapshot = structuredClone(authenticRecords);
  const authenticStreamSnapshots = authenticStreams.map((stream) => Buffer.from(stream));
  const authenticCurrentHead = 'c01c0791de9388ec7e578dacce447606ec475d76';
  const authenticTask = {
    ...structuredClone(firstFixture.aggregateTask),
    id: 'issue64-authentic-twelve-root-aggregate',
    sourceIds: authenticCompleteRows.map((row) => `thread:${row.threadNodeId}`),
    fingerprint: 'issue64-authentic-twelve-root-aggregate-fingerprint',
  };
  const authenticRemediation = {
    ...structuredClone(firstFixture.remediation),
    id: 'issue64-authentic-local-remediation',
    fingerprint: 'issue64-authentic-local-remediation-fingerprint',
    status: 'completed',
    integratedCommitSha: authenticCurrentHead,
  };
  const authenticActive = {
    ...structuredClone(firstFixture.active),
    repository: 'furinvader/aerstello',
    prNumber: 60,
    phase: 'verifying',
    currentIntegrationHeadSha: authenticCurrentHead,
    git: { branch: 'main', headSha: authenticCurrentHead, dirty: false },
    tasks: [authenticTask, authenticRemediation],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed',
      headSha: authenticCurrentHead,
      checks: ['node --test .agents/skills/pr-review-cycle/scripts/github/archive/adoption.test.mjs'],
      updatedAt: '2026-08-30T22:30:00.000Z',
    },
    threadResolutionStatus: proof('not-run'),
  };
  authenticActive.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: authenticCurrentHead,
    taskIds: [authenticRemediation.id], updatedAt: '2026-08-30T22:30:00.000Z',
  };
  const authenticViewer = {
    ...VIEWER, login: 'furinvader', url: 'https://github.com/furinvader',
  };
  const authenticClient = new FakeClient({
    pageSize: 3,
    metadata: {
      number: 60,
      headRefOid: authenticCurrentHead,
      url: 'https://github.com/furinvader/aerstello/pull/60',
      viewer: authenticViewer,
    },
  });
  for (const row of authenticCompleteRows) {
    const provenance = row.archiveProvenance;
    const authorityState = provenance === undefined
      ? authenticDecoded.r25.state : authenticDecoded.origin.state;
    const authorityEvents = provenance === undefined
      ? authenticDecoded.r25.events : authenticDecoded.origin.events;
    const historicalTaskId = provenance?.historicalTaskId ?? row.taskIds[0];
    const historicalTask = authorityState.tasks.find((task) => task.id === historicalTaskId);
    const replyOperationId = `reply:60:${row.threadNodeId}:${row.observedHeadSha}`;
    const replyIntent = authorityEvents.find((event) => (
      event.type === 'github-mutation-intent'
        && event.details?.operationId === replyOperationId
    ));
    assert.ok(historicalTask);
    assert.ok(replyIntent);
    const replyBody = [
      `Aerstello review resolution at ${row.observedHeadSha}.`,
      'Tasks:',
      historicalTask.integratedCommitSha
        ? `- ${historicalTask.id}: ${historicalTask.integratedCommitSha}`
        : `- ${historicalTask.id}: ${historicalTask.disposition} — ${historicalTask.resolutionSummary}`,
      `Validation: ${authorityState.validationStatus.checks.slice(0, 3).join(', ')}.`,
      markerFor(replyOperationId),
    ].join('\n');
    if (provenance !== undefined) {
      assert.equal(createHash('sha256').update(replyBody, 'utf8').digest('hex'),
        provenance.replyBodySha256);
    }
    const replyCreatedAt = new Date(Date.parse(replyIntent.details.at) + 1).toISOString();
    addThread(authenticClient, {
      id: row.threadNodeId,
      resolved: true,
      root: rootComment(row.threadNodeId, {
        id: row.rootCommentNodeId,
        databaseId: row.rootCommentDatabaseId,
        url: `https://github.com/furinvader/aerstello/pull/60#discussion_r${row.rootCommentDatabaseId}`,
        createdAt: new Date(Date.parse(replyIntent.details.at) - 60_000).toISOString(),
      }),
      replies: [{
        id: row.replyId,
        databaseId: Number(/discussion_r(\d+)$/u.exec(row.replyUrl)[1]),
        url: row.replyUrl,
        body: replyBody,
        createdAt: replyCreatedAt,
        lastEditedAt: null,
        author: authenticViewer,
        replyTo: { id: row.rootCommentNodeId },
        pullRequestReview: null,
      }],
    });
  }
  const authenticJournal = fakeJournal(authenticClient.events);
  const authenticStore = {
    calls: 0,
    async list() {
      this.calls += 1;
      const records = this.calls === 1
        ? authenticRecords : [authenticRecords[2], authenticRecords[0], authenticRecords[1]];
      return structuredClone(records);
    },
  };
  const authenticSetup = workflow(authenticActive, authenticClient, {
    archiveStore: authenticStore,
    git: fakeGit({
      snapshot: async () => ({ headSha: authenticCurrentHead, dirty: false }),
      pushedHead: async () => authenticCurrentHead,
      isAncestor: async () => true,
    }),
    journal: authenticJournal,
  });
  const authenticResult = await authenticSetup.api.replyResolve(60, authenticTask.id);
  const authenticImportedRows = authenticResult.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(authenticTask.id),
  );
  assert.equal(authenticStore.calls, 2);
  assert.equal(authenticSetup.state.calls.length, 1);
  assert.equal(authenticSetup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(authenticImportedRows.length, 12);
  assert.equal(new Set(authenticImportedRows.map(
    (row) => row.archiveProvenance?.authorityFingerprint,
  )).size, 1);
  assert.equal(authenticClient.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(authenticClient.events, []);
  assert.equal(authenticJournal.intents.size, 0);
  assert.deepEqual(authenticRecords, authenticRecordsSnapshot);
  for (const [index, stream] of authenticStreams.entries()) {
    assert.deepEqual(stream, authenticStreamSnapshots[index]);
  }
  const fiveRootTaskId = 'archived-pr35-five-thread-fixes-r1';
  const fiveRootRows = mixedArchive.state.threadResolutionStatus.threads.filter(
    (row) => row.taskIds[0] === fiveRootTaskId,
  );
  assert.equal(fiveRootRows.length, 5);
  const twoRootTaskId = 'issue64-two-root-split-partition';
  const twoRootIds = new Set(fiveRootRows.slice(3).map((row) => row.threadNodeId));
  for (const archive of [oldArchive, mixedArchive]) {
    const fiveRootTask = archive.state.tasks.find((task) => task.id === fiveRootTaskId);
    const twoRootTask = {
      ...structuredClone(fiveRootTask),
      id: twoRootTaskId,
      sourceIds: fiveRootTask.sourceIds.filter((source) => (
        twoRootIds.has(/^thread:(.+)$/u.exec(source)?.[1])
      )),
      fingerprint: 'issue64-two-root-split-partition-fingerprint',
      summary: 'Own the exact two-root partition in the compact Issue 64 topology.',
      resolutionSummary: 'The compact fixture retains this exact two-root partition.',
    };
    fiveRootTask.sourceIds = fiveRootTask.sourceIds.filter((source) => (
      !twoRootIds.has(/^thread:(.+)$/u.exec(source)?.[1])
    ));
    archive.state.tasks.push(twoRootTask);
    for (const row of archive.state.threadResolutionStatus.threads) {
      if (twoRootIds.has(row.threadNodeId)) row.taskIds = [twoRootTaskId];
    }
  }
  for (const threadId of twoRootIds) {
    const reply = firstFixture.client.threadComments.get(threadId)[1];
    reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
  }
  const sourceTaskId = 'pr-review-worker-commit-delta-integrity-r1';
  const sourceTask = mixedArchive.state.tasks.find((task) => task.id === sourceTaskId);
  const sourceRows = mixedArchive.state.threadResolutionStatus.threads.filter(
    (row) => row.taskIds[0] === sourceTaskId,
  );
  assert.equal(sourceRows.length, 3);
  const extensionTaskId = 'issue64-later-three-root-partition';
  const extensionCommit = '1640000000000000000000000000000000000001';
  const extensionTask = {
    ...structuredClone(sourceTask),
    id: extensionTaskId,
    sourceIds: [],
    fingerprint: 'issue64-later-three-root-partition-fingerprint',
    summary: 'Extend the retained topology with one later three-root partition.',
    integratedCommitSha: extensionCommit,
    resolutionSummary: 'The later complete carrier owns this exact three-root partition.',
  };
  const clonedEvents = [];
  for (const [index, sourceRow] of sourceRows.entries()) {
    const sourceThreadId = sourceRow.threadNodeId;
    const threadId = `PRRT_issue64_later_partition_${index + 1}`;
    const rootCommentNodeId = `PRRC_issue64_later_partition_root_${index + 1}`;
    const replyId = `PRRC_issue64_later_partition_reply_${index + 1}`;
    const rootCommentDatabaseId = 9_964_100 + index;
    const replyDatabaseId = 9_964_200 + index;
    extensionTask.sourceIds.push(`thread:${threadId}`);
    mixedArchive.state.threadResolutionStatus.threads.push({
      ...structuredClone(sourceRow),
      threadNodeId: threadId,
      rootCommentNodeId,
      rootCommentDatabaseId,
      taskIds: [extensionTaskId],
      replyId,
      replyUrl: `https://github.com/furinvader/aerstello/pull/35#discussion_r${replyDatabaseId}`,
    });
    firstFixture.client.threads.push({
      ...structuredClone(firstFixture.client.threads.find((thread) => thread.id === sourceThreadId)),
      id: threadId,
    });
    const [sourceRoot, sourceReply] = firstFixture.client.threadComments.get(sourceThreadId);
    const replyOperation = `reply:35:${threadId}:${sourceRow.observedHeadSha}`;
    firstFixture.client.threadComments.set(threadId, [{
      ...structuredClone(sourceRoot),
      id: rootCommentNodeId,
      databaseId: rootCommentDatabaseId,
      url: `https://github.com/furinvader/aerstello/pull/35#discussion_r${rootCommentDatabaseId}`,
    }, {
      ...structuredClone(sourceReply),
      id: replyId,
      databaseId: replyDatabaseId,
      url: `https://github.com/furinvader/aerstello/pull/35#discussion_r${replyDatabaseId}`,
      replyTo: { id: rootCommentNodeId },
      body: sourceReply.body
        .replace(`- ${sourceTaskId}: ${sourceTask.integratedCommitSha}`,
          `- ${extensionTaskId}: ${extensionCommit}`)
        .replace(/<!-- aerstello-review:[0-9a-f]{24} -->/u, markerFor(replyOperation)),
    }]);
    for (const sourceEvent of mixedArchive.events.filter((event) => (
      String(event.details?.operationId ?? '').includes(`:${sourceThreadId}:`)
    ))) {
      const cloned = structuredClone(sourceEvent);
      const type = cloned.details.type;
      const operationId = `${type}:35:${threadId}:${sourceRow.observedHeadSha}`;
      cloned.summary = `Intent ${type} ${operationId}`;
      cloned.details.operationId = operationId;
      cloned.details.clientMutationId = priorIntent(type, operationId).clientMutationId;
      clonedEvents.push(cloned);
    }
  }
  mixedArchive.state.tasks.push(extensionTask);
  mixedArchive.events.push(...clonedEvents);
  mixedArchive.events.sort((left, right) => left.at.localeCompare(right.at));
  const singletonTaskId = 'pr-review-repeated-archive-proof-adoption-r1';
  const singletonRoot = mixedArchive.state.threadResolutionStatus.threads.find(
    (row) => row.taskIds[0] === singletonTaskId,
  ).threadNodeId;
  const singletonPlaceholderId = 'issue64-pending-later-singleton';
  firstFixture.aggregateTask.sourceIds = firstFixture.aggregateTask.sourceIds.filter(
    (source) => source !== `thread:${singletonRoot}`,
  );
  firstFixture.active.tasks.push({
    ...structuredClone(mixedArchive.state.tasks.find((task) => task.id === singletonTaskId)),
    id: singletonPlaceholderId,
    fingerprint: 'issue64-pending-later-singleton-fingerprint',
    disposition: 'already-fixed',
    status: 'not-applicable',
    integratedCommitSha: null,
    resolutionSummary: 'Map the later singleton without giving it slice authority.',
  });
  const extensionPlaceholderId = 'issue64-pending-later-three-root-partition';
  firstFixture.active.tasks.push({
    ...structuredClone(extensionTask),
    id: extensionPlaceholderId,
    fingerprint: 'issue64-pending-later-three-root-partition-fingerprint',
    disposition: 'already-fixed',
    status: 'not-applicable',
    integratedCommitSha: null,
    resolutionSummary: 'Map the three later roots without giving them slice authority.',
  });
  const laterLive = new Map();
  for (const threadId of [
    singletonRoot,
    ...extensionTask.sourceIds.map((source) => /^thread:(.+)$/u.exec(source)[1]),
  ]) {
    laterLive.set(threadId, {
      thread: structuredClone(firstFixture.client.threads.find((thread) => thread.id === threadId)),
      comments: structuredClone(firstFixture.client.threadComments.get(threadId)),
    });
    firstFixture.client.threads.find((thread) => thread.id === threadId).isResolved = false;
    firstFixture.client.threadComments.set(
      threadId,
      firstFixture.client.threadComments.get(threadId).filter((comment) => comment.replyTo === null),
    );
  }
  firstFixture.active.tasks.find((task) => task.id === firstFixture.remediation.id).status = 'completed';
  firstFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [firstFixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
  };
  const packetGit = fakeGit({
    snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
    pushedHead: async () => PACKET_AGGREGATE_HEAD,
  });
  const first = workflow(firstFixture.active, firstFixture.client, {
    archiveStore: immutableArchiveStore([oldArchive, mixedArchive]),
    git: packetGit,
    journal: fakeJournal(firstFixture.client.events),
  });
  const firstResult = await first.api.replyResolve(35, firstFixture.aggregateTask.id);
  for (const [threadId, saved] of laterLive) {
    const index = firstFixture.client.threads.findIndex((thread) => thread.id === threadId);
    firstFixture.client.threads[index] = saved.thread;
    firstFixture.client.threadComments.set(threadId, saved.comments);
  }
  assert.equal(firstResult.threadResolutionStatus.threads.filter(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  ).length, 8);
  const authorityFingerprint = firstResult.threadResolutionStatus.threads.find(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  ).archiveProvenance.authorityFingerprint;
  const abandonmentReason = 'Preserve the provenance-bound aggregate carrier for a later fresh cycle.';
  const replayCarrier = {
    archiveId: 'pr-35-2026-08-20T12-10-00-000Z',
    state: {
      ...structuredClone(first.state.current),
      abandonmentReason,
      updatedAt: '2026-08-20T12:10:00.000Z',
    },
    events: [{
      schemaVersion: 1,
      type: 'abandoned',
      summary: `Archived without completion: ${abandonmentReason}`,
      at: '2026-08-20T12:10:00.010Z',
    }],
  };
  replayCarrier.state.tasks = replayCarrier.state.tasks.filter(
    (task) => ![singletonPlaceholderId, extensionPlaceholderId].includes(task.id),
  );

  const alternateTaskCarrier = structuredClone(replayCarrier);
  alternateTaskCarrier.archiveId = 'pr-35-2026-08-20T12-10-30-000Z';
  alternateTaskCarrier.state.updatedAt = '2026-08-20T09:30:00.000Z';
  alternateTaskCarrier.events[0].at = '2026-08-20T09:30:00.010Z';
  const alternateTaskId = 'alternate-provenance-bound-aggregate';
  alternateTaskCarrier.state.tasks.find(
    (task) => task.id === firstFixture.aggregateTask.id,
  ).id = alternateTaskId;
  for (const row of alternateTaskCarrier.state.threadResolutionStatus.threads) {
    if (Object.hasOwn(row, 'archiveProvenance')) row.taskIds = [alternateTaskId];
  }
  const replayPartitions = new Map();
  for (const row of alternateTaskCarrier.state.threadResolutionStatus.threads) {
    const historicalTaskId = row.archiveProvenance?.historicalTaskId;
    if (historicalTaskId === undefined) continue;
    const partition = replayPartitions.get(historicalTaskId) ?? [];
    partition.push(row);
    replayPartitions.set(historicalTaskId, partition);
  }
  const sliceHistoricalTaskIds = new Set([sourceTaskId, fiveRootTaskId, twoRootTaskId]);
  assert.deepEqual([...sliceHistoricalTaskIds]
    .map((taskId) => replayPartitions.get(taskId).length).sort(), [2, 3, 3]);
  const sliceRows = alternateTaskCarrier.state.threadResolutionStatus.threads.filter(
    (row) => sliceHistoricalTaskIds.has(row.archiveProvenance?.historicalTaskId),
  );
  assert.equal(sliceRows.length, 8);
  const sliceRoots = new Set(sliceRows.map((row) => row.threadNodeId));
  const sliceDiscussions = new Set(sliceRows.map((row) => row.rootCommentDatabaseId));
  alternateTaskCarrier.state.threadResolutionStatus.threads = sliceRows;
  alternateTaskCarrier.state.tasks.find(
    (task) => task.id === alternateTaskId,
  ).sourceIds = alternateTaskCarrier.state.tasks.find(
    (task) => task.id === alternateTaskId,
  ).sourceIds.filter((source) => {
    const thread = /^thread:(.+)$/u.exec(source)?.[1];
    const discussion = /^discussion:(\d+)$/u.exec(source)?.[1];
    return (thread !== undefined && sliceRoots.has(thread))
      || (discussion !== undefined && sliceDiscussions.has(Number(discussion)));
  });
  const alternateFixture = packetAggregateAdoptionFixture(
    structuredClone(fixtureOldArchive), structuredClone(fixtureMixedArchive),
  );
  for (const threadId of twoRootIds) {
    const reply = alternateFixture.client.threadComments.get(threadId)[1];
    reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
  }
  alternateFixture.aggregateTask.sourceIds.push(...extensionTask.sourceIds);
  for (const threadId of extensionTask.sourceIds.map((source) => /^thread:(.+)$/u.exec(source)[1])) {
    alternateFixture.client.threads.push(structuredClone(
      firstFixture.client.threads.find((thread) => thread.id === threadId),
    ));
    alternateFixture.client.threadComments.set(
      threadId, structuredClone(firstFixture.client.threadComments.get(threadId)),
    );
  }
  alternateFixture.active.tasks.find((task) => task.id === alternateFixture.remediation.id).status = 'completed';
  alternateFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [alternateFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
  };
  const equalCompleteCarrier = structuredClone(mixedArchive);
  equalCompleteCarrier.archiveId = 'pr-35-2026-08-20T23-59-59-999Z';
  equalCompleteCarrier.state.updatedAt = '2026-08-20T09:30:00.010Z';
  assert.equal(equalCompleteCarrier.events.at(-1).type, 'abandoned');
  equalCompleteCarrier.events.at(-1).at = '2026-08-20T09:30:00.010Z';
  assert.equal(
    equalCompleteCarrier.state.updatedAt,
    alternateTaskCarrier.events.at(-1).at,
  );
  assert.equal(equalCompleteCarrier.archiveId > mixedArchive.archiveId, true);
  assert.equal(mixedArchive.state.updatedAt > equalCompleteCarrier.state.updatedAt, true);
  const alternateCarrierSnapshot = structuredClone(alternateTaskCarrier);
  const alternateCarrierBytes = JSON.stringify(alternateTaskCarrier);
  const alternateRecords = [alternateTaskCarrier, mixedArchive, equalCompleteCarrier, oldArchive];
  assert.equal(
    alternateRecords.indexOf(equalCompleteCarrier) > alternateRecords.indexOf(mixedArchive), true,
  );
  const alternateRecordsSnapshot = structuredClone(alternateRecords);
  const alternateRecordsBytes = JSON.stringify(alternateRecords);
  const alternateStore = immutableArchiveStore(alternateRecords);
  const alternateJournal = fakeJournal(alternateFixture.client.events);
  const alternate = workflow(alternateFixture.active, alternateFixture.client, {
    archiveStore: alternateStore,
    git: packetGit,
    journal: alternateJournal,
  });
  const alternateResult = await alternate.api.replyResolve(35, alternateFixture.aggregateTask.id);
  assert.equal(alternateStore.calls, 2);
  assert.equal(alternate.state.calls.length, 1);
  const alternateImportedRows = alternateResult.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(alternateFixture.aggregateTask.id),
  );
  assert.equal(alternateImportedRows.length, 12);
  assert.equal(new Set(alternateImportedRows.map(
    (row) => row.archiveProvenance?.authorityFingerprint,
  )).size, 1);
  assert.equal(alternateTaskCarrier.state.threadResolutionStatus.threads.length, 8);
  assert.equal(alternateTaskCarrier.state.threadResolutionStatus.threads.every(
    (row) => row.archiveProvenance?.authorityFingerprint === authorityFingerprint,
  ), true);
  assert.equal(alternate.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(
    alternateFixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(alternateFixture.client.events, []);
  assert.equal(alternateJournal.intents.size, 0);
  assert.deepEqual(alternateTaskCarrier, alternateCarrierSnapshot);
  assert.equal(JSON.stringify(alternateTaskCarrier), alternateCarrierBytes);
  assert.deepEqual(alternateRecords, alternateRecordsSnapshot);
  assert.equal(JSON.stringify(alternateRecords), alternateRecordsBytes);
  const fullReplayReason = 'Preserve the later complete provenance carrier.';
  const fullReplayCarrier = {
    archiveId: 'pr-35-2026-08-20T12-40-00-000Z',
    state: {
      ...structuredClone(alternate.state.current),
      abandonmentReason: fullReplayReason,
      updatedAt: '2026-08-20T12:40:00.000Z',
    },
    events: [{
      schemaVersion: 1,
      type: 'abandoned',
      summary: `Archived without completion: ${fullReplayReason}`,
      at: '2026-08-20T12:40:00.010Z',
    }],
  };

  const priorReplayRejections = [
    ['partial owner source coverage', ({ carrier }) => {
      const row = carrier.state.threadResolutionStatus.threads.find(
        (item) => Object.hasOwn(item, 'archiveProvenance'),
      );
      const owner = carrier.state.tasks.find((task) => task.id === alternateTaskId);
      owner.sourceIds = owner.sourceIds.filter((source) => (
        source !== `thread:${row.threadNodeId}`
          && source !== `discussion:${row.rootCommentDatabaseId}`
      ));
    }],
    ['extra owner source coverage', ({ carrier }) => {
      carrier.state.tasks.find((task) => task.id === alternateTaskId)
        .sourceIds.push(`thread:${singletonRoot}`);
    }],
    ['missing owner proof row', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.pop();
    }],
    ['multiple row owners', ({ carrier }) => {
      const owner = carrier.state.tasks.find((task) => task.id === alternateTaskId);
      const secondOwner = { ...structuredClone(owner), id: 'prior-replay-second-owner' };
      carrier.state.tasks.push(secondOwner);
      carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).taskIds = [secondOwner.id];
    }],
    ['full prior-aggregate carrier cannot replace a distinct complete carrier', ({ records }) => {
      const fullPriorAggregate = structuredClone(fullReplayCarrier);
      const historicalTaskIds = [...new Set(fullPriorAggregate.state.threadResolutionStatus.threads
        .filter((row) => Object.hasOwn(row, 'archiveProvenance'))
        .map((row) => row.archiveProvenance.historicalTaskId))].sort();
      const taskGroups = [
        historicalTaskIds.filter((_, index) => index % 2 === 0),
        historicalTaskIds.filter((_, index) => index % 2 === 1),
      ];
      const partialOrigins = taskGroups.map((taskIds, index) => {
        const taskIdSet = new Set(taskIds);
        const partial = structuredClone(mixedArchive);
        partial.archiveId = `pr-35-2026-08-20T12-0${8 + index}-00-000Z`;
        partial.state.tasks = partial.state.tasks.filter((task) => taskIdSet.has(task.id));
        partial.state.threadResolutionStatus.threads = partial.state.threadResolutionStatus.threads
          .filter((row) => taskIdSet.has(row.taskIds[0]));
        const retainedRoots = new Set(partial.state.threadResolutionStatus.threads
          .map((row) => row.threadNodeId));
        partial.events = partial.events.filter((event) => (
          event.type !== 'github-mutation-intent'
            || [...retainedRoots].some((root) => (
              String(event.details?.operationId ?? '').includes(`:${root}:`)
            ))
        ));
        return partial;
      });
      assert.equal(partialOrigins.every((origin) => (
        origin.state.threadResolutionStatus.threads.length > 0
          && origin.state.threadResolutionStatus.threads.length < 12
      )), true);
      assert.equal(partialOrigins.reduce((count, origin) => (
        count + origin.state.threadResolutionStatus.threads.length
      ), 0), 12);
      records.splice(0, records.length, fullPriorAggregate, ...partialOrigins);
    }],
    ['duplicate partial prior-aggregate carrier', ({ carrier, records }) => {
      const duplicate = structuredClone(carrier);
      duplicate.archiveId = 'pr-35-2026-08-20T12-09-30-000Z';
      records.unshift(duplicate);
    }],
    ['sliced anchored partition', ({ carrier }) => {
      const row = carrier.state.threadResolutionStatus.threads[0];
      carrier.state.threadResolutionStatus.threads.shift();
      const owner = carrier.state.tasks.find((task) => task.id === alternateTaskId);
      owner.sourceIds = owner.sourceIds.filter((source) => (
        source !== `thread:${row.threadNodeId}`
          && source !== `discussion:${row.rootCommentDatabaseId}`
      ));
    }],
    ['missing later complete carrier', ({ records }) => records.splice(1, 1)],
    ['prior-aggregate terminal event postdates the complete carrier', ({ carrier }) => {
      carrier.events.at(-1).at = '2026-08-20T10:00:00.010Z';
    }],
    ['prior-aggregate terminal bound equals the complete carrier bound', ({ carrier, records }) => {
      carrier.events.at(-1).at = records[1].state.updatedAt;
    }],
    ['duplicate owner task', ({ carrier }) => {
      carrier.state.tasks.push(structuredClone(
        carrier.state.tasks.find((task) => task.id === alternateTaskId),
      ));
    }],
    ['owner source drift', ({ carrier }) => {
      carrier.state.tasks.find((task) => task.id === alternateTaskId).sourceType = 'local';
    }],
    ['owner status drift', ({ carrier }) => {
      carrier.state.tasks.find((task) => task.id === alternateTaskId).status = 'not-applicable';
    }],
    ['owner disposition drift', ({ carrier }) => {
      carrier.state.tasks.find((task) => task.id === alternateTaskId).disposition = 'actionable';
    }],
    ['owner commit drift', ({ carrier }) => {
      carrier.state.tasks.find((task) => task.id === alternateTaskId)
        .integratedCommitSha = '9'.repeat(40);
    }],
    ['missing older ordinary origin', ({ records }) => records.splice(1)],
    ['divergent older ordinary origin', ({ records }) => {
      const divergent = structuredClone(records[2]);
      divergent.archiveId = 'pr-35-2026-08-20T11-59-30-000Z';
      divergent.state.tasks[0].summary += ' divergent';
      records.push(divergent);
    }],
    ['proof core drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).replyUrl += '?drifted=1';
    }],
    ['historical task drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.historicalTaskId = 'prior-replay-drifted-task';
    }],
    ['historical disposition drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => row.archiveProvenance?.historicalDisposition === 'fixed',
      ).archiveProvenance.historicalDisposition = 'already-fixed';
    }],
    ['historical commit drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => row.archiveProvenance?.historicalDisposition === 'fixed',
      ).archiveProvenance.historicalIntegratedCommitSha = '8'.repeat(40);
    }],
    ['reply body hash drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.replyBodySha256 = '7'.repeat(64);
    }],
    ['authority fingerprint drift', ({ carrier }) => {
      carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.authorityFingerprint = '6'.repeat(64);
    }],
    ['selected-root mutation intent', ({ carrier }) => {
      const row = carrier.state.threadResolutionStatus.threads.find(
        (item) => Object.hasOwn(item, 'archiveProvenance'),
      );
      carrier.events.splice(-1, 0, archiveIntentEvent(
        'reply', `reply:35:${row.threadNodeId}:${row.observedHeadSha}`,
        '2026-08-20T12:09:00.000Z', '2026-08-20T12:09:00.010Z',
      ));
    }],
    ['unanchored selected-root task', ({ carrier }) => {
      const row = carrier.state.threadResolutionStatus.threads.find(
        (item) => Object.hasOwn(item, 'archiveProvenance'),
      );
      carrier.state.tasks.push({
        id: 'prior-replay-unanchored-selected-task',
        sourceIds: [`thread:${row.threadNodeId}`],
        sourceType: 'github-thread', fingerprint: 'prior-replay-unanchored-fingerprint',
        summary: 'Overlap one selected replay root.', severity: 'P2',
        disposition: 'already-fixed', status: 'not-applicable',
        integratedCommitSha: null, resolutionSummary: 'Not an authority owner.',
      });
    }],
    ['off-selection owner proof', ({ carrier }) => {
      const source = carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      );
      carrier.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: 'PRRT_prior_replay_off_selection',
        rootCommentNodeId: 'PRRC_prior_replay_off_selection',
        rootCommentDatabaseId: 9_902_000,
        replyId: 'PRRC_prior_replay_off_selection_reply',
        replyUrl: 'https://github.com/furinvader/aerstello/pull/35#discussion_r9902000',
      });
    }],
    ['off-selection anchored provenance', ({ carrier }) => {
      const source = carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      );
      const ownerId = 'prior-replay-off-selection-owner';
      carrier.state.tasks.push({
        id: ownerId,
        sourceIds: ['thread:PRRT_prior_replay_off_selection_anchor'],
        sourceType: 'github-thread', fingerprint: 'prior-replay-off-selection-fingerprint',
        summary: 'Own unrelated off-selection proof.', severity: 'P2',
        disposition: 'already-fixed', status: 'completed', integratedCommitSha: null,
        resolutionSummary: 'Retain separate proof.',
      });
      carrier.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: 'PRRT_prior_replay_off_selection_anchor',
        rootCommentNodeId: 'PRRC_prior_replay_off_selection_anchor',
        rootCommentDatabaseId: 9_902_001,
        taskIds: [ownerId],
        replyId: 'PRRC_prior_replay_off_selection_anchor_reply',
        replyUrl: 'https://github.com/furinvader/aerstello/pull/35#discussion_r9902001',
      });
    }],
  ];
  for (const [label, mutate] of priorReplayRejections) {
    const fixture = packetAggregateAdoptionFixture(
      structuredClone(fixtureOldArchive), structuredClone(fixtureMixedArchive),
    );
    for (const threadId of twoRootIds) {
      const reply = fixture.client.threadComments.get(threadId)[1];
      reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
    }
    fixture.aggregateTask.sourceIds.push(...extensionTask.sourceIds);
    for (const threadId of extensionTask.sourceIds.map((source) => /^thread:(.+)$/u.exec(source)[1])) {
      fixture.client.threads.push(structuredClone(
        firstFixture.client.threads.find((thread) => thread.id === threadId),
      ));
      fixture.client.threadComments.set(
        threadId, structuredClone(firstFixture.client.threadComments.get(threadId)),
      );
    }
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
    };
    const carrier = structuredClone(alternateTaskCarrier);
    const records = [carrier, structuredClone(mixedArchive), structuredClone(oldArchive)];
    mutate({ carrier, records });
    const recordsSnapshot = structuredClone(records);
    const recordsBytes = JSON.stringify(records);
    const journal = fakeJournal(fixture.client.events);
    const rejected = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore(records), git: packetGit, journal,
    });
    const durableSnapshot = structuredClone(rejected.state.current);
    await assert.rejects(
      () => rejected.api.replyResolve(35, fixture.aggregateTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(rejected.state.calls.length, 0, label);
    assert.deepEqual(rejected.state.current, durableSnapshot, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(fixture.client.events, [], label);
    assert.deepEqual(records, recordsSnapshot, label);
    assert.equal(JSON.stringify(records), recordsBytes, label);
  }

  const sliceRaceFixture = packetAggregateAdoptionFixture(
    structuredClone(fixtureOldArchive), structuredClone(fixtureMixedArchive),
  );
  sliceRaceFixture.aggregateTask.sourceIds.push(...extensionTask.sourceIds);
  for (const threadId of twoRootIds) {
    const reply = sliceRaceFixture.client.threadComments.get(threadId)[1];
    reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
  }
  for (const threadId of extensionTask.sourceIds.map(
    (source) => /^thread:(.+)$/u.exec(source)[1],
  )) {
    sliceRaceFixture.client.threads.push(structuredClone(
      firstFixture.client.threads.find((thread) => thread.id === threadId),
    ));
    sliceRaceFixture.client.threadComments.set(
      threadId, structuredClone(firstFixture.client.threadComments.get(threadId)),
    );
  }
  sliceRaceFixture.active.tasks.find(
    (task) => task.id === sliceRaceFixture.remediation.id,
  ).status = 'completed';
  sliceRaceFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [sliceRaceFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
  };
  const sliceRaceRecords = [
    structuredClone(alternateTaskCarrier), structuredClone(mixedArchive), structuredClone(oldArchive),
  ];
  const sliceRaceJournal = fakeJournal(sliceRaceFixture.client.events);
  const sliceRaceStore = immutableArchiveStore(sliceRaceRecords, (calls) => {
    if (calls === 2) {
      sliceRaceRecords[0].state.tasks.find(
        (task) => task.id === alternateTaskId,
      ).summary += ' raced';
    }
  });
  const sliceRace = workflow(sliceRaceFixture.active, sliceRaceFixture.client, {
    archiveStore: sliceRaceStore, git: packetGit, journal: sliceRaceJournal,
  });
  await assert.rejects(
    () => sliceRace.api.replyResolve(35, sliceRaceFixture.aggregateTask.id),
    GitHubWorkflowError,
    'second inventory read changes the whole-partition slice carrier',
  );
  assert.equal(sliceRaceStore.calls, 2);
  assert.equal(sliceRace.state.calls.length, 0);
  assert.equal(sliceRaceJournal.intents.size, 0);
  assert.equal(sliceRaceFixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(sliceRaceFixture.client.events, []);

  const replayClosureCases = [
    ['active replay unanchored selected-root task', () => {
      const carrier = structuredClone(fullReplayCarrier);
      const selectedRow = carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      );
      carrier.state.tasks.push({
        id: 'active-replay-unanchored-selected-task',
        sourceIds: [`discussion:${selectedRow.rootCommentDatabaseId}`],
        sourceType: 'github-thread',
        fingerprint: 'active-replay-unanchored-selected-task-fingerprint',
        summary: 'An unanchored task overlaps replay authority.',
        severity: 'P2', disposition: 'already-fixed', status: 'not-applicable',
        integratedCommitSha: null, resolutionSummary: 'No proof belongs to this task.',
      });
      return carrier;
    }],
    ['active replay off-partition anchored proof', () => {
      const carrier = structuredClone(fullReplayCarrier);
      const source = carrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      );
      const historicalTaskId = source.archiveProvenance.historicalTaskId;
      const offPartitionThreadId = 'PRRT_active_replay_off_partition';
      carrier.state.tasks.push({
        id: historicalTaskId,
        sourceIds: [`thread:${offPartitionThreadId}`],
        sourceType: 'github-thread',
        fingerprint: 'active-replay-off-partition-task-fingerprint',
        summary: 'An anchored historical ID appears outside its partition.',
        severity: 'P2', disposition: 'already-fixed', status: 'completed',
        integratedCommitSha: null, resolutionSummary: 'Recorded as an invalid replay extra.',
      });
      const offPartitionRow = {
        ...structuredClone(source),
        threadNodeId: offPartitionThreadId,
        rootCommentNodeId: 'PRRC_active_replay_off_partition',
        rootCommentDatabaseId: 9_901_000,
        taskIds: [historicalTaskId],
        replyId: 'PRRC_active_replay_off_partition_reply',
        replyUrl: 'https://github.com/furinvader/aerstello/pull/35#discussion_r9901000',
      };
      delete offPartitionRow.archiveProvenance;
      carrier.state.threadResolutionStatus.threads.push(offPartitionRow);
      return carrier;
    }],
    ['active replay off-selected provenance references anchored authority', () => {
      const carrier = structuredClone(fullReplayCarrier);
      const source = carrier.state.threadResolutionStatus.threads.find(
        (row) => row.archiveProvenance?.historicalDisposition === 'already-fixed',
      );
      const ownerTaskId = 'active-replay-off-selected-provenance-owner';
      const offSelectedThreadId = 'PRRT_active_replay_off_selected_provenance_owner';
      carrier.state.tasks.push({
        id: ownerTaskId,
        sourceIds: [`thread:${offSelectedThreadId}`],
        sourceType: 'github-thread',
        fingerprint: 'active-replay-off-selected-provenance-owner-fingerprint',
        summary: 'Own an off-selection row that references anchored replay authority.',
        severity: 'P2', disposition: 'already-fixed', status: 'completed',
        integratedCommitSha: null, resolutionSummary: 'Retain separate off-selection proof.',
      });
      carrier.state.threadResolutionStatus.threads.push({
        ...structuredClone(source),
        threadNodeId: offSelectedThreadId,
        rootCommentNodeId: 'PRRC_active_replay_off_selected_provenance_owner',
        rootCommentDatabaseId: 9_901_001,
        taskIds: [ownerTaskId],
        replyId: 'PRRC_active_replay_off_selected_provenance_owner_reply',
        replyUrl: 'https://github.com/furinvader/aerstello/pull/35#discussion_r9901001',
        archiveProvenance: {
          ...structuredClone(source.archiveProvenance),
          replyBodySha256: '7'.repeat(64),
          authorityFingerprint: '8'.repeat(64),
        },
      });
      return carrier;
    }],
  ];
  for (const [label, createCarrier] of replayClosureCases) {
    const closureFixture = packetAggregateAdoptionFixture(
      structuredClone(fixtureOldArchive), structuredClone(fixtureMixedArchive),
    );
    closureFixture.aggregateTask.sourceIds.push(...extensionTask.sourceIds);
    for (const threadId of twoRootIds) {
      const reply = closureFixture.client.threadComments.get(threadId)[1];
      reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
    }
    for (const threadId of extensionTask.sourceIds.map((source) => /^thread:(.+)$/u.exec(source)[1])) {
      closureFixture.client.threads.push(structuredClone(
        firstFixture.client.threads.find((thread) => thread.id === threadId),
      ));
      closureFixture.client.threadComments.set(
        threadId, structuredClone(firstFixture.client.threadComments.get(threadId)),
      );
    }
    closureFixture.active.tasks.find(
      (task) => task.id === closureFixture.remediation.id,
    ).status = 'completed';
    closureFixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [closureFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
    };
    const closureJournal = fakeJournal(closureFixture.client.events);
    const closure = workflow(closureFixture.active, closureFixture.client, {
      archiveStore: immutableArchiveStore([createCarrier(), mixedArchive, oldArchive]),
      git: packetGit,
      journal: closureJournal,
    });
    const durableSnapshot = structuredClone(closure.state.current);
    await assert.rejects(
      () => closure.api.replyResolve(35, closureFixture.aggregateTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(closure.state.calls.length, 0, label);
    assert.deepEqual(closure.state.current, durableSnapshot, label);
    assert.equal(closureJournal.intents.size, 0, label);
    assert.equal(closureFixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(closureFixture.client.events, [], label);
  }

  const retryFixture = packetAggregateAdoptionFixture(
    structuredClone(fixtureOldArchive), structuredClone(fixtureMixedArchive),
  );
  retryFixture.aggregateTask.sourceIds.push(...extensionTask.sourceIds);
  for (const threadId of twoRootIds) {
    const reply = retryFixture.client.threadComments.get(threadId)[1];
    reply.body = reply.body.replace(`- ${fiveRootTaskId}:`, `- ${twoRootTaskId}:`);
  }
  for (const threadId of extensionTask.sourceIds.map((source) => /^thread:(.+)$/u.exec(source)[1])) {
    retryFixture.client.threads.push(structuredClone(
      firstFixture.client.threads.find((thread) => thread.id === threadId),
    ));
    retryFixture.client.threadComments.set(
      threadId, structuredClone(firstFixture.client.threadComments.get(threadId)),
    );
  }
  retryFixture.active.tasks.find((task) => task.id === retryFixture.remediation.id).status = 'completed';
  retryFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [retryFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
  };
  const retryStore = immutableArchiveStore([fullReplayCarrier, mixedArchive, oldArchive]);
  const retry = workflow(retryFixture.active, retryFixture.client, {
    archiveStore: retryStore,
    git: packetGit,
    journal: fakeJournal(retryFixture.client.events),
  });
  const retried = await retry.api.replyResolve(35, retryFixture.aggregateTask.id);

  assert.equal(retryStore.calls, 2);
  assert.equal(retry.state.calls.length, 1);
  assert.equal(retried.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(retryFixture.aggregateTask.id)
      && Object.hasOwn(row, 'archiveProvenance'),
  ).length, 12);
  assert.equal(
    retryFixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(retryFixture.client.events, []);
});

test('a globally fresh aggregate identity bypasses multiple proofless wrappers without hiding same-ID evidence', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const priorFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  priorFixture.active.tasks.find((task) => task.id === priorFixture.remediation.id).status = 'completed';
  priorFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [priorFixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
  };
  const packetGit = fakeGit({
    snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
    pushedHead: async () => PACKET_AGGREGATE_HEAD,
  });
  const prior = workflow(priorFixture.active, priorFixture.client, {
    archiveStore: immutableArchiveStore([oldArchive, mixedArchive]),
    git: packetGit,
    journal: fakeJournal(priorFixture.client.events),
  });
  const priorResult = await prior.api.replyResolve(35, priorFixture.aggregateTask.id);
  const authorityFingerprint = priorResult.threadResolutionStatus.threads.find(
    (row) => Object.hasOwn(row, 'archiveProvenance'),
  ).archiveProvenance.authorityFingerprint;
  const priorAggregateReason = 'Preserve the all-provenance prior aggregate replay carrier.';
  const priorAggregateCarrier = {
    archiveId: 'pr-35-2026-08-20T12-10-00-000Z',
    state: {
      ...structuredClone(prior.state.current),
      abandonmentReason: priorAggregateReason,
      updatedAt: '2026-08-20T09:30:00.000Z',
    },
    events: [{
      schemaVersion: 1,
      type: 'abandoned',
      summary: `Archived without completion: ${priorAggregateReason}`,
      at: '2026-08-20T09:30:00.010Z',
    }],
  };

  const firstProoflessWrapperReason = 'Abandon the first proofless wrapper before starting a fresh aggregate.';
  const firstProoflessWrapper = {
    archiveId: 'pr-35-2026-08-20T12-20-00-000Z',
    state: {
      ...structuredClone(priorFixture.active),
      tasks: [structuredClone(priorFixture.aggregateTask)],
      abandonmentReason: firstProoflessWrapperReason,
      updatedAt: '2026-08-20T12:20:00.000Z',
    },
    events: [{
      schemaVersion: 1,
      type: 'abandoned',
      summary: `Archived without completion: ${firstProoflessWrapperReason}`,
      at: '2026-08-20T12:20:00.010Z',
    }],
  };
  const secondProoflessTaskId = 'abandoned-proofless-aggregate-r2';
  const secondProoflessTask = {
    ...structuredClone(priorFixture.aggregateTask),
    id: secondProoflessTaskId,
    fingerprint: 'fp-abandoned-proofless-aggregate-r2',
  };
  const secondProoflessWrapperReason = 'Abandon the second proofless wrapper before starting a fresh aggregate.';
  const secondProoflessWrapper = {
    archiveId: 'pr-35-2026-08-20T12-25-00-000Z',
    state: {
      ...structuredClone(priorFixture.active),
      tasks: [secondProoflessTask],
      abandonmentReason: secondProoflessWrapperReason,
      updatedAt: '2026-08-20T12:25:00.000Z',
    },
    events: [{
      schemaVersion: 1,
      type: 'abandoned',
      summary: `Archived without completion: ${secondProoflessWrapperReason}`,
      at: '2026-08-20T12:25:00.010Z',
    }],
  };

  const freshFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  freshFixture.active.tasks.find((task) => task.id === freshFixture.remediation.id).status = 'completed';
  freshFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [freshFixture.remediation.id], updatedAt: '2026-08-20T12:30:00.000Z',
  };
  const priorAggregateTaskId = freshFixture.aggregateTask.id;
  const freshAggregateTaskId = 'fresh-after-proofless-wrapper-r1';
  freshFixture.aggregateTask.id = freshAggregateTaskId;
  freshFixture.aggregateTask.fingerprint = 'fp-fresh-after-proofless-wrapper-r1';
  const inventory = [
    secondProoflessWrapper,
    firstProoflessWrapper,
    priorAggregateCarrier,
    mixedArchive,
    oldArchive,
  ];
  const inventorySnapshot = structuredClone(inventory);
  const inventoryBytes = JSON.stringify(inventory);
  const freshStore = immutableArchiveStore(inventory);
  const freshJournal = fakeJournal(freshFixture.client.events);
  const fresh = workflow(freshFixture.active, freshFixture.client, {
    archiveStore: freshStore, git: packetGit, journal: freshJournal,
  });
  const result = await fresh.api.replyResolve(35, freshAggregateTaskId);
  const importedRows = result.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(freshAggregateTaskId),
  );

  assert.equal(freshStore.calls, 2);
  assert.equal(fresh.state.calls.length, 1);
  assert.equal(fresh.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(importedRows.length, 9);
  assert.equal(importedRows.every((row) => (
    row.disposition === 'already-fixed'
      && row.archiveProvenance?.authorityFingerprint === authorityFingerprint
  )), true);
  assert.equal(freshFixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(freshFixture.client.events, []);
  assert.equal(freshJournal.intents.size, 0);
  assert.deepEqual(inventory, inventorySnapshot);
  assert.equal(JSON.stringify(inventory), inventoryBytes);

  for (const collidingTaskId of [priorAggregateTaskId, secondProoflessTaskId]) {
    const sameIdFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    sameIdFixture.active.tasks.find(
      (task) => task.id === sameIdFixture.remediation.id,
    ).status = 'completed';
    sameIdFixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [sameIdFixture.remediation.id], updatedAt: '2026-08-20T12:30:00.000Z',
    };
    sameIdFixture.aggregateTask.id = collidingTaskId;
    sameIdFixture.aggregateTask.fingerprint = `fp-collision-${collidingTaskId}`;
    const sameIdInventory = structuredClone(inventorySnapshot);
    const sameIdSnapshot = structuredClone(sameIdInventory);
    const sameIdBytes = JSON.stringify(sameIdInventory);
    const sameIdStore = immutableArchiveStore(sameIdInventory);
    const sameIdJournal = fakeJournal(sameIdFixture.client.events);
    const sameId = workflow(sameIdFixture.active, sameIdFixture.client, {
      archiveStore: sameIdStore, git: packetGit, journal: sameIdJournal,
    });
    const durableSnapshot = structuredClone(sameId.state.current);

    await assert.rejects(
      () => sameId.api.replyResolve(35, collidingTaskId),
      GitHubWorkflowError,
      collidingTaskId,
    );
    assert.equal(sameId.state.calls.length, 0, collidingTaskId);
    assert.deepEqual(sameId.state.current, durableSnapshot, collidingTaskId);
    assert.equal(sameIdJournal.intents.size, 0, collidingTaskId);
    assert.equal(sameIdFixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, collidingTaskId);
    assert.deepEqual(sameIdFixture.client.events, [], collidingTaskId);
    assert.deepEqual(sameIdInventory, sameIdSnapshot, collidingTaskId);
    assert.equal(JSON.stringify(sameIdInventory), sameIdBytes, collidingTaskId);
  }
});

test('archive adoption accepts exact 6-to-10-to-14 partial-mixed lineage and proofless covers', async () => {
  const buildTopology = async () => {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    for (const archive of [oldArchive, mixedArchive]) {
      archive.state.tasks = archive.state.tasks.filter(
        (task) => !task.sourceIds.includes(`thread:${PACKET_PORTABILITY_THREAD_ID}`),
      );
    }
    const ordinaryTaskId = 'pr-review-worker-commit-delta-integrity-r1';
    const ordinaryTask = structuredClone(
      mixedArchive.state.tasks.find((task) => task.id === ordinaryTaskId),
    );
    const ordinaryRows = new Map(mixedArchive.state.threadResolutionStatus.threads
      .filter((row) => row.taskIds[0] === ordinaryTaskId)
      .map((row) => [row.threadNodeId, structuredClone(row)]));
    assert.equal(ordinaryRows.size, 3);
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.aggregateTask.sourceIds = fixture.aggregateTask.sourceIds.filter(
      (source) => !ordinaryRows.has(/^thread:(.+)$/u.exec(source)?.[1]),
    );
    const ordinaryPlaceholderId = 'pending-three-root-origin-placeholder';
    const ordinaryLive = new Map();
    for (const threadId of ordinaryRows.keys()) {
      ordinaryLive.set(threadId, {
        thread: structuredClone(fixture.client.threads.find((thread) => thread.id === threadId)),
        comments: structuredClone(fixture.client.threadComments.get(threadId)),
      });
      fixture.client.threads.find((thread) => thread.id === threadId).isResolved = false;
      fixture.client.threadComments.set(
        threadId,
        fixture.client.threadComments.get(threadId).filter((comment) => comment.replyTo === null),
      );
    }
    fixture.active.tasks.push({
      ...structuredClone(ordinaryTask),
      id: ordinaryPlaceholderId,
      fingerprint: 'pending-three-root-origin-placeholder-fingerprint',
      disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Retained only to map the roots before the later terminal carrier.',
    });
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const packetGit = fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    });
    const first = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([oldArchive, mixedArchive]),
      git: packetGit,
      journal: fakeJournal(fixture.client.events),
      clock: { now: () => '2026-08-20T12:05:00.000Z' },
    });
    await first.api.replyResolve(35, fixture.aggregateTask.id);
    await first.api.replyResolve(35, fixture.portabilityTask.id);
    for (const [threadId, saved] of ordinaryLive) {
      const index = fixture.client.threads.findIndex((thread) => thread.id === threadId);
      fixture.client.threads[index] = saved.thread;
      fixture.client.threadComments.set(threadId, saved.comments);
    }

    const terminalState = structuredClone(first.state.current);
    terminalState.threadResolutionStatus.threads = terminalState.threadResolutionStatus.threads
      .map((row) => ordinaryRows.get(row.threadNodeId) ?? row);
    terminalState.tasks = terminalState.tasks.filter((task) => task.id !== ordinaryPlaceholderId);
    const replayRows = terminalState.threadResolutionStatus.threads.filter(
      (row) => Object.hasOwn(row, 'archiveProvenance'),
    );
    assert.equal(replayRows.length, 6);
    terminalState.tasks.push(ordinaryTask);
    terminalState.abandonmentReason = 'Preserve the six-replay plus four-origin carrier.';
    terminalState.updatedAt = '2026-08-20T12:10:00.000Z';
    const portabilityRow = terminalState.threadResolutionStatus.threads.find(
      (row) => row.threadNodeId === PACKET_PORTABILITY_THREAD_ID,
    );
    const portabilityReply = fixture.client.threadComments.get(PACKET_PORTABILITY_THREAD_ID)[1];
    portabilityReply.createdAt = '2026-08-20T12:03:30.000Z';
    const replyOperation = `reply:35:${PACKET_PORTABILITY_THREAD_ID}:${PACKET_AGGREGATE_HEAD}`;
    const resolveOperation = `resolve:35:${PACKET_PORTABILITY_THREAD_ID}:${PACKET_AGGREGATE_HEAD}`;
    const terminalCarrier = {
      archiveId: 'pr-35-2026-08-20T12-10-00-000Z',
      state: terminalState,
      events: [
        ...mixedArchive.events.filter((event) => (
          event.type === 'github-mutation-intent'
            && [...ordinaryRows.keys()].some((threadId) => (
              String(event.details?.operationId ?? '').includes(threadId)
            ))
        )).map((event) => structuredClone(event)),
        archiveIntentEvent('reply', replyOperation, '2026-08-20T12:03:00.000Z'),
        archiveIntentEvent('resolve', resolveOperation, '2026-08-20T12:04:00.000Z'),
        {
          schemaVersion: 1, type: 'abandoned',
          summary: `Archived without completion: ${terminalState.abandonmentReason}`,
          at: '2026-08-20T12:10:00.010Z',
        },
      ],
    };
    assert.equal(portabilityRow.isResolved, true);

    const successorTaskId = 'close-round-two-scope-evidence-invariants-r3';
    const predecessorTaskId = 'close-round-two-scope-evidence-invariants-r2';
    const successorCommit = 'b1a2135aa09417e825707b415bfcd9cae89e15b1';
    const successorProofHead = 'c2b3246bb10528f936818c526ceda0dbf90f26c2';
    const predecessorCommit = '62fef0589e2edc7c87c06e8f5de26c12d3fbc6b4';
    const successorRoots = new Set([
      ...ordinaryRows.keys(),
      PACKET_PORTABILITY_THREAD_ID,
    ]);
    const successorSourceIds = [...successorRoots].map((threadId) => `thread:${threadId}`);
    terminalState.tasks = terminalState.tasks.filter((task) => (
      ![ordinaryTaskId, PACKET_PORTABILITY_TASK_ID].includes(task.id)
    ));
    terminalState.tasks.push({
      ...structuredClone(ordinaryTask),
      id: successorTaskId,
      sourceIds: successorSourceIds,
      fingerprint: `${successorTaskId}-fingerprint`,
      integratedCommitSha: successorCommit,
      resolutionSummary: 'The completed successor owns the exact four-root partition.',
    });
    for (const row of terminalState.threadResolutionStatus.threads) {
      if (!successorRoots.has(row.threadNodeId)) continue;
      row.taskIds = [successorTaskId];
      row.observedHeadSha = successorProofHead;
      row.disposition = 'fixed';
      const reply = fixture.client.threadComments.get(row.threadNodeId)[1];
      reply.body = reply.body
        .replace(/^Aerstello review resolution at [0-9a-f]+\./u,
          `Aerstello review resolution at ${successorProofHead}.`)
        .replace(/^Tasks:\n(?:- [^\n]+\n)+Validation:/mu,
          `Tasks:\n- ${successorTaskId}: ${successorCommit}\nValidation:`)
        .replace(/<!-- aerstello-review:[0-9a-f]{24} -->/u, markerFor(
          `reply:35:${row.threadNodeId}:${successorProofHead}`,
        ));
    }
    for (const event of terminalCarrier.events) {
      const match = /^(reply|resolve):35:([^:]+):[0-9a-f]+$/u.exec(
        event.details?.operationId ?? '',
      );
      if (!match || !successorRoots.has(match[2])) continue;
      const operationId = `${match[1]}:35:${match[2]}:${successorProofHead}`;
      event.summary = `Intent ${match[1]} ${operationId}`;
      event.details.operationId = operationId;
      event.details.clientMutationId = priorIntent(match[1], operationId).clientMutationId;
    }

    const ordinaryCarrier = structuredClone(mixedArchive);
    ordinaryCarrier.state.tasks = ordinaryCarrier.state.tasks.filter((task) => (
      ![ordinaryTaskId, PACKET_PORTABILITY_TASK_ID].includes(task.id)
    ));
    ordinaryCarrier.state.threadResolutionStatus.threads = ordinaryCarrier.state
      .threadResolutionStatus.threads.filter((row) => !ordinaryRows.has(row.threadNodeId));
    ordinaryCarrier.events = ordinaryCarrier.events.filter((event) => (
      ![...ordinaryRows.keys()].some((threadId) => (
        String(event.details?.operationId ?? '').includes(`:${threadId}:`)
      ))
    ));
    ordinaryCarrier.state.tasks.push({
      ...structuredClone(ordinaryTask),
      id: predecessorTaskId,
      sourceIds: successorSourceIds,
      fingerprint: `${predecessorTaskId}-fingerprint`,
      status: 'integrated',
      integratedCommitSha: predecessorCommit,
      resolutionSummary: 'Integrated before the exact-partition successor replaced it.',
    });

    const freshTask = {
      ...structuredClone(fixture.aggregateTask),
      id: 'fresh-ten-root-aggregate-carrier-r9',
      fingerprint: 'fresh-ten-root-aggregate-carrier-r9-fingerprint',
      sourceIds: terminalState.threadResolutionStatus.threads
        .map((row) => `thread:${row.threadNodeId}`),
    };
    const active = structuredClone(fixture.active);
    active.tasks = [freshTask, {
      ...structuredClone(fixture.remediation), status: 'completed',
    }];
    active.currentIntegrationHeadSha = OTHER_HEAD;
    active.git = { ...active.git, headSha: OTHER_HEAD };
    active.validationStatus = { ...active.validationStatus, headSha: OTHER_HEAD };
    active.threadResolutionStatus = proof('not-run');
    active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: OTHER_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
    };
    fixture.client.metadata.headRefOid = OTHER_HEAD;
    const ancestryCalls = [];
    const freshGit = fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
      isAncestor: async (ancestorSha, descendantSha) => {
        ancestryCalls.push({ ancestorSha, descendantSha });
        return true;
      },
    });
    freshGit.ancestryCalls = ancestryCalls;
    fixture.client.events.length = 0;
    fixture.client.calls.length = 0;
    return {
      oldArchive,
      mixedArchive: ordinaryCarrier,
      terminalCarrier,
      fixture,
      freshTask,
      active,
      freshGit,
      predecessorTaskId,
      successorTaskId,
      predecessorCommit,
      successorCommit,
      successorProofHead,
    };
  };

  const successful = await buildTopology();
  const records = [successful.terminalCarrier, successful.mixedArchive, successful.oldArchive];
  const originalRecords = structuredClone(records);
  const store = immutableArchiveStore(records);
  const setup = workflow(successful.active, successful.fixture.client, {
    archiveStore: store, git: successful.freshGit,
    journal: fakeJournal(successful.fixture.client.events),
  });
  const result = await setup.api.replyResolve(35, successful.freshTask.id);
  const retainedRows = result.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(successful.freshTask.id),
  );
  assert.equal(store.calls, 2);
  assert.equal(retainedRows.length, 10);
  assert.equal(retainedRows.every((row) => Object.hasOwn(row, 'archiveProvenance')), true);
  assert.equal(setup.state.calls.length, 1);
  assert.equal(setup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(successful.freshGit.ancestryCalls.filter((call) => (
    call.ancestorSha === successful.predecessorCommit
      && call.descendantSha === successful.successorCommit
  )).length, 2);
  assert.equal(
    successful.fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(successful.fixture.client.events, []);
  assert.deepEqual(records, originalRecords);

  const buildPredecessorOnlyTopology = async () => {
    const topology = await buildTopology();
    topology.mixedArchive.state.tasks = topology.mixedArchive.state.tasks.filter(
      (task) => task.id !== topology.predecessorTaskId,
    );
    const successor = topology.terminalCarrier.state.tasks.find(
      (task) => task.id === topology.successorTaskId,
    );
    const predecessorTask = {
      ...structuredClone(successor),
      disposition: 'actionable',
      status: 'integrated',
      integratedCommitSha: topology.predecessorCommit,
      resolutionSummary: 'Integrated before the terminal proof origin superseded this task.',
      taskPacketDigest: '1'.repeat(64),
      workerResultDigest: '2'.repeat(64),
    };
    const predecessorState = structuredClone(topology.mixedArchive.state);
    predecessorState.tasks = [predecessorTask];
    predecessorState.threadResolutionStatus = proof('not-run');
    predecessorState.phase = 'triaging';
    predecessorState.abandonmentReason = 'Preserve terminal proofless predecessor authority.';
    predecessorState.updatedAt = '2026-08-01T09:00:00.000Z';
    const predecessorArchive = {
      archiveId: 'pr-35-2026-08-01T09-00-00-000Z',
      state: predecessorState,
      events: [{
        schemaVersion: 1,
        type: 'abandoned',
        summary: `Archived without completion: ${predecessorState.abandonmentReason}`,
        at: '2026-08-01T09:00:00.010Z',
      }],
    };
    return {
      ...topology,
      predecessorArchive,
      predecessorTask,
      records: [
        topology.terminalCarrier,
        topology.mixedArchive,
        topology.oldArchive,
        predecessorArchive,
      ],
    };
  };

  const predecessorOnly = await buildPredecessorOnlyTopology();
  const predecessorOnlyOriginal = structuredClone(predecessorOnly.records);
  const predecessorOnlyStore = immutableArchiveStore(predecessorOnly.records);
  const predecessorOnlySetup = workflow(
    predecessorOnly.active, predecessorOnly.fixture.client,
    {
      archiveStore: predecessorOnlyStore,
      git: predecessorOnly.freshGit,
      journal: fakeJournal(predecessorOnly.fixture.client.events),
    },
  );
  const predecessorOnlyResult = await predecessorOnlySetup.api.replyResolve(
    35, predecessorOnly.freshTask.id,
  );
  assert.equal(predecessorOnlyStore.calls, 2);
  assert.equal(predecessorOnlyResult.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(predecessorOnly.freshTask.id),
  ).length, 10);
  assert.equal(predecessorOnlySetup.state.calls.length, 1);
  assert.equal(predecessorOnlySetup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(predecessorOnly.freshGit.ancestryCalls.filter((call) => (
    call.ancestorSha === predecessorOnly.predecessorCommit
      && call.descendantSha === predecessorOnly.successorProofHead
  )).length, 2);
  assert.equal(predecessorOnly.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(predecessorOnly.fixture.client.events, []);
  assert.deepEqual(predecessorOnly.records, predecessorOnlyOriginal);

  const buildAuthorityNeutralCarrierChain = async (wrapperAliasMode = 'dual') => {
    const topology = await buildPredecessorOnlyTopology();
    const fourRootSuccessor = topology.terminalCarrier.state.tasks.find(
      (task) => task.id === topology.successorTaskId,
    );
    const splitRow = topology.terminalCarrier.state.threadResolutionStatus.threads.find(
      (row) => row.taskIds.includes(topology.successorTaskId),
    );
    const splitTaskId = `${topology.successorTaskId}-singleton`;
    const splitCommit = '1710000000000000000000000000000000000001';
    const splitSource = `thread:${splitRow.threadNodeId}`;
    fourRootSuccessor.sourceIds = fourRootSuccessor.sourceIds.filter(
      (source) => source !== splitSource,
    );
    topology.terminalCarrier.state.tasks.push({
      ...structuredClone(fourRootSuccessor),
      id: splitTaskId,
      sourceIds: [splitSource],
      fingerprint: `${splitTaskId}-fingerprint`,
      integratedCommitSha: splitCommit,
      resolutionSummary: 'The proof origin retains one exact singleton partition.',
    });
    splitRow.taskIds = [splitTaskId];
    const splitReply = topology.fixture.client.threadComments.get(splitRow.threadNodeId)[1];
    splitReply.body = splitReply.body.replace(
      `- ${topology.successorTaskId}: ${topology.successorCommit}`,
      `- ${splitTaskId}: ${splitCommit}`,
    );
    const rowsByHistoricalTask = new Map();
    for (const row of topology.terminalCarrier.state.threadResolutionStatus.threads) {
      const historicalTaskId = row.archiveProvenance?.historicalTaskId ?? row.taskIds[0];
      const roots = rowsByHistoricalTask.get(historicalTaskId) ?? [];
      roots.push(row.threadNodeId);
      rowsByHistoricalTask.set(historicalTaskId, roots);
    }
    const sourceStates = [
      topology.oldArchive.state,
      topology.mixedArchive.state,
      topology.terminalCarrier.state,
    ];
    const singletonPartitions = [...rowsByHistoricalTask]
      .filter(([, roots]) => roots.length === 1)
      .map(([taskId, roots]) => ({
        historicalTask: sourceStates.flatMap((state) => state.tasks)
          .find((task) => task.id === taskId),
        roots,
      }))
      .filter((partition) => partition.historicalTask !== undefined)
      .slice(0, 2);
    assert.equal(singletonPartitions.length, 2);

    const predecessorCommits = [
      '1426000000000000000000000000000000000001',
      '1426000000000000000000000000000000000002',
    ];
    const predecessorTasks = singletonPartitions.map((partition, index) => ({
      ...structuredClone(partition.historicalTask),
      disposition: 'actionable',
      status: 'integrated',
      integratedCommitSha: predecessorCommits[index],
      resolutionSummary: 'Integrated predecessor authority retained before the proof origin.',
    }));
    const predecessorRoots = new Set(singletonPartitions.flatMap((partition) => partition.roots));
    const wrapperRoots = topology.freshTask.sourceIds
      .map((source) => /^thread:(.+)$/u.exec(source)?.[1])
      .filter((root) => root !== undefined && !predecessorRoots.has(root));
    assert.equal(wrapperRoots.length, 8);
    const wrapperSourceIds = wrapperRoots.flatMap((root, index) => {
      const threadSource = `thread:${root}`;
      const rootComment = topology.fixture.client.threadComments.get(root)[0];
      const discussionSource = `discussion:${rootComment.databaseId}`;
      if (wrapperAliasMode === 'thread-only') return [threadSource];
      if (wrapperAliasMode === 'discussion-only') return [discussionSource];
      if (wrapperAliasMode === 'mixed') {
        return [index % 2 === 0 ? threadSource : discussionSource];
      }
      return [threadSource, discussionSource];
    });
    assert.equal(wrapperSourceIds.length, wrapperAliasMode === 'dual' ? 16 : 8);
    const wrapperTask = {
      ...structuredClone(topology.freshTask),
      id: 'retained-older-eight-proofless-wrapper-r21',
      fingerprint: 'retained-older-eight-proofless-wrapper-r21-fingerprint',
      sourceIds: wrapperSourceIds,
      disposition: 'already-fixed',
      status: 'proposed',
      integratedCommitSha: null,
      resolutionSummary: 'Authority-neutral complete wrapper for the older eight roots.',
      execution: {
        dependencies: [],
        ownedPaths: [],
        worker: null,
        branch: null,
        worktree: null,
        workerCommitSha: null,
        validationSummaries: [],
        lastError: null,
      },
    };
    const archiveAt = (archiveId, updatedAt, tasks) => {
      const state = structuredClone(topology.predecessorArchive.state);
      state.tasks = tasks;
      state.threadResolutionStatus = proof('not-run');
      state.phase = 'triaging';
      state.abandonmentReason = 'Retain exact authority-neutral proofless carrier inventory.';
      state.updatedAt = updatedAt;
      return {
        archiveId,
        state,
        events: [{
          schemaVersion: 1,
          type: 'abandoned',
          summary: `Archived without completion: ${state.abandonmentReason}`,
          at: new Date(Date.parse(updatedAt) + 10).toISOString(),
        }],
      };
    };
    const actionableCarrier = archiveAt(
      'pr-35-2026-08-01T14-26-00-000Z',
      '2026-08-01T14:26:00.000Z',
      [...predecessorTasks.map((task) => structuredClone(task)), structuredClone(wrapperTask)],
    );
    const neutralTaskAtStatus = (task, status) => {
      const neutral = {
        ...structuredClone(task),
        disposition: 'already-fixed',
        status,
        integratedCommitSha: null,
        resolutionSummary: 'Authority-neutral exact carry-forward shell.',
      };
      if (status === 'proposed') {
        neutral.execution = structuredClone(wrapperTask.execution);
      } else {
        delete neutral.execution;
      }
      return neutral;
    };
    const neutralTasks = (status) => [
      ...predecessorTasks.map((task) => neutralTaskAtStatus(task, status)),
      neutralTaskAtStatus(wrapperTask, status),
    ];
    const neutralCarriers = [
      archiveAt('pr-35-2026-08-01T15-14-00-000Z', '2026-08-01T15:14:00.000Z', neutralTasks('proposed')),
      archiveAt('pr-35-2026-08-01T15-18-00-000Z', '2026-08-01T15:18:00.000Z', neutralTasks('not-applicable')),
      archiveAt('pr-35-2026-08-01T16-07-00-000Z', '2026-08-01T16:07:00.000Z', neutralTasks('proposed')),
    ];
    return {
      ...topology,
      actionableCarrier,
      neutralCarriers,
      predecessorCommits,
      predecessorTasks,
      wrapperTask,
      records: [
        topology.terminalCarrier,
        topology.mixedArchive,
        topology.oldArchive,
        actionableCarrier,
        ...neutralCarriers,
      ],
    };
  };

  const authorityNeutral = await buildAuthorityNeutralCarrierChain();
  authorityNeutral.neutralCarriers[2].state.updatedAt = '2026-08-21T16:07:00.000Z';
  authorityNeutral.neutralCarriers[2].events.at(-1).at = '2026-08-21T16:07:00.010Z';
  const authorityNeutralOriginal = structuredClone(authorityNeutral.records);
  const authorityNeutralStore = immutableArchiveStore(authorityNeutral.records);
  const authorityNeutralJournal = fakeJournal(authorityNeutral.fixture.client.events);
  const authorityNeutralSetup = workflow(authorityNeutral.active, authorityNeutral.fixture.client, {
    archiveStore: authorityNeutralStore,
    git: authorityNeutral.freshGit,
    journal: authorityNeutralJournal,
  });
  const authorityNeutralResult = await authorityNeutralSetup.api.replyResolve(
    35, authorityNeutral.freshTask.id,
  );
  assert.equal(authorityNeutralStore.calls, 2);
  assert.equal(authorityNeutralResult.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(authorityNeutral.freshTask.id),
  ).length, 10);
  assert.equal(authorityNeutralSetup.state.calls.length, 1);
  assert.equal(authorityNeutralSetup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(authorityNeutralJournal.intents.size, 0);
  assert.equal(authorityNeutral.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(authorityNeutral.fixture.client.events, []);
  assert.deepEqual(authorityNeutral.records, authorityNeutralOriginal);
  for (const predecessorCommit of authorityNeutral.predecessorCommits) {
    assert.equal(authorityNeutral.freshGit.ancestryCalls.filter(
      (call) => call.ancestorSha === predecessorCommit,
    ).length, 2);
  }

  for (const wrapperAliasMode of ['thread-only', 'discussion-only', 'mixed']) {
    const compatible = await buildAuthorityNeutralCarrierChain(wrapperAliasMode);
    const compatibleOriginal = structuredClone(compatible.records);
    const compatibleStore = immutableArchiveStore(compatible.records);
    const compatibleJournal = fakeJournal(compatible.fixture.client.events);
    const compatibleSetup = workflow(compatible.active, compatible.fixture.client, {
      archiveStore: compatibleStore,
      git: compatible.freshGit,
      journal: compatibleJournal,
    });
    const compatibleResult = await compatibleSetup.api.replyResolve(
      35, compatible.freshTask.id,
    );
    assert.equal(compatibleStore.calls, 2, wrapperAliasMode);
    assert.equal(compatibleResult.threadResolutionStatus.threads.filter(
      (row) => row.taskIds.includes(compatible.freshTask.id),
    ).length, 10, wrapperAliasMode);
    assert.equal(compatibleSetup.state.calls.length, 1, wrapperAliasMode);
    assert.equal(
      compatibleSetup.state.calls[0].name,
      'checkpointArchiveTaskCompletion',
      wrapperAliasMode,
    );
    assert.equal(compatibleJournal.intents.size, 0, wrapperAliasMode);
    assert.equal(compatible.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, wrapperAliasMode);
    assert.deepEqual(compatible.fixture.client.events, [], wrapperAliasMode);
    assert.deepEqual(compatible.records, compatibleOriginal, wrapperAliasMode);
  }

  const authorityNeutralCases = [
    ['changed shell stable identity', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks[0].fingerprint += '-changed';
    }],
    ['actionable shell', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks[0].disposition = 'actionable';
    }],
    ['completed shell', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks[0].status = 'completed';
    }],
    ['non-null shell commit', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks[0].integratedCommitSha = ADVANCED_HEAD;
    }],
    ['non-null wrapper commit', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks.at(-1).integratedCommitSha = ADVANCED_HEAD;
    }],
    ['single-partition wrapper', ({ neutralCarriers, predecessorTasks }) => {
      neutralCarriers[0].state.tasks.at(-1).sourceIds = structuredClone(
        predecessorTasks[0].sourceIds,
      );
      neutralCarriers[0].state.tasks.splice(0, 1);
    }],
    ['unknown wrapper alias', ({ neutralCarriers }) => {
      neutralCarriers[0].state.tasks.at(-1).sourceIds.push('discussion:999999999');
    }],
    ['partial wrapper partition', ({ neutralCarriers, fixture }) => {
      const wrapper = neutralCarriers[0].state.tasks.at(-1);
      const missingRoot = /^thread:(.+)$/u.exec(wrapper.sourceIds[0])[1];
      const missingDiscussion =
        `discussion:${fixture.client.threadComments.get(missingRoot)[0].databaseId}`;
      wrapper.sourceIds = wrapper.sourceIds.filter(
        (source) => source !== `thread:${missingRoot}` && source !== missingDiscussion,
      );
    }],
    ['overlapping wrapper partition', ({ neutralCarriers, predecessorTasks }) => {
      neutralCarriers[0].state.tasks.at(-1).sourceIds.push(predecessorTasks[0].sourceIds[0]);
    }],
    ['shell without predecessor authority', ({ actionableCarrier }) => {
      actionableCarrier.state.tasks = actionableCarrier.state.tasks.filter(
        (task) => task.disposition !== 'actionable',
      );
    }],
  ];
  for (const [label, tamper] of authorityNeutralCases) {
    const topology = await buildAuthorityNeutralCarrierChain();
    tamper(topology);
    const journal = fakeJournal(topology.fixture.client.events);
    const failed = workflow(topology.active, topology.fixture.client, {
      archiveStore: immutableArchiveStore(topology.records),
      git: topology.freshGit,
      journal,
    });
    await assert.rejects(
      () => failed.api.replyResolve(35, topology.freshTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(failed.state.calls.length, 0, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(topology.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(topology.fixture.client.events, [], label);
  }

  const neutralRace = await buildAuthorityNeutralCarrierChain();
  const neutralRaceJournal = fakeJournal(neutralRace.fixture.client.events);
  const neutralRaceStore = immutableArchiveStore(neutralRace.records, (calls) => {
    if (calls === 2) neutralRace.neutralCarriers[1].state.tasks.at(-1).summary += ' raced';
  });
  const neutralRaceFailure = workflow(neutralRace.active, neutralRace.fixture.client, {
    archiveStore: neutralRaceStore, git: neutralRace.freshGit, journal: neutralRaceJournal,
  });
  await assert.rejects(
    () => neutralRaceFailure.api.replyResolve(35, neutralRace.freshTask.id),
    GitHubWorkflowError,
    'authority-neutral carrier content race',
  );
  assert.equal(neutralRaceFailure.state.calls.length, 0);
  assert.equal(neutralRaceJournal.intents.size, 0);

  const equalPredecessorSuccessor = await buildPredecessorOnlyTopology();
  equalPredecessorSuccessor.predecessorTask.integratedCommitSha =
    equalPredecessorSuccessor.successorCommit;
  const equalCommitOriginal = structuredClone(equalPredecessorSuccessor.records);
  const equalCommitJournal = fakeJournal(equalPredecessorSuccessor.fixture.client.events);
  const equalCommitFailure = workflow(
    equalPredecessorSuccessor.active, equalPredecessorSuccessor.fixture.client,
    {
      archiveStore: immutableArchiveStore(equalPredecessorSuccessor.records),
      git: equalPredecessorSuccessor.freshGit,
      journal: equalCommitJournal,
    },
  );
  await assert.rejects(
    () => equalCommitFailure.api.replyResolve(35, equalPredecessorSuccessor.freshTask.id),
    { code: 'ARCHIVE_EVIDENCE_AMBIGUOUS' },
    'a predecessor commit equal to the anchored successor commit is ambiguous',
  );
  assert.equal(equalCommitFailure.state.calls.length, 0);
  assert.equal(equalCommitJournal.intents.size, 0);
  assert.equal(equalPredecessorSuccessor.freshGit.ancestryCalls.some((call) => (
    call.ancestorSha === equalPredecessorSuccessor.successorCommit
      && call.descendantSha === equalPredecessorSuccessor.successorProofHead
  )), false);
  assert.equal(equalPredecessorSuccessor.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(equalPredecessorSuccessor.fixture.client.events, []);
  assert.deepEqual(equalPredecessorSuccessor.records, equalCommitOriginal);

  const crossLaneDuplicate = await buildPredecessorOnlyTopology();
  crossLaneDuplicate.mixedArchive.state.tasks.push(
    structuredClone(crossLaneDuplicate.predecessorTask),
  );
  const crossLaneRecords = crossLaneDuplicate.records;
  const crossLaneOriginal = structuredClone(crossLaneRecords);
  const crossLaneJournal = fakeJournal(crossLaneDuplicate.fixture.client.events);
  const crossLaneFailure = workflow(
    crossLaneDuplicate.active, crossLaneDuplicate.fixture.client,
    {
      archiveStore: immutableArchiveStore(crossLaneRecords),
      git: crossLaneDuplicate.freshGit,
      journal: crossLaneJournal,
    },
  );
  await assert.rejects(
    () => crossLaneFailure.api.replyResolve(35, crossLaneDuplicate.freshTask.id),
    { code: 'ARCHIVE_EVIDENCE_AMBIGUOUS' },
    'mixed and predecessor-only carriers cannot claim the same predecessor partition',
  );
  assert.equal(crossLaneFailure.state.calls.length, 0);
  assert.equal(crossLaneJournal.intents.size, 0);
  assert.equal(crossLaneDuplicate.freshGit.ancestryCalls.some((call) => (
    call.ancestorSha === crossLaneDuplicate.predecessorCommit
      && call.descendantSha === crossLaneDuplicate.successorCommit
  )), false);
  assert.equal(crossLaneDuplicate.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(crossLaneDuplicate.fixture.client.events, []);
  assert.deepEqual(crossLaneRecords, crossLaneOriginal);

  const predecessorRoleOverflow = await buildPredecessorOnlyTopology();
  const overflowRecords = predecessorRoleOverflow.records.slice();
  const uniqueArchive = (archive, offset) => ({
    ...archive,
    archiveId: `pr-35-${new Date(Date.parse('2026-08-21T00:00:00.000Z') + offset)
      .toISOString().replaceAll(':', '-').replace('.', '-')}`,
  });
  for (let index = 0; index < 905; index += 1) {
    overflowRecords.push(uniqueArchive(predecessorRoleOverflow.terminalCarrier, index));
  }
  const overflowOriginal = structuredClone(predecessorRoleOverflow.records);
  const overflowArchiveIds = overflowRecords.map((archive) => archive.archiveId);
  const predecessorSources = predecessorRoleOverflow.predecessorTask.sourceIds;
  let predecessorSourceReads = 0;
  Object.defineProperty(predecessorRoleOverflow.predecessorTask, 'sourceIds', {
    configurable: true,
    enumerable: true,
    get() {
      predecessorSourceReads += 1;
      return predecessorSources;
    },
  });
  assert.equal(predecessorSources.length, 4);
  const overflowJournal = fakeJournal(predecessorRoleOverflow.fixture.client.events);
  const overflowFailure = workflow(
    predecessorRoleOverflow.active, predecessorRoleOverflow.fixture.client,
    {
      archiveStore: immutableArchiveStore(overflowRecords, null, { clone: false }),
      git: predecessorRoleOverflow.freshGit,
      journal: overflowJournal,
    },
  );
  await assert.rejects(
    () => overflowFailure.api.replyResolve(35, predecessorRoleOverflow.freshTask.id),
    {
      code: 'ARCHIVE_EVIDENCE_INVALID',
      message: 'Aggregate partitions, carriers, roles, and intent footprints exceed the cumulative node bound',
    },
    'the fourth root role exceeds the inclusive cumulative predecessor carrier bound',
  );
  assert.equal(overflowFailure.state.calls.length, 0);
  assert.equal(overflowJournal.intents.size, 0);
  assert.equal(predecessorSourceReads > 0, true);
  assert.equal(predecessorRoleOverflow.freshGit.ancestryCalls.some((call) => (
    call.ancestorSha === predecessorRoleOverflow.predecessorCommit
      && call.descendantSha === predecessorRoleOverflow.successorCommit
  )), false);
  assert.equal(predecessorRoleOverflow.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(predecessorRoleOverflow.fixture.client.events, []);
  assert.deepEqual(predecessorRoleOverflow.records, overflowOriginal);
  assert.deepEqual(overflowRecords.map((archive) => archive.archiveId), overflowArchiveIds);

  const predecessorOnlyCases = [
    ['partial partition', ({ predecessorTask }) => predecessorTask.sourceIds.pop()],
    ['divergent fingerprint', ({ predecessorTask }) => {
      predecessorTask.fingerprint = 'divergent-predecessor-fingerprint';
    }],
    ['selected proof row', ({ predecessorArchive, terminalCarrier, successorTaskId }) => {
      predecessorArchive.state.threadResolutionStatus.threads.push(structuredClone(
        terminalCarrier.state.threadResolutionStatus.threads.find(
          (row) => row.taskIds.includes(successorTaskId),
        ),
      ));
    }],
    ['late terminal chronology', ({ predecessorArchive }) => {
      predecessorArchive.state.updatedAt = '2026-08-20T12:30:00.000Z';
      predecessorArchive.events.at(-1).at = '2026-08-20T12:30:00.010Z';
    }],
  ];
  for (const [label, tamper] of predecessorOnlyCases) {
    const topology = await buildPredecessorOnlyTopology();
    tamper(topology);
    topology.fixture.client.calls.length = 0;
    topology.fixture.client.events.length = 0;
    const journal = fakeJournal(topology.fixture.client.events);
    const failed = workflow(topology.active, topology.fixture.client, {
      archiveStore: immutableArchiveStore(topology.records),
      git: topology.freshGit,
      journal,
    });
    await assert.rejects(
      () => failed.api.replyResolve(35, topology.freshTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(failed.state.calls.length, 0, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(topology.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(topology.fixture.client.events, [], label);
  }

  const predecessorOnlyNonAncestral = await buildPredecessorOnlyTopology();
  predecessorOnlyNonAncestral.freshGit.isAncestor = async (ancestorSha, descendantSha) => {
    predecessorOnlyNonAncestral.freshGit.ancestryCalls.push({ ancestorSha, descendantSha });
    return ancestorSha !== predecessorOnlyNonAncestral.predecessorCommit
      || descendantSha !== predecessorOnlyNonAncestral.successorProofHead;
  };
  const predecessorOnlyAncestryJournal = fakeJournal(
    predecessorOnlyNonAncestral.fixture.client.events,
  );
  const predecessorOnlyAncestryFailure = workflow(
    predecessorOnlyNonAncestral.active, predecessorOnlyNonAncestral.fixture.client,
    {
      archiveStore: immutableArchiveStore(predecessorOnlyNonAncestral.records),
      git: predecessorOnlyNonAncestral.freshGit,
      journal: predecessorOnlyAncestryJournal,
    },
  );
  await assert.rejects(
    () => predecessorOnlyAncestryFailure.api.replyResolve(
      35, predecessorOnlyNonAncestral.freshTask.id,
    ),
    { code: 'MUTATION_NOT_READY' },
    'terminal proofless predecessor ancestry',
  );
  assert.equal(predecessorOnlyAncestryFailure.state.calls.length, 0);
  assert.equal(predecessorOnlyAncestryJournal.intents.size, 0);

  for (const [label, race] of [[
    'predecessor content race',
    (records) => { records.at(-1).state.nextAction += ' raced'; },
  ]]) {
    const topology = await buildPredecessorOnlyTopology();
    const journal = fakeJournal(topology.fixture.client.events);
    const store = immutableArchiveStore(topology.records, (calls) => {
      if (calls === 2) race(topology.records);
    });
    const failed = workflow(topology.active, topology.fixture.client, {
      archiveStore: store, git: topology.freshGit, journal,
    });
    await assert.rejects(
      () => failed.api.replyResolve(35, topology.freshTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(failed.state.calls.length, 0, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(topology.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
  }

  const cases = [
    ['partial predecessor partition', ({ mixedArchive, predecessorTaskId }) => {
      mixedArchive.state.tasks.find((task) => task.id === predecessorTaskId).sourceIds.pop();
    }],
    ['multi-partition predecessor', ({ mixedArchive, terminalCarrier, predecessorTaskId }) => {
      const replayRoot = terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).threadNodeId;
      mixedArchive.state.tasks.find(
        (task) => task.id === predecessorTaskId,
      ).sourceIds.push(`thread:${replayRoot}`);
    }],
    ['ambiguous predecessor', ({ mixedArchive, predecessorTaskId }) => {
      const predecessor = mixedArchive.state.tasks.find(
        (task) => task.id === predecessorTaskId,
      );
      mixedArchive.state.tasks.push({
        ...structuredClone(predecessor),
        id: 'close-round-two-scope-evidence-invariants-r2-ambiguous',
        fingerprint: 'close-round-two-scope-evidence-invariants-r2-ambiguous-fingerprint',
        integratedCommitSha: ADVANCED_HEAD,
      });
    }],
    ['proof-bearing predecessor', ({ mixedArchive, terminalCarrier, predecessorTaskId }) => {
      const row = structuredClone(terminalCarrier.state.threadResolutionStatus.threads.find(
        (candidate) => !Object.hasOwn(candidate, 'archiveProvenance'),
      ));
      row.taskIds = [predecessorTaskId];
      mixedArchive.state.threadResolutionStatus.threads.push(row);
    }],
    ['provenance-bearing predecessor', ({
      mixedArchive, terminalCarrier, predecessorTaskId,
    }) => {
      const row = structuredClone(terminalCarrier.state.threadResolutionStatus.threads.find(
        (candidate) => !Object.hasOwn(candidate, 'archiveProvenance'),
      ));
      row.taskIds = [predecessorTaskId];
      row.archiveProvenance = structuredClone(terminalCarrier.state.threadResolutionStatus.threads.find(
        (candidate) => Object.hasOwn(candidate, 'archiveProvenance'),
      ).archiveProvenance);
      row.archiveProvenance.historicalTaskId = predecessorTaskId;
      mixedArchive.state.threadResolutionStatus.threads.push(row);
    }],
    ['reply-intent-bearing predecessor', ({
      mixedArchive, predecessorTaskId, predecessorCommit,
    }) => {
      const root = /^thread:(.+)$/u.exec(mixedArchive.state.tasks.find(
        (task) => task.id === predecessorTaskId,
      ).sourceIds[0])[1];
      mixedArchive.events.splice(-1, 0, archiveIntentEvent(
        'reply', `reply:35:${root}:${predecessorCommit}`, '2026-08-20T09:30:00.000Z',
      ));
    }],
    ['resolve-intent-bearing predecessor', ({
      mixedArchive, predecessorTaskId, predecessorCommit,
    }) => {
      const root = /^thread:(.+)$/u.exec(mixedArchive.state.tasks.find(
        (task) => task.id === predecessorTaskId,
      ).sourceIds[0])[1];
      mixedArchive.events.splice(-1, 0, archiveIntentEvent(
        'resolve', `resolve:35:${root}:${predecessorCommit}`, '2026-08-20T09:30:00.000Z',
      ));
    }],
    ['terminal predecessor', ({ mixedArchive, predecessorTaskId }) => {
      mixedArchive.state.tasks.find((task) => task.id === predecessorTaskId).status = 'completed';
    }],
    ['null-commit predecessor', ({ mixedArchive, predecessorTaskId }) => {
      mixedArchive.state.tasks.find((task) => task.id === predecessorTaskId).integratedCommitSha = null;
    }],
    ['equal-commit predecessor and successor', ({
      mixedArchive, predecessorTaskId, successorCommit,
    }) => {
      mixedArchive.state.tasks.find(
        (task) => task.id === predecessorTaskId,
      ).integratedCommitSha = successorCommit;
    }],
    ['predecessor placed in mixed carrier', ({
      mixedArchive, terminalCarrier, predecessorTaskId,
    }) => {
      const index = mixedArchive.state.tasks.findIndex((task) => task.id === predecessorTaskId);
      terminalCarrier.state.tasks.push(mixedArchive.state.tasks.splice(index, 1)[0]);
    }],
    ['partition slicing', ({ terminalCarrier }) => {
      terminalCarrier.state.tasks.find(
        (task) => task.id === PACKET_AGGREGATE_TASK_ID,
      ).sourceIds.pop();
    }],
    ['unknown historical authority', ({ terminalCarrier }) => {
      terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.historicalTaskId = 'unknown-historical-authority';
    }],
    ['changed proof core', ({ terminalCarrier }) => {
      terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).rootCommentDatabaseId += 1;
    }],
    ['changed reply digest', ({ terminalCarrier }) => {
      terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.replyBodySha256 = '0'.repeat(64);
    }],
    ['changed authority fingerprint', ({ terminalCarrier }) => {
      terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.authorityFingerprint = '0'.repeat(64);
    }],
    ['partial provenance', ({ terminalCarrier }) => {
      delete terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance;
    }],
    ['overlapping partition owner', ({ terminalCarrier, successorTaskId }) => {
      const replayRoot = terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).threadNodeId;
      terminalCarrier.state.tasks.find(
        (task) => task.id === successorTaskId,
      ).sourceIds.push(`thread:${replayRoot}`);
    }],
  ];
  for (const [label, tamper] of cases) {
    const topology = await buildTopology();
    tamper(topology);
    const journal = fakeJournal(topology.fixture.client.events);
    const failed = workflow(topology.active, topology.fixture.client, {
      archiveStore: immutableArchiveStore([
        topology.terminalCarrier, topology.mixedArchive, topology.oldArchive,
      ]),
      git: topology.freshGit, journal,
    });
    await assert.rejects(
      () => failed.api.replyResolve(35, topology.freshTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(failed.state.calls.length, 0, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(topology.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(topology.fixture.client.events, [], label);
  }

  const nonAncestral = await buildTopology();
  nonAncestral.freshGit.isAncestor = async (ancestorSha, descendantSha) => {
    nonAncestral.freshGit.ancestryCalls.push({ ancestorSha, descendantSha });
    return ancestorSha !== nonAncestral.predecessorCommit
      || descendantSha !== nonAncestral.successorCommit;
  };
  const nonAncestralJournal = fakeJournal(nonAncestral.fixture.client.events);
  const nonAncestralSetup = workflow(nonAncestral.active, nonAncestral.fixture.client, {
    archiveStore: immutableArchiveStore([
      nonAncestral.terminalCarrier, nonAncestral.mixedArchive, nonAncestral.oldArchive,
    ]),
    git: nonAncestral.freshGit,
    journal: nonAncestralJournal,
  });
  await assert.rejects(
    () => nonAncestralSetup.api.replyResolve(35, nonAncestral.freshTask.id),
    { code: 'MUTATION_NOT_READY' },
    'non-ancestral predecessor',
  );
  assert.equal(nonAncestralSetup.state.calls.length, 0);
  assert.equal(nonAncestralJournal.intents.size, 0);
  assert.equal(nonAncestral.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(nonAncestral.fixture.client.events, []);

  const missingOrigin = await buildTopology();
  const noOlderOrigin = workflow(missingOrigin.active, missingOrigin.fixture.client, {
    archiveStore: immutableArchiveStore([missingOrigin.terminalCarrier, missingOrigin.oldArchive]),
    git: missingOrigin.freshGit, journal: fakeJournal(missingOrigin.fixture.client.events),
  });
  await assert.rejects(
    () => noOlderOrigin.api.replyResolve(35, missingOrigin.freshTask.id),
    GitHubWorkflowError,
    'provenance without its older origin',
  );
  assert.equal(noOlderOrigin.state.calls.length, 0);

  for (const [label, race] of [
    ['mixed carrier inventory race', ({ records }) => {
      records[0].state.nextAction += ' raced';
    }],
    ['mixed carrier live-evidence race', ({ topology }) => {
      const replay = topology.terminalCarrier.state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      );
      topology.fixture.client.threadComments.get(replay.threadNodeId)[1].body += '\nraced';
    }],
  ]) {
    const topology = await buildTopology();
    const raceRecords = [topology.terminalCarrier, topology.mixedArchive, topology.oldArchive];
    let raced;
    const raceStore = immutableArchiveStore(raceRecords, (calls) => {
      if (calls === 2) race({ records: raceRecords, topology });
    });
    raced = workflow(topology.active, topology.fixture.client, {
      archiveStore: raceStore, git: topology.freshGit,
      journal: fakeJournal(topology.fixture.client.events),
    });
    await assert.rejects(
      () => raced.api.replyResolve(35, topology.freshTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(raced.state.calls.length, 0, label);
    assert.equal(topology.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(topology.fixture.client.events, [], label);
  }

  const fourteen = await buildTopology();
  const partialMixedCarrier = fourteen.terminalCarrier;
  const fullMixedCarrier = structuredClone(partialMixedCarrier);
  const proofHead = 'f08c9d0123456789abcdef0123456789abcdef01';
  const newRoots = Array.from({ length: 4 }, (_, index) => `PRRT_partial_mixed_${index + 1}`);
  const predecessorIds = [
    'round-seven-proofless-predecessor-a',
    'round-seven-proofless-predecessor-b',
    'round-seven-proofless-predecessor-c',
  ];
  const predecessorCommits = [
    '7100000000000000000000000000000000000001',
    '7100000000000000000000000000000000000002',
    '7100000000000000000000000000000000000003',
  ];
  const predecessorRootSets = [[newRoots[0]], [newRoots[1]], newRoots.slice(2)];
  const taskTemplate = structuredClone(partialMixedCarrier.state.tasks.find(
    (task) => task.id === fourteen.successorTaskId,
  ));
  for (let index = 0; index < predecessorIds.length; index += 1) {
    partialMixedCarrier.state.tasks.push({
      ...structuredClone(taskTemplate),
      id: predecessorIds[index],
      sourceIds: predecessorRootSets[index].map((root) => `thread:${root}`),
      fingerprint: `${predecessorIds[index]}-fingerprint`,
      status: 'integrated',
      integratedCommitSha: predecessorCommits[index],
      resolutionSummary: 'Integrated before the later whole-partition terminal carrier.',
    });
  }

  const successorId = 'round-eight-four-root-already-fixed-successor';
  fullMixedCarrier.archiveId = 'pr-35-2026-08-20T12-20-00-000Z';
  fullMixedCarrier.state.updatedAt = '2026-08-20T12:20:00.000Z';
  fullMixedCarrier.state.currentIntegrationHeadSha = proofHead;
  fullMixedCarrier.state.git = { ...fullMixedCarrier.state.git, headSha: proofHead };
  fullMixedCarrier.state.validationStatus = {
    ...fullMixedCarrier.state.validationStatus, headSha: proofHead,
  };
  fullMixedCarrier.state.tasks.push({
    ...structuredClone(taskTemplate),
    id: successorId,
    sourceIds: newRoots.map((root) => `thread:${root}`),
    fingerprint: `${successorId}-fingerprint`,
    disposition: 'already-fixed',
    status: 'completed',
    integratedCommitSha: null,
    resolutionSummary: 'The later completed task owns the exact four-root partition.',
  });
  const proofTemplate = structuredClone(fullMixedCarrier.state.threadResolutionStatus.threads.find(
    (row) => !Object.hasOwn(row, 'archiveProvenance'),
  ));
  const viewer = fourteen.fixture.client.metadata.viewer;
  const addedEvents = [];
  for (let index = 0; index < newRoots.length; index += 1) {
    const threadId = newRoots[index];
    const rootId = `PRRC_partial_mixed_root_${index + 1}`;
    const replyId = `PRRC_partial_mixed_reply_${index + 1}`;
    const databaseId = 990001 + (index * 10);
    const replyOperation = `reply:35:${threadId}:${proofHead}`;
    const resolveOperation = `resolve:35:${threadId}:${proofHead}`;
    const replyAt = `2026-08-20T12:1${index}:00.000Z`;
    const replyIntentAt = `2026-08-20T12:1${index}:00.100Z`;
    const resolveIntentAt = `2026-08-20T12:1${index}:00.500Z`;
    const resolvedAt = `2026-08-20T12:1${index}:00.600Z`;
    fullMixedCarrier.state.threadResolutionStatus.threads.push({
      ...structuredClone(proofTemplate),
      threadNodeId: threadId,
      rootCommentNodeId: rootId,
      rootCommentDatabaseId: databaseId,
      taskIds: [successorId],
      disposition: 'already-fixed',
      replyId,
      replyUrl: `https://github.com/furinvader/aerstello/pull/35#discussion_r${databaseId + 1}`,
      resolvedAt,
      observedHeadSha: proofHead,
    });
    const body = [
      `Aerstello review resolution at ${proofHead}.`,
      'Tasks:',
      `- ${successorId}: already-fixed — The later completed task owns the exact four-root partition.`,
      `Validation: ${fullMixedCarrier.state.validationStatus.checks.slice(0, 3).join(', ')}.`,
      markerFor(replyOperation),
    ].join('\n');
    addThread(fourteen.fixture.client, {
      id: threadId,
      resolved: true,
      root: rootComment(threadId, {
        id: rootId,
        databaseId,
        url: `https://github.com/furinvader/aerstello/pull/35#discussion_r${databaseId}`,
        createdAt: '2026-08-20T12:09:00.000Z',
      }),
      replies: [{
        id: replyId,
        databaseId: databaseId + 1,
        url: `https://github.com/furinvader/aerstello/pull/35#discussion_r${databaseId + 1}`,
        body,
        createdAt: replyAt,
        lastEditedAt: null,
        author: viewer,
        replyTo: { id: rootId },
        pullRequestReview: null,
      }],
    });
    addedEvents.push(
      archiveIntentEvent('reply', replyOperation, replyIntentAt),
      archiveIntentEvent('resolve', resolveOperation, resolveIntentAt),
    );
  }
  fullMixedCarrier.events.splice(-1, 0, ...addedEvents);
  fullMixedCarrier.events.at(-1).at = '2026-08-20T12:20:00.010Z';
  const freshFourteenTask = {
    ...structuredClone(fourteen.freshTask),
    id: 'fresh-fourteen-root-partial-mixed-carrier-r14',
    fingerprint: 'fresh-fourteen-root-partial-mixed-carrier-r14-fingerprint',
    sourceIds: fullMixedCarrier.state.threadResolutionStatus.threads.map(
      (row) => `thread:${row.threadNodeId}`,
    ),
  };
  fourteen.active.tasks[0] = freshFourteenTask;
  const fourteenRecords = [
    fullMixedCarrier, partialMixedCarrier, fourteen.mixedArchive, fourteen.oldArchive,
  ];
  const fourteenOriginal = structuredClone(fourteenRecords);
  const fourteenStore = immutableArchiveStore(fourteenRecords);
  const fourteenSetup = workflow(fourteen.active, fourteen.fixture.client, {
    archiveStore: fourteenStore,
    git: fourteen.freshGit,
    journal: fakeJournal(fourteen.fixture.client.events),
  });
  const fourteenResult = await fourteenSetup.api.replyResolve(35, freshFourteenTask.id);
  assert.equal(fourteenStore.calls, 2);
  assert.equal(fourteenResult.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(freshFourteenTask.id),
  ).length, 14);
  for (const predecessorCommit of predecessorCommits) {
    assert.equal(fourteen.freshGit.ancestryCalls.filter((call) => (
      call.ancestorSha === predecessorCommit && call.descendantSha === proofHead
    )).length, 2);
  }
  assert.equal(fourteenSetup.state.calls.length, 1);
  assert.equal(fourteenSetup.state.calls[0].name, 'checkpointArchiveTaskCompletion');
  assert.equal(fourteen.fixture.client.calls.some(
    (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
  ), false);
  assert.deepEqual(fourteen.fixture.client.events, []);
  assert.deepEqual(fourteenRecords, fourteenOriginal);

  const fourteenCases = [
    ['missing full fourteen-root carrier', (records) => records.shift()],
    ['sliced carried partition', (records) => {
      const partial = records[1];
      const taskId = partial.state.threadResolutionStatus.threads.find(
        (row) => !Object.hasOwn(row, 'archiveProvenance'),
      ).taskIds[0];
      const index = partial.state.threadResolutionStatus.threads.findIndex(
        (row) => row.taskIds[0] === taskId,
      );
      partial.state.threadResolutionStatus.threads.splice(index, 1);
    }],
    ['incomplete predecessor cover', (records) => {
      records[1].state.tasks.find((task) => task.id === predecessorIds[2]).sourceIds.pop();
    }],
    ['ambiguous predecessor cover', (records) => {
      const predecessor = records[1].state.tasks.find((task) => task.id === predecessorIds[0]);
      records[1].state.tasks.push({
        ...structuredClone(predecessor),
        id: `${predecessor.id}-alternate`,
        fingerprint: `${predecessor.id}-alternate-fingerprint`,
        integratedCommitSha: '7100000000000000000000000000000000000004',
      });
    }],
    ['predecessor intent', (records) => {
      const operationId = `reply:35:${newRoots[0]}:${predecessorCommits[0]}`;
      records[1].events.splice(-1, 0, archiveIntentEvent(
        'reply', operationId, '2026-08-20T12:09:30.000Z',
      ));
    }],
    ['proof and provenance divergence', (records) => {
      records[0].state.threadResolutionStatus.threads.find(
        (row) => Object.hasOwn(row, 'archiveProvenance'),
      ).archiveProvenance.historicalTaskId = 'divergent-history';
    }],
    ['missing six-root origins', (records) => records.splice(2, 2)],
  ];
  for (const [label, tamper] of fourteenCases) {
    const records = structuredClone(fourteenRecords);
    tamper(records);
    fourteen.fixture.client.calls.length = 0;
    fourteen.fixture.client.events.length = 0;
    const journal = fakeJournal(fourteen.fixture.client.events);
    const failed = workflow(fourteen.active, fourteen.fixture.client, {
      archiveStore: immutableArchiveStore(records), git: fourteen.freshGit, journal,
    });
    await assert.rejects(
      () => failed.api.replyResolve(35, freshFourteenTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(failed.state.calls.length, 0, label);
    assert.equal(journal.intents.size, 0, label);
    assert.equal(fourteen.fixture.client.calls.some(
      (call) => ['AddThreadReply', 'ResolveThread'].includes(call.name),
    ), false, label);
    assert.deepEqual(fourteen.fixture.client.events, [], label);
  }

  const ancestryRecords = structuredClone(fourteenRecords);
  const ancestryGit = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
    isAncestor: async (ancestorSha, descendantSha) => !(
      ancestorSha === predecessorCommits[1] && descendantSha === proofHead
    ),
  });
  const ancestryJournal = fakeJournal(fourteen.fixture.client.events);
  const ancestryFailure = workflow(fourteen.active, fourteen.fixture.client, {
    archiveStore: immutableArchiveStore(ancestryRecords), git: ancestryGit,
    journal: ancestryJournal,
  });
  await assert.rejects(
    () => ancestryFailure.api.replyResolve(35, freshFourteenTask.id),
    { code: 'MUTATION_NOT_READY' },
    'proofless predecessor ancestry to the already-fixed partition proof HEAD',
  );
  assert.equal(ancestryFailure.state.calls.length, 0);
  assert.equal(ancestryJournal.intents.size, 0);
});

test('later ordinary gates reject aggregate reply, actor, digest, edit, and historical-task tampering without archive reads', async () => {
  const cases = [
    ['live reply body', ({ client }) => {
      client.threadComments.get('PRRT_kwDOTqOdrM6auUvO')[1].body += '\ntampered';
    }],
    ['reply actor identity', ({ client }) => {
      const reply = client.threadComments.get('PRRT_kwDOTqOdrM6auUvO')[1];
      reply.author = { ...reply.author, id: 'USER_2' };
    }],
    ['reply body digest', ({ state }) => {
      state.threadResolutionStatus.threads.find(
        (row) => row.threadNodeId === 'PRRT_kwDOTqOdrM6auUvO',
      ).archiveProvenance.replyBodySha256 = '0'.repeat(64);
    }],
    ['reply edit timestamp', ({ client }) => {
      client.threadComments.get('PRRT_kwDOTqOdrM6auUvO')[1].lastEditedAt = '2026-08-20T12:20:00.000Z';
    }],
    ['historical task identity', ({ state }) => {
      state.threadResolutionStatus.threads.find(
        (row) => row.threadNodeId === 'PRRT_kwDOTqOdrM6auUvO',
      ).archiveProvenance.historicalTaskId = 'tampered-historical-task';
    }],
  ];
  for (const [label, tamper] of cases) {
    const oldArchive = decodedPacketArchive(
      PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
    );
    const mixedArchive = decodedPacketArchive(
      PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
    );
    const fixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
    fixture.active.tasks.find((task) => task.id === fixture.remediation.id).status = 'completed';
    fixture.active.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      taskIds: [fixture.remediation.id], updatedAt: '2026-08-20T12:00:00.000Z',
    };
    const packetGit = fakeGit({
      snapshot: async () => ({ headSha: PACKET_AGGREGATE_HEAD, dirty: false }),
      pushedHead: async () => PACKET_AGGREGATE_HEAD,
    });
    const adopted = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([oldArchive, mixedArchive]),
      git: packetGit,
      journal: fakeJournal(fixture.client.events),
    });
    await adopted.api.replyResolve(35, fixture.aggregateTask.id);
    const state = structuredClone(adopted.state.current);
    tamper({ state, client: fixture.client });
    const noArchiveStore = {
      async list() { throw new Error('later recorded proof must not reread archives'); },
    };
    const later = workflow(state, fixture.client, {
      archiveStore: noArchiveStore,
      git: packetGit,
      journal: fakeJournal(fixture.client.events),
    });
    await assert.rejects(
      () => later.api.replyResolve(35, fixture.portabilityTask.id),
      GitHubWorkflowError,
      label,
    );
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive proof lineage rejects replay-only, divergent carriers, and partial intent authority', async () => {
  const cases = [
    ['replay only', (fixture) => [replayArchive(fixture.archive)]],
    ['divergent task', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.tasks[0].summary = 'Divergent replay task.';
      return [fixture.archive, replay];
    }],
    ['missing proof row', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.threadResolutionStatus.threads.pop();
      return [fixture.archive, replay];
    }],
    ['divergent task set', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.threadResolutionStatus.threads[0].taskIds.push('foreign-task');
      return [fixture.archive, replay];
    }],
    ['divergent historical head', (fixture) => {
      const replay = replayArchive(fixture.archive);
      for (const proofRow of replay.state.threadResolutionStatus.threads) {
        proofRow.observedHeadSha = ADVANCED_HEAD;
      }
      return [fixture.archive, replay];
    }],
    ['divergent reply identity', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.threadResolutionStatus.threads[0].replyId = 'REPLY_DIVERGENT';
      return [fixture.archive, replay];
    }],
    ['divergent resolution identity', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.threadResolutionStatus.threads[0].resolvedBy = 'other-operator';
      return [fixture.archive, replay];
    }],
    ['partial replay intent footprint', (fixture) => {
      const replay = replayArchive(fixture.archive, { retainValidation: true });
      replay.events.unshift(structuredClone(
        fixture.archive.events.find((event) => event.details?.type === 'reply'),
      ));
      return [fixture.archive, replay];
    }],
    ['conflicting complete origins', (fixture) => {
      const conflicting = {
        ...structuredClone(fixture.archive), archiveId: 'pr-2-2026-08-05T00-02-00-000Z',
      };
      const intent = conflicting.events.find((event) => event.details?.type === 'reply');
      intent.details.at = '2026-08-04T23:58:31.000Z';
      intent.at = '2026-08-04T23:58:31.001Z';
      return [fixture.archive, conflicting];
    }],
    ['nonterminal replay envelope', (fixture) => {
      const replay = replayArchive(fixture.archive);
      replay.state.abandonmentReason = null;
      replay.events = replay.events.filter((event) => event.type !== 'abandoned');
      return [fixture.archive, replay];
    }],
  ];

  for (const [label, recordsFor] of cases) {
    const fixture = archiveAdoptionFixture();
    const records = recordsFor(fixture);
    const originalRecords = structuredClone(records);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore(records), journal: fixture.journal,
    });

    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), GitHubWorkflowError, label);

    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
    assert.deepEqual(records, originalRecords, `${label} archive carriers remain immutable`);
  }
});

test('archive proof lineage rejects every extra selected-root intent correlation without writes', async () => {
  const cases = [
    ['different-HEAD reply operation', () => archiveIntentEvent(
      'reply', `reply:2:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
    )],
    ['different-HEAD resolve operation', () => archiveIntentEvent(
      'resolve', `resolve:2:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
    )],
    ['different-HEAD summary alias', () => {
      const event = archiveIntentEvent(
        'reply', `reply:2:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.summary = `Intent reply reply:2:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`;
      return event;
    }],
    ['historical client-ID alias', () => {
      const event = archiveIntentEvent(
        'resolve', `resolve:2:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
      );
      event.details.clientMutationId = priorIntent(
        'resolve', `resolve:2:THREAD_ARCHIVE_A:${OTHER_HEAD}`,
      ).clientMutationId;
      return event;
    }],
  ];

  for (const [label, extraEvent] of cases) {
    const fixture = archiveAdoptionFixture();
    fixture.archive.events.splice(-1, 0, extraEvent());
    const originalArchive = structuredClone(fixture.archive);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
    });

    await assert.rejects(
      () => setup.api.replyResolve(2, ARCHIVED_TASK_ID),
      { code: 'ARCHIVE_INTENT_AMBIGUOUS' },
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
    assert.deepEqual(fixture.archive, originalArchive, `${label} archive remains immutable`);
  }
});

test('archive intent recognition is PR-neutral by selected thread and ignores only unrelated roots', async () => {
  const rejectedCases = [
    ['wrong-PR reply details only', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
    ['wrong-PR resolve operation', () => archiveIntentEvent(
      'resolve', `resolve:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
    )],
    ['mismatched summary and operation labels', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.summary = `Intent reply resolve:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`;
      return event;
    }],
    ['extra-head selected operation', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.details.operationId = `reply:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}:extra`;
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
    ['wrong-namespace reply details only', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.details.operationId = `close:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`;
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
    ['wrong-namespace resolve details only', () => {
      const event = archiveIntentEvent(
        'resolve', `resolve:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
      );
      event.details.operationId = `close:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`;
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
    ['wrong-namespace and label summary only', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.summary = `Intent close close:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`;
      return event;
    }],
    ['selected token outside the canonical slot', () => {
      const event = archiveIntentEvent(
        'reply', `reply:999:THREAD_FOREIGN:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
      );
      event.details.type = 'close';
      event.details.operationId = `close:999:THREAD_FOREIGN:${ADVANCED_HEAD}:THREAD_ARCHIVE_A`;
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
    ['altered outer wrapper with selected details only', () => {
      const event = archiveIntentEvent(
        'resolve', `resolve:999:THREAD_ARCHIVE_A:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
      );
      event.type = 'altered-mutation-envelope';
      event.summary = 'Unrelated envelope text.';
      return event;
    }],
  ];

  for (const [label, extraEvent] of rejectedCases) {
    const fixture = archiveAdoptionFixture();
    fixture.archive.events.splice(-1, 0, extraEvent());
    const originalArchive = structuredClone(fixture.archive);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
    });

    await assert.rejects(
      () => setup.api.replyResolve(2, ARCHIVED_TASK_ID),
      { code: 'ARCHIVE_INTENT_AMBIGUOUS' },
      label,
    );
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
    assert.deepEqual(fixture.archive, originalArchive, `${label} archive remains immutable`);
  }

  const unrelated = archiveAdoptionFixture();
  unrelated.archive.events.splice(-1, 0, archiveIntentEvent(
    'reply', `reply:999:THREAD_UNRELATED:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
  ));
  unrelated.archive.events.splice(-1, 0, archiveIntentEvent(
    'close', `close:999:THREAD_UNRELATED:${ADVANCED_HEAD}`, ARCHIVE_REPLY_INTENT_AT,
  ));
  const unrelatedWrapper = archiveIntentEvent(
    'resolve', `resolve:999:THREAD_UNRELATED:${ADVANCED_HEAD}`, ARCHIVE_RESOLVE_INTENT_AT,
  );
  unrelatedWrapper.type = 'altered-mutation-envelope';
  unrelatedWrapper.summary = 'Unrelated envelope text.';
  unrelated.archive.events.splice(-1, 0, unrelatedWrapper);
  const originalArchive = structuredClone(unrelated.archive);
  const archiveStore = immutableArchiveStore([unrelated.archive]);
  const setup = workflow(unrelated.active, unrelated.client, {
    archiveStore, journal: unrelated.journal,
  });

  const result = await setup.api.replyResolve(2, ARCHIVED_TASK_ID);

  assert.equal(archiveStore.calls, 2);
  assert.equal(setup.state.calls.length, 1);
  assert.equal(result.threadResolutionStatus.threads.filter((thread) => thread.isResolved).length, 2);
  assert.equal(
    unrelated.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(unrelated.client.events, []);
  assert.deepEqual(unrelated.archive, originalArchive);
});

test('archive batch adoption honors reply represented-second and resolve-intent boundaries byte-for-byte', async () => {
  const accepted = archiveAdoptionFixture();
  const acceptedReplyEvents = accepted.archive.events.filter((event) => event.details?.type === 'reply');
  const acceptedResolveEvents = accepted.archive.events.filter((event) => event.details?.type === 'resolve');
  acceptedReplyEvents[0].details.at = '2026-08-04T23:59:00.100Z';
  acceptedReplyEvents[0].at = '2026-08-04T23:59:00.110Z';
  acceptedResolveEvents[0].details.at = '2026-08-04T23:59:00.200Z';
  acceptedResolveEvents[0].at = '2026-08-04T23:59:00.210Z';
  acceptedReplyEvents[1].details.at = '2026-08-04T23:59:00.100Z';
  acceptedReplyEvents[1].at = '2026-08-04T23:59:00.999Z';
  assert.deepEqual(
    [
      acceptedReplyEvents[0].details.at,
      acceptedReplyEvents[0].at,
      acceptedResolveEvents[0].details.at,
      acceptedResolveEvents[0].at,
    ],
    [
      '2026-08-04T23:59:00.100Z',
      '2026-08-04T23:59:00.110Z',
      '2026-08-04T23:59:00.200Z',
      '2026-08-04T23:59:00.210Z',
    ],
  );
  assert.deepEqual(
    [acceptedReplyEvents[1].details.at, acceptedReplyEvents[1].at],
    ['2026-08-04T23:59:00.100Z', '2026-08-04T23:59:00.999Z'],
  );
  const acceptedSetup = workflow(accepted.active, accepted.client, {
    archiveStore: immutableArchiveStore([accepted.archive]), journal: accepted.journal,
  });

  await acceptedSetup.api.replyResolve(2, ARCHIVED_TASK_ID);

  assert.equal(acceptedSetup.state.calls.length, 1);
  assert.equal(accepted.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  assert.deepEqual(accepted.client.events, []);

  for (const [label, replyIntentAt, replyEventAt, resolveIntentAt, resolveEventAt] of [
    ['next-second wrapper', '2026-08-04T23:59:00.100Z', '2026-08-04T23:59:01.000Z'],
    ['next-second details and wrapper', '2026-08-04T23:59:01.000Z', '2026-08-04T23:59:01.000Z'],
    [
      'reply wrapper after resolve intent',
      '2026-08-04T23:59:00.100Z',
      '2026-08-04T23:59:00.900Z',
      '2026-08-04T23:59:00.200Z',
      '2026-08-04T23:59:00.210Z',
    ],
  ]) {
    const rejected = archiveAdoptionFixture();
    const rejectedReplyEvent = rejected.archive.events.find((event) => event.details?.type === 'reply');
    rejectedReplyEvent.details.at = replyIntentAt;
    rejectedReplyEvent.at = replyEventAt;
    const rejectedResolveEvent = rejected.archive.events.find((event) => event.details?.type === 'resolve');
    if (resolveIntentAt !== undefined) {
      rejectedResolveEvent.details.at = resolveIntentAt;
      rejectedResolveEvent.at = resolveEventAt;
    }
    assert.deepEqual(
      [
        rejectedReplyEvent.details.at,
        rejectedReplyEvent.at,
        rejectedResolveEvent.details.at,
        rejectedResolveEvent.at,
      ],
      [
        replyIntentAt,
        replyEventAt,
        resolveIntentAt ?? ARCHIVE_RESOLVE_INTENT_AT,
        resolveEventAt ?? new Date(Date.parse(ARCHIVE_RESOLVE_INTENT_AT) + 1).toISOString(),
      ],
      label,
    );
    const rejectedSetup = workflow(rejected.active, rejected.client, {
      archiveStore: immutableArchiveStore([rejected.archive]), journal: rejected.journal,
    });

    await assert.rejects(
      () => rejectedSetup.api.replyResolve(2, ARCHIVED_TASK_ID),
      { code: 'ARCHIVE_INTENT_INVALID' },
      label,
    );
    assert.equal(rejectedSetup.state.calls.length, 0, label);
    assert.equal(
      rejected.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(rejected.client.events, [], label);
  }
});

test('archive batch adoption rejects proof, intent, and live reply tampering without durable mutation', async () => {
  const cases = [
    ['duplicate proof', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads.push(
        structuredClone(fixture.archive.state.threadResolutionStatus.threads[0]),
      );
    }],
    ['mixed historical heads', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads[1].observedHeadSha = ADVANCED_HEAD;
    }],
    ['altered root identity', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads[0].rootCommentNodeId = 'ROOT_altered';
    }],
    ['altered reply URL', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads[0].replyUrl = 'https://github.com/example/aerstello/pull/2#discussion_r999';
    }],
    ['missing reply intent', (fixture) => {
      const operationId = `reply:2:THREAD_ARCHIVE_A:${OTHER_HEAD}`;
      fixture.archive.events = fixture.archive.events.filter((event) => event.details?.operationId !== operationId);
    }],
    ['duplicate resolve intent', (fixture) => {
      const operationId = `resolve:2:THREAD_ARCHIVE_A:${OTHER_HEAD}`;
      fixture.archive.events.push(structuredClone(
        fixture.archive.events.find((event) => event.details?.operationId === operationId),
      ));
      const terminal = fixture.archive.events.splice(-2, 1)[0];
      fixture.archive.events.push(terminal);
    }],
    ['altered deterministic client ID', (fixture) => {
      fixture.archive.events.find((event) => event.details?.type === 'reply').details.clientMutationId = 'aerstello-altered';
    }],
    ['reply intent after reply', (fixture) => {
      const event = fixture.archive.events.find((candidate) => candidate.details?.type === 'reply');
      event.details.at = ARCHIVE_RESOLVE_INTENT_AT;
      event.at = ARCHIVE_RESOLVE_INTENT_AT;
    }],
    ['resolve intent precedes reply creation', (fixture) => {
      const event = fixture.archive.events.find((candidate) => candidate.details?.type === 'resolve');
      event.details.at = '2026-08-04T23:58:45.000Z';
      event.at = '2026-08-04T23:58:45.001Z';
    }],
    ['durable proof precedes resolve intent', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads[0].resolvedAt = '2026-08-04T23:59:29.999Z';
    }],
    ['resolve intent event postdates a later durable proof', (fixture) => {
      const event = fixture.archive.events.find((candidate) => candidate.details?.type === 'resolve');
      event.at = '2026-08-04T23:59:45.001Z';
    }],
    ['durable proof postdates archive terminal bounds', (fixture) => {
      fixture.archive.state.threadResolutionStatus.threads[0].resolvedAt = '2026-08-05T00:02:00.000Z';
    }],
    ['resolve intent event postdates archive terminal bounds', (fixture) => {
      const event = fixture.archive.events.find((candidate) => candidate.details?.type === 'resolve');
      event.at = '2026-08-05T00:02:00.000Z';
    }],
    ['edited root', (fixture) => {
      fixture.client.threadComments.get('THREAD_ARCHIVE_A')[0].lastEditedAt = AT;
    }],
    ['altered reply body', (fixture) => {
      fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1].body += '\naltered';
    }],
    ['altered validation text', (fixture) => {
      const reply = fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1];
      reply.body = reply.body.replace(
        'Validation: npm run test:pr-review.', 'Validation: npm run check:full.',
      );
    }],
    ['foreign reply author', (fixture) => {
      fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1].author = BOT;
    }],
    ['wrong reply parent', (fixture) => {
      fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1].replyTo = { id: 'ROOT_wrong' };
    }],
    ['extra live reply', (fixture) => {
      fixture.client.threadComments.get('THREAD_ARCHIVE_A').push({
        ...structuredClone(fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1]),
        id: 'REPLY_EXTRA', databaseId: 999,
      });
    }],
  ];

  for (const [label, mutate] of cases) {
    const fixture = archiveAdoptionFixture();
    mutate(fixture);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), GitHubWorkflowError, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false, label);
    assert.deepEqual(fixture.client.events, [], label);
  }
});

test('archive batch adoption requires pristine proof, current verifier coverage, complete root mapping, and ancestry', async () => {
  const cases = [
    ['non-pristine proof', (fixture) => {
      fixture.active.threadResolutionStatus = {
        ...fixture.active.threadResolutionStatus,
        status: 'failed', headSha: HEAD, updatedAt: AT,
        threads: fixture.archive.state.threadResolutionStatus.threads.map((thread) => ({
          ...thread, replyId: null, replyUrl: null, isResolved: false,
          resolvedAt: null, resolvedBy: null,
        })),
      };
    }],
    ['resolved GitHub-thread remediation', (fixture) => {
      fixture.active.threadResolutionStatus.threadlessVerification = proof('not-run').threadlessVerification;
      fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID).status = 'integrated';
      fixture.active.tasks.find((task) => task.id === 'current-thread-fix').status = 'completed';
    }],
    ['incomplete root mapping', (fixture) => {
      addThread(fixture.client, { id: 'THREAD_UNMAPPED', root: rootComment('THREAD_UNMAPPED', { databaseId: 777 }) });
    }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = archiveAdoptionFixture();
    mutate(fixture);
    const archiveStore = immutableArchiveStore([fixture.archive]);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore, journal: fixture.journal,
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), GitHubWorkflowError, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false, label);
  }

  const ancestry = archiveAdoptionFixture();
  const ancestrySetup = workflow(ancestry.active, ancestry.client, {
    archiveStore: immutableArchiveStore([ancestry.archive]), journal: ancestry.journal,
    git: fakeGit({
      isAncestor: async (ancestor, descendant) => ancestor !== OTHER_HEAD && descendant === HEAD,
    }),
  });
  await assert.rejects(() => ancestrySetup.api.replyResolve(2, ARCHIVED_TASK_ID), { code: 'MUTATION_NOT_READY' });
  assert.equal(ancestrySetup.state.calls.length, 0);
  assert.deepEqual(ancestry.client.events, []);
});

test('archive batch adoption repeats live, archive, head, and revision guards before its one checkpoint', async () => {
  for (const [label, race, code] of [
    ['reply body race', (fixture) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          fixture.client.threadComments.get('THREAD_ARCHIVE_A')[1].body += '\nraced';
        }
        return graphql(input);
      };
    }, 'ARCHIVE_REPLY_MISMATCH'],
    ['resolution race', (fixture) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          fixture.client.threads.find((thread) => thread.id === 'THREAD_ARCHIVE_A').isResolved = false;
        }
        return graphql(input);
      };
    }, 'THREAD_PROOF_STALE'],
    ['live head race', (fixture) => {
      const graphql = fixture.client.graphql.bind(fixture.client);
      let metadataReads = 0;
      fixture.client.graphql = async (input) => {
        if (input.name === 'PullRequestMetadata' && ++metadataReads === 2) {
          fixture.client.metadata.headRefOid = ADVANCED_HEAD;
        }
        return graphql(input);
      };
    }, 'MUTATION_NOT_READY'],
  ]) {
    const fixture = archiveAdoptionFixture();
    race(fixture);
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false, label);
  }

  const archiveRace = archiveAdoptionFixture();
  let archiveReads = 0;
  const archiveStore = {
    async list() {
      archiveReads += 1;
      const archive = structuredClone(archiveRace.archive);
      if (archiveReads === 2) archive.events[0].at = AT;
      return [archive];
    },
  };
  const archiveRaceSetup = workflow(archiveRace.active, archiveRace.client, {
    archiveStore, journal: archiveRace.journal,
  });
  await assert.rejects(() => archiveRaceSetup.api.replyResolve(2, ARCHIVED_TASK_ID), GitHubWorkflowError);
  assert.equal(archiveRaceSetup.state.calls.length, 0);

  for (const [label, snapshots] of [
    ['lineage carrier added', (fixture) => [
      [fixture.archive],
      [fixture.archive, replayArchive(fixture.archive)],
    ]],
    ['lineage carrier removed', (fixture) => [
      [fixture.archive, replayArchive(fixture.archive)],
      [fixture.archive],
    ]],
    ['lineage carrier content altered', (fixture) => {
      const replay = replayArchive(fixture.archive);
      const altered = structuredClone(replay);
      altered.state.nextAction = 'Changed after the first immutable inventory read.';
      return [
        [fixture.archive, replay],
        [fixture.archive, altered],
      ];
    }],
  ]) {
    const fixture = archiveAdoptionFixture();
    const reads = snapshots(fixture);
    let calls = 0;
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: {
        async list() {
          const snapshot = reads[Math.min(calls, reads.length - 1)];
          calls += 1;
          return structuredClone(snapshot);
        },
      },
      journal: fixture.journal,
    });

    await assert.rejects(
      () => setup.api.replyResolve(2, ARCHIVED_TASK_ID),
      { code: 'THREAD_PROOF_STALE' },
      label,
    );
    assert.equal(calls, 2, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(
      fixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
      false,
      label,
    );
    assert.deepEqual(fixture.client.events, [], label);
  }

  const revisionRace = archiveAdoptionFixture();
  let revisionSetup;
  const revisionStore = immutableArchiveStore([revisionRace.archive], async (calls) => {
    if (calls === 2) revisionSetup.state.advanceRevisionForTest();
  });
  revisionSetup = workflow(revisionRace.active, revisionRace.client, {
    archiveStore: revisionStore, journal: revisionRace.journal,
  });
  await assert.rejects(() => revisionSetup.api.replyResolve(2, ARCHIVED_TASK_ID), {
    code: 'STATE_REVISION_CHANGED',
  });
  assert.equal(revisionSetup.state.calls.length, 0);
  assert.deepEqual(revisionRace.client.events, []);
});
