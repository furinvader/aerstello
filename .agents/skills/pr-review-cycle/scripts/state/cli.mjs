#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import {
  validateTaskPacket,
  validateWorkerResult,
  validateWorkerResultAgainstTask,
} from '../contracts/contracts.mjs';
import {
  archiveState,
  assertTaskPacketBound,
  buildTargetedValidationPlan,
  checkpointState,
  checkpointReviewRequestLimit,
  checkpointTaskPacketBinding,
  checkpointTaskPacketReplan,
  checkpointWorkerResultAcceptance,
  checkpointWorkerResultBackfill,
  executeTargetedValidationPlan,
  initializeState,
  loadState,
  locateState,
  migrateState,
  reconcileState,
  renderRecoverySummary,
  planSpecialists,
  recordSpecialistReview,
  specialistContext,
  StateError,
} from './state.mjs';

function usage() {
  return `Usage: node .agents/skills/pr-review-cycle/scripts/state/cli.mjs <command> [options]

Commands:
  init                Start durable state for a PR review cycle
  path                Print the active state path
  validate            Check state and durable evidence against the integration checkout
  specialist-plan     Save a guarded pre-bind or post-integration routing plan
  specialist-record   Append one concise exact-plan specialist result
  specialist-context  Print fail-closed exact-HEAD verifier context (read-only)
  bind-task-packet    Bind accepted fixed instructions to a durable task
  replan-task-packet  Clear one proven migration-origin schema-v2 task binding
  validate-result     Check a worker result against its bound fixed instructions
  accept-result       Persist a validated worker result before integration
  backfill-result     Explicitly bind original result evidence to native v3 Integrated work
  validation-plan     Save and print the combined targeted checks from packet sidecars
  run-validation      Run pending checks from the saved plan and record the result
  show                Print active state JSON
  checkpoint          Replace ordinary operational state from --input
  set-review-limit    Set a positive durable request limit or restore unlimited reviews
  migrate             Explicitly migrate active schema v1 or v2 state to v3
  recover             Print compact recovery context
  archive             Archive a Done or explicitly abandoned cycle

Common options:
  --pr <number>
  --help

Specialist-plan and specialist-record options:
  --input <file>
  --expected-revision <number>

Bind-task-packet options:
  --task-packet <file>
  --expected-revision <number>

Replan-task-packet options:
  --task <opaque-id>
  --expected-revision <number>

Validation-plan options:
  --initial-selection <file>     Explicit pristine, clean-taskless, or proven v2 completed-task recovery selection
  --replace                      Start a fresh plan after a failure or commit change

Validate-result options:
  --task-packet <file>
  --worker-result <file>

Accept-result and backfill-result options:
  --task-packet <file>
  --worker-result <file>
  --expected-revision <number>

Checkpoint options:
  --expected-revision <number>

Init options:
  --review-limit <number>       Optional positive safe-integer limit; omitted means unlimited

Set-review-limit options:
  --expected-revision <number>
  --limit <number>              Positive safe-integer total durable request limit
  --unlimited                   Remove the configured request-count limit

Migrate options:
  --integration-map <file>  JSON task-ID to central integration SHA map (v1 only)

Archive options:
  --abandon-reason <reason>

Review, CI, task-resolution, targeted-validation, specialist-evidence, and Done transitions use guarded helpers that verify their evidence before saving.
`;
}

function optionsFor(command, argv) {
  const common = { booleans: ['help'], values: ['pr', 'expected-revision'] };
  if (command === 'init') {
    common.values.push('repository', 'base', 'head', 'release-ref', 'session-id', 'review-limit');
  } else if (command === 'set-review-limit') {
    common.booleans.push('unlimited');
    common.values.push('limit');
  } else if (command === 'checkpoint') {
    common.values.push('input', 'event-type', 'event-summary');
  } else if (command === 'migrate') {
    common.values.push('integration-map');
  } else if (['bind-task-packet', 'validate-result', 'accept-result', 'backfill-result'].includes(command)) {
    common.values.push('task-packet', 'worker-result');
  } else if (command === 'replan-task-packet') {
    common.values.push('task');
  } else if (command === 'validation-plan') {
    common.booleans.push('replace');
    common.values.push('initial-selection');
  } else if (command === 'archive') {
    common.values.push('abandon-reason');
  } else if (['specialist-plan', 'specialist-record'].includes(command)) {
    common.values.push('input');
  }
  return parseOptions(argv, common);
}

function positiveSafeInteger(value, option) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) {
    throw new UsageError(`${option} must be a positive safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`${option} must not exceed ${Number.MAX_SAFE_INTEGER}`);
  }
  return parsed;
}

function actualWorkerChangedPaths(packet, result) {
  if (result.status !== 'implemented') return undefined;
  for (const [label, sha] of [['reviewed HEAD', packet.reviewedHeadSha], ['worker commit', result.commitSha]]) {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' });
    } catch {
      throw new StateError(`${label} does not name an existing Git commit: ${sha}`, 'INVALID_WORKER_RESULT');
    }
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', packet.reviewedHeadSha, result.commitSha], {
      cwd: process.cwd(), stdio: 'ignore',
    });
  } catch {
    throw new StateError('Worker commit must descend from the task packet reviewedHeadSha', 'INVALID_WORKER_RESULT');
  }
  const output = execFileSync('git', [
    'diff', '--name-only', '--no-renames', '-z', packet.reviewedHeadSha, result.commitSha, '--',
  ], { cwd: process.cwd() });
  return output.toString('utf8').split('\0').filter((path) => path !== '');
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!['init', 'path', 'validate', 'specialist-plan', 'specialist-record', 'specialist-context', 'bind-task-packet', 'replan-task-packet', 'validate-result', 'accept-result', 'backfill-result', 'validation-plan', 'run-validation', 'show', 'checkpoint', 'set-review-limit', 'migrate', 'recover', 'archive'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = optionsFor(command, argv);
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const parsedExpectedRevision = options['expected-revision'] === undefined
    ? undefined
    : Number(options['expected-revision']);
  if (parsedExpectedRevision !== undefined
      && (!Number.isInteger(parsedExpectedRevision) || parsedExpectedRevision < 0)) {
    throw new UsageError('--expected-revision must be a non-negative integer');
  }

  if (command === 'init') {
    if (!options.pr) throw new UsageError('init requires --pr');
    const reviewRequestLimit = options['review-limit'] === undefined
      ? null : positiveSafeInteger(options['review-limit'], '--review-limit');
    const state = initializeState({
      prNumber: options.pr,
      repository: options.repository,
      base: options.base ?? 'origin/main',
      head: options.head ?? 'HEAD',
      releaseRef: options['release-ref'] ?? 'origin/main',
      orchestratorSessionId: options['session-id'] ?? null,
      reviewRequestLimit,
    });
    writeJson(state);
  } else if (command === 'path') {
    const located = locateState(process.cwd(), options.pr);
    if (!located) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    process.stdout.write(`${located.path}\n`);
  } else if (command === 'validate') {
    const result = reconcileState({ prNumber: options.pr });
    if (!result.state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    if (result.evidenceErrors.length > 0) {
      throw new StateError(`Durable recovery evidence is invalid:\n- ${result.evidenceErrors.join('\n- ')}`, 'RECOVERY_EVIDENCE_INVALID');
    }
    writeJson({ valid: true, ...result });
  } else if (command === 'specialist-plan') {
    if (!options.input) throw new UsageError('specialist-plan requires --input');
    if (parsedExpectedRevision === undefined) throw new UsageError('specialist-plan requires --expected-revision');
    writeJson(planSpecialists({
      prNumber: options.pr,
      input: JSON.parse(readFileSync(options.input, 'utf8')),
      expectedRevision: parsedExpectedRevision,
    }));
  } else if (command === 'specialist-record') {
    if (!options.input) throw new UsageError('specialist-record requires --input');
    if (parsedExpectedRevision === undefined) throw new UsageError('specialist-record requires --expected-revision');
    writeJson(recordSpecialistReview({
      prNumber: options.pr,
      input: JSON.parse(readFileSync(options.input, 'utf8')),
      expectedRevision: parsedExpectedRevision,
    }));
  } else if (command === 'specialist-context') {
    const context = specialistContext({ prNumber: options.pr });
    writeJson(context);
    if (!context.readyForIntegrationVerifier) process.exitCode = 1;
  } else if (command === 'show') {
    const state = loadState(process.cwd(), options.pr);
    if (!state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    writeJson(state);
  } else if (command === 'bind-task-packet') {
    if (!options['task-packet']) throw new UsageError('bind-task-packet requires --task-packet');
    const packet = JSON.parse(readFileSync(options['task-packet'], 'utf8'));
    writeJson(checkpointTaskPacketBinding({
      prNumber: options.pr, packet, expectedRevision: parsedExpectedRevision,
    }));
  } else if (command === 'replan-task-packet') {
    if (options.task === undefined || options.task.length === 0) {
      throw new UsageError('replan-task-packet requires --task');
    }
    if (parsedExpectedRevision === undefined) {
      throw new UsageError('replan-task-packet requires --expected-revision');
    }
    writeJson(checkpointTaskPacketReplan({
      prNumber: options.pr, taskId: options.task, expectedRevision: parsedExpectedRevision,
    }));
  } else if (command === 'validate-result') {
    if (!options['task-packet'] || !options['worker-result']) {
      throw new UsageError('validate-result requires --task-packet and --worker-result');
    }
    const packet = JSON.parse(readFileSync(options['task-packet'], 'utf8'));
    const result = JSON.parse(readFileSync(options['worker-result'], 'utf8'));
    const structuralErrors = [
      ...validateTaskPacket(packet).map((error) => `task packet: ${error}`),
      ...validateWorkerResult(result).map((error) => `worker result: ${error}`),
    ];
    if (structuralErrors.length > 0) {
      throw new StateError(`Worker result does not satisfy task packet:\n- ${structuralErrors.join('\n- ')}`, 'INVALID_WORKER_RESULT');
    }
    const active = loadState(process.cwd(), options.pr);
    if (!active) throw new StateError('No active PR state for worker-result acceptance', 'STATE_NOT_FOUND');
    assertTaskPacketBound(active, packet);
    const errors = validateWorkerResultAgainstTask(packet, result, actualWorkerChangedPaths(packet, result));
    if (errors.length > 0) throw new StateError(`Worker result does not satisfy task packet:\n- ${errors.join('\n- ')}`, 'INVALID_WORKER_RESULT');
    writeJson({ valid: true, taskId: packet.taskId });
  } else if (['accept-result', 'backfill-result'].includes(command)) {
    if (!options['task-packet'] || !options['worker-result']) {
      throw new UsageError(`${command} requires --task-packet and --worker-result`);
    }
    if (parsedExpectedRevision === undefined) throw new UsageError(`${command} requires --expected-revision`);
    const packet = JSON.parse(readFileSync(options['task-packet'], 'utf8'));
    const result = JSON.parse(readFileSync(options['worker-result'], 'utf8'));
    const transition = command === 'accept-result'
      ? checkpointWorkerResultAcceptance : checkpointWorkerResultBackfill;
    const state = transition({
      prNumber: options.pr, packet, result, expectedRevision: parsedExpectedRevision,
    });
    writeJson({
      accepted: true, backfilled: command === 'backfill-result', taskId: packet.taskId,
      resultDigest: state.tasks.find((task) => task.id === packet.taskId)?.workerResultDigest,
      revision: state.revision,
    });
  } else if (command === 'validation-plan') {
    if (options['initial-selection'] && options._.length > 0) {
      throw new UsageError('--initial-selection cannot be combined with task-packet files');
    }
    const initialSelection = options['initial-selection']
      ? JSON.parse(readFileSync(options['initial-selection'], 'utf8'))
      : undefined;
    writeJson(buildTargetedValidationPlan({
      prNumber: options.pr, initialSelection, replace: options.replace === true,
    }));
  } else if (command === 'run-validation') {
    const result = executeTargetedValidationPlan({ prNumber: options.pr });
    writeJson({
      status: result.state.validationStatus.status,
      headSha: result.state.validationStatus.headSha,
      checks: result.plan.commands.map(({ command: exactCommand, status, exitCode, summary }) => ({
        command: exactCommand, status, exitCode, summary,
      })),
    });
    if (result.state.validationStatus.status === 'failed') process.exitCode = 1;
  } else if (command === 'checkpoint') {
    if (!options.input) throw new UsageError('checkpoint requires --input');
    const nextState = JSON.parse(readFileSync(options.input, 'utf8'));
    const expectedRevision = parsedExpectedRevision ?? nextState.revision;
    const event = options['event-type'] || options['event-summary']
      ? {
          type: options['event-type'] ?? 'checkpoint',
          summary: options['event-summary'] ?? 'Updated active PR state',
        }
      : undefined;
    writeJson(checkpointState({ prNumber: options.pr, nextState, expectedRevision, event }));
  } else if (command === 'set-review-limit') {
    if (parsedExpectedRevision === undefined) {
      throw new UsageError('set-review-limit requires --expected-revision');
    }
    const hasLimit = options.limit !== undefined;
    const unlimited = options.unlimited === true;
    if (hasLimit === unlimited) {
      throw new UsageError('set-review-limit requires exactly one of --limit or --unlimited');
    }
    const reviewRequestLimit = unlimited ? null : positiveSafeInteger(options.limit, '--limit');
    writeJson(checkpointReviewRequestLimit({
      prNumber: options.pr,
      reviewRequestLimit,
      expectedRevision: parsedExpectedRevision,
    }));
  } else if (command === 'migrate') {
    const integrationMap = options['integration-map']
      ? JSON.parse(readFileSync(options['integration-map'], 'utf8'))
      : undefined;
    writeJson(migrateState({ prNumber: options.pr, integrationMap }));
  } else if (command === 'recover') {
    const summary = renderRecoverySummary({ prNumber: options.pr });
    if (!summary) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    process.stdout.write(`${summary}\n`);
  } else if (command === 'archive') {
    writeJson({
      archived: true,
      path: archiveState({
        prNumber: options.pr,
        abandonmentReason: options['abandon-reason'],
      }),
    });
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  } else if (error instanceof StateError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof SyntaxError) {
    process.stderr.write(`INVALID_JSON: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`STATE_OPERATIONAL_ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}
