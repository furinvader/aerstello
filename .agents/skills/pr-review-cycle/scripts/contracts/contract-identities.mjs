import { createHash } from 'node:crypto';

import { isObject } from './primitives.mjs';

export function canonicalContractJson(value) {
  if (Array.isArray(value)) return value.map(canonicalContractJson);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalContractJson(value[key])]));
  }
  return value;
}

export function sha256CanonicalContractJson(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalContractJson(value)))
    .digest('hex');
}

export function staleDiscoveryDispositionId(disposition) {
  if (!isObject(disposition)) return null;
  const { dispositionId: _dispositionId, ...identity } = disposition;
  return sha256CanonicalContractJson(identity);
}

export function validatedWorkerResultDigest(result, validateWorkerResult) {
  const errors = validateWorkerResult(result);
  if (errors.length > 0) throw new Error(`Invalid worker result: ${errors.join('; ')}`);
  return sha256CanonicalContractJson(result);
}
