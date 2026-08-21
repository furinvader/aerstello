import assert from 'node:assert/strict';
import test from 'node:test';

import * as stateFacade from './state.mjs';

const SUPPORTED_FUNCTION_EXPORTS = [
  'archiveState',
  'assertTaskPacketBound',
  'atomicWriteJson',
  'buildTargetedValidationPlan',
  'checkpointArchiveTaskCompletion',
  'checkpointCiValidation',
  'checkpointCompletion',
  'checkpointGitMetadata',
  'checkpointReviewOutcome',
  'checkpointReviewRequest',
  'checkpointReviewRequestLimit',
  'checkpointState',
  'checkpointTaskCompletion',
  'checkpointTaskPacketBinding',
  'checkpointTaskPacketReplan',
  'checkpointVerificationEscalation',
  'checkpointWorkerResultAcceptance',
  'checkpointWorkerResultBackfill',
  'claimGitHubMutationDispatch',
  'ensureGitHubMutationIntent',
  'executeTargetedValidationPlan',
  'gitCommonDirectory',
  'initializeState',
  'inspectWorkerCommitAuthority',
  'loadState',
  'locateState',
  'migrateState',
  'planSpecialists',
  'readSpecialistStatus',
  'reconcileState',
  'recordSpecialistReview',
  'renderRecoverySummary',
  'reviewRoot',
  'specialistContext',
  'stateDirectory',
  'withGitHubRequestOwnerLock',
  'withStateLock',
];

test('state façade retains the production-importer-backed API subset', () => {
  for (const exportName of SUPPORTED_FUNCTION_EXPORTS) {
    assert.equal(typeof stateFacade[exportName], 'function', `${exportName} must remain a function`);
  }

  assert.equal(typeof stateFacade.StateError, 'function');
  const error = new stateFacade.StateError('Characterized failure.', 'CHARACTERIZED_FAILURE');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'StateError');
  assert.equal(error.code, 'CHARACTERIZED_FAILURE');
  assert.equal(error.message, 'Characterized failure.');
});
