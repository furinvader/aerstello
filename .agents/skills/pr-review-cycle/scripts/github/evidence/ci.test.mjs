import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FULL_VALIDATION_CHECK,
  FULL_VALIDATION_WORKFLOW,
  FULL_VALIDATION_WORKFLOW_PATH,
  GITHUB_ACTIONS_APP,
  ciEvidenceFromRollup,
} from './ci.mjs';

const HEAD = 'a'.repeat(40);
const AT = '2026-08-05T00:00:00Z';

function fullValidationCheck(overrides = {}) {
  return {
    __typename: 'CheckRun', id: 'CHECK_full', databaseId: 301, name: FULL_VALIDATION_CHECK,
    status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: AT,
    detailsUrl: 'https://github.com/example/aerstello/actions/runs/701/job/301',
    checkSuite: {
      app: { slug: GITHUB_ACTIONS_APP },
      workflowRun: {
        databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
        file: { path: FULL_VALIDATION_WORKFLOW_PATH }, workflow: { name: FULL_VALIDATION_WORKFLOW },
      },
    },
    ...overrides,
  };
}

function snapshot(contexts) {
  return { headSha: HEAD, rollupState: 'SUCCESS', contexts };
}

function assertCode(input, code) {
  assert.throws(() => ciEvidenceFromRollup(input), { name: 'GitHubWorkflowError', code });
}

test('full CI classifier returns the exact authoritative passed evidence shape', () => {
  const unrelated = {
    __typename: 'StatusContext', id: 'STATUS_lint', context: 'lint', state: 'SUCCESS', targetUrl: null,
  };
  assert.deepEqual(ciEvidenceFromRollup(snapshot([unrelated, fullValidationCheck()])), {
    source: 'github-actions', scope: 'full', status: 'passed', headSha: HEAD,
    checks: ['Full validation'], checkRunId: 'CHECK_full', workflowRunId: 701,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/701', updatedAt: AT,
  });
});

test('full CI classifier selects the latest retry within one workflow run', () => {
  const evidence = ciEvidenceFromRollup(snapshot([
    fullValidationCheck({ id: 'CHECK_failed', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z' }),
    fullValidationCheck({ id: 'CHECK_passed', completedAt: '2026-08-05T00:01:00Z' }),
  ]));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.checkRunId, 'CHECK_passed');
  assert.equal(evidence.updatedAt, '2026-08-05T00:01:00Z');
});

test('full CI classifier prioritizes a failed authoritative run and orders representatives deterministically', () => {
  const failedRun = fullValidationCheck({
    id: 'CHECK_failed', conclusion: 'FAILURE', completedAt: '2026-08-04T23:59:00Z',
    checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
      databaseId: 700, url: 'https://github.com/example/aerstello/actions/runs/700',
      file: { path: FULL_VALIDATION_WORKFLOW_PATH }, workflow: { name: FULL_VALIDATION_WORKFLOW },
    } },
  });
  const evidence = ciEvidenceFromRollup(snapshot([fullValidationCheck(), failedRun]));
  assert.deepEqual(evidence, {
    source: 'github-actions', scope: 'full', status: 'failed', headSha: HEAD,
    checks: ['Full validation'], checkRunId: 'CHECK_failed', workflowRunId: 700,
    workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/700',
    updatedAt: '2026-08-04T23:59:00Z',
  });

  const laterFailure = fullValidationCheck({
    id: 'CHECK_failed_later', conclusion: 'FAILURE', completedAt: AT,
    checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
      databaseId: 702, url: 'https://github.com/example/aerstello/actions/runs/702',
      file: { path: FULL_VALIDATION_WORKFLOW_PATH }, workflow: { name: FULL_VALIDATION_WORKFLOW },
    } },
  });
  assert.equal(ciEvidenceFromRollup(snapshot([failedRun, laterFailure])).checkRunId, 'CHECK_failed_later');
});

test('full CI classifier rejects missing, foreign, pending, incomplete, and ambiguous authority', () => {
  assertCode(snapshot([]), 'CI_CHECK_MISSING');
  assertCode(snapshot([fullValidationCheck({ name: 'another check' })]), 'CI_CHECK_MISSING');
  assertCode(snapshot([fullValidationCheck({ checkSuite: { app: { slug: 'other' } } })]), 'CI_CHECK_MISSING');
  assertCode(snapshot([fullValidationCheck({ checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
    databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
    file: { path: '.github/workflows/other.yml' }, workflow: { name: FULL_VALIDATION_WORKFLOW },
  } } })]), 'CI_WORKFLOW_MISMATCH');
  assertCode(snapshot([fullValidationCheck({ checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
    databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/701',
  } } })]), 'CI_EVIDENCE_INCOMPLETE');
  assertCode(snapshot([fullValidationCheck({ id: null })]), 'CI_EVIDENCE_INCOMPLETE');
  assertCode(snapshot([fullValidationCheck({ status: 'IN_PROGRESS', conclusion: null, completedAt: null })]),
    'CI_VALIDATION_PENDING');
  assertCode(snapshot([fullValidationCheck({ completedAt: null })]), 'CI_EVIDENCE_INCOMPLETE');
  assertCode(snapshot([fullValidationCheck(), fullValidationCheck()]), 'CI_EVIDENCE_AMBIGUOUS');
  assertCode(snapshot([
    fullValidationCheck({ id: 'CHECK_one' }),
    fullValidationCheck({ id: 'CHECK_two' }),
  ]), 'CI_EVIDENCE_AMBIGUOUS');
});

test('full CI classifier rejects ambiguous run URLs and invalid authoritative URLs', () => {
  const otherUrl = fullValidationCheck({
    id: 'CHECK_other_url', completedAt: '2026-08-05T00:01:00Z',
    checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
      databaseId: 701, url: 'https://github.com/example/aerstello/actions/runs/other',
      file: { path: FULL_VALIDATION_WORKFLOW_PATH }, workflow: { name: FULL_VALIDATION_WORKFLOW },
    } },
  });
  assertCode(snapshot([fullValidationCheck(), otherUrl]), 'CI_EVIDENCE_AMBIGUOUS');
  for (const url of ['http://github.com/example/aerstello/actions/runs/701', 'https://user@example.test/run', 'not-a-url']) {
    assertCode(snapshot([fullValidationCheck({ checkSuite: { app: { slug: GITHUB_ACTIONS_APP }, workflowRun: {
      databaseId: 701, url,
      file: { path: FULL_VALIDATION_WORKFLOW_PATH }, workflow: { name: FULL_VALIDATION_WORKFLOW },
    } } })]), 'CI_EVIDENCE_INCOMPLETE');
  }
});
