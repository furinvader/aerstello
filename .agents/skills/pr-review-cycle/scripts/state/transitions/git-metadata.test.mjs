import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import { buildGitMetadataTransition } from './git-metadata.mjs';

test('Git metadata builder invalidates exact-HEAD evidence from an explicit snapshot', () => {
  const cwd = harness.repo();
  const state = harness.ready(harness.init(cwd));
  const git = { headSha: 'f'.repeat(40), branch: 'feature', detached: false, dirty: false };
  const next = buildGitMetadataTransition(state, git);
  assert.equal(next.currentIntegrationHeadSha, git.headSha);
  assert.equal(next.git, git);
  assert.equal(next.phase, 'recovering');
  assert.deepEqual(next.validationStatus, {
    source: 'orchestrator', scope: 'targeted', status: 'not-run',
    headSha: null, checks: [], updatedAt: null,
  });
  assert.equal(next.threadResolutionStatus.status, 'not-run');
});

test('Git metadata builder preserves the original object for equal evidence values', () => {
  const cwd = harness.repo();
  const state = harness.init(cwd);
  assert.equal(buildGitMetadataTransition(state, state.git), state);
});

test('Git metadata transition module performs no I/O or ambient clock work', () => {
  const source = readFileSync(new URL('./git-metadata.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock',
    'atomicWrite', 'process.', 'new Date']) assert.equal(source.includes(forbidden), false, forbidden);
});
