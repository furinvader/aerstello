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

function positiveCitationFree(mapping) {
  return mapping.sourceCriterionIds.length === 0
    && mapping.acceptedCriterionIds.length === 0
    && mapping.invariantIds.length === 0
    && (mapping.decisionIds ?? []).length === 0;
}

function setsIntersect(left, right) {
  return left.some((value) => right.has(value));
}

function sameOrDescendantPath(path, inheritedPath) {
  return path === inheritedPath || path.startsWith(`${inheritedPath}/`);
}

function planAuthorityProjection(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return plan;
  return Object.fromEntries(Object.entries(plan).filter(([key]) =>
    !['planRevision', 'criteria', 'tasks', 'checklistMappings'].includes(key)));
}

export function validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan, resultingPlan,
  addedTaskIds }) {
  const errors = [];
  const verdict = evidence?.result?.verdict;
  if (!['minor-amendment-required', 'trim-required'].includes(verdict)) {
    return ['current evidence does not define an exact nonmaterial remediation responsibility'];
  }
  const inventoryMappings = evidence?.packet?.changeInventory?.mappings ?? [];
  const assessedPaths = new Set(evidence?.packet?.changeInventory?.paths ?? []);
  const discoveryTaskId = /^worker-scope-discovery:([a-z0-9]+(?:-[a-z0-9]+)*):/u
    .exec(evidence?.cadence?.trigger ?? '')?.[1];
  const branchFor = (kind, responsibility, coverage) => {
    const deltaAccepted = new Set(evidence.result.scopeDelta?.acceptedCriterionIds ?? []);
    const authorities = coverage.map((row) => {
      const mappings = inventoryMappings.filter(({ mechanism }) => mechanism === row.mechanism);
      const responsibleCriterionIds = new Set(row.acceptedCriterionIds
        .filter((id) => kind !== 'necessary' || deltaAccepted.has(id)));
      const groundedTaskIds = new Set((priorPlan?.criteria ?? [])
        .filter(({ id, ownerTaskId }) => responsibleCriterionIds.has(id)
          && typeof ownerTaskId === 'string')
        .map(({ ownerTaskId }) => ownerTaskId));
      const responsibleTaskIds = new Set(groundedTaskIds);
      if (discoveryTaskId) responsibleTaskIds.add(discoveryTaskId);
      const citationFree = kind === 'removal' && positiveCitationFree(row);
      const citationFreePaths = new Set(citationFree && assessedPaths.has(row.mechanism)
        ? [row.mechanism] : []);
      const mappedPaths = new Set(mappings.map(({ mechanism }) => mechanism)
        .filter((mechanism) => assessedPaths.has(mechanism) && !citationFree));
      const deltaSources = kind === 'necessary'
        ? new Set(evidence.result.scopeDelta?.sourceCriterionIds ?? []) : null;
      const deltaInvariants = kind === 'necessary'
        ? new Set(evidence.result.scopeDelta?.invariantIds ?? []) : null;
      const anchorRows = [row]
        .filter(({ mechanism }) => !assessedPaths.has(mechanism));
      const sourceAnchors = new Set(anchorRows.flatMap(({ sourceCriterionIds }) => sourceCriterionIds)
        .filter((id) => deltaSources === null || deltaSources.has(id)));
      const invariantAnchors = new Set(anchorRows.flatMap(({ invariantIds }) => invariantIds)
        .filter((id) => deltaInvariants === null || deltaInvariants.has(id)));
      const decisionAnchors = new Set(kind === 'necessary' ? []
        : anchorRows.flatMap(({ decisionIds = [] }) => decisionIds));
      for (const mapping of inventoryMappings) {
        if (assessedPaths.has(mapping.mechanism)
            && (setsIntersect(mapping.sourceCriterionIds, sourceAnchors)
              || setsIntersect(mapping.invariantIds, invariantAnchors)
              || setsIntersect(mapping.decisionIds ?? [], decisionAnchors))) {
          mappedPaths.add(mapping.mechanism);
        }
      }
      return { row, responsibleCriterionIds, responsibleTaskIds, groundedTaskIds, mappedPaths,
        citationFree, citationFreePaths };
    });
    const responsibleCriterionIds = new Set(authorities
      .flatMap(({ responsibleCriterionIds: ids }) => [...ids]));
    const responsibleTaskIds = new Set(authorities
      .flatMap(({ responsibleTaskIds: ids }) => [...ids]));
    return { kind, responsibility, coverage, responsibleCriterionIds, responsibleTaskIds,
      authorities };
  };
  const branches = [];
  if (verdict === 'minor-amendment-required') {
    const necessaryCoverage = evidence.result.coverage
      .filter(({ classification }) => classification === 'necessary-minor-expansion');
    if (necessaryCoverage.length > 0) {
      branches.push(branchFor('necessary', evidence.result.scopeDelta?.description, necessaryCoverage));
    }
  }
  const removedMechanisms = new Set(evidence.result.unnecessaryWork ?? []);
  const removalCoverage = evidence.result.coverage
    .filter(({ mechanism }) => removedMechanisms.has(mechanism));
  if ((verdict === 'trim-required' || removedMechanisms.size > 0) && removalCoverage.length > 0) {
    branches.push(branchFor('removal', evidence.result.smallerSufficientAlternative, removalCoverage));
  }
  if (branches.length === 0 || branches.some(({ responsibility }) => typeof responsibility !== 'string')) {
    return ['current evidence does not define an exact nonmaterial remediation responsibility'];
  }
  const priorTaskIds = new Set((priorPlan?.tasks ?? []).map(({ id }) => id));
  const priorCriterionIds = new Set((priorPlan?.criteria ?? []).map(({ id }) => id));
  const addedTasks = (resultingPlan?.tasks ?? []).filter(({ id }) => !priorTaskIds.has(id));
  const addedCriteria = (resultingPlan?.criteria ?? []).filter(({ id }) => !priorCriterionIds.has(id));
  const resultingTaskIdentityCount = new Set((resultingPlan?.tasks ?? []).map(({ id }) => id)).size;
  const resultingCriterionIdentityCount = new Set((resultingPlan?.criteria ?? []).map(({ id }) => id)).size;
  if (resultingTaskIdentityCount !== (resultingPlan?.tasks ?? []).length) {
    errors.push('$ nonmaterial amendment task identities must remain unique and one-to-one');
  }
  if (resultingCriterionIdentityCount !== (resultingPlan?.criteria ?? []).length) {
    errors.push('$ nonmaterial amendment criterion identities must remain unique and one-to-one');
  }
  const addedCriteriaByOwner = new Map();
  for (const criterion of addedCriteria) {
    const owned = addedCriteriaByOwner.get(criterion.ownerTaskId) ?? [];
    owned.push(criterion);
    addedCriteriaByOwner.set(criterion.ownerTaskId, owned);
  }
  const declaredTaskIds = new Set(addedTaskIds ?? []);
  if (declaredTaskIds.size !== (addedTaskIds ?? []).length
      || declaredTaskIds.size !== addedTasks.length
      || addedTasks.some(({ id }) => !declaredTaskIds.has(id))) {
    errors.push('$ nonmaterial amendment addedTaskIds must equal the complete new task set');
  }
  if (!isDeepStrictEqual(planAuthorityProjection(resultingPlan), planAuthorityProjection(priorPlan))) {
    errors.push('$ nonmaterial amendment must preserve every plan-level authority field exactly');
  }
  const addedTasksById = new Map(addedTasks.map((task) => [task.id, task]));
  const resultingTaskIds = new Set((resultingPlan?.tasks ?? []).map(({ id }) => id));
  const resultingCriteriaById = new Map((resultingPlan?.criteria ?? []).map((row) => [row.id, row]));
  const removedTasks = (priorPlan?.tasks ?? []).filter(({ id }) => !resultingTaskIds.has(id));
  const replacementByPriorOwner = new Map();
  const priorOwnersByReplacement = new Map();
  for (const priorTask of removedTasks) {
    const owned = (priorPlan?.criteria ?? []).filter(({ ownerTaskId }) => ownerTaskId === priorTask.id);
    const replacements = new Set(owned.map(({ id }) => resultingCriteriaById.get(id)?.ownerTaskId)
      .filter((id) => addedTasksById.has(id)));
    if (owned.length > 0 && replacements.size === 1
        && owned.every(({ id }) => resultingCriteriaById.get(id)?.ownerTaskId === [...replacements][0])) {
      const replacementId = [...replacements][0];
      replacementByPriorOwner.set(priorTask.id, replacementId);
      const owners = priorOwnersByReplacement.get(replacementId) ?? [];
      owners.push(priorTask.id); priorOwnersByReplacement.set(replacementId, owners);
    }
  }
  if (discoveryTaskId) {
    const discoveryTask = removedTasks.find(({ id }) => id === discoveryTaskId);
    const owned = (priorPlan?.criteria ?? [])
      .filter(({ ownerTaskId }) => ownerTaskId === discoveryTaskId);
    if (!discoveryTask && owned.length === 0
        && (priorPlan?.tasks ?? []).some(({ id }) => id === discoveryTaskId)) {
      errors.push(`$ nonmaterial criterionless discovery task ${discoveryTaskId} must be removed and replaced exactly`);
    }
    if (discoveryTask && owned.length === 0 && !replacementByPriorOwner.has(discoveryTaskId)) {
      const candidateIds = addedTasks.filter((task) => !priorOwnersByReplacement.has(task.id)
          && branches.some((branch) => task.objective === branch.responsibility)
          && (addedCriteriaByOwner.get(task.id) ?? []).length > 0
          && (addedCriteriaByOwner.get(task.id) ?? []).every(({ id, description }) =>
            task.criterionIds.includes(id)
              && branches.some((branch) => task.objective === branch.responsibility
                && description === branch.responsibility)))
        .filter((task) => {
          const priorPaths = discoveryTask.anticipatedPaths ?? [];
          const matchingAuthorities = branches
            .filter((branch) => task.objective === branch.responsibility)
            .flatMap(({ authorities }) => authorities);
          const eligible = (path) => priorPaths
            .some((priorPath) => sameOrDescendantPath(path, priorPath))
            && matchingAuthorities.some((authority) => authority.mappedPaths.has(path)
              || authority.citationFreePaths.has(path));
          return task.anticipatedPaths.length > 0 && task.anticipatedPaths.every(eligible);
        })
        .filter((task) => {
          const hypothetical = new Map(replacementByPriorOwner);
          hypothetical.set(discoveryTaskId, task.id);
          const substitute = (id) => hypothetical.get(id) ?? id;
          const expectedOutgoing = {
            dependsOn: (discoveryTask.dependsOn ?? []).map(substitute),
            produces: discoveryTask.produces ?? [],
            consumes: (discoveryTask.consumes ?? []).map((consumption) => ({ ...consumption,
              producerTaskId: substitute(consumption.producerTaskId) })),
          };
          if (!isDeepStrictEqual({ dependsOn: task.dependsOn ?? [], produces: task.produces ?? [],
            consumes: task.consumes ?? [] }, expectedOutgoing)) return false;
          for (const prior of priorPlan?.tasks ?? []) {
            if (prior.id === discoveryTaskId
                || (!(prior.dependsOn ?? []).includes(discoveryTaskId)
                  && !(prior.consumes ?? [])
                    .some(({ producerTaskId }) => producerTaskId === discoveryTaskId))) continue;
            const resultingId = substitute(prior.id);
            const resulting = (resultingPlan?.tasks ?? []).find(({ id }) => id === resultingId);
            if (!resulting
                || !isDeepStrictEqual(resulting.dependsOn ?? [],
                  (prior.dependsOn ?? []).map(substitute))
                || !isDeepStrictEqual(resulting.consumes ?? [],
                  (prior.consumes ?? []).map((consumption) => ({ ...consumption,
                    producerTaskId: substitute(consumption.producerTaskId) })))) return false;
          }
          const expectedMappings = (priorPlan?.checklistMappings ?? []).map((mapping) => ({
            ...mapping, taskIds: mapping.taskIds.map(substitute),
          }));
          return isDeepStrictEqual(resultingPlan?.checklistMappings ?? [], expectedMappings);
        }).map(({ id }) => id);
      if (candidateIds.length === 1) {
        replacementByPriorOwner.set(discoveryTaskId, candidateIds[0]);
        priorOwnersByReplacement.set(candidateIds[0], [discoveryTaskId]);
      } else if (candidateIds.length > 1) {
        errors.push(`$ nonmaterial criterionless discovery task ${discoveryTaskId} replacement is ambiguous`);
      }
    }
  }
  const assessedPriorOwners = new Set(branches.flatMap(({ responsibleTaskIds }) =>
    [...responsibleTaskIds]));
  const substitution = (id) => replacementByPriorOwner.get(id) ?? id;
  const substitutedTaskReferences = (task) => ({ ...task,
    dependsOn: (task.dependsOn ?? []).map(substitution),
    consumes: (task.consumes ?? []).map((consumption) => ({ ...consumption,
      producerTaskId: substitution(consumption.producerTaskId) })),
  });
  for (const priorTask of priorPlan?.tasks ?? []) {
    const resulting = (resultingPlan?.tasks ?? []).find(({ id }) => id === priorTask.id);
    if (resulting) {
      const expected = substitutedTaskReferences(priorTask);
      if (!isDeepStrictEqual(resulting, expected)) {
        errors.push(`$ nonmaterial amendment retained task ${priorTask.id} must remain exact`);
      }
    } else if (!replacementByPriorOwner.has(priorTask.id)) {
      errors.push(`$ nonmaterial amendment removed task ${priorTask.id} lacks one exact replacement`);
    }
  }
  for (const priorCriterion of priorPlan?.criteria ?? []) {
    const resulting = resultingCriteriaById.get(priorCriterion.id);
    if (!resulting) {
      errors.push(`$ nonmaterial amendment must preserve criterion ${priorCriterion.id}`);
      continue;
    }
    const expected = { ...priorCriterion, ownerTaskId: substitution(priorCriterion.ownerTaskId) };
    if (!isDeepStrictEqual(resulting, expected)) {
      errors.push(`$ nonmaterial amendment criterion ${priorCriterion.id} may change only by exact owner substitution`);
    }
  }
  const expectedChecklistMappings = (priorPlan?.checklistMappings ?? []).map((mapping) => ({
    ...mapping, taskIds: mapping.taskIds.map(substitution),
  }));
  if (!isDeepStrictEqual(resultingPlan?.checklistMappings ?? [], expectedChecklistMappings)) {
    errors.push('$ nonmaterial amendment checklist mappings must preserve exact replacement substitutions');
  }
  if (!isDeepStrictEqual(resultingPlan?.decisions ?? [], priorPlan?.decisions ?? [])) {
    errors.push('$ nonmaterial amendment decisions must preserve the exact ordered prior array');
  }
  for (const criterion of addedCriteria) {
    const owner = addedTasksById.get(criterion.ownerTaskId);
    if (criterion.disposition !== 'owned' || !declaredTaskIds.has(criterion.ownerTaskId)
        || !owner?.criterionIds.includes(criterion.id)) {
      errors.push(`$ nonmaterial amendment criterion ${criterion.id} must be owned and referenced by one declared new remediation task`);
    }
  }
  for (const task of addedTasks) {
    const ownedCriterionIds = (resultingPlan?.criteria ?? [])
      .filter(({ ownerTaskId }) => ownerTaskId === task.id).map(({ id }) => id);
    if (task.criterionIds.length !== ownedCriterionIds.length
        || task.criterionIds.some((id) => !ownedCriterionIds.includes(id))
        || ownedCriterionIds.some((id) => !task.criterionIds.includes(id))) {
      errors.push(`$ nonmaterial remediation task ${task.id} criterionIds must equal its exact resulting owned criteria`);
    }
  }
  const continuityTaskIds = new Set();
  for (const [replacementId, owners] of priorOwnersByReplacement) {
    if (owners.length !== 1) {
      errors.push(`$ nonmaterial amendment task ${replacementId} cannot absorb multiple prior owners`);
      continue;
    }
    const priorOwnerId = owners[0];
    const priorTask = (priorPlan?.tasks ?? []).find(({ id }) => id === priorOwnerId);
    const replacement = addedTasksById.get(replacementId);
    const expectedReferences = substitutedTaskReferences(priorTask);
    if (assessedPriorOwners.has(priorOwnerId)) {
      if (!isDeepStrictEqual(replacement?.dependsOn ?? [], expectedReferences.dependsOn ?? [])) {
        errors.push(`$ nonmaterial assessed replacement task ${replacementId} must preserve prior dependency edges`);
      }
      if (!isDeepStrictEqual(replacement?.produces ?? [], expectedReferences.produces ?? [])) {
        errors.push(`$ nonmaterial assessed replacement task ${replacementId} must preserve prior produce edges`);
      }
      if (!isDeepStrictEqual(replacement?.consumes ?? [], expectedReferences.consumes ?? [])) {
        errors.push(`$ nonmaterial assessed replacement task ${replacementId} must preserve prior consume edges`);
      }
      continue;
    }
    continuityTaskIds.add(replacementId);
    if (!isDeepStrictEqual(replacement?.dependsOn, expectedReferences.dependsOn)
        || !isDeepStrictEqual(replacement?.consumes, expectedReferences.consumes)) {
      errors.push(`$ nonmaterial replacement task ${replacementId} must preserve dependency edges`);
    }
    const expectedTask = { ...substitutedTaskReferences(priorTask), id: replacementId,
      criterionIds: replacement?.criterionIds };
    if (!isDeepStrictEqual(replacement, expectedTask)) {
      errors.push(`$ nonmaterial continuity task ${replacementId} must preserve its prior task semantics`);
    }
    const transferred = (priorPlan?.criteria ?? []).filter(({ ownerTaskId }) => ownerTaskId === priorOwnerId);
    const newOwned = addedCriteriaByOwner.get(replacementId) ?? [];
    const freshId = newOwned[0]?.id;
    const retainedCriterionIds = (replacement?.criterionIds ?? []).filter((id) => id !== freshId);
    if (replacement?.criterionIds.filter((id) => id === freshId).length !== 1
        || !isDeepStrictEqual(retainedCriterionIds, priorTask.criterionIds)) {
      errors.push(`$ nonmaterial continuity task ${replacementId} must retain all prior criteria plus its sole duplicate`);
    }
    if (newOwned.length !== 1 || !transferred.some((criterion) => {
      const expected = { ...criterion, id: newOwned[0].id, ownerTaskId: replacementId };
      return isDeepStrictEqual(newOwned[0], expected);
    })) {
      errors.push(`$ nonmaterial continuity task ${replacementId} must add one exact duplicate owned criterion`);
    }
  }
  const mechanismWitnesses = new Map();
  for (const task of addedTasks) {
    if (continuityTaskIds.has(task.id)) continue;
    const ownedCriteria = addedCriteriaByOwner.get(task.id) ?? [];
    const matching = branches.map((branch, branchIndex) => {
      if (task.objective !== branch.responsibility || ownedCriteria.length === 0
          || ownedCriteria.some(({ id, description }) =>
            !task.criterionIds.includes(id) || description !== branch.responsibility)) return [];
      const replacedAssessedOwners = [...replacementByPriorOwner]
        .filter(([ownerId, replacementId]) => replacementId === task.id
          && assessedPriorOwners.has(ownerId)).map(([ownerId]) => ownerId);
      const dependencyPaths = new Set((priorPlan?.tasks ?? [])
        .filter(({ id }) => task.dependsOn.includes(substitution(id))
          && !continuityTaskIds.has(substitution(id)))
        .flatMap(({ anticipatedPaths }) => anticipatedPaths));
      return branch.authorities.map((authority, authorityIndex) => {
        const carries = task.criterionIds.some((id) => authority.responsibleCriterionIds.has(id))
          || [...authority.responsibleTaskIds]
            .some((id) => task.dependsOn.includes(substitution(id)))
          || replacedAssessedOwners.some((ownerId) => authority.responsibleTaskIds.has(ownerId));
        if (authority.groundedTaskIds.size > 0 && !carries) return null;
        if (replacedAssessedOwners.some((ownerId) =>
          !authority.responsibleTaskIds.has(ownerId))) return null;
        const transferredOwnerIds = new Set([...replacementByPriorOwner]
          .filter(([ownerId, replacementId]) => replacementId === task.id
            && authority.groundedTaskIds.has(ownerId)).map(([ownerId]) => ownerId));
        const inheritedPaths = new Set((priorPlan?.tasks ?? [])
          .filter(({ id }) => authority.groundedTaskIds.has(id) || transferredOwnerIds.has(id))
          .flatMap(({ anticipatedPaths }) => anticipatedPaths));
        const replacesAssessedDiscovery = discoveryTaskId !== undefined
          && replacementByPriorOwner.get(discoveryTaskId) === task.id
          && authority.responsibleTaskIds.has(discoveryTaskId);
        const eligible = (path) => authority.mappedPaths.has(path)
          || (!authority.citationFree && [...inheritedPaths]
            .some((ownerPath) => sameOrDescendantPath(path, ownerPath)))
          || (authority.citationFree && replacesAssessedDiscovery
            && authority.citationFreePaths.has(path))
          || (authority.citationFree && authority.citationFreePaths.has(path)
            && [...dependencyPaths].some((ownerPath) => sameOrDescendantPath(path, ownerPath)));
        return task.anticipatedPaths.some(eligible)
          ? { key: `${branchIndex}:${authorityIndex}`, eligible, authority } : null;
      }).filter(Boolean);
    }).flat();
    if (matching.length === 0 || task.anticipatedPaths.length === 0
        || task.anticipatedPaths.some((path) => !matching.some(({ eligible }) => eligible(path)))) {
      if (branches.some((branch) => task.objective === branch.responsibility
          && branch.responsibleCriterionIds.size > 0
          && !task.criterionIds.some((id) => branch.responsibleCriterionIds.has(id))
          && ![...branch.responsibleTaskIds].some((id) => task.dependsOn.includes(substitution(id))))) {
        errors.push(`$ nonmaterial remediation task ${task.id} is not linked to the assessed accepted criteria`);
      }
      errors.push(`$ nonmaterial remediation task ${task.id} must match one exact assessed branch`);
      errors.push(`$ nonmaterial remediation task ${task.id} anticipatedPaths exceed the exact assessed or inherited responsibility`);
    } else {
      if (!priorOwnersByReplacement.has(task.id)) {
        const matchedAuthorities = matching.filter(({ eligible }) =>
          task.anticipatedPaths.some(eligible));
        const requiredOwnerIds = new Set();
        for (const { authority, eligible } of matchedAuthorities) {
          for (const ownerId of authority.groundedTaskIds) requiredOwnerIds.add(substitution(ownerId));
          if (discoveryTaskId && authority.responsibleTaskIds.has(discoveryTaskId)) {
            const discoveryTask = (priorPlan?.tasks ?? []).find(({ id }) => id === discoveryTaskId);
            const matchedPaths = task.anticipatedPaths.filter(eligible);
            if ((discoveryTask?.anticipatedPaths ?? []).some((ownerPath) =>
              matchedPaths.some((path) => sameOrDescendantPath(path, ownerPath)))) {
              requiredOwnerIds.add(substitution(discoveryTaskId));
            }
          }
          if (!authority.citationFree || authority.groundedTaskIds.size > 0) continue;
          const matchedPaths = task.anticipatedPaths.filter(eligible);
          for (const priorTask of priorPlan?.tasks ?? []) {
            if ((priorTask.anticipatedPaths ?? []).some((ownerPath) =>
              matchedPaths.some((path) => sameOrDescendantPath(path, ownerPath)))) {
              requiredOwnerIds.add(substitution(priorTask.id));
            }
          }
        }
        const expectedDependencies = (priorPlan?.tasks ?? []).map(({ id }) => substitution(id))
          .filter((id, index, values) => requiredOwnerIds.has(id) && values.indexOf(id) === index);
        if (!isDeepStrictEqual(task.dependsOn ?? [], expectedDependencies)) {
          errors.push(`$ nonmaterial fresh remediation task ${task.id} dependencies must equal its exact row-local owner carry`);
        }
        if ((task.produces ?? []).length > 0 || (task.consumes ?? []).length > 0) {
          errors.push(`$ nonmaterial fresh remediation task ${task.id} cannot introduce artifact authority`);
        }
        const allowedDecisionIds = new Set(matchedAuthorities.flatMap(({ authority }) =>
          authority.row.decisionIds ?? []));
        if ((task.decisionIds ?? []).some((id) => !allowedDecisionIds.has(id))) {
          errors.push(`$ nonmaterial fresh remediation task ${task.id} decisionIds exceed its exact assessed rows`);
        }
        if ((task.checklistItemIds ?? []).length > 0) {
          errors.push(`$ nonmaterial fresh remediation task ${task.id} cannot introduce checklist authority`);
        }
        if (task.specialization !== undefined) {
          const ownerSpecializations = [...requiredOwnerIds]
            .map((id) => (resultingPlan?.tasks ?? []).find((candidate) => candidate.id === id)
              ?.specialization)
            .filter((value) => value !== undefined);
          const specializationAuthorities = ownerSpecializations.length > 0
            ? ownerSpecializations : priorPlan?.specialization === undefined
              ? [] : [priorPlan.specialization];
          const distinctAuthorities = specializationAuthorities.filter((value, index, values) =>
            values.findIndex((candidate) => isDeepStrictEqual(candidate, value)) === index);
          if (distinctAuthorities.length !== 1
              || !isDeepStrictEqual(task.specialization, distinctAuthorities[0])) {
            errors.push(`$ nonmaterial fresh remediation task ${task.id} specialization must equal its exact row-local authority`);
          }
        }
      }
      for (const { key, eligible } of matching) {
        const witnesses = mechanismWitnesses.get(key) ?? [];
        for (const path of task.anticipatedPaths) {
          if (eligible(path)) witnesses.push(path);
        }
        mechanismWitnesses.set(key, witnesses);
      }
    }
  }
  const mechanismByWitness = new Map();
  const representedMechanisms = new Set();
  const assignWitness = (key, seen) => {
    for (const witness of mechanismWitnesses.get(key) ?? []) {
      if (seen.has(witness)) continue;
      seen.add(witness);
      const priorKey = mechanismByWitness.get(witness);
      if (priorKey === undefined || assignWitness(priorKey, seen)) {
        mechanismByWitness.set(witness, key);
        representedMechanisms.add(key);
        return true;
      }
    }
    return false;
  };
  for (const key of mechanismWitnesses.keys()) assignWitness(key, new Set());
  for (const [branchIndex, branch] of branches.entries()) {
    if (branch.authorities.some((unused, authorityIndex) =>
      !representedMechanisms.has(`${branchIndex}:${authorityIndex}`))) {
      errors.push(`$ nonmaterial amendment must represent the complete ${branch.kind} remediation branch`);
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
