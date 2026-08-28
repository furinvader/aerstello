import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  reviewRoot,
  specialistReviewDirectory,
  taskBindingProvenanceDirectory,
  taskPacketDirectory,
  workerResultDirectory,
} from '../paths.mjs';
import { StateError } from './errors.mjs';

export function parsePrNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new StateError('PR number must be a positive integer', 'INVALID_PR_NUMBER');
  }
  return number;
}

export function stateDirectory(cwd, prNumber) {
  return join(reviewRoot(cwd), `pr-${parsePrNumber(prNumber)}`);
}

export function statePath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'state.json');
}

export function validationPlanPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'targeted-validation-plan.json');
}

export function scopeAuthorityPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-authority.json');
}

export function scopeAuthorityReceiptPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-authority.sha256');
}

export function scopeControlJournalPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-control-journal.json');
}

export function scopeControlJournalReceiptPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-control-journal.sha256');
}

export function scopeReturnPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-return.json');
}

export function scopeReturnReceiptPath(cwd, prNumber) {
  return join(stateDirectory(cwd, prNumber), 'scope-return.sha256');
}

function opaqueName(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function taskPacketSidecarPath(cwd, prNumber, taskId) {
  return join(taskPacketDirectory(cwd, parsePrNumber(prNumber)), `${opaqueName(taskId)}.json`);
}

export function taskBindingProvenancePath(cwd, prNumber, taskId) {
  return join(taskBindingProvenanceDirectory(cwd, parsePrNumber(prNumber)), `${opaqueName(taskId)}.json`);
}

export function taskBindingProvenanceReceiptPath(cwd, prNumber, taskId) {
  return join(taskBindingProvenanceDirectory(cwd, parsePrNumber(prNumber)), `${opaqueName(taskId)}.sha256`);
}

export function workerResultEnvelopePath(cwd, prNumber, taskId) {
  return join(workerResultDirectory(cwd, parsePrNumber(prNumber)), `${opaqueName(taskId)}.json`);
}

export function workerResultReceiptPath(cwd, prNumber, taskId) {
  return join(workerResultDirectory(cwd, parsePrNumber(prNumber)), `${opaqueName(taskId)}.sha256`);
}

export function specialistReviewBundlePath(cwd, prNumber, headSha, revision) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headSha)) {
    throw new StateError('Specialist review HEAD must be a full commit SHA', 'INVALID_SPECIALIST_REVIEW');
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new StateError('Specialist review revision must be a non-negative integer', 'INVALID_SPECIALIST_REVIEW');
  }
  return join(specialistReviewDirectory(cwd, parsePrNumber(prNumber)), `${headSha}-r${revision}.json`);
}

export function specialistPlanReceiptPath(cwd, prNumber, headSha, revision) {
  return specialistReviewBundlePath(cwd, prNumber, headSha, revision).replace(/\.json$/u, '.plan.sha256');
}

export function activePointerPath(cwd = process.cwd()) {
  return join(reviewRoot(cwd), 'active.json');
}

export function lockPath(cwd, prNumber) {
  return join(reviewRoot(cwd), 'locks', `pr-${parsePrNumber(prNumber)}.state-lock.sqlite`);
}

export function requestOwnerLockPath(cwd, prNumber) {
  return join(reviewRoot(cwd), 'locks', `pr-${parsePrNumber(prNumber)}.github-request-lock.sqlite`);
}

export function legacyLockPath(cwd, prNumber) {
  return join(reviewRoot(cwd), 'locks', `pr-${parsePrNumber(prNumber)}.lock`);
}

export function legacyRequestOwnerLockPath(cwd, prNumber) {
  return join(reviewRoot(cwd), 'locks', `pr-${parsePrNumber(prNumber)}.github-request.lock`);
}
