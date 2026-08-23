import { join, resolve } from 'node:path';

import { repositoryRoot } from '../../paths.mjs';
import { atomicWriteJson } from '../atomic-io.mjs';
import { checkpointProtectedStateTransaction } from '../checkpoint.mjs';
import { gitSnapshot } from '../git-authority.mjs';
import { stateDirectory } from '../locations.mjs';
import { activePrNumber } from '../state-store.mjs';
import { buildGitMetadataTransition } from '../transitions/git-metadata.mjs';

export function checkpointGitMetadata({ cwd = process.cwd(), sessionId, backup = false } = {}) {
  const selectedPr = activePrNumber(cwd);
  if (selectedPr === null) return { state: null, checkpointed: false, warning: null };
  let checkpointed = false;
  let warning = null;
  const result = checkpointProtectedStateTransaction({
    cwd,
    prNumber: selectedPr,
    transitionKind: 'git-metadata',
    transaction: (state) => {
      const currentRoot = repositoryRoot(cwd);
      if (resolve(currentRoot) !== resolve(state.integrationWorktree)) {
        return {
          nextState: state,
          result: {
            state, checkpointed: false,
            warning: 'Skipped checkpoint outside the integration worktree',
          },
          noWrite: true,
        };
      }
      if (state.orchestratorSessionId && sessionId
          && state.orchestratorSessionId !== sessionId) {
        return {
          nextState: state,
          result: {
            state, checkpointed: false,
            warning: 'Skipped checkpoint for a different session',
          },
          noWrite: true,
        };
      }
      const git = gitSnapshot(state.integrationWorktree);
      if (backup) {
        atomicWriteJson(join(stateDirectory(cwd, state.prNumber), 'state.backup.json'), state);
      }
      const nextState = buildGitMetadataTransition(state, git);
      warning = git.dirty ? 'Integration checkout is dirty' : null;
      if (nextState === state) {
        return {
          nextState: state,
          result: { state, checkpointed: false, warning },
          noWrite: true,
        };
      }
      checkpointed = true;
      return {
        nextState,
        event: {
          type: 'git-checkpoint',
          summary: `Checkpointed integration HEAD ${git.headSha}`,
        },
      };
    },
  });
  if (!checkpointed) return result;
  return { state: result, checkpointed: true, warning };
}
