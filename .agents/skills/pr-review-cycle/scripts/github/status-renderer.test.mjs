import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderHumanStatus } from './status-renderer.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function statusFixture(overrides = {}) {
  return {
    prNumber: 2,
    pullRequest: { state: 'OPEN', isDraft: false },
    reviewObservation: { status: 'not-applicable' },
    stateHeadSha: HEAD,
    liveHeadSha: HEAD,
    statePhase: 'ready-for-review',
    codexReview: 'clean',
    reviewRequests: { used: 1, limit: null },
    taskStatus: {
      resolved: 1,
      pending: 1,
      items: [
        { id: 'fixed', status: 'Resolved', summary: 'Preserve exact evidence.' },
        { id: 'pending', status: 'Integrated', summary: 'Await thread resolution.' },
      ],
    },
    targetedValidation: { status: 'passed', checks: ['npm run check:workflow'] },
    specialistReviews: {
      status: 'pending',
      requiredReviewerIds: ['security_reviewer'],
    },
    liveCiValidation: {
      status: 'passed',
      checks: ['Full validation'],
      workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/1',
    },
    openCodexThreads: 1,
    nextAction: 'Resolve the remaining thread.',
    ...overrides,
  };
}

test('renders the exact current-head human status bytes without a trailing newline', () => {
  assert.equal(renderHumanStatus(statusFixture()), [
    'PR: #2',
    'PR readiness: OPEN',
    'Live review observation: Not Applicable',
    `Current commit: ${HEAD} (matches PR head)`,
    'Phase: Ready For Review',
    'Codex review: Clean',
    'Review requests: 1; limit: unlimited',
    'Tasks: 1 Resolved, 1 pending',
    '  - fixed: Resolved — Preserve exact evidence.',
    '  - pending: Integrated — Await thread resolution.',
    'Targeted local tests: Passed (npm run check:workflow)',
    'Specialist reviews: Pending (required: security_reviewer)',
    'Full CI: Passed (Full validation) — https://github.com/example/aerstello/actions/runs/1',
    'Open Codex threads: 1',
    'Next action: Resolve the remaining thread.',
  ].join('\n'));
});

test('renders stale Done evidence and failed or missing details byte-for-byte', () => {
  assert.equal(renderHumanStatus(statusFixture({
    pullRequest: { state: 'OPEN', isDraft: true },
    reviewObservation: { status: 'stale' },
    liveHeadSha: OTHER_HEAD,
    statePhase: 'complete',
    codexReview: 'clean',
    reviewRequests: { used: 3, limit: 5 },
    taskStatus: {
      resolved: 1,
      pending: 0,
      items: [{ id: 'fixed', status: 'Done', summary: 'Preserve exact evidence.' }],
    },
    targetedValidation: { status: 'passed', checks: ['npm run check:workflow'] },
    specialistReviews: undefined,
    liveCiValidation: {
      status: 'failed',
      workflowRunUrl: 'https://github.com/example/aerstello/actions/runs/2',
    },
    openCodexThreads: 0,
    nextAction: 'Archive the completed cycle.',
  })), [
    'PR: #2',
    'PR readiness: OPEN draft',
    'Live review observation: Stale',
    `Current commit: ${HEAD} (DOES NOT MATCH PR head ${OTHER_HEAD})`,
    'Phase: Stale (recorded Done; PR head changed)',
    'Codex review: Stale clean evidence (commit mismatch)',
    'Review requests: 3; limit: 5',
    'Tasks: 1 Resolved, 0 pending',
    '  - fixed: Resolved (stale head) — Preserve exact evidence.',
    'Targeted local tests: Passed (npm run check:workflow) for the recorded commit; PR head differs',
    'Specialist reviews: Missing',
    'Full CI: Failed — https://github.com/example/aerstello/actions/runs/2',
    'Open Codex threads: 0',
    `Next action: Reconcile recorded commit with live PR head ${OTHER_HEAD}. Recorded next action: Archive the completed cycle.`,
  ].join('\n'));
});

test('keeps unknown optional statuses deterministic', () => {
  const output = renderHumanStatus(statusFixture({
    pullRequest: null,
    reviewObservation: null,
    codexReview: 'not-requested',
    targetedValidation: null,
    specialistReviews: null,
    liveCiValidation: null,
  }));
  assert.match(output, /PR readiness: unknown/u);
  assert.match(output, /Live review observation: Unknown/u);
  assert.match(output, /Targeted local tests: Unknown/u);
  assert.match(output, /Specialist reviews: Missing/u);
  assert.match(output, /Full CI: Unknown/u);
});
