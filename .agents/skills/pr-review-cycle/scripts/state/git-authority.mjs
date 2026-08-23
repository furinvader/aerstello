import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitText, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { StateError } from './errors.mjs';

const AUTHORITY_GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function runAuthorityGit(args, options = {}) {
  return runGit(['--no-replace-objects', ...args], options);
}

function authorityGitText(args, options = {}) {
  return String(runAuthorityGit(args, { ...options, encoding: 'utf8' }).stdout).trim();
}

function assertLegacyGraftsAreInert(cwd) {
  let commonGitDirectory;
  try {
    commonGitDirectory = authorityGitText([
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], { cwd });
  } catch (error) {
    throw new StateError(
      `Unable to resolve the common Git directory for worker authority: ${error.message}`,
      'WORKER_RESULT_GIT_AUTHORITY_UNAVAILABLE',
    );
  }
  if (commonGitDirectory === '') {
    throw new StateError(
      'Unable to resolve the common Git directory for worker authority',
      'WORKER_RESULT_GIT_AUTHORITY_UNAVAILABLE',
    );
  }
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  let grafts;
  try {
    grafts = statSync(graftsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new StateError(
      `Unable to inspect legacy Git graft authority at ${graftsPath}: ${error.message}`,
      'WORKER_RESULT_GIT_AUTHORITY_UNAVAILABLE',
    );
  }
  if (grafts.size > 0) {
    throw new StateError(
      `Worker authority refuses nonempty legacy Git grafts at ${graftsPath}`,
      'WORKER_RESULT_LEGACY_GRAFTS_PRESENT',
    );
  }
}

function assertCommitExists(cwd, label, sha, code = 'INVALID_WORKER_RESULT') {
  if (typeof sha !== 'string'
      || runAuthorityGit(['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFailure: true }).status !== 0) {
    throw new StateError(`${label} does not name an existing Git commit: ${sha}`, code);
  }
}

function soleCommitParent(cwd, label, sha, code) {
  assertCommitExists(cwd, label, sha, code);
  const fields = authorityGitText(['rev-list', '--parents', '-n', '1', sha], { cwd }).split(/\s+/u);
  if (fields.length !== 2) {
    const kind = fields.length === 1 ? 'root' : 'merge';
    throw new StateError(`${label} must be one non-root, non-merge commit; ${sha} is a ${kind} commit`, code);
  }
  return fields[1];
}

function workerCommitPatch(cwd, parentSha, commitSha) {
  return Buffer.from(runAuthorityGit([
    '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=false',
    'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', '--submodule=short', '--no-color',
    '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0',
    parentSha, commitSha, '--',
  ], { cwd, encoding: null }).stdout ?? Buffer.alloc(0));
}

function commitChangedPaths(cwd, parentSha, commitSha) {
  const output = Buffer.from(runAuthorityGit([
    'diff', '--name-only', '--no-renames', '--ignore-submodules=none', '-z',
    parentSha, commitSha, '--',
  ], { cwd, encoding: null }).stdout ?? Buffer.alloc(0));
  return output.toString('utf8').split('\0').filter(Boolean);
}

function isolatedAuthorityGit(args, { cwd, env, input = undefined }) {
  return spawnSync('git', ['--no-replace-objects', ...args], {
    cwd,
    env,
    input,
    encoding: null,
    maxBuffer: AUTHORITY_GIT_MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
}

function assertIsolatedGitSucceeded(result, message) {
  if (result.error || result.status !== 0) {
    throw new StateError(message, 'WORKER_RESULT_EXACT_DELTA_MISMATCH');
  }
}

function proveWorkerPatchProducesCentralTree({
  cwd, workerPatch, centralParentSha, centralCommitSha,
}) {
  const centralTreeSha = authorityGitText([
    'rev-parse', '--verify', '--end-of-options', `${centralCommitSha}^{tree}`,
  ], { cwd });
  const realObjectDirectory = authorityGitText([
    'rev-parse', '--path-format=absolute', '--git-path', 'objects',
  ], { cwd });
  const objectFormat = authorityGitText(['rev-parse', '--show-object-format'], { cwd });
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new StateError(
      `Unsupported worker-authority object format: ${objectFormat}`,
      'WORKER_RESULT_GIT_AUTHORITY_UNAVAILABLE',
    );
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), `aerstello-worker-authority-${process.pid}-`));
  try {
    const temporaryGitDirectory = join(temporaryRoot, 'git');
    const temporaryObjectDirectory = join(temporaryGitDirectory, 'objects');
    const temporaryIndex = join(temporaryGitDirectory, 'index');
    const temporaryGlobalConfig = join(temporaryRoot, 'global-config');
    const temporaryXdgConfig = join(temporaryRoot, 'xdg');
    mkdirSync(join(temporaryGitDirectory, 'refs', 'heads'), { recursive: true });
    mkdirSync(join(temporaryGitDirectory, 'info'), { recursive: true });
    mkdirSync(join(temporaryObjectDirectory, 'info'), { recursive: true });
    mkdirSync(temporaryXdgConfig, { recursive: true });
    writeFileSync(join(temporaryGitDirectory, 'HEAD'), 'ref: refs/heads/authority\n');
    const temporaryRepositoryConfig = [
      '[core]',
      `\trepositoryformatversion = ${objectFormat === 'sha1' ? 0 : 1}`,
      '\tbare = true',
    ];
    if (objectFormat !== 'sha1') {
      temporaryRepositoryConfig.push('[extensions]', `\tobjectformat = ${objectFormat}`);
    }
    temporaryRepositoryConfig.push('');
    writeFileSync(join(temporaryGitDirectory, 'config'), temporaryRepositoryConfig.join('\n'));
    writeFileSync(join(temporaryGitDirectory, 'info', 'attributes'), '* merge=text\n');
    writeFileSync(join(temporaryObjectDirectory, 'info', 'alternates'), `${realObjectDirectory}\n`);
    writeFileSync(temporaryGlobalConfig, '');
    const isolatedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    );
    Object.assign(isolatedEnv, {
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: temporaryGlobalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_DIR: temporaryGitDirectory,
      GIT_INDEX_FILE: temporaryIndex,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OBJECT_DIRECTORY: temporaryObjectDirectory,
      GIT_OPTIONAL_LOCKS: '0',
      XDG_CONFIG_HOME: temporaryXdgConfig,
    });
    const seeded = isolatedAuthorityGit(['read-tree', centralParentSha], {
      cwd: temporaryRoot, env: isolatedEnv,
    });
    assertIsolatedGitSucceeded(
      seeded,
      'Unable to seed isolated worker-authority index from the central commit parent',
    );
    const applied = isolatedAuthorityGit([
      '-c', 'apply.ignoreWhitespace=no', '-c', 'apply.whitespace=warn',
      'apply', '--cached', '--3way', '--whitespace=warn',
    ], { cwd: temporaryRoot, env: isolatedEnv, input: workerPatch });
    assertIsolatedGitSucceeded(
      applied,
      'Worker patch does not apply cleanly to the central commit parent',
    );
    const written = isolatedAuthorityGit(['write-tree'], {
      cwd: temporaryRoot, env: isolatedEnv,
    });
    assertIsolatedGitSucceeded(written, 'Unable to write the isolated worker-authority tree');
    const appliedTreeSha = Buffer.from(written.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
    if (appliedTreeSha !== centralTreeSha) {
      throw new StateError(
        'Worker patch applied to the central parent does not produce the central commit tree',
        'WORKER_RESULT_EXACT_DELTA_MISMATCH',
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function inspectWorkerCommitAuthority({ cwd = process.cwd(), state, packet, result, centralCommitSha = null }) {
  const integrationCwd = state.integrationWorktree ?? cwd;
  assertLegacyGraftsAreInert(integrationCwd);
  const isAncestor = (ancestor, descendant) => runAuthorityGit(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { cwd: integrationCwd, allowFailure: true },
  ).status === 0;
  assertCommitExists(integrationCwd, 'reviewed HEAD', packet.reviewedHeadSha);
  assertCommitExists(integrationCwd, 'current integration HEAD', state.currentIntegrationHeadSha,
    'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH');
  if (result.commitSha === packet.reviewedHeadSha) {
    throw new StateError(
      'Worker result commit must not equal the task packet reviewed HEAD',
      'WORKER_RESULT_COMMIT_NOT_SINGLE',
    );
  }
  const workerParentSha = soleCommitParent(
    integrationCwd, 'worker result commit', result.commitSha, 'WORKER_RESULT_COMMIT_NOT_SINGLE',
  );
  if (!isAncestor(packet.reviewedHeadSha, workerParentSha)) {
    throw new StateError(
      'Worker result parent does not descend from the task packet reviewed HEAD',
      'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH',
    );
  }
  if (!isAncestor(workerParentSha, state.currentIntegrationHeadSha)) {
    throw new StateError(
      'Worker result parent is absent from the current integration history',
      'WORKER_RESULT_PARENT_ANCESTRY_MISMATCH',
    );
  }
  for (const dependencyId of packet.dependencies) {
    const dependency = state.tasks.find((candidate) => candidate.id === dependencyId);
    if (!dependency || !['integrated', 'completed'].includes(dependency.status)
        || typeof dependency.integratedCommitSha !== 'string') {
      throw new StateError(
        `Task ${packet.taskId} dependency ${dependencyId} is not durably integrated`,
        'WORKER_RESULT_DEPENDENCY_NOT_READY',
      );
    }
    if (!isAncestor(dependency.integratedCommitSha, state.currentIntegrationHeadSha)
        || !isAncestor(dependency.integratedCommitSha, workerParentSha)) {
      throw new StateError(
        `Task ${packet.taskId} dependency ${dependencyId} is absent from required Git ancestry`,
        'WORKER_RESULT_DEPENDENCY_ANCESTRY_MISMATCH',
      );
    }
  }
  const workerPatch = workerCommitPatch(integrationCwd, workerParentSha, result.commitSha);
  const inspection = {
    workerCommitSha: result.commitSha,
    workerParentSha,
    changedPaths: commitChangedPaths(integrationCwd, workerParentSha, result.commitSha),
    deltaIdentity: createHash('sha256').update(workerPatch).digest('hex'),
  };
  if (centralCommitSha === null) return inspection;

  assertCommitExists(
    integrationCwd, 'central integration commit', centralCommitSha,
    'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH',
  );
  const centralParentSha = soleCommitParent(
    integrationCwd, 'central integration commit', centralCommitSha,
    'WORKER_RESULT_INTEGRATION_COMMIT_NOT_SINGLE',
  );
  if (!isAncestor(workerParentSha, centralParentSha)) {
    throw new StateError(
      `Task ${packet.taskId} central commit parent does not descend from the worker result parent`,
      'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH',
    );
  }
  if (!isAncestor(centralCommitSha, state.currentIntegrationHeadSha)) {
    throw new StateError(
      `Task ${packet.taskId} central commit is not on the integration HEAD`,
      'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH',
    );
  }
  proveWorkerPatchProducesCentralTree({
    cwd: integrationCwd,
    workerPatch,
    centralParentSha,
    centralCommitSha,
  });
  return {
    ...inspection,
    centralCommitSha,
    centralParentSha,
  };
}

export function assertIntegratedWorkerCommit(cwd, state, task, packet, result) {
  const centralCommitSha = task.status === 'implemented'
    ? state.currentIntegrationHeadSha : task.integratedCommitSha;
  if (typeof centralCommitSha !== 'string') {
    throw new StateError(
      `Task ${task.id} has no central integration commit`,
      'WORKER_RESULT_INTEGRATION_ANCESTRY_MISMATCH',
    );
  }
  return inspectWorkerCommitAuthority({ cwd, state, packet, result, centralCommitSha });
}


export function gitSnapshot(cwd) {
  const branchResult = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, allowFailure: true });
  return {
    branch: branchResult.status === 0 ? String(branchResult.stdout).trim() : null,
    headSha: resolveCommit(cwd, 'HEAD'),
    dirty: gitText(['status', '--porcelain'], { cwd }).length > 0,
  };
}
