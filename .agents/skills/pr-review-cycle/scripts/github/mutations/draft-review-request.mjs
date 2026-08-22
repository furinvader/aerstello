import { reviewRequestGate } from '../../contracts/contracts.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import { actorObservation, isViewerActor } from '../evidence/actors.mjs';
import { MAX_NODES, executeMutation } from '../graphql/client.mjs';
import { assertMutationReady, assertPullRequestReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { assertLiveThreadProof } from '../threads/proof.mjs';
import { intentFor } from '../threads/replies.mjs';

export const REQUEST_BODY = '@codex review';

export function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

export function requestRecoveryAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request') - 1_000;
}

export function sameTimestamp(left, right) {
  return parsedTime(left, 'Live evidence') === parsedTime(right, 'Recorded evidence');
}

export function exactViewerRequestCandidates(comments, viewer, intent, excludedIds = new Set()) {
  return comments.filter((comment) => comment.body === REQUEST_BODY
    && comment.lastEditedAt === null
    && !excludedIds.has(comment.id)
    && isViewerActor(comment.author, viewer)
    && requestRecoveryAtOrAfter(comment.createdAt, intent.at));
}

export async function journalRequestIntent(journal, intent) {
  if (!journal?.ensureIntent) throw new GitHubWorkflowError('A durable intent journal is required', 'JOURNAL_REQUIRED');
  const persisted = await journal.ensureIntent(intent);
  if (!persisted || persisted.type !== intent.type || persisted.operationId !== intent.operationId
      || persisted.clientMutationId !== intent.clientMutationId || !persisted.at) {
    throw new GitHubWorkflowError('Mutation intent journal did not persist correlation', 'JOURNAL_FAILED');
  }
  parsedTime(persisted.at, 'Mutation intent');
  const ids = persisted.excludedCommentIds;
  if (intent.type === 'request' && (!Array.isArray(ids) || ids.length > MAX_NODES
      || ids.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(ids).size !== ids.length)) {
    throw new GitHubWorkflowError('Request intent has an invalid comment baseline', 'JOURNAL_FAILED');
  }
  return persisted;
}

export async function lookupOptionalMutationJournalIntent(journal, type, operationId) {
  if (!journal?.lookupIntent) throw new GitHubWorkflowError('A durable intent journal lookup is required', 'JOURNAL_REQUIRED');
  const candidate = await journal.lookupIntent(operationId);
  if (!candidate || candidate.operationId !== operationId) return null;
  return lookupMutationJournalIntent(journal, type, operationId);
}

async function lookupMutationJournalIntent(journal, type, operationId) {
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

export async function lookupRequestJournalIntent(journal, operationId) {
  if (!journal?.lookupIntent) throw new GitHubWorkflowError('A durable intent journal lookup is required', 'JOURNAL_REQUIRED');
  const intent = await journal.lookupIntent(operationId);
  if (intent === null || intent === undefined) return null;
  const expected = intentFor('request', operationId, intent.at);
  if (intent.type !== 'request' || intent.operationId !== operationId
      || intent.clientMutationId !== expected.clientMutationId || !intent.at) {
    throw new GitHubWorkflowError('Mutation intent journal returned invalid correlation', 'JOURNAL_FAILED');
  }
  parsedTime(intent.at, 'Request intent');
  const ids = intent.excludedCommentIds;
  if (!Array.isArray(ids) || ids.length > MAX_NODES
      || ids.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(ids).size !== ids.length) {
    throw new GitHubWorkflowError('Request intent has an invalid comment baseline', 'JOURNAL_FAILED');
  }
  return { ...intent, isNew: false };
}

export function assertRecordedRequestComment(state, live) {
  const request = state.reviewRequest;
  if (!request) throw new GitHubWorkflowError('Review request is missing', 'REVIEW_NOT_PENDING');
  const matches = live.comments.filter((comment) => comment.id === request.id);
  if (matches.length !== 1) throw new GitHubWorkflowError('Recorded request comment is missing or duplicated', 'REQUEST_PROOF_STALE');
  const comment = matches[0];
  if (comment.body !== request.body || comment.url !== request.url
      || (comment.databaseId ?? null) !== request.databaseId
      || comment.lastEditedAt !== null
      || comment.author?.login !== request.authorLogin || comment.author?.id !== request.authorNodeId
      || !isViewerActor(comment.author, live.metadata.viewer)
      || !sameTimestamp(comment.createdAt, request.at)) {
    throw new GitHubWorkflowError('Recorded request comment differs from live evidence', 'REQUEST_PROOF_STALE');
  }
  return comment;
}

export function requestAnchorObservation(live, requestId) {
  const comment = live.comments.find((item) => item.id === requestId) ?? null;
  return comment === null ? null : {
    id: comment.id, body: comment.body, url: comment.url, databaseId: comment.databaseId ?? null,
    createdAt: comment.createdAt, lastEditedAt: comment.lastEditedAt,
    author: actorObservation(comment.author),
  };
}

export function createRequestReviewUnlocked(context) {
  const { client, stateAdapter, git, clock, journal, load, assertCurrent } = context;
  async function requestReviewUnlocked(prNumber, kind) {
    let active = await load(prNumber);
    if (kind !== undefined && !['discovery', 'verification'].includes(kind)) {
      throw new GitHubWorkflowError('Review kind is invalid', 'INVALID_REVIEW_KIND');
    }
    const pendingOperationId = active.reviewRequest
      ? `request:${prNumber}:${active.reviewRequest.kind}:${active.reviewHistory.length}:${active.currentIntegrationHeadSha}`
      : null;
    const pendingRecoveryIntent = pendingOperationId
      ? await lookupRequestJournalIntent(journal, pendingOperationId) : null;
    if (active.phase === 'awaiting-review' && pendingRecoveryIntent !== null
        && active.reviewRequest && active.reviewOutcome === null && active.reviewHistory.at(-1)?.outcome === null
        && active.reviewHistory.at(-1)?.request?.id === active.reviewRequest.id) {
      if (kind !== undefined && kind !== active.reviewRequest.kind) {
        throw new GitHubWorkflowError('Requested kind differs from the durable pending request', 'REQUEST_NOT_READY');
      }
      const livePending = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      assertRecordedRequestComment(active, livePending);
      await assertMutationReady({ state: active, git }, livePending);
      if (livePending.metadata.headRefOid !== active.reviewRequest.headSha
          || active.reviewRequest.headSha !== active.currentIntegrationHeadSha) {
        throw new GitHubWorkflowError('Durable pending request no longer has exact live proof', 'REQUEST_NOT_READY');
      }
      await assertCurrent(active);
      const readyOperationId = `ready:${prNumber}:${livePending.metadata.id}:${active.currentIntegrationHeadSha}`;
      const readyIntent = await lookupOptionalMutationJournalIntent(journal, 'ready', readyOperationId);
      return {
        requested: true, recovered: true,
        pullRequestReadiness: readyIntent ? 'recovered-ready' : 'already-ready',
        request: active.reviewRequest,
      };
    }
    let live = await readLiveSnapshot(client, active);
    const heads = await assertMutationReady({ state: active, git }, live, { requireReady: false });
    if (live.metadata.state !== 'OPEN') {
      throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
    }
    const gate = reviewRequestGate(active, {
      ...heads, prHeadSha: live.metadata.headRefOid, prState: live.metadata.state, isDraft: live.metadata.isDraft,
    }, { promotionPreflight: live.metadata.isDraft });
    const selectedKind = kind ?? gate.kind;
    if (!gate.allowed || gate.kind !== selectedKind) {
      throw new GitHubWorkflowError(
        `State gate does not allow ${selectedKind ?? 'a review request'}: ${gate.reasons.join('; ')}`,
        'REQUEST_NOT_READY',
      );
    }
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical review threads remain unresolved', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    const readyOperationId = `ready:${prNumber}:${live.metadata.id}:${active.currentIntegrationHeadSha}`;
    const readyPullRequestId = live.metadata.id;
    const priorReadyIntent = await lookupOptionalMutationJournalIntent(journal, 'ready', readyOperationId);
    let didMarkReady = false;
    let pullRequestReadiness = priorReadyIntent ? 'recovered-ready' : 'already-ready';
    if (live.metadata.isDraft) {
      const readyIntent = priorReadyIntent ?? intentFor('ready', readyOperationId, clock.now());
      const persistedReadyIntent = priorReadyIntent ?? await journalRequestIntent(journal, readyIntent);
      live = await readLiveSnapshot(client, active);
      if (live.metadata.id !== readyPullRequestId || live.metadata.headRefOid !== active.currentIntegrationHeadSha
          || live.metadata.state !== 'OPEN') {
        throw new GitHubWorkflowError('Draft promotion identity changed after journaling', 'REQUEST_NOT_READY');
      }
      if (live.metadata.isDraft) {
        const promotionHeads = await assertMutationReady({ state: active, git }, live, { requireReady: false });
        const promotionGate = reviewRequestGate(active, {
          ...promotionHeads, prHeadSha: live.metadata.headRefOid, prState: live.metadata.state, isDraft: live.metadata.isDraft,
        }, { promotionPreflight: true });
        if (!promotionGate.allowed
            || live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
          throw new GitHubWorkflowError('Draft promotion prerequisites changed after journaling', 'REQUEST_NOT_READY');
        }
        assertLiveThreadProof(active, live);
        await assertCurrent(active);
        try {
          await executeMutation(client, 'MarkPullRequestReadyForReview', {
            pullRequestId: live.metadata.id, clientMutationId: persistedReadyIntent.clientMutationId,
          }, 'markPullRequestReadyForReview');
          didMarkReady = true;
        } catch (error) {
          const recoveredLive = await readLiveSnapshot(client, active);
          try {
            if (recoveredLive.metadata.id !== readyPullRequestId
                || recoveredLive.metadata.number !== prNumber) throw error;
            const recoveredHeads = await assertMutationReady({ state: active, git }, recoveredLive);
            const recoveredGate = reviewRequestGate(active, {
              ...recoveredHeads, prHeadSha: recoveredLive.metadata.headRefOid,
              prState: recoveredLive.metadata.state, isDraft: recoveredLive.metadata.isDraft,
            });
            if (!recoveredGate.allowed || recoveredLive.threads.some((thread) => thread.canonical && !thread.isResolved)) throw error;
            assertLiveThreadProof(active, recoveredLive);
            await assertCurrent(active);
            live = recoveredLive;
          } catch {
            throw error;
          }
        }
      }
      live = await readLiveSnapshot(client, active);
      if (live.metadata.id !== readyPullRequestId) {
        throw new GitHubWorkflowError('Pull request identity changed during draft promotion', 'REQUEST_NOT_READY');
      }
      assertPullRequestReady(live);
      const refreshedHeads = await assertMutationReady({ state: active, git }, live);
      const refreshedGate = reviewRequestGate(active, {
        ...refreshedHeads, prHeadSha: live.metadata.headRefOid, prState: live.metadata.state, isDraft: live.metadata.isDraft,
      });
      if (!refreshedGate.allowed || live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
        throw new GitHubWorkflowError('Pull request readiness changed during draft promotion', 'REQUEST_NOT_READY');
      }
      assertLiveThreadProof(active, live);
      await assertCurrent(active);
      pullRequestReadiness = didMarkReady && priorReadyIntent === null && persistedReadyIntent.isNew !== false
        ? 'marked-ready' : 'recovered-ready';
    } else {
      assertPullRequestReady(live);
    }
    const operationId = `request:${prNumber}:${selectedKind}:${active.reviewHistory.length + 1}:${active.currentIntegrationHeadSha}`;
    const priorRequestIds = new Set(active.reviewHistory.map((entry) => entry.request.id));
    const intendedAt = clock.now();
    const baselineComments = live.comments.filter((comment) => comment.body === REQUEST_BODY
      && isViewerActor(comment.author, live.metadata.viewer));
    const excludedCommentIds = [...new Set(baselineComments.map((comment) => comment.id))].sort();
    if (excludedCommentIds.length > MAX_NODES) {
      throw new GitHubWorkflowError('Request comment baseline exceeded the node limit', 'GRAPHQL_TRUNCATED');
    }
    const pendingIntent = { ...intentFor('request', operationId, intendedAt), excludedCommentIds };
    const priorIntent = await lookupRequestJournalIntent(journal, operationId);
    let intended = priorIntent ?? pendingIntent;
    if (!priorIntent && baselineComments.some((comment) => !priorRequestIds.has(comment.id)
      && requestRecoveryAtOrAfter(comment.createdAt, intended.at))) {
      throw new GitHubWorkflowError('Fresh request window contains an unrecorded viewer comment', 'REQUEST_BASELINE_COLLISION');
    }
    live = await readLiveSnapshot(client, active);
    if (live.metadata.id !== readyPullRequestId) {
      throw new GitHubWorkflowError('Pull request identity changed before request journaling', 'REQUEST_NOT_READY');
    }
    const preJournalHeads = await assertMutationReady({ state: active, git }, live);
    const preJournalGate = reviewRequestGate(active, {
      ...preJournalHeads, prHeadSha: live.metadata.headRefOid,
      prState: live.metadata.state, isDraft: live.metadata.isDraft,
    });
    if (!preJournalGate.allowed || preJournalGate.kind !== selectedKind
        || live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Review request prerequisites changed before journaling', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    await assertCurrent(active);
    if (!priorIntent) intended = await journalRequestIntent(journal, pendingIntent);
    live = await readLiveSnapshot(client, active);
    if (live.metadata.id !== readyPullRequestId) {
      throw new GitHubWorkflowError('Pull request identity changed after request journaling', 'REQUEST_NOT_READY');
    }
    const journalHeads = await assertMutationReady({ state: active, git }, live);
    const journalGate = reviewRequestGate(active, {
      ...journalHeads, prHeadSha: live.metadata.headRefOid,
      prState: live.metadata.state, isDraft: live.metadata.isDraft,
    });
    if (!journalGate.allowed || journalGate.kind !== selectedKind
        || live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Review request prerequisites changed after journaling', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    await assertCurrent(active);
    const recovering = priorIntent !== null || intended.isNew === false;
    const excludedIds = new Set(intended.excludedCommentIds);
    let candidates = recovering
      ? exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds) : [];
    if (candidates.length > 1) throw new GitHubWorkflowError('Request recovery is ambiguous', 'REQUEST_RECOVERY_AMBIGUOUS');
    let recovered = candidates.length === 1;
    if (candidates.length === 0) {
      if (!journal?.claimDispatch) {
        if (recovering) return { requested: false, recovered: false, waiting: true, pullRequestReadiness,
          nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
      } else {
        const dispatch = await journal.claimDispatch(intended, active.revision);
        if (!dispatch.isNew) return { requested: false, recovered: false, waiting: true, pullRequestReadiness,
          nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
      }
      try {
        await executeMutation(client, 'AddReviewRequest', {
          subjectId: live.metadata.id, body: REQUEST_BODY, clientMutationId: intended.clientMutationId,
        }, 'addComment');
      } catch (error) {
        if (error instanceof GitHubWorkflowError) throw error;
        // A transport error can arrive after GitHub accepted the mutation.  A
        // dispatch marker makes every later caller observational: reconcile
        // this owner once, but never replay an uncertain dispatched request.
        live = await readLiveSnapshot(client, active);
        candidates = exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds);
        if (candidates.length === 0) {
          return { requested: false, recovered: false, waiting: true, pullRequestReadiness,
            nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
        }
        if (candidates.length > 1) throw new GitHubWorkflowError('Request recovery is ambiguous', 'REQUEST_RECOVERY_AMBIGUOUS');
      }
      live = await readLiveSnapshot(client, active);
      candidates = exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds);
      if (candidates.length === 0) {
        return { requested: false, recovered: false, waiting: true, pullRequestReadiness,
          nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
      }
      if (candidates.length > 1) throw new GitHubWorkflowError('Request mutation was not uniquely proven live', 'REQUEST_NOT_PROVEN');
    }
    live = await readLiveSnapshot(client, active);
    if (live.metadata.id !== readyPullRequestId) {
      throw new GitHubWorkflowError('Pull request identity changed before request checkpointing', 'REQUEST_NOT_READY');
    }
    const finalHeads = await assertMutationReady({ state: active, git }, live);
    const finalGate = reviewRequestGate(active, {
      ...finalHeads, prHeadSha: live.metadata.headRefOid,
      prState: live.metadata.state, isDraft: live.metadata.isDraft,
    });
    if (!finalGate.allowed || finalGate.kind !== selectedKind
        || live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Review request prerequisites changed before checkpointing', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    await assertCurrent(active);
    candidates = exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds);
    if (candidates.length !== 1) throw new GitHubWorkflowError('Request result changed before checkpointing', 'REQUEST_NOT_PROVEN');
    recovered = recovered || (candidates.length === 1 && !intended.isNew);
    const comment = candidates[0];
    active = await stateAdapter.checkpointReviewRequest({
      prNumber, expectedRevision: active.revision,
      request: {
        id: comment.id, databaseId: comment.databaseId ?? null, url: comment.url,
        headSha: active.currentIntegrationHeadSha, at: comment.createdAt, kind: selectedKind, body: REQUEST_BODY,
        authorLogin: comment.author.login, authorNodeId: comment.author.id,
      },
      pushedHeadSha: finalHeads.pushedHeadSha, prHeadSha: live.metadata.headRefOid,
      prState: live.metadata.state, isDraft: live.metadata.isDraft,
    });
    return { requested: true, recovered, pullRequestReadiness, request: active.reviewRequest };
  }
  return requestReviewUnlocked;
}
