import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  createGitHubReviewWorkflow,
  GitHubWorkflowError,
  githubReviewConstants,
  readTopLevelComments,
} from '../../scripts/lib/pr-review-github.mjs';
import { runCli, usage } from '../../scripts/pr-review-github.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const AT = '2026-08-05T00:00:00Z';
const BOT = {
  __typename: 'Bot', login: 'chatgpt-codex-connector',
  url: 'https://github.com/apps/chatgpt-codex-connector', id: 'BOT_codex',
};
const VIEWER = { __typename: 'User', login: 'maintainer', url: 'https://github.com/maintainer', id: 'USER_1' };

function proof(status = 'passed', headSha = HEAD) {
  return {
    status, headSha: status === 'not-run' ? null : headSha, threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    updatedAt: status === 'not-run' ? null : AT,
  };
}

function stateFixture(overrides = {}) {
  return {
    schemaVersion: 2, revision: 1, repository: 'example/sky-bar', prNumber: 2, phase: 'recovering',
    baseSha: HEAD, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: HEAD,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [],
    verificationEscalation: null, threadResolutionStatus: proof('not-run'), blockedReasons: [],
    validationStatus: { status: 'not-run', headSha: null, checks: [], updatedAt: null },
    nextAction: 'Recover.', integrationWorktree: '/tmp/integration', orchestratorSessionId: null,
    abandonmentReason: null, git: { branch: 'main', headSha: HEAD, dirty: false }, updatedAt: AT,
    ...overrides,
  };
}

function readyState(overrides = {}) {
  return stateFixture({
    phase: 'ready-for-review',
    validationStatus: { status: 'passed', headSha: HEAD, checks: ['npm run check'], updatedAt: AT },
    threadResolutionStatus: proof(), nextAction: 'Request review.',
    ...overrides,
  });
}

function requestEvidence(kind = 'verification', overrides = {}) {
  return {
    id: 'IC_request', databaseId: 101, url: 'https://github.com/example/sky-bar/pull/2#issuecomment-101',
    headSha: HEAD, at: AT, kind, body: '@codex review', authorLogin: VIEWER.login,
    authorNodeId: VIEWER.id, ...overrides,
  };
}

function pendingState(kind = 'verification', overrides = {}) {
  const request = requestEvidence(kind);
  return readyState({
    phase: 'awaiting-review', requestedHeadSha: HEAD,
    reviewRound: kind === 'verification' ? 3 : 1,
    verificationReviewUsed: kind === 'verification',
    legacyReviewProvenance: kind === 'verification'
      ? { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT } : null,
    reviewRequest: request, reviewHistory: [{ request, outcome: null }],
    nextAction: 'Collect.', ...overrides,
  });
}

function completedState(overrides = {}) {
  const request = requestEvidence('discovery');
  const outcome = {
    id: 'PRR_clean', databaseId: 201, url: 'https://github.com/example/sky-bar/pull/2#pullrequestreview-201',
    headSha: HEAD, at: AT, requestId: request.id, kind: 'discovery', outcome: 'clean',
    evidenceType: 'review-submission', reviewerLogin: BOT.login, reviewerNodeId: BOT.id,
    reviewerType: BOT.__typename, reviewerUrl: BOT.url, reactionContent: null, reactionCommentId: null,
  };
  return readyState({
    phase: 'validating', requestedHeadSha: HEAD, reviewedHeadSha: HEAD, reviewRound: 1,
    reviewRequest: request, reviewOutcome: outcome, reviewHistory: [{ request, outcome }],
    nextAction: 'Complete.', ...overrides,
  });
}

function rootComment(threadId = 'THREAD_1', overrides = {}) {
  return {
    id: `ROOT_${threadId}`, databaseId: threadId === 'THREAD_1' ? 41 : 42,
    url: `https://github.com/example/sky-bar/pull/2#discussion_r${threadId}`,
    body: 'Canonical finding.', createdAt: AT, author: BOT, replyTo: null,
    pullRequestReview: { id: 'PRR_review' }, ...overrides,
  };
}

function connection(nodes, cursor, pageSize = 1) {
  const start = cursor === null || cursor === undefined ? 0 : Number(cursor);
  const page = nodes.slice(start, start + pageSize);
  const next = start + page.length;
  return {
    nodes: page,
    pageInfo: { hasNextPage: next < nodes.length, endCursor: next < nodes.length ? String(next) : null },
  };
}

class FakeClient {
  constructor(overrides = {}) {
    this.metadata = {
      id: 'PR_node', number: 2, url: 'https://github.com/example/sky-bar/pull/2',
      headRefOid: HEAD, viewer: VIEWER,
    };
    this.comments = [];
    this.reviews = [];
    this.threads = [];
    this.threadComments = new Map();
    this.reactions = new Map();
    this.calls = [];
    this.events = overrides.events ?? [];
    this.pageSize = overrides.pageSize ?? 1;
    this.remaining = overrides.remaining ?? 5000;
    this.graphqlErrors = overrides.graphqlErrors ?? new Set();
    this.noEffect = overrides.noEffect ?? new Set();
    Object.assign(this, overrides);
  }

  result(data) {
    return {
      data: { rateLimit: { cost: 1, remaining: this.remaining }, ...data },
      extensions: { cost: { actualQueryCost: 1, throttleStatus: { remaining: this.remaining } } },
    };
  }

  async graphql({ name, query, variables }) {
    this.calls.push({ name, query, variables });
    if (this.graphqlErrors.has(name)) return { errors: [{ message: 'boom' }] };
    if (name === 'PullRequestMetadata') {
      return this.result({ viewer: this.metadata.viewer, repository: { pullRequest: { ...this.metadata, viewer: undefined } } });
    }
    if (name === 'PullRequestComments') {
      return this.result({ repository: { pullRequest: { comments: connection(this.comments, variables.cursor, this.pageSize) } } });
    }
    if (name === 'PullRequestReviews') {
      return this.result({ repository: { pullRequest: { reviews: connection(this.reviews, variables.cursor, this.pageSize) } } });
    }
    if (name === 'PullRequestThreads') {
      return this.result({ repository: { pullRequest: { reviewThreads: connection(this.threads, variables.cursor, this.pageSize) } } });
    }
    if (name === 'ReviewThreadComments') {
      return this.result({ node: { comments: connection(this.threadComments.get(variables.threadId) ?? [], variables.cursor, this.pageSize) } });
    }
    if (name === 'RequestReactions') {
      return this.result({ node: { reactions: connection(this.reactions.get(variables.commentId) ?? [], variables.cursor, this.pageSize) } });
    }
    this.events.push(`mutation:${name}`);
    if (name === 'AddReviewRequest' && !this.noEffect.has(name)) {
      this.comments.push({
        id: `IC_${this.comments.length + 1}`, databaseId: 500 + this.comments.length,
        url: 'https://github.com/example/sky-bar/pull/2#issuecomment-new', body: variables.body,
        createdAt: AT, author: this.metadata.viewer,
      });
    }
    if (name === 'AddThreadReply' && !this.noEffect.has(name)) {
      const comments = this.threadComments.get(variables.threadId);
      comments.push({
        id: `REPLY_${comments.length}`, databaseId: 900 + comments.length,
        url: 'https://github.com/example/sky-bar/pull/2#discussion_reply', body: variables.body,
        createdAt: AT, author: this.metadata.viewer, replyTo: { id: comments.find((item) => item.replyTo === null).id },
        pullRequestReview: null,
      });
    }
    if (name === 'ResolveThread' && !this.noEffect.has(name)) {
      this.threads.find((thread) => thread.id === variables.threadId).isResolved = true;
    }
    const payload = name === 'AddReviewRequest' ? 'addComment'
      : name === 'AddThreadReply' ? 'addPullRequestReviewThreadReply' : 'resolveReviewThread';
    return this.result({ [payload]: { clientMutationId: variables.clientMutationId } });
  }
}

function fakeGit(overrides = {}) {
  return {
    snapshot: async () => ({ headSha: HEAD, dirty: false }),
    pushedHead: async () => HEAD,
    isAncestor: async () => true,
    ...overrides,
  };
}

function fakeJournal(events = [], existing = []) {
  const intents = new Map(existing.map((intent) => [intent.operationId, intent]));
  return {
    intents,
    async lookupIntent(operationId) { return intents.has(operationId) ? { ...intents.get(operationId), isNew: false } : null; },
    async ensureIntent(intent) {
      events.push(`intent:${intent.type}`);
      const exists = intents.has(intent.operationId);
      if (!exists) intents.set(intent.operationId, intent);
      return { ...intents.get(intent.operationId), isNew: !exists };
    },
  };
}

function fakeState(initial) {
  let current = structuredClone(initial);
  const calls = [];
  return {
    calls,
    get current() { return current; },
    async load() { return structuredClone(current); },
    async checkpointReviewRequest(input) {
      calls.push({ name: 'checkpointReviewRequest', input });
      const request = input.request;
      current = {
        ...current, revision: current.revision + 1, phase: 'awaiting-review', requestedHeadSha: request.headSha,
        reviewRound: request.kind === 'discovery' ? current.reviewRound + 1 : current.reviewRound,
        verificationReviewUsed: request.kind === 'verification' ? true : current.verificationReviewUsed,
        reviewRequest: request, reviewOutcome: null,
        reviewHistory: [...current.reviewHistory, { request, outcome: null }],
      };
      return structuredClone(current);
    },
    async checkpointReviewOutcome(input) {
      calls.push({ name: 'checkpointReviewOutcome', input });
      const outcome = input.outcome;
      current = {
        ...current, revision: current.revision + 1, reviewedHeadSha: outcome.headSha,
        reviewOutcome: outcome,
        reviewHistory: current.reviewHistory.map((entry, index) => (
          index === current.reviewHistory.length - 1 ? { ...entry, outcome } : entry
        )),
        phase: outcome.kind === 'verification' && outcome.outcome === 'findings'
          ? 'awaiting-human-decision' : outcome.outcome === 'findings' ? 'triaging' : 'validating',
      };
      return structuredClone(current);
    },
    async checkpointVerificationEscalation(input) {
      calls.push({ name: 'checkpointVerificationEscalation', input });
      current = { ...current, revision: current.revision + 1, phase: 'awaiting-human-decision', verificationEscalation: input.escalation };
      return structuredClone(current);
    },
    async checkpointTaskCompletion(input) {
      calls.push({ name: 'checkpointTaskCompletion', input });
      const covered = new Set(input.threadResolutionStatus.threads.filter((thread) => thread.isResolved).flatMap((thread) => thread.taskIds));
      if (input.threadResolutionStatus.threadlessVerification.status === 'passed') {
        input.threadResolutionStatus.threadlessVerification.taskIds.forEach((taskId) => covered.add(taskId));
      }
      current = {
        ...current, revision: current.revision + 1, threadResolutionStatus: input.threadResolutionStatus,
        tasks: current.tasks.map((task) => covered.has(task.id) ? { ...task, status: 'completed' } : task),
      };
      return structuredClone(current);
    },
    async checkpointCompletion(input) {
      calls.push({ name: 'checkpointCompletion', input });
      current = { ...current, revision: current.revision + 1, phase: 'complete' };
      return structuredClone(current);
    },
  };
}

function workflow(initial, client = new FakeClient(), options = {}) {
  if (initial.reviewRequest && !client.comments.some((comment) => comment.id === initial.reviewRequest.id)) {
    client.comments.push({
      id: initial.reviewRequest.id, databaseId: initial.reviewRequest.databaseId,
      url: initial.reviewRequest.url, body: initial.reviewRequest.body,
      createdAt: initial.reviewRequest.at,
      author: { ...VIEWER, login: initial.reviewRequest.authorLogin, id: initial.reviewRequest.authorNodeId },
    });
  }
  const state = fakeState(initial);
  const events = client.events;
  return {
    client,
    state,
    api: createGitHubReviewWorkflow({
      client, state, git: options.git ?? fakeGit(),
      clock: options.clock ?? { now: () => AT },
      journal: options.journal ?? fakeJournal(events),
    }),
  };
}

function addThread(client, { id = 'THREAD_1', resolved = false, root = rootComment(id), replies = [] } = {}) {
  client.threads.push({ id, isResolved: resolved });
  client.threadComments.set(id, [root, ...replies]);
  return root;
}

function markerFor(operationId) {
  return `<!-- sky-bar-review:${createHash('sha256').update(operationId).digest('hex').slice(0, 24)} -->`;
}

function priorIntent(type, operationId, at = AT) {
  return { type, operationId,
    clientMutationId: `sky-bar-${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}`, at,
    ...(type === 'request' ? { excludedCommentIds: [] } : {}) };
}

test('status uses split fully paginated reads and filters canonical roots', async () => {
  const client = new FakeClient({ pageSize: 1 });
  client.comments.push({ id: 'C1' }, { id: 'C2' });
  client.reviews.push({ id: 'R1' }, { id: 'R2' });
  addThread(client);
  addThread(client, { id: 'THREAD_2', root: rootComment('THREAD_2', { author: VIEWER }) });
  const { api } = workflow(stateFixture(), client);
  const result = await api.status(2);
  assert.equal(result.canonicalThreads.length, 1);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestComments').length >= 2);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestReviews').length >= 2);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 2);
  assert.equal(client.calls.filter((call) => call.name === 'ReviewThreadComments').length, 2);
  assert.equal(result.statePhase, 'recovering');
});

test('Actor author queries select node IDs only through Bot and User fragments', async () => {
  const client = new FakeClient();
  addThread(client);
  await workflow(stateFixture(), client).api.status(2);
  for (const name of ['PullRequestComments', 'PullRequestReviews', 'ReviewThreadComments']) {
    const query = client.calls.find((call) => call.name === name)?.query;
    assert.equal(typeof query, 'string', `${name} query was captured`);
    assert.doesNotMatch(query, /author\{__typename login url id/u, `${name} must not select Actor.id directly`);
    assert.match(query, /author\{__typename login url \.\.\. on Bot\{id\} \.\.\. on User\{id\}\}/u,
      `${name} must populate a uniform id through concrete actor fragments`);
  }
});

test('canonical Bot root without a concrete node ID throws fail-closed', async () => {
  const client = new FakeClient();
  addThread(client, { root: rootComment('THREAD_1', { author: { ...BOT, id: undefined } }) });
  await assert.rejects(() => workflow(stateFixture(), client).api.status(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
});

test('canonical review, reaction, and matching viewer actors without node IDs throw fail-closed', async () => {
  const reviewClient = new FakeClient();
  reviewClient.reviews.push({ id: 'PRR_missing', databaseId: 1, url: 'https://x/review', body: '',
    state: 'COMMENTED', submittedAt: AT, commit: { oid: HEAD }, author: { ...BOT, id: undefined } });
  await assert.rejects(() => workflow(pendingState('discovery'), reviewClient).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });

  const reactionClient = new FakeClient();
  reactionClient.reactions.set('IC_request', [{ id: 'REACTION_missing', content: 'THUMBS_UP',
    createdAt: AT, user: { ...BOT, id: undefined } }]);
  await assert.rejects(() => workflow(pendingState('discovery'), reactionClient).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });

  const viewerClient = new FakeClient();
  viewerClient.comments.push({ id: 'IC_missing', databaseId: 2, url: 'https://x/request',
    body: '@codex review', createdAt: AT, author: { ...VIEWER, id: undefined } });
  await assert.rejects(() => workflow(readyState(), viewerClient).api.request(2, 'discovery'), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
  assert.equal(viewerClient.events.length, 0);
});

test('GraphQL reads fail closed on errors, unsafe cost, and truncated pagination', async () => {
  for (const client of [
    new FakeClient({ graphqlErrors: new Set(['PullRequestComments']) }),
    new FakeClient({ remaining: 0 }),
  ]) {
    await assert.rejects(() => readTopLevelComments(client, 'example/sky-bar', 2), GitHubWorkflowError);
  }
  const client = new FakeClient();
  client.comments = [{ id: 'C1' }, { id: 'C2' }];
  client.graphql = async () => client.result({
    repository: { pullRequest: { comments: { nodes: [{ id: 'C1' }], pageInfo: { hasNextPage: true, endCursor: null } } } },
  });
  await assert.rejects(() => readTopLevelComments(client, 'example/sky-bar', 2), { code: 'GRAPHQL_TRUNCATED' });
});

test('request preflight rejects dirty, local, pushed, live, and ancestry drift before mutation', async () => {
  const actionable = {
    id: 'task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Done', severity: 'P1',
    disposition: 'actionable', status: 'completed', integratedCommitSha: HEAD, resolutionSummary: 'Done.',
  };
  const cases = [
    fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }) }),
    fakeGit({ pushedHead: async () => OTHER_HEAD }),
    fakeGit({ isAncestor: async () => false }),
  ];
  for (const git of cases) {
    const client = new FakeClient();
    const { api } = workflow(readyState({ tasks: [actionable] }), client, { git });
    await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_NOT_READY' });
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  }
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const { api } = workflow(readyState({ tasks: [actionable] }), client);
  await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_NOT_READY' });
});

test('request journals before exact mutation, proves live result, and checkpoints guarded evidence', async () => {
  const events = [];
  const client = new FakeClient({ events });
  const { api, state } = workflow(readyState(), client);
  const result = await api.request(2, 'discovery');
  assert.equal(result.request.body, githubReviewConstants.REQUEST_BODY);
  assert.deepEqual(events.slice(0, 2), ['intent:request', 'mutation:AddReviewRequest']);
  const mutation = client.calls.find((call) => call.name === 'AddReviewRequest');
  assert.equal(mutation.variables.body, '@codex review');
  assert.match(mutation.variables.clientMutationId, /^sky-bar-/u);
  assert.equal(state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('mutation correlation is required in addition to live proof', async () => {
  const client = new FakeClient();
  const graphql = client.graphql.bind(client);
  client.graphql = async (input) => {
    const result = await graphql(input);
    if (input.name === 'AddReviewRequest') result.data.addComment.clientMutationId = 'wrong-correlation';
    return result;
  };
  const { api, state } = workflow(readyState(), client);
  await assert.rejects(() => api.request(2, 'discovery'), { code: 'MUTATION_CORRELATION_FAILED' });
  assert.equal(state.calls.length, 0);
  assert.equal(client.comments.length, 1, 'the live write exists but is not trusted without correlation and re-query');
});

test('request recovers one exact viewer comment and fails closed on ambiguous or unproven recovery', async () => {
  const recoveredClient = new FakeClient();
  recoveredClient.comments.push({
    id: 'IC_recovered', databaseId: 9, url: 'https://github.com/example/sky-bar/pull/2#issuecomment-9',
    body: '@codex review', createdAt: AT, author: VIEWER,
  });
  const operationId = `request:2:discovery:1:${HEAD}`;
  const recoveryJournal = fakeJournal([], [priorIntent('request', operationId)]);
  const { api: recovered } = workflow(readyState(), recoveredClient, { journal: recoveryJournal });
  const recoveredResult = await recovered.request(2, 'discovery');
  assert.equal(recoveredResult.recovered, true, 'a persisted empty baseline recovers the crash-created comment');
  assert.equal(recoveredClient.calls.some((call) => call.name === 'AddReviewRequest'), false);

  const ambiguousClient = new FakeClient();
  ambiguousClient.comments.push(...recoveredClient.comments, { ...recoveredClient.comments[0], id: 'IC_other' });
  const { api: ambiguous } = workflow(readyState(), ambiguousClient, { journal: fakeJournal([], [priorIntent('request', operationId)]) });
  await assert.rejects(() => ambiguous.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_AMBIGUOUS' });

  const unprovenClient = new FakeClient({ noEffect: new Set(['AddReviewRequest']) });
  const { api: unproven } = workflow(readyState(), unprovenClient);
  await assert.rejects(() => unproven.request(2, 'discovery'), { code: 'REQUEST_NOT_PROVEN' });

  const missingClient = new FakeClient();
  const existing = [priorIntent('request', operationId)];
  const missingState = fakeState(readyState());
  const missing = createGitHubReviewWorkflow({
    client: missingClient, state: missingState, git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal([], existing),
  });
  await assert.rejects(() => missing.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_MISSING' });
  assert.equal(missingClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
});

function integratedThreadState(sourceIds = ['thread:THREAD_1']) {
  return readyState({
    phase: 'verifying', threadResolutionStatus: proof('not-run'),
    tasks: [{
      id: 'task-thread', sourceIds, sourceType: 'github-thread', fingerprint: 'fp-thread',
      summary: 'Fix canonical finding.', severity: 'P1', disposition: 'actionable', status: 'integrated',
      integratedCommitSha: HEAD, resolutionSummary: 'Fixed the finding.',
    }],
  });
}

test('reply-resolve identifies explicit root, deduplicates shared source identities, replies before resolve, and re-queries proof', async () => {
  const events = [];
  const client = new FakeClient({ events });
  addThread(client);
  const { api, state } = workflow(integratedThreadState(['thread:THREAD_1', 'discussion:41']), client);
  const result = await api.replyResolve(2, 'task-thread');
  assert.deepEqual(events.filter((item) => item.startsWith('mutation:')), ['mutation:AddThreadReply', 'mutation:ResolveThread']);
  assert.equal(client.calls.filter((call) => call.name === 'AddThreadReply').length, 1);
  assert.equal(client.calls.filter((call) => call.name === 'ResolveThread').length, 1);
  assert.match(client.threadComments.get('THREAD_1')[1].body, /<!-- sky-bar-review:[0-9a-f]{24} -->/u);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(state.current.tasks[0].status, 'completed');
});

test('reply-resolve reuses a crash reply marker, resumes resolve, and never trusts mutation responses', async () => {
  const seed = new FakeClient();
  addThread(seed);
  const first = workflow(integratedThreadState(), seed);
  seed.noEffect.add('ResolveThread');
  await assert.rejects(() => first.api.replyResolve(2, 'task-thread'), { code: 'RESOLVE_NOT_PROVEN' });
  const reply = seed.threadComments.get('THREAD_1')[1];
  assert.ok(reply);
  seed.noEffect.delete('ResolveThread');
  seed.calls.length = 0;
  const resumed = workflow(integratedThreadState(), seed);
  await resumed.api.replyResolve(2, 'task-thread');
  assert.equal(seed.calls.some((call) => call.name === 'AddThreadReply'), false);
  assert.equal(seed.calls.filter((call) => call.name === 'ResolveThread').length, 1);

  const noReply = new FakeClient({ noEffect: new Set(['AddThreadReply']) });
  addThread(noReply);
  await assert.rejects(
    () => workflow(integratedThreadState(), noReply).api.replyResolve(2, 'task-thread'),
    { code: 'REPLY_NOT_PROVEN' },
  );
});

test('threadless task completion consumes only successful exact-head verification and performs no GitHub mutation', async () => {
  const task = {
    id: 'threadless', sourceIds: ['review:threadless'], sourceType: 'github-threadless',
    fingerprint: 'threadless-fingerprint', summary: 'Threadless finding.', severity: 'P1',
    disposition: 'actionable', status: 'integrated', integratedCommitSha: HEAD, resolutionSummary: 'Verified.',
  };
  const verified = integratedThreadState();
  verified.tasks = [task];
  verified.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: { status: 'passed', headSha: HEAD, taskIds: ['threadless'], updatedAt: AT },
  };
  const client = new FakeClient();
  const completed = workflow(verified, client);
  await completed.api.replyResolve(2, 'threadless');
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
  assert.equal(completed.state.current.tasks[0].status, 'completed');

  const missing = structuredClone(verified);
  missing.threadResolutionStatus.threadlessVerification = {
    status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
  };
  await assert.rejects(() => workflow(missing).api.replyResolve(2, 'threadless'), { code: 'TASK_NOT_READY' });
});

test('reply-resolve fails on ambiguous roots and duplicate idempotency markers', async () => {
  const badRoot = new FakeClient();
  addThread(badRoot, { replies: [{ ...rootComment('THREAD_1'), id: 'ROOT_2' }] });
  await assert.rejects(() => workflow(integratedThreadState(), badRoot).api.replyResolve(2, 'task-thread'), {
    code: 'ROOT_IDENTITY_AMBIGUOUS',
  });

  const duplicate = new FakeClient();
  const root = addThread(duplicate);
  const marker = '<!-- sky-bar-review:1234567890abcdef12345678 -->';
  duplicate.threadComments.get('THREAD_1').push(
    { id: 'R1', url: 'https://x/1', body: marker, replyTo: { id: root.id }, author: VIEWER },
    { id: 'R2', url: 'https://x/2', body: marker, replyTo: { id: root.id }, author: VIEWER },
  );
  await assert.rejects(() => workflow(integratedThreadState(), duplicate).api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
});

test('collect accepts only canonical exact request THUMBS_UP and ignores noncanonical evidence', async () => {
  const client = new FakeClient();
  client.reactions.set('IC_request', [
    { id: 'REACTION_bad', content: 'THUMBS_UP', createdAt: AT, user: VIEWER },
    { id: 'REACTION_good', content: 'THUMBS_UP', createdAt: AT, user: BOT },
  ]);
  client.reviews.push({
    id: 'REVIEW_noncanonical', databaseId: 1, url: 'https://x/review', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: VIEWER,
  });
  const { api, state } = workflow(pendingState(), client);
  const result = await api.collect(2);
  assert.equal(result.outcome.evidenceType, 'request-reaction');
  assert.equal(result.outcome.reactionCommentId, 'IC_request');
  assert.equal(result.outcome.reviewerLogin, BOT.login);
  assert.equal(state.calls.at(-1).name, 'checkpointReviewOutcome');
});

test('collect escalates verification live drift, stale evidence, and exact-head ambiguity truthfully', async () => {
  const driftClient = new FakeClient();
  driftClient.metadata.headRefOid = OTHER_HEAD;
  const drift = workflow(pendingState(), driftClient);
  const drifted = await drift.api.collect(2);
  assert.deepEqual(
    { reason: drifted.escalation.reason, relation: drifted.escalation.headRelation },
    { reason: 'request-head-drift', relation: 'changed' },
  );

  const staleClient = new FakeClient();
  staleClient.reviews.push({
    id: 'REVIEW_stale', databaseId: 1, url: 'https://x/stale', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: OTHER_HEAD }, author: BOT,
  });
  const stale = await workflow(pendingState(), staleClient).api.collect(2);
  assert.equal(stale.escalation.reason, 'stale-canonical-evidence');
  assert.equal(stale.escalation.headRelation, 'same');

  const ambiguousClient = new FakeClient();
  ambiguousClient.reviews.push({
    id: 'REVIEW_exact', databaseId: 2, url: 'https://x/exact', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  ambiguousClient.reactions.set('IC_request', [{ id: 'REACTION_exact', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  const ambiguous = await workflow(pendingState(), ambiguousClient).api.collect(2);
  assert.equal(ambiguous.escalation.reason, 'ambiguous-canonical-evidence');
  assert.equal(ambiguous.escalation.headRelation, 'same');

  const absent = workflow(pendingState(), new FakeClient());
  await assert.rejects(() => absent.api.collect(2), { code: 'REVIEW_NOT_AVAILABLE' });
  assert.equal(absent.state.calls.length, 0);
});

test('discovery stale collection stays separate and verification findings stop for a human', async () => {
  const staleDiscovery = new FakeClient();
  staleDiscovery.metadata.headRefOid = OTHER_HEAD;
  const discovery = workflow(pendingState('discovery'), staleDiscovery);
  await assert.rejects(() => discovery.api.collect(2), { code: 'DISCOVERY_COLLECTION_UNRESOLVED' });
  assert.equal(discovery.state.calls.some((call) => call.name === 'checkpointVerificationEscalation'), false);

  const findingsClient = new FakeClient();
  findingsClient.reviews.push({
    id: 'PRR_review', databaseId: 3, url: 'https://x/findings', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  addThread(findingsClient, { root: rootComment('THREAD_1', { pullRequestReview: { id: 'PRR_review' } }) });
  const findings = await workflow(pendingState(), findingsClient).api.collect(2);
  assert.equal(findings.outcome.outcome, 'findings');
  assert.equal(findings.phase, 'awaiting-human-decision');
});

test('bounded request allowance is checked before GitHub mutation', async () => {
  for (const state of [
    pendingState('verification'),
    readyState(),
  ]) {
    const client = new FakeClient();
    const { api } = workflow(state, client);
    await assert.rejects(() => api.request(2, 'verification'), { code: 'REQUEST_NOT_READY' });
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  }
});

test('complete performs fresh live proof and uses guarded completion only when exact clean state applies', async () => {
  const goodClient = new FakeClient();
  goodClient.reviews.push({
    id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  const good = workflow(completedState(), goodClient);
  const result = await good.api.complete(2);
  assert.equal(result.phase, 'complete');
  assert.equal(good.state.calls.at(-1).name, 'checkpointCompletion');

  const unresolvedClient = new FakeClient();
  addThread(unresolvedClient);
  await assert.rejects(() => workflow(completedState(), unresolvedClient).api.complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
  const driftClient = new FakeClient();
  driftClient.metadata.headRefOid = OTHER_HEAD;
  await assert.rejects(() => workflow(completedState(), driftClient).api.complete(2), {
    code: 'MUTATION_NOT_READY',
  });
  await assert.rejects(() => workflow(completedState(), new FakeClient()).api.complete(2), {
    code: 'COMPLETION_NOT_READY',
  });
  const unrecordedResolved = new FakeClient();
  addThread(unrecordedResolved, { resolved: true });
  unrecordedResolved.reviews.push({
    id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  await assert.rejects(() => workflow(completedState(), unrecordedResolved).api.complete(2), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
});

test('CLI exposes exactly the documented explicit-PR command surface and JSON-ready results', async () => {
  assert.match(usage(), /status[\s\S]*reply-resolve[\s\S]*request[\s\S]*collect[\s\S]*complete/u);
  await assert.rejects(() => runCli(['status'], {}), /--pr/u);
  await assert.rejects(() => runCli(['unknown', '--pr', '2'], {}), /Unknown command/u);
  await assert.rejects(() => runCli(['request', '--pr', '2', '--kind', 'other'], {}), /discovery\|verification/u);
  const client = new FakeClient();
  const state = fakeState(stateFixture());
  const result = await runCli(['status', '--pr', '2'], {
    client, state, git: fakeGit(), clock: { now: () => AT }, journal: fakeJournal(),
  });
  assert.equal(result.prNumber, 2);
});

test('reply-resolve validates the full task plan before any mutation', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks.push({
    id: 'task-bad', sourceIds: ['local'], sourceType: 'local', fingerprint: 'bad', summary: 'Bad',
    severity: 'P1', disposition: 'actionable', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
  });
  const { api } = workflow(state, client);
  await assert.rejects(() => api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
});

test('shared-root reply deterministically includes every mapped task', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks.push({ ...state.tasks[0], id: 'task-second', fingerprint: 'fp-second', integratedCommitSha: OTHER_HEAD });
  const { api } = workflow(state, client);
  await api.replyResolve(2, 'task-thread');
  const body = client.calls.find((call) => call.name === 'AddThreadReply').variables.body;
  assert.match(body, /task-second: b{40}/u);
  assert.match(body, /task-thread: a{40}/u);
  assert.ok(body.indexOf('task-second') < body.indexOf('task-thread'));
});

test('reply recovery rejects foreign, altered, and prior-head markers', async () => {
  for (const variant of ['foreign', 'altered', 'prior']) {
    const client = new FakeClient();
    const operationId = `reply:2:THREAD_1:${HEAD}`;
    const baseBody = `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`;
    const reply = {
      id: `REPLY_${variant}`, databaseId: 901, url: 'https://x/reply', createdAt: AT,
      author: variant === 'foreign' ? BOT : VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: variant === 'altered' ? `${baseBody}\naltered`
        : variant === 'prior' ? baseBody.replace(markerFor(operationId), markerFor(`reply:2:THREAD_1:${OTHER_HEAD}`)) : baseBody,
    };
    addThread(client, { replies: [reply] });
    await assert.rejects(() => workflow(integratedThreadState(), client).api.replyResolve(2, 'task-thread'), {
      code: 'REPLY_AMBIGUOUS',
    });
    assert.equal(client.calls.some((call) => call.name === 'AddThreadReply'), false);
  }
});

test('pre-resolved root without durable proof requires a pre-existing resolve intent', async () => {
  const client = new FakeClient();
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  addThread(client, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
  }] });
  const { api } = workflow(integratedThreadState(), client);
  await assert.rejects(() => api.replyResolve(2, 'task-thread'), { code: 'RESOLUTION_PROOF_MISSING' });
  assert.equal(client.events.length, 0);
});

test('pre-resolved root is adopted only from its pre-existing resolve intent timestamp', async () => {
  const client = new FakeClient();
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  addThread(client, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
  }] });
  const resolveOperation = `resolve:2:THREAD_1:${HEAD}`;
  const journal = fakeJournal([], [{
    ...priorIntent('resolve', resolveOperation),
  }]);
  const { api, state } = workflow(integratedThreadState(), client, { journal });
  await api.replyResolve(2, 'task-thread');
  assert.equal(state.current.threadResolutionStatus.threads[0].resolvedAt, AT);
  assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
});

test('request recovery uses numeric timestamps, viewer node identity, and logical ordinal', async () => {
  const client = new FakeClient();
  client.comments.push({ id: 'IC_numeric', databaseId: 8, url: 'https://x/8', body: '@codex review',
    createdAt: '2026-08-04T23:59:59.500Z', author: VIEWER });
  const operationId = `request:2:discovery:1:${HEAD}`;
  const journal = fakeJournal([], [priorIntent('request', operationId)]);
  const { api } = workflow(readyState(), client, { journal, clock: { now: () => AT } });
  const result = await api.request(2, 'discovery');
  assert.equal(result.recovered, true);
  assert.ok(journal.intents.has(`request:2:discovery:1:${HEAD}`));

  const noId = new FakeClient();
  noId.metadata.viewer = { login: VIEWER.login };
  await assert.rejects(() => workflow(readyState(), noId).api.request(2, 'discovery'), { code: 'GRAPHQL_TRUNCATED' });
});

test('collect rejects altered or foreign recorded request comments', async () => {
  for (const mutate of [
    (comment) => { comment.body = 'altered'; },
    (comment) => { comment.author = BOT; },
  ]) {
    const client = new FakeClient();
    const state = pendingState('discovery');
    const setup = workflow(state, client);
    mutate(client.comments[0]);
    await assert.rejects(() => setup.api.collect(2), { code: 'REQUEST_PROOF_STALE' });
  }
});

test('verification treats unsupported review states and stale-plus-exact evidence as ambiguous', async () => {
  for (const reviews of [
    [{ id: 'PENDING', state: 'PENDING', commit: { oid: HEAD } }],
    [{ id: 'EXACT', state: 'COMMENTED', commit: { oid: HEAD } }, { id: 'STALE', state: 'COMMENTED', commit: { oid: OTHER_HEAD } }],
  ]) {
    const client = new FakeClient();
    client.reviews = reviews.map((review) => ({ databaseId: 1, url: 'https://x/review', body: '', submittedAt: AT, author: BOT, ...review }));
    const { api } = workflow(pendingState('verification'), client);
    const result = await api.collect(2);
    assert.equal(result.escalated, true);
  }
});

test('fresh request intent never adopts an earlier same-head viewer comment', async () => {
  const client = new FakeClient();
  client.comments.push({ id: 'IC_manual', databaseId: 8, url: 'https://x/manual', body: '@codex review',
    createdAt: '2026-08-04T23:59:59.500Z', author: VIEWER });
  const journal = fakeJournal();
  const setup = workflow(readyState(), client, { journal });
  await assert.rejects(() => setup.api.request(2, 'discovery'), { code: 'REQUEST_BASELINE_COLLISION' });
  await assert.rejects(() => setup.api.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_MISSING' });
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 0);
  assert.equal(setup.state.calls.length, 0);
});

test('a fresh later ordinal excludes prior review-history request IDs', async () => {
  const prior = completedState();
  const state = { ...prior, phase: 'ready-for-review',
    nextAction: 'Request another discovery review.' };
  const client = new FakeClient();
  client.comments.push({ id: 'IC_request', databaseId: 101,
    url: 'https://github.com/example/sky-bar/pull/2#issuecomment-101', body: '@codex review',
    createdAt: AT, author: VIEWER });
  const journal = fakeJournal();
  const setup = workflow(state, client, { journal });
  const result = await setup.api.request(2, 'discovery');
  assert.notEqual(result.request.id, 'IC_request');
  assert.ok(journal.intents.has(`request:2:discovery:2:${HEAD}`));
});

test('malformed pre-existing resolve intents cannot adopt a live resolved root', async () => {
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  const resolveOperation = `resolve:2:THREAD_1:${HEAD}`;
  for (const intent of [
    { ...priorIntent('reply', resolveOperation) },
    { ...priorIntent('resolve', resolveOperation), clientMutationId: 'wrong' },
    { ...priorIntent('resolve', resolveOperation), at: 'not-a-time' },
  ]) {
    const client = new FakeClient();
    addThread(client, { resolved: true, replies: [{
      id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
    }] });
    const setup = workflow(integratedThreadState(), client, { journal: fakeJournal([], [intent]) });
    await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
    assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  }
});

test('verification request anchor drift escalates while discovery remains fail-closed', async () => {
  for (const changedHead of [false, true]) {
    const client = new FakeClient();
    const setup = workflow(pendingState('verification'), client);
    client.comments[0].body = 'edited';
    if (changedHead) client.metadata.headRefOid = OTHER_HEAD;
    const result = await setup.api.collect(2);
    assert.equal(result.escalated, true);
    assert.equal(result.escalation.reason, changedHead ? 'request-head-drift' : 'ambiguous-canonical-evidence');
  }
  const discovery = workflow(pendingState('discovery'));
  discovery.client.comments[0].createdAt = '2026-08-05T00:00:00.001Z';
  await assert.rejects(() => discovery.api.collect(2), { code: 'REQUEST_PROOF_STALE' });
});

test('canonical outcome evidence has no early timestamp tolerance', async () => {
  const client = new FakeClient();
  const setup = workflow(pendingState('verification'), client);
  client.reactions.set('IC_request', [{ id: 'REACTION_early', content: 'THUMBS_UP',
    createdAt: '2026-08-04T23:59:59.999Z', user: BOT }]);
  const result = await setup.api.collect(2);
  assert.equal(result.escalated, true);
  assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence');
});

test('needs-human-decision disposition cannot resolve a thread or journal a mutation', async () => {
  const client = new FakeClient();
  addThread(client);
  const state = integratedThreadState();
  state.tasks[0] = { ...state.tasks[0], disposition: 'needs-human-decision', status: 'not-applicable',
    integratedCommitSha: null, resolutionSummary: 'Requires a human decision.' };
  const setup = workflow(state, client);
  await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
  assert.equal(client.events.length, 0);
});

test('historical resolved proof survives a later-head validation, request, collection, and completion', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const oldOperation = `reply:2:THREAD_1:${HEAD}`;
  const root = addThread(client, { resolved: true, replies: [{
    id: 'REPLY_old', databaseId: 901, url: 'https://x/old-reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: old validation.\n${markerFor(oldOperation)}`,
  }] });
  const task = integratedThreadState().tasks[0];
  task.status = 'completed';
  const historical = readyState({
    currentIntegrationHeadSha: OTHER_HEAD,
    git: { branch: 'main', headSha: OTHER_HEAD, dirty: false },
    validationStatus: { status: 'passed', headSha: OTHER_HEAD, checks: ['new validation'], updatedAt: AT },
    tasks: [task],
    threadResolutionStatus: {
      status: 'passed', headSha: OTHER_HEAD, updatedAt: AT,
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
        taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_old', replyUrl: 'https://x/old-reply',
        isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD }],
    },
  });
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(historical, client, { git });
  const requested = await setup.api.request(2, 'discovery');
  client.reactions.set(requested.request.id, [{ id: 'REACTION_clean', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  await setup.api.collect(2);
  const completed = await setup.api.complete(2);
  assert.equal(completed.completed, true);
  assert.equal(setup.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('every existing unresolved proof mismatch fails before journaling or mutation', async () => {
  for (const mutate of [
    (record) => { record.rootCommentNodeId = 'ROOT_wrong'; },
    (record) => { record.taskIds = ['task-other']; },
    (record) => { record.disposition = 'duplicate'; },
  ]) {
    const client = new FakeClient();
    const root = addThread(client);
    const record = { threadNodeId: 'THREAD_1', rootCommentNodeId: root.id,
      rootCommentDatabaseId: root.databaseId, taskIds: ['task-thread'], disposition: 'fixed',
      replyId: null, replyUrl: null, isResolved: false, resolvedAt: null, resolvedBy: null,
      observedHeadSha: HEAD };
    mutate(record);
    const state = integratedThreadState();
    state.threadResolutionStatus = { status: 'failed', headSha: HEAD, updatedAt: AT,
      threads: [record], threadlessVerification: proof().threadlessVerification };
    const setup = workflow(state, client);
    await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), GitHubWorkflowError);
    assert.equal(client.events.length, 0);
  }
});

test('unresolved head-A provenance is preserved when reply and resolution occur at head B', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const root = addThread(client);
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: null, replyUrl: null,
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const first = workflow(state, client, { git });
  await first.api.replyResolve(2, 'task-thread');
  const record = first.state.current.threadResolutionStatus.threads[0];
  assert.equal(record.observedHeadSha, HEAD);
  assert.match(client.threadComments.get('THREAD_1').at(-1).body,
    new RegExp(`Sky Bar review resolution at ${OTHER_HEAD}`, 'u'));

  const ready = { ...first.state.current, phase: 'ready-for-review', nextAction: 'Request review.' };
  const second = workflow(ready, client, { git });
  const requested = await second.api.request(2, 'discovery');
  client.reactions.set(requested.request.id, [{ id: 'REACTION_B', content: 'THUMBS_UP', createdAt: AT, user: BOT }]);
  await second.api.collect(2);
  assert.equal((await second.api.complete(2)).completed, true);
  assert.equal(second.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('paired unresolved recorded reply is reused and resolved without posting another reply', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const operationId = `reply:2:THREAD_1:${OTHER_HEAD}`;
  const root = addThread(client, { replies: [{ id: 'REPLY_paired', databaseId: 902, url: 'https://x/paired',
    createdAt: AT, author: VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Sky Bar review resolution at ${OTHER_HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-B check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_paired', replyUrl: 'https://x/paired',
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(state, client, { git });
  await setup.api.replyResolve(2, 'task-thread');
  assert.equal(client.calls.some((call) => call.name === 'AddThreadReply'), false);
  assert.equal(client.calls.filter((call) => call.name === 'ResolveThread').length, 1);
  assert.equal(setup.state.current.threadResolutionStatus.threads[0].observedHeadSha, HEAD);
});

test('paired unresolved reply from a prior head fails before journal or GitHub mutation', async () => {
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  const root = addThread(client, { replies: [{ id: 'REPLY_stale', databaseId: 903, url: 'https://x/stale',
    createdAt: AT, author: VIEWER, replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Sky Bar review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-A check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
  state.threadResolutionStatus = { status: 'failed', headSha: OTHER_HEAD, updatedAt: AT,
    threadlessVerification: proof().threadlessVerification,
    threads: [{ threadNodeId: 'THREAD_1', rootCommentNodeId: root.id, rootCommentDatabaseId: root.databaseId,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_stale', replyUrl: 'https://x/stale',
      isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: HEAD }] };
  const git = fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }), pushedHead: async () => OTHER_HEAD });
  const setup = workflow(state, client, { git });
  await assert.rejects(() => setup.api.replyResolve(2, 'task-thread'), { code: 'THREAD_PROOF_STALE' });
  assert.equal(client.events.length, 0);
});
