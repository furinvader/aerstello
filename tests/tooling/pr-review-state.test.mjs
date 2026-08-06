import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
  checkpointCompletion,
  checkpointCiValidation,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointState,
  checkpointTaskPacketBinding,
  checkpointTaskCompletion,
  checkpointTargetedValidation,
  checkpointVerificationEscalation,
  completionGate,
  completeIntegratedTasks,
  executeTargetedValidationPlan,
  gitAwareGateContext,
  gitCommonDirectory,
  initializeState,
  loadState,
  migratePrReviewStateV1,
  migratePrReviewStateV2,
  migrateState,
  renderRecoverySummary,
  reviewRequestGate,
  reviewRoot,
  stateDirectory,
  statePath,
  StateError,
  taskPacketDigest,
  validationPlanPath,
  withStateLock,
} from '../../scripts/lib/pr-review-state.mjs';
import { commit, createRepository, git } from './git-fixtures.mjs';

const repositories = [];
const AT = '2026-08-05T00:00:00Z';
const STATE_CLI = fileURLToPath(new URL('../../scripts/pr-review-state.mjs', import.meta.url));

function repo() {
  const cwd = createRepository();
  repositories.push(cwd);
  return cwd;
}

function init(cwd, overrides = {}) {
  return initializeState({ cwd, prNumber: 17, base: 'main', head: 'HEAD', releaseRef: 'main', ...overrides });
}

function task(head, overrides = {}) {
  const status = overrides.status ?? 'completed';
  const result = {
    id: 'task-1',
    sourceIds: ['local:audit'],
    sourceType: 'local',
    fingerprint: 'fingerprint-0001',
    summary: 'Resolve the bounded finding.',
    severity: 'P1',
    disposition: 'actionable',
    status,
    integratedCommitSha: ['integrated', 'completed'].includes(status) ? head : null,
    resolutionSummary: ['integrated', 'completed', 'not-applicable'].includes(status) ? 'Resolved and verified.' : null,
    ...overrides,
  };
  if (['proposed', 'queued', 'running', 'implemented', 'blocked', 'failed'].includes(status)) {
    result.execution = {
      dependencies: [], ownedPaths: ['src/example.ts'], worker: 'review_fix_worker', branch: null,
      worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
      ...(overrides.execution ?? {}),
    };
  }
  return result;
}

function emptyThreadless() {
  return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null };
}

function ready(state, tasks = [task(state.currentIntegrationHeadSha)]) {
  const head = state.currentIntegrationHeadSha;
  return {
    ...state,
    phase: 'ready-for-review',
    tasks,
    validationStatus: state.validationStatus.status === 'passed' ? state.validationStatus : {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: head,
      checks: ['npm run check'], updatedAt: AT,
    },
    threadResolutionStatus: {
      status: 'passed', headSha: head, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
    },
    git: { ...state.git, headSha: head, dirty: false },
    blockedReasons: [],
    nextAction: 'Request canonical review.',
  };
}

function checkpointSyntheticTargetedValidation(cwd, state) {
  const taskIds = state.tasks.filter((item) => item.disposition === 'actionable' && item.status === 'integrated')
    .map((item) => item.id).sort();
  const plan = {
    schemaVersion: 1, prNumber: state.prNumber, stateRevision: state.revision,
    headSha: state.currentIntegrationHeadSha, taskIds, affectedAreas: ['workflow'],
    commands: [{
      kind: 'unit', command: 'npm run check:workflow', reason: 'Synthetic focused test proof.', selectors: [], projects: [],
      argv: ['npm', 'run', 'check:workflow'], status: 'passed', exitCode: 0,
      summary: 'Passed.', completedAt: AT,
    }],
    createdAt: AT, updatedAt: AT,
  };
  writeFileSync(validationPlanPath(cwd, state.prNumber), `${JSON.stringify(plan)}\n`);
  return checkpointTargetedValidation({ cwd, expectedRevision: state.revision });
}

function persistReady(cwd, state, tasks = state.tasks) {
  const validated = state.validationStatus.status === 'passed' ? state : checkpointSyntheticTargetedValidation(cwd, state);
  return checkpointState({ cwd, nextState: ready(validated, tasks), expectedRevision: validated.revision });
}

function external(cwd, state, overrides = {}) {
  return gitAwareGateContext(state, {
    pushedHeadSha: state.currentIntegrationHeadSha,
    prHeadSha: state.currentIntegrationHeadSha,
    ...overrides,
  });
}

function request(state, id = `request-${state.reviewRound + 1}`, kind = state.reviewRound < 3 ? 'discovery' : 'verification') {
  return {
    id, databaseId: 101, url: `https://github.com/example/sky-bar/pull/17#issuecomment-${id}`,
    headSha: state.currentIntegrationHeadSha, at: AT, kind, body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'MDQ6VXNlcjE=',
  };
}

function outcome(state, overrides = {}) {
  return {
    id: `outcome-${state.reviewRequest.id}`, databaseId: 201,
    url: 'https://github.com/example/sky-bar/pull/17#pullrequestreview-201',
    headSha: state.currentIntegrationHeadSha, at: AT, requestId: state.reviewRequest.id,
    kind: state.reviewRequest.kind, outcome: 'clean', evidenceType: 'review-submission',
    reviewerLogin: 'chatgpt-codex-connector', reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector', reactionContent: null,
    reactionCommentId: null, ...overrides,
  };
}

function ciEvidence(state, overrides = {}) {
  return {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: state.currentIntegrationHeadSha,
    checks: ['check', 'e2e'], checkRunId: 'CHECK_123456', workflowRunId: 123456,
    workflowRunUrl: 'https://github.com/example/sky-bar/actions/runs/123456', updatedAt: AT,
    ...overrides,
  };
}

function legacyState(state, overrides = {}) {
  const {
    verificationReviewUsed: _verificationReviewUsed,
    legacyReviewProvenance: _legacyReviewProvenance,
    reviewOutcome,
    reviewHistory: _reviewHistory,
    verificationEscalation: _verificationEscalation,
    threadResolutionStatus: _threadResolutionStatus,
    ciValidationStatus: _ciValidationStatus,
    ciValidationHistory: _ciValidationHistory,
    abandonmentReason: _abandonmentReason,
    validationStatus,
    ...legacy
  } = state;
  const legacyValidation = {
    status: validationStatus.status, headSha: validationStatus.headSha,
    checks: validationStatus.checks, updatedAt: validationStatus.updatedAt,
  };
  return {
    ...legacy, schemaVersion: 1, validationStatus: legacyValidation,
    reviewSubmission: reviewOutcome, tasks: [], ...overrides,
  };
}

function schemaV2State(state) {
  const {
    ciValidationStatus: _ciValidationStatus,
    ciValidationHistory: _ciValidationHistory,
    validationStatus,
    ...currentFields
  } = state;
  const { source: _source, scope: _scope, ...legacyValidationStatus } = validationStatus;
  return { ...currentFields, schemaVersion: 2, validationStatus: legacyValidationStatus };
}

function migrateTasklessPendingReview(cwd) {
  const prepared = ready(init(cwd), []);
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  writeFileSync(statePath(cwd, requested.prNumber), `${JSON.stringify(schemaV2State(requested))}\n`);
  return migrateState({ cwd }).state;
}

function legacyTask(workerCommitSha, overrides = {}) {
  return {
    id: 'legacy-task', sourceIds: ['review:9', 'discussion:99', 'discussion:99'],
    fingerprint: 'legacy-fingerprint', summary: 'Preserve this legacy finding', severity: 'P2',
    disposition: 'actionable', status: 'integrated', dependencies: ['earlier', 'earlier'],
    ownedPaths: ['src/legacy.ts', 'src/legacy.ts'], worker: null, branch: null, worktree: null,
    commitSha: workerCommitSha, validationSummaries: ['Focused validation passed.', 'Focused validation passed.'],
    lastError: null, ...overrides,
  };
}

function taskPacket(head, taskId, { affectedAreas = ['api'], command = 'npm run check:api' } = {}) {
  return {
    schemaVersion: 2, taskId, reviewedHeadSha: head, finding: `Finding for ${taskId}.`, evidence: 'Review evidence.',
    affectedAreas, decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['The targeted behavior is verified.'],
    requiredValidation: {
      unit: [{ command, reason: 'Direct targeted check.' }],
      system: [],
    },
  };
}

function initialSelection(head, overrides = {}) {
  return {
    schemaVersion: 1,
    headSha: head,
    affectedAreas: ['workflow'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Initial workflow selection.' }],
      system: [],
    },
    ...overrides,
  };
}

function integratedTasks(cwd, ids) {
  const initial = init(cwd);
  const proposedTasks = ids.map((id) => task(initial.currentIntegrationHeadSha, {
    id, status: 'proposed', disposition: 'actionable', integratedCommitSha: null, resolutionSummary: null,
  }));
  const proposed = checkpointState({ cwd, nextState: { ...initial, tasks: proposedTasks }, expectedRevision: initial.revision });
  const integrated = proposedTasks.map((item) => {
    const { execution: _execution, ...withoutExecution } = item;
    return {
      ...withoutExecution, status: 'integrated', integratedCommitSha: initial.currentIntegrationHeadSha,
      resolutionSummary: 'Integrated centrally; targeted validation remains.',
    };
  });
  return checkpointState({ cwd, nextState: { ...proposed, tasks: integrated }, expectedRevision: proposed.revision });
}

function bindPackets(cwd, state, packets) {
  return packets.reduce((current, packet) => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: current.revision,
  }), state);
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('initialization writes the v3 identity and empty durable ledgers', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.legacyReviewProvenance, null);
  assert.deepEqual(state.reviewHistory, []);
  assert.deepEqual(state.threadResolutionStatus.threads, []);
  assert.equal(statePath(cwd, 17), join(gitCommonDirectory(cwd), 'codex', 'pr-review', 'pr-17', 'state.json'));
});

test('v2 loading requires explicit migration and writes an exact versioned backup', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const {
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
  assert.equal(readFileSync(migrated.backupPath, 'utf8'), source);
  assert.match(migrated.backupPath, /state\.v2\.backup\.json$/u);
});

test('v2 migration preserves a pending exact-head review while resetting targeted validation', () => {
  const cwd = repo();
  const prepared = ready(init(cwd), []);
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  const {
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
      replyUrl: `https://github.com/example/sky-bar/pull/17#discussion_r${threadIndex}`,
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

test('large v2 state survives the clean lifecycle and rejects documents beyond 64 KiB', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const head = initialized.currentIntegrationHeadSha;
  const tasks = [];
  let prepared = ready(initialized, tasks);
  while (Buffer.byteLength(`${JSON.stringify(prepared)}\n`) < 48 * 1024) {
    const index = tasks.length;
    tasks.push(task(head, {
      id: `large-state-task-${index}`,
      sourceIds: [`local:large-state-audit-${index}`],
      fingerprint: `large-state-fingerprint-${String(index).padStart(4, '0')}`,
      summary: `Durable finding ${index}: ${'s'.repeat(650)}`,
      resolutionSummary: `Integrated and verified with focused evidence ${index}: ${'e'.repeat(350)}`,
    }));
    prepared = ready(initialized, tasks);
  }
  const preparedBytes = Buffer.byteLength(`${JSON.stringify(prepared)}\n`);
  assert.ok(preparedBytes > 30 * 1024);
  assert.ok(preparedBytes < ACTIVE_STATE_LIMIT_BYTES);
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(prepared)}\n`);

  const requested = checkpointReviewRequest({
    cwd, request: request(prepared, 'large-state-request'),
    pushedHeadSha: head, prHeadSha: head, expectedRevision: prepared.revision,
  });
  assert.equal(requested.phase, 'awaiting-review');
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);

  const collected = checkpointReviewOutcome({
    cwd, outcome: outcome(requested), expectedRevision: requested.revision,
  });
  assert.equal(collected.reviewOutcome.outcome, 'clean');
  assert.ok(Buffer.byteLength(readFileSync(statePath(cwd, 17))) < ACTIVE_STATE_LIMIT_BYTES);

  const ciValidated = checkpointCiValidation({
    cwd, evidence: ciEvidence(collected), expectedRevision: collected.revision,
  });
  const completed = checkpointCompletion({
    cwd, pushedHeadSha: head, prHeadSha: head, expectedRevision: ciValidated.revision,
  });
  assert.equal(completed.phase, 'complete');

  const oversized = structuredClone(completed);
  while (Buffer.byteLength(`${JSON.stringify(oversized)}\n`) <= ACTIVE_STATE_LIMIT_BYTES) {
    const index = oversized.decisions.length;
    oversized.decisions.push({ id: `oversized-${index}`, summary: 'x'.repeat(1000) });
  }
  assert.throws(
    () => checkpointState({ cwd, nextState: oversized, expectedRevision: completed.revision }),
    { code: 'STATE_TOO_LARGE' },
  );
  writeFileSync(statePath(cwd, 17), `${JSON.stringify(oversized)}\n`);
  assert.throws(() => loadState(cwd), { code: 'STATE_TOO_LARGE' });
});

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
  const invalidated = checkpointGitMetadata({ cwd }).state;
  assert.equal(invalidated.ciValidationStatus.status, 'not-run');
  assert.deepEqual(invalidated.ciValidationHistory, [currentEvidence]);
  rmSync(join(cwd, 'dirty-ci-proof.txt'));
  const cleaned = checkpointGitMetadata({ cwd }).state;
  assert.equal(cleaned.git.dirty, false);
  assert.equal(cleaned.ciValidationStatus.status, 'not-run');
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

test('stale verification request stops for a human and preserves its evidence', () => {
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
  assert.equal(drifted.phase, 'awaiting-human-decision');
  assert.deepEqual(drifted.reviewHistory, immutableEvidence);
  assert.equal(drifted.reviewOutcome, null);
});

test('verification is consumed once after three migrated discovery rounds and findings stop for a human', () => {
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
  assert.equal(stopped.phase, 'awaiting-human-decision');
  assert.equal(reviewRequestGate({ ...state, verificationReviewUsed: true }, external(cwd, state)).allowed, false);
});

test('verification collection escalation is guarded, append-only, request-bound, and terminal', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const migrated = migratePrReviewStateV1(legacyState(initialized, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-escalation', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha, prHeadSha: prepared.currentIntegrationHeadSha,
  });
  const escalation = {
    requestId: requested.reviewRequest.id,
    requestHeadSha: requested.reviewRequest.headSha,
    observedPrHeadSha: requested.reviewRequest.headSha,
    headRelation: 'same',
    evidenceIds: ['review:PRR_stale', 'reaction:R_stale'],
    reason: 'ambiguous-canonical-evidence',
    at: AT,
  };
  for (const reason of ['stale-canonical-evidence', 'ambiguous-canonical-evidence']) {
    assert.throws(() => buildVerificationEscalationTransition(requested, {
      ...escalation, reason, observedPrHeadSha: 'f'.repeat(40), headRelation: 'same',
    }), { code: 'INVALID_VERIFICATION_ESCALATION' });
  }
  const built = buildVerificationEscalationTransition(requested, escalation);
  assert.equal(built.phase, 'awaiting-human-decision');
  assert.throws(() => checkpointState({
    cwd, expectedRevision: requested.revision, nextState: built,
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const escalated = checkpointVerificationEscalation({
    cwd, expectedRevision: requested.revision, escalation,
  });
  assert.equal(escalated.verificationReviewUsed, true);
  assert.deepEqual(escalated.reviewHistory, requested.reviewHistory);
  assert.ok(reviewRequestGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.ok(completionGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.throws(() => checkpointState({
    cwd, expectedRevision: escalated.revision,
    nextState: { ...escalated, verificationEscalation: null },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: escalated.revision,
    nextState: {
      ...escalated,
      verificationEscalation: { ...escalation, evidenceIds: ['review:rewritten'] },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.deepEqual(checkpointVerificationEscalation({
    cwd, expectedRevision: escalated.revision, escalation,
  }), escalated);

  const discovery = {
    ...requested, reviewRound: 2, verificationReviewUsed: false,
    reviewRequest: { ...requested.reviewRequest, kind: 'discovery' },
    reviewHistory: [{ request: { ...requested.reviewRequest, kind: 'discovery' }, outcome: null }],
  };
  assert.throws(
    () => buildVerificationEscalationTransition(discovery, escalation),
    { code: 'VERIFICATION_ESCALATION_NOT_EXPECTED' },
  );
});

test('stale verification HEAD drift accepts truthful guarded collection escalation', () => {
  const cwd = repo();
  const initialized = init(cwd);
  const migrated = migratePrReviewStateV1(legacyState(initialized, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-head-drift', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha, prHeadSha: prepared.currentIntegrationHeadSha,
  });
  const requestHead = requested.reviewRequest.headSha;
  const observedPrHead = commit(cwd, { 'escalation-drift.txt': 'drift\n' }, 'escalation drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  const escalated = checkpointVerificationEscalation({
    cwd, expectedRevision: drifted.revision,
    escalation: {
      requestId: requested.reviewRequest.id, requestHeadSha: requestHead, observedPrHeadSha: observedPrHead,
      headRelation: 'changed', evidenceIds: [`request:${requested.reviewRequest.id}`],
      reason: 'request-head-drift', at: AT,
    },
  });
  assert.equal(escalated.phase, 'awaiting-human-decision');
  assert.equal(escalated.verificationReviewUsed, true);
  assert.equal(escalated.reviewHistory.at(-1).outcome, null);
});

test('structured canonical thread proof covers multiple tasks with one reply and completes them once', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const tasks = ['task-a', 'task-b'].map((id) => task(head, {
    id, status: 'integrated', sourceType: 'github-thread', sourceIds: ['thread:PRRT_node'],
  }));
  const proof = {
    status: 'passed', headSha: head, updatedAt: AT,
    threads: [{
      threadNodeId: 'PRRT_node', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 9,
      taskIds: ['task-a', 'task-b'],
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r9',
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
    }],
    threadlessVerification: emptyThreadless(),
  };
  const completed = completeIntegratedTasks({ ...state, tasks }, { threadResolutionStatus: proof });
  assert.ok(completed.tasks.every((item) => item.status === 'completed'));
  assert.equal(completed.threadResolutionStatus.threads.length, 1);
});

test('completion requires every exact source root to have disposition-matched replied resolved proof', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const actionable = task(head, {
    id: 'multi-root', status: 'integrated', sourceType: 'github-thread',
    sourceIds: ['discussion:41', 'thread:PRRT_second'],
  });
  const first = {
    threadNodeId: 'PRRT_first', rootCommentNodeId: 'PRRC_first', rootCommentDatabaseId: 41,
    taskIds: ['multi-root'], disposition: 'fixed', replyId: 'PRRC_reply_1',
    replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r41', isResolved: true,
    resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
  };
  const second = {
    ...first, threadNodeId: 'PRRT_second', rootCommentNodeId: 'PRRC_second', rootCommentDatabaseId: 42,
    replyId: 'PRRC_reply_2', replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r42',
  };
  const proof = {
    status: 'passed', headSha: head, threads: [first], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  assert.equal(
    completeIntegratedTasks({ ...state, tasks: [actionable] }, { threadResolutionStatus: proof }).tasks[0].status,
    'integrated',
  );
  const wrongDisposition = { ...first, disposition: 'invalid' };
  assert.equal(completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [wrongDisposition, second] } },
  ).tasks[0].status, 'integrated');
  assert.throws(() => completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [{ ...first, replyId: null, replyUrl: null }, second] } },
  ), { code: 'INVALID_TASK_COMPLETION' });
  assert.throws(() => completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [{ ...first, isResolved: false, resolvedAt: null, resolvedBy: null }, second] } },
  ), { code: 'INVALID_TASK_COMPLETION' });
  assert.equal(completeIntegratedTasks(
    { ...state, tasks: [actionable] },
    { threadResolutionStatus: { ...proof, threads: [first, second] } },
  ).tasks[0].status, 'completed');
});

test('threadless GitHub task completion requires successful exact-head verification', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const tasks = [task(head, { id: 'threadless', status: 'integrated', sourceType: 'github-threadless' })];
  const proof = {
    status: 'passed', headSha: head, threads: [], updatedAt: AT,
    threadlessVerification: { status: 'passed', headSha: head, taskIds: ['threadless'], updatedAt: AT },
  };
  assert.doesNotThrow(() => completeIntegratedTasks({ ...state, tasks }, { threadResolutionStatus: proof }));
  assert.equal(completeIntegratedTasks(
    { ...state, tasks },
    { threadResolutionStatus: { ...proof, threadlessVerification: emptyThreadless() } },
  ).tasks[0].status, 'integrated');
});

test('proven non-actionable not-applicable findings become completed-equivalent', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const disposed = task(head, {
    id: 'invalid-finding', status: 'not-applicable', disposition: 'invalid', sourceType: 'github-thread',
    sourceIds: ['thread:PRRT_invalid'], integratedCommitSha: null, resolutionSummary: 'Rejected with evidence.',
  });
  const proof = {
    status: 'passed', headSha: head, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: [{
      threadNodeId: 'PRRT_invalid', rootCommentNodeId: 'PRRC_invalid', rootCommentDatabaseId: 10,
      taskIds: ['invalid-finding'],
      disposition: 'invalid', replyId: 'PRRC_invalid_reply',
      replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r10', isResolved: true, resolvedAt: AT,
      resolvedBy: 'maintainer', observedHeadSha: head,
    }],
  };
  const completed = completeIntegratedTasks({ ...state, tasks: [disposed] }, { threadResolutionStatus: proof });
  assert.equal(completed.tasks[0].status, 'completed');
  assert.equal(completed.tasks[0].integratedCommitSha, null);
});

test('checkpoint enforces immutable identity, monotonic counters, sticky verification, and null active abandonment', () => {
  const cwd = repo();
  const state = init(cwd);
  for (const nextState of [
    { ...state, baseSha: 'a'.repeat(40) },
    { ...state, integrationWorktree: '/tmp/other' },
    { ...state, releaseBaseline: { version: '1.0.0', tag: 'v1.0.0', commit: state.baseSha, releasedAt: AT } },
    { ...state, abandonmentReason: 'not active' },
  ]) assert.throws(() => checkpointState({ cwd, nextState, expectedRevision: 0 }));

  const migrated = migratePrReviewStateV1(legacyState(state, { reviewRound: 3 }), { migratedAt: AT });
  writeFileSync(statePath(cwd, 17), JSON.stringify(migrated));
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: migrated.revision, threadResolutionStatus: ready(migrated, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const advanced = checkpointReviewRequest({
    cwd, expectedRevision: prepared.revision,
    request: request(prepared, 'verification-sticky', 'verification'),
    pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha,
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: advanced.revision,
    nextState: { ...advanced, reviewRound: 2, verificationReviewUsed: false },
  }));
});

test('invalid events cannot advance state and event I/O failure rolls back state', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.throws(() => checkpointState({
    cwd, nextState: { ...state, nextAction: 'Changed.' }, expectedRevision: 0,
    event: { type: '', summary: 'invalid' },
  }), { code: 'INVALID_EVENT' });
  assert.equal(loadState(cwd).revision, 0);
  assert.throws(() => checkpointState({
    cwd, nextState: { ...state, nextAction: 'Changed.' }, expectedRevision: 0,
    event: { type: 'checkpoint', summary: 'valid' },
    eventWriter: () => { throw new Error('disk full'); },
  }), { code: 'CHECKPOINT_EVENT_FAILED' });
  assert.deepEqual(loadState(cwd), state);
});

test('HEAD drift preserves durable task coverage while invalidating and refreshing aggregate proof', () => {
  const cwd = repo();
  const state = init(cwd);
  const headA = state.currentIntegrationHeadSha;
  const proposedTask = task(headA, {
    id: 'thread-task', status: 'proposed', sourceType: 'github-thread', sourceIds: ['thread:PRRT_drift'],
  });
  const proposed = checkpointState({ cwd, nextState: { ...state, tasks: [proposedTask] }, expectedRevision: 0 });
  const integratedTask = task(headA, {
    id: 'thread-task', status: 'integrated', sourceType: 'github-thread', sourceIds: ['thread:PRRT_drift'],
  });
  const integrated = checkpointState({
    cwd, nextState: { ...proposed, tasks: [integratedTask] }, expectedRevision: proposed.revision,
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: integrated.revision,
    nextState: { ...integrated, tasks: [{ ...integratedTask, status: 'completed' }] },
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  const proofA = {
    status: 'passed', headSha: headA, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: [{
      threadNodeId: 'PRRT_drift', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 11,
      taskIds: ['thread-task'],
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r1',
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: headA,
    }],
  };
  const completedAtA = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proofA, expectedRevision: integrated.revision,
  });
  for (const nextTask of [
    { ...completedAtA.tasks[0], status: 'integrated' },
    { ...completedAtA.tasks[0], integratedCommitSha: 'f'.repeat(40) },
    { ...completedAtA.tasks[0], resolutionSummary: 'Rewritten.' },
  ]) assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision, nextState: { ...completedAtA, tasks: [nextTask] },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision,
    nextState: {
      ...completedAtA,
      threadResolutionStatus: {
        ...completedAtA.threadResolutionStatus,
        threads: [{ ...completedAtA.threadResolutionStatus.threads[0], replyId: 'rewritten-reply' }],
      },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: completedAtA.revision,
    nextState: {
      ...completedAtA,
      threadResolutionStatus: { ...completedAtA.threadResolutionStatus, threads: [] },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const headB = commit(cwd, { 'next.txt': 'next\n' }, 'next');
  const result = checkpointGitMetadata({ cwd });
  assert.equal(result.state.threadResolutionStatus.status, 'not-run');
  assert.equal(result.state.threadResolutionStatus.threads[0].observedHeadSha, headA);
  assert.equal(result.state.tasks[0].status, 'completed');
  assert.equal(reviewRequestGate(result.state, external(cwd, result.state)).allowed, false);

  const proofB = {
    ...proofA, headSha: headB, updatedAt: '2026-08-05T00:01:00Z',
    threads: proofA.threads,
  };
  const proofRefreshed = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proofB, expectedRevision: result.state.revision,
  });
  const refreshed = ready(proofRefreshed, proofRefreshed.tasks);
  refreshed.validationStatus = {
    source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: headB,
    checks: ['npm run check'], updatedAt: '2026-08-05T00:01:00Z',
  };
  assert.equal(reviewRequestGate(refreshed, external(cwd, refreshed)).allowed, true);
});

test('generic checkpoint cannot forge zero-thread or threadless successful proof at a new HEAD', () => {
  const zeroCwd = repo();
  const zeroInitial = init(zeroCwd);
  const zeroHeadA = zeroInitial.currentIntegrationHeadSha;
  const zeroProofA = ready(zeroInitial, []).threadResolutionStatus;
  const zeroProofedA = checkpointTaskCompletion({
    cwd: zeroCwd, expectedRevision: 0, threadResolutionStatus: zeroProofA,
  });
  const zeroHeadB = commit(zeroCwd, { 'zero-proof-drift.txt': 'drift\n' }, 'zero proof drift');
  const zeroProofB = { ...zeroProofA, headSha: zeroHeadB, updatedAt: '2026-08-05T00:01:00Z' };
  assert.throws(() => checkpointState({
    cwd: zeroCwd, expectedRevision: zeroProofedA.revision,
    nextState: {
      ...zeroProofedA, currentIntegrationHeadSha: zeroHeadB,
      git: { ...zeroProofedA.git, headSha: zeroHeadB }, threadResolutionStatus: zeroProofB,
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const zeroInvalidated = checkpointGitMetadata({ cwd: zeroCwd }).state;
  assert.equal(zeroInvalidated.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(zeroInvalidated.threadResolutionStatus.threads, zeroProofA.threads);
  assert.deepEqual(zeroInvalidated.threadResolutionStatus.threadlessVerification, zeroProofA.threadlessVerification);
  const zeroRefreshed = checkpointTaskCompletion({
    cwd: zeroCwd, expectedRevision: zeroInvalidated.revision, threadResolutionStatus: zeroProofB,
  });
  assert.equal(zeroRefreshed.threadResolutionStatus.headSha, zeroHeadB);
  assert.notEqual(zeroHeadA, zeroHeadB);

  const threadlessCwd = repo();
  const threadlessInitial = init(threadlessCwd);
  const threadlessHeadA = threadlessInitial.currentIntegrationHeadSha;
  const proposedTask = task(threadlessHeadA, {
    id: 'threadless-forgery', status: 'proposed', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const proposed = checkpointState({
    cwd: threadlessCwd, expectedRevision: 0, nextState: { ...threadlessInitial, tasks: [proposedTask] },
  });
  const integratedTask = task(threadlessHeadA, {
    id: 'threadless-forgery', status: 'integrated', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const integrated = checkpointState({
    cwd: threadlessCwd, expectedRevision: proposed.revision, nextState: { ...proposed, tasks: [integratedTask] },
  });
  const threadlessProofA = {
    status: 'passed', headSha: threadlessHeadA, threads: [], updatedAt: AT,
    threadlessVerification: {
      status: 'passed', headSha: threadlessHeadA, taskIds: ['threadless-forgery'], updatedAt: AT,
    },
  };
  const completedA = checkpointTaskCompletion({
    cwd: threadlessCwd, expectedRevision: integrated.revision, threadResolutionStatus: threadlessProofA,
  });
  const threadlessHeadB = commit(threadlessCwd, { 'threadless-proof-drift.txt': 'drift\n' }, 'threadless proof drift');
  const threadlessProofB = {
    ...threadlessProofA, headSha: threadlessHeadB, updatedAt: '2026-08-05T00:01:00Z',
    threadlessVerification: {
      ...threadlessProofA.threadlessVerification,
      headSha: threadlessHeadB, updatedAt: '2026-08-05T00:01:00Z',
    },
  };
  assert.throws(() => checkpointState({
    cwd: threadlessCwd, expectedRevision: completedA.revision,
    nextState: {
      ...completedA, currentIntegrationHeadSha: threadlessHeadB,
      git: { ...completedA.git, headSha: threadlessHeadB }, threadResolutionStatus: threadlessProofB,
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  const threadlessInvalidated = checkpointGitMetadata({ cwd: threadlessCwd }).state;
  assert.equal(threadlessInvalidated.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(
    threadlessInvalidated.threadResolutionStatus.threadlessVerification,
    threadlessProofA.threadlessVerification,
  );
  const threadlessRefreshed = checkpointTaskCompletion({
    cwd: threadlessCwd, expectedRevision: threadlessInvalidated.revision,
    threadResolutionStatus: threadlessProofB,
  });
  assert.equal(threadlessRefreshed.threadResolutionStatus.threadlessVerification.headSha, threadlessHeadB);
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
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  const boundRevision = state.revision;
  assert.equal(state.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.equal(checkpointTaskPacketBinding({
    cwd, packet: reordered, expectedRevision: state.revision,
  }).revision, boundRevision);
  const weakened = {
    ...packet,
    affectedAreas: ['documentation'],
    requiredValidation: {
      unit: [{ command: 'node --test tests/tooling/contracts.test.mjs', reason: 'Weakened selection.' }],
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
  const bound = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: proposed.revision,
  });
  assert.equal(bound.reviewedHeadSha, null);
  assert.equal(bound.tasks[0].taskPacketDigest, taskPacketDigest(packet));

  const integratedHead = commit(cwd, { 'scripts/integrated-task.mjs': 'export const integrated = true;\n' }, 'integrate task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  assert.equal(advanced.currentIntegrationHeadSha, integratedHead);
  assert.throws(() => assertTaskPacketBound(advanced, packet), { code: 'TASK_PACKET_HEAD_MISMATCH' });

  const { execution: _execution, ...boundTask } = advanced.tasks[0];
  const integrated = checkpointState({
    cwd,
    expectedRevision: advanced.revision,
    nextState: {
      ...advanced,
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
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: proposed.revision });
  const integratedHead = commit(cwd, { 'scripts/ancestry-task.mjs': 'export const integrated = true;\n' }, 'integrate ancestry task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...boundTask } = advanced.tasks[0];
  const integrated = checkpointState({
    cwd,
    expectedRevision: advanced.revision,
    nextState: {
      ...advanced,
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

test('worker-result acceptance requires the exact durably bound task packet', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a');
  const workerCommit = commit(cwd, { 'scripts/worker-result.mjs': 'export const fixed = true;\n' }, 'worker result');
  const result = {
    schemaVersion: 2,
    taskId: 'task-a',
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
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
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
      proofCheckpointHeldLock = existsSync(join(reviewRoot(cwd), 'locks', 'pr-17.lock'));
    },
  });
  assert.deepEqual(attempted, ['npm run check:api', 'npm run check:shared', 'npm run check:web']);
  assert.equal(resumed.state.validationStatus.status, 'passed');
  assert.equal(resumed.state.validationStatus.headSha, state.currentIntegrationHeadSha);
  assert.equal(proofCheckpointHeldLock, true);
  assert.match(renderRecoverySummary({ cwd }), /Targeted validation plan: .*completed; pending 0, passed 3, failed 0; recorded proof passed/u);
});

test('targeted validation CLI saves and executes the exact durable plan', () => {
  const cwd = repo();
  commit(cwd, {
    'tests/focused.test.mjs': "import test from 'node:test';\ntest('focused command', () => {});\n",
  }, 'add focused validation fixture');
  const state = integratedTasks(cwd, ['task-a']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'task-a', {
    affectedAreas: ['documentation'], command: 'node --test tests/focused.test.mjs',
  });
  const packetPath = join(stateDirectory(cwd, state.prNumber), 'task-a.json');
  writeFileSync(packetPath, `${JSON.stringify(packet)}\n`);

  const bound = spawnSync(process.execPath, [
    STATE_CLI, 'bind-task-packet', '--pr', '17', '--expected-revision', String(state.revision),
    '--task-packet', packetPath,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(JSON.parse(bound.stdout).tasks[0].taskPacketDigest, taskPacketDigest(packet));

  const planned = spawnSync(process.execPath, [STATE_CLI, 'validation-plan', '--pr', '17', packetPath], {
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

test('concurrent lock attempts time out', async () => {
  const cwd = repo();
  init(cwd);
  const fixture = new URL('./fixtures/hold-state-lock.mjs', import.meta.url);
  const child = spawn(process.execPath, [fixture.pathname, cwd, '17', '350'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveLocked, reject) => {
    child.stdout.once('data', (chunk) => chunk.toString().includes('locked') ? resolveLocked() : reject(new Error('not locked')));
    child.once('error', reject);
  });
  assert.throws(() => withStateLock(cwd, 17, () => {}, { timeoutMs: 75, staleMs: 1000 }), { code: 'STATE_LOCK_TIMEOUT' });
  await new Promise((resolveExit, reject) => child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(String(code)))));
});

test('atomic checkpoints leave no temporary files', () => {
  const cwd = repo();
  const state = init(cwd);
  checkpointState({ cwd, nextState: { ...state, nextAction: 'Still recovering.' }, expectedRevision: 0 });
  assert.deepEqual(readdirSync(stateDirectory(cwd, 17)).filter((name) => name.endsWith('.tmp')), []);
});
