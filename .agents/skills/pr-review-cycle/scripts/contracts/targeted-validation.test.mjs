import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getKnownE2ESelectors,
  materializeTargetedValidationArgv,
  normalizeSelector,
  parseRelatedE2ECommand,
  parseTargetedValidationCommand,
  unionInitialValidationSelection,
  unionValidationSelections,
  validateAffectedAreas,
  validateInitialValidationSelection,
  validateRequiredValidation,
} from './targeted-validation.mjs';

const featureRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..', 'specs', 'features');
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

test('targeted command parsing accepts direct focused commands and rejects wrappers and shell syntax', () => {
  for (const command of [
    'git diff --check',
    'npm run check:workflow',
    'npm test -w @aerstello/api -- routes',
    'npm run test --workspace=@aerstello/web -- tests/example.test.ts',
    'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs',
  ]) assert.deepEqual(parseTargetedValidationCommand(command), command.split(' '), command);

  for (const command of [
    'git diff',
    'git diff --check HEAD',
    'git diff HEAD --check',
    'git diff --check -- .agents',
    'git diff --cached --check',
    'git diff --staged --check',
    'git status --check',
    'env git diff --check',
    'CI=1 git diff --check',
    'git diff --check && git status',
    'npm run check:full',
    'env CI=1 npm run check:workflow',
    'npm run check:workflow && npm run check:api',
    'node --test .agents/skills/pr-review-cycle/scripts/contracts',
    'npm test -w @aerstello/api -w @aerstello/web -- routes',
  ]) assert.equal(parseTargetedValidationCommand(command), null, command);
});

test('diff validation execution materializes only the canonical exact range', () => {
  const bare = ['git', 'diff', '--check'];
  const legacyRanged = ['git', 'diff', '--check', BASE_SHA, HEAD_SHA, '--'];
  const ranged = ['git', '--no-replace-objects', 'diff', '--check', BASE_SHA, HEAD_SHA, '--'];
  assert.deepEqual(materializeTargetedValidationArgv('git diff --check', bare, {
    baseSha: BASE_SHA, headSha: HEAD_SHA,
  }), ranged);
  assert.deepEqual(materializeTargetedValidationArgv('git diff --check', legacyRanged, {
    baseSha: BASE_SHA, headSha: HEAD_SHA,
  }), ranged);
  assert.deepEqual(materializeTargetedValidationArgv('git diff --check', ranged, {
    baseSha: BASE_SHA, headSha: HEAD_SHA,
  }), ranged);
  assert.equal(materializeTargetedValidationArgv('git diff --check', [
    'git', 'diff', '--check', HEAD_SHA, BASE_SHA, '--',
  ], { baseSha: BASE_SHA, headSha: HEAD_SHA }), null);
  for (const argv of [
    ['git', 'diff', '--no-replace-objects', '--check', BASE_SHA, HEAD_SHA, '--'],
    ['git', '--no-replace-objects', 'diff', '--check', BASE_SHA, HEAD_SHA],
    ['git', '--no-replace-objects', 'diff', '--check', BASE_SHA, HEAD_SHA, '--', 'extra'],
  ]) assert.equal(materializeTargetedValidationArgv(
    'git diff --check', argv, { baseSha: BASE_SHA, headSha: HEAD_SHA },
  ), null);
  assert.equal(materializeTargetedValidationArgv('git diff --check', bare, {
    baseSha: 'not-a-sha', headSha: HEAD_SHA,
  }), null);
  assert.deepEqual(materializeTargetedValidationArgv(
    'npm run check:workflow', ['npm', 'run', 'check:workflow'], {
      baseSha: BASE_SHA, headSha: HEAD_SHA,
    },
  ), ['npm', 'run', 'check:workflow']);
});

test('related E2E parsing preserves selector normalization, defaults, order, and discovery caching', () => {
  assert.equal(normalizeSelector('@area-security'), 'area-security');
  assert.equal(normalizeSelector('approved-request', '--id'), 'id-approved-request');
  assert.equal(normalizeSelector('Bad Selector'), null);
  assert.deepEqual(parseRelatedE2ECommand(
    'npm run test:e2e:related -- --id approved-request --tag area-security',
  ), {
    selectors: ['id-approved-request', 'area-security'], projects: ['tablet-chromium'],
  });
  assert.deepEqual(parseRelatedE2ECommand(
    'npm run test:e2e:related -- --tag area-security --project mobile-webkit --project desktop-firefox',
  ), {
    selectors: ['area-security'], projects: ['mobile-webkit', 'desktop-firefox'],
  });
  assert.equal(parseRelatedE2ECommand('npm run test:e2e:related -- --project mobile-webkit'), null);

  const selectors = getKnownE2ESelectors(featureRoot);
  assert.equal(selectors, getKnownE2ESelectors());
  assert.equal(selectors.has('area-security'), true);
});

test('validation metadata preserves exact selectors, projects, and conflict errors', () => {
  const command = 'npm run test:e2e:related -- --tag area-security --project mobile-webkit';
  const valid = {
    unit: [{ command: 'npm run check:workflow', reason: 'Focused workflow check.' }],
    system: [{
      command, reason: 'Focused security flow.', selectors: ['area-security'], projects: ['mobile-webkit'],
    }],
  };
  const errors = [];
  validateRequiredValidation(valid, '$.requiredValidation', errors);
  assert.deepEqual(errors, []);

  const mismatched = structuredClone(valid);
  mismatched.system[0].projects = ['tablet-chromium'];
  validateRequiredValidation(mismatched, '$.requiredValidation', errors);
  assert.deepEqual(errors, [
    '$.requiredValidation.system[0].projects must exactly match the command\'s effective --project scope',
  ]);

  const areaErrors = [];
  validateAffectedAreas(['workflow', 'unknown'], '$.affectedAreas', areaErrors);
  assert.deepEqual(areaErrors, ['$.affectedAreas must contain only recognized code or policy areas']);
});

test('initial selections retain exact shape validation and integrated area defaults', () => {
  const selection = {
    schemaVersion: 1,
    headSha: 'a'.repeat(40),
    affectedAreas: ['workflow'],
    requiredValidation: {
      unit: [{ command: 'node --test scripts/example.test.mjs', reason: 'Focused behavior.' }],
      system: [],
    },
  };
  assert.deepEqual(validateInitialValidationSelection(selection), []);
  assert.deepEqual(unionInitialValidationSelection({
    affectedAreas: selection.affectedAreas,
    requiredValidation: selection.requiredValidation,
  }), {
    unit: [
      selection.requiredValidation.unit[0],
      { command: 'npm run check:workflow', reason: 'Orchestrator integrated check for affected area: workflow.' },
    ],
    system: [],
  });
  assert.ok(validateInitialValidationSelection({ ...selection, headSha: 'bad' }).includes(
    '$.headSha must be a full Git SHA',
  ));
  assert.throws(() => unionInitialValidationSelection({
    affectedAreas: selection.affectedAreas,
    requiredValidation: selection.requiredValidation,
    specialization: 'ops-workflow',
  }), /\$\.specialization is not supported/u);
});

test('validation unions preserve declaration and area order, first reasons, cloning, and conflicts', () => {
  const first = {
    affectedAreas: ['shared', 'documentation'],
    requiredValidation: {
      unit: [{ command: 'npm run check:api', reason: 'First reason.' }],
      system: [],
    },
  };
  const second = {
    affectedAreas: ['migration'],
    requiredValidation: {
      unit: [{ command: 'npm run check:api', reason: 'Ignored later reason.' }],
      system: [{
        command: 'npm run check:workflow', reason: 'System reason.', selectors: [], projects: [],
      }],
    },
  };
  const original = structuredClone([first, second]);
  assert.deepEqual(unionValidationSelections([first, second]), {
    unit: [
      { command: 'npm run check:api', reason: 'First reason.' },
      { command: 'npm run check:shared', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:web', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: migration.' },
      { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: migration.' },
    ],
    system: [{
      command: 'npm run check:workflow', reason: 'System reason.', selectors: [], projects: [],
    }],
  });
  assert.deepEqual([first, second], original);

  assert.throws(() => unionValidationSelections([first, {
    affectedAreas: [], requiredValidation: {
      unit: [],
      system: [{ command: 'npm run check:api', reason: 'Conflict.', selectors: [], projects: [] }],
    },
  }]), /Conflicting validation scope for command: npm run check:api/u);
});
