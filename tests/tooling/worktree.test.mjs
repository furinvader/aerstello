import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTaskWorktree,
  inspectTaskWorktree,
  removeTaskWorktree,
  sanitizeTaskId,
} from '../../scripts/lib/pr-review-worktree.mjs';
import { StateError } from '../../scripts/lib/pr-review-state.mjs';
import { createRepository, git } from './git-fixtures.mjs';

const repositories = [];

function repo() {
  const cwd = createRepository();
  repositories.push(cwd);
  return cwd;
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('worktree creation starts at the requested SHA', () => {
  const cwd = repo();
  const baseSha = git(cwd, ['rev-parse', 'HEAD']);
  const result = createTaskWorktree({ cwd, prNumber: 9, taskId: 'Finding A', base: baseSha });
  assert.equal(result.baseSha, baseSha);
  assert.equal(git(result.path, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(result.branch, 'codex/pr-9/finding-a');
});

test('task identifiers are sanitized deterministically', () => {
  assert.equal(sanitizeTaskId('  P1: API / Billing  '), 'p1-api-billing');
  assert.equal(sanitizeTaskId('A'.repeat(100)).length, 64);
});

test('worktree creation refuses a movable ref instead of an explicit SHA', () => {
  const cwd = repo();
  assert.throws(
    () => createTaskWorktree({ cwd, prNumber: 9, taskId: 'ref-base', base: 'main' }),
    (error) => error instanceof StateError && error.code === 'INVALID_WORKTREE_BASE',
  );
});

test('existing task worktree is never reused', () => {
  const cwd = repo();
  const baseSha = git(cwd, ['rev-parse', 'HEAD']);
  createTaskWorktree({ cwd, prNumber: 9, taskId: 'same', base: baseSha });
  assert.throws(
    () => createTaskWorktree({ cwd, prNumber: 9, taskId: 'same', base: baseSha }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_EXISTS',
  );
});

test('colliding sanitized task IDs cannot inspect or remove another task worktree', () => {
  const cwd = repo();
  const baseSha = git(cwd, ['rev-parse', 'HEAD']);
  createTaskWorktree({ cwd, prNumber: 9, taskId: 'finding/a', base: baseSha });
  assert.throws(
    () => inspectTaskWorktree({ cwd, prNumber: 9, taskId: 'finding-a' }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_TASK_ID_COLLISION',
  );
  assert.throws(
    () => removeTaskWorktree({ cwd, prNumber: 9, taskId: 'finding-a' }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_TASK_ID_COLLISION',
  );
});

test('dirty worktrees are not removed', () => {
  const cwd = repo();
  const baseSha = git(cwd, ['rev-parse', 'HEAD']);
  const result = createTaskWorktree({ cwd, prNumber: 9, taskId: 'dirty', base: baseSha });
  writeFileSync(join(result.path, 'dirty.txt'), 'dirty\n');
  assert.throws(
    () => removeTaskWorktree({ cwd, prNumber: 9, taskId: 'dirty' }),
    (error) => error instanceof StateError && error.code === 'DIRTY_WORKTREE',
  );
});

test('cleanup is idempotent', () => {
  const cwd = repo();
  const baseSha = git(cwd, ['rev-parse', 'HEAD']);
  createTaskWorktree({ cwd, prNumber: 9, taskId: 'clean', base: baseSha });
  assert.equal(removeTaskWorktree({ cwd, prNumber: 9, taskId: 'clean' }).status, 'removed');
  assert.equal(removeTaskWorktree({ cwd, prNumber: 9, taskId: 'clean' }).status, 'removed');
  assert.equal(inspectTaskWorktree({ cwd, prNumber: 9, taskId: 'clean' }).exists, false);
});

test('unknown paths cannot be removed', () => {
  const cwd = repo();
  assert.throws(
    () => removeTaskWorktree({ cwd, prNumber: 9, taskId: 'unknown' }),
    (error) => error instanceof StateError && error.code === 'UNKNOWN_WORKTREE',
  );
});
