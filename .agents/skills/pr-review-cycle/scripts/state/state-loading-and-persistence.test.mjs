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

test('initialization writes the v3 identity and empty durable ledgers', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.reviewRequestLimit, null);
  assert.equal(state.legacyReviewProvenance, null);
  assert.deepEqual(state.reviewHistory, []);
  assert.deepEqual(state.staleDiscoveryDispositions, []);
  assert.deepEqual(state.threadResolutionStatus.threads, []);
  assert.equal(statePath(cwd, 17), join(gitCommonDirectory(cwd), 'codex', 'pr-review', 'pr-17', 'state.json'));
});

test('initialization accepts only an explicit positive review request limit', () => {
  const limited = init(repo(), { reviewRequestLimit: 7 });
  assert.equal(limited.reviewRequestLimit, 7);
  for (const reviewRequestLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    assert.throws(
      () => init(repo(), { reviewRequestLimit }),
      { code: 'INVALID_REVIEW_REQUEST_LIMIT' },
    );
  }
});

test('large v2 state survives the clean lifecycle and rejects documents beyond 64 KiB', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const head = initialized.currentIntegrationHeadSha;
  const tasks = [];
  let prepared = ready(initialized, tasks);
  while (Buffer.byteLength(`${JSON.stringify(prepared)}\n`) < 48 * 1024) {
    const index = tasks.length;
    tasks.push(task(head, {
      id: `large-state-task-${index}`,
      sourceIds: [`local:large-state-audit-${index}`],
      fingerprint: `large-state-fingerprint-${String(index).padStart(4, '0')}`,
      summary: `Durable finding ${index}: ${'s'.repeat(650)}`,
      resolutionSummary: `Integrated and verified with focused evidence ${index}: ${'e'.repeat(350)}`,
    }));
    prepared = ready(initialized, tasks);
  }
  const preparedBytes = Buffer.byteLength(`${JSON.stringify(prepared)}\n`);
  assert.ok(preparedBytes > 30 * 1024);
  assert.ok(preparedBytes < ACTIVE_STATE_LIMIT_BYTES);
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(prepared)}\n`);

  const requested = checkpointReviewRequest({
    cwd, request: request(prepared, 'large-state-request'),
    pushedHeadSha: head, prHeadSha: head, expectedRevision: prepared.revision,
  });
  assert.equal(requested.phase, 'awaiting-review');
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);

  const collected = checkpointReviewOutcome({
    cwd, outcome: outcome(requested), expectedRevision: requested.revision,
  });
  assert.equal(collected.reviewOutcome.outcome, 'clean');
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);

  const ciValidated = checkpointCiValidation({
    cwd, evidence: ciEvidence(collected), expectedRevision: collected.revision,
  });
  const completed = checkpointCompletion({
    cwd, pushedHeadSha: head, prHeadSha: head, expectedRevision: ciValidated.revision,
  });
  assert.equal(completed.phase, 'complete');

  const oversized = structuredClone(completed);
  while (Buffer.byteLength(`${JSON.stringify(oversized)}\n`) <= ACTIVE_STATE_LIMIT_BYTES) {
    const index = oversized.decisions.length;
    oversized.decisions.push({ id: `oversized-${index}`, summary: 'x'.repeat(1000) });
  }
  assert.throws(
    () => checkpointState({ cwd, nextState: oversized, expectedRevision: completed.revision }),
    { code: 'STATE_TOO_LARGE' },
  );
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(oversized)}\n`);
  assert.throws(() => loadState(cwd), { code: 'STATE_TOO_LARGE' });
});

test('checkpoint enforces immutable identity, monotonic counters, sticky verification, and null active abandonment', () => {
  const cwd = repo();
  const state = init(cwd);
  for (const nextState of [
    { ...state, baseSha: 'a'.repeat(40) },
    { ...state, integrationWorktree: '/tmp/other' },
    { ...state, releaseBaseline: { version: '1.0.0', tag: 'v1.0.0', commit: state.baseSha, releasedAt: AT } },
    { ...state, abandonmentReason: 'not active' },
  ]) assert.throws(() => checkpointState({ cwd, nextState, expectedRevision: 0 }));

  const migrated = migratePrReviewStateV1(legacyState(state, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const advanced = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-sticky', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha,
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: advanced.revision,
    nextState: { ...advanced, reviewRound: 2, verificationReviewUsed: false },
  }));
});

test('invalid events cannot advance state and event I/O failure rolls back state', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.throws(() => checkpointState({
    cwd, nextState: { ...state, nextAction: 'Changed.' }, expectedRevision: 0,
    event: { type: '', summary: 'invalid' },
  }), { code: 'INVALID_EVENT' });
  assert.equal(loadState(cwd).revision, 0);
  assert.throws(() => checkpointState({
    cwd, nextState: { ...state, nextAction: 'Changed.' }, expectedRevision: 0,
    event: { type: 'checkpoint', summary: 'valid' },
    eventWriter: () => { throw new Error('disk full'); },
  }), { code: 'CHECKPOINT_EVENT_FAILED' });
  assert.deepEqual(loadState(cwd), state);
});

test('atomic checkpoints leave no temporary files', () => {
  const cwd = repo();
  const state = init(cwd);
  checkpointState({ cwd, nextState: { ...state, nextAction: 'Still recovering.' }, expectedRevision: 0 });
  assert.deepEqual(readdirSync(stateDirectory(cwd, 17)).filter((name) => name.endsWith('.tmp')), []);
});
