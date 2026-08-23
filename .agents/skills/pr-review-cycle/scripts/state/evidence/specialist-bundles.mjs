import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSpecialistEvidenceApplicable, validateSpecialistEvidence } from '../../../../aerstello-specialists/scripts/validate-registry.mjs';
import { specialistReviewDirectory } from '../../paths.mjs';
import { atomicWriteText, canonicalJson, canonicalSerializedJson } from '../atomic-io.mjs';
import { StateError } from '../errors.mjs';
import { gitSnapshot } from '../git-authority.mjs';
import {
  specialistPlanReceiptPath, specialistReviewBundlePath, taskBindingProvenancePath,
  taskBindingProvenanceReceiptPath, taskPacketSidecarPath,
} from '../locations.mjs';
import { withStateLock } from '../locks.mjs';
import { activePrNumber, loadState } from '../state-store.mjs';
import {
  loadBoundTaskPacketEntries, readBoundTaskBindingProvenance, recoverHistoricalTaskBindingPlanning,
  taskBindingProvenanceDigest,
} from './task-binding.mjs';
import {
  conciseSpecialistPayloadErrors, normalizedRequiredSpecialistIds, readSpecialistBundle,
  specialistPhaseForStage, specialistPlanningErrors, specialistRouteFor, validateSpecialistBundle,
  writeNewSpecialistBundle,
} from './specialist-bundle-store.mjs';
import {
  assertBoundTaskPacket, assertTaskPacketHead, hasCompletedHistoricalV2TaskProof,
  readTaskPacketSidecar, taskPacketDigest,
} from './task-packets.mjs';
import { readAcceptedWorkerResult } from './worker-results.mjs';

const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
const PR_FINAL_VERIFIER_ID = 'integration_verifier';
function utcNow() { return new Date().toISOString(); }
function assertCleanExactIntegrationHead(state) {
  const actual = gitSnapshot(state.integrationWorktree);
  if (actual.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError('Integration HEAD differs from active state; checkpoint Git metadata first', 'VALIDATION_PLAN_STALE');
  }
  if (actual.dirty) throw new StateError('Integration checkout must be clean for targeted validation', 'VALIDATION_CHECKOUT_DIRTY');
  return actual;
}
function readBoundTaskPacketSidecar(cwd, state, task, options = {}) {
  const packet = readTaskPacketSidecar(cwd, state, task, options);
  if (options.verifyBindingProvenance !== false) readBoundTaskBindingProvenance(cwd, state, task, packet);
  return packet;
}

const TASKLESS_VERIFIER_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

function uncoveredVerifierOutcomes(state, entries) {
  const representedTaskIds = new Set(entries.map(({ task }) => task.id));
  const uncovered = state.tasks.filter((task) => !representedTaskIds.has(task.id));
  const ineligible = uncovered.find((task) => task.disposition === 'actionable'
    || !TASKLESS_VERIFIER_DISPOSITIONS.has(task.disposition)
    || !['not-applicable', 'completed'].includes(task.status));
  if (ineligible) {
    throw new StateError(
      `Post-integration planning does not cover task ${ineligible.id}, which is actionable, nonterminal, or human-gated`,
      'SPECIALIST_PLAN_TASK_MISMATCH',
    );
  }
  return uncovered.sort((a, b) => a.id.localeCompare(b.id)).map((task) => canonicalJson({
    taskId: task.id,
    sourceIds: task.sourceIds,
    sourceType: task.sourceType,
    fingerprint: task.fingerprint,
    summary: task.summary,
    severity: task.severity,
    disposition: task.disposition,
    status: task.status,
    integratedCommitSha: task.integratedCommitSha,
    resolutionSummary: task.resolutionSummary,
  }));
}

function assertPostIntegrationBundleCoverage(cwd, state, bundle) {
  if (bundle.stage !== 'post-integration') return null;
  if (state.validationStatus.status !== 'passed'
      || state.validationStatus.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError(
      'Post-integration specialist context requires passed exact-HEAD targeted validation',
      'SPECIALIST_VALIDATION_REQUIRED',
    );
  }
  const entries = loadBoundTaskPacketEntries(cwd, state, { statuses: ['integrated', 'completed'] })
    .sort((a, b) => a.packet.taskId.localeCompare(b.packet.taskId));
  entries.forEach(({ packet }) => assertBoundTaskPacket(state, packet, cwd));
  const taskOutcomes = uncoveredVerifierOutcomes(state, entries);
  const expectedTasks = entries.map(({ packet, provenance }) => ({
    taskId: packet.taskId,
    packetDigest: taskPacketDigest(packet),
    specialization: packet.specialization,
    riskTags: packet.riskTags,
    bindingProvenanceDigest: taskBindingProvenanceDigest(provenance),
    planningSignals: provenance.planningSignals,
    route: specialistRouteFor(packet, provenance.planningSignals),
  }));
  const actualTasks = [...bundle.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (canonicalSerializedJson(actualTasks) !== canonicalSerializedJson(expectedTasks)) {
    throw new StateError(
      'Specialist bundle does not cover current Integrated or Resolved packet sidecars',
      'SPECIALIST_PLAN_TASK_MISMATCH',
    );
  }
  return { entries, packets: entries.map(({ packet }) => packet), expectedTasks, taskOutcomes };
}

export function planSpecialists({ cwd = process.cwd(), prNumber, input, expectedRevision, now = utcNow } = {}) {
  const errors = specialistPlanningErrors(input);
  if (errors.length > 0) throw new StateError(`Invalid specialist planning input:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_PLAN');
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const state = loadState(cwd, selectedPr);
    if (expectedRevision !== state.revision) throw new StateError(`State revision changed: expected ${expectedRevision}, found ${state.revision}`, 'STATE_REVISION_CONFLICT');
    if (input.stage === 'pre-bind' && input.tasks.length !== 1) {
      throw new StateError('Pre-bind specialist planning accepts exactly one task per guarded revision', 'INVALID_SPECIALIST_PLAN');
    }
    const expectedHeadSha = input.stage === 'pre-bind'
      ? input.tasks[0].taskPacket.reviewedHeadSha
      : state.currentIntegrationHeadSha;
    if (input.headSha !== expectedHeadSha) {
      throw new StateError(
        `Specialist plan must bind to the exact ${input.stage === 'pre-bind' ? 'reviewed' : 'integrated'} HEAD`,
        'SPECIALIST_PLAN_STALE',
      );
    }
    let packets;
    let boundEntries = null;
    if (input.stage === 'pre-bind') {
      packets = input.tasks.map((entry) => entry.taskPacket);
      for (const packet of packets) {
        const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
        if (!task || task.disposition !== 'actionable' || task.taskPacketDigest) {
          throw new StateError(`Task ${packet.taskId} is not an unbound actionable task`, 'SPECIALIST_PLAN_TASK_MISMATCH');
        }
        assertTaskPacketHead(state, task, packet, taskPacketDigest(packet));
      }
    } else {
      assertCleanExactIntegrationHead(state);
      if (state.validationStatus.status !== 'passed' || state.validationStatus.headSha !== state.currentIntegrationHeadSha) {
        throw new StateError('Post-integration specialist planning requires passed exact-HEAD targeted validation', 'SPECIALIST_VALIDATION_REQUIRED');
      }
      boundEntries = loadBoundTaskPacketEntries(cwd, state, { statuses: ['integrated', 'completed'] })
        .sort((a, b) => a.packet.taskId.localeCompare(b.packet.taskId));
      boundEntries.forEach(({ packet }) => assertBoundTaskPacket(state, packet, cwd));
      packets = boundEntries.map(({ packet }) => packet);
      uncoveredVerifierOutcomes(state, boundEntries);
      const supplied = [...input.tasks].map((entry) => entry.taskPacket).sort((a, b) => a.taskId.localeCompare(b.taskId));
      if (canonicalSerializedJson(supplied) !== canonicalSerializedJson(packets)) {
        throw new StateError('Post-integration planning input must exactly cover durable Integrated or Resolved packet sidecars', 'SPECIALIST_PLAN_TASK_MISMATCH');
      }
    }
    const timestamp = now();
    const tasks = packets.map((packet, index) => {
      const planningSignals = input.stage === 'pre-bind'
        ? input.tasks[index].planningSignals
        : boundEntries[index].provenance.planningSignals;
      return {
        taskId: packet.taskId,
        packetDigest: taskPacketDigest(packet),
        specialization: packet.specialization,
        riskTags: packet.riskTags,
        route: specialistRouteFor(packet, planningSignals),
        ...(input.stage === 'pre-bind' ? {
          reviewedHeadSha: packet.reviewedHeadSha,
          planningSignals,
          taskPacket: canonicalJson(packet),
        } : {
          bindingProvenanceDigest: taskBindingProvenanceDigest(boundEntries[index].provenance),
          planningSignals,
        }),
      };
    });
    const bundle = {
      schemaVersion: 1, stage: input.stage, prNumber: state.prNumber,
      headSha: input.headSha, stateRevision: state.revision,
      tasks, records: [], createdAt: timestamp, updatedAt: timestamp,
    };
    const bundleErrors = validateSpecialistBundle(bundle, state);
    if (bundleErrors.length > 0) throw new StateError(`Invalid specialist plan:\n- ${bundleErrors.join('\n- ')}`, 'INVALID_SPECIALIST_PLAN');
    return writeNewSpecialistBundle(cwd, state, bundle);
  });
}

function assertConciseSpecialistRecord(input) {
  const fields = ['schemaVersion', 'planRevision', 'headSha', 'reviewerId', 'outcome', 'summary', 'findings'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StateError('Specialist record input must be an object', 'INVALID_SPECIALIST_REVIEW');
  for (const field of fields) if (!Object.hasOwn(input, field)) throw new StateError(`Specialist record input.${field} is required`, 'INVALID_SPECIALIST_REVIEW');
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw new StateError(`Specialist record input.${field} is not allowed`, 'INVALID_SPECIALIST_REVIEW');
  const payloadErrors = conciseSpecialistPayloadErrors({
    status: input.outcome, summary: input.summary, findings: input.findings,
  }, 'specialist record input');
  if (input.schemaVersion !== 1 || payloadErrors.length > 0) {
    throw new StateError(
      `Specialist record must contain one concise clean statement or concise findings${payloadErrors.length > 0 ? `:\n- ${payloadErrors.join('\n- ')}` : ''}`,
      'INVALID_SPECIALIST_REVIEW',
    );
  }
}

export function recordSpecialistReview({ cwd = process.cwd(), prNumber, input, expectedRevision, now = utcNow } = {}) {
  assertConciseSpecialistRecord(input);
  const selectedPr = prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return withStateLock(cwd, selectedPr, () => {
    const state = loadState(cwd, selectedPr);
    if (expectedRevision !== state.revision || input.planRevision !== state.revision) {
      throw new StateError(`Specialist evidence revision must equal current revision ${state.revision}`, 'STATE_REVISION_CONFLICT');
    }
    const bundle = readSpecialistBundle(cwd, state, { headSha: input.headSha });
    if (bundle.stage === 'post-integration') {
      const checkoutError = currentSpecialistCheckoutError(state);
      if (checkoutError !== null) {
        throw new StateError(`Specialist evidence is stale: ${checkoutError}`, 'SPECIALIST_PLAN_STALE');
      }
      assertPostIntegrationBundleCoverage(cwd, state, bundle);
    }
    const required = new Set(bundle.tasks.flatMap((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })));
    if (!required.has(input.reviewerId)) throw new StateError(`Reviewer ${input.reviewerId} is not routed by this plan`, 'SPECIALIST_REVIEWER_MISMATCH');
    const evidence = {
      schemaVersion: 1, planRevision: input.planRevision, headSha: input.headSha,
      reviewerId: input.reviewerId, status: input.outcome, summary: input.summary,
      findings: input.findings, recordedAt: now(),
    };
    const phase = specialistPhaseForStage(bundle.stage);
    const route = bundle.tasks.find((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage }).includes(input.reviewerId)).route;
    const routeField = phase === 'planning' ? 'planningHelpers' : 'riskReviewers';
    const oneSpecialistRoute = {
      ...route,
      [routeField]: route[routeField].filter((specialist) => specialist.id === input.reviewerId),
    };
    const evidenceErrors = validateSpecialistEvidence({
      evidence: [evidence], route: oneSpecialistRoute, subjectSha: bundle.headSha, phase,
    });
    if (evidenceErrors.length > 0) {
      throw new StateError(`Invalid specialist reviewer evidence:\n- ${evidenceErrors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    }
    const existing = bundle.records.find((record) => record.reviewerId === input.reviewerId);
    if (existing) {
      const comparableExisting = {
        schemaVersion: existing.schemaVersion, planRevision: existing.planRevision, headSha: existing.headSha,
        reviewerId: existing.reviewerId, outcome: existing.status, summary: existing.summary, findings: existing.findings,
      };
      if (canonicalSerializedJson(comparableExisting) === canonicalSerializedJson(input)) return bundle;
      throw new StateError(`Reviewer ${input.reviewerId} already has different exact-plan evidence`, 'SPECIALIST_EVIDENCE_CONFLICT');
    }
    const updated = { ...bundle, records: [...bundle.records, evidence], updatedAt: evidence.recordedAt };
    const errors = validateSpecialistBundle(updated, state);
    if (errors.length > 0) throw new StateError(`Invalid specialist review bundle:\n- ${errors.join('\n- ')}`, 'INVALID_SPECIALIST_REVIEW');
    const serialized = canonicalSerializedJson(updated);
    if (Buffer.byteLength(serialized, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
      throw new StateError('Specialist review bundle exceeds 64 KiB', 'INVALID_SPECIALIST_REVIEW');
    }
    atomicWriteText(specialistReviewBundlePath(cwd, state.prNumber, bundle.headSha, state.revision), serialized);
    return updated;
  });
}

function assertBehaviorMapperBundleComplete(bundle, packet) {
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

function assertBehaviorMapperPlanningComplete(cwd, state, packet) {
  const path = specialistReviewBundlePath(cwd, state.prNumber, packet.reviewedHeadSha, state.revision);
  if (!existsSync(path)) throw new StateError(`Task ${packet.taskId} requires a guarded pre-bind specialist plan`, 'SPECIALIST_PLAN_REQUIRED');
  const bundle = readSpecialistBundle(cwd, state, { headSha: packet.reviewedHeadSha });
  return assertBehaviorMapperBundleComplete(bundle, packet);
}

function currentSpecialistCheckoutError(state) {
  try {
    const actual = gitSnapshot(state.integrationWorktree);
    if (actual.headSha !== state.currentIntegrationHeadSha) return 'integration HEAD changed without a guarded state checkpoint';
    if (actual.dirty) return 'integration checkout has uncommitted changes';
    return null;
  } catch (error) {
    return `integration checkout could not be inspected: ${error.message}`;
  }
}

export function specialistContext({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const checkoutError = currentSpecialistCheckoutError(state);
  if (checkoutError !== null) {
    throw new StateError(`Specialist evidence is stale: ${checkoutError}`, 'SPECIALIST_PLAN_STALE');
  }
  const bundle = readSpecialistBundle(cwd, state);
  if (bundle.stage !== 'post-integration') throw new StateError('Current specialist bundle is not a post-integration review plan', 'SPECIALIST_EVIDENCE_MISSING');
  const {
    entries, packets, expectedTasks, taskOutcomes,
  } = assertPostIntegrationBundleCoverage(cwd, state, bundle);
  const required = [...new Set(bundle.tasks.flatMap((task) =>
    normalizedRequiredSpecialistIds(task.route, { stage: 'post-integration' })))].sort();
  const records = new Map(bundle.records.map((record) => [record.reviewerId, record]));
  const missing = required.filter((id) => !records.has(id));
  const stale = required.filter((id) => records.has(id)
    && !isSpecialistEvidenceApplicable({
      evidence: records.get(id), subjectSha: state.currentIntegrationHeadSha, phase: 'review',
    }));
  const findings = required.filter((id) => records.get(id)?.status === 'findings')
    .map((id) => records.get(id));
  const routes = expectedTasks.map(({ taskId, route }) => ({ phase: 'post-integration', taskId, route }));
  const finalVerificationPriority = expectedTasks.some(({ route }) =>
    route.finalVerificationPriority === 'high') ? 'high' : 'standard';
  const specialistResults = required.filter((id) => records.has(id)).map((id) => records.get(id));
  const workerResultEvidence = entries.map(({ task, packet }) => {
    try {
      const envelope = readAcceptedWorkerResult(cwd, state, task, packet);
      return {
        taskId: task.id,
        status: 'valid',
        resultDigest: envelope.resultDigest,
        envelope: canonicalJson({
          taskId: task.id,
          packetDigest: envelope.packetDigest,
          resultDigest: envelope.resultDigest,
          reviewedHeadSha: envelope.reviewedHeadSha,
          workerCommitSha: envelope.result.commitSha,
          integratedCommitSha: task.integratedCommitSha,
          result: envelope.result,
        }),
      };
    } catch (error) {
      return {
        taskId: task.id,
        status: error.code === 'WORKER_RESULT_MISSING' ? 'missing' : 'invalid',
        resultDigest: task.workerResultDigest ?? null,
        error: error.code ?? 'INVALID_WORKER_RESULT_EVIDENCE',
      };
    }
  });
  const invalidWorkerResults = workerResultEvidence.filter((entry) => entry.status !== 'valid');
  const workerResults = workerResultEvidence.filter((entry) => entry.status === 'valid')
    .map((entry) => entry.envelope);
  const preBindPlanning = entries.map(({ provenance }) => canonicalJson({
    phase: 'pre-bind',
    taskId: provenance.taskId,
    packetDigest: provenance.packetDigest,
    reviewedHeadSha: provenance.reviewedHeadSha,
    planRevision: provenance.planRevision,
    planReceiptDigest: provenance.planReceiptDigest,
    planningSignals: provenance.planningSignals,
    route: provenance.route,
    behaviorMapperResult: provenance.behaviorMapperResult,
  }));
  return {
    schemaVersion: 1,
    status: missing.length > 0 || stale.length > 0 || invalidWorkerResults.length > 0
      ? 'incomplete' : findings.length > 0 ? 'findings' : 'clean',
    readyForIntegrationVerifier: missing.length === 0 && stale.length === 0
      && findings.length === 0 && invalidWorkerResults.length === 0,
    headSha: state.currentIntegrationHeadSha,
    stateRevision: state.revision,
    taskOutcomes,
    packets: packets.map((packet) => canonicalJson(packet)),
    workerResultEvidence,
    workerResults,
    missingWorkerResultTaskIds: workerResultEvidence.filter((entry) => entry.status === 'missing').map((entry) => entry.taskId),
    invalidWorkerResultTaskIds: workerResultEvidence.filter((entry) => entry.status === 'invalid').map((entry) => entry.taskId),
    preBindPlanning,
    routes,
    finalVerification: {
      verifierId: PR_FINAL_VERIFIER_ID,
      priority: finalVerificationPriority,
    },
    requiredReviewerIds: required,
    missingReviewerIds: missing,
    staleReviewerIds: stale,
    specialistResults,
    findings,
    postIntegrationReview: {
      phase: 'review', headSha: state.currentIntegrationHeadSha, routes,
      requiredReviewerIds: required, specialistResults, findings,
    },
    targetedValidation: state.validationStatus,
  };
}

export function readSpecialistStatus({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, prNumber);
  if (!state) return { status: 'missing', headSha: null, stateRevision: null, bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [] };
  const checkoutError = currentSpecialistCheckoutError(state);
  if (checkoutError !== null) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [], error: 'SPECIALIST_PLAN_STALE',
    };
  }
  try {
    for (const task of state.tasks.filter((candidate) => candidate.disposition === 'actionable'
      && typeof candidate.taskPacketDigest === 'string')) {
      if (!existsSync(taskPacketSidecarPath(cwd, state.prNumber, task.id))
          && !existsSync(taskBindingProvenancePath(cwd, state.prNumber, task.id))
          && !existsSync(taskBindingProvenanceReceiptPath(cwd, state.prNumber, task.id))
          && hasCompletedHistoricalV2TaskProof(cwd, state, task)) continue;
      readBoundTaskPacketSidecar(cwd, state, task);
    }
  } catch (error) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [],
      error: error.code ?? 'INVALID_TASK_BINDING_PROVENANCE',
    };
  }
  const candidates = [...new Set([
    state.currentIntegrationHeadSha,
    ...(state.reviewedHeadSha === null ? [] : [state.reviewedHeadSha]),
  ])].map((headSha) => ({
    headSha,
    path: specialistReviewBundlePath(cwd, state.prNumber, headSha, state.revision),
  })).filter(({ path }) => existsSync(path));
  if (candidates.length === 0) {
    const directory = specialistReviewDirectory(cwd, state.prNumber);
    const orphanReceipts = [...new Set([
      state.currentIntegrationHeadSha,
      ...(state.reviewedHeadSha === null ? [] : [state.reviewedHeadSha]),
    ])].map((headSha) => specialistPlanReceiptPath(cwd, state.prNumber, headSha, state.revision))
      .filter((path) => existsSync(path));
    if (orphanReceipts.length > 0) {
      return {
        status: 'pending', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
        bundlePath: null, receiptPath: orphanReceipts[0], requiredReviewerIds: [], recordedReviewerIds: [],
        error: 'SPECIALIST_PLAN_INCOMPLETE',
      };
    }
    const hasHistorical = existsSync(directory) && readdirSync(directory)
      .some((name) => name.endsWith('.json') || name.endsWith('.plan.sha256'));
    return {
      status: hasHistorical ? 'stale' : 'missing', headSha: state.currentIntegrationHeadSha,
      stateRevision: state.revision, bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [],
    };
  }
  if (candidates.length !== 1) {
    return {
      status: 'stale', headSha: state.currentIntegrationHeadSha, stateRevision: state.revision,
      bundlePath: null, requiredReviewerIds: [], recordedReviewerIds: [], error: 'AMBIGUOUS_SPECIALIST_REVIEW',
    };
  }
  const [{ headSha, path }] = candidates;
  try {
    const bundle = readSpecialistBundle(cwd, state, { headSha });
    assertPostIntegrationBundleCoverage(cwd, state, bundle);
    const required = [...new Set(bundle.tasks.flatMap((task) =>
      normalizedRequiredSpecialistIds(task.route, { stage: bundle.stage })))].sort();
    const recorded = bundle.records.map((record) => record.reviewerId).sort();
    const missing = required.filter((id) => !recorded.includes(id));
    const stale = bundle.records.filter((record) => !isSpecialistEvidenceApplicable({
      evidence: record,
      subjectSha: bundle.headSha,
      phase: specialistPhaseForStage(bundle.stage),
    })).map((record) => record.reviewerId).sort();
    const findings = bundle.records.filter((record) => record.status === 'findings').map((record) => record.reviewerId).sort();
    return {
      status: stale.length > 0 ? 'stale' : missing.length > 0 ? 'pending' : findings.length > 0 ? 'finding' : 'clean',
      headSha: bundle.headSha, stateRevision: state.revision, bundlePath: path,
      stage: bundle.stage, requiredReviewerIds: required, recordedReviewerIds: recorded,
      missingReviewerIds: missing, staleReviewerIds: stale, findingReviewerIds: findings,
    };
  } catch (error) {
    return {
      status: 'stale', headSha, stateRevision: state.revision,
      bundlePath: path, requiredReviewerIds: [], recordedReviewerIds: [], error: error.code ?? 'INVALID_SPECIALIST_REVIEW',
    };
  }
}
