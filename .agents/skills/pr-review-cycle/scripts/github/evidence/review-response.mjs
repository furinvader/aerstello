import { createHash } from 'node:crypto';

import { GitHubWorkflowError } from '../errors.mjs';
import { actorObservation, isCanonicalActor } from './actors.mjs';

const REVIEWED_COMMIT_MARKER_LINE_PATTERN = /^\*\*Reviewed commit:\*\*.*$/gimu;
const REVIEWED_COMMIT_ANCHOR_PATTERN = /^\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`$/gmu;

function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

function evidenceAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request');
}

function canonicalEvidenceId(item, prefix) {
  return `${prefix}:${item.id}`;
}

export function classifyReviewSubmission(review, threads) {
  if (typeof review.body !== 'string') return 'unsupported';
  const hasAttachedCanonicalRoot = threads.some((thread) => thread.canonical
    && thread.root.pullRequestReview?.id === review.id);
  return review.body.trim().length > 0 || hasAttachedCanonicalRoot ? 'findings' : 'clean';
}

export async function classifyStructuralIssueComments({ comments, request, threads, git, cwd, expectedHeads }) {
  const exact = [];
  const unsupported = [];
  for (const comment of comments) {
    if (typeof comment.body !== 'string') continue;
    const markerLines = [...comment.body.matchAll(REVIEWED_COMMIT_MARKER_LINE_PATTERN)];
    if (markerLines.length === 0) continue;
    if (!evidenceAtOrAfter(comment.createdAt, request.at)) continue;
    if (!isCanonicalActor(comment.author)) continue;
    if (comment.lastEditedAt !== null) {
      unsupported.push(comment);
      continue;
    }
    const anchors = [...comment.body.matchAll(REVIEWED_COMMIT_ANCHOR_PATTERN)];
    if (markerLines.length !== 1 || anchors.length !== 1) {
      unsupported.push(comment);
      continue;
    }
    let candidates;
    try {
      candidates = await git.resolveCommitPrefix(anchors[0][1], cwd);
    } catch {
      candidates = [];
    }
    if (!Array.isArray(candidates) || candidates.length !== 1
        || !/^[0-9a-f]{40}$/u.test(candidates[0])
        || expectedHeads.some((head) => candidates[0] !== head)) {
      unsupported.push(comment);
      continue;
    }
    const hasPostRequestCanonicalRoot = threads.some((thread) => thread.canonical
      && evidenceAtOrAfter(thread.root.createdAt, request.at));
    if (hasPostRequestCanonicalRoot) {
      unsupported.push(comment);
      continue;
    }
    exact.push({ comment, headSha: candidates[0] });
  }
  return { exact, unsupported };
}

export function outcomeFromCanonicalResponse(request, selected, threads) {
  if (selected.type === 'reaction') {
    const reaction = selected.value;
    return {
      id: reaction.id, databaseId: null, url: request.url,
      headSha: request.headSha, at: reaction.createdAt, requestId: request.id, kind: request.kind,
      outcome: 'clean', evidenceType: 'request-reaction',
      reviewerLogin: reaction.user.login, reviewerNodeId: reaction.user.id,
      reviewerType: reaction.user.__typename, reviewerUrl: reaction.user.url,
      reactionContent: 'THUMBS_UP', reactionCommentId: request.id,
    };
  }
  if (selected.type === 'issue-comment') {
    const { comment, headSha } = selected.value;
    return {
      id: comment.id, databaseId: comment.databaseId ?? null, url: comment.url,
      headSha, at: comment.createdAt, requestId: request.id, kind: request.kind,
      outcome: 'clean', evidenceType: 'issue-comment',
      reviewerLogin: comment.author.login, reviewerNodeId: comment.author.id,
      reviewerType: comment.author.__typename, reviewerUrl: comment.author.url,
      reactionContent: null, reactionCommentId: null,
    };
  }
  const review = selected.value;
  return {
    id: review.id, databaseId: review.databaseId ?? null, url: review.url,
    headSha: review.commit.oid, at: review.submittedAt, requestId: request.id, kind: request.kind,
    outcome: classifyReviewSubmission(review, threads), evidenceType: 'review-submission',
    reviewerLogin: review.author.login, reviewerNodeId: review.author.id,
    reviewerType: review.author.__typename, reviewerUrl: review.author.url,
    reactionContent: null, reactionCommentId: null,
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function canonicalRootEvidence(live, reviewId = undefined) {
  return live.threads.filter((thread) => thread.canonical
    && (reviewId === undefined || thread.root.pullRequestReview?.id === reviewId)).map((thread) => ({
    threadId: thread.id,
    rootId: thread.root.id,
    rootDatabaseId: thread.root.databaseId ?? null,
    rootUrl: thread.root.url ?? null,
    rootBody: thread.root.body ?? null,
    rootCreatedAt: thread.root.createdAt ?? null,
    rootAuthor: actorObservation(thread.root.author),
    reviewId: thread.root.pullRequestReview?.id ?? null,
  })).sort((left, right) => left.threadId.localeCompare(right.threadId));
}

export function canonicalRootState(live) {
  const evidenceByThread = new Map(canonicalRootEvidence(live)
    .map((evidence) => [evidence.threadId, evidence]));
  return live.threads.filter((thread) => thread.canonical).map((thread) => ({
    ...evidenceByThread.get(thread.id),
    isResolved: thread.isResolved,
    comments: thread.comments.map((comment) => ({
      id: comment.id,
      databaseId: comment.databaseId ?? null,
      url: comment.url ?? null,
      body: comment.body ?? null,
      createdAt: comment.createdAt ?? null,
      authorType: comment.author?.__typename ?? null,
      authorLogin: comment.author?.login ?? null,
      authorId: comment.author?.id ?? null,
      authorUrl: comment.author?.url ?? null,
      replyToId: comment.replyTo?.id ?? null,
      reviewId: comment.pullRequestReview?.id ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.threadId.localeCompare(right.threadId));
}

export function responseObservation(candidate) {
  if (candidate.type === 'review') {
    const review = candidate.value;
    return {
      type: candidate.type,
      id: review.id,
      databaseId: review.databaseId ?? null,
      url: review.url,
      body: review.body,
      state: review.state,
      submittedAt: review.submittedAt,
      commitOid: review.commit?.oid ?? null,
      actor: actorObservation(review.author),
    };
  }
  if (candidate.type === 'reaction') {
    const reaction = candidate.value;
    return {
      type: candidate.type,
      id: reaction.id,
      content: reaction.content,
      createdAt: reaction.createdAt,
      actor: actorObservation(reaction.user),
    };
  }
  const { comment, headSha } = candidate.value;
  return {
    type: candidate.type,
    id: comment.id,
    databaseId: comment.databaseId ?? null,
    url: comment.url,
    body: comment.body,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
    headSha,
    actor: actorObservation(comment.author),
  };
}

export function responseFingerprint(candidate, live) {
  const observation = {
    response: responseObservation(candidate),
    roots: candidate.type === 'review'
      ? canonicalRootEvidence(live, candidate.value.id) : [],
  };
  return createHash('sha256').update(JSON.stringify(canonicalJson(observation))).digest('hex');
}

export async function classifyPendingReviewResponse(
  { reviewRequest: request, integrationWorktree },
  live,
  git,
  { includeUnmatchedRoots = false } = {},
) {
  const reviews = live.reviews.filter((review) => isCanonicalActor(review.author)
    && evidenceAtOrAfter(review.submittedAt, request.at));
  const exactReviews = reviews.filter((review) => review.state === 'COMMENTED'
    && typeof review.body === 'string' && review.commit?.oid === request.headSha);
  const staleReviews = reviews.filter((review) => review.state === 'COMMENTED'
    && typeof review.body === 'string' && review.commit?.oid !== request.headSha);
  const roots = live.threads.filter((thread) => thread.canonical
    && evidenceAtOrAfter(thread.root.createdAt, request.at));
  const exactReviewIds = new Set(exactReviews.map((review) => review.id));
  const unmatchedRoots = roots.filter((thread) => !exactReviewIds.has(thread.root.pullRequestReview?.id));
  const unsupportedReviews = reviews.filter((review) => !exactReviews.includes(review));
  const canonicalReactions = live.reactions.filter((reaction) => reaction.content === 'THUMBS_UP'
    && isCanonicalActor(reaction.user));
  const reactions = canonicalReactions.filter((reaction) =>
    evidenceAtOrAfter(reaction.createdAt, request.at));
  const unsupportedReactions = canonicalReactions.filter((reaction) =>
    !evidenceAtOrAfter(reaction.createdAt, request.at));
  const structural = await classifyStructuralIssueComments({
    comments: live.comments,
    request,
    threads: live.threads,
    git,
    cwd: integrationWorktree,
    expectedHeads: [request.headSha],
  });
  const candidates = [
    ...exactReviews.map((value) => ({ type: 'review', value })),
    ...reactions.map((value) => ({ type: 'reaction', value })),
    ...structural.exact.map((value) => ({ type: 'issue-comment', value })),
  ];
  const unsupportedIds = [
    ...unsupportedReviews.map((item) => canonicalEvidenceId(item, 'review')),
    ...unsupportedReactions.map((item) => canonicalEvidenceId(item, 'reaction')),
    ...unmatchedRoots.map((item) => canonicalEvidenceId(item.root, 'review-root')),
    ...structural.unsupported.map((item) => canonicalEvidenceId(item, 'issue-comment')),
  ];
  const candidateIds = candidates.map((candidate) => canonicalEvidenceId(
    candidate.type === 'issue-comment' ? candidate.value.comment : candidate.value,
    candidate.type,
  ));
  const rootState = canonicalRootState(live);
  if (candidates.length === 0 && unsupportedIds.length === 0) {
    return {
      status: 'none', evidence: null, responseFingerprint: null, evidenceIds: [], rootState,
    };
  }
  if (!includeUnmatchedRoots && candidates.length === 0 && staleReviews.length > 0 && unsupportedIds.length === staleReviews.length) {
    return { status: 'stale', evidence: null, responseFingerprint: null, evidenceIds: unsupportedIds, rootState };
  }
  if (candidates.length !== 1 || unsupportedIds.length > 0) {
    return {
      status: 'ambiguous', evidence: null,
      responseFingerprint: null,
      evidenceIds: [...new Set([...candidateIds, ...unsupportedIds])],
      rootState,
    };
  }
  const evidence = outcomeFromCanonicalResponse(request, candidates[0], live.threads);
  return {
    status: 'supported', evidence,
    responseFingerprint: responseFingerprint(candidates[0], live),
    evidenceIds: [...candidateIds, ...canonicalRootEvidence(live, candidates[0].type === 'review'
      ? candidates[0].value.id : undefined).map((root) => `review-root:${root.rootId}`)], rootState,
  };
}
