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

test('request promotes a ready draft once and recovers a lost ready mutation response', async () => {
  const client = new FakeClient({ throwAfterMutation: new Set(['MarkPullRequestReadyForReview']) });
  client.metadata.isDraft = true;
  const setup = workflow(readyState(), client);
  const recoveredInline = await setup.api.request(2);
  assert.equal(recoveredInline.pullRequestReadiness, 'recovered-ready');
  assert.equal(client.events.filter((event) => event === 'intent:ready').length, 1);
  assert.equal(client.calls.find((call) => call.name === 'MarkPullRequestReadyForReview').variables.pullRequestId, 'PR_node');
  assert.equal(client.metadata.isDraft, false);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(client.events.filter((event) => event === 'intent:ready').length, 1);
});

test('request reports already-ready and marked-ready while a non-owner draft waits without mutating', async () => {
  const already = workflow(readyState());
  const alreadyResult = await already.api.request(2);
  assert.equal(alreadyResult.pullRequestReadiness, 'already-ready');
  assert.equal(already.client.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);

  const promotedClient = new FakeClient();
  promotedClient.metadata.isDraft = true;
  const promoted = workflow(readyState(), promotedClient);
  const promotedResult = await promoted.api.request(2);
  assert.equal(promotedResult.pullRequestReadiness, 'marked-ready');
  assert.equal(promotedClient.calls.filter((call) => call.name === 'MarkPullRequestReadyForReview').length, 1);

  const concurrentClient = new FakeClient();
  concurrentClient.metadata.isDraft = true;
  const readyOperation = `ready:2:${concurrentClient.metadata.id}:${HEAD}`;
  const concurrent = workflow(readyState(), concurrentClient, {
    journal: fakeJournal([], [priorIntent('ready', readyOperation)]),
  });
  const replayed = await concurrent.api.request(2);
  assert.equal(replayed.pullRequestReadiness, 'recovered-ready');
  assert.equal(concurrentClient.calls.filter((call) => call.name === 'MarkPullRequestReadyForReview').length, 1);
});

test('overlapping shared-state requests converge on one durable request without another comment', async () => {
  const client = new FakeClient();
  const state = fakeState(readyState());
  const journal = fakeJournal(client.events);
  const adapters = { client, state, git: fakeGit(), clock: { now: () => AT }, journal };
  const owner = createGitHubReviewWorkflow(adapters);
  const retry = createGitHubReviewWorkflow(adapters);
  const [first, second] = await Promise.all([owner.request(2), retry.request(2)]);
  const waiting = [first, second].find((result) => result.waiting === true);
  const completed = [first, second].find((result) => result.requested === true);
  const recovered = waiting ? await retry.request(2) : completed;
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.request, state.current.reviewRequest);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(client.comments.filter((comment) => comment.body === '@codex review').length, 1);
  assert.equal(state.current.reviewHistory.length, 1);
});

test('staggered request retry waits for a journaled owner mutation then recovers its exact request', async () => {
  let releaseMutation;
  let enteredMutation;
  const released = new Promise((resolve) => { releaseMutation = resolve; });
  const entered = new Promise((resolve) => { enteredMutation = resolve; });
  class DeferredRequestClient extends FakeClient {
    async graphql(input) {
      if (input.name === 'AddReviewRequest') {
        enteredMutation();
        await released;
      }
      return super.graphql(input);
    }
  }
  const client = new DeferredRequestClient();
  const state = fakeState(readyState());
  const journal = fakeJournal(client.events);
  const adapters = { client, state, git: fakeGit(), clock: { now: () => AT }, journal };
  const owner = createGitHubReviewWorkflow(adapters);
  const retry = createGitHubReviewWorkflow(adapters);
  const ownerPromise = owner.request(2);
  await entered;
  const waiting = await retry.request(2);
  assert.equal(waiting.waiting, true);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 0);
  releaseMutation();
  const requested = await ownerPromise;
  const recovered = await retry.request(2);
  assert.deepEqual(recovered.request, requested.request);
  assert.equal(recovered.recovered, true);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(client.comments.filter((comment) => comment.body === '@codex review').length, 1);
  assert.equal(state.current.reviewHistory.length, 1);
});

test('real request-owner lock serializes a deferred shared request mutation', async () => {
  const cwd = createRepository();
  let release; let entered; let ownerPromise;
  const released = new Promise((resolve) => { release = resolve; });
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  class DeferredClient extends FakeClient {
    async graphql(input) {
      if (input.name === 'AddReviewRequest') { entered(); await released; }
      return super.graphql(input);
    }
  }
  try {
    const client = new DeferredClient(); const state = fakeState(readyState()); const journal = fakeJournal(client.events);
    journal.withRequestOwner = (callback) => withGitHubRequestOwnerLock(cwd, 992, callback, { timeoutMs: 20, staleMs: 0 });
    const adapters = { client, state, git: fakeGit(), clock: { now: () => AT }, journal };
    const owner = createGitHubReviewWorkflow(adapters); const retry = createGitHubReviewWorkflow(adapters);
    ownerPromise = owner.request(2); await enteredPromise;
    const waiting = await retry.request(2);
    assert.equal(waiting.waiting, true);
    release(); await ownerPromise;
    const recovered = await retry.request(2);
    assert.equal(recovered.recovered, true);
    assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
    assert.equal(client.comments.filter((comment) => comment.body === '@codex review').length, 1);
    assert.equal(state.current.reviewHistory.length, 1);
  } finally {
    if (release) release();
    await ownerPromise?.catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('request treats successful but delayed GitHub comment visibility as uncertain without replaying', async () => {
  class DelayedCommentClient extends FakeClient {
    constructor() { super(); this.visible = false; }
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestComments' && !this.visible) {
        result.data.repository.pullRequest.comments.nodes = result.data.repository.pullRequest.comments.nodes
          .filter((comment) => comment.body !== '@codex review');
      }
      return result;
    }
  }
  const client = new DelayedCommentClient();
  const state = fakeState(readyState());
  const journal = fakeJournal(client.events);
  const api = createGitHubReviewWorkflow({ client, state, git: fakeGit(), clock: { now: () => AT }, journal });
  const uncertain = await api.request(2);
  assert.deepEqual({ requested: uncertain.requested, waiting: uncertain.waiting }, { requested: false, waiting: true });
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  client.visible = true;
  const recovered = await api.request(2);
  assert.equal(recovered.recovered, true);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(client.comments.filter((comment) => comment.body === '@codex review').length, 1);
  assert.equal(state.current.reviewHistory.length, 1);
});

test('request owner-lock timeout is a mutation-free structured wait', async () => {
  const client = new FakeClient();
  const state = fakeState(readyState());
  const journal = fakeJournal(client.events);
  journal.withRequestOwner = async () => {
    const error = new Error('busy'); error.code = 'STATE_LOCK_TIMEOUT'; throw error;
  };
  const api = createGitHubReviewWorkflow({ client, state, git: fakeGit(), clock: { now: () => AT }, journal });
  const result = await api.request(2);
  assert.deepEqual(result, { requested: false, recovered: false, waiting: true,
    pullRequestReadiness: 'already-ready', nextAction: 'Wait, then rerun npm run review:github -- request --pr 2.' });
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(state.calls.length, 0);
});

test('request owner-lock timeout keeps a live draft poll-safe without claiming readiness', async () => {
  for (const existingReadyIntent of [false, true]) {
    const client = new FakeClient({ metadata: { isDraft: true } });
    const state = fakeState(readyState());
    const readyOperationId = `ready:2:${client.metadata.id}:${HEAD}`;
    const journal = fakeJournal(client.events, existingReadyIntent
      ? [priorIntent('ready', readyOperationId)] : []);
    journal.withRequestOwner = async () => {
      const error = new Error('busy'); error.code = 'STATE_LOCK_TIMEOUT'; throw error;
    };
    const api = createGitHubReviewWorkflow({
      client, state, git: fakeGit(), clock: { now: () => AT }, journal,
    });
    assert.deepEqual(await api.request(2), {
      requested: false, recovered: false, waiting: true,
      nextAction: 'Wait, then rerun npm run review:github -- request --pr 2.',
    });
    assert.equal(client.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
    assert.equal(state.calls.length, 0);
  }

  for (const { metadata, git, code } of [
    { metadata: { state: 'CLOSED' }, git: fakeGit(), code: 'PR_NOT_OPEN' },
    { metadata: { isDraft: true }, git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
      code: 'MUTATION_NOT_READY' },
    { metadata: { isDraft: true, headRefOid: OTHER_HEAD }, git: fakeGit(), code: 'MUTATION_NOT_READY' },
  ]) {
    const client = new FakeClient({ metadata });
    const state = fakeState(readyState());
    const journal = fakeJournal(client.events);
    journal.withRequestOwner = async () => {
      const error = new Error('busy'); error.code = 'STATE_LOCK_TIMEOUT'; throw error;
    };
    const api = createGitHubReviewWorkflow({ client, state, git, clock: { now: () => AT }, journal });
    await assert.rejects(() => api.request(2), { code });
    assert.equal(client.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
    assert.equal(state.calls.length, 0);
  }
});

test('request propagates state-lock timeouts after request-owner callback entry', async () => {
  for (const failurePoint of ['ensureIntent', 'claimDispatch']) {
    const client = new FakeClient();
    const state = fakeState(readyState());
    const journal = fakeJournal(client.events);
    journal.withRequestOwner = async (callback) => callback();
    const timeout = new Error(`${failurePoint} state lock is busy`);
    timeout.code = 'STATE_LOCK_TIMEOUT';
    journal[failurePoint] = async () => { throw timeout; };
    const api = createGitHubReviewWorkflow({
      client, state, git: fakeGit(), clock: { now: () => AT }, journal,
    });
    await assert.rejects(() => api.request(2), (error) => error === timeout);
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
    assert.equal(state.calls.length, 0);
  }
});

test('request preserves a checkpoint state-lock timeout and recovers its one live comment', async () => {
  const client = new FakeClient();
  const state = fakeState(readyState());
  const journal = fakeJournal(client.events);
  journal.withRequestOwner = async (callback) => callback();
  const checkpointReviewRequest = state.checkpointReviewRequest.bind(state);
  const timeout = new Error('checkpoint state lock is busy');
  timeout.code = 'STATE_LOCK_TIMEOUT';
  let failCheckpoint = true;
  state.checkpointReviewRequest = async (input) => {
    if (failCheckpoint) {
      failCheckpoint = false;
      throw timeout;
    }
    return checkpointReviewRequest(input);
  };
  const api = createGitHubReviewWorkflow({
    client, state, git: fakeGit(), clock: { now: () => AT }, journal,
  });
  await assert.rejects(() => api.request(2), (error) => error === timeout);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(state.calls.length, 0);

  const recovered = await api.request(2);
  assert.equal(recovered.recovered, true);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
  assert.equal(client.comments.filter((comment) => comment.body === '@codex review').length, 1);
  assert.equal(state.calls.filter((call) => call.name === 'checkpointReviewRequest').length, 1);
});

test('pending request retries preserve the exact durable request after new Codex roots appear', async () => {
  for (const resolved of [false, true]) {
    const setup = workflow(readyState());
    const requested = await setup.api.request(2);
    addThread(setup.client, { id: `THREAD_retry_${resolved}`, resolved });
    const calls = setup.state.calls.length;
    const retried = await setup.api.request(2);
    assert.equal(retried.requested, true);
    assert.equal(retried.recovered, true);
    assert.deepEqual(retried.request, requested.request);
    assert.equal(setup.client.calls.filter((call) => call.name === 'AddReviewRequest').length, 1);
    assert.equal(setup.state.calls.length, calls);
  }
});

test('request revalidates readiness after ready and request intents before mutation', async () => {
  const readyClient = new FakeClient();
  readyClient.metadata.isDraft = true;
  const readyJournal = {
    async lookupIntent() { return null; },
    async ensureIntent(intent) {
      if (intent.type === 'ready') readyClient.metadata.state = 'CLOSED';
      return { ...intent, isNew: true };
    },
  };
  await assert.rejects(() => workflow(readyState(), readyClient, { journal: readyJournal }).api.request(2), {
    code: 'REQUEST_NOT_READY',
  });
  assert.equal(readyClient.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);

  const requestClient = new FakeClient();
  const requestJournal = {
    async lookupIntent() { return null; },
    async ensureIntent(intent) {
      if (intent.type === 'request') requestClient.metadata.isDraft = true;
      return { ...intent, isNew: true };
    },
  };
  await assert.rejects(() => workflow(readyState(), requestClient, { journal: requestJournal }).api.request(2), {
    code: 'PR_DRAFT',
  });
  assert.equal(requestClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
});

test('draft promotion rejects a post-mutation redraft before posting the review request', async () => {
  class RedraftAfterPromotionClient extends FakeClient {
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'MarkPullRequestReadyForReview') this.metadata.isDraft = true;
      return result;
    }
  }
  const client = new RedraftAfterPromotionClient();
  client.metadata.isDraft = true;
  const setup = workflow(readyState(), client);
  await assert.rejects(() => setup.api.request(2), { code: 'PR_DRAFT' });
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);
});

test('request rejects closed, merged, and unready draft pull requests before promotion', async () => {
  for (const state of ['CLOSED', 'MERGED']) {
    const client = new FakeClient();
    client.metadata.state = state;
    await assert.rejects(() => workflow(readyState(), client).api.request(2), { code: 'PR_NOT_OPEN' });
    assert.equal(client.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);
  }
  const client = new FakeClient();
  client.metadata.isDraft = true;
  const unready = stateFixture();
  await assert.rejects(() => workflow(unready, client).api.request(2), { code: 'REQUEST_NOT_READY' });
  assert.equal(client.calls.some((call) => call.name === 'MarkPullRequestReadyForReview'), false);
});

test('request preflight rejects dirty, local, pushed, live, and ancestry drift before mutation', async () => {
  const actionable = {
    id: 'task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Done', severity: 'P1',
    disposition: 'actionable', status: 'completed', integratedCommitSha: HEAD, resolutionSummary: 'Done.',
  };
  const cases = [
    fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }) }),
    fakeGit({ pushedHead: async () => OTHER_HEAD }),
    fakeGit({ isAncestor: async () => false }),
  ];
  for (const git of cases) {
    const client = new FakeClient();
    const { api } = workflow(readyState({ tasks: [actionable] }), client, { git });
    await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_NOT_READY' });
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  }
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const { api } = workflow(readyState({ tasks: [actionable] }), client);
  await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_NOT_READY' });
});

test('request journals before exact mutation, proves live result, and checkpoints guarded evidence', async () => {
  const events = [];
  const client = new FakeClient({ events });
  const { api, state } = workflow(readyState(), client);
  const result = await api.request(2, 'discovery');
  assert.equal(result.request.body, githubReviewConstants.REQUEST_BODY);
  assert.deepEqual(events.slice(0, 2), ['intent:request', 'mutation:AddReviewRequest']);
  const mutation = client.calls.find((call) => call.name === 'AddReviewRequest');
  assert.equal(mutation.variables.body, '@codex review');
  assert.match(mutation.variables.clientMutationId, /^aerstello-/u);
  assert.equal(state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('request posts a fifth durable request as repeatable verification by default', async () => {
  const history = [
    cleanReviewEntry(1, 'discovery', HEAD),
    cleanReviewEntry(2, 'discovery', HEAD),
    cleanReviewEntry(3, 'discovery', HEAD),
    cleanReviewEntry(4, 'verification', HEAD),
  ];
  const latest = history.at(-1);
  const state = readyState({
    reviewRound: 3,
    verificationReviewUsed: true,
    requestedHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    reviewRequest: latest.request,
    reviewOutcome: latest.outcome,
    reviewHistory: history,
  });
  const events = [];
  const client = new FakeClient({ events });
  const setup = workflow(state, client);
  const result = await setup.api.request(2);
  assert.equal(result.request.kind, 'verification');
  assert.equal(setup.state.current.reviewHistory.length, 5);
  assert.deepEqual(setup.state.current.reviewHistory.map((entry) => entry.request.kind), [
    'discovery', 'discovery', 'discovery', 'verification', 'verification',
  ]);
  assert.deepEqual(events.slice(0, 2), ['intent:request', 'mutation:AddReviewRequest']);
});

test('request recovers a concurrent intent using its returned exclusion baseline without mutation', async () => {
  class CommentsBetweenSnapshotsClient extends FakeClient {
    constructor(events, comments) {
      super({ events });
      this.raceComments = comments;
      this.commentReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestComments') {
        this.commentReads += 1;
        if (this.commentReads === 2) this.comments.push(...this.raceComments);
      }
      return super.graphql(input);
    }
  }

  const operationId = `request:2:discovery:1:${HEAD}`;
  const concurrentIntent = {
    ...priorIntent('request', operationId), excludedCommentIds: ['IC_excluded'],
  };
  const comments = [
    { id: 'IC_excluded', databaseId: 8, url: 'https://x/excluded', body: '@codex review',
      createdAt: AT, lastEditedAt: null, author: VIEWER },
    { id: 'IC_recovered', databaseId: 9, url: 'https://x/recovered', body: '@codex review',
      createdAt: AT, lastEditedAt: null, author: VIEWER },
  ];
  const events = [];
  const client = new CommentsBetweenSnapshotsClient(events, comments);
  const setup = workflow(readyState(), client, {
    journal: racingRequestJournal(concurrentIntent, events),
  });
  const result = await setup.api.request(2, 'discovery');

  assert.equal(result.recovered, true);
  assert.equal(result.request.id, 'IC_recovered');
  assert.deepEqual(events, ['intent:request']);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('concurrent request intent fails closed for missing or ambiguous candidates and later retries recover', async () => {
  const operationId = `request:2:discovery:1:${HEAD}`;
  const intent = priorIntent('request', operationId);

  const missingClient = new FakeClient();
  const missing = workflow(readyState(), missingClient, {
    journal: racingRequestJournal(intent),
  });
  assert.equal((await missing.api.request(2, 'discovery')).requested, true);
  assert.equal(missingClient.calls.some((call) => call.name === 'AddReviewRequest'), true);

  const ambiguousClient = new FakeClient();
  const ambiguousJournal = racingRequestJournal(intent);
  const graphql = ambiguousClient.graphql.bind(ambiguousClient);
  let commentReads = 0;
  ambiguousClient.graphql = async (input) => {
    if (input.name === 'PullRequestComments') {
      commentReads += 1;
      if (commentReads === 2) ambiguousClient.comments.push(
        { id: 'IC_first', databaseId: 11, url: 'https://x/first', body: '@codex review', createdAt: AT, lastEditedAt: null, author: VIEWER },
        { id: 'IC_second', databaseId: 12, url: 'https://x/second', body: '@codex review', createdAt: AT, lastEditedAt: null, author: VIEWER },
      );
    }
    return graphql(input);
  };
  const ambiguous = workflow(readyState(), ambiguousClient, { journal: ambiguousJournal });
  await assert.rejects(() => ambiguous.api.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_AMBIGUOUS' });
  assert.equal(ambiguousClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(ambiguous.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);
  ambiguousClient.comments = ambiguousClient.comments.filter((comment) => comment.id === 'IC_second');
  assert.equal((await ambiguous.api.request(2, 'discovery')).request.id, 'IC_second');
  assert.equal(ambiguousClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
});

test('request revalidates canonical thread proof before journaling or mutation and retries after resolution', async () => {
  class ThreadBetweenSnapshotsClient extends FakeClient {
    constructor(events) {
      super({ events });
      this.threadReads = 0;
      this.injectRoot = true;
    }

    async graphql(input) {
      if (input.name === 'PullRequestThreads') {
        this.threadReads += 1;
        if (this.injectRoot && this.threadReads === 2) addThread(this);
      }
      return super.graphql(input);
    }
  }

  const events = [];
  const client = new ThreadBetweenSnapshotsClient(events);
  const journal = fakeJournal(events);
  const first = workflow(readyState(), client, { journal });
  await assert.rejects(() => first.api.request(2, 'discovery'), { code: 'REQUEST_NOT_READY' });
  assert.equal(journal.intents.size, 0);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(first.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);

  client.injectRoot = false;
  client.threads[0].isResolved = true;
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  const reply = {
    id: 'REPLY_resolved', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
  };
  client.threadComments.get('THREAD_1').push(reply);
  const resolvedState = readyState({
    tasks: [{
      id: 'task-thread', sourceIds: ['thread:THREAD_1'], sourceType: 'github-thread', fingerprint: 'fp-thread',
      summary: 'Fix canonical finding.', severity: 'P1', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Fixed the finding.',
    }],
    threadResolutionStatus: {
      status: 'passed', headSha: HEAD,
      threads: [{
        threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_THREAD_1', rootCommentDatabaseId: 41,
        taskIds: ['task-thread'], disposition: 'fixed', replyId: reply.id, replyUrl: reply.url,
        isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
      }],
      threadlessVerification: proof('not-run').threadlessVerification,
      updatedAt: AT,
    },
  });
  const retry = workflow(resolvedState, client, { journal });
  const result = await retry.api.request(2, 'discovery');
  assert.equal(result.request.body, '@codex review');
  assert.deepEqual(events, ['intent:request', 'mutation:AddReviewRequest']);
  assert.equal(retry.state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('mutation correlation is required in addition to live proof', async () => {
  const client = new FakeClient();
  const graphql = client.graphql.bind(client);
  client.graphql = async (input) => {
    const result = await graphql(input);
    if (input.name === 'AddReviewRequest') result.data.addComment.clientMutationId = 'wrong-correlation';
    return result;
  };
  const { api, state } = workflow(readyState(), client);
  await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_CORRELATION_FAILED' });
  assert.equal(state.calls.length, 0);
  assert.equal(client.comments.length, 1, 'the live write exists but is not trusted without correlation and re-query');
});

test('request recovers one exact viewer comment and fails closed on ambiguous recovery', async () => {
  const recoveredClient = new FakeClient();
  recoveredClient.comments.push({
    id: 'IC_recovered', databaseId: 9, url: 'https://github.com/example/aerstello/pull/2#issuecomment-9',
    body: '@codex review', createdAt: AT, lastEditedAt: null, author: VIEWER,
  });
  const operationId = `request:2:discovery:1:${HEAD}`;
  const recoveryJournal = fakeJournal([], [priorIntent('request', operationId)]);
  const { api: recovered } = workflow(readyState(), recoveredClient, { journal: recoveryJournal });
  const recoveredResult = await recovered.request(2, 'discovery');
  assert.equal(recoveredResult.recovered, true, 'a persisted empty baseline recovers the crash-created comment');
  assert.equal(recoveredClient.calls.some((call) => call.name === 'AddReviewRequest'), false);

  const ambiguousClient = new FakeClient();
  ambiguousClient.comments.push(...recoveredClient.comments, { ...recoveredClient.comments[0], id: 'IC_other' });
  const { api: ambiguous } = workflow(readyState(), ambiguousClient, { journal: fakeJournal([], [priorIntent('request', operationId)]) });
  await assert.rejects(() => ambiguous.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_AMBIGUOUS' });

  const unprovenClient = new FakeClient({ noEffect: new Set(['AddReviewRequest']) });
  const { api: unproven } = workflow(readyState(), unprovenClient);
  assert.equal((await unproven.request(2, 'discovery')).waiting, true);

  const missingClient = new FakeClient();
  const existing = [priorIntent('request', operationId)];
  const missingState = fakeState(readyState());
  const missing = createGitHubReviewWorkflow({
    client: missingClient, state: missingState, git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal([], existing),
  });
  assert.equal((await missing.request(2, 'discovery')).requested, true);
  assert.equal(missingClient.calls.some((call) => call.name === 'AddReviewRequest'), true);
});

test('bounded request allowance is checked before GitHub mutation', async () => {
  for (const state of [
    pendingState('verification'),
    readyState(),
  ]) {
    const client = new FakeClient();
    const { api } = workflow(state, client);
    await assert.rejects(() => api.request(2, 'verification'), { code: 'REQUEST_NOT_READY' });
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  }

  const history = [
    cleanReviewEntry(1, 'discovery', HEAD),
    cleanReviewEntry(2, 'discovery', HEAD),
    cleanReviewEntry(3, 'discovery', HEAD),
    cleanReviewEntry(4, 'verification', HEAD),
  ];
  const latest = history.at(-1);
  const exhausted = readyState({
    reviewRound: 3,
    verificationReviewUsed: true,
    reviewRequestLimit: 4,
    requestedHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    reviewRequest: latest.request,
    reviewOutcome: latest.outcome,
    reviewHistory: history,
  });
  const journalEvents = [];
  const client = new FakeClient();
  const setup = workflow(exhausted, client, { journal: fakeJournal(journalEvents) });
  await assert.rejects(() => setup.api.request(2, 'verification'), { code: 'REQUEST_NOT_READY' });
  assert.deepEqual(journalEvents, []);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);
  const status = await setup.api.status(2);
  assert.match(
    status.nextAction,
    /set-review-limit --pr 2 --expected-revision 1 --limit <higher-number> or --unlimited/u,
  );
});

test('request recovery uses numeric timestamps, viewer node identity, and logical ordinal', async () => {
  const client = new FakeClient();
  client.comments.push({ id: 'IC_numeric', databaseId: 8, url: 'https://x/8', body: '@codex review',
    createdAt: '2026-08-04T23:59:59.500Z', lastEditedAt: null, author: VIEWER });
  const operationId = `request:2:discovery:1:${HEAD}`;
  const journal = fakeJournal([], [priorIntent('request', operationId)]);
  const { api } = workflow(readyState(), client, { journal, clock: { now: () => AT } });
  const result = await api.request(2, 'discovery');
  assert.equal(result.recovered, true);
  assert.ok(journal.intents.has(`request:2:discovery:1:${HEAD}`));

  const noId = new FakeClient();
  noId.metadata.viewer = { login: VIEWER.login };
  await assert.rejects(() => workflow(readyState(), noId).api.request(2, 'discovery'), { code: 'GRAPHQL_TRUNCATED' });
});

test('fresh request intent never adopts an earlier same-head viewer comment', async () => {
  const client = new FakeClient();
  client.comments.push({ id: 'IC_manual', databaseId: 8, url: 'https://x/manual', body: '@codex review',
    createdAt: '2026-08-04T23:59:59.500Z', lastEditedAt: null, author: VIEWER });
  const journal = fakeJournal();
  const setup = workflow(readyState(), client, { journal });
  await assert.rejects(() => setup.api.request(2, 'discovery'), { code: 'REQUEST_BASELINE_COLLISION' });
  await assert.rejects(() => setup.api.request(2, 'discovery'), { code: 'REQUEST_BASELINE_COLLISION' });
  assert.equal(journal.intents.size, 0);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 0);
  assert.equal(setup.state.calls.length, 0);
});

test('a fresh later ordinal excludes prior review-history request IDs', async () => {
  const prior = completedState();
  const state = { ...prior, phase: 'ready-for-review',
    nextAction: 'Request another discovery review.' };
  const client = new FakeClient();
  client.comments.push({ id: 'IC_request', databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-101', body: '@codex review',
    createdAt: AT, lastEditedAt: null, author: VIEWER });
  const journal = fakeJournal();
  const setup = workflow(state, client, { journal });
  const result = await setup.api.request(2, 'discovery');
  assert.notEqual(result.request.id, 'IC_request');
  assert.ok(journal.intents.has(`request:2:discovery:2:${HEAD}`));
});
