import {
  archiveImportStateFixture, assert, loadState, repo, test,
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
