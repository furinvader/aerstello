#!/usr/bin/env node
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  createTaskWorktree,
  inspectTaskWorktree,
  removeTaskWorktree,
} from './lib/pr-review-worktree.mjs';
import { StateError } from './lib/pr-review-state.mjs';

function usage() {
  return `Usage: node scripts/pr-review-worktree.mjs <create|inspect|remove> [options]\n\nOptions:\n  --pr <number>     Required PR number\n  --task <id>       Required task identifier\n  --base <sha>      Explicit reviewed SHA (create only)\n  --detached        Create a detached worktree\n  --help            Show this help\n`;
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!['create', 'inspect', 'remove'].includes(command)) throw new UsageError(`Unknown command ${command}`);
  const options = parseOptions(argv, {
    booleans: ['detached', 'help'],
    values: ['pr', 'task', 'base'],
  });
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  if (!options.pr || !options.task) throw new UsageError('--pr and --task are required');

  if (command === 'create') {
    if (!options.base) throw new UsageError('create requires --base');
    writeJson(createTaskWorktree({
      prNumber: options.pr,
      taskId: options.task,
      base: options.base,
      detached: options.detached,
    }));
  } else if (command === 'inspect') {
    writeJson(inspectTaskWorktree({ prNumber: options.pr, taskId: options.task }));
  } else {
    writeJson(removeTaskWorktree({ prNumber: options.pr, taskId: options.task }));
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  } else if (error instanceof StateError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`WORKTREE_OPERATIONAL_ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}
