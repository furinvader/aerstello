import { GitHubWorkflowError } from '../errors.mjs';
import { ciEvidenceFromRollup } from '../evidence/ci.mjs';
import { classifyPendingReviewResponse } from '../evidence/review-response.mjs';
import { readPullRequestChecks } from '../graphql/pull-request-reader.mjs';
import { assertMutationReady, assertPullRequestReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { assertRecordedRequestComment } from '../mutations/draft-review-request.mjs';
import { assertLiveThreadProof } from '../threads/proof.mjs';
import { isTransientCiError } from './complete.mjs';
import { samePendingResponseObservation } from './refresh-threads.mjs';

export function createAdvanceUseCase(context, operations) {
  const { client, git, load } = context;
  const {
    collect,
    collectCi,
    complete,
    assertFindingsLiveEvidence,
    revalidateCompletedState,
  } = operations;

  async function advance(prNumber) {
    let active = await load(prNumber);
    const performedTransitions = [];
    const result = (terminal, waiting, nextAction, extra = {}) => ({
      phase: active.phase, revision: active.revision, performedTransitions, terminal, waiting, nextAction, ...extra,
    });
    if (active.verificationEscalation) {
      return result('escalation', false, active.nextAction, { escalation: active.verificationEscalation });
    }
    if (active.phase === 'complete') {
      try {
        await revalidateCompletedState(active);
      } catch (error) {
        if (isTransientCiError(error)) {
          return result('waiting', true, 'Await authoritative Full validation CI evidence.');
        }
        throw error;
      }
      return result('done', false, active.nextAction);
    }
    const initialLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    assertPullRequestReady(initialLive);
    if (!active.reviewRequest || !active.reviewOutcome) {
      if (!active.reviewRequest) {
        return result('waiting', true, active.nextAction);
      }
      const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      try {
        assertRecordedRequestComment(active, live);
      } catch (error) {
        if (active.reviewRequest.kind !== 'verification') throw error;
        const collected = await collect(prNumber);
        active = await load(prNumber);
        if (collected.performed) performedTransitions.push('verification-escalation');
        return result('escalation', false, active.nextAction, { escalation: collected.escalation });
      }
      if (live.metadata.headRefOid !== active.reviewRequest.headSha) {
        return result('waiting', true, 'Review request is stale at the live PR head.');
      }
      const response = await classifyPendingReviewResponse(active, live, git);
      if (response.status === 'none') {
        return result('waiting', true, 'Await the canonical Codex review response.');
      }
      if (response.status === 'ambiguous' && active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const collected = await collect(prNumber, { expectedOutcome: response.status === 'supported' ? response.evidence : null });
      if (collected.escalated) {
        active = await load(prNumber);
        if (collected.performed) performedTransitions.push('verification-escalation');
        return result('escalation', false, active.nextAction, { escalation: collected.escalation });
      }
      if (collected.performed) performedTransitions.push('review-outcome');
      active = await load(prNumber);
      if (active.reviewOutcome?.outcome === 'findings') {
        return result('triage', false, active.nextAction);
      }
    }
    if (active.reviewOutcome?.outcome === 'findings') {
      if (active.reviewRequest?.headSha !== active.currentIntegrationHeadSha
          || active.reviewOutcome.headSha !== active.currentIntegrationHeadSha) {
        throw new GitHubWorkflowError(
          'Recorded findings do not apply to the current integration HEAD',
          'REVIEW_COLLECTION_STALE',
        );
      }
      if (initialLive.metadata.headRefOid !== active.currentIntegrationHeadSha) {
        return result('waiting', true, 'Review findings are stale at the live PR head; reconcile before triage.');
      }
      const initialFindingsResponse = await assertFindingsLiveEvidence(active, initialLive);
      const finalFindingsLive = await readLiveSnapshot(
        client, active, { reactionsFor: active.reviewRequest.id },
      );
      const finalFindingsResponse = await assertFindingsLiveEvidence(active, finalFindingsLive);
      if (!samePendingResponseObservation(initialFindingsResponse, finalFindingsResponse)) {
        throw new GitHubWorkflowError(
          'Canonical findings response or root evidence changed before triage',
          'REVIEW_COLLECTION_STALE',
        );
      }
      return result('triage', false, active.nextAction);
    }
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    await assertMutationReady({ state: active, git }, live);
    assertRecordedRequestComment(active, live);
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical threads are still unresolved', 'COMPLETION_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    if (active.reviewOutcome?.outcome !== 'clean'
        || active.reviewOutcome.headSha !== live.metadata.headRefOid
        || active.reviewRequest?.headSha !== live.metadata.headRefOid) {
      throw new GitHubWorkflowError('Clean canonical outcome no longer applies to the live PR head', 'COMPLETION_NOT_READY');
    }
    const liveOutcome = await classifyPendingReviewResponse(
      { ...active, reviewOutcome: null }, live, git,
    );
    if (liveOutcome.status !== 'supported' || liveOutcome.evidence.outcome !== 'clean'
        || JSON.stringify(liveOutcome.evidence) !== JSON.stringify(active.reviewOutcome)) {
      throw new GitHubWorkflowError('Recorded clean canonical evidence changed before CI validation', 'COMPLETION_NOT_READY');
    }
    if (live.metadata.headRefOid !== active.currentIntegrationHeadSha) {
      return result('waiting', true, 'Reconcile the live PR head before advancing.');
    }
    let ci;
    try {
      ci = ciEvidenceFromRollup(await readPullRequestChecks(client, active.repository, active.prNumber, live.metadata.headRefOid));
    } catch (error) {
      if (error instanceof GitHubWorkflowError && ['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code)) {
        return result('waiting', true, 'Await authoritative Full validation CI evidence.');
      }
      throw error;
    }
    let collectedCi;
    try {
      collectedCi = await collectCi(prNumber);
    } catch (error) {
      if (isTransientCiError(error)) {
        active = await load(prNumber);
        if (active.phase === 'complete') {
          try {
            await revalidateCompletedState(active);
          } catch (revalidationError) {
            if (isTransientCiError(revalidationError)) {
              return result('waiting', true, 'Await authoritative Full validation CI evidence.');
            }
            throw revalidationError;
          }
          return result('done', false, active.nextAction);
        }
        return result('waiting', true, 'Await authoritative Full validation CI evidence.');
      }
      throw error;
    }
    active = await load(prNumber);
    if (collectedCi.performed) performedTransitions.push('ci-validation');
    if (collectedCi.evidence.status === 'failed') {
      return result('failure', false, active.nextAction, { ciValidation: collectedCi.evidence });
    }
    let completed;
    try {
      completed = await complete(prNumber, { checkpointCi: false });
    } catch (error) {
      if (!isTransientCiError(error)) throw error;
      active = await load(prNumber);
      if (active.phase === 'complete') {
        try {
          await revalidateCompletedState(active);
        } catch (revalidationError) {
          if (isTransientCiError(revalidationError)) {
            return result('waiting', true, 'Await authoritative Full validation CI evidence.');
          }
          throw revalidationError;
        }
        return result('done', false, active.nextAction);
      }
      return result('waiting', true, 'Await authoritative Full validation CI evidence.');
    }
    if (completed.performed) performedTransitions.push('cycle-completion');
    active = await load(prNumber);
    return result('done', false, 'Archive is explicit after Done.', { completed: completed.completed });
  }

  return advance;
}
