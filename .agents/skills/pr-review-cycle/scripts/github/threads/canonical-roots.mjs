import { GitHubWorkflowError } from '../errors.mjs';

export function dispositionForTask(task) {
  return task.disposition === 'actionable' ? 'fixed' : task.disposition;
}

export function canonicalRootsForTask(task, live) {
  const expectedSources = task.sourceIds.filter((source) => /^(?:thread|discussion):/u.test(source));
  if (expectedSources.length === 0) {
    throw new GitHubWorkflowError(
      `Task ${task.id} has no canonical root source`,
      'ROOT_IDENTITY_MISMATCH',
    );
  }
  const roots = new Map();
  for (const source of expectedSources) {
    const matches = live.threads.filter((thread) => thread.canonical
      && (source === `thread:${thread.id}` || source === `discussion:${thread.root.databaseId}`));
    if (matches.length !== 1) {
      throw new GitHubWorkflowError(
        `Source ${source} is missing or ambiguous`,
        'ROOT_IDENTITY_MISMATCH',
      );
    }
    roots.set(matches[0].id, matches[0]);
  }
  return [...roots.values()];
}

export function buildCanonicalRootPlan(state, live, selectedTaskId = null) {
  if (state.validationStatus.status !== 'passed'
      || state.validationStatus.headSha !== state.currentIntegrationHeadSha
      || state.validationStatus.checks.length === 0) {
    throw new GitHubWorkflowError('Current nonempty validation proof is required', 'TASK_NOT_READY');
  }
  const eligible = new Set(['integrated', 'completed', 'not-applicable']);
  const resolvableDispositions = new Set([
    'actionable', 'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
  ]);
  for (const task of state.tasks) {
    if (!eligible.has(task.status)) throw new GitHubWorkflowError(`Task ${task.id} is not integrated or completed`, 'TASK_NOT_READY');
    if (task.disposition === 'actionable'
        && (!['integrated', 'completed'].includes(task.status) || !task.integratedCommitSha)) {
      throw new GitHubWorkflowError(`Actionable task ${task.id} lacks integration proof`, 'TASK_NOT_READY');
    }
    if (task.sourceType === 'github-thread' && !resolvableDispositions.has(task.disposition)) {
      throw new GitHubWorkflowError(`Task ${task.id} disposition cannot resolve a thread`, 'TASK_NOT_READY');
    }
  }
  const selected = selectedTaskId === null ? null : state.tasks.find((task) => task.id === selectedTaskId);
  if (selectedTaskId !== null && !selected) throw new GitHubWorkflowError('Task was not found', 'TASK_NOT_FOUND');
  const tasks = state.tasks.filter((task) => task.sourceType === 'github-thread');
  const mapped = new Map();
  for (const task of tasks) {
    for (const thread of canonicalRootsForTask(task, live)) {
      const entry = mapped.get(thread.id) ?? { thread, tasks: [] };
      if (!entry.tasks.some((item) => item.id === task.id)) entry.tasks.push(task);
      mapped.set(thread.id, entry);
    }
  }
  for (const entry of mapped.values()) {
    entry.tasks.sort((left, right) => left.id.localeCompare(right.id));
    const dispositions = new Set(entry.tasks.map(dispositionForTask));
    if (dispositions.size !== 1) throw new GitHubWorkflowError('Shared root has conflicting dispositions', 'ROOT_IDENTITY_MISMATCH');
  }
  const unexpected = live.threads.filter((thread) => thread.canonical && !mapped.has(thread.id));
  if (unexpected.length > 0) throw new GitHubWorkflowError('Canonical thread has no task/source mapping', 'ROOT_IDENTITY_MISMATCH');
  const plan = [...mapped.values()].sort((left, right) => left.thread.id.localeCompare(right.thread.id));
  if (selected?.sourceType === 'github-thread' && !plan.some((entry) => entry.tasks.some((task) => task.id === selected.id))) {
    throw new GitHubWorkflowError('Selected task has no canonical root', 'ROOT_IDENTITY_MISMATCH');
  }
  if (selected && !['github-thread', 'github-threadless'].includes(selected.sourceType)) {
    throw new GitHubWorkflowError('Task is not GitHub-backed', 'TASK_NOT_FOUND');
  }
  return { plan, selected, selectedPlan: selected ? plan.filter((entry) => entry.tasks.some((task) => task.id === selected.id)) : plan };
}
