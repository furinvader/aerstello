import { GitHubWorkflowError } from '../errors.mjs';
import { isViewerActor } from '../evidence/actors.mjs';
import { lookupThreadMutationIntent } from '../mutations/thread-reply-resolve.mjs';
import {
  AGGREGATE_REPLY_HEADER_PATTERN,
  replyMarker,
  replyTaskLine,
} from './replies.mjs';

function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

function evidenceAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request');
}

export function completedThreadlessRecoveryReady(state) {
  const aggregate = state.threadResolutionStatus;
  const verification = aggregate.threadlessVerification;
  if (aggregate.status !== 'not-run' || aggregate.headSha !== null || aggregate.updatedAt !== null
      || verification.status !== 'passed' || verification.headSha !== state.currentIntegrationHeadSha
      || verification.taskIds.length === 0) return false;
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  return verification.taskIds.every((taskId) => {
    const task = byId.get(taskId);
    return task?.sourceType === 'github-threadless' && task.status === 'completed';
  });
}

export function priorHeadRecoveryCandidate(state, live, entry, selectedTask) {
  if (!completedThreadlessRecoveryReady(state) || !entry.thread.isResolved
      || selectedTask?.sourceType !== 'github-thread'
      || !entry.tasks.some((task) => task.id === selectedTask.id)
      || !selectedTask.integratedCommitSha) return null;

  const directReplies = entry.thread.comments.filter((comment) => comment.replyTo?.id === entry.thread.root.id);
  const markerPattern = /<!-- aerstello-review:[0-9a-f]{24} -->/u;
  const markedReplies = directReplies.filter((comment) => markerPattern.test(comment.body ?? ''));
  const priorCandidates = markedReplies.map((reply) => ({
    reply,
    priorHeadSha: AGGREGATE_REPLY_HEADER_PATTERN.exec(reply.body ?? '')?.[1] ?? null,
  })).filter((candidate) => candidate.priorHeadSha !== null
    && candidate.priorHeadSha !== state.currentIntegrationHeadSha);
  if (priorCandidates.length === 0) return null;
  if (directReplies.length !== 1 || markedReplies.length !== 1 || priorCandidates.length !== 1) {
    throw new GitHubWorkflowError('Prior-head recovery reply is not unique', 'REPLY_AMBIGUOUS');
  }

  const { reply, priorHeadSha } = priorCandidates[0];
  if (!state.tasks.some((task) => task.integratedCommitSha === priorHeadSha)) {
    throw new GitHubWorkflowError('Prior-head recovery is not bound to durable integration state', 'REPLY_AMBIGUOUS');
  }
  const replyOperationId = `reply:${state.prNumber}:${entry.thread.id}:${priorHeadSha}`;
  const expectedMarker = replyMarker(replyOperationId);
  const lines = String(reply.body ?? '').split('\n');
  const taskLines = entry.tasks.slice().sort((left, right) => left.id.localeCompare(right.id)).map(replyTaskLine);
  const expectedPrefix = [`Aerstello review resolution at ${priorHeadSha}.`, 'Tasks:', ...taskLines];
  const markers = [...String(reply.body ?? '').matchAll(/<!-- aerstello-review:[0-9a-f]{24} -->/gu)]
    .map((match) => match[0]);
  const prefixMatches = expectedPrefix.every((line, index) => lines[index] === line);
  const validationLine = lines.at(-2) ?? '';
  if (!prefixMatches || lines.length !== expectedPrefix.length + 2
      || !/^Validation: .+\.$/u.test(validationLine)
      || markers.length !== 1 || markers[0] !== expectedMarker || lines.at(-1) !== expectedMarker
      || !isViewerActor(reply.author, live.metadata.viewer)
      || reply.replyTo?.id !== entry.thread.root.id
      || typeof reply.id !== 'string' || reply.id.length === 0
      || typeof reply.url !== 'string' || reply.url.length === 0) {
    throw new GitHubWorkflowError('Prior-head recovery reply lost immutable evidence', 'REPLY_AMBIGUOUS');
  }
  parsedTime(reply.createdAt, 'Prior-head reply');
  return {
    priorHeadSha,
    replyOperationId,
    resolveOperationId: `resolve:${state.prNumber}:${entry.thread.id}:${priorHeadSha}`,
    reply,
    selectedTaskId: selectedTask.id,
  };
}

export function assertPriorHeadRecoveryLive(state, live, entry, recovery) {
  const selectedTask = state.tasks.find((task) => task.id === recovery.selectedTaskId);
  const candidate = priorHeadRecoveryCandidate(state, live, entry, selectedTask);
  if (!candidate || candidate.priorHeadSha !== recovery.priorHeadSha
      || candidate.reply.id !== recovery.reply.id || candidate.reply.url !== recovery.reply.url
      || candidate.reply.body !== recovery.reply.body || candidate.reply.createdAt !== recovery.reply.createdAt) {
    throw new GitHubWorkflowError('Prior-head recovery evidence changed after preflight', 'THREAD_PROOF_STALE');
  }
  return candidate.reply;
}

export async function journaledPriorHeadRecovery(state, live, entry, selectedTask, journal, git) {
  const candidate = priorHeadRecoveryCandidate(state, live, entry, selectedTask);
  if (!candidate) return null;
  if (!(await git.isAncestor(
    candidate.priorHeadSha, state.currentIntegrationHeadSha, state.integrationWorktree,
  ))) {
    throw new GitHubWorkflowError('Prior-head recovery commit is not an integration ancestor', 'MUTATION_NOT_READY');
  }
  const replyIntent = await lookupThreadMutationIntent(journal, 'reply', candidate.replyOperationId);
  const resolveIntent = await lookupThreadMutationIntent(journal, 'resolve', candidate.resolveOperationId);
  if (!replyIntent || !resolveIntent
      || !evidenceAtOrAfter(candidate.reply.createdAt, replyIntent.at)
      || !evidenceAtOrAfter(resolveIntent.at, replyIntent.at)) {
    throw new GitHubWorkflowError(
      'Prior-head resolved thread lacks its matching journaled reply and resolve pair',
      'RESOLUTION_PROOF_MISSING',
    );
  }
  return { ...candidate, replyIntent, resolveIntent };
}
