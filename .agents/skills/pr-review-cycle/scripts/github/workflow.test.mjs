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

test('advance is waiting-safe before a canonical response exists', async () => {
  const waiting = workflow(stateFixture());
  const waitingResult = await waiting.api.advance(2);
  assert.deepEqual(waitingResult.performedTransitions, []);
  assert.equal(waitingResult.terminal, 'waiting');
  assert.equal(waitingResult.waiting, true);
  assert.equal(waiting.state.calls.length, 0);
});

test('advance revalidates durable findings before returning triage', async () => {
  const exactClient = new FakeClient();
  exactClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const findings = workflow(findingsState(), exactClient);
  const findingsResult = await findings.api.advance(2);
  assert.equal(findingsResult.terminal, 'triage');
  assert.equal(findingsResult.waiting, false);
  assert.deepEqual(findingsResult.performedTransitions, []);
  assert.equal(findings.client.calls.some((call) => call.name === 'PullRequestChecks'), false);
  assert.equal(findings.state.calls.length, 0);

  const driftClient = new FakeClient({ metadata: { headRefOid: OTHER_HEAD } });
  driftClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const drift = workflow(findingsState(), driftClient);
  const waiting = await drift.api.advance(2);
  assert.equal(waiting.terminal, 'waiting');
  assert.equal(waiting.waiting, true);
  assert.match(waiting.nextAction, /stale at the live PR head; reconcile before triage/u);
  assert.equal(drift.client.calls.some((call) => call.name === 'PullRequestChecks'), false);
  assert.equal(drift.state.calls.length, 0);

  const editedClient = new FakeClient();
  editedClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const edited = workflow(findingsState(), editedClient);
  edited.client.comments.find((comment) => comment.id === 'IC_request').body = '@codex review edited';
  await assert.rejects(() => edited.api.advance(2), { code: 'REQUEST_PROOF_STALE' });

  const missing = workflow(findingsState());
  await assert.rejects(() => missing.api.advance(2), { code: 'REVIEW_COLLECTION_STALE' });

  const ambiguousClient = new FakeClient();
  ambiguousClient.reviews.push(
    canonicalReview({ body: 'Canonical finding.' }),
    canonicalReview({
      id: 'PRR_duplicate', databaseId: 202,
      url: 'https://github.com/example/aerstello/pull/2#pullrequestreview-202',
      body: 'Second canonical finding.',
    }),
  );
  const ambiguous = workflow(findingsState(), ambiguousClient);
  await assert.rejects(() => ambiguous.api.advance(2), { code: 'REVIEW_COLLECTION_STALE' });

  const rootClient = new FakeClient();
  rootClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  addThread(rootClient, { id: 'THREAD_unmatched' });
  const unmatchedRoot = workflow(findingsState(), rootClient);
  await assert.rejects(() => unmatchedRoot.api.advance(2), { code: 'REVIEW_COLLECTION_STALE' });

  for (const git of [
    fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }) }),
    fakeGit({ pushedHead: async () => OTHER_HEAD }),
  ]) {
    const gitDriftClient = new FakeClient();
    gitDriftClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
    const gitDrift = workflow(findingsState(), gitDriftClient, { git });
    await assert.rejects(() => gitDrift.api.advance(2), { code: 'MUTATION_NOT_READY' });
  }

  const revisionClient = new FakeClient();
  revisionClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const revisionRace = workflow(findingsState(), revisionClient);
  const load = revisionRace.state.load.bind(revisionRace.state);
  let loads = 0;
  revisionRace.state.load = async () => {
    loads += 1;
    if (loads === 2) revisionRace.state.advanceRevisionForTest();
    return load();
  };
  await assert.rejects(() => revisionRace.api.advance(2), { code: 'STATE_REVISION_CHANGED' });
});

test('advance rejects findings response and attached-root fingerprint drift between snapshots', async () => {
  class FindingsDriftClient extends FakeClient {
    constructor(mutate) {
      super();
      this.metadataReads = 0;
      this.mutateFindings = mutate;
    }

    async graphql(input) {
      if (input.name === 'PullRequestMetadata' && ++this.metadataReads === 2) {
        this.mutateFindings(this);
      }
      return super.graphql(input);
    }
  }

  const reviewBodyClient = new FindingsDriftClient((client) => {
    client.reviews[0] = { ...client.reviews[0], body: 'Changed canonical finding.' };
  });
  reviewBodyClient.reviews.push(canonicalReview({ body: 'Canonical finding.' }));
  const reviewBodyDrift = workflow(findingsState(), reviewBodyClient);
  await assert.rejects(() => reviewBodyDrift.api.advance(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(reviewBodyDrift.client.calls.some((call) => call.name === 'PullRequestChecks'), false);
  assert.equal(reviewBodyDrift.state.calls.length, 0);

  const attachedRootClient = new FindingsDriftClient((client) => {
    const comments = client.threadComments.get('THREAD_attached');
    comments[0] = { ...comments[0], body: 'Changed attached canonical root.' };
  });
  attachedRootClient.reviews.push(canonicalReview());
  addThread(attachedRootClient, {
    id: 'THREAD_attached',
    root: rootComment('THREAD_attached', { pullRequestReview: { id: 'PRR_clean' } }),
  });
  const attachedRootDrift = workflow(findingsState(), attachedRootClient);
  await assert.rejects(() => attachedRootDrift.api.advance(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(attachedRootDrift.client.calls.some((call) => call.name === 'PullRequestChecks'), false);
  assert.equal(attachedRootDrift.state.calls.length, 0);
});

test('advance escalates verification ambiguity, rejects discovery ambiguity, and blocks CI after a late root', async () => {
  const verificationClient = new FakeClient();
  verificationClient.reviews.push(canonicalReview());
  verificationClient.reactions.set('IC_request', [{ id: 'REACTION_ambiguous', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  const verification = workflow(pendingState('verification'), verificationClient);
  const escalated = await verification.api.advance(2);
  assert.equal(escalated.terminal, 'escalation');
  assert.deepEqual(escalated.performedTransitions, ['verification-escalation']);
  assert.equal(verification.state.calls.filter((call) => call.name === 'checkpointVerificationEscalation').length, 1);
  const repeated = await verification.api.advance(2);
  assert.equal(repeated.terminal, 'escalation');
  assert.deepEqual(repeated.performedTransitions, []);
  assert.equal(verification.state.calls.filter((call) => call.name === 'checkpointVerificationEscalation').length, 1);
  verificationClient.reviews.length = 0;
  verificationClient.reactions.clear();
  const disappeared = await verification.api.advance(2);
  assert.equal(disappeared.terminal, 'escalation');
  assert.deepEqual(disappeared.escalation, escalated.escalation);
  assert.deepEqual(disappeared.performedTransitions, []);
  assert.equal(verification.state.calls.filter((call) => call.name === 'checkpointVerificationEscalation').length, 1);

  const discoveryClient = new FakeClient();
  discoveryClient.reviews.push(canonicalReview());
  discoveryClient.reactions.set('IC_request', [{ id: 'REACTION_ambiguous', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  const discovery = workflow(pendingState('discovery'), discoveryClient);
  await assert.rejects(() => discovery.api.advance(2), { code: 'DISCOVERY_COLLECTION_UNRESOLVED' });
  assert.equal(discovery.state.calls.length, 0);

  const lateRootClient = new FakeClient();
  lateRootClient.reviews.push(canonicalReview());
  const lateRoot = workflow(pendingState('discovery'), lateRootClient);
  lateRoot.state.setBeforeCheckpointForTest(() => addThread(lateRootClient, { id: 'THREAD_late' }), 'checkpointReviewOutcome');
  await assert.rejects(() => lateRoot.api.advance(2), { code: 'COMPLETION_NOT_READY' });
  assert.equal(lateRoot.state.calls.some((call) => call.name === 'checkpointCiValidation'), false);
});

test('advance checkpoints clean evidence through CI and Done exactly once', async () => {
  const client = new FakeClient();
  client.reviews.push(canonicalReview());
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.advance(2);
  assert.deepEqual(result.performedTransitions, ['review-outcome', 'ci-validation', 'cycle-completion']);
  assert.equal(result.phase, 'complete');
  assert.equal(result.terminal, 'done');
  assert.equal(result.waiting, false);
  assert.equal(result.nextAction, 'Archive is explicit after Done.');
  assert.equal(setup.state.calls.filter((call) => call.name === 'checkpointReviewOutcome').length, 1);
  assert.equal(setup.state.calls.filter((call) => call.name === 'checkpointCiValidation').length, 1);
  assert.equal(setup.state.calls.filter((call) => call.name === 'checkpointCompletion').length, 1);
});

test('advance checkpoints only clean outcome while CI is pending and records failed CI exactly once', async () => {
  const pendingClient = new FakeClient();
  pendingClient.reviews.push(canonicalReview());
  pendingClient.rollupState = 'PENDING';
  pendingClient.ciContexts = [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })];
  const pending = workflow(pendingState('discovery'), pendingClient);
  const pendingResult = await pending.api.advance(2);
  assert.deepEqual(pendingResult.performedTransitions, ['review-outcome']);
  assert.equal(pendingResult.terminal, 'waiting');
  assert.equal(pendingResult.waiting, true);
  assert.equal(pending.state.calls.some((call) => call.name === 'checkpointCiValidation'), false);

  const failedClient = new FakeClient();
  failedClient.reviews.push(canonicalReview());
  failedClient.rollupState = 'FAILURE';
  failedClient.ciContexts = [fullValidationCheck({ conclusion: 'FAILURE' })];
  const failed = workflow(pendingState('discovery'), failedClient);
  const failedResult = await failed.api.advance(2);
  assert.deepEqual(failedResult.performedTransitions, ['review-outcome', 'ci-validation']);
  assert.equal(failedResult.terminal, 'failure');
  assert.equal(failedResult.ciValidation.status, 'failed');
  assert.equal(failed.state.calls.filter((call) => call.name === 'checkpointCiValidation').length, 1);
});

test('advance preserves second-snapshot CI waits and converges concurrent completion', async () => {
  class SecondRollupRaceClient extends FakeClient {
    constructor(code) {
      super();
      this.code = code;
      this.checkReads = 0;
      this.onSecondRead = null;
      this.restoreAfterSecondRead = false;
      this.reviews.push(canonicalReview({
        url: 'https://github.com/example/aerstello/pull/2#pullrequestreview-201',
      }));
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks' && this.restoreAfterSecondRead && this.checkReads >= 2) {
        this.rollupState = 'SUCCESS';
        this.ciContexts = [fullValidationCheck()];
      }
      if (input.name === 'PullRequestChecks' && ++this.checkReads === 2) {
        if (this.code === 'CI_VALIDATION_PENDING') {
          this.rollupState = 'PENDING';
          this.ciContexts = [fullValidationCheck({
            status: 'IN_PROGRESS', conclusion: null, completedAt: null,
          })];
        } else {
          this.ciContexts = [fullValidationCheck({ name: 'another check' })];
        }
        if (this.onSecondRead) await this.onSecondRead();
      }
      return super.graphql(input);
    }
  }

  for (const code of ['CI_VALIDATION_PENDING', 'CI_CHECK_MISSING']) {
    const client = new SecondRollupRaceClient(code);
    const setup = workflow(completedState(), client);
    const result = await setup.api.advance(2);
    assert.equal(client.checkReads, 2);
    assert.equal(result.terminal, 'waiting');
    assert.equal(result.waiting, true);
    assert.equal(result.nextAction, 'Await authoritative Full validation CI evidence.');
    assert.deepEqual(result.performedTransitions, []);
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCiValidation'), false);
    await assert.rejects(() => setup.api.collectCi(2), { code });

    const concurrentClient = new SecondRollupRaceClient(code);
    const concurrent = workflow(completedState(), concurrentClient);
    concurrentClient.restoreAfterSecondRead = true;
    concurrentClient.onSecondRead = async () => {
      const ciState = await concurrent.state.checkpointCiValidation({
        prNumber: 2, expectedRevision: concurrent.state.current.revision, evidence: passedCiEvidence(),
      });
      await concurrent.state.checkpointCompletion({
        prNumber: 2, expectedRevision: ciState.revision,
        pushedHeadSha: HEAD, prHeadSha: HEAD, prState: 'OPEN', isDraft: false,
      });
    };
    const concurrentResult = await concurrent.api.advance(2);
    assert.equal(concurrentClient.checkReads, 4);
    assert.equal(concurrentResult.phase, 'complete');
    assert.equal(concurrentResult.terminal, 'done');
    assert.equal(concurrentResult.waiting, false);
    assert.deepEqual(concurrentResult.performedTransitions, []);
    assert.equal(concurrent.state.calls.filter((call) => call.name === 'checkpointCiValidation').length, 1);
    assert.equal(concurrent.state.calls.filter((call) => call.name === 'checkpointCompletion').length, 1);
  }
});

test('advance treats transient CI during completion as waiting and revalidates a concurrent Done winner', async () => {
  class CompletionCiRaceClient extends FakeClient {
    constructor(code, mutateAt) {
      super();
      this.code = code;
      this.mutateAt = mutateAt;
      this.checkReads = 0;
      this.restoreAfterTransient = false;
      this.onTransient = null;
      this.reviews.push(canonicalReview());
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks') {
        this.checkReads += 1;
        if (this.restoreAfterTransient && this.checkReads > this.mutateAt) {
          this.rollupState = 'SUCCESS';
          this.ciContexts = [fullValidationCheck()];
        } else if (this.checkReads === this.mutateAt) {
          if (this.code === 'CI_VALIDATION_PENDING') {
            this.rollupState = 'PENDING';
            this.ciContexts = [fullValidationCheck({
              status: 'IN_PROGRESS', conclusion: null, completedAt: null,
            })];
          } else {
            this.ciContexts = [fullValidationCheck({ name: 'another check' })];
          }
          if (this.onTransient) await this.onTransient();
        }
      }
      return super.graphql(input);
    }
  }

  for (const code of ['CI_VALIDATION_PENDING', 'CI_CHECK_MISSING']) {
    for (const mutateAt of [3, 4]) {
      const client = new CompletionCiRaceClient(code, mutateAt);
      const setup = workflow(completedState(), client);
      const result = await setup.api.advance(2);
      assert.equal(result.terminal, 'waiting');
      assert.equal(result.waiting, true);
      assert.deepEqual(result.performedTransitions, ['ci-validation']);
      assert.equal(setup.state.calls.filter((call) => call.name === 'checkpointCiValidation').length, 1);
      assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCompletion'), false);
    }
  }

  const concurrentClient = new CompletionCiRaceClient('CI_VALIDATION_PENDING', 3);
  concurrentClient.restoreAfterTransient = true;
  const concurrent = workflow(completedState(), concurrentClient);
  concurrentClient.onTransient = async () => {
    await concurrent.state.checkpointCompletion({
      prNumber: 2, expectedRevision: concurrent.state.current.revision,
      pushedHeadSha: HEAD, prHeadSha: HEAD, prState: 'OPEN', isDraft: false,
    });
  };
  const concurrentResult = await concurrent.api.advance(2);
  assert.equal(concurrentResult.terminal, 'done');
  assert.equal(concurrentResult.waiting, false);
  assert.equal(concurrentResult.phase, 'complete');
  assert.deepEqual(concurrentResult.performedTransitions, ['ci-validation']);
  assert.equal(concurrentClient.checkReads, 5);
  assert.equal(concurrent.state.calls.filter((call) => call.name === 'checkpointCompletion').length, 1);
});

test('advance is idempotent for Done and converges CI and completion winners without claiming their writes', async () => {
  const doneClient = new FakeClient();
  doneClient.reviews.push(canonicalReview());
  const done = workflow(completedState({ phase: 'complete', ciValidationStatus: passedCiEvidence(),
    ciValidationHistory: [passedCiEvidence()] }), doneClient);
  const doneResult = await done.api.advance(2);
  assert.deepEqual(doneResult.performedTransitions, []);
  assert.equal(doneResult.phase, 'complete');
  assert.equal(done.client.calls.filter((call) => call.name === 'PullRequestMetadata').length, 2);
  assert.equal(done.client.calls.filter((call) => call.name === 'PullRequestChecks').length, 2);
  assert.equal(done.state.calls.length, 0);

  const manualDone = await done.api.complete(2);
  assert.equal(manualDone.idempotent, true);
  assert.equal(manualDone.performed, false);
  assert.equal(done.client.calls.filter((call) => call.name === 'PullRequestMetadata').length, 4);
  assert.equal(done.client.calls.filter((call) => call.name === 'PullRequestChecks').length, 4);
  assert.equal(done.state.calls.length, 0);

  const ciWinnerClient = new FakeClient();
  ciWinnerClient.reviews.push(canonicalReview());
  const ciWinner = workflow(pendingState('discovery'), ciWinnerClient);
  ciWinner.state.setBeforeCheckpointForTest(({ input, current, replaceCurrent }) => {
    replaceCurrent({ ...current, revision: current.revision + 1, ciValidationStatus: input.evidence,
      ciValidationHistory: [...current.ciValidationHistory, input.evidence] });
  }, 'checkpointCiValidation');
  const ciWinnerResult = await ciWinner.api.advance(2);
  assert.deepEqual(ciWinnerResult.performedTransitions, ['review-outcome', 'cycle-completion']);

  const completionWinnerClient = new FakeClient();
  completionWinnerClient.reviews.push(canonicalReview());
  const completionWinner = workflow(pendingState('discovery'), completionWinnerClient);
  completionWinner.state.setBeforeCheckpointForTest(({ current, replaceCurrent }) => {
    replaceCurrent({ ...current, revision: current.revision + 1, phase: 'complete' });
  }, 'checkpointCompletion');
  const completionWinnerResult = await completionWinner.api.advance(2);
  assert.deepEqual(completionWinnerResult.performedTransitions, ['review-outcome', 'ci-validation']);
  assert.equal(completionWinnerResult.phase, 'complete');
});

test('Done revalidation fails closed on stale live evidence and revision races', async () => {
  const completeState = () => completedState({
    phase: 'complete', ciValidationStatus: passedCiEvidence(),
    ciValidationHistory: [passedCiEvidence()],
  });
  for (const { metadata, code } of [
    { metadata: { state: 'CLOSED' }, code: 'PR_NOT_OPEN' },
    { metadata: { state: 'MERGED' }, code: 'PR_NOT_OPEN' },
    { metadata: { isDraft: true }, code: 'PR_DRAFT' },
    { metadata: { headRefOid: OTHER_HEAD }, code: 'MUTATION_NOT_READY' },
  ]) {
    const client = new FakeClient({ metadata });
    client.reviews.push(canonicalReview());
    const setup = workflow(completeState(), client);
    await assert.rejects(() => setup.api.advance(2), { code });
    assert.equal(setup.state.calls.length, 0);
  }

  const missingReview = workflow(completeState(), new FakeClient());
  await assert.rejects(() => missingReview.api.advance(2), { code: 'COMPLETION_NOT_READY' });
  assert.equal(missingReview.state.calls.length, 0);

  class DoneRootRaceClient extends FakeClient {
    constructor() { super(); this.metadataReads = 0; this.reviews.push(canonicalReview()); }
    async graphql(input) {
      if (input.name === 'PullRequestMetadata' && ++this.metadataReads === 2) {
        addThread(this, { id: 'THREAD_done_race', resolved: true });
      }
      return super.graphql(input);
    }
  }
  const rootRace = workflow(completeState(), new DoneRootRaceClient());
  await assert.rejects(() => rootRace.api.advance(2), (error) =>
    ['ROOT_IDENTITY_MISMATCH', 'THREAD_PROOF_STALE', 'COMPLETION_NOT_READY'].includes(error.code));
  assert.equal(rootRace.state.calls.length, 0);

  class DoneRevisionRaceClient extends FakeClient {
    constructor() { super(); this.checkReads = 0; this.onFinalCheck = null; this.reviews.push(canonicalReview()); }
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestChecks' && ++this.checkReads === 2) this.onFinalCheck();
      return result;
    }
  }
  const revisionClient = new DoneRevisionRaceClient();
  const revisionRace = workflow(completeState(), revisionClient);
  revisionClient.onFinalCheck = () => revisionRace.state.advanceRevisionForTest();
  await assert.rejects(() => revisionRace.api.advance(2), { code: 'STATE_REVISION_CHANGED' });
  assert.equal(revisionRace.state.calls.length, 0);
});

test('advance waits but complete stays strict when durable Done CI is pending or missing', async () => {
  const completeState = () => completedState({
    phase: 'complete', ciValidationStatus: passedCiEvidence(),
    ciValidationHistory: [passedCiEvidence()],
  });
  for (const code of ['CI_VALIDATION_PENDING', 'CI_CHECK_MISSING']) {
    const makeClient = () => {
      const client = new FakeClient();
      client.reviews.push(canonicalReview());
      if (code === 'CI_VALIDATION_PENDING') {
        client.rollupState = 'PENDING';
        client.ciContexts = [fullValidationCheck({
          status: 'IN_PROGRESS', conclusion: null, completedAt: null,
        })];
      } else {
        client.ciContexts = [fullValidationCheck({ name: 'another check' })];
      }
      return client;
    };
    const advanced = workflow(completeState(), makeClient());
    const waiting = await advanced.api.advance(2);
    assert.equal(waiting.phase, 'complete');
    assert.equal(waiting.terminal, 'waiting');
    assert.equal(waiting.waiting, true);
    assert.deepEqual(waiting.performedTransitions, []);
    assert.equal(advanced.state.calls.length, 0);

    const manual = workflow(completeState(), makeClient());
    await assert.rejects(() => manual.api.complete(2), { code });
    assert.equal(manual.state.calls.length, 0);
  }
});

test('advance converges an exact outcome winner but rejects mismatched concurrent evidence', async () => {
  const outcomeWinnerClient = new FakeClient();
  outcomeWinnerClient.reviews.push(canonicalReview());
  const outcomeWinner = workflow(pendingState('discovery'), outcomeWinnerClient);
  outcomeWinner.state.setBeforeCheckpointForTest(({ input, current, replaceCurrent }) => {
    const reviewHistory = current.reviewHistory.map((entry, index) => (
      index === current.reviewHistory.length - 1 ? { ...entry, outcome: input.outcome } : entry
    ));
    replaceCurrent({ ...current, revision: current.revision + 1, phase: 'validating',
      reviewedHeadSha: input.outcome.headSha, reviewOutcome: input.outcome, reviewHistory });
  }, 'checkpointReviewOutcome');
  const outcomeWinnerResult = await outcomeWinner.api.advance(2);
  assert.deepEqual(outcomeWinnerResult.performedTransitions, ['ci-validation', 'cycle-completion']);
  assert.equal(outcomeWinnerResult.phase, 'complete');

  const mismatchClient = new FakeClient();
  mismatchClient.reviews.push(canonicalReview());
  const mismatch = workflow(pendingState('discovery'), mismatchClient);
  mismatch.state.setBeforeCheckpointForTest(({ input, current, replaceCurrent }) => {
    replaceCurrent({ ...current, revision: current.revision + 1,
      ciValidationStatus: { ...input.evidence, checkRunId: 'CHECK_other' },
      ciValidationHistory: [...current.ciValidationHistory, { ...input.evidence, checkRunId: 'CHECK_other' }] });
  }, 'checkpointCiValidation');
  await assert.rejects(() => mismatch.api.advance(2), { code: 'STATE_REVISION_CONFLICT' });
});

test('complete performs fresh live proof and uses guarded completion only when exact clean state applies', async () => {
  const goodClient = new FakeClient();
  goodClient.reviews.push(canonicalReview());
  const good = workflow(completedState(), goodClient);
  const result = await good.api.complete(2);
  assert.equal(result.phase, 'complete');
  assert.equal(good.state.calls.at(-1).name, 'checkpointCompletion');
  assert.equal(good.state.calls.at(-2).name, 'checkpointCiValidation');

  const unresolvedClient = new FakeClient();
  addThread(unresolvedClient);
  await assert.rejects(() => workflow(completedState(), unresolvedClient).api.complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
  const driftClient = new FakeClient();
  driftClient.metadata.headRefOid = OTHER_HEAD;
  await assert.rejects(() => workflow(completedState(), driftClient).api.complete(2), {
    code: 'MUTATION_NOT_READY',
  });
  await assert.rejects(() => workflow(completedState(), new FakeClient()).api.complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
  const unrecordedResolved = new FakeClient();
  addThread(unrecordedResolved, { resolved: true });
  unrecordedResolved.reviews.push(canonicalReview());
  await assert.rejects(() => workflow(completedState(), unrecordedResolved).api.complete(2), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
});

test('complete freshly revalidates the recorded clean review submission body', async () => {
  const whitespaceClient = new FakeClient();
  whitespaceClient.reviews.push(canonicalReview({ body: ' \n\t ' }));
  assert.equal(
    (await workflow(completedState(), whitespaceClient).api.complete(2)).phase,
    'complete',
  );

  for (const [label, body, omitBody] of [
    ['nonempty', 'A newly visible threadless finding.', false],
    ['missing', undefined, true],
    ['null', null, false],
    ['number', 1, false],
  ]) {
    const client = new FakeClient();
    const review = canonicalReview({ body });
    if (omitBody) delete review.body;
    client.reviews.push(review);
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), {
      code: 'COMPLETION_NOT_READY',
    }, label);
    assert.equal(setup.state.calls.length, 0, label);
  }
});

test('complete freshly revalidates structural-comment identity and content', async () => {
  const goodClient = new FakeClient();
  goodClient.comments.push(cleanIssueComment());
  assert.equal((await workflow(issueCommentCompletedState(), goodClient).api.complete(2)).phase, 'complete');

  const changedProseClient = new FakeClient();
  changedProseClient.comments.push(cleanIssueComment({ body: ALTERNATE_STRUCTURAL_COMMENT_BODY }));
  assert.equal(
    (await workflow(issueCommentCompletedState(), changedProseClient).api.complete(2)).phase,
    'complete',
  );

  const mutations = [
    null,
    cleanIssueComment({ id: 'IC_changed' }),
    cleanIssueComment({ databaseId: 999 }),
    cleanIssueComment({ url: 'https://github.com/example/aerstello/pull/2#issuecomment-mutated' }),
    cleanIssueComment({ createdAt: '2026-08-05T00:00:01Z' }),
    cleanIssueComment({ author: { ...BOT, id: 'BOT_changed' } }),
    cleanIssueComment({ author: { ...BOT, login: 'chatgpt-codex-connector-renamed' } }),
    cleanIssueComment({ author: { ...BOT, url: 'https://github.com/apps/another-app' } }),
    cleanIssueComment({ body: ALTERNATE_STRUCTURAL_COMMENT_BODY, lastEditedAt: '2026-08-05T00:00:01Z' }),
    cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace('**Reviewed commit:**', '**Reviewed Commit:**') }),
    cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace(HEAD.slice(0, 10), HEAD.slice(0, 10).toUpperCase()) }),
    cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)) }),
    cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace('`\n\n<details>', '` trailing\n\n<details>') }),
  ];
  for (const comment of mutations) {
    const client = new FakeClient();
    if (comment) client.comments.push(comment);
    await assert.rejects(() => workflow(issueCommentCompletedState(), client).api.complete(2), {
      code: 'COMPLETION_NOT_READY',
    });
  }
});

test('complete rejects a later-resolved root from the structural review request', async () => {
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const reply = {
    id: 'REPLY_resolved', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
  };
  const state = issueCommentCompletedState({
    tasks: [{
      id: 'task-thread', sourceIds: ['thread:THREAD_1'], sourceType: 'github-thread',
      fingerprint: 'fp-thread', summary: 'Fix canonical finding.', severity: 'P1',
      disposition: 'actionable', status: 'completed', integratedCommitSha: HEAD,
      resolutionSummary: 'Fixed the finding.',
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
  const client = new FakeClient();
  client.comments.push(cleanIssueComment());
  addThread(client, { resolved: true, replies: [reply] });
  await assert.rejects(() => workflow(state, client).api.complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
});

test('complete rejects same-SHA and conflicting duplicate structural anchors', async () => {
  const formats = [
    { body: STRUCTURAL_COMMENT_BODY, anchorSha: HEAD.slice(0, 10), conflictingSha: OTHER_HEAD.slice(0, 10) },
    { body: ALTERNATE_STRUCTURAL_COMMENT_BODY, anchorSha: HEAD, conflictingSha: OTHER_HEAD },
  ];
  for (const format of formats) {
    for (const duplicateSha of [format.anchorSha, format.conflictingSha]) {
      const client = new FakeClient();
      client.comments.push(cleanIssueComment({
        body: withDuplicateReviewedCommitAnchor(format.body, duplicateSha),
      }));
      const setup = workflow(issueCommentCompletedState(), client);
      await assert.rejects(() => setup.api.complete(2), { code: 'COMPLETION_NOT_READY' });
      assert.equal(setup.state.calls.length, 0);
      assert.equal(setup.state.current.phase, 'validating');
    }
  }
});

test('complete reruns review and thread proof after checkpointing CI', async () => {
  class FinalSnapshotMutationClient extends FakeClient {
    constructor(mutate) {
      super();
      this.mutate = mutate;
      this.metadataReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestMetadata') {
        this.metadataReads += 1;
        if (this.metadataReads === 2) this.mutate(this);
      }
      return super.graphql(input);
    }
  }

  for (const { mutate, code } of [
    {
      mutate(client) { addThread(client, { id: 'THREAD_late' }); },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.reviews.length = 0; },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.reviews[0].body = 'A late threadless finding.'; },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.comments.length = 0; },
      code: 'REQUEST_PROOF_STALE',
    },
  ]) {
    const client = new FinalSnapshotMutationClient(mutate);
    client.reviews.push(canonicalReview());
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), { code });
    assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCompletion'), false);
  }
});

test('complete rechecks that the same successful workflow evidence is still authoritative', async () => {
  class FinalCiMutationClient extends FakeClient {
    constructor(mutate) {
      super();
      this.mutate = mutate;
      this.checkReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks') {
        this.checkReads += 1;
        if (this.checkReads === 2) this.mutate(this);
      }
      return super.graphql(input);
    }
  }

  for (const { mutate, code } of [
    {
      mutate(client) {
        client.rollupState = 'PENDING';
        client.ciContexts = [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })];
      },
      code: 'CI_VALIDATION_PENDING',
    },
    {
      mutate(client) {
        client.rollupState = 'FAILURE';
        client.ciContexts = [fullValidationCheck({ conclusion: 'FAILURE' })];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.rollupState = 'FAILURE';
        client.ciContexts = [
          fullValidationCheck(),
          fullValidationCheck({ id: 'CHECK_parallel_failure', conclusion: 'FAILURE',
            completedAt: '2026-08-05T00:01:00Z', checkSuite: {
              app: { slug: 'github-actions' },
              workflowRun: { databaseId: 702,
                url: 'https://github.com/example/aerstello/actions/runs/702',
                file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } },
            } }),
        ];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.ciContexts = [fullValidationCheck({ completedAt: '2026-08-05T00:01:00Z', checkSuite: {
          app: { slug: 'github-actions' },
          workflowRun: { databaseId: 702, url: 'https://github.com/example/aerstello/actions/runs/702',
            file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } },
        } })];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.ciContexts = [fullValidationCheck({ id: 'CHECK_rerun', completedAt: '2026-08-05T00:01:00Z' })];
      },
      code: 'COMPLETION_NOT_READY',
    },
  ]) {
    const client = new FinalCiMutationClient(mutate);
    client.reviews.push(canonicalReview());
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), { code });
    assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCompletion'), false);
  }
});

test('complete ignores unrelated context changes between authoritative CI reads', async () => {
  class UnrelatedContextMutationClient extends FakeClient {
    constructor() {
      super();
      this.checkReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks') {
        this.checkReads += 1;
        if (this.checkReads === 2) {
          this.ciContexts = [
            { __typename: 'StatusContext', id: 'STATUS_late', context: 'late status',
              state: 'FAILURE', targetUrl: 'https://github.com/example/aerstello' },
            { __typename: 'CheckRun', id: 'CHECK_late', databaseId: 999, name: 'late unrelated check',
              status: 'COMPLETED', conclusion: 'FAILURE', completedAt: AT,
              detailsUrl: 'https://github.com/example/aerstello/actions/runs/999/job/999', checkSuite: null },
            fullValidationCheck(),
          ];
        }
      }
      return super.graphql(input);
    }
  }

  const client = new UnrelatedContextMutationClient();
  client.reviews.push(canonicalReview());
  const setup = workflow(completedState(), client);
  const result = await setup.api.complete(2);
  assert.equal(result.phase, 'complete');
  assert.equal(setup.state.calls.at(-1).name, 'checkpointCompletion');
  assert.deepEqual(setup.state.current.ciValidationStatus.checks, ['Full validation']);
});
