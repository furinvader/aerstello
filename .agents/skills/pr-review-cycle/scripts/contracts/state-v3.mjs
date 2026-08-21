import {
  completionStateGate,
  reviewReadyStateGate,
  reviewRequestUsage,
} from './gates.mjs';
import {
  findRawFields,
  isDateTime,
  isObject,
  isSha,
  isString,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';
import {
  validateReviewHistory,
  validateReviewOutcome,
  validateReviewRequest,
  validateStaleDiscoveryDispositions,
  validateVerificationEscalation,
} from './review-evidence.mjs';
import {
  validateCiProof,
  validateProof,
  validateThreadStatus,
} from './thread-proof.mjs';

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
    'integratedCommitSha', 'resolutionSummary', 'taskPacketDigest', 'workerResultDigest', 'execution',
  ];
  if (!requireFields(task, fields.filter((field) => !['execution', 'taskPacketDigest', 'workerResultDigest'].includes(field)), path, errors)) return;
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
  if (!(task.workerResultDigest === undefined || task.workerResultDigest === null
      || /^[0-9a-f]{64}$/u.test(task.workerResultDigest))) {
    errors.push(`${path}.workerResultDigest is invalid`);
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

export function validatePrReviewState(value) {
  const errors = [];
  const requiredFields = [
    'schemaVersion', 'revision', 'repository', 'prNumber', 'phase', 'baseSha', 'requestedHeadSha',
    'reviewedHeadSha', 'currentIntegrationHeadSha', 'reviewRound', 'verificationReviewUsed', 'legacyReviewProvenance',
    'releaseBaseline', 'decisions', 'tasks', 'reviewRequest', 'reviewOutcome', 'reviewHistory', 'verificationEscalation',
    'threadResolutionStatus', 'blockedReasons', 'validationStatus', 'ciValidationStatus', 'ciValidationHistory', 'nextAction',
    'integrationWorktree', 'orchestratorSessionId', 'abandonmentReason', 'git', 'updatedAt',
  ];
  const fields = [...requiredFields, 'reviewRequestLimit', 'staleDiscoveryDispositions'];
  if (!requireFields(value, requiredFields, '$', errors)) return errors;
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
  if (Object.hasOwn(value, 'reviewRequestLimit')
      && !(value.reviewRequestLimit === null
        || (Number.isSafeInteger(value.reviewRequestLimit) && value.reviewRequestLimit > 0))) {
    errors.push(`$.reviewRequestLimit must be null or a positive safe integer up to ${Number.MAX_SAFE_INTEGER}`);
  }
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
  const legacyDiscoveryCount = value.legacyReviewProvenance?.discoveryRounds ?? 0;
  validateReviewHistory(value.reviewHistory, legacyDiscoveryCount, errors);
  validateStaleDiscoveryDispositions(value.staleDiscoveryDispositions, value, errors);
  const latest = Array.isArray(value.reviewHistory) ? value.reviewHistory.at(-1) : null;
  if ((latest?.request ?? null)?.id !== value.reviewRequest?.id) errors.push('$.reviewRequest must equal the latest history request');
  if ((latest?.outcome ?? null)?.id !== value.reviewOutcome?.id) errors.push('$.reviewOutcome must equal the latest history outcome');
  const discoveryCount = value.reviewHistory?.filter((entry) => entry.request?.kind === 'discovery').length;
  const verificationCount = value.reviewHistory?.filter((entry) => entry.request?.kind === 'verification').length;
  if (Number.isInteger(discoveryCount) && legacyDiscoveryCount + discoveryCount > 3) {
    errors.push('$.reviewHistory plus migrated discovery count exceeds three rounds');
  }
  if (Number.isInteger(discoveryCount) && value.reviewRound !== legacyDiscoveryCount + discoveryCount) {
    errors.push('$.reviewRound must equal durable migrated and native discovery request count');
  }
  if (Number.isInteger(verificationCount) && value.verificationReviewUsed !== (verificationCount > 0)) {
    errors.push('$.verificationReviewUsed must equal durable verification request use');
  }
  const usage = reviewRequestUsage(value);
  if (usage.limit !== null && usage.limit < usage.used) {
    errors.push('$.reviewRequestLimit cannot be lower than the durable request count');
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
    if (currentCi !== null && !value.ciValidationHistory.some(
      (proof) => JSON.stringify(proof) === JSON.stringify(currentCi),
    )) {
      errors.push('$.ciValidationStatus must equal an immutable CI history entry');
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
    const staleDisposition = (value.staleDiscoveryDispositions ?? [])
      .find((disposition) => disposition.requestId === latest.request.id);
    const dispositionedFindingPhase = stale && staleDisposition?.evidence?.outcome === 'findings'
      && ['triaging', 'implementing', 'integrating', 'verifying', 'validating', 'blocked',
        'awaiting-human-decision'].includes(value.phase);
    const allowedPhase = value.phase === 'awaiting-review'
      || (stale && ['recovering', 'ready-for-review'].includes(value.phase))
      || dispositionedFindingPhase
      || (latest.request.kind === 'verification' && value.phase === 'awaiting-human-decision'
        && value.verificationEscalation !== null);
    if (!allowedPhase) errors.push('$.phase is invalid for the pending current or stale review request');
  }
  if (value.phase === 'ready-for-review') {
    errors.push(...reviewReadyStateGate(value).map((reason) => `$.phase ready-for-review requires: ${reason}`));
  }
  if (value.phase === 'complete') errors.push(...completionStateGate(value).map((reason) => `$.phase complete requires: ${reason}`));
  findRawFields(value, '$', errors);
  return errors;
}
