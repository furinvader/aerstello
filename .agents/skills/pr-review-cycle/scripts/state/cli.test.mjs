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

test('state CLI preserves help and malformed-usage exit behavior', () => {
  const cwd = repo();
  const noCommand = spawnSync(process.execPath, [STATE_CLI], { cwd, encoding: 'utf8' });
  const help = spawnSync(process.execPath, [STATE_CLI, 'help'], { cwd, encoding: 'utf8' });
  const unknown = spawnSync(process.execPath, [STATE_CLI, 'not-a-command'], { cwd, encoding: 'utf8' });
  const malformed = spawnSync(process.execPath, [STATE_CLI, 'show', '--pr'], { cwd, encoding: 'utf8' });

  assert.equal(noCommand.status, 0, noCommand.stderr);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(noCommand.stdout, help.stdout);
  assert.match(noCommand.stdout, /^Usage: node .*state\/cli\.mjs <command> \[options\]/u);
  for (const command of [
    'init', 'scope-authority', 'scope-classify', 'scope-decision', 'scope-return', 'scope-resume',
  ]) assert.match(noCommand.stdout, new RegExp(`^  ${command}\\s`, 'mu'));
  assert.doesNotMatch(noCommand.stdout, /scope-amendment/u);

  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^Unknown command not-a-command\nUsage:/u);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /^--pr requires a value\nUsage:/u);
});

test('state CLI preserves StateError, invalid JSON, and operational exit classes', () => {
  const cwd = repo();
  const missingState = spawnSync(process.execPath, [STATE_CLI, 'show'], { cwd, encoding: 'utf8' });
  assert.equal(missingState.status, 1);
  assert.equal(missingState.stderr, 'STATE_NOT_FOUND: No active PR state\n');

  const malformedPath = join(cwd, 'malformed.json');
  writeFileSync(malformedPath, '{not-json\n');
  const invalidJson = spawnSync(process.execPath, [
    STATE_CLI, 'checkpoint', '--input', malformedPath,
  ], { cwd, encoding: 'utf8' });
  assert.equal(invalidJson.status, 1);
  assert.match(invalidJson.stderr, /^INVALID_JSON: /u);
  assert.doesNotMatch(invalidJson.stderr, /STATE_OPERATIONAL_ERROR/u);

  const missingPath = join(cwd, 'does-not-exist.json');
  const operational = spawnSync(process.execPath, [
    STATE_CLI, 'checkpoint', '--input', missingPath,
  ], { cwd, encoding: 'utf8' });
  assert.equal(operational.status, 2);
  assert.match(operational.stderr, /^STATE_OPERATIONAL_ERROR: ENOENT:/u);
  assert.match(operational.stderr, /does-not-exist\.json/u);
});

test('state CLI renders representative JSON and recovery output exactly', () => {
  const cwd = repo();
  const state = init(cwd);

  const shown = spawnSync(process.execPath, [STATE_CLI, 'show', '--pr', '17'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, `${JSON.stringify(state, null, 2)}\n`);

  const recovered = spawnSync(process.execPath, [STATE_CLI, 'recover', '--pr', '17'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, `${renderRecoverySummary({ cwd, prNumber: 17 })}\n`);
  assert.match(recovered.stdout, /^PR review recovery: example\/aerstello#17\nPhase: recovering;/u);
});

test('validate-result CLI enforces the exact task validation commands', () => {
  const cwd = repo();
  const reviewedHeadSha = commit(cwd, {
    'scripts/a.mjs': 'export const value = 1;\n',
  }, 'add worker validation fixture');
  const packet = {
    schemaVersion: 3, taskId: 'task-1', reviewedHeadSha, specialization: 'ops-workflow',
    riskTags: ['workflow'], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers workflow tooling.' }], system: [],
    },
  };
  let state = initializeState({
    cwd, prNumber: 17, repository: 'example/aerstello', base: 'HEAD', head: 'HEAD', releaseRef: 'HEAD',
  });
  state = checkpointState({
    cwd,
    expectedRevision: state.revision,
    nextState: {
      ...state,
      tasks: [{
        id: 'task-1', sourceIds: ['local:fixture'], sourceType: 'local', fingerprint: 'fixture-fingerprint',
        summary: 'Exercise exact validation commands.', severity: 'P2', disposition: 'actionable', status: 'proposed',
        integratedCommitSha: null, resolutionSummary: null,
        execution: {
          dependencies: [], ownedPaths: ['scripts/a.mjs'], worker: 'review_fix_worker', branch: null,
          worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
        },
      }],
    },
  });
  state = harness.scopeReadyForPacket(cwd, state, packet);
  planSpecialists({
    cwd,
    expectedRevision: state.revision,
    input: {
      schemaVersion: 1, stage: 'pre-bind', headSha: reviewedHeadSha,
      tasks: [{ taskPacket: packet, planningSignals: { browserVisible: false, testSelectionUncertain: false } }],
    },
  });
  checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  const commitSha = commit(cwd, { 'scripts/a.mjs': 'export const value = 2;\n' }, 'worker result');
  const result = {
    schemaVersion: 3, taskId: 'task-1', specialization: 'ops-workflow', status: 'implemented',
    commitSha, changedPaths: ['scripts/a.mjs'],
    validation: [{ command: 'npm run check:full', result: 'passed', summary: 'Broad command.' }],
    resolutionSummary: 'Implemented.', residualRisks: [], unexpectedDependencies: [],
  };
  const packetPath = join(cwd, 'packet.json');
  const resultPath = join(cwd, 'result.json');
  writeFileSync(packetPath, JSON.stringify(packet));
  writeFileSync(resultPath, JSON.stringify(result));
  const beforeInvalid = durableAcceptanceSnapshot(cwd, packet.taskId);

  const cli = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.match(cli.stderr, /undeclared command/u);
  assert.match(cli.stderr, /required validation was not reported/u);
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), beforeInvalid,
    'a validation-contract mismatch writes no state, event, envelope, or receipt evidence');

  writeFileSync(resultPath, JSON.stringify({
    ...result,
    validation: [{
      command: 'npm run check:workflow', result: 'passed', summary: 'Focused workflow check passed.',
    }],
  }));
  const valid = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stderr, '');
  assert.equal(valid.stdout, '{\n  "valid": true,\n  "taskId": "task-1"\n}\n');
});

test('validate-result CLI shares advanced-history acceptance authority without writes', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd);
  const packetPath = join(cwd, 'dependent-packet.json');
  const resultPath = join(cwd, 'dependent-result.json');
  writeFileSync(packetPath, JSON.stringify(fixture.packet));
  writeFileSync(resultPath, JSON.stringify(fixture.result));
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);

  const validated = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });

  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, '{\n  "valid": true,\n  "taskId": "dependent-result"\n}\n');
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
    'the diagnostic writes no state, event, envelope, or receipt evidence');
});

test('validate-result CLI accepts a parallel worker after unrelated integration advances', () => {
  const cwd = repo();
  const fixture = boundWorkerResultFixture(cwd, 'parallel-result');
  commit(cwd, {
    'scripts/parallel-sibling.mjs': 'export const parallelSibling = true;\n',
  }, 'integrate parallel sibling');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const packetPath = join(cwd, 'parallel-packet.json');
  const resultPath = join(cwd, 'parallel-result.json');
  writeFileSync(packetPath, JSON.stringify(fixture.packet));
  writeFileSync(resultPath, JSON.stringify(fixture.result));
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);

  assert.throws(() => assertTaskPacketBound(advanced, fixture.packet, { cwd }), {
    code: 'TASK_PACKET_HEAD_MISMATCH',
  }, 'the generic non-result packet gate remains exact-HEAD bound');
  const validated = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });

  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, '{\n  "valid": true,\n  "taskId": "parallel-result"\n}\n');
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
    'parallel result diagnostics write no state, event, envelope, or receipt evidence');
});

test('validate-result CLI rejects off-history advanced results without writes', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd, { workerBase: 'review' });
  const packetPath = join(cwd, 'off-history-packet.json');
  const resultPath = join(cwd, 'off-history-result.json');
  writeFileSync(packetPath, JSON.stringify(fixture.packet));
  writeFileSync(resultPath, JSON.stringify(fixture.result));
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);

  const rejected = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });

  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /^WORKER_RESULT_DEPENDENCY_ANCESTRY_MISMATCH:/u);
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
    'a rejected diagnostic writes no state, event, envelope, or receipt evidence');
});

test('validate-result CLI rejects terminal tasks without accepted worker evidence', () => {
  for (const status of ['integrated', 'completed']) {
    const cwd = repo();
    const fixture = boundWorkerResultFixture(cwd, `terminal-${status}`);
    git(cwd, ['cherry-pick', fixture.result.commitSha]);
    const centralSha = git(cwd, ['rev-parse', 'HEAD']);
    const advanced = checkpointGitMetadata({ cwd }).state;
    const terminalTask = advanced.tasks.map((item) => {
      if (item.id !== fixture.packet.taskId) return item;
      const { execution: _execution, ...withoutExecution } = item;
      return {
        ...withoutExecution,
        status,
        integratedCommitSha: centralSha,
        resolutionSummary: `Terminal ${status} fixture without accepted evidence.`,
      };
    });
    writeFileSync(statePath(cwd, advanced.prNumber), `${JSON.stringify({
      ...advanced, tasks: terminalTask,
    })}\n`);
    const packetPath = join(cwd, `${status}-packet.json`);
    const resultPath = join(cwd, `${status}-result.json`);
    writeFileSync(packetPath, JSON.stringify(fixture.packet));
    writeFileSync(resultPath, JSON.stringify(fixture.result));
    const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);

    const rejected = spawnSync(process.execPath, [
      STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
    ], { cwd, encoding: 'utf8' });

    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(
      `^WORKER_RESULT_ACCEPTANCE_NOT_ALLOWED: Task ${fixture.packet.taskId} cannot accept a worker result while ${status}`,
      'u',
    ));
    assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
      `a rejected ${status} diagnostic writes no state, event, envelope, or receipt evidence`);
  }
});

test('validate-result CLI is idempotent for exact accepted terminal evidence', () => {
  const cwd = repo();
  const fixture = boundWorkerResultFixture(cwd, 'accepted-diagnostic');
  checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result,
    expectedRevision: fixture.bound.revision,
  });
  git(cwd, ['cherry-pick', fixture.result.commitSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...acceptedTask } = advanced.tasks[0];
  const integrated = checkpointState({
    cwd,
    expectedRevision: advanced.revision,
    nextState: {
      ...advanced,
      tasks: [{
        ...acceptedTask,
        status: 'integrated',
        integratedCommitSha: centralSha,
        resolutionSummary: 'Integrated exact accepted worker evidence.',
      }],
    },
  });
  const packetPath = join(cwd, 'accepted-packet.json');
  const resultPath = join(cwd, 'accepted-result.json');
  writeFileSync(packetPath, JSON.stringify(fixture.packet));
  writeFileSync(resultPath, JSON.stringify(fixture.result));
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);

  const validated = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8' });

  assert.equal(integrated.tasks[0].status, 'integrated');
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(validated.stdout, '{\n  "valid": true,\n  "taskId": "accepted-diagnostic"\n}\n');
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before,
    'an idempotent accepted-evidence diagnostic writes no state, event, envelope, or receipt evidence');
});

test('state CLI configures and removes a finite review request limit strictly', () => {
  const cwd = repo();
  const initialized = spawnSync(process.execPath, [
    STATE_CLI, 'init', '--pr', '17', '--base', 'main', '--head', 'HEAD', '--release-ref', 'main',
    '--review-limit', '5',
  ], { cwd, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).reviewRequestLimit, 5);

  const invalid = spawnSync(process.execPath, [
    STATE_CLI, 'set-review-limit', '--pr', '17', '--expected-revision', '0',
    '--limit', '6', '--unlimited',
  ], { cwd, encoding: 'utf8' });
  assert.equal(invalid.status, 2);

  const unsafe = spawnSync(process.execPath, [
    STATE_CLI, 'set-review-limit', '--pr', '17', '--expected-revision', '0',
    '--limit', '9007199254740993',
  ], { cwd, encoding: 'utf8' });
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /must not exceed 9007199254740991/u);

  const unlimited = spawnSync(process.execPath, [
    STATE_CLI, 'set-review-limit', '--pr', '17', '--expected-revision', '0', '--unlimited',
  ], { cwd, encoding: 'utf8' });
  assert.equal(unlimited.status, 0, unlimited.stderr);
  assert.equal(JSON.parse(unlimited.stdout).reviewRequestLimit, null);
});

test('targeted validation CLI saves and executes the exact durable plan', () => {
  const cwd = repo();
  commit(cwd, {
    'tests/focused.test.mjs': "import test from 'node:test';\ntest('focused command', () => {});\n",
  }, 'add focused validation fixture');
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a', {
    affectedAreas: ['documentation'], command: 'node --test tests/focused.test.mjs',
  });
  state = harness.scopeReadyForPacket(cwd, state, packet);
  const packetPath = join(stateDirectory(cwd, state.prNumber), 'task-a.json');
  const specialistPlanInputPath = join(stateDirectory(cwd, state.prNumber), 'specialist-plan-input.json');
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  writeFileSync(specialistPlanInputPath, `${JSON.stringify(planInput(state, packet))}\n`);

  const specialistPlanned = spawnSync(process.execPath, [
    STATE_CLI, 'specialist-plan', '--pr', '17', '--expected-revision', String(state.revision),
    '--input', specialistPlanInputPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(specialistPlanned.status, 0, specialistPlanned.stderr);

  const bound = spawnSync(process.execPath, [
    STATE_CLI, 'bind-task-packet', '--pr', '17', '--expected-revision', String(state.revision),
    '--task-packet', packetPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(JSON.parse(bound.stdout).tasks[0].taskPacketDigest, taskPacketDigest(packet));

  const planned = spawnSync(process.execPath, [STATE_CLI, 'validation-plan', '--pr', '17'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(JSON.parse(planned.stdout).commands.map((entry) => entry.command), [
    'node --test tests/focused.test.mjs',
  ]);

  const executed = spawnSync(process.execPath, [STATE_CLI, 'run-validation', '--pr', '17'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).status, 'passed');
  assert.equal(loadState(cwd).validationStatus.status, 'passed');
});

test('specialist-plan CLI rejects malformed packet specialization before durable writes', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['malformed-specialization']);
  const packet = {
    ...taskPacket(state.currentIntegrationHeadSha, 'malformed-specialization'),
    specialization: null,
  };
  const inputPath = join(cwd, 'malformed-specialist-plan.json');
  writeFileSync(inputPath, `${JSON.stringify(planInput(state, packet))}\n`);
  const stateBefore = readFileSync(statePath(cwd, state.prNumber), 'utf8');
  const eventsPath = join(stateDirectory(cwd, state.prNumber), 'events.ndjson');
  const eventsBefore = readFileSync(eventsPath, 'utf8');
  const bundlePath = specialistReviewBundlePath(
    cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision,
  );
  const receiptPath = specialistPlanReceiptPath(
    cwd, state.prNumber, state.currentIntegrationHeadSha, state.revision,
  );

  const result = spawnSync(process.execPath, [
    STATE_CLI, 'specialist-plan', '--pr', '17', '--expected-revision', String(state.revision),
    '--input', inputPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^INVALID_SPECIALIST_PLAN:/u);
  assert.doesNotMatch(result.stderr, /STATE_OPERATIONAL_ERROR|TypeError/u);
  assert.match(result.stderr, /specialization must be a 1-128 character specialist profile ID/u);
  assert.equal(readFileSync(statePath(cwd, state.prNumber), 'utf8'), stateBefore);
  assert.equal(readFileSync(eventsPath, 'utf8'), eventsBefore);
  assert.equal(existsSync(bundlePath), false);
  assert.equal(existsSync(receiptPath), false);
});

test('replan-task-packet CLI preserves one opaque task ID and requires its revision guard', () => {
  const cwd = repo();
  const taskId = 'legacy, opaque task';
  const { state: migrated } = migrateV2BoundTask(cwd, { taskId });
  const missingRevision = spawnSync(process.execPath, [
    STATE_CLI, 'replan-task-packet', '--pr', '17', '--task', taskId,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(missingRevision.status, 2);
  assert.match(missingRevision.stderr, /requires --expected-revision/u);

  const replanned = spawnSync(process.execPath, [
    STATE_CLI, 'replan-task-packet', '--pr', '17', '--task', taskId,
    '--expected-revision', String(migrated.revision),
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(replanned.status, 0, replanned.stderr);
  assert.equal(JSON.parse(replanned.stdout).tasks[0].id, taskId);
  assert.equal(JSON.parse(replanned.stdout).tasks[0].status, 'proposed');
});
