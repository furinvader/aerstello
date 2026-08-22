import { GitHubWorkflowError } from '../errors.mjs';
import { ciEvidenceFromRollup } from '../evidence/ci.mjs';
import {
  readPullRequestChecks,
  readPullRequestMetadata,
} from '../graphql/pull-request-reader.mjs';
import { assertPullRequestReady } from '../mutation-readiness.mjs';

export function sameCiEvidence(left, right) {
  return left.source === right.source && left.scope === right.scope
    && left.status === right.status && left.headSha === right.headSha
    && left.checkRunId === right.checkRunId
    && left.workflowRunId === right.workflowRunId && left.workflowRunUrl === right.workflowRunUrl
    && left.updatedAt === right.updatedAt
    && left.checks.length === right.checks.length
    && left.checks.every((check, index) => check === right.checks[index]);
}

export function createCollectCiUseCase(context) {
  const { client, stateAdapter, load } = context;
  async function collectCi(prNumber) {
    let active = await load(prNumber);
    const priorRevision = active.revision;
    const metadata = await readPullRequestMetadata(client, active.repository, active.prNumber);
    assertPullRequestReady({ metadata });
    if (metadata.headRefOid !== active.currentIntegrationHeadSha) {
      throw new GitHubWorkflowError('Live PR HEAD does not match the integration HEAD', 'CI_HEAD_MISMATCH');
    }
    const snapshot = await readPullRequestChecks(
      client, active.repository, active.prNumber, active.currentIntegrationHeadSha,
    );
    const evidence = ciEvidenceFromRollup(snapshot);
    if (!stateAdapter.checkpointCiValidation) {
      throw new GitHubWorkflowError('The CI validation state checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    try {
      active = await stateAdapter.checkpointCiValidation({
        prNumber: active.prNumber, expectedRevision: active.revision, evidence,
      });
    } catch (error) {
      if (error?.code !== 'STATE_REVISION_CONFLICT') throw error;
      active = await load(prNumber);
      if (!sameCiEvidence(active.ciValidationStatus, evidence)) throw error;
      return { evidence: active.ciValidationStatus, phase: active.phase, revision: active.revision, performed: false };
    }
    return { evidence: active.ciValidationStatus, phase: active.phase, revision: active.revision,
      performed: active.revision !== priorRevision };
  }
  return collectCi;
}
