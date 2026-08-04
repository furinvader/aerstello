import { spawnSync } from 'node:child_process';

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(message, { args = [], cwd, status, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.status = status;
    this.stderr = stderr;
  }
}

export function assertSafeGitValue(value, label = 'Git value') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitError(`${label} must be a non-empty string`);
  }
  if (value.startsWith('-') || /[\0\r\n]/u.test(value)) {
    throw new GitError(`${label} contains unsupported characters`);
  }
  return value;
}

export function runGit(args, { cwd = process.cwd(), allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });

  if (result.error) {
    throw new GitError(`Unable to run Git: ${result.error.message}`, {
      args,
      cwd,
      stderr: result.error.message,
    });
  }

  if (result.status !== 0 && !allowFailure) {
    const stderr = typeof result.stderr === 'string'
      ? result.stderr.trim()
      : Buffer.from(result.stderr ?? '').toString('utf8').trim();
    throw new GitError(stderr || `Git exited with status ${result.status}`, {
      args,
      cwd,
      status: result.status,
      stderr,
    });
  }

  return result;
}

export function gitText(args, options = {}) {
  return String(runGit(args, { ...options, encoding: 'utf8' }).stdout).trim();
}

export function gitBuffer(args, options = {}) {
  return Buffer.from(runGit(args, { ...options, encoding: null }).stdout ?? Buffer.alloc(0));
}

export function resolveCommit(cwd, ref) {
  assertSafeGitValue(ref, 'Git ref');
  return gitText(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd });
}

export function resolveAbsoluteGitPath(cwd, pathName) {
  assertSafeGitValue(pathName, 'Git path name');
  return gitText(['rev-parse', '--path-format=absolute', pathName], { cwd });
}

export function isAncestor(cwd, ancestor, descendant) {
  assertSafeGitValue(ancestor, 'Ancestor commit');
  assertSafeGitValue(descendant, 'Descendant commit');
  const result = runGit(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const stderr = String(result.stderr ?? '').trim();
  throw new GitError(stderr || `Unable to compare commits ${ancestor} and ${descendant}`, {
    args: ['merge-base', '--is-ancestor', ancestor, descendant],
    cwd,
    status: result.status,
    stderr,
  });
}

export function readTreeFile(cwd, commit, path) {
  assertSafeGitValue(commit, 'Commit');
  assertSafeGitValue(path, 'Tree path');
  const result = runGit(['show', `${commit}:${path}`], {
    cwd,
    allowFailure: true,
    encoding: null,
  });
  if (result.status !== 0) {
    const stderr = Buffer.from(result.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    if (/(?:does not exist in|exists on disk, but not in)/u.test(stderr)) return null;
    throw new GitError(stderr || `Unable to read ${path} from ${commit}`, {
      args: ['show', `${commit}:${path}`],
      cwd,
      status: result.status,
      stderr,
    });
  }
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

export function listTree(cwd, commit, pathPrefix) {
  assertSafeGitValue(commit, 'Commit');
  assertSafeGitValue(pathPrefix, 'Tree path prefix');
  const output = gitBuffer(['ls-tree', '-r', '-z', '--full-tree', commit, '--', pathPrefix], { cwd });
  if (output.length === 0) return [];

  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      if (tab < 0) throw new GitError(`Unexpected git ls-tree output: ${record}`);
      const [mode, type, object] = record.slice(0, tab).split(' ');
      return { mode, type, object, path: record.slice(tab + 1) };
    });
}

export function blobAtPath(cwd, commit, path) {
  const entry = listTree(cwd, commit, path).find((item) => item.path === path && item.type === 'blob');
  return entry?.object ?? null;
}
