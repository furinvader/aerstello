import { readdirSync, readFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RAW_FIELD_PATTERN = /^(?:raw[_-]?(?:log|diff|output)|logs?|full[_-]?(?:diff|review|transcript)|stack(?:trace)?|transcript)$/iu;
const SAFE_REPOSITORY_SEGMENT_PATTERN = /^[^/\\\0*?\[\]{}]+$/u;
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
  'npm run check:api',
  'npm run check:web',
  'npm run check:shared',
  'npm run check:workflow',
  'npm run check:release-state',
  'npm run check:released-migrations',
]);
const WRAPPER_EXECUTABLES = new Set(['env', 'bash', 'sh', 'zsh', 'fish', 'command', 'exec', 'xargs']);
const KNOWN_WORKSPACES = new Set(['@sky-bar/api', '@sky-bar/web', '@sky-bar/shared']);
const SHELL_SYNTAX_PATTERN = /[;&|<>`$()'"\\*?\[\]{}!#~\t\v\f\r\n]/u;
const NODE_TEST_PATH_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

export const STATE_PHASES = [
  'recovering',
  'ready-for-review',
  'awaiting-review',
  'triaging',
  'implementing',
  'integrating',
  'verifying',
  'validating',
  'awaiting-human-decision',
  'blocked',
  'complete',
];

const STATE_PHASES_V1 = STATE_PHASES.filter((phase) => phase !== 'awaiting-human-decision');

export const TASK_STATUSES = [
  'proposed',
  'queued',
  'running',
  'implemented',
  'integrated',
  'completed',
  'blocked',
  'not-applicable',
  'failed',
];

export const FINDING_DISPOSITIONS = [
  'actionable',
  'duplicate',
  'already-fixed',
  'stale',
  'invalid',
  'policy-conflict',
  'out-of-scope',
  'needs-human-decision',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isSha(value, nullable = false) {
  return nullable && value === null ? true : typeof value === 'string' && SHA_PATTERN.test(value);
}

function isDateTime(value, nullable = false) {
  return nullable && value === null
    ? true
    : typeof value === 'string' && DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isHttpsUrl(value) {
  if (!isString(value, { min: 1, max: 2000 })) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function requireFields(value, fields, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const field of fields) {
    if (!(field in value)) errors.push(`${path}.${field} is required`);
  }
  return true;
}

function rejectUnknownFields(value, fields, path, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${path}.${field} is not supported`);
  }
}

function findRawFields(value, path = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRawFields(item, `${path}[${index}]`, errors));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (RAW_FIELD_PATTERN.test(key)) errors.push(`${path}.${key} is not allowed in active state`);
      findRawFields(item, `${path}.${key}`, errors);
    }
  }
  return errors;
}

function validateValidationEntry(entry, path, errors) {
  if (!requireFields(entry, ['command', 'result', 'summary'], path, errors)) return;
  if (!isString(entry.command, { min: 1, max: 500 })) errors.push(`${path}.command must be 1-500 characters`);
  if (!['passed', 'failed', 'skipped'].includes(entry.result)) errors.push(`${path}.result is invalid`);
  if (!isString(entry.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary must be 1-1000 characters`);
}

function parseRepositoryPath(value, { allowOwnershipPattern = false } = {}) {
  if (!isString(value, { min: 1, max: 500 }) || value.startsWith('/') || value.endsWith('/')
      || value.includes('\\') || value.includes('//')) return null;
  const suffix = allowOwnershipPattern && value.endsWith('/**') ? '/**' : '';
  const path = suffix ? value.slice(0, -suffix.length) : value;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..'
      || !SAFE_REPOSITORY_SEGMENT_PATTERN.test(segment))) return null;
  return { path, recursive: suffix !== '' };
}

function pathMatchesOwnership(changedPath, ownershipPattern) {
  const changed = parseRepositoryPath(changedPath);
  const ownership = parseRepositoryPath(ownershipPattern, { allowOwnershipPattern: true });
  if (!changed || !ownership) return false;
  return changed.path === ownership.path
    || (ownership.recursive && changed.path.startsWith(`${ownership.path}/`));
}

function normalizeSelector(value, option = null) {
  if (!isString(value, { min: 1, max: 200 }) || !SAFE_SELECTOR_PATTERN.test(value)) return null;
  const slug = value.startsWith('@') ? value.slice(1) : value;
  return option === '--id' && !slug.startsWith('id-') ? `id-${slug}` : slug;
}

let knownE2ESelectors;
function getKnownE2ESelectors() {
  if (knownE2ESelectors) return knownE2ESelectors;
  knownE2ESelectors = new Set();
  const featureRoot = new URL('../../specs/features/', import.meta.url);
  // Keep the contract registry derived from the same checked-in feature tags as the E2E runner.
  const pending = [featureRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        pending.push(new URL(`${entry.name}/`, directory));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.feature')) continue;
      const source = readFileSync(entryUrl, 'utf8');
      for (const match of source.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gmu)) knownE2ESelectors.add(match[1]);
    }
  }
  return knownE2ESelectors;
}

function parseRelatedE2ECommand(command) {
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
  if (ALLOWED_CHECK_COMMANDS.has(command)) return tokens;
  if (parseRelatedE2ECommand(command)) return tokens;
  if (tokens[0] === 'npm') return isTargetedNpmTest(tokens) ? tokens : null;
  if (tokens[0] === 'node' && tokens[1] === '--test' && tokens.length > 2) {
    return tokens.slice(2).every((path) => !path.startsWith('-')
      && parseRepositoryPath(path) && NODE_TEST_PATH_PATTERN.test(path)) ? tokens : null;
  }
  return null;
}

function isTargetedValidationCommand(command) {
  return parseTargetedValidationCommand(command) !== null;
}

export function validateWorkerResult(value) {
  const errors = [];
  const fields = [
    'schemaVersion',
    'taskId',
    'status',
    'commitSha',
    'changedPaths',
    'validation',
    'resolutionSummary',
    'residualRisks',
    'unexpectedDependencies',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 2) errors.push('$.schemaVersion must equal 2');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!['implemented', 'blocked', 'not-applicable', 'failed'].includes(value.status)) errors.push('$.status is invalid');
  if (value.status === 'implemented' ? !isSha(value.commitSha) : !isSha(value.commitSha, true)) {
    errors.push('$.commitSha must be a full Git SHA when implemented and otherwise may be null');
  }
  if (!Array.isArray(value.changedPaths) || value.changedPaths.some((path) => !isString(path, { min: 1, max: 500 }))) {
    errors.push('$.changedPaths must contain repository-relative paths');
  } else {
    value.changedPaths.forEach((path, index) => {
      if (!parseRepositoryPath(path)) errors.push(`$.changedPaths[${index}] must be a safe repository-relative file path`);
    });
    if (new Set(value.changedPaths).size !== value.changedPaths.length) {
      errors.push('$.changedPaths must not contain duplicates');
    }
  }
  if (!Array.isArray(value.validation)) errors.push('$.validation must be an array');
  else value.validation.forEach((entry, index) => validateValidationEntry(entry, `$.validation[${index}]`, errors));
  if (!isString(value.resolutionSummary, { min: 1, max: 2000 })) errors.push('$.resolutionSummary must be 1-2000 characters');
  for (const field of ['residualRisks', 'unexpectedDependencies']) {
    if (!Array.isArray(value[field]) || value[field].some((item) => !isString(item, { min: 1, max: 1000 }))) {
      errors.push(`$.${field} must be an array of concise strings`);
    }
  }
  findRawFields(value, '$', errors);
  return errors;
}

export function validateTaskPacket(value) {
  const errors = [];
  const fields = [
    'schemaVersion',
    'taskId',
    'reviewedHeadSha',
    'finding',
    'evidence',
    'affectedAreas',
    'decisionIds',
    'allowedPaths',
    'forbiddenPaths',
    'dependencies',
    'acceptanceCriteria',
    'requiredValidation',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 2) errors.push('$.schemaVersion must equal 2');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!isSha(value.reviewedHeadSha)) errors.push('$.reviewedHeadSha must be a full Git SHA');
  if (!isString(value.finding, { min: 1, max: 2000 })) errors.push('$.finding must be concise');
  if (!isString(value.evidence, { min: 1, max: 3000 })) errors.push('$.evidence must be concise');
  for (const field of ['decisionIds', 'affectedAreas', 'allowedPaths', 'forbiddenPaths', 'dependencies', 'acceptanceCriteria']) {
    validateStringList(value[field], `$.${field}`, errors);
  }
  if (Array.isArray(value.affectedAreas) && value.affectedAreas.length === 0) errors.push('$.affectedAreas must not be empty');
  if (Array.isArray(value.affectedAreas)
      && value.affectedAreas.some((area) => !RECOGNIZED_AREAS.has(area))) {
    errors.push('$.affectedAreas must contain only recognized code or policy areas');
  }
  if (Array.isArray(value.allowedPaths) && value.allowedPaths.length === 0) errors.push('$.allowedPaths must not be empty');
  for (const field of ['allowedPaths', 'forbiddenPaths']) {
    if (Array.isArray(value[field])) value[field].forEach((path, index) => {
      if (!parseRepositoryPath(path, { allowOwnershipPattern: true })) {
        errors.push(`$.${field}[${index}] must be a safe repository-relative path or trailing /** pattern`);
      }
    });
  }
  validateRequiredValidation(value.requiredValidation, '$.requiredValidation', errors);
  findRawFields(value, '$', errors);
  return errors;
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
  const packetErrors = validateTaskPacket({
    schemaVersion: 2,
    taskId: 'initial-validation-selection',
    reviewedHeadSha: value.headSha,
    finding: 'Initial pull-request validation selection.',
    evidence: 'Explicit orchestrator-selected validation before the first discovery review.',
    affectedAreas: value.affectedAreas,
    decisionIds: [],
    allowedPaths: ['scripts/**'],
    forbiddenPaths: [],
    dependencies: [],
    acceptanceCriteria: ['The selected initial checks pass.'],
    requiredValidation: value.requiredValidation,
  });
  errors.push(...packetErrors.map((error) => `$.selection ${error}`));
  return errors;
}

function validateRequiredValidation(value, path, errors) {
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

export function validateWorkerResultAgainstTask(packet, result, actualChangedPaths) {
  const errors = [
    ...validateTaskPacket(packet).map((error) => `task packet: ${error}`),
    ...validateWorkerResult(result).map((error) => `worker result: ${error}`),
  ];
  if (errors.length > 0) return errors;
  if (result.taskId !== packet.taskId) errors.push('worker result taskId must equal task packet taskId');
  if (new Set(result.changedPaths).size !== result.changedPaths.length) {
    errors.push('worker result changedPaths must not contain duplicates');
  }
  if (result.status === 'implemented' && !Array.isArray(actualChangedPaths)) {
    errors.push('implemented worker result requires actual Git changed paths');
  }
  const pathsToCheck = result.status === 'implemented' && Array.isArray(actualChangedPaths)
    ? actualChangedPaths : result.changedPaths;
  if (result.status === 'implemented' && Array.isArray(actualChangedPaths)) {
    if (actualChangedPaths.length === 0) errors.push('implemented worker commit must contain at least one changed path');
    if (new Set(actualChangedPaths).size !== actualChangedPaths.length) {
      errors.push('actual Git changed paths must not contain duplicates');
    }
    for (const [index, path] of actualChangedPaths.entries()) {
      if (!parseRepositoryPath(path)) errors.push(`actual Git changed path ${index} is not a safe repository-relative file path`);
    }
    const reported = new Set(result.changedPaths);
    const actual = new Set(actualChangedPaths);
    if (reported.size !== actual.size || [...reported].some((path) => !actual.has(path))) {
      errors.push('worker result changedPaths must exactly equal the actual Git commit diff');
    }
  }
  for (const path of pathsToCheck) {
    if (!packet.allowedPaths.some((pattern) => pathMatchesOwnership(path, pattern))) {
      errors.push(`worker result changed path is outside allowedPaths: ${path}`);
    }
    if (packet.forbiddenPaths.some((pattern) => pathMatchesOwnership(path, pattern))) {
      errors.push(`worker result changed path is forbidden: ${path}`);
    }
  }
  const declared = new Set([
    ...packet.requiredValidation.unit.map((entry) => entry.command),
    ...packet.requiredValidation.system.map((entry) => entry.command),
  ]);
  const reported = new Map();
  for (const entry of result.validation) {
    if (reported.has(entry.command)) errors.push(`worker result reports command more than once: ${entry.command}`);
    reported.set(entry.command, entry.result);
    if (!declared.has(entry.command)) {
      errors.push(`worker result reports undeclared command: ${entry.command}`);
    }
  }
  for (const command of declared) {
    if (!reported.has(command)) errors.push(`required validation was not reported: ${command}`);
    else if (result.status === 'implemented' && reported.get(command) !== 'passed') {
      errors.push(`required validation did not pass: ${command}`);
    }
  }
  return errors;
}

export function unionRequiredValidation(taskPackets) {
  if (!Array.isArray(taskPackets)) throw new TypeError('taskPackets must be an array');
  const union = { unit: [], system: [] };
  const byCommand = new Map();
  taskPackets.forEach((packet, index) => {
    const errors = validateTaskPacket(packet);
    if (errors.length > 0) throw new TypeError(`Invalid task packet ${index}: ${errors.join('; ')}`);
    for (const kind of ['unit', 'system']) {
      for (const entry of packet.requiredValidation[kind]) {
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
  });
  const affectedAreas = new Set(taskPackets.flatMap((packet) => packet.affectedAreas));
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

function validateTaskV1(task, index, errors) {
  const path = `$.tasks[${index}]`;
  const fields = [
    'id', 'sourceIds', 'fingerprint', 'summary', 'severity', 'disposition', 'status', 'dependencies',
    'ownedPaths', 'worker', 'branch', 'worktree', 'commitSha', 'validationSummaries', 'lastError',
  ];
  if (!requireFields(task, fields, path, errors)) return;
  rejectUnknownFields(task, fields, path, errors);
  if (!isString(task.id, { min: 1, max: 128 })) errors.push(`${path}.id is invalid`);
  if (!Array.isArray(task.sourceIds) || task.sourceIds.some((id) => !isString(id, { min: 1, max: 256 }))) errors.push(`${path}.sourceIds is invalid`);
  if (!isString(task.fingerprint, { min: 8, max: 256 })) errors.push(`${path}.fingerprint is invalid`);
  if (!isString(task.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary is invalid`);
  if (!['P0', 'P1', 'P2', 'P3'].includes(task.severity)) errors.push(`${path}.severity is invalid`);
  if (!FINDING_DISPOSITIONS.includes(task.disposition)) errors.push(`${path}.disposition is invalid`);
  if (!TASK_STATUSES.includes(task.status)) errors.push(`${path}.status is invalid`);
  for (const field of ['dependencies', 'ownedPaths', 'validationSummaries']) {
    if (!Array.isArray(task[field]) || task[field].some((item) => !isString(item, { min: 1, max: 1000 }))) errors.push(`${path}.${field} is invalid`);
  }
  for (const field of ['worker', 'branch', 'worktree', 'lastError']) {
    if (!(task[field] === null || isString(task[field], { min: 1, max: 1000 }))) errors.push(`${path}.${field} is invalid`);
  }
  if (!isSha(task.commitSha, true)) errors.push(`${path}.commitSha is invalid`);
}

export function validatePrReviewStateV1(value) {
  const errors = [];
  const fields = [
    'schemaVersion', 'revision', 'repository', 'prNumber', 'phase', 'baseSha', 'requestedHeadSha',
    'reviewedHeadSha', 'currentIntegrationHeadSha', 'reviewRound', 'releaseBaseline', 'decisions',
    'tasks', 'reviewRequest', 'reviewSubmission', 'blockedReasons', 'validationStatus', 'nextAction',
    'integrationWorktree', 'orchestratorSessionId', 'git', 'updatedAt',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!Number.isInteger(value.revision) || value.revision < 0) errors.push('$.revision must be a non-negative integer');
  if (!isString(value.repository, { min: 3, max: 256 }) || !value.repository.includes('/')) errors.push('$.repository must be owner/name');
  if (!Number.isInteger(value.prNumber) || value.prNumber < 1) errors.push('$.prNumber must be a positive integer');
  if (!STATE_PHASES_V1.includes(value.phase)) errors.push('$.phase is invalid');
  for (const field of ['baseSha', 'currentIntegrationHeadSha']) if (!isSha(value[field])) errors.push(`$.${field} is invalid`);
  for (const field of ['requestedHeadSha', 'reviewedHeadSha']) if (!isSha(value[field], true)) errors.push(`$.${field} is invalid`);
  if (!Number.isInteger(value.reviewRound) || value.reviewRound < 0 || value.reviewRound > 3) errors.push('$.reviewRound must be between 0 and 3');
  if (!(value.releaseBaseline === null || (
    isObject(value.releaseBaseline)
    && Object.keys(value.releaseBaseline).every((key) => ['version', 'tag', 'commit', 'releasedAt'].includes(key))
    && isString(value.releaseBaseline.version, { min: 1, max: 128 })
    && isString(value.releaseBaseline.tag, { min: 1, max: 128 })
    && isSha(value.releaseBaseline.commit)
    && isDateTime(value.releaseBaseline.releasedAt)
  ))) errors.push('$.releaseBaseline is invalid');
  if (!Array.isArray(value.decisions)) errors.push('$.decisions must be an array');
  else value.decisions.forEach((decision, index) => {
    const path = `$.decisions[${index}]`;
    if (requireFields(decision, ['id', 'summary'], path, errors)) {
      rejectUnknownFields(decision, ['id', 'summary'], path, errors);
      if (!isString(decision.id, { min: 1, max: 128 })) errors.push(`${path}.id is invalid`);
      if (!isString(decision.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary is invalid`);
    }
  });
  if (!Array.isArray(value.tasks)) errors.push('$.tasks must be an array');
  else value.tasks.forEach((task, index) => validateTaskV1(task, index, errors));
  for (const field of ['reviewRequest', 'reviewSubmission']) {
    const metadata = value[field];
    if (metadata === null) continue;
    const path = `$.${field}`;
    const reviewFields = ['id', 'databaseId', 'url', 'headSha', 'at'];
    if (!requireFields(metadata, reviewFields, path, errors)) continue;
    rejectUnknownFields(metadata, reviewFields, path, errors);
    if (!isString(metadata.id, { min: 1, max: 256 })) errors.push(`${path}.id is invalid`);
    if (!(metadata.databaseId === null || (Number.isInteger(metadata.databaseId) && metadata.databaseId >= 1))) errors.push(`${path}.databaseId is invalid`);
    if (!isString(metadata.url, { min: 1, max: 2000 })) errors.push(`${path}.url is invalid`);
    if (!isSha(metadata.headSha)) errors.push(`${path}.headSha is invalid`);
    if (!isDateTime(metadata.at)) errors.push(`${path}.at is invalid`);
  }
  if (!Array.isArray(value.blockedReasons) || value.blockedReasons.some((item) => !isString(item, { min: 1, max: 1000 }))) errors.push('$.blockedReasons is invalid');
  if (!isObject(value.validationStatus)) errors.push('$.validationStatus must be an object');
  else {
    const validationFields = ['status', 'headSha', 'checks', 'updatedAt'];
    requireFields(value.validationStatus, validationFields, '$.validationStatus', errors);
    rejectUnknownFields(value.validationStatus, validationFields, '$.validationStatus', errors);
    if (!['not-run', 'passed', 'failed'].includes(value.validationStatus.status)) errors.push('$.validationStatus.status is invalid');
    if (!isSha(value.validationStatus.headSha, true)) errors.push('$.validationStatus.headSha is invalid');
    if (!Array.isArray(value.validationStatus.checks) || value.validationStatus.checks.some((item) => !isString(item, { min: 1, max: 1000 }))) errors.push('$.validationStatus.checks is invalid');
    if (!isDateTime(value.validationStatus.updatedAt, true)) errors.push('$.validationStatus.updatedAt is invalid');
  }
  if (!isString(value.nextAction, { min: 1, max: 1000 })) errors.push('$.nextAction is invalid');
  if (!isString(value.integrationWorktree, { min: 1, max: 4096 }) || !value.integrationWorktree.startsWith('/')) errors.push('$.integrationWorktree must be absolute');
  if (!(value.orchestratorSessionId === null || isString(value.orchestratorSessionId, { min: 1, max: 256 }))) errors.push('$.orchestratorSessionId is invalid');
  if (!isObject(value.git)) errors.push('$.git must be an object');
  else {
    const gitFields = ['branch', 'headSha', 'dirty'];
    requireFields(value.git, gitFields, '$.git', errors);
    rejectUnknownFields(value.git, gitFields, '$.git', errors);
    if (!(value.git.branch === null || isString(value.git.branch, { min: 1, max: 1000 }))) errors.push('$.git.branch is invalid');
    if (!isSha(value.git.headSha)) errors.push('$.git.headSha is invalid');
    if (typeof value.git.dirty !== 'boolean') errors.push('$.git.dirty is invalid');
  }
  if (Array.isArray(value.tasks)) {
    const taskIds = value.tasks.map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) errors.push('$.tasks contains duplicate IDs');
  }
  if (Array.isArray(value.decisions)) {
    const decisionIds = value.decisions.map((decision) => decision.id);
    if (new Set(decisionIds).size !== decisionIds.length) errors.push('$.decisions contains duplicate IDs');
  }
  if (!isDateTime(value.updatedAt)) errors.push('$.updatedAt must be an RFC 3339 UTC timestamp');
  findRawFields(value, '$', errors);
  return errors;
}

function validateStringList(value, path, errors, max = 1000) {
  if (!Array.isArray(value) || value.some((item) => !isString(item, { min: 1, max }))) {
    errors.push(`${path} is invalid`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} contains duplicates`);
}

function validateBaseEvidence(value, path, fields, errors) {
  if (!requireFields(value, fields, path, errors)) return false;
  rejectUnknownFields(value, fields, path, errors);
  if (!isString(value.id, { min: 1, max: 256 })) errors.push(`${path}.id is invalid`);
  if (!(value.databaseId === null || (Number.isInteger(value.databaseId) && value.databaseId >= 1))) {
    errors.push(`${path}.databaseId is invalid`);
  }
  if (!isHttpsUrl(value.url)) errors.push(`${path}.url must be an HTTPS URL`);
  if (!isSha(value.headSha)) errors.push(`${path}.headSha is invalid`);
  if (!isDateTime(value.at)) errors.push(`${path}.at is invalid`);
  return true;
}

function validateReviewRequest(value, path, errors) {
  const fields = ['id', 'databaseId', 'url', 'headSha', 'at', 'kind', 'body', 'authorLogin', 'authorNodeId'];
  if (!validateBaseEvidence(value, path, fields, errors)) return;
  if (!['discovery', 'verification'].includes(value.kind)) errors.push(`${path}.kind is invalid`);
  if (value.body !== '@codex review') errors.push(`${path}.body must be exactly @codex review`);
  for (const field of ['authorLogin', 'authorNodeId']) {
    if (!isString(value[field], { min: 1, max: field === 'authorLogin' ? 128 : 256 })) {
      errors.push(`${path}.${field} is invalid`);
    }
  }
}

function validateReviewOutcome(value, path, errors) {
  const fields = [
    'id', 'databaseId', 'url', 'headSha', 'at', 'requestId', 'kind', 'outcome',
    'evidenceType', 'reviewerLogin', 'reviewerNodeId', 'reviewerType', 'reviewerUrl',
    'reactionContent', 'reactionCommentId',
  ];
  if (!validateBaseEvidence(value, path, fields, errors)) return;
  if (!isString(value.requestId, { min: 1, max: 256 })) errors.push(`${path}.requestId is invalid`);
  if (!['discovery', 'verification'].includes(value.kind)) errors.push(`${path}.kind is invalid`);
  if (!['clean', 'findings'].includes(value.outcome)) errors.push(`${path}.outcome is invalid`);
  if (!['review-submission', 'request-reaction'].includes(value.evidenceType)) {
    errors.push(`${path}.evidenceType is invalid`);
  }
  if (value.reviewerLogin !== 'chatgpt-codex-connector') errors.push(`${path}.reviewerLogin must identify canonical Codex`);
  if (!isString(value.reviewerNodeId, { min: 1, max: 256 })) errors.push(`${path}.reviewerNodeId is invalid`);
  if (value.reviewerType !== 'Bot') errors.push(`${path}.reviewerType must be Bot`);
  if (value.reviewerUrl !== 'https://github.com/apps/chatgpt-codex-connector') {
    errors.push(`${path}.reviewerUrl must identify the canonical Codex GitHub App`);
  }
  if (value.evidenceType === 'request-reaction') {
    if (value.outcome !== 'clean') errors.push(`${path} request-reaction evidence may only prove a clean outcome`);
    if (value.reactionContent !== 'THUMBS_UP') errors.push(`${path}.reactionContent must be THUMBS_UP`);
    if (value.reactionCommentId !== value.requestId) errors.push(`${path}.reactionCommentId must equal requestId`);
  } else if (value.reactionContent !== null || value.reactionCommentId !== null) {
    errors.push(`${path} review-submission evidence cannot include reaction fields`);
  }
}

function validateVerificationEscalation(value, request, errors) {
  const path = '$.verificationEscalation';
  if (value === null) return;
  const fields = ['requestId', 'requestHeadSha', 'observedPrHeadSha', 'headRelation', 'evidenceIds', 'reason', 'at'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (!isString(value.requestId, { min: 1, max: 256 })) errors.push(`${path}.requestId is invalid`);
  for (const field of ['requestHeadSha', 'observedPrHeadSha']) {
    if (!isSha(value[field])) errors.push(`${path}.${field} is invalid`);
  }
  validateStringList(value.evidenceIds, `${path}.evidenceIds`, errors);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 8
      || value.evidenceIds.some((id) => !isString(id, { min: 1, max: 256 }))) {
    errors.push(`${path}.evidenceIds must contain 1-8 concise identifiers`);
  }
  if (!['stale-canonical-evidence', 'ambiguous-canonical-evidence', 'request-head-drift'].includes(value.reason)) {
    errors.push(`${path}.reason is invalid`);
  }
  if (!['same', 'changed'].includes(value.headRelation)) errors.push(`${path}.headRelation is invalid`);
  if (!isDateTime(value.at)) errors.push(`${path}.at is invalid`);
  if (request?.kind !== 'verification') errors.push(`${path} requires the current verification request`);
  if (value.requestId !== request?.id || value.requestHeadSha !== request?.headSha) {
    errors.push(`${path} must bind to the current pending request and exact SHA`);
  }
  const expectedRelation = value.reason === 'request-head-drift' ? 'changed' : 'same';
  if (value.headRelation !== expectedRelation) {
    errors.push(`${path}.headRelation must be ${expectedRelation} for ${value.reason}`);
  }
  const actualRelation = value.observedPrHeadSha === value.requestHeadSha ? 'same' : 'changed';
  if (value.headRelation !== actualRelation) {
    errors.push(`${path}.headRelation contradicts the request and observed PR HEADs`);
  }
}

function validateExecution(value, path, errors) {
  const fields = [
    'dependencies', 'ownedPaths', 'worker', 'branch', 'worktree', 'workerCommitSha',
    'validationSummaries', 'lastError',
  ];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  for (const field of ['dependencies', 'ownedPaths', 'validationSummaries']) {
    validateStringList(value[field], `${path}.${field}`, errors);
  }
  for (const field of ['worker', 'branch', 'worktree', 'lastError']) {
    if (!(value[field] === null || isString(value[field], { min: 1, max: 1000 }))) {
      errors.push(`${path}.${field} is invalid`);
    }
  }
  if (!isSha(value.workerCommitSha, true)) errors.push(`${path}.workerCommitSha is invalid`);
}

const EXECUTION_STATUSES = new Set(['proposed', 'queued', 'running', 'implemented', 'blocked', 'failed']);
const RESOLVED_STATUSES = new Set(['integrated', 'completed', 'not-applicable']);

function validateTaskV2(task, index, errors) {
  const path = `$.tasks[${index}]`;
  const fields = [
    'id', 'sourceIds', 'sourceType', 'fingerprint', 'summary', 'severity', 'disposition', 'status',
    'integratedCommitSha', 'resolutionSummary', 'taskPacketDigest', 'execution',
  ];
  if (!requireFields(task, fields.filter((field) => !['execution', 'taskPacketDigest'].includes(field)), path, errors)) return;
  rejectUnknownFields(task, fields, path, errors);
  if (!isString(task.id, { min: 1, max: 128 })) errors.push(`${path}.id is invalid`);
  validateStringList(task.sourceIds, `${path}.sourceIds`, errors);
  if (!['github-thread', 'github-threadless', 'local'].includes(task.sourceType)) errors.push(`${path}.sourceType is invalid`);
  if (!isString(task.fingerprint, { min: 8, max: 256 })) errors.push(`${path}.fingerprint is invalid`);
  if (!isString(task.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary is invalid`);
  if (!['P0', 'P1', 'P2', 'P3'].includes(task.severity)) errors.push(`${path}.severity is invalid`);
  if (!FINDING_DISPOSITIONS.includes(task.disposition)) errors.push(`${path}.disposition is invalid`);
  if (!TASK_STATUSES.includes(task.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(task.integratedCommitSha, true)) errors.push(`${path}.integratedCommitSha is invalid`);
  if (!(task.resolutionSummary === null || isString(task.resolutionSummary, { min: 1, max: 1000 }))) {
    errors.push(`${path}.resolutionSummary is invalid`);
  }
  if (!(task.taskPacketDigest === undefined || task.taskPacketDigest === null
      || /^[0-9a-f]{64}$/u.test(task.taskPacketDigest))) {
    errors.push(`${path}.taskPacketDigest is invalid`);
  }
  if (EXECUTION_STATUSES.has(task.status)) {
    if (task.execution === undefined) errors.push(`${path}.execution is required for ${task.status}`);
    else validateExecution(task.execution, `${path}.execution`, errors);
    if (task.integratedCommitSha !== null) errors.push(`${path}.integratedCommitSha is reserved for integrated code`);
  } else if (task.execution !== undefined) {
    errors.push(`${path}.execution is not allowed for ${task.status}`);
  }
  if (RESOLVED_STATUSES.has(task.status) && !isString(task.resolutionSummary, { min: 1, max: 1000 })) {
    errors.push(`${path}.resolutionSummary is required for ${task.status}`);
  }
  if (['integrated', 'completed'].includes(task.status)
      && task.disposition === 'actionable' && !isSha(task.integratedCommitSha)) {
    errors.push(`${path}.integratedCommitSha is required for actionable integrated code`);
  }
}

function validateProof(value, path, errors, { source, scope } = {}) {
  const fields = ['source', 'scope', 'status', 'headSha', 'checks', 'updatedAt'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (value.source !== source) errors.push(`${path}.source must be ${source}`);
  if (value.scope !== scope) errors.push(`${path}.scope must be ${scope}`);
  if (!['not-run', 'passed', 'failed'].includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(value.headSha, true)) errors.push(`${path}.headSha is invalid`);
  validateStringList(value.checks, `${path}.checks`, errors);
  if (!isDateTime(value.updatedAt, true)) errors.push(`${path}.updatedAt is invalid`);
  if (value.status === 'not-run' && (value.headSha !== null || value.updatedAt !== null || value.checks?.length !== 0)) {
    errors.push(`${path} not-run proof must be empty`);
  }
  if (value.status === 'passed' && (!isSha(value.headSha) || !isDateTime(value.updatedAt) || value.checks?.length === 0)) {
    errors.push(`${path} passed proof requires a HEAD, checks, and timestamp`);
  }
}

function validateCiProof(value, path, errors, { allowNotRun = true } = {}) {
  const requiredFields = [
    'source', 'scope', 'status', 'headSha', 'checks', 'workflowRunId', 'workflowRunUrl', 'updatedAt',
  ];
  if (!requireFields(value, requiredFields, path, errors)) return;
  rejectUnknownFields(value, [...requiredFields, 'checkRunId'], path, errors);
  if (value.source !== 'github-actions') errors.push(`${path}.source must be github-actions`);
  if (value.scope !== 'full') errors.push(`${path}.scope must be full`);
  if (!['not-run', 'passed', 'failed'].includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(value.headSha, true)) errors.push(`${path}.headSha is invalid`);
  validateStringList(value.checks, `${path}.checks`, errors);
  if (!(value.workflowRunId === null || (Number.isInteger(value.workflowRunId) && value.workflowRunId >= 1))) {
    errors.push(`${path}.workflowRunId is invalid`);
  }
  if (Object.hasOwn(value, 'checkRunId')
      && !(value.checkRunId === null || isString(value.checkRunId, { min: 1, max: 500 }))) {
    errors.push(`${path}.checkRunId is invalid`);
  }
  if (!(value.workflowRunUrl === null || isHttpsUrl(value.workflowRunUrl))) errors.push(`${path}.workflowRunUrl is invalid`);
  if (!isDateTime(value.updatedAt, true)) errors.push(`${path}.updatedAt is invalid`);
  if (value.status === 'not-run') {
    if (!allowNotRun) errors.push(`${path}.status cannot be not-run`);
    if (value.headSha !== null || value.updatedAt !== null || value.workflowRunId !== null
        || value.workflowRunUrl !== null || (Object.hasOwn(value, 'checkRunId') && value.checkRunId !== null)
        || value.checks?.length !== 0) {
      errors.push(`${path} not-run proof must be empty`);
    }
  } else if (Object.hasOwn(value, 'checkRunId') && !isString(value.checkRunId, { min: 1, max: 500 })) {
    errors.push(`${path} completed CI proof checkRunId must be nonempty when present`);
  } else if (!isSha(value.headSha) || !isDateTime(value.updatedAt)
      || !Number.isInteger(value.workflowRunId) || !isHttpsUrl(value.workflowRunUrl)
      || value.checks?.length === 0) {
    errors.push(`${path} completed CI proof requires a HEAD, checks, workflow run, URL, and timestamp`);
  }
}

function validateThreadlessProof(value, path, errors) {
  const fields = ['status', 'headSha', 'taskIds', 'updatedAt'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (!['not-run', 'passed', 'failed'].includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(value.headSha, true)) errors.push(`${path}.headSha is invalid`);
  validateStringList(value.taskIds, `${path}.taskIds`, errors);
  if (!isDateTime(value.updatedAt, true)) errors.push(`${path}.updatedAt is invalid`);
  if (value.status === 'not-run' && (value.headSha !== null || value.updatedAt !== null || value.taskIds?.length !== 0)) {
    errors.push(`${path} not-run proof must be empty`);
  }
  if (value.status === 'passed' && (!isSha(value.headSha) || !isDateTime(value.updatedAt))) {
    errors.push(`${path} passed proof requires a HEAD and timestamp`);
  }
}

const TASK_THREAD_DISPOSITIONS = new Map([
  ['actionable', 'fixed'],
  ['duplicate', 'duplicate'],
  ['already-fixed', 'already-fixed'],
  ['stale', 'stale'],
  ['invalid', 'invalid'],
  ['policy-conflict', 'policy-conflict'],
  ['out-of-scope', 'out-of-scope'],
]);

function threadMatchesSource(thread, sourceId) {
  return sourceId === `thread:${thread.threadNodeId}`
    || sourceId === `discussion:${thread.rootCommentDatabaseId}`;
}

export function taskHasCanonicalThreadCoverage(task, threads) {
  const sources = task.sourceIds.filter((sourceId) => /^(?:discussion|thread):/u.test(sourceId));
  const expectedDisposition = TASK_THREAD_DISPOSITIONS.get(task.disposition);
  if (sources.length === 0 || expectedDisposition === undefined) return false;
  return sources.every((sourceId) => threads.some((thread) => (
    thread.taskIds.includes(task.id)
    && threadMatchesSource(thread, sourceId)
    && thread.disposition === expectedDisposition
    && thread.isResolved === true
    && thread.replyId !== null
    && thread.replyUrl !== null
    && isDateTime(thread.resolvedAt)
    && isString(thread.resolvedBy, { min: 1, max: 1000 })
  )));
}

function validateThreadStatus(value, tasks, errors) {
  const path = '$.threadResolutionStatus';
  const fields = ['status', 'headSha', 'threads', 'threadlessVerification', 'updatedAt'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (!['not-run', 'passed', 'failed'].includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(value.headSha, true)) errors.push(`${path}.headSha is invalid`);
  if (!isDateTime(value.updatedAt, true)) errors.push(`${path}.updatedAt is invalid`);
  if (!Array.isArray(value.threads)) errors.push(`${path}.threads is invalid`);
  else value.threads.forEach((thread, index) => {
    const threadPath = `${path}.threads[${index}]`;
    const threadFields = [
      'threadNodeId', 'rootCommentNodeId', 'rootCommentDatabaseId', 'taskIds', 'disposition', 'replyId', 'replyUrl',
      'isResolved', 'resolvedAt', 'resolvedBy', 'observedHeadSha',
    ];
    if (!requireFields(thread, threadFields, threadPath, errors)) return;
    rejectUnknownFields(thread, threadFields, threadPath, errors);
    if (!isString(thread.threadNodeId, { min: 1, max: 256 })) errors.push(`${threadPath}.threadNodeId is invalid`);
    if (!isString(thread.rootCommentNodeId, { min: 1, max: 256 })) errors.push(`${threadPath}.rootCommentNodeId is invalid`);
    if (!Number.isInteger(thread.rootCommentDatabaseId) || thread.rootCommentDatabaseId < 1) {
      errors.push(`${threadPath}.rootCommentDatabaseId is invalid`);
    }
    for (const field of ['replyId', 'resolvedAt', 'resolvedBy']) {
      if (!(thread[field] === null || isString(thread[field], { min: 1, max: field === 'replyUrl' ? 2000 : 1000 }))) {
        errors.push(`${threadPath}.${field} is invalid`);
      }
    }
    if (!(thread.replyUrl === null || isHttpsUrl(thread.replyUrl))) errors.push(`${threadPath}.replyUrl must be an HTTPS URL`);
    validateStringList(thread.taskIds, `${threadPath}.taskIds`, errors);
    if (thread.taskIds?.length === 0) errors.push(`${threadPath}.taskIds must not be empty`);
    if (!['fixed', 'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope'].includes(thread.disposition)) {
      errors.push(`${threadPath}.disposition is invalid`);
    }
    if (typeof thread.isResolved !== 'boolean') errors.push(`${threadPath}.isResolved is invalid`);
    if (!isSha(thread.observedHeadSha)) errors.push(`${threadPath}.observedHeadSha is invalid`);
    if (thread.isResolved && (!isDateTime(thread.resolvedAt) || !isString(thread.resolvedBy, { min: 1, max: 1000 }))) {
      errors.push(`${threadPath} resolved thread requires time and actor`);
    }
    if (!thread.isResolved && (thread.resolvedAt !== null || thread.resolvedBy !== null)) {
      errors.push(`${threadPath} unresolved thread cannot have resolution metadata`);
    }
    if ((thread.replyId === null) !== (thread.replyUrl === null)) errors.push(`${threadPath} reply ID and URL must be paired`);
    if (thread.isResolved && thread.replyId === null) errors.push(`${threadPath} resolved disposition requires reply evidence`);
  });
  validateThreadlessProof(value.threadlessVerification, `${path}.threadlessVerification`, errors);
  const unresolved = Array.isArray(value.threads) ? value.threads.filter((thread) => !thread.isResolved) : [];
  if (value.status === 'not-run' && (
    value.headSha !== null || value.updatedAt !== null
  )) errors.push(`${path} not-run aggregate observation must have null HEAD and timestamp`);
  if (value.status === 'passed' && (!isSha(value.headSha) || !isDateTime(value.updatedAt) || unresolved.length > 0)) {
    errors.push(`${path} passed proof requires an exact HEAD, timestamp, and all threads resolved`);
  }
  if (value.status === 'passed' && value.threadlessVerification?.status === 'passed'
      && value.threadlessVerification.headSha !== value.headSha) {
    errors.push(`${path}.threadlessVerification.headSha must equal the thread proof HEAD`);
  }
  if (Array.isArray(value.threads)) {
    for (const [field, label] of [
      ['threadNodeId', 'thread node IDs'],
      ['rootCommentNodeId', 'root comment node IDs'],
      ['rootCommentDatabaseId', 'root comment database IDs'],
      ['replyId', 'reply IDs'],
    ]) {
      const identifiers = value.threads.map((thread) => thread[field]).filter((identifier) => identifier !== null);
      if (new Set(identifiers).size !== identifiers.length) {
        errors.push(`${path}.threads contains duplicate ${label}`);
      }
    }
  }
  const taskIds = new Set((tasks ?? []).map((task) => task.id));
  const resolvedThreads = (value.threads ?? []).filter((thread) => thread.isResolved);
  const covered = new Set(resolvedThreads.flatMap((thread) => thread.taskIds ?? []));
  const threadless = value.threadlessVerification?.status === 'passed'
    ? new Set(value.threadlessVerification.taskIds) : new Set();
  for (const id of [...covered, ...threadless]) if (!taskIds.has(id)) errors.push(`${path} references unknown task ${id}`);
  for (const task of tasks ?? []) {
    if (task.status !== 'completed') continue;
    if (task.sourceType === 'github-thread' && !taskHasCanonicalThreadCoverage(task, resolvedThreads)) {
      errors.push(`${path} lacks disposition- and source-bound canonical thread coverage for completed task ${task.id}`);
    }
    if (task.sourceType === 'github-threadless' && !threadless.has(task.id)) {
      errors.push(`${path} lacks successful threadless verification for completed task ${task.id}`);
    }
  }
}

function exactHeadReason(label, actual, expected) {
  return actual === expected ? null : `${label} must equal currentIntegrationHeadSha`;
}

function reviewRequestStateGate(state) {
  const reasons = [];
  const head = state?.currentIntegrationHeadSha;
  if (state?.phase !== 'ready-for-review') reasons.push('phase must be exactly ready-for-review');
  if (state?.validationStatus?.status !== 'passed') reasons.push('validation must have passed');
  if (state?.validationStatus?.source !== 'orchestrator' || state?.validationStatus?.scope !== 'targeted') {
    reasons.push('validation must be targeted orchestrator evidence');
  }
  for (const [label, actual] of [
    ['validation HEAD', state?.validationStatus?.headSha],
    ['thread proof HEAD', state?.threadResolutionStatus?.headSha],
    ['recorded local Git HEAD', state?.git?.headSha],
  ]) {
    const reason = exactHeadReason(label, actual, head);
    if (reason) reasons.push(reason);
  }
  if (state?.threadResolutionStatus?.status !== 'passed') reasons.push('thread resolution proof must have passed');
  if (state?.threadResolutionStatus?.threads?.some((thread) => !thread.isResolved)) reasons.push('all canonical threads must be resolved');
  if (state?.git?.dirty !== false) reasons.push('integration checkout must be clean');
  if (state?.verificationEscalation !== null) reasons.push('verification collection escalation requires human decision');
  if (!Array.isArray(state?.tasks) || state.tasks.some((task) => task.status !== 'completed')) reasons.push('all prior tasks must be completed');
  if (state?.tasks?.some((task) => task.disposition === 'needs-human-decision')) reasons.push('needs-human-decision findings require a human');
  if ((state?.blockedReasons?.length ?? 0) !== 0) reasons.push('blocked reasons must be cleared');
  let kind = null;
  if (Number.isInteger(state?.reviewRound) && state.reviewRound < 3) kind = 'discovery';
  else if (state?.reviewRound === 3 && state?.verificationReviewUsed === false) kind = 'verification';
  else reasons.push('the three discovery rounds and one verification review are exhausted');
  return { kind, reasons };
}

function validateExternalHeads(state, external, reasons) {
  const head = state?.currentIntegrationHeadSha;
  for (const [label, field] of [
    ['fresh local HEAD', 'localHeadSha'],
    ['fresh pushed remote HEAD', 'pushedHeadSha'],
    ['fresh live PR HEAD', 'prHeadSha'],
  ]) {
    const reason = exactHeadReason(label, external?.[field], head);
    if (reason) reasons.push(reason);
  }
  if (external?.localDirty !== false) reasons.push('fresh integration checkout must be clean');
  if (typeof external?.isAncestor !== 'function') {
    reasons.push('a Git-aware integrated-commit ancestry check is required');
  } else {
    for (const task of state?.tasks ?? []) {
      if (task.disposition === 'actionable' && ['integrated', 'completed'].includes(task.status)
          && !external.isAncestor(task.integratedCommitSha, head)) {
        reasons.push(`task ${task.id} integrated commit must be an ancestor of currentIntegrationHeadSha`);
      }
    }
  }
}

export function reviewRequestGate(state, external) {
  const { kind, reasons } = reviewRequestStateGate(state);
  validateExternalHeads(state, external, reasons);
  return { allowed: reasons.length === 0, kind: reasons.length === 0 ? kind : null, reasons };
}

function completionStateGate(state) {
  const reasons = [];
  const head = state?.currentIntegrationHeadSha;
  if (!state?.reviewRequest) reasons.push('review request evidence is required');
  if (state?.reviewOutcome?.outcome !== 'clean') reasons.push('a clean canonical review outcome is required');
  for (const [label, actual] of [
    ['requested HEAD', state?.requestedHeadSha], ['reviewed HEAD', state?.reviewedHeadSha],
    ['review request HEAD', state?.reviewRequest?.headSha], ['review outcome HEAD', state?.reviewOutcome?.headSha],
    ['validation HEAD', state?.validationStatus?.headSha], ['thread proof HEAD', state?.threadResolutionStatus?.headSha],
    ['full CI HEAD', state?.ciValidationStatus?.headSha],
    ['recorded local Git HEAD', state?.git?.headSha],
  ]) {
    const reason = exactHeadReason(label, actual, head);
    if (reason) reasons.push(reason);
  }
  if (state?.reviewOutcome?.requestId !== state?.reviewRequest?.id) reasons.push('outcome must bind to the current request');
  if (state?.reviewOutcome?.kind !== state?.reviewRequest?.kind) reasons.push('outcome kind must match the current request');
  if (state?.reviewRound < 1) reasons.push('at least one discovery round is required');
  if (state?.reviewRequest?.kind === 'verification'
      && (state.reviewRound !== 3 || state.verificationReviewUsed !== true)) {
    reasons.push('verification clean completion requires three discovery rounds and consumed verification');
  }
  if (state?.validationStatus?.status !== 'passed') reasons.push('validation must have passed');
  if (state?.ciValidationStatus?.status !== 'passed') reasons.push('full GitHub Actions validation must have passed');
  if (state?.validationStatus?.source !== 'orchestrator' || state?.validationStatus?.scope !== 'targeted') {
    reasons.push('validation must be targeted orchestrator evidence');
  }
  if (state?.ciValidationStatus?.source !== 'github-actions' || state?.ciValidationStatus?.scope !== 'full') {
    reasons.push('full validation must be GitHub Actions evidence');
  }
  if (state?.threadResolutionStatus?.status !== 'passed') reasons.push('thread proof must have passed');
  if (state?.verificationEscalation !== null) reasons.push('verification collection escalation requires human decision');
  if (state?.git?.dirty !== false) reasons.push('integration checkout must be clean');
  if (!Array.isArray(state?.tasks) || state.tasks.some((task) => task.status !== 'completed')) reasons.push('all tasks must be completed');
  if (state?.tasks?.some((task) => task.disposition === 'needs-human-decision')) reasons.push('needs-human-decision findings require a human');
  if ((state?.blockedReasons?.length ?? 0) !== 0) reasons.push('blocked reasons must be cleared');
  return reasons;
}

export function completionGate(state, external) {
  const reasons = completionStateGate(state);
  validateExternalHeads(state, external, reasons);
  return { allowed: reasons.length === 0, reasons };
}

function validateReviewHistory(value, currentHeadSha, errors) {
  if (!Array.isArray(value) || value.length > 4) {
    errors.push('$.reviewHistory must contain at most four entries');
    return;
  }
  value.forEach((entry, index) => {
    const path = `$.reviewHistory[${index}]`;
    if (!requireFields(entry, ['request', 'outcome'], path, errors)) return;
    rejectUnknownFields(entry, ['request', 'outcome'], path, errors);
    validateReviewRequest(entry.request, `${path}.request`, errors);
    if (entry.outcome !== null) {
      validateReviewOutcome(entry.outcome, `${path}.outcome`, errors);
      if (entry.outcome.requestId !== entry.request.id || entry.outcome.kind !== entry.request.kind
          || entry.outcome.headSha !== entry.request.headSha) {
        errors.push(`${path}.outcome must bind to its exact request and SHA`);
      }
    } else if (index !== value.length - 1 && entry.request.headSha === currentHeadSha) {
      errors.push(`${path} only a request made stale by HEAD drift may retain a null outcome`);
    }
  });
  const discoveryCount = value.filter((entry) => entry.request?.kind === 'discovery').length;
  const verificationCount = value.filter((entry) => entry.request?.kind === 'verification').length;
  if (discoveryCount > 3 || verificationCount > 1) errors.push('$.reviewHistory exceeds the 3+1 review limit');
  const requestIds = value.map((entry) => entry.request?.id);
  if (new Set(requestIds).size !== requestIds.length) errors.push('$.reviewHistory contains duplicate request IDs');
}

export function validatePrReviewState(value) {
  const errors = [];
  const fields = [
    'schemaVersion', 'revision', 'repository', 'prNumber', 'phase', 'baseSha', 'requestedHeadSha',
    'reviewedHeadSha', 'currentIntegrationHeadSha', 'reviewRound', 'verificationReviewUsed', 'legacyReviewProvenance',
    'releaseBaseline', 'decisions', 'tasks', 'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
    'threadResolutionStatus', 'blockedReasons', 'validationStatus', 'ciValidationStatus', 'ciValidationHistory', 'nextAction',
    'integrationWorktree', 'orchestratorSessionId', 'abandonmentReason', 'git', 'updatedAt',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 3) errors.push('$.schemaVersion must equal 3');
  if (!Number.isInteger(value.revision) || value.revision < 0) errors.push('$.revision must be non-negative');
  if (!isString(value.repository, { min: 3, max: 256 }) || !/^[^/\s]+\/[^/\s]+$/u.test(value.repository)) errors.push('$.repository must be owner/name');
  if (!Number.isInteger(value.prNumber) || value.prNumber < 1) errors.push('$.prNumber must be positive');
  if (!STATE_PHASES.includes(value.phase)) errors.push('$.phase is invalid');
  for (const field of ['baseSha', 'currentIntegrationHeadSha']) if (!isSha(value[field])) errors.push(`$.${field} is invalid`);
  for (const field of ['requestedHeadSha', 'reviewedHeadSha']) if (!isSha(value[field], true)) errors.push(`$.${field} is invalid`);
  if (!Number.isInteger(value.reviewRound) || value.reviewRound < 0 || value.reviewRound > 3) errors.push('$.reviewRound must be 0-3');
  if (typeof value.verificationReviewUsed !== 'boolean') errors.push('$.verificationReviewUsed must be boolean');
  if (value.verificationReviewUsed && value.reviewRound !== 3) errors.push('$.verificationReviewUsed requires reviewRound 3');
  if (!(value.legacyReviewProvenance === null || (
    isObject(value.legacyReviewProvenance)
    && Object.keys(value.legacyReviewProvenance).length === 3
    && value.legacyReviewProvenance.schemaVersion === 1
    && Number.isInteger(value.legacyReviewProvenance.discoveryRounds)
    && value.legacyReviewProvenance.discoveryRounds >= 0
    && value.legacyReviewProvenance.discoveryRounds <= 3
    && isDateTime(value.legacyReviewProvenance.migratedAt)
  ))) errors.push('$.legacyReviewProvenance is invalid');
  if (!(value.releaseBaseline === null || (isObject(value.releaseBaseline)
      && Object.keys(value.releaseBaseline).every((key) => ['version', 'tag', 'commit', 'releasedAt'].includes(key))
      && isString(value.releaseBaseline.version, { min: 1, max: 128 })
      && isString(value.releaseBaseline.tag, { min: 1, max: 128 })
      && isSha(value.releaseBaseline.commit) && isDateTime(value.releaseBaseline.releasedAt)))) {
    errors.push('$.releaseBaseline is invalid');
  }
  if (!Array.isArray(value.decisions)) errors.push('$.decisions must be an array');
  else value.decisions.forEach((decision, index) => {
    const path = `$.decisions[${index}]`;
    if (requireFields(decision, ['id', 'summary'], path, errors)) {
      rejectUnknownFields(decision, ['id', 'summary'], path, errors);
      if (!isString(decision.id, { min: 1, max: 128 })) errors.push(`${path}.id is invalid`);
      if (!isString(decision.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary is invalid`);
    }
  });
  if (!Array.isArray(value.tasks)) errors.push('$.tasks must be an array');
  else value.tasks.forEach((task, index) => validateTaskV2(task, index, errors));
  if (value.reviewRequest !== null) validateReviewRequest(value.reviewRequest, '$.reviewRequest', errors);
  if (value.reviewOutcome !== null) validateReviewOutcome(value.reviewOutcome, '$.reviewOutcome', errors);
  validateVerificationEscalation(value.verificationEscalation, value.reviewRequest, errors);
  validateReviewHistory(value.reviewHistory, value.currentIntegrationHeadSha, errors);
  const latest = Array.isArray(value.reviewHistory) ? value.reviewHistory.at(-1) : null;
  if ((latest?.request ?? null)?.id !== value.reviewRequest?.id) errors.push('$.reviewRequest must equal the latest history request');
  if ((latest?.outcome ?? null)?.id !== value.reviewOutcome?.id) errors.push('$.reviewOutcome must equal the latest history outcome');
  const discoveryCount = value.reviewHistory?.filter((entry) => entry.request?.kind === 'discovery').length;
  const verificationCount = value.reviewHistory?.filter((entry) => entry.request?.kind === 'verification').length;
  const legacyDiscoveryCount = value.legacyReviewProvenance?.discoveryRounds ?? 0;
  if (Number.isInteger(discoveryCount) && legacyDiscoveryCount + discoveryCount > 3) {
    errors.push('$.reviewHistory plus migrated discovery count exceeds three rounds');
  }
  if (Number.isInteger(discoveryCount) && value.reviewRound !== legacyDiscoveryCount + discoveryCount) {
    errors.push('$.reviewRound must equal durable migrated and native discovery request count');
  }
  if (Number.isInteger(verificationCount) && value.verificationReviewUsed !== (verificationCount === 1)) {
    errors.push('$.verificationReviewUsed must equal durable verification request use');
  }
  if (value.reviewRequest && value.requestedHeadSha !== value.reviewRequest.headSha) errors.push('$.requestedHeadSha must equal request HEAD');
  if (value.reviewOutcome && value.reviewedHeadSha !== value.reviewOutcome.headSha) errors.push('$.reviewedHeadSha must equal outcome HEAD');
  if (value.verificationEscalation !== null) {
    if (value.phase !== 'awaiting-human-decision') errors.push('$.verificationEscalation requires awaiting-human-decision');
    if (value.verificationReviewUsed !== true) errors.push('$.verificationEscalation requires the consumed verification allowance');
    if (value.reviewOutcome !== null || latest?.outcome !== null) {
      errors.push('$.verificationEscalation requires a pending review collection');
    }
  }
  validateStringList(value.blockedReasons, '$.blockedReasons', errors);
  validateProof(value.validationStatus, '$.validationStatus', errors, { source: 'orchestrator', scope: 'targeted' });
  validateCiProof(value.ciValidationStatus, '$.ciValidationStatus', errors);
  if (!Array.isArray(value.ciValidationHistory)) errors.push('$.ciValidationHistory must be an array');
  else {
    value.ciValidationHistory.forEach((proof, index) => validateCiProof(
      proof, `$.ciValidationHistory[${index}]`, errors, { allowNotRun: false },
    ));
    const attemptIds = value.ciValidationHistory.map((proof) => (
      Object.hasOwn(proof, 'checkRunId')
        ? `check:${proof.checkRunId}` : `legacy-workflow:${proof.workflowRunId}`
    ));
    if (new Set(attemptIds).size !== attemptIds.length) {
      errors.push('$.ciValidationHistory contains duplicate CI attempt identities');
    }
    const currentCi = value.ciValidationStatus?.status === 'not-run' ? null : value.ciValidationStatus;
    if (currentCi !== null && JSON.stringify(value.ciValidationHistory.at(-1)) !== JSON.stringify(currentCi)) {
      errors.push('$.ciValidationStatus must equal the latest append-only CI evidence');
    }
  }
  validateThreadStatus(value.threadResolutionStatus, value.tasks, errors);
  if (!isString(value.nextAction, { min: 1, max: 1000 })) errors.push('$.nextAction is invalid');
  if (!isString(value.integrationWorktree, { min: 1, max: 4096 }) || !value.integrationWorktree.startsWith('/')) errors.push('$.integrationWorktree must be absolute');
  for (const field of ['orchestratorSessionId', 'abandonmentReason']) {
    if (!(value[field] === null || isString(value[field], { min: 1, max: 1000 }))) errors.push(`$.${field} is invalid`);
  }
  if (!isObject(value.git)) errors.push('$.git must be an object');
  else {
    const gitFields = ['branch', 'headSha', 'dirty'];
    requireFields(value.git, gitFields, '$.git', errors);
    rejectUnknownFields(value.git, gitFields, '$.git', errors);
    if (!(value.git.branch === null || isString(value.git.branch, { min: 1, max: 1000 }))) errors.push('$.git.branch is invalid');
    if (!isSha(value.git.headSha)) errors.push('$.git.headSha is invalid');
    if (typeof value.git.dirty !== 'boolean') errors.push('$.git.dirty is invalid');
  }
  if (Array.isArray(value.tasks) && new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length) errors.push('$.tasks contains duplicate IDs');
  if (Array.isArray(value.decisions) && new Set(value.decisions.map((decision) => decision.id)).size !== value.decisions.length) errors.push('$.decisions contains duplicate IDs');
  if (!isDateTime(value.updatedAt)) errors.push('$.updatedAt must be RFC 3339');
  if (value.phase === 'awaiting-review' && (!value.reviewRequest || value.reviewOutcome !== null || latest?.outcome !== null)) {
    errors.push('$.phase awaiting-review requires one current pending request');
  }
  if (latest && latest.outcome === null) {
    const stale = latest.request.headSha !== value.currentIntegrationHeadSha;
    const allowedPhase = value.phase === 'awaiting-review'
      || (stale && latest.request.kind === 'discovery' && value.phase === 'recovering')
      || (stale && latest.request.kind === 'discovery' && value.phase === 'ready-for-review')
      || (latest.request.kind === 'verification' && value.phase === 'awaiting-human-decision'
        && (stale || value.verificationEscalation !== null));
    if (!allowedPhase) errors.push('$.phase is invalid for the pending current or stale review request');
  }
  if (value.reviewOutcome?.kind === 'verification' && value.reviewOutcome.outcome === 'findings'
      && value.phase !== 'awaiting-human-decision') {
    errors.push('$.phase must be awaiting-human-decision after verification findings');
  }
  if (value.phase === 'ready-for-review') {
    errors.push(...reviewRequestStateGate(value).reasons.map((reason) => `$.phase ready-for-review requires: ${reason}`));
  }
  if (value.phase === 'complete') errors.push(...completionStateGate(value).map((reason) => `$.phase complete requires: ${reason}`));
  findRawFields(value, '$', errors);
  return errors;
}
