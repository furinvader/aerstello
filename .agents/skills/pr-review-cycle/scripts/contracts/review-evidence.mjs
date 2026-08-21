import { staleDiscoveryDispositionId } from './contract-identities.mjs';
import {
  isDateTime,
  isHttpsUrl,
  isObject,
  isSha,
  isString,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';

export { staleDiscoveryDispositionId } from './contract-identities.mjs';

export function buildStaleDiscoveryDisposition({
  request, liveHeadSha, evidence, responseFingerprint, disposedAt,
} = {}) {
  const disposition = {
    schemaVersion: 1,
    requestId: request?.id,
    requestHeadSha: request?.headSha,
    liveHeadSha,
    evidence,
    responseFingerprint,
    reason: 'head-drift',
    disposedAt,
  };
  return {
    schemaVersion: disposition.schemaVersion,
    dispositionId: staleDiscoveryDispositionId(disposition),
    requestId: disposition.requestId,
    requestHeadSha: disposition.requestHeadSha,
    liveHeadSha: disposition.liveHeadSha,
    evidence: disposition.evidence,
    responseFingerprint: disposition.responseFingerprint,
    reason: disposition.reason,
    disposedAt: disposition.disposedAt,
  };
}

function validateBaseEvidence(value, path, fields, errors) {
  if (!requireFields(value, fields, path, errors)) return false;
  rejectUnknownFields(value, fields, path, errors);
  if (!isString(value.id, { min: 1, max: 256 })) errors.push(`${path}.id is invalid`);
  if (!(value.databaseId === null || (Number.isInteger(value.databaseId) && value.databaseId >= 1))) {
    errors.push(`${path}.databaseId is invalid`);
  }
  if (!isHttpsUrl(value.url)) errors.push(`${path}.url must be an HTTPS URL`);
  if (!isSha(value.headSha)) errors.push(`${path}.headSha is invalid`);
  if (!isDateTime(value.at)) errors.push(`${path}.at is invalid`);
  return true;
}

export function validateReviewRequest(value, path, errors) {
  const fields = ['id', 'databaseId', 'url', 'headSha', 'at', 'kind', 'body', 'authorLogin', 'authorNodeId'];
  if (!validateBaseEvidence(value, path, fields, errors)) return;
  if (!['discovery', 'verification'].includes(value.kind)) errors.push(`${path}.kind is invalid`);
  if (value.body !== '@codex review') errors.push(`${path}.body must be exactly @codex review`);
  for (const field of ['authorLogin', 'authorNodeId']) {
    if (!isString(value[field], { min: 1, max: field === 'authorLogin' ? 128 : 256 })) {
      errors.push(`${path}.${field} is invalid`);
    }
  }
}

export function validateReviewOutcome(value, path, errors) {
  const fields = [
    'id', 'databaseId', 'url', 'headSha', 'at', 'requestId', 'kind', 'outcome',
    'evidenceType', 'reviewerLogin', 'reviewerNodeId', 'reviewerType', 'reviewerUrl',
    'reactionContent', 'reactionCommentId',
  ];
  if (!validateBaseEvidence(value, path, fields, errors)) return;
  if (!isString(value.requestId, { min: 1, max: 256 })) errors.push(`${path}.requestId is invalid`);
  if (!['discovery', 'verification'].includes(value.kind)) errors.push(`${path}.kind is invalid`);
  if (!['clean', 'findings'].includes(value.outcome)) errors.push(`${path}.outcome is invalid`);
  if (!['review-submission', 'request-reaction', 'issue-comment'].includes(value.evidenceType)) {
    errors.push(`${path}.evidenceType is invalid`);
  }
  if (value.reviewerLogin !== 'chatgpt-codex-connector') errors.push(`${path}.reviewerLogin must identify canonical Codex`);
  if (!isString(value.reviewerNodeId, { min: 1, max: 256 })) errors.push(`${path}.reviewerNodeId is invalid`);
  if (value.reviewerType !== 'Bot') errors.push(`${path}.reviewerType must be Bot`);
  if (value.reviewerUrl !== 'https://github.com/apps/chatgpt-codex-connector') {
    errors.push(`${path}.reviewerUrl must identify the canonical Codex GitHub App`);
  }
  if (value.evidenceType === 'request-reaction') {
    if (value.outcome !== 'clean') errors.push(`${path} request-reaction evidence may only prove a clean outcome`);
    if (value.reactionContent !== 'THUMBS_UP') errors.push(`${path}.reactionContent must be THUMBS_UP`);
    if (value.reactionCommentId !== value.requestId) errors.push(`${path}.reactionCommentId must equal requestId`);
  } else {
    if (value.reactionContent !== null || value.reactionCommentId !== null) {
      errors.push(`${path} non-reaction evidence cannot include reaction fields`);
    }
    if (value.evidenceType === 'issue-comment' && value.outcome !== 'clean') {
      errors.push(`${path} issue-comment evidence may only prove a clean outcome`);
    }
  }
}

export function validateStaleDiscoveryDispositions(value, state, errors) {
  const path = '$.staleDiscoveryDispositions';
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > 3) errors.push(`${path} must contain at most three discovery dispositions`);
  const dispositionIds = [];
  const requestIds = [];
  const evidenceIds = [];
  const historyIndexes = [];
  value.forEach((disposition, index) => {
    const itemPath = `${path}[${index}]`;
    const fields = [
      'schemaVersion', 'dispositionId', 'requestId', 'requestHeadSha', 'liveHeadSha',
      'evidence', 'responseFingerprint', 'reason', 'disposedAt',
    ];
    if (!requireFields(disposition, fields, itemPath, errors)) return;
    rejectUnknownFields(disposition, fields, itemPath, errors);
    if (disposition.schemaVersion !== 1) errors.push(`${itemPath}.schemaVersion must be 1`);
    if (!isString(disposition.dispositionId, { min: 64, max: 64 })
        || !/^[0-9a-f]{64}$/u.test(disposition.dispositionId)) {
      errors.push(`${itemPath}.dispositionId is invalid`);
    } else {
      dispositionIds.push(disposition.dispositionId);
    }
    if (!isString(disposition.requestId, { min: 1, max: 256 })) {
      errors.push(`${itemPath}.requestId is invalid`);
    } else {
      requestIds.push(disposition.requestId);
    }
    for (const field of ['requestHeadSha', 'liveHeadSha']) {
      if (!isSha(disposition[field])) errors.push(`${itemPath}.${field} is invalid`);
    }
    if (disposition.requestHeadSha === disposition.liveHeadSha) {
      errors.push(`${itemPath} requires distinct request and live HEADs`);
    }
    if (disposition.reason !== 'head-drift') errors.push(`${itemPath}.reason must be head-drift`);
    if (!isString(disposition.responseFingerprint, { min: 64, max: 64 })
        || !/^[0-9a-f]{64}$/u.test(disposition.responseFingerprint)) {
      errors.push(`${itemPath}.responseFingerprint is invalid`);
    }
    if (!isDateTime(disposition.disposedAt)) errors.push(`${itemPath}.disposedAt is invalid`);
    validateReviewOutcome(disposition.evidence, `${itemPath}.evidence`, errors);
    if (isObject(disposition.evidence)) {
      if (typeof disposition.evidence.id === 'string') evidenceIds.push(disposition.evidence.id);
      if (disposition.evidence.kind !== 'discovery') {
        errors.push(`${itemPath}.evidence must be a discovery response`);
      }
      if (disposition.evidence.requestId !== disposition.requestId
          || disposition.evidence.headSha !== disposition.requestHeadSha) {
        errors.push(`${itemPath}.evidence must bind to the exact request and prior HEAD`);
      }
      if (isDateTime(disposition.evidence.at) && isDateTime(disposition.disposedAt)
          && Date.parse(disposition.disposedAt) < Date.parse(disposition.evidence.at)) {
        errors.push(`${itemPath}.disposedAt cannot precede the canonical response`);
      }
    }
    if (staleDiscoveryDispositionId(disposition) !== disposition.dispositionId) {
      errors.push(`${itemPath}.dispositionId does not match its immutable evidence`);
    }
    const matches = Array.isArray(state.reviewHistory)
      ? state.reviewHistory.map((entry, historyIndex) => ({ entry, historyIndex }))
        .filter(({ entry }) => entry?.request?.id === disposition.requestId)
      : [];
    if (matches.length !== 1) {
      errors.push(`${itemPath} must bind to exactly one durable request history row`);
    } else {
      const [{ entry, historyIndex }] = matches;
      historyIndexes.push(historyIndex);
      if (entry.request.kind !== 'discovery' || entry.request.headSha !== disposition.requestHeadSha
          || entry.outcome !== null) {
        errors.push(`${itemPath} requires an exact null-outcome discovery history row`);
      }
      if (isDateTime(entry.request.at) && isDateTime(disposition.evidence?.at)
          && Date.parse(disposition.evidence.at) < Date.parse(entry.request.at)) {
        errors.push(`${itemPath}.evidence predates its request`);
      }
    }
  });
  for (const [label, values] of [
    ['disposition IDs', dispositionIds], ['request IDs', requestIds], ['evidence IDs', evidenceIds],
  ]) {
    if (new Set(values).size !== values.length) errors.push(`${path} contains duplicate ${label}`);
  }
  if (historyIndexes.some((historyIndex, index) => index > 0 && historyIndex <= historyIndexes[index - 1])) {
    errors.push(`${path} must follow durable request-history order`);
  }
  if (value.length > 0 && state.legacyReviewProvenance !== null) {
    errors.push(`${path} is available only to native schema-v3 request provenance`);
  }
}

export function validateVerificationEscalation(value, request, errors) {
  const path = '$.verificationEscalation';
  if (value === null) return;
  const fields = ['requestId', 'requestHeadSha', 'observedPrHeadSha', 'headRelation', 'evidenceIds', 'reason', 'at'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  if (!isString(value.requestId, { min: 1, max: 256 })) errors.push(`${path}.requestId is invalid`);
  for (const field of ['requestHeadSha', 'observedPrHeadSha']) {
    if (!isSha(value[field])) errors.push(`${path}.${field} is invalid`);
  }
  validateStringList(value.evidenceIds, `${path}.evidenceIds`, errors);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 8
      || value.evidenceIds.some((id) => !isString(id, { min: 1, max: 256 }))) {
    errors.push(`${path}.evidenceIds must contain 1-8 concise identifiers`);
  }
  if (!['stale-canonical-evidence', 'ambiguous-canonical-evidence', 'request-head-drift'].includes(value.reason)) {
    errors.push(`${path}.reason is invalid`);
  }
  if (!['same', 'changed'].includes(value.headRelation)) errors.push(`${path}.headRelation is invalid`);
  if (!isDateTime(value.at)) errors.push(`${path}.at is invalid`);
  if (request?.kind !== 'verification') errors.push(`${path} requires the current verification request`);
  if (value.requestId !== request?.id || value.requestHeadSha !== request?.headSha) {
    errors.push(`${path} must bind to the current pending request and exact SHA`);
  }
  const expectedRelation = value.reason === 'request-head-drift' ? 'changed' : 'same';
  if (value.headRelation !== expectedRelation) {
    errors.push(`${path}.headRelation must be ${expectedRelation} for ${value.reason}`);
  }
  const actualRelation = value.observedPrHeadSha === value.requestHeadSha ? 'same' : 'changed';
  if (value.headRelation !== actualRelation) {
    errors.push(`${path}.headRelation contradicts the request and observed PR HEADs`);
  }
}

export function validateReviewHistory(value, legacyDiscoveryCount, errors) {
  if (!Array.isArray(value)) {
    errors.push('$.reviewHistory must be an array');
    return;
  }
  value.forEach((entry, index) => {
    const path = `$.reviewHistory[${index}]`;
    if (!requireFields(entry, ['request', 'outcome'], path, errors)) return;
    rejectUnknownFields(entry, ['request', 'outcome'], path, errors);
    validateReviewRequest(entry.request, `${path}.request`, errors);
    if (entry.outcome !== null) {
      validateReviewOutcome(entry.outcome, `${path}.outcome`, errors);
      if (entry.outcome.requestId !== entry.request.id || entry.outcome.kind !== entry.request.kind
          || entry.outcome.headSha !== entry.request.headSha) {
        errors.push(`${path}.outcome must bind to its exact request and SHA`);
      }
    }
  });
  const discoveryCount = value.filter((entry) => entry.request?.kind === 'discovery').length;
  if (discoveryCount > 3) errors.push('$.reviewHistory exceeds three discovery requests');
  value.forEach((entry, index) => {
    const expectedKind = legacyDiscoveryCount + index < 3 ? 'discovery' : 'verification';
    if (entry.request?.kind && entry.request.kind !== expectedKind) {
      errors.push(`$.reviewHistory[${index}].request.kind must be ${expectedKind} at this durable request ordinal`);
    }
  });
  const requestIds = value.map((entry) => entry.request?.id);
  if (new Set(requestIds).size !== requestIds.length) errors.push('$.reviewHistory contains duplicate request IDs');
}
