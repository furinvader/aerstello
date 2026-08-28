import { isDeepStrictEqual } from 'node:util';

import {
  scopeContractDigest,
  scopeEvidenceIsCurrent,
  validateMinimalClosureContract,
  validateScopeDecision,
  validateScopeEvidence,
} from '../scope/contracts.mjs';
import {
  scopeReturnResumeIdentity,
  validateScopeReturnEnvelope,
} from '../../../pr-review-cycle/scripts/contracts/scope-control.mjs';

const ADMITTING_VERDICT = 'within-scope';

export const SCOPE_STATUSES = Object.freeze([
  'current',
  'assessment-required',
  'awaiting-decision',
]);

export function amendmentDigests(records) {
  return records.map((record) => scopeContractDigest(record));
}

export function expectedScopeIdentity({ state, closureDigest, amendmentRecords = [], taskPacketDigest = null,
  subjectDigest, subjectSha }) {
  return {
    sourceDigest: state.plan?.sourceCaptureDigest ?? state.source.latestDigest,
    planDigest: state.plan.effectiveDigest,
    amendmentDigests: amendmentDigests(amendmentRecords),
    taskPacketDigest,
    subjectDigest,
    subjectSha,
    closureDigest,
  };
}

export function validateClosureForState(closure, state, planDigest = state.plan?.effectiveDigest) {
  const errors = validateMinimalClosureContract(closure);
  const expected = {
    changeId: state.changeId,
    sourceType: state.source.kind,
    sourceIdentity: state.source.reference,
    sourceDigest: state.plan?.sourceCaptureDigest ?? state.source.latestDigest,
    planningSha: state.planningSha,
    planDigest,
  };
  for (const [label, actual, value] of [
    ['changeId', closure?.changeId, expected.changeId],
    ['source.type', closure?.source?.type, expected.sourceType],
    ['source.identity', closure?.source?.identity, expected.sourceIdentity],
    ['source.digest', closure?.source?.digest, expected.sourceDigest],
    ['planningSha', closure?.planningSha, expected.planningSha],
    ['planDigest', closure?.planDigest, expected.planDigest],
  ]) if (actual !== value) errors.push(`$ ${label} does not match the exact durable authority`);
  return [...new Set(errors)].sort();
}

export function validateEvidenceForBoundary(evidence, { state, closureDigest, amendmentRecords = [],
  boundary, subjectDigest, subjectSha, taskPacketDigest = null, verdict = null }) {
  const errors = validateScopeEvidence(evidence);
  if (evidence?.changeId !== state.changeId) errors.push('$ changeId does not match the active change');
  if (evidence?.cadence?.boundary !== boundary) errors.push(`$ cadence boundary must equal ${boundary}`);
  const expected = expectedScopeIdentity({
    state, closureDigest, amendmentRecords, taskPacketDigest, subjectDigest, subjectSha,
  });
  if (!scopeEvidenceIsCurrent(evidence, expected)) {
    errors.push('$ scope evidence is stale for the exact source, plan, amendments, closure, task set, or subject');
  }
  if (verdict !== null && evidence?.result?.verdict !== verdict) {
    errors.push(`$ assessment verdict must equal ${verdict}`);
  }
  return [...new Set(errors)].sort();
}

export function scopeGateForVerdict(verdict) {
  if (verdict === ADMITTING_VERDICT) return { status: 'current', phase: null, blocker: null };
  if (verdict === 'human-decision-required') {
    return {
      status: 'awaiting-decision',
      phase: 'awaiting-scope-decision',
      blocker: 'Scope assessment requires an exact human disposition before material authority can advance.',
    };
  }
  if (verdict === 'minor-amendment-required') return {
    status: 'assessment-required',
    phase: 'blocked',
    blocker: 'Scope assessment requires a bounded minor amendment before implementation can continue.',
  };
  if (verdict === 'trim-required') return {
    status: 'assessment-required',
    phase: 'blocked',
    blocker: 'Scope assessment requires bounded removal or simplification of unnecessary machinery.',
  };
  return {
    status: 'assessment-required',
    phase: 'blocked',
    blocker: 'Scope assessment has insufficient evidence; authority remains unchanged.',
  };
}

export function validateDecisionForEvidence(decision, { state, evidence, closureDigest,
  amendmentRecords = [] }) {
  const errors = validateScopeDecision(decision);
  const expected = {
    sourceDigest: state.plan?.sourceCaptureDigest ?? state.source.latestDigest,
    planningSha: state.planningSha,
    planDigest: state.plan.effectiveDigest,
    amendmentDigests: amendmentDigests(amendmentRecords),
    closureDigest,
    subjectDigest: evidence.packet.binding.subject.digest,
    subjectSha: evidence.packet.binding.subject.sha,
    assessmentPacketDigest: evidence.packetDigest,
    assessmentResultDigest: evidence.resultDigest,
  };
  if (decision?.changeId !== state.changeId) errors.push('$ decision changeId does not match the active change');
  if (decision?.revision !== state.revision + 1) errors.push('$ decision revision must equal the guarded next state revision');
  if (!isDeepStrictEqual(decision?.evidence, expected)) errors.push('$ decision evidence does not match the exact current scope assessment');
  return [...new Set(errors)].sort();
}

export function validateMinorAmendmentAuthority({ evidence, amendment }) {
  const errors = [];
  if (evidence?.result?.verdict !== 'minor-amendment-required') {
    errors.push('current evidence does not authorize a minor scope amendment');
    return errors;
  }
  if ((evidence.result.materialityTriggers ?? []).length > 0
      || (evidence.result.scopeDelta?.materialSurfaces ?? []).length > 0) {
    errors.push('minor scope amendment contains a material trigger');
  }
  if (amendment?.trigger !== scopeContractDigest(evidence)) {
    errors.push('minor scope amendment trigger must name the exact scope evidence digest');
  }
  if (!(amendment?.invalidatedEvidence ?? []).includes(scopeContractDigest(evidence))) {
    errors.push('minor scope amendment must invalidate the triggering scope evidence');
  }
  return errors;
}

export function validateScopeReturnResume(envelope, { currentHeadSha, expectedAuthorityDigest = null } = {}) {
  const errors = validateScopeReturnEnvelope(envelope);
  if (envelope?.reviewHeadSha !== currentHeadSha || envelope?.livePrHeadSha !== currentHeadSha) {
    errors.push('$ scope return must bind the exact clean current PR head');
  }
  if (expectedAuthorityDigest !== null && envelope?.authorityDigest !== expectedAuthorityDigest) {
    errors.push('$ scope return authority does not match the current development authority');
  }
  return [...new Set(errors)].sort();
}

export function developmentScopeResumeRecord(envelope, { changeId, currentHeadSha, resumedAt }) {
  const errors = validateScopeReturnResume(envelope, { currentHeadSha });
  if (errors.length > 0) throw new TypeError(`Invalid scope return: ${errors.join('; ')}`);
  return {
    schemaVersion: 1,
    changeId,
    returnIdentity: scopeReturnResumeIdentity(envelope),
    returnEnvelope: envelope,
    resumedHeadSha: currentHeadSha,
    resumedAt,
  };
}
