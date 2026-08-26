import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { sha256CanonicalContractJson } from './contract-identities.mjs';
let contract;

const AT = '2026-08-27T08:00:00Z';
const HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const THIRD_DIGEST = `sha256:${'c'.repeat(64)}`;

function binding() {
  return {
    phase: 'integrated-head',
    source: { type: 'github-issue', identity: 'furinvader/aerstello#56', digest: DIGEST },
    subject: { digest: OTHER_DIGEST, sha: HEAD },
    planDigest: THIRD_DIGEST,
    amendmentDigests: [],
    taskPacketDigest: DIGEST,
  };
}

function assessmentPacket() {
  return {
    schemaVersion: 1,
    binding: binding(),
    sourceScope: {
      objective: 'Keep remediation inside accepted scope.',
      requiredCriteria: [{ id: 'scope-gate', text: 'Gate expanded remediation.' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'scope-gate', text: 'Gate expanded remediation.' }],
      invariants: [{ id: 'exact-head', text: 'Bind evidence to the exact review head.' }],
      minimalClosure: 'A strict scope gate is sufficient.',
      authorizedShape: ['scope-gate'],
      unauthorizedShape: ['generalized-policy-engine'],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'Use the bounded scope gate.',
      paths: ['.agents/skills/pr-review-cycle'],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: ['scope-gate'],
      mappings: [{
        mechanism: 'scope-gate', sourceCriterionIds: ['scope-gate'], acceptedCriterionIds: ['scope-gate'],
        invariantIds: ['exact-head'], nonGoalIds: [], guidanceIds: [],
        rationale: 'The mechanism directly implements the accepted gate.',
      }],
    },
    tripwires: [],
  };
}

function assessmentResult(packet = assessmentPacket()) {
  return {
    schemaVersion: 1,
    binding: packet.binding,
    verdict: 'within-scope',
    summary: 'The bounded gate remains within accepted scope.',
    coverage: [{
      mechanism: 'scope-gate', sourceCriterionIds: ['scope-gate'], acceptedCriterionIds: ['scope-gate'],
      invariantIds: ['exact-head'], nonGoalIds: [], guidanceIds: [], classification: 'required',
      rationale: 'The mechanism is required by the accepted criterion.',
    }],
    unnecessaryWork: [], smallerSufficientAlternative: null, scopeDelta: null,
    materialityTriggers: [], smallestExpansion: null, narrowAlternative: null,
    deferralConsequences: null, missingEvidence: [], humanDecision: false,
  };
}

function assessmentPair() {
  const packet = assessmentPacket();
  const result = assessmentResult(packet);
  return {
    packet, result,
    digest: `sha256:${sha256CanonicalContractJson({ packet, result })}`,
  };
}

function authority(overrides = {}) {
  return {
    schemaVersion: 1,
    authorityKind: 'imported',
    source: { type: 'github-issue', identity: 'furinvader/aerstello#56', digest: DIGEST },
    planDigest: THIRD_DIGEST,
    amendmentDigests: [],
    minimalClosure: { statement: 'A bounded scope gate is sufficient.', digest: OTHER_DIGEST },
    handoffHeadSha: HEAD,
    integratedHeadAssessment: assessmentPair(),
    approvedDecisions: [{ id: 'initial-scope', digest: DIGEST }],
    deferredFollowUps: [{ id: 'delivery-linkage', reference: 'furinvader/aerstello#26' }],
    capturedAt: AT,
    ...overrides,
  };
}

test('scope-control contract loads', async () => {
  contract = await import('./scope-control.mjs');
});

function classificationEntry(authorityDigest, overrides = {}) {
  return {
    schemaVersion: 1, sequence: 1, entryId: 'classification-one', kind: 'classification', at: AT,
    reviewHeadSha: HEAD, authorityDigest, rootCauseId: 'scope-root',
    findingIds: ['thread:PRRT_one'], findingFingerprints: ['fingerprint-one'],
    classification: 'within-scope-defect', assessment: assessmentPair(),
    authorityAmendmentRequired: false, unrelatedReference: null,
    remediationShapeDigest: THIRD_DIGEST, tripwires: [],
    ...overrides,
  };
}

function journal(authorityDigest, overrides = {}) {
  return { schemaVersion: 1, prNumber: 56, authorityDigest, entries: [classificationEntry(authorityDigest)], ...overrides };
}

function scopeReturn(authorityDigest, journalDigest, overrides = {}) {
  return {
    schemaVersion: 1, repository: 'furinvader/aerstello', prNumber: 56,
    authorityDigest, journalDigest, blockerId: 'scope-blocker', decisionId: 'scope-decision',
    reviewHeadSha: HEAD, livePrHeadSha: HEAD, rootCauseId: 'scope-root',
    findingIds: ['thread:PRRT_one'], findingFingerprints: ['fingerprint-one'],
    assessmentDigest: assessmentPair().digest,
    smallestExpansion: 'Maintain the new persistent scope boundary.',
    narrowAlternative: 'Remove the generalized mechanism.', trimAlternative: 'Retain direct assertions only.',
    inventory: {
      paths: ['.agents/skills/pr-review-cycle'], dependencies: [], publicSurfaces: ['review:state'],
      persistentSurfaces: ['scope-control-journal'], validation: ['npm run test:pr-review'],
    },
    priorDecisionIds: [], createdAt: AT,
    ...overrides,
  };
}

test('scope-control exports closed policy vocabularies', () => {
  const { SCOPE_CLASSIFICATIONS, SCOPE_CONTROL_GATES, SCOPE_DECISIONS, SCOPE_JOURNAL_ENTRY_KINDS } = contract;
  assert.deepEqual(SCOPE_CLASSIFICATIONS, [
    'within-scope-defect', 'unnecessary-mechanism-defect', 'material-scope-change',
    'unrelated-follow-up', 'insufficient-scope-authority',
  ]);
  assert.deepEqual(SCOPE_DECISIONS, [
    'approve-expansion-and-replan', 'remove-or-simplify', 'split-or-defer',
    'reject-expansion', 'abandon-or-rework',
  ]);
  assert.deepEqual(SCOPE_JOURNAL_ENTRY_KINDS, [
    'classification', 'decision', 'amendment', 'exact-head-manifest', 'resume',
  ]);
  assert.deepEqual(SCOPE_CONTROL_GATES, [
    'insufficient-authority', 'ready', 'decision-required', 'return-pending',
    'returned', 'resume-required',
  ]);
});

test('imported authority requires complete real scope identities and a current within-scope assessment', () => {
  const { scopeAuthorityDigest, validateScopeAuthoritySnapshot } = contract;
  const imported = authority();
  assert.deepEqual(validateScopeAuthoritySnapshot(imported), []);
  assert.match(scopeAuthorityDigest(imported), /^sha256:[0-9a-f]{64}$/u);

  const standalone = authority({ authorityKind: 'standalone', planDigest: null, integratedHeadAssessment: null });
  assert.deepEqual(validateScopeAuthoritySnapshot(standalone), []);

  assert.match(validateScopeAuthoritySnapshot(authority({ planDigest: null })).join('\n'), /planDigest is required/u);
  assert.match(validateScopeAuthoritySnapshot(authority({ integratedHeadAssessment: null })).join('\n'), /integratedHeadAssessment is required/u);
  const stale = assessmentPair();
  stale.packet.binding.subject.sha = OTHER_HEAD;
  stale.result.binding.subject.sha = OTHER_HEAD;
  stale.digest = `sha256:${sha256CanonicalContractJson({ packet: stale.packet, result: stale.result })}`;
  assert.match(validateScopeAuthoritySnapshot(authority({ integratedHeadAssessment: stale })).join('\n'), /exact expected HEAD/u);
});

test('journal is append-only shaped and embeds exact canonical assessment evidence', () => {
  const { scopeAuthorityDigest, scopeControlJournalDigest, validateScopeControlJournal } = contract;
  const authorityDigest = scopeAuthorityDigest(authority());
  const value = journal(authorityDigest);
  assert.deepEqual(validateScopeControlJournal(value), []);
  assert.match(scopeControlJournalDigest(value), /^sha256:[0-9a-f]{64}$/u);

  assert.match(validateScopeControlJournal(journal(authorityDigest, {
    entries: [classificationEntry(authorityDigest, { sequence: 2 })],
  })).join('\n'), /one-based position/u);
  assert.match(validateScopeControlJournal(journal(authorityDigest, {
    entries: [classificationEntry(authorityDigest, { authorityDigest: OTHER_DIGEST })],
  })).join('\n'), /journal authority/u);
  const changedPair = assessmentPair();
  changedPair.digest = DIGEST;
  assert.match(validateScopeControlJournal(journal(authorityDigest, {
    entries: [classificationEntry(authorityDigest, { assessment: changedPair })],
  })).join('\n'), /canonical packet\/result pair/u);
});

test('all non-assessment journal variants are closed and exact-evidence-bound', () => {
  const { scopeAuthorityDigest, scopeExactHeadManifestDigest, validateScopeControlJournal } = contract;
  const authorityDigest = scopeAuthorityDigest(authority());
  const common = {
    schemaVersion: 1, at: AT, reviewHeadSha: HEAD, authorityDigest, rootCauseId: 'scope-root',
  };
  const entries = [classificationEntry(authorityDigest)];
  entries.push(
    {
      ...common, sequence: 2, entryId: 'decision-one', kind: 'decision', blockerId: 'blocker-one',
      decisionId: 'decision-one', decision: 'approve-expansion-and-replan', assessmentDigest: DIGEST,
      blockerDigest: OTHER_DIGEST, approvedDeltaDigest: THIRD_DIGEST, rationale: 'Approve the bounded delta.',
      priorDecisionIds: [],
    },
    {
      ...common, sequence: 3, entryId: 'amendment-one', kind: 'amendment', decisionId: 'decision-one',
      amendmentDigest: DIGEST, priorAuthorityDigest: authorityDigest, revisedAuthorityDigest: OTHER_DIGEST,
    },
  );
  entries.push(
    {
      ...common, sequence: 4, entryId: 'manifest-one', kind: 'exact-head-manifest',
      manifestDigest: scopeExactHeadManifestDigest(entries, HEAD), assessmentDigest: OTHER_DIGEST, triggerKinds: ['persistent-surface'],
    },
    {
      ...common, sequence: 5, entryId: 'resume-one', kind: 'resume', decisionId: 'decision-one',
      scopeReturnDigest: DIGEST, resumedAuthorityDigest: OTHER_DIGEST, resumedHeadSha: HEAD,
    },
  );
  assert.deepEqual(validateScopeControlJournal(journal(authorityDigest, { entries })), []);
  const invalid = structuredClone(entries);
  invalid[1].approvedDeltaDigest = null;
  invalid[4].resumedHeadSha = OTHER_HEAD;
  const errors = validateScopeControlJournal(journal(authorityDigest, { entries: invalid })).join('\n');
  assert.match(errors, /approvedDeltaDigest is required/u);
  assert.match(errors, /resumedHeadSha must equal reviewHeadSha/u);
});

test('minor amendments remain fail-closed through a decision-required projection', () => {
  const { scopeGateForClassificationEntry, validateScopeControlJournal } = contract;
  const authorityDigest = `sha256:${'d'.repeat(64)}`;
  const packet = assessmentPacket();
  packet.acceptedScope.criteria.push({ id: 'amended-gate', text: 'Authorize the bounded extra behavior.' });
  packet.changeInventory.mappings[0].acceptedCriterionIds.push('amended-gate');
  const result = assessmentResult(packet);
  result.verdict = 'minor-amendment-required';
  result.coverage[0].classification = 'necessary-minor-expansion';
  result.coverage[0].acceptedCriterionIds.push('amended-gate');
  result.scopeDelta = {
    description: 'Authorize the bounded extra behavior.', sourceCriterionIds: [],
    acceptedCriterionIds: ['amended-gate'], invariantIds: [], materialSurfaces: [],
  };
  const entry = classificationEntry(authorityDigest, {
    assessment: { packet, result, digest: `sha256:${sha256CanonicalContractJson({ packet, result })}` },
    authorityAmendmentRequired: true,
  });
  assert.deepEqual(validateScopeControlJournal(journal(authorityDigest, { entries: [entry] })), []);
  assert.equal(scopeGateForClassificationEntry(entry), 'decision-required');
  const unguarded = { ...entry, authorityAmendmentRequired: false };
  assert.match(validateScopeControlJournal(journal(authorityDigest, { entries: [unguarded] })).join('\n'), /minor-amendment verdict/u);
});

test('guarded scope return binds exact live head, findings, alternatives, and inventory', () => {
  const { scopeAuthorityDigest, scopeControlJournalDigest, validateScopeReturnEnvelope } = contract;
  const authorityDigest = scopeAuthorityDigest(authority());
  const journalDigest = scopeControlJournalDigest(journal(authorityDigest));
  const value = scopeReturn(authorityDigest, journalDigest);
  assert.deepEqual(validateScopeReturnEnvelope(value), []);
  assert.match(validateScopeReturnEnvelope({ ...value, livePrHeadSha: OTHER_HEAD }).join('\n'), /must equal livePrHeadSha/u);
  assert.match(validateScopeReturnEnvelope({ ...value, narrowAlternative: null }).join('\n'), /narrowAlternative is required/u);
});

test('compact state reference carries only receipt identities and gate projection', () => {
  const { validateScopeControlReference } = contract;
  const reference = {
    authorityDigest: DIGEST, journalDigest: OTHER_DIGEST, returnDigest: null,
    gate: 'ready', assessmentHeadSha: HEAD, updatedAt: AT,
  };
  assert.deepEqual(validateScopeControlReference(reference), []);
  assert.match(validateScopeControlReference({ ...reference, gate: 'returned' }).join('\n'), /returnDigest is required/u);
  assert.match(validateScopeControlReference({ ...reference, packet: assessmentPacket() }).join('\n'), /not supported/u);
});

test('scope-control JSON Schema accepts all three strict persistent surfaces', () => {
  const { scopeAuthorityDigest, scopeControlJournalDigest } = contract;
  const schema = JSON.parse(readFileSync(new URL('../../schemas/scope-control.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const authorityValue = authority();
  const authorityDigest = scopeAuthorityDigest(authorityValue);
  const journalValue = journal(authorityDigest);
  for (const value of [authorityValue, journalValue, scopeReturn(authorityDigest, scopeControlJournalDigest(journalValue))]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  assert.equal(validate({ schemaVersion: 1, guessedScope: true }), false);
});
