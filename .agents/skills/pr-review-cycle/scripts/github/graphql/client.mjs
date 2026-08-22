import { GitHubWorkflowError } from '../errors.mjs';
import { OPERATIONS } from './operations.mjs';

export const MAX_PAGES = 100;
export const MAX_NODES = 10_000;
export const MIN_GRAPHQL_REMAINING = 10;

export function assertGraphqlResult(result, operation) {
  if (!result || typeof result !== 'object' || (result.errors?.length ?? 0) > 0 || !result.data) {
    throw new GitHubWorkflowError(`${operation} returned GraphQL errors or no data`, 'GRAPHQL_READ_FAILED');
  }
  return result.data;
}

export async function execute(client, name, variables) {
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

export async function executeMutation(client, name, variables, payloadField) {
  const data = await execute(client, name, variables);
  if (data[payloadField]?.clientMutationId !== variables.clientMutationId) {
    throw new GitHubWorkflowError(`${name} lost clientMutationId correlation`, 'MUTATION_CORRELATION_FAILED');
  }
  return data[payloadField];
}

export async function paginate(client, name, variables, selectConnection) {
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
