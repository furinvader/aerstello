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

test('taskless thread refresh records guarded empty proof without GitHub mutation or threadless verification', async () => {
  const initial = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, { id: 'THREAD_noncanonical', root: rootComment('THREAD_noncanonical', { author: VIEWER }) });
  const setup = workflow(initial, client);
  const result = await setup.api.refreshThreads(2);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, proof('not-run').threadlessVerification);
  assert.equal(setup.state.current.phase, 'recovering');
  assert.deepEqual(setup.state.current.tasks, []);
  assert.equal(client.events.length, 0);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointTaskCompletion');

  const requestClient = new FakeClient();
  addThread(requestClient, { resolved: true });
  const requestState = {
    ...setup.state.current, phase: 'ready-for-review', nextAction: 'Request review.',
  };
  const requestSetup = workflow(requestState, requestClient);
  await assert.rejects(() => requestSetup.api.request(2, 'discovery'), { code: 'ROOT_IDENTITY_MISMATCH' });
  assert.equal(requestClient.events.length, 0);
});

test('taskless thread refresh restores empty proof after guarded clean-review HEAD drift', async () => {
  const initial = tasklessReviewHeadDriftState();
  const preserved = {
    reviewRequest: structuredClone(initial.reviewRequest),
    reviewOutcome: structuredClone(initial.reviewOutcome),
    reviewHistory: structuredClone(initial.reviewHistory),
    threadlessVerification: structuredClone(initial.threadResolutionStatus.threadlessVerification),
  };
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, {
    id: 'THREAD_noncanonical_1',
    root: rootComment('THREAD_noncanonical_1', { author: VIEWER }),
  });
  addThread(client, {
    id: 'THREAD_noncanonical_2',
    root: rootComment('THREAD_noncanonical_2', { author: VIEWER }),
  });
  const setup = workflow(initial, client);
  const result = await setup.api.refreshThreads(2);

  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(result.threadResolutionStatus.headSha, HEAD);
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, preserved.threadlessVerification);
  assert.equal(setup.state.current.phase, 'recovering');
  assert.deepEqual({
    reviewRequest: setup.state.current.reviewRequest,
    reviewOutcome: setup.state.current.reviewOutcome,
    reviewHistory: setup.state.current.reviewHistory,
    threadlessVerification: setup.state.current.threadResolutionStatus.threadlessVerification,
  }, preserved);
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 4);
  assert.equal(client.events.length, 0);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion']);
});

test('taskless thread refresh recovers exact stale pending evidence and preserves its request slot', async () => {
  const initial = tasklessPendingReviewHeadDriftState();
  const preserved = {
    reviewRequest: structuredClone(initial.reviewRequest),
    reviewOutcome: initial.reviewOutcome,
    reviewHistory: structuredClone(initial.reviewHistory),
  };
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, {
    id: 'THREAD_noncanonical_pending',
    root: rootComment('THREAD_noncanonical_pending', { author: VIEWER }),
  });
  const setup = workflow(initial, client);
  const result = await setup.api.refreshThreads(2);

  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(result.threadResolutionStatus.headSha, HEAD);
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual({
    reviewRequest: setup.state.current.reviewRequest,
    reviewOutcome: setup.state.current.reviewOutcome,
    reviewHistory: setup.state.current.reviewHistory,
  }, preserved);
  assert.equal(client.events.length, 0);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion']);
  assert.equal(setup.state.current.phase, 'ready-for-review');
  assert.equal(setup.state.current.nextAction, 'Request canonical verification review.');

  const firstRevision = setup.state.current.revision;
  const retry = await setup.api.refreshThreads(2);
  assert.equal(retry.stateRevision, firstRevision);
  assert.equal(setup.state.current.revision, firstRevision);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion']);
  assert.deepEqual(setup.state.current.reviewHistory, preserved.reviewHistory);

  const replacement = workflow(setup.state.current);
  const requested = await replacement.api.request(2);
  assert.equal(requested.request.kind, 'verification');
  assert.equal(replacement.state.current.reviewHistory.length, 5);
  assert.deepEqual(replacement.state.current.reviewHistory.slice(0, 4), preserved.reviewHistory);
  assert.equal(replacement.state.current.reviewHistory.at(-1).outcome, null);
  assert.deepEqual(replacement.client.events.slice(0, 2), [
    'intent:request', 'mutation:AddReviewRequest',
  ]);

  const finite = workflow(tasklessPendingReviewHeadDriftState({ reviewRequestLimit: 4 }));
  await finite.api.refreshThreads(2);
  assert.equal(finite.state.current.phase, 'ready-for-review');
  assert.match(finite.state.current.nextAction,
    /set-review-limit --pr 2 --expected-revision 2 --limit <higher-number> or --unlimited/u);
  const exhausted = workflow(finite.state.current);
  await assert.rejects(() => exhausted.api.request(2), { code: 'REQUEST_NOT_READY' });
  assert.equal(exhausted.client.events.length, 0);
  assert.equal(exhausted.state.calls.length, 0);
  assert.deepEqual(exhausted.state.current.reviewHistory, preserved.reviewHistory);
});

test('pure stale discovery drift keeps the null history row and uses the existing proof recovery', async () => {
  const initial = tasklessPendingDiscoveryHeadDriftState();
  const immutableHistory = structuredClone(initial.reviewHistory);
  const setup = workflow(initial, new FakeClient({ pageSize: 1 }));

  const before = await setup.api.status(2);
  assert.deepEqual(before.staleDiscoveryEvidence, {
    category: 'pure-head-drift', dispositionId: null, canonicalRootCount: 0,
  });
  const result = await setup.api.refreshThreads(2);
  assert.equal(result.staleDiscoveryDisposition, undefined);
  assert.equal(setup.state.current.phase, 'ready-for-review');
  assert.equal(setup.state.current.nextAction, 'Request canonical discovery review.');
  assert.deepEqual(setup.state.current.staleDiscoveryDispositions, []);
  assert.deepEqual(setup.state.current.reviewHistory, immutableHistory);
  assert.equal(setup.state.current.reviewOutcome, null);
  assert.equal(setup.state.current.reviewedHeadSha, null);
  assert.equal(setup.client.events.length, 0);
});

test('unique stale discovery clean evidence is dispositioned without rewriting history or mutating GitHub', async () => {
  const initial = tasklessPendingDiscoveryHeadDriftState();
  const immutableHistory = structuredClone(initial.reviewHistory);
  const client = new FakeClient({ pageSize: 1 });
  client.reviews.push(canonicalReview({ id: 'PRR_stale_clean', commit: { oid: OTHER_HEAD } }));
  const setup = workflow(initial, client);

  const before = await setup.api.status(2);
  assert.equal(before.staleDiscoveryEvidence.category, 'disposition-ready');
  assert.equal(before.staleDiscoveryEvidence.dispositionId, null);
  const result = await setup.api.refreshThreads(2);
  const disposition = result.staleDiscoveryDisposition;
  assert.match(disposition.dispositionId, /^[0-9a-f]{64}$/u);
  assert.equal(disposition.requestId, initial.reviewRequest.id);
  assert.equal(disposition.requestHeadSha, OTHER_HEAD);
  assert.equal(disposition.liveHeadSha, HEAD);
  assert.equal(disposition.evidence.id, 'PRR_stale_clean');
  assert.equal(disposition.evidence.outcome, 'clean');
  assert.match(disposition.responseFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(setup.state.current.phase, 'ready-for-review');
  assert.equal(setup.state.current.reviewOutcome, null);
  assert.equal(setup.state.current.reviewedHeadSha, null);
  assert.deepEqual(setup.state.current.reviewHistory, immutableHistory);
  assert.deepEqual(setup.state.current.staleDiscoveryDispositions, [disposition]);
  assert.equal(setup.state.current.threadResolutionStatus.status, 'passed');
  assert.equal(setup.state.current.threadResolutionStatus.headSha, HEAD);
  assert.equal(client.events.length, 0);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestReviews').length >= 2);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 2);

  const after = await setup.api.status(2);
  assert.equal(after.staleDiscoveryEvidence.category, 'dispositioned');
  assert.equal(after.staleDiscoveryEvidence.dispositionId, disposition.dispositionId);
  const dispositionRevision = setup.state.current.revision;
  const retry = await setup.api.refreshThreads(2);
  assert.equal(retry.stateRevision, dispositionRevision);
  assert.equal(setup.state.current.revision, dispositionRevision);
  assert.deepEqual(setup.state.calls.map((call) => call.name), [
    'checkpointTaskCompletion', 'checkpointTaskCompletion',
  ]);

  const replacement = await setup.api.request(2);
  assert.equal(replacement.request.kind, 'discovery');
  assert.equal(setup.state.current.reviewHistory.length, 2);
  assert.deepEqual(setup.state.current.reviewHistory[0], immutableHistory[0]);
  assert.equal(setup.state.current.reviewHistory[1].outcome, null);
});

test('stale discovery findings are dispositioned into ordinary triage and retry without mutation', async () => {
  const initial = tasklessPendingDiscoveryHeadDriftState();
  const immutableHistory = structuredClone(initial.reviewHistory);
  const client = new FakeClient({ pageSize: 1 });
  client.reviews.push(canonicalReview({
    id: 'PRR_review', body: 'Please address the inline finding.', commit: { oid: OTHER_HEAD },
  }));
  addThread(client, { root: rootComment() });
  const setup = workflow(initial, client);

  const before = await setup.api.status(2);
  assert.equal(before.staleDiscoveryEvidence.category, 'actionable-stale-findings');
  assert.equal(before.staleDiscoveryEvidence.dispositionId, null);
  assert.equal(before.staleDiscoveryEvidence.canonicalRootCount, 1);
  const result = await setup.api.refreshThreads(2);
  assert.equal(result.actionable, true);
  assert.equal(result.staleDiscoveryDisposition.evidence.outcome, 'findings');
  assert.equal(setup.state.current.phase, 'triaging');
  assert.equal(setup.state.current.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(setup.state.current.reviewHistory, immutableHistory);
  assert.equal(setup.state.current.reviewOutcome, null);
  assert.equal(setup.state.current.reviewedHeadSha, null);
  assert.equal(client.events.length, 0);

  const after = await setup.api.status(2);
  assert.equal(after.staleDiscoveryEvidence.category, 'actionable-stale-findings');
  assert.equal(after.staleDiscoveryEvidence.dispositionId,
    result.staleDiscoveryDisposition.dispositionId);
  const dispositionRevision = setup.state.current.revision;
  const retry = await setup.api.refreshThreads(2);
  assert.equal(retry.stateRevision, dispositionRevision);
  assert.equal(setup.state.current.revision, dispositionRevision);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion', 'checkpointTaskCompletion']);
  assert.equal(client.events.length, 0);

  const advancedState = {
    ...setup.state.current,
    phase: 'implementing',
    currentIntegrationHeadSha: ADVANCED_HEAD,
    git: { ...setup.state.current.git, headSha: ADVANCED_HEAD },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null,
      checks: [], updatedAt: null,
    },
    tasks: [{
      id: 'stale-root-task', sourceIds: ['thread:THREAD_1'], sourceType: 'github-thread',
      fingerprint: 'stale-root-task', summary: 'Resolve the stale review root.', severity: 'P1',
      disposition: 'actionable', status: 'proposed', integratedCommitSha: null,
      resolutionSummary: null,
      execution: {
        dependencies: [], ownedPaths: ['src/example.ts'], worker: 'review_fix_worker',
        branch: null, worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
      },
    }],
    nextAction: 'Continue ordinary remediation for the mapped stale root.',
  };
  const advancedClient = new FakeClient();
  advancedClient.metadata.headRefOid = ADVANCED_HEAD;
  advancedClient.reviews.push(structuredClone(client.reviews[0]));
  addThread(advancedClient, { root: rootComment() });
  const advancedStatus = await workflow(advancedState, advancedClient).api.status(2);
  assert.equal(advancedStatus.staleDiscoveryEvidence.category, 'actionable-stale-findings');
  assert.equal(advancedStatus.nextAction, advancedState.nextAction);
});

test('finite stale discovery recovery retains proof and blocks a replacement request', async () => {
  const initial = tasklessPendingDiscoveryHeadDriftState({ reviewRequestLimit: 1 });
  const client = new FakeClient();
  client.reviews.push(canonicalReview({ id: 'PRR_finite', commit: { oid: OTHER_HEAD } }));
  const setup = workflow(initial, client);
  await setup.api.refreshThreads(2);

  assert.equal(setup.state.current.phase, 'ready-for-review');
  assert.equal(setup.state.current.threadResolutionStatus.status, 'passed');
  assert.match(setup.state.current.nextAction,
    /limit 1 is exhausted after 1 durable requests; run npm run review:state -- set-review-limit --pr 2 --expected-revision 2 --limit <higher-number> or --unlimited/u);
  await assert.rejects(() => setup.api.request(2), { code: 'REQUEST_NOT_READY' });
  assert.equal(client.events.length, 0);
  assert.equal(setup.state.current.reviewHistory.length, 1);
  assert.equal(setup.state.current.reviewHistory[0].outcome, null);
});

test('taskless pending-review HEAD-drift refresh requires the exact immutable request anchor', async () => {
  for (const mutate of [
    (client) => { client.comments = []; },
    (client) => { client.comments[0] = { ...client.comments[0], body: '@codex review edited' }; },
    (client) => { client.comments[0] = { ...client.comments[0], author: BOT }; },
  ]) {
    const setup = workflow(tasklessPendingReviewHeadDriftState());
    mutate(setup.client);
    const result = await setup.api.refreshThreads(2);
    assert.equal(result.escalated, true);
    assert.equal(result.escalation.reason, 'request-head-drift');
    assert.equal(setup.state.current.phase, 'awaiting-human-decision');
    assert.equal(setup.client.events.length, 0);
    assert.deepEqual(setup.state.calls.map((call) => call.name), [
      'checkpointVerificationEscalation',
    ]);
  }
});

test('stale discovery disposition requires one exact immutable request anchor', async () => {
  for (const [label, mutate] of [
    ['missing', (client) => { client.comments = []; }],
    ['edited', (client) => { client.comments[0] = { ...client.comments[0], body: '@codex review edited' }; }],
    ['edit history', (client) => {
      client.comments[0] = { ...client.comments[0], lastEditedAt: '2026-08-05T00:00:01Z' };
    }],
    ['foreign', (client) => { client.comments[0] = { ...client.comments[0], author: BOT }; }],
    ['duplicated', (client) => { client.comments.push(structuredClone(client.comments[0])); }],
  ]) {
    const setup = workflow(tasklessPendingDiscoveryHeadDriftState());
    setup.client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }));
    mutate(setup.client);
    await assert.rejects(() => setup.api.refreshThreads(2), { code: 'REQUEST_PROOF_STALE' }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(setup.client.events.length, 0, label);
  }
});

test('multiple, conflicting, and unsupported stale discovery responses remain human-gated', async () => {
  const cases = [
    ['multiple reviews', (client) => client.reviews.push(
      canonicalReview({ id: 'PRR_one', commit: { oid: OTHER_HEAD } }),
      canonicalReview({ id: 'PRR_two', commit: { oid: OTHER_HEAD } }),
    )],
    ['current-head review', (client) => client.reviews.push(canonicalReview({ commit: { oid: HEAD } }))],
    ['unsupported review state', (client) => client.reviews.push(canonicalReview({
      state: 'APPROVED', commit: { oid: OTHER_HEAD },
    }))],
    ['review and reaction', (client, requestId) => {
      client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }));
      client.reactions.set(requestId, [{
        id: 'REACTION_conflict', content: 'THUMBS_UP', createdAt: AT, user: BOT,
      }]);
    }],
    ['unmatched canonical root', (client) => addThread(client)],
    ['unsupported structural marker', (client) => client.comments.push(cleanIssueComment())],
  ];
  for (const [label, prepare] of cases) {
    const initial = tasklessPendingDiscoveryHeadDriftState();
    const client = new FakeClient();
    prepare(client, initial.reviewRequest.id);
    const setup = workflow(initial, client);
    const status = await setup.api.status(2);
    assert.equal(status.staleDiscoveryEvidence.category, 'ambiguous-human-decision', label);
    await assert.rejects(() => setup.api.refreshThreads(2), {
      code: 'DISCOVERY_COLLECTION_UNRESOLVED',
    }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('status human-gates same-head, migrated, task-bearing, unvalidated, and dirty recovery states', async () => {
  const sameHead = pendingState('discovery');
  const sameHeadStatus = await workflow(sameHead).api.status(2);
  assert.equal(sameHeadStatus.staleDiscoveryEvidence.category, 'not-applicable');
  await assert.rejects(() => workflow(sameHead).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const task = {
    id: 'existing-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'existing-task',
    summary: 'Already present.', severity: 'P1', disposition: 'actionable', status: 'completed',
    integratedCommitSha: HEAD, resolutionSummary: 'Completed.',
  };
  const states = [
    tasklessPendingDiscoveryHeadDriftState({
      legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 1, migratedAt: AT },
      reviewRound: 2,
    }),
    tasklessPendingDiscoveryHeadDriftState({ tasks: [task] }),
    tasklessPendingDiscoveryHeadDriftState({ validationStatus: stateFixture().validationStatus }),
  ];
  for (const state of states) {
    const client = new FakeClient();
    client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }));
    const setup = workflow(state, client);
    const status = await setup.api.status(2);
    assert.equal(status.staleDiscoveryEvidence.category, 'ambiguous-human-decision');
    await assert.rejects(() => setup.api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });
    assert.equal(setup.state.calls.length, 0);
  }

  const dirtyClient = new FakeClient();
  dirtyClient.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }));
  const dirty = workflow(tasklessPendingDiscoveryHeadDriftState(), dirtyClient, {
    git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
  });
  const dirtyStatus = await dirty.api.status(2);
  assert.equal(dirtyStatus.staleDiscoveryEvidence.category, 'ambiguous-human-decision');
  await assert.rejects(() => dirty.api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  assert.equal(dirty.state.calls.length, 0);
});

test('stale discovery evidence, root, head, and revision races fail before checkpoint', async () => {
  class SecondSnapshotRaceClient extends FakeClient {
    constructor(mutate) {
      super();
      this.metadataReads = 0;
      this.mutateSecondSnapshot = mutate;
    }

    async graphql(input) {
      if (input.name === 'PullRequestMetadata') {
        this.metadataReads += 1;
        if (this.metadataReads === 2) this.mutateSecondSnapshot(this);
      }
      return super.graphql(input);
    }
  }

  for (const [label, prepare, mutate, code] of [
    ['evidence',
      (client) => client.reviews.push(canonicalReview({
        body: 'Initial finding.', commit: { oid: OTHER_HEAD },
      })),
      (client) => { client.reviews[0] = { ...client.reviews[0], body: 'Changed response.' }; },
      'STALE_DISCOVERY_EVIDENCE_CHANGED'],
    ['root',
      (client) => {
        client.reviews.push(canonicalReview({ id: 'PRR_review', body: 'Finding.', commit: { oid: OTHER_HEAD } }));
        addThread(client);
      },
      (client) => { client.threads[0] = { ...client.threads[0], isResolved: true }; },
      'STALE_DISCOVERY_EVIDENCE_CHANGED'],
    ['root body',
      (client) => {
        client.reviews.push(canonicalReview({ id: 'PRR_review', commit: { oid: OTHER_HEAD } }));
        addThread(client);
      },
      (client) => {
        const comments = client.threadComments.get('THREAD_1');
        comments[0] = { ...comments[0], body: 'Edited canonical finding.' };
      },
      'STALE_DISCOVERY_EVIDENCE_CHANGED'],
    ['head',
      (client) => client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } })),
      (client) => { client.metadata.headRefOid = OTHER_HEAD; },
      'MUTATION_NOT_READY'],
    ['closed',
      (client) => client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } })),
      (client) => { client.metadata.state = 'CLOSED'; },
      'PR_NOT_OPEN'],
    ['draft',
      (client) => client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } })),
      (client) => { client.metadata.isDraft = true; },
      'PR_DRAFT'],
  ]) {
    const client = new SecondSnapshotRaceClient(mutate);
    prepare(client);
    const setup = workflow(tasklessPendingDiscoveryHeadDriftState(), client);
    await assert.rejects(() => setup.api.refreshThreads(2), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }

  const initial = tasklessPendingDiscoveryHeadDriftState();
  const client = new FakeClient();
  client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }));
  client.comments.push({
    id: initial.reviewRequest.id, databaseId: initial.reviewRequest.databaseId,
    url: initial.reviewRequest.url, body: initial.reviewRequest.body,
    createdAt: initial.reviewRequest.at, lastEditedAt: null,
    author: { ...VIEWER, login: initial.reviewRequest.authorLogin, id: initial.reviewRequest.authorNodeId },
  });
  const state = fakeState(initial);
  const originalLoad = state.load.bind(state);
  let loads = 0;
  state.load = async () => {
    const loaded = await originalLoad();
    loads += 1;
    return loads > 1 ? { ...loaded, revision: loaded.revision + 1 } : loaded;
  };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client, state, git: fakeGit(), clock: { now: () => AT }, journal: fakeJournal(client.events),
  }).refreshThreads(2), { code: 'STATE_REVISION_CHANGED' });
  assert.equal(state.calls.length, 0);
  assert.equal(client.events.length, 0);

  const retryClient = new FakeClient();
  retryClient.reviews.push(canonicalReview({ id: 'PRR_retry_race', commit: { oid: OTHER_HEAD } }));
  const retrySetup = workflow(tasklessPendingDiscoveryHeadDriftState(), retryClient);
  await retrySetup.api.refreshThreads(2);
  const checkpoint = retrySetup.state.checkpointTaskCompletion.bind(retrySetup.state);
  retrySetup.state.checkpointTaskCompletion = async (input) => {
    retrySetup.state.advanceRevisionForTest();
    return checkpoint(input);
  };
  await assert.rejects(() => retrySetup.api.refreshThreads(2), {
    code: 'STATE_REVISION_CONFLICT',
  });
  assert.equal(retryClient.events.length, 0);
});

test('an immutable stale discovery disposition is never heuristically repaired from changed live evidence', async () => {
  const client = new FakeClient();
  client.reviews.push(canonicalReview({
    id: 'PRR_immutable', body: 'Original threadless finding.', commit: { oid: OTHER_HEAD },
  }));
  const setup = workflow(tasklessPendingDiscoveryHeadDriftState(), client);
  await setup.api.refreshThreads(2);
  const immutableDisposition = structuredClone(setup.state.current.staleDiscoveryDispositions[0]);
  client.reviews[0] = { ...client.reviews[0], body: 'Edited threadless finding.' };

  const status = await setup.api.status(2);
  assert.equal(status.staleDiscoveryEvidence.category, 'ambiguous-human-decision');
  await assert.rejects(() => setup.api.refreshThreads(2), {
    code: 'STALE_DISCOVERY_EVIDENCE_CHANGED',
  });
  assert.deepEqual(setup.state.current.staleDiscoveryDispositions, [immutableDisposition]);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion']);
  assert.equal(client.events.length, 0);

  const rootClient = new FakeClient();
  rootClient.reviews.push(canonicalReview({ id: 'PRR_review', commit: { oid: OTHER_HEAD } }));
  addThread(rootClient);
  const rooted = workflow(tasklessPendingDiscoveryHeadDriftState(), rootClient);
  await rooted.api.refreshThreads(2);
  const immutableRootDisposition = structuredClone(rooted.state.current.staleDiscoveryDispositions[0]);
  const rootComments = rootClient.threadComments.get('THREAD_1');
  rootComments[0] = { ...rootComments[0], body: 'Edited canonical root finding.' };
  const rootedStatus = await rooted.api.status(2);
  assert.equal(rootedStatus.staleDiscoveryEvidence.category, 'ambiguous-human-decision');
  await assert.rejects(() => rooted.api.refreshThreads(2), {
    code: 'STALE_DISCOVERY_EVIDENCE_CHANGED',
  });
  assert.deepEqual(rooted.state.current.staleDiscoveryDispositions, [immutableRootDisposition]);
  assert.equal(rootClient.events.length, 0);
});

test('taskless pending-review HEAD-drift refresh escalates canonical outcome evidence', async () => {
  for (const [label, prepare] of [
    ['stale exact review', (client) => client.reviews.push(canonicalReview({ commit: { oid: OTHER_HEAD } }))],
    ['foreign-head review', (client) => client.reviews.push(canonicalReview({ commit: { oid: HEAD } }))],
    ['canonical request reaction', (client) => client.reactions.set('IC_verification_4', [{
      id: 'REACTION_1', content: 'THUMBS_UP', createdAt: AT, user: BOT,
    }])],
    ['canonical review root', (client) => addThread(client)],
  ]) {
    const client = new FakeClient();
    prepare(client);
    const setup = workflow(tasklessPendingReviewHeadDriftState(), client);
    const result = await setup.api.refreshThreads(2);
    assert.equal(result.escalated, true, label);
    assert.equal(result.escalation.reason, 'request-head-drift', label);
    assert.equal(setup.state.current.phase, 'awaiting-human-decision', label);
    assert.equal(client.events.length, 0, label);
    assert.deepEqual(setup.state.calls.map((call) => call.name), [
      'checkpointVerificationEscalation',
    ], label);
  }
});

test('taskless clean-review HEAD-drift refresh fails closed at lifecycle and live-proof boundaries', async () => {
  await assert.rejects(() => workflow(tasklessPendingReviewHeadDriftState({
    validationStatus: stateFixture().validationStatus,
  })).api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });
  await assert.rejects(() => workflow(tasklessPendingReviewHeadDriftState({
    reviewedHeadSha: OTHER_HEAD,
  })).api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });
  await assert.rejects(() => workflow(tasklessPendingReviewHeadDriftState({
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 0, migratedAt: AT },
  })).api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });

  const unvalidated = tasklessReviewHeadDriftState({
    validationStatus: stateFixture().validationStatus,
  });
  await assert.rejects(() => workflow(unvalidated).api.refreshThreads(2), { code: 'TASK_NOT_READY' });

  const taskBearing = tasklessReviewHeadDriftState({
    tasks: [{
      id: 'unexpected-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'unexpected-task',
      summary: 'Unexpected task.', severity: 'P2', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Completed.',
    }],
  });
  await assert.rejects(() => workflow(taskBearing).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });
  await assert.rejects(() => workflow(tasklessReviewHeadDriftState({
    blockedReasons: ['Operator decision remains.'],
  })).api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });

  const sameHead = completedState({
    phase: 'recovering',
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Same-HEAD replacement is not recovery.',
  });
  await assert.rejects(() => workflow(sameHead).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const findings = tasklessReviewHeadDriftState();
  findings.reviewOutcome = { ...findings.reviewOutcome, outcome: 'findings' };
  findings.reviewHistory = [{ request: findings.reviewRequest, outcome: findings.reviewOutcome }];
  await assert.rejects(() => workflow(findings).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const migrated = tasklessReviewHeadDriftState({
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 0, migratedAt: AT },
  });
  await assert.rejects(() => workflow(migrated).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const exhaustedHistory = [
    cleanReviewEntry(1, 'discovery'),
    cleanReviewEntry(2, 'discovery'),
    cleanReviewEntry(3, 'discovery'),
    cleanReviewEntry(4, 'verification'),
  ];
  const exhaustedLatest = exhaustedHistory.at(-1);
  const exhausted = tasklessReviewHeadDriftState({
    requestedHeadSha: OTHER_HEAD,
    reviewedHeadSha: OTHER_HEAD,
    reviewRound: 3,
    verificationReviewUsed: true,
    reviewRequest: exhaustedLatest.request,
    reviewOutcome: exhaustedLatest.outcome,
    reviewHistory: exhaustedHistory,
    reviewRequestLimit: 4,
  });
  await assert.rejects(() => workflow(exhausted).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const inconsistent = tasklessReviewHeadDriftState();
  inconsistent.reviewHistory = [{
    request: inconsistent.reviewRequest,
    outcome: { ...inconsistent.reviewOutcome, id: 'PRR_inconsistent' },
  }];
  await assert.rejects(() => workflow(inconsistent).api.refreshThreads(2), { code: 'INVALID_STATE' });

  const rootedClient = new FakeClient();
  addThread(rootedClient);
  await assert.rejects(() => workflow(tasklessReviewHeadDriftState(), rootedClient).api.refreshThreads(2), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
  assert.equal(rootedClient.events.length, 0);

  for (const git of [
    fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }) }),
    fakeGit({ pushedHead: async () => OTHER_HEAD }),
  ]) {
    await assert.rejects(() => workflow(tasklessReviewHeadDriftState(), new FakeClient(), { git })
      .api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  }

  const raced = fakeState(tasklessReviewHeadDriftState());
  const originalLoad = raced.load.bind(raced);
  let reads = 0;
  raced.load = async () => {
    const state = await originalLoad();
    reads += 1;
    return reads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: raced, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'STATE_REVISION_CHANGED' });

  class DriftingRecoveryRefreshClient extends FakeClient {
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestThreads') this.metadata.headRefOid = OTHER_HEAD;
      return result;
    }
  }
  const drifted = workflow(tasklessReviewHeadDriftState(), new DriftingRecoveryRefreshClient());
  await assert.rejects(() => drifted.api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  assert.equal(drifted.state.calls.some((call) => call.name === 'checkpointTaskCompletion'), false);
});

test('taskless thread refresh fails closed across task, root, validation, Git, adapter, and state-race boundaries', async () => {
  const validated = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  await assert.rejects(() => workflow(stateFixture()).api.refreshThreads(2), { code: 'TASK_NOT_READY' });
  await assert.rejects(() => workflow({
    ...validated,
    tasks: [{
      id: 'durable-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'durable-task',
      summary: 'Durable task.', severity: 'P2', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Completed.',
    }],
  }).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });
  for (const resolved of [false, true]) {
    const client = new FakeClient();
    addThread(client, { resolved });
    await assert.rejects(() => workflow(validated, client).api.refreshThreads(2), {
      code: 'ROOT_IDENTITY_MISMATCH',
    });
    assert.equal(client.events.length, 0);
  }
  const duplicate = new FakeClient();
  duplicate.threads = [{ id: 'THREAD_duplicate', isResolved: false }, { id: 'THREAD_duplicate', isResolved: false }];
  duplicate.threadComments.set('THREAD_duplicate', [rootComment('THREAD_duplicate', { author: VIEWER })]);
  await assert.rejects(() => workflow(validated, duplicate).api.refreshThreads(2), {
    code: 'ROOT_IDENTITY_AMBIGUOUS',
  });
  await assert.rejects(() => workflow(validated, new FakeClient(), {
    git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
  }).api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  const withoutCheckpoint = { async load() { return structuredClone(validated); } };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: withoutCheckpoint, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'INVALID_ADAPTERS' });
  const raced = fakeState(validated);
  const originalLoad = raced.load.bind(raced);
  let reads = 0;
  raced.load = async () => {
    const state = await originalLoad();
    reads += 1;
    return reads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: raced, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'STATE_REVISION_CHANGED' });

  class DriftingRefreshClient extends FakeClient {
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestThreads') this.metadata.headRefOid = OTHER_HEAD;
      return result;
    }
  }
  const drifted = workflow(validated, new DriftingRefreshClient());
  await assert.rejects(() => drifted.api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  assert.equal(drifted.state.calls.some((call) => call.name === 'checkpointTaskCompletion'), false);
});

test('taskless thread refresh rejects every prior-review lifecycle while allowing pristine repetition', async () => {
  const validated = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  const priorPending = pendingState('discovery', { validationStatus: validated.validationStatus });
  const priorCompleted = completedState({
    phase: 'recovering',
    validationStatus: validated.validationStatus,
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Recover prior review evidence.',
  });
  for (const [label, state] of [
    ['non-recovering phase', { ...validated, phase: 'validating' }],
    ['pending discovery provenance', priorPending],
    ['completed review provenance', priorCompleted],
  ]) {
    await assert.rejects(() => workflow(state).api.refreshThreads(2), {
      code: 'TASKLESS_REFRESH_NOT_ALLOWED',
    }, label);
  }

  const setup = workflow(validated);
  await setup.api.refreshThreads(2);
  const firstRevision = setup.state.current.revision;
  await setup.api.refreshThreads(2);
  assert.equal(setup.state.current.revision, firstRevision + 1);
  assert.equal(setup.state.current.reviewRound, 0);
  assert.deepEqual(setup.state.current.reviewHistory, []);
});
