import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubWorkflowError } from './errors.mjs';
import { assertMutationReady, assertPullRequestReady } from './mutation-readiness.mjs';

const HEAD = 'a'.repeat(40);
const TASK_HEAD = 'b'.repeat(40);

function state(overrides = {}) {
  return {
    integrationWorktree: '/repo/worktree',
    currentIntegrationHeadSha: HEAD,
    tasks: [],
    ...overrides,
  };
}

function live(metadata = {}) {
  return { metadata: { state: 'OPEN', isDraft: false, headRefOid: HEAD, ...metadata } };
}

function gitAdapter({ local = { headSha: HEAD, dirty: false }, pushed = HEAD, ancestry = true } = {}) {
  const calls = [];
  return {
    calls,
    async snapshot(cwd) { calls.push(['snapshot', cwd]); return local; },
    async pushedHead(cwd) { calls.push(['pushedHead', cwd]); return pushed; },
    async isAncestor(ancestor, descendant, cwd) {
      calls.push(['isAncestor', ancestor, descendant, cwd]);
      return ancestry;
    },
  };
}

function expectWorkflowError(code, message) {
  return (error) => {
    assert.ok(error instanceof GitHubWorkflowError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  };
}

test('pull request readiness preserves open and draft failure order', () => {
  assert.doesNotThrow(() => assertPullRequestReady(live()));
  assert.throws(
    () => assertPullRequestReady(live({ state: 'CLOSED', isDraft: true })),
    expectWorkflowError('PR_NOT_OPEN', 'Pull request is closed or merged'),
  );
  assert.throws(
    () => assertPullRequestReady(live({ isDraft: true })),
    expectWorkflowError('PR_DRAFT', 'Pull request is still a draft'),
  );
});

test('mutation readiness returns exact Git evidence and proven actionable ancestry', async () => {
  const active = state({
    tasks: [
      { id: 'integrated', disposition: 'actionable', status: 'integrated', integratedCommitSha: TASK_HEAD },
      { id: 'completed', disposition: 'actionable', status: 'completed', integratedCommitSha: TASK_HEAD },
      { id: 'pending', disposition: 'actionable', status: 'pending', integratedCommitSha: 'c'.repeat(40) },
      { id: 'non-actionable', disposition: 'stale', status: 'completed', integratedCommitSha: 'd'.repeat(40) },
    ],
  });
  const git = gitAdapter();
  const evidence = await assertMutationReady({ state: active, git }, live());

  assert.equal(evidence.localHeadSha, HEAD);
  assert.equal(evidence.localDirty, false);
  assert.equal(evidence.pushedHeadSha, HEAD);
  assert.equal(evidence.isAncestor(TASK_HEAD, HEAD), true);
  assert.equal(evidence.isAncestor('c'.repeat(40), HEAD), false);
  assert.equal(evidence.isAncestor(TASK_HEAD, 'c'.repeat(40)), false);
  assert.deepEqual(git.calls, [
    ['snapshot', '/repo/worktree'],
    ['pushedHead', '/repo/worktree'],
    ['isAncestor', TASK_HEAD, HEAD, '/repo/worktree'],
    ['isAncestor', TASK_HEAD, HEAD, '/repo/worktree'],
  ]);
});

test('mutation readiness preserves readiness, Git, head, and ancestry failure order', async () => {
  const closedGit = gitAdapter();
  await assert.rejects(
    assertMutationReady({ state: state(), git: closedGit }, live({ state: 'CLOSED' })),
    expectWorkflowError('PR_NOT_OPEN', 'Pull request is closed or merged'),
  );
  assert.deepEqual(closedGit.calls, []);

  const dirtyGit = gitAdapter({ local: { headSha: 'c'.repeat(40), dirty: true }, pushed: 'd'.repeat(40) });
  await assert.rejects(
    assertMutationReady({ state: state(), git: dirtyGit }, live({ headRefOid: 'e'.repeat(40) })),
    expectWorkflowError('MUTATION_NOT_READY', 'Integration checkout is dirty'),
  );
  assert.deepEqual(dirtyGit.calls, [
    ['snapshot', '/repo/worktree'],
    ['pushedHead', '/repo/worktree'],
  ]);

  for (const [options, metadata, message] of [
    [{ local: { headSha: 'c'.repeat(40), dirty: false } }, {}, 'local HEAD does not match state HEAD'],
    [{ pushed: 'c'.repeat(40) }, {}, 'pushed remote HEAD does not match state HEAD'],
    [{}, { headRefOid: 'c'.repeat(40) }, 'live PR HEAD does not match state HEAD'],
  ]) {
    await assert.rejects(
      assertMutationReady({ state: state(), git: gitAdapter(options) }, live(metadata)),
      expectWorkflowError('MUTATION_NOT_READY', message),
    );
  }

  const ancestryGit = gitAdapter({ ancestry: false });
  await assert.rejects(
    assertMutationReady({
      state: state({ tasks: [
        { id: 'task-a', disposition: 'actionable', status: 'integrated', integratedCommitSha: TASK_HEAD },
      ] }),
      git: ancestryGit,
    }, live()),
    expectWorkflowError('MUTATION_NOT_READY', 'Task task-a integration is not an ancestor'),
  );
});

test('mutation readiness can skip PR readiness without weakening later gates', async () => {
  const git = gitAdapter();
  const evidence = await assertMutationReady(
    { state: state(), git },
    live({ state: 'CLOSED', isDraft: true }),
    { requireReady: false },
  );
  assert.equal(evidence.localHeadSha, HEAD);

  const missingCommitGit = gitAdapter();
  await assert.rejects(
    assertMutationReady({
      state: state({ tasks: [
        { id: 'missing', disposition: 'actionable', status: 'completed', integratedCommitSha: null },
      ] }),
      git: missingCommitGit,
    }, live(), { requireReady: false }),
    expectWorkflowError('MUTATION_NOT_READY', 'Task missing integration is not an ancestor'),
  );
  assert.equal(missingCommitGit.calls.some(([name]) => name === 'isAncestor'), false);
});
