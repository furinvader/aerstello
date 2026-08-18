import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { digestJson } from '../contracts/contracts.mjs';
import { implementationTaskDigest } from '../implementation/contracts.mjs';
import { canonicalizeValidationEntry, deriveValidationPlan, findingFingerprint,
  validateVerificationContract, validationPlanDigest, validationPlanReceiptDigest,
} from './contracts.mjs';

const SHA = 'a'.repeat(40); const AT = '2026-08-18T10:00:00Z';
function packet({ taskId = 'workflow-contracts', areas = ['workflow'], unit, system = [] } = {}) {
  return {
    schemaVersion: 1, changeId: 'issue-24-development-verification', taskId, planRevision: 1,
    planDigest: `sha256:${'b'.repeat(64)}`, planningSha: SHA, taskBaseSha: SHA,
    specialization: 'ops-workflow', riskTags: ['workflow'], affectedAreas: areas,
    planningSignals: { browserVisible: system.length > 0, relatedTestSelectionUncertain: false },
    specialistRoute: { schemaVersion: 2, specialization: 'ops-workflow', profileGuidePath: 'profiles/ops-workflow.md',
      riskTags: ['workflow'], signals: { browserVisible: system.length > 0, testSelectionUncertain: false },
      planningHelpers: [], riskReviewers: [], supplementalGuidance: [], finalVerificationPriority: 'high' },
    behaviorMapperEvidence: null, objective: 'Exercise verification contracts.', evidence: 'Issue 24 contract evidence.',
    decisionIds: ['durable-evidence'], decisionContext: [{ id: 'durable-evidence', resolution: 'Persist exact evidence.' }],
    acceptanceCriteriaIds: ['validation-union'], acceptanceCriteria: [{ id: 'validation-union', description: 'Derive exact validation.' }],
    allowedPaths: ['.agents/skills/change-development/scripts/verification/**'], forbiddenPaths: [], dependencies: [],
    requiredValidation: { unit: unit ?? [{ command: 'npm run check:workflow', reason: 'Packet workflow check.' }], system },
  };
}
function evidence(value, terminalStatus = 'integrated') {
  const result = { schemaVersion: 1, changeId: value.changeId, taskId: value.taskId, planDigest: value.planDigest,
    packetDigest: implementationTaskDigest(value), specialization: value.specialization, taskBaseSha: value.taskBaseSha,
    status: terminalStatus === 'no-change' ? 'no-change' : 'implemented', workerCommit: terminalStatus === 'no-change' ? null : 'c'.repeat(40),
    changedPaths: terminalStatus === 'no-change' ? [] : ['.agents/skills/change-development/scripts/verification/contracts.mjs'],
    validation: [...value.requiredValidation.unit, ...value.requiredValidation.system].map(({ command }) => ({ command, result: 'passed', summary: 'Passed.' })),
    unexpectedDependencies: [], summary: 'Implemented exact verification contracts.' };
  const provenance = { schemaVersion: 1, taskId: value.taskId };
  const integrationReceipt = terminalStatus === 'integrated'
    ? { schemaVersion: 1, taskId: value.taskId, binding: 1, integratedCommit: 'd'.repeat(40) } : null;
  return { packet: value, result, provenance, binding: 1, packetDigest: implementationTaskDigest(value), resultDigest: digestJson(result),
    provenanceDigest: digestJson(provenance), terminalStatus, integratedCommit: integrationReceipt?.integratedCommit ?? null,
    integrationReceipt, integrationReceiptDigest: integrationReceipt === null ? null : digestJson(integrationReceipt) };
}

test('all six exact-HEAD contracts are strict and enforce clean/finding consistency', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const finding = { id: 'missing-check', priority: 'P1', summary: 'A check is missing.', evidence: 'Criterion lacks evidence.',
    affectedAreas: ['workflow'], recommendedSpecialization: 'ops-workflow', riskTags: ['workflow'], criterionIds: ['validation-union'], invariantIds: [] };
  const specialist = { schemaVersion: 1, reviewerId: 'security_reviewer', headSha: SHA, specialistPlanDigest: digest,
    status: 'clean', summary: 'No findings.', findings: [], recordedAt: AT };
  assert.deepEqual(validateVerificationContract('specialistResult', specialist), []);
  assert.ok(validateVerificationContract('specialistResult', { ...specialist, findings: [finding] }).length > 0);
  const tooManyFindings = Array.from({ length: 101 }, (_, index) => ({ ...finding, id: `finding-${index}` }));
  assert.ok(validateVerificationContract('specialistResult', { ...specialist, status: 'findings', findings: tooManyFindings }).length > 0);
  const verification = { schemaVersion: 1, headSha: SHA, contextDigest: digest, status: 'findings', summary: 'One finding.', findings: [finding], recordedAt: AT };
  assert.deepEqual(validateVerificationContract('verificationResult', verification), []);
  const context = { schemaVersion: 1, verifierId: 'development_integration_verifier', finalVerificationPriority: 'high',
    verificationRound: 1, inputIdentityDigest: digest, changeId: 'issue-24', headSha: SHA, planningSha: SHA,
    originalPlanDigest: digest, effectivePlanDigest: digest, taskSetDigest: digest,
    sourceIdentity: { kind: 'github-issue', reference: 'furinvader/aerstello#24', digest }, validationPlanDigest: digest,
    validationResultDigests: [digest], specialistResultDigests: [], evidence: [
      { kind: 'checklist', id: 'validation-union', digest, summary: 'Covered.' },
      { kind: 'planning-helper', id: 'behavior-mapper', digest, summary: 'Not routed.' },
      { kind: 'supplemental-guidance', id: 'data-integrity', digest, summary: 'Applied.' },
      { kind: 'specialist-result', id: 'security-reviewer', digest, summary: 'Clean.' },
      { kind: 'finding-disposition', id: 'finding-one', digest, summary: 'Resolved.' },
    ], generatedAt: AT };
  assert.deepEqual(validateVerificationContract('verifierContext', context), []);
  assert.ok(validateVerificationContract('verifierContext', { ...context,
    evidence: Array.from({ length: 501 }, (_, index) => ({ kind: 'criterion', id: `criterion-${index}`, digest, summary: 'Covered.' })) }).length > 0);
  const disposition = { schemaVersion: 1, sourceKind: 'verifier', sourceRole: 'development_integration_verifier', sourceResultDigest: digest, headSha: SHA,
    findingId: finding.id, fingerprint: digest, disposition: 'actionable', reason: 'Requires remediation.', amendmentId: 'fix-check',
    replacementCriterionId: 'fix-check-criterion', replacementTaskId: 'fix-check-task', recordedAt: AT };
  assert.deepEqual(validateVerificationContract('findingDisposition', disposition), []);
  assert.ok(validateVerificationContract('findingDisposition', { ...disposition, replacementTaskId: null }).length > 0);
  assert.ok(validateVerificationContract('findingDisposition', { ...disposition, sourceRole: 'security_reviewer' }).length > 0);
  const commandResult = { schemaVersion: 1, planDigest: digest, headSha: SHA, commandId: 'command-one', argv: ['npm', 'run', 'check:workflow'],
    attempt: 1, status: 'passed', startedAt: AT, completedAt: AT, exitCode: 0, signal: null, summary: 'Passed.', outputDigest: digest };
  assert.deepEqual(validateVerificationContract('validationResult', commandResult), []);
});

test('validation union is receipt-bound, deterministic, reason-preserving, and area-aware', () => {
  const first = evidence(packet());
  const second = evidence(packet({ taskId: 'release-contracts', areas: ['shared', 'release'],
    unit: [{ command: 'npm run check:workflow', reason: 'Second task reason.' }] }));
  const releaseEvidence = { schemaVersion: 1, baseSha: SHA, headSha: SHA, releaseRef: 'main', releaseRefSha: SHA,
    status: 'pre-release', latestRelease: null, frozenMigrationCount: 0, evidenceDigest: `sha256:${'e'.repeat(64)}` };
  const plan = deriveValidationPlan({ changeId: first.packet.changeId, effectivePlanDigest: first.packet.planDigest,
    headSha: SHA, taskEvidence: [first, second], createdAt: AT, releaseEvidence });
  assert.deepEqual(plan.commands.map(({ argv }) => argv.join(' ')), ['npm run check:workflow', 'npm run check:shared',
    'npm run check:api', 'npm run check:web', 'npm run check:release-state', 'npm run check:released-migrations']);
  assert.deepEqual(plan.commands[0].reasons, ['Packet workflow check.', 'Second task reason.', 'Integrated affected-area check: workflow.']);
  assert.deepEqual(plan.commands[0].taskIds, ['workflow-contracts', 'release-contracts']);
  assert.equal(plan.tasks[0].binding, 1); assert.equal(plan.tasks[0].integratedCommit, 'd'.repeat(40));
  assert.equal(plan.tasks[0].integrationReceiptDigest, first.integrationReceiptDigest);
  assert.notEqual(validationPlanDigest(plan), validationPlanReceiptDigest(plan));
  assert.throws(() => deriveValidationPlan({ changeId: first.packet.changeId, effectivePlanDigest: first.packet.planDigest, headSha: SHA,
    taskEvidence: [{ ...first, packetDigest: `sha256:${'0'.repeat(64)}` }], createdAt: AT }), /packet receipt does not match/u);
  assert.throws(() => deriveValidationPlan({ changeId: 'other-change', effectivePlanDigest: first.packet.planDigest, headSha: SHA,
    taskEvidence: [first], createdAt: AT }), /changeId does not match/u);
  assert.throws(() => deriveValidationPlan({ changeId: first.packet.changeId, effectivePlanDigest: first.packet.planDigest, headSha: SHA,
    taskEvidence: [first], createdAt: AT, releaseEvidence }), /not relevant/u);
});

test('validation plan semantic identity ignores timestamps but binds HEAD, task set, and commands', () => {
  const selected = evidence(packet());
  const plan = deriveValidationPlan({ changeId: selected.packet.changeId, effectivePlanDigest: selected.packet.planDigest,
    headSha: SHA, taskEvidence: [selected], createdAt: AT });
  const identity = validationPlanDigest(plan);
  assert.equal(validationPlanDigest({ ...plan, createdAt: '2026-08-18T10:01:00Z' }), identity);
  assert.notEqual(validationPlanDigest({ ...plan, headSha: 'f'.repeat(40) }), identity);
  const changedTasks = [{ ...plan.tasks[0], binding: 2 }];
  assert.notEqual(validationPlanDigest({ ...plan, tasks: changedTasks, taskSetDigest: digestJson(changedTasks) }), identity);
  assert.notEqual(validationPlanDigest({ ...plan, commands: [{ ...plan.commands[0], reasons: ['Changed semantic reason.'] }] }), identity);
});

test('related E2E canonicalization reuses the planner and rejects empty, unknown, and full scopes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'development-verification-e2e-'));
  try {
    writeFileSync(join(directory, 'scope.feature'), '@browser-webkit\nFeature: Scope\n\n  @id-zeta @smoke\n  Scenario: Zeta\n    Given a step\n');
    const entry = canonicalizeValidationEntry({
      command: 'npm run test:e2e:related -- --project mobile-webkit --id zeta --project tablet-chromium --tag smoke',
      reason: 'Exact browser scope.', selectors: ['@id-zeta', '@smoke'], projects: ['mobile-webkit', 'tablet-chromium'],
    }, { featureDirectory: directory });
    assert.deepEqual(entry.selectors, ['@id-zeta', '@smoke']);
    assert.deepEqual(entry.projects, ['tablet-chromium', 'mobile-webkit']);
    assert.equal(entry.argv.join(' '), 'npm run test:e2e:related -- --tag @id-zeta --tag @smoke --project tablet-chromium --project mobile-webkit');
    assert.throws(() => canonicalizeValidationEntry({ command: 'npm run test:e2e:related -- --project tablet-chromium', reason: 'Empty.' }, { featureDirectory: directory }), /unsafe, broad|at least one/u);
    assert.throws(() => canonicalizeValidationEntry({ command: 'npm run test:e2e:full', reason: 'Broad.' }), /unsafe, broad/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('finding fingerprints survive HEAD and wording changes but remain source-role qualified', () => {
  const finding = { id: 'scope-drift', priority: 'P2', evidence: 'Unexpected path.', criterionIds: ['b', 'a'], invariantIds: [],
    affectedAreas: ['workflow'], riskTags: ['workflow'], recommendedSpecialization: 'ops-workflow' };
  const first = findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier', headSha: SHA, finding });
  const reordered = findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier',
    headSha: 'f'.repeat(40), finding: { ...finding, criterionIds: ['a', 'b'], evidence: 'Different wording at a later HEAD.' } });
  assert.equal(first, reordered);
  assert.equal(first, findingFingerprint({ sourceKind: 'verifier', sourceRole: 'development_integration_verifier', finding }));
  assert.notEqual(first, findingFingerprint({ sourceKind: 'specialist', sourceRole: 'security_reviewer', finding }));
  assert.notEqual(findingFingerprint({ sourceKind: 'specialist', sourceRole: 'security_reviewer', finding }),
    findingFingerprint({ sourceKind: 'specialist', sourceRole: 'offline_realtime_reviewer', finding }));
});
