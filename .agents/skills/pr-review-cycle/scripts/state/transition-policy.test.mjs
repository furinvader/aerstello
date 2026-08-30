import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import * as harness from './test-support/state-harness.mjs';
import {
  checkpointScopeClassification,
  checkpointScopeDecision,
  checkpointTaskPacketBinding,
  checkpointWorkerResultAcceptance,
} from './state.mjs';
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

function archiveFixture(sourceType = 'github-threadless') {
  const task = {
    id: 'archive-task', sourceIds: ['thread:root-a', 'discussion:2'], sourceType: 'github-thread',
    fingerprint: 'task-fingerprint', summary: 'Archive task.', severity: 'P2',
    disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
    resolutionSummary: 'Already fixed.',
  };
  const remediation = {
    ...task, id: 'remediation', sourceIds: [`${sourceType}:remediation`], sourceType,
    disposition: 'actionable', status: 'completed', integratedCommitSha: SHA,
  };
  const selectedProof = { status: 'passed', headSha: SHA, taskIds: ['remediation'], updatedAt: AT };
  const current = {
    ...baseState(), tasks: [remediation, task],
    threadResolutionStatus: {
      ...baseState().threadResolutionStatus,
      ...(sourceType === 'local'
        ? { localVerification: selectedProof }
        : { threadlessVerification: selectedProof }),
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

function localBootstrapFixture() {
  const current = baseState();
  const remediation = {
    id: 'local-remediation', sourceIds: ['orchestrator:integration-verifier'], sourceType: 'local',
    fingerprint: 'local-remediation-fingerprint', summary: 'Fix verifier finding.', severity: 'P1',
    disposition: 'actionable', status: 'integrated', integratedCommitSha: SHA,
    resolutionSummary: 'Integrated local fix.',
  };
  const aggregate = {
    id: 'aggregate', sourceIds: ['thread:root-a', 'discussion:2'], sourceType: 'github-thread',
    fingerprint: 'aggregate-fingerprint', summary: 'Retained roots.', severity: 'P2',
    disposition: 'already-fixed', status: 'not-applicable', integratedCommitSha: null,
    resolutionSummary: 'Already fixed.',
  };
  current.tasks = [remediation, aggregate];
  const next = {
    ...current,
    tasks: [{ ...remediation, status: 'completed' }, aggregate],
    threadResolutionStatus: {
      ...current.threadResolutionStatus,
      localVerification: { status: 'passed', headSha: SHA, taskIds: [remediation.id], updatedAt: AT },
    },
  };
  const envelope = {
    schemaVersion: 1, taskId: remediation.id, integratedCommitSha: SHA, headSha: SHA,
    proofLane: 'localVerification', archiveTaskId: aggregate.id,
    roots: [
      { threadNodeId: 'root-a', rootCommentNodeId: 'comment-a', rootCommentDatabaseId: 1, isResolved: true, taskId: aggregate.id },
      { threadNodeId: 'root-b', rootCommentNodeId: 'comment-b', rootCommentDatabaseId: 2, isResolved: true, taskId: aggregate.id },
    ],
    priorStateFingerprint: fingerprint({ tasks: current.tasks, threadResolutionStatus: current.threadResolutionStatus }),
    nextStateFingerprint: fingerprint({ tasks: next.tasks, threadResolutionStatus: next.threadResolutionStatus }),
  };
  return { current, next, envelope };
}

function githubThreadAttestationFixture(cwd) {
  const initial = harness.init(cwd);
  const head = initial.currentIntegrationHeadSha;
  const aggregate = harness.task(head, {
    id: 'aggregate', sourceIds: ['thread:root-a', 'discussion:2'],
    sourceType: 'github-thread', disposition: 'already-fixed', status: 'proposed',
    integratedCommitSha: null, resolutionSummary: null,
  });
  const remediation = harness.task(head, {
    id: 'remediation', sourceIds: ['thread:root-c'], sourceType: 'github-thread',
    disposition: 'actionable', status: 'proposed', integratedCommitSha: null,
  });
  const localImplementation = harness.task(head, {
    id: 'local-implementation', sourceIds: ['orchestrator:integration-verifier'],
    sourceType: 'local', disposition: 'actionable', status: 'proposed',
    integratedCommitSha: null,
  });
  let current = harness.checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: { ...initial, tasks: [aggregate, remediation, localImplementation] },
  });
  const aggregatePacket = harness.taskPacket(head, aggregate.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const remediationPacket = harness.taskPacket(head, remediation.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const localPacket = harness.taskPacket(head, localImplementation.id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  current = harness.scopeReadyForPacket(cwd, current, aggregatePacket);
  current = harness.scopeReadyForPacket(cwd, current, remediationPacket);
  current = harness.scopeReadyForPacket(cwd, current, localPacket);
  current = {
    ...current,
    tasks: current.tasks.map((task) => task.id === aggregate.id ? {
      ...task, status: 'not-applicable', integratedCommitSha: null,
      resolutionSummary: 'Retained immutable aggregate.',
    } : {
      ...task, status: 'integrated', integratedCommitSha: head,
      resolutionSummary: 'Integrated and validated.',
    }),
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: head,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
  };
  const authorityFingerprint = 'b'.repeat(64);
  const archiveRows = [
    ['root-a', 'comment-a', 1, 'reply-a', 'c'.repeat(64)],
    ['root-b', 'comment-b', 2, 'reply-b', 'd'.repeat(64)],
  ].map(([threadNodeId, rootCommentNodeId, rootCommentDatabaseId, replyId, replyBodySha256]) => ({
    threadNodeId, rootCommentNodeId, rootCommentDatabaseId, taskIds: [aggregate.id],
    disposition: 'already-fixed', replyId, replyUrl: `https://example.test/${replyId}`,
    isResolved: true, resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: head,
    archiveProvenance: {
      schemaVersion: 1, historicalTaskId: threadNodeId, historicalDisposition: 'already-fixed',
      historicalIntegratedCommitSha: null, replyBodySha256, authorityFingerprint,
    },
  }));
  const unresolvedRow = {
    threadNodeId: 'root-c', rootCommentNodeId: 'comment-c', rootCommentDatabaseId: 3,
    taskIds: [remediation.id], disposition: 'fixed', replyId: null, replyUrl: null,
    isResolved: false, resolvedAt: null, resolvedBy: null, observedHeadSha: head,
  };
  const threadResolutionStatus = {
    status: 'failed', headSha: head, threads: [...archiveRows, unresolvedRow],
    threadlessVerification: current.threadResolutionStatus.threadlessVerification,
    localVerification: current.threadResolutionStatus.localVerification, updatedAt: AT,
  };
  const next = {
    ...current,
    tasks: current.tasks.map((task) => task.id === aggregate.id
      ? { ...task, status: 'completed' } : task),
    threadResolutionStatus,
  };
  const classifications = [
    { taskId: aggregate.id, digest: harness.scopePair(head, aggregatePacket).digest },
    { taskId: localImplementation.id, digest: harness.scopePair(head, localPacket).digest },
    { taskId: remediation.id, digest: harness.scopePair(head, remediationPacket).digest },
  ].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const roots = threadResolutionStatus.threads.map((row) => ({
    threadNodeId: row.threadNodeId,
    rootCommentNodeId: row.rootCommentNodeId,
    rootCommentDatabaseId: row.rootCommentDatabaseId,
    isResolved: row.isResolved,
    taskId: row.taskIds[0],
  })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
  const envelope = {
    schemaVersion: 2, taskId: aggregate.id, authorityFingerprint,
    rows: archiveRows.map((row) => ({
      threadNodeId: row.threadNodeId, replyId: row.replyId,
      replyBodySha256: row.archiveProvenance.replyBodySha256,
      provenanceFingerprint: fingerprint(row.archiveProvenance), rowFingerprint: fingerprint(row),
    })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId)),
    attestation: {
      schemaVersion: 1, headSha: head, stateRevision: current.revision,
      heads: { durable: head, local: head, pushed: head, live: head },
      remediations: [{ taskId: remediation.id, integratedCommitSha: head }],
      roots,
      scope: {
        authorityDigest: current.scopeControl.authorityDigest,
        journalDigest: current.scopeControl.journalDigest,
        classifications,
      },
      verifierAssertion: {
        schemaVersion: 1, verifierId: 'integration_verifier', status: 'clean', headSha: head,
        stateRevision: current.revision,
        scopeAuthorityDigest: current.scopeControl.authorityDigest,
        scopeJournalDigest: current.scopeControl.journalDigest, assertedAt: AT,
      },
      priorStateFingerprint: fingerprint({
        tasks: current.tasks, threadResolutionStatus: current.threadResolutionStatus,
      }),
      nextStateFingerprint: fingerprint({
        tasks: next.tasks, threadResolutionStatus: next.threadResolutionStatus,
      }),
    },
  };
  return { current, next, envelope };
}

function reviewLimitTransition(current, reviewRequestLimit = 5) {
  return { ...current, reviewRequestLimit };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

function materialScopeClassification(state, packet, suffix) {
  const task = state.tasks.find((candidate) => candidate.id === packet.taskId);
  const pair = harness.scopePair(packet.reviewedHeadSha, packet);
  const mapping = {
    mechanism: 'new-package', sourceCriterionIds: ['bounded-remediation'],
    acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
    rationale: 'The dependency is relevant but not authorized by accepted shape.',
  };
  pair.packet.changeInventory.dependencies.push('new-package');
  pair.packet.changeInventory.mappings.push(mapping);
  pair.result.verdict = 'human-decision-required';
  pair.result.coverage.push({ ...mapping, classification: 'material-scope-change' });
  pair.result.scopeDelta = {
    description: 'Add one new dependency.', sourceCriterionIds: ['bounded-remediation'],
    acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], materialSurfaces: ['new-dependency'],
  };
  pair.result.materialityTriggers = [{
    category: 'new-dependency', evidence: 'The inventory adds new-package.',
  }];
  pair.result.smallestExpansion = 'Add only new-package.';
  pair.result.narrowAlternative = 'Keep the direct bounded remediation.';
  pair.result.deferralConsequences = 'The dependency-backed mechanism remains unavailable.';
  pair.result.humanDecision = true;
  pair.digest = `sha256:${fingerprint({ packet: pair.packet, result: pair.result })}`;
  return {
    entryId: `classification-material-${suffix}`, at: harness.AT,
    reviewHeadSha: packet.reviewedHeadSha,
    rootCauseId: harness.scopeRootForTask(task),
    findingIds: task.sourceIds,
    findingFingerprints: task.sourceIds.map(
      (_sourceId, index) => `${task.fingerprint}-f${index + 1}`,
    ),
    classification: 'material-scope-change', assessment: pair,
    authorityAmendmentRequired: false, unrelatedReference: null,
    remediationShapeDigest: `sha256:${harness.taskPacketDigest(packet)}`, tripwires: [],
  };
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

test('archive authorization validates immutable exact envelopes for either bootstrap lane', () => {
  const cwd = '/tmp/aerstello-policy';
  const policy = createTransitionPolicy();
  for (const sourceType of ['github-threadless', 'local']) {
    const fixture = archiveFixture(sourceType);
    const next = {
      ...fixture.current,
      tasks: fixture.current.tasks.map((task) => (
        task.id === fixture.envelope.taskId ? { ...task, status: 'completed' } : task
      )),
      threadResolutionStatus: fixture.threadResolutionStatus,
    };
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
  }

  const fixture = archiveFixture();
  const next = {
    ...fixture.current,
    tasks: fixture.current.tasks.map((task) => (
      task.id === fixture.envelope.taskId ? { ...task, status: 'completed' } : task
    )),
    threadResolutionStatus: fixture.threadResolutionStatus,
  };
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

test('archive authorization rejects malformed or ambiguous bootstrap proof lanes', () => {
  const policy = createTransitionPolicy();
  for (const [label, mutate] of [
    ['both lanes passed', (copy) => { copy.current.threadResolutionStatus.localVerification = {
      status: 'passed', headSha: SHA, taskIds: ['remediation'], updatedAt: AT,
    }; }],
    ['neither lane passed', (copy) => { copy.current.threadResolutionStatus.threadlessVerification = {
      status: 'not-run', headSha: null, taskIds: [], updatedAt: null,
    }; }],
    ['wrong source', (copy) => { copy.current.tasks[0].sourceType = 'local'; }],
    ['stale head', (copy) => { copy.current.threadResolutionStatus.threadlessVerification.headSha = 'b'.repeat(40); }],
    ['multiple proof tasks', (copy) => { copy.current.threadResolutionStatus.threadlessVerification.taskIds.push('other'); }],
    ['non-actionable remediation', (copy) => { copy.current.tasks[0].disposition = 'already-fixed'; }],
    ['null integration commit', (copy) => { copy.current.tasks[0].integratedCommitSha = null; }],
    ['non-pristine opposite lane', (copy) => { copy.current.threadResolutionStatus.localVerification.updatedAt = AT; }],
    ['multiple remediations', (copy) => { copy.current.tasks.push({
      ...copy.current.tasks[0], id: 'other', integratedCommitSha: null,
    }); }],
  ]) {
    const fixture = archiveFixture();
    const next = {
      ...fixture.current,
      tasks: fixture.current.tasks.map((task) => task.id === fixture.envelope.taskId
        ? { ...task, status: 'completed' } : task),
      threadResolutionStatus: fixture.threadResolutionStatus,
    };
    const copy = { current: structuredClone(fixture.current), next: structuredClone(next) };
    mutate(copy);
    const authorization = policy.authorizeProtectedTransition(
      copy.current, copy.next, 'archive-task-completion',
      { archiveImportEnvelope: fixture.envelope },
    );
    assertCode(
      () => policy.assertTransitionAllowed(
        copy.current, copy.next, authorization, '/tmp/aerstello-policy',
      ),
      'INVALID_ARCHIVE_IMPORT',
      label,
    );
  }
});

test('archive authorization admits only the closed singleton local verifier bootstrap delta', () => {
  const fixture = localBootstrapFixture();
  const policy = createTransitionPolicy();
  const authorization = policy.authorizeProtectedTransition(
    fixture.current, fixture.next, 'archive-task-completion',
    { verifierBootstrapEnvelope: fixture.envelope },
  );
  assert.doesNotThrow(() => policy.assertTransitionAllowed(
      fixture.current, fixture.next, authorization, '/tmp/aerstello-policy',
  ));

  for (const [label, mutate] of [
    ['mixed proof', (copy) => { copy.next.threadResolutionStatus.threadlessVerification = {
      status: 'passed', headSha: SHA, taskIds: ['other'], updatedAt: AT,
    }; }],
    ['wrong source', (copy) => { copy.current.tasks[0].sourceType = 'github-threadless'; }],
    ['topology drift', (copy) => { copy.envelope.roots[0].isResolved = false; }],
    ['forged delta', (copy) => { copy.envelope.nextStateFingerprint = 'f'.repeat(64); }],
  ]) {
    const copy = structuredClone(fixture);
    mutate(copy);
    const rejected = policy.authorizeProtectedTransition(
      copy.current, copy.next, 'archive-task-completion',
      { verifierBootstrapEnvelope: copy.envelope },
    );
    assertCode(
      () => policy.assertTransitionAllowed(copy.current, copy.next, rejected, '/tmp/aerstello-policy'),
      'INVALID_ARCHIVE_IMPORT',
      label,
    );
  }
});

test('archive authorization admits only the exact transient GitHub-thread attestation delta', () => {
  const cwd = harness.repo();
  const fixture = githubThreadAttestationFixture(cwd);
  const policy = createTransitionPolicy();
  const authorization = policy.authorizeProtectedTransition(
    fixture.current, fixture.next, 'archive-task-completion',
    { archiveImportEnvelope: fixture.envelope },
  );
  assert.doesNotThrow(() => policy.assertTransitionAllowed(
    fixture.current, fixture.next, authorization, cwd,
  ));

  for (const [label, mutate] of [
    ['unsorted remediation set', (copy) => { copy.envelope.attestation.remediations.push({
      ...copy.envelope.attestation.remediations[0], taskId: 'a-extra',
    }); }],
    ['resolved remediation', (copy) => {
      copy.envelope.attestation.roots.find((root) => root.taskId === 'remediation').isResolved = true;
    }],
    ['duplicated root', (copy) => {
      copy.envelope.attestation.roots.push(structuredClone(copy.envelope.attestation.roots[0]));
    }],
    ['shared aggregate root', (copy) => {
      copy.envelope.attestation.roots.find((root) => root.threadNodeId === 'root-c').taskId = 'aggregate';
    }],
    ['wrong remediation source', (copy) => {
      copy.current.tasks.find((task) => task.id === 'remediation').sourceType = 'local';
    }],
    ['wrong remediation commit', (copy) => {
      copy.envelope.attestation.remediations[0].integratedCommitSha = 'f'.repeat(40);
    }],
    ['unsorted classifications', (copy) => {
      copy.envelope.attestation.scope.classifications.reverse();
    }],
    ['forged verifier assertion', (copy) => {
      copy.envelope.attestation.verifierAssertion.status = 'findings';
    }],
    ['stale verifier revision', (copy) => {
      copy.envelope.attestation.verifierAssertion.stateRevision -= 1;
    }],
    ['persisted proof-lane delta', (copy) => {
      copy.next.threadResolutionStatus.localVerification = {
        status: 'passed', headSha: SHA, taskIds: ['remediation'], updatedAt: AT,
      };
    }],
    ['scope digest drift', (copy) => {
      copy.envelope.attestation.scope.journalDigest = `sha256:${'f'.repeat(64)}`;
    }],
    ['forged next fingerprint', (copy) => {
      copy.envelope.attestation.nextStateFingerprint = 'f'.repeat(64);
    }],
  ]) {
    const copy = structuredClone(fixture);
    mutate(copy);
    const rejected = policy.authorizeProtectedTransition(
      copy.current, copy.next, 'archive-task-completion',
      { archiveImportEnvelope: copy.envelope },
    );
    assertCode(
      () => policy.assertTransitionAllowed(copy.current, copy.next, rejected, cwd),
      'INVALID_ARCHIVE_IMPORT',
      label,
    );
  }
});

test('transition policy rejects active execution behind a forged ready minor-amendment gate', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'minor-policy-task', status: 'proposed', integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'minor-policy-task', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const scoped = harness.scopeReadyForPacket(cwd, proposed, packet);
  harness.planSpecialists({
    cwd, input: harness.planInput(scoped, packet), expectedRevision: scoped.revision,
    now: () => harness.AT,
  });
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: scoped.revision });
  const pair = harness.scopePair(packet.reviewedHeadSha, packet);
  pair.result.verdict = 'minor-amendment-required';
  pair.result.coverage[0].classification = 'necessary-minor-expansion';
  pair.result.scopeDelta = {
    description: 'Authorize the bounded adjacent workflow behavior.',
    sourceCriterionIds: ['bounded-remediation'], acceptedCriterionIds: ['bounded-remediation'],
    invariantIds: [], materialSurfaces: [],
  };
  pair.digest = `sha256:${fingerprint({ packet: pair.packet, result: pair.result })}`;
  const classified = checkpointScopeClassification({
    cwd,
    expectedRevision: bound.revision,
    classification: {
      entryId: 'classification-minor-policy', at: harness.AT,
      reviewHeadSha: packet.reviewedHeadSha, rootCauseId: 'minor-policy-root',
      findingIds: bound.tasks[0].sourceIds,
      findingFingerprints: bound.tasks[0].sourceIds.map(
        (_sourceId, index) => `${bound.tasks[0].fingerprint}-f${index + 1}`,
      ),
      classification: 'within-scope-defect', assessment: pair,
      authorityAmendmentRequired: true, unrelatedReference: null,
      remediationShapeDigest: `sha256:${harness.taskPacketDigest(packet)}`, tripwires: [],
    },
  });
  const forged = {
    ...classified,
    scopeControl: { ...classified.scopeControl, gate: 'ready' },
  };
  const next = {
    ...forged,
    tasks: forged.tasks.map((task) => task.id === 'minor-policy-task'
      ? { ...task, status: 'queued' } : task),
  };
  assertCode(
    () => createTransitionPolicy().assertTransitionAllowed(forged, next, undefined, cwd),
    'SCOPE_TASK_BLOCKED',
  );
});

test('transition policy rejects active execution from an uncheckpointed journal suffix', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'journal-ahead-policy-task', status: 'proposed', integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'journal-ahead-policy-task', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const scoped = harness.scopeReadyForPacket(cwd, proposed, packet);
  harness.planSpecialists({
    cwd, input: harness.planInput(scoped, packet), expectedRevision: scoped.revision,
    now: () => harness.AT,
  });
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: scoped.revision });
  const pair = harness.scopePair(packet.reviewedHeadSha, packet);
  assert.throws(() => checkpointScopeClassification({
    cwd,
    expectedRevision: bound.revision,
    event: { type: 'invalid-scope-event', summary: 'x'.repeat(1001) },
    classification: {
      entryId: 'classification-uncheckpointed-policy-suffix', at: harness.AT,
      reviewHeadSha: packet.reviewedHeadSha, rootCauseId: 'uncheckpointed-policy-root',
      findingIds: bound.tasks[0].sourceIds,
      findingFingerprints: bound.tasks[0].sourceIds.map(
        (_sourceId, index) => `${bound.tasks[0].fingerprint}-f${index + 1}`,
      ),
      classification: 'within-scope-defect', assessment: pair,
      authorityAmendmentRequired: false, unrelatedReference: null,
      remediationShapeDigest: `sha256:${harness.taskPacketDigest(packet)}`, tripwires: [],
    },
  }), { code: 'INVALID_EVENT' });
  const queued = {
    ...bound,
    tasks: bound.tasks.map((task) => task.id === packet.taskId ? { ...task, status: 'queued' } : task),
  };
  assertCode(
    () => createTransitionPolicy().assertTransitionAllowed(bound, queued, undefined, cwd),
    'INVALID_SCOPE_EVIDENCE',
  );
});

test('transition policy rechecks a later decision-required gate on every execution advance', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'decision-transition-task', status: 'proposed', integratedCommitSha: null,
        resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'decision-transition-task', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const scoped = harness.scopeReadyForPacket(cwd, proposed, packet);
  harness.planSpecialists({
    cwd, input: harness.planInput(scoped, packet), expectedRevision: scoped.revision,
    now: () => harness.AT,
  });
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: scoped.revision });
  const queued = harness.checkpointState({
    cwd,
    expectedRevision: bound.revision,
    nextState: {
      ...bound,
      tasks: bound.tasks.map((task) => task.id === packet.taskId
        ? { ...task, status: 'queued' } : task),
    },
  });
  const blocked = checkpointScopeClassification({
    cwd,
    expectedRevision: queued.revision,
    classification: materialScopeClassification(queued, packet, 'decision'),
  });
  assert.equal(blocked.scopeControl.gate, 'decision-required');

  for (const [currentStatus, nextStatus] of [
    ['queued', 'running'],
    ['queued', 'implemented'],
    ['running', 'implemented'],
  ]) {
    const current = {
      ...blocked,
      scopeControl: { ...blocked.scopeControl, gate: 'ready' },
      tasks: blocked.tasks.map((task) => task.id === packet.taskId
        ? { ...task, status: currentStatus } : task),
    };
    const next = {
      ...current,
      tasks: current.tasks.map((task) => task.id === packet.taskId
        ? { ...task, status: nextStatus } : task),
    };
    assertCode(
      () => createTransitionPolicy().assertTransitionAllowed(current, next, undefined, cwd),
      'SCOPE_TASK_BLOCKED',
    );
  }
});

test('transition policy blocks integration behind a later guarded return', () => {
  const cwd = harness.repo();
  const fixture = harness.boundWorkerResultFixture(cwd, 'return-transition-task');
  const implemented = checkpointWorkerResultAcceptance({
    cwd, packet: fixture.packet, result: fixture.result, expectedRevision: fixture.bound.revision,
  });
  const classified = checkpointScopeClassification({
    cwd,
    expectedRevision: implemented.revision,
    classification: materialScopeClassification(implemented, fixture.packet, 'return'),
  });
  assert.equal(classified.scopeControl.gate, 'decision-required');

  const integrated = {
    ...classified,
    tasks: classified.tasks.map((task) => task.id === fixture.packet.taskId ? {
      ...task, status: 'integrated', integratedCommitSha: fixture.result.commitSha,
      resolutionSummary: 'Integrated centrally; targeted validation remains.',
    } : task),
  };
  assertCode(
    () => createTransitionPolicy().assertTransitionAllowed(classified, integrated, undefined, cwd),
    'SCOPE_TASK_BLOCKED',
  );

  const pending = checkpointScopeDecision({
    cwd,
    expectedRevision: classified.revision,
    decision: {
      entryId: 'decision-return-transition', at: harness.AT,
      rootCauseId: harness.scopeRootForTask(classified.tasks[0]),
      blockerId: 'scope-blocker-return-transition', decisionId: 'scope-decision-return-transition',
      decision: 'approve-expansion-and-replan', blockerDigest: `sha256:${'a'.repeat(64)}`,
      approvedDeltaDigest: `sha256:${'b'.repeat(64)}`,
      rationale: 'Approve only the bounded return.', priorDecisionIds: [],
    },
  });
  assert.equal(pending.scopeControl.gate, 'return-pending');
  assertCode(
    () => createTransitionPolicy().assertTransitionAllowed(
      pending,
      { ...integrated, scopeControl: pending.scopeControl },
      undefined,
      cwd,
    ),
    'SCOPE_TASK_BLOCKED',
  );
});

test('transition policy selects the latest exact task evidence independently of scope root identity', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'opaque, task "identity"',
        sourceIds: ['thread:root-one', 'thread:root-two'],
        fingerprint: 'fingerprint-policy-map',
        status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, proposed.tasks[0].id, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const scoped = harness.scopeReadyForPacket(cwd, proposed, packet);
  harness.planSpecialists({
    cwd, input: harness.planInput(scoped, packet), expectedRevision: scoped.revision,
    now: () => harness.AT,
  });
  const bound = checkpointTaskPacketBinding({ cwd, packet, expectedRevision: scoped.revision });
  const pair = harness.scopePair(packet.reviewedHeadSha, packet);
  const exactClassification = {
    entryId: 'classification-independent-policy-root', at: harness.AT,
    reviewHeadSha: packet.reviewedHeadSha, rootCauseId: 'independent-policy-root',
    findingIds: [...bound.tasks[0].sourceIds].reverse(),
    findingFingerprints: bound.tasks[0].sourceIds.map(
      (_sourceId, index) => `${bound.tasks[0].fingerprint}-f${index + 1}`,
    ).reverse(),
    classification: 'within-scope-defect', assessment: pair,
    authorityAmendmentRequired: false, unrelatedReference: null,
    remediationShapeDigest: `sha256:${harness.taskPacketDigest(packet)}`, tripwires: [],
  };
  const classified = checkpointScopeClassification({
    cwd, classification: exactClassification, expectedRevision: bound.revision,
  });
  const queued = {
    ...classified,
    tasks: classified.tasks.map((task) => task.id === packet.taskId ? { ...task, status: 'queued' } : task),
  };
  assert.doesNotThrow(() => createTransitionPolicy().assertTransitionAllowed(
    classified, queued, undefined, cwd,
  ));

  const changedPacket = { ...packet, evidence: 'A different remediation shape.' };
  const changedPair = harness.scopePair(changedPacket.reviewedHeadSha, changedPacket);
  const stale = checkpointScopeClassification({
    cwd,
    expectedRevision: classified.revision,
    classification: {
      ...exactClassification,
      entryId: 'classification-independent-policy-root-stale-shape',
      rootCauseId: 'independent-policy-root-stale-shape',
      assessment: changedPair,
      remediationShapeDigest: `sha256:${harness.taskPacketDigest(changedPacket)}`,
    },
  });
  const staleQueued = {
    ...stale,
    tasks: stale.tasks.map((task) => task.id === packet.taskId ? { ...task, status: 'queued' } : task),
  };
  assertCode(
    () => createTransitionPolicy().assertTransitionAllowed(stale, staleQueued, undefined, cwd),
    'SCOPE_CLASSIFICATION_REQUIRED',
  );
});
