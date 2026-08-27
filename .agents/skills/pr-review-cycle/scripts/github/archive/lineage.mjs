import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { validatePrReviewState } from '../../contracts/contracts.mjs';
import { GitHubWorkflowError } from '../errors.mjs';
import { canonicalJson } from '../evidence/review-response.mjs';
import { MAX_NODES } from '../graphql/client.mjs';
import { intentFor } from '../threads/replies.mjs';
import {
  archiveBatchProofProjection,
  archiveContentFingerprint,
  assertArchiveEventList,
  assertArchiveInventory,
  assertArchiveReplyBody,
  assertTerminalArchive,
  parsedTime,
  projectedArchivedTask,
  stableCommentEvidence,
  validateArchiveBatchLive,
} from './evidence.mjs';

export function selectLegacyArchiveForBatch(state, selectedTask, archives) {
  assertArchiveInventory(archives);
  const candidates = [];
  for (const archive of archives) {
    const archivedState = archive?.state;
    if (archivedState?.repository !== state.repository || archivedState?.prNumber !== state.prNumber) continue;
    const matchingTasks = Array.isArray(archivedState.tasks)
      ? archivedState.tasks.filter((task) => task?.id === selectedTask.id) : [];
    if (matchingTasks.length === 0) {
      const proofRows = archivedState?.threadResolutionStatus?.threads;
      const proofReferencesSelectedTask = Array.isArray(proofRows) && proofRows.some(
        (row) => Array.isArray(row?.taskIds) && row.taskIds.includes(selectedTask.id),
      );
      if (!proofReferencesSelectedTask) continue;
      const stateErrors = Array.isArray(archivedState.tasks)
        ? validatePrReviewState(archivedState) : ['tasks must be an array'];
      throw new GitHubWorkflowError(
        `Archived task state is invalid: ${stateErrors.join('; ')}`,
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
    if (matchingTasks.length !== 1) {
      throw new GitHubWorkflowError('Archived task identity is duplicated', 'ARCHIVE_EVIDENCE_AMBIGUOUS');
    }
    const stateErrors = validatePrReviewState(archivedState);
    if (archivedState.schemaVersion !== 3 || stateErrors.length > 0) {
      throw new GitHubWorkflowError(
        `Archived task state is invalid: ${stateErrors.join('; ')}`,
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
    assertArchiveEventList(archive.events);
    const terminalBounds = assertTerminalArchive(archivedState, archive.events);
    const archivedTask = matchingTasks[0];
    if (archivedTask.status !== 'completed'
        || !isDeepStrictEqual(projectedArchivedTask(archivedTask), selectedTask)) {
      throw new GitHubWorkflowError(
        'Archived task does not exactly match the active terminal projection',
        'ARCHIVE_TASK_MISMATCH',
      );
    }
    const projection = archiveBatchProofProjection(state, selectedTask, archivedState);
    candidates.push({
      archive,
      archivedState,
      archivedTask,
      terminalBounds,
      projection,
      contentFingerprint: archiveContentFingerprint(archive),
    });
  }
  if (candidates.length === 0) {
    throw new GitHubWorkflowError('No exact immutable archive proves this task', 'ARCHIVE_EVIDENCE_MISSING');
  }
  const projection = candidates[0].projection;
  if (candidates.some((candidate) => !isDeepStrictEqual(candidate.projection, projection))) {
    throw new GitHubWorkflowError(
      'Matching archives carry conflicting task or resolved-root proof lineages',
      'ARCHIVE_EVIDENCE_AMBIGUOUS',
    );
  }
  candidates.sort((left, right) => left.archive.archiveId.localeCompare(right.archive.archiveId));
  return { candidates, projection };
}

export function selectedArchiveIntentCorrelations(state, projection) {
  return projection.proofRows.flatMap((proof) => ['reply', 'resolve'].map((type) => {
    const operationId = `${type}:${state.prNumber}:${proof.threadNodeId}:${projection.historicalHeadSha}`;
    return {
      operationId,
      clientMutationId: intentFor(type, operationId, null).clientMutationId,
      summary: `Intent ${type} ${operationId}`,
    };
  }));
}

export function exactlyMatchesArchiveIntentCorrelation(event, correlation) {
  return event.summary === correlation.summary
    || event.details?.operationId === correlation.operationId
    || event.details?.clientMutationId === correlation.clientMutationId;
}

export function archivedOperationReference(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  return {
    operationId: value,
    type: parts[0],
    tokens: parts,
    threadNodeId: parts.length >= 3 && parts[2].length > 0 ? parts[2] : null,
    wellFormedReplyResolve: ['reply', 'resolve'].includes(parts[0])
      && parts.length === 4
      && /^[1-9]\d*$/u.test(parts[1])
      && parts[2].length > 0
      && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(parts[3]),
  };
}

export function archivedIntentSummaryReference(value) {
  if (typeof value !== 'string') return null;
  const match = /^Intent (\S+) ([\s\S]*)$/u.exec(value);
  if (!match) return null;
  const operation = archivedOperationReference(match[2]);
  return {
    ...operation,
    summaryType: match[1],
    wellFormedReplyResolve: operation.wellFormedReplyResolve
      && operation.type === match[1],
  };
}

export function eventCarriesSelectedArchiveIntent(event, selectedThreadIds) {
  const detailOperation = archivedOperationReference(event.details?.operationId);
  const summaryOperation = archivedIntentSummaryReference(event.summary);
  if ([detailOperation, summaryOperation].some((operation) => (
    operation?.tokens.some((token) => selectedThreadIds.has(token))
  ))) return true;

  const replyResolve = (value) => ['reply', 'resolve'].includes(value);
  const detailAdvertisesReplyResolve = event.type === 'github-mutation-intent'
    && (replyResolve(event.details?.type) || replyResolve(detailOperation?.type));
  const summaryAdvertisesReplyResolve = summaryOperation !== null
    && (replyResolve(summaryOperation.summaryType) || replyResolve(summaryOperation.type));
  if (!detailAdvertisesReplyResolve && !summaryAdvertisesReplyResolve) return false;
  if (detailAdvertisesReplyResolve && (
    detailOperation === null
      || !detailOperation.wellFormedReplyResolve
      || event.details?.type !== detailOperation.type
      || (summaryOperation !== null && !summaryAdvertisesReplyResolve)
  )) return true;
  if (summaryAdvertisesReplyResolve && (
    !summaryOperation.wellFormedReplyResolve
      || (detailOperation !== null && !detailAdvertisesReplyResolve)
  )) return true;
  return detailAdvertisesReplyResolve && summaryAdvertisesReplyResolve
    && (detailOperation.operationId !== summaryOperation.operationId
      || detailOperation.type !== summaryOperation.type);
}

export function selectedArchiveIntentFootprint(state, projection, events) {
  const correlations = selectedArchiveIntentCorrelations(state, projection);
  const selectedThreadIds = new Set(projection.proofRows.map((proof) => proof.threadNodeId));
  return events.filter((event) => (
    correlations.some((correlation) => exactlyMatchesArchiveIntentCorrelation(event, correlation))
    || eventCarriesSelectedArchiveIntent(event, selectedThreadIds)
  ));
}

export function unambiguousSelectedArchiveIntentRoot(event, selectedRoots) {
  const detailOperation = archivedOperationReference(event.details?.operationId);
  const summaryOperation = archivedIntentSummaryReference(event.summary);
  const replyResolve = (value) => ['reply', 'resolve'].includes(value);
  const detailAdvertises = event.type === 'github-mutation-intent'
    && (replyResolve(event.details?.type) || replyResolve(detailOperation?.type));
  const summaryAdvertises = summaryOperation !== null
    && (replyResolve(summaryOperation.summaryType) || replyResolve(summaryOperation.type));
  if (!detailAdvertises && !summaryAdvertises) return null;
  if (detailAdvertises && (detailOperation === null
      || !detailOperation.wellFormedReplyResolve
      || event.details?.type !== detailOperation.type
      || (summaryOperation !== null && !summaryAdvertises))) return null;
  if (summaryAdvertises && (!summaryOperation.wellFormedReplyResolve
      || (detailOperation !== null && !detailAdvertises))) return null;
  if (detailAdvertises && summaryAdvertises
      && (detailOperation.operationId !== summaryOperation.operationId
        || detailOperation.type !== summaryOperation.type)) return null;
  const operations = [detailAdvertises ? detailOperation : null, summaryAdvertises ? summaryOperation : null]
    .filter((operation) => operation !== null);
  const roots = new Set(operations.map((operation) => operation.threadNodeId));
  return roots.size === 1 && selectedRoots.has([...roots][0]) ? [...roots][0] : null;
}

export function indexedAggregateArchiveIntentFootprints(state, candidate, projection, reserveNode) {
  const authorityByRoot = aggregateAuthorityByRoot(projection);
  const selectedRoots = new Set(authorityByRoot.keys());
  const footprints = new Map();
  const bySummary = new Map();
  const byOperationId = new Map();
  const byClientMutationId = new Map();
  const addIndex = (index, key, threadId) => {
    const roots = index.get(key) ?? new Set();
    roots.add(threadId);
    index.set(key, roots);
  };
  for (const [threadId, authority] of authorityByRoot) {
    for (const correlation of selectedArchiveIntentCorrelations(
      state, singleRootProjection(authority),
    )) {
      addIndex(bySummary, correlation.summary, threadId);
      addIndex(byOperationId, correlation.operationId, threadId);
      addIndex(byClientMutationId, correlation.clientMutationId, threadId);
    }
  }
  for (const event of candidate.archive.events) {
    const matchedRoots = new Set([
      ...(bySummary.get(event.summary) ?? []),
      ...(byOperationId.get(event.details?.operationId) ?? []),
      ...(byClientMutationId.get(event.details?.clientMutationId) ?? []),
    ]);
    if (eventCarriesSelectedArchiveIntent(event, selectedRoots)) {
      const referencedRoot = unambiguousSelectedArchiveIntentRoot(event, selectedRoots);
      if (referencedRoot === null) {
        for (const threadId of selectedRoots) matchedRoots.add(threadId);
      } else {
        matchedRoots.add(referencedRoot);
      }
    }
    for (const threadId of matchedRoots) {
      reserveNode();
      const footprint = footprints.get(threadId);
      if (footprint === undefined) footprints.set(threadId, [event]);
      else footprint.push(event);
    }
  }
  return footprints;
}

const EMPTY_AGGREGATE_INTENT_FOOTPRINT = Object.freeze([]);

export function aggregateArchiveIntentFootprint(footprints, threadId) {
  return footprints.get(threadId) ?? EMPTY_AGGREGATE_INTENT_FOOTPRINT;
}

export function assertCompleteSelectedArchiveIntentFootprint(state, projection, footprint) {
  const correlations = selectedArchiveIntentCorrelations(state, projection);
  const correlationsAreUnique = correlations.every((correlation) => (
    footprint.filter((event) => exactlyMatchesArchiveIntentCorrelation(event, correlation)).length === 1
  ));
  const eventsAreUnique = footprint.every((event) => (
    correlations.filter((correlation) => exactlyMatchesArchiveIntentCorrelation(event, correlation)).length === 1
  ));
  if (footprint.length !== correlations.length || !correlationsAreUnique || !eventsAreUnique) {
    throw new GitHubWorkflowError(
      'Archived selected-root intent footprint is partial, duplicated, altered, or conflicting',
      'ARCHIVE_INTENT_AMBIGUOUS',
    );
  }
}

export function assertReplayArchiveBounds(candidate) {
  for (const proof of candidate.projection.proofRows) {
    const resolvedAt = parsedTime(proof.resolvedAt, 'Archived replay resolution proof');
    if (resolvedAt > candidate.terminalBounds.stateUpdatedAt
        || (candidate.terminalBounds.terminalEventAt !== null
          && resolvedAt > candidate.terminalBounds.terminalEventAt)) {
      throw new GitHubWorkflowError(
        'Archived replay proof falls outside its terminal envelope',
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
  }
}

export function normalizedArchiveOriginAuthority(projection, adoption) {
  return {
    projection: structuredClone(projection),
    roots: adoption.evidence.map((item) => ({
      threadNodeId: item.threadNodeId,
      replyBody: item.reply.body,
      intents: structuredClone(item.intents),
    })),
  };
}

export function archiveLineageFingerprint(candidates, roles) {
  const inventory = candidates.map((candidate) => ({
    archiveId: candidate.archive.archiveId,
    contentFingerprint: candidate.contentFingerprint,
    role: roles.get(candidate.archive.archiveId),
  })).sort((left, right) => left.archiveId.localeCompare(right.archiveId));
  return {
    inventory,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(canonicalJson(inventory)))
      .digest('hex'),
  };
}

export function aggregateCanonicalRootIndex(proofRows) {
  const bySource = new Map();
  for (const proof of proofRows) {
    for (const source of [
      `thread:${proof.threadNodeId}`,
      `discussion:${proof.rootCommentDatabaseId}`,
    ]) {
      const existing = bySource.get(source);
      if (existing !== undefined && existing !== proof.threadNodeId) {
        throw new GitHubWorkflowError(
          'Aggregate canonical root aliases are ambiguous',
          'ARCHIVE_PROOF_MISMATCH',
        );
      }
      bySource.set(source, proof.threadNodeId);
    }
  }
  return bySource;
}

export function taskCanonicalRootIds(task, canonicalRootIndex, { requireComplete = false } = {}) {
  const sources = task.sourceIds.filter((source) => /^(?:thread|discussion):/u.test(source));
  if (requireComplete && sources.length === 0) return null;
  const roots = new Set();
  for (const source of sources) {
    const root = canonicalRootIndex.get(source);
    if (root === undefined) {
      if (requireComplete) return null;
      continue;
    }
    roots.add(root);
  }
  return [...roots].sort();
}

export function aggregateSelectedThreadIds(selectedTask, selectedPlan) {
  const selectedRows = selectedPlan.map((entry) => ({
    threadNodeId: entry.thread.id,
    rootCommentDatabaseId: entry.thread.root.databaseId,
  }));
  const threadIds = taskCanonicalRootIds(
    selectedTask, aggregateCanonicalRootIndex(selectedRows), { requireComplete: true },
  );
  const planThreadIds = selectedRows.map((row) => row.threadNodeId).sort();
  if (threadIds === null || threadIds.length < 2 || threadIds.length > MAX_NODES
      || !isDeepStrictEqual(threadIds, planThreadIds)) {
    throw new GitHubWorkflowError(
      'Aggregate archive adoption requires at least two unique canonical root sources',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  return threadIds;
}

export function archiveReferencesSelectedRoots(archive, selectedThreadIds) {
  const selected = new Set(selectedThreadIds);
  const proofReference = Array.isArray(archive?.state?.threadResolutionStatus?.threads)
    && archive.state.threadResolutionStatus.threads.some((proof) => selected.has(proof?.threadNodeId));
  const intentReference = Array.isArray(archive?.events)
    && archive.events.some((event) => event !== null && typeof event === 'object' && !Array.isArray(event)
      && eventCarriesSelectedArchiveIntent(event, selected));
  return proofReference || intentReference;
}

export function validatedAggregateCarrier(state, archive, activeCarrierKind = null) {
  const archivedState = archive.state;
  const stateErrors = Array.isArray(archivedState?.tasks)
    ? validatePrReviewState(archivedState) : ['tasks must be an array'];
  if (archivedState?.schemaVersion !== 3 || stateErrors.length > 0) {
    throw new GitHubWorkflowError(
      `Relevant archived state is invalid: ${stateErrors.join('; ')}`,
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  assertArchiveEventList(archive.events);
  return {
    archive,
    archivedState,
    terminalBounds: assertTerminalArchive(archivedState, archive.events),
    contentFingerprint: archiveContentFingerprint(archive),
    activeCarrierKind,
  };
}

export function selectedCarrierProofRows(candidate, selectedThreadIds) {
  const selected = new Set(selectedThreadIds);
  const rows = candidate.archivedState.threadResolutionStatus.threads
    .filter((proof) => selected.has(proof.threadNodeId));
  const ids = rows.map((proof) => proof.threadNodeId);
  if (new Set(ids).size !== ids.length || rows.length > MAX_NODES) {
    throw new GitHubWorkflowError(
      'Relevant archive duplicates or exceeds selected-root proof bounds',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  return rows.slice().sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
}

export function boundedAggregateSelectedRows(candidates, selectedThreadIds) {
  const selected = new Set(selectedThreadIds);
  let nodeCount = selectedThreadIds.length + 2 + candidates.length;
  if (nodeCount > MAX_NODES) {
    throw new GitHubWorkflowError(
      'Aggregate selected roots, minimum partitions, and relevant carriers exceed the cumulative node bound',
      'ARCHIVE_EVIDENCE_INVALID',
    );
  }
  const rowsByArchive = new Map();
  for (const candidate of candidates) {
    const rows = [];
    const seen = new Set();
    for (const proof of candidate.archivedState.threadResolutionStatus.threads) {
      if (!selected.has(proof.threadNodeId)) continue;
      nodeCount += 1;
      if (nodeCount > MAX_NODES) {
        throw new GitHubWorkflowError(
          'Aggregate carrier-root roles exceed the cumulative node bound',
          'ARCHIVE_EVIDENCE_INVALID',
        );
      }
      if (seen.has(proof.threadNodeId)) {
        throw new GitHubWorkflowError(
          'Relevant archive duplicates selected-root proof',
          'ARCHIVE_PROOF_MISMATCH',
        );
      }
      seen.add(proof.threadNodeId);
      rows.push(proof);
    }
    rows.sort((left, right) => left.threadNodeId.localeCompare(right.threadNodeId));
    rowsByArchive.set(candidate.archive.archiveId, rows);
  }
  return { nodeCount, rowsByArchive };
}

export function aggregateHistoricalProjection(
  state, candidate, selectedThreadIds, selectedRows = null, reservePartition = null,
) {
  const proofRows = selectedRows ?? selectedCarrierProofRows(candidate, selectedThreadIds);
  if (proofRows.length === 0 || proofRows.some((proof) => Object.hasOwn(proof, 'archiveProvenance')
      || proof.taskIds.length !== 1 || proof.isResolved !== true
      || proof.replyId === null || proof.replyUrl === null
      || proof.resolvedAt === null || proof.resolvedBy === null
      || proof.observedHeadSha === state.currentIntegrationHeadSha)) {
    throw new GitHubWorkflowError(
      'Historical aggregate carrier proof is incomplete or provenance-mixed',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const partitions = [];
  for (const taskId of [...new Set(proofRows.flatMap((proof) => proof.taskIds))].sort()) {
    const partitionRows = proofRows.filter((proof) => proof.taskIds[0] === taskId);
    const matchingTasks = candidate.archivedState.tasks.filter((task) => task.id === taskId);
    if (matchingTasks.length !== 1) {
      throw new GitHubWorkflowError('Historical aggregate task is missing or duplicated', 'ARCHIVE_TASK_MISMATCH');
    }
    const task = matchingTasks[0];
    const taskThreadIds = taskCanonicalRootIds(
      task, aggregateCanonicalRootIndex(proofRows), { requireComplete: true },
    );
    const partitionThreadIds = partitionRows.map((proof) => proof.threadNodeId).sort();
    const expectedDisposition = task.disposition === 'actionable' ? 'fixed'
      : task.disposition === 'already-fixed' ? 'already-fixed' : null;
    const heads = new Set(partitionRows.map((proof) => proof.observedHeadSha));
    if (task.sourceType !== 'github-thread' || task.status !== 'completed'
        || taskThreadIds === null
        || !isDeepStrictEqual(taskThreadIds, partitionThreadIds)
        || expectedDisposition === null
        || partitionRows.some((proof) => proof.disposition !== expectedDisposition)
        || (task.disposition === 'actionable' && typeof task.integratedCommitSha !== 'string')
        || (task.disposition === 'already-fixed' && task.integratedCommitSha !== null)
        || heads.size !== 1) {
      throw new GitHubWorkflowError(
        'Historical aggregate task partition is incomplete, divergent, or ineligible',
        'ARCHIVE_TASK_MISMATCH',
      );
    }
    if (partitions.length >= 2) reservePartition?.();
    partitions.push({
      historicalTask: task,
      historicalDisposition: expectedDisposition,
      historicalHeadSha: [...heads][0],
      proofRows: partitionRows,
    });
  }
  return { partitions, proofRows };
}

export function aggregateFullAuthorityProjection(
  state, historicalCandidates, selectedThreadIds, selectedRowsByArchive, reservePartition,
) {
  const full = historicalCandidates.filter((candidate) => (
    selectedRowsByArchive.get(candidate.archive.archiveId).length === selectedThreadIds.length
  ));
  if (full.length === 0) {
    throw new GitHubWorkflowError(
      'Aggregate adoption requires one complete historical full carrier',
      'ARCHIVE_EVIDENCE_MISSING',
    );
  }
  const projection = aggregateHistoricalProjection(
    state,
    full[0],
    selectedThreadIds,
    selectedRowsByArchive.get(full[0].archive.archiveId),
    reservePartition,
  );
  if (projection.proofRows.length !== selectedThreadIds.length
      || full.slice(1).some((candidate) => !isDeepStrictEqual(
        aggregateHistoricalProjection(
          state, candidate, selectedThreadIds, selectedRowsByArchive.get(candidate.archive.archiveId),
        ),
        projection,
      ))) {
    throw new GitHubWorkflowError(
      'Historical full carriers disagree on the aggregate partition authority',
      'ARCHIVE_EVIDENCE_AMBIGUOUS',
    );
  }
  return projection;
}

export function aggregateAuthorityByRoot(projection) {
  const byRoot = new Map();
  for (const partition of projection.partitions) {
    for (const proof of partition.proofRows) {
      byRoot.set(proof.threadNodeId, {
        historicalTask: partition.historicalTask,
        historicalDisposition: partition.historicalDisposition,
        historicalHeadSha: partition.historicalHeadSha,
        proof,
      });
    }
  }
  return byRoot;
}

export function assertHistoricalCarrierSlice(candidate, projection, rows) {
  if (rows.length === 0) {
    throw new GitHubWorkflowError('Intent-only aggregate carrier is not authoritative', 'ARCHIVE_PROOF_MISMATCH');
  }
  const carriedRoots = new Set(rows.map((proof) => proof.threadNodeId));
  const authorityByRoot = aggregateAuthorityByRoot(projection);
  const canonicalRootIndex = aggregateCanonicalRootIndex(projection.proofRows);
  const partitionsByTask = new Map(projection.partitions.map((partition) => (
    [partition.historicalTask.id, partition]
  )));
  const archivedTasksById = new Map();
  const requiredHistoricalTaskIds = new Set();
  for (const task of candidate.archivedState.tasks) {
    const indexed = archivedTasksById.get(task.id);
    if (indexed === undefined) archivedTasksById.set(task.id, { count: 1, task });
    else indexed.count += 1;
    if (task.sourceType === 'github-thread'
        && taskCanonicalRootIds(task, canonicalRootIndex).length !== 0) {
      requiredHistoricalTaskIds.add(task.id);
    }
  }
  for (const row of candidate.archivedState.threadResolutionStatus.threads) {
    const provenanceTaskId = row.archiveProvenance?.historicalTaskId;
    if (partitionsByTask.has(provenanceTaskId)) {
      requiredHistoricalTaskIds.add(provenanceTaskId);
      if (!row.taskIds.includes(provenanceTaskId)) {
        throw new GitHubWorkflowError(
          'Aggregate carrier provenance references historical authority outside its exact partition',
          'ARCHIVE_EVIDENCE_AMBIGUOUS',
        );
      }
    }
    for (const taskId of row.taskIds) {
      if (partitionsByTask.has(taskId)) requiredHistoricalTaskIds.add(taskId);
    }
  }
  for (const taskId of requiredHistoricalTaskIds) {
    const partition = partitionsByTask.get(taskId);
    const indexedTask = archivedTasksById.get(taskId);
    const task = indexedTask?.task;
    const taskThreadIds = task?.sourceType === 'github-thread'
      ? taskCanonicalRootIds(task, canonicalRootIndex, { requireComplete: true }) : null;
    const authorityRows = new Map(partition?.proofRows.map((row) => [row.threadNodeId, row]) ?? []);
    const taskRowIds = [];
    let taskRowsAreExact = true;
    for (const row of candidate.archivedState.threadResolutionStatus.threads) {
      if (!row.taskIds.includes(taskId)) continue;
      taskRowIds.push(row.threadNodeId);
      if (row.taskIds.length !== 1 || row.taskIds[0] !== taskId
          || !isDeepStrictEqual(row, authorityRows.get(row.threadNodeId))) {
        taskRowsAreExact = false;
      }
    }
    taskRowIds.sort();
    if (!partition || indexedTask?.count !== 1
        || !isDeepStrictEqual(task, partition.historicalTask)
        || taskThreadIds === null
        || !isDeepStrictEqual(taskThreadIds, taskRowIds)
        || !taskRowsAreExact) {
      throw new GitHubWorkflowError(
        'Aggregate carrier has an unanchored, overlapping, or incomplete historical task partition',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
  }
  for (const partition of projection.partitions) {
    const roots = partition.proofRows.map((proof) => proof.threadNodeId);
    const count = roots.filter((root) => carriedRoots.has(root)).length;
    if (count !== 0 && count !== roots.length) {
      throw new GitHubWorkflowError(
        'Partial aggregate carrier slices a historical task partition',
        'ARCHIVE_PROOF_MISMATCH',
      );
    }
  }
  for (const row of rows) {
    const authority = authorityByRoot.get(row.threadNodeId);
    const indexedTask = archivedTasksById.get(authority?.historicalTask.id);
    if (!authority || !isDeepStrictEqual(row, authority.proof)
        || indexedTask?.count !== 1
        || !isDeepStrictEqual(indexedTask.task, authority.historicalTask)) {
      throw new GitHubWorkflowError(
        'Aggregate carrier diverges from its anchored historical partition',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
  }
  return rows;
}

export function archiveReferencesAnchoredHistoricalTasks(archive, anchoredTaskIds) {
  if (Array.isArray(archive?.state?.tasks)) {
    for (const task of archive.state.tasks) {
      if (anchoredTaskIds.has(task?.id)) return true;
    }
  }
  const proofRows = archive?.state?.threadResolutionStatus?.threads;
  if (!Array.isArray(proofRows)) return false;
  for (const row of proofRows) {
    if (anchoredTaskIds.has(row?.archiveProvenance?.historicalTaskId)) return true;
    if (!Array.isArray(row?.taskIds)) continue;
    for (const taskId of row.taskIds) {
      if (anchoredTaskIds.has(taskId)) return true;
    }
  }
  return false;
}

export function singleRootProjection(authority) {
  return {
    task: authority.historicalTask,
    proofRows: [authority.proof],
    historicalHeadSha: authority.historicalHeadSha,
  };
}

export function validateAggregateRootOrigin(state, live, selectedPlanByRoot, candidate, authority) {
  const entry = selectedPlanByRoot.get(authority.proof.threadNodeId);
  if (!entry) throw new GitHubWorkflowError('Aggregate live root is missing', 'ARCHIVE_LIVE_MISMATCH');
  const adoption = validateArchiveBatchLive(
    state,
    live,
    authority.historicalTask,
    [entry],
    {
      ...candidate,
      archivedTask: authority.historicalTask,
      projection: singleRootProjection(authority),
    },
    { aggregateOrigin: true },
  );
  return adoption.evidence[0];
}

export function normalizedAggregateRootAuthority(authority, evidence) {
  return {
    threadNodeId: authority.proof.threadNodeId,
    proof: structuredClone(authority.proof),
    historicalTask: structuredClone(authority.historicalTask),
    observedHeadSha: authority.historicalHeadSha,
    replyBody: evidence.reply.body,
    intents: structuredClone(evidence.intents),
  };
}

export function aggregateInventoryFingerprint(candidates, roleEntries, authorityFingerprint) {
  const inventory = candidates.map((candidate) => ({
    archiveId: candidate.archive.archiveId,
    contentFingerprint: candidate.contentFingerprint,
    partitionRootRoles: roleEntries.get(candidate.archive.archiveId)
      .slice().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).sort((left, right) => left.archiveId.localeCompare(right.archiveId));
  const bound = { authorityFingerprint, inventory };
  return {
    inventory,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(canonicalJson(bound)))
      .digest('hex'),
  };
}

export function aggregateProofCore(proof) {
  return {
    threadNodeId: proof.threadNodeId,
    rootCommentNodeId: proof.rootCommentNodeId,
    rootCommentDatabaseId: proof.rootCommentDatabaseId,
    replyId: proof.replyId,
    replyUrl: proof.replyUrl,
    isResolved: proof.isResolved,
    resolvedAt: proof.resolvedAt,
    resolvedBy: proof.resolvedBy,
    observedHeadSha: proof.observedHeadSha,
  };
}

export function assertAggregateReplayCarrier(
  selectedTask, candidate, rows, selectedThreadIds, projection, authorityRootsByRoot,
  authorityFingerprint, intentFootprints,
) {
  const archivedActiveTaskIds = [...new Set(rows.flatMap((row) => row.taskIds))];
  const archivedActiveTaskId = archivedActiveTaskIds.length === 1 ? archivedActiveTaskIds[0] : null;
  const matchingTasks = candidate.archivedState.tasks.filter((task) => task.id === selectedTask.id);
  const authorityByRoot = aggregateAuthorityByRoot(projection);
  const canonicalRootIndex = aggregateCanonicalRootIndex(projection.proofRows);
  const archivedTaskThreadIds = matchingTasks.length === 1
    ? taskCanonicalRootIds(matchingTasks[0], canonicalRootIndex, { requireComplete: true }) : null;
  const selectedRows = new Set(rows.map((row) => row.threadNodeId));
  const allActiveRows = candidate.archivedState.threadResolutionStatus.threads.filter(
    (row) => row.taskIds.includes(selectedTask.id),
  );
  const anchoredHistoricalTaskIds = new Set(
    projection.partitions.map((partition) => partition.historicalTask.id),
  );
  const replayClosureIsExact = candidate.archivedState.tasks.every((task) => {
    if (task.sourceType !== 'github-thread') return true;
    const intersecting = taskCanonicalRootIds(task, canonicalRootIndex);
    return intersecting.length === 0 || task.id === selectedTask.id;
  }) && candidate.archivedState.threadResolutionStatus.threads.every((row) => {
    if (row.taskIds.some((taskId) => anchoredHistoricalTaskIds.has(taskId))) return false;
    if (!anchoredHistoricalTaskIds.has(row.archiveProvenance?.historicalTaskId)) return true;
    return row.taskIds.length === 1 && row.taskIds[0] === selectedTask.id
      && selectedRows.has(row.threadNodeId);
  });
  if (rows.length !== selectedThreadIds.length || matchingTasks.length !== 1
      || archivedActiveTaskId !== selectedTask.id
      || allActiveRows.length !== rows.length
      || allActiveRows.some((row) => !selectedRows.has(row.threadNodeId))
      || !replayClosureIsExact
      || matchingTasks[0].status !== 'completed'
      || matchingTasks[0].sourceType !== 'github-thread'
      || matchingTasks[0].disposition !== 'already-fixed'
      || matchingTasks[0].integratedCommitSha !== null
      || archivedTaskThreadIds === null
      || !isDeepStrictEqual(archivedTaskThreadIds, selectedThreadIds)
      || !isDeepStrictEqual(projectedArchivedTask(matchingTasks[0]), selectedTask)
      || rows.some((row) => row.taskIds.length !== 1 || row.taskIds[0] !== archivedActiveTaskId
        || row.disposition !== 'already-fixed' || !Object.hasOwn(row, 'archiveProvenance'))) {
    throw new GitHubWorkflowError(
      'Active aggregate replay carrier is incomplete or downgraded',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const roles = [];
  for (const row of rows) {
    const authority = authorityByRoot.get(row.threadNodeId);
    const normalizedAuthority = authorityRootsByRoot.get(row.threadNodeId);
    const provenance = row.archiveProvenance;
    const expectedBodyHash = createHash('sha256')
      .update(normalizedAuthority?.replyBody ?? '', 'utf8').digest('hex');
    if (!authority || !normalizedAuthority
        || !isDeepStrictEqual(aggregateProofCore(row), aggregateProofCore(authority.proof))
        || provenance.schemaVersion !== 1
        || provenance.historicalTaskId !== authority.historicalTask.id
        || provenance.historicalDisposition !== authority.historicalDisposition
        || provenance.historicalIntegratedCommitSha !== authority.historicalTask.integratedCommitSha
        || provenance.replyBodySha256 !== expectedBodyHash
        || provenance.authorityFingerprint !== authorityFingerprint) {
      throw new GitHubWorkflowError(
        'Active aggregate replay provenance is missing, altered, or inconsistent',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
    const projectionForRoot = singleRootProjection(authority);
    const footprint = aggregateArchiveIntentFootprint(intentFootprints, row.threadNodeId);
    if (footprint.length !== 0) {
      throw new GitHubWorkflowError(
        'Active aggregate carrier may replay but cannot originate historical authority',
        'ARCHIVE_INTENT_AMBIGUOUS',
      );
    }
    assertReplayArchiveBounds({ ...candidate, projection: projectionForRoot });
    roles.push({
      historicalTaskId: authority.historicalTask.id,
      threadNodeId: row.threadNodeId,
      role: 'replay',
    });
  }
  return roles;
}

export function aggregateAncestryRelations(state, candidates, projection, selectedRowsByArchive) {
  const relations = new Map();
  const add = (ancestorSha, descendantSha, label) => {
    relations.set(`${ancestorSha}:${descendantSha}`, { ancestorSha, descendantSha, label });
  };
  for (const partition of projection.partitions) {
    if (partition.historicalDisposition === 'fixed') {
      add(
        partition.historicalTask.integratedCommitSha,
        partition.historicalHeadSha,
        `historical task ${partition.historicalTask.id}`,
      );
    }
  }
  for (const candidate of candidates) {
    for (const row of selectedRowsByArchive.get(candidate.archive.archiveId)) {
      add(
        row.observedHeadSha,
        candidate.archivedState.currentIntegrationHeadSha,
        `archive ${candidate.archive.archiveId} proof`,
      );
    }
    add(
      candidate.archivedState.currentIntegrationHeadSha,
      state.currentIntegrationHeadSha,
      `archive ${candidate.archive.archiveId} carrier`,
    );
  }
  return [...relations.values()].sort((left, right) => (
    `${left.ancestorSha}:${left.descendantSha}`.localeCompare(`${right.ancestorSha}:${right.descendantSha}`)
  ));
}

export function validateAggregateArchiveLineage(
  state, live, selectedTask, selectedPlan, candidates, provenanceCandidates, archiveInventory,
) {
  const selectedThreadIds = aggregateSelectedThreadIds(selectedTask, selectedPlan);
  const planThreadIds = selectedPlan.map((entry) => entry.thread.id).sort();
  if (!isDeepStrictEqual(planThreadIds, selectedThreadIds)) {
    throw new GitHubWorkflowError(
      'Aggregate archive roots do not exactly match the exclusive live plan',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const provenanceIds = new Set(provenanceCandidates.map((candidate) => candidate.archive.archiveId));
  const historicalCandidates = candidates.filter((candidate) => !provenanceIds.has(candidate.archive.archiveId));
  const boundedRows = boundedAggregateSelectedRows(candidates, selectedThreadIds);
  const selectedRowsByArchive = boundedRows.rowsByArchive;
  let aggregateNodeCount = boundedRows.nodeCount;
  const reserveAggregateNode = (count = 1) => {
    aggregateNodeCount += count;
    if (aggregateNodeCount > MAX_NODES) {
      throw new GitHubWorkflowError(
        'Aggregate partitions, carriers, roles, and intent footprints exceed the cumulative node bound',
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
  };
  const projection = aggregateFullAuthorityProjection(
    state, historicalCandidates, selectedThreadIds, selectedRowsByArchive, reserveAggregateNode,
  );
  if (projection.partitions.length < 2 || projection.partitions.length > MAX_NODES) {
    throw new GitHubWorkflowError(
      'Aggregate adoption requires multiple bounded historical task partitions',
      'ARCHIVE_PROOF_MISMATCH',
    );
  }
  const candidateIds = new Set();
  for (const candidate of candidates) candidateIds.add(candidate.archive.archiveId);
  const anchoredHistoricalTaskIds = new Set();
  for (const partition of projection.partitions) {
    anchoredHistoricalTaskIds.add(partition.historicalTask.id);
  }
  for (const archive of archiveInventory) {
    if (candidateIds.has(archive.archiveId)
        || archive?.state?.repository !== state.repository
        || archive?.state?.prNumber !== state.prNumber) continue;
    if (archiveReferencesAnchoredHistoricalTasks(archive, anchoredHistoricalTaskIds)) {
      throw new GitHubWorkflowError(
        'An off-selection archive carrier references anchored historical authority',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
  }
  const historicalRowsByArchive = new Map(historicalCandidates.map((candidate) => [
    candidate.archive.archiveId,
    assertHistoricalCarrierSlice(
      candidate, projection, selectedRowsByArchive.get(candidate.archive.archiveId),
    ),
  ]));
  const provenanceRowsByArchive = new Map(provenanceCandidates.map((candidate) => [
    candidate.archive.archiveId,
    selectedRowsByArchive.get(candidate.archive.archiveId),
  ]));
  const intentFootprintsByArchive = new Map();
  for (const candidate of candidates) {
    intentFootprintsByArchive.set(
      candidate.archive.archiveId,
      indexedAggregateArchiveIntentFootprints(
        state, candidate, projection, reserveAggregateNode,
      ),
    );
  }
  const authorityByRoot = aggregateAuthorityByRoot(projection);
  const selectedPlanByRoot = new Map(selectedPlan.map((entry) => [entry.thread.id, entry]));
  const origins = new Map(selectedThreadIds.map((threadId) => [threadId, []]));
  const roleEntries = new Map(candidates.map((candidate) => [candidate.archive.archiveId, []]));
  for (const candidate of historicalCandidates) {
    const carriedRows = historicalRowsByArchive.get(candidate.archive.archiveId);
    const carried = new Set(carriedRows.map((row) => row.threadNodeId));
    const intentFootprints = intentFootprintsByArchive.get(candidate.archive.archiveId);
    for (const threadId of selectedThreadIds) {
      const authority = authorityByRoot.get(threadId);
      const rootProjection = singleRootProjection(authority);
      const footprint = aggregateArchiveIntentFootprint(intentFootprints, threadId);
      if (!carried.has(threadId)) {
        if (footprint.length !== 0) {
          throw new GitHubWorkflowError(
            'Archive carries selected-root intent evidence outside its proof partition',
            'ARCHIVE_INTENT_AMBIGUOUS',
          );
        }
        continue;
      }
      let role = 'replay';
      if (footprint.length === 0) {
        assertReplayArchiveBounds({ ...candidate, projection: rootProjection });
      } else {
        assertCompleteSelectedArchiveIntentFootprint(state, rootProjection, footprint);
        const evidence = validateAggregateRootOrigin(
          state, live, selectedPlanByRoot, candidate, authority,
        );
        origins.get(threadId).push({
          archiveId: candidate.archive.archiveId,
          evidence,
          authority: normalizedAggregateRootAuthority(authority, evidence),
        });
        role = 'origin';
      }
      roleEntries.get(candidate.archive.archiveId).push({
        historicalTaskId: authority.historicalTask.id,
        threadNodeId: threadId,
        role,
      });
    }
  }
  const authorityRoots = [];
  const evidence = [];
  for (const threadId of selectedThreadIds) {
    const rootOrigins = origins.get(threadId);
    if (rootOrigins.length === 0) {
      throw new GitHubWorkflowError(
        `Aggregate root ${threadId} lacks an original reply and resolve authority`,
        'ARCHIVE_INTENT_AMBIGUOUS',
      );
    }
    const normalized = rootOrigins[0].authority;
    if (rootOrigins.some((origin) => !isDeepStrictEqual(origin.authority, normalized))) {
      throw new GitHubWorkflowError(
        `Aggregate root ${threadId} has conflicting origin authorities`,
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
    rootOrigins.sort((left, right) => left.archiveId.localeCompare(right.archiveId));
    authorityRoots.push(normalized);
    const authority = authorityByRoot.get(threadId);
    evidence.push({
      ...rootOrigins[0].evidence,
      historicalTask: structuredClone(authority.historicalTask),
      historicalDisposition: authority.historicalDisposition,
      historicalHeadSha: authority.historicalHeadSha,
    });
  }
  const authorityFingerprint = createHash('sha256')
    .update(JSON.stringify(canonicalJson({ roots: authorityRoots })))
    .digest('hex');
  const authorityRootsByRoot = new Map(authorityRoots.map((root) => [root.threadNodeId, root]));
  for (const candidate of provenanceCandidates) {
    const roles = assertAggregateReplayCarrier(
      selectedTask, candidate, provenanceRowsByArchive.get(candidate.archive.archiveId),
      selectedThreadIds, projection, authorityRootsByRoot, authorityFingerprint,
      intentFootprintsByArchive.get(candidate.archive.archiveId),
    );
    roleEntries.set(candidate.archive.archiveId, roles);
  }
  const replyBodies = new Map(authorityRoots.map((root) => [root.threadNodeId, root.replyBody]));
  const finalizedEvidence = evidence.map((item) => ({
    ...item,
    archiveProvenance: {
      schemaVersion: 1,
      historicalTaskId: item.historicalTask.id,
      historicalDisposition: item.historicalDisposition,
      historicalIntegratedCommitSha: item.historicalTask.integratedCommitSha,
      replyBodySha256: createHash('sha256').update(replyBodies.get(item.threadNodeId), 'utf8').digest('hex'),
      authorityFingerprint,
    },
  }));
  const inventory = aggregateInventoryFingerprint(candidates, roleEntries, authorityFingerprint);
  return {
    mode: 'aggregate',
    evidence: finalizedEvidence,
    archiveLineage: { ...inventory, authorityFingerprint },
    ancestryRelations: aggregateAncestryRelations(state, candidates, projection, new Map([
      ...historicalRowsByArchive,
      ...provenanceRowsByArchive,
    ])),
  };
}

export function activeArchiveCarrierKind(state, selectedTask, archive) {
  const archivedState = archive?.state;
  if (archivedState?.repository !== state.repository
      || archivedState?.prNumber !== state.prNumber) return null;
  let matchingTaskCount = 0;
  if (Array.isArray(archivedState.tasks)) {
    for (const task of archivedState.tasks) {
      if (task?.id !== selectedTask.id) continue;
      matchingTaskCount += 1;
    }
  }
  const proofRows = archivedState.threadResolutionStatus?.threads;
  if (!Array.isArray(proofRows)) return matchingTaskCount === 0 ? null : 'ordinary';
  let matchingProofCount = 0;
  let sawProvenance = false;
  let sawLegacy = false;
  for (const proof of proofRows) {
    if (!Array.isArray(proof?.taskIds) || !proof.taskIds.includes(selectedTask.id)) continue;
    matchingProofCount += 1;
    if (Object.hasOwn(proof, 'archiveProvenance')) sawProvenance = true;
    else sawLegacy = true;
    if (sawProvenance && sawLegacy) {
      throw new GitHubWorkflowError(
        'Active archive carrier mixes aggregate provenance with legacy proof rows',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
  }
  if (matchingTaskCount === 0 && matchingProofCount === 0) return null;
  return sawProvenance ? 'aggregate-replay' : 'ordinary';
}

export async function selectArchiveForBatch(state, selectedTask, selectedPlan, archiveStore) {
  if (!archiveStore?.list) {
    throw new GitHubWorkflowError('Immutable archive evidence is unavailable', 'ARCHIVE_EVIDENCE_MISSING');
  }
  const archives = await archiveStore.list(state.prNumber);
  assertArchiveInventory(archives);
  const selectedThreadIds = aggregateSelectedThreadIds(selectedTask, selectedPlan);
  const relevantArchives = [];
  let minimumAggregateNodes = selectedThreadIds.length + 2;
  let hasOrdinaryCarrier = false;
  let hasAggregateReplayCarrier = false;
  for (const archive of archives) {
    const kind = activeArchiveCarrierKind(state, selectedTask, archive);
    hasOrdinaryCarrier ||= kind === 'ordinary';
    hasAggregateReplayCarrier ||= kind === 'aggregate-replay';
    if (hasOrdinaryCarrier && hasAggregateReplayCarrier) {
      throw new GitHubWorkflowError(
        'Ordinary and aggregate replay carriers cannot be mixed',
        'ARCHIVE_EVIDENCE_AMBIGUOUS',
      );
    }
    const samePullRequest = archive?.state?.repository === state.repository
      && archive?.state?.prNumber === state.prNumber;
    if (!samePullRequest || (kind === null
        && !archiveReferencesSelectedRoots(archive, selectedThreadIds))) continue;
    minimumAggregateNodes += 1;
    if (minimumAggregateNodes > MAX_NODES) {
      throw new GitHubWorkflowError(
        'Aggregate selected roots, minimum partitions, and relevant carriers exceed the cumulative node bound',
        'ARCHIVE_EVIDENCE_INVALID',
      );
    }
    relevantArchives.push({ archive, kind });
  }
  if (hasOrdinaryCarrier) {
    return { mode: 'legacy', ...selectLegacyArchiveForBatch(state, selectedTask, archives) };
  }
  if (selectedTask.disposition !== 'already-fixed') {
    throw new GitHubWorkflowError(
      'Aggregate archive adoption is limited to an already-fixed active task',
      'ARCHIVE_TASK_MISMATCH',
    );
  }
  const relevant = relevantArchives.map(({ archive, kind }) => (
    validatedAggregateCarrier(state, archive, kind)
  ));
  if (relevant.length === 0) {
    throw new GitHubWorkflowError('No immutable archive proves this aggregate task', 'ARCHIVE_EVIDENCE_MISSING');
  }
  const provenanceCandidates = relevant.filter(
    (candidate) => candidate.activeCarrierKind === 'aggregate-replay',
  );
  return {
    mode: 'aggregate', candidates: relevant, provenanceCandidates, archiveInventory: archives,
  };
}

export function validateArchiveBatchLineage(state, live, selectedTask, selectedPlan, lineage) {
  if (lineage.mode === 'aggregate') {
    return validateAggregateArchiveLineage(
      state, live, selectedTask, selectedPlan, lineage.candidates, lineage.provenanceCandidates,
      lineage.archiveInventory,
    );
  }
  if (!isDeepStrictEqual(lineage.projection.task, selectedTask)) {
    throw new GitHubWorkflowError('Archive lineage task projection changed', 'ARCHIVE_TASK_MISMATCH');
  }
  const origins = [];
  const roles = new Map();
  for (const candidate of lineage.candidates) {
    const archiveId = candidate.archive.archiveId;
    const footprint = selectedArchiveIntentFootprint(
      state, candidate.projection, candidate.archive.events,
    );
    if (footprint.length === 0) {
      assertReplayArchiveBounds(candidate);
      roles.set(archiveId, 'replay');
      continue;
    }
    assertCompleteSelectedArchiveIntentFootprint(state, candidate.projection, footprint);
    const adoption = validateArchiveBatchLive(
      state, live, selectedTask, selectedPlan, candidate,
    );
    origins.push({
      archiveId,
      adoption,
      authority: normalizedArchiveOriginAuthority(lineage.projection, adoption),
    });
    roles.set(archiveId, 'origin');
  }
  if (origins.length === 0) {
    throw new GitHubWorkflowError(
      'Archive lineage lacks a complete original reply and resolve intent authority',
      'ARCHIVE_INTENT_AMBIGUOUS',
    );
  }
  const authority = origins[0].authority;
  if (origins.some((origin) => !isDeepStrictEqual(origin.authority, authority))) {
    throw new GitHubWorkflowError(
      'Archive lineage contains conflicting complete intent authorities',
      'ARCHIVE_EVIDENCE_AMBIGUOUS',
    );
  }
  origins.sort((left, right) => left.archiveId.localeCompare(right.archiveId));
  const lineageInventory = archiveLineageFingerprint(lineage.candidates, roles);
  return {
    ...origins[0].adoption,
    archiveLineage: {
      ...lineageInventory,
      authorityFingerprint: createHash('sha256')
        .update(JSON.stringify(canonicalJson(authority)))
        .digest('hex'),
    },
  };
}
