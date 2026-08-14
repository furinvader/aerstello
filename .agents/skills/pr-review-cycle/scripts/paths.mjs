import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitText } from '../../../../scripts/lib/git.mjs';

export const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const skillDirectory = dirname(scriptsDirectory);
export const schemaDirectory = join(skillDirectory, 'schemas');

export const prReviewStateSchemaPath = join(schemaDirectory, 'pr-review-state.schema.json');
export const reviewFixTaskSchemaPath = join(schemaDirectory, 'review-fix-task.schema.json');
export const reviewFixResultSchemaPath = join(schemaDirectory, 'review-fix-result.schema.json');

export function gitTopLevel(startDirectory) {
  return gitText(
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    { cwd: startDirectory },
  );
}

export function repositoryDirectory() {
  return gitTopLevel(skillDirectory);
}

export function featureDirectory() {
  return join(repositoryDirectory(), 'specs', 'features');
}

export function repositoryPath(...segments) {
  return join(repositoryDirectory(), ...segments);
}

export function repositoryRoot(cwd = process.cwd()) {
  return gitTopLevel(cwd);
}

export function gitCommonDirectory(cwd = process.cwd()) {
  return gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

export function reviewRoot(cwd = process.cwd()) {
  return join(gitCommonDirectory(cwd), 'codex', 'pr-review');
}

export function taskPacketDirectory(cwd = process.cwd(), prNumber) {
  return join(reviewRoot(cwd), `pr-${Number(prNumber)}`, 'task-packets');
}

export function specialistReviewDirectory(cwd = process.cwd(), prNumber) {
  return join(reviewRoot(cwd), `pr-${Number(prNumber)}`, 'specialist-reviews');
}
