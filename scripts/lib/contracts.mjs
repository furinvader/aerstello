const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RAW_FIELD_PATTERN = /^(?:raw[_-]?(?:log|diff|output)|logs?|full[_-]?(?:diff|review|transcript)|stack(?:trace)?|transcript)$/iu;

export const STATE_PHASES = [
  'recovering',
  'ready-for-review',
  'awaiting-review',
  'triaging',
  'implementing',
  'integrating',
  'verifying',
  'validating',
  'blocked',
  'complete',
];

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
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!['implemented', 'blocked', 'not-applicable', 'failed'].includes(value.status)) errors.push('$.status is invalid');
  if (value.status === 'implemented' ? !isSha(value.commitSha) : !isSha(value.commitSha, true)) {
    errors.push('$.commitSha must be a full Git SHA when implemented and otherwise may be null');
  }
  if (!Array.isArray(value.changedPaths) || value.changedPaths.some((path) => !isString(path, { min: 1, max: 500 }))) {
    errors.push('$.changedPaths must contain repository-relative paths');
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
    'decisionIds',
    'allowedPaths',
    'forbiddenPaths',
    'dependencies',
    'acceptanceCriteria',
    'requiredValidation',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!isSha(value.reviewedHeadSha)) errors.push('$.reviewedHeadSha must be a full Git SHA');
  if (!isString(value.finding, { min: 1, max: 2000 })) errors.push('$.finding must be concise');
  if (!isString(value.evidence, { min: 1, max: 3000 })) errors.push('$.evidence must be concise');
  for (const field of ['decisionIds', 'allowedPaths', 'forbiddenPaths', 'dependencies', 'acceptanceCriteria', 'requiredValidation']) {
    if (!Array.isArray(value[field]) || value[field].some((item) => !isString(item, { min: 1, max: 1000 }))) {
      errors.push(`$.${field} must be an array of concise strings`);
    }
  }
  if (Array.isArray(value.allowedPaths) && value.allowedPaths.length === 0) errors.push('$.allowedPaths must not be empty');
  findRawFields(value, '$', errors);
  return errors;
}

function validateTask(task, index, errors) {
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

export function validatePrReviewState(value) {
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
  if (!STATE_PHASES.includes(value.phase)) errors.push('$.phase is invalid');
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
  else value.tasks.forEach((task, index) => validateTask(task, index, errors));
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
