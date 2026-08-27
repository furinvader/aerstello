import assert from 'node:assert/strict';

import { spawn, spawnSync } from 'node:child_process';

import { createHash } from 'node:crypto';

import { afterEach, test } from 'node:test';

import {
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
} from 'node:fs';

import { tmpdir } from 'node:os';

import { dirname, join } from 'node:path';

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
  checkpointCompletion as rawCheckpointCompletion,
  checkpointArchiveTaskCompletion,
  checkpointCiValidation,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequestLimit,
  checkpointScopeAuthority,
  checkpointScopeClassification,
  checkpointReviewRequest as rawCheckpointReviewRequest,
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
} from '../state.mjs';

import {
  buildStaleDiscoveryDisposition,
  staleDiscoveryDispositionId,
} from '../../contracts/contracts.mjs';

import { routeSpecialists } from '../../../../aerstello-specialists/scripts/validate-registry.mjs';

import { commit, createRepository, git } from '../../../../../../tests/support/git-fixtures.mjs';

const repositories = [];

const AT = '2026-08-05T00:00:00Z';

const checkpointReviewRequest = (input) => rawCheckpointReviewRequest({ prState: 'OPEN', isDraft: false, ...input });

const checkpointCompletion = (input) => rawCheckpointCompletion({ prState: 'OPEN', isDraft: false, ...input });

const STATE_CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

const STATE_MODULE_URL = new URL('../state.mjs', import.meta.url).href;

const LOCK_HOLDER_SOURCE = `
  import { withGitHubRequestOwnerLock, withStateLock } from ${JSON.stringify(STATE_MODULE_URL)};
  const [cwd, prNumber, kind, holdMilliseconds] = process.argv.slice(1);
  const hold = Number(holdMilliseconds);
  if (kind === 'state') {
    withStateLock(cwd, Number(prNumber), () => {
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    });
  } else {
    await withGitHubRequestOwnerLock(cwd, Number(prNumber), async () => {
      process.stdout.write('locked\\n');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, hold));
    });
  }
`;

const LEGACY_LOCK_RELEASE_SOURCE = `
  import { unlinkSync } from 'node:fs';
  const [path, delayMilliseconds] = process.argv.slice(1);
  setTimeout(() => unlinkSync(path), Number(delayMilliseconds));
`;

function spawnLockHolder(cwd, kind, holdMilliseconds) {
  return spawn(process.execPath, [
    '--input-type=module', '--eval', LOCK_HOLDER_SOURCE, cwd, '17', kind, String(holdMilliseconds),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function spawnLegacyLockRelease(path, delayMilliseconds) {
  return spawn(process.execPath, [
    '--input-type=module', '--eval', LEGACY_LOCK_RELEASE_SOURCE, path, String(delayMilliseconds),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function waitForLockHolder(child) {
  return new Promise((resolveLocked, reject) => {
    let stdout = '';
    let stderr = '';
    const onStdout = (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('locked\n')) {
        cleanup();
        resolveLocked();
      }
    };
    const onStderr = (chunk) => { stderr += chunk.toString(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`lock holder exited before acquisition (${code ?? signal}): ${stderr}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

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

function emptyLocalVerification() {
  return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null };
}

function ready(state, tasks = [task(state.currentIntegrationHeadSha)]) {
  const head = state.currentIntegrationHeadSha;
  const localTaskIds = tasks.filter((item) => item.sourceType === 'local' && item.status === 'completed')
    .map((item) => item.id).sort();
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
      localVerification: localTaskIds.length > 0 ? {
        status: 'passed', headSha: head, taskIds: localTaskIds, updatedAt: AT,
      } : emptyLocalVerification(),
    },
    git: { ...state.git, headSha: head, dirty: false },
    blockedReasons: [],
    nextAction: 'Request canonical review.',
  };
}

function canonicalJsonForTest(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonForTest);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonicalJsonForTest(value[key])],
    ));
  }
  return value;
}

function archiveImportDigest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonForTest(value)))
    .digest('hex');
}

function archiveImportStateFixture(cwd) {
  const initial = init(cwd);
  const head = initial.currentIntegrationHeadSha;
  const remediation = task(head, {
    id: 'archive-import-remediation',
    sourceIds: ['orchestrator:archive-import-remediation'],
    sourceType: 'github-threadless',
    disposition: 'actionable',
    status: 'completed',
  });
  const aggregate = task(head, {
    id: 'retained-aggregate',
    sourceIds: ['thread:PRRT_archive_a', 'discussion:202'],
    sourceType: 'github-thread',
    disposition: 'already-fixed',
    status: 'not-applicable',
    integratedCommitSha: null,
    resolutionSummary: 'Already fixed and retained from immutable archives.',
  });
  const current = {
    ...initial,
    phase: 'implementing',
    tasks: [remediation, aggregate],
    threadResolutionStatus: {
      status: 'not-run',
      headSha: null,
      threads: [],
      threadlessVerification: {
        status: 'passed', headSha: head, taskIds: [remediation.id], updatedAt: AT,
      },
      localVerification: emptyLocalVerification(),
      updatedAt: null,
    },
    nextAction: 'Import the validated aggregate archive proof.',
  };
  writeFileSync(statePath(cwd, current.prNumber), `${JSON.stringify(current)}\n`);
  const authorityFingerprint = 'a'.repeat(64);
  const rows = [
    ['PRRT_archive_a', 'PRRC_archive_a', 201, 'REPLY_archive_a', 'b'.repeat(64)],
    ['PRRT_archive_b', 'PRRC_archive_b', 202, 'REPLY_archive_b', 'c'.repeat(64)],
  ].map(([threadNodeId, rootCommentNodeId, rootCommentDatabaseId, replyId, replyBodySha256], index) => ({
    threadNodeId,
    rootCommentNodeId,
    rootCommentDatabaseId,
    taskIds: [aggregate.id],
    disposition: 'already-fixed',
    replyId,
    replyUrl: `https://github.com/example/aerstello/pull/17#discussion_r${rootCommentDatabaseId}`,
    isResolved: true,
    resolvedAt: AT,
    resolvedBy: 'maintainer',
    observedHeadSha: index === 0 ? 'd'.repeat(40) : 'e'.repeat(40),
    archiveProvenance: {
      schemaVersion: 1,
      historicalTaskId: `historical-partition-${index + 1}`,
      historicalDisposition: 'already-fixed',
      historicalIntegratedCommitSha: null,
      replyBodySha256,
      authorityFingerprint,
    },
  }));
  const threadResolutionStatus = {
    status: 'passed',
    headSha: head,
    threads: rows,
    threadlessVerification: current.threadResolutionStatus.threadlessVerification,
    localVerification: current.threadResolutionStatus.localVerification,
    updatedAt: AT,
  };
  const envelope = {
    schemaVersion: 1,
    taskId: aggregate.id,
    authorityFingerprint,
    rows: rows.map((row) => ({
      threadNodeId: row.threadNodeId,
      replyId: row.replyId,
      replyBodySha256: row.archiveProvenance.replyBodySha256,
      provenanceFingerprint: archiveImportDigest(row.archiveProvenance),
      rowFingerprint: archiveImportDigest(row),
    })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId)),
  };
  return { current: loadState(cwd), aggregate, threadResolutionStatus, envelope };
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
  return { ...gitAwareGateContext(state, {
    pushedHeadSha: state.currentIntegrationHeadSha,
    prHeadSha: state.currentIntegrationHeadSha,
    ...overrides,
  }), prState: 'OPEN', isDraft: false, ...overrides };
}

function request(state, id = `request-${reviewRequestUsage(state).used + 1}`,
  kind = reviewRequestUsage(state).used < 3 ? 'discovery' : 'verification') {
  return {
    id, databaseId: 101, url: `https://github.com/example/aerstello/pull/17#issuecomment-${id}`,
    headSha: state.currentIntegrationHeadSha, at: AT, kind, body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'MDQ6VXNlcjE=',
  };
}

function outcome(state, overrides = {}) {
  return {
    id: `outcome-${state.reviewRequest.id}`, databaseId: 201,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-201',
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
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/123456', updatedAt: AT,
    ...overrides,
  };
}

function legacyState(state, overrides = {}) {
  const {
    staleDiscoveryDispositions: _staleDiscoveryDispositions,
    verificationReviewUsed: _verificationReviewUsed,
    reviewRequestLimit: _reviewRequestLimit,
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
    staleDiscoveryDispositions: _staleDiscoveryDispositions,
    ciValidationStatus: _ciValidationStatus,
    ciValidationHistory: _ciValidationHistory,
    reviewRequestLimit: _reviewRequestLimit,
    validationStatus,
    threadResolutionStatus,
    ...currentFields
  } = state;
  const { source: _source, scope: _scope, ...legacyValidationStatus } = validationStatus;
  const { localVerification: _localVerification, ...legacyThreadResolutionStatus } = threadResolutionStatus;
  return {
    ...currentFields, schemaVersion: 2, validationStatus: legacyValidationStatus,
    threadResolutionStatus: legacyThreadResolutionStatus,
  };
}

function migrateTasklessPendingReview(cwd) {
  const prepared = ready(init(cwd), []);
  const requested = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  writeFileSync(statePath(cwd, requested.prNumber), `${JSON.stringify(schemaV2State(requested))}\n`);
  return migrateState({ cwd }).state;
}

function migrateCompletedTaskCycle(cwd, phase) {
  let source = ready(init(cwd));
  if (phase === 'complete') {
    source = buildReviewRequestTransition(source, request(source), external(cwd, source));
    source = buildReviewOutcomeTransition(source, outcome(source));
    source = buildCiValidationTransition(source, ciEvidence(source));
    source = buildCompletionTransition(source, external(cwd, source));
  }
  writeFileSync(statePath(cwd, source.prNumber), `${JSON.stringify(schemaV2State(source))}\n`);
  return { source, migrated: migrateState({ cwd }).state };
}

function migrateCompletedTaskPendingReview(cwd) {
  const prepared = ready(init(cwd));
  const source = buildReviewRequestTransition(prepared, request(prepared), external(cwd, prepared));
  const legacy = schemaV2State(source);
  const serialized = `${JSON.stringify(legacy)}\n`;
  writeFileSync(statePath(cwd, source.prNumber), serialized);
  const migration = migrateState({ cwd });
  return { source, legacy, serialized, migrated: migration.state, backupPath: migration.backupPath };
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

function taskPacket(head, taskId, {
  affectedAreas = ['api'], command = 'npm run check:api',
  specialization = affectedAreas.includes('workflow') || affectedAreas.includes('documentation') ? 'ops-workflow'
    : affectedAreas.includes('shared') ? 'contracts' : affectedAreas.includes('web') ? 'web' : 'api',
  riskTags = [], dependencies = [],
} = {}) {
  return {
    schemaVersion: 3, taskId, reviewedHeadSha: head, specialization, riskTags,
    finding: `Finding for ${taskId}.`, evidence: 'Review evidence.',
    affectedAreas, decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies,
    acceptanceCriteria: ['The targeted behavior is verified.'],
    requiredValidation: {
      unit: [{ command, reason: 'Direct targeted check.' }],
      system: [],
    },
  };
}

function workerResult(packet, commitSha, changedPaths) {
  return {
    schemaVersion: 3,
    taskId: packet.taskId,
    specialization: packet.specialization,
    status: 'implemented',
    commitSha,
    changedPaths,
    validation: [...packet.requiredValidation.unit, ...packet.requiredValidation.system]
      .map(({ command }) => ({ command, result: 'passed', summary: 'Focused validation passed.' })),
    resolutionSummary: 'Implemented the fixed task and verified its declared validation.',
    residualRisks: [],
    unexpectedDependencies: [],
  };
}

function historicalTaskPacketV2(packet) {
  return Object.fromEntries(Object.entries(packet)
    .filter(([key]) => !['specialization', 'riskTags'].includes(key))
    .map(([key, value]) => [key, key === 'schemaVersion' ? 2 : value]));
}

function migrateV2BoundTask(cwd, {
  taskId = 'legacy-active', status = 'proposed', packetOptions = {}, taskOverrides = {},
} = {}) {
  const initial = init(cwd);
  const packet = taskPacket(initial.currentIntegrationHeadSha, taskId, packetOptions);
  const historicalPacket = historicalTaskPacketV2(packet);
  const boundTask = task(initial.currentIntegrationHeadSha, {
    id: taskId,
    sourceIds: [`local:${taskId}`],
    fingerprint: `fingerprint-${taskId}`,
    status,
    taskPacketDigest: taskPacketDigest(historicalPacket),
    ...(['proposed', 'blocked', 'failed'].includes(status) ? {
      execution: { worker: null, branch: null, worktree: null, workerCommitSha: null },
    } : {}),
    ...taskOverrides,
  });
  const source = { ...initial, tasks: [boundTask] };
  writeFileSync(statePath(cwd, source.prNumber), `${JSON.stringify(schemaV2State(source))}\n`);
  const migration = migrateState({ cwd });
  return { source, packet, historicalPacket, ...migration };
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

function nativeTasklessReview(cwd, { collectOutcome = true, outcomeOverrides = {} } = {}) {
  const initial = init(cwd);
  const threadProofed = checkpointTaskCompletion({
    cwd,
    expectedRevision: initial.revision,
    threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, threadProofed, []);
  const requested = checkpointReviewRequest({
    cwd,
    request: request(prepared),
    pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha,
    expectedRevision: prepared.revision,
  });
  const reviewed = collectOutcome ? checkpointReviewOutcome({
    cwd,
    outcome: outcome(requested, outcomeOverrides),
    expectedRevision: requested.revision,
  }) : null;
  return { initial, prepared, requested, reviewed };
}

function nativeTasklessPendingVerification(cwd, { reviewRequestLimit = null } = {}) {
  const initial = init(cwd, { reviewRequestLimit });
  const threadProofed = checkpointTaskCompletion({
    cwd,
    expectedRevision: initial.revision,
    threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  let current = persistReady(cwd, threadProofed, []);
  for (let round = 0; round < 3; round += 1) {
    const requested = checkpointReviewRequest({
      cwd,
      request: request(current),
      pushedHeadSha: current.currentIntegrationHeadSha,
      prHeadSha: current.currentIntegrationHeadSha,
      expectedRevision: current.revision,
    });
    const reviewed = checkpointReviewOutcome({
      cwd, outcome: outcome(requested), expectedRevision: requested.revision,
    });
    current = checkpointState({
      cwd, nextState: ready(reviewed, []), expectedRevision: reviewed.revision,
    });
  }
  const requested = checkpointReviewRequest({
    cwd,
    request: request(current),
    pushedHeadSha: current.currentIntegrationHeadSha,
    prHeadSha: current.currentIntegrationHeadSha,
    expectedRevision: current.revision,
  });
  return { initial, requested };
}

function nativeStaleDiscoveryDisposition(cwd, {
  dispositionOutcome = 'clean', reviewRequestLimit = null,
} = {}) {
  const initial = init(cwd, { reviewRequestLimit });
  const proofed = checkpointTaskCompletion({
    cwd,
    expectedRevision: initial.revision,
    threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  const prepared = persistReady(cwd, proofed, []);
  const requested = checkpointReviewRequest({
    cwd,
    request: request(prepared, 'stale-discovery-request', 'discovery'),
    pushedHeadSha: prepared.currentIntegrationHeadSha,
    prHeadSha: prepared.currentIntegrationHeadSha,
    expectedRevision: prepared.revision,
  });
  const requestHeadSha = requested.currentIntegrationHeadSha;
  const immutableHistory = structuredClone(requested.reviewHistory);
  const liveHeadSha = commit(cwd, { 'stale-discovery-drift.txt': 'drift\n' }, 'stale discovery drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  const validated = checkpointSyntheticTargetedValidation(cwd, drifted);
  const evidence = outcome(validated, {
    id: 'stale-discovery-response',
    headSha: requestHeadSha,
    requestId: requested.reviewRequest.id,
    kind: 'discovery',
    outcome: dispositionOutcome,
  });
  const disposition = buildStaleDiscoveryDisposition({
    request: requested.reviewRequest,
    liveHeadSha,
    evidence,
    responseFingerprint: 'd'.repeat(64),
    disposedAt: AT,
  });
  const threadResolutionStatus = {
    status: 'passed', headSha: liveHeadSha, threads: [],
    threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  const dispositioned = checkpointTaskCompletion({
    cwd,
    expectedRevision: validated.revision,
    threadResolutionStatus,
    staleDiscoveryDisposition: disposition,
  });
  return {
    requested, immutableHistory, requestHeadSha, liveHeadSha, validated,
    evidence, disposition, threadResolutionStatus, dispositioned,
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
  const preAuthority = { ...proposed, tasks: integrated };
  writeFileSync(statePath(cwd, preAuthority.prNumber), `${JSON.stringify(preAuthority)}\n`);
  return loadState(cwd, preAuthority.prNumber);
}

function bindPackets(cwd, state, packets) {
  return packets.reduce((current, packet) => bindPacket(cwd, current, packet), state);
}

function planInput(state, packet, planningSignals = { browserVisible: false, testSelectionUncertain: false }) {
  return {
    schemaVersion: 1, stage: 'pre-bind', headSha: packet.reviewedHeadSha,
    tasks: [{ taskPacket: packet, planningSignals }],
  };
}

function bindPacket(cwd, state, packet, planningSignals) {
  const scoped = scopeReadyForPacket(cwd, state, packet);
  planSpecialists({ cwd, input: planInput(scoped, packet, planningSignals), expectedRevision: scoped.revision, now: () => AT });
  return checkpointTaskPacketBinding({ cwd, packet, expectedRevision: scoped.revision });
}

const SCOPE_DIGEST = `sha256:${'a'.repeat(64)}`;
const SCOPE_PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;

function scopePair(headSha, packet) {
  const shapeDigest = `sha256:${taskPacketDigest(packet)}`;
  const binding = {
    phase: 'review-finding',
    source: { type: 'github-issue', identity: 'example/aerstello#17', digest: SCOPE_DIGEST },
    subject: { digest: shapeDigest, sha: headSha },
    planDigest: SCOPE_PLAN_DIGEST,
    amendmentDigests: [],
    taskPacketDigest: shapeDigest,
  };
  const assessmentPacket = {
    schemaVersion: 1,
    binding,
    sourceScope: {
      objective: 'Resolve the bounded review finding.',
      requiredCriteria: [{ id: 'bounded-remediation', text: 'Keep remediation in accepted scope.' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'bounded-remediation', text: 'Keep remediation in accepted scope.' }],
      invariants: [],
      minimalClosure: 'The exact task packet is sufficient.',
      authorizedShape: ['exact-task-packet'],
      unauthorizedShape: [],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'Implement the exact task packet.',
      paths: packet.allowedPaths,
      dependencies: [], publicSurfaces: [], persistentSurfaces: [], subsystems: [],
      mappings: [{
        mechanism: 'exact-task-packet', sourceCriterionIds: ['bounded-remediation'],
        acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
        rationale: 'The exact packet implements the accepted remediation criterion.',
      }],
    },
    tripwires: [],
  };
  const result = {
    schemaVersion: 1,
    binding,
    verdict: 'within-scope',
    summary: 'The exact packet remains within accepted scope.',
    coverage: [{
      mechanism: 'exact-task-packet', sourceCriterionIds: ['bounded-remediation'],
      acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
      classification: 'required', rationale: 'The exact packet is the bounded remediation.',
    }],
    unnecessaryWork: [], smallerSufficientAlternative: null, scopeDelta: null,
    materialityTriggers: [], smallestExpansion: null, narrowAlternative: null,
    deferralConsequences: null, missingEvidence: [], humanDecision: false,
  };
  return {
    packet: assessmentPacket,
    result,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(canonicalJsonForTest({ packet: assessmentPacket, result }))).digest('hex')}`,
  };
}

function scopeReadyForPacket(cwd, state, packet) {
  let current = state;
  if (!current.scopeControl) {
    current = checkpointScopeAuthority({
      cwd,
      authority: {
        schemaVersion: 1, authorityKind: 'standalone',
        source: { type: 'github-issue', identity: 'example/aerstello#17', digest: SCOPE_DIGEST },
        planDigest: SCOPE_PLAN_DIGEST, amendmentDigests: [],
        minimalClosure: { statement: 'The exact accepted review remediation is sufficient.', digest: SCOPE_DIGEST },
        handoffHeadSha: current.currentIntegrationHeadSha, integratedHeadAssessment: null,
        approvedDecisions: [], deferredFollowUps: [], capturedAt: AT,
      },
      expectedRevision: current.revision,
    });
  }
  const durableTask = current.tasks.find((item) => item.id === packet.taskId);
  const pair = scopePair(packet.reviewedHeadSha, packet);
  return checkpointScopeClassification({
    cwd,
    classification: {
      entryId: `classification-${createHash('sha256').update(packet.taskId).digest('hex').slice(0, 16)}`,
      at: AT,
      reviewHeadSha: packet.reviewedHeadSha,
      rootCauseId: durableTask.id,
      findingIds: durableTask.sourceIds,
      findingFingerprints: durableTask.sourceIds.map(
        (_sourceId, index) => `${durableTask.fingerprint}-f${index + 1}`,
      ),
      classification: 'within-scope-defect', assessment: pair,
      authorityAmendmentRequired: false, unrelatedReference: null,
      remediationShapeDigest: `sha256:${taskPacketDigest(packet)}`, tripwires: [],
    },
    expectedRevision: current.revision,
  });
}

function writePreAuthorityImplementedState(cwd, state, taskId, workerCommitSha) {
  const implemented = {
    ...state,
    tasks: state.tasks.map((item) => item.id === taskId ? {
      ...item,
      status: 'implemented',
      execution: { ...item.execution, workerCommitSha },
    } : item),
  };
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(implemented)}\n`);
  return loadState(cwd, state.prNumber);
}

function writePreAuthorityTasks(cwd, state, tasks) {
  const preAuthority = { ...state, tasks };
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(preAuthority)}\n`);
  return loadState(cwd, state.prNumber);
}

function canonicalBoundIntegratedTask(cwd, taskId = 'canonical-ancestry') {
  const initial = init(cwd);
  const threadProofed = checkpointTaskCompletion({
    cwd,
    expectedRevision: initial.revision,
    threadResolutionStatus: ready(initial, []).threadResolutionStatus,
  });
  const reviewReady = persistReady(cwd, threadProofed, []);
  const requested = checkpointReviewRequest({
    cwd,
    request: request(reviewReady),
    pushedHeadSha: reviewReady.currentIntegrationHeadSha,
    prHeadSha: reviewReady.currentIntegrationHeadSha,
    expectedRevision: reviewReady.revision,
  });
  const reviewed = checkpointReviewOutcome({
    cwd,
    outcome: outcome(requested, { outcome: 'findings' }),
    expectedRevision: requested.revision,
  });
  const proposedTask = task(reviewed.currentIntegrationHeadSha, {
    id: taskId, status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: reviewed.revision, nextState: { ...reviewed, tasks: [proposedTask] },
  });
  const packet = taskPacket(reviewed.reviewedHeadSha, taskId, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  const integratedHead = commit(cwd, { [`scripts/${taskId}.mjs`]: 'export const integrated = true;\n' }, `integrate ${taskId}`);
  const advanced = checkpointGitMetadata({ cwd }).state;
  rmSync(validationPlanPath(cwd, advanced.prNumber), { force: true });
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, taskId, integratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result: workerResult(packet, integratedHead, [`scripts/${taskId}.mjs`]),
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
  return { packet, reviewedHead: reviewed.reviewedHeadSha, integratedHead, integrated, bound };
}

function tasklessVerifierFixture(cwd, definitions = [{
  id: 'already-fixed-thread', disposition: 'already-fixed', status: 'not-applicable',
}], { validate = true } = {}) {
  const initial = init(cwd);
  const proposedTasks = definitions.map(({ id, disposition }) => task(initial.currentIntegrationHeadSha, {
    id, sourceIds: [`thread:${id}`], sourceType: 'github-thread', fingerprint: `fingerprint-${id}`,
    summary: `Retained outcome for ${id}.`, disposition, status: 'proposed',
    integratedCommitSha: null, resolutionSummary: null,
  }));
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: proposedTasks },
  });
  const transitionedTasks = proposed.tasks.map((item) => {
    const definition = definitions.find(({ id }) => id === item.id);
    if (definition.status === 'proposed') return item;
    if (definition.status === 'failed') {
      return {
        ...item, status: 'failed',
        execution: { ...item.execution, lastError: 'Focused worker failed.' },
      };
    }
    const { execution: _execution, ...withoutExecution } = item;
    return {
      ...withoutExecution, status: definition.status, integratedCommitSha: null,
      resolutionSummary: `Evidence retained for ${item.id}.`,
    };
  });
  const transitioned = definitions.every(({ status }) => status === 'proposed') ? proposed : checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: { ...proposed, tasks: transitionedTasks },
  });
  return {
    state: transitioned,
    validated: validate ? checkpointSyntheticTargetedValidation(cwd, transitioned) : transitioned,
  };
}

function appendVerifierOutcomeTasks(cwd, state, definitions) {
  const proposedTasks = definitions.map(({ id, disposition }) => task(state.currentIntegrationHeadSha, {
    id, sourceIds: [`thread:${id}`, `archive:${id}`], sourceType: 'github-thread',
    fingerprint: `fingerprint-${id}`, summary: `Retained outcome for ${id}.`,
    disposition, status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  }));
  const proposed = checkpointState({
    cwd, expectedRevision: state.revision,
    nextState: { ...state, tasks: [...state.tasks, ...proposedTasks] },
  });
  const transitioned = proposed.tasks.map((item) => {
    const definition = definitions.find(({ id }) => id === item.id);
    if (!definition || definition.status === 'proposed') return item;
    if (definition.status === 'failed') {
      return {
        ...item, status: 'failed',
        execution: { ...item.execution, lastError: 'Focused worker failed.' },
      };
    }
    const { execution: _execution, ...withoutExecution } = item;
    return {
      ...withoutExecution, status: definition.status, integratedCommitSha: null,
      resolutionSummary: `Evidence retained for ${item.id}.`,
    };
  });
  return definitions.every(({ status }) => status === 'proposed') ? proposed : checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: { ...proposed, tasks: transitioned },
  });
}

function completeLocalPacketTask(cwd, state, taskId) {
  return checkpointTaskCompletion({
    cwd, expectedRevision: state.revision, verifiedLocalTaskIds: [taskId],
    threadResolutionStatus: {
      status: 'passed', headSha: state.currentIntegrationHeadSha, threads: [],
      threadlessVerification: emptyThreadless(), updatedAt: AT,
      localVerification: {
        status: 'passed', headSha: state.currentIntegrationHeadSha,
        taskIds: [taskId], updatedAt: AT,
      },
    },
  });
}

function completedAndIntegratedPacketFixture(cwd, {
  retainedOutcome = true, laterReview = false,
} = {}) {
  const priorId = 'z-completed-packet';
  const { packet: priorPacket, integrated: priorIntegrated } = canonicalBoundIntegratedTask(cwd, priorId);
  const priorCompleted = completeLocalPacketTask(cwd, priorIntegrated, priorId);
  let currentAuthority = priorCompleted;
  if (laterReview) {
    buildTargetedValidationPlan({ cwd, now: () => AT });
    const priorValidated = executeTargetedValidationPlan({
      cwd, runCommand: () => ({ status: 0 }), now: () => AT,
    }).state;
    const reviewReady = persistReady(cwd, priorValidated, priorValidated.tasks);
    const requested = checkpointReviewRequest({
      cwd, request: request(reviewReady),
      pushedHeadSha: reviewReady.currentIntegrationHeadSha,
      prHeadSha: reviewReady.currentIntegrationHeadSha,
      expectedRevision: reviewReady.revision,
    });
    currentAuthority = checkpointReviewOutcome({
      cwd, outcome: outcome(requested, { outcome: 'findings' }),
      expectedRevision: requested.revision,
    });
  }
  const currentId = 'a-integrated-packet';
  const proposedTask = task(currentAuthority.reviewedHeadSha, {
    id: currentId, sourceIds: [`local:${currentId}`], fingerprint: `fingerprint-${currentId}`,
    status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: currentAuthority.revision,
    nextState: { ...currentAuthority, tasks: [...currentAuthority.tasks, proposedTask] },
  });
  const currentPacket = taskPacket(currentAuthority.reviewedHeadSha, currentId, {
    affectedAreas: ['api'], command: 'npm run check:api',
  });
  const bound = bindPacket(cwd, proposed, currentPacket);
  const currentHead = commit(cwd, {
    [`scripts/${currentId}.mjs`]: 'export const currentPacket = true;\n',
  }, `integrate ${currentId}`);
  const advanced = checkpointGitMetadata({ cwd }).state;
  rmSync(validationPlanPath(cwd, advanced.prNumber), { force: true });
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet: currentPacket,
    result: workerResult(currentPacket, currentHead, [`scripts/${currentId}.mjs`]),
    expectedRevision: advanced.revision,
  });
  const integratedTasks = accepted.tasks.map((item) => {
    if (item.id !== currentId) return item;
    const { execution: _execution, ...withoutExecution } = item;
    return {
      ...withoutExecution, status: 'integrated', integratedCommitSha: currentHead,
      resolutionSummary: 'Integrated current packet.',
    };
  });
  let integrated = checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: { ...accepted, tasks: integratedTasks },
  });
  if (retainedOutcome) {
    integrated = appendVerifierOutcomeTasks(cwd, integrated, [{
      id: 'm-archived-outcome', disposition: 'already-fixed', status: 'not-applicable',
    }]);
  }
  return {
    priorPacket, currentPacket, priorId, currentId, currentHead, integrated,
  };
}

function dependentWorkerAcceptanceFixture(cwd, {
  dependencyReference = 'integrated', workerBase = 'dependency', centralBase = 'dependency',
} = {}) {
  const dependencyId = 'result-dependency';
  const { reviewedHead, integratedHead, integrated } = canonicalBoundIntegratedTask(cwd, dependencyId);
  const pendingDependency = task(reviewedHead, {
    id: 'pending-result-dependency', sourceIds: ['local:pending-result-dependency'],
    fingerprint: 'pending-result-dependency', status: 'proposed', disposition: 'actionable',
    integratedCommitSha: null, resolutionSummary: null,
  });
  const targetId = 'dependent-result';
  const target = task(reviewedHead, {
    id: targetId, sourceIds: [`local:${targetId}`], fingerprint: targetId,
    status: 'proposed', disposition: 'actionable', integratedCommitSha: null, resolutionSummary: null,
    execution: { dependencies: [], ownedPaths: ['scripts/**'] },
  });
  const dependencies = dependencyReference === 'missing' ? ['missing-result-dependency']
    : dependencyReference === 'pending' ? [pendingDependency.id] : [dependencyId];
  target.execution.dependencies = dependencies;
  const proposedTasks = dependencyReference === 'pending'
    ? [...integrated.tasks, pendingDependency, target] : [...integrated.tasks, target];
  const proposed = checkpointState({
    cwd, expectedRevision: integrated.revision,
    nextState: { ...integrated, tasks: proposedTasks },
  });
  const packet = taskPacket(reviewedHead, targetId, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review', dependencies,
  });
  const bound = bindPacket(cwd, proposed, packet);
  const running = checkpointState({
    cwd, expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map((item) => item.id === targetId ? { ...item, status: 'running' } : item),
    },
  });

  const workerParent = workerBase === 'review' ? reviewedHead : integratedHead;
  git(cwd, ['switch', '-c', `worker-${workerBase}`, workerParent]);
  const workerSha = commit(cwd, {
    'scripts/dependent-result.mjs': 'export const dependentResult = true;\n',
  }, 'implement dependent result');

  const centralParent = centralBase === 'review' ? reviewedHead : integratedHead;
  git(cwd, ['switch', '-C', `central-${centralBase}`, centralParent]);
  const centralSha = commit(cwd, {
    'scripts/independent-sibling.mjs': 'export const independentSibling = true;\n',
  }, 'integrate independent sibling');
  const advanced = checkpointGitMetadata({ cwd }).state;
  return {
    packet, result: workerResult(packet, workerSha, ['scripts/dependent-result.mjs']), workerSha, centralSha,
    reviewedHead, integratedHead, advanced,
  };
}

function durableAcceptanceSnapshot(cwd, taskId) {
  const directory = join(stateDirectory(cwd, 17), 'worker-results');
  return {
    state: readFileSync(statePath(cwd, 17), 'utf8'),
    events: readFileSync(join(stateDirectory(cwd, 17), 'events.ndjson'), 'utf8'),
    inventory: existsSync(directory) ? readdirSync(directory).sort() : [],
    envelope: existsSync(workerResultEnvelopePath(cwd, 17, taskId))
      ? readFileSync(workerResultEnvelopePath(cwd, 17, taskId), 'utf8') : null,
    receipt: existsSync(workerResultReceiptPath(cwd, 17, taskId))
      ? readFileSync(workerResultReceiptPath(cwd, 17, taskId), 'utf8') : null,
  };
}

function repositoryAuthoritySnapshot(cwd) {
  const buffer = (args) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: null,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(
      result.status,
      0,
      Buffer.from(result.stderr ?? Buffer.alloc(0)).toString('utf8'),
    );
    return Buffer.from(result.stdout ?? Buffer.alloc(0));
  };
  const indexPath = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  return {
    head: git(cwd, ['rev-parse', 'HEAD']),
    index: existsSync(indexPath) ? readFileSync(indexPath) : null,
    indexDiff: buffer(['diff', '--cached', '--binary', '--no-ext-diff']),
    objectCount: buffer(['count-objects', '-v']),
    refs: buffer(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)']),
    status: buffer(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    temporaryDirectories: readdirSync(tmpdir())
      .filter((name) => name.startsWith(`aerstello-worker-authority-${process.pid}-`))
      .sort(),
    worktreeDiff: buffer(['diff', '--binary', '--no-ext-diff']),
  };
}

function boundWorkerResultFixture(cwd, taskId) {
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: taskId, status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, taskId, {
    affectedAreas: ['workflow'], command: 'npm run test:pr-review',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', `${taskId}-worker`]);
  const changedPath = `scripts/${taskId}.mjs`;
  const workerSha = commit(cwd, { [changedPath]: 'export const workerResult = true;\n' },
    `implement ${taskId}`);
  git(cwd, ['switch', 'main']);
  return { bound, packet, result: workerResult(packet, workerSha, [changedPath]) };
}

function acceptedWorkerStateProjection(state, packet, result) {
  const validationSummaries = result.validation.map((entry) => {
    const summary = `${entry.command}: ${entry.result} — ${entry.summary}`;
    return summary.length <= 1000 ? summary : `${summary.slice(0, 999)}…`;
  });
  return {
    ...state,
    tasks: state.tasks.map((item) => item.id === packet.taskId ? {
      ...item,
      status: 'implemented',
      workerResultDigest: 'a'.repeat(64),
      execution: {
        ...item.execution, workerCommitSha: result.commitSha,
        validationSummaries, lastError: null,
      },
    } : item),
  };
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

export {
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
  checkpointScopeAuthority,
  checkpointScopeClassification,
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
  scopePair,
  scopeReadyForPacket,
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
};
