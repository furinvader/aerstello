import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateTaskPacket } from '../contracts/contracts.mjs';
import { taskBindingProvenanceDirectory, taskPacketDirectory, workerResultDirectory } from '../paths.mjs';
import { readJsonSidecar } from './atomic-io.mjs';
import { gitSnapshot } from './git-authority.mjs';
import {
  taskBindingProvenancePath, taskBindingProvenanceReceiptPath, taskPacketSidecarPath,
  scopeAuthorityPath, scopeAuthorityReceiptPath, scopeControlJournalPath,
  scopeControlJournalReceiptPath, scopeReturnPath, scopeReturnReceiptPath,
  workerResultEnvelopePath, workerResultReceiptPath,
} from './locations.mjs';
import { loadState } from './state-store.mjs';
import {
  assertTaskBindingProvenanceSource, buildTaskBindingProvenance, readBoundTaskBindingProvenance,
  recoverHistoricalTaskBindingPlanning, validateTaskBindingProvenance, verifyTaskBindingProvenanceReceipt,
} from './evidence/task-binding.mjs';
import { readSpecialistStatus } from './evidence/specialist-bundles.mjs';
import { hasCompletedHistoricalV2TaskProof, readTaskPacketSidecar } from './evidence/task-packets.mjs';
import { readAcceptedWorkerResult } from './evidence/worker-results.mjs';
import { readScopeAuthority, readScopeJournal, readScopeReturn } from './evidence/scope-control.mjs';

function readBoundPacketWithProvenance(cwd, state, task, options = {}) {
  const packet = readTaskPacketSidecar(cwd, state, task, options);
  if (options.verifyBindingProvenance !== false) readBoundTaskBindingProvenance(cwd, state, task, packet);
  return packet;
}

export function reconcileState({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) return { state: null, warnings: [] };
  const warnings = [];
  let actual;
  try {
    actual = gitSnapshot(state.integrationWorktree);
    if (actual.headSha !== state.currentIntegrationHeadSha) {
      warnings.push(`Integration HEAD is ${actual.headSha}, recorded ${state.currentIntegrationHeadSha}`);
    }
    if (actual.dirty) warnings.push('Integration checkout has uncommitted changes');
  } catch (error) {
    warnings.push(`Unable to inspect integration checkout: ${error.message}`);
    actual = null;
  }
  const packetSidecars = [];
  const bindingProvenance = [];
  const evidenceErrors = [];
  let scope = { status: 'not-configured' };
  const scopePaths = [
    scopeAuthorityPath(cwd, state.prNumber), scopeAuthorityReceiptPath(cwd, state.prNumber),
    scopeControlJournalPath(cwd, state.prNumber), scopeControlJournalReceiptPath(cwd, state.prNumber),
    scopeReturnPath(cwd, state.prNumber), scopeReturnReceiptPath(cwd, state.prNumber),
  ];
  if (state.scopeControl) {
    try {
      const authority = readScopeAuthority(cwd, state);
      const journal = readScopeJournal(cwd, state);
      const returned = state.scopeControl.returnDigest === null ? null : readScopeReturn(cwd, state);
      const initialAuthorityDigest = journal.value.entries.find(
        (entry) => entry.kind === 'amendment',
      )?.priorAuthorityDigest ?? journal.value.authorityDigest;
      if (authority.digest !== initialAuthorityDigest
          || journal.value.authorityDigest !== state.scopeControl.authorityDigest
          || journal.digest !== state.scopeControl.journalDigest
          || (returned?.digest ?? null) !== state.scopeControl.returnDigest) {
        throw new Error('compact state reference does not match durable scope evidence');
      }
      scope = { status: 'valid', gate: state.scopeControl.gate };
    } catch (error) {
      scope = { status: 'invalid', error: error.code ?? 'INVALID_SCOPE_EVIDENCE' };
      evidenceErrors.push(`Scope-control evidence: ${error.message}`);
    }
  } else if (scopePaths.some((path) => existsSync(path))) {
    scope = { status: 'orphan' };
    evidenceErrors.push('Scope-control evidence exists without a compact active-state reference');
  }
  const seenPacketPaths = new Set();
  const seenProvenancePaths = new Set();
  const seenProvenanceReceiptPaths = new Set();
  for (const task of state.tasks.filter((candidate) => typeof candidate.taskPacketDigest === 'string')) {
    const path = taskPacketSidecarPath(cwd, state.prNumber, task.id);
    const provenancePath = taskBindingProvenancePath(cwd, state.prNumber, task.id);
    const provenanceReceiptPath = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
    seenPacketPaths.add(path);
    seenProvenancePaths.add(provenancePath);
    seenProvenanceReceiptPaths.add(provenanceReceiptPath);
    if (!existsSync(path) && !existsSync(provenancePath) && !existsSync(provenanceReceiptPath)
        && hasCompletedHistoricalV2TaskProof(cwd, state, task)) {
      packetSidecars.push({ taskId: task.id, status: 'historical-v2', path: null });
      bindingProvenance.push({ taskId: task.id, status: 'historical-v2', path: null, receiptPath: null });
      continue;
    }
    let packet;
    try {
      packet = readBoundPacketWithProvenance(cwd, state, task, { verifyBindingProvenance: false });
      packetSidecars.push({ taskId: task.id, status: 'valid', path });
    } catch (error) {
      packetSidecars.push({ taskId: task.id, status: 'invalid', path: existsSync(path) ? path : null, error: error.code });
      evidenceErrors.push(`Task ${task.id} packet sidecar: ${error.message}`);
    }
    if (packet) {
      try {
        readBoundTaskBindingProvenance(cwd, state, task, packet);
        bindingProvenance.push({
          taskId: task.id, status: 'valid', path: provenancePath,
          receiptPath: provenanceReceiptPath,
        });
      } catch (error) {
        bindingProvenance.push({
          taskId: task.id, status: 'invalid', path: existsSync(provenancePath) ? provenancePath : null,
          receiptPath: existsSync(provenanceReceiptPath) ? provenanceReceiptPath : null,
          error: error.code,
        });
        evidenceErrors.push(`Task ${task.id} binding provenance: ${error.message}`);
      }
    } else {
      bindingProvenance.push({
        taskId: task.id, status: 'unverifiable', path: existsSync(provenancePath) ? provenancePath : null,
        receiptPath: existsSync(provenanceReceiptPath) ? provenanceReceiptPath : null,
      });
    }
  }
  const packetDirectory = taskPacketDirectory(cwd, state.prNumber);
  if (existsSync(packetDirectory)) {
    for (const name of readdirSync(packetDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(packetDirectory, name);
      if (seenPacketPaths.has(path)) continue;
      try {
        const packet = readJsonSidecar(path, 'unbound task packet sidecar');
        const packetErrors = validateTaskPacket(packet);
        if (packetErrors.length > 0 || taskPacketSidecarPath(cwd, state.prNumber, packet.taskId) !== path) {
          throw new Error(packetErrors.join('; ') || 'sidecar filename does not match its hashed task ID');
        }
        const pendingTask = state.tasks.find((task) => task.id === packet.taskId && !task.taskPacketDigest);
        const status = pendingTask ? 'pending-binding' : 'orphan';
        packetSidecars.push({ taskId: packet.taskId, status, path });
        evidenceErrors.push(`Task ${packet.taskId} packet sidecar is ${status}`);
      } catch (error) {
        packetSidecars.push({ taskId: null, status: 'invalid', path, error: 'INVALID_DURABLE_SIDECAR' });
        evidenceErrors.push(`Unbound packet sidecar ${name} is invalid: ${error.message}`);
      }
    }
  }
  const provenanceDirectory = taskBindingProvenanceDirectory(cwd, state.prNumber);
  if (existsSync(provenanceDirectory)) {
    for (const name of readdirSync(provenanceDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(provenanceDirectory, name);
      if (seenProvenancePaths.has(path)) continue;
      try {
        const provenance = readJsonSidecar(path, 'unbound task binding provenance');
        if (typeof provenance?.taskId !== 'string'
            || taskBindingProvenancePath(cwd, state.prNumber, provenance.taskId) !== path) {
          throw new Error('provenance filename does not match its hashed task ID');
        }
        const receiptPath = taskBindingProvenanceReceiptPath(
          cwd, state.prNumber, provenance.taskId,
        );
        seenProvenanceReceiptPaths.add(receiptPath);
        const pendingTask = state.tasks.find((task) => task.id === provenance.taskId && !task.taskPacketDigest);
        const packetPath = taskPacketSidecarPath(cwd, state.prNumber, provenance.taskId);
        if (!pendingTask || !existsSync(packetPath)) {
          bindingProvenance.push({
            taskId: provenance.taskId, status: 'orphan', path,
            receiptPath: existsSync(receiptPath) ? receiptPath : null,
          });
          evidenceErrors.push(`Task ${provenance.taskId} binding provenance is orphaned`);
          continue;
        }
        const packet = readJsonSidecar(packetPath, 'pending task packet sidecar');
        const errors = validateTaskBindingProvenance(provenance, state, pendingTask, packet);
        if (errors.length > 0) throw new Error(errors.join('; '));
        assertTaskBindingProvenanceSource(cwd, state, pendingTask, packet, provenance);
        verifyTaskBindingProvenanceReceipt(cwd, state, pendingTask, provenance);
        bindingProvenance.push({
          taskId: provenance.taskId, status: 'pending-binding', path, receiptPath,
        });
        evidenceErrors.push(`Task ${provenance.taskId} binding provenance is pending state checkpoint`);
      } catch (error) {
        bindingProvenance.push({
          taskId: null, status: 'invalid', path, receiptPath: null,
          error: 'INVALID_TASK_BINDING_PROVENANCE',
        });
        evidenceErrors.push(`Unbound task binding provenance ${name} is invalid: ${error.message}`);
      }
    }
    for (const name of readdirSync(provenanceDirectory).filter((entry) => entry.endsWith('.sha256')).sort()) {
      const receiptPath = join(provenanceDirectory, name);
      if (seenProvenanceReceiptPaths.has(receiptPath)) continue;
      const pendingTask = state.tasks.find((task) => !task.taskPacketDigest
        && taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id) === receiptPath);
      const packetPath = pendingTask
        ? taskPacketSidecarPath(cwd, state.prNumber, pendingTask.id) : null;
      if (!pendingTask || !existsSync(packetPath)) {
        bindingProvenance.push({ taskId: pendingTask?.id ?? null, status: 'orphan', path: null, receiptPath });
        evidenceErrors.push(`Task binding provenance receipt ${name} is orphaned`);
        continue;
      }
      try {
        const packet = readJsonSidecar(packetPath, 'pending task packet sidecar');
        const planning = recoverHistoricalTaskBindingPlanning(cwd, state, packet);
        const provenance = buildTaskBindingProvenance(state, packet, planning);
        verifyTaskBindingProvenanceReceipt(cwd, state, pendingTask, provenance);
        bindingProvenance.push({
          taskId: pendingTask.id, status: 'pending-binding', path: null, receiptPath,
        });
        evidenceErrors.push(`Task ${pendingTask.id} binding provenance receipt is pending sidecar and state checkpoints`);
      } catch (error) {
        bindingProvenance.push({
          taskId: pendingTask.id, status: 'invalid', path: null, receiptPath,
          error: 'INVALID_TASK_BINDING_PROVENANCE',
        });
        evidenceErrors.push(`Task ${pendingTask.id} binding provenance receipt is invalid: ${error.message}`);
      }
    }
  }
  const workerResults = [];
  const seenWorkerEvidencePaths = new Set();
  for (const task of state.tasks.filter((candidate) => typeof candidate.taskPacketDigest === 'string')) {
    const envelopePath = workerResultEnvelopePath(cwd, state.prNumber, task.id);
    const receiptPath = workerResultReceiptPath(cwd, state.prNumber, task.id);
    seenWorkerEvidencePaths.add(envelopePath);
    seenWorkerEvidencePaths.add(receiptPath);
    if (typeof task.workerResultDigest !== 'string') {
      if (existsSync(envelopePath) || existsSync(receiptPath)) {
        let status = 'pending-state';
        try {
          if (existsSync(envelopePath) && !existsSync(receiptPath)) throw new Error('envelope has no receipt');
          if (existsSync(envelopePath)) {
            const envelope = readJsonSidecar(envelopePath, 'pending worker-result envelope');
            const packet = readBoundPacketWithProvenance(cwd, state, task);
            readAcceptedWorkerResult(cwd, state, { ...task, workerResultDigest: envelope.resultDigest }, packet);
          }
        } catch {
          status = 'invalid';
        }
        workerResults.push({ taskId: task.id, status, path: existsSync(envelopePath) ? envelopePath : null, receiptPath: existsSync(receiptPath) ? receiptPath : null });
        evidenceErrors.push(`Task ${task.id} worker-result evidence is ${status === 'invalid' ? 'invalid' : 'pending its guarded state checkpoint'}`);
      }
      continue;
    }
    try {
      const packet = readBoundPacketWithProvenance(cwd, state, task);
      readAcceptedWorkerResult(cwd, state, task, packet);
      workerResults.push({ taskId: task.id, status: 'valid', path: envelopePath, receiptPath });
    } catch (error) {
      workerResults.push({ taskId: task.id, status: 'invalid', path: existsSync(envelopePath) ? envelopePath : null, receiptPath: existsSync(receiptPath) ? receiptPath : null, error: error.code });
      evidenceErrors.push(`Task ${task.id} worker-result evidence: ${error.message}`);
    }
  }
  const resultDirectory = workerResultDirectory(cwd, state.prNumber);
  if (existsSync(resultDirectory)) {
    for (const name of readdirSync(resultDirectory).filter((entry) => /\.(?:json|sha256)$/u.test(entry)).sort()) {
      const path = join(resultDirectory, name);
      if (seenWorkerEvidencePaths.has(path)) continue;
      workerResults.push({ taskId: null, status: 'orphan', path: name.endsWith('.json') ? path : null, receiptPath: name.endsWith('.sha256') ? path : null });
      evidenceErrors.push(`Worker-result evidence ${name} is orphaned`);
    }
  }
  const specialist = readSpecialistStatus({ cwd, prNumber: state.prNumber });
  if (specialist.error && specialist.error !== 'SPECIALIST_PLAN_STALE') {
    evidenceErrors.push(`Specialist review bundle is invalid: ${specialist.error}`);
  }
  return {
    state, actualGit: actual, warnings, evidenceErrors, packetSidecars, bindingProvenance, workerResults, specialist, scope,
  };
}
