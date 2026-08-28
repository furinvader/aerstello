import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import {
  SCOPE_TRIPWIRE_CATEGORIES,
  evaluateScopeTripwires,
  implementationContractPaths,
  implementationTaskDigest,
  parseImplementationValidationCommand,
  validateImplementationResult,
  validateImplementationResultAgainstTask,
  validateImplementationTask,
  validateImplementationTaskStructure,
} from './contracts.mjs';
import { implementationResultSchemaPath, implementationTaskSchemaPath } from '../paths.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const SHA = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const registry = loadRegistry();

function packet(overrides = {}) {
  const specialization = overrides.specialization ?? 'ops-workflow';
  const riskTags = overrides.riskTags ?? ['workflow'];
  const affectedAreas = overrides.affectedAreas ?? ['workflow'];
  const planningSignals = overrides.planningSignals ?? {
    browserVisible: false, relatedTestSelectionUncertain: false,
  };
  return {
    schemaVersion: 1,
    changeId: 'issue-23',
    taskId: 'implementation-contracts',
    planRevision: 1,
    planDigest: DIGEST,
    planningSha: SHA,
    taskBaseSha: SHA,
    specialization,
    riskTags,
    affectedAreas,
    planningSignals,
    specialistRoute: routeSpecialists({
      specialization, riskTags,
      browserVisible: planningSignals.browserVisible,
      testSelectionUncertain: planningSignals.relatedTestSelectionUncertain,
    }, registry),
    behaviorMapperEvidence: null,
    objective: 'Add immutable implementation contracts.',
    evidence: 'Issue 23 requires bounded task and result packets.',
    decisionIds: [],
    decisionContext: [],
    acceptanceCriteriaIds: ['bounded-contracts'],
    acceptanceCriteria: [{ id: 'bounded-contracts', description: 'Packets and results fail closed.' }],
    allowedPaths: ['.agents/skills/change-development/scripts/implementation/**'],
    forbiddenPaths: ['.agents/skills/change-development/scripts/implementation/secret.txt'],
    dependencies: [],
    requiredValidation: {
      unit: [{
        command: 'node --test .agents/skills/change-development/scripts/implementation/contracts.test.mjs',
        reason: 'Exercise only the implementation contracts.',
      }],
      system: [],
    },
    ...overrides,
  };
}

function result(task = packet(), overrides = {}) {
  return {
    schemaVersion: 1,
    changeId: task.changeId,
    taskId: task.taskId,
    planDigest: task.planDigest,
    packetDigest: implementationTaskDigest(task),
    specialization: task.specialization,
    taskBaseSha: task.taskBaseSha,
    status: 'implemented',
    workerCommit: COMMIT,
    changedPaths: ['.agents/skills/change-development/scripts/implementation/contracts.mjs'],
    validation: [{
      command: task.requiredValidation.unit[0].command,
      result: 'passed',
      summary: 'Focused contract tests passed.',
    }],
    unexpectedDependencies: [],
    summary: 'Implemented the bounded contracts.',
    ...overrides,
  };
}

function minimalityAuthority(task = packet()) {
  return {
    closureDigest: `sha256:${'f'.repeat(64)}`,
    criterionNeed: task.acceptanceCriteriaIds.map((criterionId) => ({
      criterionId, rationale: `Removing this task leaves ${criterionId} unsatisfied.`,
    })),
    removalCounterfactual: 'Removing the packet leaves its exact criteria without implementation or proof.',
    forbiddenExpansion: ['Do not change product behavior or durable lifecycle state.'],
    tripwires: SCOPE_TRIPWIRE_CATEGORIES.map((category, index) => ({
      id: `scope-${String(index).padStart(2, '0')}-${category}`,
      category,
      inventory: [`${category}-baseline`],
      observedInventory: [`${category}-baseline`],
    })),
    discoveryReturn: { status: 'blocked', workerCommit: null, authority: 'unchanged' },
  };
}

function discovery(task) {
  const tripwireId = task.minimalityAuthority.tripwires[0].id;
  return {
    schemaVersion: 1,
    summary: 'An unowned lifecycle path is required.',
    evidence: [{ kind: 'state-path', identity: '.agents/skills/change-development/scripts/state/state.mjs',
      detail: 'The lifecycle must consume the new contract before the behavior can be complete.' }],
    triggeredTripwireIds: [tripwireId],
    requestedAuthority: [{ field: 'paths', values: ['.agents/skills/change-development/scripts/state/state.mjs'] }],
  };
}

test('both closed schemas compile independently in strict Draft 2020-12 mode', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const path of Object.values(implementationContractPaths)) {
    assert.doesNotThrow(() => ajv.compile(JSON.parse(readFileSync(path, 'utf8'))));
  }
  const extraTask = packet(); extraTask.rawLog = 'not retained';
  assert.match(validateImplementationTask(extraTask).join('\n'), /additional properties/u);
  const extraResult = result(); extraResult.transcript = 'not retained';
  assert.match(validateImplementationResult(extraResult).join('\n'), /additional properties/u);
  assert.equal(implementationContractPaths.implementationTaskSchema, implementationTaskSchemaPath);
  assert.equal(implementationContractPaths.implementationResultSchema, implementationResultSchemaPath);
});

test('valid packet has a canonical digest that binds every packet field', () => {
  const value = packet();
  assert.deepEqual(validateImplementationTask(value), []);
  assert.match(implementationTaskDigest(value), /^sha256:[0-9a-f]{64}$/u);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(implementationTaskDigest(reordered), implementationTaskDigest(value));
  assert.notEqual(implementationTaskDigest({ ...value, objective: 'A changed objective.' }), implementationTaskDigest(value));
  assert.notEqual(implementationTaskDigest({ ...value, taskBaseSha: 'd'.repeat(40) }), implementationTaskDigest(value));
  const planned = {
    ...value,
    allowedPaths: [...value.allowedPaths, 'specs/features/planned.feature'],
    plannedE2ESelectors: [{ selector: 'id-planned-flow', featurePath: 'specs/features/planned.feature' }],
    requiredValidation: { unit: [], system: [{
      command: 'npm run test:e2e:related -- --id planned-flow',
      reason: 'Exercise the task-owned scenario.',
      selectors: ['id-planned-flow'],
      projects: ['tablet-chromium'],
    }] },
  };
  assert.deepEqual(validateImplementationTask(planned), []);
  assert.notEqual(implementationTaskDigest(planned), implementationTaskDigest(value));
});

test('minimality authority binds exact criterion need, closure, removal, forbidden expansion, and discovery return', () => {
  const legacy = packet();
  assert.deepEqual(validateImplementationTaskStructure(legacy), [], 'historical packets remain readable');
  const governed = packet(); governed.minimalityAuthority = minimalityAuthority(governed);
  assert.deepEqual(validateImplementationTask(governed), []);
  assert.notEqual(implementationTaskDigest(governed), implementationTaskDigest(legacy));

  const wrongCriterion = structuredClone(governed);
  wrongCriterion.minimalityAuthority.criterionNeed[0].criterionId = 'different-criterion';
  assert.match(validateImplementationTask(wrongCriterion).join('\n'), /criterionNeed IDs must exactly match/u);
  const duplicateCategory = structuredClone(governed);
  duplicateCategory.minimalityAuthority.tripwires[1].category = duplicateCategory.minimalityAuthority.tripwires[0].category;
  assert.match(validateImplementationTask(duplicateCategory).join('\n'), /must not repeat a category/u);
  const unordered = structuredClone(governed);
  unordered.minimalityAuthority.tripwires[0].inventory = ['second', 'first'];
  assert.match(validateImplementationTask(unordered).join('\n'), /sorted unique string inventory/u);
  const unorderedObservation = structuredClone(governed);
  unorderedObservation.minimalityAuthority.tripwires[0].observedInventory = ['second', 'first'];
  assert.match(validateImplementationTask(unorderedObservation).join('\n'), /observedInventory must be a sorted unique/u);
});

test('every bounded inventory category is a verdict-neutral exact-change tripwire', () => {
  const governed = packet(); governed.minimalityAuthority = minimalityAuthority(governed);
  const unchanged = Object.fromEntries(governed.minimalityAuthority.tripwires
    .map(({ id, inventory }) => [id, [...inventory]]));
  assert.deepEqual(evaluateScopeTripwires(governed, unchanged), []);
  assert.deepEqual(evaluateScopeTripwires(governed), [], 'packet-bound observations are recovery-safe');
  const changed = Object.fromEntries(governed.minimalityAuthority.tripwires
    .map(({ id, category }) => [id, [`${category}-observed`]]));
  const triggers = evaluateScopeTripwires(governed, changed);
  assert.deepEqual(triggers.map(({ category }) => category), SCOPE_TRIPWIRE_CATEGORIES);
  assert.ok(triggers.every((trigger) => !Object.hasOwn(trigger, 'verdict')),
    'tripwires request assessment without selecting a verdict');
  assert.throws(() => evaluateScopeTripwires(governed, { ...unchanged, unknown: [] }), /exactly match tripwire IDs/u);
  const historical = structuredClone(governed);
  for (const tripwire of historical.minimalityAuthority.tripwires) delete tripwire.observedInventory;
  assert.deepEqual(validateImplementationTaskStructure(historical), [], 'historical packets remain structurally readable');
  assert.throws(() => evaluateScopeTripwires(historical), /new task binding requires packet-bound observed/u);
});

test('immutable packet digest and replay use structural authority while new binding uses the supplied live registry', () => {
  const value = packet();
  const digest = implementationTaskDigest(value);
  const changedRegistry = structuredClone(registry);
  changedRegistry.profiles.find(({ id }) => id === 'ops-workflow').supportedRiskTags = [];
  assert.deepEqual(validateImplementationTaskStructure(value), []);
  assert.equal(implementationTaskDigest(value), digest);
  assert.deepEqual(validateImplementationResultAgainstTask(value, result(value), result(value).changedPaths), []);
  assert.match(validateImplementationTask(value, { registry: changedRegistry }).join('\n'), /current specialist registry|does not support risk tag/u);
});

test('planned E2E selector declarations are structurally bounded without reading a checkout', () => {
  const requiredValidation = { unit: [], system: [{
    command: 'npm run test:e2e:related -- --id planned-flow',
    reason: 'Exercise the task-owned scenario.',
    selectors: ['id-planned-flow'],
    projects: ['tablet-chromium'],
  }] };
  const valid = packet({
    allowedPaths: ['specs/features/planned.feature'],
    plannedE2ESelectors: [{ selector: 'id-planned-flow', featurePath: 'specs/features/planned.feature' }],
    requiredValidation,
  });
  assert.deepEqual(validateImplementationTask(valid), []);
  for (const [label, change, pattern] of [
    ['unused', { plannedE2ESelectors: [{ selector: 'id-unused-flow', featurePath: 'specs/features/planned.feature' }] }, /must be used/u],
    ['unowned', { allowedPaths: ['apps/web/src/owned.ts'] }, /must be owned/u],
    ['forbidden', { forbiddenPaths: ['specs/features/planned.feature'] }, /must not be forbidden/u],
    ['unsafe path', { plannedE2ESelectors: [{ selector: 'id-planned-flow', featurePath: 'specs/features/planned.txt' }] }, /feature file/u],
    ['duplicate', { plannedE2ESelectors: [
      { selector: 'id-planned-flow', featurePath: 'specs/features/planned.feature' },
      { selector: 'id-planned-flow', featurePath: 'specs/features/other.feature' },
    ], allowedPaths: ['specs/features/**'] }, /duplicate selector/u],
  ]) {
    assert.match(validateImplementationTask({ ...valid, ...change }).join('\n'), pattern, label);
  }
});

test('specialist metadata and the exact canonical route are validated', () => {
  const incompatible = packet({ specialization: 'web', affectedAreas: ['api'], riskTags: [] });
  assert.match(validateImplementationTask(incompatible).join('\n'), /specialization/u);
  const changedRoute = packet(); changedRoute.specialistRoute.finalVerificationPriority = 'high';
  assert.match(validateImplementationTask(changedRoute).join('\n'), /canonical specialist route/u);
  const browser = packet({ planningSignals: { browserVisible: true, relatedTestSelectionUncertain: false } });
  assert.match(validateImplementationTask(browser).join('\n'), /behaviorMapperEvidence is required/u);
  const contradictory = structuredClone(browser);
  contradictory.behaviorMapperEvidence = {
    schemaVersion: 1, reviewerId: 'behavior_mapper', status: 'clean', planRevision: browser.planRevision,
    headSha: browser.planningSha, findings: ['Clean evidence cannot carry findings.'],
    summary: 'Contradictory evidence.', recordedAt: '2026-08-18T10:00:00.000Z',
  };
  assert.match(validateImplementationTask(contradictory).join('\n'), /findings must be empty/u);
  const uncertain = packet({ planningSignals: { browserVisible: false, relatedTestSelectionUncertain: true } });
  assert.match(validateImplementationTask(uncertain).join('\n'), /must be resolved before binding/u);
});

test('self-contained decision and criterion context exactly matches cross-plan IDs', () => {
  const value = packet({
    decisionIds: ['fixed-scope'],
    decisionContext: [{ id: 'fixed-scope', resolution: 'Bind one immutable task.' }],
  });
  assert.deepEqual(validateImplementationTask(value), []);
  const wrongDecision = structuredClone(value); wrongDecision.decisionContext[0].id = 'other-decision';
  assert.match(validateImplementationTask(wrongDecision).join('\n'), /decisionContext IDs must exactly match/u);
  const wrongCriterion = structuredClone(value); wrongCriterion.acceptanceCriteria[0].id = 'other-criterion';
  assert.match(validateImplementationTask(wrongCriterion).join('\n'), /acceptanceCriteria IDs must exactly match/u);
  const expanded = structuredClone(value); expanded.acceptanceCriteria[0].rawDiff = 'not contract evidence';
  assert.match(validateImplementationTask(expanded).join('\n'), /additional properties/u);
});

test('ownership paths reject absolute, traversal, glob, and non-trailing recursive syntax', () => {
  for (const unsafe of ['/apps/api/**', '../apps/api/**', 'apps/**/orders', 'apps/api/*.ts', 'apps\\api\\**',
    '.git/**', '.git/config', 'nested/.git/hooks/**']) {
    const value = packet(); value.allowedPaths = [unsafe];
    assert.ok(validateImplementationTask(value).length > 0, unsafe);
  }
  assert.deepEqual(validateImplementationTask(packet({
    allowedPaths: ['apps/api/src/orders/**', 'package.json'], forbiddenPaths: ['apps/api/src/orders/internal/**'],
  })), []);
});

test('only direct targeted validation commands and bounded browser projects are accepted', () => {
  assert.ok(parseImplementationValidationCommand('node --test .agents/skills/change-development/scripts/implementation/contracts.test.mjs'));
  assert.ok(parseImplementationValidationCommand('npm test -w @aerstello/api -- src/orders/policy.test.ts'));
  assert.deepEqual(parseImplementationValidationCommand('git diff --check'), ['git', 'diff', '--check']);
  for (const broad of [
    'npm test', 'npm run check:full', 'npm run test:e2e:full',
    'env CI=1 node --test apps/api/src/orders/policy.test.ts',
    'node --test apps/api/src/orders/policy.test.ts && npm run check:full',
    'git diff', 'git diff --check HEAD', 'git diff --check --cached',
  ]) assert.equal(parseImplementationValidationCommand(broad), null, broad);

  const broad = packet(); broad.requiredValidation.unit[0].command = 'npm run check:full';
  assert.match(validateImplementationTask(broad).join('\n'), /direct targeted command/u);
  const fullE2E = packet(); fullE2E.requiredValidation = { unit: [], system: [{
    command: 'npm run test:e2e:full', reason: 'Too broad.', selectors: [], projects: [],
  }] };
  assert.match(validateImplementationTask(fullE2E).join('\n'), /targeted related command/u);
  const project = packet(); project.requiredValidation = { unit: [], system: [{
    command: 'npm run test:e2e:related -- --tag area-localization --project all-browsers',
    reason: 'Unknown project.', selectors: ['area-localization'], projects: ['tablet-chromium'],
  }] };
  assert.match(validateImplementationTask(project).join('\n'), /unsafe or unknown E2E project/u);
  assert.match(validateImplementationTask(packet({ requiredValidation: { unit: [], system: [] } })).join('\n'), /at least one|anyOf/u);
});

test('implemented result identities, paths, and validation must exactly match packet and Git', () => {
  const task = packet(); const value = result(task);
  assert.deepEqual(validateImplementationResultAgainstTask(task, value, value.changedPaths), []);
  for (const [field, changed, pattern] of [
    ['changeId', 'issue-24', /changeId/u],
    ['taskId', 'other-task', /taskId/u],
    ['planDigest', `sha256:${'e'.repeat(64)}`, /planDigest/u],
    ['packetDigest', `sha256:${'e'.repeat(64)}`, /packetDigest/u],
    ['specialization', 'contracts', /specialization/u],
    ['taskBaseSha', 'e'.repeat(40), /taskBaseSha/u],
  ]) {
    assert.match(validateImplementationResultAgainstTask(task, { ...value, [field]: changed }, value.changedPaths).join('\n'), pattern);
  }
  assert.match(validateImplementationResultAgainstTask(task, value).join('\n'), /requires actual Git changed paths/u);
  assert.match(validateImplementationResultAgainstTask(task, value, ['README.md']).join('\n'), /exactly equal the actual Git commit diff/u);
  const forbidden = result(task, { changedPaths: [task.forbiddenPaths[0]] });
  assert.match(validateImplementationResultAgainstTask(task, forbidden, forbidden.changedPaths).join('\n'), /forbidden/u);
  const missing = result(task, { validation: [] });
  assert.match(validateImplementationResultAgainstTask(task, missing, missing.changedPaths).join('\n'), /required validation was not reported/u);
  const substitute = result(task, { validation: [{ command: 'npm run check:full', result: 'passed', summary: 'Broad substitute.' }] });
  assert.match(validateImplementationResultAgainstTask(task, substitute, substitute.changedPaths).join('\n'), /undeclared command/u);
});

test('implemented, blocked, failed, and no-change outcomes are explicit and raw evidence is rejected', () => {
  const task = packet();
  assert.deepEqual(validateImplementationResult(result(task)), []);
  for (const status of ['blocked', 'failed']) {
    assert.deepEqual(validateImplementationResult(result(task, {
      status, workerCommit: null, changedPaths: [], validation: [],
      unexpectedDependencies: [],
    })), [], status);
  }
  assert.deepEqual(validateImplementationResult(result(task, {
    status: 'no-change', workerCommit: null, changedPaths: [], validation: [],
  })), []);
  assert.match(validateImplementationResult(result(task, {
    status: 'no-change', workerCommit: null, changedPaths: [],
    validation: [{ command: task.requiredValidation.unit[0].command, result: 'failed', summary: 'Did not pass.' }],
  })).join('\n'), /successful result/u);
  assert.ok(validateImplementationResult(result(task, {
    status: 'no-change', workerCommit: null, changedPaths: [], validation: [],
    unexpectedDependencies: ['No-change cannot claim an unexpected dependency.'],
  })).length > 0);
  assert.ok(validateImplementationResult(result(task, { status: 'no-change', workerCommit: null })).length > 0);
  for (const status of ['blocked', 'failed', 'no-change']) {
    assert.ok(validateImplementationResult(result(task, {
      status, workerCommit: null, changedPaths: ['src/uncommitted.ts'], validation: [],
      unexpectedDependencies: status === 'no-change' ? [] : ['Unexpected dependency.'],
    })).length > 0, status);
  }
  assert.ok(validateImplementationResult(result(task, { changedPaths: ['.git/config'] })).length > 0);
  const raw = result(task); raw.stackTrace = 'full failure details';
  const errors = validateImplementationResult(raw).join('\n');
  assert.match(errors, /stackTrace is not allowed/u);
});

test('structured scope discovery stops without a commit and cannot grant packet authority', () => {
  const governed = packet(); governed.minimalityAuthority = minimalityAuthority(governed);
  const scopeDiscovery = discovery(governed);
  const blocked = result(governed, {
    status: 'blocked', workerCommit: null, changedPaths: [],
    validation: governed.requiredValidation.unit.map(({ command }) => ({
      command, result: 'skipped', summary: 'Unexpected scope stopped implementation before validation.',
    })),
    unexpectedDependencies: [scopeDiscovery.summary], scopeDiscovery,
  });
  assert.deepEqual(validateImplementationResultAgainstTask(governed, blocked, []), []);

  const legacy = packet();
  const historical = result(legacy, {
    status: 'blocked', workerCommit: null, changedPaths: [],
    validation: legacy.requiredValidation.unit.map(({ command }) => ({ command, result: 'skipped',
      summary: 'Historical unexpected dependency evidence predates structured scope discovery.' })),
    unexpectedDependencies: ['An unowned lifecycle path is required.'],
  });
  assert.deepEqual(validateImplementationResult(historical), [],
    'historical unstructured unexpected-dependency results remain readable');
  assert.deepEqual(validateImplementationResultAgainstTask(legacy, historical, []), [],
    'historical packets do not retroactively acquire structured discovery governance');

  const committed = result(governed, { scopeDiscovery, unexpectedDependencies: [scopeDiscovery.summary] });
  assert.match(validateImplementationResult(committed).join('\n'), /must be equal to constant|blocked/u);
  const unstructured = result(governed, {
    status: 'blocked', workerCommit: null, changedPaths: [],
    validation: governed.requiredValidation.unit.map(({ command }) => ({ command, result: 'skipped',
      summary: 'The ordinary blocker occurred before validation.' })),
    unexpectedDependencies: ['An unowned lifecycle path is required.'],
  });
  assert.match(validateImplementationResultAgainstTask(governed, unstructured, []).join('\n'),
    /requires structured scopeDiscovery/u,
    'an unexpected dependency cannot bypass structured discovery governance');
  const failed = { ...unstructured, status: 'failed' };
  assert.match(validateImplementationResultAgainstTask(governed, failed, []).join('\n'),
    /requires structured scopeDiscovery/u,
    'a failed result cannot bypass structured discovery governance');
  const ordinaryBlocked = { ...unstructured, unexpectedDependencies: [] };
  assert.deepEqual(validateImplementationResultAgainstTask(governed, ordinaryBlocked, []), [],
    'an ordinary blocker without an unexpected dependency remains distinct from scope discovery');

  const unboundTripwire = structuredClone(blocked);
  unboundTripwire.scopeDiscovery.triggeredTripwireIds = ['not-bound'];
  assert.match(validateImplementationResultAgainstTask(governed, unboundTripwire, []).join('\n'), /unbound tripwire/u);
  for (const [field, value, pattern] of [
    ['criteria', governed.acceptanceCriteriaIds[0], /criterion is already authorized/u],
    ['dependencies', 'existing-dependency', /dependency is already authorized/u],
    ['validation', governed.requiredValidation.unit[0].command, /validation is already authorized/u],
    ['paths', '.agents/skills/change-development/scripts/implementation/contracts.mjs', /path is already authorized/u],
  ]) {
    const current = structuredClone(blocked);
    if (field === 'dependencies') governed.dependencies.push(value);
    current.scopeDiscovery.requestedAuthority = [{ field, values: [value] }];
    assert.match(validateImplementationResultAgainstTask(governed, current, []).join('\n'), pattern, field);
    if (field === 'dependencies') governed.dependencies.pop();
  }
  const legacyDiscovery = result(legacy, {
    status: 'blocked', workerCommit: null, changedPaths: [], validation: [],
    unexpectedDependencies: [scopeDiscovery.summary], scopeDiscovery,
  });
  assert.match(validateImplementationResultAgainstTask(legacy, legacyDiscovery, []).join('\n'), /packet-bound minimalityAuthority/u);
});

test('planned E2E selectors require implementation while blocked and failed remain valid', () => {
  const planned = packet({
    allowedPaths: ['.agents/skills/change-development/scripts/implementation/**', 'specs/features/planned.feature'],
    plannedE2ESelectors: [{ selector: 'id-planned-flow', featurePath: 'specs/features/planned.feature' }],
    requiredValidation: {
      unit: [{
        command: 'node --test .agents/skills/change-development/scripts/implementation/contracts.test.mjs',
        reason: 'Exercise only the implementation contracts.',
      }],
      system: [{
        command: 'npm run test:e2e:related -- --id planned-flow',
        reason: 'Exercise the task-owned scenario.',
        selectors: ['id-planned-flow'],
        projects: ['tablet-chromium'],
      }],
    },
  });
  const validation = [...planned.requiredValidation.unit, ...planned.requiredValidation.system].map(({ command }) => ({
    command, result: 'skipped', summary: 'The worker could not realize the planned selector.',
  }));
  const noChange = result(planned, {
    status: 'no-change', workerCommit: null, changedPaths: [],
    validation: validation.map((entry) => ({ ...entry, result: 'passed' })), unexpectedDependencies: [],
  });
  assert.match(validateImplementationResultAgainstTask(planned, noChange, []).join('\n'), /cannot be no-change/u);
  for (const status of ['blocked', 'failed']) {
    const failClosed = result(planned, {
      status, workerCommit: null, changedPaths: [], validation,
      unexpectedDependencies: [],
    });
    assert.deepEqual(validateImplementationResultAgainstTask(planned, failClosed, []), [], status);
  }
});
