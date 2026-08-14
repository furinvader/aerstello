import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gitText, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { atomicWriteJson, gitCommonDirectory, reviewRoot, StateError } from '../state/state.mjs';

function parsePrNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new StateError('PR number must be a positive integer', 'INVALID_PR_NUMBER');
  return number;
}

export function sanitizeTaskId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new StateError('Task ID is required', 'INVALID_TASK_ID');
  const sanitized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
  if (!sanitized) throw new StateError('Task ID has no safe characters', 'INVALID_TASK_ID');
  return sanitized;
}

function worktreeBase(cwd) {
  return join(reviewRoot(cwd), 'worktrees');
}

function expectedPath(cwd, prNumber, slug) {
  return join(worktreeBase(cwd), `pr-${prNumber}`, slug);
}

function manifestPath(cwd, prNumber, slug) {
  return join(worktreeBase(cwd), 'manifests', `pr-${prNumber}`, `${slug}.json`);
}

function loadManifest(cwd, prNumber, slug) {
  const path = manifestPath(cwd, prNumber, slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StateError(`Invalid worktree manifest ${path}: ${error.message}`, 'INVALID_WORKTREE_MANIFEST');
  }
}

function registeredWorktrees(cwd) {
  const text = gitText(['worktree', 'list', '--porcelain'], { cwd });
  const records = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('HEAD ')) current.headSha = line.slice('HEAD '.length);
    else if (current && line.startsWith('branch ')) current.branchRef = line.slice('branch '.length);
    else if (current && line === 'detached') current.detached = true;
  }
  if (current) records.push(current);
  return records;
}

function publicManifest(manifest) {
  return {
    schemaVersion: 1,
    prNumber: manifest.prNumber,
    taskId: manifest.taskId,
    path: manifest.path,
    branch: manifest.branch,
    detached: manifest.detached,
    baseSha: manifest.baseSha,
    status: manifest.status,
  };
}

export function createTaskWorktree({ cwd = process.cwd(), prNumber, taskId, base, detached = false } = {}) {
  const pr = parsePrNumber(prNumber);
  const slug = sanitizeTaskId(taskId);
  if (typeof base !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(base)) {
    throw new StateError('Worktree base must be an explicit full commit SHA', 'INVALID_WORKTREE_BASE');
  }
  const baseSha = resolveCommit(cwd, base);
  if (baseSha !== base) throw new StateError('Worktree base did not resolve to the supplied commit SHA', 'INVALID_WORKTREE_BASE');
  const path = expectedPath(cwd, pr, slug);
  const manifestFile = manifestPath(cwd, pr, slug);
  const previous = loadManifest(cwd, pr, slug);
  if (previous && previous.taskId !== taskId) {
    throw new StateError(
      `Task ID ${taskId} collides with existing task ${previous.taskId}`,
      'WORKTREE_TASK_ID_COLLISION',
    );
  }
  if (previous?.status === 'active') throw new StateError(`Task worktree already exists at ${previous.path}`, 'WORKTREE_EXISTS');
  if (existsSync(path)) throw new StateError(`Refusing to reuse existing path ${path}`, 'WORKTREE_PATH_EXISTS');

  mkdirSync(dirname(path), { recursive: true });
  const branch = detached ? null : `codex/pr-${pr}/${slug}`;
  if (branch) {
    const branchResult = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, allowFailure: true });
    if (branchResult.status === 0) throw new StateError(`Branch ${branch} already exists`, 'WORKTREE_BRANCH_EXISTS');
    runGit(['worktree', 'add', '-b', branch, path, baseSha], { cwd });
  } else {
    runGit(['worktree', 'add', '--detach', path, baseSha], { cwd });
  }

  const manifest = {
    schemaVersion: 1,
    prNumber: pr,
    taskId,
    slug,
    path,
    branch,
    detached: Boolean(detached),
    baseSha,
    status: 'active',
    createdAt: new Date().toISOString(),
    removedAt: null,
    gitCommonDir: gitCommonDirectory(cwd),
  };
  atomicWriteJson(manifestFile, manifest);
  return publicManifest(manifest);
}

export function inspectTaskWorktree({ cwd = process.cwd(), prNumber, taskId } = {}) {
  const pr = parsePrNumber(prNumber);
  const slug = sanitizeTaskId(taskId);
  const manifest = loadManifest(cwd, pr, slug);
  if (!manifest) throw new StateError('Unknown task worktree', 'UNKNOWN_WORKTREE');
  if (manifest.taskId !== taskId) throw new StateError('Task ID does not own this worktree manifest', 'WORKTREE_TASK_ID_COLLISION');
  const expected = resolve(expectedPath(cwd, pr, slug));
  if (resolve(manifest.path) !== expected) throw new StateError('Manifest path is outside the owned worktree location', 'UNSAFE_WORKTREE_PATH');
  const registered = registeredWorktrees(cwd).find((item) => resolve(item.path) === expected) ?? null;
  return { ...publicManifest(manifest), exists: existsSync(expected), registered };
}

export function removeTaskWorktree({ cwd = process.cwd(), prNumber, taskId } = {}) {
  const pr = parsePrNumber(prNumber);
  const slug = sanitizeTaskId(taskId);
  const manifestFile = manifestPath(cwd, pr, slug);
  const manifest = loadManifest(cwd, pr, slug);
  if (!manifest) throw new StateError('Unknown task worktree; refusing cleanup', 'UNKNOWN_WORKTREE');
  if (manifest.taskId !== taskId) throw new StateError('Task ID does not own this worktree manifest', 'WORKTREE_TASK_ID_COLLISION');
  const expected = resolve(expectedPath(cwd, pr, slug));
  if (resolve(manifest.path) !== expected) throw new StateError('Manifest path is outside the owned worktree location', 'UNSAFE_WORKTREE_PATH');
  if (manifest.status === 'removed') return publicManifest(manifest);

  const registration = registeredWorktrees(cwd).find((item) => resolve(item.path) === expected);
  if (existsSync(expected)) {
    if (!registration) throw new StateError('Owned path exists but is not a registered Git worktree', 'UNREGISTERED_WORKTREE_PATH');
    const dirty = gitText(['status', '--porcelain'], { cwd: expected });
    if (dirty) throw new StateError(`Worktree ${expected} is dirty`, 'DIRTY_WORKTREE');
    runGit(['worktree', 'remove', expected], { cwd });
  } else if (registration) {
    throw new StateError('Git still registers a missing worktree; run git worktree prune manually', 'MISSING_REGISTERED_WORKTREE');
  }

  const removed = { ...manifest, status: 'removed', removedAt: new Date().toISOString() };
  atomicWriteJson(manifestFile, removed);
  return publicManifest(removed);
}
