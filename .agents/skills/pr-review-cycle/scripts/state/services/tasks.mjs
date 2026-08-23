import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { validateTaskPacket } from '../../contracts/contracts.mjs';
import { canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import { assertIntegratedWorkerCommit } from '../git-authority.mjs';
import {
  stateDirectory, taskBindingProvenancePath, taskBindingProvenanceReceiptPath,
  taskPacketSidecarPath,
} from '../locations.mjs';
import { migratePrReviewStateV2 } from '../migrations.mjs';
import { truncate as truncateSummary } from '../recovery.mjs';
import { activePrNumber, loadState, readStateDocument } from '../state-store.mjs';
import {
  assertBehaviorMapperPlanningComplete, buildTaskBindingProvenance,
  persistImmutableTaskBindingProvenance, readBoundTaskBindingProvenance,
  recoverHistoricalTaskBindingPlanning,
} from '../evidence/task-binding.mjs';
import {
  assertTaskPacketHead, persistImmutableTaskPacketSidecar,
  readTaskPacketSidecar as readBoundTaskPacketSidecar, taskPacketDigest,
} from '../evidence/task-packets.mjs';
import {
  persistWorkerResultEvidence, proveWorkerResultEvidence, readAcceptedWorkerResult,
} from '../evidence/worker-results.mjs';
import { isNativeTasklessPendingReviewHeadDriftValidationRecovery } from '../evidence/validation-plans.mjs';
import { reviewLimitNextAction } from '../transitions/review-policy.mjs';
import { completeIntegratedTasks } from '../transitions/tasks.mjs';
import {
  buildTaskPacketBindingTransition, buildTaskPacketReplanTransition,
  buildWorkerResultTransition,
} from '../transitions/transactional-evidence.mjs';

const REPLANNABLE_EXECUTION_STATUSES = new Set(['proposed', 'blocked', 'failed']);
const REPLANNABLE_NEUTRAL_EXECUTION_FIELDS = ['worker', 'branch', 'worktree', 'workerCommitSha'];
const STABLE_TASK_IDENTITY_FIELDS = [
  'id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition',
];

function sameEvidence(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selected;
}
function runProtectedTransaction(options, { onCheckpoint } = {}) {
  const state = checkpointProtectedStateTransaction(options);
  if (state.revision !== options.expectedRevision) {
    onCheckpoint?.(state);
  }
  return state;
}

function assertMigrationOriginV2Binding(cwd, state, task) {
  if (task.disposition !== 'actionable' || typeof task.taskPacketDigest !== 'string'
      || task.status === 'completed'
      || (!REPLANNABLE_EXECUTION_STATUSES.has(task.status) && task.status !== 'integrated')) {
    throw new StateError(
      `Task ${task.id} is not an eligible non-completed actionable v2 binding`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  if (REPLANNABLE_EXECUTION_STATUSES.has(task.status)
      && REPLANNABLE_NEUTRAL_EXECUTION_FIELDS.some((field) => task.execution?.[field] !== null)) {
    throw new StateError(
      `Task ${task.id} still has an active assignment or worker commit and cannot be replanned`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  if (existsSync(taskPacketSidecarPath(cwd, state.prNumber, task.id))
      || existsSync(taskBindingProvenancePath(cwd, state.prNumber, task.id))
      || existsSync(taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id))) {
    throw new StateError(
      `Task ${task.id} has schema-v3 sidecar evidence and cannot use legacy replanning`,
      'TASK_PACKET_REPLAN_NOT_ALLOWED',
    );
  }
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath)) {
    throw new StateError(
      `Task ${task.id} has no immutable schema-v2 migration backup`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  let legacy;
  try {
    legacy = readStateDocument(backupPath);
    if (legacy.schemaVersion !== 2) throw new Error('backup is not schema v2');
    migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
  } catch (error) {
    throw new StateError(
      `Task ${task.id} schema-v2 migration backup is invalid: ${error.message}`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  if (legacy.repository !== state.repository || legacy.prNumber !== state.prNumber
      || legacy.baseSha !== state.baseSha
      || resolve(legacy.integrationWorktree) !== resolve(state.integrationWorktree)
      || !sameEvidence(legacy.releaseBaseline, state.releaseBaseline)
      || !sameEvidence(legacy.legacyReviewProvenance, state.legacyReviewProvenance)
      || state.revision < legacy.revision + 1) {
    throw new StateError(
      `Task ${task.id} schema-v2 migration backup does not match active state identity`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
  const legacyTask = legacy.tasks.find((candidate) => candidate.id === task.id);
  if (!legacyTask || legacyTask.status === 'completed'
      || legacyTask.disposition !== 'actionable'
      || legacyTask.taskPacketDigest !== task.taskPacketDigest
      || STABLE_TASK_IDENTITY_FIELDS.some((field) => !sameEvidence(legacyTask[field], task[field]))) {
    throw new StateError(
      `Task ${task.id} binding is not proven by the immutable schema-v2 migration backup`,
      'TASK_PACKET_REPLAN_PROVENANCE_INVALID',
    );
  }
}

export function checkpointTaskPacketReplan({
  cwd = process.cwd(), prNumber, taskId, expectedRevision, event,
} = {}) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new StateError('Task replanning requires one opaque nonempty task ID', 'INVALID_TASK_PACKET_REPLAN');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError('Task replanning requires an expected non-negative revision', 'INVALID_TASK_PACKET_REPLAN');
  }
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'task-packet-replan',
    transaction: (current) => {
      const task = current.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new StateError(`Task ${taskId} was not found`, 'TASK_PACKET_REPLAN_NOT_ALLOWED');
      assertMigrationOriginV2Binding(cwd, current, task);
      return {
        nextState: buildTaskPacketReplanTransition(current, taskId),
        event: event ?? {
          type: 'task-packet-replan',
          summary: `Cleared migration-origin schema-v2 packet binding for task ${taskId}`,
        },
      };
    },
  });
}

export function checkpointTaskPacketBinding({
  cwd = process.cwd(), prNumber, packet, expectedRevision, event,
} = {}) {
  const errors = validateTaskPacket(packet);
  if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'task-packet-binding',
    transaction: (current) => {
      const task = current.tasks.find((candidate) => candidate.id === packet.taskId);
      if (!task || task.disposition !== 'actionable') {
        throw new StateError('Task packet must match an actionable durable task', 'TASK_PACKET_NOT_BOUND');
      }
      const digest = taskPacketDigest(packet);
      if (task.taskPacketDigest) {
        const durablePacket = readBoundTaskPacketSidecar(cwd, current, task, { suppliedPacket: packet });
        assertTaskPacketHead(current, task, packet, digest);
        if (task.taskPacketDigest !== digest) {
          throw new StateError('Task packet differs from the accepted packet', 'TASK_PACKET_CONFLICT');
        }
        const provenancePath = taskBindingProvenancePath(cwd, current.prNumber, task.id);
        if (existsSync(provenancePath)) {
          readBoundTaskBindingProvenance(cwd, current, task, durablePacket);
          return { nextState: current, result: current, noWrite: true };
        } else {
          const planning = recoverHistoricalTaskBindingPlanning(cwd, current, durablePacket);
          const provenance = buildTaskBindingProvenance(current, durablePacket, planning);
          return {
            nextState: current,
            result: current,
            noWrite: true,
            beforeCommit: () => {
              persistImmutableTaskBindingProvenance(
                cwd, current, task, durablePacket, provenance,
              );
            },
          };
        }
      }
      assertTaskPacketHead(current, task, packet, digest);
      if (packet.schemaVersion !== 3) {
        throw new StateError('New task packet bindings require explicit schema v3 instructions', 'TASK_PACKET_V3_REQUIRED');
      }
      const planning = assertBehaviorMapperPlanningComplete(cwd, current, packet);
      const provenance = buildTaskBindingProvenance(current, packet, planning);
      return {
        nextState: buildTaskPacketBindingTransition(current, packet.taskId, digest),
        event: event ?? { type: 'task-packet-bound', summary: `Bound accepted packet for task ${packet.taskId}` },
        beforeCommit: () => {
          persistImmutableTaskPacketSidecar(cwd, current, packet, digest);
          persistImmutableTaskBindingProvenance(cwd, current, task, packet, provenance);
        },
      };
    },
  });
}

function preflightWorkerResultAcceptance({ cwd, state, packet, result, backfill }) {
  const task = state?.tasks?.find((candidate) => candidate.id === packet?.taskId);
  if (!task) throw new StateError('Worker result does not match a durable task', 'TASK_PACKET_NOT_BOUND');
  const packetErrors = validateTaskPacket(packet);
  if (packetErrors.length > 0) throw new StateError(`Invalid task packet:\n- ${packetErrors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  if (typeof task.taskPacketDigest !== 'string') {
    throw new StateError('Worker result does not match a durably bound task packet', 'TASK_PACKET_NOT_BOUND');
  }
  if (task.disposition !== 'actionable' || task.taskPacketDigest !== taskPacketDigest(packet)) {
    throw new StateError('Worker result does not match the accepted packet binding', 'TASK_PACKET_CONFLICT');
  }
  const durablePacket = readBoundTaskPacketSidecar(cwd, state, task);
  if (canonicalSerializedJson(durablePacket) !== canonicalSerializedJson(packet)) {
    throw new StateError('Worker result packet differs from its durable sidecar', 'TASK_PACKET_CONFLICT');
  }
  const { authority, envelope } = proveWorkerResultEvidence({ cwd, state, task, packet, result });
  if (typeof task.workerResultDigest === 'string') {
    if (backfill && !['integrated', 'completed'].includes(task.status)) {
      throw new StateError('Worker-result backfill requires an Integrated native schema-v3 task', 'WORKER_RESULT_BACKFILL_NOT_ALLOWED');
    }
    const existing = readAcceptedWorkerResult(cwd, state, task, packet);
    if (canonicalSerializedJson(existing) !== canonicalSerializedJson(envelope)) {
      throw new StateError(`Task ${task.id} already has different accepted worker evidence`, 'WORKER_RESULT_CONFLICT');
    }
    return { authority, envelope, task, nextState: state, idempotent: true };
  }
  if (backfill) {
    if (!['integrated', 'completed'].includes(task.status)) {
      throw new StateError('Worker-result backfill requires an Integrated native schema-v3 task', 'WORKER_RESULT_BACKFILL_NOT_ALLOWED');
    }
    for (const version of [1, 2]) {
      const backupPath = join(stateDirectory(cwd, state.prNumber), `state.v${version}.backup.json`);
      if (!existsSync(backupPath)) continue;
      try {
        const legacy = readJsonSidecar(backupPath, `schema-v${version} migration backup`);
        if (legacy.tasks?.some((candidate) => candidate.id === task.id)) {
          throw new StateError(
            `Task ${task.id} originated in schema v${version}; migration cannot synthesize its result`,
            'WORKER_RESULT_BACKFILL_NOT_ALLOWED',
          );
        }
      } catch (error) {
        if (error instanceof StateError && error.code === 'WORKER_RESULT_BACKFILL_NOT_ALLOWED') throw error;
        throw new StateError(
          `Cannot prove task ${task.id} is native schema v3: ${error.message}`,
          'WORKER_RESULT_BACKFILL_NOT_ALLOWED',
        );
      }
    }
    assertIntegratedWorkerCommit(cwd, state, task, packet, result);
  } else {
    if (!['proposed', 'queued', 'running', 'implemented'].includes(task.status)) {
      throw new StateError(`Task ${task.id} cannot accept a worker result while ${task.status}`, 'WORKER_RESULT_ACCEPTANCE_NOT_ALLOWED');
    }
    if (task.status === 'implemented') assertIntegratedWorkerCommit(cwd, state, task, packet, result);
  }
  const validationSummaries = result.validation.map((entry) => truncateSummary(
    `${entry.command}: ${entry.result} — ${entry.summary}`, 1000,
  ));
  return {
    authority, envelope, task,
    nextState: buildWorkerResultTransition(state, {
      taskId: task.id, envelope, result, backfill, validationSummaries,
    }),
    idempotent: false,
  };
}

function checkpointWorkerResultEvidence({
  cwd, prNumber, packet, result, expectedRevision, backfill, event, onStep,
}) {
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    requireExpectedRevision: true,
    transitionKind: backfill ? 'worker-result-backfill' : 'worker-result-acceptance',
    transaction: (current) => {
      const preflight = preflightWorkerResultAcceptance({ cwd, state: current, packet, result, backfill });
      if (preflight.idempotent) {
        return { nextState: current, result: current, noWrite: true };
      }
      return {
        nextState: preflight.nextState,
        event: event ?? {
          type: backfill ? 'worker-result-backfilled' : 'worker-result-accepted',
          summary: `${backfill ? 'Backfilled' : 'Accepted'} worker result for task ${preflight.task.id}`,
        },
        beforeCommit: () => {
          persistWorkerResultEvidence(
            cwd, current, preflight.task, preflight.envelope, onStep,
          );
        },
      };
    },
  }, { onCheckpoint: () => onStep?.('state-checkpointed') });
}

export function checkpointWorkerResultAcceptance({
  cwd = process.cwd(), prNumber, packet, result, expectedRevision, event, onStep,
  preflightOnly = false,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  if (preflightOnly) {
    const current = loadState(cwd, pr);
    if (!current) throw new StateError('No active PR state for worker-result acceptance', 'STATE_NOT_FOUND');
    return preflightWorkerResultAcceptance({ cwd, state: current, packet, result, backfill: false });
  }
  return checkpointWorkerResultEvidence({
    cwd, prNumber: pr, packet, result, expectedRevision, backfill: false, event, onStep,
  });
}

export function checkpointWorkerResultBackfill({
  cwd = process.cwd(), prNumber, packet, result, expectedRevision, event, onStep,
} = {}) {
  return checkpointWorkerResultEvidence({
    cwd, prNumber, packet, result, expectedRevision, backfill: true, event, onStep,
  });
}

function staleDiscoveryDispositionList(state) {
  return Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
}
function staleDiscoveryDispositionForRequest(state, requestId = state?.reviewRequest?.id) {
  return staleDiscoveryDispositionList(state)
    .find((disposition) => disposition.requestId === requestId) ?? null;
}

export function checkpointTaskCompletion(options = {}) {
  const {
    cwd = process.cwd(), prNumber, threadResolutionStatus, verifiedLocalTaskIds = [],
    staleDiscoveryDisposition = null, expectedRevision, event,
  } = options;
  if (Object.hasOwn(options, 'archiveImportEnvelope')) {
    throw new StateError('Ordinary task completion cannot accept archive import authorization', 'PROTECTED_ARCHIVE_IMPORT_REQUIRED');
  }
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'task-completion',
    transaction: (current) => {
      const priorDispositionCount = staleDiscoveryDispositionList(current).length;
      let nextState = completeIntegratedTasks(current, {
        threadResolutionStatus, verifiedLocalTaskIds, staleDiscoveryDisposition,
      });
      const dispositionAppended = staleDiscoveryDispositionList(nextState).length
        === priorDispositionCount + 1;
      const recoveryDisposition = staleDiscoveryDispositionForRequest(nextState);
      if (dispositionAppended && recoveryDisposition.evidence.outcome === 'findings') {
        nextState = {
          ...nextState, phase: 'triaging',
          threadResolutionStatus: {
            ...nextState.threadResolutionStatus, status: 'not-run', headSha: null, updatedAt: null,
          },
          nextAction: 'Triage the actionable findings from the dispositioned stale discovery response.',
        };
      }
      const pendingHeadDriftReady
        = isNativeTasklessPendingReviewHeadDriftValidationRecovery(current, [])
        && current.validationStatus.status === 'passed'
        && current.validationStatus.headSha === current.currentIntegrationHeadSha
        && (recoveryDisposition === null || recoveryDisposition.evidence.outcome === 'clean')
        && nextState.threadResolutionStatus.status === 'passed'
        && nextState.threadResolutionStatus.headSha === current.currentIntegrationHeadSha
        && nextState.threadResolutionStatus.threads.length === 0;
      if (pendingHeadDriftReady) {
        nextState = { ...nextState, phase: 'ready-for-review', nextAction: reviewLimitNextAction(nextState) };
      }
      if (staleDiscoveryDisposition !== null && sameEvidence(current, nextState)) {
        return { nextState: current, result: current, noWrite: true };
      }
      return { nextState, event };
    },
  });
}
