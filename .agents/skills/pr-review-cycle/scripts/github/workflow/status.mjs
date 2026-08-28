import { reviewRequestUsage } from '../../contracts/contracts.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import { ciEvidenceFromRollup } from '../evidence/ci.mjs';
import { classifyPendingReviewResponse } from '../evidence/review-response.mjs';
import { readPullRequestChecks } from '../graphql/pull-request-reader.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { assertRecordedRequestComment } from '../mutations/draft-review-request.mjs';
import { tasklessPendingReviewHeadDriftRefreshAllowed } from './refresh-threads.mjs';
import { scopeStatusSummary } from '../scope-readiness.mjs';

export function codexReviewStatus(state, liveHeadSha) {
  const request = state.reviewRequest;
  if (!request) return 'not-requested';
  const requestIsCurrent = request.headSha === state.currentIntegrationHeadSha
    && request.headSha === liveHeadSha;
  if (!requestIsCurrent) return 'stale';
  const outcome = state.reviewOutcome;
  if (!outcome) return 'awaiting';
  const outcomeIsCurrent = outcome.headSha === state.currentIntegrationHeadSha
    && outcome.headSha === liveHeadSha;
  return outcomeIsCurrent ? outcome.outcome : 'stale';
}

export async function reviewObservation(state, live, git) {
  if (!state.reviewRequest || state.reviewOutcome) {
    return { status: 'not-applicable', outcome: null, evidenceType: null, evidenceIds: [] };
  }
  if (live.metadata.headRefOid !== state.reviewRequest.headSha
      || state.reviewRequest.headSha !== state.currentIntegrationHeadSha
      || live.metadata.headRefOid !== state.currentIntegrationHeadSha) {
    return { status: 'stale', outcome: null, evidenceType: null, evidenceIds: [] };
  }
  try {
    assertRecordedRequestComment(state, live);
    const response = await classifyPendingReviewResponse(state, live, git);
    if (response.status === 'none') return { status: 'waiting', outcome: null, evidenceType: null, evidenceIds: [] };
    if (response.status === 'ambiguous') {
      return { status: 'ambiguous', outcome: null, evidenceType: null, evidenceIds: response.evidenceIds };
    }
    if (response.status === 'stale') {
      return { status: 'stale', outcome: null, evidenceType: null, evidenceIds: response.evidenceIds };
    }
    return {
      status: 'collectable', outcome: response.evidence.outcome,
      evidenceType: response.evidence.evidenceType, evidenceIds: response.evidenceIds,
    };
  } catch {
    const matching = live.comments.filter((comment) => comment.id === state.reviewRequest.id)
      .map((comment) => `live-request:${comment.id}`);
    return {
      status: 'ambiguous', outcome: null, evidenceType: null,
      evidenceIds: [...new Set([`request-proof:${state.reviewRequest.id}`, ...matching])],
    };
  }
}

export async function staleDiscoveryStatus(state, live, git) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  if (request?.kind !== 'discovery' || state.reviewOutcome !== null || latest?.outcome !== null
      || latest?.request?.id !== request.id || request.headSha === live.metadata.headRefOid) {
    return { category: 'not-applicable', dispositionId: null, canonicalRootCount: 0 };
  }
  if (live.metadata.headRefOid !== state.currentIntegrationHeadSha) {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  const existing = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === request.id) ?? null;
  if (existing === null && !tasklessPendingReviewHeadDriftRefreshAllowed(state)) {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  try {
    assertRecordedRequestComment(state, live);
    if (existing === null) await assertMutationReady({ state, git }, live);
  } catch {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  let response;
  try {
    response = await classifyPendingReviewResponse(state, live, git, { includeUnmatchedRoots: true });
  } catch {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  if (existing !== null) {
    if (response.status !== 'supported'
        || JSON.stringify(existing.evidence) !== JSON.stringify(response.evidence)
        || existing.responseFingerprint !== response.responseFingerprint
        || (existing.evidence.outcome === 'clean'
          && existing.liveHeadSha !== live.metadata.headRefOid)) {
      return {
        category: 'ambiguous-human-decision', dispositionId: existing.dispositionId,
        canonicalRootCount: response.rootState.length,
      };
    }
    return {
      category: response.evidence.outcome === 'findings'
        ? 'actionable-stale-findings' : 'dispositioned',
      dispositionId: existing.dispositionId,
      canonicalRootCount: response.rootState.length,
    };
  }
  if (response.status === 'none') {
    return { category: 'pure-head-drift', dispositionId: null, canonicalRootCount: 0 };
  }
  if (response.status === 'ambiguous' || response.status === 'stale') {
    return {
      category: 'ambiguous-human-decision', dispositionId: null,
      canonicalRootCount: response.rootState.length,
    };
  }
  return {
    category: response.evidence.outcome === 'findings'
      ? 'actionable-stale-findings' : 'disposition-ready',
    dispositionId: null,
    canonicalRootCount: response.rootState.length,
  };
}

export function staleDiscoveryNextAction(status, fallback) {
  if (status.category === 'disposition-ready') {
    return 'Run refresh-threads to disposition the unique stale discovery response and prove the current empty root set.';
  }
  if (status.category === 'actionable-stale-findings' && status.dispositionId === null) {
    return 'Run refresh-threads to disposition the unique stale discovery response, then triage its actionable findings.';
  }
  if (status.category === 'ambiguous-human-decision') {
    return 'Present the ambiguous stale discovery evidence and exact request/head identities to a human.';
  }
  return fallback;
}

export function createStatusUseCase(context) {
  const { client, stateAdapter, git, load, scopeReadiness } = context;
  async function status(prNumber) {
    const active = await load(prNumber);
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    if (live.metadata.state !== 'OPEN') {
      throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
    }
    const ciSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid, { requireReady: false },
    );
    let liveCi;
    try {
      liveCi = ciEvidenceFromRollup(ciSnapshot);
    } catch (error) {
      if (!(error instanceof GitHubWorkflowError)
          || !['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code)) throw error;
      liveCi = { status: error.code === 'CI_CHECK_MISSING' ? 'missing' : 'pending', message: error.message };
    }
    const openThreads = live.threads.filter((thread) => thread.canonical && !thread.isResolved).length;
    const requestUsage = reviewRequestUsage(active);
    const staleDiscoveryEvidence = await staleDiscoveryStatus(active, live, git);
    const observation = await reviewObservation(active, live, git);
    const scope = scopeStatusSummary(await scopeReadiness(active, live.metadata.headRefOid));
    const specialistReviews = stateAdapter.specialistStatus
      ? await stateAdapter.specialistStatus(active.prNumber)
      : {
          status: 'missing', headSha: active.currentIntegrationHeadSha,
          stateRevision: active.revision, requiredReviewerIds: [], recordedReviewerIds: [],
        };
    return {
      prNumber: active.prNumber,
      statePhase: active.phase,
      stateHeadSha: active.currentIntegrationHeadSha,
      liveHeadSha: live.metadata.headRefOid,
      pullRequest: { state: live.metadata.state, isDraft: live.metadata.isDraft },
      reviewObservation: observation,
      canonicalThreads: live.threads.filter((thread) => thread.canonical).map((thread) => ({
        threadNodeId: thread.id,
        rootCommentNodeId: thread.root.id,
        rootCommentDatabaseId: thread.root.databaseId,
        isResolved: thread.isResolved,
      })),
      reviewCount: live.reviews.length,
      reviewRequests: { used: requestUsage.used, limit: requestUsage.limit },
      requestReactionCount: live.reactions.length,
      staleDiscoveryEvidence,
      codexReview: codexReviewStatus(active, live.metadata.headRefOid),
      taskStatus: {
        resolved: active.tasks.filter((task) => task.status === 'completed').length,
        pending: active.tasks.filter((task) => task.status !== 'completed').length,
        display: active.phase === 'complete' ? 'Done' : 'Resolved',
        items: active.tasks.map((task) => ({
          id: task.id,
          summary: task.summary,
          status: active.phase === 'complete' ? 'Done'
            : task.status === 'completed' ? 'Resolved'
              : task.status === 'integrated' ? 'Integrated'
                : task.status === 'running' ? 'worker running' : task.status,
        })),
      },
      targetedValidation: active.validationStatus,
      specialistReviews,
      recordedCiValidation: active.ciValidationStatus,
      liveCiValidation: liveCi,
      openCodexThreads: openThreads,
      scope,
      nextAction: scope.blocker ? scope.nextAction : staleDiscoveryNextAction(staleDiscoveryEvidence,
        active.phase === 'ready-for-review' && requestUsage.exhausted
        ? `Review request limit ${requestUsage.limit} is exhausted after ${requestUsage.used} durable requests; run npm run review:state -- set-review-limit --pr ${active.prNumber} --expected-revision ${active.revision} --limit <higher-number> or --unlimited before the next request.`
        : active.nextAction),
    };
  }
  return status;
}
