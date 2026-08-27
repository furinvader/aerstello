import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import * as harness from './test-support/state-harness.mjs';
import {
  persistScopeReturn,
  readScopeAuthority,
  readScopeJournal,
  readScopeReturn,
  scopeReturnDigest,
} from './evidence/scope-control.mjs';
import { canonicalSerializedJson } from './atomic-io.mjs';
import {
  scopeAuthorityPath,
  scopeAuthorityReceiptPath,
  scopeControlJournalPath,
  scopeControlJournalReceiptPath,
  scopeReturnPath,
  scopeReturnReceiptPath,
} from './locations.mjs';
import {
  checkpointScopeAuthority,
  checkpointScopeClassification,
  checkpointScopeDecision,
  checkpointScopeResume,
  checkpointScopeReturn,
  initializeState,
  scopeStatus,
} from './state.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const INVALID_EVENT = { type: 'invalid-scope-event', summary: 'x'.repeat(1001) };

function authority(headSha) {
  return {
    schemaVersion: 1,
    authorityKind: 'standalone',
    source: { type: 'github-issue', identity: 'example/aerstello#17', digest: DIGEST },
    planDigest: PLAN_DIGEST,
    amendmentDigests: [],
    minimalClosure: { statement: 'The accepted remediation remains the minimal closure.', digest: DIGEST },
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

function proposedFixture(cwd, taskId) {
  const initial = harness.init(cwd);
  const proposed = harness.checkpointState({
    cwd,
    expectedRevision: initial.revision,
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
  return { packet, adopted, task: adopted.tasks[0] };
}

function classificationInput(fixture, verdict = 'within-scope') {
  const pair = harness.scopePair(fixture.packet.reviewedHeadSha, fixture.packet);
  if (verdict === 'human-decision-required') {
    const mapping = {
      mechanism: 'new-package', sourceCriterionIds: ['bounded-remediation'],
      acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], nonGoalIds: [], guidanceIds: [],
      rationale: 'The dependency is relevant but requires explicit approval.',
    };
    pair.packet.changeInventory.dependencies.push('new-package');
    pair.packet.changeInventory.mappings.push(mapping);
    pair.result.verdict = verdict;
    pair.result.coverage.push({ ...mapping, classification: 'material-scope-change' });
    pair.result.scopeDelta = {
      description: 'Add one new dependency.', sourceCriterionIds: ['bounded-remediation'],
      acceptedCriterionIds: ['bounded-remediation'], invariantIds: [], materialSurfaces: ['new-dependency'],
    };
    pair.result.materialityTriggers = [{ category: 'new-dependency', evidence: 'The inventory adds new-package.' }];
    pair.result.smallestExpansion = 'Add only new-package.';
    pair.result.narrowAlternative = 'Keep the direct bounded remediation.';
    pair.result.deferralConsequences = 'The dependency-backed mechanism remains unavailable.';
    pair.result.humanDecision = true;
  }
  return {
    entryId: `classification-${verdict}`,
    at: harness.AT,
    reviewHeadSha: fixture.packet.reviewedHeadSha,
    rootCauseId: fixture.task.id,
    findingIds: fixture.task.sourceIds,
    findingFingerprints: fixture.task.sourceIds.map(
      (_sourceId, index) => `${fixture.task.fingerprint}-f${index + 1}`,
    ),
    classification: verdict === 'human-decision-required' ? 'material-scope-change' : 'within-scope-defect',
    assessment: { packet: pair.packet, result: pair.result, digest: pairDigest(pair.packet, pair.result) },
    authorityAmendmentRequired: false,
    unrelatedReference: null,
    remediationShapeDigest: `sha256:${harness.taskPacketDigest(fixture.packet)}`,
    tripwires: [],
  };
}

function decisionInput(rootCauseId = 'scope-root') {
  return {
    entryId: 'decision-scope-return', at: harness.AT, rootCauseId,
    blockerId: 'scope-blocker', decisionId: 'scope-decision',
    decision: 'approve-expansion-and-replan', blockerDigest: DIGEST,
    approvedDeltaDigest: PLAN_DIGEST, rationale: 'Approve only the bounded return.', priorDecisionIds: [],
  };
}

function scopeReturn(state) {
  return {
    schemaVersion: 1,
    repository: state.repository,
    prNumber: state.prNumber,
    authorityDigest: state.scopeControl.authorityDigest,
    journalDigest: state.scopeControl.journalDigest,
    blockerId: 'scope-blocker-one',
    decisionId: 'scope-decision-one',
    reviewHeadSha: state.currentIntegrationHeadSha,
    livePrHeadSha: state.currentIntegrationHeadSha,
    rootCauseId: 'scope-root-one',
    findingIds: ['local:scope-root-one'],
    findingFingerprints: ['scope-fingerprint-one'],
    assessmentDigest: DIGEST,
    smallestExpansion: 'Add only the explicitly approved scope.',
    narrowAlternative: 'Retain the current bounded remediation.',
    trimAlternative: null,
    inventory: {
      paths: ['scripts/example.mjs'],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      validation: ['node --test scripts/example.test.mjs'],
    },
    priorDecisionIds: [],
    createdAt: harness.AT,
  };
}

function fixture() {
  const cwd = harness.repo();
  const headSha = harness.git(cwd, ['rev-parse', 'HEAD']).trim();
  const state = initializeState({
    cwd,
    prNumber: 17,
    repository: 'example/aerstello',
    base: 'HEAD',
    head: 'HEAD',
    releaseRef: 'HEAD',
    scopeAuthority: authority(headSha),
  });
  const envelope = scopeReturn(state);
  persistScopeReturn(cwd, state, envelope);
  return { cwd, state, envelope };
}

function evidencePairs(cwd, state, envelope) {
  return [
    {
      label: 'scope authority',
      documentPath: scopeAuthorityPath(cwd, state.prNumber),
      receiptPath: scopeAuthorityReceiptPath(cwd, state.prNumber),
      read: () => readScopeAuthority(cwd, state),
      digest: state.scopeControl.authorityDigest,
    },
    {
      label: 'scope control journal',
      documentPath: scopeControlJournalPath(cwd, state.prNumber),
      receiptPath: scopeControlJournalReceiptPath(cwd, state.prNumber),
      read: () => readScopeJournal(cwd, state),
      digest: state.scopeControl.journalDigest,
    },
    {
      label: 'scope return',
      documentPath: scopeReturnPath(cwd, state.prNumber),
      receiptPath: scopeReturnReceiptPath(cwd, state.prNumber),
      read: () => readScopeReturn(cwd, state),
      digest: scopeReturnDigest(envelope),
    },
  ];
}

test('complete scope-evidence pairs are strict read-only inputs', () => {
  const { cwd, state, envelope } = fixture();

  for (const pair of evidencePairs(cwd, state, envelope)) {
    const documentBefore = readFileSync(pair.documentPath);
    const receiptBefore = readFileSync(pair.receiptPath);
    assert.equal(pair.read().digest, pair.digest, pair.label);
    assert.deepEqual(readFileSync(pair.documentPath), documentBefore, `${pair.label} document changed`);
    assert.deepEqual(readFileSync(pair.receiptPath), receiptBefore, `${pair.label} receipt changed`);
  }
});

test('strict scope-evidence reads do not repair a missing receipt', () => {
  for (const pairIndex of [0, 1, 2]) {
    const { cwd, state, envelope } = fixture();
    const pair = evidencePairs(cwd, state, envelope)[pairIndex];
    const documentBefore = readFileSync(pair.documentPath);
    unlinkSync(pair.receiptPath);

    assert.throws(pair.read, { code: 'INVALID_SCOPE_EVIDENCE' }, pair.label);
    assert.deepEqual(readFileSync(pair.documentPath), documentBefore, `${pair.label} document changed`);
    assert.equal(existsSync(pair.receiptPath), false, `${pair.label} receipt was recreated`);
  }
});

test('exact classification retry repairs receipt-new document-old and rejects a foreign candidate', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'classification-recovery-task');
  const classification = classificationInput(fixture);
  const documentPath = scopeControlJournalPath(cwd, 17);
  const receiptPath = scopeControlJournalReceiptPath(cwd, 17);
  const oldDocument = readFileSync(documentPath);

  assert.throws(() => checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  writeFileSync(documentPath, oldDocument);
  const pendingReceipt = readFileSync(receiptPath);
  assert.throws(() => checkpointScopeClassification({
    cwd,
    classification: { ...classification, entryId: 'classification-foreign-retry' },
    expectedRevision: fixture.adopted.revision,
  }), { code: 'INVALID_SCOPE_EVIDENCE' });
  assert.deepEqual(readFileSync(documentPath), oldDocument);
  assert.deepEqual(readFileSync(receiptPath), pendingReceipt);

  const recovered = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  assert.equal(recovered.scopeControl.gate, 'ready');
  assert.equal(scopeStatus({ cwd }).journal.value.entries.at(-1).entryId, classification.entryId);
});

test('authority and empty-journal receipt-only initialization repairs only the exact retry', () => {
  const cwd = harness.repo();
  const initial = harness.init(cwd);
  const candidate = authority(initial.currentIntegrationHeadSha);
  assert.throws(() => checkpointScopeAuthority({
    cwd, authority: candidate, expectedRevision: initial.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  unlinkSync(scopeAuthorityPath(cwd, 17));
  unlinkSync(scopeControlJournalPath(cwd, 17));

  assert.throws(() => checkpointScopeAuthority({
    cwd,
    authority: { ...candidate, capturedAt: '2026-08-27T10:00:00.000Z' },
    expectedRevision: initial.revision,
  }), { code: 'INVALID_SCOPE_EVIDENCE' });
  assert.equal(existsSync(scopeAuthorityPath(cwd, 17)), false);
  assert.equal(existsSync(scopeControlJournalPath(cwd, 17)), false);

  const recovered = checkpointScopeAuthority({
    cwd, authority: candidate, expectedRevision: initial.revision,
  });
  assert.equal(recovered.scopeControl.gate, 'ready');
  assert.deepEqual(scopeStatus({ cwd }).journal.value.entries, []);
});

test('update retries do not adopt malformed receipts or orphaned replacement documents', () => {
  const malformedCwd = harness.repo();
  const malformed = proposedFixture(malformedCwd, 'malformed-recovery-task');
  writeFileSync(scopeControlJournalReceiptPath(malformedCwd, 17), 'not-a-digest\n');
  assert.throws(() => checkpointScopeClassification({
    cwd: malformedCwd,
    classification: classificationInput(malformed),
    expectedRevision: malformed.adopted.revision,
  }), { code: 'INVALID_SCOPE_EVIDENCE' });
  assert.equal(readFileSync(scopeControlJournalReceiptPath(malformedCwd, 17), 'utf8'), 'not-a-digest\n');

  const orphanedCwd = harness.repo();
  const orphaned = proposedFixture(orphanedCwd, 'orphaned-recovery-task');
  const receiptBefore = readFileSync(scopeControlJournalReceiptPath(orphanedCwd, 17));
  unlinkSync(scopeControlJournalPath(orphanedCwd, 17));
  assert.throws(() => checkpointScopeClassification({
    cwd: orphanedCwd,
    classification: classificationInput(orphaned),
    expectedRevision: orphaned.adopted.revision,
  }), { code: 'INVALID_DURABLE_SIDECAR' });
  assert.equal(existsSync(scopeControlJournalPath(orphanedCwd, 17)), false);
  assert.deepEqual(readFileSync(scopeControlJournalReceiptPath(orphanedCwd, 17)), receiptBefore);
});

test('decision retry repairs a receipt-only return after the journal suffix completed', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'return-recovery-task');
  const classification = classificationInput(fixture, 'human-decision-required');
  const classified = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  const decision = decisionInput(classification.rootCauseId);
  assert.throws(() => checkpointScopeDecision({
    cwd, decision, expectedRevision: classified.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  unlinkSync(scopeReturnPath(cwd, 17));
  const receiptBefore = readFileSync(scopeReturnReceiptPath(cwd, 17));

  assert.throws(() => checkpointScopeDecision({
    cwd,
    decision: { ...decision, decisionId: 'different-scope-decision' },
    expectedRevision: classified.revision,
  }), { code: 'SCOPE_EVIDENCE_CONFLICT' });
  assert.equal(existsSync(scopeReturnPath(cwd, 17)), false);
  assert.deepEqual(readFileSync(scopeReturnReceiptPath(cwd, 17)), receiptBefore);

  const recovered = checkpointScopeDecision({
    cwd, decision, expectedRevision: classified.revision,
  });
  assert.equal(recovered.scopeControl.gate, 'return-pending');
  assert.equal(readScopeReturn(cwd, recovered).digest, recovered.scopeControl.returnDigest);
  assert.throws(() => checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha,
    expectedRevision: recovered.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: fixture.packet.reviewedHeadSha, expectedRevision: recovered.revision,
  });
  assert.equal(returned.scopeControl.gate, 'returned');
});

test('resume retry repairs receipt-new document-old without weakening return identity', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'resume-recovery-task');
  const classification = classificationInput(fixture, 'human-decision-required');
  const classified = checkpointScopeClassification({
    cwd, classification, expectedRevision: fixture.adopted.revision,
  });
  const decision = decisionInput(classification.rootCauseId);
  const decided = checkpointScopeDecision({ cwd, decision, expectedRevision: classified.revision });
  const returned = checkpointScopeReturn({
    cwd, livePrHeadSha: returnedHead(fixture), expectedRevision: decided.revision,
  });
  const resume = {
    entryId: 'resume-scope-return', at: harness.AT, rootCauseId: classification.rootCauseId,
    decisionId: decision.decisionId, scopeReturnDigest: returned.scopeControl.returnDigest,
    resumedAuthorityDigest: returned.scopeControl.authorityDigest,
    resumedHeadSha: returned.currentIntegrationHeadSha,
  };
  const documentPath = scopeControlJournalPath(cwd, 17);
  const oldDocument = readFileSync(documentPath);
  assert.throws(() => checkpointScopeResume({
    cwd, resume, expectedRevision: returned.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  writeFileSync(documentPath, oldDocument);

  const recovered = checkpointScopeResume({ cwd, resume, expectedRevision: returned.revision });
  assert.equal(recovered.scopeControl.gate, 'ready');
  assert.equal(scopeStatus({ cwd }).journal.value.entries.at(-1).entryId, resume.entryId);
});

test('reclassification retains return identity and a second-root return retry replaces it exactly', () => {
  const cwd = harness.repo();
  const fixture = proposedFixture(cwd, 'second-return-recovery-task');
  const firstClassification = classificationInput(fixture, 'human-decision-required');
  const firstClassified = checkpointScopeClassification({
    cwd, classification: firstClassification, expectedRevision: fixture.adopted.revision,
  });
  const firstDecision = decisionInput(firstClassification.rootCauseId);
  const firstDecided = checkpointScopeDecision({
    cwd, decision: firstDecision, expectedRevision: firstClassified.revision,
  });
  const firstReturned = checkpointScopeReturn({
    cwd, livePrHeadSha: returnedHead(fixture), expectedRevision: firstDecided.revision,
  });
  const firstDigest = firstReturned.scopeControl.returnDigest;
  const resumed = checkpointScopeResume({
    cwd,
    expectedRevision: firstReturned.revision,
    resume: {
      entryId: 'resume-first-return', at: harness.AT,
      rootCauseId: firstClassification.rootCauseId, decisionId: firstDecision.decisionId,
      scopeReturnDigest: firstDigest,
      resumedAuthorityDigest: firstReturned.scopeControl.authorityDigest,
      resumedHeadSha: firstReturned.currentIntegrationHeadSha,
    },
  });
  const readyClassification = classificationInput(fixture, 'within-scope');
  readyClassification.entryId = 'classification-after-first-return';
  const reclassified = checkpointScopeClassification({
    cwd, classification: readyClassification, expectedRevision: resumed.revision,
  });
  assert.equal(reclassified.scopeControl.returnDigest, firstDigest);

  const secondClassification = classificationInput(fixture, 'human-decision-required');
  secondClassification.entryId = 'classification-second-return-root';
  secondClassification.rootCauseId = 'second-return-root';
  const secondClassified = checkpointScopeClassification({
    cwd, classification: secondClassification, expectedRevision: reclassified.revision,
  });
  const secondDecision = {
    ...decisionInput(secondClassification.rootCauseId),
    entryId: 'decision-second-return', blockerId: 'scope-blocker-second-return',
    decisionId: 'scope-decision-second-return', priorDecisionIds: [firstDecision.decisionId],
  };
  assert.throws(() => checkpointScopeDecision({
    cwd, decision: secondDecision, expectedRevision: secondClassified.revision, event: INVALID_EVENT,
  }), { code: 'INVALID_EVENT' });
  const recovered = checkpointScopeDecision({
    cwd, decision: secondDecision, expectedRevision: secondClassified.revision,
  });
  assert.equal(recovered.scopeControl.gate, 'return-pending');
  assert.notEqual(recovered.scopeControl.returnDigest, firstDigest);
  assert.equal(readScopeReturn(cwd, recovered).digest, recovered.scopeControl.returnDigest);
});

function returnedHead(fixture) {
  return fixture.packet.reviewedHeadSha;
}

test('scope readers preserve the 256 KiB evidence bound above active-state size', () => {
  const { cwd, state } = fixture();
  unlinkSync(scopeReturnPath(cwd, 17));
  unlinkSync(scopeReturnReceiptPath(cwd, 17));
  const large = scopeReturn(state);
  large.inventory.paths = Array.from(
    { length: 160 },
    (_, index) => `scripts/${String(index).padStart(3, '0')}-${'x'.repeat(700)}.mjs`,
  );
  const serialized = canonicalSerializedJson(large);
  assert.ok(Buffer.byteLength(serialized) > 64 * 1024);
  assert.ok(Buffer.byteLength(serialized) <= 256 * 1024);
  persistScopeReturn(cwd, state, large);
  const documentBefore = readFileSync(scopeReturnPath(cwd, 17));
  const receiptBefore = readFileSync(scopeReturnReceiptPath(cwd, 17));
  assert.equal(readScopeReturn(cwd, state).digest, scopeReturnDigest(large));
  assert.deepEqual(readFileSync(scopeReturnPath(cwd, 17)), documentBefore);
  assert.deepEqual(readFileSync(scopeReturnReceiptPath(cwd, 17)), receiptBefore);

  const oversized = { ...large, inventory: { ...large.inventory } };
  oversized.inventory.paths = Array.from(
    { length: 360 },
    (_, index) => `scripts/${String(index).padStart(3, '0')}-${'y'.repeat(800)}.mjs`,
  );
  const oversizedSerialized = canonicalSerializedJson(oversized);
  assert.ok(Buffer.byteLength(oversizedSerialized) > 256 * 1024);
  writeFileSync(scopeReturnPath(cwd, 17), oversizedSerialized);
  writeFileSync(scopeReturnReceiptPath(cwd, 17), `${scopeReturnDigest(oversized)}\n`);
  assert.throws(() => readScopeReturn(cwd, state), { code: 'INVALID_DURABLE_SIDECAR' });
  assert.throws(() => persistScopeReturn(cwd, state, oversized), { code: 'SCOPE_EVIDENCE_TOO_LARGE' });
});
