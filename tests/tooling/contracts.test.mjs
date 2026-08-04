import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  validateTaskPacket,
  validateWorkerResult,
} from '../../scripts/lib/contracts.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

test('checked-in JSON contracts parse and declare Draft 2020-12', () => {
  const paths = [
    '.release/marker.schema.json',
    'docs/agents/pr-review-state.schema.json',
    'docs/agents/review-fix-task.schema.json',
    'docs/agents/review-fix-result.schema.json',
    '.codex/hooks.json',
  ];
  for (const path of paths) {
    const document = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (path.endsWith('.schema.json')) assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
  }
});

test('task packet validator accepts the documented contract', () => {
  const errors = validateTaskPacket({
    schemaVersion: 1,
    taskId: 'task-1',
    reviewedHeadSha: 'a'.repeat(40),
    finding: 'The mutation can overwrite newer state.',
    evidence: 'The route updates without checking the displayed version.',
    decisionIds: ['decision-1'],
    allowedPaths: ['apps/api/src/example.ts'],
    forbiddenPaths: ['apps/api/migrations/**'],
    dependencies: [],
    acceptanceCriteria: ['Reject stale versions.'],
    requiredValidation: ['npm test -w @sky-bar/api -- routes'],
  });
  assert.deepEqual(errors, []);
});

test('worker result validator rejects raw artifact fields', () => {
  const errors = validateWorkerResult({
    schemaVersion: 1,
    taskId: 'task-1',
    status: 'failed',
    commitSha: null,
    changedPaths: [],
    validation: [],
    resolutionSummary: 'The task failed.',
    residualRisks: [],
    unexpectedDependencies: [],
    rawLog: 'large output',
  });
  assert.ok(errors.some((error) => error.includes('rawLog')));
});

test('skill frontmatter has only name and description and no TODOs', () => {
  const skill = readFileSync(join(root, '.agents/skills/pr-review-cycle/SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  const keys = frontmatter.split('\n').map((line) => line.split(':', 1)[0]);
  assert.deepEqual(keys, ['name', 'description']);
  assert.doesNotMatch(skill, /TODO/u);
  assert.ok(skill.split('\n').length < 500);
});

test('custom agent required fields are declared at the TOML root', () => {
  const agentsDirectory = join(root, '.codex', 'agents');
  for (const fileName of readdirSync(agentsDirectory).filter((name) => name.endsWith('.toml'))) {
    const source = readFileSync(join(agentsDirectory, fileName), 'utf8');
    const firstTable = source.search(/^\s*\[/mu);
    const rootSource = firstTable === -1 ? source : source.slice(0, firstTable);
    for (const field of ['name', 'description', 'developer_instructions']) {
      assert.match(
        rootSource,
        new RegExp(`^${field}\\s*=`, 'mu'),
        `${fileName} must declare ${field} before its first TOML table`,
      );
    }
  }
});
