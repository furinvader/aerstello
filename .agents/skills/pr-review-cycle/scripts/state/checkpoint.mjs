import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { atomicWriteJson, atomicWriteText } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { appendEvent, prepareEvent } from './journal.mjs';
import { statePath } from './locations.mjs';
import { withStateLock } from './locks.mjs';
import {
  activePrNumber,
  loadState,
  validateStateForWrite,
} from './state-store.mjs';
import { createTransitionPolicy } from './transition-policy.mjs';

const transitionPolicy = createTransitionPolicy();

function utcNow() {
  return new Date().toISOString();
}

function selectPr(cwd, prNumber, nextState) {
  const selectedPr = prNumber ?? nextState?.prNumber ?? activePrNumber(cwd);
  if (selectedPr === null || selectedPr === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selectedPr;
}

function assertRevision(current, expectedRevision, nextState) {
  const expected = expectedRevision ?? nextState?.revision;
  if (expected !== current.revision) {
    throw new StateError(
      `State revision changed: expected ${expected}, found ${current.revision}`,
      'STATE_REVISION_CONFLICT',
    );
  }
}

function assertImmutableIdentity(current, nextState) {
  for (const field of ['repository', 'prNumber', 'baseSha', 'integrationWorktree']) {
    if (nextState[field] !== current[field]) {
      throw new StateError(`${field} is immutable`, 'IMMUTABLE_STATE_IDENTITY');
    }
  }
  if (JSON.stringify(nextState.releaseBaseline) !== JSON.stringify(current.releaseBaseline)) {
    throw new StateError('releaseBaseline is immutable', 'IMMUTABLE_STATE_IDENTITY');
  }
  if (JSON.stringify(nextState.legacyReviewProvenance)
      !== JSON.stringify(current.legacyReviewProvenance)) {
    throw new StateError('legacyReviewProvenance is immutable', 'IMMUTABLE_STATE_IDENTITY');
  }
  if (nextState.reviewRound < current.reviewRound) {
    throw new StateError('reviewRound cannot decrease', 'INVALID_LIFECYCLE_TRANSITION');
  }
  if (current.verificationReviewUsed && !nextState.verificationReviewUsed) {
    throw new StateError('verificationReviewUsed is sticky', 'INVALID_LIFECYCLE_TRANSITION');
  }
  if (nextState.abandonmentReason !== null) {
    throw new StateError(
      'abandonmentReason must remain null in active state',
      'INVALID_LIFECYCLE_TRANSITION',
    );
  }
}

function writeCheckpoint({
  cwd,
  selectedPr,
  current,
  nextState,
  event,
  eventWriter,
  beforeCommit,
  transitionAuthorization,
  now,
}) {
  if (beforeCommit === undefined) {
    if (event) prepareEvent(event);
    assertImmutableIdentity(current, nextState);
    transitionPolicy.assertTransitionAllowed(
      current,
      nextState,
      transitionAuthorization,
      cwd,
    );
  } else {
    assertImmutableIdentity(current, nextState);
  }
  const state = { ...nextState, revision: current.revision + 1, updatedAt: now() };
  validateStateForWrite(state);
  invokeBeforeCommit(beforeCommit);
  if (beforeCommit !== undefined) {
    transitionPolicy.assertTransitionAllowed(
      current,
      nextState,
      transitionAuthorization,
      cwd,
    );
    if (event) prepareEvent(event);
  }

  const path = statePath(cwd, selectedPr);
  const originalBytes = readFileSync(path, 'utf8');
  atomicWriteJson(path, state);
  if (event) {
    try {
      eventWriter(cwd, selectedPr, event);
    } catch (error) {
      atomicWriteText(path, originalBytes);
      throw new StateError(
        `Checkpoint event failed; state was rolled back: ${error.message}`,
        'CHECKPOINT_EVENT_FAILED',
      );
    }
  }
  return state;
}

function checkpointLocked({
  cwd,
  selectedPr,
  nextState,
  expectedRevision,
  event,
  eventWriter,
  transitionAuthorization,
  transitionKind,
  transitionEvidence,
  now,
}) {
  const current = loadState(cwd, selectedPr);
  assertRevision(current, expectedRevision, nextState);
  const authorization = transitionKind === undefined
    ? transitionAuthorization
    : transitionPolicy.authorizeProtectedTransition(
      current,
      nextState,
      transitionKind,
      transitionEvidence,
    );
  return writeCheckpoint({
    cwd,
    selectedPr,
    current,
    nextState,
    event,
    eventWriter,
    transitionAuthorization: authorization,
    now,
  });
}

export function checkpointState({
  cwd = process.cwd(),
  prNumber,
  nextState,
  expectedRevision,
  event,
  eventWriter = appendEvent,
  transitionAuthorization,
} = {}) {
  const selectedPr = selectPr(cwd, prNumber, nextState);
  return withStateLock(cwd, selectedPr, () => checkpointLocked({
    cwd,
    selectedPr,
    nextState,
    expectedRevision,
    event,
    eventWriter,
    transitionAuthorization,
    now: utcNow,
  }));
}

export function checkpointProtectedState({
  cwd = process.cwd(),
  prNumber,
  nextState,
  expectedRevision,
  event,
  eventWriter = appendEvent,
  transitionKind,
  transitionEvidence = {},
} = {}) {
  const selectedPr = selectPr(cwd, prNumber, nextState);
  return withStateLock(cwd, selectedPr, () => checkpointLocked({
    cwd,
    selectedPr,
    nextState,
    expectedRevision,
    event,
    eventWriter,
    transitionKind,
    transitionEvidence,
    now: utcNow,
  }));
}

function transactionResult(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof value.then === 'function') {
    throw new StateError(
      'Checkpoint transaction callbacks must be synchronous',
      'ASYNC_CHECKPOINT_TRANSACTION',
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.nextState === null || typeof value.nextState !== 'object'
      || Array.isArray(value.nextState)) {
    throw new StateError(
      'Checkpoint transaction callbacks must return an object containing nextState',
      'INVALID_CHECKPOINT_TRANSACTION',
    );
  }
  if (Object.hasOwn(value, 'result')
      && value.result !== null
      && (typeof value.result === 'object' || typeof value.result === 'function')
      && typeof value.result.then === 'function') {
    throw new StateError(
      'Checkpoint transaction results must be synchronous',
      'ASYNC_CHECKPOINT_TRANSACTION',
    );
  }
  if (Object.hasOwn(value, 'noWrite') && typeof value.noWrite !== 'boolean') {
    throw new StateError(
      'Checkpoint transaction noWrite must be a boolean',
      'INVALID_CHECKPOINT_TRANSACTION',
    );
  }
  if (Object.hasOwn(value, 'beforeCommit') && typeof value.beforeCommit !== 'function') {
    throw new StateError(
      'Checkpoint transaction beforeCommit must be a function',
      'INVALID_CHECKPOINT_TRANSACTION',
    );
  }
  return value;
}

function invokeBeforeCommit(beforeCommit) {
  if (beforeCommit === undefined) return;
  const value = beforeCommit();
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof value.then === 'function') {
    throw new StateError(
      'Checkpoint transaction beforeCommit hooks must be synchronous',
      'ASYNC_CHECKPOINT_TRANSACTION',
    );
  }
}

function checkpointTransaction({
  cwd = process.cwd(),
  prNumber,
  expectedRevision,
  transaction,
  eventWriter = appendEvent,
  transitionKind,
  transitionEvidence = {},
} = {}) {
  if (typeof transaction !== 'function') {
    throw new StateError(
      'Checkpoint transaction callback is required',
      'INVALID_CHECKPOINT_TRANSACTION',
    );
  }
  const selectedPr = selectPr(cwd, prNumber);
  return withStateLock(cwd, selectedPr, () => {
    const current = loadState(cwd, selectedPr);
    assertRevision(current, expectedRevision, current);
    const result = transactionResult(transaction(structuredClone(current)));
    const kind = transitionKind;
    const authorization = kind === undefined
      ? undefined
      : transitionPolicy.authorizeProtectedTransition(
        current,
        result.nextState,
        kind,
        result.transitionEvidence ?? transitionEvidence,
      );
    if (result.noWrite === true) {
      if (!isDeepStrictEqual(result.nextState, current)) {
        throw new StateError(
          'Checkpoint transaction noWrite requires the exact current state',
          'INVALID_CHECKPOINT_TRANSACTION',
        );
      }
      if (Object.hasOwn(result, 'event')) {
        throw new StateError(
          'Checkpoint transaction noWrite cannot include an event',
          'INVALID_CHECKPOINT_TRANSACTION',
        );
      }
      assertImmutableIdentity(current, result.nextState);
      validateStateForWrite(result.nextState);
      transitionPolicy.assertTransitionAllowed(current, result.nextState, authorization, cwd);
      invokeBeforeCommit(result.beforeCommit);
      return Object.hasOwn(result, 'result') ? result.result : current;
    }
    const state = writeCheckpoint({
      cwd,
      selectedPr,
      current,
      nextState: result.nextState,
      event: result.event,
      eventWriter,
      beforeCommit: result.beforeCommit,
      transitionAuthorization: authorization,
      now: utcNow,
    });
    return Object.hasOwn(result, 'result') ? result.result : state;
  });
}

export function checkpointStateTransaction(options = {}) {
  const {
    transitionKind: _transitionKind,
    transitionEvidence: _transitionEvidence,
    ...genericOptions
  } = options;
  return checkpointTransaction(genericOptions);
}

export function checkpointProtectedStateTransaction(options = {}) {
  if (options.transitionKind === undefined) {
    throw new StateError(
      'Protected checkpoint transactions require a transition kind',
      'INVALID_TRANSITION_AUTHORIZATION',
    );
  }
  return checkpointTransaction(options);
}
