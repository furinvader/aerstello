import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCollectCiUseCase, sameCiEvidence } from './collect-ci.mjs';
import { createWorkflowContext } from './context.mjs';
import {
  FakeClient, OTHER_HEAD, fakeGit, fakeState, fullValidationCheck, passedCiEvidence, stateFixture,
} from '../test-support/workflow-harness.mjs';

test('collect-ci owner records authoritative evidence and reconciles an equivalent revision winner', async () => {
  const client = new FakeClient();
  const stateAdapter = fakeState(stateFixture());
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => passedCiEvidence().updatedAt }, journal: {},
  });
  const collectCi = createCollectCiUseCase(context);
  const first = await collectCi(2);
  assert.equal(first.performed, true);
  assert.equal(first.evidence.status, 'passed');
  assert.deepEqual(stateAdapter.calls.map(({ name }) => name), ['checkpointCiValidation']);

  stateAdapter.setBeforeCheckpointForTest(({ input, current, replaceCurrent }) => {
    replaceCurrent({
      ...current,
      revision: current.revision + 1,
      ciValidationStatus: input.evidence,
      ciValidationHistory: current.ciValidationHistory,
    });
  }, 'checkpointCiValidation');
  const repeated = await collectCi(2);
  assert.equal(repeated.performed, false);
  assert.equal(sameCiEvidence(repeated.evidence, first.evidence), true);
  assert.equal(client.calls.filter(({ name }) => name === 'PullRequestChecks').length, 2);
});

test('collect-ci owner fails closed on head drift and records authoritative failed CI', async () => {
  const driftClient = new FakeClient({ metadata: { headRefOid: OTHER_HEAD } });
  const driftState = fakeState(stateFixture());
  const driftContext = createWorkflowContext({
    client: driftClient, state: driftState, git: fakeGit(), clock: { now: () => passedCiEvidence().updatedAt }, journal: {},
  });
  await assert.rejects(() => createCollectCiUseCase(driftContext)(2), { code: 'CI_HEAD_MISMATCH' });
  assert.deepEqual(driftState.calls, []);

  const failedClient = new FakeClient({
    rollupState: 'FAILURE',
    ciContexts: [fullValidationCheck({ conclusion: 'FAILURE' })],
  });
  const failedState = fakeState(stateFixture());
  const failedContext = createWorkflowContext({
    client: failedClient, state: failedState, git: fakeGit(), clock: { now: () => passedCiEvidence().updatedAt }, journal: {},
  });
  const result = await createCollectCiUseCase(failedContext)(2);
  assert.equal(result.evidence.status, 'failed');
  assert.deepEqual(failedState.calls.map(({ name }) => name), ['checkpointCiValidation']);
});

test('collect-ci owner does not checkpoint pending authoritative CI', async () => {
  const client = new FakeClient({
    rollupState: 'PENDING',
    ciContexts: [fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })],
  });
  const stateAdapter = fakeState(stateFixture());
  const context = createWorkflowContext({
    client, state: stateAdapter, git: fakeGit(), clock: { now: () => passedCiEvidence().updatedAt }, journal: {},
  });
  await assert.rejects(() => createCollectCiUseCase(context)(2), { code: 'CI_VALIDATION_PENDING' });
  assert.deepEqual(stateAdapter.calls, []);
});
