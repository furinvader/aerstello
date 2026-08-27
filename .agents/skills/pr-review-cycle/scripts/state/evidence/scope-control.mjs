import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  scopeAuthorityDigest,
  scopeControlJournalDigest,
  validateScopeAuthoritySnapshot,
  validateScopeControlJournal,
  validateScopeReturnEnvelope,
} from '../../contracts/contracts.mjs';
import { atomicWriteText, canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import {
  scopeAuthorityPath,
  scopeAuthorityReceiptPath,
  scopeControlJournalPath,
  scopeControlJournalReceiptPath,
  scopeReturnPath,
  scopeReturnReceiptPath,
} from '../locations.mjs';

const EVIDENCE_LIMIT_BYTES = 256 * 1024;

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalSerializedJson(value)).digest('hex')}`;
}

function assertValid(value, validate, label) {
  const errors = validate(value);
  if (errors.length > 0) {
    throw new StateError(`Invalid ${label}:\n- ${errors.join('\n- ')}`, 'INVALID_SCOPE_EVIDENCE');
  }
}

function readReceipt(path, label) {
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    throw new StateError(`Unable to read ${label} receipt: ${error.message}`, 'INVALID_SCOPE_EVIDENCE');
  }
}

function persistEvidence({ documentPath, receiptPath, value, expectedDigest, label, replace = false }) {
  const serialized = canonicalSerializedJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > EVIDENCE_LIMIT_BYTES) {
    throw new StateError(`${label} exceeds 256 KiB`, 'SCOPE_EVIDENCE_TOO_LARGE');
  }
  if (existsSync(documentPath)) {
    const existing = readJsonSidecar(documentPath, label);
    if (canonicalSerializedJson(existing) === serialized) {
      if (readReceipt(receiptPath, label) !== expectedDigest) {
        throw new StateError(`${label} receipt is stale or altered`, 'INVALID_SCOPE_EVIDENCE');
      }
      return;
    }
    if (!replace) throw new StateError(`A different ${label} already exists`, 'SCOPE_EVIDENCE_CONFLICT');
  } else if (existsSync(receiptPath)) {
    throw new StateError(`${label} receipt exists without its document`, 'INVALID_SCOPE_EVIDENCE');
  }
  // Journal and return documents are durable projections whose receipts always bind the complete value.
  atomicWriteText(receiptPath, `${expectedDigest}\n`);
  atomicWriteText(documentPath, serialized);
}

function readEvidence({ documentPath, receiptPath, validate, expectedDigest, label }) {
  const value = readJsonSidecar(documentPath, label);
  assertValid(value, validate, label);
  const actual = readReceipt(receiptPath, label);
  const expected = expectedDigest(value);
  if (actual !== expected) {
    throw new StateError(`${label} receipt does not bind its complete document`, 'INVALID_SCOPE_EVIDENCE');
  }
  return { value, digest: expected };
}

export function scopeReturnDigest(value) {
  assertValid(value, validateScopeReturnEnvelope, 'scope return');
  return digest(value);
}

export function persistScopeAuthority(cwd, state, authority) {
  assertValid(authority, validateScopeAuthoritySnapshot, 'scope authority');
  persistEvidence({
    documentPath: scopeAuthorityPath(cwd, state.prNumber),
    receiptPath: scopeAuthorityReceiptPath(cwd, state.prNumber),
    value: authority,
    expectedDigest: scopeAuthorityDigest(authority),
    label: 'scope authority',
  });
}

export function readScopeAuthority(cwd, state) {
  return readEvidence({
    documentPath: scopeAuthorityPath(cwd, state.prNumber),
    receiptPath: scopeAuthorityReceiptPath(cwd, state.prNumber),
    validate: validateScopeAuthoritySnapshot,
    expectedDigest: scopeAuthorityDigest,
    label: 'scope authority',
  });
}

export function persistScopeJournal(cwd, state, journal) {
  const authority = readScopeAuthority(cwd, state).value;
  assertValid(journal, (value) => validateScopeControlJournal(value, authority), 'scope control journal');
  persistEvidence({
    documentPath: scopeControlJournalPath(cwd, state.prNumber),
    receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
    value: journal,
    expectedDigest: scopeControlJournalDigest(journal),
    label: 'scope control journal',
    replace: true,
  });
}

export function readScopeJournal(cwd, state) {
  const authority = readScopeAuthority(cwd, state).value;
  return readEvidence({
    documentPath: scopeControlJournalPath(cwd, state.prNumber),
    receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
    validate: (value) => validateScopeControlJournal(value, authority),
    expectedDigest: scopeControlJournalDigest,
    label: 'scope control journal',
  });
}

export function persistScopeReturn(cwd, state, envelope) {
  assertValid(envelope, validateScopeReturnEnvelope, 'scope return');
  persistEvidence({
    documentPath: scopeReturnPath(cwd, state.prNumber),
    receiptPath: scopeReturnReceiptPath(cwd, state.prNumber),
    value: envelope,
    expectedDigest: scopeReturnDigest(envelope),
    label: 'scope return',
    replace: true,
  });
}

export function readScopeReturn(cwd, state) {
  return readEvidence({
    documentPath: scopeReturnPath(cwd, state.prNumber),
    receiptPath: scopeReturnReceiptPath(cwd, state.prNumber),
    validate: validateScopeReturnEnvelope,
    expectedDigest: scopeReturnDigest,
    label: 'scope return',
  });
}
