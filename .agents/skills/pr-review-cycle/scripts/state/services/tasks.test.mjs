import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import * as harness from '../test-support/state-harness.mjs';
import {
  checkpointTaskCompletion,
  checkpointTaskPacketBinding,
  checkpointWorkerResultAcceptance,
} from './tasks.mjs';

function proposedTaskFixture(cwd, taskId = 'service-task') {
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: taskId,
        status: 'proposed',
        disposition: 'actionable',
        integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, taskId, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  harness.planSpecialists({
    cwd,
    input: harness.planInput(proposed, packet),
    expectedRevision: proposed.revision,
    now: () => harness.AT,
  });
  const bound = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: proposed.revision,
  });
  return { initial, packet, bound };
}

test('task packet service persists immutable sidecars before one state checkpoint', () => {
  const cwd = harness.repo();
  const { packet, bound } = proposedTaskFixture(cwd);
  assert.equal(bound.tasks[0].taskPacketDigest, harness.taskPacketDigest(packet));
  assert.equal(existsSync(harness.taskPacketSidecarPath(cwd, 17, packet.taskId)), true);
  assert.equal(existsSync(
    harness.taskBindingProvenanceReceiptPath(cwd, 17, packet.taskId),
  ), true);
  const retry = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: bound.revision,
  });
  assert.equal(retry.revision, bound.revision);

  const provenancePath = harness.taskBindingProvenancePath(cwd, 17, packet.taskId);
  const stateBytes = readFileSync(harness.statePath(cwd, 17), 'utf8');
  const eventsPath = join(harness.stateDirectory(cwd, 17), 'events.ndjson');
  const eventBytes = readFileSync(eventsPath, 'utf8');
  rmSync(provenancePath);
  const repaired = checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: bound.revision,
  });
  assert.equal(repaired.revision, bound.revision);
  assert.equal(existsSync(provenancePath), true);
  assert.equal(readFileSync(harness.statePath(cwd, 17), 'utf8'), stateBytes);
  assert.equal(readFileSync(eventsPath, 'utf8'), eventBytes);
});

test('task packet service retains staged evidence when the event is invalid', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'invalid-event-packet',
        status: 'proposed',
        disposition: 'actionable',
        integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'invalid-event-packet', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  harness.planSpecialists({
    cwd,
    input: harness.planInput(proposed, packet),
    expectedRevision: proposed.revision,
    now: () => harness.AT,
  });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd,
    packet,
    expectedRevision: proposed.revision,
    event: { type: 'invalid-packet-event', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(existsSync(harness.taskPacketSidecarPath(cwd, 17, packet.taskId)), true);
  assert.equal(existsSync(harness.taskBindingProvenancePath(cwd, 17, packet.taskId)), true);
  assert.equal(existsSync(
    harness.taskBindingProvenanceReceiptPath(cwd, 17, packet.taskId),
  ), true);
  assert.equal(harness.loadState(cwd).tasks[0].taskPacketDigest, undefined);
});

test('task packet service preflights near-capacity state before sidecar persistence', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'packet-capacity',
        status: 'proposed',
        disposition: 'actionable',
        integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'packet-capacity', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const digest = harness.taskPacketDigest(packet);
  const bytes = (state) => Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8');
  const persistedShape = (state) => ({
    ...state, revision: proposed.revision + 1, updatedAt: proposed.updatedAt,
  });
  const boundShape = (state) => ({
    ...state,
    revision: state.revision + 1,
    tasks: state.tasks.map((task) => task.id === packet.taskId
      ? { ...task, taskPacketDigest: digest } : task),
  });
  let padded = { ...proposed, decisions: [...proposed.decisions] };
  let index = 0;
  while (true) {
    const candidate = { ...padded, decisions: [...padded.decisions, {
      id: `packet-capacity-${index}`, summary: 'p'.repeat(1000),
    }] };
    if (bytes(boundShape(persistedShape(candidate))) > harness.ACTIVE_STATE_LIMIT_BYTES) break;
    padded = candidate;
    index += 1;
  }
  let fitting = null;
  for (let length = 1; length <= 1000; length += 1) {
    const candidate = { ...padded, decisions: [...padded.decisions, {
      id: `packet-capacity-${index}`, summary: 'p'.repeat(length),
    }] };
    const persisted = persistedShape(candidate);
    if (bytes(persisted) <= harness.ACTIVE_STATE_LIMIT_BYTES
        && bytes(boundShape(persisted)) > harness.ACTIVE_STATE_LIMIT_BYTES) fitting = candidate;
  }
  assert.ok(fitting, 'constructed a valid current state whose bound projection is oversized');
  const nearLimit = harness.checkpointState({
    cwd, expectedRevision: proposed.revision, nextState: fitting,
  });
  harness.planSpecialists({
    cwd,
    input: harness.planInput(nearLimit, packet),
    expectedRevision: nearLimit.revision,
    now: () => harness.AT,
  });

  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: nearLimit.revision,
  }), { code: 'STATE_TOO_LARGE' });
  assert.equal(existsSync(harness.taskPacketSidecarPath(cwd, 17, packet.taskId)), false);
  assert.equal(existsSync(harness.taskBindingProvenancePath(cwd, 17, packet.taskId)), false);
  assert.equal(existsSync(
    harness.taskBindingProvenanceReceiptPath(cwd, 17, packet.taskId),
  ), false);
});

test('worker result service resumes receipt and envelope evidence before checkpointing state', () => {
  const cwd = harness.repo();
  const { packet, bound } = proposedTaskFixture(cwd, 'result-service-task');
  harness.git(cwd, ['switch', '-c', 'result-service-worker']);
  const workerSha = harness.commit(
    cwd, { 'scripts/result-service.mjs': 'export const result = true;\n' },
    'result service worker',
  );
  harness.git(cwd, ['switch', 'main']);
  const result = harness.workerResult(packet, workerSha, ['scripts/result-service.mjs']);

  assert.throws(() => checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => { if (step === 'receipt-durable') throw new Error('interrupt receipt'); },
  }), /interrupt receipt/u);
  assert.equal(existsSync(
    harness.workerResultReceiptPath(cwd, 17, packet.taskId),
  ), true);
  assert.equal(existsSync(
    harness.workerResultEnvelopePath(cwd, 17, packet.taskId),
  ), false);

  const order = [];
  const accepted = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: bound.revision,
    onStep: (step) => order.push(step),
  });
  assert.deepEqual(order, ['envelope-durable', 'state-checkpointed']);
  assert.equal(accepted.tasks[0].status, 'implemented');
  assert.equal(accepted.tasks[0].execution.workerCommitSha, workerSha);
  const retryOrder = [];
  const retried = checkpointWorkerResultAcceptance({
    cwd, packet, result, expectedRevision: accepted.revision,
    onStep: (step) => retryOrder.push(step),
  });
  assert.equal(retried.revision, accepted.revision);
  assert.deepEqual(retryOrder, []);
});

test('ordinary task completion rejects archive authorization envelopes', () => {
  const cwd = harness.repo();
  const state = harness.init(cwd);
  assert.throws(() => checkpointTaskCompletion({
    cwd,
    expectedRevision: state.revision,
    threadResolutionStatus: harness.ready(state, []).threadResolutionStatus,
    archiveImportEnvelope: {},
  }), (error) => error.code === 'PROTECTED_ARCHIVE_IMPORT_REQUIRED');
});

test('stale-disposition retry returns locked state without state, event, or revision write', () => {
  const cwd = harness.repo();
  const fixture = harness.nativeStaleDiscoveryDisposition(cwd);
  const statePath = harness.statePath(cwd, fixture.dispositioned.prNumber);
  const eventsPath = join(
    harness.stateDirectory(cwd, fixture.dispositioned.prNumber), 'events.ndjson',
  );
  const stateBytes = readFileSync(statePath, 'utf8');
  const eventBytes = readFileSync(eventsPath, 'utf8');
  const retried = checkpointTaskCompletion({
    cwd,
    expectedRevision: fixture.dispositioned.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    staleDiscoveryDisposition: fixture.disposition,
  });
  assert.deepEqual(retried, fixture.dispositioned);
  assert.equal(retried.revision, fixture.dispositioned.revision);
  assert.equal(readFileSync(statePath, 'utf8'), stateBytes);
  assert.equal(readFileSync(eventsPath, 'utf8'), eventBytes);
});
