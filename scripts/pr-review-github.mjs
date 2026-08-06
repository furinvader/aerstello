#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import { createGitHubReviewWorkflow, GitHubWorkflowError } from './lib/pr-review-github.mjs';
import {
  appendEvent,
  checkpointCompletion,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointTaskCompletion,
  checkpointVerificationEscalation,
  loadState,
  stateDirectory,
} from './lib/pr-review-state.mjs';

export function usage() {
  return `Usage: node scripts/pr-review-github.mjs <command> --pr <number> [options]\n\nCommands:\n  status                         Read live review status\n  reply-resolve --task <id>      Reply to and resolve one task's canonical roots\n  request --kind <kind>          Request discovery or verification review\n  collect                        Collect canonical exact-SHA review evidence\n  complete                       Complete the exact-head review cycle\n\nRequired options:\n  --pr <number>\n\nRequest options:\n  --kind discovery|verification\n\nReply-resolve options:\n  --task <task-id>\n\nAll successful commands write JSON to stdout.\n`;
}

function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function buildGhGraphqlArgs(query, variables) {
  if (typeof query !== 'string') {
    throw new GitHubWorkflowError('GraphQL query must be a string', 'INVALID_GRAPHQL_VARIABLE');
  }
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      args.push('-f', `${key}=${value}`);
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      args.push('-F', `${key}=${value}`);
    } else {
      throw new GitHubWorkflowError(`GraphQL variable ${key} has an unsupported value`, 'INVALID_GRAPHQL_VARIABLE');
    }
  }
  return args;
}

export function createDefaultGitHubClient(exec = execFileSync) {
  return {
    async graphql({ query, variables }) {
      const args = buildGhGraphqlArgs(query, variables);
      return JSON.parse(exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    },
  };
}

function defaultState(cwd) {
  return {
    load: (prNumber) => loadState(cwd, prNumber),
    checkpointReviewRequest: (input) => checkpointReviewRequest({ cwd, ...input }),
    checkpointReviewOutcome: (input) => checkpointReviewOutcome({ cwd, ...input }),
    checkpointVerificationEscalation: (input) => checkpointVerificationEscalation({ cwd, ...input }),
    checkpointTaskCompletion: (input) => checkpointTaskCompletion({ cwd, ...input }),
    checkpointCompletion: (input) => checkpointCompletion({ cwd, ...input }),
  };
}

function defaultGit() {
  return {
    snapshot: (cwd) => ({
      headSha: gitText(cwd, ['rev-parse', 'HEAD']),
      dirty: gitText(cwd, ['status', '--porcelain']).length > 0,
    }),
    pushedHead: (cwd) => gitText(cwd, ['rev-parse', '@{upstream}']),
    isAncestor: (ancestor, descendant, cwd) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
          cwd, stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function defaultJournal(cwd, prNumber) {
  const path = join(stateDirectory(cwd, prNumber), 'events.ndjson');
  function lookupIntent(operationId) {
    const events = existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const existing = events.find((event) => event.type === 'github-mutation-intent'
      && event.details?.operationId === operationId);
    return existing ? { ...existing.details, isNew: false } : null;
  }
  return {
    lookupIntent,
    ensureIntent(intent) {
      const existing = lookupIntent(intent.operationId);
      if (existing) return existing;
      appendEvent(cwd, prNumber, {
        type: 'github-mutation-intent',
        summary: `Intent ${intent.type} ${intent.operationId}`.slice(0, 1000),
        details: intent,
      });
      return { ...intent, isNew: true };
    },
  };
}

function parsePr(value) {
  if (!/^\d+$/u.test(value ?? '') || Number(value) < 1) throw new UsageError('--pr must be a positive integer');
  return Number(value);
}

export async function runCli(argv, {
  cwd = process.cwd(), client = createDefaultGitHubClient(), state, git = defaultGit(), clock = { now: () => new Date().toISOString() },
  journal,
} = {}) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') return { help: usage() };
  if (!['status', 'reply-resolve', 'request', 'collect', 'complete'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = parseOptions(args, { booleans: ['help'], values: ['pr', 'task', 'kind'] });
  if (options.help) return { help: usage() };
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const prNumber = parsePr(options.pr);
  if (command === 'reply-resolve' && !options.task) throw new UsageError('reply-resolve requires --task');
  if (command !== 'reply-resolve' && options.task !== undefined) throw new UsageError('--task is only valid for reply-resolve');
  if (command === 'request' && !['discovery', 'verification'].includes(options.kind)) {
    throw new UsageError('request requires --kind discovery|verification');
  }
  if (command !== 'request' && options.kind !== undefined) throw new UsageError('--kind is only valid for request');
  const workflow = createGitHubReviewWorkflow({
    client,
    state: state ?? defaultState(cwd),
    git,
    clock,
    journal: journal ?? defaultJournal(cwd, prNumber),
  });
  if (command === 'status') return workflow.status(prNumber);
  if (command === 'reply-resolve') return workflow.replyResolve(prNumber, options.task);
  if (command === 'request') return workflow.request(prNumber, options.kind);
  if (command === 'collect') return workflow.collect(prNumber);
  return workflow.complete(prNumber);
}

async function main() {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result.help) process.stdout.write(result.help);
    else writeJson(result);
  } catch (error) {
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
