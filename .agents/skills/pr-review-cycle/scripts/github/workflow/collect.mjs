import { GitHubWorkflowError } from '../errors.mjs';
import { classifyPendingReviewResponse } from '../evidence/review-response.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import {
  assertRecordedRequestComment,
  requestAnchorObservation,
} from '../mutations/draft-review-request.mjs';
import { samePendingResponseObservation } from './refresh-threads.mjs';

export function sameRequestBoundOutcome(state, outcome) {
  const latest = state.reviewHistory.at(-1);
  return JSON.stringify(state.reviewOutcome) === JSON.stringify(outcome)
    && latest?.request?.id === outcome.requestId
    && JSON.stringify(latest.outcome) === JSON.stringify(outcome);
}

export function createCollectUseCase(context) {
  const {
    client, stateAdapter, git, load, assertCurrent,
    checkpointPendingRecoveryEscalation,
  } = context;
  async function collect(prNumber, { expectedOutcome = null } = {}) {
    let active = await load(prNumber);
    if (expectedOutcome !== null && active.reviewOutcome !== null
        && sameRequestBoundOutcome(active, expectedOutcome)) {
      return { escalated: false, outcome: active.reviewOutcome, phase: active.phase, performed: false };
    }
    const priorRevision = active.revision;
    if (!active.reviewRequest || active.reviewOutcome || active.reviewHistory.at(-1)?.outcome !== null) {
      throw new GitHubWorkflowError('No pending review request to collect', 'REVIEW_NOT_PENDING');
    }
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
    try {
      assertRecordedRequestComment(active, live);
    } catch (error) {
      if (!(error instanceof GitHubWorkflowError) || error.code !== 'REQUEST_PROOF_STALE') throw error;
      if (active.reviewRequest.kind !== 'verification') throw error;
      const response = await classifyPendingReviewResponse(active, live, git);
      await assertMutationReady({ state: active, git }, live);
      const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
      await assertMutationReady({ state: active, git }, finalLive);
      if (JSON.stringify(requestAnchorObservation(live, active.reviewRequest.id))
          !== JSON.stringify(requestAnchorObservation(finalLive, active.reviewRequest.id))
          || !samePendingResponseObservation(response, finalResponse)) {
        throw new GitHubWorkflowError('Recorded request anchor changed during collection', 'REVIEW_COLLECTION_STALE');
      }
      await assertCurrent(active);
      const ids = [
        `request-proof:${active.reviewRequest.id}`,
        ...response.evidenceIds,
        ...live.comments.filter((comment) => comment.id === active.reviewRequest.id)
          .map((comment) => `live-request:${comment.id}`),
      ];
      return checkpointPendingRecoveryEscalation(
        active, finalLive, ids, 'ambiguous-canonical-evidence',
      );
    }
    if (live.metadata.headRefOid !== active.reviewRequest.headSha) {
      throw new GitHubWorkflowError(
        'The exact recorded review request became stale at the live PR head',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertMutationReady({ state: active, git }, live);
    const response = await classifyPendingReviewResponse(active, live, git);
    if (response.status === 'none') {
      if (active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      throw new GitHubWorkflowError('Canonical review evidence is not available yet', 'REVIEW_NOT_AVAILABLE');
    }
    if (response.status === 'ambiguous' || response.status === 'stale') {
      if (active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
      if (!samePendingResponseObservation(response, finalResponse)) {
        throw new GitHubWorkflowError('Canonical review evidence changed during collection', 'REVIEW_COLLECTION_STALE');
      }
      await assertMutationReady({ state: active, git }, finalLive);
      await assertCurrent(active);
      return checkpointPendingRecoveryEscalation(
        active, finalLive,
        response.evidenceIds,
        response.status === 'stale' ? 'stale-canonical-evidence' : 'ambiguous-canonical-evidence',
      );
    }
    const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
    assertRecordedRequestComment(active, finalLive);
    if (finalLive.metadata.headRefOid !== active.reviewRequest.headSha) {
      throw new GitHubWorkflowError('The exact recorded review request became stale at the live PR head', 'REVIEW_COLLECTION_STALE');
    }
    const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
    if (!samePendingResponseObservation(response, finalResponse)) {
      throw new GitHubWorkflowError('Canonical review evidence changed during collection', 'REVIEW_COLLECTION_STALE');
    }
    await assertMutationReady({ state: active, git }, finalLive);
    await assertCurrent(active);
    const outcome = finalResponse.evidence;
    try {
      active = await stateAdapter.checkpointReviewOutcome({
        prNumber, expectedRevision: active.revision, outcome,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (!sameRequestBoundOutcome(active, outcome)) throw error;
      return { escalated: false, outcome: active.reviewOutcome, phase: active.phase, performed: false };
    }
    return { escalated: false, outcome: active.reviewOutcome, phase: active.phase,
      performed: active.revision !== priorRevision };
  }
  return collect;
}
