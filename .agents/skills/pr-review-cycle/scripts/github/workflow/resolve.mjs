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

function verificationProofIsPristine(verification) {
  return verification?.status === 'not-run'
    && verification.headSha === null
    && verification.taskIds.length === 0
    && verification.updatedAt === null;
}

function githubThreadArchiveAttestationCandidate(state, selectedTask, selectedPlan) {
  const aggregate = state.threadResolutionStatus;
  return selectedTask?.sourceType === 'github-thread'
    && selectedTask.status === 'not-applicable'
    && selectedTask.disposition === 'already-fixed'
    && selectedTask.integratedCommitSha === null
    && selectedPlan.length >= 2
    && selectedPlan.every((entry) => entry.thread.isResolved
      && entry.tasks.length === 1 && entry.tasks[0].id === selectedTask.id)
    && aggregate.status === 'not-run' && aggregate.headSha === null
    && aggregate.threads.length === 0 && aggregate.updatedAt === null
    && verificationProofIsPristine(aggregate.localVerification)
    && verificationProofIsPristine(aggregate.threadlessVerification);
}

function githubThreadArchiveAttestationRetryReady(state, selectedTask, selectedPlan) {
  const aggregate = state.threadResolutionStatus;
  const recorded = new Map(aggregate.threads.map((row) => [row.threadNodeId, row]));
  if (selectedTask?.sourceType !== 'github-thread' || selectedTask.status !== 'completed'
      || selectedTask.disposition !== 'already-fixed' || selectedTask.integratedCommitSha !== null
      || selectedPlan.length < 2
      || aggregate.status !== 'failed' || aggregate.headSha !== state.currentIntegrationHeadSha
      || aggregate.updatedAt === null
      || !verificationProofIsPristine(aggregate.localVerification)
      || !verificationProofIsPristine(aggregate.threadlessVerification)) return false;
  return selectedPlan.every((entry) => {
    const row = recorded.get(entry.thread.id);
    return entry.thread.isResolved && entry.tasks.length === 1
      && entry.tasks[0].id === selectedTask.id
      && row?.isResolved === true && row.taskIds.length === 1
      && row.taskIds[0] === selectedTask.id
      && Object.hasOwn(row, 'archiveProvenance');
  });
}

function exactClassificationDigest(scope) {
  const digest = scope?.classification?.assessment?.digest;
  return typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(digest) ? digest : null;
}

function githubThreadArchiveAttestationPlan({
  state, live, selectedTask, selectedPlan, heads, scopes, verifierAssertion,
}) {
  if (!githubThreadArchiveAttestationCandidate(state, selectedTask, selectedPlan)) return null;
  const { plan } = buildCanonicalRootPlan(state, live);
  const canonicalRoots = live.threads.filter((thread) => thread.canonical);
  if (plan.length !== canonicalRoots.length
      || plan.some((entry) => entry.tasks.length !== 1)) {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation requires complete exclusive canonical-root mappings',
      'ROOT_IDENTITY_MISMATCH',
    );
  }
  const selectedRoots = plan.filter((entry) => entry.tasks[0].id === selectedTask.id);
  if (selectedRoots.length !== selectedPlan.length
      || selectedRoots.length < 2
      || selectedRoots.some((entry) => !entry.thread.isResolved)) {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation requires exactly one resolved multi-root aggregate',
      'TASK_NOT_READY',
    );
  }
  const remediationTasks = new Map();
  for (const entry of plan.filter((candidate) => candidate.tasks[0].id !== selectedTask.id)) {
    const task = entry.tasks[0];
    if (entry.thread.isResolved || task.sourceType !== 'github-thread'
        || task.disposition !== 'actionable' || task.status !== 'integrated'
        || typeof task.integratedCommitSha !== 'string') {
      throw new GitHubWorkflowError(
        'GitHub-thread archive attestation found an ineligible root outside the aggregate',
        'TASK_NOT_READY',
      );
    }
    remediationTasks.set(task.id, task);
  }
  if (remediationTasks.size === 0) {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation requires an unresolved Integrated remediation',
      'TASK_NOT_READY',
    );
  }
  const actionableGitHubTasks = state.tasks.filter((task) => task.sourceType === 'github-thread'
    && task.disposition === 'actionable' && task.status === 'integrated'
    && typeof task.integratedCommitSha === 'string');
  if (actionableGitHubTasks.length !== remediationTasks.size
      || actionableGitHubTasks.some((task) => !remediationTasks.has(task.id))) {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation remediation set is incomplete',
      'TASK_NOT_READY',
    );
  }
  const attestedTasks = [selectedTask, ...state.tasks.filter((task) => (
    task.disposition === 'actionable' && task.status === 'integrated'
      && typeof task.integratedCommitSha === 'string'
  ))];
  const classifications = attestedTasks.map((task) => {
    const scope = scopes.get(task.id);
    const digest = exactClassificationDigest(scope);
    if (scope?.authorityDigest !== state.scopeControl?.authorityDigest
        || scope?.journalDigest !== state.scopeControl?.journalDigest
        || digest === null) {
      throw new GitHubWorkflowError(
        `GitHub-thread archive attestation lacks current scope evidence for task ${task.id}`,
        'SCOPE_ROOT_NOT_READY',
      );
    }
    return { taskId: task.id, digest };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const roots = plan.map((entry) => ({
    threadNodeId: entry.thread.id,
    rootCommentNodeId: entry.thread.root.id,
    rootCommentDatabaseId: entry.thread.root.databaseId,
    isResolved: entry.thread.isResolved,
    taskId: entry.tasks[0].id,
  })).sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
  const remediations = [...remediationTasks.values()].map((task) => ({
    taskId: task.id, integratedCommitSha: task.integratedCommitSha,
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    schemaVersion: 1,
    headSha: state.currentIntegrationHeadSha,
    stateRevision: state.revision,
    heads: {
      durable: state.currentIntegrationHeadSha,
      local: heads.localHeadSha,
      pushed: heads.pushedHeadSha,
      live: live.metadata.headRefOid,
    },
    remediations,
    roots,
    scope: {
      authorityDigest: state.scopeControl.authorityDigest,
      journalDigest: state.scopeControl.journalDigest,
      classifications,
    },
    verifierAssertion: structuredClone(verifierAssertion),
  };
}

function integrationVerifierAssertion(state) {
  const raw = process.env.AERSTELLO_INTEGRATION_VERIFIER_ASSERTION;
  let assertion;
  try {
    assertion = JSON.parse(raw ?? 'null');
  } catch {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation requires valid integration-verifier assertion JSON',
      'TASK_NOT_READY',
    );
  }
  const fields = [
    'schemaVersion', 'verifierId', 'status', 'headSha', 'stateRevision',
    'scopeAuthorityDigest', 'scopeJournalDigest', 'assertedAt',
  ];
  if (assertion === null || typeof assertion !== 'object' || Array.isArray(assertion)
      || Object.keys(assertion).length !== fields.length
      || fields.some((field) => !Object.hasOwn(assertion, field))
      || assertion.schemaVersion !== 1
      || assertion.verifierId !== 'integration_verifier'
      || assertion.status !== 'clean'
      || assertion.headSha !== state.currentIntegrationHeadSha
      || assertion.stateRevision !== state.revision
      || assertion.scopeAuthorityDigest !== state.scopeControl?.authorityDigest
      || assertion.scopeJournalDigest !== state.scopeControl?.journalDigest
      || typeof assertion.assertedAt !== 'string'
      || !Number.isFinite(Date.parse(assertion.assertedAt))) {
    throw new GitHubWorkflowError(
      'GitHub-thread archive attestation requires a clean exact-HEAD integration-verifier assertion',
      'TASK_NOT_READY',
    );
  }
  return assertion;
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
    if (githubThreadArchiveAttestationRetryReady(active, selectedTask, selectedPlan)) {
      const assertRetrySnapshot = async (snapshot) => {
        await assertMutationReady({ state: active, git }, snapshot);
        assertRecordedThreadsLive(active, snapshot);
        for (const task of [selectedTask, ...active.tasks.filter((candidate) => (
          candidate.disposition === 'actionable' && candidate.status === 'integrated'
            && typeof candidate.integratedCommitSha === 'string'
        ))]) {
          await assertScopeRootCurrent(active, snapshot.metadata.headRefOid, task);
          if (task.id !== selectedTask.id && !(await git.isAncestor(
            task.integratedCommitSha, active.currentIntegrationHeadSha,
            active.integrationWorktree,
          ))) {
            throw new GitHubWorkflowError(
              `Attested task ${task.id} is not an integration ancestor`,
              'MUTATION_NOT_READY',
            );
          }
        }
        await assertCurrent(active);
      };
      await assertRetrySnapshot(live);
      live = await readLiveSnapshot(client, active);
      await assertRetrySnapshot(live);
      return verifyResolveResult([taskId], active);
    }
    if (githubThreadArchiveAttestationCandidate(active, selectedTask, selectedPlan)) {
      const verifierAssertion = integrationVerifierAssertion(active);
      const readGitHubThreadAttestation = async (
        state, snapshot, aggregateTask, aggregatePlan,
      ) => {
        const heads = await assertMutationReady({ state, git }, snapshot);
        const tasks = [aggregateTask, ...state.tasks.filter((task) => (
          task.disposition === 'actionable' && task.status === 'integrated'
            && typeof task.integratedCommitSha === 'string'
        ))];
        const scopes = new Map();
        for (const task of tasks) {
          scopes.set(task.id, await assertScopeRootCurrent(
            state, snapshot.metadata.headRefOid, task,
          ));
          if (task.id !== aggregateTask.id && !(await git.isAncestor(
            task.integratedCommitSha, state.currentIntegrationHeadSha, state.integrationWorktree,
          ))) {
            throw new GitHubWorkflowError(
              `Attested task ${task.id} is not an integration ancestor`,
              'MUTATION_NOT_READY',
            );
          }
        }
        return githubThreadArchiveAttestationPlan({
          state, live: snapshot, selectedTask: aggregateTask,
          selectedPlan: aggregatePlan, heads, scopes, verifierAssertion,
        });
      };
      return adoptArchiveBatch({
        state: active, live, taskId, selectedTask, selectedPlan, archiveStore, git, clock,
        readLiveSnapshot: (state) => readLiveSnapshot(client, state),
        assertMutationReady: ({ state }, snapshot) => assertSelectedRootReady(
          state, snapshot, selectedTask,
        ),
        assertCurrent,
        checkpointArchiveTaskCompletion: archiveTaskCheckpoint(stateAdapter, active),
        checkpointTaskCompletion: (input) => stateAdapter.checkpointTaskCompletion(input),
        readGitHubThreadAttestation,
      });
    }
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
