import { scopeClassificationMatchesTask } from '../contracts/contracts.mjs';
import { GitHubWorkflowError } from './errors.mjs';

function latestClassifications(journal) {
  const roots = new Map();
  for (const entry of journal?.entries ?? []) {
    if (entry.kind === 'classification') {
      roots.delete(entry.rootCauseId);
      roots.set(entry.rootCauseId, entry);
    }
  }
  return [...roots.values()];
}

function classificationMatchesDisposition(classification, disposition) {
  return disposition === 'actionable'
    ? ['within-scope-defect', 'unnecessary-mechanism-defect'].includes(classification)
    : disposition === 'out-of-scope' && classification === 'unrelated-follow-up';
}

function initialAuthorityDigest(journal) {
  return journal?.entries?.find((entry) => entry.kind === 'amendment')?.priorAuthorityDigest
    ?? journal?.authorityDigest
    ?? null;
}

function canonicalExactHeadManifest(entries) {
  const manifest = entries.at(-1);
  const classification = entries.at(-2);
  if (manifest?.kind !== 'exact-head-manifest' || classification?.kind !== 'classification') return null;
  const canonical = manifest.reviewHeadSha === classification.reviewHeadSha
    && manifest.rootCauseId === classification.rootCauseId
    && manifest.authorityDigest === classification.authorityDigest
    && manifest.assessmentDigest === classification.assessment?.digest
    && classification.assessment?.packet?.binding?.phase === 'integrated-head'
    && classification.assessment?.result?.binding?.phase === 'integrated-head'
    && classification.assessment?.result?.verdict === 'within-scope'
    && classification.classification === 'within-scope-defect'
    && classification.authorityAmendmentRequired === false
    && manifest.triggerKinds?.length === 1
    && manifest.triggerKinds[0] === 'classification';
  return canonical ? { manifest, classification } : null;
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
  const entries = status?.journal?.value?.entries ?? [];
  // scopeStatus validates durable journal variants before they reach this adapter. Keeping
  // the schema discriminator here also leaves old lightweight adapter fixtures equivalent
  // to their original empty-journal authority setup.
  const durableEntries = entries.filter((entry) => entry?.schemaVersion === 1);
  const classifications = latestClassifications(status?.journal?.value);
  const currentHead = state.currentIntegrationHeadSha;
  const referenceMatchesState = status?.configured === true
    && JSON.stringify(status.reference) === JSON.stringify(state.scopeControl);
  const effectiveAuthorityDigest = status?.journal?.value?.authorityDigest
    ?? (durableEntries.length === 0 ? status?.reference?.authorityDigest : null);
  const journalInitialAuthorityDigest = initialAuthorityDigest(status?.journal?.value)
    ?? (durableEntries.length === 0 ? effectiveAuthorityDigest : null);
  const receiptsMatch = status?.authority?.digest === journalInitialAuthorityDigest
    && effectiveAuthorityDigest === status?.reference?.authorityDigest
    && status?.journal?.digest === status?.reference?.journalDigest
    && (status?.return?.digest ?? null) === status?.reference?.returnDigest;
  const authorityHead = status?.authority?.value?.handoffHeadSha ?? null;
  const hasClassificationHistory = durableEntries.some((entry) => entry.kind === 'classification');
  const exactHeadManifest = hasClassificationHistory
    ? canonicalExactHeadManifest(durableEntries)
    : null;
  const initialAuthorityReady = !hasClassificationHistory
    && durableEntries.length === 0
    && ['standalone', 'imported'].includes(status?.authority?.value?.authorityKind)
    && authorityHead === currentHead;
  const manifestMatches = !hasClassificationHistory
    ? initialAuthorityReady
    : exactHeadManifest?.manifest.authorityDigest === effectiveAuthorityDigest;
  const exactHead = exactHeadManifest?.manifest.reviewHeadSha
    ?? (initialAuthorityReady ? authorityHead : status?.reference?.assessmentHeadSha ?? null);
  const headMatches = exactHead === currentHead
    && (liveHeadSha === null || liveHeadSha === currentHead)
    && status?.reference?.assessmentHeadSha === (hasClassificationHistory ? currentHead : null);
  const ready = referenceMatchesState && receiptsMatch && status.gate === 'ready'
    && manifestMatches && headMatches;
  return {
    ready,
    configured: status?.configured === true,
    gate: status?.gate ?? 'insufficient-authority',
    currentHeadSha: currentHead,
    liveHeadSha,
    exactHeadSha: exactHead,
    authority: status?.authority?.value ?? null,
    authorityDigest: effectiveAuthorityDigest,
    journalAuthorityDigest: effectiveAuthorityDigest,
    journalDigest: status?.journal?.digest ?? null,
    classifications,
    hasClassificationHistory,
    exactHeadManifest,
    manifestMatches,
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
  if (!readiness.manifestMatches) {
    scopeFailure('Scope history lacks a terminal canonical integrated-HEAD manifest', 'SCOPE_EVIDENCE_INVALID');
  }
  if (!readiness.headMatches) scopeFailure('Scope evidence does not apply to the exact active and live PR HEAD', 'SCOPE_EVIDENCE_STALE');
  return readiness;
}

export async function assertScopeRootReady(stateAdapter, state, liveHeadSha, task) {
  const readiness = await readScopeReadiness(stateAdapter, state, liveHeadSha);
  if (!readiness.configured) scopeFailure('Explicit scope authority is required before expanded review execution');
  if (!readiness.referenceMatchesState || !readiness.receiptsMatch) {
    scopeFailure('Durable scope evidence does not match the active state projection', 'SCOPE_EVIDENCE_INVALID');
  }
  if (readiness.gate !== 'ready') scopeFailure(`Scope gate ${readiness.gate} blocks expanded review execution`);
  if (liveHeadSha !== null && liveHeadSha !== readiness.currentHeadSha) {
    scopeFailure('Scope evidence does not apply to the exact active and live PR HEAD', 'SCOPE_EVIDENCE_STALE');
  }
  const classification = readiness.classifications.findLast(
    (entry) => scopeClassificationMatchesTask(entry, task),
  );
  if (!classification) scopeFailure(`Task ${task.id} lacks receipt-valid scope classification`, 'SCOPE_ROOT_NOT_READY');
  const phase = classification.assessment?.packet?.binding?.phase;
  const expectedHead = classification.schemaVersion !== 1
    ? readiness.currentHeadSha
    : phase === 'integrated-head'
      ? readiness.currentHeadSha
      : ['task', 'review-finding'].includes(phase)
        ? state.reviewedHeadSha ?? readiness.currentHeadSha
        : null;
  if (classification.schemaVersion === 1
      && (classification.authorityDigest !== readiness.authorityDigest
        || classification.authorityDigest !== readiness.journalAuthorityDigest)) {
    scopeFailure(`Task ${task.id} has superseded scope authority`, 'SCOPE_ROOT_NOT_READY');
  }
  if (expectedHead === null || classification.reviewHeadSha !== expectedHead) {
    scopeFailure(`Task ${task.id} has stale scope classification`, 'SCOPE_ROOT_NOT_READY');
  }
  if (!classificationMatchesDisposition(classification.classification, task.disposition)) {
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
      : !readiness.manifestMatches ? 'scope history lacks a terminal integrated-HEAD manifest'
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
