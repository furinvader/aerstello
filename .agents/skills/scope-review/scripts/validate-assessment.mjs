import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';

export const ASSESSMENT_PACKET_LIMIT_BYTES = 64 * 1024;
export const SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES = 32 * 1024;

const CODE_PHASES = new Set(['task', 'integrated-head', 'review-finding']);
const MATERIAL_INVENTORY_FIELDS = [
  'dependencies',
  'publicSurfaces',
  'persistentSurfaces',
  'subsystems',
];
const MATERIAL_INVENTORY_CATEGORIES = new Map([
  ['dependencies', 'new-dependency'],
  ['publicSurfaces', 'public-surface'],
  ['persistentSurfaces', 'persistent-surface'],
  ['subsystems', 'new-subsystem'],
]);
const AFFIRMATIVE_CLASSIFICATIONS = new Set(['required', 'implementation-choice']);

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

function overlappingAcceptedShapes(acceptedScope) {
  const shapeSet = (field) => new Set(
    Array.isArray(acceptedScope?.[field]) ? acceptedScope[field] : [],
  );
  const shapes = [
    ['authorizedShape', shapeSet('authorizedShape')],
    ['unauthorizedShape', shapeSet('unauthorizedShape')],
    ['deferredShape', shapeSet('deferredShape')],
  ];
  const errors = [];
  for (let left = 0; left < shapes.length; left += 1) {
    const [leftField, leftShapes] = shapes[left];
    for (let right = left + 1; right < shapes.length; right += 1) {
      const [rightField, rightShapes] = shapes[right];
      for (const shape of leftShapes) {
        if (rightShapes.has(shape)) {
          errors.push(
            `$ acceptedScope.${leftField} overlaps acceptedScope.${rightField} at ${JSON.stringify(shape)}`,
          );
        }
      }
    }
  }
  return errors;
}

function materialInventoryCorrespondence(packet, result) {
  const mappings = new Map(
    packet.changeInventory.mappings.map((entry) => [entry.mechanism, entry]),
  );
  const coverage = new Map(result.coverage.map((entry) => [entry.mechanism, entry]));
  const authorizedShape = new Set(packet.acceptedScope?.authorizedShape ?? []);
  const materialSurfaces = new Set(result.scopeDelta?.materialSurfaces ?? []);
  const materialityTriggers = new Set(
    result.materialityTriggers.map(({ category }) => category),
  );
  const errors = [];
  for (const field of MATERIAL_INVENTORY_FIELDS) {
    for (const surface of packet.changeInventory[field]) {
      const mapping = mappings.get(surface);
      const missingAuthorities = [];
      if (!mapping || mapping.sourceCriterionIds.length === 0) {
        missingAuthorities.push('explicit authoritative-source support');
      }
      if (!authorizedShape.has(surface)) {
        missingAuthorities.push('accepted-scope authorization');
      }
      if (missingAuthorities.length > 0) {
        const category = MATERIAL_INVENTORY_CATEGORIES.get(field);
        const surfaceCoverage = coverage.get(surface);
        const hasRequiredDisposition = (
          result.verdict === 'human-decision-required'
          && surfaceCoverage?.classification === 'material-scope-change'
          && materialSurfaces.has(category)
          && materialityTriggers.has(category)
        );
        if (!hasRequiredDisposition) {
          errors.push(
            `$ changeInventory.${field} material surface ${JSON.stringify(surface)} lacks ${missingAuthorities.join(' and ')} and requires human-decision-required material-scope-change coverage with category ${category}`,
          );
        }
      }
    }
  }
  return errors;
}

function positiveCoverageAuthority(coverage) {
  if (!Array.isArray(coverage)) return [];
  const errors = [];
  for (const [index, entry] of coverage.entries()) {
    if (!entry || !AFFIRMATIVE_CLASSIFICATIONS.has(entry.classification)) continue;
    const hasPositiveAuthority = [
      entry.sourceCriterionIds,
      entry.acceptedCriterionIds,
      entry.invariantIds,
    ].some((ids) => Array.isArray(ids) && ids.length > 0);
    if (!hasPositiveAuthority) {
      errors.push(
        `$ coverage[${index}] ${entry.classification} classification lacks positive source, accepted-criterion, or invariant authority`,
      );
    }
  }
  return errors;
}

function exactSemanticSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && new Set(expected).size === expected.length
    && actual.every((entry) => expected.includes(entry));
}

function resultCorrespondence(result) {
  const errors = [...positiveCoverageAuthority(result?.coverage)];
  if (result?.verdict === 'trim-required') {
    const speculativeMechanisms = (Array.isArray(result.coverage) ? result.coverage : [])
      .filter((entry) => entry?.classification === 'speculative')
      .map((entry) => entry.mechanism);
    if (!exactSemanticSet(result.unnecessaryWork, speculativeMechanisms)) {
      errors.push('$ trim-required unnecessaryWork must exactly match speculative coverage mechanisms');
    }
  }
  if (result?.verdict === 'human-decision-required') {
    const triggerCategories = (Array.isArray(result.materialityTriggers)
      ? result.materialityTriggers
      : [])
      .map((entry) => entry?.category)
      .filter((category) => typeof category === 'string');
    const materialSurfaces = Array.isArray(result.scopeDelta?.materialSurfaces)
      ? result.scopeDelta.materialSurfaces
      : [];
    if (!exactSemanticSet(triggerCategories, materialSurfaces)) {
      errors.push('$ human-decision-required materialityTriggers categories must exactly match scopeDelta.materialSurfaces');
    }
  }
  return errors;
}

function acceptedShapeCorrespondence(packet, result) {
  if (!packet.acceptedScope) return [];
  const unauthorized = new Set(packet.acceptedScope.unauthorizedShape);
  const deferred = new Set(packet.acceptedScope.deferredShape);
  const errors = [];
  for (const entry of result.coverage) {
    if (!AFFIRMATIVE_CLASSIFICATIONS.has(entry.classification)) continue;
    if (unauthorized.has(entry.mechanism)) {
      errors.push(
        `$ coverage mechanism ${JSON.stringify(entry.mechanism)} is ${entry.classification} despite acceptedScope.unauthorizedShape`,
      );
    }
    if (deferred.has(entry.mechanism)) {
      errors.push(
        `$ coverage mechanism ${JSON.stringify(entry.mechanism)} is ${entry.classification} despite acceptedScope.deferredShape`,
      );
    }
  }
  return errors;
}

function requiresMissingArtifactVerdict(packet) {
  return CODE_PHASES.has(packet.binding.phase)
    && (packet.binding.planDigest === null || packet.binding.taskPacketDigest === null);
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
  errors.push(...overlappingAcceptedShapes(packet?.acceptedScope));

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
  errors.push(...resultCorrespondence(result));
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

  const missingCodeArtifact = requiresMissingArtifactVerdict(packet);
  if (missingCodeArtifact && result.verdict !== 'insufficient-evidence') {
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
  errors.push(...acceptedShapeCorrespondence(packet, result));
  if (!(missingCodeArtifact && result.verdict === 'insufficient-evidence')) {
    errors.push(...materialInventoryCorrespondence(packet, result));
  }
  return normalize(errors);
}
