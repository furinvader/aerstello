import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { canonicalJsonText } from '../contracts/contracts.mjs';
import {
  scopeContractDigest,
  taskSetDigest,
  taskSetIdentity,
  validateMinimalClosureContract,
  validateScopeDecision,
  validateScopeEvidence,
} from '../scope/contracts.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_AMENDMENTS = 128;
const MAX_DECISIONS = 128;
const MAX_FOLLOW_UPS = 256;
const MAX_FOLLOW_UP_REFERENCE_LENGTH = 4000;

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertFields(value, fields, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function assertReceipt(receipt, label, validate = null) {
  assertFields(receipt, ['digest', 'value'], label);
  if (!DIGEST.test(receipt.digest ?? '') || receipt.digest !== scopeContractDigest(receipt.value)) {
    throw new TypeError(`${label} digest does not match its canonical value`);
  }
  const errors = validate?.(receipt.value) ?? [];
  if (errors.length > 0) throw new TypeError(`${label} is invalid: ${errors.join('; ')}`);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`);
}

function clone(value) {
  return structuredClone(value);
}

function amendmentDigests(amendments, acceptedPlan, effectivePlan) {
  if (!Array.isArray(amendments) || amendments.length > MAX_AMENDMENTS) {
    throw new TypeError(`amendments must contain at most ${MAX_AMENDMENTS} receipt records`);
  }
  const original = acceptedPlan.value;
  const effective = effectivePlan.value;
  if (!Number.isSafeInteger(original.planRevision) || original.planRevision < 1
      || !Number.isSafeInteger(effective.planRevision) || effective.planRevision < 1) {
    throw new TypeError('original and effective plan revisions must be positive safe integers');
  }
  if (original.changeId !== effective.changeId) {
    throw new TypeError('original and effective plan change identities must match');
  }
  if (amendments.length !== effective.planRevision - original.planRevision) {
    throw new TypeError('amendment count must exactly span the original and effective plan revisions');
  }
  let previousDigest = acceptedPlan.digest;
  const digests = amendments.map((receipt, index) => {
    assertReceipt(receipt, `amendments[${index}]`);
    const amendment = receipt.value;
    assertObject(amendment, `amendments[${index}].value`);
    if (!DIGEST.test(amendment.previousDigest ?? '') || !DIGEST.test(amendment.newDigest ?? '')) {
      throw new TypeError(`amendments[${index}] lacks canonical plan digests`);
    }
    if (amendment.previousDigest !== previousDigest) {
      throw new TypeError('amendments do not form one ordered effective-plan chain');
    }
    if (scopeContractDigest(amendment.resultingPlan) !== amendment.newDigest) {
      throw new TypeError(`amendments[${index}] resulting plan digest does not match`);
    }
    if (amendment.resultingPlan?.changeId !== original.changeId
        || amendment.resultingPlan?.planRevision !== original.planRevision + index + 1) {
      throw new TypeError(`amendments[${index}] resulting plan identity or revision is not contiguous`);
    }
    previousDigest = amendment.newDigest;
    return receipt.digest;
  });
  if (previousDigest !== effectivePlan.digest) {
    throw new TypeError('final amendment does not produce the effective plan');
  }
  assertUnique(digests, 'amendment digests');
  return digests;
}

function approvedDecisions(decisions, closure) {
  if (!Array.isArray(decisions) || decisions.length > MAX_DECISIONS) {
    throw new TypeError(`decisions must contain at most ${MAX_DECISIONS} receipt records`);
  }
  const projected = decisions.map((receipt, index) => {
    assertReceipt(receipt, `decisions[${index}]`, validateScopeDecision);
    return {
      id: receipt.value.decisionId,
      digest: receipt.digest,
      disposition: receipt.value.disposition,
      authorizedShape: clone(receipt.value.approvedShape),
    };
  });
  assertUnique(projected.map(({ id }) => id), 'decision IDs');
  if (!isDeepStrictEqual(projected.map(({ digest }) => digest), closure.value.operatorDecisionDigests)) {
    throw new TypeError('decision receipts do not match minimal-closure decision authority');
  }
  return projected;
}

function deferredFollowUps(closure) {
  const entries = closure.value.deferredFollowups;
  if (entries.length > MAX_FOLLOW_UPS) {
    throw new TypeError(`deferred follow-ups must contain at most ${MAX_FOLLOW_UPS} entries`);
  }
  const projected = entries.map(({ id, text: reference }) => ({ id, reference }));
  if (projected.some(
    ({ reference }) => Array.from(reference).length > MAX_FOLLOW_UP_REFERENCE_LENGTH,
  )) {
    throw new TypeError(
      `deferred follow-up reference exceeds ${MAX_FOLLOW_UP_REFERENCE_LENGTH} characters`,
    );
  }
  assertUnique(projected.map(({ id }) => id), 'deferred follow-up IDs');
  return projected;
}

function terminalTaskSetAuthority(receipt) {
  assertReceipt(receipt, 'terminalTaskSet');
  const identity = taskSetIdentity(receipt.value);
  if (!isDeepStrictEqual(identity, receipt.value) || receipt.digest !== taskSetDigest(identity)) {
    throw new TypeError('terminalTaskSet must be the exact receipt-valid canonical terminal task identity');
  }
  return receipt.digest;
}

export function buildDevelopmentScopeHandoff(input) {
  assertFields(input, [
    'amendments',
    'capturedAt',
    'changeId',
    'decisions',
    'effectivePlan',
    'headSha',
    'integratedScopeEvidence',
    'minimalClosure',
    'acceptedPlan',
    'terminalTaskSet',
  ], 'handoff input');
  if (!SHA.test(input.headSha ?? '')) throw new TypeError('headSha must be a full Git SHA');
  if (!DATE_TIME.test(input.capturedAt ?? '') || Number.isNaN(Date.parse(input.capturedAt))) {
    throw new TypeError('capturedAt must be an RFC 3339 timestamp');
  }
  assertReceipt(input.acceptedPlan, 'acceptedPlan');
  assertReceipt(input.effectivePlan, 'effectivePlan');
  assertReceipt(input.minimalClosure, 'minimalClosure', validateMinimalClosureContract);
  assertReceipt(input.integratedScopeEvidence, 'integratedScopeEvidence', validateScopeEvidence);
  const terminalTaskSetDigest = terminalTaskSetAuthority(input.terminalTaskSet);

  const plan = input.effectivePlan.value;
  const closure = input.minimalClosure.value;
  const evidence = input.integratedScopeEvidence.value;
  const amendmentReceiptDigests = amendmentDigests(
    input.amendments,
    input.acceptedPlan,
    input.effectivePlan,
  );
  const decisionReceipts = approvedDecisions(input.decisions, input.minimalClosure);
  const errors = [];
  if (input.changeId !== closure.changeId || input.changeId !== evidence.changeId
      || input.changeId !== plan.changeId || input.changeId !== input.acceptedPlan.value.changeId) {
    errors.push('change identity is inconsistent');
  }
  if (closure.planDigest !== input.effectivePlan.digest) errors.push('minimal closure is stale for the effective plan');
  if (closure.planningSha !== plan.planning?.planningSha) errors.push('minimal closure Planning SHA is stale');
  const source = { type: plan.source?.kind, identity: plan.source?.reference, digest: plan.source?.captureDigest };
  if (!isDeepStrictEqual(closure.source, source)) errors.push('minimal closure source is stale');
  const binding = evidence.packet?.binding;
  if (evidence.cadence?.boundary !== 'integrated-head' || binding?.phase !== 'integrated-head'
      || evidence.result?.verdict !== 'within-scope') errors.push('current evidence is not an integrated-HEAD within-scope assessment');
  if (binding?.subject?.sha !== input.headSha || evidence.result?.binding?.subject?.sha !== input.headSha) {
    errors.push('integrated assessment is stale for the handoff HEAD');
  }
  if (!isDeepStrictEqual(binding?.source, source) || binding?.planDigest !== input.effectivePlan.digest
      || !isDeepStrictEqual(binding?.amendmentDigests, amendmentReceiptDigests)
      || !isDeepStrictEqual(binding?.decisionDigests ?? [], decisionReceipts.map(({ digest }) => digest))) {
    errors.push('integrated assessment is stale for the effective authority');
  }
  if (binding?.taskPacketDigest !== terminalTaskSetDigest) {
    errors.push('integrated assessment is stale for the terminal task set');
  }
  const expectedSubjectDigest = scopeContractDigest({
    headSha: input.headSha,
    taskSetDigest: terminalTaskSetDigest,
  });
  if (binding?.subject?.digest !== expectedSubjectDigest
      || evidence.result?.binding?.subject?.digest !== expectedSubjectDigest) {
    errors.push('integrated assessment subject is stale for the handoff HEAD and terminal task set');
  }
  if (evidence.closureDigest !== input.minimalClosure.digest) errors.push('integrated assessment is stale for minimal closure');
  if (errors.length > 0) throw new TypeError(`Cannot build development scope handoff: ${errors.join('; ')}`);

  return {
    schemaVersion: 1,
    authorityKind: 'imported',
    source: clone(source),
    planDigest: input.effectivePlan.digest,
    amendmentDigests: clone(amendmentReceiptDigests),
    minimalClosure: { statement: closure.outcome, digest: input.minimalClosure.digest },
    handoffHeadSha: input.headSha,
    integratedHeadAssessment: {
      packet: clone(evidence.packet),
      result: clone(evidence.result),
      digest: `sha256:${createHash('sha256').update(canonicalJsonText({
        packet: evidence.packet, result: evidence.result,
      }).slice(0, -1), 'utf8').digest('hex')}`,
    },
    approvedDecisions: clone(decisionReceipts),
    deferredFollowUps: clone(deferredFollowUps(input.minimalClosure)),
    capturedAt: input.capturedAt,
  };
}
