#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  archiveState,
  checkpointState,
  initializeState,
  loadState,
  locateState,
  reconcileState,
  renderRecoverySummary,
  StateError,
} from './lib/pr-review-state.mjs';

function usage() {
  return `Usage: node scripts/pr-review-state.mjs <command> [options]\n\nCommands:\n  init        Initialize a durable PR cycle\n  path        Print the active state path\n  validate    Validate state and reconcile Git metadata\n  show        Print active state JSON\n  checkpoint  Atomically replace state from --input\n  recover     Render compact recovery context\n  archive     Archive a completed or stale cycle\n\nCommon options:\n  --pr <number>\n  --help\n\nRun a command with --help for its accepted options.\n`;
}

function optionsFor(command, argv) {
  const common = { booleans: ['help'], values: ['pr'] };
  if (command === 'init') {
    common.values.push('repository', 'base', 'head', 'release-ref', 'session-id');
  } else if (command === 'checkpoint') {
    common.values.push('input', 'expected-revision', 'event-type', 'event-summary');
  }
  return parseOptions(argv, common);
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!['init', 'path', 'validate', 'show', 'checkpoint', 'recover', 'archive'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = optionsFor(command, argv);
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);

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
  } else if (command === 'checkpoint') {
    if (!options.input) throw new UsageError('checkpoint requires --input');
    const nextState = JSON.parse(readFileSync(options.input, 'utf8'));
    const expectedRevision = options['expected-revision'] === undefined
      ? nextState.revision
      : Number(options['expected-revision']);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new UsageError('--expected-revision must be a non-negative integer');
    const event = options['event-type'] || options['event-summary']
      ? {
          type: options['event-type'] ?? 'checkpoint',
          summary: options['event-summary'] ?? 'Updated active PR state',
        }
      : undefined;
    writeJson(checkpointState({ prNumber: options.pr, nextState, expectedRevision, event }));
  } else if (command === 'recover') {
    const summary = renderRecoverySummary({ prNumber: options.pr });
    if (!summary) throw new StateError('No active PR state', 'STATE_NOT_FOUND');
    process.stdout.write(`${summary}\n`);
  } else if (command === 'archive') {
    writeJson({ archived: true, path: archiveState({ prNumber: options.pr }) });
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
