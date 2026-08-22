import * as harness from './test-support/state-harness.mjs';
import { reconcileState } from './reconciliation.mjs';
import { renderRecoverySummary } from './recovery.mjs';
import { readBoundTaskBindingProvenance } from './evidence/task-binding.mjs';
import {
  assertBoundTaskPacket as assertBoundTaskPacketOwner,
  taskPacketDigest,
} from './evidence/task-packets.mjs';

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
  recordSpecialistReview,
  reviewRequestGate,
  reviewRequestUsage,
  reviewRoot,
  stateDirectory,
  statePath,
  StateError,
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

test('accepted task packet identity is canonical, guarded, persistent, and required by consumers', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  const reordered = Object.fromEntries(Object.entries(packet).reverse());
  assert.equal(taskPacketDigest(reordered), taskPacketDigest(packet));
  assert.notEqual(taskPacketDigest({
    ...packet,
    affectedAreas: ['documentation', 'api'],
  }), taskPacketDigest({
    ...packet,
    affectedAreas: ['api', 'documentation'],
  }));
  assert.throws(() => checkpointState({
    cwd,
    nextState: {
      ...state,
      tasks: state.tasks.map((item) => ({ ...item, taskPacketDigest: taskPacketDigest(packet) })),
    },
    expectedRevision: state.revision,
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet] }), {
    code: 'TASK_PACKET_NOT_BOUND',
  });
  assert.throws(() => assertTaskPacketBound(state, { ...packet, taskId: 'missing-task' }), {
    code: 'TASK_PACKET_NOT_BOUND',
  });
  assert.throws(() => assertTaskPacketBound(state, { ...packet, reviewedHeadSha: 'f'.repeat(40) }), {
    code: 'TASK_PACKET_HEAD_MISMATCH',
  });
  state = bindPacket(cwd, state, packet);
  assert.equal(assertBoundTaskPacketOwner(state, packet, cwd).id, packet.taskId);
  const boundRevision = state.revision;
  assert.equal(state.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.equal(checkpointTaskPacketBinding({
    cwd, packet: reordered, expectedRevision: state.revision,
  }).revision, boundRevision);
  const weakened = {
    ...packet,
    affectedAreas: ['documentation'],
    requiredValidation: {
      unit: [{ command: 'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs', reason: 'Weakened selection.' }],
      system: [],
    },
  };
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet: weakened, expectedRevision: state.revision,
  }), { code: 'TASK_PACKET_CONFLICT' });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [weakened] }), {
    code: 'TASK_PACKET_CONFLICT',
  });
  const completed = checkpointTaskCompletion({
    cwd, expectedRevision: state.revision,
    threadResolutionStatus: {
      status: 'passed', headSha: state.currentIntegrationHeadSha, threads: [],
      threadlessVerification: emptyThreadless(), updatedAt: AT,
    },
  });
  assert.equal(completed.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.throws(() => checkpointState({
    cwd,
    nextState: { ...completed, tasks: completed.tasks.map(({ taskPacketDigest: _digest, ...item }) => item) },
    expectedRevision: completed.revision,
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
});

test('exact bound packet survives null-review central integration HEAD advance only after integration', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'post-integration-packet', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(proposed.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  assert.equal(bound.reviewedHeadSha, null);
  assert.equal(bound.tasks[0].taskPacketDigest, taskPacketDigest(packet));

  const integratedHead = commit(cwd, { 'scripts/integrated-task.mjs': 'export const integrated = true;\n' }, 'integrate task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  assert.equal(advanced.currentIntegrationHeadSha, integratedHead);
  assert.throws(() => assertTaskPacketBound(advanced, packet), { code: 'TASK_PACKET_HEAD_MISMATCH' });
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, packet.taskId, integratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet,
    result: workerResult(packet, integratedHead, ['scripts/integrated-task.mjs']),
    expectedRevision: implementedBeforeAcceptance.revision,
  });
  const { execution: _execution, ...boundTask } = accepted.tasks[0];
  const integrated = checkpointState({
    cwd,
    expectedRevision: accepted.revision,
    nextState: {
      ...accepted,
      tasks: [{
        ...boundTask,
        status: 'integrated',
        integratedCommitSha: integratedHead,
        resolutionSummary: 'Integrated centrally; targeted validation remains.',
      }],
    },
  });
  assert.equal(assertTaskPacketBound(integrated, packet).id, packet.taskId);
  const descendantHead = commit(cwd, { 'scripts/later-integration.mjs': 'export const later = true;\n' }, 'later integration');
  const descendant = checkpointGitMetadata({ cwd }).state;
  assert.equal(descendant.currentIntegrationHeadSha, descendantHead);
  assert.equal(assertTaskPacketBound(descendant, packet).id, packet.taskId);
  assert.equal(checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: descendant.revision,
  }).revision, descendant.revision);
  const plan = buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  assert.deepEqual(plan.taskIds, [packet.taskId]);
  assert.equal(plan.headSha, descendantHead);
  assert.equal(plan.stateRevision, descendant.revision);

  const substituted = { ...packet, evidence: 'Substituted packet evidence.' };
  assert.throws(() => assertTaskPacketBound(descendant, substituted), {
    code: 'TASK_PACKET_CONFLICT',
  });
  const canonicalReviewedState = { ...descendant, reviewedHeadSha: descendantHead };
  assert.throws(() => assertTaskPacketBound(canonicalReviewedState, packet), {
    code: 'TASK_PACKET_HEAD_MISMATCH',
  });
  assert.throws(() => assertTaskPacketBound(canonicalReviewedState, {
    ...packet, reviewedHeadSha: descendantHead,
  }), { code: 'TASK_PACKET_CONFLICT' });
});

test('bound packet rejects rollback, unrelated, or missing central integration ancestry without validation proof', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'ancestry-guard', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(proposed.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  const integratedHead = commit(cwd, { 'scripts/ancestry-task.mjs': 'export const integrated = true;\n' }, 'integrate ancestry task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, packet.taskId, integratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet,
    result: workerResult(packet, integratedHead, ['scripts/ancestry-task.mjs']),
    expectedRevision: implementedBeforeAcceptance.revision,
  });
  const { execution: _execution, ...boundTask } = accepted.tasks[0];
  const integrated = checkpointState({
    cwd,
    expectedRevision: accepted.revision,
    nextState: {
      ...accepted,
      tasks: [{
        ...boundTask,
        status: 'integrated',
        integratedCommitSha: integratedHead,
        resolutionSummary: 'Integrated centrally; targeted validation remains.',
      }],
    },
  });
  assert.equal(integrated.tasks[0].taskPacketDigest, bound.tasks[0].taskPacketDigest);

  git(cwd, ['switch', '--detach', packet.reviewedHeadSha]);
  const rollback = checkpointGitMetadata({ cwd }).state;
  assert.equal(rollback.currentIntegrationHeadSha, packet.reviewedHeadSha);
  assert.throws(() => assertTaskPacketBound(rollback, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.equal(existsSync(validationPlanPath(cwd, rollback.prNumber)), false);
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');

  const tree = git(cwd, ['rev-parse', `${integratedHead}^{tree}`]);
  const unrelatedHead = git(cwd, ['commit-tree', tree, '-m', 'unrelated integration history']);
  const unrelatedCommitState = {
    ...rollback,
    tasks: rollback.tasks.map((item) => ({ ...item, integratedCommitSha: unrelatedHead })),
  };
  assert.throws(() => assertTaskPacketBound(unrelatedCommitState, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  const missingCommitState = {
    ...rollback,
    tasks: rollback.tasks.map((item) => ({ ...item, integratedCommitSha: 'f'.repeat(40) })),
  };
  assert.throws(() => assertTaskPacketBound(missingCommitState, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });

  git(cwd, ['switch', '--detach', unrelatedHead]);
  const unrelated = checkpointGitMetadata({ cwd }).state;
  assert.equal(unrelated.currentIntegrationHeadSha, unrelatedHead);
  assert.throws(() => assertTaskPacketBound(unrelated, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.equal(existsSync(validationPlanPath(cwd, unrelated.prNumber)), false);
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');
});

test('canonical bound packet accepts direct and descendant central integration ancestry only', () => {
  const cwd = repo();
  const { packet, reviewedHead, integratedHead, integrated } = canonicalBoundIntegratedTask(cwd);
  assert.equal(packet.reviewedHeadSha, reviewedHead);
  assert.equal(integrated.reviewedHeadSha, reviewedHead);
  assert.equal(assertTaskPacketBound(integrated, packet).integratedCommitSha, integratedHead);

  const descendantHead = commit(cwd, { 'scripts/canonical-later.mjs': 'export const later = true;\n' }, 'later canonical integration');
  const descendant = checkpointGitMetadata({ cwd }).state;
  assert.equal(assertTaskPacketBound(descendant, packet).integratedCommitSha, integratedHead);
  const plan = buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  assert.deepEqual(plan.taskIds, [packet.taskId]);
  assert.equal(plan.headSha, descendantHead);
  assert.equal(plan.stateRevision, descendant.revision);

  assert.throws(() => assertTaskPacketBound(descendant, {
    ...packet, reviewedHeadSha: integratedHead,
  }), { code: 'TASK_PACKET_HEAD_MISMATCH' });
  assert.throws(() => assertTaskPacketBound(descendant, {
    ...packet, evidence: 'Substituted canonical packet evidence.',
  }), { code: 'TASK_PACKET_CONFLICT' });
});

test('canonical bound packet rejects rollback, unrelated, or missing integration ancestry without proof', () => {
  const cwd = repo();
  const { packet, reviewedHead, integratedHead } = canonicalBoundIntegratedTask(cwd, 'canonical-fail-closed');

  git(cwd, ['switch', '--detach', reviewedHead]);
  const rollback = checkpointGitMetadata({ cwd }).state;
  assert.equal(rollback.currentIntegrationHeadSha, reviewedHead);
  assert.throws(() => assertTaskPacketBound(rollback, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.equal(existsSync(validationPlanPath(cwd, rollback.prNumber)), false);
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');

  const tree = git(cwd, ['rev-parse', `${integratedHead}^{tree}`]);
  const unrelatedHead = git(cwd, ['commit-tree', tree, '-m', 'unrelated canonical integration']);
  const unrelatedCommitState = {
    ...rollback,
    tasks: rollback.tasks.map((item) => ({ ...item, integratedCommitSha: unrelatedHead })),
  };
  assert.throws(() => assertTaskPacketBound(unrelatedCommitState, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  const missingCommitState = {
    ...rollback,
    tasks: rollback.tasks.map((item) => ({ ...item, integratedCommitSha: 'f'.repeat(40) })),
  };
  assert.throws(() => assertTaskPacketBound(missingCommitState, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });

  git(cwd, ['switch', '--detach', unrelatedHead]);
  const unrelated = checkpointGitMetadata({ cwd }).state;
  assert.throws(() => assertTaskPacketBound(unrelated, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.equal(existsSync(validationPlanPath(cwd, unrelated.prNumber)), false);
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');
});

test('worker-result acceptance requires the exact durably bound task packet', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  const workerCommit = commit(cwd, { 'scripts/worker-result.mjs': 'export const fixed = true;\n' }, 'worker result');
  const result = {
    schemaVersion: 3,
    taskId: 'task-a',
    specialization: 'api',
    status: 'implemented',
    commitSha: workerCommit,
    changedPaths: ['scripts/worker-result.mjs'],
    validation: [{ command: 'npm run check:api', result: 'passed', summary: 'Passed.' }],
    resolutionSummary: 'Implemented the accepted task.',
    residualRisks: [],
    unexpectedDependencies: [],
  };
  const packetPath = join(stateDirectory(cwd, state.prNumber), 'accepted-task.json');
  const resultPath = join(stateDirectory(cwd, state.prNumber), 'worker-result.json');
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  const invalidResult = {
    ...result,
    commitSha: 'f'.repeat(40),
    changedPaths: ['apps/outside-ownership.ts'],
    validation: [{ command: 'npm run check:web', result: 'passed', summary: 'Wrong check.' }],
  };
  writeFileSync(resultPath, `${JSON.stringify(invalidResult)}\n`);
  const runValidation = () => spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--pr', '17', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const unbound = runValidation();
  assert.equal(unbound.status, 1);
  assert.match(unbound.stderr, /TASK_PACKET_NOT_BOUND/u);
  state = bindPacket(cwd, state, packet);
  writeFileSync(packetPath, `${JSON.stringify({ ...packet, evidence: 'Conflicting review evidence.' })}\n`);
  const conflicting = runValidation();
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /TASK_PACKET_CONFLICT/u);
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  const accepted = runValidation();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { valid: true, taskId: 'task-a' });
});

test('schema-v3 packet sidecars are canonical, immutable, digest-verified, and recovery-critical', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['sidecar-task']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'sidecar-task');
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'SPECIALIST_PLAN_REQUIRED' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);

  planSpecialists({ cwd, input: planInput(state, packet), expectedRevision: state.revision, now: () => AT });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
    event: { type: 'x', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(loadState(cwd).tasks[0].taskPacketDigest, undefined);
  const sidecarPath = taskPacketSidecarPath(cwd, state.prNumber, packet.taskId);
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, packet.taskId);
  assert.deepEqual(JSON.parse(readFileSync(sidecarPath, 'utf8')), packet);
  assert.equal(existsSync(provenancePath), true);
  assert.match(readFileSync(provenanceReceiptPath, 'utf8'), /^[0-9a-f]{64}\n$/u);
  const interrupted = reconcileState({ cwd });
  assert.equal(interrupted.packetSidecars.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  assert.equal(interrupted.bindingProvenance.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  rmSync(provenancePath);
  const receiptOnly = reconcileState({ cwd });
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).path, null);
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).receiptPath, provenanceReceiptPath);
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  assert.equal(state.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  assert.deepEqual(
    readBoundTaskBindingProvenance(cwd, state, state.tasks[0], packet),
    provenance,
    'the extracted binding owner reads the immutable, receipt-verified provenance',
  );
  assert.equal(provenance.phase, 'pre-bind');
  assert.equal(provenance.packetDigest, taskPacketDigest(packet));
  assert.equal(provenance.reviewedHeadSha, packet.reviewedHeadSha);
  assert.equal(provenance.planRevision, state.revision - 1);
  assert.match(provenance.planReceiptDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(provenance.planningSignals, {
    browserVisible: false, testSelectionUncertain: false,
  });
  assert.equal(provenance.behaviorMapperResult, null);

  writeFileSync(sidecarPath, `${JSON.stringify({ ...packet, evidence: 'tampered' })}\n`);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  assert.throws(() => buildTargetedValidationPlan({ cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  const recovery = reconcileState({ cwd });
  assert.equal(recovery.packetSidecars[0].status, 'invalid');
  assert.equal(recovery.specialist.status, 'stale');
  assert.equal(recovery.specialist.error, 'TASK_PACKET_REPLAN_REQUIRED');
  assert.deepEqual(recovery.evidenceErrors.map((message) => message.split(':')[0]), [
    'Task sidecar-task packet sidecar', 'Specialist review bundle is invalid',
  ]);
});

test('a stale packet binder cannot create a sidecar after revision drift', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['raced-task']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'raced-task');
  planSpecialists({ cwd, input: planInput(state, packet), expectedRevision: state.revision, now: () => AT });
  checkpointState({
    cwd, expectedRevision: state.revision,
    nextState: { ...state, nextAction: 'A concurrent orchestrator checkpoint won the revision.' },
  });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);
});

test('active legacy-bound tasks fail with the dedicated replan error before rebinding or result acceptance', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['legacy-active']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'legacy-active');
  const historicalV2 = Object.fromEntries(Object.entries(packet)
    .filter(([key]) => !['specialization', 'riskTags'].includes(key))
    .map(([key, value]) => [key, key === 'schemaVersion' ? 2 : value]));
  const legacyBound = {
    ...state,
    tasks: state.tasks.map((taskItem) => ({ ...taskItem, taskPacketDigest: taskPacketDigest(historicalV2) })),
  };
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(legacyBound)}\n`);
  assert.throws(
    () => checkpointTaskPacketBinding({ cwd, packet, expectedRevision: legacyBound.revision }),
    { code: 'TASK_PACKET_REPLAN_REQUIRED' },
  );
  assert.throws(() => assertTaskPacketBound(legacyBound, packet, { cwd }), {
    code: 'TASK_PACKET_REPLAN_REQUIRED',
  });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);
});

test('migration-origin v2 binding replanning is guarded, neutral, and followed by explicit v3 planning', () => {
  const cwd = repo();
  const opaqueTaskId = 'legacy, task "quoted"';
  const { state: migrated, packet, backupPath } = migrateV2BoundTask(cwd, { taskId: opaqueTaskId });
  const backup = readFileSync(backupPath, 'utf8');
  assert.equal(migrated.tasks[0].status, 'proposed');
  assert.equal(typeof migrated.tasks[0].taskPacketDigest, 'string');
  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: migrated.revision,
    nextState: {
      ...migrated,
      tasks: migrated.tasks.map(({ taskPacketDigest: _digest, ...taskItem }) => taskItem),
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: migrated.revision + 1,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, migrated.prNumber, opaqueTaskId)), false);

  const replanned = checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: migrated.revision,
  });
  const replannedTask = replanned.tasks[0];
  assert.equal(replannedTask.status, 'proposed');
  assert.equal(Object.hasOwn(replannedTask, 'taskPacketDigest'), false);
  assert.equal(replannedTask.integratedCommitSha, null);
  assert.equal(replannedTask.resolutionSummary, null);
  assert.deepEqual(replannedTask.execution, {
    dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
    workerCommitSha: null, validationSummaries: [], lastError: null,
  });
  assert.equal(replanned.phase, 'recovering');
  assert.equal(readFileSync(backupPath, 'utf8'), backup);
  assert.equal(existsSync(taskPacketSidecarPath(cwd, replanned.prNumber, opaqueTaskId)), false);
  assert.equal(existsSync(taskBindingProvenancePath(cwd, replanned.prNumber, opaqueTaskId)), false);

  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: replanned.revision,
  }), { code: 'SPECIALIST_PLAN_REQUIRED' });
  planSpecialists({
    cwd, input: planInput(replanned, packet), expectedRevision: replanned.revision, now: () => AT,
  });
  const rebound = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: replanned.revision,
  });
  assert.equal(rebound.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.equal(existsSync(taskPacketSidecarPath(cwd, rebound.prNumber, opaqueTaskId)), true);
  assert.equal(existsSync(taskBindingProvenancePath(cwd, rebound.prNumber, opaqueTaskId)), true);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: rebound.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
});

test('v2 replan preserves integrated facts, invalidates targeted proof, and rejects unsafe provenance', () => {
  const integratedCwd = repo();
  const integratedSetup = migrateV2BoundTask(integratedCwd, { status: 'integrated' });
  const validated = checkpointSyntheticTargetedValidation(integratedCwd, integratedSetup.state);
  const integratedTask = structuredClone(validated.tasks[0]);
  const replanned = checkpointTaskPacketReplan({
    cwd: integratedCwd, taskId: integratedTask.id, expectedRevision: validated.revision,
  });
  assert.equal(replanned.tasks[0].status, 'integrated');
  assert.equal(replanned.tasks[0].integratedCommitSha, integratedTask.integratedCommitSha);
  assert.equal(replanned.tasks[0].resolutionSummary, integratedTask.resolutionSummary);
  assert.equal(Object.hasOwn(replanned.tasks[0], 'execution'), false);
  assert.equal(Object.hasOwn(replanned.tasks[0], 'taskPacketDigest'), false);
  assert.equal(replanned.validationStatus.status, 'not-run');

  for (const status of ['queued', 'running', 'implemented']) {
    const activeCwd = repo();
    const active = migrateV2BoundTask(activeCwd, { status });
    assert.throws(() => checkpointTaskPacketReplan({
      cwd: activeCwd, taskId: 'legacy-active', expectedRevision: active.state.revision,
    }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
    assert.equal(loadState(activeCwd).tasks[0].status, status);
    assert.equal(loadState(activeCwd).tasks[0].taskPacketDigest, taskPacketDigest(active.historicalPacket));
  }

  const assignedCwd = repo();
  const assigned = migrateV2BoundTask(assignedCwd, {
    status: 'proposed', taskOverrides: { execution: { worker: 'review_fix_worker' } },
  });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: assignedCwd, taskId: 'legacy-active', expectedRevision: assigned.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(loadState(assignedCwd).tasks[0].execution.worker, 'review_fix_worker');

  for (const status of ['blocked', 'failed']) {
    const neutralCwd = repo();
    const neutral = migrateV2BoundTask(neutralCwd, { status });
    const safelyReplanned = checkpointTaskPacketReplan({
      cwd: neutralCwd, taskId: 'legacy-active', expectedRevision: neutral.state.revision,
    });
    assert.equal(safelyReplanned.tasks[0].status, 'proposed');
    assert.equal(safelyReplanned.tasks[0].taskPacketDigest, undefined);
    assert.deepEqual(safelyReplanned.tasks[0].execution, {
      dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
      workerCommitSha: null, validationSummaries: [], lastError: null,
    });
  }

  const nativeCwd = repo();
  const native = integratedTasks(nativeCwd, ['legacy-active']);
  const legacyPacket = historicalTaskPacketV2(taskPacket(native.currentIntegrationHeadSha, 'legacy-active'));
  writeFileSync(statePath(nativeCwd, native.prNumber), `${JSON.stringify({
    ...native,
    tasks: native.tasks.map((taskItem) => ({
      ...taskItem, taskPacketDigest: taskPacketDigest(legacyPacket),
    })),
  })}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: nativeCwd, taskId: 'legacy-active', expectedRevision: native.revision,
  }), { code: 'TASK_PACKET_REPLAN_PROVENANCE_INVALID' });

  const tamperedCwd = repo();
  const tampered = migrateV2BoundTask(tamperedCwd);
  const backup = JSON.parse(readFileSync(tampered.backupPath, 'utf8'));
  backup.tasks[0].taskPacketDigest = 'f'.repeat(64);
  writeFileSync(tampered.backupPath, `${JSON.stringify(backup)}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: tamperedCwd, taskId: 'legacy-active', expectedRevision: tampered.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_PROVENANCE_INVALID' });

  const sidecarCwd = repo();
  const sidecar = migrateV2BoundTask(sidecarCwd);
  mkdirSync(join(stateDirectory(sidecarCwd, 17), 'task-packets'), { recursive: true });
  writeFileSync(taskPacketSidecarPath(sidecarCwd, 17, 'legacy-active'), '{}\n');
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: sidecarCwd, taskId: 'legacy-active', expectedRevision: sidecar.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(existsSync(taskPacketSidecarPath(sidecarCwd, 17, 'legacy-active')), true);

  const receiptCwd = repo();
  const receipt = migrateV2BoundTask(receiptCwd);
  const receiptPath = taskBindingProvenanceReceiptPath(receiptCwd, 17, 'legacy-active');
  mkdirSync(join(stateDirectory(receiptCwd, 17), 'task-binding-provenance'), { recursive: true });
  writeFileSync(receiptPath, `${'f'.repeat(64)}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: receiptCwd, taskId: 'legacy-active', expectedRevision: receipt.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(existsSync(receiptPath), true);

  const completedCwd = repo();
  const completed = migrateV2BoundTask(completedCwd, { status: 'completed' });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: completedCwd, taskId: 'legacy-active', expectedRevision: completed.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
});

test('a bound schema-v3 task without its sidecar requires explicit replanning while completed v2 remains readable', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['missing-sidecar']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'missing-sidecar');
  state = bindPacket(cwd, state, packet);
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, packet.taskId);
  const provenanceReceipt = readFileSync(provenanceReceiptPath, 'utf8');
  rmSync(provenancePath);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(reconcileState({ cwd }).bindingProvenance[0].status, 'invalid');
  assert.match(renderRecoverySummary({ cwd }), /Task binding provenance: missing-sidecar=invalid/u);
  checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  assert.equal(existsSync(provenancePath), true);
  rmSync(provenanceReceiptPath);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(readSpecialistStatus({ cwd }).error, 'INVALID_TASK_BINDING_PROVENANCE');
  assert.equal(reconcileState({ cwd }).bindingProvenance[0].status, 'invalid');
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'INVALID_TASK_BINDING_PROVENANCE' });
  writeFileSync(provenanceReceiptPath, provenanceReceipt);
  rmSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId));
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  assert.match(renderRecoverySummary({ cwd }), /missing-sidecar=invalid/u);

  const completedV3 = checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision,
    verifiedLocalTaskIds: ['missing-sidecar'],
    threadResolutionStatus: {
      status: 'passed', headSha: state.currentIntegrationHeadSha, threads: [],
      threadlessVerification: emptyThreadless(),
      localVerification: {
        status: 'passed', headSha: state.currentIntegrationHeadSha,
        taskIds: ['missing-sidecar'], updatedAt: AT,
      },
      updatedAt: AT,
    },
  });
  assert.equal(completedV3.tasks[0].status, 'completed');
  assert.equal(reconcileState({ cwd }).packetSidecars[0].status, 'invalid');

  const historicalV2 = Object.fromEntries(Object.entries(packet)
    .filter(([key]) => !['specialization', 'riskTags'].includes(key))
    .map(([key, value]) => [key, key === 'schemaVersion' ? 2 : value]));
  const completed = {
    ...completedV3,
    tasks: completedV3.tasks.map((item) => ({ ...item, taskPacketDigest: taskPacketDigest(historicalV2) })),
  };
  assert.equal(assertTaskPacketBound(completed, historicalV2, { cwd }).id, packet.taskId);
  rmSync(provenancePath);
  rmSync(provenanceReceiptPath);
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(schemaV2State(completed))}\n`);
  migrateState({ cwd });
  assert.equal(reconcileState({ cwd }).packetSidecars[0].status, 'historical-v2');
});
