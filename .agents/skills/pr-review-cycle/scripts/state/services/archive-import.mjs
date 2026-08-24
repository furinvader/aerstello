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
  expectedRevision, event,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError(
      'Archive import completion requires an explicit expected revision',
      'STATE_REVISION_CONFLICT',
    );
  }
  return checkpointProtectedStateTransaction({
    cwd,
    prNumber: pr,
    expectedRevision,
    transitionKind: 'archive-task-completion',
    transitionEvidence: { archiveImportEnvelope },
    transaction: (current) => {
      const nextState = completeIntegratedTasks(current, {
        threadResolutionStatus,
        verifiedLocalTaskIds: [],
        staleDiscoveryDisposition: null,
      });
      return sameEvidence(nextState, current)
        ? {
            nextState: current,
            result: current,
            noWrite: true,
            transitionEvidence: { archiveImportEnvelope },
          }
        : {
            nextState,
            event,
            transitionEvidence: { archiveImportEnvelope },
          };
    },
  });
}
