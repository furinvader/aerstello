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

test('dependent worker result accepts its commit-local delta and integrates it exactly', () => {
  const cwd = repo();
  const { packet, result, workerSha, centralSha, advanced } = dependentWorkerAcceptanceFixture(cwd);
  assert.notEqual(workerSha, centralSha);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', workerSha, centralSha], { cwd }).status, 1);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', centralSha, workerSha], { cwd }).status, 1);

  const staleSnapshot = durableAcceptanceSnapshot(cwd, packet.taskId);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision - 1,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), staleSnapshot);

  const eventPath = join(stateDirectory(cwd, 17), 'events.ndjson');
  const priorEventCount = readFileSync(eventPath, 'utf8').trim().split('\n').length;
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision,
  });
  assert.equal(accepted.revision, advanced.revision + 1);
  assert.equal(accepted.tasks.find((item) => item.id === packet.taskId).status, 'implemented');
  const envelope = JSON.parse(readFileSync(workerResultEnvelopePath(cwd, 17, packet.taskId), 'utf8'));
  const receipt = readFileSync(workerResultReceiptPath(cwd, 17, packet.taskId), 'utf8').trim();
  assert.deepEqual(envelope.result, result);
  assert.equal(envelope.packetDigest, taskPacketDigest(packet));
  assert.equal(envelope.resultDigest, accepted.tasks.find((item) => item.id === packet.taskId).workerResultDigest);
  assert.match(receipt, /^[0-9a-f]{64}$/u);
  assert.equal(readFileSync(eventPath, 'utf8').trim().split('\n').length, priorEventCount + 1);
  assert.equal(reconcileState({ cwd }).workerResults.find((entry) => entry.taskId === packet.taskId).status, 'valid');

  const acceptedSnapshot = durableAcceptanceSnapshot(cwd, packet.taskId);
  assert.equal(checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: accepted.revision,
  }).revision, accepted.revision);
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), acceptedSnapshot);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result: { ...result, resolutionSummary: 'Altered result evidence.' },
    expectedRevision: accepted.revision,
  }), { code: 'WORKER_RESULT_CONFLICT' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), acceptedSnapshot);

  git(cwd, ['cherry-pick', workerSha]);
  const integratedCommitSha = git(cwd, ['rev-parse', 'HEAD']);
  const advancedAfterPick = checkpointGitMetadata({ cwd }).state;
  const integrated = checkpointState({
    cwd, expectedRevision: advancedAfterPick.revision,
    nextState: {
      ...advancedAfterPick,
      tasks: advancedAfterPick.tasks.map((item) => {
        if (item.id !== packet.taskId) return item;
        const { execution: _execution, ...withoutExecution } = item;
        return {
          ...withoutExecution, status: 'integrated', integratedCommitSha,
          resolutionSummary: 'Integrated exact accepted worker patch.',
        };
      }),
    },
  });
  assert.equal(integrated.tasks.find((item) => item.id === packet.taskId).integratedCommitSha, integratedCommitSha);
});

test('actionable integration requires an ancestral central commit with the accepted exact delta', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result,
    expectedRevision: fixture.advanced.revision,
  });
  const tree = git(cwd, ['rev-parse', `${fixture.centralSha}^{tree}`]);
  const unrelatedSha = git(cwd, [
    'commit-tree', tree, '-p', fixture.centralSha, '-m', 'unrelated integration candidate',
  ]);
  const integrationState = (integratedCommitSha) => ({
    ...accepted,
    tasks: accepted.tasks.map((item) => {
      if (item.id !== fixture.packet.taskId) return item;
      const { execution: _execution, ...withoutExecution } = item;
      return {
        ...withoutExecution, status: 'integrated', integratedCommitSha,
        resolutionSummary: 'Attempted central integration.',
      };
    }),
  });
  for (const integratedCommitSha of ['f'.repeat(40), unrelatedSha]) {
    const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
    assert.throws(() => checkpointState({
      cwd, expectedRevision: accepted.revision,
      nextState: integrationState(integratedCommitSha),
    }), { code: 'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH' });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
  }
  const beforeMismatch = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: integrationState(fixture.centralSha),
  }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), beforeMismatch);
});

test('an older matching apply followed by a revert cannot claim a later worker result', () => {
  const cwd = repo();
  const changedPath = 'scripts/replayed-delta.mjs';
  commit(cwd, { [changedPath]: 'export const value = 0;\n' }, 'add replay base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'replayed-central-delta', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);
  const oldApplySha = commit(cwd, { [changedPath]: 'export const value = 1;\n' }, 'old matching apply');
  commit(cwd, { [changedPath]: 'export const value = 0;\n' }, 'revert old matching apply');
  const workerParentSha = commit(cwd, {
    'scripts/later-worker-parent.mjs': 'export const laterParent = true;\n',
  }, 'advance to later worker parent');
  git(cwd, ['switch', '-c', 'replayed-central-worker', workerParentSha]);
  const workerSha = commit(cwd, { [changedPath]: 'export const value = 1;\n' }, 'apply later worker delta');
  git(cwd, ['switch', 'main']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const result = workerResult(packet, workerSha, [changedPath]);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision,
  });
  const { execution: _execution, ...implementedTask } = accepted.tasks[0];
  const nextState = {
    ...accepted,
    tasks: [{
      ...implementedTask, status: 'integrated', integratedCommitSha: oldApplySha,
      resolutionSummary: 'Attempted to claim an older matching application.',
    }],
  };
  assert.equal(spawnSync('git', [
    'merge-base', '--is-ancestor', oldApplySha, workerParentSha,
  ], { cwd }).status, 0, 'the older apply remains on the current integration history');
  assert.equal(spawnSync('git', [
    'merge-base', '--is-ancestor', workerParentSha, `${oldApplySha}^`,
  ], { cwd }).status, 1, 'the older apply parent predates the worker parent');
  const durableBefore = durableAcceptanceSnapshot(cwd, packet.taskId);
  const repositoryBefore = repositoryAuthoritySnapshot(cwd);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision, nextState,
  }), { code: 'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), durableBefore);
  assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
});

test('exact integration accepts a same-file cherry-pick over nonoverlapping central history', () => {
  const cwd = repo();
  const changedPath = 'scripts/same-file-history.mjs';
  commit(cwd, {
    [changedPath]: [
      'export const centralValue = 0;',
      'export const spacerA = true;',
      'export const spacerB = true;',
      'export const workerValue = 0;',
      '',
    ].join('\n'),
  }, 'add same-file history base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'same-file-nonoverlap', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'same-file-worker']);
  const workerSha = commit(cwd, {
    [changedPath]: [
      'export const centralValue = 0;',
      'export const spacerA = true;',
      'export const spacerB = true;',
      'export const workerValue = 1;',
      '',
    ].join('\n'),
  }, 'change lower worker line');
  git(cwd, ['switch', 'main']);
  const centralParentSha = commit(cwd, {
    [changedPath]: [
      'export const centralValue = 1;',
      'export const spacerA = true;',
      'export const spacerB = true;',
      'export const workerValue = 0;',
      '',
    ].join('\n'),
  }, 'change upper central line');
  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  assert.notEqual(
    git(cwd, ['rev-parse', `${packet.reviewedHeadSha}:${changedPath}`]),
    git(cwd, ['rev-parse', `${centralParentSha}:${changedPath}`]),
    'the central parent has a different whole-file base blob',
  );
  assert.notEqual(
    git(cwd, ['rev-parse', `${workerSha}:${changedPath}`]),
    git(cwd, ['rev-parse', `${centralSha}:${changedPath}`]),
    'the exact cherry-pick has a different whole-file result blob',
  );
  const advanced = checkpointGitMetadata({ cwd }).state;
  const inspectExact = () => inspectWorkerCommitAuthority({
    cwd, state: advanced, packet,
    result: workerResult(packet, workerSha, [changedPath]),
    centralCommitSha: centralSha,
  });
  const baselineIdentity = inspectExact().deltaIdentity;
  git(cwd, ['config', 'diff.context', '0']);
  git(cwd, ['config', 'diff.interHunkContext', '99']);
  git(cwd, ['config', 'diff.mnemonicPrefix', 'true']);
  git(cwd, ['config', 'diff.noprefix', 'true']);
  git(cwd, ['config', 'color.ui', 'always']);
  assert.equal(inspectExact().deltaIdentity, baselineIdentity);
  const accepted = checkpointWorkerResultAcceptance({
    cwd,
    packet,
    result: workerResult(packet, workerSha, [changedPath]),
    expectedRevision: advanced.revision,
  });
  const { execution: _execution, ...implementedTask } = accepted.tasks[0];
  const repositoryBefore = repositoryAuthoritySnapshot(cwd);
  const integrated = checkpointState({
    cwd,
    expectedRevision: accepted.revision,
    nextState: {
      ...accepted,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
        resolutionSummary: 'Integrated exact same-file nonoverlapping cherry-pick.',
      }],
    },
  });
  assert.equal(integrated.tasks[0].integratedCommitSha, centralSha);
  assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
});

test('exact integration fails closed when the isolated three-way application conflicts', () => {
  const cwd = repo();
  const changedPath = 'scripts/three-way-conflict.mjs';
  commit(cwd, { [changedPath]: 'export const conflictValue = 0;\n' }, 'add three-way conflict base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'three-way-conflict', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'three-way-conflict-worker']);
  const workerSha = commit(cwd, {
    [changedPath]: 'export const conflictValue=0;\n',
  }, 'three-way conflict worker');
  git(cwd, ['switch', 'main']);
  const centralParentSha = commit(cwd, {
    [changedPath]: 'export  const conflictValue = 0;\n',
  }, 'overlapping central parent');
  const centralSha = commit(cwd, {
    [changedPath]: 'export const conflictValue=0;\n',
  }, 'manual whitespace conflict resolution');
  assert.equal(git(cwd, ['rev-parse', `${centralSha}^`]), centralParentSha);
  const advanced = checkpointGitMetadata({ cwd }).state;
  git(cwd, ['config', 'apply.ignoreWhitespace', 'change']);
  git(cwd, ['config', 'apply.whitespace', 'fix']);
  const result = workerResult(packet, workerSha, [changedPath]);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision,
  });
  const { execution: _execution, ...implementedTask } = accepted.tasks[0];
  const durableBefore = durableAcceptanceSnapshot(cwd, packet.taskId);
  const repositoryBefore = repositoryAuthoritySnapshot(cwd);
  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: accepted.revision,
    nextState: {
      ...accepted,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
        resolutionSummary: 'Attempted integration after an overlapping central edit.',
      }],
    },
  }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), durableBefore);
  assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
});

test('exact integration ignores repository attributes and custom merge drivers without mutation', () => {
  const cwd = repo();
  const changedPath = 'scripts/custom-merge-driver.txt';
  commit(cwd, {
    '.gitattributes': `${changedPath} merge=keepours\n`,
    [changedPath]: 'value=base\n',
  }, 'add custom merge driver base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'custom-merge-driver', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);

  git(cwd, ['switch', '-c', 'custom-merge-driver-worker']);
  const workerSha = commit(cwd, { [changedPath]: 'value=worker\n' }, 'custom driver worker value');
  git(cwd, ['switch', 'main']);
  const centralParentSha = commit(cwd, {
    [changedPath]: 'value=central\n',
  }, 'custom driver central value');
  git(cwd, ['commit', '--allow-empty', '-m', 'omit custom driver worker value']);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  assert.equal(git(cwd, ['rev-parse', `${centralSha}^`]), centralParentSha);
  const advanced = checkpointGitMetadata({ cwd }).state;

  const sentinelPath = join(cwd, 'custom-merge-driver-sentinel');
  const customDriver = `printf custom-driver-ran > ${sentinelPath}`;
  git(cwd, ['config', 'merge.keepours.driver', customDriver]);
  const gitDirectory = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const repositoryConfigPath = join(gitDirectory, 'config');
  const inheritedConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  assert.ok(Number.isSafeInteger(inheritedConfigCount) && inheritedConfigCount >= 0);
  const environmentKeys = [
    'GIT_CONFIG_COUNT',
    `GIT_CONFIG_KEY_${inheritedConfigCount}`,
    `GIT_CONFIG_VALUE_${inheritedConfigCount}`,
  ];
  const inheritedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = String(inheritedConfigCount + 1);
  process.env[`GIT_CONFIG_KEY_${inheritedConfigCount}`] = 'merge.text.driver';
  process.env[`GIT_CONFIG_VALUE_${inheritedConfigCount}`] = customDriver;
  try {
    assert.equal(
      git(cwd, ['check-attr', 'merge', '--', changedPath]),
      `${changedPath}: merge: keepours`,
    );
    assert.equal(git(cwd, ['config', 'merge.keepours.driver']), customDriver);
    assert.equal(existsSync(sentinelPath), false);

    const result = workerResult(packet, workerSha, [changedPath]);
    const accepted = checkpointWorkerResultAcceptance({
      cwd, packet, result, expectedRevision: advanced.revision,
    });
    const { execution: _execution, ...implementedTask } = accepted.tasks[0];
    const durableBefore = durableAcceptanceSnapshot(cwd, packet.taskId);
    const repositoryBefore = repositoryAuthoritySnapshot(cwd);
    const repositoryConfigBefore = readFileSync(repositoryConfigPath);
    assert.throws(() => checkpointState({
      cwd,
      expectedRevision: accepted.revision,
      nextState: {
        ...accepted,
        tasks: [{
          ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
          resolutionSummary: 'Attempted integration through a custom keep-ours merge driver.',
        }],
      },
    }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
    assert.equal(existsSync(sentinelPath), false, 'custom merge drivers must never execute');
    assert.deepEqual(readFileSync(repositoryConfigPath), repositoryConfigBefore);
    assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), durableBefore);
    assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
  } finally {
    for (const [key, value] of inheritedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('worker authority rejects reviewed, root, merge, and absent-parent tips before durable mutation', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'single-worker-commit', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(cwd, proposed, packet);
  const reviewedHead = packet.reviewedHeadSha;

  const rootTree = git(cwd, ['rev-parse', `${reviewedHead}^{tree}`]);
  const rootSha = git(cwd, ['commit-tree', rootTree, '-m', 'root worker result']);
  git(cwd, ['switch', '-c', 'merge-worker-left', reviewedHead]);
  const leftSha = commit(cwd, { 'scripts/merge-left.mjs': 'export const left = true;\n' }, 'merge left');
  git(cwd, ['switch', '-c', 'merge-worker-right', reviewedHead]);
  const rightSha = commit(cwd, { 'scripts/merge-right.mjs': 'export const right = true;\n' }, 'merge right');
  const mergeTree = git(cwd, ['rev-parse', `${rightSha}^{tree}`]);
  const mergeSha = git(cwd, [
    'commit-tree', mergeTree, '-p', leftSha, '-p', rightSha, '-m', 'merge worker result',
  ]);
  git(cwd, ['switch', '-c', 'two-commit-worker', reviewedHead]);
  commit(cwd, { 'scripts/worker-first.mjs': 'export const first = true;\n' }, 'worker first commit');
  const twoCommitSha = commit(cwd, {
    'scripts/worker-second.mjs': 'export const second = true;\n',
  }, 'worker second commit');
  git(cwd, ['switch', 'main']);

  const scenarios = [
    { sha: reviewedHead, paths: ['scripts/reviewed-head.mjs'], code: 'WORKER_RESULT_COMMIT_NOT_SINGLE' },
    { sha: rootSha, paths: ['scripts/root.mjs'], code: 'WORKER_RESULT_COMMIT_NOT_SINGLE' },
    { sha: mergeSha, paths: ['scripts/merge-right.mjs'], code: 'WORKER_RESULT_COMMIT_NOT_SINGLE' },
    {
      sha: twoCommitSha, paths: ['scripts/worker-second.mjs'],
      code: 'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH',
    },
  ];
  for (const scenario of scenarios) {
    const result = workerResult(packet, scenario.sha, scenario.paths);
    const before = durableAcceptanceSnapshot(cwd, packet.taskId);
    assert.throws(() => checkpointWorkerResultAcceptance({
      cwd, packet, result, expectedRevision: bound.revision,
    }), { code: scenario.code });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), before);
  }

  const packetPath = join(stateDirectory(cwd, bound.prNumber), 'single-worker-packet.json');
  const resultPath = join(stateDirectory(cwd, bound.prNumber), 'single-worker-result.json');
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);
  writeFileSync(resultPath, `${JSON.stringify(workerResult(
    packet, twoCommitSha, ['scripts/worker-second.mjs'],
  ))}\n`);
  const cli = spawnSync(process.execPath, [
    STATE_CLI, 'validate-result', '--pr', '17', '--task-packet', packetPath, '--worker-result', resultPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /WORKER_RESULT_PARENT_ANCESTRY_MISMATCH/u);
});

test('worker authority ignores replacement refs and compares actual commit objects atomically', () => {
  const cwd = repo();
  const changedPath = 'scripts/replacement-authority.mjs';
  commit(cwd, { [changedPath]: 'export const actualValue = 0;\n' }, 'add replacement authority base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'replacement-object-authority', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'replacement-authority-worker']);
  const workerSha = commit(cwd, {
    [changedPath]: 'export const actualValue = 1;\n',
  }, 'replacement authority worker');
  git(cwd, ['switch', '-c', 'replacement-authority-forged-parent', packet.reviewedHeadSha]);
  const forgedParentSha = commit(cwd, {
    'scripts/replacement-forged-parent.mjs': 'export const forgedParent = true;\n',
  }, 'replacement authority forged parent');
  git(cwd, ['cherry-pick', workerSha]);
  const forgedCentralSha = git(cwd, ['rev-parse', 'HEAD']);
  const forgedTree = git(cwd, ['rev-parse', `${forgedCentralSha}^{tree}`]);
  git(cwd, ['switch', 'main']);
  const centralSha = commit(cwd, {
    [changedPath]: 'export const actualValue = 2;\n',
  }, 'actual mismatched central commit');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const result = workerResult(packet, workerSha, [changedPath]);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision,
  });
  git(cwd, ['replace', centralSha, forgedCentralSha]);
  assert.equal(
    git(cwd, ['rev-parse', `${centralSha}^`]),
    forgedParentSha,
    'ordinary Git reads the forged replacement parent',
  );
  assert.equal(
    git(cwd, ['--no-replace-objects', 'rev-parse', `${centralSha}^`]),
    packet.reviewedHeadSha,
    'the actual central object retains its real parent',
  );
  assert.equal(
    git(cwd, ['rev-parse', `${centralSha}^{tree}`]),
    forgedTree,
    'ordinary Git reads the forged replacement tree',
  );
  assert.notEqual(
    git(cwd, ['--no-replace-objects', 'rev-parse', `${centralSha}^{tree}`]),
    forgedTree,
    'the actual central object retains its mismatched tree',
  );
  const { execution: _execution, ...implementedTask } = accepted.tasks[0];
  const nextState = {
    ...accepted,
    tasks: [{
      ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
      resolutionSummary: 'Attempted integration through a replacement object.',
    }],
  };
  const durableBefore = durableAcceptanceSnapshot(cwd, packet.taskId);
  const repositoryBefore = repositoryAuthoritySnapshot(cwd);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision, nextState,
  }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), durableBefore);
  assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
});

test('worker authority rejects common-dir grafts in linked worktrees without durable mutation', () => {
  const cwd = repo();
  const integrationCwd = `${cwd}-linked-worker-authority`;
  git(cwd, ['worktree', 'add', '--detach', integrationCwd, 'HEAD']);
  repositories.push(integrationCwd);
  const initial = init(integrationCwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'legacy-graft-authority', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd: integrationCwd,
    expectedRevision: initial.revision,
    nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(integrationCwd, proposed, packet);

  git(integrationCwd, ['switch', '-c', 'legacy-grafts-valid-worker']);
  const validWorkerSha = commit(integrationCwd, {
    'scripts/legacy-grafts-valid.mjs': 'export const validWorker = true;\n',
  }, 'add valid worker commit');
  git(integrationCwd, ['switch', '--detach', packet.reviewedHeadSha]);
  const validResult = workerResult(packet, validWorkerSha, ['scripts/legacy-grafts-valid.mjs']);
  const commonGitDirectory = git(integrationCwd, [
    '--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]);
  assert.equal(commonGitDirectory, join(cwd, '.git'));
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  assert.equal(existsSync(graftsPath), false);
  assert.doesNotThrow(() => inspectWorkerCommitAuthority({
    cwd: integrationCwd, state: bound, packet, result: validResult,
  }));
  mkdirSync(dirname(graftsPath), { recursive: true });
  writeFileSync(graftsPath, '');
  assert.doesNotThrow(() => inspectWorkerCommitAuthority({
    cwd: integrationCwd, state: bound, packet, result: validResult,
  }));

  git(integrationCwd, ['switch', '-c', 'legacy-grafts-forged-worker', packet.reviewedHeadSha]);
  git(integrationCwd, ['commit', '--allow-empty', '-m', 'hide an extra worker commit']);
  const hiddenParentSha = git(integrationCwd, ['rev-parse', 'HEAD']);
  const forgedWorkerSha = commit(integrationCwd, {
    'scripts/legacy-grafts-forged.mjs': 'export const forgedWorker = true;\n',
  }, 'add forged worker tip');
  git(integrationCwd, ['switch', '--detach', packet.reviewedHeadSha]);
  assert.equal(
    git(integrationCwd, ['--no-replace-objects', 'rev-list', '--parents', '-n', '1', forgedWorkerSha]),
    `${forgedWorkerSha} ${hiddenParentSha}`,
  );
  assert.equal(spawnSync('git', [
    '--no-replace-objects', 'merge-base', '--is-ancestor', hiddenParentSha,
    bound.currentIntegrationHeadSha,
  ], { cwd: integrationCwd }).status, 1);

  writeFileSync(graftsPath, `${forgedWorkerSha} ${packet.reviewedHeadSha}\n`);
  assert.equal(
    git(integrationCwd, ['--no-replace-objects', 'rev-list', '--parents', '-n', '1', forgedWorkerSha]),
    `${forgedWorkerSha} ${packet.reviewedHeadSha}`,
    'Git 2.34-compatible authority reads honor the forged common-dir graft',
  );
  assert.equal(spawnSync('git', [
    '--no-replace-objects', 'merge-base', '--is-ancestor', packet.reviewedHeadSha, forgedWorkerSha,
  ], { cwd: integrationCwd }).status, 0, 'the graft forges worker ancestry despite --no-replace-objects');

  const forgedResult = workerResult(packet, forgedWorkerSha, ['scripts/legacy-grafts-forged.mjs']);
  const durableBefore = durableAcceptanceSnapshot(integrationCwd, packet.taskId);
  const repositoryBefore = repositoryAuthoritySnapshot(integrationCwd);
  const graftsBefore = readFileSync(graftsPath, 'utf8');
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd: integrationCwd, packet, result: forgedResult, expectedRevision: bound.revision,
  }), { code: 'WORKER_RESULT_LEGACY_GRAFTS_PRESENT' });
  assert.deepEqual(durableAcceptanceSnapshot(integrationCwd, packet.taskId), durableBefore);
  assert.deepEqual(repositoryAuthoritySnapshot(integrationCwd), repositoryBefore);
  assert.equal(readFileSync(graftsPath, 'utf8'), graftsBefore);
});

test('worker authority cannot omit gitlink paths or pointers through diff configuration', () => {
  const cwd = repo();
  const targetTree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
  const baseGitlinkSha = git(cwd, ['commit-tree', targetTree, '-m', 'base gitlink target']);
  const workerGitlinkSha = git(cwd, [
    'commit-tree', targetTree, '-p', baseGitlinkSha, '-m', 'worker gitlink target',
  ]);
  const gitlinkPath = 'scripts/worker-authority-gitlink';
  const regularPath = 'scripts/gitlink-authority.mjs';
  git(cwd, [
    'update-index', '--add', '--cacheinfo', `160000,${baseGitlinkSha},${gitlinkPath}`,
  ]);
  git(cwd, ['commit', '-m', 'add worker authority gitlink base']);

  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'gitlink-diff-authority', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  bindPacket(cwd, proposed, packet);

  git(cwd, ['switch', '-c', 'gitlink-diff-worker']);
  mkdirSync(dirname(join(cwd, regularPath)), { recursive: true });
  writeFileSync(join(cwd, regularPath), 'export const gitlinkAuthority = true;\n');
  git(cwd, ['add', '--', regularPath]);
  git(cwd, ['update-index', '--cacheinfo', `160000,${workerGitlinkSha},${gitlinkPath}`]);
  git(cwd, ['commit', '-m', 'change worker file and gitlink']);
  const workerSha = git(cwd, ['rev-parse', 'HEAD']);

  git(cwd, ['switch', 'main']);
  mkdirSync(dirname(join(cwd, regularPath)), { recursive: true });
  writeFileSync(join(cwd, regularPath), 'export const gitlinkAuthority = true;\n');
  git(cwd, ['add', '--', regularPath]);
  git(cwd, ['commit', '-m', 'integrate worker file without gitlink']);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;

  const inheritedConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  assert.ok(Number.isSafeInteger(inheritedConfigCount) && inheritedConfigCount >= 0);
  const environmentKeys = [
    'GIT_CONFIG_COUNT',
    `GIT_CONFIG_KEY_${inheritedConfigCount}`,
    `GIT_CONFIG_VALUE_${inheritedConfigCount}`,
    `GIT_CONFIG_KEY_${inheritedConfigCount + 1}`,
    `GIT_CONFIG_VALUE_${inheritedConfigCount + 1}`,
  ];
  const inheritedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = String(inheritedConfigCount + 2);
  process.env[`GIT_CONFIG_KEY_${inheritedConfigCount}`] = 'diff.ignoreSubmodules';
  process.env[`GIT_CONFIG_VALUE_${inheritedConfigCount}`] = 'all';
  process.env[`GIT_CONFIG_KEY_${inheritedConfigCount + 1}`] = 'diff.submodule';
  process.env[`GIT_CONFIG_VALUE_${inheritedConfigCount + 1}`] = 'log';
  try {
    const configuredPaths = git(cwd, [
      '--no-replace-objects', 'diff', '--name-only', '--no-renames',
      packet.reviewedHeadSha, workerSha, '--',
    ]).split('\n').filter(Boolean);
    assert.deepEqual(configuredPaths, [regularPath], 'inherited diff configuration hides the gitlink path');
    const authorityPatchArgs = (submoduleFormat = []) => [
      '--no-replace-objects', '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false',
      'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', ...submoduleFormat, '--no-color',
      '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0',
      packet.reviewedHeadSha, workerSha, '--',
    ];
    const inheritedLogPatch = git(cwd, authorityPatchArgs());
    assert.ok(inheritedLogPatch.includes(`Submodule ${gitlinkPath} `),
      'inherited diff.submodule=log replaces the applyable gitlink delta with a log summary');
    const forcedShortPatch = git(cwd, authorityPatchArgs(['--submodule=short']));
    assert.ok(forcedShortPatch.includes(`-Subproject commit ${baseGitlinkSha}`));
    assert.ok(forcedShortPatch.includes(`+Subproject commit ${workerGitlinkSha}`));
    assert.equal(git(cwd, ['rev-parse', `${workerSha}:${gitlinkPath}`]), workerGitlinkSha);
    assert.equal(git(cwd, ['rev-parse', `${centralSha}:${gitlinkPath}`]), baseGitlinkSha);

    const result = workerResult(packet, workerSha, [regularPath, gitlinkPath]);
    const authority = inspectWorkerCommitAuthority({ cwd, state: advanced, packet, result });
    assert.deepEqual([...authority.changedPaths].sort(), [gitlinkPath, regularPath].sort());
    const accepted = checkpointWorkerResultAcceptance({
      cwd, packet, result, expectedRevision: advanced.revision,
    });
    const { execution: _execution, ...implementedTask } = accepted.tasks[0];
    const durableBefore = durableAcceptanceSnapshot(cwd, packet.taskId);
    const repositoryBefore = repositoryAuthoritySnapshot(cwd);
    assert.throws(() => checkpointState({
      cwd,
      expectedRevision: accepted.revision,
      nextState: {
        ...accepted,
        tasks: [{
          ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
          resolutionSummary: 'Attempted integration without the accepted gitlink pointer.',
        }],
      },
    }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), durableBefore);
    assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
  } finally {
    for (const [key, value] of inheritedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('exact delta identity rejects patch-id whitespace collisions and preserves state', () => {
  const cwd = repo();
  commit(cwd, { 'scripts/collision.mjs': 'export const base = true;\n' }, 'add collision base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'whitespace-collision', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'whitespace-worker']);
  const workerSha = commit(cwd, {
    'scripts/collision.mjs': 'export const base = true;\nexport const value = 1;\n',
  }, 'worker whitespace form');
  git(cwd, ['switch', 'main']);
  const centralSha = commit(cwd, {
    'scripts/collision.mjs': 'export const base = true;\nexport const value=1;\n',
  }, 'central whitespace form');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const patchId = (sha) => {
    const shown = spawnSync('git', ['show', '--format=', '--no-renames', sha], { cwd, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr);
    const identified = spawnSync('git', ['patch-id', '--stable'], {
      cwd, input: shown.stdout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(identified.status, 0, identified.stderr);
    return identified.stdout.trim().split(/\s+/u)[0];
  };
  assert.equal(patchId(workerSha), patchId(centralSha), 'fixture reproduces the stable patch-id collision');
  const result = workerResult(packet, workerSha, ['scripts/collision.mjs']);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: advanced.revision,
  });
  const { execution: _execution, ...implementedTask } = accepted.tasks[0];
  const before = durableAcceptanceSnapshot(cwd, packet.taskId);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: {
      ...accepted,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
        resolutionSummary: 'Attempted whitespace-normalized integration.',
      }],
    },
  }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), before);
});

test('exact integration rejects text, whitespace, path, status, and mode mismatch matrix', () => {
  const cwd = repo();
  const changedPath = 'scripts/exact-matrix.mjs';
  const baseText = 'export const exactValue = 0;\n';
  const workerText = 'export const exactValue = 1;\n';
  commit(cwd, { [changedPath]: baseText }, 'add exact mismatch matrix base');
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'exact-mismatch-matrix', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(cwd, proposed, packet);
  const fromBase = (branch) => git(cwd, ['switch', '-C', branch, packet.reviewedHeadSha]);

  fromBase('exact-matrix-worker');
  const workerSha = commit(cwd, { [changedPath]: workerText }, 'exact matrix worker');
  fromBase('exact-matrix-match');
  const exactSha = commit(cwd, { [changedPath]: workerText }, 'exact matrix match');
  fromBase('exact-matrix-text');
  const textMismatchSha = commit(cwd, {
    [changedPath]: 'export const exactValue = 2;\n',
  }, 'exact matrix text mismatch');
  fromBase('exact-matrix-whitespace');
  const whitespaceMismatchSha = commit(cwd, {
    [changedPath]: 'export const exactValue=1;\n',
  }, 'exact matrix whitespace mismatch');
  fromBase('exact-matrix-path');
  const pathMismatchSha = commit(cwd, {
    'scripts/exact-matrix-other.mjs': workerText,
  }, 'exact matrix path mismatch');
  fromBase('exact-matrix-status');
  rmSync(join(cwd, changedPath));
  git(cwd, ['add', '--all', '--', changedPath]);
  git(cwd, ['commit', '-m', 'exact matrix status mismatch']);
  const statusMismatchSha = git(cwd, ['rev-parse', 'HEAD']);
  fromBase('exact-matrix-mode');
  writeFileSync(join(cwd, changedPath), workerText);
  chmodSync(join(cwd, changedPath), 0o755);
  git(cwd, ['add', '--', changedPath]);
  git(cwd, ['commit', '-m', 'exact matrix mode mismatch']);
  const modeMismatchSha = git(cwd, ['rev-parse', 'HEAD']);

  const result = workerResult(packet, workerSha, [changedPath]);
  const inspect = (centralCommitSha) => inspectWorkerCommitAuthority({
    cwd,
    state: { ...bound, currentIntegrationHeadSha: centralCommitSha },
    packet,
    result,
    centralCommitSha,
  });
  const repositoryBefore = repositoryAuthoritySnapshot(cwd);
  assert.doesNotThrow(() => inspect(exactSha));
  for (const centralCommitSha of [
    textMismatchSha,
    whitespaceMismatchSha,
    pathMismatchSha,
    statusMismatchSha,
    modeMismatchSha,
  ]) {
    assert.throws(() => inspect(centralCommitSha), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  }
  assert.deepEqual(repositoryAuthoritySnapshot(cwd), repositoryBefore);
});

test('exact delta identity covers binary bytes and executable modes', () => {
  const cwd = repo();
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'payload.bin'), Buffer.from([0, 1]));
  writeFileSync(join(cwd, 'scripts', 'tool.sh'), '#!/bin/sh\nexit 0\n');
  git(cwd, ['add', 'scripts/payload.bin', 'scripts/tool.sh']);
  git(cwd, ['commit', '-m', 'add delta identity base']);
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'binary-mode-delta', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(cwd, proposed, packet);
  const makeDeltaCommit = (branch, bytes, executable) => {
    git(cwd, ['switch', '-c', branch, packet.reviewedHeadSha]);
    writeFileSync(join(cwd, 'scripts', 'payload.bin'), Buffer.from(bytes));
    chmodSync(join(cwd, 'scripts', 'tool.sh'), executable ? 0o755 : 0o644);
    git(cwd, ['add', 'scripts/payload.bin', 'scripts/tool.sh']);
    git(cwd, ['commit', '-m', branch]);
    return git(cwd, ['rev-parse', 'HEAD']);
  };
  const workerSha = makeDeltaCommit('binary-mode-worker', [0, 1, 2], true);
  const exactSha = makeDeltaCommit('binary-mode-exact', [0, 1, 2], true);
  const binaryMismatchSha = makeDeltaCommit('binary-mode-content-mismatch', [0, 1, 3], true);
  const modeMismatchSha = makeDeltaCommit('binary-mode-mode-mismatch', [0, 1, 2], false);
  const result = workerResult(packet, workerSha, ['scripts/payload.bin', 'scripts/tool.sh']);

  assert.doesNotThrow(() => inspectWorkerCommitAuthority({
    cwd, state: { ...bound, currentIntegrationHeadSha: exactSha }, packet, result,
    centralCommitSha: exactSha,
  }));
  for (const centralCommitSha of [binaryMismatchSha, modeMismatchSha]) {
    assert.throws(() => inspectWorkerCommitAuthority({
      cwd, state: { ...bound, currentIntegrationHeadSha: centralCommitSha }, packet, result,
      centralCommitSha,
    }), { code: 'WORKER_RESULT_EXACT_DELTA_MISMATCH' });
  }
});

test('post-acceptance worker-parent drift blocks final integration without mutation', () => {
  const cwd = repo();
  const { bound, packet, result } = boundWorkerResultFixture(cwd, 'post-acceptance-drift');
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
  });
  const tree = git(cwd, ['rev-parse', `${packet.reviewedHeadSha}^{tree}`]);
  const unrelatedRoot = git(cwd, ['commit-tree', tree, '-m', 'unrelated post-acceptance root']);
  git(cwd, ['switch', '--detach', unrelatedRoot]);
  const drifted = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...implementedTask } = drifted.tasks[0];
  const before = durableAcceptanceSnapshot(cwd, packet.taskId);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: drifted.revision,
    nextState: {
      ...drifted,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: unrelatedRoot,
        resolutionSummary: 'Attempted after worker-parent history drift.',
      }],
    },
  }), { code: 'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, packet.taskId), before);
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'invalid');
});
