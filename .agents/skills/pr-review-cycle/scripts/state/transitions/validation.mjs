import { parseTargetedValidationCommand, validatePrReviewState } from '../../contracts/contracts.mjs';
import { StateError } from '../errors.mjs';

const VALIDATION_AREAS = new Set([
  'api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration',
]);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function materializeValidationArgv(command, argv, state, headSha) {
  const parsed = parseTargetedValidationCommand(command);
  if (!parsed) return null;
  if (command !== 'git diff --check') {
    return JSON.stringify(argv) === JSON.stringify(parsed) ? [...argv] : null;
  }
  if (!SHA.test(state.baseSha ?? '') || !SHA.test(headSha ?? '')) return null;
  const expected = ['git', 'diff', '--check', state.baseSha, headSha, '--'];
  return JSON.stringify(argv) === JSON.stringify(parsed)
      || JSON.stringify(argv) === JSON.stringify(expected) ? expected : null;
}

function sameEvidence(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function relatedE2EMetadata(argv) {
  if (argv.slice(0, 4).join(' ') !== 'npm run test:e2e:related --') return null;
  const selectors = [];
  const projects = [];
  for (let index = 4; index < argv.length; index += 1) {
    const [option, inlineValue] = argv[index].split('=', 2);
    const value = inlineValue ?? argv[++index];
    if (option === '--project') projects.push(value);
    else if (option === '--id') {
      const normalized = value.replace(/^@/u, '');
      selectors.push(normalized.startsWith('id-') ? normalized : `id-${normalized}`);
    } else if (option === '--tag') selectors.push(value.replace(/^@/u, ''));
  }
  return { selectors, projects: projects.length > 0 ? projects : ['tablet-chromium'] };
}

function validateValidationPlan(plan, state) {
  const errors = [];
  const fields = [
    'schemaVersion', 'prNumber', 'stateRevision', 'headSha', 'taskIds', 'affectedAreas',
    'commands', 'createdAt', 'updatedAt',
  ];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return ['plan must be a JSON object'];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(plan, field)) errors.push(`plan.${field} is required`);
  }
  for (const field of Object.keys(plan)) {
    if (!fields.includes(field)) errors.push(`plan.${field} is not allowed`);
  }
  if (plan.schemaVersion !== 1) errors.push('plan.schemaVersion must be 1');
  if (plan.prNumber !== state.prNumber) errors.push('plan.prNumber must match active state');
  if (plan.stateRevision !== state.revision) errors.push('plan.stateRevision is stale');
  if (plan.headSha !== state.currentIntegrationHeadSha) errors.push('plan.headSha is stale');
  if (!Array.isArray(plan.taskIds)
      || plan.taskIds.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(plan.taskIds).size !== plan.taskIds.length) {
    errors.push('plan.taskIds must be unique nonempty strings');
  }
  if (!Array.isArray(plan.affectedAreas)
      || plan.affectedAreas.some((area) => !VALIDATION_AREAS.has(area))
      || new Set(plan.affectedAreas).size !== plan.affectedAreas.length) {
    errors.push('plan.affectedAreas must be unique strings');
  }
  if (!Array.isArray(plan.commands) || plan.commands.length === 0) {
    errors.push('plan.commands must not be empty');
  } else {
    const seen = new Set();
    for (const [index, entry] of plan.commands.entries()) {
      const prefix = `plan.commands[${index}]`;
      const entryFields = [
        'kind', 'command', 'reason', 'selectors', 'projects', 'argv', 'status', 'exitCode',
        'summary', 'completedAt',
      ];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      for (const field of entryFields) {
        if (!Object.prototype.hasOwnProperty.call(entry, field)) {
          errors.push(`${prefix}.${field} is required`);
        }
      }
      for (const field of Object.keys(entry)) {
        if (!entryFields.includes(field)) errors.push(`${prefix}.${field} is not allowed`);
      }
      const executionArgv = materializeValidationArgv(entry.command, entry.argv, state, plan.headSha);
      if (!executionArgv) {
        errors.push(`${prefix} is not a supported exact command`);
      }
      if (!['unit', 'system'].includes(entry.kind)) errors.push(`${prefix}.kind is invalid`);
      if (typeof entry.reason !== 'string' || entry.reason.length < 1
          || entry.reason.length > 1000) errors.push(`${prefix}.reason is invalid`);
      for (const field of ['selectors', 'projects']) {
        if (!Array.isArray(entry[field])
            || entry[field].some((item) => typeof item !== 'string')
            || new Set(entry[field]).size !== entry[field].length) {
          errors.push(`${prefix}.${field} is invalid`);
        }
      }
      const e2eMetadata = executionArgv ? relatedE2EMetadata(executionArgv) : null;
      if (entry.kind === 'unit'
          && (entry.selectors?.length > 0 || entry.projects?.length > 0)) {
        errors.push(`${prefix} unit metadata must be empty`);
      }
      if (entry.kind === 'system' && e2eMetadata === null
          && (entry.selectors?.length > 0 || entry.projects?.length > 0)) {
        errors.push(`${prefix} non-E2E metadata must be empty`);
      }
      if (entry.kind === 'system' && e2eMetadata !== null
          && (JSON.stringify(entry.selectors) !== JSON.stringify(e2eMetadata.selectors)
            || JSON.stringify(entry.projects) !== JSON.stringify(e2eMetadata.projects))) {
        errors.push(`${prefix} E2E metadata must match command scope`);
      }
      if (seen.has(entry.command)) errors.push(`${prefix}.command is duplicated`);
      seen.add(entry.command);
      if (!['pending', 'passed', 'failed'].includes(entry.status)) {
        errors.push(`${prefix}.status is invalid`);
      }
      if (entry.status === 'pending') {
        if (entry.exitCode !== null || entry.summary !== null || entry.completedAt !== null) {
          errors.push(`${prefix} pending result must be empty`);
        }
      } else {
        if (!Number.isInteger(entry.exitCode) || entry.exitCode < 0) {
          errors.push(`${prefix}.exitCode is invalid`);
        }
        if (typeof entry.summary !== 'string' || entry.summary.length < 1
            || entry.summary.length > 500) errors.push(`${prefix}.summary is invalid`);
        if (typeof entry.completedAt !== 'string'
            || !Number.isFinite(Date.parse(entry.completedAt))) {
          errors.push(`${prefix}.completedAt is invalid`);
        }
        if ((entry.status === 'passed') !== (entry.exitCode === 0)) {
          errors.push(`${prefix}.status contradicts exitCode`);
        }
      }
    }
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof plan[field] !== 'string' || !Number.isFinite(Date.parse(plan[field]))) {
      errors.push(`plan.${field} is invalid`);
    }
  }
  return errors;
}

function actionablePacketValidationTaskIds(state) {
  return state.tasks.filter((task) => task.disposition === 'actionable'
    && (task.status === 'integrated'
      || (task.status === 'completed' && typeof task.taskPacketDigest === 'string')))
    .map((task) => task.id).sort();
}

export function buildTargetedValidationTransition(state, plan, timestamp) {
  const errors = validateValidationPlan(plan, state);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid targeted validation plan:\n- ${errors.join('\n- ')}`,
      'INVALID_VALIDATION_PLAN',
    );
  }
  if (plan.commands.some((entry) => entry.status === 'pending')) {
    throw new StateError(
      'Targeted validation plan still has pending commands',
      'VALIDATION_PLAN_INCOMPLETE',
    );
  }
  if (JSON.stringify([...plan.taskIds].sort())
      !== JSON.stringify(actionablePacketValidationTaskIds(state))) {
    throw new StateError(
      'Targeted validation plan no longer covers current actionable Integrated or Resolved tasks',
      'VALIDATION_TASK_COVERAGE_MISMATCH',
    );
  }
  const status = plan.commands.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
  const next = {
    ...state,
    validationStatus: {
      source: 'orchestrator', scope: 'targeted', status, headSha: plan.headSha,
      checks: plan.commands.map((entry) => entry.command), updatedAt: timestamp,
    },
    nextAction: status === 'passed'
      ? state.nextAction
      : 'Fix the failed targeted check, rebuild the validation plan, and run it again.',
  };
  const stateErrors = validatePrReviewState(next);
  if (stateErrors.length > 0) {
    throw new StateError(
      `Invalid targeted validation transition:\n- ${stateErrors.join('\n- ')}`,
      'INVALID_TARGETED_VALIDATION',
    );
  }
  return next;
}

export function buildCiValidationTransition(state, evidence) {
  if (evidence?.source !== 'github-actions' || evidence?.scope !== 'full'
      || !['passed', 'failed'].includes(evidence?.status)
      || typeof evidence?.checkRunId !== 'string' || evidence.checkRunId.length === 0
      || evidence?.headSha !== state.currentIntegrationHeadSha) {
    throw new StateError(
      'CI evidence must be full GitHub Actions validation for the current integration HEAD',
      'INVALID_CI_VALIDATION',
    );
  }
  const existing = state.ciValidationHistory.find(
    (entry) => entry.checkRunId === evidence.checkRunId,
  );
  if (existing && !sameEvidence(existing, evidence)) {
    throw new StateError(
      'GitHub Actions check run ID was reused with different evidence',
      'CI_EVIDENCE_CONFLICT',
    );
  }
  if (existing && sameEvidence(state.ciValidationStatus, evidence)) return state;
  const next = {
    ...state,
    ciValidationStatus: evidence,
    ciValidationHistory: existing ? state.ciValidationHistory : [...state.ciValidationHistory, evidence],
    nextAction: evidence.status === 'passed'
      ? state.nextAction
      : 'Inspect the failed full GitHub Actions run, then record a new run for the same review commit.',
  };
  const errors = validatePrReviewState(next);
  if (errors.length > 0) {
    throw new StateError(
      `Invalid CI validation transition:\n- ${errors.join('\n- ')}`,
      'INVALID_CI_VALIDATION',
    );
  }
  return next;
}
