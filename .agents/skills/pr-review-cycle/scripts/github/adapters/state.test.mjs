import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultStateAdapter } from './state.mjs';

test('forwards the exact cwd and arguments to the stable state operations', async () => {
  const calls = [];
  const operation = (name) => (...args) => {
    calls.push({ name, args });
    return `${name}-result`;
  };
  const operations = {
    loadState: operation('loadState'),
    checkpointCiValidation: operation('checkpointCiValidation'),
    checkpointCompletion: operation('checkpointCompletion'),
    checkpointReviewOutcome: operation('checkpointReviewOutcome'),
    checkpointReviewRequest: operation('checkpointReviewRequest'),
    checkpointTaskCompletion: operation('checkpointTaskCompletion'),
    checkpointVerificationEscalation: operation('checkpointVerificationEscalation'),
    readSpecialistStatus: operation('readSpecialistStatus'),
  };
  const adapter = createDefaultStateAdapter('/repo', operations);
  assert.deepEqual(Object.keys(adapter), [
    'load',
    'checkpointCiValidation',
    'checkpointReviewRequest',
    'checkpointReviewOutcome',
    'checkpointVerificationEscalation',
    'checkpointTaskCompletion',
    'checkpointCompletion',
    'specialistStatus',
  ]);
  assert.equal(adapter.load(17), 'loadState-result');
  const input = { prNumber: 17, expectedRevision: 4 };
  for (const name of [
    'checkpointCiValidation',
    'checkpointReviewRequest',
    'checkpointReviewOutcome',
    'checkpointVerificationEscalation',
    'checkpointTaskCompletion',
    'checkpointCompletion',
  ]) assert.equal(adapter[name](input), `${name}-result`);
  assert.equal(adapter.specialistStatus(17), 'readSpecialistStatus-result');
  assert.deepEqual(calls, [
    { name: 'loadState', args: ['/repo', 17] },
    ...[
      'checkpointCiValidation',
      'checkpointReviewRequest',
      'checkpointReviewOutcome',
      'checkpointVerificationEscalation',
      'checkpointTaskCompletion',
      'checkpointCompletion',
    ].map((name) => ({ name, args: [{ cwd: '/repo', ...input }] })),
    { name: 'readSpecialistStatus', args: [{ cwd: '/repo', prNumber: 17 }] },
  ]);
});

test('preserves caller cwd authority over an input cwd field', () => {
  let forwarded;
  const operations = {
    loadState() {},
    checkpointCiValidation(input) { forwarded = input; },
    checkpointCompletion() {},
    checkpointReviewOutcome() {},
    checkpointReviewRequest() {},
    checkpointTaskCompletion() {},
    checkpointVerificationEscalation() {},
    readSpecialistStatus() {},
  };
  createDefaultStateAdapter('/adapter-root', operations)
    .checkpointCiValidation({ cwd: '/input-root', prNumber: 17 });
  assert.deepEqual(forwarded, { cwd: '/input-root', prNumber: 17 });
});
