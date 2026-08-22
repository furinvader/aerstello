import { GitHubWorkflowError } from './errors.mjs';

export function assertPullRequestReady(live) {
  if (live.metadata.state !== 'OPEN') {
    throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
  }
  if (live.metadata.isDraft) {
    throw new GitHubWorkflowError('Pull request is still a draft', 'PR_DRAFT');
  }
}

export async function assertMutationReady({ state, git }, live, { requireReady = true } = {}) {
  if (requireReady) assertPullRequestReady(live);
  const local = await git.snapshot(state.integrationWorktree);
  const pushedHeadSha = await git.pushedHead(state.integrationWorktree);
  const expected = state.currentIntegrationHeadSha;
  if (local.dirty) throw new GitHubWorkflowError('Integration checkout is dirty', 'MUTATION_NOT_READY');
  for (const [label, sha] of [
    ['local HEAD', local.headSha], ['pushed remote HEAD', pushedHeadSha], ['live PR HEAD', live.metadata.headRefOid],
  ]) if (sha !== expected) throw new GitHubWorkflowError(`${label} does not match state HEAD`, 'MUTATION_NOT_READY');
  const verifiedAncestors = new Set();
  for (const task of state.tasks) {
    if (task.disposition === 'actionable' && ['integrated', 'completed'].includes(task.status)) {
      if (!task.integratedCommitSha || !(await git.isAncestor(task.integratedCommitSha, expected, state.integrationWorktree))) {
        throw new GitHubWorkflowError(`Task ${task.id} integration is not an ancestor`, 'MUTATION_NOT_READY');
      }
      verifiedAncestors.add(`${task.integratedCommitSha}:${expected}`);
    }
  }
  return {
    localHeadSha: local.headSha,
    localDirty: local.dirty,
    pushedHeadSha,
    isAncestor: (ancestor, descendant) => verifiedAncestors.has(`${ancestor}:${descendant}`),
  };
}
