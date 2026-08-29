import { writeFileSync } from 'node:fs';

import {
  archiveImportDigest, archiveImportStateFixture, assert, loadState, repo, statePath, test,
} from '../test-support/state-harness.mjs';
import { checkpointArchiveTaskCompletion } from './archive-import.mjs';

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('archive import service revalidates exact protected evidence on write and retry', () => {
  const cwd = repo();
  const fixture = archiveImportStateFixture(cwd);
  const completed = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.equal(completed.tasks.find((task) => task.id === fixture.aggregate.id).status, 'completed');
  assert.equal(completed.threadResolutionStatus.threads.length, 2);

  const exactRetry = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: completed.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.deepEqual(exactRetry, completed);
  assert.equal(loadState(cwd).revision, completed.revision);

  throwsCode(() => checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: completed.revision,
    threadResolutionStatus: fixture.threadResolutionStatus,
    archiveImportEnvelope: { ...fixture.envelope, authorityFingerprint: 'f'.repeat(64) },
  }), 'INVALID_ARCHIVE_IMPORT');
  assert.equal(loadState(cwd).revision, completed.revision);
});

test('archive service bootstraps local proof then imports the archive through production checkpoints', () => {
  const cwd = repo();
  const fixture = archiveImportStateFixture(cwd);
  const local = fixture.current.tasks[0];
  local.sourceType = 'local';
  local.sourceIds = ['orchestrator:integration-verifier'];
  local.status = 'integrated';
  fixture.current.threadResolutionStatus.threadlessVerification = {
    status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
  };
  const nextProof = {
    ...fixture.current.threadResolutionStatus,
    localVerification: {
      status: 'passed', headSha: fixture.current.currentIntegrationHeadSha,
      taskIds: [local.id], updatedAt: '2026-08-23T00:00:00.000Z',
    },
  };
  const nextTasks = fixture.current.tasks.map((task) => task.id === local.id
    ? { ...task, status: 'completed' } : task);
  const roots = fixture.threadResolutionStatus.threads.map((row) => ({
    threadNodeId: row.threadNodeId,
    rootCommentNodeId: row.rootCommentNodeId,
    rootCommentDatabaseId: row.rootCommentDatabaseId,
    isResolved: true,
    taskId: fixture.aggregate.id,
  })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
  const verifierBootstrapEnvelope = {
    schemaVersion: 1,
    taskId: local.id,
    integratedCommitSha: local.integratedCommitSha,
    headSha: fixture.current.currentIntegrationHeadSha,
    proofLane: 'localVerification',
    archiveTaskId: fixture.aggregate.id,
    roots,
    priorStateFingerprint: archiveImportDigest({
      tasks: fixture.current.tasks,
      threadResolutionStatus: fixture.current.threadResolutionStatus,
    }),
    nextStateFingerprint: archiveImportDigest({
      tasks: nextTasks,
      threadResolutionStatus: nextProof,
    }),
  };
  writeFileSync(statePath(cwd, fixture.current.prNumber), `${JSON.stringify(fixture.current)}\n`);

  const completed = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: fixture.current.revision,
    threadResolutionStatus: nextProof,
    verifierBootstrapEnvelope,
  });
  assert.equal(completed.tasks.find((task) => task.id === local.id).status, 'completed');
  assert.deepEqual(completed.threadResolutionStatus.threadlessVerification,
    fixture.current.threadResolutionStatus.threadlessVerification);
  assert.deepEqual(completed.threadResolutionStatus.localVerification, nextProof.localVerification);

  const importedProof = {
    ...fixture.threadResolutionStatus,
    threadlessVerification: completed.threadResolutionStatus.threadlessVerification,
    localVerification: completed.threadResolutionStatus.localVerification,
  };
  const imported = checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: completed.revision,
    threadResolutionStatus: importedProof,
    archiveImportEnvelope: fixture.envelope,
  });
  assert.equal(imported.tasks.find((task) => task.id === fixture.aggregate.id).status, 'completed');
  assert.equal(imported.threadResolutionStatus.status, 'passed');
  assert.equal(imported.threadResolutionStatus.threads.length, 2);
  assert.deepEqual(imported.threadResolutionStatus.localVerification, nextProof.localVerification);
  assert.deepEqual(imported.threadResolutionStatus.threadlessVerification, {
    status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
  });

  throwsCode(() => checkpointArchiveTaskCompletion({
    cwd,
    expectedRevision: imported.revision,
    threadResolutionStatus: imported.threadResolutionStatus,
    archiveImportEnvelope: fixture.envelope,
    verifierBootstrapEnvelope,
  }), 'INVALID_ARCHIVE_IMPORT');
});
