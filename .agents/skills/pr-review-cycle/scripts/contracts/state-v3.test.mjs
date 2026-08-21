import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { validatePrReviewState as validateAggregateState } from './contracts.mjs';
import {
  FINDING_DISPOSITIONS,
  STATE_PHASES,
  TASK_STATUSES,
  validatePrReviewState,
} from './state-v3.mjs';
import { prReviewStateSchemaPath } from '../paths.mjs';

const AT = '2026-08-05T00:00:00Z';
const HEAD = 'a'.repeat(40);

function stateFixture(overrides = {}) {
  return {
    schemaVersion: 3,
    revision: 0,
    repository: 'example/aerstello',
    prNumber: 17,
    phase: 'recovering',
    baseSha: HEAD,
    requestedHeadSha: null,
    reviewedHeadSha: null,
    currentIntegrationHeadSha: HEAD,
    reviewRound: 0,
    verificationReviewUsed: false,
    legacyReviewProvenance: null,
    releaseBaseline: null,
    decisions: [],
    tasks: [],
    reviewRequest: null,
    reviewOutcome: null,
    reviewHistory: [],
    verificationEscalation: null,
    threadResolutionStatus: {
      status: 'not-run',
      headSha: null,
      threads: [],
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
    nextAction: 'Recover exact context.',
    integrationWorktree: '/tmp/integration',
    orchestratorSessionId: null,
    abandonmentReason: null,
    git: { branch: 'main', headSha: HEAD, dirty: false },
    updatedAt: AT,
    ...overrides,
  };
}

function requestFixture(overrides = {}) {
  return {
    id: 'request',
    databaseId: 101,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-101',
    headSha: HEAD,
    at: AT,
    kind: 'discovery',
    body: '@codex review',
    authorLogin: 'maintainer',
    authorNodeId: 'USER_maintainer',
    ...overrides,
  };
}

function outcomeFixture(request = requestFixture(), overrides = {}) {
  return {
    id: 'review',
    databaseId: 102,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-102',
    headSha: request.headSha,
    at: AT,
    requestId: request.id,
    kind: request.kind,
    outcome: 'clean',
    evidenceType: 'review-submission',
    reviewerLogin: 'chatgpt-codex-connector',
    reviewerNodeId: 'BOT_codex',
    reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector',
    reactionContent: null,
    reactionCommentId: null,
    ...overrides,
  };
}

function readyStateFixture(overrides = {}) {
  return stateFixture({
    phase: 'ready-for-review',
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: HEAD,
      checks: ['npm run check:workflow'], updatedAt: AT,
    },
    threadResolutionStatus: {
      status: 'passed', headSha: HEAD, threads: [],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: AT,
    },
    ...overrides,
  });
}

function completeStateFixture(overrides = {}) {
  const request = requestFixture();
  const outcome = outcomeFixture(request);
  const ci = {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation', 'Full E2E'], workflowRunId: 99,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/99', updatedAt: AT,
  };
  return readyStateFixture({
    phase: 'complete',
    requestedHeadSha: HEAD,
    reviewedHeadSha: HEAD,
    reviewRound: 1,
    reviewRequest: request,
    reviewOutcome: outcome,
    reviewHistory: [{ request, outcome }],
    ciValidationStatus: ci,
    ciValidationHistory: [ci],
    nextAction: 'Archive the completed cycle.',
    ...overrides,
  });
}

function awaitingReviewFixture() {
  const request = requestFixture();
  return stateFixture({
    phase: 'awaiting-review',
    requestedHeadSha: HEAD,
    reviewRound: 1,
    reviewRequest: request,
    reviewHistory: [{ request, outcome: null }],
  });
}

function escalatedStateFixture() {
  const request = requestFixture({ id: 'verification-request', kind: 'verification' });
  return stateFixture({
    phase: 'awaiting-human-decision',
    requestedHeadSha: HEAD,
    reviewRound: 3,
    verificationReviewUsed: true,
    legacyReviewProvenance: { schemaVersion: 1, discoveryRounds: 3, migratedAt: AT },
    reviewRequest: request,
    reviewHistory: [{ request, outcome: null }],
    verificationEscalation: {
      requestId: request.id,
      requestHeadSha: HEAD,
      observedPrHeadSha: HEAD,
      headRelation: 'same',
      evidenceIds: ['review:PRR_stale'],
      reason: 'stale-canonical-evidence',
      at: AT,
    },
  });
}

function executionFixture() {
  return {
    dependencies: [], ownedPaths: ['scripts/workflow.mjs'], worker: null, branch: null,
    worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
  };
}

function taskFixture(overrides = {}) {
  return {
    id: 'task', sourceIds: ['local:audit'], sourceType: 'local', fingerprint: 'task-fingerprint',
    summary: 'Apply the finding.', severity: 'P1', disposition: 'actionable', status: 'queued',
    integratedCommitSha: null, resolutionSummary: null, execution: executionFixture(),
    ...overrides,
  };
}

test('schema-v3 exports the current literal policy and accepts every phase', () => {
  assert.deepEqual(STATE_PHASES, [
    'recovering', 'ready-for-review', 'awaiting-review', 'triaging', 'implementing',
    'integrating', 'verifying', 'validating', 'awaiting-human-decision', 'blocked', 'complete',
  ]);
  assert.deepEqual(TASK_STATUSES, [
    'proposed', 'queued', 'running', 'implemented', 'integrated', 'completed',
    'blocked', 'not-applicable', 'failed',
  ]);
  assert.deepEqual(FINDING_DISPOSITIONS, [
    'actionable', 'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict',
    'out-of-scope', 'needs-human-decision',
  ]);

  const specialized = new Map([
    ['ready-for-review', readyStateFixture()],
    ['awaiting-review', awaitingReviewFixture()],
    ['awaiting-human-decision', escalatedStateFixture()],
    ['complete', completeStateFixture()],
  ]);
  for (const phase of STATE_PHASES) {
    const fixture = specialized.get(phase) ?? stateFixture({ phase });
    assert.deepEqual(validatePrReviewState(fixture), [], phase);
    assert.deepEqual(validatePrReviewState(fixture), validateAggregateState(fixture), phase);
  }
});

test('schema-v3 retains JSON Schema parity for representative valid and invalid states', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const valid = [stateFixture(), readyStateFixture(), awaitingReviewFixture(), escalatedStateFixture(), completeStateFixture()];
  for (const fixture of valid) {
    assert.equal(validateSchema(fixture), true, JSON.stringify(validateSchema.errors));
    assert.deepEqual(validatePrReviewState(fixture), []);
  }

  const invalid = [
    stateFixture({ repository: 'invalid' }),
    stateFixture({ phase: 'unknown' }),
    stateFixture({ reviewRequestLimit: 0 }),
    stateFixture({ tasks: [taskFixture({ execution: undefined })] }),
    stateFixture({ tasks: [taskFixture({ status: 'completed', execution: executionFixture() })] }),
    stateFixture({ tasks: [taskFixture({ status: 'completed', execution: undefined, resolutionSummary: 'Done.' })] }),
  ];
  for (const fixture of invalid) {
    assert.equal(validateSchema(fixture), false, 'JSON Schema must reject the fixture');
    assert.notDeepEqual(validatePrReviewState(fixture), [], 'manual validator must reject the fixture');
  }
});

test('schema-v3 preserves aggregate error order and lifecycle cross-field invariants', () => {
  const malformed = stateFixture({
    schemaVersion: 1,
    revision: -1,
    repository: 'invalid',
    phase: 'unknown',
    repairHint: 'guess',
  });
  assert.deepEqual(validatePrReviewState(malformed), [
    '$.repairHint is not supported',
    '$.schemaVersion must equal 3',
    '$.revision must be non-negative',
    '$.repository must be owner/name',
    '$.phase is invalid',
  ]);
  assert.deepEqual(validatePrReviewState(malformed), validateAggregateState(malformed));

  const pending = awaitingReviewFixture();
  const completed = taskFixture({
    status: 'completed', execution: undefined, integratedCommitSha: HEAD, resolutionSummary: 'Done.',
  });
  const cases = [
    { ...pending, reviewOutcome: outcomeFixture(pending.reviewRequest) },
    { ...pending, requestedHeadSha: 'b'.repeat(40) },
    readyStateFixture({ git: { branch: 'main', headSha: HEAD, dirty: true } }),
    readyStateFixture({ tasks: [completed] }),
    completeStateFixture({ reviewedHeadSha: 'b'.repeat(40) }),
    completeStateFixture({ ciValidationHistory: [] }),
    { ...stateFixture(), rawLog: 'attached' },
  ];
  for (const fixture of cases) {
    const errors = validatePrReviewState(fixture);
    assert.notDeepEqual(errors, []);
    assert.deepEqual(errors, validateAggregateState(fixture));
  }
});
