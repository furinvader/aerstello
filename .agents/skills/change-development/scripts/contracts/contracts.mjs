import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  loadRegistry,
  routeSpecialists,
  validateSpecialistEvidence,
  validateSpecialization,
} from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import {
  materialDigest as sourceMaterialDigest,
  progressDigest as sourceProgressDigest,
  sourceObservationDigest,
} from '../source/source.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;

export const IMPLEMENTATION_PLAN_SCHEMA_VERSION = 1;
export const DEVELOPMENT_STATE_SCHEMA_VERSION = 1;
export const CHANGE_MODES = Object.freeze(['plan-only', 'implement', 'full']);
export const DEVELOPMENT_PHASES = Object.freeze([
  'initializing', 'planning', 'awaiting-decision', 'ready-to-implement',
  'blocked', 'recovering', 'abandoned',
]);
export const SOURCE_KINDS = Object.freeze([
  'github-issue', 'direct-request', 'repository-plan', 'partial-implementation',
]);
// Concise aliases are kept for state/source modules while the longer names make
// the two versioned public contracts unambiguous to external consumers.
export const PLAN_SCHEMA_VERSION = IMPLEMENTATION_PLAN_SCHEMA_VERSION;
export const STATE_SCHEMA_VERSION = DEVELOPMENT_STATE_SCHEMA_VERSION;
export const MODES = CHANGE_MODES;
export const STATE_PHASES = DEVELOPMENT_PHASES;

const schemaDirectory = new URL('../../schemas/', import.meta.url);
export const implementationPlanSchema = JSON.parse(readFileSync(new URL('implementation-plan.schema.json', schemaDirectory), 'utf8'));
export const developmentStateSchema = JSON.parse(readFileSync(new URL('development-state.schema.json', schemaDirectory), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validatePlanSchema = ajv.compile(implementationPlanSchema);
const validateStateSchema = ajv.compile(developmentStateSchema);
const validateRfc3339DateTime = ajv.compile({ type: 'string', format: 'date-time' });
const repositoryPathPattern = new RegExp(implementationPlanSchema.$defs.repositoryPath.pattern, 'u');
const registry = loadRegistry();

function sortedJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => sortedJson(entry, seen)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON requires plain objects');
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

export function canonicalJsonText(value) {
  return `${sortedJson(value)}\n`;
}

export function digestJson(value) {
  return `sha256:${createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex')}`;
}

function schemaErrors(validator, value) {
  if (validator(value)) return [];
  return validator.errors.map(({ instancePath, message }) => `${instancePath || '$'} ${message}`);
}

function duplicates(items) {
  const seen = new Set();
  const duplicate = new Set();
  for (const item of items) (seen.has(item) ? duplicate : seen).add(item);
  return [...duplicate];
}

function sameJson(left, right) {
  return canonicalJsonText(left) === canonicalJsonText(right);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function requiredSourceString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/**
 * Convert one parsed source checklist item to the only checklist binding shape
 * accepted by implementation-plan v1. Planning-only relationship and coverage
 * fields are deliberately added by the plan, not fabricated by this helper.
 */
export function sourceChecklistBinding(item) {
  if (!isRecord(item) || !isRecord(item.identity)) throw new TypeError('source checklist item and identity must be objects');
  const id = requiredSourceString(item.checklistItemId, 'source checklist item ID');
  const capturedText = requiredSourceString(item.text, `source checklist item ${id} text`);
  let identity;
  if (item.identity.kind === 'stable-marker') {
    identity = {
      kind: 'stable-marker',
      stableId: requiredSourceString(item.identity.stableId, `source checklist item ${id} stableId`),
    };
  } else if (item.identity.kind === 'legacy-position') {
    if (!Number.isInteger(item.identity.position) || item.identity.position < 1) {
      throw new TypeError(`source checklist item ${id} legacy position must be at least 1`);
    }
    if (!Number.isInteger(item.identity.line) || item.identity.line < 1) {
      throw new TypeError(`source checklist item ${id} legacy line must be at least 1`);
    }
    const section = item.identity.section ?? null;
    if (section !== null) requiredSourceString(section, `source checklist item ${id} section`);
    identity = {
      kind: 'legacy-position', text: capturedText,
      position: item.identity.position, line: item.identity.line, section,
    };
  } else {
    throw new TypeError(`source checklist item ${id} has an unknown identity kind`);
  }
  const reasons = Array.isArray(item.ambiguityReasons)
    ? item.ambiguityReasons.map((reason) => requiredSourceString(reason, `source checklist item ${id} ambiguity reason`))
    : [];
  const ambiguous = item.ambiguous === true;
  const status = item.status ?? (ambiguous ? 'ambiguous' : 'current');
  if (!['current', 'ambiguous', 'removed'].includes(status)) throw new TypeError(`source checklist item ${id} has an invalid status`);
  const ambiguity = item.ambiguity ?? (ambiguous ? (reasons.join('; ') || 'ambiguous source checklist identity') : null);
  if (ambiguity !== null) requiredSourceString(ambiguity, `source checklist item ${id} ambiguity`);
  return {
    id, identity, capturedText, checked: item.checked === true,
    status, ambiguity, externalChange: item.externalChange === true,
  };
}

function validateIds(errors, records, label) {
  for (const id of duplicates(records.map((entry) => entry.id))) errors.push(`duplicate ${label} ID: ${id}`);
}

function computedRoute(metadata, errors, label) {
  const specializationErrors = validateSpecialization(metadata, registry);
  errors.push(...specializationErrors.map((error) => `${label}: ${error}`));
  if (specializationErrors.length > 0) return null;
  try {
    return routeSpecialists({
      specialization: metadata.specialization,
      riskTags: metadata.riskTags,
      browserVisible: metadata.browserVisible,
      testSelectionUncertain: metadata.relatedTestSelectionUncertain,
    }, registry);
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}

function validateRouteAndEvidence(metadata, evidence, planningSha, planRevision, errors, label) {
  const route = computedRoute(metadata, errors, label);
  if (!route) return;
  if (!sameJson(metadata.route, route)) errors.push(`${label}.route does not equal the canonical specialist route`);
  if (metadata.relatedTestSelectionUncertain) errors.push(`${label} has unresolved related-test selection`);
  const required = new Set(route.planningHelpers.map(({ id }) => id));
  const applicableEvidence = Array.isArray(evidence)
    ? evidence.filter((item) => item !== null && typeof item === 'object' && required.has(item.reviewerId))
    : [];
  errors.push(...validateSpecialistEvidence({ evidence: applicableEvidence, route, subjectSha: planningSha, phase: 'planning' })
    .map((error) => `${label}: ${error}`));
  for (const item of applicableEvidence) {
    if (item.planRevision !== planRevision) errors.push(`${label}: ${item.reviewerId} evidence is not for plan revision ${planRevision}`);
    if (item.status !== 'clean') errors.push(`${label}: ${item.reviewerId} evidence must be clean`);
  }
}

function transitiveDependencies(taskId, byId, visiting = new Set()) {
  if (visiting.has(taskId)) return new Set();
  visiting.add(taskId);
  const result = new Set();
  for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
    result.add(dependency);
    for (const ancestor of transitiveDependencies(dependency, byId, visiting)) result.add(ancestor);
  }
  visiting.delete(taskId);
  return result;
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

const EXECUTABLE_SHAPED_PREFIX = /^\s*(?:[a-z0-9][a-z0-9._+-]*|[a-z0-9._+-]+[A-Z][A-Za-z0-9._+-]*|[A-Z][A-Za-z0-9._+-]*[A-Z][A-Za-z0-9._+-]*|"[A-Za-z0-9][A-Za-z0-9._+-]*"|'[A-Za-z0-9][A-Za-z0-9._+-]*'|\.{0,2}\/\S*|\/\S*)(?:\s|$)/u;
const COMMAND_ARGUMENT_PREFIX = /^\s*\S+\s+(?:-{1,2}[A-Za-z0-9]|https?:\/\/|\.{0,2}\/|\/)/u;
const ENVIRONMENT_ASSIGNMENT_PREFIX = /^\s*[A-Za-z_][A-Za-z0-9_]*=\S+(?:\s|$)/u;
const SHELL_SYNTAX = /(?:&&|\|\||[;|`<>]|\$\()/u;

function isExecutableIntent(value) {
  return EXECUTABLE_SHAPED_PREFIX.test(value) || COMMAND_ARGUMENT_PREFIX.test(value)
    || ENVIRONMENT_ASSIGNMENT_PREFIX.test(value) || SHELL_SYNTAX.test(value);
}

const REPOSITORY_PATH_SHAPE = /(?:\/|\.[A-Za-z0-9][A-Za-z0-9._-]*$)/u;
const CLEAR_COMMAND_NAMES = new Set([
  'bash', 'bun', 'cat', 'chmod', 'cp', 'curl', 'deno', 'docker', 'eslint', 'find',
  'git', 'grep', 'jest', 'make', 'mv', 'node', 'npm', 'npx', 'pnpm', 'python',
  'python3', 'rm', 'sed', 'sh', 'tar', 'tsc', 'tsx', 'vitest', 'wget', 'yarn',
]);

function isCommandShapedAnticipatedPath(value) {
  if (SHELL_SYNTAX.test(value) || ENVIRONMENT_ASSIGNMENT_PREFIX.test(value)) return true;
  if (!/\s/u.test(value)) return false;
  const command = value.trim().split(/\s+/u, 1)[0].replace(/^(?:"|')|(?:"|')$/gu, '').toLowerCase();
  return CLEAR_COMMAND_NAMES.has(command) || !REPOSITORY_PATH_SHAPE.test(value);
}

const FEATURE_PATH = /^specs\/features\/(?:[^/]+\/)*[^/]+\.feature$/u;
const SCENARIO_HEADING = /^\s*Scenario(?: Outline| Template)?:\s*(.*?)\s*$/u;
const DOC_STRING_DELIMITER = /^\s*("""|```)/u;

function scenarioHeadings(bytes, scenario, errors) {
  if (!(bytes instanceof Uint8Array)) {
    errors.push(`scenario ${scenario.id} feature reader must return bytes or null`);
    return [];
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { errors.push(`scenario ${scenario.id} feature is not valid UTF-8: ${scenario.feature}`); return []; }
  const names = [];
  let docString = null;
  for (const line of text.split(/\r?\n/u)) {
    const delimiter = line.match(DOC_STRING_DELIMITER)?.[1] ?? null;
    if (delimiter !== null) {
      if (docString === null) docString = delimiter;
      else if (delimiter === docString) docString = null;
      continue;
    }
    if (docString !== null) continue;
    const heading = line.match(SCENARIO_HEADING);
    if (heading && heading[1] !== '') names.push(heading[1]);
  }
  return names;
}

function validateScenarioContext(plan, readPlanningFile, errors) {
  if (plan.scenarios.length === 0) return;
  if (typeof readPlanningFile !== 'function') {
    errors.push('nonempty scenario mappings require synchronous Planning-SHA repository context');
    return;
  }
  const files = new Map();
  for (const scenario of plan.scenarios) {
    if (!FEATURE_PATH.test(scenario.feature)) {
      errors.push(`scenario ${scenario.id} feature must be under specs/features and end in .feature`);
      continue;
    }
    let headings = files.get(scenario.feature);
    if (headings === undefined) {
      let bytes;
      try {
        bytes = readPlanningFile({ planningSha: plan.planning.planningSha, path: scenario.feature });
      } catch {
        errors.push(`scenario ${scenario.id} feature read failed at the Planning SHA: ${scenario.feature}`);
        files.set(scenario.feature, null);
        continue;
      }
      if (bytes && typeof bytes.then === 'function') {
        errors.push(`scenario ${scenario.id} feature reader must be synchronous`);
        files.set(scenario.feature, null);
        continue;
      }
      if (bytes === null || bytes === undefined) {
        errors.push(`scenario ${scenario.id} feature is missing at the Planning SHA: ${scenario.feature}`);
        files.set(scenario.feature, null);
        continue;
      }
      headings = scenarioHeadings(bytes, scenario, errors);
      files.set(scenario.feature, headings);
    }
    if (headings === null) continue;
    const matches = headings.filter((name) => name === scenario.scenario).length;
    if (matches === 0) errors.push(`scenario ${scenario.id} heading is missing at the Planning SHA: ${scenario.scenario}`);
    else if (matches > 1) errors.push(`scenario ${scenario.id} heading is ambiguous at the Planning SHA: ${scenario.scenario}`);
  }
}

function validatePlanningEvidence(evidence, errors) {
  if (!Array.isArray(evidence)) {
    errors.push('planningEvidence must be an array');
    return;
  }
  const allowed = ['schemaVersion', 'planRevision', 'reviewerId', 'headSha', 'status', 'summary', 'findings', 'recordedAt'];
  const seen = new Set();
  for (const [index, item] of evidence.entries()) {
    const label = `planningEvidence[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label} must be an object`); continue; }
    for (const key of Object.keys(item)) if (!allowed.includes(key)) errors.push(`${label}.${key} is not allowed`);
    for (const key of allowed) if (!Object.hasOwn(item, key)) errors.push(`${label}.${key} is required`);
    if (item.schemaVersion !== 1) errors.push(`${label}.schemaVersion must be 1`);
    if (!Number.isInteger(item.planRevision) || item.planRevision < 1) errors.push(`${label}.planRevision must be a positive integer`);
    if (item.reviewerId !== 'behavior_mapper') errors.push(`${label}.reviewerId must be behavior_mapper`);
    if (seen.has(item.reviewerId)) errors.push(`duplicate planning evidence: ${item.reviewerId}`); seen.add(item.reviewerId);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(item.headSha ?? '')) errors.push(`${label}.headSha must be a lowercase Git SHA`);
    if (!['clean', 'findings'].includes(item.status)) errors.push(`${label}.status is invalid`);
    if (typeof item.summary !== 'string' || item.summary.trim() === '') errors.push(`${label}.summary is required`);
    if (!Array.isArray(item.findings) || item.findings.some((finding) => typeof finding !== 'string' || finding.trim() === '')) errors.push(`${label}.findings must be a string array`);
    if (!validateRfc3339DateTime(item.recordedAt)) errors.push(`${label}.recordedAt must be a strict RFC3339 date-time`);
    if (item.status === 'clean' && item.findings?.length !== 0) errors.push(`${label} clean evidence cannot contain findings`);
    if (item.status === 'findings' && item.findings?.length === 0) errors.push(`${label} findings evidence must contain findings`);
  }
}

function validateSourceObservationContext(plan, sourceObservation, errors) {
  if (sourceObservation === undefined) return;
  if (!isRecord(sourceObservation)) {
    errors.push('sourceObservation must be an immutable source observation object');
    return;
  }
  const required = [
    'schemaVersion', 'sourceType', 'planningSha', 'descriptor', 'capturedAt', 'source',
    'materialDigest', 'progressDigest', 'digest',
  ];
  for (const key of required) if (!Object.hasOwn(sourceObservation, key)) errors.push(`sourceObservation.${key} is required`);
  if (sourceObservation.schemaVersion !== 1) errors.push('sourceObservation.schemaVersion must be 1');
  if (!isRecord(sourceObservation.descriptor) || !isRecord(sourceObservation.source)) {
    errors.push('sourceObservation descriptor and source must be objects');
    return;
  }
  try {
    if (sourceObservation.digest !== sourceObservationDigest(sourceObservation)) errors.push('sourceObservation digest receipt does not match its content');
    if (sourceObservation.materialDigest !== sourceMaterialDigest(sourceObservation)) errors.push('sourceObservation material digest receipt does not match its content');
    if (sourceObservation.progressDigest !== sourceProgressDigest(sourceObservation)) errors.push('sourceObservation progress digest receipt does not match its content');
  } catch (error) {
    errors.push(`sourceObservation receipt cannot be verified: ${error.message}`);
    return;
  }
  if (plan.source.captureDigest !== sourceObservation.digest) errors.push('plan source captureDigest does not match sourceObservation digest');
  if (plan.source.kind !== sourceObservation.sourceType) errors.push('plan source kind does not match sourceObservation sourceType');
  if (plan.planning.planningSha !== sourceObservation.planningSha) errors.push('plan Planning SHA does not match sourceObservation Planning SHA');
  if (plan.source.relationship !== sourceObservation.descriptor.relationshipIntent) errors.push('plan source relationship does not match sourceObservation relationship intent');

  if (plan.source.kind === 'partial-implementation') {
    if (plan.planning.comparisonBaseSha !== sourceObservation.source.comparisonBaseSha) {
      errors.push('partial-implementation comparisonBaseSha does not match sourceObservation');
    }
  } else if (plan.planning.comparisonBaseSha !== null) {
    errors.push('non-partial source planning comparisonBaseSha must be null');
  }

  const checklist = sourceObservation.source.checklist ?? [];
  if (!Array.isArray(checklist)) {
    errors.push('sourceObservation.source.checklist must be an array when present');
    return;
  }
  const expected = [];
  for (const [index, item] of checklist.entries()) {
    try { expected.push(sourceChecklistBinding(item)); }
    catch (error) { errors.push(`sourceObservation checklist[${index}] cannot be bound: ${error.message}`); }
  }
  const expectedIds = expected.map(({ id }) => id);
  for (const id of duplicates(expectedIds)) errors.push(`sourceObservation has duplicate checklist mapping ID: ${id}`);
  const expectedIdentityKeys = expected.map(({ identity }) => canonicalJsonText(identity));
  for (const identity of duplicates(expectedIdentityKeys)) errors.push(`sourceObservation has duplicate checklist identity: ${identity.trim()}`);
  const mappingIdentityKeys = plan.checklistMappings.map(({ identity }) => canonicalJsonText(identity));
  for (const identity of duplicates(mappingIdentityKeys)) errors.push(`plan has duplicate checklist identity: ${identity.trim()}`);

  const expectedById = new Map(expected.map((binding) => [binding.id, binding]));
  const mappingById = new Map(plan.checklistMappings.map((mapping) => [mapping.id, mapping]));
  for (const binding of expected) {
    const mapping = mappingById.get(binding.id);
    if (!mapping) { errors.push(`plan is missing source checklist mapping ${binding.id}`); continue; }
    for (const field of ['identity', 'capturedText', 'checked', 'status', 'ambiguity', 'externalChange']) {
      if (!sameJson(mapping[field], binding[field])) errors.push(`checklist mapping ${binding.id}.${field} does not match sourceObservation`);
    }
  }
  for (const mapping of plan.checklistMappings) {
    if (!expectedById.has(mapping.id)) errors.push(`plan checklist mapping ${mapping.id} is fabricated or no longer present in sourceObservation`);
  }
}

function validateSpecialistAggregate(plan, planningEvidence, errors) {
  // A single registry profile cannot necessarily represent the union of a
  // split workflow + product DAG. Treat global metadata as the change's own
  // independently validated classification, then derive final requirements
  // from the union of that route and every independently validated task route.
  const metadataEntries = [
    ['global', plan.specialization],
    ...plan.tasks.map((task) => [`task ${task.id}`, task.specialization]),
  ];
  const requiredPlanningHelpers = new Set();
  const requiredRiskReviewers = new Set();
  const persistedPlanningHelpers = new Set();
  const persistedRiskReviewers = new Set();
  for (const [label, metadata] of metadataEntries) {
    const route = computedRoute(metadata, [], label);
    for (const { id } of route?.planningHelpers ?? []) requiredPlanningHelpers.add(id);
    for (const { id } of route?.riskReviewers ?? []) requiredRiskReviewers.add(id);
    for (const { id } of metadata.route.planningHelpers) persistedPlanningHelpers.add(id);
    for (const { id } of metadata.route.riskReviewers) persistedRiskReviewers.add(id);
  }
  for (const id of requiredPlanningHelpers) if (!persistedPlanningHelpers.has(id)) errors.push(`derived specialist aggregate is missing planning helper ${id}`);
  for (const id of requiredRiskReviewers) if (!persistedRiskReviewers.has(id)) errors.push(`derived specialist aggregate is missing risk reviewer ${id}`);
  for (const item of planningEvidence) {
    if (isRecord(item) && !requiredPlanningHelpers.has(item.reviewerId)) {
      errors.push(`${item.reviewerId} evidence is not routed by the global or any planned task specialization`);
    }
  }
}

export function validateImplementationPlan(value, { planningEvidence = [], sourceObservation, readPlanningFile } = {}) {
  const errors = schemaErrors(validatePlanSchema, value);
  if (errors.length > 0) return errors;
  validatePlanningEvidence(planningEvidence, errors);
  validateSourceObservationContext(value, sourceObservation, errors);
  validateScenarioContext(value, readPlanningFile, errors);

  validateIds(errors, value.criteria, 'criterion');
  validateIds(errors, value.decisions, 'decision');
  validateIds(errors, value.tasks, 'task');
  const criterionIds = new Set(value.criteria.map(({ id }) => id));
  const decisionIds = new Set(value.decisions.map(({ id }) => id));
  validateIds(errors, value.scenarios, 'scenario');
  const scenarioIds = new Set(value.scenarios.map(({ id }) => id));
  for (const id of value.productScenarioDisposition.scenarioIds) if (!scenarioIds.has(id)) errors.push(`product scenario disposition references unknown scenario ${id}`);
  for (const id of scenarioIds) if (!value.productScenarioDisposition.scenarioIds.includes(id)) errors.push(`scenario ${id} is missing from product scenario disposition`);
  const checklistIdList = value.checklistMappings.map(({ id }) => id);
  const checklistIds = new Set(checklistIdList);
  for (const id of duplicates(checklistIdList)) errors.push(`duplicate checklist item ID: ${id}`);
  const taskIds = new Set(value.tasks.map(({ id }) => id));
  const byId = new Map(value.tasks.map((task) => [task.id, task]));

  validateRouteAndEvidence(value.specialization, planningEvidence, value.planning.planningSha, value.planRevision, errors, '$.specialization');
  validateSpecialistAggregate(value, planningEvidence, errors);
  for (const task of value.tasks) {
    const label = `task ${task.id}`;
    validateRouteAndEvidence(task.specialization, planningEvidence, value.planning.planningSha, value.planRevision, errors, label);
    for (const [ids, known, kind] of [[task.criterionIds, criterionIds, 'criterion'], [task.decisionIds, decisionIds, 'decision'], [task.scenarioIds, scenarioIds, 'scenario'], [task.checklistItemIds, checklistIds, 'checklist item']]) {
      for (const id of ids) if (!known.has(id)) errors.push(`${label} references unknown ${kind} ${id}`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) errors.push(`${label} depends on itself`);
      else if (!taskIds.has(dependency)) errors.push(`${label} depends on unknown task ${dependency}`);
    }
    if (task.specialization.affectedAreas.length > 1 && task.unsplittable === null) errors.push(`${label} spans multiple domains without an unsplittable explanation`);
    if (task.unsplittable !== null) {
      if (!sameMembers(task.unsplittable.serializedDomains, task.specialization.affectedAreas)) errors.push(`${label}.unsplittable serializedDomains must exactly cover affectedAreas`);
      if (task.unsplittable.highestRiskSpecialization !== task.specialization.specialization) errors.push(`${label}.unsplittable highestRiskSpecialization must equal the task's primary specialization`);
    }
    for (const intent of task.validationIntent) if (isExecutableIntent(intent)) errors.push(`${label}.validationIntent must describe intent, not an executable command`);
    for (const path of task.anticipatedPaths) {
      if (!repositoryPathPattern.test(path)) errors.push(`${label}.anticipatedPaths contains an unsafe repository path: ${JSON.stringify(path)}`);
      if (isCommandShapedAnticipatedPath(path)) errors.push(`${label}.anticipatedPaths must describe repository paths, not commands`);
    }
  }

  for (const task of value.tasks) {
    if (transitiveDependencies(task.id, byId).has(task.id)) errors.push(`task dependency cycle includes ${task.id}`);
  }
  for (const criterion of value.criteria) {
    if (criterion.disposition === 'owned') {
      if (!taskIds.has(criterion.ownerTaskId)) errors.push(`criterion ${criterion.id} names unknown owner task ${criterion.ownerTaskId}`);
      else if (!byId.get(criterion.ownerTaskId).criterionIds.includes(criterion.id)) errors.push(`criterion ${criterion.id} owner task ${criterion.ownerTaskId} does not reference it`);
      const otherOwners = value.tasks.filter((task) => task.id !== criterion.ownerTaskId && task.criterionIds.includes(criterion.id));
      if (otherOwners.length > 0) errors.push(`criterion ${criterion.id} has contradictory ownership`);
    } else if (value.tasks.some((task) => task.criterionIds.includes(criterion.id))) errors.push(`deferred criterion ${criterion.id} must not be owned by a task`);
  }
  for (const mapping of value.checklistMappings) {
    for (const id of mapping.criterionIds) if (!criterionIds.has(id)) errors.push(`checklist item ${mapping.id} references unknown criterion ${id}`);
    for (const id of mapping.taskIds) if (!taskIds.has(id)) errors.push(`checklist item ${mapping.id} references unknown task ${id}`);
    if (mapping.criterionIds.length === 0 || mapping.taskIds.length === 0) errors.push(`checklist item ${mapping.id} lacks criterion or task coverage`);
    if ((mapping.status === 'ambiguous') !== (mapping.ambiguity !== null)) errors.push(`checklist item ${mapping.id} ambiguity must match its status`);
    if (mapping.identity.kind === 'legacy-position' && mapping.capturedText !== mapping.identity.text) errors.push(`checklist item ${mapping.id} capturedText must exactly match legacy identity text`);
    if (mapping.relationship !== value.source.relationship) errors.push(`checklist item ${mapping.id} relationship must equal the plan source relationship`);
    const referencingTaskIds = value.tasks.filter((task) => task.checklistItemIds.includes(mapping.id)).map(({ id }) => id);
    if (!sameMembers(mapping.taskIds, referencingTaskIds)) errors.push(`checklist item ${mapping.id} taskIds must exactly match task checklistItemIds back-references`);
    for (const criterionId of mapping.criterionIds) {
      const criterion = value.criteria.find(({ id }) => id === criterionId);
      if (criterion?.disposition === 'owned' && !mapping.taskIds.includes(criterion.ownerTaskId)) {
        errors.push(`checklist item ${mapping.id} criterion ${criterionId} is owned by task ${criterion.ownerTaskId} outside mapping.taskIds`);
      }
    }
  }
  for (let leftIndex = 0; leftIndex < value.tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < value.tasks.length; rightIndex += 1) {
      const left = value.tasks[leftIndex]; const right = value.tasks[rightIndex];
      for (const leftPath of left.anticipatedPaths) for (const rightPath of right.anticipatedPaths) {
        if (pathOverlaps(leftPath, rightPath)) errors.push(`tasks ${left.id} and ${right.id} have overlapping anticipated paths: ${leftPath} / ${rightPath}`);
      }
    }
  }
  const producers = new Map();
  for (const task of value.tasks) for (const artifact of task.produces) {
    if (producers.has(artifact)) errors.push(`artifact ${artifact} has multiple producers: ${producers.get(artifact)} and ${task.id}`);
    else producers.set(artifact, task.id);
  }
  for (const task of value.tasks) for (const consumption of task.consumes) {
    const { artifactId, producerTaskId } = consumption;
    const producer = producers.get(artifactId);
    if (!producer) errors.push(`task ${task.id} consumes artifact ${artifactId} with no producer`);
    else if (producer !== producerTaskId) errors.push(`task ${task.id} binds ${artifactId} to producer ${producerTaskId}, but ${producer} produces it`);
    else if (producer === task.id) errors.push(`task ${task.id} both produces and consumes artifact ${artifactId}`);
    else if (!transitiveDependencies(task.id, byId).has(producer)) errors.push(`task ${task.id} consumes ${artifactId} without depending on producer ${producer}`);
  }
  return [...new Set(errors)];
}

export function planReadiness(value, { planningEvidence = [], sourceObservation, readPlanningFile } = {}) {
  const errors = validateImplementationPlan(value, { planningEvidence, sourceObservation, readPlanningFile });
  if (errors.length === 0) {
    for (const decision of value.decisions) if (decision.status !== 'resolved') errors.push(`decision ${decision.id} is ${decision.status}`);
    for (const mapping of value.checklistMappings) {
      if (mapping.status !== 'current' || mapping.externalChange || mapping.ambiguity !== null) errors.push(`checklist item ${mapping.id} is not implementation-ready`);
    }
  }
  return { ready: errors.length === 0, errors };
}

export function validateDevelopmentState(value) {
  const errors = schemaErrors(validateStateSchema, value);
  if (errors.length > 0) return errors;
  for (const id of duplicates(value.checklist.map(({ id }) => id))) errors.push(`duplicate checklist status ID: ${id}`);
  if (value.plan === null && ['ready-to-implement'].includes(value.phase)) errors.push(`${value.phase} requires an accepted plan`);
  if (value.source.fullDigest !== value.source.latestDigest) errors.push('source fullDigest must equal latestDigest');
  if (value.phase === 'ready-to-implement') {
    if (value.unresolvedDecisionIds.length > 0) errors.push('ready-to-implement cannot have unresolved decisions');
    if (value.source.classification === 'unreviewed-material') errors.push('ready-to-implement cannot retain material source drift');
    if (!value.git.clean || value.git.headSha !== value.planningSha) errors.push('ready-to-implement requires a clean Git observation at the Planning SHA');
  }
  if (value.phase === 'awaiting-decision' && value.unresolvedDecisionIds.length === 0 && value.source.classification !== 'unreviewed-material') errors.push('awaiting-decision requires an unresolved decision or material source drift');
  if (value.phase === 'blocked' && value.blockedReasons.length === 0) errors.push('blocked requires at least one blocked reason');
  if (value.phase !== 'blocked' && value.blockedReasons.length > 0) errors.push('blocked reasons are only valid in the blocked phase');
  if (value.phase === 'abandoned' && value.abandonmentReason === null) errors.push('abandoned requires an abandonment reason');
  if (value.phase !== 'abandoned' && value.abandonmentReason !== null) errors.push('abandonmentReason is only valid in the abandoned phase');
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) errors.push('updatedAt cannot precede createdAt');
  return [...new Set(errors)];
}

export const contractPaths = Object.freeze({
  implementationPlanSchema: fileURLToPath(new URL('implementation-plan.schema.json', schemaDirectory)),
  developmentStateSchema: fileURLToPath(new URL('development-state.schema.json', schemaDirectory)),
});
