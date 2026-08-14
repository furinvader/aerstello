import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkReleasedMigrations,
  inspectReleaseState,
} from './release-state.mjs';
import {
  commit,
  createRepository,
  git,
} from '../../tests/support/git-fixtures.mjs';

const repositories = [];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const releaseCli = join(testDirectory, '..', '..', 'scripts', 'release-state.mjs');
const migrationsCli = join(testDirectory, '..', '..', 'scripts', 'check-released-migrations.mjs');

function repo() {
  const cwd = createRepository({
    initialFiles: {
      'package.json': '{"name":"fixture","version":"9.9.9"}\n',
      'apps/api/migrations/0001_initial.sql': 'create table fixture (id integer);\n',
    },
  });
  repositories.push(cwd);
  return cwd;
}

function updateOriginMain(cwd) {
  git(cwd, ['update-ref', 'refs/remotes/origin/main', git(cwd, ['rev-parse', 'main'])]);
}

function marker(version, overrides = {}) {
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

function addRelease(cwd, version, {
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

function inspect(cwd, overrides = {}) {
  return inspectReleaseState({
    cwd,
    base: 'origin/main',
    head: 'HEAD',
    releaseRef: 'origin/main',
    ...overrides,
  });
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('no tags and no markers is pre-release', () => {
  const state = inspect(repo());
  assert.equal(state.status, 'pre-release');
  assert.equal(state.latestRelease, null);
  assert.deepEqual(state.frozenMigrations, []);
});

test('package version alone is not release evidence', () => {
  const cwd = repo();
  commit(cwd, { 'package.json': '{"name":"fixture","version":"1.0.0"}\n' }, 'package version');
  updateOriginMain(cwd);
  assert.equal(inspect(cwd).status, 'pre-release');
});

test('marker without tag is pending rather than released', () => {
  const cwd = repo();
  commit(cwd, { '.release/markers/v0.1.0.json': marker('0.1.0') }, 'pending marker');
  updateOriginMain(cwd);
  const state = inspect(cwd);
  assert.equal(state.status, 'pre-release');
  assert.equal(state.pendingMarkers.length, 1);
  assert.equal(state.pendingMarkers[0].valid, true);
});

test('invalid marker filename is inconsistent', () => {
  const cwd = repo();
  commit(cwd, { '.release/markers/release.json': marker('0.1.0') }, 'bad marker path');
  updateOriginMain(cwd);
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'RELEASE_MARKER_PATH_INVALID'));
});

test('lightweight release tag is inconsistent', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0', { annotated: false });
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'LIGHTWEIGHT_RELEASE_TAG'));
});

test('annotated tag without marker is inconsistent', () => {
  const cwd = repo();
  git(cwd, ['tag', '-a', 'v0.1.0', '-m', 'missing marker']);
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'RELEASE_MARKER_MISSING'));
});

test('annotated tag with malformed marker is inconsistent', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0', { markerContent: '{not json\n' });
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'RELEASE_MARKER_INVALID'));
});

test('tag and marker version mismatch is inconsistent', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0', { markerContent: marker('0.2.0') });
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'RELEASE_MARKER_INVALID'));
});

test('valid annotated tag and marker creates a release baseline', () => {
  const cwd = repo();
  const releaseSha = addRelease(cwd, '0.1.0');
  const state = inspect(cwd);
  assert.equal(state.status, 'released');
  assert.equal(state.latestRelease.tag, 'v0.1.0');
  assert.equal(state.latestRelease.commit, releaseSha);
  assert.equal(state.frozenMigrations.length, 1);
});

test('tag not reachable from release ref is inconsistent and not a baseline', () => {
  const cwd = repo();
  const main = git(cwd, ['rev-parse', 'main']);
  git(cwd, ['switch', '-c', 'side']);
  addRelease(cwd, '0.1.0', { updateRemote: false });
  git(cwd, ['switch', 'main']);
  git(cwd, ['reset', '--hard', main]);
  updateOriginMain(cwd);
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.equal(state.latestRelease, null);
  assert.ok(state.errors.some((error) => error.code === 'RELEASE_TAG_NOT_REACHABLE'));
});

test('latest release uses semantic-version order', () => {
  const cwd = repo();
  addRelease(cwd, '0.10.0');
  addRelease(cwd, '0.2.0');
  const state = inspect(cwd);
  assert.equal(state.latestRelease.tag, 'v0.10.0');
});

test('head missing the latest release baseline is stale', () => {
  const cwd = repo();
  const before = git(cwd, ['rev-parse', 'HEAD']);
  addRelease(cwd, '0.1.0');
  const state = inspect(cwd, { head: before });
  assert.equal(state.status, 'stale');
  assert.equal(state.headContainsReleaseBaseline, false);
});

test('historical released migration disagreement is inconsistent', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0', { migrationContent: 'create table one (id integer);\n' });
  addRelease(cwd, '0.2.0', { migrationContent: 'create table two (id integer);\n' });
  const state = inspect(cwd);
  assert.equal(state.status, 'inconsistent');
  assert.ok(state.errors.some((error) => error.code === 'FROZEN_MIGRATION_HISTORY_CONFLICT'));
});

test('pre-release initial migration may be edited', () => {
  const cwd = repo();
  commit(cwd, { 'apps/api/migrations/0001_initial.sql': 'create table changed (id integer);\n' }, 'rewrite initial');
  const result = checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' });
  assert.equal(result.ok, true);
});

test('released migration unchanged passes', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  assert.equal(checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' }).ok, true);
});

test('released migration modified fails', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  commit(cwd, { 'apps/api/migrations/0001_initial.sql': 'changed\n' }, 'modify migration');
  updateOriginMain(cwd);
  const result = checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.code === 'RELEASED_MIGRATION_MODIFIED'));
});

test('released migration deleted fails', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  commit(cwd, { 'apps/api/migrations/0001_initial.sql': null }, 'delete migration');
  updateOriginMain(cwd);
  const result = checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.code === 'RELEASED_MIGRATION_DELETED'));
});

test('new unreleased migration may be added and edited', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  commit(cwd, { 'apps/api/migrations/0002_new.sql': 'first\n' }, 'add migration');
  commit(cwd, { 'apps/api/migrations/0002_new.sql': 'second\n' }, 'edit migration');
  updateOriginMain(cwd);
  const result = checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' });
  assert.equal(result.ok, true);
});

test('new migration freezes only after a later valid release', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  commit(cwd, { 'apps/api/migrations/0002_new.sql': 'released content\n' }, 'add migration');
  addRelease(cwd, '0.2.0');
  commit(cwd, { 'apps/api/migrations/0002_new.sql': 'changed later\n' }, 'modify frozen migration');
  updateOriginMain(cwd);
  const result = checkReleasedMigrations({ cwd, base: 'main', head: 'HEAD', releaseRef: 'main' });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === 'apps/api/migrations/0002_new.sql'));
});

test('release-state CLI distinguishes success, policy failure, and operational failure', () => {
  const cwd = repo();
  const common = ['--base', 'main', '--head', 'HEAD', '--release-ref', 'main', '--check'];
  assert.equal(spawnSync(process.execPath, [releaseCli, ...common], { cwd }).status, 0);
  addRelease(cwd, '0.1.0', { annotated: false });
  assert.equal(spawnSync(process.execPath, [releaseCli, ...common], { cwd }).status, 1);
  assert.equal(spawnSync(process.execPath, [releaseCli, '--base', 'missing', '--check'], { cwd }).status, 2);
});

test('migration CLI exits one for a frozen migration violation', () => {
  const cwd = repo();
  addRelease(cwd, '0.1.0');
  commit(cwd, { 'apps/api/migrations/0001_initial.sql': 'changed\n' }, 'modify migration');
  const result = spawnSync(process.execPath, [
    migrationsCli,
    '--base', 'main',
    '--head', 'HEAD',
    '--release-ref', 'main',
  ], { cwd });
  assert.equal(result.status, 1);
});
