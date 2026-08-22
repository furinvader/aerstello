import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import { createWorkflowContext, escalationFor } from './context.mjs';
import {
  FakeClient, AT, fakeGit, fakeState, readyState,
} from '../test-support/workflow-harness.mjs';

test('workflow context validates adapters and reloads exact revisions', async () => {
  assert.throws(
    () => createWorkflowContext({}),
    (error) => error instanceof GitHubWorkflowError && error.code === 'INVALID_ADAPTERS',
  );
  const state = readyState();
  const context = createWorkflowContext({
    client: new FakeClient(), state: fakeState(state), git: fakeGit(),
    clock: { now: () => AT }, journal: {}, archiveStore: {},
  });
  assert.equal((await context.load(state.prNumber)).revision, state.revision);
  await assert.doesNotReject(() => context.assertCurrent(state));
});

test('workflow context bounds shared escalation evidence and head drift reason', () => {
  const state = readyState({ reviewRequest: { id: 'REQUEST', headSha: 'a'.repeat(40) } });
  const escalation = escalationFor(
    state, 'b'.repeat(40), Array.from({ length: 12 }, (_, index) => `evidence-${index}`),
    'ambiguous-canonical-evidence', AT,
  );
  assert.equal(escalation.reason, 'request-head-drift');
  assert.equal(escalation.evidenceIds.length, 8);
});
