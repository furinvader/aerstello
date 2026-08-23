import { randomUUID } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { reviewRoot } from '../paths.mjs';
import { atomicWriteJson } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { prepareEvent } from './journal.mjs';
import { activePointerPath, parsePrNumber, stateDirectory } from './locations.mjs';
import { withStateLock } from './locks.mjs';
import { reconcileState } from './reconciliation.mjs';
import { activePrNumber, loadState, validateStateForWrite } from './state-store.mjs';
function utcNow() { return new Date().toISOString(); }

export function archiveState({ cwd = process.cwd(), prNumber, abandonmentReason, onArchiveStep } = {}) {
  const requestedPr = prNumber ?? activePrNumber(cwd);
  if (requestedPr === null || requestedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const selectedPr = parsePrNumber(requestedPr);
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    const resultInventory = reconcileState({ cwd, prNumber: selectedPr }).workerResults ?? [];
    const invalidResultEvidence = resultInventory.filter((entry) => entry.status !== 'valid');
    if (invalidResultEvidence.length > 0) {
      throw new StateError(
        `Worker-result evidence must be receipt-valid before archive: ${invalidResultEvidence.map((entry) => `${entry.taskId ?? 'orphan'}=${entry.status}`).join(', ')}`,
        'INVALID_WORKER_RESULT_EVIDENCE',
      );
    }
    const reason = typeof abandonmentReason === 'string' ? abandonmentReason.trim() : '';
    if (current.phase !== 'complete' && reason.length === 0) {
      throw new StateError(
        'Only a complete cycle may be archived without an explicit abandonment reason',
        'STATE_ARCHIVE_NOT_ALLOWED',
      );
    }
    if (reason.length > 1000) {
      throw new StateError('Abandonment reason must be at most 1000 characters', 'INVALID_ABANDONMENT_REASON');
    }
    const archivedState = reason.length > 0
      ? { ...current, abandonmentReason: reason, revision: current.revision + 1, updatedAt: utcNow() }
      : current;
    validateStateForWrite(archivedState);
    const suffix = utcNow().replace(/[:.]/gu, '-');
    const target = join(reviewRoot(cwd), 'archive', `pr-${selectedPr}-${suffix}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    mkdirSync(dirname(target), { recursive: true });
    try {
      cpSync(stateDirectory(cwd, selectedPr), temporary, { recursive: true, errorOnExist: true });
      atomicWriteJson(join(temporary, 'state.json'), archivedState);
      if (reason.length > 0) {
        const event = prepareEvent({ type: 'abandoned', summary: `Archived without completion: ${reason}` });
        const handle = openSync(join(temporary, 'events.ndjson'), 'a', 0o600);
        try {
          writeFileSync(handle, `${JSON.stringify(event)}\n`, 'utf8');
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
      }
      renameSync(temporary, target);
      onArchiveStep?.('archive-durable');
    } catch (error) {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const active = activePrNumber(cwd);
    if (active === selectedPr) unlinkSync(activePointerPath(cwd));
    onArchiveStep?.('pointer-cleared');
    rmSync(stateDirectory(cwd, selectedPr), { recursive: true });
    return target;
  });
}
