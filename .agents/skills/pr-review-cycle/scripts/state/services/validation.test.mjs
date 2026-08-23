import assert from 'node:assert/strict';
import test from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  buildTargetedValidationPlan,
  checkpointCiValidation,
  checkpointTargetedValidationReset,
  executeTargetedValidationPlan,
} from './validation.mjs';

test('validation service saves command facts before exact-head proof', () => {
  const cwd = harness.repo();
  const state = harness.init(cwd);
  const selection = harness.initialSelection(state.currentIntegrationHeadSha);
  const plan = buildTargetedValidationPlan({ cwd, initialSelection: selection });
  assert.ok(plan.commands.every((entry) => entry.status === 'pending'));
  const order = [];
  const completed = executeTargetedValidationPlan({
    cwd,
    runCommand: () => ({ status: 0 }),
    onCommandRecorded: () => order.push('command-recorded'),
    onProofCheckpointed: () => order.push('proof-checkpointed'),
  });
  assert.equal(completed.state.validationStatus.status, 'passed');
  assert.equal(order.at(-1), 'proof-checkpointed');
  assert.ok(order.slice(0, -1).every((entry) => entry === 'command-recorded'));
});

test('validation reset and CI checkpoint use protected revision-guarded transactions', () => {
  const cwd = harness.repo();
  const initial = harness.ready(harness.init(cwd));
  const passed = harness.checkpointSyntheticTargetedValidation(cwd, initial);
  const reset = checkpointTargetedValidationReset({
    cwd, expectedRevision: passed.revision,
  });
  assert.equal(reset.validationStatus.status, 'not-run');
  assert.throws(
    () => checkpointTargetedValidationReset({ cwd, expectedRevision: passed.revision }),
    (error) => error.code === 'STATE_REVISION_CONFLICT',
  );

  const evidence = harness.ciEvidence(reset);
  const recorded = checkpointCiValidation({
    cwd, evidence, expectedRevision: reset.revision,
  });
  assert.equal(recorded.ciValidationStatus.checkRunId, evidence.checkRunId);
  assert.equal(checkpointCiValidation({
    cwd, evidence, expectedRevision: recorded.revision,
  }).revision, recorded.revision);
});
