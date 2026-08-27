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
const REVISED_AUTHORITY = `sha256:${'d'.repeat(64)}`;
const JOURNAL = `sha256:${'b'.repeat(64)}`;
const ASSESSMENT = `sha256:${'c'.repeat(64)}`;

function branch(classification, decision = null) {
  const reference = {
    authorityDigest: AUTHORITY, journalDigest: JOURNAL, returnDigest: null,
    gate: 'ready', assessmentHeadSha: HEAD, updatedAt: '2026-08-27T00:00:00Z',
  };
  const entries = [{
    kind: 'classification', rootCauseId: 'generalized-checker', findingIds: ['pr53-checker-root'],
    findingFingerprints: ['generalized-checker-fingerprint-f1'],
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
        journal: { digest: JOURNAL, value: { authorityDigest: AUTHORITY, entries } }, return: null,
      };
    } },
    task: {
      id: 'generalized-checker', sourceIds: ['pr53-checker-root'],
      fingerprint: 'generalized-checker-fingerprint',
      disposition: 'actionable',
    },
  };
}

function workflowScope(state, classification, gate = 'ready', { integratedManifest = false } = {}) {
  const reference = { ...state.scopeControl, gate, assessmentHeadSha: HEAD };
  state.scopeControl = reference;
  const assessment = {
    digest: ASSESSMENT,
    packet: {
      binding: { phase: integratedManifest ? 'integrated-head' : 'review-finding' },
      minimalClosure: { statement: 'Preserve the accepted boundary.' },
    },
    result: {
      binding: { phase: integratedManifest ? 'integrated-head' : 'review-finding' },
      verdict: classification === 'within-scope-defect' ? 'within-scope' : 'human-decision-required',
      ...(classification === 'unnecessary-mechanism-defect'
        ? { verdict: 'trim-required', smallerSufficientAlternative: 'Remove or trim the generalized checker.' }
        : { smallestExpansion: 'Use only the explicitly approved replanned boundary.' }),
    },
  };
  const classificationEntry = {
    schemaVersion: 1, kind: 'classification', rootCauseId: state.tasks[0]?.id ?? 'generalized-checker',
    findingIds: state.tasks[0]?.sourceIds ?? ['pr53-checker-root'],
    findingFingerprints: (state.tasks[0]?.sourceIds ?? ['pr53-checker-root']).map(
      (_sourceId, index) => `${state.tasks[0]?.fingerprint ?? 'generalized-checker-fingerprint'}-f${index + 1}`,
    ),
    reviewHeadSha: HEAD, authorityDigest: AUTHORITY, classification,
    authorityAmendmentRequired: false, assessment,
  };
  const entries = [classificationEntry];
  if (integratedManifest) entries.push({
    schemaVersion: 1, kind: 'exact-head-manifest', rootCauseId: classificationEntry.rootCauseId,
    reviewHeadSha: HEAD, authorityDigest: AUTHORITY,
    assessmentDigest: ASSESSMENT, triggerKinds: ['classification'],
  });
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
      value: { authorityDigest: AUTHORITY, entries },
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

function amendedWorkflowScope(state) {
  const status = workflowScope(state, 'within-scope-defect', 'ready', { integratedManifest: true });
  status.reference.authorityDigest = REVISED_AUTHORITY;
  state.scopeControl = status.reference;
  status.journal.value.authorityDigest = REVISED_AUTHORITY;
  status.journal.value.entries.unshift({
    schemaVersion: 1, kind: 'amendment', rootCauseId: 'generalized-checker',
    reviewHeadSha: HEAD, authorityDigest: AUTHORITY,
    priorAuthorityDigest: AUTHORITY, revisedAuthorityDigest: REVISED_AUTHORITY,
  });
  status.journal.value.entries.at(-2).authorityDigest = REVISED_AUTHORITY;
  status.journal.value.entries.at(-1).authorityDigest = REVISED_AUTHORITY;
  return status;
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
    adapter, state, HEAD, {
      id: 'different-root', sourceIds: ['different-finding'],
      fingerprint: 'different-fingerprint', disposition: 'actionable',
    },
  ), { code: 'SCOPE_ROOT_NOT_READY' });
});

test('selected root requires classification compatible with immutable task disposition', async () => {
  for (const [disposition, classification, accepted] of [
    ['actionable', 'within-scope-defect', true],
    ['actionable', 'unnecessary-mechanism-defect', true],
    ['actionable', 'unrelated-follow-up', false],
    ['out-of-scope', 'within-scope-defect', false],
    ['out-of-scope', 'unnecessary-mechanism-defect', false],
    ['out-of-scope', 'unrelated-follow-up', true],
  ]) {
    const candidate = branch(classification);
    candidate.task.disposition = disposition;
    if (accepted) {
      assert.equal(
        (await assertScopeRootReady(candidate.adapter, candidate.state, HEAD, candidate.task))
          .classification.classification,
        classification,
      );
    } else {
      await assert.rejects(
        () => assertScopeRootReady(candidate.adapter, candidate.state, HEAD, candidate.task),
        { code: 'SCOPE_ROOT_NOT_READY' },
      );
    }
  }
});

test('mismatched resolution classifications fail before workflow mutation or checkpoint', async () => {
  const actionable = integratedThreadState();
  const actionableStatus = workflowScope(actionable, 'unrelated-follow-up');
  const actionableClient = new FakeClient();
  addThread(actionableClient);
  const actionableSetup = workflow(actionable, actionableClient);
  actionableSetup.state.setScopeStatusForTest(actionableStatus);
  await assert.rejects(() => actionableSetup.api.replyResolve(2, actionable.tasks[0].id), {
    code: 'SCOPE_ROOT_NOT_READY',
  });
  assert.deepEqual(actionableClient.events, []);
  assert.deepEqual(actionableSetup.state.calls, []);

  const outOfScope = stateFixture({
    phase: 'verifying',
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['scope regression'], updatedAt: '2026-08-27T00:00:00Z',
    },
    tasks: [{
      id: 'out-of-scope-local', sourceIds: ['local:out-of-scope'], sourceType: 'local',
      fingerprint: 'out-of-scope-fingerprint', summary: 'Defer unrelated work.', severity: 'P2',
      disposition: 'out-of-scope', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Tracked separately.',
    }],
  });
  const outOfScopeStatus = workflowScope(outOfScope, 'within-scope-defect');
  const outOfScopeSetup = workflow(outOfScope, new FakeClient());
  outOfScopeSetup.state.setScopeStatusForTest(outOfScopeStatus);
  await assert.rejects(() => outOfScopeSetup.api.verifyResolve(2, [outOfScope.tasks[0].id]), {
    code: 'SCOPE_ROOT_NOT_READY',
  });
  assert.deepEqual(outOfScopeSetup.client.events, []);
  assert.deepEqual(outOfScopeSetup.state.calls, []);
});

test('compatible out-of-scope resolution remains usable without GitHub mutation', async () => {
  const state = stateFixture({
    phase: 'verifying',
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['scope regression'], updatedAt: '2026-08-27T00:00:00Z',
    },
    tasks: [{
      id: 'out-of-scope-local', sourceIds: ['local:out-of-scope'], sourceType: 'local',
      fingerprint: 'out-of-scope-fingerprint', summary: 'Defer unrelated work.', severity: 'P2',
      disposition: 'out-of-scope', status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Tracked separately.',
    }],
  });
  const status = workflowScope(state, 'unrelated-follow-up');
  const setup = workflow(state, new FakeClient());
  setup.state.setScopeStatusForTest(status);
  await setup.api.verifyResolve(2, [state.tasks[0].id]);
  assert.equal(setup.state.current.tasks[0].status, 'completed');
  assert.deepEqual(setup.client.events, []);
});

test('reply resolution rejects partial multi-root classification before mutation', async () => {
  const state = integratedThreadState();
  state.tasks[0].sourceIds = ['thread:THREAD_1', 'thread:THREAD_2'];
  const status = workflowScope(state, 'within-scope-defect');
  status.journal.value.entries[0].findingIds = status.journal.value.entries[0].findingIds.slice(0, 1);
  status.journal.value.entries[0].findingFingerprints = status.journal.value.entries[0]
    .findingFingerprints.slice(0, 1);
  const client = new FakeClient();
  addThread(client);
  addThread(client, { id: 'THREAD_2' });
  const setup = workflow(state, client);
  setup.state.setScopeStatusForTest(status);

  await assert.rejects(() => setup.api.replyResolve(2, state.tasks[0].id), {
    code: 'SCOPE_ROOT_NOT_READY',
  });
  assert.deepEqual(client.events, []);
  assert.deepEqual(setup.state.calls, []);
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

test('review request, Review-ready recovery, and Done fail closed without the exact-head manifest', async () => {
  const requestState = readyState();
  const requestSetup = workflow(requestState);
  requestSetup.state.setScopeStatusForTest(workflowScope(requestState, 'within-scope-defect'));
  await assert.rejects(() => requestSetup.api.request(2, 'discovery'), { code: 'SCOPE_EVIDENCE_INVALID' });
  assert.deepEqual(requestSetup.client.events, []);

  const recoveryState = scopeRecoveryState();
  const recoverySetup = workflow(recoveryState);
  recoverySetup.state.setScopeStatusForTest(workflowScope(recoveryState, 'within-scope-defect'));
  await assert.rejects(() => recoverySetup.api.refreshThreads(2), { code: 'SCOPE_EVIDENCE_INVALID' });
  assert.deepEqual(recoverySetup.state.calls, []);

  const doneState = completedState();
  const doneSetup = workflow(doneState);
  doneSetup.state.setScopeStatusForTest(workflowScope(doneState, 'within-scope-defect'));
  await assert.rejects(() => doneSetup.api.complete(2), { code: 'SCOPE_EVIDENCE_INVALID' });
  assert.deepEqual(doneSetup.state.calls, []);
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
  const replannedStatus = workflowScope(replannedState, 'within-scope-defect', 'ready', { integratedManifest: true });
  const replannedSetup = workflow(replannedState);
  replannedSetup.state.setScopeStatusForTest(replannedStatus);
  const requested = await replannedSetup.api.request(2, 'discovery');
  assert.equal(requested.requested, true);
  assert.equal(replannedSetup.client.events.includes('mutation:AddReviewRequest'), true);

  const recoveryState = scopeRecoveryState();
  const recoveryStatus = workflowScope(recoveryState, 'within-scope-defect', 'ready', { integratedManifest: true });
  const recoverySetup = workflow(recoveryState);
  recoverySetup.state.setScopeStatusForTest(recoveryStatus);
  assert.equal((await recoverySetup.api.refreshThreads(2)).threadResolutionStatus.status, 'passed');
  assert.equal(recoverySetup.state.calls[0].name, 'checkpointTaskCompletion');
});

test('revised authority with a fresh exact-head manifest unlocks GitHub mutation', async () => {
  const state = readyState();
  const status = amendedWorkflowScope(state);
  const setup = workflow(state);
  setup.state.setScopeStatusForTest(status);
  const requested = await setup.api.request(2, 'discovery');
  assert.equal(requested.requested, true);
  assert.equal(setup.client.events.includes('mutation:AddReviewRequest'), true);
});
