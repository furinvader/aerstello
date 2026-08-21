import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  localTaskIsEligibleForVerification,
  taskHasCanonicalThreadCoverage,
  validateArchiveProvenance,
  validateCiProof,
  validateLocalVerification,
  validateProof,
  validateThreadlessProof,
  validateThreadStatus,
} from './thread-proof.mjs';

const AT = '2026-08-05T00:00:00Z';
const HEAD = 'a'.repeat(40);

function errorsFrom(validate, ...args) {
  const errors = [];
  validate(...args, errors);
  return errors;
}

function task(overrides = {}) {
  return {
    id: 'thread-task', sourceIds: ['thread:PRRT_one'], sourceType: 'github-thread',
    disposition: 'actionable', status: 'completed', integratedCommitSha: HEAD,
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    threadNodeId: 'PRRT_one', rootCommentNodeId: 'PRRC_one', rootCommentDatabaseId: 11,
    taskIds: ['thread-task'], disposition: 'fixed', replyId: 'PRRC_reply_one',
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r11',
    isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: HEAD,
    ...overrides,
  };
}

function threadStatus(overrides = {}) {
  return {
    status: 'passed', headSha: HEAD, threads: [thread()],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    updatedAt: AT,
    ...overrides,
  };
}

test('direct targeted, CI, and threadless proof contracts preserve exact closed shapes', () => {
  const targeted = {
    source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
    checks: ['npm run check:workflow'], updatedAt: AT,
  };
  const targetedErrors = [];
  validateProof(targeted, '$.validation', targetedErrors, { source: 'orchestrator', scope: 'targeted' });
  assert.deepEqual(targetedErrors, []);
  const closedTargetedErrors = [];
  validateProof(
    { ...targeted, extra: true }, '$.validation', closedTargetedErrors,
    { source: 'orchestrator', scope: 'targeted' },
  );
  assert.deepEqual(closedTargetedErrors, ['$.validation.extra is not supported']);

  const ci = {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation'], workflowRunId: 99,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/99',
    checkRunId: 'CHECK_attempt_1', updatedAt: AT,
  };
  const ciErrors = [];
  validateCiProof(ci, '$.ci', ciErrors, { allowNotRun: false });
  assert.deepEqual(ciErrors, []);
  const notRunCi = {
    source: 'github-actions', scope: 'full', status: 'not-run', headSha: null,
    checks: [], workflowRunId: null, workflowRunUrl: null, updatedAt: null,
  };
  const notRunErrors = [];
  validateCiProof(notRunCi, '$.ci', notRunErrors, { allowNotRun: false });
  assert.deepEqual(notRunErrors, [
    '$.ci.status cannot be not-run',
  ]);
  assert.deepEqual(errorsFrom(validateCiProof, { ...ci, unknown: true }, '$.ci'), [
    '$.ci.unknown is not supported',
  ]);

  const threadless = { status: 'passed', headSha: HEAD, taskIds: [], updatedAt: AT };
  assert.deepEqual(errorsFrom(validateThreadlessProof, threadless, '$.threadless'), []);
  assert.deepEqual(errorsFrom(validateThreadlessProof, { ...threadless, taskIds: ['x', 'x'] }, '$.threadless'), [
    '$.threadless.taskIds contains duplicates',
  ]);
});

test('direct local proof preserves eligibility and exact completed-task coverage', () => {
  const actionable = task({
    id: 'local-actionable', sourceType: 'local', sourceIds: ['local:audit'],
  });
  const nonActionable = task({
    id: 'local-stale', sourceType: 'local', sourceIds: ['local:stale'],
    disposition: 'stale', integratedCommitSha: null,
  });
  assert.equal(localTaskIsEligibleForVerification(actionable), true);
  assert.equal(localTaskIsEligibleForVerification(nonActionable), true);
  assert.equal(localTaskIsEligibleForVerification({ ...actionable, status: 'integrated' }), false);
  assert.equal(localTaskIsEligibleForVerification({ ...actionable, integratedCommitSha: null }), false);

  const proof = { status: 'passed', headSha: HEAD, taskIds: [actionable.id, nonActionable.id], updatedAt: AT };
  assert.deepEqual(errorsFrom(validateLocalVerification, proof, [actionable, nonActionable], '$.local'), []);
  assert.deepEqual(errorsFrom(validateLocalVerification, { ...proof, taskIds: [] }, [actionable], '$.local'), [
    '$.local passed proof must cover at least one local task',
  ]);
});

test('canonical thread coverage is source- and disposition-bound', () => {
  const completed = task({ sourceIds: ['thread:PRRT_one', 'discussion:12'] });
  const rows = [
    thread(),
    thread({
      threadNodeId: 'PRRT_two', rootCommentNodeId: 'PRRC_two', rootCommentDatabaseId: 12,
      replyId: 'PRRC_reply_two',
      replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r12',
    }),
  ];
  assert.equal(taskHasCanonicalThreadCoverage(completed, rows), true);
  assert.equal(taskHasCanonicalThreadCoverage(completed, [rows[0]]), false);
  assert.equal(taskHasCanonicalThreadCoverage(completed, [{ ...rows[0], disposition: 'duplicate' }, rows[1]]), false);
  assert.deepEqual(errorsFrom(validateThreadStatus, {
    ...threadStatus(), threads: rows,
  }, [completed]), []);
});

test('archive provenance preserves exact shape, adoption rules, and deep partition equality', () => {
  const provenance = {
    schemaVersion: 1, historicalTaskId: 'historical-task', historicalDisposition: 'fixed',
    historicalIntegratedCommitSha: 'b'.repeat(40), replyBodySha256: '1'.repeat(64),
    authorityFingerprint: 'c'.repeat(64),
  };
  assert.deepEqual(errorsFrom(validateArchiveProvenance, provenance, '$.archive'), []);
  assert.deepEqual(errorsFrom(validateArchiveProvenance, { ...provenance, extra: true }, '$.archive'), [
    '$.archive.extra is not supported',
  ]);

  const active = task({
    id: 'adopted-task', sourceIds: ['thread:PRRT_one', 'thread:PRRT_two'],
    disposition: 'already-fixed', integratedCommitSha: null,
  });
  const first = thread({
    taskIds: [active.id], disposition: 'already-fixed', archiveProvenance: provenance,
  });
  const second = thread({
    threadNodeId: 'PRRT_two', rootCommentNodeId: 'PRRC_two', rootCommentDatabaseId: 12,
    taskIds: [active.id], disposition: 'already-fixed', replyId: 'PRRC_reply_two',
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r12',
    archiveProvenance: { ...provenance },
  });
  const valid = { ...threadStatus(), threads: [first, second] };
  assert.deepEqual(errorsFrom(validateThreadStatus, valid, [active]), []);

  const changedNestedMetadata = structuredClone(valid);
  changedNestedMetadata.threads[1].observedHeadSha = 'd'.repeat(40);
  assert.ok(errorsFrom(validateThreadStatus, changedNestedMetadata, [active]).includes(
    '$.threadResolutionStatus.threads[1].archiveProvenance conflicts with its historical task partition',
  ));
  const changedAuthority = structuredClone(valid);
  changedAuthority.threads[1].archiveProvenance.authorityFingerprint = 'e'.repeat(64);
  assert.ok(errorsFrom(validateThreadStatus, changedAuthority, [active]).includes(
    '$.threadResolutionStatus.threads[1].archiveProvenance diverges within its active adoption',
  ));
});

test('aggregate thread proof binds threadless, local, and archive coverage without mutation', () => {
  const githubThread = task();
  const githubThreadless = task({
    id: 'threadless-task', sourceIds: ['review:threadless'], sourceType: 'github-threadless',
  });
  const local = task({
    id: 'local-task', sourceIds: ['local:audit'], sourceType: 'local',
  });
  const proof = threadStatus({
    threadlessVerification: { status: 'passed', headSha: HEAD, taskIds: [githubThreadless.id], updatedAt: AT },
    localVerification: { status: 'passed', headSha: HEAD, taskIds: [local.id], updatedAt: AT },
  });
  const original = structuredClone(proof);
  assert.deepEqual(errorsFrom(validateThreadStatus, proof, [githubThread, githubThreadless, local]), []);
  assert.deepEqual(proof, original);
  const unknownField = { ...proof, aggregateDigest: 'not-authority' };
  assert.deepEqual(errorsFrom(validateThreadStatus, unknownField, [githubThread, githubThreadless, local]), [
    '$.threadResolutionStatus.aggregateDigest is not supported',
  ]);
});
