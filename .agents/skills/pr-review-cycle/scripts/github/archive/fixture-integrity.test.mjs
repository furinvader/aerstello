import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  ARCHIVE_FIXTURE_MANIFEST,
  ARCHIVE_FIXTURE_ROOT,
  ArchiveFixtureError,
  loadArchiveFixture,
  PACKET_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_NAME,
} from './archive-fixture-loader.mjs';

const ARCHIVE_IDS = Object.freeze([
  PACKET_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_NAME,
]);

const EXPECTED_BYTES = Object.freeze({
  [PACKET_ARCHIVE_NAME]: Object.freeze({ state: 11_181, events: 13_045, lines: 59 }),
  [PACKET_MIXED_ARCHIVE_NAME]: Object.freeze({ state: 15_618, events: 11_725, lines: 52 }),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function copyArchive(t, archiveId = PACKET_ARCHIVE_NAME) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'aerstello-archive-fixture-'));
  t.after(() => rmSync(rootDirectory, { recursive: true, force: true }));
  const source = join(ARCHIVE_FIXTURE_ROOT, archiveId);
  const destination = join(rootDirectory, archiveId);
  mkdirSync(destination);
  copyFileSync(join(source, 'state.json'), join(destination, 'state.json'));
  copyFileSync(join(source, 'events.ndjson'), join(destination, 'events.ndjson'));
  return { rootDirectory, directory: destination };
}

function manifestFor(rootDirectory, archiveId = PACKET_ARCHIVE_NAME) {
  const directory = join(rootDirectory, archiveId);
  return {
    [archiveId]: {
      stateSha256: sha256(readFileSync(join(directory, 'state.json'))),
      eventsSha256: sha256(readFileSync(join(directory, 'events.ndjson'))),
    },
  };
}

function assertFixtureError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ArchiveFixtureError);
    assert.equal(error.code, code);
    return true;
  });
}

test('checked-in archive fixtures have an exact local inventory and byte identity before fresh parsing', () => {
  const entries = readdirSync(ARCHIVE_FIXTURE_ROOT, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(entries.map(({ name }) => name), [...ARCHIVE_IDS].sort());
  assert.ok(entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()));

  for (const archiveId of ARCHIVE_IDS) {
    const first = loadArchiveFixture(archiveId);
    const second = loadArchiveFixture(archiveId);
    const expected = EXPECTED_BYTES[archiveId];
    assert.equal(first.stateBytes.length, expected.state);
    assert.equal(first.eventsBytes.length, expected.events);
    assert.equal(first.events.length, expected.lines);
    assert.equal(sha256(first.stateBytes), ARCHIVE_FIXTURE_MANIFEST[archiveId].stateSha256);
    assert.equal(sha256(first.eventsBytes), ARCHIVE_FIXTURE_MANIFEST[archiveId].eventsSha256);
    assert.equal(first.stateBytes.at(-1), 0x0a);
    assert.notEqual(first.stateBytes.at(-2), 0x0a);
    assert.equal(first.eventsBytes.at(-1), 0x0a);
    assert.notEqual(first.eventsBytes.at(-2), 0x0a);
    assert.notStrictEqual(first.stateBytes, second.stateBytes);
    assert.notStrictEqual(first.eventsBytes, second.eventsBytes);
    assert.notStrictEqual(first.state, second.state);
    assert.notStrictEqual(first.events, second.events);
    assert.deepEqual(first.state, second.state);
    assert.deepEqual(first.events, second.events);
  }
});

test('archive fixture loading rejects byte drift and truncation before parsing', (t) => {
  {
    const { rootDirectory, directory } = copyArchive(t);
    const bytes = readFileSync(join(directory, 'state.json'));
    bytes[0] ^= 1;
    writeFileSync(join(directory, 'state.json'), bytes);
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, { rootDirectory }),
      'FIXTURE_DIGEST_MISMATCH',
    );
  }
  {
    const { rootDirectory, directory } = copyArchive(t);
    const bytes = readFileSync(join(directory, 'events.ndjson'));
    writeFileSync(join(directory, 'events.ndjson'), bytes.subarray(0, -17));
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, { rootDirectory }),
      'FIXTURE_DIGEST_MISMATCH',
    );
  }
});

test('archive fixture loading rejects unexpected entries and non-regular evidence files', (t) => {
  {
    const { rootDirectory, directory } = copyArchive(t);
    writeFileSync(join(directory, 'unexpected.txt'), 'unexpected\n');
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, { rootDirectory }),
      'FIXTURE_DIRECTORY_DRIFT',
    );
  }
  {
    const { rootDirectory, directory } = copyArchive(t);
    rmSync(join(directory, 'state.json'));
    symlinkSync('events.ndjson', join(directory, 'state.json'));
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, { rootDirectory }),
      'FIXTURE_ENTRY_TYPE',
    );
  }
});

test('archive fixture loading rejects malformed JSON, malformed NDJSON, and newline normalization', (t) => {
  {
    const { rootDirectory, directory } = copyArchive(t);
    writeFileSync(join(directory, 'state.json'), '{"incomplete":\n');
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, {
        rootDirectory,
        manifest: manifestFor(rootDirectory),
      }),
      'FIXTURE_JSON_INVALID',
    );
  }
  {
    const { rootDirectory, directory } = copyArchive(t);
    writeFileSync(join(directory, 'events.ndjson'), '{"valid":true}\nnot-json\n');
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, {
        rootDirectory,
        manifest: manifestFor(rootDirectory),
      }),
      'FIXTURE_NDJSON_INVALID',
    );
  }
  {
    const { rootDirectory, directory } = copyArchive(t);
    const stateBytes = readFileSync(join(directory, 'state.json'));
    writeFileSync(join(directory, 'state.json'), stateBytes.subarray(0, -1));
    assertFixtureError(
      () => loadArchiveFixture(PACKET_ARCHIVE_NAME, {
        rootDirectory,
        manifest: manifestFor(rootDirectory),
      }),
      'FIXTURE_NEWLINE_MISMATCH',
    );
  }
});
