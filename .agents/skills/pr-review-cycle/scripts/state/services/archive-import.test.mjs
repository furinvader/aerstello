import { writeFileSync } from 'node:fs';

import {
  archiveImportDigest, archiveImportStateFixture, assert, loadState, repo, statePath, test,
} from '../test-support/state-harness.mjs';
import * as harness from '../test-support/state-harness.mjs';
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

test('archive service imports one transient GitHub-thread attestation without persisting it', () => {
  const cwd = repo();
  const fixture = archiveImportStateFixture(cwd);
  const head = fixture.current.currentIntegrationHeadSha;
  const remediation = fixture.current.tasks[0];
  remediation.sourceType = 'github-thread';
  remediation.sourceIds = ['thread:PRRT_current'];
  remediation.status = 'integrated';
  const localImplementation = harness.task(head, {
    id: 'local-implementation', sourceIds: ['orchestrator:integration-verifier'],
    sourceType: 'local', disposition: 'actionable', status: 'integrated',
    integratedCommitSha: head,
  });
  fixture.current.tasks.push(localImplementation);
  fixture.current.threadResolutionStatus = {
    status: 'not-run', headSha: null, threads: [], updatedAt: null,
    threadlessVerification: {
      status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
    },
    localVerification: {
      status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
    },
  };
  writeFileSync(statePath(cwd, fixture.current.prNumber), `${JSON.stringify(fixture.current)}\n`);
  const aggregatePacket = harness.taskPacket(head, fixture.aggregate.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const remediationPacket = harness.taskPacket(head, remediation.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const localPacket = harness.taskPacket(head, localImplementation.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  let current = harness.scopeReadyForPacket(cwd, loadState(cwd), aggregatePacket);
  current = harness.scopeReadyForPacket(cwd, current, remediationPacket);
  current = harness.scopeReadyForPacket(cwd, current, localPacket);
  current = {
    ...current,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: head,
      checks: ['npm run check:workflow'], updatedAt: harness.AT,
    },
  };
  const unresolved = {
    threadNodeId: 'PRRT_current', rootCommentNodeId: 'PRRC_current', rootCommentDatabaseId: 203,
    taskIds: [remediation.id], disposition: 'fixed', replyId: null, replyUrl: null,
    isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: head,
  };
  const threadResolutionStatus = {
    ...fixture.threadResolutionStatus,
    status: 'failed',
    threads: [...fixture.threadResolutionStatus.threads, unresolved],
    threadlessVerification: current.threadResolutionStatus.threadlessVerification,
    localVerification: current.threadResolutionStatus.localVerification,
  };
  const nextTasks = current.tasks.map((task) => task.id === fixture.aggregate.id
    ? { ...task, status: 'completed' } : task);
  const roots = threadResolutionStatus.threads.map((row) => ({
    threadNodeId: row.threadNodeId,
    rootCommentNodeId: row.rootCommentNodeId,
    rootCommentDatabaseId: row.rootCommentDatabaseId,
    isResolved: row.isResolved,
    taskId: row.taskIds[0],
  })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
  const envelope = {
    ...fixture.envelope,
    schemaVersion: 2,
    attestation: {
      schemaVersion: 1, headSha: head, stateRevision: current.revision,
      heads: { durable: head, local: head, pushed: head, live: head },
      remediations: [{ taskId: remediation.id, integratedCommitSha: remediation.integratedCommitSha }],
      roots,
      scope: {
        authorityDigest: current.scopeControl.authorityDigest,
        journalDigest: current.scopeControl.journalDigest,
        classifications: [
          { taskId: fixture.aggregate.id, digest: harness.scopePair(head, aggregatePacket).digest },
          { taskId: localImplementation.id, digest: harness.scopePair(head, localPacket).digest },
          { taskId: remediation.id, digest: harness.scopePair(head, remediationPacket).digest },
        ].sort((left, right) => left.taskId.localeCompare(right.taskId)),
      },
      verifierAssertion: {
        schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean', headSha: head,
        stateRevision: current.revision,
        scopeAuthorityDigest: current.scopeControl.authorityDigest,
        scopeJournalDigest: current.scopeControl.journalDigest, assertedAt: harness.AT,
      },
      priorStateFingerprint: archiveImportDigest({
        tasks: current.tasks, threadResolutionStatus: current.threadResolutionStatus,
      }),
      nextStateFingerprint: archiveImportDigest({
        tasks: nextTasks, threadResolutionStatus,
      }),
    },
  };
  writeFileSync(statePath(cwd, current.prNumber), `${JSON.stringify(current)}\n`);

  const completed = checkpointArchiveTaskCompletion({
    cwd, expectedRevision: current.revision, threadResolutionStatus,
    archiveImportEnvelope: envelope,
  });
  assert.equal(completed.tasks.find((task) => task.id === fixture.aggregate.id).status, 'completed');
  assert.equal(completed.tasks.find((task) => task.id === remediation.id).status, 'integrated');
  assert.deepEqual(completed.threadResolutionStatus.localVerification,
    current.threadResolutionStatus.localVerification);
  assert.deepEqual(completed.threadResolutionStatus.threadlessVerification,
    current.threadResolutionStatus.threadlessVerification);
  assert.equal(Object.hasOwn(completed, 'attestation'), false);

  const retry = checkpointArchiveTaskCompletion({
    cwd, expectedRevision: completed.revision, threadResolutionStatus,
    archiveImportEnvelope: envelope,
  });
  assert.deepEqual(retry, completed);
});
