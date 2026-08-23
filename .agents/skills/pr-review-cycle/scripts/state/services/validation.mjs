import { spawnSync } from 'node:child_process';

import { canonicalJson } from '../atomic-io.mjs';
import {
  checkpointProtectedStateTransaction,
  checkpointStateTransaction,
} from '../checkpoint.mjs';
import { StateError } from '../errors.mjs';
import {
  actionableIntegratedTaskIds,
  actionablePacketValidationTaskIds,
  assertCleanExactIntegrationHead,
  buildTargetedValidationPlanUnlocked,
  executeTargetedValidationFacts,
  isCleanTasklessReviewValidationRecovery,
  isNativeTasklessPendingReviewHeadDriftValidationRecovery,
  isNativeTasklessReviewHeadDriftValidationRecovery,
  readV2CompletedTaskValidationRecoveryEvidence,
  readValidationPlan,
} from '../evidence/validation-plans.mjs';
import { activePrNumber, loadState } from '../state-store.mjs';
import { buildReviewOutcomeTransition } from '../transitions/review.mjs';
import {
  buildCiValidationTransition,
  buildTargetedValidationTransition,
} from '../transitions/validation.mjs';
import { buildTargetedValidationResetTransition } from '../transitions/transactional-evidence.mjs';

const VALIDATION_PLANNING_PHASES = new Set([
  'recovering', 'ready-for-review', 'integrating', 'verifying', 'validating',
]);

class IdempotentTransaction extends Error {
  constructor(state) {
    super('idempotent checkpoint transaction');
    this.state = state;
  }
}

class PlanTransaction extends Error {
  constructor(plan) {
    super('validation plan persisted under checkpoint lock');
    this.plan = plan;
  }
}

function utcNow() { return new Date().toISOString(); }
function selectedPr(cwd, prNumber) {
  const selected = prNumber ?? activePrNumber(cwd);
  if (selected === null || selected === undefined) {
    throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  }
  return selected;
}
function runProtectedTransaction(options) {
  try { return checkpointProtectedStateTransaction(options); } catch (error) {
    if (error instanceof IdempotentTransaction) return error.state;
    throw error;
  }
}

function isV2CompletedTaskValidationRecoveryAuthorized(cwd, state, expectedIds) {
  const evidence = readV2CompletedTaskValidationRecoveryEvidence(cwd, state, expectedIds);
  if (evidence === null) return false;
  let expected = evidence.migrated;
  if (evidence.legacyPhase === 'awaiting-review') {
    if (evidence.migrated.phase !== 'awaiting-review' || state.phase !== 'validating'
        || state.reviewOutcome?.outcome !== 'clean'
        || state.revision !== evidence.migrated.revision + 1) return false;
    try {
      expected = {
        ...buildReviewOutcomeTransition(evidence.migrated, state.reviewOutcome),
        revision: state.revision,
        updatedAt: state.updatedAt,
      };
    } catch {
      return false;
    }
  }
  return JSON.stringify(canonicalJson(expected)) === JSON.stringify(canonicalJson(state));
}

export function buildTargetedValidationPlan({
  cwd = process.cwd(), prNumber, taskPackets, initialSelection, replace = false,
  now = utcNow,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  let current = loadState(cwd, pr);
  if (!current) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  if (!VALIDATION_PLANNING_PHASES.has(current.phase)) {
    throw new StateError(
      `Cannot plan targeted validation while phase is ${current.phase}`,
      'VALIDATION_PLAN_PHASE_BLOCKED',
    );
  }
  if (initialSelection !== undefined && initialSelection !== null
      && current.validationStatus.status === 'passed'
      && (isCleanTasklessReviewValidationRecovery(
        current, actionableIntegratedTaskIds(current),
      ) || isNativeTasklessReviewHeadDriftValidationRecovery(
        current, actionableIntegratedTaskIds(current),
      ) || isNativeTasklessPendingReviewHeadDriftValidationRecovery(
        current, actionableIntegratedTaskIds(current),
      ))) {
    throw new StateError(
      'Taskless review recovery cannot replace existing targeted-validation proof',
      'INITIAL_VALIDATION_NOT_ALLOWED',
    );
  }
  if (current.validationStatus.status !== 'not-run' && !replace) {
    throw new StateError(
      'Targeted validation proof already exists; use --replace to start a fresh plan',
      'VALIDATION_PLAN_REPLACE_REQUIRED',
    );
  }
  if (current.validationStatus.status !== 'not-run') {
    current = checkpointTargetedValidationReset({
      cwd, prNumber: pr, expectedRevision: current.revision,
    });
  }
  try {
    checkpointStateTransaction({
      cwd,
      prNumber: pr,
      expectedRevision: current.revision,
      transaction: (locked) => {
        const initialMode = initialSelection !== undefined && initialSelection !== null;
        const expectedIds = initialMode ? actionableIntegratedTaskIds(locked) : [];
        const completedTaskRecoveryAuthorized = initialMode
          && isV2CompletedTaskValidationRecoveryAuthorized(cwd, locked, expectedIds);
        const plan = buildTargetedValidationPlanUnlocked({
          cwd, prNumber: pr, taskPackets, initialSelection, replace, now,
          completedTaskRecoveryAuthorized,
        });
        throw new PlanTransaction(plan);
      },
    });
  } catch (error) {
    if (error instanceof PlanTransaction) return error.plan;
    throw error;
  }
  throw new StateError('Validation plan transaction did not return a plan', 'INVALID_VALIDATION_PLAN');
}

export function checkpointTargetedValidationReset({
  cwd = process.cwd(), prNumber, expectedRevision,
} = {}) {
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'targeted-validation',
    transaction: (current) => {
      const nextState = buildTargetedValidationResetTransition(current);
      if (nextState === current) throw new IdempotentTransaction(current);
      return {
        nextState,
        event: {
          type: 'targeted-validation-reset',
          summary: 'Reset targeted validation before creating a new plan',
        },
      };
    },
  });
}

export function checkpointTargetedValidation({
  cwd = process.cwd(), prNumber, expectedRevision,
} = {}) {
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'targeted-validation',
    transaction: (current) => {
      assertCleanExactIntegrationHead(current);
      const plan = readValidationPlan(cwd, current);
      const nextState = buildTargetedValidationTransition(current, plan, utcNow());
      return {
        nextState,
        event: {
          type: 'targeted-validation-recorded',
          summary: `Recorded ${nextState.validationStatus.status} targeted validation for ${current.currentIntegrationHeadSha}`,
        },
      };
    },
  });
}

export function executeTargetedValidationPlan({
  cwd = process.cwd(), prNumber,
  runCommand = (argv, commandCwd) => spawnSync(argv[0], argv.slice(1), {
    cwd: commandCwd, stdio: 'inherit', shell: false,
  }),
  now = utcNow,
  onCommandRecorded,
  onProofCheckpointed,
} = {}) {
  const pr = selectedPr(cwd, prNumber);
  let plan;
  const initial = loadState(cwd, pr);
  if (!initial) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
  const checkpointed = runProtectedTransaction({
    cwd,
    prNumber: pr,
    expectedRevision: initial.revision,
    transitionKind: 'targeted-validation',
    transaction: (current) => {
      assertCleanExactIntegrationHead(current);
      plan = readValidationPlan(cwd, current);
      if (JSON.stringify([...plan.taskIds].sort())
          !== JSON.stringify(actionablePacketValidationTaskIds(current))) {
        throw new StateError(
          'Targeted validation plan no longer covers current actionable Integrated or Resolved tasks',
          'VALIDATION_TASK_COVERAGE_MISMATCH',
        );
      }
      plan = executeTargetedValidationFacts({
        cwd, state: current, plan, runCommand, now, onCommandRecorded,
        beforeCommand: (_entry, currentPlan) => {
          const observed = loadState(cwd, current.prNumber);
          assertCleanExactIntegrationHead(observed);
          if (observed.currentIntegrationHeadSha !== currentPlan.headSha
              || observed.revision !== currentPlan.stateRevision) {
            throw new StateError('Targeted validation plan is stale', 'VALIDATION_PLAN_STALE');
          }
          if (JSON.stringify([...currentPlan.taskIds].sort())
              !== JSON.stringify(actionablePacketValidationTaskIds(observed))) {
            throw new StateError(
              'Targeted validation plan no longer covers current actionable Integrated or Resolved tasks',
              'VALIDATION_TASK_COVERAGE_MISMATCH',
            );
          }
        },
      });
      const nextState = buildTargetedValidationTransition(current, plan, utcNow());
      return {
        nextState,
        event: {
          type: 'targeted-validation-recorded',
          summary: `Recorded ${nextState.validationStatus.status} targeted validation for ${current.currentIntegrationHeadSha}`,
        },
      };
    },
  });
  onProofCheckpointed?.(checkpointed, plan);
  return { plan, state: checkpointed };
}

export function checkpointCiValidation({
  cwd = process.cwd(), prNumber, evidence, expectedRevision, event,
} = {}) {
  return runProtectedTransaction({
    cwd, prNumber: selectedPr(cwd, prNumber), expectedRevision,
    transitionKind: 'ci-validation',
    transaction: (current) => {
      const nextState = buildCiValidationTransition(current, evidence);
      if (nextState === current) throw new IdempotentTransaction(current);
      return { nextState, event };
    },
  });
}
