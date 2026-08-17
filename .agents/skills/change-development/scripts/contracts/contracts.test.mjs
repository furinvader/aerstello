import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import {
  canonicalJsonText, contractPaths, digestJson, planReadiness,
  sourceChecklistBinding, validateDevelopmentState, validateImplementationPlan,
} from './contracts.mjs';
import { parseChecklist } from '../source/checklists.mjs';
import {
  materialDigest as observationMaterialDigest,
  progressDigest as observationProgressDigest,
  sourceObservationDigest,
} from '../source/source.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-08-17T10:00:00.000Z';
const registry = loadRegistry();

function metadata(overrides = {}) {
  const input = {
    specialization: 'ops-workflow', affectedAreas: ['workflow'], riskTags: ['workflow'],
    browserVisible: false, relatedTestSelectionUncertain: false, ...overrides,
  };
  return {
    ...input,
    route: routeSpecialists({
      specialization: input.specialization,
      riskTags: input.riskTags,
      browserVisible: input.browserVisible,
      testSelectionUncertain: input.relatedTestSelectionUncertain,
    }, registry),
  };
}

function plan() {
  return {
    schemaVersion: 1, planRevision: 1, changeId: 'issue-22',
    source: { kind: 'github-issue', reference: 'furinvader/aerstello#22', relationship: 'resolves', captureDigest: DIGEST },
    title: 'Durable planning', objective: 'Create durable planning contracts.',
    scope: ['Repository workflow contracts'], nonGoals: ['Application behavior'],
    planning: { planningSha: SHA, baseBranch: 'main', comparisonBaseSha: null }, expectedPrBaseBranch: 'main',
    criteria: [{ id: 'durable-state', description: 'State is durable.', disposition: 'owned', ownerTaskId: 'contracts', deferredReason: null }],
    decisions: [{ id: 'state-root', question: 'Where is state stored?', rationale: 'Linked worktrees share it.', status: 'resolved', resolution: 'Use the Git common directory.' }],
    scenarios: [],
    productScenarioDisposition: { disposition: 'not-applicable', scenarioIds: [], rationale: 'Repository-only tooling has no product scenario.' },
    specialization: metadata(),
    checklistMappings: [{ id: 'durable-state', identity: { kind: 'stable-marker', stableId: 'durable-state' }, capturedText: 'State is durable', criterionIds: ['durable-state'], taskIds: ['contracts'], relationship: 'resolves', checked: false, status: 'current', ambiguity: null, externalChange: false }],
    tasks: [{ id: 'contracts', title: 'Add contracts', objective: 'Define strict contracts.', rationale: 'Later execution requires stable inputs.', specialization: metadata(), criterionIds: ['durable-state'], decisionIds: ['state-root'], scenarioIds: [], checklistItemIds: ['durable-state'], dependsOn: [], anticipatedPaths: ['.agents/skills/change-development/schemas'], produces: ['plan-contract'], consumes: [], validationIntent: ['Validate schema and manual invariants'], unsplittable: null }],
  };
}

function state() {
  return {
    schemaVersion: 1, changeId: 'issue-22', mode: 'plan-only', phase: 'ready-to-implement', revision: 3,
    baseBranch: 'main', expectedPrBaseBranch: 'main', planningRef: 'refs/heads/main', planningSha: SHA,
    source: { kind: 'github-issue', reference: 'furinvader/aerstello#22', relationship: 'resolves', initialDigest: DIGEST, latestDigest: DIGEST, fullDigest: DIGEST, materialDigest: DIGEST, progressDigest: DIGEST, classification: 'unchanged', observationDigest: DIGEST, latestCommentIdentity: null, refreshedAt: NOW },
    plan: { revision: 1, originalDigest: DIGEST, effectiveDigest: DIGEST, sourceCaptureDigest: DIGEST, amendmentCount: 0, acceptedAt: NOW },
    git: { headSha: SHA, branch: 'main', clean: true, observedAt: NOW }, unresolvedDecisionIds: [],
    checklist: [{ id: 'durable-state', checked: false, status: 'current', externalChange: false }], blockedReasons: [], abandonmentReason: null,
    nextAction: 'Archive this completed plan-only change.', createdAt: NOW, updatedAt: NOW,
  };
}

function observation(markdown = '- [ ] <!-- aerstello:item=durable-state --> State is durable') {
  const value = {
    schemaVersion: 1, sourceType: 'github-issue', planningSha: SHA,
    descriptor: { type: 'github-issue', repository: 'furinvader/aerstello', issueNumber: 22, relationshipIntent: 'resolves' },
    capturedAt: NOW,
    source: { checklist: parseChecklist(markdown) },
  };
  value.materialDigest = observationMaterialDigest(value);
  value.progressDigest = observationProgressDigest(value);
  value.digest = sourceObservationDigest(value);
  return value;
}

function partialObservation(comparisonBaseSha = 'c'.repeat(40)) {
  const value = {
    schemaVersion: 1, sourceType: 'partial-implementation', planningSha: SHA,
    descriptor: { type: 'partial-implementation', comparisonBase: 'main', relationshipIntent: 'partial' },
    capturedAt: NOW, source: { comparisonBaseSha },
  };
  value.materialDigest = observationMaterialDigest(value);
  value.progressDigest = observationProgressDigest(value);
  value.digest = sourceObservationDigest(value);
  return value;
}

function bindObservation(value, sourceObservation) {
  value.source.captureDigest = sourceObservation.digest;
  value.checklistMappings = (sourceObservation.source.checklist ?? []).map((item) => ({
    ...sourceChecklistBinding(item), criterionIds: ['durable-state'], taskIds: ['contracts'], relationship: value.source.relationship,
  }));
  value.tasks[0].checklistItemIds = value.checklistMappings.map(({ id }) => id);
  return value;
}

test('schemas compile independently in strict Draft 2020-12 mode', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  for (const path of Object.values(contractPaths)) assert.doesNotThrow(() => ajv.compile(JSON.parse(readFileSync(path, 'utf8'))));
});

test('canonical JSON is stable and its receipt includes the canonical newline', () => {
  assert.equal(canonicalJsonText({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}\n');
  assert.equal(digestJson({ a: 1 }), digestJson({ a: 1 }));
  assert.throws(() => canonicalJsonText({ bad: undefined }), /cannot contain undefined/u);
});

test('valid plan is schema-valid, manually valid, and ready', () => {
  assert.deepEqual(validateImplementationPlan(plan()), []);
  assert.deepEqual(planReadiness(plan()), { ready: true, errors: [] });
});

test('schema and manual validation fail closed for malformed and contradictory plans', () => {
  const extra = plan(); extra.unknown = true;
  assert.match(validateImplementationPlan(extra).join('\n'), /additional properties/u);
  const duplicate = plan(); duplicate.criteria.push({ ...duplicate.criteria[0] });
  assert.match(validateImplementationPlan(duplicate).join('\n'), /duplicate criterion ID/u);
  const unknown = plan(); unknown.tasks[0].decisionIds = ['missing'];
  assert.match(validateImplementationPlan(unknown).join('\n'), /unknown decision/u);
  const deferred = plan(); Object.assign(deferred.criteria[0], { disposition: 'deferred', ownerTaskId: null, deferredReason: 'Later issue.' }); deferred.tasks[0].criterionIds = [];
  assert.equal(validateImplementationPlan(deferred).length, 0); assert.equal(planReadiness(deferred).ready, true);
});

test('shared semantic text rejects whitespace in schema and manual validation', () => {
  const schema = JSON.parse(readFileSync(contractPaths.implementationPlanSchema, 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(schema.$defs.text.pattern, '\\S');
  for (const [label, mutate] of [
    ['title', (value) => { value.title = ' \t '; }],
    ['criterion description', (value) => { value.criteria[0].description = '\n '; }],
    ['validation intent', (value) => { value.tasks[0].validationIntent = ['  ']; }],
  ]) {
    const value = plan(); mutate(value);
    assert.equal(validateSchema(value), false, `${label} must fail the strict schema`);
    assert.ok(validateImplementationPlan(value).length > 0, `${label} must fail contract validation`);
  }
});

test('DAG, producer ordering, ownership overlap, and cross-domain serialization are enforced', () => {
  const cyclic = plan();
  cyclic.tasks.push({ ...structuredClone(cyclic.tasks[0]), id: 'consumer', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['other/path'], produces: [], consumes: [{ artifactId: 'plan-contract', producerTaskId: 'contracts' }], dependsOn: ['contracts'] });
  cyclic.tasks[0].dependsOn = ['consumer'];
  assert.match(validateImplementationPlan(cyclic).join('\n'), /cycle/u);

  const unordered = plan(); unordered.tasks.push({ ...structuredClone(unordered.tasks[0]), id: 'consumer', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['other/path'], produces: [], consumes: [{ artifactId: 'plan-contract', producerTaskId: 'contracts' }], dependsOn: [] });
  assert.match(validateImplementationPlan(unordered).join('\n'), /without depending/u);
  const overlap = plan(); overlap.tasks.push({ ...structuredClone(overlap.tasks[0]), id: 'other', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['.agents/skills/change-development/schemas/file.json'], produces: [], dependsOn: [] });
  assert.match(validateImplementationPlan(overlap).join('\n'), /overlapping anticipated paths/u);
  const cross = plan(); cross.tasks[0].specialization = metadata({ affectedAreas: ['workflow', 'documentation'] });
  assert.match(validateImplementationPlan(cross).join('\n'), /unsplittable explanation/u);
});

test('routes are recomputed and current clean Planning-SHA evidence is required', () => {
  const mismatched = plan(); mismatched.specialization.route.finalVerificationPriority = 'high';
  assert.match(validateImplementationPlan(mismatched).join('\n'), /canonical specialist route/u);
  const routed = plan(); routed.specialization = metadata({ browserVisible: true }); routed.tasks[0].specialization = metadata({ browserVisible: true });
  assert.match(validateImplementationPlan(routed).join('\n'), /missing required specialist evidence/u);
  const evidence = [{ schemaVersion: 1, reviewerId: 'behavior_mapper', headSha: SHA, status: 'clean', summary: 'Scenario selection is resolved.', findings: [], recordedAt: NOW, planRevision: 1 }];
  assert.deepEqual(validateImplementationPlan(routed, { planningEvidence: evidence }), []);
  evidence[0].planRevision = 2; assert.match(validateImplementationPlan(routed, { planningEvidence: evidence }).join('\n'), /not for plan revision/u);
  const uncertain = plan(); uncertain.specialization = metadata({ relatedTestSelectionUncertain: true });
  assert.match(validateImplementationPlan(uncertain, { planningEvidence: [{ schemaVersion: 1, reviewerId: 'behavior_mapper', headSha: SHA, status: 'clean', summary: 'Still uncertain.', findings: [], recordedAt: NOW, planRevision: 1 }] }).join('\n'), /unresolved related-test selection/u);
});

test('validation intent cannot smuggle exact commands', () => {
  const value = plan(); value.tasks[0].validationIntent = ['npm run test:change-development'];
  assert.match(validateImplementationPlan(value).join('\n'), /not an executable command/u);
});

test('development state gates readiness, blocking, abandonment, and exact observations', () => {
  assert.deepEqual(validateDevelopmentState(state()), []);
  const dirty = state(); dirty.git.clean = false;
  assert.match(validateDevelopmentState(dirty).join('\n'), /clean Git observation/u);
  const drift = state(); drift.source.classification = 'unreviewed-material';
  assert.match(validateDevelopmentState(drift).join('\n'), /material source drift/u);
  const blocked = state(); blocked.phase = 'blocked'; blocked.blockedReasons = [];
  assert.match(validateDevelopmentState(blocked).join('\n'), /blocked requires/u);
  const abandoned = state(); abandoned.phase = 'abandoned';
  assert.match(validateDevelopmentState(abandoned).join('\n'), /abandonment reason/u);
});

test('all source kinds and workflow modes are represented by the contracts', () => {
  for (const kind of ['github-issue', 'direct-request', 'repository-plan', 'partial-implementation']) {
    const value = plan(); value.source.kind = kind;
    if (kind === 'partial-implementation') value.planning.comparisonBaseSha = 'c'.repeat(40);
    if (kind !== 'github-issue') { value.checklistMappings = []; value.tasks[0].checklistItemIds = []; }
    assert.deepEqual(validateImplementationPlan(value), [], kind);
  }
  for (const mode of ['plan-only', 'implement', 'full']) {
    const value = state(); value.mode = mode;
    assert.deepEqual(validateDevelopmentState(value), [], mode);
  }
});

test('every stable ID namespace rejects duplicates', () => {
  for (const [label, mutate] of [
    ['decision', (value) => value.decisions.push(structuredClone(value.decisions[0]))],
    ['scenario', (value) => { value.scenarios = [{ id: 'scenario-one', feature: 'specs/features/example.feature', scenario: 'Example' }, { id: 'scenario-one', feature: 'specs/features/example.feature', scenario: 'Other' }]; value.productScenarioDisposition = { disposition: 'mapped', scenarioIds: ['scenario-one'], rationale: 'Product behavior is mapped.' }; }],
    ['checklist', (value) => value.checklistMappings.push(structuredClone(value.checklistMappings[0]))],
    ['task', (value) => { const task = structuredClone(value.tasks[0]); task.anticipatedPaths = ['other']; value.tasks.push(task); }],
  ]) {
    const value = plan(); mutate(value);
    assert.match(validateImplementationPlan(value).join('\n'), new RegExp(`duplicate ${label}`, 'u'), label);
  }
});

test('dependency, producer, criterion-owner, and reference contradictions fail closed', () => {
  const cases = [
    ['unknown task', (value) => value.tasks[0].dependsOn = ['missing-task']],
    ['depends on itself', (value) => value.tasks[0].dependsOn = ['contracts']],
    ['unknown owner task', (value) => value.criteria[0].ownerTaskId = 'missing-task'],
    ['unknown scenario', (value) => value.tasks[0].scenarioIds = ['missing-scenario']],
  ];
  for (const [expected, mutate] of cases) { const value = plan(); mutate(value); assert.match(validateImplementationPlan(value).join('\n'), new RegExp(expected, 'u')); }
  const producer = plan(); producer.tasks.push({ ...structuredClone(producer.tasks[0]), id: 'consumer', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['other'], produces: [], dependsOn: ['contracts'], consumes: [{ artifactId: 'plan-contract', producerTaskId: 'wrong-task' }] });
  assert.match(validateImplementationPlan(producer).join('\n'), /binds plan-contract to producer wrong-task/u);
});

test('specialization, scenario disposition, and unsplittable ownership are verified', () => {
  const specialization = plan(); specialization.tasks[0].specialization.specialization = 'web';
  assert.match(validateImplementationPlan(specialization).join('\n'), /incompatible|canonical specialist route/u);
  const risk = plan(); risk.tasks[0].specialization.riskTags = ['billing'];
  assert.match(validateImplementationPlan(risk).join('\n'), /does not support|canonical specialist route/u);
  const disposition = plan(); disposition.scenarios = [{ id: 'scenario-one', feature: 'specs/features/example.feature', scenario: 'Example' }];
  assert.match(validateImplementationPlan(disposition).join('\n'), /productScenarioDisposition|scenarioIds|missing from product scenario disposition/u);
  const unsplittable = plan(); unsplittable.tasks[0].specialization = metadata({ affectedAreas: ['workflow', 'documentation'] }); unsplittable.tasks[0].unsplittable = { reason: 'Must serialize one atomic contract.', serializedDomains: ['workflow', 'documentation'], highestRiskSpecialization: 'contracts' };
  assert.match(validateImplementationPlan(unsplittable).join('\n'), /highestRiskSpecialization/u);
});

test('planning evidence rejects stale, finding-bearing, unknown, and duplicate records', () => {
  const value = plan(); value.specialization = metadata({ browserVisible: true }); value.tasks[0].specialization = metadata({ browserVisible: true });
  const clean = { schemaVersion: 1, planRevision: 1, reviewerId: 'behavior_mapper', headSha: SHA, status: 'clean', summary: 'Mapped.', findings: [], recordedAt: NOW };
  for (const [expected, evidence] of [
    ['stale', [{ ...clean, headSha: 'c'.repeat(40) }]],
    ['clean evidence cannot contain findings', [{ ...clean, findings: ['Unresolved'] }]],
    ['reviewerId must be behavior_mapper', [{ ...clean, reviewerId: 'security_reviewer' }]],
    ['duplicate planning evidence', [clean, { ...clean }]],
  ]) assert.match(validateImplementationPlan(value, { planningEvidence: evidence }).join('\n'), new RegExp(expected, 'u'));
});

test('ambiguous, removed, or externally changed checklist mappings prevent readiness', () => {
  for (const mutate of [
    (mapping) => Object.assign(mapping, { status: 'ambiguous', ambiguity: 'Duplicate legacy text.' }),
    (mapping) => Object.assign(mapping, { status: 'removed' }),
    (mapping) => Object.assign(mapping, { externalChange: true }),
  ]) {
    const value = plan(); mutate(value.checklistMappings[0]);
    assert.equal(planReadiness(value).ready, false);
  }
});

test('receipt-protected source context enforces exact one-to-one checklist bindings', () => {
  const sourceObservation = observation();
  const value = bindObservation(plan(), sourceObservation);
  assert.deepEqual(validateImplementationPlan(value, { sourceObservation }), []);
  assert.deepEqual(planReadiness(value, { sourceObservation }), { ready: true, errors: [] });

  const cases = [
    ['missing source checklist mapping', (candidate) => { candidate.checklistMappings = []; candidate.tasks[0].checklistItemIds = []; }],
    ['fabricated or no longer present', (candidate) => { const mapping = structuredClone(candidate.checklistMappings[0]); mapping.id = 'fabricated'; mapping.identity.stableId = 'fabricated'; candidate.checklistMappings.push(mapping); candidate.tasks[0].checklistItemIds.push('fabricated'); }],
    ['identity does not match', (candidate) => { candidate.checklistMappings[0].identity.stableId = 'fabricated'; }],
    ['capturedText does not match', (candidate) => { candidate.checklistMappings[0].capturedText = 'Changed'; }],
    ['checked does not match', (candidate) => { candidate.checklistMappings[0].checked = true; }],
    ['status does not match', (candidate) => { candidate.checklistMappings[0].status = 'removed'; }],
    ['externalChange does not match', (candidate) => { candidate.checklistMappings[0].externalChange = true; }],
  ];
  for (const [expected, mutate] of cases) {
    const candidate = bindObservation(plan(), sourceObservation); mutate(candidate);
    assert.match(validateImplementationPlan(candidate, { sourceObservation }).join('\n'), new RegExp(expected, 'u'), expected);
  }
});

test('source receipt tampering and duplicate source or plan identities fail closed', () => {
  const validObservation = observation();
  const tampered = structuredClone(validObservation); tampered.source.checklist[0].text = 'Tampered';
  assert.match(validateImplementationPlan(bindObservation(plan(), validObservation), { sourceObservation: tampered }).join('\n'), /digest receipt does not match/u);

  const duplicateObservation = observation('- [ ] <!-- aerstello:item=duplicate --> First\n- [ ] <!-- aerstello:item=duplicate --> Second');
  const duplicatePlan = bindObservation(plan(), duplicateObservation);
  assert.match(validateImplementationPlan(duplicatePlan, { sourceObservation: duplicateObservation }).join('\n'), /duplicate checklist mapping ID|duplicate checklist identity/u);

  const duplicateIdentity = bindObservation(plan(), observation('- [ ] <!-- aerstello:item=one --> One\n- [ ] <!-- aerstello:item=two --> Two'));
  duplicateIdentity.checklistMappings[1].identity = structuredClone(duplicateIdentity.checklistMappings[0].identity);
  assert.match(validateImplementationPlan(duplicateIdentity, { sourceObservation: observation('- [ ] <!-- aerstello:item=one --> One\n- [ ] <!-- aerstello:item=two --> Two') }).join('\n'), /duplicate checklist identity/u);
});

test('canonical legacy conversion binds exact text and structural position', () => {
  const sourceObservation = observation('- [x] Legacy task');
  const binding = sourceChecklistBinding(sourceObservation.source.checklist[0]);
  assert.deepEqual(binding.identity, { kind: 'legacy-position', text: 'Legacy task', position: 1, line: 1, section: null });
  assert.equal(binding.capturedText, binding.identity.text);
  assert.equal(binding.checked, true);
  const value = bindObservation(plan(), sourceObservation);
  assert.deepEqual(validateImplementationPlan(value, { sourceObservation }), []);
  value.checklistMappings[0].capturedText = 'Different text';
  assert.match(validateImplementationPlan(value, { sourceObservation }).join('\n'), /exactly match legacy identity text|capturedText does not match/u);

  const invalid = structuredClone(sourceObservation.source.checklist[0]); invalid.identity.position = 0;
  assert.throws(() => sourceChecklistBinding(invalid), /position must be at least 1/u);
});

test('partial implementation comparison base is explicit and observation-bound', () => {
  const sourceObservation = partialObservation();
  const value = plan();
  Object.assign(value.source, { kind: 'partial-implementation', relationship: 'partial', captureDigest: sourceObservation.digest });
  value.planning.comparisonBaseSha = sourceObservation.source.comparisonBaseSha;
  value.checklistMappings = []; value.tasks[0].checklistItemIds = [];
  assert.deepEqual(validateImplementationPlan(value, { sourceObservation }), []);

  const missing = structuredClone(value); missing.planning.comparisonBaseSha = null;
  assert.ok(validateImplementationPlan(missing, { sourceObservation }).length > 0);
  const mismatch = structuredClone(value); mismatch.planning.comparisonBaseSha = 'd'.repeat(40);
  assert.match(validateImplementationPlan(mismatch, { sourceObservation }).join('\n'), /comparisonBaseSha does not match/u);
  const nonPartial = plan(); nonPartial.planning.comparisonBaseSha = 'c'.repeat(40);
  assert.ok(validateImplementationPlan(nonPartial).length > 0);
});

test('split cross-profile plans derive helper evidence without forcing one union profile', () => {
  const value = plan();
  value.criteria.push({ id: 'api-contract', description: 'API work is planned.', disposition: 'owned', ownerTaskId: 'api-task', deferredReason: null });
  value.tasks.push({
    id: 'api-task', title: 'Add API work', objective: 'Implement an API contract.', rationale: 'The workflow requires product support.',
    specialization: metadata({ specialization: 'api', affectedAreas: ['api'], riskTags: ['authentication'], browserVisible: true }),
    criterionIds: ['api-contract'], decisionIds: [], scenarioIds: [], checklistItemIds: [], dependsOn: ['contracts'],
    anticipatedPaths: ['apps/api/src/example.ts'], produces: ['api-contract'],
    consumes: [{ artifactId: 'plan-contract', producerTaskId: 'contracts' }], validationIntent: ['Validate the API contract'], unsplittable: null,
  });
  const evidence = [{ schemaVersion: 1, reviewerId: 'behavior_mapper', headSha: SHA, status: 'clean', summary: 'Mapped.', findings: [], recordedAt: NOW, planRevision: 1 }];
  assert.deepEqual(validateImplementationPlan(value, { planningEvidence: evidence }), []);
  assert.match(validateImplementationPlan(value).join('\n'), /missing required specialist evidence: behavior_mapper/u);

  const unroutedEvidence = plan();
  assert.match(validateImplementationPlan(unroutedEvidence, { planningEvidence: evidence }).join('\n'), /evidence is not routed by the global or any planned task/u);
});

test('unsplittable serialization covers every affected area and validation intent is nonempty', () => {
  const value = plan();
  value.tasks[0].specialization = metadata({ affectedAreas: ['workflow', 'documentation'] });
  value.specialization = metadata({ affectedAreas: ['workflow', 'documentation'] });
  value.tasks[0].unsplittable = { reason: 'Serialize changes.', serializedDomains: ['workflow', 'release'], highestRiskSpecialization: 'ops-workflow' };
  assert.match(validateImplementationPlan(value).join('\n'), /serializedDomains must exactly cover affectedAreas/u);
  const emptyIntent = plan(); emptyIntent.tasks[0].validationIntent = [];
  assert.ok(validateImplementationPlan(emptyIntent).length > 0);
});

test('checklist task links, criterion ownership, and relationship are bidirectional', () => {
  const missingBackReference = plan(); missingBackReference.tasks[0].checklistItemIds = [];
  assert.match(validateImplementationPlan(missingBackReference).join('\n'), /taskIds must exactly match task checklistItemIds back-references/u);

  const fabricatedTaskLink = plan();
  fabricatedTaskLink.tasks.push({ ...structuredClone(fabricatedTaskLink.tasks[0]), id: 'second-task', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['other/path'], produces: [] });
  fabricatedTaskLink.checklistMappings[0].taskIds.push('second-task');
  assert.match(validateImplementationPlan(fabricatedTaskLink).join('\n'), /taskIds must exactly match task checklistItemIds back-references/u);

  const contradictoryOwner = plan();
  contradictoryOwner.tasks.push({ ...structuredClone(contradictoryOwner.tasks[0]), id: 'second-task', checklistItemIds: [], anticipatedPaths: ['other/path'], produces: [] });
  contradictoryOwner.tasks[0].criterionIds = [];
  contradictoryOwner.criteria[0].ownerTaskId = 'second-task';
  assert.match(validateImplementationPlan(contradictoryOwner).join('\n'), /owned by task second-task outside mapping.taskIds/u);

  const relationship = plan(); relationship.checklistMappings[0].relationship = 'partial';
  assert.match(validateImplementationPlan(relationship).join('\n'), /relationship must equal the plan source relationship/u);
});

test('repository paths reject trailing separators and control-character overlap bypasses', () => {
  for (const unsafePath of ['apps/api/', 'apps/api\nsmuggled', 'apps/api\rsmuggled', 'apps/api\0smuggled', 'apps/api\u007fsmuggled']) {
    const value = plan(); value.tasks[0].anticipatedPaths = [unsafePath];
    assert.ok(validateImplementationPlan(value).length > 0, JSON.stringify(unsafePath));
  }
  const overlap = plan();
  overlap.tasks.push({ ...structuredClone(overlap.tasks[0]), id: 'second-task', criterionIds: [], checklistItemIds: [], anticipatedPaths: ['apps/api/routes'], produces: [] });
  overlap.tasks[0].anticipatedPaths = ['apps/api'];
  assert.match(validateImplementationPlan(overlap).join('\n'), /overlapping anticipated paths/u);
});

test('schema-valid root-level anticipated paths remain valid planning data', () => {
  for (const path of ['package.json', 'scripts', 'README.md', 'AGENTS.md']) {
    const value = plan(); value.tasks[0].anticipatedPaths = [path];
    assert.deepEqual(validateImplementationPlan(value), [], path);
  }
});

test('planning evidence recordedAt uses strict Ajv RFC3339 semantics', () => {
  const value = plan(); value.specialization = metadata({ browserVisible: true }); value.tasks[0].specialization = metadata({ browserVisible: true });
  const evidence = { schemaVersion: 1, reviewerId: 'behavior_mapper', headSha: SHA, status: 'clean', summary: 'Mapped.', findings: [], recordedAt: NOW, planRevision: 1 };
  assert.deepEqual(validateImplementationPlan(value, { planningEvidence: [evidence] }), []);
  for (const recordedAt of ['2026-08-17', '2026-08-17T10:00:00', '2026-02-30T10:00:00Z', 'not-a-date']) {
    assert.match(validateImplementationPlan(value, { planningEvidence: [{ ...evidence, recordedAt }] }).join('\n'), /strict RFC3339 date-time/u, recordedAt);
  }
});

test('validation intent rejects executable-shaped prefixes while preserving prose intent', () => {
  for (const command of [
    'vitest run contracts', 'playwright test --project tablet-chromium', 'tsc --noEmit',
    'eslint .', 'python3 scripts/check.py', 'curl https://example.test', 'wget artifact.json',
    'sed -n 1p file', 'rm generated-file', 'future-tool validate contracts',
    'NODE_ENV=test vitest run', './scripts/check.sh', 'CustomTool --check contracts',
    'CustomTool validate contracts', 'customTool validate contracts', 'CUSTOMTOOL validate contracts',
    '"CustomTool" validate contracts', "'CustomTool' validate contracts",
  ]) {
    const value = plan(); value.tasks[0].validationIntent = [command];
    assert.match(validateImplementationPlan(value).join('\n'), /not an executable command/u, command);
  }
  for (const intent of [
    'Validate behavior with Playwright on the selected project',
    'Verify curl integration against a local fixture',
    'Confirm generated files are removed without invoking rm',
    'Exercise artifact downloads through the wget adapter',
    'Validate CustomTool behavior through the planning contract',
    'Review Playwright behavior through the selected scenarios',
  ]) {
    const prose = plan(); prose.tasks[0].validationIntent = [intent];
    assert.deepEqual(validateImplementationPlan(prose), [], intent);
  }
});
