import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptPlan,
  acceptResult,
  activePointerPath,
  amendPlan,
  archiveState,
  boundedStatus,
  bindTask,
  changeDirectory,
  checkpointGitMetadata,
  finalizeIntegration,
  initializeState,
  integrateTask,
  loadLatestSourceObservation,
  loadState,
  locateState,
  nextActionFor,
  recoverState,
  recordDecision,
  refreshSource,
  renderStatus,
  reconcileIntegration,
  rejectTask,
  scheduleWave,
  startTask,
  StateError,
  tasksConflict,
  upgradeState,
  validateState,
  withChangeLock,
  withIntegrationOperationLock,
  changeRoot,
} from './state.mjs';

test('wave conflicts serialize shared and producer surfaces while permitting disjoint work', () => {
  const task = (anticipatedPaths, produces = [], consumes = []) => ({ anticipatedPaths, produces, consumes });
  assert.equal(tasksConflict(task(['apps/web/src/a.ts']), task(['apps/api/src/b.ts'])), false);
  assert.equal(tasksConflict(task(['.agents/skills/a/file.mjs']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['package-lock.json']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['apps/web/package.json']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['packages/shared/package-lock.json']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['tests/e2e/venue.steps.ts']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['tests/e2e/steps/catalog/venue.steps.ts']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['apps/web/src/a.ts'], ['catalog']), task(['apps/api/src/b.ts'], ['catalog'])), true);
  assert.equal(tasksConflict(task(['apps/web/src'], ['catalog']), task(['apps/web/src/file.ts'], [], ['catalog'])), true);
});

test('oversized plan acceptance fails before durable transition or evidence writes', async () => {
  const { cwd, sha } = repository('oversized plan acceptance');
  const planning = await initializeState({ cwd, changeId: 'oversized-plan', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  const template = plan.tasks[0];
  for (let index = 1; index < 180; index += 1) {
    const taskId = `oversized-task-${index}`;
    const criterionId = `oversized-criterion-${index}`;
    plan.criteria.push({ id: criterionId, description: `Task ${index} remains durable.`, disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    plan.tasks.push({ ...template, id: taskId, title: `Implement oversized task ${index}`,
      objective: `Persist oversized task ${index}.`, criterionIds: [criterionId], checklistItemIds: [],
      anticipatedPaths: [`generated/${String(index).padStart(3, '0')}-${'x'.repeat(430)}.txt`] });
  }
  const directory = changeDirectory(cwd, planning.changeId);
  const statePath = join(directory, 'state.json');
  const eventsPath = join(directory, 'events.jsonl');
  const durableBefore = {
    state: readFileSync(statePath, 'utf8'),
    events: readFileSync(eventsPath, 'utf8'),
    transitions: readdirSync(join(directory, 'transitions')),
  };

  assert.throws(() => acceptPlan({ cwd, plan, expectedRevision: planning.revision }),
    (error) => error instanceof StateError && error.code === 'STATE_TOO_LARGE');
  assert.equal(readFileSync(statePath, 'utf8'), durableBefore.state);
  assert.equal(readFileSync(eventsPath, 'utf8'), durableBefore.events);
  assert.deepEqual(readdirSync(join(directory, 'transitions')), durableBefore.transitions);
  assert.equal(existsSync(join(directory, 'plan')), false);
});

test('two same-base workers integrate by delta, resume intent-only integration, clean up, and finalize', async () => {
  const { cwd, sha } = repository('execution integration');
  const planning = await initializeState({ cwd, changeId: 'execution-change', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const firstPacket = packetFor(state, plan, 'state-task');
  state = bindTask({ cwd, packet: firstPacket, expectedRevision: 1 });
  const firstWorktree = createWorkerFixture(cwd, state, firstPacket);
  const secondPacket = packetFor(state, plan, 'second-task');
  state = bindTask({ cwd, packet: secondPacket, expectedRevision: 2 });
  const secondWorktree = createWorkerFixture(cwd, state, secondPacket);
  state = scheduleWave({ cwd, expectedRevision: 3 });
  assert.deepEqual(state.execution.activeWave, ['state-task', 'second-task']);
  state = startTask({ cwd, taskId: 'state-task', workerId: 'worker-one', expectedRevision: 4 });
  state = startTask({ cwd, taskId: 'second-task', workerId: 'worker-two', expectedRevision: 5 });
  writeFileSync(join(firstWorktree.path, 'first.txt'), 'first\n'); git(firstWorktree.path, 'add', 'first.txt'); git(firstWorktree.path, 'commit', '-m', 'test: first worker');
  writeFileSync(join(secondWorktree.path, 'second.txt'), 'second\n'); git(secondWorktree.path, 'add', 'second.txt'); git(secondWorktree.path, 'commit', '-m', 'test: second worker');
  const firstCommit = git(firstWorktree.path, 'rev-parse', 'HEAD'); const secondCommit = git(secondWorktree.path, 'rev-parse', 'HEAD');
  state = acceptResult({ cwd, result: resultFor(firstPacket, 'implemented', firstCommit, ['first.txt']), workerCwd: firstWorktree.path, expectedRevision: 6 });
  state = acceptResult({ cwd, result: resultFor(secondPacket, 'implemented', secondCommit, ['second.txt']), workerCwd: secondWorktree.path, expectedRevision: 7 });
  git(cwd, 'switch', '-c', 'alternate-central');
  assert.throws(() => integrateTask({ cwd, taskId: 'state-task', expectedRevision: 8 }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = integrateTask({ cwd, taskId: 'state-task', expectedRevision: 8 });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
  assert.throws(() => integrateTask({ cwd, taskId: 'second-task', expectedRevision: 10,
    crashStep(step) { if (step === 'after-complete') throw new Error('intent-only stop'); } }), /intent-only stop/u);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), state.git.headSha);
  git(cwd, 'branch', '-f', 'alternate-central', 'HEAD');
  git(cwd, 'switch', 'alternate-central');
  assert.throws(() => reconcileIntegration({ cwd, expectedRevision: 11 }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = reconcileIntegration({ cwd, expectedRevision: 11 });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'second-task').status, 'integrated');
  assert.equal(readFileSync(join(cwd, 'first.txt'), 'utf8'), 'first\n');
  assert.equal(readFileSync(join(cwd, 'second.txt'), 'utf8'), 'second\n');
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'state-task' });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'second-task' });
  git(cwd, 'branch', '-f', 'alternate-central', 'HEAD');
  git(cwd, 'switch', 'alternate-central');
  assert.throws(() => finalizeIntegration({ cwd, expectedRevision: 12 }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = finalizeIntegration({ cwd, expectedRevision: 12 });
  assert.equal(state.phase, 'integrated');
  assert.equal(validateState({ cwd }).valid, true);
  git(cwd, 'switch', 'alternate-central');
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'blocked');
  git(cwd, 'switch', 'main');
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'integrated', 'restoring finalized identity must preserve explicit finalization');
});

test('execution Git checkpoints preserve durable identity and restore lifecycle phase exactly', async () => {
  const { cwd, sha } = repository('execution checkpoint identity');
  const planning = await initializeState({ cwd, changeId: 'execution-checkpoint', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  let state = acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0 });
  const durableGit = structuredClone(state.git);
  git(cwd, 'switch', '-c', 'same-sha-drift');
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'blocked');
  assert.deepEqual(state.git, durableGit, 'invalid execution observations must not replace durable identity');
  git(cwd, 'switch', 'main');
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'ready-to-implement');
  const packet = packetFor(state, planFor(planning), 'state-task');
  state = bindTask({ cwd, packet, expectedRevision: state.revision });
  writeFileSync(join(cwd, 'checkpoint-dirty.txt'), 'dirty');
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'blocked');
  unlinkSync(join(cwd, 'checkpoint-dirty.txt'));
  state = checkpointGitMetadata({ cwd }).state;
  assert.equal(state.phase, 'implementing');
});

test('interrupted execution checkpoint recovers against evidence without replacing expected Git identity', async () => {
  const { cwd, sha } = repository('execution checkpoint recovery');
  const planning = await initializeState({ cwd, changeId: 'execution-checkpoint-recovery', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const accepted = acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0 });
  git(cwd, 'switch', '-c', 'checkpoint-drift');
  assert.throws(() => checkpointGitMetadata({ cwd,
    crashStep(step) { if (step === 'after-state') throw new Error('execution checkpoint crash'); } }), /checkpoint crash/u);
  const interruptedState = readFileSync(join(changeDirectory(cwd, 'execution-checkpoint-recovery'), 'state.json'), 'utf8');
  git(cwd, 'switch', 'main');
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
  assert.equal(readFileSync(join(changeDirectory(cwd, 'execution-checkpoint-recovery'), 'state.json'), 'utf8'), interruptedState);
  git(cwd, 'switch', 'checkpoint-drift');
  const recovered = recoverState({ cwd });
  assert.equal(recovered.state.phase, 'blocked');
  assert.deepEqual(recovered.state.git, accepted.git);
});

test('accepted sibling integrates after a failed wave and preserves failure evidence', async () => {
  const { cwd, sha } = repository('failed wave sibling integration');
  const planning = await initializeState({ cwd, changeId: 'failed-wave-sibling', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning);
  plan.criteria.push({ id: 'third-change', description: 'Third task remains independent.', disposition: 'owned', ownerTaskId: 'third-task', deferredReason: null });
  plan.tasks.push({ ...plan.tasks[0], id: 'third-task', title: 'Implement third', objective: 'Persist third file.',
    criterionIds: ['third-change'], checklistItemIds: [], anticipatedPaths: ['third.txt'] });
  let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const first = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet: first, expectedRevision: state.revision });
  const firstWorker = createWorkerFixture(cwd, state, first);
  const second = packetFor(state, plan, 'second-task'); state = bindTask({ cwd, packet: second, expectedRevision: state.revision });
  const secondWorker = createWorkerFixture(cwd, state, second);
  const third = packetFor(state, plan, 'third-task'); state = bindTask({ cwd, packet: third, expectedRevision: state.revision });
  const thirdWorker = createWorkerFixture(cwd, state, third);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: first.taskId, workerId: 'successful-worker', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: second.taskId, workerId: 'failed-worker', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: third.taskId, workerId: 'third-failed-worker', expectedRevision: state.revision });
  writeFileSync(join(firstWorker.path, 'first.txt'), 'accepted sibling\n'); git(firstWorker.path, 'add', 'first.txt'); git(firstWorker.path, 'commit', '-m', 'test: accepted sibling');
  const firstCommit = git(firstWorker.path, 'rev-parse', 'HEAD');
  state = acceptResult({ cwd, workerCwd: firstWorker.path, expectedRevision: state.revision,
    result: resultFor(first, 'implemented', firstCommit, ['first.txt']) });
  state = acceptResult({ cwd, workerCwd: thirdWorker.path, expectedRevision: state.revision,
    result: { ...resultFor(third, 'failed'), validation: third.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'Third validation failed.',
    })), unexpectedDependencies: ['Third worker validation failed.'], summary: 'Third worker validation failed.' } });
  state = acceptResult({ cwd, workerCwd: secondWorker.path, expectedRevision: state.revision,
    result: { ...resultFor(second, 'failed'), validation: second.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'Worker validation failed.',
    })), unexpectedDependencies: ['Worker validation failed.'], summary: 'Worker validation failed.' } });
  const failureReasons = [...state.blockedReasons];
  assert.deepEqual(failureReasons, [
    'Task second-task reported failed: Worker validation failed.',
    'Task third-task reported failed: Third worker validation failed.',
  ], 'failure reasons follow accepted plan task order, not arrival order');
  state = integrateTask({ cwd, taskId: first.taskId, expectedRevision: state.revision });
  assert.equal(state.phase, 'blocked');
  assert.deepEqual(state.blockedReasons, failureReasons);
  assert.equal(state.execution.tasks.find(({ id }) => id === first.taskId).status, 'integrated');
  assert.equal(state.execution.tasks.find(({ id }) => id === second.taskId).status, 'failed');
  assert.equal(state.execution.tasks.find(({ id }) => id === third.taskId).status, 'failed');
});

test('reverse-order sibling results preserve Git drift until exact restoration and failed-wave integration', async () => {
  const { cwd, sha } = repository('git blocked sibling acceptance');
  const planning = await initializeState({ cwd, changeId: 'git-blocked-siblings', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const first = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet: first, expectedRevision: state.revision });
  const firstWorker = createWorkerFixture(cwd, state, first);
  const second = packetFor(state, plan, 'second-task'); state = bindTask({ cwd, packet: second, expectedRevision: state.revision });
  const secondWorker = createWorkerFixture(cwd, state, second);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: first.taskId, workerId: 'git-blocked-first', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: second.taskId, workerId: 'git-blocked-second', expectedRevision: state.revision });
  writeFileSync(join(firstWorker.path, 'first.txt'), 'accepted after Git restoration\n');
  git(firstWorker.path, 'add', 'first.txt'); git(firstWorker.path, 'commit', '-m', 'test: Git-blocked sibling');
  const firstCommit = git(firstWorker.path, 'rev-parse', 'HEAD');

  git(cwd, 'switch', '-c', 'same-sha-result-drift');
  state = checkpointGitMetadata({ cwd }).state;
  const gitReason = state.blockedReasons[0];
  assert.match(gitReason, /^Central Git observation does not match exact clean durable identity/u);
  state = acceptResult({ cwd, workerCwd: secondWorker.path, expectedRevision: state.revision,
    result: { ...resultFor(second, 'failed'), validation: second.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'Second validation failed.',
    })), unexpectedDependencies: ['Second worker validation failed.'], summary: 'Second worker validation failed.' } });
  assert.deepEqual(state.blockedReasons, [gitReason, 'Task second-task reported failed: Second worker validation failed.']);
  state = acceptResult({ cwd, workerCwd: firstWorker.path, expectedRevision: state.revision,
    result: resultFor(first, 'implemented', firstCommit, ['first.txt']) });
  assert.deepEqual(state.blockedReasons, [gitReason, 'Task second-task reported failed: Second worker validation failed.']);
  assert.throws(() => integrateTask({ cwd, taskId: first.taskId, expectedRevision: state.revision }),
    (error) => error.code === 'INVALID_PHASE');

  git(cwd, 'switch', 'main');
  state = checkpointGitMetadata({ cwd }).state;
  assert.deepEqual(state.blockedReasons, ['Task second-task reported failed: Second worker validation failed.']);
  state = integrateTask({ cwd, taskId: first.taskId, expectedRevision: state.revision });
  assert.equal(state.execution.tasks.find(({ id }) => id === first.taskId).status, 'integrated');
  assert.deepEqual(state.blockedReasons, ['Task second-task reported failed: Second worker validation failed.']);
});

test('explicit rejection survives a successful active-wave sibling result', async () => {
  const { cwd, sha } = repository('rejected sibling acceptance');
  const planning = await initializeState({ cwd, changeId: 'rejected-siblings', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const first = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet: first, expectedRevision: state.revision });
  createWorkerFixture(cwd, state, first);
  const second = packetFor(state, plan, 'second-task'); state = bindTask({ cwd, packet: second, expectedRevision: state.revision });
  const secondWorker = createWorkerFixture(cwd, state, second);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: first.taskId, workerId: 'rejected-first', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: second.taskId, workerId: 'successful-second', expectedRevision: state.revision });
  state = rejectTask({ cwd, taskId: first.taskId, reason: 'Operator rejected the first result.', expectedRevision: state.revision });
  const rejectionReason = 'Task state-task was explicitly rejected: Operator rejected the first result.';
  assert.deepEqual(state.blockedReasons, [rejectionReason]);
  writeFileSync(join(secondWorker.path, 'second.txt'), 'accepted sibling\n');
  git(secondWorker.path, 'add', 'second.txt'); git(secondWorker.path, 'commit', '-m', 'test: accepted rejection sibling');
  const secondCommit = git(secondWorker.path, 'rev-parse', 'HEAD');
  state = acceptResult({ cwd, result: resultFor(second, 'implemented', secondCommit, ['second.txt']),
    workerCwd: secondWorker.path, expectedRevision: state.revision });
  assert.equal(state.phase, 'blocked');
  assert.deepEqual(state.blockedReasons, [rejectionReason]);
  state = integrateTask({ cwd, taskId: second.taskId, expectedRevision: state.revision });
  assert.equal(state.execution.tasks.find(({ id }) => id === second.taskId).status, 'integrated');
  assert.deepEqual(state.blockedReasons, [rejectionReason]);
});

test('failure and rejection blockers replay in plan order and tampering fails closed', async () => {
  const { cwd, sha } = repository('missing prior task failure blocker');
  const planning = await initializeState({ cwd, changeId: 'missing-task-failure', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning);
  plan.criteria.push({ id: 'third-change', description: 'Third task remains independent.', disposition: 'owned', ownerTaskId: 'third-task', deferredReason: null });
  plan.tasks.push({ ...plan.tasks[0], id: 'third-task', title: 'Implement third', objective: 'Persist third file.',
    criterionIds: ['third-change'], checklistItemIds: [], anticipatedPaths: ['third.txt'] });
  let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const packets = [];
  const workers = new Map();
  for (const taskId of ['state-task', 'second-task', 'third-task']) {
    const packet = packetFor(state, plan, taskId); packets.push(packet);
    state = bindTask({ cwd, packet, expectedRevision: state.revision });
    workers.set(taskId, createWorkerFixture(cwd, state, packet));
  }
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  for (const taskId of ['state-task', 'second-task', 'third-task']) {
    state = startTask({ cwd, taskId, workerId: `worker-${taskId}`, expectedRevision: state.revision });
  }
  const [first, second, third] = packets;
  state = acceptResult({ cwd, workerCwd: workers.get(first.taskId).path, expectedRevision: state.revision,
    result: { ...resultFor(first, 'failed'), validation: first.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'First validation failed.',
    })), unexpectedDependencies: ['First worker validation failed.'], summary: 'First worker validation failed.' } });
  state = rejectTask({ cwd, taskId: second.taskId, reason: 'Replace the second task.', expectedRevision: state.revision });
  assert.deepEqual(state.blockedReasons, [
    'Task state-task reported failed: First worker validation failed.',
    'Task second-task was explicitly rejected: Replace the second task.',
  ]);
  assert.equal(validateState({ cwd }).valid, true);
  const rejectionDirectory = join(changeDirectory(cwd, state.changeId), 'implementation', 'rejections', second.taskId);
  const rejectionName = readdirSync(rejectionDirectory).find((name) => name.endsWith('.json'));
  const rejectionPath = join(rejectionDirectory, rejectionName);
  const rejection = JSON.parse(readFileSync(rejectionPath, 'utf8'));
  writeReceiptJson(rejectionPath, { ...rejection, taskId: 'wrong-task' });
  const statePath = join(changeDirectory(cwd, state.changeId), 'state.json');
  const before = readFileSync(statePath, 'utf8');
  assert.throws(() => acceptResult({ cwd, result: resultFor(third, 'no-change'), workerCwd: workers.get(third.taskId).path,
    expectedRevision: state.revision }), (error) => error instanceof StateError);
  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(existsSync(join(changeDirectory(cwd, state.changeId), 'implementation', 'results', third.taskId, '0001.json')), false);
  writeReceiptJson(rejectionPath, rejection);
  const duplicatePath = join(rejectionDirectory, '99999999.json');
  writeReceiptJson(duplicatePath, rejection);
  assert.throws(() => validateState({ cwd }), (error) => error instanceof StateError);
  unlinkSync(duplicatePath); unlinkSync(duplicatePath.replace(/\.json$/u, '.sha256'));
  unlinkSync(rejectionPath); unlinkSync(rejectionPath.replace(/\.json$/u, '.sha256'));
  assert.throws(() => validateState({ cwd }), (error) => error instanceof StateError);
});

test('v1 accepts a plan without execution and upgrades explicitly with unchanged identities', async () => {
  const { cwd, sha } = repository('historical v1 acceptance');
  const planningV2 = await initializeState({ cwd, changeId: 'historical-v1', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const planning = downgradeInitialStateToV1(cwd);
  let state = acceptPlan({ cwd, plan: planFor(planningV2), expectedRevision: planning.revision });
  assert.equal(state.schemaVersion, 1);
  assert.equal(Object.hasOwn(state, 'execution'), false);
  const planIdentity = structuredClone(state.plan); const gitIdentity = structuredClone(state.git);
  state = upgradeState({ cwd, expectedRevision: state.revision });
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.plan, planIdentity);
  assert.deepEqual({ ...state.git, observedAt: gitIdentity.observedAt }, gitIdentity);
  assert.equal(state.execution.tasks[0].status, 'unbound');
});

test('implementation authority rejects plan-only bind and upgrade without durable mutation', async () => {
  const modern = repository('plan-only v2 implementation authority');
  const modernPlanning = await initializeState({ cwd: modern.cwd, changeId: 'plan-only-v2', mode: 'plan-only',
    baseBranch: 'main', planningRef: modern.sha, source: descriptor });
  const modernPlan = planFor(modernPlanning);
  const modernState = acceptPlan({ cwd: modern.cwd, plan: modernPlan, expectedRevision: modernPlanning.revision });
  const modernRoot = changeDirectory(modern.cwd, modernState.changeId);
  const modernBefore = {
    state: readFileSync(join(modernRoot, 'state.json'), 'utf8'),
    events: readFileSync(join(modernRoot, 'events.jsonl'), 'utf8'),
    transitions: readdirSync(join(modernRoot, 'transitions')),
  };
  assert.throws(() => bindTask({ cwd: modern.cwd, packet: packetFor(modernState, modernPlan, 'state-task'),
    expectedRevision: modernState.revision }), (error) => error.code === 'IMPLEMENTATION_MODE_REQUIRED');
  assert.equal(readFileSync(join(modernRoot, 'state.json'), 'utf8'), modernBefore.state);
  assert.equal(readFileSync(join(modernRoot, 'events.jsonl'), 'utf8'), modernBefore.events);
  assert.deepEqual(readdirSync(join(modernRoot, 'transitions')), modernBefore.transitions);
  assert.equal(existsSync(join(modernRoot, 'implementation')), false);

  const legacy = repository('plan-only v1 implementation authority');
  const legacyV2 = await initializeState({ cwd: legacy.cwd, changeId: 'plan-only-v1', mode: 'plan-only',
    baseBranch: 'main', planningRef: legacy.sha, source: descriptor });
  const legacyPlanning = downgradeInitialStateToV1(legacy.cwd);
  const legacyState = acceptPlan({ cwd: legacy.cwd, plan: planFor(legacyV2), expectedRevision: legacyPlanning.revision });
  const legacyRoot = changeDirectory(legacy.cwd, legacyState.changeId);
  const legacyBefore = readFileSync(join(legacyRoot, 'state.json'), 'utf8');
  const legacyTransitions = readdirSync(join(legacyRoot, 'transitions'));
  assert.throws(() => upgradeState({ cwd: legacy.cwd, expectedRevision: legacyState.revision }),
    (error) => error.code === 'IMPLEMENTATION_MODE_REQUIRED');
  assert.equal(readFileSync(join(legacyRoot, 'state.json'), 'utf8'), legacyBefore);
  assert.deepEqual(readdirSync(join(legacyRoot, 'transitions')), legacyTransitions);
});

test('implement and full modes retain implementation authority', async () => {
  for (const mode of ['implement', 'full']) {
    const { cwd, sha } = repository(`${mode} implementation authority`);
    const planning = await initializeState({ cwd, changeId: `${mode}-authority`, mode,
      baseBranch: 'main', planningRef: sha, source: descriptor });
    const plan = planFor(planning);
    let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
    state = bindTask({ cwd, packet: packetFor(state, plan, 'state-task'), expectedRevision: state.revision });
    assert.equal(state.execution.tasks[0].status, 'bound');
  }
});

test('implementation acceptance and v1 upgrade require a named branch while plan-only remains detached-safe', async () => {
  for (const mode of ['implement', 'full']) {
    const fixture = repository(`${mode} detached acceptance`);
    const planning = await initializeState({ cwd: fixture.cwd, changeId: `${mode}-detached`, mode,
      baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
    git(fixture.cwd, 'switch', '--detach', fixture.sha);
    const root = changeDirectory(fixture.cwd, planning.changeId);
    const before = {
      state: readFileSync(join(root, 'state.json'), 'utf8'),
      events: readFileSync(join(root, 'events.jsonl'), 'utf8'),
      transitions: readdirSync(join(root, 'transitions')),
    };
    assert.throws(() => acceptPlan({ cwd: fixture.cwd, plan: planFor(planning), expectedRevision: planning.revision }),
      (error) => error.code === 'CENTRAL_BRANCH_REQUIRED');
    assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before.state);
    assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), before.events);
    assert.deepEqual(readdirSync(join(root, 'transitions')), before.transitions);
    assert.equal(existsSync(join(root, 'plan')), false);
    git(fixture.cwd, 'switch', 'main');
    const accepted = acceptPlan({ cwd: fixture.cwd, plan: planFor(planning), expectedRevision: planning.revision });
    assert.equal(accepted.git.branch, 'main');
  }

  const planningOnly = repository('plan-only detached acceptance');
  const planning = await initializeState({ cwd: planningOnly.cwd, changeId: 'plan-only-detached', mode: 'plan-only',
    baseBranch: 'main', planningRef: planningOnly.sha, source: descriptor });
  git(planningOnly.cwd, 'switch', '--detach', planningOnly.sha);
  const accepted = acceptPlan({ cwd: planningOnly.cwd, plan: planFor(planning), expectedRevision: planning.revision });
  assert.equal(accepted.git.branch, '(detached)');
  assert.equal(archiveState({ cwd: planningOnly.cwd, expectedRevision: accepted.revision }).archived, true);

  const legacy = repository('v1 detached upgrade');
  const legacyPlanningV2 = await initializeState({ cwd: legacy.cwd, changeId: 'v1-detached-upgrade', mode: 'implement',
    baseBranch: 'main', planningRef: legacy.sha, source: descriptor });
  const legacyPlanning = downgradeInitialStateToV1(legacy.cwd);
  const legacyAccepted = acceptPlan({ cwd: legacy.cwd, plan: planFor(legacyPlanningV2),
    expectedRevision: legacyPlanning.revision });
  git(legacy.cwd, 'switch', '--detach', legacy.sha);
  const legacyRoot = changeDirectory(legacy.cwd, legacyAccepted.changeId);
  const legacyBefore = readFileSync(join(legacyRoot, 'state.json'), 'utf8');
  const legacyTransitions = readdirSync(join(legacyRoot, 'transitions'));
  assert.throws(() => upgradeState({ cwd: legacy.cwd, expectedRevision: legacyAccepted.revision }),
    (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  assert.equal(readFileSync(join(legacyRoot, 'state.json'), 'utf8'), legacyBefore);
  assert.deepEqual(readdirSync(join(legacyRoot, 'transitions')), legacyTransitions);
  git(legacy.cwd, 'switch', 'main');
  assert.equal(upgradeState({ cwd: legacy.cwd, expectedRevision: legacyAccepted.revision }).schemaVersion, 2);
});

test('mapper packets bind exact original or amendment evidence and mismatch leaves no sidecars', async () => {
  const { cwd, sha } = repository('mapper history');
  const planning = await initializeState({ cwd, changeId: 'mapper-history', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning); const profile = behaviorSpecialization();
  plan.specialization = profile;
  plan.tasks = plan.tasks.map((task) => ({ ...task, specialization: profile }));
  const originalEvidence = mapperEvidence(sha, 1, 'Original mapping is clean.');
  let state = acceptPlan({ cwd, plan, planningEvidence: [originalEvidence], expectedRevision: 0 });
  const first = packetFor(state, plan, 'state-task'); first.behaviorMapperEvidence = { ...originalEvidence, summary: 'Unaccepted mapping.' };
  const statePath = join(changeDirectory(cwd, state.changeId), 'state.json');
  const before = readFileSync(statePath, 'utf8');
  assert.throws(() => bindTask({ cwd, packet: first, expectedRevision: state.revision }),
    (error) => error.code === 'TASK_PROVENANCE_MISMATCH');
  assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.equal(existsSync(join(changeDirectory(cwd, state.changeId), 'implementation')), false);

  first.behaviorMapperEvidence = originalEvidence;
  state = bindTask({ cwd, packet: first, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, first);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: first.taskId, workerId: 'mapper-worker', expectedRevision: state.revision });
  state = acceptResult({ cwd, result: resultFor(first, 'no-change'), workerCwd: worker.path, expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: first.taskId });

  const amendedPlan = structuredClone(plan); amendedPlan.planRevision = 2; amendedPlan.title = 'Mapper history amended';
  const amendedEvidence = mapperEvidence(sha, 2, 'Amended mapping is clean.');
  state = amendPlan({ cwd, resultingPlan: amendedPlan, planningEvidence: [amendedEvidence], expectedRevision: state.revision,
    amendment: { id: 'mapper-history-amendment', reason: 'Exercise historical mapper replay.', authorization: 'operator',
      trigger: 'operator-decision', delta: { title: amendedPlan.title }, invalidatedEvidence: [] } });
  const second = packetFor(state, amendedPlan, 'second-task'); second.behaviorMapperEvidence = amendedEvidence;
  state = bindTask({ cwd, packet: second, expectedRevision: state.revision });
  assert.equal(validateState({ cwd }).valid, true, 'replay must select original evidence for task one and amendment evidence for task two');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'no-change');
});

test('abandonment refuses created worktrees until active-state cleanup is tombstoned', async () => {
  const { cwd, sha } = repository('abandon cleanup ordering');
  const planning = await initializeState({ cwd, changeId: 'abandon-cleanup', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: state.revision });
  createWorkerFixture(cwd, state, packet);
  assert.throws(() => archiveState({ cwd, expectedRevision: state.revision, abandonReason: 'Stop.' }),
    (error) => ['RECEIPT_MISSING', 'WORKTREE_TOMBSTONE_MISMATCH'].includes(error.code));
  assert.equal(loadState(cwd).revision, state.revision);
  state = rejectTask({ cwd, taskId: packet.taskId, reason: 'Stop the work.', expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  assert.equal(archiveState({ cwd, expectedRevision: state.revision, abandonReason: 'Stop.' }).archived, true);
});

test('result acceptance rejects wrong worktree identity, branch, dirtiness, and HEAD', async () => {
  const { cwd, sha } = repository('worker identity rejection');
  const planning = await initializeState({ cwd, changeId: 'worker-identity', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: 1 });
  const worker = createWorkerFixture(cwd, state, packet); state = scheduleWave({ cwd, expectedRevision: 2 });
  writeFileSync(join(worker.path, 'prestart-dirty.txt'), 'dirty before start\n');
  assert.throws(() => startTask({ cwd, taskId: 'state-task', workerId: 'identity-worker', expectedRevision: 3 }),
    (error) => error.code === 'WORKTREE_GIT_MISMATCH');
  unlinkSync(join(worker.path, 'prestart-dirty.txt'));
  state = startTask({ cwd, taskId: 'state-task', workerId: 'identity-worker', expectedRevision: 3 });
  const result = resultFor(packet, 'no-change');
  const other = repository('wrong worker repository');
  for (const [label, workerCwd] of [['central path', cwd], ['wrong repository', other.cwd]]) {
    assert.throws(() => acceptResult({ cwd, result, workerCwd, expectedRevision: 4 }),
      (error) => error.code === 'WORKTREE_IDENTITY_MISMATCH', label);
  }
  git(worker.path, 'switch', '-c', 'wrong-worker-branch');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: 4 }),
    (error) => ['WORKTREE_REGISTRATION_MISMATCH', 'WORKTREE_GIT_MISMATCH'].includes(error.code));
  git(worker.path, 'switch', worker.branch);
  writeFileSync(join(worker.path, 'dirty.txt'), 'dirty\n');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: 4 }),
    (error) => error.code === 'WORKTREE_GIT_MISMATCH');
  unlinkSync(join(worker.path, 'dirty.txt'));
  writeFileSync(join(worker.path, 'head.txt'), 'head\n'); git(worker.path, 'add', 'head.txt'); git(worker.path, 'commit', '-m', 'test: wrong worker head');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: 4 }),
    (error) => error.code === 'WORKTREE_HEAD_MISMATCH');
  git(worker.path, 'reset', '--hard', sha);
  assert.equal(loadState(cwd).revision, 4);
});

test('bound task rejection retains evidence and amendment requires a replacement task ID', async () => {
  const { cwd, sha } = repository('bound rejection');
  const planning = await initializeState({ cwd, changeId: 'bound-rejection', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: 1 });
  state = rejectTask({ cwd, taskId: 'state-task', reason: 'The immutable packet must be replaced.', expectedRevision: 2 });
  const rejected = state.execution.tasks[0]; assert.equal(rejected.status, 'rejected'); assert.equal(rejected.workerId, null);
  const resulting = planFor(planning, 2); resulting.tasks[0].id = 'replacement-task'; resulting.criteria[0].ownerTaskId = 'replacement-task';
  resulting.checklistMappings[0].taskIds = ['replacement-task'];
  const suffix = 'state-task/0001.json';
  state = amendPlan({ cwd, expectedRevision: 3, resultingPlan: resulting,
    amendment: { id: 'replace-rejected-task', reason: 'Replace rejected immutable work.', authorization: 'operator', trigger: 'task-rejected',
      delta: { replacementTaskId: 'replacement-task' }, invalidatedEvidence: [
        `implementation/tasks/${suffix}`, `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`,
      ] } });
  assert.equal(state.phase, 'implementing');
  assert.deepEqual(state.execution.tasks.map(({ id, status }) => ({ id, status })), [{ id: 'replacement-task', status: 'unbound' }]);
});

test('wave scheduling refuses partial worktree creation evidence until recovery restores active manifest', async () => {
  const { cwd, sha } = repository('partial worktree scheduling');
  const planning = await initializeState({ cwd, changeId: 'partial-scheduling', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: 1 });
  createWorkerFixture(cwd, state, packet);
  const manifestPath = join(changeRoot(cwd), 'worktrees', 'manifests', state.changeId, 'state-task.json');
  const receiptPath = manifestPath.replace(/\.json$/u, '.sha256');
  const manifest = readFileSync(manifestPath); const receipt = readFileSync(receiptPath);
  unlinkSync(manifestPath); unlinkSync(receiptPath);
  assert.throws(() => scheduleWave({ cwd, expectedRevision: 2 }), (error) => error.code === 'RECEIPT_MISSING');
  writeFileSync(manifestPath, manifest); writeFileSync(receiptPath, receipt);
  state = scheduleWave({ cwd, expectedRevision: 2 });
  assert.deepEqual(state.execution.activeWave, ['state-task']);
});
import { archiveDirectory } from '../paths.mjs';
import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { digestJson, sourceChecklistBinding } from '../contracts/contracts.mjs';
import { implementationTaskDigest } from '../implementation/contracts.mjs';
import { removeTaskWorktree } from '../worktree/worktree.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(label = 'change state') {
  const cwd = mkdtempSync(join(tmpdir(), `${label} `));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'State Test');
  git(cwd, 'config', 'user.email', 'state@example.invalid');
  writeFileSync(join(cwd, 'request.md'), '# Request\n\n- [ ] <!-- aerstello:item=durable-state --> Add durable state\n');
  mkdirSync(join(cwd, 'specs', 'features'), { recursive: true });
  writeFileSync(join(cwd, 'specs', 'features', 'state.feature'), 'Feature: State\n\n  Scenario: Durable planning scenario\n    Then state is durable\n');
  git(cwd, 'add', 'request.md', 'specs/features/state.feature');
  git(cwd, 'commit', '-m', 'test: seed repository');
  return { cwd, sha: git(cwd, 'rev-parse', 'HEAD') };
}

const descriptor = { type: 'direct-request', path: 'request.md', relationshipIntent: 'reference-only' };
const registry = loadRegistry();

function specialization() {
  const value = { specialization: 'ops-workflow', affectedAreas: ['workflow'], riskTags: ['workflow'],
    browserVisible: false, relatedTestSelectionUncertain: false };
  return { ...value, route: routeSpecialists({ ...value, testSelectionUncertain: false }, registry) };
}

function behaviorSpecialization() {
  const value = { specialization: 'ops-workflow', affectedAreas: ['workflow'], riskTags: ['workflow'],
    browserVisible: true, relatedTestSelectionUncertain: false };
  return { ...value, route: routeSpecialists({ ...value, testSelectionUncertain: false }, registry) };
}

function mapperEvidence(headSha, planRevision, summary) {
  return { schemaVersion: 1, planRevision, reviewerId: 'behavior_mapper', headSha, status: 'clean',
    summary, findings: [], recordedAt: '2026-08-18T10:00:00.000Z' };
}

function planFor(state, revision = 1) {
  return {
    schemaVersion: 1, planRevision: revision, changeId: state.changeId,
    source: { kind: state.source.kind, reference: state.source.reference,
      relationship: state.source.relationship, captureDigest: state.source.latestDigest },
    title: 'Durable state', objective: 'Exercise durable state transitions.',
    scope: ['Repository workflow'], nonGoals: ['Product behavior'],
    planning: { planningSha: state.planningSha, baseBranch: state.baseBranch, comparisonBaseSha: null },
    expectedPrBaseBranch: state.expectedPrBaseBranch,
    criteria: [{ id: 'durable-state', description: 'State remains durable.', disposition: 'owned', ownerTaskId: 'state-task', deferredReason: null }],
    decisions: [{ id: 'storage-root', question: 'Where?', rationale: 'Share worktrees.', status: 'resolved', resolution: 'Git common directory.' }],
    scenarios: [], productScenarioDisposition: { disposition: 'not-applicable', scenarioIds: [], rationale: 'Repository tooling only.' },
    specialization: specialization(),
    checklistMappings: state.checklist.map((item) => ({ id: item.id, identity: { kind: 'stable-marker', stableId: item.id },
      capturedText: state.source.kind === 'github-issue' ? 'State remains durable' : 'Add durable state', criterionIds: ['durable-state'], taskIds: ['state-task'],
      relationship: state.source.relationship, checked: item.checked, status: item.status, ambiguity: null,
      externalChange: item.externalChange })),
    tasks: [{ id: 'state-task', title: 'Implement state', objective: 'Persist state.', rationale: 'Recovery needs evidence.',
      specialization: specialization(), criterionIds: ['durable-state'], decisionIds: ['storage-root'], scenarioIds: [],
      checklistItemIds: state.checklist.map((item) => item.id), dependsOn: [], anticipatedPaths: ['.agents/skills/change-development/scripts/state'],
      produces: [], consumes: [], validationIntent: ['Exercise state transitions'], unsplittable: null }],
  };
}

function executionPlanFor(state) {
  const plan = planFor(state);
  plan.criteria.push({ id: 'second-change', description: 'Second task remains independent.', disposition: 'owned', ownerTaskId: 'second-task', deferredReason: null });
  plan.tasks[0] = { ...plan.tasks[0], anticipatedPaths: ['first.txt'] };
  plan.tasks.push({ ...plan.tasks[0], id: 'second-task', title: 'Implement second', objective: 'Persist second file.',
    criterionIds: ['second-change'], checklistItemIds: [], anticipatedPaths: ['second.txt'] });
  return plan;
}

function packetFor(state, plan, taskId) {
  const task = plan.tasks.find((entry) => entry.id === taskId);
  return {
    schemaVersion: 1, changeId: state.changeId, taskId, planRevision: plan.planRevision,
    planDigest: state.plan.effectiveDigest, planningSha: state.planningSha, taskBaseSha: state.git.headSha,
    specialization: task.specialization.specialization, riskTags: task.specialization.riskTags,
    affectedAreas: task.specialization.affectedAreas,
    planningSignals: { browserVisible: task.specialization.browserVisible,
      relatedTestSelectionUncertain: task.specialization.relatedTestSelectionUncertain },
    specialistRoute: task.specialization.route, behaviorMapperEvidence: null, objective: task.objective,
    evidence: 'Implement only the exact accepted-plan task in the owned worktree.', decisionIds: task.decisionIds,
    decisionContext: task.decisionIds.map((id) => ({ id, resolution: plan.decisions.find((entry) => entry.id === id).resolution })),
    acceptanceCriteriaIds: task.criterionIds,
    acceptanceCriteria: task.criterionIds.map((id) => ({ id, description: plan.criteria.find((entry) => entry.id === id).description })),
    allowedPaths: [...task.anticipatedPaths], forbiddenPaths: [], dependencies: [...task.dependsOn],
    requiredValidation: { unit: [{ command: 'node --test .agents/skills/change-development/scripts/state/state.test.mjs', reason: 'Exercise state behavior.' }], system: [] },
  };
}

function resultFor(packet, status, workerCommit = null, changedPaths = []) {
  return { schemaVersion: 1, changeId: packet.changeId, taskId: packet.taskId, planDigest: packet.planDigest,
    packetDigest: implementationTaskDigest(packet), specialization: packet.specialization, taskBaseSha: packet.taskBaseSha,
    status, workerCommit, changedPaths, validation: [{ command: packet.requiredValidation.unit[0].command, result: 'passed', summary: 'Focused validation passed.' }],
    unexpectedDependencies: [], summary: status === 'implemented' ? 'Implemented the exact packet.' : 'No repository change was needed.' };
}

function createWorkerFixture(cwd, state, packet) {
  const branch = `codex/change-${state.changeId}/${packet.taskId}`;
  const path = join(changeRoot(cwd), 'worktrees', 'changes', state.changeId, packet.taskId);
  git(cwd, 'worktree', 'add', '-b', branch, path, packet.taskBaseSha);
  const identity = { schemaVersion: 1, repository: git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    changeId: state.changeId, taskId: packet.taskId, packetDigest: implementationTaskDigest(packet), branch,
    path, baseSha: packet.taskBaseSha };
  const creation = { ...identity, status: 'creating' };
  writeReceiptJson(join(changeRoot(cwd), 'worktrees', 'manifests', state.changeId, `${packet.taskId}.creation.json`), creation);
  writeReceiptJson(join(changeRoot(cwd), 'worktrees', 'manifests', state.changeId, `${packet.taskId}.json`),
    { ...identity, status: 'active', creationIntentDigest: digestJson(creation) });
  return { ...identity };
}

function scenarioPlanFor(state, revision = 1) {
  const value = planFor(state, revision);
  value.scenarios = [{ id: 'durable-scenario', feature: 'specs/features/state.feature', scenario: 'Durable planning scenario' }];
  value.productScenarioDisposition = {
    disposition: 'mapped', scenarioIds: ['durable-scenario'], rationale: 'The exact product scenario is mapped.',
  };
  value.tasks[0].scenarioIds = ['durable-scenario'];
  return value;
}

function planForObservation(state, observation, revision = 1) {
  const value = planFor(state, revision);
  value.checklistMappings = observation.source.checklist.map((item) => ({
    ...sourceChecklistBinding(item),
    criterionIds: ['durable-state'], taskIds: ['state-task'], relationship: state.source.relationship,
  }));
  value.tasks[0].checklistItemIds = value.checklistMappings.map(({ id }) => id);
  return value;
}

function issueSource(number, id = `I_${number}`) {
  return {
    id, number, title: 'Decision source',
    body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z',
    updatedAt: '2026-08-17T10:00:00Z', comments: [], commentsComplete: true,
  };
}

async function acceptedMaterialDrift(cwd, sha, changeId, number) {
  const issue = issueSource(number, `I_${changeId}`);
  const adapter = { async readIssue() { return structuredClone(issue); } };
  const planning = await initializeState({
    cwd, changeId, mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: number, relationshipIntent: 'resolves' },
    sourceAdapter: adapter,
  });
  acceptPlan({ cwd, expectedRevision: 0, plan: planFor(planning) });
  issue.body += '\n\nMaterial source drift.';
  issue.updatedAt = '2026-08-17T10:01:00Z';
  const drift = await refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter });
  assert.equal(drift.phase, 'awaiting-decision');
  return { planning, drift, issue, adapter };
}

function writeReceiptJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  writeFileSync(path.replace(/\.json$/u, '.sha256'), `${digestJson(value)}\n`);
}

function installLegacyPreacceptDecision(cwd, decisionId = 'legacy-preaccept') {
  const state = loadState(cwd);
  const recordedAt = new Date(Date.parse(state.updatedAt) + 1_000).toISOString();
  const observed = {
    headSha: git(cwd, 'rev-parse', 'HEAD'),
    branch: git(cwd, 'branch', '--show-current') || '(detached)',
    clean: git(cwd, 'status', '--porcelain') === '',
    observedAt: recordedAt,
  };
  const record = {
    schemaVersion: 1, id: decisionId, reason: 'Legacy planning prose.',
    authorization: 'operator', trigger: 'request', disposition: 'resolve',
    changeId: state.changeId, stateRevision: state.revision,
    sourceObservationDigest: state.source.observationDigest,
    sourceDigest: state.source.latestDigest, effectivePlanDigest: null,
    repositorySha: observed.headSha, recordedAt,
  };
  const next = {
    ...state, git: observed, revision: state.revision + 1, updatedAt: recordedAt,
  };
  next.nextAction = nextActionFor(next);
  const decisionDigest = digestJson(record);
  const decisionPath = `decisions/${decisionId}.json`;
  const intent = {
    schemaVersion: 1, changeId: state.changeId, revision: next.revision,
    type: 'decision-recorded', summary: `Recorded decision ${decisionId}`,
    previousStateDigest: digestJson(state), nextStateDigest: digestJson(next), nextState: next,
    evidence: { decisionDigest }, evidencePaths: { decisionDigest: decisionPath },
    authoritativeEvidence: {
      decisionDigest: { path: decisionPath, label: `decision ${decisionId}`, digest: decisionDigest, value: record },
    },
    createdAt: recordedAt,
  };
  const receipt = {
    schemaVersion: 1, revision: next.revision, intentDigest: digestJson(intent),
    stateDigest: digestJson(next), evidence: intent.evidence, completedAt: recordedAt,
  };
  const root = changeDirectory(cwd, state.changeId);
  const transition = join(root, 'transitions', String(next.revision).padStart(8, '0'));
  writeReceiptJson(join(root, decisionPath), record);
  writeReceiptJson(join(transition, 'intent.json'), intent);
  writeReceiptJson(join(transition, 'receipt.json'), receipt);
  writeFileSync(join(transition, 'complete'), `${digestJson(receipt)}\n`);
  writeFileSync(join(root, 'state.json'), `${JSON.stringify(next)}\n`);
  const eventsPath = join(root, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  events.push(JSON.stringify({ revision: next.revision, type: intent.type, summary: intent.summary, at: recordedAt }));
  writeFileSync(eventsPath, `${events.join('\n')}\n`);
  return next;
}

function downgradeInitialStateToV1(cwd) {
  const state = loadState(cwd);
  const legacy = { ...state, schemaVersion: 1 };
  delete legacy.execution;
  legacy.nextAction = nextActionFor(legacy);
  const transition = join(changeDirectory(cwd, state.changeId), 'transitions', '00000000');
  const intentPath = join(transition, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.nextState = legacy;
  intent.nextStateDigest = digestJson(legacy);
  const receipt = {
    schemaVersion: 1, revision: 0, intentDigest: digestJson(intent), stateDigest: digestJson(legacy),
    evidence: intent.evidence, completedAt: legacy.updatedAt,
  };
  writeReceiptJson(intentPath, intent);
  writeReceiptJson(join(transition, 'receipt.json'), receipt);
  writeFileSync(join(transition, 'complete'), `${digestJson(receipt)}\n`);
  writeFileSync(join(changeDirectory(cwd, state.changeId), 'state.json'), `${JSON.stringify(legacy)}\n`);
  return legacy;
}

test('initialization persists valid shared state and receipts', async () => {
  const { cwd, sha } = repository();
  const state = await initializeState({
    cwd, changeId: 'durable-change', mode: 'plan-only', baseBranch: 'main',
    planningRef: sha, source: descriptor,
  });
  assert.equal(state.phase, 'planning');
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.execution, null);
  assert.equal(state.source.initialDigest, state.source.latestDigest);
  assert.equal(loadState(cwd).changeId, 'durable-change');
  assert.equal(validateState({ cwd }).valid, true);

  const linked = `${cwd} linked`;
  git(cwd, 'worktree', 'add', '--detach', linked, sha);
  assert.equal(loadState(linked).changeId, 'durable-change');
  const before = loadState(cwd).revision;
  const checkpoint = checkpointGitMetadata({ cwd: linked });
  assert.equal(checkpoint.checkpointed, false);
  assert.match(checkpoint.warning, /another linked worktree/u);
  assert.equal(loadState(cwd).revision, before);
});

test('recovery finishes only the exact interrupted initialization', async () => {
  const { cwd, sha } = repository('crash state');
  await assert.rejects(initializeState({
    cwd, changeId: 'crash-change', mode: 'plan-only', baseBranch: 'main',
    planningRef: sha, source: descriptor,
    crashStep(step) { if (step === 'after-state') throw new Error('injected crash'); },
  }), /injected crash/u);
  const result = recoverState({ cwd, changeId: 'crash-change' });
  assert.equal(result.recovered, true);
  assert.equal(loadState(cwd).revision, 0);
  assert.equal(JSON.parse(readFileSync(activePointerPath(cwd), 'utf8')).changeId, 'crash-change');
});

test('pointerless completed initialization is discoverable without a remembered change ID', async () => {
  const { cwd, sha } = repository('pointerless state');
  await initializeState({ cwd, changeId: 'pointerless-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  unlinkSync(activePointerPath(cwd));
  assert.match(renderStatus({ cwd }), /pointerless-change[\s\S]*Phase: recovering/u);
  await assert.rejects(initializeState({ cwd, changeId: 'must-not-start', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor }),
    (error) => error.code === 'LIFECYCLE_RECOVERY_REQUIRED');
  assert.equal(recoverState({ cwd }).recovered, true);
  assert.equal(loadState(cwd).changeId, 'pointerless-change');
});

test('pointerless state is recovery-only and later completed revisions fail closed unchanged', async () => {
  const initialization = repository('pointerless ordinary commands');
  const issue = {
    id: 'I_pointerless', number: 22, title: 'Pointerless state',
    body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
    comments: [], commentsComplete: true,
  };
  let reads = 0;
  const adapter = { async readIssue() { reads += 1; return structuredClone(issue); } };
  const planning = await initializeState({ cwd: initialization.cwd, changeId: 'pointerless-ordinary', mode: 'plan-only',
    baseBranch: 'main', planningRef: initialization.sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 22, relationshipIntent: 'resolves' }, sourceAdapter: adapter });
  unlinkSync(activePointerPath(initialization.cwd));
  const statePath = join(changeDirectory(initialization.cwd, planning.changeId), 'state.json');
  const eventsPath = join(changeDirectory(initialization.cwd, planning.changeId), 'events.jsonl');
  const durableBefore = [readFileSync(statePath, 'utf8'), readFileSync(eventsPath, 'utf8')];
  const ordinary = [
    () => acceptPlan({ cwd: initialization.cwd, changeId: planning.changeId, plan: planFor(planning), expectedRevision: 0 }),
    () => recordDecision({ cwd: initialization.cwd, changeId: planning.changeId, expectedRevision: 0,
      decision: { id: 'pointerless-decision', reason: 'No pointer.', authorization: 'operator', trigger: 'test', disposition: 'resolve' } }),
    () => amendPlan({ cwd: initialization.cwd, changeId: planning.changeId, expectedRevision: 0, resultingPlan: planFor(planning, 2),
      amendment: { id: 'pointerless-amendment', reason: 'No pointer.', authorization: 'operator', trigger: 'test',
        delta: { changed: ['title'] }, invalidatedEvidence: [] } }),
    () => archiveState({ cwd: initialization.cwd, changeId: planning.changeId, expectedRevision: 0, abandonReason: 'No pointer.' }),
  ];
  for (const operation of ordinary) assert.throws(operation, (error) => error.code === 'STATE_NOT_FOUND');
  await assert.rejects(refreshSource({ cwd: initialization.cwd, changeId: planning.changeId, expectedRevision: 0, sourceAdapter: adapter }),
    (error) => error.code === 'STATE_NOT_FOUND');
  assert.equal(reads, 1, 'pointerless refresh must not perform another connector read');
  assert.equal(checkpointGitMetadata({ cwd: initialization.cwd }).checkpointed, false);
  assert.deepEqual([readFileSync(statePath, 'utf8'), readFileSync(eventsPath, 'utf8')], durableBefore);
  assert.equal(recoverState({ cwd: initialization.cwd, changeId: planning.changeId }).recovered, true);

  const later = repository('pointerless completed revision');
  const laterPlanning = await initializeState({ cwd: later.cwd, changeId: 'pointerless-later', mode: 'plan-only',
    baseBranch: 'main', planningRef: later.sha, source: descriptor });
  acceptPlan({ cwd: later.cwd, expectedRevision: 0, plan: planFor(laterPlanning) });
  unlinkSync(activePointerPath(later.cwd));
  const laterState = join(changeDirectory(later.cwd, 'pointerless-later'), 'state.json');
  const laterEvents = join(changeDirectory(later.cwd, 'pointerless-later'), 'events.jsonl');
  const laterBefore = [readFileSync(laterState, 'utf8'), readFileSync(laterEvents, 'utf8')];
  assert.throws(() => recoverState({ cwd: later.cwd, changeId: 'pointerless-later' }),
    (error) => error.code === 'RECOVERY_STATE_CONFLICT');
  assert.deepEqual([readFileSync(laterState, 'utf8'), readFileSync(laterEvents, 'utf8')], laterBefore);
});

test('dangling active pointers and completed transitions without state fail closed', async () => {
  const dangling = repository('dangling pointer');
  await initializeState({ cwd: dangling.cwd, changeId: 'dangling-change', mode: 'plan-only', baseBranch: 'main', planningRef: dangling.sha, source: descriptor });
  unlinkSync(join(changeDirectory(dangling.cwd, 'dangling-change'), 'state.json'));
  assert.throws(() => locateState(dangling.cwd), (error) => error.code === 'ACTIVE_POINTER_INVALID');
  await assert.rejects(initializeState({ cwd: dangling.cwd, changeId: 'replacement-change', mode: 'plan-only', baseBranch: 'main',
    planningRef: dangling.sha, source: descriptor }), (error) => error.code === 'ACTIVE_POINTER_INVALID');
  assert.throws(() => recoverState({ cwd: dangling.cwd }), (error) => error.code === 'ACTIVE_POINTER_INVALID');
  const status = renderStatus({ cwd: dangling.cwd });
  assert.ok(status.length <= 2500);
  assert.match(status, /Phase: blocked[\s\S]*ACTIVE_POINTER_INVALID[\s\S]*automatic recovery is blocked/u);
  assert.match(renderStatus({ cwd: dangling.cwd, changeId: 'dangling-change' }),
    /Phase: blocked[\s\S]*ACTIVE_POINTER_INVALID/u);

  const missing = repository('completed missing state');
  await initializeState({ cwd: missing.cwd, changeId: 'missing-state', mode: 'plan-only', baseBranch: 'main', planningRef: missing.sha, source: descriptor });
  unlinkSync(activePointerPath(missing.cwd));
  unlinkSync(join(changeDirectory(missing.cwd, 'missing-state'), 'state.json'));
  assert.throws(() => recoverState({ cwd: missing.cwd, changeId: 'missing-state' }),
    (error) => error.code === 'RECOVERY_STATE_CONFLICT');
});

test('initialization rejects dirty and non-ancestor planning snapshots', async () => {
  const { cwd, sha } = repository('snapshot state');
  writeFileSync(join(cwd, 'untracked.txt'), 'dirty');
  await assert.rejects(initializeState({
    cwd, changeId: 'dirty-change', mode: 'plan-only', baseBranch: 'main',
    planningRef: sha, source: descriptor,
  }), (error) => error instanceof StateError && error.code === 'PLANNING_SNAPSHOT_MISMATCH');
});

test('acceptance is immutable, revision guarded, receipt protected, and mode-gated for archive', async () => {
  const { cwd, sha } = repository('accept state');
  const planning = await initializeState({ cwd, changeId: 'accept-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd, plan: scenarioPlanFor(planning), expectedRevision: 9 }), (error) => error.code === 'REVISION_CONFLICT');
  const ready = acceptPlan({ cwd, plan: scenarioPlanFor(planning), expectedRevision: 0 });
  assert.equal(ready.phase, 'ready-to-implement');
  assert.equal(ready.execution.planDigest, ready.plan.effectiveDigest);
  assert.deepEqual(ready.execution.tasks.map(({ id, status }) => ({ id, status })), [{ id: 'state-task', status: 'unbound' }]);
  assert.match(renderStatus({ cwd }), /Archive this completed plan-only change/u);
  assert.throws(() => acceptPlan({ cwd, plan: scenarioPlanFor(planning), expectedRevision: 1 }), (error) => error.code === 'PLAN_ALREADY_ACCEPTED');
  const archived = archiveState({ cwd, expectedRevision: 1 });
  assert.equal(archived.archived, true);

  const other = repository('implement state');
  const implementation = await initializeState({ cwd: other.cwd, changeId: 'implement-change', mode: 'implement', baseBranch: 'main', planningRef: other.sha, source: descriptor });
  acceptPlan({ cwd: other.cwd, plan: planFor(implementation), expectedRevision: 0 });
  assert.throws(() => archiveState({ cwd: other.cwd, expectedRevision: 1 }), (error) => error.code === 'ARCHIVE_NOT_ALLOWED');
  writeFileSync(join(other.cwd, 'blocked.txt'), 'dirty'); checkpointGitMetadata({ cwd: other.cwd });
  assert.throws(() => amendPlan({ cwd: other.cwd, expectedRevision: 2, resultingPlan: planFor(implementation, 2),
    amendment: { id: 'blocked-amendment', reason: 'Must not resurrect.', authorization: 'operator', trigger: 'blocked',
      delta: { changed: ['title'] }, invalidatedEvidence: [] } }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
});

test('plan receipt tampering and transition orphans fail closed', async () => {
  const { cwd, sha } = repository('tamper state');
  const planning = await initializeState({ cwd, changeId: 'tamper-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  acceptPlan({ cwd, plan: scenarioPlanFor(planning), expectedRevision: 0 });
  const path = join(changeDirectory(cwd, 'tamper-change'), 'plan', 'plan.json');
  const changed = JSON.parse(readFileSync(path, 'utf8')); changed.title = 'Tampered'; writeFileSync(path, JSON.stringify(changed));
  assert.throws(() => validateState({ cwd }), (error) => error.code === 'RECEIPT_TAMPERED');

  const orphan = repository('orphan state');
  await initializeState({ cwd: orphan.cwd, changeId: 'orphan-change', mode: 'plan-only', baseBranch: 'main', planningRef: orphan.sha, source: descriptor });
  unlinkSync(join(changeDirectory(orphan.cwd, 'orphan-change'), 'source', 'initial.json'));
  assert.throws(() => validateState({ cwd: orphan.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');

  const extra = repository('extra evidence');
  await initializeState({ cwd: extra.cwd, changeId: 'extra-change', mode: 'plan-only', baseBranch: 'main', planningRef: extra.sha, source: descriptor });
  const base = changeDirectory(extra.cwd, 'extra-change'); mkdirSync(join(base, 'decisions'));
  copyFileSync(join(base, 'source', 'initial.json'), join(base, 'decisions', 'orphan.json'));
  copyFileSync(join(base, 'source', 'initial.sha256'), join(base, 'decisions', 'orphan.sha256'));
  assert.throws(() => validateState({ cwd: extra.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.match(renderStatus({ cwd: extra.cwd }), /Phase: blocked[\s\S]*Inspect or restore the durable evidence/u);
  assert.throws(() => acceptPlan({ cwd: extra.cwd, plan: planFor(loadState(extra.cwd)), expectedRevision: 0 }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
});

test('amendments append a replayable complete plan without rewriting the accepted plan', async () => {
  const { cwd, sha } = repository('amend state');
  const planning = await initializeState({ cwd, changeId: 'amend-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0 });
  const originalPath = join(changeDirectory(cwd, 'amend-change'), 'plan', 'plan.json');
  const original = readFileSync(originalPath, 'utf8');
  const resultingPlan = scenarioPlanFor(planning, 2); resultingPlan.title = 'Durable state, amended';
  const amended = amendPlan({ cwd, expectedRevision: 1, resultingPlan,
    amendment: { id: 'clarify-title', reason: 'Clarify plan title.', authorization: 'operator-confirmed',
      delta: { changed: ['title'] }, trigger: 'operator-decision', invalidatedEvidence: [] } });
  assert.equal(amended.plan.amendmentCount, 1);
  assert.equal(readFileSync(originalPath, 'utf8'), original);
  assert.equal(validateState({ cwd }).valid, true);
  assert.throws(() => amendPlan({ cwd, expectedRevision: 2, resultingPlan: { ...resultingPlan, planRevision: 3 },
    amendment: { id: 'clarify-title', reason: 'Duplicate.', authorization: 'operator-confirmed', trigger: 'operator-decision',
      delta: { changed: ['title'] }, invalidatedEvidence: [] } }),
  (error) => error.code === 'AMENDMENT_ID_CONFLICT');
});

test('concurrent initialization admits exactly one active change', async () => {
  const { cwd, sha } = repository('concurrent state');
  const settled = await Promise.allSettled(['first-change', 'second-change'].map((changeId) => initializeState({
    cwd, changeId, mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor,
  })));
  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(settled.filter(({ status }) => status === 'rejected').length, 1);
});

test('refresh separates progress from material drift and requires explicit retain authorization', async () => {
  const { cwd, sha } = repository('refresh state');
  const issue = {
    id: 'I_kwTEST', number: 22, url: 'https://example.invalid/issues/22', title: 'Durable state',
    body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z',
    updatedAt: '2026-08-17T10:00:00Z', comments: [], commentsComplete: true,
  };
  const adapter = { async readIssue() { return structuredClone(issue); } };
  const planning = await initializeState({
    cwd, changeId: 'refresh-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 22, relationshipIntent: 'resolves' },
    sourceAdapter: adapter,
  });
  const ready = acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0 });
  const acceptedDigest = ready.plan.originalDigest;
  issue.body = issue.body.replace('[ ]', '[x]'); issue.updatedAt = '2026-08-17T10:01:00Z';
  const progress = await refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter });
  assert.equal(progress.source.classification, 'progress-only');
  assert.equal(progress.phase, 'ready-to-implement');
  const stillProgress = await refreshSource({ cwd, expectedRevision: 2, sourceAdapter: adapter });
  assert.equal(stillProgress.source.classification, 'progress-only');
  issue.body += '\n\nNew material requirement.'; issue.updatedAt = '2026-08-17T10:02:00Z';
  const material = await refreshSource({ cwd, expectedRevision: 3, sourceAdapter: adapter });
  assert.equal(material.phase, 'awaiting-decision');
  assert.equal(material.source.classification, 'unreviewed-material');
  const stillMaterial = await refreshSource({ cwd, expectedRevision: 4, sourceAdapter: adapter });
  assert.equal(stillMaterial.phase, 'awaiting-decision');
  assert.equal(stillMaterial.source.classification, 'unreviewed-material');
  assert.throws(() => amendPlan({ cwd, expectedRevision: 5, resultingPlan: planFor(stillMaterial, 2),
    amendment: { id: 'material-amendment', reason: 'Incorporate drift.', authorization: 'operator', trigger: 'source-refresh',
      delta: { changed: ['source'] }, invalidatedEvidence: [] } }), (error) => error.code === 'DECISION_REQUIRED');
  writeFileSync(join(cwd, 'dirty.txt'), 'dirty');
  assert.throws(() => recordDecision({ cwd, expectedRevision: 5, decision: {
    id: 'retain-live-drift', reason: 'Covered.', authorization: 'operator-confirmed', trigger: 'source-refresh', disposition: 'retain-plan',
  } }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
  unlinkSync(join(cwd, 'dirty.txt'));
  const retained = recordDecision({ cwd, expectedRevision: 5, decision: {
    id: 'retain-live-drift', reason: 'The accepted plan already covers this wording.',
    authorization: 'operator-confirmed', trigger: 'source-refresh', disposition: 'retain-plan',
  } });
  assert.equal(retained.phase, 'ready-to-implement');
  assert.equal(retained.plan.originalDigest, acceptedDigest);
  assert.throws(() => recordDecision({ cwd, expectedRevision: 6, decision: {
    id: 'late-decision', reason: 'Too late.', authorization: 'operator-confirmed', trigger: 'operator', disposition: 'resolve',
  } }), (error) => error.code === 'INVALID_PHASE');
});

test('refresh rejects abandoned and blocked phases before connector I/O and preserves terminal state', async () => {
  for (const terminal of ['abandoned', 'blocked']) {
    const { cwd, sha } = repository(`${terminal} refresh`);
    const issue = {
      id: `I_${terminal}`, number: 23, title: 'Terminal refresh',
      body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
      author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
      comments: [], commentsComplete: true,
    };
    let reads = 0;
    const adapter = { async readIssue() { reads += 1; return structuredClone(issue); } };
    await initializeState({ cwd, changeId: `${terminal}-refresh`, mode: 'plan-only', baseBranch: 'main', planningRef: sha,
      source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 23, relationshipIntent: 'reference-only' }, sourceAdapter: adapter });
    if (terminal === 'abandoned') {
      assert.throws(() => archiveState({ cwd, expectedRevision: 0, abandonReason: 'Stop this change.',
        crashStep(step) { if (step === 'after-complete') throw new Error('stop before archive'); } }), /stop before archive/u);
    } else {
      writeFileSync(join(cwd, 'dirty.txt'), 'dirty');
      assert.equal(checkpointGitMetadata({ cwd }).state.phase, 'blocked');
    }
    const stateBefore = readFileSync(join(changeDirectory(cwd, `${terminal}-refresh`), 'state.json'), 'utf8');
    const eventsBefore = readFileSync(join(changeDirectory(cwd, `${terminal}-refresh`), 'events.jsonl'), 'utf8');
    await assert.rejects(refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter }),
      (error) => error.code === 'INVALID_PHASE');
    assert.equal(reads, 1, `${terminal} refresh must not perform connector I/O`);
    assert.equal(readFileSync(join(changeDirectory(cwd, `${terminal}-refresh`), 'state.json'), 'utf8'), stateBefore);
    assert.equal(readFileSync(join(changeDirectory(cwd, `${terminal}-refresh`), 'events.jsonl'), 'utf8'), eventsBefore);
    if (terminal === 'abandoned') assert.equal(archiveState({ cwd, expectedRevision: 1 }).archived, true);
  }
});

test('material amendments require the exact current bound resolve-decision trigger', async () => {
  const { cwd, sha } = repository('exact amendment decision');
  const issue = {
    id: 'I_decision', number: 24, title: 'Decision binding',
    body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
    comments: [], commentsComplete: true,
  };
  const adapter = { async readIssue() { return structuredClone(issue); } };
  const planning = await initializeState({ cwd, changeId: 'decision-binding', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 24, relationshipIntent: 'resolves' }, sourceAdapter: adapter });
  acceptPlan({ cwd, expectedRevision: 0, plan: planFor(planning) });
  issue.body += '\n\nMaterial one.'; issue.updatedAt = '2026-08-17T10:01:00Z';
  const drift = await refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter });
  const decided = recordDecision({ cwd, expectedRevision: 2, decision: {
    id: 'resolve-current', reason: 'Incorporate current drift.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve',
  } });
  const amendment = (id, trigger) => ({ id, reason: 'Incorporate reviewed drift.', authorization: 'operator', trigger,
    delta: { changed: ['source'] }, invalidatedEvidence: [] });
  const revisionTwo = planForObservation(decided, loadLatestSourceObservation(cwd), 2);
  assert.throws(() => amendPlan({ cwd, expectedRevision: 3, resultingPlan: revisionTwo,
    amendment: amendment('wrong-trigger-amendment', 'does-not-exist') }), (error) => error.code === 'DECISION_REQUIRED');
  const amended = amendPlan({ cwd, expectedRevision: 3, resultingPlan: revisionTwo,
    amendment: amendment('exact-trigger-amendment', 'resolve-current') });
  assert.equal(amended.phase, 'ready-to-implement');

  issue.body += '\n\nMaterial two.'; issue.updatedAt = '2026-08-17T10:02:00Z';
  await refreshSource({ cwd, expectedRevision: 4, sourceAdapter: adapter });
  recordDecision({ cwd, expectedRevision: 5, decision: {
    id: 'resolve-stale', reason: 'Review second drift.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve',
  } });
  await refreshSource({ cwd, expectedRevision: 6, sourceAdapter: adapter });
  const revisionThree = planForObservation(loadState(cwd), loadLatestSourceObservation(cwd), 3);
  for (const trigger of ['resolve-current', 'resolve-stale']) {
    assert.throws(() => amendPlan({ cwd, expectedRevision: 7, resultingPlan: revisionThree,
      amendment: amendment(`reject-${trigger}`, trigger) }), (error) => error.code === 'DECISION_REQUIRED');
  }

  recordDecision({ cwd, expectedRevision: 7, decision: {
    id: 'retain-second', reason: 'Existing amendment covers second drift.', authorization: 'operator', trigger: 'source-refresh', disposition: 'retain-plan',
  } });
  issue.body += '\n\nMaterial three.'; issue.updatedAt = '2026-08-17T10:03:00Z';
  await refreshSource({ cwd, expectedRevision: 8, sourceAdapter: adapter });
  const afterRetain = planForObservation(loadState(cwd), loadLatestSourceObservation(cwd), 3);
  assert.throws(() => amendPlan({ cwd, expectedRevision: 9, resultingPlan: afterRetain,
    amendment: amendment('reject-retain', 'retain-second') }), (error) => error.code === 'DECISION_REQUIRED');
  assert.equal(drift.phase, 'awaiting-decision');
});

test('pre-accept decisions fail without side effects and legacy evidence blocks acceptance', async () => {
  const { cwd, sha } = repository('decision state');
  const planning = await initializeState({ cwd, changeId: 'decision-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  assert.throws(() => recordDecision({ cwd, expectedRevision: 0, decision: {
    id: 'bad-decision', reason: '', authorization: 'operator', trigger: 'request', disposition: 'resolve',
  } }), (error) => error.code === 'INVALID_DECISION');
  writeFileSync(join(cwd, 'preaccept-dirty.txt'), 'dirty');
  const root = changeDirectory(cwd, planning.changeId);
  const stateBefore = readFileSync(join(root, 'state.json'), 'utf8');
  const eventsBefore = readFileSync(join(root, 'events.jsonl'), 'utf8');
  const transitionsBefore = [...readdirSync(join(root, 'transitions'))];
  assert.throws(() => recordDecision({ cwd, expectedRevision: 0, decision: {
    id: 'scope-decision', reason: 'Clarify scope.', authorization: 'operator', trigger: 'request', disposition: 'resolve',
  } }), (error) => error.code === 'INVALID_PHASE');
  assert.equal(existsSync(join(root, 'decisions')), false);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), stateBefore);
  assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), eventsBefore);
  assert.deepEqual(readdirSync(join(root, 'transitions')), transitionsBefore);
  assert.equal(loadState(cwd).revision, 0);
  unlinkSync(join(cwd, 'preaccept-dirty.txt'));

  const legacy = repository('legacy preaccept decision');
  const legacyPlanning = await initializeState({ cwd: legacy.cwd, changeId: 'legacy-preaccept-change', mode: 'plan-only',
    baseBranch: 'main', planningRef: legacy.sha, source: descriptor });
  installLegacyPreacceptDecision(legacy.cwd);
  assert.equal(validateState({ cwd: legacy.cwd }).valid, true);
  const legacyRoot = changeDirectory(legacy.cwd, legacyPlanning.changeId);
  const legacyStateBefore = readFileSync(join(legacyRoot, 'state.json'), 'utf8');
  const legacyEventsBefore = readFileSync(join(legacyRoot, 'events.jsonl'), 'utf8');
  assert.throws(() => acceptPlan({ cwd: legacy.cwd, expectedRevision: 1, plan: planFor(loadState(legacy.cwd)) }),
    (error) => error.code === 'PREACCEPT_DECISION_RECONCILIATION_REQUIRED'
      && /candidate plan decisions[\s\S]*prose reconciliation/u.test(error.message));
  assert.equal(existsSync(join(legacyRoot, 'plan')), false);
  assert.equal(readFileSync(join(legacyRoot, 'state.json'), 'utf8'), legacyStateBefore);
  assert.equal(readFileSync(join(legacyRoot, 'events.jsonl'), 'utf8'), legacyEventsBefore);
});

test('post-accept decision records enforce strict provenance and reject duplicate IDs', async () => {
  const { cwd, sha } = repository('postaccept decision state');
  await acceptedMaterialDrift(cwd, sha, 'postaccept-decision', 31);
  recordDecision({ cwd, expectedRevision: 2, decision: {
    id: 'scope-decision', reason: 'Incorporate source drift.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve',
  } });
  assert.throws(() => recordDecision({ cwd, expectedRevision: 3, decision: {
    id: 'scope-decision', reason: 'Repeat.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve',
  } }), (error) => error.code === 'DECISION_ID_CONFLICT');
});

test('recovery rejects an interrupted legacy planning-phase decision intent', async () => {
  const { cwd, sha } = repository('legacy preaccept recovery');
  const predecessor = await initializeState({ cwd, changeId: 'legacy-preaccept-recovery', mode: 'plan-only',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  installLegacyPreacceptDecision(cwd, 'legacy-interrupted');
  const root = changeDirectory(cwd, predecessor.changeId);
  const transition = join(root, 'transitions', '00000001');
  unlinkSync(join(transition, 'receipt.json'));
  unlinkSync(join(transition, 'receipt.sha256'));
  unlinkSync(join(transition, 'complete'));
  writeFileSync(join(root, 'state.json'), `${JSON.stringify(predecessor)}\n`);
  const initialEvent = readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n')[0];
  writeFileSync(join(root, 'events.jsonl'), `${initialEvent}\n`);

  const stateBefore = readFileSync(join(root, 'state.json'), 'utf8');
  const eventsBefore = readFileSync(join(root, 'events.jsonl'), 'utf8');
  assert.throws(() => recoverState({ cwd }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
      && /Interrupted decision transition is semantically inconsistent/u.test(error.message));
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), stateBefore);
  assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), eventsBefore);
  assert.equal(existsSync(join(transition, 'receipt.json')), false);
  assert.equal(existsSync(join(transition, 'complete')), false);
});

test('one pre-accept refresh rebases unambiguous stable additions removals text and moves', async () => {
  const { cwd, sha } = repository('stable checklist rebase');
  const issue = {
    id: 'I_stable', number: 8, title: 'Stable list',
    body: '- [ ] <!-- aerstello:item=keep-item --> Keep text\n- [ ] <!-- aerstello:item=remove-item --> Remove text', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
    comments: [], commentsComplete: true,
  };
  const adapter = { async readIssue() { return structuredClone(issue); } };
  await initializeState({ cwd, changeId: 'stable-rebase', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 8, relationshipIntent: 'resolves' }, sourceAdapter: adapter });
  issue.body = '- [ ] <!-- aerstello:item=added-item --> Added text\n- [x] <!-- aerstello:item=keep-item --> Updated keep text';
  issue.updatedAt = '2026-08-17T10:01:00Z';
  const refreshed = await refreshSource({ cwd, expectedRevision: 0, sourceAdapter: adapter });
  assert.equal(refreshed.phase, 'planning');
  assert.equal(refreshed.source.classification, 'unreviewed-material');
  assert.deepEqual(refreshed.checklist, [
    { id: 'added-item', checked: false, status: 'current', externalChange: false },
    { id: 'keep-item', checked: true, status: 'current', externalChange: false },
  ]);
  const observation = loadLatestSourceObservation(cwd);
  const ready = acceptPlan({ cwd, expectedRevision: 1, plan: planForObservation(refreshed, observation) });
  assert.equal(ready.phase, 'ready-to-implement');
});

test('legacy checklist drift remains ambiguous across refreshes and exact restoration clears it', async () => {
  const { cwd, sha } = repository('legacy refresh');
  const issue = {
    id: 'I_legacy', number: 7, title: 'Legacy list', body: '- [ ] First item\n- [ ] Second item', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
    comments: [], commentsComplete: true,
  };
  const adapter = { async readIssue() { return structuredClone(issue); } };
  await initializeState({ cwd, changeId: 'legacy-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 7, relationshipIntent: 'reference-only' }, sourceAdapter: adapter });
  issue.body = '- [ ] Second item\n- [ ] First item'; issue.updatedAt = '2026-08-17T10:01:00Z';
  const refreshed = await refreshSource({ cwd, expectedRevision: 0, sourceAdapter: adapter });
  assert.ok(refreshed.checklist.some((item) => item.status === 'ambiguous' && item.externalChange));
  assert.ok(refreshed.checklist.some((item) => item.status === 'removed'));
  const repeated = await refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter });
  assert.deepEqual(repeated.checklist, refreshed.checklist);
  assert.ok(repeated.checklist.some((item) => item.status === 'ambiguous' && item.externalChange));
  assert.ok(repeated.checklist.some((item) => item.status === 'removed' && item.externalChange));
  assert.throws(() => acceptPlan({ cwd, expectedRevision: 2,
    plan: planForObservation(repeated, loadLatestSourceObservation(cwd)) }),
  (error) => ['PLAN_NOT_READY', 'PLAN_CHECKLIST_MISMATCH'].includes(error.code));

  issue.body = '- [ ] First item\n- [ ] Second item'; issue.updatedAt = '2026-08-17T10:02:00Z';
  const restored = await refreshSource({ cwd, expectedRevision: 2, sourceAdapter: adapter });
  assert.equal(restored.checklist.length, 2);
  assert.ok(restored.checklist.every((item) => item.status === 'current' && item.externalChange === false));
  const ready = acceptPlan({ cwd, expectedRevision: 3,
    plan: planForObservation(restored, loadLatestSourceObservation(cwd)) });
  assert.equal(ready.phase, 'ready-to-implement');
});

test('lifecycle is a valid change ID isolated from the global lifecycle lock', async () => {
  const { cwd, sha } = repository('lifecycle lock namespace');
  const state = await initializeState({
    cwd, changeId: 'lifecycle', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor,
    lockOptions: { timeoutMs: 25 },
  });
  assert.equal(state.changeId, 'lifecycle');
  assert.equal(state.revision, 0);
  assert.equal(validateState({ cwd, changeId: 'lifecycle' }).valid, true);
});

test('every phase exposes one exact next action', () => {
  const state = { mode: 'plan-only', unresolvedDecisionIds: [] };
  const expected = new Map([
    ['initializing', /Complete source capture/u], ['planning', /Validate and accept/u],
    ['awaiting-decision', /Record a decision/u], ['ready-to-implement', /Archive/u],
    ['blocked', /Resolve the listed blocking evidence/u], ['recovering', /recover/u],
    ['abandoned', /Archive the explicitly abandoned/u],
  ]);
  for (const [phase, pattern] of expected) assert.match(nextActionFor({ ...state, phase }), pattern, phase);
  assert.match(nextActionFor({ ...state, phase: 'ready-to-implement', mode: 'full' }), /implementation capability/u);
});

test('bounded status preserves the exact next action', () => {
  const next = 'Next action: Run the exact recovery command.';
  const output = boundedStatus(['Change: bounded', `Unresolved: ${'decision-id,'.repeat(1000)}`, next]);
  assert.ok(output.length <= 2500);
  assert.ok(output.endsWith(next));
});

test('locks enforce contention and reclaim only stale dead ownership', async () => {
  const { cwd } = repository('lock state');
  assert.throws(() => withChangeLock(cwd, 'lock-change', () => withChangeLock(cwd, 'lock-change', () => {}, { timeoutMs: 10 })),
    (error) => error.code === 'LOCK_TIMEOUT');
  const path = join(changeRoot(cwd), 'locks', 'stale-change.lock');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ token: 'dead-token', pid: 2_147_483_647, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00Z' }));
  const past = new Date('2000-01-01T00:00:00Z'); utimesSync(path, past, past);
  let entered = false;
  withChangeLock(cwd, 'stale-change', () => { entered = true; }, { staleMs: 1, timeoutMs: 100 });
  assert.equal(entered, true);

  assert.throws(() => withIntegrationOperationLock(cwd, 'operation-change', () => (
    withIntegrationOperationLock(cwd, 'operation-change', () => {}, { timeoutMs: 10 })
  )), (error) => error.code === 'LOCK_TIMEOUT');
  const staleOperation = join(changeRoot(cwd), 'locks', 'operations', 'stale-operation.integration.lock');
  mkdirSync(staleOperation, { recursive: true });
  writeFileSync(join(staleOperation, 'owner.json'), JSON.stringify({
    token: 'dead-operation-token', pid: 2_147_483_647, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00Z',
  }));
  utimesSync(staleOperation, past, past);
  let operationEntered = false;
  withIntegrationOperationLock(cwd, 'stale-operation', () => { operationEntered = true; },
    { staleMs: 1, timeoutMs: 100 });
  assert.equal(operationEntered, true);

  const malformed = join(changeRoot(cwd), 'locks', 'malformed-change.lock');
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, 'owner.json'), '{');
  writeFileSync(join(malformed, '.owner.json.2147483647.00000000-0000-4000-8000-000000000000.tmp'), 'partial');
  utimesSync(malformed, past, past);
  withChangeLock(cwd, 'malformed-change', () => { entered = true; }, { staleMs: 1, timeoutMs: 100 });

  const liveTemporary = join(changeRoot(cwd), 'locks', 'live-temp-change.lock');
  mkdirSync(liveTemporary, { recursive: true });
  const liveName = `.owner.json.${process.pid}.00000000-0000-4000-8000-000000000001.tmp`;
  writeFileSync(join(liveTemporary, liveName), 'partial');
  utimesSync(liveTemporary, past, past);
  assert.throws(() => withChangeLock(cwd, 'live-temp-change', () => {}, { staleMs: 1, timeoutMs: 20 }),
    (error) => error.code === 'LOCK_TIMEOUT');
  assert.equal(existsSync(join(liveTemporary, liveName)), true);

  const unexpected = join(changeRoot(cwd), 'locks', 'unexpected-change.lock');
  mkdirSync(unexpected, { recursive: true });
  writeFileSync(join(unexpected, 'do-not-delete'), 'unknown');
  utimesSync(unexpected, past, past);
  assert.throws(() => withChangeLock(cwd, 'unexpected-change', () => {}, { staleMs: 1, timeoutMs: 20 }),
    (error) => error.code === 'LOCK_TIMEOUT');
  assert.equal(existsSync(join(unexpected, 'do-not-delete')), true);
});

test('each guarded crash boundary recovers, while conflicting state fails closed', async () => {
  for (const step of ['after-evidence', 'after-state', 'after-receipt', 'after-event']) {
    const { cwd, sha } = repository(`crash ${step}`);
    await assert.rejects(initializeState({ cwd, changeId: `crash-${step}`, mode: 'plan-only', baseBranch: 'main',
      planningRef: sha, source: descriptor, crashStep(current) { if (current === step) throw new Error(step); } }), new RegExp(step, 'u'));
    assert.match(renderStatus({ cwd }), /Phase: recovering[\s\S]*change:state recover/u);
    assert.equal(recoverState({ cwd, changeId: `crash-${step}` }).recovered, true);
    assert.equal(validateState({ cwd }).valid, true);
  }
  const { cwd, sha } = repository('crash conflict');
  await assert.rejects(initializeState({ cwd, changeId: 'crash-conflict', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: descriptor, crashStep(step) { if (step === 'after-state') throw new Error('conflict'); } }), /conflict/u);
  const path = join(changeDirectory(cwd, 'crash-conflict'), 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')); state.nextAction = 'tampered'; writeFileSync(path, JSON.stringify(state));
  assert.throws(() => recoverState({ cwd, changeId: 'crash-conflict' }), (error) => error.code === 'RECOVERY_STATE_CONFLICT');
});

test('transition intent atomically binds exact domain evidence for deterministic recovery', async () => {
  const before = repository('crash before intent');
  await assert.rejects(initializeState({ cwd: before.cwd, changeId: 'before-intent', mode: 'plan-only', baseBranch: 'main',
    planningRef: before.sha, source: descriptor, crashStep(step) { if (step === 'before-intent') throw new Error(step); } }), /before-intent/u);
  const beforeDirectory = changeDirectory(before.cwd, 'before-intent');
  assert.equal(existsSync(beforeDirectory), false);
  assert.equal(existsSync(join(beforeDirectory, 'source', 'initial.json')), false);
  assert.equal(existsSync(join(beforeDirectory, 'worktree.json')), false);
  assert.equal((await initializeState({ cwd: before.cwd, changeId: 'before-intent', mode: 'plan-only', baseBranch: 'main',
    planningRef: before.sha, source: descriptor })).revision, 0);

  const stagedBeforeCommit = repository('crash before intent commit');
  await assert.rejects(initializeState({ cwd: stagedBeforeCommit.cwd, changeId: 'before-intent-commit', mode: 'plan-only', baseBranch: 'main',
    planningRef: stagedBeforeCommit.sha, source: descriptor,
    crashStep(step) { if (step === 'before-intent-commit') throw new Error(step); } }), /before-intent-commit/u);
  assert.equal(existsSync(changeDirectory(stagedBeforeCommit.cwd, 'before-intent-commit')), true);
  assert.equal(recoverState({ cwd: stagedBeforeCommit.cwd, changeId: 'before-intent-commit' }).rolledBack, true);
  assert.equal(existsSync(changeDirectory(stagedBeforeCommit.cwd, 'before-intent-commit')), false);

  const initialization = repository('crash after init intent');
  await assert.rejects(initializeState({ cwd: initialization.cwd, changeId: 'after-init-intent', mode: 'plan-only', baseBranch: 'main',
    planningRef: initialization.sha, source: descriptor, crashStep(step) { if (step === 'after-intent') throw new Error(step); } }), /after-intent/u);
  const initializationDirectory = changeDirectory(initialization.cwd, 'after-init-intent');
  assert.equal(existsSync(join(initializationDirectory, 'transitions', '00000000', 'intent.json')), true);
  assert.equal(existsSync(join(initializationDirectory, 'source', 'initial.json')), false);
  assert.equal(existsSync(join(initializationDirectory, 'worktree.json')), false);
  assert.equal(recoverState({ cwd: initialization.cwd, changeId: 'after-init-intent' }).recovered, true);
  assert.equal(validateState({ cwd: initialization.cwd }).valid, true);
  assert.equal(existsSync(join(initializationDirectory, 'source', 'initial.sha256')), true);

  const acceptance = repository('crash after plan intent');
  const planning = await initializeState({ cwd: acceptance.cwd, changeId: 'after-plan-intent', mode: 'plan-only', baseBranch: 'main',
    planningRef: acceptance.sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd: acceptance.cwd, plan: planFor(planning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-intent') throw new Error(step); } }), /after-intent/u);
  const acceptanceDirectory = changeDirectory(acceptance.cwd, 'after-plan-intent');
  assert.equal(existsSync(join(acceptanceDirectory, 'plan', 'plan.json')), false);
  assert.equal(existsSync(join(acceptanceDirectory, 'plan', 'planning-evidence.json')), false);
  assert.equal(recoverState({ cwd: acceptance.cwd }).recovered, true);
  assert.equal(validateState({ cwd: acceptance.cwd }).valid, true);

  const partial = repository('crash inside plan evidence');
  const partialPlanning = await initializeState({ cwd: partial.cwd, changeId: 'partial-plan-evidence', mode: 'plan-only', baseBranch: 'main',
    planningRef: partial.sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd: partial.cwd, plan: planFor(partialPlanning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-evidence-json') throw new Error(step); } }), /after-evidence-json/u);
  const partialPlan = join(changeDirectory(partial.cwd, 'partial-plan-evidence'), 'plan', 'plan.json');
  assert.equal(existsSync(partialPlan), true);
  assert.equal(existsSync(partialPlan.replace(/\.json$/u, '.sha256')), false);
  assert.equal(recoverState({ cwd: partial.cwd }).recovered, true);
  assert.equal(validateState({ cwd: partial.cwd }).valid, true);

  const recoverable = repository('crash after plan evidence');
  const recoverablePlanning = await initializeState({ cwd: recoverable.cwd, changeId: 'after-plan-evidence', mode: 'plan-only', baseBranch: 'main',
    planningRef: recoverable.sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd: recoverable.cwd, plan: planFor(recoverablePlanning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-evidence') throw new Error(step); } }), /after-evidence/u);
  assert.equal(existsSync(join(changeDirectory(recoverable.cwd, 'after-plan-evidence'), 'plan', 'plan.json')), true);
  assert.equal(recoverState({ cwd: recoverable.cwd }).recovered, true);
  assert.equal(validateState({ cwd: recoverable.cwd }).valid, true);

  const tampered = repository('tampered partial plan evidence');
  const tamperedPlanning = await initializeState({ cwd: tampered.cwd, changeId: 'tampered-plan-evidence', mode: 'plan-only', baseBranch: 'main',
    planningRef: tampered.sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd: tampered.cwd, plan: planFor(tamperedPlanning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-evidence-json') throw new Error(step); } }), /after-evidence-json/u);
  const tamperedPlan = join(changeDirectory(tampered.cwd, 'tampered-plan-evidence'), 'plan', 'plan.json');
  const changed = JSON.parse(readFileSync(tamperedPlan, 'utf8')); changed.title = 'tampered'; writeFileSync(tamperedPlan, JSON.stringify(changed));
  assert.throws(() => recoverState({ cwd: tampered.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');

  const escaped = repository('out of domain intent evidence');
  const escapedPlanning = await initializeState({ cwd: escaped.cwd, changeId: 'escaped-evidence', mode: 'plan-only', baseBranch: 'main',
    planningRef: escaped.sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd: escaped.cwd, plan: planFor(escapedPlanning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-intent') throw new Error(step); } }), /after-intent/u);
  const escapedIntentPath = join(changeDirectory(escaped.cwd, 'escaped-evidence'), 'transitions', '00000001', 'intent.json');
  const escapedIntent = JSON.parse(readFileSync(escapedIntentPath, 'utf8'));
  escapedIntent.evidencePaths.planDigest = 'outside.json';
  escapedIntent.authoritativeEvidence.planDigest.path = 'outside.json';
  writeFileSync(escapedIntentPath, `${JSON.stringify(escapedIntent)}\n`);
  writeFileSync(escapedIntentPath.replace(/\.json$/u, '.sha256'), `${digestJson(escapedIntent)}\n`);
  assert.throws(() => recoverState({ cwd: escaped.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.equal(existsSync(join(changeDirectory(escaped.cwd, 'escaped-evidence'), 'outside.json')), false);
});

test('receipt and event crash boundaries recover only their canonical intent-derived records', async () => {
  const receiptRepository = repository('partial transition receipt');
  await assert.rejects(initializeState({ cwd: receiptRepository.cwd, changeId: 'partial-receipt', mode: 'plan-only', baseBranch: 'main',
    planningRef: receiptRepository.sha, source: descriptor,
    crashStep(step) { if (step === 'after-receipt-json') throw new Error(step); } }), /after-receipt-json/u);
  const receiptDirectory = join(changeDirectory(receiptRepository.cwd, 'partial-receipt'), 'transitions', '00000000');
  assert.equal(existsSync(join(receiptDirectory, 'receipt.json')), true);
  assert.equal(existsSync(join(receiptDirectory, 'receipt.sha256')), false);
  assert.equal(recoverState({ cwd: receiptRepository.cwd }).recovered, true);
  assert.equal(validateState({ cwd: receiptRepository.cwd }).valid, true);

  const eventRepository = repository('atomic transition event');
  await assert.rejects(initializeState({ cwd: eventRepository.cwd, changeId: 'atomic-event', mode: 'plan-only', baseBranch: 'main',
    planningRef: eventRepository.sha, source: descriptor,
    crashStep(step) { if (step === 'before-event-commit') throw new Error(step); } }), /before-event-commit/u);
  const eventDirectory = changeDirectory(eventRepository.cwd, 'atomic-event');
  assert.equal(existsSync(join(eventDirectory, 'events.jsonl')), false);
  writeFileSync(join(eventDirectory, '.events.jsonl.2147483647.00000000-0000-4000-8000-000000000004.tmp'), '{partial');
  assert.equal(recoverState({ cwd: eventRepository.cwd }).recovered, true);
  assert.deepEqual(readFileSync(join(eventDirectory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map((event) => event.revision), [0]);
  assert.equal(validateState({ cwd: eventRepository.cwd }).valid, true);
});

test('pointerless uncommitted transition staging and empty shells roll back safely', async () => {
  const staged = repository('pointerless staging');
  const stagedTransitions = join(changeDirectory(staged.cwd, 'staged-change'), 'transitions');
  const staging = join(stagedTransitions, '.00000000.2147483647.00000000-0000-4000-8000-000000000005.pending');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, '.intent.json.2147483647.00000000-0000-4000-8000-000000000006.tmp'), '{partial');
  assert.match(renderStatus({ cwd: staged.cwd }), /Phase: recovering[\s\S]*change:state recover/u);
  const stagedRecovery = recoverState({ cwd: staged.cwd });
  assert.equal(stagedRecovery.rolledBack, true);
  assert.equal(existsSync(changeDirectory(staged.cwd, 'staged-change')), false);

  const empty = repository('pointerless empty transition shell');
  mkdirSync(join(changeDirectory(empty.cwd, 'empty-change'), 'transitions'), { recursive: true });
  assert.match(renderStatus({ cwd: empty.cwd }), /Phase: recovering[\s\S]*change:state recover/u);
  const emptyRecovery = recoverState({ cwd: empty.cwd });
  assert.equal(emptyRecovery.rolledBack, true);
  assert.equal(existsSync(changeDirectory(empty.cwd, 'empty-change')), false);

  const emptyDirectory = repository('pointerless empty change directory');
  mkdirSync(changeDirectory(emptyDirectory.cwd, 'empty-directory'), { recursive: true });
  assert.match(renderStatus({ cwd: emptyDirectory.cwd }), /Phase: recovering[\s\S]*change:state recover/u);
  const emptyDirectoryRecovery = recoverState({ cwd: emptyDirectory.cwd });
  assert.equal(emptyDirectoryRecovery.rolledBack, true);
  assert.equal(existsSync(changeDirectory(emptyDirectory.cwd, 'empty-directory')), false);

  const later = repository('later revision staging');
  await initializeState({ cwd: later.cwd, changeId: 'later-staging', mode: 'plan-only', baseBranch: 'main', planningRef: later.sha, source: descriptor });
  mkdirSync(join(changeDirectory(later.cwd, 'later-staging'), 'transitions',
    '.00000001.2147483647.00000000-0000-4000-8000-000000000007.pending'));
  assert.throws(() => validateState({ cwd: later.cwd }), (error) => error.code === 'RECOVERY_REQUIRED');
  assert.match(renderStatus({ cwd: later.cwd }), /Phase: recovering[\s\S]*change:state recover/u);
  const laterRecovery = recoverState({ cwd: later.cwd });
  assert.equal(laterRecovery.recovered, true);
  assert.equal(laterRecovery.rolledBack, true);
  assert.equal(validateState({ cwd: later.cwd }).valid, true);
});

test('invalid atomic archive lifecycle envelopes fail closed for initialization, status, and recovery', async () => {
  const { cwd, sha } = repository('archive intent pair');
  mkdirSync(changeRoot(cwd), { recursive: true });
  writeFileSync(join(changeRoot(cwd), 'archive-lifecycle.json'), `${JSON.stringify({ schemaVersion: 1, intent: { changeId: 'orphan' }, intentDigest: 'wrong' })}\n`);
  await assert.rejects(initializeState({ cwd, changeId: 'blocked-init', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor }),
    (error) => error.code === 'ARCHIVE_CONFLICT');
  assert.throws(() => renderStatus({ cwd }), (error) => error.code === 'ARCHIVE_CONFLICT');
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'ARCHIVE_CONFLICT');
});

test('recovery rejects tampered predecessor events and semantically mismatched receipts', async () => {
  const { cwd, sha } = repository('recovery chain');
  const planning = await initializeState({ cwd, changeId: 'recovery-chain', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  assert.throws(() => acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0,
    crashStep(step) { if (step === 'after-state') throw new Error('accept crash'); } }), /accept crash/u);
  const eventsPath = join(changeDirectory(cwd, 'recovery-chain'), 'events.jsonl');
  const event = JSON.parse(readFileSync(eventsPath, 'utf8')); event.type = 'tampered'; writeFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');

  const other = repository('receipt semantics');
  await initializeState({ cwd: other.cwd, changeId: 'receipt-semantics', mode: 'plan-only', baseBranch: 'main', planningRef: other.sha, source: descriptor });
  const receiptPath = join(changeDirectory(other.cwd, 'receipt-semantics'), 'transitions', '00000000', 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.revision = 9;
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  writeFileSync(receiptPath.replace(/\.json$/u, '.sha256'), `${digestJson(receipt)}\n`);
  assert.throws(() => validateState({ cwd: other.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  writeFileSync(join(changeDirectory(other.cwd, 'receipt-semantics'), 'transitions', 'junk'), 'orphan');
  assert.throws(() => validateState({ cwd: other.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.throws(() => recoverState({ cwd: other.cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
});

test('validateState reports branch-only Git drift at the same clean commit', async () => {
  const { cwd, sha } = repository('branch drift');
  const state = await initializeState({ cwd, changeId: 'branch-drift', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  assert.equal(state.git.branch, 'main');
  git(cwd, 'switch', '-c', 'same-commit-branch');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), state.git.headSha);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
  const validation = validateState({ cwd });
  assert.equal(validation.git.branch, 'same-commit-branch');
  assert.equal(validation.gitDrift, true);
});

test('detached HEAD observations remain schema-valid', async () => {
  const { cwd, sha } = repository('detached state');
  git(cwd, 'checkout', '--detach', sha);
  const state = await initializeState({ cwd, changeId: 'detached-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  assert.equal(state.git.branch, '(detached)');
  assert.equal(validateState({ cwd }).valid, true);
});

test('interrupted resolve decisions recover only at their exact initiating Git observation', async () => {
  const cases = [
    ['dirty-planning-head', ({ cwd }) => writeFileSync(join(cwd, 'dirty-decision.txt'), 'dirty')],
    ['advanced-branch', ({ cwd }) => {
      git(cwd, 'switch', '-c', 'decision-branch');
      writeFileSync(join(cwd, 'decision-commit.txt'), 'advanced');
      git(cwd, 'add', 'decision-commit.txt');
      git(cwd, 'commit', '-m', 'test: advance decision head');
    }],
    ['detached-head', ({ cwd, sha }) => git(cwd, 'checkout', '--detach', sha)],
  ];
  for (const [index, [label, prepare]] of cases.entries()) {
    const fixture = repository(`decision recovery ${label}`);
    await acceptedMaterialDrift(fixture.cwd, fixture.sha, `decision-${label}`, 40 + index);
    prepare(fixture);
    const expected = {
      headSha: git(fixture.cwd, 'rev-parse', 'HEAD'),
      branch: git(fixture.cwd, 'branch', '--show-current') || '(detached)',
      clean: git(fixture.cwd, 'status', '--porcelain') === '',
    };
    assert.throws(() => recordDecision({ cwd: fixture.cwd, expectedRevision: 2,
      decision: { id: `resolve-${label}`, reason: 'Bind the initiating Git observation.', authorization: 'operator',
        trigger: 'source-refresh', disposition: 'resolve' },
      crashStep(step) { if (step === 'after-state') throw new Error('decision crash'); },
    }), /decision crash/u);
    const interrupted = loadState(fixture.cwd);
    assert.deepEqual({ headSha: interrupted.git.headSha, branch: interrupted.git.branch, clean: interrupted.git.clean }, expected);
    const recovered = recoverState({ cwd: fixture.cwd });
    assert.deepEqual({ headSha: recovered.state.git.headSha, branch: recovered.state.git.branch, clean: recovered.state.git.clean }, expected);
    assert.equal(recovered.state.revision, 3);
  }
});

test('decision recovery rejects HEAD branch and cleanliness drift from the recorded observation', async () => {
  const cases = [
    ['head', ({ cwd }) => {
      writeFileSync(join(cwd, 'later-head.txt'), 'later');
      git(cwd, 'add', 'later-head.txt');
      git(cwd, 'commit', '-m', 'test: move after decision');
    }],
    ['branch', ({ cwd }) => git(cwd, 'switch', '-c', 'after-decision')],
    ['cleanliness', ({ cwd }) => writeFileSync(join(cwd, 'later-dirty.txt'), 'dirty')],
  ];
  for (const [index, [label, drift]] of cases.entries()) {
    const fixture = repository(`decision mismatch ${label}`);
    await acceptedMaterialDrift(fixture.cwd, fixture.sha, `decision-mismatch-${label}`, 50 + index);
    assert.throws(() => recordDecision({ cwd: fixture.cwd, expectedRevision: 2,
      decision: { id: `resolve-mismatch-${label}`, reason: 'Record before drift.', authorization: 'operator',
        trigger: 'source-refresh', disposition: 'resolve' },
      crashStep(step) { if (step === 'after-state') throw new Error('decision crash'); },
    }), /decision crash/u);
    drift(fixture);
    assert.throws(() => recoverState({ cwd: fixture.cwd }),
      (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
  }
});

test('relabeled transition intent cannot claim decision-observation recovery', async () => {
  const { cwd, sha } = repository('relabeled decision recovery');
  await acceptedMaterialDrift(cwd, sha, 'relabeled-decision', 60);
  writeFileSync(join(cwd, 'decision-dirty.txt'), 'dirty');
  assert.throws(() => recordDecision({ cwd, expectedRevision: 2,
    decision: { id: 'resolve-relabeled', reason: 'Record dirty state.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve' },
    crashStep(step) { if (step === 'after-state') throw new Error('decision crash'); },
  }), /decision crash/u);
  const intentPath = join(changeDirectory(cwd, 'relabeled-decision'), 'transitions', '00000003', 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.type = 'git-checkpoint';
  intent.summary = 'Checkpointed local Git observation before compaction';
  writeFileSync(intentPath, `${JSON.stringify(intent)}\n`);
  writeFileSync(intentPath.replace(/\.json$/u, '.sha256'), `${digestJson(intent)}\n`);
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
});

test('retain-plan recovery still requires clean HEAD at the Planning SHA', async () => {
  const { cwd, sha } = repository('retain recovery');
  const issue = {
    id: 'I_retain', number: 25, title: 'Retain recovery',
    body: '- [ ] <!-- aerstello:item=durable-state --> State remains durable', state: 'OPEN',
    author: { login: 'operator', id: 'U_test' }, createdAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T10:00:00Z',
    comments: [], commentsComplete: true,
  };
  const adapter = { async readIssue() { return structuredClone(issue); } };
  const planning = await initializeState({ cwd, changeId: 'retain-recovery', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 25, relationshipIntent: 'resolves' }, sourceAdapter: adapter });
  acceptPlan({ cwd, expectedRevision: 0, plan: planFor(planning) });
  issue.body += '\n\nMaterial change.'; issue.updatedAt = '2026-08-17T10:01:00Z';
  await refreshSource({ cwd, expectedRevision: 1, sourceAdapter: adapter });
  assert.throws(() => recordDecision({ cwd, expectedRevision: 2,
    decision: { id: 'retain-interrupted', reason: 'The accepted plan remains sufficient.', authorization: 'operator',
      trigger: 'source-refresh', disposition: 'retain-plan' },
    crashStep(step) { if (step === 'after-state') throw new Error('retain crash'); },
  }), /retain crash/u);
  writeFileSync(join(cwd, 'post-retain-dirty.txt'), 'dirty');
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
});

test('an interrupted Git checkpoint recovers against its exact recorded dirty observation', async () => {
  const { cwd, sha } = repository('checkpoint crash');
  await initializeState({ cwd, changeId: 'checkpoint-crash', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  writeFileSync(join(cwd, 'dirty.txt'), 'drift');
  assert.throws(() => checkpointGitMetadata({ cwd, crashStep(step) { if (step === 'after-state') throw new Error('checkpoint crash'); } }), /checkpoint crash/u);
  assert.match(renderStatus({ cwd }), /Phase: recovering/u);
  const recovered = recoverState({ cwd });
  assert.equal(recovered.state.phase, 'blocked');
  assert.equal(recovered.state.git.clean, false);
});

test('a mislabeled unrelated transition cannot use dirty abandonment recovery', async () => {
  const { cwd, sha } = repository('mislabeled abandonment');
  await initializeState({ cwd, changeId: 'mislabeled-abandonment', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  writeFileSync(join(cwd, 'dirty.txt'), 'drift');
  assert.throws(() => checkpointGitMetadata({ cwd,
    crashStep(step) { if (step === 'after-state') throw new Error('checkpoint crash'); } }), /checkpoint crash/u);
  const intentPath = join(changeDirectory(cwd, 'mislabeled-abandonment'), 'transitions', '00000001', 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.type = 'abandoned';
  writeFileSync(intentPath, `${JSON.stringify(intent)}\n`);
  writeFileSync(intentPath.replace(/\.json$/u, '.sha256'), `${digestJson(intent)}\n`);
  assert.throws(() => recoverState({ cwd }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
});

test('abandonment recovery binds exact dirty and non-Planning Git observations', async () => {
  const dirty = repository('dirty abandonment');
  await initializeState({ cwd: dirty.cwd, changeId: 'dirty-abandonment', mode: 'plan-only', baseBranch: 'main', planningRef: dirty.sha, source: descriptor });
  writeFileSync(join(dirty.cwd, 'dirty.txt'), 'dirty');
  assert.throws(() => archiveState({ cwd: dirty.cwd, expectedRevision: 0, abandonReason: 'Operator stopped planning.',
    crashStep(step) { if (step === 'after-state') throw new Error('abandonment crash'); } }), /abandonment crash/u);
  const interrupted = loadState(dirty.cwd);
  assert.equal(interrupted.phase, 'abandoned');
  assert.equal(interrupted.git.clean, false);
  const recovered = recoverState({ cwd: dirty.cwd });
  assert.equal(recovered.state.phase, 'abandoned');
  const archived = archiveState({ cwd: dirty.cwd, expectedRevision: 1 });
  assert.equal(archived.archived, true);
  assert.equal(archived.state.revision, 1);

  const advanced = repository('advanced abandonment');
  await initializeState({ cwd: advanced.cwd, changeId: 'advanced-abandonment', mode: 'plan-only', baseBranch: 'main', planningRef: advanced.sha, source: descriptor });
  writeFileSync(join(advanced.cwd, 'advance.txt'), 'advance');
  git(advanced.cwd, 'add', 'advance.txt');
  git(advanced.cwd, 'commit', '-m', 'test: advance from planning sha');
  const advancedHead = git(advanced.cwd, 'rev-parse', 'HEAD');
  assert.throws(() => archiveState({ cwd: advanced.cwd, expectedRevision: 0, abandonReason: 'Planning was superseded.',
    crashStep(step) { if (step === 'after-state') throw new Error('advanced abandonment crash'); } }), /advanced abandonment crash/u);
  assert.equal(loadState(advanced.cwd).git.headSha, advancedHead);
  assert.equal(recoverState({ cwd: advanced.cwd }).state.phase, 'abandoned');

  const drifted = repository('drifted abandonment');
  await initializeState({ cwd: drifted.cwd, changeId: 'drifted-abandonment', mode: 'plan-only', baseBranch: 'main', planningRef: drifted.sha, source: descriptor });
  writeFileSync(join(drifted.cwd, 'dirty.txt'), 'dirty');
  assert.throws(() => archiveState({ cwd: drifted.cwd, expectedRevision: 0, abandonReason: 'Stop after drift.',
    crashStep(step) { if (step === 'after-state') throw new Error('drift abandonment crash'); } }), /drift abandonment crash/u);
  git(drifted.cwd, 'switch', '-c', 'later-drift');
  assert.throws(() => recoverState({ cwd: drifted.cwd }), (error) => error.code === 'PLANNING_SNAPSHOT_MISMATCH');
});

test('archive resumes exactly after the directory rename boundary', async () => {
  const { cwd, sha } = repository('archive crash');
  const planning = await initializeState({ cwd, changeId: 'archive-crash', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  acceptPlan({ cwd, plan: planFor(planning), expectedRevision: 0 });
  assert.throws(() => archiveState({ cwd, expectedRevision: 1,
    crashStep(step) { if (step === 'archive-after-rename') throw new Error('archive crash'); } }), /archive crash/u);
  const envelope = JSON.parse(readFileSync(join(changeRoot(cwd), 'archive-lifecycle.json'), 'utf8'));
  const receipt = { schemaVersion: 1, intentDigest: digestJson(envelope.intent), changeId: envelope.intent.changeId,
    stateDigest: envelope.intent.stateDigest, archivedAt: envelope.intent.archivedAt };
  writeFileSync(join(archiveDirectory(cwd, 'archive-crash'), 'archive-receipt.json'), `${JSON.stringify(receipt)}\n`);
  await assert.rejects(initializeState({ cwd, changeId: 'new-during-archive', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor }),
    (error) => error.code === 'LIFECYCLE_RECOVERY_REQUIRED');
  const recovered = recoverState({ cwd });
  assert.equal(recovered.archived, true);
  assert.equal(loadState(cwd), null);
  assert.equal(existsSync(join(archiveDirectory(cwd, 'archive-crash'), 'archive-receipt.sha256')), true);
  assert.equal(existsSync(join(changeRoot(cwd), 'archive-lifecycle.json')), false);
});

test('CLI rejects command-irrelevant options as usage errors', () => {
  const { cwd } = repository('cli options');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'status', '--plan', 'irrelevant.json'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /status does not accept --plan/u);
});

test('CLI state-free candidate validation never claims receipt-bound readiness', () => {
  const { cwd, sha } = repository('cli state free');
  const candidateState = {
    changeId: 'state-free-candidate', planningSha: sha, baseBranch: 'main', expectedPrBaseBranch: 'main',
    source: {
      kind: 'direct-request', reference: 'request.md', relationship: 'reference-only',
      latestDigest: `sha256:${'a'.repeat(64)}`,
    },
    checklist: [{ id: 'durable-state', checked: false, status: 'current', externalChange: false }],
  };
  const planPath = join(cwd, 'state-free-plan.json');
  writeFileSync(planPath, `${JSON.stringify(planFor(candidateState))}\n`);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'validate', '--plan', planPath], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.activeState, null);
  assert.equal(output.valid, false);
  assert.equal(output.readiness.ready, false);
  assert.ok(output.errors.includes('An active durable state is required to validate plan identity.'));
  assert.ok(output.readiness.errors.includes('An active durable state is required to validate plan identity.'));
});

test('CLI candidate-plan validation fails closed on corrupt durable event evidence', async () => {
  const { cwd, sha } = repository('cli durable corruption');
  const planning = await initializeState({ cwd, changeId: 'cli-durable-corruption', mode: 'plan-only',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const planPath = join(cwd, 'candidate-plan.json');
  writeFileSync(planPath, `${JSON.stringify(planFor(planning))}\n`);
  const eventsPath = join(changeDirectory(cwd, planning.changeId), 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  events[0].summary = 'Tampered durable lifecycle event';
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'validate', '--plan', planPath], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', 'corrupt durable state must not emit positive candidate validation JSON');
  assert.match(result.stderr, /^RECOVERY_EVIDENCE_INVALID:/u);
});

test('CLI plan validation rejects every active-state identity mismatch and accepts a matching control', async () => {
  const { cwd, sha } = repository('cli identity validation');
  const planning = await initializeState({ cwd, changeId: 'cli-identity', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const cases = [
    ['change-id', (plan) => { plan.changeId = 'another-change'; }],
    ['planning-sha', (plan) => { plan.planning.planningSha = 'f'.repeat(40); }],
    ['base-branch', (plan) => { plan.planning.baseBranch = 'develop'; }],
    ['expected-pr-base', (plan) => { plan.expectedPrBaseBranch = 'release'; }],
    ['source-kind', (plan) => { plan.source.kind = 'repository-plan'; }],
    ['source-reference', (plan) => { plan.source.reference = 'another-request.md'; }],
    ['source-relationship', (plan) => {
      plan.source.relationship = 'partial';
      for (const mapping of plan.checklistMappings) mapping.relationship = 'partial';
    }],
    ['source-capture', (plan) => { plan.source.captureDigest = `sha256:${'f'.repeat(64)}`; }],
  ];
  const run = (label, plan) => {
    const path = join(cwd, `${label}.json`);
    writeFileSync(path, `${JSON.stringify(plan)}\n`);
    return spawnSync(process.execPath, [cli, 'validate', '--plan', path], { cwd, encoding: 'utf8' });
  };
  const control = run('matching-control', planFor(planning));
  assert.equal(control.status, 0, control.stderr);
  assert.equal(JSON.parse(control.stdout).readiness.ready, true);
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(planFor(planning));
    mutate(candidate);
    const result = run(label, candidate);
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.valid, false, label);
    assert.equal(output.readiness.ready, false, label);
    assert.ok(output.errors.some((error) => /does not match active state/u.test(error)), label);
  }
});

test('CLI plan validation reads scenarios from the immutable Planning SHA', async () => {
  const { cwd, sha } = repository('cli planning reader');
  const planning = await initializeState({ cwd, changeId: 'cli-planning-reader', mode: 'plan-only', baseBranch: 'main', planningRef: sha, source: descriptor });
  const planPath = join(cwd, 'candidate-plan.json');
  writeFileSync(planPath, `${JSON.stringify(scenarioPlanFor(planning))}\n`);
  writeFileSync(join(cwd, 'specs', 'features', 'state.feature'), 'Feature: Mutable worktree\n\n  Scenario: Different mutable scenario\n');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'validate', '--plan', planPath], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.readiness.ready, true);
});
