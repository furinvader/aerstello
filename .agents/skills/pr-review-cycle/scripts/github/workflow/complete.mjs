import { GitHubWorkflowError } from '../errors.mjs';
import { isCanonicalActor } from '../evidence/actors.mjs';
import { ciEvidenceFromRollup } from '../evidence/ci.mjs';
import {
  classifyPendingReviewResponse,
  classifyReviewSubmission,
  classifyStructuralIssueComments,
} from '../evidence/review-response.mjs';
import { readPullRequestChecks } from '../graphql/pull-request-reader.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import {
  assertRecordedRequestComment,
  sameTimestamp,
} from '../mutations/draft-review-request.mjs';
import { assertLiveThreadProof } from '../threads/proof.mjs';
import { sameCiEvidence } from './collect-ci.mjs';
import { samePendingResponseObservation } from './refresh-threads.mjs';

function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

function evidenceAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request');
}

export function isTransientCiError(error) {
  return error instanceof GitHubWorkflowError
    && ['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code);
}

export function createCompletionUseCases(context) {
  const { client, stateAdapter, git, load, assertCurrent, assertScopeCurrent } = context;

  async function assertCompletionReady(state, live) {
    const heads = await assertMutationReady({ state, git }, live);
    await assertScopeCurrent(state, live.metadata.headRefOid);
    return heads;
  }

  async function assertCompletionLiveEvidence(state, live, heads) {
    assertRecordedRequestComment(state, live);
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical threads are still unresolved', 'COMPLETION_NOT_READY');
    }
    assertLiveThreadProof(state, live);
    if (state.reviewOutcome?.outcome !== 'clean'
        || state.reviewOutcome.headSha !== live.metadata.headRefOid
        || state.reviewRequest?.headSha !== live.metadata.headRefOid) {
      throw new GitHubWorkflowError('Clean canonical outcome does not apply to live PR HEAD', 'COMPLETION_NOT_READY');
    }
    let outcomeIsLive;
    if (state.reviewOutcome.evidenceType === 'review-submission') {
      outcomeIsLive = live.reviews.some((review) => review.id === state.reviewOutcome.id
        && review.state === 'COMMENTED' && review.commit?.oid === live.metadata.headRefOid
        && isCanonicalActor(review.author) && evidenceAtOrAfter(review.submittedAt, state.reviewRequest.at)
        && classifyReviewSubmission(review, live.threads) === 'clean');
    } else if (state.reviewOutcome.evidenceType === 'request-reaction') {
      outcomeIsLive = live.reactions.some((reaction) => reaction.id === state.reviewOutcome.id
        && reaction.content === 'THUMBS_UP' && isCanonicalActor(reaction.user)
        && evidenceAtOrAfter(reaction.createdAt, state.reviewRequest.at));
    } else {
      const classified = await classifyStructuralIssueComments({
        comments: live.comments.filter((comment) => comment.id === state.reviewOutcome.id),
        request: state.reviewRequest, threads: live.threads, git, cwd: state.integrationWorktree,
        expectedHeads: [state.reviewRequest.headSha, state.currentIntegrationHeadSha,
          heads.pushedHeadSha, live.metadata.headRefOid],
      });
      outcomeIsLive = classified.exact.length === 1 && classified.unsupported.length === 0;
      if (outcomeIsLive) {
        const comment = classified.exact[0].comment;
        outcomeIsLive = (comment.databaseId ?? null) === state.reviewOutcome.databaseId
          && comment.url === state.reviewOutcome.url
          && sameTimestamp(comment.createdAt, state.reviewOutcome.at)
          && comment.author.login === state.reviewOutcome.reviewerLogin
          && comment.author.id === state.reviewOutcome.reviewerNodeId
          && comment.author.__typename === state.reviewOutcome.reviewerType
          && comment.author.url === state.reviewOutcome.reviewerUrl;
      }
    }
    if (!outcomeIsLive) {
      throw new GitHubWorkflowError('Recorded clean outcome is not proven live', 'COMPLETION_NOT_READY');
    }
    const response = await classifyPendingReviewResponse(
      { ...state, reviewOutcome: null }, live, git,
    );
    if (response.status !== 'supported' || response.evidence.outcome !== 'clean'
        || JSON.stringify(response.evidence) !== JSON.stringify(state.reviewOutcome)) {
      throw new GitHubWorkflowError(
        'Recorded clean canonical response or root evidence changed before completion',
        'COMPLETION_NOT_READY',
      );
    }
    return response;
  }

  async function assertFindingsLiveEvidence(state, live) {
    if (state.reviewOutcome?.outcome !== 'findings'
        || state.reviewRequest?.headSha !== state.currentIntegrationHeadSha
        || state.reviewOutcome.headSha !== state.currentIntegrationHeadSha) {
      throw new GitHubWorkflowError(
        'Recorded findings do not apply to the current integration HEAD',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertCompletionReady(state, live);
    assertRecordedRequestComment(state, live);
    const response = await classifyPendingReviewResponse(
      { ...state, reviewOutcome: null }, live, git,
    );
    if (response.status !== 'supported' || response.evidence.outcome !== 'findings'
        || JSON.stringify(response.evidence) !== JSON.stringify(state.reviewOutcome)) {
      throw new GitHubWorkflowError(
        'Recorded canonical findings evidence changed before triage',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertCurrent(state);
    return response;
  }

  async function revalidateCompletedState(active) {
    if (active.phase !== 'complete' || active.ciValidationStatus?.status !== 'passed') {
      throw new GitHubWorkflowError('Durable completion evidence is incomplete', 'COMPLETION_NOT_READY');
    }
    let priorResponse = null;
    let priorCiEvidence = null;
    for (let snapshotIndex = 0; snapshotIndex < 2; snapshotIndex += 1) {
      const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
      const heads = await assertCompletionReady(active, live);
      const response = await assertCompletionLiveEvidence(active, live, heads);
      const ciEvidence = ciEvidenceFromRollup(await readPullRequestChecks(
        client, active.repository, active.prNumber, live.metadata.headRefOid,
      ));
      if (ciEvidence.status !== 'passed' || !sameCiEvidence(ciEvidence, active.ciValidationStatus)) {
        throw new GitHubWorkflowError(
          'Live Full validation evidence differs from durable completion evidence',
          'COMPLETION_NOT_READY',
        );
      }
      if (priorResponse !== null && (!samePendingResponseObservation(priorResponse, response)
          || !sameCiEvidence(priorCiEvidence, ciEvidence))) {
        throw new GitHubWorkflowError(
          'Live review or CI evidence changed during Done revalidation',
          'COMPLETION_NOT_READY',
        );
      }
      priorResponse = response;
      priorCiEvidence = ciEvidence;
    }
    await assertCurrent(active);
    return active;
  }

  async function complete(prNumber, { checkpointCi = true } = {}) {
    let active = await load(prNumber);
    const priorRevision = active.revision;
    if (active.phase === 'complete') {
      await revalidateCompletedState(active);
      return { completed: true, phase: active.phase, revision: active.revision, idempotent: true, performed: false };
    }
    const expectedRequest = structuredClone(active.reviewRequest);
    const expectedOutcome = structuredClone(active.reviewOutcome);
    const expectedHeadSha = active.currentIntegrationHeadSha;

    let live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    let completionHeads = await assertCompletionReady(active, live);
    const initialResponse = await assertCompletionLiveEvidence(active, live, completionHeads);
    const snapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const evidence = ciEvidenceFromRollup(snapshot);
    if (!checkpointCi && !sameCiEvidence(evidence, active.ciValidationStatus)) {
      throw new GitHubWorkflowError('Durable CI evidence changed before completion', 'COMPLETION_NOT_READY');
    }
    if (evidence.status !== 'passed') {
      throw new GitHubWorkflowError('Full GitHub Actions validation did not pass', 'COMPLETION_NOT_READY');
    }
    if (checkpointCi) {
      active = await stateAdapter.checkpointCiValidation({
        prNumber: active.prNumber, expectedRevision: active.revision, evidence,
      });
    }
    const expectedCiEvidence = checkpointCi ? evidence : structuredClone(active.ciValidationStatus);
    live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    const refreshedHeads = await assertCompletionReady(active, live);
    completionHeads = refreshedHeads;
    const finalResponse = await assertCompletionLiveEvidence(active, live, completionHeads);
    if (!samePendingResponseObservation(initialResponse, finalResponse)) {
      throw new GitHubWorkflowError(
        'Live review response or root evidence changed before completion',
        'COMPLETION_NOT_READY',
      );
    }
    const finalCiSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const finalEvidence = ciEvidenceFromRollup(finalCiSnapshot);
    if (finalEvidence.status !== 'passed' || !sameCiEvidence(evidence, finalEvidence)) {
      throw new GitHubWorkflowError(
        'Full GitHub Actions validation changed before completion', 'COMPLETION_NOT_READY',
      );
    }
    try {
      active = await stateAdapter.checkpointCompletion({
        prNumber, expectedRevision: active.revision,
        pushedHeadSha: refreshedHeads.pushedHeadSha, prHeadSha: live.metadata.headRefOid,
        prState: live.metadata.state, isDraft: live.metadata.isDraft,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (active.phase !== 'complete'
          || active.currentIntegrationHeadSha !== expectedHeadSha
          || JSON.stringify(active.reviewRequest) !== JSON.stringify(expectedRequest)
          || JSON.stringify(active.reviewOutcome) !== JSON.stringify(expectedOutcome)
          || !sameCiEvidence(active.ciValidationStatus, expectedCiEvidence)) throw error;
      return { completed: true, phase: active.phase, revision: active.revision, performed: false, idempotent: true };
    }
    return { completed: true, phase: active.phase, revision: active.revision,
      performed: active.revision !== priorRevision };
  }

  return { assertCompletionLiveEvidence, assertFindingsLiveEvidence, revalidateCompletedState, complete };
}

export function createCompleteUseCase(context) {
  return createCompletionUseCases(context).complete;
}
