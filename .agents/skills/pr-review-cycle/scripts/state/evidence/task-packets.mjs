import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGit } from '../../../../../../scripts/lib/git.mjs';
import {
  taskPacketDigest as contractTaskPacketDigest,
  validateTaskPacket,
} from '../../contracts/contracts.mjs';
import { atomicWriteText, canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import { stateDirectory, taskPacketSidecarPath } from '../locations.mjs';
import { migratePrReviewStateV2 } from '../migrations.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
function activeReviewEvidenceHead(state) {
  const dispositions = Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
  return state.reviewedHeadSha ?? dispositions.find((item) => item.requestId === state?.reviewRequest?.id)?.evidence?.headSha ?? null;
}

export function taskPacketDigest(packet) {
  if (packet?.schemaVersion !== 2) {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  } else if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || typeof packet.taskId !== 'string' || packet.taskId.length === 0) {
    throw new StateError('Invalid historical schema-v2 task packet', 'INVALID_TASK_PACKET');
  }
  return contractTaskPacketDigest(packet);
}

export function persistImmutableTaskPacketSidecar(cwd, state, packet, digest) {
  const path = taskPacketSidecarPath(cwd, state.prNumber, packet.taskId);
  const serialized = canonicalSerializedJson(packet);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Task packet sidecar exceeds 64 KiB', 'TASK_PACKET_SIDECAR_WRITE_FAILED');
  }
  if (existsSync(path)) {
    let existing;
    try {
      existing = readJsonSidecar(path, 'task packet sidecar');
    } catch (error) {
      throw new StateError(
        `Task ${packet.taskId} already has an invalid durable packet sidecar; explicitly replan the task`,
        'TASK_PACKET_REPLAN_REQUIRED',
      );
    }
    let existingDigest;
    try { existingDigest = taskPacketDigest(existing); } catch { existingDigest = null; }
    if (existing?.schemaVersion !== 3 || existingDigest !== digest
        || canonicalSerializedJson(existing) !== serialized) {
      throw new StateError(
        `Task ${packet.taskId} already has a different or invalid durable packet sidecar; explicitly replan the task`,
        'TASK_PACKET_REPLAN_REQUIRED',
      );
    }
    return path;
  }
  atomicWriteText(path, serialized);
  const persisted = readJsonSidecar(path, 'task packet sidecar');
  if (persisted?.schemaVersion !== 3 || taskPacketDigest(persisted) !== digest
      || canonicalSerializedJson(persisted) !== serialized) {
    throw new StateError(`Durable packet sidecar verification failed for task ${packet.taskId}`, 'TASK_PACKET_SIDECAR_WRITE_FAILED');
  }
  return path;
}


export function readTaskPacketSidecar(cwd, state, task, {
  suppliedPacket,
} = {}) {
  const path = taskPacketSidecarPath(cwd, state.prNumber, task.id);
  if (!existsSync(path)) {
    if (task.status === 'completed' && suppliedPacket?.schemaVersion === 2
        && taskPacketDigest(suppliedPacket) === task.taskPacketDigest) return suppliedPacket;
    throw new StateError(
      `Task ${task.id} is bound without a valid schema-v3 packet sidecar; explicitly replan it`,
      'TASK_PACKET_REPLAN_REQUIRED',
    );
  }
  let packet;
  try {
    packet = readJsonSidecar(path, 'task packet sidecar');
    if (packet?.schemaVersion !== 3) throw new Error('sidecar packet must use schema v3');
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new Error(errors.join('; '));
    if (packet.taskId !== task.id || taskPacketDigest(packet) !== task.taskPacketDigest) {
      throw new Error('task ID or digest does not match active state');
    }
  } catch (error) {
    throw new StateError(
      `Task ${task.id} has a missing or tampered durable packet sidecar; explicitly replan it (${error.message})`,
      'TASK_PACKET_REPLAN_REQUIRED',
    );
  }
  return packet;
}

export function hasCompletedHistoricalV2TaskProof(cwd, state, task) {
  const backupPath = join(stateDirectory(cwd, state.prNumber), 'state.v2.backup.json');
  if (!existsSync(backupPath) || task.status !== 'completed') return false;
  try {
    const legacy = readJsonSidecar(backupPath, 'schema-v2 migration backup');
    migratePrReviewStateV2(legacy, { migratedAt: state.updatedAt });
    if (legacy.repository !== state.repository || legacy.prNumber !== state.prNumber
        || resolve(legacy.integrationWorktree) !== resolve(state.integrationWorktree)) return false;
    const legacyTask = legacy.tasks.find((candidate) => candidate.id === task.id);
    return legacyTask?.status === 'completed'
      && legacyTask.taskPacketDigest === task.taskPacketDigest;
  } catch {
    return false;
  }
}


export function assertTaskPacketHead(state, task, packet, digest) {
  const assertBoundIntegrationHistory = () => {
    if (task.taskPacketDigest !== digest) {
      throw new StateError(`Task packet ${packet.taskId} differs from the accepted packet`, 'TASK_PACKET_CONFLICT');
    }
    if (typeof task.integratedCommitSha !== 'string' || task.integratedCommitSha.length === 0) {
      throw new StateError(
        `Task ${task.id} integration commit is not proven in the current integration history`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
    let ancestry;
    try {
      ancestry = runGit(
        ['merge-base', '--is-ancestor', task.integratedCommitSha, state.currentIntegrationHeadSha],
        { cwd: state.integrationWorktree, allowFailure: true },
      );
    } catch {
      throw new StateError(
        `Task ${task.id} integration ancestry could not be verified`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
    if (ancestry.status !== 0) {
      throw new StateError(
        `Task ${task.id} integration commit is not an ancestor of the current integration HEAD`,
        'TASK_INTEGRATION_ANCESTRY_MISMATCH',
      );
    }
  };
  const boundCompletedTask = task.status === 'completed'
    && typeof task.taskPacketDigest === 'string';
  if (boundCompletedTask) {
    assertBoundIntegrationHistory();
    return;
  }
  const evidenceHeadSha = activeReviewEvidenceHead(state);
  if (evidenceHeadSha !== null) {
    if (packet.reviewedHeadSha !== evidenceHeadSha) {
      throw new StateError(`Task packet ${packet.taskId} does not match the exact reviewed HEAD`, 'TASK_PACKET_HEAD_MISMATCH');
    }
  }
  const boundIntegratedTask = task.status === 'integrated'
    && typeof task.taskPacketDigest === 'string';
  if (boundIntegratedTask) {
    assertBoundIntegrationHistory();
    return;
  }
  if (evidenceHeadSha !== null) return;
  if (packet.reviewedHeadSha === state.currentIntegrationHeadSha) return;
  throw new StateError(`Task packet ${packet.taskId} does not match the exact reviewed HEAD`, 'TASK_PACKET_HEAD_MISMATCH');
}

export function assertBoundTaskPacket(state, packet, cwd = state.integrationWorktree) {
  const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
  if (!task || task.disposition !== 'actionable') {
    throw new StateError(`Task packet ${packet.taskId} does not match an actionable durable task`, 'TASK_PACKET_NOT_BOUND');
  }
  const digest = taskPacketDigest(packet);
  if (!task.taskPacketDigest) {
    assertTaskPacketHead(state, task, packet, digest);
    throw new StateError(`Task packet ${packet.taskId} has not been durably bound`, 'TASK_PACKET_NOT_BOUND');
  }
  const durablePacket = readTaskPacketSidecar(cwd, state, task, { suppliedPacket: packet });
  assertTaskPacketHead(state, task, packet, digest);
  if (task.taskPacketDigest !== digest) {
    throw new StateError(`Task packet ${packet.taskId} differs from the accepted packet`, 'TASK_PACKET_CONFLICT');
  }
  if (durablePacket.schemaVersion === 3
      && canonicalSerializedJson(durablePacket) !== canonicalSerializedJson(packet)) {
    throw new StateError(`Task packet ${packet.taskId} differs from its durable sidecar`, 'TASK_PACKET_CONFLICT');
  }
  return task;
}

export function assertTaskPacketBound(state, packet, { cwd = state.integrationWorktree } = {}) {
  if (packet?.schemaVersion !== 2) {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new StateError(`Invalid task packet:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_PACKET');
  }
  return assertBoundTaskPacket(state, packet, cwd);
}
