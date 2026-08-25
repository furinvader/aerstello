import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as contractsFacade from './contracts.mjs';
import { staleDiscoveryDispositionId } from './contract-identities.mjs';
import { completionGate, reviewRequestGate, reviewRequestUsage } from './gates.mjs';
import { buildStaleDiscoveryDisposition } from './review-evidence.mjs';
import { validatePrReviewStateV1 } from './state-v1.mjs';
import {
  FINDING_DISPOSITIONS,
  STATE_PHASES,
  TASK_STATUSES,
  validatePrReviewState,
} from './state-v3.mjs';
import {
  parseTargetedValidationCommand,
  unionInitialValidationSelection,
  validateInitialValidationSelection,
} from './targeted-validation.mjs';
import { unionRequiredValidation } from './task-packet-union.mjs';
import { taskPacketDigest, validateTaskPacket } from './task-packet.mjs';
import { taskHasCanonicalThreadCoverage } from './thread-proof.mjs';
import {
  validateWorkerResult,
  validateWorkerResultAgainstTask,
  workerResultDigest,
} from './worker-result.mjs';

const SUPPORTED_FUNCTIONS = {
  buildStaleDiscoveryDisposition,
  completionGate,
  parseTargetedValidationCommand,
  reviewRequestGate,
  reviewRequestUsage,
  staleDiscoveryDispositionId,
  taskPacketDigest,
  taskHasCanonicalThreadCoverage,
  unionInitialValidationSelection,
  unionRequiredValidation,
  validateInitialValidationSelection,
  validatePrReviewState,
  validatePrReviewStateV1,
  validateTaskPacket,
  validateWorkerResult,
  validateWorkerResultAgainstTask,
  workerResultDigest,
};

test('façade retains every supported function as its direct owner identity', () => {
  for (const [name, owner] of Object.entries(SUPPORTED_FUNCTIONS)) {
    assert.equal(typeof contractsFacade[name], 'function', `${name} must remain a function`);
    assert.strictEqual(contractsFacade[name], owner, `${name} must preserve owner identity`);
  }
});

test('façade retains state-v3 constant identities', () => {
  assert.strictEqual(contractsFacade.STATE_PHASES, STATE_PHASES);
  assert.strictEqual(contractsFacade.TASK_STATUSES, TASK_STATUSES);
  assert.strictEqual(contractsFacade.FINDING_DISPOSITIONS, FINDING_DISPOSITIONS);
});

test('façade preserves representative contract behavior', () => {
  assert.deepEqual(contractsFacade.parseTargetedValidationCommand('npm run check:workflow'), [
    'npm', 'run', 'check:workflow',
  ]);
  assert.deepEqual(contractsFacade.validateTaskPacket(null), ['$ must be an object']);
  assert.deepEqual(contractsFacade.reviewRequestUsage({
    legacyReviewProvenance: { discoveryRounds: 2 },
    reviewHistory: [{}, {}],
    reviewRequestLimit: 5,
  }), { used: 4, limit: 5, remaining: 1, exhausted: false });
});
