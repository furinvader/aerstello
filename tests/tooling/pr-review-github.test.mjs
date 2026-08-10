import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  createGitHubReviewWorkflow,
  GitHubWorkflowError,
  githubReviewConstants,
  readTopLevelComments,
} from '../../scripts/lib/pr-review-github.mjs';
import {
  buildGhGraphqlArgs,
  createDefaultGitHubClient,
  renderHumanStatus,
  runCli,
  usage,
} from '../../scripts/pr-review-github.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const PRIOR_INTEGRATION_HEAD = '4b8d4d36dd6ea4da9d1c1a0e39033a829e1852f9';
const SELECTED_TASK_HEAD = '7ea9bbccc60725dcfd0cfefcb0caff742145b8ec';
const AT = '2026-08-05T00:00:00Z';
const AUTHORIZED_AT = '2026-08-09T21:30:00Z';
const NOT_BEFORE = '2026-08-10T13:00:00Z';
const BOT = {
  __typename: 'Bot', login: 'chatgpt-codex-connector',
  url: 'https://github.com/apps/chatgpt-codex-connector', id: 'BOT_codex',
};
const VIEWER = { __typename: 'User', login: 'maintainer', url: 'https://github.com/maintainer', id: 'USER_1' };
const CLEAN_COMMENT_BODY = `${githubReviewConstants.CLEAN_ISSUE_COMMENT_TEMPLATE}\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\n\n<details>About Codex</details>`;
const CLEAN_TADA_COMMENT_BODY = `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${HEAD}\`\n\n<details>About Codex</details>`;

function withDuplicateCleanAnchor(body, sha) {
  return `${body}\n\n**Reviewed commit:** \`${sha}\``;
}

function proof(status = 'passed', headSha = HEAD) {
  return {
    status, headSha: status === 'not-run' ? null : headSha, threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    localVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    updatedAt: status === 'not-run' ? null : AT,
  };
}

function stateFixture(overrides = {}) {
  return {
    schemaVersion: 5, revision: 1, repository: 'example/aerstello', prNumber: 2, phase: 'recovering',
    baseSha: HEAD, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: HEAD,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [],
    verificationEscalation: null, humanFinalReviewAuthorization: null,
    postFinalRemediationAuthorization: null,
    threadResolutionStatus: proof('not-run'), blockedReasons: [],
    validationStatus: { source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null },
    ciValidationStatus: { source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
      checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null },
    ciValidationHistory: [],
    nextAction: 'Recover.', integrationWorktree: '/tmp/integration', orchestratorSessionId: null,
    abandonmentReason: null, git: { branch: 'main', headSha: HEAD, dirty: false }, updatedAt: AT,
    ...overrides,
  };
}

function readyState(overrides = {}) {
  const state = stateFixture({
    phase: 'ready-for-review',
    validationStatus: { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD, checks: ['npm run check'], updatedAt: AT },
    threadResolutionStatus: proof(), nextAction: 'Request review.',
    ...overrides,
  });
  if (!Object.hasOwn(overrides, 'threadResolutionStatus')) {
    const localTaskIds = state.tasks.filter((task) => task.sourceType === 'local' && task.status === 'completed')
      .map((task) => task.id).sort();
    if (localTaskIds.length > 0) {
      state.threadResolutionStatus.localVerification = {
        status: 'passed', headSha: state.currentIntegrationHeadSha, taskIds: localTaskIds, updatedAt: AT,
      };
    }
  }
  return state;
}

function requestEvidence(kind = 'verification', overrides = {}) {
  return {
    id: 'IC_request', databaseId: 101, url: 'https://github.com/example/aerstello/pull/2#issuecomment-101',
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
    id: 'PRR_clean', databaseId: 201, url: 'https://github.com/example/aerstello/pull/2#pullrequestreview-201',
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

function tasklessReviewHeadDriftState(overrides = {}) {
  const exactHead = completedState();
  const request = { ...exactHead.reviewRequest, headSha: OTHER_HEAD };
  const outcome = {
    ...exactHead.reviewOutcome,
    headSha: OTHER_HEAD,
    requestId: request.id,
    kind: request.kind,
  };
  return stateFixture({
    phase: 'recovering',
    requestedHeadSha: OTHER_HEAD,
    reviewedHeadSha: OTHER_HEAD,
    reviewRound: 1,
    reviewRequest: request,
    reviewOutcome: outcome,
    reviewHistory: [{ request, outcome }],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Rebuild current-head empty-thread proof before the next review.',
    ...overrides,
  });
}

function cleanReviewEntry(index, kind, headSha = OTHER_HEAD) {
  const request = requestEvidence(kind, {
    id: `IC_${kind}_${index}`,
    databaseId: 100 + index,
    url: `https://github.com/example/aerstello/pull/2#issuecomment-${100 + index}`,
    headSha,
  });
  const outcome = {
    id: `PRR_${kind}_${index}`,
    databaseId: 200 + index,
    url: `https://github.com/example/aerstello/pull/2#pullrequestreview-${200 + index}`,
    headSha,
    at: AT,
    requestId: request.id,
    kind,
    outcome: 'clean',
    evidenceType: 'review-submission',
    reviewerLogin: BOT.login,
    reviewerNodeId: BOT.id,
    reviewerType: BOT.__typename,
    reviewerUrl: BOT.url,
    reactionContent: null,
    reactionCommentId: null,
  };
  return { request, outcome };
}

function humanFinalAuthorizedState(overrides = {}) {
  const reviewHistory = [
    cleanReviewEntry(1, 'discovery', HEAD),
    cleanReviewEntry(2, 'discovery', HEAD),
    cleanReviewEntry(3, 'discovery', HEAD),
    cleanReviewEntry(4, 'verification', HEAD),
  ];
  reviewHistory[3].outcome = { ...reviewHistory[3].outcome, outcome: 'findings' };
  const latest = reviewHistory.at(-1);
  return readyState({
    phase: 'awaiting-human-decision', requestedHeadSha: HEAD, reviewedHeadSha: HEAD,
    reviewRound: 3, verificationReviewUsed: true,
    decisions: [{ id: 'decision-final', summary: 'Authorize one time-gated human-final review.' }],
    reviewRequest: latest.request, reviewOutcome: latest.outcome, reviewHistory,
    humanFinalReviewAuthorization: {
      decisionId: 'decision-final', source: 'operator-instruction', authorizedAt: AUTHORIZED_AT,
      verificationOutcomeId: latest.outcome.id, notBefore: NOT_BEFORE,
      summary: 'One operator-authorized final review.',
    },
    nextAction: 'Request the human-final review at the trusted time.',
    ...overrides,
  });
}

function pendingHumanFinalState(overrides = {}) {
  const authorized = humanFinalAuthorizedState();
  const request = requestEvidence('human-final', {
    id: 'IC_human_final_request', databaseId: 301,
    url: 'https://github.com/example/sky-bar/pull/2#issuecomment-301', at: NOT_BEFORE,
  });
  return {
    ...authorized,
    phase: 'awaiting-review', requestedHeadSha: HEAD, reviewedHeadSha: null,
    reviewRequest: request, reviewOutcome: null,
    reviewHistory: [...authorized.reviewHistory, { request, outcome: null }],
    nextAction: 'Collect the exact human-final outcome.',
    ...overrides,
  };
}

function postFinalRemediationAuthorizedState(overrides = {}) {
  const pending = pendingHumanFinalState();
  const outcome = {
    id: 'PRR_human_final_findings', databaseId: 401,
    url: 'https://github.com/example/sky-bar/pull/2#pullrequestreview-401',
    headSha: HEAD, at: '2026-08-10T13:05:00Z', requestId: pending.reviewRequest.id,
    kind: 'human-final', outcome: 'findings', evidenceType: 'review-submission',
    reviewerLogin: BOT.login, reviewerNodeId: BOT.id, reviewerType: BOT.__typename,
    reviewerUrl: BOT.url, reactionContent: null, reactionCommentId: null,
  };
  return {
    ...pending,
    phase: 'awaiting-human-decision', reviewedHeadSha: HEAD,
    decisions: [
      ...pending.decisions,
      { id: 'decision-post-final', summary: 'Authorize remediation-only work.' },
    ],
    reviewOutcome: outcome,
    reviewHistory: pending.reviewHistory.map((entry, index) => (
      index === pending.reviewHistory.length - 1 ? { ...entry, outcome } : entry
    )),
    postFinalRemediationAuthorization: {
      decisionId: 'decision-post-final', source: 'operator-instruction',
      authorizedAt: '2026-08-10T13:06:00Z', humanFinalOutcomeId: outcome.id,
      summary: 'Remediate the final findings without another review request.',
    },
    nextAction: 'Remediate and validate without another review request.',
    ...overrides,
  };
}

function canonicalReview(overrides = {}) {
  return {
    id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT, ...overrides,
  };
}

function cleanIssueComment(overrides = {}) {
  return {
    id: 'IC_clean', databaseId: 202,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-202',
    body: CLEAN_COMMENT_BODY, createdAt: AT, lastEditedAt: null, author: BOT, ...overrides,
  };
}

function issueCommentCompletedState(overrides = {}) {
  const state = completedState();
  const comment = cleanIssueComment();
  const outcome = {
    ...state.reviewOutcome, id: comment.id, databaseId: comment.databaseId, url: comment.url,
    at: comment.createdAt, evidenceType: 'issue-comment',
  };
  return { ...state, reviewOutcome: outcome, reviewHistory: [{ request: state.reviewRequest, outcome }], ...overrides };
}

function findingsState(overrides = {}) {
  const state = completedState({ phase: 'triaging', nextAction: 'Triage findings.', ...overrides });
  state.reviewOutcome = { ...state.reviewOutcome, outcome: 'findings' };
  state.reviewHistory = [{ request: state.reviewRequest, outcome: state.reviewOutcome }];
  return state;
}

function rootComment(threadId = 'THREAD_1', overrides = {}) {
  return {
    id: `ROOT_${threadId}`, databaseId: threadId === 'THREAD_1' ? 41 : 42,
    url: `https://github.com/example/aerstello/pull/2#discussion_r${threadId}`,
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

function fullValidationCheck(overrides = {}) {
  return {
    __typename: 'CheckRun', id: 'CHECK_full', databaseId: 301, name: 'Full validation',
    status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: AT,
    detailsUrl: 'https://github.com/example/aerstello/actions/runs/701/job/301',
    checkSuite: {
      app: { slug: 'github-actions' },
      workflowRun: {
        databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      },
    },
    ...overrides,
  };
}

class FakeClient {
  constructor(overrides = {}) {
    this.metadata = {
      id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
      headRefOid: HEAD, viewer: VIEWER,
    };
    this.comments = [];
    this.reviews = [];
    this.threads = [];
    this.threadComments = new Map();
    this.reactions = new Map();
    this.ciContexts = [fullValidationCheck()];
    this.rollupState = 'SUCCESS';
    this.checkHeadSha = null;
    this.calls = [];
    this.events = overrides.events ?? [];
    this.pageSize = overrides.pageSize ?? 1;
    this.remaining = overrides.remaining ?? 5000;
    this.graphqlErrors = overrides.graphqlErrors ?? new Set();
    this.noEffect = overrides.noEffect ?? new Set();
    this.requestCreatedAt = overrides.requestCreatedAt ?? AT;
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
    if (name === 'PullRequestChecks') {
      const headSha = this.checkHeadSha ?? this.metadata.headRefOid;
      return this.result({ repository: { pullRequest: {
        number: this.metadata.number, headRefOid: this.metadata.headRefOid,
        commits: { nodes: [{ commit: { oid: headSha, statusCheckRollup: {
          state: this.rollupState,
          contexts: connection(this.ciContexts, variables.cursor, this.pageSize),
        } } }] },
      } } });
    }
    this.events.push(`mutation:${name}`);
    if (name === 'AddReviewRequest' && !this.noEffect.has(name)) {
      this.comments.push({
        id: `IC_${this.comments.length + 1}`, databaseId: 500 + this.comments.length,
        url: 'https://github.com/example/aerstello/pull/2#issuecomment-new', body: variables.body,
        createdAt: this.requestCreatedAt, author: this.metadata.viewer,
      });
    }
    if (name === 'AddThreadReply' && !this.noEffect.has(name)) {
      const comments = this.threadComments.get(variables.threadId);
      comments.push({
        id: `REPLY_${comments.length}`, databaseId: 900 + comments.length,
        url: 'https://github.com/example/aerstello/pull/2#discussion_reply', body: variables.body,
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
    resolveCommitPrefix: async (prefix) => HEAD.startsWith(prefix) ? [HEAD] : [],
    ...overrides,
  };
}

function fakeJournal(events = [], existing = []) {
  const intents = new Map();
  for (const intent of existing) {
    if (!intents.has(intent.operationId)) intents.set(intent.operationId, intent);
  }
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

function racingRequestJournal(intent, events = []) {
  let concurrentIntent = null;
  return {
    async lookupIntent() {
      return concurrentIntent ? { ...concurrentIntent, isNew: false } : null;
    },
    async ensureIntent() {
      events.push('intent:request');
      concurrentIntent = structuredClone(intent);
      return { ...concurrentIntent, isNew: false };
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
    async checkpointCiValidation(input) {
      calls.push({ name: 'checkpointCiValidation', input });
      const duplicate = current.ciValidationHistory.find((entry) => entry.checkRunId === input.evidence.checkRunId);
      if (!duplicate) {
        current = { ...current, revision: current.revision + 1,
          ciValidationStatus: input.evidence,
          ciValidationHistory: [...current.ciValidationHistory, input.evidence] };
      }
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
        phase: ['verification', 'human-final'].includes(outcome.kind) && outcome.outcome === 'findings'
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
      const verifiedLocal = new Set(input.verifiedLocalTaskIds ?? []);
      const priorLocal = current.threadResolutionStatus.localVerification ?? proof('not-run').localVerification;
      const retainedLocalIds = priorLocal.status === 'passed'
          && priorLocal.headSha === current.currentIntegrationHeadSha
        ? priorLocal.taskIds : [];
      const { localVerification: _untrustedLocal, ...inputWithoutLocal } = input.threadResolutionStatus;
      const preservedThreadResolutionStatus = Object.hasOwn(current.threadResolutionStatus, 'localVerification')
        ? { ...inputWithoutLocal, localVerification: priorLocal } : inputWithoutLocal;
      const threadResolutionStatus = verifiedLocal.size > 0 ? {
        ...inputWithoutLocal,
        localVerification: {
          status: 'passed', headSha: current.currentIntegrationHeadSha,
          taskIds: [...new Set([...retainedLocalIds, ...verifiedLocal])].sort(),
          updatedAt: input.threadResolutionStatus.updatedAt,
        },
      } : preservedThreadResolutionStatus;
      const covered = new Set(threadResolutionStatus.threads.filter((thread) => thread.isResolved).flatMap((thread) => thread.taskIds));
      if (threadResolutionStatus.threadlessVerification.status === 'passed') {
        threadResolutionStatus.threadlessVerification.taskIds.forEach((taskId) => covered.add(taskId));
      }
      const tasks = current.tasks.map((task) => (
        covered.has(task.id) || (task.sourceType === 'local' && verifiedLocal.has(task.id))
          ? { ...task, status: 'completed' } : task
      ));
      const next = { ...current, threadResolutionStatus, tasks };
      current = {
        ...next, revision: current.revision + 1,
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
  return `<!-- aerstello-review:${createHash('sha256').update(operationId).digest('hex').slice(0, 24)} -->`;
}

function priorIntent(type, operationId, at = AT) {
  return { type, operationId,
    clientMutationId: `aerstello-${createHash('sha256').update(operationId).digest('hex').slice(0, 24)}`, at,
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
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestChecks').length, 1);
  assert.equal(result.statePhase, 'recovering');
  assert.equal(result.liveCiValidation.status, 'passed');
});

test('status marks preserved review evidence stale after both recorded and live HEAD advance', async () => {
  const drift = {
    phase: 'recovering', currentIntegrationHeadSha: OTHER_HEAD,
    git: { branch: 'main', headSha: OTHER_HEAD, dirty: false },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null,
      checks: [], updatedAt: null,
    },
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Reconcile the changed integration checkout.',
  };
  for (const state of [completedState(drift), findingsState(drift), pendingState('discovery', drift)]) {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const result = await workflow(state, client).api.status(2);
    assert.equal(result.codexReview, 'stale');
    assert.match(renderHumanStatus(result), /Codex review: Stale review evidence \(commit mismatch\)/u);
  }
});

test('status preserves exact-head review states', async () => {
  for (const [state, expected] of [
    [stateFixture(), 'not-requested'],
    [pendingState('discovery'), 'awaiting'],
    [completedState(), 'clean'],
    [findingsState(), 'findings'],
  ]) {
    const result = await workflow(state).api.status(2);
    assert.equal(result.codexReview, expected);
  }
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

test('collect-ci paginates the exact-head rollup and records the latest authoritative workflow run', async () => {
  const client = new FakeClient({ pageSize: 1 });
  client.ciContexts = [
    { __typename: 'StatusContext', id: 'STATUS_lint', context: 'lint', state: 'SUCCESS', targetUrl: 'https://github.com/example/aerstello' },
    fullValidationCheck({ id: 'CHECK_old', completedAt: '2026-08-04T23:00:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: { databaseId: 700,
        url: 'https://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } } } }),
    fullValidationCheck(),
  ];
  const setup = workflow(stateFixture(), client);
  const result = await setup.api.collectCi(2);
  assert.deepEqual(result.evidence, {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation'], checkRunId: 'CHECK_full', workflowRunId: 701,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/701', updatedAt: AT,
  });
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestChecks').length >= 3);
  assert.match(client.calls.find((call) => call.name === 'PullRequestChecks').query,
    /workflowRun\{databaseId url file\{path\} workflow\{name\}\}/u);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
});

test('collect-ci evidence is unchanged by unrelated rollup contexts', async () => {
  const authoritative = fullValidationCheck();
  const unrelatedCheck = {
    __typename: 'CheckRun', id: 'CHECK_lint', databaseId: 302, name: 'lint',
    status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: AT,
    detailsUrl: 'https://github.com/example/aerstello/actions/runs/800/job/302', checkSuite: null,
  };
  const unrelatedStatus = {
    __typename: 'StatusContext', id: 'STATUS_lint', context: 'legacy lint',
    state: 'SUCCESS', targetUrl: 'https://github.com/example/aerstello',
  };
  const client = new FakeClient({ ciContexts: [unrelatedStatus, authoritative, unrelatedCheck] });
  const setup = workflow(stateFixture(), client);
  const first = await setup.api.collectCi(2);
  assert.deepEqual(first.evidence.checks, ['Full validation']);
  const revision = setup.state.current.revision;
  const historyLength = setup.state.current.ciValidationHistory.length;

  for (const contexts of [
    [unrelatedCheck, authoritative, { ...unrelatedStatus, context: 'renamed status', state: 'FAILURE' }],
    [authoritative],
    [authoritative, { ...unrelatedCheck, id: 'CHECK_other', name: 'unrelated changed check' }],
  ]) {
    client.ciContexts = contexts;
    const repeated = await setup.api.collectCi(2);
    assert.deepEqual(repeated.evidence, first.evidence);
    assert.equal(setup.state.current.revision, revision);
    assert.equal(setup.state.current.ciValidationHistory.length, historyLength);
  }
});

test('collect-ci appends distinct check attempts for one rerun workflow and is idempotent per check', async () => {
  const client = new FakeClient({
    rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ id: 'CHECK_attempt_1', conclusion: 'FAILURE' })],
  });
  const setup = workflow(stateFixture(), client);
  assert.equal((await setup.api.collectCi(2)).evidence.status, 'failed');
  client.rollupState = 'SUCCESS';
  client.ciContexts = [fullValidationCheck({
    id: 'CHECK_attempt_2', conclusion: 'SUCCESS', completedAt: '2026-08-05T00:01:00Z',
  })];
  const successful = await setup.api.collectCi(2);
  assert.equal(successful.evidence.status, 'passed');
  assert.equal(successful.evidence.workflowRunId, 701);
  assert.equal(successful.evidence.checkRunId, 'CHECK_attempt_2');
  assert.deepEqual(setup.state.current.ciValidationHistory.map((entry) => entry.checkRunId), [
    'CHECK_attempt_1', 'CHECK_attempt_2',
  ]);
  const revision = setup.state.current.revision;
  await setup.api.collectCi(2);
  assert.equal(setup.state.current.revision, revision);
});

test('collect-ci supersedes failures only within the same workflow run', async () => {
  const sameRun = new FakeClient({ ciContexts: [
    fullValidationCheck({
      id: 'CHECK_failed_attempt', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z',
    }),
    fullValidationCheck({ id: 'CHECK_successful_rerun' }),
  ] });
  const rerunEvidence = (await workflow(stateFixture(), sameRun).api.collectCi(2)).evidence;
  assert.equal(rerunEvidence.status, 'passed');
  assert.equal(rerunEvidence.checkRunId, 'CHECK_successful_rerun');
  assert.equal(rerunEvidence.workflowRunId, 701);

  const distinctRuns = new FakeClient({ rollupState: 'FAILURE', ciContexts: [
    fullValidationCheck({
      id: 'CHECK_failed_parallel', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 700, url: 'https://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
    fullValidationCheck({ id: 'CHECK_newer_success' }),
  ] });
  const failedEvidence = (await workflow(stateFixture(), distinctRuns).api.collectCi(2)).evidence;
  assert.equal(failedEvidence.status, 'failed');
  assert.equal(failedEvidence.checkRunId, 'CHECK_failed_parallel');
  assert.equal(failedEvidence.workflowRunId, 700);
  assert.equal(failedEvidence.workflowRunUrl, 'https://github.com/example/aerstello/actions/runs/700');
  assert.equal(failedEvidence.updatedAt, '2026-08-04T23:59:00Z');
});

test('collect-ci records a completed failed full run but rejects pending, stale, missing, and ambiguous evidence', async () => {
  const failed = new FakeClient({ rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ conclusion: 'FAILURE' })] });
  const failedSetup = workflow(stateFixture(), failed);
  assert.equal((await failedSetup.api.collectCi(2)).evidence.status, 'failed');

  const pending = new FakeClient({ rollupState: 'PENDING',
    ciContexts: [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })] });
  await assert.rejects(() => workflow(stateFixture(), pending).api.collectCi(2), { code: 'CI_VALIDATION_PENDING' });

  const stale = new FakeClient({ checkHeadSha: OTHER_HEAD });
  await assert.rejects(() => workflow(stateFixture(), stale).api.collectCi(2), { code: 'CI_HEAD_MISMATCH' });

  const missing = new FakeClient({ ciContexts: [fullValidationCheck({ name: 'another check' })] });
  await assert.rejects(() => workflow(stateFixture(), missing).api.collectCi(2), { code: 'CI_CHECK_MISSING' });

  const ambiguous = new FakeClient({ ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({ id: 'CHECK_other', checkSuite: { app: { slug: 'github-actions' },
      workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } } } }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), ambiguous).api.collectCi(2), { code: 'CI_EVIDENCE_AMBIGUOUS' });

  const missingAttempt = new FakeClient({ ciContexts: [fullValidationCheck({ id: null })] });
  await assert.rejects(() => workflow(stateFixture(), missingAttempt).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });
});

test('taskless thread refresh records guarded empty proof without GitHub mutation or threadless verification', async () => {
  const initial = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, { id: 'THREAD_noncanonical', root: rootComment('THREAD_noncanonical', { author: VIEWER }) });
  const setup = workflow(initial, client);
  const result = await setup.api.refreshThreads(2);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, proof('not-run').threadlessVerification);
  assert.equal(setup.state.current.phase, 'recovering');
  assert.deepEqual(setup.state.current.tasks, []);
  assert.equal(client.events.length, 0);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointTaskCompletion');

  const requestClient = new FakeClient();
  addThread(requestClient, { resolved: true });
  const requestState = {
    ...setup.state.current, phase: 'ready-for-review', nextAction: 'Request review.',
  };
  const requestSetup = workflow(requestState, requestClient);
  await assert.rejects(() => requestSetup.api.request(2, 'discovery'), { code: 'ROOT_IDENTITY_MISMATCH' });
  assert.equal(requestClient.events.length, 0);
});

test('taskless thread refresh restores empty proof after guarded clean-review HEAD drift', async () => {
  const initial = tasklessReviewHeadDriftState();
  assert.equal(initial.schemaVersion, 5);
  const preserved = {
    reviewRequest: structuredClone(initial.reviewRequest),
    reviewOutcome: structuredClone(initial.reviewOutcome),
    reviewHistory: structuredClone(initial.reviewHistory),
    threadlessVerification: structuredClone(initial.threadResolutionStatus.threadlessVerification),
  };
  const client = new FakeClient({ pageSize: 1 });
  addThread(client, {
    id: 'THREAD_noncanonical_1',
    root: rootComment('THREAD_noncanonical_1', { author: VIEWER }),
  });
  addThread(client, {
    id: 'THREAD_noncanonical_2',
    root: rootComment('THREAD_noncanonical_2', { author: VIEWER }),
  });
  const setup = workflow(initial, client);
  const result = await setup.api.refreshThreads(2);

  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(result.threadResolutionStatus.headSha, HEAD);
  assert.deepEqual(result.threadResolutionStatus.threads, []);
  assert.deepEqual(result.threadResolutionStatus.threadlessVerification, preserved.threadlessVerification);
  assert.equal(setup.state.current.phase, 'recovering');
  assert.deepEqual({
    reviewRequest: setup.state.current.reviewRequest,
    reviewOutcome: setup.state.current.reviewOutcome,
    reviewHistory: setup.state.current.reviewHistory,
    threadlessVerification: setup.state.current.threadResolutionStatus.threadlessVerification,
  }, preserved);
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 2);
  assert.equal(client.events.length, 0);
  assert.deepEqual(setup.state.calls.map((call) => call.name), ['checkpointTaskCompletion']);
});

test('taskless clean-review HEAD-drift refresh fails closed at lifecycle and live-proof boundaries', async () => {
  const unvalidated = tasklessReviewHeadDriftState({
    validationStatus: stateFixture().validationStatus,
  });
  await assert.rejects(() => workflow(unvalidated).api.refreshThreads(2), { code: 'TASK_NOT_READY' });

  const taskBearing = tasklessReviewHeadDriftState({
    tasks: [{
      id: 'unexpected-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'unexpected-task',
      summary: 'Unexpected task.', severity: 'P2', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Completed.',
    }],
  });
  await assert.rejects(() => workflow(taskBearing).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });
  await assert.rejects(() => workflow(tasklessReviewHeadDriftState({
    blockedReasons: ['Operator decision remains.'],
  })).api.refreshThreads(2), { code: 'TASKLESS_REFRESH_NOT_ALLOWED' });

  const sameHead = completedState({
    phase: 'recovering',
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Same-HEAD replacement is not recovery.',
  });
  await assert.rejects(() => workflow(sameHead).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const findings = tasklessReviewHeadDriftState();
  findings.reviewOutcome = { ...findings.reviewOutcome, outcome: 'findings' };
  findings.reviewHistory = [{ request: findings.reviewRequest, outcome: findings.reviewOutcome }];
  await assert.rejects(() => workflow(findings).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const pending = tasklessReviewHeadDriftState({
    reviewedHeadSha: null,
    reviewOutcome: null,
  });
  pending.reviewHistory = [{ request: pending.reviewRequest, outcome: null }];
  await assert.rejects(() => workflow(pending).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const migrated = tasklessReviewHeadDriftState({
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 0, migratedAt: AT },
  });
  await assert.rejects(() => workflow(migrated).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const exhaustedHistory = [
    cleanReviewEntry(1, 'discovery'),
    cleanReviewEntry(2, 'discovery'),
    cleanReviewEntry(3, 'discovery'),
    cleanReviewEntry(4, 'verification'),
  ];
  const exhaustedLatest = exhaustedHistory.at(-1);
  const exhausted = tasklessReviewHeadDriftState({
    requestedHeadSha: OTHER_HEAD,
    reviewedHeadSha: OTHER_HEAD,
    reviewRound: 3,
    verificationReviewUsed: true,
    reviewRequest: exhaustedLatest.request,
    reviewOutcome: exhaustedLatest.outcome,
    reviewHistory: exhaustedHistory,
  });
  await assert.rejects(() => workflow(exhausted).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });

  const inconsistent = tasklessReviewHeadDriftState();
  inconsistent.reviewHistory = [{
    request: inconsistent.reviewRequest,
    outcome: { ...inconsistent.reviewOutcome, id: 'PRR_inconsistent' },
  }];
  await assert.rejects(() => workflow(inconsistent).api.refreshThreads(2), { code: 'INVALID_STATE' });

  const rootedClient = new FakeClient();
  addThread(rootedClient);
  await assert.rejects(() => workflow(tasklessReviewHeadDriftState(), rootedClient).api.refreshThreads(2), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
  assert.equal(rootedClient.events.length, 0);

  for (const git of [
    fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    fakeGit({ snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }) }),
    fakeGit({ pushedHead: async () => OTHER_HEAD }),
  ]) {
    await assert.rejects(() => workflow(tasklessReviewHeadDriftState(), new FakeClient(), { git })
      .api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  }

  const raced = fakeState(tasklessReviewHeadDriftState());
  const originalLoad = raced.load.bind(raced);
  let reads = 0;
  raced.load = async () => {
    const state = await originalLoad();
    reads += 1;
    return reads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: raced, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'STATE_REVISION_CHANGED' });

  class DriftingRecoveryRefreshClient extends FakeClient {
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestThreads') this.metadata.headRefOid = OTHER_HEAD;
      return result;
    }
  }
  const drifted = workflow(tasklessReviewHeadDriftState(), new DriftingRecoveryRefreshClient());
  await assert.rejects(() => drifted.api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  assert.equal(drifted.state.calls.some((call) => call.name === 'checkpointTaskCompletion'), false);
});

test('taskless thread refresh fails closed across task, root, validation, Git, adapter, and state-race boundaries', async () => {
  const validated = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  await assert.rejects(() => workflow(stateFixture()).api.refreshThreads(2), { code: 'TASK_NOT_READY' });
  await assert.rejects(() => workflow({
    ...validated,
    tasks: [{
      id: 'durable-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'durable-task',
      summary: 'Durable task.', severity: 'P2', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Completed.',
    }],
  }).api.refreshThreads(2), {
    code: 'TASKLESS_REFRESH_NOT_ALLOWED',
  });
  for (const resolved of [false, true]) {
    const client = new FakeClient();
    addThread(client, { resolved });
    await assert.rejects(() => workflow(validated, client).api.refreshThreads(2), {
      code: 'ROOT_IDENTITY_MISMATCH',
    });
    assert.equal(client.events.length, 0);
  }
  const duplicate = new FakeClient();
  duplicate.threads = [{ id: 'THREAD_duplicate', isResolved: false }, { id: 'THREAD_duplicate', isResolved: false }];
  duplicate.threadComments.set('THREAD_duplicate', [rootComment('THREAD_duplicate', { author: VIEWER })]);
  await assert.rejects(() => workflow(validated, duplicate).api.refreshThreads(2), {
    code: 'ROOT_IDENTITY_AMBIGUOUS',
  });
  await assert.rejects(() => workflow(validated, new FakeClient(), {
    git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
  }).api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  const withoutCheckpoint = { async load() { return structuredClone(validated); } };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: withoutCheckpoint, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'INVALID_ADAPTERS' });
  const raced = fakeState(validated);
  const originalLoad = raced.load.bind(raced);
  let reads = 0;
  raced.load = async () => {
    const state = await originalLoad();
    reads += 1;
    return reads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  await assert.rejects(() => createGitHubReviewWorkflow({
    client: new FakeClient(), state: raced, git: fakeGit(), clock: { now: () => AT }, journal: null,
  }).refreshThreads(2), { code: 'STATE_REVISION_CHANGED' });

  class DriftingRefreshClient extends FakeClient {
    async graphql(input) {
      const result = await super.graphql(input);
      if (input.name === 'PullRequestThreads') this.metadata.headRefOid = OTHER_HEAD;
      return result;
    }
  }
  const drifted = workflow(validated, new DriftingRefreshClient());
  await assert.rejects(() => drifted.api.refreshThreads(2), { code: 'MUTATION_NOT_READY' });
  assert.equal(drifted.state.calls.some((call) => call.name === 'checkpointTaskCompletion'), false);
});

test('taskless thread refresh rejects every prior-review lifecycle while allowing pristine repetition', async () => {
  const validated = stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  });
  const priorPending = pendingState('discovery', { validationStatus: validated.validationStatus });
  const priorCompleted = completedState({
    phase: 'recovering',
    validationStatus: validated.validationStatus,
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Recover prior review evidence.',
  });
  for (const [label, state] of [
    ['non-recovering phase', { ...validated, phase: 'validating' }],
    ['pending discovery provenance', priorPending],
    ['completed review provenance', priorCompleted],
  ]) {
    await assert.rejects(() => workflow(state).api.refreshThreads(2), {
      code: 'TASKLESS_REFRESH_NOT_ALLOWED',
    }, label);
  }

  const setup = workflow(validated);
  await setup.api.refreshThreads(2);
  const firstRevision = setup.state.current.revision;
  await setup.api.refreshThreads(2);
  assert.equal(setup.state.current.revision, firstRevision + 1);
  assert.equal(setup.state.current.reviewRound, 0);
  assert.deepEqual(setup.state.current.reviewHistory, []);
});

test('collect-ci classifies the selected Full validation run independently of the aggregate rollup', async () => {
  for (const [rollupState, conclusion, expected] of [
    ['FAILURE', 'SUCCESS', 'passed'],
    ['PENDING', 'SUCCESS', 'passed'],
    ['SUCCESS', 'FAILURE', 'failed'],
  ]) {
    const client = new FakeClient({
      rollupState,
      ciContexts: [
        fullValidationCheck({ conclusion }),
        { __typename: 'StatusContext', id: `STATUS_${rollupState}`, context: 'unrelated',
          state: rollupState, targetUrl: 'https://github.com/example/aerstello' },
      ],
    });
    const result = await workflow(stateFixture(), client).api.collectCi(2);
    assert.equal(result.evidence.status, expected);
  }
});

test('collect-ci waits when another authoritative Full validation run is incomplete', async () => {
  const client = new FakeClient({ rollupState: 'FAILURE', ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({
      id: 'CHECK_pending', status: 'IN_PROGRESS', conclusion: null, completedAt: null,
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 702, url: 'https://github.com/example/aerstello/actions/runs/702',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), client).api.collectCi(2), {
    code: 'CI_VALIDATION_PENDING',
  });
});

test('collect-ci rejects same-named jobs from another workflow and incomplete workflow identity', async () => {
  const wrongWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
      file: { path: '.github/workflows/other.yml' }, workflow: { name: 'CI' } },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), wrongWorkflow).api.collectCi(2), {
    code: 'CI_WORKFLOW_MISMATCH',
  });

  const missingWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701' },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), missingWorkflow).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });

  const truncatedWorkflow = new FakeClient({ ciContexts: [fullValidationCheck({ checkSuite: {
    app: { slug: 'github-actions' },
    workflowRun: { databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
      file: { path: null }, workflow: { name: 'CI' } },
  } })] });
  await assert.rejects(() => workflow(stateFixture(), truncatedWorkflow).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });

  const malformedNonSelected = new FakeClient({ ciContexts: [
    fullValidationCheck(),
    fullValidationCheck({
      id: null, completedAt: '2026-08-04T23:00:00Z',
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: {
        databaseId: 700, url: 'http://github.com/example/aerstello/actions/runs/700',
        file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' },
      } },
    }),
  ] });
  await assert.rejects(() => workflow(stateFixture(), malformedNonSelected).api.collectCi(2), {
    code: 'CI_EVIDENCE_INCOMPLETE',
  });
});

test('check rollup reads fail closed on GraphQL errors and repeated pagination cursors', async () => {
  const graphqlError = new FakeClient({ graphqlErrors: new Set(['PullRequestChecks']) });
  await assert.rejects(() => workflow(stateFixture(), graphqlError).api.collectCi(2), { code: 'GRAPHQL_READ_FAILED' });

  const truncated = new FakeClient({ pageSize: 0 });
  await assert.rejects(() => workflow(stateFixture(), truncated).api.collectCi(2), { code: 'GRAPHQL_TRUNCATED' });
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
    await assert.rejects(() => readTopLevelComments(client, 'example/aerstello', 2), GitHubWorkflowError);
  }
  const client = new FakeClient();
  client.comments = [{ id: 'C1' }, { id: 'C2' }];
  client.graphql = async () => client.result({
    repository: { pullRequest: { comments: { nodes: [{ id: 'C1' }], pageInfo: { hasNextPage: true, endCursor: null } } } },
  });
  await assert.rejects(() => readTopLevelComments(client, 'example/aerstello', 2), { code: 'GRAPHQL_TRUNCATED' });
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
  assert.match(mutation.variables.clientMutationId, /^aerstello-/u);
  assert.equal(state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('human-final request performs no journal or GitHub mutation before notBefore and succeeds at the exact boundary', async () => {
  const beforeEvents = [];
  const beforeClient = new FakeClient({ events: beforeEvents, requestCreatedAt: NOT_BEFORE });
  const before = workflow(humanFinalAuthorizedState(), beforeClient, {
    clock: { now: () => '2026-08-10T12:59:59.999Z' },
  });
  await assert.rejects(() => before.api.request(2, 'human-final'), { code: 'REQUEST_NOT_READY' });
  assert.deepEqual(beforeEvents, []);
  assert.equal(beforeClient.calls.length, 0);
  assert.equal(before.state.calls.length, 0);

  const boundaryEvents = [];
  const boundaryClient = new FakeClient({ events: boundaryEvents, requestCreatedAt: NOT_BEFORE });
  const initial = humanFinalAuthorizedState();
  const boundary = workflow(initial, boundaryClient, { clock: { now: () => NOT_BEFORE } });
  const result = await boundary.api.request(2, 'human-final');
  assert.equal(result.request.kind, 'human-final');
  assert.equal(result.request.at, NOT_BEFORE);
  assert.deepEqual(boundaryEvents, ['intent:request', 'mutation:AddReviewRequest']);
  assert.equal(boundary.state.current.reviewHistory.length, 5);
  assert.deepEqual(boundary.state.current.reviewHistory.slice(0, 4), initial.reviewHistory);
  assert.equal(boundary.state.current.reviewRound, 3);
  assert.equal(boundary.state.current.verificationReviewUsed, true);
});

test('human-final request recovery rejects pre-bound evidence and never posts twice', async () => {
  const operationId = `request:2:human-final:5:${HEAD}`;
  const intent = priorIntent('request', operationId, NOT_BEFORE);
  const staleClient = new FakeClient();
  staleClient.comments.push({
    id: 'IC_human_final_stale', databaseId: 801, url: 'https://x/human-final-stale',
    body: '@codex review', createdAt: '2026-08-10T12:59:59.999Z', author: VIEWER,
  });
  const stale = workflow(humanFinalAuthorizedState(), staleClient, {
    clock: { now: () => NOT_BEFORE }, journal: fakeJournal([], [intent]),
  });
  await assert.rejects(() => stale.api.request(2, 'human-final'), { code: 'REQUEST_RECOVERY_MISSING' });
  assert.equal(staleClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(stale.state.calls.length, 0);

  const recoveredClient = new FakeClient();
  recoveredClient.comments.push({
    id: 'IC_human_final', databaseId: 802, url: 'https://x/human-final',
    body: '@codex review', createdAt: NOT_BEFORE, author: VIEWER,
  });
  const recovered = workflow(humanFinalAuthorizedState(), recoveredClient, {
    clock: { now: () => NOT_BEFORE }, journal: fakeJournal([], [intent]),
  });
  const result = await recovered.api.request(2, 'human-final');
  assert.equal(result.recovered, true);
  assert.equal(result.request.id, 'IC_human_final');
  assert.equal(recoveredClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(recovered.state.current.reviewHistory.length, 5);
  await assert.rejects(() => recovered.api.request(2, 'human-final'), { code: 'REQUEST_NOT_READY' });
  assert.equal(recoveredClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
});

test('post-final remediation authorization never enables a sixth request or journal mutation', async () => {
  for (const kind of ['discovery', 'verification', 'human-final']) {
    const events = [];
    const client = new FakeClient({ events });
    const setup = workflow(postFinalRemediationAuthorizedState(), client, {
      clock: { now: () => '2026-08-10T13:07:00Z' },
      journal: fakeJournal(events),
    });
    await assert.rejects(() => setup.api.request(2, kind), { code: 'REQUEST_NOT_READY' });
    assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
    assert.deepEqual(events, []);
    assert.equal(setup.state.calls.length, 0);
  }
});

test('request recovers a concurrent intent using its returned exclusion baseline without mutation', async () => {
  class CommentsBetweenSnapshotsClient extends FakeClient {
    constructor(events, comments) {
      super({ events });
      this.raceComments = comments;
      this.commentReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestComments') {
        this.commentReads += 1;
        if (this.commentReads === 2) this.comments.push(...this.raceComments);
      }
      return super.graphql(input);
    }
  }

  const operationId = `request:2:discovery:1:${HEAD}`;
  const concurrentIntent = {
    ...priorIntent('request', operationId), excludedCommentIds: ['IC_excluded'],
  };
  const comments = [
    { id: 'IC_excluded', databaseId: 8, url: 'https://x/excluded', body: '@codex review',
      createdAt: AT, author: VIEWER },
    { id: 'IC_recovered', databaseId: 9, url: 'https://x/recovered', body: '@codex review',
      createdAt: AT, author: VIEWER },
  ];
  const events = [];
  const client = new CommentsBetweenSnapshotsClient(events, comments);
  const setup = workflow(readyState(), client, {
    journal: racingRequestJournal(concurrentIntent, events),
  });
  const result = await setup.api.request(2, 'discovery');

  assert.equal(result.recovered, true);
  assert.equal(result.request.id, 'IC_recovered');
  assert.deepEqual(events, ['intent:request']);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointReviewRequest');
});

test('concurrent request intent fails closed for missing or ambiguous candidates and later retries recover', async () => {
  const operationId = `request:2:discovery:1:${HEAD}`;
  const intent = priorIntent('request', operationId);

  const missingClient = new FakeClient();
  const missing = workflow(readyState(), missingClient, {
    journal: racingRequestJournal(intent),
  });
  await assert.rejects(() => missing.api.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_MISSING' });
  assert.equal(missingClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(missing.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);
  missingClient.comments.push({ id: 'IC_later', databaseId: 10, url: 'https://x/later', body: '@codex review',
    createdAt: AT, author: VIEWER });
  assert.equal((await missing.api.request(2, 'discovery')).request.id, 'IC_later');
  assert.equal(missingClient.calls.some((call) => call.name === 'AddReviewRequest'), false);

  const ambiguousClient = new FakeClient();
  const ambiguousJournal = racingRequestJournal(intent);
  const graphql = ambiguousClient.graphql.bind(ambiguousClient);
  let commentReads = 0;
  ambiguousClient.graphql = async (input) => {
    if (input.name === 'PullRequestComments') {
      commentReads += 1;
      if (commentReads === 2) ambiguousClient.comments.push(
        { id: 'IC_first', databaseId: 11, url: 'https://x/first', body: '@codex review', createdAt: AT, author: VIEWER },
        { id: 'IC_second', databaseId: 12, url: 'https://x/second', body: '@codex review', createdAt: AT, author: VIEWER },
      );
    }
    return graphql(input);
  };
  const ambiguous = workflow(readyState(), ambiguousClient, { journal: ambiguousJournal });
  await assert.rejects(() => ambiguous.api.request(2, 'discovery'), { code: 'REQUEST_RECOVERY_AMBIGUOUS' });
  assert.equal(ambiguousClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(ambiguous.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);
  ambiguousClient.comments = ambiguousClient.comments.filter((comment) => comment.id === 'IC_second');
  assert.equal((await ambiguous.api.request(2, 'discovery')).request.id, 'IC_second');
  assert.equal(ambiguousClient.calls.some((call) => call.name === 'AddReviewRequest'), false);
});

test('request revalidates canonical thread proof before journaling or mutation and retries after resolution', async () => {
  class ThreadBetweenSnapshotsClient extends FakeClient {
    constructor(events) {
      super({ events });
      this.threadReads = 0;
      this.injectRoot = true;
    }

    async graphql(input) {
      if (input.name === 'PullRequestThreads') {
        this.threadReads += 1;
        if (this.injectRoot && this.threadReads === 2) addThread(this);
      }
      return super.graphql(input);
    }
  }

  const events = [];
  const client = new ThreadBetweenSnapshotsClient(events);
  const journal = fakeJournal(events);
  const first = workflow(readyState(), client, { journal });
  await assert.rejects(() => first.api.request(2, 'discovery'), { code: 'REQUEST_NOT_READY' });
  assert.equal(journal.intents.size, 0);
  assert.equal(client.calls.some((call) => call.name === 'AddReviewRequest'), false);
  assert.equal(first.state.calls.some((call) => call.name === 'checkpointReviewRequest'), false);

  client.injectRoot = false;
  client.threads[0].isResolved = true;
  const replyOperation = `reply:2:THREAD_1:${HEAD}`;
  const reply = {
    id: 'REPLY_resolved', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
  };
  client.threadComments.get('THREAD_1').push(reply);
  const resolvedState = readyState({
    tasks: [{
      id: 'task-thread', sourceIds: ['thread:THREAD_1'], sourceType: 'github-thread', fingerprint: 'fp-thread',
      summary: 'Fix canonical finding.', severity: 'P1', disposition: 'actionable', status: 'completed',
      integratedCommitSha: HEAD, resolutionSummary: 'Fixed the finding.',
    }],
    threadResolutionStatus: {
      status: 'passed', headSha: HEAD,
      threads: [{
        threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_THREAD_1', rootCommentDatabaseId: 41,
        taskIds: ['task-thread'], disposition: 'fixed', replyId: reply.id, replyUrl: reply.url,
        isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
      }],
      threadlessVerification: proof('not-run').threadlessVerification,
      updatedAt: AT,
    },
  });
  const retry = workflow(resolvedState, client, { journal });
  const result = await retry.api.request(2, 'discovery');
  assert.equal(result.request.body, '@codex review');
  assert.deepEqual(events, ['intent:request', 'mutation:AddReviewRequest']);
  assert.equal(retry.state.calls.at(-1).name, 'checkpointReviewRequest');
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
    id: 'IC_recovered', databaseId: 9, url: 'https://github.com/example/aerstello/pull/2#issuecomment-9',
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

function integratedNonThreadState(sourceType = 'local', id = 'task-local') {
  return readyState({
    phase: 'verifying',
    tasks: [{
      id, sourceIds: [sourceType === 'local' ? 'local:verifier' : 'review:threadless'], sourceType,
      fingerprint: `fp-${id}`, summary: 'Verify a non-thread finding.', severity: 'P1',
      disposition: 'actionable', status: 'integrated', integratedCommitSha: HEAD,
      resolutionSummary: 'Integrated and verified.',
    }],
  });
}

function nonActionableNonThreadState(sourceType = 'local', id = 'task-disposed', disposition = 'duplicate') {
  const state = integratedNonThreadState(sourceType, id);
  state.tasks[0] = {
    ...state.tasks[0], disposition, status: 'not-applicable', integratedCommitSha: null,
    resolutionSummary: 'Disposition verified.',
  };
  return state;
}

function completedThreadlessDriftState(selection = 'threadless-completed') {
  const taskIds = [...(Array.isArray(selection) ? selection : [selection])].sort();
  const state = integratedNonThreadState('github-threadless', taskIds[0]);
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { ...state.git, headSha: OTHER_HEAD };
  state.validationStatus = { ...state.validationStatus, headSha: OTHER_HEAD };
  state.tasks = taskIds.map((id) => ({
    ...state.tasks[0], id, fingerprint: `fp-${id}`, status: 'completed',
  }));
  state.threadResolutionStatus = {
    status: 'not-run', headSha: null, threads: [], updatedAt: null,
    threadlessVerification: { status: 'passed', headSha: HEAD, taskIds, updatedAt: AT },
  };
  return state;
}

test('reply-resolve identifies explicit root, deduplicates shared source identities, replies before resolve, and re-queries proof', async () => {
  const events = [];
  const client = new FakeClient({ events });
  addThread(client);
  const initial = integratedThreadState(['thread:THREAD_1', 'discussion:41']);
  initial.tasks.push(integratedNonThreadState().tasks[0]);
  const { api, state } = workflow(initial, client);
  const result = await api.replyResolve(2, 'task-thread');
  assert.deepEqual(events.filter((item) => item.startsWith('mutation:')), ['mutation:AddThreadReply', 'mutation:ResolveThread']);
  assert.equal(client.calls.filter((call) => call.name === 'AddThreadReply').length, 1);
  assert.equal(client.calls.filter((call) => call.name === 'ResolveThread').length, 1);
  assert.match(client.threadComments.get('THREAD_1')[1].body, /<!-- aerstello-review:[0-9a-f]{24} -->/u);
  assert.equal(result.threadResolutionStatus.status, 'passed');
  assert.equal(state.current.tasks[0].status, 'completed');
  assert.equal(state.current.tasks[1].status, 'integrated');
  assert.deepEqual(state.calls.at(-1).input.verifiedLocalTaskIds, undefined);
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

test('verify-resolve completes only the selected local task after repeated read-only exact-head guards', async () => {
  const state = integratedNonThreadState();
  state.tasks.push({
    ...state.tasks[0], id: 'task-other-local', fingerprint: 'fp-task-other-local',
  });
  const client = new FakeClient({ pageSize: 1 });
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const setup = workflow(state, client, { journal });
  const result = await setup.api.verifyResolve(2, ['task-local']);
  assert.equal(result.taskId, 'task-local');
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['completed', 'integrated']);
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, ['task-local']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: HEAD, taskIds: ['task-local'], updatedAt: AT,
  });
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= 2);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const guardedThreadReads = client.calls.filter((call) => call.name === 'PullRequestThreads').length;
  const retried = await setup.api.verifyResolve(2, ['task-local']);
  assert.equal(retried.stateRevision, revision);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= guardedThreadReads + 2);
});

test('verify-resolve completes only the selected eligible non-actionable local task idempotently', async () => {
  const state = nonActionableNonThreadState('local', 'disposed-a', 'duplicate');
  state.tasks.push(nonActionableNonThreadState('local', 'disposed-b', 'stale').tasks[0]);
  const client = new FakeClient();
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const setup = workflow(state, client, { journal });
  await setup.api.verifyResolve(2, ['disposed-b']);
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['not-applicable', 'completed']);
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, ['disposed-b']);
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const retried = await setup.api.verifyResolve(2, ['disposed-b']);
  assert.equal(retried.stateRevision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);

  for (const disposition of ['already-fixed', 'invalid', 'policy-conflict', 'out-of-scope']) {
    const candidate = nonActionableNonThreadState('local', `disposed-${disposition}`, disposition);
    const candidateSetup = workflow(candidate, new FakeClient());
    await candidateSetup.api.verifyResolve(2, [candidate.tasks[0].id]);
    assert.equal(candidateSetup.state.current.tasks[0].status, 'completed');
  }
});

test('superseded local task verifies without granting proof to its actionable replacement or guard', async () => {
  const state = nonActionableNonThreadState('local', 'stopped-contract', 'duplicate');
  state.tasks.push(
    integratedNonThreadState('local', 'replacement-contract').tasks[0],
    integratedNonThreadState('local', 'supersession-guard').tasks[0],
  );
  const setup = workflow(state, new FakeClient());
  await setup.api.verifyResolve(2, ['stopped-contract']);
  assert.deepEqual(
    setup.state.current.tasks.map((task) => [task.id, task.status]),
    [
      ['stopped-contract', 'completed'],
      ['replacement-contract', 'integrated'],
      ['supersession-guard', 'integrated'],
    ],
  );
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification.taskIds, ['stopped-contract']);
  const status = await setup.api.status(2);
  assert.equal(status.taskStatus.pending, 2);

  await setup.api.verifyResolve(2, ['replacement-contract']);
  assert.equal(setup.state.current.tasks.find((task) => task.id === 'supersession-guard').status, 'integrated');
  assert.deepEqual(
    setup.state.current.threadResolutionStatus.localVerification.taskIds,
    ['replacement-contract', 'stopped-contract'],
  );
});

test('verify-resolve re-attests completed local tasks at a new HEAD as a guarded accumulating exact set', async () => {
  const state = integratedNonThreadState('local', 'local-a');
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { ...state.git, headSha: OTHER_HEAD };
  state.validationStatus = { ...state.validationStatus, headSha: OTHER_HEAD };
  state.tasks = [
    { ...state.tasks[0], id: 'local-a', fingerprint: 'fp-local-a', status: 'completed' },
    { ...state.tasks[0], id: 'local-b', fingerprint: 'fp-local-b', status: 'completed' },
  ];
  state.threadResolutionStatus = {
    status: 'not-run', headSha: null, threads: [],
    threadlessVerification: proof('not-run').threadlessVerification,
    localVerification: { status: 'passed', headSha: HEAD, taskIds: ['local-a', 'local-b'], updatedAt: AT },
    updatedAt: null,
  };
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const journal = {
    async lookupIntent() { throw new Error('local re-attestation must not read the mutation journal'); },
    async ensureIntent() { throw new Error('local re-attestation must not write the mutation journal'); },
  };
  const setup = workflow(state, client, {
    journal,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
  });

  await setup.api.verifyResolve(2, ['local-a']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification, {
    status: 'passed', headSha: OTHER_HEAD, taskIds: ['local-a'], updatedAt: AT,
  });
  assert.deepEqual(setup.state.current.tasks.map((task) => task.status), ['completed', 'completed']);

  await setup.api.verifyResolve(2, ['local-b']);
  assert.deepEqual(setup.state.current.threadResolutionStatus.localVerification.taskIds, ['local-a', 'local-b']);
  const revision = setup.state.current.revision;
  const checkpoints = setup.state.calls.length;
  const guardedThreadReads = client.calls.filter((call) => call.name === 'PullRequestThreads').length;
  await setup.api.verifyResolve(2, ['local-a']);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpoints);
  assert.ok(client.calls.filter((call) => call.name === 'PullRequestThreads').length >= guardedThreadReads + 2);
  assert.equal(client.calls.some((call) => call.name.startsWith('Add') || call.name === 'ResolveThread'), false);
  assert.deepEqual(client.events, []);
});

test('verify-resolve creates current-head threadless proof and preserves prior proven IDs', async () => {
  const state = integratedNonThreadState('github-threadless', 'threadless-new');
  state.tasks.unshift({
    ...state.tasks[0], id: 'threadless-prior', fingerprint: 'fp-threadless-prior', status: 'completed',
  });
  state.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: {
      status: 'passed', headSha: HEAD, taskIds: ['threadless-prior'], updatedAt: AT,
    },
  };
  const client = new FakeClient();
  const setup = workflow(state, client);
  await setup.api.verifyResolve(2, ['threadless-new']);
  assert.deepEqual(
    setup.state.current.threadResolutionStatus.threadlessVerification.taskIds,
    ['threadless-new', 'threadless-prior'],
  );
  assert.equal(setup.state.current.threadResolutionStatus.threadlessVerification.headSha, HEAD);
  assert.ok(setup.state.current.tasks.every((task) => task.status === 'completed'));
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, []);
  assert.equal(client.events.length, 0);
});

test('verify-resolve proves eligible non-actionable threadless tasks and rejects needs-human decisions', async () => {
  const state = nonActionableNonThreadState('github-threadless', 'threadless-disposed', 'already-fixed');
  state.tasks.unshift({
    ...state.tasks[0], id: 'threadless-prior', fingerprint: 'fp-threadless-prior', status: 'completed',
  });
  state.threadResolutionStatus = {
    ...proof(),
    threadlessVerification: {
      status: 'passed', headSha: HEAD, taskIds: ['threadless-prior'], updatedAt: AT,
    },
  };
  const client = new FakeClient();
  const setup = workflow(state, client);
  await setup.api.verifyResolve(2, ['threadless-disposed']);
  assert.deepEqual(
    setup.state.current.threadResolutionStatus.threadlessVerification.taskIds,
    ['threadless-disposed', 'threadless-prior'],
  );
  assert.ok(setup.state.current.tasks.every((task) => task.status === 'completed'));
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  await setup.api.verifyResolve(2, ['threadless-disposed', 'threadless-prior']);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);

  for (const sourceType of ['local', 'github-threadless']) {
    const needsHuman = nonActionableNonThreadState(sourceType, `needs-human-${sourceType}`, 'needs-human-decision');
    const rejected = workflow(needsHuman, new FakeClient());
    await assert.rejects(() => rejected.api.verifyResolve(2, [needsHuman.tasks[0].id]), { code: 'TASK_NOT_READY' });
    assert.equal(rejected.state.calls.length, 0);
    assert.equal(rejected.client.events.length, 0);
  }
});

test('verify-resolve re-attests completed threadless proof after HEAD drift without aggregate fabrication', async () => {
  const state = completedThreadlessDriftState();
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const later = '2026-08-05T00:01:00Z';
  const setup = workflow(state, client, { git, journal, clock: { now: () => later } });
  const result = await setup.api.verifyResolve(2, ['threadless-completed']);
  assert.equal(result.stateRevision, state.revision + 1);
  assert.deepEqual(result.threadResolutionStatus, {
    status: 'not-run', headSha: null, threads: [], updatedAt: null,
    threadlessVerification: {
      status: 'passed', headSha: OTHER_HEAD, taskIds: ['threadless-completed'], updatedAt: later,
    },
  });
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, []);
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 2);
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  await setup.api.verifyResolve(2, ['threadless-completed']);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);

  const aggregateNotInvalidated = completedThreadlessDriftState();
  aggregateNotInvalidated.threadResolutionStatus = {
    ...aggregateNotInvalidated.threadResolutionStatus,
    status: 'passed', headSha: HEAD, updatedAt: AT,
  };
  const rejected = workflow(aggregateNotInvalidated, new FakeClient({ metadata: {
    id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
    headRefOid: OTHER_HEAD, viewer: VIEWER,
  } }), { git });
  await assert.rejects(() => rejected.api.verifyResolve(2, ['threadless-completed']), { code: 'TASK_NOT_READY' });
  assert.equal(rejected.state.calls.length, 0);
  assert.equal(rejected.client.events.length, 0);
});

test('verify-resolve workflow accepts only arrays of exact opaque task IDs', async () => {
  for (const [label, selection] of [
    ['string', 'task-local'],
    ['null', null],
    ['object', { taskId: 'task-local' }],
    ['number', 1],
    ['empty ID', ['']],
    ['non-string ID', ['task-local', 1]],
  ]) {
    const client = new FakeClient();
    const setup = workflow(integratedNonThreadState(), client);
    await assert.rejects(() => setup.api.verifyResolve(2, selection), {
      code: 'TASK_NOT_READY',
    }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('verify-resolve atomically re-attests only the exact completed threadless task set', async () => {
  const taskIds = ['threadless-a', 'threadless-b'];
  const initial = completedThreadlessDriftState(taskIds);
  const client = new FakeClient();
  client.metadata.headRefOid = OTHER_HEAD;
  const journal = {
    async lookupIntent() { throw new Error('verify-resolve must not read the mutation journal'); },
    async ensureIntent() { throw new Error('verify-resolve must not write the mutation journal'); },
  };
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const updatedAt = '2026-08-05T00:02:00Z';
  const setup = workflow(initial, client, { git, journal, clock: { now: () => updatedAt } });

  const result = await setup.api.verifyResolve(2, ['threadless-b', 'threadless-a']);
  assert.deepEqual(result.taskIds, taskIds);
  assert.equal(Object.hasOwn(result, 'taskId'), false);
  assert.equal(result.stateRevision, initial.revision + 1);
  const expected = structuredClone(initial);
  expected.revision += 1;
  expected.threadResolutionStatus.threadlessVerification = {
    ...expected.threadResolutionStatus.threadlessVerification,
    headSha: OTHER_HEAD,
    taskIds,
    updatedAt,
  };
  assert.deepEqual(setup.state.current, expected, 'only the shared proof and revision advance');
  assert.deepEqual(setup.state.calls.at(-1).input.verifiedLocalTaskIds, []);
  assert.deepEqual(
    setup.state.calls.at(-1).input.threadResolutionStatus.threadlessVerification.taskIds,
    taskIds,
  );
  assert.equal(setup.state.current.threadResolutionStatus.status, 'not-run');
  assert.equal(client.calls.filter((call) => call.name === 'PullRequestThreads').length, 2);
  assert.equal(client.events.length, 0);

  const revision = setup.state.current.revision;
  const checkpointCount = setup.state.calls.length;
  const retry = await setup.api.verifyResolve(2, ['threadless-a', 'threadless-b']);
  assert.equal(retry.stateRevision, revision);
  assert.deepEqual(retry.taskIds, taskIds);
  assert.equal(setup.state.current.revision, revision);
  assert.equal(setup.state.calls.length, checkpointCount);
  assert.equal(client.events.length, 0);
});

test('verify-resolve rejects every non-exact completed threadless selection before checkpointing', async () => {
  const taskIds = ['threadless-a', 'threadless-b'];
  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const cases = [
    ['partial set', () => completedThreadlessDriftState(taskIds), ['threadless-a'], 'TASK_NOT_READY'],
    ['duplicate ID', () => completedThreadlessDriftState(taskIds), ['threadless-a', 'threadless-a'], 'TASK_NOT_READY'],
    ['empty selection', () => completedThreadlessDriftState(taskIds), [], 'TASK_NOT_READY'],
    ['unknown ID', () => completedThreadlessDriftState(taskIds), [...taskIds, 'threadless-unknown'], 'TASK_NOT_FOUND'],
    ['extra eligible task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'threadless-extra', fingerprint: 'fp-threadless-extra',
        status: 'integrated',
      });
      return state;
    }, [...taskIds, 'threadless-extra'], 'TASK_NOT_READY'],
    ['local task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'local-completed', fingerprint: 'fp-local-completed',
        sourceType: 'local', sourceIds: ['local:verifier'],
      });
      return state;
    }, [...taskIds, 'local-completed'], 'TASK_NOT_READY'],
    ['not-completed task', () => {
      const state = completedThreadlessDriftState(taskIds);
      state.tasks.push({
        ...state.tasks[0], id: 'threadless-integrated', fingerprint: 'fp-threadless-integrated',
        disposition: 'duplicate', status: 'not-applicable', integratedCommitSha: null,
      });
      return state;
    }, [...taskIds, 'threadless-integrated'], 'TASK_NOT_READY'],
    ['ineligible task', () => {
      const state = completedThreadlessDriftState([...taskIds, 'threadless-ineligible']);
      state.tasks.find((task) => task.id === 'threadless-ineligible').disposition = 'needs-human-decision';
      state.tasks.find((task) => task.id === 'threadless-ineligible').integratedCommitSha = null;
      return state;
    }, [...taskIds, 'threadless-ineligible'], 'TASK_NOT_READY'],
  ];

  for (const [label, buildState, selection, code] of cases) {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const setup = workflow(buildState(), client, { git });
    await assert.rejects(() => setup.api.verifyResolve(2, selection), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }

  const alreadyCurrent = completedThreadlessDriftState(taskIds);
  alreadyCurrent.threadResolutionStatus.threadlessVerification.headSha = OTHER_HEAD;
  const currentClient = new FakeClient();
  currentClient.metadata.headRefOid = OTHER_HEAD;
  const current = workflow(alreadyCurrent, currentClient, { git });
  await assert.rejects(() => current.api.verifyResolve(2, ['threadless-a']), {
    code: 'TASK_NOT_READY',
  });
  assert.equal(current.state.calls.length, 0);
  assert.equal(currentClient.calls.length, 0);
  assert.equal(currentClient.events.length, 0);
});

test('completed threadless refresh permits mapped new roots and enables journal-backed resolution recovery', async () => {
  const state = completedThreadlessDriftState();
  state.tasks[0].integratedCommitSha = PRIOR_INTEGRATION_HEAD;
  const recordedTask = {
    ...integratedThreadState(['thread:THREAD_OLD']).tasks[0],
    id: 'task-thread-old', fingerprint: 'fp-thread-old', status: 'completed', integratedCommitSha: HEAD,
  };
  const pendingTask = {
    ...integratedThreadState(['thread:THREAD_1']).tasks[0],
    id: 'task-thread-new', fingerprint: 'fp-thread-new', integratedCommitSha: SELECTED_TASK_HEAD,
  };
  state.tasks.push(recordedTask, pendingTask);
  state.threadResolutionStatus.threads = [{
    threadNodeId: 'THREAD_OLD', rootCommentNodeId: 'ROOT_THREAD_OLD', rootCommentDatabaseId: 42,
    taskIds: ['task-thread-old'], disposition: 'fixed', replyId: 'REPLY_OLD', replyUrl: 'https://x/old-reply',
    isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
  }];

  function recoveryClient() {
    const client = new FakeClient();
    client.metadata.headRefOid = OTHER_HEAD;
    const oldReplyOperation = `reply:2:THREAD_OLD:${HEAD}`;
    addThread(client, { id: 'THREAD_OLD', resolved: true, replies: [{
      id: 'REPLY_OLD', databaseId: 901, url: 'https://x/old-reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_OLD' }, pullRequestReview: null,
      body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread-old: ${HEAD}\nValidation: prior validation.\n${markerFor(oldReplyOperation)}`,
    }] });
    const newReplyOperation = `reply:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
    addThread(client, { id: 'THREAD_1', resolved: true, replies: [{
      id: 'REPLY_NEW', databaseId: 902, url: 'https://x/new-reply', createdAt: AT, author: VIEWER,
      replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
      body: `Aerstello review resolution at ${PRIOR_INTEGRATION_HEAD}.\nTasks:\n- task-thread-new: ${SELECTED_TASK_HEAD}\nValidation: prior validation.\n${markerFor(newReplyOperation)}`,
    }] });
    return client;
  }

  const git = fakeGit({
    snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
    pushedHead: async () => OTHER_HEAD,
  });
  const driftedClient = recoveryClient();
  driftedClient.threads.find((thread) => thread.id === 'THREAD_OLD').isResolved = false;
  const drifted = workflow(state, driftedClient, { git });
  await assert.rejects(() => drifted.api.verifyResolve(2, ['threadless-completed']), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(drifted.state.calls.length, 0);
  assert.equal(driftedClient.events.length, 0);

  const client = recoveryClient();
  const replyOperation = `reply:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
  const resolveOperation = `resolve:2:THREAD_1:${PRIOR_INTEGRATION_HEAD}`;
  const journalEvents = [];
  const journal = fakeJournal(journalEvents, [
    priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation),
  ]);
  const lookupOperations = [];
  const lookupRecoveryIntent = journal.lookupIntent.bind(journal);
  journal.lookupIntent = async (operationId) => {
    lookupOperations.push(operationId);
    return lookupRecoveryIntent(operationId);
  };
  const setup = workflow(state, client, { git, journal, clock: { now: () => '2026-08-05T00:01:00Z' } });
  const refreshed = await setup.api.verifyResolve(2, ['threadless-completed']);
  assert.equal(refreshed.threadResolutionStatus.status, 'not-run');
  assert.deepEqual(refreshed.threadResolutionStatus.threads, state.threadResolutionStatus.threads);
  assert.equal(refreshed.threadResolutionStatus.threadlessVerification.headSha, OTHER_HEAD);
  assert.equal(client.events.length, 0);
  const postRefreshState = structuredClone(setup.state.current);

  const missingPairClient = recoveryClient();
  const missingPair = workflow(postRefreshState, missingPairClient, {
    git, journal: fakeJournal([], [priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => missingPair.api.replyResolve(2, 'task-thread-new'), {
    code: 'RESOLUTION_PROOF_MISSING',
  });
  assert.equal(missingPairClient.events.length, 0);

  const reversedPairClient = recoveryClient();
  const reversedPair = workflow(postRefreshState, reversedPairClient, {
    git,
    journal: fakeJournal([], [
      priorIntent('reply', replyOperation, '2026-08-05T00:00:01Z'),
      priorIntent('resolve', resolveOperation, AT),
    ]),
  });
  await assert.rejects(() => reversedPair.api.replyResolve(2, 'task-thread-new'), {
    code: 'RESOLUTION_PROOF_MISSING',
  });
  assert.equal(reversedPairClient.events.length, 0);

  const extraReplyClient = recoveryClient();
  extraReplyClient.threadComments.get('THREAD_1').push({
    id: 'REPLY_EXTRA', databaseId: 903, url: 'https://x/extra', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `extra\n${markerFor(`reply:2:THREAD_1:${HEAD}`)}`,
  });
  const extraReply = workflow(postRefreshState, extraReplyClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => extraReply.api.replyResolve(2, 'task-thread-new'), { code: 'REPLY_AMBIGUOUS' });
  assert.equal(extraReplyClient.events.length, 0);

  const resolutionFlipClient = recoveryClient();
  const resolutionFlipGraphql = resolutionFlipClient.graphql.bind(resolutionFlipClient);
  let threadSnapshots = 0;
  resolutionFlipClient.graphql = async (input) => {
    if (input.name === 'PullRequestThreads' && input.variables.cursor === null
        && ++threadSnapshots === 2) {
      resolutionFlipClient.threads.find((thread) => thread.id === 'THREAD_1').isResolved = false;
    }
    return resolutionFlipGraphql(input);
  };
  const resolutionFlip = workflow(postRefreshState, resolutionFlipClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => resolutionFlip.api.replyResolve(2, 'task-thread-new'), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(resolutionFlipClient.events.length, 0);

  const headDriftClient = recoveryClient();
  const headDriftGraphql = headDriftClient.graphql.bind(headDriftClient);
  let metadataSnapshots = 0;
  headDriftClient.graphql = async (input) => {
    if (input.name === 'PullRequestMetadata' && ++metadataSnapshots === 2) {
      headDriftClient.metadata.headRefOid = HEAD;
    }
    return headDriftGraphql(input);
  };
  const headDrift = workflow(postRefreshState, headDriftClient, {
    git,
    journal: fakeJournal([], [priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation)]),
  });
  await assert.rejects(() => headDrift.api.replyResolve(2, 'task-thread-new'), { code: 'MUTATION_NOT_READY' });
  assert.equal(headDriftClient.events.length, 0);

  const stateRaceClient = recoveryClient();
  const stateRaceJournal = fakeJournal([], [
    priorIntent('reply', replyOperation), priorIntent('resolve', resolveOperation),
  ]);
  const lookupIntent = stateRaceJournal.lookupIntent.bind(stateRaceJournal);
  let stateRace;
  let revisionAdvanced = false;
  stateRaceJournal.lookupIntent = async (operationId) => {
    const intent = await lookupIntent(operationId);
    if (!revisionAdvanced) {
      revisionAdvanced = true;
      await stateRace.state.checkpointTaskCompletion({
        prNumber: 2,
        expectedRevision: stateRace.state.current.revision,
        threadResolutionStatus: stateRace.state.current.threadResolutionStatus,
        verifiedLocalTaskIds: [],
      });
    }
    return intent;
  };
  stateRace = workflow(postRefreshState, stateRaceClient, { git, journal: stateRaceJournal });
  await assert.rejects(() => stateRace.api.replyResolve(2, 'task-thread-new'), {
    code: 'STATE_REVISION_CHANGED',
  });
  assert.equal(stateRaceClient.events.length, 0);

  const resolved = await setup.api.replyResolve(2, 'task-thread-new');
  assert.equal(resolved.threadResolutionStatus.status, 'passed');
  assert.deepEqual(
    resolved.threadResolutionStatus.threads.map((thread) => thread.threadNodeId),
    ['THREAD_1', 'THREAD_OLD'],
  );
  assert.equal(resolved.threadResolutionStatus.threadlessVerification.headSha, OTHER_HEAD);
  assert.equal(client.calls.some((call) => ['AddThreadReply', 'ResolveThread'].includes(call.name)), false);
  assert.deepEqual(lookupOperations, [replyOperation, resolveOperation]);
  assert.deepEqual(journalEvents, []);
});

test('verify-resolve rejects unsupported and stale selections without state or GitHub mutation', async () => {
  const unsupported = integratedThreadState();
  const unsupportedClient = new FakeClient();
  addThread(unsupportedClient);
  const unsupportedSetup = workflow(unsupported, unsupportedClient);
  await assert.rejects(() => unsupportedSetup.api.verifyResolve(2, ['task-thread']), { code: 'TASK_NOT_READY' });
  assert.equal(unsupportedSetup.state.calls.length, 0);
  assert.equal(unsupportedClient.events.length, 0);

  for (const [label, state, options, code] of [
    ['missing', integratedNonThreadState(), {}, 'TASK_NOT_FOUND'],
    ['unintegrated', (() => {
      const value = integratedNonThreadState();
      value.tasks[0] = {
        ...value.tasks[0], status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
        execution: {
          dependencies: [], ownedPaths: ['scripts/example.mjs'], worker: 'review_fix_worker',
          branch: null, worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
        },
      };
      return value;
    })(), {}, 'TASK_NOT_READY'],
    ['unvalidated', (() => {
      const value = integratedNonThreadState();
      value.validationStatus = stateFixture().validationStatus;
      return value;
    })(), {}, 'TASK_NOT_READY'],
    ['dirty', integratedNonThreadState(), {
      git: fakeGit({ snapshot: async () => ({ headSha: HEAD, dirty: true }) }),
    }, 'MUTATION_NOT_READY'],
    ['unpushed', integratedNonThreadState(), {
      git: fakeGit({ pushedHead: async () => OTHER_HEAD }),
    }, 'MUTATION_NOT_READY'],
    ['non-ancestor', integratedNonThreadState(), {
      git: fakeGit({ isAncestor: async () => false }),
    }, 'MUTATION_NOT_READY'],
    ['live-head', integratedNonThreadState(), {}, 'MUTATION_NOT_READY'],
  ]) {
    const client = new FakeClient(label === 'live-head' ? { metadata: {
      id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
      headRefOid: OTHER_HEAD, viewer: VIEWER,
    } } : {});
    const setup = workflow(state, client, options);
    const taskId = label === 'missing' ? 'missing-task' : state.tasks[0].id;
    await assert.rejects(() => setup.api.verifyResolve(2, [taskId]), { code }, label);
    assert.equal(setup.state.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('verify-resolve rechecks state and canonical root resolution before its state-only checkpoint', async () => {
  const racedState = fakeState(integratedNonThreadState());
  const originalLoad = racedState.load.bind(racedState);
  let stateReads = 0;
  racedState.load = async () => {
    const state = await originalLoad();
    stateReads += 1;
    return stateReads > 1 ? { ...state, revision: state.revision + 1 } : state;
  };
  const racedClient = new FakeClient();
  const raced = createGitHubReviewWorkflow({
    client: racedClient, state: racedState, git: fakeGit(), clock: { now: () => AT }, journal: null,
  });
  await assert.rejects(() => raced.verifyResolve(2, ['task-local']), { code: 'STATE_REVISION_CHANGED' });
  assert.equal(racedState.calls.length, 0);
  assert.equal(racedClient.events.length, 0);

  const unexpectedRootClient = new FakeClient();
  addThread(unexpectedRootClient);
  const unexpectedRoot = workflow(integratedNonThreadState(), unexpectedRootClient);
  await assert.rejects(() => unexpectedRoot.api.verifyResolve(2, ['task-local']), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
  assert.equal(unexpectedRoot.state.calls.length, 0);
  assert.equal(unexpectedRootClient.events.length, 0);

  const threadState = integratedThreadState();
  threadState.tasks[0].status = 'completed';
  threadState.tasks.push(integratedNonThreadState().tasks[0]);
  threadState.threadResolutionStatus = {
    status: 'passed', headSha: HEAD, updatedAt: AT,
    threadlessVerification: proof('not-run').threadlessVerification,
    threads: [{
      threadNodeId: 'THREAD_1', rootCommentNodeId: 'ROOT_THREAD_1', rootCommentDatabaseId: 41,
      taskIds: ['task-thread'], disposition: 'fixed', replyId: 'REPLY_1', replyUrl: 'https://x/reply',
      isResolved: true, resolvedAt: AT, resolvedBy: VIEWER.login, observedHeadSha: HEAD,
    }],
  };
  const operationId = `reply:2:THREAD_1:${HEAD}`;
  class ResolutionRaceClient extends FakeClient {
    threadReads = 0;

    async graphql(input) {
      if (input.name === 'PullRequestThreads') {
        this.threadReads += 1;
        if (this.threadReads > 1) this.threads[0].isResolved = false;
      }
      return super.graphql(input);
    }
  }
  const resolutionClient = new ResolutionRaceClient();
  addThread(resolutionClient, { resolved: true, replies: [{
    id: 'REPLY_1', databaseId: 901, url: 'https://x/reply', createdAt: AT, author: VIEWER,
    replyTo: { id: 'ROOT_THREAD_1' }, pullRequestReview: null,
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
  }] });
  const resolutionRace = workflow(threadState, resolutionClient);
  await assert.rejects(() => resolutionRace.api.verifyResolve(2, ['task-local']), {
    code: 'THREAD_PROOF_STALE',
  });
  assert.equal(resolutionRace.state.calls.length, 0);
  assert.equal(resolutionClient.events.length, 0);
});

test('reply-resolve fails on ambiguous roots and duplicate idempotency markers', async () => {
  const badRoot = new FakeClient();
  addThread(badRoot, { replies: [{ ...rootComment('THREAD_1'), id: 'ROOT_2' }] });
  await assert.rejects(() => workflow(integratedThreadState(), badRoot).api.replyResolve(2, 'task-thread'), {
    code: 'ROOT_IDENTITY_AMBIGUOUS',
  });

  const duplicate = new FakeClient();
  const root = addThread(duplicate);
  const marker = '<!-- aerstello-review:1234567890abcdef12345678 -->';
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

test('collect conservatively classifies canonical review bodies and attached roots', async () => {
  for (const [kind, expectedPhase] of [
    ['discovery', 'triaging'],
    ['verification', 'awaiting-human-decision'],
  ]) {
    const client = new FakeClient();
    client.reviews.push(canonicalReview({
      id: `PRR_body_${kind}`,
      body: 'Arbitrary canonical review body; its prose is not parsed.',
    }));
    const setup = workflow(pendingState(kind), client);
    const result = await setup.api.collect(2);
    assert.equal(result.outcome.outcome, 'findings');
    assert.equal(result.outcome.evidenceType, 'review-submission');
    assert.equal(result.phase, expectedPhase);
    assert.equal(client.threads.length, 0, 'a nonempty body needs no attached root');
  }

  for (const body of ['', ' \n\t ']) {
    const client = new FakeClient();
    client.reviews.push(canonicalReview({ body }));
    const result = await workflow(pendingState('discovery'), client).api.collect(2);
    assert.equal(result.outcome.outcome, 'clean');
    assert.equal(result.phase, 'validating');
  }

  const attachedClient = new FakeClient();
  attachedClient.reviews.push(canonicalReview({ id: 'PRR_attached', body: '' }));
  addThread(attachedClient, {
    root: rootComment('THREAD_1', { pullRequestReview: { id: 'PRR_attached' } }),
  });
  const attached = await workflow(pendingState('discovery'), attachedClient).api.collect(2);
  assert.equal(attached.outcome.outcome, 'findings');
  assert.equal(attached.phase, 'triaging');
});

test('collect rejects canonical reviews with missing or non-string bodies as unsupported', async () => {
  for (const [label, body, omitBody] of [
    ['missing', undefined, true],
    ['null', null, false],
    ['number', 1, false],
    ['object', {}, false],
  ]) {
    for (const kind of ['discovery', 'verification']) {
      const client = new FakeClient();
      const review = canonicalReview({ id: `PRR_${label}_${kind}`, body });
      if (omitBody) delete review.body;
      client.reviews.push(review);
      const setup = workflow(pendingState(kind), client);
      if (kind === 'discovery') {
        await assert.rejects(() => setup.api.collect(2), {
          code: 'DISCOVERY_COLLECTION_UNRESOLVED',
        }, label);
        assert.equal(setup.state.calls.length, 0, label);
      } else {
        const result = await setup.api.collect(2);
        assert.equal(result.escalated, true, label);
        assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence', label);
        assert.deepEqual(result.escalation.evidenceIds, [`review:${review.id}`], label);
      }
      assert.equal(client.events.length, 0, label);
    }
  }
});

test('collect records a unique canonical exact-head clean issue comment at the request-time boundary', async () => {
  const client = new FakeClient();
  client.comments.push(cleanIssueComment());
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.collect(2);
  assert.equal(result.outcome.evidenceType, 'issue-comment');
  assert.equal(result.outcome.outcome, 'clean');
  assert.equal(result.outcome.headSha, HEAD);
  assert.equal(result.outcome.databaseId, 202);
  assert.equal(result.outcome.reactionContent, null);
  assert.equal(result.phase, 'validating');
  assert.equal(setup.state.current.ciValidationStatus.status, 'not-run');
});

test('collect records the literal :tada: clean issue comment with exact immutable identity', async () => {
  const client = new FakeClient();
  const observed = cleanIssueComment({
    id: 'IC_kwDOTqOdrM8AAAABNuD83Q', databaseId: 5215681757,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-5215681757',
    body: CLEAN_TADA_COMMENT_BODY,
  });
  client.comments.push(observed);
  const setup = workflow(pendingState('discovery'), client);
  const result = await setup.api.collect(2);
  assert.deepEqual(result.outcome, {
    id: observed.id, databaseId: observed.databaseId, url: observed.url,
    headSha: HEAD, at: observed.createdAt, requestId: 'IC_request', kind: 'discovery',
    outcome: 'clean', evidenceType: 'issue-comment', reviewerLogin: BOT.login,
    reviewerNodeId: BOT.id, reviewerType: BOT.__typename, reviewerUrl: BOT.url,
    reactionContent: null, reactionCommentId: null,
  });
  assert.equal(client.comments.find((comment) => comment.id === observed.id).body, CLEAN_TADA_COMMENT_BODY);
  assert.equal(setup.state.calls.at(-1).name, 'checkpointReviewOutcome');
});

test('collect rejects same-SHA and conflicting duplicate clean-comment anchors for both formats', async () => {
  const formats = [
    { body: CLEAN_COMMENT_BODY, anchorSha: HEAD.slice(0, 10), conflictingSha: OTHER_HEAD.slice(0, 10) },
    { body: CLEAN_TADA_COMMENT_BODY, anchorSha: HEAD, conflictingSha: OTHER_HEAD },
  ];
  for (const format of formats) {
    for (const duplicateSha of [format.anchorSha, format.conflictingSha]) {
      const client = new FakeClient();
      client.comments.push(cleanIssueComment({
        body: withDuplicateCleanAnchor(format.body, duplicateSha),
      }));
      const setup = workflow(pendingState('discovery'), client);
      await assert.rejects(() => setup.api.collect(2), {
        code: 'DISCOVERY_COLLECTION_UNRESOLVED',
      });
      assert.equal(setup.state.calls.length, 0);
      assert.equal(setup.state.current.reviewOutcome, null);
    }
  }

  const unsupportedClient = new FakeClient();
  const unsupportedComment = cleanIssueComment({
    body: withDuplicateCleanAnchor(CLEAN_TADA_COMMENT_BODY, HEAD),
  });
  unsupportedClient.comments.push(unsupportedComment);
  const unsupported = await workflow(pendingState('verification'), unsupportedClient).api.collect(2);
  assert.equal(unsupported.escalated, true);
  assert.equal(unsupported.escalation.reason, 'ambiguous-canonical-evidence');
  assert.deepEqual(unsupported.escalation.evidenceIds, [`issue-comment:${unsupportedComment.id}`]);
});

test('collect ignores historical clean comments from prior requests', async () => {
  const historical = cleanIssueComment({
    id: 'IC_historical', databaseId: 199, createdAt: '2026-08-04T23:59:59Z',
    author: { ...BOT, id: null },
    body: CLEAN_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)),
  });
  const historicalOnlyClient = new FakeClient();
  historicalOnlyClient.comments.push(historical);
  const historicalOnly = workflow(pendingState('discovery'), historicalOnlyClient);
  await assert.rejects(() => historicalOnly.api.collect(2), {
    code: 'DISCOVERY_COLLECTION_UNRESOLVED',
  });
  assert.equal(historicalOnly.state.current.phase, 'awaiting-review');
  assert.equal(historicalOnly.state.current.reviewOutcome, null);
  assert.equal(historicalOnly.state.current.verificationEscalation, null);
  assert.equal(historicalOnly.state.calls.length, 0);

  const current = cleanIssueComment({
    id: 'IC_current', databaseId: 203, createdAt: '2026-08-05T00:00:01Z',
  });
  const currentClient = new FakeClient();
  currentClient.comments.push(historical, current);
  const currentSetup = workflow(pendingState('discovery'), currentClient);
  const collected = await currentSetup.api.collect(2);
  assert.equal(collected.outcome.id, current.id);
  assert.equal(collected.outcome.databaseId, current.databaseId);
  assert.equal(collected.outcome.evidenceType, 'issue-comment');
  assert.equal(currentSetup.state.calls.length, 1);
  assert.equal(currentSetup.state.calls[0].name, 'checkpointReviewOutcome');
});

test('clean issue comments fail closed for actors, time, anchors, and Git resolution', async () => {
  const cases = [
    { comment: cleanIssueComment({ author: VIEWER }) },
    { comment: cleanIssueComment({ body: `${githubReviewConstants.CLEAN_ISSUE_COMMENT_TEMPLATE}\n\nNo anchor` }) },
    { comment: cleanIssueComment({ body: `${githubReviewConstants.CLEAN_ISSUE_COMMENT_TEMPLATE}\n\n**Reviewed commit:** \`not-a-sha\`` }) },
    { comment: cleanIssueComment({ body: CLEAN_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)) }) },
    { comment: cleanIssueComment({ lastEditedAt: '2026-08-05T00:00:01Z' }) },
    { comment: cleanIssueComment(), git: fakeGit({ resolveCommitPrefix: async () => [] }) },
    { comment: cleanIssueComment(), git: fakeGit({ resolveCommitPrefix: async () => [HEAD, OTHER_HEAD] }) },
  ];
  for (const entry of cases) {
    const client = new FakeClient();
    client.comments.push(entry.comment);
    await assert.rejects(
      () => workflow(pendingState('discovery'), client, { git: entry.git }).api.collect(2),
      { code: 'DISCOVERY_COLLECTION_UNRESOLVED' },
    );
  }

  const incomplete = new FakeClient();
  incomplete.comments.push(cleanIssueComment({ author: { ...BOT, id: null } }));
  await assert.rejects(() => workflow(pendingState('discovery'), incomplete).api.collect(2), {
    code: 'CANONICAL_ACTOR_INCOMPLETE',
  });
});

test('unknown canonical no-major-issues wording and anchor variants are unsupported evidence', async () => {
  const prefix = "Codex Review: Didn't find any major issues.";
  const anchor = `**Reviewed commit:** \`${HEAD.slice(0, 10)}\``;
  const variants = [
    `${prefix} Good work!\n\n${anchor}`,
    `${prefix} 🎉\n\n${anchor}`,
    `${prefix}  Nice work!\n\n${anchor}`,
    `${prefix} Nice work.\n\n${anchor}`,
    `${prefix} nice work!\n\n${anchor}`,
    `${prefix} :TADA:\n\n${anchor}`,
    `${prefix} Nice work!\n${anchor}`,
    `${prefix} Nice work!\r\n\r\n${anchor}`,
    `${prefix} :tada:\n\n**Reviewed Commit:** \`${HEAD.slice(0, 10)}\``,
    `${prefix} :tada:\n\n**Reviewed commit:** \`${HEAD.slice(0, 10).toUpperCase()}\``,
  ];
  for (const [index, body] of variants.entries()) {
    const client = new FakeClient();
    const comment = cleanIssueComment({ id: `IC_variant_${index}`, databaseId: 300 + index, body });
    client.comments.push(comment);
    const setup = workflow(pendingState('verification'), client);
    const result = await setup.api.collect(2);
    assert.equal(result.escalated, true);
    assert.equal(result.escalation.reason, 'ambiguous-canonical-evidence');
    assert.deepEqual(result.escalation.evidenceIds, [`issue-comment:${comment.id}`]);
    assert.equal(setup.state.calls.at(-1).name, 'checkpointVerificationEscalation');
  }
});

test('either clean issue-comment format remains ambiguous beside any second canonical evidence', async () => {
  const mixed = new FakeClient();
  mixed.comments.push(
    cleanIssueComment(),
    cleanIssueComment({ id: 'IC_clean_tada', databaseId: 203, body: CLEAN_TADA_COMMENT_BODY }),
  );
  await assert.rejects(() => workflow(pendingState('discovery'), mixed).api.collect(2), {
    code: 'DISCOVERY_COLLECTION_UNRESOLVED',
  });

  for (const body of [CLEAN_COMMENT_BODY, CLEAN_TADA_COMMENT_BODY]) {
    for (const second of ['review', 'reaction']) {
      const client = new FakeClient();
      client.comments.push(cleanIssueComment({ body }));
      if (second === 'review') client.reviews.push({
        id: 'PRR_clean_2', databaseId: 204, url: 'https://x/review', body: '', state: 'COMMENTED',
        submittedAt: AT, commit: { oid: HEAD }, author: BOT,
      });
      if (second === 'reaction') client.reactions.set('IC_request', [{
        id: 'REACTION_clean_2', content: 'THUMBS_UP', createdAt: AT, user: BOT,
      }]);
      await assert.rejects(() => workflow(pendingState('discovery'), client).api.collect(2), {
        code: 'DISCOVERY_COLLECTION_UNRESOLVED',
      });
    }
  }
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

test('human-final collection is one-shot: clean validates, findings stop, and stale or ambiguous evidence escalates terminally', async () => {
  const cleanClient = new FakeClient();
  cleanClient.reviews.push(canonicalReview({
    id: 'PRR_human_final_clean', body: '', submittedAt: '2026-08-10T13:01:00Z',
  }));
  const clean = workflow(pendingHumanFinalState(), cleanClient);
  const cleanResult = await clean.api.collect(2);
  assert.equal(cleanResult.outcome.kind, 'human-final');
  assert.equal(cleanResult.outcome.outcome, 'clean');
  assert.equal(cleanResult.phase, 'validating');
  assert.equal(clean.state.current.reviewHistory.length, 5);

  const findingsClient = new FakeClient();
  findingsClient.reviews.push(canonicalReview({
    id: 'PRR_human_final_findings', body: 'One remaining finding.',
    submittedAt: '2026-08-10T13:01:00Z',
  }));
  const findings = workflow(pendingHumanFinalState(), findingsClient);
  const findingsResult = await findings.api.collect(2);
  assert.equal(findingsResult.outcome.outcome, 'findings');
  assert.equal(findingsResult.phase, 'awaiting-human-decision');

  const staleClient = new FakeClient();
  staleClient.metadata.headRefOid = OTHER_HEAD;
  const stale = await workflow(pendingHumanFinalState(), staleClient).api.collect(2);
  assert.equal(stale.escalated, true);
  assert.equal(stale.escalation.reason, 'request-head-drift');

  const ambiguousClient = new FakeClient();
  ambiguousClient.reviews.push(canonicalReview({
    id: 'PRR_human_final_ambiguous', body: '', submittedAt: '2026-08-10T13:01:00Z',
  }));
  ambiguousClient.reactions.set('IC_human_final_request', [{
    id: 'REACTION_human_final', content: 'THUMBS_UP',
    createdAt: '2026-08-10T13:01:00Z', user: BOT,
  }]);
  const ambiguous = workflow(pendingHumanFinalState(), ambiguousClient);
  const ambiguousResult = await ambiguous.api.collect(2);
  assert.equal(ambiguousResult.escalated, true);
  assert.equal(ambiguousResult.escalation.reason, 'ambiguous-canonical-evidence');
  assert.equal(ambiguous.state.current.phase, 'awaiting-human-decision');
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
  assert.equal(good.state.calls.at(-2).name, 'checkpointCiValidation');

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

test('complete freshly revalidates the recorded clean review submission body', async () => {
  const whitespaceClient = new FakeClient();
  whitespaceClient.reviews.push(canonicalReview({ body: ' \n\t ' }));
  assert.equal(
    (await workflow(completedState(), whitespaceClient).api.complete(2)).phase,
    'complete',
  );

  for (const [label, body, omitBody] of [
    ['nonempty', 'A newly visible threadless finding.', false],
    ['missing', undefined, true],
    ['null', null, false],
    ['number', 1, false],
  ]) {
    const client = new FakeClient();
    const review = canonicalReview({ body });
    if (omitBody) delete review.body;
    client.reviews.push(review);
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), {
      code: 'COMPLETION_NOT_READY',
    }, label);
    assert.equal(setup.state.calls.length, 0, label);
  }
});

test('complete freshly revalidates clean issue-comment identity and content', async () => {
  const goodClient = new FakeClient();
  goodClient.comments.push(cleanIssueComment());
  assert.equal((await workflow(issueCommentCompletedState(), goodClient).api.complete(2)).phase, 'complete');

  const tadaClient = new FakeClient();
  tadaClient.comments.push(cleanIssueComment({ body: CLEAN_TADA_COMMENT_BODY }));
  assert.equal((await workflow(issueCommentCompletedState(), tadaClient).api.complete(2)).phase, 'complete');

  const mutations = [
    null,
    cleanIssueComment({ id: 'IC_changed' }),
    cleanIssueComment({ databaseId: 999 }),
    cleanIssueComment({ url: 'https://github.com/example/aerstello/pull/2#issuecomment-mutated' }),
    cleanIssueComment({ createdAt: '2026-08-05T00:00:01Z' }),
    cleanIssueComment({ author: { ...BOT, id: 'BOT_changed' } }),
    cleanIssueComment({ author: { ...BOT, login: 'chatgpt-codex-connector-renamed' } }),
    cleanIssueComment({ author: { ...BOT, url: 'https://github.com/apps/another-app' } }),
    cleanIssueComment({ body: CLEAN_TADA_COMMENT_BODY, lastEditedAt: '2026-08-05T00:00:01Z' }),
    cleanIssueComment({ body: CLEAN_COMMENT_BODY.replace('Nice work!', 'Good work!') }),
    cleanIssueComment({ body: CLEAN_TADA_COMMENT_BODY.replace(':tada:', '🎉') }),
    cleanIssueComment({ body: CLEAN_TADA_COMMENT_BODY.replace('**Reviewed commit:**', '**Reviewed Commit:**') }),
    cleanIssueComment({ body: CLEAN_COMMENT_BODY.replace(HEAD.slice(0, 10), OTHER_HEAD.slice(0, 10)) }),
  ];
  for (const comment of mutations) {
    const client = new FakeClient();
    if (comment) client.comments.push(comment);
    await assert.rejects(() => workflow(issueCommentCompletedState(), client).api.complete(2), {
      code: 'COMPLETION_NOT_READY',
    });
  }
});

test('complete rejects same-SHA and conflicting duplicate clean-comment anchors for both formats', async () => {
  const formats = [
    { body: CLEAN_COMMENT_BODY, anchorSha: HEAD.slice(0, 10), conflictingSha: OTHER_HEAD.slice(0, 10) },
    { body: CLEAN_TADA_COMMENT_BODY, anchorSha: HEAD, conflictingSha: OTHER_HEAD },
  ];
  for (const format of formats) {
    for (const duplicateSha of [format.anchorSha, format.conflictingSha]) {
      const client = new FakeClient();
      client.comments.push(cleanIssueComment({
        body: withDuplicateCleanAnchor(format.body, duplicateSha),
      }));
      const setup = workflow(issueCommentCompletedState(), client);
      await assert.rejects(() => setup.api.complete(2), { code: 'COMPLETION_NOT_READY' });
      assert.equal(setup.state.calls.length, 0);
      assert.equal(setup.state.current.phase, 'validating');
    }
  }
});

test('complete reruns review and thread proof after checkpointing CI', async () => {
  class FinalSnapshotMutationClient extends FakeClient {
    constructor(mutate) {
      super();
      this.mutate = mutate;
      this.metadataReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestMetadata') {
        this.metadataReads += 1;
        if (this.metadataReads === 2) this.mutate(this);
      }
      return super.graphql(input);
    }
  }

  for (const { mutate, code } of [
    {
      mutate(client) { addThread(client, { id: 'THREAD_late' }); },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.reviews.length = 0; },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.reviews[0].body = 'A late threadless finding.'; },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) { client.comments.length = 0; },
      code: 'REQUEST_PROOF_STALE',
    },
  ]) {
    const client = new FinalSnapshotMutationClient(mutate);
    client.reviews.push({
      id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
      submittedAt: AT, commit: { oid: HEAD }, author: BOT,
    });
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), { code });
    assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCompletion'), false);
  }
});

test('complete rechecks that the same successful workflow evidence is still authoritative', async () => {
  class FinalCiMutationClient extends FakeClient {
    constructor(mutate) {
      super();
      this.mutate = mutate;
      this.checkReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks') {
        this.checkReads += 1;
        if (this.checkReads === 2) this.mutate(this);
      }
      return super.graphql(input);
    }
  }

  for (const { mutate, code } of [
    {
      mutate(client) {
        client.rollupState = 'PENDING';
        client.ciContexts = [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })];
      },
      code: 'CI_VALIDATION_PENDING',
    },
    {
      mutate(client) {
        client.rollupState = 'FAILURE';
        client.ciContexts = [fullValidationCheck({ conclusion: 'FAILURE' })];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.rollupState = 'FAILURE';
        client.ciContexts = [
          fullValidationCheck(),
          fullValidationCheck({ id: 'CHECK_parallel_failure', conclusion: 'FAILURE',
            completedAt: '2026-08-05T00:01:00Z', checkSuite: {
              app: { slug: 'github-actions' },
              workflowRun: { databaseId: 702,
                url: 'https://github.com/example/aerstello/actions/runs/702',
                file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } },
            } }),
        ];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.ciContexts = [fullValidationCheck({ completedAt: '2026-08-05T00:01:00Z', checkSuite: {
          app: { slug: 'github-actions' },
          workflowRun: { databaseId: 702, url: 'https://github.com/example/aerstello/actions/runs/702',
            file: { path: '.github/workflows/ci.yml' }, workflow: { name: 'CI' } },
        } })];
      },
      code: 'COMPLETION_NOT_READY',
    },
    {
      mutate(client) {
        client.ciContexts = [fullValidationCheck({ id: 'CHECK_rerun', completedAt: '2026-08-05T00:01:00Z' })];
      },
      code: 'COMPLETION_NOT_READY',
    },
  ]) {
    const client = new FinalCiMutationClient(mutate);
    client.reviews.push({
      id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
      submittedAt: AT, commit: { oid: HEAD }, author: BOT,
    });
    const setup = workflow(completedState(), client);
    await assert.rejects(() => setup.api.complete(2), { code });
    assert.equal(setup.state.calls.at(-1).name, 'checkpointCiValidation');
    assert.equal(setup.state.calls.some((call) => call.name === 'checkpointCompletion'), false);
  }
});

test('complete ignores unrelated context changes between authoritative CI reads', async () => {
  class UnrelatedContextMutationClient extends FakeClient {
    constructor() {
      super();
      this.checkReads = 0;
    }

    async graphql(input) {
      if (input.name === 'PullRequestChecks') {
        this.checkReads += 1;
        if (this.checkReads === 2) {
          this.ciContexts = [
            { __typename: 'StatusContext', id: 'STATUS_late', context: 'late status',
              state: 'FAILURE', targetUrl: 'https://github.com/example/aerstello' },
            { __typename: 'CheckRun', id: 'CHECK_late', databaseId: 999, name: 'late unrelated check',
              status: 'COMPLETED', conclusion: 'FAILURE', completedAt: AT,
              detailsUrl: 'https://github.com/example/aerstello/actions/runs/999/job/999', checkSuite: null },
            fullValidationCheck(),
          ];
        }
      }
      return super.graphql(input);
    }
  }

  const client = new UnrelatedContextMutationClient();
  client.reviews.push({
    id: 'PRR_clean', databaseId: 201, url: 'https://x/clean', body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT,
  });
  const setup = workflow(completedState(), client);
  const result = await setup.api.complete(2);
  assert.equal(result.phase, 'complete');
  assert.equal(setup.state.calls.at(-1).name, 'checkpointCompletion');
  assert.deepEqual(setup.state.current.ciValidationStatus.checks, ['Full validation']);
});

test('CLI rejects ambiguous or invalid task selections before external reads', async () => {
  const cases = [
    ['missing selection', ['verify-resolve', '--pr', '2'], /exactly one/u],
    ['both selections', [
      'verify-resolve', '--pr', '2', '--task', 'a', '--task-set-json', '["a"]',
    ], /exactly one/u],
    ['repeated task', [
      'verify-resolve', '--pr', '2', '--task=a', '--task=b',
    ], /--task may be specified only once/u],
    ['repeated task set', [
      'verify-resolve', '--pr', '2', '--task-set-json=["a"]', '--task-set-json=["b"]',
    ], /--task-set-json may be specified only once/u],
    ['task set for reply', [
      'reply-resolve', '--pr', '2', '--task-set-json', '["a"]',
    ], /only valid for verify-resolve/u],
    ['task set for unrelated command', [
      'refresh-threads', '--pr', '2', '--task-set-json', '["a"]',
    ], /only valid for verify-resolve/u],
    ['empty singleton', [
      'verify-resolve', '--pr', '2', '--task=',
    ], /--task must not be empty/u],
    ['malformed JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a"',
    ], /valid JSON/u],
    ['string JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '"a"',
    ], /nonempty array/u],
    ['object JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', '{"task":"a"}',
    ], /nonempty array/u],
    ['null JSON', [
      'verify-resolve', '--pr', '2', '--task-set-json', 'null',
    ], /nonempty array/u],
    ['empty JSON array', [
      'verify-resolve', '--pr', '2', '--task-set-json', '[]',
    ], /nonempty array/u],
    ['non-string JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a",1]',
    ], /unique nonempty strings/u],
    ['empty JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a",""]',
    ], /unique nonempty strings/u],
    ['duplicate JSON entry', [
      'verify-resolve', '--pr', '2', '--task-set-json', '["a","a"]',
    ], /unique nonempty strings/u],
  ];

  for (const [label, argv, pattern] of cases) {
    let stateReads = 0;
    let journalReads = 0;
    const state = {
      async load() {
        stateReads += 1;
        throw new Error('invalid CLI input must not load state');
      },
    };
    const journal = {
      async lookupIntent() { journalReads += 1; },
      async ensureIntent() { journalReads += 1; },
    };
    const client = new FakeClient();
    await assert.rejects(() => runCli(argv, {
      client, state, git: fakeGit(), clock: { now: () => AT }, journal,
    }), pattern, label);
    assert.equal(stateReads, 0, label);
    assert.equal(journalReads, 0, label);
    assert.equal(client.calls.length, 0, label);
    assert.equal(client.events.length, 0, label);
  }
});

test('CLI keeps opaque singleton IDs distinct from explicit JSON task sets', async () => {
  const ambiguousSingleton = integratedNonThreadState('local', 'a,b');
  ambiguousSingleton.tasks[0].fingerprint = 'fp-comma';
  ambiguousSingleton.tasks.push(
    { ...ambiguousSingleton.tasks[0], id: 'a', fingerprint: 'fp-task-a' },
    { ...ambiguousSingleton.tasks[0], id: 'b', fingerprint: 'fp-task-b' },
  );
  const singletonState = fakeState(ambiguousSingleton);
  const singleton = await runCli([
    'verify-resolve', '--pr', '2', '--task', 'a,b',
  ], {
    client: new FakeClient(), state: singletonState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(singleton.taskId, 'a,b');
  assert.deepEqual(singletonState.current.tasks.map((task) => task.status), [
    'completed', 'integrated', 'integrated',
  ]);

  const opaqueId = '  a,b "quoted" \\path  ';
  const opaqueStateValue = integratedNonThreadState('local', opaqueId);
  opaqueStateValue.tasks[0].fingerprint = 'fp-opaque';
  const opaqueState = fakeState(opaqueStateValue);
  const opaque = await runCli([
    'verify-resolve', '--pr', '2', '--task', opaqueId,
  ], {
    client: new FakeClient(), state: opaqueState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(opaque.taskId, opaqueId);
  assert.equal(opaqueState.current.tasks[0].id, opaqueId);
  assert.equal(opaqueState.current.tasks[0].status, 'completed');

  const setStateValue = completedThreadlessDriftState(['a', 'b']);
  setStateValue.tasks[0].fingerprint = 'fp-set-task-a';
  setStateValue.tasks[1].fingerprint = 'fp-set-task-b';
  setStateValue.tasks.push({
    ...integratedNonThreadState('local', 'a,b').tasks[0],
    fingerprint: 'fp-comma-local', integratedCommitSha: HEAD,
  });
  const setState = fakeState(setStateValue);
  const setClient = new FakeClient();
  setClient.metadata.headRefOid = OTHER_HEAD;
  const selectedSet = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', '["b","a"]',
  ], {
    client: setClient,
    state: setState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(selectedSet.taskIds, ['a', 'b']);
  assert.equal(setState.current.tasks.find((task) => task.id === 'a,b').status, 'integrated');

  const specialIds = [' leading ', 'trailing ', 'a,b', '"quoted"', '\\path'];
  const specialStateValue = completedThreadlessDriftState(specialIds);
  specialStateValue.tasks.forEach((task, index) => {
    task.fingerprint = `fp-special-${index}`;
  });
  const specialState = fakeState(specialStateValue);
  const specialClient = new FakeClient();
  specialClient.metadata.headRefOid = OTHER_HEAD;
  const special = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', JSON.stringify([...specialIds].reverse()),
  ], {
    client: specialClient,
    state: specialState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(special.taskIds, [...specialIds].sort());
  assert.deepEqual(
    specialState.current.threadResolutionStatus.threadlessVerification.taskIds,
    [...specialIds].sort(),
  );

  const replyId = ' thread,with "quotes" and \\slashes ';
  const replyStateValue = integratedThreadState();
  replyStateValue.tasks[0] = {
    ...replyStateValue.tasks[0], id: replyId, fingerprint: 'fp-opaque-reply',
  };
  const replyState = fakeState(replyStateValue);
  const replyClient = new FakeClient();
  addThread(replyClient);
  const reply = await runCli([
    'reply-resolve', '--pr', '2', '--task', replyId,
  ], {
    client: replyClient, state: replyState, git: fakeGit(), clock: { now: () => AT },
    journal: fakeJournal(),
  });
  assert.equal(reply.taskId, replyId);
  assert.equal(replyState.current.tasks[0].status, 'completed');
});

test('CLI exposes exactly the documented explicit-PR command surface and JSON-ready results', async () => {
  assert.match(usage(), /status[\s\S]*refresh-threads[\s\S]*reply-resolve[\s\S]*verify-resolve[\s\S]*request[\s\S]*collect[\s\S]*collect-ci[\s\S]*complete/u);
  assert.match(usage(), /Local task verification persists exact-current-HEAD proof[\s\S]*re-attest/u);
  await assert.rejects(() => runCli(['collect'], {}), /--pr/u);
  await assert.rejects(() => runCli(['refresh-threads'], {}), /--pr/u);
  await assert.rejects(() => runCli(['verify-resolve', '--pr', '2'], {}), /exactly one/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--task', 'x'], {}), /--task is only valid/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--kind', 'discovery'], {}), /--kind is only valid/u);
  await assert.rejects(() => runCli(['refresh-threads', '--pr', '2', '--human'], {}), /--human is only valid/u);
  await assert.rejects(() => runCli(['unknown', '--pr', '2'], {}), /Unknown command/u);
  await assert.rejects(() => runCli(['request', '--pr', '2', '--kind', 'other'], {}), /discovery\|verification/u);
  const client = new FakeClient();
  const state = fakeState(stateFixture());
  const result = await runCli(['status', '--pr', '2'], {
    client, state, git: fakeGit(), clock: { now: () => AT }, journal: fakeJournal(),
  });
  assert.equal(result.prNumber, 2);
  const taskless = fakeState(stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  }));
  const refreshed = await runCli(['refresh-threads', '--pr', '2'], {
    client: new FakeClient(), state: taskless, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(refreshed.threadResolutionStatus.status, 'passed');
  const verifiedState = fakeState(integratedNonThreadState());
  const verified = await runCli(['verify-resolve', '--pr', '2', '--task', 'task-local'], {
    client: new FakeClient(), state: verifiedState, git: fakeGit(), clock: { now: () => AT },
  });
  assert.equal(verified.taskId, 'task-local');
  assert.equal(verifiedState.current.tasks[0].status, 'completed');
  const threadlessSetState = fakeState(completedThreadlessDriftState([
    'threadless-a', 'threadless-b',
  ]));
  const threadlessSetClient = new FakeClient();
  threadlessSetClient.metadata.headRefOid = OTHER_HEAD;
  const threadlessSet = await runCli([
    'verify-resolve', '--pr', '2', '--task-set-json', '["threadless-b","threadless-a"]',
  ], {
    client: threadlessSetClient,
    state: threadlessSetState,
    git: fakeGit({
      snapshot: async () => ({ headSha: OTHER_HEAD, dirty: false }),
      pushedHead: async () => OTHER_HEAD,
    }),
    clock: { now: () => AT },
  });
  assert.deepEqual(threadlessSet.taskIds, ['threadless-a', 'threadless-b']);
  assert.equal(threadlessSetState.current.revision, completedThreadlessDriftState().revision + 1);
  assert.equal(threadlessSetClient.events.length, 0);
  const human = await runCli(['status', '--human'], {
    client, state, git: fakeGit(), clock: { now: () => AT },
  });
  assert.match(human.human, /PR: #2[\s\S]*Current commit:[\s\S]*Codex review:[\s\S]*Tasks:[\s\S]*Full CI: Passed[\s\S]*Open Codex threads: 0[\s\S]*Next action:/u);
  const done = renderHumanStatus({ ...result, statePhase: 'complete', taskStatus: {
    resolved: 1, pending: 0, display: 'Done',
    items: [{ id: 'finding-a', summary: 'Preserve exact SHA evidence.', status: 'Done' }],
  } });
  assert.match(done, /Phase: Done[\s\S]*Tasks: Done[\s\S]*finding-a: Done — Preserve exact SHA evidence\./u);

  const stale = renderHumanStatus({
    ...result,
    statePhase: 'complete',
    liveHeadSha: OTHER_HEAD,
    codexReview: 'clean',
    targetedValidation: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    nextAction: 'Archive the completed cycle.',
    taskStatus: {
      resolved: 1, pending: 0, display: 'Done',
      items: [{ id: 'finding-a', summary: 'Preserve exact SHA evidence.', status: 'Done' }],
    },
  });
  assert.match(stale, new RegExp(`Current commit: ${HEAD} \\(DOES NOT MATCH PR head ${OTHER_HEAD}\\)`, 'u'));
  assert.match(stale, /Phase: Stale \(recorded Done; PR head changed\)/u);
  assert.match(stale, /Codex review: Stale clean evidence \(commit mismatch\)/u);
  assert.doesNotMatch(stale, /Phase: Done|Codex review: Clean|Tasks: Done/u);
  assert.match(stale, /Targeted local tests: Passed .* for the recorded commit; PR head differs/u);
  assert.match(stale, /Full CI: Passed .*live PR head differs from the recorded commit/u);
  assert.match(stale, new RegExp(`Next action: Reconcile recorded commit with live PR head ${OTHER_HEAD}`, 'u'));
});

test('default gh GraphQL transport preserves literal strings and typed scalar variables', async () => {
  const calls = [];
  const client = createDefaultGitHubClient((command, args, options) => {
    calls.push({ command, args, options });
    return JSON.stringify({ data: { ok: true } });
  });
  const result = await client.graphql({
    query: 'mutation($body:String!,$pr:Int!,$enabled:Boolean!){example}',
    variables: {
      body: '@codex review', owner: 'openai/aerstello', pr: 2, enabled: true,
      cursor: null, absent: undefined,
    },
  });
  assert.deepEqual(result, { data: { ok: true } });
  assert.deepEqual(calls[0].args, [
    'api', 'graphql',
    '-f', 'query=mutation($body:String!,$pr:Int!,$enabled:Boolean!){example}',
    '-f', 'body=@codex review',
    '-f', 'owner=openai/aerstello',
    '-F', 'pr=2',
    '-F', 'enabled=true',
  ]);
  assert.equal(calls[0].args.includes('codex review'), false, 'the literal body remains one raw-field argument');
});

test('default gh GraphQL transport rejects unsupported values before invoking gh', async () => {
  let invocations = 0;
  const client = createDefaultGitHubClient(() => {
    invocations += 1;
    return '{}';
  });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, {}, [], 1n]) {
    await assert.rejects(() => client.graphql({ query: 'query{viewer{login}}', variables: { value } }), {
      code: 'INVALID_GRAPHQL_VARIABLE',
    });
  }
  assert.equal(invocations, 0);
  assert.deepEqual(buildGhGraphqlArgs('query{viewer{login}}', { nullable: null, missing: undefined }),
    ['api', 'graphql', '-f', 'query=query{viewer{login}}']);
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
    const baseBody = `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`;
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
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(operationId)}`,
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
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
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
  await assert.rejects(() => setup.api.request(2, 'discovery'), { code: 'REQUEST_BASELINE_COLLISION' });
  assert.equal(journal.intents.size, 0);
  assert.equal(client.calls.filter((call) => call.name === 'AddReviewRequest').length, 0);
  assert.equal(setup.state.calls.length, 0);
});

test('a fresh later ordinal excludes prior review-history request IDs', async () => {
  const prior = completedState();
  const state = { ...prior, phase: 'ready-for-review',
    nextAction: 'Request another discovery review.' };
  const client = new FakeClient();
  client.comments.push({ id: 'IC_request', databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-101', body: '@codex review',
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
      body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: npm run check.\n${markerFor(replyOperation)}`,
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
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: old validation.\n${markerFor(oldOperation)}`,
  }] });
  const task = integratedThreadState().tasks[0];
  task.status = 'completed';
  const historical = readyState({
    currentIntegrationHeadSha: OTHER_HEAD,
    git: { branch: 'main', headSha: OTHER_HEAD, dirty: false },
    validationStatus: { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['new validation'], updatedAt: AT },
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
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
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
    new RegExp(`Aerstello review resolution at ${OTHER_HEAD}`, 'u'));

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
    body: `Aerstello review resolution at ${OTHER_HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-B check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
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
    body: `Aerstello review resolution at ${HEAD}.\nTasks:\n- task-thread: ${HEAD}\nValidation: head-A check.\n${markerFor(operationId)}` }] });
  const state = integratedThreadState();
  state.currentIntegrationHeadSha = OTHER_HEAD;
  state.git = { branch: 'main', headSha: OTHER_HEAD, dirty: false };
  state.validationStatus = { source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: OTHER_HEAD, checks: ['head-B check'], updatedAt: AT };
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
