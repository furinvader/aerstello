import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { commit, createRepository, git } from '../../../../../tests/support/git-fixtures.mjs';
import { implementationTaskDigest } from '../implementation/contracts.mjs';
import {
  implementationTaskPacketPath,
  implementationWorktreeCreationIntentPath,
  implementationWorktreeManifestPath,
  implementationWorktreePath,
  implementationWorktreeRemovalIntentPath,
  implementationWorktreeRoot,
  implementationWorktreeTombstonePath,
} from '../paths.mjs';
import {
  acceptPlan, acceptResult, amendPlan, archiveState, bindTask, initializeState, rejectTask, scheduleWave, startTask, StateError,
} from '../state/state.mjs';
import {
  createTaskWorktree, inspectTaskWorktree, recoverTaskWorktree, removeTaskWorktree,
} from './worktree.mjs';

const repositories = [];
const registry = loadRegistry();
function specialization() {
  const value = { specialization: 'ops-workflow', affectedAreas: ['workflow'], riskTags: ['workflow'],
    browserVisible: false, relatedTestSelectionUncertain: false };
  return { ...value, route: routeSpecialists({ specialization: value.specialization, riskTags: value.riskTags,
    browserVisible: value.browserVisible, testSelectionUncertain: value.relatedTestSelectionUncertain }, registry) };
}

async function boundRepository(taskId = 'worker-layer') {
  const cwd = createRepository(); repositories.push(cwd);
  const base = commit(cwd, { 'request.md': '# Worktree request\n' }, 'test: add worktree request');
  const planning = await initializeState({ cwd, changeId: 'issue-23', mode: 'implement', baseBranch: 'main',
    planningRef: base, source: { type: 'direct-request', path: 'request.md', relationshipIntent: 'resolves' } });
  const profile = specialization();
  const plan = {
    schemaVersion: 1, planRevision: 1, changeId: 'issue-23',
    source: { kind: planning.source.kind, reference: planning.source.reference,
      relationship: planning.source.relationship, captureDigest: planning.source.latestDigest },
    title: 'Bound worktree fixture', objective: 'Exercise exact worktree lifecycle evidence.',
    scope: ['Repository workflow'], nonGoals: ['Product behavior'],
    planning: { planningSha: base, baseBranch: 'main', comparisonBaseSha: null }, expectedPrBaseBranch: 'main',
    criteria: [{ id: 'safe-worktree', description: 'Worker worktrees recover safely.', disposition: 'owned', ownerTaskId: taskId, deferredReason: null }],
    decisions: [], scenarios: [], productScenarioDisposition: { disposition: 'not-applicable', scenarioIds: [], rationale: 'Workflow-only behavior.' },
    specialization: profile, checklistMappings: [],
    tasks: [{ id: taskId, title: 'Implement worker layer', objective: 'Harden worktree lifecycle.',
      rationale: 'Workers require exact isolation.', specialization: profile, criterionIds: ['safe-worktree'],
      decisionIds: [], scenarioIds: [], checklistItemIds: [], dependsOn: [], anticipatedPaths: ['src'],
      produces: [], consumes: [], validationIntent: ['Exercise the focused worktree lifecycle'], unsplittable: null }],
  };
  const accepted = acceptPlan({ cwd, expectedRevision: planning.revision, plan, planningEvidence: [] });
  const packet = {
    schemaVersion: 1, changeId: 'issue-23', taskId, planRevision: 1,
    planDigest: accepted.plan.effectiveDigest, planningSha: base, taskBaseSha: base,
    specialization: profile.specialization, riskTags: profile.riskTags, affectedAreas: profile.affectedAreas,
    planningSignals: { browserVisible: profile.browserVisible,
      relatedTestSelectionUncertain: profile.relatedTestSelectionUncertain },
    specialistRoute: profile.route, behaviorMapperEvidence: null,
    objective: plan.tasks[0].objective, evidence: 'The accepted plan binds this exact task.',
    decisionIds: [], decisionContext: [], acceptanceCriteriaIds: ['safe-worktree'],
    acceptanceCriteria: [{ id: 'safe-worktree', description: 'Worker worktrees recover safely.' }],
    allowedPaths: ['src/**'], forbiddenPaths: [], dependencies: [],
    requiredValidation: { unit: [{ command: 'node --test src/example.test.mjs', reason: 'Exercise the exact task.' }], system: [] },
  };
  const packetDigest = implementationTaskDigest(packet);
  const bound = bindTask({ cwd, changeId: 'issue-23', packet, expectedRevision: accepted.revision });
  return { cwd, base, priorBase: git(cwd, ['rev-parse', 'HEAD^']), plan, packet, packetDigest, bound, taskId };
}

function create(context, options = {}) {
  return createTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    base: context.base, packetDigest: context.packetDigest, ...options });
}

function noChangeResult(context) {
  return {
    schemaVersion: 1, changeId: 'issue-23', taskId: context.taskId,
    planDigest: context.packet.planDigest, packetDigest: context.packetDigest,
    specialization: context.packet.specialization, taskBaseSha: context.base,
    status: 'no-change', workerCommit: null, changedPaths: [],
    validation: context.packet.requiredValidation.unit.map(({ command }) => ({ command, result: 'passed', summary: 'Focused validation passed.' })),
    unexpectedDependencies: [], summary: 'The bound task required no repository changes.',
  };
}

function authorizeNoChangeRemoval(context, worktree) {
  const scheduled = scheduleWave({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: context.bound.revision });
  const started = startTask({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    workerId: 'implementation-worker', expectedRevision: scheduled.revision });
  return acceptResult({ cwd: context.cwd, changeId: 'issue-23', result: noChangeResult(context),
    workerCwd: worktree.path, expectedRevision: started.revision });
}

afterEach(() => { while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true }); });

test('canonical path helpers keep task evidence and worktrees below the shared roots', async () => {
  const context = await boundRepository();
  assert.equal(implementationWorktreePath(context.cwd, 'issue-23', context.taskId),
    join(implementationWorktreeRoot(context.cwd), 'changes', 'issue-23', context.taskId));
  assert.equal(implementationWorktreeManifestPath(context.cwd, 'issue-23', context.taskId),
    join(implementationWorktreeRoot(context.cwd), 'manifests', 'issue-23', `${context.taskId}.json`));
  assert.ok(implementationTaskPacketPath(context.cwd, 'issue-23', context.taskId, 1).endsWith('/implementation/tasks/worker-layer/0001.json'));
});

test('creation binds receipt-valid active state, packet, exact full base, and active manifest', async () => {
  const context = await boundRepository(); const result = create(context);
  assert.equal(git(result.path, ['rev-parse', 'HEAD']), context.base);
  assert.equal(result.status, 'active'); assert.equal(result.baseSha, context.base);
  assert.equal(result.packetDigest, context.packetDigest);
  assert.equal(result.branch, 'codex/change-issue-23/worker-layer');
  for (const path of [
    implementationWorktreeCreationIntentPath(context.cwd, 'issue-23', context.taskId),
    implementationWorktreeManifestPath(context.cwd, 'issue-23', context.taskId),
  ]) {
    assert.ok(existsSync(path)); assert.ok(existsSync(path.replace(/\.json$/u, '.sha256')));
  }
});

test('fabricated task, packet digest, base, and tampered packet receipt create no durable identity', async () => {
  for (const mutate of [
    (context) => ({ taskId: 'fabricated-task' }),
    () => ({ packetDigest: `sha256:${'f'.repeat(64)}` }),
    (context) => ({ base: context.priorBase }),
  ]) {
    const context = await boundRepository();
    assert.throws(() => createTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
      base: context.base, packetDigest: context.packetDigest, ...mutate(context) }),
    (error) => error instanceof StateError && ['WORKTREE_TASK_NOT_BOUND', 'WORKTREE_PACKET_MISMATCH'].includes(error.code));
    assert.equal(existsSync(implementationWorktreeCreationIntentPath(context.cwd, 'issue-23', context.taskId)), false);
  }
  const tampered = await boundRepository();
  const packetPath = implementationTaskPacketPath(tampered.cwd, 'issue-23', tampered.taskId, 1);
  const value = JSON.parse(readFileSync(packetPath, 'utf8')); value.objective = 'Tampered'; writeFileSync(packetPath, JSON.stringify(value));
  assert.throws(() => create(tampered), (error) => error instanceof StateError);
  assert.equal(existsSync(implementationWorktreeCreationIntentPath(tampered.cwd, 'issue-23', tampered.taskId)), false);
});

test('receipt-bound creation intent precedes Git mutation and exact retry recovers it', async () => {
  const context = await boundRepository();
  assert.throws(() => create(context, { crashStep: 'creation-after-intent' }),
    (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
  const creating = inspectTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
  assert.equal(creating.status, 'creating'); assert.equal(creating.exists, false); assert.equal(creating.registered, null);
  const recovered = create(context);
  assert.equal(recovered.status, 'active'); assert.equal(recovered.baseSha, context.base);
});

test('an incomplete creation cannot be scheduled and remains recoverable while bound', async () => {
  const context = await boundRepository();
  assert.throws(() => create(context, { crashStep: 'creation-after-intent' }),
    (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
  assert.throws(() => scheduleWave({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: context.bound.revision }),
    (error) => error instanceof StateError && ['RECEIPT_MISSING', 'WORKTREE_NOT_READY'].includes(error.code));
  assert.equal(recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }).status, 'active');
  const scheduled = scheduleWave({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: context.bound.revision });
  assert.equal(scheduled.execution.tasks.find(({ id }) => id === context.taskId).status, 'scheduled');
});

test('recover completes interruptions after Git add and after manifest JSON', async () => {
  for (const crashStep of ['creation-after-worktree-add', 'creation-after-manifest-json']) {
    const context = await boundRepository();
    assert.throws(() => create(context, { crashStep }),
      (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
    if (crashStep === 'creation-after-worktree-add') assert.equal(inspectTaskWorktree({ cwd: context.cwd,
      changeId: 'issue-23', taskId: context.taskId }).status, 'creating');
    const recovered = recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
    assert.equal(recovered.status, 'active'); assert.equal(recovered.registered.headSha, context.base);
  }
});

test('recover repairs exact partial creation evidence retained by a scheduled task', async () => {
  const context = await boundRepository(); create(context);
  const scheduled = scheduleWave({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: context.bound.revision });
  const manifestPath = implementationWorktreeManifestPath(context.cwd, 'issue-23', context.taskId);
  rmSync(manifestPath.replace(/\.json$/u, '.sha256'));
  assert.throws(() => inspectTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }),
    (error) => error instanceof StateError && error.code === 'INCOMPLETE_WORKTREE_EVIDENCE');
  const recovered = recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
  assert.equal(recovered.status, 'active');
  assert.equal(scheduled.execution.tasks.find(({ id }) => id === context.taskId).status, 'scheduled');
});

test('recover revalidates lifecycle state even when active manifest evidence is complete', async () => {
  const context = await boundRepository(); create(context);
  const scheduled = scheduleWave({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: context.bound.revision });
  startTask({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    workerId: 'implementation-worker', expectedRevision: scheduled.revision });
  assert.throws(() => recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_RECOVERY_NOT_APPLICABLE');
});

test('recover resumes an exact branch-only Git add interruption and rejects a mismatched partial registration', async () => {
  const branchOnly = await boundRepository();
  assert.throws(() => create(branchOnly, { crashStep: 'creation-after-intent' }), StateError);
  git(branchOnly.cwd, ['branch', `codex/change-issue-23/${branchOnly.taskId}`, branchOnly.base]);
  assert.equal(inspectTaskWorktree({ cwd: branchOnly.cwd, changeId: 'issue-23', taskId: branchOnly.taskId }).status, 'creating');
  assert.equal(recoverTaskWorktree({ cwd: branchOnly.cwd, changeId: 'issue-23', taskId: branchOnly.taskId }).status, 'active');

  const mismatched = await boundRepository();
  assert.throws(() => create(mismatched, { crashStep: 'creation-after-intent' }), StateError);
  const path = implementationWorktreePath(mismatched.cwd, 'issue-23', mismatched.taskId);
  mkdirSync(dirname(path), { recursive: true }); git(mismatched.cwd, ['worktree', 'add', '--detach', path, mismatched.base]);
  assert.throws(() => recoverTaskWorktree({ cwd: mismatched.cwd, changeId: 'issue-23', taskId: mismatched.taskId }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_REGISTRATION_MISMATCH');
});

test('unknown branch, path, and registration orphans are rejected before intent persistence', async () => {
  for (const orphan of ['branch', 'path', 'registration']) {
    const context = await boundRepository();
    const path = implementationWorktreePath(context.cwd, 'issue-23', context.taskId);
    const branch = `codex/change-issue-23/${context.taskId}`;
    if (orphan === 'branch') git(context.cwd, ['branch', branch, context.base]);
    else if (orphan === 'path') mkdirSync(path, { recursive: true });
    else { mkdirSync(dirname(path), { recursive: true }); git(context.cwd, ['worktree', 'add', '-b', branch, path, context.base]); }
    assert.throws(() => create(context),
      (error) => error instanceof StateError && error.code === 'WORKTREE_ORPHAN_COLLISION');
    assert.equal(existsSync(implementationWorktreeCreationIntentPath(context.cwd, 'issue-23', context.taskId)), false);
  }
});

test('linked-worktree inspection resolves the same shared evidence and exact registration', async () => {
  const context = await boundRepository(); const created = create(context);
  const inspected = inspectTaskWorktree({ cwd: created.path, changeId: 'issue-23', taskId: context.taskId });
  assert.equal(inspected.status, 'active'); assert.equal(inspected.path, created.path);
  assert.equal(inspected.registered.branchRef, `refs/heads/${created.branch}`);
});

test('removal rejects dirty and pre-terminal worktrees', async () => {
  const early = await boundRepository(); const earlyWorktree = create(early);
  assert.throws(() => removeTaskWorktree({ cwd: early.cwd, changeId: 'issue-23', taskId: early.taskId }),
    (error) => error instanceof StateError && error.code === 'WORKTREE_REMOVAL_NOT_AUTHORIZED');

  const dirty = await boundRepository(); const dirtyWorktree = create(dirty);
  authorizeNoChangeRemoval(dirty, dirtyWorktree); writeFileSync(join(dirtyWorktree.path, 'dirty.txt'), 'dirty\n');
  assert.throws(() => removeTaskWorktree({ cwd: dirty.cwd, changeId: 'issue-23', taskId: dirty.taskId }),
    (error) => error instanceof StateError && error.code === 'DIRTY_WORKTREE');
  assert.equal(inspectTaskWorktree({ cwd: dirty.cwd, changeId: 'issue-23', taskId: dirty.taskId }).status, 'active');
  assert.equal(earlyWorktree.status, 'active');
});

test('explicitly rejected bound task authorizes cleanup without a started worker', async () => {
  const context = await boundRepository(); const created = create(context);
  rejectTask({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    reason: 'Operator explicitly rejected this attempt.', expectedRevision: context.bound.revision });
  assert.equal(removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }).status, 'removed');
  assert.equal(git(context.cwd, ['show-ref', '--verify', `refs/heads/${created.branch}`]).split(' ')[0], context.base);
});

test('recovery completes an exact rejected-task creation before authorized removal', async () => {
  const context = await boundRepository();
  assert.throws(() => create(context, { crashStep: 'creation-after-worktree-add' }),
    (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
  const rejected = rejectTask({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    reason: 'Operator rejected the interrupted task.', expectedRevision: context.bound.revision });
  const replacementId = 'replacement-worker-layer';
  const resultingPlan = {
    ...context.plan,
    planRevision: 2,
    criteria: context.plan.criteria.map((criterion) => ({ ...criterion, ownerTaskId: replacementId })),
    tasks: context.plan.tasks.map((entry) => ({ ...entry, id: replacementId })),
  };
  const amendment = {
    id: 'replace-interrupted-worker', reason: 'Replace rejected interrupted work.', authorization: 'operator',
    trigger: 'task-rejected', delta: { replacementTaskId: replacementId }, invalidatedEvidence: [
      `implementation/tasks/${context.taskId}/0001.json`,
      `implementation/provenance/${context.taskId}/0001.json`,
      `implementation/planning-signals/${context.taskId}/0001.json`,
      `implementation/specialist-routes/${context.taskId}/0001.json`,
    ],
  };
  assert.throws(() => amendPlan({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: rejected.revision,
    resultingPlan, amendment }), (error) => error instanceof StateError && error.code === 'RECEIPT_MISSING');
  const recovered = recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
  assert.equal(recovered.status, 'active'); assert.equal(recovered.baseSha, context.base);
  const removed = removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
  assert.equal(removed.status, 'removed'); assert.equal(removed.exists, false);
  const amended = amendPlan({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: rejected.revision,
    resultingPlan, amendment });
  assert.deepEqual(amended.execution.tasks.map(({ id, status }) => ({ id, status })),
    [{ id: replacementId, status: 'unbound' }]);
});

test('removal intent recovers interruption after Git removal and preserves manifest and branch', async () => {
  const context = await boundRepository(); const created = create(context); authorizeNoChangeRemoval(context, created);
  const manifestPath = implementationWorktreeManifestPath(context.cwd, 'issue-23', context.taskId);
  const manifestBefore = readFileSync(manifestPath, 'utf8');
  assert.throws(() => removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId,
    crashStep: 'removal-after-worktree-remove' }),
  (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
  assert.equal(inspectTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }).status, 'removing');
  const cli = fileURLToPath(new URL('cli.mjs', import.meta.url));
  const recovery = spawnSync(process.execPath, [cli, 'recover', '--change', 'issue-23', '--task', context.taskId],
    { cwd: context.cwd, encoding: 'utf8' });
  assert.equal(recovery.status, 0, recovery.stderr);
  const removed = JSON.parse(recovery.stdout);
  assert.equal(removed.status, 'removed'); assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore);
  assert.ok(existsSync(implementationWorktreeRemovalIntentPath(context.cwd, 'issue-23', context.taskId)));
  assert.ok(existsSync(implementationWorktreeTombstonePath(context.cwd, 'issue-23', context.taskId)));
  assert.equal(git(context.cwd, ['show-ref', '--verify', `refs/heads/${created.branch}`]).split(' ')[0], context.base);
  assert.equal(removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }).status, 'removed');
});

test('archived state never authorizes worktree deletion', async () => {
  const context = await boundRepository(); const created = create(context);
  const terminal = authorizeNoChangeRemoval(context, created);
  assert.equal(removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }).status, 'removed');
  assert.equal(archiveState({ cwd: context.cwd, changeId: 'issue-23', expectedRevision: terminal.revision,
    abandonReason: 'Archive after active-state cleanup.' }).archived, true);
  assert.throws(() => removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }),
    (error) => error instanceof StateError && ['STATE_NOT_FOUND', 'ARCHIVE_NOT_ACTIVE'].includes(error.code));
});

test('removal repairs exact JSON-only intent and tombstone crash boundaries', async () => {
  for (const crashStep of ['removal-after-intent-json', 'removal-after-tombstone-json']) {
    const context = await boundRepository(); const created = create(context); authorizeNoChangeRemoval(context, created);
    assert.throws(() => removeTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId, crashStep }),
      (error) => error instanceof StateError && error.code === 'SIMULATED_WORKTREE_CRASH');
    assert.throws(() => inspectTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId }),
      (error) => error instanceof StateError && error.code === 'INCOMPLETE_WORKTREE_EVIDENCE');
    const recovered = recoverTaskWorktree({ cwd: context.cwd, changeId: 'issue-23', taskId: context.taskId });
    assert.equal(recovered.status, 'removed'); assert.equal(recovered.exists, false);
  }
});

test('CLI recover resumes the exact receipt-bound creating identity', async () => {
  const context = await boundRepository();
  assert.throws(() => create(context, { crashStep: 'creation-after-intent' }), StateError);
  const cli = fileURLToPath(new URL('cli.mjs', import.meta.url));
  const recovered = spawnSync(process.execPath, [cli, 'recover', '--change', 'issue-23', '--task', context.taskId],
    { cwd: context.cwd, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).status, 'active');
});
