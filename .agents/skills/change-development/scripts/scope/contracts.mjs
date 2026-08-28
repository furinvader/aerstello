import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { digestJson } from '../contracts/contracts.mjs';
import {
  validateAssessmentPacket,
  validateScopeAssessmentApplicability,
  validateScopeAssessmentResult,
} from '../../../scope-review/scripts/validate-assessment.mjs';

// Canonical consumers: .agents/skills/scope-review/scripts/validate-assessment.mjs
// and .agents/skills/scope-review/schemas/scope-assessment.schema.json.

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const schemaDirectory = new URL('../../schemas/', import.meta.url);
const scopeReviewSchema = JSON.parse(readFileSync(
  new URL('../../../scope-review/schemas/scope-assessment.schema.json', import.meta.url),
  'utf8',
));

export const scopeContractSchemas = Object.freeze(Object.fromEntries(
  [
    ['minimalClosure', 'minimal-closure-contract.schema.json'],
    ['scopeDecision', 'scope-decision.schema.json'],
    ['scopeEvidence', 'scope-evidence.schema.json'],
  ].map(([kind, file]) => [
    kind,
    JSON.parse(readFileSync(new URL(file, schemaDirectory), 'utf8')),
  ]),
));

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(scopeReviewSchema);
const validators = Object.freeze(Object.fromEntries(
  Object.entries(scopeContractSchemas).map(([kind, schema]) => [kind, ajv.compile(schema)]),
));

function schemaErrors(validator) {
  return (validator.errors ?? []).map(({ instancePath, message }) => (
    `${instancePath || '$'} ${message}`
  ));
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated].sort();
}

function repeatedCriterionIds(value, fields) {
  return fields.flatMap((field) => duplicates((value?.[field] ?? []).map(({ id }) => id))
    .map((id) => `$ ${field} contains duplicate id ${id}`));
}

export function scopeContractDigest(value) {
  return digestJson(value);
}

export function validateMinimalClosureContract(value) {
  const validate = validators.minimalClosure;
  const errors = validate(value) ? [] : schemaErrors(validate);
  errors.push(...repeatedCriterionIds(value, [
    'requiredCriteria',
    'invariants',
    'nonGoals',
    'mandatoryConstraints',
    'optionalGuidance',
    'deferredFollowups',
  ]));
  if (value?.revision === 1 && value.previousContractDigest !== null) {
    errors.push('$ initial minimal closure contract must have a null previousContractDigest');
  }
  if (Number.isInteger(value?.revision) && value.revision > 1
      && value.previousContractDigest === null) {
    errors.push('$ revised minimal closure contract requires previousContractDigest');
  }
  return [...new Set(errors)].sort();
}

export function validateScopeDecision(value) {
  const validate = validators.scopeDecision;
  return validate(value) ? [] : [...new Set(schemaErrors(validate))].sort();
}

const BOUNDARY_PHASE = Object.freeze({
  admission: 'plan',
  task: 'task',
  'integrated-head': 'integrated-head',
});

export function validateScopeEvidence(value) {
  const validate = validators.scopeEvidence;
  const errors = validate(value) ? [] : schemaErrors(validate);
  if (errors.length > 0) return [...new Set(errors)].sort();
  errors.push(...validateAssessmentPacket(value.packet).map((error) => `packet: ${error}`));
  errors.push(...validateScopeAssessmentResult(value.result).map((error) => `result: ${error}`));
  errors.push(...validateScopeAssessmentApplicability(value.packet, value.result)
    .map((error) => `applicability: ${error}`));
  if (value.packetDigest !== scopeContractDigest(value.packet)) {
    errors.push('$ packetDigest must equal the canonical assessment packet digest');
  }
  if (value.resultDigest !== scopeContractDigest(value.result)) {
    errors.push('$ resultDigest must equal the canonical assessment result digest');
  }
  const expectedPhase = BOUNDARY_PHASE[value.cadence.boundary];
  if (value.packet.binding.phase !== expectedPhase) {
    errors.push(`$ cadence boundary ${value.cadence.boundary} requires packet phase ${expectedPhase}`);
  }
  return [...new Set(errors)].sort();
}

const TASK_IDENTITY_FIELDS = Object.freeze([
  'taskId',
  'binding',
  'packetDigest',
  'resultDigest',
  'provenanceDigest',
  'terminalStatus',
  'integratedCommit',
  'integrationReceiptDigest',
]);

export function taskSetIdentity(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('task set must be a nonempty array');
  }
  const identities = tasks.map((task, index) => {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) {
      throw new TypeError(`task set entry ${index} must be an object`);
    }
    const missing = TASK_IDENTITY_FIELDS.filter((field) => !Object.hasOwn(task, field));
    if (missing.length > 0) {
      throw new TypeError(`task set entry ${index} lacks ${missing.join(', ')}`);
    }
    return Object.fromEntries(TASK_IDENTITY_FIELDS.map((field) => [field, task[field]]));
  });
  if (duplicates(identities.map(({ taskId }) => taskId)).length > 0) {
    throw new TypeError('task set contains duplicate task IDs');
  }
  return identities;
}

export function taskSetDigest(tasks) {
  return scopeContractDigest(taskSetIdentity(tasks));
}

export function scopeEvidenceIsCurrent(evidence, expected) {
  if (validateScopeEvidence(evidence).length > 0) return false;
  return [
    ['sourceDigest', evidence.packet.binding.source.digest],
    ['planDigest', evidence.packet.binding.planDigest],
    ['amendmentDigests', evidence.packet.binding.amendmentDigests],
    ['decisionDigests', evidence.packet.binding.decisionDigests ?? []],
    ['taskPacketDigest', evidence.packet.binding.taskPacketDigest],
    ['subjectDigest', evidence.packet.binding.subject.digest],
    ['subjectSha', evidence.packet.binding.subject.sha],
    ['closureDigest', evidence.closureDigest],
  ].every(([field, actual]) => digestJson(actual) === digestJson(
    field === 'decisionDigests' ? expected[field] ?? [] : expected[field],
  ));
}
