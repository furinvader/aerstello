import { createHash } from 'node:crypto';

import { GitHubWorkflowError } from '../errors.mjs';
import { isViewerActor } from '../evidence/actors.mjs';

export const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
export const AGGREGATE_REPLY_HEADER_PATTERN = /^Aerstello review resolution at ([0-9a-f]{40}(?:[0-9a-f]{24})?)\.\n/u;
const OPAQUE_LINE_SEPARATOR_PATTERN = /[\r\u2028\u2029]/u;

export function operationToken(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function intentFor(type, operationId, at) {
  return { type, operationId, clientMutationId: `aerstello-${operationToken(operationId)}`, at };
}

export function replyMarker(operationId) {
  return `<!-- aerstello-review:${operationToken(operationId)} -->`;
}

export function replyTaskLine(task) {
  return task.integratedCommitSha
    ? `- ${task.id}: ${task.integratedCommitSha}`
    : `- ${task.id}: ${task.disposition} — ${task.resolutionSummary ?? 'Disposition recorded and verified.'}`;
}

export function aggregateHistoricalReplyBody(body, {
  prNumber, threadNodeId, historicalHeadSha, historicalTaskId,
  historicalDisposition, historicalIntegratedCommitSha,
}) {
  if (typeof body !== 'string' || !FULL_GIT_SHA_PATTERN.test(historicalHeadSha)
      || typeof historicalTaskId !== 'string' || historicalTaskId.length === 0
      || /[\n\r\u2028\u2029]/u.test(historicalTaskId)
      || OPAQUE_LINE_SEPARATOR_PATTERN.test(body)) return null;
  const header = AGGREGATE_REPLY_HEADER_PATTERN.exec(body);
  if (header?.[1] !== historicalHeadSha) return null;
  const expectedMarker = replyMarker(`reply:${prNumber}:${threadNodeId}:${historicalHeadSha}`);
  const markerAnchors = [...body.matchAll(/<!-- aerstello-review:/gu)];
  const markers = [...body.matchAll(/<!-- aerstello-review:[0-9a-f]{24} -->/gu)]
    .map((match) => match[0]);
  const prefix = `${header[0]}Tasks:\n`;
  const validationSeparator = '\nValidation: ';
  const separatorIndex = body.indexOf(validationSeparator, prefix.length);
  if (!body.startsWith(prefix) || separatorIndex <= prefix.length
      || separatorIndex !== body.lastIndexOf(validationSeparator)
      || markerAnchors.length !== 1
      || markers.length !== 1 || markers[0] !== expectedMarker) return null;
  const taskContent = body.slice(prefix.length, separatorIndex);
  const stableTaskMatches = historicalDisposition === 'fixed'
    ? FULL_GIT_SHA_PATTERN.test(historicalIntegratedCommitSha ?? '')
      && taskContent === `- ${historicalTaskId}: ${historicalIntegratedCommitSha}`
    : historicalDisposition === 'already-fixed'
      && historicalIntegratedCommitSha === null
      && taskContent.startsWith(`- ${historicalTaskId}: already-fixed — `)
      && taskContent.length > `- ${historicalTaskId}: already-fixed — `.length;
  const markerSuffix = `\n${expectedMarker}`;
  const validationAndMarker = body.slice(separatorIndex + 1);
  if (!stableTaskMatches || !validationAndMarker.endsWith(markerSuffix)) return null;
  const validationLine = validationAndMarker.slice(0, -markerSuffix.length);
  if (!/^Validation: [^\n\r\u2028\u2029]+\.$/u.test(validationLine)) return null;
  return { historicalHeadSha: header[1], expectedMarker };
}

export function aggregateHistoricalReplyBodyIsAdmissible(body, options) {
  return aggregateHistoricalReplyBody(body, options) !== null;
}

export function deterministicReply(state, entry, operationId) {
  const checks = state.validationStatus.checks.slice(0, 3).join(', ');
  const tasks = entry.tasks.slice().sort((left, right) => left.id.localeCompare(right.id));
  return [
    `Aerstello review resolution at ${state.currentIntegrationHeadSha}.`,
    'Tasks:',
    ...tasks.map(replyTaskLine),
    `Validation: ${checks}.`,
    replyMarker(operationId),
  ].join('\n');
}

export function exactRepliesFor(state, live, entry) {
  const operationId = `reply:${state.prNumber}:${entry.thread.id}:${state.currentIntegrationHeadSha}`;
  const body = deterministicReply(state, entry, operationId);
  const marker = replyMarker(operationId);
  const markerPattern = /<!-- aerstello-review:[0-9a-f]{24} -->/u;
  const replies = entry.thread.comments.filter((comment) => comment.replyTo?.id === entry.thread.root.id);
  for (const reply of replies.filter((comment) => markerPattern.test(comment.body ?? ''))) {
    if (!reply.body.includes(marker)) throw new GitHubWorkflowError('Prior-head idempotency reply is present', 'REPLY_AMBIGUOUS');
    if (reply.body !== body) throw new GitHubWorkflowError('Current reply marker has altered content', 'REPLY_AMBIGUOUS');
    if (!isViewerActor(reply.author, live.metadata.viewer)) {
      throw new GitHubWorkflowError('Current reply was authored by a foreign viewer', 'REPLY_AMBIGUOUS');
    }
  }
  const exact = replies.filter((reply) => reply.body === body
    && isViewerActor(reply.author, live.metadata.viewer));
  if (exact.length > 1) throw new GitHubWorkflowError('Existing idempotency reply is ambiguous', 'REPLY_AMBIGUOUS');
  return { body, exact };
}
