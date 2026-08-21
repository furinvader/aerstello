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

test('CI pagination observes readiness and HEAD changes on later pages before checkpointing', async () => {
  class PaginatedReadinessRaceClient extends FakeClient {
    constructor(mutate) {
      super({ pageSize: 1 });
      this.ciContexts = [
        fullValidationCheck(),
        { __typename: 'StatusContext', id: 'STATUS_other', context: 'other', state: 'SUCCESS', targetUrl: null },
      ];
      this.checkReads = 0;
      this.mutate = mutate;
    }

    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestChecks' && ++this.checkReads === 1) this.mutate(this);
      return result;
    }
  }
  for (const [mutate, code] of [
    [(client) => { client.metadata.state = 'CLOSED'; }, 'PR_NOT_OPEN'],
    [(client) => { client.metadata.isDraft = true; }, 'PR_DRAFT'],
    [(client) => { client.metadata.headRefOid = OTHER_HEAD; }, 'CI_HEAD_MISMATCH'],
  ]) {
    const client = new PaginatedReadinessRaceClient(mutate);
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.collectCi(2), { code });
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCiValidation'), false);
  }
});

test('collect-ci paginates the exact-head rollup and records the latest authoritative workflow run', async () => {
  const client = new FakeClient({ pageSize: 1 });
  client.ciContexts = [
    { __typename: 'StatusContext', id: 'STATUS_lint', context: 'lint', state: 'SUCCESS', targetUrl: 'https://github.com/example/aerstello' },
    fullValidationCheck({ id: 'CHECK_old', completedAt: '2026-08-04T23:00:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: { databaseId: 700,
        url: 'https://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } } } }),
    fullValidationCheck(),
  ];
  const setup = workflow(stateFixture(), client);
  const result = await setup.api.collectCi(2);
  assert.deepEqual(result.evidence, {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation'], checkRunId: 'CHECK_full', workflowRunId: 701,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/701', updatedAt: AT,
  });
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestChecks').length >= 3);
  assert.match(client.calls.find((call) => call.name === 'PullRequestChecks').query,
    /workflowRun\{databaseId url file\{path\} workflow\{name\}\}/u);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
});

test('collect-ci evidence is unchanged by unrelated rollup contexts', async () => {
  const authoritative = fullValidationCheck();
  const unrelatedCheck = {
    __typename: 'CheckRun', id: 'CHECK_lint', databaseId: 302, name: 'lint',
    status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: AT,
    detailsUrl: 'https://github.com/example/aerstello/actions/runs/800/job/302', checkSuite: null,
  };
  const unrelatedStatus = {
    __typename: 'StatusContext', id: 'STATUS_lint', context: 'legacy lint',
    state: 'SUCCESS', targetUrl: 'https://github.com/example/aerstello',
  };
  const client = new FakeClient({ ciContexts: [unrelatedStatus, authoritative, unrelatedCheck] });
  const setup = workflow(stateFixture(), client);
  const first = await setup.api.collectCi(2);
  assert.deepEqual(first.evidence.checks, ['Full validation']);
  const revision = setup.state.current.revision;
  const historyLength = setup.state.current.ciValidationHistory.length;

  for (const contexts of [
    [unrelatedCheck, authoritative, { ...unrelatedStatus, context: 'renamed status', state: 'FAILURE' }],
    [authoritative],
    [authoritative, { ...unrelatedCheck, id: 'CHECK_other', name: 'unrelated changed check' }],
  ]) {
    client.ciContexts = contexts;
    const repeated = await setup.api.collectCi(2);
    assert.deepEqual(repeated.evidence, first.evidence);
    assert.equal(setup.state.current.revision, revision);
    assert.equal(setup.state.current.ciValidationHistory.length, historyLength);
  }
});

test('collect-ci appends distinct check attempts for one rerun workflow and is idempotent per check', async () => {
  const client = new FakeClient({
    rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ id: 'CHECK_attempt_1', conclusion: 'FAILURE' })],
  });
  const setup = workflow(stateFixture(), client);
  assert.equal((await setup.api.collectCi(2)).evidence.status, 'failed');
  client.rollupState = 'SUCCESS';
  client.ciContexts = [fullValidationCheck({
    id: 'CHECK_attempt_2', conclusion: 'SUCCESS', completedAt: '2026-08-05T00:01:00Z',
  })];
  const successful = await setup.api.collectCi(2);
  assert.equal(successful.evidence.status, 'passed');
  assert.equal(successful.evidence.workflowRunId, 701);
  assert.equal(successful.evidence.checkRunId, 'CHECK_attempt_2');
  assert.deepEqual(setup.state.current.ciValidationHistory.map((entry) => entry.checkRunId), [
    'CHECK_attempt_1', 'CHECK_attempt_2',
  ]);
  const revision = setup.state.current.revision;
  await setup.api.collectCi(2);
  assert.equal(setup.state.current.revision, revision);
});

test('collect-ci supersedes failures only within the same workflow run', async () => {
  const sameRun = new FakeClient({ ciContexts: [
    fullValidationCheck({
      id: 'CHECK_failed_attempt', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z',
    }),
    fullValidationCheck({ id: 'CHECK_successful_rerun' }),
  ] });
  const rerunEvidence = (await workflow(stateFixture(), sameRun).api.collectCi(2)).evidence;
  assert.equal(rerunEvidence.status, 'passed');
  assert.equal(rerunEvidence.checkRunId, 'CHECK_successful_rerun');
  assert.equal(rerunEvidence.workflowRunId, 701);

  const distinctRuns = new FakeClient({ rollupState: 'FAILURE', ciContexts: [
    fullValidationCheck({
      id: 'CHECK_failed_parallel', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 700, url: 'https://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
    fullValidationCheck({ id: 'CHECK_newer_success' }),
  ] });
  const failedEvidence = (await workflow(stateFixture(), distinctRuns).api.collectCi(2)).evidence;
  assert.equal(failedEvidence.status, 'failed');
  assert.equal(failedEvidence.checkRunId, 'CHECK_failed_parallel');
  assert.equal(failedEvidence.workflowRunId, 700);
  assert.equal(failedEvidence.workflowRunUrl, 'https://github.com/example/aerstello/actions/runs/700');
  assert.equal(failedEvidence.updatedAt, '2026-08-04T23:59:00Z');
});

test('collect-ci records a completed failed full run but rejects pending, stale, missing, and ambiguous evidence', async () => {
  const failed = new FakeClient({ rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ conclusion: 'FAILURE' })] });
  const failedSetup = workflow(stateFixture(), failed);
  assert.equal((await failedSetup.api.collectCi(2)).evidence.status, 'failed');

  const pending = new FakeClient({ rollupState: 'PENDING',
    ciContexts: [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })] });
  await assert.rejects(() => workflow(stateFixture(), pending).api.collectCi(2), { code: 'CI_VALIDATION_PENDING' });

  const stale = new FakeClient({ checkHeadSha: OTHER_HEAD });
  await assert.rejects(() => workflow(stateFixture(), stale).api.collectCi(2), { code: 'CI_HEAD_MISMATCH' });

  const missing = new FakeClient({ ciContexts: [fullValidationCheck({ name: 'another check' })] });
  await assert.rejects(() => workflow(stateFixture(), missing).api.collectCi(2), { code: 'CI_CHECK_MISSING' });

  const ambiguous = new FakeClient({ ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({ id: 'CHECK_other', checkSuite: { app: { slug: 'github-actions' },
      workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } } } }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), ambiguous).api.collectCi(2), { code: 'CI_EVIDENCE_AMBIGUOUS' });

  const missingAttempt = new FakeClient({ ciContexts: [fullValidationCheck({ id: null })] });
  await assert.rejects(() => workflow(stateFixture(), missingAttempt).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });
});

test('collect-ci classifies the selected Full validation run independently of the aggregate rollup', async () => {
  for (const [rollupState, conclusion, expected] of [
    ['FAILURE', 'SUCCESS', 'passed'],
    ['PENDING', 'SUCCESS', 'passed'],
    ['SUCCESS', 'FAILURE', 'failed'],
  ]) {
    const client = new FakeClient({
      rollupState,
      ciContexts: [
        fullValidationCheck({ conclusion }),
        { __typename: 'StatusContext', id: `STATUS_${rollupState}`, context: 'unrelated',
          state: rollupState, targetUrl: 'https://github.com/example/aerstello' },
      ],
    });
    const result = await workflow(stateFixture(), client).api.collectCi(2);
    assert.equal(result.evidence.status, expected);
  }
});

test('collect-ci waits when another authoritative Full validation run is incomplete', async () => {
  const client = new FakeClient({ rollupState: 'FAILURE', ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({
      id: 'CHECK_pending', status: 'IN_PROGRESS', conclusion: null, completedAt: null,
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 702, url: 'https://github.com/example/aerstello/actions/runs/702',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), client).api.collectCi(2), {
    code: 'CI_VALIDATION_PENDING',
  });
});

test('collect-ci rejects same-named jobs from another workflow and incomplete workflow identity', async () => {
  const wrongWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
      file: { path: '.github/workflows/other.yml' }, workflow: { name: 'CI' } },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), wrongWorkflow).api.collectCi(2), {
    code: 'CI_WORKFLOW_MISMATCH',
  });

  const missingWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701' },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), missingWorkflow).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });

  const truncatedWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
      file: { path: null }, workflow: { name: 'CI' } },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), truncatedWorkflow).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });

  const malformedNonSelected = new FakeClient({ ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({
      id: null, completedAt: '2026-08-04T23:00:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 700, url: 'http://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), malformedNonSelected).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });
});
