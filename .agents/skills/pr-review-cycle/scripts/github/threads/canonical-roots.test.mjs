import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCanonicalRootPlan, canonicalRootsForTask } from './canonical-roots.mjs';

const HEAD = 'a'.repeat(40);

function task(id, sourceIds, overrides = {}) {
  return {
    id,
    sourceIds,
    sourceType: 'github-thread',
    disposition: 'actionable',
    status: 'integrated',
    integratedCommitSha: HEAD,
    ...overrides,
  };
}

function thread(id, databaseId, canonical = true) {
  return { id, canonical, root: { databaseId } };
}

function state(tasks) {
  return {
    currentIntegrationHeadSha: HEAD,
    validationStatus: { status: 'passed', headSha: HEAD, checks: ['npm run check'] },
    tasks,
  };
}

test('canonical roots retain opaque IDs and deduplicate explicit thread and discussion sources', () => {
  const root = thread('THREAD:%2Fopaque', 41);
  assert.deepEqual(
    canonicalRootsForTask(task('opaque/task', ['thread:THREAD:%2Fopaque', 'discussion:41']), { threads: [root] }),
    [root],
  );
});

test('canonical root plans sort roots and shared tasks while preserving selected multi-root mapping', () => {
  const roots = [thread('THREAD_B', 42), thread('THREAD_A', 41)];
  const tasks = [
    task('z-task', ['thread:THREAD_A', 'thread:THREAD_B']),
    task('a-task', ['discussion:41']),
  ];
  const result = buildCanonicalRootPlan(state(tasks), { threads: roots }, 'z-task');
  assert.deepEqual(result.plan.map((entry) => entry.thread.id), ['THREAD_A', 'THREAD_B']);
  assert.deepEqual(result.plan[0].tasks.map((item) => item.id), ['a-task', 'z-task']);
  assert.deepEqual(result.selectedPlan.map((entry) => entry.thread.id), ['THREAD_A', 'THREAD_B']);
  assert.equal(result.selected.id, 'z-task');
});

test('canonical planning fails closed for conflicting shared dispositions and unmapped roots', () => {
  const root = thread('THREAD_A', 41);
  assert.throws(() => buildCanonicalRootPlan(state([
    task('fixed', ['thread:THREAD_A']),
    task('stale', ['discussion:41'], {
      disposition: 'stale', status: 'not-applicable', integratedCommitSha: null,
    }),
  ]), { threads: [root] }), { code: 'ROOT_IDENTITY_MISMATCH' });

  assert.throws(() => buildCanonicalRootPlan(state([]), { threads: [root] }), {
    code: 'ROOT_IDENTITY_MISMATCH',
  });
});

test('canonical planning validates the complete task set before returning a selected plan', () => {
  const root = thread('THREAD_A', 41);
  assert.throws(() => buildCanonicalRootPlan(state([
    task('selected', ['thread:THREAD_A']),
    task('not-ready', ['local'], { sourceType: 'local', status: 'proposed', integratedCommitSha: null }),
  ]), { threads: [root] }, 'selected'), { code: 'TASK_NOT_READY' });
});
