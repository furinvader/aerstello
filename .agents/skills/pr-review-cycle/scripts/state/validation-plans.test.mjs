import * as harness from './test-support/state-harness.mjs';
import { renderRecoverySummary } from './recovery.mjs';
import {
  executeTargetedValidationFacts,
  relatedE2EMetadata,
  validateValidationPlan,
} from './evidence/validation-plans.mjs';

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

function unrelatedCommit(cwd, message = 'unrelated validation base') {
  return git(cwd, [
    'commit-tree', git(cwd, ['rev-parse', 'HEAD^{tree}']), '-m', message,
  ]);
}

function validationEvidenceSnapshot(cwd, prNumber = 17) {
  const directory = stateDirectory(cwd, prNumber);
  const planPath = validationPlanPath(cwd, prNumber);
  return {
    state: readFileSync(statePath(cwd, prNumber), 'utf8'),
    events: readFileSync(join(directory, 'events.ndjson'), 'utf8'),
    plan: existsSync(planPath) ? readFileSync(planPath, 'utf8') : null,
    repository: repositoryAuthoritySnapshot(cwd),
  };
}

test('extracted validation evidence owner validates plans and related E2E metadata directly', () => {
  assert.deepEqual(
    relatedE2EMetadata(['npm', 'run', 'test:e2e:related', '--', '--id', 'sample', '--project', 'desktop-firefox']),
    { selectors: ['id-sample'], projects: ['desktop-firefox'] },
  );
  assert.equal(relatedE2EMetadata(['npm', 'run', 'check:workflow']), null);

  const cwd = repo();
  const state = init(cwd);
  const plan = buildTargetedValidationPlan({
    cwd,
    initialSelection: initialSelection(state.currentIntegrationHeadSha),
    now: () => AT,
  });
  assert.deepEqual(validateValidationPlan(plan, state), []);
  assert.match(
    validateValidationPlan({ ...plan, headSha: 'f'.repeat(40) }, state).join('\n'),
    /plan\.headSha is stale/u,
  );
});

test('pristine taskless cycles run an explicit initial targeted validation selection', () => {
  const cwd = repo();
  const state = init(cwd);
  const selection = initialSelection(state.currentIntegrationHeadSha);
  const plan = buildTargetedValidationPlan({ cwd, initialSelection: selection, now: () => AT });
  assert.deepEqual(plan.taskIds, []);
  assert.deepEqual(plan.affectedAreas, ['workflow']);
  assert.deepEqual(plan.commands.map((entry) => entry.command), ['npm run check:workflow']);
  const result = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT });
  assert.equal(result.state.validationStatus.status, 'passed');
  assert.equal(result.state.validationStatus.headSha, state.currentIntegrationHeadSha);

  const laterCwd = repo();
  const later = init(laterCwd);
  const packet = taskPacket(later.currentIntegrationHeadSha, 'task-a');
  assert.throws(() => buildTargetedValidationPlan({
    cwd: laterCwd, taskPackets: [packet], initialSelection: initialSelection(later.currentIntegrationHeadSha),
  }), { code: 'INVALID_VALIDATION_PLAN' });
  assert.throws(() => buildTargetedValidationPlan({ cwd: laterCwd, taskPackets: [] }), {
    code: 'INVALID_VALIDATION_PLAN',
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: laterCwd, initialSelection: initialSelection('f'.repeat(40)),
  }), { code: 'VALIDATION_PLAN_STALE' });
  const withTask = checkpointState({
    cwd: laterCwd,
    nextState: {
      ...later,
      tasks: [task(later.currentIntegrationHeadSha, {
        id: 'task-a', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
    expectedRevision: later.revision,
  });
  assert.throws(() => buildTargetedValidationPlan({
    cwd: laterCwd, initialSelection: initialSelection(withTask.currentIntegrationHeadSha),
  }), { code: 'INITIAL_VALIDATION_NOT_ALLOWED' });
});

test('PR validation binds diff checks to the durable base and exact validation HEAD', () => {
  const equalCwd = repo();
  const equalState = init(equalCwd);
  const diffSelection = initialSelection(equalState.currentIntegrationHeadSha, {
    requiredValidation: {
      unit: [{ command: 'git diff --check', reason: 'Check the exact committed range.' }],
      system: [],
    },
  });
  const fresh = buildTargetedValidationPlan({ cwd: equalCwd, initialSelection: diffSelection, now: () => AT });
  assert.deepEqual(fresh.commands[0].argv, [
    'git', 'diff', '--check', equalState.baseSha, equalState.currentIntegrationHeadSha, '--',
  ]);

  const legacy = {
    ...fresh,
    commands: fresh.commands.map((entry) => entry.command === 'git diff --check'
      ? { ...entry, argv: ['git', 'diff', '--check'] }
      : entry),
  };
  writeFileSync(validationPlanPath(equalCwd, equalState.prNumber), `${JSON.stringify(legacy)}\n`);
  const attempted = [];
  const equalResult = executeTargetedValidationPlan({
    cwd: equalCwd,
    runCommand(argv, runCwd) {
      attempted.push(argv);
      return argv[0] === 'git'
        ? spawnSync(argv[0], argv.slice(1), { cwd: runCwd, encoding: 'utf8' })
        : { status: 0 };
    },
    now: () => AT,
  });
  assert.deepEqual(attempted[0], fresh.commands[0].argv);
  assert.deepEqual(equalResult.plan.commands[0].argv, ['git', 'diff', '--check']);
  assert.equal(equalResult.state.validationStatus.status, 'passed');

  const whitespaceCwd = repo();
  const original = init(whitespaceCwd);
  writeFileSync(join(whitespaceCwd, 'committed-whitespace.txt'), 'trailing whitespace  \n');
  git(whitespaceCwd, ['add', 'committed-whitespace.txt']);
  git(whitespaceCwd, ['commit', '-m', 'test: add committed whitespace']);
  const advanced = checkpointGitMetadata({ cwd: whitespaceCwd }).state;
  assert.equal(advanced.baseSha, original.baseSha);
  buildTargetedValidationPlan({
    cwd: whitespaceCwd,
    initialSelection: initialSelection(advanced.currentIntegrationHeadSha, {
      requiredValidation: {
        unit: [{ command: 'git diff --check', reason: 'Check the exact committed range.' }],
        system: [],
      },
    }),
    now: () => AT,
  });
  const failed = executeTargetedValidationPlan({
    cwd: whitespaceCwd,
    runCommand: (argv, runCwd) => argv[0] === 'git'
      ? spawnSync(argv[0], argv.slice(1), { cwd: runCwd, encoding: 'utf8' })
      : { status: 0 },
    now: () => AT,
  });
  assert.equal(failed.state.validationStatus.status, 'failed');
});

test('targeted validation planning proves actual base ancestry without replacement refs', () => {
  const cwd = repo();
  const unrelatedBase = unrelatedCommit(cwd);
  const state = init(cwd, { base: unrelatedBase });
  const selection = initialSelection(state.currentIntegrationHeadSha);
  const before = validationEvidenceSnapshot(cwd);
  assert.throws(
    () => buildTargetedValidationPlan({ cwd, initialSelection: selection, now: () => AT }),
    { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' },
  );
  assert.deepEqual(validationEvidenceSnapshot(cwd), before);

  const missingCwd = repo();
  const valid = init(missingCwd);
  const missingState = { ...valid, baseSha: 'f'.repeat(40) };
  writeFileSync(statePath(missingCwd, valid.prNumber), `${JSON.stringify(missingState)}\n`);
  const missingBefore = validationEvidenceSnapshot(missingCwd);
  assert.throws(
    () => buildTargetedValidationPlan({
      cwd: missingCwd,
      initialSelection: initialSelection(valid.currentIntegrationHeadSha),
      now: () => AT,
    }),
    { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' },
  );
  assert.deepEqual(validationEvidenceSnapshot(missingCwd), missingBefore);

  const replacementCwd = repo();
  const replacementBase = unrelatedCommit(replacementCwd, 'replacement-only base');
  const replacementState = init(replacementCwd, { base: replacementBase });
  const replacementCommit = git(replacementCwd, [
    'commit-tree', `${replacementState.currentIntegrationHeadSha}^{tree}`,
    '-p', replacementBase, '-m', 'forge validation ancestry',
  ]);
  git(replacementCwd, [
    'update-ref', `refs/replace/${replacementState.currentIntegrationHeadSha}`, replacementCommit,
  ]);
  assert.equal(spawnSync('git', [
    'merge-base', '--is-ancestor', replacementBase, replacementState.currentIntegrationHeadSha,
  ], { cwd: replacementCwd }).status, 0);
  assert.equal(spawnSync('git', [
    '--no-replace-objects', 'merge-base', '--is-ancestor',
    replacementBase, replacementState.currentIntegrationHeadSha,
  ], { cwd: replacementCwd }).status, 1);
  const replacementBefore = validationEvidenceSnapshot(replacementCwd);
  assert.throws(
    () => buildTargetedValidationPlan({
      cwd: replacementCwd,
      initialSelection: initialSelection(replacementState.currentIntegrationHeadSha),
      now: () => AT,
    }),
    { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' },
  );
  assert.deepEqual(validationEvidenceSnapshot(replacementCwd), replacementBefore);
});

test('targeted validation refuses common-directory graft ancestry from a linked worktree', () => {
  const primaryCwd = repo();
  const linkedCwd = join(
    tmpdir(), `aerstello-validation-linked-${process.pid}-${Date.now()}`,
  );
  git(primaryCwd, ['worktree', 'add', '--detach', linkedCwd, 'HEAD']);
  const commonDirectory = gitCommonDirectory(linkedCwd);
  const graftsPath = join(commonDirectory, 'info', 'grafts');
  try {
    const unrelatedBase = unrelatedCommit(linkedCwd, 'linked graft base');
    const state = init(linkedCwd, { base: unrelatedBase });
    mkdirSync(dirname(graftsPath), { recursive: true });
    writeFileSync(graftsPath, `${state.currentIntegrationHeadSha} ${unrelatedBase}\n`);
    assert.equal(spawnSync('git', [
      '--no-replace-objects', 'merge-base', '--is-ancestor',
      unrelatedBase, state.currentIntegrationHeadSha,
    ], { cwd: linkedCwd }).status, 0);
    const before = validationEvidenceSnapshot(linkedCwd);
    const graftsBefore = readFileSync(graftsPath, 'utf8');
    assert.throws(
      () => buildTargetedValidationPlan({
        cwd: linkedCwd,
        initialSelection: initialSelection(state.currentIntegrationHeadSha),
        now: () => AT,
      }),
      { code: 'VALIDATION_LEGACY_GRAFTS_PRESENT' },
    );
    assert.deepEqual(validationEvidenceSnapshot(linkedCwd), before);
    assert.equal(readFileSync(graftsPath, 'utf8'), graftsBefore);
  } finally {
    rmSync(graftsPath, { force: true });
    git(primaryCwd, ['worktree', 'remove', '--force', linkedCwd]);
  }
});

test('targeted validation execution rechecks ancestry before each pending command', () => {
  const cwd = repo();
  const state = init(cwd);
  buildTargetedValidationPlan({
    cwd,
    initialSelection: initialSelection(state.currentIntegrationHeadSha, {
      requiredValidation: {
        unit: [
          { command: 'npm run check:api', reason: 'First validation command.' },
          { command: 'npm run check:web', reason: 'Second validation command.' },
        ],
        system: [],
      },
    }),
    now: () => AT,
  });
  const unrelatedBase = unrelatedCommit(cwd, 'between-command base drift');
  let invoked = 0;
  let afterDrift;
  assert.throws(() => executeTargetedValidationPlan({
    cwd,
    runCommand: () => { invoked += 1; return { status: 0 }; },
    now: () => AT,
    onCommandRecorded: () => {
      const current = loadState(cwd);
      writeFileSync(
        statePath(cwd, current.prNumber),
        `${JSON.stringify({ ...current, baseSha: unrelatedBase })}\n`,
      );
      afterDrift = validationEvidenceSnapshot(cwd);
    },
  }), { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' });
  assert.equal(invoked, 1);
  assert.deepEqual(validationEvidenceSnapshot(cwd), afterDrift);
  const recorded = JSON.parse(readFileSync(validationPlanPath(cwd, state.prNumber), 'utf8'));
  assert.deepEqual(
    recorded.commands.map((entry) => entry.status),
    ['passed', 'pending', 'pending'],
  );
});

test('targeted validation execution rejects initial ancestry drift before invoking commands', () => {
  const cwd = repo();
  const state = init(cwd);
  buildTargetedValidationPlan({
    cwd, initialSelection: initialSelection(state.currentIntegrationHeadSha), now: () => AT,
  });
  const unrelatedBase = unrelatedCommit(cwd, 'initial execution base drift');
  writeFileSync(
    statePath(cwd, state.prNumber),
    `${JSON.stringify({ ...state, baseSha: unrelatedBase })}\n`,
  );
  const before = validationEvidenceSnapshot(cwd);
  let invoked = false;
  assert.throws(() => executeTargetedValidationPlan({
    cwd, runCommand: () => { invoked = true; return { status: 0 }; }, now: () => AT,
  }), { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' });
  assert.equal(invoked, false);
  assert.deepEqual(validationEvidenceSnapshot(cwd), before);
});

test('targeted validation execution preserves checkout errors over unrelated ancestry', () => {
  for (const fixture of [
    { kind: 'stale', code: 'VALIDATION_PLAN_STALE' },
    { kind: 'dirty', code: 'VALIDATION_CHECKOUT_DIRTY' },
  ]) {
    const cwd = repo();
    const state = init(cwd);
    buildTargetedValidationPlan({
      cwd, initialSelection: initialSelection(state.currentIntegrationHeadSha), now: () => AT,
    });
    const unrelatedBase = unrelatedCommit(cwd, `${fixture.kind} execution ancestry`);
    writeFileSync(
      statePath(cwd, state.prNumber),
      `${JSON.stringify({ ...state, baseSha: unrelatedBase })}\n`,
    );
    const checkoutPath = join(cwd, `${fixture.kind}-execution.txt`);
    if (fixture.kind === 'stale') {
      commit(cwd, { [`${fixture.kind}-execution.txt`]: 'stale checkout\n' }, 'stale validation checkout');
    } else {
      writeFileSync(checkoutPath, 'dirty checkout\n');
    }
    const checkoutContents = readFileSync(checkoutPath, 'utf8');
    const before = validationEvidenceSnapshot(cwd);
    let invoked = false;
    assert.throws(() => executeTargetedValidationPlan({
      cwd, runCommand: () => { invoked = true; return { status: 0 }; }, now: () => AT,
    }), { code: fixture.code });
    assert.equal(invoked, false);
    assert.deepEqual(validationEvidenceSnapshot(cwd), before);
    assert.equal(readFileSync(checkoutPath, 'utf8'), checkoutContents);
  }
});

test('post-command ancestry drift is rejected before command facts are accepted', () => {
  const cwd = repo();
  const state = init(cwd);
  const plan = buildTargetedValidationPlan({
    cwd, initialSelection: initialSelection(state.currentIntegrationHeadSha), now: () => AT,
  });
  const unrelatedBase = unrelatedCommit(cwd, 'post-command base drift');
  const before = validationEvidenceSnapshot(cwd);
  const executionState = { ...state };
  assert.throws(() => executeTargetedValidationFacts({
    cwd,
    state: executionState,
    plan,
    runCommand: () => {
      executionState.baseSha = unrelatedBase;
      return { status: 0 };
    },
    now: () => AT,
  }), { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' });
  assert.deepEqual(validationEvidenceSnapshot(cwd), before);
});

test('completed validation checkpoint rejects ancestry drift without mutation', () => {
  const cwd = repo();
  const state = init(cwd);
  const plan = buildTargetedValidationPlan({
    cwd, initialSelection: initialSelection(state.currentIntegrationHeadSha), now: () => AT,
  });
  const completedPlan = {
    ...plan,
    commands: plan.commands.map((entry) => ({
      ...entry, status: 'passed', exitCode: 0, summary: 'Passed.', completedAt: AT,
    })),
    updatedAt: AT,
  };
  writeFileSync(validationPlanPath(cwd, state.prNumber), `${JSON.stringify(completedPlan)}\n`);
  const unrelatedBase = unrelatedCommit(cwd, 'completed-plan base drift');
  writeFileSync(
    statePath(cwd, state.prNumber),
    `${JSON.stringify({ ...state, baseSha: unrelatedBase })}\n`,
  );
  const before = validationEvidenceSnapshot(cwd);
  assert.throws(() => checkpointTargetedValidation({
    cwd, expectedRevision: state.revision,
  }), { code: 'VALIDATION_BASE_ANCESTRY_MISMATCH' });
  assert.deepEqual(validationEvidenceSnapshot(cwd), before);
});

test('completed validation checkpoint preserves checkout errors over unrelated ancestry', () => {
  for (const fixture of [
    { kind: 'stale', code: 'VALIDATION_PLAN_STALE' },
    { kind: 'dirty', code: 'VALIDATION_CHECKOUT_DIRTY' },
  ]) {
    const cwd = repo();
    const state = init(cwd);
    const plan = buildTargetedValidationPlan({
      cwd, initialSelection: initialSelection(state.currentIntegrationHeadSha), now: () => AT,
    });
    const completedPlan = {
      ...plan,
      commands: plan.commands.map((entry) => ({
        ...entry, status: 'passed', exitCode: 0, summary: 'Passed.', completedAt: AT,
      })),
      updatedAt: AT,
    };
    writeFileSync(validationPlanPath(cwd, state.prNumber), `${JSON.stringify(completedPlan)}\n`);
    const unrelatedBase = unrelatedCommit(cwd, `${fixture.kind} checkpoint ancestry`);
    writeFileSync(
      statePath(cwd, state.prNumber),
      `${JSON.stringify({ ...state, baseSha: unrelatedBase })}\n`,
    );
    const checkoutPath = join(cwd, `${fixture.kind}-checkpoint.txt`);
    if (fixture.kind === 'stale') {
      commit(cwd, { [`${fixture.kind}-checkpoint.txt`]: 'stale checkout\n' }, 'stale checkpoint checkout');
    } else {
      writeFileSync(checkoutPath, 'dirty checkout\n');
    }
    const checkoutContents = readFileSync(checkoutPath, 'utf8');
    const before = validationEvidenceSnapshot(cwd);
    assert.throws(() => checkpointTargetedValidation({
      cwd, expectedRevision: state.revision,
    }), { code: fixture.code });
    assert.deepEqual(validationEvidenceSnapshot(cwd), before);
    assert.equal(readFileSync(checkoutPath, 'utf8'), checkoutContents);
  }
});

test('pending initial validation plans require an exact immutable definition match', () => {
  const cwd = repo();
  const state = init(cwd);
  const selection = initialSelection(state.currentIntegrationHeadSha);
  const plan = buildTargetedValidationPlan({ cwd, initialSelection: selection, now: () => AT });
  assert.deepEqual(buildTargetedValidationPlan({ cwd, initialSelection: selection }), plan);

  const changedAreas = {
    ...selection,
    affectedAreas: ['workflow', 'documentation'],
  };
  assert.throws(() => buildTargetedValidationPlan({ cwd, initialSelection: changedAreas }), {
    code: 'VALIDATION_PLAN_REPLACE_REQUIRED',
  });
  const changedReason = initialSelection(state.currentIntegrationHeadSha, {
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Revised workflow rationale.' }],
      system: [],
    },
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, initialSelection: changedReason }), {
    code: 'VALIDATION_PLAN_REPLACE_REQUIRED',
  });

  const replacementSelection = { ...changedReason, affectedAreas: changedAreas.affectedAreas };
  const replacement = buildTargetedValidationPlan({
    cwd, initialSelection: replacementSelection, replace: true, now: () => AT,
  });
  assert.deepEqual(replacement.affectedAreas, ['documentation', 'workflow']);
  assert.equal(replacement.commands[0].reason, 'Revised workflow rationale.');
  assert.deepEqual(buildTargetedValidationPlan({ cwd, initialSelection: replacementSelection }), replacement);
});

test('targeted validation plan durably de-duplicates the integrated task union and is resumable', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a', 'task-b']);
  const packets = [
    taskPacket(state.currentIntegrationHeadSha, 'task-a'),
    taskPacket(state.currentIntegrationHeadSha, 'task-b', { affectedAreas: ['shared'] }),
  ];
  state = bindPackets(cwd, state, packets);
  const plan = buildTargetedValidationPlan({ cwd, taskPackets: packets, now: () => AT });
  assert.deepEqual(plan.commands.map((entry) => entry.command), [
    'npm run check:api', 'npm run check:shared', 'npm run check:web',
  ]);
  assert.deepEqual(JSON.parse(readFileSync(validationPlanPath(cwd, 17), 'utf8')), plan);
  assert.deepEqual(buildTargetedValidationPlan({ cwd, taskPackets: [...packets].reverse() }), plan);

  const attempted = [];
  assert.throws(() => executeTargetedValidationPlan({
    cwd,
    runCommand: (argv) => { attempted.push(argv.join(' ')); return { status: 0 }; },
    now: () => AT,
    onCommandRecorded: () => { if (attempted.length === 1) throw new Error('simulated interruption'); },
  }), /simulated interruption/u);
  const beforeNoop = loadState(cwd);
  const eventPath = join(stateDirectory(cwd, state.prNumber), 'events.ndjson');
  const eventsBeforeNoop = readFileSync(eventPath, 'utf8');
  const noOp = checkpointGitMetadata({ cwd, backup: true });
  assert.equal(noOp.checkpointed, false);
  assert.deepEqual(noOp.state, beforeNoop);
  assert.equal(readFileSync(eventPath, 'utf8'), eventsBeforeNoop);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDirectory(cwd, state.prNumber), 'state.backup.json'), 'utf8')), beforeNoop);
  let proofCheckpointHeldLock = false;
  const resumed = executeTargetedValidationPlan({
    cwd,
    runCommand: (argv) => { attempted.push(argv.join(' ')); return { status: 0 }; },
    now: () => AT,
    onProofCheckpointed: () => {
      proofCheckpointHeldLock = existsSync(join(reviewRoot(cwd), 'locks', 'pr-17.state-lock.sqlite'));
    },
  });
  assert.deepEqual(attempted, ['npm run check:api', 'npm run check:shared', 'npm run check:web']);
  assert.equal(resumed.state.validationStatus.status, 'passed');
  assert.equal(resumed.state.validationStatus.headSha, state.currentIntegrationHeadSha);
  assert.equal(proofCheckpointHeldLock, true);
  assert.match(renderRecoverySummary({ cwd }), /Targeted validation plan: .*completed; pending 0, passed 3, failed 0; recorded proof passed/u);
});

test('targeted validation records concise failure and generic checkpoint cannot forge passing proof', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  state = bindPackets(cwd, state, [packet]);
  buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  const result = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 7 }), now: () => AT });
  assert.equal(result.state.validationStatus.status, 'failed');
  assert.deepEqual(result.plan.commands.map((entry) => entry.summary), ['Failed with exit code 7.']);
  const forged = {
    ...result.state,
    validationStatus: { ...result.state.validationStatus, status: 'passed' },
  };
  assert.throws(
    () => checkpointState({ cwd, nextState: forged, expectedRevision: result.state.revision }),
    { code: 'IMMUTABLE_STATE_PROVENANCE' },
  );
  assert.throws(
    () => buildTargetedValidationPlan({ cwd, taskPackets: [packet] }),
    { code: 'VALIDATION_PLAN_REPLACE_REQUIRED' },
  );
  const replacement = buildTargetedValidationPlan({
    cwd, replace: true, taskPackets: [packet], now: () => AT,
  });
  assert.ok(replacement.commands.every((entry) => entry.status === 'pending'));
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');
  const retried = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT });
  assert.equal(retried.state.validationStatus.status, 'passed');
});

test('replacing a same-head passed plan closes the review gate until the replacement runs', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  state = bindPackets(cwd, state, [packet]);
  buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  const passed = executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }), now: () => AT }).state;
  assert.equal(passed.validationStatus.status, 'passed');
  const replacement = buildTargetedValidationPlan({ cwd, taskPackets: [packet], replace: true, now: () => AT });
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');
  assert.equal(replacement.stateRevision, loadState(cwd).revision);
});

test('execution refuses changed task coverage before invoking a command', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  state = bindPackets(cwd, state, [packet]);
  buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  checkpointTaskCompletion({
    cwd, expectedRevision: state.revision,
    threadResolutionStatus: { status: 'not-run', headSha: null, threads: [], threadlessVerification: emptyThreadless(), updatedAt: null },
  });
  let invoked = false;
  assert.throws(() => executeTargetedValidationPlan({ cwd, runCommand: () => { invoked = true; return { status: 0 }; } }), {
    code: 'INVALID_VALIDATION_PLAN',
  });
  assert.equal(invoked, false);
});

test('targeted validation rejects incomplete coverage, dirty worktrees, and head drift', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a', 'task-b']);
  const packetA = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  const packetB = taskPacket(state.currentIntegrationHeadSha, 'task-b');
  state = bindPackets(cwd, state, [packetA, packetB]);
  assert.throws(
    () => buildTargetedValidationPlan({ cwd, taskPackets: [packetA] }),
    { code: 'VALIDATION_TASK_COVERAGE_MISMATCH' },
  );
  buildTargetedValidationPlan({ cwd, taskPackets: [packetA, packetB], now: () => AT });
  commit(cwd, { 'head-drift.txt': 'drift\n' }, 'head drift');
  assert.throws(() => executeTargetedValidationPlan({ cwd, runCommand: () => ({ status: 0 }) }), {
    code: 'VALIDATION_PLAN_STALE',
  });

  checkpointGitMetadata({ cwd });
  writeFileSync(join(cwd, 'dirty.txt'), 'dirty\n');
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packetA, packetB] }), {
    code: 'VALIDATION_CHECKOUT_DIRTY',
  });
});
