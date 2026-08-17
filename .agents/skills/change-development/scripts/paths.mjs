import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitText } from '../../../../scripts/lib/git.mjs';

export const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const skillDirectory = dirname(scriptsDirectory);
export const schemaDirectory = join(skillDirectory, 'schemas');
export const implementationPlanSchemaPath = join(schemaDirectory, 'implementation-plan.schema.json');
export const developmentStateSchemaPath = join(schemaDirectory, 'development-state.schema.json');

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

export function validateChangeId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError('changeId must be a lowercase-hyphen stable ID of at most 128 characters');
  }
  return value;
}
