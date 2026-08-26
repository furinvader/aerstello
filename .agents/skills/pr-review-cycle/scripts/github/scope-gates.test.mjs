import assert from 'node:assert/strict';
import test from 'node:test';

import { assertScopeRootReady } from './scope-readiness.mjs';
import {
  FakeClient,
  addThread,
  completedState,
  integratedThreadState,
  readyState,
  stateFixture,
  workflow,
} from './test-support/workflow-harness.mjs';

const HEAD = 'a'.repeat(40);
const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const JOURNAL = `sha256:${'b'.repeat(64)}`;

function branch(classification, decision = null) {
  const reference = {
    authorityDigest: AUTHORITY, journalDigest: JOURNAL, returnDigest: null,
    gate: 'ready', assessmentHeadSha: HEAD, updatedAt: '2026-08-27T00:00:00Z',
  };
  const entries = [{
    kind: 'classification', rootCauseId: 'generalized-checker', findingIds: ['pr53-checker-root'],
    reviewHeadSha: HEAD, classification,
    assessment: {
      packet: { minimalClosure: { statement: 'Preserve the accepted boundary.' } },
      result: classification === 'unnecessary-mechanism-defect'
        ? { smallerSufficientAlternative: 'Remove or trim the generalized checker.' }
        : { smallestExpansion: 'Use only the explicitly approved replanned boundary.' },
    },
  }];
  if (decision) entries.push({ kind: 'decision', rootCauseId: 'generalized-checker', decision });
  return {
    state: { prNumber: 53, currentIntegrationHeadSha: HEAD, scopeControl: reference },
    adapter: { async scopeStatus() {
      return {
        configured: true, gate: 'ready', reference,
        authority: {
          digest: AUTHORITY,
          value: {
            authorityKind: 'legacy-adoption', source: { identity: 'furinvader/aerstello#54' },
            minimalClosure: { statement: 'Preserve the accepted boundary.' }, handoffHeadSha: HEAD,
          },
        },
        journal: { digest: JOURNAL, value: { entries } }, return: null,
      };
    } },
    task: { id: 'generalized-checker', sourceIds: ['pr53-checker-root'] },
  };
}

function workflowScope(state, classification, gate = 'ready') {
  const reference = { ...state.scopeControl, gate, assessmentHeadSha: HEAD };
  state.scopeControl = reference;
  return {
    configured: true,
    gate,
    reference,
    authority: {
      digest: reference.authorityDigest,
      value: {
        authorityKind: 'legacy-adoption', source: { identity: 'furinvader/aerstello#54' },
        minimalClosure: { statement: 'Preserve the accepted boundary.' }, handoffHeadSha: HEAD,
      },
    },
    journal: {
      digest: reference.journalDigest,
      value: { entries: [{
        kind: 'classification', rootCauseId: state.tasks[0]?.id ?? 'generalized-checker',
        findingIds: state.tasks[0]?.sourceIds ?? ['pr53-checker-root'],
        reviewHeadSha: HEAD, classification,
        assessment: {
          packet: { minimalClosure: { statement: 'Preserve the accepted boundary.' } },
          result: classification === 'unnecessary-mechanism-defect'
            ? { smallerSufficientAlternative: 'Remove or trim the generalized checker.' }
            : { smallestExpansion: 'Use only the explicitly approved replanned boundary.' },
        },
      }] },
    },
    return: null,
  };
}

function scopeRecoveryState() {
  return stateFixture({
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['scope regression'], updatedAt: '2026-08-27T00:00:00Z',
    },
  });
}

test('PR #53 generalized-checker removal or trim branch remains eligible without choosing its disposition', async () => {
  const { adapter, state, task } = branch('unnecessary-mechanism-defect', 'remove-or-simplify');
  const result = await assertScopeRootReady(adapter, state, HEAD, task);
  assert.equal(result.classification.classification, 'unnecessary-mechanism-defect');
});

test('PR #53 explicitly approved expansion requires a replan and new exact-head classification', async () => {
  const blocked = branch('material-scope-change', 'approve-expansion-and-replan');
  await assert.rejects(() => assertScopeRootReady(blocked.adapter, blocked.state, HEAD, blocked.task), {
    code: 'SCOPE_ROOT_NOT_READY',
  });
  const replanned = branch('within-scope-defect');
  assert.equal((await assertScopeRootReady(
    replanned.adapter, replanned.state, HEAD, replanned.task,
  )).classification.classification, 'within-scope-defect');
});

test('selected root gates do not authorize a different unclassified root', async () => {
  const { adapter, state } = branch('within-scope-defect');
  await assert.rejects(() => assertScopeRootReady(
    adapter, state, HEAD, { id: 'different-root', sourceIds: ['different-finding'] },
  ), { code: 'SCOPE_ROOT_NOT_READY' });
});

test('PR #53 material expansion blocks GitHub mutation, journal, checkpoints, request, and Done', async () => {
  const threadState = integratedThreadState();
  const threadStatus = workflowScope(threadState, 'material-scope-change', 'decision-required');
  const threadClient = new FakeClient();
  addThread(threadClient);
  const threadSetup = workflow(threadState, threadClient);
  threadSetup.state.setScopeStatusForTest(threadStatus);
  await assert.rejects(() => threadSetup.api.replyResolve(2, threadState.tasks[0].id), { code: 'SCOPE_NOT_READY' });
  assert.deepEqual(threadClient.events, []);
  assert.deepEqual(threadSetup.state.calls, []);

  const requestState = readyState();
  const requestStatus = workflowScope(requestState, 'material-scope-change', 'decision-required');
  const requestSetup = workflow(requestState);
  requestSetup.state.setScopeStatusForTest(requestStatus);
  await assert.rejects(() => requestSetup.api.request(2, 'discovery'), { code: 'SCOPE_NOT_READY' });
  assert.deepEqual(requestSetup.client.events, []);
  assert.deepEqual(requestSetup.state.calls, []);

  const recoveryState = scopeRecoveryState();
  const recoveryStatus = workflowScope(recoveryState, 'material-scope-change', 'decision-required');
  const recoverySetup = workflow(recoveryState);
  recoverySetup.state.setScopeStatusForTest(recoveryStatus);
  await assert.rejects(() => recoverySetup.api.refreshThreads(2), { code: 'SCOPE_NOT_READY' });
  assert.deepEqual(recoverySetup.state.calls, []);

  const doneState = completedState();
  const doneStatus = workflowScope(doneState, 'material-scope-change', 'decision-required');
  const doneSetup = workflow(doneState);
  doneSetup.state.setScopeStatusForTest(doneStatus);
  await assert.rejects(() => doneSetup.api.complete(2), { code: 'SCOPE_NOT_READY' });
  assert.deepEqual(doneSetup.state.calls, []);
  assert.equal((await doneSetup.api.advance(2)).terminal, 'scope-blocked');
  assert.deepEqual(doneSetup.client.events, []);
});

test('PR #53 trim and freshly replanned exact-head branches unlock the same workflow gates', async () => {
  const trimState = integratedThreadState();
  const trimStatus = workflowScope(trimState, 'unnecessary-mechanism-defect');
  const trimClient = new FakeClient();
  addThread(trimClient);
  const trimSetup = workflow(trimState, trimClient);
  trimSetup.state.setScopeStatusForTest(trimStatus);
  await trimSetup.api.replyResolve(2, trimState.tasks[0].id);
  assert.equal(trimClient.events.includes('mutation:AddThreadReply'), true);
  assert.equal(trimClient.events.includes('mutation:ResolveThread'), true);

  const replannedState = readyState();
  const replannedStatus = workflowScope(replannedState, 'within-scope-defect');
  const replannedSetup = workflow(replannedState);
  replannedSetup.state.setScopeStatusForTest(replannedStatus);
  const requested = await replannedSetup.api.request(2, 'discovery');
  assert.equal(requested.requested, true);
  assert.equal(replannedSetup.client.events.includes('mutation:AddReviewRequest'), true);

  const recoveryState = scopeRecoveryState();
  const recoveryStatus = workflowScope(recoveryState, 'within-scope-defect');
  const recoverySetup = workflow(recoveryState);
  recoverySetup.state.setScopeStatusForTest(recoveryStatus);
  assert.equal((await recoverySetup.api.refreshThreads(2)).threadResolutionStatus.status, 'passed');
  assert.equal(recoverySetup.state.calls[0].name, 'checkpointTaskCompletion');
});
