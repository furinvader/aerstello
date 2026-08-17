import { createHash } from 'node:crypto';

import { parseChecklist } from './checklists.mjs';

const MAX_PAGES = 100;
const MAX_COMMENTS = 10_000;
const MIN_RATE_REMAINING = 10;

export class GithubSourceError extends Error {
  constructor(message, code = 'GITHUB_SOURCE_ERROR') {
    super(message); this.name = 'GithubSourceError'; this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u;

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(RFC3339_DATE_TIME);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59) return false;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function requiredString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new GithubSourceError(`${label} is missing`, 'GITHUB_DATA_INCOMPLETE');
  }
  return value;
}

function requiredTimestamp(value, label) {
  if (!isRfc3339DateTime(value)) {
    throw new GithubSourceError(`${label} must be an RFC3339 date-time`, 'GITHUB_DATA_INCOMPLETE');
  }
  return value;
}

function actor(raw) {
  if (typeof raw === 'string' && raw) return { login: raw, id: null, url: null, type: null };
  if (typeof raw?.login !== 'string' || !raw.login) {
    throw new GithubSourceError('GitHub actor identity is missing', 'GITHUB_DATA_INCOMPLETE');
  }
  return { login: raw.login, id: raw.id ?? raw.nodeId ?? null, url: raw.url ?? null,
    type: raw.__typename ?? raw.type ?? null };
}

function normalizedComment(raw) {
  const body = raw?.body;
  const bodyDigest = typeof body === 'string' ? `sha256:${sha256(body)}` : raw?.bodyDigest;
  if (typeof bodyDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(bodyDigest)) {
    throw new GithubSourceError('GitHub comment body or body digest is missing', 'GITHUB_DATA_INCOMPLETE');
  }
  const createdAt = requiredTimestamp(raw.createdAt, 'GitHub comment createdAt');
  return {
    id: requiredString(raw?.id ?? raw?.nodeId, 'GitHub comment identity'),
    databaseId: Number.isInteger(raw.databaseId) ? raw.databaseId : null,
    url: raw.url ?? null, author: actor(raw.author), bodyDigest,
    createdAt,
    updatedAt: requiredTimestamp(raw.updatedAt ?? raw.lastEditedAt ?? createdAt,
      'GitHub comment updatedAt'),
  };
}

function issueObject(raw) { return raw?.repository?.issue ?? raw?.issue ?? raw; }

function exactCountEvidence(nodes, evidence) {
  const counts = [];
  if (Object.hasOwn(evidence, 'commentsTotalCount')) counts.push(evidence.commentsTotalCount);
  if (Object.hasOwn(evidence, 'totalCount')) counts.push(evidence.totalCount);
  for (const count of counts) {
    if (!Number.isInteger(count) || count < 0 || count !== nodes.length) {
      throw new GithubSourceError('GitHub comment count evidence is inconsistent',
        'GITHUB_DATA_INCOMPLETE');
    }
  }
  return counts.length > 0;
}

/*
 * Normalized connector shape: `comments` is an authoritative-order array and
 * must be paired with `commentsComplete: true` or exact `commentsTotalCount`.
 * Raw connection data instead proves completion through a final pageInfo or an
 * exact totalCount. Canonical GraphQL pagination supplies its own proof.
 */
function completeComments(issue) {
  if (!Object.hasOwn(issue, 'comments')) {
    throw new GithubSourceError('GitHub comment completeness evidence is missing', 'GITHUB_DATA_INCOMPLETE');
  }
  if (Array.isArray(issue.comments)) {
    if (Object.hasOwn(issue, 'commentsComplete') && issue.commentsComplete !== true) {
      throw new GithubSourceError('GitHub connector reports incomplete comments',
        'GITHUB_DATA_INCOMPLETE');
    }
    const exactCount = exactCountEvidence(issue.comments, issue);
    if (issue.commentsComplete !== true && !exactCount) {
      throw new GithubSourceError('GitHub comment completeness evidence is missing',
        'GITHUB_DATA_INCOMPLETE');
    }
    return issue.comments;
  }
  const connection = issue.comments;
  if (!connection || !Array.isArray(connection.nodes)) {
    throw new GithubSourceError('GitHub comment completeness evidence is missing', 'GITHUB_DATA_INCOMPLETE');
  }
  const hasPageEvidence = typeof connection.pageInfo?.hasNextPage === 'boolean';
  const exactCount = exactCountEvidence(connection.nodes, connection);
  if (connection.pageInfo?.hasNextPage === true) {
    throw new GithubSourceError('GitHub connector returned an incomplete comments connection',
      'GITHUB_DATA_INCOMPLETE');
  }
  if (!hasPageEvidence && !exactCount) {
    throw new GithubSourceError('GitHub comment completeness evidence is missing',
      'GITHUB_DATA_INCOMPLETE');
  }
  return connection.nodes;
}

export function normalizeGithubIssue(raw, { repository, issueNumber, capturedAt } = {}) {
  const issue = issueObject(raw);
  if (!issue || typeof issue !== 'object') throw new GithubSourceError('GitHub issue was not found', 'ISSUE_NOT_FOUND');
  const number = Number(issue.number ?? issueNumber);
  if (!Number.isInteger(number) || number <= 0 || (issueNumber !== undefined && number !== Number(issueNumber))) {
    throw new GithubSourceError('GitHub issue number does not match', 'GITHUB_DATA_INCOMPLETE');
  }
  const commentsValue = completeComments(issue);
  // Connector/connection order is authoritative. Sorting opaque IDs would invent a
  // latest comment when GitHub timestamps have equal precision.
  const comments = commentsValue.map(normalizedComment);
  const ids = new Set();
  for (const comment of comments) {
    if (ids.has(comment.id)) throw new GithubSourceError('GitHub comment identity is duplicated', 'GITHUB_DATA_AMBIGUOUS');
    ids.add(comment.id);
  }
  const body = requiredString(issue.body, 'GitHub issue body', { allowEmpty: true });
  return {
    sourceType: 'github-issue', repository: requiredString(repository ?? raw.repositoryNameWithOwner, 'GitHub repository'),
    issueNumber: number, id: requiredString(issue.id ?? issue.nodeId, 'GitHub issue identity'),
    url: issue.url ?? null, title: requiredString(issue.title, 'GitHub issue title'), body,
    bodyDigest: `sha256:${sha256(body)}`, state: requiredString(issue.state, 'GitHub issue state').toLowerCase(),
    author: actor(issue.author), createdAt: requiredTimestamp(issue.createdAt, 'GitHub issue createdAt'),
    updatedAt: requiredTimestamp(issue.updatedAt, 'GitHub issue updatedAt'),
    capturedAt: requiredTimestamp(capturedAt, 'GitHub capture timestamp'), comments,
    latestCommentIdentity: comments.at(-1)?.id ?? null, checklist: parseChecklist(body),
  };
}

function graphqlIssue(page) {
  if (!page || typeof page !== 'object' || (page.errors?.length ?? 0) > 0 || !page.data) {
    throw new GithubSourceError('GitHub issue query returned errors or no data', 'GITHUB_READ_FAILED');
  }
  const rate = page.data.rateLimit;
  if (!rate || !Number.isFinite(rate.cost) || !Number.isFinite(rate.remaining)
      || rate.remaining < MIN_RATE_REMAINING) {
    throw new GithubSourceError('GitHub issue read did not prove a safe rate limit', 'GITHUB_RATE_LIMIT_UNSAFE');
  }
  const issue = page.data.repository?.issue;
  if (!issue) throw new GithubSourceError('GitHub issue was not found', 'ISSUE_NOT_FOUND');
  const connection = issue.comments;
  if (!connection || !Array.isArray(connection.nodes)
      || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    throw new GithubSourceError('GitHub comments connection was truncated', 'GITHUB_DATA_INCOMPLETE');
  }
  return { issue, connection };
}

function issuePageIdentity(issue) {
  return JSON.stringify({ id: issue.id, number: issue.number, url: issue.url, title: issue.title,
    body: issue.body, state: issue.state, author: issue.author, createdAt: issue.createdAt,
    updatedAt: issue.updatedAt });
}

export async function readGithubIssue({ repository, issueNumber, adapter, capturedAt }) {
  if (!adapter || (typeof adapter.readIssue !== 'function' && typeof adapter.readIssuePage !== 'function')) {
    throw new TypeError('GitHub source adapter must expose readIssue or readIssuePage');
  }
  if (typeof adapter.readIssue === 'function') {
    return normalizeGithubIssue(await adapter.readIssue({ repository, issueNumber }),
      { repository, issueNumber, capturedAt });
  }
  const comments = [];
  let cursor = null;
  let firstIssue = null;
  const seenCursors = new Set();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const { issue, connection } = graphqlIssue(await adapter.readIssuePage({ repository, issueNumber, cursor }));
    if (!firstIssue) firstIssue = issue;
    else if (issuePageIdentity(issue) !== issuePageIdentity(firstIssue)) {
      throw new GithubSourceError('GitHub issue changed during pagination', 'GITHUB_DATA_AMBIGUOUS');
    }
    comments.push(...connection.nodes);
    if (comments.length > MAX_COMMENTS) throw new GithubSourceError('GitHub issue exceeded the comment limit', 'GITHUB_PAGE_LIMIT');
    if (!connection.pageInfo.hasNextPage) {
      return normalizeGithubIssue({ ...firstIssue, comments, commentsComplete: true,
        commentsTotalCount: comments.length }, { repository, issueNumber, capturedAt });
    }
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || next.length === 0 || seenCursors.has(next)) {
      throw new GithubSourceError('GitHub comments cursor is missing or cyclic', 'GITHUB_CURSOR_INVALID');
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new GithubSourceError('GitHub issue exceeded the page limit', 'GITHUB_PAGE_LIMIT');
}

export const githubSourceLimits = Object.freeze({ maxPages: MAX_PAGES, maxComments: MAX_COMMENTS,
  minRateRemaining: MIN_RATE_REMAINING });
