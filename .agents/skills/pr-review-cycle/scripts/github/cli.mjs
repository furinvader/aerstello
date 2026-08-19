#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { createGitHubReviewWorkflow, GitHubWorkflowError } from './github.mjs';
import {
  checkpointCiValidation,
  checkpointCompletion,
  checkpointReviewOutcome,
  checkpointReviewRequest,
  checkpointTaskCompletion,
  checkpointVerificationEscalation,
  ensureGitHubMutationIntent,
  claimGitHubMutationDispatch,
  withGitHubRequestOwnerLock,
  loadState,
  readSpecialistStatus,
  reviewRoot,
  stateDirectory,
} from '../state/state.mjs';

const MAX_ARCHIVED_STATE_BYTES = 128 * 1024;
const MAX_ARCHIVED_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const ARCHIVE_DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const ARCHIVE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const DEFAULT_ARCHIVE_FS = {
  closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync,
};

function baseUsage() {
  return `Usage: node .agents/skills/pr-review-cycle/scripts/github/cli.mjs <command> [--pr <number>] [options]\n\nCommands:\n  status [--human]               Read-only diagnostic live review and CI status (active PR by default)\n  advance --pr <number>          Safely checkpoint available review and CI progress\n  refresh-threads                Record exact-head empty canonical-thread proof for a taskless cycle\n  reply-resolve --task <id>      Reply to and close one task's Codex review threads\n  verify-resolve <selection>     Verify one task or re-attest one complete threadless set\n  request [--kind <kind>]        Request the state-selected review kind\n  collect                        Collect official review evidence for the Review commit\n  collect-ci                     Collect full GitHub Actions evidence for the Review commit\n  complete                       Reconfirm every gate and mark the cycle Done\n\nRequired options:\n  --pr <number>                  Required except for status with an active state\n\nRequest options:\n  --kind discovery|verification  Optional compatibility assertion; state selects the kind\n\nTask resolution options:\n  --task <opaque-task-id>        One byte-for-byte task ID for reply-resolve or verify-resolve\n  --task-set-json <json-array>   Explicit task-ID set for verify-resolve only\n\nSuccessful commands write JSON, except status --human which writes plain English.\n`;
}

export function usage() {
  return `${baseUsage().trimEnd()}\n\nadvance safely records available review and CI progress without requesting review or archiving. Request may return waiting while a durable GitHub dispatch is reconciled; retry it rather than posting another comment.\n\nLocal task verification persists exact-current-HEAD proof; rerun it to re-attest a completed local task after HEAD drift.\n`;
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
  const specialistStatus = status.specialistReviews?.status ?? 'missing';
  const specialistReviewers = status.specialistReviews?.requiredReviewerIds ?? [];
  const specialists = `${titleCase(specialistStatus)}${specialistReviewers.length > 0
    ? ` (required: ${specialistReviewers.join(', ')})` : ''}`;
  return [
    `PR: #${status.prNumber}`,
    `PR readiness: ${status.pullRequest?.state ?? 'unknown'}${status.pullRequest?.isDraft ? ' draft' : ''}`,
    `Live review observation: ${titleCase(status.reviewObservation?.status)}`,
    `Current commit: ${status.stateHeadSha} (${headRelation})`,
    `Phase: ${status.statePhase === 'complete' && headMatches ? 'Done'
      : status.statePhase === 'complete' ? 'Stale (recorded Done; PR head changed)'
        : titleCase(status.statePhase)}`,
    `Codex review: ${review}`,
    `Review requests: ${status.reviewRequests.used}; limit: ${status.reviewRequests.limit ?? 'unlimited'}`,
    `Tasks: ${tasks}`,
    ...taskRows,
    `Targeted local tests: ${targeted}`,
    `Specialist reviews: ${specialists}`,
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
    specialistStatus: (prNumber) => readSpecialistStatus({ cwd, prNumber }),
  };
}

function actualObjectGitText(cwd, args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertLegacyGraftsAreInert(cwd) {
  const commonGitDirectory = actualObjectGitText(
    cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  );
  if (commonGitDirectory.length === 0) throw new Error('Git common directory is unavailable');
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  let stat;
  try {
    stat = lstatSync(graftsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
    throw new Error(`Actual-object ancestry refuses legacy grafts at ${graftsPath}`);
  }
}

export function createDefaultGitAdapter() {
  return {
    snapshot: (cwd) => ({
      headSha: gitText(cwd, ['rev-parse', 'HEAD']),
      dirty: gitText(cwd, ['status', '--porcelain']).length > 0,
    }),
    pushedHead: (cwd) => gitText(cwd, ['rev-parse', '@{upstream}']),
    isAncestor: (ancestor, descendant, cwd) => {
      try {
        assertLegacyGraftsAreInert(cwd);
        execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant], {
          cwd,
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    },
    resolveCommitPrefix: (prefix, cwd) => gitText(cwd, ['rev-list', '--all'])
      .split('\n').filter((sha) => sha.startsWith(prefix)),
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
      return ensureGitHubMutationIntent(cwd, prNumber, intent);
    },
    claimDispatch(intent, expectedRevision) { return claimGitHubMutationDispatch(cwd, prNumber, intent, expectedRevision); },
    withRequestOwner(callback) { return withGitHubRequestOwnerLock(cwd, prNumber, callback); },
  };
}

function sameStableArchiveStat(left, right) {
  return [
    'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'mtimeNs', 'ctimeNs',
  ].every((field) => left[field] === right[field]);
}

function assertImmutableArchiveDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new GitHubWorkflowError(`${label} is not one immutable real directory`, 'ARCHIVE_EVIDENCE_INVALID');
  }
}

function openImmutableArchiveDirectory(fileSystem, path, label) {
  const pathStat = fileSystem.lstatSync(path, { bigint: true });
  assertImmutableArchiveDirectory(pathStat, label);
  const fd = fileSystem.openSync(path, ARCHIVE_DIRECTORY_OPEN_FLAGS);
  try {
    const fdStat = fileSystem.fstatSync(fd, { bigint: true });
    assertImmutableArchiveDirectory(fdStat, label);
    if (!sameStableArchiveStat(pathStat, fdStat)) {
      throw new GitHubWorkflowError(`${label} changed while it was opened`, 'ARCHIVE_EVIDENCE_INVALID');
    }
    return { fd, path, label, initialStat: fdStat };
  } catch (error) {
    fileSystem.closeSync(fd);
    throw error;
  }
}

function assertImmutableArchiveDirectoryStable(fileSystem, directory) {
  const fdStat = fileSystem.fstatSync(directory.fd, { bigint: true });
  const pathStat = fileSystem.lstatSync(directory.path, { bigint: true });
  assertImmutableArchiveDirectory(fdStat, directory.label);
  assertImmutableArchiveDirectory(pathStat, directory.label);
  if (!sameStableArchiveStat(directory.initialStat, fdStat)
      || !sameStableArchiveStat(directory.initialStat, pathStat)) {
    throw new GitHubWorkflowError(`${directory.label} changed during evidence reads`, 'ARCHIVE_EVIDENCE_INVALID');
  }
}

function readImmutableArchiveFile(fileSystem, path, label, maxBytes) {
  const pathStat = fileSystem.lstatSync(path, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()
      || pathStat.size < 1n || pathStat.size > BigInt(maxBytes)) {
    throw new GitHubWorkflowError(`${label} is not one bounded immutable regular file`, 'ARCHIVE_EVIDENCE_INVALID');
  }
  const fd = fileSystem.openSync(path, ARCHIVE_FILE_OPEN_FLAGS);
  try {
    const openedStat = fileSystem.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile() || openedStat.isSymbolicLink()
        || openedStat.size < 1n || openedStat.size > BigInt(maxBytes)
        || !sameStableArchiveStat(pathStat, openedStat)) {
      throw new GitHubWorkflowError(`${label} changed while it was opened`, 'ARCHIVE_EVIDENCE_INVALID');
    }
    const bytes = fileSystem.readFileSync(fd);
    const finalFdStat = fileSystem.fstatSync(fd, { bigint: true });
    const finalPathStat = fileSystem.lstatSync(path, { bigint: true });
    if (!Buffer.isBuffer(bytes) || BigInt(bytes.byteLength) !== openedStat.size
        || !finalFdStat.isFile() || finalFdStat.isSymbolicLink()
        || !finalPathStat.isFile() || finalPathStat.isSymbolicLink()
        || !sameStableArchiveStat(openedStat, finalFdStat)
        || !sameStableArchiveStat(openedStat, finalPathStat)) {
      throw new GitHubWorkflowError(`${label} changed during its exact read`, 'ARCHIVE_EVIDENCE_INVALID');
    }
    return bytes.toString('utf8');
  } finally {
    fileSystem.closeSync(fd);
  }
}

export function createDefaultArchiveStore(cwd = process.cwd(), fileSystemOverrides = {}) {
  const fileSystem = { ...DEFAULT_ARCHIVE_FS, ...fileSystemOverrides };
  return {
    async list(prNumber) {
      const archiveRoot = join(reviewRoot(cwd), 'archive');
      try {
        fileSystem.lstatSync(archiveRoot, { bigint: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw new GitHubWorkflowError(
          `Immutable archive root cannot be inspected exactly: ${error.message}`,
          'ARCHIVE_EVIDENCE_INVALID',
        );
      }
      const namePattern = new RegExp(
        `^pr-${prNumber}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`,
        'u',
      );
      let rootDirectory;
      try {
        rootDirectory = openImmutableArchiveDirectory(fileSystem, archiveRoot, 'Archive root');
        const pinnedRoot = `/proc/self/fd/${rootDirectory.fd}`;
        const entryNames = fileSystem.readdirSync(pinnedRoot, { withFileTypes: true })
          .map((entry) => entry.name)
          .filter((name) => namePattern.test(name))
          .sort((left, right) => left.localeCompare(right));
        if (entryNames.length > MAX_ARCHIVE_ENTRIES) {
          throw new GitHubWorkflowError(
            'Canonical archive inventory exceeded the node limit', 'ARCHIVE_EVIDENCE_INVALID',
          );
        }
        const archives = [];
        for (const entryName of entryNames) {
          const directoryPath = join(pinnedRoot, entryName);
          const directory = openImmutableArchiveDirectory(
            fileSystem, directoryPath, `Canonical archive ${entryName}`,
          );
          let stateText;
          let eventsText;
          try {
            const pinnedDirectory = `/proc/self/fd/${directory.fd}`;
            stateText = readImmutableArchiveFile(
              fileSystem,
              join(pinnedDirectory, 'state.json'), `${entryName}/state.json`, MAX_ARCHIVED_STATE_BYTES,
            );
            eventsText = readImmutableArchiveFile(
              fileSystem,
              join(pinnedDirectory, 'events.ndjson'), `${entryName}/events.ndjson`, MAX_ARCHIVED_EVENTS_BYTES,
            );
            assertImmutableArchiveDirectoryStable(fileSystem, directory);
          } finally {
            fileSystem.closeSync(directory.fd);
          }
          const eventLines = eventsText.trim().split('\n').filter(Boolean);
          archives.push({
            archiveId: entryName,
            state: JSON.parse(stateText),
            events: eventLines.map((line) => JSON.parse(line)),
          });
        }
        assertImmutableArchiveDirectoryStable(fileSystem, rootDirectory);
        return archives;
      } catch (error) {
        if (error instanceof GitHubWorkflowError) throw error;
        throw new GitHubWorkflowError(
          `Immutable archive evidence cannot be read exactly: ${error.message}`,
          'ARCHIVE_EVIDENCE_INVALID',
        );
      } finally {
        if (rootDirectory) fileSystem.closeSync(rootDirectory.fd);
      }
    },
  };
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
    state: state ?? defaultState(cwd),
    git,
    clock,
    journal: journal ?? (['status', 'advance', 'refresh-threads', 'verify-resolve'].includes(command)
      ? null : defaultJournal(cwd, prNumber)),
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
