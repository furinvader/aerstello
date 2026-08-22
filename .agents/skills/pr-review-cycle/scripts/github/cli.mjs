#!/usr/bin/env node
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { parseOptions, UsageError, writeJson } from '../../../../../scripts/lib/cli.mjs';
import { reviewRoot } from '../state/state.mjs';
import { buildGhGraphqlArgs, createDefaultGitHubClient } from './adapters/gh-cli.mjs';
import { createDefaultGitAdapter } from './adapters/git.mjs';
import { createDefaultStateAdapter } from './adapters/state.mjs';
import { GitHubWorkflowError } from './errors.mjs';
import { createGitHubReviewWorkflow } from './github.mjs';
import { createDefaultMutationJournal } from './mutation-journal.mjs';
import { renderHumanStatus } from './status-renderer.mjs';

export {
  buildGhGraphqlArgs,
  createDefaultGitAdapter,
  createDefaultGitHubClient,
  renderHumanStatus,
};

const MAX_ARCHIVED_STATE_BYTES = 128 * 1024;
const MAX_ARCHIVED_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const ARCHIVE_DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const ARCHIVE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const DEFAULT_ARCHIVE_FS = {
  closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync,
};
const DEFAULT_ARCHIVE_RUNTIME = {
  platform: process.platform,
  isMainThread,
  cwd: () => process.cwd(),
  chdir: (path) => process.chdir(path),
  runSynchronous: (callback) => callback(),
};
const FATAL_ARCHIVE_CWD = Symbol('fatal-archive-cwd');
let activeDarwinArchiveOwner = null;
let darwinArchiveCwdPoisoned = false;

function baseUsage() {
  return `Usage: node .agents/skills/pr-review-cycle/scripts/github/cli.mjs <command> [--pr <number>] [options]\n\nCommands:\n  status [--human]               Read-only diagnostic live review and CI status (active PR by default)\n  advance --pr <number>          Safely checkpoint available review and CI progress\n  refresh-threads                Record exact-head empty canonical-thread proof for a taskless cycle\n  reply-resolve --task <id>      Reply to and close one task's Codex review threads\n  verify-resolve <selection>     Verify one task or re-attest one complete threadless set\n  request [--kind <kind>]        Request the state-selected review kind\n  collect                        Collect official review evidence for the Review commit\n  collect-ci                     Collect full GitHub Actions evidence for the Review commit\n  complete                       Reconfirm every gate and mark the cycle Done\n\nRequired options:\n  --pr <number>                  Required except for status with an active state\n\nRequest options:\n  --kind discovery|verification  Optional compatibility assertion; state selects the kind\n\nTask resolution options:\n  --task <opaque-task-id>        One byte-for-byte task ID for reply-resolve or verify-resolve\n  --task-set-json <json-array>   Explicit task-ID set for verify-resolve only\n\nSuccessful commands write JSON, except status --human which writes plain English.\n`;
}

export function usage() {
  return `${baseUsage().trimEnd()}\n\nadvance safely records available review and CI progress without requesting review or archiving. Request may return waiting while a durable GitHub dispatch is reconciled; retry it rather than posting another comment.\n\nLocal task verification persists exact-current-HEAD proof; rerun it to re-attest a completed local task after HEAD drift.\n`;
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

function openImmutableArchiveDirectory(fileSystem, openPath, label, stabilityPath = openPath) {
  const pathStat = fileSystem.lstatSync(openPath, { bigint: true });
  assertImmutableArchiveDirectory(pathStat, label);
  const fd = fileSystem.openSync(openPath, ARCHIVE_DIRECTORY_OPEN_FLAGS);
  try {
    const fdStat = fileSystem.fstatSync(fd, { bigint: true });
    assertImmutableArchiveDirectory(fdStat, label);
    if (!sameStableArchiveStat(pathStat, fdStat)) {
      throw new GitHubWorkflowError(`${label} changed while it was opened`, 'ARCHIVE_EVIDENCE_INVALID');
    }
    return { fd, path: stabilityPath, label, initialStat: fdStat };
  } catch (error) {
    fileSystem.closeSync(fd);
    throw error;
  }
}

function assertCurrentArchiveDirectory(fileSystem, directory) {
  const currentStat = fileSystem.statSync('.', { bigint: true });
  const descriptorStat = fileSystem.fstatSync(directory.fd, { bigint: true });
  const pathStat = fileSystem.lstatSync(directory.path, { bigint: true });
  assertImmutableArchiveDirectory(currentStat, `${directory.label} current working directory`);
  assertImmutableArchiveDirectory(descriptorStat, directory.label);
  assertImmutableArchiveDirectory(pathStat, directory.label);
  if (!sameStableArchiveStat(directory.initialStat, currentStat)
      || !sameStableArchiveStat(directory.initialStat, descriptorStat)
      || !sameStableArchiveStat(directory.initialStat, pathStat)) {
    throw new GitHubWorkflowError(
      `${directory.label} does not match the verified current working directory`,
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
}

function assertNestedArchivePrior(fileSystem, priorDirectory, expectedPriorDirectory) {
  if (!expectedPriorDirectory) return;
  const expectedDescriptorStat = fileSystem.fstatSync(expectedPriorDirectory.fd, { bigint: true });
  assertImmutableArchiveDirectory(expectedDescriptorStat, expectedPriorDirectory.label);
  if (!sameStableArchiveStat(priorDirectory.initialStat, expectedPriorDirectory.initialStat)
      || !sameStableArchiveStat(priorDirectory.initialStat, expectedDescriptorStat)) {
    throw new GitHubWorkflowError(
      'Nested archive scope does not start in its authorized outer directory',
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  assertImmutableArchiveDirectoryStable(fileSystem, expectedPriorDirectory);
}

function assertSynchronousArchiveResult(result) {
  if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
    let then;
    try {
      then = result.then;
    } catch (error) {
      throw new GitHubWorkflowError(
        `Archive scope returned an unreadable thenable: ${error.message}`,
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
    if (typeof then === 'function') {
      throw new GitHubWorkflowError(
        'Archive working-directory scope must remain fully synchronous',
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
  }
  return result;
}

function archiveRestorationError(error, outermost) {
  const failure = new GitHubWorkflowError(
    `Immutable archive working-directory restoration failed: ${error.message}`,
    'ARCHIVE_EVIDENCE_INVALID',
  );
  if (outermost) markFatalArchiveCwd(failure);
  return failure;
}

function markFatalArchiveCwd(error) {
  darwinArchiveCwdPoisoned = true;
  Object.defineProperty(error, FATAL_ARCHIVE_CWD, { value: true });
  return error;
}

function archivePreTargetCwdError(error) {
  return markFatalArchiveCwd(new GitHubWorkflowError(
    `Immutable archive current working directory became unprovable before target traversal: ${error.message}`,
    'ARCHIVE_EVIDENCE_INVALID',
  ));
}

function closeArchiveDescriptor(fileSystem, directory, priorError) {
  if (!directory) return priorError;
  try {
    fileSystem.closeSync(directory.fd);
    return priorError;
  } catch (error) {
    return priorError ?? new GitHubWorkflowError(
      `Immutable archive descriptor could not be closed: ${error.message}`,
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
}

function withDarwinArchiveDirectory({
  fileSystem,
  runtime,
  owner,
  openPath,
  stabilityPath,
  label,
  expectedPriorDirectory = null,
  outermost = false,
}, callback) {
  if (activeDarwinArchiveOwner !== owner) {
    throw new GitHubWorkflowError(
      'Darwin archive directory scope lacks its outer operation owner',
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  let initialDirectory = null;
  let priorPath;
  let priorDirectory = null;
  let targetDirectory = null;
  let targetChdirAttempted = false;
  let result;
  let operationError = null;
  let restorationError = null;
  let closeError = null;
  try {
    initialDirectory = openImmutableArchiveDirectory(
      fileSystem, '.', `${label} initial working directory`, '.',
    );
    assertCurrentArchiveDirectory(fileSystem, initialDirectory);
    priorPath = runtime.cwd();
    priorDirectory = openImmutableArchiveDirectory(
      fileSystem, priorPath, `${label} saved prior working directory`, priorPath,
    );
    assertCurrentArchiveDirectory(fileSystem, initialDirectory);
    assertCurrentArchiveDirectory(fileSystem, priorDirectory);
    assertNestedArchivePrior(fileSystem, priorDirectory, expectedPriorDirectory);
    targetDirectory = openImmutableArchiveDirectory(
      fileSystem, openPath, label, stabilityPath,
    );
    targetChdirAttempted = true;
    runtime.chdir(openPath);
    assertCurrentArchiveDirectory(fileSystem, targetDirectory);
    result = assertSynchronousArchiveResult(runtime.runSynchronous(
      () => callback(targetDirectory),
    ));
    assertCurrentArchiveDirectory(fileSystem, targetDirectory);
  } catch (error) {
    operationError = error;
  } finally {
    if (targetChdirAttempted) {
      try {
        runtime.chdir(priorPath);
        if (!initialDirectory || !priorDirectory) {
          throw new GitHubWorkflowError(
            `${label} saved prior working directory could not be proved`,
            'ARCHIVE_EVIDENCE_INVALID',
          );
        }
        assertCurrentArchiveDirectory(fileSystem, priorDirectory);
        assertCurrentArchiveDirectory(fileSystem, initialDirectory);
        assertNestedArchivePrior(fileSystem, priorDirectory, expectedPriorDirectory);
      } catch (error) {
        restorationError = archiveRestorationError(error, outermost);
      }
    } else if (initialDirectory) {
      try {
        assertCurrentArchiveDirectory(fileSystem, initialDirectory);
      } catch (error) {
        restorationError = archivePreTargetCwdError(error);
      }
    }
    closeError = closeArchiveDescriptor(fileSystem, targetDirectory, closeError);
    closeError = closeArchiveDescriptor(fileSystem, priorDirectory, closeError);
    closeError = closeArchiveDescriptor(fileSystem, initialDirectory, closeError);
  }
  if (restorationError) throw restorationError;
  if (closeError) throw closeError;
  if (operationError) throw operationError;
  return result;
}

function withDarwinArchiveOperation(runtime, callback) {
  if (runtime.isMainThread !== true) {
    throw new GitHubWorkflowError(
      'Darwin archive traversal is supported only on the main thread',
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  if (darwinArchiveCwdPoisoned) {
    const error = new GitHubWorkflowError(
      'Darwin archive traversal is unavailable after an unprovable cwd restoration',
      'ARCHIVE_EVIDENCE_INVALID',
    );
    Object.defineProperty(error, FATAL_ARCHIVE_CWD, { value: true });
    throw error;
  }
  if (activeDarwinArchiveOwner !== null) {
    throw new GitHubWorkflowError(
      'Another Darwin archive traversal already owns the process cwd',
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  const owner = Symbol('darwin-archive-owner');
  activeDarwinArchiveOwner = owner;
  try {
    return assertSynchronousArchiveResult(callback(owner));
  } finally {
    if (activeDarwinArchiveOwner === owner) activeDarwinArchiveOwner = null;
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

function archiveRootOrNull(cwd, fileSystem) {
  const archiveRoot = join(reviewRoot(cwd), 'archive');
  try {
    fileSystem.lstatSync(archiveRoot, { bigint: true });
    return archiveRoot;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new GitHubWorkflowError(
      `Immutable archive root cannot be inspected exactly: ${error.message}`,
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
}

function canonicalArchiveNames(fileSystem, directoryPath, prNumber) {
  const namePattern = new RegExp(
    `^pr-${prNumber}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$`,
    'u',
  );
  const entryNames = fileSystem.readdirSync(directoryPath, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => namePattern.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (entryNames.length > MAX_ARCHIVE_ENTRIES) {
    throw new GitHubWorkflowError(
      'Canonical archive inventory exceeded the node limit', 'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  return entryNames;
}

function parsedArchive(archiveId, stateText, eventsText) {
  const eventLines = eventsText.trim().split('\n').filter(Boolean);
  return {
    archiveId,
    state: JSON.parse(stateText),
    events: eventLines.map((line) => JSON.parse(line)),
  };
}

function listLinuxArchives(cwd, fileSystem, prNumber) {
  const archiveRoot = archiveRootOrNull(cwd, fileSystem);
  if (archiveRoot === null) return [];
  let rootDirectory;
  try {
    rootDirectory = openImmutableArchiveDirectory(fileSystem, archiveRoot, 'Archive root');
    const pinnedRoot = `/proc/self/fd/${rootDirectory.fd}`;
    const entryNames = canonicalArchiveNames(fileSystem, pinnedRoot, prNumber);
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
      archives.push(parsedArchive(entryName, stateText, eventsText));
    }
    assertImmutableArchiveDirectoryStable(fileSystem, rootDirectory);
    return archives;
  } finally {
    if (rootDirectory) fileSystem.closeSync(rootDirectory.fd);
  }
}

function listDarwinArchives(cwd, fileSystem, runtime, prNumber, owner) {
  const archiveRoot = archiveRootOrNull(cwd, fileSystem);
  if (archiveRoot === null) return [];
  return withDarwinArchiveDirectory({
    fileSystem,
    runtime,
    owner,
    openPath: archiveRoot,
    stabilityPath: archiveRoot,
    label: 'Archive root',
    outermost: true,
  }, (rootDirectory) => {
    const entryNames = canonicalArchiveNames(fileSystem, '.', prNumber);
    const archives = [];
    for (const entryName of entryNames) {
      const absoluteDirectoryPath = join(archiveRoot, entryName);
      const texts = withDarwinArchiveDirectory({
        fileSystem,
        runtime,
        owner,
        openPath: entryName,
        stabilityPath: absoluteDirectoryPath,
        label: `Canonical archive ${entryName}`,
        expectedPriorDirectory: rootDirectory,
      }, (directory) => {
        const stateText = readImmutableArchiveFile(
          fileSystem, 'state.json', `${entryName}/state.json`, MAX_ARCHIVED_STATE_BYTES,
        );
        const eventsText = readImmutableArchiveFile(
          fileSystem, 'events.ndjson', `${entryName}/events.ndjson`, MAX_ARCHIVED_EVENTS_BYTES,
        );
        assertImmutableArchiveDirectoryStable(fileSystem, directory);
        return { stateText, eventsText };
      });
      archives.push(parsedArchive(entryName, texts.stateText, texts.eventsText));
    }
    assertImmutableArchiveDirectoryStable(fileSystem, rootDirectory);
    return archives;
  });
}

export function createDefaultArchiveStore(
  cwd = process.cwd(), fileSystemOverrides = {}, runtimeOverrides = {},
) {
  const fileSystem = { ...DEFAULT_ARCHIVE_FS, ...fileSystemOverrides };
  const runtime = { ...DEFAULT_ARCHIVE_RUNTIME, ...runtimeOverrides };
  return {
    async list(prNumber) {
      try {
        if (runtime.platform === 'linux') {
          return listLinuxArchives(cwd, fileSystem, prNumber);
        }
        if (runtime.platform === 'darwin') {
          return withDarwinArchiveOperation(
            runtime,
            (owner) => listDarwinArchives(cwd, fileSystem, runtime, prNumber, owner),
          );
        }
        throw new GitHubWorkflowError(
          `Immutable archive traversal is unsupported on ${runtime.platform}`,
          'ARCHIVE_EVIDENCE_INVALID',
        );
      } catch (error) {
        if (error instanceof GitHubWorkflowError) throw error;
        throw new GitHubWorkflowError(
          `Immutable archive evidence cannot be read exactly: ${error.message}`,
          'ARCHIVE_EVIDENCE_INVALID',
        );
      }
    },
  };
}

export function terminateOnFatalArchiveCwd(error, runtime = process) {
  if (error?.[FATAL_ARCHIVE_CWD] !== true) return false;
  runtime.stderr.write(`${error.code ?? 'ARCHIVE_EVIDENCE_INVALID'}: ${error.message}\n`);
  runtime.exit(1);
  return true;
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
