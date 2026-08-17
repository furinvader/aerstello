#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { readTreeFile } from '../../../../../scripts/lib/git.mjs';
import { planReadiness, validateImplementationPlan } from '../contracts/contracts.mjs';
import {
  acceptPlan,
  amendPlan,
  archiveState,
  initializeState,
  loadLatestSourceObservation,
  loadState,
  locateState,
  recordDecision,
  recoverState,
  refreshSource,
  renderStatus,
  repositoryRoot,
  StateError,
  validatePlanStateIdentity,
  validateState,
} from './state.mjs';

const COMMANDS = new Set([
  'init', 'path', 'show', 'validate', 'refresh-source', 'accept-plan',
  'record-decision', 'amend-plan', 'recover', 'archive', 'status',
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
  record-decision   Append an authorized decision record
  amend-plan        Append an amendment containing the complete resulting plan
  recover           Finish one exact matching interrupted transition
  archive           Archive completed plan-only or explicitly abandoned state
  status            Print bounded human-readable status

Init options:
  --change-id <id> --mode <plan-only|implement|full>
  --base-branch <branch> --planning-ref <commit> --source <descriptor.json>
  [--expected-pr-base-branch <branch>]

Transition options:
  --change-id <id> --expected-revision <number>
  accept-plan: --plan <plan.json> [--planning-evidence <evidence.json>]
  record-decision: --decision <decision.json>
  amend-plan: --amendment <amendment.json> --plan <resulting-plan.json>
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
    booleans: ['help', 'human'],
    values: [
      'change-id', 'mode', 'base-branch', 'expected-pr-base-branch', 'planning-ref',
      'source', 'expected-revision', 'plan', 'planning-evidence', 'decision',
      'amendment', 'abandon-reason',
    ],
  });
}

const COMMAND_OPTIONS = Object.freeze({
  init: ['change-id', 'mode', 'base-branch', 'expected-pr-base-branch', 'planning-ref', 'source'],
  path: ['change-id'], show: ['change-id'],
  validate: ['change-id', 'plan', 'planning-evidence'],
  'refresh-source': ['change-id', 'expected-revision'],
  'accept-plan': ['change-id', 'expected-revision', 'plan', 'planning-evidence'],
  'record-decision': ['change-id', 'expected-revision', 'decision'],
  'amend-plan': ['change-id', 'expected-revision', 'amendment', 'plan', 'planning-evidence'],
  recover: ['change-id'], archive: ['change-id', 'expected-revision', 'abandon-reason'],
  status: ['change-id', 'human'],
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
      const active = loadState(process.cwd(), parsed['change-id']);
      const sourceObservation = active ? loadLatestSourceObservation(process.cwd(), active.changeId) : undefined;
      const root = repositoryRoot(process.cwd());
      const readPlanningFile = ({ planningSha, path }) => readTreeFile(root, planningSha, path);
      const contractErrors = validateImplementationPlan(plan, { planningEvidence, sourceObservation, readPlanningFile });
      const identityErrors = active ? validatePlanStateIdentity(plan, active) : [];
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
      planningEvidence: parsed['planning-evidence'] ? json(parsed['planning-evidence'], '--planning-evidence') : [],
    }));
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
  } else {
    process.stdout.write(`${renderStatus(common)}\n`);
  }
} catch (error) {
  const code = error instanceof StateError ? error.code : error instanceof UsageError ? 'USAGE' : 'CHANGE_STATE_ERROR';
  process.stderr.write(`${code}: ${error.message}\n`);
  if (error instanceof UsageError) process.stderr.write(`\n${usage()}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
