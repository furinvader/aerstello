import { GitHubWorkflowError } from '../errors.mjs';
import { executeMutation } from '../graphql/client.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { deterministicReply, exactRepliesFor, intentFor } from '../threads/replies.mjs';

function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

function assertThreadMutationType(type) {
  if (!['reply', 'resolve'].includes(type)) {
    throw new GitHubWorkflowError('Thread mutation type is invalid', 'JOURNAL_FAILED');
  }
}

export function threadOperationId(type, state, threadNodeId) {
  assertThreadMutationType(type);
  return `${type}:${state.prNumber}:${threadNodeId}:${state.currentIntegrationHeadSha}`;
}

export async function journalThreadMutationIntent(journal, type, operationId, at) {
  assertThreadMutationType(type);
  if (!journal?.ensureIntent) throw new GitHubWorkflowError('A durable intent journal is required', 'JOURNAL_REQUIRED');
  const intended = intentFor(type, operationId, at);
  const persisted = await journal.ensureIntent(intended);
  if (!persisted || persisted.type !== intended.type || persisted.operationId !== intended.operationId
      || persisted.clientMutationId !== intended.clientMutationId || !persisted.at) {
    throw new GitHubWorkflowError('Mutation intent journal did not persist correlation', 'JOURNAL_FAILED');
  }
  parsedTime(persisted.at, 'Mutation intent');
  return persisted;
}

export async function lookupThreadMutationIntent(journal, type, operationId) {
  assertThreadMutationType(type);
  if (!journal?.lookupIntent) throw new GitHubWorkflowError('A durable intent journal lookup is required', 'JOURNAL_REQUIRED');
  const intent = await journal.lookupIntent(operationId);
  const expected = intentFor(type, operationId, intent?.at);
  if (intent !== null && intent !== undefined && (intent.type !== type
      || intent.operationId !== operationId || intent.clientMutationId !== expected.clientMutationId)) {
    throw new GitHubWorkflowError('Mutation intent journal returned invalid correlation', 'JOURNAL_FAILED');
  }
  if (intent) parsedTime(intent.at, `${type === 'reply' ? 'Reply' : 'Resolve'} intent`);
  return intent ?? null;
}

export async function postThreadReply({
  client,
  journal,
  clock,
  state,
  git,
  entry,
  assertCurrent,
  readSnapshot = readLiveSnapshot,
  assertReady = assertMutationReady,
  execute = executeMutation,
}) {
  const operationId = threadOperationId('reply', state, entry.thread.id);
  const intent = await journalThreadMutationIntent(journal, 'reply', operationId, clock.now());
  let live = await readSnapshot(client, state);
  await assertReady({ state, git }, live);
  let current = live.threads.find((item) => item.id === entry.thread.id);
  let replies = exactRepliesFor(state, live, { ...entry, thread: current }).exact;
  if (replies.length === 0) {
    if (intent.isNew === false) {
      throw new GitHubWorkflowError('Prior reply intent has no unique live marker', 'REPLY_RECOVERY_MISSING');
    }
    await assertCurrent(state);
    await execute(client, 'AddThreadReply', {
      threadId: entry.thread.id, body: deterministicReply(state, entry, operationId),
      clientMutationId: intent.clientMutationId,
    }, 'addPullRequestReviewThreadReply');
    current = (await readSnapshot(client, state)).threads.find((item) => item.id === entry.thread.id);
    live = await readSnapshot(client, state);
    current = live.threads.find((item) => item.id === entry.thread.id);
    replies = exactRepliesFor(state, live, { ...entry, thread: current }).exact;
  }
  if (replies.length !== 1) throw new GitHubWorkflowError('Reply mutation was not uniquely proven live', 'REPLY_NOT_PROVEN');
  return { operationId, intent, live, thread: current, reply: replies[0] };
}

export async function resolveThread({
  client,
  journal,
  clock,
  state,
  git,
  entry,
  reply,
  assertCurrent,
  readSnapshot = readLiveSnapshot,
  assertReady = assertMutationReady,
  execute = executeMutation,
}) {
  let live = await readSnapshot(client, state);
  await assertReady({ state, git }, live);
  let current = live.threads.find((item) => item.id === entry.thread.id);
  let intent = null;
  if (!current.isResolved) {
    const operationId = threadOperationId('resolve', state, entry.thread.id);
    intent = await journalThreadMutationIntent(journal, 'resolve', operationId, clock.now());
    live = await readSnapshot(client, state);
    await assertReady({ state, git }, live);
    current = live.threads.find((item) => item.id === entry.thread.id);
    if (current?.isResolved) {
      return {
        operationId, intent, live, thread: current,
        evidence: { reply, resolvedAt: intent.at, resolvedBy: live.metadata.viewer.login },
      };
    }
    await assertCurrent(state);
    await execute(
      client,
      'ResolveThread',
      { threadId: entry.thread.id, clientMutationId: intent.clientMutationId },
      'resolveReviewThread',
    );
    current = (await readSnapshot(client, state)).threads.find((item) => item.id === entry.thread.id);
    if (!current?.isResolved) throw new GitHubWorkflowError('Resolve mutation was not proven live', 'RESOLVE_NOT_PROVEN');
  }
  return {
    operationId: threadOperationId('resolve', state, entry.thread.id),
    intent,
    live,
    thread: current,
    evidence: {
      reply,
      resolvedAt: intent?.at ?? clock.now(),
      resolvedBy: live.metadata.viewer.login,
    },
  };
}
