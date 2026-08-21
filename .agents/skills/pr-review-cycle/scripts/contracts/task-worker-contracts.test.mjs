import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  parseTargetedValidationCommand,
  unionInitialValidationSelection,
  unionRequiredValidation,
  validateInitialValidationSelection,
  validateTaskPacket,
  validateWorkerResult,
  validateWorkerResultAgainstTask,
} from './contracts.mjs';
import { taskPacketDigest } from '../state/state.mjs';
import { reviewFixResultSchemaPath, reviewFixTaskSchemaPath } from '../paths.mjs';

test('initial validation selections require an exact head and nonempty targeted union', () => {
  const selection = {
    schemaVersion: 1,
    headSha: 'a'.repeat(40),
    affectedAreas: ['workflow'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Initial workflow scope.' }],
      system: [],
    },
  };
  assert.deepEqual(validateInitialValidationSelection(selection), []);
  for (const invalid of [
    { ...selection, headSha: 'bad' },
    { ...selection, affectedAreas: [] },
    { ...selection, requiredValidation: { unit: [], system: [] } },
    { ...selection, extra: true },
  ]) assert.notDeepEqual(validateInitialValidationSelection(invalid), []);
});

test('initial taskless validation union adds area checks without packet metadata', () => {
  const selection = {
    affectedAreas: ['shared', 'documentation'],
    requiredValidation: {
      unit: [
        { command: 'npm run check:api', reason: 'Explicit API consumer coverage.' },
        { command: 'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs', reason: 'Focused contracts.' },
      ],
      system: [],
    },
  };
  const original = structuredClone(selection);
  assert.deepEqual(unionInitialValidationSelection(selection), {
    unit: [
      ...selection.requiredValidation.unit,
      { command: 'npm run check:shared', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:web', reason: 'Orchestrator integrated check for affected area: shared.' },
    ],
    system: [],
  });
  assert.deepEqual(selection, original);
  assert.throws(() => unionInitialValidationSelection({
    ...selection, specialization: 'contracts',
  }), /specialization is not supported/u);
});

test('task packet validator accepts the documented contract', () => {
  const packet = {
    schemaVersion: 3,
    taskId: 'task-1',
    reviewedHeadSha: 'a'.repeat(40),
    specialization: 'api',
    riskTags: ['authorization'],
    finding: 'The mutation can overwrite newer state.',
    evidence: 'The route updates without checking the displayed version.',
    affectedAreas: ['api'],
    decisionIds: ['decision-1'],
    allowedPaths: ['apps/api/src/example.ts'],
    forbiddenPaths: ['apps/api/migrations/**'],
    dependencies: [],
    acceptanceCriteria: ['Reject stale versions.'],
    requiredValidation: {
      unit: [{ command: 'npm test -w @aerstello/api -- routes', reason: 'Covers stale route versions.' }],
      system: [{
        command: 'npm run test:e2e:related -- --id id-an-approved-request-token-grants-exactly-one-device --project tablet-chromium',
        reason: 'Covers the visible stale-version flow.',
        selectors: ['id-an-approved-request-token-grants-exactly-one-device'], projects: ['tablet-chromium'],
      }],
    },
  };
  const schema = JSON.parse(readFileSync(reviewFixTaskSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const errors = validateTaskPacket(packet);
  assert.deepEqual(errors, []);
  assert.equal(validateSchema(packet), true, JSON.stringify(validateSchema.errors));
  assert.ok(validateTaskPacket({
    ...packet,
    requiredValidation: {
      ...packet.requiredValidation,
      system: [{ ...packet.requiredValidation.system[0], projects: [] }],
    },
  }).some((error) => error.includes('both be empty or both be nonempty')));
});

test('task packet specialization and risks are registry-validated without expanding authority', () => {
  const packet = {
    schemaVersion: 3, taskId: 'task-specialized', reviewedHeadSha: 'a'.repeat(40),
    specialization: 'web', riskTags: [], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['web'], decisionIds: [], allowedPaths: ['apps/web/src/example.ts'], forbiddenPaths: [],
    dependencies: [], acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:web', reason: 'Covers the affected web area.' }], system: [],
    },
  };
  const original = structuredClone(packet);
  assert.deepEqual(validateTaskPacket(packet), []);
  assert.deepEqual(packet, original);
  const { specialization: _specialization, ...withoutSpecialization } = packet;
  const { riskTags: _riskTags, ...withoutRiskTags } = packet;
  assert.ok(validateTaskPacket(withoutSpecialization).some((error) => error.includes('specialization is required')));
  assert.ok(validateTaskPacket(withoutRiskTags).some((error) => error.includes('riskTags is required')));

  const schema = JSON.parse(readFileSync(reviewFixTaskSchemaPath, 'utf8'));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateSchema(packet), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateSchema({ ...packet, riskTags: ['offline', 'offline'] }), false);
  assert.equal(validateSchema({ ...packet, specialization: 'unknown' }), false);
  assert.equal(validateSchema({ ...packet, riskTags: ['unknown'] }), false);

  for (const specialization of [null, 1, true, {}, [], '', 'x'.repeat(129)]) {
    const invalid = { ...packet, specialization };
    const shapeErrors = validateTaskPacket(invalid).filter(
      (error) => error === '$.specialization must be a 1-128 character specialist profile ID',
    );
    assert.deepEqual(shapeErrors, [
      '$.specialization must be a 1-128 character specialist profile ID',
    ]);
    assert.equal(validateSchema(invalid), false, JSON.stringify(specialization));
  }

  for (const [change, expected] of [
    [{ specialization: 'unknown' }, /unknown|specialization|profile/iu],
    [{ riskTags: ['unknown'] }, /unknown|risk/iu],
    [{ riskTags: ['offline', 'offline'] }, /duplicate/iu],
    [{ specialization: 'web', affectedAreas: ['api'] }, /compatible|affected|profile|specialization/iu],
    [{ specialization: 'web', riskTags: ['migration'] }, /support|risk|profile|specialization/iu],
  ]) {
    assert.ok(validateTaskPacket({ ...packet, ...change }).some((error) => expected.test(error)));
  }
});

test('specialization and ordered risk tags are binding packet identity', () => {
  const packet = {
    schemaVersion: 3, taskId: 'task-identity', reviewedHeadSha: 'a'.repeat(40),
    specialization: 'data-integrity', riskTags: ['migration', 'release'], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['release'], decisionIds: [], allowedPaths: ['.release/markers/example.json'], forbiddenPaths: [],
    dependencies: [], acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:release-state', reason: 'Covers release metadata.' }], system: [],
    },
  };
  assert.notEqual(taskPacketDigest(packet), taskPacketDigest({ ...packet, specialization: 'ops-workflow' }));
  assert.notEqual(taskPacketDigest(packet), taskPacketDigest({ ...packet, riskTags: ['release', 'migration'] }));
  assert.notEqual(taskPacketDigest(packet), taskPacketDigest({ ...packet, riskTags: ['migration'] }));
  const reordered = Object.fromEntries(Object.entries(packet).reverse());
  assert.equal(taskPacketDigest(packet), taskPacketDigest(reordered));
});

test('task packets reject unsafe ownership and inexact or broad system validation scopes', () => {
  const packet = {
    schemaVersion: 3, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40),
    specialization: 'ops-workflow', riskTags: ['workflow'], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: ['scripts/private/**'],
    dependencies: [], acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [], system: [{
        command: 'npm run check:workflow', reason: 'Focused workflow check.', selectors: [], projects: [],
      }],
    },
  };
  assert.deepEqual(validateTaskPacket(packet), []);
  for (const command of ['npm run check', 'npm run check:full', 'npm run test:e2e', 'npm run test:e2e:full']) {
    assert.ok(validateTaskPacket({
      ...packet, requiredValidation: { unit: [], system: [{ command, reason: 'Too broad.', selectors: [], projects: [] }] },
    }).some((error) => error.includes('allowed direct targeted command')), command);
  }

  for (const command of [
    'env CI=1 npm run check:workflow',
    'npm --silent run check:workflow',
    'bash -lc npm run check:workflow',
    'npm run check:workflow && npm run check:api',
    'npm run check:workflow > result.txt',
    'npm run check:workflow $(touch unsafe)',
    'node --test #',
    'node --test ~',
    'node --test .agents/skills/pr-review-cycle/scripts',
    'npm test -w @aerstello/api -- #',
    'npm test -w @aerstello/api -- routes\t--watch',
    'npm test -w @aerstello/api -w @aerstello/web -- routes',
  ]) {
    assert.equal(parseTargetedValidationCommand(command), null, command);
    assert.ok(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Bypass attempt.' }], system: [] },
    }).some((error) => error.includes('allowed direct targeted command')), command);
  }
  for (const affectedAreas of [['other'], ['documentation', 'ap1']]) {
    const invalid = { ...packet, affectedAreas };
    assert.ok(validateTaskPacket(invalid).some(
      (error) => error.includes('only recognized code or policy areas'),
    ));
    const schema = JSON.parse(readFileSync(reviewFixTaskSchemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    assert.equal(ajv.compile(schema)(invalid), false);
  }
  for (const command of [
    'npm test -w @aerstello/api -- routes',
    'npm run test --workspace=@aerstello/web -- tests/example.test.ts',
    'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs',
    'npm run test:pr-review',
  ]) {
    assert.deepEqual(parseTargetedValidationCommand(command), command.split(' '), command);
    assert.deepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Focused test.' }], system: [] },
    }), [], command);
  }
  for (const command of ['npm run check:full', 'npm run test:e2e:related -- --tag area-security']) {
    if (command === 'npm run check:full') assert.equal(parseTargetedValidationCommand(command), null);
    assert.notDeepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Wrong local scope.' }], system: [] },
    }), [], command);
  }
  for (const allowedPaths of [['../scripts/**'], ['/scripts/**'], ['scripts/*/file.mjs']]) {
    assert.ok(validateTaskPacket({ ...packet, allowedPaths }).some((error) => error.includes('safe repository-relative')));
  }

  const command = 'npm run test:e2e:related -- --tag area-security --project mobile-webkit';
  const e2e = { command, reason: 'Focused security flow.', selectors: ['area-security'], projects: ['mobile-webkit'] };
  assert.deepEqual(validateTaskPacket({
    ...packet, requiredValidation: { unit: [], system: [e2e] },
  }), []);
  for (const entry of [
    { ...e2e, selectors: [] },
    { ...e2e, selectors: ['area-auth'] },
    { ...e2e, selectors: ['area-does-not-exist'] },
    { ...e2e, projects: ['tablet-chromium'] },
    { ...e2e, projects: ['chromium'] },
    { ...e2e, command: 'npm run test:e2e:related -- --project mobile-webkit' },
  ]) {
    assert.notDeepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [], system: [entry] },
    }), []);
  }
});

test('worker result validator rejects raw artifact fields', () => {
  const result = {
    schemaVersion: 3,
    taskId: 'task-1',
    specialization: 'ops-workflow',
    status: 'failed',
    commitSha: null,
    changedPaths: [],
    validation: [],
    resolutionSummary: 'The task failed.',
    residualRisks: [],
    unexpectedDependencies: [],
    rawLog: 'large output',
  };
  const errors = validateWorkerResult(result);
  assert.ok(errors.some((error) => error.includes('rawLog')));
  const schema = JSON.parse(readFileSync(reviewFixResultSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(validateSchema(result), false);
});

test('worker result schema requires only the specialization echo, not risk tags', () => {
  const result = {
    schemaVersion: 3, taskId: 'task-1', specialization: 'ops-workflow', status: 'failed', commitSha: null,
    changedPaths: [], validation: [], resolutionSummary: 'The task failed.', residualRisks: [],
    unexpectedDependencies: [],
  };
  assert.deepEqual(validateWorkerResult(result), []);
  const schema = JSON.parse(readFileSync(reviewFixResultSchemaPath, 'utf8'));
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validateSchema(result), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateSchema({ ...result, riskTags: [] }), false);
  assert.equal(validateSchema({ ...result, specialization: 'unknown' }), false);
  assert.ok(validateWorkerResult({ ...result, specialization: 'unknown' }).some(
    (error) => error.includes('unknown specialist profile'),
  ));
});

test('worker result enforces exact commands and status-aware validation outcomes', () => {
  const packet = {
    schemaVersion: 3, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40),
    specialization: 'ops-workflow', riskTags: ['workflow'], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers workflow tooling.' }], system: [],
    },
  };
  const result = {
    schemaVersion: 3, taskId: 'task-1', specialization: 'ops-workflow', status: 'implemented',
    commitSha: 'b'.repeat(40), changedPaths: ['scripts/a.mjs'],
    validation: [{ command: 'npm run check:workflow', result: 'passed', summary: 'Passed.' }],
    resolutionSummary: 'Implemented.', residualRisks: [], unexpectedDependencies: [],
  };
  assert.deepEqual(validateWorkerResultAgainstTask(packet, result, ['scripts/a.mjs']), []);
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, specialization: 'api',
  }, ['scripts/a.mjs']).some((error) => error.includes('specialization must equal')));
  assert.ok(validateWorkerResultAgainstTask(packet, result).some(
    (error) => error.includes('requires actual Git changed paths'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, result, []).some(
    (error) => error.includes('at least one changed path'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, result, ['scripts/other.mjs']).some(
    (error) => error.includes('exactly equal'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, changedPaths: ['scripts/a.mjs', 'scripts/a.mjs'],
  }, ['scripts/a.mjs']).some((error) => error.includes('must not contain duplicates')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result,
    validation: [...result.validation, { command: 'npm run check:full', result: 'passed', summary: 'Too broad.' }],
  }, ['scripts/a.mjs']).some((error) => error.includes('undeclared command')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, validation: [{ ...result.validation[0], result: 'skipped' }],
  }, ['scripts/a.mjs']).some((error) => error.includes('did not pass')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, validation: [],
  }, ['scripts/a.mjs']).some((error) => error.includes('was not reported')));
  for (const status of ['blocked', 'failed', 'not-applicable']) {
    for (const outcome of ['passed', 'failed', 'skipped']) {
      const terminalResult = {
        ...result,
        status,
        commitSha: null,
        changedPaths: [],
        validation: [{ ...result.validation[0], result: outcome }],
      };
      assert.deepEqual(validateWorkerResultAgainstTask(packet, terminalResult), []);
    }
    assert.ok(validateWorkerResultAgainstTask(packet, {
      ...result, status, commitSha: null, changedPaths: [], validation: [],
    }).some((error) => error.includes('was not reported')));
  }
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, changedPaths: ['apps/api/src/outside.ts'],
  }, ['apps/api/src/outside.ts']).some((error) => error.includes('outside allowedPaths')));
  assert.ok(validateWorkerResultAgainstTask({
    ...packet, forbiddenPaths: ['scripts/private/**'],
  }, {
    ...result, changedPaths: ['scripts/private/a.mjs'],
  }, ['scripts/private/a.mjs']).some((error) => error.includes('is forbidden')));
  assert.ok(validateWorkerResult({ ...result, changedPaths: ['../scripts/a.mjs'] }).some(
    (error) => error.includes('safe repository-relative'),
  ));
});


test('required validation union is deterministic and de-duplicates repeated commands', () => {
  const base = {
    schemaVersion: 3, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40),
    specialization: 'ops-workflow', riskTags: ['workflow'], finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers tooling.' }], system: [],
    },
  };
  assert.deepEqual(unionRequiredValidation([base, { ...base, taskId: 'task-2' }]), base.requiredValidation);
  assert.deepEqual(unionRequiredValidation([
    base,
    { ...base, taskId: 'task-2', requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Different reason.' }], system: [],
    } },
  ]), base.requiredValidation);
  assert.throws(() => unionRequiredValidation([
    base,
    { ...base, taskId: 'task-2', requiredValidation: {
      unit: [], system: [{ command: 'npm run check:workflow', reason: 'Wrong scope.', selectors: [], projects: [] }],
    } },
  ]), /Conflicting validation scope/u);

  const areaOnly = {
    ...base,
    specialization: 'data-integrity',
    riskTags: ['migration'],
    affectedAreas: ['shared', 'migration', 'documentation'],
    requiredValidation: {
      unit: [{ command: 'node --test .agents/skills/pr-review-cycle/scripts/contracts/contracts.test.mjs', reason: 'Focused contract tests.' }],
      system: [],
    },
  };
  assert.deepEqual(unionRequiredValidation([areaOnly]), {
    unit: [
      areaOnly.requiredValidation.unit[0],
      { command: 'npm run check:shared', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:api', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:web', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: migration.' },
      { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: migration.' },
    ],
    system: [],
  });
  assert.deepEqual(unionRequiredValidation([{ ...areaOnly, affectedAreas: ['release'] }]).unit.slice(-2), [
    { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: release.' },
    { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: release.' },
  ]);
});
