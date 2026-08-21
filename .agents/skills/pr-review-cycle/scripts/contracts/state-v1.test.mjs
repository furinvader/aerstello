import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validatePrReviewStateV1 as validateAggregateStateV1 } from './contracts.mjs';
import { validatePrReviewStateV1 } from './state-v1.mjs';

const AT = '2026-08-05T00:00:00Z';
const HEAD = 'a'.repeat(40);

function historicalStateFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 0,
    repository: 'example/aerstello',
    prNumber: 17,
    phase: 'recovering',
    baseSha: HEAD,
    requestedHeadSha: null,
    reviewedHeadSha: null,
    currentIntegrationHeadSha: HEAD,
    reviewRound: 0,
    releaseBaseline: null,
    decisions: [],
    tasks: [],
    reviewRequest: null,
    reviewSubmission: null,
    blockedReasons: [],
    validationStatus: { status: 'not-run', headSha: null, checks: [], updatedAt: null },
    nextAction: 'Recover exact context.',
    integrationWorktree: '/tmp/integration',
    orchestratorSessionId: null,
    git: { branch: 'main', headSha: HEAD, dirty: false },
    updatedAt: AT,
    ...overrides,
  };
}

function historicalTaskFixture(overrides = {}) {
  return {
    id: 'historical-task',
    sourceIds: ['review:one'],
    fingerprint: 'historical-fingerprint',
    summary: 'Retain historical policy.',
    severity: 'P1',
    disposition: 'needs-human-decision',
    status: 'not-applicable',
    dependencies: [],
    ownedPaths: ['scripts/workflow.mjs'],
    worker: null,
    branch: null,
    worktree: null,
    commitSha: null,
    validationSummaries: [],
    lastError: null,
    ...overrides,
  };
}

test('schema-v1 accepts direct historical state and task fixtures', () => {
  const fixtures = [
    historicalStateFixture(),
    historicalStateFixture({
      phase: 'blocked',
      tasks: [historicalTaskFixture()],
      blockedReasons: ['A historical decision is required.'],
    }),
    historicalStateFixture({
      phase: 'complete',
      tasks: [historicalTaskFixture({ disposition: 'already-fixed', status: 'completed' })],
    }),
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(validatePrReviewStateV1(fixture), []);
    assert.deepEqual(validatePrReviewStateV1(fixture), validateAggregateStateV1(fixture));
  }
});

test('schema-v1 uses literal historical phase, status, and disposition snapshots', () => {
  const invalidFixtures = [
    historicalStateFixture({ phase: 'awaiting-human-decision' }),
    historicalStateFixture({ tasks: [historicalTaskFixture({ status: 'cancelled' })] }),
    historicalStateFixture({ tasks: [historicalTaskFixture({ disposition: 'deferred' })] }),
  ];

  for (const fixture of invalidFixtures) {
    const errors = validatePrReviewStateV1(fixture);
    assert.notDeepEqual(errors, []);
    assert.deepEqual(errors, validateAggregateStateV1(fixture));
  }
});

test('schema-v1 preserves aggregate error ordering and unknown-field rejection', () => {
  const invalid = historicalStateFixture({
    schemaVersion: 3,
    revision: -1,
    repository: 'invalid',
    phase: 'awaiting-human-decision',
    repairHint: 'guess',
  });

  assert.deepEqual(validatePrReviewStateV1(invalid), [
    '$.repairHint is not supported',
    '$.schemaVersion must equal 1',
    '$.revision must be a non-negative integer',
    '$.repository must be owner/name',
    '$.phase is invalid',
  ]);
  assert.deepEqual(validatePrReviewStateV1(invalid), validateAggregateStateV1(invalid));
});
