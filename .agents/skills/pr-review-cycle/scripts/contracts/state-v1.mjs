import {
  findRawFields,
  isDateTime,
  isObject,
  isSha,
  isString,
  rejectUnknownFields,
  requireFields,
} from './primitives.mjs';

const STATE_PHASES_V1 = [
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

const TASK_STATUSES_V1 = [
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

const FINDING_DISPOSITIONS_V1 = [
  'actionable',
  'duplicate',
  'already-fixed',
  'stale',
  'invalid',
  'policy-conflict',
  'out-of-scope',
  'needs-human-decision',
];

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
  if (!FINDING_DISPOSITIONS_V1.includes(task.disposition)) errors.push(`${path}.disposition is invalid`);
  if (!TASK_STATUSES_V1.includes(task.status)) errors.push(`${path}.status is invalid`);
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
