import {
  assert, checkpointCiValidation, ciEvidence, init, outcome, ready, repo, request, statePath,
  test, writeFileSync,
} from '../test-support/state-harness.mjs';
import { checkpointReviewOutcome, checkpointReviewRequest } from './review.mjs';
import {
  assertCompletionAllowed, checkpointCompletion, gitAwareGateContext,
} from './completion.mjs';

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test('completion service owns exact-head context, gate errors, completion, and no-write retry', () => {
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
  const context = gitAwareGateContext(current, external);
  assert.equal(context.localHeadSha, current.currentIntegrationHeadSha);
  assert.equal(context.localDirty, false);
  throwsCode(() => assertCompletionAllowed(current, context), 'REVIEW_CYCLE_INCOMPLETE');

  current = checkpointReviewRequest({
    cwd, expectedRevision: current.revision, request: request(current), ...external,
  });
  current = checkpointReviewOutcome({
    cwd, expectedRevision: current.revision, outcome: outcome(current),
  });
  current = checkpointCiValidation({
    cwd, expectedRevision: current.revision, evidence: ciEvidence(current),
  });
  const completed = checkpointCompletion({
    cwd, expectedRevision: current.revision, ...external,
  });
  assert.equal(completed.phase, 'complete');
  const retry = checkpointCompletion({
    cwd, expectedRevision: completed.revision, ...external,
  });
  assert.deepEqual(retry, completed);
});
