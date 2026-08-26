import {
  scopeControlJournalDigest,
  scopeGateForClassificationEntry,
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

export function scopeGateForJournal(journal) {
  const latestByRoot = new Map();
  for (const entry of journal.entries) {
    if (entry.kind === 'classification') latestByRoot.set(entry.rootCauseId, entry);
  }
  if (latestByRoot.size === 0) return 'insufficient-authority';
  let decisionRequired = false;
  for (const entry of latestByRoot.values()) {
    const entryGate = scopeGateForClassificationEntry(entry);
    if (entryGate === 'insufficient-authority') return entryGate;
    if (entryGate !== 'decision-required') continue;
    const resolved = journal.entries.some((candidate) => candidate.kind === 'decision'
      && candidate.rootCauseId === entry.rootCauseId
      && candidate.assessmentDigest === entry.assessment.digest
      && candidate.sequence > entry.sequence);
    if (!resolved) decisionRequired = true;
  }
  return decisionRequired ? 'decision-required' : 'ready';
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
  const gate = returning ? 'return-pending' : 'ready';
  return {
    ...state,
    phase: returning ? 'awaiting-human-decision' : state.phase,
    blockedReasons: returning
      ? [...state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
        `Scope authority: ${decision.rootCauseId} requires guarded return.`]
      : state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate,
      returnDigest,
      assessmentHeadSha: decision.reviewHeadSha,
      at,
    }),
    nextAction: returning
      ? 'Emit the guarded scope-return envelope for change-development disposition.'
      : 'Apply the approved narrow disposition and classify any changed remediation shape.',
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
  return {
    ...state,
    phase: 'recovering',
    blockedReasons: state.blockedReasons.filter((reason) => !reason.startsWith('Scope authority:')),
    scopeControl: scopeReference({
      authorityDigest: journal.authorityDigest,
      journal,
      gate: 'ready',
      returnDigest,
      assessmentHeadSha: headSha,
      at,
    }),
    nextAction: 'Reconcile the resumed exact HEAD and classify any changed remediation shape.',
  };
}
