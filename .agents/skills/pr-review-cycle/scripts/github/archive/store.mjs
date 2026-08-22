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
import { isMainThread } from 'node:worker_threads';

import { reviewRoot } from '../../state/state.mjs';
import { GitHubWorkflowError } from '../errors.mjs';

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
