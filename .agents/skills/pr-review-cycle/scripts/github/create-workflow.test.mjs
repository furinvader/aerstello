import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { GitHubWorkflowError } from './errors.mjs';
import { createGitHubReviewWorkflow } from './create-workflow.mjs';

const METHOD_NAMES = [
  'status', 'refreshThreads', 'replyResolve', 'verifyResolve', 'request',
  'collect', 'collectCi', 'complete', 'advance',
];

const METHOD_ARITIES = {
  status: 1,
  refreshThreads: 1,
  replyResolve: 2,
  verifyResolve: 2,
  request: 2,
  collect: 1,
  collectCi: 1,
  complete: 1,
  advance: 1,
};

test('workflow composition exposes exactly nine bound methods in stable order', () => {
  const api = createGitHubReviewWorkflow({
    client: { async graphql() { throw new Error('unused'); } },
    state: { async load() { throw new Error('unused'); } },
    git: {},
    clock: { now: () => '2026-08-22T00:00:00.000Z' },
    journal: {},
    archiveStore: {},
  });
  assert.deepEqual(Object.keys(api), METHOD_NAMES);
  for (const method of METHOD_NAMES) {
    assert.equal(typeof api[method], 'function', method);
    assert.equal(api[method].length, METHOD_ARITIES[method], `${method} arity`);
  }
});

test('workflow composition creates one context and injects the same bound operations into advance', () => {
  const source = readFileSync(new URL('./create-workflow.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/createWorkflowContext\(adapters\)/gu)?.length, 1);
  assert.equal(source.match(/createCollectUseCase\(context\)/gu)?.length, 1);
  assert.equal(source.match(/createCollectCiUseCase\(context\)/gu)?.length, 1);
  assert.equal(source.match(/createCompletionUseCases\(context\)/gu)?.length, 1);
  assert.match(source, /const \{ complete \} = completion;/u);
  assert.match(source, /createAdvanceUseCase\(context, \{\s*collect,\s*collectCi,\s*complete,\s*assertFindingsLiveEvidence: completion\.assertFindingsLiveEvidence,\s*revalidateCompletedState: completion\.revalidateCompletedState,\s*\}\)/u);
});

test('workflow composition validates one shared explicit adapter context', () => {
  assert.throws(() => createGitHubReviewWorkflow({}), (error) => (
    error instanceof GitHubWorkflowError
    && error.code === 'INVALID_ADAPTERS'
    && error.message === 'Client, state, Git, and clock adapters are required'
  ));
});
