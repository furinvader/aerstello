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

test('dedicated archive import completion revalidates its closed envelope and retries byte-identically', () => {
  const cwd = repo();
  const fixture = archiveImportStateFixture(cwd);
  const adopted = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.equal(adopted.tasks.find((candidate) => candidate.id === fixture.aggregate.id).status, 'completed');
  assert.equal(adopted.threadResolutionStatus.threads.length, 2);
  assert.deepEqual(
    adopted.threadResolutionStatus.threads.map((row) => row.archiveProvenance.authorityFingerprint),
    [fixture.envelope.authorityFingerprint, fixture.envelope.authorityFingerprint],
  );
  const stateBytes = readFileSync(statePath(cwd, adopted.prNumber), 'utf8');
  const eventBytes = readFileSync(join(stateDirectory(cwd, adopted.prNumber), 'events.ndjson'), 'utf8');
  const retried = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: adopted.revision,
    threadResolutionStatus: adopted.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.equal(retried.revision, adopted.revision);
  assert.equal(readFileSync(statePath(cwd, adopted.prNumber), 'utf8'), stateBytes);
  assert.equal(readFileSync(join(stateDirectory(cwd, adopted.prNumber), 'events.ndjson'), 'utf8'), eventBytes);

  const invalidEnvelopes = [
    { ...fixture.envelope, extra: true },
    { ...fixture.envelope, taskId: 'alternate-task' },
    { ...fixture.envelope, rows: fixture.envelope.rows.slice().reverse() },
    {
      ...fixture.envelope,
      rows: fixture.envelope.rows.map((row, index) => (
        index === 0 ? { ...row, rowFingerprint: '0'.repeat(64) } : row
      )),
    },
  ];
  for (const archiveImportEnvelope of invalidEnvelopes) {
    assert.throws(() => checkpointArchiveTaskCompletion({
      cwd,
      expectedRevision: adopted.revision,
      threadResolutionStatus: adopted.threadResolutionStatus,
      archiveImportEnvelope,
    }), { code: 'INVALID_ARCHIVE_IMPORT' });
    assert.equal(readFileSync(statePath(cwd, adopted.prNumber), 'utf8'), stateBytes);
    assert.equal(readFileSync(join(stateDirectory(cwd, adopted.prNumber), 'events.ndjson'), 'utf8'), eventBytes);
  }
});

test('generic and ordinary checkpoints cannot forge archive provenance and adopted rows stay immutable', () => {
  const cwd = repo();
  const fixture = archiveImportStateFixture(cwd);
  const stateBytes = readFileSync(statePath(cwd, fixture.current.prNumber), 'utf8');
  const eventPath = join(stateDirectory(cwd, fixture.current.prNumber), 'events.ndjson');
  const eventBytes = readFileSync(eventPath, 'utf8');
  assert.throws(() => checkpointArchiveTaskCompletion({
    cwd,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  }), { code: 'STATE_REVISION_CONFLICT' });
  const extraResolvedProof = structuredClone(fixture.threadResolutionStatus);
  extraResolvedProof.threads.push({
    ...structuredClone(extraResolvedProof.threads[0]),
    threadNodeId: 'PRRT_archive_extra',
    rootCommentNodeId: 'PRRC_archive_extra',
    rootCommentDatabaseId: 203,
    replyId: 'REPLY_archive_extra',
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r203',
  });
  delete extraResolvedProof.threads.at(-1).archiveProvenance;
  assert.throws(() => checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: extraResolvedProof,
    archiveImportEnvelope: fixture.envelope,
  }), { code: 'INVALID_ARCHIVE_IMPORT' });
  assert.throws(() => checkpointTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  }), { code: 'PROTECTED_ARCHIVE_IMPORT_REQUIRED' });
  assert.throws(() => checkpointTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
  }), { code: 'PROTECTED_ARCHIVE_IMPORT_REQUIRED' });
  const forgedNext = completeIntegratedTasks(fixture.current, {
    threadResolutionStatus: fixture.threadResolutionStatus,
  });
  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: fixture.current.revision,
    nextState: forgedNext,
  }), { code: 'PROTECTED_ARCHIVE_IMPORT_REQUIRED' });
  assert.equal(readFileSync(statePath(cwd, fixture.current.prNumber), 'utf8'), stateBytes);
  assert.equal(readFileSync(eventPath, 'utf8'), eventBytes);

  const adopted = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  const adoptedBytes = readFileSync(statePath(cwd, adopted.prNumber), 'utf8');
  const adoptedEvents = readFileSync(eventPath, 'utf8');
  const removed = structuredClone(adopted);
  delete removed.threadResolutionStatus.threads[0].archiveProvenance;
  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: adopted.revision,
    nextState: removed,
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const alteredProof = structuredClone(adopted.threadResolutionStatus);
  alteredProof.threads[0].archiveProvenance.replyBodySha256 = 'f'.repeat(64);
  const alteredEnvelope = structuredClone(fixture.envelope);
  alteredEnvelope.rows[0] = {
    ...alteredEnvelope.rows[0],
    replyBodySha256: 'f'.repeat(64),
    provenanceFingerprint: archiveImportDigest(alteredProof.threads[0].archiveProvenance),
    rowFingerprint: archiveImportDigest(alteredProof.threads[0]),
  };
  assert.throws(() => checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: adopted.revision,
    threadResolutionStatus: alteredProof,
    archiveImportEnvelope: alteredEnvelope,
  }), { code: 'INVALID_ARCHIVE_IMPORT' });
  assert.equal(readFileSync(statePath(cwd, adopted.prNumber), 'utf8'), adoptedBytes);
  assert.equal(readFileSync(eventPath, 'utf8'), adoptedEvents);
});

test('archival preserves immutable packet sidecars and specialist bundles', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['archive-evidence']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'archive-evidence');
  state = bindPacket(cwd, state, packet);
  buildTargetedValidationPlan({ cwd, now: () => AT });
  state = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT }).state;
  planSpecialists({
    cwd,
    expectedRevision: state.revision,
    now: () => AT,
    input: {
      schemaVersion: 1, stage: 'post-integration', headSha: state.currentIntegrationHeadSha,
      tasks: [{ taskPacket: packet }],
    },
  });
  const archived = archiveState({ cwd, abandonmentReason: 'Archive specialist evidence fixture.' });
  assert.equal(readdirSync(join(archived, 'task-packets')).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(readdirSync(join(archived, 'task-binding-provenance')).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(readdirSync(join(archived, 'task-binding-provenance')).filter((name) => name.endsWith('.sha256')).length, 1);
  assert.equal(readdirSync(join(archived, 'specialist-reviews')).filter((name) => name.endsWith('.json')).length, 2);
  assert.equal(readdirSync(join(archived, 'specialist-reviews')).filter((name) => name.endsWith('.plan.sha256')).length, 2);
});

test('archive interruption before pointer clear leaves active source valid; retry succeeds', () => {
  const cwd = repo();
  init(cwd);
  assert.throws(() => archiveState({
    cwd, abandonmentReason: 'Human-owned cycle.',
    onArchiveStep: (step) => { if (step === 'archive-durable') throw new Error('interrupt'); },
  }));
  assert.equal(loadState(cwd).prNumber, 17);
  const archived = archiveState({ cwd, abandonmentReason: 'Human-owned cycle.' });
  assert.ok(existsSync(join(archived, 'state.json')));
  assert.equal(loadState(cwd), null);
});

test('archive interruption after pointer clear is recoverable with explicit PR retry', () => {
  const cwd = repo();
  init(cwd);
  assert.throws(() => archiveState({
    cwd, abandonmentReason: 'Human-owned cycle.',
    onArchiveStep: (step) => { if (step === 'pointer-cleared') throw new Error('interrupt'); },
  }));
  assert.equal(existsSync(activePointerPath(cwd)), false);
  assert.ok(existsSync(statePath(cwd, 17)));
  const archived = archiveState({ cwd, prNumber: 17, abandonmentReason: 'Human-owned cycle.' });
  assert.ok(existsSync(join(archived, 'state.json')));
});

test('archive normalizes an explicit string PR number before clearing the active pointer', () => {
  const cwd = repo();
  init(cwd);

  archiveState({ cwd, prNumber: '17', abandonmentReason: 'Superseded by a new pull request.' });

  assert.equal(existsSync(activePointerPath(cwd)), false);
  assert.equal(existsSync(stateDirectory(cwd, 17)), false);
});
