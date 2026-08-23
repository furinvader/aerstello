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

test('review request gate requires ready phase, fresh three-way heads, and real ancestry', () => {
  const cwd = repo();
  const state = ready(init(cwd));
  assert.equal(reviewRequestGate(state, external(cwd, state)).allowed, true);
  assert.equal(reviewRequestGate({ ...state, phase: 'validating' }, external(cwd, state)).allowed, false);
  assert.equal(reviewRequestGate(state, external(cwd, state, { prHeadSha: 'f'.repeat(40) })).allowed, false);
  assert.equal(reviewRequestGate(state, { ...external(cwd, state), isAncestor: () => false }).allowed, false);
  writeFileSync(join(cwd, 'dirty-request.txt'), 'dirty\n');
  assert.equal(reviewRequestGate(state, external(cwd, state)).allowed, false);
  rmSync(join(cwd, 'dirty-request.txt'));
});

test('review and Done gates require exact-current-HEAD coverage for every completed local task', () => {
  const cwd = repo();
  const prepared = ready(init(cwd));
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  const reviewed = buildReviewOutcomeTransition(requested, outcome(requested));
  const ciValidated = buildCiValidationTransition(reviewed, ciEvidence(reviewed));
  assert.equal(reviewRequestGate(prepared, external(cwd, prepared)).allowed, true);
  assert.equal(completionGate(ciValidated, external(cwd, ciValidated)).allowed, true);

  const variants = [];
  const missing = structuredClone(prepared.threadResolutionStatus);
  delete missing.localVerification;
  variants.push(missing);
  variants.push({
    ...prepared.threadResolutionStatus,
    localVerification: { ...prepared.threadResolutionStatus.localVerification, status: 'failed' },
  });
  variants.push({
    ...prepared.threadResolutionStatus,
    localVerification: { ...prepared.threadResolutionStatus.localVerification, headSha: 'b'.repeat(40) },
  });
  variants.push({
    ...prepared.threadResolutionStatus,
    localVerification: { ...prepared.threadResolutionStatus.localVerification, taskIds: [] },
  });
  for (const threadResolutionStatus of variants) {
    const unready = { ...prepared, threadResolutionStatus };
    const notDone = { ...ciValidated, threadResolutionStatus };
    assert.equal(reviewRequestGate(unready, external(cwd, unready)).allowed, false);
    assert.equal(completionGate(notDone, external(cwd, notDone)).allowed, false);
  }
});

test('request and outcome builders are guarded and idempotent; completion is separate', () => {
  const cwd = repo();
  const prepared = ready(init(cwd));
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  assert.equal(requested.reviewRound, 1);
  assert.equal(requested.phase, 'awaiting-review');
  assert.equal(buildReviewRequestTransition(requested, requested.reviewRequest, external(cwd, prepared)), requested);
  assert.throws(
    () => buildReviewOutcomeTransition(requested, outcome(requested, { reviewerLogin: 'codex' })),
    { code: 'INVALID_REVIEW_OUTCOME' },
  );
  assert.throws(
    () => buildReviewOutcomeTransition(requested, outcome(requested, {
      evidenceType: 'request-reaction', reactionContent: 'HEART', reactionCommentId: requested.reviewRequest.id,
    })),
    { code: 'INVALID_REVIEW_OUTCOME' },
  );
  assert.throws(
    () => buildReviewOutcomeTransition(requested, outcome(requested, {
      evidenceType: 'request-reaction', reactionContent: 'THUMBS_UP', reactionCommentId: 'other-comment',
    })),
    { code: 'INVALID_REVIEW_OUTCOME' },
  );
  const collected = buildReviewOutcomeTransition(requested, outcome(requested));
  assert.equal(collected.phase, 'validating');
  assert.equal(buildReviewOutcomeTransition(collected, collected.reviewOutcome), collected);
  writeFileSync(join(cwd, 'dirty-completion.txt'), 'dirty\n');
  assert.throws(
    () => buildCompletionTransition(collected, external(cwd, collected)),
    { code: 'REVIEW_CYCLE_INCOMPLETE' },
  );
  rmSync(join(cwd, 'dirty-completion.txt'));
  assert.throws(
    () => buildCompletionTransition(collected, external(cwd, collected)),
    { code: 'REVIEW_CYCLE_INCOMPLETE' },
  );
  const ciValidated = buildCiValidationTransition(collected, ciEvidence(collected));
  const completed = buildCompletionTransition(ciValidated, external(cwd, ciValidated));
  assert.equal(completed.phase, 'complete');
});

test('generic checkpoint cannot bypass guarded request, outcome, or completion persistence', () => {
  const cwd = repo();
  const initial = init(cwd);
  assert.throws(
    () => checkpointState({ cwd, nextState: ready(initial, []), expectedRevision: 0 }),
    { code: 'IMMUTABLE_STATE_PROVENANCE' },
  );
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: 0, threadResolutionStatus: ready(initial).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const evidence = request(prepared);
  const builtRequest = buildReviewRequestTransition(prepared, evidence, external(cwd, prepared));
  assert.throws(
    () => checkpointState({ cwd, nextState: builtRequest, expectedRevision: prepared.revision }),
    { code: 'IMMUTABLE_STATE_PROVENANCE' },
  );
  const requested = checkpointReviewRequest({
    cwd, request: evidence, pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha, expectedRevision: prepared.revision,
  });
  const reviewOutcome = outcome(requested);
  assert.throws(
    () => checkpointState({
      cwd, nextState: buildReviewOutcomeTransition(requested, reviewOutcome), expectedRevision: requested.revision,
    }),
    { code: 'IMMUTABLE_STATE_PROVENANCE' },
  );
  const collected = checkpointReviewOutcome({
    cwd, outcome: reviewOutcome, expectedRevision: requested.revision,
  });
  const ciValidated = checkpointCiValidation({
    cwd, evidence: ciEvidence(collected), expectedRevision: collected.revision,
  });
  const builtComplete = buildCompletionTransition(ciValidated, external(cwd, ciValidated));
  assert.throws(
    () => checkpointState({ cwd, nextState: builtComplete, expectedRevision: ciValidated.revision }),
    { code: 'PROTECTED_TRANSITION_REQUIRED' },
  );
  const completed = checkpointCompletion({
    cwd, pushedHeadSha: ciValidated.currentIntegrationHeadSha, prHeadSha: ciValidated.currentIntegrationHeadSha,
    expectedRevision: ciValidated.revision,
  });
  assert.equal(completed.phase, 'complete');
});

test('revision-guarded review services reject omitted and stale revisions without persistence', () => {
  const cwd = repo();
  const snapshot = () => ({
    state: readFileSync(statePath(cwd, 17), 'utf8'),
    events: readFileSync(join(stateDirectory(cwd, 17), 'events.ndjson'), 'utf8'),
  });
  const rejectsWithoutPersistence = (invoke, revision) => {
    const before = snapshot();
    for (const expectedRevision of [undefined, revision + 1]) {
      assert.throws(() => invoke(expectedRevision), { code: 'STATE_REVISION_CONFLICT' });
      assert.deepEqual(snapshot(), before);
    }
  };

  const initial = init(cwd);
  rejectsWithoutPersistence((expectedRevision) => checkpointReviewRequestLimit({
    cwd, reviewRequestLimit: 4, expectedRevision,
  }), initial.revision);
  const limited = checkpointReviewRequestLimit({
    cwd, reviewRequestLimit: 4, expectedRevision: initial.revision,
  });
  assert.deepEqual(checkpointReviewRequestLimit({
    cwd, reviewRequestLimit: 4, expectedRevision: limited.revision,
  }), limited);
  rejectsWithoutPersistence((expectedRevision) => checkpointReviewRequestLimit({
    cwd, reviewRequestLimit: 4, expectedRevision,
  }), limited.revision);

  const prepared = ready(initial, []);
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(prepared)}\n`);
  const requested = checkpointReviewRequest({
    cwd,
    request: request(prepared),
    pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha,
    expectedRevision: prepared.revision,
  });
  const reviewEvidence = outcome(requested);
  rejectsWithoutPersistence((expectedRevision) => checkpointReviewOutcome({
    cwd, outcome: reviewEvidence, expectedRevision,
  }), requested.revision);
  const reviewed = checkpointReviewOutcome({
    cwd, outcome: reviewEvidence, expectedRevision: requested.revision,
  });
  assert.deepEqual(checkpointReviewOutcome({
    cwd, outcome: reviewEvidence, expectedRevision: reviewed.revision,
  }), reviewed);

  const ci = ciEvidence(reviewed);
  rejectsWithoutPersistence((expectedRevision) => checkpointCiValidation({
    cwd, evidence: ci, expectedRevision,
  }), reviewed.revision);
  const validated = checkpointCiValidation({
    cwd, evidence: ci, expectedRevision: reviewed.revision,
  });
  assert.deepEqual(checkpointCiValidation({
    cwd, evidence: ci, expectedRevision: validated.revision,
  }), validated);

  rejectsWithoutPersistence((expectedRevision) => checkpointCompletion({
    cwd,
    pushedHeadSha: validated.currentIntegrationHeadSha,
    prHeadSha: validated.currentIntegrationHeadSha,
    expectedRevision,
  }), validated.revision);
  const completed = checkpointCompletion({
    cwd,
    pushedHeadSha: validated.currentIntegrationHeadSha,
    prHeadSha: validated.currentIntegrationHeadSha,
    expectedRevision: validated.revision,
  });
  assert.deepEqual(checkpointCompletion({
    cwd,
    pushedHeadSha: completed.currentIntegrationHeadSha,
    prHeadSha: completed.currentIntegrationHeadSha,
    expectedRevision: completed.revision,
  }), completed);
  rejectsWithoutPersistence((expectedRevision) => checkpointCompletion({
    cwd,
    pushedHeadSha: completed.currentIntegrationHeadSha,
    prHeadSha: completed.currentIntegrationHeadSha,
    expectedRevision,
  }), completed.revision);
});

test('historically optional task-completion revisions remain optional', () => {
  const cwd = repo();
  const initial = init(cwd);
  const completed = checkpointTaskCompletion({
    cwd, threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  assert.equal(completed.revision, initial.revision + 1);
  assert.equal(completed.threadResolutionStatus.status, 'passed');
});

test('verification-escalation retries enforce revisions before idempotence', () => {
  const cwd = repo();
  const requested = nativeTasklessPendingVerification(cwd).requested;
  const escalation = {
    requestId: requested.reviewRequest.id,
    requestHeadSha: requested.reviewRequest.headSha,
    observedPrHeadSha: requested.reviewRequest.headSha,
    headRelation: 'same',
    evidenceIds: ['review:PRR_ambiguous', 'reaction:R_ambiguous'],
    reason: 'ambiguous-canonical-evidence',
    at: AT,
  };
  const escalated = checkpointVerificationEscalation({
    cwd, escalation, expectedRevision: requested.revision,
  });
  const stateBytes = readFileSync(statePath(cwd, 17), 'utf8');
  const eventBytes = readFileSync(join(stateDirectory(cwd, 17), 'events.ndjson'), 'utf8');

  for (const expectedRevision of [undefined, escalated.revision - 1]) {
    assert.throws(() => checkpointVerificationEscalation({
      cwd, escalation, expectedRevision,
    }), { code: 'STATE_REVISION_CONFLICT' });
    assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), stateBytes);
    assert.equal(readFileSync(join(stateDirectory(cwd, 17), 'events.ndjson'), 'utf8'), eventBytes);
  }
  assert.deepEqual(checkpointVerificationEscalation({
    cwd, escalation, expectedRevision: escalated.revision,
  }), escalated);
});

test('full CI evidence is guarded, restorable, append-only, exact-head, and invalidated by HEAD drift', () => {
  const cwd = repo();
  const initial = init(cwd);
  const forged = {
    ...initial,
    ciValidationStatus: ciEvidence(initial),
    ciValidationHistory: [ciEvidence(initial)],
  };
  assert.throws(
    () => checkpointState({ cwd, nextState: forged, expectedRevision: initial.revision }),
    { code: 'IMMUTABLE_STATE_PROVENANCE' },
  );
  assert.throws(
    () => checkpointCiValidation({
      cwd, evidence: ciEvidence(initial, { headSha: 'f'.repeat(40) }), expectedRevision: initial.revision,
    }),
    { code: 'INVALID_CI_VALIDATION' },
  );
  const passed = checkpointCiValidation({
    cwd, evidence: ciEvidence(initial), expectedRevision: initial.revision,
  });
  assert.deepEqual(passed.ciValidationHistory, [passed.ciValidationStatus]);
  assert.deepEqual(checkpointCiValidation({
    cwd, evidence: passed.ciValidationStatus, expectedRevision: passed.revision,
  }), passed);

  const currentEvidence = structuredClone(passed.ciValidationStatus);
  writeFileSync(join(cwd, 'dirty-ci-proof.txt'), 'dirty\n');
  const dirty = checkpointGitMetadata({ cwd }).state;
  assert.deepEqual(dirty.ciValidationStatus, currentEvidence);
  assert.deepEqual(dirty.ciValidationHistory, [currentEvidence]);
  rmSync(join(cwd, 'dirty-ci-proof.txt'));
  const cleaned = checkpointGitMetadata({ cwd }).state;
  assert.equal(cleaned.git.dirty, false);
  assert.deepEqual(cleaned.ciValidationStatus, currentEvidence);
  const restored = checkpointCiValidation({
    cwd, evidence: currentEvidence, expectedRevision: cleaned.revision,
  });
  assert.deepEqual(restored.ciValidationStatus, currentEvidence);
  assert.deepEqual(restored.ciValidationHistory, [currentEvidence]);

  assert.throws(() => checkpointCiValidation({
    cwd, evidence: { ...currentEvidence, status: 'failed' }, expectedRevision: restored.revision,
  }), { code: 'CI_EVIDENCE_CONFLICT' });

  const failedEvidence = ciEvidence(restored, {
    status: 'failed', checkRunId: 'CHECK_123457',
  });
  const failed = checkpointCiValidation({ cwd, evidence: failedEvidence, expectedRevision: restored.revision });
  assert.equal(failed.ciValidationHistory.length, 2);
  assert.equal(failed.ciValidationStatus.status, 'failed');
  assert.equal(failed.ciValidationHistory[0].workflowRunId, failed.ciValidationHistory[1].workflowRunId);

  const { checkRunId: _legacyCheckRunId, ...legacyEvidence } = currentEvidence;
  const legacyState = {
    ...initial, ciValidationStatus: legacyEvidence, ciValidationHistory: [legacyEvidence],
  };
  const upgraded = buildCiValidationTransition(legacyState, currentEvidence);
  assert.deepEqual(upgraded.ciValidationHistory, [legacyEvidence, currentEvidence]);
  assert.throws(() => buildCiValidationTransition(initial, {
    ...currentEvidence, checkRunId: '',
  }), { code: 'INVALID_CI_VALIDATION' });

  const previousHistory = structuredClone(failed.ciValidationHistory);
  const newHead = commit(cwd, { 'ci-drift.txt': 'drift\n' }, 'CI proof drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.currentIntegrationHeadSha, newHead);
  assert.deepEqual(drifted.ciValidationStatus, {
    source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
    checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null,
  });
  assert.deepEqual(drifted.ciValidationHistory, previousHistory);
  assert.throws(() => checkpointCiValidation({
    cwd, evidence: currentEvidence, expectedRevision: drifted.revision,
  }), { code: 'INVALID_CI_VALIDATION' });
});

test('full CI evidence restores a non-tail immutable attempt when integration HEAD returns', () => {
  const cwd = repo();
  const initial = init(cwd);
  const headA = initial.currentIntegrationHeadSha;
  const evidenceA = ciEvidence(initial, {
    checkRunId: 'CHECK_HEAD_A', workflowRunId: 123451,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/123451',
  });
  const collectedA = checkpointCiValidation({
    cwd, evidence: evidenceA, expectedRevision: initial.revision,
  });

  const headB = commit(cwd, { 'ci-head-b.txt': 'head B\n' }, 'CI head B');
  const onHeadB = checkpointGitMetadata({ cwd }).state;
  assert.equal(onHeadB.currentIntegrationHeadSha, headB);
  assert.equal(onHeadB.ciValidationStatus.status, 'not-run');
  const evidenceB = ciEvidence(onHeadB, {
    status: 'failed', checkRunId: 'CHECK_HEAD_B', workflowRunId: 123452,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/123452',
    updatedAt: '2026-08-05T00:01:00Z',
  });
  const collectedB = checkpointCiValidation({
    cwd, evidence: evidenceB, expectedRevision: onHeadB.revision,
  });
  const immutableHistory = structuredClone(collectedB.ciValidationHistory);
  assert.deepEqual(immutableHistory, [evidenceA, evidenceB]);

  git(cwd, ['switch', '--detach', headA]);
  const returnedToHeadA = checkpointGitMetadata({ cwd }).state;
  assert.equal(returnedToHeadA.currentIntegrationHeadSha, headA);
  assert.equal(returnedToHeadA.ciValidationStatus.status, 'not-run');
  assert.deepEqual(returnedToHeadA.ciValidationHistory, immutableHistory);

  const restoredA = checkpointCiValidation({
    cwd, evidence: evidenceA, expectedRevision: returnedToHeadA.revision,
  });
  assert.deepEqual(restoredA.ciValidationStatus, evidenceA);
  assert.deepEqual(restoredA.ciValidationHistory, immutableHistory);
  assert.equal(restoredA.revision, returnedToHeadA.revision + 1);

  const repeatedA = checkpointCiValidation({
    cwd, evidence: evidenceA, expectedRevision: restoredA.revision,
  });
  assert.deepEqual(repeatedA, restoredA);
  assert.equal(repeatedA.revision, restoredA.revision);
  assert.throws(() => checkpointCiValidation({
    cwd, evidence: { ...evidenceA, status: 'failed' }, expectedRevision: restoredA.revision,
  }), { code: 'CI_EVIDENCE_CONFLICT' });

  const unseenA = ciEvidence(restoredA, {
    checkRunId: 'CHECK_HEAD_A_RERUN', workflowRunId: 123453,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/123453',
    updatedAt: '2026-08-05T00:02:00Z',
  });
  const appended = checkpointCiValidation({
    cwd, evidence: unseenA, expectedRevision: restoredA.revision,
  });
  assert.deepEqual(appended.ciValidationHistory, [...immutableHistory, unseenA]);
  assert.deepEqual(appended.ciValidationHistory.slice(0, -1), immutableHistory);
  assert.deepEqual(checkpointCiValidation({
    cwd, evidence: unseenA, expectedRevision: appended.revision,
  }), appended);
});

test('same-HEAD dirty checkpoints preserve proof while lifecycle gates remain fail-closed', () => {
  const readyCwd = repo();
  const prepared = ready(init(readyCwd));
  writeFileSync(statePath(readyCwd, prepared.prNumber), `${JSON.stringify(prepared)}\n`);
  const readyProof = {
    validationStatus: structuredClone(prepared.validationStatus),
    threadResolutionStatus: structuredClone(prepared.threadResolutionStatus),
    tasks: structuredClone(prepared.tasks),
  };

  writeFileSync(join(readyCwd, 'temporary-ready-change.txt'), 'dirty\n');
  const dirtyReady = checkpointGitMetadata({ cwd: readyCwd }).state;
  assert.equal(dirtyReady.git.dirty, true);
  assert.equal(dirtyReady.phase, 'recovering');
  assert.deepEqual(dirtyReady.validationStatus, readyProof.validationStatus);
  assert.deepEqual(dirtyReady.threadResolutionStatus, readyProof.threadResolutionStatus);
  assert.deepEqual(dirtyReady.tasks, readyProof.tasks);
  assert.equal(reviewRequestGate(dirtyReady, external(readyCwd, dirtyReady)).allowed, false);

  rmSync(join(readyCwd, 'temporary-ready-change.txt'));
  const restoredReady = checkpointGitMetadata({ cwd: readyCwd }).state;
  assert.equal(restoredReady.git.dirty, false);
  assert.equal(restoredReady.phase, 'ready-for-review');
  assert.deepEqual(restoredReady.validationStatus, readyProof.validationStatus);
  assert.deepEqual(restoredReady.threadResolutionStatus, readyProof.threadResolutionStatus);
  assert.equal(reviewRequestGate(restoredReady, external(readyCwd, restoredReady)).allowed, true);

  const tasklessCwd = repo();
  const tasklessReady = ready(init(tasklessCwd), []);
  writeFileSync(statePath(tasklessCwd, tasklessReady.prNumber), `${JSON.stringify(tasklessReady)}\n`);
  const requested = checkpointReviewRequest({
    cwd: tasklessCwd, request: request(tasklessReady),
    pushedHeadSha: tasklessReady.currentIntegrationHeadSha,
    prHeadSha: tasklessReady.currentIntegrationHeadSha,
    expectedRevision: tasklessReady.revision,
  });
  const reviewed = checkpointReviewOutcome({
    cwd: tasklessCwd, outcome: outcome(requested), expectedRevision: requested.revision,
  });
  const validated = checkpointCiValidation({
    cwd: tasklessCwd, evidence: ciEvidence(reviewed), expectedRevision: reviewed.revision,
  });
  const exactHeadProof = {
    validationStatus: structuredClone(validated.validationStatus),
    ciValidationStatus: structuredClone(validated.ciValidationStatus),
    reviewRequest: structuredClone(validated.reviewRequest),
    reviewOutcome: structuredClone(validated.reviewOutcome),
    reviewHistory: structuredClone(validated.reviewHistory),
    threadResolutionStatus: structuredClone(validated.threadResolutionStatus),
  };

  writeFileSync(join(tasklessCwd, 'temporary-validating-change.txt'), 'dirty\n');
  const dirtyValidating = checkpointGitMetadata({ cwd: tasklessCwd }).state;
  assert.equal(dirtyValidating.phase, 'validating');
  for (const [field, proof] of Object.entries(exactHeadProof)) assert.deepEqual(dirtyValidating[field], proof);
  assert.equal(completionGate(dirtyValidating, external(tasklessCwd, dirtyValidating)).allowed, false);

  rmSync(join(tasklessCwd, 'temporary-validating-change.txt'));
  const cleanValidating = checkpointGitMetadata({ cwd: tasklessCwd }).state;
  const completed = checkpointCompletion({
    cwd: tasklessCwd,
    pushedHeadSha: cleanValidating.currentIntegrationHeadSha,
    prHeadSha: cleanValidating.currentIntegrationHeadSha,
    expectedRevision: cleanValidating.revision,
  });
  assert.equal(completed.phase, 'complete');

  writeFileSync(join(tasklessCwd, 'temporary-complete-change.txt'), 'dirty\n');
  const dirtyComplete = checkpointGitMetadata({ cwd: tasklessCwd }).state;
  assert.equal(dirtyComplete.phase, 'recovering');
  for (const [field, proof] of Object.entries(exactHeadProof)) assert.deepEqual(dirtyComplete[field], proof);
  assert.equal(completionGate(dirtyComplete, external(tasklessCwd, dirtyComplete)).allowed, false);

  rmSync(join(tasklessCwd, 'temporary-complete-change.txt'));
  const cleanRecovering = checkpointGitMetadata({ cwd: tasklessCwd }).state;
  const recompleted = checkpointCompletion({
    cwd: tasklessCwd,
    pushedHeadSha: cleanRecovering.currentIntegrationHeadSha,
    prHeadSha: cleanRecovering.currentIntegrationHeadSha,
    expectedRevision: cleanRecovering.revision,
  });
  assert.equal(recompleted.phase, 'complete');

  commit(tasklessCwd, { 'actual-head-change.txt': 'changed\n' }, 'actual head change');
  writeFileSync(join(tasklessCwd, 'dirty-after-head-change.txt'), 'dirty too\n');
  const driftedDirty = checkpointGitMetadata({ cwd: tasklessCwd }).state;
  assert.equal(driftedDirty.git.dirty, true);
  assert.equal(driftedDirty.phase, 'recovering');
  assert.equal(driftedDirty.validationStatus.status, 'not-run');
  assert.equal(driftedDirty.ciValidationStatus.status, 'not-run');
  assert.equal(driftedDirty.threadResolutionStatus.status, 'not-run');
});

test('cleaning an exhausted finite-limit checkout restores truthful review readiness', () => {
  const cwd = repo();
  let state = ready(init(cwd, { reviewRequestLimit: 4 }), []);
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const requested = buildReviewRequestTransition(state, request(state), external(cwd, state));
    state = ready(buildReviewOutcomeTransition(
      requested, outcome(requested, { outcome: 'findings' }),
    ), []);
  }
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(state)}\n`);
  writeFileSync(join(cwd, 'dirty-exhausted.txt'), 'dirty\n');
  const dirty = checkpointGitMetadata({ cwd }).state;
  assert.equal(dirty.phase, 'recovering');
  rmSync(join(cwd, 'dirty-exhausted.txt'));
  const restored = checkpointGitMetadata({ cwd }).state;
  assert.equal(restored.phase, 'ready-for-review');
  assert.match(restored.nextAction, /limit 4 is exhausted[\s\S]*set-review-limit[\s\S]*--unlimited/u);
  assert.equal(reviewRequestGate(restored, external(cwd, restored)).allowed, false);
});

test('stale discovery request can be replaced without rewriting its null-outcome ledger entry', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proofedA = checkpointTaskCompletion({
    cwd, expectedRevision: 0, threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  const preparedA = persistReady(cwd, proofedA, []);
  const requestedA = checkpointReviewRequest({
    cwd, expectedRevision: preparedA.revision, request: request(preparedA, 'discovery-a', 'discovery'),
    pushedHeadSha: preparedA.currentIntegrationHeadSha, prHeadSha: preparedA.currentIntegrationHeadSha,
  });
  const headA = requestedA.currentIntegrationHeadSha;
  const headB = commit(cwd, { 'discovery-drift.txt': 'drift\n' }, 'discovery request drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.phase, 'recovering');
  assert.equal(drifted.reviewHistory.length, 1);
  assert.equal(drifted.reviewHistory[0].request.headSha, headA);
  assert.equal(drifted.reviewHistory[0].outcome, null);

  const proofedB = checkpointTaskCompletion({
    cwd, expectedRevision: drifted.revision,
    threadResolutionStatus: {
      status: 'passed', headSha: headB, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
    },
  });
  const preparedB = persistReady(cwd, proofedB, []);
  const requestedB = checkpointReviewRequest({
    cwd, expectedRevision: preparedB.revision, request: request(preparedB, 'discovery-b', 'discovery'),
    pushedHeadSha: headB, prHeadSha: headB,
  });
  assert.equal(requestedB.phase, 'awaiting-review');
  assert.equal(requestedB.reviewHistory.length, 2);
  assert.equal(requestedB.reviewHistory[0].request.id, 'discovery-a');
  assert.equal(requestedB.reviewHistory[0].outcome, null);
  assert.equal(requestedB.reviewHistory[1].request.id, 'discovery-b');
  assert.equal(requestedB.reviewHistory[1].request.headSha, headB);
});

test('stale discovery disposition is append-only, exact-bound, retry-idempotent, and ordinal-preserving', () => {
  const cwd = repo();
  const recovery = nativeStaleDiscoveryDisposition(cwd);
  const state = recovery.dispositioned;

  assert.equal(state.phase, 'ready-for-review');
  assert.equal(state.reviewOutcome, null);
  assert.equal(state.reviewedHeadSha, null);
  assert.equal(state.reviewRound, 1);
  assert.deepEqual(state.reviewHistory, recovery.immutableHistory);
  assert.deepEqual(state.staleDiscoveryDispositions, [recovery.disposition]);
  assert.equal(state.staleDiscoveryDispositions[0].responseFingerprint, 'd'.repeat(64));
  assert.equal(state.threadResolutionStatus.status, 'passed');
  assert.equal(state.threadResolutionStatus.headSha, recovery.liveHeadSha);
  assert.deepEqual(reviewRequestUsage(state), {
    used: 1, limit: null, remaining: null, exhausted: false,
  });
  assert.equal(reviewRequestGate(state, external(cwd, state)).kind, 'discovery');
  assert.match(renderRecoverySummary({ cwd }),
    /Stale discovery dispositions: 1; latest [0-9a-f]{64} binds request stale-discovery-request [0-9a-f]{40} -> [0-9a-f]{40} \(clean\)/u);

  const retry = checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision,
    threadResolutionStatus: recovery.threadResolutionStatus,
    staleDiscoveryDisposition: recovery.disposition,
  });
  assert.equal(retry.revision, state.revision);
  assert.deepEqual(retry, state);
  assert.throws(() => checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision - 1,
    threadResolutionStatus: recovery.threadResolutionStatus,
    staleDiscoveryDisposition: recovery.disposition,
  }), { code: 'STATE_REVISION_CONFLICT' });

  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: state.revision,
    nextState: { ...state, staleDiscoveryDispositions: [] },
  }), /staleDiscoveryDispositions/u);
  const edited = structuredClone(state);
  edited.staleDiscoveryDispositions[0].evidence.id = 'heuristically-repaired';
  edited.staleDiscoveryDispositions[0].dispositionId = staleDiscoveryDispositionId(
    edited.staleDiscoveryDispositions[0],
  );
  assert.throws(() => checkpointState({
    cwd, expectedRevision: state.revision, nextState: edited,
  }), /staleDiscoveryDispositions/u);

  const replacement = checkpointReviewRequest({
    cwd,
    expectedRevision: state.revision,
    request: request(state, 'replacement-discovery', 'discovery'),
    pushedHeadSha: state.currentIntegrationHeadSha,
    prHeadSha: state.currentIntegrationHeadSha,
  });
  assert.equal(replacement.reviewHistory.length, 2);
  assert.deepEqual(replacement.reviewHistory[0], recovery.immutableHistory[0]);
  assert.equal(replacement.reviewHistory[1].request.kind, 'discovery');
  assert.equal(replacement.reviewHistory[1].outcome, null);
  assert.deepEqual(replacement.staleDiscoveryDispositions, [recovery.disposition]);
});

test('dispositioned stale discovery findings enter ordinary triage and retain immutable source evidence', () => {
  const cwd = repo();
  const recovery = nativeStaleDiscoveryDisposition(cwd, { dispositionOutcome: 'findings' });
  const state = recovery.dispositioned;

  assert.equal(state.phase, 'triaging');
  assert.equal(state.threadResolutionStatus.status, 'not-run');
  assert.equal(state.threadResolutionStatus.headSha, null);
  assert.match(state.nextAction, /Triage the actionable findings/u);
  assert.deepEqual(state.reviewHistory, recovery.immutableHistory);
  assert.equal(state.reviewOutcome, null);
  assert.equal(state.reviewedHeadSha, null);
  assert.equal(state.staleDiscoveryDispositions[0].evidence.outcome, 'findings');
  assert.equal(state.staleDiscoveryDispositions[0].evidence.headSha, recovery.requestHeadSha);

  const retry = checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision,
    threadResolutionStatus: state.threadResolutionStatus,
    staleDiscoveryDisposition: recovery.disposition,
  });
  assert.equal(retry.revision, state.revision);
  assert.deepEqual(retry, state);
});

test('stale discovery disposition rejects non-native, inconsistent, and tampered evidence', () => {
  for (const mutate of [
    (recovery, disposition) => { disposition.liveHeadSha = recovery.requestHeadSha; },
    (_recovery, disposition) => { disposition.requestId = 'foreign-request'; },
    (_recovery, disposition) => { disposition.evidence.kind = 'verification'; },
    (_recovery, disposition) => { disposition.evidence.headSha = 'c'.repeat(40); },
  ]) {
    const cwd = repo();
    const recovery = nativeStaleDiscoveryDisposition(cwd);
    const disposition = structuredClone(recovery.disposition);
    mutate(recovery, disposition);
    disposition.dispositionId = staleDiscoveryDispositionId(disposition);
    assert.throws(() => completeIntegratedTasks(recovery.validated, {
      threadResolutionStatus: recovery.threadResolutionStatus,
      staleDiscoveryDisposition: disposition,
    }), { code: 'INVALID_STALE_DISCOVERY_DISPOSITION' });
  }

  const cwd = repo();
  const recovery = nativeStaleDiscoveryDisposition(cwd);
  assert.throws(() => completeIntegratedTasks({
    ...recovery.validated,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 0, migratedAt: AT },
  }, {
    threadResolutionStatus: recovery.threadResolutionStatus,
    staleDiscoveryDisposition: recovery.disposition,
  }), { code: 'STALE_DISCOVERY_DISPOSITION_NOT_ALLOWED' });
});

test('finite stale discovery allowance keeps proof but blocks replacement with the exact operator action', () => {
  const cwd = repo();
  const { dispositioned, immutableHistory, disposition } = nativeStaleDiscoveryDisposition(cwd, {
    reviewRequestLimit: 1,
  });
  assert.equal(dispositioned.phase, 'ready-for-review');
  assert.equal(dispositioned.threadResolutionStatus.status, 'passed');
  assert.deepEqual(dispositioned.reviewHistory, immutableHistory);
  assert.deepEqual(dispositioned.staleDiscoveryDispositions, [disposition]);
  assert.deepEqual(reviewRequestUsage(dispositioned), {
    used: 1, limit: 1, remaining: 0, exhausted: true,
  });
  assert.equal(reviewRequestGate(dispositioned, external(cwd, dispositioned)).allowed, false);
  assert.match(dispositioned.nextAction,
    /limit 1 is exhausted after 1 durable requests; run npm run review:state -- set-review-limit --pr 17 --expected-revision [0-9]+ --limit <higher-number> or --unlimited/u);
});

test('stale verification request recovers without rewriting its evidence', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const migrated = migratePrReviewStateV1(legacyState(initialized, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision, request: request(prepared, 'verification-stale', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha, prHeadSha: prepared.currentIntegrationHeadSha,
  });
  const immutableEvidence = structuredClone(requested.reviewHistory);
  commit(cwd, { 'verification-drift.txt': 'drift\n' }, 'verification request drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.phase, 'recovering');
  assert.deepEqual(drifted.reviewHistory, immutableEvidence);
  assert.equal(drifted.reviewOutcome, null);
});

test('verification repeats after three discovery rounds and findings return to triage', () => {
  const cwd = repo();
  const base = ready(init(cwd));
  const state = {
    ...base,
    reviewRound: 3,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT },
  };
  const requested = buildReviewRequestTransition(state, request(state, 'verification-1', 'verification'), external(cwd, state));
  assert.equal(requested.reviewRound, 3);
  assert.equal(requested.verificationReviewUsed, true);
  const stopped = buildReviewOutcomeTransition(requested, outcome(requested, { outcome: 'findings' }));
  assert.equal(stopped.phase, 'triaging');
  const preparedAgain = ready(stopped, []);
  const requestedAgain = buildReviewRequestTransition(
    preparedAgain, request(preparedAgain), external(cwd, preparedAgain),
  );
  assert.equal(requestedAgain.reviewRound, 3);
  assert.equal(requestedAgain.reviewHistory.length, 2);
  assert.deepEqual(requestedAgain.reviewHistory.map((entry) => entry.request.kind), [
    'verification', 'verification',
  ]);
  assert.equal(reviewRequestGate(preparedAgain, external(cwd, preparedAgain)).allowed, true);
});

test('unlimited cycles accept more than four durable requests in ordinal kind order', () => {
  const cwd = repo();
  let state = ready(init(cwd), []);
  const kinds = [];
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    const requested = buildReviewRequestTransition(state, request(state), external(cwd, state));
    kinds.push(requested.reviewRequest.kind);
    const reviewed = buildReviewOutcomeTransition(requested, outcome(requested, { outcome: 'findings' }));
    assert.equal(reviewed.phase, 'triaging');
    state = ready(reviewed, []);
  }
  assert.deepEqual(kinds, ['discovery', 'discovery', 'discovery', 'verification', 'verification', 'verification']);
  assert.deepEqual(reviewRequestUsage(state), {
    used: 6, limit: null, remaining: null, exhausted: false,
  });
  assert.equal(reviewRequestGate(state, external(cwd, state)).allowed, true);
  assert.equal(reviewRequestGate(state, external(cwd, state)).kind, 'verification');
});

test('a finite limit blocks only the next request and allows a clean final request to complete', () => {
  const cwd = repo();
  let state = ready(init(cwd, { reviewRequestLimit: 4 }), []);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const requested = buildReviewRequestTransition(state, request(state), external(cwd, state));
    const reviewed = buildReviewOutcomeTransition(requested, outcome(requested, { outcome: 'findings' }));
    state = ready(reviewed, []);
  }
  const finalRequest = buildReviewRequestTransition(state, request(state), external(cwd, state));
  assert.equal(finalRequest.reviewRequest.kind, 'verification');
  const clean = buildReviewOutcomeTransition(finalRequest, outcome(finalRequest));
  const ciValidated = buildCiValidationTransition(clean, ciEvidence(clean));
  assert.equal(completionGate(ciValidated, external(cwd, ciValidated)).allowed, true);
  assert.equal(buildCompletionTransition(ciValidated, external(cwd, ciValidated)).phase, 'complete');

  const findings = buildReviewOutcomeTransition(finalRequest, outcome(finalRequest, { outcome: 'findings' }));
  assert.equal(findings.phase, 'triaging');
  assert.match(findings.nextAction, /Triage[\s\S]*set-review-limit[\s\S]*--unlimited/u);
  const remediated = ready(findings, []);
  assert.deepEqual(reviewRequestUsage(remediated), {
    used: 4, limit: 4, remaining: 0, exhausted: true,
  });
  assert.equal(reviewRequestGate(remediated, external(cwd, remediated)).allowed, false);
  assert.ok(reviewRequestGate(remediated, external(cwd, remediated)).reasons.some(
    (reason) => reason.includes('explicit review request limit 4 is exhausted'),
  ));
});

test('guarded review limits preserve history, reject lowering and generic rewrites, and resume legacy findings', () => {
  const cwd = repo();
  let state = ready(init(cwd), []);
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const requested = buildReviewRequestTransition(state, request(state), external(cwd, state));
    const reviewed = buildReviewOutcomeTransition(requested, outcome(requested, { outcome: 'findings' }));
    state = ordinal === 4 ? reviewed : ready(reviewed, []);
  }
  const historical = {
    ...state,
    phase: 'awaiting-human-decision',
    nextAction: 'Historical fixed-limit workflow required an operator decision.',
  };
  delete historical.reviewRequestLimit;
  const immutableHistory = structuredClone(historical.reviewHistory);
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(historical)}\n`);

  const resumed = checkpointReviewRequestLimit({
    cwd, expectedRevision: historical.revision, reviewRequestLimit: null,
  });
  assert.equal(resumed.phase, 'triaging');
  assert.equal(resumed.reviewRequestLimit, null);
  assert.deepEqual(resumed.reviewHistory, immutableHistory);
  assert.equal(resumed.nextAction, 'Triage the applicable canonical review findings.');
  assert.throws(() => checkpointReviewRequestLimit({
    cwd, expectedRevision: historical.revision, reviewRequestLimit: null,
  }), { code: 'STATE_REVISION_CONFLICT' });

  const exhausted = checkpointReviewRequestLimit({
    cwd, expectedRevision: resumed.revision, reviewRequestLimit: 4,
  });
  assert.equal(exhausted.phase, 'triaging');
  assert.equal(reviewRequestUsage(exhausted).exhausted, true);
  assert.match(exhausted.nextAction, /Triage[\s\S]*limit 4 is exhausted[\s\S]*--unlimited/u);
  assert.throws(() => checkpointReviewRequestLimit({
    cwd, expectedRevision: exhausted.revision, reviewRequestLimit: 3,
  }), { code: 'INVALID_REVIEW_REQUEST_LIMIT' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: exhausted.revision,
    nextState: { ...exhausted, reviewRequestLimit: 8 },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });

  const raised = checkpointReviewRequestLimit({
    cwd, expectedRevision: exhausted.revision, reviewRequestLimit: 8,
  });
  assert.equal(reviewRequestUsage(raised).exhausted, false);
  assert.equal(raised.nextAction, 'Triage the applicable canonical review findings.');
  const unlimited = checkpointReviewRequestLimit({
    cwd, expectedRevision: raised.revision, reviewRequestLimit: null,
  });
  assert.deepEqual(reviewRequestUsage(unlimited), {
    used: 4, limit: null, remaining: null, exhausted: false,
  });
  assert.equal(unlimited.nextAction, 'Triage the applicable canonical review findings.');
  assert.deepEqual(unlimited.reviewHistory, immutableHistory);
});

test('review limit changes cannot exhaust a pending request but may preserve its recovery slot', () => {
  const cwd = repo();
  let prepared = ready(init(cwd), []);
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
    prepared = ready(buildReviewOutcomeTransition(
      requested, outcome(requested, { outcome: 'findings' }),
    ), []);
  }
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(prepared)}\n`);
  const eventsPath = join(stateDirectory(cwd, 17), 'events.ndjson');
  const priorEvents = readFileSync(eventsPath, 'utf8');
  const operationId = `request:17:verification:5:${prepared.currentIntegrationHeadSha}`;
  writeFileSync(eventsPath, `${priorEvents}${JSON.stringify({
    type: 'github-mutation-intent', summary: 'Pending review request.',
    details: { operationId }, at: AT,
  })}\n`);
  assert.throws(() => checkpointReviewRequestLimit({
    cwd, expectedRevision: prepared.revision, reviewRequestLimit: 4,
  }), { code: 'REVIEW_REQUEST_INTENT_PENDING' });
  const raised = checkpointReviewRequestLimit({
    cwd, expectedRevision: prepared.revision, reviewRequestLimit: 6,
  });
  assert.equal(raised.reviewRequestLimit, 6);
  assert.equal(reviewRequestUsage(raised).remaining, 2);
  assert.deepEqual(raised.reviewHistory, prepared.reviewHistory);
});

test('GitHub mutation intents atomically retain one durable winner across differing retry metadata', () => {
  const cwd = repo();
  const operationId = `ready:17:PR_node:${'a'.repeat(40)}`;
  const winner = ensureGitHubMutationIntent(cwd, 17, {
    type: 'ready', operationId, clientMutationId: 'mutation-1', at: AT,
  });
  const retry = ensureGitHubMutationIntent(cwd, 17, {
    type: 'ready', operationId, clientMutationId: 'mutation-1', at: '2026-08-05T00:00:01Z',
    excludedCommentIds: ['irrelevant-retry-baseline'],
  });
  assert.equal(winner.isNew, true);
  assert.equal(retry.isNew, false);
  assert.equal(retry.at, AT);
  const events = readFileSync(join(stateDirectory(cwd, 17), 'events.ndjson'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.type === 'github-mutation-intent');
  assert.equal(events.length, 1);
  assert.throws(() => ensureGitHubMutationIntent(cwd, 17, {
    type: 'request', operationId, clientMutationId: 'mutation-1', at: AT,
  }), { code: 'INTENT_CONFLICT' });
  assert.throws(() => ensureGitHubMutationIntent(cwd, 17, {
    type: 'ready', operationId, clientMutationId: 'different-mutation', at: AT,
  }), { code: 'INTENT_CONFLICT' });
});
