import { existsSync } from 'node:fs';

import {
  scopeAuthorityDigest,
  scopeControlJournalDigest,
  scopeExactHeadManifestDigest,
  validateScopeAuthoritySnapshot,
  validateScopeControlJournal,
  validateScopeReturnEnvelope,
} from '../../contracts/contracts.mjs';
import { canonicalSerializedJson } from '../atomic-io.mjs';
import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import {
  persistScopeAuthority,
  persistScopeJournal,
  persistScopeReturn,
  readScopeAuthority,
  readScopeJournal,
  readScopeReturn,
  scopeReturnDigest,
} from '../evidence/scope-control.mjs';
import { activePrNumber, loadState } from '../state-store.mjs';
import { taskPacketDigest } from '../evidence/task-packets.mjs';
import { scopeReturnPath } from '../locations.mjs';
import { resolveScopeClassificationHead } from '../scope-classification-head.mjs';
import {
  buildScopeAuthorityTransition,
  buildScopeClassificationTransition,
  buildScopeDecisionTransition,
  buildScopeResumeTransition,
  buildScopeReturnTransition,
  latestScopeClassification,
} from '../transitions/scope.mjs';

function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  return selected;
}

function validateInput(value, validate, label) {
  const errors = validate(value);
  if (errors.length > 0) throw new StateError(`Invalid ${label}:\n- ${errors.join('\n- ')}`, 'INVALID_SCOPE_EVIDENCE');
}

function activeWorker(state) {
  return state.tasks.find((task) => ['queued', 'running', 'implemented'].includes(task.status)) ?? null;
}

function transact({ cwd, prNumber, expectedRevision, kind, transaction }) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateError('Scope transition requires an expected revision', 'STATE_REVISION_CONFLICT');
  }
  return checkpointProtectedStateTransaction({
    cwd,
    prNumber: selectedPr(cwd, prNumber),
    expectedRevision,
    requireExpectedRevision: true,
    transitionKind: kind,
    transaction,
  });
}

export function checkpointScopeAuthority({
  cwd = process.cwd(), prNumber, authority, expectedRevision, event,
} = {}) {
  validateInput(authority, validateScopeAuthoritySnapshot, 'scope authority');
  return transact({
    cwd, prNumber, expectedRevision, kind: 'scope-authority',
    transaction: (current) => {
      if (current.scopeControl) {
        const existing = readScopeAuthority(cwd, current);
        if (canonicalSerializedJson(existing.value) === canonicalSerializedJson(authority)) {
          return { nextState: current, result: current, noWrite: true };
        }
        throw new StateError('Scope authority is immutable after capture', 'SCOPE_AUTHORITY_CONFLICT');
      }
      const worker = activeWorker(current);
      if (worker) throw new StateError(`Legacy authority adoption is unsafe while ${worker.id} is ${worker.status}`, 'SCOPE_ADOPTION_ACTIVE_WORKER');
      if (authority.handoffHeadSha !== current.currentIntegrationHeadSha) {
        throw new StateError('Scope authority handoff HEAD is stale', 'SCOPE_AUTHORITY_STALE');
      }
      const authorityDigest = scopeAuthorityDigest(authority);
      const journal = { schemaVersion: 1, prNumber: current.prNumber, authorityDigest, entries: [] };
      return {
        nextState: buildScopeAuthorityTransition(current, authorityDigest, journal),
        event: event ?? { type: 'scope-authority-captured', summary: `Captured ${authority.authorityKind} scope authority` },
        beforeCommit: () => {
          persistScopeAuthority(cwd, current, authority);
          persistScopeJournal(cwd, current, journal);
        },
      };
    },
  });
}

function appendEntry(journal, entry) {
  const next = structuredClone(entry);
  next.sequence = journal.entries.length + 1;
  const value = {
    ...journal,
    authorityDigest: next.kind === 'amendment' ? next.revisedAuthorityDigest : journal.authorityDigest,
    entries: [...journal.entries, next],
  };
  validateInput(value, validateScopeControlJournal, 'scope control journal');
  return value;
}

function initialJournalAuthorityDigest(journal) {
  return journal.entries.find((entry) => entry.kind === 'amendment')?.priorAuthorityDigest
    ?? journal.authorityDigest;
}

function amendmentEntry(amendment, journal, classification, decision, transitionAt) {
  if (amendment === null || typeof amendment !== 'object' || Array.isArray(amendment)) {
    throw new StateError('Scope amendment payload is invalid', 'INVALID_SCOPE_AMENDMENT');
  }
  if (amendment.priorAuthorityDigest !== journal.authorityDigest) {
    throw new StateError('Scope amendment prior authority is stale', 'INVALID_SCOPE_EVIDENCE');
  }
  const fields = [
    'entryId', 'at', 'rootCauseId', 'decisionId', 'amendmentDigest',
    'priorAuthorityDigest', 'revisedAuthorityDigest',
  ];
  if (Object.keys(amendment).sort().join('\n') !== [...fields].sort().join('\n')
      || amendment.at !== transitionAt
      || amendment.rootCauseId !== classification.rootCauseId
      || amendment.decisionId !== decision.decisionId) {
    throw new StateError('Scope amendment payload does not match its atomic authority chain', 'INVALID_SCOPE_AMENDMENT');
  }
  return {
    ...amendment,
    schemaVersion: 1,
    sequence: journal.entries.length + 1,
    kind: 'amendment',
    reviewHeadSha: classification.reviewHeadSha,
    authorityDigest: journal.authorityDigest,
    rootCauseId: classification.rootCauseId,
    decisionId: decision.decisionId,
  };
}

function journalPrefixLength(journal, expectedDigest) {
  for (let length = journal.entries.length; length >= 0; length -= 1) {
    const candidate = { ...journal, entries: journal.entries.slice(0, length) };
    if (scopeControlJournalDigest(candidate) === expectedDigest) return length;
  }
  return null;
}

function sameEntryPayload(left, right) {
  const omitGenerated = (entry) => {
    const { sequence: _sequence, schemaVersion: _schemaVersion, kind: _kind,
      authorityDigest: _authorityDigest, ...payload } = entry;
    return payload;
  };
  return canonicalSerializedJson(omitGenerated(left)) === canonicalSerializedJson(omitGenerated(right));
}

export function checkpointScopeClassification({
  cwd = process.cwd(), prNumber, classification, expectedRevision, event,
} = {}) {
  return transact({
    cwd, prNumber, expectedRevision, kind: 'scope-classification',
    transaction: (current) => {
      if (!current.scopeControl) throw new StateError('Capture scope authority before classification', 'SCOPE_AUTHORITY_REQUIRED');
      const authority = readScopeAuthority(cwd, current);
      const existing = readScopeJournal(cwd, current);
      if (authority.digest !== initialJournalAuthorityDigest(existing.value)) {
        throw new StateError('Scope state projection is stale or altered', 'INVALID_SCOPE_EVIDENCE');
      }
      const entry = {
        ...classification,
        schemaVersion: 1,
        sequence: existing.value.entries.length + 1,
        kind: 'classification',
        authorityDigest: existing.value.authorityDigest,
      };
      const reviewHeadSha = resolveScopeClassificationHead({
        phase: entry.assessment?.packet?.binding?.phase,
        reviewedHeadSha: current.reviewedHeadSha,
        currentIntegrationHeadSha: current.currentIntegrationHeadSha,
      });
      if (entry.reviewHeadSha !== reviewHeadSha) {
        throw new StateError('Scope classification must bind the exact Review commit', 'SCOPE_CLASSIFICATION_STALE');
      }
      const prior = latestScopeClassification(existing.value, entry.rootCauseId);
      const prefixLength = journalPrefixLength(existing.value, current.scopeControl.journalDigest);
      if (prefixLength === null) {
        throw new StateError('Scope journal does not extend the compact state projection', 'INVALID_SCOPE_EVIDENCE');
      }
      if (existing.digest !== current.scopeControl.journalDigest) {
        const pending = existing.value.entries.slice(prefixLength);
        if (pending.length < 1 || pending.length > 2 || pending[0].kind !== 'classification'
            || !sameEntryPayload(pending[0], entry)
            || (pending.length === 2 && pending[1].kind !== 'exact-head-manifest')) {
          throw new StateError('Different scope journal evidence is pending checkpoint', 'SCOPE_EVIDENCE_CONFLICT');
        }
        return {
          nextState: buildScopeClassificationTransition(current, existing.value),
          event: event ?? { type: 'scope-classified', summary: `Recovered classification ${entry.entryId}` },
        };
      }
      if (prior && canonicalSerializedJson({ ...prior, sequence: entry.sequence, entryId: entry.entryId, at: entry.at })
        === canonicalSerializedJson(entry)) {
        return { nextState: current, result: current, noWrite: true };
      }
      let journal = appendEntry(existing.value, entry);
      if (entry.assessment.result.verdict === 'within-scope'
          && entry.assessment.packet.binding.phase === 'integrated-head') {
        const manifest = {
          schemaVersion: 1,
          sequence: journal.entries.length + 1,
          entryId: `exact-head-${entry.entryId}`,
          kind: 'exact-head-manifest',
          at: entry.at,
          reviewHeadSha: entry.reviewHeadSha,
          authorityDigest: existing.value.authorityDigest,
          rootCauseId: entry.rootCauseId,
          manifestDigest: scopeExactHeadManifestDigest(journal.entries, entry.reviewHeadSha),
          assessmentDigest: entry.assessment.digest,
          triggerKinds: ['classification'],
        };
        journal = appendEntry(journal, manifest);
      }
      return {
        nextState: buildScopeClassificationTransition(current, journal),
        event: event ?? { type: 'scope-classified', summary: `Classified ${entry.rootCauseId} as ${entry.classification}` },
        beforeCommit: () => persistScopeJournal(cwd, current, journal),
      };
    },
  });
}

function materialExpansionCount(journal, rootCauseId) {
  return journal.entries.filter((entry) => entry.kind === 'decision'
    && entry.rootCauseId === rootCauseId
    && entry.decision === 'approve-expansion-and-replan').length;
}

export function checkpointScopeDecision({
  cwd = process.cwd(), prNumber, decision, expectedRevision, event,
} = {}) {
  return transact({
    cwd, prNumber, expectedRevision, kind: 'scope-decision',
    transaction: (current) => {
      if (!current.scopeControl) throw new StateError('Scope authority is required', 'SCOPE_AUTHORITY_REQUIRED');
      const existing = readScopeJournal(cwd, current);
      if (current.scopeControl.gate !== 'decision-required') {
        throw new StateError('No scope decision is currently required', 'SCOPE_DECISION_NOT_REQUIRED');
      }
      const classification = latestScopeClassification(existing.value, decision.rootCauseId);
      if (!classification) throw new StateError('Decision has no classified root cause', 'INVALID_SCOPE_DECISION');
      const { amendment = null, ...decisionInput } = decision;
      const entry = {
        ...decisionInput,
        schemaVersion: 1,
        sequence: existing.value.entries.length + 1,
        kind: 'decision',
        authorityDigest: existing.value.authorityDigest,
        reviewHeadSha: classification.reviewHeadSha,
        assessmentDigest: classification.assessment.digest,
      };
      const prefixLength = journalPrefixLength(existing.value, current.scopeControl.journalDigest);
      if (prefixLength === null) {
        throw new StateError('Scope journal does not extend the compact state projection', 'INVALID_SCOPE_EVIDENCE');
      }
      if (existing.digest !== current.scopeControl.journalDigest) {
        const pending = existing.value.entries.slice(prefixLength);
        const expectedKinds = amendment === null ? ['decision'] : ['decision', 'amendment'];
        const expectedAmendment = amendment === null ? null
          : amendmentEntry(amendment, {
            ...existing.value,
            authorityDigest: current.scopeControl.authorityDigest,
            entries: existing.value.entries.slice(0, prefixLength + 1),
          }, classification, entry, entry.at);
        if (canonicalSerializedJson(pending.map((item) => item.kind)) !== canonicalSerializedJson(expectedKinds)
            || !sameEntryPayload(pending[0], entry)
            || (expectedAmendment && !sameEntryPayload(pending[1], expectedAmendment))) {
          throw new StateError('Different scope decision evidence is pending checkpoint', 'SCOPE_EVIDENCE_CONFLICT');
        }
        const pendingReturn = existsSync(scopeReturnPath(cwd, current.prNumber))
          ? readScopeReturn(cwd, current) : null;
        return {
          nextState: buildScopeDecisionTransition(
            current, existing.value, pending[0], undefined, pendingReturn?.digest ?? null,
          ),
          event: event ?? { type: 'scope-decision-recorded', summary: `Recovered ${entry.decisionId}` },
        };
      }
      if (entry.decision === 'approve-expansion-and-replan'
          && materialExpansionCount(existing.value, entry.rootCauseId) >= 1) {
        const reason = `Scope authority: repeated expansion churn for ${entry.rootCauseId}.`;
        return {
          nextState: {
            ...current,
            phase: 'blocked',
            blockedReasons: [...current.blockedReasons.filter((item) => item !== reason), reason],
            nextAction: 'Stop remediation expansion and obtain an explicit human disposition.',
          },
          event: { type: 'scope-churn-blocked', summary: `Stopped repeated expansion for ${entry.rootCauseId}` },
        };
      }
      let journal = appendEntry(existing.value, entry);
      if (amendment !== null) {
        if (!classification.authorityAmendmentRequired) {
          throw new StateError('Authority amendment is not required by the classified scope verdict', 'INVALID_SCOPE_AMENDMENT');
        }
        journal = appendEntry(journal, amendmentEntry(amendment, journal, classification, entry, entry.at));
      }
      const returning = !classification.authorityAmendmentRequired
        && ['approve-expansion-and-replan', 'abandon-or-rework'].includes(entry.decision);
      const returnEnvelope = returning
        ? buildReturnEnvelope(current, journal, classification, entry, entry.at) : null;
      const returnIdentity = returnEnvelope === null ? null : scopeReturnDigest(returnEnvelope);
      return {
        nextState: buildScopeDecisionTransition(current, journal, entry, undefined, returnIdentity),
        event: event ?? { type: 'scope-decision-recorded', summary: `Recorded ${entry.decisionId}` },
        beforeCommit: () => {
          persistScopeJournal(cwd, current, journal);
          if (returnEnvelope) persistScopeReturn(cwd, current, returnEnvelope);
        },
      };
    },
  });
}

function inventoryFromAssessment(assessment) {
  const inventory = assessment.packet.changeInventory;
  return {
    paths: inventory.paths,
    dependencies: inventory.dependencies,
    publicSurfaces: inventory.publicSurfaces,
    persistentSurfaces: inventory.persistentSurfaces,
    validation: [],
  };
}

function buildReturnEnvelope(state, journal, classification, decision, createdAt) {
  const result = classification.assessment.result;
  const envelope = {
    schemaVersion: 1,
    repository: state.repository,
    prNumber: state.prNumber,
    authorityDigest: journal.authorityDigest,
    journalDigest: scopeControlJournalDigest(journal),
    blockerId: decision.blockerId,
    decisionId: decision.decisionId,
    reviewHeadSha: classification.reviewHeadSha,
    livePrHeadSha: state.currentIntegrationHeadSha,
    rootCauseId: classification.rootCauseId,
    findingIds: classification.findingIds,
    findingFingerprints: classification.findingFingerprints,
    assessmentDigest: classification.assessment.digest,
    smallestExpansion: result.smallestExpansion,
    narrowAlternative: result.narrowAlternative,
    trimAlternative: result.smallerSufficientAlternative,
    inventory: inventoryFromAssessment(classification.assessment),
    priorDecisionIds: decision.priorDecisionIds,
    createdAt,
  };
  validateInput(envelope, validateScopeReturnEnvelope, 'scope return');
  return envelope;
}

export function checkpointScopeReturn({
  cwd = process.cwd(), prNumber, livePrHeadSha, expectedRevision, event,
} = {}) {
  return transact({
    cwd, prNumber, expectedRevision, kind: 'scope-return',
    transaction: (current) => {
      if (current.scopeControl?.gate !== 'return-pending') {
        throw new StateError('Scope return is not pending', 'SCOPE_RETURN_NOT_PENDING');
      }
      const journalEvidence = readScopeJournal(cwd, current);
      const classification = latestScopeClassification(journalEvidence.value);
      const decision = journalEvidence.value.entries.findLast((entry) => entry.kind === 'decision'
        && entry.rootCauseId === classification?.rootCauseId);
      if (!classification || !decision) throw new StateError('Scope return lacks classified decision evidence', 'INVALID_SCOPE_RETURN');
      if (livePrHeadSha !== current.currentIntegrationHeadSha
          || livePrHeadSha !== classification.reviewHeadSha) {
        throw new StateError('Scope return requires the exact live PR HEAD', 'SCOPE_RETURN_STALE');
      }
      if (!existsSync(scopeReturnPath(cwd, current.prNumber))) {
        throw new StateError('Scope return envelope is missing after its guarded decision', 'INVALID_SCOPE_RETURN');
      }
      const envelope = readScopeReturn(cwd, current).value;
      const expected = buildReturnEnvelope(
        current, journalEvidence.value, classification, decision, envelope.createdAt,
      );
      if (canonicalSerializedJson(envelope) !== canonicalSerializedJson(expected)) {
        throw new StateError('Scope return envelope does not match its guarded decision', 'SCOPE_EVIDENCE_CONFLICT');
      }
      validateInput(envelope, validateScopeReturnEnvelope, 'scope return');
      const returnIdentity = scopeReturnDigest(envelope);
      return {
        nextState: buildScopeReturnTransition(current, journalEvidence.value, returnIdentity),
        event: event ?? { type: 'scope-returned', summary: `Returned scope control for ${classification.rootCauseId}` },
        beforeCommit: () => persistScopeReturn(cwd, current, envelope),
      };
    },
  });
}

export function checkpointScopeResume({
  cwd = process.cwd(), prNumber, resume, expectedRevision, event,
} = {}) {
  return transact({
    cwd, prNumber, expectedRevision, kind: 'scope-resume',
    transaction: (current) => {
      if (!['returned', 'resume-required'].includes(current.scopeControl?.gate)) {
        throw new StateError('Scope control is not awaiting resume', 'SCOPE_RESUME_NOT_REQUIRED');
      }
      const returned = readScopeReturn(cwd, current);
      const journalEvidence = readScopeJournal(cwd, current);
      const { amendment = null, ...resumeInput } = resume;
      const expectedAuthorityDigest = amendment?.revisedAuthorityDigest
        ?? journalEvidence.value.authorityDigest;
      if (resumeInput.scopeReturnDigest !== returned.digest
          || resumeInput.resumedAuthorityDigest !== expectedAuthorityDigest
          || resume.resumedHeadSha !== current.currentIntegrationHeadSha) {
        throw new StateError('Scope resume input is stale or does not match durable evidence', 'INVALID_SCOPE_RESUME');
      }
      const entry = {
        schemaVersion: 1,
        sequence: journalEvidence.value.entries.length + 1,
        entryId: resumeInput.entryId,
        kind: 'resume',
        at: resumeInput.at,
        reviewHeadSha: resumeInput.resumedHeadSha,
        authorityDigest: expectedAuthorityDigest,
        rootCauseId: resumeInput.rootCauseId,
        decisionId: resumeInput.decisionId,
        scopeReturnDigest: resumeInput.scopeReturnDigest,
        resumedAuthorityDigest: resumeInput.resumedAuthorityDigest,
        resumedHeadSha: resumeInput.resumedHeadSha,
      };
      const classification = latestScopeClassification(journalEvidence.value, entry.rootCauseId);
      const decision = journalEvidence.value.entries.findLast((candidate) => candidate.kind === 'decision'
        && candidate.rootCauseId === entry.rootCauseId && candidate.decisionId === entry.decisionId);
      if (!classification || !decision) {
        throw new StateError('Scope resume lacks its classified decision', 'INVALID_SCOPE_RESUME');
      }
      const prefixLength = journalPrefixLength(journalEvidence.value, current.scopeControl.journalDigest);
      if (prefixLength === null) {
        throw new StateError('Scope journal does not extend the compact state projection', 'INVALID_SCOPE_EVIDENCE');
      }
      if (journalEvidence.digest !== current.scopeControl.journalDigest) {
        const pending = journalEvidence.value.entries.slice(prefixLength);
        const expectedKinds = amendment === null ? ['resume'] : ['amendment', 'resume'];
        const expectedAmendment = amendment === null ? null
          : amendmentEntry(amendment, {
            ...journalEvidence.value,
            authorityDigest: current.scopeControl.authorityDigest,
            entries: journalEvidence.value.entries.slice(0, prefixLength),
          }, classification, decision, entry.at);
        if (canonicalSerializedJson(pending.map((item) => item.kind)) !== canonicalSerializedJson(expectedKinds)
            || !sameEntryPayload(pending.at(-1), entry)
            || (expectedAmendment && !sameEntryPayload(pending[0], expectedAmendment))) {
          throw new StateError('Different scope resume evidence is pending checkpoint', 'SCOPE_EVIDENCE_CONFLICT');
        }
        return {
          nextState: buildScopeResumeTransition(
            current, journalEvidence.value, returned.digest, resumeInput.resumedHeadSha,
          ),
          event: event ?? { type: 'scope-resumed', summary: `Recovered scope resume ${entry.entryId}` },
        };
      }
      let journal = journalEvidence.value;
      if (amendment !== null) {
        journal = appendEntry(journal, amendmentEntry(amendment, journal, classification, decision, entry.at));
      }
      journal = appendEntry(journal, entry);
      return {
        nextState: buildScopeResumeTransition(current, journal, returned.digest, resumeInput.resumedHeadSha),
        event: event ?? { type: 'scope-resumed', summary: `Resumed scope control for ${entry.rootCauseId}` },
        beforeCommit: () => persistScopeJournal(cwd, current, journal),
      };
    },
  });
}

export function assertScopeTaskAllowed(cwd, state, task, packet) {
  if (!state.scopeControl) {
    throw new StateError(`Scope authority is insufficient for task ${task.id}`, 'SCOPE_AUTHORITY_REQUIRED');
  }
  if (state.scopeControl.gate !== 'ready') {
    throw new StateError(`Scope gate ${state.scopeControl.gate} blocks task ${task.id}`, 'SCOPE_TASK_BLOCKED');
  }
  const journal = readScopeJournal(cwd, state).value;
  const expectedShape = `sha256:${taskPacketDigest(packet)}`;
  const classification = journal.entries.findLast((entry) => entry.kind === 'classification'
    && (entry.rootCauseId === task.id
      || task.sourceIds.every((sourceId) => entry.findingIds.includes(sourceId))));
  if (!classification
      || classification.authorityAmendmentRequired
      || classification.authorityDigest !== journal.authorityDigest
      || classification.reviewHeadSha !== packet.reviewedHeadSha
      || classification.remediationShapeDigest !== expectedShape
      || !['within-scope-defect', 'unnecessary-mechanism-defect'].includes(classification.classification)) {
    throw new StateError(`Task ${task.id} lacks a current applicable scope classification for its exact packet`, 'SCOPE_CLASSIFICATION_REQUIRED');
  }
}

export function scopeStatus({ cwd = process.cwd(), prNumber } = {}) {
  const state = loadState(cwd, selectedPr(cwd, prNumber));
  if (!state.scopeControl) return { configured: false, gate: 'insufficient-authority' };
  const authority = readScopeAuthority(cwd, state);
  const journal = readScopeJournal(cwd, state);
  const returned = state.scopeControl.returnDigest === null ? null : readScopeReturn(cwd, state);
  return {
    configured: true,
    gate: state.scopeControl.gate,
    reference: state.scopeControl,
    authority: { digest: authority.digest, value: authority.value },
    journal: { digest: journal.digest, value: journal.value },
    return: returned && { digest: returned.digest, value: returned.value },
  };
}
