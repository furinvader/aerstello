import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { createHash } from 'node:crypto';

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import { join } from 'node:path';

import { test } from 'node:test';

import {
  ARCHIVE_FIXTURE_MANIFEST,
  loadArchiveFixture,
  PACKET_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_NAME,
} from '../archive/archive-fixture-loader.mjs';

import { createRepository, git, writeFiles } from '../../../../../../tests/support/git-fixtures.mjs';

import {
  createGitHubReviewWorkflow,
} from '../create-workflow.mjs';

import { GitHubWorkflowError } from '../errors.mjs';

import { CANONICAL_LOGIN, CANONICAL_URL } from '../evidence/actors.mjs';

import {
  FULL_VALIDATION_CHECK,
  FULL_VALIDATION_WORKFLOW,
  FULL_VALIDATION_WORKFLOW_PATH,
  GITHUB_ACTIONS_APP,
} from '../evidence/ci.mjs';

import { PAGE_SIZE } from '../graphql/operations.mjs';

import { readTopLevelComments } from '../graphql/pull-request-reader.mjs';

import { REQUEST_BODY } from '../mutations/draft-review-request.mjs';

import {
  buildGhGraphqlArgs,
  createDefaultGitHubClient,
} from '../adapters/gh-cli.mjs';

import { createDefaultGitAdapter } from '../adapters/git.mjs';

import {
  createDefaultArchiveStore,
  terminateOnFatalArchiveCwd,
} from '../archive/store.mjs';

import { renderHumanStatus } from '../status-renderer.mjs';

import { withGitHubRequestOwnerLock } from '../../state/state.mjs';

const HEAD = 'a'.repeat(40);

const OTHER_HEAD = 'b'.repeat(40);

const ADVANCED_HEAD = 'c'.repeat(40);

const PRIOR_INTEGRATION_HEAD = '4b8d4d36dd6ea4da9d1c1a0e39033a829e1852f9';

const SELECTED_TASK_HEAD = '7ea9bbccc60725dcfd0cfefcb0caff742145b8ec';

const AT = '2026-08-05T00:00:00Z';

const GITHUB_CLI_MODULE_URL = new URL('../cli.mjs', import.meta.url).href;

const githubReviewConstants = {
  CANONICAL_LOGIN, CANONICAL_URL, REQUEST_BODY, PAGE_SIZE, FULL_VALIDATION_CHECK, GITHUB_ACTIONS_APP,
  FULL_VALIDATION_WORKFLOW, FULL_VALIDATION_WORKFLOW_PATH,
};

const BOT = {
  __typename: 'Bot', login: 'chatgpt-codex-connector',
  url: 'https://github.com/apps/chatgpt-codex-connector', id: 'BOT_codex',
};

const VIEWER = { __typename: 'User', login: 'maintainer', url: 'https://github.com/maintainer', id: 'USER_1' };

function darwinArchiveRuntime(overrides = {}) {
  return {
    platform: 'darwin',
    isMainThread: true,
    cwd: () => process.cwd(),
    chdir: (path) => process.chdir(path),
    runSynchronous: (callback) => callback(),
    ...overrides,
  };
}

function trackedArchiveFileSystem(overrides = {}) {
  const opened = [];
  const closed = [];
  return {
    opened,
    closed,
    overrides: {
      openSync: (path, flags) => {
        const fd = openSync(path, flags);
        opened.push(fd);
        return fd;
      },
      closeSync: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
      ...overrides,
    },
  };
}

function assertTrackedArchiveDescriptorsClosed(tracker) {
  assert.deepEqual(
    [...tracker.closed].sort((left, right) => left - right),
    [...tracker.opened].sort((left, right) => left - right),
  );
}

const STRUCTURAL_COMMENT_BODY = `Chef's kiss.\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\`\n\n<details>About Codex</details>`;

const ALTERNATE_STRUCTURAL_COMMENT_BODY = `Review finished with different prose.\n\n**Reviewed commit:** \`${HEAD}\`\n\n<details>About Codex</details>`;


const PACKET_ARCHIVE_FIXTURE = loadArchiveFixture(PACKET_ARCHIVE_NAME);
const PACKET_ARCHIVE_STATE_SHA256 = ARCHIVE_FIXTURE_MANIFEST[PACKET_ARCHIVE_NAME].stateSha256;
const PACKET_ARCHIVE_EVENTS_SHA256 = ARCHIVE_FIXTURE_MANIFEST[PACKET_ARCHIVE_NAME].eventsSha256;
const PACKET_ARCHIVE_STATE_BASE64 = PACKET_ARCHIVE_FIXTURE.stateBytes.toString('base64');
const PACKET_ARCHIVE_EVENTS_BASE64 = PACKET_ARCHIVE_FIXTURE.eventsBytes.toString('base64');

const PACKET_MIXED_ARCHIVE_FIXTURE = loadArchiveFixture(PACKET_MIXED_ARCHIVE_NAME);
const PACKET_MIXED_ARCHIVE_STATE_SHA256 = ARCHIVE_FIXTURE_MANIFEST[PACKET_MIXED_ARCHIVE_NAME].stateSha256;
const PACKET_MIXED_ARCHIVE_EVENTS_SHA256 = ARCHIVE_FIXTURE_MANIFEST[PACKET_MIXED_ARCHIVE_NAME].eventsSha256;
const PACKET_MIXED_ARCHIVE_STATE_BASE64 = PACKET_MIXED_ARCHIVE_FIXTURE.stateBytes.toString('base64');
const PACKET_MIXED_ARCHIVE_EVENTS_BASE64 = PACKET_MIXED_ARCHIVE_FIXTURE.eventsBytes.toString('base64');





















function withDuplicateReviewedCommitAnchor(body, sha) {
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
  const state = {
    schemaVersion: 3, revision: 1, repository: 'example/aerstello', prNumber: 2, phase: 'recovering',
    baseSha: HEAD, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: HEAD,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [],
    staleDiscoveryDispositions: [],
    scopeControl: {
      authorityDigest: `sha256:${'a'.repeat(64)}`,
      journalDigest: `sha256:${'b'.repeat(64)}`,
      returnDigest: null,
      gate: 'ready',
      assessmentHeadSha: null,
      updatedAt: AT,
    },
    verificationEscalation: null, threadResolutionStatus: proof('not-run'), blockedReasons: [],
    validationStatus: { source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null },
    ciValidationStatus: { source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
      checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null },
    ciValidationHistory: [],
    nextAction: 'Recover.', integrationWorktree: '/tmp/integration', orchestratorSessionId: null,
    abandonmentReason: null, git: { branch: 'main', headSha: HEAD, dirty: false }, updatedAt: AT,
    ...overrides,
  };
  return state;
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

function tasklessPendingReviewHeadDriftState(overrides = {}) {
  const completedHistory = [
    cleanReviewEntry(1, 'discovery'),
    cleanReviewEntry(2, 'discovery'),
    cleanReviewEntry(3, 'discovery'),
  ];
  const request = requestEvidence('verification', {
    id: 'IC_verification_4',
    databaseId: 104,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-104',
    headSha: OTHER_HEAD,
  });
  return stateFixture({
    phase: 'recovering',
    requestedHeadSha: OTHER_HEAD,
    reviewedHeadSha: null,
    reviewRound: 3,
    verificationReviewUsed: true,
    reviewRequest: request,
    reviewOutcome: null,
    reviewHistory: [...completedHistory, { request, outcome: null }],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Rebuild current-head empty-thread proof before the replacement review.',
    ...overrides,
  });
}

function tasklessPendingDiscoveryHeadDriftState(overrides = {}) {
  const request = requestEvidence('discovery', {
    id: 'IC_discovery_stale',
    databaseId: 105,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-105',
    headSha: OTHER_HEAD,
  });
  return stateFixture({
    phase: 'recovering',
    requestedHeadSha: OTHER_HEAD,
    reviewedHeadSha: null,
    reviewRound: 1,
    verificationReviewUsed: false,
    reviewRequest: request,
    reviewOutcome: null,
    reviewHistory: [{ request, outcome: null }],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    threadResolutionStatus: proof('not-run'),
    nextAction: 'Classify the stale discovery response before the replacement review.',
    ...overrides,
  });
}

function canonicalReview(overrides = {}) {
  return {
    id: 'PRR_clean', databaseId: 201,
    url: 'https://github.com/example/aerstello/pull/2#pullrequestreview-201',
    body: '', state: 'COMMENTED',
    submittedAt: AT, commit: { oid: HEAD }, author: BOT, ...overrides,
  };
}

function cleanIssueComment(overrides = {}) {
  return {
    id: 'IC_clean', databaseId: 202,
    url: 'https://github.com/example/aerstello/pull/2#issuecomment-202',
    body: STRUCTURAL_COMMENT_BODY, createdAt: AT, lastEditedAt: null, author: BOT, ...overrides,
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
    body: 'Canonical finding.', createdAt: AT, lastEditedAt: null, author: BOT, replyTo: null,
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

function passedCiEvidence() {
  return {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation'], checkRunId: 'CHECK_full', workflowRunId: 701,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/701', updatedAt: AT,
  };
}

class FakeClient {
  constructor(overrides = {}) {
    this.metadata = {
      id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
      headRefOid: HEAD, state: 'OPEN', isDraft: false, viewer: VIEWER,
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
    this.throwAfterMutation = overrides.throwAfterMutation ?? new Set();
    Object.assign(this, overrides);
    this.metadata = { id: 'PR_node', number: 2, url: 'https://github.com/example/aerstello/pull/2',
      headRefOid: HEAD, state: 'OPEN', isDraft: false, viewer: VIEWER, ...overrides.metadata };
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
        id: this.metadata.id, number: this.metadata.number, state: this.metadata.state,
        isDraft: this.metadata.isDraft, headRefOid: this.metadata.headRefOid,
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
        createdAt: AT, lastEditedAt: null, author: this.metadata.viewer,
      });
    }
    if (name === 'MarkPullRequestReadyForReview' && !this.noEffect.has(name)) this.metadata.isDraft = false;
    if (name === 'AddThreadReply' && !this.noEffect.has(name)) {
      const comments = this.threadComments.get(variables.threadId);
      comments.push({
        id: `REPLY_${comments.length}`, databaseId: 900 + comments.length,
        url: 'https://github.com/example/aerstello/pull/2#discussion_reply', body: variables.body,
        createdAt: AT, lastEditedAt: null, author: this.metadata.viewer,
        replyTo: { id: comments.find((item) => item.replyTo === null).id },
        pullRequestReview: null,
      });
    }
    if (name === 'ResolveThread' && !this.noEffect.has(name)) {
      this.threads.find((thread) => thread.id === variables.threadId).isResolved = true;
    }
    if (this.throwAfterMutation.has(name)) throw new Error(`lost ${name} response`);
    const payload = name === 'AddReviewRequest' ? 'addComment'
      : name === 'MarkPullRequestReadyForReview' ? 'markPullRequestReadyForReview'
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
  const dispatches = new Map();
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
    async claimDispatch(intent) {
      const exists = dispatches.has(intent.operationId);
      if (!exists) dispatches.set(intent.operationId, {
        operationId: intent.operationId, clientMutationId: intent.clientMutationId,
      });
      return { ...dispatches.get(intent.operationId), isNew: !exists };
    },
  };
}

function racingRequestJournal(intent, events = []) {
  let concurrentIntent = null;
  let dispatched = false;
  return {
    async lookupIntent() {
      return concurrentIntent ? { ...concurrentIntent, isNew: false } : null;
    },
    async ensureIntent() {
      events.push('intent:request');
      concurrentIntent = structuredClone(intent);
      return { ...concurrentIntent, isNew: false };
    },
    async claimDispatch() { const isNew = !dispatched; dispatched = true; return { isNew }; },
  };
}

function fakeState(initial) {
  let current = structuredClone(initial);
  const calls = [];
  let scopeStatusOverride = null;
  let beforeCheckpoint = null;
  async function runCheckpointHook(name, input) {
    if (beforeCheckpoint === null || (beforeCheckpoint.name !== null && beforeCheckpoint.name !== name)) return;
    const hook = beforeCheckpoint.hook;
    beforeCheckpoint = null;
    await hook({ name, input, current: structuredClone(current), replaceCurrent(next) { current = structuredClone(next); } });
  }
  return {
    calls,
    get current() { return current; },
    advanceRevisionForTest() { current = { ...current, revision: current.revision + 1 }; },
    setScopeStatusForTest(value) { scopeStatusOverride = structuredClone(value); },
    setBeforeCheckpointForTest(hook, name = null) { beforeCheckpoint = { hook, name }; },
    async load() { return structuredClone(current); },
    async scopeStatus() {
      if (scopeStatusOverride !== null) return structuredClone(scopeStatusOverride);
      const entries = current.tasks.map((task, index) => ({
        kind: 'classification',
        sequence: index + 1,
        rootCauseId: task.id,
        findingIds: task.sourceIds ?? [task.id],
        classification: task.disposition === 'out-of-scope'
          ? 'unrelated-follow-up' : 'within-scope-defect',
        reviewHeadSha: current.currentIntegrationHeadSha,
        assessment: {
          packet: { minimalClosure: { statement: 'Keep the fixture within its accepted boundary.' } },
          result: { narrowAlternative: 'Keep only the selected root.' },
        },
      }));
      return {
        configured: true,
        gate: current.scopeControl.gate,
        reference: structuredClone(current.scopeControl),
        authority: {
          digest: current.scopeControl.authorityDigest,
          value: {
            authorityKind: 'standalone',
            source: { identity: 'example/aerstello#fixture' },
            minimalClosure: { statement: 'Keep the fixture within its accepted boundary.' },
            handoffHeadSha: current.currentIntegrationHeadSha,
          },
        },
        journal: {
          digest: current.scopeControl.journalDigest,
          value: { entries },
        },
        return: null,
      };
    },
    async checkpointReviewRequest(input) {
      calls.push({ name: 'checkpointReviewRequest', input });
      const request = input.request;
      current = {
        ...current, revision: current.revision + 1, phase: 'awaiting-review',
        requestedHeadSha: request.headSha, reviewedHeadSha: null,
        reviewRound: request.kind === 'discovery' ? current.reviewRound + 1 : current.reviewRound,
        verificationReviewUsed: request.kind === 'verification' ? true : current.verificationReviewUsed,
        reviewRequest: request, reviewOutcome: null,
        reviewHistory: [...current.reviewHistory, { request, outcome: null }],
      };
      return structuredClone(current);
    },
    async checkpointCiValidation(input) {
      await runCheckpointHook('checkpointCiValidation', input);
      if (input.expectedRevision !== current.revision) { const error = new Error('revision conflict'); error.code = 'STATE_REVISION_CONFLICT'; throw error; }
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
      await runCheckpointHook('checkpointReviewOutcome', input);
      if (input.expectedRevision !== current.revision) { const error = new Error('revision conflict'); error.code = 'STATE_REVISION_CONFLICT'; throw error; }
      calls.push({ name: 'checkpointReviewOutcome', input });
      const outcome = input.outcome;
      current = {
        ...current, revision: current.revision + 1, reviewedHeadSha: outcome.headSha,
        reviewOutcome: outcome,
        reviewHistory: current.reviewHistory.map((entry, index) => (
          index === current.reviewHistory.length - 1 ? { ...entry, outcome } : entry
        )),
        phase: outcome.outcome === 'findings' ? 'triaging' : 'validating',
      };
      return structuredClone(current);
    },
    async checkpointVerificationEscalation(input) {
      await runCheckpointHook('checkpointVerificationEscalation', input);
      if (input.expectedRevision !== current.revision) { const error = new Error('revision conflict'); error.code = 'STATE_REVISION_CONFLICT'; throw error; }
      calls.push({ name: 'checkpointVerificationEscalation', input });
      current = { ...current, revision: current.revision + 1, phase: 'awaiting-human-decision', verificationEscalation: input.escalation };
      return structuredClone(current);
    },
    async checkpointTaskCompletion(input) {
      calls.push({ name: 'checkpointTaskCompletion', input });
      if (input.expectedRevision !== current.revision) {
        const error = new Error('State revision changed during task completion');
        error.code = 'STATE_REVISION_CONFLICT';
        throw error;
      }
      const dispositions = current.staleDiscoveryDispositions ?? [];
      const existingDisposition = input.staleDiscoveryDisposition === undefined ? null
        : dispositions.find((entry) => entry.requestId === input.staleDiscoveryDisposition.requestId) ?? null;
      if (existingDisposition !== null
          && JSON.stringify(existingDisposition) === JSON.stringify(input.staleDiscoveryDisposition)
          && JSON.stringify(current.threadResolutionStatus) === JSON.stringify(input.threadResolutionStatus)) {
        return structuredClone(current);
      }
      const stalePendingRecovery = ['recovering', 'triaging'].includes(current.phase)
        && current.tasks.length === 0
        && current.reviewRequest !== null
        && current.reviewOutcome === null
        && current.reviewHistory.at(-1)?.outcome === null
        && current.reviewedHeadSha === null
        && current.reviewRequest.headSha !== current.currentIntegrationHeadSha
        && current.validationStatus.status === 'passed'
        && current.validationStatus.headSha === current.currentIntegrationHeadSha;
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
      const nextRevision = current.revision + 1;
      const usedRequests = (current.legacyReviewProvenance?.discoveryRounds ?? 0)
        + current.reviewHistory.length;
      const exhausted = Number.isSafeInteger(current.reviewRequestLimit)
        && usedRequests >= current.reviewRequestLimit;
      const staleDiscoveryDispositions = input.staleDiscoveryDisposition === undefined
        ? dispositions : [...dispositions, input.staleDiscoveryDisposition];
      const dispositionFindings = input.staleDiscoveryDisposition?.evidence?.outcome === 'findings';
      current = {
        ...next,
        revision: nextRevision,
        staleDiscoveryDispositions,
        ...(stalePendingRecovery
          && !dispositionFindings
          && threadResolutionStatus.status === 'passed'
          && threadResolutionStatus.headSha === current.currentIntegrationHeadSha
          && threadResolutionStatus.threads.length === 0 ? {
            phase: 'ready-for-review',
            nextAction: exhausted
              ? `Review request limit ${current.reviewRequestLimit} is exhausted after ${usedRequests} durable requests; run npm run review:state -- set-review-limit --pr ${current.prNumber} --expected-revision ${nextRevision} --limit <higher-number> or --unlimited before the next request.`
              : `Request canonical ${usedRequests < 3 ? 'discovery' : 'verification'} review.`,
          } : {}),
        ...(dispositionFindings ? {
          phase: 'triaging',
          threadResolutionStatus: {
            ...threadResolutionStatus, status: 'not-run', headSha: null, updatedAt: null,
          },
          nextAction: 'Triage the actionable findings from the dispositioned stale discovery response.',
        } : {}),
      };
      return structuredClone(current);
    },
    async checkpointArchiveTaskCompletion(input) {
      const callIndex = calls.length;
      const next = await this.checkpointTaskCompletion(input);
      calls[callIndex] = { ...calls[callIndex], name: 'checkpointArchiveTaskCompletion' };
      return next;
    },
    async checkpointCompletion(input) {
      await runCheckpointHook('checkpointCompletion', input);
      if (input.expectedRevision !== current.revision) { const error = new Error('revision conflict'); error.code = 'STATE_REVISION_CONFLICT'; throw error; }
      calls.push({ name: 'checkpointCompletion', input });
      if (current.phase === 'complete') return structuredClone(current);
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
      createdAt: initial.reviewRequest.at, lastEditedAt: null,
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
      archiveStore: options.archiveStore,
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

const ARCHIVE_REPLY_INTENT_AT = '2026-08-04T23:58:30.000Z';

const ARCHIVE_REPLY_AT = '2026-08-04T23:59:00.000Z';

const ARCHIVE_RESOLVE_INTENT_AT = '2026-08-04T23:59:30.000Z';

const ARCHIVE_PROOF_RESOLVED_AT = '2026-08-04T23:59:45.000Z';

const ARCHIVE_STATE_AT = '2026-08-05T00:01:00.000Z';

const ARCHIVE_EVENT_AT = '2026-08-05T00:01:00.010Z';

const ARCHIVED_TASK_ID = 'archived-resolved-batch';

const ARCHIVE_REMEDIATION_ID = 'archive-adoption-remediation';

const PACKET_ARCHIVE_LIVE_TIMES = new Map([
  ['PRRT_kwDOTqOdrM6aWc8f', { rootCreatedAt: '2026-08-19T05:01:01.000Z', replyCreatedAt: '2026-08-19T15:31:11.000Z' }],
  ['PRRT_kwDOTqOdrM6aWc8k', { rootCreatedAt: '2026-08-19T05:01:01.000Z', replyCreatedAt: '2026-08-19T15:32:01.000Z' }],
  ['PRRT_kwDOTqOdrM6aWc8m', { rootCreatedAt: '2026-08-19T05:01:01.000Z', replyCreatedAt: '2026-08-19T15:32:44.000Z' }],
  ['PRRT_kwDOTqOdrM6aWc8q', { rootCreatedAt: '2026-08-19T05:01:01.000Z', replyCreatedAt: '2026-08-19T15:33:27.000Z' }],
  ['PRRT_kwDOTqOdrM6aWc8t', { rootCreatedAt: '2026-08-19T05:01:01.000Z', replyCreatedAt: '2026-08-19T15:34:08.000Z' }],
]);

const PACKET_UNRESOLVED_THREAD_IDS = Object.freeze([
  'PRRT_kwDOTqOdrM6ahnN9',
  'PRRT_kwDOTqOdrM6ahnOB',
  'PRRT_kwDOTqOdrM6ahnOF',
]);

const PACKET_AGGREGATE_HEAD = 'c2d593fdc3bc6efda78249450bedaaac60065403';

const PACKET_AGGREGATE_TASK_ID = 'retained-pr35-nine-roots-r1';

const PACKET_PORTABILITY_TASK_ID = 'retained-pr35-portable-archive-reader-r1';

const PACKET_PORTABILITY_THREAD_ID = 'PRRT_kwDOTqOdrM6awEjF';

const PACKET_MIXED_LIVE_TIMES = new Map([
  ['PRRT_kwDOTqOdrM6ahnN9', { rootCreatedAt: '2026-08-19T15:43:55.000Z', replyCreatedAt: '2026-08-20T07:15:26.000Z' }],
  ['PRRT_kwDOTqOdrM6ahnOB', { rootCreatedAt: '2026-08-19T15:43:55.000Z', replyCreatedAt: '2026-08-20T07:16:22.000Z' }],
  ['PRRT_kwDOTqOdrM6ahnOF', { rootCreatedAt: '2026-08-19T15:43:55.000Z', replyCreatedAt: '2026-08-20T07:17:17.000Z' }],
  ['PRRT_kwDOTqOdrM6auUvO', { rootCreatedAt: '2026-08-20T07:29:03.000Z', replyCreatedAt: '2026-08-20T08:58:26.000Z' }],
]);

function archivedBatchTask(status = 'not-applicable') {
  return {
    id: ARCHIVED_TASK_ID,
    sourceIds: ['thread:THREAD_ARCHIVE_A', 'thread:THREAD_ARCHIVE_B'],
    sourceType: 'github-thread', fingerprint: 'fp-archived-resolved-batch',
    summary: 'Adopt the exact already-resolved archived roots.', severity: 'P1',
    disposition: 'already-fixed', status, integratedCommitSha: null,
    resolutionSummary: 'Already fixed and independently verified.',
  };
}

function archiveIntentEvent(type, operationId, at, eventAt = new Date(Date.parse(at) + 1).toISOString()) {
  return {
    schemaVersion: 1,
    type: 'github-mutation-intent',
    summary: `Intent ${type} ${operationId}`,
    at: eventAt,
    details: priorIntent(type, operationId, at),
  };
}

function immutableArchiveStore(records, onList = null, { clone = true } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async list() {
      calls += 1;
      await onList?.(calls);
      return clone ? structuredClone(records) : records;
    },
  };
}

function archiveAdoptionFixture({
  currentHeadSha = HEAD,
  historicalHeadSha = OTHER_HEAD,
  integrationWorktree = '/tmp/integration',
} = {}) {
  const selectedTask = archivedBatchTask();
  const remediation = {
    id: ARCHIVE_REMEDIATION_ID, sourceIds: ['orchestrator:archive-adoption'],
    sourceType: 'github-threadless', fingerprint: 'fp-archive-adoption-remediation',
    summary: 'Implement archive adoption.', severity: 'P1', disposition: 'actionable',
    status: 'completed', integratedCommitSha: currentHeadSha, resolutionSummary: 'Implemented and verified.',
  };
  const currentThreadTask = {
    ...integratedThreadState(['thread:THREAD_CURRENT']).tasks[0],
    id: 'current-thread-fix', fingerprint: 'fp-current-thread-fix', integratedCommitSha: currentHeadSha,
  };
  const active = readyState({
    phase: 'verifying',
    currentIntegrationHeadSha: currentHeadSha,
    integrationWorktree,
    git: { branch: 'main', headSha: currentHeadSha, dirty: false },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: currentHeadSha,
      checks: ['npm run test:pr-review'], updatedAt: AT,
    },
    tasks: [selectedTask, remediation, currentThreadTask],
    threadResolutionStatus: {
      status: 'not-run', headSha: null, threads: [], updatedAt: null,
      threadlessVerification: {
        status: 'passed', headSha: currentHeadSha, taskIds: [ARCHIVE_REMEDIATION_ID], updatedAt: AT,
      },
      localVerification: proof('not-run').localVerification,
    },
  });
  const client = new FakeClient({ pageSize: 1, metadata: { headRefOid: currentHeadSha } });
  const archivedProofs = [];
  const events = [];
  for (const [index, threadId] of ['THREAD_ARCHIVE_A', 'THREAD_ARCHIVE_B'].entries()) {
    const root = rootComment(threadId, {
      databaseId: 510 + index,
      createdAt: '2026-08-04T23:58:00.000Z',
    });
    const replyOperationId = `reply:2:${threadId}:${historicalHeadSha}`;
    const resolveOperationId = `resolve:2:${threadId}:${historicalHeadSha}`;
    const reply = {
      id: `REPLY_ARCHIVE_${index}`, databaseId: 610 + index,
      url: `https://github.com/example/aerstello/pull/2#discussion_r${610 + index}`,
      body: `Aerstello review resolution at ${historicalHeadSha}.\nTasks:\n- ${ARCHIVED_TASK_ID}: already-fixed — Already fixed and independently verified.\nValidation: npm run test:pr-review.\n${markerFor(replyOperationId)}`,
      createdAt: ARCHIVE_REPLY_AT, lastEditedAt: null, author: VIEWER,
      replyTo: { id: root.id }, pullRequestReview: null,
    };
    addThread(client, { id: threadId, resolved: true, root, replies: [reply] });
    archivedProofs.push({
      threadNodeId: threadId,
      rootCommentNodeId: root.id,
      rootCommentDatabaseId: root.databaseId,
      taskIds: [ARCHIVED_TASK_ID], disposition: 'already-fixed',
      replyId: reply.id, replyUrl: reply.url, isResolved: true,
      resolvedAt: ARCHIVE_PROOF_RESOLVED_AT, resolvedBy: VIEWER.login,
      observedHeadSha: historicalHeadSha,
    });
    events.push(
      archiveIntentEvent('reply', replyOperationId, ARCHIVE_REPLY_INTENT_AT),
      archiveIntentEvent('resolve', resolveOperationId, ARCHIVE_RESOLVE_INTENT_AT),
    );
  }
  addThread(client, {
    id: 'THREAD_CURRENT', resolved: false,
    root: rootComment('THREAD_CURRENT', { databaseId: 520 }),
  });
  const abandonmentReason = 'Superseded by a fresh recovery cycle with exact retained evidence.';
  const archivedState = readyState({
    currentIntegrationHeadSha: historicalHeadSha,
    git: { branch: 'main', headSha: historicalHeadSha, dirty: false },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: historicalHeadSha,
      checks: ['npm run test:pr-review'], updatedAt: AT,
    },
    tasks: [archivedBatchTask('completed')],
    threadResolutionStatus: {
      status: 'passed', headSha: historicalHeadSha, threads: archivedProofs,
      threadlessVerification: proof('not-run').threadlessVerification,
      localVerification: proof('not-run').localVerification,
      updatedAt: AT,
    },
    abandonmentReason,
    updatedAt: ARCHIVE_STATE_AT,
  });
  events.push({
    schemaVersion: 1, type: 'abandoned',
    summary: `Archived without completion: ${abandonmentReason}`,
    at: ARCHIVE_EVENT_AT,
  });
  const archive = {
    archiveId: 'pr-2-2026-08-05T00-01-00-000Z',
    state: archivedState,
    events,
  };
  const journal = {
    async lookupIntent() { throw new Error('archive adoption must not read the active journal'); },
    async ensureIntent() { throw new Error('archive adoption must not write the active journal'); },
  };
  return { active, archive, client, journal };
}

function replayArchive(origin, {
  archiveId = 'pr-2-2026-08-05T00-02-00-000Z',
  stateAt = '2026-08-05T00:02:00.000Z',
  terminalAt = '2026-08-05T00:02:00.010Z',
  retainValidation = false,
} = {}) {
  const replay = structuredClone(origin);
  replay.archiveId = archiveId;
  replay.state.updatedAt = stateAt;
  if (!retainValidation) {
    replay.state.validationStatus = {
      ...replay.state.validationStatus,
      checks: ['npm run check:workflow'],
      updatedAt: stateAt,
    };
  }
  replay.events = replay.events.filter((event) => event.type !== 'github-mutation-intent');
  replay.events.at(-1).at = terminalAt;
  return replay;
}

function archiveBootstrapFixture(options = {}) {
  const fixture = archiveAdoptionFixture(options);
  const remediation = fixture.active.tasks.find((task) => task.id === ARCHIVE_REMEDIATION_ID);
  remediation.status = 'integrated';
  fixture.active.threadResolutionStatus = proof('not-run');
  return fixture;
}

function packetArchiveAdoptionFixture(archive, {
  bootstrap = false,
  unresolvedThreadIds = [],
} = {}) {
  const archivedState = archive.state;
  const archivedTask = archivedState.tasks.find(
    (task) => task.id === 'archived-pr35-five-thread-fixes-r1',
  );
  assert.ok(archivedTask);
  const selectedTask = { ...structuredClone(archivedTask), status: 'not-applicable' };
  const remediation = {
    id: 'packet-archive-adoption-remediation',
    sourceIds: ['orchestrator:packet-archive-adoption'],
    sourceType: 'github-threadless',
    fingerprint: 'fp-packet-archive-adoption-remediation',
    summary: 'Implement exact packet archive adoption.',
    severity: 'P1', disposition: 'actionable', status: bootstrap ? 'integrated' : 'completed',
    integratedCommitSha: HEAD, resolutionSummary: 'Implemented and verified.',
  };
  const unresolvedTask = {
    id: 'pr-review-worker-commit-delta-integrity-r1',
    sourceIds: unresolvedThreadIds.map((threadId) => `thread:${threadId}`),
    sourceType: 'github-thread',
    fingerprint: 'fp-pr-review-worker-commit-delta-integrity-r1',
    summary: 'Preserve exact worker-commit delta integrity.',
    severity: 'P1', disposition: 'actionable', status: 'integrated',
    integratedCommitSha: HEAD, resolutionSummary: 'Integrated and verified.',
  };
  const active = readyState({
    repository: archivedState.repository,
    prNumber: archivedState.prNumber,
    phase: 'verifying',
    tasks: [selectedTask, remediation, ...(unresolvedThreadIds.length > 0 ? [unresolvedTask] : [])],
    threadResolutionStatus: bootstrap ? proof('not-run') : {
      status: 'not-run', headSha: null, threads: [], updatedAt: null,
      threadlessVerification: {
        status: 'passed', headSha: HEAD, taskIds: [remediation.id], updatedAt: AT,
      },
      localVerification: proof('not-run').localVerification,
    },
  });
  const viewer = {
    ...VIEWER,
    login: archivedState.threadResolutionStatus.threads[0].resolvedBy,
    url: `https://github.com/${archivedState.threadResolutionStatus.threads[0].resolvedBy}`,
  };
  const client = new FakeClient({
    pageSize: 2,
    metadata: {
      number: archivedState.prNumber,
      url: `https://github.com/${archivedState.repository}/pull/${archivedState.prNumber}`,
      viewer,
    },
  });
  const proofs = archivedState.threadResolutionStatus.threads.filter(
    (item) => item.taskIds.includes(archivedTask.id),
  );
  const historicalHeads = new Set(proofs.map((item) => item.observedHeadSha));
  assert.equal(historicalHeads.size, 1);
  const historicalHeadSha = [...historicalHeads][0];
  for (const proofRow of proofs) {
    const replyOperationId = `reply:${archivedState.prNumber}:${proofRow.threadNodeId}:${historicalHeadSha}`;
    const resolveOperationId = `resolve:${archivedState.prNumber}:${proofRow.threadNodeId}:${historicalHeadSha}`;
    const replyIntent = archive.events.find(
      (event) => event.details?.operationId === replyOperationId,
    );
    const resolveIntent = archive.events.find(
      (event) => event.details?.operationId === resolveOperationId,
    );
    assert.ok(replyIntent);
    assert.ok(resolveIntent);
    const liveTimes = PACKET_ARCHIVE_LIVE_TIMES.get(proofRow.threadNodeId);
    assert.ok(liveTimes);
    const root = rootComment(proofRow.threadNodeId, {
      id: proofRow.rootCommentNodeId,
      databaseId: proofRow.rootCommentDatabaseId,
      url: `https://github.com/${archivedState.repository}/pull/${archivedState.prNumber}#discussion_r${proofRow.rootCommentDatabaseId}`,
      createdAt: liveTimes.rootCreatedAt,
    });
    const body = [
      `Aerstello review resolution at ${historicalHeadSha}.`,
      'Tasks:',
      `- ${archivedTask.id}: ${archivedTask.disposition} — ${archivedTask.resolutionSummary}`,
      `Validation: ${archivedState.validationStatus.checks.slice(0, 3).join(', ')}.`,
      markerFor(replyOperationId),
    ].join('\n');
    addThread(client, {
      id: proofRow.threadNodeId,
      resolved: true,
      root,
      replies: [{
        id: proofRow.replyId,
        databaseId: proofRow.rootCommentDatabaseId + 1,
        url: proofRow.replyUrl,
        body,
        createdAt: liveTimes.replyCreatedAt,
        lastEditedAt: null,
        author: viewer,
        replyTo: { id: proofRow.rootCommentNodeId },
        pullRequestReview: null,
      }],
    });
  }
  for (const [index, threadId] of unresolvedThreadIds.entries()) {
    addThread(client, {
      id: threadId,
      resolved: false,
      root: rootComment(threadId, {
        databaseId: 3_900_000_000 + index,
        url: `https://github.com/${archivedState.repository}/pull/${archivedState.prNumber}#discussion_r${3_900_000_000 + index}`,
      }),
    });
  }
  const journal = {
    async lookupIntent() { throw new Error('packet archive adoption must not read the active journal'); },
    async ensureIntent() { throw new Error('packet archive adoption must not write the active journal'); },
  };
  return { active, archivedTask, client, journal, proofs, remediation };
}

function decodedPacketArchive(archiveId, stateBase64, eventsBase64) {
  return {
    archiveId,
    state: JSON.parse(Buffer.from(stateBase64, 'base64').toString('utf8')),
    events: Buffer.from(eventsBase64, 'base64').toString('utf8').trim().split('\n').map(JSON.parse),
  };
}

function packetAggregateAdoptionFixture(oldArchive, mixedArchive) {
  const mixedProofs = mixedArchive.state.threadResolutionStatus.threads;
  const selectedThreadIds = mixedProofs.map((proofRow) => proofRow.threadNodeId).sort();
  const aggregateTask = {
    id: PACKET_AGGREGATE_TASK_ID,
    sourceIds: selectedThreadIds.map((threadId) => `thread:${threadId}`),
    sourceType: 'github-thread', fingerprint: 'fp-retained-pr35-nine-roots-r1',
    summary: 'Retain the exact nine historically resolved PR35 roots.',
    severity: 'P1', disposition: 'already-fixed', status: 'not-applicable',
    integratedCommitSha: null, resolutionSummary: 'Retained through composite archive authority.',
  };
  const remediation = {
    id: 'pr-review-multi-historical-archive-aggregate-adoption-r2',
    sourceIds: ['orchestrator:multi-historical-archive-aggregate-adoption'],
    sourceType: 'github-threadless', fingerprint: 'fp-multi-historical-archive-aggregate-adoption-r2',
    summary: 'Implement the multi-historical aggregate importer.', severity: 'P1', disposition: 'actionable',
    status: 'integrated', integratedCommitSha: PACKET_AGGREGATE_HEAD,
    resolutionSummary: 'Integrated and ready for exact verifier proof.',
  };
  const portabilityTask = {
    id: PACKET_PORTABILITY_TASK_ID,
    sourceIds: [`thread:${PACKET_PORTABILITY_THREAD_ID}`],
    sourceType: 'github-thread', fingerprint: 'fp-retained-pr35-portable-archive-reader-r1',
    summary: 'Resolve the current portability review root.', severity: 'P2', disposition: 'already-fixed',
    status: 'not-applicable', integratedCommitSha: null,
    resolutionSummary: 'Portable reader is already integrated and validated at current HEAD.',
  };
  const active = readyState({
    repository: mixedArchive.state.repository,
    prNumber: mixedArchive.state.prNumber,
    phase: 'verifying',
    currentIntegrationHeadSha: PACKET_AGGREGATE_HEAD,
    git: { branch: 'main', headSha: PACKET_AGGREGATE_HEAD, dirty: false },
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: PACKET_AGGREGATE_HEAD,
      checks: ['npm run test:pr-review'], updatedAt: '2026-08-20T12:00:00.000Z',
    },
    tasks: [aggregateTask, remediation, portabilityTask],
    threadResolutionStatus: proof('not-run'),
  });
  const viewer = { ...VIEWER, login: mixedProofs[0].resolvedBy, url: 'https://github.com/furinvader' };
  const client = new FakeClient({
    pageSize: 2,
    metadata: {
      number: mixedArchive.state.prNumber,
      headRefOid: PACKET_AGGREGATE_HEAD,
      url: `https://github.com/${mixedArchive.state.repository}/pull/${mixedArchive.state.prNumber}`,
      viewer,
    },
  });
  const oldRoots = new Set(oldArchive.state.threadResolutionStatus.threads.map((proof) => proof.threadNodeId));
  for (const proofRow of mixedProofs) {
    const origin = oldRoots.has(proofRow.threadNodeId) ? oldArchive : mixedArchive;
    const historicalTask = origin.state.tasks.find((task) => task.id === proofRow.taskIds[0]);
    assert.ok(historicalTask);
    const times = PACKET_ARCHIVE_LIVE_TIMES.get(proofRow.threadNodeId)
      ?? PACKET_MIXED_LIVE_TIMES.get(proofRow.threadNodeId);
    assert.ok(times);
    const root = rootComment(proofRow.threadNodeId, {
      id: proofRow.rootCommentNodeId,
      databaseId: proofRow.rootCommentDatabaseId,
      url: `https://github.com/${mixedArchive.state.repository}/pull/35#discussion_r${proofRow.rootCommentDatabaseId}`,
      createdAt: times.rootCreatedAt,
    });
    const replyOperationId = `reply:35:${proofRow.threadNodeId}:${proofRow.observedHeadSha}`;
    const body = [
      `Aerstello review resolution at ${proofRow.observedHeadSha}.`,
      'Tasks:',
      historicalTask.integratedCommitSha
        ? `- ${historicalTask.id}: ${historicalTask.integratedCommitSha}`
        : `- ${historicalTask.id}: ${historicalTask.disposition} — ${historicalTask.resolutionSummary}`,
      `Validation: ${origin.state.validationStatus.checks.slice(0, 3).join(', ')}.`,
      markerFor(replyOperationId),
    ].join('\n');
    addThread(client, {
      id: proofRow.threadNodeId, resolved: true, root,
      replies: [{
        id: proofRow.replyId,
        databaseId: proofRow.rootCommentDatabaseId + 1,
        url: proofRow.replyUrl,
        body,
        createdAt: times.replyCreatedAt,
        lastEditedAt: null,
        author: viewer,
        replyTo: { id: proofRow.rootCommentNodeId },
        pullRequestReview: null,
      }],
    });
  }
  addThread(client, {
    id: PACKET_PORTABILITY_THREAD_ID,
    resolved: false,
    root: rootComment(PACKET_PORTABILITY_THREAD_ID, {
      id: 'PRRC_kwDOTqOdrM7jsyHF', databaseId: 3_820_167_621,
      url: 'https://github.com/furinvader/aerstello/pull/35#discussion_r3820167621',
      createdAt: '2026-08-20T09:11:40.000Z',
    }),
  });
  return { active, aggregateTask, remediation, portabilityTask, client, selectedThreadIds };
}

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

export {
  assert,
  spawnSync,
  createHash,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  join,
  test,
  createRepository,
  git,
  writeFiles,
  createGitHubReviewWorkflow,
  GitHubWorkflowError,
  githubReviewConstants,
  readTopLevelComments,
  withGitHubRequestOwnerLock,
  buildGhGraphqlArgs,
  createDefaultArchiveStore,
  createDefaultGitAdapter,
  createDefaultGitHubClient,
  renderHumanStatus,
  terminateOnFatalArchiveCwd,
  HEAD,
  OTHER_HEAD,
  ADVANCED_HEAD,
  PRIOR_INTEGRATION_HEAD,
  SELECTED_TASK_HEAD,
  AT,
  GITHUB_CLI_MODULE_URL,
  BOT,
  VIEWER,
  darwinArchiveRuntime,
  trackedArchiveFileSystem,
  assertTrackedArchiveDescriptorsClosed,
  STRUCTURAL_COMMENT_BODY,
  ALTERNATE_STRUCTURAL_COMMENT_BODY,
  PACKET_MIXED_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_STATE_SHA256,
  PACKET_MIXED_ARCHIVE_EVENTS_SHA256,
  PACKET_MIXED_ARCHIVE_STATE_BASE64,
  PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  PACKET_ARCHIVE_NAME,
  PACKET_ARCHIVE_STATE_SHA256,
  PACKET_ARCHIVE_EVENTS_SHA256,
  PACKET_ARCHIVE_STATE_BASE64,
  PACKET_ARCHIVE_EVENTS_BASE64,
  withDuplicateReviewedCommitAnchor,
  proof,
  stateFixture,
  readyState,
  requestEvidence,
  pendingState,
  completedState,
  tasklessReviewHeadDriftState,
  cleanReviewEntry,
  tasklessPendingReviewHeadDriftState,
  tasklessPendingDiscoveryHeadDriftState,
  canonicalReview,
  cleanIssueComment,
  issueCommentCompletedState,
  findingsState,
  rootComment,
  connection,
  fullValidationCheck,
  passedCiEvidence,
  FakeClient,
  fakeGit,
  fakeJournal,
  racingRequestJournal,
  fakeState,
  workflow,
  addThread,
  markerFor,
  priorIntent,
  ARCHIVE_REPLY_INTENT_AT,
  ARCHIVE_REPLY_AT,
  ARCHIVE_RESOLVE_INTENT_AT,
  ARCHIVE_PROOF_RESOLVED_AT,
  ARCHIVE_STATE_AT,
  ARCHIVE_EVENT_AT,
  ARCHIVED_TASK_ID,
  ARCHIVE_REMEDIATION_ID,
  PACKET_ARCHIVE_LIVE_TIMES,
  PACKET_UNRESOLVED_THREAD_IDS,
  PACKET_AGGREGATE_HEAD,
  PACKET_AGGREGATE_TASK_ID,
  PACKET_PORTABILITY_TASK_ID,
  PACKET_PORTABILITY_THREAD_ID,
  PACKET_MIXED_LIVE_TIMES,
  archivedBatchTask,
  archiveIntentEvent,
  immutableArchiveStore,
  archiveAdoptionFixture,
  replayArchive,
  archiveBootstrapFixture,
  packetArchiveAdoptionFixture,
  decodedPacketArchive,
  packetAggregateAdoptionFixture,
  integratedThreadState,
  integratedNonThreadState,
  nonActionableNonThreadState,
  completedThreadlessDriftState,
};
