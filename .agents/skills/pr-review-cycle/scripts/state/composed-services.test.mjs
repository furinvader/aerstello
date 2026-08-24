import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import * as harness from './test-support/state-harness.mjs';
import {
  buildTargetedValidationPlan,
  checkpointArchiveTaskCompletion,
  checkpointCiValidation,
  checkpointCompletion,
  checkpointGitMetadata,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointState,
  checkpointTaskCompletion,
  checkpointTaskPacketBinding,
  checkpointWorkerResultAcceptance,
  executeTargetedValidationPlan,
  gitAwareGateContext,
  loadState,
  planSpecialists,
  statePath,
  taskBindingProvenanceReceiptPath,
  taskPacketSidecarPath,
  workerResultEnvelopePath,
  workerResultReceiptPath,
} from './state.mjs';

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('public facade composes task evidence before its single state write and exact retry', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const taskId = 'composed-task';
  const proposed = checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: taskId,
        status: 'proposed',
        integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, taskId, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  planSpecialists({
    cwd,
    input: harness.planInput(proposed, packet),
    expectedRevision: proposed.revision,
    now: () => harness.AT,
  });

  const bound = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: proposed.revision,
  });
  assert.equal(bound.revision, proposed.revision + 1, 'binding performs one state checkpoint');
  assert.equal(existsSync(taskPacketSidecarPath(cwd, 17, taskId)), true);
  assert.equal(existsSync(taskBindingProvenanceReceiptPath(cwd, 17, taskId)), true);
  const boundBytes = readFileSync(statePath(cwd, 17), 'utf8');
  const retried = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: bound.revision,
  });
  assert.deepEqual(retried, bound);
  assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), boundBytes);

  harness.git(cwd, ['switch', '-c', 'composed-worker']);
  const workerSha = harness.commit(
    cwd, { 'scripts/composed-worker.mjs': 'export const composed = true;\n' },
    'implement composed worker',
  );
  harness.git(cwd, ['switch', 'main']);
  const result = harness.workerResult(packet, workerSha, ['scripts/composed-worker.mjs']);
  const evidenceOrder = [];
  const accepted = checkpointWorkerResultAcceptance({
    cwd,
    packet,
    result,
    expectedRevision: bound.revision,
    onStep: (step) => evidenceOrder.push(step),
  });
  assert.deepEqual(evidenceOrder, [
    'receipt-durable', 'envelope-durable', 'state-checkpointed',
  ]);
  assert.equal(existsSync(workerResultReceiptPath(cwd, 17, taskId)), true);
  assert.equal(existsSync(workerResultEnvelopePath(cwd, 17, taskId)), true);
  assert.equal(accepted.tasks[0].status, 'implemented');
});

test('public facade composes validation facts before exact-head proof', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const plan = buildTargetedValidationPlan({
    cwd,
    initialSelection: harness.initialSelection(initial.currentIntegrationHeadSha),
  });
  assert.equal(plan.headSha, initial.currentIntegrationHeadSha);
  const order = [];
  const completed = executeTargetedValidationPlan({
    cwd,
    runCommand: () => ({ status: 0 }),
    onCommandRecorded: () => order.push('command-recorded'),
    onProofCheckpointed: () => order.push('proof-checkpointed'),
  });
  assert.equal(completed.state.validationStatus.headSha, initial.currentIntegrationHeadSha);
  assert.equal(completed.state.validationStatus.status, 'passed');
  assert.equal(order.at(-1), 'proof-checkpointed');
  assert.ok(order.slice(0, -1).every((entry) => entry === 'command-recorded'));
});

test('public facade composes review, CI, Git, and completion with exact-head retries', () => {
  const cwd = harness.repo();
  const initial = harness.ready(harness.init(cwd), []);
  writeFileSync(statePath(cwd, initial.prNumber), `${JSON.stringify(initial)}\n`);
  const external = harness.external(cwd, initial);
  const context = gitAwareGateContext(initial, external);
  assert.equal(context.localHeadSha, initial.currentIntegrationHeadSha);
  assert.equal(context.localDirty, false);

  const stableGit = checkpointGitMetadata({ cwd, backup: true });
  assert.equal(stableGit.checkpointed, false);
  assert.equal(loadState(cwd).revision, initial.revision);
  let current = checkpointReviewRequest({
    cwd, expectedRevision: initial.revision, request: harness.request(initial), ...external,
  });
  current = checkpointReviewOutcome({
    cwd, expectedRevision: current.revision, outcome: harness.outcome(current),
  });
  current = checkpointCiValidation({
    cwd, expectedRevision: current.revision, evidence: harness.ciEvidence(current),
  });
  const completed = checkpointCompletion({
    cwd, expectedRevision: current.revision, ...external,
  });
  assert.equal(completed.phase, 'complete');
  assert.equal(completed.currentIntegrationHeadSha, external.prHeadSha);
  const completedBytes = readFileSync(statePath(cwd, 17), 'utf8');
  const retry = checkpointCompletion({
    cwd, expectedRevision: completed.revision, ...external,
  });
  assert.deepEqual(retry, completed);
  assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), completedBytes);
});

test('public facade reserves archive envelopes for dedicated archive completion', () => {
  const cwd = harness.repo();
  const fixture = harness.archiveImportStateFixture(cwd);
  throwsCode(() => checkpointTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  }), 'PROTECTED_ARCHIVE_IMPORT_REQUIRED');
  const completed = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.equal(completed.tasks.find((task) => task.id === fixture.aggregate.id).status, 'completed');
  const completedBytes = readFileSync(statePath(cwd, 17), 'utf8');
  const retry = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: completed.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.deepEqual(retry, completed);
  assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), completedBytes);
});
