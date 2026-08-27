import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import * as harness from './test-support/state-harness.mjs';
import {
  checkpointScopeAuthority,
  checkpointScopeClassification,
  checkpointScopeDecision,
  checkpointScopeResume,
  checkpointScopeReturn,
  checkpointTaskPacketBinding,
  initializeState,
  scopeStatus,
} from './state.mjs';
import {
  scopeAuthorityPath,
  scopeAuthorityReceiptPath,
  scopeControlJournalPath,
  scopeControlJournalReceiptPath,
} from './locations.mjs';
import { validateScopeAssessmentApplicability } from '../../../scope-review/scripts/validate-assessment.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;

function authority(headSha, authorityKind = 'standalone') {
  return {
    schemaVersion: 1,
    authorityKind,
    source: { type: 'github-issue', identity: 'example/aerstello#17', digest: DIGEST },
    planDigest: PLAN_DIGEST,
    amendmentDigests: [],
    minimalClosure: { statement: 'The exact accepted remediation is sufficient.', digest: DIGEST },
    handoffHeadSha: headSha,
    integratedHeadAssessment: null,
    approvedDecisions: [],
    deferredFollowUps: [],
    capturedAt: harness.AT,
  };
}

function pairDigest(packet, result) {
  return `sha256:${createHash('sha256').update(JSON.stringify(
    harness.canonicalJsonForTest({ packet, result }),
  )).digest('hex')}`;
}

function assessmentPair(headSha, packet, verdict = 'within-scope') {
  const base = harness.scopePair(headSha, packet);
  const assessmentPacket = structuredClone(base.packet);
  const result = structuredClone(base.result);
  if (verdict === 'trim-required') {
    const mapping = {
      mechanism: 'extra-checker', sourceCriterionIds: [], acceptedCriterionIds: [],
      invariantIds: [], nonGoalIds: [], guidanceIds: [], rationale: 'No authority requires the checker.',
    };
    assessmentPacket.changeInventory.paths.push('scripts/extra-checker.mjs');
    assessmentPacket.changeInventory.mappings.push(mapping);
    result.verdict = verdict;
    result.coverage.push({ ...mapping, classification: 'speculative' });
    result.unnecessaryWork = ['extra-checker'];
    result.smallerSufficientAlternative = 'Keep only the exact task packet.';
  } else if (verdict === 'minor-amendment-required') {
    const mapping = {
      mechanism: 'adjacent-helper', sourceCriterionIds: ['bounded-remediation'],
      acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
      rationale: 'The helper is adjacent and grounded but absent from accepted shape.',
    };
    assessmentPacket.changeInventory.paths.push('scripts/adjacent-helper.mjs');
    assessmentPacket.changeInventory.mappings.push(mapping);
    result.verdict = verdict;
    result.coverage.push({ ...mapping, classification: 'necessary-minor-expansion' });
    result.scopeDelta = {
      description: 'Add the grounded adjacent helper.',
      sourceCriterionIds: ['bounded-remediation'], acceptedCriterionIds: ['bounded-remediation'],
      invariantIds: [], materialSurfaces: [],
    };
  } else if (verdict === 'human-decision-required') {
    const mapping = {
      mechanism: 'new-package', sourceCriterionIds: ['bounded-remediation'],
      acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
      rationale: 'The dependency is relevant but not authorized by accepted shape.',
    };
    assessmentPacket.changeInventory.dependencies.push('new-package');
    assessmentPacket.changeInventory.mappings.push(mapping);
    result.verdict = verdict;
    result.coverage.push({ ...mapping, classification: 'material-scope-change' });
    result.scopeDelta = {
      description: 'Add one new dependency.',
      sourceCriterionIds: ['bounded-remediation'], acceptedCriterionIds: ['bounded-remediation'],
      invariantIds: [], materialSurfaces: ['new-dependency'],
    };
    result.materialityTriggers = [{ category: 'new-dependency', evidence: 'The inventory adds new-package.' }];
    result.smallestExpansion = 'Add only new-package.';
    result.narrowAlternative = 'Keep the direct bounded remediation.';
    result.deferralConsequences = 'The dependency-backed mechanism remains unavailable.';
    result.humanDecision = true;
  } else if (verdict === 'insufficient-evidence') {
    result.verdict = verdict;
    result.coverage = result.coverage.map((row) => ({ ...row, classification: 'insufficient-evidence' }));
    result.missingEvidence = ['The accepted remediation authority is incomplete.'];
  }
  assert.deepEqual(validateScopeAssessmentApplicability(assessmentPacket, result), [], verdict);
  return { packet: assessmentPacket, result, digest: pairDigest(assessmentPacket, result) };
}

function proposedFixture(cwd, taskId = 'scope-task') {
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: taskId, status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, taskId, {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  const adopted = checkpointScopeAuthority({
    cwd, authority: authority(initial.currentIntegrationHeadSha), expectedRevision: proposed.revision,
  });
  return { initial, proposed, packet, adopted, task: adopted.tasks[0] };
}

function classificationInput(fixture, verdict, overrides = {}) {
  const pair = assessmentPair(fixture.packet.reviewedHeadSha, fixture.packet, verdict);
  const mapping = new Map([
    ['within-scope', ['within-scope-defect', false]],
    ['trim-required', ['unnecessary-mechanism-defect', false]],
    ['minor-amendment-required', ['within-scope-defect', true]],
    ['human-decision-required', ['material-scope-change', false]],
    ['insufficient-evidence', ['insufficient-scope-authority', false]],
  ]).get(verdict);
  return {
    entryId: `classification-${verdict.replaceAll(/[^a-z]+/gu, '-')}`,
    at: harness.AT,
    reviewHeadSha: fixture.packet.reviewedHeadSha,
    rootCauseId: 'scope-root',
    findingIds: fixture.task.sourceIds,
    findingFingerprints: fixture.task.sourceIds.map(() => fixture.task.fingerprint),
    classification: mapping[0], assessment: pair,
    authorityAmendmentRequired: mapping[1], unrelatedReference: null,
    remediationShapeDigest: `sha256:${harness.taskPacketDigest(fixture.packet)}`,
    tripwires: [],
    ...overrides,
  };
}

test('initialization atomically captures explicit authority and its empty journal', () => {
  const cwd = harness.repo();
  const headSha = harness.git(cwd, ['rev-parse', 'HEAD']).trim();
  const state = initializeState({
    cwd, prNumber: 17, repository: 'example/aerstello', base: 'HEAD', head: 'HEAD',
    releaseRef: 'HEAD', scopeAuthority: authority(headSha),
  });

  assert.equal(state.revision, 0);
  assert.equal(state.scopeControl.gate, 'ready');
  assert.equal(state.scopeControl.assessmentHeadSha, null);
  for (const path of [
    scopeAuthorityPath(cwd, 17), scopeAuthorityReceiptPath(cwd, 17),
    scopeControlJournalPath(cwd, 17), scopeControlJournalReceiptPath(cwd, 17),
  ]) assert.equal(existsSync(path), true, path);
  assert.match(readFileSync(scopeAuthorityReceiptPath(cwd, 17), 'utf8'), /^sha256:[0-9a-f]{64}\n$/u);
  assert.deepEqual(scopeStatus({ cwd, prNumber: 17 }).journal.value.entries, []);
});

test('legacy schema-v3 stays readable but cannot bind before guarded adoption and classification', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'scope-gated-task', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'scope-gated-task', {
    affectedAreas: ['workflow'], command: 'npm run check:workflow',
  });
  harness.planSpecialists({
    cwd, input: harness.planInput(proposed, packet), expectedRevision: proposed.revision,
    now: () => harness.AT,
  });

  assert.equal(harness.loadState(cwd).scopeControl, undefined);
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet, expectedRevision: proposed.revision,
  }), { code: 'SCOPE_AUTHORITY_REQUIRED' });

  const bound = harness.bindPacket(cwd, proposed, packet);
  assert.equal(bound.scopeControl.gate, 'ready');
  assert.equal(bound.tasks[0].taskPacketDigest, harness.taskPacketDigest(packet));
  const status = scopeStatus({ cwd });
  assert.equal(status.journal.value.entries.filter((entry) => entry.kind === 'classification').length, 1);
});

test('guarded legacy adoption refuses active worker state and preserves historical tasks', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const runningTask = harness.task(initial.currentIntegrationHeadSha, {
    id: 'active-worker', status: 'running', integratedCommitSha: null, resolutionSummary: null,
  });
  const legacy = harness.writePreAuthorityTasks(cwd, initial, [runningTask]);

  assert.throws(() => checkpointScopeAuthority({
    cwd, authority: authority(initial.currentIntegrationHeadSha, 'legacy-adoption'),
    expectedRevision: legacy.revision,
  }), { code: 'SCOPE_ADOPTION_ACTIVE_WORKER' });
  assert.deepEqual(harness.loadState(cwd).tasks, [runningTask]);
  assert.equal(existsSync(scopeAuthorityPath(cwd, 17)), false);
});

test('integration-head drift invalidates only compact exact-head applicability', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd, expectedRevision: initial.revision,
    nextState: {
      ...initial,
      tasks: [harness.task(initial.currentIntegrationHeadSha, {
        id: 'head-sensitive-task', status: 'proposed', integratedCommitSha: null, resolutionSummary: null,
      })],
    },
  });
  const packet = harness.taskPacket(initial.currentIntegrationHeadSha, 'head-sensitive-task');
  const scoped = harness.scopeReadyForPacket(cwd, proposed, packet);
  const journalDigest = scoped.scopeControl.journalDigest;
  assert.equal(scoped.scopeControl.assessmentHeadSha, packet.reviewedHeadSha);

  harness.commit(cwd, { 'scripts/unrelated.mjs': 'export const unrelated = true;\n' }, 'advance integration head');
  const advanced = harness.checkpointGitMetadata({ cwd }).state;
  assert.equal(advanced.scopeControl.gate, 'ready');
  assert.equal(advanced.scopeControl.assessmentHeadSha, null);
  assert.equal(advanced.scopeControl.journalDigest, journalDigest);
  assert.equal(scopeStatus({ cwd }).journal.digest, journalDigest);
});

test('all canonical verdict mappings drive the closed state gates', () => {
  const expectations = new Map([
    ['within-scope', 'ready'],
    ['trim-required', 'ready'],
    ['minor-amendment-required', 'decision-required'],
    ['human-decision-required', 'decision-required'],
    ['insufficient-evidence', 'insufficient-authority'],
  ]);
  for (const [verdict, expectedGate] of expectations) {
    const cwd = harness.repo();
    const fixture = proposedFixture(cwd, `mapping-${verdict.replaceAll(/[^a-z]+/gu, '-')}`);
    const classified = checkpointScopeClassification({
      cwd,
      classification: classificationInput(fixture, verdict),
      expectedRevision: fixture.adopted.revision,
    });
    assert.equal(classified.scopeControl.gate, expectedGate, verdict);
    if (verdict === 'minor-amendment-required') {
      harness.planSpecialists({
        cwd, input: harness.planInput(classified, fixture.packet), expectedRevision: classified.revision,
        now: () => harness.AT,
      });
      assert.throws(() => checkpointTaskPacketBinding({
        cwd, packet: fixture.packet, expectedRevision: classified.revision,
      }), { code: 'SCOPE_TASK_BLOCKED' });
    }
  }
});

test('exact packet classification is reusable for duplicate roots and rejects changed shape', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'duplicate-root-task');
  const classification = classificationInput(fixture, 'within-scope');
  const classified = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  const retried = checkpointScopeClassification({
    cwd, classification, expectedRevision: classified.revision,
  });
  assert.equal(retried.revision, classified.revision);
  assert.equal(scopeStatus({ cwd }).journal.value.entries.filter(
    (entry) => entry.kind === 'classification' && entry.rootCauseId === classification.rootCauseId,
  ).length, 1);

  harness.planSpecialists({
    cwd, input: harness.planInput(classified, fixture.packet), expectedRevision: classified.revision,
    now: () => harness.AT,
  });
  const changedPacket = { ...fixture.packet, evidence: 'A changed remediation shape.' };
  assert.throws(() => checkpointTaskPacketBinding({
    cwd, packet: changedPacket, expectedRevision: classified.revision,
  }), { code: 'SPECIALIST_PLAN_TASK_MISMATCH' });
  const bound = checkpointTaskPacketBinding({
    cwd, packet: fixture.packet, expectedRevision: classified.revision,
  });
  assert.equal(bound.tasks[0].taskPacketDigest, harness.taskPacketDigest(fixture.packet));
});

test('material return and resume preserve review history and stop a second expansion', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'material-return-task');
  const material = classificationInput(fixture, 'human-decision-required');
  const classified = checkpointScopeClassification({
    cwd, classification: material, expectedRevision: fixture.adopted.revision,
  });
  const taskSnapshot = structuredClone(classified.tasks);
  const decision = {
    entryId: 'decision-approve-one', at: harness.AT, rootCauseId: material.rootCauseId,
    blockerId: 'scope-blocker-one', decisionId: 'scope-decision-one',
    decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
    approvedDeltaDigest: PLAN_DIGEST, rationale: 'Approve only the named dependency.',
    priorDecisionIds: [],
  };
  const decided = checkpointScopeDecision({
    cwd, decision, expectedRevision: classified.revision,
  });
  assert.equal(decided.scopeControl.gate, 'return-pending');
  assert.throws(() => checkpointScopeClassification({
    cwd, classification: { ...material, entryId: 'classification-during-return-pending' },
    expectedRevision: decided.revision,
  }), { code: 'SCOPE_CLASSIFICATION_BLOCKED' });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha, expectedRevision: decided.revision,
  });
  assert.equal(returned.scopeControl.gate, 'returned');
  assert.throws(() => checkpointScopeClassification({
    cwd, classification: { ...material, entryId: 'classification-while-returned' },
    expectedRevision: returned.revision,
  }), { code: 'SCOPE_CLASSIFICATION_BLOCKED' });
  assert.deepEqual(returned.tasks, taskSnapshot);
  const returnDigest = returned.scopeControl.returnDigest;
  const resumed = checkpointScopeResume({
    cwd,
    expectedRevision: returned.revision,
    resume: {
      entryId: 'resume-scope-one', at: harness.AT, rootCauseId: material.rootCauseId,
      decisionId: decision.decisionId, scopeReturnDigest: returnDigest,
      resumedAuthorityDigest: returned.scopeControl.authorityDigest,
      resumedHeadSha: returned.currentIntegrationHeadSha,
    },
  });
  assert.equal(resumed.scopeControl.gate, 'ready');
  assert.deepEqual(resumed.tasks, taskSnapshot);

  const secondMaterial = classificationInput(fixture, 'human-decision-required', {
    entryId: 'classification-human-decision-second',
    remediationShapeDigest: DIGEST,
  });
  const secondClassified = checkpointScopeClassification({
    cwd, classification: secondMaterial, expectedRevision: resumed.revision,
  });
  const churned = checkpointScopeDecision({
    cwd,
    expectedRevision: secondClassified.revision,
    decision: {
      ...decision,
      entryId: 'decision-approve-two', blockerId: 'scope-blocker-two',
      decisionId: 'scope-decision-two', priorDecisionIds: [decision.decisionId],
    },
  });
  assert.equal(churned.phase, 'blocked');
  assert.match(churned.blockedReasons.join('\n'), /repeated expansion churn/u);
});

test('scope classification remains locked after returned HEAD drift', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'resume-required-task');
  const material = classificationInput(fixture, 'human-decision-required');
  const classified = checkpointScopeClassification({
    cwd, classification: material, expectedRevision: fixture.adopted.revision,
  });
  const decided = checkpointScopeDecision({
    cwd,
    expectedRevision: classified.revision,
    decision: {
      entryId: 'decision-resume-required', at: harness.AT, rootCauseId: material.rootCauseId,
      blockerId: 'scope-blocker-resume-required', decisionId: 'scope-decision-resume-required',
      decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
      approvedDeltaDigest: PLAN_DIGEST, rationale: 'Approve the bounded return.',
      priorDecisionIds: [],
    },
  });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha, expectedRevision: decided.revision,
  });
  harness.commit(cwd, { 'scripts/scope-head-drift.mjs': 'export const drift = true;\n' }, 'drift scope head');
  const advanced = harness.checkpointGitMetadata({ cwd }).state;
  assert.equal(returned.scopeControl.gate, 'returned');
  assert.equal(advanced.scopeControl.gate, 'resume-required');
  assert.throws(() => checkpointScopeClassification({
    cwd, classification: { ...material, entryId: 'classification-during-resume-required' },
    expectedRevision: advanced.revision,
  }), { code: 'SCOPE_CLASSIFICATION_BLOCKED' });
});

test('scope resume identity must match the guarded return envelope, not older journal roots', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'multi-root-resume-task');
  const older = classificationInput(fixture, 'human-decision-required', {
    entryId: 'classification-older-root', rootCauseId: 'older-scope-root',
  });
  const olderClassified = checkpointScopeClassification({
    cwd, classification: older, expectedRevision: fixture.adopted.revision,
  });
  const olderDecision = {
    entryId: 'decision-older-root', at: harness.AT, rootCauseId: older.rootCauseId,
    blockerId: 'scope-blocker-older-root', decisionId: 'scope-decision-older-root',
    decision: 'reject-expansion', blockerDigest: DIGEST,
    approvedDeltaDigest: null, rationale: 'Keep the earlier root narrow.', priorDecisionIds: [],
  };
  const olderDecided = checkpointScopeDecision({
    cwd, decision: olderDecision, expectedRevision: olderClassified.revision,
  });
  const current = classificationInput(fixture, 'human-decision-required', {
    entryId: 'classification-current-root', rootCauseId: 'current-scope-root',
  });
  const currentClassified = checkpointScopeClassification({
    cwd, classification: current, expectedRevision: olderDecided.revision,
  });
  const currentDecision = {
    entryId: 'decision-current-root', at: harness.AT, rootCauseId: current.rootCauseId,
    blockerId: 'scope-blocker-current-root', decisionId: 'scope-decision-current-root',
    decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
    approvedDeltaDigest: PLAN_DIGEST, rationale: 'Return the current bounded root.', priorDecisionIds: [],
  };
  const decided = checkpointScopeDecision({
    cwd, decision: currentDecision, expectedRevision: currentClassified.revision,
  });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha, expectedRevision: decided.revision,
  });
  assert.throws(() => checkpointScopeResume({
    cwd,
    expectedRevision: returned.revision,
    resume: {
      entryId: 'resume-wrong-journal-root', at: harness.AT,
      rootCauseId: older.rootCauseId, decisionId: olderDecision.decisionId,
      scopeReturnDigest: returned.scopeControl.returnDigest,
      resumedAuthorityDigest: returned.scopeControl.authorityDigest,
      resumedHeadSha: returned.currentIntegrationHeadSha,
    },
  }), { code: 'INVALID_SCOPE_RESUME' });
  assert.throws(() => checkpointScopeResume({
    cwd,
    expectedRevision: returned.revision,
    resume: {
      entryId: 'resume-wrong-decision', at: harness.AT,
      rootCauseId: current.rootCauseId, decisionId: olderDecision.decisionId,
      scopeReturnDigest: returned.scopeControl.returnDigest,
      resumedAuthorityDigest: returned.scopeControl.authorityDigest,
      resumedHeadSha: returned.currentIntegrationHeadSha,
    },
  }), { code: 'INVALID_SCOPE_RESUME' });
});

test('minor amendment stays blocked until an atomic authority chain and fresh assessment', () => {
  const amendmentDigest = `sha256:${'c'.repeat(64)}`;
  const revisedAuthorityDigest = `sha256:${'d'.repeat(64)}`;
  const decisionInput = {
    entryId: 'decision-minor-one', at: harness.AT, rootCauseId: 'scope-root',
    blockerId: 'scope-blocker-minor', decisionId: 'scope-decision-minor',
    decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
    approvedDeltaDigest: amendmentDigest, rationale: 'Approve only the bounded amendment.',
    priorDecisionIds: [],
  };

  const bareCwd = harness.repo();
  const bareFixture = proposedFixture(bareCwd, 'bare-minor-task');
  const bareClassification = classificationInput(bareFixture, 'minor-amendment-required');
  const bareClassified = checkpointScopeClassification({
    cwd: bareCwd, classification: bareClassification, expectedRevision: bareFixture.adopted.revision,
  });
  const bareDecision = checkpointScopeDecision({
    cwd: bareCwd, decision: decisionInput, expectedRevision: bareClassified.revision,
  });
  assert.equal(bareDecision.scopeControl.gate, 'decision-required');
  harness.planSpecialists({
    cwd: bareCwd, input: harness.planInput(bareDecision, bareFixture.packet),
    expectedRevision: bareDecision.revision, now: () => harness.AT,
  });
  assert.throws(() => checkpointTaskPacketBinding({
    cwd: bareCwd, packet: bareFixture.packet, expectedRevision: bareDecision.revision,
  }), { code: 'SCOPE_TASK_BLOCKED' });

  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'amended-minor-task');
  const minor = classificationInput(fixture, 'minor-amendment-required');
  const classified = checkpointScopeClassification({
    cwd, classification: minor, expectedRevision: fixture.adopted.revision,
  });
  const priorAuthorityDigest = classified.scopeControl.authorityDigest;
  const amendment = {
    entryId: 'amendment-minor-one', at: harness.AT,
    rootCauseId: minor.rootCauseId, decisionId: decisionInput.decisionId,
    amendmentDigest, priorAuthorityDigest, revisedAuthorityDigest,
  };
  assert.throws(() => checkpointScopeDecision({
    cwd,
    decision: { ...decisionInput, amendment },
    expectedRevision: classified.revision,
    event: { type: 'invalid-scope-event', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(harness.loadState(cwd).scopeControl.journalDigest, classified.scopeControl.journalDigest);

  const amended = checkpointScopeDecision({
    cwd,
    decision: { ...decisionInput, amendment },
    expectedRevision: classified.revision,
  });
  assert.equal(amended.scopeControl.authorityDigest, revisedAuthorityDigest);
  assert.equal(amended.scopeControl.gate, 'decision-required');
  assert.deepEqual(scopeStatus({ cwd }).journal.value.entries.slice(-2).map((entry) => entry.kind), [
    'decision', 'amendment',
  ]);

  const fresh = classificationInput(fixture, 'within-scope', {
    entryId: 'classification-revised-authority',
  });
  fresh.assessment.packet.binding.amendmentDigests = [amendmentDigest];
  fresh.assessment.result.binding.amendmentDigests = [amendmentDigest];
  fresh.assessment.digest = pairDigest(fresh.assessment.packet, fresh.assessment.result);
  const ready = checkpointScopeClassification({
    cwd, classification: fresh, expectedRevision: amended.revision,
  });
  assert.equal(ready.scopeControl.gate, 'ready');

  const staleCwd = harness.repo();
  const staleFixture = proposedFixture(staleCwd, 'stale-amendment-task');
  const staleMinor = classificationInput(staleFixture, 'minor-amendment-required');
  const staleClassified = checkpointScopeClassification({
    cwd: staleCwd, classification: staleMinor, expectedRevision: staleFixture.adopted.revision,
  });
  assert.throws(() => checkpointScopeDecision({
    cwd: staleCwd,
    decision: {
      ...decisionInput,
      amendment: {
        ...amendment,
        priorAuthorityDigest: revisedAuthorityDigest,
      },
    },
    expectedRevision: staleClassified.revision,
  }), { code: 'INVALID_SCOPE_EVIDENCE' });
});

test('returned scope atomically imports amendment and resume evidence', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'returned-amendment-task');
  const material = classificationInput(fixture, 'human-decision-required');
  const classified = checkpointScopeClassification({
    cwd, classification: material, expectedRevision: fixture.adopted.revision,
  });
  const decision = {
    entryId: 'decision-return-amendment', at: harness.AT, rootCauseId: material.rootCauseId,
    blockerId: 'scope-blocker-return', decisionId: 'scope-decision-return',
    decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
    approvedDeltaDigest: PLAN_DIGEST, rationale: 'Approve the returned bounded authority.',
    priorDecisionIds: [],
  };
  const decided = checkpointScopeDecision({
    cwd, decision, expectedRevision: classified.revision,
  });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha, expectedRevision: decided.revision,
  });
  const revisedAuthorityDigest = `sha256:${'e'.repeat(64)}`;
  const resume = {
    entryId: 'resume-return-amendment', at: harness.AT, rootCauseId: material.rootCauseId,
    decisionId: decision.decisionId, scopeReturnDigest: returned.scopeControl.returnDigest,
    resumedAuthorityDigest: revisedAuthorityDigest,
    resumedHeadSha: returned.currentIntegrationHeadSha,
    amendment: {
      entryId: 'amendment-return-one', at: harness.AT, rootCauseId: material.rootCauseId,
      decisionId: decision.decisionId, amendmentDigest: PLAN_DIGEST,
      priorAuthorityDigest: returned.scopeControl.authorityDigest,
      revisedAuthorityDigest,
    },
  };
  assert.throws(() => checkpointScopeResume({
    cwd,
    expectedRevision: returned.revision,
    resume: {
      ...resume,
      rootCauseId: 'unrelated-amendment-root',
      amendment: { ...resume.amendment, rootCauseId: 'unrelated-amendment-root' },
    },
  }), { code: 'INVALID_SCOPE_RESUME' });
  assert.throws(() => checkpointScopeResume({
    cwd,
    expectedRevision: returned.revision,
    resume,
    event: { type: 'invalid-scope-event', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(harness.loadState(cwd).scopeControl.journalDigest, returned.scopeControl.journalDigest);

  const resumed = checkpointScopeResume({
    cwd, expectedRevision: returned.revision, resume,
  });
  assert.equal(resumed.scopeControl.gate, 'decision-required');
  assert.equal(resumed.scopeControl.authorityDigest, revisedAuthorityDigest);
  assert.deepEqual(scopeStatus({ cwd }).journal.value.entries.slice(-2).map((entry) => entry.kind), [
    'amendment', 'resume',
  ]);

  const fresh = classificationInput(fixture, 'within-scope', {
    entryId: 'classification-returned-revised-authority',
  });
  fresh.assessment.packet.binding.amendmentDigests = [PLAN_DIGEST];
  fresh.assessment.result.binding.amendmentDigests = [PLAN_DIGEST];
  fresh.assessment.digest = pairDigest(fresh.assessment.packet, fresh.assessment.result);
  const ready = checkpointScopeClassification({
    cwd, classification: fresh, expectedRevision: resumed.revision,
  });
  assert.equal(ready.scopeControl.gate, 'ready');
});

test('journal checkpoint interruption resumes exact evidence and tampering fails closed', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'journal-recovery-task');
  const classification = classificationInput(fixture, 'within-scope');
  assert.throws(() => checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
    event: { type: 'invalid-scope-event', summary: 'x'.repeat(1001) },
  }), { code: 'INVALID_EVENT' });
  assert.equal(harness.loadState(cwd).scopeControl.journalDigest, fixture.adopted.scopeControl.journalDigest);

  const recovered = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  assert.equal(recovered.scopeControl.gate, 'ready');
  assert.equal(scopeStatus({ cwd }).journal.value.entries.at(-1).entryId, classification.entryId);

  writeFileSync(scopeControlJournalReceiptPath(cwd, 17), `${DIGEST}\n`);
  assert.throws(() => scopeStatus({ cwd }), { code: 'INVALID_SCOPE_EVIDENCE' });
});

test('integrated-head classifications append one canonical manifest and reuse it exactly', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'manifest-task');
  const classification = classificationInput(fixture, 'within-scope');
  classification.assessment.packet.binding.phase = 'integrated-head';
  classification.assessment.result.binding.phase = 'integrated-head';
  classification.assessment.digest = pairDigest(
    classification.assessment.packet, classification.assessment.result,
  );
  assert.deepEqual(validateScopeAssessmentApplicability(
    classification.assessment.packet, classification.assessment.result,
  ), []);
  const classified = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  const entries = scopeStatus({ cwd }).journal.value.entries;
  assert.deepEqual(entries.map((entry) => entry.kind), ['classification', 'exact-head-manifest']);
  assert.equal(entries[1].assessmentDigest, classification.assessment.digest);
  const retry = checkpointScopeClassification({
    cwd, classification, expectedRevision: classified.revision,
  });
  assert.equal(retry.revision, classified.revision);
  assert.deepEqual(scopeStatus({ cwd }).journal.value.entries, entries);
});
