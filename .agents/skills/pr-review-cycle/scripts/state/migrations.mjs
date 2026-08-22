import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from '../../../../../scripts/lib/git.mjs';
import { validatePrReviewState, validatePrReviewStateV1 } from '../contracts/contracts.mjs';
import { atomicWriteJson, atomicWriteText, serializeJson } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { appendEvent } from './journal.mjs';
import { activePointerPath, parsePrNumber, stateDirectory, statePath } from './locations.mjs';
import { withStateLock } from './locks.mjs';

function utcNow() { return new Date().toISOString(); }
function emptyLocalVerification() { return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null }; }
function emptyThreadProof() {
  return { status: 'not-run', headSha: null, threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    localVerification: emptyLocalVerification(), updatedAt: null };
}
function emptyTargetedValidation() {
  return { source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null };
}
function emptyCiValidation() {
  return { source: 'github-actions', scope: 'full', status: 'not-run', headSha: null, checks: [],
    checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null };
}

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
function readStateDocument(path) {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
      throw new StateError(`Active state exceeds ${ACTIVE_STATE_LIMIT_BYTES} bytes`, 'STATE_TOO_LARGE');
    }
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(`Unable to read ${path}: ${error.message}`, 'STATE_READ_FAILED');
  }
}
function validateStateForWrite(state) {
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new StateError(`Invalid PR review state:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  if (Buffer.byteLength(serializeJson(state), 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Active state exceeds 65536 bytes', 'STATE_TOO_LARGE');
  }
}
function activePrNumber(cwd) {
  const path = activePointerPath(cwd);
  if (!existsSync(path)) return null;
  try { return parsePrNumber(JSON.parse(readFileSync(path, 'utf8')).prNumber); } catch (error) {
    throw new StateError(`Invalid active PR pointer at ${path}: ${error.message}`, 'INVALID_ACTIVE_POINTER');
  }
}

function unique(values) {
  return [...new Set(values)];
}

function inferLegacySourceType(task) {
  return task.sourceIds.some((id) => /(?:thread|discussion)/iu.test(id)) ? 'github-thread' : 'github-threadless';
}

export function validateIntegrationMap(legacyState, integrationMap) {
  if (integrationMap === undefined || integrationMap === null) return {};
  if (typeof integrationMap !== 'object' || Array.isArray(integrationMap)) {
    throw new StateError('Integration map must be a JSON object from task ID to central SHA', 'INVALID_INTEGRATION_MAP');
  }
  const tasks = new Map(legacyState.tasks.map((task) => [task.id, task]));
  for (const [taskId, sha] of Object.entries(integrationMap)) {
    const task = tasks.get(taskId);
    if (!task) throw new StateError(`Integration map contains unknown task ${taskId}`, 'INVALID_INTEGRATION_MAP');
    if (!['integrated', 'completed'].includes(task.status)) {
      throw new StateError(`Integration map task ${taskId} is not a legacy integrated task`, 'INVALID_INTEGRATION_MAP');
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha)) {
      throw new StateError(`Integration map task ${taskId} has an invalid SHA`, 'INVALID_INTEGRATION_MAP');
    }
  }
  return integrationMap;
}

export function migrateTaskV1(task, integrationMap) {
  const centralSha = integrationMap[task.id] ?? null;
  const wasIntegrated = ['integrated', 'completed'].includes(task.status);
  const status = wasIntegrated ? (centralSha ? 'integrated' : 'implemented') : task.status;
  const migrated = {
    id: task.id,
    sourceIds: unique(task.sourceIds),
    sourceType: inferLegacySourceType(task),
    fingerprint: task.fingerprint,
    summary: task.summary,
    severity: task.severity,
    disposition: task.disposition,
    status,
    integratedCommitSha: centralSha,
    resolutionSummary: status === 'integrated'
      ? task.validationSummaries[0] ?? 'Central integration reconciled; canonical thread verification remains pending.'
      : status === 'not-applicable' ? task.lastError ?? 'Preserved legacy non-applicable disposition.' : null,
  };
  if (['proposed', 'queued', 'running', 'implemented', 'blocked', 'failed'].includes(status)) {
    migrated.execution = {
      dependencies: unique(task.dependencies),
      ownedPaths: unique(task.ownedPaths),
      worker: task.worker,
      branch: task.branch,
      worktree: task.worktree,
      workerCommitSha: task.commitSha,
      validationSummaries: unique(task.validationSummaries),
      lastError: task.lastError,
    };
  }
  return migrated;
}

export function migrateValidationProof(proof, head) {
  if (proof.status === 'passed' && proof.headSha === head && proof.checks.length > 0 && proof.updatedAt !== null) {
    return { source: 'orchestrator', scope: 'targeted', ...proof, checks: unique(proof.checks) };
  }
  if (proof.status === 'failed' && proof.headSha !== null && proof.updatedAt !== null) {
    return { source: 'orchestrator', scope: 'targeted', ...proof, checks: unique(proof.checks) };
  }
  return emptyTargetedValidation();
}

export function migratePrReviewStateV2(legacyState, { migratedAt = utcNow() } = {}) {
  if (!legacyState || legacyState.schemaVersion !== 2) {
    throw new StateError('Expected schema v2 state', 'INVALID_STATE');
  }
  const normalized = Object.prototype.hasOwnProperty.call(legacyState, 'verificationEscalation')
    ? legacyState : { ...legacyState, verificationEscalation: null };
  for (const field of ['ciValidationStatus', 'ciValidationHistory', 'staleDiscoveryDispositions']) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      throw new StateError(`Schema v2 state cannot contain ${field}`, 'INVALID_STATE');
    }
  }
  const wasComplete = normalized.phase === 'complete';
  const validationMustBeRebuilt = normalized.validationStatus?.status === 'passed';
  const latestReview = normalized.reviewHistory?.at(-1);
  const pendingReviewMustBePreserved = normalized.phase === 'awaiting-review'
    && normalized.reviewOutcome === null
    && latestReview?.outcome === null
    && normalized.reviewRequest?.id === latestReview.request?.id
    && latestReview.request?.headSha === normalized.currentIntegrationHeadSha;
  const mustRecover = wasComplete || (validationMustBeRebuilt && !pendingReviewMustBePreserved);
  const migrated = {
    ...normalized,
    schemaVersion: 3,
    revision: normalized.revision + 1,
    validationStatus: emptyTargetedValidation(),
    ciValidationStatus: emptyCiValidation(),
    ciValidationHistory: [],
    staleDiscoveryDispositions: [],
    nextAction: pendingReviewMustBePreserved
      ? 'Collect the pending exact-head review, then reconfirm targeted validation and full GitHub Actions.'
      : wasComplete || validationMustBeRebuilt
        ? 'Reconfirm targeted validation, full GitHub Actions, and the exact review commit after schema v3 migration.'
      : normalized.nextAction,
    phase: mustRecover ? 'recovering' : normalized.phase,
    updatedAt: migratedAt,
  };
  const legacyCompletionPlaceholder = {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: normalized.currentIntegrationHeadSha,
    checks: ['schema-v2 completion invariant validation only'], workflowRunId: 1,
    workflowRunUrl: 'https://github.com/aerstello/schema-v2-migration-placeholder', updatedAt: migratedAt,
  };
  const legacyCompletedLocalTaskIds = (normalized.tasks ?? [])
    .filter((task) => task.sourceType === 'local' && task.status === 'completed')
    .map((task) => task.id).sort();
  const legacyCompletionThreadProof = legacyCompletedLocalTaskIds.length > 0
    && !Object.hasOwn(normalized.threadResolutionStatus, 'localVerification')
    ? {
        ...normalized.threadResolutionStatus,
        localVerification: {
          status: 'passed', headSha: normalized.currentIntegrationHeadSha,
          taskIds: legacyCompletedLocalTaskIds, updatedAt: migratedAt,
        },
      }
    : normalized.threadResolutionStatus;
  const validationCandidate = wasComplete ? {
    ...migrated,
    phase: 'complete',
    validationStatus: migrateValidationProof(normalized.validationStatus, normalized.currentIntegrationHeadSha),
    ciValidationStatus: legacyCompletionPlaceholder,
    ciValidationHistory: [legacyCompletionPlaceholder],
    // This proof exists only to validate the legacy Done invariant. The returned recovering
    // state never treats schema-v2 local completion as current verifier evidence.
    threadResolutionStatus: legacyCompletionThreadProof,
  } : migrated;
  const errors = validatePrReviewState(validationCandidate);
  if (errors.length > 0) {
    throw new StateError(`Unable to migrate schema v2 state:\n- ${errors.join('\n- ')}`, 'STATE_MIGRATION_FAILED');
  }
  return migrated;
}

export function migratePrReviewStateV1(legacyState, {
  migratedAt = utcNow(), integrationMap: suppliedIntegrationMap, isAncestor,
} = {}) {
  const legacyErrors = validatePrReviewStateV1(legacyState);
  if (legacyErrors.length > 0) {
    throw new StateError(`Invalid schema v1 state:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
  }
  const integrationMap = validateIntegrationMap(legacyState, suppliedIntegrationMap);
  if (Object.keys(integrationMap).length > 0 && typeof isAncestor !== 'function') {
    throw new StateError('A Git ancestry verifier is required for every nonempty integration map', 'INVALID_INTEGRATION_MAP');
  }
  if (typeof isAncestor === 'function') {
    for (const [taskId, sha] of Object.entries(integrationMap)) {
      if (!isAncestor(sha, legacyState.currentIntegrationHeadSha)) {
        throw new StateError(`Mapped central commit for ${taskId} is not an ancestor of integration HEAD`, 'INVALID_INTEGRATION_MAP');
      }
    }
  }
  const schemaV2 = {
    schemaVersion: 2,
    revision: legacyState.revision + 1,
    repository: legacyState.repository,
    prNumber: legacyState.prNumber,
    phase: 'recovering',
    baseSha: legacyState.baseSha,
    requestedHeadSha: null,
    reviewedHeadSha: null,
    currentIntegrationHeadSha: legacyState.currentIntegrationHeadSha,
    reviewRound: legacyState.reviewRound,
    verificationReviewUsed: false,
    legacyReviewProvenance: {
      schemaVersion: 1,
      discoveryRounds: legacyState.reviewRound,
      migratedAt,
    },
    releaseBaseline: legacyState.releaseBaseline,
    decisions: [...new Map(legacyState.decisions.map((decision) => [decision.id, decision])).values()],
    tasks: legacyState.tasks.map((task) => migrateTaskV1(task, integrationMap)),
    reviewRequest: null,
    reviewOutcome: null,
    reviewHistory: [],
    verificationEscalation: null,
    threadResolutionStatus: emptyThreadProof(),
    blockedReasons: unique(legacyState.blockedReasons),
    validationStatus: migrateValidationProof(legacyState.validationStatus, legacyState.currentIntegrationHeadSha),
    nextAction: 'Re-establish canonical review and structured thread evidence after schema v1 migration.',
    integrationWorktree: legacyState.integrationWorktree,
    orchestratorSessionId: legacyState.orchestratorSessionId,
    abandonmentReason: null,
    git: legacyState.git,
    updatedAt: migratedAt,
  };
  return migratePrReviewStateV2(schemaV2, { migratedAt });
}

export function migrateState({ cwd = process.cwd(), prNumber, integrationMap } = {}) {
  const activePr = activePrNumber(cwd);
  const selectedPr = prNumber === undefined || prNumber === null ? activePr : parsePrNumber(prNumber);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (activePr !== null && activePr !== selectedPr) {
    throw new StateError(`PR ${activePr} is active; refusing to migrate PR ${selectedPr}`, 'ACTIVE_POINTER_CONFLICT');
  }
  return withStateLock(cwd, selectedPr, () => {
    const lockedActivePr = activePrNumber(cwd);
    if (lockedActivePr !== null && lockedActivePr !== selectedPr) {
      throw new StateError(`PR ${lockedActivePr} is active; refusing to migrate PR ${selectedPr}`, 'ACTIVE_POINTER_CONFLICT');
    }
    const path = statePath(cwd, selectedPr);
    if (!existsSync(path)) throw new StateError(`No state file at ${path}`, 'STATE_NOT_FOUND');
    const legacySource = readFileSync(path, 'utf8');
    const legacy = readStateDocument(path);
    if (legacy.schemaVersion === 3) throw new StateError('State already uses schema v3', 'STATE_ALREADY_MIGRATED');
    const state = legacy.schemaVersion === 1
      ? migratePrReviewStateV1(legacy, {
          integrationMap,
          isAncestor: (ancestor, descendant) => runGit(
            ['merge-base', '--is-ancestor', ancestor, descendant],
            { cwd: legacy.integrationWorktree, allowFailure: true },
          ).status === 0,
        })
      : migratePrReviewStateV2(legacy);
    validateStateForWrite(state);
    const backupPath = join(stateDirectory(cwd, selectedPr), `state.v${legacy.schemaVersion}.backup.json`);
    if (existsSync(backupPath)) {
      const existingSource = readFileSync(backupPath, 'utf8');
      let semanticallyEqual = false;
      try { semanticallyEqual = JSON.stringify(JSON.parse(existingSource)) === JSON.stringify(legacy); } catch { /* fail closed */ }
      if (existingSource !== legacySource && !semanticallyEqual) {
        throw new StateError(`Migration backup differs from current v${legacy.schemaVersion} state at ${backupPath}`, 'MIGRATION_BACKUP_CONFLICT');
      }
    } else {
      atomicWriteText(backupPath, legacySource);
    }
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 3, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, {
      type: 'state-migrated',
      summary: `Migrated PR ${selectedPr} state from schema v${legacy.schemaVersion} to v3`,
    });
    return { state, backupPath };
  });
}
