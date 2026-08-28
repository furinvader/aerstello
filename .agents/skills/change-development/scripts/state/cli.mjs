#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { readTreeFile } from '../../../../../scripts/lib/git.mjs';
import { planReadiness, validateImplementationPlan } from '../contracts/contracts.mjs';
import {
  acceptPlan,
  adoptScope,
  assessScope,
  acceptResult,
  authorizeRepeatedFinding,
  amendPlan,
  archiveState,
  bindTask,
  buildVerifierContext,
  createSpecialistPlan,
  createValidationPlan,
  initializeState,
  integrateTask,
  finalizeIntegration,
  finalizeDevelopment,
  loadLatestSourceObservation,
  loadState,
  locateState,
  recordDecision,
  recordScopeDecision,
  recordFindingDisposition,
  recordSpecialistResult,
  recordVerifierResult,
  reconcileIntegration,
  rejectTask,
  recoverState,
  resumeScopeReturn,
  refreshSource,
  renderStatus,
  repositoryRoot,
  StateError,
  validatePlanStateIdentity,
  validateState,
  scheduleWave,
  startTask,
  runValidation,
  upgradeState,
} from './state.mjs';

const COMMANDS = new Set([
  'init', 'path', 'show', 'validate', 'refresh-source', 'accept-plan',
  'adopt-scope', 'assess-scope', 'record-scope-decision', 'resume-scope-return',
  'record-decision', 'amend-plan', 'recover', 'archive', 'status',
  'upgrade-state', 'bind-task', 'schedule-wave', 'start-task', 'accept-result',
  'integrate-task', 'reconcile-integration',
  'finalize-integration',
  'validation-plan', 'run-validation', 'specialist-plan', 'specialist-record',
  'verifier-context', 'verifier-record', 'finding-authorize', 'finding-disposition', 'finalize-development',
  'reject-task',
]);

function usage() {
  return `Usage: npm run change:state -- <command> [options]

Commands:
  init              Capture one source and create durable planning state
  path              Print the active state path
  show              Print active state JSON
  validate          Verify state, receipts, transitions, plan, and Git observation
  refresh-source    Refresh the configured source without holding a state lock
  accept-plan       Accept an immutable normalized plan
  adopt-scope       Append exact scope authority to one unfinished legacy accepted plan
  assess-scope      Record exact task or integrated-HEAD canonical scope evidence
  record-scope-decision  Record one exact append-only human scope disposition
  resume-scope-return   Resume at one exact guarded PR-review scope-return HEAD
  record-decision   Append an authorized decision record
  amend-plan        Append an amendment containing the complete resulting plan
  recover           Finish one exact matching interrupted transition
  archive           Archive completed plan-only or explicitly abandoned state
  status            Print bounded human-readable status
  upgrade-state     Receipt-protect the explicit v1 to v2 execution-state upgrade
  bind-task         Bind one immutable task packet to the effective plan and clean base
  schedule-wave     Schedule up to three dependency-ready non-conflicting tasks
  start-task        Record one scheduled task attempt as running
  accept-result     Cross-check and preserve one structured worker result
  integrate-task    Persist intent, cherry-pick, and reconcile one accepted task
  reconcile-integration  Reconcile an interrupted persisted integration intent
  finalize-integration   Prove all worker worktrees removed and enter integrated
  validation-plan       Persist an immutable exact-HEAD targeted validation plan
  run-validation        Resume direct execution of pending validation argv
  specialist-plan       Derive routed reviewers from immutable stored packet routes
  specialist-record     Record one exact-HEAD routed specialist result
  verifier-context      Print deterministic bounded final-verifier context
  verifier-record       Record one exact-context final-verifier result
  finding-authorize     Receipt-protect human authorization for a repeated finding
  finding-disposition   Append a source-role-qualified finding disposition
  finalize-development  Prove all exact-HEAD local gates and enter development-ready
  reject-task       Durably reject packet-bound work before cleanup and replan

Init options:
  --change-id <id> --mode <plan-only|implement|full>
  --base-branch <branch> --planning-ref <commit> --source <descriptor.json>
  [--expected-pr-base-branch <branch>]

Transition options:
  --change-id <id> --expected-revision <number>
  accept-plan: --plan <plan.json> --minimal-closure <closure.json>
               --scope-evidence <evidence.json> [--planning-evidence <evidence.json>]
  adopt-scope: --minimal-closure <closure.json> --scope-evidence <evidence.json>
  assess-scope: --scope-evidence <evidence.json>
  record-scope-decision: --decision <decision.json>
  resume-scope-return: --input <scope-return.json>
  record-decision: --decision <decision.json>
  amend-plan: --amendment <amendment.json> --plan <resulting-plan.json>
              --minimal-closure <closure.json>
              [--planning-evidence <evidence.json>]
  archive: [--abandon-reason <reason>]
`;
}

function json(path, label) {
  if (!path) throw new UsageError(`${label} is required`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new StateError(`Unable to read ${label}: ${error.message}`, 'INVALID_JSON_INPUT'); }
}

function parseRevision(value, required = false) {
  if (value === undefined && !required) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError('--expected-revision must be a non-negative integer');
  return parsed;
}

function options(argv) {
  return parseOptions(argv, {
    booleans: ['help', 'human', 'replace'],
    values: [
      'change-id', 'mode', 'base-branch', 'expected-pr-base-branch', 'planning-ref',
      'source', 'expected-revision', 'plan', 'planning-evidence', 'decision',
      'minimal-closure', 'scope-evidence', 'amendment', 'abandon-reason', 'packet', 'result', 'input', 'task-id', 'worker-id', 'worker-cwd', 'reason',
    ],
  });
}

const COMMAND_OPTIONS = Object.freeze({
  init: ['change-id', 'mode', 'base-branch', 'expected-pr-base-branch', 'planning-ref', 'source'],
  path: ['change-id'], show: ['change-id'],
  validate: ['change-id', 'plan', 'planning-evidence'],
  'refresh-source': ['change-id', 'expected-revision'],
  'accept-plan': ['change-id', 'expected-revision', 'plan', 'planning-evidence', 'minimal-closure', 'scope-evidence'],
  'adopt-scope': ['change-id', 'expected-revision', 'minimal-closure', 'scope-evidence'],
  'assess-scope': ['change-id', 'expected-revision', 'scope-evidence'],
  'record-scope-decision': ['change-id', 'expected-revision', 'decision'],
  'resume-scope-return': ['change-id', 'expected-revision', 'input'],
  'record-decision': ['change-id', 'expected-revision', 'decision'],
  'amend-plan': ['change-id', 'expected-revision', 'amendment', 'plan', 'planning-evidence', 'minimal-closure'],
  recover: ['change-id'], archive: ['change-id', 'expected-revision', 'abandon-reason'],
  status: ['change-id', 'human'],
  'upgrade-state': ['change-id', 'expected-revision'],
  'bind-task': ['change-id', 'expected-revision', 'packet'],
  'schedule-wave': ['change-id', 'expected-revision'],
  'start-task': ['change-id', 'expected-revision', 'task-id', 'worker-id'],
  'accept-result': ['change-id', 'expected-revision', 'result', 'worker-cwd'],
  'integrate-task': ['change-id', 'expected-revision', 'task-id'],
  'reconcile-integration': ['change-id', 'expected-revision'],
  'finalize-integration': ['change-id', 'expected-revision'],
  'validation-plan': ['change-id', 'expected-revision', 'replace'],
  'run-validation': ['change-id', 'expected-revision'],
  'specialist-plan': ['change-id', 'expected-revision'],
  'specialist-record': ['change-id', 'expected-revision', 'input'],
  'verifier-context': ['change-id'],
  'verifier-record': ['change-id', 'expected-revision', 'input'],
  'finding-authorize': ['change-id', 'expected-revision', 'input'],
  'finding-disposition': ['change-id', 'expected-revision', 'input'],
  'finalize-development': ['change-id', 'expected-revision'],
  'reject-task': ['change-id', 'expected-revision', 'task-id', 'reason'],
});

function assertCommandOptions(command, parsed) {
  const allowed = new Set(['_', 'help', ...COMMAND_OPTIONS[command]]);
  const irrelevant = Object.keys(parsed).filter((key) => parsed[key] !== undefined && !allowed.has(key));
  if (irrelevant.length > 0) throw new UsageError(`${command} does not accept --${irrelevant[0]}`);
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!COMMANDS.has(command)) throw new UsageError(`Unknown command ${command}`);
  const parsed = options(argv);
  assertCommandOptions(command, parsed);
  if (parsed.help) { process.stdout.write(usage()); process.exit(0); }
  if (parsed._.length > 0) throw new UsageError(`Unexpected argument ${parsed._[0]}`);
  const common = { cwd: process.cwd(), changeId: parsed['change-id'] };

  if (command === 'init') {
    for (const name of ['change-id', 'mode', 'base-branch', 'planning-ref', 'source']) {
      if (!parsed[name]) throw new UsageError(`init requires --${name}`);
    }
    writeJson(await initializeState({
      ...common,
      mode: parsed.mode,
      baseBranch: parsed['base-branch'],
      expectedPrBaseBranch: parsed['expected-pr-base-branch'],
      planningRef: parsed['planning-ref'],
      source: json(parsed.source, '--source'),
    }));
  } else if (command === 'path') {
    const located = locateState(process.cwd(), parsed['change-id']);
    if (!located) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    process.stdout.write(`${located.path}\n`);
  } else if (command === 'show') {
    const state = loadState(process.cwd(), parsed['change-id']);
    if (!state) throw new StateError('No active change state', 'STATE_NOT_FOUND');
    writeJson(state);
  } else if (command === 'validate') {
    if (parsed.plan) {
      const plan = json(parsed.plan, '--plan');
      const planningEvidence = parsed['planning-evidence'] ? json(parsed['planning-evidence'], '--planning-evidence') : [];
      const located = locateState(process.cwd(), parsed['change-id']);
      const active = located ? validateState(common).state : null;
      const sourceObservation = active ? loadLatestSourceObservation(process.cwd(), active.changeId) : undefined;
      const root = repositoryRoot(process.cwd());
      const readPlanningFile = ({ planningSha, path }) => readTreeFile(root, planningSha, path);
      const contractErrors = validateImplementationPlan(plan, { planningEvidence, sourceObservation, readPlanningFile });
      const identityErrors = validatePlanStateIdentity(plan, active);
      const errors = [...new Set([...contractErrors, ...identityErrors])];
      const candidateReadiness = planReadiness(plan, { planningEvidence, sourceObservation, readPlanningFile });
      const readiness = identityErrors.length === 0 ? candidateReadiness : {
        ...candidateReadiness,
        ready: false,
        errors: [...new Set([...(candidateReadiness.errors ?? []), ...identityErrors])],
      };
      writeJson({
        valid: errors.length === 0,
        errors,
        readiness,
        activeState: active ? { changeId: active.changeId, revision: active.revision, planningSha: active.planningSha } : null,
      });
      if (errors.length > 0 || !readiness.ready) process.exitCode = 1;
    } else writeJson(validateState(common));
  } else if (command === 'refresh-source') {
    writeJson(await refreshSource({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'accept-plan') {
    writeJson(acceptPlan({
      ...common,
      expectedRevision: parseRevision(parsed['expected-revision'], true),
      plan: json(parsed.plan, '--plan'),
      minimalClosure: json(parsed['minimal-closure'], '--minimal-closure'),
      scopeEvidence: json(parsed['scope-evidence'], '--scope-evidence'),
      planningEvidence: parsed['planning-evidence'] ? json(parsed['planning-evidence'], '--planning-evidence') : [],
    }));
  } else if (command === 'adopt-scope') {
    writeJson(adoptScope({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true),
      minimalClosure: json(parsed['minimal-closure'], '--minimal-closure'),
      scopeEvidence: json(parsed['scope-evidence'], '--scope-evidence') }));
  } else if (command === 'assess-scope') {
    writeJson(assessScope({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true),
      scopeEvidence: json(parsed['scope-evidence'], '--scope-evidence') }));
  } else if (command === 'record-scope-decision') {
    writeJson(recordScopeDecision({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true),
      decision: json(parsed.decision, '--decision') }));
  } else if (command === 'resume-scope-return') {
    writeJson(resumeScopeReturn({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true),
      scopeReturn: json(parsed.input, '--input') }));
  } else if (command === 'record-decision') {
    writeJson(recordDecision({
      ...common,
      expectedRevision: parseRevision(parsed['expected-revision'], true),
      decision: json(parsed.decision, '--decision'),
    }));
  } else if (command === 'amend-plan') {
    writeJson(amendPlan({
      ...common,
      expectedRevision: parseRevision(parsed['expected-revision'], true),
      amendment: json(parsed.amendment, '--amendment'),
      resultingPlan: json(parsed.plan, '--plan'),
      minimalClosure: json(parsed['minimal-closure'], '--minimal-closure'),
      planningEvidence: parsed['planning-evidence'] ? json(parsed['planning-evidence'], '--planning-evidence') : [],
    }));
  } else if (command === 'recover') {
    writeJson(recoverState(common));
  } else if (command === 'archive') {
    writeJson(archiveState({
      ...common,
      expectedRevision: parseRevision(parsed['expected-revision'], true),
      abandonReason: parsed['abandon-reason'],
    }));
  } else if (command === 'upgrade-state') {
    writeJson(upgradeState({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'bind-task') {
    writeJson(bindTask({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), packet: json(parsed.packet, '--packet') }));
  } else if (command === 'schedule-wave') {
    writeJson(scheduleWave({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'start-task') {
    if (!parsed['task-id'] || !parsed['worker-id']) throw new UsageError('start-task requires --task-id and --worker-id');
    writeJson(startTask({ ...common, taskId: parsed['task-id'], workerId: parsed['worker-id'], expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'accept-result') {
    writeJson(acceptResult({ ...common, result: json(parsed.result, '--result'), workerCwd: parsed['worker-cwd'], expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'integrate-task') {
    if (!parsed['task-id']) throw new UsageError('integrate-task requires --task-id');
    writeJson(integrateTask({ ...common, taskId: parsed['task-id'], expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'reconcile-integration') {
    writeJson(reconcileIntegration({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'finalize-integration') {
    writeJson(finalizeIntegration({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'validation-plan') {
    writeJson(createValidationPlan({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), replace: parsed.replace === true }));
  } else if (command === 'run-validation') {
    writeJson(runValidation({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'specialist-plan') {
    writeJson(createSpecialistPlan({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'specialist-record') {
    writeJson(recordSpecialistResult({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), result: json(parsed.input, '--input') }));
  } else if (command === 'verifier-context') {
    writeJson(buildVerifierContext(common));
  } else if (command === 'verifier-record') {
    writeJson(recordVerifierResult({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), result: json(parsed.input, '--input') }));
  } else if (command === 'finding-authorize') {
    writeJson(authorizeRepeatedFinding({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), authorization: json(parsed.input, '--input') }));
  } else if (command === 'finding-disposition') {
    writeJson(recordFindingDisposition({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true), disposition: json(parsed.input, '--input') }));
  } else if (command === 'finalize-development') {
    writeJson(await finalizeDevelopment({ ...common, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else if (command === 'reject-task') {
    if (!parsed['task-id'] || !parsed.reason) throw new UsageError('reject-task requires --task-id and --reason');
    writeJson(rejectTask({ ...common, taskId: parsed['task-id'], reason: parsed.reason, expectedRevision: parseRevision(parsed['expected-revision'], true) }));
  } else {
    process.stdout.write(`${renderStatus(common)}\n`);
  }
} catch (error) {
  const code = error instanceof StateError ? error.code : error instanceof UsageError ? 'USAGE' : 'CHANGE_STATE_ERROR';
  process.stderr.write(`${code}: ${error.message}\n`);
  if (error instanceof UsageError) process.stderr.write(`\n${usage()}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
