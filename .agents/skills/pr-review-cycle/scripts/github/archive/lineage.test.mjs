import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readLiveSnapshot } from '../snapshot.mjs';
import { buildCanonicalRootPlan } from '../threads/canonical-roots.mjs';
import {
  selectArchiveForBatch,
  validateArchiveBatchLineage,
} from './lineage.mjs';
import {
  ARCHIVED_TASK_ID,
  archiveAdoptionFixture,
  immutableArchiveStore,
} from '../test-support/workflow-harness.mjs';

test('lineage owner selects and validates the exact ordinary archive authority', async () => {
  const fixture = archiveAdoptionFixture();
  const live = await readLiveSnapshot(fixture.client, fixture.active);
  const { selected, selectedPlan } = buildCanonicalRootPlan(
    fixture.active, live, ARCHIVED_TASK_ID,
  );
  const archiveStore = immutableArchiveStore([fixture.archive]);

  const lineage = await selectArchiveForBatch(
    fixture.active, selected, selectedPlan, archiveStore,
  );
  const adoption = validateArchiveBatchLineage(
    fixture.active, live, selected, selectedPlan, lineage,
  );

  assert.equal(archiveStore.calls, 1);
  assert.equal(lineage.mode, 'legacy');
  assert.deepEqual(adoption.evidence.map((item) => item.threadNodeId), [
    'THREAD_ARCHIVE_A',
    'THREAD_ARCHIVE_B',
  ]);
  assert.equal(adoption.archiveLineage.inventory.length, 1);
  assert.match(adoption.archiveLineage.authorityFingerprint, /^[0-9a-f]{64}$/u);
});

test('lineage owner rejects mixed ordinary and aggregate carrier authority', async () => {
  const fixture = archiveAdoptionFixture();
  const live = await readLiveSnapshot(fixture.client, fixture.active);
  const { selected, selectedPlan } = buildCanonicalRootPlan(
    fixture.active, live, ARCHIVED_TASK_ID,
  );
  const mixed = structuredClone(fixture.archive);
  mixed.archiveId = 'aggregate-replay';
  mixed.state.tasks = [];
  mixed.state.threadResolutionStatus.threads = mixed.state.threadResolutionStatus.threads.map((row) => ({
    ...row,
    archiveProvenance: {
      schemaVersion: 1,
      historicalTaskId: 'historical-task',
      historicalDisposition: 'already-fixed',
      historicalIntegratedCommitSha: null,
      replyBodySha256: 'a'.repeat(64),
      authorityFingerprint: 'b'.repeat(64),
    },
  }));

  await assert.rejects(
    () => selectArchiveForBatch(
      fixture.active, selected, selectedPlan,
      immutableArchiveStore([fixture.archive, mixed]),
    ),
    /Ordinary and aggregate replay carriers cannot be mixed/u,
  );
});
