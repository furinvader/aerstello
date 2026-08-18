import { createHash } from 'node:crypto';

import {
  buildStaleDiscoveryDisposition,
  reviewRequestGate,
  reviewRequestUsage,
  validatePrReviewState,
} from '../contracts/contracts.mjs';

const CANONICAL_LOGIN = 'chatgpt-codex-connector';
const CANONICAL_URL = 'https://github.com/apps/chatgpt-codex-connector';
const REQUEST_BODY = '@codex review';
const REVIEWED_COMMIT_MARKER_LINE_PATTERN = /^\*\*Reviewed commit:\*\*.*$/gimu;
const REVIEWED_COMMIT_ANCHOR_PATTERN = /^\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`$/gmu;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 10_000;
const MIN_GRAPHQL_REMAINING = 10;
const FULL_VALIDATION_CHECK = 'Full validation';
const GITHUB_ACTIONS_APP = 'github-actions';
const FULL_VALIDATION_WORKFLOW = 'CI';
const FULL_VALIDATION_WORKFLOW_PATH = '.github/workflows/ci.yml';
const VERIFIED_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

const OPERATIONS = {
  PullRequestMetadata: `query PullRequestMetadata($owner:String!,$repo:String!,$pr:Int!){rateLimit{cost remaining} viewer{login id} repository(owner:$owner,name:$repo){pullRequest(number:$pr){id number url headRefOid state isDraft}}}`,
  PullRequestComments: `query PullRequestComments($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){comments(first:50,after:$cursor){nodes{id databaseId url body createdAt lastEditedAt author{__typename login url ... on Bot{id} ... on User{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestReviews: `query PullRequestReviews($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviews(first:50,after:$cursor){nodes{id databaseId url body state submittedAt commit{oid} author{__typename login url ... on Bot{id} ... on User{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestThreads: `query PullRequestThreads($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:50,after:$cursor){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestChecks: `query PullRequestChecks($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){id number state isDraft headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:50,after:$cursor){nodes{__typename ... on CheckRun{id databaseId name status conclusion completedAt detailsUrl checkSuite{workflowRun{databaseId url file{path} workflow{name}} app{slug}}} ... on StatusContext{id context state targetUrl}} pageInfo{hasNextPage endCursor}}}}}}}}}`,
  ReviewThreadComments: `query ReviewThreadComments($threadId:ID!,$cursor:String){rateLimit{cost remaining} node(id:$threadId){... on PullRequestReviewThread{comments(first:50,after:$cursor){nodes{id databaseId url body createdAt author{__typename login url ... on Bot{id} ... on User{id}} replyTo{id} pullRequestReview{id}} pageInfo{hasNextPage endCursor}}}}}`,
  RequestReactions: `query RequestReactions($commentId:ID!,$cursor:String){rateLimit{cost remaining} node(id:$commentId){... on IssueComment{reactions(first:50,after:$cursor){nodes{id content createdAt user{__typename login url id}} pageInfo{hasNextPage endCursor}}}}}`,
  AddReviewRequest: `mutation AddReviewRequest($subjectId:ID!,$body:String!,$clientMutationId:String!){addComment(input:{subjectId:$subjectId,body:$body,clientMutationId:$clientMutationId}){clientMutationId}}`,
  MarkPullRequestReadyForReview: `mutation MarkPullRequestReadyForReview($pullRequestId:ID!,$clientMutationId:String!){markPullRequestReadyForReview(input:{pullRequestId:$pullRequestId,clientMutationId:$clientMutationId}){clientMutationId}}`,
  AddThreadReply: `mutation AddThreadReply($threadId:ID!,$body:String!,$clientMutationId:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body,clientMutationId:$clientMutationId}){clientMutationId}}`,
  ResolveThread: `mutation ResolveThread($threadId:ID!,$clientMutationId:String!){resolveReviewThread(input:{threadId:$threadId,clientMutationId:$clientMutationId}){clientMutationId}}`,
};

export class GitHubWorkflowError extends Error {
  constructor(message, code = 'GITHUB_WORKFLOW_ERROR') {
    super(message);
    this.name = 'GitHubWorkflowError';
    this.code = code;
  }
}

function splitRepository(repository) {
  const [owner, repo, extra] = String(repository ?? '').split('/');
  if (!owner || !repo || extra) throw new GitHubWorkflowError('State repository must be owner/name', 'INVALID_REPOSITORY');
  return { owner, repo };
}

function isCanonicalActor(actor) {
  const matches = actor?.__typename === 'Bot'
    && actor?.login === CANONICAL_LOGIN && actor?.url === CANONICAL_URL;
  if (matches && !actor.id) {
    throw new GitHubWorkflowError('Canonical Bot actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  return matches;
}

function isViewerActor(actor, viewer) {
  const matches = actor?.login === viewer.login;
  if (matches && !actor.id) {
    throw new GitHubWorkflowError('Viewer actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  return matches && actor.id === viewer.id;
}

function assertGraphqlResult(result, operation) {
  if (!result || typeof result !== 'object' || (result.errors?.length ?? 0) > 0 || !result.data) {
    throw new GitHubWorkflowError(`${operation} returned GraphQL errors or no data`, 'GRAPHQL_READ_FAILED');
  }
  return result.data;
}

async function execute(client, name, variables) {
  const result = await client.graphql({ name, query: OPERATIONS[name], variables });
  const data = assertGraphqlResult(result, name);
  if (!name.startsWith('Add') && !['ResolveThread', 'MarkPullRequestReadyForReview'].includes(name)) {
    if (!Number.isFinite(data.rateLimit?.cost) || !Number.isFinite(data.rateLimit?.remaining)
        || data.rateLimit.remaining < MIN_GRAPHQL_REMAINING) {
      throw new GitHubWorkflowError(`${name} did not prove safe live rate-limit cost`, 'GRAPHQL_COST_UNSAFE');
    }
  }
  return data;
}

async function executeMutation(client, name, variables, payloadField) {
  const data = await execute(client, name, variables);
  if (data[payloadField]?.clientMutationId !== variables.clientMutationId) {
    throw new GitHubWorkflowError(`${name} lost clientMutationId correlation`, 'MUTATION_CORRELATION_FAILED');
  }
  return data[payloadField];
}

async function paginate(client, name, variables, selectConnection) {
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await execute(client, name, { ...variables, cursor });
    const connection = selectConnection(data);
    if (!connection || !Array.isArray(connection.nodes)
        || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new GitHubWorkflowError(`${name} returned a truncated connection`, 'GRAPHQL_TRUNCATED');
    }
    nodes.push(...connection.nodes);
    if (nodes.length > MAX_NODES) throw new GitHubWorkflowError(`${name} exceeded the node limit`, 'GRAPHQL_TRUNCATED');
    if (!connection.pageInfo.hasNextPage) return nodes;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      throw new GitHubWorkflowError(`${name} pagination cursor is missing or repeated`, 'GRAPHQL_TRUNCATED');
    }
    cursor = connection.pageInfo.endCursor;
  }
  throw new GitHubWorkflowError(`${name} exceeded the page limit`, 'GRAPHQL_TRUNCATED');
}

function prConnection(data, name) {
  const pr = data.repository?.pullRequest;
  if (!pr) throw new GitHubWorkflowError('Pull request was not found', 'PR_NOT_FOUND');
  return pr[name];
}

export async function readPullRequestMetadata(client, repository, prNumber) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  const data = await execute(client, 'PullRequestMetadata', variables);
  const pr = data.repository?.pullRequest;
  if (!pr || pr.number !== prNumber || !pr.id || !pr.headRefOid || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
      || typeof pr.isDraft !== 'boolean' || !data.viewer?.login || !data.viewer?.id) {
    throw new GitHubWorkflowError('Pull request metadata is incomplete', 'GRAPHQL_TRUNCATED');
  }
  return { ...pr, viewer: data.viewer };
}

export function readTopLevelComments(client, repository, prNumber) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  return paginate(client, 'PullRequestComments', variables, (data) => prConnection(data, 'comments'));
}

export function readReviews(client, repository, prNumber) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  return paginate(client, 'PullRequestReviews', variables, (data) => prConnection(data, 'reviews'));
}

export function readReviewThreads(client, repository, prNumber) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  return paginate(client, 'PullRequestThreads', variables, (data) => prConnection(data, 'reviewThreads'));
}

export function readThreadComments(client, threadId) {
  return paginate(client, 'ReviewThreadComments', { threadId }, (data) => data.node?.comments);
}

export function readRequestReactions(client, commentId) {
  return paginate(client, 'RequestReactions', { commentId }, (data) => data.node?.reactions);
}

export async function readPullRequestChecks(client, repository, prNumber, expectedHeadSha, { requireReady = true } = {}) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  const contexts = [];
  let cursor = null;
  let rollupState = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await execute(client, 'PullRequestChecks', { ...variables, cursor });
    const pr = data.repository?.pullRequest;
    const commits = pr?.commits?.nodes;
    if (pr?.number !== prNumber || !pr.id || typeof pr.state !== 'string' || typeof pr.isDraft !== 'boolean') {
      throw new GitHubWorkflowError('Check rollup pull request metadata was truncated', 'GRAPHQL_TRUNCATED');
    }
    if (pr.state !== 'OPEN') {
      throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
    }
    if (requireReady && pr.isDraft) {
      throw new GitHubWorkflowError('Pull request is still a draft', 'PR_DRAFT');
    }
    if (pr.headRefOid !== expectedHeadSha
        || !Array.isArray(commits) || commits.length !== 1
        || commits[0]?.commit?.oid !== expectedHeadSha) {
      throw new GitHubWorkflowError('Check rollup does not apply to the expected PR HEAD', 'CI_HEAD_MISMATCH');
    }
    const commit = commits[0].commit;
    if (!Object.hasOwn(commit, 'statusCheckRollup')) {
      throw new GitHubWorkflowError('Commit status check rollup was truncated', 'GRAPHQL_TRUNCATED');
    }
    const rollup = commit.statusCheckRollup;
    if (rollup === null) return { headSha: expectedHeadSha, rollupState: null, contexts: [] };
    const connection = rollup?.contexts;
    if (!rollup || typeof rollup.state !== 'string' || !connection || !Array.isArray(connection.nodes)
        || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new GitHubWorkflowError('Commit status check rollup is missing or truncated', 'GRAPHQL_TRUNCATED');
    }
    if (rollupState !== null && rollupState !== rollup.state) {
      throw new GitHubWorkflowError('Commit status check rollup changed during pagination', 'CI_EVIDENCE_AMBIGUOUS');
    }
    if (connection.nodes.some((node) => !node || !['CheckRun', 'StatusContext'].includes(node.__typename)
        || (node.__typename === 'CheckRun' && (typeof node.name !== 'string' || typeof node.status !== 'string'))
        || (node.__typename === 'StatusContext' && (typeof node.context !== 'string' || typeof node.state !== 'string')))) {
      throw new GitHubWorkflowError('Commit status context was truncated', 'GRAPHQL_TRUNCATED');
    }
    rollupState = rollup.state;
    contexts.push(...connection.nodes);
    if (contexts.length > MAX_NODES) {
      throw new GitHubWorkflowError('PullRequestChecks exceeded the node limit', 'GRAPHQL_TRUNCATED');
    }
    if (!connection.pageInfo.hasNextPage) {
      return { headSha: expectedHeadSha, rollupState, contexts };
    }
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
      throw new GitHubWorkflowError('PullRequestChecks pagination cursor is missing or repeated', 'GRAPHQL_TRUNCATED');
    }
    cursor = connection.pageInfo.endCursor;
  }
  throw new GitHubWorkflowError('PullRequestChecks exceeded the page limit', 'GRAPHQL_TRUNCATED');
}

function httpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function ciEvidenceFromRollup(snapshot) {
  const checkRuns = snapshot.contexts.filter((context) => context?.__typename === 'CheckRun');
  const candidates = checkRuns.filter((check) => check.name === FULL_VALIDATION_CHECK
    && check.checkSuite?.app?.slug === GITHUB_ACTIONS_APP);
  if (candidates.length === 0) {
    throw new GitHubWorkflowError('The authoritative Full validation GitHub Actions check is missing', 'CI_CHECK_MISSING');
  }
  const namedChecks = [...new Set(candidates.map((check) => check.name))].sort();
  const checkRunIds = new Set();
  const runs = new Map();
  for (const check of candidates) {
    const workflowRun = check.checkSuite?.workflowRun;
    if (typeof workflowRun?.workflow?.name !== 'string' || typeof workflowRun?.file?.path !== 'string') {
      throw new GitHubWorkflowError('Full validation lacks authoritative workflow identity', 'CI_EVIDENCE_INCOMPLETE');
    }
    if (workflowRun.workflow.name !== FULL_VALIDATION_WORKFLOW
        || workflowRun.file.path !== FULL_VALIDATION_WORKFLOW_PATH) {
      throw new GitHubWorkflowError('Full validation came from an unexpected workflow', 'CI_WORKFLOW_MISMATCH');
    }
    if (typeof check.id !== 'string' || check.id.length === 0
        || !Number.isInteger(workflowRun.databaseId) || workflowRun.databaseId < 1
        || !httpsUrl(workflowRun.url) || typeof check.status !== 'string' || check.status.length === 0) {
      throw new GitHubWorkflowError('Full validation lacks authoritative run identity', 'CI_EVIDENCE_INCOMPLETE');
    }
    if (checkRunIds.has(check.id)) {
      throw new GitHubWorkflowError('Full validation check-run identity is duplicated', 'CI_EVIDENCE_AMBIGUOUS');
    }
    checkRunIds.add(check.id);
    if (check.status === 'COMPLETED'
        && (!check.completedAt || !Number.isFinite(Date.parse(check.completedAt))
          || typeof check.conclusion !== 'string' || check.conclusion.length === 0)) {
      throw new GitHubWorkflowError('Completed Full validation lacks completion metadata', 'CI_EVIDENCE_INCOMPLETE');
    }
    const group = runs.get(workflowRun.databaseId) ?? { urls: new Set(), attempts: [] };
    group.urls.add(workflowRun.url);
    group.attempts.push(check);
    runs.set(workflowRun.databaseId, group);
  }
  if ([...runs.values()].some((run) => run.urls.size !== 1)) {
    throw new GitHubWorkflowError('Full validation workflow-run identity is ambiguous', 'CI_EVIDENCE_AMBIGUOUS');
  }
  if (candidates.some((check) => check.status !== 'COMPLETED')) {
    throw new GitHubWorkflowError('Full validation is still pending', 'CI_VALIDATION_PENDING');
  }
  const effective = [];
  for (const [runId, run] of runs) {
    const latestTime = Math.max(...run.attempts.map((check) => Date.parse(check.completedAt)));
    const latest = run.attempts.filter((check) => Date.parse(check.completedAt) === latestTime);
    if (latest.length !== 1) {
      throw new GitHubWorkflowError('Latest Full validation attempt is ambiguous', 'CI_EVIDENCE_AMBIGUOUS');
    }
    effective.push({ check: latest[0], runId });
  }
  const failed = effective.filter(({ check }) => check.conclusion !== 'SUCCESS');
  const representatives = failed.length > 0 ? failed : effective;
  representatives.sort((left, right) => Date.parse(right.check.completedAt) - Date.parse(left.check.completedAt)
    || right.runId - left.runId);
  const selected = representatives[0].check;
  const workflowRun = selected.checkSuite?.workflowRun;
  const passed = failed.length === 0;
  return {
    source: 'github-actions', scope: 'full', status: passed ? 'passed' : 'failed',
    headSha: snapshot.headSha, checks: namedChecks,
    checkRunId: selected.id, workflowRunId: workflowRun.databaseId, workflowRunUrl: workflowRun.url,
    updatedAt: selected.completedAt,
  };
}

function codexReviewStatus(state, liveHeadSha) {
  const request = state.reviewRequest;
  if (!request) return 'not-requested';
  const requestIsCurrent = request.headSha === state.currentIntegrationHeadSha
    && request.headSha === liveHeadSha;
  if (!requestIsCurrent) return 'stale';
  const outcome = state.reviewOutcome;
  if (!outcome) return 'awaiting';
  const outcomeIsCurrent = outcome.headSha === state.currentIntegrationHeadSha
    && outcome.headSha === liveHeadSha;
  return outcomeIsCurrent ? outcome.outcome : 'stale';
}

function sameCiEvidence(left, right) {
  return left.source === right.source && left.scope === right.scope
    && left.status === right.status && left.headSha === right.headSha
    && left.checkRunId === right.checkRunId
    && left.workflowRunId === right.workflowRunId && left.workflowRunUrl === right.workflowRunUrl
    && left.updatedAt === right.updatedAt
    && left.checks.length === right.checks.length
    && left.checks.every((check, index) => check === right.checks[index]);
}

function sameRequestBoundOutcome(state, outcome) {
  const latest = state.reviewHistory.at(-1);
  return JSON.stringify(state.reviewOutcome) === JSON.stringify(outcome)
    && latest?.request?.id === outcome.requestId
    && JSON.stringify(latest.outcome) === JSON.stringify(outcome);
}

function validateState(state, prNumber) {
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new GitHubWorkflowError(`Invalid active state: ${errors.join('; ')}`, 'INVALID_STATE');
  if (prNumber !== undefined && prNumber !== null && state.prNumber !== prNumber) {
    throw new GitHubWorkflowError('Explicit PR does not match active state', 'PR_MISMATCH');
  }
}

async function readLiveSnapshot(client, state, { reactionsFor = null } = {}) {
  const metadata = await readPullRequestMetadata(client, state.repository, state.prNumber);
  const [comments, reviews, rawThreads, reactions] = await Promise.all([
    readTopLevelComments(client, state.repository, state.prNumber),
    readReviews(client, state.repository, state.prNumber),
    readReviewThreads(client, state.repository, state.prNumber),
    reactionsFor ? readRequestReactions(client, reactionsFor) : Promise.resolve([]),
  ]);
  if (rawThreads.some((thread) => typeof thread?.id !== 'string' || thread.id.length === 0)
      || new Set(rawThreads.map((thread) => thread.id)).size !== rawThreads.length) {
    throw new GitHubWorkflowError('Review thread identity is missing or duplicated', 'ROOT_IDENTITY_AMBIGUOUS');
  }
  const threads = [];
  for (const thread of rawThreads) {
    const threadComments = await readThreadComments(client, thread.id);
    const roots = threadComments.filter((comment) => comment.replyTo === null);
    if (roots.length !== 1) {
      throw new GitHubWorkflowError(`Thread ${thread.id} does not have one explicit root`, 'ROOT_IDENTITY_AMBIGUOUS');
    }
    threads.push({ ...thread, comments: threadComments, root: roots[0], canonical: isCanonicalActor(roots[0].author) });
  }
  return { metadata, comments, reviews, threads, reactions };
}

async function assertMutationReady({ state, git }, live, { requireReady = true } = {}) {
  if (requireReady) assertPullRequestReady(live);
  const local = await git.snapshot(state.integrationWorktree);
  const pushedHeadSha = await git.pushedHead(state.integrationWorktree);
  const expected = state.currentIntegrationHeadSha;
  if (local.dirty) throw new GitHubWorkflowError('Integration checkout is dirty', 'MUTATION_NOT_READY');
  for (const [label, sha] of [
    ['local HEAD', local.headSha], ['pushed remote HEAD', pushedHeadSha], ['live PR HEAD', live.metadata.headRefOid],
  ]) if (sha !== expected) throw new GitHubWorkflowError(`${label} does not match state HEAD`, 'MUTATION_NOT_READY');
  const verifiedAncestors = new Set();
  for (const task of state.tasks) {
    if (task.disposition === 'actionable' && ['integrated', 'completed'].includes(task.status)) {
      if (!task.integratedCommitSha || !(await git.isAncestor(task.integratedCommitSha, expected, state.integrationWorktree))) {
        throw new GitHubWorkflowError(`Task ${task.id} integration is not an ancestor`, 'MUTATION_NOT_READY');
      }
      verifiedAncestors.add(`${task.integratedCommitSha}:${expected}`);
    }
  }
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    isAncestor: (ancestor, descendant) => verifiedAncestors.has(`${ancestor}:${descendant}`),
  };
}

function assertPullRequestReady(live) {
  if (live.metadata.state !== 'OPEN') {
    throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
  }
  if (live.metadata.isDraft) {
    throw new GitHubWorkflowError('Pull request is still a draft', 'PR_DRAFT');
  }
}

function operationToken(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function intentFor(type, operationId, at) {
  return { type, operationId, clientMutationId: `aerstello-${operationToken(operationId)}`, at };
}

function replyMarker(operationId) {
  return `<!-- aerstello-review:${operationToken(operationId)} -->`;
}

function replyTaskLine(task) {
  return task.integratedCommitSha
    ? `- ${task.id}: ${task.integratedCommitSha}`
    : `- ${task.id}: ${task.disposition} — ${task.resolutionSummary ?? 'Disposition recorded and verified.'}`;
}

function deterministicReply(state, entry, operationId) {
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

function parsedTime(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new GitHubWorkflowError(`${label} has an invalid timestamp`, 'INVALID_TIMESTAMP');
  return time;
}

function requestRecoveryAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request') - 1_000;
}

function evidenceAtOrAfter(candidate, anchor) {
  return parsedTime(candidate, 'Evidence') >= parsedTime(anchor, 'Request');
}

function sameTimestamp(left, right) {
  return parsedTime(left, 'Live evidence') === parsedTime(right, 'Recorded evidence');
}

function exactViewerRequestCandidates(comments, viewer, intent, excludedIds = new Set()) {
  return comments.filter((comment) => comment.body === REQUEST_BODY
    && comment.lastEditedAt === null
    && !excludedIds.has(comment.id)
    && isViewerActor(comment.author, viewer)
    && requestRecoveryAtOrAfter(comment.createdAt, intent.at));
}

async function journalIntent(journal, intent) {
  if (!journal?.ensureIntent) throw new GitHubWorkflowError('A durable intent journal is required', 'JOURNAL_REQUIRED');
  const persisted = await journal.ensureIntent(intent);
  if (!persisted || persisted.type !== intent.type || persisted.operationId !== intent.operationId
      || persisted.clientMutationId !== intent.clientMutationId || !persisted.at) {
    throw new GitHubWorkflowError('Mutation intent journal did not persist correlation', 'JOURNAL_FAILED');
  }
  parsedTime(persisted.at, 'Mutation intent');
  if (intent.type === 'request') {
    const ids = persisted.excludedCommentIds;
    if (!Array.isArray(ids) || ids.length > MAX_NODES
        || ids.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(ids).size !== ids.length) {
      throw new GitHubWorkflowError('Request intent has an invalid comment baseline', 'JOURNAL_FAILED');
    }
  }
  return persisted;
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

async function lookupOptionalMutationJournalIntent(journal, type, operationId) {
  if (!journal?.lookupIntent) throw new GitHubWorkflowError('A durable intent journal lookup is required', 'JOURNAL_REQUIRED');
  const candidate = await journal.lookupIntent(operationId);
  if (!candidate || candidate.operationId !== operationId) return null;
  return lookupMutationJournalIntent(journal, type, operationId);
}

async function lookupJournalIntent(journal, operationId) {
  return lookupMutationJournalIntent(journal, 'resolve', operationId);
}

async function lookupRequestJournalIntent(journal, operationId) {
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

function dispositionForTask(task) {
  return task.disposition === 'actionable' ? 'fixed' : task.disposition;
}

function taskIsEligibleForVerifyResolve(task) {
  const actionable = task.disposition === 'actionable'
    && ['integrated', 'completed'].includes(task.status)
    && Boolean(task.integratedCommitSha);
  const nonActionable = VERIFIED_NON_ACTIONABLE_DISPOSITIONS.has(task.disposition)
    && ['not-applicable', 'completed'].includes(task.status);
  return actionable || nonActionable;
}

function normalizeVerifyResolveTaskIds(taskSelection) {
  const taskIds = Array.isArray(taskSelection) ? [...taskSelection] : [];
  if (
    !Array.isArray(taskSelection)
    || taskIds.length === 0
    || taskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
    || new Set(taskIds).size !== taskIds.length
  ) {
    throw new GitHubWorkflowError(
      'verify-resolve requires an array of unique nonempty opaque task IDs',
      'TASK_NOT_READY',
    );
  }
  return taskIds.sort();
}

function sameTaskIds(left, right) {
  return left.length === right.length
    && left.every((taskId, index) => taskId === right[index]);
}

function verifyResolveResult(taskIds, active) {
  return {
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : { taskIds }),
    stateRevision: active.revision,
    threadResolutionStatus: active.threadResolutionStatus,
  };
}

function buildCanonicalRootPlan(state, live, selectedTaskId = null) {
  if (state.validationStatus.status !== 'passed'
      || state.validationStatus.headSha !== state.currentIntegrationHeadSha
      || state.validationStatus.checks.length === 0) {
    throw new GitHubWorkflowError('Current nonempty validation proof is required', 'TASK_NOT_READY');
  }
  const eligible = new Set(['integrated', 'completed', 'not-applicable']);
  const resolvableDispositions = new Set([
    'actionable', 'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
  ]);
  for (const task of state.tasks) {
    if (!eligible.has(task.status)) throw new GitHubWorkflowError(`Task ${task.id} is not integrated or completed`, 'TASK_NOT_READY');
    if (task.disposition === 'actionable'
        && (!['integrated', 'completed'].includes(task.status) || !task.integratedCommitSha)) {
      throw new GitHubWorkflowError(`Actionable task ${task.id} lacks integration proof`, 'TASK_NOT_READY');
    }
    if (task.sourceType === 'github-thread' && !resolvableDispositions.has(task.disposition)) {
      throw new GitHubWorkflowError(`Task ${task.id} disposition cannot resolve a thread`, 'TASK_NOT_READY');
    }
  }
  const selected = selectedTaskId === null ? null : state.tasks.find((task) => task.id === selectedTaskId);
  if (selectedTaskId !== null && !selected) throw new GitHubWorkflowError('Task was not found', 'TASK_NOT_FOUND');
  const tasks = state.tasks.filter((task) => task.sourceType === 'github-thread');
  const mapped = new Map();
  for (const task of tasks) {
    const expectedSources = task.sourceIds.filter((source) => /^(?:thread|discussion):/u.test(source));
    if (expectedSources.length === 0) throw new GitHubWorkflowError(`Task ${task.id} has no canonical root source`, 'ROOT_IDENTITY_MISMATCH');
    for (const source of expectedSources) {
      const matches = live.threads.filter((thread) => thread.canonical
        && (source === `thread:${thread.id}` || source === `discussion:${thread.root.databaseId}`));
      if (matches.length !== 1) throw new GitHubWorkflowError(`Source ${source} is missing or ambiguous`, 'ROOT_IDENTITY_MISMATCH');
      const thread = matches[0];
      const entry = mapped.get(thread.id) ?? { thread, tasks: [] };
      if (!entry.tasks.some((item) => item.id === task.id)) entry.tasks.push(task);
      mapped.set(thread.id, entry);
    }
  }
  for (const entry of mapped.values()) {
    entry.tasks.sort((left, right) => left.id.localeCompare(right.id));
    const dispositions = new Set(entry.tasks.map(dispositionForTask));
    if (dispositions.size !== 1) throw new GitHubWorkflowError('Shared root has conflicting dispositions', 'ROOT_IDENTITY_MISMATCH');
  }
  const unexpected = live.threads.filter((thread) => thread.canonical && !mapped.has(thread.id));
  if (unexpected.length > 0) throw new GitHubWorkflowError('Canonical thread has no task/source mapping', 'ROOT_IDENTITY_MISMATCH');
  const plan = [...mapped.values()].sort((left, right) => left.thread.id.localeCompare(right.thread.id));
  if (selected?.sourceType === 'github-thread' && !plan.some((entry) => entry.tasks.some((task) => task.id === selected.id))) {
    throw new GitHubWorkflowError('Selected task has no canonical root', 'ROOT_IDENTITY_MISMATCH');
  }
  if (selected && !['github-thread', 'github-threadless'].includes(selected.sourceType)) {
    throw new GitHubWorkflowError('Task is not GitHub-backed', 'TASK_NOT_FOUND');
  }
  return { plan, selected, selectedPlan: selected ? plan.filter((entry) => entry.tasks.some((task) => task.id === selected.id)) : plan };
}

function exactRepliesFor(state, live, entry) {
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

function completedThreadlessRecoveryReady(state) {
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

function priorHeadRecoveryCandidate(state, live, entry, selectedTask) {
  if (!completedThreadlessRecoveryReady(state) || !entry.thread.isResolved
      || selectedTask?.sourceType !== 'github-thread'
      || !entry.tasks.some((task) => task.id === selectedTask.id)
      || !selectedTask.integratedCommitSha) return null;

  const directReplies = entry.thread.comments.filter((comment) => comment.replyTo?.id === entry.thread.root.id);
  const markerPattern = /<!-- aerstello-review:[0-9a-f]{24} -->/u;
  const markedReplies = directReplies.filter((comment) => markerPattern.test(comment.body ?? ''));
  const priorCandidates = markedReplies.map((reply) => ({
    reply,
    priorHeadSha: /^Aerstello review resolution at ([0-9a-f]{40})\.\n/u.exec(reply.body ?? '')?.[1] ?? null,
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

function assertPriorHeadRecoveryLive(state, live, entry, recovery) {
  const selectedTask = state.tasks.find((task) => task.id === recovery.selectedTaskId);
  const candidate = priorHeadRecoveryCandidate(state, live, entry, selectedTask);
  if (!candidate || candidate.priorHeadSha !== recovery.priorHeadSha
      || candidate.reply.id !== recovery.reply.id || candidate.reply.url !== recovery.reply.url
      || candidate.reply.body !== recovery.reply.body || candidate.reply.createdAt !== recovery.reply.createdAt) {
    throw new GitHubWorkflowError('Prior-head recovery evidence changed after preflight', 'THREAD_PROOF_STALE');
  }
  return candidate.reply;
}

async function journaledPriorHeadRecovery(state, live, entry, selectedTask, journal, git) {
  const candidate = priorHeadRecoveryCandidate(state, live, entry, selectedTask);
  if (!candidate) return null;
  if (!(await git.isAncestor(
    candidate.priorHeadSha, state.currentIntegrationHeadSha, state.integrationWorktree,
  ))) {
    throw new GitHubWorkflowError('Prior-head recovery commit is not an integration ancestor', 'MUTATION_NOT_READY');
  }
  const replyIntent = await lookupMutationJournalIntent(journal, 'reply', candidate.replyOperationId);
  const resolveIntent = await lookupMutationJournalIntent(journal, 'resolve', candidate.resolveOperationId);
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

function assertRecordedReply(state, live, entry, proof) {
  const replies = entry.thread.comments.filter((comment) => comment.id === proof.replyId);
  if (replies.length !== 1) throw new GitHubWorkflowError('Historical reply ID is not uniquely live', 'THREAD_PROOF_STALE');
  const reply = replies[0];
  const header = /^Aerstello review resolution at ([0-9a-f]{40})\.\n/u.exec(reply.body ?? '');
  const replyHeadSha = header?.[1] ?? null;
  const operationId = replyHeadSha ? `reply:${state.prNumber}:${entry.thread.id}:${replyHeadSha}` : null;
  const markers = [...String(reply.body ?? '').matchAll(/<!-- aerstello-review:[0-9a-f]{24} -->/gu)].map((match) => match[0]);
  const authorMatches = proof.isResolved
    ? reply.author?.login === proof.resolvedBy
    : isViewerActor(reply.author, live.metadata.viewer);
  if (proof.isResolved && authorMatches && !reply.author?.id) {
    throw new GitHubWorkflowError('Recorded reply actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  if (reply.url !== proof.replyUrl || reply.replyTo?.id !== entry.thread.root.id
      || !authorMatches || !replyHeadSha || markers.length !== 1
      || (!proof.isResolved && replyHeadSha !== state.currentIntegrationHeadSha)
      || markers[0] !== replyMarker(operationId)) {
    throw new GitHubWorkflowError('Historical reply identity or immutable anchor is stale', 'THREAD_PROOF_STALE');
  }
  for (const task of entry.tasks) {
    const stableLine = task.integratedCommitSha
      ? `- ${task.id}: ${task.integratedCommitSha}` : `- ${task.id}: ${task.disposition} —`;
    if (!reply.body.includes(stableLine)) {
      throw new GitHubWorkflowError(`Historical reply lost stable task evidence for ${task.id}`, 'THREAD_PROOF_STALE');
    }
  }
  return reply;
}

function assertExistingThreadProof(state, live, entry, proof) {
  const taskIds = entry.tasks.map((task) => task.id).sort();
  const proofTaskIds = proof.taskIds.slice().sort();
  if (proof.rootCommentNodeId !== entry.thread.root.id
      || proof.rootCommentDatabaseId !== entry.thread.root.databaseId
      || taskIds.length !== proofTaskIds.length
      || taskIds.some((taskId, index) => taskId !== proofTaskIds[index])
      || proof.disposition !== dispositionForTask(entry.tasks[0])
      || (proof.isResolved && !entry.thread.isResolved)
      || ((proof.replyId === null) !== (proof.replyUrl === null))) {
    throw new GitHubWorkflowError(`Thread ${entry.thread.id} immutable proof does not match the live plan`, 'THREAD_PROOF_STALE');
  }
  return proof.replyId === null ? null : assertRecordedReply(state, live, entry, proof);
}

function assertLiveThreadProof(state, live) {
  const { plan } = buildCanonicalRootPlan(state, live);
  const canonical = live.threads.filter((thread) => thread.canonical);
  const recorded = new Map(state.threadResolutionStatus.threads.map((thread) => [thread.threadNodeId, thread]));
  if (canonical.length !== recorded.size) {
    throw new GitHubWorkflowError('Live canonical threads do not match durable thread proof', 'THREAD_PROOF_STALE');
  }
  for (const entry of plan) {
    const thread = entry.thread;
    const proof = recorded.get(thread.id);
    if (!proof || proof.isResolved !== thread.isResolved) {
      throw new GitHubWorkflowError(`Thread ${thread.id} identity or resolution differs from durable proof`, 'THREAD_PROOF_STALE');
    }
    assertExistingThreadProof(state, live, entry, proof);
  }
}

function assertRecordedThreadsLive(state, live) {
  const { plan } = buildCanonicalRootPlan(state, live);
  const liveByThread = new Map(plan.map((entry) => [entry.thread.id, entry]));
  for (const proof of state.threadResolutionStatus.threads) {
    const entry = liveByThread.get(proof.threadNodeId);
    if (!entry || proof.isResolved !== entry.thread.isResolved) {
      throw new GitHubWorkflowError(
        `Recorded thread ${proof.threadNodeId} identity or resolution differs from live evidence`,
        'THREAD_PROOF_STALE',
      );
    }
    assertExistingThreadProof(state, live, entry, proof);
  }
}

function buildThreadProof(state, live, resolvedEvidence, at) {
  const { plan: mapped } = buildCanonicalRootPlan(state, live);
  const previous = new Map(state.threadResolutionStatus.threads.map((thread) => [thread.threadNodeId, thread]));
  const threads = mapped.map(({ thread, tasks }) => {
    const old = previous.get(thread.id);
    const fresh = resolvedEvidence.get(thread.id);
    const entry = { thread, tasks };
    const recordedReply = old ? assertExistingThreadProof(state, live, entry, old) : null;
    if (old?.isResolved) {
      return { ...old };
    }
    const exact = recordedReply ? [recordedReply]
      : fresh?.priorHeadRecovery
        ? [assertPriorHeadRecoveryLive(state, live, entry, fresh.priorHeadRecovery)]
        : exactRepliesFor(state, live, entry).exact;
    const reply = recordedReply ?? fresh?.reply ?? exact[0] ?? null;
    if (thread.isResolved && (!fresh || exact.length !== 1)) {
      throw new GitHubWorkflowError(`Thread ${thread.id} exact reply is not live`, 'THREAD_PROOF_STALE');
    }
    if (thread.isResolved && !old && !fresh) {
      throw new GitHubWorkflowError(`Resolved thread ${thread.id} lacks durable resolution evidence`, 'RESOLUTION_PROOF_MISSING');
    }
    const updated = {
      threadNodeId: thread.id,
      rootCommentNodeId: thread.root.id,
      rootCommentDatabaseId: thread.root.databaseId,
      taskIds: tasks.map((task) => task.id).sort(),
      disposition: dispositionForTask(tasks[0]),
      replyId: old?.replyId ?? reply?.id ?? null,
      replyUrl: old?.replyUrl ?? reply?.url ?? null,
      isResolved: thread.isResolved,
      resolvedAt: thread.isResolved ? old?.resolvedAt ?? fresh?.resolvedAt ?? null : null,
      resolvedBy: thread.isResolved ? old?.resolvedBy ?? fresh?.resolvedBy ?? null : null,
      observedHeadSha: old?.observedHeadSha ?? state.currentIntegrationHeadSha,
    };
    return old ? {
      ...old,
      replyId: old.replyId ?? updated.replyId,
      replyUrl: old.replyUrl ?? updated.replyUrl,
      isResolved: updated.isResolved,
      resolvedAt: updated.resolvedAt,
      resolvedBy: updated.resolvedBy,
    } : updated;
  });
  return {
    status: threads.every((thread) => thread.isResolved) ? 'passed' : 'failed',
    headSha: state.currentIntegrationHeadSha,
    threads,
    threadlessVerification: state.threadResolutionStatus.threadlessVerification,
    ...(Object.hasOwn(state.threadResolutionStatus, 'localVerification') ? {
      localVerification: state.threadResolutionStatus.localVerification,
    } : {}),
    updatedAt: at,
  };
}

function canonicalEvidenceId(item, prefix) {
  return `${prefix}:${item.id}`;
}

function classifyReviewSubmission(review, threads) {
  if (typeof review.body !== 'string') return 'unsupported';
  const hasAttachedCanonicalRoot = threads.some((thread) => thread.canonical
    && thread.root.pullRequestReview?.id === review.id);
  return review.body.trim().length > 0 || hasAttachedCanonicalRoot ? 'findings' : 'clean';
}

async function classifyStructuralIssueComments({ comments, request, threads, git, cwd, expectedHeads }) {
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

function assertRecordedRequestComment(state, live) {
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

function requestAnchorObservation(live, requestId) {
  const comment = live.comments.find((item) => item.id === requestId) ?? null;
  return comment === null ? null : {
    id: comment.id, body: comment.body, url: comment.url, databaseId: comment.databaseId ?? null,
    createdAt: comment.createdAt, lastEditedAt: comment.lastEditedAt,
    author: actorObservation(comment.author),
  };
}

function escalationFor(state, liveHead, evidenceIds, reason, at) {
  const same = liveHead === state.reviewRequest.headSha;
  return {
    requestId: state.reviewRequest.id,
    requestHeadSha: state.reviewRequest.headSha,
    observedPrHeadSha: liveHead,
    headRelation: same ? 'same' : 'changed',
    evidenceIds: [...new Set(evidenceIds)].slice(0, 8),
    reason: !same && reason !== 'request-head-drift' ? 'request-head-drift' : reason,
    at,
  };
}

function sameEscalationIntent(left, right) {
  return left?.requestId === right.requestId
    && left.requestHeadSha === right.requestHeadSha
    && left.observedPrHeadSha === right.observedPrHeadSha
    && left.headRelation === right.headRelation
    && left.reason === right.reason
    && JSON.stringify(left.evidenceIds) === JSON.stringify(right.evidenceIds);
}

function tasklessReviewHeadDriftRefreshAllowed(state) {
  const request = state.reviewRequest;
  const outcome = state.reviewOutcome;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const reviewAllowanceRemains = !reviewRequestUsage(state).exhausted;
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && state.phase === 'recovering'
    && state.tasks.length === 0
    && request !== null
    && outcome?.outcome === 'clean' && latest !== undefined
    && JSON.stringify(latest.request) === JSON.stringify(request)
    && JSON.stringify(latest.outcome) === JSON.stringify(outcome)
    && outcome.requestId === request.id && outcome.kind === request.kind
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === priorHeadSha
    && outcome.headSha === priorHeadSha
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && reviewAllowanceRemains;
}

function tasklessPendingReviewHeadDriftRefreshAllowed(state) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  const priorHeadSha = request?.headSha;
  const disposition = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === request?.id) ?? null;
  const recoveryPhase = ['recovering', 'ready-for-review'].includes(state.phase)
    || (state.phase === 'triaging' && disposition?.evidence?.outcome === 'findings');
  return state.schemaVersion === 3
    && state.legacyReviewProvenance === null
    && recoveryPhase
    && state.tasks.length === 0
    && request !== null && latest !== undefined
    && state.reviewOutcome === null && latest.outcome === null
    && JSON.stringify(latest.request) === JSON.stringify(request)
    && state.requestedHeadSha === priorHeadSha && state.reviewedHeadSha === null
    && priorHeadSha !== state.currentIntegrationHeadSha
    && state.git.headSha === state.currentIntegrationHeadSha && state.git.dirty === false
    && state.validationStatus.status === 'passed'
    && state.validationStatus.headSha === state.currentIntegrationHeadSha
    && state.blockedReasons.length === 0 && state.verificationEscalation === null
    && !state.tasks.some((task) => task.disposition === 'needs-human-decision')
    && (disposition === null
      || (disposition.requestHeadSha === priorHeadSha
        && disposition.liveHeadSha === state.currentIntegrationHeadSha));
}

function outcomeFromCanonicalResponse(request, selected, threads) {
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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function actorObservation(actor) {
  return {
    type: actor?.__typename ?? null,
    login: actor?.login ?? null,
    id: actor?.id ?? null,
    url: actor?.url ?? null,
  };
}

function canonicalRootEvidence(live, reviewId = undefined) {
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

function canonicalRootState(live) {
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

function responseObservation(candidate) {
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

function responseFingerprint(candidate, live) {
  const observation = {
    response: responseObservation(candidate),
    roots: candidate.type === 'review'
      ? canonicalRootEvidence(live, candidate.value.id) : [],
  };
  return createHash('sha256').update(JSON.stringify(canonicalJson(observation))).digest('hex');
}

async function classifyPendingReviewResponse(state, live, git, { includeUnmatchedRoots = false } = {}) {
  const request = state.reviewRequest;
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
    cwd: state.integrationWorktree,
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

function dispositionForPendingResponse(state, response, disposedAt) {
  const existing = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === state.reviewRequest.id) ?? null;
  if (response.status !== 'supported') {
    if (existing !== null) {
      throw new GitHubWorkflowError(
        'Dispositioned stale discovery evidence is missing or no longer uniquely classifiable',
        'STALE_DISCOVERY_EVIDENCE_CHANGED',
      );
    }
    return null;
  }
  const disposition = buildStaleDiscoveryDisposition({
    request: state.reviewRequest,
    liveHeadSha: state.currentIntegrationHeadSha,
    evidence: response.evidence,
    responseFingerprint: response.responseFingerprint,
    disposedAt: existing?.disposedAt ?? disposedAt,
  });
  if (existing !== null && JSON.stringify(existing) !== JSON.stringify(disposition)) {
    throw new GitHubWorkflowError(
      'Live stale discovery evidence differs from its immutable disposition',
      'STALE_DISCOVERY_EVIDENCE_CHANGED',
    );
  }
  return disposition;
}

function samePendingResponseObservation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function reviewObservation(state, live, git) {
  if (!state.reviewRequest || state.reviewOutcome) {
    return { status: 'not-applicable', outcome: null, evidenceType: null, evidenceIds: [] };
  }
  if (live.metadata.headRefOid !== state.reviewRequest.headSha
      || state.reviewRequest.headSha !== state.currentIntegrationHeadSha
      || live.metadata.headRefOid !== state.currentIntegrationHeadSha) {
    return { status: 'stale', outcome: null, evidenceType: null, evidenceIds: [] };
  }
  try {
    assertRecordedRequestComment(state, live);
    const response = await classifyPendingReviewResponse(state, live, git);
    if (response.status === 'none') return { status: 'waiting', outcome: null, evidenceType: null, evidenceIds: [] };
    if (response.status === 'ambiguous') {
      return { status: 'ambiguous', outcome: null, evidenceType: null, evidenceIds: response.evidenceIds };
    }
    if (response.status === 'stale') {
      return { status: 'stale', outcome: null, evidenceType: null, evidenceIds: response.evidenceIds };
    }
    return {
      status: 'collectable', outcome: response.evidence.outcome,
      evidenceType: response.evidence.evidenceType, evidenceIds: response.evidenceIds,
    };
  } catch {
    const matching = live.comments.filter((comment) => comment.id === state.reviewRequest.id)
      .map((comment) => `live-request:${comment.id}`);
    return {
      status: 'ambiguous', outcome: null, evidenceType: null,
      evidenceIds: [...new Set([`request-proof:${state.reviewRequest.id}`, ...matching])],
    };
  }
}

async function staleDiscoveryStatus(state, live, git) {
  const request = state.reviewRequest;
  const latest = state.reviewHistory.at(-1);
  if (request?.kind !== 'discovery' || state.reviewOutcome !== null || latest?.outcome !== null
      || latest?.request?.id !== request.id || request.headSha === live.metadata.headRefOid) {
    return { category: 'not-applicable', dispositionId: null, canonicalRootCount: 0 };
  }
  if (live.metadata.headRefOid !== state.currentIntegrationHeadSha) {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  const existing = (state.staleDiscoveryDispositions ?? [])
    .find((entry) => entry.requestId === request.id) ?? null;
  if (existing === null && !tasklessPendingReviewHeadDriftRefreshAllowed(state)) {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  try {
    assertRecordedRequestComment(state, live);
    if (existing === null) await assertMutationReady({ state, git }, live);
  } catch {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  let response;
  try {
    response = await classifyPendingReviewResponse(state, live, git, { includeUnmatchedRoots: true });
  } catch {
    return { category: 'ambiguous-human-decision', dispositionId: null, canonicalRootCount: 0 };
  }
  if (existing !== null) {
    if (response.status !== 'supported'
        || JSON.stringify(existing.evidence) !== JSON.stringify(response.evidence)
        || existing.responseFingerprint !== response.responseFingerprint
        || (existing.evidence.outcome === 'clean'
          && existing.liveHeadSha !== live.metadata.headRefOid)) {
      return {
        category: 'ambiguous-human-decision', dispositionId: existing.dispositionId,
        canonicalRootCount: response.rootState.length,
      };
    }
    return {
      category: response.evidence.outcome === 'findings'
        ? 'actionable-stale-findings' : 'dispositioned',
      dispositionId: existing.dispositionId,
      canonicalRootCount: response.rootState.length,
    };
  }
  if (response.status === 'none') {
    return { category: 'pure-head-drift', dispositionId: null, canonicalRootCount: 0 };
  }
  if (response.status === 'ambiguous' || response.status === 'stale') {
    return {
      category: 'ambiguous-human-decision', dispositionId: null,
      canonicalRootCount: response.rootState.length,
    };
  }
  return {
    category: response.evidence.outcome === 'findings'
      ? 'actionable-stale-findings' : 'disposition-ready',
    dispositionId: null,
    canonicalRootCount: response.rootState.length,
  };
}

function staleDiscoveryNextAction(status, fallback) {
  if (status.category === 'disposition-ready') {
    return 'Run refresh-threads to disposition the unique stale discovery response and prove the current empty root set.';
  }
  if (status.category === 'actionable-stale-findings' && status.dispositionId === null) {
    return 'Run refresh-threads to disposition the unique stale discovery response, then triage its actionable findings.';
  }
  if (status.category === 'ambiguous-human-decision') {
    return 'Present the ambiguous stale discovery evidence and exact request/head identities to a human.';
  }
  return fallback;
}

export function createGitHubReviewWorkflow({ client, state: stateAdapter, git, clock, journal }) {
  if (!client?.graphql || !stateAdapter?.load || !git || !clock?.now) {
    throw new GitHubWorkflowError('Client, state, Git, and clock adapters are required', 'INVALID_ADAPTERS');
  }

  async function load(prNumber) {
    const active = await stateAdapter.load(prNumber);
    if (!active) throw new GitHubWorkflowError('No active PR state', 'STATE_NOT_FOUND');
    validateState(active, prNumber);
    return active;
  }

  async function assertCurrent(expected) {
    const current = await load(expected.prNumber);
    if (current.revision !== expected.revision) {
      throw new GitHubWorkflowError('Active state changed after preflight', 'STATE_REVISION_CHANGED');
    }
  }

  async function checkpointPendingRecoveryEscalation(active, live, evidenceIds, reason) {
    if (!stateAdapter.checkpointVerificationEscalation) {
      throw new GitHubWorkflowError('The verification escalation checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    await assertMutationReady({ state: active, git }, live);
    await assertCurrent(active);
    const escalation = escalationFor(
      active,
      live.metadata.headRefOid,
      evidenceIds.length > 0 ? evidenceIds : [`request:${active.reviewRequest.id}`],
      reason,
      clock.now(),
    );
    try {
      const escalated = await stateAdapter.checkpointVerificationEscalation({
        prNumber: active.prNumber,
        expectedRevision: active.revision,
        escalation,
      });
      return {
        escalated: true, escalation: escalated.verificationEscalation,
        performed: escalated.revision !== active.revision,
      };
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      const current = await load(active.prNumber);
      if (!sameEscalationIntent(current.verificationEscalation, escalation)) throw error;
      return { escalated: true, escalation: current.verificationEscalation, performed: false };
    }
  }

  async function status(prNumber) {
    const active = await load(prNumber);
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    if (live.metadata.state !== 'OPEN') {
      throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
    }
    const ciSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid, { requireReady: false },
    );
    let liveCi;
    try {
      liveCi = ciEvidenceFromRollup(ciSnapshot);
    } catch (error) {
      if (!(error instanceof GitHubWorkflowError)
          || !['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code)) throw error;
      liveCi = { status: error.code === 'CI_CHECK_MISSING' ? 'missing' : 'pending', message: error.message };
    }
    const openThreads = live.threads.filter((thread) => thread.canonical && !thread.isResolved).length;
    const requestUsage = reviewRequestUsage(active);
    const staleDiscoveryEvidence = await staleDiscoveryStatus(active, live, git);
    const observation = await reviewObservation(active, live, git);
    const specialistReviews = stateAdapter.specialistStatus
      ? await stateAdapter.specialistStatus(active.prNumber)
      : {
          status: 'missing', headSha: active.currentIntegrationHeadSha,
          stateRevision: active.revision, requiredReviewerIds: [], recordedReviewerIds: [],
        };
    return {
      prNumber: active.prNumber,
      statePhase: active.phase,
      stateHeadSha: active.currentIntegrationHeadSha,
      liveHeadSha: live.metadata.headRefOid,
      pullRequest: { state: live.metadata.state, isDraft: live.metadata.isDraft },
      reviewObservation: observation,
      canonicalThreads: live.threads.filter((thread) => thread.canonical).map((thread) => ({
        threadNodeId: thread.id,
        rootCommentNodeId: thread.root.id,
        rootCommentDatabaseId: thread.root.databaseId,
        isResolved: thread.isResolved,
      })),
      reviewCount: live.reviews.length,
      reviewRequests: { used: requestUsage.used, limit: requestUsage.limit },
      requestReactionCount: live.reactions.length,
      staleDiscoveryEvidence,
      codexReview: codexReviewStatus(active, live.metadata.headRefOid),
      taskStatus: {
        resolved: active.tasks.filter((task) => task.status === 'completed').length,
        pending: active.tasks.filter((task) => task.status !== 'completed').length,
        display: active.phase === 'complete' ? 'Done' : 'Resolved',
        items: active.tasks.map((task) => ({
          id: task.id,
          summary: task.summary,
          status: active.phase === 'complete' ? 'Done'
            : task.status === 'completed' ? 'Resolved'
              : task.status === 'integrated' ? 'Integrated'
                : task.status === 'running' ? 'worker running' : task.status,
        })),
      },
      targetedValidation: active.validationStatus,
      specialistReviews,
      recordedCiValidation: active.ciValidationStatus,
      liveCiValidation: liveCi,
      openCodexThreads: openThreads,
      nextAction: staleDiscoveryNextAction(staleDiscoveryEvidence,
        active.phase === 'ready-for-review' && requestUsage.exhausted
        ? `Review request limit ${requestUsage.limit} is exhausted after ${requestUsage.used} durable requests; run npm run review:state -- set-review-limit --pr ${active.prNumber} --expected-revision ${active.revision} --limit <higher-number> or --unlimited before the next request.`
        : active.nextAction),
    };
  }

  async function collectCi(prNumber) {
    let active = await load(prNumber);
    const priorRevision = active.revision;
    const metadata = await readPullRequestMetadata(client, active.repository, active.prNumber);
    assertPullRequestReady({ metadata });
    if (metadata.headRefOid !== active.currentIntegrationHeadSha) {
      throw new GitHubWorkflowError('Live PR HEAD does not match the integration HEAD', 'CI_HEAD_MISMATCH');
    }
    const snapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, active.currentIntegrationHeadSha,
    );
    const evidence = ciEvidenceFromRollup(snapshot);
    if (!stateAdapter.checkpointCiValidation) {
      throw new GitHubWorkflowError('The CI validation state checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    try {
      active = await stateAdapter.checkpointCiValidation({
        prNumber: active.prNumber, expectedRevision: active.revision, evidence,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (!sameCiEvidence(active.ciValidationStatus, evidence)) throw error;
      return { evidence: active.ciValidationStatus, phase: active.phase, revision: active.revision, performed: false };
    }
    return { evidence: active.ciValidationStatus, phase: active.phase, revision: active.revision,
      performed: active.revision !== priorRevision };
  }

  async function refreshThreads(prNumber) {
    let active = await load(prNumber);
    const pristine = active.phase === 'recovering'
      && active.tasks.length === 0
      && active.reviewRound === 0
      && active.requestedHeadSha === null
      && active.reviewedHeadSha === null
      && active.reviewRequest === null
      && active.reviewOutcome === null
      && active.reviewHistory.length === 0
      && active.verificationReviewUsed === false
      && active.verificationEscalation === null;
    const headDriftRecovery = tasklessReviewHeadDriftRefreshAllowed(active);
    const pendingHeadDriftRecovery = tasklessPendingReviewHeadDriftRefreshAllowed(active);
    if (!pristine && !headDriftRecovery && !pendingHeadDriftRecovery) {
      throw new GitHubWorkflowError(
        'Empty-thread refresh requires a pristine taskless cycle or guarded review HEAD-drift recovery',
        'TASKLESS_REFRESH_NOT_ALLOWED',
      );
    }
    if (!stateAdapter.checkpointTaskCompletion) {
      throw new GitHubWorkflowError('The guarded thread-proof checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    let live = await readLiveSnapshot(client, active, {
      reactionsFor: pendingHeadDriftRecovery ? active.reviewRequest.id : null,
    });
    let pendingResponse = null;
    let staleDiscoveryDisposition = null;
    if (pendingHeadDriftRecovery) {
      try {
        assertRecordedRequestComment(active, live);
      } catch (error) {
        if (!(error instanceof GitHubWorkflowError) || error.code !== 'REQUEST_PROOF_STALE'
            || active.reviewRequest.kind !== 'verification') throw error;
        return checkpointPendingRecoveryEscalation(
          active, live, [`request-proof:${active.reviewRequest.id}`], 'ambiguous-canonical-evidence',
        );
      }
      pendingResponse = await classifyPendingReviewResponse(active, live, git, { includeUnmatchedRoots: true });
      if (active.reviewRequest.kind === 'verification' && pendingResponse.status !== 'none') {
        return checkpointPendingRecoveryEscalation(
          active,
          live,
          pendingResponse.evidenceIds,
          pendingResponse.status === 'supported'
            ? 'stale-canonical-evidence' : 'ambiguous-canonical-evidence',
        );
      }
      if (active.reviewRequest.kind === 'discovery') {
        if (pendingResponse.status === 'ambiguous') {
          throw new GitHubWorkflowError(
            'Discovery review evidence is multiple, conflicting, or unsupported and requires a human',
            'DISCOVERY_COLLECTION_UNRESOLVED',
          );
        }
        staleDiscoveryDisposition = dispositionForPendingResponse(
          active, pendingResponse, clock.now(),
        );
      }
    }
    await assertMutationReady({ state: active, git }, live);
    if (staleDiscoveryDisposition?.evidence.outcome === 'findings') {
      const finalLive = await readLiveSnapshot(client, active, {
        reactionsFor: active.reviewRequest.id,
      });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git, { includeUnmatchedRoots: true });
      if (!samePendingResponseObservation(pendingResponse, finalResponse)) {
        throw new GitHubWorkflowError(
          'Stale discovery evidence or canonical root state changed during disposition',
          'STALE_DISCOVERY_EVIDENCE_CHANGED',
        );
      }
      dispositionForPendingResponse(active, finalResponse, staleDiscoveryDisposition.disposedAt);
      await assertMutationReady({ state: active, git }, finalLive);
      await assertCurrent(active);
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber: active.prNumber,
        expectedRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        staleDiscoveryDisposition,
      });
      return {
        stateRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        staleDiscoveryDisposition,
        actionable: true,
      };
    }
    const { plan } = buildCanonicalRootPlan(active, live);
    if (plan.length !== 0 || live.threads.some((thread) => thread.canonical)) {
      throw new GitHubWorkflowError('Canonical Codex roots exist; triage them before refreshing empty proof', 'TASKLESS_THREADS_NOT_EMPTY');
    }
    const threadResolutionStatus = {
      status: 'passed',
      headSha: active.currentIntegrationHeadSha,
      threads: [],
      threadlessVerification: active.threadResolutionStatus.threadlessVerification,
      ...(Object.hasOwn(active.threadResolutionStatus, 'localVerification') ? {
        localVerification: active.threadResolutionStatus.localVerification,
      } : {}),
      updatedAt: clock.now(),
    };
    if (pendingHeadDriftRecovery) {
      const finalLive = await readLiveSnapshot(client, active, {
        reactionsFor: active.reviewRequest.id,
      });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git, { includeUnmatchedRoots: true });
      if (!samePendingResponseObservation(pendingResponse, finalResponse)) {
        throw new GitHubWorkflowError(
          'Pending review evidence or canonical root state changed while refreshing proof',
          'STALE_DISCOVERY_EVIDENCE_CHANGED',
        );
      }
      if (active.reviewRequest.kind === 'discovery') {
        dispositionForPendingResponse(
          active,
          finalResponse,
          staleDiscoveryDisposition?.disposedAt ?? clock.now(),
        );
      }
      await assertMutationReady({ state: active, git }, finalLive);
      const { plan: finalPlan } = buildCanonicalRootPlan(active, finalLive);
      if (finalPlan.length !== 0 || finalLive.threads.some((thread) => thread.canonical)) {
        throw new GitHubWorkflowError(
          'Canonical Codex roots changed while refreshing empty proof',
          'TASKLESS_THREADS_NOT_EMPTY',
        );
      }
    } else {
      const finalLive = await readLiveSnapshot(client, active);
      await assertMutationReady({ state: active, git }, finalLive);
      const { plan: finalPlan } = buildCanonicalRootPlan(active, finalLive);
      if (finalPlan.length !== 0 || finalLive.threads.some((thread) => thread.canonical)) {
        throw new GitHubWorkflowError(
          'Canonical Codex roots changed while refreshing empty proof',
          'TASKLESS_THREADS_NOT_EMPTY',
        );
      }
    }
    await assertCurrent(active);
    if (pendingHeadDriftRecovery
        && active.threadResolutionStatus.status === 'passed'
        && active.threadResolutionStatus.headSha === active.currentIntegrationHeadSha
        && active.threadResolutionStatus.threads.length === 0) {
      if (staleDiscoveryDisposition !== null) {
        active = await stateAdapter.checkpointTaskCompletion({
          prNumber: active.prNumber,
          expectedRevision: active.revision,
          threadResolutionStatus: active.threadResolutionStatus,
          staleDiscoveryDisposition,
        });
      }
      return {
        stateRevision: active.revision,
        threadResolutionStatus: active.threadResolutionStatus,
        ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
      };
    }
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber: active.prNumber,
      expectedRevision: active.revision,
      threadResolutionStatus,
      ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
    });
    return {
      stateRevision: active.revision,
      threadResolutionStatus: active.threadResolutionStatus,
      ...(staleDiscoveryDisposition ? { staleDiscoveryDisposition } : {}),
    };
  }

  async function requestUnlocked(prNumber, kind) {
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
      const persistedReadyIntent = priorReadyIntent ?? await journalIntent(journal, readyIntent);
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
    if (!priorIntent) intended = await journalIntent(journal, pendingIntent);
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

  async function replyResolve(prNumber, taskId) {
    let active = await load(prNumber);
    let live = await readLiveSnapshot(client, active);
    await assertMutationReady({ state: active, git }, live);
    const { plan, selected: selectedTask, selectedPlan } = buildCanonicalRootPlan(active, live, taskId);
    if (selectedTask?.sourceType === 'github-threadless') {
      const verification = active.threadResolutionStatus.threadlessVerification;
      if (verification.status !== 'passed' || verification.headSha !== active.currentIntegrationHeadSha
          || !verification.taskIds.includes(taskId)) {
        throw new GitHubWorkflowError('Threadless task lacks successful exact-head verification', 'TASK_NOT_READY');
      }
      const proof = buildThreadProof(active, live, new Map(), clock.now());
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber, expectedRevision: active.revision, threadResolutionStatus: proof,
      });
      return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
    }
    const previousProof = new Map(active.threadResolutionStatus.threads.map((item) => [item.threadNodeId, item]));
    const priorResolveIntents = new Map();
    const priorHeadRecoveries = new Map();
    const preflightReplies = new Map();
    for (const entry of plan) {
      const { thread } = entry;
      const old = previousProof.get(thread.id);
      const recordedReply = old ? assertExistingThreadProof(active, live, entry, old) : null;
      const priorHeadRecovery = !old && selectedPlan.some((selected) => selected.thread.id === thread.id)
        ? await journaledPriorHeadRecovery(active, live, entry, selectedTask, journal, git) : null;
      if (priorHeadRecovery) priorHeadRecoveries.set(thread.id, priorHeadRecovery);
      preflightReplies.set(thread.id, recordedReply ? [recordedReply]
        : priorHeadRecovery ? [priorHeadRecovery.reply]
          : exactRepliesFor(active, live, entry).exact);
      if (thread.isResolved && !old?.isResolved) {
        const operationId = `resolve:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
        const intent = priorHeadRecovery?.resolveIntent ?? await lookupJournalIntent(journal, operationId);
        if (!intent || preflightReplies.get(thread.id).length !== 1) {
          throw new GitHubWorkflowError('Resolved thread lacks pre-existing exact recovery evidence', 'RESOLUTION_PROOF_MISSING');
        }
        priorResolveIntents.set(thread.id, intent);
      }
    }
    if (priorHeadRecoveries.size > 1) {
      throw new GitHubWorkflowError('Prior-head recovery is ambiguous across canonical roots', 'REPLY_AMBIGUOUS');
    }
    if (priorHeadRecoveries.size === 1) await assertCurrent(active);
    const evidence = new Map();
    for (const entry of plan) {
      const intent = priorResolveIntents.get(entry.thread.id);
      if (intent) evidence.set(entry.thread.id, {
        reply: preflightReplies.get(entry.thread.id)[0], resolvedAt: intent.at, resolvedBy: live.metadata.viewer.login,
        ...(priorHeadRecoveries.has(entry.thread.id)
          ? { priorHeadRecovery: priorHeadRecoveries.get(entry.thread.id) } : {}),
      });
    }
    for (const entry of selectedPlan) {
      const { thread } = entry;
      const operationId = `reply:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
      live = await readLiveSnapshot(client, active);
      await assertMutationReady({ state: active, git }, live);
      if (priorHeadRecoveries.size === 1) await assertCurrent(active);
      let current = live.threads.find((item) => item.id === thread.id);
      const old = previousProof.get(thread.id);
      if (old?.isResolved) {
        assertExistingThreadProof(active, live, { ...entry, thread: current }, old);
        continue;
      }
      const priorHeadRecovery = priorHeadRecoveries.get(thread.id);
      let replies = priorHeadRecovery
        ? [assertPriorHeadRecoveryLive(active, live, { ...entry, thread: current }, priorHeadRecovery)]
        : old?.replyId
        ? [assertExistingThreadProof(active, live, { ...entry, thread: current }, old)]
        : exactRepliesFor(active, live, { ...entry, thread: current }).exact;
      if (replies.length === 0) {
        if (current.isResolved) {
          throw new GitHubWorkflowError('Resolved thread lacks its exact current reply', 'RESOLUTION_PROOF_MISSING');
        }
        const intent = await journalIntent(journal, intentFor('reply', operationId, clock.now()));
        live = await readLiveSnapshot(client, active);
        await assertMutationReady({ state: active, git }, live);
        current = live.threads.find((item) => item.id === thread.id);
        replies = exactRepliesFor(active, live, { ...entry, thread: current }).exact;
        if (replies.length === 0) {
          if (intent.isNew === false) {
            throw new GitHubWorkflowError('Prior reply intent has no unique live marker', 'REPLY_RECOVERY_MISSING');
          }
          await assertCurrent(active);
          await executeMutation(client, 'AddThreadReply', {
            threadId: thread.id, body: deterministicReply(active, entry, operationId),
            clientMutationId: intent.clientMutationId,
          }, 'addPullRequestReviewThreadReply');
          current = (await readLiveSnapshot(client, active)).threads.find((item) => item.id === thread.id);
          live = await readLiveSnapshot(client, active);
          current = live.threads.find((item) => item.id === thread.id);
          replies = exactRepliesFor(active, live, { ...entry, thread: current }).exact;
        }
        if (replies.length !== 1) throw new GitHubWorkflowError('Reply mutation was not uniquely proven live', 'REPLY_NOT_PROVEN');
      }
      const reply = replies[0];
      if (current.isResolved && !old?.isResolved) {
        const priorIntent = priorResolveIntents.get(thread.id);
        if (!priorIntent) throw new GitHubWorkflowError('Resolved thread lacks a pre-existing resolve intent', 'RESOLUTION_PROOF_MISSING');
        evidence.set(thread.id, {
          reply, resolvedAt: priorIntent.at, resolvedBy: live.metadata.viewer.login,
          ...(priorHeadRecovery ? { priorHeadRecovery } : {}),
        });
        continue;
      }
      if (!current.isResolved) {
        live = await readLiveSnapshot(client, active);
        await assertMutationReady({ state: active, git }, live);
        current = live.threads.find((item) => item.id === thread.id);
        if (!current.isResolved) {
          const resolveOperation = `resolve:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
          const intent = await journalIntent(journal, intentFor('resolve', resolveOperation, clock.now()));
          live = await readLiveSnapshot(client, active);
          await assertMutationReady({ state: active, git }, live);
          current = live.threads.find((item) => item.id === thread.id);
          if (current?.isResolved) {
            evidence.set(thread.id, { reply, resolvedAt: intent.at, resolvedBy: live.metadata.viewer.login });
            continue;
          }
          await assertCurrent(active);
          await executeMutation(
            client,
            'ResolveThread',
            { threadId: thread.id, clientMutationId: intent.clientMutationId },
            'resolveReviewThread',
          );
          current = (await readLiveSnapshot(client, active)).threads.find((item) => item.id === thread.id);
          if (!current?.isResolved) throw new GitHubWorkflowError('Resolve mutation was not proven live', 'RESOLVE_NOT_PROVEN');
        }
      }
      evidence.set(thread.id, {
        reply,
        resolvedAt: previousProof.get(thread.id)?.resolvedAt ?? clock.now(),
        resolvedBy: live.metadata.viewer.login,
      });
    }
    live = await readLiveSnapshot(client, active);
    await assertMutationReady({ state: active, git }, live);
    if (priorHeadRecoveries.size === 1) {
      for (const [threadId, recovery] of priorHeadRecoveries) {
        const entry = plan.find((candidate) => candidate.thread.id === threadId);
        const current = live.threads.find((thread) => thread.id === threadId);
        assertPriorHeadRecoveryLive(active, live, { ...entry, thread: current }, recovery);
      }
      await assertCurrent(active);
    }
    const proof = buildThreadProof(active, live, evidence, clock.now());
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber, expectedRevision: active.revision, threadResolutionStatus: proof,
    });
    return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
  }

  async function verifyResolve(prNumber, taskSelection) {
    const taskIds = normalizeVerifyResolveTaskIds(taskSelection);
    let active = await load(prNumber);
    if (!stateAdapter.checkpointTaskCompletion) {
      throw new GitHubWorkflowError('The guarded task-completion checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    const selectedTasks = taskIds.map((taskId) => {
      const task = active.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new GitHubWorkflowError(`Task ${taskId} was not found`, 'TASK_NOT_FOUND');
      return task;
    });
    const selectedTask = selectedTasks[0];
    const completedThreadlessRefresh = selectedTasks.every((task) => (
      task.sourceType === 'github-threadless' && task.status === 'completed'
    ));
    if (taskIds.length > 1 && !completedThreadlessRefresh) {
      throw new GitHubWorkflowError(
        'Multiple tasks may only select one completed threadless proof set',
        'TASK_NOT_READY',
      );
    }
    for (const task of selectedTasks) {
      if (!['local', 'github-threadless'].includes(task.sourceType)) {
        throw new GitHubWorkflowError(
          `Task ${task.id} must use reply-resolve for its canonical GitHub thread`,
          'TASK_NOT_READY',
        );
      }
      if (!taskIsEligibleForVerifyResolve(task)) {
        throw new GitHubWorkflowError(
          `Task ${task.id} is not eligible for verifier completion`,
          'TASK_NOT_READY',
        );
      }
    }

    let completedThreadlessVerification = null;
    if (completedThreadlessRefresh) {
      completedThreadlessVerification = active.threadResolutionStatus.threadlessVerification;
      const preservedTaskIds = [...(completedThreadlessVerification.taskIds ?? [])].sort();
      if (completedThreadlessVerification.status !== 'passed'
          || !sameTaskIds(taskIds, preservedTaskIds)) {
        throw new GitHubWorkflowError(
          'Completed threadless refresh requires the complete preserved task set',
          'TASK_NOT_READY',
        );
      }
    }

    let live = await readLiveSnapshot(client, active);
    await assertMutationReady({ state: active, git }, live);
    if (completedThreadlessRefresh) assertRecordedThreadsLive(active, live);
    else assertLiveThreadProof(active, live);
    await assertCurrent(active);

    live = await readLiveSnapshot(client, active);
    await assertMutationReady({ state: active, git }, live);
    if (completedThreadlessRefresh) assertRecordedThreadsLive(active, live);
    else assertLiveThreadProof(active, live);
    await assertCurrent(active);

    if (selectedTask.status === 'completed' && completedThreadlessRefresh) {
      if (completedThreadlessVerification.headSha === active.currentIntegrationHeadSha) {
        return verifyResolveResult(taskIds, active);
      }
      if (active.threadResolutionStatus.status !== 'not-run'
          || active.threadResolutionStatus.headSha !== null
          || active.threadResolutionStatus.updatedAt !== null) {
        throw new GitHubWorkflowError('Completed threadless refresh requires invalidated aggregate proof', 'TASK_NOT_READY');
      }
      const threadResolutionStatus = {
        ...active.threadResolutionStatus,
        threadlessVerification: {
          ...completedThreadlessVerification,
          headSha: active.currentIntegrationHeadSha,
          taskIds,
          updatedAt: clock.now(),
        },
      };
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber, expectedRevision: active.revision, threadResolutionStatus, verifiedLocalTaskIds: [],
      });
      return verifyResolveResult(taskIds, active);
    }
    if (selectedTask.status === 'completed' && selectedTask.sourceType === 'local') {
      const localVerification = active.threadResolutionStatus.localVerification;
      if (localVerification?.status === 'passed'
          && localVerification.headSha === active.currentIntegrationHeadSha
          && localVerification.taskIds.includes(selectedTask.id)) {
        return verifyResolveResult(taskIds, active);
      }
    }

    const verifiedAt = clock.now();
    let threadResolutionStatus = buildThreadProof(active, live, new Map(), verifiedAt);
    const verifiedLocalTaskIds = [];
    if (selectedTask.sourceType === 'local') {
      verifiedLocalTaskIds.push(selectedTask.id);
    } else {
      const previousIds = active.threadResolutionStatus.threadlessVerification.status === 'passed'
        ? active.threadResolutionStatus.threadlessVerification.taskIds : [];
      threadResolutionStatus = {
        ...threadResolutionStatus,
        threadlessVerification: {
          status: 'passed',
          headSha: active.currentIntegrationHeadSha,
          taskIds: [...new Set([...previousIds, selectedTask.id])].sort(),
          updatedAt: verifiedAt,
        },
      };
    }
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber, expectedRevision: active.revision, threadResolutionStatus, verifiedLocalTaskIds,
    });
    return verifyResolveResult(taskIds, active);
  }

  async function collect(prNumber, { expectedOutcome = null } = {}) {
    let active = await load(prNumber);
    if (expectedOutcome !== null && active.reviewOutcome !== null
        && sameRequestBoundOutcome(active, expectedOutcome)) {
      return { escalated: false, outcome: active.reviewOutcome, phase: active.phase, performed: false };
    }
    const priorRevision = active.revision;
    if (!active.reviewRequest || active.reviewOutcome || active.reviewHistory.at(-1)?.outcome !== null) {
      throw new GitHubWorkflowError('No pending review request to collect', 'REVIEW_NOT_PENDING');
    }
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
    try {
      assertRecordedRequestComment(active, live);
    } catch (error) {
      if (!(error instanceof GitHubWorkflowError) || error.code !== 'REQUEST_PROOF_STALE') throw error;
      if (active.reviewRequest.kind !== 'verification') throw error;
      const response = await classifyPendingReviewResponse(active, live, git);
      await assertMutationReady({ state: active, git }, live);
      const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
      await assertMutationReady({ state: active, git }, finalLive);
      if (JSON.stringify(requestAnchorObservation(live, active.reviewRequest.id))
          !== JSON.stringify(requestAnchorObservation(finalLive, active.reviewRequest.id))
          || !samePendingResponseObservation(response, finalResponse)) {
        throw new GitHubWorkflowError('Recorded request anchor changed during collection', 'REVIEW_COLLECTION_STALE');
      }
      await assertCurrent(active);
      const ids = [
        `request-proof:${active.reviewRequest.id}`,
        ...response.evidenceIds,
        ...live.comments.filter((comment) => comment.id === active.reviewRequest.id)
          .map((comment) => `live-request:${comment.id}`),
      ];
      return checkpointPendingRecoveryEscalation(
        active, finalLive, ids, 'ambiguous-canonical-evidence',
      );
    }
    if (live.metadata.headRefOid !== active.reviewRequest.headSha) {
      throw new GitHubWorkflowError(
        'The exact recorded review request became stale at the live PR head',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertMutationReady({ state: active, git }, live);
    const response = await classifyPendingReviewResponse(active, live, git);
    if (response.status === 'none') {
      if (active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      throw new GitHubWorkflowError('Canonical review evidence is not available yet', 'REVIEW_NOT_AVAILABLE');
    }
    if (response.status === 'ambiguous' || response.status === 'stale') {
      if (active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      assertRecordedRequestComment(active, finalLive);
      const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
      if (!samePendingResponseObservation(response, finalResponse)) {
        throw new GitHubWorkflowError('Canonical review evidence changed during collection', 'REVIEW_COLLECTION_STALE');
      }
      await assertMutationReady({ state: active, git }, finalLive);
      await assertCurrent(active);
      return checkpointPendingRecoveryEscalation(
        active, finalLive,
        response.evidenceIds,
        response.status === 'stale' ? 'stale-canonical-evidence' : 'ambiguous-canonical-evidence',
      );
    }
    const finalLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
    assertRecordedRequestComment(active, finalLive);
    if (finalLive.metadata.headRefOid !== active.reviewRequest.headSha) {
      throw new GitHubWorkflowError('The exact recorded review request became stale at the live PR head', 'REVIEW_COLLECTION_STALE');
    }
    const finalResponse = await classifyPendingReviewResponse(active, finalLive, git);
    if (!samePendingResponseObservation(response, finalResponse)) {
      throw new GitHubWorkflowError('Canonical review evidence changed during collection', 'REVIEW_COLLECTION_STALE');
    }
    await assertMutationReady({ state: active, git }, finalLive);
    await assertCurrent(active);
    const outcome = finalResponse.evidence;
    try {
      active = await stateAdapter.checkpointReviewOutcome({
        prNumber, expectedRevision: active.revision, outcome,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (!sameRequestBoundOutcome(active, outcome)) throw error;
      return { escalated: false, outcome: active.reviewOutcome, phase: active.phase, performed: false };
    }
    return { escalated: false, outcome: active.reviewOutcome, phase: active.phase,
      performed: active.revision !== priorRevision };
  }

  async function assertCompletionLiveEvidence(state, live, heads) {
    assertRecordedRequestComment(state, live);
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical threads are still unresolved', 'COMPLETION_NOT_READY');
    }
    assertLiveThreadProof(state, live);
    if (state.reviewOutcome?.outcome !== 'clean'
        || state.reviewOutcome.headSha !== live.metadata.headRefOid
        || state.reviewRequest?.headSha !== live.metadata.headRefOid) {
      throw new GitHubWorkflowError('Clean canonical outcome does not apply to live PR HEAD', 'COMPLETION_NOT_READY');
    }
    let outcomeIsLive;
    if (state.reviewOutcome.evidenceType === 'review-submission') {
      outcomeIsLive = live.reviews.some((review) => review.id === state.reviewOutcome.id
        && review.state === 'COMMENTED' && review.commit?.oid === live.metadata.headRefOid
        && isCanonicalActor(review.author) && evidenceAtOrAfter(review.submittedAt, state.reviewRequest.at)
        && classifyReviewSubmission(review, live.threads) === 'clean');
    } else if (state.reviewOutcome.evidenceType === 'request-reaction') {
      outcomeIsLive = live.reactions.some((reaction) => reaction.id === state.reviewOutcome.id
        && reaction.content === 'THUMBS_UP' && isCanonicalActor(reaction.user)
        && evidenceAtOrAfter(reaction.createdAt, state.reviewRequest.at));
    } else {
      const classified = await classifyStructuralIssueComments({
        comments: live.comments.filter((comment) => comment.id === state.reviewOutcome.id),
        request: state.reviewRequest, threads: live.threads, git, cwd: state.integrationWorktree,
        expectedHeads: [state.reviewRequest.headSha, state.currentIntegrationHeadSha,
          heads.pushedHeadSha, live.metadata.headRefOid],
      });
      outcomeIsLive = classified.exact.length === 1 && classified.unsupported.length === 0;
      if (outcomeIsLive) {
        const comment = classified.exact[0].comment;
        outcomeIsLive = (comment.databaseId ?? null) === state.reviewOutcome.databaseId
          && comment.url === state.reviewOutcome.url
          && sameTimestamp(comment.createdAt, state.reviewOutcome.at)
          && comment.author.login === state.reviewOutcome.reviewerLogin
          && comment.author.id === state.reviewOutcome.reviewerNodeId
          && comment.author.__typename === state.reviewOutcome.reviewerType
          && comment.author.url === state.reviewOutcome.reviewerUrl;
      }
    }
    if (!outcomeIsLive) {
      throw new GitHubWorkflowError('Recorded clean outcome is not proven live', 'COMPLETION_NOT_READY');
    }
    const response = await classifyPendingReviewResponse(
      { ...state, reviewOutcome: null }, live, git,
    );
    if (response.status !== 'supported' || response.evidence.outcome !== 'clean'
        || JSON.stringify(response.evidence) !== JSON.stringify(state.reviewOutcome)) {
      throw new GitHubWorkflowError(
        'Recorded clean canonical response or root evidence changed before completion',
        'COMPLETION_NOT_READY',
      );
    }
    return response;
  }

  async function assertFindingsLiveEvidence(state, live) {
    if (state.reviewOutcome?.outcome !== 'findings'
        || state.reviewRequest?.headSha !== state.currentIntegrationHeadSha
        || state.reviewOutcome.headSha !== state.currentIntegrationHeadSha) {
      throw new GitHubWorkflowError(
        'Recorded findings do not apply to the current integration HEAD',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertMutationReady({ state, git }, live);
    assertRecordedRequestComment(state, live);
    const response = await classifyPendingReviewResponse(
      { ...state, reviewOutcome: null }, live, git,
    );
    if (response.status !== 'supported' || response.evidence.outcome !== 'findings'
        || JSON.stringify(response.evidence) !== JSON.stringify(state.reviewOutcome)) {
      throw new GitHubWorkflowError(
        'Recorded canonical findings evidence changed before triage',
        'REVIEW_COLLECTION_STALE',
      );
    }
    await assertCurrent(state);
    return response;
  }

  async function revalidateCompletedState(active) {
    if (active.phase !== 'complete' || active.ciValidationStatus?.status !== 'passed') {
      throw new GitHubWorkflowError('Durable completion evidence is incomplete', 'COMPLETION_NOT_READY');
    }
    let priorResponse = null;
    let priorCiEvidence = null;
    for (let snapshotIndex = 0; snapshotIndex < 2; snapshotIndex += 1) {
      const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
      const heads = await assertMutationReady({ state: active, git }, live);
      const response = await assertCompletionLiveEvidence(active, live, heads);
      const ciEvidence = ciEvidenceFromRollup(await readPullRequestChecks(
        client, active.repository, active.prNumber, live.metadata.headRefOid,
      ));
      if (ciEvidence.status !== 'passed' || !sameCiEvidence(ciEvidence, active.ciValidationStatus)) {
        throw new GitHubWorkflowError(
          'Live Full validation evidence differs from durable completion evidence',
          'COMPLETION_NOT_READY',
        );
      }
      if (priorResponse !== null && (!samePendingResponseObservation(priorResponse, response)
          || !sameCiEvidence(priorCiEvidence, ciEvidence))) {
        throw new GitHubWorkflowError(
          'Live review or CI evidence changed during Done revalidation',
          'COMPLETION_NOT_READY',
        );
      }
      priorResponse = response;
      priorCiEvidence = ciEvidence;
    }
    await assertCurrent(active);
    return active;
  }

  function isTransientCiError(error) {
    return error instanceof GitHubWorkflowError
      && ['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code);
  }

  async function advance(prNumber) {
    let active = await load(prNumber);
    const performedTransitions = [];
    const result = (terminal, waiting, nextAction, extra = {}) => ({
      phase: active.phase, revision: active.revision, performedTransitions, terminal, waiting, nextAction, ...extra,
    });
    if (active.verificationEscalation) {
      return result('escalation', false, active.nextAction, { escalation: active.verificationEscalation });
    }
    if (active.phase === 'complete') {
      try {
        await revalidateCompletedState(active);
      } catch (error) {
        if (isTransientCiError(error)) {
          return result('waiting', true, 'Await authoritative Full validation CI evidence.');
        }
        throw error;
      }
      return result('done', false, active.nextAction);
    }
    const initialLive = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    assertPullRequestReady(initialLive);
    if (!active.reviewRequest || !active.reviewOutcome) {
      if (!active.reviewRequest) {
        return result('waiting', true, active.nextAction);
      }
      const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
      try {
        assertRecordedRequestComment(active, live);
      } catch (error) {
        if (active.reviewRequest.kind !== 'verification') throw error;
        const collected = await collect(prNumber);
        active = await load(prNumber);
        if (collected.performed) performedTransitions.push('verification-escalation');
        return result('escalation', false, active.nextAction, { escalation: collected.escalation });
      }
      if (live.metadata.headRefOid !== active.reviewRequest.headSha) {
        return result('waiting', true, 'Review request is stale at the live PR head.');
      }
      const response = await classifyPendingReviewResponse(active, live, git);
      if (response.status === 'none') {
        return result('waiting', true, 'Await the canonical Codex review response.');
      }
      if (response.status === 'ambiguous' && active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const collected = await collect(prNumber, { expectedOutcome: response.status === 'supported' ? response.evidence : null });
      if (collected.escalated) {
        active = await load(prNumber);
        if (collected.performed) performedTransitions.push('verification-escalation');
        return result('escalation', false, active.nextAction, { escalation: collected.escalation });
      }
      if (collected.performed) performedTransitions.push('review-outcome');
      active = await load(prNumber);
      if (active.reviewOutcome?.outcome === 'findings') {
        return result('triage', false, active.nextAction);
      }
    }
    if (active.reviewOutcome?.outcome === 'findings') {
      if (active.reviewRequest?.headSha !== active.currentIntegrationHeadSha
          || active.reviewOutcome.headSha !== active.currentIntegrationHeadSha) {
        throw new GitHubWorkflowError(
          'Recorded findings do not apply to the current integration HEAD',
          'REVIEW_COLLECTION_STALE',
        );
      }
      if (initialLive.metadata.headRefOid !== active.currentIntegrationHeadSha) {
        return result('waiting', true, 'Review findings are stale at the live PR head; reconcile before triage.');
      }
      const initialFindingsResponse = await assertFindingsLiveEvidence(active, initialLive);
      const finalFindingsLive = await readLiveSnapshot(
        client, active, { reactionsFor: active.reviewRequest.id },
      );
      const finalFindingsResponse = await assertFindingsLiveEvidence(active, finalFindingsLive);
      if (!samePendingResponseObservation(initialFindingsResponse, finalFindingsResponse)) {
        throw new GitHubWorkflowError(
          'Canonical findings response or root evidence changed before triage',
          'REVIEW_COLLECTION_STALE',
        );
      }
      return result('triage', false, active.nextAction);
    }
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    await assertMutationReady({ state: active, git }, live);
    assertRecordedRequestComment(active, live);
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical threads are still unresolved', 'COMPLETION_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    if (active.reviewOutcome?.outcome !== 'clean'
        || active.reviewOutcome.headSha !== live.metadata.headRefOid
        || active.reviewRequest?.headSha !== live.metadata.headRefOid) {
      throw new GitHubWorkflowError('Clean canonical outcome no longer applies to the live PR head', 'COMPLETION_NOT_READY');
    }
    const liveOutcome = await classifyPendingReviewResponse(
      { ...active, reviewOutcome: null }, live, git,
    );
    if (liveOutcome.status !== 'supported' || liveOutcome.evidence.outcome !== 'clean'
        || JSON.stringify(liveOutcome.evidence) !== JSON.stringify(active.reviewOutcome)) {
      throw new GitHubWorkflowError('Recorded clean canonical evidence changed before CI validation', 'COMPLETION_NOT_READY');
    }
    if (live.metadata.headRefOid !== active.currentIntegrationHeadSha) {
      return result('waiting', true, 'Reconcile the live PR head before advancing.');
    }
    let ci;
    try {
      ci = ciEvidenceFromRollup(await readPullRequestChecks(client, active.repository, active.prNumber, live.metadata.headRefOid));
    } catch (error) {
      if (error instanceof GitHubWorkflowError && ['CI_CHECK_MISSING', 'CI_VALIDATION_PENDING'].includes(error.code)) {
        return result('waiting', true, 'Await authoritative Full validation CI evidence.');
      }
      throw error;
    }
    let collectedCi;
    try {
      collectedCi = await collectCi(prNumber);
    } catch (error) {
      if (isTransientCiError(error)) {
        active = await load(prNumber);
        if (active.phase === 'complete') {
          try {
            await revalidateCompletedState(active);
          } catch (revalidationError) {
            if (isTransientCiError(revalidationError)) {
              return result('waiting', true, 'Await authoritative Full validation CI evidence.');
            }
            throw revalidationError;
          }
          return result('done', false, active.nextAction);
        }
        return result('waiting', true, 'Await authoritative Full validation CI evidence.');
      }
      throw error;
    }
    active = await load(prNumber);
    if (collectedCi.performed) performedTransitions.push('ci-validation');
    if (collectedCi.evidence.status === 'failed') {
      return result('failure', false, active.nextAction, { ciValidation: collectedCi.evidence });
    }
    let completed;
    try {
      completed = await complete(prNumber, { checkpointCi: false });
    } catch (error) {
      if (!isTransientCiError(error)) throw error;
      active = await load(prNumber);
      if (active.phase === 'complete') {
        try {
          await revalidateCompletedState(active);
        } catch (revalidationError) {
          if (isTransientCiError(revalidationError)) {
            return result('waiting', true, 'Await authoritative Full validation CI evidence.');
          }
          throw revalidationError;
        }
        return result('done', false, active.nextAction);
      }
      return result('waiting', true, 'Await authoritative Full validation CI evidence.');
    }
    if (completed.performed) performedTransitions.push('cycle-completion');
    active = await load(prNumber);
    return result('done', false, 'Archive is explicit after Done.', { completed: completed.completed });
  }

  async function complete(prNumber, { checkpointCi = true } = {}) {
    let active = await load(prNumber);
    const priorRevision = active.revision;
    if (active.phase === 'complete') {
      await revalidateCompletedState(active);
      return { completed: true, phase: active.phase, revision: active.revision, idempotent: true, performed: false };
    }
    const expectedRequest = structuredClone(active.reviewRequest);
    const expectedOutcome = structuredClone(active.reviewOutcome);
    const expectedHeadSha = active.currentIntegrationHeadSha;

    let live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    let completionHeads = await assertMutationReady({ state: active, git }, live);
    const initialResponse = await assertCompletionLiveEvidence(active, live, completionHeads);
    const snapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const evidence = ciEvidenceFromRollup(snapshot);
    if (!checkpointCi && !sameCiEvidence(evidence, active.ciValidationStatus)) {
      throw new GitHubWorkflowError('Durable CI evidence changed before completion', 'COMPLETION_NOT_READY');
    }
    if (evidence.status !== 'passed') {
      throw new GitHubWorkflowError('Full GitHub Actions validation did not pass', 'COMPLETION_NOT_READY');
    }
    if (checkpointCi) {
      active = await stateAdapter.checkpointCiValidation({
        prNumber: active.prNumber, expectedRevision: active.revision, evidence,
      });
    }
    const expectedCiEvidence = checkpointCi ? evidence : structuredClone(active.ciValidationStatus);
    live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    const refreshedHeads = await assertMutationReady({ state: active, git }, live);
    completionHeads = refreshedHeads;
    const finalResponse = await assertCompletionLiveEvidence(active, live, completionHeads);
    if (!samePendingResponseObservation(initialResponse, finalResponse)) {
      throw new GitHubWorkflowError(
        'Live review response or root evidence changed before completion',
        'COMPLETION_NOT_READY',
      );
    }
    const finalCiSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const finalEvidence = ciEvidenceFromRollup(finalCiSnapshot);
    if (finalEvidence.status !== 'passed' || !sameCiEvidence(evidence, finalEvidence)) {
      throw new GitHubWorkflowError(
        'Full GitHub Actions validation changed before completion', 'COMPLETION_NOT_READY',
      );
    }
    try {
      active = await stateAdapter.checkpointCompletion({
        prNumber, expectedRevision: active.revision,
        pushedHeadSha: refreshedHeads.pushedHeadSha, prHeadSha: live.metadata.headRefOid,
        prState: live.metadata.state, isDraft: live.metadata.isDraft,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (active.phase !== 'complete'
          || active.currentIntegrationHeadSha !== expectedHeadSha
          || JSON.stringify(active.reviewRequest) !== JSON.stringify(expectedRequest)
          || JSON.stringify(active.reviewOutcome) !== JSON.stringify(expectedOutcome)
          || !sameCiEvidence(active.ciValidationStatus, expectedCiEvidence)) throw error;
      return { completed: true, phase: active.phase, revision: active.revision, performed: false, idempotent: true };
    }
    return { completed: true, phase: active.phase, revision: active.revision,
      performed: active.revision !== priorRevision };
  }

  async function request(prNumber, kind) {
    if (!journal?.withRequestOwner) return requestUnlocked(prNumber, kind);
    let requestOwnerEntered = false;
    try {
      return await journal.withRequestOwner(() => {
        requestOwnerEntered = true;
        return requestUnlocked(prNumber, kind);
      });
    } catch (error) {
      if (error?.code !== 'STATE_LOCK_TIMEOUT' || requestOwnerEntered) throw error;
      const active = await load(prNumber);
      const live = await readLiveSnapshot(client, active);
      if (live.metadata.state !== 'OPEN') throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
      await assertMutationReady({ state: active, git }, live, { requireReady: false });
      if (live.metadata.isDraft) {
        return { requested: false, recovered: false, waiting: true,
          nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
      }
      const readyOperationId = `ready:${prNumber}:${live.metadata.id}:${active.currentIntegrationHeadSha}`;
      const readyIntent = await lookupOptionalMutationJournalIntent(journal, 'ready', readyOperationId);
      return { requested: false, recovered: false, waiting: true,
        pullRequestReadiness: readyIntent ? 'recovered-ready' : 'already-ready',
        nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
    }
  }

  return { status, refreshThreads, replyResolve, verifyResolve, request, collect, collectCi, complete, advance };
}

export const githubReviewConstants = {
  CANONICAL_LOGIN, CANONICAL_URL, REQUEST_BODY, PAGE_SIZE, FULL_VALIDATION_CHECK, GITHUB_ACTIONS_APP,
  FULL_VALIDATION_WORKFLOW, FULL_VALIDATION_WORKFLOW_PATH,
};
