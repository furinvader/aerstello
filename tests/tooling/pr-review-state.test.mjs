import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATE_LIMIT_BYTES,
  activePointerPath,
  archiveState,
  buildCompletionTransition,
  buildReviewOutcomeTransition,
  buildReviewRequestTransition,
  checkpointCompletion,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointState,
  checkpointTaskCompletion,
  completeIntegratedTasks,
  gitAwareGateContext,
  gitCommonDirectory,
  initializeState,
  loadState,
  migratePrReviewStateV1,
  migrateState,
  reviewRequestGate,
  reviewRoot,
  stateDirectory,
  statePath,
  StateError,
  withStateLock,
} from '../../scripts/lib/pr-review-state.mjs';
import { commit, createRepository, git } from './git-fixtures.mjs';

const repositories = [];
const AT = '2026-08-05T00:00:00Z';

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
    validationStatus: { status: 'passed', headSha: head, checks: ['npm run check'], updatedAt: AT },
    threadResolutionStatus: {
      status: 'passed', headSha: head, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
    },
    git: { ...state.git, headSha: head, dirty: false },
    blockedReasons: [],
    nextAction: 'Request canonical review.',
  };
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

function legacyState(state, overrides = {}) {
  const {
    verificationReviewUsed: _verificationReviewUsed,
    legacyReviewProvenance: _legacyReviewProvenance,
    reviewOutcome,
    reviewHistory: _reviewHistory,
    threadResolutionStatus: _threadResolutionStatus,
    abandonmentReason: _abandonmentReason,
    ...legacy
  } = state;
  return { ...legacy, schemaVersion: 1, reviewSubmission: reviewOutcome, tasks: [], ...overrides };
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

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('initialization writes the v2 identity and empty durable ledgers', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.legacyReviewProvenance, null);
  assert.deepEqual(state.reviewHistory, []);
  assert.deepEqual(state.threadResolutionStatus.threads, []);
  assert.equal(statePath(cwd, 17), join(gitCommonDirectory(cwd), 'codex', 'pr-review', 'pr-17', 'state.json'));
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
  assert.deepEqual(migrated.validationStatus, { status: 'not-run', headSha: null, checks: [], updatedAt: null });
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
  const completed = checkpointTaskCompletion({
    cwd, threadResolutionStatus: proof, expectedRevision: result.state.revision,
  });
  const prepared = checkpointState({
    cwd, nextState: {
      ...ready(completed, completed.tasks), threadResolutionStatus: completed.threadResolutionStatus,
    }, expectedRevision: completed.revision,
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
  assert.equal(migrateState({ cwd, integrationMap }).state.schemaVersion, 2);
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
  const completed = buildCompletionTransition(collected, external(cwd, collected));
  assert.equal(completed.phase, 'complete');
});

test('generic checkpoint cannot bypass guarded request, outcome, or completion persistence', () => {
  const cwd = repo();
  const initial = init(cwd);
  assert.throws(
    () => checkpointState({ cwd, nextState: ready(initial, []), expectedRevision: 0 }),
    { code: 'PROTECTED_TRANSITION_REQUIRED' },
  );
  const proofed = checkpointTaskCompletion({
    cwd, expectedRevision: 0, threadResolutionStatus: ready(initial).threadResolutionStatus,
  });
  const prepared = checkpointState({
    cwd, nextState: ready(proofed, []), expectedRevision: proofed.revision,
  });
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
  const builtComplete = buildCompletionTransition(collected, external(cwd, collected));
  assert.throws(
    () => checkpointState({ cwd, nextState: builtComplete, expectedRevision: collected.revision }),
    { code: 'PROTECTED_TRANSITION_REQUIRED' },
  );
  const completed = checkpointCompletion({
    cwd, pushedHeadSha: collected.currentIntegrationHeadSha, prHeadSha: collected.currentIntegrationHeadSha,
    expectedRevision: collected.revision,
  });
  assert.equal(completed.phase, 'complete');
});

test('stale discovery request can be replaced without rewriting its null-outcome ledger entry', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proofedA = checkpointTaskCompletion({
    cwd, expectedRevision: 0, threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  const preparedA = checkpointState({
    cwd, expectedRevision: proofedA.revision, nextState: ready(proofedA, []),
  });
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
  const preparedB = checkpointState({
    cwd, expectedRevision: proofedB.revision, nextState: ready(proofedB, []),
  });
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
  const prepared = checkpointState({
    cwd, expectedRevision: proofed.revision, nextState: ready(proofed, []),
  });
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
  const prepared = checkpointState({
    cwd, expectedRevision: proofed.revision, nextState: ready(proofed, []),
  });
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
    status: 'passed', headSha: headB, checks: ['npm run check'], updatedAt: '2026-08-05T00:01:00Z',
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
