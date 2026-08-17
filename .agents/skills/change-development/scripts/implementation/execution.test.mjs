import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { commit, createRepository, git, writeFiles } from '../../../../../tests/support/git-fixtures.mjs';
import { changeDirectory } from '../paths.mjs';
import {
  acceptPlan,
  acceptResult,
  bindTask,
  initializeState,
  integrateTask,
  loadState,
  reconcileIntegration,
  rejectTask,
  scheduleWave,
  startTask,
  StateError,
  validateState,
} from '../state/state.mjs';
import { createTaskWorktree } from '../worktree/worktree.mjs';
import { implementationTaskDigest } from './contracts.mjs';

const repositories = [];
const registry = loadRegistry();

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

function profile() {
  const value = {
    specialization: 'ops-workflow',
    affectedAreas: ['workflow'],
    riskTags: ['workflow'],
    browserVisible: false,
    relatedTestSelectionUncertain: false,
  };
  return {
    ...value,
    route: routeSpecialists({
      specialization: value.specialization,
      riskTags: value.riskTags,
      browserVisible: value.browserVisible,
      testSelectionUncertain: value.relatedTestSelectionUncertain,
    }, registry),
  };
}

function task(id, anticipatedPaths, dependsOn = []) {
  return {
    id,
    title: `Implement ${id}`,
    objective: `Produce the exact ${id} repository change.`,
    rationale: 'The implementation lifecycle needs deterministic execution evidence.',
    specialization: profile(),
    criterionIds: [`criterion-${id}`],
    decisionIds: [],
    scenarioIds: [],
    checklistItemIds: [],
    dependsOn,
    anticipatedPaths,
    produces: [],
    consumes: [],
    validationIntent: [`Exercise ${id} through the public lifecycle API.`],
    unsplittable: null,
  };
}

async function fixture(tasks, initialFiles = {}) {
  const cwd = createRepository();
  repositories.push(cwd);
  const base = commit(cwd, {
    'request.md': '# Execution request\n',
    ...initialFiles,
  }, 'test: seed execution fixture');
  const planning = await initializeState({
    cwd,
    changeId: `execution-${repositories.length}`,
    mode: 'implement',
    baseBranch: 'main',
    planningRef: base,
    source: { type: 'direct-request', path: 'request.md', relationshipIntent: 'resolves' },
  });
  const specialization = profile();
  const plan = {
    schemaVersion: 1,
    planRevision: 1,
    changeId: planning.changeId,
    source: {
      kind: planning.source.kind,
      reference: planning.source.reference,
      relationship: planning.source.relationship,
      captureDigest: planning.source.latestDigest,
    },
    title: 'Execution lifecycle fixture',
    objective: 'Exercise bounded worker execution and central integration.',
    scope: ['Repository workflow'],
    nonGoals: ['Product behavior'],
    planning: { planningSha: base, baseBranch: 'main', comparisonBaseSha: null },
    expectedPrBaseBranch: 'main',
    criteria: tasks.map(({ id }) => ({
      id: `criterion-${id}`,
      description: `The ${id} task is executed with exact durable evidence.`,
      disposition: 'owned',
      ownerTaskId: id,
      deferredReason: null,
    })),
    decisions: [],
    scenarios: [],
    productScenarioDisposition: {
      disposition: 'not-applicable',
      scenarioIds: [],
      rationale: 'This fixture exercises repository workflow only.',
    },
    specialization,
    checklistMappings: [],
    tasks,
  };
  const accepted = acceptPlan({ cwd, expectedRevision: planning.revision, plan, planningEvidence: [] });
  return { cwd, base, plan, state: accepted, changeId: planning.changeId };
}

function packetFor(context, taskId, overrides = {}) {
  const planned = context.plan.tasks.find(({ id }) => id === taskId);
  return {
    schemaVersion: 1,
    changeId: context.changeId,
    taskId,
    planRevision: context.plan.planRevision,
    planDigest: context.state.plan.effectiveDigest,
    planningSha: context.base,
    taskBaseSha: context.state.git.headSha,
    specialization: planned.specialization.specialization,
    riskTags: planned.specialization.riskTags,
    affectedAreas: planned.specialization.affectedAreas,
    planningSignals: {
      browserVisible: planned.specialization.browserVisible,
      relatedTestSelectionUncertain: planned.specialization.relatedTestSelectionUncertain,
    },
    specialistRoute: planned.specialization.route,
    behaviorMapperEvidence: null,
    objective: planned.objective,
    evidence: 'The accepted plan binds this exact public-API execution test task.',
    decisionIds: [],
    decisionContext: [],
    acceptanceCriteriaIds: planned.criterionIds,
    acceptanceCriteria: planned.criterionIds.map((id) => ({
      id,
      description: context.plan.criteria.find((criterion) => criterion.id === id).description,
    })),
    allowedPaths: planned.anticipatedPaths.map((path) => path.includes('.') ? path : `${path}/**`),
    forbiddenPaths: [],
    dependencies: planned.dependsOn,
    requiredValidation: {
      unit: [{ command: 'node --test tests/execution.test.mjs', reason: 'Exercise the exact worker result.' }],
      system: [],
    },
    ...overrides,
  };
}

function bind(context, taskId) {
  const packet = packetFor(context, taskId);
  context.state = bindTask({
    cwd: context.cwd,
    changeId: context.changeId,
    packet,
    expectedRevision: context.state.revision,
  });
  return packet;
}

function createWorker(context, packet) {
  return createTaskWorktree({
    cwd: context.cwd,
    changeId: context.changeId,
    taskId: packet.taskId,
    base: packet.taskBaseSha,
    packetDigest: implementationTaskDigest(packet),
  });
}

function startWave(context, packets) {
  context.state = scheduleWave({
    cwd: context.cwd,
    changeId: context.changeId,
    expectedRevision: context.state.revision,
  });
  const scheduled = new Set(context.state.execution.activeWave);
  for (const packet of packets.filter(({ taskId }) => scheduled.has(taskId))) {
    context.state = startTask({
      cwd: context.cwd,
      changeId: context.changeId,
      taskId: packet.taskId,
      workerId: `worker-${packet.taskId}`,
      expectedRevision: context.state.revision,
    });
  }
}

function resultFor(packet, workerCommit, changedPaths) {
  return {
    schemaVersion: 1,
    changeId: packet.changeId,
    taskId: packet.taskId,
    planDigest: packet.planDigest,
    packetDigest: implementationTaskDigest(packet),
    specialization: packet.specialization,
    taskBaseSha: packet.taskBaseSha,
    status: 'implemented',
    workerCommit,
    changedPaths,
    validation: packet.requiredValidation.unit.map(({ command }) => ({
      command,
      result: 'passed',
      summary: 'Focused validation passed.',
    })),
    unexpectedDependencies: [],
    summary: 'Implemented the exact immutable task packet.',
  };
}

function accept(context, packet, worker, workerCommit, changedPaths) {
  context.state = acceptResult({
    cwd: context.cwd,
    changeId: context.changeId,
    result: resultFor(packet, workerCommit, changedPaths),
    workerCwd: worker.path,
    expectedRevision: context.state.revision,
  });
}

test('binding rejects unready dependencies and any taskBaseSha other than the exact durable central HEAD', async () => {
  const prerequisite = task('prerequisite', ['output/prerequisite.txt']);
  const dependent = task('dependent', ['output/dependent.txt'], ['prerequisite']);
  const context = await fixture([prerequisite, dependent]);
  const wrongBase = git(context.cwd, ['rev-parse', `${context.base}^`]);

  assert.throws(() => bindTask({
    cwd: context.cwd,
    changeId: context.changeId,
    packet: packetFor(context, 'prerequisite', { taskBaseSha: wrongBase }),
    expectedRevision: context.state.revision,
  }), (error) => error instanceof StateError && error.code === 'PACKET_PLAN_MISMATCH');
  assert.throws(() => bindTask({
    cwd: context.cwd,
    changeId: context.changeId,
    packet: packetFor(context, 'dependent'),
    expectedRevision: context.state.revision,
  }), (error) => error instanceof StateError && error.code === 'DEPENDENCY_NOT_INTEGRATED');

  assert.equal(loadState(context.cwd).revision, context.state.revision);
  assert.equal(validateState({ cwd: context.cwd }).valid, true);
});

test('wave scheduling deterministically admits at most the first three non-conflicting writers', async () => {
  const tasks = ['alpha', 'bravo', 'charlie', 'delta'].map((id) => task(id, [`output/${id}.txt`]));
  const context = await fixture(tasks);
  const packets = tasks.map(({ id }) => bind(context, id));
  packets.forEach((packet) => createWorker(context, packet));

  context.state = scheduleWave({ cwd: context.cwd, changeId: context.changeId, expectedRevision: context.state.revision });
  assert.deepEqual(context.state.execution.activeWave, ['alpha', 'bravo', 'charlie']);
  assert.equal(context.state.execution.tasks.find(({ id }) => id === 'delta').status, 'bound');
  assert.equal(validateState({ cwd: context.cwd }).valid, true);
});

test('implemented results reject missing, non-descendant, and empty worker commits without advancing durable state', async () => {
  for (const variant of ['missing', 'non-descendant', 'empty']) {
    const context = await fixture([task('worker-result', ['output/result.txt'])]);
    const packet = bind(context, 'worker-result');
    const worker = createWorker(context, packet);
    startWave(context, [packet]);
    let workerCommit = null;
    const changedPaths = ['output/result.txt'];

    if (variant === 'non-descendant') {
      workerCommit = git(worker.path, ['commit-tree', `${packet.taskBaseSha}^{tree}`, '-m', 'test: unrelated root']);
      git(worker.path, ['reset', '--hard', workerCommit]);
    } else if (variant === 'empty') {
      git(worker.path, ['commit', '--allow-empty', '-m', 'test: empty worker result']);
      workerCommit = git(worker.path, ['rev-parse', 'HEAD']);
    }

    const revision = context.state.revision;
    assert.throws(() => acceptResult({
      cwd: context.cwd,
      changeId: context.changeId,
      result: resultFor(packet, workerCommit, changedPaths),
      workerCwd: worker.path,
      expectedRevision: revision,
    }), variant === 'non-descendant'
      ? (error) => error instanceof StateError && error.code === 'WORKER_COMMIT_INVALID'
      : (error) => error instanceof StateError && error.code === 'INVALID_IMPLEMENTATION_RESULT');
    assert.equal(loadState(context.cwd).revision, revision, variant);
    assert.equal(validateState({ cwd: context.cwd }).valid, true, variant);
  }
});

test('a bound packet becomes durably stale after a conflicting earlier writer advances central HEAD', async () => {
  const first = task('first-writer', ['.agents/first.txt']);
  const stale = task('stale-writer', ['.agents/stale.txt']);
  const context = await fixture([first, stale]);
  const firstPacket = bind(context, 'first-writer');
  const stalePacket = bind(context, 'stale-writer');
  const firstWorker = createWorker(context, firstPacket);
  createWorker(context, stalePacket);
  startWave(context, [firstPacket, stalePacket]);
  assert.deepEqual(context.state.execution.activeWave, ['first-writer']);

  const firstCommit = commit(firstWorker.path, { '.agents/first.txt': 'first\n' }, 'test: first writer');
  accept(context, firstPacket, firstWorker, firstCommit, ['.agents/first.txt']);
  context.state = integrateTask({
    cwd: context.cwd,
    changeId: context.changeId,
    taskId: firstPacket.taskId,
    expectedRevision: context.state.revision,
  });
  const revision = context.state.revision;
  assert.throws(() => scheduleWave({
    cwd: context.cwd,
    changeId: context.changeId,
    expectedRevision: revision,
  }), (error) => error instanceof StateError && error.code === 'TASK_BASE_STALE');
  assert.equal(loadState(context.cwd).revision, revision);
  assert.equal(validateState({ cwd: context.cwd }).valid, true);
});

test('a real central cherry-pick conflict preserves its intent and requires abort plus receipt-backed rejection/replan', async () => {
  const rename = task('rename-directory', ['old/a.txt', 'new/a.txt']);
  const add = task('add-to-renamed-directory', ['old/b.txt']);
  const context = await fixture([rename, add], { 'old/a.txt': 'base\n' });
  const renamePacket = bind(context, rename.id);
  const addPacket = bind(context, add.id);
  const renameWorker = createWorker(context, renamePacket);
  const addWorker = createWorker(context, addPacket);
  startWave(context, [renamePacket, addPacket]);

  mkdirSync(join(renameWorker.path, 'new'), { recursive: true });
  git(renameWorker.path, ['mv', 'old/a.txt', 'new/a.txt']);
  git(renameWorker.path, ['commit', '-m', 'test: rename directory']);
  const renameCommit = git(renameWorker.path, ['rev-parse', 'HEAD']);
  writeFiles(addWorker.path, { 'old/b.txt': 'added on original directory\n' });
  git(addWorker.path, ['add', 'old/b.txt']);
  git(addWorker.path, ['commit', '-m', 'test: add to original directory']);
  const addCommit = git(addWorker.path, ['rev-parse', 'HEAD']);

  accept(context, renamePacket, renameWorker, renameCommit, ['new/a.txt', 'old/a.txt']);
  accept(context, addPacket, addWorker, addCommit, ['old/b.txt']);
  context.state = integrateTask({
    cwd: context.cwd,
    changeId: context.changeId,
    taskId: rename.id,
    expectedRevision: context.state.revision,
  });
  const centralBase = context.state.git.headSha;
  assert.throws(() => integrateTask({
    cwd: context.cwd,
    changeId: context.changeId,
    taskId: add.id,
    expectedRevision: context.state.revision,
  }), (error) => error instanceof StateError && error.code === 'INTEGRATION_CHERRY_PICK_FAILED');

  const integrating = loadState(context.cwd);
  assert.equal(integrating.phase, 'integrating');
  assert.deepEqual(integrating.execution.integrationIntent, {
    taskId: add.id,
    workerCommit: addCommit,
    centralBaseSha: centralBase,
  });
  assert.equal(existsSync(join(context.cwd, '.git', 'CHERRY_PICK_HEAD')), true);
  assert.throws(() => reconcileIntegration({
    cwd: context.cwd,
    changeId: context.changeId,
    expectedRevision: integrating.revision,
  }), (error) => error instanceof StateError && error.code === 'INTEGRATION_DIRTY');
  assert.equal(loadState(context.cwd).revision, integrating.revision);

  git(context.cwd, ['cherry-pick', '--abort']);
  assert.equal(git(context.cwd, ['rev-parse', 'HEAD']), centralBase);
  const rejected = rejectTask({
    cwd: context.cwd,
    changeId: context.changeId,
    taskId: add.id,
    reason: 'Directory rename exposed an unplanned dependency.',
    expectedRevision: integrating.revision,
  });
  assert.equal(rejected.phase, 'blocked');
  assert.equal(rejected.execution.tasks.find(({ id }) => id === add.id).status, 'rejected');
  assert.match(rejected.nextAction, /rejecting\/replanning/u);
  const rejectionPath = join(changeDirectory(context.cwd, context.changeId), 'implementation', 'rejections', add.id,
    `${String(rejected.revision).padStart(8, '0')}.json`);
  assert.equal(JSON.parse(readFileSync(rejectionPath, 'utf8')).reason, 'Directory rename exposed an unplanned dependency.');
  assert.equal(existsSync(rejectionPath.replace(/\.json$/u, '.sha256')), true);
  assert.equal(validateState({ cwd: context.cwd }).valid, true);
});
