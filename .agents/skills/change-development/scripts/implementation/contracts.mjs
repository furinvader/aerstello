import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  loadRegistry, routeSpecialists, validateSpecialistEvidence, validateSpecialization,
} from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { implementationResultSchemaPath, implementationTaskSchemaPath } from '../paths.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;

export const IMPLEMENTATION_TASK_SCHEMA_VERSION = 1;
export const IMPLEMENTATION_RESULT_SCHEMA_VERSION = 1;
export const implementationTaskSchema = JSON.parse(readFileSync(implementationTaskSchemaPath, 'utf8'));
export const implementationResultSchema = JSON.parse(readFileSync(implementationResultSchemaPath, 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateTaskSchema = ajv.compile(implementationTaskSchema);
const validateResultSchema = ajv.compile(implementationResultSchema);
const RAW_FIELD_PATTERN = /^(?:raw[_-]?(?:log|diff|output)|logs?|full[_-]?(?:diff|transcript)|stack(?:trace)?|transcript)$/iu;
const SAFE_PATH_SEGMENT = /^[^/\\\0*?\[\]{}]+$/u;
const SAFE_SELECTOR = /^@?[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const E2E_PROJECTS = new Set(['tablet-chromium', 'mobile-webkit', 'desktop-firefox']);
const DIRECT_COMMANDS = new Set([
  'npm run test:change-development', 'npm run test:specialists', 'npm run test:pr-review',
  'npm run check:api', 'npm run check:web', 'npm run check:shared', 'npm run check:workflow',
  'npm run check:release-state', 'npm run check:released-migrations',
]);
const FIXED_DIFF_CHECK_COMMAND = 'git diff --check';
const WORKSPACES = new Set(['@aerstello/api', '@aerstello/web', '@aerstello/shared']);
const WRAPPERS = new Set(['env', 'bash', 'sh', 'zsh', 'fish', 'command', 'exec', 'xargs']);
const SHELL_SYNTAX = /[;&|<>`$()'"\\*?\[\]{}!#~\t\v\f\r\n]/u;
const NODE_TEST_PATH = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

function schemaErrors(validator, value) {
  if (validator(value)) return [];
  return validator.errors.map(({ instancePath, message }) => `${instancePath || '$'} ${message}`);
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sortedJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((entry) => sortedJson(entry, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}
function canonicalJsonText(value) { return `${sortedJson(value)}\n`; }
function digestJson(value) {
  return `sha256:${createHash('sha256').update(canonicalJsonText(value), 'utf8').digest('hex')}`;
}
function sameJson(left, right) { return canonicalJsonText(left) === canonicalJsonText(right); }
function findRawFields(value, path = '$', errors = []) {
  if (Array.isArray(value)) value.forEach((entry, index) => findRawFields(entry, `${path}[${index}]`, errors));
  else if (isRecord(value)) for (const [key, entry] of Object.entries(value)) {
    if (RAW_FIELD_PATTERN.test(key)) errors.push(`${path}.${key} is not allowed in an implementation contract`);
    findRawFields(entry, `${path}.${key}`, errors);
  }
  return errors;
}
function parseRepositoryPath(value, { allowOwnershipPattern = false } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500
      || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('//')) return null;
  const suffix = allowOwnershipPattern && value.endsWith('/**') ? '/**' : '';
  const path = suffix ? value.slice(0, -suffix.length) : value;
  if (path.split('/').some((part) => part === '.' || part === '..' || part === '.git'
      || !SAFE_PATH_SEGMENT.test(part))) return null;
  return { path, recursive: suffix !== '' };
}
export function pathMatchesOwnership(changedPath, ownershipPattern) {
  const changed = parseRepositoryPath(changedPath);
  const owned = parseRepositoryPath(ownershipPattern, { allowOwnershipPattern: true });
  return Boolean(changed && owned && (changed.path === owned.path
    || (owned.recursive && changed.path.startsWith(`${owned.path}/`))));
}
function safeToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
    && !SHELL_SYNTAX.test(value) && !/^\w+=/u.test(value);
}
function targetedNpmTest(tokens) {
  const offset = tokens[1] === 'test' ? 2 : tokens[1] === 'run' && tokens[2] === 'test' ? 3 : -1;
  if (offset === -1 || tokens.length <= offset) return false;
  let workspaces = 0;
  let target = false;
  for (let index = offset; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-w' || token === '--workspace') {
      if (!WORKSPACES.has(tokens[++index])) return false;
      workspaces += 1;
    } else if (token.startsWith('--workspace=')) {
      if (!WORKSPACES.has(token.slice('--workspace='.length))) return false;
      workspaces += 1;
    } else if (token === '--') {
      if (index === tokens.length - 1
          || tokens.slice(index + 1).some((path) => path.startsWith('-') || !parseRepositoryPath(path))) return false;
      target = true;
      break;
    } else return false;
  }
  return workspaces === 1 && target;
}
function normalizeSelector(value, option = null) {
  if (typeof value !== 'string' || value.length > 200 || !SAFE_SELECTOR.test(value)) return null;
  const slug = value.startsWith('@') ? value.slice(1) : value;
  return option === '--id' && !slug.startsWith('id-') ? `id-${slug}` : slug;
}
function parseRelatedE2E(command) {
  const prefix = 'npm run test:e2e:related -- ';
  if (!command.startsWith(prefix)) return null;
  const tokens = command.slice(prefix.length).trim().split(/\s+/u);
  const selectors = [];
  const projects = [];
  if (tokens.length === 0 || tokens[0] === '') return null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equalsAt = token.indexOf('=');
    const option = equalsAt === -1 ? token : token.slice(0, equalsAt);
    if (!['--id', '--tag', '--project'].includes(option)) return null;
    const value = equalsAt === -1 ? tokens[++index] : token.slice(equalsAt + 1);
    if (!value) return null;
    if (option === '--project') projects.push(value);
    else {
      const selector = normalizeSelector(value, option);
      if (!selector) return null;
      selectors.push(selector);
    }
  }
  if (selectors.length === 0) return null;
  return { selectors, projects: projects.length === 0 ? ['tablet-chromium'] : projects };
}

export function parseImplementationValidationCommand(command) {
  if (typeof command !== 'string' || command.length < 1 || command.length > 500
      || command.trim() !== command || /\s{2,}/u.test(command) || SHELL_SYNTAX.test(command)) return null;
  const tokens = command.split(' ');
  if (tokens.some((token) => !safeToken(token)) || WRAPPERS.has(tokens[0])) return null;
  if (DIRECT_COMMANDS.has(command) || command === FIXED_DIFF_CHECK_COMMAND || parseRelatedE2E(command)) return tokens;
  if (tokens[0] === 'npm') return targetedNpmTest(tokens) ? tokens : null;
  if (tokens[0] === 'node' && tokens[1] === '--test' && tokens.length > 2
      && tokens.slice(2).every((path) => !path.startsWith('-')
        && parseRepositoryPath(path) && NODE_TEST_PATH.test(path))) return tokens;
  return null;
}

function validateRequiredValidation(value, errors, packet) {
  if (!isRecord(value) || !Array.isArray(value.unit) || !Array.isArray(value.system)) return;
  const commands = [];
  for (const kind of ['unit', 'system']) for (const [index, entry] of value[kind].entries()) {
    const path = `$.requiredValidation.${kind}[${index}]`;
    if (!isRecord(entry) || typeof entry.command !== 'string') continue;
    commands.push(entry.command);
    if (!parseImplementationValidationCommand(entry.command)) {
      errors.push(`${path}.command must be an allowed direct targeted command without shell or wrapper syntax`);
    }
    const e2e = parseRelatedE2E(entry.command);
    const mentionsE2E = /(?:test:e2e|(?:^|\s)playwright\s+test|(?:^|\s)bddgen(?:\s|$))/u.test(entry.command);
    if (kind === 'unit' && mentionsE2E) errors.push(`${path}.command must record E2E scope as system validation`);
    if (kind !== 'system') continue;
    if (e2e) {
      const selectors = Array.isArray(entry.selectors) ? entry.selectors.map((item) => normalizeSelector(item)) : [];
      if (selectors.some((item) => !item)) errors.push(`${path}.selectors contains an unsafe E2E selector`);
      if (!Array.isArray(entry.projects) || entry.projects.some((item) => !E2E_PROJECTS.has(item))) errors.push(`${path}.projects contains an unsafe or unknown E2E project`);
      if (!sameJson(selectors, e2e.selectors)) errors.push(`${path}.selectors must exactly match the command's repeatable --id/--tag scope`);
      if (!sameJson(entry.projects, e2e.projects)) errors.push(`${path}.projects must exactly match the command's effective --project scope`);
      if (e2e.projects.some((item) => !E2E_PROJECTS.has(item))) errors.push(`${path}.command contains an unsafe or unknown E2E project`);
      if (e2e.selectors.some((item) => !item)) errors.push(`${path}.command contains an unsafe E2E selector`);
    } else if (mentionsE2E) errors.push(`${path}.command must be a targeted related command, not a full-suite or local fallback`);
    else if ((entry.selectors?.length ?? 0) !== 0 || (entry.projects?.length ?? 0) !== 0) errors.push(`${path} non-E2E commands require empty selector and project metadata`);
  }
  if (commands.length === 0) errors.push('$.requiredValidation must contain at least one unit or system command');
  if (new Set(commands).size !== commands.length) errors.push('$.requiredValidation contains duplicate commands');
  const planned = packet.plannedE2ESelectors ?? [];
  const plannedNames = planned.map(({ selector }) => selector);
  if (new Set(plannedNames).size !== plannedNames.length) errors.push('$.plannedE2ESelectors contains a duplicate selector');
  const usedSelectors = value.system.flatMap((entry) => Array.isArray(entry.selectors)
    ? entry.selectors.map((selector) => normalizeSelector(selector)).filter(Boolean) : []);
  for (const [index, entry] of planned.entries()) {
    const path = `$.plannedE2ESelectors[${index}]`;
    if (!entry.featurePath.startsWith('specs/features/') || !entry.featurePath.endsWith('.feature')) {
      errors.push(`${path}.featurePath must name a feature file below specs/features`);
    }
    if (!packet.allowedPaths.some((pattern) => pathMatchesOwnership(entry.featurePath, pattern))) {
      errors.push(`${path}.featurePath must be owned by allowedPaths`);
    }
    if (packet.forbiddenPaths.some((pattern) => pathMatchesOwnership(entry.featurePath, pattern))) {
      errors.push(`${path}.featurePath must not be forbidden`);
    }
    if (!usedSelectors.includes(entry.selector)) errors.push(`${path}.selector must be used by required system validation`);
  }
}

export function validateImplementationTaskStructure(value) {
  const errors = schemaErrors(validateTaskSchema, value);
  findRawFields(value, '$', errors);
  if (errors.length > 0) return [...new Set(errors)];
  if (value.planningSignals.relatedTestSelectionUncertain) errors.push('$.planningSignals.relatedTestSelectionUncertain must be resolved before binding');
  const needsMapper = value.specialistRoute.planningHelpers.some(({ id }) => id === 'behavior_mapper');
  if (needsMapper) {
    if (value.behaviorMapperEvidence === null) errors.push('$.behaviorMapperEvidence is required by the receipt-bound specialist route');
    else {
      errors.push(...validateSpecialistEvidence({ evidence: [value.behaviorMapperEvidence], route: value.specialistRoute,
        subjectSha: value.planningSha, phase: 'planning' }).map((error) => `$.behaviorMapperEvidence: ${error}`));
      if (value.behaviorMapperEvidence.planRevision !== value.planRevision) errors.push('$.behaviorMapperEvidence.planRevision must equal the packet planRevision');
      if (value.behaviorMapperEvidence.status !== 'clean') errors.push('$.behaviorMapperEvidence.status must be clean before binding');
      if (value.behaviorMapperEvidence.status === 'clean' && value.behaviorMapperEvidence.findings.length !== 0) errors.push('$.behaviorMapperEvidence.findings must be empty when status is clean');
    }
  } else if (value.behaviorMapperEvidence !== null) errors.push('$.behaviorMapperEvidence must be null when the receipt-bound specialist route does not require behavior_mapper');
  if (!sameJson(value.decisionContext.map(({ id }) => id), value.decisionIds)) {
    errors.push('$.decisionContext IDs must exactly match decisionIds');
  }
  if (!sameJson(value.acceptanceCriteria.map(({ id }) => id), value.acceptanceCriteriaIds)) {
    errors.push('$.acceptanceCriteria IDs must exactly match acceptanceCriteriaIds');
  }
  validateRequiredValidation(value.requiredValidation, errors, value);
  return [...new Set(errors)];
}

export function validateImplementationTask(value, { registry = loadRegistry() } = {}) {
  const errors = validateImplementationTaskStructure(value);
  if (errors.length > 0) return errors;
  errors.push(...validateSpecialization({ specialization: value.specialization,
    affectedAreas: value.affectedAreas, riskTags: value.riskTags }, registry)
    .map((error) => `$.specialization: ${error}`));
  let route;
  try {
    route = routeSpecialists({ specialization: value.specialization, riskTags: value.riskTags,
      browserVisible: value.planningSignals.browserVisible,
      testSelectionUncertain: value.planningSignals.relatedTestSelectionUncertain }, registry);
  } catch (error) {
    errors.push(`$.specialistRoute cannot be derived from the current specialist registry: ${error.message}`);
    return [...new Set(errors)];
  }
  if (!sameJson(value.specialistRoute, route)) errors.push('$.specialistRoute must equal the canonical specialist route');
  return [...new Set(errors)];
}

export function validateImplementationResult(value) {
  const errors = schemaErrors(validateResultSchema, value);
  findRawFields(value, '$', errors);
  if (errors.length > 0) return [...new Set(errors)];
  if (['implemented', 'no-change'].includes(value.status) && value.validation.some(({ result }) => result !== 'passed')) errors.push('$.validation must contain only passed commands for a successful result');
  if (new Set(value.validation.map(({ command }) => command)).size !== value.validation.length) errors.push('$.validation must not report a command more than once');
  return [...new Set(errors)];
}

export function implementationTaskDigest(packet) {
  const errors = validateImplementationTaskStructure(packet);
  if (errors.length > 0) throw new TypeError(`invalid implementation task packet: ${errors.join('; ')}`);
  return digestJson(packet);
}

export function validateImplementationResultAgainstTask(packet, result, actualChangedPaths) {
  const errors = [...validateImplementationTaskStructure(packet).map((error) => `task packet: ${error}`),
    ...validateImplementationResult(result).map((error) => `worker result: ${error}`)];
  if (errors.length > 0) return [...new Set(errors)];
  for (const field of ['changeId', 'taskId', 'planDigest', 'specialization', 'taskBaseSha']) {
    if (result[field] !== packet[field]) errors.push(`worker result ${field} must equal task packet ${field}`);
  }
  if (result.packetDigest !== implementationTaskDigest(packet)) errors.push('worker result packetDigest must equal the canonical task packet digest');
  if (result.status === 'no-change' && (packet.plannedE2ESelectors?.length ?? 0) > 0) {
    errors.push('worker result cannot be no-change when the task packet declares planned E2E selectors');
  }
  const paths = result.status === 'implemented' && Array.isArray(actualChangedPaths) ? actualChangedPaths : result.changedPaths;
  if (result.status === 'implemented') {
    if (!Array.isArray(actualChangedPaths)) errors.push('implemented worker result requires actual Git changed paths');
    else {
      if (actualChangedPaths.length === 0) errors.push('implemented worker commit must contain at least one changed path');
      if (new Set(actualChangedPaths).size !== actualChangedPaths.length) errors.push('actual Git changed paths must not contain duplicates');
      actualChangedPaths.forEach((path, index) => { if (!parseRepositoryPath(path)) errors.push(`actual Git changed path ${index} is not a safe repository-relative file path`); });
      const reported = new Set(result.changedPaths); const actual = new Set(actualChangedPaths);
      if (reported.size !== actual.size || [...reported].some((path) => !actual.has(path))) errors.push('worker result changedPaths must exactly equal the actual Git commit diff');
    }
  }
  for (const path of paths) {
    if (!packet.allowedPaths.some((pattern) => pathMatchesOwnership(path, pattern))) errors.push(`worker result changed path is outside allowedPaths: ${path}`);
    if (packet.forbiddenPaths.some((pattern) => pathMatchesOwnership(path, pattern))) errors.push(`worker result changed path is forbidden: ${path}`);
  }
  const declared = new Set([...packet.requiredValidation.unit, ...packet.requiredValidation.system].map(({ command }) => command));
  const reported = new Map(result.validation.map(({ command, result: outcome }) => [command, outcome]));
  for (const command of reported.keys()) if (!declared.has(command)) errors.push(`worker result reports undeclared command: ${command}`);
  for (const command of declared) {
    if (!reported.has(command)) errors.push(`required validation was not reported: ${command}`);
    else if (['implemented', 'no-change'].includes(result.status) && reported.get(command) !== 'passed') errors.push(`required validation did not pass: ${command}`);
  }
  return [...new Set(errors)];
}

export const implementationContractPaths = Object.freeze({
  implementationTaskSchema: implementationTaskSchemaPath,
  implementationResultSchema: implementationResultSchemaPath,
});
