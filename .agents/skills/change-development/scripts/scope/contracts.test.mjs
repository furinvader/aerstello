import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  scopeContractDigest,
  scopeEvidenceIsCurrent,
  taskSetDigest,
  taskSetIdentity,
  validateMinimalClosureContract,
  validateScopeDecision,
  validateScopeEvidence,
} from './contracts.mjs';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;
const SHA = '1'.repeat(40);

function closure(overrides = {}) {
  return {
    schemaVersion: 1,
    changeId: 'issue-55-minimal-scope',
    revision: 1,
    source: { type: 'github-issue', identity: 'furinvader/aerstello#55', digest: A },
    planningSha: SHA,
    planDigest: B,
    previousContractDigest: null,
    outcome: 'Gate development on the smallest sufficient implementation.',
    requiredCriteria: [{ id: 'minimal', text: 'Record minimal closure.' }],
    invariants: [{ id: 'immutable', text: 'Preserve accepted history.' }],
    nonGoals: [{ id: 'no-engine', text: 'Do not build a planning engine.' }],
    mandatoryConstraints: [{ id: 'exact', text: 'Bind evidence to exact identities.' }],
    optionalGuidance: [{ id: 'layout', text: 'Keep helpers co-located.' }],
    authorizedShape: ['scope-sidecars'],
    unauthorizedExpansion: ['generic-planning-engine'],
    deferredFollowups: [{ id: 'handoff', text: 'Issue 25 owns full handoff.' }],
    operatorDecisionDigests: [],
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    changeId: 'issue-55-minimal-scope',
    decisionId: 'approve-scope-api',
    revision: 4,
    disposition: 'approve-material-amendment',
    evidence: {
      sourceDigest: A,
      planningSha: SHA,
      planDigest: B,
      amendmentDigests: [C],
      closureDigest: D,
      subjectDigest: C,
      subjectSha: SHA,
      assessmentPacketDigest: A,
      assessmentResultDigest: B,
    },
    rationale: 'The named contract is required and its narrower alternative is insufficient.',
    approvedShape: ['scope-evidence-contract'],
    deferredFollowups: [],
    ...overrides,
  };
}

function assessmentPacket() {
  return {
    schemaVersion: 1,
    binding: {
      phase: 'integrated-head',
      source: { type: 'github-issue', identity: 'furinvader/aerstello#55', digest: A },
      subject: { digest: B, sha: SHA },
      planDigest: C,
      amendmentDigests: [],
      taskPacketDigest: D,
    },
    sourceScope: {
      objective: 'Provide bounded development scope gates.',
      requiredCriteria: [{ id: 'scope-gate', text: 'Gate the exact integrated head.' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'scope-gate', text: 'Gate the exact integrated head.' }],
      invariants: [],
      minimalClosure: 'One exact-head assessment is sufficient.',
      authorizedShape: ['integrated-scope-gate'],
      unauthorizedShape: [],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'Assess one exact integrated head.',
      paths: ['.agents/skills/change-development/scripts/state/state.mjs'],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: ['integrated-scope-gate'],
      mappings: [{
        mechanism: 'integrated-scope-gate',
        sourceCriterionIds: ['scope-gate'],
        acceptedCriterionIds: ['scope-gate'],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        rationale: 'The gate directly implements the required criterion.',
      }],
    },
    tripwires: [],
  };
}

function assessmentResult(packet) {
  return {
    schemaVersion: 1,
    binding: packet.binding,
    verdict: 'within-scope',
    summary: 'The exact integrated head remains within scope.',
    coverage: [{
      ...packet.changeInventory.mappings[0],
      classification: 'required',
      rationale: 'The gate is required by the source and accepted scope.',
    }],
    unnecessaryWork: [],
    smallerSufficientAlternative: null,
    scopeDelta: null,
    materialityTriggers: [],
    smallestExpansion: null,
    narrowAlternative: null,
    deferralConsequences: null,
    missingEvidence: [],
    humanDecision: false,
  };
}

test('minimal closure keeps semantic authority distinct and append-only', () => {
  assert.deepEqual(validateMinimalClosureContract(closure()), []);
  assert.match(scopeContractDigest(closure()), /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    validateMinimalClosureContract(closure({ revision: 2 })),
    ['$ revised minimal closure contract requires previousContractDigest'],
  );
  assert.deepEqual(
    validateMinimalClosureContract(closure({ requiredCriteria: [
      { id: 'minimal', text: 'First.' },
      { id: 'minimal', text: 'Second.' },
    ] })),
    ['$ requiredCriteria contains duplicate id minimal'],
  );
});

test('scope decisions bind all exact evidence and only approval authorizes shape', () => {
  assert.deepEqual(validateScopeDecision(decision()), []);
  assert.ok(validateScopeDecision(decision({
    disposition: 'reject-use-narrow',
  })).some((error) => error.includes('approvedShape')));
  assert.deepEqual(validateScopeDecision(decision({
    disposition: 'split-defer',
    approvedShape: [],
    deferredFollowups: ['separate-issue'],
  })), []);
});

test('scope evidence binds canonical packet, result, cadence, and exact applicability', () => {
  const packet = assessmentPacket();
  const result = assessmentResult(packet);
  const evidence = {
    schemaVersion: 1,
    changeId: 'issue-55-minimal-scope',
    evidenceId: 'integrated-head-1',
    revision: 8,
    cadence: { boundary: 'integrated-head', trigger: null },
    packet,
    packetDigest: scopeContractDigest(packet),
    result,
    resultDigest: scopeContractDigest(result),
    closureDigest: A,
  };
  assert.deepEqual(validateScopeEvidence(evidence), []);
  assert.equal(scopeEvidenceIsCurrent(evidence, {
    sourceDigest: A,
    planDigest: C,
    amendmentDigests: [],
    decisionDigests: [],
    taskPacketDigest: D,
    subjectDigest: B,
    subjectSha: SHA,
    closureDigest: A,
  }), true);
  assert.equal(scopeEvidenceIsCurrent(evidence, {
    sourceDigest: A,
    planDigest: C,
    amendmentDigests: [],
    decisionDigests: [],
    taskPacketDigest: D,
    subjectDigest: B,
    subjectSha: '2'.repeat(40),
    closureDigest: A,
  }), false);
  assert.ok(validateScopeEvidence({ ...evidence, packetDigest: B })
    .includes('$ packetDigest must equal the canonical assessment packet digest'));
});

test('scope freshness binds ordered decision receipts while legacy zero-decision evidence remains readable', () => {
  const packet = assessmentPacket();
  const result = assessmentResult(packet);
  const evidence = {
    schemaVersion: 1, changeId: 'issue-55-minimal-scope', evidenceId: 'decision-bound', revision: 2,
    cadence: { boundary: 'integrated-head', trigger: null }, packet,
    packetDigest: scopeContractDigest(packet), result, resultDigest: scopeContractDigest(result), closureDigest: A,
  };
  const expected = {
    sourceDigest: A, planDigest: C, amendmentDigests: [], decisionDigests: [], taskPacketDigest: D,
    subjectDigest: B, subjectSha: SHA, closureDigest: A,
  };
  assert.equal(scopeEvidenceIsCurrent(evidence, expected), true);

  packet.binding.decisionDigests = [A, B];
  packet.acceptedScope.authorityDecisions = [
    { id: 'first-decision', digest: A, disposition: 'split-defer', authorizedShape: [] },
    { id: 'second-decision', digest: B, disposition: 'reject-use-narrow', authorizedShape: [] },
  ];
  result.binding = packet.binding;
  evidence.packetDigest = scopeContractDigest(packet);
  evidence.resultDigest = scopeContractDigest(result);
  assert.equal(scopeEvidenceIsCurrent(evidence, { ...expected, decisionDigests: [A, B] }), true);
  assert.equal(scopeEvidenceIsCurrent(evidence, { ...expected, decisionDigests: [B, A] }), false);
  assert.equal(scopeEvidenceIsCurrent(evidence, { ...expected, decisionDigests: [A] }), false);
});

test('integrated task packet identity is the canonical task-set projection', () => {
  const task = {
    taskId: 'scope-contracts',
    binding: 1,
    packetDigest: A,
    resultDigest: B,
    provenanceDigest: C,
    terminalStatus: 'integrated',
    integratedCommit: SHA,
    integrationReceiptDigest: D,
    ignoredDisplayField: 'not identity',
  };
  assert.deepEqual(Object.keys(taskSetIdentity([task])), [
    '0',
  ]);
  assert.equal(taskSetDigest([task]), taskSetDigest([{ ...task, ignoredDisplayField: 'changed' }]));
  assert.notEqual(taskSetDigest([task]), taskSetDigest([{ ...task, resultDigest: C }]));
  assert.throws(() => taskSetDigest([task, task]), /duplicate task IDs/u);
});

test('legacy assessment packets remain valid without decision authority fields', () => {
  const packet = assessmentPacket();
  const result = assessmentResult(packet);
  assert.equal(Object.hasOwn(packet.binding, 'decisionDigests'), false);
  assert.equal(Object.hasOwn(packet.acceptedScope, 'authorityDecisions'), false);
  assert.deepEqual(validateScopeEvidence({
    schemaVersion: 1,
    changeId: 'issue-55-minimal-scope',
    evidenceId: 'legacy-compatible',
    revision: 1,
    cadence: { boundary: 'integrated-head', trigger: null },
    packet,
    packetDigest: scopeContractDigest(packet),
    result,
    resultDigest: scopeContractDigest(result),
    closureDigest: A,
  }), []);
});
