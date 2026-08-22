import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubWorkflowError } from '../errors.mjs';
import {
  archiveContentFingerprint,
  assertArchiveInventory,
  assertTerminalArchive,
} from './evidence.mjs';
import { archiveAdoptionFixture } from '../test-support/workflow-harness.mjs';

test('archive evidence owner preserves canonical inventory and terminal bounds', () => {
  const { archive } = archiveAdoptionFixture();
  assert.doesNotThrow(() => assertArchiveInventory([archive]));
  assert.deepEqual(assertTerminalArchive(archive.state, archive.events), {
    stateUpdatedAt: Date.parse(archive.state.updatedAt),
    terminalEventAt: Date.parse(archive.events.at(-1).at),
  });
  assert.equal(
    archiveContentFingerprint(archive),
    archiveContentFingerprint(structuredClone(archive)),
  );
});

test('archive evidence owner rejects ambiguous inventory before carrier interpretation', () => {
  const { archive } = archiveAdoptionFixture();
  assert.throws(
    () => assertArchiveInventory([archive, structuredClone(archive)]),
    (error) => error instanceof GitHubWorkflowError
      && error.code === 'ARCHIVE_EVIDENCE_AMBIGUOUS'
      && error.message === 'Immutable archive identity is missing or duplicated',
  );
});
