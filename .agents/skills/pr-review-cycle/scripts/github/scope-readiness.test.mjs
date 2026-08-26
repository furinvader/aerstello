import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertScopeReady,
  readScopeReadiness,
  scopeStatusSummary,
} from './scope-readiness.mjs';

const HEAD = 'a'.repeat(40);
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function fixture(overrides = {}) {
  const reference = {
    authorityDigest: DIGEST_A, journalDigest: DIGEST_B, returnDigest: null,
    gate: 'ready', assessmentHeadSha: HEAD, updatedAt: '2026-08-27T00:00:00Z',
    ...overrides.reference,
  };
  return {
    state: { prNumber: 53, currentIntegrationHeadSha: HEAD, scopeControl: reference },
    status: {
      configured: true, gate: reference.gate, reference,
      authority: {
        digest: DIGEST_A,
        value: {
          authorityKind: 'legacy-adoption', source: { identity: 'furinvader/aerstello#54' },
          minimalClosure: { statement: 'Close only the accepted import boundary.' }, handoffHeadSha: HEAD,
        },
      },
      journal: { digest: DIGEST_B, value: { entries: [] } },
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
