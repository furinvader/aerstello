import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { validateWorkerResultAgainstTask, workerResultDigest } from '../../contracts/contracts.mjs';
import { atomicWriteText, canonicalJson, canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import { inspectWorkerCommitAuthority } from '../git-authority.mjs';
import { workerResultEnvelopePath, workerResultReceiptPath } from '../locations.mjs';
import { readBoundTaskBindingProvenance } from './task-binding.mjs';
import { taskPacketDigest } from './task-packets.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;

export function buildWorkerResultEnvelope(state, packet, result) {
  return canonicalJson({
    schemaVersion: 1,
    prNumber: state.prNumber,
    taskId: packet.taskId,
    packetDigest: taskPacketDigest(packet),
    reviewedHeadSha: packet.reviewedHeadSha,
    resultDigest: workerResultDigest(result),
    result,
  });
}

export function workerResultEnvelopeDigest(envelope) {
  return createHash('sha256').update(canonicalSerializedJson(envelope)).digest('hex');
}

export function verifyWorkerResultReceipt(cwd, state, task, envelope) {
  const path = workerResultReceiptPath(cwd, state.prNumber, task.id);
  let receipt;
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    receipt = readFileSync(path, 'utf8').trim();
  } catch (error) {
    throw new StateError(`Unable to read task ${task.id} worker-result receipt: ${error.message}`, 'INVALID_WORKER_RESULT_EVIDENCE');
  }
  if (receipt !== workerResultEnvelopeDigest(envelope)) {
    throw new StateError(`Task ${task.id} worker-result receipt does not match its envelope`, 'INVALID_WORKER_RESULT_EVIDENCE');
  }
  return receipt;
}

export function persistWorkerResultEvidence(cwd, state, task, envelope, onStep) {
  const envelopePath = workerResultEnvelopePath(cwd, state.prNumber, task.id);
  const receiptPath = workerResultReceiptPath(cwd, state.prNumber, task.id);
  const serialized = canonicalSerializedJson(envelope);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Worker-result envelope exceeds 64 KiB', 'WORKER_RESULT_EVIDENCE_TOO_LARGE');
  }
  const expectedReceipt = workerResultEnvelopeDigest(envelope);
  if (existsSync(envelopePath) && !existsSync(receiptPath)) {
    throw new StateError('Worker-result envelope exists without its immutable receipt', 'INVALID_WORKER_RESULT_EVIDENCE');
  }
  if (existsSync(receiptPath)) {
    const actual = readFileSync(receiptPath, 'utf8').trim();
    if (actual !== expectedReceipt) throw new StateError('A different worker-result receipt already exists', 'WORKER_RESULT_CONFLICT');
  } else {
    atomicWriteText(receiptPath, `${expectedReceipt}\n`);
    onStep?.('receipt-durable');
  }
  if (existsSync(envelopePath)) {
    let existing;
    try { existing = readJsonSidecar(envelopePath, 'worker-result envelope'); } catch {
      throw new StateError('An invalid worker-result envelope already exists', 'WORKER_RESULT_CONFLICT');
    }
    if (canonicalSerializedJson(existing) !== serialized) {
      throw new StateError('A different worker-result envelope already exists', 'WORKER_RESULT_CONFLICT');
    }
  } else {
    atomicWriteText(envelopePath, serialized);
    onStep?.('envelope-durable');
  }
  verifyWorkerResultReceipt(cwd, state, task, envelope);
}

export function readAcceptedWorkerResult(cwd, state, task, packet) {
  readBoundTaskBindingProvenance(cwd, state, task, packet);
  if (typeof task.workerResultDigest !== 'string') {
    throw new StateError(`Task ${task.id} has no accepted worker-result digest`, 'WORKER_RESULT_MISSING');
  }
  const envelope = readJsonSidecar(
    workerResultEnvelopePath(cwd, state.prNumber, task.id), 'worker-result envelope',
  );
  const expectedFields = ['schemaVersion', 'prNumber', 'taskId', 'packetDigest', 'reviewedHeadSha', 'resultDigest', 'result'];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).sort().join('\0') !== [...expectedFields].sort().join('\0')
      || envelope.schemaVersion !== 1 || envelope.prNumber !== state.prNumber
      || envelope.taskId !== task.id || envelope.packetDigest !== taskPacketDigest(packet)
      || envelope.reviewedHeadSha !== packet.reviewedHeadSha
      || envelope.resultDigest !== task.workerResultDigest
      || workerResultDigest(envelope.result) !== envelope.resultDigest) {
    throw new StateError(`Task ${task.id} worker-result envelope is missing, stale, or altered`, 'INVALID_WORKER_RESULT_EVIDENCE');
  }
  const authority = envelope.result.status === 'implemented'
    ? inspectWorkerCommitAuthority({
      cwd, state, packet, result: envelope.result,
      centralCommitSha: ['integrated', 'completed'].includes(task.status) ? task.integratedCommitSha : null,
    }) : null;
  const actualPaths = authority?.changedPaths;
  const errors = validateWorkerResultAgainstTask(packet, envelope.result, actualPaths);
  if (errors.length > 0) {
    throw new StateError(`Task ${task.id} worker-result envelope is invalid: ${errors.join('; ')}`, 'INVALID_WORKER_RESULT_EVIDENCE');
  }
  verifyWorkerResultReceipt(cwd, state, task, envelope);
  return envelope;
}


export function proveWorkerResultEvidence({ cwd, state, task, packet, result }) {
  readBoundTaskBindingProvenance(cwd, state, task, packet);
  const preliminaryErrors = validateWorkerResultAgainstTask(packet, result, result?.changedPaths);
  if (preliminaryErrors.length > 0) {
    throw new StateError(`Worker result does not satisfy task packet:\n- ${preliminaryErrors.join('\n- ')}`, 'INVALID_WORKER_RESULT');
  }
  if (result.status !== 'implemented') {
    throw new StateError('Only an implemented worker result can be durably accepted', 'INVALID_WORKER_RESULT');
  }
  const authority = inspectWorkerCommitAuthority({ cwd, state, packet, result });
  const errors = validateWorkerResultAgainstTask(packet, result, authority.changedPaths);
  if (errors.length > 0) {
    throw new StateError(`Worker result does not satisfy task packet:\n- ${errors.join('\n- ')}`, 'INVALID_WORKER_RESULT');
  }
  return { authority, envelope: buildWorkerResultEnvelope(state, packet, result) };
}
