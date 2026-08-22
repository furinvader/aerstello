function titleCase(value) {
  return String(value ?? 'unknown').split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function renderHumanStatus(status) {
  const headMatches = status.stateHeadSha === status.liveHeadSha;
  const headRelation = headMatches ? 'matches PR head' : `DOES NOT MATCH PR head ${status.liveHeadSha}`;
  const review = !headMatches && status.codexReview === 'clean' ? 'Stale clean evidence (commit mismatch)'
    : status.codexReview === 'clean' ? 'Clean'
    : status.codexReview === 'findings' ? 'Findings need resolution'
      : status.codexReview === 'awaiting' ? 'Awaiting Codex'
        : status.codexReview === 'stale' ? 'Stale review evidence (commit mismatch)' : 'Not requested';
  const tasks = status.statePhase === 'complete' && headMatches ? 'Done'
    : `${status.taskStatus.resolved} Resolved, ${status.taskStatus.pending} pending`;
  const taskRows = status.taskStatus.items.map((task) => {
    const taskStatus = !headMatches && task.status === 'Done' ? 'Resolved (stale head)' : task.status;
    return `  - ${task.id}: ${taskStatus} — ${task.summary}`;
  });
  const targeted = status.targetedValidation?.status === 'passed'
    ? `Passed (${status.targetedValidation.checks.join(', ')})${headMatches ? '' : ' for the recorded commit; PR head differs'}`
    : titleCase(status.targetedValidation?.status);
  const ci = status.liveCiValidation?.status === 'passed'
    ? `Passed (${status.liveCiValidation.checks.join(', ')}) — ${status.liveCiValidation.workflowRunUrl}${headMatches ? '' : ' (live PR head differs from the recorded commit)'}`
    : status.liveCiValidation?.status === 'failed'
      ? `Failed — ${status.liveCiValidation.workflowRunUrl}`
      : titleCase(status.liveCiValidation?.status);
  const specialistStatus = status.specialistReviews?.status ?? 'missing';
  const specialistReviewers = status.specialistReviews?.requiredReviewerIds ?? [];
  const specialists = `${titleCase(specialistStatus)}${specialistReviewers.length > 0
    ? ` (required: ${specialistReviewers.join(', ')})` : ''}`;
  return [
    `PR: #${status.prNumber}`,
    `PR readiness: ${status.pullRequest?.state ?? 'unknown'}${status.pullRequest?.isDraft ? ' draft' : ''}`,
    `Live review observation: ${titleCase(status.reviewObservation?.status)}`,
    `Current commit: ${status.stateHeadSha} (${headRelation})`,
    `Phase: ${status.statePhase === 'complete' && headMatches ? 'Done'
      : status.statePhase === 'complete' ? 'Stale (recorded Done; PR head changed)'
        : titleCase(status.statePhase)}`,
    `Codex review: ${review}`,
    `Review requests: ${status.reviewRequests.used}; limit: ${status.reviewRequests.limit ?? 'unlimited'}`,
    `Tasks: ${tasks}`,
    ...taskRows,
    `Targeted local tests: ${targeted}`,
    `Specialist reviews: ${specialists}`,
    `Full CI: ${ci}`,
    `Open Codex threads: ${status.openCodexThreads}`,
    `Next action: ${headMatches ? status.nextAction
      : `Reconcile recorded commit with live PR head ${status.liveHeadSha}. Recorded next action: ${status.nextAction}`}`,
  ].join('\n');
}
