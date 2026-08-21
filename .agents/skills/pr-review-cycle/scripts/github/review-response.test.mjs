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

test('collect accepts only canonical exact request THUMBS_UP and ignores noncanonical evidence', async () => {
  const client = new FakeClient();
  client.reactions.set('IC_request', [
    { id: 'REACTION_bad', content: 'THUMBS_UP', createdAt: AT, user: VIEWER },
    { id: 'REACTION_good', content: 'THUMBS_UP', createdAt: AT, user: BOT },
  ]);
  client.reviews.push({
    id: 'REVIEW_noncanonical', databaseId: 1, url: 'https://x/review', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: VIEWER,
  });
  const { api, state } = workflow(pendingState(), client);
  const result = await api.collect(2);
  assert.equal(result.outcome.evidenceType, 'request-reaction');
  assert.equal(result.outcome.reactionCommentId, 'IC_request');
  assert.equal(result.outcome.reviewerLogin, BOT.login);
  assert.equal(state.calls.at(-1).name, 'checkpointReviewOutcome');
});

test('collect conservatively classifies canonical review bodies and attached roots', async () => {
  for (const [kind, expectedPhase] of [
    ['discovery', 'triaging'],
    ['verification', 'triaging'],
  ]) {
    const client = new FakeClient();
    client.reviews.push(canonicalReview({
      id: `PRR_body_${kind}`,
      body: 'Arbitrary canonical review body; its prose is not parsed.',
    }));
    const setup = workflow(pendingState(kind), client);
    const result = await setup.api.collect(2);
    assert.equal(result.outcome.outcome, 'findings');
    assert.equal(result.outcome.evidenceType, 'review-submission');
    assert.equal(result.phase, expectedPhase);
    assert.equal(client.threads.length, 0, 'a nonempty body needs no attached root');
  }

  for (const body of ['', ' \n\t ']) {
    const client = new FakeClient();
    client.reviews.push(canonicalReview({ body }));
    const result = await workflow(pendingState('discovery'), client).api.collect(2);
    assert.equal(result.outcome.outcome, 'clean');
    assert.equal(result.phase, 'validating');
  }

  const attachedClient = new FakeClient();
  attachedClient.reviews.push(canonicalReview({ id: 'PRR_attached', body: '' }));
  addThread(attachedClient, {
    root: rootComment('THREAD_1', { pullRequestReview: { id: 'PRR_attached' } }),
  });
  const attached = await workflow(pendingState('discovery'), attachedClient).api.collect(2);
  assert.equal(attached.outcome.outcome, 'findings');
  assert.equal(attached.phase, 'triaging');
});

test('collect rejects canonical reviews with missing or non-string bodies as unsupported', async () => {
  for (const [label, body, omitBody] of [
    ['missing', undefined, true],
    ['null', null, false],
    ['number', 1, false],
    ['object', {}, false],
  ]) {
    for (const kind of ['discovery', 'verification']) {
      const client = new FakeClient();
      const review = canonicalReview({ id: `PRR_${label}_${kind}`, body });
      if (omitBody) delete review.body;
      client.reviews.push(review);
      const setup = workflow(pendingState(kind), client);
      if (kind === 'discovery') {
        await assert.rejects(() => setup.api.collect(2), {
          code: 'DISCOVERY_COLLECTION_UNRESOLVED',
        }, label);
        assert.equal(setup.state.calls.length, 0, label);
      } else {
        const result = await setup.api.collect(2);
        assert.equal(result.escalated, true, label);
        assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence', label);
        assert.deepEqual(result.escalation.evidenceIds, [`review:${review.id}`], label);
      }
      assert.equal(client.events.length, 0, label);
    }
  }
});

test('collect records a unique canonical exact-head structural comment at the request boundary', async () => {
  const client = new FakeClient();
  client.comments.push(cleanIssueComment());
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.collect(2);
  assert.equal(result.outcome.evidenceType, 'issue-comment');
  assert.equal(result.outcome.outcome, 'clean');
  assert.equal(result.outcome.headSha, HEAD);
  assert.equal(result.outcome.databaseId, 202);
  assert.equal(result.outcome.reactionContent, null);
  assert.equal(result.phase, 'validating');
  assert.equal(setup.state.current.ciValidationStatus.status, 'not-run');
});

test('collect records changed surrounding prose with exact immutable identity', async () => {
  const client = new FakeClient();
  const observed = cleanIssueComment({
    id: 'IC_kwDOTqOdrM8AAAABNuD83Q', databaseId: 5215681757,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-5215681757',
    body: ALTERNATE_STRUCTURAL_COMMENT_BODY,
  });
  client.comments.push(observed);
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.collect(2);
  assert.deepEqual(result.outcome, {
    id: observed.id, databaseId: observed.databaseId, url: observed.url,
    headSha: HEAD, at: observed.createdAt, requestId: 'IC_request', kind: 'discovery',
    outcome: 'clean', evidenceType: 'issue-comment', reviewerLogin: BOT.login,
    reviewerNodeId: BOT.id, reviewerType: BOT.__typename, reviewerUrl: BOT.url,
    reactionContent: null, reactionCommentId: null,
  });
  assert.equal(
    client.comments.find((comment) => comment.id === observed.id).body,
    ALTERNATE_STRUCTURAL_COMMENT_BODY,
  );
  assert.equal(setup.state.calls.at(-1).name, 'checkpointReviewOutcome');
});

test('collect rejects same-SHA and conflicting duplicate structural anchors', async () => {
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
      const setup = workflow(pendingState('discovery'), client);
      await assert.rejects(() => setup.api.collect(2), {
        code: 'DISCOVERY_COLLECTION_UNRESOLVED',
      });
      assert.equal(setup.state.calls.length, 0);
      assert.equal(setup.state.current.reviewOutcome, null);
    }
  }

  const unsupportedClient = new FakeClient();
  const unsupportedComment = cleanIssueComment({
    body: withDuplicateReviewedCommitAnchor(ALTERNATE_STRUCTURAL_COMMENT_BODY, HEAD),
  });
  unsupportedClient.comments.push(unsupportedComment);
  const unsupported = await workflow(pendingState('verification'), unsupportedClient).api.collect(2);
  assert.equal(unsupported.escalated, true);
  assert.equal(unsupported.escalation.reason, 'ambiguous-canonical-evidence');
  assert.deepEqual(unsupported.escalation.evidenceIds, [`issue-comment:${unsupportedComment.id}`]);
});

test('collect ignores historical structural comments from prior requests', async () => {
  const historical = cleanIssueComment({
    id: 'IC_historical', databaseId: 199, createdAt: '2026-08-04T23:59:59Z',
    author: { ...BOT, id: null },
    body: STRUCTURAL_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)),
  });
  const historicalOnlyClient = new FakeClient();
  historicalOnlyClient.comments.push(historical);
  const historicalOnly = workflow(pendingState('discovery'), historicalOnlyClient);
  await assert.rejects(() => historicalOnly.api.collect(2), {
    code: 'DISCOVERY_COLLECTION_UNRESOLVED',
  });
  assert.equal(historicalOnly.state.current.phase, 'awaiting-review');
  assert.equal(historicalOnly.state.current.reviewOutcome, null);
  assert.equal(historicalOnly.state.current.verificationEscalation, null);
  assert.equal(historicalOnly.state.calls.length, 0);

  const current = cleanIssueComment({
    id: 'IC_current', databaseId: 203, createdAt: '2026-08-05T00:00:01Z',
  });
  const currentClient = new FakeClient();
  currentClient.comments.push(historical, current);
  const currentSetup = workflow(pendingState('discovery'), currentClient);
  const collected = await currentSetup.api.collect(2);
  assert.equal(collected.outcome.id, current.id);
  assert.equal(collected.outcome.databaseId, current.databaseId);
  assert.equal(collected.outcome.evidenceType, 'issue-comment');
  assert.equal(currentSetup.state.calls.length, 1);
  assert.equal(currentSetup.state.calls[0].name, 'checkpointReviewOutcome');
});

test('structural issue comments fail closed for identity, marker, and Git resolution', async () => {
  const cases = [
    { comment: cleanIssueComment({ author: VIEWER }) },
    { comment: cleanIssueComment({ body: 'Prose.\n\n**Reviewed commit:** `not-a-sha`' }) },
    { comment: cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)) }) },
    { comment: cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace('Reviewed commit', 'Reviewed Commit') }) },
    { comment: cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace(HEAD.slice(0, 10), HEAD.slice(0, 10).toUpperCase()) }) },
    { comment: cleanIssueComment({ body: STRUCTURAL_COMMENT_BODY.replace('`\n\n<details>', '` trailing\n\n<details>') }) },
    { comment: cleanIssueComment({ lastEditedAt: '2026-08-05T00:00:01Z' }) },
    { comment: cleanIssueComment(), git: fakeGit({ resolveCommitPrefix: async () => [] }) },
    { comment: cleanIssueComment(), git: fakeGit({ resolveCommitPrefix: async () => [HEAD, OTHER_HEAD] }) },
  ];
  for (const entry of cases) {
    const client = new FakeClient();
    client.comments.push(entry.comment);
    await assert.rejects(
      () => workflow(pendingState('discovery'), client, { git: entry.git }).api.collect(2),
      { code: 'DISCOVERY_COLLECTION_UNRESOLVED' },
    );
  }

  const incomplete = new FakeClient();
  incomplete.comments.push(cleanIssueComment({ author: { ...BOT, id: null } }));
  await assert.rejects(() => workflow(pendingState('discovery'), incomplete).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
});

test('surrounding structural-comment prose does not affect clean classification', async () => {
  const anchor = `**Reviewed commit:** \`${HEAD.slice(0, 10)}\``;
  const variants = [
    anchor,
    `Chef's kiss.\n\n${anchor}`,
    `Codex Review: Didn't find any major issues. :tada:\n\n${anchor}`,
    `Arbitrary heading\n${anchor}\nArbitrary footer`,
  ];
  for (const [index, body] of variants.entries()) {
    const client = new FakeClient();
    const comment = cleanIssueComment({ id: `IC_variant_${index}`, databaseId: 300 + index, body });
    client.comments.push(comment);
    const setup = workflow(pendingState('discovery'), client);
    const result = await setup.api.collect(2);
    assert.equal(result.escalated, false);
    assert.equal(result.outcome.id, comment.id);
    assert.equal(result.outcome.outcome, 'clean');
    assert.equal(setup.state.calls.at(-1).name, 'checkpointReviewOutcome');
  }
});

test('unrelated and foreign top-level comments do not create structural evidence', async () => {
  const ignoredOnly = new FakeClient();
  ignoredOnly.comments.push(cleanIssueComment({
    body: 'Canonical status prose without a reviewed-commit marker.',
  }));
  await assert.rejects(() => workflow(pendingState('verification'), ignoredOnly).api.collect(2), {
    code: 'REVIEW_NOT_AVAILABLE',
  });

  const client = new FakeClient();
  const exact = cleanIssueComment({ id: 'IC_exact', databaseId: 204 });
  client.comments.push(
    cleanIssueComment({ id: 'IC_unrelated', databaseId: 202, body: 'Unrelated canonical status.' }),
    cleanIssueComment({ id: 'IC_foreign', databaseId: 203, author: VIEWER }),
    exact,
  );
  const result = await workflow(pendingState('discovery'), client).api.collect(2);
  assert.equal(result.outcome.id, exact.id);
  assert.equal(result.outcome.outcome, 'clean');
});

test('post-request canonical roots prevent structural clean evidence after resolution', async () => {
  for (const resolved of [false, true]) {
    const client = new FakeClient();
    const comment = cleanIssueComment({ id: `IC_root_${resolved}`, databaseId: resolved ? 204 : 203 });
    client.comments.push(comment);
    addThread(client, { resolved });
    const result = await workflow(pendingState('verification'), client).api.collect(2);
    assert.equal(result.escalated, true);
    assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence');
    assert.deepEqual(result.escalation.evidenceIds.sort(), [
      `issue-comment:${comment.id}`, 'review-root:ROOT_THREAD_1',
    ].sort());
  }

  const historicalRoot = new FakeClient();
  historicalRoot.comments.push(cleanIssueComment());
  addThread(historicalRoot, {
    resolved: true,
    root: rootComment('THREAD_1', { createdAt: '2026-08-04T23:59:59Z' }),
  });
  const collected = await workflow(pendingState('discovery'), historicalRoot).api.collect(2);
  assert.equal(collected.outcome.outcome, 'clean');
});

test('structural issue comments remain ambiguous beside any second canonical evidence', async () => {
  const mixed = new FakeClient();
  mixed.comments.push(
    cleanIssueComment(),
    cleanIssueComment({ id: 'IC_clean_alternate', databaseId: 203, body: ALTERNATE_STRUCTURAL_COMMENT_BODY }),
  );
  await assert.rejects(() => workflow(pendingState('discovery'), mixed).api.collect(2), {
    code: 'DISCOVERY_COLLECTION_UNRESOLVED',
  });

  for (const body of [STRUCTURAL_COMMENT_BODY, ALTERNATE_STRUCTURAL_COMMENT_BODY]) {
    for (const second of ['review', 'reaction']) {
      const client = new FakeClient();
      client.comments.push(cleanIssueComment({ body }));
      if (second === 'review') client.reviews.push({
        id: 'PRR_clean_2', databaseId: 204, url: 'https://x/review', body: '', state: 'COMMENTED',
        submittedAt: AT, commit: { oid: HEAD }, author: BOT,
      });
      if (second === 'reaction') client.reactions.set('IC_request', [{
        id: 'REACTION_clean_2', content: 'THUMBS_UP', createdAt: AT, user: BOT,
      }]);
      await assert.rejects(() => workflow(pendingState('discovery'), client).api.collect(2), {
        code: 'DISCOVERY_COLLECTION_UNRESOLVED',
      });
    }
  }
});

test('collect recovers exact-anchor live drift but escalates stale or ambiguous evidence', async () => {
  const driftClient = new FakeClient();
  driftClient.metadata.headRefOid = OTHER_HEAD;
  const drift = workflow(pendingState(), driftClient);
  await assert.rejects(() => drift.api.collect(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(drift.state.calls.some((call) => call.name === 'checkpointVerificationEscalation'), false);

  const staleClient = new FakeClient();
  staleClient.reviews.push({
    id: 'REVIEW_stale', databaseId: 1, url: 'https://x/stale', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: OTHER_HEAD }, author: BOT,
  });
  const stale = await workflow(pendingState(), staleClient).api.collect(2);
  assert.equal(stale.escalation.reason, 'stale-canonical-evidence');
  assert.equal(stale.escalation.headRelation, 'same');

  const ambiguousClient = new FakeClient();
  ambiguousClient.reviews.push({
    id: 'REVIEW_exact', databaseId: 2, url: 'https://x/exact', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  ambiguousClient.reactions.set('IC_request', [{ id: 'REACTION_exact', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  const ambiguous = await workflow(pendingState(), ambiguousClient).api.collect(2);
  assert.equal(ambiguous.escalation.reason, 'ambiguous-canonical-evidence');
  assert.equal(ambiguous.escalation.headRelation, 'same');

  const absent = workflow(pendingState(), new FakeClient());
  await assert.rejects(() => absent.api.collect(2), { code: 'REVIEW_NOT_AVAILABLE' });
  assert.equal(absent.state.calls.length, 0);
});

test('exact-anchor stale collection recovers for either kind and verification findings return to triage', async () => {
  const staleDiscovery = new FakeClient();
  staleDiscovery.metadata.headRefOid = OTHER_HEAD;
  const discovery = workflow(pendingState('discovery'), staleDiscovery);
  await assert.rejects(() => discovery.api.collect(2), { code: 'REVIEW_COLLECTION_STALE' });
  assert.equal(discovery.state.calls.some((call) => call.name === 'checkpointVerificationEscalation'), false);

  const findingsClient = new FakeClient();
  findingsClient.reviews.push({
    id: 'PRR_review', databaseId: 3, url: 'https://x/findings', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  addThread(findingsClient, { root: rootComment('THREAD_1', { pullRequestReview: { id: 'PRR_review' } }) });
  const findings = await workflow(pendingState(), findingsClient).api.collect(2);
  assert.equal(findings.outcome.outcome, 'findings');
  assert.equal(findings.phase, 'triaging');
});

test('collect rejects altered or foreign recorded request comments', async () => {
  for (const mutate of [
    (comment) => { comment.body = 'altered'; },
    (comment) => { comment.author = BOT; },
    (comment) => { comment.lastEditedAt = '2026-08-05T00:00:01Z'; },
  ]) {
    const client = new FakeClient();
    const state = pendingState('discovery');
    const setup = workflow(state, client);
    mutate(client.comments[0]);
    await assert.rejects(() => setup.api.collect(2), { code: 'REQUEST_PROOF_STALE' });
  }
});

test('verification treats unsupported review states and stale-plus-exact evidence as ambiguous', async () => {
  for (const reviews of [
    [{ id: 'PENDING', state: 'PENDING', commit: { oid: HEAD } }],
    [{ id: 'EXACT', state: 'COMMENTED', commit: { oid: HEAD } }, { id: 'STALE', state: 'COMMENTED', commit: { oid: OTHER_HEAD } }],
  ]) {
    const client = new FakeClient();
    client.reviews = reviews.map((review) => ({ databaseId: 1, url: 'https://x/review', body: '', submittedAt: AT, author: BOT, ...review }));
    const { api } = workflow(pendingState('verification'), client);
    const result = await api.collect(2);
    assert.equal(result.escalated, true);
  }
});

test('altered verification anchors remain ambiguous even when the live HEAD changes', async () => {
  const client = new FakeClient();
  const setup = workflow(pendingState('verification'), client);
  client.comments[0].body = 'edited';
  const result = await setup.api.collect(2);
  assert.equal(result.escalated, true);
  assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence');
  assert.equal(result.escalation.headRelation, 'same');

  const headDrift = new FakeClient();
  const headDriftSetup = workflow(pendingState('verification'), headDrift);
  headDrift.comments[0].body = 'edited';
  headDrift.metadata.headRefOid = OTHER_HEAD;
  await assert.rejects(() => headDriftSetup.api.collect(2), { code: 'MUTATION_NOT_READY' });
  const discovery = workflow(pendingState('discovery'));
  discovery.client.comments[0].createdAt = '2026-08-05T00:00:00.001Z';
  await assert.rejects(() => discovery.api.collect(2), { code: 'REQUEST_PROOF_STALE' });
});

test('canonical outcome evidence has no early timestamp tolerance', async () => {
  const client = new FakeClient();
  const setup = workflow(pendingState('verification'), client);
  client.reactions.set('IC_request', [{ id: 'REACTION_early', content: 'THUMBS_UP',
    createdAt: '2026-08-04T23:59:59.999Z', user: BOT }]);
  const result = await setup.api.collect(2);
  assert.equal(result.escalated, true);
  assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence');
});
