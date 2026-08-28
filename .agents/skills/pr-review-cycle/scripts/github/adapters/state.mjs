import {
  checkpointCiValidation,
  checkpointCompletion,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointTaskCompletion,
  checkpointVerificationEscalation,
  loadState,
  readSpecialistStatus,
  scopeStatus,
} from '../../state/state.mjs';

const DEFAULT_STATE_OPERATIONS = {
  checkpointCiValidation,
  checkpointCompletion,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointTaskCompletion,
  checkpointVerificationEscalation,
  loadState,
  readSpecialistStatus,
  scopeStatus,
};

export function createDefaultStateAdapter(cwd, operations = DEFAULT_STATE_OPERATIONS) {
  return {
    load: (prNumber) => operations.loadState(cwd, prNumber),
    scopeStatus: (prNumber) => operations.scopeStatus({ cwd, prNumber }),
    checkpointCiValidation: (input) => operations.checkpointCiValidation({ cwd, ...input }),
    checkpointReviewRequest: (input) => operations.checkpointReviewRequest({ cwd, ...input }),
    checkpointReviewOutcome: (input) => operations.checkpointReviewOutcome({ cwd, ...input }),
    checkpointVerificationEscalation: (input) => operations.checkpointVerificationEscalation({ cwd, ...input }),
    checkpointTaskCompletion: (input) => operations.checkpointTaskCompletion({ cwd, ...input }),
    checkpointCompletion: (input) => operations.checkpointCompletion({ cwd, ...input }),
    specialistStatus: (prNumber) => operations.readSpecialistStatus({ cwd, prNumber }),
  };
}
