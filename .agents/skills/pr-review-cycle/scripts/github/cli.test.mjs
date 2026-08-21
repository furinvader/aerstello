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

test('CLI returns stable uncertainty for an already-dispatched request without replay', async () => {
  const client = new FakeClient();
  const state = fakeState(readyState());
  const operationId = `request:2:discovery:1:${HEAD}`;
  const intent = priorIntent('request', operationId);
  const journal = fakeJournal(client.events, [intent]);
  await journal.claimDispatch(intent);
  const expected = { requested: false, recovered: false, waiting: true,
    pullRequestReadiness: 'already-ready', nextAction: 'Wait, then rerun npm run review:github -- request --pr 2.' };
  const first = await runCli(['request', '--pr', '2'], { client, state, git: fakeGit(), clock: { now: () => AT }, journal });
  assert.deepEqual(first, expected);
  const retry = await runCli(['request', '--pr', '2'], { client, state, git: fakeGit(), clock: { now: () => AT }, journal });
  assert.deepEqual(retry, expected);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(state.calls.length, 0);
});

test('CLI rejects ambiguous or invalid task selections before external reads', async () => {
  const cases = [
    ['missing selection', ['verify-resolve', '--pr', '2'], /exactly one/u],
    ['both selections', [
      'verify-resolve', '--pr', '2', '--task', 'a', '--task-set-json', '["a"]',
    ], /exactly one/u],
    ['repeated task', [
      'verify-resolve', '--pr', '2', '--task=a', '--task=b',
    ], /--task may be specified only once/u],
    ['repeated task set', [
      'verify-resolve', '--pr', '2', '--task-set-json=["a"]', '--task-set-json=["b"]',
    ], /--task-set-json may be specified only once/u],
    ['task set for reply', [
      'reply-resolve', '--pr', '2', '--task-set-json', '["a"]',
    ], /only valid for verify-resolve/u],
    ['task set for unrelated command', [
      'refresh-threads', '--pr', '2', '--task-set-json', '["a"]',
    ], /only valid for verify-resolve/u],
    ['empty singleton', [
      'verify-resolve', '--pr', '2', '--task=',
    ], /--task must not be empty/u],
    ['malformed JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a"',
    ], /valid JSON/u],
    ['string JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '"a"',
    ], /nonempty array/u],
    ['object JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '{"task":"a"}',
    ], /nonempty array/u],
    ['null JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', 'null',
    ], /nonempty array/u],
    ['empty JSON array', [
      'verify-resolve', '--pr', '2', '--task-set-json', '[]',
    ], /nonempty array/u],
    ['non-string JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a",1]',
    ], /unique nonempty strings/u],
    ['empty JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a",""]',
    ], /unique nonempty strings/u],
    ['duplicate JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a","a"]',
    ], /unique nonempty strings/u],
  ];

  for (const [label, argv, pattern] of cases) {
    let stateReads = 0;
    let journalReads = 0;
    const state = {
      async load() {
        stateReads += 1;
        throw new Error('invalid CLI input must not load state');
      },
    };
    const journal = {
      async lookupIntent() { journalReads += 1; },
      async ensureIntent() { journalReads += 1; },
    };
    const client = new FakeClient();
    await assert.rejects(() => runCli(argv, {
      client, state, git: fakeGit(), clock: { now: () => AT }, journal,
    }), pattern, label);
    assert.equal(stateReads, 0, label);
    assert.equal(journalReads, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('CLI keeps opaque singleton IDs distinct from explicit JSON task sets', async () => {
  const ambiguousSingleton = integratedNonThreadState('local', 'a,b');
  ambiguousSingleton.tasks[0].fingerprint = 'fp-comma';
  ambiguousSingleton.tasks.push(
    { ...ambiguousSingleton.tasks[0], id: 'a', fingerprint: 'fp-task-a' },
    { ...ambiguousSingleton.tasks[0], id: 'b', fingerprint: 'fp-task-b' },
  );
  const singletonState = fakeState(ambiguousSingleton);
  const singleton = await runCli([
    'verify-resolve', '--pr', '2', '--task', 'a,b',
  ], {
    client: new FakeClient(), state: singletonState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(singleton.taskId, 'a,b');
  assert.deepEqual(singletonState.current.tasks.map((task) => task.status), [
    'completed', 'integrated', 'integrated',
  ]);

  const opaqueId = '  a,b "quoted" \\path  ';
  const opaqueStateValue = integratedNonThreadState('local', opaqueId);
  opaqueStateValue.tasks[0].fingerprint = 'fp-opaque';
  const opaqueState = fakeState(opaqueStateValue);
  const opaque = await runCli([
    'verify-resolve', '--pr', '2', '--task', opaqueId,
  ], {
    client: new FakeClient(), state: opaqueState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(opaque.taskId, opaqueId);
  assert.equal(opaqueState.current.tasks[0].id, opaqueId);
  assert.equal(opaqueState.current.tasks[0].status, 'completed');

  const setStateValue = completedThreadlessDriftState(['a', 'b']);
  setStateValue.tasks[0].fingerprint = 'fp-set-task-a';
  setStateValue.tasks[1].fingerprint = 'fp-set-task-b';
  setStateValue.tasks.push({
    ...integratedNonThreadState('local', 'a,b').tasks[0],
    fingerprint: 'fp-comma-local', integratedCommitSha: HEAD,
  });
  const setState = fakeState(setStateValue);
  const setClient = new FakeClient();
  setClient.metadata.headRefOid = OTHER_HEAD;
  const selectedSet = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', '["b","a"]',
  ], {
    client: setClient,
    state: setState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(selectedSet.taskIds, ['a', 'b']);
  assert.equal(setState.current.tasks.find((task) => task.id === 'a,b').status, 'integrated');

  const specialIds = [' leading ', 'trailing ', 'a,b', '"quoted"', '\\path'];
  const specialStateValue = completedThreadlessDriftState(specialIds);
  specialStateValue.tasks.forEach((task, index) => {
    task.fingerprint = `fp-special-${index}`;
  });
  const specialState = fakeState(specialStateValue);
  const specialClient = new FakeClient();
  specialClient.metadata.headRefOid = OTHER_HEAD;
  const special = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', JSON.stringify([...specialIds].reverse()),
  ], {
    client: specialClient,
    state: specialState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(special.taskIds, [...specialIds].sort());
  assert.deepEqual(
    specialState.current.threadResolutionStatus.threadlessVerification.taskIds,
    [...specialIds].sort(),
  );

  const replyId = ' thread,with "quotes" and \\slashes ';
  const replyStateValue = integratedThreadState();
  replyStateValue.tasks[0] = {
    ...replyStateValue.tasks[0], id: replyId, fingerprint: 'fp-opaque-reply',
  };
  const replyState = fakeState(replyStateValue);
  const replyClient = new FakeClient();
  addThread(replyClient);
  const reply = await runCli([
    'reply-resolve', '--pr', '2', '--task', replyId,
  ], {
    client: replyClient, state: replyState, git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal(),
  });
  assert.equal(reply.taskId, replyId);
  assert.equal(replyState.current.tasks[0].status, 'completed');
});

test('CLI exposes exactly the documented explicit-PR command surface and JSON-ready results', async () => {
  assert.match(usage(), /status[\s\S]*refresh-threads[\s\S]*reply-resolve[\s\S]*verify-resolve[\s\S]*request[\s\S]*collect[\s\S]*collect-ci[\s\S]*complete/u);
  assert.match(usage(), /Local task verification persists exact-current-HEAD proof[\s\S]*re-attest/u);
  assert.match(usage(), /Request may return waiting[\s\S]*retry it/u);
  await assert.rejects(() => runCli(['collect'], {}), /--pr/u);
  await assert.rejects(() => runCli(['advance'], {}), /--pr/u);
  await assert.rejects(() => runCli(['advance', '--pr', '2', '--human'], {}), /--human is only valid/u);
  await assert.rejects(() => runCli(['advance', '--pr', '2', '--kind', 'discovery'], {}), /--kind is only valid/u);
  await assert.rejects(() => runCli(['advance', '--pr', '2', '--task', 'x'], {}), /--task is only valid/u);
  await assert.rejects(() => runCli(['advance', '--pr', '2', '--task-set-json', '["x"]'], {}), /--task-set-json is only valid/u);
  assert.match(usage(), /status \[--human\][\s\S]*advance --pr <number>[\s\S]*refresh-threads[\s\S]*reply-resolve[\s\S]*verify-resolve[\s\S]*request[\s\S]*collect[\s\S]*collect-ci[\s\S]*complete/u);
  await assert.rejects(() => runCli(['refresh-threads'], {}), /--pr/u);
  await assert.rejects(() => runCli(['verify-resolve', '--pr', '2'], {}), /exactly one/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--task', 'x'], {}), /--task is only valid/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--kind', 'discovery'], {}), /--kind is only valid/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--human'], {}), /--human is only valid/u);
  await assert.rejects(() => runCli(['unknown', '--pr', '2'], {}), /Unknown command/u);
  await assert.rejects(() => runCli(['request', '--pr', '2', '--kind', 'other'], {}), /discovery or verification/u);
  const requested = await runCli(['request', '--pr', '2'], {
    client: new FakeClient(), state: fakeState(readyState()), git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal(),
  });
  assert.equal(requested.request.kind, 'discovery');
  const client = new FakeClient();
  const state = fakeState(stateFixture());
  const result = await runCli(['status', '--pr', '2'], {
    client, state, git: fakeGit(), clock: { now: () => AT }, journal: fakeJournal(),
  });
  const waitingClient = new FakeClient();
  const waitingState = fakeState(stateFixture());
  const waiting = await runCli(['advance', '--pr', '2'], {
    client: waitingClient, state: waitingState, git: fakeGit(),
  });
  assert.deepEqual(Object.keys(waiting).sort(), [
    'nextAction', 'performedTransitions', 'phase', 'revision', 'terminal', 'waiting',
  ]);
  assert.deepEqual(waiting.performedTransitions, []);
  assert.equal(waiting.terminal, 'waiting');
  assert.equal(waitingClient.events.length, 0);
  assert.equal(waitingState.calls.length, 0);
  assert.equal(result.prNumber, 2);
  const taskless = fakeState(stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  }));
  const refreshed = await runCli(['refresh-threads', '--pr', '2'], {
    client: new FakeClient(), state: taskless, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(refreshed.threadResolutionStatus.status, 'passed');
  const verifiedState = fakeState(integratedNonThreadState());
  const verified = await runCli(['verify-resolve', '--pr', '2', '--task', 'task-local'], {
    client: new FakeClient(), state: verifiedState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(verified.taskId, 'task-local');
  assert.equal(verifiedState.current.tasks[0].status, 'completed');
  const threadlessSetState = fakeState(completedThreadlessDriftState([
    'threadless-a', 'threadless-b',
  ]));
  const threadlessSetClient = new FakeClient();
  threadlessSetClient.metadata.headRefOid = OTHER_HEAD;
  const threadlessSet = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', '["threadless-b","threadless-a"]',
  ], {
    client: threadlessSetClient,
    state: threadlessSetState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(threadlessSet.taskIds, ['threadless-a', 'threadless-b']);
  assert.equal(threadlessSetState.current.revision, completedThreadlessDriftState().revision + 1);
  assert.equal(threadlessSetClient.events.length, 0);
  const human = await runCli(['status', '--human'], {
    client, state, git: fakeGit(), clock: { now: () => AT },
  });
  assert.match(human.human, /PR: #2[\s\S]*PR readiness: OPEN[\s\S]*Live review observation: Not Applicable[\s\S]*Current commit:[\s\S]*Codex review:[\s\S]*Tasks:[\s\S]*Specialist reviews: Missing[\s\S]*Full CI: Passed[\s\S]*Open Codex threads: 0[\s\S]*Next action:/u);
  assert.match(renderHumanStatus({
    ...result,
    specialistReviews: {
      status: 'pending', requiredReviewerIds: ['security_reviewer'], recordedReviewerIds: [],
    },
  }), /Specialist reviews: Pending \(required: security_reviewer\)/u);
  const done = renderHumanStatus({ ...result, statePhase: 'complete', taskStatus: {
    resolved: 1, pending: 0, display: 'Done',
    items: [{ id: 'finding-a', summary: 'Preserve exact SHA evidence.', status: 'Done' }],
  } });
  assert.match(done, /Phase: Done[\s\S]*Tasks: Done[\s\S]*finding-a: Done — Preserve exact SHA evidence\./u);

  const stale = renderHumanStatus({
    ...result,
    statePhase: 'complete',
    liveHeadSha: OTHER_HEAD,
    codexReview: 'clean',
    targetedValidation: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    nextAction: 'Archive the completed cycle.',
    taskStatus: {
      resolved: 1, pending: 0, display: 'Done',
      items: [{ id: 'finding-a', summary: 'Preserve exact SHA evidence.', status: 'Done' }],
    },
  });
  assert.match(stale, new RegExp(`Current commit: ${HEAD} \\(DOES NOT MATCH PR head ${OTHER_HEAD}\\)`, 'u'));
  assert.match(stale, /Phase: Stale \(recorded Done; PR head changed\)/u);
  assert.match(stale, /Codex review: Stale clean evidence \(commit mismatch\)/u);
  assert.doesNotMatch(stale, /Phase: Done|Codex review: Clean|Tasks: Done/u);
  assert.match(stale, /Targeted local tests: Passed .* for the recorded commit; PR head differs/u);
  assert.match(stale, /Full CI: Passed .*live PR head differs from the recorded commit/u);
  assert.match(stale, new RegExp(`Next action: Reconcile recorded commit with live PR head ${OTHER_HEAD}`, 'u'));
});
