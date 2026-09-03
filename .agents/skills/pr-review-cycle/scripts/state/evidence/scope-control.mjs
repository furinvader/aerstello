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
const SCOPE_JOURNAL_LIMIT_BYTES = 16 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalSerializedJson(value)).digest('hex')}`;
}

function assertValid(value, validate, label) {
  const errors = validate(value);
  if (errors.length > 0) {
    throw new StateError(`Invalid ${label}:\n- ${errors.join('\n- ')}`, 'INVALID_SCOPE_EVIDENCE');
  }
}

function assertWithinEvidenceLimit(value, label, limitBytes, limitLabel) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
  if (serializedBytes > limitBytes) {
    throw new StateError(`${label} exceeds ${limitLabel}`, 'SCOPE_EVIDENCE_TOO_LARGE');
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

function persistEvidence({
  documentPath,
  receiptPath,
  value,
  expectedDigest,
  valueDigest,
  previousDigest,
  label,
  replace = false,
  limitBytes = EVIDENCE_LIMIT_BYTES,
  limitLabel = '256 KiB',
}) {
  assertWithinEvidenceLimit(value, label, limitBytes, limitLabel);
  const serialized = canonicalSerializedJson(value);
  if (existsSync(documentPath)) {
    const existing = readJsonSidecar(documentPath, label, limitBytes);
    if (canonicalSerializedJson(existing) === serialized) {
      if (readReceipt(receiptPath, label) !== expectedDigest) {
        throw new StateError(`${label} receipt is stale or altered`, 'INVALID_SCOPE_EVIDENCE');
      }
      return;
    }
    if (!replace) throw new StateError(`A different ${label} already exists`, 'SCOPE_EVIDENCE_CONFLICT');
    const existingDigest = valueDigest(existing);
    const receiptDigest = readReceipt(receiptPath, label);
    if (existingDigest !== previousDigest) {
      throw new StateError(`${label} document does not match the compact state projection`, 'INVALID_SCOPE_EVIDENCE');
    }
    if (receiptDigest !== existingDigest && receiptDigest !== expectedDigest) {
      throw new StateError(`${label} receipt is neither the prior nor retried candidate identity`, 'INVALID_SCOPE_EVIDENCE');
    }
    if (receiptDigest === expectedDigest) {
      atomicWriteText(documentPath, serialized);
      return;
    }
  } else if (existsSync(receiptPath)) {
    if (previousDigest !== null || readReceipt(receiptPath, label) !== expectedDigest) {
      throw new StateError(`${label} receipt exists without uniquely matching retried evidence`, 'INVALID_SCOPE_EVIDENCE');
    }
    atomicWriteText(documentPath, serialized);
    return;
  }
  // Journal and return documents are durable projections whose receipts always bind the complete value.
  atomicWriteText(receiptPath, `${expectedDigest}\n`);
  atomicWriteText(documentPath, serialized);
}

function readEvidenceForUpdate({
  documentPath, receiptPath, validate, expectedDigest, previousDigest, label,
  limitBytes = EVIDENCE_LIMIT_BYTES,
}) {
  const value = readJsonSidecar(documentPath, label, limitBytes);
  assertValid(value, validate, label);
  const documentDigest = expectedDigest(value);
  const receiptDigest = readReceipt(receiptPath, label);
  if (!DIGEST_PATTERN.test(receiptDigest)) {
    throw new StateError(`${label} receipt is malformed`, 'INVALID_SCOPE_EVIDENCE');
  }
  if (receiptDigest !== documentDigest && documentDigest !== previousDigest) {
    throw new StateError(
      `${label} evidence is neither complete nor an interrupted update from compact state`,
      'INVALID_SCOPE_EVIDENCE',
    );
  }
  return { value, digest: documentDigest, receiptDigest };
}

function readEvidence({
  documentPath, receiptPath, validate, expectedDigest, label,
  limitBytes = EVIDENCE_LIMIT_BYTES,
}) {
  const value = readJsonSidecar(documentPath, label, limitBytes);
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

export function persistScopeAuthority(cwd, state, authority, { previousDigest = null } = {}) {
  assertValid(authority, validateScopeAuthoritySnapshot, 'scope authority');
  persistEvidence({
    documentPath: scopeAuthorityPath(cwd, state.prNumber),
    receiptPath: scopeAuthorityReceiptPath(cwd, state.prNumber),
    value: authority,
    expectedDigest: scopeAuthorityDigest(authority),
    valueDigest: scopeAuthorityDigest,
    previousDigest,
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

export function persistScopeJournal(cwd, state, journal, {
  previousDigest = state.scopeControl?.journalDigest ?? null,
} = {}) {
  const authority = readScopeAuthority(cwd, state).value;
  assertValid(journal, (value) => validateScopeControlJournal(value, authority), 'scope control journal');
  assertWithinEvidenceLimit(
    journal,
    'scope control journal',
    SCOPE_JOURNAL_LIMIT_BYTES,
    '16 MiB',
  );
  persistEvidence({
    documentPath: scopeControlJournalPath(cwd, state.prNumber),
    receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
    value: journal,
    expectedDigest: scopeControlJournalDigest(journal),
    valueDigest: scopeControlJournalDigest,
    previousDigest,
    label: 'scope control journal',
    replace: true,
    limitBytes: SCOPE_JOURNAL_LIMIT_BYTES,
    limitLabel: '16 MiB',
  });
}

export function readScopeJournalForUpdate(cwd, state) {
  const authority = readScopeAuthority(cwd, state).value;
  return readEvidenceForUpdate({
    documentPath: scopeControlJournalPath(cwd, state.prNumber),
    receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
    validate: (value) => validateScopeControlJournal(value, authority),
    expectedDigest: scopeControlJournalDigest,
    previousDigest: state.scopeControl?.journalDigest ?? null,
    label: 'scope control journal',
    limitBytes: SCOPE_JOURNAL_LIMIT_BYTES,
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
    limitBytes: SCOPE_JOURNAL_LIMIT_BYTES,
  });
}

export function persistScopeReturn(cwd, state, envelope, {
  previousDigest = state.scopeControl?.returnDigest ?? null,
} = {}) {
  assertValid(envelope, validateScopeReturnEnvelope, 'scope return');
  persistEvidence({
    documentPath: scopeReturnPath(cwd, state.prNumber),
    receiptPath: scopeReturnReceiptPath(cwd, state.prNumber),
    value: envelope,
    expectedDigest: scopeReturnDigest(envelope),
    valueDigest: scopeReturnDigest,
    previousDigest,
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
