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

test('a later provenance-bound active-task carrier remains a zero-intent aggregate replay', async () => {
  const oldArchive = decodedPacketArchive(
    PACKET_ARCHIVE_NAME, PACKET_ARCHIVE_STATE_BASE64, PACKET_ARCHIVE_EVENTS_BASE64,
  );
  const mixedArchive = decodedPacketArchive(
    PACKET_MIXED_ARCHIVE_NAME, PACKET_MIXED_ARCHIVE_STATE_BASE64, PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  );
  const firstFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
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

  const alternateTaskCarrier = structuredClone(replayCarrier);
  alternateTaskCarrier.archiveId = 'pr-35-2026-08-20T12-10-30-000Z';
  const alternateTaskId = 'alternate-provenance-bound-aggregate';
  alternateTaskCarrier.state.tasks.find(
    (task) => task.id === firstFixture.aggregateTask.id,
  ).id = alternateTaskId;
  for (const row of alternateTaskCarrier.state.threadResolutionStatus.threads) {
    if (Object.hasOwn(row, 'archiveProvenance')) row.taskIds = [alternateTaskId];
  }
  const alternateFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  alternateFixture.active.tasks.find((task) => task.id === alternateFixture.remediation.id).status = 'completed';
  alternateFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [alternateFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
  };
  const alternate = workflow(alternateFixture.active, alternateFixture.client, {
    archiveStore: immutableArchiveStore([alternateTaskCarrier, mixedArchive, oldArchive]),
    git: packetGit,
    journal: fakeJournal(alternateFixture.client.events),
  });
  await assert.rejects(
    () => alternate.api.replyResolve(35, alternateFixture.aggregateTask.id),
    GitHubWorkflowError,
  );
  assert.equal(alternate.state.calls.length, 0);
  assert.equal(
    alternateFixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(alternateFixture.client.events, []);

  const replayClosureCases = [
    ['active replay unanchored selected-root task', () => {
      const carrier = structuredClone(replayCarrier);
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
      const carrier = structuredClone(replayCarrier);
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
      const carrier = structuredClone(replayCarrier);
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
    const closureFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
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

  const retryFixture = packetAggregateAdoptionFixture(oldArchive, mixedArchive);
  retryFixture.active.tasks.find((task) => task.id === retryFixture.remediation.id).status = 'completed';
  retryFixture.active.threadResolutionStatus.threadlessVerification = {
    status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
    taskIds: [retryFixture.remediation.id], updatedAt: '2026-08-20T12:11:00.000Z',
  };
  const retryStore = immutableArchiveStore([replayCarrier, mixedArchive, oldArchive]);
  const retry = workflow(retryFixture.active, retryFixture.client, {
    archiveStore: retryStore,
    git: packetGit,
    journal: fakeJournal(retryFixture.client.events),
  });
  const retried = await retry.api.replyResolve(35, retryFixture.aggregateTask.id);

  assert.equal(retryStore.calls, 2);
  assert.equal(retry.state.calls.length, 1);
  assert.equal(retried.threadResolutionStatus.threads.filter(
    (row) => row.archiveProvenance?.authorityFingerprint === authorityFingerprint,
  ).length, 9);
  assert.equal(
    retryFixture.client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)),
    false,
  );
  assert.deepEqual(retryFixture.client.events, []);
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
    ['absent verifier coverage', (fixture) => {
      fixture.active.threadResolutionStatus.threadlessVerification = proof('not-run').threadlessVerification;
      fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID).status = 'integrated';
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
