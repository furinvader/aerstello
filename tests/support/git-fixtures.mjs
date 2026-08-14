import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function writeFiles(cwd, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(cwd, path);
    if (content === null) {
      rmSync(absolute, { force: true });
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

export function commit(cwd, files, message = 'test commit') {
  writeFiles(cwd, files);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function createRepository({
  remote = true,
  directoryPrefix = 'aerstello-tooling-',
  initialFiles = { 'README.md': 'fixture repository\n' },
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), directoryPrefix));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Aerstello Tests']);
  git(cwd, ['config', 'user.email', 'tests@aerstello.invalid']);
  commit(cwd, initialFiles, 'initial');
  if (remote) {
    git(cwd, ['remote', 'add', 'origin', 'https://github.com/example/aerstello.git']);
    git(cwd, ['update-ref', 'refs/remotes/origin/main', git(cwd, ['rev-parse', 'main'])]);
  }
  return cwd;
}
