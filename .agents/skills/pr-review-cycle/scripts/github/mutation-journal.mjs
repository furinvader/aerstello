import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  claimGitHubMutationDispatch,
  ensureGitHubMutationIntent,
  stateDirectory,
  withGitHubRequestOwnerLock,
} from '../state/state.mjs';

const DEFAULT_JOURNAL_OPERATIONS = {
  claimGitHubMutationDispatch,
  ensureGitHubMutationIntent,
  stateDirectory,
  withGitHubRequestOwnerLock,
};

export function createDefaultMutationJournal(
  cwd,
  prNumber,
  operations = DEFAULT_JOURNAL_OPERATIONS,
) {
  const path = join(operations.stateDirectory(cwd, prNumber), 'events.ndjson');
  function lookupIntent(operationId) {
    const events = existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line))
      : [];
    const existing = events.find((event) => event.type === 'github-mutation-intent'
      && event.details?.operationId === operationId);
    return existing ? { ...existing.details, isNew: false } : null;
  }
  return {
    lookupIntent,
    ensureIntent(intent) {
      return operations.ensureGitHubMutationIntent(cwd, prNumber, intent);
    },
    claimDispatch(intent, expectedRevision) {
      return operations.claimGitHubMutationDispatch(cwd, prNumber, intent, expectedRevision);
    },
    withRequestOwner(callback) {
      return operations.withGitHubRequestOwnerLock(cwd, prNumber, callback);
    },
  };
}
