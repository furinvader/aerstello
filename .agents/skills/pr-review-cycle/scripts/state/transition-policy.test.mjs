import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createTransitionPolicy } from './transition-policy.mjs';

const SHA = 'a'.repeat(40);
const AT = '2026-08-23T00:00:00.000Z';

function baseState() {
  return {
    repository: 'example/aerstello', prNumber: 17, baseSha: SHA, integrationWorktree: '/tmp/aerstello',
    releaseBaseline: null, legacyReviewProvenance: null, reviewRound: 0,
    verificationReviewUsed: false, abandonmentReason: null, reviewRequestLimit: null,
    staleDiscoveryDispositions: [], requestedHeadSha: null, reviewedHeadSha: null,
    reviewRequest: null, reviewOutcome: null, reviewHistory: [], verificationEscalation: null,
    ciValidationStatus: {
      source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
      checks: [], checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null,
    },
    ciValidationHistory: [],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null,
      checks: [], updatedAt: null,
    },
    threadResolutionStatus: {
      status: 'not-run', headSha: null, threads: [],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      localVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: null,
    },
    tasks: [], decisions: [], phase: 'implementing', currentIntegrationHeadSha: SHA,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function archiveFixture() {
  const task = {
    id: 'archive-task', sourceIds: ['thread:root-a', 'discussion:2'], sourceType: 'github-thread',
    fingerprint: 'task-fingerprint', summary: 'Archive task.', severity: 'P2',
    disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
    resolutionSummary: 'Already fixed.',
  };
  const remediation = {
    ...task, id: 'remediation', sourceIds: ['local:remediation'], sourceType: 'local',
    disposition: 'actionable', status: 'completed', integratedCommitSha: SHA,
  };
  const current = {
    ...baseState(), tasks: [remediation, task],
    threadResolutionStatus: {
      ...baseState().threadResolutionStatus,
      threadlessVerification: { status: 'passed', headSha: SHA, taskIds: ['remediation'], updatedAt: AT },
    },
  };
  const authorityFingerprint = 'b'.repeat(64);
  const rows = [
    ['root-a', 'comment-a', 1, 'reply-a', 'c'.repeat(64)],
    ['root-b', 'comment-b', 2, 'reply-b', 'd'.repeat(64)],
  ].map(([threadNodeId, rootCommentNodeId, rootCommentDatabaseId, replyId, replyBodySha256]) => ({
    threadNodeId, rootCommentNodeId, rootCommentDatabaseId, taskIds: [task.id],
    disposition: 'already-fixed', replyId, replyUrl: `https://example.test/${replyId}`,
    isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: SHA,
    archiveProvenance: {
      schemaVersion: 1, historicalTaskId: threadNodeId, historicalDisposition: 'already-fixed',
      historicalIntegratedCommitSha: null, replyBodySha256, authorityFingerprint,
    },
  }));
  const threadResolutionStatus = {
    status: 'passed', headSha: SHA, threads: rows,
    threadlessVerification: current.threadResolutionStatus.threadlessVerification,
    localVerification: current.threadResolutionStatus.localVerification, updatedAt: AT,
  };
  const envelope = {
    schemaVersion: 1, taskId: task.id, authorityFingerprint,
    rows: rows.map((row) => ({
      threadNodeId: row.threadNodeId, replyId: row.replyId,
      replyBodySha256: row.archiveProvenance.replyBodySha256,
      provenanceFingerprint: fingerprint(row.archiveProvenance), rowFingerprint: fingerprint(row),
    })),
  };
  return { current, threadResolutionStatus, envelope };
}

function reviewLimitTransition(current, reviewRequestLimit = 5) {
  return { ...current, reviewRequestLimit };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('protected authorization is private, closed, snapshot-bound, and fail-closed', () => {
  const cwd = '/tmp/aerstello-policy';
  const current = baseState();
  const next = reviewLimitTransition(current);
  const policy = createTransitionPolicy();
  const authorization = policy.authorizeProtectedTransition(
    current,
    next,
    'review-request-limit',
  );

  assert.doesNotThrow(() => policy.assertTransitionAllowed(current, next, authorization, cwd));
  assertCode(
    () => policy.authorizeProtectedTransition(current, next, 'invented-transition'),
    'INVALID_TRANSITION_AUTHORIZATION',
  );
  for (const invalid of [
    null,
    {},
    { ...authorization },
    createTransitionPolicy().authorizeProtectedTransition(current, next, 'review-request-limit'),
  ]) {
    assertCode(
      () => policy.assertTransitionAllowed(current, next, invalid, cwd),
      'INVALID_TRANSITION_AUTHORIZATION',
    );
  }
  assertCode(
    () => policy.assertTransitionAllowed({ ...current, revision: current.revision + 1 }, next, authorization, cwd),
    'INVALID_TRANSITION_AUTHORIZATION',
  );
  assertCode(
    () => policy.assertTransitionAllowed(current, { ...next, nextAction: 'Mismatch.' }, authorization, cwd),
    'INVALID_TRANSITION_AUTHORIZATION',
  );

  next.nextAction = 'Mutated after authorization.';
  assertCode(
    () => policy.assertTransitionAllowed(current, next, authorization, cwd),
    'INVALID_TRANSITION_AUTHORIZATION',
  );
});

test('absence of authorization retains the generic append-only policy path', () => {
  const cwd = '/tmp/aerstello-policy';
  const current = baseState();
  const policy = createTransitionPolicy();

  assert.doesNotThrow(() => policy.assertTransitionAllowed(
    current,
    { ...current, nextAction: 'A generic operational update.' },
    undefined,
    cwd,
  ));
  assertCode(
    () => policy.assertTransitionAllowed(current, reviewLimitTransition(current), undefined, cwd),
    'IMMUTABLE_STATE_PROVENANCE',
  );
});

test('archive authorization validates an immutable exact envelope', () => {
  const cwd = '/tmp/aerstello-policy';
  const fixture = archiveFixture();
  const next = {
    ...fixture.current,
    tasks: fixture.current.tasks.map((task) => (
      task.id === fixture.envelope.taskId ? { ...task, status: 'completed' } : task
    )),
    threadResolutionStatus: fixture.threadResolutionStatus,
  };
  const policy = createTransitionPolicy();
  const authorization = policy.authorizeProtectedTransition(
    fixture.current,
    next,
    'archive-task-completion',
    { archiveImportEnvelope: fixture.envelope },
  );
  assert.doesNotThrow(() => policy.assertTransitionAllowed(
    fixture.current,
    next,
    authorization,
    cwd,
  ));

  const malformedEnvelope = {
    ...fixture.envelope,
    rows: fixture.envelope.rows.slice().reverse(),
  };
  const malformedAuthorization = policy.authorizeProtectedTransition(
    fixture.current,
    next,
    'archive-task-completion',
    { archiveImportEnvelope: malformedEnvelope },
  );
  assertCode(
    () => policy.assertTransitionAllowed(
      fixture.current,
      next,
      malformedAuthorization,
      cwd,
    ),
    'INVALID_ARCHIVE_IMPORT',
  );
});
