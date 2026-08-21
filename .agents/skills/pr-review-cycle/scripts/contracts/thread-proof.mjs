import { isDeepStrictEqual } from 'node:util';

import {
  isDateTime,
  isHttpsUrl,
  isObject,
  isSha,
  isString,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';

export function validateProof(value, path, errors, { source, scope } = {}) {
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

export function validateCiProof(value, path, errors, { allowNotRun = true } = {}) {
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

export function validateThreadlessProof(value, path, errors) {
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

const VERIFIED_LOCAL_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

export function localTaskIsEligibleForVerification(task) {
  if (task?.sourceType !== 'local' || task.status !== 'completed') return false;
  return (task.disposition === 'actionable' && isSha(task.integratedCommitSha))
    || VERIFIED_LOCAL_NON_ACTIONABLE_DISPOSITIONS.has(task.disposition);
}

export function validateLocalVerification(value, tasks, path, errors) {
  validateThreadlessProof(value, path, errors);
  if (!isObject(value) || !Array.isArray(value.taskIds)) return;
  if (value.status === 'passed' && value.taskIds.length === 0) {
    errors.push(`${path} passed proof must cover at least one local task`);
  }
  const byId = new Map((tasks ?? []).map((task) => [task.id, task]));
  for (const taskId of value.taskIds) {
    const task = byId.get(taskId);
    if (!task) errors.push(`${path} references unknown task ${taskId}`);
    else if (task.sourceType !== 'local') errors.push(`${path} references non-local task ${taskId}`);
    else if (!localTaskIsEligibleForVerification(task)) {
      errors.push(`${path} references ineligible local task ${taskId}`);
    }
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

export function validateArchiveProvenance(value, path, errors) {
  const fields = [
    'schemaVersion', 'historicalTaskId', 'historicalDisposition',
    'historicalIntegratedCommitSha', 'replyBodySha256', 'authorityFingerprint',
  ];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (value.schemaVersion !== 1) errors.push(`${path}.schemaVersion must be 1`);
  if (!isString(value.historicalTaskId, { min: 1, max: 128 })) {
    errors.push(`${path}.historicalTaskId is invalid`);
  }
  if (!['fixed', 'already-fixed'].includes(value.historicalDisposition)) {
    errors.push(`${path}.historicalDisposition is invalid`);
  }
  if (!isSha(value.historicalIntegratedCommitSha, true)) {
    errors.push(`${path}.historicalIntegratedCommitSha is invalid`);
  }
  for (const field of ['replyBodySha256', 'authorityFingerprint']) {
    if (!/^[0-9a-f]{64}$/u.test(value[field] ?? '')) errors.push(`${path}.${field} is invalid`);
  }
  if (value.historicalDisposition === 'fixed' && !isSha(value.historicalIntegratedCommitSha)) {
    errors.push(`${path} fixed provenance requires a historical integration commit`);
  }
  if (value.historicalDisposition === 'already-fixed'
      && value.historicalIntegratedCommitSha !== null) {
    errors.push(`${path} already-fixed provenance requires a null historical integration commit`);
  }
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

export function validateThreadStatus(value, tasks, errors) {
  const path = '$.threadResolutionStatus';
  const requiredFields = ['status', 'headSha', 'threads', 'threadlessVerification', 'updatedAt'];
  const fields = [...requiredFields, 'localVerification'];
  if (!requireFields(value, requiredFields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (!['not-run', 'passed', 'failed'].includes(value.status)) errors.push(`${path}.status is invalid`);
  if (!isSha(value.headSha, true)) errors.push(`${path}.headSha is invalid`);
  if (!isDateTime(value.updatedAt, true)) errors.push(`${path}.updatedAt is invalid`);
  if (!Array.isArray(value.threads)) errors.push(`${path}.threads is invalid`);
  else value.threads.forEach((thread, index) => {
    const threadPath = `${path}.threads[${index}]`;
    const threadFields = [
      'threadNodeId', 'rootCommentNodeId', 'rootCommentDatabaseId', 'taskIds', 'disposition', 'replyId', 'replyUrl',
      'isResolved', 'resolvedAt', 'resolvedBy', 'observedHeadSha', 'archiveProvenance',
    ];
    if (!requireFields(thread, threadFields.filter((field) => field !== 'archiveProvenance'), threadPath, errors)) return;
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
    if (Object.hasOwn(thread, 'archiveProvenance')) {
      validateArchiveProvenance(thread.archiveProvenance, `${threadPath}.archiveProvenance`, errors);
      const activeTask = thread.taskIds?.length === 1
        ? (tasks ?? []).find((task) => task.id === thread.taskIds[0]) : null;
      if (!thread.isResolved || thread.replyId === null || thread.disposition !== 'already-fixed') {
        errors.push(`${threadPath}.archiveProvenance requires an adopted resolved already-fixed row`);
      }
      if (!activeTask || activeTask.sourceType !== 'github-thread'
          || activeTask.status !== 'completed' || activeTask.disposition !== 'already-fixed'
          || activeTask.integratedCommitSha !== null) {
        errors.push(`${threadPath}.archiveProvenance requires one completed already-fixed GitHub-thread task`);
      } else if (!activeTask.sourceIds.some((sourceId) => threadMatchesSource(thread, sourceId))) {
        errors.push(`${threadPath}.archiveProvenance is outside the active task source partition`);
      }
      if (thread.archiveProvenance?.historicalTaskId === thread.taskIds?.[0]) {
        errors.push(`${threadPath}.archiveProvenance historical task must differ from the active task`);
      }
    }
  });
  validateThreadlessProof(value.threadlessVerification, `${path}.threadlessVerification`, errors);
  if (Object.hasOwn(value, 'localVerification')) {
    validateLocalVerification(value.localVerification, tasks, `${path}.localVerification`, errors);
  }
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
    const authorityTasks = new Map();
    const activeAuthorities = new Map();
    const historicalTasks = new Map();
    for (const [index, thread] of value.threads.entries()) {
      if (!Object.hasOwn(thread, 'archiveProvenance')) continue;
      const provenance = thread.archiveProvenance;
      if (!isObject(provenance) || !isString(provenance.historicalTaskId, { min: 1, max: 128 })) continue;
      const activeTaskId = thread.taskIds?.length === 1 ? thread.taskIds[0] : null;
      const authorityTask = authorityTasks.get(provenance.authorityFingerprint);
      if (authorityTask !== undefined && authorityTask !== activeTaskId) {
        errors.push(`${path}.threads[${index}].archiveProvenance authority projects to multiple active tasks`);
      } else {
        authorityTasks.set(provenance.authorityFingerprint, activeTaskId);
      }
      const activeAuthority = activeAuthorities.get(activeTaskId);
      if (activeAuthority !== undefined && activeAuthority !== provenance.authorityFingerprint) {
        errors.push(`${path}.threads[${index}].archiveProvenance diverges within its active adoption`);
      } else {
        activeAuthorities.set(activeTaskId, provenance.authorityFingerprint);
      }
      const metadata = {
        historicalDisposition: provenance.historicalDisposition,
        historicalIntegratedCommitSha: provenance.historicalIntegratedCommitSha,
        observedHeadSha: thread.observedHeadSha,
        authorityFingerprint: provenance.authorityFingerprint,
      };
      const partitionKey = JSON.stringify([activeTaskId, provenance.historicalTaskId]);
      const prior = historicalTasks.get(partitionKey);
      if (prior !== undefined && !isDeepStrictEqual(prior, metadata)) {
        errors.push(`${path}.threads[${index}].archiveProvenance conflicts with its historical task partition`);
      } else {
        historicalTasks.set(partitionKey, metadata);
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

export function completedLocalTaskIds(state) {
  return (state?.tasks ?? []).filter((task) => task.sourceType === 'local' && task.status === 'completed')
    .map((task) => task.id).sort();
}

export function localVerificationStateGate(state) {
  const expectedTaskIds = completedLocalTaskIds(state);
  if (expectedTaskIds.length === 0) return [];
  const proof = state?.threadResolutionStatus?.localVerification;
  const reasons = [];
  if (!isObject(proof)) {
    return ['completed local tasks require persisted local verifier proof'];
  }
  if (proof.status !== 'passed') reasons.push('local verifier proof must have passed');
  if (proof.headSha !== state?.currentIntegrationHeadSha) {
    reasons.push('local verifier proof HEAD must equal currentIntegrationHeadSha');
  }
  const actualTaskIds = Array.isArray(proof.taskIds) ? [...proof.taskIds].sort() : [];
  if (actualTaskIds.length !== expectedTaskIds.length
      || actualTaskIds.some((taskId, index) => taskId !== expectedTaskIds[index])) {
    reasons.push('local verifier proof must cover exactly every completed local task');
  }
  return reasons;
}
