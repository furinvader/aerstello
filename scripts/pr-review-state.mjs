#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  validateTaskPacket,
  validateWorkerResult,
  validateWorkerResultAgainstTask,
} from './lib/contracts.mjs';
import {
  archiveState,
  assertTaskPacketBound,
  buildTargetedValidationPlan,
  checkpointHumanFinalReviewAuthorization,
  checkpointState,
  checkpointTaskPacketBinding,
  executeTargetedValidationPlan,
  initializeState,
  loadState,
  locateState,
  migrateState,
  reconcileState,
  renderRecoverySummary,
  StateError,
} from './lib/pr-review-state.mjs';

function usage() {
  return `Usage: node scripts/pr-review-state.mjs <command> [options]\n\nCommands:\n  init                      Start durable state for a PR review cycle\n  path                      Print the active state path\n  validate                  Check state against the integration checkout\n  bind-task-packet          Bind accepted fixed instructions to a durable task\n  validate-result           Check a worker result against its bound fixed instructions\n  validation-plan           Save and print the combined targeted checks\n  run-validation            Run pending checks from the saved plan and record the result\n  show                      Print active state JSON\n  checkpoint                Replace ordinary operational state from --input\n  migrate                   Explicitly migrate active schema v1, v2, or v3 state to v4\n  authorize-final-review    Record one immutable operator-authorized human-final review\n  recover                   Print compact recovery context\n  archive                   Archive a Done or explicitly abandoned cycle\n\nCommon options:\n  --pr <number>\n  --help\n\nBind-task-packet options:\n  --task-packet <file>\n  --expected-revision <number>\n\nValidation-plan arguments:\n  <task-packet.json> [...]       One bound file for every actionable Integrated task\n  --initial-selection <file>     Explicit pristine, clean-taskless, or proven v2 completed-task recovery selection\n  --replace                      Start a fresh plan after a failure or commit change\n\nValidate-result options:\n  --task-packet <file>\n  --worker-result <file>\n\nCheckpoint options:\n  --expected-revision <number>\n\nAuthorize-final-review options:\n  --decision-id <id>             Existing durable operator decision ID\n  --not-before <RFC3339>         Earliest trusted time for the one-shot request\n  --summary <text>               Concise immutable authorization summary\n  --expected-revision <number>   Required optimistic state revision\n\nMigrate options:\n  --integration-map <file>  JSON task-ID to central integration SHA map (v1 only)\n\nArchive options:\n  --abandon-reason <reason>\n\nReview, CI, task-resolution, targeted-validation, and Done transitions use guarded helpers that verify their evidence before saving.\n`;
}

function optionsFor(command, argv) {
  const common = { booleans: ['help'], values: ['pr', 'expected-revision'] };
  if (command === 'init') {
    common.values.push('repository', 'base', 'head', 'release-ref', 'session-id');
  } else if (command === 'checkpoint') {
    common.values.push('input', 'event-type', 'event-summary');
  } else if (command === 'migrate') {
    common.values.push('integration-map');
  } else if (command === 'authorize-final-review') {
    common.values.push('decision-id', 'not-before', 'summary');
  } else if (['bind-task-packet', 'validate-result'].includes(command)) {
    common.values.push('task-packet', 'worker-result');
  } else if (command === 'validation-plan') {
    common.booleans.push('replace');
    common.values.push('initial-selection');
  } else if (command === 'archive') {
    common.values.push('abandon-reason');
  }
  return parseOptions(argv, common);
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
  if (!['init', 'path', 'validate', 'bind-task-packet', 'validate-result', 'validation-plan', 'run-validation', 'show', 'checkpoint', 'migrate', 'authorize-final-review', 'recover', 'archive'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = optionsFor(command, argv);
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (command !== 'validation-plan' && options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const parsedExpectedRevision = options['expected-revision'] === undefined
    ? undefined
    : Number(options['expected-revision']);
  if (parsedExpectedRevision !== undefined
      && (!Number.isInteger(parsedExpectedRevision) || parsedExpectedRevision < 0)) {
    throw new UsageError('--expected-revision must be a non-negative integer');
  }

  if (command === 'init') {
    if (!options.pr) throw new UsageError('init requires --pr');
    const state = initializeState({
      prNumber: options.pr,
      repository: options.repository,
      base: options.base ?? 'origin/main',
      head: options.head ?? 'HEAD',
      releaseRef: options['release-ref'] ?? 'origin/main',
      orchestratorSessionId: options['session-id'] ?? null,
    });
    writeJson(state);
  } else if (command === 'path') {
    const located = locateState(process.cwd(), options.pr);
    if (!located) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    process.stdout.write(`${located.path}\n`);
  } else if (command === 'validate') {
    const result = reconcileState({ prNumber: options.pr });
    if (!result.state) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    writeJson({ valid: true, ...result });
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
  } else if (command === 'validation-plan') {
    if (options['initial-selection'] && options._.length > 0) {
      throw new UsageError('--initial-selection cannot be combined with task-packet files');
    }
    if (!options['initial-selection'] && options._.length === 0) {
      throw new UsageError('validation-plan requires task-packet files or --initial-selection');
    }
    const taskPackets = options._.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const initialSelection = options['initial-selection']
      ? JSON.parse(readFileSync(options['initial-selection'], 'utf8'))
      : undefined;
    writeJson(buildTargetedValidationPlan({
      prNumber: options.pr, taskPackets, initialSelection, replace: options.replace === true,
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
  } else if (command === 'migrate') {
    const integrationMap = options['integration-map']
      ? JSON.parse(readFileSync(options['integration-map'], 'utf8'))
      : undefined;
    writeJson(migrateState({ prNumber: options.pr, integrationMap }));
  } else if (command === 'authorize-final-review') {
    if (!options['decision-id'] || !options['not-before'] || !options.summary) {
      throw new UsageError('authorize-final-review requires --decision-id, --not-before, and --summary');
    }
    if (parsedExpectedRevision === undefined) {
      throw new UsageError('authorize-final-review requires --expected-revision');
    }
    writeJson(checkpointHumanFinalReviewAuthorization({
      prNumber: options.pr,
      decisionId: options['decision-id'],
      notBefore: options['not-before'],
      summary: options.summary,
      expectedRevision: parsedExpectedRevision,
    }));
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
