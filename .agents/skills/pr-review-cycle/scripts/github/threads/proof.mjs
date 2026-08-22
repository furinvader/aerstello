import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { GitHubWorkflowError } from '../errors.mjs';
import { isViewerActor } from '../evidence/actors.mjs';
import { buildCanonicalRootPlan, dispositionForTask } from './canonical-roots.mjs';
import {
  AGGREGATE_REPLY_HEADER_PATTERN,
  FULL_GIT_SHA_PATTERN,
  aggregateHistoricalReplyBodyIsAdmissible,
  exactRepliesFor,
  replyMarker,
} from './replies.mjs';
import { assertPriorHeadRecoveryLive } from './recovery.mjs';

function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

export function assertRecordedReply(state, live, entry, proof) {
  const replies = entry.thread.comments.filter((comment) => comment.id === proof.replyId);
  if (replies.length !== 1) throw new GitHubWorkflowError('Historical reply ID is not uniquely live', 'THREAD_PROOF_STALE');
  const reply = replies[0];
  const header = AGGREGATE_REPLY_HEADER_PATTERN.exec(reply.body ?? '');
  const replyHeadSha = header?.[1] ?? null;
  const operationId = replyHeadSha ? `reply:${state.prNumber}:${entry.thread.id}:${replyHeadSha}` : null;
  const markers = [...String(reply.body ?? '').matchAll(/<!-- aerstello-review:[0-9a-f]{24} -->/gu)].map((match) => match[0]);
  const provenance = proof.archiveProvenance;
  const authorMatches = proof.isResolved
    ? provenance
      ? isViewerActor(reply.author, live.metadata.viewer) && reply.author.login === proof.resolvedBy
      : reply.author?.login === proof.resolvedBy
    : isViewerActor(reply.author, live.metadata.viewer);
  if (proof.isResolved && reply.author?.login === proof.resolvedBy && !reply.author?.id) {
    throw new GitHubWorkflowError('Recorded reply actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  if (reply.url !== proof.replyUrl || reply.replyTo?.id !== entry.thread.root.id
      || !authorMatches || !replyHeadSha || markers.length !== 1
      || (!provenance && !proof.isResolved && replyHeadSha !== state.currentIntegrationHeadSha)
      || markers[0] !== replyMarker(operationId)) {
    throw new GitHubWorkflowError('Historical reply identity or immutable anchor is stale', 'THREAD_PROOF_STALE');
  }
  if (provenance) {
    const fields = [
      'schemaVersion', 'historicalTaskId', 'historicalDisposition',
      'historicalIntegratedCommitSha', 'replyBodySha256', 'authorityFingerprint',
    ];
    const bodyHash = createHash('sha256').update(String(reply.body ?? ''), 'utf8').digest('hex');
    if (!hasExactKeys(provenance, fields)
        || provenance.schemaVersion !== 1
        || typeof provenance.historicalTaskId !== 'string' || provenance.historicalTaskId.length === 0
        || !['fixed', 'already-fixed'].includes(provenance.historicalDisposition)
        || (provenance.historicalDisposition === 'fixed'
          && !FULL_GIT_SHA_PATTERN.test(provenance.historicalIntegratedCommitSha ?? ''))
        || (provenance.historicalDisposition === 'already-fixed'
          && provenance.historicalIntegratedCommitSha !== null)
        || !/^[0-9a-f]{64}$/u.test(provenance.replyBodySha256 ?? '')
        || !/^[0-9a-f]{64}$/u.test(provenance.authorityFingerprint ?? '')
        || reply.lastEditedAt !== null || replyHeadSha !== proof.observedHeadSha
        || bodyHash !== provenance.replyBodySha256
        || !aggregateHistoricalReplyBodyIsAdmissible(reply.body, {
          prNumber: state.prNumber,
          threadNodeId: entry.thread.id,
          historicalHeadSha: proof.observedHeadSha,
          historicalTaskId: provenance.historicalTaskId,
          historicalDisposition: provenance.historicalDisposition,
          historicalIntegratedCommitSha: provenance.historicalIntegratedCommitSha,
        })) {
      throw new GitHubWorkflowError(
        'Historical aggregate reply or archive provenance is stale',
        'THREAD_PROOF_STALE',
      );
    }
    return reply;
  }
  for (const task of entry.tasks) {
    const stableLine = task.integratedCommitSha
      ? `- ${task.id}: ${task.integratedCommitSha}` : `- ${task.id}: ${task.disposition} —`;
    if (!reply.body.includes(stableLine)) {
      throw new GitHubWorkflowError(`Historical reply lost stable task evidence for ${task.id}`, 'THREAD_PROOF_STALE');
    }
  }
  return reply;
}

export function assertExistingThreadProof(state, live, entry, proof) {
  const taskIds = entry.tasks.map((task) => task.id).sort();
  const proofTaskIds = proof.taskIds.slice().sort();
  if (proof.rootCommentNodeId !== entry.thread.root.id
      || proof.rootCommentDatabaseId !== entry.thread.root.databaseId
      || taskIds.length !== proofTaskIds.length
      || taskIds.some((taskId, index) => taskId !== proofTaskIds[index])
      || proof.disposition !== dispositionForTask(entry.tasks[0])
      || (proof.isResolved && !entry.thread.isResolved)
      || ((proof.replyId === null) !== (proof.replyUrl === null))) {
    throw new GitHubWorkflowError(`Thread ${entry.thread.id} immutable proof does not match the live plan`, 'THREAD_PROOF_STALE');
  }
  return proof.replyId === null ? null : assertRecordedReply(state, live, entry, proof);
}

export function assertLiveThreadProof(state, live) {
  const { plan } = buildCanonicalRootPlan(state, live);
  const canonical = live.threads.filter((thread) => thread.canonical);
  const recorded = new Map(state.threadResolutionStatus.threads.map((thread) => [thread.threadNodeId, thread]));
  if (canonical.length !== recorded.size) {
    throw new GitHubWorkflowError('Live canonical threads do not match durable thread proof', 'THREAD_PROOF_STALE');
  }
  for (const entry of plan) {
    const thread = entry.thread;
    const proof = recorded.get(thread.id);
    if (!proof || proof.isResolved !== thread.isResolved) {
      throw new GitHubWorkflowError(`Thread ${thread.id} identity or resolution differs from durable proof`, 'THREAD_PROOF_STALE');
    }
    assertExistingThreadProof(state, live, entry, proof);
  }
}

export function assertRecordedThreadsLive(state, live) {
  const { plan } = buildCanonicalRootPlan(state, live);
  const liveByThread = new Map(plan.map((entry) => [entry.thread.id, entry]));
  for (const proof of state.threadResolutionStatus.threads) {
    const entry = liveByThread.get(proof.threadNodeId);
    if (!entry || proof.isResolved !== entry.thread.isResolved) {
      throw new GitHubWorkflowError(
        `Recorded thread ${proof.threadNodeId} identity or resolution differs from live evidence`,
        'THREAD_PROOF_STALE',
      );
    }
    assertExistingThreadProof(state, live, entry, proof);
  }
}

export function buildThreadProof(state, live, resolvedEvidence, at) {
  const { plan: mapped } = buildCanonicalRootPlan(state, live);
  const previous = new Map(state.threadResolutionStatus.threads.map((thread) => [thread.threadNodeId, thread]));
  const threads = mapped.map(({ thread, tasks }) => {
    const old = previous.get(thread.id);
    const fresh = resolvedEvidence.get(thread.id);
    const entry = { thread, tasks };
    const recordedReply = old ? assertExistingThreadProof(state, live, entry, old) : null;
    if (old?.isResolved) {
      return { ...old };
    }
    const exact = recordedReply ? [recordedReply]
      : fresh?.priorHeadRecovery
        ? [assertPriorHeadRecoveryLive(state, live, entry, fresh.priorHeadRecovery)]
        : fresh?.archiveAdoption ? [fresh.reply]
          : exactRepliesFor(state, live, entry).exact;
    const reply = recordedReply ?? fresh?.reply ?? exact[0] ?? null;
    if (thread.isResolved && (!fresh || exact.length !== 1)) {
      throw new GitHubWorkflowError(`Thread ${thread.id} exact reply is not live`, 'THREAD_PROOF_STALE');
    }
    if (thread.isResolved && !old && !fresh) {
      throw new GitHubWorkflowError(`Resolved thread ${thread.id} lacks durable resolution evidence`, 'RESOLUTION_PROOF_MISSING');
    }
    const updated = {
      threadNodeId: thread.id,
      rootCommentNodeId: thread.root.id,
      rootCommentDatabaseId: thread.root.databaseId,
      taskIds: tasks.map((task) => task.id).sort(),
      disposition: dispositionForTask(tasks[0]),
      replyId: old?.replyId ?? reply?.id ?? null,
      replyUrl: old?.replyUrl ?? reply?.url ?? null,
      isResolved: thread.isResolved,
      resolvedAt: thread.isResolved ? old?.resolvedAt ?? fresh?.resolvedAt ?? null : null,
      resolvedBy: thread.isResolved ? old?.resolvedBy ?? fresh?.resolvedBy ?? null : null,
      observedHeadSha: old?.observedHeadSha ?? fresh?.observedHeadSha ?? state.currentIntegrationHeadSha,
      ...(fresh?.archiveProvenance ? {
        archiveProvenance: structuredClone(fresh.archiveProvenance),
      } : {}),
    };
    return old ? {
      ...old,
      replyId: old.replyId ?? updated.replyId,
      replyUrl: old.replyUrl ?? updated.replyUrl,
      isResolved: updated.isResolved,
      resolvedAt: updated.resolvedAt,
      resolvedBy: updated.resolvedBy,
    } : updated;
  });
  return {
    status: threads.every((thread) => thread.isResolved) ? 'passed' : 'failed',
    headSha: state.currentIntegrationHeadSha,
    threads,
    threadlessVerification: state.threadResolutionStatus.threadlessVerification,
    ...(Object.hasOwn(state.threadResolutionStatus, 'localVerification') ? {
      localVerification: state.threadResolutionStatus.localVerification,
    } : {}),
    updatedAt: at,
  };
}
