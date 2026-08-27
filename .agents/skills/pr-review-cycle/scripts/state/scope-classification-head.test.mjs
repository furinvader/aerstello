import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveScopeClassificationHead } from './scope-classification-head.mjs';

const REVIEW_HEAD = '1'.repeat(40);
const INTEGRATION_HEAD = '2'.repeat(40);

test('integrated-head classifications bind the current integration HEAD', () => {
  assert.equal(resolveScopeClassificationHead({
    phase: 'integrated-head',
    reviewedHeadSha: REVIEW_HEAD,
    currentIntegrationHeadSha: INTEGRATION_HEAD,
  }), INTEGRATION_HEAD);
});

test('task and review-finding classifications retain Review-commit identity', () => {
  for (const phase of ['task', 'review-finding']) {
    assert.equal(resolveScopeClassificationHead({
      phase,
      reviewedHeadSha: REVIEW_HEAD,
      currentIntegrationHeadSha: INTEGRATION_HEAD,
    }), REVIEW_HEAD);
    assert.equal(resolveScopeClassificationHead({
      phase,
      reviewedHeadSha: null,
      currentIntegrationHeadSha: INTEGRATION_HEAD,
    }), INTEGRATION_HEAD);
  }
});

test('classification HEAD resolution rejects unsupported assessment phases', () => {
  for (const phase of [undefined, null, '', 'source-draft', 'plan', 'unknown']) {
    assert.throws(() => resolveScopeClassificationHead({
      phase,
      reviewedHeadSha: REVIEW_HEAD,
      currentIntegrationHeadSha: INTEGRATION_HEAD,
    }), {
      name: 'TypeError',
      message: `Unsupported scope classification phase: ${String(phase)}`,
    });
  }
});
