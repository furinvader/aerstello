#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { buildGhGraphqlArgs, createDefaultGitHubClient } from './adapters/gh-cli.mjs';
import { createDefaultGitAdapter } from './adapters/git.mjs';
import { createDefaultStateAdapter } from './adapters/state.mjs';
import { createDefaultArchiveStore, terminateOnFatalArchiveCwd } from './archive/store.mjs';
import { createGitHubReviewWorkflow } from './create-workflow.mjs';
import { GitHubWorkflowError } from './errors.mjs';
import { createDefaultMutationJournal } from './mutation-journal.mjs';
import { renderHumanStatus } from './status-renderer.mjs';

export {
  buildGhGraphqlArgs,
  createDefaultArchiveStore,
  createDefaultGitAdapter,
  createDefaultGitHubClient,
  renderHumanStatus,
  terminateOnFatalArchiveCwd,
};

function baseUsage() {
  return `Usage: node .agents/skills/pr-review-cycle/scripts/github/cli.mjs <command> [--pr <number>] [options]\n\nCommands:\n  status [--human]               Read-only diagnostic live review and CI status (active PR by default)\n  advance --pr <number>          Safely checkpoint available review and CI progress\n  refresh-threads                Record exact-head empty canonical-thread proof for a taskless cycle\n  reply-resolve --task <id>      Reply to and close one task's Codex review threads\n  verify-resolve <selection>     Verify one task or re-attest one complete threadless set\n  request [--kind <kind>]        Request the state-selected review kind\n  collect                        Collect official review evidence for the Review commit\n  collect-ci                     Collect full GitHub Actions evidence for the Review commit\n  complete                       Reconfirm every gate and mark the cycle Done\n\nRequired options:\n  --pr <number>                  Required except for status with an active state\n\nRequest options:\n  --kind discovery|verification  Optional compatibility assertion; state selects the kind\n\nTask resolution options:\n  --task <opaque-task-id>        One byte-for-byte task ID for reply-resolve or verify-resolve\n  --task-set-json <json-array>   Explicit task-ID set for verify-resolve only\n\nSuccessful commands write JSON, except status --human which writes plain English.\n`;
}

export function usage() {
  return `${baseUsage().trimEnd()}\n\nadvance safely records available review and CI progress without requesting review or archiving. Request may return waiting while a durable GitHub dispatch is reconciled; retry it rather than posting another comment.\n\nLocal task verification persists exact-current-HEAD proof; rerun it to re-attest a completed local task after HEAD drift.\n`;
}

function parsePr(value) {
  if (!/^\d+$/u.test(value ?? '') || Number(value) < 1) throw new UsageError('--pr must be a positive integer');
  return Number(value);
}

function optionOccurrences(args, name) {
  let count = 0;
  for (const raw of args) {
    if (raw === '--') break;
    if (raw === `--${name}` || raw.startsWith(`--${name}=`)) count += 1;
  }
  return count;
}

function parseVerifyTaskSetJson(value) {
  let taskIds;
  try {
    taskIds = JSON.parse(value);
  } catch {
    throw new UsageError('--task-set-json must be valid JSON');
  }
  if (!Array.isArray(taskIds) || taskIds.length === 0
      || taskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
      || new Set(taskIds).size !== taskIds.length) {
    throw new UsageError('--task-set-json must be a nonempty array of unique nonempty strings');
  }
  return taskIds;
}

export async function runCli(argv, {
  cwd = process.cwd(), client = createDefaultGitHubClient(), state, git = createDefaultGitAdapter(), clock = { now: () => new Date().toISOString() },
  journal, archiveStore,
} = {}) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') return { help: usage() };
  if (!['status', 'refresh-threads', 'reply-resolve', 'verify-resolve', 'request', 'collect', 'collect-ci', 'complete', 'advance'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = parseOptions(args, {
    booleans: ['help', 'human'], values: ['pr', 'task', 'task-set-json', 'kind'],
  });
  if (optionOccurrences(args, 'task') > 1) {
    throw new UsageError('--task may be specified only once');
  }
  if (optionOccurrences(args, 'task-set-json') > 1) {
    throw new UsageError('--task-set-json may be specified only once');
  }
  if (options.help) return { help: usage() };
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const prNumber = options.pr === undefined && command === 'status' ? undefined : parsePr(options.pr);
  if (command !== 'status' && options.human) throw new UsageError('--human is only valid for status');
  const hasTask = options.task !== undefined;
  const hasTaskSet = options['task-set-json'] !== undefined;
  let verifyTaskSelection = null;
  if (command === 'reply-resolve') {
    if (hasTaskSet) throw new UsageError('--task-set-json is only valid for verify-resolve');
    if (!hasTask || options.task.length === 0) throw new UsageError('reply-resolve requires --task');
  } else if (command === 'verify-resolve') {
    if (hasTask === hasTaskSet) {
      throw new UsageError('verify-resolve requires exactly one of --task or --task-set-json');
    }
    if (hasTask) {
      if (options.task.length === 0) throw new UsageError('verify-resolve --task must not be empty');
      verifyTaskSelection = [options.task];
    } else {
      verifyTaskSelection = parseVerifyTaskSetJson(options['task-set-json']);
    }
  } else if (hasTask) {
    throw new UsageError('--task is only valid for reply-resolve or verify-resolve');
  } else if (hasTaskSet) {
    throw new UsageError('--task-set-json is only valid for verify-resolve');
  }
  if (command === 'request' && options.kind !== undefined
      && !['discovery', 'verification'].includes(options.kind)) {
    throw new UsageError('--kind must be discovery or verification when supplied');
  }
  if (command !== 'request' && options.kind !== undefined) throw new UsageError('--kind is only valid for request');
  const workflow = createGitHubReviewWorkflow({
    client,
    state: state ?? createDefaultStateAdapter(cwd),
    git,
    clock,
    journal: journal ?? (['status', 'advance', 'refresh-threads', 'verify-resolve'].includes(command)
      ? null : createDefaultMutationJournal(cwd, prNumber)),
    archiveStore: archiveStore ?? (command === 'reply-resolve' ? createDefaultArchiveStore(cwd) : null),
  });
  if (command === 'status') {
    const result = await workflow.status(prNumber);
    return options.human ? { human: renderHumanStatus(result) } : result;
  }
  if (command === 'refresh-threads') return workflow.refreshThreads(prNumber);
  if (command === 'reply-resolve') return workflow.replyResolve(prNumber, options.task);
  if (command === 'verify-resolve') {
    return workflow.verifyResolve(prNumber, verifyTaskSelection);
  }
  if (command === 'request') return workflow.request(prNumber, options.kind);
  if (command === 'collect') return workflow.collect(prNumber);
  if (command === 'collect-ci') return workflow.collectCi(prNumber);
  if (command === 'advance') return workflow.advance(prNumber);
  return workflow.complete(prNumber);
}

async function main() {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result.help) process.stdout.write(result.help);
    else if (result.human) process.stdout.write(`${result.human}\n`);
    else writeJson(result);
  } catch (error) {
    if (terminateOnFatalArchiveCwd(error)) return;
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${usage()}`);
      process.exitCode = 2;
    } else if (error instanceof GitHubWorkflowError || error?.code) {
      process.stderr.write(`${error.code ?? 'GITHUB_WORKFLOW_ERROR'}: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`GITHUB_OPERATIONAL_ERROR: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
