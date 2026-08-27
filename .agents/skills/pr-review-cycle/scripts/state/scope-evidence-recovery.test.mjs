import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import test from 'node:test';

import * as harness from './test-support/state-harness.mjs';
import {
  persistScopeReturn,
  readScopeAuthority,
  readScopeJournal,
  readScopeReturn,
  scopeReturnDigest,
} from './evidence/scope-control.mjs';
import {
  scopeAuthorityPath,
  scopeAuthorityReceiptPath,
  scopeControlJournalPath,
  scopeControlJournalReceiptPath,
  scopeReturnPath,
  scopeReturnReceiptPath,
} from './locations.mjs';
import { initializeState } from './state.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function authority(headSha) {
  return {
    schemaVersion: 1,
    authorityKind: 'standalone',
    source: { type: 'github-issue', identity: 'example/aerstello#17', digest: DIGEST },
    planDigest: DIGEST,
    amendmentDigests: [],
    minimalClosure: { statement: 'The accepted remediation remains the minimal closure.', digest: DIGEST },
    handoffHeadSha: headSha,
    integratedHeadAssessment: null,
    approvedDecisions: [],
    deferredFollowUps: [],
    capturedAt: harness.AT,
  };
}

function scopeReturn(state) {
  return {
    schemaVersion: 1,
    repository: state.repository,
    prNumber: state.prNumber,
    authorityDigest: state.scopeControl.authorityDigest,
    journalDigest: state.scopeControl.journalDigest,
    blockerId: 'scope-blocker-one',
    decisionId: 'scope-decision-one',
    reviewHeadSha: state.currentIntegrationHeadSha,
    livePrHeadSha: state.currentIntegrationHeadSha,
    rootCauseId: 'scope-root-one',
    findingIds: ['local:scope-root-one'],
    findingFingerprints: ['scope-fingerprint-one'],
    assessmentDigest: DIGEST,
    smallestExpansion: 'Add only the explicitly approved scope.',
    narrowAlternative: 'Retain the current bounded remediation.',
    trimAlternative: null,
    inventory: {
      paths: ['scripts/example.mjs'],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      validation: ['node --test scripts/example.test.mjs'],
    },
    priorDecisionIds: [],
    createdAt: harness.AT,
  };
}

function fixture() {
  const cwd = harness.repo();
  const headSha = harness.git(cwd, ['rev-parse', 'HEAD']).trim();
  const state = initializeState({
    cwd,
    prNumber: 17,
    repository: 'example/aerstello',
    base: 'HEAD',
    head: 'HEAD',
    releaseRef: 'HEAD',
    scopeAuthority: authority(headSha),
  });
  const envelope = scopeReturn(state);
  persistScopeReturn(cwd, state, envelope);
  return { cwd, state, envelope };
}

function evidencePairs(cwd, state, envelope) {
  return [
    {
      label: 'scope authority',
      documentPath: scopeAuthorityPath(cwd, state.prNumber),
      receiptPath: scopeAuthorityReceiptPath(cwd, state.prNumber),
      read: () => readScopeAuthority(cwd, state),
      digest: state.scopeControl.authorityDigest,
    },
    {
      label: 'scope control journal',
      documentPath: scopeControlJournalPath(cwd, state.prNumber),
      receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
      read: () => readScopeJournal(cwd, state),
      digest: state.scopeControl.journalDigest,
    },
    {
      label: 'scope return',
      documentPath: scopeReturnPath(cwd, state.prNumber),
      receiptPath: scopeReturnReceiptPath(cwd, state.prNumber),
      read: () => readScopeReturn(cwd, state),
      digest: scopeReturnDigest(envelope),
    },
  ];
}

test('complete scope-evidence pairs are strict read-only inputs', () => {
  const { cwd, state, envelope } = fixture();

  for (const pair of evidencePairs(cwd, state, envelope)) {
    const documentBefore = readFileSync(pair.documentPath);
    const receiptBefore = readFileSync(pair.receiptPath);
    assert.equal(pair.read().digest, pair.digest, pair.label);
    assert.deepEqual(readFileSync(pair.documentPath), documentBefore, `${pair.label} document changed`);
    assert.deepEqual(readFileSync(pair.receiptPath), receiptBefore, `${pair.label} receipt changed`);
  }
});

test('strict scope-evidence reads do not repair a missing receipt', () => {
  for (const pairIndex of [0, 1, 2]) {
    const { cwd, state, envelope } = fixture();
    const pair = evidencePairs(cwd, state, envelope)[pairIndex];
    const documentBefore = readFileSync(pair.documentPath);
    unlinkSync(pair.receiptPath);

    assert.throws(pair.read, { code: 'INVALID_SCOPE_EVIDENCE' }, pair.label);
    assert.deepEqual(readFileSync(pair.documentPath), documentBefore, `${pair.label} document changed`);
    assert.equal(existsSync(pair.receiptPath), false, `${pair.label} receipt was recreated`);
  }
});
