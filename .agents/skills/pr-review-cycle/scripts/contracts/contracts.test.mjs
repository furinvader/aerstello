import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import * as contractsFacade from './contracts.mjs';
import { validatePrReviewState } from './contracts.mjs';
import {
  prReviewStateSchemaPath,
  repositoryDirectory,
  reviewFixResultSchemaPath,
  reviewFixTaskSchemaPath,
} from '../paths.mjs';
import { loadRegistry } from '../../../aerstello-specialists/scripts/validate-registry.mjs';

const root = repositoryDirectory();
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

test('checked-in JSON contracts parse and declare Draft 2020-12', () => {
  const registry = loadRegistry();
  const paths = [
    join(root, '.release/marker.schema.json'),
    prReviewStateSchemaPath,
    reviewFixTaskSchemaPath,
    reviewFixResultSchemaPath,
    join(root, '.codex/hooks.json'),
  ];
  for (const path of paths) {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (path.endsWith('.schema.json')) assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema');
    if (path === prReviewStateSchemaPath) {
      assert.equal(document.properties.schemaVersion.const, 3);
      assert.ok(document.required.includes('verificationReviewUsed'));
      assert.ok(document.required.includes('reviewOutcome'));
      assert.ok(document.required.includes('threadResolutionStatus'));
      assert.ok(document.properties.phase.enum.includes('awaiting-human-decision'));
      assert.ok(document.$defs.threadResolutionStatus.properties.localVerification);
      assert.equal(document.$defs.threadResolutionStatus.required.includes('localVerification'), false);
      assert.equal(document.required.includes('staleDiscoveryDispositions'), false);
      assert.equal(document.properties.staleDiscoveryDispositions.maxItems, 3);
      assert.equal(document.$defs.staleDiscoveryDisposition.properties.evidence
        .allOf[1].properties.kind.const, 'discovery');
      assert.ok(document.$defs.staleDiscoveryDisposition.required.includes('responseFingerprint'));
    }
    if (path === reviewFixTaskSchemaPath || path === reviewFixResultSchemaPath) {
      assert.equal(document.properties.schemaVersion.const, 3);
      assert.ok(document.required.includes('specialization'));
      assert.deepEqual(document.properties.specialization.enum, registry.profiles.map(({ id }) => id));
    }
    if (path === reviewFixTaskSchemaPath) {
      assert.ok(document.required.includes('riskTags'));
      assert.deepEqual(document.properties.riskTags.items.enum, registry.riskTags);
    }
  }
});

test('state JSON Schema compiles with Ajv and shares representative fixtures with the manual validator', () => {
  const schema = JSON.parse(readFileSync(prReviewStateSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const valid = stateFixture();
  assert.equal(validateSchema(valid), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(valid), []);
  const validEscalation = escalatedStateFixture();
  assert.equal(validateSchema(validEscalation), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validEscalation), []);
  const validUnboundTask = stateFixture({
    tasks: [{
      id: 'legacy-task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Done.',
      severity: 'P1', disposition: 'actionable', status: 'completed', integratedCommitSha: 'a'.repeat(40),
      resolutionSummary: 'Done.',
    }],
  });
  assert.equal(validateSchema(validUnboundTask), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validUnboundTask), []);
  const validBoundTask = stateFixture({
    tasks: [{
      id: 'task', sourceIds: ['local'], sourceType: 'local', fingerprint: 'fingerprint', summary: 'Done.',
      severity: 'P1', disposition: 'actionable', status: 'completed', integratedCommitSha: 'a'.repeat(40),
      resolutionSummary: 'Done.', taskPacketDigest: 'b'.repeat(64),
    }],
  });
  assert.equal(validateSchema(validBoundTask), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validBoundTask), []);

  const { verificationEscalation: _verificationEscalation, ...noncanonicalPriorV2 } = valid;
  const invalidFixtures = [
    noncanonicalPriorV2,
    stateFixture({ repository: 'not-a-repository' }),
    stateFixture({
      validationStatus: {
        source: 'orchestrator', scope: 'targeted', status: 'passed', headSha: null, checks: [], updatedAt: null,
      },
    }),
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
        severity: 'P1', disposition: 'actionable', status: 'completed', integratedCommitSha: 'a'.repeat(40),
        resolutionSummary: 'Done.', taskPacketDigest: 'not-a-digest',
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
          threadFixture({ replyUrl: 'http://github.com/example/aerstello/pull/17#discussion_r9' }),
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


const SUPPORTED_FUNCTION_EXPORTS = [
  'buildStaleDiscoveryDisposition',
  'completionGate',
  'parseTargetedValidationCommand',
  'reviewRequestGate',
  'reviewRequestUsage',
  'staleDiscoveryDispositionId',
  'taskHasCanonicalThreadCoverage',
  'unionInitialValidationSelection',
  'unionRequiredValidation',
  'validateInitialValidationSelection',
  'validatePrReviewState',
  'validatePrReviewStateV1',
  'validateTaskPacket',
  'validateWorkerResult',
  'validateWorkerResultAgainstTask',
  'workerResultDigest',
];

test('contracts façade retains the importer-backed function subset', () => {
  for (const exportName of SUPPORTED_FUNCTION_EXPORTS) {
    assert.equal(typeof contractsFacade[exportName], 'function', `${exportName} must remain a function`);
  }
});
