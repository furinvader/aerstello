import * as harness from './test-support/state-harness.mjs';

const {
  assert,
  spawn,
  spawnSync,
  createHash,
  afterEach,
  test,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  tmpdir,
  dirname,
  join,
  fileURLToPath,
  ACTIVE_STATE_LIMIT_BYTES,
  activePointerPath,
  archiveState,
  assertTaskPacketBound,
  buildCompletionTransition,
  buildCiValidationTransition,
  buildTargetedValidationPlan,
  buildReviewOutcomeTransition,
  buildReviewRequestTransition,
  buildVerificationEscalationTransition,
  rawCheckpointCompletion,
  checkpointArchiveTaskCompletion,
  checkpointCiValidation,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequestLimit,
  rawCheckpointReviewRequest,
  checkpointState,
  checkpointTaskPacketBinding,
  checkpointTaskPacketReplan,
  checkpointWorkerResultAcceptance,
  checkpointWorkerResultBackfill,
  checkpointTaskCompletion,
  checkpointTargetedValidation,
  checkpointTargetedValidationReset,
  checkpointVerificationEscalation,
  completionGate,
  completeIntegratedTasks,
  ensureGitHubMutationIntent,
  claimGitHubMutationDispatch,
  executeTargetedValidationPlan,
  gitAwareGateContext,
  gitCommonDirectory,
  initializeState,
  inspectWorkerCommitAuthority,
  loadState,
  migratePrReviewStateV1,
  migratePrReviewStateV2,
  migrateState,
  planSpecialists,
  readSpecialistStatus,
  reconcileState,
  recordSpecialistReview,
  renderRecoverySummary,
  reviewRequestGate,
  reviewRequestUsage,
  reviewRoot,
  stateDirectory,
  statePath,
  StateError,
  taskPacketDigest,
  taskBindingProvenancePath,
  taskBindingProvenanceReceiptPath,
  taskPacketSidecarPath,
  workerResultEnvelopePath,
  workerResultReceiptPath,
  specialistContext,
  specialistPlanReceiptPath,
  specialistReviewBundlePath,
  validationPlanPath,
  withStateLock,
  withGitHubRequestOwnerLock,
  buildStaleDiscoveryDisposition,
  staleDiscoveryDispositionId,
  routeSpecialists,
  commit,
  createRepository,
  git,
  repositories,
  AT,
  checkpointReviewRequest,
  checkpointCompletion,
  STATE_CLI,
  STATE_MODULE_URL,
  LOCK_HOLDER_SOURCE,
  LEGACY_LOCK_RELEASE_SOURCE,
  spawnLockHolder,
  spawnLegacyLockRelease,
  waitForLockHolder,
  waitForChildExit,
  repo,
  init,
  task,
  emptyThreadless,
  emptyLocalVerification,
  ready,
  canonicalJsonForTest,
  archiveImportDigest,
  archiveImportStateFixture,
  checkpointSyntheticTargetedValidation,
  persistReady,
  external,
  request,
  outcome,
  ciEvidence,
  legacyState,
  schemaV2State,
  migrateTasklessPendingReview,
  migrateCompletedTaskCycle,
  migrateCompletedTaskPendingReview,
  legacyTask,
  taskPacket,
  workerResult,
  historicalTaskPacketV2,
  migrateV2BoundTask,
  initialSelection,
  nativeTasklessReview,
  nativeTasklessPendingVerification,
  nativeStaleDiscoveryDisposition,
  integratedTasks,
  bindPackets,
  planInput,
  bindPacket,
  writePreAuthorityImplementedState,
  writePreAuthorityTasks,
  canonicalBoundIntegratedTask,
  tasklessVerifierFixture,
  appendVerifierOutcomeTasks,
  completeLocalPacketTask,
  completedAndIntegratedPacketFixture,
  dependentWorkerAcceptanceFixture,
  durableAcceptanceSnapshot,
  repositoryAuthoritySnapshot,
  boundWorkerResultFixture,
  acceptedWorkerStateProjection,
} = harness;

test('verification collection escalation is guarded, append-only, request-bound, and human-gated', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const migrated = migratePrReviewStateV1(legacyState(initialized, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-escalation', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha, prHeadSha: prepared.currentIntegrationHeadSha,
  });
  const escalation = {
    requestId: requested.reviewRequest.id,
    requestHeadSha: requested.reviewRequest.headSha,
    observedPrHeadSha: requested.reviewRequest.headSha,
    headRelation: 'same',
    evidenceIds: ['review:PRR_stale', 'reaction:R_stale'],
    reason: 'ambiguous-canonical-evidence',
    at: AT,
  };
  for (const reason of ['stale-canonical-evidence', 'ambiguous-canonical-evidence']) {
    assert.throws(() => buildVerificationEscalationTransition(requested, {
      ...escalation, reason, observedPrHeadSha: 'f'.repeat(40), headRelation: 'same',
    }), { code: 'INVALID_VERIFICATION_ESCALATION' });
  }
  const built = buildVerificationEscalationTransition(requested, escalation);
  assert.equal(built.phase, 'awaiting-human-decision');
  assert.throws(() => checkpointState({
    cwd, expectedRevision: requested.revision, nextState: built,
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const escalated = checkpointVerificationEscalation({
    cwd, expectedRevision: requested.revision, escalation,
  });
  assert.equal(escalated.verificationReviewUsed, true);
  assert.deepEqual(escalated.reviewHistory, requested.reviewHistory);
  const limitedEscalation = checkpointReviewRequestLimit({
    cwd, expectedRevision: escalated.revision, reviewRequestLimit: 9,
  });
  assert.equal(limitedEscalation.phase, 'awaiting-human-decision');
  assert.deepEqual(limitedEscalation.verificationEscalation, escalation);
  assert.ok(reviewRequestGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.ok(completionGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.throws(() => checkpointState({
    cwd, expectedRevision: limitedEscalation.revision,
    nextState: { ...limitedEscalation, verificationEscalation: null },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: limitedEscalation.revision,
    nextState: {
      ...limitedEscalation,
      verificationEscalation: { ...escalation, evidenceIds: ['review:rewritten'] },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.deepEqual(checkpointVerificationEscalation({
    cwd, expectedRevision: limitedEscalation.revision, escalation,
  }), limitedEscalation);

  const discovery = {
    ...requested, reviewRound: 2, verificationReviewUsed: false,
    reviewRequest: { ...requested.reviewRequest, kind: 'discovery' },
    reviewHistory: [{ request: { ...requested.reviewRequest, kind: 'discovery' }, outcome: null }],
  };
  assert.throws(
    () => buildVerificationEscalationTransition(discovery, escalation),
    { code: 'VERIFICATION_ESCALATION_NOT_EXPECTED' },
  );
});

test('stale verification HEAD drift remains recoverable and cannot be mislabeled as ambiguity', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const migrated = migratePrReviewStateV1(legacyState(initialized, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-head-drift', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha, prHeadSha: prepared.currentIntegrationHeadSha,
  });
  const requestHead = requested.reviewRequest.headSha;
  const observedPrHead = commit(cwd, { 'escalation-drift.txt': 'drift\n' }, 'escalation drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.phase, 'recovering');
  assert.throws(() => checkpointVerificationEscalation({
    cwd, expectedRevision: drifted.revision,
    escalation: {
      requestId: requested.reviewRequest.id, requestHeadSha: requestHead, observedPrHeadSha: observedPrHead,
      headRelation: 'changed', evidenceIds: [`request:${requested.reviewRequest.id}`],
      reason: 'request-head-drift', at: AT,
    },
  }), { code: 'VERIFICATION_ESCALATION_NOT_EXPECTED' });
  assert.equal(drifted.verificationReviewUsed, true);
  assert.equal(drifted.reviewHistory.at(-1).outcome, null);
});

test('native stale pending verification escalates only canonical evidence ambiguity', () => {
  const cwd = repo();
  const requested = nativeTasklessPendingVerification(cwd).requested;
  const requestHead = requested.reviewRequest.headSha;
  const observedPrHead = commit(cwd, {
    'native-escalation-drift.txt': 'drift\n',
  }, 'native pending escalation drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  const escalated = checkpointVerificationEscalation({
    cwd,
    expectedRevision: drifted.revision,
    escalation: {
      requestId: requested.reviewRequest.id,
      requestHeadSha: requestHead,
      observedPrHeadSha: observedPrHead,
      headRelation: 'changed',
      evidenceIds: ['review:PRR_stale'],
      reason: 'request-head-drift',
      at: AT,
    },
  });
  assert.equal(escalated.phase, 'awaiting-human-decision');
  assert.deepEqual(escalated.reviewHistory, drifted.reviewHistory);
  assert.equal(escalated.reviewOutcome, null);
});

test('structured canonical thread proof covers multiple tasks with one reply and completes them once', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const tasks = ['task-a', 'task-b'].map((id) => task(head, {
    id, status: 'integrated', sourceType: 'github-thread', sourceIds: ['thread:PRRT_node'],
  }));
  const proof = {
    status: 'passed', headSha: head, updatedAt: AT,
    threads: [{
      threadNodeId: 'PRRT_node', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 9,
      taskIds: ['task-a', 'task-b'],
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r9',
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
    }],
    threadlessVerification: emptyThreadless(),
  };
  const completed = completeIntegratedTasks({ ...state, tasks }, { threadResolutionStatus: proof });
  assert.ok(completed.tasks.every((item) => item.status === 'completed'));
  assert.equal(completed.threadResolutionStatus.threads.length, 1);
});

test('guarded verifier completion selects only unique integrated local task IDs', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const localA = task(head, { id: 'local-a', status: 'integrated', sourceType: 'local' });
  const localB = task(head, { id: 'local-b', status: 'integrated', sourceType: 'local' });
  const threadless = task(head, {
    id: 'threadless', status: 'integrated', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const proof = {
    status: 'passed', headSha: head, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  const unchanged = completeIntegratedTasks(
    { ...state, tasks: [localA, localB, threadless] },
    { threadResolutionStatus: proof },
  );
  assert.deepEqual(unchanged.tasks.map((item) => item.status), ['integrated', 'integrated', 'integrated']);

  const selected = completeIntegratedTasks(
    { ...state, tasks: [localA, localB, threadless] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['local-b'] },
  );
  assert.deepEqual(selected.tasks.map((item) => item.status), ['integrated', 'completed', 'integrated']);
  assert.deepEqual(selected.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: head, taskIds: ['local-b'], updatedAt: AT,
  });

  const selectedA = completeIntegratedTasks(
    { ...state, tasks: [localA, localB] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['local-a'] },
  );
  const accumulated = completeIntegratedTasks(selectedA, {
    threadResolutionStatus: { ...proof, updatedAt: '2026-08-05T00:01:00Z' },
    verifiedLocalTaskIds: ['local-b'],
  });
  assert.deepEqual(accumulated.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: head, taskIds: ['local-a', 'local-b'], updatedAt: '2026-08-05T00:01:00Z',
  });
  const nextHead = 'b'.repeat(40);
  const drifted = {
    ...accumulated,
    currentIntegrationHeadSha: nextHead,
    git: { ...accumulated.git, headSha: nextHead },
    threadResolutionStatus: {
      ...accumulated.threadResolutionStatus, status: 'not-run', headSha: null, updatedAt: null,
    },
  };
  const reattested = completeIntegratedTasks(drifted, {
    threadResolutionStatus: {
      ...proof, headSha: nextHead, updatedAt: '2026-08-05T00:02:00Z',
    },
    verifiedLocalTaskIds: ['local-b'],
  });
  assert.deepEqual(reattested.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: nextHead, taskIds: ['local-b'], updatedAt: '2026-08-05T00:02:00Z',
  });

  const disposedA = task(head, {
    id: 'disposed-a', status: 'not-applicable', disposition: 'duplicate', sourceType: 'local',
  });
  const disposedB = task(head, {
    id: 'disposed-b', status: 'not-applicable', disposition: 'stale', sourceType: 'local',
  });
  const selectedDisposed = completeIntegratedTasks(
    { ...state, tasks: [disposedA, disposedB] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['disposed-b'] },
  );
  assert.deepEqual(selectedDisposed.tasks.map((item) => item.status), ['not-applicable', 'completed']);
  assert.deepEqual(selectedDisposed.threadResolutionStatus.localVerification.taskIds, ['disposed-b']);

  for (const disposition of [
    'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
  ]) {
    const disposed = task(head, {
      id: `disposed-${disposition}`, status: 'not-applicable', disposition, sourceType: 'local',
    });
    assert.equal(completeIntegratedTasks(
      { ...state, tasks: [disposed] },
      { threadResolutionStatus: proof, verifiedLocalTaskIds: [disposed.id] },
    ).tasks[0].status, 'completed');
  }

  const unintegrated = task(head, { id: 'unintegrated', status: 'proposed', sourceType: 'local' });
  const needsHuman = task(head, {
    id: 'needs-human', status: 'not-applicable', disposition: 'needs-human-decision', sourceType: 'local',
  });

  for (const verifiedLocalTaskIds of [
    ['local-a', 'local-a'], ['missing'], ['threadless'], ['unintegrated'], ['needs-human'], [''], 'local-a',
  ]) {
    assert.throws(() => completeIntegratedTasks(
      { ...state, tasks: [localA, localB, threadless, unintegrated, needsHuman] },
      { threadResolutionStatus: proof, verifiedLocalTaskIds },
    ), { code: 'INVALID_TASK_COMPLETION' });
  }
});

test('pristine local bootstrap completion requires the archive-only internal exception', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const local = task(head, {
    id: 'archive-local', status: 'integrated', sourceType: 'local',
    sourceIds: ['orchestrator:integration-verifier'],
  });
  const proof = {
    ...state.threadResolutionStatus,
    localVerification: {
      status: 'passed', headSha: head, taskIds: [local.id], updatedAt: AT,
    },
  };
  assert.throws(() => completeIntegratedTasks(
    { ...state, tasks: [local] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: [local.id] },
  ), { code: 'INVALID_TASK_COMPLETION' });
  const completed = completeIntegratedTasks(
    { ...state, tasks: [local] },
    {
      threadResolutionStatus: proof,
      verifiedLocalTaskIds: [local.id],
      archiveVerifierBootstrapTaskId: local.id,
    },
  );
  assert.equal(completed.tasks[0].status, 'completed');
  assert.deepEqual(completed.threadResolutionStatus.threadlessVerification,
    state.threadResolutionStatus.threadlessVerification);
  assert.deepEqual(completed.threadResolutionStatus.localVerification, proof.localVerification);
});

test('completion requires every exact source root to have disposition-matched replied resolved proof', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const actionable = task(head, {
    id: 'multi-root', status: 'integrated', sourceType: 'github-thread',
    sourceIds: ['discussion:41', 'thread:PRRT_second'],
  });
  const first = {
    threadNodeId: 'PRRT_first', rootCommentNodeId: 'PRRC_first', rootCommentDatabaseId: 41,
    taskIds: ['multi-root'], disposition: 'fixed', replyId: 'PRRC_reply_1',
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r41', isResolved: true,
    resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
  };
  const second = {
    ...first, threadNodeId: 'PRRT_second', rootCommentNodeId: 'PRRC_second', rootCommentDatabaseId: 42,
    replyId: 'PRRC_reply_2', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r42',
  };
  const proof = {
    status: 'passed', headSha: head, threads: [first], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  assert.equal(
    completeIntegratedTasks({ ...state, tasks: [actionable] }, { threadResolutionStatus: proof }).tasks[0].status,
    'integrated',
  );
  const wrongDisposition = { ...first, disposition: 'invalid' };
  assert.equal(completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [wrongDisposition, second] } },
  ).tasks[0].status, 'integrated');
  assert.throws(() => completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [{ ...first, replyId: null, replyUrl: null }, second] } },
  ), { code: 'INVALID_TASK_COMPLETION' });
  assert.throws(() => completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [{ ...first, isResolved: false, resolvedAt: null, resolvedBy: null }, second] } },
  ), { code: 'INVALID_TASK_COMPLETION' });
  assert.equal(completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [first, second] } },
  ).tasks[0].status, 'completed');
});

test('threadless GitHub task completion requires successful exact-head verification', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const nextHead = 'b'.repeat(40);
  const tasks = [task(head, { id: 'threadless', status: 'integrated', sourceType: 'github-threadless' })];
  const proof = {
    status: 'passed', headSha: head, threads: [], updatedAt: AT,
    threadlessVerification: { status: 'passed', headSha: head, taskIds: ['threadless'], updatedAt: AT },
  };
  assert.doesNotThrow(() => completeIntegratedTasks({ ...state, tasks }, { threadResolutionStatus: proof }));
  assert.equal(completeIntegratedTasks(
    { ...state, tasks },
    { threadResolutionStatus: { ...proof, threadlessVerification: emptyThreadless() } },
  ).tasks[0].status, 'integrated');
  const reconciled = {
    ...state, currentIntegrationHeadSha: nextHead, git: { ...state.git, headSha: nextHead }, tasks,
  };
  const invalidatedProof = {
    ...proof, status: 'not-run', headSha: null, updatedAt: null,
  };
  assert.equal(completeIntegratedTasks(
    reconciled,
    { threadResolutionStatus: invalidatedProof },
  ).tasks[0].status, 'integrated');
  const refreshedProof = {
    ...proof, headSha: nextHead,
    threadlessVerification: { ...proof.threadlessVerification, headSha: nextHead },
  };
  assert.equal(completeIntegratedTasks(
    reconciled,
    { threadResolutionStatus: refreshedProof },
  ).tasks[0].status, 'completed');
});

test('proven non-actionable not-applicable findings become completed-equivalent', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const disposed = task(head, {
    id: 'invalid-finding', status: 'not-applicable', disposition: 'invalid', sourceType: 'github-thread',
    sourceIds: ['thread:PRRT_invalid'], integratedCommitSha: null, resolutionSummary: 'Rejected with evidence.',
  });
  const proof = {
    status: 'passed', headSha: head, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: [{
      threadNodeId: 'PRRT_invalid', rootCommentNodeId: 'PRRC_invalid', rootCommentDatabaseId: 10,
      taskIds: ['invalid-finding'],
      disposition: 'invalid', replyId: 'PRRC_invalid_reply',
      replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r10', isResolved: true, resolvedAt: AT,
      resolvedBy: 'maintainer', observedHeadSha: head,
    }],
  };
  const completed = completeIntegratedTasks({ ...state, tasks: [disposed] }, { threadResolutionStatus: proof });
  assert.equal(completed.tasks[0].status, 'completed');
  assert.equal(completed.tasks[0].integratedCommitSha, null);
});

test('HEAD drift preserves durable task coverage while invalidating and refreshing aggregate proof', () => {
  const cwd = repo();
  const state = init(cwd);
  const headA = state.currentIntegrationHeadSha;
  const proposedTask = task(headA, {
    id: 'thread-task', status: 'proposed', sourceType: 'github-thread', sourceIds: ['thread:PRRT_drift'],
  });
  const proposed = checkpointState({ cwd, nextState: { ...state, tasks: [proposedTask] }, expectedRevision: 0 });
  const integratedTask = task(headA, {
    id: 'thread-task', status: 'integrated', sourceType: 'github-thread', sourceIds: ['thread:PRRT_drift'],
  });
  const integrated = writePreAuthorityTasks(cwd, proposed, [integratedTask]);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: integrated.revision,
    nextState: { ...integrated, tasks: [{ ...integratedTask, status: 'completed' }] },
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  const proofA = {
    status: 'passed', headSha: headA, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: [{
      threadNodeId: 'PRRT_drift', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 11,
      taskIds: ['thread-task'],
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r1',
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: headA,
    }],
  };
  const completedAtA = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proofA, expectedRevision: integrated.revision,
  });
  for (const nextTask of [
    { ...completedAtA.tasks[0], status: 'integrated' },
    { ...completedAtA.tasks[0], integratedCommitSha: 'f'.repeat(40) },
    { ...completedAtA.tasks[0], resolutionSummary: 'Rewritten.' },
  ]) assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision, nextState: { ...completedAtA, tasks: [nextTask] },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision,
    nextState: {
      ...completedAtA,
      threadResolutionStatus: {
        ...completedAtA.threadResolutionStatus,
        threads: [{ ...completedAtA.threadResolutionStatus.threads[0], replyId: 'rewritten-reply' }],
      },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision,
    nextState: {
      ...completedAtA,
      threadResolutionStatus: { ...completedAtA.threadResolutionStatus, threads: [] },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const headB = commit(cwd, { 'next.txt': 'next\n' }, 'next');
  const result = checkpointGitMetadata({ cwd });
  assert.equal(result.state.threadResolutionStatus.status, 'not-run');
  assert.equal(result.state.threadResolutionStatus.threads[0].observedHeadSha, headA);
  assert.equal(result.state.tasks[0].status, 'completed');
  assert.equal(reviewRequestGate(result.state, external(cwd, result.state)).allowed, false);

  const proofB = {
    ...proofA, headSha: headB, updatedAt: '2026-08-05T00:01:00Z',
    threads: proofA.threads,
  };
  const proofRefreshed = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proofB, expectedRevision: result.state.revision,
  });
  const refreshed = ready(proofRefreshed, proofRefreshed.tasks);
  refreshed.validationStatus = {
    source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: headB,
    checks: ['npm run check'], updatedAt: '2026-08-05T00:01:00Z',
  };
  assert.equal(reviewRequestGate(refreshed, external(cwd, refreshed)).allowed, true);
});

test('HEAD drift preserves historical local verifier proof until guarded current-HEAD re-attestation', () => {
  const cwd = repo();
  const initial = init(cwd);
  const headA = initial.currentIntegrationHeadSha;
  const proposedTask = task(headA, { id: 'local-drift', status: 'proposed', sourceType: 'local' });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const integratedTask = task(headA, { id: 'local-drift', status: 'integrated', sourceType: 'local' });
  const integrated = writePreAuthorityTasks(cwd, proposed, [integratedTask]);
  const proofA = {
    status: 'passed', headSha: headA, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  const completed = checkpointTaskCompletion({
    cwd, expectedRevision: integrated.revision, threadResolutionStatus: proofA,
    verifiedLocalTaskIds: ['local-drift'],
  });
  assert.deepEqual(completed.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: headA, taskIds: ['local-drift'], updatedAt: AT,
  });

  const headB = commit(cwd, { 'local-proof-drift.txt': 'drift\n' }, 'local proof drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(drifted.threadResolutionStatus.localVerification, completed.threadResolutionStatus.localVerification);

  const proofB = {
    status: 'passed', headSha: headB, threads: [], threadlessVerification: emptyThreadless(),
    updatedAt: '2026-08-05T00:01:00Z',
  };
  const refreshed = checkpointTaskCompletion({
    cwd, expectedRevision: drifted.revision, threadResolutionStatus: proofB,
    verifiedLocalTaskIds: ['local-drift'],
  });
  assert.deepEqual(refreshed.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: headB, taskIds: ['local-drift'], updatedAt: '2026-08-05T00:01:00Z',
  });
});

test('generic checkpoint cannot forge zero-thread or threadless successful proof at a new HEAD', () => {
  const zeroCwd = repo();
  const zeroInitial = init(zeroCwd);
  const zeroHeadA = zeroInitial.currentIntegrationHeadSha;
  const zeroProofA = ready(zeroInitial, []).threadResolutionStatus;
  const zeroProofedA = checkpointTaskCompletion({
    cwd: zeroCwd, expectedRevision: 0, threadResolutionStatus: zeroProofA,
  });
  const zeroHeadB = commit(zeroCwd, { 'zero-proof-drift.txt': 'drift\n' }, 'zero proof drift');
  const zeroProofB = { ...zeroProofA, headSha: zeroHeadB, updatedAt: '2026-08-05T00:01:00Z' };
  assert.throws(() => checkpointState({
    cwd: zeroCwd, expectedRevision: zeroProofedA.revision,
    nextState: {
      ...zeroProofedA, currentIntegrationHeadSha: zeroHeadB,
      git: { ...zeroProofedA.git, headSha: zeroHeadB }, threadResolutionStatus: zeroProofB,
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const zeroInvalidated = checkpointGitMetadata({ cwd: zeroCwd }).state;
  assert.equal(zeroInvalidated.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(zeroInvalidated.threadResolutionStatus.threads, zeroProofA.threads);
  assert.deepEqual(zeroInvalidated.threadResolutionStatus.threadlessVerification, zeroProofA.threadlessVerification);
  const zeroRefreshed = checkpointTaskCompletion({
    cwd: zeroCwd, expectedRevision: zeroInvalidated.revision, threadResolutionStatus: zeroProofB,
  });
  assert.equal(zeroRefreshed.threadResolutionStatus.headSha, zeroHeadB);
  assert.notEqual(zeroHeadA, zeroHeadB);

  const threadlessCwd = repo();
  const threadlessInitial = init(threadlessCwd);
  const threadlessHeadA = threadlessInitial.currentIntegrationHeadSha;
  const proposedTask = task(threadlessHeadA, {
    id: 'threadless-forgery', status: 'proposed', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const proposed = checkpointState({
    cwd: threadlessCwd, expectedRevision: 0, nextState: { ...threadlessInitial, tasks: [proposedTask] },
  });
  const integratedTask = task(threadlessHeadA, {
    id: 'threadless-forgery', status: 'integrated', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const integrated = writePreAuthorityTasks(threadlessCwd, proposed, [integratedTask]);
  const threadlessProofA = {
    status: 'passed', headSha: threadlessHeadA, threads: [], updatedAt: AT,
    threadlessVerification: {
      status: 'passed', headSha: threadlessHeadA, taskIds: ['threadless-forgery'], updatedAt: AT,
    },
  };
  const completedA = checkpointTaskCompletion({
    cwd: threadlessCwd, expectedRevision: integrated.revision, threadResolutionStatus: threadlessProofA,
  });
  const threadlessHeadB = commit(threadlessCwd, { 'threadless-proof-drift.txt': 'drift\n' }, 'threadless proof drift');
  const threadlessProofB = {
    ...threadlessProofA, headSha: threadlessHeadB, updatedAt: '2026-08-05T00:01:00Z',
    threadlessVerification: {
      ...threadlessProofA.threadlessVerification,
      headSha: threadlessHeadB, updatedAt: '2026-08-05T00:01:00Z',
    },
  };
  assert.throws(() => checkpointState({
    cwd: threadlessCwd, expectedRevision: completedA.revision,
    nextState: {
      ...completedA, currentIntegrationHeadSha: threadlessHeadB,
      git: { ...completedA.git, headSha: threadlessHeadB }, threadResolutionStatus: threadlessProofB,
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const threadlessInvalidated = checkpointGitMetadata({ cwd: threadlessCwd }).state;
  assert.equal(threadlessInvalidated.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(
    threadlessInvalidated.threadResolutionStatus.threadlessVerification,
    threadlessProofA.threadlessVerification,
  );
  const threadlessRefreshed = checkpointTaskCompletion({
    cwd: threadlessCwd, expectedRevision: threadlessInvalidated.revision,
    threadResolutionStatus: threadlessProofB,
  });
  assert.equal(threadlessRefreshed.threadResolutionStatus.threadlessVerification.headSha, threadlessHeadB);
});
