import assert from 'node:assert/strict';
import test from 'node:test';

import { StateError as OwnerStateError } from './errors.mjs';
import * as stateFacade from './state.mjs';
import * as contracts from '../contracts/contracts.mjs';
import * as paths from '../paths.mjs';
import * as locations from './locations.mjs';
import * as atomicIo from './atomic-io.mjs';
import * as gitAuthority from './git-authority.mjs';
import * as journal from './journal.mjs';
import * as migrations from './migrations.mjs';
import * as stateStore from './state-store.mjs';
import * as archive from './archive.mjs';
import * as taskBinding from './evidence/task-binding.mjs';
import * as specialistBundles from './evidence/specialist-bundles.mjs';
import * as taskPackets from './evidence/task-packets.mjs';
import * as reconciliation from './reconciliation.mjs';
import * as recovery from './recovery.mjs';
import * as locks from './locks.mjs';
import * as checkpoint from './checkpoint.mjs';
import * as reviewTransitions from './transitions/review.mjs';
import * as completionTransitions from './transitions/completion.mjs';
import * as validationTransitions from './transitions/validation.mjs';
import * as taskTransitions from './transitions/tasks.mjs';
import * as reviewServices from './services/review.mjs';
import * as completionServices from './services/completion.mjs';
import * as gitMetadataServices from './services/git-metadata.mjs';
import * as archiveImportServices from './services/archive-import.mjs';
import * as validationServices from './services/validation.mjs';
import * as taskServices from './services/tasks.mjs';
import * as scopeServices from './services/scope.mjs';

const EXPECTED_STATE_EXPORTS = [
  'ACTIVE_STATE_LIMIT_BYTES',
  'StateError',
  'activePointerPath',
  'activePrNumber',
  'appendEvent',
  'archiveState',
  'assertCompletionAllowed',
  'assertReviewRequestAllowed',
  'assertScopeTaskAllowed',
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
  'checkpointScopeAuthority',
  'checkpointScopeClassification',
  'checkpointScopeDecision',
  'checkpointScopeResume',
  'checkpointScopeReturn',
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
  'scopeAuthorityPath',
  'scopeAuthorityReceiptPath',
  'scopeControlJournalPath',
  'scopeControlJournalReceiptPath',
  'scopeReturnPath',
  'scopeReturnReceiptPath',
  'scopeStatus',
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

const EXPECTED_EXPORT_OWNERS = new Map([
  [contracts, ['completionGate', 'reviewRequestGate', 'reviewRequestUsage']],
  [paths, ['gitCommonDirectory', 'repositoryRoot', 'reviewRoot']],
  [{ StateError: OwnerStateError }, ['StateError']],
  [locations, [
    'activePointerPath', 'specialistPlanReceiptPath', 'specialistReviewBundlePath',
    'scopeAuthorityPath', 'scopeAuthorityReceiptPath', 'scopeControlJournalPath',
    'scopeControlJournalReceiptPath', 'scopeReturnPath', 'scopeReturnReceiptPath',
    'stateDirectory', 'statePath', 'taskBindingProvenancePath',
    'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath', 'validationPlanPath',
    'workerResultEnvelopePath', 'workerResultReceiptPath',
  ]],
  [atomicIo, ['atomicWriteJson']],
  [gitAuthority, ['inspectWorkerCommitAuthority']],
  [journal, ['appendEvent', 'ensureGitHubMutationIntent']],
  [migrations, ['migratePrReviewStateV1', 'migratePrReviewStateV2', 'migrateState']],
  [stateStore, [
    'ACTIVE_STATE_LIMIT_BYTES', 'activePrNumber', 'claimGitHubMutationDispatch',
    'initializeState', 'loadState', 'locateState',
  ]],
  [archive, ['archiveState']],
  [taskBinding, ['assertTaskPacketBound', 'loadBoundTaskPackets']],
  [specialistBundles, [
    'planSpecialists', 'readSpecialistStatus', 'recordSpecialistReview', 'specialistContext',
  ]],
  [taskPackets, ['taskPacketDigest']],
  [reconciliation, ['reconcileState']],
  [recovery, ['renderRecoverySummary']],
  [locks, ['withGitHubRequestOwnerLock', 'withStateLock']],
  [checkpoint, ['checkpointState']],
  [reviewTransitions, [
    'buildReviewOutcomeTransition', 'buildReviewRequestTransition',
    'buildVerificationEscalationTransition',
  ]],
  [completionTransitions, ['buildCompletionTransition']],
  [validationTransitions, ['buildCiValidationTransition']],
  [taskTransitions, ['completeIntegratedTasks']],
  [reviewServices, [
    'assertReviewRequestAllowed', 'checkpointReviewOutcome', 'checkpointReviewRequest',
    'checkpointReviewRequestLimit', 'checkpointVerificationEscalation',
  ]],
  [completionServices, [
    'assertCompletionAllowed', 'checkpointCompletion', 'gitAwareGateContext',
  ]],
  [gitMetadataServices, ['checkpointGitMetadata']],
  [archiveImportServices, ['checkpointArchiveTaskCompletion']],
  [validationServices, [
    'buildTargetedValidationPlan', 'checkpointCiValidation', 'checkpointTargetedValidation',
    'checkpointTargetedValidationReset', 'executeTargetedValidationPlan',
  ]],
  [taskServices, [
    'checkpointTaskCompletion', 'checkpointTaskPacketBinding', 'checkpointTaskPacketReplan',
    'checkpointWorkerResultAcceptance', 'checkpointWorkerResultBackfill',
  ]],
  [scopeServices, [
    'assertScopeTaskAllowed', 'checkpointScopeAuthority', 'checkpointScopeClassification',
    'checkpointScopeDecision', 'checkpointScopeResume', 'checkpointScopeReturn', 'scopeStatus',
  ]],
]);

test('state façade retains the exact characterized public API', () => {
  assert.deepEqual(Object.keys(stateFacade).sort(), EXPECTED_STATE_EXPORTS);
  const characterizedOwners = [];
  for (const [owner, names] of EXPECTED_EXPORT_OWNERS) {
    for (const name of names) {
      characterizedOwners.push(name);
      assert.equal(stateFacade[name], owner[name], `${name} must come from its canonical owner`);
    }
  }
  assert.deepEqual(characterizedOwners.sort(), EXPECTED_STATE_EXPORTS);

  const error = new stateFacade.StateError('Characterized failure.', 'CHARACTERIZED_FAILURE');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof OwnerStateError);
  assert.equal(Object.getPrototypeOf(error), OwnerStateError.prototype);
  assert.equal(error.name, 'StateError');
  assert.equal(error.code, 'CHARACTERIZED_FAILURE');
  assert.equal(error.message, 'Characterized failure.');
});
