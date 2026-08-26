import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';

export const ASSESSMENT_PACKET_LIMIT_BYTES = 64 * 1024;
export const SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES = 32 * 1024;

const CODE_PHASES = new Set(['task', 'integrated-head', 'review-finding']);

const schema = JSON.parse(readFileSync(
  new URL('../schemas/scope-assessment.schema.json', import.meta.url),
  'utf8',
));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validatePacketSchema = ajv.compile({ $ref: `${schema.$id}#/$defs/assessmentPacket` });
const validateResultSchema = ajv.getSchema(schema.$id);

function normalize(errors) {
  return [...new Set(errors)].sort();
}

function schemaErrors(validator) {
  return (validator.errors ?? []).map(({ instancePath, keyword, message }) => (
    `${instancePath || '$'} ${keyword}: ${message}`
  ));
}

function serializedBytes(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { error: `$ ${label} is not JSON-serializable` };
    return { bytes: Buffer.byteLength(serialized, 'utf8') };
  } catch {
    return { error: `$ ${label} is not JSON-serializable` };
  }
}

function repeatedIds(entries, label) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (entry && typeof entry.id === 'string') {
      if (seen.has(entry.id)) duplicates.add(entry.id);
      seen.add(entry.id);
    }
  }
  return [...duplicates].map((id) => `$ ${label} contains duplicate id ${id}`);
}

function repeatedMechanisms(entries, label) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (entry && typeof entry.mechanism === 'string') {
      if (seen.has(entry.mechanism)) duplicates.add(entry.mechanism);
      seen.add(entry.mechanism);
    }
  }
  return [...duplicates].map((mechanism) => `$ ${label} contains duplicate mechanism ${mechanism}`);
}

function idsFrom(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (entry && typeof entry.id === 'string' ? entry.id : null))
    .filter((id) => id !== null);
}

function unknownReferences(
  entries,
  sourceCriteria,
  acceptedCriteria,
  invariants,
  nonGoals,
  guidance,
  label,
) {
  if (!Array.isArray(entries)) return [];
  const errors = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    for (const id of Array.isArray(entry.sourceCriterionIds) ? entry.sourceCriterionIds : []) {
      if (!sourceCriteria.has(id)) {
        errors.push(`$ ${label}[${index}] references unknown source criterion ${id}`);
      }
    }
    for (const id of Array.isArray(entry.acceptedCriterionIds) ? entry.acceptedCriterionIds : []) {
      if (!acceptedCriteria.has(id)) {
        errors.push(`$ ${label}[${index}] references unknown accepted criterion ${id}`);
      }
    }
    for (const id of Array.isArray(entry.invariantIds) ? entry.invariantIds : []) {
      if (!invariants.has(id)) errors.push(`$ ${label}[${index}] references unknown invariant ${id}`);
    }
    for (const id of Array.isArray(entry.nonGoalIds) ? entry.nonGoalIds : []) {
      if (!nonGoals.has(id)) errors.push(`$ ${label}[${index}] references unknown non-goal ${id}`);
    }
    for (const id of Array.isArray(entry.guidanceIds) ? entry.guidanceIds : []) {
      if (!guidance.has(id)) errors.push(`$ ${label}[${index}] references unknown guidance ${id}`);
    }
  }
  return errors;
}

export function validateAssessmentPacket(packet) {
  const errors = [];
  const serialized = serializedBytes(packet, 'assessment packet');
  if (serialized.error) errors.push(serialized.error);
  else if (serialized.bytes > ASSESSMENT_PACKET_LIMIT_BYTES) {
    errors.push(`$ assessment packet exceeds ${ASSESSMENT_PACKET_LIMIT_BYTES} bytes`);
  }

  if (!validatePacketSchema(packet)) errors.push(...schemaErrors(validatePacketSchema));

  errors.push(...repeatedIds(packet?.sourceScope?.requiredCriteria, 'sourceScope.requiredCriteria'));
  errors.push(...repeatedIds(packet?.sourceScope?.nonGoals, 'sourceScope.nonGoals'));
  errors.push(...repeatedIds(packet?.sourceScope?.implementationGuidance, 'sourceScope.implementationGuidance'));
  errors.push(...repeatedIds(packet?.acceptedScope?.criteria, 'acceptedScope.criteria'));
  errors.push(...repeatedIds(packet?.acceptedScope?.invariants, 'acceptedScope.invariants'));
  errors.push(...repeatedIds(packet?.tripwires, 'tripwires'));
  errors.push(...repeatedMechanisms(packet?.changeInventory?.mappings, 'changeInventory.mappings'));

  const sourceCriteria = new Set(idsFrom(packet?.sourceScope?.requiredCriteria));
  const acceptedCriteria = new Set(idsFrom(packet?.acceptedScope?.criteria));
  const invariants = new Set(idsFrom(packet?.acceptedScope?.invariants));
  const nonGoals = new Set(idsFrom(packet?.sourceScope?.nonGoals));
  const guidance = new Set(idsFrom(packet?.sourceScope?.implementationGuidance));
  errors.push(...unknownReferences(
    packet?.changeInventory?.mappings,
    sourceCriteria,
    acceptedCriteria,
    invariants,
    nonGoals,
    guidance,
    'changeInventory.mappings',
  ));
  return normalize(errors);
}

export function validateScopeAssessmentResult(result) {
  const errors = [];
  const serialized = serializedBytes(result, 'scope assessment result');
  if (serialized.error) errors.push(serialized.error);
  else if (serialized.bytes > SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) {
    errors.push(`$ scope assessment result exceeds ${SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES} bytes`);
  }

  if (!validateResultSchema(result)) errors.push(...schemaErrors(validateResultSchema));
  errors.push(...repeatedMechanisms(result?.coverage, 'coverage'));
  return normalize(errors);
}

export function validateScopeAssessmentApplicability(packet, result) {
  const packetErrors = validateAssessmentPacket(packet).map((error) => `packet: ${error}`);
  const resultErrors = validateScopeAssessmentResult(result).map((error) => `result: ${error}`);
  const errors = [...packetErrors, ...resultErrors];
  if (packetErrors.length > 0 || resultErrors.length > 0) return normalize(errors);

  if (!isDeepStrictEqual(packet.binding, result.binding)) {
    errors.push('$ result binding does not exactly match assessment packet binding');
  }

  if (
    CODE_PHASES.has(packet.binding.phase)
    && (packet.binding.planDigest === null || packet.binding.taskPacketDigest === null)
    && result.verdict !== 'insufficient-evidence'
  ) {
    errors.push('$ code-phase assessment with an absent plan or task-packet identity requires insufficient-evidence');
  }

  const sourceCriteria = new Set(packet.sourceScope.requiredCriteria.map(({ id }) => id));
  const acceptedCriteria = new Set((packet.acceptedScope?.criteria ?? []).map(({ id }) => id));
  const invariants = new Set((packet.acceptedScope?.invariants ?? []).map(({ id }) => id));
  const nonGoals = new Set(packet.sourceScope.nonGoals.map(({ id }) => id));
  const guidance = new Set(packet.sourceScope.implementationGuidance.map(({ id }) => id));
  errors.push(...unknownReferences(
    result.coverage,
    sourceCriteria,
    acceptedCriteria,
    invariants,
    nonGoals,
    guidance,
    'coverage',
  ));
  if (result.scopeDelta) {
    errors.push(...unknownReferences(
      [result.scopeDelta],
      sourceCriteria,
      acceptedCriteria,
      invariants,
      nonGoals,
      guidance,
      'scopeDelta',
    ));
  }

  const inventoryMechanisms = packet.changeInventory.mappings.map(({ mechanism }) => mechanism).sort();
  const coverageMechanisms = result.coverage.map(({ mechanism }) => mechanism).sort();
  if (JSON.stringify(inventoryMechanisms) !== JSON.stringify(coverageMechanisms)) {
    errors.push('$ result coverage does not exactly match packet inventory mechanisms');
  }
  return normalize(errors);
}
