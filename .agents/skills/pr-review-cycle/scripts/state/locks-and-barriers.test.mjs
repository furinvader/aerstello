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

test('GitHub request owner lock awaits async work and dispatch claims are revision-bound', async () => {
  const cwd = repo();
  const initial = init(cwd);
  let release;
  const held = withGitHubRequestOwnerLock(cwd, 17, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => withGitHubRequestOwnerLock(cwd, 17, () => {}, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  release();
  await held;
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'owner result'), 'owner result');
  const ownerFailure = new Error('owner failed');
  await assert.rejects(
    () => withGitHubRequestOwnerLock(cwd, 17, () => { throw ownerFailure; }),
    (error) => error === ownerFailure,
  );
  await withGitHubRequestOwnerLock(cwd, 17, () => {});

  const intent = { type: 'request', operationId: `request:17:discovery:1:${initial.currentIntegrationHeadSha}`,
    clientMutationId: 'dispatch-correlation', at: AT, excludedCommentIds: [] };
  ensureGitHubMutationIntent(cwd, 17, intent);
  const first = claimGitHubMutationDispatch(cwd, 17, intent, initial.revision);
  assert.equal(first.isNew, true);
  assert.equal(claimGitHubMutationDispatch(cwd, 17, intent, initial.revision).isNew, false);
  assert.throws(() => claimGitHubMutationDispatch(cwd, 17, intent, initial.revision + 1), { code: 'STATE_REVISION_CONFLICT' });
  assert.throws(() => claimGitHubMutationDispatch(cwd, 17, { ...intent, clientMutationId: 'conflict' }, initial.revision), { code: 'INTENT_RECOVERY_INVALID' });

  const raceCwd = repo();
  const race = init(raceCwd);
  ensureGitHubMutationIntent(raceCwd, 17, intent);
  assert.throws(() => claimGitHubMutationDispatch(raceCwd, 17, intent, race.revision + 1), { code: 'STATE_REVISION_CONFLICT' });
  const raceEvents = readFileSync(join(stateDirectory(raceCwd, 17), 'events.ndjson'), 'utf8');
  assert.equal(raceEvents.includes('github-mutation-dispatch'), false);

  const missingCwd = repo();
  const missing = init(missingCwd);
  assert.throws(() => claimGitHubMutationDispatch(missingCwd, 17, intent, missing.revision), { code: 'INTENT_RECOVERY_INVALID' });
  writeFileSync(join(stateDirectory(missingCwd, 17), 'events.ndjson'), '{bad json}\n');
  assert.throws(() => claimGitHubMutationDispatch(missingCwd, 17, intent, missing.revision), { code: 'INTENT_RECOVERY_INVALID' });
});

test('state lock recovers from SIGKILL and keeps the replacement owner exclusive', async () => {
  const cwd = repo();
  init(cwd);
  const path = join(reviewRoot(cwd), 'locks', 'pr-17.state-lock.sqlite');
  const crashed = spawnLockHolder(cwd, 'state', 10_000);
  await waitForLockHolder(crashed);
  crashed.kill('SIGKILL');
  assert.deepEqual(await waitForChildExit(crashed), { code: null, signal: 'SIGKILL' });
  assert.equal(existsSync(path), true);

  const replacement = spawnLockHolder(cwd, 'state', 300);
  await waitForLockHolder(replacement);
  assert.throws(
    () => withStateLock(cwd, 17, () => {}, { timeoutMs: 60 }),
    { code: 'STATE_LOCK_TIMEOUT' },
  );
  assert.deepEqual(await waitForChildExit(replacement), { code: 0, signal: null });
  assert.equal(withStateLock(cwd, 17, () => 'state result'), 'state result');
  const stateFailure = new Error('state failed');
  assert.throws(() => withStateLock(cwd, 17, () => { throw stateFailure; }), (error) => error === stateFailure);
  assert.equal(existsSync(path), true);
});

test('GitHub request lock recovers from SIGKILL and keeps the replacement owner exclusive', async () => {
  const cwd = repo();
  init(cwd);
  const path = join(reviewRoot(cwd), 'locks', 'pr-17.github-request-lock.sqlite');
  const crashed = spawnLockHolder(cwd, 'github', 10_000);
  await waitForLockHolder(crashed);
  crashed.kill('SIGKILL');
  assert.deepEqual(await waitForChildExit(crashed), { code: null, signal: 'SIGKILL' });
  assert.equal(existsSync(path), true);

  const replacement = spawnLockHolder(cwd, 'github', 300);
  await waitForLockHolder(replacement);
  await assert.rejects(
    () => withGitHubRequestOwnerLock(cwd, 17, () => {}, { timeoutMs: 60 }),
    { code: 'STATE_LOCK_TIMEOUT' },
  );
  assert.deepEqual(await waitForChildExit(replacement), { code: 0, signal: null });
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request result'), 'request result');
  assert.equal(existsSync(path), true);
});

test('SQLite locks permanently seal both legacy protocol paths', async () => {
  const cwd = repo();
  const locks = join(reviewRoot(cwd), 'locks');
  mkdirSync(locks, { recursive: true });
  const legacyState = join(locks, 'pr-17.lock');
  const legacyRequest = join(locks, 'pr-17.github-request.lock');
  writeFileSync(`${legacyState}.retire-orphan`, 'orphan state claim\n');
  writeFileSync(`${legacyRequest}.retire-orphan`, 'orphan request claim\n');

  assert.equal(withStateLock(cwd, 17, () => 'state result'), 'state result');
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request result'), 'request result');
  assert.equal(existsSync(join(locks, 'pr-17.state-lock.sqlite')), true);
  assert.equal(existsSync(join(locks, 'pr-17.github-request-lock.sqlite')), true);
  assert.equal(statSync(legacyState).isDirectory(), true);
  assert.equal(statSync(legacyRequest).isDirectory(), true);
  assert.throws(() => openSync(legacyState, 'wx'), { code: 'EEXIST' });
  assert.throws(() => openSync(legacyRequest, 'wx'), { code: 'EEXIST' });
  assert.equal(existsSync(`${legacyState}.retire-orphan`), true);
  assert.equal(existsSync(`${legacyRequest}.retire-orphan`), true);
});

test('legacy file owners block both new lock callbacks until explicit safe release', async () => {
  const cwd = repo();
  const locks = join(reviewRoot(cwd), 'locks');
  mkdirSync(locks, { recursive: true });
  const legacyState = join(locks, 'pr-17.lock');
  const legacyRequest = join(locks, 'pr-17.github-request.lock');
  const liveOwner = `${JSON.stringify({
    token: 'live-owner', pid: process.pid, hostname: 'same-host', createdAt: AT,
  })}\n`;
  writeFileSync(legacyState, liveOwner);
  writeFileSync(legacyRequest, liveOwner);

  let stateCallbackRan = false;
  assert.throws(() => withStateLock(cwd, 17, () => {
    stateCallbackRan = true;
  }, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  assert.equal(stateCallbackRan, false);
  assert.equal(readFileSync(legacyState, 'utf8'), liveOwner);

  let requestCallbackRan = false;
  await assert.rejects(() => withGitHubRequestOwnerLock(cwd, 17, () => {
    requestCallbackRan = true;
  }, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  assert.equal(requestCallbackRan, false);
  assert.equal(readFileSync(legacyRequest, 'utf8'), liveOwner);

  const stateRelease = spawnLegacyLockRelease(legacyState, 40);
  assert.equal(withStateLock(cwd, 17, () => 'state migrated'), 'state migrated');
  assert.deepEqual(await waitForChildExit(stateRelease), { code: 0, signal: null });

  const requestRelease = new Promise((resolveRelease) => {
    setTimeout(() => {
      unlinkSync(legacyRequest);
      resolveRelease();
    }, 40);
  });
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request migrated'), 'request migrated');
  await requestRelease;
  assert.equal(statSync(legacyState).isDirectory(), true);
  assert.equal(statSync(legacyRequest).isDirectory(), true);
});

test('concurrent lock attempts time out', async () => {
  const cwd = repo();
  init(cwd);
  const fixture = new URL('./fixtures/hold-state-lock.mjs', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(fixture), cwd, '17', '350'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveLocked, reject) => {
    child.stdout.once('data', (chunk) => chunk.toString().includes('locked') ? resolveLocked() : reject(new Error('not locked')));
    child.once('error', reject);
  });
  assert.throws(() => withStateLock(cwd, 17, () => {}, { timeoutMs: 75 }), { code: 'STATE_LOCK_TIMEOUT' });
  await new Promise((resolveExit, reject) => child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(String(code)))));
});
