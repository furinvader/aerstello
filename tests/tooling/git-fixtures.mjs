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

export function createRepository({ remote = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'aerstello-tooling-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Aerstello Tests']);
  git(cwd, ['config', 'user.email', 'tests@aerstello.invalid']);
  commit(cwd, {
    'package.json': '{"name":"fixture","version":"9.9.9"}\n',
    'apps/api/migrations/0001_initial.sql': 'create table fixture (id integer);\n',
  }, 'initial');
  if (remote) {
    git(cwd, ['remote', 'add', 'origin', 'https://github.com/example/aerstello.git']);
    updateOriginMain(cwd);
  }
  return cwd;
}

export function updateOriginMain(cwd) {
  git(cwd, ['update-ref', 'refs/remotes/origin/main', git(cwd, ['rev-parse', 'main'])]);
}

export function marker(version, overrides = {}) {
  return `${JSON.stringify({
    schemaVersion: 1,
    product: 'aerstello',
    version,
    tag: `v${version}`,
    channel: 'production',
    releasedAt: '2026-08-04T12:00:00Z',
    ...overrides,
  }, null, 2)}\n`;
}

export function addRelease(cwd, version, {
  annotated = true,
  markerContent = marker(version),
  migrationContent,
  updateRemote = true,
} = {}) {
  const files = { [`.release/markers/v${version}.json`]: markerContent };
  if (migrationContent !== undefined) files['apps/api/migrations/0001_initial.sql'] = migrationContent;
  const sha = commit(cwd, files, `release ${version}`);
  if (annotated) git(cwd, ['tag', '-a', `v${version}`, '-m', `Release ${version}`]);
  else git(cwd, ['tag', `v${version}`]);
  if (updateRemote) updateOriginMain(cwd);
  return sha;
}
