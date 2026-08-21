import { loadRegistry } from '../../../aerstello-specialists/scripts/validate-registry.mjs';

import { validatedWorkerResultDigest } from './contract-identities.mjs';
import {
  findRawFields,
  isSha,
  isString,
  parseRepositoryPath,
  pathMatchesOwnership,
  rejectUnknownFields,
  requireFields,
  validateValidationEntry,
} from './primitives.mjs';
import { validateTaskPacket } from './task-packet.mjs';

export function validateWorkerResult(value) {
  const errors = [];
  const fields = [
    'schemaVersion',
    'taskId',
    'specialization',
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
  if (value.schemaVersion !== 3) errors.push('$.schemaVersion must equal 3');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!isString(value.specialization, { min: 1, max: 128 })) {
    errors.push('$.specialization must be a 1-128 character specialist profile ID');
  } else if (!loadRegistry().profiles.some((profile) => profile.id === value.specialization)) {
    errors.push(`$.specialization is an unknown specialist profile: ${value.specialization}`);
  }
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

export function workerResultDigest(result) {
  return validatedWorkerResultDigest(result, validateWorkerResult);
}

export function validateWorkerResultAgainstTask(packet, result, actualChangedPaths) {
  const errors = [
    ...validateTaskPacket(packet).map((error) => `task packet: ${error}`),
    ...validateWorkerResult(result).map((error) => `worker result: ${error}`),
  ];
  if (errors.length > 0) return errors;
  if (result.taskId !== packet.taskId) errors.push('worker result taskId must equal task packet taskId');
  if (result.specialization !== packet.specialization) {
    errors.push('worker result specialization must equal task packet specialization');
  }
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
