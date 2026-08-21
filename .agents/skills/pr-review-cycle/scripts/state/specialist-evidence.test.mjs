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

test('specialist plan creation recovers receipt-only interruption without weakening plan identity', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['receipt-retry']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'receipt-retry');
  const input = planInput(state, packet);
  const first = planSpecialists({
    cwd, input, expectedRevision: state.revision, now: () => AT,
  });
  const bundlePath = specialistReviewBundlePath(cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision);
  const receiptPath = specialistPlanReceiptPath(cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision);
  const receipt = readFileSync(receiptPath, 'utf8');
  assert.match(receipt, /^[0-9a-f]{64}\n$/u);

  rmSync(bundlePath);
  const interruptedStatus = readSpecialistStatus({ cwd });
  assert.equal(interruptedStatus.status, 'pending');
  assert.equal(interruptedStatus.error, 'SPECIALIST_PLAN_INCOMPLETE');
  assert.match(renderRecoverySummary({ cwd }), /Specialist evidence: pending/u);
  assert.match(renderRecoverySummary({ cwd }), /SPECIALIST_PLAN_INCOMPLETE/u);
  for (const conflictingInput of [
    planInput(state, { ...packet, evidence: 'Changed packet evidence.' }),
    planInput(state, packet, { browserVisible: true, testSelectionUncertain: false }),
  ]) {
    assert.throws(() => planSpecialists({
      cwd, input: conflictingInput, expectedRevision: state.revision,
      now: () => '2026-08-06T00:00:00Z',
    }), { code: 'SPECIALIST_PLAN_CONFLICT' });
    assert.equal(existsSync(bundlePath), false);
    assert.equal(readFileSync(receiptPath, 'utf8'), receipt);
  }

  const recovered = planSpecialists({
    cwd, input, expectedRevision: state.revision, now: () => '2026-08-06T00:00:00Z',
  });
  assert.equal(recovered.createdAt, '2026-08-06T00:00:00Z');
  assert.equal(readFileSync(receiptPath, 'utf8'), receipt);
  assert.equal(readSpecialistStatus({ cwd }).status, 'clean');

  const persisted = readFileSync(bundlePath, 'utf8');
  const idempotent = planSpecialists({
    cwd, input, expectedRevision: state.revision, now: () => '2026-08-07T00:00:00Z',
  });
  assert.deepEqual(idempotent, recovered);
  assert.equal(readFileSync(bundlePath, 'utf8'), persisted);

  rmSync(receiptPath);
  assert.throws(() => planSpecialists({
    cwd, input, expectedRevision: state.revision, now: () => '2026-08-08T00:00:00Z',
  }), { code: 'INVALID_SPECIALIST_REVIEW' });
  assert.equal(existsSync(receiptPath), false);
  writeFileSync(receiptPath, receipt);
  assert.equal(readSpecialistStatus({ cwd }).status, 'clean');
  assert.notEqual(first.createdAt, recovered.createdAt);
});

test('an already-bound pre-fix v3 packet repairs only from one exact historical pre-bind plan', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['pre-fix-bound']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'pre-fix-bound', {
    affectedAreas: ['web'], command: 'npm run check:web', specialization: 'web', riskTags: [],
  });
  packet.requiredValidation.system.push({
    command: 'npm run test:e2e:related -- --id id-a-host-switches-the-interface-to-italian --project tablet-chromium',
    reason: 'Exact browser-visible scenario selected before binding.',
    selectors: ['id-a-host-switches-the-interface-to-italian'], projects: ['tablet-chromium'],
  });
  planSpecialists({
    cwd, input: planInput(state, packet, { browserVisible: true, testSelectionUncertain: false }),
    expectedRevision: state.revision, now: () => AT,
  });
  recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: packet.reviewedHeadSha,
      reviewerId: 'behavior_mapper', outcome: 'clean',
      summary: 'Exact historical browser scenario selected.', findings: [],
    },
  });
  const planRevision = state.revision;
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, packet.taskId);
  const expectedProvenance = readFileSync(provenancePath, 'utf8');
  const expectedProvenanceReceipt = readFileSync(provenanceReceiptPath, 'utf8');
  rmSync(provenancePath);
  rmSync(provenanceReceiptPath);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });

  const repaired = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  });
  assert.equal(repaired.revision, state.revision);
  assert.equal(readFileSync(provenancePath, 'utf8'), expectedProvenance);
  assert.equal(readFileSync(provenanceReceiptPath, 'utf8'), expectedProvenanceReceipt);
  assert.equal(JSON.parse(expectedProvenance).behaviorMapperResult.evidence.summary, 'Exact historical browser scenario selected.');

  rmSync(provenancePath);
  const receiptPath = specialistPlanReceiptPath(cwd, state.prNumber, packet.reviewedHeadSha, planRevision);
  const receipt = readFileSync(receiptPath, 'utf8');
  writeFileSync(receiptPath, `${'f'.repeat(64)}\n`);
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED' });
  assert.equal(existsSync(provenancePath), false);
  writeFileSync(receiptPath, receipt);
  assert.doesNotThrow(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }));

  rmSync(provenancePath);
  const bundlePath = specialistReviewBundlePath(cwd, state.prNumber, packet.reviewedHeadSha, planRevision);
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  writeFileSync(bundlePath, `${JSON.stringify({
    ...bundle,
    tasks: bundle.tasks.map((planned) => ({
      ...planned,
      planningSignals: { browserVisible: false, testSelectionUncertain: false },
      route: routeSpecialists({
        specialization: planned.specialization,
        riskTags: planned.riskTags,
        browserVisible: false,
        testSelectionUncertain: false,
      }),
    })),
  })}\n`);
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED' });
  assert.equal(existsSync(provenancePath), false);
});

test('taskless post-integration planning yields receipt-backed final-verifier context', () => {
  const cwd = repo();
  const { validated } = tasklessVerifierFixture(cwd, [
    { id: 'z-already-fixed', disposition: 'already-fixed', status: 'not-applicable' },
    { id: 'a-invalid', disposition: 'invalid', status: 'not-applicable' },
  ]);
  const input = {
    schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha, tasks: [],
  };
  const stateBefore = readFileSync(statePath(cwd, validated.prNumber), 'utf8');
  const eventsPath = join(stateDirectory(cwd, validated.prNumber), 'events.ndjson');
  const eventsBefore = readFileSync(eventsPath, 'utf8');
  const bundle = planSpecialists({
    cwd, input, expectedRevision: validated.revision, now: () => AT,
  });
  assert.deepEqual(bundle.tasks, []);
  assert.deepEqual(bundle.records, []);
  assert.equal(readFileSync(statePath(cwd, validated.prNumber), 'utf8'), stateBefore);
  assert.equal(readFileSync(eventsPath, 'utf8'), eventsBefore);
  const bundlePath = specialistReviewBundlePath(
    cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
  );
  const receiptPath = specialistPlanReceiptPath(
    cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
  );
  assert.equal(existsSync(bundlePath), true);
  assert.match(readFileSync(receiptPath, 'utf8'), /^[0-9a-f]{64}\n$/u);
  assert.deepEqual(planSpecialists({
    cwd, input, expectedRevision: validated.revision, now: () => '2026-08-05T01:00:00Z',
  }), bundle);

  const context = specialistContext({ cwd });
  assert.equal(context.status, 'clean');
  assert.equal(context.readyForIntegrationVerifier, true);
  assert.deepEqual(context.packets, []);
  assert.deepEqual(context.routes, []);
  assert.deepEqual(context.workerResultEvidence, []);
  assert.deepEqual(context.workerResults, []);
  assert.deepEqual(context.preBindPlanning, []);
  assert.deepEqual(context.requiredReviewerIds, []);
  assert.deepEqual(context.specialistResults, []);
  assert.deepEqual(context.finalVerification, {
    verifierId: 'integration_verifier', priority: 'standard',
  });
  assert.deepEqual(context.targetedValidation, validated.validationStatus);
  assert.deepEqual(context.taskOutcomes, [
    {
      taskId: 'a-invalid', sourceIds: ['thread:a-invalid'], sourceType: 'github-thread',
      fingerprint: 'fingerprint-a-invalid', summary: 'Retained outcome for a-invalid.', severity: 'P1',
      disposition: 'invalid', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Evidence retained for a-invalid.',
    },
    {
      taskId: 'z-already-fixed', sourceIds: ['thread:z-already-fixed'], sourceType: 'github-thread',
      fingerprint: 'fingerprint-z-already-fixed', summary: 'Retained outcome for z-already-fixed.', severity: 'P1',
      disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Evidence retained for z-already-fixed.',
    },
  ]);
  assert.deepEqual(loadState(cwd).tasks, validated.tasks);
  assert.equal(readSpecialistStatus({ cwd }).status, 'clean');
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: validated.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: validated.revision, headSha: validated.currentIntegrationHeadSha,
      reviewerId: 'security_reviewer', outcome: 'clean', summary: 'No routed review exists.', findings: [],
    },
  }), { code: 'SPECIALIST_REVIEWER_MISMATCH' });
  assert.deepEqual(loadState(cwd).tasks, validated.tasks);
});

test('mixed specialist context projects uncovered archived outcomes without packet duplication', () => {
  const cwd = repo();
  const { packet, integrated } = canonicalBoundIntegratedTask(cwd, 'packet-backed-fix');
  const retained = appendVerifierOutcomeTasks(cwd, integrated, [
    { id: 'z-archived-already-fixed', disposition: 'already-fixed', status: 'not-applicable' },
    { id: 'a-archived-invalid', disposition: 'invalid', status: 'not-applicable' },
  ]);
  const validated = checkpointSyntheticTargetedValidation(cwd, retained);
  planSpecialists({
    cwd, expectedRevision: validated.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha,
      tasks: [{ taskPacket: packet }],
    },
  });
  const context = specialistContext({ cwd });
  assert.equal(context.status, 'clean');
  assert.equal(context.readyForIntegrationVerifier, true);
  assert.deepEqual(context.packets, [packet]);
  assert.deepEqual(context.routes.map(({ taskId }) => taskId), ['packet-backed-fix']);
  assert.deepEqual(context.workerResultEvidence.map(({ taskId, status }) => ({ taskId, status })), [
    { taskId: 'packet-backed-fix', status: 'valid' },
  ]);
  assert.deepEqual(context.taskOutcomes, [
    {
      taskId: 'a-archived-invalid',
      sourceIds: ['thread:a-archived-invalid', 'archive:a-archived-invalid'],
      sourceType: 'github-thread', fingerprint: 'fingerprint-a-archived-invalid',
      summary: 'Retained outcome for a-archived-invalid.', severity: 'P1', disposition: 'invalid',
      status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Evidence retained for a-archived-invalid.',
    },
    {
      taskId: 'z-archived-already-fixed',
      sourceIds: ['thread:z-archived-already-fixed', 'archive:z-archived-already-fixed'],
      sourceType: 'github-thread', fingerprint: 'fingerprint-z-archived-already-fixed',
      summary: 'Retained outcome for z-archived-already-fixed.', severity: 'P1',
      disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Evidence retained for z-archived-already-fixed.',
    },
  ]);
  assert.equal(context.taskOutcomes.some(({ taskId }) => taskId === 'packet-backed-fix'), false);
});

test('mixed specialist planning rejects every ineligible uncovered durable task', () => {
  const scenarios = [
    { id: 'uncovered-actionable', disposition: 'actionable', status: 'proposed' },
    { id: 'uncovered-nonterminal', disposition: 'already-fixed', status: 'proposed' },
    { id: 'uncovered-failed', disposition: 'already-fixed', status: 'failed' },
    { id: 'uncovered-human', disposition: 'needs-human-decision', status: 'not-applicable' },
  ];
  for (const scenario of scenarios) {
    const cwd = repo();
    const { packet, integrated } = canonicalBoundIntegratedTask(cwd, `packet-for-${scenario.id}`);
    const retained = appendVerifierOutcomeTasks(cwd, integrated, [scenario]);
    const validated = checkpointSyntheticTargetedValidation(cwd, retained);
    const bundlePath = specialistReviewBundlePath(
      cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
    );
    const receiptPath = specialistPlanReceiptPath(
      cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
    );
    assert.throws(() => planSpecialists({
      cwd, expectedRevision: validated.revision, now: () => AT,
      input: {
        schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha,
        tasks: [{ taskPacket: packet }],
      },
    }), { code: 'SPECIALIST_PLAN_TASK_MISMATCH' });
    assert.equal(existsSync(bundlePath), false);
    assert.equal(existsSync(receiptPath), false);
  }
});

test('Resolved packets remain in later validation and mixed final-verifier context', () => {
  const cwd = repo();
  const {
    priorPacket, currentPacket, priorId, currentId, integrated,
  } = completedAndIntegratedPacketFixture(cwd);
  const plan = buildTargetedValidationPlan({ cwd, now: () => AT });
  assert.deepEqual(plan.taskIds, [currentId, priorId]);
  assert.deepEqual(plan.commands.map(({ command }) => command), [
    'npm run check:api', 'npm run check:workflow',
  ]);
  const validated = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }).state;
  const bundle = planSpecialists({
    cwd, expectedRevision: validated.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha,
      tasks: [{ taskPacket: priorPacket }, { taskPacket: currentPacket }],
    },
  });
  assert.deepEqual(bundle.tasks.map(({ taskId }) => taskId), [currentId, priorId]);
  const context = specialistContext({ cwd });
  assert.equal(context.status, 'clean');
  assert.equal(context.readyForIntegrationVerifier, true);
  assert.deepEqual(context.packets.map(({ taskId }) => taskId), [currentId, priorId]);
  assert.deepEqual(context.routes.map(({ taskId }) => taskId), [currentId, priorId]);
  assert.deepEqual(context.workerResultEvidence.map(({ taskId, status }) => ({ taskId, status })), [
    { taskId: currentId, status: 'valid' }, { taskId: priorId, status: 'valid' },
  ]);
  assert.deepEqual(context.workerResults.map(({ taskId }) => taskId), [currentId, priorId]);
  assert.deepEqual(context.taskOutcomes.map(({ taskId }) => taskId), ['m-archived-outcome']);
  assert.equal(context.taskOutcomes.some(({ taskId }) => [currentId, priorId].includes(taskId)), false);
  assert.equal(context.workerResults.find(({ taskId }) => taskId === priorId).integratedCommitSha,
    integrated.tasks.find(({ id }) => id === priorId).integratedCommitSha);

  const allCompleted = completeLocalPacketTask(cwd, validated, currentId);
  const reset = checkpointTargetedValidationReset({
    cwd, expectedRevision: allCompleted.revision,
  });
  const completedPlan = buildTargetedValidationPlan({ cwd, replace: true, now: () => AT });
  assert.deepEqual(completedPlan.taskIds, [currentId, priorId]);
  writeFileSync(validationPlanPath(cwd, completedPlan.prNumber), `${JSON.stringify({
    ...completedPlan, taskIds: [],
  })}\n`);
  assert.throws(() => executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }), { code: 'VALIDATION_TASK_COVERAGE_MISMATCH' });
  writeFileSync(validationPlanPath(cwd, completedPlan.prNumber), `${JSON.stringify(completedPlan)}\n`);
  const completedValidated = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }).state;
  assert.equal(reset.revision + 1, completedValidated.revision);
  planSpecialists({
    cwd, expectedRevision: completedValidated.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: completedValidated.currentIntegrationHeadSha,
      tasks: [{ taskPacket: currentPacket }, { taskPacket: priorPacket }],
    },
  });
  const completedContext = specialistContext({ cwd });
  assert.deepEqual(completedContext.packets.map(({ taskId }) => taskId), [currentId, priorId]);
  assert.deepEqual(completedContext.workerResults.map(({ taskId }) => taskId), [currentId, priorId]);
  assert.deepEqual(completedContext.taskOutcomes.map(({ taskId }) => taskId), ['m-archived-outcome']);
});

test('Resolved packet receipts and ancestry survive a later active review head', () => {
  const cwd = repo();
  const {
    priorPacket, currentPacket, priorId, currentId, currentHead,
  } = completedAndIntegratedPacketFixture(cwd, { laterReview: true });
  assert.notEqual(priorPacket.reviewedHeadSha, currentPacket.reviewedHeadSha);
  buildTargetedValidationPlan({ cwd, now: () => AT });
  const validated = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }).state;
  assert.equal(validated.reviewedHeadSha, currentPacket.reviewedHeadSha);
  assert.equal(validated.currentIntegrationHeadSha, currentHead);
  assert.notEqual(currentPacket.reviewedHeadSha, currentHead);
  assert.deepEqual(validated.tasks.filter(({ disposition }) => disposition === 'actionable')
    .map(({ id, status }) => ({ id, status })), [
    { id: priorId, status: 'completed' }, { id: currentId, status: 'integrated' },
  ]);
  planSpecialists({
    cwd, expectedRevision: validated.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha,
      tasks: [{ taskPacket: priorPacket }, { taskPacket: currentPacket }],
    },
  });
  assert.equal(specialistContext({ cwd }).readyForIntegrationVerifier, true);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(
    cwd, validated.prNumber, priorId,
  );
  const provenanceReceipt = readFileSync(provenanceReceiptPath, 'utf8');
  writeFileSync(provenanceReceiptPath, `${'f'.repeat(64)}\n`);
  assert.throws(() => specialistContext({ cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  writeFileSync(provenanceReceiptPath, provenanceReceipt);

  const tree = git(cwd, ['rev-parse', `${validated.currentIntegrationHeadSha}^{tree}`]);
  const unrelated = git(cwd, ['commit-tree', tree, '-m', 'unrelated Resolved packet ancestry']);
  const stateSource = readFileSync(statePath(cwd, validated.prNumber), 'utf8');
  writeFileSync(statePath(cwd, validated.prNumber), `${JSON.stringify({
    ...validated,
    tasks: validated.tasks.map((item) => item.id === priorId
      ? { ...item, taskPacketDigest: 'f'.repeat(64) } : item),
  })}\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  writeFileSync(statePath(cwd, validated.prNumber), stateSource);

  const altered = {
    ...validated,
    tasks: validated.tasks.map((item) => item.id === priorId
      ? { ...item, integratedCommitSha: unrelated } : item),
  };
  writeFileSync(statePath(cwd, validated.prNumber), `${JSON.stringify(altered)}\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH' });
  writeFileSync(statePath(cwd, validated.prNumber), stateSource);

  const reset = checkpointTargetedValidationReset({ cwd, expectedRevision: validated.revision });
  const resetSource = readFileSync(statePath(cwd, reset.prNumber), 'utf8');
  writeFileSync(statePath(cwd, reset.prNumber), `${JSON.stringify({
    ...reset,
    tasks: reset.tasks.map((item) => item.id === priorId
      ? { ...item, integratedCommitSha: unrelated } : item),
  })}\n`);
  assert.throws(() => buildTargetedValidationPlan({ cwd, now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  writeFileSync(statePath(cwd, reset.prNumber), resetSource);
});

test('taskless specialist planning rejects ineligible states before durable evidence writes', () => {
  const scenarios = [
    [{ id: 'actionable-omission', disposition: 'actionable', status: 'proposed' }],
    [{ id: 'nonterminal-outcome', disposition: 'already-fixed', status: 'proposed' }],
    [{ id: 'failed-outcome', disposition: 'already-fixed', status: 'failed' }],
    [{ id: 'human-outcome', disposition: 'needs-human-decision', status: 'not-applicable' }],
  ];
  for (const definitions of scenarios) {
    const cwd = repo();
    const { validated } = tasklessVerifierFixture(cwd, definitions);
    const stateBefore = readFileSync(statePath(cwd, validated.prNumber), 'utf8');
    const eventsPath = join(stateDirectory(cwd, validated.prNumber), 'events.ndjson');
    const eventsBefore = readFileSync(eventsPath, 'utf8');
    const bundlePath = specialistReviewBundlePath(
      cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
    );
    const receiptPath = specialistPlanReceiptPath(
      cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
    );
    assert.throws(() => planSpecialists({
      cwd, expectedRevision: validated.revision, now: () => AT,
      input: {
        schemaVersion: 1, stage: 'post-integration',
        headSha: validated.currentIntegrationHeadSha, tasks: [],
      },
    }), { code: 'SPECIALIST_PLAN_TASK_MISMATCH' });
    assert.equal(readFileSync(statePath(cwd, validated.prNumber), 'utf8'), stateBefore);
    assert.equal(readFileSync(eventsPath, 'utf8'), eventsBefore);
    assert.equal(existsSync(bundlePath), false);
    assert.equal(existsSync(receiptPath), false);
  }
});

test('taskless specialist planning and context fail closed on stale or altered authority', () => {
  const preBindCwd = repo();
  const preBind = init(preBindCwd);
  assert.throws(() => planSpecialists({
    cwd: preBindCwd, expectedRevision: preBind.revision,
    input: { schemaVersion: 1, stage: 'pre-bind', headSha: preBind.currentIntegrationHeadSha, tasks: [] },
  }), { code: 'INVALID_SPECIALIST_PLAN' });

  const missingValidationCwd = repo();
  const { validated: missingValidation } = tasklessVerifierFixture(missingValidationCwd, undefined, { validate: false });
  assert.throws(() => planSpecialists({
    cwd: missingValidationCwd, expectedRevision: missingValidation.revision,
    input: {
      schemaVersion: 1, stage: 'post-integration',
      headSha: missingValidation.currentIntegrationHeadSha, tasks: [],
    },
  }), { code: 'SPECIALIST_VALIDATION_REQUIRED' });

  const cwd = repo();
  const { validated } = tasklessVerifierFixture(cwd);
  const input = {
    schemaVersion: 1, stage: 'post-integration', headSha: validated.currentIntegrationHeadSha, tasks: [],
  };
  assert.throws(() => planSpecialists({
    cwd, input, expectedRevision: validated.revision - 1,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.throws(() => planSpecialists({
    cwd, expectedRevision: validated.revision,
    input: { ...input, headSha: 'f'.repeat(40) },
  }), { code: 'SPECIALIST_PLAN_STALE' });
  planSpecialists({ cwd, input, expectedRevision: validated.revision, now: () => AT });
  const bundlePath = specialistReviewBundlePath(
    cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
  );
  const receiptPath = specialistPlanReceiptPath(
    cwd, validated.prNumber, validated.currentIntegrationHeadSha, validated.revision,
  );
  const bundle = readFileSync(bundlePath, 'utf8');
  const receipt = readFileSync(receiptPath, 'utf8');
  writeFileSync(bundlePath, `${JSON.stringify({ ...JSON.parse(bundle), tasks: [{}] })}\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'INVALID_SPECIALIST_REVIEW' });
  writeFileSync(bundlePath, bundle);
  writeFileSync(receiptPath, `${'0'.repeat(64)}\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'INVALID_SPECIALIST_REVIEW' });
  writeFileSync(receiptPath, receipt);

  const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
  writeFileSync(join(cwd, 'README.md'), `${readme}dirty\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'SPECIALIST_PLAN_STALE' });
  writeFileSync(join(cwd, 'README.md'), readme);
  commit(cwd, { 'scripts/taskless-later.mjs': 'export const later = true;\n' }, 'advance taskless context');
  assert.throws(() => specialistContext({ cwd }), { code: 'SPECIALIST_PLAN_STALE' });
  checkpointGitMetadata({ cwd });
  assert.throws(() => specialistContext({ cwd }), { code: 'SPECIALIST_EVIDENCE_MISSING' });
});

test('behavior mapping gates binding and exact-head risk evidence feeds only verifier context', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['browser-task']);
  const browserPacket = taskPacket(state.currentIntegrationHeadSha, 'browser-task', {
    affectedAreas: ['web'], command: 'npm run check:web', specialization: 'web', riskTags: ['localization'],
  });
  browserPacket.requiredValidation.system.push({
    command: 'npm run test:e2e:related -- --id id-a-host-switches-the-interface-to-italian --project tablet-chromium',
    reason: 'Exact localization scenario selected by behavior mapping.',
    selectors: ['id-a-host-switches-the-interface-to-italian'],
    projects: ['tablet-chromium'],
  });
  planSpecialists({
    cwd, input: planInput(state, browserPacket, { browserVisible: true, testSelectionUncertain: false }),
    expectedRevision: state.revision, now: () => AT,
  });
  const preBundlePath = specialistReviewBundlePath(cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision);
  const preReceiptPath = specialistPlanReceiptPath(cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision);
  const preBundle = JSON.parse(readFileSync(preBundlePath, 'utf8'));
  const preReceipt = readFileSync(preReceiptPath, 'utf8');
  writeFileSync(preBundlePath, `${JSON.stringify({
    ...preBundle,
    tasks: preBundle.tasks.map((item) => ({
      ...item, planningSignals: { ...item.planningSignals, inferredFallback: false },
    })),
  })}\n`);
  assert.throws(() => checkpointTaskPacketBinding({ cwd, packet: browserPacket, expectedRevision: state.revision }), {
    code: 'INVALID_SPECIALIST_REVIEW',
  });
  writeFileSync(preBundlePath, `${JSON.stringify(preBundle)}\n`);
  assert.throws(() => checkpointTaskPacketBinding({ cwd, packet: browserPacket, expectedRevision: state.revision }), {
    code: 'BEHAVIOR_MAPPING_REQUIRED',
  });
  const recordInput = {
    schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
    reviewerId: 'behavior_mapper', outcome: 'clean', summary: 'Exact scenarios and projects selected.', findings: [],
  };
  const signals = preBundle.tasks[0].planningSignals;
  const coherentlyTamperedPackets = [
    { ...browserPacket, taskId: 'forged-browser-task' },
    { ...browserPacket, evidence: 'Forged pre-bind evidence.' },
    { ...browserPacket, specialization: 'behavior-tests' },
    { ...browserPacket, riskTags: ['responsive'] },
  ];
  for (const taskPacket of coherentlyTamperedPackets) {
    const tamperedTask = {
      ...preBundle.tasks[0],
      taskId: taskPacket.taskId,
      packetDigest: taskPacketDigest(taskPacket),
      specialization: taskPacket.specialization,
      riskTags: taskPacket.riskTags,
      route: routeSpecialists({
        specialization: taskPacket.specialization,
        riskTags: taskPacket.riskTags,
        browserVisible: signals.browserVisible,
        testSelectionUncertain: signals.testSelectionUncertain,
      }),
      taskPacket,
    };
    writeFileSync(preBundlePath, `${JSON.stringify({ ...preBundle, tasks: [tamperedTask] })}\n`);
    assert.throws(() => recordSpecialistReview({
      cwd, expectedRevision: state.revision, input: recordInput, now: () => AT,
    }), { code: 'INVALID_SPECIALIST_REVIEW' });
    const status = readSpecialistStatus({ cwd });
    assert.equal(status.status, 'stale');
    assert.equal(status.error, 'INVALID_SPECIALIST_REVIEW');
    assert.match(reconcileState({ cwd }).evidenceErrors.join('\n'), /Specialist review bundle is invalid/u);
  }
  writeFileSync(preBundlePath, `${JSON.stringify(preBundle)}\n`);
  rmSync(preReceiptPath);
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: state.revision, input: recordInput, now: () => AT,
  }), { code: 'INVALID_SPECIALIST_REVIEW' });
  assert.equal(readSpecialistStatus({ cwd }).error, 'INVALID_SPECIALIST_REVIEW');
  assert.match(reconcileState({ cwd }).evidenceErrors.join('\n'), /Specialist review bundle is invalid/u);
  writeFileSync(preReceiptPath, preReceipt);
  recordSpecialistReview({
    cwd, expectedRevision: state.revision,
    input: recordInput,
    now: () => AT,
  });
  state = checkpointTaskPacketBinding({ cwd, packet: browserPacket, expectedRevision: state.revision });
  buildTargetedValidationPlan({ cwd, now: () => AT });
  state = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT }).state;
  const postInput = {
    schemaVersion: 1, stage: 'post-integration', headSha: state.currentIntegrationHeadSha,
    tasks: [{ taskPacket: browserPacket }],
  };
  const post = planSpecialists({ cwd, input: postInput, expectedRevision: state.revision, now: () => AT });
  assert.deepEqual(post.records, []);
  const context = specialistContext({ cwd });
  assert.equal(context.readyForIntegrationVerifier, false);
  assert.deepEqual(context.missingWorkerResultTaskIds, ['browser-task']);
  assert.deepEqual(context.packets, [browserPacket]);
  assert.deepEqual(context.routes.map(({ taskId }) => taskId), ['browser-task']);
  assert.equal(context.routes[0].route.profileGuidePath, 'profiles/web.md');
  assert.equal(context.routes[0].route.schemaVersion, 2);
  assert.deepEqual(context.routes[0].route.planningHelpers.map(({ id }) => id), ['behavior_mapper']);
  assert.deepEqual(context.routes[0].route.riskReviewers, []);
  assert.equal(JSON.stringify(context.routes[0].route).includes('integration_verifier'), false);
  assert.deepEqual(context.finalVerification, {
    verifierId: 'integration_verifier', priority: 'standard',
  });
  assert.deepEqual(context.requiredReviewerIds, []);
  assert.equal(readSpecialistStatus({ cwd }).status, 'clean');
});

test('signal-only behavior mapping survives binding and compound provenance tampering fails every specialist consumer', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['signal-only-mapping']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'signal-only-mapping', {
    specialization: 'api', riskTags: [],
  });
  packet.requiredValidation.system.push({
    command: 'npm run test:e2e:related -- --id id-a-host-switches-the-interface-to-italian --project tablet-chromium',
    reason: 'Explicit browser-visible planning signal selected this scenario.',
    selectors: ['id-a-host-switches-the-interface-to-italian'], projects: ['tablet-chromium'],
  });
  planSpecialists({
    cwd, input: planInput(state, packet, { browserVisible: false, testSelectionUncertain: true }),
    expectedRevision: state.revision, now: () => AT,
  });
  recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: packet.reviewedHeadSha,
      reviewerId: 'behavior_mapper', outcome: 'clean',
      summary: 'Browser-visible scenario and project selected.', findings: [],
    },
  });
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  assert.deepEqual(provenance.planningSignals, {
    browserVisible: false, testSelectionUncertain: true,
  });
  assert.equal(provenance.route.schemaVersion, 2);
  assert.equal(JSON.stringify(provenance.route).includes('integration_verifier'), false);
  assert.equal(provenance.behaviorMapperResult.phase, 'planning');
  assert.equal(provenance.behaviorMapperResult.evidence.headSha, packet.reviewedHeadSha);

  buildTargetedValidationPlan({ cwd, now: () => AT });
  state = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT }).state;
  const postInput = {
    schemaVersion: 1, stage: 'post-integration', headSha: state.currentIntegrationHeadSha,
    tasks: [{ taskPacket: packet }],
  };
  const post = planSpecialists({ cwd, input: postInput, expectedRevision: state.revision, now: () => AT });
  assert.deepEqual(post.tasks[0].planningSignals, provenance.planningSignals);
  assert.deepEqual(post.tasks[0].route.planningHelpers.map(({ id }) => id), ['behavior_mapper']);
  assert.deepEqual(post.tasks[0].route.riskReviewers, []);
  assert.deepEqual(post.records, []);
  const context = specialistContext({ cwd });
  assert.equal(context.readyForIntegrationVerifier, false);
  assert.deepEqual(context.missingWorkerResultTaskIds, ['signal-only-mapping']);
  assert.deepEqual(context.requiredReviewerIds, []);
  assert.deepEqual(context.finalVerification, {
    verifierId: 'integration_verifier', priority: 'standard',
  });
  assert.equal(context.preBindPlanning[0].phase, 'pre-bind');
  assert.equal(context.preBindPlanning[0].behaviorMapperResult.phase, 'planning');
  assert.equal(context.preBindPlanning[0].route.planningHelpers[0].reasons[0], 'signal:testSelectionUncertain');
  assert.equal(context.routes[0].phase, 'post-integration');
  assert.equal(context.postIntegrationReview.phase, 'review');
  assert.deepEqual(context.postIntegrationReview.specialistResults, []);

  const historicalBundlePath = specialistReviewBundlePath(
    cwd, state.prNumber, provenance.reviewedHeadSha, provenance.planRevision,
  );
  const historicalReceiptPath = specialistPlanReceiptPath(
    cwd, state.prNumber, provenance.reviewedHeadSha, provenance.planRevision,
  );
  const historicalBundle = JSON.parse(readFileSync(historicalBundlePath, 'utf8'));
  const historicalReceipt = readFileSync(historicalReceiptPath, 'utf8');
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(
    cwd, state.prNumber, packet.taskId,
  );
  const provenanceReceipt = readFileSync(provenanceReceiptPath, 'utf8');
  const forgedMapperSummary = 'Coherently forged in both mutable evidence files.';
  writeFileSync(historicalBundlePath, `${JSON.stringify({
    ...historicalBundle,
    records: historicalBundle.records.map((record) => record.reviewerId === 'behavior_mapper'
      ? { ...record, summary: forgedMapperSummary } : record),
  })}\n`);
  writeFileSync(provenancePath, `${JSON.stringify({
    ...provenance,
    behaviorMapperResult: {
      ...provenance.behaviorMapperResult,
      evidence: { ...provenance.behaviorMapperResult.evidence, summary: forgedMapperSummary },
    },
  })}\n`);
  assert.equal(readFileSync(historicalReceiptPath, 'utf8'), historicalReceipt);
  assert.equal(readFileSync(provenanceReceiptPath, 'utf8'), provenanceReceipt);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.throws(() => specialistContext({ cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(readSpecialistStatus({ cwd }).error, 'INVALID_TASK_BINDING_PROVENANCE');
  assert.equal(reconcileState({ cwd }).bindingProvenance[0].status, 'invalid');
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
      reviewerId: 'security_reviewer', outcome: 'clean', summary: 'Should not record.', findings: [],
    },
  }), { code: 'INVALID_TASK_BINDING_PROVENANCE' });
  writeFileSync(historicalBundlePath, `${JSON.stringify(historicalBundle)}\n`);
  writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
  assert.doesNotThrow(() => assertTaskPacketBound(state, packet, { cwd }));

  const tamperedSignals = { browserVisible: true, testSelectionUncertain: false };
  const tampered = {
    ...provenance,
    planReceiptDigest: 'f'.repeat(64),
    planningSignals: tamperedSignals,
    route: routeSpecialists({
      specialization: packet.specialization,
      riskTags: packet.riskTags,
      ...tamperedSignals,
    }),
    behaviorMapperResult: {
      phase: 'planning',
      evidence: {
        ...provenance.behaviorMapperResult.evidence,
        summary: 'Coherently forged mapper evidence.',
      },
    },
  };
  writeFileSync(provenancePath, `${JSON.stringify(tampered)}\n`);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.throws(() => specialistContext({ cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(readSpecialistStatus({ cwd }).status, 'stale');
  assert.equal(readSpecialistStatus({ cwd }).error, 'INVALID_TASK_BINDING_PROVENANCE');
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
      reviewerId: 'security_reviewer', outcome: 'clean', summary: 'Should not record.', findings: [],
    },
  }), { code: 'INVALID_TASK_BINDING_PROVENANCE' });
  const recovery = reconcileState({ cwd });
  assert.equal(recovery.bindingProvenance[0].status, 'invalid');
  assert.match(recovery.evidenceErrors.join('\n'), /binding provenance/u);
});

test('behavior mapping cannot bind without exact related-E2E selectors and projects', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['missing-related-selection']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'missing-related-selection', {
    affectedAreas: ['web'], command: 'npm run check:web', specialization: 'web', riskTags: ['responsive'],
  });
  planSpecialists({
    cwd,
    input: planInput(state, packet, { browserVisible: true, testSelectionUncertain: true }),
    expectedRevision: state.revision,
    now: () => AT,
  });
  recordSpecialistReview({
    cwd,
    expectedRevision: state.revision,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
      reviewerId: 'behavior_mapper', outcome: 'clean', summary: 'Planning response omitted an exact selection.', findings: [],
    },
    now: () => AT,
  });
  assert.throws(
    () => checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision }),
    { code: 'BEHAVIOR_TEST_SELECTION_REQUIRED' },
  );
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);
});

test('behavior mapping remains bound to the reviewed commit after dependent integration advances HEAD', () => {
  const cwd = repo();
  const {
    packet: firstPacket, integrated, reviewedHead, integratedHead,
  } = canonicalBoundIntegratedTask(cwd, 'first-dependency');
  const laterTask = task(reviewedHead, {
    id: 'later-browser-task', sourceIds: ['local:later-browser-task'], fingerprint: 'later-browser-task',
    status: 'proposed', disposition: 'actionable', integratedCommitSha: null, resolutionSummary: null,
  });
  const state = checkpointState({
    cwd, expectedRevision: integrated.revision,
    nextState: { ...integrated, tasks: [...integrated.tasks, laterTask] },
  });
  const packet = taskPacket(reviewedHead, laterTask.id, {
    affectedAreas: ['web'], command: 'npm run check:web', specialization: 'web', riskTags: ['localization'],
  });
  packet.requiredValidation.system.push({
    command: 'npm run test:e2e:related -- --id id-a-host-switches-the-interface-to-italian --project tablet-chromium',
    reason: 'Exact localization scenario selected against the reviewed commit.',
    selectors: ['id-a-host-switches-the-interface-to-italian'], projects: ['tablet-chromium'],
  });
  assert.notEqual(reviewedHead, integratedHead);
  assert.throws(() => planSpecialists({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: { ...planInput(state, packet, { browserVisible: true, testSelectionUncertain: false }), headSha: integratedHead },
  }), { code: 'SPECIALIST_PLAN_STALE' });

  const planned = planSpecialists({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: planInput(state, packet, { browserVisible: true, testSelectionUncertain: false }),
  });
  assert.equal(planned.headSha, reviewedHead);
  assert.equal(planned.tasks[0].reviewedHeadSha, reviewedHead);
  assert.equal(existsSync(specialistReviewBundlePath(cwd, state.prNumber, reviewedHead, state.revision)), true);
  assert.equal(existsSync(specialistReviewBundlePath(cwd, state.prNumber, integratedHead, state.revision)), false);
  assert.equal(readSpecialistStatus({ cwd }).headSha, reviewedHead);
  recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: reviewedHead,
      reviewerId: 'behavior_mapper', outcome: 'clean', summary: 'Reviewed-commit scenarios selected.', findings: [],
    },
  });
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  const laterIntegratedHead = commit(cwd, {
    'scripts/later-browser-task.mjs': 'export const laterBrowserTask = true;\n',
  }, 'integrate later browser task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, packet.taskId, laterIntegratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet,
    result: workerResult(packet, laterIntegratedHead, ['scripts/later-browser-task.mjs']),
    expectedRevision: implementedBeforeAcceptance.revision,
  });
  const integratedTasksAtHead = accepted.tasks.map((taskItem) => {
    if (taskItem.id !== packet.taskId) return taskItem;
    const { execution: _execution, ...withoutExecution } = taskItem;
    return {
      ...withoutExecution,
      status: 'integrated',
      integratedCommitSha: laterIntegratedHead,
      resolutionSummary: 'Integrated centrally; targeted validation remains.',
    };
  });
  let integratedLater = checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: { ...accepted, tasks: integratedTasksAtHead },
  });
  assert.equal(bound.tasks.find((taskItem) => taskItem.id === packet.taskId).taskPacketDigest, taskPacketDigest(packet));
  buildTargetedValidationPlan({ cwd, now: () => AT });
  integratedLater = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }).state;
  const post = planSpecialists({
    cwd, expectedRevision: integratedLater.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: laterIntegratedHead,
      tasks: [{ taskPacket: firstPacket }, { taskPacket: packet }],
    },
  });
  assert.equal(post.headSha, laterIntegratedHead);
  const context = specialistContext({ cwd });
  const preBind = context.preBindPlanning.find((entry) => entry.taskId === packet.taskId);
  const postRoute = context.routes.find((entry) => entry.taskId === packet.taskId);
  assert.equal(preBind.reviewedHeadSha, reviewedHead);
  assert.equal(preBind.behaviorMapperResult.phase, 'planning');
  assert.equal(preBind.behaviorMapperResult.evidence.headSha, reviewedHead);
  assert.deepEqual(preBind.planningSignals, {
    browserVisible: true, testSelectionUncertain: false,
  });
  assert.equal(postRoute.phase, 'post-integration');
  assert.equal(postRoute.route.signals.browserVisible, true);
  assert.ok(postRoute.route.planningHelpers.some(({ id }) => id === 'behavior_mapper'));
  assert.equal(context.headSha, laterIntegratedHead);
  assert.notEqual(context.headSha, preBind.reviewedHeadSha);
  assert.deepEqual(context.missingWorkerResultTaskIds, []);
  assert.deepEqual(context.invalidWorkerResultTaskIds, []);
  const laterResult = context.workerResults.find((entry) => entry.taskId === packet.taskId);
  assert.equal(laterResult.packetDigest, taskPacketDigest(packet));
  assert.equal(laterResult.reviewedHeadSha, reviewedHead);
  assert.equal(laterResult.workerCommitSha, laterIntegratedHead);
  assert.equal(laterResult.integratedCommitSha, laterIntegratedHead);
  assert.deepEqual(laterResult.result, workerResult(
    packet, laterIntegratedHead, ['scripts/later-browser-task.mjs'],
  ));
});

test('PR context selects its own final verifier and aggregates high priority across routes', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['security-task', 'billing-task']);
  const securityPacket = taskPacket(state.currentIntegrationHeadSha, 'security-task', {
    specialization: 'api', riskTags: ['authorization'],
  });
  const billingPacket = taskPacket(state.currentIntegrationHeadSha, 'billing-task', {
    specialization: 'api', riskTags: ['billing'],
  });
  state = bindPackets(cwd, state, [securityPacket, billingPacket]);
  assert.equal(state.schemaVersion, 3);
  buildTargetedValidationPlan({ cwd, now: () => AT });
  state = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  }).state;
  const bundle = planSpecialists({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: state.currentIntegrationHeadSha,
      tasks: [{ taskPacket: securityPacket }, { taskPacket: billingPacket }],
    },
  });
  assert.deepEqual(bundle.tasks.map(({ route: taskRoute }) =>
    taskRoute.finalVerificationPriority), ['high', 'standard']);
  assert.equal(bundle.tasks.every(({ route: taskRoute }) =>
    JSON.stringify(taskRoute).includes('integration_verifier') === false), true);

  let context = specialistContext({ cwd });
  assert.deepEqual(context.finalVerification, {
    verifierId: 'integration_verifier', priority: 'high',
  });
  assert.deepEqual(context.requiredReviewerIds, ['security_reviewer']);
  assert.equal(context.requiredReviewerIds.includes('integration_verifier'), false);
  assert.equal(context.readyForIntegrationVerifier, false);
  assert.deepEqual(readSpecialistStatus({ cwd }), {
    status: 'pending',
    headSha: state.currentIntegrationHeadSha,
    stateRevision: state.revision,
    bundlePath: specialistReviewBundlePath(
      cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision,
    ),
    stage: 'post-integration',
    requiredReviewerIds: ['security_reviewer'],
    recordedReviewerIds: [],
    missingReviewerIds: ['security_reviewer'],
    staleReviewerIds: [],
    findingReviewerIds: [],
  });
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
      reviewerId: 'integration_verifier', outcome: 'clean', summary: 'Not reusable evidence.', findings: [],
    },
  }), { code: 'SPECIALIST_REVIEWER_MISMATCH' });

  recordSpecialistReview({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
      reviewerId: 'security_reviewer', outcome: 'clean', summary: 'No authorization finding.', findings: [],
    },
  });
  context = specialistContext({ cwd });
  assert.equal(context.readyForIntegrationVerifier, false);
  assert.deepEqual(context.missingWorkerResultTaskIds, ['billing-task', 'security-task']);
  assert.deepEqual(context.finalVerification, {
    verifierId: 'integration_verifier', priority: 'high',
  });
  const status = readSpecialistStatus({ cwd });
  assert.equal(status.status, 'clean');
  assert.deepEqual(status.requiredReviewerIds, ['security_reviewer']);
  assert.deepEqual(status.recordedReviewerIds, ['security_reviewer']);
  assert.equal(status.requiredReviewerIds.includes('integration_verifier'), false);
  assert.equal(status.requiredReviewerIds.includes('behavior_mapper'), false);
});

test('specialist risk evidence is exact reviewer/head/revision, deduplicated, tamper-proof, and stale after HEAD change', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['security-task']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'security-task', {
    specialization: 'api', riskTags: ['authentication'],
  });
  state = bindPacket(cwd, state, packet);
  buildTargetedValidationPlan({ cwd, now: () => AT });
  state = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT }).state;
  planSpecialists({
    cwd, expectedRevision: state.revision, now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: state.currentIntegrationHeadSha,
      tasks: [{ taskPacket: packet }],
    },
  });
  const pendingContext = specialistContext({ cwd });
  assert.equal(pendingContext.status, 'incomplete');
  assert.deepEqual(pendingContext.requiredReviewerIds, ['security_reviewer']);
  assert.deepEqual(pendingContext.finalVerification, {
    verifierId: 'integration_verifier', priority: 'standard',
  });
  assert.equal(readSpecialistStatus({ cwd }).status, 'pending');
  const record = {
    schemaVersion: 1, planRevision: state.revision, headSha: state.currentIntegrationHeadSha,
    reviewerId: 'security_reviewer', outcome: 'findings', summary: 'Authentication review found a gap.',
    findings: [{ summary: 'Recheck session revocation before final verification.' }],
  };
  const bundlePath = specialistReviewBundlePath(cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision);
  const plannedBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  writeFileSync(bundlePath, `${JSON.stringify({
    ...plannedBundle,
    tasks: plannedBundle.tasks.map((item) => ({ ...item, packetDigest: 'b'.repeat(64) })),
  })}\n`);
  assert.throws(() => recordSpecialistReview({
    cwd, input: record, expectedRevision: state.revision, now: () => AT,
  }), { code: 'INVALID_SPECIALIST_REVIEW' });
  writeFileSync(bundlePath, `${JSON.stringify(plannedBundle)}\n`);
  recordSpecialistReview({ cwd, input: record, expectedRevision: state.revision, now: () => AT });
  recordSpecialistReview({ cwd, input: record, expectedRevision: state.revision, now: () => AT });
  assert.equal(specialistContext({ cwd }).status, 'incomplete');
  assert.equal(specialistContext({ cwd }).readyForIntegrationVerifier, false);
  assert.equal(readSpecialistStatus({ cwd }).status, 'finding');
  assert.throws(() => recordSpecialistReview({
    cwd, expectedRevision: state.revision,
    input: { ...record, reviewerId: 'offline_realtime_reviewer' },
  }), { code: 'SPECIALIST_REVIEWER_MISMATCH' });

  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  for (const records of [
    bundle.records.map((item) => ({ ...item, rawLog: 'tampered raw output' })),
    bundle.records.map((item) => ({ ...item, findings: item.findings.map((finding) => ({
      ...finding, transcript: 'tampered transcript',
    })) })),
    bundle.records.map((item) => ({ ...item, recordedAt: 'not-a-date' })),
  ]) {
    writeFileSync(bundlePath, `${JSON.stringify({ ...bundle, records })}\n`);
    assert.throws(() => specialistContext({ cwd }), { code: 'INVALID_SPECIALIST_REVIEW' });
    assert.match(reconcileState({ cwd }).evidenceErrors.join('\n'), /Specialist review bundle is invalid/u);
  }
  writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`);
  writeFileSync(bundlePath, `${JSON.stringify({
    ...bundle,
    tasks: bundle.tasks.map((item) => ({ ...item, route: { ...item.route, riskReviewers: [] } })),
  })}\n`);
  assert.throws(() => specialistContext({ cwd }), { code: 'INVALID_SPECIALIST_REVIEW' });
  writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`);

  commit(cwd, { 'scripts/security-later.mjs': 'export const later = true;\n' }, 'advance after specialist review');
  assert.equal(readSpecialistStatus({ cwd }).status, 'stale');
  assert.throws(() => specialistContext({ cwd }), { code: 'SPECIALIST_PLAN_STALE' });
  assert.throws(() => recordSpecialistReview({
    cwd, input: record, expectedRevision: state.revision, now: () => AT,
  }), { code: 'SPECIALIST_PLAN_STALE' });
  checkpointGitMetadata({ cwd });
  assert.equal(readSpecialistStatus({ cwd }).status, 'stale');
  assert.throws(() => specialistContext({ cwd }), { code: 'SPECIALIST_EVIDENCE_MISSING' });
});
