import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  validatePrReviewState,
  validateTaskPacket,
  validateWorkerResult,
} from '../../scripts/lib/contracts.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const AT = '2026-08-05T00:00:00Z';

function stateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  return {
    schemaVersion: 2, revision: 0, repository: 'example/sky-bar', prNumber: 17, phase: 'recovering',
    baseSha: head, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: head,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [], verificationEscalation: null,
    threadResolutionStatus: {
      status: 'not-run', headSha: null, threads: [],
      threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
      updatedAt: null,
    },
    blockedReasons: [], validationStatus: { status: 'not-run', headSha: null, checks: [], updatedAt: null },
    nextAction: 'Recover exact context.', integrationWorktree: '/tmp/integration', orchestratorSessionId: null,
    abandonmentReason: null, git: { branch: 'main', headSha: head, dirty: false }, updatedAt: AT,
    ...overrides,
  };
}

function threadFixture(overrides = {}) {
  return {
    threadNodeId: 'PRRT_node', rootCommentNodeId: 'PRRC_root', rootCommentDatabaseId: 9,
    taskIds: ['task'], disposition: 'fixed', replyId: 'PRRC_reply',
    replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r9', isResolved: true,
    resolvedAt: AT, resolvedBy: 'maintainer', observedHeadSha: 'a'.repeat(40), ...overrides,
  };
}

function escalatedStateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  const request = {
    id: 'verification-request', databaseId: 101,
    url: 'https://github.com/example/sky-bar/pull/17#issuecomment-101', headSha: head, at: AT,
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

test('checked-in JSON contracts parse and declare Draft 2020-12', () => {
  const paths = [
    '.release/marker.schema.json',
    'docs/agents/pr-review-state.schema.json',
    'docs/agents/review-fix-task.schema.json',
    'docs/agents/review-fix-result.schema.json',
    '.codex/hooks.json',
  ];
  for (const path of paths) {
    const document = JSON.parse(readFileSync(join(root, path), 'utf8'));
    if (path.endsWith('.schema.json')) assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    if (path === 'docs/agents/pr-review-state.schema.json') {
      assert.equal(document.properties.schemaVersion.const, 2);
      assert.ok(document.required.includes('verificationReviewUsed'));
      assert.ok(document.required.includes('reviewOutcome'));
      assert.ok(document.required.includes('threadResolutionStatus'));
      assert.ok(document.properties.phase.enum.includes('awaiting-human-decision'));
    }
  }
});

test('state JSON Schema compiles with Ajv and shares representative fixtures with the manual validator', () => {
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/pr-review-state.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const valid = stateFixture();
  assert.equal(validateSchema(valid), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(valid), []);
  const validEscalation = escalatedStateFixture();
  assert.equal(validateSchema(validEscalation), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validEscalation), []);

  const { verificationEscalation: _verificationEscalation, ...noncanonicalPriorV2 } = valid;
  const invalidFixtures = [
    noncanonicalPriorV2,
    stateFixture({ repository: 'not-a-repository' }),
    stateFixture({ validationStatus: { status: 'passed', headSha: null, checks: [], updatedAt: null } }),
    escalatedStateFixture({ phase: 'recovering' }),
    escalatedStateFixture({
      verificationEscalation: {
        ...validEscalation.verificationEscalation, evidenceIds: [],
      },
    }),
    ...['stale-canonical-evidence', 'ambiguous-canonical-evidence'].map((reason) => escalatedStateFixture({
      verificationEscalation: {
        ...validEscalation.verificationEscalation, observedPrHeadSha: 'b'.repeat(40),
        headRelation: 'changed', reason,
      },
    })),
    escalatedStateFixture({
      reviewRequest: { ...validEscalation.reviewRequest, kind: 'discovery' },
      reviewHistory: [{ request: { ...validEscalation.reviewRequest, kind: 'discovery' }, outcome: null }],
    }),
    stateFixture({
      tasks: [{
        id: 'task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Queued.',
        severity: 'P1', disposition: 'actionable', status: 'queued', integratedCommitSha: null,
        resolutionSummary: null,
      }],
    }),
    stateFixture({
      tasks: [{
        id: 'task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Done.',
        severity: 'P1', disposition: 'actionable', status: 'completed', integratedCommitSha: null,
        resolutionSummary: 'Done.',
      }],
    }),
    stateFixture({
      tasks: [
        {
          id: 'duplicate', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint',
          summary: 'Done.', severity: 'P1', disposition: 'actionable', status: 'completed',
          integratedCommitSha: 'a'.repeat(40), resolutionSummary: 'Done.',
        },
        {
          id: 'duplicate', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint',
          summary: 'Done.', severity: 'P1', disposition: 'actionable', status: 'completed',
          integratedCommitSha: 'a'.repeat(40), resolutionSummary: 'Done.',
        },
      ],
    }),
    stateFixture({
      threadResolutionStatus: {
        status: 'failed', headSha: 'a'.repeat(40), threads: [
          threadFixture({ replyUrl: 'http://github.com/example/sky-bar/pull/17#discussion_r9' }),
        ],
        threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
        updatedAt: AT,
      },
    }),
    stateFixture({
      threadResolutionStatus: {
        status: 'failed', headSha: 'a'.repeat(40), threads: [
          threadFixture({ isResolved: false }),
        ],
        threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
        updatedAt: AT,
      },
    }),
    stateFixture({
      threadResolutionStatus: {
        status: 'failed', headSha: 'a'.repeat(40), threads: [
          threadFixture({ disposition: 'invalid', replyId: null, replyUrl: null }),
        ],
        threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
        updatedAt: AT,
      },
    }),
    stateFixture({
      threadResolutionStatus: {
        status: 'failed', headSha: 'a'.repeat(40), threads: [threadFixture(), threadFixture()],
        threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
        updatedAt: AT,
      },
    }),
  ];
  for (const fixture of invalidFixtures) {
    assert.equal(validateSchema(fixture), false, 'schema should reject shared invalid fixture');
    assert.notDeepEqual(validatePrReviewState(fixture), [], 'manual validator should reject shared invalid fixture');
  }
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
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/pr-review-state.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(validateSchema(state), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(state), []);
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
            replyId: 'PRRC_other_reply', replyUrl: 'https://github.com/example/sky-bar/pull/17#discussion_r10',
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

test('task packet validator accepts the documented contract', () => {
  const errors = validateTaskPacket({
    schemaVersion: 1,
    taskId: 'task-1',
    reviewedHeadSha: 'a'.repeat(40),
    finding: 'The mutation can overwrite newer state.',
    evidence: 'The route updates without checking the displayed version.',
    decisionIds: ['decision-1'],
    allowedPaths: ['apps/api/src/example.ts'],
    forbiddenPaths: ['apps/api/migrations/**'],
    dependencies: [],
    acceptanceCriteria: ['Reject stale versions.'],
    requiredValidation: ['npm test -w @sky-bar/api -- routes'],
  });
  assert.deepEqual(errors, []);
});

test('worker result validator rejects raw artifact fields', () => {
  const errors = validateWorkerResult({
    schemaVersion: 1,
    taskId: 'task-1',
    status: 'failed',
    commitSha: null,
    changedPaths: [],
    validation: [],
    resolutionSummary: 'The task failed.',
    residualRisks: [],
    unexpectedDependencies: [],
    rawLog: 'large output',
  });
  assert.ok(errors.some((error) => error.includes('rawLog')));
});

test('skill frontmatter has only name and description and no TODOs', () => {
  const skill = readFileSync(join(root, '.agents/skills/pr-review-cycle/SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  const keys = frontmatter.split('\n').map((line) => line.split(':', 1)[0]);
  assert.deepEqual(keys, ['name', 'description']);
  assert.doesNotMatch(skill, /TODO/u);
  assert.ok(skill.split('\n').length < 500);
});

test('custom agent required fields are declared at the TOML root', () => {
  const agentsDirectory = join(root, '.codex', 'agents');
  for (const fileName of readdirSync(agentsDirectory).filter((name) => name.endsWith('.toml'))) {
    const source = readFileSync(join(agentsDirectory, fileName), 'utf8');
    const firstTable = source.search(/^\s*\[/mu);
    const rootSource = firstTable === -1 ? source : source.slice(0, firstTable);
    for (const field of ['name', 'description', 'developer_instructions']) {
      assert.match(
        rootSource,
        new RegExp(`^${field}\\s*=`, 'mu'),
        `${fileName} must declare ${field} before its first TOML table`,
      );
    }
  }
});
