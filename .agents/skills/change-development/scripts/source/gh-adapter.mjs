import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);
const ISSUE_QUERY = `query ChangeDevelopmentIssue($owner:String!,$repo:String!,$issue:Int!,$cursor:String){rateLimit{cost remaining} repository(owner:$owner,name:$repo){issue(number:$issue){id number url title body state createdAt updatedAt author{__typename login ... on Node{id} url} comments(first:100,after:$cursor){nodes{id databaseId url body createdAt updatedAt lastEditedAt author{__typename login ... on Node{id} url}} pageInfo{hasNextPage endCursor}}}}}`;

function splitRepository(repository) {
  const parts = String(repository ?? '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part || /[\0\r\n]/u.test(part))) throw new TypeError('repository must be owner/name');
  return { owner: parts[0], repo: parts[1] };
}

export function createGhGraphqlAdapter({ execFile = execFileAsync, ghPath = 'gh', env = process.env } = {}) {
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function');
  return { async readIssuePage({ repository, issueNumber, cursor = null }) {
    const { owner, repo } = splitRepository(repository);
    if (!Number.isInteger(Number(issueNumber)) || Number(issueNumber) <= 0) throw new TypeError('issueNumber must be a positive integer');
    const args = ['api', 'graphql', '-f', `query=${ISSUE_QUERY}`, '-F', `owner=${owner}`,
      '-F', `repo=${repo}`, '-F', `issue=${Number(issueNumber)}`];
    if (cursor !== null) args.push('-F', `cursor=${cursor}`);
    const result = await execFile(ghPath, args, { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
    const stdout = typeof result === 'string' ? result : result?.stdout;
    try { return JSON.parse(stdout); } catch (error) { throw new Error(`gh api graphql returned invalid JSON: ${error.message}`); }
  } };
}

export { ISSUE_QUERY };
