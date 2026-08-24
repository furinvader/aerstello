import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  buildCiValidationTransition,
  buildTargetedValidationTransition,
} from './validation.mjs';

test('CI builder preserves exact evidence, validation, and idempotency', () => {
  const cwd = harness.repo();
  const state = harness.ready(harness.init(cwd));
  const evidence = harness.ciEvidence(state);
  const actual = buildCiValidationTransition(state, evidence);
  assert.deepEqual(actual, harness.buildCiValidationTransition(state, evidence));
  assert.equal(buildCiValidationTransition(actual, evidence), actual);
  assert.throws(
    () => buildCiValidationTransition(state, { ...evidence, headSha: 'f'.repeat(40) }),
    (error) => error.code === 'INVALID_CI_VALIDATION',
  );
});

test('targeted validation builder consumes an explicit timestamp and completed plan', () => {
  const cwd = harness.repo();
  const state = harness.integratedTasks(cwd, ['local-one']);
  const plan = {
    schemaVersion: 1, prNumber: state.prNumber, stateRevision: state.revision,
    headSha: state.currentIntegrationHeadSha, taskIds: ['local-one'], affectedAreas: ['workflow'],
    commands: [{
      kind: 'unit', command: 'npm run check:workflow', reason: 'Focused proof.',
      selectors: [], projects: [], argv: ['npm', 'run', 'check:workflow'], status: 'passed',
      exitCode: 0, summary: 'Passed.', completedAt: harness.AT,
    }],
    createdAt: harness.AT, updatedAt: harness.AT,
  };
  const result = buildTargetedValidationTransition(state, plan, harness.AT);
  assert.deepEqual(result.validationStatus, {
    source: 'orchestrator', scope: 'targeted', status: 'passed',
    headSha: state.currentIntegrationHeadSha, checks: ['npm run check:workflow'],
    updatedAt: harness.AT,
  });
  assert.throws(
    () => buildTargetedValidationTransition(state, {
      ...plan, commands: [{ ...plan.commands[0], status: 'pending', exitCode: null,
        summary: null, completedAt: null }],
    }, harness.AT),
    (error) => error.code === 'VALIDATION_PLAN_INCOMPLETE',
  );
});

test('validation transition module performs no I/O or ambient clock work', () => {
  const source = readFileSync(new URL('./validation.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'node:child_process', 'gitSnapshot', 'withStateLock',
    'atomicWrite', 'process.', 'new Date']) assert.equal(source.includes(forbidden), false, forbidden);
});
