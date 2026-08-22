import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultGitAdapter } from './git.mjs';

const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);

function fakeExecution({ ancestryFails = false } = {}) {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${HEAD}\n`;
    if (args[0] === 'status') return ' M changed.mjs\n';
    if (args[0] === 'rev-parse' && args[1] === '@{upstream}') return `${HEAD}\n`;
    if (args[0] === 'rev-list') return `${HEAD}\n${PARENT}\n`;
    if (args[0] === '--no-replace-objects' && args[1] === 'rev-parse') return '/repo/.git\n';
    if (args[0] === '--no-replace-objects' && args[1] === 'merge-base') {
      if (ancestryFails) throw new Error('not ancestral');
      return '';
    }
    throw new Error(`unexpected Git invocation: ${args.join(' ')}`);
  };
  return { calls, exec };
}

function missingPath() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

test('collects snapshot, upstream, and prefix evidence with exact Git arguments', () => {
  const execution = fakeExecution();
  const adapter = createDefaultGitAdapter({ exec: execution.exec, inspectPath: missingPath });
  assert.deepEqual(adapter.snapshot('/repo'), { headSha: HEAD, dirty: true });
  assert.equal(adapter.pushedHead('/repo'), HEAD);
  assert.deepEqual(adapter.resolveCommitPrefix('a', '/repo'), [HEAD]);
  assert.deepEqual(execution.calls.map(({ file, args, options }) => ({ file, args, options })), [
    {
      file: 'git', args: ['rev-parse', 'HEAD'],
      options: { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    },
    {
      file: 'git', args: ['status', '--porcelain'],
      options: { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    },
    {
      file: 'git', args: ['rev-parse', '@{upstream}'],
      options: { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    },
    {
      file: 'git', args: ['rev-list', '--all'],
      options: { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    },
  ]);
});

test('proves ancestry with actual-object authority and forces replacement refs off', () => {
  const execution = fakeExecution();
  const environment = { PATH: '/bin', GIT_NO_REPLACE_OBJECTS: 'caller-value' };
  const adapter = createDefaultGitAdapter({
    exec: execution.exec,
    inspectPath: missingPath,
    environment,
  });
  assert.equal(adapter.isAncestor(PARENT, HEAD, '/repo'), true);
  assert.deepEqual(execution.calls, [
    {
      file: 'git',
      args: ['--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      options: {
        cwd: '/repo', encoding: 'utf8',
        env: { PATH: '/bin', GIT_NO_REPLACE_OBJECTS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    },
    {
      file: 'git',
      args: ['--no-replace-objects', 'merge-base', '--is-ancestor', PARENT, HEAD],
      options: {
        cwd: '/repo',
        env: { PATH: '/bin', GIT_NO_REPLACE_OBJECTS: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    },
  ]);
});

test('returns false for unproven ancestry and any active legacy graft authority', () => {
  const failed = fakeExecution({ ancestryFails: true });
  assert.equal(createDefaultGitAdapter({
    exec: failed.exec,
    inspectPath: missingPath,
    environment: {},
  }).isAncestor(PARENT, HEAD, '/repo'), false);

  for (const stat of [
    { isFile: () => true, isSymbolicLink: () => false, size: 1 },
    { isFile: () => true, isSymbolicLink: () => true, size: 0 },
    { isFile: () => false, isSymbolicLink: () => false, size: 0 },
  ]) {
    const execution = fakeExecution();
    const adapter = createDefaultGitAdapter({
      exec: execution.exec,
      inspectPath: () => stat,
      environment: {},
    });
    assert.equal(adapter.isAncestor(PARENT, HEAD, '/repo'), false);
    assert.equal(execution.calls.length, 1, 'graft rejection must precede merge-base');
  }
});

test('accepts an inert empty regular graft file', () => {
  const execution = fakeExecution();
  const adapter = createDefaultGitAdapter({
    exec: execution.exec,
    inspectPath: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 0 }),
    environment: {},
  });
  assert.equal(adapter.isAncestor(PARENT, HEAD, '/repo'), true);
  assert.equal(execution.calls.length, 2);
});
