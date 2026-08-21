import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findRawFields,
  isDateTime,
  isHttpsUrl,
  isObject,
  isSha,
  isString,
  parseRepositoryPath,
  pathMatchesOwnership,
  rejectUnknownFields,
  requireFields,
  validateStringList,
  validateValidationEntry,
} from './primitives.mjs';
import {
  canonicalContractJson,
  sha256CanonicalContractJson,
  staleDiscoveryDispositionId,
  validatedWorkerResultDigest,
} from './contract-identities.mjs';

test('generic validation primitives preserve shape, bounds, and exact errors', () => {
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), false);
  assert.equal(isString('ab', { min: 2, max: 2 }), true);
  assert.equal(isSha('a'.repeat(40)), true);
  assert.equal(isSha(null, true), true);
  assert.equal(isDateTime('2026-08-21T09:10:11Z'), true);
  assert.equal(isHttpsUrl('https://example.com/path'), true);
  assert.equal(isHttpsUrl('https://user@example.com/path'), false);

  const errors = [];
  assert.equal(requireFields({ present: true }, ['present', 'missing'], '$', errors), true);
  rejectUnknownFields({ present: true, extra: true }, ['present'], '$', errors);
  validateStringList(['same', 'same'], '$.items', errors);
  validateValidationEntry({ command: '', result: 'unknown', summary: '' }, '$.validation[0]', errors);
  assert.deepEqual(errors, [
    '$.missing is required',
    '$.extra is not supported',
    '$.items contains duplicates',
    '$.validation[0].command must be 1-500 characters',
    '$.validation[0].result is invalid',
    '$.validation[0].summary must be 1-1000 characters',
  ]);
  assert.deepEqual(findRawFields({ nested: [{ rawOutput: 'bytes' }], stacktrace: 'trace' }), [
    '$.nested[0].rawOutput is not allowed in active state',
    '$.stacktrace is not allowed in active state',
  ]);
});

test('repository paths and ownership preserve exact safe path semantics', () => {
  assert.deepEqual(parseRepositoryPath('scripts/review.mjs'), { path: 'scripts/review.mjs', recursive: false });
  assert.deepEqual(parseRepositoryPath('scripts/**', { allowOwnershipPattern: true }), {
    path: 'scripts', recursive: true,
  });
  for (const path of ['/scripts/a.mjs', 'scripts/', 'scripts//a.mjs', 'scripts/../a.mjs', 'scripts/*.mjs']) {
    assert.equal(parseRepositoryPath(path), null, path);
  }
  assert.equal(pathMatchesOwnership('scripts/a.mjs', 'scripts/**'), true);
  assert.equal(pathMatchesOwnership('scripts', 'scripts/**'), true);
  assert.equal(pathMatchesOwnership('scripts-old/a.mjs', 'scripts/**'), false);
  assert.equal(pathMatchesOwnership('../scripts/a.mjs', 'scripts/**'), false);
});

test('contract identities canonicalize object keys while retaining array order and exact hash bytes', () => {
  const value = { z: [{ b: 2, a: 1 }], a: 'ä' };
  assert.deepEqual(canonicalContractJson(value), { a: 'ä', z: [{ a: 1, b: 2 }] });
  assert.equal(
    sha256CanonicalContractJson(value),
    'ab6a19a956dc7ee5168651a4e2637c618fcbaa1014ed018385443a7d454efd37',
  );
  assert.notEqual(
    sha256CanonicalContractJson({ values: ['first', 'second'] }),
    sha256CanonicalContractJson({ values: ['second', 'first'] }),
  );
});

test('precise disposition and validated worker identities preserve their domain rules', () => {
  const disposition = { requestId: 'request-1', evidence: { z: 2, a: 1 }, dispositionId: 'ignored' };
  assert.equal(staleDiscoveryDispositionId(null), null);
  assert.equal(staleDiscoveryDispositionId(disposition), staleDiscoveryDispositionId({
    evidence: { a: 1, z: 2 }, requestId: 'request-1', dispositionId: 'different',
  }));

  const result = { taskId: 'task-1', status: 'implemented' };
  assert.equal(
    validatedWorkerResultDigest(result, () => []),
    sha256CanonicalContractJson(result),
  );
  assert.throws(
    () => validatedWorkerResultDigest(result, () => ['$.status is invalid']),
    /Invalid worker result: \$\.status is invalid/u,
  );
});
