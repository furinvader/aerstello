import {
  scopeControlJournalDigest,
  scopeGateForJournal,
} from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

function now(value) { return value ?? new Date().toISOString(); }

export function scopeReference({ authorityDigest, journal, gate, returnDigest = null, assessmentHeadSha = null, at }) {
  return {
    authorityDigest,
    journalDigest: scopeControlJournalDigest(journal),
    returnDigest,
    gate,
    assessmentHeadSha,
    updatedAt: now(at),
  };
}

export function latestScopeClassification(journal, rootCauseId = null) {
  return journal.entries.findLast((entry) => entry.kind === 'classification'
    && (rootCauseId === null || entry.rootCauseId === rootCauseId)) ?? null;
}

export function buildScopeAuthorityTransition(state, authorityDigest, journal, at) {
  return {
    ...state,
    phase: state.phase === 'blocked'
      && state.blockedReasons.some((reason) => reason.startsWith('Scope authority:'))
      ? 'recovering' : state.phase,
    blockedReasons: state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
    scopeControl: scopeReference({
      authorityDigest, journal, gate: journal.entries.length === 0 ? 'ready' : scopeGateForJournal(journal), at,
    }),
    nextAction: journal.entries.length === 0
      ? 'Classify every nonterminal finding root before binding or progressing remediation.'
      : state.nextAction,
  };
}

export function buildScopeClassificationTransition(state, journal, at) {
  const latest = latestScopeClassification(journal);
  if (latest === null) throw new StateError('Scope classification journal has no classification', 'INVALID_SCOPE_CLASSIFICATION');
  const gate = scopeGateForJournal(journal);
  const blocker = `Scope authority: ${latest.rootCauseId} requires ${gate}.`;
  return {
    ...state,
    phase: gate === 'ready' ? state.phase : 'awaiting-human-decision',
    blockedReasons: gate === 'ready'
      ? state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:'))
      : [...state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')), blocker],
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate,
      returnDigest: state.scopeControl?.returnDigest ?? null,
      assessmentHeadSha: latest.reviewHeadSha,
      at,
    }),
    nextAction: gate === 'ready'
      ? 'Continue only with remediation bound to the applicable classified shape.'
      : 'Record the required scope decision or return control to change development.',
  };
}

export function buildScopeDecisionTransition(state, journal, decision, at, returnDigest = null) {
  const returning = ['approve-expansion-and-replan', 'abandon-or-rework'].includes(decision.decision);
  const classification = latestScopeClassification(journal, decision.rootCauseId);
  const materialReturn = returning && !classification?.authorityAmendmentRequired;
  const gate = materialReturn ? 'return-pending' : scopeGateForJournal(journal);
  return {
    ...state,
    phase: gate === 'ready' ? state.phase : 'awaiting-human-decision',
    blockedReasons: materialReturn
      ? [...state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
        `Scope authority: ${decision.rootCauseId} requires guarded return.`]
      : gate === 'ready'
        ? state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:'))
        : [...state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
          `Scope authority: ${decision.rootCauseId} requires a fresh revised-authority assessment.`],
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate,
      returnDigest: returnDigest ?? state.scopeControl?.returnDigest ?? null,
      assessmentHeadSha: decision.reviewHeadSha,
      at,
    }),
    nextAction: materialReturn
      ? 'Emit the guarded scope-return envelope for change-development disposition.'
      : gate === 'ready'
        ? 'Apply the approved narrow disposition and classify any changed remediation shape.'
        : 'Classify the exact remediation shape under the revised authority before execution.',
  };
}

export function buildScopeReturnTransition(state, journal, returnDigest, at) {
  return {
    ...state,
    phase: 'awaiting-human-decision',
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate: 'returned',
      returnDigest,
      assessmentHeadSha: state.scopeControl?.assessmentHeadSha ?? null,
      at,
    }),
    nextAction: 'Wait for a guarded scope-resume handoff; do not mutate change-development state.',
  };
}

export function buildScopeResumeTransition(state, journal, returnDigest, headSha, at) {
  const gate = scopeGateForJournal(journal);
  return {
    ...state,
    phase: 'recovering',
    blockedReasons: gate === 'ready'
      ? state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:'))
      : [...state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
        'Scope authority: resumed authority requires a fresh exact-head assessment.'],
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate,
      returnDigest,
      assessmentHeadSha: headSha,
      at,
    }),
    nextAction: gate === 'ready'
      ? 'Reconcile the resumed exact HEAD and classify any changed remediation shape.'
      : 'Classify the resumed exact HEAD under the revised authority before execution.',
  };
}
