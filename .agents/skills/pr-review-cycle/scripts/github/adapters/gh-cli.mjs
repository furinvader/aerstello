import { execFileSync } from 'node:child_process';

import { GitHubWorkflowError } from '../errors.mjs';

export function buildGhGraphqlArgs(query, variables) {
  if (typeof query !== 'string') {
    throw new GitHubWorkflowError('GraphQL query must be a string', 'INVALID_GRAPHQL_VARIABLE');
  }
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      args.push('-f', `${key}=${value}`);
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      args.push('-F', `${key}=${value}`);
    } else {
      throw new GitHubWorkflowError(
        `GraphQL variable ${key} has an unsupported value`,
        'INVALID_GRAPHQL_VARIABLE',
      );
    }
  }
  return args;
}

export function createDefaultGitHubClient(exec = execFileSync) {
  return {
    async graphql({ query, variables }) {
      const args = buildGhGraphqlArgs(query, variables);
      return JSON.parse(exec('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    },
  };
}
