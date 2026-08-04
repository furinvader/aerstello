import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATE_LIMIT_BYTES,
  archiveState,
  checkpointState,
  gitCommonDirectory,
  initializeState,
  loadState,
  reconcileState,
  renderRecoverySummary,
  reviewRoot,
  statePath,
  StateError,
  withStateLock,
} from '../../scripts/lib/pr-review-state.mjs';
import { commit, createRepository, git } from './git-fixtures.mjs';

const repositories = [];

function repo() {
  const cwd = createRepository();
  repositories.push(cwd);
  return cwd;
}

function init(cwd, overrides = {}) {
  return initializeState({
    cwd,
    prNumber: 17,
    base: 'main',
    head: 'HEAD',
    releaseRef: 'main',
    ...overrides,
  });
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    sourceIds: ['review:1'],
    fingerprint: 'fingerprint-0001',
    summary: 'Resolve the bounded review finding',
    severity: 'P1',
    disposition: 'actionable',
    status: 'queued',
    dependencies: [],
    ownedPaths: ['src/example.ts'],
    worker: 'review_fix_worker',
    branch: null,
    worktree: null,
    commitSha: null,
    validationSummaries: [],
    lastError: null,
    ...overrides,
  };
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('initialization uses the absolute Git common directory', () => {
  const cwd = repo();
  const state = init(cwd);
  assert.equal(state.repository, 'example/sky-bar');
  assert.equal(statePath(cwd, 17), join(gitCommonDirectory(cwd), 'codex', 'pr-review', 'pr-17', 'state.json'));
  assert.ok(existsSync(statePath(cwd, 17)));
});

test('checkpoint writes atomically and increments revision', () => {
  const cwd = repo();
  const state = init(cwd);
  const updated = checkpointState({
    cwd,
    nextState: { ...state, phase: 'triaging', nextAction: 'Triage the applicable review.' },
    expectedRevision: 0,
  });
  assert.equal(updated.revision, 1);
  assert.equal(loadState(cwd).phase, 'triaging');
  const leftovers = readdirSync(join(reviewRoot(cwd), 'pr-17')).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('invalid state schema is rejected', () => {
  const cwd = repo();
  init(cwd);
  const path = statePath(cwd, 17);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.phase = 'invented';
  writeFileSync(path, JSON.stringify(state));
  assert.throws(() => loadState(cwd), (error) => error instanceof StateError && error.code === 'INVALID_STATE');
});

test('oversized active state is rejected', () => {
  const cwd = repo();
  const state = init(cwd);
  const decisions = Array.from({ length: 40 }, (_, index) => ({
    id: `decision-${index}`,
    summary: 'x'.repeat(900),
  }));
  assert.throws(
    () => checkpointState({ cwd, nextState: { ...state, decisions }, expectedRevision: 0 }),
    (error) => error instanceof StateError && error.code === 'STATE_TOO_LARGE',
  );
  assert.ok(Buffer.byteLength(JSON.stringify({ ...state, decisions })) > ACTIVE_STATE_LIMIT_BYTES);
  writeFileSync(statePath(cwd, 17), JSON.stringify({ ...state, decisions }));
  assert.throws(
    () => loadState(cwd),
    (error) => error instanceof StateError && error.code === 'STATE_TOO_LARGE',
  );
});

test('recovery summary is concise and excludes raw error details', () => {
  const cwd = repo();
  const state = init(cwd);
  const updated = checkpointState({
    cwd,
    nextState: {
      ...state,
      tasks: [task({ lastError: 'RAW_SECRET_STACK_TRACE_SHOULD_NOT_APPEAR' })],
      decisions: [{ id: 'decision-1', summary: 'Use the smallest safe fix.' }],
      nextAction: 'Delegate task-1.',
    },
    expectedRevision: 0,
  });
  assert.equal(updated.revision, 1);
  const summary = renderRecoverySummary({ cwd });
  assert.ok(summary.length < 9000);
  assert.match(summary, /task-1 \[queued\]/u);
  assert.doesNotMatch(summary, /RAW_SECRET_STACK_TRACE/u);
});

test('HEAD mismatch creates a reconciliation warning', () => {
  const cwd = repo();
  init(cwd);
  commit(cwd, { 'new.txt': 'new\n' }, 'new head');
  const result = reconcileState({ cwd });
  assert.ok(result.warnings.some((warning) => warning.startsWith('Integration HEAD is')));
});

test('concurrent lock attempts time out instead of overlapping', async () => {
  const cwd = repo();
  const fixture = new URL('./fixtures/hold-state-lock.mjs', import.meta.url);
  const child = spawn(process.execPath, [fixture.pathname, cwd, '17', '350'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolveLocked, reject) => {
    child.stdout.once('data', (chunk) => {
      if (chunk.toString().includes('locked')) resolveLocked();
      else reject(new Error(`Unexpected child output: ${chunk}`));
    });
    child.once('error', reject);
  });
  assert.throws(
    () => withStateLock(cwd, 17, () => {}, { timeoutMs: 75, staleMs: 1000 }),
    (error) => error instanceof StateError && error.code === 'STATE_LOCK_TIMEOUT',
  );
  await new Promise((resolveExit, reject) => {
    child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`Lock holder exited ${code}`)));
  });
});

test('archive preserves the cycle and clears the active pointer', () => {
  const cwd = repo();
  init(cwd);
  const archived = archiveState({ cwd });
  assert.ok(existsSync(join(archived, 'state.json')));
  assert.equal(loadState(cwd), null);
});

test('revision mismatch rejects stale updates', () => {
  const cwd = repo();
  const state = init(cwd);
  checkpointState({ cwd, nextState: { ...state, nextAction: 'First update.' }, expectedRevision: 0 });
  assert.throws(
    () => checkpointState({ cwd, nextState: { ...state, nextAction: 'Stale update.' }, expectedRevision: 0 }),
    (error) => error instanceof StateError && error.code === 'STATE_REVISION_CONFLICT',
  );
});
