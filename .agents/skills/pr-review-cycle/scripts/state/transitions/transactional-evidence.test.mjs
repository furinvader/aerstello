import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  buildTargetedValidationResetTransition,
  buildTaskPacketBindingTransition,
  buildTaskPacketReplanTransition,
  buildWorkerResultTransition,
} from './transactional-evidence.mjs';

test('packet binding, replanning, and worker acceptance are pure projections', () => {
  const cwd = harness.repo();
  const state = harness.integratedTasks(cwd, ['task-a']);
  const digest = `sha256:${'a'.repeat(64)}`;
  const bound = buildTaskPacketBindingTransition(state, 'task-a', digest);
  assert.equal(bound.tasks[0].taskPacketDigest, digest);
  assert.equal(buildTaskPacketBindingTransition(bound, 'task-a', digest), bound);

  const replanned = buildTaskPacketReplanTransition(bound, 'task-a');
  assert.equal(replanned.tasks[0].taskPacketDigest, undefined);
  assert.equal(replanned.validationStatus.status, 'not-run');

  const result = { commitSha: 'b'.repeat(40) };
  const accepted = buildWorkerResultTransition(replanned, {
    taskId: 'task-a', envelope: { resultDigest: `sha256:${'c'.repeat(64)}` }, result,
    validationSummaries: ['focused check: passed'],
  });
  assert.equal(accepted.tasks[0].status, 'implemented');
  assert.equal(accepted.tasks[0].execution.workerCommitSha, result.commitSha);
});

test('targeted validation reset preserves ready recovery semantics', () => {
  const cwd = harness.repo();
  const state = harness.ready(harness.init(cwd));
  const passed = {
    ...state,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed',
      headSha: state.currentIntegrationHeadSha, checks: ['npm run check:workflow'],
      updatedAt: harness.AT,
    },
  };
  const reset = buildTargetedValidationResetTransition(passed);
  assert.equal(reset.phase, 'recovering');
  assert.equal(reset.validationStatus.status, 'not-run');
});

test('transactional evidence module performs no I/O or ambient work', () => {
  const source = readFileSync(new URL('./transactional-evidence.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock', 'atomicWrite',
    'process.', 'new Date',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
