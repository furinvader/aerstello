import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readGithubIssue } from '../source/github.mjs';
import { refreshSource as captureSourceRefresh } from '../source/source.mjs';

import {
  acceptPlan,
  acceptResult,
  activePointerPath,
  amendPlan,
  archiveState,
  authorizeRepeatedFinding,
  boundedStatus,
  bindTask,
  boundVerifierEvidence,
  buildVerifierContext,
  changeDirectory,
  checkpointGitMetadata,
  createSpecialistPlan,
  createValidationPlan,
  finalizeDevelopment,
  finalizeIntegration,
  initializeState,
  integrateTask,
  loadLatestSourceObservation,
  loadState,
  locateState,
  mergeLifecycleValidationCommands,
  nextActionFor,
  preflightVerifierCapacity,
  preflightStateVerifierCapacity,
  recoverState,
  recordDecision,
  recordFindingDisposition,
  recordSpecialistResult,
  recordVerifierResult,
  refreshSource,
  renderStatus,
  reconcileIntegration,
  rejectTask,
  runValidation,
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
  assert.equal(tasksConflict(task(['.agents']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['.codex']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['.github']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['apps/api/migrations']), task(['apps/web/src/b.ts'])), true);
  for (const lookalike of ['.agentsx', '.codex-notes', '.githubish', 'apps/api/migrations-old']) {
    assert.equal(tasksConflict(task([lookalike]), task(['apps/web/src/b.ts'])), false, `${lookalike} is not a shared root`);
  }
  assert.equal(tasksConflict(task(['package-lock.json']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['apps/web/package.json']), task(['apps/api/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['packages/shared/package-lock.json']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['tests/e2e/venue.steps.ts']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['tests/e2e/steps/catalog/venue.steps.ts']), task(['apps/web/src/b.ts'])), true);
  assert.equal(tasksConflict(task(['apps/web/src/a.ts'], ['catalog']), task(['apps/api/src/b.ts'], ['catalog'])), true);
  assert.equal(tasksConflict(task(['apps/web/src'], ['catalog']), task(['apps/web/src/file.ts'], [], ['catalog'])), true);
});

test('cross-plan validation merge rejects conflicting metadata for identical argv', () => {
  const command = { id: 'command-shared', kind: 'unit', argv: ['npm', 'run', 'check:workflow'],
    reasons: ['first'], taskIds: ['first-task'], selectors: [], projects: [] };
  const merged = mergeLifecycleValidationCommands([{ commands: [command] }, { commands: [{ ...command,
    reasons: ['second'], taskIds: ['second-task'] }] }]);
  assert.deepEqual(merged[0].reasons, ['first', 'second']);
  assert.deepEqual(merged[0].taskIds, ['first-task', 'second-task']);
  for (const conflicting of [
    { ...command, kind: 'system' },
    { ...command, selectors: ['@changed'] },
    { ...command, projects: ['chromium'] },
  ]) assert.throws(() => mergeLifecycleValidationCommands([{ commands: [command] }, { commands: [conflicting] }]),
    (error) => error.code === 'VALIDATION_COMMAND_CONFLICT');
});

test('binding rejects command-kind conflicts before packet evidence or revision mutation', async () => {
  const area = repository('packet area command conflict');
  const areaPlanning = await initializeState({ cwd: area.cwd, changeId: 'packet-area-conflict', mode: 'implement',
    baseBranch: 'main', planningRef: area.sha, source: descriptor });
  const areaPlan = planFor(areaPlanning);
  let areaState = acceptPlan({ cwd: area.cwd, plan: areaPlan, expectedRevision: areaPlanning.revision });
  const areaPacket = packetFor(areaState, areaPlan, 'state-task');
  areaPacket.requiredValidation = { unit: [], system: [{ command: 'npm run check:workflow', reason: 'Conflicts with workflow area.',
    selectors: [], projects: [] }] };
  const areaBefore = readFileSync(join(changeDirectory(area.cwd, areaState.changeId), 'state.json'), 'utf8');
  assert.throws(() => bindTask({ cwd: area.cwd, packet: areaPacket, expectedRevision: areaState.revision }),
    (error) => error.code === 'VALIDATION_COMMAND_CONFLICT');
  assert.equal(readFileSync(join(changeDirectory(area.cwd, areaState.changeId), 'state.json'), 'utf8'), areaBefore);
  assert.equal(existsSync(join(changeDirectory(area.cwd, areaState.changeId), 'implementation')), false);

  const historical = repository('terminal packet command conflict');
  const historicalPlanning = await initializeState({ cwd: historical.cwd, changeId: 'terminal-packet-conflict', mode: 'implement',
    baseBranch: 'main', planningRef: historical.sha, source: descriptor });
  const historicalPlan = executionPlanFor(historicalPlanning);
  historicalPlan.tasks[1].dependsOn = ['state-task'];
  let state = acceptPlan({ cwd: historical.cwd, plan: historicalPlan, expectedRevision: historicalPlanning.revision });
  const firstPacket = packetFor(state, historicalPlan, 'state-task');
  state = bindTask({ cwd: historical.cwd, packet: firstPacket, expectedRevision: state.revision });
  const worker = createWorkerFixture(historical.cwd, state, firstPacket);
  state = scheduleWave({ cwd: historical.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: historical.cwd, taskId: firstPacket.taskId, workerId: 'historical-worker', expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'first.txt'), 'first\n'); git(worker.path, 'add', 'first.txt');
  git(worker.path, 'commit', '-m', 'test: historical packet');
  state = acceptResult({ cwd: historical.cwd,
    result: resultFor(firstPacket, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']),
    workerCwd: worker.path, expectedRevision: state.revision });
  state = integrateTask({ cwd: historical.cwd, taskId: firstPacket.taskId, expectedRevision: state.revision });
  const secondPacket = packetFor(state, historicalPlan, 'second-task');
  secondPacket.requiredValidation = { unit: [], system: [{ ...firstPacket.requiredValidation.unit[0], selectors: [], projects: [] }] };
  const before = readFileSync(join(changeDirectory(historical.cwd, state.changeId), 'state.json'), 'utf8');
  assert.throws(() => bindTask({ cwd: historical.cwd, packet: secondPacket, expectedRevision: state.revision }),
    (error) => error.code === 'VALIDATION_COMMAND_CONFLICT');
  assert.equal(readFileSync(join(changeDirectory(historical.cwd, state.changeId), 'state.json'), 'utf8'), before);
  assert.equal(existsSync(join(changeDirectory(historical.cwd, state.changeId), 'implementation', 'tasks', 'second-task')), false);
});

test('verifier evidence remains deterministic and schema-bounded at the upper limit', () => {
  const evidence = Array.from({ length: 40 }, (_, index) => ({ kind: index % 2 ? 'criterion' : 'decision',
    id: `item-${index}`, digest: `sha256:${String(index).padStart(64, '0')}`, summary: `${'semantic '.repeat(100)}${index}` }));
  const first = boundVerifierEvidence(evidence);
  const second = boundVerifierEvidence(evidence);
  assert.deepEqual(first, second);
  assert.ok(first.length <= 500);
  assert.ok(first.every(({ summary }) => Buffer.byteLength(summary, 'utf8') <= 1800));
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') < 256 * 1024);
  const requiredSemantics = [
    ['criterion', 'original-plan-objective', `Original objective: ${'€'.repeat(4000)}`],
    ['criterion', 'original-plan-scope', `Original scope: ${'€scope,'.repeat(2000)}; original non-goals: ${'€non-goal,'.repeat(2000)}`],
    ['packet', 'task-ownership', `Allowed paths: ${'€/owned/**,'.repeat(500)}; forbidden paths: ${'€/forbidden/**,'.repeat(500)}`],
    ['packet', 'task-validation', `Required validation: ${'npm run check:workflow;'.repeat(500)}`],
    ['result', 'task-result', `implemented; ${'€result'.repeat(4000)}; changed paths ${'€/changed,'.repeat(500)}`],
    ['finding-disposition', 'round-1-finding-summary', `Finding summary: ${'€summary'.repeat(4000)}`],
    ['finding-disposition', 'round-1-finding-evidence', `Finding evidence: ${'€evidence'.repeat(4000)}`],
  ].map(([kind, id, summary], index) => ({ kind, id, summary, digest: `sha256:${String(index).padStart(64, '0')}` }));
  const semantic = boundVerifierEvidence(requiredSemantics);
  assert.ok(semantic.length > requiredSemantics.length);
  for (const required of requiredSemantics) {
    const chunks = semantic.filter(({ digest }) => digest === required.digest);
    assert.ok(chunks.length > 0, `${required.id} remains present`);
    assert.equal(chunks.map(({ summary }) => summary).join(''), required.summary, `${required.id} reconstructs exactly`);
    assert.ok(chunks.every(({ summary }) => Buffer.byteLength(summary, 'utf8') <= 1800));
  }
  assert.deepEqual(new Set(semantic.map(({ kind }) => kind)), new Set(['criterion', 'packet', 'result', 'finding-disposition']));
  assert.throws(() => boundVerifierEvidence(Array.from({ length: 501 }, (_, index) => ({ kind: 'packet', id: `packet-${index}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: `packet ${index}` }))),
  (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.equal(boundVerifierEvidence(Array.from({ length: 500 }, (_, index) => ({ kind: 'packet', id: `edge-${index}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: 'x' }))).length, 500,
  'the exact 500-item boundary is admitted');
  assert.throws(() => boundVerifierEvidence(Array.from({ length: 150 }, (_, index) => ({ kind: 'packet', id: `large-${index}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: '€'.repeat(600) }))),
  (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');

  const byteItem = (index, summary) => ({ kind: 'packet', id: `byte-edge-${index}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary });
  const full = []; let exactByteItems;
  for (let index = 0; index < 500; index += 1) {
    const last = byteItem(index, '');
    const remaining = (256 * 1024) - Buffer.byteLength(JSON.stringify([...full, last]), 'utf8');
    if (remaining >= 1 && remaining <= 1800) {
      exactByteItems = [...full, byteItem(index, 'x'.repeat(remaining))]; break;
    }
    full.push(byteItem(index, 'x'.repeat(1800)));
  }
  assert.ok(exactByteItems, 'constructed the exact byte boundary');
  assert.equal(Buffer.byteLength(JSON.stringify(exactByteItems), 'utf8'), 256 * 1024);
  assert.equal(boundVerifierEvidence(exactByteItems).length, exactByteItems.length,
    'the exact 256-KiB evidence boundary is admitted');
  const overByteItems = structuredClone(exactByteItems);
  overByteItems.at(-1).summary += 'x';
  assert.throws(() => boundVerifierEvidence(overByteItems),
    (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');

  const commonPrefix = `task-${'a'.repeat(115)}`;
  const boundaryItems = [
    { kind: 'packet', id: `${commonPrefix}-one-two`, digest: `sha256:${'a'.repeat(64)}`, summary: `one-${'€'.repeat(1000)}` },
    { kind: 'packet', id: `${commonPrefix}-one-six`, digest: `sha256:${'b'.repeat(64)}`, summary: `six-${'€'.repeat(1000)}` },
    { kind: 'finding-disposition', id: `${'finding-'.repeat(16)}identity-summary-synthetic-suffix`,
      digest: `sha256:${'c'.repeat(64)}`, summary: `BEGIN-${'€'.repeat(2000)}-END` },
  ];
  assert.ok(boundaryItems.slice(0, 2).every(({ id }) => id.length === 128));
  const boundary = boundVerifierEvidence(boundaryItems);
  assert.ok(boundary.every(({ id }) => id.length <= 128 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)));
  assert.equal(new Set(boundary.map(({ id }) => id)).size, boundary.length, 'normalized and chunk IDs remain distinct');
  for (const item of boundaryItems) {
    const identity = `Evidence identity: ${item.id}\n`;
    const digestChunks = boundary.filter(({ digest }) => digest === item.digest);
    assert.ok(digestChunks[0].summary.startsWith(identity), `${item.id} preserves its original identity`);
    assert.equal(digestChunks.map(({ summary }) => summary).join(''), `${identity}${item.summary}`);
    assert.ok(digestChunks.every(({ id }) => !id.includes('--part-') && !id.endsWith('-')));
  }
  const exactBoundary = { kind: 'packet', id: `task-${'z'.repeat(123)}`, digest: `sha256:${'d'.repeat(64)}`, summary: 'short authority' };
  assert.equal(exactBoundary.id.length, 128);
  assert.deepEqual(boundVerifierEvidence([exactBoundary]), [exactBoundary], 'valid unchunked boundary identity remains readable');
});

test('canonical projected full context admits exact 500-item and 256-KiB envelopes only', async () => {
  const { cwd, sha } = repository('full verifier envelope boundaries');
  const planning = await initializeState({ cwd, changeId: 'full-verifier-envelope', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  const task = plan.tasks[0];
  const taskRecord = { task, packet: null, packetDigest: digestJson(task),
    provenanceDigest: digestJson({ decisionIds: task.decisionIds, criterionIds: task.criterionIds }),
    result: null, resultDigest: digestJson({ taskId: task.id, status: 'projected-terminal' }),
    requiresReplacement: true,
    terminalStatus: 'integrated', integratedCommit: null, integrationReceipt: null,
    integrationReceiptDigest: digestJson({ taskId: task.id, status: 'projected-integration' }),
    binding: 1, behaviorMapperEvidence: null };
  const dispositionRecord = (index, summaryLength = 1, evidenceLength = 1) => {
    const finding = { id: `envelope-finding-${String(index).padStart(3, '0')}`, priority: 'P2',
      summary: 's'.repeat(summaryLength), evidence: 'e'.repeat(evidenceLength), affectedAreas: ['workflow'],
      recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'],
      criterionIds: ['durable-state'], invariantIds: [] };
    const fingerprint = findingFingerprint({ sourceKind: 'verifier',
      sourceRole: 'development_integration_verifier', finding });
    const disposition = { schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
      sourceResultDigest: `sha256:${'a'.repeat(64)}`, headSha: sha, findingId: finding.id, fingerprint,
      disposition: 'duplicate', reason: 'x', amendmentId: null, replacementCriterionId: null,
      replacementTaskId: null, recordedAt: '2026-08-18T18:00:00.000Z' };
    return { round: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
      sourceDigest: disposition.sourceResultDigest, finding, fingerprint,
      disposition: { value: disposition, digest: digestJson(disposition) }, authorization: null,
      authorizationRequired: false };
  };
  const projection = (findingRecords, helperCount = 0) => {
    const validationPlan = { commands: [], headSha: sha, releaseEvidence: null };
    const specialistPlan = { schemaVersion: 1, headSha: sha,
      validationPlanDigest: digestJson(validationPlan), finalVerificationPriority: 'standard',
      routeReceiptDigests: [], planningHelpers: Array.from({ length: helperCount }, (_, index) => ({
        id: `helper-${String(index).padStart(3, '0')}`, reasons: ['x'],
      })), reviewers: [], supplementalGuidance: [] };
    return { originalPlan: plan, effectivePlan: plan, taskRecords: [taskRecord], validationPlan,
      validationPlanDigestValue: digestJson(validationPlan), specialistPlan, findingRecords,
      sourceDigest: planning.source.observationDigest, headSha: sha, planningSha: sha,
      verificationRound: 1, taskSetDigest: digestJson(plan.tasks),
      generatedAt: '2026-08-18T18:00:00.000Z' };
  };

  const baseline = preflightVerifierCapacity({ projection: projection([]) }).context;
  const remediationEnvelope = baseline.evidence.filter(({ summary }) =>
    summary.startsWith('Reserved schema-minimal viable remediation authority for state-task:'));
  assert.equal(remediationEnvelope.length, 15,
    'the full-context byte boundary includes the bounded task-replacement authority envelope');
  const baselineCount = baseline.evidence.length;
  const findingCount = Math.floor((500 - baselineCount) / 4);
  const helperCount = 500 - baselineCount - (findingCount * 4);
  const exactItems = preflightVerifierCapacity({ projection: projection(
    Array.from({ length: findingCount }, (_, index) => dispositionRecord(index)), helperCount) }).context;
  assert.equal(exactItems.evidence.length, 500, 'the complete canonical context admits exactly 500 evidence items');
  assert.throws(() => preflightVerifierCapacity({ projection: projection(
    Array.from({ length: findingCount }, (_, index) => dispositionRecord(index)), helperCount + 1) }),
  (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');

  const targetBytes = 256 * 1024; const tuningCount = 3; const fieldLimit = 1600;
  let coarseCount = 0;
  for (;; coarseCount += 1) {
    const records = [
      ...Array.from({ length: coarseCount + 1 }, (_, index) => dispositionRecord(index, fieldLimit, fieldLimit)),
      ...Array.from({ length: tuningCount }, (_, index) =>
        dispositionRecord(coarseCount + 1 + index, 1, 1)),
    ];
    try { preflightVerifierCapacity({ projection: projection(records) }); }
    catch (error) { assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE'); break; }
  }
  const coarseRecords = Array.from({ length: coarseCount }, (_, index) =>
    dispositionRecord(index, fieldLimit, fieldLimit));
  const minimumTuning = Array.from({ length: tuningCount }, (_, index) =>
    dispositionRecord(coarseCount + index, 1, 1));
  const minimumContext = preflightVerifierCapacity({ projection: projection([...coarseRecords, ...minimumTuning]) }).context;
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(minimumContext), 'utf8');
  assert.ok(remaining >= 0 && remaining <= tuningCount * 2 * (fieldLimit - 1),
    'the coarse inventory leaves an exactly fillable unchunked envelope gap');
  const lengths = Array.from({ length: tuningCount * 2 }, () => 1);
  for (let index = 0; index < lengths.length && remaining > 0; index += 1) {
    const increase = Math.min(fieldLimit - 1, remaining); lengths[index] += increase; remaining -= increase;
  }
  assert.equal(remaining, 0);
  const tunedRecords = Array.from({ length: tuningCount }, (_, index) => dispositionRecord(
    coarseCount + index, lengths[index * 2], lengths[(index * 2) + 1]));
  const exactBytes = preflightVerifierCapacity({ projection: projection([...coarseRecords, ...tunedRecords]) }).context;
  assert.equal(Buffer.byteLength(JSON.stringify(exactBytes), 'utf8'), targetBytes,
    'the complete canonical context admits the exact 256-KiB envelope');
  const growIndex = lengths.findIndex((length) => length < fieldLimit);
  assert.notEqual(growIndex, -1);
  lengths[growIndex] += 1;
  const overRecords = Array.from({ length: tuningCount }, (_, index) => dispositionRecord(
    coarseCount + index, lengths[index * 2], lengths[(index * 2) + 1]));
  assert.throws(() => preflightVerifierCapacity({ projection: projection([...coarseRecords, ...overRecords]) }),
    (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
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
    (error) => error instanceof StateError && ['STATE_TOO_LARGE', 'VERIFIER_CONTEXT_TOO_LARGE'].includes(error.code));
  assert.equal(readFileSync(statePath, 'utf8'), durableBefore.state);
  assert.equal(readFileSync(eventsPath, 'utf8'), durableBefore.events);
  assert.deepEqual(readdirSync(join(directory, 'transitions')), durableBefore.transitions);
  assert.equal(existsSync(join(directory, 'plan')), false);
});

test('verifier-capacity admission fails before accepted-plan mutation', async () => {
  const { cwd, sha } = repository('verifier capacity admission');
  const planning = await initializeState({ cwd, changeId: 'verifier-capacity-admission', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); const template = plan.tasks[0];
  for (let index = 1; index < 45; index += 1) {
    const taskId = `capacity-task-${index}`; const criterionId = `capacity-criterion-${index}`;
    plan.criteria.push({ id: criterionId, description: `Capacity criterion ${index}.`, disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    plan.tasks.push({ ...template, id: taskId, title: `Capacity task ${index}`, objective: `Exercise capacity ${index}.`,
      criterionIds: [criterionId], checklistItemIds: [], anticipatedPaths: [`capacity/${index}.txt`] });
  }
  const root = changeDirectory(cwd, planning.changeId); const before = readFileSync(join(root, 'state.json'), 'utf8');
  assert.throws(() => acceptPlan({ cwd, plan, expectedRevision: planning.revision }),
    (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before);
  assert.equal(existsSync(join(root, 'plan')), false);
});

test('packet and implementation-result capacity failures are atomic and retryable', async () => {
  const { cwd, sha } = repository('packet result capacity');
  const planning = await initializeState({ cwd, changeId: 'packet-result-capacity', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  const ownedPath = `capacity/${'nested/'.repeat(25)}long-command-edge.test.mjs`;
  plan.tasks[0].anticipatedPaths = [ownedPath];
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  packet.requiredValidation.unit[0] = { command: `node --test ${ownedPath}`,
    reason: 'Exercise the exact long owned path and validation command.' };
  const padding = Array.from({ length: 700 }, (_, index) =>
    `padding/${String(index).padStart(3, '0')}-${'x'.repeat(470)}`);
  const projected = (count) => {
    const candidate = { ...packet, forbiddenPaths: padding.slice(0, count) };
    return preflightVerifierCapacity({ originalPlan: plan, packets: [candidate],
      sourceDigest: state.source.observationDigest, featureDirectory: join(cwd, 'specs', 'features') }).context;
  };
  let lower = 0; let upper = padding.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    try { projected(middle); lower = middle; }
    catch (error) {
      assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE'); upper = middle - 1;
    }
  }
  assert.ok(lower > 0 && lower < padding.length, 'found a bounded packet projection edge');
  const root = changeDirectory(cwd, state.changeId);
  const beforePacket = durableSnapshot(root);
  assert.throws(() => bindTask({ cwd, expectedRevision: state.revision,
    packet: { ...packet, forbiddenPaths: padding.slice(0, lower + 1) } }),
  (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(root), beforePacket, 'oversized packet binding is nonmutating');

  const retryableCount = lower - 3;
  assert.ok(retryableCount > 0);
  packet.forbiddenPaths = padding.slice(0, retryableCount);
  state = bindTask({ cwd, expectedRevision: state.revision, packet });
  const worker = createWorkerFixture(cwd, state, packet);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: packet.taskId, workerId: 'capacity-worker', expectedRevision: state.revision });
  mkdirSync(dirname(join(worker.path, ownedPath)), { recursive: true });
  writeFileSync(join(worker.path, ownedPath), 'capacity\n'); git(worker.path, 'add', ownedPath);
  git(worker.path, 'commit', '-m', 'test: capacity worker');
  const workerCommit = git(worker.path, 'rev-parse', 'HEAD');
  const oversizedResult = resultFor(packet, 'implemented', workerCommit, [ownedPath]);
  oversizedResult.summary = 'r'.repeat(4000);
  oversizedResult.validation[0].summary = 'v'.repeat(4000);
  const beforeResult = durableSnapshot(root);
  assert.throws(() => acceptResult({ cwd, expectedRevision: state.revision, workerCwd: worker.path,
    result: oversizedResult }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(root), beforeResult, 'oversized implementation result is nonmutating');
  state = acceptResult({ cwd, expectedRevision: state.revision, workerCwd: worker.path,
    result: resultFor(packet, 'implemented', workerCommit, [ownedPath]) });
  assert.equal(state.execution.tasks[0].status, 'accepted', 'consolidated result retry succeeds');
  state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
  state = createValidationPlan({ cwd, expectedRevision: state.revision });
  state = runValidation({ cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd, expectedRevision: state.revision });
  const context = buildVerifierContext({ cwd });
  assert.ok(context.evidence.some(({ kind, summary }) => kind === 'integration'
    && summary.includes(state.verification.headSha)), 'conservative integration authority completes at the edge');
  assert.ok(context.evidence.some(({ kind, summary }) => kind === 'validation-result'
    && summary.includes(`${packet.requiredValidation.unit[0].command} => passed; exit 0; output sha256:`)),
  'the deterministic terminal validation result fits after its long-command intent');
});

test('failed result admission reserves truthful rejection and replacement without integration deadlock', async () => {
  const { cwd, sha } = repository('failed result replacement capacity');
  const planning = await initializeState({ cwd, changeId: 'failed-result-replacement-capacity',
    mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, packet);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: packet.taskId, workerId: 'failed-capacity-worker',
    expectedRevision: state.revision });
  const dependency = (index) => `dependency-${String(index).padStart(3, '0')}-${'x'.repeat(3000)}`;
  const failedResult = (count) => ({ ...resultFor(packet, 'failed'),
    validation: packet.requiredValidation.unit.map(({ command }) => ({ command, result: 'failed',
      summary: 'The exact worker validation failed.' })),
    unexpectedDependencies: Array.from({ length: count }, (_, index) => dependency(index)),
    summary: 'The immutable task must be rejected and replaced.' });
  let lower = 0; let upper = 100;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    try {
      preflightStateVerifierCapacity({ cwd, pending: { result: failedResult(middle) } }); lower = middle;
    } catch (error) {
      assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE'); upper = middle - 1;
    }
  }
  assert.ok(lower > 0 && lower < 100, 'found the failed-result replacement capacity edge');
  const rejected = failedResult(lower + 1);
  const before = durableSnapshot(changeDirectory(cwd, state.changeId));
  assert.throws(() => acceptResult({ cwd, expectedRevision: state.revision,
    workerCwd: worker.path, result: rejected }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(changeDirectory(cwd, state.changeId)), before,
    'an unfit nonterminal result creates no result receipt, blocker, event, or transition');
  const admitted = failedResult(lower);
  const projection = preflightStateVerifierCapacity({ cwd, pending: { result: admitted } }).context;
  const replacementEvidence = projection.evidence.filter(({ summary }) =>
    summary.startsWith('Reserved schema-minimal viable remediation authority for state-task:'));
  assert.equal(replacementEvidence.length, 15);
  assert.equal(projection.evidence.some(({ kind, id }) => kind === 'integration'
    && id === 'state-task-integration'), false,
  'a failed result does not reserve impossible integration authority');
  state = acceptResult({ cwd, expectedRevision: state.revision, workerCwd: worker.path, result: admitted });
  state = rejectTask({ cwd, taskId: packet.taskId, reason: 'Replace the receipt-bound failed task.',
    expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  const resultingPlan = planFor(planning, 2);
  resultingPlan.tasks[0].id = 'replacement-task'; resultingPlan.tasks[0].title = 'Implement replacement task';
  resultingPlan.criteria[0].ownerTaskId = 'replacement-task';
  resultingPlan.checklistMappings[0].taskIds = ['replacement-task'];
  const suffix = 'state-task/0001.json';
  state = amendPlan({ cwd, expectedRevision: state.revision, resultingPlan,
    amendment: { id: 'replace-failed-task', reason: 'Replace the failed immutable work truthfully.',
      authorization: 'operator', trigger: 'task-rejected', delta: { replacementTaskId: 'replacement-task' },
      invalidatedEvidence: [`implementation/tasks/${suffix}`, `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`,
        'implementation/results/state-task/0001.json'] } });
  assert.deepEqual(state.execution.tasks.map(({ id, status }) => ({ id, status })),
    [{ id: 'replacement-task', status: 'unbound' }],
  'the admitted edge result remains truthfully rejectable and replaceable');
});

test('implemented integration conflict remains rejectable through reserved replacement authority', async () => {
  const repositoryFixture = repository('integration conflict replacement capacity');
  writeFileSync(join(repositoryFixture.cwd, 'shared.txt'), 'base\n');
  git(repositoryFixture.cwd, 'add', 'shared.txt');
  git(repositoryFixture.cwd, 'commit', '-m', 'test: shared conflict base');
  const sha = git(repositoryFixture.cwd, 'rev-parse', 'HEAD');
  const planning = await initializeState({ cwd: repositoryFixture.cwd,
    changeId: 'integration-conflict-replacement-capacity', mode: 'implement', baseBranch: 'main',
    planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  plan.tasks[0].anticipatedPaths = ['shared.txt'];
  let state = acceptPlan({ cwd: repositoryFixture.cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTask({ cwd: repositoryFixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(repositoryFixture.cwd, state, packet);
  state = scheduleWave({ cwd: repositoryFixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: repositoryFixture.cwd, taskId: packet.taskId,
    workerId: 'conflict-worker', expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'shared.txt'), 'worker\n');
  git(worker.path, 'add', 'shared.txt'); git(worker.path, 'commit', '-m', 'test: worker conflict side');
  const workerCommit = git(worker.path, 'rev-parse', 'HEAD');
  state = acceptResult({ cwd: repositoryFixture.cwd, workerCwd: worker.path,
    expectedRevision: state.revision,
    result: resultFor(packet, 'implemented', workerCommit, ['shared.txt']) });
  const reserved = preflightStateVerifierCapacity({ cwd: repositoryFixture.cwd }).context.evidence
    .filter(({ summary }) => summary.startsWith(
      'Reserved schema-minimal viable remediation authority for state-task:'));
  assert.equal(reserved.length, 15,
    'an implemented result retains the larger conflict-rejection branch before integration intent');
  assert.throws(() => integrateTask({ cwd: repositoryFixture.cwd, taskId: packet.taskId,
    expectedRevision: state.revision,
    crashStep(step) { if (step === 'integration-operation-after-intent') throw new Error('pause before conflict'); } }),
  /pause before conflict/u);
  state = loadState(repositoryFixture.cwd);
  assert.equal(state.execution.integrationIntent.taskId, packet.taskId);
  writeFileSync(join(repositoryFixture.cwd, 'shared.txt'), 'central\n');
  git(repositoryFixture.cwd, 'add', 'shared.txt');
  git(repositoryFixture.cwd, 'commit', '-m', 'test: conflicting central side');
  const cherryPick = spawnSync('git', ['cherry-pick', workerCommit], {
    cwd: repositoryFixture.cwd, encoding: 'utf8' });
  assert.notEqual(cherryPick.status, 0, 'the accepted worker delta conflicts against the advanced central file');
  git(repositoryFixture.cwd, 'cherry-pick', '--abort');
  git(repositoryFixture.cwd, 'reset', '--hard', state.execution.integrationIntent.centralBaseSha);
  state = rejectTask({ cwd: repositoryFixture.cwd, taskId: packet.taskId,
    reason: 'Replace the exact worker delta after its truthful integration conflict.',
    expectedRevision: state.revision });
  removeTaskWorktree({ cwd: repositoryFixture.cwd, changeId: state.changeId, taskId: packet.taskId });
  const resultingPlan = structuredClone(plan); resultingPlan.planRevision = 2;
  resultingPlan.criteria[0].ownerTaskId = 'state-task-replacement';
  resultingPlan.checklistMappings[0].taskIds = ['state-task-replacement'];
  resultingPlan.tasks = [{ ...structuredClone(plan.tasks[0]), id: 'state-task-replacement',
    title: 'Replace conflicted task', objective: 'Implement the change from the restored central base.' }];
  const suffix = 'state-task/0001.json';
  state = amendPlan({ cwd: repositoryFixture.cwd, expectedRevision: state.revision, resultingPlan,
    amendment: { id: 'replace-conflicted-state-task',
      reason: 'Replace the receipt-bound conflict with a new-base task.', authorization: 'operator',
      trigger: 'task-rejected', delta: { replacementTaskId: 'state-task-replacement' },
      invalidatedEvidence: [`implementation/tasks/${suffix}`, `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`,
        'implementation/results/state-task/0001.json'] } });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task-replacement').status, 'unbound');
});

test('oversized amendment projection fails before append-only authority mutates', async () => {
  const { cwd, sha } = repository('amendment capacity');
  const planning = await initializeState({ cwd, changeId: 'amendment-capacity', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const acceptedPlan = planFor(planning);
  const state = acceptPlan({ cwd, plan: acceptedPlan, expectedRevision: planning.revision });
  const resultingPlan = structuredClone(acceptedPlan); resultingPlan.planRevision = 2;
  const template = resultingPlan.tasks[0];
  for (let index = 1; index < 45; index += 1) {
    const taskId = `amendment-task-${index}`; const criterionId = `amendment-criterion-${index}`;
    resultingPlan.criteria.push({ id: criterionId, description: `Amendment criterion ${index}.`,
      disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    resultingPlan.tasks.push({ ...template, id: taskId, title: `Amendment task ${index}`,
      objective: `Exercise amended capacity ${index}.`, criterionIds: [criterionId],
      checklistItemIds: [], anticipatedPaths: [`amendment/${index}.txt`] });
  }
  const root = changeDirectory(cwd, state.changeId); const before = durableSnapshot(root);
  assert.throws(() => amendPlan({ cwd, expectedRevision: state.revision, resultingPlan,
    amendment: { id: 'oversized-amendment', reason: 'Exercise canonical capacity.', authorization: 'operator',
      trigger: 'operator-decision', delta: { addedTaskIds: resultingPlan.tasks.slice(1).map(({ id }) => id) },
      invalidatedEvidence: [] } }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(root), before, 'oversized amendment creates no sidecar, receipt, event, or transition');
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
  state = createValidationPlan({ cwd, expectedRevision: state.revision });
  assert.equal(state.phase, 'validating');
  writeFileSync(join(cwd, 'verification-head-drift.txt'), 'dirty');
  assert.throws(() => runValidation({ cwd, expectedRevision: state.revision }),
    (error) => error.code === 'VERIFICATION_HEAD_MISMATCH');
  unlinkSync(join(cwd, 'verification-head-drift.txt'));
  let runnerCalled = false;
  assert.throws(() => runValidation({ cwd, expectedRevision: state.revision,
    runner() { runnerCalled = true; return { status: 0, signal: null, stdout: '', stderr: '' }; },
    crashStep(step) { if (step === 'after-complete') throw new Error('resume persisted validation intent'); } }),
  /resume persisted validation intent/u);
  assert.equal(runnerCalled, false, 'execution starts only after its immutable intent transition returns');
  state = loadState(cwd);
  state = runValidation({ cwd, expectedRevision: state.revision,
    runner(executable, argv, options) {
      assert.equal(options.shell, false);
      assert.ok(executable.length > 0 && argv.length > 0);
      return { status: 0, signal: null, stdout: 'passed\n', stderr: '' };
    } });
  assert.equal(state.phase, 'specialist-review');
  state = createSpecialistPlan({ cwd, expectedRevision: state.revision });
  assert.equal(state.phase, 'verifying');
  const context = buildVerifierContext({ cwd });
  assert.equal(context.verifierId, 'development_integration_verifier');
  assert.equal(context.finalVerificationPriority, 'standard');
  const integrationEvidence = Object.fromEntries(context.evidence.filter(({ kind }) => kind === 'integration')
    .map((entry) => [entry.id, entry]));
  assert.match(integrationEvidence['state-task-integration'].summary, new RegExp(`Integrated exact worker result at ${state.execution.tasks.find(({ id }) => id === 'state-task').integratedCommit}; integration transition revision \\d+;`, 'u'));
  assert.match(integrationEvidence['second-task-integration'].summary, new RegExp(`Integrated exact worker result at ${state.execution.tasks.find(({ id }) => id === 'second-task').integratedCommit}; integration transition revision \\d+;`, 'u'));
  const firstIntegrationRevision = Number(/integration transition revision (\d+)/u.exec(integrationEvidence['state-task-integration'].summary)[1]);
  const secondIntegrationRevision = Number(/integration transition revision (\d+)/u.exec(integrationEvidence['second-task-integration'].summary)[1]);
  assert.ok(firstIntegrationRevision < secondIntegrationRevision, 'task receipts preserve exact integration order');
  assert.notEqual(integrationEvidence['state-task-integration'].digest, integrationEvidence['second-task-integration'].digest,
    'each task binds its own task-integrated transition receipt');
  assert.match(context.evidence.find(({ kind, id }) => kind === 'packet' && id === 'state-task-ownership').summary,
    /Allowed paths: first\.txt; forbidden paths: none/u);
  assert.match(context.evidence.find(({ kind, id }) => kind === 'packet' && id === 'state-task-validation').summary,
    /Required validation: node --test/u);
  assert.ok(context.evidence.some(({ id, summary }) => id === 'original-plan-scope' && summary.includes('Original scope')));
  assert.ok(context.evidence.some(({ id, summary }) => id === 'effective-plan-profile' && summary.includes('profiles/ops-workflow.md')));
  assert.ok(context.evidence.some(({ kind, id, summary }) => kind === 'criterion' && id === 'durable-state'
    && summary.includes('State remains durable.')));
  assert.ok(context.evidence.some(({ kind }) => kind === 'validation-result'));
  await assert.rejects(finalizeDevelopment({ cwd, expectedRevision: state.revision }),
    (error) => error.code === 'INVALID_PHASE');
  state = recordVerifierResult({ cwd, expectedRevision: state.revision, result: {
    schemaVersion: 1, headSha: state.verification.headSha, contextDigest: digestJson(context), status: 'clean',
    summary: 'Exact integrated HEAD satisfies the accepted plan.', findings: [], recordedAt: '2026-08-18T12:00:00.000Z',
  } });
  const revisionBeforeCaptureFailure = state.revision;
  unlinkSync(join(cwd, 'request.md'));
  await assert.rejects(finalizeDevelopment({ cwd, expectedRevision: state.revision }), /ENOENT/u);
  assert.equal(loadState(cwd).revision, revisionBeforeCaptureFailure);
  writeFileSync(join(cwd, 'request.md'), '# Request\n\n- [ ] <!-- aerstello:item=durable-state --> Add durable state\n');
  state = await finalizeDevelopment({ cwd, expectedRevision: state.revision });
  assert.equal(state.phase, 'development-ready');
  assert.equal(validateState({ cwd }).valid, true);
});

test('terminal integration authority rejects missing, broken, and ambiguous exact receipt pairs', async () => {
  const fixture = await integratedSingleTaskFixture('integration receipt authority');
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const transitions = join(changeDirectory(fixture.cwd, state.changeId), 'transitions');
  const taskDirectoryName = readdirSync(transitions).find((name) => {
    const path = join(transitions, name, 'intent.json');
    return existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).type === 'task-integrated';
  });
  const taskDirectory = join(transitions, taskDirectoryName);
  const intentPath = join(taskDirectory, 'intent.json');
  const receiptPath = join(taskDirectory, 'receipt.json');
  const originalIntent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const originalReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));

  unlinkSync(receiptPath.replace(/\.json$/u, '.sha256'));
  assert.throws(() => buildVerifierContext({ cwd: fixture.cwd }), (error) => error.code === 'RECEIPT_MISSING');
  writeReceiptJson(receiptPath, originalReceipt);

  writeCompleteTransitionFixture(taskDirectory, { ...originalIntent, type: 'not-task-integrated' });
  assert.throws(() => buildVerifierContext({ cwd: fixture.cwd }), (error) => error.code === 'INTEGRATION_RECEIPT_MISSING');
  writeCompleteTransitionFixture(taskDirectory, originalIntent);

  const precedingDirectory = join(transitions, String(originalIntent.revision - 1).padStart(8, '0'));
  const precedingIntent = JSON.parse(readFileSync(join(precedingDirectory, 'intent.json'), 'utf8'));
  const clonedPreceding = structuredClone(precedingIntent);
  clonedPreceding.revision = 90000000;
  clonedPreceding.nextState.revision = 90000000;
  clonedPreceding.nextStateDigest = digestJson(clonedPreceding.nextState);
  const clonedIntegrated = structuredClone(originalIntent);
  clonedIntegrated.revision = 90000001;
  clonedIntegrated.previousStateDigest = clonedPreceding.nextStateDigest;
  clonedIntegrated.nextState.revision = 90000001;
  clonedIntegrated.nextStateDigest = digestJson(clonedIntegrated.nextState);
  writeCompleteTransitionFixture(join(transitions, '90000000'), clonedPreceding);
  writeCompleteTransitionFixture(join(transitions, '90000001'), clonedIntegrated);
  assert.throws(() => buildVerifierContext({ cwd: fixture.cwd }), (error) => error.code === 'INTEGRATION_RECEIPT_AMBIGUOUS');
});

test('change validation executes diff checks across immutable planning and HEAD commits', async () => {
  const fixture = await integratedSingleTaskFixture(
    'committed whitespace validation range',
    specialization(),
    { validationCommand: 'git diff --check', workerContent: 'trailing whitespace  \n' },
  );
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  const planPath = join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0001', 'validation-plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const diffCommand = plan.commands.find(({ argv }) => argv[0] === 'git');
  assert.deepEqual(diffCommand.argv, [
    'git', 'diff', '--check', state.planningSha, state.verification.headSha, '--',
  ]);
  state = runValidation({
    cwd: fixture.cwd,
    expectedRevision: state.revision,
    runner(executable, argv, options) {
      return executable === 'git'
        ? spawnSync(executable, argv, options)
        : { status: 0, signal: null, stdout: 'passed', stderr: '' };
    },
  });
  assert.equal(state.verification.validationStatus, 'failed');

  const equal = await integratedSingleTaskFixture(
    'equal committed validation range',
    specialization(),
    { validationCommand: 'git diff --check', noChange: true },
  );
  let equalState = createValidationPlan({ cwd: equal.cwd, expectedRevision: equal.state.revision });
  equalState = runValidation({
    cwd: equal.cwd,
    expectedRevision: equalState.revision,
    runner(executable, argv, options) {
      return executable === 'git'
        ? spawnSync(executable, argv, options)
        : { status: 0, signal: null, stdout: 'passed', stderr: '' };
    },
  });
  assert.equal(equalState.verification.validationStatus, 'passed');
});

test('change validation planning rejects common-directory grafts from a linked worktree without mutation', async () => {
  const fixture = await integratedSingleTaskFixture('linked validation planning graft authority');
  git(fixture.cwd, 'switch', '--detach');
  const linkedCwd = join(mkdtempSync(join(tmpdir(), 'change-validation-planning-linked-')), 'worktree');
  git(fixture.cwd, 'worktree', 'add', linkedCwd, 'main');
  const commonGitDirectory = git(linkedCwd, '--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(commonGitDirectory, join(fixture.cwd, '.git'));
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  mkdirSync(dirname(graftsPath), { recursive: true });
  writeFileSync(graftsPath, `${fixture.state.git.headSha} ${fixture.state.planningSha}\n`);
  const before = durableSnapshot(changeDirectory(linkedCwd, fixture.state.changeId));

  assert.throws(() => createValidationPlan({ cwd: linkedCwd, expectedRevision: fixture.state.revision + 1 }),
    (error) => error.code === 'REVISION_CONFLICT');
  writeFileSync(join(linkedCwd, 'dirty-validation-authority.txt'), 'dirty\n');
  assert.throws(() => createValidationPlan({ cwd: linkedCwd, expectedRevision: fixture.state.revision }),
    (error) => error.code === 'VERIFICATION_HEAD_MISMATCH');
  unlinkSync(join(linkedCwd, 'dirty-validation-authority.txt'));
  assert.throws(() => createValidationPlan({ cwd: linkedCwd, expectedRevision: fixture.state.revision }),
    (error) => error.code === 'VALIDATION_LEGACY_GRAFTS_PRESENT');
  assert.deepEqual(durableSnapshot(changeDirectory(linkedCwd, fixture.state.changeId)), before);

  unlinkSync(graftsPath);
  const state = createValidationPlan({ cwd: linkedCwd, expectedRevision: fixture.state.revision });
  assert.equal(state.phase, 'validating', 'an absent graft file is inert');
  writeFileSync(graftsPath, `${state.git.headSha} ${state.planningSha}\n`);
  const validatingBefore = durableSnapshot(changeDirectory(linkedCwd, state.changeId));
  assert.throws(() => createValidationPlan({ cwd: linkedCwd, expectedRevision: state.revision }),
    (error) => error.code === 'INVALID_PHASE');
  assert.deepEqual(durableSnapshot(changeDirectory(linkedCwd, state.changeId)), validatingBefore);
  unlinkSync(graftsPath);
});

test('change validation execution rechecks linked-worktree grafts after plan identity without invoking a runner', async () => {
  const fixture = await integratedSingleTaskFixture('linked validation runtime graft authority');
  git(fixture.cwd, 'switch', '--detach');
  const linkedCwd = join(mkdtempSync(join(tmpdir(), 'change-validation-runtime-linked-')), 'worktree');
  git(fixture.cwd, 'worktree', 'add', linkedCwd, 'main');
  const commonGitDirectory = git(linkedCwd, '--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir');
  assert.equal(commonGitDirectory, join(fixture.cwd, '.git'));
  const graftsPath = join(commonGitDirectory, 'info', 'grafts');
  mkdirSync(dirname(graftsPath), { recursive: true });
  writeFileSync(graftsPath, '');
  const state = createValidationPlan({ cwd: linkedCwd, expectedRevision: fixture.state.revision });
  const planPath = join(changeDirectory(linkedCwd, state.changeId), 'verification', 'rounds', '0001', 'validation-plan.json');
  const receiptPath = planPath.replace(/\.json$/u, '.sha256');
  const originalPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  const originalReceipt = readFileSync(receiptPath);
  writeFileSync(graftsPath, `${state.git.headSha} ${state.planningSha}\n`);
  let runnerCalled = false;
  const runner = () => { runnerCalled = true; return { status: 0, signal: null, stdout: '', stderr: '' }; };

  unlinkSync(receiptPath);
  const missingReceiptBefore = durableSnapshot(changeDirectory(linkedCwd, state.changeId));
  assert.throws(() => runValidation({ cwd: linkedCwd, expectedRevision: state.revision, runner }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.deepEqual(durableSnapshot(changeDirectory(linkedCwd, state.changeId)), missingReceiptBefore);
  writeFileSync(receiptPath, originalReceipt);

  writeReceiptJson(planPath, { ...originalPlan, taskSetDigest: `sha256:${'0'.repeat(64)}` });
  const staleIdentityBefore = durableSnapshot(changeDirectory(linkedCwd, state.changeId));
  assert.throws(() => runValidation({ cwd: linkedCwd, expectedRevision: state.revision, runner }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.deepEqual(durableSnapshot(changeDirectory(linkedCwd, state.changeId)), staleIdentityBefore);
  writeReceiptJson(planPath, originalPlan);

  const graftBefore = durableSnapshot(changeDirectory(linkedCwd, state.changeId));
  assert.throws(() => runValidation({ cwd: linkedCwd, expectedRevision: state.revision, runner }),
    (error) => error.code === 'VALIDATION_LEGACY_GRAFTS_PRESENT');
  assert.equal(runnerCalled, false);
  assert.deepEqual(durableSnapshot(changeDirectory(linkedCwd, state.changeId)), graftBefore);
  unlinkSync(graftsPath);
});

test('failed validation is private, immutable, and explicitly replaced at the next durable round', async () => {
  const fixture = await integratedSingleTaskFixture('validation replacement');
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  const pendingProjection = preflightStateVerifierCapacity({ cwd: fixture.cwd }).context;
  const pendingRemediation = pendingProjection.evidence.filter(({ summary }) =>
    summary.startsWith('Reserved schema-minimal viable remediation authority for validation-'));
  assert.equal(pendingRemediation.length, 15,
    'validation-plan authority already reserves the exact failed-result remediation branch');
  const withoutPendingRemediation = pendingProjection.evidence.filter((entry) =>
    !pendingRemediation.includes(entry));
  const pendingFiller = Array.from({ length: 500 - withoutPendingRemediation.length }, (_, index) => ({
    kind: 'criterion', id: `validation-remediation-edge-${String(index + 1).padStart(3, '0')}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: 'x',
  }));
  assert.equal(boundVerifierEvidence([...withoutPendingRemediation, ...pendingFiller]).length, 500);
  assert.throws(() => boundVerifierEvidence([
    ...withoutPendingRemediation, ...pendingFiller, ...pendingRemediation,
  ]), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE',
  'the mandatory validation-remediation envelope is independently enforced at the item edge');
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 7, signal: null, stdout: 'private command output', stderr: 'private failure detail' }) });
  assert.equal(state.verification.validationStatus, 'failed');
  assert.equal(preflightStateVerifierCapacity({ cwd: fixture.cwd }).context.evidence.filter(({ summary }) =>
    summary.startsWith('Reserved schema-minimal viable remediation authority for validation-')).length, 15,
  'the exact failed receipt substitutes the pending failure branch without expanding it');
  const resultDirectory = join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0001', 'validation-results');
  const stored = readFileSync(join(resultDirectory, readdirSync(resultDirectory).find((name) => name.endsWith('.json'))), 'utf8');
  assert.doesNotMatch(stored, /private command output|private failure detail/u);
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision, replace: true });
  assert.equal(state.verification.round, 2);
  assert.ok(existsSync(join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0001', 'validation-plan.json')));
  assert.ok(existsSync(join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0002', 'validation-plan.json')));
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 8, signal: null, stdout: '', stderr: 'corrective work required' }) });
  const verificationDirectory = join(changeDirectory(fixture.cwd, state.changeId), 'verification');
  const failedValidationEvidence = durableSnapshot(verificationDirectory);
  const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
  const amendedPlan = structuredClone(original); amendedPlan.planRevision = 2;
  amendedPlan.criteria.push({ id: 'validation-remediation', description: 'Correct the failed lifecycle validation.',
    disposition: 'owned', ownerTaskId: 'validation-remediation-task', deferredReason: null });
  amendedPlan.tasks.push({ ...original.tasks[0], id: 'validation-remediation-task', title: 'Remediate validation',
    objective: 'Correct the receipt-bound validation failure.', criterionIds: ['validation-remediation'],
    checklistItemIds: [], dependsOn: ['state-task'], anticipatedPaths: ['first.txt'] });
  const amendment = { id: 'validation-remediation', reason: 'The durable failed result requires corrective work.',
    authorization: 'operator', trigger: `validation-failure:${state.verification.validationResultDigests.at(-1)}`,
    delta: { added: ['validation-remediation'] }, invalidatedEvidence: [] };
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, resultingPlan: amendedPlan,
    amendment: { ...amendment, trigger: `validation-failure:sha256:${'0'.repeat(64)}` } }),
  (error) => error.code === 'INVALID_AMENDMENT');
  const conflictingPlan = structuredClone(amendedPlan);
  conflictingPlan.criteria.push({ id: 'validation-remediation-conflict', description: 'Keep remediation ownership disjoint.',
    disposition: 'owned', ownerTaskId: 'validation-remediation-conflict-task', deferredReason: null });
  conflictingPlan.tasks.push({ ...amendedPlan.tasks.at(-1), id: 'validation-remediation-conflict-task',
    title: 'Conflict with remediation', objective: 'Attempt overlapping corrective ownership.',
    criterionIds: ['validation-remediation-conflict'] });
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    resultingPlan: conflictingPlan, amendment }),
  (error) => error.code === 'PLAN_NOT_READY' && error.message.includes('overlapping anticipated paths'));
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, resultingPlan: amendedPlan, amendment });
  assert.equal(state.phase, 'implementing');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'validation-remediation-task').status, 'unbound');
  assert.equal(state.verification, null);
  assert.deepEqual(durableSnapshot(verificationDirectory), failedValidationEvidence,
    'failed validation plans and results remain byte-for-byte immutable after remediation admission');
});

test('late source drift preserves terminal authority and invalidates verification proof', async () => {
  const { cwd, sha } = repository('late source drift'); const issue = issueSource(35, 'I_late_source');
  const adapter = { async readIssue() { return structuredClone(issue); } };
  const planning = await initializeState({ cwd, changeId: 'late-source-drift', mode: 'implement', baseBranch: 'main', planningRef: sha,
    source: { type: 'github-issue', repository: 'owner/repo', issueNumber: 35, relationshipIntent: 'resolves' }, sourceAdapter: adapter });
  const plan = planFor(planning); plan.tasks[0].anticipatedPaths = ['first.txt'];
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, packet); state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: packet.taskId, workerId: 'late-source-worker', expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'first.txt'), 'first\n'); git(worker.path, 'add', 'first.txt'); git(worker.path, 'commit', '-m', 'test: late source worker');
  state = acceptResult({ cwd, result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']),
    workerCwd: worker.path, expectedRevision: state.revision });
  state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });

  issue.body = issue.body.replace('[ ]', '[x]'); issue.updatedAt = '2026-08-18T10:01:00Z';
  await assert.rejects(refreshSource({ cwd, expectedRevision: state.revision, sourceAdapter: adapter,
    crashStep(step) { if (step === 'after-intent') throw new Error('late progress crash'); } }), /late progress crash/u);
  state = recoverState({ cwd }).state;
  assert.equal(state.phase, 'integrated'); assert.equal(state.source.classification, 'unchanged');
  assert.equal(state.execution.tasks[0].status, 'integrated');
  assert.equal(state.verification, null);

  issue.body += '\n\nMaterial requirement.'; issue.updatedAt = '2026-08-18T10:02:00Z';
  await assert.rejects(refreshSource({ cwd, expectedRevision: state.revision, sourceAdapter: adapter,
    crashStep(step) { if (step === 'after-intent') throw new Error('late material crash'); } }), /late material crash/u);
  state = recoverState({ cwd }).state;
  assert.equal(state.phase, 'awaiting-decision'); assert.equal(state.source.classification, 'unreviewed-material');
  assert.throws(() => recordDecision({ cwd, expectedRevision: state.revision, decision: { id: 'retain-late-source',
    reason: 'The terminal implementation already covers this wording.', authorization: 'operator', trigger: 'source-refresh', disposition: 'retain-plan' },
  crashStep(step) { if (step === 'after-intent') throw new Error('late retain crash'); } }), /late retain crash/u);
  state = recoverState({ cwd }).state;
  assert.equal(state.phase, 'integrated'); assert.equal(state.verification, null);

  issue.body += '\n\nAnother material requirement.'; issue.updatedAt = '2026-08-18T10:03:00Z';
  state = await refreshSource({ cwd, expectedRevision: state.revision, sourceAdapter: adapter });
  state = recordDecision({ cwd, expectedRevision: state.revision, decision: { id: 'resolve-late-source',
    reason: 'Add ordinary remediation work.', authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve' } });
  const resultingPlan = structuredClone(plan); resultingPlan.planRevision = 2;
  resultingPlan.source.captureDigest = state.source.latestDigest;
  resultingPlan.checklistMappings = resultingPlan.checklistMappings.map((mapping) => {
    const current = state.checklist.find(({ id }) => id === mapping.id); return { ...mapping, checked: current.checked,
      status: current.status, externalChange: current.externalChange };
  });
  resultingPlan.criteria.push({ id: 'late-source-remediation', description: 'Cover the late source requirement.',
    disposition: 'owned', ownerTaskId: 'late-source-remediation-task', deferredReason: null });
  resultingPlan.tasks.push({ ...plan.tasks[0], id: 'late-source-remediation-task', title: 'Cover late source',
    objective: 'Implement the late source requirement.', criterionIds: ['late-source-remediation'], checklistItemIds: [],
    dependsOn: ['state-task'], anticipatedPaths: ['late-source.txt'] });
  assert.throws(() => amendPlan({ cwd, expectedRevision: state.revision, resultingPlan,
    amendment: { id: 'late-source-amendment', reason: 'Incorporate live material drift.', authorization: 'operator',
      trigger: 'resolve-late-source', delta: { added: ['late-source-remediation'] }, invalidatedEvidence: [] },
    crashStep(step) { if (step === 'after-intent') throw new Error('late amendment crash'); } }), /late amendment crash/u);
  state = recoverState({ cwd }).state;
  assert.equal(state.phase, 'implementing'); assert.equal(state.verification, null);
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'late-source-remediation-task').status, 'unbound');
});

test('material source refresh reserves full captured text before mutation and completes remediation', async () => {
  const capturedText = '😀'.repeat(4000);
  const fixtureFor = async (target, number, changeId, expectRefreshFailure = false) => {
    const { cwd, sha } = repository(`source decision capacity ${target}`);
    const issue = issueSource(number, `I_source_decision_${target}`);
    const adapter = { async readIssue() { return structuredClone(issue); } };
    const planning = await initializeState({ cwd, changeId, mode: 'implement', baseBranch: 'main',
      planningRef: sha, source: { type: 'github-issue', repository: 'owner/repo', issueNumber: number,
        relationshipIntent: 'resolves' }, sourceAdapter: adapter });
    const candidate = (taskCount, decisionCount) => {
      const plan = planFor(planning); const template = structuredClone(plan.tasks[0]);
      for (let index = 2; index <= taskCount; index += 1) {
        const taskId = `decision-edge-task-${index}`; const criterionId = `decision-edge-criterion-${index}`;
        plan.criteria.push({ id: criterionId, description: `Decision edge criterion ${index}.`,
          disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
        plan.tasks.push({ ...structuredClone(template), id: taskId,
          title: `Implement decision edge task ${index}`, objective: `Persist decision edge task ${index}.`,
          criterionIds: [criterionId], checklistItemIds: [], dependsOn: [],
          anticipatedPaths: [`decision-edge-${index}.txt`] });
      }
      for (let index = 1; index <= decisionCount; index += 1) {
        const id = `decision-edge-authority-${index}`;
        plan.decisions.push({ id, question: `Decision edge question ${index}?`,
          rationale: 'Retain compact durable authority.', status: 'resolved', resolution: 'Use the exact route.' });
        plan.tasks[0].decisionIds.push(id);
      }
      return plan;
    };
    let plan = null;
    for (let taskCount = 1; taskCount <= 40 && !plan; taskCount += 1) {
      for (let decisionCount = 0; decisionCount <= 12; decisionCount += 1) {
        const value = candidate(taskCount, decisionCount);
        try {
          if (preflightVerifierCapacity({ originalPlan: value,
            sourceDigest: planning.source.observationDigest,
            featureDirectory: join(cwd, 'specs', 'features') }).context.evidence.length === target) {
            plan = value; break;
          }
        } catch (error) { assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE'); }
      }
    }
    assert.ok(plan, `constructed an exact ${target}-item accepted-plan context`);
    let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
    assert.equal(preflightStateVerifierCapacity({ cwd }).context.evidence.length, target);
    issue.body += `\n- [ ] <!-- aerstello:item=late-source-${target} --> ${capturedText}`;
    issue.updatedAt = '2026-08-18T18:30:00Z';
    const before = durableSnapshot(changeDirectory(cwd, state.changeId));
    if (expectRefreshFailure) {
      await assert.rejects(() => refreshSource({ cwd, expectedRevision: state.revision,
        sourceAdapter: adapter }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
      assert.deepEqual(durableSnapshot(changeDirectory(cwd, state.changeId)), before,
        'an unfit captured-text remediation writes no source receipt, event, transition, or state');
      return { cwd, state };
    }
    state = await refreshSource({ cwd, expectedRevision: state.revision, sourceAdapter: adapter });
    assert.equal(state.phase, 'awaiting-decision');
    assert.equal(preflightStateVerifierCapacity({ cwd }).context.evidence.length, target);
    return { cwd, state };
  };
  const passing = await fixtureFor(463, 71, 'decision-capacity-pass');
  const passDecision = { id: 'decision-edge-pass', reason: 'Authorize the mandatory source amendment.',
    authorization: 'operator', trigger: 'source-refresh', disposition: 'resolve' };
  const projected = preflightStateVerifierCapacity({ cwd: passing.cwd,
    pending: { decisionResolution: passDecision } }).context;
  assert.ok(projected.evidence.length <= 500);
  const projectedMapping = projected.evidence.filter(({ id }) =>
    id.startsWith('late-source-463'));
  assert.ok(projectedMapping.length > 1,
    'the exact 4000-code-point multibyte capturedText is reserved with canonical chunks');
  let passed = recordDecision({ cwd: passing.cwd, expectedRevision: passing.state.revision,
    decision: passDecision });
  assert.equal(passed.phase, 'awaiting-decision',
    'resolve authority remains bound to the immediately required source amendment');
  const original = JSON.parse(readFileSync(join(changeDirectory(passing.cwd, passed.changeId),
    'plan', 'plan.json'), 'utf8'));
  const observation = loadLatestSourceObservation(passing.cwd);
  const newChecklist = observation.source.checklist.find(({ checklistItemId }) =>
    checklistItemId === 'late-source-463');
  assert.ok(newChecklist, 'the exact refreshed source contains the new checklist authority');
  const resultingPlan = structuredClone(original); resultingPlan.planRevision = 2;
  resultingPlan.source.captureDigest = passed.source.latestDigest;
  resultingPlan.criteria.push({ id: 'decision-edge-pass-source-criterion',
    description: 'The new material source requirement is implemented.', disposition: 'owned',
    ownerTaskId: 'decision-edge-pass-source-task', deferredReason: null });
  resultingPlan.tasks.push({ ...structuredClone(original.tasks[0]), id: 'decision-edge-pass-source-task',
    title: 'Implement material source requirement', objective: 'Satisfy the added checklist requirement.',
    criterionIds: ['decision-edge-pass-source-criterion'], checklistItemIds: ['late-source-463'],
    dependsOn: original.tasks.map(({ id }) => id), anticipatedPaths: ['late-source-463.txt'] });
  resultingPlan.checklistMappings.push({ ...sourceChecklistBinding(newChecklist),
    criterionIds: ['decision-edge-pass-source-criterion'], taskIds: ['decision-edge-pass-source-task'],
    relationship: passed.source.relationship });
  passed = amendPlan({ cwd: passing.cwd, expectedRevision: passed.revision, resultingPlan,
    amendment: { id: 'decision-edge-pass-source-amendment',
      reason: 'Incorporate the exact added source checklist requirement.', authorization: 'operator',
      trigger: passDecision.id, delta: { addedChecklistItemIds: ['late-source-463'],
        addedTaskIds: ['decision-edge-pass-source-task'] }, invalidatedEvidence: [] } });
  assert.equal(passed.execution.tasks.find(({ id }) => id === 'decision-edge-pass-source-task').status, 'unbound',
    'the reserved material checklist bundle completes as ordinary amendment work');

  await fixtureFor(464, 72, 'decision-capacity-fail', true);
});

test('source refresh enforces checklist plan-text representability before persistence', async () => {
  const fixtureFor = async (count, number, changeId) => {
    const { cwd, sha } = repository(`source representability ${count}`);
    const issue = issueSource(number, `I_source_representability_${count}`);
    const adapter = { async readIssue() { return structuredClone(issue); } };
    const planning = await initializeState({ cwd, changeId, mode: 'implement', baseBranch: 'main',
      planningRef: sha, source: { type: 'github-issue', repository: 'owner/repo', issueNumber: number,
        relationshipIntent: 'resolves' }, sourceAdapter: adapter });
    const state = acceptPlan({ cwd, plan: planFor(planning), expectedRevision: planning.revision });
    issue.body += `\n- [ ] ${'😀'.repeat(count)}`;
    issue.updatedAt = '2026-08-18T18:45:00Z';
    return { cwd, state, adapter };
  };

  const passing = await fixtureFor(4000, 73, 'source-representability-pass');
  const passed = await refreshSource({ cwd: passing.cwd, expectedRevision: passing.state.revision,
    sourceAdapter: passing.adapter });
  assert.equal(passed.phase, 'awaiting-decision');
  const observation = loadLatestSourceObservation(passing.cwd);
  const legacy = observation.source.checklist.find(({ identity }) => identity.kind === 'legacy-position');
  const binding = sourceChecklistBinding(legacy);
  assert.equal([...binding.capturedText].length, 4000);
  assert.equal([...binding.identity.text].length, 4000,
    'the representable legacy identity preserves the exact 4000-code-point text');

  const failing = await fixtureFor(4001, 74, 'source-representability-fail');
  const before = durableSnapshot(changeDirectory(failing.cwd, failing.state.changeId));
  await assert.rejects(() => refreshSource({ cwd: failing.cwd, expectedRevision: failing.state.revision,
    sourceAdapter: failing.adapter }), (error) => error.code === 'SOURCE_CHECKLIST_UNREPRESENTABLE');
  assert.deepEqual(durableSnapshot(changeDirectory(failing.cwd, failing.state.changeId)), before,
    'an unrepresentable capturedText/legacy identity writes no receipt, transition, event, or state');
});

test('development finalization preflights representability and material source capacity', async () => {
  const verifiedFixture = async (label, number, changeId) => {
    const { cwd, sha } = repository(label);
    const issue = issueSource(number, `I_${changeId}`);
    const adapter = { async readIssue() { return structuredClone(issue); } };
    const planning = await initializeState({ cwd, changeId, mode: 'implement', baseBranch: 'main',
      planningRef: sha, source: { type: 'github-issue', repository: 'owner/repo', issueNumber: number,
        relationshipIntent: 'resolves' }, sourceAdapter: adapter });
    const plan = planFor(planning); plan.tasks[0].anticipatedPaths = ['first.txt'];
    let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
    const packet = packetFor(state, plan, 'state-task');
    state = bindTask({ cwd, packet, expectedRevision: state.revision });
    const worker = createWorkerFixture(cwd, state, packet);
    state = scheduleWave({ cwd, expectedRevision: state.revision });
    state = startTask({ cwd, taskId: packet.taskId, workerId: `${changeId}-worker`,
      expectedRevision: state.revision });
    writeFileSync(join(worker.path, 'first.txt'), `${changeId}\n`);
    git(worker.path, 'add', 'first.txt'); git(worker.path, 'commit', '-m', `test: ${changeId}`);
    state = acceptResult({ cwd, expectedRevision: state.revision, workerCwd: worker.path,
      result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']) });
    state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
    removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
    state = finalizeIntegration({ cwd, expectedRevision: state.revision });
    state = createValidationPlan({ cwd, expectedRevision: state.revision });
    state = runValidation({ cwd, expectedRevision: state.revision,
      runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
    state = createSpecialistPlan({ cwd, expectedRevision: state.revision });
    const context = buildVerifierContext({ cwd });
    state = recordVerifierResult({ cwd, expectedRevision: state.revision, result: {
      schemaVersion: 1, headSha: state.verification.headSha, contextDigest: digestJson(context),
      status: 'clean', summary: 'The exact integrated HEAD is clean.', findings: [],
      recordedAt: '2026-08-18T19:00:00.000Z',
    } });
    return { cwd, issue, adapter, state };
  };

  const passing = await verifiedFixture('final source representability pass', 75,
    'final-source-representability-pass');
  passing.issue.body += `\n- [ ] ${'😀'.repeat(4000)}`;
  passing.issue.updatedAt = '2026-08-18T19:01:00Z';
  const passed = await finalizeDevelopment({ cwd: passing.cwd, expectedRevision: passing.state.revision,
    sourceAdapter: passing.adapter });
  assert.equal(passed.phase, 'awaiting-decision');
  const passBinding = sourceChecklistBinding(loadLatestSourceObservation(passing.cwd).source.checklist
    .find(({ identity }) => identity.kind === 'legacy-position'));
  assert.equal([...passBinding.capturedText].length, 4000);
  assert.equal([...passBinding.identity.text].length, 4000);

  const unrepresentable = await verifiedFixture('final source representability fail', 76,
    'final-source-representability-fail');
  unrepresentable.issue.body += `\n- [ ] ${'😀'.repeat(4001)}`;
  unrepresentable.issue.updatedAt = '2026-08-18T19:02:00Z';
  const unrepresentableBefore = durableSnapshot(changeDirectory(unrepresentable.cwd,
    unrepresentable.state.changeId));
  await assert.rejects(() => finalizeDevelopment({ cwd: unrepresentable.cwd,
    expectedRevision: unrepresentable.state.revision, sourceAdapter: unrepresentable.adapter }),
  (error) => error.code === 'SOURCE_CHECKLIST_UNREPRESENTABLE');
  assert.deepEqual(durableSnapshot(changeDirectory(unrepresentable.cwd,
    unrepresentable.state.changeId)), unrepresentableBefore,
  'the final source gate writes nothing for a 4001-code-point checklist identity');

  const edge = await verifiedFixture('final source capacity edge', 77, 'final-source-capacity-edge');
  const previousObservation = loadLatestSourceObservation(edge.cwd);
  const initialBody = edge.issue.body;
  const bodyFor = (count) => `${initialBody}\n${Array.from({ length: count }, (_, index) =>
    `- [ ] <!-- aerstello:item=final-edge-${String(index + 1).padStart(3, '0')} --> ${'😀'.repeat(4000)}`).join('\n')}`;
  const capture = async (count) => {
    edge.issue.body = bodyFor(count); edge.issue.updatedAt = '2026-08-18T19:03:00Z';
    return captureSourceRefresh({ cwd: edge.cwd, planningSha: edge.state.planningSha,
      descriptor: previousObservation.descriptor, previousObservation, requirePlanningCheckout: false,
      githubReader: (options) => readGithubIssue({ ...options, adapter: edge.adapter }),
      now: () => new Date('2026-08-18T19:03:00.000Z') });
  };
  let fitting = null; let oversized = null;
  for (let count = 1; count <= 40; count += 1) {
    const candidate = await capture(count);
    try {
      preflightStateVerifierCapacity({ cwd: edge.cwd, pending: {
        sourceObservation: candidate.observation, verificationRound: edge.state.verification.round + 1,
        resetsVerification: true,
      } });
      fitting = { count, body: edge.issue.body };
    } catch (error) {
      assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE');
      oversized = { count, body: edge.issue.body }; break;
    }
  }
  assert.ok(fitting && oversized && oversized.count === fitting.count + 1,
    'constructed adjacent representable material-drift capacity outcomes');
  edge.issue.body = oversized.body;
  const edgeBefore = durableSnapshot(changeDirectory(edge.cwd, edge.state.changeId));
  await assert.rejects(() => finalizeDevelopment({ cwd: edge.cwd, expectedRevision: edge.state.revision,
    sourceAdapter: edge.adapter }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(changeDirectory(edge.cwd, edge.state.changeId)), edgeBefore,
    'over-capacity final source drift writes no observation, transition, event, or state');
  edge.issue.body = fitting.body;
  const completed = await finalizeDevelopment({ cwd: edge.cwd, expectedRevision: edge.state.revision,
    sourceAdapter: edge.adapter });
  assert.equal(completed.phase, 'awaiting-decision');
  assert.equal(loadLatestSourceObservation(edge.cwd).source.checklist.length,
    previousObservation.source.checklist.length + fitting.count,
  'the adjacent fitting material drift completes the final source transition');
});

test('validation planning binds release evidence to protected origin/main for a non-main development base', async () => {
  const { cwd, sha } = repository('protected release validation');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', sha);
  git(cwd, 'branch', 'develop', sha);
  const planning = await initializeState({ cwd, changeId: 'protected-release-validation', mode: 'implement',
    baseBranch: 'develop', planningRef: sha, source: descriptor });
  const releaseValue = { specialization: 'ops-workflow', affectedAreas: ['release'], riskTags: ['release'],
    browserVisible: false, relatedTestSelectionUncertain: false };
  const releaseSpecialization = { ...releaseValue,
    route: routeSpecialists({ ...releaseValue, testSelectionUncertain: false }, registry) };
  const plan = planFor(planning); plan.specialization = releaseSpecialization;
  plan.tasks[0].specialization = releaseSpecialization; plan.tasks[0].anticipatedPaths = ['first.txt'];
  const reservedRelease = preflightVerifierCapacity({ originalPlan: plan,
    sourceDigest: planning.source.observationDigest, featureDirectory: join(cwd, 'specs', 'features') }).context.evidence
    .find(({ kind, id }) => kind === 'release' && id === 'release-state');
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, packet); state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: packet.taskId, workerId: 'release-worker', expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'first.txt'), 'first\n'); git(worker.path, 'add', 'first.txt'); git(worker.path, 'commit', '-m', 'test: release worker');
  state = acceptResult({ cwd, result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']),
    workerCwd: worker.path, expectedRevision: state.revision });
  state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
  state = createValidationPlan({ cwd, expectedRevision: state.revision });
  const storedPlan = JSON.parse(readFileSync(join(changeDirectory(cwd, state.changeId), 'verification', 'rounds', '0001', 'validation-plan.json'), 'utf8'));
  assert.equal(storedPlan.releaseEvidence.releaseRef, 'origin/main');
  assert.equal(storedPlan.releaseEvidence.releaseRefSha, sha);
  const exactRelease = { kind: 'release', id: 'release-state', digest: storedPlan.releaseEvidence.evidenceDigest,
    summary: `Release state ${storedPlan.releaseEvidence.status}; base ${storedPlan.releaseEvidence.baseSha}; ref ${storedPlan.releaseEvidence.releaseRef} at ${storedPlan.releaseEvidence.releaseRefSha}; latest ${storedPlan.releaseEvidence.latestRelease ?? 'none'}; frozen migrations ${storedPlan.releaseEvidence.frozenMigrationCount}.` };
  assert.ok(Buffer.byteLength(JSON.stringify(reservedRelease), 'utf8')
    >= Buffer.byteLength(JSON.stringify(exactRelease), 'utf8'),
  'pre-capture protected-ref authority conservatively reserves the exact release summary envelope');

  const missing = await integratedSingleTaskFixture('missing protected release', releaseSpecialization);
  const before = readFileSync(join(changeDirectory(missing.cwd, missing.state.changeId), 'state.json'), 'utf8');
  assert.throws(() => createValidationPlan({ cwd: missing.cwd, expectedRevision: missing.state.revision }));
  assert.equal(readFileSync(join(changeDirectory(missing.cwd, missing.state.changeId), 'state.json'), 'utf8'), before);
  assert.equal(existsSync(join(changeDirectory(missing.cwd, missing.state.changeId), 'verification')), false);
});

test('stored union specialist routes are consumed in canonical reviewer order', async () => {
  const value = { specialization: 'api', affectedAreas: ['api'], riskTags: ['authorization', 'offline'],
    browserVisible: false, relatedTestSelectionUncertain: false };
  const specialize = { ...value, route: routeSpecialists({ ...value, testSelectionUncertain: false }, registry) };
  const fixture = await integratedSingleTaskFixture('specialist ordering', specialize);
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  assert.deepEqual(state.verification.requiredReviewerIds, ['security_reviewer', 'offline_realtime_reviewer']);
  const resultForReviewer = (reviewerId) => ({ schemaVersion: 1, reviewerId, headSha: state.verification.headSha,
    specialistPlanDigest: state.verification.specialistPlanDigest, status: 'clean', summary: `${reviewerId} is clean.`,
    findings: [], recordedAt: '2026-08-18T12:00:00.000Z' });
  assert.throws(() => recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: resultForReviewer('offline_realtime_reviewer') }), (error) => error.code === 'SPECIALIST_RESULT_ORDER');
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: resultForReviewer('security_reviewer') });
  assert.equal(state.phase, 'specialist-review');
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: resultForReviewer('offline_realtime_reviewer') });
  assert.equal(state.phase, 'verifying');
  assert.equal(buildVerifierContext({ cwd: fixture.cwd }).finalVerificationPriority, specialize.route.finalVerificationPriority);
});

test('routed finding inventory begins only at specialist-result admission', async () => {
  const { cwd, sha } = repository('specialist-result evidence reservation');
  const planning = await initializeState({ cwd, changeId: 'specialist-result-evidence-reservation',
    mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const specialize = dualReviewerSpecialization();
  const plan = planFor(planning); plan.specialization = specialize;
  plan.tasks[0].specialization = specialize; plan.tasks[0].anticipatedPaths = ['first.txt'];
  const initialProjection = preflightVerifierCapacity({ originalPlan: plan,
    sourceDigest: planning.source.observationDigest,
    featureDirectory: join(cwd, 'specs', 'features') });
  assert.equal(initialProjection.context.evidence.filter(({ id }) =>
    /^round-1-(?:security-reviewer|offline-realtime-reviewer)-reserved-\d+-identity$/u.test(id)).length,
  0, 'plan admission does not speculate about future finding inventory');
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTask({ cwd, packet, expectedRevision: state.revision });
  assert.equal(preflightStateVerifierCapacity({ cwd }).context.evidence.some(({ id }) =>
    /-reserved-\d+-identity$/u.test(id)), false,
  'packet binding still reserves only known route and result summaries');
  const worker = createWorkerFixture(cwd, state, packet);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: packet.taskId, workerId: 'early-capacity-worker',
    expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'first.txt'), 'early capacity\n');
  git(worker.path, 'add', 'first.txt'); git(worker.path, 'commit', '-m', 'test: early capacity worker');
  state = acceptResult({ cwd, expectedRevision: state.revision, workerCwd: worker.path,
    result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']) });
  state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
  state = createValidationPlan({ cwd, expectedRevision: state.revision });
  state = runValidation({ cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd, expectedRevision: state.revision });
  assert.equal(preflightStateVerifierCapacity({ cwd }).context.evidence.some(({ id }) =>
    /-reserved-\d+-identity$/u.test(id)), false,
  'the immutable specialist plan alone does not reserve speculative findings');
  const first = specialistResult(state, 'security_reviewer', 0);
  const admission = preflightStateVerifierCapacity({ cwd,
    pending: { specialistResult: first, authorizationRequiredFingerprints: [] } }).context;
  assert.equal(admission.evidence.filter(({ id }) =>
    /^round-1-offline-realtime-reviewer-reserved-\d+-identity$/u.test(id)).length, 100,
  'first-result admission reserves the final reviewer full remaining share');
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision,
    result: first });
  assert.equal(preflightStateVerifierCapacity({ cwd }).context.evidence.filter(({ id }) =>
    /^round-1-offline-realtime-reviewer-reserved-\d+-identity$/u.test(id)).length, 100,
  'the partial durable review retains the same dynamic reservation');
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 100) });
  assert.equal(state.phase, 'blocked');
  assert.equal(state.verification.unresolvedFindingFingerprints.length, 100);
});

test('specialist admission reserves the 100-fingerprint aggregate across routed reviewers', async () => {
  const fixture = await integratedSingleTaskFixture('specialist fingerprint reservation', dualReviewerSpecialization());
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const securityResult = (count) => specialistResult(state, 'security_reviewer', count);
  const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  const nearItemEdge = securityResult(50);
  nearItemEdge.findings = nearItemEdge.findings.map((finding) => ({ ...finding,
    summary: 's'.repeat(1801), evidence: 'e'.repeat(1801) }));
  assert.throws(() => recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: nearItemEdge }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE'
      && /requires \d+ items; maximum is 500/u.test(error.message));
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
    'the first near-edge result is rejected before consuming capacity reserved for the second reviewer');
  assert.throws(() => recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: securityResult(51) }), (error) => error.code === 'SPECIALIST_FINDING_CAPACITY_EXCEEDED');
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
    'capacity rejection creates no transition, event, receipt, or sidecar');

  const consolidated = securityResult(50);
  const projected = preflightStateVerifierCapacity({ cwd: fixture.cwd,
    pending: { specialistResult: consolidated, authorizationRequiredFingerprints: [] } }).context;
  assert.equal(projected.evidence.filter(({ id }) =>
    /^round-1-offline-realtime-reviewer-reserved-\d+-identity$/u.test(id)).length, 50,
  'first-result admission reserves canonical finding evidence for the final reviewer share');
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: consolidated });
  assert.equal(state.phase, 'specialist-review');
  assert.equal(state.verification.unresolvedFindingFingerprints.length, 50);
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 50) });
  assert.equal(state.phase, 'blocked');
  assert.equal(state.verification.unresolvedFindingFingerprints.length, 100,
    'compact 50 plus 50 records exactly the required aggregate maximum');
});

test('a clean first specialist leaves the schema-v1 maximum to the final reviewer', async () => {
  const fixture = await integratedSingleTaskFixture('clean specialist reservation', dualReviewerSpecialization());
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'security_reviewer', 0) });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 100) });
  assert.equal(state.phase, 'blocked');
  assert.equal(state.verification.unresolvedFindingFingerprints.length, 100);
});

test('new rounds skip missing same-role results and reserve the prior identity plus authorization', async () => {
  const fixture = await integratedSingleTaskFixture('future repeated specialist reservation',
    dualReviewerSpecialization());
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const prior = specialistResult(state, 'security_reviewer', 1);
  const longId = (prefix, index) => {
    const start = `${prefix}-${String(index).padStart(3, '0')}-`;
    return `${start}${'x'.repeat(128 - start.length)}`;
  };
  prior.findings[0] = { ...prior.findings[0], id: 'chunked-repeat-identity',
    affectedAreas: ['api', 'web', 'shared', 'workflow', 'documentation', 'release', 'migration'],
    recommendedSpecialization: 'data-integrity',
    riskTags: ['authentication', 'authorization', 'billing', 'money', 'migration', 'release',
      'offline', 'realtime', 'localization', 'responsive', 'deployment', 'workflow'],
    criterionIds: Array.from({ length: 12 }, (_, index) => longId('criterion', index)),
    invariantIds: Array.from({ length: 12 }, (_, index) => longId('invariant', index)) };
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision, result: prior });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 0) });
  const priorReceipt = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId),
    'verification', 'rounds', '0001', 'specialists', 'security_reviewer.json'), 'utf8'));
  const finding = priorReceipt.findings[0];
  const fingerprint = findingFingerprint({ sourceKind: 'specialist', sourceRole: 'security_reviewer', finding });
  const disposition = { schemaVersion: 1, sourceKind: 'specialist', sourceRole: 'security_reviewer',
    sourceResultDigest: digestJson(priorReceipt), headSha: state.verification.headSha,
    findingId: finding.id, fingerprint, disposition: 'duplicate',
    reason: 'Record the prior identity before a validation-only skipped round.',
    amendmentId: null, replacementCriterionId: null,
    replacementTaskId: null, recordedAt: '2026-08-18T18:00:00.000Z' };
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition });
  assert.equal(state.phase, 'integrated');
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  assert.equal(state.verification.round, 2);
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 7, signal: null, stdout: '', stderr: 'corrective work required' }) });
  const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId),
    'plan', 'plan.json'), 'utf8'));
  const resultingPlan = structuredClone(original); resultingPlan.planRevision = 2;
  resultingPlan.criteria.push({ id: 'validation-repeat-remediation-criterion',
    description: 'The skipped-round validation remediation is complete.', disposition: 'owned',
    ownerTaskId: 'validation-repeat-remediation-task', deferredReason: null });
  resultingPlan.tasks.push({ ...resultingPlan.tasks[0], id: 'validation-repeat-remediation-task',
    title: 'Implement skipped-round remediation', objective: 'Resolve the failed validation.',
    criterionIds: ['validation-repeat-remediation-criterion'], checklistItemIds: [], dependsOn: ['state-task'],
    anticipatedPaths: ['repeat-remediation.txt'] });
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, resultingPlan,
    planningEvidence: [], amendment: { id: 'validation-repeat-remediation',
      reason: 'Resolve the exact failed validation after the skipped specialist round.',
      authorization: 'operator',
      trigger: `validation-failure:${state.verification.validationResultDigests.at(-1)}`,
      delta: { addedTaskIds: ['validation-repeat-remediation-task'] }, invalidatedEvidence: [] } });
  assert.equal(state.verification, null);
  const beforeResult = preflightStateVerifierCapacity({ cwd: fixture.cwd }).context;
  assert.equal(beforeResult.evidence.some(({ id }) => id.startsWith('round-3-')), false,
    'the reset plan does not invent round-three findings before specialist-result admission');

  const packet = packetFor(state, resultingPlan, 'validation-repeat-remediation-task');
  state = bindTask({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(fixture.cwd, state, packet);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: packet.taskId, workerId: 'repeat-remediation-worker',
    expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'repeat-remediation.txt'), 'repeat remediation\n');
  git(worker.path, 'add', 'repeat-remediation.txt');
  git(worker.path, 'commit', '-m', 'test: skipped-round remediation');
  state = acceptResult({ cwd: fixture.cwd, expectedRevision: state.revision, workerCwd: worker.path,
    result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['repeat-remediation.txt']) });
  state = integrateTask({ cwd: fixture.cwd, taskId: packet.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd: fixture.cwd, changeId: state.changeId, taskId: packet.taskId });
  state = finalizeIntegration({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  assert.equal(state.verification.round, 3);
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const repeated = specialistResult(state, 'security_reviewer', 0);
  repeated.status = 'findings'; repeated.summary = 'The prior security finding repeated after a skipped round.';
  repeated.findings = [finding];
  const projection = preflightStateVerifierCapacity({ cwd: fixture.cwd,
    pending: { specialistResult: repeated, authorizationRequiredFingerprints: [fingerprint] } }).context;
  const roundThreeDispositions = projection.evidence.filter(({ kind, summary }) =>
    kind === 'finding-disposition' && summary.startsWith('Finding disposition authority:'));
  assert.equal(roundThreeDispositions.filter(({ id }) => id.startsWith('round-3-')).length, 100,
    'the exact repeated result reserves its finding plus the final reviewer remaining share');
  const repeatedIdentity = projection.evidence.filter(({ id }) =>
    id.startsWith('round-3-security-reviewer-chunked-repeat-identity-identity'));
  assert.ok(repeatedIdentity.length > 1,
    'the most recent applicable same-role identity skips the round without a specialist result');
  const authorizations = projection.evidence.filter(({ id }) =>
    id.startsWith(`round-3-${fingerprint.slice(7, 19)}-authorization`));
  assert.equal(authorizations.length, 1,
    'the future repeated identity reserves its mandatory authorization authority');
  const withoutAuthorization = projection.evidence.filter((entry) => !authorizations.includes(entry));
  const filler = Array.from({ length: 500 - withoutAuthorization.length }, (_, index) => ({
    kind: 'criterion', id: `repeat-edge-filler-${String(index + 1).padStart(3, '0')}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: 'x' }));
  assert.equal(boundVerifierEvidence([...withoutAuthorization, ...filler]).length, 500);
  assert.throws(() => boundVerifierEvidence([...withoutAuthorization, ...filler, ...authorizations]),
    (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE'
      && /requires 501 items; maximum is 500/u.test(error.message));
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision, result: repeated });
  assert.deepEqual(state.verification.humanDecisionRequiredFingerprints, [fingerprint]);
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 0) });
  assert.equal(state.phase, 'blocked');
});

test('an intervening clean same-role result stops prior repeat applicability', async () => {
  const fixture = await integratedSingleTaskFixture('intervening clean specialist applicability',
    dualReviewerSpecialization());
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'security_reviewer', 1) });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 0) });
  const firstReceipt = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId),
    'verification', 'rounds', '0001', 'specialists', 'security_reviewer.json'), 'utf8'));
  const firstFinding = firstReceipt.findings[0];
  const firstFingerprint = findingFingerprint({ sourceKind: 'specialist',
    sourceRole: 'security_reviewer', finding: firstFinding });
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition: {
    schemaVersion: 1, sourceKind: 'specialist', sourceRole: 'security_reviewer',
    sourceResultDigest: digestJson(firstReceipt), headSha: state.verification.headSha,
    findingId: firstFinding.id, fingerprint: firstFingerprint, disposition: 'duplicate',
    reason: 'Retain the first-round identity only as historical evidence.', amendmentId: null,
    replacementCriterionId: null, replacementTaskId: null, recordedAt: '2026-08-18T18:10:00.000Z',
  } });
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'security_reviewer', 0) });
  state = recordSpecialistResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 0) });
  const context = buildVerifierContext({ cwd: fixture.cwd });
  const verifierFinding = { id: 'open-third-round', priority: 'P2',
    summary: 'One non-actionable verifier note opens a later round.',
    evidence: 'The same-role clean specialist result remains the latest applicable authority.',
    affectedAreas: ['workflow'], recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'],
    criterionIds: ['durable-state'], invariantIds: [] };
  const verifierResult = { schemaVersion: 1, headSha: state.verification.headSha,
    contextDigest: digestJson(context), status: 'findings', summary: 'Record a non-actionable note.',
    findings: [verifierFinding], recordedAt: '2026-08-18T18:11:00.000Z' };
  state = recordVerifierResult({ cwd: fixture.cwd, expectedRevision: state.revision, result: verifierResult });
  const verifierFingerprint = findingFingerprint({ sourceKind: 'verifier',
    sourceRole: 'development_integration_verifier', finding: verifierFinding });
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition: {
    schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
    sourceResultDigest: digestJson(verifierResult), headSha: state.verification.headSha,
    findingId: verifierFinding.id, fingerprint: verifierFingerprint, disposition: 'duplicate',
    reason: 'The note requires no code change.', amendmentId: null, replacementCriterionId: null,
    replacementTaskId: null, recordedAt: '2026-08-18T18:12:00.000Z',
  } });
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  assert.equal(state.verification.round, 3);
  const projection = preflightStateVerifierCapacity({ cwd: fixture.cwd }).context;
  assert.equal(projection.evidence.some(({ id }) =>
    id.startsWith(`round-3-${firstFingerprint.slice(7, 19)}-authorization`)), false);
  assert.equal(projection.evidence.some(({ id }) =>
    id.startsWith('round-3-security-reviewer-security-reviewer-finding-001-identity')), false,
  'the clean round-two security receipt stops the round-one finding from being reserved as a repeat');
});

test('projected admission equals final mixed lifecycle evidence across every durable authority', async () => {
  const { cwd, sha } = repository('combined verifier projection parity');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', sha);
  const planning = await initializeState({ cwd, changeId: 'combined-verifier-projection', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const specialize = dualReviewerReleaseSpecialization();
  let effectivePlan = planFor(planning); effectivePlan.specialization = specialize;
  effectivePlan.tasks[0].specialization = specialize; effectivePlan.tasks[0].anticipatedPaths = ['first.txt'];
  effectivePlan.tasks[0].unsplittable = { reason: 'Release workflow and API authority must remain serialized.',
    serializedDomains: ['api', 'release'], highestRiskSpecialization: 'data-integrity' };
  let state = acceptPlan({ cwd, plan: effectivePlan, expectedRevision: planning.revision });

  const integratePlannedTask = (current, plan, taskId, path, workerId) => {
    const packet = packetFor(current, plan, taskId);
    let next = bindTask({ cwd, packet, expectedRevision: current.revision });
    const worker = createWorkerFixture(cwd, next, packet);
    next = scheduleWave({ cwd, expectedRevision: next.revision });
    next = startTask({ cwd, taskId, workerId, expectedRevision: next.revision });
    writeFileSync(join(worker.path, path), `${taskId}\n`); git(worker.path, 'add', path);
    git(worker.path, 'commit', '-m', `test: ${taskId}`);
    next = acceptResult({ cwd, expectedRevision: next.revision, workerCwd: worker.path,
      result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), [path]) });
    next = integrateTask({ cwd, taskId, expectedRevision: next.revision });
    removeTaskWorktree({ cwd, changeId: next.changeId, taskId });
    return finalizeIntegration({ cwd, expectedRevision: next.revision });
  };
  const prepareRound = (current) => {
    let next = createValidationPlan({ cwd, expectedRevision: current.revision });
    next = runValidation({ cwd, expectedRevision: next.revision,
      runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
    return createSpecialistPlan({ cwd, expectedRevision: next.revision });
  };
  const recordCleanSpecialists = (current) => {
    let next = recordSpecialistResult({ cwd, expectedRevision: current.revision,
      result: specialistResult(current, 'security_reviewer', 0) });
    return recordSpecialistResult({ cwd, expectedRevision: next.revision,
      result: specialistResult(next, 'offline_realtime_reviewer', 0) });
  };

  state = integratePlannedTask(state, effectivePlan, 'state-task', 'first.txt', 'parity-worker-one');
  state = prepareRound(state);
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'security_reviewer', 1) });
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'offline_realtime_reviewer', 0) });
  const specialistReceipt = JSON.parse(readFileSync(join(changeDirectory(cwd, state.changeId),
    'verification', 'rounds', '0001', 'specialists', 'security_reviewer.json'), 'utf8'));
  const specialistFinding = specialistReceipt.findings[0];
  const specialistFingerprint = findingFingerprint({ sourceKind: 'specialist',
    sourceRole: 'security_reviewer', finding: specialistFinding });
  state = recordFindingDisposition({ cwd, expectedRevision: state.revision, disposition: {
    schemaVersion: 1, sourceKind: 'specialist', sourceRole: 'security_reviewer',
    sourceResultDigest: digestJson(specialistReceipt), headSha: state.verification.headSha,
    findingId: specialistFinding.id, fingerprint: specialistFingerprint, disposition: 'duplicate',
    reason: 'Retain the specialist observation as complete historical authority.', amendmentId: null,
    replacementCriterionId: null, replacementTaskId: null, recordedAt: '2026-08-18T13:00:00.000Z',
  } });

  state = prepareRound(state);
  state = recordCleanSpecialists(state);
  const repeatedFinding = { id: 'projected-parity-finding', priority: 'P1',
    summary: 'The mixed lifecycle requires ordinary remediation.',
    evidence: 'Exact verifier evidence identifies the durable remediation need.', affectedAreas: ['workflow'],
    recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'],
    criterionIds: ['durable-state'], invariantIds: [] };
  let context = buildVerifierContext({ cwd });
  const firstVerifier = { schemaVersion: 1, headSha: state.verification.headSha,
    contextDigest: digestJson(context), status: 'findings', summary: 'One remediation is required.',
    findings: [repeatedFinding], recordedAt: '2026-08-18T14:00:00.000Z' };
  state = recordVerifierResult({ cwd, expectedRevision: state.revision, result: firstVerifier });
  const verifierFingerprint = findingFingerprint({ sourceKind: 'verifier',
    sourceRole: 'development_integration_verifier', finding: repeatedFinding });
  const firstDisposition = { schemaVersion: 1, sourceKind: 'verifier',
    sourceRole: 'development_integration_verifier', sourceResultDigest: digestJson(firstVerifier),
    headSha: state.verification.headSha, findingId: repeatedFinding.id, fingerprint: verifierFingerprint,
    disposition: 'duplicate', reason: 'Retain the exact finding for repeat-loop evidence.',
    amendmentId: null, replacementCriterionId: null,
    replacementTaskId: null, recordedAt: '2026-08-18T14:01:00.000Z' };
  state = recordFindingDisposition({ cwd, expectedRevision: state.revision, disposition: firstDisposition });

  state = prepareRound(state);
  state = recordCleanSpecialists(state);
  context = buildVerifierContext({ cwd });
  const repeatedVerifier = { ...firstVerifier, headSha: state.verification.headSha,
    contextDigest: digestJson(context), summary: 'The exact verifier finding repeated.',
    recordedAt: '2026-08-18T15:00:00.000Z' };
  state = recordVerifierResult({ cwd, expectedRevision: state.revision, result: repeatedVerifier });
  assert.deepEqual(state.verification.humanDecisionRequiredFingerprints, [verifierFingerprint]);
  const reservedAuthorization = preflightStateVerifierCapacity({ cwd }).context.evidence
    .find(({ id }) => id === `round-3-${verifierFingerprint.slice(7, 19)}-authorization`);
  const authorization = { fingerprint: verifierFingerprint,
    reason: `${'\u0000'.repeat(511)}${'€'.repeat(171)}`,
    authorizedBy: `${'\u0000'.repeat(64)}${'€'.repeat(64)}` };
  state = authorizeRepeatedFinding({ cwd, expectedRevision: state.revision, authorization });
  const exactAuthorization = preflightStateVerifierCapacity({ cwd }).context.evidence
    .find(({ id }) => id === `round-3-${verifierFingerprint.slice(7, 19)}-authorization`);
  assert.equal(Buffer.byteLength(authorization.reason, 'utf8'), 1024);
  assert.equal(Buffer.byteLength(authorization.authorizedBy, 'utf8'), 256);
  assert.ok(Buffer.byteLength(JSON.stringify(reservedAuthorization), 'utf8')
    >= Buffer.byteLength(JSON.stringify(exactAuthorization), 'utf8'),
  'escaped and multibyte maximum authorization fields are conservatively reserved in serialized bytes');
  const secondDisposition = { ...firstDisposition, sourceResultDigest: digestJson(repeatedVerifier),
    headSha: state.verification.headSha, reason: 'Create the repeated-finding remediation task.',
    disposition: 'actionable',
    amendmentId: 'combined-remediation-two', replacementCriterionId: 'combined-criterion-two',
    replacementTaskId: 'combined-task-two', recordedAt: '2026-08-18T15:02:00.000Z' };
  state = recordFindingDisposition({ cwd, expectedRevision: state.revision, disposition: secondDisposition });
  let nextPlan = structuredClone(effectivePlan); nextPlan.planRevision = 2;
  nextPlan.criteria.push({ id: secondDisposition.replacementCriterionId,
    description: 'The repeated mixed-authority remediation is complete.', disposition: 'owned',
    ownerTaskId: secondDisposition.replacementTaskId, deferredReason: null });
  nextPlan.tasks.push({ ...nextPlan.tasks[0], id: secondDisposition.replacementTaskId,
    title: 'Implement repeated combined remediation', objective: 'Resolve the repeated verifier finding.',
    criterionIds: [secondDisposition.replacementCriterionId], checklistItemIds: [],
    dependsOn: ['state-task'], anticipatedPaths: ['combined-two.txt'] });
  state = amendPlan({ cwd, expectedRevision: state.revision, resultingPlan: nextPlan, planningEvidence: [],
    amendment: { id: secondDisposition.amendmentId, reason: 'Resolve the authorized repeated finding.',
      authorization: 'operator', trigger: verifierFingerprint,
      delta: { addedTaskIds: [secondDisposition.replacementTaskId] }, invalidatedEvidence: [] } });
  effectivePlan = nextPlan;
  state = integratePlannedTask(state, effectivePlan, secondDisposition.replacementTaskId,
    'combined-two.txt', 'parity-worker-two');

  state = prepareRound(state);
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision,
    result: specialistResult(state, 'security_reviewer', 0) });
  const finalOffline = specialistResult(state, 'offline_realtime_reviewer', 0);
  const projected = preflightStateVerifierCapacity({ cwd,
    pending: { specialistResult: finalOffline, authorizationRequiredFingerprints: [] } }).context;
  state = recordSpecialistResult({ cwd, expectedRevision: state.revision, result: finalOffline });
  const actual = buildVerifierContext({ cwd });
  assert.deepEqual(projected, actual,
    'the last verifier-visible admission and final context share one exact canonical projection');
  for (const [kind, id] of [
    ['release', 'release-state'], ['specialist-result', 'security-reviewer'],
    ['specialist-result', 'offline-realtime-reviewer'],
    ['finding-disposition', 'round-1-security-reviewer-finding-001'],
    ['finding-disposition', 'round-2-projected-parity-finding'],
    ['finding-disposition', 'round-3-projected-parity-finding'],
    ['amendment', 'combined-remediation-two'],
  ]) assert.ok(actual.evidence.some((entry) => entry.kind === kind && entry.id === id), `${kind}:${id} is complete`);
  assert.ok(actual.evidence.some(({ kind }) => kind === 'validation-result'), 'exact validation results are complete');
  assert.ok(actual.evidence.some(({ id }) => id === `round-3-${verifierFingerprint.slice(7, 19)}-authorization`),
    'receipt-backed repeated-finding authorization is complete');
});

test('actionable remediation reserves the behavior-mapper row at the exact 14-vs-15 item edge', async () => {
  const fixture = await integratedSingleTaskFixture('behavior mapper remediation edge');
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const context = buildVerifierContext({ cwd: fixture.cwd });
  const finding = { id: 'mapper-edge-finding', priority: 'P2', summary: 'Behavior mapping may be required.',
    evidence: 'The eventual replacement route is not known until the guarded amendment.',
    affectedAreas: ['workflow'], recommendedSpecialization: 'ops-workflow',
    riskTags: [], criterionIds: [], invariantIds: [] };
  const verifierResult = { schemaVersion: 1, headSha: state.verification.headSha,
    contextDigest: digestJson(context), status: 'findings', summary: 'Mapper-capacity findings require disposition.',
    findings: [finding], recordedAt: '2026-08-18T17:30:00.000Z' };
  const actionable = { schemaVersion: 1, sourceKind: 'verifier',
    sourceRole: 'development_integration_verifier', sourceResultDigest: digestJson(verifierResult),
    headSha: state.verification.headSha, findingId: finding.id,
    fingerprint: findingFingerprint({ sourceKind: 'verifier',
      sourceRole: 'development_integration_verifier', finding }),
    disposition: 'actionable', reason: 'Route a behavior-mapped ordinary remediation.',
    amendmentId: 'mapper-edge-amendment', replacementCriterionId: 'mapper-edge-criterion',
    replacementTaskId: 'mapper-edge-task', recordedAt: '2026-08-18T17:31:00.000Z' };
  const viableProjection = preflightStateVerifierCapacity({ cwd: fixture.cwd,
    pending: { verifierResult, disposition: actionable } }).context;
  const remediationEvidence = viableProjection.evidence.filter(({ summary }) =>
    summary.startsWith('Reserved schema-minimal viable remediation authority for mapper-edge-amendment:'));
  assert.equal(remediationEvidence.length, 15);
  assert.ok(remediationEvidence.some(({ kind, id }) => kind === 'planning-helper'
    && id === 'mapper-edge-task-behavior-mapper'),
  'the viable route reserves the potential behavior-mapper evidence row');

  const filler = Array.from({ length: 486 }, (_, index) => ({ kind: 'criterion',
    id: `mapper-edge-filler-${String(index + 1).padStart(3, '0')}`,
    digest: `sha256:${String(index).padStart(64, '0')}`, summary: 'x' }));
  assert.equal(boundVerifierEvidence([...filler, ...remediationEvidence.slice(0, 14)]).length, 500,
    'the old 14-item bundle would fit at the exact edge');
  assert.throws(() => boundVerifierEvidence([...filler, ...remediationEvidence]),
    (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE'
      && /requires 501 items; maximum is 500/u.test(error.message));
});

test('oversized actionable disposition is atomic and a concise retry remains writable', async () => {
  const fixture = await integratedSingleTaskFixture('disposition writer capacity');
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const context = buildVerifierContext({ cwd: fixture.cwd });
  const resultForLength = (length) => ({ schemaVersion: 1, headSha: state.verification.headSha,
    contextDigest: digestJson(context), status: 'findings', summary: 'Capacity-edge findings require disposition.',
    findings: Array.from({ length: 100 }, (_, index) => ({
      id: `disposition-edge-${String(index + 1).padStart(3, '0')}`, priority: 'P2',
      summary: 's'.repeat(length), evidence: 'e'.repeat(length), affectedAreas: ['workflow'],
      recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'],
      criterionIds: ['durable-state'], invariantIds: [],
    })), recordedAt: '2026-08-18T17:40:00.000Z' });
  const dispositionFor = (result, oversized) => {
    const finding = result.findings[0];
    return { schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
      sourceResultDigest: digestJson(result), headSha: state.verification.headSha, findingId: finding.id,
      fingerprint: findingFingerprint({ sourceKind: 'verifier',
        sourceRole: 'development_integration_verifier', finding }), disposition: 'actionable',
      reason: oversized ? '😀'.repeat(4000) : 'Create the concise ordinary remediation task.',
      amendmentId: oversized ? `a-${'x'.repeat(126)}` : 'disposition-edge-amendment',
      replacementCriterionId: oversized ? `c-${'x'.repeat(126)}` : 'disposition-edge-criterion',
      replacementTaskId: oversized ? `t-${'x'.repeat(126)}` : 'disposition-edge-task',
      recordedAt: '2026-08-18T17:41:00.000Z' };
  };

  let low = 1; let high = 4000; let result = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = resultForLength(middle);
    try {
      preflightStateVerifierCapacity({ cwd: fixture.cwd,
        pending: { verifierResult: candidate, disposition: dispositionFor(candidate, false) } });
      result = candidate; low = middle + 1;
    } catch (error) {
      assert.equal(error.code, 'VERIFIER_CONTEXT_TOO_LARGE'); high = middle - 1;
    }
  }
  assert.ok(result, 'constructed a verifier result whose concise actionable disposition still fits');
  const concise = dispositionFor(result, false);
  const oversized = dispositionFor(result, true);
  assert.throws(() => preflightStateVerifierCapacity({ cwd: fixture.cwd,
    pending: { verifierResult: result, disposition: oversized } }),
  (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');

  state = recordVerifierResult({ cwd: fixture.cwd, expectedRevision: state.revision, result });
  const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision,
    disposition: oversized }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
    'oversized disposition writes no state, event, transition, receipt, or sidecar bytes');
  const retried = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision,
    disposition: concise });
  assert.equal(retried.revision, state.revision + 1);
  assert.equal(retried.phase, 'blocked', 'the concise retry records while remaining findings stay unresolved');
});

test('final-verifier finding disposition creates ordinary remediation work without deleting round history', async () => {
  const fixture = await integratedSingleTaskFixture('finding remediation', behaviorSpecialization());
  let state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: fixture.state.revision });
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const context = buildVerifierContext({ cwd: fixture.cwd });
  const finding = { id: 'missing-recovery-check', priority: 'P1', summary: 'Recovery coverage is incomplete.',
    evidence: 'The exact integrated lifecycle context lacks the required recovery assertion.', affectedAreas: ['workflow'],
    recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'], criterionIds: ['durable-state'], invariantIds: [] };
  const siblingFinding = { ...finding, id: 'duplicate-recovery-note', priority: 'P2', summary: 'The same recovery gap was also noted.' };
  const oversizedVerifierResult = { schemaVersion: 1, headSha: state.verification.headSha,
    contextDigest: digestJson(context), status: 'findings', summary: 's'.repeat(4000),
    findings: Array.from({ length: 100 }, (_, index) => ({ ...finding,
      id: `oversized-verifier-${String(index + 1).padStart(3, '0')}`,
      summary: 's'.repeat(4000), evidence: 'e'.repeat(4000) })), recordedAt: '2026-08-18T11:59:00.000Z' };
  const beforeVerifier = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => recordVerifierResult({ cwd: fixture.cwd, expectedRevision: state.revision,
    result: oversizedVerifierResult }), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE');
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), beforeVerifier,
    'oversized verifier semantics create no durable evidence');
  const verifierResult = { schemaVersion: 1, headSha: state.verification.headSha, contextDigest: digestJson(context),
    status: 'findings', summary: 'Recovery findings require disposition.', findings: [finding, siblingFinding], recordedAt: '2026-08-18T12:00:00.000Z' };
  state = recordVerifierResult({ cwd: fixture.cwd, expectedRevision: state.revision, result: verifierResult });
  const fingerprint = findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier', finding });
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition: {
    schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
    sourceResultDigest: digestJson(verifierResult), headSha: state.verification.headSha, findingId: finding.id, fingerprint,
    disposition: 'actionable', reason: 'Add recovery coverage as ordinary planned work.', amendmentId: 'remediate-recovery',
    replacementCriterionId: 'recovery-remediation', replacementTaskId: 'recovery-remediation-task', recordedAt: '2026-08-18T12:05:00.000Z',
  } });
  const resultingPlan = planFor(state, 2);
  resultingPlan.specialization = behaviorSpecialization();
  resultingPlan.tasks[0].specialization = behaviorSpecialization();
  resultingPlan.tasks[0].anticipatedPaths = ['first.txt'];
  resultingPlan.criteria.push({ id: 'recovery-remediation', description: 'Recovery coverage is complete.', disposition: 'owned',
    ownerTaskId: 'recovery-remediation-task', deferredReason: null });
  resultingPlan.tasks.push({ ...resultingPlan.tasks[0], id: 'recovery-remediation-task', title: 'Add recovery coverage',
    objective: 'Implement the exact finding remediation.', criterionIds: ['recovery-remediation'], checklistItemIds: [],
    dependsOn: ['state-task'], anticipatedPaths: ['first.txt'] });
  const amendment = {
    id: 'remediate-recovery', reason: 'Resolve exact verifier finding.', authorization: 'Human-approved remediation.',
    trigger: fingerprint, delta: { addedTaskIds: ['recovery-remediation-task'] }, invalidatedEvidence: [],
  };
  const amendmentPlanningEvidence = [mapperEvidence(state.planningSha, 2, 'Remediation behavior coverage is mapped.')];
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: { ...amendment, trigger: 'manual-override' }, resultingPlan, planningEvidence: amendmentPlanningEvidence }),
  (error) => error.code === 'INVALID_AMENDMENT');
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, amendment, resultingPlan,
    planningEvidence: amendmentPlanningEvidence }),
    (error) => ['RECEIPT_MISSING', 'INVALID_AMENDMENT'].includes(error.code));
  const siblingFingerprint = findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier', finding: siblingFinding });
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition: {
    schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier', sourceResultDigest: digestJson(verifierResult),
    headSha: state.verification.headSha, findingId: siblingFinding.id, fingerprint: siblingFingerprint, disposition: 'duplicate',
    reason: 'Same remediation covers this duplicate note.', amendmentId: null, replacementCriterionId: null, replacementTaskId: null,
    recordedAt: '2026-08-18T12:06:00.000Z',
  } });
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, amendment, resultingPlan,
    planningEvidence: amendmentPlanningEvidence });
  assert.equal(state.phase, 'implementing');
  assert.equal(state.verification, null);
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'recovery-remediation-task').status, 'unbound');
  assert.ok(existsSync(join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0001', 'verifier-result.json')));
  const remediationPacket = packetFor(state, resultingPlan, 'recovery-remediation-task');
  remediationPacket.behaviorMapperEvidence = amendmentPlanningEvidence[0];
  state = bindTask({ cwd: fixture.cwd, packet: remediationPacket, expectedRevision: state.revision });
  const remediationWorker = createWorkerFixture(fixture.cwd, state, remediationPacket);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: remediationPacket.taskId, workerId: 'worker-two', expectedRevision: state.revision });
  writeFileSync(join(remediationWorker.path, 'first.txt'), 'covered\n'); git(remediationWorker.path, 'add', 'first.txt');
  git(remediationWorker.path, 'commit', '-m', 'test: remediate finding');
  state = acceptResult({ cwd: fixture.cwd, expectedRevision: state.revision, workerCwd: remediationWorker.path,
    result: resultFor(remediationPacket, 'implemented', git(remediationWorker.path, 'rev-parse', 'HEAD'), ['first.txt']) });
  state = integrateTask({ cwd: fixture.cwd, taskId: remediationPacket.taskId, expectedRevision: state.revision });
  removeTaskWorktree({ cwd: fixture.cwd, changeId: state.changeId, taskId: remediationPacket.taskId });
  state = finalizeIntegration({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = createValidationPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  assert.equal(state.verification.round, 2, 'round identity comes from immutable history after verification reset');
  state = runValidation({ cwd: fixture.cwd, expectedRevision: state.revision,
    runner: () => ({ status: 0, signal: null, stdout: 'passed', stderr: '' }) });
  state = createSpecialistPlan({ cwd: fixture.cwd, expectedRevision: state.revision });
  const repeatedContext = buildVerifierContext({ cwd: fixture.cwd });
  const originalPlan = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
  for (const [id, expected] of [
    ['original-plan-criterion-durable-state', originalPlan.criteria[0]],
    ['original-plan-decision-storage-root', originalPlan.decisions[0]],
    [`original-plan-checklist-${originalPlan.checklistMappings[0].id}`, originalPlan.checklistMappings[0]],
    ['original-plan-task-state-task', originalPlan.tasks[0]],
  ]) {
    const record = repeatedContext.evidence.find((entry) => entry.id === id);
    assert.ok(record, `${id} is projected`);
    assert.deepEqual(JSON.parse(record.summary.slice(record.summary.indexOf('\n') + 1)), expected,
      `${id} retains complete original semantics`);
  }
  const amendmentRecord = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'amendments', '0001.json'), 'utf8'));
  const amendmentEvidence = repeatedContext.evidence.find(({ kind, id }) => kind === 'amendment' && id === amendment.id);
  const amendmentAuthority = JSON.parse(amendmentEvidence.summary.slice(amendmentEvidence.summary.indexOf('\n') + 1));
  assert.equal(amendmentAuthority.authorization, amendment.authorization);
  assert.equal(amendmentAuthority.previousDigest, amendmentRecord.previousDigest);
  assert.equal(amendmentAuthority.newDigest, amendmentRecord.newDigest);
  assert.equal(amendmentAuthority.repositorySha, amendmentRecord.repositorySha);
  assert.deepEqual(amendmentAuthority.invalidatedEvidence, amendment.invalidatedEvidence);
  assert.deepEqual(amendmentAuthority.delta, amendment.delta);
  assert.deepEqual(amendmentAuthority.resultingPlanIdentity,
    { changeId: resultingPlan.changeId, planRevision: resultingPlan.planRevision, digest: digestJson(resultingPlan) });
  const projectedProvenance = repeatedContext.evidence.find(({ id }) => id === 'remediate-recovery-provenance-record-1');
  assert.deepEqual(JSON.parse(projectedProvenance.summary.slice(projectedProvenance.summary.indexOf('\n') + 1)), amendmentPlanningEvidence[0]);
  const actionableDispositionEvidence = repeatedContext.evidence.find(({ kind, id }) => kind === 'finding-disposition'
    && id === 'round-1-missing-recovery-check');
  const actionableAuthority = JSON.parse(actionableDispositionEvidence.summary.slice(actionableDispositionEvidence.summary.indexOf('\n') + 1));
  assert.deepEqual({ amendmentId: actionableAuthority.amendmentId, replacementCriterionId: actionableAuthority.replacementCriterionId,
    replacementTaskId: actionableAuthority.replacementTaskId }, {
    amendmentId: amendment.id, replacementCriterionId: 'recovery-remediation', replacementTaskId: 'recovery-remediation-task',
  }, 'historical actionable disposition exposes its exact remediation authority mapping');
  const duplicateDispositionEvidence = repeatedContext.evidence.find(({ kind, id }) => kind === 'finding-disposition'
    && id === 'round-1-duplicate-recovery-note');
  const duplicateAuthority = JSON.parse(duplicateDispositionEvidence.summary.slice(duplicateDispositionEvidence.summary.indexOf('\n') + 1));
  assert.deepEqual({ amendmentId: duplicateAuthority.amendmentId, replacementCriterionId: duplicateAuthority.replacementCriterionId,
    replacementTaskId: duplicateAuthority.replacementTaskId }, { amendmentId: null, replacementCriterionId: null, replacementTaskId: null },
  'non-actionable disposition cannot imply remediation authority');
  const amendmentPath = join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'amendments', '0001.json');
  writeReceiptJson(amendmentPath, { ...amendmentRecord, previousDigest: `sha256:${'0'.repeat(64)}` });
  assert.throws(() => buildVerifierContext({ cwd: fixture.cwd }),
    (error) => ['AMENDMENT_CHAIN_INVALID', 'RECOVERY_EVIDENCE_INVALID'].includes(error.code));
  writeReceiptJson(amendmentPath, amendmentRecord);
  const repeatedResult = { ...verifierResult, findings: [finding], summary: 'The remediation finding repeated.',
    headSha: state.verification.headSha, contextDigest: digestJson(repeatedContext),
    recordedAt: '2026-08-18T13:00:00.000Z' };
  state = recordVerifierResult({ cwd: fixture.cwd, expectedRevision: state.revision, result: repeatedResult });
  assert.deepEqual(state.verification.humanDecisionRequiredFingerprints, [fingerprint]);
  const repeatedDisposition = { schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
    sourceResultDigest: digestJson(repeatedResult), headSha: state.verification.headSha, findingId: finding.id, fingerprint,
    disposition: 'actionable', reason: 'A second ordinary remediation is authorized.', amendmentId: 'remediate-recovery-again',
    replacementCriterionId: 'recovery-remediation-again', replacementTaskId: 'recovery-remediation-task-again', recordedAt: '2026-08-18T13:05:00.000Z' };
  assert.throws(() => recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision,
    disposition: { ...repeatedDisposition, disposition: 'duplicate', amendmentId: null, replacementCriterionId: null, replacementTaskId: null } }),
  (error) => error.code === 'HUMAN_DECISION_REQUIRED');
  const authorizationBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => authorizeRepeatedFinding({ cwd: fixture.cwd, expectedRevision: state.revision,
    authorization: { fingerprint, reason: '€'.repeat(342), authorizedBy: 'release-owner' } }),
  (error) => error.code === 'HUMAN_AUTHORIZATION_INVALID');
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), authorizationBefore,
    'oversized UTF-8 authorization is rejected without durable mutation');
  state = authorizeRepeatedFinding({ cwd: fixture.cwd, expectedRevision: state.revision,
    authorization: { fingerprint, reason: 'Human reviewed the consecutive applicable finding.', authorizedBy: 'release-owner' } });
  state = recordFindingDisposition({ cwd: fixture.cwd, expectedRevision: state.revision, disposition: repeatedDisposition });
  assert.ok(existsSync(join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0001', 'findings', `${fingerprint.slice(7)}.json`)));
  assert.ok(existsSync(join(changeDirectory(fixture.cwd, state.changeId), 'verification', 'rounds', '0002', 'findings', `${fingerprint.slice(7)}.json`)));
  const secondPlan = structuredClone(resultingPlan);
  secondPlan.planRevision = 3;
  secondPlan.criteria.push({ id: repeatedDisposition.replacementCriterionId, description: 'Repeated recovery coverage is complete.',
    disposition: 'owned', ownerTaskId: repeatedDisposition.replacementTaskId, deferredReason: null });
  secondPlan.tasks.push({ ...secondPlan.tasks[0], id: repeatedDisposition.replacementTaskId, title: 'Repeat recovery remediation',
    objective: 'Resolve the repeated exact finding.', criterionIds: [repeatedDisposition.replacementCriterionId], checklistItemIds: [],
    dependsOn: ['recovery-remediation-task'], anticipatedPaths: ['second-remediation.txt'] });
  const secondAmendment = { id: repeatedDisposition.amendmentId, reason: 'Resolve the repeated exact verifier finding.',
    authorization: 'Human-approved repeated remediation.', trigger: fingerprint,
    delta: { addedTaskIds: [repeatedDisposition.replacementTaskId] }, invalidatedEvidence: [] };
  const secondPlanningEvidence = [mapperEvidence(state.planningSha, 3, 'Repeated remediation behavior coverage is mapped.')];
  const unsafePlan = structuredClone(secondPlan);
  unsafePlan.criteria.push({ id: 'unplanned-overlap', description: 'Unplanned overlap is rejected.', disposition: 'owned',
    ownerTaskId: 'unplanned-overlap-task', deferredReason: null });
  unsafePlan.tasks.push({ ...secondPlan.tasks[0], id: 'unplanned-overlap-task', title: 'Unplanned overlapping work',
    objective: 'Attempt unrelated overlapping work.', criterionIds: ['unplanned-overlap'], checklistItemIds: [],
    dependsOn: ['recovery-remediation-task'], anticipatedPaths: ['second-remediation.txt'] });
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, amendment: secondAmendment,
    resultingPlan: unsafePlan, planningEvidence: secondPlanningEvidence }),
  (error) => error.code === 'PLAN_NOT_READY' && error.message.includes('overlapping anticipated paths'));
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, amendment: secondAmendment,
    resultingPlan: secondPlan, planningEvidence: secondPlanningEvidence });
  assert.equal(state.phase, 'implementing');
  assert.equal(state.execution.tasks.find(({ id }) => id === 'recovery-remediation-task').status, 'integrated');
  assert.equal(state.execution.tasks.find(({ id }) => id === repeatedDisposition.replacementTaskId).status, 'unbound');
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

test('interrupted Git checkpoint without its receipt-bound observation refuses recovery without durable mutation', async () => {
  const { cwd, sha } = repository('receipt-free checkpoint recovery');
  const planning = await initializeState({ cwd, changeId: 'receipt-free-checkpoint', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  acceptPlan({ cwd, plan: planFor(planning), expectedRevision: planning.revision });
  writeFileSync(join(cwd, 'checkpoint-dirty.txt'), 'dirty');
  assert.throws(() => checkpointGitMetadata({ cwd,
    crashStep(step) { if (step === 'after-state') throw new Error('checkpoint crash'); } }), /checkpoint crash/u);

  const root = changeDirectory(cwd, 'receipt-free-checkpoint');
  const state = loadState(cwd);
  const transition = join(root, 'transitions', String(state.revision).padStart(8, '0'));
  const intentPath = join(transition, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const observationPath = join(root, intent.evidencePaths.gitCheckpointObservationDigest);
  unlinkSync(observationPath);
  unlinkSync(observationPath.replace(/\.json$/u, '.sha256'));
  intent.evidence = {};
  intent.evidencePaths = {};
  intent.authoritativeEvidence = {};
  writeReceiptJson(intentPath, intent);
  const before = {
    state: readFileSync(join(root, 'state.json'), 'utf8'),
    events: readFileSync(join(root, 'events.jsonl'), 'utf8'),
    transition: readdirSync(transition),
  };

  assert.throws(() => recoverState({ cwd }),
    (error) => error instanceof StateError && error.code === 'RECOVERY_EVIDENCE_INVALID');
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), before.state);
  assert.equal(readFileSync(join(root, 'events.jsonl'), 'utf8'), before.events);
  assert.deepEqual(readdirSync(transition), before.transition);
  assert.equal(existsSync(join(transition, 'complete')), false);
});

test('plan-only execution summaries checkpoint detached Planning-SHA identity and recover without named-branch authority', async () => {
  const { cwd, sha } = repository('plan-only execution checkpoint');
  const planning = await initializeState({ cwd, changeId: 'plan-only-execution-checkpoint', mode: 'plan-only',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  git(cwd, 'switch', '--detach', sha);
  const accepted = acceptPlan({ cwd, plan: planFor(planning), expectedRevision: planning.revision });
  assert.ok(accepted.execution, 'native v2 plan-only state retains its non-null execution summary');
  git(cwd, 'switch', '-c', 'plan-only-checkpoint');
  assert.throws(() => checkpointGitMetadata({ cwd,
    crashStep(step) { if (step === 'after-state') throw new Error('plan-only checkpoint crash'); } }), /plan-only checkpoint crash/u);
  const recovered = recoverState({ cwd }).state;
  assert.equal(recovered.phase, 'ready-to-implement');
  assert.equal(recovered.git.branch, 'plan-only-checkpoint');
  git(cwd, 'switch', '--detach', sha);
  const detached = checkpointGitMetadata({ cwd }).state;
  assert.equal(detached.phase, 'ready-to-implement');
  assert.equal(detached.git.branch, '(detached)');
  assert.equal(archiveState({ cwd, expectedRevision: detached.revision }).archived, true);
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

test('task blockers cap Unicode code points while immutable failure and rejection prose remains complete', async () => {
  const { cwd, sha } = repository('bounded Unicode task blockers');
  const planning = await initializeState({ cwd, changeId: 'bounded-unicode-blockers', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning); let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const first = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet: first, expectedRevision: state.revision });
  const firstWorker = createWorkerFixture(cwd, state, first);
  const second = packetFor(state, plan, 'second-task'); state = bindTask({ cwd, packet: second, expectedRevision: state.revision });
  createWorkerFixture(cwd, state, second);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: first.taskId, workerId: 'long-failure', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: second.taskId, workerId: 'long-rejection', expectedRevision: state.revision });
  const failureSummary = `Failure ${'😀'.repeat(2100)} complete`;
  state = acceptResult({ cwd, workerCwd: firstWorker.path, expectedRevision: state.revision,
    result: { ...resultFor(first, 'failed'), validation: first.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'Validation failed.',
    })), unexpectedDependencies: ['Unexpected dependency.'], summary: failureSummary } });
  const rejectionReason = `Reject ${'🛠️'.repeat(1200)} complete`;
  state = rejectTask({ cwd, taskId: second.taskId, reason: rejectionReason, expectedRevision: state.revision });
  assert.equal(state.blockedReasons.length, 2);
  for (const blocker of state.blockedReasons) {
    assert.equal(Array.from(blocker).length, 2000);
    assert.match(blocker, /full evidence retained\]$/u);
  }
  const resultPath = join(changeDirectory(cwd, state.changeId), 'implementation', 'results', first.taskId, '0001.json');
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).summary, failureSummary);
  const rejectionDirectory = join(changeDirectory(cwd, state.changeId), 'implementation', 'rejections', second.taskId);
  const rejectionPath = join(rejectionDirectory, readdirSync(rejectionDirectory).find((name) => name.endsWith('.json')));
  assert.equal(JSON.parse(readFileSync(rejectionPath, 'utf8')).reason, rejectionReason);
  assert.equal(validateState({ cwd }).valid, true);
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

test('bound task reserves direct rejection replacement at its exact capacity edge', async () => {
  const { cwd, sha } = repository('bound rejection edge');
  const planning = await initializeState({ cwd, changeId: 'bound-rejection-edge', mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  const taskId = `task-${'x'.repeat(123)}`;
  plan.tasks[0].id = taskId;
  plan.criteria[0].ownerTaskId = taskId;
  plan.checklistMappings[0].taskIds = [taskId];
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, taskId);
  state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const projection = preflightStateVerifierCapacity({ cwd }).context.evidence;
  const replacementDigests = new Set(projection.filter(({ summary }) => summary.includes(
    `Reserved schema-minimal viable remediation authority for ${taskId}:`)).map(({ digest }) => digest));
  const replacement = projection.filter(({ digest }) => replacementDigests.has(digest));
  assert.ok(replacement.length > 15,
    'long schema-valid task IDs and derived authority identities consume canonical extra chunks');
  assert.ok(replacement.some(({ id }) => id.endsWith('-part-2')),
    'the bounded remediation envelope accounts for normalized second chunks');
  assert.ok(replacement.some(({ summary }) => summary.includes(
    `invalidated-evidence:implementation/tasks/${taskId}/0001.json`)),
  'the reservation includes the exact long invalidated-evidence path before binding');
  const withoutReplacement = projection.filter((item) => !replacement.includes(item));
  const edgeFiller = Array.from({ length: 500 - withoutReplacement.length }, (_, index) => ({
    kind: 'result',
    id: `bound-rejection-edge-filler-${index + 1}`,
    summary: 'Capacity edge filler.',
  }));
  assert.equal(boundVerifierEvidence([...withoutReplacement, ...edgeFiller]).length, 500,
    'the state without its mandatory rejection branch can occupy the entire item budget');
  assert.throws(() => boundVerifierEvidence([
    ...withoutReplacement, ...edgeFiller, ...replacement,
  ]), (error) => error.code === 'VERIFIER_CONTEXT_TOO_LARGE',
  'the reserved replacement branch is required before binding can make rejection inevitable');

  state = rejectTask({ cwd, taskId,
    reason: 'The immutable packet must be replaced.', expectedRevision: state.revision });
  const rejected = state.execution.tasks[0]; assert.equal(rejected.status, 'rejected'); assert.equal(rejected.workerId, null);
  const resulting = structuredClone(plan); resulting.planRevision = 2;
  resulting.tasks[0].id = 'replacement-task'; resulting.criteria[0].ownerTaskId = 'replacement-task';
  resulting.checklistMappings[0].taskIds = ['replacement-task'];
  const suffix = `${taskId}/0001.json`;
  state = amendPlan({ cwd, expectedRevision: state.revision, resultingPlan: resulting,
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
import { findingFingerprint } from '../verification/contracts.mjs';
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

function dualReviewerSpecialization() {
  const value = { specialization: 'api', affectedAreas: ['api'], riskTags: ['authorization', 'offline'],
    browserVisible: false, relatedTestSelectionUncertain: false };
  return { ...value, route: routeSpecialists({ ...value, testSelectionUncertain: false }, registry) };
}

function dualReviewerReleaseSpecialization() {
  const value = { specialization: 'data-integrity', affectedAreas: ['api', 'release'],
    riskTags: ['authorization', 'offline', 'release'], browserVisible: false,
    relatedTestSelectionUncertain: false };
  return { ...value, route: routeSpecialists({ ...value, testSelectionUncertain: false }, registry) };
}

function specialistResult(state, reviewerId, findingCount) {
  const findings = Array.from({ length: findingCount }, (_, index) => ({
    id: `finding-${String(index + 1).padStart(3, '0')}`,
    priority: 'P2', summary: `Finding ${index + 1} requires disposition.`,
    evidence: `Exact routed evidence ${index + 1}.`, affectedAreas: ['workflow'],
    recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'],
    criterionIds: ['durable-state'], invariantIds: [],
  }));
  return { schemaVersion: 1, reviewerId, headSha: state.verification.headSha,
    specialistPlanDigest: state.verification.specialistPlanDigest,
    status: findings.length ? 'findings' : 'clean',
    summary: findings.length ? `${reviewerId} reported ${findings.length} findings.` : `${reviewerId} is clean.`,
    findings, recordedAt: '2026-08-18T12:00:00.000Z' };
}

function durableSnapshot(root) {
  if (!existsSync(root)) return [];
  const snapshot = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { snapshot.push(['directory', key]); visit(path, key); }
      else snapshot.push(['file', key, readFileSync(path).toString('base64')]);
    }
  };
  visit(root);
  return snapshot;
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

async function integratedSingleTaskFixture(label, specialize = specialization(), {
  validationCommand = 'node --test .agents/skills/change-development/scripts/state/state.test.mjs',
  workerContent = 'first\n',
  noChange = false,
} = {}) {
  const { cwd, sha } = repository(label);
  const planning = await initializeState({ cwd, changeId: label.replaceAll(' ', '-'), mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  plan.specialization = specialize;
  plan.tasks[0].specialization = specialize;
  plan.tasks[0].anticipatedPaths = ['first.txt'];
  const planningEvidence = specialize.browserVisible ? [mapperEvidence(planning.planningSha, plan.planRevision,
    'Accepted behavior coverage is mapped.')] : [];
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision, planningEvidence });
  const packet = packetFor(state, plan, 'state-task');
  packet.requiredValidation.unit[0].command = validationCommand;
  packet.behaviorMapperEvidence = planningEvidence[0] ?? null;
  state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, packet);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  state = startTask({ cwd, taskId: 'state-task', workerId: 'worker-one', expectedRevision: state.revision });
  if (noChange) {
    state = acceptResult({ cwd, result: resultFor(packet, 'no-change'),
      workerCwd: worker.path, expectedRevision: state.revision });
  } else {
    writeFileSync(join(worker.path, 'first.txt'), workerContent); git(worker.path, 'add', 'first.txt'); git(worker.path, 'commit', '-m', 'test: lifecycle worker');
    state = acceptResult({ cwd, result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), ['first.txt']),
      workerCwd: worker.path, expectedRevision: state.revision });
    state = integrateTask({ cwd, taskId: 'state-task', expectedRevision: state.revision });
  }
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'state-task' });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
  return { cwd, state };
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

function writeCompleteTransitionFixture(directory, intent) {
  const receipt = { schemaVersion: 1, revision: intent.revision, intentDigest: digestJson(intent),
    stateDigest: intent.nextStateDigest, evidence: intent.evidence, completedAt: intent.nextState.updatedAt };
  writeReceiptJson(join(directory, 'intent.json'), intent);
  writeReceiptJson(join(directory, 'receipt.json'), receipt);
  writeFileSync(join(directory, 'complete'), `${digestJson(receipt)}\n`);
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

test('Git metadata ownership is rejected before plan acceptance or amendment evidence mutates', async () => {
  const acceptance = repository('git metadata acceptance');
  const planning = await initializeState({ cwd: acceptance.cwd, changeId: 'git-metadata-acceptance', mode: 'implement',
    baseBranch: 'main', planningRef: acceptance.sha, source: descriptor });
  const unsafe = planFor(planning); unsafe.tasks[0].anticipatedPaths = ['.git/config'];
  const acceptanceRoot = changeDirectory(acceptance.cwd, planning.changeId);
  const acceptanceBefore = {
    state: readFileSync(join(acceptanceRoot, 'state.json'), 'utf8'),
    events: readFileSync(join(acceptanceRoot, 'events.jsonl'), 'utf8'),
    transitions: readdirSync(join(acceptanceRoot, 'transitions')),
  };
  assert.throws(() => acceptPlan({ cwd: acceptance.cwd, expectedRevision: planning.revision, plan: unsafe }),
    (error) => error instanceof StateError && error.code === 'PLAN_NOT_READY');
  assert.equal(readFileSync(join(acceptanceRoot, 'state.json'), 'utf8'), acceptanceBefore.state);
  assert.equal(readFileSync(join(acceptanceRoot, 'events.jsonl'), 'utf8'), acceptanceBefore.events);
  assert.deepEqual(readdirSync(join(acceptanceRoot, 'transitions')), acceptanceBefore.transitions);
  assert.equal(existsSync(join(acceptanceRoot, 'plan')), false);

  const amendment = repository('git metadata amendment');
  const amendmentPlanning = await initializeState({ cwd: amendment.cwd, changeId: 'git-metadata-amendment', mode: 'implement',
    baseBranch: 'main', planningRef: amendment.sha, source: descriptor });
  const acceptedPlan = planFor(amendmentPlanning); acceptedPlan.tasks[0].anticipatedPaths = ['.gitignore'];
  const accepted = acceptPlan({ cwd: amendment.cwd, expectedRevision: amendmentPlanning.revision, plan: acceptedPlan });
  const amendmentRoot = changeDirectory(amendment.cwd, accepted.changeId);
  const resultingPlan = structuredClone(acceptedPlan); resultingPlan.planRevision = 2;
  resultingPlan.tasks[0].anticipatedPaths = ['nested/.git/hooks'];
  const amendmentBefore = {
    state: readFileSync(join(amendmentRoot, 'state.json'), 'utf8'),
    events: readFileSync(join(amendmentRoot, 'events.jsonl'), 'utf8'),
    transitions: readdirSync(join(amendmentRoot, 'transitions')),
    plan: readFileSync(join(amendmentRoot, 'plan', 'plan.json'), 'utf8'),
  };
  assert.throws(() => amendPlan({ cwd: amendment.cwd, expectedRevision: accepted.revision, resultingPlan,
    amendment: { id: 'unsafe-git-metadata', reason: 'Unsafe ownership must fail.', authorization: 'operator',
      trigger: 'operator-decision', delta: { changed: ['anticipatedPaths'] }, invalidatedEvidence: [] } }),
  (error) => error instanceof StateError && error.code === 'PLAN_NOT_READY');
  assert.equal(readFileSync(join(amendmentRoot, 'state.json'), 'utf8'), amendmentBefore.state);
  assert.equal(readFileSync(join(amendmentRoot, 'events.jsonl'), 'utf8'), amendmentBefore.events);
  assert.deepEqual(readdirSync(join(amendmentRoot, 'transitions')), amendmentBefore.transitions);
  assert.equal(readFileSync(join(amendmentRoot, 'plan', 'plan.json'), 'utf8'), amendmentBefore.plan);
  assert.equal(existsSync(join(amendmentRoot, 'plan', 'amendments')), false);

  const packet = packetFor(accepted, acceptedPlan, 'state-task');
  const bound = bindTask({ cwd: amendment.cwd, packet, expectedRevision: accepted.revision });
  assert.equal(bound.execution.tasks[0].status, 'bound');
  assert.equal(validateState({ cwd: amendment.cwd }).valid, true);
});

test('historical accepted Git metadata ownership replays but requires an explicit safe amendment before binding', async () => {
  const fixture = repository('historical git metadata plan');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'historical-git-metadata', mode: 'implement',
    baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const safePlan = planFor(planning);
  const accepted = acceptPlan({ cwd: fixture.cwd, expectedRevision: planning.revision, plan: safePlan });
  const root = changeDirectory(fixture.cwd, accepted.changeId);
  const historicalPlan = structuredClone(safePlan); historicalPlan.tasks[0].anticipatedPaths = ['.git/config'];
  const historicalDigest = digestJson(historicalPlan);
  const historicalState = structuredClone(accepted);
  historicalState.plan.originalDigest = historicalDigest;
  historicalState.plan.effectiveDigest = historicalDigest;
  historicalState.execution.planDigest = historicalDigest;
  historicalState.execution.tasks[0].anticipatedPaths = ['.git/config'];
  writeReceiptJson(join(root, 'plan', 'plan.json'), historicalPlan);
  const transition = join(root, 'transitions', '00000001');
  const intentPath = join(transition, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.nextState = historicalState;
  intent.nextStateDigest = digestJson(historicalState);
  intent.evidence.planDigest = historicalDigest;
  intent.authoritativeEvidence.planDigest = {
    ...intent.authoritativeEvidence.planDigest, digest: historicalDigest, value: historicalPlan,
  };
  writeReceiptJson(intentPath, intent);
  const receiptPath = join(transition, 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.intentDigest = digestJson(intent);
  receipt.stateDigest = digestJson(historicalState);
  receipt.evidence = intent.evidence;
  writeReceiptJson(receiptPath, receipt);
  writeFileSync(join(transition, 'complete'), `${digestJson(receipt)}\n`);
  writeFileSync(join(root, 'state.json'), `${JSON.stringify(historicalState)}\n`);

  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
  const unsafePacket = packetFor(historicalState, historicalPlan, 'state-task');
  const revision = historicalState.revision;
  assert.throws(() => bindTask({ cwd: fixture.cwd, packet: unsafePacket, expectedRevision: revision }),
    (error) => error instanceof StateError && error.code === 'INVALID_TASK_PACKET');
  assert.equal(loadState(fixture.cwd).revision, revision);

  const amendedPlan = structuredClone(historicalPlan); amendedPlan.planRevision = 2;
  amendedPlan.tasks[0].anticipatedPaths = ['.gitignore'];
  const amended = amendPlan({ cwd: fixture.cwd, expectedRevision: revision, resultingPlan: amendedPlan,
    amendment: { id: 'replace-git-metadata', reason: 'Replace historical unsafe ownership.', authorization: 'operator',
      trigger: 'operator-decision', delta: { changed: ['anticipatedPaths'] }, invalidatedEvidence: [] } });
  const safePacket = packetFor(amended, amendedPlan, 'state-task');
  const bound = bindTask({ cwd: fixture.cwd, packet: safePacket, expectedRevision: amended.revision });
  assert.equal(bound.execution.tasks[0].status, 'bound');
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
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
  assert.match(nextActionFor({ ...state, phase: 'blocked', verification: {
    humanDecisionRequiredFingerprints: ['sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  } }), /durable human authorization/u);
  assert.match(nextActionFor({ ...state, phase: 'blocked', verification: { humanDecisionRequiredFingerprints: [] } }),
    /Disposition every exact-source verification finding/u);
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
