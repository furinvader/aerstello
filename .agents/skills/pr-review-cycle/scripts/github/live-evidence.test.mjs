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

test('status uses split fully paginated reads and filters canonical roots', async () => {
  const client = new FakeClient({ pageSize: 1 });
  client.comments.push({ id: 'C1' }, { id: 'C2' });
  client.reviews.push({ id: 'R1' }, { id: 'R2' });
  addThread(client);
  addThread(client, { id: 'THREAD_2', root: rootComment('THREAD_2', { author: VIEWER }) });
  const { api } = workflow(stateFixture(), client);
  const result = await api.status(2);
  assert.equal(result.canonicalThreads.length, 1);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestComments').length >= 2);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestReviews').length >= 2);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 2);
  assert.equal(client.calls.filter((call) => call.name === 'ReviewThreadComments').length, 2);
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestChecks').length, 1);
  assert.equal(result.statePhase, 'recovering');
  assert.equal(result.liveCiValidation.status, 'passed');
  assert.deepEqual(result.reviewRequests, { used: 0, limit: null });
  assert.match(renderHumanStatus(result), /Review requests: 0; limit: unlimited/u);

  const finite = await workflow(stateFixture({
    reviewRound: 3,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT },
    reviewRequestLimit: 5,
  })).api.status(2);
  assert.deepEqual(finite.reviewRequests, { used: 3, limit: 5 });
  assert.match(renderHumanStatus(finite), /Review requests: 3; limit: 5/u);
});

test('status reports volatile readiness and observations without state or GitHub mutations', async () => {
  const client = new FakeClient();
  client.metadata.isDraft = true;
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.status(2);
  assert.deepEqual(result.pullRequest, { state: 'OPEN', isDraft: true });
  assert.deepEqual(result.reviewObservation, { status: 'waiting', outcome: null, evidenceType: null, evidenceIds: [] });
  assert.equal(setup.state.calls.length, 0);
  assert.equal(client.events.length, 0);
  assert.match(renderHumanStatus(result), /PR readiness: OPEN draft/u);
});

test('status rejects close or merge observed by the later checks snapshot without writes', async () => {
  for (const state of ['CLOSED', 'MERGED']) {
    class LaterChecksStateClient extends FakeClient {
      async graphql(input) {
        if (input.name === 'PullRequestChecks') this.metadata.state = state;
        return super.graphql(input);
      }
    }
    const client = new LaterChecksStateClient();
    const setup = workflow(pendingState('discovery'), client);
    await assert.rejects(() => setup.api.status(2), { code: 'PR_NOT_OPEN' });
    assert.equal(setup.state.calls.length, 0);
    assert.equal(client.events.length, 0);
  }
});

test('status gives typed immutable-anchor identifiers for edited, missing, and duplicate requests', async () => {
  for (const mutate of [
    (client) => { client.comments[0].lastEditedAt = '2026-08-05T00:00:01Z'; },
    (client) => { client.comments.length = 0; },
    (client) => client.comments.push({ ...client.comments[0] }),
  ]) {
    const client = new FakeClient();
    const setup = workflow(pendingState('discovery'), client);
    mutate(client);
    const observation = (await setup.api.status(2)).reviewObservation;
    assert.equal(observation.status, 'ambiguous');
    assert.deepEqual(observation.evidenceIds, client.comments.length > 0
      ? ['request-proof:IC_request', 'live-request:IC_request']
      : ['request-proof:IC_request']);
  }
});

test('status reports every canonical observation state without mutations', async () => {
  const cases = [];
  cases.push(['not-applicable', stateFixture(), new FakeClient()]);
  cases.push(['waiting', pendingState('discovery'), new FakeClient()]);
  const clean = new FakeClient();
  clean.reviews.push(canonicalReview());
  cases.push(['collectable', pendingState('discovery'), clean]);
  const ambiguous = new FakeClient();
  ambiguous.reviews.push(canonicalReview());
  ambiguous.reactions.set('IC_request', [{ id: 'REACTION_duplicate', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  cases.push(['ambiguous', pendingState('discovery'), ambiguous]);
  const duplicateReview = new FakeClient();
  duplicateReview.reviews.push(canonicalReview(), canonicalReview({ id: 'PRR_duplicate', databaseId: 202 }));
  cases.push(['ambiguous', pendingState('discovery'), duplicateReview]);
  const stale = new FakeClient();
  stale.metadata.headRefOid = OTHER_HEAD;
  cases.push(['stale', pendingState('discovery'), stale]);
  const stateAndLiveAdvanced = new FakeClient();
  stateAndLiveAdvanced.metadata.headRefOid = OTHER_HEAD;
  cases.push(['stale', pendingState('discovery', { currentIntegrationHeadSha: OTHER_HEAD }), stateAndLiveAdvanced]);
  for (const [expected, state, client] of cases) {
    const setup = workflow(state, client);
    const result = await setup.api.status(2);
    assert.equal(result.reviewObservation.status, expected);
    assert.equal(setup.state.calls.length, 0);
    assert.equal(client.events.length, 0);
  }

  const findings = new FakeClient();
  findings.reviews.push(canonicalReview({ id: 'PRR_findings', body: '' }));
  const root = addThread(findings, { root: rootComment('THREAD_status', {
    pullRequestReview: { id: 'PRR_findings' },
  }) });
  const findingsStatus = await workflow(pendingState('discovery'), findings).api.status(2);
  assert.equal(findingsStatus.reviewObservation.status, 'collectable');
  assert.equal(findingsStatus.reviewObservation.outcome, 'findings');
  assert.deepEqual(findingsStatus.reviewObservation.evidenceIds.sort(), [
    `review:PRR_findings`, `review-root:${root.id}`,
  ].sort());

  const malformed = new FakeClient();
  malformed.reviews.push(canonicalReview({ body: null }));
  assert.equal((await workflow(pendingState('discovery'), malformed).api.status(2)).reviewObservation.status, 'ambiguous');
});

test('collection rejects canonical response drift between complete snapshots without checkpointing', async () => {
  class ResponseDriftClient extends FakeClient {
    constructor() {
      super();
      this.reviews.push(canonicalReview());
      this.reviewReads = 0;
    }

    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestReviews' && ++this.reviewReads === 1) {
        this.reviews.push(canonicalReview({ id: 'PRR_late', databaseId: 999 }));
      }
      return result;
    }
  }
  const setup = workflow(pendingState('verification'), new ResponseDriftClient());
  await assert.rejects(() => setup.api.collect(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointReviewOutcome'), false);
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointVerificationEscalation'), false);
});

test('collection rejects attached canonical-root fingerprint drift between complete snapshots', async () => {
  class RootDriftClient extends FakeClient {
    constructor() {
      super();
      this.reviews.push(canonicalReview({ id: 'PRR_attached' }));
      addThread(this, { id: 'THREAD_attached', root: rootComment('THREAD_attached', { pullRequestReview: { id: 'PRR_attached' } }) });
      this.threadReads = 0;
    }

    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'ReviewThreadComments' && ++this.threadReads === 1) {
        const first = structuredClone(result);
        const comments = this.threadComments.get('THREAD_attached');
        comments[0] = { ...comments[0], body: 'Changed root after first snapshot.' };
        return first;
      }
      return result;
    }
  }
  const setup = workflow(pendingState('verification'), new RootDriftClient());
  await assert.rejects(() => setup.api.collect(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointReviewOutcome'), false);
  assert.equal(setup.state.calls.some((call) => call.name === 'checkpointVerificationEscalation'), false);
});

test('unmatched canonical roots make clean reaction and review evidence ambiguous whether resolved or open', async () => {
  for (const resolved of [false, true]) {
    const reactionClient = new FakeClient();
    reactionClient.reactions.set('IC_request', [{ id: 'REACTION_root', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
    addThread(reactionClient, { resolved });
    await assert.rejects(() => workflow(pendingState('discovery'), reactionClient).api.collect(2), {
      code: 'DISCOVERY_COLLECTION_UNRESOLVED',
    });

    const reviewClient = new FakeClient();
    reviewClient.reviews.push(canonicalReview());
    addThread(reviewClient, { resolved });
    await assert.rejects(() => workflow(pendingState('discovery'), reviewClient).api.collect(2), {
      code: 'DISCOVERY_COLLECTION_UNRESOLVED',
    });
  }
});

test('status classifies canonical channels and fails closed on an edited request anchor', async () => {
  const cases = [
    ['review', (client) => client.reviews.push(canonicalReview({ body: '' })), 'review-submission'],
    ['reaction', (client) => client.reactions.set('IC_request', [{ id: 'REACTION_status', content: 'THUMBS_UP', createdAt: AT, user: BOT }]), 'request-reaction'],
    ['issue comment', (client) => client.comments.push(cleanIssueComment()), 'issue-comment'],
  ];
  for (const [, prepare, evidenceType] of cases) {
    const client = new FakeClient();
    prepare(client);
    const setup = workflow(pendingState('discovery'), client);
    const status = await setup.api.status(2);
    assert.equal(status.reviewObservation.status, 'collectable');
    assert.equal(status.reviewObservation.outcome, 'clean');
    assert.equal(status.reviewObservation.evidenceType, evidenceType);
    assert.equal(setup.state.calls.length, 0);
  }
  const edited = new FakeClient();
  const setup = workflow(pendingState('discovery'), edited);
  edited.comments.find((comment) => comment.id === 'IC_request').lastEditedAt = AT;
  const status = await setup.api.status(2);
  assert.equal(status.reviewObservation.status, 'ambiguous');
  assert.equal(status.codexReview, 'awaiting');
  assert.equal(setup.state.calls.length, 0);
});

test('status marks preserved review evidence stale after both recorded and live HEAD advance', async () => {
  const drift = {
    phase: 'recovering', currentIntegrationHeadSha: OTHER_HEAD,
    git: { branch: 'main', headSha: OTHER_HEAD, dirty: false },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null,
      checks: [], updatedAt: null,
    },
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Reconcile the changed integration checkout.',
  };
  for (const state of [completedState(drift), findingsState(drift), pendingState('discovery', drift)]) {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const result = await workflow(state, client).api.status(2);
    assert.equal(result.codexReview, 'stale');
    assert.match(renderHumanStatus(result), /Codex review: Stale review evidence \(commit mismatch\)/u);
  }
});

test('status preserves exact-head review states', async () => {
  for (const [state, expected] of [
    [stateFixture(), 'not-requested'],
    [pendingState('discovery'), 'awaiting'],
    [completedState(), 'clean'],
    [findingsState(), 'findings'],
  ]) {
    const result = await workflow(state).api.status(2);
    assert.equal(result.codexReview, expected);
  }
});

test('Actor author queries select node IDs only through Bot and User fragments', async () => {
  const client = new FakeClient();
  addThread(client);
  await workflow(stateFixture(), client).api.status(2);
  for (const name of ['PullRequestComments', 'PullRequestReviews', 'ReviewThreadComments']) {
    const query = client.calls.find((call) => call.name === name)?.query;
    assert.equal(typeof query, 'string', `${name} query was captured`);
    assert.doesNotMatch(query, /author\{__typename login url id/u, `${name} must not select Actor.id directly`);
    assert.match(query, /author\{__typename login url \.\.\. on Bot\{id\} \.\.\. on User\{id\}\}/u,
      `${name} must populate a uniform id through concrete actor fragments`);
  }
});

test('check rollup reads fail closed on GraphQL errors and repeated pagination cursors', async () => {
  const graphqlError = new FakeClient({ graphqlErrors: new Set(['PullRequestChecks']) });
  await assert.rejects(() => workflow(stateFixture(), graphqlError).api.collectCi(2), { code: 'GRAPHQL_READ_FAILED' });

  const truncated = new FakeClient({ pageSize: 0 });
  await assert.rejects(() => workflow(stateFixture(), truncated).api.collectCi(2), { code: 'GRAPHQL_TRUNCATED' });
});

test('canonical Bot root without a concrete node ID throws fail-closed', async () => {
  const client = new FakeClient();
  addThread(client, { root: rootComment('THREAD_1', { author: { ...BOT, id: undefined } }) });
  await assert.rejects(() => workflow(stateFixture(), client).api.status(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
});

test('canonical review, reaction, and matching viewer actors without node IDs throw fail-closed', async () => {
  const reviewClient = new FakeClient();
  reviewClient.reviews.push({ id: 'PRR_missing', databaseId: 1, url: 'https://x/review', body: '',
    state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD }, author: { ...BOT, id: undefined } });
  await assert.rejects(() => workflow(pendingState('discovery'), reviewClient).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });

  const reactionClient = new FakeClient();
  reactionClient.reactions.set('IC_request', [{ id: 'REACTION_missing', content: 'THUMBS_UP',
    createdAt: AT, user: { ...BOT, id: undefined } }]);
  await assert.rejects(() => workflow(pendingState('discovery'), reactionClient).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });

  const viewerClient = new FakeClient();
  viewerClient.comments.push({ id: 'IC_missing', databaseId: 2, url: 'https://x/request',
    body: '@codex review', createdAt: AT, lastEditedAt: null, author: { ...VIEWER, id: undefined } });
  await assert.rejects(() => workflow(readyState(), viewerClient).api.request(2, 'discovery'), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
  assert.equal(viewerClient.events.length, 0);
});

test('GraphQL reads fail closed on errors, unsafe cost, and truncated pagination', async () => {
  for (const client of [
    new FakeClient({ graphqlErrors: new Set(['PullRequestComments']) }),
    new FakeClient({ remaining: 0 }),
  ]) {
    await assert.rejects(() => readTopLevelComments(client, 'example/aerstello', 2), GitHubWorkflowError);
  }
  const client = new FakeClient();
  client.comments = [{ id: 'C1' }, { id: 'C2' }];
  client.graphql = async () => client.result({
    repository: { pullRequest: { comments: { nodes: [{ id: 'C1' }], pageInfo: { hasNextPage: true, endCursor: null } } } },
  });
  await assert.rejects(() => readTopLevelComments(client, 'example/aerstello', 2), { code: 'GRAPHQL_TRUNCATED' });
});

test('default gh GraphQL transport preserves literal strings and typed scalar variables', async () => {
  const calls = [];
  const client = createDefaultGitHubClient((command, args, options) => {
    calls.push({ command, args, options });
    return JSON.stringify({ data: { ok: true } });
  });
  const result = await client.graphql({
    query: 'mutation($body:String!,$pr:Int!,$enabled:Boolean!){example}',
    variables: {
      body: '@codex review', owner: 'openai/aerstello', pr: 2, enabled: true,
      cursor: null, absent: undefined,
    },
  });
  assert.deepEqual(result, { data: { ok: true } });
  assert.deepEqual(calls[0].args, [
    'api', 'graphql',
    '-f', 'query=mutation($body:String!,$pr:Int!,$enabled:Boolean!){example}',
    '-f', 'body=@codex review',
    '-f', 'owner=openai/aerstello',
    '-F', 'pr=2',
    '-F', 'enabled=true',
  ]);
  assert.equal(calls[0].args.includes('codex review'), false, 'the literal body remains one raw-field argument');
});

test('default gh GraphQL transport rejects unsupported values before invoking gh', async () => {
  let invocations = 0;
  const client = createDefaultGitHubClient(() => {
    invocations += 1;
    return '{}';
  });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, {}, [], 1n]) {
    await assert.rejects(() => client.graphql({ query: 'query{viewer{login}}', variables: { value } }), {
      code: 'INVALID_GRAPHQL_VARIABLE',
    });
  }
  assert.equal(invocations, 0);
  assert.deepEqual(buildGhGraphqlArgs('query{viewer{login}}', { nullable: null, missing: undefined }),
    ['api', 'graphql', '-f', 'query=query{viewer{login}}']);
});
