import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateError } from './errors.mjs';
import {
  legacyLockPath, legacyRequestOwnerLockPath, lockPath, requestOwnerLockPath,
} from './locations.mjs';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
const LOCK_RETRY_INTERVAL_MS = 25;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isSqliteBusy(error) { return error?.errcode === SQLITE_BUSY; }

function openLockDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path, { timeout: 0 });
}

function lockTimeout(path) {
  return new StateError(`Timed out waiting for ${path}`, 'STATE_LOCK_TIMEOUT');
}

function ensureLegacyBarrierSync(path, timeoutMs) {
  const started = Date.now();
  while (true) {
    try { mkdirSync(path, { mode: 0o700 }); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try { if (lstatSync(path).isDirectory()) return; } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - started >= timeoutMs) throw lockTimeout(path);
    sleep(LOCK_RETRY_INTERVAL_MS);
  }
}

async function ensureLegacyBarrierAsync(path, timeoutMs) {
  const started = Date.now();
  while (true) {
    try { mkdirSync(path, { mode: 0o700 }); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try { if (lstatSync(path).isDirectory()) return; } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (Date.now() - started >= timeoutMs) throw lockTimeout(path);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_INTERVAL_MS));
  }
}

function beginExclusiveSync(database, path, timeoutMs) {
  const started = Date.now();
  while (true) {
    try { database.exec('BEGIN EXCLUSIVE'); return; } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (Date.now() - started >= timeoutMs) throw lockTimeout(path);
      sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

async function beginExclusiveAsync(database, path, timeoutMs) {
  const started = Date.now();
  while (true) {
    try { database.exec('BEGIN EXCLUSIVE'); return; } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (Date.now() - started >= timeoutMs) throw lockTimeout(path);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_INTERVAL_MS));
    }
  }
}

function rollbackQuietly(database) { try { database.exec('ROLLBACK'); } catch { /* preserve error */ } }
function closeQuietly(database) { try { database.close(); } catch { /* preserve error */ } }

export function withStateLock(cwd, prNumber, callback, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const path = lockPath(cwd, prNumber);
  const started = Date.now();
  const database = openLockDatabase(path);
  try {
    beginExclusiveSync(database, path, timeoutMs);
    ensureLegacyBarrierSync(legacyLockPath(cwd, prNumber), Math.max(0, timeoutMs - (Date.now() - started)));
  } catch (error) { rollbackQuietly(database); closeQuietly(database); throw error; }
  try {
    const result = callback();
    database.exec('COMMIT');
    database.close();
    return result;
  } catch (error) { rollbackQuietly(database); closeQuietly(database); throw error; }
}

export async function withGitHubRequestOwnerLock(cwd, prNumber, callback, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
  const path = requestOwnerLockPath(cwd, prNumber);
  const started = Date.now();
  const database = openLockDatabase(path);
  try {
    await beginExclusiveAsync(database, path, timeoutMs);
    await ensureLegacyBarrierAsync(legacyRequestOwnerLockPath(cwd, prNumber), Math.max(0, timeoutMs - (Date.now() - started)));
  } catch (error) { rollbackQuietly(database); closeQuietly(database); throw error; }
  try {
    const result = await callback();
    database.exec('COMMIT');
    database.close();
    return result;
  } catch (error) { rollbackQuietly(database); closeQuietly(database); throw error; }
}
