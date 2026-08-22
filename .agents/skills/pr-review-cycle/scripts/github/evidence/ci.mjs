import { GitHubWorkflowError } from '../errors.mjs';
import { httpsUrl } from './primitives.mjs';

export const FULL_VALIDATION_CHECK = 'Full validation';
export const GITHUB_ACTIONS_APP = 'github-actions';
export const FULL_VALIDATION_WORKFLOW = 'CI';
export const FULL_VALIDATION_WORKFLOW_PATH = '.github/workflows/ci.yml';

export function ciEvidenceFromRollup(snapshot) {
  const checkRuns = snapshot.contexts.filter((context) => context?.__typename === 'CheckRun');
  const candidates = checkRuns.filter((check) => check.name === FULL_VALIDATION_CHECK
    && check.checkSuite?.app?.slug === GITHUB_ACTIONS_APP);
  if (candidates.length === 0) {
    throw new GitHubWorkflowError('The authoritative Full validation GitHub Actions check is missing', 'CI_CHECK_MISSING');
  }
  const namedChecks = [...new Set(candidates.map((check) => check.name))].sort();
  const checkRunIds = new Set();
  const runs = new Map();
  for (const check of candidates) {
    const workflowRun = check.checkSuite?.workflowRun;
    if (typeof workflowRun?.workflow?.name !== 'string' || typeof workflowRun?.file?.path !== 'string') {
      throw new GitHubWorkflowError('Full validation lacks authoritative workflow identity', 'CI_EVIDENCE_INCOMPLETE');
    }
    if (workflowRun.workflow.name !== FULL_VALIDATION_WORKFLOW
        || workflowRun.file.path !== FULL_VALIDATION_WORKFLOW_PATH) {
      throw new GitHubWorkflowError('Full validation came from an unexpected workflow', 'CI_WORKFLOW_MISMATCH');
    }
    if (typeof check.id !== 'string' || check.id.length === 0
        || !Number.isInteger(workflowRun.databaseId) || workflowRun.databaseId < 1
        || !httpsUrl(workflowRun.url) || typeof check.status !== 'string' || check.status.length === 0) {
      throw new GitHubWorkflowError('Full validation lacks authoritative run identity', 'CI_EVIDENCE_INCOMPLETE');
    }
    if (checkRunIds.has(check.id)) {
      throw new GitHubWorkflowError('Full validation check-run identity is duplicated', 'CI_EVIDENCE_AMBIGUOUS');
    }
    checkRunIds.add(check.id);
    if (check.status === 'COMPLETED'
        && (!check.completedAt || !Number.isFinite(Date.parse(check.completedAt))
          || typeof check.conclusion !== 'string' || check.conclusion.length === 0)) {
      throw new GitHubWorkflowError('Completed Full validation lacks completion metadata', 'CI_EVIDENCE_INCOMPLETE');
    }
    const group = runs.get(workflowRun.databaseId) ?? { urls: new Set(), attempts: [] };
    group.urls.add(workflowRun.url);
    group.attempts.push(check);
    runs.set(workflowRun.databaseId, group);
  }
  if ([...runs.values()].some((run) => run.urls.size !== 1)) {
    throw new GitHubWorkflowError('Full validation workflow-run identity is ambiguous', 'CI_EVIDENCE_AMBIGUOUS');
  }
  if (candidates.some((check) => check.status !== 'COMPLETED')) {
    throw new GitHubWorkflowError('Full validation is still pending', 'CI_VALIDATION_PENDING');
  }
  const effective = [];
  for (const [runId, run] of runs) {
    const latestTime = Math.max(...run.attempts.map((check) => Date.parse(check.completedAt)));
    const latest = run.attempts.filter((check) => Date.parse(check.completedAt) === latestTime);
    if (latest.length !== 1) {
      throw new GitHubWorkflowError('Latest Full validation attempt is ambiguous', 'CI_EVIDENCE_AMBIGUOUS');
    }
    effective.push({ check: latest[0], runId });
  }
  const failed = effective.filter(({ check }) => check.conclusion !== 'SUCCESS');
  const representatives = failed.length > 0 ? failed : effective;
  representatives.sort((left, right) => Date.parse(right.check.completedAt) - Date.parse(left.check.completedAt)
    || right.runId - left.runId);
  const selected = representatives[0].check;
  const workflowRun = selected.checkSuite?.workflowRun;
  const passed = failed.length === 0;
  return {
    source: 'github-actions', scope: 'full', status: passed ? 'passed' : 'failed',
    headSha: snapshot.headSha, checks: namedChecks,
    checkRunId: selected.id, workflowRunId: workflowRun.databaseId, workflowRunUrl: workflowRun.url,
    updatedAt: selected.completedAt,
  };
}
