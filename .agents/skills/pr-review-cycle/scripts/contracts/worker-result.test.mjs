import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateTaskPacket } from './task-packet.mjs';
import {
  validateWorkerResult,
  validateWorkerResultAgainstTask,
  workerResultDigest,
} from './worker-result.mjs';

function taskPacket(overrides = {}) {
  return {
    schemaVersion: 3,
    taskId: 'task-direct',
    reviewedHeadSha: 'a'.repeat(40),
    specialization: 'ops-workflow',
    riskTags: ['workflow'],
    finding: 'Finding.',
    evidence: 'Evidence.',
    affectedAreas: ['workflow'],
    decisionIds: ['decision-1'],
    allowedPaths: ['scripts/exact.mjs', 'scripts/tree/**'],
    forbiddenPaths: ['scripts/tree/private/**'],
    dependencies: [],
    acceptanceCriteria: ['Validated.'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Focused workflow coverage.' }],
      system: [],
    },
    ...overrides,
  };
}

function workerResult(overrides = {}) {
  return {
    schemaVersion: 3,
    taskId: 'task-direct',
    specialization: 'ops-workflow',
    status: 'implemented',
    commitSha: 'b'.repeat(40),
    changedPaths: ['scripts/exact.mjs'],
    validation: [{ command: 'npm run check:workflow', result: 'passed', summary: 'Passed.' }],
    resolutionSummary: 'Implemented.',
    residualRisks: [],
    unexpectedDependencies: [],
    ...overrides,
  };
}

test('direct worker-result validation preserves specialization and task compatibility', () => {
  const packet = taskPacket();
  const result = workerResult();
  assert.deepEqual(validateTaskPacket(packet), []);
  assert.deepEqual(validateWorkerResult(result), []);
  assert.deepEqual(validateWorkerResultAgainstTask(packet, result, result.changedPaths), []);

  assert.ok(validateWorkerResult({ ...result, specialization: 'unknown' }).some(
    (error) => error.includes('unknown specialist profile'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, specialization: 'api',
  }, result.changedPaths).some((error) => error.includes('specialization must equal')));
});

test('worker-result identity preserves golden bytes, key order, and content sensitivity', () => {
  const result = workerResult();
  assert.equal(workerResultDigest(result), '994892ccf9e6da112a760406a7a6e15510586e86a4ff808432f3ecd2443f785f');
  assert.equal(workerResultDigest(Object.fromEntries(Object.entries(result).reverse())), workerResultDigest(result));
  assert.notEqual(workerResultDigest(workerResult({ residualRisks: ['Residual risk.'] })), workerResultDigest(result));
  assert.notEqual(workerResultDigest(workerResult({ changedPaths: ['scripts/tree/file.mjs'] })), workerResultDigest(result));
  assert.throws(
    () => workerResultDigest({ ...result, status: 'unknown' }),
    /^Error: Invalid worker result: \$\.status is invalid$/u,
  );
});

test('worker-result matching preserves exact Git paths and recursive segment boundaries', () => {
  const packet = taskPacket();
  const exact = workerResult();
  assert.deepEqual(validateWorkerResultAgainstTask(packet, exact, ['scripts/exact.mjs']), []);

  const recursive = workerResult({ changedPaths: ['scripts/tree/file.mjs'] });
  assert.deepEqual(validateWorkerResultAgainstTask(packet, recursive, ['scripts/tree/file.mjs']), []);
  assert.ok(validateWorkerResultAgainstTask(packet, recursive, ['scripts/tree/other.mjs']).some(
    (error) => error.includes('exactly equal the actual Git commit diff'),
  ));

  for (const changedPath of ['scripts/exact.mjs/child', 'scripts/treeish/file.mjs']) {
    const outside = workerResult({ changedPaths: [changedPath] });
    assert.ok(validateWorkerResultAgainstTask(packet, outside, [changedPath]).some(
      (error) => error.includes(`outside allowedPaths: ${changedPath}`),
    ));
  }

  const forbiddenPath = 'scripts/tree/private/file.mjs';
  const forbidden = workerResult({ changedPaths: [forbiddenPath] });
  assert.ok(validateWorkerResultAgainstTask(packet, forbidden, [forbiddenPath]).some(
    (error) => error.includes(`is forbidden: ${forbiddenPath}`),
  ));
});
