import assert from 'node:assert/strict';
import test from 'node:test';

import { StateError as OwnerStateError } from './errors.mjs';
import * as stateFacade from './state.mjs';

const EXPECTED_STATE_EXPORTS = [
  'ACTIVE_STATE_LIMIT_BYTES',
  'StateError',
  'activePointerPath',
  'activePrNumber',
  'appendEvent',
  'archiveState',
  'assertCompletionAllowed',
  'assertReviewRequestAllowed',
  'assertTaskPacketBound',
  'atomicWriteJson',
  'buildCiValidationTransition',
  'buildCompletionTransition',
  'buildReviewOutcomeTransition',
  'buildReviewRequestTransition',
  'buildTargetedValidationPlan',
  'buildVerificationEscalationTransition',
  'checkpointArchiveTaskCompletion',
  'checkpointCiValidation',
  'checkpointCompletion',
  'checkpointGitMetadata',
  'checkpointReviewOutcome',
  'checkpointReviewRequest',
  'checkpointReviewRequestLimit',
  'checkpointState',
  'checkpointTargetedValidation',
  'checkpointTargetedValidationReset',
  'checkpointTaskCompletion',
  'checkpointTaskPacketBinding',
  'checkpointTaskPacketReplan',
  'checkpointVerificationEscalation',
  'checkpointWorkerResultAcceptance',
  'checkpointWorkerResultBackfill',
  'claimGitHubMutationDispatch',
  'completeIntegratedTasks',
  'completionGate',
  'ensureGitHubMutationIntent',
  'executeTargetedValidationPlan',
  'gitAwareGateContext',
  'gitCommonDirectory',
  'initializeState',
  'inspectWorkerCommitAuthority',
  'loadBoundTaskPackets',
  'loadState',
  'locateState',
  'migratePrReviewStateV1',
  'migratePrReviewStateV2',
  'migrateState',
  'planSpecialists',
  'readSpecialistStatus',
  'reconcileState',
  'recordSpecialistReview',
  'renderRecoverySummary',
  'repositoryRoot',
  'reviewRequestGate',
  'reviewRequestUsage',
  'reviewRoot',
  'specialistContext',
  'specialistPlanReceiptPath',
  'specialistReviewBundlePath',
  'stateDirectory',
  'statePath',
  'taskBindingProvenancePath',
  'taskBindingProvenanceReceiptPath',
  'taskPacketDigest',
  'taskPacketSidecarPath',
  'validationPlanPath',
  'withGitHubRequestOwnerLock',
  'withStateLock',
  'workerResultEnvelopePath',
  'workerResultReceiptPath',
];

test('state façade retains the exact characterized public API', () => {
  assert.deepEqual(Object.keys(stateFacade).sort(), EXPECTED_STATE_EXPORTS);
  assert.equal(stateFacade.StateError, OwnerStateError);

  const error = new stateFacade.StateError('Characterized failure.', 'CHARACTERIZED_FAILURE');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof OwnerStateError);
  assert.equal(Object.getPrototypeOf(error), OwnerStateError.prototype);
  assert.equal(error.name, 'StateError');
  assert.equal(error.code, 'CHARACTERIZED_FAILURE');
  assert.equal(error.message, 'Characterized failure.');
});
