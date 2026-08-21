import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unionRequiredValidation } from './task-packet-union.mjs';

function packet(overrides = {}) {
  return {
    schemaVersion: 3,
    taskId: 'task-1',
    reviewedHeadSha: 'a'.repeat(40),
    specialization: 'ops-workflow',
    riskTags: ['workflow'],
    finding: 'Finding.',
    evidence: 'Evidence.',
    affectedAreas: ['workflow'],
    decisionIds: [],
    allowedPaths: ['scripts/**'],
    forbiddenPaths: [],
    dependencies: [],
    acceptanceCriteria: ['Validated.'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers tooling.' }],
      system: [],
    },
    ...overrides,
  };
}

test('de-duplicates commands deterministically and preserves the first reason', () => {
  const first = packet();
  const second = packet({
    taskId: 'task-2',
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Different reason.' }],
      system: [],
    },
  });

  assert.deepEqual(unionRequiredValidation([first, second]), first.requiredValidation);
});

test('rejects conflicting command scopes', () => {
  assert.throws(() => unionRequiredValidation([
    packet(),
    packet({
      taskId: 'task-2',
      requiredValidation: {
        unit: [],
        system: [{
          command: 'npm run check:workflow', reason: 'Wrong scope.', selectors: [], projects: [],
        }],
      },
    }),
  ]), {
    name: 'TypeError',
    message: 'Conflicting validation scope for command: npm run check:workflow',
  });
});

test('adds integrated checks for affected areas in canonical order', () => {
  const focused = packet({
    specialization: 'data-integrity',
    riskTags: ['migration'],
    affectedAreas: ['shared', 'migration', 'documentation'],
    requiredValidation: {
      unit: [{
        command: 'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs',
        reason: 'Focused contract tests.',
      }],
      system: [],
    },
  });

  assert.deepEqual(unionRequiredValidation([focused]), {
    unit: [
      focused.requiredValidation.unit[0],
      { command: 'npm run check:shared', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:api', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:web', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: migration.' },
      { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: migration.' },
    ],
    system: [],
  });
});

test('reports array and packet validation failures with existing ordering and text', () => {
  assert.throws(() => unionRequiredValidation(null), {
    name: 'TypeError', message: 'taskPackets must be an array',
  });
  assert.throws(() => unionRequiredValidation([
    packet(),
    packet({ schemaVersion: 2, taskId: '' }),
    packet({ taskId: 'later-invalid', reviewedHeadSha: 'invalid' }),
  ]), {
    name: 'TypeError',
    message: 'Invalid task packet 1: $.schemaVersion must equal 3; $.taskId must be 1-128 characters',
  });
});

test('returns cloned validation entries and metadata arrays', () => {
  const source = packet({
    affectedAreas: ['documentation'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Unit.' }],
      system: [{ command: 'npm run check:web', reason: 'System.', selectors: [], projects: [] }],
    },
  });
  const result = unionRequiredValidation([source]);

  assert.deepEqual(result, source.requiredValidation);
  assert.notStrictEqual(result.unit[0], source.requiredValidation.unit[0]);
  assert.notStrictEqual(result.system[0], source.requiredValidation.system[0]);
  assert.notStrictEqual(result.system[0].selectors, source.requiredValidation.system[0].selectors);
  assert.notStrictEqual(result.system[0].projects, source.requiredValidation.system[0].projects);
});
