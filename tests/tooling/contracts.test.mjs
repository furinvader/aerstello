import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  parseTargetedValidationCommand,
  validateInitialValidationSelection,
  validatePrReviewState,
  validateTaskPacket,
  validateWorkerResultAgainstTask,
  validateWorkerResult,
  unionRequiredValidation,
} from '../../scripts/lib/contracts.mjs';
import {
  checkpointState,
  checkpointTaskPacketBinding,
  initializeState,
} from '../../scripts/lib/pr-review-state.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const AT = '2026-08-05T00:00:00Z';
const AUTHORIZED_AT = '2026-08-09T21:30:00Z';
const NOT_BEFORE = '2026-08-10T13:00:00Z';

function stateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  return {
    schemaVersion: 5, revision: 0, repository: 'example/aerstello', prNumber: 17, phase: 'recovering',
    baseSha: head, requestedHeadSha: null, reviewedHeadSha: null, currentIntegrationHeadSha: head,
    reviewRound: 0, verificationReviewUsed: false, legacyReviewProvenance: null, releaseBaseline: null,
    decisions: [], tasks: [], reviewRequest: null, reviewOutcome: null, reviewHistory: [], verificationEscalation: null,
    humanFinalReviewAuthorization: null, postFinalRemediationAuthorization: null,
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

function humanFinalStateFixture(overrides = {}) {
  const head = 'a'.repeat(40);
  const history = Array.from({ length: 4 }, (_, index) => {
    const kind = index === 3 ? 'verification' : 'discovery';
    const request = {
      id: `request-${index + 1}`, databaseId: 101 + index,
      url: `https://github.com/example/aerstello/pull/17#issuecomment-${101 + index}`,
      headSha: head, at: AT, kind, body: '@codex review',
      authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
    };
    const outcome = {
      id: `outcome-${index + 1}`, databaseId: 201 + index,
      url: `https://github.com/example/aerstello/pull/17#pullrequestreview-${201 + index}`,
      headSha: head, at: AT, requestId: request.id, kind,
      outcome: index === 3 ? 'findings' : 'clean', evidenceType: 'review-submission',
      reviewerLogin: 'chatgpt-codex-connector', reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
      reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector', reactionContent: null,
      reactionCommentId: null,
    };
    return { request, outcome };
  });
  const latest = history.at(-1);
  return readyStateFixture({
    phase: 'awaiting-human-decision', requestedHeadSha: head, reviewedHeadSha: head,
    reviewRound: 3, verificationReviewUsed: true,
    decisions: [{ id: 'decision-final', summary: 'Authorize one final human review.' }],
    reviewRequest: latest.request, reviewOutcome: latest.outcome, reviewHistory: history,
    humanFinalReviewAuthorization: {
      decisionId: 'decision-final', source: 'operator-instruction', authorizedAt: AUTHORIZED_AT,
      verificationOutcomeId: latest.outcome.id, notBefore: NOT_BEFORE,
      summary: 'One operator-authorized human-final review.',
    },
    nextAction: 'Request human-final review at the trusted time.',
    ...overrides,
  });
}

function postFinalRemediationStateFixture(overrides = {}) {
  const authorized = humanFinalStateFixture();
  const head = authorized.currentIntegrationHeadSha;
  const request = {
    id: 'request-5', databaseId: 105,
    url: 'https://github.com/example/aerstello/pull/17#issuecomment-105',
    headSha: head, at: NOT_BEFORE, kind: 'human-final', body: '@codex review',
    authorLogin: 'maintainer', authorNodeId: 'USER_maintainer',
  };
  const outcome = {
    id: 'outcome-5', databaseId: 205,
    url: 'https://github.com/example/aerstello/pull/17#pullrequestreview-205',
    headSha: head, at: '2026-08-10T13:05:00Z', requestId: request.id,
    kind: 'human-final', outcome: 'findings', evidenceType: 'review-submission',
    reviewerLogin: 'chatgpt-codex-connector', reviewerNodeId: 'BOT_codex', reviewerType: 'Bot',
    reviewerUrl: 'https://github.com/apps/chatgpt-codex-connector', reactionContent: null,
    reactionCommentId: null,
  };
  return {
    ...authorized,
    decisions: [
      ...authorized.decisions,
      { id: 'decision-post-final', summary: 'Authorize remediation-only final work.' },
    ],
    reviewRequest: request,
    reviewOutcome: outcome,
    reviewHistory: [...authorized.reviewHistory, { request, outcome }],
    postFinalRemediationAuthorization: {
      decisionId: 'decision-post-final', source: 'operator-instruction',
      authorizedAt: '2026-08-10T13:06:00Z', humanFinalOutcomeId: outcome.id,
      summary: 'Remediate the final findings without requesting another review.',
    },
    nextAction: 'Perform remediation-only validation without another review request.',
    ...overrides,
  };
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
      assert.equal(document.properties.schemaVersion.const, 5);
      assert.ok(document.required.includes('verificationReviewUsed'));
      assert.ok(document.required.includes('reviewOutcome'));
      assert.ok(document.required.includes('humanFinalReviewAuthorization'));
      assert.ok(document.required.includes('postFinalRemediationAuthorization'));
      assert.ok(document.required.includes('threadResolutionStatus'));
      assert.ok(document.properties.phase.enum.includes('awaiting-human-decision'));
      assert.ok(document.$defs.threadResolutionStatus.properties.localVerification);
      assert.equal(document.$defs.threadResolutionStatus.required.includes('localVerification'), false);
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
  const validHumanFinal = humanFinalStateFixture();
  assert.equal(validateSchema(validHumanFinal), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validHumanFinal), []);
  const validPostFinal = postFinalRemediationStateFixture();
  assert.equal(validateSchema(validPostFinal), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validatePrReviewState(validPostFinal), []);
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

  const {
    verificationEscalation: _verificationEscalation,
    humanFinalReviewAuthorization: _humanFinalReviewAuthorization,
    postFinalRemediationAuthorization: _postFinalRemediationAuthorization,
    ...noncanonicalPriorV2
  } = valid;
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
  for (const fixture of [
    humanFinalStateFixture({
      humanFinalReviewAuthorization: {
        ...validHumanFinal.humanFinalReviewAuthorization, decisionId: 'missing-decision',
      },
    }),
    humanFinalStateFixture({
      humanFinalReviewAuthorization: {
        ...validHumanFinal.humanFinalReviewAuthorization, verificationOutcomeId: 'missing-outcome',
      },
    }),
  ]) {
    assert.notDeepEqual(validatePrReviewState(fixture), [], 'manual cross-reference validation should reject fixture');
  }
  for (const fixture of [
    postFinalRemediationStateFixture({
      postFinalRemediationAuthorization: {
        ...validPostFinal.postFinalRemediationAuthorization,
        decisionId: 'missing-decision',
      },
    }),
    postFinalRemediationStateFixture({
      postFinalRemediationAuthorization: {
        ...validPostFinal.postFinalRemediationAuthorization,
        humanFinalOutcomeId: 'missing-outcome',
      },
    }),
    postFinalRemediationStateFixture({
      postFinalRemediationAuthorization: {
        ...validPostFinal.postFinalRemediationAuthorization,
        authorizedAt: '2026-08-10T13:04:59Z',
      },
    }),
  ]) {
    assert.notDeepEqual(validatePrReviewState(fixture), [], 'manual post-final binding validation should reject fixture');
  }
  const unknownPostFinalField = postFinalRemediationStateFixture({
    postFinalRemediationAuthorization: {
      ...validPostFinal.postFinalRemediationAuthorization,
      notBefore: NOT_BEFORE,
    },
  });
  assert.equal(validateSchema(unknownPostFinalField), false);
  assert.notDeepEqual(validatePrReviewState(unknownPostFinalField), []);
});

test('local verifier proof is backward-readable, source-bound, and mandatory for completed local readiness', () => {
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/pr-review-state.schema.json'), 'utf8'));
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
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/pr-review-state.schema.json'), 'utf8'));
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
    readyStateFixture({ reviewRound: 3, verificationReviewUsed: true }),
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

test('initial validation selections require an exact head and nonempty targeted union', () => {
  const selection = {
    schemaVersion: 1,
    headSha: 'a'.repeat(40),
    affectedAreas: ['workflow'],
    requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Initial workflow scope.' }],
      system: [],
    },
  };
  assert.deepEqual(validateInitialValidationSelection(selection), []);
  for (const invalid of [
    { ...selection, headSha: 'bad' },
    { ...selection, affectedAreas: [] },
    { ...selection, requiredValidation: { unit: [], system: [] } },
    { ...selection, extra: true },
  ]) assert.notDeepEqual(validateInitialValidationSelection(invalid), []);
});

test('task packet validator accepts the documented contract', () => {
  const packet = {
    schemaVersion: 2,
    taskId: 'task-1',
    reviewedHeadSha: 'a'.repeat(40),
    finding: 'The mutation can overwrite newer state.',
    evidence: 'The route updates without checking the displayed version.',
    affectedAreas: ['api'],
    decisionIds: ['decision-1'],
    allowedPaths: ['apps/api/src/example.ts'],
    forbiddenPaths: ['apps/api/migrations/**'],
    dependencies: [],
    acceptanceCriteria: ['Reject stale versions.'],
    requiredValidation: {
      unit: [{ command: 'npm test -w @aerstello/api -- routes', reason: 'Covers stale route versions.' }],
      system: [{
        command: 'npm run test:e2e:related -- --id id-an-approved-request-token-grants-exactly-one-device --project tablet-chromium',
        reason: 'Covers the visible stale-version flow.',
        selectors: ['id-an-approved-request-token-grants-exactly-one-device'], projects: ['tablet-chromium'],
      }],
    },
  };
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/review-fix-task.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const errors = validateTaskPacket(packet);
  assert.deepEqual(errors, []);
  assert.equal(validateSchema(packet), true, JSON.stringify(validateSchema.errors));
  assert.ok(validateTaskPacket({
    ...packet,
    requiredValidation: {
      ...packet.requiredValidation,
      system: [{ ...packet.requiredValidation.system[0], projects: [] }],
    },
  }).some((error) => error.includes('both be empty or both be nonempty')));
});

test('task packets reject unsafe ownership and inexact or broad system validation scopes', () => {
  const packet = {
    schemaVersion: 2, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40), finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: ['scripts/private/**'],
    dependencies: [], acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [], system: [{
        command: 'npm run check:workflow', reason: 'Focused workflow check.', selectors: [], projects: [],
      }],
    },
  };
  assert.deepEqual(validateTaskPacket(packet), []);
  for (const command of ['npm run check', 'npm run check:full', 'npm run test:e2e', 'npm run test:e2e:full']) {
    assert.ok(validateTaskPacket({
      ...packet, requiredValidation: { unit: [], system: [{ command, reason: 'Too broad.', selectors: [], projects: [] }] },
    }).some((error) => error.includes('allowed direct targeted command')), command);
  }

  for (const command of [
    'env CI=1 npm run check:workflow',
    'npm --silent run check:workflow',
    'bash -lc npm run check:workflow',
    'npm run check:workflow && npm run check:api',
    'npm run check:workflow > result.txt',
    'npm run check:workflow $(touch unsafe)',
    'node --test #',
    'node --test ~',
    'node --test tests/tooling',
    'npm test -w @aerstello/api -- #',
    'npm test -w @aerstello/api -- routes\t--watch',
    'npm test -w @aerstello/api -w @aerstello/web -- routes',
  ]) {
    assert.equal(parseTargetedValidationCommand(command), null, command);
    assert.ok(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Bypass attempt.' }], system: [] },
    }).some((error) => error.includes('allowed direct targeted command')), command);
  }
  for (const affectedAreas of [['other'], ['documentation', 'ap1']]) {
    const invalid = { ...packet, affectedAreas };
    assert.ok(validateTaskPacket(invalid).some(
      (error) => error.includes('only recognized code or policy areas'),
    ));
    const schema = JSON.parse(readFileSync(join(root, 'docs/agents/review-fix-task.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    assert.equal(ajv.compile(schema)(invalid), false);
  }
  for (const command of [
    'npm test -w @aerstello/api -- routes',
    'npm run test --workspace=@aerstello/web -- tests/example.test.ts',
    'node --test tests/tooling/contracts.test.mjs',
  ]) {
    assert.deepEqual(parseTargetedValidationCommand(command), command.split(' '), command);
    assert.deepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Focused test.' }], system: [] },
    }), [], command);
  }
  for (const command of ['npm run check:full', 'npm run test:e2e:related -- --tag area-security']) {
    if (command === 'npm run check:full') assert.equal(parseTargetedValidationCommand(command), null);
    assert.notDeepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [{ command, reason: 'Wrong local scope.' }], system: [] },
    }), [], command);
  }
  for (const allowedPaths of [['../scripts/**'], ['/scripts/**'], ['scripts/*/file.mjs']]) {
    assert.ok(validateTaskPacket({ ...packet, allowedPaths }).some((error) => error.includes('safe repository-relative')));
  }

  const command = 'npm run test:e2e:related -- --tag area-security --project mobile-webkit';
  const e2e = { command, reason: 'Focused security flow.', selectors: ['area-security'], projects: ['mobile-webkit'] };
  assert.deepEqual(validateTaskPacket({
    ...packet, requiredValidation: { unit: [], system: [e2e] },
  }), []);
  for (const entry of [
    { ...e2e, selectors: [] },
    { ...e2e, selectors: ['area-auth'] },
    { ...e2e, selectors: ['area-does-not-exist'] },
    { ...e2e, projects: ['tablet-chromium'] },
    { ...e2e, projects: ['chromium'] },
    { ...e2e, command: 'npm run test:e2e:related -- --project mobile-webkit' },
  ]) {
    assert.notDeepEqual(validateTaskPacket({
      ...packet, requiredValidation: { unit: [], system: [entry] },
    }), []);
  }
});

test('worker result validator rejects raw artifact fields', () => {
  const result = {
    schemaVersion: 2,
    taskId: 'task-1',
    status: 'failed',
    commitSha: null,
    changedPaths: [],
    validation: [],
    resolutionSummary: 'The task failed.',
    residualRisks: [],
    unexpectedDependencies: [],
    rawLog: 'large output',
  };
  const errors = validateWorkerResult(result);
  assert.ok(errors.some((error) => error.includes('rawLog')));
  const schema = JSON.parse(readFileSync(join(root, 'docs/agents/review-fix-result.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  assert.equal(validateSchema(result), false);
});

test('worker result enforces exact commands and status-aware validation outcomes', () => {
  const packet = {
    schemaVersion: 2, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40), finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers workflow tooling.' }], system: [],
    },
  };
  const result = {
    schemaVersion: 2, taskId: 'task-1', status: 'implemented', commitSha: 'b'.repeat(40), changedPaths: ['scripts/a.mjs'],
    validation: [{ command: 'npm run check:workflow', result: 'passed', summary: 'Passed.' }],
    resolutionSummary: 'Implemented.', residualRisks: [], unexpectedDependencies: [],
  };
  assert.deepEqual(validateWorkerResultAgainstTask(packet, result, ['scripts/a.mjs']), []);
  assert.ok(validateWorkerResultAgainstTask(packet, result).some(
    (error) => error.includes('requires actual Git changed paths'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, result, []).some(
    (error) => error.includes('at least one changed path'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, result, ['scripts/other.mjs']).some(
    (error) => error.includes('exactly equal'),
  ));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, changedPaths: ['scripts/a.mjs', 'scripts/a.mjs'],
  }, ['scripts/a.mjs']).some((error) => error.includes('must not contain duplicates')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result,
    validation: [...result.validation, { command: 'npm run check:full', result: 'passed', summary: 'Too broad.' }],
  }, ['scripts/a.mjs']).some((error) => error.includes('undeclared command')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, validation: [{ ...result.validation[0], result: 'skipped' }],
  }, ['scripts/a.mjs']).some((error) => error.includes('did not pass')));
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, validation: [],
  }, ['scripts/a.mjs']).some((error) => error.includes('was not reported')));
  for (const status of ['blocked', 'failed', 'not-applicable']) {
    for (const outcome of ['passed', 'failed', 'skipped']) {
      const terminalResult = {
        ...result,
        status,
        commitSha: null,
        changedPaths: [],
        validation: [{ ...result.validation[0], result: outcome }],
      };
      assert.deepEqual(validateWorkerResultAgainstTask(packet, terminalResult), []);
    }
    assert.ok(validateWorkerResultAgainstTask(packet, {
      ...result, status, commitSha: null, changedPaths: [], validation: [],
    }).some((error) => error.includes('was not reported')));
  }
  assert.ok(validateWorkerResultAgainstTask(packet, {
    ...result, changedPaths: ['apps/api/src/outside.ts'],
  }, ['apps/api/src/outside.ts']).some((error) => error.includes('outside allowedPaths')));
  assert.ok(validateWorkerResultAgainstTask({
    ...packet, forbiddenPaths: ['scripts/private/**'],
  }, {
    ...result, changedPaths: ['scripts/private/a.mjs'],
  }, ['scripts/private/a.mjs']).some((error) => error.includes('is forbidden')));
  assert.ok(validateWorkerResult({ ...result, changedPaths: ['../scripts/a.mjs'] }).some(
    (error) => error.includes('safe repository-relative'),
  ));
});

test('validate-result CLI enforces the exact task validation commands', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aerstello-result-contract-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: directory }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Test'], { cwd: directory }).status, 0);
    mkdirSync(join(directory, 'scripts'));
    writeFileSync(join(directory, 'scripts/a.mjs'), 'export const value = 1;\n');
    assert.equal(spawnSync('git', ['add', 'scripts/a.mjs'], { cwd: directory }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'base'], { cwd: directory }).status, 0);
    const reviewedHeadSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).stdout.trim();
    const packet = {
      schemaVersion: 2, taskId: 'task-1', reviewedHeadSha, finding: 'Finding.', evidence: 'Evidence.',
      affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
      acceptanceCriteria: ['Validated.'], requiredValidation: {
        unit: [{ command: 'npm run check:workflow', reason: 'Covers workflow tooling.' }], system: [],
      },
    };
    let state = initializeState({
      cwd: directory, prNumber: 17, repository: 'example/aerstello', base: 'HEAD', head: 'HEAD', releaseRef: 'HEAD',
    });
    state = checkpointState({
      cwd: directory,
      expectedRevision: state.revision,
      nextState: {
        ...state,
        tasks: [{
          id: 'task-1', sourceIds: ['local:fixture'], sourceType: 'local', fingerprint: 'fixture-fingerprint',
          summary: 'Exercise exact validation commands.', severity: 'P2', disposition: 'actionable', status: 'proposed',
          integratedCommitSha: null, resolutionSummary: null,
          execution: {
            dependencies: [], ownedPaths: ['scripts/a.mjs'], worker: 'review_fix_worker', branch: null,
            worktree: null, workerCommitSha: null, validationSummaries: [], lastError: null,
          },
        }],
      },
    });
    checkpointTaskPacketBinding({ cwd: directory, packet, expectedRevision: state.revision });
    writeFileSync(join(directory, 'scripts/a.mjs'), 'export const value = 2;\n');
    assert.equal(spawnSync('git', ['add', 'scripts/a.mjs'], { cwd: directory }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'worker'], { cwd: directory }).status, 0);
    const commitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).stdout.trim();
    const result = {
      schemaVersion: 2, taskId: 'task-1', status: 'implemented', commitSha, changedPaths: ['scripts/a.mjs'],
      validation: [{ command: 'npm run check:full', result: 'passed', summary: 'Broad command.' }],
      resolutionSummary: 'Implemented.', residualRisks: [], unexpectedDependencies: [],
    };
    const packetPath = join(directory, 'packet.json');
    const resultPath = join(directory, 'result.json');
    writeFileSync(packetPath, JSON.stringify(packet));
    writeFileSync(resultPath, JSON.stringify(result));
    const cli = spawnSync(process.execPath, [
      join(root, 'scripts/pr-review-state.mjs'), 'validate-result',
      '--task-packet', packetPath, '--worker-result', resultPath,
    ], { cwd: directory, encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /undeclared command/u);
    assert.match(cli.stderr, /required validation was not reported/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('required validation union is deterministic and de-duplicates repeated commands', () => {
  const base = {
    schemaVersion: 2, taskId: 'task-1', reviewedHeadSha: 'a'.repeat(40), finding: 'Finding.', evidence: 'Evidence.',
    affectedAreas: ['workflow'], decisionIds: [], allowedPaths: ['scripts/**'], forbiddenPaths: [], dependencies: [],
    acceptanceCriteria: ['Validated.'], requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Covers tooling.' }], system: [],
    },
  };
  assert.deepEqual(unionRequiredValidation([base, { ...base, taskId: 'task-2' }]), base.requiredValidation);
  assert.deepEqual(unionRequiredValidation([
    base,
    { ...base, taskId: 'task-2', requiredValidation: {
      unit: [{ command: 'npm run check:workflow', reason: 'Different reason.' }], system: [],
    } },
  ]), base.requiredValidation);
  assert.throws(() => unionRequiredValidation([
    base,
    { ...base, taskId: 'task-2', requiredValidation: {
      unit: [], system: [{ command: 'npm run check:workflow', reason: 'Wrong scope.', selectors: [], projects: [] }],
    } },
  ]), /Conflicting validation scope/u);

  const areaOnly = {
    ...base,
    affectedAreas: ['shared', 'migration', 'documentation'],
    requiredValidation: {
      unit: [{ command: 'node --test tests/tooling/contracts.test.mjs', reason: 'Focused contract tests.' }],
      system: [],
    },
  };
  assert.deepEqual(unionRequiredValidation([areaOnly]), {
    unit: [
      areaOnly.requiredValidation.unit[0],
      { command: 'npm run check:shared', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:api', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:web', reason: 'Orchestrator integrated check for affected area: shared.' },
      { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: migration.' },
      { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: migration.' },
    ],
    system: [],
  });
  assert.deepEqual(unionRequiredValidation([{ ...areaOnly, affectedAreas: ['release'] }]).unit.slice(-2), [
    { command: 'npm run check:release-state', reason: 'Orchestrator integrated check for affected area: release.' },
    { command: 'npm run check:released-migrations', reason: 'Orchestrator integrated check for affected area: release.' },
  ]);
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
