import {
  buildStaleDiscoveryDisposition,
  reviewRequestUsage,
} from '../../contracts/contracts.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import { classifyPendingReviewResponse } from '../evidence/review-response.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { buildCanonicalRootPlan } from '../threads/canonical-roots.mjs';
import { assertRecordedRequestComment } from '../mutations/draft-review-request.mjs';

export function tasklessReviewHeadDriftRefreshAllowed(state) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const reviewAllowanceRemains = !reviewRequestUsage(state).exhausted;
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && state.phase === 'recovering'
    && state.tasks.length === 0
    && request !== null
    && outcome?.outcome === 'clean' && latest !== undefined
    && JSON.stringify(latest.request) === JSON.stringify(request)
    && JSON.stringify(latest.outcome) === JSON.stringify(outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === priorHeadSha
    && outcome.headSha === priorHeadSha
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && reviewAllowanceRemains;
}

export function tasklessPendingReviewHeadDriftRefreshAllowed(state) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const disposition = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === request?.id) ?? null;
  const recoveryPhase = ['recovering', 'ready-for-review'].includes(state.phase)
    || (state.phase === 'triaging' && disposition?.evidence?.outcome === 'findings');
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && recoveryPhase
    && state.tasks.length === 0
    && request !== null && latest !== undefined
    && state.reviewOutcome === null && latest.outcome === null
    && JSON.stringify(latest.request) === JSON.stringify(request)
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === null
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.validationStatus.status === 'passed'
    && state.validationStatus.headSha === state.currentIntegrationHeadSha
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && (disposition === null
      || (disposition.requestHeadSha === priorHeadSha
        && disposition.liveHeadSha === state.currentIntegrationHeadSha));
}

export function dispositionForPendingResponse(state, response, disposedAt) {
  const existing = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === state.reviewRequest.id) ?? null;
  if (response.status !== 'supported') {
    if (existing !== null) {
      throw new GitHubWorkflowError(
        'Dispositioned stale discovery evidence is missing or no longer uniquely classifiable',
        'STALE_DISCOVERY_EVIDENCE_CHANGED',
      );
    }
    return null;
  }
  const disposition = buildStaleDiscoveryDisposition({
    request: state.reviewRequest,
    liveHeadSha: state.currentIntegrationHeadSha,
    evidence: response.evidence,
    responseFingerprint: response.responseFingerprint,
    disposedAt: existing?.disposedAt ?? disposedAt,
  });
  if (existing !== null && JSON.stringify(existing) !== JSON.stringify(disposition)) {
    throw new GitHubWorkflowError(
      'Live stale discovery evidence differs from its immutable disposition',
      'STALE_DISCOVERY_EVIDENCE_CHANGED',
    );
  }
  return disposition;
}

export function samePendingResponseObservation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createRefreshThreadsUseCase(context) {
  const {
    client, stateAdapter, git, clock, load, assertCurrent,
    checkpointPendingRecoveryEscalation,
  } = context;
  async function refreshThreads(prNumber) {
    let active = await load(prNumber);
    const pristine = active.phase === 'recovering'
      && active.tasks.length === 0
      && active.reviewRound === 0
      && active.requestedHeadSha === null
      && active.reviewedHeadSha === null
      && active.reviewRequest === null
      && active.reviewOutcome === null
      && active.reviewHistory.length === 0
      && active.verificationReviewUsed === false
      && active.verificationEscalation === null;
    const headDriftRecovery = tasklessReviewHeadDriftRefreshAllowed(active);
    const pendingHeadDriftRecovery = tasklessPendingReviewHeadDriftRefreshAllowed(active);
    if (!pristine && !headDriftRecovery && !pendingHeadDriftRecovery) {
      throw new GitHubWorkflowError(
        'Empty-thread refresh requires a pristine taskless cycle or guarded review HEAD-drift recovery',
        'TASKLESS_REFRESH_NOT_ALLOWED',
      );
    }
    if (!stateAdapter.checkpointTaskCompletion) {
      throw new GitHubWorkflowError('The guarded thread-proof checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    let live = await readLiveSnapshot(client, active, {
      reactionsFor: pendingHeadDriftRecovery ? active.reviewRequest.id : null,
    });
    let pendingResponse = null;
    let staleDiscoveryDisposition = null;
    if (pendingHeadDriftRecovery) {
      try {
        assertRecordedRequestComment(active, live);
      } catch (error) {
        if (!(error instanceof GitHubWorkflowError) || error.code !== 'REQUEST_PROOF_STALE'
            || active.reviewRequest.kind !== 'verification') throw error;
        return checkpointPendingRecoveryEscalation(
          active, live, [`request-proof:${active.reviewRequest.id}`], 'ambiguous-canonical-evidence',
        );
      }
      pendingResponse = await classifyPendingReviewResponse(active, live, git, { includeUnmatchedRoots: true });
      if (active.reviewRequest.kind === 'verification' && pendingResponse.status !== 'none') {
        return checkpointPendingRecoveryEscalation(
          active,
          live,
          pendingResponse.evidenceIds,
          pendingResponse.status === 'supported'
            ? 'stale-canonical-evidence' : 'ambiguous-canonical-evidence',
        );
      }
      if (active.reviewRequest.kind === 'discovery') {
        if (pendingResponse.status === 'ambiguous') {
          throw new GitHubWorkflowError(
            'Discovery review evidence is multiple, conflicting, or unsupported and requires a human',
            'DISCOVERY_COLLECTION_UNRESOLVED',
          );
        }
        staleDiscoveryDisposition = dispositionForPendingResponse(
          active, pendingResponse, clock.now(),
        );
      }
    }
    await assertMutationReady({ state: active, git }, live);
    if (staleDiscoveryDisposition?.evidence.outcome === 'findings') {
      const finalLive = await readLiveSnapshot(client, active, {
        reactionsFor: active.reviewRequest.id,
      });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git, { includeUnmatchedRoots: true });
      if (!samePendingResponseObservation(pendingResponse, finalResponse)) {
        throw new GitHubWorkflowError(
          'Stale discovery evidence or canonical root state changed during disposition',
          'STALE_DISCOVERY_EVIDENCE_CHANGED',
        );
      }
      dispositionForPendingResponse(active, finalResponse, staleDiscoveryDisposition.disposedAt);
      await assertMutationReady({ state: active, git }, finalLive);
      await assertCurrent(active);
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber: active.prNumber,
        expectedRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        staleDiscoveryDisposition,
      });
      return {
        stateRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        staleDiscoveryDisposition,
        actionable: true,
      };
    }
    const { plan } = buildCanonicalRootPlan(active, live);
    if (plan.length !== 0 || live.threads.some((thread) => thread.canonical)) {
      throw new GitHubWorkflowError('Canonical Codex roots exist; triage them before refreshing empty proof', 'TASKLESS_THREADS_NOT_EMPTY');
    }
    const threadResolutionStatus = {
      status: 'passed',
      headSha: active.currentIntegrationHeadSha,
      threads: [],
      threadlessVerification: active.threadResolutionStatus.threadlessVerification,
      ...(Object.hasOwn(active.threadResolutionStatus, 'localVerification') ? {
        localVerification: active.threadResolutionStatus.localVerification,
      } : {}),
      updatedAt: clock.now(),
    };
    if (pendingHeadDriftRecovery) {
      const finalLive = await readLiveSnapshot(client, active, {
        reactionsFor: active.reviewRequest.id,
      });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git, { includeUnmatchedRoots: true });
      if (!samePendingResponseObservation(pendingResponse, finalResponse)) {
        throw new GitHubWorkflowError(
          'Pending review evidence or canonical root state changed while refreshing proof',
          'STALE_DISCOVERY_EVIDENCE_CHANGED',
        );
      }
      if (active.reviewRequest.kind === 'discovery') {
        dispositionForPendingResponse(
          active,
          finalResponse,
          staleDiscoveryDisposition?.disposedAt ?? clock.now(),
        );
      }
      await assertMutationReady({ state: active, git }, finalLive);
      const { plan: finalPlan } = buildCanonicalRootPlan(active, finalLive);
      if (finalPlan.length !== 0 || finalLive.threads.some((thread) => thread.canonical)) {
        throw new GitHubWorkflowError(
          'Canonical Codex roots changed while refreshing empty proof',
          'TASKLESS_THREADS_NOT_EMPTY',
        );
      }
    } else {
      const finalLive = await readLiveSnapshot(client, active);
      await assertMutationReady({ state: active, git }, finalLive);
      const { plan: finalPlan } = buildCanonicalRootPlan(active, finalLive);
      if (finalPlan.length !== 0 || finalLive.threads.some((thread) => thread.canonical)) {
        throw new GitHubWorkflowError(
          'Canonical Codex roots changed while refreshing empty proof',
          'TASKLESS_THREADS_NOT_EMPTY',
        );
      }
    }
    await assertCurrent(active);
    if (pendingHeadDriftRecovery
        && active.threadResolutionStatus.status === 'passed'
        && active.threadResolutionStatus.headSha === active.currentIntegrationHeadSha
        && active.threadResolutionStatus.threads.length === 0) {
      if (staleDiscoveryDisposition !== null) {
        active = await stateAdapter.checkpointTaskCompletion({
          prNumber: active.prNumber,
          expectedRevision: active.revision,
          threadResolutionStatus: active.threadResolutionStatus,
          staleDiscoveryDisposition,
        });
      }
      return {
        stateRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
      };
    }
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber: active.prNumber,
      expectedRevision: active.revision,
      threadResolutionStatus,
      ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
    });
    return {
      stateRevision: active.revision,
      threadResolutionStatus: active.threadResolutionStatus,
      ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
    };
  }
  return refreshThreads;
}
