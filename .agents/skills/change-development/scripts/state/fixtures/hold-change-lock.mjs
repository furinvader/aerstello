#!/usr/bin/env node
import { withChangeLock } from '../state.mjs';

const [cwd, changeId, milliseconds = '10000'] = process.argv.slice(2);
if (!cwd || !changeId) throw new Error('usage: hold-change-lock.mjs <cwd> <change-id> [milliseconds]');
withChangeLock(cwd, changeId, () => {
  process.stdout.write('locked\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(milliseconds));
});
