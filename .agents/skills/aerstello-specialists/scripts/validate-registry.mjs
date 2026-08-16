#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { registryPath, skillPath } from './paths.mjs';

export const SPECIALIZATION_IDS = Object.freeze([
  'web', 'api', 'contracts', 'data-integrity', 'behavior-tests', 'ops-workflow',
]);
export const AFFECTED_AREA_IDS = Object.freeze([
  'api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration',
]);
export const RISK_TAG_IDS = Object.freeze([
  'authentication', 'authorization', 'billing', 'money', 'migration', 'release',
  'offline', 'realtime', 'localization', 'responsive', 'deployment', 'workflow',
]);
export const REVIEWER_IDS = Object.freeze([
  'behavior_mapper', 'security_reviewer', 'offline_realtime_reviewer', 'integration_verifier',
]);

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const EVIDENCE_STATUSES = new Set(['clean', 'findings']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function duplicates(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function exactArray(errors, label, actual, expected) {
  if (!Array.isArray(actual)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    errors.push(`${label} must equal the canonical ordered IDs: ${expected.join(', ')}`);
  }
}

function rejectUnknownKeys(errors, label, value, allowed) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

export function loadRegistry({ path = registryPath, validate = true } = {}) {
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (validate) {
    const errors = validateRegistry(registry);
    if (errors.length > 0) throw new Error(`invalid specialist registry:\n- ${errors.join('\n- ')}`);
  }
  return registry;
}

export function validateRegistry(registry) {
  const errors = [];
  if (!isRecord(registry)) return ['registry must be an object'];
  rejectUnknownKeys(errors, 'registry', registry, [
    '$schema', 'schemaVersion', 'affectedAreas', 'riskTags', 'profiles', 'reviewers', 'routing',
  ]);
  if (registry.$schema !== './schemas/registry.schema.json') errors.push('$schema must reference the canonical registry schema');
  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  exactArray(errors, 'affectedAreas', registry.affectedAreas, AFFECTED_AREA_IDS);
  exactArray(errors, 'riskTags', registry.riskTags, RISK_TAG_IDS);

  if (!Array.isArray(registry.profiles)) {
    errors.push('profiles must be an array');
  } else {
    exactArray(errors, 'profile IDs', registry.profiles.map((profile) => profile?.id), SPECIALIZATION_IDS);
    for (const profile of registry.profiles) {
      if (!isRecord(profile)) continue;
      rejectUnknownKeys(errors, `profiles.${profile.id ?? 'unknown'}`, profile, [
        'id', 'guidePath', 'compatibleAffectedAreas', 'supportedRiskTags',
      ]);
      if (profile.guidePath !== `profiles/${profile.id}.md`) errors.push(`${profile.id} has an invalid guidePath`);
      if (!existsSync(skillPath(profile.guidePath ?? ''))) errors.push(`${profile.id} guide does not exist`);
      for (const [field, known] of [
        ['compatibleAffectedAreas', new Set(AFFECTED_AREA_IDS)],
        ['supportedRiskTags', new Set(RISK_TAG_IDS)],
      ]) {
        const values = profile[field];
        if (!Array.isArray(values) || (field === 'compatibleAffectedAreas' && values.length === 0)) {
          errors.push(`${profile.id}.${field} must be ${field === 'compatibleAffectedAreas' ? 'a non-empty' : 'an'} array`);
          continue;
        }
        for (const value of values) if (!known.has(value)) errors.push(`${profile.id}.${field} contains unknown ID ${value}`);
        if (duplicates(values).length > 0) errors.push(`${profile.id}.${field} contains duplicate IDs`);
      }
    }
  }

  if (!Array.isArray(registry.reviewers)) {
    errors.push('reviewers must be an array');
  } else {
    exactArray(errors, 'reviewer IDs', registry.reviewers.map((reviewer) => reviewer?.id), REVIEWER_IDS);
    const expectedBindings = new Map([
      ['behavior_mapper', { phase: 'planning', headBinding: 'reviewed' }],
      ['security_reviewer', { phase: 'review', headBinding: 'integrated' }],
      ['offline_realtime_reviewer', { phase: 'review', headBinding: 'integrated' }],
      ['integration_verifier', { phase: 'review', headBinding: 'integrated' }],
    ]);
    for (const reviewer of registry.reviewers) {
      if (!isRecord(reviewer)) continue;
      rejectUnknownKeys(errors, `reviewers.${reviewer.id ?? 'unknown'}`, reviewer, [
        'id', 'phase', 'readOnly', 'nonDelegating', 'githubWrites', 'headBinding', 'guidance',
      ]);
      if (reviewer.readOnly !== true || reviewer.nonDelegating !== true || reviewer.githubWrites !== false) {
        errors.push(`${reviewer.id} must be read-only, non-delegating, and forbidden from GitHub writes`);
      }
      if (!['planning', 'review'].includes(reviewer.phase)) errors.push(`${reviewer.id} has an invalid phase`);
      if (!['reviewed', 'integrated'].includes(reviewer.headBinding)) errors.push(`${reviewer.id} has an invalid headBinding`);
      const expected = expectedBindings.get(reviewer.id);
      if (expected && (reviewer.phase !== expected.phase || reviewer.headBinding !== expected.headBinding)) {
        errors.push(`${reviewer.id} must use ${expected.phase} phase and ${expected.headBinding}-HEAD binding`);
      }
      if (typeof reviewer.guidance !== 'string' || reviewer.guidance.trim() === '') errors.push(`${reviewer.id} guidance is required`);
    }
  }

  const routing = registry.routing;
  if (!isRecord(routing) || !isRecord(routing.behaviorMapper)) {
    errors.push('routing and routing.behaviorMapper must be objects');
  } else {
    rejectUnknownKeys(errors, 'routing', routing, [
      'behaviorMapper', 'securityReviewerRiskTags', 'offlineRealtimeReviewerRiskTags',
      'dataIntegrityGuidanceRiskTags', 'opsWorkflowGuidanceRiskTags',
      'integrationVerifierHighPriorityRiskTags',
    ]);
    rejectUnknownKeys(errors, 'routing.behaviorMapper', routing.behaviorMapper, [
      'specializations', 'riskTags', 'signals',
    ]);
    exactArray(errors, 'behavior mapper specializations', routing.behaviorMapper.specializations, ['behavior-tests']);
    exactArray(errors, 'behavior mapper risk tags', routing.behaviorMapper.riskTags, ['localization', 'responsive']);
    exactArray(errors, 'behavior mapper signals', routing.behaviorMapper.signals, ['browserVisible', 'testSelectionUncertain']);
    exactArray(errors, 'security reviewer risk tags', routing.securityReviewerRiskTags, ['authentication', 'authorization']);
    exactArray(errors, 'offline/realtime reviewer risk tags', routing.offlineRealtimeReviewerRiskTags, ['offline', 'realtime']);
    exactArray(errors, 'data-integrity guidance risk tags', routing.dataIntegrityGuidanceRiskTags, ['billing', 'money', 'migration', 'release']);
    exactArray(errors, 'ops/workflow guidance risk tags', routing.opsWorkflowGuidanceRiskTags, ['deployment', 'workflow']);
    exactArray(errors, 'integration verifier high-priority risk tags', routing.integrationVerifierHighPriorityRiskTags, ['billing', 'money', 'migration', 'release']);
  }
  return errors;
}

export function validateSpecialization({ specialization, affectedAreas, riskTags } = {}, registry = loadRegistry()) {
  const errors = [];
  const profile = registry.profiles.find(({ id }) => id === specialization);
  if (typeof specialization !== 'string' || specialization === '') errors.push('specialization is required');
  else if (!profile) errors.push(`unknown specialization: ${specialization}`);

  if (!Array.isArray(affectedAreas) || affectedAreas.length === 0) {
    errors.push('affectedAreas must be a non-empty array');
  } else {
    for (const area of affectedAreas) if (!registry.affectedAreas.includes(area)) errors.push(`unknown affected area: ${area}`);
    for (const area of new Set(duplicates(affectedAreas))) errors.push(`duplicate affected area: ${area}`);
    if (profile) {
      for (const area of affectedAreas) {
        if (registry.affectedAreas.includes(area) && !profile.compatibleAffectedAreas.includes(area)) {
          errors.push(`specialization ${specialization} is incompatible with affected area ${area}`);
        }
      }
    }
  }

  if (!Array.isArray(riskTags)) {
    errors.push('riskTags must be an array');
  } else {
    for (const risk of riskTags) if (!registry.riskTags.includes(risk)) errors.push(`unknown risk tag: ${risk}`);
    for (const risk of new Set(duplicates(riskTags))) errors.push(`duplicate risk tag: ${risk}`);
    if (profile) {
      for (const risk of riskTags) {
        if (registry.riskTags.includes(risk) && !profile.supportedRiskTags.includes(risk)) {
          errors.push(`specialization ${specialization} does not support risk tag ${risk}`);
        }
      }
    }
  }
  return errors;
}

function orderedRisks(riskTags, registry) {
  return registry.riskTags.filter((risk) => riskTags.includes(risk));
}

function requireRoutingInput(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function routeSpecialists({
  specialization,
  riskTags,
  browserVisible,
  testSelectionUncertain,
} = {}, registry = loadRegistry()) {
  requireRoutingInput(typeof specialization === 'string' && specialization !== '', 'specialization is required');
  requireRoutingInput(Array.isArray(riskTags), 'riskTags must be an array');
  requireRoutingInput(typeof browserVisible === 'boolean', 'browserVisible must be an explicit boolean');
  requireRoutingInput(typeof testSelectionUncertain === 'boolean', 'testSelectionUncertain must be an explicit boolean');
  const profile = registry.profiles.find(({ id }) => id === specialization);
  requireRoutingInput(Boolean(profile), `unknown specialization: ${specialization}`);
  const risks = orderedRisks(riskTags, registry);
  requireRoutingInput(risks.length === riskTags.length && duplicates(riskTags).length === 0, 'riskTags must contain unique known risk tags');
  for (const risk of risks) {
    requireRoutingInput(profile.supportedRiskTags.includes(risk), `specialization ${specialization} does not support risk tag ${risk}`);
  }

  const reasons = new Map();
  const add = (reviewerId, reason) => {
    if (!reasons.has(reviewerId)) reasons.set(reviewerId, []);
    if (!reasons.get(reviewerId).includes(reason)) reasons.get(reviewerId).push(reason);
  };
  const behavior = registry.routing.behaviorMapper;
  if (behavior.specializations.includes(specialization)) add('behavior_mapper', `specialization:${specialization}`);
  for (const risk of behavior.riskTags) if (risks.includes(risk)) add('behavior_mapper', `risk:${risk}`);
  if (browserVisible) add('behavior_mapper', 'signal:browserVisible');
  if (testSelectionUncertain) add('behavior_mapper', 'signal:testSelectionUncertain');
  for (const risk of registry.routing.securityReviewerRiskTags) if (risks.includes(risk)) add('security_reviewer', `risk:${risk}`);
  for (const risk of registry.routing.offlineRealtimeReviewerRiskTags) if (risks.includes(risk)) add('offline_realtime_reviewer', `risk:${risk}`);
  add('integration_verifier', 'final-combined-review');
  const highPriority = registry.routing.integrationVerifierHighPriorityRiskTags.some((risk) => risks.includes(risk));
  if (highPriority) add('integration_verifier', 'high-priority:data-integrity');

  const supplementalGuidance = [];
  const addSupplementalGuidance = (id, routedRisks) => {
    if (id === specialization || routedRisks.length === 0) return;
    const supplementalProfile = registry.profiles.find((candidate) => candidate.id === id);
    supplementalGuidance.push({
      id,
      guidePath: supplementalProfile.guidePath,
      reasons: routedRisks.map((risk) => `risk:${risk}`),
    });
  };
  addSupplementalGuidance(
    'data-integrity',
    registry.routing.dataIntegrityGuidanceRiskTags.filter((risk) => risks.includes(risk)),
  );
  addSupplementalGuidance(
    'ops-workflow',
    registry.routing.opsWorkflowGuidanceRiskTags.filter((risk) => risks.includes(risk)),
  );

  const reviewers = registry.reviewers
    .filter(({ id }) => reasons.has(id))
    .map(({ id, phase, headBinding, guidance }) => ({
      id, phase, headBinding, guidance, reasons: [...reasons.get(id)],
    }));
  return {
    schemaVersion: registry.schemaVersion,
    specialization,
    profileGuidePath: profile.guidePath,
    riskTags: risks,
    signals: { browserVisible, testSelectionUncertain },
    integrationVerifierPriority: highPriority ? 'high' : 'standard',
    supplementalGuidance,
    reviewers,
  };
}

export function requiredReviewerIds(route, { phase } = {}) {
  if (!isRecord(route) || !Array.isArray(route.reviewers)) throw new TypeError('route.reviewers must be an array');
  return route.reviewers.filter((reviewer) => phase === undefined || reviewer.phase === phase).map(({ id }) => id);
}

export function isReviewerEvidenceApplicable({ evidence, integratedHeadSha } = {}) {
  return isRecord(evidence)
    && SHA_PATTERN.test(integratedHeadSha ?? '')
    && evidence.headSha === integratedHeadSha;
}

export function validateReviewerEvidence({ evidence, route, integratedHeadSha } = {}) {
  const errors = [];
  if (!SHA_PATTERN.test(integratedHeadSha ?? '')) errors.push('integratedHeadSha must be a 40- or 64-character lowercase hexadecimal SHA');
  if (!Array.isArray(evidence)) return [...errors, 'evidence must be an array'];
  let required;
  try {
    required = requiredReviewerIds(route, { phase: 'review' });
  } catch (error) {
    return [...errors, error.message];
  }
  const seen = new Set();
  for (const item of evidence) {
    if (!isRecord(item)) {
      errors.push('each evidence entry must be an object');
      continue;
    }
    if (!REVIEWER_IDS.includes(item.reviewerId)) errors.push(`unknown reviewer evidence: ${item.reviewerId}`);
    if (seen.has(item.reviewerId)) errors.push(`duplicate reviewer evidence: ${item.reviewerId}`);
    seen.add(item.reviewerId);
    if (!SHA_PATTERN.test(item.headSha ?? '')) errors.push(`${item.reviewerId} evidence has an invalid headSha`);
    else if (!isReviewerEvidenceApplicable({ evidence: item, integratedHeadSha })) errors.push(`${item.reviewerId} evidence is stale for integrated HEAD`);
    if (!EVIDENCE_STATUSES.has(item.status)) errors.push(`${item.reviewerId} evidence has an invalid status`);
    if (typeof item.summary !== 'string' || item.summary.trim() === '') errors.push(`${item.reviewerId} evidence requires a summary`);
  }
  for (const reviewerId of required) if (!seen.has(reviewerId)) errors.push(`missing required reviewer evidence: ${reviewerId}`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = loadRegistry({ validate: false });
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`valid specialist registry v${registry.schemaVersion}\n`);
  }
}
