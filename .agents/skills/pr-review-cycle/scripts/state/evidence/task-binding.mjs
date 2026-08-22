import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { specialistReviewDirectory } from '../../paths.mjs';
import { isSpecialistEvidenceApplicable } from '../../../../aerstello-specialists/scripts/validate-registry.mjs';
import { atomicWriteText, canonicalJson, canonicalSerializedJson, readJsonSidecar } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import {
  specialistReviewBundlePath, taskBindingProvenancePath, taskBindingProvenanceReceiptPath,
} from '../locations.mjs';
import {
  conciseSpecialistPayloadErrors, normalizedRequiredSpecialistIds, readSpecialistBundle,
  specialistPlanDigest, specialistRouteFor,
} from './specialist-bundle-store.mjs';
import { assertBoundTaskPacket, readTaskPacketSidecar, taskPacketDigest } from './task-packets.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;

export function loadBoundTaskPackets(cwd, state, { statuses } = {}) {
  return loadBoundTaskPacketEntries(cwd, state, { statuses }).map(({ packet }) => packet);
}

export function assertTaskPacketBound(state, packet, { cwd = state.integrationWorktree } = {}) {
  const task = assertBoundTaskPacket(state, packet, cwd);
  if (packet.schemaVersion !== 2) readBoundTaskBindingProvenance(cwd, state, task, packet);
  return task;
}

export function assertBehaviorMapperBundleComplete(bundle, packet) {
  const planned = bundle.stage === 'pre-bind' && bundle.tasks.length === 1 ? bundle.tasks[0] : null;
  if (!planned || planned.taskId !== packet.taskId || planned.packetDigest !== taskPacketDigest(packet)) {
    throw new StateError(`Task ${packet.taskId} does not match the exact pre-bind specialist plan`, 'SPECIALIST_PLAN_TASK_MISMATCH');
  }
  if (canonicalSerializedJson(planned.taskPacket) !== canonicalSerializedJson(packet)) {
    throw new StateError(`Task ${packet.taskId} differs from its exact pre-bind specialist packet`, 'SPECIALIST_PLAN_TASK_MISMATCH');
  }
  const required = normalizedRequiredSpecialistIds(planned.route, { stage: 'pre-bind' });
  if (required.includes('behavior_mapper')) {
    const mapper = bundle.records.find((record) => record.reviewerId === 'behavior_mapper');
    if (!mapper || mapper.status !== 'clean' || !isSpecialistEvidenceApplicable({
      evidence: mapper, subjectSha: packet.reviewedHeadSha, phase: 'planning',
    })) {
      throw new StateError('Behavior mapper must record a current-plan clean result before packet binding', 'BEHAVIOR_MAPPING_REQUIRED');
    }
    const hasExactRelatedE2E = packet.requiredValidation.system.some((entry) =>
      entry.command.startsWith('npm run test:e2e:related -- ')
      && entry.selectors.length > 0 && entry.projects.length > 0);
    if (!hasExactRelatedE2E) {
      throw new StateError(
        'Behavior-mapped work requires an exact related-E2E selector and browser-project selection before binding',
        'BEHAVIOR_TEST_SELECTION_REQUIRED',
      );
    }
  }
  return { bundle, planned };
}

export function assertBehaviorMapperPlanningComplete(cwd, state, packet) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, packet.reviewedHeadSha, state.revision);
  if (!existsSync(path)) throw new StateError(`Task ${packet.taskId} requires a guarded pre-bind specialist plan`, 'SPECIALIST_PLAN_REQUIRED');
  const bundle = readSpecialistBundle(cwd, state, { headSha: packet.reviewedHeadSha });
  return assertBehaviorMapperBundleComplete(bundle, packet);
}

export function recoverHistoricalTaskBindingPlanning(cwd, state, packet) {
  const directory = specialistReviewDirectory(cwd, state.prNumber);
  if (!existsSync(directory)) {
    throw new StateError(
      `Task ${packet.taskId} has no durable historical pre-bind specialist plan for provenance recovery`,
      'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED',
    );
  }
  const escapedHead = packet.reviewedHeadSha.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^${escapedHead}-r(\\d+)\\.json$`, 'u');
  const candidates = [];
  for (const name of readdirSync(directory).sort()) {
    const match = name.match(pattern);
    if (!match) continue;
    const revision = Number(match[1]);
    if (!Number.isInteger(revision) || revision > state.revision) continue;
    const historicalState = { ...state, revision, reviewedHeadSha: packet.reviewedHeadSha };
    let planning;
    try {
      const bundle = readSpecialistBundle(cwd, historicalState, { headSha: packet.reviewedHeadSha });
      planning = assertBehaviorMapperBundleComplete(bundle, packet);
    } catch {
      continue;
    }
    candidates.push(planning);
  }
  if (candidates.length !== 1) {
    throw new StateError(
      `Task ${packet.taskId} requires exactly one receipt-verified historical pre-bind plan; found ${candidates.length}`,
      'TASK_BINDING_PROVENANCE_RECOVERY_REQUIRED',
    );
  }
  return candidates[0];
}



export function taskBindingProvenanceDigest(provenance) {
  return createHash('sha256').update(canonicalSerializedJson(provenance)).digest('hex');
}

export function verifyTaskBindingProvenanceReceipt(cwd, state, task, provenance) {
  const path = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
  let recorded;
  try {
    if (statSync(path).size > 128) throw new Error('receipt exceeds 128 bytes');
    recorded = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StateError(
      `Unable to read task ${task.id} binding provenance receipt at ${path}: ${error.message}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  const expected = `${taskBindingProvenanceDigest(provenance)}\n`;
  if (recorded !== expected) {
    throw new StateError(
      `Task ${task.id} binding provenance receipt does not match its complete immutable evidence`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  return path;
}

export function persistTaskBindingProvenanceReceipt(cwd, state, task, provenance) {
  const path = taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id);
  const expected = `${taskBindingProvenanceDigest(provenance)}\n`;
  if (existsSync(path)) {
    try {
      if (statSync(path).size > 128 || readFileSync(path, 'utf8') !== expected) {
        throw new Error('receipt differs from the complete binding provenance');
      }
    } catch (error) {
      throw new StateError(
        `Task ${task.id} already has invalid immutable binding provenance receipt: ${error.message}`,
        'INVALID_TASK_BINDING_PROVENANCE',
      );
    }
    return path;
  }
  atomicWriteText(path, expected);
  return path;
}

export function validateTaskBindingProvenance(provenance, state, task, packet) {
  const errors = [];
  const fields = [
    'schemaVersion', 'phase', 'prNumber', 'taskId', 'packetDigest', 'reviewedHeadSha',
    'planRevision', 'planReceiptDigest', 'planningSignals', 'route', 'behaviorMapperResult',
  ];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance must be an object'];
  }
  for (const field of fields) if (!Object.hasOwn(provenance, field)) errors.push(`provenance.${field} is required`);
  for (const field of Object.keys(provenance)) if (!fields.includes(field)) errors.push(`provenance.${field} is not allowed`);
  if (provenance.schemaVersion !== 1) errors.push('provenance.schemaVersion must be 1');
  if (provenance.phase !== 'pre-bind') errors.push('provenance.phase must be pre-bind');
  if (provenance.prNumber !== state.prNumber) errors.push('provenance.prNumber does not match state');
  if (provenance.taskId !== task.id || provenance.taskId !== packet.taskId) {
    errors.push('provenance.taskId does not match the durable task and packet');
  }
  const packetDigest = taskPacketDigest(packet);
  if (provenance.packetDigest !== packetDigest) errors.push('provenance.packetDigest does not match the packet');
  if (typeof task.taskPacketDigest === 'string' && task.taskPacketDigest !== provenance.packetDigest) {
    errors.push('provenance.packetDigest does not match active state');
  }
  if (provenance.reviewedHeadSha !== packet.reviewedHeadSha) {
    errors.push('provenance.reviewedHeadSha does not match the packet');
  }
  if (!Number.isInteger(provenance.planRevision) || provenance.planRevision < 0
      || provenance.planRevision > state.revision) {
    errors.push('provenance.planRevision is invalid');
  }
  if (!/^[0-9a-f]{64}$/u.test(provenance.planReceiptDigest ?? '')) {
    errors.push('provenance.planReceiptDigest is invalid');
  }
  const signals = provenance.planningSignals;
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)
      || Object.keys(signals).sort().join(',') !== 'browserVisible,testSelectionUncertain'
      || typeof signals.browserVisible !== 'boolean'
      || typeof signals.testSelectionUncertain !== 'boolean') {
    errors.push('provenance.planningSignals must contain exactly browserVisible and testSelectionUncertain booleans');
  }
  let canonicalRoute;
  try {
    canonicalRoute = specialistRouteFor(packet, signals);
    if (canonicalSerializedJson(provenance.route) !== canonicalSerializedJson(canonicalRoute)) {
      errors.push('provenance.route does not match canonical specialist routing');
    }
  } catch (error) {
    errors.push(`provenance.route cannot be recomputed: ${error.message}`);
  }
  let requiredPlanning = [];
  try {
    requiredPlanning = normalizedRequiredSpecialistIds(canonicalRoute ?? provenance.route, { stage: 'pre-bind' });
  } catch (error) {
    errors.push(`provenance planning reviewers are invalid: ${error.message}`);
  }
  if (requiredPlanning.some((reviewerId) => reviewerId !== 'behavior_mapper')) {
    errors.push('provenance contains an unsupported planning reviewer route');
  }
  const mapperRequired = requiredPlanning.includes('behavior_mapper');
  const mapperResult = provenance.behaviorMapperResult;
  if (!mapperRequired && mapperResult !== null) {
    errors.push('provenance.behaviorMapperResult is present when behavior mapping was not routed');
  } else if (mapperRequired) {
    if (!mapperResult || typeof mapperResult !== 'object' || Array.isArray(mapperResult)) {
      errors.push('provenance.behaviorMapperResult is required');
    } else {
      const mapperFields = ['phase', 'evidence'];
      for (const field of mapperFields) if (!Object.hasOwn(mapperResult, field)) errors.push(`provenance.behaviorMapperResult.${field} is required`);
      for (const field of Object.keys(mapperResult)) if (!mapperFields.includes(field)) errors.push(`provenance.behaviorMapperResult.${field} is not allowed`);
      if (mapperResult.phase !== 'planning') errors.push('provenance.behaviorMapperResult.phase must be planning');
      const evidence = mapperResult.evidence;
      const evidenceFields = [
        'schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'status',
        'summary', 'findings', 'recordedAt',
      ];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        errors.push('provenance.behaviorMapperResult.evidence must be an object');
      } else {
        for (const field of evidenceFields) if (!Object.hasOwn(evidence, field)) errors.push(`provenance.behaviorMapperResult.evidence.${field} is required`);
        for (const field of Object.keys(evidence)) if (!evidenceFields.includes(field)) errors.push(`provenance.behaviorMapperResult.evidence.${field} is not allowed`);
        if (evidence.schemaVersion !== 1 || evidence.planRevision !== provenance.planRevision
            || evidence.reviewerId !== 'behavior_mapper' || evidence.status !== 'clean') {
          errors.push('provenance behavior mapper evidence does not match its clean exact plan');
        }
        if (!isSpecialistEvidenceApplicable({
          evidence, subjectSha: provenance.reviewedHeadSha, phase: 'planning',
        })) {
          errors.push('provenance behavior mapper evidence is stale for the reviewed HEAD');
        }
        errors.push(...conciseSpecialistPayloadErrors({
          status: evidence.status, summary: evidence.summary, findings: evidence.findings,
        }, 'provenance behavior mapper evidence'));
        if (typeof evidence.recordedAt !== 'string' || !Number.isFinite(Date.parse(evidence.recordedAt))) {
          errors.push('provenance behavior mapper evidence.recordedAt is invalid');
        }
      }
    }
  }
  return errors;
}

export function buildTaskBindingProvenance(state, packet, planning) {
  const mapper = planning.bundle.records.find((record) => record.reviewerId === 'behavior_mapper') ?? null;
  return canonicalJson({
    schemaVersion: 1,
    phase: 'pre-bind',
    prNumber: state.prNumber,
    taskId: packet.taskId,
    packetDigest: taskPacketDigest(packet),
    reviewedHeadSha: packet.reviewedHeadSha,
    planRevision: planning.bundle.stateRevision,
    planReceiptDigest: specialistPlanDigest(planning.bundle),
    planningSignals: planning.planned.planningSignals,
    route: planning.planned.route,
    behaviorMapperResult: mapper === null ? null : { phase: 'planning', evidence: mapper },
  });
}

export function assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance) {
  const historicalState = {
    ...state,
    revision: provenance.planRevision,
    reviewedHeadSha: provenance.reviewedHeadSha,
  };
  let planning;
  try {
    const bundle = readSpecialistBundle(cwd, historicalState, { headSha: provenance.reviewedHeadSha });
    planning = assertBehaviorMapperBundleComplete(bundle, packet);
  } catch (error) {
    throw new StateError(
      `Task ${task.id} binding provenance source is invalid: ${error.message}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  if (specialistPlanDigest(planning.bundle) !== provenance.planReceiptDigest) {
    throw new StateError(
      `Task ${task.id} binding provenance does not match its specialist plan receipt`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  const expected = buildTaskBindingProvenance(state, packet, planning);
  if (canonicalSerializedJson(expected) !== canonicalSerializedJson(provenance)) {
    throw new StateError(
      `Task ${task.id} binding provenance differs from its receipt-verified historical pre-bind plan`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  return planning;
}

export function persistImmutableTaskBindingProvenance(cwd, state, task, packet, provenance) {
  const path = taskBindingProvenancePath(cwd, state.prNumber, task.id);
  const errors = validateTaskBindingProvenance(provenance, state, task, packet);
  if (errors.length > 0) {
    throw new StateError(`Invalid task binding provenance:\n- ${errors.join('\n- ')}`, 'INVALID_TASK_BINDING_PROVENANCE');
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance);
  const serialized = canonicalSerializedJson(provenance);
  if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError('Task binding provenance exceeds 64 KiB', 'INVALID_TASK_BINDING_PROVENANCE');
  }
  if (existsSync(path)) {
    let existing;
    try { existing = readJsonSidecar(path, 'task binding provenance'); } catch (error) {
      throw new StateError(`Task ${task.id} has invalid immutable binding provenance: ${error.message}`, 'INVALID_TASK_BINDING_PROVENANCE');
    }
    const existingErrors = validateTaskBindingProvenance(existing, state, task, packet);
    if (existingErrors.length > 0 || canonicalSerializedJson(existing) !== serialized) {
      throw new StateError(
        `Task ${task.id} already has different or invalid immutable binding provenance`,
        'INVALID_TASK_BINDING_PROVENANCE',
      );
    }
    assertTaskBindingProvenanceSource(cwd, state, task, packet, existing);
    verifyTaskBindingProvenanceReceipt(cwd, state, task, existing);
    return existing;
  }
  persistTaskBindingProvenanceReceipt(cwd, state, task, provenance);
  atomicWriteText(path, serialized);
  const persisted = readJsonSidecar(path, 'task binding provenance');
  const persistedErrors = validateTaskBindingProvenance(persisted, state, task, packet);
  if (persistedErrors.length > 0 || canonicalSerializedJson(persisted) !== serialized) {
    throw new StateError(`Binding provenance verification failed for task ${task.id}`, 'TASK_BINDING_PROVENANCE_WRITE_FAILED');
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, persisted);
  verifyTaskBindingProvenanceReceipt(cwd, state, task, persisted);
  return persisted;
}

export function readBoundTaskBindingProvenance(cwd, state, task, packet) {
  const path = taskBindingProvenancePath(cwd, state.prNumber, task.id);
  if (!existsSync(path)) {
    throw new StateError(
      `Task ${task.id} is bound without immutable pre-bind planning provenance`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  let provenance;
  try { provenance = readJsonSidecar(path, 'task binding provenance'); } catch (error) {
    throw new StateError(`Task ${task.id} has invalid immutable binding provenance: ${error.message}`, 'INVALID_TASK_BINDING_PROVENANCE');
  }
  const errors = validateTaskBindingProvenance(provenance, state, task, packet);
  if (errors.length > 0) {
    throw new StateError(
      `Task ${task.id} has invalid immutable binding provenance:\n- ${errors.join('\n- ')}`,
      'INVALID_TASK_BINDING_PROVENANCE',
    );
  }
  assertTaskBindingProvenanceSource(cwd, state, task, packet, provenance);
  verifyTaskBindingProvenanceReceipt(cwd, state, task, provenance);
  return provenance;
}

export function loadBoundTaskPacketEntries(cwd, state, { statuses } = {}) {
  const selected = state.tasks.filter((task) => task.disposition === 'actionable'
    && typeof task.taskPacketDigest === 'string'
    && (!statuses || statuses.includes(task.status)));
  return selected.map((task) => {
    const packet = readTaskPacketSidecar(cwd, state, task, { verifyBindingProvenance: false });
    return { task, packet, provenance: readBoundTaskBindingProvenance(cwd, state, task, packet) };
  });
}
