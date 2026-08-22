import { existsSync, readFileSync } from 'node:fs';
import { gitText, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { inspectReleaseState } from '../../../../../scripts/lib/release-state.mjs';
import { validatePrReviewState, validatePrReviewStateV1 } from '../contracts/contracts.mjs';
import { repositoryRoot } from '../paths.mjs';
import { atomicWriteJson, serializeJson } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { gitSnapshot } from './git-authority.mjs';
import { appendEvent } from './journal.mjs';
import { activePointerPath, parsePrNumber, statePath } from './locations.mjs';
import { withStateLock } from './locks.mjs';
import { migratePrReviewStateV2 } from './migrations.mjs';

export const ACTIVE_STATE_LIMIT_BYTES = 64 * 1024;
function utcNow() { return new Date().toISOString(); }
function emptyLocalVerification() { return { status: 'not-run', headSha: null, taskIds: [], updatedAt: null }; }
function emptyThreadProof() {
  return { status: 'not-run', headSha: null, threads: [],
    threadlessVerification: { status: 'not-run', headSha: null, taskIds: [], updatedAt: null },
    localVerification: emptyLocalVerification(), updatedAt: null };
}
function emptyTargetedValidation() {
  return { source: 'orchestrator', scope: 'targeted', status: 'not-run', headSha: null, checks: [], updatedAt: null };
}
function emptyCiValidation() {
  return { source: 'github-actions', scope: 'full', status: 'not-run', headSha: null, checks: [],
    checkRunId: null, workflowRunId: null, workflowRunUrl: null, updatedAt: null };
}

export function validateStateForWrite(state) {
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new StateError(`Invalid PR review state:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  const bytes = Buffer.byteLength(serializeJson(state), 'utf8');
  if (bytes > ACTIVE_STATE_LIMIT_BYTES) {
    throw new StateError(`Active state is ${bytes} bytes; limit is ${ACTIVE_STATE_LIMIT_BYTES}`, 'STATE_TOO_LARGE');
  }
}

export function readStateDocument(path) {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > ACTIVE_STATE_LIMIT_BYTES) {
      throw new StateError(
        `Active state exceeds ${ACTIVE_STATE_LIMIT_BYTES} bytes`,
        'STATE_TOO_LARGE',
      );
    }
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(`Unable to read ${path}: ${error.message}`, 'STATE_READ_FAILED');
  }
}

export function parseState(path) {
  const document = readStateDocument(path);
  const state = document;
  if (state?.schemaVersion === 1) {
    const legacyErrors = validatePrReviewStateV1(state);
    if (legacyErrors.length > 0) {
      throw new StateError(`Invalid state at ${path}:\n- ${legacyErrors.join('\n- ')}`, 'INVALID_STATE');
    }
    throw new StateError(
      `State at ${path} uses schema v1; run the explicit migrate command`,
      'STATE_MIGRATION_REQUIRED',
    );
  }
  if (state?.schemaVersion === 2) {
    try { migratePrReviewStateV2(state); } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError(`Invalid state at ${path}: ${error.message}`, 'INVALID_STATE');
    }
    throw new StateError(
      `State at ${path} uses schema v2; run the explicit migrate command`,
      'STATE_MIGRATION_REQUIRED',
    );
  }
  const errors = validatePrReviewState(state);
  if (errors.length > 0) throw new StateError(`Invalid state at ${path}:\n- ${errors.join('\n- ')}`, 'INVALID_STATE');
  return state;
}

export function activePrNumber(cwd = process.cwd()) {
  const path = activePointerPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const pointer = JSON.parse(readFileSync(path, 'utf8'));
    return parsePrNumber(pointer.prNumber);
  } catch (error) {
    throw new StateError(`Invalid active PR pointer at ${path}: ${error.message}`, 'INVALID_ACTIVE_POINTER');
  }
}

export function locateState(cwd = process.cwd(), prNumber) {
  const selected = prNumber === undefined || prNumber === null ? activePrNumber(cwd) : parsePrNumber(prNumber);
  if (selected === null) return null;
  const path = statePath(cwd, selected);
  if (!existsSync(path)) throw new StateError(`Active PR ${selected} has no state file at ${path}`, 'STATE_NOT_FOUND');
  return { prNumber: selected, path };
}

export function loadState(cwd = process.cwd(), prNumber) {
  const located = locateState(cwd, prNumber);
  return located ? parseState(located.path) : null;
}

export function originRepository(cwd) {
  const result = runGit(['config', '--get', 'remote.origin.url'], { cwd, allowFailure: true });
  if (result.status !== 0) return null;
  const remote = String(result.stdout).trim();
  const match = remote.match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function initializeState({
  cwd = process.cwd(),
  prNumber,
  repository,
  base = 'origin/main',
  head = 'HEAD',
  releaseRef = 'origin/main',
  orchestratorSessionId = null,
  reviewRequestLimit = null,
} = {}) {
  const selectedPr = parsePrNumber(prNumber);
  const repo = repository ?? originRepository(cwd);
  if (!repo) throw new StateError('Unable to derive owner/name from origin; pass --repository', 'REPOSITORY_REQUIRED');
  if (!(reviewRequestLimit === null
      || (Number.isSafeInteger(reviewRequestLimit) && reviewRequestLimit > 0))) {
    throw new StateError(
      `Review request limit must be null or a positive safe integer up to ${Number.MAX_SAFE_INTEGER}`,
      'INVALID_REVIEW_REQUEST_LIMIT',
    );
  }
  const root = repositoryRoot(cwd);
  const baseSha = resolveCommit(cwd, base);
  const currentIntegrationHeadSha = resolveCommit(cwd, head);
  const releaseState = inspectReleaseState({ cwd, base, head, releaseRef });
  if (releaseState.status === 'inconsistent') {
    throw new StateError('Release metadata is inconsistent; PR review state was not initialized', 'RELEASE_STATE_INCONSISTENT');
  }

  return withStateLock(cwd, selectedPr, () => {
    const existingActive = activePrNumber(cwd);
    if (existingActive !== null) throw new StateError(`PR ${existingActive} is already active`, 'ACTIVE_STATE_EXISTS');
    const path = statePath(cwd, selectedPr);
    if (existsSync(path)) throw new StateError(`State already exists for PR ${selectedPr}`, 'STATE_EXISTS');
    const state = {
      schemaVersion: 3,
      revision: 0,
      repository: repo,
      prNumber: selectedPr,
      phase: 'recovering',
      baseSha,
      requestedHeadSha: null,
      reviewedHeadSha: null,
      currentIntegrationHeadSha,
      reviewRound: 0,
      verificationReviewUsed: false,
      reviewRequestLimit,
      legacyReviewProvenance: null,
      releaseBaseline: releaseState.applicableRelease,
      decisions: [],
      tasks: [],
      reviewRequest: null,
      reviewOutcome: null,
      reviewHistory: [],
      staleDiscoveryDispositions: [],
      verificationEscalation: null,
      threadResolutionStatus: emptyThreadProof(),
      blockedReasons: [],
      validationStatus: emptyTargetedValidation(),
      ciValidationStatus: emptyCiValidation(),
      ciValidationHistory: [],
      nextAction: 'Resolve the PR and pushed head metadata before requesting review.',
      integrationWorktree: root,
      orchestratorSessionId,
      abandonmentReason: null,
      git: gitSnapshot(root),
      updatedAt: utcNow(),
    };
    validateStateForWrite(state);
    atomicWriteJson(path, state);
    atomicWriteJson(activePointerPath(cwd), { schemaVersion: 3, prNumber: selectedPr });
    appendEvent(cwd, selectedPr, { type: 'initialized', summary: `Initialized PR ${selectedPr}` });
    return state;
  });
}
