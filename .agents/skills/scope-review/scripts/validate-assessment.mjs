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

function buildMinorResult(packet, coverage, necessary) {
  const groundedCoverage = coverage.map((entry, index) => {
    const authority = necessary.get(index);
    return authority
      ? minimalCoverage(entry.mechanism, 'necessary-minor-expansion', authority)
      : entry;
  });
  const deltaFields = new Map(POSITIVE_AUTHORITY_FIELDS.map((field) => [field, new Set()]));
  for (const authority of necessary.values()) deltaFields.get(authority.field).add(authority.id);
  const result = baseMinimalResult(packet, 'minor-amendment-required', groundedCoverage);
  result.scopeDelta = {
    description: 'x',
    sourceCriterionIds: [...deltaFields.get('sourceCriterionIds')],
    acceptedCriterionIds: [...deltaFields.get('acceptedCriterionIds')],
    invariantIds: [...deltaFields.get('invariantIds')],
    materialSurfaces: [],
  };
  result.unnecessaryWork = groundedCoverage
    .filter(({ classification }) => classification === 'speculative')
    .map(({ mechanism }) => mechanism);
  if (result.unnecessaryWork.length > 0) result.smallerSufficientAlternative = 'x';
  return result;
}

function isSourceOrAccepted({ field }) {
  return field === 'sourceCriterionIds' || field === 'acceptedCriterionIds';
}

function minorAuthorityOptions(mapping, sourceOrAcceptedOnly = false) {
  const fields = sourceOrAcceptedOnly
    ? ['sourceCriterionIds', 'acceptedCriterionIds']
    : POSITIVE_AUTHORITY_FIELDS;
  return fields.flatMap((field) => mapping[field].map((id) => ({
    field,
    id,
    key: `${field}\u0000${id}`,
    serializedIdBytes: Buffer.byteLength(JSON.stringify(id), 'utf8'),
  })));
}

function reduceDominatedMinorOptions(rows) {
  const incidence = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    for (const option of row.options) {
      const indexes = incidence.get(option.key) ?? new Set();
      indexes.add(rowIndex);
      incidence.set(option.key, indexes);
    }
  }
  const tokens = [...new Map(
    rows.flatMap(({ options }) => options.map((option) => [option.key, option])),
  ).values()];
  const dominated = new Set();
  for (const candidate of tokens) {
    const candidateRows = incidence.get(candidate.key);
    for (const replacement of tokens) {
      if (candidate.key === replacement.key || candidate.field !== replacement.field) continue;
      if (replacement.serializedIdBytes > candidate.serializedIdBytes) continue;
      const replacementRows = incidence.get(replacement.key);
      const coversCandidate = [...candidateRows].every((index) => replacementRows.has(index));
      if (!coversCandidate) continue;
      const symmetric = replacementRows.size === candidateRows.size
        && replacement.serializedIdBytes === candidate.serializedIdBytes;
      if (!symmetric || replacement.key.localeCompare(candidate.key) < 0) {
        dominated.add(candidate.key);
        break;
      }
    }
  }
  return rows.map((row) => ({
    ...row,
    options: row.options.filter(({ key }) => !dominated.has(key)),
  }));
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

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function incidenceCommonDenominator(rowCount) {
  let denominator = 1n;
  for (let value = 2n; value <= BigInt(rowCount); value += 1n) {
    denominator = (denominator / greatestCommonDivisor(denominator, value)) * value;
  }
  return denominator;
}

function ensureMinorSourceAuthority(rows, assignments) {
  if (![...assignments.values()].some(isSourceOrAccepted)) {
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
    if (!best) return null;
    return best.assignments;
  }
  return assignments;
}

function initialMinorAssignments(rows) {
  const assignments = new Map();
  for (const row of rows) {
    const options = [...row.options].sort((left, right) => (
      left.serializedIdBytes - right.serializedIdBytes
      || left.field.localeCompare(right.field)
      || left.id.localeCompare(right.id)
    ));
    assignments.set(row.index, options[0]);
  }
  return ensureMinorSourceAuthority(rows, assignments);
}

function greedyCoverMinorAssignments(rows) {
  const candidates = new Map();
  for (const row of rows) {
    for (const option of row.options) {
      const candidate = candidates.get(option.key) ?? { option, rowIndexes: [] };
      candidate.rowIndexes.push(row.index);
      candidates.set(option.key, candidate);
    }
  }
  const uncovered = new Set(rows.map(({ index }) => index));
  const assignments = new Map();
  while (uncovered.size > 0) {
    const ranked = [...candidates.values()].map((candidate) => ({
      ...candidate,
      uncoveredIndexes: candidate.rowIndexes.filter((index) => uncovered.has(index)),
    })).filter(({ uncoveredIndexes }) => uncoveredIndexes.length > 0);
    ranked.sort((left, right) => (
      (right.uncoveredIndexes.length * left.option.serializedIdBytes)
        - (left.uncoveredIndexes.length * right.option.serializedIdBytes)
      || right.uncoveredIndexes.length - left.uncoveredIndexes.length
      || left.option.serializedIdBytes - right.option.serializedIdBytes
      || left.option.key.localeCompare(right.option.key)
    ));
    const selected = ranked[0];
    for (const index of selected.uncoveredIndexes) {
      assignments.set(index, selected.option);
      uncovered.delete(index);
    }
  }
  return ensureMinorSourceAuthority(rows, assignments);
}

function improveSharedMinorAssignments(rows, initialAssignments) {
  let assignments = initialAssignments;
  let cost = minorVariableCost(assignments);
  const candidates = new Map();
  for (const row of rows) {
    for (const option of row.options) {
      const candidate = candidates.get(option.key) ?? { option, indexes: [] };
      candidate.indexes.push(row.index);
      candidates.set(option.key, candidate);
    }
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (const { option, indexes } of candidates.values()) {
      if (indexes.length < 2) continue;
      const candidateAssignments = new Map(assignments);
      for (const index of indexes) candidateAssignments.set(index, option);
      if (![...candidateAssignments.values()].some(isSourceOrAccepted)) continue;
      const candidateCost = minorVariableCost(candidateAssignments);
      if (candidateCost < cost) {
        assignments = candidateAssignments;
        cost = candidateCost;
        improved = true;
      }
    }
  }
  return assignments;
}

function solveMinorAuthorityScenario(packet, coverage, necessaryIndexes, sourceAnchorIndex) {
  let rows = necessaryIndexes.map((index) => ({
    index,
    mechanism: packet.changeInventory.mappings[index].mechanism,
    options: minorAuthorityOptions(
      packet.changeInventory.mappings[index],
      index === sourceAnchorIndex,
    ),
  }));
  if (rows.some(({ options }) => options.length === 0)) return null;
  rows = reduceDominatedMinorOptions(rows);
  if (rows.some(({ options }) => options.length === 0)) return null;
  rows.sort((left, right) => (
    left.options.length - right.options.length
    || left.mechanism.localeCompare(right.mechanism)
    || left.index - right.index
  ));

  let assignments = initialMinorAssignments(rows);
  if (!assignments) return null;
  assignments = improveSharedMinorAssignments(rows, assignments);
  const greedyAssignments = greedyCoverMinorAssignments(rows);
  if (
    greedyAssignments
    && minorVariableCost(greedyAssignments) < minorVariableCost(assignments)
  ) {
    assignments = greedyAssignments;
  }
  let bestAssignments = assignments;
  let bestVariableCost = minorVariableCost(assignments);
  let bestResult = buildMinorResult(packet, coverage, assignments);
  let bestBytes = serializedBytes(bestResult, 'scope assessment result').bytes;
  if (bestBytes <= SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) return bestResult;

  const tokenMap = new Map();
  for (const row of rows) {
    for (const option of row.options) tokenMap.set(option.key, option);
  }
  const tokens = [...tokenMap.values()].sort((left, right) => left.key.localeCompare(right.key));
  tokens.forEach((token, index) => {
    token.tokenIndex = index;
    token.bit = 1n << BigInt(index);
    token.fieldIndex = POSITIVE_AUTHORITY_FIELDS.indexOf(token.field);
  });
  for (const row of rows) {
    row.options = row.options.map((option) => tokenMap.get(option.key));
  }
  const remainingIncidence = Array.from(
    { length: rows.length + 1 },
    () => new Uint16Array(tokens.length),
  );
  for (let position = rows.length - 1; position >= 0; position -= 1) {
    remainingIncidence[position].set(remainingIncidence[position + 1]);
    for (const option of rows[position].options) {
      remainingIncidence[position][option.tokenIndex] += 1;
    }
  }
  const commonDenominator = incidenceCommonDenominator(rows.length);

  function searchLowerBound(position, openedMask, fieldCounts) {
    let coverageLowerBound = 0;
    let openingLowerBoundNumerator = 0n;
    const uncoveredRows = [];
    const unopenedCoverage = new Map();
    const unopenedFields = new Set();
    let shortestUnopenedAuthorityBytes = Number.POSITIVE_INFINITY;
    for (let remaining = position; remaining < rows.length; remaining += 1) {
      let rowCoverageLowerBound = Number.POSITIVE_INFINITY;
      let rowOpeningLowerBoundNumerator = null;
      let hasOpenedOption = false;
      for (const option of rows[remaining].options) {
        const isOpened = (openedMask & option.bit) !== 0n;
        hasOpenedOption ||= isOpened;
        const openingCost = isOpened ? 0 : option.serializedIdBytes;
        const incidenceCount = BigInt(remainingIncidence[position][option.tokenIndex]);
        const openingNumerator = BigInt(openingCost) * (commonDenominator / incidenceCount);
        rowCoverageLowerBound = Math.min(rowCoverageLowerBound, option.serializedIdBytes);
        if (
          rowOpeningLowerBoundNumerator === null
          || openingNumerator < rowOpeningLowerBoundNumerator
        ) {
          rowOpeningLowerBoundNumerator = openingNumerator;
        }
        if (!isOpened) {
          unopenedFields.add(option.fieldIndex);
          shortestUnopenedAuthorityBytes = Math.min(
            shortestUnopenedAuthorityBytes,
            option.serializedIdBytes,
          );
          const coveredRows = unopenedCoverage.get(option.tokenIndex) ?? new Set();
          coveredRows.add(remaining);
          unopenedCoverage.set(option.tokenIndex, coveredRows);
        }
      }
      coverageLowerBound += rowCoverageLowerBound;
      openingLowerBoundNumerator += rowOpeningLowerBoundNumerator;
      if (!hasOpenedOption) uncoveredRows.push(remaining);
    }
    const packedKeys = new Set();
    const packedFields = new Set();
    let packedOpenings = 0;
    for (let remaining = position; remaining < rows.length; remaining += 1) {
      const unopenedOptions = rows[remaining].options.filter(
        (option) => (openedMask & option.bit) === 0n,
      );
      if (unopenedOptions.length !== rows[remaining].options.length) continue;
      if (unopenedOptions.some(({ key }) => packedKeys.has(key))) continue;
      packedOpenings += 1;
      for (const option of unopenedOptions) {
        packedKeys.add(option.key);
        packedFields.add(option.fieldIndex);
      }
    }
    const availableCommaFreeFields = [...packedFields].filter(
      (fieldIndex) => fieldCounts[fieldIndex] === 0,
    ).length;
    const commaLowerBound = Math.max(packedOpenings - availableCommaFreeFields, 0);
    const exactFractionalOpeningCeiling = (
      openingLowerBoundNumerator + commonDenominator - 1n
    ) / commonDenominator;
    let additionalOpeningCount = 0;
    if (uncoveredRows.length > 0) {
      const maxUncoveredCoverage = Math.max(
        ...[...unopenedCoverage.values()].map((coveredRows) => coveredRows.size),
      );
      additionalOpeningCount = Math.ceil(uncoveredRows.length / maxUncoveredCoverage);
    }
    const cardinalityOpeningBytes = additionalOpeningCount === 0
      ? 0
      : additionalOpeningCount * shortestUnopenedAuthorityBytes;
    const exactOpeningLowerBound = Math.max(
      Number(exactFractionalOpeningCeiling),
      cardinalityOpeningBytes,
    );
    const cardinalityCommaLowerBound = Math.max(
      additionalOpeningCount - [...unopenedFields].filter(
        (fieldIndex) => fieldCounts[fieldIndex] === 0,
      ).length,
      0,
    );
    return coverageLowerBound
      + exactOpeningLowerBound
      + Math.max(commaLowerBound, cardinalityCommaLowerBound);
  }

  const fixedResultBytes = bestBytes - bestVariableCost;
  const rootLowerBoundBytes = fixedResultBytes + searchLowerBound(0, 0n, [0, 0, 0]);
  if (rootLowerBoundBytes > SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) {
    Object.defineProperty(bestResult, RESULT_REPRESENTABILITY, {
      configurable: true,
      value: {
        exact: rootLowerBoundBytes === bestBytes,
        lowerBoundBytes: rootLowerBoundBytes,
        witnessBytes: bestBytes,
      },
    });
    return bestResult;
  }

  const workingAssignments = new Map();
  const memo = new Map();
  function search(position, openedMask, fieldCounts, hasSourceOrAccepted, runningCost) {
    if (position === rows.length) {
      if (!hasSourceOrAccepted || runningCost >= bestVariableCost) return;
      bestVariableCost = runningCost;
      bestAssignments = new Map(workingAssignments);
      bestResult = buildMinorResult(packet, coverage, bestAssignments);
      return;
    }
    if (!hasSourceOrAccepted) {
      const canStillGroundDelta = rows.slice(position).some(({ options }) => (
        options.some(isSourceOrAccepted)
      ));
      if (!canStillGroundDelta) return;
    }

    const integerLowerBound = searchLowerBound(position, openedMask, fieldCounts);
    if (runningCost + integerLowerBound >= bestVariableCost) return;

    const memoKey = `${position}:${openedMask.toString(16)}:${hasSourceOrAccepted ? 1 : 0}`;
    const priorCost = memo.get(memoKey);
    if (priorCost !== undefined && priorCost <= runningCost) return;
    memo.set(memoKey, runningCost);

    const row = rows[position];
    const options = [...row.options].sort((left, right) => {
      const leftOpened = (openedMask & left.bit) !== 0n;
      const rightOpened = (openedMask & right.bit) !== 0n;
      const leftIncrement = left.serializedIdBytes + (leftOpened
        ? 0
        : left.serializedIdBytes + (fieldCounts[left.fieldIndex] > 0 ? 1 : 0));
      const rightIncrement = right.serializedIdBytes + (rightOpened
        ? 0
        : right.serializedIdBytes + (fieldCounts[right.fieldIndex] > 0 ? 1 : 0));
      return leftIncrement - rightIncrement
        || remainingIncidence[position][right.tokenIndex]
          - remainingIncidence[position][left.tokenIndex]
        || left.key.localeCompare(right.key);
    });
    for (const option of options) {
      const isOpened = (openedMask & option.bit) !== 0n;
      const nextFieldCounts = [...fieldCounts];
      let increment = option.serializedIdBytes;
      let nextMask = openedMask;
      if (!isOpened) {
        increment += option.serializedIdBytes + (nextFieldCounts[option.fieldIndex] > 0 ? 1 : 0);
        nextFieldCounts[option.fieldIndex] += 1;
        nextMask |= option.bit;
      }
      workingAssignments.set(row.index, option);
      search(
        position + 1,
        nextMask,
        nextFieldCounts,
        hasSourceOrAccepted || isSourceOrAccepted(option),
        runningCost + increment,
      );
      workingAssignments.delete(row.index);
    }
  }
  search(0, 0n, [0, 0, 0], false, 0);
  return bestResult;
}

function exactMinorResult(packet, coverage, forcedNecessaryIndexes) {
  const ordinaryAnchorIndexes = packet.changeInventory.mappings.flatMap((mapping, index) => {
    if (forcedNecessaryIndexes.includes(index)) return [];
    return minorAuthorityOptions(mapping, true).length > 0 ? [index] : [];
  });
  ordinaryAnchorIndexes.sort((left, right) => (
    packet.changeInventory.mappings[left].mechanism.localeCompare(
      packet.changeInventory.mappings[right].mechanism,
    ) || left - right
  ));
  const scenarios = forcedNecessaryIndexes.length > 0
    ? [{ necessary: forcedNecessaryIndexes, anchor: null }, ...ordinaryAnchorIndexes.map((anchor) => ({
      necessary: [...forcedNecessaryIndexes, anchor],
      anchor,
    }))]
    : ordinaryAnchorIndexes.map((anchor) => ({ necessary: [anchor], anchor }));
  let bestResult = null;
  let bestBytes = Number.POSITIVE_INFINITY;
  let globalLowerBoundBytes = Number.POSITIVE_INFINITY;
  for (const scenario of scenarios) {
    const scenarioCoverage = coverage.map((entry, index) => (
      scenario.necessary.includes(index)
        ? minimalCoverage(entry.mechanism, 'necessary-minor-expansion')
        : entry
    ));
    const result = solveMinorAuthorityScenario(
      packet,
      scenarioCoverage,
      scenario.necessary,
      scenario.anchor,
    );
    if (!result) continue;
    const bytes = serializedBytes(result, 'scope assessment result').bytes;
    const evidence = result[RESULT_REPRESENTABILITY] ?? {
      lowerBoundBytes: bytes,
      witnessBytes: bytes,
    };
    if (bytes <= SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES) return result;
    globalLowerBoundBytes = Math.min(globalLowerBoundBytes, evidence.lowerBoundBytes);
    if (bytes < bestBytes) {
      bestResult = result;
      bestBytes = bytes;
    }
  }
  if (bestResult) {
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
    const forcedNecessaryIndexes = [];
    coverage = mappings.map((mapping, index) => {
      const affirmative = affirmativeCoverage(mapping, rejectedShape);
      if (affirmative) return affirmative;
      if (materialMechanisms.has(mapping.mechanism)) return null;
      if (minorAuthorityOptions(mapping).length === 0) {
        return minimalCoverage(mapping.mechanism, 'speculative');
      }
      forcedNecessaryIndexes.push(index);
      return minimalCoverage(mapping.mechanism, 'necessary-minor-expansion');
    });
    if (coverage.some((entry) => entry === null)) return null;
    return exactMinorResult(packet, coverage, forcedNecessaryIndexes);
  } else if (verdict === 'human-decision-required') {
    const materialIndexes = new Set();
    if (forcedMechanisms.size > 0) {
      mappings.forEach(({ mechanism }, index) => {
        if (forcedMechanisms.has(mechanism)) materialIndexes.add(index);
      });
    } else {
      const candidates = mappings.map((mapping, index) => {
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
        return {
          index,
          incrementalBytes: ordinary
            ? serializedBytes(material, 'coverage').bytes - serializedBytes(ordinary, 'coverage').bytes
            : Number.POSITIVE_INFINITY,
        };
      });
      candidates.sort((left, right) => (
        left.incrementalBytes - right.incrementalBytes || left.index - right.index
      ));
      if (!Number.isFinite(candidates[0].incrementalBytes)) return null;
      materialIndexes.add(candidates[0].index);
    }
    coverage = mappings.map((mapping, index) => {
      if (materialIndexes.has(index)) {
        return minimalCoverage(mapping.mechanism, 'material-scope-change');
      }
      if (materialMechanisms.has(mapping.mechanism)) return affirmativeCoverage(mapping, rejectedShape);
      const speculative = minimalCoverage(mapping.mechanism, 'speculative');
      const affirmative = affirmativeCoverage(mapping, rejectedShape);
      if (!affirmative) return speculative;
      return serializedBytes(affirmative, 'coverage').bytes <= serializedBytes(speculative, 'coverage').bytes
        ? affirmative
        : speculative;
    });
    if (coverage.some((entry) => entry === null)) return null;
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
  if (result.verdict !== 'minor-amendment-required') return [];
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
  const materialMechanisms = new Set(
    MATERIAL_INVENTORY_FIELDS.flatMap((field) => packet.changeInventory[field]),
  );
  return result.coverage.flatMap((entry) => (
    entry.classification === 'speculative' && materialMechanisms.has(entry.mechanism)
      ? [`$ human-decision-required speculative mechanism ${JSON.stringify(entry.mechanism)} must be independent removable nonmaterial work`]
      : []
  ));
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
