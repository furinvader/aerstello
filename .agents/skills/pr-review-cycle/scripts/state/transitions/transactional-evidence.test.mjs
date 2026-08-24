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

function invalidRepository(state) {
  return { ...state, repository: 'invalid' };
}

function assertCanonicalFailure(action, code, label) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof harness.StateError, true);
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(`^${label}:\\n- \\$\\.repository must be owner/name$`, 'u'));
    return true;
  });
}

test('packet binding, replanning, and worker acceptance are pure projections', () => {
  const cwd = harness.repo();
  const state = harness.integratedTasks(cwd, ['task-a']);
  const digest = 'a'.repeat(64);
  const bound = buildTaskPacketBindingTransition(state, 'task-a', digest);
  assert.equal(bound.tasks[0].taskPacketDigest, digest);
  assert.equal(buildTaskPacketBindingTransition(bound, 'task-a', digest), bound);

  const replanned = buildTaskPacketReplanTransition(bound, 'task-a');
  assert.equal(replanned.tasks[0].taskPacketDigest, undefined);
  assert.equal(replanned.validationStatus.status, 'not-run');

  const running = {
    ...state,
    tasks: [harness.task(state.currentIntegrationHeadSha, {
      id: 'task-a', status: 'running', integratedCommitSha: null, resolutionSummary: null,
    })],
  };
  const result = { commitSha: 'b'.repeat(40) };
  const accepted = buildWorkerResultTransition(running, {
    taskId: 'task-a', envelope: { resultDigest: 'c'.repeat(64) }, result,
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
  const notRun = {
    ...state,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run',
      headSha: null, checks: [], updatedAt: null,
    },
  };
  assert.equal(buildTargetedValidationResetTransition(notRun), notRun);
});

test('transactional evidence builders reject invalid complete proposed states', () => {
  const cwd = harness.repo();
  const integrated = harness.integratedTasks(cwd, ['task-a']);
  const digest = 'a'.repeat(64);
  const running = {
    ...integrated,
    tasks: [harness.task(integrated.currentIntegrationHeadSha, {
      id: 'task-a', status: 'running', integratedCommitSha: null, resolutionSummary: null,
    })],
  };
  assertCanonicalFailure(
    () => buildTaskPacketReplanTransition(invalidRepository(integrated), 'task-a'),
    'TASK_PACKET_REPLAN_NOT_ALLOWED',
    'Invalid task packet replan transition',
  );
  assertCanonicalFailure(
    () => buildTaskPacketBindingTransition(invalidRepository(integrated), 'task-a', digest),
    'TASK_PACKET_NOT_BOUND',
    'Invalid task packet binding transition',
  );
  assertCanonicalFailure(
    () => buildWorkerResultTransition(invalidRepository(running), {
      taskId: 'task-a',
      envelope: { resultDigest: 'c'.repeat(64) },
      result: { commitSha: 'b'.repeat(40) },
      validationSummaries: ['focused check: passed'],
    }),
    'INVALID_WORKER_RESULT',
    'Invalid worker result transition',
  );
  assertCanonicalFailure(
    () => buildTargetedValidationResetTransition(invalidRepository({
      ...integrated,
      validationStatus: {
        source: 'orchestrator', scope: 'targeted', status: 'failed',
        headSha: integrated.currentIntegrationHeadSha,
        checks: ['npm run check:workflow'], updatedAt: harness.AT,
      },
    })),
    'INVALID_TARGETED_VALIDATION_RESET',
    'Invalid targeted validation reset transition',
  );
});

test('transactional evidence module performs no I/O or ambient work', () => {
  const source = readFileSync(new URL('./transactional-evidence.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock', 'atomicWrite',
    'process.', 'new Date',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
