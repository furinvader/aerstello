import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { terminateChildProcess } from '../tests/e2e/support/api-replica.ts';
import { ResourceRegistry } from '../tests/e2e/support/resource-registry.ts';
import {
  DATABASE_RESET_ARGS,
  createDatabaseResetCommand,
  executeDatabaseReset,
} from '../tests/e2e/support/reset-command.ts';
import { createScenarioState, ScenarioStateStore } from '../tests/e2e/support/scenario-state.ts';

test('database reset command preserves the seed invocation and forces reset credentials', () => {
  const env = { KEEP_ME: 'yes', E2E_RESET: 'false', SEED_ADMIN_PASSWORD: 'wrong' };
  const input = { cwd: '/worktree', env };
  const command = createDatabaseResetCommand(input);

  assert.equal(command.file, 'npm');
  assert.deepEqual(command.args, ['run', 'db:seed', '-w', '@aerstello/api']);
  assert.deepEqual(command.args, DATABASE_RESET_ARGS);
  assert.equal(command.options.cwd, '/worktree');
  assert.equal(command.options.stdio, 'pipe');
  assert.deepEqual(command.options.env, {
    KEEP_ME: 'yes',
    E2E_RESET: 'true',
    SEED_ADMIN_PASSWORD: 'AerstelloTest123!',
  });
  assert.deepEqual(env, { KEEP_ME: 'yes', E2E_RESET: 'false', SEED_ADMIN_PASSWORD: 'wrong' });
  assert.deepEqual(input, { cwd: '/worktree', env });
  assert.throws(() => command.args.push('changed'), TypeError);
  assert.throws(() => { command.options.env.KEEP_ME = 'changed'; }, TypeError);
});

test('database reset execution uses the injected runner exactly once', async () => {
  const observed = [];
  await executeDatabaseReset({ cwd: '/runner' }, async (command) => {
    observed.push(command);
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].options.cwd, '/runner');
});

test('resource registry disposes sequentially in LIFO order', async () => {
  const registry = new ResourceRegistry();
  const events = [];
  let releaseFirst;
  registry.defer('first', async () => events.push('first'));
  registry.defer('second', async () => {
    events.push('second:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('second:end');
  });

  const disposal = registry.disposeAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['second:start']);
  releaseFirst();
  await disposal;
  assert.deepEqual(events, ['second:start', 'second:end', 'first']);
});

test('explicit disposal, release, and disposeAll are idempotent and isolated', async () => {
  const first = new ResourceRegistry();
  const second = new ResourceRegistry();
  let disposed = 0;
  const explicitlyDisposed = first.defer('explicit', () => { disposed += 1; });
  const released = first.defer('released', () => { disposed += 100; });
  second.defer('other scenario', () => { disposed += 10; });

  await Promise.all([explicitlyDisposed.dispose(), explicitlyDisposed.dispose()]);
  released.release();
  released.release();
  await first.disposeAll();
  await first.disposeAll();
  assert.equal(disposed, 1);
  await second.disposeAll();
  assert.equal(disposed, 11);
});

test('resource registry rejects late registrations and aggregates labeled failures', async () => {
  const registry = new ResourceRegistry();
  const calls = [];
  registry.defer('first failure', () => { calls.push('first'); throw new Error('one'); });
  registry.defer('healthy', () => { calls.push('healthy'); });
  registry.defer('second failure', () => { calls.push('second'); throw new Error('two'); });

  const disposal = registry.disposeAll();
  assert.throws(() => registry.defer('too late', () => {}), /too late.*disposal has started/);
  await assert.rejects(disposal, (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /second failure/);
    assert.match(error.errors[1].message, /first failure/);
    return true;
  });
  assert.deepEqual(calls, ['second', 'healthy', 'first']);
});

test('scenario state factories are symbol-isolated and evaluated once per store', () => {
  let creations = 0;
  const firstState = createScenarioState('shared label', () => ({ id: ++creations }));
  const adjacentModuleState = createScenarioState('shared label', () => ({ id: ++creations }));
  const firstStore = new ScenarioStateStore();
  const retryStore = new ScenarioStateStore();

  assert.equal(firstState(firstStore), firstState(firstStore));
  assert.notEqual(firstState(firstStore), adjacentModuleState(firstStore));
  assert.notEqual(firstState(firstStore), firstState(retryStore));
  assert.equal(creations, 3);
});

test('child teardown escalates from SIGTERM to SIGKILL and awaits exit', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signals are required');
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
  });

  await terminateChildProcess(child, { terminateTimeoutMs: 25, killTimeoutMs: 2_000 });
  assert.equal(child.signalCode, 'SIGKILL');
});

test('a signal error is not mistaken for child-process exit', async () => {
  class SignalingChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    pid = 1234;
    signals = [];

    kill(signal) {
      this.signals.push(signal);
      if (signal === 'SIGTERM') {
        queueMicrotask(() => this.emit('error', new Error('simulated TERM failure')));
      } else {
        queueMicrotask(() => {
          this.signalCode = 'SIGKILL';
          this.emit('exit', null, 'SIGKILL');
        });
      }
      return true;
    }
  }

  const child = new SignalingChild();
  await terminateChildProcess(child, { terminateTimeoutMs: 5, killTimeoutMs: 100 });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
});
