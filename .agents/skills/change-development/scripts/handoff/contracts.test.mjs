import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeContractDigest } from '../scope/contracts.mjs';
import { buildDevelopmentScopeHandoff } from './contracts.mjs';

const HEAD = '1'.repeat(40);
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;

function receipt(value) {
  return { value, digest: scopeContractDigest(value) };
}

function fixture() {
  const effectivePlan = receipt({
    schemaVersion: 1, changeId: 'issue-55', planRevision: 1,
    source: { kind: 'github-issue', reference: 'furinvader/aerstello#55', captureDigest: SOURCE_DIGEST },
    planning: { planningSha: HEAD },
  });
  const minimalClosure = receipt({
    schemaVersion: 1, changeId: 'issue-55', revision: 1,
    source: { type: 'github-issue', identity: 'furinvader/aerstello#55', digest: SOURCE_DIGEST },
    planningSha: HEAD, planDigest: effectivePlan.digest, previousContractDigest: null,
    outcome: 'Carry only exact current scope proof into later PR preparation.',
    requiredCriteria: [{ id: 'handoff', text: 'Carry bounded current scope proof.' }],
    invariants: [], nonGoals: [], mandatoryConstraints: [], optionalGuidance: [],
    authorizedShape: ['handoff-scope-proof'], unauthorizedExpansion: ['delivery-orchestration'],
    deferredFollowups: [{ id: 'delivery', text: 'Delivery remains owned by issue 26.' }],
    operatorDecisionDigests: [],
  });
  const binding = {
    phase: 'integrated-head', source: minimalClosure.value.source,
    subject: { digest: scopeContractDigest({ headSha: HEAD }), sha: HEAD },
    planDigest: effectivePlan.digest, amendmentDigests: [],
    taskPacketDigest: scopeContractDigest({ tasks: ['operator-contract'] }),
  };
  const mappings = [
    ['handoff-scope-proof', 'The projection directly carries the required proof.'],
    ['build-development-scope-handoff', 'The public surface is the bounded projection.'],
    ['change-development', 'The owning subsystem contains the projection.'],
  ].map(([mechanism, rationale]) => ({
    mechanism, sourceCriterionIds: ['handoff'], acceptedCriterionIds: ['handoff'],
    invariantIds: [], nonGoalIds: [], guidanceIds: [], rationale,
  }));
  const packet = {
    schemaVersion: 1, binding,
    sourceScope: {
      objective: 'Keep development within accepted scope.',
      requiredCriteria: [{ id: 'handoff', text: 'Carry bounded current scope proof.' }],
      nonGoals: [], implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'handoff', text: 'Carry bounded current scope proof.' }],
      invariants: [], minimalClosure: 'One exact receipt projection is sufficient.',
      authorizedShape: [
        'handoff-scope-proof', 'build-development-scope-handoff', 'change-development',
      ],
      unauthorizedShape: [], deferredShape: [],
    },
    changeInventory: {
      summary: 'Project exact current scope receipts.',
      paths: ['.agents/skills/change-development/scripts/handoff/contracts.mjs'],
      dependencies: [], publicSurfaces: ['build-development-scope-handoff'],
      persistentSurfaces: [], subsystems: ['change-development'], mappings,
    },
    tripwires: [],
  };
  const result = {
    schemaVersion: 1, binding, verdict: 'within-scope',
    summary: 'The exact integrated head is within scope.',
    coverage: mappings.map((mapping) => ({
      ...mapping, classification: 'required', rationale: 'Required by accepted scope.',
    })),
    unnecessaryWork: [], smallerSufficientAlternative: null, scopeDelta: null,
    materialityTriggers: [], smallestExpansion: null, narrowAlternative: null,
    deferralConsequences: null, missingEvidence: [], humanDecision: false,
  };
  return {
    changeId: 'issue-55', headSha: HEAD, capturedAt: '2026-08-28T12:00:00.000Z',
    minimalClosure, effectivePlan, amendments: [], decisions: [],
    integratedScopeEvidence: receipt({
      schemaVersion: 1, changeId: 'issue-55', evidenceId: 'integrated-head-1', revision: 8,
      cadence: { boundary: 'integrated-head', trigger: null },
      packet, packetDigest: scopeContractDigest(packet),
      result, resultDigest: scopeContractDigest(result), closureDigest: minimalClosure.digest,
    }),
  };
}

test('builds a bounded detached imported authority snapshot', () => {
  const input = fixture();
  const before = structuredClone(input);
  const handoff = buildDevelopmentScopeHandoff(input);
  assert.equal(handoff.authorityKind, 'imported');
  assert.equal(handoff.planDigest, input.effectivePlan.digest);
  assert.equal(handoff.handoffHeadSha, HEAD);
  assert.deepEqual(handoff.deferredFollowUps, [
    { id: 'delivery', reference: 'Delivery remains owned by issue 26.' },
  ]);
  assert.equal(Object.hasOwn(handoff, 'effectivePlan'), false);
  handoff.source.identity = 'changed';
  handoff.integratedHeadAssessment.packet.sourceScope.objective = 'changed';
  assert.deepEqual(input, before);
});

test('fails closed for stale receipt and authority identities', () => {
  const mutations = [
    (input) => { input.headSha = '2'.repeat(40); },
    (input) => { input.effectivePlan.digest = `sha256:${'b'.repeat(64)}`; },
    (input) => { input.minimalClosure.value.outcome = 'tampered'; },
    (input) => { input.integratedScopeEvidence.value.result.verdict = 'trim-required'; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildDevelopmentScopeHandoff(input), TypeError);
  }
});

test('rejects unknown input fields and bounded-list overflow', () => {
  assert.throws(() => buildDevelopmentScopeHandoff({ ...fixture(), rawPlan: {} }), /exactly/u);
  const input = fixture();
  input.decisions = Array.from({ length: 129 }, () => input.minimalClosure);
  assert.throws(() => buildDevelopmentScopeHandoff(input), /at most 128/u);
});
