import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as github from './github.mjs';

const SUPPORTED_GITHUB_FACADE = Object.freeze([
  ['createGitHubReviewWorkflow', 'function'],
  ['GitHubWorkflowError', 'function'],
]);

test('GitHub workflow façade retains the production importer-backed exports', () => {
  for (const [name, type] of SUPPORTED_GITHUB_FACADE) {
    assert.equal(typeof github[name], type, `${name} must remain available as a ${type}`);
  }
  assert.equal(Object.getPrototypeOf(github.GitHubWorkflowError.prototype), Error.prototype);
});
