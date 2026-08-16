import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import { registryPath, registrySchemaPath } from './paths.mjs';

import {
  AFFECTED_AREA_IDS,
  REVIEWER_IDS,
  RISK_TAG_IDS,
  SPECIALIZATION_IDS,
  isReviewerEvidenceApplicable,
  loadRegistry,
  requiredReviewerIds,
  routeSpecialists,
  validateRegistry,
  validateReviewerEvidence,
  validateSpecialization,
} from './validate-registry.mjs';

const HEAD = 'a'.repeat(40);

test('registry v1 contains the exact stable IDs and resolvable profile guides', () => {
  const registry = loadRegistry();
  assert.deepEqual(validateRegistry(registry), []);
  const schema = JSON.parse(readFileSync(registrySchemaPath, 'utf8'));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateSchema(registry), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(registry, JSON.parse(readFileSync(registryPath, 'utf8')));
  assert.deepEqual(registry.profiles.map(({ id }) => id), SPECIALIZATION_IDS);
  assert.deepEqual(registry.affectedAreas, AFFECTED_AREA_IDS);
  assert.deepEqual(registry.riskTags, RISK_TAG_IDS);
  assert.deepEqual(registry.reviewers.map(({ id }) => id), REVIEWER_IDS);
});

test('registry preserves the canonical affected-area and supported-risk matrices', () => {
  const registry = loadRegistry();
  assert.deepEqual(Object.fromEntries(registry.profiles.map((profile) => [profile.id, {
    affectedAreas: profile.compatibleAffectedAreas,
    riskTags: profile.supportedRiskTags,
  }])), {
    web: {
      affectedAreas: ['web', 'documentation'],
      riskTags: ['authentication', 'authorization', 'billing', 'money', 'offline', 'realtime', 'localization', 'responsive'],
    },
    api: {
      affectedAreas: ['api', 'documentation'],
      riskTags: ['authentication', 'authorization', 'billing', 'money', 'offline', 'realtime'],
    },
    contracts: {
      affectedAreas: ['shared', 'api', 'web', 'documentation'],
      riskTags: ['authentication', 'authorization', 'billing', 'money', 'offline', 'realtime', 'localization'],
    },
    'data-integrity': {
      affectedAreas: ['api', 'web', 'shared', 'migration', 'release', 'documentation'],
      riskTags: ['authentication', 'authorization', 'billing', 'money', 'migration', 'release', 'offline', 'realtime'],
    },
    'behavior-tests': {
      affectedAreas: ['web', 'api', 'shared', 'documentation'],
      riskTags: ['authentication', 'authorization', 'billing', 'money', 'offline', 'realtime', 'localization', 'responsive'],
    },
    'ops-workflow': {
      affectedAreas: ['workflow', 'release', 'documentation'],
      riskTags: ['migration', 'release', 'deployment', 'workflow'],
    },
  });
});

test('registry validation rejects additional fields at every closed level', () => {
  const registry = loadRegistry();
  for (const mutation of [
    { ...registry, fallbackProfile: 'web' },
    { ...registry, profiles: registry.profiles.map((profile, index) => index === 0 ? { ...profile, commands: [] } : profile) },
    { ...registry, reviewers: registry.reviewers.map((reviewer, index) => index === 0 ? { ...reviewer, canWrite: false } : reviewer) },
    { ...registry, routing: { ...registry.routing, fallbackReviewer: 'integration_verifier' } },
    { ...registry, routing: { ...registry.routing, behaviorMapper: { ...registry.routing.behaviorMapper, inferredSignals: [] } } },
  ]) {
    assert.match(validateRegistry(mutation).join('\n'), /not allowed/u);
  }
});

test('reviewer definitions preserve their exact phase and commit binding', () => {
  const registry = loadRegistry();
  for (const [reviewerId, change] of [
    ['behavior_mapper', { headBinding: 'integrated' }],
    ['security_reviewer', { phase: 'planning' }],
    ['offline_realtime_reviewer', { headBinding: 'reviewed' }],
    ['integration_verifier', { phase: 'planning' }],
  ]) {
    const mutated = structuredClone(registry);
    const reviewer = mutated.reviewers.find(({ id }) => id === reviewerId);
    Object.assign(reviewer, change);
    assert.ok(validateRegistry(mutated).some((error) => error.includes(reviewerId)));
  }
});

test('specialization validation rejects missing, unknown, duplicate, and contradictory metadata', () => {
  assert.deepEqual(validateSpecialization({
    specialization: 'web', affectedAreas: ['web'], riskTags: ['localization'],
  }), []);
  assert.match(validateSpecialization({ affectedAreas: ['web'], riskTags: [] }).join('\n'), /specialization is required/u);
  assert.match(validateSpecialization({ specialization: 'generic', affectedAreas: ['web'], riskTags: [] }).join('\n'), /unknown specialization/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['space'], riskTags: [] }).join('\n'), /unknown affected area/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['web', 'web'], riskTags: [] }).join('\n'), /duplicate affected area/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['api'], riskTags: [] }).join('\n'), /incompatible/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['web'], riskTags: ['mystery'] }).join('\n'), /unknown risk tag/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['web'], riskTags: ['offline', 'offline'] }).join('\n'), /duplicate risk tag/u);
  assert.match(validateSpecialization({ specialization: 'web', affectedAreas: ['web'], riskTags: ['deployment'] }).join('\n'), /does not support/u);
  assert.deepEqual(validateSpecialization({ specialization: 'data-integrity', affectedAreas: ['api', 'web'], riskTags: ['billing'] }), []);
});

test('routing requires explicit behavior signals and selects behavior mapping deterministically', () => {
  assert.throws(() => routeSpecialists({ specialization: 'web', riskTags: [] }), /browserVisible/u);
  const base = { specialization: 'web', riskTags: [], browserVisible: false, testSelectionUncertain: false };
  assert.deepEqual(requiredReviewerIds(routeSpecialists(base)), ['integration_verifier']);
  for (const input of [
    { ...base, browserVisible: true },
    { ...base, testSelectionUncertain: true },
    { ...base, riskTags: ['localization'] },
    { ...base, riskTags: ['responsive'] },
    { ...base, specialization: 'behavior-tests', riskTags: [] },
  ]) {
    assert.deepEqual(requiredReviewerIds(routeSpecialists(input)), ['behavior_mapper', 'integration_verifier']);
  }
});

test('risk routing is deduplicated and independent of risk-tag order', () => {
  const input = { specialization: 'api', browserVisible: false, testSelectionUncertain: false };
  const first = routeSpecialists({ ...input, riskTags: ['realtime', 'authentication', 'offline', 'authorization'] });
  const second = routeSpecialists({ ...input, riskTags: ['authorization', 'offline', 'authentication', 'realtime'] });
  assert.deepEqual(first, second);
  assert.deepEqual(requiredReviewerIds(first), [
    'security_reviewer', 'offline_realtime_reviewer', 'integration_verifier',
  ]);
});

test('data-integrity risks raise final verification priority', () => {
  for (const risk of ['billing', 'money', 'migration', 'release']) {
    const specialization = ['migration', 'release'].includes(risk) ? 'data-integrity' : 'api';
    const route = routeSpecialists({ specialization, riskTags: [risk], browserVisible: false, testSelectionUncertain: false });
    assert.equal(route.integrationVerifierPriority, 'high');
    assert.deepEqual(requiredReviewerIds(route), ['integration_verifier']);
    if (specialization !== 'data-integrity') {
      assert.deepEqual(route.supplementalGuidance.map(({ id }) => id), ['data-integrity']);
    }
  }
});

test('deployment and workflow risks add ops guidance without raising verifier priority', () => {
  const route = routeSpecialists({
    specialization: 'ops-workflow', riskTags: ['workflow', 'deployment'],
    browserVisible: false, testSelectionUncertain: false,
  });
  assert.equal(route.integrationVerifierPriority, 'standard');
  assert.deepEqual(route.supplementalGuidance, []);
  assert.equal(route.profileGuidePath, 'profiles/ops-workflow.md');
});

test('router returns guidance only and cannot expand ownership or validation', () => {
  const input = {
    specialization: 'web', riskTags: ['responsive'], browserVisible: true, testSelectionUncertain: true,
    allowedPaths: ['apps/web/src/App.tsx'],
    requiredValidation: { unit: [{ command: 'npm test' }], system: [] },
  };
  const before = structuredClone(input);
  const route = routeSpecialists(input);
  assert.deepEqual(input, before);
  assert.equal('allowedPaths' in route, false);
  assert.equal('requiredValidation' in route, false);
  assert.equal(route.supplementalGuidance.some((guidance) => 'allowedPaths' in guidance), false);
  assert.equal(JSON.stringify(route).includes('apps/web/src/App.tsx'), false);
  assert.equal(JSON.stringify(route).includes('npm test'), false);
});

test('exact-HEAD evidence requires every integrated review and becomes stale after HEAD changes', () => {
  const route = routeSpecialists({
    specialization: 'api', riskTags: ['authentication', 'offline'],
    browserVisible: false, testSelectionUncertain: false,
  });
  const evidence = requiredReviewerIds(route, { phase: 'review' }).map((reviewerId) => ({
    reviewerId, headSha: HEAD, status: 'clean', summary: 'No finding.',
  }));
  assert.deepEqual(validateReviewerEvidence({ evidence, route, integratedHeadSha: HEAD }), []);
  assert.equal(isReviewerEvidenceApplicable({ evidence: evidence[0], integratedHeadSha: HEAD }), true);
  assert.equal(isReviewerEvidenceApplicable({ evidence: evidence[0], integratedHeadSha: 'b'.repeat(40) }), false);
  assert.match(validateReviewerEvidence({ evidence, route, integratedHeadSha: 'b'.repeat(40) }).join('\n'), /stale/u);
  assert.match(validateReviewerEvidence({ evidence: evidence.slice(1), route, integratedHeadSha: HEAD }).join('\n'), /missing required reviewer evidence/u);
});
