import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { buildDevelopmentScopeHandoff } from '../../../change-development/scripts/handoff/contracts.mjs';
import { scopeContractDigest } from '../../../change-development/scripts/scope/contracts.mjs';
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

function bindAssessmentAuthority(pair, authorityValue, amendmentDigests = authorityValue.amendmentDigests) {
  for (const side of ['packet', 'result']) {
    pair[side].binding.source = structuredClone(authorityValue.source);
    pair[side].binding.planDigest = authorityValue.planDigest;
    pair[side].binding.amendmentDigests = [...amendmentDigests];
    if (authorityValue.planDigest === null) pair[side].binding.taskPacketDigest = null;
  }
  pair.digest = `sha256:${sha256CanonicalContractJson({ packet: pair.packet, result: pair.result })}`;
  return pair;
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

function developmentReceipt(value) {
  return { value, digest: scopeContractDigest(value) };
}

function developmentHandoffInput() {
  const effectivePlan = developmentReceipt({
    schemaVersion: 1, changeId: 'issue-55', planRevision: 1,
    source: { kind: 'github-issue', reference: 'furinvader/aerstello#56', captureDigest: DIGEST },
    planning: { planningSha: HEAD },
  });
  const minimalClosure = developmentReceipt({
    schemaVersion: 1, changeId: 'issue-55', revision: 1,
    source: { type: 'github-issue', identity: 'furinvader/aerstello#56', digest: DIGEST },
    planningSha: HEAD, planDigest: effectivePlan.digest, previousContractDigest: null,
    outcome: 'A bounded scope gate is sufficient.',
    requiredCriteria: [{ id: 'scope-gate', text: 'Gate expanded remediation.' }],
    invariants: [], nonGoals: [], mandatoryConstraints: [], optionalGuidance: [],
    authorizedShape: ['scope-gate'], unauthorizedExpansion: ['generalized-policy-engine'],
    deferredFollowups: [], operatorDecisionDigests: [],
  });
  const pair = assessmentPair();
  const projectedAuthority = {
    source: minimalClosure.value.source,
    planDigest: effectivePlan.digest,
    amendmentDigests: [],
  };
  bindAssessmentAuthority(pair, projectedAuthority);
  const integratedScopeEvidence = developmentReceipt({
    schemaVersion: 1, changeId: 'issue-55', evidenceId: 'integrated-head-1', revision: 1,
    cadence: { boundary: 'integrated-head', trigger: null },
    packet: pair.packet, packetDigest: scopeContractDigest(pair.packet),
    result: pair.result, resultDigest: scopeContractDigest(pair.result),
    closureDigest: minimalClosure.digest,
  });
  return {
    changeId: 'issue-55', headSha: HEAD, capturedAt: AT,
    minimalClosure, effectivePlan, amendments: [], decisions: [], integratedScopeEvidence,
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

test('scope classification task identity requires the exact indexed finding map', () => {
  const { scopeClassificationMatchesTask } = contract;
  const task = {
    id: 'task-identity',
    sourceIds: ['thread:one', 'thread:two'],
    fingerprint: 'task-fingerprint',
  };
  const exact = {
    rootCauseId: 'independent-lifecycle-root',
    findingIds: ['thread:one', 'thread:two'],
    findingFingerprints: ['task-fingerprint-f1', 'task-fingerprint-f2'],
  };
  assert.equal(scopeClassificationMatchesTask(exact, task), true);
  assert.equal(scopeClassificationMatchesTask({
    ...exact,
    findingIds: [...exact.findingIds].reverse(),
    findingFingerprints: [...exact.findingFingerprints].reverse(),
  }, task), true);
  for (const classification of [
    { ...exact, findingIds: ['thread:one'], findingFingerprints: ['task-fingerprint-f1'] },
    { ...exact, findingIds: ['thread:one', 'thread:two', 'thread:three'], findingFingerprints: ['task-fingerprint-f1', 'task-fingerprint-f2', 'task-fingerprint-f3'] },
    { ...exact, findingIds: ['thread:one', 'thread:foreign'] },
    { ...exact, findingIds: ['thread:one', 'thread:one'] },
    { ...exact, findingFingerprints: ['task-fingerprint-f1', 'foreign-f2'] },
  ]) assert.equal(scopeClassificationMatchesTask(classification, task), false);
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
  const wrongPhase = assessmentPair();
  wrongPhase.packet.binding.phase = 'task';
  wrongPhase.result.binding.phase = 'task';
  wrongPhase.digest = `sha256:${sha256CanonicalContractJson({ packet: wrongPhase.packet, result: wrongPhase.result })}`;
  assert.match(validateScopeAuthoritySnapshot(authority({ integratedHeadAssessment: wrongPhase })).join('\n'), /canonical integrated-head/u);
  const stale = assessmentPair();
  stale.packet.binding.subject.sha = OTHER_HEAD;
  stale.result.binding.subject.sha = OTHER_HEAD;
  stale.digest = `sha256:${sha256CanonicalContractJson({ packet: stale.packet, result: stale.result })}`;
  assert.match(validateScopeAuthoritySnapshot(authority({ integratedHeadAssessment: stale })).join('\n'), /exact expected HEAD/u);

  const capturedAmendments = [DIGEST, OTHER_DIGEST];
  const correlated = authority({ amendmentDigests: capturedAmendments });
  correlated.integratedHeadAssessment = bindAssessmentAuthority(
    correlated.integratedHeadAssessment,
    correlated,
  );
  assert.deepEqual(validateScopeAuthoritySnapshot(correlated), []);
  for (const mutate of [
    (bindingValue) => { bindingValue.source.digest = THIRD_DIGEST; },
    (bindingValue) => { bindingValue.planDigest = DIGEST; },
    (bindingValue) => { bindingValue.amendmentDigests = [OTHER_DIGEST, DIGEST]; },
    (bindingValue) => { bindingValue.amendmentDigests = [DIGEST]; },
    (bindingValue) => { bindingValue.amendmentDigests = [...capturedAmendments, THIRD_DIGEST]; },
  ]) {
    const mismatched = structuredClone(correlated);
    mutate(mismatched.integratedHeadAssessment.packet.binding);
    mismatched.integratedHeadAssessment.result.binding = structuredClone(
      mismatched.integratedHeadAssessment.packet.binding,
    );
    mismatched.integratedHeadAssessment.digest = `sha256:${sha256CanonicalContractJson({
      packet: mismatched.integratedHeadAssessment.packet,
      result: mismatched.integratedHeadAssessment.result,
    })}`;
    assert.notDeepEqual(validateScopeAuthoritySnapshot(mismatched), []);
  }

  assert.match(validateScopeAuthoritySnapshot(authority({
    authorityKind: 'standalone', planDigest: null, amendmentDigests: [DIGEST],
    integratedHeadAssessment: null,
  })).join('\n'), /amendmentDigests requires a plan digest/u);
});

test('accepts the real development scope handoff and its canonical authority digest', () => {
  const { scopeAuthorityDigest, validateScopeAuthoritySnapshot } = contract;
  const handoff = buildDevelopmentScopeHandoff(developmentHandoffInput());
  assert.deepEqual(validateScopeAuthoritySnapshot(handoff), []);
  assert.match(scopeAuthorityDigest(handoff), /^sha256:[0-9a-f]{64}$/u);
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
  })).join('\n'), /authority effective/u);
  const changedPair = assessmentPair();
  changedPair.digest = DIGEST;
  assert.match(validateScopeControlJournal(journal(authorityDigest, {
    entries: [classificationEntry(authorityDigest, { assessment: changedPair })],
  })).join('\n'), /canonical packet\/result pair/u);
});

test('unrelated follow-up requires affirmative canonical scope evidence and a stable reference', () => {
  const { scopeAuthorityDigest, scopeGateForJournal, validateScopeControlJournal } = contract;
  const authorityDigest = scopeAuthorityDigest(authority());
  const affirmative = classificationEntry(authorityDigest, {
    classification: 'unrelated-follow-up', unrelatedReference: 'furinvader/aerstello#25',
  });
  assert.deepEqual(validateScopeControlJournal(journal(authorityDigest, {
    entries: [affirmative],
  })), []);
  assert.equal(scopeGateForJournal(journal(authorityDigest, { entries: [affirmative] })), 'ready');

  const missingReference = { ...affirmative, unrelatedReference: null };
  assert.match(
    validateScopeControlJournal(journal(authorityDigest, { entries: [missingReference] })).join('\n'),
    /unrelatedReference is required/u,
  );
  const amendmentRequired = { ...affirmative, authorityAmendmentRequired: true };
  assert.match(
    validateScopeControlJournal(journal(authorityDigest, { entries: [amendmentRequired] })).join('\n'),
    /authorityAmendmentRequired must equal/u,
  );

  for (const verdict of [
    'trim-required', 'minor-amendment-required', 'human-decision-required', 'insufficient-evidence',
  ]) {
    const rejected = structuredClone(affirmative);
    rejected.assessment.result.verdict = verdict;
    rejected.assessment.digest = `sha256:${sha256CanonicalContractJson({
      packet: rejected.assessment.packet, result: rejected.assessment.result,
    })}`;
    assert.match(
      validateScopeControlJournal(journal(authorityDigest, { entries: [rejected] })).join('\n'),
      /classification does not match the canonical scope verdict/u,
      verdict,
    );
  }
});

test('classification assessments bind captured and journal authority in exact append order', () => {
  const { scopeAuthorityDigest, validateScopeControlJournal } = contract;
  const authorityValue = authority({ amendmentDigests: [DIGEST] });
  authorityValue.integratedHeadAssessment = bindAssessmentAuthority(
    authorityValue.integratedHeadAssessment,
    authorityValue,
  );
  const capturedAuthorityDigest = scopeAuthorityDigest(authorityValue);
  const first = classificationEntry(capturedAuthorityDigest);
  first.assessment = bindAssessmentAuthority(first.assessment, authorityValue);
  const decision = {
    schemaVersion: 1, sequence: 2, entryId: 'decision-authority', kind: 'decision', at: AT,
    reviewHeadSha: HEAD, authorityDigest: capturedAuthorityDigest, rootCauseId: 'scope-root',
    blockerId: 'blocker-authority', decisionId: 'decision-authority',
    decision: 'approve-expansion-and-replan', assessmentDigest: first.assessment.digest,
    blockerDigest: OTHER_DIGEST, approvedDeltaDigest: THIRD_DIGEST,
    rationale: 'Approve the bounded authority amendment.', priorDecisionIds: [],
  };
  const amendment = {
    schemaVersion: 1, sequence: 3, entryId: 'amendment-authority', kind: 'amendment', at: AT,
    reviewHeadSha: HEAD, authorityDigest: capturedAuthorityDigest, rootCauseId: 'scope-root',
    decisionId: 'decision-authority', amendmentDigest: THIRD_DIGEST,
    priorAuthorityDigest: capturedAuthorityDigest, revisedAuthorityDigest: OTHER_DIGEST,
  };
  const second = classificationEntry(OTHER_DIGEST, {
    sequence: 4, entryId: 'classification-authority-revised',
  });
  second.assessment = bindAssessmentAuthority(second.assessment, authorityValue, [DIGEST, THIRD_DIGEST]);
  const entries = [first, decision, amendment, second];
  const exactJournal = journal(OTHER_DIGEST, { entries });
  assert.deepEqual(validateScopeControlJournal(exactJournal, authorityValue), []);

  const nonApprovalAmendment = structuredClone(exactJournal);
  nonApprovalAmendment.entries[1].decision = 'remove-or-simplify';
  assert.match(
    validateScopeControlJournal(nonApprovalAmendment, authorityValue).join('\n'),
    /approved expansion decision/u,
  );

  for (const amendments of [
    [THIRD_DIGEST],
    [THIRD_DIGEST, DIGEST],
    [DIGEST],
    [DIGEST, OTHER_DIGEST, THIRD_DIGEST],
  ]) {
    const mismatched = structuredClone(exactJournal);
    mismatched.entries[3].assessment = bindAssessmentAuthority(
      mismatched.entries[3].assessment,
      authorityValue,
      amendments,
    );
    assert.match(
      validateScopeControlJournal(mismatched, authorityValue).join('\n'),
      /ordered effective authority amendments/u,
    );
  }

  const foreignSource = structuredClone(exactJournal);
  foreignSource.entries[3].assessment.packet.binding.source.digest = OTHER_DIGEST;
  foreignSource.entries[3].assessment.result.binding = structuredClone(
    foreignSource.entries[3].assessment.packet.binding,
  );
  foreignSource.entries[3].assessment.digest = `sha256:${sha256CanonicalContractJson({
    packet: foreignSource.entries[3].assessment.packet,
    result: foreignSource.entries[3].assessment.result,
  })}`;
  assert.match(validateScopeControlJournal(foreignSource, authorityValue).join('\n'), /captured authority source/u);
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
      decisionId: 'decision-one', decision: 'approve-expansion-and-replan', assessmentDigest: entries[0].assessment.digest,
      blockerDigest: OTHER_DIGEST, approvedDeltaDigest: DIGEST, rationale: 'Approve the bounded delta.',
      priorDecisionIds: [],
    },
    {
      ...common, sequence: 3, entryId: 'amendment-one', kind: 'amendment', decisionId: 'decision-one',
      amendmentDigest: DIGEST, priorAuthorityDigest: authorityDigest, revisedAuthorityDigest: OTHER_DIGEST,
    },
  );
  const revised = classificationEntry(OTHER_DIGEST, {
    sequence: 5, entryId: 'classification-revised',
  });
  revised.assessment.packet.binding.amendmentDigests = [DIGEST];
  revised.assessment.result.binding.amendmentDigests = [DIGEST];
  revised.assessment.digest = `sha256:${sha256CanonicalContractJson({
    packet: revised.assessment.packet, result: revised.assessment.result,
  })}`;
  entries.push(
    {
      ...common, authorityDigest: OTHER_DIGEST, sequence: 4, entryId: 'resume-one', kind: 'resume',
      decisionId: 'decision-one', scopeReturnDigest: DIGEST,
      resumedAuthorityDigest: OTHER_DIGEST, resumedHeadSha: HEAD,
    },
    revised,
  );
  entries.push({
    ...common, authorityDigest: OTHER_DIGEST, sequence: 6, entryId: 'manifest-one', kind: 'exact-head-manifest',
    manifestDigest: scopeExactHeadManifestDigest(entries, HEAD),
    assessmentDigest: revised.assessment.digest, triggerKinds: ['classification'],
  });
  assert.deepEqual(validateScopeControlJournal(journal(OTHER_DIGEST, { entries })), []);
  const invalid = structuredClone(entries);
  invalid[1].approvedDeltaDigest = null;
  invalid[3].resumedHeadSha = OTHER_HEAD;
  const errors = validateScopeControlJournal(journal(OTHER_DIGEST, { entries: invalid })).join('\n');
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
  const { scopeAuthorityDigest, scopeControlJournalDigest, scopeReturnResumeIdentity,
    validateScopeReturnEnvelope } = contract;
  const authorityDigest = scopeAuthorityDigest(authority());
  const journalDigest = scopeControlJournalDigest(journal(authorityDigest));
  const value = scopeReturn(authorityDigest, journalDigest);
  assert.deepEqual(validateScopeReturnEnvelope(value), []);
  assert.equal(scopeReturnResumeIdentity(value), scopeReturnResumeIdentity(structuredClone(value)));
  assert.notEqual(scopeReturnResumeIdentity(value), scopeReturnResumeIdentity({
    ...value, decisionId: 'scope-decision-next',
  }));
  assert.throws(() => scopeReturnResumeIdentity({ ...value, livePrHeadSha: OTHER_HEAD }), /Invalid scope return/u);
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
