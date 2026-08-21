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

test('v2 loading requires explicit migration and writes an exact versioned backup', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const {
    staleDiscoveryDispositions: _staleDiscoveryDispositions,
    ciValidationStatus: _ciValidationStatus, ciValidationHistory: _ciValidationHistory,
    validationStatus, ...currentFields
  } = initialized;
  const priorV2 = {
    ...currentFields, schemaVersion: 2,
    validationStatus: {
      status: validationStatus.status, headSha: validationStatus.headSha,
      checks: validationStatus.checks, updatedAt: validationStatus.updatedAt,
    },
  };
  const source = `${JSON.stringify(priorV2)}\n`;
  assert.throws(
    () => migratePrReviewStateV2({ ...priorV2, phase: 'complete' }),
    { code: 'STATE_MIGRATION_FAILED' },
  );
  writeFileSync(statePath(cwd, 17), source);
  assert.throws(() => loadState(cwd), { code: 'STATE_MIGRATION_REQUIRED' });
  const migrated = migrateState({ cwd });
  assert.equal(migrated.state.schemaVersion, 3);
  assert.deepEqual(migrated.state.staleDiscoveryDispositions, []);
  assert.equal(readFileSync(migrated.backupPath, 'utf8'), source);
  assert.match(migrated.backupPath, /state\.v2\.backup\.json$/u);
});

test('v2 migration preserves a pending exact-head review while resetting targeted validation', () => {
  const cwd = repo();
  const prepared = ready(init(cwd), []);
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  const {
    staleDiscoveryDispositions: _staleDiscoveryDispositions,
    ciValidationStatus: _ciValidationStatus,
    ciValidationHistory: _ciValidationHistory,
    validationStatus,
    ...currentFields
  } = requested;
  const { source: _source, scope: _scope, ...legacyValidationStatus } = validationStatus;
  const priorV2 = {
    ...currentFields,
    schemaVersion: 2,
    validationStatus: legacyValidationStatus,
  };

  const migrated = migratePrReviewStateV2(priorV2, { migratedAt: AT });

  assert.equal(migrated.phase, 'awaiting-review');
  assert.equal(migrated.reviewRequest.id, requested.reviewRequest.id);
  assert.equal(migrated.reviewHistory.at(-1).outcome, null);
  assert.equal(migrated.validationStatus.status, 'not-run');
  assert.equal(migrated.ciValidationStatus.status, 'not-run');
  assert.deepEqual(migrated.ciValidationHistory, []);
  assert.match(migrated.nextAction, /Collect the pending exact-head review/u);
  assert.equal(buildReviewOutcomeTransition(migrated, outcome(migrated)).reviewOutcome.outcome, 'clean');
});

test('v2 pending review with completed tasks rebuilds fresh validation after one clean outcome', () => {
  const cwd = repo();
  const { source, serialized, migrated, backupPath } = migrateCompletedTaskPendingReview(cwd);
  assert.equal(readFileSync(backupPath, 'utf8'), serialized);
  assert.equal(source.phase, 'awaiting-review');
  assert.ok(source.tasks.length > 0);
  assert.ok(source.tasks.every((item) => item.status === 'completed'));
  assert.equal(source.validationStatus.status, 'passed');
  assert.equal(migrated.phase, 'awaiting-review');
  assert.equal(migrated.validationStatus.status, 'not-run');
  assert.equal(migrated.ciValidationStatus.status, 'not-run');
  assert.deepEqual(migrated.reviewRequest, source.reviewRequest);
  assert.deepEqual(migrated.reviewHistory, source.reviewHistory);
  assert.deepEqual(migrated.tasks, source.tasks);
  const { localVerification: _localVerification, ...legacyThreadResolutionStatus } = source.threadResolutionStatus;
  assert.deepEqual(migrated.threadResolutionStatus, legacyThreadResolutionStatus);

  const collected = checkpointReviewOutcome({
    cwd, outcome: outcome(migrated), expectedRevision: migrated.revision,
  });
  const preserved = {
    tasks: structuredClone(collected.tasks),
    reviewRequest: structuredClone(collected.reviewRequest),
    reviewOutcome: structuredClone(collected.reviewOutcome),
    reviewHistory: structuredClone(collected.reviewHistory),
    threadResolutionStatus: structuredClone(collected.threadResolutionStatus),
  };
  assert.equal(collected.phase, 'validating');
  assert.equal(collected.reviewOutcome.outcome, 'clean');
  assert.equal(collected.reviewHistory.length, 1);

  const plan = buildTargetedValidationPlan({
    cwd, initialSelection: initialSelection(collected.currentIntegrationHeadSha), now: () => AT,
  });
  assert.deepEqual(plan.taskIds, []);
  assert.equal(plan.stateRevision, collected.revision);
  assert.equal(plan.headSha, collected.currentIntegrationHeadSha);
  const result = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  });
  assert.equal(result.state.phase, 'validating');
  assert.equal(result.state.validationStatus.status, 'passed');
  assert.equal(result.state.validationStatus.headSha, collected.currentIntegrationHeadSha);
  assert.deepEqual(result.state.validationStatus.checks, ['npm run check:workflow']);
  assert.deepEqual({
    tasks: result.state.tasks,
    reviewRequest: result.state.reviewRequest,
    reviewOutcome: result.state.reviewOutcome,
    reviewHistory: result.state.reviewHistory,
    threadResolutionStatus: result.state.threadResolutionStatus,
  }, preserved);
});

test('v2 pending completed-task recovery requires exact one-outcome backup provenance', () => {
  function collectedCycle() {
    const cwd = repo();
    const setup = migrateCompletedTaskPendingReview(cwd);
    const collected = checkpointReviewOutcome({
      cwd, outcome: outcome(setup.migrated), expectedRevision: setup.migrated.revision,
    });
    return { cwd, ...setup, collected };
  }
  function expectRejected(setup) {
    assert.throws(() => buildTargetedValidationPlan({
      cwd: setup.cwd, initialSelection: initialSelection(setup.collected.currentIntegrationHeadSha),
    }), StateError);
  }

  const missing = collectedCycle();
  rmSync(missing.backupPath);
  expectRejected(missing);

  const corrupt = collectedCycle();
  writeFileSync(corrupt.backupPath, '{}\n');
  expectRejected(corrupt);

  const tamperedBackup = collectedCycle();
  writeFileSync(tamperedBackup.backupPath, `${JSON.stringify({
    ...tamperedBackup.legacy,
    tasks: tamperedBackup.legacy.tasks.map((item) => ({ ...item, summary: 'Tampered summary.' })),
  })}\n`);
  expectRejected(tamperedBackup);

  const revisionDrift = collectedCycle();
  revisionDrift.collected = { ...revisionDrift.collected, revision: revisionDrift.collected.revision + 1 };
  writeFileSync(statePath(revisionDrift.cwd, 17), `${JSON.stringify(revisionDrift.collected)}\n`);
  expectRejected(revisionDrift);

  const blocked = collectedCycle();
  blocked.collected = { ...blocked.collected, blockedReasons: ['Operator decision is required.'] };
  writeFileSync(statePath(blocked.cwd, 17), `${JSON.stringify(blocked.collected)}\n`);
  expectRejected(blocked);

  const taskMismatch = collectedCycle();
  taskMismatch.collected = {
    ...taskMismatch.collected,
    tasks: taskMismatch.collected.tasks.map((item) => ({ ...item, summary: 'Unexpected active summary.' })),
  };
  writeFileSync(statePath(taskMismatch.cwd, 17), `${JSON.stringify(taskMismatch.collected)}\n`);
  expectRejected(taskMismatch);

  const extraProof = collectedCycle();
  extraProof.collected = {
    ...extraProof.collected,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed',
      headSha: extraProof.collected.currentIntegrationHeadSha,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  };
  writeFileSync(statePath(extraProof.cwd, 17), `${JSON.stringify(extraProof.collected)}\n`);
  expectRejected(extraProof);

  const dirty = collectedCycle();
  writeFileSync(join(dirty.cwd, 'dirty.txt'), 'dirty\n');
  assert.throws(() => buildTargetedValidationPlan({
    cwd: dirty.cwd, initialSelection: initialSelection(dirty.collected.currentIntegrationHeadSha),
  }), { code: 'VALIDATION_CHECKOUT_DIRTY' });

  const findingsCwd = repo();
  const findingsSetup = migrateCompletedTaskPendingReview(findingsCwd);
  const findings = checkpointReviewOutcome({
    cwd: findingsCwd, outcome: outcome(findingsSetup.migrated, { outcome: 'findings' }),
    expectedRevision: findingsSetup.migrated.revision,
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: findingsCwd, initialSelection: initialSelection(findings.currentIntegrationHeadSha),
  }), { code: 'VALIDATION_PLAN_PHASE_BLOCKED' });
});

test('migrated taskless clean review rebuilds and runs exact-head targeted validation without repeating review', () => {
  const cwd = repo();
  const migrated = migrateTasklessPendingReview(cwd);
  const collected = checkpointReviewOutcome({
    cwd, outcome: outcome(migrated), expectedRevision: migrated.revision,
  });
  const reviewEvidence = {
    reviewRequest: structuredClone(collected.reviewRequest),
    reviewOutcome: structuredClone(collected.reviewOutcome),
    reviewHistory: structuredClone(collected.reviewHistory),
  };
  const selection = initialSelection(collected.currentIntegrationHeadSha, {
    affectedAreas: ['workflow', 'documentation'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Rebuild discarded schema-v2 validation proof.' }],
      system: [],
    },
  });

  const plan = buildTargetedValidationPlan({ cwd, initialSelection: selection, now: () => AT });
  assert.deepEqual(plan.taskIds, []);
  assert.deepEqual(plan.affectedAreas, ['documentation', 'workflow']);
  assert.equal(plan.stateRevision, collected.revision);
  assert.equal(plan.headSha, collected.currentIntegrationHeadSha);
  assert.deepEqual(plan.commands.map(({ command, reason }) => ({ command, reason })), [{
    command: 'npm run check:workflow', reason: 'Rebuild discarded schema-v2 validation proof.',
  }]);

  const result = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  });
  assert.equal(result.state.phase, 'validating');
  assert.equal(result.state.validationStatus.status, 'passed');
  assert.equal(result.state.validationStatus.headSha, collected.currentIntegrationHeadSha);
  assert.deepEqual({
    reviewRequest: result.state.reviewRequest,
    reviewOutcome: result.state.reviewOutcome,
    reviewHistory: result.state.reviewHistory,
  }, reviewEvidence);
});

test('taskless post-review validation recovery rejects pending, findings, tasks, dirty state, and inconsistent proof', () => {
  const pendingCwd = repo();
  const pending = migrateTasklessPendingReview(pendingCwd);
  assert.throws(() => buildTargetedValidationPlan({
    cwd: pendingCwd, initialSelection: initialSelection(pending.currentIntegrationHeadSha),
  }), { code: 'VALIDATION_PLAN_PHASE_BLOCKED' });

  const findingsCwd = repo();
  const findingsMigrated = migrateTasklessPendingReview(findingsCwd);
  const findings = checkpointReviewOutcome({
    cwd: findingsCwd,
    outcome: outcome(findingsMigrated, { outcome: 'findings' }),
    expectedRevision: findingsMigrated.revision,
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: findingsCwd, initialSelection: initialSelection(findings.currentIntegrationHeadSha),
  }), { code: 'VALIDATION_PLAN_PHASE_BLOCKED' });

  const taskCwd = repo();
  const taskMigrated = migrateTasklessPendingReview(taskCwd);
  const taskCollected = checkpointReviewOutcome({
    cwd: taskCwd, outcome: outcome(taskMigrated), expectedRevision: taskMigrated.revision,
  });
  const withTask = checkpointState({
    cwd: taskCwd, expectedRevision: taskCollected.revision,
    nextState: {
      ...taskCollected,
      tasks: [task(taskCollected.currentIntegrationHeadSha, {
        id: 'unexpected-task', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: taskCwd, initialSelection: initialSelection(withTask.currentIntegrationHeadSha),
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });

  const dirtyCwd = repo();
  const dirtyMigrated = migrateTasklessPendingReview(dirtyCwd);
  const dirtyCollected = checkpointReviewOutcome({
    cwd: dirtyCwd, outcome: outcome(dirtyMigrated), expectedRevision: dirtyMigrated.revision,
  });
  writeFileSync(join(dirtyCwd, 'dirty.txt'), 'dirty\n');
  assert.throws(() => buildTargetedValidationPlan({
    cwd: dirtyCwd, initialSelection: initialSelection(dirtyCollected.currentIntegrationHeadSha),
  }), { code: 'VALIDATION_CHECKOUT_DIRTY' });

  const ordinaryCwd = repo();
  const ordinaryInitial = init(ordinaryCwd);
  const ordinaryProofed = checkpointTaskCompletion({
    cwd: ordinaryCwd,
    expectedRevision: ordinaryInitial.revision,
    threadResolutionStatus: ready(ordinaryInitial, []).threadResolutionStatus,
  });
  const ordinaryReady = persistReady(ordinaryCwd, ordinaryProofed, []);
  const ordinaryRequested = checkpointReviewRequest({
    cwd: ordinaryCwd,
    request: request(ordinaryReady),
    pushedHeadSha: ordinaryReady.currentIntegrationHeadSha,
    prHeadSha: ordinaryReady.currentIntegrationHeadSha,
    expectedRevision: ordinaryReady.revision,
  });
  const ordinaryCollected = checkpointReviewOutcome({
    cwd: ordinaryCwd, outcome: outcome(ordinaryRequested), expectedRevision: ordinaryRequested.revision,
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: ordinaryCwd,
    initialSelection: initialSelection(ordinaryCollected.currentIntegrationHeadSha),
    replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
  assert.equal(loadState(ordinaryCwd).validationStatus.status, 'passed');

  const inconsistentCwd = repo();
  const inconsistentMigrated = migrateTasklessPendingReview(inconsistentCwd);
  const inconsistent = checkpointReviewOutcome({
    cwd: inconsistentCwd, outcome: outcome(inconsistentMigrated), expectedRevision: inconsistentMigrated.revision,
  });
  writeFileSync(statePath(inconsistentCwd, inconsistent.prNumber), `${JSON.stringify({
    ...inconsistent,
    reviewHistory: inconsistent.reviewHistory.map((entry, index) => index === inconsistent.reviewHistory.length - 1
      ? { ...entry, outcome: { ...entry.outcome, id: 'inconsistent-outcome' } }
      : entry),
  })}\n`);
  assert.throws(() => buildTargetedValidationPlan({
    cwd: inconsistentCwd, initialSelection: initialSelection(inconsistent.currentIntegrationHeadSha),
  }), StateError);
});

test('native taskless clean-review HEAD drift rebuilds only current targeted validation', () => {
  const cwd = repo();
  const { reviewed } = nativeTasklessReview(cwd);
  const priorHeadSha = reviewed.currentIntegrationHeadSha;
  const preserved = {
    reviewRequest: structuredClone(reviewed.reviewRequest),
    reviewOutcome: structuredClone(reviewed.reviewOutcome),
    reviewHistory: structuredClone(reviewed.reviewHistory),
    threadlessVerification: structuredClone(reviewed.threadResolutionStatus.threadlessVerification),
  };

  const currentHeadSha = commit(cwd, { 'taskless-head-drift.txt': 'current HEAD\n' }, 'taskless review HEAD drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.notEqual(currentHeadSha, priorHeadSha);
  assert.equal(drifted.phase, 'recovering');
  assert.equal(drifted.currentIntegrationHeadSha, currentHeadSha);
  assert.equal(drifted.validationStatus.status, 'not-run');
  assert.equal(drifted.threadResolutionStatus.status, 'not-run');
  assert.equal(drifted.requestedHeadSha, priorHeadSha);
  assert.equal(drifted.reviewedHeadSha, priorHeadSha);
  assert.deepEqual({
    reviewRequest: drifted.reviewRequest,
    reviewOutcome: drifted.reviewOutcome,
    reviewHistory: drifted.reviewHistory,
    threadlessVerification: drifted.threadResolutionStatus.threadlessVerification,
  }, preserved);

  const selection = initialSelection(currentHeadSha, {
    affectedAreas: ['workflow', 'documentation'],
    requiredValidation: {
      unit: [{
        command: 'npm run check:workflow',
        reason: 'Rebuild native taskless validation after the clean Review commit drifted.',
      }],
      system: [],
    },
  });
  const plan = buildTargetedValidationPlan({
    cwd, initialSelection: selection, replace: true, now: () => AT,
  });
  assert.equal(plan.headSha, currentHeadSha);
  assert.equal(plan.stateRevision, drifted.revision);
  assert.deepEqual(plan.taskIds, []);
  assert.deepEqual(plan.affectedAreas, ['documentation', 'workflow']);

  const result = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  });
  assert.equal(result.state.phase, 'recovering');
  assert.equal(result.state.validationStatus.status, 'passed');
  assert.equal(result.state.validationStatus.headSha, currentHeadSha);
  assert.deepEqual(result.state.validationStatus.checks, ['npm run check:workflow']);
  assert.deepEqual({
    reviewRequest: result.state.reviewRequest,
    reviewOutcome: result.state.reviewOutcome,
    reviewHistory: result.state.reviewHistory,
    threadlessVerification: result.state.threadResolutionStatus.threadlessVerification,
  }, preserved);

  assert.throws(() => buildTargetedValidationPlan({
    cwd, initialSelection: selection, replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
});

test('native taskless pending-review HEAD drift rebuilds current validation without rewriting history', () => {
  const cwd = repo();
  const { requested } = nativeTasklessPendingVerification(cwd, { reviewRequestLimit: 4 });
  const priorHeadSha = requested.currentIntegrationHeadSha;
  const preserved = {
    reviewRequest: structuredClone(requested.reviewRequest),
    reviewOutcome: requested.reviewOutcome,
    reviewHistory: structuredClone(requested.reviewHistory),
    threadlessVerification: structuredClone(requested.threadResolutionStatus.threadlessVerification),
  };
  assert.deepEqual(reviewRequestUsage(requested), {
    used: 4, limit: 4, remaining: 0, exhausted: true,
  });
  assert.equal(requested.reviewRequest.kind, 'verification');
  assert.equal(requested.reviewHistory.at(-1).outcome, null);

  const currentHeadSha = commit(cwd, {
    'pending-review-head-drift.txt': 'current HEAD\n',
  }, 'pending review HEAD drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.notEqual(currentHeadSha, priorHeadSha);
  assert.equal(drifted.phase, 'recovering');
  assert.equal(drifted.validationStatus.status, 'not-run');
  assert.deepEqual({
    reviewRequest: drifted.reviewRequest,
    reviewOutcome: drifted.reviewOutcome,
    reviewHistory: drifted.reviewHistory,
    threadlessVerification: drifted.threadResolutionStatus.threadlessVerification,
  }, preserved);

  const selection = initialSelection(currentHeadSha, {
    affectedAreas: ['workflow', 'documentation'],
    requiredValidation: {
      unit: [{
        command: 'npm run check:workflow',
        reason: 'Rebuild taskless validation after the pending Review commit drifted.',
      }],
      system: [],
    },
  });
  const plan = buildTargetedValidationPlan({
    cwd, initialSelection: selection, replace: true, now: () => AT,
  });
  assert.equal(plan.headSha, currentHeadSha);
  assert.deepEqual(plan.taskIds, []);

  const result = executeTargetedValidationPlan({
    cwd, runCommand: () => ({ status: 0 }), now: () => AT,
  });
  assert.equal(result.state.phase, 'recovering');
  assert.equal(result.state.validationStatus.status, 'passed');
  assert.equal(result.state.validationStatus.headSha, currentHeadSha);
  assert.deepEqual(reviewRequestUsage(result.state), {
    used: 4, limit: 4, remaining: 0, exhausted: true,
  });
  assert.deepEqual({
    reviewRequest: result.state.reviewRequest,
    reviewOutcome: result.state.reviewOutcome,
    reviewHistory: result.state.reviewHistory,
    threadlessVerification: result.state.threadResolutionStatus.threadlessVerification,
  }, preserved);

  const readyForReplacement = checkpointTaskCompletion({
    cwd,
    expectedRevision: result.state.revision,
    threadResolutionStatus: {
      ...result.state.threadResolutionStatus,
      status: 'passed',
      headSha: currentHeadSha,
      threads: [],
      updatedAt: AT,
    },
  });
  assert.equal(readyForReplacement.phase, 'ready-for-review');
  assert.match(
    readyForReplacement.nextAction,
    new RegExp(`Review request limit 4 is exhausted after 4 durable requests; run npm run review:state -- set-review-limit --pr 17 --expected-revision ${readyForReplacement.revision} --limit <higher-number> or --unlimited before the next request\\.`),
  );
  assert.deepEqual({
    reviewRequest: readyForReplacement.reviewRequest,
    reviewOutcome: readyForReplacement.reviewOutcome,
    reviewHistory: readyForReplacement.reviewHistory,
  }, {
    reviewRequest: preserved.reviewRequest,
    reviewOutcome: preserved.reviewOutcome,
    reviewHistory: preserved.reviewHistory,
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd, initialSelection: selection, replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
});

test('native taskless review HEAD-drift validation recovery fails closed at every lifecycle boundary', () => {
  const wrongHeadCwd = repo();
  const wrongHeadReview = nativeTasklessReview(wrongHeadCwd).reviewed;
  commit(wrongHeadCwd, { 'wrong-selection-head.txt': 'drift\n' }, 'wrong selection drift');
  const wrongHeadDrift = checkpointGitMetadata({ cwd: wrongHeadCwd }).state;
  assert.throws(() => buildTargetedValidationPlan({
    cwd: wrongHeadCwd,
    initialSelection: initialSelection(wrongHeadReview.currentIntegrationHeadSha),
    replace: true,
  }), { code: 'VALIDATION_PLAN_STALE' });

  const dirtyCwd = repo();
  nativeTasklessReview(dirtyCwd);
  const dirtyHead = commit(dirtyCwd, { 'dirty-recovery-head.txt': 'drift\n' }, 'dirty recovery drift');
  const dirtyDrift = checkpointGitMetadata({ cwd: dirtyCwd }).state;
  writeFileSync(join(dirtyCwd, 'dirty-recovery.txt'), 'dirty\n');
  assert.throws(() => buildTargetedValidationPlan({
    cwd: dirtyCwd, initialSelection: initialSelection(dirtyHead), replace: true,
  }), { code: 'VALIDATION_CHECKOUT_DIRTY' });
  assert.equal(dirtyDrift.validationStatus.status, 'not-run');

  const sameHeadPendingCwd = repo();
  const sameHeadPending = nativeTasklessReview(sameHeadPendingCwd, { collectOutcome: false }).requested;
  assert.throws(() => buildTargetedValidationPlan({
    cwd: sameHeadPendingCwd,
    initialSelection: initialSelection(sameHeadPending.currentIntegrationHeadSha),
    replace: true,
  }), { code: 'VALIDATION_PLAN_PHASE_BLOCKED' });

  for (const [name, mutate] of [
    ['reviewed HEAD', (state, priorHeadSha) => ({ ...state, reviewedHeadSha: priorHeadSha })],
    ['legacy provenance', (state) => ({
      ...state,
      legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 0, migratedAt: AT },
    })],
  ]) {
    const cwd = repo();
    const pending = nativeTasklessPendingVerification(cwd).requested;
    const priorHeadSha = pending.currentIntegrationHeadSha;
    const headSha = commit(cwd, { [`malformed-${name}.txt`]: 'drift\n' }, `malformed ${name}`);
    const drifted = checkpointGitMetadata({ cwd }).state;
    writeFileSync(statePath(cwd, drifted.prNumber), `${JSON.stringify(mutate(drifted, priorHeadSha))}\n`);
    assert.throws(() => buildTargetedValidationPlan({
      cwd, initialSelection: initialSelection(headSha), replace: true,
    }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' }, name);
  }

  const findingsCwd = repo();
  nativeTasklessReview(findingsCwd, { outcomeOverrides: { outcome: 'findings' } });
  const findingsHead = commit(findingsCwd, { 'findings-review-drift.txt': 'drift\n' }, 'findings review drift');
  const findingsDrift = checkpointGitMetadata({ cwd: findingsCwd }).state;
  assert.equal(findingsDrift.phase, 'recovering');
  assert.throws(() => buildTargetedValidationPlan({
    cwd: findingsCwd, initialSelection: initialSelection(findingsHead), replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });

  const taskCwd = repo();
  nativeTasklessReview(taskCwd);
  const taskHead = commit(taskCwd, { 'task-bearing-drift.txt': 'drift\n' }, 'task-bearing drift');
  const taskDrift = checkpointGitMetadata({ cwd: taskCwd }).state;
  const taskBearing = checkpointState({
    cwd: taskCwd,
    expectedRevision: taskDrift.revision,
    nextState: {
      ...taskDrift,
      tasks: [task(taskHead, {
        id: 'unexpected-recovery-task', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: taskCwd, initialSelection: initialSelection(taskHead), replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
  assert.equal(taskBearing.tasks.length, 1);

  const blockedCwd = repo();
  nativeTasklessReview(blockedCwd);
  const blockedHead = commit(blockedCwd, { 'blocked-drift.txt': 'drift\n' }, 'blocked drift');
  const blockedDrift = checkpointGitMetadata({ cwd: blockedCwd }).state;
  checkpointState({
    cwd: blockedCwd,
    expectedRevision: blockedDrift.revision,
    nextState: { ...blockedDrift, blockedReasons: ['Operator decision remains.'] },
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: blockedCwd, initialSelection: initialSelection(blockedHead), replace: true,
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });

  const inconsistentCwd = repo();
  nativeTasklessReview(inconsistentCwd);
  const inconsistentHead = commit(inconsistentCwd, { 'inconsistent-drift.txt': 'drift\n' }, 'inconsistent drift');
  const inconsistent = checkpointGitMetadata({ cwd: inconsistentCwd }).state;
  writeFileSync(statePath(inconsistentCwd, inconsistent.prNumber), `${JSON.stringify({
    ...inconsistent,
    reviewHistory: inconsistent.reviewHistory.map((entry, index) => (
      index === inconsistent.reviewHistory.length - 1
        ? { ...entry, outcome: { ...entry.outcome, id: 'different-latest-outcome' } }
        : entry
    )),
  })}\n`);
  assert.throws(() => buildTargetedValidationPlan({
    cwd: inconsistentCwd, initialSelection: initialSelection(inconsistentHead), replace: true,
  }), StateError);

  const exhaustedCwd = repo();
  let exhausted = nativeTasklessReview(exhaustedCwd).reviewed;
  for (let round = 1; round < 4; round += 1) {
    const prepared = checkpointState({
      cwd: exhaustedCwd,
      expectedRevision: exhausted.revision,
      nextState: ready(exhausted, []),
    });
    const requested = checkpointReviewRequest({
      cwd: exhaustedCwd,
      request: request(prepared),
      pushedHeadSha: prepared.currentIntegrationHeadSha,
      prHeadSha: prepared.currentIntegrationHeadSha,
      expectedRevision: prepared.revision,
    });
    exhausted = checkpointReviewOutcome({
      cwd: exhaustedCwd, outcome: outcome(requested), expectedRevision: requested.revision,
    });
  }
  assert.equal(exhausted.reviewRound, 3);
  assert.equal(exhausted.verificationReviewUsed, true);
  const exhaustedHead = commit(exhaustedCwd, { 'exhausted-drift.txt': 'drift\n' }, 'exhausted review drift');
  const exhaustedDrift = checkpointGitMetadata({ cwd: exhaustedCwd }).state;
  assert.equal(exhaustedDrift.phase, 'recovering');
  const unlimitedRecovery = buildTargetedValidationPlan({
    cwd: exhaustedCwd, initialSelection: initialSelection(exhaustedHead), replace: true,
  });
  assert.equal(unlimitedRecovery.headSha, exhaustedHead);
});

test('v2 completed-task cycles rebuild fresh exact-head validation from immutable migration proof', () => {
  for (const phase of ['ready-for-review', 'complete']) {
    const cwd = repo();
    const { source, migrated } = migrateCompletedTaskCycle(cwd, phase);
    const preserved = {
      tasks: structuredClone(migrated.tasks),
      reviewRequest: structuredClone(migrated.reviewRequest),
      reviewOutcome: structuredClone(migrated.reviewOutcome),
      reviewHistory: structuredClone(migrated.reviewHistory),
      threadResolutionStatus: structuredClone(migrated.threadResolutionStatus),
    };
    assert.equal(migrated.phase, 'recovering');
    assert.equal(migrated.validationStatus.status, 'not-run');
    assert.equal(source.validationStatus.status, 'passed');
    const plan = buildTargetedValidationPlan({
      cwd, initialSelection: initialSelection(migrated.currentIntegrationHeadSha), now: () => AT,
    });
    assert.deepEqual(plan.taskIds, []);
    const result = executeTargetedValidationPlan({
      cwd, runCommand: () => ({ status: 0 }), now: () => AT,
    });
    assert.equal(result.state.validationStatus.status, 'passed');
    assert.equal(result.state.validationStatus.headSha, migrated.currentIntegrationHeadSha);
    assert.deepEqual({
      tasks: result.state.tasks,
      reviewRequest: result.state.reviewRequest,
      reviewOutcome: result.state.reviewOutcome,
      reviewHistory: result.state.reviewHistory,
      threadResolutionStatus: result.state.threadResolutionStatus,
    }, preserved);
  }
});

test('v2 completed-task validation recovery fails closed without exact immutable provenance', () => {
  for (const mutate of [
    (cwd) => rmSync(join(stateDirectory(cwd, 17), 'state.v2.backup.json')),
    (cwd) => writeFileSync(join(stateDirectory(cwd, 17), 'state.v2.backup.json'), '{}\n'),
    (_cwd, state) => writeFileSync(statePath(_cwd, 17), `${JSON.stringify({ ...state, blockedReasons: ['blocked'] })}\n`),
  ]) {
    const cwd = repo();
    const { migrated } = migrateCompletedTaskCycle(cwd, 'ready-for-review');
    mutate(cwd, migrated);
    assert.throws(() => buildTargetedValidationPlan({
      cwd, initialSelection: initialSelection(migrated.currentIntegrationHeadSha),
    }), StateError);
  }

  const nativeCwd = repo();
  const native = { ...ready(init(nativeCwd)), phase: 'recovering', validationStatus: {
    source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null,
  } };
  writeFileSync(statePath(nativeCwd, native.prNumber), `${JSON.stringify(native)}\n`);
  assert.throws(() => buildTargetedValidationPlan({
    cwd: nativeCwd, initialSelection: initialSelection(native.currentIntegrationHeadSha),
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
});

test('migration keeps worker and central cherry-pick SHAs distinct and preserves three-round provenance', () => {
  const cwd = repo();
  const initial = init(cwd);
  git(cwd, ['branch', 'worker']);
  git(cwd, ['switch', 'worker']);
  const workerSha = commit(cwd, { 'worker.txt': 'fix\n' }, 'worker fix');
  git(cwd, ['switch', 'main']);
  commit(cwd, { 'integration.txt': 'integration advance\n' }, 'integration advance');
  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  assert.notEqual(workerSha, centralSha);
  const legacy = legacyState(initial, {
    phase: 'complete', reviewRound: 3, currentIntegrationHeadSha: centralSha,
    git: { ...initial.git, headSha: centralSha }, tasks: [legacyTask(workerSha)],
  });
  const migrated = migratePrReviewStateV1(legacy, {
    migratedAt: AT,
    integrationMap: { 'legacy-task': centralSha },
    isAncestor: (ancestor, descendant) => {
      try { git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; } catch { return false; }
    },
  });
  assert.equal(migrated.tasks[0].status, 'integrated');
  assert.equal(migrated.tasks[0].integratedCommitSha, centralSha);
  assert.ok(!('execution' in migrated.tasks[0]));
  assert.equal(migrated.reviewRound, 3);
  assert.deepEqual(migrated.legacyReviewProvenance, { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT });
  assert.equal(migrated.verificationReviewUsed, false);
});

test('migration without reconciliation never promotes a legacy worker SHA or completed status', () => {
  const cwd = repo();
  const state = init(cwd);
  const workerSha = git(cwd, ['rev-parse', 'HEAD']);
  const migrated = migratePrReviewStateV1(legacyState(state, {
    phase: 'complete', tasks: [legacyTask(workerSha, { status: 'completed' })],
  }), { migratedAt: AT });
  assert.equal(migrated.tasks[0].status, 'implemented');
  assert.equal(migrated.tasks[0].integratedCommitSha, null);
  assert.equal(migrated.tasks[0].execution.workerCommitSha, workerSha);
  assert.deepEqual(migrated.tasks[0].sourceIds, ['review:9', 'discussion:99']);
  assert.deepEqual(migrated.tasks[0].execution.dependencies, ['earlier']);
});

test('migration rejects invalid, unknown, inapplicable, and non-ancestor reconciliation entries', () => {
  const cwd = repo();
  const state = init(cwd);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  const legacy = legacyState(state, { tasks: [legacyTask(sha)] });
  for (const integrationMap of [{ unknown: sha }, { 'legacy-task': 'bad' }]) {
    assert.throws(() => migratePrReviewStateV1(legacy, { integrationMap }), { code: 'INVALID_INTEGRATION_MAP' });
  }
  assert.throws(
    () => migratePrReviewStateV1(legacy, { integrationMap: { 'legacy-task': sha }, isAncestor: () => false }),
    { code: 'INVALID_INTEGRATION_MAP' },
  );
  assert.throws(
    () => migratePrReviewStateV1(legacy, { integrationMap: { 'legacy-task': sha } }),
    { code: 'INVALID_INTEGRATION_MAP' },
  );
  const running = legacyState(state, { tasks: [legacyTask(sha, { status: 'running' })] });
  assert.throws(() => migratePrReviewStateV1(running, { integrationMap: { 'legacy-task': sha } }), { code: 'INVALID_INTEGRATION_MAP' });
});

test('migration downgrades weak exact-head proof and is total over duplicate legacy lists', () => {
  const cwd = repo();
  const state = init(cwd);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  const legacy = legacyState(state, {
    blockedReasons: ['same', 'same'],
    validationStatus: { status: 'passed', headSha: null, checks: [], updatedAt: null },
    tasks: [legacyTask(sha, { status: 'running' })],
  });
  const migrated = migratePrReviewStateV1(legacy, { migratedAt: AT });
  assert.deepEqual(migrated.blockedReasons, ['same']);
  assert.deepEqual(migrated.validationStatus, {
    source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null,
  });
});

test('explicit migration uses immutable exact backup and handles a near-limit v1 document', () => {
  const cwd = repo();
  const state = init(cwd);
  const workerSha = git(cwd, ['rev-parse', 'HEAD']);
  const currentTaskIds = [
    'r1-capability-limit-key', 'r1-guest-me-error', 'r1-guest-add-pending',
    'v1-guest-add-error-ownership', 'v1-guest-identity-outage-test', 'r2-bill-item-immutability',
    'r2-host-me-error', 'r2-bill-detail-query-state', 'r2-bill-search-ranking',
    'r2-order-stepper-touch-target', 'r2-pass3-regression-coverage', 'v2-host-identity-retry-count',
    'v2-bill-item-truncate-guard', 'r3-settlement-undo-wall-clock', 'r3-access-status-ip-scope',
    'v3-limiter-readiness-probe-isolation', 'r3-financial-record-immutability',
  ];
  const integrationMap = {};
  for (const [index, id] of currentTaskIds.entries()) {
    integrationMap[id] = commit(cwd, { [`integrated-${index}.txt`]: `${id}\n` }, `integrate ${id}`);
  }
  const integrationHead = git(cwd, ['rev-parse', 'HEAD']);
  const tasks = currentTaskIds.map((id, index) => legacyTask(workerSha, {
    id, fingerprint: `legacy-fingerprint-${index}`,
    sourceIds: [`review:${index}`, `discussion:${Math.min(index, 11) + 1}`],
    dependencies: [], ownedPaths: [`src/fix-${index}.ts`],
  }));
  const legacy = legacyState(state, {
    decisions: Array.from({ length: 12 }, (_, decisionIndex) => ({
      id: `decision-${decisionIndex}`,
      summary: `Durable decision ${decisionIndex}: ${'d'.repeat(700)}`,
    })),
    reviewRound: 3, phase: 'complete', tasks,
    currentIntegrationHeadSha: integrationHead, git: { ...state.git, headSha: integrationHead },
  });
  let index = 0;
  const serializedLegacy = () => `${JSON.stringify(legacy, null, 2)}\n`;
  while (Buffer.byteLength(JSON.stringify(legacy.tasks)) < 11_000
      || Buffer.byteLength(serializedLegacy()) < 28_400) {
    const selected = legacy.tasks[index % legacy.tasks.length];
    selected.validationSummaries.push(`Historical worker check ${index}: ${'x'.repeat(260)}`);
    index += 1;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(legacy.decisions)) >= 8_500);
  assert.ok(Buffer.byteLength(JSON.stringify(legacy.tasks)) >= 11_000);
  const legacySource = serializedLegacy();
  assert.ok(Buffer.byteLength(legacySource) >= 28_400);
  assert.ok(Buffer.byteLength(legacySource) < ACTIVE_STATE_LIMIT_BYTES);
  writeFileSync(statePath(cwd, 17), legacySource);
  const result = migrateState({ cwd, integrationMap });
  assert.equal(result.backupPath, join(stateDirectory(cwd, 17), 'state.v1.backup.json'));
  assert.deepEqual(JSON.parse(readFileSync(result.backupPath, 'utf8')), legacy);
  assert.equal(readFileSync(result.backupPath, 'utf8'), legacySource);
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);
  assert.equal(result.state.tasks.length, 17);
  assert.ok(result.state.tasks.every((item) => item.status === 'integrated'));
  assert.equal(result.state.reviewRound, 3);
  const threadGroups = Array.from({ length: 12 }, (_, threadIndex) => (
    threadIndex < 11 ? [currentTaskIds[threadIndex]] : currentTaskIds.slice(11)
  ));
  const proof = {
    status: 'passed', headSha: integrationHead, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: threadGroups.map((taskIds, threadIndex) => ({
      threadNodeId: `PRRT_current_${threadIndex}`, rootCommentNodeId: `PRRC_current_${threadIndex}`,
      rootCommentDatabaseId: threadIndex + 1, taskIds,
      disposition: 'fixed', replyId: `PRRC_reply_${threadIndex}`,
      replyUrl: `https://github.com/example/aerstello/pull/17#discussion_r${threadIndex}`,
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: integrationHead,
    })),
  };
  const validated = checkpointSyntheticTargetedValidation(cwd, result.state);
  const completed = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proof, expectedRevision: validated.revision,
  });
  const preparedBase = ready(completed, completed.tasks);
  const prepared = checkpointState({
    cwd, nextState: { ...preparedBase, threadResolutionStatus: completed.threadResolutionStatus },
    expectedRevision: completed.revision,
  });
  const requested = checkpointReviewRequest({
    cwd, request: request(prepared, 'verification-size', 'verification'),
    pushedHeadSha: integrationHead, prHeadSha: integrationHead, expectedRevision: prepared.revision,
  });
  const collected = checkpointReviewOutcome({ cwd, expectedRevision: requested.revision, outcome: outcome(requested, {
    evidenceType: 'request-reaction',
    url: requested.reviewRequest.url,
    reactionContent: 'THUMBS_UP',
    reactionCommentId: requested.reviewRequest.id,
  }) });
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);

  writeFileSync(statePath(cwd, 17), legacySource);
  assert.equal(migrateState({ cwd, integrationMap }).state.schemaVersion, 3);
  writeFileSync(statePath(cwd, 17), JSON.stringify({ ...legacy, nextAction: 'different v1 state' }));
  assert.throws(() => migrateState({ cwd, integrationMap }), { code: 'MIGRATION_BACKUP_CONFLICT' });
});

test('explicit migration cannot hijack a different active pointer', () => {
  const cwd = repo();
  const state = init(cwd);
  mkdirSync(stateDirectory(cwd, 18), { recursive: true });
  writeFileSync(statePath(cwd, 18), JSON.stringify(legacyState({ ...state, prNumber: 18 })));
  assert.throws(() => migrateState({ cwd, prNumber: 18 }), { code: 'ACTIVE_POINTER_CONFLICT' });
});
