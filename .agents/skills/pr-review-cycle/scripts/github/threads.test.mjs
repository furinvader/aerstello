import * as harness from './test-support/workflow-harness.mjs';

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

test('reply-resolve identifies explicit root, deduplicates shared source identities, replies before resolve, and re-queries proof', async () => {
  const events = [];
  const client = new FakeClient({ events });
  addThread(client);
  const initial = integratedThreadState(['thread:THREAD_1', 'discussion:41']);
  initial.tasks.push(integratedNonThreadState().tasks[0]);
  const { api, state } = workflow(initial, client);
  const result = await api.replyResolve(2, 'task-thread');
  assert.deepEqual(events.filter((item) => item.startsWith('mutation:')), ['mutation:AddThreadReply', 'mutation:ResolveThread']);
  assert.equal(client.calls.filter((call) => call.name === 'AddThreadReply').length, 1);
  assert.equal(client.calls.filter((call) => call.name === 'ResolveThread').length, 1);
  assert.match(client.threadComments.get('THREAD_1')[1].body, /<!-- aerstello-review:[0-9a-f]{24} -->/u);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(state.current.tasks[0].status, 'completed');
  assert.equal(state.current.tasks[1].status, 'integrated');
  assert.deepEqual(state.calls.at(-1).input.verifiedLocalTaskIds, undefined);
});

test('reply-resolve reuses a crash reply marker, resumes resolve, and never trusts mutation responses', async () => {
  const seed = new FakeClient();
  addThread(seed);
  const first = workflow(integratedThreadState(), seed);
  seed.noEffect.add('ResolveThread');
  await assert.rejects(() => first.api.replyResolve(2, 'task-thread'), { code: 'RESOLVE_NOT_PROVEN' });
  const reply = seed.threadComments.get('THREAD_1')[1];
  assert.ok(reply);
  seed.noEffect.delete('ResolveThread');
  seed.calls.length = 0;
  const resumed = workflow(integratedThreadState(), seed);
  await resumed.api.replyResolve(2, 'task-thread');
  assert.equal(seed.calls.some((call) => call.name === 'AddThreadReply'), false);
  assert.equal(seed.calls.filter((call) => call.name === 'ResolveThread').length, 1);

  const noReply = new FakeClient({ noEffect: new Set(['AddThreadReply']) });
  addThread(noReply);
  await assert.rejects(
    () => workflow(integratedThreadState(), noReply).api.replyResolve(2, 'task-thread'),
    { code: 'REPLY_NOT_PROVEN' },
  );
});

test('threadless task completion consumes only successful exact-head verification and performs no GitHub mutation', async () => {
  const task = {
    id: 'threadless', sourceIds: ['review:threadless'], sourceType: 'github-threadless',
    fingerprint: 'threadless-fingerprint', summary: 'Threadless finding.', severity: 'P1',
    disposition: 'actionable', status: 'integrated', integratedCommitSha: HEAD, resolutionSummary: 'Verified.',
  };
  const verified = integratedThreadState();
  verified.tasks = [task];
  verified.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: { status: 'passed', headSha: HEAD, taskIds: ['threadless'], updatedAt: AT },
  };
  const client = new FakeClient();
  const completed = workflow(verified, client);
  await completed.api.replyResolve(2, 'threadless');
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
  assert.equal(completed.state.current.tasks[0].status, 'completed');

  const missing = structuredClone(verified);
  missing.threadResolutionStatus.threadlessVerification = {
    status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
  };
  await assert.rejects(() => workflow(missing).api.replyResolve(2, 'threadless'), { code: 'TASK_NOT_READY' });
});

test('verify-resolve completes only the selected local task after repeated read-only exact-head guards', async () => {
  const state = integratedNonThreadState();
  state.tasks.push({
    ...state.tasks[0], id: 'task-other-local', fingerprint: 'fp-task-other-local',
  });
  const client = new FakeClient({ pageSize: 1 });
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const setup = workflow(state, client, { journal });
  const result = await setup.api.verifyResolve(2, ['task-local']);
  assert.equal(result.taskId, 'task-local');
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['completed', 'integrated']);
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, ['task-local']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: HEAD, taskIds: ['task-local'], updatedAt: AT,
  });
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 2);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const guardedThreadReads = client.calls.filter((call) => call.name === 'PullRequestThreads').length;
  const retried = await setup.api.verifyResolve(2, ['task-local']);
  assert.equal(retried.stateRevision, revision);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= guardedThreadReads + 2);
});

test('verify-resolve completes only the selected eligible non-actionable local task idempotently', async () => {
  const state = nonActionableNonThreadState('local', 'disposed-a', 'duplicate');
  state.tasks.push(nonActionableNonThreadState('local', 'disposed-b', 'stale').tasks[0]);
  const client = new FakeClient();
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const setup = workflow(state, client, { journal });
  await setup.api.verifyResolve(2, ['disposed-b']);
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['not-applicable', 'completed']);
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, ['disposed-b']);
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const retried = await setup.api.verifyResolve(2, ['disposed-b']);
  assert.equal(retried.stateRevision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);

  for (const disposition of ['already-fixed', 'invalid', 'policy-conflict', 'out-of-scope']) {
    const candidate = nonActionableNonThreadState('local', `disposed-${disposition}`, disposition);
    const candidateSetup = workflow(candidate, new FakeClient());
    await candidateSetup.api.verifyResolve(2, [candidate.tasks[0].id]);
    assert.equal(candidateSetup.state.current.tasks[0].status, 'completed');
  }
});

test('verify-resolve re-attests completed local tasks at a new HEAD as a guarded accumulating exact set', async () => {
  const state = integratedNonThreadState('local', 'local-a');
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { ...state.git, headSha: OTHER_HEAD };
  state.validationStatus = { ...state.validationStatus, headSha: OTHER_HEAD };
  state.tasks = [
    { ...state.tasks[0], id: 'local-a', fingerprint: 'fp-local-a', status: 'completed' },
    { ...state.tasks[0], id: 'local-b', fingerprint: 'fp-local-b', status: 'completed' },
  ];
  state.threadResolutionStatus = {
    status: 'not-run', headSha: null, threads: [],
    threadlessVerification: proof('not-run').threadlessVerification,
    localVerification: { status: 'passed', headSha: HEAD, taskIds: ['local-a', 'local-b'], updatedAt: AT },
    updatedAt: null,
  };
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const journal = {
    async lookupIntent() { throw new Error('local re-attestation must not read the mutation journal'); },
    async ensureIntent() { throw new Error('local re-attestation must not write the mutation journal'); },
  };
  const setup = workflow(state, client, {
    journal,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
  });

  await setup.api.verifyResolve(2, ['local-a']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: OTHER_HEAD, taskIds: ['local-a'], updatedAt: AT,
  });
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['completed', 'completed']);

  await setup.api.verifyResolve(2, ['local-b']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification.taskIds, ['local-a', 'local-b']);
  const revision = setup.state.current.revision;
  const checkpoints = setup.state.calls.length;
  const guardedThreadReads = client.calls.filter((call) => call.name === 'PullRequestThreads').length;
  await setup.api.verifyResolve(2, ['local-a']);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpoints);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= guardedThreadReads + 2);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
  assert.deepEqual(client.events, []);
});

test('verify-resolve creates current-head threadless proof and preserves prior proven IDs', async () => {
  const state = integratedNonThreadState('github-threadless', 'threadless-new');
  state.tasks.unshift({
    ...state.tasks[0], id: 'threadless-prior', fingerprint: 'fp-threadless-prior', status: 'completed',
  });
  state.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: {
      status: 'passed', headSha: HEAD, taskIds: ['threadless-prior'], updatedAt: AT,
    },
  };
  const client = new FakeClient();
  const setup = workflow(state, client);
  await setup.api.verifyResolve(2, ['threadless-new']);
  assert.deepEqual(
    setup.state.current.threadResolutionStatus.threadlessVerification.taskIds,
    ['threadless-new', 'threadless-prior'],
  );
  assert.equal(setup.state.current.threadResolutionStatus.threadlessVerification.headSha, HEAD);
  assert.ok(setup.state.current.tasks.every((task) => task.status === 'completed'));
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, []);
  assert.equal(client.events.length, 0);
});

test('verify-resolve proves eligible non-actionable threadless tasks and rejects needs-human decisions', async () => {
  const state = nonActionableNonThreadState('github-threadless', 'threadless-disposed', 'already-fixed');
  state.tasks.unshift({
    ...state.tasks[0], id: 'threadless-prior', fingerprint: 'fp-threadless-prior', status: 'completed',
  });
  state.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: {
      status: 'passed', headSha: HEAD, taskIds: ['threadless-prior'], updatedAt: AT,
    },
  };
  const client = new FakeClient();
  const setup = workflow(state, client);
  await setup.api.verifyResolve(2, ['threadless-disposed']);
  assert.deepEqual(
    setup.state.current.threadResolutionStatus.threadlessVerification.taskIds,
    ['threadless-disposed', 'threadless-prior'],
  );
  assert.ok(setup.state.current.tasks.every((task) => task.status === 'completed'));
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  await setup.api.verifyResolve(2, ['threadless-disposed', 'threadless-prior']);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);

  for (const sourceType of ['local', 'github-threadless']) {
    const needsHuman = nonActionableNonThreadState(sourceType, `needs-human-${sourceType}`, 'needs-human-decision');
    const rejected = workflow(needsHuman, new FakeClient());
    await assert.rejects(() => rejected.api.verifyResolve(2, [needsHuman.tasks[0].id]), { code: 'TASK_NOT_READY' });
    assert.equal(rejected.state.calls.length, 0);
    assert.equal(rejected.client.events.length, 0);
  }
});

test('verify-resolve re-attests completed threadless proof after HEAD drift without aggregate fabrication', async () => {
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const later = '2026-08-05T00:01:00Z';
  for (const [label, withTerminalThreadTask] of [
    ['ordinary stale proof', false],
    ['one-root already-fixed terminal thread task', true],
  ]) {
    const state = completedThreadlessDriftState();
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    if (withTerminalThreadTask) {
      state.tasks.push({
        ...archivedBatchTask(), sourceIds: ['thread:THREAD_ARCHIVE_A'],
      });
      state.threadResolutionStatus.localVerification = proof('not-run').localVerification;
      addThread(client, {
        id: 'THREAD_ARCHIVE_A', resolved: true,
        root: rootComment('THREAD_ARCHIVE_A', { databaseId: 510 }),
      });
    }
    const originalAggregate = structuredClone(state.threadResolutionStatus);
    const setup = workflow(state, client, { git, journal, clock: { now: () => later } });
    const result = await setup.api.verifyResolve(2, ['threadless-completed']);
    assert.equal(result.stateRevision, state.revision + 1, label);
    assert.deepEqual(result.threadResolutionStatus, {
      ...originalAggregate,
      threadlessVerification: {
        status: 'passed', headSha: OTHER_HEAD, taskIds: ['threadless-completed'], updatedAt: later,
      },
    }, label);
    assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, [], label);
    assert.equal(
      client.calls.filter((call) => call.name === 'PullRequestThreads').length,
      2,
      label,
    );
    assert.equal(client.events.length, 0, label);

    const revision = setup.state.current.revision;
    const checkpointCount = setup.state.calls.length;
    const guardedReads = client.calls.filter((call) => call.name === 'PullRequestThreads').length;
    const retry = await setup.api.verifyResolve(2, ['threadless-completed']);
    assert.equal(retry.stateRevision, revision, label);
    assert.equal(setup.state.current.revision, revision, label);
    assert.equal(setup.state.calls.length, checkpointCount, label);
    assert.equal(
      client.calls.filter((call) => call.name === 'PullRequestThreads').length,
      guardedReads + 2,
      `${label} retry repeats both complete live snapshots`,
    );
  }

  const aggregateNotInvalidated = completedThreadlessDriftState();
  aggregateNotInvalidated.threadResolutionStatus = {
    ...aggregateNotInvalidated.threadResolutionStatus,
    status: 'passed', headSha: HEAD, updatedAt: AT,
  };
  const rejected = workflow(aggregateNotInvalidated, new FakeClient({ metadata: {
    id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
    headRefOid: OTHER_HEAD, viewer: VIEWER,
  } }), { git });
  await assert.rejects(() => rejected.api.verifyResolve(2, ['threadless-completed']), { code: 'TASK_NOT_READY' });
  assert.equal(rejected.state.calls.length, 0);
  assert.equal(rejected.client.events.length, 0);
});

test('verify-resolve workflow accepts only arrays of exact opaque task IDs', async () => {
  for (const [label, selection] of [
    ['string', 'task-local'],
    ['null', null],
    ['object', { taskId: 'task-local' }],
    ['number', 1],
    ['empty ID', ['']],
    ['non-string ID', ['task-local', 1]],
  ]) {
    const client = new FakeClient();
    const setup = workflow(integratedNonThreadState(), client);
    await assert.rejects(() => setup.api.verifyResolve(2, selection), {
      code: 'TASK_NOT_READY',
    }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('verify-resolve atomically re-attests only the exact completed threadless task set', async () => {
  const taskIds = ['threadless-a', 'threadless-b'];
  const initial = completedThreadlessDriftState(taskIds);
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const updatedAt = '2026-08-05T00:02:00Z';
  const setup = workflow(initial, client, { git, journal, clock: { now: () => updatedAt } });

  const result = await setup.api.verifyResolve(2, ['threadless-b', 'threadless-a']);
  assert.deepEqual(result.taskIds, taskIds);
  assert.equal(Object.hasOwn(result, 'taskId'), false);
  assert.equal(result.stateRevision, initial.revision + 1);
  const expected = structuredClone(initial);
  expected.revision += 1;
  expected.threadResolutionStatus.threadlessVerification = {
    ...expected.threadResolutionStatus.threadlessVerification,
    headSha: OTHER_HEAD,
    taskIds,
    updatedAt,
  };
  assert.deepEqual(setup.state.current, expected, 'only the shared proof and revision advance');
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, []);
  assert.deepEqual(
    setup.state.calls.at(-1).input.threadResolutionStatus.threadlessVerification.taskIds,
    taskIds,
  );
  assert.equal(setup.state.current.threadResolutionStatus.status, 'not-run');
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 2);
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const retry = await setup.api.verifyResolve(2, ['threadless-a', 'threadless-b']);
  assert.equal(retry.stateRevision, revision);
  assert.deepEqual(retry.taskIds, taskIds);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.equal(client.events.length, 0);
});

test('verify-resolve rejects every non-exact completed threadless selection before checkpointing', async () => {
  const taskIds = ['threadless-a', 'threadless-b'];
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const cases = [
    ['partial set', () => completedThreadlessDriftState(taskIds), ['threadless-a'], 'TASK_NOT_READY'],
    ['duplicate ID', () => completedThreadlessDriftState(taskIds), ['threadless-a', 'threadless-a'], 'TASK_NOT_READY'],
    ['empty selection', () => completedThreadlessDriftState(taskIds), [], 'TASK_NOT_READY'],
    ['unknown ID', () => completedThreadlessDriftState(taskIds), [...taskIds, 'threadless-unknown'], 'TASK_NOT_FOUND'],
    ['extra eligible task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'threadless-extra', fingerprint: 'fp-threadless-extra',
        status: 'integrated',
      });
      return state;
    }, [...taskIds, 'threadless-extra'], 'TASK_NOT_READY'],
    ['local task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'local-completed', fingerprint: 'fp-local-completed',
        sourceType: 'local', sourceIds: ['local:verifier'],
      });
      return state;
    }, [...taskIds, 'local-completed'], 'TASK_NOT_READY'],
    ['not-completed task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'threadless-integrated', fingerprint: 'fp-threadless-integrated',
        disposition: 'duplicate', status: 'not-applicable', integratedCommitSha: null,
      });
      return state;
    }, [...taskIds, 'threadless-integrated'], 'TASK_NOT_READY'],
    ['ineligible task', () => {
      const state = completedThreadlessDriftState([...taskIds, 'threadless-ineligible']);
      state.tasks.find((task) => task.id === 'threadless-ineligible').disposition = 'needs-human-decision';
      state.tasks.find((task) => task.id === 'threadless-ineligible').integratedCommitSha = null;
      return state;
    }, [...taskIds, 'threadless-ineligible'], 'TASK_NOT_READY'],
  ];

  for (const [label, buildState, selection, code] of cases) {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const setup = workflow(buildState(), client, { git });
    await assert.rejects(() => setup.api.verifyResolve(2, selection), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }

  const alreadyCurrent = completedThreadlessDriftState(taskIds);
  alreadyCurrent.threadResolutionStatus.threadlessVerification.headSha = OTHER_HEAD;
  const currentClient = new FakeClient();
  currentClient.metadata.headRefOid = OTHER_HEAD;
  const current = workflow(alreadyCurrent, currentClient, { git });
  await assert.rejects(() => current.api.verifyResolve(2, ['threadless-a']), {
    code: 'TASK_NOT_READY',
  });
  assert.equal(current.state.calls.length, 0);
  assert.equal(currentClient.calls.length, 0);
  assert.equal(currentClient.events.length, 0);
});

test('verify-resolve rejects unsupported and stale selections without state or GitHub mutation', async () => {
  const unsupported = integratedThreadState();
  const unsupportedClient = new FakeClient();
  addThread(unsupportedClient);
  const unsupportedSetup = workflow(unsupported, unsupportedClient);
  await assert.rejects(() => unsupportedSetup.api.verifyResolve(2, ['task-thread']), { code: 'TASK_NOT_READY' });
  assert.equal(unsupportedSetup.state.calls.length, 0);
  assert.equal(unsupportedClient.events.length, 0);

  for (const [label, state, options, code] of [
    ['missing', integratedNonThreadState(), {}, 'TASK_NOT_FOUND'],
    ['unintegrated', (() => {
      const value = integratedNonThreadState();
      value.tasks[0] = {
        ...value.tasks[0], status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
        execution: {
          dependencies: [], ownedPaths: ['scripts/example.mjs'], worker: 'review_fix_worker',
          branch: null, worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
        },
      };
      return value;
    })(), {}, 'TASK_NOT_READY'],
    ['unvalidated', (() => {
      const value = integratedNonThreadState();
      value.validationStatus = stateFixture().validationStatus;
      return value;
    })(), {}, 'TASK_NOT_READY'],
    ['dirty', integratedNonThreadState(), {
      git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    }, 'MUTATION_NOT_READY'],
    ['unpushed', integratedNonThreadState(), {
      git: fakeGit({ pushedHead: async () => OTHER_HEAD }),
    }, 'MUTATION_NOT_READY'],
    ['non-ancestor', integratedNonThreadState(), {
      git: fakeGit({ isAncestor: async () => false }),
    }, 'MUTATION_NOT_READY'],
    ['live-head', integratedNonThreadState(), {}, 'MUTATION_NOT_READY'],
  ]) {
    const client = new FakeClient(label === 'live-head' ? { metadata: {
      id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
      headRefOid: OTHER_HEAD, viewer: VIEWER,
    } } : {});
    const setup = workflow(state, client, options);
    const taskId = label === 'missing' ? 'missing-task' : state.tasks[0].id;
    await assert.rejects(() => setup.api.verifyResolve(2, [taskId]), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('verify-resolve rechecks state and canonical root resolution before its state-only checkpoint', async () => {
  const racedState = fakeState(integratedNonThreadState());
  const originalLoad = racedState.load.bind(racedState);
  let stateReads = 0;
  racedState.load = async () => {
    const state = await originalLoad();
    stateReads += 1;
    return stateReads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  const racedClient = new FakeClient();
  const raced = createGitHubReviewWorkflow({
    client: racedClient, state: racedState, git: fakeGit(), clock: { now: () => AT }, journal: null,
  });
  await assert.rejects(() => raced.verifyResolve(2, ['task-local']), { code: 'STATE_REVISION_CHANGED' });
  assert.equal(racedState.calls.length, 0);
  assert.equal(racedClient.events.length, 0);

  const unexpectedRootClient = new FakeClient();
  addThread(unexpectedRootClient);
  const unexpectedRoot = workflow(integratedNonThreadState(), unexpectedRootClient);
  await assert.rejects(() => unexpectedRoot.api.verifyResolve(2, ['task-local']), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
  assert.equal(unexpectedRoot.state.calls.length, 0);
  assert.equal(unexpectedRootClient.events.length, 0);

  const threadState = integratedThreadState();
  threadState.tasks[0].status = 'completed';
  threadState.tasks.push(integratedNonThreadState().tasks[0]);
  threadState.threadResolutionStatus = {
    status: 'passed', headSha: HEAD, updatedAt: AT,
    threadlessVerification: proof('not-run').threadlessVerification,
    threads: [{
      threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_THREAD_1', rootCommentDatabaseId: 41,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_1', replyUrl: 'https://x/reply',
      isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
    }],
  };
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  class ResolutionRaceClient extends FakeClient {
    threadReads = 0;

    async graphql(input) {
      if (input.name === 'PullRequestThreads') {
        this.threadReads += 1;
        if (this.threadReads > 1) this.threads[0].isResolved = false;
      }
      return super.graphql(input);
    }
  }
  const resolutionClient = new ResolutionRaceClient();
  addThread(resolutionClient, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
  }] });
  const resolutionRace = workflow(threadState, resolutionClient);
  await assert.rejects(() => resolutionRace.api.verifyResolve(2, ['task-local']), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(resolutionRace.state.calls.length, 0);
  assert.equal(resolutionClient.events.length, 0);
});

test('reply-resolve fails on ambiguous roots and duplicate idempotency markers', async () => {
  const badRoot = new FakeClient();
  addThread(badRoot, { replies: [{ ...rootComment('THREAD_1'), id: 'ROOT_2' }] });
  await assert.rejects(() => workflow(integratedThreadState(), badRoot).api.replyResolve(2, 'task-thread'), {
    code: 'ROOT_IDENTITY_AMBIGUOUS',
  });

  const duplicate = new FakeClient();
  const root = addThread(duplicate);
  const marker = '<!-- aerstello-review:1234567890abcdef12345678 -->';
  duplicate.threadComments.get('THREAD_1').push(
    { id: 'R1', url: 'https://x/1', body: marker, replyTo: { id: root.id }, author: VIEWER },
    { id: 'R2', url: 'https://x/2', body: marker, replyTo: { id: root.id }, author: VIEWER },
  );
  await assert.rejects(() => workflow(integratedThreadState(), duplicate).api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
});

test('reply-resolve validates the full task plan before any mutation', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks.push({
    id: 'task-bad', sourceIds: ['local'], sourceType: 'local', fingerprint: 'bad', summary: 'Bad',
    severity: 'P1', disposition: 'actionable', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const { api } = workflow(state, client);
  await assert.rejects(() => api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
});

test('shared-root reply deterministically includes every mapped task', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks.push({ ...state.tasks[0], id: 'task-second', fingerprint: 'fp-second', integratedCommitSha: OTHER_HEAD });
  const { api } = workflow(state, client);
  await api.replyResolve(2, 'task-thread');
  const body = client.calls.find((call) => call.name === 'AddThreadReply').variables.body;
  assert.match(body, /task-second: b{40}/u);
  assert.match(body, /task-thread: a{40}/u);
  assert.ok(body.indexOf('task-second') < body.indexOf('task-thread'));
});

test('reply recovery rejects foreign, altered, and prior-head markers', async () => {
  for (const variant of ['foreign', 'altered', 'prior']) {
    const client = new FakeClient();
    const operationId = `reply:2:THREAD_1:${HEAD}`;
    const baseBody = `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`;
    const reply = {
      id: `REPLY_${variant}`, databaseId: 901, url: 'https://x/reply', createdAt: AT,
      author: variant === 'foreign' ? BOT : VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: variant === 'altered' ? `${baseBody}\naltered`
        : variant === 'prior' ? baseBody.replace(markerFor(operationId), markerFor(`reply:2:THREAD_1:${OTHER_HEAD}`)) : baseBody,
    };
    addThread(client, { replies: [reply] });
    await assert.rejects(() => workflow(integratedThreadState(), client).api.replyResolve(2, 'task-thread'), {
      code: 'REPLY_AMBIGUOUS',
    });
    assert.equal(client.calls.some((call) => call.name === 'AddThreadReply'), false);
  }
});

test('pre-resolved root without durable proof requires a pre-existing resolve intent', async () => {
  const client = new FakeClient();
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  addThread(client, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
  }] });
  const { api } = workflow(integratedThreadState(), client);
  await assert.rejects(() => api.replyResolve(2, 'task-thread'), { code: 'RESOLUTION_PROOF_MISSING' });
  assert.equal(client.events.length, 0);
});

test('pre-resolved root is adopted only from its pre-existing resolve intent timestamp', async () => {
  const client = new FakeClient();
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  addThread(client, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
  }] });
  const resolveOperation = `resolve:2:THREAD_1:${HEAD}`;
  const journal = fakeJournal([], [{
    ...priorIntent('resolve', resolveOperation),
  }]);
  const { api, state } = workflow(integratedThreadState(), client, { journal });
  await api.replyResolve(2, 'task-thread');
  assert.equal(state.current.threadResolutionStatus.threads[0].resolvedAt, AT);
  assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
});

test('malformed pre-existing resolve intents cannot adopt a live resolved root', async () => {
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  const resolveOperation = `resolve:2:THREAD_1:${HEAD}`;
  for (const intent of [
    { ...priorIntent('reply', resolveOperation) },
    { ...priorIntent('resolve', resolveOperation), clientMutationId: 'wrong' },
    { ...priorIntent('resolve', resolveOperation), at: 'not-a-time' },
  ]) {
    const client = new FakeClient();
    addThread(client, { resolved: true, replies: [{
      id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
    }] });
    const setup = workflow(integratedThreadState(), client, { journal: fakeJournal([], [intent]) });
    await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
    assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  }
});

test('needs-human-decision disposition cannot resolve a thread or journal a mutation', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks[0] = { ...state.tasks[0], disposition: 'needs-human-decision', status: 'not-applicable',
    integratedCommitSha: null, resolutionSummary: 'Requires a human decision.' };
  const setup = workflow(state, client);
  await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
  assert.equal(client.events.length, 0);
});

test('historical resolved proof survives a later-head validation, request, collection, and completion', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const oldOperation = `reply:2:THREAD_1:${HEAD}`;
  const root = addThread(client, { resolved: true, replies: [{
    id: 'REPLY_old', databaseId: 901, url: 'https://x/old-reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: old validation.\n${markerFor(oldOperation)}`,
  }] });
  root.createdAt = '2026-08-04T23:59:59Z';
  const task = integratedThreadState().tasks[0];
  task.status = 'completed';
  const historical = readyState({
    currentIntegrationHeadSha: OTHER_HEAD,
    git: { branch: 'main', headSha: OTHER_HEAD, dirty: false },
    validationStatus: { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['new validation'], updatedAt: AT },
    tasks: [task],
    threadResolutionStatus: {
      status: 'passed', headSha: OTHER_HEAD, updatedAt: AT,
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
        taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_old', replyUrl: 'https://x/old-reply',
        isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD }],
    },
  });
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(historical, client, { git });
  const requested = await setup.api.request(2, 'discovery');
  client.reactions.set(requested.request.id, [{ id: 'REACTION_clean', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  await setup.api.collect(2);
  const completed = await setup.api.complete(2);
  assert.equal(completed.completed, true);
  assert.equal(setup.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('every existing unresolved proof mismatch fails before journaling or mutation', async () => {
  for (const mutate of [
    (record) => { record.rootCommentNodeId = 'ROOT_wrong'; },
    (record) => { record.taskIds = ['task-other']; },
    (record) => { record.disposition = 'duplicate'; },
  ]) {
    const client = new FakeClient();
    const root = addThread(client);
    const record = { threadNodeId: 'THREAD_1', rootCommentNodeId: root.id,
      rootCommentDatabaseId: root.databaseId, taskIds: ['task-thread'], disposition: 'fixed',
      replyId: null, replyUrl: null, isResolved: false, resolvedAt: null, resolvedBy: null,
      observedHeadSha: HEAD };
    mutate(record);
    const state = integratedThreadState();
    state.threadResolutionStatus = { status: 'failed', headSha: HEAD, updatedAt: AT,
      threads: [record], threadlessVerification: proof().threadlessVerification };
    const setup = workflow(state, client);
    await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
    assert.equal(client.events.length, 0);
  }
});

test('unresolved head-A provenance is preserved when reply and resolution occur at head B', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const root = addThread(client);
  root.createdAt = '2026-08-04T23:59:59Z';
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: null, replyUrl: null,
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const first = workflow(state, client, { git });
  await first.api.replyResolve(2, 'task-thread');
  const record = first.state.current.threadResolutionStatus.threads[0];
  assert.equal(record.observedHeadSha, HEAD);
  assert.match(client.threadComments.get('THREAD_1').at(-1).body,
    new RegExp(`Aerstello review resolution at ${OTHER_HEAD}`, 'u'));

  const ready = { ...first.state.current, phase: 'ready-for-review', nextAction: 'Request review.' };
  const second = workflow(ready, client, { git });
  const requested = await second.api.request(2, 'discovery');
  client.reactions.set(requested.request.id, [{ id: 'REACTION_B', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  await second.api.collect(2);
  assert.equal((await second.api.complete(2)).completed, true);
  assert.equal(second.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('paired unresolved recorded reply is reused and resolved without posting another reply', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const operationId = `reply:2:THREAD_1:${OTHER_HEAD}`;
  const root = addThread(client, { replies: [{ id: 'REPLY_paired', databaseId: 902, url: 'https://x/paired',
    createdAt: AT, author: VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${OTHER_HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-B check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_paired', replyUrl: 'https://x/paired',
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(state, client, { git });
  await setup.api.replyResolve(2, 'task-thread');
  assert.equal(client.calls.some((call) => call.name === 'AddThreadReply'), false);
  assert.equal(client.calls.filter((call) => call.name === 'ResolveThread').length, 1);
  assert.equal(setup.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('paired unresolved reply from a prior head fails before journal or GitHub mutation', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const root = addThread(client, { replies: [{ id: 'REPLY_stale', databaseId: 903, url: 'https://x/stale',
    createdAt: AT, author: VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-A check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_stale', replyUrl: 'https://x/stale',
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(state, client, { git });
  await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), { code: 'THREAD_PROOF_STALE' });
  assert.equal(client.events.length, 0);
});
