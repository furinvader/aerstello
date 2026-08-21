import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKET_ARCHIVE_NAME = 'pr-35-2026-08-19T16-31-55-612Z';
export const PACKET_MIXED_ARCHIVE_NAME = 'pr-35-2026-08-20T09-39-32-610Z';

export const ARCHIVE_FIXTURE_MANIFEST = Object.freeze({
  [PACKET_ARCHIVE_NAME]: Object.freeze({
    stateSha256: 'ac8dd7fa0dd9a0e621f7426b5dba14af45578964a42f8bcfae738577d9c7f43b',
    eventsSha256: '8d0d2be88b209ade5a38379bc4959acd9370569366527ed3e0cd71a4944b70f6',
  }),
  [PACKET_MIXED_ARCHIVE_NAME]: Object.freeze({
    stateSha256: 'aae507307c8c5b84aed64652c714d576f4d68870d07a1cf859e674af2908a566',
    eventsSha256: '4fa3e4f19839a694adebba9d482a766d8f145e4945f807bf6243f3f1ecd08759',
  }),
});

export const ARCHIVE_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const EXPECTED_FILES = Object.freeze(['events.ndjson', 'state.json']);

export class ArchiveFixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveFixtureError';
    this.code = code;
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireSingleTerminalLf(bytes, label) {
  if (
    bytes.length < 2
    || bytes[bytes.length - 1] !== 0x0a
    || bytes[bytes.length - 2] === 0x0a
    || bytes[bytes.length - 2] === 0x0d
  ) {
    throw new ArchiveFixtureError(
      'FIXTURE_NEWLINE_MISMATCH',
      `${label} must end with exactly one LF byte`,
    );
  }
}

function parseState(bytes, archiveId) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new TypeError('state root must be an object');
    }
    return value;
  } catch (error) {
    throw new ArchiveFixtureError(
      'FIXTURE_JSON_INVALID',
      `Archive fixture ${archiveId} state.json is invalid JSON: ${error.message}`,
    );
  }
}

function parseEvents(bytes, archiveId) {
  const text = bytes.subarray(0, -1).toString('utf8');
  const lines = text.split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw new ArchiveFixtureError(
      'FIXTURE_NDJSON_INVALID',
      `Archive fixture ${archiveId} events.ndjson contains a blank line`,
    );
  }
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        throw new TypeError('event root must be an object');
      }
      return value;
    } catch (error) {
      throw new ArchiveFixtureError(
        'FIXTURE_NDJSON_INVALID',
        `Archive fixture ${archiveId} events.ndjson line ${index + 1} is invalid: ${error.message}`,
      );
    }
  });
}

export function loadArchiveFixture(
  archiveId,
  {
    rootDirectory = ARCHIVE_FIXTURE_ROOT,
    manifest = ARCHIVE_FIXTURE_MANIFEST,
  } = {},
) {
  const expected = manifest[archiveId];
  if (!expected) {
    throw new ArchiveFixtureError(
      'UNKNOWN_ARCHIVE_FIXTURE',
      `Unknown archive fixture: ${archiveId}`,
    );
  }

  const archiveDirectory = join(rootDirectory, archiveId);
  const entries = readdirSync(archiveDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = entries.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_FILES)) {
    throw new ArchiveFixtureError(
      'FIXTURE_DIRECTORY_DRIFT',
      `Archive fixture ${archiveId} must contain exactly ${EXPECTED_FILES.join(' and ')}`,
    );
  }
  for (const entry of entries) {
    const path = join(archiveDirectory, entry.name);
    if (!entry.isFile() || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new ArchiveFixtureError(
        'FIXTURE_ENTRY_TYPE',
        `Archive fixture ${archiveId}/${entry.name} must be a regular file`,
      );
    }
  }

  const stateBytes = readFileSync(join(archiveDirectory, 'state.json'));
  const eventsBytes = readFileSync(join(archiveDirectory, 'events.ndjson'));
  const stateDigest = digest(stateBytes);
  const eventsDigest = digest(eventsBytes);
  if (stateDigest !== expected.stateSha256) {
    throw new ArchiveFixtureError(
      'FIXTURE_DIGEST_MISMATCH',
      `Archive fixture ${archiveId}/state.json SHA-256 mismatch`,
    );
  }
  if (eventsDigest !== expected.eventsSha256) {
    throw new ArchiveFixtureError(
      'FIXTURE_DIGEST_MISMATCH',
      `Archive fixture ${archiveId}/events.ndjson SHA-256 mismatch`,
    );
  }

  requireSingleTerminalLf(stateBytes, `Archive fixture ${archiveId}/state.json`);
  requireSingleTerminalLf(eventsBytes, `Archive fixture ${archiveId}/events.ndjson`);

  return {
    archiveId,
    stateBytes,
    eventsBytes,
    state: parseState(stateBytes, archiveId),
    events: parseEvents(eventsBytes, archiveId),
  };
}
