import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import { registryPath, registrySchemaPath } from './paths.mjs';

import {
  AFFECTED_AREA_IDS,
  PLANNING_HELPER_IDS,
  RISK_REVIEWER_IDS,
  RISK_TAG_IDS,
  SPECIALIST_ROLE_IDS,
  SPECIALIZATION_IDS,
  isSpecialistEvidenceApplicable,
  loadRegistry,
  requiredSpecialistIds,
  routeSpecialists,
  validateRegistry,
  validateSpecialistEvidence,
  validateSpecialization,
} from './validate-registry.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function route(overrides = {}) {
  return routeSpecialists({
    specialization: 'api',
    riskTags: [],
    browserVisible: false,
    testSelectionUncertain: false,
    ...overrides,
  });
}

function evidence(reviewerId, overrides = {}) {
  return {
    reviewerId,
    headSha: HEAD,
    status: 'clean',
    summary: 'No finding.',
    ...overrides,
  };
}

test('registry v2 contains the exact stable IDs and reusable specialist roles', () => {
  const registry = loadRegistry();
  assert.deepEqual(validateRegistry(registry), []);
  const schema = JSON.parse(readFileSync(registrySchemaPath, 'utf8'));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateSchema(registry), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(registry, JSON.parse(readFileSync(registryPath, 'utf8')));
  assert.equal(registry.schemaVersion, 2);
  assert.deepEqual(registry.profiles.map(({ id }) => id), SPECIALIZATION_IDS);
  assert.deepEqual(registry.affectedAreas, AFFECTED_AREA_IDS);
  assert.deepEqual(registry.riskTags, RISK_TAG_IDS);
  assert.deepEqual(PLANNING_HELPER_IDS, ['behavior_mapper']);
  assert.deepEqual(RISK_REVIEWER_IDS, ['security_reviewer', 'offline_realtime_reviewer']);
  assert.deepEqual(SPECIALIST_ROLE_IDS, [...PLANNING_HELPER_IDS, ...RISK_REVIEWER_IDS]);
  assert.deepEqual(registry.reviewers.map(({ id }) => id), SPECIALIST_ROLE_IDS);
  assert.equal(JSON.stringify(registry).includes('integration_verifier'), false);
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
    { ...registry, routing: { ...registry.routing, fallbackVerifier: 'integration_verifier' } },
    { ...registry, routing: { ...registry.routing, integrationVerifierHighPriorityRiskTags: [] } },
    { ...registry, routing: { ...registry.routing, behaviorMapper: { ...registry.routing.behaviorMapper, inferredSignals: [] } } },
  ]) {
    assert.match(validateRegistry(mutation).join('\n'), /not allowed/u);
  }
});

test('reusable role definitions preserve exact phase and subject binding', () => {
  const registry = loadRegistry();
  assert.deepEqual(registry.reviewers.map(({ id, phase, subjectBinding }) => ({
    id, phase, subjectBinding,
  })), [
    { id: 'behavior_mapper', phase: 'planning', subjectBinding: 'planning' },
    { id: 'security_reviewer', phase: 'review', subjectBinding: 'integrated' },
    { id: 'offline_realtime_reviewer', phase: 'review', subjectBinding: 'integrated' },
  ]);
  for (const [reviewerId, change] of [
    ['behavior_mapper', { subjectBinding: 'integrated' }],
    ['security_reviewer', { phase: 'planning' }],
    ['offline_realtime_reviewer', { subjectBinding: 'planning' }],
  ]) {
    const mutated = structuredClone(registry);
    Object.assign(mutated.reviewers.find(({ id }) => id === reviewerId), change);
    assert.ok(validateRegistry(mutated).some((error) => error.includes(reviewerId)));
  }
  const withFinalVerifier = structuredClone(registry);
  withFinalVerifier.reviewers.push({
    ...withFinalVerifier.reviewers[1], id: 'integration_verifier',
  });
  assert.match(validateRegistry(withFinalVerifier).join('\n'), /canonical ordered IDs/u);
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

test('routing returns the exact workflow-neutral v2 shape without a final verifier', () => {
  const actual = route({ riskTags: ['billing', 'authorization'] });
  assert.deepEqual(actual, {
    schemaVersion: 2,
    specialization: 'api',
    profileGuidePath: 'profiles/api.md',
    riskTags: ['authorization', 'billing'],
    signals: { browserVisible: false, testSelectionUncertain: false },
    planningHelpers: [],
    riskReviewers: [{ id: 'security_reviewer', reasons: ['risk:authorization'] }],
    supplementalGuidance: [{ id: 'data-integrity', reasons: ['risk:billing'] }],
    finalVerificationPriority: 'high',
  });
  assert.deepEqual(Object.keys(actual), [
    'schemaVersion', 'specialization', 'profileGuidePath', 'riskTags', 'signals',
    'planningHelpers', 'riskReviewers', 'supplementalGuidance', 'finalVerificationPriority',
  ]);
  assert.equal('reviewers' in actual, false);
  assert.equal(JSON.stringify(actual).includes('integration_verifier'), false);
});

test('routing requires explicit signals and selects behavior mapping for every trigger', () => {
  assert.throws(() => routeSpecialists({ specialization: 'web', riskTags: [] }), /browserVisible/u);
  const base = {
    specialization: 'web', riskTags: [], browserVisible: false, testSelectionUncertain: false,
  };
  assert.deepEqual(requiredSpecialistIds(routeSpecialists(base), { phase: 'planning' }), []);
  const triggers = [
    [{ ...base, browserVisible: true }, ['signal:browserVisible']],
    [{ ...base, testSelectionUncertain: true }, ['signal:testSelectionUncertain']],
    [{ ...base, riskTags: ['localization'] }, ['risk:localization']],
    [{ ...base, riskTags: ['responsive'] }, ['risk:responsive']],
    [{ ...base, specialization: 'behavior-tests' }, ['specialization:behavior-tests']],
  ];
  for (const [input, reasons] of triggers) {
    const routed = routeSpecialists(input);
    assert.deepEqual(requiredSpecialistIds(routed, { phase: 'planning' }), ['behavior_mapper']);
    assert.deepEqual(routed.planningHelpers[0].reasons, reasons);
  }
  const combined = routeSpecialists({
    specialization: 'behavior-tests', riskTags: ['responsive', 'localization'],
    browserVisible: true, testSelectionUncertain: true,
  });
  assert.deepEqual(combined.planningHelpers, [{
    id: 'behavior_mapper',
    reasons: [
      'specialization:behavior-tests', 'risk:localization', 'risk:responsive',
      'signal:browserVisible', 'signal:testSelectionUncertain',
    ],
  }]);
});

test('risk routing is deduplicated, categorized, and independent of input order', () => {
  const input = { specialization: 'api', browserVisible: false, testSelectionUncertain: false };
  const first = routeSpecialists({
    ...input, riskTags: ['realtime', 'authentication', 'offline', 'authorization'],
  });
  const second = routeSpecialists({
    ...input, riskTags: ['authorization', 'offline', 'authentication', 'realtime'],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.riskReviewers, [
    { id: 'security_reviewer', reasons: ['risk:authentication', 'risk:authorization'] },
    { id: 'offline_realtime_reviewer', reasons: ['risk:offline', 'risk:realtime'] },
  ]);
  assert.deepEqual(requiredSpecialistIds(first, { phase: 'planning' }), []);
  assert.deepEqual(requiredSpecialistIds(first, { phase: 'review' }), RISK_REVIEWER_IDS);
});

test('supplemental guidance is deduplicated and final-verification priority is deterministic', () => {
  assert.equal(route().finalVerificationPriority, 'standard');
  const routed = route({ riskTags: ['money', 'billing'] });
  assert.equal(routed.finalVerificationPriority, 'high');
  assert.deepEqual(routed.supplementalGuidance, [{
    id: 'data-integrity', reasons: ['risk:billing', 'risk:money'],
  }]);
  for (const risk of ['billing', 'money', 'migration', 'release']) {
    const specialization = ['migration', 'release'].includes(risk) ? 'data-integrity' : 'api';
    const highRiskRoute = routeSpecialists({
      specialization, riskTags: [risk], browserVisible: false, testSelectionUncertain: false,
    });
    assert.equal(highRiskRoute.finalVerificationPriority, 'high');
    if (specialization === 'data-integrity') assert.deepEqual(highRiskRoute.supplementalGuidance, []);
  }
  const opsRoute = routeSpecialists({
    specialization: 'ops-workflow', riskTags: ['workflow', 'deployment'],
    browserVisible: false, testSelectionUncertain: false,
  });
  assert.equal(opsRoute.finalVerificationPriority, 'standard');
  assert.deepEqual(opsRoute.supplementalGuidance, []);
});

test('router rejects unknown, duplicate, unsupported, and missing metadata', () => {
  assert.throws(() => route({ specialization: 'generic' }), /unknown specialization/u);
  assert.throws(() => route({ riskTags: ['mystery'] }), /unique known risk tags/u);
  assert.throws(() => route({ riskTags: ['offline', 'offline'] }), /unique known risk tags/u);
  assert.throws(() => route({ specialization: 'web', riskTags: ['deployment'] }), /does not support/u);
  assert.throws(() => routeSpecialists({
    specialization: 'api', riskTags: [], browserVisible: false,
  }), /testSelectionUncertain/u);
});

test('router returns guidance only and cannot expand ownership or validation authority', () => {
  const input = {
    specialization: 'web', riskTags: ['responsive'], browserVisible: true,
    testSelectionUncertain: true, allowedPaths: ['apps/web/src/App.tsx'],
    requiredValidation: { unit: [{ command: 'npm test' }], system: [] },
    acceptanceCriteria: ['Untrusted expansion.'], selectors: ['all'], projects: ['all'],
  };
  const before = structuredClone(input);
  const routed = routeSpecialists(input);
  assert.deepEqual(input, before);
  for (const forbidden of [
    'allowedPaths', 'requiredValidation', 'acceptanceCriteria', 'selectors', 'projects',
  ]) assert.equal(forbidden in routed, false);
  assert.equal(JSON.stringify(routed).includes('apps/web/src/App.tsx'), false);
  assert.equal(JSON.stringify(routed).includes('npm test'), false);
});

test('planning evidence binds to a generic exact planning subject SHA', () => {
  const routed = route({ browserVisible: true });
  const mapperEvidence = evidence('behavior_mapper');
  assert.deepEqual(validateSpecialistEvidence({
    evidence: [mapperEvidence], route: routed, subjectSha: HEAD, phase: 'planning',
  }), []);
  assert.equal(isSpecialistEvidenceApplicable({
    evidence: mapperEvidence, subjectSha: HEAD, phase: 'planning',
  }), true);
  assert.equal(isSpecialistEvidenceApplicable({
    evidence: mapperEvidence, subjectSha: OTHER_HEAD, phase: 'planning',
  }), false);
  assert.match(validateSpecialistEvidence({
    evidence: [mapperEvidence], route: routed, subjectSha: OTHER_HEAD, phase: 'planning',
  }).join('\n'), /stale or inapplicable/u);
  assert.match(validateSpecialistEvidence({
    evidence: [], route: routed, subjectSha: HEAD, phase: 'planning',
  }).join('\n'), /missing required specialist evidence: behavior_mapper/u);
});

test('integrated risk evidence requires every routed reviewer and stales after HEAD advances', () => {
  const routed = route({ riskTags: ['authentication', 'offline'] });
  const reviewEvidence = requiredSpecialistIds(routed, { phase: 'review' })
    .map((reviewerId) => evidence(reviewerId));
  assert.deepEqual(validateSpecialistEvidence({
    evidence: reviewEvidence, route: routed, subjectSha: HEAD, phase: 'review',
  }), []);
  assert.equal(isSpecialistEvidenceApplicable({
    evidence: reviewEvidence[0], subjectSha: HEAD, phase: 'review',
  }), true);
  assert.equal(isSpecialistEvidenceApplicable({
    evidence: reviewEvidence[0], subjectSha: OTHER_HEAD, phase: 'review',
  }), false);
  assert.match(validateSpecialistEvidence({
    evidence: reviewEvidence, route: routed, subjectSha: OTHER_HEAD, phase: 'review',
  }).join('\n'), /stale or inapplicable/u);
  assert.match(validateSpecialistEvidence({
    evidence: reviewEvidence.slice(1), route: routed, subjectSha: HEAD, phase: 'review',
  }).join('\n'), /missing required specialist evidence: security_reviewer/u);
});

test('evidence validation rejects invalid phases, cross-phase, unrouted, final, and duplicate evidence', () => {
  const routed = route({ riskTags: ['authentication'] });
  assert.match(validateSpecialistEvidence({
    evidence: [], route: routed, subjectSha: HEAD, phase: 'verification',
  }).join('\n'), /phase must be planning or review/u);
  assert.match(validateSpecialistEvidence({
    evidence: [evidence('behavior_mapper')], route: routed, subjectSha: HEAD, phase: 'review',
  }).join('\n'), /does not apply to review phase/u);
  assert.match(validateSpecialistEvidence({
    evidence: [evidence('offline_realtime_reviewer')], route: routed, subjectSha: HEAD, phase: 'review',
  }).join('\n'), /not routed for review phase/u);
  assert.match(validateSpecialistEvidence({
    evidence: [evidence('integration_verifier')], route: routed, subjectSha: HEAD, phase: 'review',
  }).join('\n'), /unknown specialist evidence: integration_verifier/u);
  assert.match(validateSpecialistEvidence({
    evidence: [evidence('security_reviewer'), evidence('security_reviewer')],
    route: routed, subjectSha: HEAD, phase: 'review',
  }).join('\n'), /duplicate specialist evidence/u);
  assert.match(validateSpecialistEvidence({
    evidence: [evidence('security_reviewer', { headSha: 'invalid', status: 'maybe', summary: '' })],
    route: routed, subjectSha: 'invalid', phase: 'review',
  }).join('\n'), /subjectSha.*invalid headSha.*invalid status.*requires a summary/su);
});

test('required specialist selection rejects malformed route categories', () => {
  assert.throws(() => requiredSpecialistIds(route(), {}), /phase must be planning or review/u);
  assert.throws(() => requiredSpecialistIds({ planningHelpers: {} }, { phase: 'planning' }), /must be an array/u);
  assert.throws(() => requiredSpecialistIds({
    planningHelpers: [{ id: 'security_reviewer', reasons: [] }],
  }, { phase: 'planning' }), /invalid specialist/u);
  assert.throws(() => requiredSpecialistIds({
    riskReviewers: [
      { id: 'security_reviewer', reasons: [] },
      { id: 'security_reviewer', reasons: [] },
    ],
  }, { phase: 'review' }), /duplicate specialist/u);
});
