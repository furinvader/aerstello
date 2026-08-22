import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubWorkflowError } from './errors.mjs';
import { createGitHubReviewWorkflow } from './create-workflow.mjs';
import * as github from './github.mjs';
import {
  readPullRequestChecks,
  readPullRequestMetadata,
  readRequestReactions,
  readReviewThreads,
  readReviews,
  readThreadComments,
  readTopLevelComments,
} from './graphql/pull-request-reader.mjs';

const SUPPORTED_GITHUB_FACADE = Object.freeze([
  ['createGitHubReviewWorkflow', 'function'],
  ['GitHubWorkflowError', 'function'],
  ['githubReviewConstants', 'object'],
  ['readPullRequestChecks', 'function'],
  ['readPullRequestMetadata', 'function'],
  ['readRequestReactions', 'function'],
  ['readReviewThreads', 'function'],
  ['readReviews', 'function'],
  ['readThreadComments', 'function'],
  ['readTopLevelComments', 'function'],
]);

test('GitHub workflow façade retains the production importer-backed exports', () => {
  assert.deepEqual(Object.keys(github).sort(), SUPPORTED_GITHUB_FACADE.map(([name]) => name).sort());
  for (const [name, type] of SUPPORTED_GITHUB_FACADE) {
    assert.equal(typeof github[name], type, `${name} must remain available as a ${type}`);
  }
  assert.equal(github.GitHubWorkflowError, GitHubWorkflowError);
  assert.equal(github.createGitHubReviewWorkflow, createGitHubReviewWorkflow);
  assert.equal(github.readPullRequestChecks, readPullRequestChecks);
  assert.equal(github.readPullRequestMetadata, readPullRequestMetadata);
  assert.equal(github.readRequestReactions, readRequestReactions);
  assert.equal(github.readReviewThreads, readReviewThreads);
  assert.equal(github.readReviews, readReviews);
  assert.equal(github.readThreadComments, readThreadComments);
  assert.equal(github.readTopLevelComments, readTopLevelComments);
  assert.equal(Object.getPrototypeOf(github.GitHubWorkflowError.prototype), Error.prototype);
  assert.deepEqual(github.githubReviewConstants, {
    CANONICAL_LOGIN: 'chatgpt-codex-connector',
    CANONICAL_URL: 'https://github.com/apps/chatgpt-codex-connector',
    REQUEST_BODY: '@codex review',
    PAGE_SIZE: 50,
    FULL_VALIDATION_CHECK: 'Full validation',
    GITHUB_ACTIONS_APP: 'github-actions',
    FULL_VALIDATION_WORKFLOW: 'CI',
    FULL_VALIDATION_WORKFLOW_PATH: '.github/workflows/ci.yml',
  });
});
