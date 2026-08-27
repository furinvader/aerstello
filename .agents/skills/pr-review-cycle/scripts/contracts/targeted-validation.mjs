import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { featureDirectory } from '../paths.mjs';
import {
  isSha,
  isString,
  parseRepositoryPath,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';

const SAFE_SELECTOR_PATTERN = /^@?[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KNOWN_E2E_PROJECTS = new Set(['tablet-chromium', 'mobile-webkit', 'desktop-firefox']);
const RECOGNIZED_AREAS = new Set(['api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration']);
const AREA_VALIDATION = new Map([
  ['api', ['npm run check:api']],
  ['web', ['npm run check:web']],
  ['shared', ['npm run check:shared', 'npm run check:api', 'npm run check:web']],
  ['workflow', ['npm run check:workflow']],
  ['documentation', []],
  ['release', ['npm run check:release-state', 'npm run check:released-migrations']],
  ['migration', ['npm run check:release-state', 'npm run check:released-migrations']],
]);
const ALLOWED_CHECK_COMMANDS = new Set([
  'npm run test:pr-review',
  'npm run check:api',
  'npm run check:web',
  'npm run check:shared',
  'npm run check:workflow',
  'npm run check:release-state',
  'npm run check:released-migrations',
]);
const ALLOWED_DIRECT_COMMANDS = new Set(['git diff --check']);
const BARE_DIFF_CHECK_ARGV = Object.freeze(['git', 'diff', '--check']);
const WRAPPER_EXECUTABLES = new Set(['env', 'bash', 'sh', 'zsh', 'fish', 'command', 'exec', 'xargs']);
const KNOWN_WORKSPACES = new Set(['@aerstello/api', '@aerstello/web', '@aerstello/shared']);
const SHELL_SYNTAX_PATTERN = /[;&|<>`$()'"\\*?\[\]{}!#~\t\v\f\r\n]/u;
const NODE_TEST_PATH_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

export function normalizeSelector(value, option = null) {
  if (!isString(value, { min: 1, max: 200 }) || !SAFE_SELECTOR_PATTERN.test(value)) return null;
  const slug = value.startsWith('@') ? value.slice(1) : value;
  return option === '--id' && !slug.startsWith('id-') ? `id-${slug}` : slug;
}

let knownE2ESelectors;
export function getKnownE2ESelectors(featureRoot) {
  if (knownE2ESelectors) return knownE2ESelectors;
  knownE2ESelectors = new Set();
  const root = featureRoot ?? featureDirectory();
  // Keep the contract registry derived from the same checked-in feature tags as the E2E runner.
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.feature')) continue;
      const source = readFileSync(entryPath, 'utf8');
      for (const match of source.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gmu)) knownE2ESelectors.add(match[1]);
    }
  }
  return knownE2ESelectors;
}

export function parseRelatedE2ECommand(command) {
  const prefix = 'npm run test:e2e:related -- ';
  if (!command.startsWith(prefix)) return null;
  const tokens = command.slice(prefix.length).trim().split(/\s+/u);
  if (tokens.length === 0 || tokens[0] === '') return null;
  const selectors = [];
  const projects = [];
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

function isSafeCommandArgument(value) {
  return isString(value, { min: 1, max: 500 })
    && !SHELL_SYNTAX_PATTERN.test(value)
    && !/^\w+=/u.test(value);
}

function isTargetedNpmTest(tokens) {
  const offset = tokens[1] === 'test' ? 2 : tokens[1] === 'run' && tokens[2] === 'test' ? 3 : -1;
  if (offset === -1 || tokens.length <= offset) return false;
  let workspaceCount = 0;
  let hasTarget = false;
  for (let index = offset; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-w' || token === '--workspace') {
      const workspace = tokens[++index];
      if (!KNOWN_WORKSPACES.has(workspace)) return false;
      workspaceCount += 1;
    } else if (token.startsWith('--workspace=')) {
      if (!KNOWN_WORKSPACES.has(token.slice('--workspace='.length))) return false;
      workspaceCount += 1;
    } else if (token === '--') {
      if (index === tokens.length - 1) return false;
      for (const target of tokens.slice(index + 1)) {
        if (target.startsWith('-') || !parseRepositoryPath(target)) return false;
      }
      hasTarget = true;
      break;
    } else {
      return false;
    }
  }
  return workspaceCount === 1 && hasTarget;
}

export function parseTargetedValidationCommand(command) {
  if (!isString(command, { min: 1, max: 500 }) || command.trim() !== command
      || /\s{2,}/u.test(command) || SHELL_SYNTAX_PATTERN.test(command)) return null;
  const tokens = command.split(' ');
  if (tokens.some((token) => !isSafeCommandArgument(token))
      || WRAPPER_EXECUTABLES.has(tokens[0]) || /^\w+=/u.test(tokens[0])) return null;
  if (ALLOWED_DIRECT_COMMANDS.has(command)) return tokens;
  if (ALLOWED_CHECK_COMMANDS.has(command)) return tokens;
  if (parseRelatedE2ECommand(command)) return tokens;
  if (tokens[0] === 'npm') return isTargetedNpmTest(tokens) ? tokens : null;
  if (tokens[0] === 'node' && tokens[1] === '--test' && tokens.length > 2) {
    return tokens.slice(2).every((path) => !path.startsWith('-')
      && parseRepositoryPath(path) && NODE_TEST_PATH_PATTERN.test(path)) ? tokens : null;
  }
  return null;
}

export function materializeTargetedValidationArgv(command, argv, { baseSha, headSha } = {}) {
  const parsed = parseTargetedValidationCommand(command);
  if (!parsed) return null;
  if (command !== 'git diff --check') {
    return JSON.stringify(argv) === JSON.stringify(parsed) ? [...argv] : null;
  }
  if (!isSha(baseSha) || !isSha(headSha)) return null;
  const expected = ['git', 'diff', '--check', baseSha, headSha, '--'];
  if (JSON.stringify(argv) === JSON.stringify(BARE_DIFF_CHECK_ARGV)
      || JSON.stringify(argv) === JSON.stringify(expected)) return expected;
  return null;
}

function isTargetedValidationCommand(command) {
  return parseTargetedValidationCommand(command) !== null;
}

export function validateAffectedAreas(value, path, errors) {
  validateStringList(value, path, errors);
  if (!Array.isArray(value)) return;
  if (value.length === 0) errors.push(`${path} must not be empty`);
  if (value.some((area) => !RECOGNIZED_AREAS.has(area))) {
    errors.push(`${path} must contain only recognized code or policy areas`);
  }
}

export function validateRequiredValidation(value, path, errors) {
  const fields = ['unit', 'system'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  const commands = [];
  for (const kind of ['unit', 'system']) {
    if (!Array.isArray(value[kind])) {
      errors.push(`${path}.${kind} must be an array`);
      continue;
    }
    value[kind].forEach((entry, index) => {
      const entryPath = `${path}.${kind}[${index}]`;
      const entryFields = kind === 'system' ? ['command', 'reason', 'selectors', 'projects'] : ['command', 'reason'];
      if (!requireFields(entry, entryFields, entryPath, errors)) return;
      rejectUnknownFields(entry, entryFields, entryPath, errors);
      if (!isString(entry.command, { min: 1, max: 500 })) errors.push(`${entryPath}.command must be 1-500 characters`);
      else {
        commands.push(entry.command);
        if (!isTargetedValidationCommand(entry.command)) {
          errors.push(`${entryPath}.command must be an allowed direct targeted command without shell or wrapper syntax`);
        }
        if (kind === 'unit' && /(?:test:e2e|(?:^|\s)playwright\s+test|(?:^|\s)bddgen(?:\s|$))/u.test(entry.command)) {
          errors.push(`${entryPath}.command must record E2E scope as a system validation`);
        }
      }
      if (!isString(entry.reason, { min: 1, max: 1000 })) errors.push(`${entryPath}.reason must be 1-1000 characters`);
      if (kind === 'system') {
        validateStringList(entry.selectors, `${entryPath}.selectors`, errors);
        validateStringList(entry.projects, `${entryPath}.projects`, errors);
        if (Array.isArray(entry.selectors) && Array.isArray(entry.projects)
            && (entry.selectors.length === 0) !== (entry.projects.length === 0)) {
          errors.push(`${entryPath}.selectors and projects must both be empty or both be nonempty`);
        }
        if (isString(entry.command, { min: 1, max: 500 })) {
          const e2eScope = parseRelatedE2ECommand(entry.command);
          const mentionsE2E = /(?:test:e2e|(?:^|\s)playwright\s+test|(?:^|\s)bddgen(?:\s|$))/u.test(entry.command);
          if (e2eScope) {
            const metadataSelectors = Array.isArray(entry.selectors)
              ? entry.selectors.map((selector) => normalizeSelector(selector)) : [];
            const selectorsKnown = metadataSelectors.every((selector) => selector && getKnownE2ESelectors().has(selector));
            const projectsKnown = Array.isArray(entry.projects)
              && entry.projects.every((project) => KNOWN_E2E_PROJECTS.has(project));
            if (!selectorsKnown) errors.push(`${entryPath}.selectors contains an unsafe or unknown E2E selector`);
            if (!projectsKnown) errors.push(`${entryPath}.projects contains an unsafe or unknown E2E project`);
            if (new Set(metadataSelectors).size !== metadataSelectors.length
                || new Set(entry.projects ?? []).size !== (entry.projects ?? []).length) {
              errors.push(`${entryPath} E2E selector and project metadata must not contain duplicates`);
            }
            if (JSON.stringify(metadataSelectors) !== JSON.stringify(e2eScope.selectors)) {
              errors.push(`${entryPath}.selectors must exactly match the command's repeatable --id/--tag scope`);
            }
            if (JSON.stringify(entry.projects) !== JSON.stringify(e2eScope.projects)) {
              errors.push(`${entryPath}.projects must exactly match the command's effective --project scope`);
            }
            if (!e2eScope.projects.every((project) => KNOWN_E2E_PROJECTS.has(project))) {
              errors.push(`${entryPath}.command contains an unsafe or unknown E2E project`);
            }
            if (!e2eScope.selectors.every((selector) => getKnownE2ESelectors().has(selector))) {
              errors.push(`${entryPath}.command contains an unsafe or unknown E2E selector`);
            }
          } else if (mentionsE2E) {
            errors.push(`${entryPath}.command must be a targeted related command, not a full-suite or local fallback`);
          } else if ((entry.selectors?.length ?? 0) !== 0 || (entry.projects?.length ?? 0) !== 0) {
            errors.push(`${entryPath} non-E2E commands require empty selector and project metadata`);
          }
        }
      }
    });
  }
  if (Array.isArray(value.unit) && Array.isArray(value.system)
      && value.unit.length === 0 && value.system.length === 0) {
    errors.push(`${path} must declare at least one exact command`);
  }
  if (new Set(commands).size !== commands.length) errors.push(`${path} contains duplicate commands`);
}

export function validateInitialValidationSelection(value) {
  const errors = [];
  const fields = ['schemaVersion', 'headSha', 'affectedAreas', 'requiredValidation'];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!isSha(value.headSha)) errors.push('$.headSha must be a full Git SHA');
  if ((value.requiredValidation?.unit?.length ?? 0) + (value.requiredValidation?.system?.length ?? 0) === 0) {
    errors.push('$.requiredValidation must select at least one targeted command');
  }
  validateAffectedAreas(value.affectedAreas, '$.affectedAreas', errors);
  validateRequiredValidation(value.requiredValidation, '$.requiredValidation', errors);
  return errors;
}

export function unionInitialValidationSelection(value) {
  const errors = [];
  const fields = ['affectedAreas', 'requiredValidation'];
  if (!requireFields(value, fields, '$', errors)) throw new TypeError(`Invalid initial validation selection: ${errors.join('; ')}`);
  rejectUnknownFields(value, fields, '$', errors);
  validateAffectedAreas(value.affectedAreas, '$.affectedAreas', errors);
  validateRequiredValidation(value.requiredValidation, '$.requiredValidation', errors);
  if (errors.length > 0) throw new TypeError(`Invalid initial validation selection: ${errors.join('; ')}`);
  return unionValidationSelections([value]);
}

export function unionValidationSelections(selections) {
  const union = { unit: [], system: [] };
  const byCommand = new Map();
  for (const selection of selections) {
    for (const kind of ['unit', 'system']) {
      for (const entry of selection.requiredValidation[kind]) {
        const existing = byCommand.get(entry.command);
        if (existing) {
          const metadataConflicts = kind === 'system' && (
            JSON.stringify(existing.entry.selectors) !== JSON.stringify(entry.selectors)
            || JSON.stringify(existing.entry.projects) !== JSON.stringify(entry.projects)
          );
          if (existing.kind !== kind || metadataConflicts) {
            throw new TypeError(`Conflicting validation scope for command: ${entry.command}`);
          }
          continue;
        }
        const copied = kind === 'system'
          ? { command: entry.command, reason: entry.reason, selectors: [...entry.selectors], projects: [...entry.projects] }
          : { command: entry.command, reason: entry.reason };
        byCommand.set(entry.command, { kind, entry: copied });
        union[kind].push(copied);
      }
    }
  }
  const affectedAreas = new Set(selections.flatMap((selection) => selection.affectedAreas));
  for (const area of AREA_VALIDATION.keys()) {
    if (!affectedAreas.has(area)) continue;
    for (const command of AREA_VALIDATION.get(area)) {
      if (byCommand.has(command)) continue;
      const copied = { command, reason: `Orchestrator integrated check for affected area: ${area}.` };
      byCommand.set(command, { kind: 'unit', entry: copied });
      union.unit.push(copied);
    }
  }
  return union;
}
