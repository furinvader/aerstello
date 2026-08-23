import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { createRepository } from '../../../../../tests/support/git-fixtures.mjs';
import {
  checkpointProtectedState,
  checkpointProtectedStateTransaction,
  checkpointState,
  checkpointStateTransaction,
} from './checkpoint.mjs';
import { statePath } from './locations.mjs';
import { initializeState, loadState } from './state-store.mjs';

function withRepository(callback) {
  const cwd = createRepository();
  try {
    const state = initializeState({
      cwd, prNumber: 17, repository: 'example/aerstello',
      base: 'main', head: 'HEAD', releaseRef: 'main',
    });
    return callback(cwd, state);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

function proposedTask(index) {
  return {
    id: `capacity-task-${index}`,
    sourceIds: [`local:capacity-${index}`],
    sourceType: 'local',
    fingerprint: `capacity-fingerprint-${index}`,
    summary: `${index}:${'x'.repeat(990)}`,
    severity: 'P3',
    disposition: 'actionable',
    status: 'proposed',
    integratedCommitSha: null,
    resolutionSummary: null,
    execution: {
      dependencies: [], ownedPaths: [`scripts/capacity-${index}.mjs`],
      worker: 'review_fix_worker', branch: null, worktree: null,
      workerCommitSha: null, validationSummaries: [], lastError: null,
    },
  };
}

test('checkpoint reloads under the lock and owns revision, identity, validation, and ordering', () => {
  withRepository((cwd, initial) => {
    let revisionSeenByEvent = null;
    const updated = checkpointState({
      cwd,
      expectedRevision: initial.revision,
      nextState: { ...initial, nextAction: 'Persist the next bounded action.' },
      event: { type: 'checkpoint-test', summary: 'Exercise the extracted checkpoint' },
      eventWriter: () => { revisionSeenByEvent = loadState(cwd).revision; },
    });

    assert.equal(updated.revision, initial.revision + 1);
    assert.equal(revisionSeenByEvent, updated.revision, 'state must be written before its event');
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(initial.updatedAt));
    assert.equal(loadState(cwd).nextAction, updated.nextAction);

    const stableBytes = readFileSync(statePath(cwd, 17), 'utf8');
    throwsCode(() => checkpointState({
      cwd,
      expectedRevision: updated.revision,
      nextState: { ...updated, repository: 'other/repository' },
    }), 'IMMUTABLE_STATE_IDENTITY');
    throwsCode(() => checkpointState({
      cwd,
      expectedRevision: initial.revision,
      nextState: { ...updated, nextAction: 'Stale update.' },
    }), 'STATE_REVISION_CONFLICT');
    assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), stableBytes);

    const oversized = {
      ...updated,
      tasks: Array.from({ length: 70 }, (_entry, index) => proposedTask(index)),
    };
    throwsCode(() => checkpointState({
      cwd, expectedRevision: updated.revision, nextState: oversized,
    }), 'STATE_TOO_LARGE');
    assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), stableBytes);
  });
});

test('checkpoint is the only accepted protected-authorization minting boundary', () => {
  withRepository((cwd, initial) => {
    const nextState = { ...initial, reviewRequestLimit: 5 };
    throwsCode(() => checkpointState({
      cwd, expectedRevision: initial.revision, nextState,
    }), 'IMMUTABLE_STATE_PROVENANCE');
    throwsCode(() => checkpointState({
      cwd, expectedRevision: initial.revision, nextState, transitionAuthorization: {},
    }), 'INVALID_TRANSITION_AUTHORIZATION');

    const updated = checkpointProtectedState({
      cwd,
      expectedRevision: initial.revision,
      nextState,
      transitionKind: 'review-request-limit',
    });
    assert.equal(updated.reviewRequestLimit, 5);
    throwsCode(() => checkpointProtectedState({
      cwd,
      expectedRevision: updated.revision,
      nextState: { ...updated, reviewRequestLimit: 6 },
      transitionKind: 'unknown-transition',
    }), 'INVALID_TRANSITION_AUTHORIZATION');
  });
});

test('event failure restores exact prior state bytes', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const originalBytes = `${JSON.stringify(initial, null, 2)}\n`;
    writeFileSync(path, originalBytes);

    throwsCode(() => checkpointState({
      cwd,
      expectedRevision: initial.revision,
      nextState: { ...initial, nextAction: 'This write must roll back.' },
      event: { type: 'failing-event', summary: 'Force exact checkpoint rollback' },
      eventWriter: () => { throw new Error('synthetic journal failure'); },
    }), 'CHECKPOINT_EVENT_FAILED');
    assert.equal(readFileSync(path, 'utf8'), originalBytes);
  });
});

test('protected transaction reloads state and rejects Promise callbacks before persistence', () => {
  withRepository((cwd, initial) => {
    const first = checkpointState({
      cwd,
      expectedRevision: initial.revision,
      nextState: { ...initial, nextAction: 'Reload this exact state under the transaction lock.' },
    });
    const updated = checkpointProtectedStateTransaction({
      cwd,
      expectedRevision: first.revision,
      transitionKind: 'review-request-limit',
      transitionEvidence: {},
      transaction: (current) => {
        assert.equal(current.nextAction, first.nextAction);
        return {
          nextState: { ...current, reviewRequestLimit: 7 },
          event: { type: 'transaction-test', summary: 'Persist a protected transaction' },
        };
      },
    });
    assert.equal(updated.reviewRequestLimit, 7);

    const stableBytes = readFileSync(statePath(cwd, 17), 'utf8');
    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: updated.revision,
      transaction: async (current) => ({ nextState: current }),
    }), 'ASYNC_CHECKPOINT_TRANSACTION');
    assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), stableBytes);
  });
});

test('transactions can return explicit synchronous service results', () => {
  withRepository((cwd, initial) => {
    const serviceResult = { kind: 'checkpoint-result', selectedPr: initial.prNumber };
    const returned = checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: { ...current, nextAction: 'Return the structured service result.' },
        result: serviceResult,
      }),
    });

    assert.equal(returned, serviceResult);
    assert.equal(loadState(cwd).revision, initial.revision + 1);
    assert.equal(loadState(cwd).nextAction, 'Return the structured service result.');

    const stableBytes = readFileSync(statePath(cwd, 17), 'utf8');
    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision + 1,
      transaction: (current) => ({
        nextState: current,
        result: Promise.resolve(current),
      }),
    }), 'ASYNC_CHECKPOINT_TRANSACTION');
    assert.equal(readFileSync(statePath(cwd, 17), 'utf8'), stableBytes);
  });
});

test('explicit no-write results authorize under the lock without persistence', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');
    let eventWrites = 0;
    const serviceResult = { kind: 'idempotent', revision: initial.revision };
    const returned = checkpointProtectedStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transitionKind: 'review-request-limit',
      eventWriter: () => { eventWrites += 1; },
      transaction: (current) => ({
        nextState: current,
        result: serviceResult,
        noWrite: true,
      }),
    });

    assert.equal(returned, serviceResult);
    assert.equal(eventWrites, 0);
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
    assert.deepEqual(loadState(cwd), initial);

    throwsCode(() => checkpointProtectedStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transitionKind: 'review-request-limit',
      transaction: (current) => ({
        nextState: { ...current, reviewRequestLimit: 4 },
        noWrite: true,
      }),
    }), 'INVALID_CHECKPOINT_TRANSACTION');
    throwsCode(() => checkpointProtectedStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transitionKind: 'review-request-limit',
      transaction: (current) => ({
        nextState: current,
        event: { type: 'invalid-no-write-event', summary: 'Must be rejected' },
        noWrite: true,
      }),
    }), 'INVALID_CHECKPOINT_TRANSACTION');
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});

test('transactions preflight the exact persisted candidate before staged effects', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');
    let stagedEffects = 0;

    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: {
          ...current,
          tasks: Array.from({ length: 70 }, (_entry, index) => proposedTask(index)),
        },
        beforeCommit: () => { stagedEffects += 1; },
      }),
    }), 'STATE_TOO_LARGE');
    assert.equal(stagedEffects, 0);
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});

test('staged effects precede receipt-dependent policy and event validation', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');
    let stagedEffects = 0;

    throwsCode(() => checkpointProtectedStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transitionKind: 'review-request-limit',
      transaction: (current) => ({
        nextState: {
          ...current,
          reviewRequestLimit: 4,
          tasks: [proposedTask(0)],
        },
        beforeCommit: () => { stagedEffects += 1; },
      }),
    }), 'IMMUTABLE_STATE_PROVENANCE');
    assert.equal(stagedEffects, 1);

    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: { ...current, nextAction: 'Reject the event after staging.' },
        event: { type: 'invalid-event', summary: 'x'.repeat(1001) },
        beforeCommit: () => { stagedEffects += 1; },
      }),
    }), 'INVALID_EVENT');

    assert.equal(stagedEffects, 2);
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});

test('transaction staged effects must be functions with synchronous results', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');

    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({ nextState: current, beforeCommit: null }),
    }), 'INVALID_CHECKPOINT_TRANSACTION');
    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: current,
        beforeCommit: async () => undefined,
      }),
    }), 'ASYNC_CHECKPOINT_TRANSACTION');
    assert.throws(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: current,
        beforeCommit: () => { throw new Error('synthetic staged-effect failure'); },
      }),
    }), /synthetic staged-effect failure/u);

    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});

test('no-write transactions validate before running their staged repair', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');
    let observedRevision = null;
    const returned = checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      transaction: (current) => ({
        nextState: current,
        result: { repaired: true },
        noWrite: true,
        beforeCommit: () => { observedRevision = loadState(cwd).revision; },
      }),
    });

    assert.deepEqual(returned, { repaired: true });
    assert.equal(observedRevision, initial.revision);
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});

test('event failure rolls state back while retaining the completed staged effect', () => {
  withRepository((cwd, initial) => {
    const path = statePath(cwd, 17);
    const stableBytes = readFileSync(path, 'utf8');
    let evidenceDurable = false;
    let revisionSeenByEffect = null;

    throwsCode(() => checkpointStateTransaction({
      cwd,
      expectedRevision: initial.revision,
      eventWriter: () => { throw new Error('synthetic journal failure'); },
      transaction: (current) => ({
        nextState: { ...current, nextAction: 'Retry after journal recovery.' },
        event: { type: 'staged-effect-test', summary: 'Retain staged evidence on rollback' },
        beforeCommit: () => {
          revisionSeenByEffect = loadState(cwd).revision;
          evidenceDurable = true;
        },
      }),
    }), 'CHECKPOINT_EVENT_FAILED');

    assert.equal(revisionSeenByEffect, initial.revision);
    assert.equal(evidenceDurable, true);
    assert.equal(readFileSync(path, 'utf8'), stableBytes);
  });
});
