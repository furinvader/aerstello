import { existsSync, readFileSync } from 'node:fs';
import { StateError } from './errors.mjs';
import { reviewRequestUsage } from '../contracts/contracts.mjs';
import { validationPlanPath } from './locations.mjs';
import { reconcileState } from './reconciliation.mjs';
import { loadState } from './state-store.mjs';
import { readSpecialistStatus } from './evidence/specialist-bundles.mjs';
import {
  actionablePacketValidationTaskIds, readValidationPlan, validateValidationPlan,
} from './evidence/validation-plans.mjs';

const VALIDATION_PLAN_LIMIT_BYTES = 64 * 1024;

function staleDiscoveryDispositionList(state) {
  return Array.isArray(state?.staleDiscoveryDispositions) ? state.staleDiscoveryDispositions : [];
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function validationPlanRecoverySummary(cwd, state) {
  const path = validationPlanPath(cwd, state.prNumber);
  if (!existsSync(path)) return 'missing';
  try {
    const plan = readValidationPlan(cwd, state);
    const counts = Object.fromEntries(['pending', 'passed', 'failed'].map((status) => [
      status, plan.commands.filter((entry) => entry.status === status).length,
    ]));
    return `${plan.headSha}; pending ${counts.pending}, passed ${counts.passed}, failed ${counts.failed}`;
  } catch (error) {
    if (error.code !== 'INVALID_VALIDATION_PLAN') return `unavailable (${error.code ?? 'error'})`;
    try {
      const source = readFileSync(path, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > VALIDATION_PLAN_LIMIT_BYTES) return 'invalid';
      const plan = JSON.parse(source);
      const historicalErrors = validateValidationPlan(plan, {
        ...state, revision: plan?.stateRevision, currentIntegrationHeadSha: plan?.headSha,
      });
      if (historicalErrors.length > 0) return 'invalid';
      const counts = Object.fromEntries(['pending', 'passed', 'failed'].map((status) => [
        status, plan.commands.filter((entry) => entry.status === status).length,
      ]));
      const countSummary = `pending ${counts.pending}, passed ${counts.passed}, failed ${counts.failed}`;
      if (plan.headSha !== state.currentIntegrationHeadSha) {
        return `historical for ${plan.headSha}; ${countSummary}; current HEAD is ${state.currentIntegrationHeadSha}`;
      }
      const recordedStatus = plan.commands.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
      const proofMatches = counts.pending === 0
        && state.validationStatus.source === 'orchestrator'
        && state.validationStatus.scope === 'targeted'
        && state.validationStatus.status === recordedStatus
        && state.validationStatus.headSha === plan.headSha
        && JSON.stringify(state.validationStatus.checks) === JSON.stringify(plan.commands.map((entry) => entry.command));
      if (proofMatches) return `${plan.headSha}; completed; ${countSummary}; recorded proof ${recordedStatus}`;
      return `${plan.headSha}; historical; ${countSummary}; current proof not recorded`;
    } catch {
      return 'invalid';
    }
  }
}

export function staleDiscoveryRecoverySummary(state) {
  const dispositions = staleDiscoveryDispositionList(state);
  if (dispositions.length === 0) return 'none';
  const latest = dispositions.at(-1);
  return `${dispositions.length}; latest ${latest.dispositionId} binds request ${latest.requestId} `
    + `${latest.requestHeadSha} -> ${latest.liveHeadSha} (${latest.evidence.outcome})`;
}

export function renderRecoverySummary({ cwd = process.cwd(), prNumber, maxCharacters = 9000 } = {}) {
  const {
    state, warnings, evidenceErrors, packetSidecars, bindingProvenance, workerResults, specialist,
  } = reconcileState({ cwd, prNumber });
  if (!state) return '';
  const release = state.releaseBaseline ? `${state.releaseBaseline.tag} (${state.releaseBaseline.commit})` : 'pre-release';
  const taskLines = state.tasks.slice(0, 30).map((task) => `- ${task.id} [${task.status}]: ${truncate(task.summary, 180)}`);
  const decisions = state.decisions.slice(0, 15).map((decision) => {
    const id = typeof decision === 'object' ? decision.id ?? 'decision' : 'decision';
    const summary = typeof decision === 'object' ? decision.summary ?? JSON.stringify(decision) : String(decision);
    return `- ${id}: ${truncate(summary, 180)}`;
  });
  const lines = [
    `PR review recovery: ${state.repository}#${state.prNumber}`,
    `Phase: ${state.phase}; round: ${state.reviewRound}`,
    `Review requests: ${reviewRequestUsage(state).used}; limit: ${reviewRequestUsage(state).limit ?? 'unlimited'}`,
    `Release baseline: ${release}`,
    `Base: ${state.baseSha}`,
    `Requested/reviewed: ${state.requestedHeadSha ?? 'none'} / ${state.reviewedHeadSha ?? 'none'}`,
    `Stale discovery dispositions: ${staleDiscoveryRecoverySummary(state)}`,
    `Verification escalation: ${state.verificationEscalation
      ? `${state.verificationEscalation.reason} at PR ${state.verificationEscalation.observedPrHeadSha}`
      : 'none'}`,
    `Integration HEAD: ${state.currentIntegrationHeadSha}`,
    `Task packet sidecars: ${packetSidecars.length === 0 ? 'none' : packetSidecars.map((entry) => `${entry.taskId}=${entry.status}`).join(', ')}`,
    `Task binding provenance: ${bindingProvenance.length === 0 ? 'none' : bindingProvenance.map((entry) => `${entry.taskId ?? 'unknown'}=${entry.status}`).join(', ')}`,
    `Worker results: ${workerResults.length === 0 ? 'none' : workerResults.map((entry) => `${entry.taskId ?? 'unknown'}=${entry.status}`).join(', ')}`,
    `Specialist evidence: ${specialist.status}${specialist.requiredReviewerIds.length > 0 ? `; required ${specialist.requiredReviewerIds.join(', ')}` : ''}`,
    `Targeted validation plan: ${validationPlanRecoverySummary(cwd, state)}`,
    'Tasks:',
    ...(taskLines.length > 0 ? taskLines : ['- none']),
    'Decisions:',
    ...(decisions.length > 0 ? decisions : ['- none']),
    `Blocked: ${state.blockedReasons.length > 0 ? state.blockedReasons.map((item) => truncate(item, 200)).join('; ') : 'none'}`,
    `Next action: ${truncate(state.nextAction, 500)}`,
    `Reconciliation warnings: ${warnings.length > 0 ? warnings.join('; ') : 'none'}`,
    `Recovery evidence errors: ${evidenceErrors.length > 0 ? evidenceErrors.map((item) => truncate(item, 240)).join('; ') : 'none'}`,
  ];
  return truncate(lines.join('\n'), maxCharacters);
}
