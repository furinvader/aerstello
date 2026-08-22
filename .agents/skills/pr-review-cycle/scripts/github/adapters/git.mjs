import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

function gitText(exec, cwd, args) {
  return exec('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function actualObjectGitText(exec, environment, cwd, args) {
  return exec('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...environment, GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertLegacyGraftsAreInert(exec, inspectPath, environment, cwd) {
  const commonGitDirectory = actualObjectGitText(
    exec, environment, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  );
  if (commonGitDirectory.length === 0) throw new Error('Git common directory is unavailable');
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  let stat;
  try {
    stat = inspectPath(graftsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
    throw new Error(`Actual-object ancestry refuses legacy grafts at ${graftsPath}`);
  }
}

export function createDefaultGitAdapter({
  exec = execFileSync,
  inspectPath = lstatSync,
  environment = process.env,
} = {}) {
  return {
    snapshot: (cwd) => ({
      headSha: gitText(exec, cwd, ['rev-parse', 'HEAD']),
      dirty: gitText(exec, cwd, ['status', '--porcelain']).length > 0,
    }),
    pushedHead: (cwd) => gitText(exec, cwd, ['rev-parse', '@{upstream}']),
    isAncestor: (ancestor, descendant, cwd) => {
      try {
        assertLegacyGraftsAreInert(exec, inspectPath, environment, cwd);
        exec(
          'git',
          ['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant],
          {
            cwd,
            env: { ...environment, GIT_NO_REPLACE_OBJECTS: '1' },
            stdio: ['ignore', 'ignore', 'ignore'],
          },
        );
        return true;
      } catch {
        return false;
      }
    },
    resolveCommitPrefix: (prefix, cwd) => gitText(exec, cwd, ['rev-list', '--all'])
      .split('\n').filter((sha) => sha.startsWith(prefix)),
  };
}
