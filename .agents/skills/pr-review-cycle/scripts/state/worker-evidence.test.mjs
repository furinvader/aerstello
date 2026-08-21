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

test('worker results are receipt-bound, interruption-safe, immutable, and required for integration', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'durable-result', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'worker-result-fixture']);
  const workerSha = commit(cwd, { 'scripts/durable-result.mjs': 'export const durable = true;\n' }, 'worker result fixture');
  git(cwd, ['switch', 'main']);
  const result = workerResult(packet, workerSha, ['scripts/durable-result.mjs']);

  assert.throws(() => checkpointState({
    cwd, expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map((item) => ({
        ...item, status: 'implemented',
        execution: { ...item.execution, workerCommitSha: workerSha },
      })),
    },
  }), { code: 'WORKER_RESULT_MISSING' });

  assert.throws(() => checkpointState({
    cwd, expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map(({ execution: _execution, ...item }) => ({
        ...item, status: 'integrated', integratedCommitSha: workerSha, resolutionSummary: 'Forged integration.',
      })),
    },
  }), { code: 'WORKER_RESULT_MISSING' });

  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'receipt-durable') throw new Error('interrupt receipt'); },
  }), /interrupt receipt/u);
  assert.equal(existsSync(workerResultReceiptPath(cwd, 17, packet.taskId)), true);
  assert.equal(existsSync(workerResultEnvelopePath(cwd, 17, packet.taskId)), false);
  const pendingReceipt = readFileSync(workerResultReceiptPath(cwd, 17, packet.taskId), 'utf8');
  const pending = reconcileState({ cwd });
  assert.equal(pending.workerResults[0].status, 'pending-state');

  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'envelope-durable') throw new Error('interrupt envelope'); },
  }), /interrupt envelope/u);
  assert.equal(readFileSync(workerResultReceiptPath(cwd, 17, packet.taskId), 'utf8'), pendingReceipt,
    'an exact retry reuses the immutable pending receipt byte-for-byte');
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'state-checkpointed') throw new Error('interrupt state response'); },
  }), /interrupt state response/u);
  const accepted = loadState(cwd);
  assert.equal(accepted.tasks[0].status, 'implemented');
  assert.match(accepted.tasks[0].workerResultDigest, /^[0-9a-f]{64}$/u);
  assert.equal(checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: accepted.revision,
  }).revision, accepted.revision);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result: { ...result, resolutionSummary: 'Different evidence.' },
    expectedRevision: accepted.revision,
  }), { code: 'WORKER_RESULT_CONFLICT' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: { ...accepted, tasks: accepted.tasks.map(({ workerResultDigest: _digest, ...item }) => item) },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });

  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...implementedTask } = advanced.tasks[0];
  const integrated = checkpointState({
    cwd, expectedRevision: advanced.revision,
    nextState: {
      ...advanced,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
        resolutionSummary: 'Integrated accepted evidence.',
      }],
    },
  });
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'valid');
  assert.equal(integrated.tasks[0].workerResultDigest, accepted.tasks[0].workerResultDigest);
  const envelopePath = workerResultEnvelopePath(cwd, 17, packet.taskId);
  const receiptPath = workerResultReceiptPath(cwd, 17, packet.taskId);
  const canonicalReceipt = readFileSync(receiptPath, 'utf8');
  writeFileSync(receiptPath, `${'0'.repeat(64)}\n`);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: integrated.revision,
  }), { code: 'INVALID_WORKER_RESULT_EVIDENCE' });
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'invalid',
    'direct receipt tampering is visible to recovery reconciliation');
  writeFileSync(receiptPath, canonicalReceipt);
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'valid');
  const canonicalEnvelope = readFileSync(envelopePath, 'utf8');
  const alteredEnvelope = JSON.parse(canonicalEnvelope);
  alteredEnvelope.result.resolutionSummary = 'Tampered evidence.';
  writeFileSync(envelopePath, `${JSON.stringify(alteredEnvelope)}\n`);
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'invalid');
  writeFileSync(envelopePath, canonicalEnvelope);
  const orphanPath = join(dirname(envelopePath), 'orphan.json');
  writeFileSync(orphanPath, '{}\n');
  assert.ok(reconcileState({ cwd }).workerResults.some((entry) => entry.status === 'orphan'));
  rmSync(orphanPath);
  const archived = archiveState({ cwd, abandonmentReason: 'Archive durable worker-result fixture.' });
  assert.equal(readdirSync(join(archived, 'worker-results')).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(readdirSync(join(archived, 'worker-results')).filter((name) => name.endsWith('.sha256')).length, 1);
});

test('worker result compacts max-valid validation summaries before durable acceptance', () => {
  const cwd = repo();
  const { bound, packet, result } = boundWorkerResultFixture(cwd, 'max-validation-summary');
  result.validation[0].summary = 'x'.repeat(1000);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'receipt-durable') throw new Error('interrupt max summary receipt'); },
  }), /interrupt max summary receipt/u);
  const pendingReceipt = readFileSync(workerResultReceiptPath(cwd, bound.prNumber, packet.taskId), 'utf8');
  assert.equal(existsSync(workerResultEnvelopePath(cwd, bound.prNumber, packet.taskId)), false);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
  });
  assert.equal(readFileSync(workerResultReceiptPath(cwd, bound.prNumber, packet.taskId), 'utf8'), pendingReceipt,
    'the max-summary retry reuses its exact pending receipt');
  const compact = accepted.tasks[0].execution.validationSummaries[0];
  assert.equal(compact.length, 1000);
  assert.match(compact, /…$/u);
  const envelope = JSON.parse(readFileSync(
    workerResultEnvelopePath(cwd, accepted.prNumber, packet.taskId), 'utf8',
  ));
  assert.deepEqual(envelope.result, result,
    'only compact task state is truncated; the immutable result envelope remains exact');
  assert.equal(envelope.result.validation[0].summary.length, 1000,
    'the immutable result envelope retains the complete valid worker summary');
});

test('derived oversized worker state rejects before any result evidence mutation', () => {
  const cwd = repo();
  const { bound, packet, result } = boundWorkerResultFixture(cwd, 'derived-state-capacity');
  result.validation[0].summary = 'y'.repeat(1000);
  const persistedShape = (state) => ({
    ...state, revision: bound.revision + 1, updatedAt: bound.updatedAt,
  });
  const bytes = (state) => Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8');
  let padded = { ...bound, decisions: [...bound.decisions] };
  let index = 0;
  while (true) {
    const candidate = { ...padded, decisions: [...padded.decisions, {
      id: `worker-capacity-${index}`, summary: 'd'.repeat(1000),
    }] };
    if (bytes(acceptedWorkerStateProjection(persistedShape(candidate), packet, result))
        > ACTIVE_STATE_LIMIT_BYTES) break;
    padded = candidate; index += 1;
  }
  let fitting = null;
  for (let length = 1; length <= 1000; length += 1) {
    const candidate = { ...padded, decisions: [...padded.decisions, {
      id: `worker-capacity-${index}`, summary: 'd'.repeat(length),
    }] };
    const persisted = persistedShape(candidate);
    if (bytes(persisted) <= ACTIVE_STATE_LIMIT_BYTES
        && bytes(acceptedWorkerStateProjection(persisted, packet, result))
          > ACTIVE_STATE_LIMIT_BYTES) fitting = candidate;
  }
  assert.ok(fitting, 'constructed a valid current state whose fully derived acceptance state is oversized');
  const nearLimit = checkpointState({
    cwd, expectedRevision: bound.revision, nextState: fitting,
  });
  assert.ok(bytes(nearLimit) <= ACTIVE_STATE_LIMIT_BYTES);
  assert.ok(bytes(acceptedWorkerStateProjection(nearLimit, packet, result))
    > ACTIVE_STATE_LIMIT_BYTES);
  const before = durableAcceptanceSnapshot(cwd, packet.taskId);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: nearLimit.revision,
  }), { code: 'STATE_TOO_LARGE' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), before,
    'invalid derived state writes no envelope, receipt, state, event, or sidecar bytes');
});

test('worker result preflights revision digit growth before result evidence mutation', () => {
  const cwd = repo();
  const fixture = boundWorkerResultFixture(cwd, 'revision-digit-capacity');
  fixture.result.validation[0].summary = 'z'.repeat(1000);
  let current = fixture.bound;
  while (current.revision < 8) {
    current = checkpointState({ cwd, expectedRevision: current.revision, nextState: current });
  }
  assert.equal(current.revision, 8);
  const bytes = (state) => Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8');
  const revisionNine = (state) => ({ ...state, revision: 9, updatedAt: current.updatedAt });
  const projectedBytes = (state) => bytes(acceptedWorkerStateProjection(
    revisionNine(state), fixture.packet, fixture.result,
  ));
  let padded = { ...current, nextAction: 'x', decisions: [...current.decisions] };
  let index = 0;
  while (true) {
    const candidate = { ...padded, decisions: [...padded.decisions, {
      id: `revision-capacity-${index}`, summary: 'r'.repeat(1000),
    }] };
    if (projectedBytes(candidate) > ACTIVE_STATE_LIMIT_BYTES) break;
    padded = candidate; index += 1;
  }
  let remaining = ACTIVE_STATE_LIMIT_BYTES - projectedBytes(padded);
  const nextActionGrowth = Math.min(999, remaining);
  padded = { ...padded, nextAction: 'x'.repeat(1 + nextActionGrowth) };
  remaining -= nextActionGrowth;
  if (remaining > 0) {
    const lastDecision = padded.decisions.at(-1);
    assert.ok(lastDecision.id.length + remaining <= 128);
    padded = { ...padded, decisions: padded.decisions.map((decision) =>
      decision === lastDecision ? { ...decision, id: `${decision.id}${'x'.repeat(remaining)}` } : decision) };
  }
  assert.equal(projectedBytes(padded), ACTIVE_STATE_LIMIT_BYTES,
    'constructed an exact 64-KiB acceptance state at revision 9');
  const nearLimit = checkpointState({ cwd, expectedRevision: current.revision, nextState: padded });
  assert.equal(nearLimit.revision, 9);
  const revisionNineAcceptance = acceptedWorkerStateProjection(
    nearLimit, fixture.packet, fixture.result,
  );
  assert.equal(bytes(revisionNineAcceptance), ACTIVE_STATE_LIMIT_BYTES);
  assert.equal(bytes({ ...revisionNineAcceptance, revision: 10 }), ACTIVE_STATE_LIMIT_BYTES + 1);
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result, expectedRevision: nearLimit.revision,
  }), { code: 'STATE_TOO_LARGE' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
    'revision-width rejection writes no envelope, receipt, state, event, or sidecar bytes');
});

test('dependent worker result rejects missing, nonterminal, or absent dependency ancestry without mutation', () => {
  for (const scenario of [
    { dependencyReference: 'missing', code: 'WORKER_RESULT_DEPENDENCY_NOT_READY' },
    { dependencyReference: 'pending', code: 'WORKER_RESULT_DEPENDENCY_NOT_READY' },
    { centralBase: 'review', code: 'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH' },
    { workerBase: 'review', code: 'WORKER_RESULT_DEPENDENCY_ANCESTRY_MISMATCH' },
  ]) {
    const cwd = repo();
    const fixture = dependentWorkerAcceptanceFixture(cwd, scenario);
    const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
    assert.throws(() => checkpointWorkerResultAcceptance({
      cwd, packet: fixture.packet, result: fixture.result,
      expectedRevision: fixture.advanced.revision,
    }), { code: scenario.code });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
  }
});

test('dependent worker result rejects a non-descendant central authority without mutation', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd);
  const tree = git(cwd, ['rev-parse', `${fixture.centralSha}^{tree}`]);
  const unrelatedHead = git(cwd, ['commit-tree', tree, '-m', 'unrelated result authority']);
  git(cwd, ['switch', '--detach', unrelatedHead]);
  const unrelated = checkpointGitMetadata({ cwd }).state;
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result, expectedRevision: unrelated.revision,
  }), { code: 'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
});

test('new and unbound actionable tasks cannot pre-seed or bypass result authority', () => {
  const cwd = repo();
  const initial = init(cwd);
  const unbound = task(initial.currentIntegrationHeadSha, {
    id: 'unbound-authority', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: { ...initial, tasks: [{ ...unbound, workerResultDigest: 'a'.repeat(64) }] },
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [unbound] },
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: {
      ...proposed,
      tasks: [{
        ...unbound, status: 'implemented',
        execution: { ...unbound.execution, workerCommitSha: initial.currentIntegrationHeadSha },
      }],
    },
  }), { code: 'TASK_PACKET_NOT_BOUND' });
  const { execution: _execution, ...withoutExecution } = unbound;
  assert.throws(() => checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: {
      ...proposed,
      tasks: [{
        ...withoutExecution, status: 'integrated', integratedCommitSha: initial.currentIntegrationHeadSha,
        resolutionSummary: 'Forged unbound integration.',
      }],
    },
  }), { code: 'TASK_PACKET_NOT_BOUND' });
});

test('native-v3 backfill proves central patch equivalence and migrations do not synthesize results', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'backfill-result', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'backfill-worker']);
  const workerSha = commit(cwd, { 'scripts/backfill-result.mjs': 'export const backfill = true;\n' }, 'backfill worker');
  git(cwd, ['switch', 'main']);
  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...boundTask } = advanced.tasks[0];
  const preBoundary = {
    ...advanced,
    tasks: [{
      ...boundTask, status: 'integrated', integratedCommitSha: centralSha,
      resolutionSummary: 'Integrated before durable result acceptance existed.',
    }],
  };
  writeFileSync(statePath(cwd, preBoundary.prNumber), `${JSON.stringify(preBoundary)}\n`);
  const result = workerResult(packet, workerSha, ['scripts/backfill-result.mjs']);
  const backfilled = checkpointWorkerResultBackfill({
    cwd, packet, result, expectedRevision: preBoundary.revision,
  });
  assert.match(backfilled.tasks[0].workerResultDigest, /^[0-9a-f]{64}$/u);
  assert.equal(checkpointWorkerResultBackfill({
    cwd, packet, result, expectedRevision: backfilled.revision,
  }).revision, backfilled.revision);

  git(cwd, ['switch', '-c', 'mismatched-worker', packet.reviewedHeadSha]);
  const mismatchSha = commit(cwd, { 'scripts/backfill-result.mjs': 'export const mismatch = true;\n' }, 'mismatched worker');
  git(cwd, ['switch', 'main']);
  const mismatchResult = workerResult(packet, mismatchSha, ['scripts/backfill-result.mjs']);
  const unboundEvidenceState = {
    ...backfilled,
    tasks: backfilled.tasks.map(({ workerResultDigest: _digest, ...item }) => item),
  };
  writeFileSync(statePath(cwd, unboundEvidenceState.prNumber), `${JSON.stringify(unboundEvidenceState)}\n`);
  assert.throws(() => checkpointWorkerResultBackfill({
    cwd, packet, result: mismatchResult, expectedRevision: unboundEvidenceState.revision,
  }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });

  const migrated = migratePrReviewStateV2(schemaV2State({
    ...initial,
    tasks: [task(initial.currentIntegrationHeadSha, { id: 'migrated-no-result' })],
  }), { migratedAt: AT });
  assert.equal(Object.hasOwn(migrated.tasks[0], 'workerResultDigest'), false);
});
