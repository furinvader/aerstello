import { isDeepStrictEqual } from 'node:util';

import { checkpointArchiveTaskCompletion } from '../../state/state.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import {
  adoptArchiveBatch,
  archiveAdoptionVerifierBootstrapPlan,
  archiveBatchAdoptionReady,
} from '../archive/adoption.mjs';
import { executeMutation } from '../graphql/client.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import {
  lookupThreadMutationIntent,
  postThreadReply,
  resolveThread,
} from '../mutations/thread-reply-resolve.mjs';
import { buildCanonicalRootPlan } from '../threads/canonical-roots.mjs';
import {
  assertExistingThreadProof,
  assertLiveThreadProof,
  assertRecordedThreadsLive,
  buildThreadProof,
} from '../threads/proof.mjs';
import {
  assertPriorHeadRecoveryLive,
  journaledPriorHeadRecovery,
} from '../threads/recovery.mjs';
import { exactRepliesFor } from '../threads/replies.mjs';

const VERIFIED_NON_ACTIONABLE_DISPOSITIONS = new Set([
  'duplicate', 'already-fixed', 'stale', 'invalid', 'policy-conflict', 'out-of-scope',
]);

export function taskIsEligibleForVerifyResolve(task) {
  const actionable = task.disposition === 'actionable'
    && ['integrated', 'completed'].includes(task.status)
    && Boolean(task.integratedCommitSha);
  const nonActionable = VERIFIED_NON_ACTIONABLE_DISPOSITIONS.has(task.disposition)
    && ['not-applicable', 'completed'].includes(task.status);
  return actionable || nonActionable;
}

export function normalizeVerifyResolveTaskIds(taskSelection) {
  const taskIds = Array.isArray(taskSelection) ? [...taskSelection] : [];
  if (
    !Array.isArray(taskSelection)
    || taskIds.length === 0
    || taskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
    || new Set(taskIds).size !== taskIds.length
  ) {
    throw new GitHubWorkflowError(
      'verify-resolve requires an array of unique nonempty opaque task IDs',
      'TASK_NOT_READY',
    );
  }
  return taskIds.sort();
}

function sameTaskIds(left, right) {
  return left.length === right.length
    && left.every((taskId, index) => taskId === right[index]);
}

function verifyResolveResult(taskIds, active) {
  return {
    ...(taskIds.length === 1 ? { taskId: taskIds[0] } : { taskIds }),
    stateRevision: active.revision,
    threadResolutionStatus: active.threadResolutionStatus,
  };
}

export function archiveTaskCheckpoint(stateAdapter, active, fallback = checkpointArchiveTaskCompletion) {
  return stateAdapter.checkpointArchiveTaskCompletion
    ? (input) => stateAdapter.checkpointArchiveTaskCompletion(input)
    : (input) => fallback({ cwd: active.integrationWorktree, ...input });
}

export function createResolveUseCases(context) {
  const {
    client, stateAdapter, git, clock, journal, archiveStore, load, assertCurrent,
    assertScopeRootCurrent,
  } = context;

  async function assertSelectedRootReady(active, live, task) {
    const heads = await assertMutationReady({ state: active, git }, live);
    await assertScopeRootCurrent(active, live.metadata.headRefOid, task);
    return heads;
  }

  async function replyResolve(prNumber, taskId) {
    let active = await load(prNumber);
    let live = await readLiveSnapshot(client, active);
    const { plan, selected: selectedTask, selectedPlan } = buildCanonicalRootPlan(active, live, taskId);
    await assertSelectedRootReady(active, live, selectedTask);
    if (archiveBatchAdoptionReady(active, selectedTask, selectedPlan)) {
      return adoptArchiveBatch({
        state: active,
        live,
        taskId,
        selectedTask,
        selectedPlan,
        archiveStore,
        git,
        clock,
        readLiveSnapshot: (state) => readLiveSnapshot(client, state),
        assertMutationReady: ({ state }, snapshot) => assertSelectedRootReady(state, snapshot, selectedTask),
        assertCurrent,
        checkpointArchiveTaskCompletion: archiveTaskCheckpoint(stateAdapter, active),
        checkpointTaskCompletion: (input) => stateAdapter.checkpointTaskCompletion(input),
      });
    }
    if (selectedTask?.sourceType === 'github-threadless') {
      const verification = active.threadResolutionStatus.threadlessVerification;
      if (verification.status !== 'passed' || verification.headSha !== active.currentIntegrationHeadSha
          || !verification.taskIds.includes(taskId)) {
        throw new GitHubWorkflowError('Threadless task lacks successful exact-head verification', 'TASK_NOT_READY');
      }
      const proof = buildThreadProof(active, live, new Map(), clock.now());
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber, expectedRevision: active.revision, threadResolutionStatus: proof,
      });
      return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
    }
    const previousProof = new Map(active.threadResolutionStatus.threads.map((item) => [item.threadNodeId, item]));
    const priorResolveIntents = new Map();
    const priorHeadRecoveries = new Map();
    const preflightReplies = new Map();
    for (const entry of plan) {
      const { thread } = entry;
      const old = previousProof.get(thread.id);
      const recordedReply = old ? assertExistingThreadProof(active, live, entry, old) : null;
      const priorHeadRecovery = !old && selectedPlan.some((selected) => selected.thread.id === thread.id)
        ? await journaledPriorHeadRecovery(active, live, entry, selectedTask, journal, git) : null;
      if (priorHeadRecovery) priorHeadRecoveries.set(thread.id, priorHeadRecovery);
      preflightReplies.set(thread.id, recordedReply ? [recordedReply]
        : priorHeadRecovery ? [priorHeadRecovery.reply]
          : exactRepliesFor(active, live, entry).exact);
      if (thread.isResolved && !old?.isResolved) {
        const operationId = `resolve:${prNumber}:${thread.id}:${active.currentIntegrationHeadSha}`;
        const intent = priorHeadRecovery?.resolveIntent
          ?? await lookupThreadMutationIntent(journal, 'resolve', operationId);
        if (!intent || preflightReplies.get(thread.id).length !== 1) {
          throw new GitHubWorkflowError('Resolved thread lacks pre-existing exact recovery evidence', 'RESOLUTION_PROOF_MISSING');
        }
        priorResolveIntents.set(thread.id, intent);
      }
    }
    if (priorHeadRecoveries.size > 1) {
      throw new GitHubWorkflowError('Prior-head recovery is ambiguous across canonical roots', 'REPLY_AMBIGUOUS');
    }
    if (priorHeadRecoveries.size === 1) await assertCurrent(active);
    const evidence = new Map();
    for (const entry of plan) {
      const intent = priorResolveIntents.get(entry.thread.id);
      if (intent) evidence.set(entry.thread.id, {
        reply: preflightReplies.get(entry.thread.id)[0], resolvedAt: intent.at, resolvedBy: live.metadata.viewer.login,
        ...(priorHeadRecoveries.has(entry.thread.id)
          ? { priorHeadRecovery: priorHeadRecoveries.get(entry.thread.id) } : {}),
      });
    }
    for (const entry of selectedPlan) {
      const { thread } = entry;
      live = await readLiveSnapshot(client, active);
      await assertSelectedRootReady(active, live, selectedTask);
      if (priorHeadRecoveries.size === 1) await assertCurrent(active);
      let current = live.threads.find((item) => item.id === thread.id);
      const old = previousProof.get(thread.id);
      if (old?.isResolved) {
        assertExistingThreadProof(active, live, { ...entry, thread: current }, old);
        continue;
      }
      const priorHeadRecovery = priorHeadRecoveries.get(thread.id);
      let replies = priorHeadRecovery
        ? [assertPriorHeadRecoveryLive(active, live, { ...entry, thread: current }, priorHeadRecovery)]
        : old?.replyId
        ? [assertExistingThreadProof(active, live, { ...entry, thread: current }, old)]
        : exactRepliesFor(active, live, { ...entry, thread: current }).exact;
      if (replies.length === 0) {
        if (current.isResolved) {
          throw new GitHubWorkflowError('Resolved thread lacks its exact current reply', 'RESOLUTION_PROOF_MISSING');
        }
        const posted = await postThreadReply({
          client, journal, clock, state: active, git, entry: { ...entry, thread: current }, assertCurrent,
          assertReady: ({ state }, snapshot) => assertSelectedRootReady(state, snapshot, selectedTask),
        });
        live = posted.live;
        current = posted.thread;
        replies = [posted.reply];
      }
      const reply = replies[0];
      if (current.isResolved && !old?.isResolved) {
        const priorIntent = priorResolveIntents.get(thread.id);
        if (!priorIntent) throw new GitHubWorkflowError('Resolved thread lacks a pre-existing resolve intent', 'RESOLUTION_PROOF_MISSING');
        evidence.set(thread.id, {
          reply, resolvedAt: priorIntent.at, resolvedBy: live.metadata.viewer.login,
          ...(priorHeadRecovery ? { priorHeadRecovery } : {}),
        });
        continue;
      }
      let resolveExecuted = false;
      const resolved = await resolveThread({
        client, journal, clock, state: active, git, entry: { ...entry, thread: current }, reply, assertCurrent,
        assertReady: ({ state }, snapshot) => assertSelectedRootReady(state, snapshot, selectedTask),
        execute: async (...args) => {
          resolveExecuted = true;
          return executeMutation(...args);
        },
      });
      live = resolved.live;
      current = resolved.thread;
      evidence.set(thread.id, {
        ...resolved.evidence,
        resolvedAt: previousProof.get(thread.id)?.resolvedAt
          ?? (resolveExecuted ? clock.now() : resolved.evidence.resolvedAt),
      });
    }
    live = await readLiveSnapshot(client, active);
    await assertSelectedRootReady(active, live, selectedTask);
    if (priorHeadRecoveries.size === 1) {
      for (const [threadId, recovery] of priorHeadRecoveries) {
        const entry = plan.find((candidate) => candidate.thread.id === threadId);
        const current = live.threads.find((thread) => thread.id === threadId);
        assertPriorHeadRecoveryLive(active, live, { ...entry, thread: current }, recovery);
      }
      await assertCurrent(active);
    }
    const proof = buildThreadProof(active, live, evidence, clock.now());
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber, expectedRevision: active.revision, threadResolutionStatus: proof,
    });
    return { taskId, stateRevision: active.revision, threadResolutionStatus: active.threadResolutionStatus };
  }

  async function verifyResolve(prNumber, taskSelection) {
    const taskIds = normalizeVerifyResolveTaskIds(taskSelection);
    let active = await load(prNumber);
    if (!stateAdapter.checkpointTaskCompletion) {
      throw new GitHubWorkflowError('The guarded task-completion checkpoint is unavailable', 'INVALID_ADAPTERS');
    }
    const selectedTasks = taskIds.map((taskId) => {
      const task = active.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new GitHubWorkflowError(`Task ${taskId} was not found`, 'TASK_NOT_FOUND');
      return task;
    });
    const selectedTask = selectedTasks[0];
    const completedThreadlessRefresh = selectedTasks.every((task) => (
      task.sourceType === 'github-threadless' && task.status === 'completed'
    ));
    if (taskIds.length > 1 && !completedThreadlessRefresh) {
      throw new GitHubWorkflowError(
        'Multiple tasks may only select one completed threadless proof set',
        'TASK_NOT_READY',
      );
    }
    for (const task of selectedTasks) {
      if (!['local', 'github-threadless'].includes(task.sourceType)) {
        throw new GitHubWorkflowError(
          `Task ${task.id} must use reply-resolve for its canonical GitHub thread`,
          'TASK_NOT_READY',
        );
      }
      if (!taskIsEligibleForVerifyResolve(task)) {
        throw new GitHubWorkflowError(
          `Task ${task.id} is not eligible for verifier completion`,
          'TASK_NOT_READY',
        );
      }
    }

    let completedThreadlessVerification = null;
    if (completedThreadlessRefresh) {
      completedThreadlessVerification = active.threadResolutionStatus.threadlessVerification;
      const preservedTaskIds = [...(completedThreadlessVerification.taskIds ?? [])].sort();
      if (completedThreadlessVerification.status !== 'passed'
          || !sameTaskIds(taskIds, preservedTaskIds)) {
        throw new GitHubWorkflowError(
          'Completed threadless refresh requires the complete preserved task set',
          'TASK_NOT_READY',
        );
      }
    }

    let live = await readLiveSnapshot(client, active);
    const preflightHeads = await assertMutationReady({ state: active, git }, live);
    for (const task of selectedTasks) await assertScopeRootCurrent(active, live.metadata.headRefOid, task);
    const preflightBootstrap = taskIds.length === 1
      ? archiveAdoptionVerifierBootstrapPlan(active, live, selectedTask.id, preflightHeads)
      : null;
    if (preflightBootstrap === null) {
      if (completedThreadlessRefresh) assertRecordedThreadsLive(active, live);
      else assertLiveThreadProof(active, live);
    }
    await assertCurrent(active);

    live = await readLiveSnapshot(client, active);
    const finalHeads = await assertMutationReady({ state: active, git }, live);
    for (const task of selectedTasks) await assertScopeRootCurrent(active, live.metadata.headRefOid, task);
    let finalBootstrap = null;
    try {
      finalBootstrap = taskIds.length === 1
        ? archiveAdoptionVerifierBootstrapPlan(active, live, selectedTask.id, finalHeads)
        : null;
    } catch (error) {
      if (preflightBootstrap === null) throw error;
      throw new GitHubWorkflowError(
        'Archive-adoption verifier bootstrap evidence changed after preflight',
        'THREAD_PROOF_STALE',
      );
    }
    if (preflightBootstrap !== null) {
      if (finalBootstrap === null || !isDeepStrictEqual(preflightBootstrap, finalBootstrap)) {
        throw new GitHubWorkflowError(
          'Archive-adoption verifier bootstrap evidence changed after preflight',
          'THREAD_PROOF_STALE',
        );
      }
    } else {
      if (completedThreadlessRefresh) assertRecordedThreadsLive(active, live);
      else assertLiveThreadProof(active, live);
    }
    await assertCurrent(active);

    if (preflightBootstrap !== null) {
      if (preflightBootstrap.mode === 'retry') return verifyResolveResult(taskIds, active);
      const verifiedAt = clock.now();
      const localBootstrap = preflightBootstrap.proofLane === 'localVerification'
        ? archiveAdoptionVerifierBootstrapPlan(
          active, live, selectedTask.id, finalHeads, verifiedAt,
        ).completion : null;
      if (localBootstrap !== null) {
        active = await archiveTaskCheckpoint(stateAdapter, active)({
          prNumber, expectedRevision: active.revision,
          threadResolutionStatus: localBootstrap.threadResolutionStatus,
          verifierBootstrapEnvelope: localBootstrap.envelope,
        });
        return verifyResolveResult(taskIds, active);
      }
      const threadResolutionStatus = {
        ...active.threadResolutionStatus,
        threadlessVerification: {
          status: 'passed',
          headSha: active.currentIntegrationHeadSha,
          taskIds: [selectedTask.id],
          updatedAt: verifiedAt,
        },
      };
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber, expectedRevision: active.revision, threadResolutionStatus, verifiedLocalTaskIds: [],
      });
      return verifyResolveResult(taskIds, active);
    }

    if (selectedTask.status === 'completed' && completedThreadlessRefresh) {
      if (completedThreadlessVerification.headSha === active.currentIntegrationHeadSha) {
        return verifyResolveResult(taskIds, active);
      }
      if (active.threadResolutionStatus.status !== 'not-run'
          || active.threadResolutionStatus.headSha !== null
          || active.threadResolutionStatus.updatedAt !== null) {
        throw new GitHubWorkflowError('Completed threadless refresh requires invalidated aggregate proof', 'TASK_NOT_READY');
      }
      const threadResolutionStatus = {
        ...active.threadResolutionStatus,
        threadlessVerification: {
          ...completedThreadlessVerification,
          headSha: active.currentIntegrationHeadSha,
          taskIds,
          updatedAt: clock.now(),
        },
      };
      active = await stateAdapter.checkpointTaskCompletion({
        prNumber, expectedRevision: active.revision, threadResolutionStatus, verifiedLocalTaskIds: [],
      });
      return verifyResolveResult(taskIds, active);
    }
    if (selectedTask.status === 'completed' && selectedTask.sourceType === 'local') {
      const localVerification = active.threadResolutionStatus.localVerification;
      if (localVerification?.status === 'passed'
          && localVerification.headSha === active.currentIntegrationHeadSha
          && localVerification.taskIds.includes(selectedTask.id)) {
        return verifyResolveResult(taskIds, active);
      }
    }

    const verifiedAt = clock.now();
    let threadResolutionStatus = buildThreadProof(active, live, new Map(), verifiedAt);
    const verifiedLocalTaskIds = [];
    if (selectedTask.sourceType === 'local') {
      verifiedLocalTaskIds.push(selectedTask.id);
    } else {
      const previousIds = active.threadResolutionStatus.threadlessVerification.status === 'passed'
        ? active.threadResolutionStatus.threadlessVerification.taskIds : [];
      threadResolutionStatus = {
        ...threadResolutionStatus,
        threadlessVerification: {
          status: 'passed',
          headSha: active.currentIntegrationHeadSha,
          taskIds: [...new Set([...previousIds, selectedTask.id])].sort(),
          updatedAt: verifiedAt,
        },
      };
    }
    active = await stateAdapter.checkpointTaskCompletion({
      prNumber, expectedRevision: active.revision, threadResolutionStatus, verifiedLocalTaskIds,
    });
    return verifyResolveResult(taskIds, active);
  }

  return { replyResolve, verifyResolve };
}
