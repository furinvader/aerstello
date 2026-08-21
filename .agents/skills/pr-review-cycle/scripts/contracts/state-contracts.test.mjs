import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildStaleDiscoveryDisposition,
  reviewRequestGate,
  reviewRequestUsage,
  staleDiscoveryDispositionId,
  validatePrReviewState,
} from './contracts.mjs';
import { prReviewStateSchemaPath } from '../paths.mjs';

const AT = '2026-08-05T00:00:00Z';

function stateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  return {
    schemaVersion: 3, revision: 0, repository: 'example/aerstello', prNumber: 17, phase: 'recovering',
    baseSha: head, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: head,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [], verificationEscalation: null,
    threadResolutionStatus: {
      status: 'not-run', headSha: null, threads: [],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: null,
    },
    blockedReasons: [],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null,
    },
    ciValidationStatus: {
      source: 'github-actions', scope: 'full', status: 'not-run', headSha: null, checks: [],
      workflowRunId: null, workflowRunUrl: null, updatedAt: null,
    },
    ciValidationHistory: [],
    nextAction: 'Recover exact context.', integrationWorktree: '/tmp/integration', orchestratorSessionId: null,
    abandonmentReason: null, git: { branch: 'main', headSha: head, dirty: false }, updatedAt: AT,
    ...overrides,
  };
}

function threadFixture(overrides = {}) {
  return {
    threadNodeId: 'PRRT_node', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 9,
    taskIds: ['task'], disposition: 'fixed', replyId: 'PRRC_reply',
    replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r9', isResolved: true,
    resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: 'a'.repeat(40), ...overrides,
  };
}

function escalatedStateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  const request = {
    id: 'verification-request', databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-101', headSha: head, at: AT,
    kind: 'verification', body: '@codex review', authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
  };
  return stateFixture({
    phase: 'awaiting-human-decision', requestedHeadSha: head, reviewRound: 3, verificationReviewUsed: true,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT },
    reviewRequest: request, reviewHistory: [{ request, outcome: null }],
    verificationEscalation: {
      requestId: request.id, requestHeadSha: head, observedPrHeadSha: head, headRelation: 'same',
      evidenceIds: ['review:PRR_stale'], reason: 'stale-canonical-evidence', at: AT,
    },
    ...overrides,
  });
}

function readyStateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  return stateFixture({
    phase: 'ready-for-review',
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: head,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    threadResolutionStatus: {
      status: 'passed', headSha: head, threads: [],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: AT,
    },
    ...overrides,
  });
}

function completeStateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  const request = {
    id: 'request', databaseId: 101, url: 'https://github.com/example/aerstello/pull/17#issuecomment-101',
    headSha: head, at: AT, kind: 'discovery', body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
  };
  const outcome = {
    id: 'review', databaseId: 102, url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-102',
    headSha: head, at: AT, requestId: request.id, kind: 'discovery', outcome: 'clean',
    evidenceType: 'review-submission', reviewerLogin: 'chatgpt-codex-connector', reviewerNodeId: 'BOT_codex',
    reviewerType: 'Bot', reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
    reactionContent: null, reactionCommentId: null,
  };
  const ci = {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: head,
    checks: ['Full validation', 'Full E2E'], workflowRunId: 99,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/99', updatedAt: AT,
  };
  return readyStateFixture({
    phase: 'complete', requestedHeadSha: head, reviewedHeadSha: head, reviewRound: 1,
    reviewRequest: request, reviewOutcome: outcome, reviewHistory: [{ request, outcome }],
    ciValidationStatus: ci, ciValidationHistory: [ci], nextAction: 'Archive the completed cycle.',
    ...overrides,
  });
}

function staleDiscoveryStateFixture({ outcome = 'clean', stateOverrides = {} } = {}) {
  const liveHead = 'a'.repeat(40);
  const requestHead = 'b'.repeat(40);
  const request = {
    id: 'stale-discovery-request', databaseId: 301,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-301',
    headSha: requestHead, at: AT, kind: 'discovery', body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
  };
  const evidence = {
    id: 'stale-discovery-response', databaseId: 302,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-302',
    headSha: requestHead, at: AT, requestId: request.id, kind: 'discovery', outcome,
    evidenceType: 'review-submission', reviewerLogin: 'chatgpt-codex-connector',
    reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
    reactionContent: null, reactionCommentId: null,
  };
  const disposition = buildStaleDiscoveryDisposition({
    request, liveHeadSha: liveHead, evidence, responseFingerprint: 'd'.repeat(64), disposedAt: AT,
  });
  return stateFixture({
    phase: outcome === 'findings' ? 'triaging' : 'recovering',
    requestedHeadSha: requestHead, reviewedHeadSha: null,
    currentIntegrationHeadSha: liveHead, reviewRound: 1,
    reviewRequest: request, reviewOutcome: null, reviewHistory: [{ request, outcome: null }],
    staleDiscoveryDispositions: [disposition],
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: liveHead,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    git: { branch: 'main', headSha: liveHead, dirty: false },
    ...stateOverrides,
  });
}

test('stale discovery dispositions have strict schema shape and exact manual bindings', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const valid = staleDiscoveryStateFixture();
  const findings = staleDiscoveryStateFixture({ outcome: 'findings' });
  for (const fixture of [valid, findings]) {
    assert.equal(validateSchema(fixture), true, JSON.stringify(validateSchema.errors));
    assert.deepEqual(validatePrReviewState(fixture), []);
  }
  const legacyWithoutLedger = structuredClone(valid);
  delete legacyWithoutLedger.staleDiscoveryDispositions;
  assert.equal(validateSchema(legacyWithoutLedger), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(legacyWithoutLedger), []);

  const verificationEvidence = structuredClone(valid);
  verificationEvidence.staleDiscoveryDispositions[0].evidence.kind = 'verification';
  verificationEvidence.staleDiscoveryDispositions[0].dispositionId = staleDiscoveryDispositionId(
    verificationEvidence.staleDiscoveryDispositions[0],
  );
  assert.equal(validateSchema(verificationEvidence), false);
  assert.match(validatePrReviewState(verificationEvidence).join('\n'), /discovery response/u);

  const migrated = structuredClone(valid);
  migrated.legacyReviewProvenance = { schemaVersion: 1, discoveryRounds: 1, migratedAt: AT };
  migrated.reviewRound = 2;
  assert.equal(validateSchema(migrated), false);
  assert.match(validatePrReviewState(migrated).join('\n'), /native schema-v3/u);

  const unknownField = structuredClone(valid);
  unknownField.staleDiscoveryDispositions[0].repairHint = 'guess';
  assert.equal(validateSchema(unknownField), false);
  assert.match(validatePrReviewState(unknownField).join('\n'), /repairHint is not supported/u);

  const invalidFingerprint = structuredClone(valid);
  invalidFingerprint.staleDiscoveryDispositions[0].responseFingerprint = 'not-a-fingerprint';
  invalidFingerprint.staleDiscoveryDispositions[0].dispositionId = staleDiscoveryDispositionId(
    invalidFingerprint.staleDiscoveryDispositions[0],
  );
  assert.equal(validateSchema(invalidFingerprint), false);
  assert.match(validatePrReviewState(invalidFingerprint).join('\n'), /responseFingerprint/u);

  const overBound = structuredClone(valid);
  overBound.staleDiscoveryDispositions = Array.from(
    { length: 4 },
    (_, index) => ({ ...valid.staleDiscoveryDispositions[0], dispositionId: `${index}`.repeat(64) }),
  );
  assert.equal(validateSchema(overBound), false);
  assert.match(validatePrReviewState(overBound).join('\n'), /at most three/u);

  for (const mutate of [
    (fixture) => { fixture.staleDiscoveryDispositions[0].liveHeadSha = 'b'.repeat(40); },
    (fixture) => { fixture.staleDiscoveryDispositions[0].evidence.requestId = 'foreign-request'; },
    (fixture) => { fixture.staleDiscoveryDispositions[0].disposedAt = '2026-08-04T23:59:59Z'; },
    (fixture) => { fixture.reviewHistory[0].outcome = fixture.staleDiscoveryDispositions[0].evidence; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    invalid.staleDiscoveryDispositions[0].dispositionId = staleDiscoveryDispositionId(
      invalid.staleDiscoveryDispositions[0],
    );
    assert.notDeepEqual(validatePrReviewState(invalid), []);
  }

  const tamperedIdentity = structuredClone(valid);
  tamperedIdentity.staleDiscoveryDispositions[0].evidence.id = 'edited-response';
  assert.match(validatePrReviewState(tamperedIdentity).join('\n'), /immutable evidence/u);
});

test('local verifier proof is backward-readable, source-bound, and mandatory for completed local readiness', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const head = 'a'.repeat(40);
  const completedLocal = {
    id: 'local-task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'local-fingerprint',
    summary: 'Verified locally.', severity: 'P1', disposition: 'actionable', status: 'completed',
    integratedCommitSha: head, resolutionSummary: 'Verified.',
  };
  const historicalWithoutProof = stateFixture({ tasks: [completedLocal] });
  assert.equal(validateSchema(historicalWithoutProof), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(historicalWithoutProof), []);

  const localVerification = { status: 'passed', headSha: head, taskIds: ['local-task'], updatedAt: AT };
  const readyProof = {
    ...readyStateFixture().threadResolutionStatus,
    localVerification,
  };
  const readyWithProof = readyStateFixture({ tasks: [completedLocal], threadResolutionStatus: readyProof });
  const completeWithProof = completeStateFixture({ tasks: [completedLocal], threadResolutionStatus: readyProof });
  for (const fixture of [readyWithProof, completeWithProof]) {
    assert.equal(validateSchema(fixture), true, JSON.stringify(validateSchema.errors));
    assert.deepEqual(validatePrReviewState(fixture), []);
  }
  for (const fixture of [
    readyStateFixture({ tasks: [completedLocal] }),
    completeStateFixture({ tasks: [completedLocal] }),
  ]) {
    assert.equal(validateSchema(fixture), false, 'ready/Done schema must require local proof');
    assert.match(validatePrReviewState(fixture).join('\n'), /local verifier proof/u);
  }
  for (const localProof of [
    { ...localVerification, status: 'failed' },
    { ...localVerification, headSha: 'b'.repeat(40) },
    { ...localVerification, taskIds: [] },
  ]) {
    const invalid = readyStateFixture({
      tasks: [completedLocal],
      threadResolutionStatus: { ...readyProof, localVerification: localProof },
    });
    assert.notDeepEqual(validatePrReviewState(invalid), []);
  }

  const githubTask = {
    ...completedLocal, id: 'github-task', sourceType: 'github-threadless', status: 'integrated',
    sourceIds: ['review:threadless'], fingerprint: 'github-fingerprint',
  };
  const integratedLocal = { ...completedLocal, id: 'integrated-local', status: 'integrated' };
  for (const [taskId, tasks, reason] of [
    ['unknown', [completedLocal], /unknown task/u],
    ['github-task', [githubTask], /non-local task/u],
    ['integrated-local', [integratedLocal], /ineligible local task/u],
  ]) {
    const invalid = stateFixture({
      tasks,
      threadResolutionStatus: {
        ...stateFixture().threadResolutionStatus,
        localVerification: { status: 'passed', headSha: head, taskIds: [taskId], updatedAt: AT },
      },
    });
    assert.match(validatePrReviewState(invalid).join('\n'), reason);
  }
});

test('state JSON Schema rejects terminal and review-ready states missing current proof shapes', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const ready = readyStateFixture();
  const complete = completeStateFixture();
  assert.equal(validateSchema(ready), true, JSON.stringify(validateSchema.errors));
  assert.equal(validateSchema(complete), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(ready), []);
  assert.deepEqual(validatePrReviewState(complete), []);
  const issueCommentOutcome = {
    ...complete.reviewOutcome, id: 'clean-comment', databaseId: 103,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-103', evidenceType: 'issue-comment',
  };
  const issueCommentState = completeStateFixture({
    reviewOutcome: issueCommentOutcome,
    reviewHistory: [{ request: complete.reviewRequest, outcome: issueCommentOutcome }],
  });
  assert.equal(validateSchema(issueCommentState), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(issueCommentState), []);
  for (const outcome of [
    { ...issueCommentOutcome, outcome: 'findings' },
    { ...issueCommentOutcome, reactionContent: 'THUMBS_UP' },
  ]) {
    const malformed = completeStateFixture({
      reviewOutcome: outcome, reviewHistory: [{ request: complete.reviewRequest, outcome }],
    });
    assert.equal(validateSchema(malformed), false);
    assert.notDeepEqual(validatePrReviewState(malformed), []);
  }
  const attemptProof = { ...complete.ciValidationStatus, checkRunId: 'CHECK_attempt_1' };
  const attemptAware = completeStateFixture({
    ciValidationStatus: attemptProof, ciValidationHistory: [attemptProof],
  });
  assert.equal(validateSchema(attemptAware), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(attemptAware), []);
  for (const checkRunId of ['', null, 42]) {
    const malformed = completeStateFixture({
      ciValidationStatus: { ...attemptProof, checkRunId },
      ciValidationHistory: [{ ...attemptProof, checkRunId }],
    });
    assert.equal(validateSchema(malformed), false);
    assert.notDeepEqual(validatePrReviewState(malformed), []);
  }
  const rerunProof = { ...attemptProof, checkRunId: 'CHECK_attempt_2' };
  assert.deepEqual(validatePrReviewState(completeStateFixture({
    ciValidationStatus: rerunProof, ciValidationHistory: [attemptProof, rerunProof],
  })), []);
  const historicalHeadProof = {
    ...attemptProof, status: 'failed', headSha: 'b'.repeat(40), checkRunId: 'CHECK_head_b',
    workflowRunId: 100,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/100',
    updatedAt: '2026-08-05T00:01:00Z',
  };
  const restoredComplete = completeStateFixture({
    ciValidationStatus: attemptProof, ciValidationHistory: [attemptProof, historicalHeadProof],
  });
  assert.equal(validateSchema(restoredComplete), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(restoredComplete), []);

  const absentProof = {
    ...attemptProof, checkRunId: 'CHECK_absent', workflowRunId: 101,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/101',
  };
  assert.match(validatePrReviewState(completeStateFixture({
    ciValidationStatus: absentProof, ciValidationHistory: [attemptProof, historicalHeadProof],
  })).join('\n'), /immutable CI history entry/u);
  assert.notDeepEqual(validatePrReviewState(completeStateFixture({
    ciValidationStatus: rerunProof, ciValidationHistory: [rerunProof, rerunProof],
  })), []);

  const completedTask = {
    id: 'task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'audit-fingerprint',
    summary: 'Audited.', severity: 'P1', disposition: 'actionable', status: 'completed',
    integratedCommitSha: 'a'.repeat(40), resolutionSummary: 'Audited.',
  };
  const invalid = [
    readyStateFixture({ validationStatus: stateFixture().validationStatus }),
    readyStateFixture({ threadResolutionStatus: stateFixture().threadResolutionStatus }),
    readyStateFixture({ blockedReasons: ['Still blocked.'] }),
    readyStateFixture({ git: { branch: 'main', headSha: 'a'.repeat(40), dirty: true } }),
    readyStateFixture({ tasks: [{ ...completedTask, status: 'integrated' }] }),
    completeStateFixture({ ciValidationStatus: stateFixture().ciValidationStatus, ciValidationHistory: [] }),
    completeStateFixture({ requestedHeadSha: null }),
    completeStateFixture({ reviewedHeadSha: null }),
    completeStateFixture({ ciValidationHistory: [] }),
    completeStateFixture({ reviewHistory: [] }),
    completeStateFixture({ reviewOutcome: { ...complete.reviewOutcome, outcome: 'findings' } }),
    completeStateFixture({ tasks: [{ ...completedTask, status: 'integrated' }] }),
    completeStateFixture({ tasks: [{ ...completedTask, disposition: 'needs-human-decision' }] }),
  ];
  for (const fixture of invalid) {
    assert.equal(validateSchema(fixture), false, 'schema must reject an unready terminal/readiness state');
    assert.notDeepEqual(validatePrReviewState(fixture), [], 'manual validator must reject the same state');
  }
});

test('review requests are unlimited by default and an explicit positive limit counts every durable request', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const head = 'a'.repeat(40);
  const entries = Array.from({ length: 6 }, (_, index) => {
    const kind = index < 3 ? 'discovery' : 'verification';
    const request = {
      id: `request-${index + 1}`, databaseId: 100 + index,
      url: `https://github.com/example/aerstello/pull/17#issuecomment-${100 + index}`,
      headSha: head, at: AT, kind, body: '@codex review',
      authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
    };
    const outcome = {
      id: `review-${index + 1}`, databaseId: 200 + index,
      url: `https://github.com/example/aerstello/pull/17#pullrequestreview-${200 + index}`,
      headSha: head, at: AT, requestId: request.id, kind, outcome: 'findings',
      evidenceType: 'review-submission', reviewerLogin: 'chatgpt-codex-connector',
      reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
      reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
      reactionContent: null, reactionCommentId: null,
    };
    return { request, outcome };
  });
  const latest = entries.at(-1);
  const unlimited = readyStateFixture({
    requestedHeadSha: head, reviewedHeadSha: head, reviewRound: 3, verificationReviewUsed: true,
    reviewRequest: latest.request, reviewOutcome: latest.outcome, reviewHistory: entries,
  });
  assert.equal(validateSchema(unlimited), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(unlimited), []);
  assert.deepEqual(reviewRequestUsage(unlimited), {
    used: 6, limit: null, remaining: null, exhausted: false,
  });
  const external = {
    localHeadSha: head, localDirty: false, pushedHeadSha: head, prHeadSha: head, prState: 'OPEN', isDraft: false,
    isAncestor: () => true,
  };
  assert.deepEqual(reviewRequestGate(unlimited, external), { allowed: true, kind: 'verification', reasons: [] });

  const finite = { ...unlimited, reviewRequestLimit: 6 };
  assert.equal(validateSchema(finite), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(finite), []);
  assert.equal(reviewRequestGate(finite, external).allowed, false);
  assert.match(reviewRequestGate(finite, external).reasons.join('\n'), /explicit review request limit 6/u);

  for (const reviewRequestLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '6']) {
    const invalid = { ...unlimited, reviewRequestLimit };
    assert.equal(validateSchema(invalid), false);
    assert.match(validatePrReviewState(invalid).join('\n'), /reviewRequestLimit/u);
  }
  assert.match(validatePrReviewState({ ...unlimited, reviewRequestLimit: 5 }).join('\n'), /lower than/u);

  const outOfOrder = structuredClone(unlimited);
  outOfOrder.reviewHistory[3].request.kind = 'discovery';
  outOfOrder.reviewHistory[3].outcome.kind = 'discovery';
  assert.match(validatePrReviewState(outOfOrder).join('\n'), /must be verification/u);

  const legacyEntries = entries.slice(2);
  const legacy = {
    ...unlimited,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 2, migratedAt: AT },
    reviewHistory: legacyEntries,
    reviewRequest: legacyEntries.at(-1).request,
    reviewOutcome: legacyEntries.at(-1).outcome,
  };
  assert.equal(reviewRequestUsage(legacy).used, 6);
  assert.deepEqual(validatePrReviewState(legacy), []);
});

test('superseded null-outcome requests remain valid when the integration HEAD returns', () => {
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  const requestA = {
    id: 'request-a', databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-101',
    headSha: headA, at: AT, kind: 'discovery', body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
  };
  const requestB = {
    ...requestA, id: 'request-b', databaseId: 102,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-102', headSha: headB,
  };
  const returnedToA = stateFixture({
    phase: 'recovering', currentIntegrationHeadSha: headA,
    requestedHeadSha: headB, reviewRound: 2, reviewRequest: requestB,
    reviewHistory: [{ request: requestA, outcome: null }, { request: requestB, outcome: null }],
    git: { branch: 'main', headSha: headA, dirty: false },
  });
  const immutableHistory = structuredClone(returnedToA.reviewHistory);

  assert.deepEqual(validatePrReviewState(returnedToA), []);
  assert.deepEqual(returnedToA.reviewHistory, immutableHistory);
  assert.equal(returnedToA.reviewRequest.id, requestB.id);

  const outcomeA = {
    id: 'review-a', databaseId: 103,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-103',
    headSha: headA, at: AT, requestId: requestA.id, kind: 'discovery', outcome: 'clean',
    evidenceType: 'review-submission', reviewerLogin: 'chatgpt-codex-connector',
    reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
    reactionContent: null, reactionCommentId: null,
  };
  for (const outcome of [
    { ...outcomeA, requestId: requestB.id },
    { ...outcomeA, headSha: headB },
  ]) {
    assert.ok(validatePrReviewState({
      ...returnedToA,
      reviewHistory: [{ request: requestA, outcome }, { request: requestB, outcome: null }],
    }).some((error) => error.includes('outcome must bind')));
  }
  assert.ok(validatePrReviewState({
    ...returnedToA, reviewRequest: requestA,
  }).some((error) => error.includes('reviewRequest must equal')));
  assert.ok(validatePrReviewState({
    ...returnedToA,
    reviewHistory: [
      { request: requestA, outcome: null },
      { request: { ...requestB, id: requestA.id }, outcome: null },
    ],
  }).some((error) => error.includes('duplicate request IDs')));
  assert.ok(validatePrReviewState({
    ...returnedToA, phase: 'validating',
  }).some((error) => error.includes('phase is invalid for the pending')));
});

test('manual escalation binding rejects a mismatched pending request identity or SHA', () => {
  const valid = escalatedStateFixture();
  for (const verificationEscalation of [
    { ...valid.verificationEscalation, requestId: 'other-request' },
    { ...valid.verificationEscalation, requestHeadSha: 'b'.repeat(40) },
    {
      ...valid.verificationEscalation, reason: 'request-head-drift',
      headRelation: 'changed', observedPrHeadSha: valid.verificationEscalation.requestHeadSha,
    },
  ]) {
    assert.ok(validatePrReviewState({ ...valid, verificationEscalation }).some(
      (error) => error.includes('verificationEscalation'),
    ));
  }
});

test('unresolved canonical thread may retain paired reply evidence for recovery', () => {
  const state = stateFixture({
    threadResolutionStatus: {
      status: 'failed', headSha: 'a'.repeat(40), threads: [
        threadFixture({ isResolved: false, resolvedAt: null, resolvedBy: null }),
      ],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: AT,
    },
  });
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(validateSchema(state), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(state), []);
});

test('archive provenance is optional for legacy rows and strictly binds a multi-history aggregate', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  assert.equal(schema.$defs.threadRecord.required.includes('archiveProvenance'), false);
  assert.equal(schema.$defs.archiveProvenance.additionalProperties, false);
  assert.equal(schema.$defs.archiveProvenance.properties.schemaVersion.const, 1);
  assert.equal(schema.$defs.archiveProvenance.properties.replyBodySha256.pattern, '^[0-9a-f]{64}$');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const activeTask = {
    id: 'aggregate-task',
    sourceIds: ['thread:PRRT_one', 'thread:PRRT_two'],
    sourceType: 'github-thread', fingerprint: 'aggregate-task-fingerprint',
    summary: 'Retain two historical roots.', severity: 'P1', disposition: 'already-fixed',
    status: 'completed', integratedCommitSha: null,
    resolutionSummary: 'Composite archive authority retained.',
  };
  const authorityFingerprint = 'c'.repeat(64);
  const provenanceRows = [
    threadFixture({
      threadNodeId: 'PRRT_one', rootCommentNodeId: 'PRRC_one', rootCommentDatabaseId: 11,
      taskIds: [activeTask.id], disposition: 'already-fixed', replyId: 'PRRC_reply_one',
      replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r11',
      archiveProvenance: {
        schemaVersion: 1,
        historicalTaskId: 'historical-fixed',
        historicalDisposition: 'fixed',
        historicalIntegratedCommitSha: 'b'.repeat(40),
        replyBodySha256: '1'.repeat(64),
        authorityFingerprint,
      },
    }),
    threadFixture({
      threadNodeId: 'PRRT_two', rootCommentNodeId: 'PRRC_two', rootCommentDatabaseId: 12,
      taskIds: [activeTask.id], disposition: 'already-fixed', replyId: 'PRRC_reply_two',
      replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r12',
      observedHeadSha: 'd'.repeat(40),
      archiveProvenance: {
        schemaVersion: 1,
        historicalTaskId: 'historical-already-fixed',
        historicalDisposition: 'already-fixed',
        historicalIntegratedCommitSha: null,
        replyBodySha256: '2'.repeat(64),
        authorityFingerprint,
      },
    }),
  ];
  const valid = stateFixture({
    tasks: [activeTask],
    threadResolutionStatus: {
      status: 'passed', headSha: 'a'.repeat(40), threads: provenanceRows,
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: AT,
    },
  });
  assert.equal(validateSchema(valid), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(valid), []);
  const legacy = structuredClone(valid);
  for (const row of legacy.threadResolutionStatus.threads) delete row.archiveProvenance;
  assert.equal(validateSchema(legacy), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(legacy), []);

  for (const [label, mutate] of [
    ['missing field', (state) => { delete state.threadResolutionStatus.threads[0].archiveProvenance.replyBodySha256; }],
    ['unknown field', (state) => { state.threadResolutionStatus.threads[0].archiveProvenance.extra = true; }],
    ['wrong version', (state) => { state.threadResolutionStatus.threads[0].archiveProvenance.schemaVersion = 2; }],
    ['bad body hash', (state) => { state.threadResolutionStatus.threads[0].archiveProvenance.replyBodySha256 = 'A'.repeat(64); }],
    ['fixed without commit', (state) => { state.threadResolutionStatus.threads[0].archiveProvenance.historicalIntegratedCommitSha = null; }],
    ['already-fixed with commit', (state) => { state.threadResolutionStatus.threads[1].archiveProvenance.historicalIntegratedCommitSha = 'e'.repeat(40); }],
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(validateSchema(invalid), false, label);
    assert.notDeepEqual(validatePrReviewState(invalid), [], label);
  }

  const unresolved = structuredClone(valid);
  Object.assign(unresolved.threadResolutionStatus.threads[0], {
    isResolved: false, resolvedAt: null, resolvedBy: null,
  });
  assert.equal(validateSchema(unresolved), false, 'unresolved rows must schema-forbid archive provenance');
  assert.ok(validatePrReviewState(unresolved).some((error) => error.includes('adopted resolved')));
  const divergentAuthority = structuredClone(valid);
  divergentAuthority.threadResolutionStatus.threads[1].archiveProvenance.authorityFingerprint = 'f'.repeat(64);
  assert.ok(validatePrReviewState(divergentAuthority).some((error) => error.includes('diverges within')));
  const inconsistentPartition = structuredClone(valid);
  inconsistentPartition.threadResolutionStatus.threads[1].archiveProvenance = {
    ...inconsistentPartition.threadResolutionStatus.threads[0].archiveProvenance,
    replyBodySha256: '2'.repeat(64),
  };
  assert.ok(validatePrReviewState(inconsistentPartition).some(
    (error) => error.includes('historical task partition'),
  ));
});

test('manual state validation rejects every ambiguous canonical thread identifier', () => {
  const cases = [
    ['threadNodeId', 'PRRT_node'],
    ['rootCommentNodeId', 'PRRC_root'],
    ['rootCommentDatabaseId', 9],
    ['replyId', 'PRRC_reply'],
  ];
  for (const [field, duplicate] of cases) {
    const state = stateFixture({
      threadResolutionStatus: {
        status: 'failed', headSha: 'a'.repeat(40), threads: [
          threadFixture(),
          threadFixture({
            threadNodeId: 'PRRT_other', rootCommentNodeId: 'PRRC_other', rootCommentDatabaseId: 10,
            replyId: 'PRRC_other_reply', replyUrl: 'https://github.com/example/aerstello/pull/17#discussion_r10',
            [field]: duplicate,
          }),
        ],
        threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
        updatedAt: AT,
      },
    });
    assert.ok(validatePrReviewState(state).some((error) => error.includes('contains duplicate')), field);
  }
});
