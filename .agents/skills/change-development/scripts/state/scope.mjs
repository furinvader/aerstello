import { isDeepStrictEqual } from 'node:util';

import {
  scopeContractDigest,
  scopeEvidenceIsCurrent,
  validateMinimalClosureContract,
  validateScopeDecision,
  validateScopeEvidence,
} from '../scope/contracts.mjs';
import { pathMatchesOwnership } from '../implementation/contracts.mjs';
import {
  scopeAuthorityDigest,
  scopeReturnResumeIdentity,
  validateScopeAuthoritySnapshot,
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
    decisionDigests: [...(state.scope?.decisionDigests ?? [])],
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
  if (!isDeepStrictEqual(closure?.operatorDecisionDigests, state.scope?.decisionDigests ?? [])) {
    errors.push('$ operatorDecisionDigests must equal the exact ordered durable scope decision digests');
  }
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

function criterionFromPlan({ id, description }) {
  return { id, text: description };
}

export function scopeAuthorityDecisionProjection(decisionReceipts) {
  return decisionReceipts.map(({ digest, value }) => ({
    id: value.decisionId,
    digest,
    disposition: value.disposition,
    authorizedShape: [...value.approvedShape],
  }));
}

export function validateAdmissionScopeSemantics(evidence, { effectivePlan, minimalClosure,
  authorityDecisions = [] }) {
  const errors = [];
  const expectedSourceScope = {
    objective: effectivePlan?.objective,
    requiredCriteria: minimalClosure?.requiredCriteria,
    nonGoals: minimalClosure?.nonGoals,
    implementationGuidance: minimalClosure?.optionalGuidance,
  };
  const expectedAcceptedScope = {
    criteria: (effectivePlan?.criteria ?? []).map(criterionFromPlan),
    invariants: [
      ...(minimalClosure?.invariants ?? []),
      ...(minimalClosure?.mandatoryConstraints ?? []),
    ],
    minimalClosure: minimalClosure?.outcome,
    authorizedShape: minimalClosure?.authorizedShape,
    unauthorizedShape: minimalClosure?.unauthorizedExpansion,
    deferredShape: (minimalClosure?.deferredFollowups ?? []).map(({ id }) => id),
    authorityDecisions,
  };
  if (!isDeepStrictEqual(evidence?.packet?.sourceScope, expectedSourceScope)) {
    errors.push('$ packet.sourceScope does not equal the canonical source and minimal-closure projection');
  }
  const actualAcceptedScope = evidence?.packet?.acceptedScope;
  const actualProjection = actualAcceptedScope === null || typeof actualAcceptedScope !== 'object'
    ? actualAcceptedScope
    : Object.fromEntries(Object.keys(expectedAcceptedScope).map((key) => [key,
      key === 'authorityDecisions' ? actualAcceptedScope[key] ?? [] : actualAcceptedScope[key]]));
  if (!isDeepStrictEqual(actualProjection, expectedAcceptedScope)) {
    errors.push('$ packet.acceptedScope does not equal the exact effective-plan and minimal-closure projection');
  }
  return errors;
}

function remediationResponsibility(evidence) {
  return evidence?.result?.verdict === 'minor-amendment-required'
    ? evidence.result.scopeDelta?.description
    : evidence?.result?.verdict === 'trim-required'
      ? evidence.result.smallerSufficientAlternative
      : null;
}

function applicableRemediationMappings(evidence) {
  const mechanisms = new Set(evidence?.result?.verdict === 'minor-amendment-required'
    ? evidence.result.coverage
      .filter(({ classification }) => classification === 'necessary-minor-expansion')
      .map(({ mechanism }) => mechanism)
    : evidence?.result?.verdict === 'trim-required'
      ? evidence.result.unnecessaryWork
      : []);
  return (evidence?.packet?.changeInventory?.mappings ?? [])
    .filter(({ mechanism }) => mechanisms.has(mechanism));
}

export function validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan, resultingPlan,
  addedTaskIds }) {
  const errors = [];
  const responsibility = remediationResponsibility(evidence);
  if (typeof responsibility !== 'string') {
    return ['current evidence does not define an exact nonmaterial remediation responsibility'];
  }
  const priorTaskIds = new Set((priorPlan?.tasks ?? []).map(({ id }) => id));
  const priorCriterionIds = new Set((priorPlan?.criteria ?? []).map(({ id }) => id));
  const addedTasks = (resultingPlan?.tasks ?? []).filter(({ id }) => !priorTaskIds.has(id));
  const addedCriteria = (resultingPlan?.criteria ?? []).filter(({ id }) => !priorCriterionIds.has(id));
  const addedCriteriaByOwner = new Map();
  for (const criterion of addedCriteria) {
    const owned = addedCriteriaByOwner.get(criterion.ownerTaskId) ?? [];
    owned.push(criterion);
    addedCriteriaByOwner.set(criterion.ownerTaskId, owned);
  }
  const declaredTaskIds = new Set(addedTaskIds ?? []);
  if (declaredTaskIds.size !== addedTasks.length
      || addedTasks.some(({ id }) => !declaredTaskIds.has(id))) {
    errors.push('$ nonmaterial amendment addedTaskIds must equal the complete new task set');
  }
  const mappings = applicableRemediationMappings(evidence);
  const responsibleCriterionIds = new Set(mappings.flatMap(({ acceptedCriterionIds }) => acceptedCriterionIds));
  const responsibleTaskIds = new Set((priorPlan?.criteria ?? [])
    .filter(({ id }) => responsibleCriterionIds.has(id))
    .map(({ ownerTaskId }) => ownerTaskId));
  const discoveryTaskId = /^worker-scope-discovery:([a-z0-9]+(?:-[a-z0-9]+)*):/u
    .exec(evidence?.cadence?.trigger ?? '')?.[1];
  if (discoveryTaskId) responsibleTaskIds.add(discoveryTaskId);
  const assessedPaths = new Set(evidence?.packet?.changeInventory?.paths ?? []);
  const applicableMappedPaths = new Set(mappings
    .map(({ mechanism }) => mechanism)
    .filter((mechanism) => assessedPaths.has(mechanism)));
  const discoveryPaths = new Set((priorPlan?.tasks ?? [])
    .find(({ id }) => id === discoveryTaskId)?.anticipatedPaths ?? []);
  for (const task of addedTasks) {
    const ownedCriteria = addedCriteriaByOwner.get(task.id) ?? [];
    if (ownedCriteria.length === 0 || ownedCriteria.some(({ id, description }) =>
      !task.criterionIds.includes(id) || description !== responsibility)) {
      errors.push(`$ nonmaterial remediation task ${task.id} must own a new criterion with the exact assessed responsibility`);
    }
    if (task.objective !== responsibility) {
      errors.push(`$ nonmaterial remediation task ${task.id} objective must equal the exact assessed responsibility`);
    }
    const carriesResponsibility = task.criterionIds.some((id) => responsibleCriterionIds.has(id))
      || task.dependsOn.some((id) => responsibleTaskIds.has(id))
      || (discoveryPaths.size > 0 && task.anticipatedPaths.length === discoveryPaths.size
        && task.anticipatedPaths.every((path) => discoveryPaths.has(path)));
    if (responsibleCriterionIds.size > 0 && !carriesResponsibility) {
      errors.push(`$ nonmaterial remediation task ${task.id} is not linked to the assessed accepted criteria`);
    }
    const inheritedPaths = new Set((priorPlan?.tasks ?? [])
      .filter(({ id }) => responsibleTaskIds.has(id) || task.criterionIds.some((criterionId) =>
        id === (priorPlan.criteria.find((criterion) => criterion.id === criterionId)?.ownerTaskId)))
      .flatMap(({ anticipatedPaths }) => anticipatedPaths));
    if (task.anticipatedPaths.length === 0 || task.anticipatedPaths.some((path) =>
      !applicableMappedPaths.has(path) && !inheritedPaths.has(path))) {
      errors.push(`$ nonmaterial remediation task ${task.id} anticipatedPaths exceed the exact assessed or inherited responsibility`);
    }
  }
  return [...new Set(errors)].sort();
}

export function resumedPathHasCompleteTaskAuthority(path, terminal, validationCommands) {
  const represented = new Set(validationCommands);
  return terminal.some(({ packet }) =>
    packet.allowedPaths.some((pattern) => pathMatchesOwnership(path, pattern))
    && !packet.forbiddenPaths.some((pattern) => pathMatchesOwnership(path, pattern))
    && [...packet.requiredValidation.unit, ...packet.requiredValidation.system]
      .every(({ command }) => represented.has(command)));
}

const PRESERVED_CLOSURE_FIELDS = Object.freeze([
  'outcome',
  'requiredCriteria',
  'invariants',
  'nonGoals',
  'mandatoryConstraints',
  'optionalGuidance',
]);

function withoutIdentities(values, removed, identity = (value) => value) {
  return values.filter((value) => !removed.has(identity(value)));
}

export function projectNonmaterialScopeRemediation({ evidence, priorClosure, minimalClosure }) {
  const errors = [];
  const verdict = evidence?.result?.verdict;
  if (!['minor-amendment-required', 'trim-required'].includes(verdict)) {
    return { errors: ['current evidence does not authorize a nonmaterial scope amendment'], remediation: null };
  }
  for (const field of PRESERVED_CLOSURE_FIELDS) {
    if (!isDeepStrictEqual(minimalClosure?.[field], priorClosure?.[field])) {
      errors.push(`$ ${verdict} amendment must preserve prior ${field} exactly`);
    }
  }
  const necessaryMechanisms = evidence.result.coverage
    .filter(({ classification }) => classification === 'necessary-minor-expansion')
    .map(({ mechanism }) => mechanism);
  const unnecessaryWork = [...evidence.result.unnecessaryWork];
  const necessary = new Set(necessaryMechanisms);
  const unnecessary = new Set(unnecessaryWork);
  const expected = verdict === 'minor-amendment-required'
    ? {
      authorizedShape: [...withoutIdentities(priorClosure.authorizedShape, unnecessary),
        ...necessaryMechanisms.filter((mechanism) => !priorClosure.authorizedShape.includes(mechanism))],
      unauthorizedExpansion: withoutIdentities(priorClosure.unauthorizedExpansion, necessary),
      deferredFollowups: withoutIdentities(priorClosure.deferredFollowups, necessary, ({ id }) => id),
    }
    : {
      authorizedShape: withoutIdentities(priorClosure.authorizedShape, unnecessary),
      unauthorizedExpansion: [...priorClosure.unauthorizedExpansion],
      deferredFollowups: [...priorClosure.deferredFollowups],
    };
  for (const [field, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(minimalClosure?.[field], value)) {
      errors.push(`$ ${verdict} amendment must apply the exact assessed ${field} transformation`);
    }
  }
  if (verdict === 'minor-amendment-required') {
    if (necessaryMechanisms.length === 0) {
      errors.push('$ minor amendment assessment must name at least one necessary-minor-expansion mechanism');
    }
    if (evidence.result.scopeDelta === null) {
      errors.push('$ minor amendment must bind the exact assessed scope delta');
    }
  } else {
    if (necessaryMechanisms.length > 0) errors.push('$ trim amendment cannot add authority');
    if (unnecessaryWork.length === 0 || evidence.result.scopeDelta !== null
        || typeof evidence.result.smallerSufficientAlternative !== 'string') {
      errors.push('$ trim amendment must bind exact unnecessary work and one smaller sufficient alternative');
    }
  }
  return {
    errors: [...new Set(errors)].sort(),
    remediation: {
      schemaVersion: 1,
      verdict,
      evidenceDigest: scopeContractDigest(evidence),
      necessaryMechanisms,
      unnecessaryWork,
      scopeDelta: evidence.result.scopeDelta,
      smallerSufficientAlternative: evidence.result.smallerSufficientAlternative,
      priorClosureDigest: scopeContractDigest(priorClosure),
      resultingClosureDigest: scopeContractDigest(minimalClosure),
    },
  };
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

export function validateDecisionForEvidence(decision, { state, evidence, closure,
  amendmentRecords = [] }) {
  const errors = validateScopeDecision(decision);
  const closureDigest = scopeContractDigest(closure);
  if (decision?.disposition === 'split-defer' && Array.isArray(decision.deferredFollowups)) {
    const projectedClosure = {
      ...closure,
      deferredFollowups: [
        ...(closure?.deferredFollowups ?? []),
        ...decision.deferredFollowups.map((identity) => ({ id: identity, text: identity })),
      ],
    };
    errors.push(...validateMinimalClosureContract(projectedClosure)
      .map((error) => `projected split-defer closure: ${error}`));
  }
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

export function validateActiveHandoffAuthority(receipt) {
  const errors = [];
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
      || !isDeepStrictEqual(Object.keys(receipt).sort(), ['digest', 'value'])) {
    return ['$ active handoff authority must contain exactly digest and value'];
  }
  const authorityErrors = validateScopeAuthoritySnapshot(receipt.value);
  errors.push(...authorityErrors.map((error) => `authority: ${error}`));
  if (receipt.value?.authorityKind !== 'imported') {
    errors.push('$ active handoff authority must be an imported development handoff');
  }
  if (receipt.digest !== scopeAuthorityDigest(receipt.value)) {
    errors.push('$ active handoff authority receipt digest does not match its canonical value');
  }
  return [...new Set(errors)].sort();
}

export function validateScopeReturnResume(envelope, { currentHeadSha, expectedAuthorityDigest } = {}) {
  const errors = validateScopeReturnEnvelope(envelope);
  if (envelope?.reviewHeadSha !== currentHeadSha || envelope?.livePrHeadSha !== currentHeadSha) {
    errors.push('$ scope return must bind the exact clean current PR head');
  }
  if (typeof expectedAuthorityDigest !== 'string') {
    errors.push('$ active handoff authority digest is required independently of the scope return envelope');
  } else if (envelope?.authorityDigest !== expectedAuthorityDigest) {
    errors.push('$ scope return authority does not match the current development authority');
  }
  return [...new Set(errors)].sort();
}

export function developmentScopeResumeRecord(envelope, {
  activeHandoffAuthorityDigest, changeId, currentHeadSha, resumedAt,
}) {
  const errors = validateScopeReturnResume(envelope, {
    currentHeadSha,
    expectedAuthorityDigest: activeHandoffAuthorityDigest,
  });
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
