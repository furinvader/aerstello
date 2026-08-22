import { GitHubWorkflowError } from '../errors.mjs';
import { MAX_NODES, MAX_PAGES, execute, paginate } from './client.mjs';

function splitRepository(repository) {
  const [owner, repo, extra] = String(repository ?? '').split('/');
  if (!owner || !repo || extra) throw new GitHubWorkflowError('State repository must be owner/name', 'INVALID_REPOSITORY');
  return { owner, repo };
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

export async function readLiveSnapshot(
  client,
  { repository, prNumber },
  { reactionsFor = null, isCanonicalActor } = {},
) {
  const metadata = await readPullRequestMetadata(client, repository, prNumber);
  const [comments, reviews, rawThreads, reactions] = await Promise.all([
    readTopLevelComments(client, repository, prNumber),
    readReviews(client, repository, prNumber),
    readReviewThreads(client, repository, prNumber),
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
