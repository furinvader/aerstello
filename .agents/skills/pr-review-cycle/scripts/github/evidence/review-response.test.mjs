import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import {
  canonicalJson,
  canonicalRootEvidence,
  canonicalRootState,
  classifyPendingReviewResponse,
  classifyReviewSubmission,
  classifyStructuralIssueComments,
  outcomeFromCanonicalResponse,
  responseFingerprint,
  responseObservation,
} from './review-response.mjs';

const HEAD = 'a'.repeat(40);
const STALE_HEAD = 'b'.repeat(40);
const REQUEST_AT = '2026-08-22T10:00:00.000Z';
const RESPONSE_AT = '2026-08-22T10:01:00.000Z';
const CANONICAL_ACTOR = {
  __typename: 'Bot',
  login: 'chatgpt-codex-connector',
  id: 'BOT_codex',
  url: 'https://github.com/apps/chatgpt-codex-connector',
};
const FOREIGN_ACTOR = {
  __typename: 'User', login: 'foreign', id: 'U_foreign', url: 'https://example.test/foreign',
};
const REQUEST = {
  id: 'request-1', databaseId: 100, url: 'https://example.test/request-1',
  headSha: HEAD, at: REQUEST_AT, kind: 'discovery',
};
const FACTS = { reviewRequest: REQUEST, integrationWorktree: '/integration' };

function emptyLive(overrides = {}) {
  return { reviews: [], reactions: [], comments: [], threads: [], ...overrides };
}

function review(overrides = {}) {
  return {
    id: 'review-1', databaseId: 201, url: 'https://example.test/review-1',
    body: '', state: 'COMMENTED', submittedAt: RESPONSE_AT,
    commit: { oid: HEAD }, author: CANONICAL_ACTOR,
    ...overrides,
  };
}

function reaction(overrides = {}) {
  return {
    id: 'reaction-1', content: 'THUMBS_UP', createdAt: RESPONSE_AT,
    user: CANONICAL_ACTOR, ...overrides,
  };
}

function structuralComment(overrides = {}) {
  return {
    id: 'comment-1', databaseId: 301, url: 'https://example.test/comment-1',
    body: `Review complete.\n\n**Reviewed commit:** \`${HEAD.slice(0, 12)}\``,
    createdAt: RESPONSE_AT, lastEditedAt: null, author: CANONICAL_ACTOR,
    ...overrides,
  };
}

function rootThread(id = 'thread-1', reviewId = 'review-1', overrides = {}) {
  const root = {
    id: `${id}-root`, databaseId: 401, url: `https://example.test/${id}`,
    body: 'Finding', createdAt: RESPONSE_AT, author: CANONICAL_ACTOR,
    replyTo: null, pullRequestReview: reviewId === null ? null : { id: reviewId },
  };
  return {
    id, isResolved: false, canonical: true, root,
    comments: [root, {
      id: `${id}-reply`, body: 'Reply', author: FOREIGN_ACTOR,
      replyTo: { id: root.id }, pullRequestReview: { id: reviewId },
    }],
    ...overrides,
  };
}

function resolvingGit(candidates = [HEAD], calls = []) {
  return {
    async resolveCommitPrefix(prefix, cwd) {
      calls.push({ prefix, cwd });
      if (candidates instanceof Error) throw candidates;
      return candidates;
    },
  };
}

test('classifyReviewSubmission preserves unsupported, clean, body, and root findings order', () => {
  assert.equal(classifyReviewSubmission(review({ body: null }), []), 'unsupported');
  assert.equal(classifyReviewSubmission(review({ body: '   ' }), []), 'clean');
  assert.equal(classifyReviewSubmission(review({ body: 'Finding' }), []), 'findings');
  assert.equal(classifyReviewSubmission(review({ body: '' }), [rootThread()]), 'findings');
  assert.equal(classifyReviewSubmission(review({ body: '' }), [rootThread('other', 'other-review')]), 'clean');
});

test('classifyStructuralIssueComments accepts one exact canonical anchor through injected Git', async () => {
  const calls = [];
  const comment = structuralComment();
  const classified = await classifyStructuralIssueComments({
    comments: [comment], request: REQUEST, threads: [],
    git: resolvingGit([HEAD], calls), cwd: '/integration', expectedHeads: [HEAD],
  });
  assert.deepEqual(classified, { exact: [{ comment, headSha: HEAD }], unsupported: [] });
  assert.deepEqual(calls, [{ prefix: HEAD.slice(0, 12), cwd: '/integration' }]);
});

test('structural comment anchor rules ignore unrelated evidence and reject altered structure', async () => {
  const before = structuralComment({ id: 'before', createdAt: '2026-08-22T09:59:59.000Z' });
  const foreign = structuralComment({ id: 'foreign', author: FOREIGN_ACTOR });
  const unrelated = structuralComment({ id: 'unrelated', body: 'ordinary comment' });
  const edited = structuralComment({ id: 'edited', lastEditedAt: RESPONSE_AT });
  const duplicate = structuralComment({
    id: 'duplicate',
    body: `**Reviewed commit:** \`${HEAD.slice(0, 12)}\`\n**Reviewed commit:** \`${HEAD.slice(0, 12)}\``,
  });
  const malformed = structuralComment({ id: 'malformed', body: '**Reviewed commit:** not-a-prefix' });
  const classified = await classifyStructuralIssueComments({
    comments: [before, foreign, unrelated, edited, duplicate, malformed],
    request: REQUEST, threads: [], git: resolvingGit(), cwd: '/integration', expectedHeads: [HEAD],
  });
  assert.deepEqual(classified.exact, []);
  assert.deepEqual(classified.unsupported.map((item) => item.id), ['edited', 'duplicate', 'malformed']);
});

test('structural comments reject unresolved, ambiguous, wrong-head, and root-conflicted anchors', async () => {
  const cases = [
    resolvingGit(new Error('resolution failed')),
    resolvingGit([]),
    resolvingGit([HEAD, STALE_HEAD]),
    resolvingGit([STALE_HEAD]),
  ];
  for (const git of cases) {
    const comment = structuralComment();
    const classified = await classifyStructuralIssueComments({
      comments: [comment], request: REQUEST, threads: [], git,
      cwd: '/integration', expectedHeads: [HEAD],
    });
    assert.deepEqual(classified, { exact: [], unsupported: [comment] });
  }

  const comment = structuralComment();
  const classified = await classifyStructuralIssueComments({
    comments: [comment], request: REQUEST, threads: [rootThread()],
    git: resolvingGit(), cwd: '/integration', expectedHeads: [HEAD],
  });
  assert.deepEqual(classified, { exact: [], unsupported: [comment] });
});

test('structural classification preserves timestamp failure code and ordering', async () => {
  await assert.rejects(
    classifyStructuralIssueComments({
      comments: [structuralComment({ createdAt: 'invalid' })],
      request: REQUEST, threads: [], git: resolvingGit(), cwd: '/integration', expectedHeads: [HEAD],
    }),
    (error) => {
      assert.ok(error instanceof GitHubWorkflowError);
      assert.equal(error.code, 'INVALID_TIMESTAMP');
      assert.equal(error.message, 'Evidence has an invalid timestamp');
      return true;
    },
  );
});

test('outcomeFromCanonicalResponse returns exact channel-specific shapes', () => {
  const selectedReaction = reaction();
  assert.deepEqual(outcomeFromCanonicalResponse(
    REQUEST,
    { type: 'reaction', value: selectedReaction },
    [],
  ), {
    id: 'reaction-1', databaseId: null, url: REQUEST.url,
    headSha: HEAD, at: RESPONSE_AT, requestId: REQUEST.id, kind: 'discovery',
    outcome: 'clean', evidenceType: 'request-reaction',
    reviewerLogin: CANONICAL_ACTOR.login, reviewerNodeId: CANONICAL_ACTOR.id,
    reviewerType: CANONICAL_ACTOR.__typename, reviewerUrl: CANONICAL_ACTOR.url,
    reactionContent: 'THUMBS_UP', reactionCommentId: REQUEST.id,
  });

  const comment = structuralComment();
  assert.deepEqual(outcomeFromCanonicalResponse(
    REQUEST,
    { type: 'issue-comment', value: { comment, headSha: HEAD } },
    [],
  ), {
    id: comment.id, databaseId: comment.databaseId, url: comment.url,
    headSha: HEAD, at: RESPONSE_AT, requestId: REQUEST.id, kind: 'discovery',
    outcome: 'clean', evidenceType: 'issue-comment',
    reviewerLogin: CANONICAL_ACTOR.login, reviewerNodeId: CANONICAL_ACTOR.id,
    reviewerType: CANONICAL_ACTOR.__typename, reviewerUrl: CANONICAL_ACTOR.url,
    reactionContent: null, reactionCommentId: null,
  });

  const selectedReview = review({ body: '' });
  assert.deepEqual(outcomeFromCanonicalResponse(
    REQUEST,
    { type: 'review', value: selectedReview },
    [rootThread()],
  ), {
    id: selectedReview.id, databaseId: selectedReview.databaseId, url: selectedReview.url,
    headSha: HEAD, at: RESPONSE_AT, requestId: REQUEST.id, kind: 'discovery',
    outcome: 'findings', evidenceType: 'review-submission',
    reviewerLogin: CANONICAL_ACTOR.login, reviewerNodeId: CANONICAL_ACTOR.id,
    reviewerType: CANONICAL_ACTOR.__typename, reviewerUrl: CANONICAL_ACTOR.url,
    reactionContent: null, reactionCommentId: null,
  });
});

test('canonicalJson recursively sorts object keys without reordering arrays', () => {
  assert.deepEqual(canonicalJson({ z: 1, a: [{ y: 2, x: 3 }, 4] }), {
    a: [{ x: 3, y: 2 }, 4], z: 1,
  });
});

test('canonical roots and comments retain exact observations with deterministic ordering', () => {
  const threadB = rootThread('thread-b', 'review-1');
  const threadA = rootThread('thread-a', 'review-1');
  threadA.comments.reverse();
  const noncanonical = rootThread('thread-c', 'review-1', { canonical: false });
  const live = emptyLive({ threads: [threadB, noncanonical, threadA] });

  assert.deepEqual(canonicalRootEvidence(live).map((item) => item.threadId), ['thread-a', 'thread-b']);
  assert.deepEqual(canonicalRootEvidence(live, 'other'), []);
  assert.deepEqual(canonicalRootEvidence(live, 'review-1')[0], {
    threadId: 'thread-a',
    rootId: 'thread-a-root',
    rootDatabaseId: 401,
    rootUrl: 'https://example.test/thread-a',
    rootBody: 'Finding',
    rootCreatedAt: RESPONSE_AT,
    rootAuthor: {
      type: 'Bot', login: CANONICAL_ACTOR.login, id: CANONICAL_ACTOR.id, url: CANONICAL_ACTOR.url,
    },
    reviewId: 'review-1',
  });
  const state = canonicalRootState(live);
  assert.deepEqual(state.map((item) => item.threadId), ['thread-a', 'thread-b']);
  assert.deepEqual(state[0].comments.map((item) => item.id), ['thread-a-reply', 'thread-a-root']);
  assert.deepEqual(state[0].comments[0], {
    id: 'thread-a-reply', databaseId: null, url: null, body: 'Reply', createdAt: null,
    authorType: 'User', authorLogin: 'foreign', authorId: 'U_foreign',
    authorUrl: 'https://example.test/foreign', replyToId: 'thread-a-root', reviewId: 'review-1',
  });
});

test('responseObservation preserves exact review, reaction, and issue-comment shapes', () => {
  const selectedReview = review();
  assert.deepEqual(responseObservation({ type: 'review', value: selectedReview }), {
    type: 'review', id: 'review-1', databaseId: 201, url: selectedReview.url,
    body: '', state: 'COMMENTED', submittedAt: RESPONSE_AT, commitOid: HEAD,
    actor: { type: 'Bot', login: CANONICAL_ACTOR.login, id: CANONICAL_ACTOR.id, url: CANONICAL_ACTOR.url },
  });
  assert.deepEqual(responseObservation({ type: 'reaction', value: reaction() }), {
    type: 'reaction', id: 'reaction-1', content: 'THUMBS_UP', createdAt: RESPONSE_AT,
    actor: { type: 'Bot', login: CANONICAL_ACTOR.login, id: CANONICAL_ACTOR.id, url: CANONICAL_ACTOR.url },
  });
  const comment = structuralComment();
  assert.deepEqual(responseObservation({ type: 'issue-comment', value: { comment, headSha: HEAD } }), {
    type: 'issue-comment', id: 'comment-1', databaseId: 301, url: comment.url,
    body: comment.body, createdAt: RESPONSE_AT, lastEditedAt: null, headSha: HEAD,
    actor: { type: 'Bot', login: CANONICAL_ACTOR.login, id: CANONICAL_ACTOR.id, url: CANONICAL_ACTOR.url },
  });
});

test('responseFingerprint preserves the fixed canonical SHA-256 vector', () => {
  const candidate = { type: 'review', value: review({ body: 'Finding' }) };
  const live = emptyLive({ threads: [rootThread('thread-b'), rootThread('thread-a')] });
  assert.equal(
    responseFingerprint(candidate, live),
    'fb58ba65d5bdb36a5631e79be456b4f21eccac126d7489180230c18cffd9252f',
  );
});

test('classifyPendingReviewResponse returns the exact empty result', async () => {
  assert.deepEqual(await classifyPendingReviewResponse(
    FACTS, emptyLive(), resolvingGit(),
  ), {
    status: 'none', evidence: null, responseFingerprint: null, evidenceIds: [], rootState: [],
  });
});

test('pending response classification supports exact review, reaction, and structural channels', async () => {
  const channelLives = [
    emptyLive({ reviews: [review({ body: 'Finding' })], threads: [rootThread()] }),
    emptyLive({ reactions: [reaction()] }),
    emptyLive({ comments: [structuralComment()] }),
  ];
  const expected = [
    ['review-submission', 'findings', ['review:review-1', 'review-root:thread-1-root']],
    ['request-reaction', 'clean', ['reaction:reaction-1']],
    ['issue-comment', 'clean', ['issue-comment:comment-1']],
  ];
  for (let index = 0; index < channelLives.length; index += 1) {
    const classified = await classifyPendingReviewResponse(FACTS, channelLives[index], resolvingGit());
    assert.equal(classified.status, 'supported');
    assert.equal(classified.evidence.evidenceType, expected[index][0]);
    assert.equal(classified.evidence.outcome, expected[index][1]);
    assert.deepEqual(classified.evidenceIds, expected[index][2]);
    assert.match(classified.responseFingerprint, /^[0-9a-f]{64}$/u);
  }
});

test('pending response classification distinguishes stale and include-unmatched-root ambiguity', async () => {
  const stale = emptyLive({ reviews: [review({ commit: { oid: STALE_HEAD } })] });
  assert.deepEqual(await classifyPendingReviewResponse(FACTS, stale, resolvingGit()), {
    status: 'stale', evidence: null, responseFingerprint: null,
    evidenceIds: ['review:review-1'], rootState: [],
  });
  const included = await classifyPendingReviewResponse(
    FACTS, stale, resolvingGit(), { includeUnmatchedRoots: true },
  );
  assert.equal(included.status, 'ambiguous');
  assert.deepEqual(included.evidenceIds, ['review:review-1']);

  const unmatched = emptyLive({ threads: [rootThread('thread-1', 'missing-review')] });
  const classified = await classifyPendingReviewResponse(FACTS, unmatched, resolvingGit());
  assert.equal(classified.status, 'ambiguous');
  assert.deepEqual(classified.evidenceIds, ['review-root:thread-1-root']);
});

test('pending response classification preserves candidate and unsupported evidence ordering', async () => {
  const exactReview = review({ id: 'exact-review' });
  const staleReview = review({ id: 'stale-review', commit: { oid: STALE_HEAD } });
  const exactReaction = reaction({ id: 'exact-reaction' });
  const oldReaction = reaction({ id: 'old-reaction', createdAt: '2026-08-22T09:59:00.000Z' });
  const exactComment = structuralComment({ id: 'exact-comment' });
  const editedComment = structuralComment({ id: 'edited-comment', lastEditedAt: RESPONSE_AT });
  const unmatchedRoot = rootThread('unmatched-thread', 'missing-review');
  const classified = await classifyPendingReviewResponse(FACTS, emptyLive({
    reviews: [exactReview, staleReview],
    reactions: [exactReaction, oldReaction],
    comments: [exactComment, editedComment],
    threads: [unmatchedRoot],
  }), resolvingGit());

  assert.equal(classified.status, 'ambiguous');
  assert.deepEqual(classified.evidenceIds, [
    'review:exact-review',
    'reaction:exact-reaction',
    'review:stale-review',
    'reaction:old-reaction',
    'review-root:unmatched-thread-root',
    'issue-comment:exact-comment',
    'issue-comment:edited-comment',
  ]);
});

test('pending response classification ignores foreign and unsupported noncanonical channels', async () => {
  const live = emptyLive({
    reviews: [review({ author: FOREIGN_ACTOR })],
    reactions: [reaction({ user: FOREIGN_ACTOR }), reaction({ content: 'CONFUSED' })],
    comments: [structuralComment({ author: FOREIGN_ACTOR })],
  });
  const classified = await classifyPendingReviewResponse(FACTS, live, resolvingGit());
  assert.equal(classified.status, 'none');
  assert.deepEqual(classified.evidenceIds, []);
});
