import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertScopeReady,
  assertScopeRootReady,
  readScopeReadiness,
  scopeStatusSummary,
} from './scope-readiness.mjs';

const HEAD = 'a'.repeat(40);
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_D = `sha256:${'d'.repeat(64)}`;
const ASSESSMENT = `sha256:${'c'.repeat(64)}`;

function classification({
  phase = 'integrated-head', headSha = HEAD, authorityDigest = DIGEST_A,
  rootCauseId = 'scope-root', findingIds = ['finding-one'],
  findingFingerprints = ['scope-fingerprint-f1'],
} = {}) {
  return {
    schemaVersion: 1, kind: 'classification', rootCauseId, findingIds, findingFingerprints,
    reviewHeadSha: headSha, authorityDigest, classification: 'within-scope-defect',
    authorityAmendmentRequired: false,
    assessment: {
      digest: ASSESSMENT,
      packet: { binding: { phase }, minimalClosure: { statement: 'Preserve the accepted boundary.' } },
      result: { binding: { phase }, verdict: 'within-scope' },
    },
  };
}

function manifest(headSha = HEAD, authorityDigest = DIGEST_A, rootCauseId = 'scope-root') {
  return {
    schemaVersion: 1, kind: 'exact-head-manifest', rootCauseId, reviewHeadSha: headSha,
    authorityDigest, assessmentDigest: ASSESSMENT, triggerKinds: ['classification'],
  };
}

function amendedFixture() {
  const entries = [
    classification({
      phase: 'review-finding', authorityDigest: DIGEST_A,
      rootCauseId: 'stale-root', findingIds: ['stale-finding'],
    }),
    {
      schemaVersion: 1, kind: 'decision', authorityDigest: DIGEST_A,
      rootCauseId: 'scope-root', reviewHeadSha: HEAD,
    },
    {
      schemaVersion: 1, kind: 'amendment', authorityDigest: DIGEST_A,
      rootCauseId: 'scope-root', reviewHeadSha: HEAD,
      priorAuthorityDigest: DIGEST_A, revisedAuthorityDigest: DIGEST_D,
    },
    classification({ authorityDigest: DIGEST_D }),
    manifest(HEAD, DIGEST_D),
  ];
  return fixture({
    reference: { authorityDigest: DIGEST_D, assessmentHeadSha: HEAD },
    status: {
      journal: { digest: DIGEST_B, value: { authorityDigest: DIGEST_D, entries } },
    },
  });
}

function fixture(overrides = {}) {
  const reference = {
    authorityDigest: DIGEST_A, journalDigest: DIGEST_B, returnDigest: null,
    gate: 'ready', assessmentHeadSha: null, updatedAt: '2026-08-27T00:00:00Z',
    ...overrides.reference,
  };
  return {
    state: { prNumber: 53, currentIntegrationHeadSha: HEAD, scopeControl: reference },
    status: {
      configured: true, gate: reference.gate, reference,
      authority: {
        digest: DIGEST_A,
        value: {
          authorityKind: 'standalone', source: { identity: 'furinvader/aerstello#54' },
          minimalClosure: { statement: 'Close only the accepted import boundary.' }, handoffHeadSha: HEAD,
        },
      },
      journal: { digest: DIGEST_B, value: { authorityDigest: DIGEST_A, entries: [] } },
      return: null,
      ...overrides.status,
    },
  };
}

test('accepts only receipt-valid ready scope at the exact active and live PR HEAD', async () => {
  const { state, status } = fixture();
  const adapter = { async scopeStatus() { return status; } };
  const readiness = await assertScopeReady(adapter, state, HEAD);
  assert.equal(readiness.ready, true);
  assert.equal(scopeStatusSummary(readiness).blocker, null);

  await assert.rejects(() => assertScopeReady(adapter, state, 'b'.repeat(40)), { code: 'SCOPE_EVIDENCE_STALE' });
  status.journal.digest = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(() => assertScopeReady(adapter, state, HEAD), { code: 'SCOPE_EVIDENCE_INVALID' });
});

test('requires a terminal canonical integrated-head manifest after classification history begins', async () => {
  for (const entries of [
    [classification()],
    [classification({ phase: 'review-finding' }), manifest()],
    [classification(), manifest(), { schemaVersion: 1, kind: 'decision', reviewHeadSha: HEAD }],
  ]) {
    const { state, status } = fixture({
      reference: { assessmentHeadSha: HEAD },
      status: { journal: { digest: DIGEST_B, value: { authorityDigest: DIGEST_A, entries } } },
    });
    const adapter = { async scopeStatus() { return status; } };
    await assert.rejects(() => assertScopeReady(adapter, state, HEAD), { code: 'SCOPE_EVIDENCE_INVALID' });
  }

  const staleHead = 'b'.repeat(40);
  const stale = fixture({
    reference: { assessmentHeadSha: staleHead },
    status: {
      journal: {
        digest: DIGEST_B,
        value: {
          authorityDigest: DIGEST_A,
          entries: [classification({ headSha: staleHead }), manifest(staleHead)],
        },
      },
    },
  });
  await assert.rejects(
    () => assertScopeReady({ async scopeStatus() { return stale.status; } }, stale.state, HEAD),
    { code: 'SCOPE_EVIDENCE_STALE' },
  );

  const { state, status } = fixture({
    reference: { assessmentHeadSha: HEAD },
    status: {
      journal: {
        digest: DIGEST_B,
        value: { authorityDigest: DIGEST_A, entries: [classification(), manifest()] },
      },
    },
  });
  const readiness = await assertScopeReady({ async scopeStatus() { return status; } }, state, HEAD);
  assert.equal(readiness.exactHeadManifest.classification.assessment.result.verdict, 'within-scope');
});

test('preserves pristine standalone and imported readiness without accepting empty legacy adoption', async () => {
  for (const authorityKind of ['standalone', 'imported']) {
    const { state, status } = fixture();
    status.authority.value.authorityKind = authorityKind;
    assert.equal((await assertScopeReady({ async scopeStatus() { return status; } }, state, HEAD)).ready, true);
  }
  const { state, status } = fixture();
  status.authority.value.authorityKind = 'legacy-adoption';
  await assert.rejects(() => assertScopeReady({ async scopeStatus() { return status; } }, state, HEAD), {
    code: 'SCOPE_EVIDENCE_INVALID',
  });
});

test('selected-root readiness is phase-aware and rejects superseded authority', async () => {
  const reviewedHead = 'b'.repeat(40);
  const entry = classification({ phase: 'review-finding', headSha: reviewedHead });
  const { state, status } = fixture({
    reference: { assessmentHeadSha: reviewedHead },
    status: {
      journal: {
        digest: DIGEST_B,
        value: { authorityDigest: DIGEST_A, entries: [entry] },
      },
    },
  });
  state.reviewedHeadSha = reviewedHead;
  const adapter = { async scopeStatus() { return status; } };
  const task = { id: entry.rootCauseId, sourceIds: entry.findingIds, fingerprint: 'scope-fingerprint' };
  assert.equal((await assertScopeRootReady(adapter, state, HEAD, task)).classification, entry);

  entry.authorityDigest = `sha256:${'d'.repeat(64)}`;
  await assert.rejects(() => assertScopeRootReady(adapter, state, HEAD, task), {
    code: 'SCOPE_ROOT_NOT_READY',
  });
});

test('accepts revised effective authority while rejecting stale or tampered amendment evidence', async () => {
  const amended = amendedFixture();
  const adapter = { async scopeStatus() { return amended.status; } };
  const readiness = await assertScopeReady(adapter, amended.state, HEAD);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.authorityDigest, DIGEST_D);
  assert.equal((await assertScopeRootReady(
    adapter, amended.state, HEAD, { id: 'scope-root', sourceIds: ['finding-one'], fingerprint: 'scope-fingerprint' },
  )).classification.authorityDigest, DIGEST_D);
  await assert.rejects(() => assertScopeRootReady(
    adapter, amended.state, HEAD, { id: 'stale-root', sourceIds: ['stale-finding'], fingerprint: 'scope-fingerprint' },
  ), { code: 'SCOPE_ROOT_NOT_READY' });

  const tamperedSnapshot = amendedFixture();
  tamperedSnapshot.status.authority.digest = DIGEST_B;
  await assert.rejects(
    () => assertScopeReady({ async scopeStatus() { return tamperedSnapshot.status; } }, tamperedSnapshot.state, HEAD),
    { code: 'SCOPE_EVIDENCE_INVALID' },
  );

  const divergentJournal = amendedFixture();
  divergentJournal.status.journal.value.authorityDigest = ASSESSMENT;
  await assert.rejects(
    () => assertScopeReady({ async scopeStatus() { return divergentJournal.status; } }, divergentJournal.state, HEAD),
    { code: 'SCOPE_EVIDENCE_INVALID' },
  );

  const staleManifest = amendedFixture();
  staleManifest.status.journal.value.entries.at(-1).authorityDigest = DIGEST_A;
  await assert.rejects(
    () => assertScopeReady({ async scopeStatus() { return staleManifest.status; } }, staleManifest.state, HEAD),
    { code: 'SCOPE_EVIDENCE_INVALID' },
  );
});

test('selected-root readiness requires the complete task classification identity', async () => {
  const reviewedHead = 'b'.repeat(40);
  const task = {
    id: 'multi-root-task',
    sourceIds: ['finding-one', 'finding-two'],
    fingerprint: 'multi-root-fingerprint',
  };
  const baseEntry = classification({
    phase: 'review-finding', headSha: reviewedHead, rootCauseId: task.id,
    findingIds: task.sourceIds,
    findingFingerprints: ['multi-root-fingerprint-f1', 'multi-root-fingerprint-f2'],
  });
  const assertEntry = async (entry) => {
    const { state, status } = fixture({
      reference: { assessmentHeadSha: reviewedHead },
      status: { journal: { digest: DIGEST_B, value: { authorityDigest: DIGEST_A, entries: [entry] } } },
    });
    state.reviewedHeadSha = reviewedHead;
    return assertScopeRootReady({ async scopeStatus() { return status; } }, state, HEAD, task);
  };

  assert.equal((await assertEntry({
    ...baseEntry,
    rootCauseId: 'independent-lifecycle-root',
    findingIds: [...baseEntry.findingIds].reverse(),
    findingFingerprints: [...baseEntry.findingFingerprints].reverse(),
  })).classification.rootCauseId, 'independent-lifecycle-root');
  for (const entry of [
    { ...baseEntry, findingIds: ['finding-one'], findingFingerprints: ['multi-root-fingerprint-f1'] },
    { ...baseEntry, findingIds: ['finding-one', 'finding-foreign'] },
    { ...baseEntry, findingIds: ['finding-one', 'finding-one'] },
    { ...baseEntry, findingFingerprints: ['multi-root-fingerprint-f1', 'foreign-f2'] },
  ]) await assert.rejects(() => assertEntry(entry), { code: 'SCOPE_ROOT_NOT_READY' });
});

test('reports durable decision, return, and resume blockers without trusting compact state alone', async () => {
  for (const gate of ['decision-required', 'return-pending', 'returned', 'resume-required']) {
    const { state, status } = fixture({ reference: { gate } });
    const adapter = { async scopeStatus() { return status; } };
    const readiness = await readScopeReadiness(adapter, state, HEAD);
    assert.equal(readiness.ready, false);
    await assert.rejects(() => assertScopeReady(adapter, state, HEAD), { code: 'SCOPE_NOT_READY' });
    assert.match(scopeStatusSummary(readiness).blocker, new RegExp(gate, 'u'));
  }
});

test('fails closed when the receipt-valid facade operation is unavailable or interrupted', async () => {
  const { state } = fixture();
  await assert.rejects(() => assertScopeReady({}, state, HEAD), { code: 'INVALID_ADAPTERS' });
  await assert.rejects(() => assertScopeReady({ scopeStatus() { throw new Error('receipt mismatch'); } }, state, HEAD), {
    code: 'SCOPE_EVIDENCE_INVALID',
  });
});

test('fails closed for explicit insufficient authority and legacy state without scopeControl', async () => {
  const { state, status } = fixture({ reference: { gate: 'insufficient-authority', assessmentHeadSha: null } });
  const adapter = { async scopeStatus() { return status; } };
  await assert.rejects(() => assertScopeReady(adapter, state, HEAD), { code: 'SCOPE_NOT_READY' });

  const legacy = { ...state };
  delete legacy.scopeControl;
  await assert.rejects(() => assertScopeReady(adapter, legacy, HEAD), { code: 'SCOPE_EVIDENCE_INVALID' });
});
