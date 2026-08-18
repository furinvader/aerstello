#!/usr/bin/env node
import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { StateError } from '../state/state.mjs';
import { createTaskWorktree, inspectTaskWorktree, recoverTaskWorktree, removeTaskWorktree } from './worktree.mjs';
function usage() { return `Usage: node .agents/skills/change-development/scripts/worktree/cli.mjs <create|recover|inspect|remove> [options]\n\nOptions:\n  --change <id>       Required change identifier\n  --task <id>         Required task identifier\n  --base <sha>        Explicit full packet base SHA (create only)\n  --packet <digest>   Exact packet sha256 digest (create only)\n  --help              Show this help\n`; }
try {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { process.stdout.write(usage()); process.exit(0); }
  if (!['create', 'recover', 'inspect', 'remove'].includes(command)) throw new UsageError(`Unknown command ${command}`);
  const options = parseOptions(argv, { booleans: ['help'], values: ['change', 'task', 'base', 'packet'] });
  if (options.help) { process.stdout.write(usage()); process.exit(0); }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  if (!options.change || !options.task) throw new UsageError('--change and --task are required');
  if (command === 'create') {
    if (!options.base || !options.packet) throw new UsageError('create requires --base and --packet');
    writeJson(createTaskWorktree({ changeId: options.change, taskId: options.task, base: options.base, packetDigest: options.packet }));
  } else if (command === 'recover') writeJson(recoverTaskWorktree({ changeId: options.change, taskId: options.task }));
  else if (command === 'inspect') writeJson(inspectTaskWorktree({ changeId: options.change, taskId: options.task }));
  else writeJson(removeTaskWorktree({ changeId: options.change, taskId: options.task }));
} catch (error) {
  if (error instanceof UsageError) { process.stderr.write(`${error.message}\n${usage()}`); process.exitCode = 2; }
  else if (error instanceof StateError) { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1; }
  else { process.stderr.write(`WORKTREE_OPERATIONAL_ERROR: ${error.message}\n`); process.exitCode = 2; }
}
