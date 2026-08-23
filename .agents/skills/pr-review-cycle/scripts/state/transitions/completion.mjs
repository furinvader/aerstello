import { completionGate, validatePrReviewState } from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

export function buildCompletionTransition(state, external) {
  const gate = completionGate(state, external);
  if (!gate.allowed) {
    throw new StateError(
      `Review cycle is not complete:\n- ${gate.reasons.join('\n- ')}`,
      'REVIEW_CYCLE_INCOMPLETE',
    );
  }
  const next = { ...state, phase: 'complete', nextAction: 'Archive the completed review cycle.' };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid completion transition:\n- ${errors.join('\n- ')}`,
      'REVIEW_CYCLE_INCOMPLETE',
    );
  }
  return next;
}
