#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import { createGitHubReviewWorkflow, GitHubWorkflowError } from './lib/pr-review-github.mjs';
import {
  appendEvent,
  checkpointCiValidation,
  checkpointCompletion,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointTaskCompletion,
  checkpointVerificationEscalation,
  loadState,
  stateDirectory,
} from './lib/pr-review-state.mjs';

export function usage() {
  return `Usage: node scripts/pr-review-github.mjs <command> [--pr <number>] [options]\n\nCommands:\n  status [--human]               Read live review and CI status (active PR by default)\n  refresh-threads                Record exact-head empty canonical-thread proof for a taskless cycle\n  reply-resolve --task <id>      Reply to and close one task's Codex review threads\n  request --kind <kind>          Request discovery or verification review\n  collect                        Collect official review evidence for the Review commit\n  collect-ci                     Collect full GitHub Actions evidence for the Review commit\n  complete                       Reconfirm every gate and mark the cycle Done\n\nRequired options:\n  --pr <number>                  Required except for status with an active state\n\nRequest options:\n  --kind discovery|verification\n\nReply-resolve options:\n  --task <task-id>\n\nSuccessful commands write JSON, except status --human which writes plain English.\n`;
}

function titleCase(value) {
  return String(value ?? 'unknown').split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function renderHumanStatus(status) {
  const headMatches = status.stateHeadSha === status.liveHeadSha;
  const headRelation = headMatches ? 'matches PR head' : `DOES NOT MATCH PR head ${status.liveHeadSha}`;
  const review = !headMatches && status.codexReview === 'clean' ? 'Stale clean evidence (commit mismatch)'
    : status.codexReview === 'clean' ? 'Clean'
    : status.codexReview === 'findings' ? 'Findings need resolution'
      : status.codexReview === 'awaiting' ? 'Awaiting Codex'
        : status.codexReview === 'stale' ? 'Stale review evidence (commit mismatch)' : 'Not requested';
  const tasks = status.statePhase === 'complete' && headMatches ? 'Done'
    : `${status.taskStatus.resolved} Resolved, ${status.taskStatus.pending} pending`;
  const taskRows = status.taskStatus.items.map((task) => {
    const taskStatus = !headMatches && task.status === 'Done' ? 'Resolved (stale head)' : task.status;
    return `  - ${task.id}: ${taskStatus} — ${task.summary}`;
  });
  const targeted = status.targetedValidation?.status === 'passed'
    ? `Passed (${status.targetedValidation.checks.join(', ')})${headMatches ? '' : ' for the recorded commit; PR head differs'}`
    : titleCase(status.targetedValidation?.status);
  const ci = status.liveCiValidation?.status === 'passed'
    ? `Passed (${status.liveCiValidation.checks.join(', ')}) — ${status.liveCiValidation.workflowRunUrl}${headMatches ? '' : ' (live PR head differs from the recorded commit)'}`
    : status.liveCiValidation?.status === 'failed'
      ? `Failed — ${status.liveCiValidation.workflowRunUrl}`
      : titleCase(status.liveCiValidation?.status);
  return [
    `PR: #${status.prNumber}`,
    `Current commit: ${status.stateHeadSha} (${headRelation})`,
    `Phase: ${status.statePhase === 'complete' && headMatches ? 'Done'
      : status.statePhase === 'complete' ? 'Stale (recorded Done; PR head changed)'
        : titleCase(status.statePhase)}`,
    `Codex review: ${review}`,
    `Tasks: ${tasks}`,
    ...taskRows,
    `Targeted local tests: ${targeted}`,
    `Full CI: ${ci}`,
    `Open Codex threads: ${status.openCodexThreads}`,
    `Next action: ${headMatches ? status.nextAction
      : `Reconcile recorded commit with live PR head ${status.liveHeadSha}. Recorded next action: ${status.nextAction}`}`,
  ].join('\n');
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
    checkpointCiValidation: (input) => checkpointCiValidation({ cwd, ...input }),
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
  if (!['status', 'refresh-threads', 'reply-resolve', 'request', 'collect', 'collect-ci', 'complete'].includes(command)) {
    throw new UsageError(`Unknown command ${command}`);
  }
  const options = parseOptions(args, { booleans: ['help', 'human'], values: ['pr', 'task', 'kind'] });
  if (options.help) return { help: usage() };
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const prNumber = options.pr === undefined && command === 'status' ? undefined : parsePr(options.pr);
  if (command !== 'status' && options.human) throw new UsageError('--human is only valid for status');
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
    journal: journal ?? (['status', 'refresh-threads'].includes(command) ? null : defaultJournal(cwd, prNumber)),
  });
  if (command === 'status') {
    const result = await workflow.status(prNumber);
    return options.human ? { human: renderHumanStatus(result) } : result;
  }
  if (command === 'refresh-threads') return workflow.refreshThreads(prNumber);
  if (command === 'reply-resolve') return workflow.replyResolve(prNumber, options.task);
  if (command === 'request') return workflow.request(prNumber, options.kind);
  if (command === 'collect') return workflow.collect(prNumber);
  if (command === 'collect-ci') return workflow.collectCi(prNumber);
  return workflow.complete(prNumber);
}

async function main() {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result.help) process.stdout.write(result.help);
    else if (result.human) process.stdout.write(`${result.human}\n`);
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
