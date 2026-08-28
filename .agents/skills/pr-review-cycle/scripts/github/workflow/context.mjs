import { validatePrReviewState } from '../../contracts/contracts.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { assertScopeReady, assertScopeRootReady, readScopeReadiness } from '../scope-readiness.mjs';

export function validateWorkflowState(state, prNumber) {
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new GitHubWorkflowError(`Invalid active state: ${errors.join('; ')}`, 'INVALID_STATE');
  if (prNumber !== undefined && prNumber !== null && state.prNumber !== prNumber) {
    throw new GitHubWorkflowError('Explicit PR does not match active state', 'PR_MISMATCH');
  }
}

export function escalationFor(state, liveHead, evidenceIds, reason, at) {
  const same = liveHead === state.reviewRequest.headSha;
  return {
    requestId: state.reviewRequest.id,
    requestHeadSha: state.reviewRequest.headSha,
    observedPrHeadSha: liveHead,
    headRelation: same ? 'same' : 'changed',
    evidenceIds: [...new Set(evidenceIds)].slice(0, 8),
    reason: !same && reason !== 'request-head-drift' ? 'request-head-drift' : reason,
    at,
  };
}

export function sameEscalationIntent(left, right) {
  return left?.requestId === right.requestId
    && left.requestHeadSha === right.requestHeadSha
    && left.observedPrHeadSha === right.observedPrHeadSha
    && left.headRelation === right.headRelation
    && left.reason === right.reason
    && JSON.stringify(left.evidenceIds) === JSON.stringify(right.evidenceIds);
}

export function createWorkflowContext({ client, state: stateAdapter, git, clock, journal, archiveStore }) {
  if (!client?.graphql || !stateAdapter?.load || !git || !clock?.now) {
    throw new GitHubWorkflowError('Client, state, Git, and clock adapters are required', 'INVALID_ADAPTERS');
  }

  async function load(prNumber) {
    const active = await stateAdapter.load(prNumber);
    if (!active) throw new GitHubWorkflowError('No active PR state', 'STATE_NOT_FOUND');
    validateWorkflowState(active, prNumber);
    return active;
  }

  async function assertCurrent(expected) {
    const current = await load(expected.prNumber);
    if (current.revision !== expected.revision) {
      throw new GitHubWorkflowError('Active state changed after preflight', 'STATE_REVISION_CHANGED');
    }
  }

  const scopeReadiness = (state, liveHeadSha = null) => readScopeReadiness(stateAdapter, state, liveHeadSha);
  const assertScopeCurrent = (state, liveHeadSha = null) => assertScopeReady(stateAdapter, state, liveHeadSha);
  const assertScopeRootCurrent = (state, liveHeadSha, task) => (
    assertScopeRootReady(stateAdapter, state, liveHeadSha, task)
  );

  async function checkpointPendingRecoveryEscalation(active, live, evidenceIds, reason) {
    if (!stateAdapter.checkpointVerificationEscalation) {
      throw new GitHubWorkflowError('The verification escalation checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    await assertMutationReady({ state: active, git }, live);
    await assertCurrent(active);
    const escalation = escalationFor(
      active,
      live.metadata.headRefOid,
      evidenceIds.length > 0 ? evidenceIds : [`request:${active.reviewRequest.id}`],
      reason,
      clock.now(),
    );
    try {
      const escalated = await stateAdapter.checkpointVerificationEscalation({
        prNumber: active.prNumber,
        expectedRevision: active.revision,
        escalation,
      });
      return {
        escalated: true, escalation: escalated.verificationEscalation,
        performed: escalated.revision !== active.revision,
      };
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      const current = await load(active.prNumber);
      if (!sameEscalationIntent(current.verificationEscalation, escalation)) throw error;
      return { escalated: true, escalation: current.verificationEscalation, performed: false };
    }
  }

  return {
    client, stateAdapter, git, clock, journal, archiveStore,
    load, assertCurrent, scopeReadiness, assertScopeCurrent, assertScopeRootCurrent,
    checkpointPendingRecoveryEscalation,
  };
}
