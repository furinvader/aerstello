import { isObject } from './primitives.mjs';

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

export function exactHeadReason(label, actual, expected) {
  return actual === expected ? null : `${label} must equal currentIntegrationHeadSha`;
}

export function reviewRequestUsage(state) {
  const legacyRequests = Number.isInteger(state?.legacyReviewProvenance?.discoveryRounds)
    ? state.legacyReviewProvenance.discoveryRounds : 0;
  const nativeRequests = Array.isArray(state?.reviewHistory) ? state.reviewHistory.length : 0;
  const used = legacyRequests + nativeRequests;
  const limit = Number.isSafeInteger(state?.reviewRequestLimit) && state.reviewRequestLimit > 0
    ? state.reviewRequestLimit : null;
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    exhausted: limit !== null && used >= limit,
  };
}

export function nextReviewKind(state) {
  return reviewRequestUsage(state).used < 3 ? 'discovery' : 'verification';
}

export function reviewReadyStateGate(state) {
  const reasons = [];
  const head = state?.currentIntegrationHeadSha;
  if (state?.phase !== 'ready-for-review') reasons.push('phase must be exactly ready-for-review');
  if (state?.validationStatus?.status !== 'passed') reasons.push('validation must have passed');
  if (state?.validationStatus?.source !== 'orchestrator' || state?.validationStatus?.scope !== 'targeted') {
    reasons.push('validation must be targeted orchestrator evidence');
  }
  for (const [label, actual] of [
    ['validation HEAD', state?.validationStatus?.headSha],
    ['thread proof HEAD', state?.threadResolutionStatus?.headSha],
    ['recorded local Git HEAD', state?.git?.headSha],
  ]) {
    const reason = exactHeadReason(label, actual, head);
    if (reason) reasons.push(reason);
  }
  if (state?.threadResolutionStatus?.status !== 'passed') reasons.push('thread resolution proof must have passed');
  if (state?.threadResolutionStatus?.threads?.some((thread) => !thread.isResolved)) reasons.push('all canonical threads must be resolved');
  reasons.push(...localVerificationStateGate(state));
  if (state?.git?.dirty !== false) reasons.push('integration checkout must be clean');
  if (state?.verificationEscalation !== null) reasons.push('verification collection escalation requires human decision');
  if (!Array.isArray(state?.tasks) || state.tasks.some((task) => task.status !== 'completed')) reasons.push('all prior tasks must be completed');
  if (state?.tasks?.some((task) => task.disposition === 'needs-human-decision')) reasons.push('needs-human-decision findings require a human');
  const latest = state?.reviewHistory?.at(-1);
  const latestStaleDiscovery = (state?.staleDiscoveryDispositions ?? [])
    .find((disposition) => disposition.requestId === latest?.request?.id);
  if (latest?.outcome === null && latestStaleDiscovery?.evidence?.outcome === 'findings'
      && (state?.tasks?.length ?? 0) === 0) {
    reasons.push('dispositioned stale discovery findings require ordinary triage');
  }
  if ((state?.blockedReasons?.length ?? 0) !== 0) reasons.push('blocked reasons must be cleared');
  return reasons;
}

export function reviewRequestStateGate(state) {
  const reasons = reviewReadyStateGate(state);
  const usage = reviewRequestUsage(state);
  if (usage.exhausted) {
    reasons.push(`explicit review request limit ${usage.limit} is exhausted after ${usage.used} durable requests`);
  }
  return { kind: nextReviewKind(state), reasons };
}

export function validateExternalHeads(state, external, reasons, { promotionPreflight = false } = {}) {
  const head = state?.currentIntegrationHeadSha;
  for (const [label, field] of [
    ['fresh local HEAD', 'localHeadSha'],
    ['fresh pushed remote HEAD', 'pushedHeadSha'],
    ['fresh live PR HEAD', 'prHeadSha'],
  ]) {
    const reason = exactHeadReason(label, external?.[field], head);
    if (reason) reasons.push(reason);
  }
  if (external?.localDirty !== false) reasons.push('fresh integration checkout must be clean');
  if (external?.prState !== 'OPEN') reasons.push('live pull request must be OPEN');
  if (typeof external?.isDraft !== 'boolean') reasons.push('live pull request draft evidence is required');
  else if (promotionPreflight ? external.isDraft !== true : external.isDraft !== false) {
    reasons.push(promotionPreflight ? 'promotion preflight requires a live draft pull request' : 'live pull request must not be a draft');
  }
  if (typeof external?.isAncestor !== 'function') {
    reasons.push('a Git-aware integrated-commit ancestry check is required');
  } else {
    for (const task of state?.tasks ?? []) {
      if (task.disposition === 'actionable' && ['integrated', 'completed'].includes(task.status)
          && !external.isAncestor(task.integratedCommitSha, head)) {
        reasons.push(`task ${task.id} integrated commit must be an ancestor of currentIntegrationHeadSha`);
      }
    }
  }
}

export function reviewRequestGate(state, external, options = {}) {
  const { kind, reasons } = reviewRequestStateGate(state);
  validateExternalHeads(state, external, reasons, options);
  return { allowed: reasons.length === 0, kind: reasons.length === 0 ? kind : null, reasons };
}

export function completionStateGate(state) {
  const reasons = [];
  const head = state?.currentIntegrationHeadSha;
  if (!state?.reviewRequest) reasons.push('review request evidence is required');
  if (state?.reviewOutcome?.outcome !== 'clean') reasons.push('a clean canonical review outcome is required');
  for (const [label, actual] of [
    ['requested HEAD', state?.requestedHeadSha], ['reviewed HEAD', state?.reviewedHeadSha],
    ['review request HEAD', state?.reviewRequest?.headSha], ['review outcome HEAD', state?.reviewOutcome?.headSha],
    ['validation HEAD', state?.validationStatus?.headSha], ['thread proof HEAD', state?.threadResolutionStatus?.headSha],
    ['full CI HEAD', state?.ciValidationStatus?.headSha],
    ['recorded local Git HEAD', state?.git?.headSha],
  ]) {
    const reason = exactHeadReason(label, actual, head);
    if (reason) reasons.push(reason);
  }
  if (state?.reviewOutcome?.requestId !== state?.reviewRequest?.id) reasons.push('outcome must bind to the current request');
  if (state?.reviewOutcome?.kind !== state?.reviewRequest?.kind) reasons.push('outcome kind must match the current request');
  if (state?.reviewRound < 1) reasons.push('at least one discovery round is required');
  if (state?.reviewRequest?.kind === 'verification'
      && (state.reviewRound !== 3 || state.verificationReviewUsed !== true)) {
    reasons.push('verification clean completion requires three discovery rounds and consumed verification');
  }
  if (state?.validationStatus?.status !== 'passed') reasons.push('validation must have passed');
  if (state?.ciValidationStatus?.status !== 'passed') reasons.push('full GitHub Actions validation must have passed');
  if (state?.validationStatus?.source !== 'orchestrator' || state?.validationStatus?.scope !== 'targeted') {
    reasons.push('validation must be targeted orchestrator evidence');
  }
  if (state?.ciValidationStatus?.source !== 'github-actions' || state?.ciValidationStatus?.scope !== 'full') {
    reasons.push('full validation must be GitHub Actions evidence');
  }
  if (state?.threadResolutionStatus?.status !== 'passed') reasons.push('thread proof must have passed');
  reasons.push(...localVerificationStateGate(state));
  if (state?.verificationEscalation !== null) reasons.push('verification collection escalation requires human decision');
  if (state?.git?.dirty !== false) reasons.push('integration checkout must be clean');
  if (!Array.isArray(state?.tasks) || state.tasks.some((task) => task.status !== 'completed')) reasons.push('all tasks must be completed');
  if (state?.tasks?.some((task) => task.disposition === 'needs-human-decision')) reasons.push('needs-human-decision findings require a human');
  if ((state?.blockedReasons?.length ?? 0) !== 0) reasons.push('blocked reasons must be cleared');
  return reasons;
}

export function completionGate(state, external) {
  const reasons = completionStateGate(state);
  validateExternalHeads(state, external, reasons);
  return { allowed: reasons.length === 0, reasons };
}
