import { GitHubWorkflowError } from './errors.mjs';

function latestClassifications(journal) {
  const roots = new Map();
  for (const entry of journal?.entries ?? []) {
    if (entry.kind === 'classification') roots.set(entry.rootCauseId, entry);
  }
  return [...roots.values()];
}

function scopeFailure(message, code = 'SCOPE_NOT_READY') {
  throw new GitHubWorkflowError(message, code);
}

export async function readScopeReadiness(stateAdapter, state, liveHeadSha = null) {
  if (!stateAdapter?.scopeStatus) scopeFailure('The receipt-valid scope status adapter is unavailable', 'INVALID_ADAPTERS');
  let status;
  try {
    status = await stateAdapter.scopeStatus(state.prNumber);
  } catch (error) {
    scopeFailure(`Receipt-valid scope evidence could not be loaded: ${error.message}`, 'SCOPE_EVIDENCE_INVALID');
  }
  const classifications = latestClassifications(status?.journal?.value);
  const currentHead = state.currentIntegrationHeadSha;
  const referenceMatchesState = status?.configured === true
    && JSON.stringify(status.reference) === JSON.stringify(state.scopeControl);
  const receiptsMatch = status?.authority?.digest === status?.reference?.authorityDigest
    && status?.journal?.digest === status?.reference?.journalDigest
    && (status?.return?.digest ?? null) === status?.reference?.returnDigest;
  const assessmentHeads = classifications.map((entry) => entry.reviewHeadSha);
  const authorityHead = status?.authority?.value?.handoffHeadSha ?? null;
  const exactHead = status?.reference?.assessmentHeadSha
    ?? classifications[0]?.reviewHeadSha
    ?? authorityHead;
  const headMatches = exactHead === currentHead
    && (liveHeadSha === null || liveHeadSha === currentHead)
    && assessmentHeads.every((headSha) => headSha === currentHead);
  const ready = referenceMatchesState && receiptsMatch && status.gate === 'ready' && headMatches;
  return {
    ready,
    configured: status?.configured === true,
    gate: status?.gate ?? 'insufficient-authority',
    currentHeadSha: currentHead,
    liveHeadSha,
    exactHeadSha: exactHead,
    authority: status?.authority?.value ?? null,
    authorityDigest: status?.authority?.digest ?? null,
    journalDigest: status?.journal?.digest ?? null,
    classifications,
    referenceMatchesState,
    receiptsMatch,
    headMatches,
    returned: status?.return ?? null,
  };
}

export async function assertScopeReady(stateAdapter, state, liveHeadSha = null) {
  const readiness = await readScopeReadiness(stateAdapter, state, liveHeadSha);
  if (!readiness.configured) scopeFailure('Explicit scope authority is required before expanded review execution');
  if (!readiness.referenceMatchesState || !readiness.receiptsMatch) {
    scopeFailure('Durable scope evidence does not match the active state projection', 'SCOPE_EVIDENCE_INVALID');
  }
  if (readiness.gate !== 'ready') scopeFailure(`Scope gate ${readiness.gate} blocks expanded review execution`);
  if (!readiness.headMatches) scopeFailure('Scope evidence does not apply to the exact active and live PR HEAD', 'SCOPE_EVIDENCE_STALE');
  return readiness;
}

export async function assertScopeRootReady(stateAdapter, state, liveHeadSha, task) {
  const readiness = await assertScopeReady(stateAdapter, state, liveHeadSha);
  const sourceIds = new Set([task.id, ...(task.sourceIds ?? [])]);
  const classification = readiness.classifications.findLast((entry) => (
    entry.rootCauseId === task.id || entry.findingIds.some((id) => sourceIds.has(id))
  ));
  if (!classification) scopeFailure(`Task ${task.id} lacks receipt-valid scope classification`, 'SCOPE_ROOT_NOT_READY');
  if (!['within-scope-defect', 'unnecessary-mechanism-defect', 'unrelated-follow-up'].includes(
    classification.classification,
  )) {
    scopeFailure(`Task ${task.id} has blocked scope classification ${classification.classification}`, 'SCOPE_ROOT_NOT_READY');
  }
  return { ...readiness, classification };
}

export function scopeStatusSummary(readiness) {
  const roots = readiness.classifications.map((entry) => ({
    rootCauseId: entry.rootCauseId,
    findingIds: entry.findingIds,
    classification: entry.classification,
    smallestAlternative: entry.assessment.result.smallerSufficientAlternative
      ?? entry.assessment.result.narrowAlternative
      ?? entry.assessment.result.smallestExpansion,
    approvedBoundary: entry.assessment.result.scopeDelta?.description
      ?? entry.assessment.packet.minimalClosure?.statement
      ?? readiness.authority?.minimalClosure?.statement
      ?? 'No expanded boundary is approved.',
  }));
  const blocker = readiness.ready ? null
    : readiness.gate !== 'ready' ? `scope gate ${readiness.gate}`
      : !readiness.headMatches ? 'scope evidence is stale for the live PR HEAD'
        : 'scope evidence receipts do not match active state';
  return {
    configured: readiness.configured,
    authority: readiness.authority ? {
      kind: readiness.authority.authorityKind,
      source: readiness.authority.source.identity,
      minimalClosure: readiness.authority.minimalClosure.statement,
    } : null,
    exactHeadSha: readiness.exactHeadSha,
    headMatches: readiness.headMatches,
    roots,
    blocker,
    nextAction: blocker === null
      ? 'Continue within the approved exact-head scope boundary.'
      : readiness.gate === 'returned' || readiness.gate === 'resume-required'
        ? 'Resume through the guarded scope handoff before review execution.'
        : 'Resolve the durable scope blocker and re-establish exact-head evidence.',
  };
}
