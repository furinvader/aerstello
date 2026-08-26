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
const MATERIALITY_CATEGORIES = [
  'new-subsystem',
  'new-dependency',
  'public-surface',
  'persistent-surface',
  'cross-capability-work',
  'policy-change',
  'repository-wide-enforcement',
  'independent-workstream',
  'new-criterion',
  'non-goal-reversal',
  'sensitive-policy',
  'replaces-accepted-approach',
  'repeated-expansion',
];
const AFFIRMATIVE_CLASSIFICATIONS = new Set(['required', 'implementation-choice']);
const RESULT_REPRESENTABILITY = Symbol('scope-result-representability');
const AUTHORITY_FIELDS = [
  'sourceCriterionIds',
  'acceptedCriterionIds',
  'invariantIds',
  'nonGoalIds',
  'guidanceIds',
];
const POSITIVE_AUTHORITY_FIELDS = AUTHORITY_FIELDS.slice(0, 3);

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

function unmappedMaterialInventory(packet) {
  const mappedMechanisms = new Set(packet.changeInventory.mappings.map(({ mechanism }) => mechanism));
  const errors = [];
  for (const field of MATERIAL_INVENTORY_FIELDS) {
    for (const entry of packet.changeInventory[field]) {
      if (!mappedMechanisms.has(entry)) {
        errors.push(
          `$ changeInventory.${field} entry ${JSON.stringify(entry)} requires exactly one changeInventory.mappings row`,
        );
      }
    }
  }
  return errors;
}

function shortestMappedAuthority(mapping, allowedFields = POSITIVE_AUTHORITY_FIELDS) {
  let shortest = null;
  let shortestBytes = Number.POSITIVE_INFINITY;
  for (const field of allowedFields) {
    for (const id of mapping[field]) {
      const bytes = Buffer.byteLength(JSON.stringify(id), 'utf8');
      if (
        bytes < shortestBytes
        || (
          bytes === shortestBytes
          && shortest
          && (field.localeCompare(shortest.field) < 0
            || (field === shortest.field && id.localeCompare(shortest.id) < 0))
        )
      ) {
        shortest = { field, id };
        shortestBytes = bytes;
      }
    }
  }
  return shortest;
}

function minimalCoverage(mechanism, classification, authority = null) {
  const coverage = {
    mechanism,
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    classification,
    rationale: 'x',
  };
  if (authority) coverage[authority.field] = [authority.id];
  return coverage;
}

function materialInventoryState(packet) {
  const materialMechanisms = new Set();
  const forcedMechanisms = new Set();
  const forcedCategories = new Set();
  const mappings = new Map(
    packet.changeInventory.mappings.map((entry) => [entry.mechanism, entry]),
  );
  const authorizedShape = new Set(packet.acceptedScope?.authorizedShape ?? []);
  for (const field of MATERIAL_INVENTORY_FIELDS) {
    for (const mechanism of packet.changeInventory[field]) {
      materialMechanisms.add(mechanism);
      const mapping = mappings.get(mechanism);
      if (!mapping || mapping.sourceCriterionIds.length === 0 || !authorizedShape.has(mechanism)) {
        forcedMechanisms.add(mechanism);
        forcedCategories.add(MATERIAL_INVENTORY_CATEGORIES.get(field));
      }
    }
  }
  return { materialMechanisms, forcedMechanisms, forcedCategories };
}

function affirmativeCoverage(mapping, rejectedShape) {
  if (rejectedShape.has(mapping.mechanism)) return null;
  const authority = shortestMappedAuthority(mapping);
  return authority ? minimalCoverage(mapping.mechanism, 'required', authority) : null;
}

function baseMinimalResult(packet, verdict, coverage) {
  return {
    schemaVersion: 1,
    binding: packet.binding,
    verdict,
    summary: 'x',
    coverage,
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

function buildGroundedResult(packet, verdict, coverage, necessary, materialCategories = []) {
  const groundedCoverage = coverage.map((entry, index) => {
    const authority = necessary.get(index);
    return authority
      ? minimalCoverage(entry.mechanism, 'necessary-minor-expansion', authority)
      : entry;
  });
  const deltaFields = new Map(POSITIVE_AUTHORITY_FIELDS.map((field) => [field, new Set()]));
  for (const authority of necessary.values()) deltaFields.get(authority.field).add(authority.id);
  const result = baseMinimalResult(packet, verdict, groundedCoverage);
  result.scopeDelta = {
    description: 'x',
    sourceCriterionIds: [...deltaFields.get('sourceCriterionIds')],
    acceptedCriterionIds: [...deltaFields.get('acceptedCriterionIds')],
    invariantIds: [...deltaFields.get('invariantIds')],
    materialSurfaces: materialCategories,
  };
  if (verdict === 'minor-amendment-required') {
    result.unnecessaryWork = groundedCoverage
      .filter(({ classification }) => classification === 'speculative')
      .map(({ mechanism }) => mechanism);
    if (result.unnecessaryWork.length > 0) result.smallerSufficientAlternative = 'x';
  } else {
    result.materialityTriggers = materialCategories.map((category) => ({
      category,
      evidence: 'x',
    }));
    result.smallestExpansion = 'x';
    result.narrowAlternative = 'x';
    result.deferralConsequences = 'x';
    result.humanDecision = true;
  }
  return result;
}

function minorAuthorityOptions(mapping) {
  return POSITIVE_AUTHORITY_FIELDS.flatMap((field) => mapping[field].map((id) => ({
    field,
    id,
    key: `${field}\u0000${id}`,
    serializedIdBytes: Buffer.byteLength(JSON.stringify(id), 'utf8'),
  })));
}

function isSourceOrAccepted({ field }) {
  return field === 'sourceCriterionIds' || field === 'acceptedCriterionIds';
}

function ensureMinorSourceAuthority(rows, assignments) {
  if ([...assignments.values()].some(isSourceOrAccepted)) return assignments;
  let best = null;
  for (const row of rows) {
    for (const option of row.options.filter(isSourceOrAccepted)) {
      const candidate = new Map(assignments).set(row.index, option);
      const cost = minorVariableCost(candidate);
      if (!best || cost < best.cost || (cost === best.cost && option.key < best.option.key)) {
        best = { assignments: candidate, cost, option };
      }
    }
  }
  return best?.assignments ?? null;
}

function minorVariableCost(assignments) {
  let cost = 0;
  const openedByField = new Map(POSITIVE_AUTHORITY_FIELDS.map((field) => [field, new Map()]));
  for (const option of assignments.values()) {
    cost += option.serializedIdBytes;
    openedByField.get(option.field).set(option.key, option);
  }
  for (const opened of openedByField.values()) {
    const authorities = [...opened.values()];
    cost += authorities.reduce((sum, option) => sum + option.serializedIdBytes, 0);
    cost += Math.max(authorities.length - 1, 0);
  }
  return cost;
}

function initialMinorAssignments(rows, requireSourceOrAccepted) {
  const assignments = new Map();
  for (const row of rows) {
    const options = [...row.options].sort((left, right) => (
      left.serializedIdBytes - right.serializedIdBytes
      || left.field.localeCompare(right.field)
      || left.id.localeCompare(right.id)
    ));
    assignments.set(row.index, options[0]);
  }
  return requireSourceOrAccepted ? ensureMinorSourceAuthority(rows, assignments) : assignments;
}

function minorProjectionChoices(packet, mapping, materialMechanisms, rejectedShape, authorityMode) {
  const choices = [];
  const affirmative = affirmativeCoverage(mapping, rejectedShape);
  if (affirmative) choices.push({ kind: 'affirmative', coverage: affirmative });
  if (
    !materialMechanisms.has(mapping.mechanism)
    && (!affirmative || rejectedShape.has(mapping.mechanism))
  ) {
    choices.push({
      kind: 'speculative',
      coverage: minimalCoverage(mapping.mechanism, 'speculative'),
    });
  }
  for (const authority of minorAuthorityOptions(mapping)) {
    if (authorityMode === 'invariant-only' && authority.field !== 'invariantIds') continue;
    choices.push({
      kind: 'necessary',
      authority,
      coverage: minimalCoverage(mapping.mechanism, 'necessary-minor-expansion', authority),
    });
  }
  return choices;
}

function buildMinorProjection(packet, choices) {
  const assignments = new Map();
  const coverage = choices.map((choice, index) => {
    if (choice.kind === 'necessary') assignments.set(index, choice.authority);
    return choice.coverage;
  });
  return buildGroundedResult(packet, 'minor-amendment-required', coverage, assignments);
}

function betterMinorProjection(best, candidate) {
  if (!candidate) return best;
  const bytes = serializedBytes(candidate, 'scope assessment result').bytes;
  if (!best || bytes < best.bytes) return { result: candidate, bytes };
  return best;
}

function exactUniqueIncidenceMinorProjection(
  packet,
  materialMechanisms,
  rejectedShape,
  authorityMode,
) {
  const rows = packet.changeInventory.mappings.map((mapping) => ({
    mapping,
    choices: minorProjectionChoices(
      packet,
      mapping,
      materialMechanisms,
      rejectedShape,
      authorityMode,
    ).filter((choice, index, choices) => (
      choice.kind !== 'necessary'
      || choices.findIndex((candidate) => (
        candidate.kind === 'necessary'
        && candidate.authority.field === choice.authority.field
        && (
          candidate.authority.serializedIdBytes < choice.authority.serializedIdBytes
          || (
            candidate.authority.serializedIdBytes === choice.authority.serializedIdBytes
            && candidate.authority.key.localeCompare(choice.authority.key) <= 0
          )
        )
      )) === index
    )),
  }));
  if (rows.some(({ choices }) => choices.length === 0)) return null;
  const coverageCommas = Math.max(rows.length - 1, 0);
  let states = new Map([['0:0:0:0', {
    usedFields: 0,
    hasSourceOrAccepted: false,
    hasNecessary: false,
    hasSpeculative: false,
    variableBytes: 0,
    choices: [],
  }]]);
  for (const row of rows) {
    const nextStates = new Map();
    for (const state of states.values()) {
      for (const choice of row.choices) {
        let usedFields = state.usedFields;
        let hasSourceOrAccepted = state.hasSourceOrAccepted;
        let hasNecessary = state.hasNecessary;
        let hasSpeculative = state.hasSpeculative;
        let increment = serializedBytes(choice.coverage, 'coverage').bytes;
        if (choice.kind === 'speculative') {
          increment += Buffer.byteLength(JSON.stringify(row.mapping.mechanism), 'utf8');
          if (hasSpeculative) increment += 1;
          hasSpeculative = true;
        } else if (choice.kind === 'necessary') {
          const fieldIndex = POSITIVE_AUTHORITY_FIELDS.indexOf(choice.authority.field);
          const fieldBit = 1 << fieldIndex;
          increment += choice.authority.serializedIdBytes;
          if ((usedFields & fieldBit) !== 0) increment += 1;
          usedFields |= fieldBit;
          hasNecessary = true;
          hasSourceOrAccepted ||= isSourceOrAccepted(choice.authority);
        }
        const key = `${usedFields}:${hasSourceOrAccepted ? 1 : 0}:${hasNecessary ? 1 : 0}:${hasSpeculative ? 1 : 0}`;
        const candidate = {
          usedFields,
          hasSourceOrAccepted,
          hasNecessary,
          hasSpeculative,
          variableBytes: state.variableBytes + increment,
        };
        const current = nextStates.get(key);
        if (!current || candidate.variableBytes < current.variableBytes) {
          nextStates.set(key, {
            ...candidate,
            choices: [...state.choices, choice],
          });
        }
      }
    }
    states = nextStates;
  }
  const exact = [...states.values()].filter((state) => (
    state.hasNecessary
    && (authorityMode !== 'source-or-accepted' || state.hasSourceOrAccepted)
  )).sort((left, right) => {
    const leftBytes = left.variableBytes + Buffer.byteLength(
      JSON.stringify(left.hasSpeculative ? 'x' : null),
      'utf8',
    );
    const rightBytes = right.variableBytes + Buffer.byteLength(
      JSON.stringify(right.hasSpeculative ? 'x' : null),
      'utf8',
    );
    return leftBytes - rightBytes;
  })[0];
  if (!exact) return null;
  const result = buildMinorProjection(packet, exact.choices);
  const projectedVariableBytes = coverageCommas + exact.variableBytes
    + Buffer.byteLength(JSON.stringify(exact.hasSpeculative ? 'x' : null), 'utf8');
  const actualVariableBytes = result.coverage.reduce(
    (sum, entry) => sum + serializedBytes(entry, 'coverage').bytes,
    Math.max(result.coverage.length - 1, 0),
  ) + result.unnecessaryWork.reduce(
    (sum, mechanism) => sum + Buffer.byteLength(JSON.stringify(mechanism), 'utf8'),
    Math.max(result.unnecessaryWork.length - 1, 0),
  ) + POSITIVE_AUTHORITY_FIELDS.reduce((sum, field) => (
    sum + result.scopeDelta[field].reduce(
      (fieldSum, id) => fieldSum + Buffer.byteLength(JSON.stringify(id), 'utf8'),
      Math.max(result.scopeDelta[field].length - 1, 0),
    )
  ), 0) + Buffer.byteLength(JSON.stringify(result.smallerSufficientAlternative), 'utf8');
  if (projectedVariableBytes !== actualVariableBytes) {
    throw new Error('internal minor projection byte ordering mismatch');
  }
  const exactBytes = serializedBytes(result, 'scope assessment result').bytes;
  return { result, bytes: exactBytes };
}

function relaxedMinorProjectionLowerBound(
  packet,
  materialMechanisms,
  rejectedShape,
  authorityMode,
) {
  const rows = packet.changeInventory.mappings.map((mapping) => minorProjectionChoices(
    packet,
    mapping,
    materialMechanisms,
    rejectedShape,
    authorityMode,
  ));
  if (rows.some((choices) => choices.length === 0)) return Number.POSITIVE_INFINITY;
  const hasEligibleAnchor = rows.some((choices) => choices.some((choice) => (
    choice.kind === 'necessary'
    && (authorityMode !== 'source-or-accepted' || isSourceOrAccepted(choice.authority))
  )));
  if (!hasEligibleAnchor) return Number.POSITIVE_INFINITY;
  const empty = buildGroundedResult(packet, 'minor-amendment-required', [], new Map());
  const fixedWithoutAlternative = serializedBytes(empty, 'scope assessment result').bytes
    - Buffer.byteLength(JSON.stringify(null), 'utf8');
  const rowBytes = rows.reduce((sum, choices, index) => sum + Math.min(...choices.map((choice) => {
    let bytes = serializedBytes(choice.coverage, 'coverage').bytes;
    if (choice.kind === 'speculative') {
      bytes += Buffer.byteLength(
        JSON.stringify(packet.changeInventory.mappings[index].mechanism),
        'utf8',
      );
    }
    return bytes;
  })), 0);
  return fixedWithoutAlternative
    + Math.max(rows.length - 1, 0)
    + rowBytes
    + Buffer.byteLength(JSON.stringify('x'), 'utf8');
}

function sharedAuthorityMinorProjection(
  packet,
  materialMechanisms,
  rejectedShape,
  authorityMode,
) {
  const rows = packet.changeInventory.mappings.map((mapping) => ({
    mapping,
    choices: minorProjectionChoices(
      packet,
      mapping,
      materialMechanisms,
      rejectedShape,
      authorityMode,
    ),
  }));
  if (rows.some(({ choices }) => choices.length === 0)) return null;
  let best = null;
  const anchorCandidates = [];
  for (const [anchorIndex, row] of rows.entries()) {
    const anchors = row.choices.filter((choice) => (
      choice.kind === 'necessary'
      && (authorityMode !== 'source-or-accepted' || isSourceOrAccepted(choice.authority))
    )).sort((left, right) => (
      left.authority.serializedIdBytes - right.authority.serializedIdBytes
      || left.authority.key.localeCompare(right.authority.key)
    )).slice(0, 1);
    for (const anchor of anchors) {
      const ordinary = row.choices.filter(({ kind }) => kind !== 'necessary');
      const ordinaryBytes = ordinary.length === 0 ? 0 : Math.min(...ordinary.map((choice) => (
        serializedBytes(choice.coverage, 'coverage').bytes
        + (choice.kind === 'speculative'
          ? Buffer.byteLength(JSON.stringify(row.mapping.mechanism), 'utf8') + 1
          : 0)
      )));
      anchorCandidates.push({
        anchor,
        anchorIndex,
        incrementalBytes: serializedBytes(anchor.coverage, 'coverage').bytes
          + anchor.authority.serializedIdBytes
          - ordinaryBytes,
      });
    }
  }
  anchorCandidates.sort((left, right) => (
    left.incrementalBytes - right.incrementalBytes
    || left.anchorIndex - right.anchorIndex
    || left.anchor.authority.key.localeCompare(right.anchor.authority.key)
  ));
  let thresholdEvaluations = 0;
  for (const { anchor, anchorIndex } of anchorCandidates.slice(0, 64)) {
    let choices = rows.map(({ mapping, choices: rowChoices }, index) => {
      if (index === anchorIndex) return anchor;
      const ordinary = rowChoices.filter(({ kind }) => kind !== 'necessary');
      const pool = ordinary.length > 0 ? ordinary : rowChoices;
      return [...pool].sort((left, right) => {
        const cost = (choice) => serializedBytes(choice.coverage, 'coverage').bytes
          + (choice.kind === 'speculative'
            ? Buffer.byteLength(JSON.stringify(mapping.mechanism), 'utf8') + 1
            : 0);
        return cost(left) - cost(right)
          || left.kind.localeCompare(right.kind)
          || (left.authority?.key ?? '').localeCompare(right.authority?.key ?? '');
      })[0];
    });
    let candidate = betterMinorProjection(null, buildMinorProjection(packet, choices));
    for (let pass = 0; pass < 2 && thresholdEvaluations < 4096; pass += 1) {
      let improved = false;
      for (const [index, row] of rows.entries()) {
        if (choices[index].kind === 'necessary') continue;
        const alternatives = row.choices.filter(({ kind }) => kind === 'necessary')
          .sort((left, right) => (
            left.authority.serializedIdBytes - right.authority.serializedIdBytes
            || left.authority.key.localeCompare(right.authority.key)
          )).slice(0, 3);
        for (const alternative of alternatives) {
          thresholdEvaluations += 1;
          const alternativeChoices = [...choices];
          alternativeChoices[index] = alternative;
          const alternativeResult = betterMinorProjection(
            null,
            buildMinorProjection(packet, alternativeChoices),
          );
          if (alternativeResult.bytes < candidate.bytes) {
            candidate = alternativeResult;
            choices = alternativeChoices;
            improved = true;
          }
          if (thresholdEvaluations >= 4096) break;
        }
        if (thresholdEvaluations >= 4096) break;
      }
      if (!improved) break;
    }
    best = betterMinorProjection(best, candidate.result);
    if (best.bytes <= SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) return best;
    if (thresholdEvaluations >= 4096) break;
  }
  const necessaryRows = rows.map(({ mapping, choices }, index) => ({
    index,
    mechanism: mapping.mechanism,
    options: choices.filter(({ kind }) => kind === 'necessary').map(({ authority }) => authority),
  }));
  if (necessaryRows.every(({ options }) => options.length > 0)) {
    const assignments = initialMinorAssignments(
      necessaryRows,
      authorityMode === 'source-or-accepted',
    );
    if (assignments) {
      const choices = necessaryRows.map(({ index }) => ({
        kind: 'necessary',
        authority: assignments.get(index),
        coverage: minimalCoverage(
          packet.changeInventory.mappings[index].mechanism,
          'necessary-minor-expansion',
          assignments.get(index),
        ),
      }));
      best = betterMinorProjection(best, buildMinorProjection(packet, choices));
    }
  }
  return best;
}

function minimalMinorProjection(packet, materialMechanisms, rejectedShape) {
  const authorityIncidence = new Map();
  for (const mapping of packet.changeInventory.mappings) {
    for (const authority of minorAuthorityOptions(mapping)) {
      authorityIncidence.set(authority.key, (authorityIncidence.get(authority.key) ?? 0) + 1);
    }
  }
  const uniqueIncidence = [...authorityIncidence.values()].every((count) => count === 1);
  let best = null;
  let lowerBoundBytes = Number.POSITIVE_INFINITY;
  for (const authorityMode of ['source-or-accepted', 'invariant-only']) {
    if (uniqueIncidence) {
      const exact = exactUniqueIncidenceMinorProjection(
        packet,
        materialMechanisms,
        rejectedShape,
        authorityMode,
      );
      if (exact) best = betterMinorProjection(best, exact.result);
      lowerBoundBytes = Math.min(lowerBoundBytes, exact?.bytes ?? Number.POSITIVE_INFINITY);
    } else {
      const candidate = sharedAuthorityMinorProjection(
        packet,
        materialMechanisms,
        rejectedShape,
        authorityMode,
      );
      if (candidate) best = betterMinorProjection(best, candidate.result);
      lowerBoundBytes = Math.min(
        lowerBoundBytes,
        relaxedMinorProjectionLowerBound(
          packet,
          materialMechanisms,
          rejectedShape,
          authorityMode,
        ),
      );
    }
  }
  if (best && best.bytes > SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) {
    Object.defineProperty(best.result, RESULT_REPRESENTABILITY, {
      configurable: true,
      value: {
        exact: uniqueIncidence && lowerBoundBytes === best.bytes,
        lowerBoundBytes,
        witnessBytes: best.bytes,
      },
    });
  }
  return best?.result ?? null;
}

function minimalResult(packet, verdict) {
  const mappings = packet.changeInventory.mappings;
  const mechanisms = mappings.map(({ mechanism }) => mechanism);
  const { materialMechanisms, forcedMechanisms, forcedCategories } = materialInventoryState(packet);
  const rejectedShape = new Set([
    ...(packet.acceptedScope?.unauthorizedShape ?? []),
    ...(packet.acceptedScope?.deferredShape ?? []),
  ]);
  let coverage;

  if (verdict === 'within-scope') {
    if (forcedMechanisms.size > 0) return null;
    coverage = mappings.map((mapping) => affirmativeCoverage(mapping, rejectedShape));
    if (coverage.some((entry) => entry === null)) return null;
  } else if (verdict === 'trim-required') {
    if (forcedMechanisms.size > 0) return null;
    const choices = mappings.map((mapping) => {
      const affirmative = affirmativeCoverage(mapping, rejectedShape);
      if (materialMechanisms.has(mapping.mechanism)) return { affirmative, speculative: null };
      return {
        affirmative,
        speculative: minimalCoverage(mapping.mechanism, 'speculative'),
      };
    });
    if (choices.some(({ affirmative, speculative }) => !affirmative && !speculative)) return null;
    const speculativeIndexes = new Set(
      choices.flatMap(({ affirmative }, index) => (affirmative ? [] : [index])),
    );
    const optionalSpeculative = choices
      .map(({ affirmative, speculative }, index) => {
        if (!affirmative || !speculative) return null;
        const firstCost = serializedBytes(speculative, 'coverage').bytes
          + serializedBytes(mappings[index].mechanism, 'mechanism').bytes
          - serializedBytes(affirmative, 'coverage').bytes;
        return { firstCost, additionalCost: firstCost + 1, index };
      })
      .filter((entry) => entry !== null);
    for (const { additionalCost, index } of optionalSpeculative) {
      if (additionalCost < 0) speculativeIndexes.add(index);
    }
    if (speculativeIndexes.size === 0) {
      optionalSpeculative.sort((left, right) => (
        left.firstCost - right.firstCost || left.index - right.index
      ));
      if (optionalSpeculative.length === 0) return null;
      speculativeIndexes.add(optionalSpeculative[0].index);
    }
    coverage = choices.map(({ affirmative, speculative }, index) => (
      speculativeIndexes.has(index) ? speculative : affirmative
    ));
  } else if (verdict === 'minor-amendment-required') {
    if (forcedMechanisms.size > 0) return null;
    return minimalMinorProjection(packet, materialMechanisms, rejectedShape);
  } else if (verdict === 'human-decision-required') {
    const categories = forcedCategories.size > 0
      ? [...forcedCategories]
      : [[...MATERIALITY_CATEGORIES].sort((left, right) => {
        const byteDifference = Buffer.byteLength(JSON.stringify(left), 'utf8')
          - Buffer.byteLength(JSON.stringify(right), 'utf8');
        return byteDifference || left.localeCompare(right);
      })[0]];
    const resultForMaterialIndexes = (materialIndexes) => {
      const scenarioCoverage = mappings.map((mapping, index) => {
        if (materialIndexes.has(index)) {
          return minimalCoverage(mapping.mechanism, 'material-scope-change');
        }
        if (materialMechanisms.has(mapping.mechanism)) {
          return affirmativeCoverage(mapping, rejectedShape);
        }
        const speculative = minimalCoverage(mapping.mechanism, 'speculative');
        const affirmative = affirmativeCoverage(mapping, rejectedShape);
        if (!affirmative) return speculative;
        return serializedBytes(affirmative, 'coverage').bytes <= serializedBytes(speculative, 'coverage').bytes
          ? affirmative
          : speculative;
      });
      if (scenarioCoverage.some((entry) => entry === null)) return null;
      const buildHumanResult = (groundedCoverage, assignments) => buildGroundedResult(
        packet,
        'human-decision-required',
        groundedCoverage,
        assignments,
        categories,
      );
      return buildHumanResult(scenarioCoverage, new Map());
    };

    if (forcedMechanisms.size > 0) {
      const materialIndexes = new Set();
      mappings.forEach(({ mechanism }, index) => {
        if (forcedMechanisms.has(mechanism)) materialIndexes.add(index);
      });
      return resultForMaterialIndexes(materialIndexes);
    }

    let bestResult = null;
    let bestBytes = Number.POSITIVE_INFINITY;
    let globalLowerBoundBytes = Number.POSITIVE_INFINITY;
    const stableAnchors = [];
    for (const [index, mapping] of mappings.entries()) {
      const material = minimalCoverage(mapping.mechanism, 'material-scope-change');
      let ordinary;
      if (materialMechanisms.has(mapping.mechanism)) {
        ordinary = affirmativeCoverage(mapping, rejectedShape);
      } else {
        const speculative = minimalCoverage(mapping.mechanism, 'speculative');
        const affirmative = affirmativeCoverage(mapping, rejectedShape);
        ordinary = !affirmative
          || serializedBytes(speculative, 'coverage').bytes < serializedBytes(affirmative, 'coverage').bytes
          ? speculative
          : affirmative;
      }
      if (!ordinary) continue;
      stableAnchors.push({
        index,
        incrementalBytes: serializedBytes(material, 'coverage').bytes
          - serializedBytes(ordinary, 'coverage').bytes,
      });
    }
    stableAnchors.sort((left, right) => (
      left.incrementalBytes - right.incrementalBytes || left.index - right.index
    ));
    const anchorIndexes = stableAnchors.slice(0, 1).map(({ index }) => index);
    for (const index of anchorIndexes) {
      const scenarioResult = resultForMaterialIndexes(new Set([index]));
      if (!scenarioResult) continue;
      const bytes = serializedBytes(scenarioResult, 'scope assessment result').bytes;
      const evidence = scenarioResult[RESULT_REPRESENTABILITY] ?? {
        lowerBoundBytes: bytes,
      };
      globalLowerBoundBytes = Math.min(globalLowerBoundBytes, evidence.lowerBoundBytes);
      if (bytes < bestBytes) {
        bestResult = scenarioResult;
        bestBytes = bytes;
      }
    }
    if (!bestResult) return null;
    if (bestBytes > SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) {
      Object.defineProperty(bestResult, RESULT_REPRESENTABILITY, {
        configurable: true,
        value: {
          exact: globalLowerBoundBytes === bestBytes,
          lowerBoundBytes: globalLowerBoundBytes,
          witnessBytes: bestBytes,
        },
      });
    }
    return bestResult;
  } else {
    coverage = mechanisms.map((mechanism) => minimalCoverage(mechanism, 'insufficient-evidence'));
  }

  const result = baseMinimalResult(packet, verdict, coverage);

  if (verdict === 'trim-required') {
    result.unnecessaryWork = coverage
      .filter(({ classification }) => classification === 'speculative')
      .map(({ mechanism }) => mechanism);
    result.smallerSufficientAlternative = 'x';
  } else if (verdict === 'human-decision-required') {
    const categories = forcedCategories.size > 0
      ? [...forcedCategories]
      : [[...MATERIALITY_CATEGORIES].sort((left, right) => {
        const byteDifference = Buffer.byteLength(JSON.stringify(left), 'utf8')
          - Buffer.byteLength(JSON.stringify(right), 'utf8');
        return byteDifference || left.localeCompare(right);
      })[0]];
    result.scopeDelta = {
      description: 'x',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: categories,
    };
    result.materialityTriggers = categories.map((category) => ({
      category,
      evidence: 'x',
    }));
    result.smallestExpansion = 'x';
    result.narrowAlternative = 'x';
    result.deferralConsequences = 'x';
    result.humanDecision = true;
  } else if (verdict === 'insufficient-evidence') {
    result.missingEvidence = ['x'];
  }
  return result;
}

function resultRepresentability(packet) {
  const verdicts = [
    'within-scope',
    'trim-required',
    'minor-amendment-required',
    'human-decision-required',
    'insufficient-evidence',
  ];
  return verdicts.flatMap((verdict) => {
    const result = minimalResult(packet, verdict);
    if (!result) return [];
    const bytes = serializedBytes(result, 'scope assessment result').bytes;
    const evidence = result[RESULT_REPRESENTABILITY] ?? {
      exact: true,
      lowerBoundBytes: bytes,
      witnessBytes: bytes,
    };
    return [{ verdict, ...evidence }];
  });
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
      } else {
        const category = MATERIAL_INVENTORY_CATEGORIES.get(field);
        const surfaceCoverage = coverage.get(surface);
        if (
          surfaceCoverage?.classification === 'material-scope-change'
          && materialSurfaces.has(category)
          && materialityTriggers.has(category)
        ) {
          errors.push(
            `$ changeInventory.${field} material surface ${JSON.stringify(surface)} has exact authoritative-source support and accepted-scope authorization and cannot be relabeled material-scope-change with native category ${category}`,
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
  if (result?.verdict === 'minor-amendment-required') {
    const speculativeMechanisms = (Array.isArray(result.coverage) ? result.coverage : [])
      .filter((entry) => entry?.classification === 'speculative')
      .map((entry) => entry.mechanism);
    if (!exactSemanticSet(result.unnecessaryWork, speculativeMechanisms)) {
      errors.push('$ minor-amendment-required unnecessaryWork must exactly match speculative coverage mechanisms');
    }
    const hasAlternative = typeof result.smallerSufficientAlternative === 'string'
      && result.smallerSufficientAlternative.trim().length > 0;
    if (hasAlternative !== (speculativeMechanisms.length > 0)) {
      errors.push('$ minor-amendment-required smallerSufficientAlternative must be nonempty if and only if speculative coverage exists');
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

function mappingAuthorityCorrespondence(packet, result) {
  const mappings = new Map(
    packet.changeInventory.mappings.map((entry) => [entry.mechanism, entry]),
  );
  const errors = [];
  for (const [index, entry] of result.coverage.entries()) {
    const mapping = mappings.get(entry.mechanism);
    if (!mapping) continue;
    for (const field of AUTHORITY_FIELDS) {
      const mappedIds = new Set(mapping[field]);
      for (const id of entry[field]) {
        if (!mappedIds.has(id)) {
          errors.push(
            `$ coverage[${index}].${field} authority ${JSON.stringify(id)} is not mapped to mechanism ${JSON.stringify(entry.mechanism)} in changeInventory.mappings`,
          );
        }
      }
    }
  }
  return errors;
}

function minorDeltaCorrespondence(packet, result) {
  if (!['minor-amendment-required', 'human-decision-required'].includes(result.verdict)) return [];
  const mappings = new Map(
    packet.changeInventory.mappings.map((entry) => [entry.mechanism, entry]),
  );
  const necessaryRows = result.coverage.filter(
    ({ classification }) => classification === 'necessary-minor-expansion',
  );
  const errors = [];
  for (const entry of necessaryRows) {
    const mapping = mappings.get(entry.mechanism);
    const sharesGroundedAuthority = POSITIVE_AUTHORITY_FIELDS.some((field) => {
      const mappedIds = new Set(mapping?.[field] ?? []);
      const deltaIds = new Set(result.scopeDelta[field]);
      return entry[field].some((id) => mappedIds.has(id) && deltaIds.has(id));
    });
    if (!sharesGroundedAuthority) {
      errors.push(
        `$ necessary-minor-expansion mechanism ${JSON.stringify(entry.mechanism)} must share same-field positive authority with its inventory mapping and scopeDelta`,
      );
    }
  }
  if (result.verdict !== 'minor-amendment-required') return errors;
  for (const field of POSITIVE_AUTHORITY_FIELDS) {
    for (const id of result.scopeDelta[field]) {
      const supported = necessaryRows.some((entry) => {
        const mapping = mappings.get(entry.mechanism);
        return entry[field].includes(id) && (mapping?.[field] ?? []).includes(id);
      });
      if (!supported) {
        errors.push(
          `$ scopeDelta.${field} authority ${JSON.stringify(id)} is not supported by any necessary-minor-expansion mechanism`,
        );
      }
    }
  }
  return errors;
}

function humanCoverageCorrespondence(packet, result) {
  if (result.verdict !== 'human-decision-required') return [];
  const { materialMechanisms, forcedCategories } = materialInventoryState(packet);
  const materialSurfaces = new Set(result.scopeDelta?.materialSurfaces ?? []);
  const hasDistinctNonNativeCategory = [...materialSurfaces].some(
    (category) => !forcedCategories.has(category),
  );
  return result.coverage.flatMap((entry) => {
    const isMaterialMechanism = materialMechanisms.has(entry.mechanism);
    if (entry.classification === 'speculative' && isMaterialMechanism) {
      return [`$ human-decision-required speculative mechanism ${JSON.stringify(entry.mechanism)} must be independent removable nonmaterial work`];
    }
    if (
      !isMaterialMechanism
      && entry.classification === 'material-scope-change'
      && !hasDistinctNonNativeCategory
    ) {
      return [`$ human-decision-required non-inventory material-scope-change mechanism ${JSON.stringify(entry.mechanism)} requires a distinct non-native material category; independent unsupported work must remain speculative`];
    }
    return [];
  });
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

  const packetSchemaValid = validatePacketSchema(packet);
  if (!packetSchemaValid) errors.push(...schemaErrors(validatePacketSchema));

  errors.push(...repeatedIds(packet?.sourceScope?.requiredCriteria, 'sourceScope.requiredCriteria'));
  errors.push(...repeatedIds(packet?.sourceScope?.nonGoals, 'sourceScope.nonGoals'));
  errors.push(...repeatedIds(packet?.sourceScope?.implementationGuidance, 'sourceScope.implementationGuidance'));
  errors.push(...repeatedIds(packet?.acceptedScope?.criteria, 'acceptedScope.criteria'));
  errors.push(...repeatedIds(packet?.acceptedScope?.invariants, 'acceptedScope.invariants'));
  errors.push(...repeatedIds(packet?.tripwires, 'tripwires'));
  errors.push(...repeatedMechanisms(packet?.changeInventory?.mappings, 'changeInventory.mappings'));
  errors.push(...overlappingAcceptedShapes(packet?.acceptedScope));

  if (packetSchemaValid) {
    errors.push(...unmappedMaterialInventory(packet));
    for (const evidence of resultRepresentability(packet)) {
      if (evidence.lowerBoundBytes <= SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) continue;
      const detail = evidence.exact
        ? `requires ${evidence.witnessBytes} bytes`
        : `requires more than ${SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES} bytes; certified lower bound ${evidence.lowerBoundBytes} bytes and valid witness ${evidence.witnessBytes} bytes`;
      errors.push(
        `$ assessment packet cannot represent a schema-minimal ${evidence.verdict} result within ${SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES} bytes (${detail})`,
      );
    }
  }

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
  errors.push(...mappingAuthorityCorrespondence(packet, result));
  errors.push(...minorDeltaCorrespondence(packet, result));
  errors.push(...humanCoverageCorrespondence(packet, result));
  errors.push(...acceptedShapeCorrespondence(packet, result));
  if (result.verdict !== 'insufficient-evidence') {
    errors.push(...materialInventoryCorrespondence(packet, result));
  }
  return normalize(errors);
}
