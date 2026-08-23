import { runGit } from '../../../../../../scripts/lib/git.mjs';

import { completionGate } from '../../contracts/contracts.mjs';
import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import { gitSnapshot } from '../git-authority.mjs';
import { activePrNumber } from '../state-store.mjs';
import { buildCompletionTransition } from '../transitions/completion.mjs';

function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selected;
}

export function assertCompletionAllowed(state, external) {
  const gate = completionGate(state, external);
  if (!gate.allowed) {
    throw new StateError(
      `Review cycle is not complete:\n- ${gate.reasons.join('\n- ')}`,
      'REVIEW_CYCLE_INCOMPLETE',
    );
  }
}

export function gitAwareGateContext(state, {
  pushedHeadSha, prHeadSha, prState, isDraft,
} = {}) {
  const cwd = state.integrationWorktree;
  const local = gitSnapshot(cwd);
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    prHeadSha,
    prState,
    isDraft,
    isAncestor: (ancestor, descendant) => runGit(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, allowFailure: true },
    ).status === 0,
  };
}

export function checkpointCompletion({
  cwd = process.cwd(), prNumber, pushedHeadSha, prHeadSha, prState, isDraft,
  expectedRevision, event,
} = {}) {
  return checkpointProtectedStateTransaction({
    cwd,
    prNumber: selectedPr(cwd, prNumber),
    expectedRevision,
    transitionKind: 'cycle-completion',
    transaction: (current) => {
      if (current.phase === 'complete') {
        return { nextState: current, result: current, noWrite: true };
      }
      const nextState = buildCompletionTransition(
        current,
        gitAwareGateContext(current, { pushedHeadSha, prHeadSha, prState, isDraft }),
      );
      if (nextState === current) {
        return { nextState: current, result: current, noWrite: true };
      }
      return { nextState, event };
    },
  });
}
