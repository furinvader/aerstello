import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import { activePrNumber } from '../state-store.mjs';
import { completeIntegratedTasks } from '../transitions/tasks.mjs';

function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selected;
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkpointArchiveTaskCompletion({
  cwd = process.cwd(), prNumber, threadResolutionStatus, archiveImportEnvelope,
  verifierBootstrapEnvelope,
  expectedRevision, event,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError(
      'Archive import completion requires an explicit expected revision',
      'STATE_REVISION_CONFLICT',
    );
  }
  const hasImport = archiveImportEnvelope !== undefined;
  const hasBootstrap = verifierBootstrapEnvelope !== undefined;
  if (hasImport === hasBootstrap) {
    throw new StateError(
      'Archive completion requires exactly one closed import or verifier-bootstrap envelope',
      'INVALID_ARCHIVE_IMPORT',
    );
  }
  return checkpointProtectedStateTransaction({
    cwd,
    prNumber: pr,
    expectedRevision,
    transitionKind: 'archive-task-completion',
    transitionEvidence: { archiveImportEnvelope, verifierBootstrapEnvelope },
    transaction: (current) => {
      const nextState = completeIntegratedTasks(current, {
        threadResolutionStatus,
        verifiedLocalTaskIds: hasBootstrap ? [verifierBootstrapEnvelope.taskId] : [],
        staleDiscoveryDisposition: null,
        archiveVerifierBootstrapTaskId: hasBootstrap ? verifierBootstrapEnvelope.taskId : null,
      });
      return sameEvidence(nextState, current)
        ? {
            nextState: current,
            result: current,
            noWrite: true,
            transitionEvidence: { archiveImportEnvelope, verifierBootstrapEnvelope },
          }
        : {
            nextState,
            event,
            transitionEvidence: { archiveImportEnvelope, verifierBootstrapEnvelope },
          };
    },
  });
}
