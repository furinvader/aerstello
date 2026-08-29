import { isDeepStrictEqual } from 'node:util';

import {
  validateAssessmentPacket,
  validateScopeAssessmentApplicability,
  validateScopeAssessmentResult,
} from '../../../scope-review/scripts/validate-assessment.mjs';

import { sha256CanonicalContractJson } from './contract-identities.mjs';
import {
  isDateTime,
  isObject,
  isSha,
  isString,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_TYPES = new Set(['github-issue', 'direct-request', 'repository-plan', 'partial-implementation']);

export const SCOPE_CLASSIFICATIONS = [
  'within-scope-defect',
  'unnecessary-mechanism-defect',
  'material-scope-change',
  'unrelated-follow-up',
  'insufficient-scope-authority',
];

export const SCOPE_DECISIONS = [
  'approve-expansion-and-replan',
  'remove-or-simplify',
  'split-or-defer',
  'reject-expansion',
  'abandon-or-rework',
];

export const SCOPE_JOURNAL_ENTRY_KINDS = [
  'classification',
  'decision',
  'amendment',
  'exact-head-manifest',
  'resume',
];

export const SCOPE_CONTROL_GATES = [
  'insufficient-authority',
  'ready',
  'decision-required',
  'return-pending',
  'returned',
  'resume-required',
];

export function scopeClassificationMatchesTask(classification, task) {
  const findingIds = classification?.findingIds;
  const findingFingerprints = classification?.findingFingerprints;
  const sourceIds = task?.sourceIds;
  if (!Array.isArray(findingIds) || !Array.isArray(findingFingerprints)
      || !Array.isArray(sourceIds) || typeof task?.fingerprint !== 'string'
      || findingIds.length !== sourceIds.length
      || findingFingerprints.length !== sourceIds.length
      || new Set(findingIds).size !== findingIds.length
      || new Set(sourceIds).size !== sourceIds.length) return false;
  const actual = new Map(findingIds.map(
    (findingId, index) => [findingId, findingFingerprints[index]],
  ));
  return sourceIds.every(
    (sourceId, index) => actual.get(sourceId) === `${task.fingerprint}-f${index + 1}`,
  );
}

function isDigest(value, nullable = false) {
  return nullable && value === null ? true : typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isId(value) {
  return isString(value, { min: 1, max: 128 }) && ID_PATTERN.test(value);
}

function validateIdList(value, path, errors, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > 256
      || value.some((entry) => !isId(entry))) {
    errors.push(`${path} is invalid`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} contains duplicates`);
}

function validateDigestList(value, path, errors) {
  if (!Array.isArray(value) || value.length > 128 || value.some((entry) => !isDigest(entry))) {
    errors.push(`${path} is invalid`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} contains duplicates`);
}

function validateSource(source, path, errors) {
  const fields = ['type', 'identity', 'digest'];
  if (!requireFields(source, fields, path, errors)) return;
  rejectUnknownFields(source, fields, path, errors);
  if (!SOURCE_TYPES.has(source.type)) errors.push(`${path}.type is invalid`);
  if (!isString(source.identity, { min: 1, max: 512 }) || !/\S/u.test(source.identity)) {
    errors.push(`${path}.identity is invalid`);
  }
  if (!isDigest(source.digest)) errors.push(`${path}.digest is invalid`);
}

function validateAssessmentPair(value, path, errors, { requiredVerdict = null, expectedHeadSha = null } = {}) {
  const fields = ['packet', 'result', 'digest'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  for (const error of validateAssessmentPacket(value.packet)) errors.push(`${path}.packet: ${error}`);
  for (const error of validateScopeAssessmentResult(value.result)) errors.push(`${path}.result: ${error}`);
  for (const error of validateScopeAssessmentApplicability(value.packet, value.result)) {
    errors.push(`${path}: ${error}`);
  }
  if (requiredVerdict !== null && value.result?.verdict !== requiredVerdict) {
    errors.push(`${path}.result.verdict must equal ${requiredVerdict}`);
  }
  if (expectedHeadSha !== null
      && (value.packet?.binding?.subject?.sha !== expectedHeadSha
        || value.result?.binding?.subject?.sha !== expectedHeadSha)) {
    errors.push(`${path} must bind the exact expected HEAD`);
  }
  const expectedDigest = `sha256:${sha256CanonicalContractJson({ packet: value.packet, result: value.result })}`;
  if (value.digest !== expectedDigest) errors.push(`${path}.digest must bind the canonical packet/result pair`);
}

function validateAssessmentAuthority(value, authority, amendmentDigests, path, errors) {
  const approvedDecisions = Array.isArray(authority?.approvedDecisions)
    ? authority.approvedDecisions
    : [];
  const expectedDecisionAuthority = approvedDecisions.map(({ id, digest }) => ({ id, digest }));
  const acceptedDecisions = Array.isArray(value?.packet?.acceptedScope?.authorityDecisions)
    ? value.packet.acceptedScope.authorityDecisions
    : [];
  const acceptedDecisionAuthority = acceptedDecisions.map(({ id, digest }) => ({ id, digest }));
  if (!isDeepStrictEqual(acceptedDecisionAuthority, expectedDecisionAuthority)) {
    errors.push(`${path}.packet.acceptedScope.authorityDecisions must equal the ordered captured approved decisions`);
  }
  const decisionDigests = approvedDecisions.map(({ digest }) => digest);
  for (const side of ['packet', 'result']) {
    const binding = value?.[side]?.binding;
    if (!isDeepStrictEqual(binding?.source, authority?.source)) {
      errors.push(`${path}.${side}.binding.source must equal the captured authority source`);
    }
    if (binding?.planDigest !== authority?.planDigest) {
      errors.push(`${path}.${side}.binding.planDigest must equal the captured authority plan digest`);
    }
    if (!isDeepStrictEqual(binding?.amendmentDigests, amendmentDigests)) {
      errors.push(`${path}.${side}.binding.amendmentDigests must equal the ordered effective authority amendments`);
    }
    if (!isDeepStrictEqual(binding?.decisionDigests ?? [], decisionDigests)) {
      errors.push(`${path}.${side}.binding.decisionDigests must equal the ordered captured approved decision digests`);
    }
  }
}

function validateApprovedDecisions(value, path, errors) {
  if (!Array.isArray(value) || value.length > 128) {
    errors.push(`${path} is invalid`);
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const fields = ['id', 'digest'];
    if (!requireFields(entry, fields, entryPath, errors)) return;
    rejectUnknownFields(entry, fields, entryPath, errors);
    if (!isId(entry.id)) errors.push(`${entryPath}.id is invalid`);
    if (!isDigest(entry.digest)) errors.push(`${entryPath}.digest is invalid`);
  });
  if (new Set(value.map((entry) => entry?.id)).size !== value.length) errors.push(`${path} contains duplicate IDs`);
}

function validateDeferredFollowUps(value, path, errors) {
  if (!Array.isArray(value) || value.length > 256) {
    errors.push(`${path} is invalid`);
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const fields = ['id', 'reference'];
    if (!requireFields(entry, fields, entryPath, errors)) return;
    rejectUnknownFields(entry, fields, entryPath, errors);
    if (!isId(entry.id)) errors.push(`${entryPath}.id is invalid`);
    if (!isString(entry.reference, { min: 1 }) || Array.from(entry.reference).length > 4000) {
      errors.push(`${entryPath}.reference is invalid`);
    }
  });
  if (new Set(value.map((entry) => entry?.id)).size !== value.length) errors.push(`${path} contains duplicate IDs`);
}

export function validateScopeAuthoritySnapshot(value) {
  const errors = [];
  const fields = [
    'schemaVersion', 'authorityKind', 'source', 'planDigest', 'amendmentDigests',
    'minimalClosure', 'handoffHeadSha', 'integratedHeadAssessment', 'approvedDecisions',
    'deferredFollowUps', 'capturedAt',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!['standalone', 'imported', 'legacy-adoption'].includes(value.authorityKind)) {
    errors.push('$.authorityKind is invalid');
  }
  validateSource(value.source, '$.source', errors);
  if (!isDigest(value.planDigest, true)) errors.push('$.planDigest is invalid');
  validateDigestList(value.amendmentDigests, '$.amendmentDigests', errors);
  const closureFields = ['statement', 'digest'];
  if (requireFields(value.minimalClosure, closureFields, '$.minimalClosure', errors)) {
    rejectUnknownFields(value.minimalClosure, closureFields, '$.minimalClosure', errors);
    if (!isString(value.minimalClosure.statement, { min: 1, max: 4000 })
        || !/\S/u.test(value.minimalClosure.statement)) errors.push('$.minimalClosure.statement is invalid');
    if (!isDigest(value.minimalClosure.digest)) errors.push('$.minimalClosure.digest is invalid');
  }
  if (!isSha(value.handoffHeadSha)) errors.push('$.handoffHeadSha is invalid');
  if (value.integratedHeadAssessment !== null) {
    validateAssessmentPair(value.integratedHeadAssessment, '$.integratedHeadAssessment', errors, {
      requiredVerdict: 'within-scope', expectedHeadSha: value.handoffHeadSha,
    });
    validateAssessmentAuthority(
      value.integratedHeadAssessment,
      value,
      value.amendmentDigests,
      '$.integratedHeadAssessment',
      errors,
    );
    if (value.integratedHeadAssessment.packet?.binding?.phase !== 'integrated-head'
        || value.integratedHeadAssessment.result?.binding?.phase !== 'integrated-head') {
      errors.push('$.integratedHeadAssessment must be a canonical integrated-head assessment');
    }
  }
  validateApprovedDecisions(value.approvedDecisions, '$.approvedDecisions', errors);
  validateDeferredFollowUps(value.deferredFollowUps, '$.deferredFollowUps', errors);
  if (!isDateTime(value.capturedAt)) errors.push('$.capturedAt must be RFC 3339');
  if (value.authorityKind === 'imported') {
    if (value.planDigest === null) errors.push('$.planDigest is required for imported authority');
    if (value.integratedHeadAssessment === null) {
      errors.push('$.integratedHeadAssessment is required for imported authority');
    }
  }
  if (value.planDigest === null && value.amendmentDigests.length > 0) {
    errors.push('$.amendmentDigests requires a plan digest');
  }
  return errors;
}

export function scopeAuthorityDigest(value) {
  const errors = validateScopeAuthoritySnapshot(value);
  if (errors.length > 0) throw new Error(`Invalid scope authority: ${errors.join('; ')}`);
  return `sha256:${sha256CanonicalContractJson(value)}`;
}

function validateInventory(value, path, errors) {
  const fields = ['paths', 'dependencies', 'publicSurfaces', 'persistentSurfaces', 'validation'];
  if (!requireFields(value, fields, path, errors)) return;
  rejectUnknownFields(value, fields, path, errors);
  for (const field of fields) validateStringList(value[field], `${path}.${field}`, errors, 1000);
}

function validateJournalBase(entry, index, errors) {
  const path = `$.entries[${index}]`;
  if (!Number.isInteger(entry.sequence) || entry.sequence !== index + 1) {
    errors.push(`${path}.sequence must be the append-only one-based position`);
  }
  if (!isId(entry.entryId)) errors.push(`${path}.entryId is invalid`);
  if (!SCOPE_JOURNAL_ENTRY_KINDS.includes(entry.kind)) errors.push(`${path}.kind is invalid`);
  if (!isDateTime(entry.at)) errors.push(`${path}.at must be RFC 3339`);
  if (!isSha(entry.reviewHeadSha)) errors.push(`${path}.reviewHeadSha is invalid`);
  if (!isDigest(entry.authorityDigest)) errors.push(`${path}.authorityDigest is invalid`);
  if (!isId(entry.rootCauseId)) errors.push(`${path}.rootCauseId is invalid`);
}

function validateClassificationEntry(entry, path, errors) {
  validateStringList(entry.findingIds, `${path}.findingIds`, errors, 256);
  if (entry.findingIds?.length === 0) errors.push(`${path}.findingIds must not be empty`);
  validateStringList(entry.findingFingerprints, `${path}.findingFingerprints`, errors, 256);
  if (entry.findingFingerprints?.length !== entry.findingIds?.length) {
    errors.push(`${path}.findingFingerprints must correspond one-for-one with findingIds`);
  }
  if (!SCOPE_CLASSIFICATIONS.includes(entry.classification)) errors.push(`${path}.classification is invalid`);
  validateAssessmentPair(entry.assessment, `${path}.assessment`, errors, { expectedHeadSha: entry.reviewHeadSha });
  if (typeof entry.authorityAmendmentRequired !== 'boolean') {
    errors.push(`${path}.authorityAmendmentRequired must be boolean`);
  }
  if (!(entry.unrelatedReference === null
      || isString(entry.unrelatedReference, { min: 1, max: 1000 }))) {
    errors.push(`${path}.unrelatedReference is invalid`);
  }
  const verdict = entry.assessment?.result?.verdict;
  const expected = new Map([
    ['within-scope', 'within-scope-defect'],
    ['trim-required', 'unnecessary-mechanism-defect'],
    ['minor-amendment-required', 'within-scope-defect'],
    ['human-decision-required', 'material-scope-change'],
    ['insufficient-evidence', 'insufficient-scope-authority'],
  ]).get(verdict);
  if (entry.classification === 'unrelated-follow-up') {
    if (verdict !== 'within-scope') {
      errors.push(`${path}.classification does not match the canonical scope verdict`);
    }
    if (entry.unrelatedReference === null) {
      errors.push(`${path}.unrelatedReference is required for unrelated-follow-up`);
    }
  } else {
    if (expected !== undefined && entry.classification !== expected) {
      errors.push(`${path}.classification does not match the canonical scope verdict`);
    }
    if (entry.unrelatedReference !== null) {
      errors.push(`${path}.unrelatedReference is reserved for unrelated-follow-up`);
    }
  }
  const amendmentRequired = verdict === 'minor-amendment-required';
  if (entry.authorityAmendmentRequired !== amendmentRequired) {
    errors.push(`${path}.authorityAmendmentRequired must equal the minor-amendment verdict`);
  }
  if (!isDigest(entry.remediationShapeDigest)) errors.push(`${path}.remediationShapeDigest is invalid`);
  validateStringList(entry.tripwires, `${path}.tripwires`, errors, 128);
}

function validateDecisionEntry(entry, path, errors) {
  for (const field of ['blockerId', 'decisionId']) if (!isId(entry[field])) errors.push(`${path}.${field} is invalid`);
  if (!SCOPE_DECISIONS.includes(entry.decision)) errors.push(`${path}.decision is invalid`);
  for (const field of ['assessmentDigest', 'blockerDigest']) {
    if (!isDigest(entry[field])) errors.push(`${path}.${field} is invalid`);
  }
  if (!isDigest(entry.approvedDeltaDigest, true)) errors.push(`${path}.approvedDeltaDigest is invalid`);
  if (!isString(entry.rationale, { min: 1, max: 4000 })) errors.push(`${path}.rationale is invalid`);
  validateIdList(entry.priorDecisionIds, `${path}.priorDecisionIds`, errors);
  if (entry.decision === 'approve-expansion-and-replan' && entry.approvedDeltaDigest === null) {
    errors.push(`${path}.approvedDeltaDigest is required for approved expansion`);
  }
}

function validateEntry(entry, index, errors) {
  const path = `$.entries[${index}]`;
  const common = ['schemaVersion', 'sequence', 'entryId', 'kind', 'at', 'reviewHeadSha', 'authorityDigest', 'rootCauseId'];
  const variants = {
    classification: ['findingIds', 'findingFingerprints', 'classification', 'assessment', 'authorityAmendmentRequired', 'unrelatedReference', 'remediationShapeDigest', 'tripwires'],
    decision: ['blockerId', 'decisionId', 'decision', 'assessmentDigest', 'blockerDigest', 'approvedDeltaDigest', 'rationale', 'priorDecisionIds'],
    amendment: ['decisionId', 'amendmentDigest', 'priorAuthorityDigest', 'revisedAuthorityDigest'],
    'exact-head-manifest': ['manifestDigest', 'assessmentDigest', 'triggerKinds'],
    resume: ['decisionId', 'scopeReturnDigest', 'resumedAuthorityDigest', 'resumedHeadSha'],
  };
  const fields = [...common, ...(variants[entry?.kind] ?? [])];
  if (!requireFields(entry, fields, path, errors)) return;
  rejectUnknownFields(entry, fields, path, errors);
  if (entry.schemaVersion !== 1) errors.push(`${path}.schemaVersion must equal 1`);
  validateJournalBase(entry, index, errors);
  if (entry.kind === 'classification') validateClassificationEntry(entry, path, errors);
  if (entry.kind === 'decision') validateDecisionEntry(entry, path, errors);
  if (entry.kind === 'amendment') {
    if (!isId(entry.decisionId)) errors.push(`${path}.decisionId is invalid`);
    for (const field of ['amendmentDigest', 'priorAuthorityDigest', 'revisedAuthorityDigest']) {
      if (!isDigest(entry[field])) errors.push(`${path}.${field} is invalid`);
    }
  }
  if (entry.kind === 'exact-head-manifest') {
    for (const field of ['manifestDigest', 'assessmentDigest']) {
      if (!isDigest(entry[field])) errors.push(`${path}.${field} is invalid`);
    }
    validateStringList(entry.triggerKinds, `${path}.triggerKinds`, errors, 128);
  }
  if (entry.kind === 'resume') {
    if (!isId(entry.decisionId)) errors.push(`${path}.decisionId is invalid`);
    for (const field of ['scopeReturnDigest', 'resumedAuthorityDigest']) {
      if (!isDigest(entry[field])) errors.push(`${path}.${field} is invalid`);
    }
    if (!isSha(entry.resumedHeadSha) || entry.resumedHeadSha !== entry.reviewHeadSha) {
      errors.push(`${path}.resumedHeadSha must equal reviewHeadSha`);
    }
  }
}

export function validateScopeControlJournal(value, authority = null) {
  const errors = [];
  const fields = ['schemaVersion', 'prNumber', 'authorityDigest', 'entries'];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!Number.isInteger(value.prNumber) || value.prNumber < 1) errors.push('$.prNumber must be positive');
  if (!isDigest(value.authorityDigest)) errors.push('$.authorityDigest is invalid');
  if (!Array.isArray(value.entries) || value.entries.length > 4096) errors.push('$.entries is invalid');
  else {
    value.entries.forEach((entry, index) => validateEntry(entry, index, errors));
    if (new Set(value.entries.map((entry) => entry?.entryId)).size !== value.entries.length) {
      errors.push('$.entries contains duplicate entry IDs');
    }
    const firstAmendment = value.entries.find((entry) => entry?.kind === 'amendment');
    let effectiveAuthority = firstAmendment?.priorAuthorityDigest ?? value.authorityDigest;
    const decisions = new Map();
    const classifications = new Map();
    const amendmentDigests = Array.isArray(authority?.amendmentDigests)
      ? [...authority.amendmentDigests]
      : [];
    if (authority !== null) {
      const authorityErrors = validateScopeAuthoritySnapshot(authority);
      for (const error of authorityErrors) errors.push(`$ authority: ${error}`);
      const capturedDigest = authorityErrors.length === 0 ? scopeAuthorityDigest(authority) : null;
      if (capturedDigest !== null && effectiveAuthority !== capturedDigest) {
        errors.push('$.authorityDigest chain must begin with the captured authority digest');
      }
    }
    for (const [index, entry] of value.entries.entries()) {
      const path = `$.entries[${index}]`;
      if (entry?.authorityDigest !== effectiveAuthority) {
        errors.push(`${path}.authorityDigest must equal the authority effective at its sequence`);
      }
      if (entry?.kind === 'classification') {
        classifications.set(entry.rootCauseId, entry);
        if (authority !== null) {
          validateAssessmentAuthority(entry.assessment, authority, amendmentDigests, `${path}.assessment`, errors);
        } else if (amendmentDigests.some(
          (digest) => !entry.assessment?.packet?.binding?.amendmentDigests?.includes(digest),
        )) {
          errors.push(`${path}.assessment must bind every preceding journal amendment`);
        }
      }
      if (entry?.kind === 'decision') {
        const classification = classifications.get(entry.rootCauseId);
        if (!classification || classification.authorityDigest !== effectiveAuthority
            || entry.assessmentDigest !== classification.assessment?.digest) {
          errors.push(`${path} must bind the latest classification for its root cause`);
        }
        decisions.set(entry.decisionId, entry);
      }
      if (entry?.kind === 'amendment') {
        const decision = decisions.get(entry.decisionId);
        const classification = classifications.get(entry.rootCauseId);
        if (entry.priorAuthorityDigest !== effectiveAuthority) {
          errors.push(`${path}.priorAuthorityDigest must equal the authority effective before amendment`);
        }
        if (entry.revisedAuthorityDigest === entry.priorAuthorityDigest) {
          errors.push(`${path}.revisedAuthorityDigest must differ from priorAuthorityDigest`);
        }
        if (!decision || decision.rootCauseId !== entry.rootCauseId
            || decision.assessmentDigest !== classification?.assessment?.digest
            || decision.decision !== 'approve-expansion-and-replan'
            || decision.approvedDeltaDigest !== entry.amendmentDigest) {
          errors.push(`${path} must bind an approved expansion decision and its matching classified delta`);
        }
        amendmentDigests.push(entry.amendmentDigest);
        effectiveAuthority = entry.revisedAuthorityDigest;
      }
      if (entry?.kind === 'exact-head-manifest') {
        const expected = scopeExactHeadManifestDigest(value.entries.slice(0, index), entry.reviewHeadSha);
        if (entry.manifestDigest !== expected) {
          errors.push(`$.entries[${index}].manifestDigest must bind the complete ordered prior journal evidence`);
        }
        const classification = value.entries[index - 1];
        if (classification?.kind !== 'classification'
            || classification.reviewHeadSha !== entry.reviewHeadSha
            || classification.rootCauseId !== entry.rootCauseId
            || classification.authorityDigest !== entry.authorityDigest
            || classification.assessment?.digest !== entry.assessmentDigest
            || classification.assessment?.packet?.binding?.phase !== 'integrated-head'
            || classification.assessment?.result?.verdict !== 'within-scope'
            || classification.classification !== 'within-scope-defect'
            || classification.authorityAmendmentRequired
            || entry.triggerKinds?.length !== 1
            || entry.triggerKinds[0] !== 'classification') {
          errors.push(`${path} must identify the immediately prior canonical integrated-head within-scope classification`);
        }
      }
      if (entry?.kind === 'resume') {
        const prior = value.entries[index - 1];
        if (entry.resumedAuthorityDigest !== effectiveAuthority) {
          errors.push(`${path}.resumedAuthorityDigest must equal the authority effective at resume`);
        }
        if (prior?.kind === 'amendment' && (prior.decisionId !== entry.decisionId
            || prior.rootCauseId !== entry.rootCauseId
            || prior.revisedAuthorityDigest !== entry.resumedAuthorityDigest)) {
          errors.push(`${path} must bind the immediately preceding authority amendment`);
        }
      }
    }
    if (value.authorityDigest !== effectiveAuthority) {
      errors.push('$.authorityDigest must equal the final effective authority');
    }
  }
  return errors;
}

export function scopeExactHeadManifestDigest(entries, reviewHeadSha) {
  if (!Array.isArray(entries) || !isSha(reviewHeadSha)) {
    throw new Error('Exact-head manifest identity requires ordered entries and a review HEAD');
  }
  return `sha256:${sha256CanonicalContractJson({ reviewHeadSha, entries })}`;
}

function classificationGate(entry) {
  if (entry.classification === 'insufficient-scope-authority') return 'insufficient-authority';
  if (entry.classification === 'material-scope-change' || entry.authorityAmendmentRequired) {
    return 'decision-required';
  }
  return 'ready';
}

export function scopeGateForClassificationEntry(entry) {
  const errors = [];
  validateEntry(entry, Number.isInteger(entry?.sequence) ? entry.sequence - 1 : 0, errors);
  if (errors.length > 0 || entry?.kind !== 'classification') {
    throw new Error(`Invalid scope classification: ${errors.join('; ') || 'wrong journal variant'}`);
  }
  return classificationGate(entry);
}

export function scopeGateForJournal(journal) {
  const latestAmendment = journal.entries.findLast((entry) => entry.kind === 'amendment');
  if (latestAmendment) {
    const revisedAssessment = journal.entries.findLast((entry) => entry.kind === 'classification'
      && entry.sequence > latestAmendment.sequence
      && entry.authorityDigest === journal.authorityDigest
      && !entry.authorityAmendmentRequired);
    if (!revisedAssessment) return 'decision-required';
  }
  const latestByRoot = new Map();
  for (const entry of journal.entries) {
    if (entry.kind === 'classification') latestByRoot.set(entry.rootCauseId, entry);
  }
  if (latestByRoot.size === 0) return 'insufficient-authority';
  let decisionRequired = false;
  for (const entry of latestByRoot.values()) {
    const entryGate = classificationGate(entry);
    if (entryGate === 'insufficient-authority') return entryGate;
    if (entryGate !== 'decision-required') continue;
    if (entry.authorityAmendmentRequired) {
      decisionRequired = true;
      continue;
    }
    const resolved = journal.entries.some((candidate) => candidate.kind === 'decision'
      && candidate.rootCauseId === entry.rootCauseId
      && candidate.assessmentDigest === entry.assessment.digest
      && candidate.sequence > entry.sequence);
    if (!resolved) decisionRequired = true;
  }
  return decisionRequired ? 'decision-required' : 'ready';
}

export function scopeControlJournalDigest(value) {
  const errors = validateScopeControlJournal(value);
  if (errors.length > 0) throw new Error(`Invalid scope journal: ${errors.join('; ')}`);
  return `sha256:${sha256CanonicalContractJson(value)}`;
}

export function validateScopeReturnEnvelope(value) {
  const errors = [];
  const fields = [
    'schemaVersion', 'repository', 'prNumber', 'authorityDigest', 'journalDigest', 'blockerId',
    'decisionId', 'reviewHeadSha', 'livePrHeadSha', 'rootCauseId', 'findingIds',
    'findingFingerprints', 'assessmentDigest', 'smallestExpansion', 'narrowAlternative',
    'trimAlternative', 'inventory', 'priorDecisionIds', 'createdAt',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 1) errors.push('$.schemaVersion must equal 1');
  if (!isString(value.repository, { min: 3, max: 256 }) || !/^[^/\s]+\/[^/\s]+$/u.test(value.repository)) {
    errors.push('$.repository is invalid');
  }
  if (!Number.isInteger(value.prNumber) || value.prNumber < 1) errors.push('$.prNumber must be positive');
  for (const field of ['authorityDigest', 'journalDigest', 'assessmentDigest']) {
    if (!isDigest(value[field])) errors.push(`$.${field} is invalid`);
  }
  for (const field of ['blockerId', 'decisionId', 'rootCauseId']) {
    if (!isId(value[field])) errors.push(`$.${field} is invalid`);
  }
  for (const field of ['reviewHeadSha', 'livePrHeadSha']) {
    if (!isSha(value[field])) errors.push(`$.${field} is invalid`);
  }
  if (value.reviewHeadSha !== value.livePrHeadSha) errors.push('$.reviewHeadSha must equal livePrHeadSha');
  validateStringList(value.findingIds, '$.findingIds', errors, 256);
  if (value.findingIds?.length === 0) errors.push('$.findingIds must not be empty');
  validateStringList(value.findingFingerprints, '$.findingFingerprints', errors, 256);
  if (value.findingFingerprints?.length !== value.findingIds?.length) {
    errors.push('$.findingFingerprints must correspond one-for-one with findingIds');
  }
  for (const field of ['smallestExpansion', 'narrowAlternative', 'trimAlternative']) {
    if (!(value[field] === null || isString(value[field], { min: 1, max: 4000 }))) {
      errors.push(`$.${field} is invalid`);
    }
  }
  if (value.smallestExpansion === null) errors.push('$.smallestExpansion is required');
  if (value.narrowAlternative === null) errors.push('$.narrowAlternative is required');
  validateInventory(value.inventory, '$.inventory', errors);
  validateIdList(value.priorDecisionIds, '$.priorDecisionIds', errors);
  if (!isDateTime(value.createdAt)) errors.push('$.createdAt must be RFC 3339');
  return errors;
}

export function scopeReturnResumeIdentity(value) {
  const errors = validateScopeReturnEnvelope(value);
  if (errors.length > 0) throw new Error(`Invalid scope return: ${errors.join('; ')}`);
  return `sha256:${sha256CanonicalContractJson({
    authorityDigest: value.authorityDigest,
    journalDigest: value.journalDigest,
    blockerId: value.blockerId,
    decisionId: value.decisionId,
    reviewHeadSha: value.reviewHeadSha,
    livePrHeadSha: value.livePrHeadSha,
    rootCauseId: value.rootCauseId,
    assessmentDigest: value.assessmentDigest,
    findingIds: value.findingIds,
    findingFingerprints: value.findingFingerprints,
  })}`;
}

export function validateScopeControlReference(value, path = '$.scopeControl') {
  const errors = [];
  const fields = ['authorityDigest', 'journalDigest', 'returnDigest', 'gate', 'assessmentHeadSha', 'updatedAt'];
  if (!requireFields(value, fields, path, errors)) return errors;
  rejectUnknownFields(value, fields, path, errors);
  for (const field of ['authorityDigest', 'journalDigest']) {
    if (!isDigest(value[field])) errors.push(`${path}.${field} is invalid`);
  }
  if (!isDigest(value.returnDigest, true)) errors.push(`${path}.returnDigest is invalid`);
  if (!SCOPE_CONTROL_GATES.includes(value.gate)) errors.push(`${path}.gate is invalid`);
  if (!isSha(value.assessmentHeadSha, true)) errors.push(`${path}.assessmentHeadSha is invalid`);
  if (!isDateTime(value.updatedAt)) errors.push(`${path}.updatedAt must be RFC 3339`);
  if (['return-pending', 'returned', 'resume-required'].includes(value.gate)
      && value.returnDigest === null) errors.push(`${path}.returnDigest is required for ${value.gate}`);
  return errors;
}
