import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { GitHubWorkflowError } from '../errors.mjs';
import { isCanonicalActor, isViewerActor } from '../evidence/actors.mjs';
import { httpsUrl } from '../evidence/primitives.mjs';
import { canonicalJson } from '../evidence/review-response.mjs';
import { MAX_NODES } from '../graphql/client.mjs';
import {
  aggregateHistoricalReplyBodyIsAdmissible,
  deterministicReply,
  intentFor,
} from '../threads/replies.mjs';

export function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

export function hasExactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

export function assertArchiveEventList(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_NODES
      || events.some((event) => event === null || typeof event !== 'object' || Array.isArray(event))) {
    throw new GitHubWorkflowError('Archived mutation evidence is missing or malformed', 'ARCHIVE_EVIDENCE_INVALID');
  }
}

export function assertTerminalArchive(state, events) {
  const stateUpdatedAt = parsedTime(state.updatedAt, 'Archived state');
  if (state.phase === 'complete' && state.abandonmentReason === null) {
    return { stateUpdatedAt, terminalEventAt: null };
  }
  if (typeof state.abandonmentReason !== 'string' || state.abandonmentReason.trim().length === 0) {
    throw new GitHubWorkflowError('Archive lacks terminal completion or abandonment evidence', 'ARCHIVE_EVIDENCE_INVALID');
  }
  const terminal = events.filter((event) => event.type === 'abandoned');
  const event = terminal[0];
  if (terminal.length !== 1 || events.at(-1) !== event
      || !hasExactKeys(event, ['schemaVersion', 'type', 'summary', 'at'])
      || event.schemaVersion !== 1
      || event.summary !== `Archived without completion: ${state.abandonmentReason}`
      || parsedTime(event.at, 'Archive terminal event') < stateUpdatedAt) {
    throw new GitHubWorkflowError('Archive terminal evidence is missing, altered, or ambiguous', 'ARCHIVE_EVIDENCE_INVALID');
  }
  return { stateUpdatedAt, terminalEventAt: parsedTime(event.at, 'Archive terminal event') };
}

export function projectedArchivedTask(archivedTask) {
  return { ...archivedTask, status: 'not-applicable' };
}

export function archiveBatchProofProjection(state, selectedTask, archivedState) {
  const sourceThreadIds = selectedTask.sourceIds.map((source) => (
    /^thread:(.+)$/u.exec(source)?.[1] ?? null
  ));
  if (sourceThreadIds.some((threadId) => threadId === null)
      || new Set(sourceThreadIds).size !== sourceThreadIds.length) {
    throw new GitHubWorkflowError(
      'Archive batch requires one unique explicit thread source per root',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const archivedProofs = archivedState.threadResolutionStatus.threads.filter((proof) => (
    proof.taskIds.includes(selectedTask.id)
  ));
  if (archivedProofs.length !== sourceThreadIds.length
      || archivedProofs.some((proof) => proof.taskIds.length !== 1
        || proof.taskIds[0] !== selectedTask.id || proof.isResolved !== true
        || proof.disposition !== selectedTask.disposition
        || proof.replyId === null || proof.replyUrl === null
        || proof.resolvedAt === null || proof.resolvedBy === null)) {
    throw new GitHubWorkflowError('Archived resolved-root proof is incomplete or ambiguous', 'ARCHIVE_PROOF_MISMATCH');
  }
  const proofRows = sourceThreadIds.slice().sort().map((threadId) => {
    const proofs = archivedProofs.filter((proof) => proof.threadNodeId === threadId);
    if (proofs.length !== 1) {
      throw new GitHubWorkflowError('Archived source root is missing or duplicated', 'ARCHIVE_PROOF_MISMATCH');
    }
    return structuredClone(proofs[0]);
  });
  const historicalHeads = new Set(proofRows.map((proof) => proof.observedHeadSha));
  if (historicalHeads.size !== 1) {
    throw new GitHubWorkflowError('Archived roots do not share one historical HEAD', 'ARCHIVE_PROOF_MISMATCH');
  }
  const historicalHeadSha = [...historicalHeads][0];
  if (historicalHeadSha === state.currentIntegrationHeadSha) {
    throw new GitHubWorkflowError('Archive adoption requires a distinct historical HEAD', 'ARCHIVE_PROOF_MISMATCH');
  }
  return {
    task: structuredClone(selectedTask),
    proofRows,
    historicalHeadSha,
  };
}

export function archiveContentFingerprint(archive) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(archive)))
    .digest('hex');
}

export function assertArchiveInventory(archives) {
  if (!Array.isArray(archives) || archives.length > MAX_NODES) {
    throw new GitHubWorkflowError('Immutable archive inventory is malformed or unbounded', 'ARCHIVE_EVIDENCE_INVALID');
  }
  const archiveIds = archives.map((archive) => archive?.archiveId);
  if (archiveIds.some((archiveId) => typeof archiveId !== 'string' || archiveId.length === 0)
      || new Set(archiveIds).size !== archiveIds.length) {
    throw new GitHubWorkflowError('Immutable archive identity is missing or duplicated', 'ARCHIVE_EVIDENCE_AMBIGUOUS');
  }
}

export function archiveIntent(events, type, operationId) {
  const expectedClientMutationId = intentFor(type, operationId, null).clientMutationId;
  const candidates = events.filter((event) => event.details?.operationId === operationId
    || event.details?.clientMutationId === expectedClientMutationId);
  if (candidates.length !== 1) {
    throw new GitHubWorkflowError(
      `Archived ${type} intent is missing, duplicated, or ambiguous`,
      'ARCHIVE_INTENT_AMBIGUOUS',
    );
  }
  const event = candidates[0];
  const intent = event.details;
  if (!hasExactKeys(event, ['schemaVersion', 'type', 'summary', 'at', 'details'])
      || !hasExactKeys(intent, ['type', 'operationId', 'clientMutationId', 'at'])
      || event.schemaVersion !== 1 || event.type !== 'github-mutation-intent'
      || event.summary !== `Intent ${type} ${operationId}`
      || !isDeepStrictEqual(intent, intentFor(type, operationId, intent?.at))
      || parsedTime(event.at, `Archived ${type} event`) < parsedTime(intent?.at, `Archived ${type} intent`)) {
    throw new GitHubWorkflowError(`Archived ${type} intent lost exact correlation`, 'ARCHIVE_INTENT_INVALID');
  }
  return { event, intent };
}

export function assertArchiveReplyBody(
  archivedState, archivedTask, threadId, historicalHeadSha, body,
  { aggregateOrigin = false } = {},
) {
  if (typeof body !== 'string') {
    throw new GitHubWorkflowError('Archived live reply body is missing', 'ARCHIVE_REPLY_MISMATCH');
  }
  const operationId = `reply:${archivedTask.prNumber ?? ''}:${threadId}:${historicalHeadSha}`;
  if (aggregateOrigin) {
    const historicalDisposition = archivedTask.disposition === 'actionable' ? 'fixed'
      : archivedTask.disposition === 'already-fixed' ? 'already-fixed' : null;
    if (!aggregateHistoricalReplyBodyIsAdmissible(body, {
      prNumber: archivedTask.prNumber,
      threadNodeId: threadId,
      historicalHeadSha,
      historicalTaskId: archivedTask.id,
      historicalDisposition,
      historicalIntegratedCommitSha: archivedTask.integratedCommitSha,
    })) {
      throw new GitHubWorkflowError(
        'Historical aggregate reply has ambiguous stable task or marker structure',
        'ARCHIVE_REPLY_MISMATCH',
      );
    }
    return operationId;
  }
  const expectedBody = deterministicReply(
    { ...archivedState, currentIntegrationHeadSha: historicalHeadSha },
    { tasks: [archivedTask] },
    operationId,
  );
  if (body !== expectedBody) {
    throw new GitHubWorkflowError('Archived live reply body or marker is altered', 'ARCHIVE_REPLY_MISMATCH');
  }
  return operationId;
}

export function stableCommentEvidence(comment) {
  return {
    id: comment.id,
    databaseId: comment.databaseId ?? null,
    url: comment.url,
    body: comment.body,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
    author: {
      type: comment.author?.__typename ?? null,
      login: comment.author?.login ?? null,
      url: comment.author?.url ?? null,
      id: comment.author?.id ?? null,
    },
    replyToId: comment.replyTo?.id ?? null,
    pullRequestReviewId: comment.pullRequestReview?.id ?? null,
  };
}

export function validateArchiveBatchLive(
  state, live, selectedTask, selectedPlan, selectedArchive,
  { aggregateOrigin = false } = {},
) {
  const {
    archivedState, archivedTask, archive, terminalBounds, projection,
  } = selectedArchive;
  if (!isDeepStrictEqual(projection.task, selectedTask)
      || projection.proofRows.length !== selectedPlan.length) {
    throw new GitHubWorkflowError(
      'Archive batch requires one unique explicit thread source per root',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const historicalHeadSha = projection.historicalHeadSha;
  const evidence = [];
  for (const proof of projection.proofRows) {
    const threadId = proof.threadNodeId;
    const entries = selectedPlan.filter((entry) => entry.thread.id === threadId);
    if (entries.length !== 1) {
      throw new GitHubWorkflowError('Archived source root is missing or duplicated', 'ARCHIVE_PROOF_MISMATCH');
    }
    const entry = entries[0];
    const { thread } = entry;
    const root = thread.root;
    const directReplies = thread.comments.filter((comment) => comment.replyTo?.id === root.id);
    if (!thread.isResolved || thread.comments.length !== 2 || directReplies.length !== 1
        || proof.rootCommentNodeId !== root.id
        || proof.rootCommentDatabaseId !== root.databaseId
        || root.lastEditedAt !== null || !httpsUrl(root.url) || typeof root.body !== 'string'
        || !isCanonicalActor(root.author)) {
      throw new GitHubWorkflowError('Live archived root or root comment does not match proof', 'ARCHIVE_LIVE_MISMATCH');
    }
    const reply = directReplies[0];
    if (reply.id !== proof.replyId || reply.url !== proof.replyUrl
        || reply.replyTo?.id !== root.id || reply.lastEditedAt !== null
        || !httpsUrl(reply.url) || !isViewerActor(reply.author, live.metadata.viewer)
        || proof.resolvedBy !== live.metadata.viewer.login) {
      throw new GitHubWorkflowError('Live archived reply identity does not match proof', 'ARCHIVE_LIVE_MISMATCH');
    }
    const replyOperationId = assertArchiveReplyBody(
      archivedState, { ...archivedTask, prNumber: state.prNumber },
      thread.id, historicalHeadSha, reply.body, { aggregateOrigin },
    );
    const resolveOperationId = `resolve:${state.prNumber}:${thread.id}:${historicalHeadSha}`;
    const replyIntent = archiveIntent(archive.events, 'reply', replyOperationId);
    const resolveIntent = archiveIntent(archive.events, 'resolve', resolveOperationId);
    const rootAt = parsedTime(root.createdAt, 'Archived root creation');
    const replyAt = parsedTime(reply.createdAt, 'Archived reply creation');
    const replyIntentAt = parsedTime(replyIntent.intent.at, 'Archived reply intent');
    const resolveIntentAt = parsedTime(resolveIntent.intent.at, 'Archived resolve intent');
    const replyIntentEventAt = parsedTime(replyIntent.event.at, 'Archived reply intent event');
    const resolveIntentEventAt = parsedTime(resolveIntent.event.at, 'Archived resolve intent event');
    const proofResolvedAt = parsedTime(proof.resolvedAt, 'Archived durable resolution proof');
    // GitHub returns reply.createdAt at second precision. archiveIntent already
    // proves intent.at <= event.at, so this represented second supplies only an
    // exclusive upper bound for both values, not an exact mutation instant.
    const replyRepresentedSecondExclusiveUpperBound = (Math.floor(replyAt / 1_000) * 1_000) + 1_000;
    // Recovery deliberately records intent.at as resolvedAt; appendEvent timestamps
    // its enclosing journal record moments later. A later proof is instead a
    // post-mutation observation and must follow that persisted journal record.
    const proofUsesResolveIntentTime = proofResolvedAt === resolveIntentAt;
    if (replyIntentAt < rootAt
        || replyIntentEventAt >= replyRepresentedSecondExclusiveUpperBound
        || replyIntentEventAt > resolveIntentAt
        || resolveIntentAt < replyAt
        || proofResolvedAt < resolveIntentAt
        || (!proofUsesResolveIntentTime && resolveIntentEventAt > proofResolvedAt)
        || replyIntentEventAt > terminalBounds.stateUpdatedAt
        || resolveIntentEventAt > terminalBounds.stateUpdatedAt
        || proofResolvedAt > terminalBounds.stateUpdatedAt
        || (terminalBounds.terminalEventAt !== null
          && (replyIntentEventAt > terminalBounds.terminalEventAt
            || resolveIntentEventAt > terminalBounds.terminalEventAt
            || proofResolvedAt > terminalBounds.terminalEventAt))) {
      throw new GitHubWorkflowError('Archived reply and resolution timestamps do not correlate', 'ARCHIVE_INTENT_INVALID');
    }
    evidence.push({
      threadNodeId: thread.id,
      proof: { ...proof },
      reply: { ...reply },
      intents: {
        reply: structuredClone(replyIntent),
        resolve: structuredClone(resolveIntent),
      },
      live: {
        threadNodeId: thread.id,
        isResolved: thread.isResolved,
        root: stableCommentEvidence(root),
        reply: stableCommentEvidence(reply),
      },
    });
  }
  return {
    archiveId: archive.archiveId,
    archive: structuredClone(archive),
    historicalHeadSha,
    evidence,
  };
}
