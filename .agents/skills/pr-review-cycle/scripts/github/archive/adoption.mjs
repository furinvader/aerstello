import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { GitHubWorkflowError } from '../errors.mjs';
import { canonicalJson } from '../evidence/review-response.mjs';
import { buildCanonicalRootPlan, canonicalRootsForTask } from '../threads/canonical-roots.mjs';
import { buildThreadProof } from '../threads/proof.mjs';
import { selectArchiveForBatch, validateArchiveBatchLineage } from './lineage.mjs';

const VERIFIED_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

function sameTaskIds(left, right) {
  return left.length === right.length
    && left.every((taskId, index) => taskId === right[index]);
}

function bootstrapStateProjection(state) {
  return { tasks: state.tasks, threadResolutionStatus: state.threadResolutionStatus };
}

function evidenceFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function currentBootstrapLane(state) {
  const aggregate = state.threadResolutionStatus;
  const candidates = [
    ['threadlessVerification', 'github-threadless'],
    ['localVerification', 'local'],
  ].filter(([lane]) => {
    const proof = aggregate[lane];
    return proof?.status === 'passed'
      && proof.headSha === state.currentIntegrationHeadSha
      && proof.taskIds.length === 1
      && proof.updatedAt !== null;
  });
  if (candidates.length !== 1) return null;
  const [proofLane, sourceType] = candidates[0];
  const oppositeLane = proofLane === 'localVerification'
    ? 'threadlessVerification' : 'localVerification';
  if (!verificationProofIsPristine(aggregate[oppositeLane])) return null;
  const [taskId] = aggregate[proofLane].taskIds;
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task?.sourceType !== sourceType || task.disposition !== 'actionable'
      || task.status !== 'completed' || typeof task.integratedCommitSha !== 'string') return null;
  const remediations = state.tasks.filter((candidate) => (
    ['local', 'github-threadless'].includes(candidate.sourceType)
      && candidate.disposition === 'actionable'
      && ['integrated', 'completed'].includes(candidate.status)
      && typeof candidate.integratedCommitSha === 'string'
  ));
  return remediations.length === 1 && remediations[0].id === taskId
    ? { proofLane, sourceType, task } : null;
}

export function archiveBatchAdoptionReady(state, selectedTask, selectedPlan) {
  const aggregate = state.threadResolutionStatus;
  const bootstrap = currentBootstrapLane(state);
  if (selectedTask?.sourceType !== 'github-thread'
      || selectedTask.status !== 'not-applicable'
      || !VERIFIED_NON_ACTIONABLE_DISPOSITIONS.has(selectedTask.disposition)
      || selectedTask.integratedCommitSha !== null
      || selectedPlan.length < 2
      || selectedPlan.some((entry) => !entry.thread.isResolved
        || entry.tasks.length !== 1 || entry.tasks[0].id !== selectedTask.id)
      || aggregate.status !== 'not-run' || aggregate.headSha !== null
      || aggregate.threads.length !== 0 || aggregate.updatedAt !== null
      || bootstrap === null) return false;
  return true;
}

export function verificationProofIsPristine(verification) {
  return verification?.status === 'not-run'
    && verification.headSha === null
    && verification.taskIds.length === 0
    && verification.updatedAt === null;
}

export function archiveBootstrapScaffoldIsPristine(state, proofLane = 'threadlessVerification') {
  const aggregate = state.threadResolutionStatus;
  const oppositeLane = proofLane === 'localVerification'
    ? 'threadlessVerification' : 'localVerification';
  return aggregate.status === 'not-run'
    && aggregate.headSha === null
    && aggregate.threads.length === 0
    && aggregate.updatedAt === null
    && Object.hasOwn(aggregate, oppositeLane)
    && verificationProofIsPristine(aggregate[oppositeLane]);
}

export function immutableSourcesDeclareMultiRootArchiveBatch(task, live) {
  return canonicalRootsForTask(task, live).length >= 2;
}

export function archiveAdoptionVerifierBootstrapPlan(
  state, live, selectedTaskId, heads, verifiedAt = null,
) {
  const selectedTask = state.tasks.find((task) => task.id === selectedTaskId);
  const terminalThreadTasks = state.tasks.filter((task) => task.sourceType === 'github-thread'
    && task.status === 'not-applicable' && task.disposition === 'already-fixed'
    && task.integratedCommitSha === null);
  const proofLane = selectedTask?.sourceType === 'local'
    ? 'localVerification' : 'threadlessVerification';
  const oppositeLane = proofLane === 'localVerification'
    ? 'threadlessVerification' : 'localVerification';
  const verification = state.threadResolutionStatus[proofLane];
  const retry = selectedTask?.disposition === 'actionable'
    && selectedTask.status === 'completed'
    && typeof selectedTask.integratedCommitSha === 'string'
    && verification.status === 'passed'
    && verification.headSha === state.currentIntegrationHeadSha
    && sameTaskIds([...verification.taskIds].sort(), [selectedTask.id])
    && verification.updatedAt !== null
    && verificationProofIsPristine(state.threadResolutionStatus[oppositeLane]);
  const potentialBootstrap = ['github-threadless', 'local'].includes(selectedTask?.sourceType)
    && archiveBootstrapScaffoldIsPristine(state, proofLane)
    && terminalThreadTasks.length > 0
    && (selectedTask.status !== 'completed' || (retry && terminalThreadTasks.some(
      (task) => immutableSourcesDeclareMultiRootArchiveBatch(task, live),
    )));
  if (!potentialBootstrap) return null;

  const pending = selectedTask.disposition === 'actionable'
    && selectedTask.status === 'integrated'
    && typeof selectedTask.integratedCommitSha === 'string'
    && verificationProofIsPristine(verification);
  if (!pending && !retry) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap requires one Integrated remediation or its exact retry',
      'TASK_NOT_READY',
    );
  }

  const eligibleRemediations = state.tasks.filter((task) => ['github-threadless', 'local'].includes(task.sourceType)
    && task.disposition === 'actionable' && task.status === 'integrated'
    && typeof task.integratedCommitSha === 'string');
  if ((pending && (eligibleRemediations.length !== 1 || eligibleRemediations[0].id !== selectedTask.id))
      || (retry && eligibleRemediations.length !== 0)) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap remediation is missing or ambiguous',
      'TASK_NOT_READY',
    );
  }
  const { plan } = buildCanonicalRootPlan(state, live);
  const canonicalRoots = live.threads.filter((thread) => thread.canonical);
  if (plan.length !== canonicalRoots.length
      || plan.some((entry) => entry.tasks.length !== 1)) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap requires exclusive canonical-root mappings',
      'ROOT_IDENTITY_MISMATCH',
    );
  }
  const archiveCandidates = terminalThreadTasks.map((task) => ({
    task,
    plan: plan.filter((entry) => entry.tasks[0].id === task.id),
  })).filter((candidate) => candidate.plan.length >= 2
    && candidate.plan.every((entry) => entry.thread.isResolved));
  if (archiveCandidates.length !== 1) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap requires one resolved multi-root batch',
      'TASK_NOT_READY',
    );
  }
  const [{ task: archiveTask, plan: archivePlan }] = archiveCandidates;
  const otherRootsEligible = plan.filter((entry) => entry.tasks[0].id !== archiveTask.id)
    .every((entry) => {
      const task = entry.tasks[0];
      return !entry.thread.isResolved
        && task.sourceType === 'github-thread'
        && ((task.disposition === 'actionable'
          && ['integrated', 'completed'].includes(task.status)
          && typeof task.integratedCommitSha === 'string')
          || (task.disposition === 'already-fixed'
            && task.status === 'not-applicable'
            && task.integratedCommitSha === null));
    });
  if (!otherRootsEligible) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap found an ineligible root outside the resolved batch',
      'TASK_NOT_READY',
    );
  }

  const hypotheticalState = {
    ...state,
    tasks: state.tasks.map((task) => task.id === selectedTask.id
      ? { ...task, status: 'completed' } : task),
    threadResolutionStatus: {
      ...state.threadResolutionStatus,
      [proofLane]: {
        status: 'passed',
        headSha: state.currentIntegrationHeadSha,
        taskIds: [selectedTask.id],
        updatedAt: retry ? verification.updatedAt : state.updatedAt,
      },
    },
  };
  if (!archiveBatchAdoptionReady(hypotheticalState, archiveTask, archivePlan)) {
    throw new GitHubWorkflowError(
      'Archive-adoption verifier bootstrap does not enable the ordinary archive-adoption predicate',
      'TASK_NOT_READY',
    );
  }

  const bootstrapPlan = {
    mode: pending ? 'pending' : 'retry',
    stateRevision: state.revision,
    selectedTaskId: selectedTask.id,
    selectedIntegratedCommitSha: selectedTask.integratedCommitSha,
    archiveTaskId: archiveTask.id,
    proofLane,
    heads: {
      durable: state.currentIntegrationHeadSha,
      local: heads.localHeadSha,
      pushed: heads.pushedHeadSha,
      live: live.metadata.headRefOid,
    },
    roots: plan.map((entry) => ({
      threadNodeId: entry.thread.id,
      rootCommentNodeId: entry.thread.root.id,
      rootCommentDatabaseId: entry.thread.root.databaseId,
      isResolved: entry.thread.isResolved,
      taskId: entry.tasks[0].id,
    })),
  };
  if (verifiedAt === null || bootstrapPlan.mode !== 'pending'
      || bootstrapPlan.proofLane !== 'localVerification') return bootstrapPlan;
  const threadResolutionStatus = {
    ...state.threadResolutionStatus,
    localVerification: {
      status: 'passed', headSha: state.currentIntegrationHeadSha,
      taskIds: [bootstrapPlan.selectedTaskId], updatedAt: verifiedAt,
    },
  };
  const nextState = {
    ...state,
    tasks: state.tasks.map((task) => task.id === bootstrapPlan.selectedTaskId
      ? { ...task, status: 'completed' } : task),
    threadResolutionStatus,
  };
  return {
    ...bootstrapPlan,
    completion: {
      envelope: {
      schemaVersion: 1,
      taskId: bootstrapPlan.selectedTaskId,
      integratedCommitSha: bootstrapPlan.selectedIntegratedCommitSha,
      headSha: state.currentIntegrationHeadSha,
      proofLane: 'localVerification',
      archiveTaskId: bootstrapPlan.archiveTaskId,
      roots: structuredClone(bootstrapPlan.roots).sort(
        (left, right) => left.threadNodeId.localeCompare(right.threadNodeId),
      ),
      priorStateFingerprint: evidenceFingerprint(bootstrapStateProjection(state)),
      nextStateFingerprint: evidenceFingerprint(bootstrapStateProjection(nextState)),
      },
      threadResolutionStatus,
    },
  };
}

export async function prepareArchiveBatchAdoption({
  state, live, selectedTask, selectedPlan, archiveStore, git,
}) {
  const lineage = await selectArchiveForBatch(state, selectedTask, selectedPlan, archiveStore);
  const adoption = validateArchiveBatchLineage(state, live, selectedTask, selectedPlan, lineage);
  const relations = adoption.mode === 'aggregate'
    ? adoption.ancestryRelations
    : [{
      ancestorSha: adoption.historicalHeadSha,
      descendantSha: state.currentIntegrationHeadSha,
      label: 'archived historical HEAD',
    }];
  for (const relation of relations) {
    if (!(await git.isAncestor(
      relation.ancestorSha, relation.descendantSha, state.integrationWorktree,
    ))) {
      throw new GitHubWorkflowError(
        `${relation.label} is not an integration ancestor`,
        'MUTATION_NOT_READY',
      );
    }
  }
  return adoption;
}

export function archiveAdoptionEvidenceMap(adoption) {
  return new Map(adoption.evidence.map((item) => [item.threadNodeId, {
    archiveAdoption: true,
    reply: item.reply,
    resolvedAt: item.proof.resolvedAt,
    resolvedBy: item.proof.resolvedBy,
    observedHeadSha: item.historicalHeadSha ?? adoption.historicalHeadSha,
    ...(item.archiveProvenance ? { archiveProvenance: structuredClone(item.archiveProvenance) } : {}),
  }]));
}

export function archiveImportCompletionEnvelope(selectedTask, proof, adoption) {
  const rows = proof.threads.filter((row) => Object.hasOwn(row, 'archiveProvenance'))
    .map((row) => ({
      threadNodeId: row.threadNodeId,
      replyId: row.replyId,
      replyBodySha256: row.archiveProvenance.replyBodySha256,
      provenanceFingerprint: createHash('sha256')
        .update(JSON.stringify(canonicalJson(row.archiveProvenance)))
        .digest('hex'),
      rowFingerprint: createHash('sha256')
        .update(JSON.stringify(canonicalJson(row)))
        .digest('hex'),
    }))
    .sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
  return {
    schemaVersion: 1,
    taskId: selectedTask.id,
    authorityFingerprint: adoption.archiveLineage.authorityFingerprint,
    rows,
  };
}

export async function adoptArchiveBatch({
  state, live, taskId, selectedTask, selectedPlan, archiveStore, git, clock,
  readLiveSnapshot, assertMutationReady, assertCurrent,
  checkpointArchiveTaskCompletion, checkpointTaskCompletion,
}) {
  const preflightAdoption = await prepareArchiveBatchAdoption({
    state, live, selectedTask, selectedPlan, archiveStore, git,
  });
  const finalLineage = await selectArchiveForBatch(state, selectedTask, selectedPlan, archiveStore);
  const finalLive = await readLiveSnapshot(state);
  await assertMutationReady({ state, git }, finalLive);
  const finalPlan = buildCanonicalRootPlan(state, finalLive, taskId);
  if (!archiveBatchAdoptionReady(state, finalPlan.selected, finalPlan.selectedPlan)) {
    throw new GitHubWorkflowError('Archive adoption prerequisites changed after preflight', 'THREAD_PROOF_STALE');
  }
  const finalAdoption = validateArchiveBatchLineage(
    state, finalLive, finalPlan.selected, finalPlan.selectedPlan, finalLineage,
  );
  const finalRelations = finalAdoption.mode === 'aggregate'
    ? finalAdoption.ancestryRelations
    : [{
      ancestorSha: finalAdoption.historicalHeadSha,
      descendantSha: state.currentIntegrationHeadSha,
      label: 'archived historical HEAD',
    }];
  for (const relation of finalRelations) {
    if (!(await git.isAncestor(
      relation.ancestorSha, relation.descendantSha, state.integrationWorktree,
    ))) {
      throw new GitHubWorkflowError(
        `${relation.label} is not an integration ancestor`,
        'MUTATION_NOT_READY',
      );
    }
  }
  if (!isDeepStrictEqual(preflightAdoption, finalAdoption)) {
    throw new GitHubWorkflowError('Archive or live resolved-root evidence changed after preflight', 'THREAD_PROOF_STALE');
  }
  const proof = buildThreadProof(
    state, finalLive, archiveAdoptionEvidenceMap(finalAdoption), clock.now(),
  );
  await assertCurrent(state);
  let active;
  if (finalAdoption.mode === 'aggregate') {
    const archiveImportEnvelope = archiveImportCompletionEnvelope(
      finalPlan.selected, proof, finalAdoption,
    );
    active = await checkpointArchiveTaskCompletion({
      prNumber: state.prNumber,
      expectedRevision: state.revision,
      threadResolutionStatus: proof,
      archiveImportEnvelope,
    });
  } else {
    active = await checkpointTaskCompletion({
      prNumber: state.prNumber,
      expectedRevision: state.revision,
      threadResolutionStatus: proof,
    });
  }
  return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
}
