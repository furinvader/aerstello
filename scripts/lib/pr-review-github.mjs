import { createHash } from 'node:crypto';

import { reviewRequestGate, validatePrReviewState } from './contracts.mjs';

const CANONICAL_LOGIN = 'chatgpt-codex-connector';
const CANONICAL_URL = 'https://github.com/apps/chatgpt-codex-connector';
const REQUEST_BODY = '@codex review';
const CLEAN_ISSUE_COMMENT_TEMPLATE = "Codex Review: Didn't find any major issues. Nice work!";
const CLEAN_ISSUE_COMMENT_PATTERN = /^Codex Review: Didn't find any major issues\. Nice work!\n\n\*\*Reviewed commit:\*\* `([0-9a-f]{7,40})`(?:\n|$)/u;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 10_000;
const MIN_GRAPHQL_REMAINING = 10;
const FULL_VALIDATION_CHECK = 'Full validation';
const GITHUB_ACTIONS_APP = 'github-actions';
const FULL_VALIDATION_WORKFLOW = 'CI';
const FULL_VALIDATION_WORKFLOW_PATH = '.github/workflows/ci.yml';

const OPERATIONS = {
  PullRequestMetadata: `query PullRequestMetadata($owner:String!,$repo:String!,$pr:Int!){rateLimit{cost remaining} viewer{login id} repository(owner:$owner,name:$repo){pullRequest(number:$pr){id number url headRefOid}}}`,
  PullRequestComments: `query PullRequestComments($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){comments(first:50,after:$cursor){nodes{id databaseId url body createdAt author{__typename login url ... on Bot{id} ... on User{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestReviews: `query PullRequestReviews($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviews(first:50,after:$cursor){nodes{id databaseId url body state submittedAt commit{oid} author{__typename login url ... on Bot{id} ... on User{id}}} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestThreads: `query PullRequestThreads($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:50,after:$cursor){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}`,
  PullRequestChecks: `query PullRequestChecks($owner:String!,$repo:String!,$pr:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){pullRequest(number:$pr){number headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:50,after:$cursor){nodes{__typename ... on CheckRun{id databaseId name status conclusion completedAt detailsUrl checkSuite{workflowRun{databaseId url file{path} workflow{name}} app{slug}}} ... on StatusContext{id context state targetUrl}} pageInfo{hasNextPage endCursor}}}}}}}}}`,
  ReviewThreadComments: `query ReviewThreadComments($threadId:ID!,$cursor:String){rateLimit{cost remaining} node(id:$threadId){... on PullRequestReviewThread{comments(first:50,after:$cursor){nodes{id databaseId url body createdAt author{__typename login url ... on Bot{id} ... on User{id}} replyTo{id} pullRequestReview{id}} pageInfo{hasNextPage endCursor}}}}}`,
  RequestReactions: `query RequestReactions($commentId:ID!,$cursor:String){rateLimit{cost remaining} node(id:$commentId){... on IssueComment{reactions(first:50,after:$cursor){nodes{id content createdAt user{__typename login url id}} pageInfo{hasNextPage endCursor}}}}}`,
  AddReviewRequest: `mutation AddReviewRequest($subjectId:ID!,$body:String!,$clientMutationId:String!){addComment(input:{subjectId:$subjectId,body:$body,clientMutationId:$clientMutationId}){clientMutationId}}`,
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
  if (!name.startsWith('Add') && name !== 'ResolveThread') {
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
  if (!pr || pr.number !== prNumber || !pr.id || !pr.headRefOid || !data.viewer?.login || !data.viewer?.id) {
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

export async function readPullRequestChecks(client, repository, prNumber, expectedHeadSha) {
  const variables = { ...splitRepository(repository), pr: prNumber };
  const contexts = [];
  let cursor = null;
  let rollupState = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await execute(client, 'PullRequestChecks', { ...variables, cursor });
    const pr = data.repository?.pullRequest;
    const commits = pr?.commits?.nodes;
    if (pr?.number !== prNumber || pr.headRefOid !== expectedHeadSha
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

async function assertMutationReady({ state, git }, live) {
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

function operationToken(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function intentFor(type, operationId, at) {
  return { type, operationId, clientMutationId: `sky-bar-${operationToken(operationId)}`, at };
}

function replyMarker(operationId) {
  return `<!-- sky-bar-review:${operationToken(operationId)} -->`;
}

function deterministicReply(state, entry, operationId) {
  const checks = state.validationStatus.checks.slice(0, 3).join(', ');
  const tasks = entry.tasks.slice().sort((left, right) => left.id.localeCompare(right.id));
  return [
    `Sky Bar review resolution at ${state.currentIntegrationHeadSha}.`,
    'Tasks:',
    ...tasks.map((task) => task.integratedCommitSha
      ? `- ${task.id}: ${task.integratedCommitSha}`
      : `- ${task.id}: ${task.disposition} — ${task.resolutionSummary ?? 'Disposition recorded and verified.'}`),
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

async function lookupJournalIntent(journal, operationId) {
  if (!journal?.lookupIntent) throw new GitHubWorkflowError('A durable intent journal lookup is required', 'JOURNAL_REQUIRED');
  const intent = await journal.lookupIntent(operationId);
  const expected = intentFor('resolve', operationId, intent?.at);
  if (intent !== null && intent !== undefined && (intent.type !== 'resolve'
      || intent.operationId !== operationId || intent.clientMutationId !== expected.clientMutationId)) {
    throw new GitHubWorkflowError('Mutation intent journal returned invalid correlation', 'JOURNAL_FAILED');
  }
  if (intent) parsedTime(intent.at, 'Resolve intent');
  return intent ?? null;
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
  const markerPattern = /<!-- sky-bar-review:[0-9a-f]{24} -->/u;
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

function assertRecordedReply(state, live, entry, proof) {
  const replies = entry.thread.comments.filter((comment) => comment.id === proof.replyId);
  if (replies.length !== 1) throw new GitHubWorkflowError('Historical reply ID is not uniquely live', 'THREAD_PROOF_STALE');
  const reply = replies[0];
  const header = /^Sky Bar review resolution at ([0-9a-f]{40})\.\n/u.exec(reply.body ?? '');
  const replyHeadSha = header?.[1] ?? null;
  const operationId = replyHeadSha ? `reply:${state.prNumber}:${entry.thread.id}:${replyHeadSha}` : null;
  const markers = [...String(reply.body ?? '').matchAll(/<!-- sky-bar-review:[0-9a-f]{24} -->/gu)].map((match) => match[0]);
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
    const exact = recordedReply ? [recordedReply] : exactRepliesFor(state, live, entry).exact;
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
    updatedAt: at,
  };
}

function canonicalEvidenceId(item, prefix) {
  return `${prefix}:${item.id}`;
}

async function classifyCleanIssueComments({ comments, request, git, cwd, expectedHeads }) {
  const exact = [];
  const unsupported = [];
  for (const comment of comments) {
    if (typeof comment.body !== 'string' || !comment.body.startsWith(CLEAN_ISSUE_COMMENT_TEMPLATE)) continue;
    if (!evidenceAtOrAfter(comment.createdAt, request.at)) continue;
    if (!isCanonicalActor(comment.author)) continue;
    const match = CLEAN_ISSUE_COMMENT_PATTERN.exec(comment.body);
    if (!match) {
      unsupported.push(comment);
      continue;
    }
    let candidates;
    try {
      candidates = await git.resolveCommitPrefix(match[1], cwd);
    } catch {
      candidates = [];
    }
    if (!Array.isArray(candidates) || candidates.length !== 1
        || !/^[0-9a-f]{40}$/u.test(candidates[0])
        || expectedHeads.some((head) => candidates[0] !== head)) {
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
      || comment.author?.login !== request.authorLogin || comment.author?.id !== request.authorNodeId
      || !isViewerActor(comment.author, live.metadata.viewer)
      || !sameTimestamp(comment.createdAt, request.at)) {
    throw new GitHubWorkflowError('Recorded request comment differs from live evidence', 'REQUEST_PROOF_STALE');
  }
  return comment;
}

function escalationFor(state, liveHead, evidenceIds, reason, at) {
  const same = liveHead === state.reviewRequest.headSha;
  return {
    requestId: state.reviewRequest.id,
    requestHeadSha: state.reviewRequest.headSha,
    observedPrHeadSha: liveHead,
    headRelation: same ? 'same' : 'changed',
    evidenceIds: [...new Set(evidenceIds)].slice(0, 8),
    reason,
    at,
  };
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

  async function status(prNumber) {
    const active = await load(prNumber);
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    const ciSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
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
    return {
      prNumber: active.prNumber,
      statePhase: active.phase,
      stateHeadSha: active.currentIntegrationHeadSha,
      liveHeadSha: live.metadata.headRefOid,
      canonicalThreads: live.threads.filter((thread) => thread.canonical).map((thread) => ({
        threadNodeId: thread.id,
        rootCommentNodeId: thread.root.id,
        rootCommentDatabaseId: thread.root.databaseId,
        isResolved: thread.isResolved,
      })),
      reviewCount: live.reviews.length,
      requestReactionCount: live.reactions.length,
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
      recordedCiValidation: active.ciValidationStatus,
      liveCiValidation: liveCi,
      openCodexThreads: openThreads,
      nextAction: active.nextAction,
    };
  }

  async function collectCi(prNumber) {
    let active = await load(prNumber);
    const metadata = await readPullRequestMetadata(client, active.repository, active.prNumber);
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
    active = await stateAdapter.checkpointCiValidation({
      prNumber: active.prNumber, expectedRevision: active.revision, evidence,
    });
    return { evidence: active.ciValidationStatus, phase: active.phase, revision: active.revision };
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
    if (!pristine) {
      throw new GitHubWorkflowError('Empty-thread refresh requires a pristine taskless first-review cycle', 'TASKLESS_REFRESH_NOT_ALLOWED');
    }
    if (!stateAdapter.checkpointTaskCompletion) {
      throw new GitHubWorkflowError('The guarded thread-proof checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    const live = await readLiveSnapshot(client, active);
    await assertMutationReady({ state: active, git }, live);
    const { plan } = buildCanonicalRootPlan(active, live);
    if (plan.length !== 0 || live.threads.some((thread) => thread.canonical)) {
      throw new GitHubWorkflowError('Canonical Codex roots exist; triage them before refreshing empty proof', 'TASKLESS_THREADS_NOT_EMPTY');
    }
    const threadResolutionStatus = {
      status: 'passed',
      headSha: active.currentIntegrationHeadSha,
      threads: [],
      threadlessVerification: active.threadResolutionStatus.threadlessVerification,
      updatedAt: clock.now(),
    };
    await assertCurrent(active);
    const finalMetadata = await readPullRequestMetadata(client, active.repository, active.prNumber);
    if (finalMetadata.headRefOid !== active.currentIntegrationHeadSha) {
      throw new GitHubWorkflowError('Live PR HEAD changed while refreshing empty thread proof', 'MUTATION_NOT_READY');
    }
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber: active.prNumber, expectedRevision: active.revision, threadResolutionStatus,
    });
    return { stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
  }

  async function request(prNumber, kind) {
    let active = await load(prNumber);
    if (!['discovery', 'verification'].includes(kind)) throw new GitHubWorkflowError('Review kind is invalid', 'INVALID_REVIEW_KIND');
    let live = await readLiveSnapshot(client, active);
    const heads = await assertMutationReady({ state: active, git }, live);
    const gate = reviewRequestGate(active, { ...heads, prHeadSha: live.metadata.headRefOid });
    if (!gate.allowed || gate.kind !== kind) {
      throw new GitHubWorkflowError(`State gate does not allow ${kind}: ${gate.reasons.join('; ')}`, 'REQUEST_NOT_READY');
    }
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical review threads remain unresolved', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    const operationId = `request:${prNumber}:${kind}:${active.reviewHistory.length + 1}:${active.currentIntegrationHeadSha}`;
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
    await assertMutationReady({ state: active, git }, live);
    if (live.threads.some((thread) => thread.canonical && !thread.isResolved)) {
      throw new GitHubWorkflowError('Canonical review threads remain unresolved', 'REQUEST_NOT_READY');
    }
    assertLiveThreadProof(active, live);
    await assertCurrent(active);
    if (!priorIntent) intended = await journalIntent(journal, pendingIntent);
    const recovering = priorIntent !== null || intended.isNew === false;
    const excludedIds = new Set(intended.excludedCommentIds);
    let candidates = recovering
      ? exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds) : [];
    if (candidates.length > 1) throw new GitHubWorkflowError('Request recovery is ambiguous', 'REQUEST_RECOVERY_AMBIGUOUS');
    const recovered = candidates.length === 1;
    if (candidates.length === 0) {
      if (recovering) throw new GitHubWorkflowError('Prior request intent has no unique live result', 'REQUEST_RECOVERY_MISSING');
      await assertCurrent(active);
      await executeMutation(client, 'AddReviewRequest', {
        subjectId: live.metadata.id, body: REQUEST_BODY, clientMutationId: intended.clientMutationId,
      }, 'addComment');
      live = await readLiveSnapshot(client, active);
      candidates = exactViewerRequestCandidates(live.comments, live.metadata.viewer, intended, excludedIds);
      if (candidates.length !== 1) throw new GitHubWorkflowError('Request mutation was not uniquely proven live', 'REQUEST_NOT_PROVEN');
    }
    const comment = candidates[0];
    active = await stateAdapter.checkpointReviewRequest({
      prNumber, expectedRevision: active.revision,
      request: {
        id: comment.id, databaseId: comment.databaseId ?? null, url: comment.url,
        headSha: active.currentIntegrationHeadSha, at: comment.createdAt, kind, body: REQUEST_BODY,
        authorLogin: comment.author.login, authorNodeId: comment.author.id,
      },
      pushedHeadSha: heads.pushedHeadSha, prHeadSha: live.metadata.headRefOid,
    });
    return { requested: true, recovered, request: active.reviewRequest };
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
    const preflightReplies = new Map();
    for (const entry of plan) {
      const { thread } = entry;
      const old = previousProof.get(thread.id);
      const recordedReply = old ? assertExistingThreadProof(active, live, entry, old) : null;
      preflightReplies.set(thread.id, recordedReply
        ? [recordedReply] : exactRepliesFor(active, live, entry).exact);
      if (thread.isResolved && !old?.isResolved) {
        const operationId = `resolve:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
        const intent = await lookupJournalIntent(journal, operationId);
        if (!intent || preflightReplies.get(thread.id).length !== 1) {
          throw new GitHubWorkflowError('Resolved thread lacks pre-existing exact recovery evidence', 'RESOLUTION_PROOF_MISSING');
        }
        priorResolveIntents.set(thread.id, intent);
      }
    }
    const evidence = new Map();
    for (const entry of plan) {
      const intent = priorResolveIntents.get(entry.thread.id);
      if (intent) evidence.set(entry.thread.id, {
        reply: preflightReplies.get(entry.thread.id)[0], resolvedAt: intent.at, resolvedBy: live.metadata.viewer.login,
      });
    }
    for (const entry of selectedPlan) {
      const { thread } = entry;
      const operationId = `reply:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
      live = await readLiveSnapshot(client, active);
      await assertMutationReady({ state: active, git }, live);
      let current = live.threads.find((item) => item.id === thread.id);
      const old = previousProof.get(thread.id);
      if (old?.isResolved) {
        assertExistingThreadProof(active, live, { ...entry, thread: current }, old);
        continue;
      }
      let replies = old?.replyId
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
        evidence.set(thread.id, { reply, resolvedAt: priorIntent.at, resolvedBy: live.metadata.viewer.login });
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
    const proof = buildThreadProof(active, live, evidence, clock.now());
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber, expectedRevision: active.revision, threadResolutionStatus: proof,
    });
    return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
  }

  async function collect(prNumber) {
    let active = await load(prNumber);
    if (!active.reviewRequest || active.reviewOutcome || active.reviewHistory.at(-1)?.outcome !== null) {
      throw new GitHubWorkflowError('No pending review request to collect', 'REVIEW_NOT_PENDING');
    }
    const live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest.id });
    try {
      assertRecordedRequestComment(active, live);
    } catch (error) {
      if (!(error instanceof GitHubWorkflowError) || error.code !== 'REQUEST_PROOF_STALE'
          || active.reviewRequest.kind !== 'verification') throw error;
      const changed = live.metadata.headRefOid !== active.reviewRequest.headSha;
      const ids = [
        `request:${active.reviewRequest.id}`,
        ...live.comments.filter((comment) => comment.id === active.reviewRequest.id)
          .map((comment) => `live-request:${comment.id}`),
      ];
      active = await stateAdapter.checkpointVerificationEscalation({
        prNumber, expectedRevision: active.revision,
        escalation: escalationFor(active, live.metadata.headRefOid, ids,
          changed ? 'request-head-drift' : 'ambiguous-canonical-evidence', clock.now()),
      });
      return { escalated: true, escalation: active.verificationEscalation };
    }
    if (live.metadata.headRefOid !== active.reviewRequest.headSha) {
      if (active.reviewRequest.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery request became stale at the live PR head', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const ids = [`request:${active.reviewRequest.id}`];
      active = await stateAdapter.checkpointVerificationEscalation({
        prNumber, expectedRevision: active.revision,
        escalation: escalationFor(active, live.metadata.headRefOid, ids, 'request-head-drift', clock.now()),
      });
      return { escalated: true, escalation: active.verificationEscalation };
    }
    const heads = await assertMutationReady({ state: active, git }, live);
    const request = active.reviewRequest;
    const canonicalReviews = live.reviews.filter((review) => isCanonicalActor(review.author)
      && evidenceAtOrAfter(review.submittedAt, request.at));
    const exactReviews = canonicalReviews.filter((review) => review.state === 'COMMENTED'
      && review.commit?.oid === request.headSha);
    const staleReviews = canonicalReviews.filter((review) => review.state === 'COMMENTED'
      && review.commit?.oid !== request.headSha);
    const unsupportedReviews = canonicalReviews.filter((review) => review.state !== 'COMMENTED');
    const exactReactions = live.reactions.filter((reaction) => reaction.content === 'THUMBS_UP'
      && isCanonicalActor(reaction.user) && evidenceAtOrAfter(reaction.createdAt, request.at));
    const unsupportedReactions = live.reactions.filter((reaction) => reaction.content === 'THUMBS_UP'
      && isCanonicalActor(reaction.user) && !evidenceAtOrAfter(reaction.createdAt, request.at));
    const cleanComments = await classifyCleanIssueComments({
      comments: live.comments, request, git, cwd: active.integrationWorktree,
      expectedHeads: [request.headSha, active.currentIntegrationHeadSha, heads.pushedHeadSha,
        live.metadata.headRefOid],
    });
    const evidence = [
      ...exactReviews.map((review) => ({ type: 'review', value: review })),
      ...exactReactions.map((reaction) => ({ type: 'reaction', value: reaction })),
      ...cleanComments.exact.map((item) => ({ type: 'issue-comment', value: item })),
    ];
    if (evidence.length !== 1 || staleReviews.length > 0
        || unsupportedReviews.length > 0 || unsupportedReactions.length > 0
        || cleanComments.unsupported.length > 0) {
      if (request.kind !== 'verification') {
        throw new GitHubWorkflowError('Discovery review evidence is stale or ambiguous', 'DISCOVERY_COLLECTION_UNRESOLVED');
      }
      const ids = [
        ...exactReviews.map((item) => canonicalEvidenceId(item, 'review')),
        ...staleReviews.map((item) => canonicalEvidenceId(item, 'review')),
        ...unsupportedReviews.map((item) => canonicalEvidenceId(item, 'review')),
        ...exactReactions.map((item) => canonicalEvidenceId(item, 'reaction')),
        ...unsupportedReactions.map((item) => canonicalEvidenceId(item, 'reaction')),
        ...cleanComments.exact.map((item) => canonicalEvidenceId(item.comment, 'issue-comment')),
        ...cleanComments.unsupported.map((item) => canonicalEvidenceId(item, 'issue-comment')),
      ];
      if (ids.length === 0) {
        throw new GitHubWorkflowError('Canonical review evidence is not available yet', 'REVIEW_NOT_AVAILABLE');
      }
      const reason = unsupportedReviews.length > 0 || unsupportedReactions.length > 0
        || cleanComments.unsupported.length > 0
        || evidence.length > 1 || (evidence.length === 1 && ids.length > 1)
        ? 'ambiguous-canonical-evidence' : 'stale-canonical-evidence';
      active = await stateAdapter.checkpointVerificationEscalation({
        prNumber, expectedRevision: active.revision,
        escalation: escalationFor(active, live.metadata.headRefOid, ids.length > 0 ? ids : [`request:${request.id}`], reason, clock.now()),
      });
      return { escalated: true, escalation: active.verificationEscalation };
    }
    const selected = evidence[0];
    let outcome;
    if (selected.type === 'reaction') {
      const reaction = selected.value;
      outcome = {
        id: reaction.id, databaseId: null, url: request.url,
        headSha: request.headSha, at: reaction.createdAt, requestId: request.id, kind: request.kind,
        outcome: 'clean', evidenceType: 'request-reaction',
        reviewerLogin: reaction.user.login, reviewerNodeId: reaction.user.id,
        reviewerType: reaction.user.__typename, reviewerUrl: reaction.user.url,
        reactionContent: 'THUMBS_UP', reactionCommentId: request.id,
      };
    } else if (selected.type === 'issue-comment') {
      const { comment, headSha } = selected.value;
      outcome = {
        id: comment.id, databaseId: comment.databaseId ?? null, url: comment.url,
        headSha, at: comment.createdAt, requestId: request.id, kind: request.kind,
        outcome: 'clean', evidenceType: 'issue-comment',
        reviewerLogin: comment.author.login, reviewerNodeId: comment.author.id,
        reviewerType: comment.author.__typename, reviewerUrl: comment.author.url,
        reactionContent: null, reactionCommentId: null,
      };
    } else {
      const review = selected.value;
      const findingCount = live.threads.filter((thread) => thread.canonical
        && thread.root.pullRequestReview?.id === review.id).length;
      outcome = {
        id: review.id, databaseId: review.databaseId ?? null, url: review.url,
        headSha: review.commit.oid, at: review.submittedAt, requestId: request.id, kind: request.kind,
        outcome: findingCount > 0 ? 'findings' : 'clean', evidenceType: 'review-submission',
        reviewerLogin: review.author.login, reviewerNodeId: review.author.id,
        reviewerType: review.author.__typename, reviewerUrl: review.author.url,
        reactionContent: null, reactionCommentId: null,
      };
    }
    active = await stateAdapter.checkpointReviewOutcome({
      prNumber, expectedRevision: active.revision, outcome,
    });
    return { escalated: false, outcome: active.reviewOutcome, phase: active.phase };
  }

  async function complete(prNumber) {
    let active = await load(prNumber);
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
          && isCanonicalActor(review.author) && evidenceAtOrAfter(review.submittedAt, state.reviewRequest.at));
      } else if (state.reviewOutcome.evidenceType === 'request-reaction') {
        outcomeIsLive = live.reactions.some((reaction) => reaction.id === state.reviewOutcome.id
          && reaction.content === 'THUMBS_UP' && isCanonicalActor(reaction.user)
          && evidenceAtOrAfter(reaction.createdAt, state.reviewRequest.at));
      } else {
        const classified = await classifyCleanIssueComments({
          comments: live.comments.filter((comment) => comment.id === state.reviewOutcome.id),
          request: state.reviewRequest, git, cwd: state.integrationWorktree,
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
    }

    let live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    let completionHeads = await assertMutationReady({ state: active, git }, live);
    await assertCompletionLiveEvidence(active, live, completionHeads);
    const snapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const evidence = ciEvidenceFromRollup(snapshot);
    if (evidence.status !== 'passed') {
      throw new GitHubWorkflowError('Full GitHub Actions validation did not pass', 'COMPLETION_NOT_READY');
    }
    active = await stateAdapter.checkpointCiValidation({
      prNumber: active.prNumber, expectedRevision: active.revision, evidence,
    });
    live = await readLiveSnapshot(client, active, { reactionsFor: active.reviewRequest?.id ?? null });
    const refreshedHeads = await assertMutationReady({ state: active, git }, live);
    completionHeads = refreshedHeads;
    await assertCompletionLiveEvidence(active, live, completionHeads);
    const finalCiSnapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, live.metadata.headRefOid,
    );
    const finalEvidence = ciEvidenceFromRollup(finalCiSnapshot);
    if (finalEvidence.status !== 'passed' || !sameCiEvidence(evidence, finalEvidence)) {
      throw new GitHubWorkflowError(
        'Full GitHub Actions validation changed before completion', 'COMPLETION_NOT_READY',
      );
    }
    active = await stateAdapter.checkpointCompletion({
      prNumber, expectedRevision: active.revision,
      pushedHeadSha: refreshedHeads.pushedHeadSha, prHeadSha: live.metadata.headRefOid,
    });
    return { completed: true, phase: active.phase, revision: active.revision };
  }

  return { status, refreshThreads, replyResolve, request, collect, collectCi, complete };
}

export const githubReviewConstants = {
  CANONICAL_LOGIN, CANONICAL_URL, REQUEST_BODY, PAGE_SIZE, FULL_VALIDATION_CHECK, GITHUB_ACTIONS_APP,
  FULL_VALIDATION_WORKFLOW, FULL_VALIDATION_WORKFLOW_PATH, CLEAN_ISSUE_COMMENT_TEMPLATE,
};
