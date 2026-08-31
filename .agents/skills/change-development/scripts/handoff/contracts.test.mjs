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
  const terminalTaskSet = receipt([{
    taskId: 'operator-contract', binding: 1,
    packetDigest: `sha256:${'1'.repeat(64)}`,
    resultDigest: `sha256:${'2'.repeat(64)}`,
    provenanceDigest: `sha256:${'3'.repeat(64)}`,
    terminalStatus: 'integrated', integratedCommit: HEAD,
    integrationReceiptDigest: `sha256:${'4'.repeat(64)}`,
  }]);
  const acceptedPlan = receipt({
    schemaVersion: 1, changeId: 'issue-55', planRevision: 1,
    source: { kind: 'github-issue', reference: 'furinvader/aerstello#55', captureDigest: SOURCE_DIGEST },
    planning: { planningSha: HEAD },
  });
  const effectivePlan = structuredClone(acceptedPlan);
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
    subject: { digest: scopeContractDigest({ headSha: HEAD, taskSetDigest: terminalTaskSet.digest }), sha: HEAD },
    planDigest: effectivePlan.digest, amendmentDigests: [],
    taskPacketDigest: terminalTaskSet.digest,
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
    minimalClosure, acceptedPlan, effectivePlan, amendments: [], decisions: [],
    terminalTaskSet,
    integratedScopeEvidence: receipt({
      schemaVersion: 1, changeId: 'issue-55', evidenceId: 'integrated-head-1', revision: 8,
      cadence: { boundary: 'integrated-head', trigger: null },
      packet, packetDigest: scopeContractDigest(packet),
      result, resultDigest: scopeContractDigest(result), closureDigest: minimalClosure.digest,
    }),
  };
}

function refreshAuthorityReceipts(input) {
  input.minimalClosure.value.planDigest = input.effectivePlan.digest;
  input.minimalClosure.digest = scopeContractDigest(input.minimalClosure.value);
  const amendmentDigests = input.amendments.map(({ digest }) => digest);
  const decisionDigests = input.decisions.map(({ digest }) => digest);
  for (const binding of [
    input.integratedScopeEvidence.value.packet.binding,
    input.integratedScopeEvidence.value.result.binding,
  ]) {
    binding.planDigest = input.effectivePlan.digest;
    binding.amendmentDigests = [...amendmentDigests];
    if (decisionDigests.length > 0) binding.decisionDigests = [...decisionDigests];
    else delete binding.decisionDigests;
  }
  input.integratedScopeEvidence.value.packetDigest = scopeContractDigest(
    input.integratedScopeEvidence.value.packet,
  );
  input.integratedScopeEvidence.value.resultDigest = scopeContractDigest(
    input.integratedScopeEvidence.value.result,
  );
  input.integratedScopeEvidence.value.closureDigest = input.minimalClosure.digest;
  input.integratedScopeEvidence.digest = scopeContractDigest(input.integratedScopeEvidence.value);
  return input;
}

function withPlanChain(input, resultingPlans) {
  let previousDigest = input.acceptedPlan.digest;
  input.amendments = resultingPlans.map((resultingPlan, index) => {
    const newDigest = scopeContractDigest(resultingPlan);
    const record = receipt({
      schemaVersion: 1,
      amendmentId: `handoff-amendment-${index + 1}`,
      previousDigest,
      newDigest,
      resultingPlan,
    });
    previousDigest = newDigest;
    return record;
  });
  input.effectivePlan = receipt(resultingPlans.at(-1) ?? input.acceptedPlan.value);
  return refreshAuthorityReceipts(input);
}

function withDecision(input) {
  const decision = receipt({
    schemaVersion: 1,
    changeId: input.changeId,
    decisionId: 'approve-bounded-shape',
    revision: 1,
    disposition: 'approve-material-amendment',
    evidence: {
      sourceDigest: SOURCE_DIGEST,
      planningSha: HEAD,
      planDigest: input.effectivePlan.digest,
      amendmentDigests: [],
      closureDigest: input.minimalClosure.digest,
      subjectDigest: input.integratedScopeEvidence.value.packet.binding.subject.digest,
      subjectSha: HEAD,
      assessmentPacketDigest: input.integratedScopeEvidence.value.packetDigest,
      assessmentResultDigest: input.integratedScopeEvidence.value.resultDigest,
    },
    rationale: 'Authorize exactly one bounded shape.',
    approvedShape: ['bounded-shape'],
    deferredFollowups: [],
  });
  input.decisions = [decision];
  input.minimalClosure.value.operatorDecisionDigests = [decision.digest];
  input.integratedScopeEvidence.value.packet.acceptedScope.authorityDecisions = [{
    id: decision.value.decisionId,
    digest: decision.digest,
    disposition: decision.value.disposition,
    authorizedShape: [...decision.value.approvedShape],
  }];
  return refreshAuthorityReceipts(input);
}

function withDeferredFollowUps(input, deferredFollowups) {
  input.minimalClosure.value.deferredFollowups = deferredFollowups;
  input.minimalClosure.digest = scopeContractDigest(input.minimalClosure.value);
  input.integratedScopeEvidence.value.closureDigest = input.minimalClosure.digest;
  input.integratedScopeEvidence.digest = scopeContractDigest(input.integratedScopeEvidence.value);
  return input;
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
    (input) => { input.terminalTaskSet.value[0].resultDigest = `sha256:${'5'.repeat(64)}`; },
    (input) => { input.integratedScopeEvidence.value.packet.binding.subject.digest = `sha256:${'6'.repeat(64)}`; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildDevelopmentScopeHandoff(input), TypeError);
  }
});

test('anchors the complete contiguous amendment chain to the accepted plan', () => {
  const input = fixture();
  const revisionTwo = { ...input.acceptedPlan.value, planRevision: 2, objective: 'Revision two.' };
  const revisionThree = { ...revisionTwo, planRevision: 3, objective: 'Revision three.' };
  withPlanChain(input, [revisionTwo, revisionThree]);
  assert.equal(buildDevelopmentScopeHandoff(input).planDigest, input.effectivePlan.digest);

  for (const [label, mutate] of [
    ['forged first predecessor', (candidate) => { candidate.amendments[0].value.previousDigest = SOURCE_DIGEST; }],
    ['skipped revision', (candidate) => { candidate.amendments[0].value.resultingPlan.planRevision = 3; }],
    ['reordered suffix', (candidate) => { candidate.amendments.reverse(); }],
    ['omitted prefix', (candidate) => { candidate.amendments.shift(); }],
    ['duplicate suffix', (candidate) => { candidate.amendments.push(candidate.amendments[1]); }],
    ['foreign accepted identity', (candidate) => { candidate.acceptedPlan.value.changeId = 'other-change'; }],
  ]) {
    const candidate = structuredClone(input);
    mutate(candidate);
    assert.throws(() => buildDevelopmentScopeHandoff(candidate), TypeError, label);
  }
});

test('requires exact accepted and effective identity when there are no amendments', () => {
  assert.doesNotThrow(() => buildDevelopmentScopeHandoff(fixture()));
  for (const mutate of [
    (input) => { input.effectivePlan.value.planRevision = 2; input.effectivePlan.digest = scopeContractDigest(input.effectivePlan.value); },
    (input) => { input.effectivePlan.value.objective = 'Unrecorded effective drift.'; input.effectivePlan.digest = scopeContractDigest(input.effectivePlan.value); },
  ]) {
    const input = fixture();
    mutate(input);
    refreshAuthorityReceipts(input);
    assert.throws(() => buildDevelopmentScopeHandoff(input), TypeError);
  }
});

test('projects complete approved-decision semantics through a detached clone', () => {
  const input = withDecision(fixture());
  const before = structuredClone(input);
  const handoff = buildDevelopmentScopeHandoff(input);
  assert.deepEqual(handoff.approvedDecisions, [{
    id: 'approve-bounded-shape',
    digest: input.decisions[0].digest,
    disposition: 'approve-material-amendment',
    authorizedShape: ['bounded-shape'],
  }]);
  handoff.approvedDecisions[0].authorizedShape.push('mutated-output');
  assert.deepEqual(input, before);
});

test('rejects unknown input fields and bounded-list overflow', () => {
  assert.throws(() => buildDevelopmentScopeHandoff({ ...fixture(), rawPlan: {} }), /exactly/u);
  const input = fixture();
  input.decisions = Array.from({ length: 129 }, () => input.minimalClosure);
  assert.throws(() => buildDevelopmentScopeHandoff(input), /at most 128/u);
});

test('projects the complete canonical deferred follow-up domain', () => {
  const astralReference = '💠'.repeat(4000);
  const deferredFollowups = Array.from({ length: 256 }, (_, index) => ({
    id: `follow-up-${index + 1}`,
    text: index === 255 ? astralReference : `Deferred follow-up ${index + 1}.`,
  }));
  const handoff = buildDevelopmentScopeHandoff(withDeferredFollowUps(fixture(), deferredFollowups));
  assert.equal(handoff.deferredFollowUps.length, 256);
  assert.deepEqual(handoff.deferredFollowUps.map(({ id }) => id), deferredFollowups.map(({ id }) => id));
  assert.equal(Array.from(handoff.deferredFollowUps[255].reference).length, 4000);
  assert.equal(handoff.deferredFollowUps[255].reference.length, 8000);

  assert.throws(
    () => buildDevelopmentScopeHandoff(withDeferredFollowUps(fixture(), [
      ...deferredFollowups,
      { id: 'follow-up-257', text: 'One entry beyond the canonical closure domain.' },
    ])),
    TypeError,
  );
  assert.throws(
    () => buildDevelopmentScopeHandoff(withDeferredFollowUps(fixture(), [
      { id: 'follow-up-reference-overflow', text: '💠'.repeat(4001) },
    ])),
    TypeError,
  );
});

test('derives terminal task and subject authority instead of trusting caller identities', () => {
  const omitted = fixture();
  delete omitted.terminalTaskSet;
  assert.throws(() => buildDevelopmentScopeHandoff(omitted), /exactly/u);

  const reordered = fixture();
  const second = { ...reordered.terminalTaskSet.value[0], taskId: 'second-contract' };
  reordered.terminalTaskSet.value.push(second);
  reordered.terminalTaskSet.digest = scopeContractDigest(reordered.terminalTaskSet.value);
  assert.throws(() => buildDevelopmentScopeHandoff(reordered), /terminal task set/u);

  const forged = fixture();
  forged.terminalTaskSet.digest = forged.integratedScopeEvidence.value.packet.binding.taskPacketDigest;
  forged.terminalTaskSet.value[0].packetDigest = `sha256:${'7'.repeat(64)}`;
  assert.throws(() => buildDevelopmentScopeHandoff(forged), /digest/u);
});
