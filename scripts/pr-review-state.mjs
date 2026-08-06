#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  archiveState,
  checkpointState,
  initializeState,
  loadState,
  locateState,
  migrateState,
  reconcileState,
  renderRecoverySummary,
  StateError,
} from './lib/pr-review-state.mjs';

function usage() {
  return `Usage: node scripts/pr-review-state.mjs <command> [options]\n\nCommands:\n  init        Initialize a durable PR cycle\n  path        Print the active state path\n  validate    Validate state and reconcile Git metadata\n  show        Print active state JSON\n  checkpoint  Replace unprotected operational state from --input\n  migrate     Explicitly migrate active schema v1 state to v2\n  recover     Render compact recovery context\n  archive     Archive a complete or explicitly abandoned cycle\n\nCommon options:\n  --pr <number>\n  --help\n\nCheckpoint options:\n  --expected-revision <number>\n\nMigrate options:\n  --integration-map <file>  JSON task-ID to true central integration SHA map\n\nArchive options:\n  --abandon-reason <reason>\n\nProtected review, task-proof, and completion transitions are library-only so a GitHub evidence helper can verify live data before persistence.\n`;
}

function optionsFor(command, argv) {
  const common = { booleans: ['help'], values: ['pr', 'expected-revision'] };
  if (command === 'init') {
    common.values.push('repository', 'base', 'head', 'release-ref', 'session-id');
  } else if (command === 'checkpoint') {
    common.values.push('input', 'event-type', 'event-summary');
  } else if (command === 'migrate') {
    common.values.push('integration-map');
  } else if (command === 'archive') {
    common.values.push('abandon-reason');
  }
  return parseOptions(argv, common);
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!['init', 'path', 'validate', 'show', 'checkpoint', 'migrate', 'recover', 'archive'].includes(command)) {
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
