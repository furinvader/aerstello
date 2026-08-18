import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitText } from '../../../../scripts/lib/git.mjs';

export const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const skillDirectory = dirname(scriptsDirectory);
export const schemaDirectory = join(skillDirectory, 'schemas');
export const implementationPlanSchemaPath = join(schemaDirectory, 'implementation-plan.schema.json');
export const developmentStateSchemaPath = join(schemaDirectory, 'development-state.schema.json');
export const implementationTaskSchemaPath = join(schemaDirectory, 'implementation-task.schema.json');
export const implementationResultSchemaPath = join(schemaDirectory, 'implementation-result.schema.json');

export function repositoryRoot(cwd = process.cwd()) {
  return gitText(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd });
}

export function gitCommonDirectory(cwd = process.cwd()) {
  return gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

export function changeRoot(cwd = process.cwd()) {
  return join(gitCommonDirectory(cwd), 'codex', 'change-development');
}

export function activePointerPath(cwd = process.cwd()) {
  return join(changeRoot(cwd), 'active.json');
}

export function changeDirectory(cwd, changeId) {
  return join(changeRoot(cwd), 'changes', validateChangeId(changeId));
}

export function archiveDirectory(cwd, changeId) {
  return join(changeRoot(cwd), 'archives', validateChangeId(changeId));
}

export function implementationWorktreeRoot(cwd = process.cwd()) {
  return join(changeRoot(cwd), 'worktrees');
}

export function implementationWorktreePath(cwd, changeId, taskId) {
  return join(implementationWorktreeRoot(cwd), 'changes', validateChangeId(changeId), validateTaskId(taskId));
}

export function implementationWorktreeManifestPath(cwd, changeId, taskId) {
  return join(implementationWorktreeRoot(cwd), 'manifests', validateChangeId(changeId), `${validateTaskId(taskId)}.json`);
}

export function implementationWorktreeCreationIntentPath(cwd, changeId, taskId) {
  return join(implementationWorktreeRoot(cwd), 'manifests', validateChangeId(changeId), `${validateTaskId(taskId)}.creation.json`);
}

export function implementationWorktreeTombstonePath(cwd, changeId, taskId) {
  return join(implementationWorktreeRoot(cwd), 'tombstones', validateChangeId(changeId), `${validateTaskId(taskId)}.json`);
}

export function implementationWorktreeRemovalIntentPath(cwd, changeId, taskId) {
  return join(implementationWorktreeRoot(cwd), 'tombstones', validateChangeId(changeId), `${validateTaskId(taskId)}.removal.json`);
}

export function implementationTaskPacketPath(cwd, changeId, taskId, binding) {
  if (!Number.isInteger(binding) || binding < 1) throw new TypeError('binding must be a positive integer');
  return join(changeDirectory(cwd, changeId), 'implementation', 'tasks', validateTaskId(taskId), `${String(binding).padStart(4, '0')}.json`);
}

export function validateChangeId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError('changeId must be a lowercase-hyphen stable ID of at most 128 characters');
  }
  return value;
}
export function validateTaskId(value) {
  try { return validateChangeId(value); }
  catch { throw new TypeError('taskId must be a lowercase-hyphen stable ID of at most 128 characters'); }
}
