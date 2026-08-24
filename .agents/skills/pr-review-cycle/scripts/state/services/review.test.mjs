import {
  assert, init, loadState, outcome, ready, repo, request, statePath, test, writeFileSync,
} from '../test-support/state-harness.mjs';
import {
  assertReviewRequestAllowed,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointReviewRequestLimit,
  checkpointVerificationEscalation,
} from './review.mjs';

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('review service owns request gates, limits, requests, outcomes, and exact retries', () => {
  const cwd = repo();
  const initial = init(cwd);
  let current = ready(initial, []);
  writeFileSync(statePath(cwd, current.prNumber), `${JSON.stringify(current)}\n`);
  const external = {
    pushedHeadSha: current.currentIntegrationHeadSha,
    prHeadSha: current.currentIntegrationHeadSha,
    prState: 'OPEN',
    isDraft: false,
  };
  assert.equal(assertReviewRequestAllowed(current, {
    ...external,
    localHeadSha: current.currentIntegrationHeadSha,
    localDirty: false,
    isAncestor: () => true,
  }), 'discovery');

  current = checkpointReviewRequestLimit({
    cwd, expectedRevision: current.revision, reviewRequestLimit: 4,
  });
  assert.equal(current.reviewRequestLimit, 4);
  const reviewRequest = request(current);
  const requested = checkpointReviewRequest({
    cwd, expectedRevision: current.revision, request: reviewRequest, ...external,
  });
  assert.equal(requested.phase, 'awaiting-review');
  assert.equal(requested.reviewHistory.length, 1);

  const exactRetry = checkpointReviewRequest({
    cwd, expectedRevision: -1, request: reviewRequest, ...external,
  });
  assert.deepEqual(exactRetry, requested, 'request retry retains outer early-return ordering');

  const reviewOutcome = outcome(requested);
  const collected = checkpointReviewOutcome({
    cwd, expectedRevision: requested.revision, outcome: reviewOutcome,
  });
  assert.equal(collected.phase, 'validating');
  const outcomeRetry = checkpointReviewOutcome({
    cwd, expectedRevision: collected.revision, outcome: reviewOutcome,
  });
  assert.deepEqual(outcomeRetry, collected);
  assert.equal(loadState(cwd).revision, collected.revision);

  throwsCode(() => checkpointVerificationEscalation({
    cwd,
    expectedRevision: collected.revision,
    escalation: { requestId: reviewRequest.id, requestHeadSha: reviewRequest.headSha },
  }), 'VERIFICATION_ESCALATION_NOT_EXPECTED');
});
