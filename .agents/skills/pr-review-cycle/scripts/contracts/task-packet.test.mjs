import assert from 'node:assert/strict';
import { test } from 'node:test';

import { taskPacketDigest, validateTaskPacket } from './task-packet.mjs';

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

test('direct task-packet validation preserves canonical specialist compatibility', () => {
  const packet = taskPacket();
  assert.deepEqual(validateTaskPacket(packet), []);
  assert.deepEqual(packet, taskPacket());

  assert.ok(validateTaskPacket(taskPacket({ specialization: 'web' })).some(
    (error) => error.includes('incompatible with affected area workflow'),
  ));
  assert.ok(validateTaskPacket(taskPacket({ riskTags: ['offline'] })).some(
    (error) => error.includes('does not support risk tag offline'),
  ));
  assert.deepEqual(validateTaskPacket(taskPacket({
    specialization: 'data-integrity',
    affectedAreas: ['release'],
    riskTags: ['migration', 'release'],
    requiredValidation: {
      unit: [{ command: 'npm run check:release-state', reason: 'Focused release coverage.' }],
      system: [],
    },
  })), []);
});

test('schema-v3 task-packet identity preserves golden bytes and ordered content', () => {
  const packet = taskPacket();
  assert.equal(taskPacketDigest(packet), '58b701e105fbe87e428cbbe101d7cce2e492d64d9241ef25925a613cce103485');
  assert.equal(taskPacketDigest(Object.fromEntries(Object.entries(packet).reverse())), taskPacketDigest(packet));
  assert.notEqual(taskPacketDigest(taskPacket({ riskTags: ['workflow', 'deployment'] })), taskPacketDigest(packet));
  assert.notEqual(taskPacketDigest(taskPacket({ decisionIds: ['decision-2'] })), taskPacketDigest(packet));
  assert.notEqual(taskPacketDigest(taskPacket({
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Changed reason.' }],
      system: [],
    },
  })), taskPacketDigest(packet));
});

test('historical schema-v2 task-packet identity preserves golden bytes', () => {
  const historical = { schemaVersion: 2, taskId: 'legacy-task' };
  assert.equal(taskPacketDigest(historical), 'fbfdf4ceca15469e652367d819bbd8569cef2e9db3e5f4dc7dcf7bea0796b324');
  assert.equal(taskPacketDigest({ taskId: 'legacy-task', schemaVersion: 2 }), taskPacketDigest(historical));
  assert.notEqual(taskPacketDigest({ ...historical, taskId: 'other-task' }), taskPacketDigest(historical));
});
