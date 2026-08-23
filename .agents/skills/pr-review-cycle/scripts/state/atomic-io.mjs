import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { StateError } from './errors.mjs';

export function serializeJson(value) {
  return `${JSON.stringify(value)}\n`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function canonicalSerializedJson(value) {
  return serializeJson(canonicalJson(value));
}

export function atomicWriteText(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = openSync(temporary, 'wx', 0o600);
    writeFileSync(handle, data, 'utf8');
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, path);
    try {
      const directoryHandle = openSync(dirname(path), 'r');
      fsyncSync(directoryHandle);
      closeSync(directoryHandle);
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteText(path, serializeJson(value));
}

export function readJsonSidecar(path, label, limit = 64 * 1024) {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    return JSON.parse(source);
  } catch (error) {
    throw new StateError(`Unable to read ${label} at ${path}: ${error.message}`, 'INVALID_DURABLE_SIDECAR');
  }
}
