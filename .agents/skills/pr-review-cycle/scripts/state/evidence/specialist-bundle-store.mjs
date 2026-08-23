import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { validateTaskPacket } from '../../contracts/contracts.mjs';
import {
  isSpecialistEvidenceApplicable, loadRegistry, requiredSpecialistIds, routeSpecialists, validateSpecialistEvidence,
} from '../../../../aerstello-specialists/scripts/validate-registry.mjs';
import { atomicWriteText, canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import { specialistPlanReceiptPath, specialistReviewBundlePath } from '../locations.mjs';
import { taskPacketDigest } from './task-packets.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
const PR_FINAL_VERIFIER_ID = 'integration_verifier';

export function specialistPlanningErrors(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['input must be an object'];
  const fields = ['schemaVersion', 'stage', 'headSha', 'tasks'];
  for (const field of fields) if (!Object.hasOwn(input, field)) errors.push(`input.${field} is required`);
  for (const field of Object.keys(input)) if (!fields.includes(field)) errors.push(`input.${field} is not allowed`);
  if (input.schemaVersion !== 1) errors.push('input.schemaVersion must be 1');
  if (!['pre-bind', 'post-integration'].includes(input.stage)) errors.push('input.stage is invalid');
  if (typeof input.headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(input.headSha)) errors.push('input.headSha is invalid');
  if (!Array.isArray(input.tasks)
      || (input.stage === 'pre-bind' && input.tasks.length === 0)) {
    errors.push('input.tasks must be a non-empty array for pre-bind planning');
  } else for (const [index, entry] of input.tasks.entries()) {
    const prefix = `input.tasks[${index}]`;
    const entryFields = input.stage === 'pre-bind' ? ['taskPacket', 'planningSignals'] : ['taskPacket'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${prefix} must be an object`); continue; }
    for (const field of entryFields) if (!Object.hasOwn(entry, field)) errors.push(`${prefix}.${field} is required`);
    for (const field of Object.keys(entry)) if (!entryFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
    errors.push(...validateTaskPacket(entry.taskPacket).map((error) => `${prefix}.taskPacket: ${error}`));
    if (input.stage === 'pre-bind') {
      const signals = entry.planningSignals;
      if (!signals || typeof signals !== 'object' || Array.isArray(signals)
          || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
          || typeof signals.browserVisible !== 'boolean'
          || typeof signals.testSelectionUncertain !== 'boolean') {
        errors.push(`${prefix}.planningSignals must contain exactly browserVisible and testSelectionUncertain booleans`);
      }
    }
  }
  return errors;
}

export function specialistRouteFor(packet, planningSignals = {}) {
  loadRegistry();
  return routeSpecialists({
    specialization: packet.specialization,
    riskTags: packet.riskTags,
    browserVisible: planningSignals.browserVisible === true,
    testSelectionUncertain: planningSignals.testSelectionUncertain === true,
  });
}

export function specialistPhaseForStage(stage) {
  return stage === 'post-integration' ? 'review' : 'planning';
}

export function normalizedRequiredSpecialistIds(route, { stage }) {
  const ids = requiredSpecialistIds(route, { phase: specialistPhaseForStage(stage) });
  return [...new Set(ids)].sort();
}

export function canonicalBundleTaskRoute(task, stage) {
  return specialistRouteFor(stage === 'pre-bind' ? task.taskPacket : task, task.planningSignals);
}

export function specialistPlanDigest(bundle) {
  const {
    records: _records,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...immutablePlan
  } = bundle;
  return createHash('sha256').update(canonicalSerializedJson(immutablePlan)).digest('hex');
}

export function verifySpecialistPlanReceipt(cwd, state, bundle) {
  const path = specialistPlanReceiptPath(cwd, state.prNumber, bundle.headSha, bundle.stateRevision);
  let recorded;
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    recorded = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StateError(`Unable to read specialist plan receipt at ${path}: ${error.message}`, 'INVALID_SPECIALIST_REVIEW');
  }
  const expected = `${specialistPlanDigest(bundle)}\n`;
  if (recorded !== expected) {
    throw new StateError('Specialist plan receipt does not match immutable bundle planning data', 'INVALID_SPECIALIST_REVIEW');
  }
  return path;
}

export function persistSpecialistPlanReceipt(cwd, state, bundle) {
  const path = specialistPlanReceiptPath(cwd, state.prNumber, bundle.headSha, bundle.stateRevision);
  const expected = `${specialistPlanDigest(bundle)}\n`;
  if (existsSync(path)) {
    if (statSync(path).size > 128 || readFileSync(path, 'utf8') !== expected) {
      throw new StateError('A different specialist plan receipt already exists', 'SPECIALIST_PLAN_CONFLICT');
    }
    return path;
  }
  atomicWriteText(path, expected);
  return path;
}

export function conciseSpecialistPayloadErrors({ status, summary, findings }, label) {
  const errors = [];
  if (!['clean', 'findings'].includes(status)) errors.push(`${label}.status is invalid`);
  if (typeof summary !== 'string' || summary.trim() === '' || summary.length > 1000) {
    errors.push(`${label}.summary must be a non-empty string of at most 1000 characters`);
  }
  if (!Array.isArray(findings) || findings.length > 20) {
    errors.push(`${label}.findings must be an array with at most 20 entries`);
    return errors;
  }
  if ((status === 'clean' && findings.length !== 0)
      || (status === 'findings' && findings.length === 0)) {
    errors.push(`${label}.findings contradicts its status`);
  }
  if (JSON.stringify(findings).length > 8000) errors.push(`${label}.findings exceeds the concise evidence limit`);
  for (const [index, finding] of findings.entries()) {
    const prefix = `${label}.findings[${index}]`;
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const key of Object.keys(finding)) {
      if (key !== 'summary') errors.push(`${prefix}.${key} is not allowed`);
    }
    if (typeof finding.summary !== 'string' || finding.summary.trim() === '' || finding.summary.length > 1000) {
      errors.push(`${prefix}.summary must be a non-empty string of at most 1000 characters`);
    }
  }
  return errors;
}

export function validateSpecialistBundle(bundle, state) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return ['bundle must be an object'];
  const fields = ['schemaVersion', 'stage', 'prNumber', 'headSha', 'stateRevision', 'tasks', 'records', 'createdAt', 'updatedAt'];
  for (const field of fields) if (!Object.hasOwn(bundle, field)) errors.push(`bundle.${field} is required`);
  for (const field of Object.keys(bundle)) if (!fields.includes(field)) errors.push(`bundle.${field} is not allowed`);
  if (bundle.schemaVersion !== 1) errors.push('bundle.schemaVersion must be 1');
  if (!['pre-bind', 'post-integration'].includes(bundle.stage)) errors.push('bundle.stage is invalid');
  if (bundle.prNumber !== state.prNumber) errors.push('bundle.prNumber does not match state');
  if (typeof bundle.headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(bundle.headSha)) {
    errors.push('bundle.headSha is invalid');
  }
  if (bundle.stage === 'post-integration' && bundle.headSha !== state.currentIntegrationHeadSha) {
    errors.push('bundle.headSha is stale for the integrated review stage');
  }
  if (bundle.stage === 'pre-bind' && state.reviewedHeadSha !== null
      && bundle.headSha !== state.reviewedHeadSha) {
    errors.push('bundle.headSha does not match the reviewed commit');
  }
  if (bundle.stateRevision !== state.revision) errors.push('bundle.stateRevision is stale');
  if (!Array.isArray(bundle.tasks)
      || (bundle.stage === 'pre-bind' && bundle.tasks.length === 0)) {
    errors.push('bundle.tasks must be a non-empty array for pre-bind planning');
  } else {
    if (bundle.stage === 'pre-bind' && bundle.tasks.length !== 1) {
      errors.push('pre-bind bundles must contain exactly one task');
    }
    const ids = [];
    for (const [index, task] of bundle.tasks.entries()) {
      const prefix = `bundle.tasks[${index}]`;
      const taskFields = ['taskId', 'packetDigest', 'specialization', 'riskTags', 'planningSignals', 'route'];
      if (bundle.stage === 'pre-bind') taskFields.push('reviewedHeadSha', 'taskPacket');
      else taskFields.push('bindingProvenanceDigest');
      if (!task || typeof task !== 'object' || Array.isArray(task)) { errors.push(`${prefix} must be an object`); continue; }
      for (const field of taskFields) if (!Object.hasOwn(task, field)) errors.push(`${prefix}.${field} is required`);
      for (const field of Object.keys(task)) if (!taskFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
      if (typeof task.taskId !== 'string' || task.taskId.length === 0) errors.push(`${prefix}.taskId is invalid`);
      else ids.push(task.taskId);
      if (!/^[0-9a-f]{64}$/u.test(task.packetDigest ?? '')) errors.push(`${prefix}.packetDigest is invalid`);
      if (bundle.stage === 'post-integration'
          && !/^[0-9a-f]{64}$/u.test(task.bindingProvenanceDigest ?? '')) {
        errors.push(`${prefix}.bindingProvenanceDigest is invalid`);
      }
      if (typeof task.specialization !== 'string' || !Array.isArray(task.riskTags)) errors.push(`${prefix} specialization metadata is invalid`);
      if (bundle.stage === 'pre-bind') {
        const packetErrors = validateTaskPacket(task.taskPacket);
        errors.push(...packetErrors.map((error) => `${prefix}.taskPacket: ${error}`));
        if (packetErrors.length === 0) {
          if (task.taskPacket.taskId !== task.taskId
              || taskPacketDigest(task.taskPacket) !== task.packetDigest
              || task.taskPacket.reviewedHeadSha !== task.reviewedHeadSha
              || task.taskPacket.specialization !== task.specialization
              || canonicalSerializedJson(task.taskPacket.riskTags) !== canonicalSerializedJson(task.riskTags)) {
            errors.push(`${prefix}.taskPacket does not match its immutable planning metadata`);
          }
        }
        if (task.reviewedHeadSha !== bundle.headSha) {
          errors.push(`${prefix}.reviewedHeadSha must match the bundle reviewed commit`);
        }
      }
      const signals = task.planningSignals;
      if (!signals || typeof signals !== 'object' || Array.isArray(signals)
          || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
          || typeof signals.browserVisible !== 'boolean' || typeof signals.testSelectionUncertain !== 'boolean') {
        errors.push(`${prefix}.planningSignals is invalid`);
      }
      try {
        const canonicalRoute = canonicalBundleTaskRoute(task, bundle.stage);
        if (canonicalSerializedJson(task.route) !== canonicalSerializedJson(canonicalRoute)) {
          errors.push(`${prefix}.route does not match canonical specialist routing`);
        }
      } catch (error) {
        errors.push(`${prefix}.route cannot be recomputed: ${error.message}`);
      }
    }
    if (new Set(ids).size !== ids.length) errors.push('bundle task IDs must be unique');
  }
  if (!Array.isArray(bundle.records)) errors.push('bundle.records must be an array');
  else {
    const reviewers = [];
    let required = new Set();
    try {
      required = new Set(bundle.tasks?.flatMap((task) =>
        normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })) ?? []);
    } catch (error) {
      errors.push(`bundle task routes are invalid: ${error.message}`);
    }
    for (const record of bundle.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        errors.push('bundle record must be an object');
        continue;
      }
      const recordFields = [
        'schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'status',
        'summary', 'findings', 'recordedAt',
      ];
      for (const key of Object.keys(record)) {
        if (!recordFields.includes(key)) errors.push(`bundle record ${record.reviewerId ?? 'unknown'}.${key} is not allowed`);
      }
      if (typeof record?.reviewerId === 'string') reviewers.push(record.reviewerId);
      if (!required.has(record?.reviewerId)) errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} is not routed`);
      if (!isSpecialistEvidenceApplicable({
        evidence: record,
        subjectSha: bundle.headSha,
        phase: specialistPhaseForStage(bundle.stage),
      })) {
        errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} is stale`);
      }
      if (record?.schemaVersion !== 1 || record?.planRevision !== bundle.stateRevision) {
        errors.push(`bundle record ${record?.reviewerId ?? 'unknown'} does not match the exact plan revision`);
      }
      errors.push(...conciseSpecialistPayloadErrors({
        status: record.status, summary: record.summary, findings: record.findings,
      }, `bundle record ${record.reviewerId ?? 'unknown'}`));
      if (typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) {
        errors.push(`bundle record ${record.reviewerId ?? 'unknown'}.recordedAt is invalid`);
      }
    }
    if (new Set(reviewers).size !== reviewers.length) errors.push('bundle reviewer records must be unique');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof bundle[field] !== 'string' || !Number.isFinite(Date.parse(bundle[field]))) errors.push(`bundle.${field} is invalid`);
  }
  return errors;
}

export function readSpecialistBundle(cwd, state, { headSha = state.currentIntegrationHeadSha } = {}) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, headSha, state.revision);
  if (!existsSync(path)) throw new StateError(`No exact-HEAD specialist bundle at ${path}`, 'SPECIALIST_EVIDENCE_MISSING');
  const bundle = readJsonSidecar(path, 'specialist review bundle');
  if (bundle?.headSha !== headSha) {
    throw new StateError('Specialist bundle content does not match its exact-HEAD path', 'INVALID_SPECIALIST_REVIEW');
  }
  const errors = validateSpecialistBundle(bundle, state);
  if (errors.length > 0) throw new StateError(`Invalid specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
  verifySpecialistPlanReceipt(cwd, state, bundle);
  return bundle;
}

export function writeNewSpecialistBundle(cwd, state, bundle) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, bundle.headSha, state.revision);
  const serialized = canonicalSerializedJson(bundle);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Specialist review bundle exceeds 64 KiB', 'INVALID_SPECIALIST_REVIEW');
  }
  if (existsSync(path)) {
    const existing = readJsonSidecar(path, 'specialist review bundle');
    const errors = validateSpecialistBundle(existing, state);
    if (errors.length > 0) {
      throw new StateError(`Invalid existing specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    }
    if (specialistPlanDigest(existing) !== specialistPlanDigest(bundle)) {
      throw new StateError('An exact-HEAD/revision specialist plan already exists', 'SPECIALIST_PLAN_CONFLICT');
    }
    verifySpecialistPlanReceipt(cwd, state, existing);
    return existing;
  }
  persistSpecialistPlanReceipt(cwd, state, bundle);
  atomicWriteText(path, serialized);
  return bundle;
}
