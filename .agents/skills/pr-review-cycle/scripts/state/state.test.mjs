import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import {
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
  checkpointCiValidation,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequestLimit,
  checkpointReviewRequest as rawCheckpointReviewRequest,
  checkpointState,
  checkpointTaskPacketBinding,
  checkpointTaskPacketReplan,
  checkpointWorkerResultAcceptance,
  checkpointWorkerResultBackfill,
  checkpointTaskCompletion,
  checkpointTargetedValidation,
  checkpointVerificationEscalation,
  completionGate,
  completeIntegratedTasks,
  ensureGitHubMutationIntent,
  claimGitHubMutationDispatch,
  executeTargetedValidationPlan,
  gitAwareGateContext,
  gitCommonDirectory,
  initializeState,
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
} from './state.mjs';
import {
  buildStaleDiscoveryDisposition,
  staleDiscoveryDispositionId,
} from '../contracts/contracts.mjs';
import { routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { commit, createRepository, git } from '../../../../../tests/support/git-fixtures.mjs';

const repositories = [];
const AT = '2026-08-05T00:00:00Z';
const checkpointReviewRequest = (input) => rawCheckpointReviewRequest({ prState: 'OPEN', isDraft: false, ...input });
const checkpointCompletion = (input) => rawCheckpointCompletion({ prState: 'OPEN', isDraft: false, ...input });
const STATE_CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const STATE_MODULE_URL = new URL('./state.mjs', import.meta.url).href;
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
  planSpecialists({ cwd, input: planInput(state, packet, planningSignals), expectedRevision: state.revision, now: () => AT });
  return checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
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
  const changedPaths = git(cwd, [
    'diff', '--name-only', '--no-renames', reviewedHead, workerSha, '--',
  ]).split('\n').filter(Boolean);
  return {
    packet, result: workerResult(packet, workerSha, changedPaths), workerSha, centralSha,
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

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('initialization writes the v3 identity and empty durable ledgers', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.reviewRequestLimit, null);
  assert.equal(state.legacyReviewProvenance, null);
  assert.deepEqual(state.reviewHistory, []);
  assert.deepEqual(state.staleDiscoveryDispositions, []);
  assert.deepEqual(state.threadResolutionStatus.threads, []);
  assert.equal(statePath(cwd, 17), join(gitCommonDirectory(cwd), 'codex', 'pr-review', 'pr-17', 'state.json'));
});

test('worker results are receipt-bound, interruption-safe, immutable, and required for integration', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'durable-result', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'worker-result-fixture']);
  const workerSha = commit(cwd, { 'scripts/durable-result.mjs': 'export const durable = true;\n' }, 'worker result fixture');
  git(cwd, ['switch', 'main']);
  const result = workerResult(packet, workerSha, ['scripts/durable-result.mjs']);

  assert.throws(() => checkpointState({
    cwd, expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map((item) => ({
        ...item, status: 'implemented',
        execution: { ...item.execution, workerCommitSha: workerSha },
      })),
    },
  }), { code: 'WORKER_RESULT_MISSING' });

  assert.throws(() => checkpointState({
    cwd, expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map(({ execution: _execution, ...item }) => ({
        ...item, status: 'integrated', integratedCommitSha: workerSha, resolutionSummary: 'Forged integration.',
      })),
    },
  }), { code: 'WORKER_RESULT_MISSING' });

  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'receipt-durable') throw new Error('interrupt receipt'); },
  }), /interrupt receipt/u);
  assert.equal(existsSync(workerResultReceiptPath(cwd, 17, packet.taskId)), true);
  assert.equal(existsSync(workerResultEnvelopePath(cwd, 17, packet.taskId)), false);
  const pending = reconcileState({ cwd });
  assert.equal(pending.workerResults[0].status, 'pending-state');

  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'envelope-durable') throw new Error('interrupt envelope'); },
  }), /interrupt envelope/u);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'state-checkpointed') throw new Error('interrupt state response'); },
  }), /interrupt state response/u);
  const accepted = loadState(cwd);
  assert.equal(accepted.tasks[0].status, 'implemented');
  assert.match(accepted.tasks[0].workerResultDigest, /^[0-9a-f]{64}$/u);
  assert.equal(checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: accepted.revision,
  }).revision, accepted.revision);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result: { ...result, resolutionSummary: 'Different evidence.' },
    expectedRevision: accepted.revision,
  }), { code: 'WORKER_RESULT_CONFLICT' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: { ...accepted, tasks: accepted.tasks.map(({ workerResultDigest: _digest, ...item }) => item) },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });

  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...implementedTask } = advanced.tasks[0];
  const integrated = checkpointState({
    cwd, expectedRevision: advanced.revision,
    nextState: {
      ...advanced,
      tasks: [{
        ...implementedTask, status: 'integrated', integratedCommitSha: centralSha,
        resolutionSummary: 'Integrated accepted evidence.',
      }],
    },
  });
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'valid');
  assert.equal(integrated.tasks[0].workerResultDigest, accepted.tasks[0].workerResultDigest);
  const envelopePath = workerResultEnvelopePath(cwd, 17, packet.taskId);
  const canonicalEnvelope = readFileSync(envelopePath, 'utf8');
  const alteredEnvelope = JSON.parse(canonicalEnvelope);
  alteredEnvelope.result.resolutionSummary = 'Tampered evidence.';
  writeFileSync(envelopePath, `${JSON.stringify(alteredEnvelope)}\n`);
  assert.equal(reconcileState({ cwd }).workerResults[0].status, 'invalid');
  writeFileSync(envelopePath, canonicalEnvelope);
  const orphanPath = join(dirname(envelopePath), 'orphan.json');
  writeFileSync(orphanPath, '{}\n');
  assert.ok(reconcileState({ cwd }).workerResults.some((entry) => entry.status === 'orphan'));
  rmSync(orphanPath);
  const archived = archiveState({ cwd, abandonmentReason: 'Archive durable worker-result fixture.' });
  assert.equal(readdirSync(join(archived, 'worker-results')).filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(readdirSync(join(archived, 'worker-results')).filter((name) => name.endsWith('.sha256')).length, 1);
});

test('dependent worker result accepts divergent reviewed descendants and integrates exact patch', () => {
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

test('actionable integration requires an ancestral central commit with the accepted worker patch', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd);
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result,
    expectedRevision: fixture.advanced.revision,
  });
  const tree = git(cwd, ['rev-parse', `${fixture.centralSha}^{tree}`]);
  const unrelatedSha = git(cwd, ['commit-tree', tree, '-m', 'unrelated integration candidate']);
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
    }), { code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH' });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
  }
  const beforeMismatch = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: accepted.revision,
    nextState: integrationState(fixture.centralSha),
  }), { code: 'WORKER_RESULT_PATCH_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), beforeMismatch);
});

test('dependent worker result rejects missing, nonterminal, or absent dependency ancestry without mutation', () => {
  for (const scenario of [
    { dependencyReference: 'missing', code: 'WORKER_RESULT_DEPENDENCY_NOT_READY' },
    { dependencyReference: 'pending', code: 'WORKER_RESULT_DEPENDENCY_NOT_READY' },
    { centralBase: 'review', code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH' },
    { workerBase: 'review', code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH' },
  ]) {
    const cwd = repo();
    const fixture = dependentWorkerAcceptanceFixture(cwd, scenario);
    const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
    assert.throws(() => checkpointWorkerResultAcceptance({
      cwd, packet: fixture.packet, result: fixture.result,
      expectedRevision: fixture.advanced.revision,
    }), { code: scenario.code });
    assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
  }
});

test('dependent worker result rejects a non-descendant central authority without mutation', () => {
  const cwd = repo();
  const fixture = dependentWorkerAcceptanceFixture(cwd);
  const tree = git(cwd, ['rev-parse', `${fixture.centralSha}^{tree}`]);
  const unrelatedHead = git(cwd, ['commit-tree', tree, '-m', 'unrelated result authority']);
  git(cwd, ['switch', '--detach', unrelatedHead]);
  const unrelated = checkpointGitMetadata({ cwd }).state;
  const before = durableAcceptanceSnapshot(cwd, fixture.packet.taskId);
  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result, expectedRevision: unrelated.revision,
  }), { code: 'WORKER_RESULT_ACCEPTANCE_AUTHORITY_MISMATCH' });
  assert.deepEqual(durableAcceptanceSnapshot(cwd, fixture.packet.taskId), before);
});

test('new and unbound actionable tasks cannot pre-seed or bypass result authority', () => {
  const cwd = repo();
  const initial = init(cwd);
  const unbound = task(initial.currentIntegrationHeadSha, {
    id: 'unbound-authority', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: { ...initial, tasks: [{ ...unbound, workerResultDigest: 'a'.repeat(64) }] },
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [unbound] },
  });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: {
      ...proposed,
      tasks: [{
        ...unbound, status: 'implemented',
        execution: { ...unbound.execution, workerCommitSha: initial.currentIntegrationHeadSha },
      }],
    },
  }), { code: 'TASK_PACKET_NOT_BOUND' });
  const { execution: _execution, ...withoutExecution } = unbound;
  assert.throws(() => checkpointState({
    cwd, expectedRevision: proposed.revision,
    nextState: {
      ...proposed,
      tasks: [{
        ...withoutExecution, status: 'integrated', integratedCommitSha: initial.currentIntegrationHeadSha,
        resolutionSummary: 'Forged unbound integration.',
      }],
    },
  }), { code: 'TASK_PACKET_NOT_BOUND' });
});

test('native-v3 backfill proves central patch equivalence and migrations do not synthesize results', () => {
  const cwd = repo();
  const initial = init(cwd);
  const proposedTask = task(initial.currentIntegrationHeadSha, {
    id: 'backfill-result', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const packet = taskPacket(initial.currentIntegrationHeadSha, proposedTask.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const bound = bindPacket(cwd, proposed, packet);
  git(cwd, ['switch', '-c', 'backfill-worker']);
  const workerSha = commit(cwd, { 'scripts/backfill-result.mjs': 'export const backfill = true;\n' }, 'backfill worker');
  git(cwd, ['switch', 'main']);
  git(cwd, ['cherry-pick', workerSha]);
  const centralSha = git(cwd, ['rev-parse', 'HEAD']);
  const advanced = checkpointGitMetadata({ cwd }).state;
  const { execution: _execution, ...boundTask } = advanced.tasks[0];
  const preBoundary = {
    ...advanced,
    tasks: [{
      ...boundTask, status: 'integrated', integratedCommitSha: centralSha,
      resolutionSummary: 'Integrated before durable result acceptance existed.',
    }],
  };
  writeFileSync(statePath(cwd, preBoundary.prNumber), `${JSON.stringify(preBoundary)}\n`);
  const result = workerResult(packet, workerSha, ['scripts/backfill-result.mjs']);
  const backfilled = checkpointWorkerResultBackfill({
    cwd, packet, result, expectedRevision: preBoundary.revision,
  });
  assert.match(backfilled.tasks[0].workerResultDigest, /^[0-9a-f]{64}$/u);
  assert.equal(checkpointWorkerResultBackfill({
    cwd, packet, result, expectedRevision: backfilled.revision,
  }).revision, backfilled.revision);

  git(cwd, ['switch', '-c', 'mismatched-worker', packet.reviewedHeadSha]);
  const mismatchSha = commit(cwd, { 'scripts/backfill-result.mjs': 'export const mismatch = true;\n' }, 'mismatched worker');
  git(cwd, ['switch', 'main']);
  const mismatchResult = workerResult(packet, mismatchSha, ['scripts/backfill-result.mjs']);
  const unboundEvidenceState = {
    ...backfilled,
    tasks: backfilled.tasks.map(({ workerResultDigest: _digest, ...item }) => item),
  };
  writeFileSync(statePath(cwd, unboundEvidenceState.prNumber), `${JSON.stringify(unboundEvidenceState)}\n`);
  assert.throws(() => checkpointWorkerResultBackfill({
    cwd, packet, result: mismatchResult, expectedRevision: unboundEvidenceState.revision,
  }), { code: 'WORKER_RESULT_PATCH_MISMATCH' });

  const migrated = migratePrReviewStateV2(schemaV2State({
    ...initial,
    tasks: [task(initial.currentIntegrationHeadSha, { id: 'migrated-no-result' })],
  }), { migratedAt: AT });
  assert.equal(Object.hasOwn(migrated.tasks[0], 'workerResultDigest'), false);
});

test('initialization accepts only an explicit positive review request limit', () => {
  const limited = init(repo(), { reviewRequestLimit: 7 });
  assert.equal(limited.reviewRequestLimit, 7);
  for (const reviewRequestLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    assert.throws(
      () => init(repo(), { reviewRequestLimit }),
      { code: 'INVALID_REVIEW_REQUEST_LIMIT' },
    );
  }
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

test('GitHub request owner lock awaits async work and dispatch claims are revision-bound', async () => {
  const cwd = repo();
  const initial = init(cwd);
  let release;
  const held = withGitHubRequestOwnerLock(cwd, 17, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => withGitHubRequestOwnerLock(cwd, 17, () => {}, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  release();
  await held;
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'owner result'), 'owner result');
  const ownerFailure = new Error('owner failed');
  await assert.rejects(
    () => withGitHubRequestOwnerLock(cwd, 17, () => { throw ownerFailure; }),
    (error) => error === ownerFailure,
  );
  await withGitHubRequestOwnerLock(cwd, 17, () => {});

  const intent = { type: 'request', operationId: `request:17:discovery:1:${initial.currentIntegrationHeadSha}`,
    clientMutationId: 'dispatch-correlation', at: AT, excludedCommentIds: [] };
  ensureGitHubMutationIntent(cwd, 17, intent);
  const first = claimGitHubMutationDispatch(cwd, 17, intent, initial.revision);
  assert.equal(first.isNew, true);
  assert.equal(claimGitHubMutationDispatch(cwd, 17, intent, initial.revision).isNew, false);
  assert.throws(() => claimGitHubMutationDispatch(cwd, 17, intent, initial.revision + 1), { code: 'STATE_REVISION_CONFLICT' });
  assert.throws(() => claimGitHubMutationDispatch(cwd, 17, { ...intent, clientMutationId: 'conflict' }, initial.revision), { code: 'INTENT_RECOVERY_INVALID' });

  const raceCwd = repo();
  const race = init(raceCwd);
  ensureGitHubMutationIntent(raceCwd, 17, intent);
  assert.throws(() => claimGitHubMutationDispatch(raceCwd, 17, intent, race.revision + 1), { code: 'STATE_REVISION_CONFLICT' });
  const raceEvents = readFileSync(join(stateDirectory(raceCwd, 17), 'events.ndjson'), 'utf8');
  assert.equal(raceEvents.includes('github-mutation-dispatch'), false);

  const missingCwd = repo();
  const missing = init(missingCwd);
  assert.throws(() => claimGitHubMutationDispatch(missingCwd, 17, intent, missing.revision), { code: 'INTENT_RECOVERY_INVALID' });
  writeFileSync(join(stateDirectory(missingCwd, 17), 'events.ndjson'), '{bad json}\n');
  assert.throws(() => claimGitHubMutationDispatch(missingCwd, 17, intent, missing.revision), { code: 'INTENT_RECOVERY_INVALID' });
});

test('state lock recovers from SIGKILL and keeps the replacement owner exclusive', async () => {
  const cwd = repo();
  init(cwd);
  const path = join(reviewRoot(cwd), 'locks', 'pr-17.state-lock.sqlite');
  const crashed = spawnLockHolder(cwd, 'state', 10_000);
  await waitForLockHolder(crashed);
  crashed.kill('SIGKILL');
  assert.deepEqual(await waitForChildExit(crashed), { code: null, signal: 'SIGKILL' });
  assert.equal(existsSync(path), true);

  const replacement = spawnLockHolder(cwd, 'state', 300);
  await waitForLockHolder(replacement);
  assert.throws(
    () => withStateLock(cwd, 17, () => {}, { timeoutMs: 60 }),
    { code: 'STATE_LOCK_TIMEOUT' },
  );
  assert.deepEqual(await waitForChildExit(replacement), { code: 0, signal: null });
  assert.equal(withStateLock(cwd, 17, () => 'state result'), 'state result');
  const stateFailure = new Error('state failed');
  assert.throws(() => withStateLock(cwd, 17, () => { throw stateFailure; }), (error) => error === stateFailure);
  assert.equal(existsSync(path), true);
});

test('GitHub request lock recovers from SIGKILL and keeps the replacement owner exclusive', async () => {
  const cwd = repo();
  init(cwd);
  const path = join(reviewRoot(cwd), 'locks', 'pr-17.github-request-lock.sqlite');
  const crashed = spawnLockHolder(cwd, 'github', 10_000);
  await waitForLockHolder(crashed);
  crashed.kill('SIGKILL');
  assert.deepEqual(await waitForChildExit(crashed), { code: null, signal: 'SIGKILL' });
  assert.equal(existsSync(path), true);

  const replacement = spawnLockHolder(cwd, 'github', 300);
  await waitForLockHolder(replacement);
  await assert.rejects(
    () => withGitHubRequestOwnerLock(cwd, 17, () => {}, { timeoutMs: 60 }),
    { code: 'STATE_LOCK_TIMEOUT' },
  );
  assert.deepEqual(await waitForChildExit(replacement), { code: 0, signal: null });
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request result'), 'request result');
  assert.equal(existsSync(path), true);
});

test('SQLite locks permanently seal both legacy protocol paths', async () => {
  const cwd = repo();
  const locks = join(reviewRoot(cwd), 'locks');
  mkdirSync(locks, { recursive: true });
  const legacyState = join(locks, 'pr-17.lock');
  const legacyRequest = join(locks, 'pr-17.github-request.lock');
  writeFileSync(`${legacyState}.retire-orphan`, 'orphan state claim\n');
  writeFileSync(`${legacyRequest}.retire-orphan`, 'orphan request claim\n');

  assert.equal(withStateLock(cwd, 17, () => 'state result'), 'state result');
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request result'), 'request result');
  assert.equal(existsSync(join(locks, 'pr-17.state-lock.sqlite')), true);
  assert.equal(existsSync(join(locks, 'pr-17.github-request-lock.sqlite')), true);
  assert.equal(statSync(legacyState).isDirectory(), true);
  assert.equal(statSync(legacyRequest).isDirectory(), true);
  assert.throws(() => openSync(legacyState, 'wx'), { code: 'EEXIST' });
  assert.throws(() => openSync(legacyRequest, 'wx'), { code: 'EEXIST' });
  assert.equal(existsSync(`${legacyState}.retire-orphan`), true);
  assert.equal(existsSync(`${legacyRequest}.retire-orphan`), true);
});

test('legacy file owners block both new lock callbacks until explicit safe release', async () => {
  const cwd = repo();
  const locks = join(reviewRoot(cwd), 'locks');
  mkdirSync(locks, { recursive: true });
  const legacyState = join(locks, 'pr-17.lock');
  const legacyRequest = join(locks, 'pr-17.github-request.lock');
  const liveOwner = `${JSON.stringify({
    token: 'live-owner', pid: process.pid, hostname: 'same-host', createdAt: AT,
  })}\n`;
  writeFileSync(legacyState, liveOwner);
  writeFileSync(legacyRequest, liveOwner);

  let stateCallbackRan = false;
  assert.throws(() => withStateLock(cwd, 17, () => {
    stateCallbackRan = true;
  }, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  assert.equal(stateCallbackRan, false);
  assert.equal(readFileSync(legacyState, 'utf8'), liveOwner);

  let requestCallbackRan = false;
  await assert.rejects(() => withGitHubRequestOwnerLock(cwd, 17, () => {
    requestCallbackRan = true;
  }, { timeoutMs: 10 }), { code: 'STATE_LOCK_TIMEOUT' });
  assert.equal(requestCallbackRan, false);
  assert.equal(readFileSync(legacyRequest, 'utf8'), liveOwner);

  const stateRelease = spawnLegacyLockRelease(legacyState, 40);
  assert.equal(withStateLock(cwd, 17, () => 'state migrated'), 'state migrated');
  assert.deepEqual(await waitForChildExit(stateRelease), { code: 0, signal: null });

  const requestRelease = new Promise((resolveRelease) => {
    setTimeout(() => {
      unlinkSync(legacyRequest);
      resolveRelease();
    }, 40);
  });
  assert.equal(await withGitHubRequestOwnerLock(cwd, 17, () => 'request migrated'), 'request migrated');
  await requestRelease;
  assert.equal(statSync(legacyState).isDirectory(), true);
  assert.equal(statSync(legacyRequest).isDirectory(), true);
});

test('verification collection escalation is guarded, append-only, request-bound, and human-gated', () => {
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
  const limitedEscalation = checkpointReviewRequestLimit({
    cwd, expectedRevision: escalated.revision, reviewRequestLimit: 9,
  });
  assert.equal(limitedEscalation.phase, 'awaiting-human-decision');
  assert.deepEqual(limitedEscalation.verificationEscalation, escalation);
  assert.ok(reviewRequestGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.ok(completionGate(escalated, external(cwd, escalated)).reasons.some(
    (reason) => reason.includes('verification collection escalation'),
  ));
  assert.throws(() => checkpointState({
    cwd, expectedRevision: limitedEscalation.revision,
    nextState: { ...limitedEscalation, verificationEscalation: null },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointState({
    cwd, expectedRevision: limitedEscalation.revision,
    nextState: {
      ...limitedEscalation,
      verificationEscalation: { ...escalation, evidenceIds: ['review:rewritten'] },
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.deepEqual(checkpointVerificationEscalation({
    cwd, expectedRevision: limitedEscalation.revision, escalation,
  }), limitedEscalation);

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

test('stale verification HEAD drift remains recoverable and cannot be mislabeled as ambiguity', () => {
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
  assert.equal(drifted.phase, 'recovering');
  assert.throws(() => checkpointVerificationEscalation({
    cwd, expectedRevision: drifted.revision,
    escalation: {
      requestId: requested.reviewRequest.id, requestHeadSha: requestHead, observedPrHeadSha: observedPrHead,
      headRelation: 'changed', evidenceIds: [`request:${requested.reviewRequest.id}`],
      reason: 'request-head-drift', at: AT,
    },
  }), { code: 'VERIFICATION_ESCALATION_NOT_EXPECTED' });
  assert.equal(drifted.verificationReviewUsed, true);
  assert.equal(drifted.reviewHistory.at(-1).outcome, null);
});

test('native stale pending verification escalates only canonical evidence ambiguity', () => {
  const cwd = repo();
  const requested = nativeTasklessPendingVerification(cwd).requested;
  const requestHead = requested.reviewRequest.headSha;
  const observedPrHead = commit(cwd, {
    'native-escalation-drift.txt': 'drift\n',
  }, 'native pending escalation drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  const escalated = checkpointVerificationEscalation({
    cwd,
    expectedRevision: drifted.revision,
    escalation: {
      requestId: requested.reviewRequest.id,
      requestHeadSha: requestHead,
      observedPrHeadSha: observedPrHead,
      headRelation: 'changed',
      evidenceIds: ['review:PRR_stale'],
      reason: 'request-head-drift',
      at: AT,
    },
  });
  assert.equal(escalated.phase, 'awaiting-human-decision');
  assert.deepEqual(escalated.reviewHistory, drifted.reviewHistory);
  assert.equal(escalated.reviewOutcome, null);
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
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r9',
      isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
    }],
    threadlessVerification: emptyThreadless(),
  };
  const completed = completeIntegratedTasks({ ...state, tasks }, { threadResolutionStatus: proof });
  assert.ok(completed.tasks.every((item) => item.status === 'completed'));
  assert.equal(completed.threadResolutionStatus.threads.length, 1);
});

test('guarded verifier completion selects only unique integrated local task IDs', () => {
  const cwd = repo();
  const state = init(cwd);
  const head = state.currentIntegrationHeadSha;
  const localA = task(head, { id: 'local-a', status: 'integrated', sourceType: 'local' });
  const localB = task(head, { id: 'local-b', status: 'integrated', sourceType: 'local' });
  const threadless = task(head, {
    id: 'threadless', status: 'integrated', sourceType: 'github-threadless', sourceIds: ['review:threadless'],
  });
  const proof = {
    status: 'passed', headSha: head, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  const unchanged = completeIntegratedTasks(
    { ...state, tasks: [localA, localB, threadless] },
    { threadResolutionStatus: proof },
  );
  assert.deepEqual(unchanged.tasks.map((item) => item.status), ['integrated', 'integrated', 'integrated']);

  const selected = completeIntegratedTasks(
    { ...state, tasks: [localA, localB, threadless] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['local-b'] },
  );
  assert.deepEqual(selected.tasks.map((item) => item.status), ['integrated', 'completed', 'integrated']);
  assert.deepEqual(selected.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: head, taskIds: ['local-b'], updatedAt: AT,
  });

  const selectedA = completeIntegratedTasks(
    { ...state, tasks: [localA, localB] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['local-a'] },
  );
  const accumulated = completeIntegratedTasks(selectedA, {
    threadResolutionStatus: { ...proof, updatedAt: '2026-08-05T00:01:00Z' },
    verifiedLocalTaskIds: ['local-b'],
  });
  assert.deepEqual(accumulated.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: head, taskIds: ['local-a', 'local-b'], updatedAt: '2026-08-05T00:01:00Z',
  });
  const nextHead = 'b'.repeat(40);
  const drifted = {
    ...accumulated,
    currentIntegrationHeadSha: nextHead,
    git: { ...accumulated.git, headSha: nextHead },
    threadResolutionStatus: {
      ...accumulated.threadResolutionStatus, status: 'not-run', headSha: null, updatedAt: null,
    },
  };
  const reattested = completeIntegratedTasks(drifted, {
    threadResolutionStatus: {
      ...proof, headSha: nextHead, updatedAt: '2026-08-05T00:02:00Z',
    },
    verifiedLocalTaskIds: ['local-b'],
  });
  assert.deepEqual(reattested.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: nextHead, taskIds: ['local-b'], updatedAt: '2026-08-05T00:02:00Z',
  });

  const disposedA = task(head, {
    id: 'disposed-a', status: 'not-applicable', disposition: 'duplicate', sourceType: 'local',
  });
  const disposedB = task(head, {
    id: 'disposed-b', status: 'not-applicable', disposition: 'stale', sourceType: 'local',
  });
  const selectedDisposed = completeIntegratedTasks(
    { ...state, tasks: [disposedA, disposedB] },
    { threadResolutionStatus: proof, verifiedLocalTaskIds: ['disposed-b'] },
  );
  assert.deepEqual(selectedDisposed.tasks.map((item) => item.status), ['not-applicable', 'completed']);
  assert.deepEqual(selectedDisposed.threadResolutionStatus.localVerification.taskIds, ['disposed-b']);

  for (const disposition of [
    'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
  ]) {
    const disposed = task(head, {
      id: `disposed-${disposition}`, status: 'not-applicable', disposition, sourceType: 'local',
    });
    assert.equal(completeIntegratedTasks(
      { ...state, tasks: [disposed] },
      { threadResolutionStatus: proof, verifiedLocalTaskIds: [disposed.id] },
    ).tasks[0].status, 'completed');
  }

  const unintegrated = task(head, { id: 'unintegrated', status: 'proposed', sourceType: 'local' });
  const needsHuman = task(head, {
    id: 'needs-human', status: 'not-applicable', disposition: 'needs-human-decision', sourceType: 'local',
  });

  for (const verifiedLocalTaskIds of [
    ['local-a', 'local-a'], ['missing'], ['threadless'], ['unintegrated'], ['needs-human'], [''], 'local-a',
  ]) {
    assert.throws(() => completeIntegratedTasks(
      { ...state, tasks: [localA, localB, threadless, unintegrated, needsHuman] },
      { threadResolutionStatus: proof, verifiedLocalTaskIds },
    ), { code: 'INVALID_TASK_COMPLETION' });
  }
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
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r41', isResolved: true,
    resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
  };
  const second = {
    ...first, threadNodeId: 'PRRT_second', rootCommentNodeId: 'PRRC_second', rootCommentDatabaseId: 42,
    replyId: 'PRRC_reply_2', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r42',
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
  const nextHead = 'b'.repeat(40);
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
  const reconciled = {
    ...state, currentIntegrationHeadSha: nextHead, git: { ...state.git, headSha: nextHead }, tasks,
  };
  const invalidatedProof = {
    ...proof, status: 'not-run', headSha: null, updatedAt: null,
  };
  assert.equal(completeIntegratedTasks(
    reconciled,
    { threadResolutionStatus: invalidatedProof },
  ).tasks[0].status, 'integrated');
  const refreshedProof = {
    ...proof, headSha: nextHead,
    threadlessVerification: { ...proof.threadlessVerification, headSha: nextHead },
  };
  assert.equal(completeIntegratedTasks(
    reconciled,
    { threadResolutionStatus: refreshedProof },
  ).tasks[0].status, 'completed');
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
      replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r10', isResolved: true, resolvedAt: AT,
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
  const integrated = writePreAuthorityTasks(cwd, proposed, [integratedTask]);
  assert.throws(() => checkpointState({
    cwd, expectedRevision: integrated.revision,
    nextState: { ...integrated, tasks: [{ ...integratedTask, status: 'completed' }] },
  }), { code: 'PROTECTED_TRANSITION_REQUIRED' });
  const proofA = {
    status: 'passed', headSha: headA, updatedAt: AT, threadlessVerification: emptyThreadless(),
    threads: [{
      threadNodeId: 'PRRT_drift', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 11,
      taskIds: ['thread-task'],
      disposition: 'fixed', replyId: 'PRRC_reply', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r1',
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

test('HEAD drift preserves historical local verifier proof until guarded current-HEAD re-attestation', () => {
  const cwd = repo();
  const initial = init(cwd);
  const headA = initial.currentIntegrationHeadSha;
  const proposedTask = task(headA, { id: 'local-drift', status: 'proposed', sourceType: 'local' });
  const proposed = checkpointState({
    cwd, expectedRevision: initial.revision, nextState: { ...initial, tasks: [proposedTask] },
  });
  const integratedTask = task(headA, { id: 'local-drift', status: 'integrated', sourceType: 'local' });
  const integrated = writePreAuthorityTasks(cwd, proposed, [integratedTask]);
  const proofA = {
    status: 'passed', headSha: headA, threads: [], threadlessVerification: emptyThreadless(), updatedAt: AT,
  };
  const completed = checkpointTaskCompletion({
    cwd, expectedRevision: integrated.revision, threadResolutionStatus: proofA,
    verifiedLocalTaskIds: ['local-drift'],
  });
  assert.deepEqual(completed.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: headA, taskIds: ['local-drift'], updatedAt: AT,
  });

  const headB = commit(cwd, { 'local-proof-drift.txt': 'drift\n' }, 'local proof drift');
  const drifted = checkpointGitMetadata({ cwd }).state;
  assert.equal(drifted.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(drifted.threadResolutionStatus.localVerification, completed.threadResolutionStatus.localVerification);

  const proofB = {
    status: 'passed', headSha: headB, threads: [], threadlessVerification: emptyThreadless(),
    updatedAt: '2026-08-05T00:01:00Z',
  };
  const refreshed = checkpointTaskCompletion({
    cwd, expectedRevision: drifted.revision, threadResolutionStatus: proofB,
    verifiedLocalTaskIds: ['local-drift'],
  });
  assert.deepEqual(refreshed.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: headB, taskIds: ['local-drift'], updatedAt: '2026-08-05T00:01:00Z',
  });
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
  const integrated = writePreAuthorityTasks(threadlessCwd, proposed, [integratedTask]);
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
  state = bindPacket(cwd, state, packet);
  const boundRevision = state.revision;
  assert.equal(state.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.equal(checkpointTaskPacketBinding({
    cwd, packet: reordered, expectedRevision: state.revision,
  }).revision, boundRevision);
  const weakened = {
    ...packet,
    affectedAreas: ['documentation'],
    requiredValidation: {
      unit: [{ command: 'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs', reason: 'Weakened selection.' }],
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
  const bound = bindPacket(cwd, proposed, packet);
  assert.equal(bound.reviewedHeadSha, null);
  assert.equal(bound.tasks[0].taskPacketDigest, taskPacketDigest(packet));

  const integratedHead = commit(cwd, { 'scripts/integrated-task.mjs': 'export const integrated = true;\n' }, 'integrate task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  assert.equal(advanced.currentIntegrationHeadSha, integratedHead);
  assert.throws(() => assertTaskPacketBound(advanced, packet), { code: 'TASK_PACKET_HEAD_MISMATCH' });
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, packet.taskId, integratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet,
    result: workerResult(packet, integratedHead, ['scripts/integrated-task.mjs']),
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
  const bound = bindPacket(cwd, proposed, packet);
  const integratedHead = commit(cwd, { 'scripts/ancestry-task.mjs': 'export const integrated = true;\n' }, 'integrate ancestry task');
  const advanced = checkpointGitMetadata({ cwd }).state;
  const implementedBeforeAcceptance = writePreAuthorityImplementedState(
    cwd, advanced, packet.taskId, integratedHead,
  );
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet,
    result: workerResult(packet, integratedHead, ['scripts/ancestry-task.mjs']),
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

test('canonical bound packet accepts direct and descendant central integration ancestry only', () => {
  const cwd = repo();
  const { packet, reviewedHead, integratedHead, integrated } = canonicalBoundIntegratedTask(cwd);
  assert.equal(packet.reviewedHeadSha, reviewedHead);
  assert.equal(integrated.reviewedHeadSha, reviewedHead);
  assert.equal(assertTaskPacketBound(integrated, packet).integratedCommitSha, integratedHead);

  const descendantHead = commit(cwd, { 'scripts/canonical-later.mjs': 'export const later = true;\n' }, 'later canonical integration');
  const descendant = checkpointGitMetadata({ cwd }).state;
  assert.equal(assertTaskPacketBound(descendant, packet).integratedCommitSha, integratedHead);
  const plan = buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT });
  assert.deepEqual(plan.taskIds, [packet.taskId]);
  assert.equal(plan.headSha, descendantHead);
  assert.equal(plan.stateRevision, descendant.revision);

  assert.throws(() => assertTaskPacketBound(descendant, {
    ...packet, reviewedHeadSha: integratedHead,
  }), { code: 'TASK_PACKET_HEAD_MISMATCH' });
  assert.throws(() => assertTaskPacketBound(descendant, {
    ...packet, evidence: 'Substituted canonical packet evidence.',
  }), { code: 'TASK_PACKET_CONFLICT' });
});

test('canonical bound packet rejects rollback, unrelated, or missing integration ancestry without proof', () => {
  const cwd = repo();
  const { packet, reviewedHead, integratedHead } = canonicalBoundIntegratedTask(cwd, 'canonical-fail-closed');

  git(cwd, ['switch', '--detach', reviewedHead]);
  const rollback = checkpointGitMetadata({ cwd }).state;
  assert.equal(rollback.currentIntegrationHeadSha, reviewedHead);
  assert.throws(() => assertTaskPacketBound(rollback, packet), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.throws(() => buildTargetedValidationPlan({ cwd, taskPackets: [packet], now: () => AT }), {
    code: 'TASK_INTEGRATION_ANCESTRY_MISMATCH',
  });
  assert.equal(existsSync(validationPlanPath(cwd, rollback.prNumber)), false);
  assert.equal(loadState(cwd).validationStatus.status, 'not-run');

  const tree = git(cwd, ['rev-parse', `${integratedHead}^{tree}`]);
  const unrelatedHead = git(cwd, ['commit-tree', tree, '-m', 'unrelated canonical integration']);
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
    schemaVersion: 3,
    taskId: 'task-a',
    specialization: 'api',
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
  state = bindPacket(cwd, state, packet);
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
      proofCheckpointHeldLock = existsSync(join(reviewRoot(cwd), 'locks', 'pr-17.state-lock.sqlite'));
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

test('schema-v3 packet sidecars are canonical, immutable, digest-verified, and recovery-critical', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['sidecar-task']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'sidecar-task');
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'SPECIALIST_PLAN_REQUIRED' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);

  planSpecialists({ cwd, input: planInput(state, packet), expectedRevision: state.revision, now: () => AT });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
    event: { type: 'x', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(loadState(cwd).tasks[0].taskPacketDigest, undefined);
  const sidecarPath = taskPacketSidecarPath(cwd, state.prNumber, packet.taskId);
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, packet.taskId);
  assert.deepEqual(JSON.parse(readFileSync(sidecarPath, 'utf8')), packet);
  assert.equal(existsSync(provenancePath), true);
  assert.match(readFileSync(provenanceReceiptPath, 'utf8'), /^[0-9a-f]{64}\n$/u);
  const interrupted = reconcileState({ cwd });
  assert.equal(interrupted.packetSidecars.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  assert.equal(interrupted.bindingProvenance.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  rmSync(provenancePath);
  const receiptOnly = reconcileState({ cwd });
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).status, 'pending-binding');
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).path, null);
  assert.equal(receiptOnly.bindingProvenance.find((entry) => entry.taskId === packet.taskId).receiptPath, provenanceReceiptPath);
  state = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  assert.equal(state.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  assert.equal(provenance.phase, 'pre-bind');
  assert.equal(provenance.packetDigest, taskPacketDigest(packet));
  assert.equal(provenance.reviewedHeadSha, packet.reviewedHeadSha);
  assert.equal(provenance.planRevision, state.revision - 1);
  assert.match(provenance.planReceiptDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(provenance.planningSignals, {
    browserVisible: false, testSelectionUncertain: false,
  });
  assert.equal(provenance.behaviorMapperResult, null);

  writeFileSync(sidecarPath, `${JSON.stringify({ ...packet, evidence: 'tampered' })}\n`);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  assert.throws(() => buildTargetedValidationPlan({ cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  const recovery = reconcileState({ cwd });
  assert.equal(recovery.packetSidecars[0].status, 'invalid');
  assert.equal(recovery.specialist.status, 'stale');
  assert.equal(recovery.specialist.error, 'TASK_PACKET_REPLAN_REQUIRED');
  assert.deepEqual(recovery.evidenceErrors.map((message) => message.split(':')[0]), [
    'Task sidecar-task packet sidecar', 'Specialist review bundle is invalid',
  ]);
});

test('a stale packet binder cannot create a sidecar after revision drift', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['raced-task']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'raced-task');
  planSpecialists({ cwd, input: planInput(state, packet), expectedRevision: state.revision, now: () => AT });
  checkpointState({
    cwd, expectedRevision: state.revision,
    nextState: { ...state, nextAction: 'A concurrent orchestrator checkpoint won the revision.' },
  });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);
});

test('active legacy-bound tasks fail with the dedicated replan error before rebinding or result acceptance', () => {
  const cwd = repo();
  const state = integratedTasks(cwd, ['legacy-active']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'legacy-active');
  const historicalV2 = Object.fromEntries(Object.entries(packet)
    .filter(([key]) => !['specialization', 'riskTags'].includes(key))
    .map(([key, value]) => [key, key === 'schemaVersion' ? 2 : value]));
  const legacyBound = {
    ...state,
    tasks: state.tasks.map((taskItem) => ({ ...taskItem, taskPacketDigest: taskPacketDigest(historicalV2) })),
  };
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(legacyBound)}\n`);
  assert.throws(
    () => checkpointTaskPacketBinding({ cwd, packet, expectedRevision: legacyBound.revision }),
    { code: 'TASK_PACKET_REPLAN_REQUIRED' },
  );
  assert.throws(() => assertTaskPacketBound(legacyBound, packet, { cwd }), {
    code: 'TASK_PACKET_REPLAN_REQUIRED',
  });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId)), false);
});

test('migration-origin v2 binding replanning is guarded, neutral, and followed by explicit v3 planning', () => {
  const cwd = repo();
  const opaqueTaskId = 'legacy, task "quoted"';
  const { state: migrated, packet, backupPath } = migrateV2BoundTask(cwd, { taskId: opaqueTaskId });
  const backup = readFileSync(backupPath, 'utf8');
  assert.equal(migrated.tasks[0].status, 'proposed');
  assert.equal(typeof migrated.tasks[0].taskPacketDigest, 'string');
  assert.throws(() => checkpointState({
    cwd,
    expectedRevision: migrated.revision,
    nextState: {
      ...migrated,
      tasks: migrated.tasks.map(({ taskPacketDigest: _digest, ...taskItem }) => taskItem),
    },
  }), { code: 'IMMUTABLE_STATE_PROVENANCE' });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: migrated.revision + 1,
  }), { code: 'STATE_REVISION_CONFLICT' });
  assert.equal(existsSync(taskPacketSidecarPath(cwd, migrated.prNumber, opaqueTaskId)), false);

  const replanned = checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: migrated.revision,
  });
  const replannedTask = replanned.tasks[0];
  assert.equal(replannedTask.status, 'proposed');
  assert.equal(Object.hasOwn(replannedTask, 'taskPacketDigest'), false);
  assert.equal(replannedTask.integratedCommitSha, null);
  assert.equal(replannedTask.resolutionSummary, null);
  assert.deepEqual(replannedTask.execution, {
    dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
    workerCommitSha: null, validationSummaries: [], lastError: null,
  });
  assert.equal(replanned.phase, 'recovering');
  assert.equal(readFileSync(backupPath, 'utf8'), backup);
  assert.equal(existsSync(taskPacketSidecarPath(cwd, replanned.prNumber, opaqueTaskId)), false);
  assert.equal(existsSync(taskBindingProvenancePath(cwd, replanned.prNumber, opaqueTaskId)), false);

  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: replanned.revision,
  }), { code: 'SPECIALIST_PLAN_REQUIRED' });
  planSpecialists({
    cwd, input: planInput(replanned, packet), expectedRevision: replanned.revision, now: () => AT,
  });
  const rebound = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: replanned.revision,
  });
  assert.equal(rebound.tasks[0].taskPacketDigest, taskPacketDigest(packet));
  assert.equal(existsSync(taskPacketSidecarPath(cwd, rebound.prNumber, opaqueTaskId)), true);
  assert.equal(existsSync(taskBindingProvenancePath(cwd, rebound.prNumber, opaqueTaskId)), true);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd, taskId: opaqueTaskId, expectedRevision: rebound.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
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

test('v2 replan preserves integrated facts, invalidates targeted proof, and rejects unsafe provenance', () => {
  const integratedCwd = repo();
  const integratedSetup = migrateV2BoundTask(integratedCwd, { status: 'integrated' });
  const validated = checkpointSyntheticTargetedValidation(integratedCwd, integratedSetup.state);
  const integratedTask = structuredClone(validated.tasks[0]);
  const replanned = checkpointTaskPacketReplan({
    cwd: integratedCwd, taskId: integratedTask.id, expectedRevision: validated.revision,
  });
  assert.equal(replanned.tasks[0].status, 'integrated');
  assert.equal(replanned.tasks[0].integratedCommitSha, integratedTask.integratedCommitSha);
  assert.equal(replanned.tasks[0].resolutionSummary, integratedTask.resolutionSummary);
  assert.equal(Object.hasOwn(replanned.tasks[0], 'execution'), false);
  assert.equal(Object.hasOwn(replanned.tasks[0], 'taskPacketDigest'), false);
  assert.equal(replanned.validationStatus.status, 'not-run');

  for (const status of ['queued', 'running', 'implemented']) {
    const activeCwd = repo();
    const active = migrateV2BoundTask(activeCwd, { status });
    assert.throws(() => checkpointTaskPacketReplan({
      cwd: activeCwd, taskId: 'legacy-active', expectedRevision: active.state.revision,
    }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
    assert.equal(loadState(activeCwd).tasks[0].status, status);
    assert.equal(loadState(activeCwd).tasks[0].taskPacketDigest, taskPacketDigest(active.historicalPacket));
  }

  const assignedCwd = repo();
  const assigned = migrateV2BoundTask(assignedCwd, {
    status: 'proposed', taskOverrides: { execution: { worker: 'review_fix_worker' } },
  });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: assignedCwd, taskId: 'legacy-active', expectedRevision: assigned.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(loadState(assignedCwd).tasks[0].execution.worker, 'review_fix_worker');

  for (const status of ['blocked', 'failed']) {
    const neutralCwd = repo();
    const neutral = migrateV2BoundTask(neutralCwd, { status });
    const safelyReplanned = checkpointTaskPacketReplan({
      cwd: neutralCwd, taskId: 'legacy-active', expectedRevision: neutral.state.revision,
    });
    assert.equal(safelyReplanned.tasks[0].status, 'proposed');
    assert.equal(safelyReplanned.tasks[0].taskPacketDigest, undefined);
    assert.deepEqual(safelyReplanned.tasks[0].execution, {
      dependencies: [], ownedPaths: [], worker: null, branch: null, worktree: null,
      workerCommitSha: null, validationSummaries: [], lastError: null,
    });
  }

  const nativeCwd = repo();
  const native = integratedTasks(nativeCwd, ['legacy-active']);
  const legacyPacket = historicalTaskPacketV2(taskPacket(native.currentIntegrationHeadSha, 'legacy-active'));
  writeFileSync(statePath(nativeCwd, native.prNumber), `${JSON.stringify({
    ...native,
    tasks: native.tasks.map((taskItem) => ({
      ...taskItem, taskPacketDigest: taskPacketDigest(legacyPacket),
    })),
  })}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: nativeCwd, taskId: 'legacy-active', expectedRevision: native.revision,
  }), { code: 'TASK_PACKET_REPLAN_PROVENANCE_INVALID' });

  const tamperedCwd = repo();
  const tampered = migrateV2BoundTask(tamperedCwd);
  const backup = JSON.parse(readFileSync(tampered.backupPath, 'utf8'));
  backup.tasks[0].taskPacketDigest = 'f'.repeat(64);
  writeFileSync(tampered.backupPath, `${JSON.stringify(backup)}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: tamperedCwd, taskId: 'legacy-active', expectedRevision: tampered.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_PROVENANCE_INVALID' });

  const sidecarCwd = repo();
  const sidecar = migrateV2BoundTask(sidecarCwd);
  mkdirSync(join(stateDirectory(sidecarCwd, 17), 'task-packets'), { recursive: true });
  writeFileSync(taskPacketSidecarPath(sidecarCwd, 17, 'legacy-active'), '{}\n');
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: sidecarCwd, taskId: 'legacy-active', expectedRevision: sidecar.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(existsSync(taskPacketSidecarPath(sidecarCwd, 17, 'legacy-active')), true);

  const receiptCwd = repo();
  const receipt = migrateV2BoundTask(receiptCwd);
  const receiptPath = taskBindingProvenanceReceiptPath(receiptCwd, 17, 'legacy-active');
  mkdirSync(join(stateDirectory(receiptCwd, 17), 'task-binding-provenance'), { recursive: true });
  writeFileSync(receiptPath, `${'f'.repeat(64)}\n`);
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: receiptCwd, taskId: 'legacy-active', expectedRevision: receipt.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
  assert.equal(existsSync(receiptPath), true);

  const completedCwd = repo();
  const completed = migrateV2BoundTask(completedCwd, { status: 'completed' });
  assert.throws(() => checkpointTaskPacketReplan({
    cwd: completedCwd, taskId: 'legacy-active', expectedRevision: completed.state.revision,
  }), { code: 'TASK_PACKET_REPLAN_NOT_ALLOWED' });
});

test('a bound schema-v3 task without its sidecar requires explicit replanning while completed v2 remains readable', () => {
  const cwd = repo();
  let state = integratedTasks(cwd, ['missing-sidecar']);
  const packet = taskPacket(state.currentIntegrationHeadSha, 'missing-sidecar');
  state = bindPacket(cwd, state, packet);
  const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, packet.taskId);
  const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, packet.taskId);
  const provenanceReceipt = readFileSync(provenanceReceiptPath, 'utf8');
  rmSync(provenancePath);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(reconcileState({ cwd }).bindingProvenance[0].status, 'invalid');
  assert.match(renderRecoverySummary({ cwd }), /Task binding provenance: missing-sidecar=invalid/u);
  checkpointTaskPacketBinding({ cwd, packet, expectedRevision: state.revision });
  assert.equal(existsSync(provenancePath), true);
  rmSync(provenanceReceiptPath);
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), {
    code: 'INVALID_TASK_BINDING_PROVENANCE',
  });
  assert.equal(readSpecialistStatus({ cwd }).error, 'INVALID_TASK_BINDING_PROVENANCE');
  assert.equal(reconcileState({ cwd }).bindingProvenance[0].status, 'invalid');
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: state.revision,
  }), { code: 'INVALID_TASK_BINDING_PROVENANCE' });
  writeFileSync(provenanceReceiptPath, provenanceReceipt);
  rmSync(taskPacketSidecarPath(cwd, state.prNumber, packet.taskId));
  assert.throws(() => assertTaskPacketBound(state, packet, { cwd }), { code: 'TASK_PACKET_REPLAN_REQUIRED' });
  assert.match(renderRecoverySummary({ cwd }), /missing-sidecar=invalid/u);

  const completedV3 = checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision,
    verifiedLocalTaskIds: ['missing-sidecar'],
    threadResolutionStatus: {
      status: 'passed', headSha: state.currentIntegrationHeadSha, threads: [],
      threadlessVerification: emptyThreadless(),
      localVerification: {
        status: 'passed', headSha: state.currentIntegrationHeadSha,
        taskIds: ['missing-sidecar'], updatedAt: AT,
      },
      updatedAt: AT,
    },
  });
  assert.equal(completedV3.tasks[0].status, 'completed');
  assert.equal(reconcileState({ cwd }).packetSidecars[0].status, 'invalid');

  const historicalV2 = Object.fromEntries(Object.entries(packet)
    .filter(([key]) => !['specialization', 'riskTags'].includes(key))
    .map(([key, value]) => [key, key === 'schemaVersion' ? 2 : value]));
  const completed = {
    ...completedV3,
    tasks: completedV3.tasks.map((item) => ({ ...item, taskPacketDigest: taskPacketDigest(historicalV2) })),
  };
  assert.equal(assertTaskPacketBound(completed, historicalV2, { cwd }).id, packet.taskId);
  rmSync(provenancePath);
  rmSync(provenanceReceiptPath);
  writeFileSync(statePath(cwd, state.prNumber), `${JSON.stringify(schemaV2State(completed))}\n`);
  migrateState({ cwd });
  assert.equal(reconcileState({ cwd }).packetSidecars[0].status, 'historical-v2');
});

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
    result: workerResult(packet, laterIntegratedHead, [
      'scripts/first-dependency.mjs', 'scripts/later-browser-task.mjs',
    ]),
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
    packet, laterIntegratedHead, ['scripts/first-dependency.mjs', 'scripts/later-browser-task.mjs'],
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
  const child = spawn(process.execPath, [fileURLToPath(fixture), cwd, '17', '350'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveLocked, reject) => {
    child.stdout.once('data', (chunk) => chunk.toString().includes('locked') ? resolveLocked() : reject(new Error('not locked')));
    child.once('error', reject);
  });
  assert.throws(() => withStateLock(cwd, 17, () => {}, { timeoutMs: 75 }), { code: 'STATE_LOCK_TIMEOUT' });
  await new Promise((resolveExit, reject) => child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(String(code)))));
});

test('atomic checkpoints leave no temporary files', () => {
  const cwd = repo();
  const state = init(cwd);
  checkpointState({ cwd, nextState: { ...state, nextAction: 'Still recovering.' }, expectedRevision: 0 });
  assert.deepEqual(readdirSync(stateDirectory(cwd, 17)).filter((name) => name.endsWith('.tmp')), []);
});
