import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readGithubIssue } from '../source/github.mjs';
import { refreshSource as captureSourceRefresh } from '../source/source.mjs';
import { buildDevelopmentScopeHandoff } from '../handoff/contracts.mjs';
import { scopeAuthorityDigest } from '../../../pr-review-cycle/scripts/contracts/scope-control.mjs';

import {
  acceptPlan as acceptPlanWithScope,
  adoptScope,
  assessScope,
  acceptResult,
  activePointerPath,
  amendPlan as amendPlanWithScope,
  archiveState,
  authorizeRepeatedFinding,
  boundedStatus,
  bindTask as bindTaskWithScope,
  boundVerifierEvidence,
  buildVerifierContext,
  changeDirectory,
  checkpointGitMetadata,
  createSpecialistPlan,
  createValidationPlan as createValidationPlanWithScope,
  finalizeDevelopment,
  finalizeIntegration as finalizeIntegrationWithScope,
  initializeState,
  integrateTask,
  integratedScopeAssessmentIdentity,
  loadLatestSourceObservation,
  loadState,
  locateState,
  mergeLifecycleValidationCommands,
  nextPlanAmendmentNumber,
  nextActionFor,
  preflightVerifierCapacity,
  preflightStateVerifierCapacity,
  recoverState,
  recordDecision,
  recordFindingDisposition as recordFindingDispositionWithScope,
  recordScopeDecision,
  recordSpecialistResult,
  recordVerifierResult as recordVerifierResultWithScope,
  refreshSource,
  renderStatus,
  reconcileIntegration,
  rejectTask,
  resumeScopeReturn,
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
import {
  projectNonmaterialScopeRemediation,
  resumedPathHasCompleteTaskAuthority,
  validateNonmaterialAmendmentTaskAuthority,
} from './scope.mjs';

test('mixed minor remediation removes exact speculative work and adds only necessary authority', () => {
  const priorClosure = {
    outcome: 'Keep the bounded result.', requiredCriteria: [{ id: 'criterion', text: 'Required.' }],
    invariants: [], nonGoals: [], mandatoryConstraints: [], optionalGuidance: [],
    authorizedShape: ['unrelated-authority', 'speculative-helper'],
    unauthorizedExpansion: ['necessary-helper', 'unrelated-unauthorized'],
    deferredFollowups: [{ id: 'necessary-helper', text: 'Necessary helper.' },
      { id: 'unrelated-followup', text: 'Unrelated.' }],
  };
  const evidence = { result: {
    verdict: 'minor-amendment-required',
    coverage: [
      { mechanism: 'speculative-helper', classification: 'speculative' },
      { mechanism: 'necessary-helper', classification: 'necessary-minor-expansion' },
    ],
    unnecessaryWork: ['speculative-helper'],
    scopeDelta: { description: 'Add only the necessary helper.', sourceCriterionIds: [],
      acceptedCriterionIds: ['criterion'], invariantIds: [], materialSurfaces: [] },
    smallerSufficientAlternative: 'Remove the speculative helper.',
  } };
  const minimalClosure = { ...structuredClone(priorClosure),
    authorizedShape: ['unrelated-authority', 'necessary-helper'],
    unauthorizedExpansion: ['unrelated-unauthorized'],
    deferredFollowups: [{ id: 'unrelated-followup', text: 'Unrelated.' }] };
  const exact = projectNonmaterialScopeRemediation({ evidence, priorClosure, minimalClosure });
  assert.deepEqual(exact.errors, []);
  assert.deepEqual(exact.remediation.unnecessaryWork, ['speculative-helper']);
  assert.deepEqual(exact.remediation.necessaryMechanisms, ['necessary-helper']);
  assert.deepEqual(exact.remediation.scopeDelta, evidence.result.scopeDelta);
  assert.equal(exact.remediation.smallerSufficientAlternative, 'Remove the speculative helper.');
  const tampered = projectNonmaterialScopeRemediation({ evidence, priorClosure,
    minimalClosure: { ...minimalClosure,
      authorizedShape: ['unrelated-authority', 'speculative-helper', 'necessary-helper'] } });
  assert.ok(tampered.errors.some((error) => /exact assessed authorizedShape transformation/u.test(error)));
});

test('resumed path authority keeps same-packet validation existential across overlapping owners', () => {
  const packet = (allowedPaths, forbiddenPaths, commands) => ({
    allowedPaths, forbiddenPaths,
    requiredValidation: { unit: commands.map((command) => ({ command })), system: [] },
  });
  const terminal = [
    { packet: packet(['shared.txt'], [], ['validate-owner-a', 'validate-shared']) },
    { packet: packet(['shared.txt'], [], ['validate-owner-b']) },
    { packet: packet(['other.txt'], [], ['validate-unrelated']) },
  ];
  assert.equal(resumedPathHasCompleteTaskAuthority('shared.txt', terminal,
    ['validate-owner-a', 'validate-unrelated']), false,
  'partial owner validation plus an unrelated packet cannot be borrowed');
  assert.equal(resumedPathHasCompleteTaskAuthority('shared.txt', terminal,
    ['validate-owner-b']), true,
  'one overlapping eligible owner with its complete validation is sufficient');
  assert.equal(resumedPathHasCompleteTaskAuthority('shared.txt', [
    { packet: packet(['shared.txt'], ['shared.txt'], ['validate-owner-b']) },
  ], ['validate-owner-b']), false, 'forbidden matching ownership remains ineligible');
});

test('trim ownership transfer requires removal of the prior owner task', () => {
  const responsibility = 'Apply only the bounded trim.';
  const evidence = {
    result: { verdict: 'trim-required', unnecessaryWork: ['logical-trim'],
      smallerSufficientAlternative: responsibility,
      coverage: [{ mechanism: 'logical-trim', sourceCriterionIds: [], acceptedCriterionIds: [],
        invariantIds: [], classification: 'speculative' }] },
    packet: { changeInventory: { paths: [], mappings: [{ mechanism: 'logical-trim',
      sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [] }] } },
    cadence: { trigger: null },
  };
  const priorPlan = { criteria: [{ id: 'existing', ownerTaskId: 'existing-owner' }],
    tasks: [{ id: 'existing-owner', anticipatedPaths: ['owned/path'] }] };
  const resultingPlan = {
    criteria: [{ id: 'existing', ownerTaskId: 'replacement' },
      { id: 'remediation', description: responsibility, disposition: 'owned',
        ownerTaskId: 'replacement' }],
    tasks: [{ id: 'existing-owner', anticipatedPaths: ['owned/path'] },
      { id: 'replacement', objective: responsibility, criterionIds: ['existing', 'remediation'],
        dependsOn: [], anticipatedPaths: ['owned/path'] }],
  };
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan, resultingPlan,
    addedTaskIds: ['replacement'] }).some((error) =>
    /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error)),
  'reassignment cannot borrow paths while the prior owner task remains in the resulting plan');
});

test('citation-free discovery replacement retains only its exact assessed removal path', () => {
  const responsibility = 'Remove only the discovered path.';
  const discoveredPath = 'discovered/remove.json'; const unrelatedPath = 'discovered/keep.json';
  const row = (mechanism, acceptedCriterionIds = []) => ({ mechanism, sourceCriterionIds: [],
    acceptedCriterionIds, invariantIds: [] });
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [discoveredPath],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...row(discoveredPath), classification: 'speculative' },
      { ...row(unrelatedPath, ['unrelated']), classification: 'required' }] },
    packet: { changeInventory: { paths: [discoveredPath, unrelatedPath],
      mappings: [row(discoveredPath), row(unrelatedPath, ['unrelated'])] } },
    cadence: { trigger: 'worker-scope-discovery:discovery-owner:result:discovery' } };
  const priorPlan = { criteria: [
    { id: 'discovery', description: 'Prior discovery.', disposition: 'owned',
      ownerTaskId: 'discovery-owner', deferredReason: null },
    { id: 'unrelated', description: 'Unrelated.', disposition: 'owned',
      ownerTaskId: 'unrelated-owner', deferredReason: null }],
    tasks: [
      { id: 'discovery-owner', anticipatedPaths: ['discovered'], dependsOn: [], consumes: [] },
      { id: 'unrelated-owner', anticipatedPaths: ['other'], dependsOn: [], consumes: [] }],
    checklistMappings: [] };
  const resultFor = (path) => ({ criteria: [
    { ...priorPlan.criteria[0], ownerTaskId: 'replacement' }, priorPlan.criteria[1],
    { id: 'remediation', description: responsibility, disposition: 'owned',
      ownerTaskId: 'replacement', deferredReason: null }],
    tasks: [{ id: 'replacement', objective: responsibility,
      criterionIds: ['discovery', 'remediation'], anticipatedPaths: [path], dependsOn: [], consumes: [] },
    priorPlan.tasks[1]],
    checklistMappings: [] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: resultFor(discoveredPath), addedTaskIds: ['replacement'] }), []);
  for (const [label, changedEvidence, path] of [
    ['unrelated assessed', evidence, unrelatedPath],
    ['unassessed', evidence, 'unassessed/path.json'],
    ['missing cadence', { ...evidence, cadence: { trigger: null } }, discoveredPath],
    ['wrong replacement owner', { ...evidence,
      cadence: { trigger: 'worker-scope-discovery:unrelated-owner:result:discovery' } }, discoveredPath],
  ]) assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence: changedEvidence, priorPlan,
    resultingPlan: resultFor(path), addedTaskIds: ['replacement'] }).length > 0,
  `${label} cannot borrow exact discovery replacement authority`);
});

test('removal branches project exact grounded paths without widening citation-free authority', () => {
  const responsibility = 'Remove only the grounded mechanism.';
  const ownerTask = { id: 'owner', anticipatedPaths: ['owned'], dependsOn: [], consumes: [] };
  const priorPlan = { criteria: [{ id: 'owned', description: 'Remain bounded.', disposition: 'owned',
    ownerTaskId: 'owner', deferredReason: null }], tasks: [ownerTask], checklistMappings: [], decisions: [] };
  const row = (mechanism, authority = {}) => ({ mechanism, sourceCriterionIds: [],
    acceptedCriterionIds: [], invariantIds: [], ...authority });
  const resultingPlanFor = (path, dependsOn = [], decisionIds = []) => ({ ...structuredClone(priorPlan),
    criteria: [...priorPlan.criteria, { id: 'removal', description: responsibility,
      disposition: 'owned', ownerTaskId: 'removal-task', deferredReason: null }],
    tasks: [ownerTask, { id: 'removal-task', objective: responsibility,
      criterionIds: ['removal'], decisionIds, anticipatedPaths: [path], dependsOn, consumes: [] }] });
  for (const [label, authority] of [
    ['source', { sourceCriterionIds: ['source'] }],
    ['invariant', { invariantIds: ['invariant'] }],
  ]) {
    const mechanism = `${label}-mechanism`; const exactPath = `owned/${label}.mjs`;
    const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [mechanism],
      smallerSufficientAlternative: responsibility,
      coverage: [{ ...row(mechanism, authority), classification: 'speculative' }] },
    packet: { changeInventory: { paths: [exactPath, `owned/unrelated-${label}.mjs`], mappings: [
      row(mechanism, authority), row(exactPath, authority),
      row(`owned/unrelated-${label}.mjs`, label === 'source'
        ? { sourceCriterionIds: ['other'] } : { invariantIds: ['other'] }),
    ] } }, cadence: { trigger: null } };
    assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: resultingPlanFor(exactPath), addedTaskIds: ['removal-task'] }), [],
    `${label}-grounded removal projects its exact assessed path`);
    assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: resultingPlanFor(`owned/unrelated-${label}.mjs`),
      addedTaskIds: ['removal-task'] }).length > 0,
    `${label}-grounded removal does not project an unrelated assessed path`);
  }

  const exactPath = 'owned/decision.mjs'; const siblingPath = 'owned/decision-sibling.mjs';
  const decisionEvidence = { result: { verdict: 'trim-required', unnecessaryWork: [exactPath],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...row(exactPath, { decisionIds: ['approved-decision'] }),
      classification: 'speculative' },
    { ...row(siblingPath), classification: 'required' }] },
  packet: { changeInventory: { paths: [exactPath, siblingPath], mappings: [
    row(exactPath, { decisionIds: ['approved-decision'] }), row(siblingPath),
  ] } }, cadence: { trigger: null } };
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence: decisionEvidence, priorPlan,
    resultingPlan: resultingPlanFor(exactPath, [], ['approved-decision']),
    addedTaskIds: ['removal-task'] }), [],
  'decision-only affirmative authority is mapped rather than citation-free');
  const logicalDecision = 'decision-grounded-logical-mechanism';
  const logicalDecisionEvidence = structuredClone(decisionEvidence);
  logicalDecisionEvidence.result.unnecessaryWork = [logicalDecision];
  logicalDecisionEvidence.result.coverage = [
    { ...row(logicalDecision, { decisionIds: ['approved-decision'] }), classification: 'speculative' },
    { ...row(exactPath, { decisionIds: ['approved-decision'] }), classification: 'required' },
  ];
  logicalDecisionEvidence.packet.changeInventory.paths = [exactPath];
  logicalDecisionEvidence.packet.changeInventory.mappings = [
    row(logicalDecision, { decisionIds: ['approved-decision'] }),
    row(exactPath, { decisionIds: ['approved-decision'] }),
  ];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence: logicalDecisionEvidence,
    priorPlan, resultingPlan: resultingPlanFor(exactPath, [], ['approved-decision']),
    addedTaskIds: ['removal-task'] }), [],
  'decision-grounded logical mechanisms project their exact assessed path');
  const decisionDirectory = mkdtempSync(join(tmpdir(), 'decision-anchor-receipt '));
  const decisionReceipt = join(decisionDirectory, 'authority.json');
  writeReceiptJson(decisionReceipt, { evidence: logicalDecisionEvidence, priorPlan,
    resultingPlan: resultingPlanFor(exactPath, [], ['approved-decision']),
    addedTaskIds: ['removal-task'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(decisionReceipt, 'utf8'))), [],
  'receipt-backed decision authority preserves its logical-to-path projection');
  const citationFreeEvidence = structuredClone(decisionEvidence);
  delete citationFreeEvidence.result.coverage[0].decisionIds;
  delete citationFreeEvidence.packet.changeInventory.mappings[0].decisionIds;
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence: citationFreeEvidence, priorPlan,
    resultingPlan: resultingPlanFor(exactPath), addedTaskIds: ['removal-task'] }).length > 0,
  'omitted decisionIds remains compatible and citation-free without inventing owner authority');
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence: citationFreeEvidence, priorPlan,
    resultingPlan: resultingPlanFor(exactPath, ['owner']), addedTaskIds: ['removal-task'] }), [],
  'the exact branch-local citation-free removal path accepts its owner dependency');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence: citationFreeEvidence, priorPlan,
    resultingPlan: resultingPlanFor(siblingPath, ['owner']), addedTaskIds: ['removal-task'] }).length > 0,
  'an unrelated assessed sibling beneath the same owner cannot borrow citation-free authority');
});

test('mixed removal authority remains local to each exact mechanism', () => {
  const responsibility = 'Remove both assessed mechanisms.';
  const cited = 'owned/cited.mjs'; const citationFree = 'owned/exact.json';
  const row = (mechanism, acceptedCriterionIds = []) => ({ mechanism, sourceCriterionIds: [],
    acceptedCriterionIds, invariantIds: [] });
  const priorTask = { id: 'owner', objective: 'Own the retained area.', criterionIds: ['owned'],
    anticipatedPaths: ['owned'], dependsOn: [], produces: [], consumes: [] };
  const priorPlan = { criteria: [{ id: 'owned', description: 'Own the retained area.',
    disposition: 'owned', ownerTaskId: 'owner', deferredReason: null }], tasks: [priorTask],
  checklistMappings: [], decisions: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [cited, citationFree],
    smallerSufficientAlternative: responsibility, coverage: [
      { ...row(cited, ['owned']), classification: 'speculative' },
      { ...row(citationFree), classification: 'speculative' },
    ] }, packet: { changeInventory: { paths: [cited, citationFree], mappings: [
      row(cited, ['owned']), row(citationFree),
    ] } }, cadence: { trigger: null } };
  const plan = (paths) => ({ ...structuredClone(priorPlan), criteria: [...priorPlan.criteria,
    { id: 'remove', description: responsibility, disposition: 'owned',
      ownerTaskId: 'remediation', deferredReason: null }], tasks: [priorTask,
    { id: 'remediation', objective: responsibility, criterionIds: ['remove'],
      anticipatedPaths: paths, dependsOn: ['owner'], produces: [], consumes: [] }] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan([cited, citationFree]), addedTaskIds: ['remediation'] }), [],
  'one task may cover both mechanisms only through each mechanism-local authority');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan([cited]), addedTaskIds: ['remediation'] })
    .some((error) => /complete removal remediation branch/u.test(error)),
  'covering the cited mechanism does not silently represent its citation-free sibling');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan(['outside/cited.mjs']), addedTaskIds: ['remediation'] }).length > 0,
  'a cited mechanism cannot inherit a path from an unrelated owner');
});

test('each nonmaterial mechanism requires its own eligible anticipated-path witness', () => {
  const responsibility = 'Remove both shared-authority mechanisms.';
  const logical = ['logical-first', 'logical-second'];
  const paths = ['owned/first.mjs', 'owned/second.mjs'];
  const mapping = (mechanism) => ({ mechanism, sourceCriterionIds: ['shared-source'],
    acceptedCriterionIds: ['owned'], invariantIds: [] });
  const priorTask = { id: 'owner', objective: 'Own paths.', criterionIds: ['owned'],
    anticipatedPaths: ['owned'], dependsOn: [], produces: [], consumes: [] };
  const priorPlan = { criteria: [{ id: 'owned', description: 'Own paths.', disposition: 'owned',
    ownerTaskId: 'owner', deferredReason: null }], tasks: [priorTask], checklistMappings: [],
  decisions: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: logical,
    smallerSufficientAlternative: responsibility,
    coverage: logical.map((mechanism) => ({ ...mapping(mechanism), classification: 'speculative' })) },
  packet: { changeInventory: { paths, mappings: [...logical.map(mapping), ...paths.map(mapping)] } },
  cadence: { trigger: null } };
  const plan = (anticipatedPaths) => ({ ...structuredClone(priorPlan),
    criteria: [...priorPlan.criteria, { id: 'remove', description: responsibility,
      disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null }],
    tasks: [priorTask, { id: 'remediation', objective: responsibility, criterionIds: ['remove'],
      anticipatedPaths, dependsOn: ['owner'], produces: [], consumes: [] }] });
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan([paths[0]]), addedTaskIds: ['remediation'] })
    .some((error) => /complete removal remediation branch/u.test(error)),
  'one shared-authority path cannot represent two mechanisms');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan([paths[0], paths[0]]), addedTaskIds: ['remediation'] })
    .some((error) => /complete removal remediation branch/u.test(error)),
  'duplicating one shared-authority path cannot manufacture another witness');
  const sharedAcrossTasks = { ...structuredClone(priorPlan), criteria: [...priorPlan.criteria,
    ...['first', 'second'].map((id) => ({ id: `remove-${id}`, description: responsibility,
      disposition: 'owned', ownerTaskId: `remediation-${id}`, deferredReason: null }))],
  tasks: [priorTask, ...['first', 'second'].map((id) => ({ id: `remediation-${id}`,
    objective: responsibility, criterionIds: [`remove-${id}`], anticipatedPaths: [paths[0]],
    dependsOn: ['owner'], produces: [], consumes: [] }))] };
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: sharedAcrossTasks,
    addedTaskIds: ['remediation-first', 'remediation-second'] })
    .some((error) => /complete removal remediation branch/u.test(error)),
  'separate remediation tasks cannot reuse one exact path as two witnesses');
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan(paths), addedTaskIds: ['remediation'] }), [],
  'distinct eligible witnesses represent both shared-authority mechanisms');
  const duplicateTask = plan(paths); duplicateTask.tasks.push(structuredClone(priorTask));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: duplicateTask, addedTaskIds: ['remediation'] })
    .some((error) => /task identities must remain unique and one-to-one/u.test(error)));
  const duplicateCriterion = plan(paths);
  duplicateCriterion.criteria.push(structuredClone(priorPlan.criteria[0]));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: duplicateCriterion, addedTaskIds: ['remediation'] })
    .some((error) => /criterion identities must remain unique and one-to-one/u.test(error)));
  const duplicateNewCriterion = plan(paths);
  duplicateNewCriterion.criteria.push(structuredClone(duplicateNewCriterion.criteria.at(-1)));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: duplicateNewCriterion, addedTaskIds: ['remediation'] })
    .some((error) => /criterion identities must remain unique and one-to-one/u.test(error)));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan(paths), addedTaskIds: ['remediation', 'remediation'] })
    .some((error) => /addedTaskIds must equal the complete new task set/u.test(error)),
  'duplicate declared task identities cannot satisfy exact amendment cardinality');
  const directory = mkdtempSync(join(tmpdir(), 'mechanism-witness-receipt '));
  const receiptPath = join(directory, 'authority.json');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: plan([paths[0]]),
    addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /complete removal remediation branch/u, 'receipt-backed shared-witness reuse fails closed');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: duplicateCriterion,
    addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /criterion identities must remain unique and one-to-one/u,
  'receipt-consistent duplicate retained criterion identity fails closed');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: duplicateTask,
    addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /task identities must remain unique and one-to-one/u,
  'receipt-consistent duplicate retained task identity fails closed');
});

test('deferred-only grounding is representable while mixed grounding retains its owned carry', () => {
  const responsibility = 'Add the assessed deferred remediation.';
  const path = 'owned/deferred.mjs';
  const siblingPath = 'owned/deferred-sibling.mjs';
  const priorTask = { id: 'owner', objective: 'Own the retained path.', criterionIds: ['owned'],
    anticipatedPaths: ['owned'], dependsOn: [], produces: [], consumes: [] };
  const priorPlan = { criteria: [
    { id: 'deferred', description: 'Deferred authority.', disposition: 'deferred',
      ownerTaskId: null, deferredReason: 'Await exact implementation evidence.' },
    { id: 'owned', description: 'Owned authority.', disposition: 'owned',
      ownerTaskId: 'owner', deferredReason: null },
  ], tasks: [priorTask], checklistMappings: [], decisions: [] };
  const evidenceFor = (acceptedCriterionIds) => {
    const mapping = { mechanism: path, sourceCriterionIds: [],
      acceptedCriterionIds,
      invariantIds: [] };
    const siblingMapping = { ...mapping, mechanism: siblingPath };
    return { result: { verdict: 'minor-amendment-required', unnecessaryWork: [],
      smallerSufficientAlternative: null,
      coverage: [{ ...mapping, classification: 'necessary-minor-expansion' },
        { ...siblingMapping, classification: 'required' }],
      scopeDelta: { description: responsibility, sourceCriterionIds: [], acceptedCriterionIds,
        invariantIds: [], materialSurfaces: [] } },
    packet: { changeInventory: { paths: [path, siblingPath], mappings: [mapping, siblingMapping] } },
    cadence: { trigger: null } };
  };
  const planFor = (dependsOn, anticipatedPath = path) => ({ ...structuredClone(priorPlan),
    criteria: [...priorPlan.criteria, { id: 'remediation-criterion', description: responsibility,
      disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null }],
    tasks: [priorTask, { id: 'remediation', objective: responsibility,
      criterionIds: ['remediation-criterion'], anticipatedPaths: [anticipatedPath], dependsOn,
      produces: [], consumes: [] }] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({
    evidence: evidenceFor(['deferred']), priorPlan, resultingPlan: planFor([]),
    addedTaskIds: ['remediation'] }), [],
  'ownerless deferred grounding is represented by a new owned criterion and assessed path');
  for (const [label, rejectedPath] of [
    ['accepted-criterion sibling', siblingPath],
    ['unassessed path', 'owned/deferred-unassessed.mjs'],
  ]) assert.ok(validateNonmaterialAmendmentTaskAuthority({
    evidence: evidenceFor(['deferred']), priorPlan, resultingPlan: planFor([], rejectedPath),
    addedTaskIds: ['remediation'] }).some((error) =>
    /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error)),
  `${label} cannot borrow deferred-only path authority`);
  const deferredBorrow = planFor([]);
  deferredBorrow.tasks.at(-1).criterionIds.push('deferred');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({
    evidence: evidenceFor(['deferred']), priorPlan, resultingPlan: deferredBorrow,
    addedTaskIds: ['remediation'] })
    .some((error) => /criterionIds must equal its exact resulting owned criteria/u.test(error)),
  'deferred-only grounding cannot turn the ownerless criterion into a task reference');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({
    evidence: evidenceFor(['deferred', 'owned']), priorPlan, resultingPlan: planFor([]),
    addedTaskIds: ['remediation'] }).some((error) => /not linked to the assessed accepted criteria/u.test(error)),
  'mixed grounding cannot discard its owner-backed carry');
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({
    evidence: evidenceFor(['deferred', 'owned']), priorPlan, resultingPlan: planFor(['owner']),
    addedTaskIds: ['remediation'] }), []);
  const directory = mkdtempSync(join(tmpdir(), 'deferred-authority-receipt '));
  const receiptPath = join(directory, 'authority.json');
  writeReceiptJson(receiptPath, { evidence: evidenceFor(['deferred']), priorPlan,
    resultingPlan: planFor([]), addedTaskIds: ['remediation'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed deferred-only grounding remains representable');
  writeReceiptJson(receiptPath, { evidence: evidenceFor(['deferred']), priorPlan,
    resultingPlan: planFor([], siblingPath), addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /anticipatedPaths exceed the exact assessed or inherited responsibility/u,
  'receipt-backed accepted-criterion sibling borrowing fails closed');
  writeReceiptJson(receiptPath, { evidence: evidenceFor(['deferred']), priorPlan,
    resultingPlan: deferredBorrow, addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /criterionIds must equal its exact resulting owned criteria/u,
  'receipt-consistent deferred criterion borrowing fails closed');
});

test('minor expansion requires every exact mechanism to be represented', () => {
  const responsibility = 'Add both bounded corrections.';
  const task = (id, criterionId, path, dependency) => ({ id, objective: responsibility,
    criterionIds: [criterionId], anticipatedPaths: [path], dependsOn: [dependency],
    produces: [], consumes: [] });
  const priorPlan = { criteria: ['first', 'second'].map((id) => ({ id,
    description: `${id} authority.`, disposition: 'owned', ownerTaskId: `${id}-owner`,
    deferredReason: null })), tasks: ['first', 'second'].map((id) => ({ id: `${id}-owner`,
    objective: `${id} authority.`, criterionIds: [id], anticipatedPaths: [`${id}/owned`],
    dependsOn: [], produces: [], consumes: [] })), checklistMappings: [], decisions: [] };
  const rows = ['first', 'second'].map((id) => ({ mechanism: `${id}/correction.mjs`,
    classification: 'necessary-minor-expansion', sourceCriterionIds: ['source'],
    acceptedCriterionIds: [id], invariantIds: [] }));
  const evidence = { result: { verdict: 'minor-amendment-required', coverage: rows,
    unnecessaryWork: [], smallerSufficientAlternative: null,
    scopeDelta: { description: responsibility, sourceCriterionIds: ['source'],
      acceptedCriterionIds: ['first', 'second'], invariantIds: [], materialSurfaces: [] } },
  packet: { changeInventory: { paths: rows.map(({ mechanism }) => mechanism), mappings: rows } },
  cadence: { trigger: null } };
  const complete = structuredClone(priorPlan);
  complete.criteria.push(...['first', 'second'].map((id) => ({ id: `${id}-new`,
    description: responsibility, disposition: 'owned', ownerTaskId: `${id}-remediation`,
    deferredReason: null })));
  complete.tasks.push(task('first-remediation', 'first-new', rows[0].mechanism, 'first-owner'),
    task('second-remediation', 'second-new', rows[1].mechanism, 'second-owner'));
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: complete, addedTaskIds: ['first-remediation', 'second-remediation'] }), []);
  const omitted = structuredClone(complete);
  omitted.criteria.pop(); omitted.tasks.pop();
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: omitted, addedTaskIds: ['first-remediation'] })
    .some((error) => /complete necessary remediation branch/u.test(error)),
  'one covered minor mechanism cannot complete its disjoint sibling');
});

test('assessed and continuity replacements both preserve their exact substituted graphs', () => {
  const responsibility = 'Apply the assessed remediation.';
  const task = (id, objective, criterionIds, anticipatedPaths, dependsOn = []) => ({ id, objective,
    criterionIds, anticipatedPaths, dependsOn, produces: [], consumes: [] });
  const priorPlan = { criteria: [
    { id: 'assessed', description: 'Assessed.', disposition: 'owned',
      ownerTaskId: 'assessed-owner', deferredReason: null },
    { id: 'dependency', description: 'Dependency.', disposition: 'owned',
      ownerTaskId: 'dependency-owner', deferredReason: null },
  ], tasks: [task('assessed-owner', 'Prior assessed.', ['assessed'], ['assessed']),
    task('dependency-owner', 'Dependency.', ['dependency'], ['dependency'])],
  checklistMappings: [], decisions: [] };
  const mapping = { mechanism: 'assessed/new.mjs', sourceCriterionIds: [],
    acceptedCriterionIds: ['assessed'], invariantIds: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [mapping.mechanism],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...mapping, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [mapping.mechanism], mappings: [mapping] } },
  cadence: { trigger: null } };
  const resultingPlan = structuredClone(priorPlan);
  resultingPlan.tasks = resultingPlan.tasks.filter(({ id }) => id !== 'assessed-owner');
  resultingPlan.criteria[0].ownerTaskId = 'remediation';
  resultingPlan.criteria.push({ id: 'new-remediation', description: responsibility,
    disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null });
  resultingPlan.tasks.unshift(task('remediation', responsibility, ['assessed', 'new-remediation'],
    [mapping.mechanism], ['dependency-owner']));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan, addedTaskIds: ['remediation'] })
    .some((error) => /must preserve prior dependency edges/u.test(error)),
  'an assessed replacement cannot add an unstructured dependency edge');
  resultingPlan.tasks.find(({ id }) => id === 'remediation').dependsOn = [];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan, addedTaskIds: ['remediation'] }), []);
  const continuity = structuredClone(resultingPlan);
  continuity.tasks = continuity.tasks.filter(({ id }) => id !== 'dependency-owner');
  continuity.criteria[1].ownerTaskId = 'dependency-replacement';
  continuity.criteria.push({ ...priorPlan.criteria[1], id: 'dependency-copy',
    ownerTaskId: 'dependency-replacement' });
  continuity.tasks.push(task('dependency-replacement', 'Dependency.',
    ['dependency', 'dependency-copy'], ['dependency'], ['remediation']));
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: continuity, addedTaskIds: ['remediation', 'dependency-replacement'] })
    .some((error) => /must preserve dependency edges/u.test(error)),
  'an unrelated continuity replacement cannot change dependency edges');
});

test('assessed replacements preserve the exact substituted prior graph', () => {
  const responsibility = 'Replace both assessed owners.';
  const task = (id, criterionIds, path, dependsOn = [], produces = [], consumes = []) => ({
    id, objective: id, criterionIds, anticipatedPaths: [path], dependsOn, produces, consumes });
  const priorPlan = { criteria: ['a', 'b', 'extra'].map((id) => ({ id,
    description: `${id} authority.`, disposition: 'owned', ownerTaskId: `${id}-owner`,
    deferredReason: null })), tasks: [
      task('a-owner', ['a'], 'a', [], ['artifact']),
      task('b-owner', ['b'], 'b', ['extra-owner', 'a-owner'], [],
        [{ artifactId: 'artifact', producerTaskId: 'a-owner' }]),
      task('extra-owner', ['extra'], 'extra'),
    ], checklistMappings: [], decisions: [] };
  const rows = ['a', 'b'].map((id) => ({ mechanism: `${id}/assessed.mjs`,
    sourceCriterionIds: [], acceptedCriterionIds: [id], invariantIds: [] }));
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: rows
    .map(({ mechanism }) => mechanism), smallerSufficientAlternative: responsibility,
  coverage: rows.map((row) => ({ ...row, classification: 'speculative' })) },
  packet: { changeInventory: { paths: rows.map(({ mechanism }) => mechanism), mappings: rows } },
  cadence: { trigger: null } };
  const exact = () => ({ criteria: [
    { ...priorPlan.criteria[0], ownerTaskId: 'a-replacement' },
    { ...priorPlan.criteria[1], ownerTaskId: 'b-replacement' }, priorPlan.criteria[2],
    { id: 'a-new', description: responsibility, disposition: 'owned',
      ownerTaskId: 'a-replacement', deferredReason: null },
    { id: 'b-new', description: responsibility, disposition: 'owned',
      ownerTaskId: 'b-replacement', deferredReason: null },
  ], tasks: [{ ...task('a-replacement', ['a', 'a-new'], rows[0].mechanism, [], ['artifact']),
      objective: responsibility },
    { ...task('b-replacement', ['b', 'b-new'], rows[1].mechanism,
      ['extra-owner', 'a-replacement'], [],
      [{ artifactId: 'artifact', producerTaskId: 'a-replacement' }]), objective: responsibility },
    priorPlan.tasks[2],
  ], checklistMappings: [], decisions: [] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: exact(), addedTaskIds: ['a-replacement', 'b-replacement'] }), []);
  const extra = exact();
  extra.tasks.find(({ id }) => id === 'b-replacement').dependsOn.push('extra-owner');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: extra, addedTaskIds: ['a-replacement', 'b-replacement'] })
    .some((error) => /must preserve prior dependency edges/u.test(error)),
  'an assessed replacement cannot add or reorder retained-owner edges');
  const droppedDependency = exact();
  droppedDependency.tasks.find(({ id }) => id === 'b-replacement').dependsOn = [];
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: droppedDependency, addedTaskIds: ['a-replacement', 'b-replacement'] })
    .some((error) => /must preserve prior dependency edges/u.test(error)));
  const droppedConsume = exact();
  droppedConsume.tasks.find(({ id }) => id === 'b-replacement').consumes = [];
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: droppedConsume, addedTaskIds: ['a-replacement', 'b-replacement'] })
    .some((error) => /must preserve prior consume edges/u.test(error)));
});

test('criterionless discovery replacement is exact, unique, and cadence-bound', () => {
  const responsibility = 'Replace the criterionless discovery.';
  const path = 'discovery/exact.json';
  const mapping = { mechanism: path, sourceCriterionIds: ['source'], acceptedCriterionIds: [],
    invariantIds: [] };
  const discovery = { id: 'discovery-task', objective: 'Discover scope.', criterionIds: [],
    anticipatedPaths: ['discovery'], dependsOn: [], produces: ['discovery-artifact'], consumes: [] };
  const dependent = { id: 'dependent', objective: 'Use discovery.', criterionIds: ['dependent'],
    anticipatedPaths: ['dependent'], dependsOn: ['discovery-task'], produces: [],
    consumes: [{ artifactId: 'discovery-artifact', producerTaskId: 'discovery-task' }] };
  const priorPlan = { criteria: [{ id: 'dependent', description: 'Use discovery.',
    disposition: 'owned', ownerTaskId: 'dependent', deferredReason: null }],
  tasks: [discovery, dependent], checklistMappings: [{ id: 'check', taskIds: ['discovery-task'] }],
  decisions: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [path],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...mapping, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [path], mappings: [mapping] } },
  cadence: { trigger: 'worker-scope-discovery:discovery-task:result:criterionless' } };
  const replacement = (id) => ({ id, objective: responsibility, criterionIds: [`criterion-${id}`],
    anticipatedPaths: [path], dependsOn: [], produces: ['discovery-artifact'], consumes: [] });
  const plan = (candidateIds = ['replacement'], selected = 'replacement') => ({
    criteria: [priorPlan.criteria[0], ...candidateIds.map((id) => ({ id: `criterion-${id}`,
      description: responsibility, disposition: 'owned', ownerTaskId: id, deferredReason: null }))],
    tasks: [...candidateIds.map(replacement), { ...dependent, dependsOn: [selected],
      consumes: [{ ...dependent.consumes[0], producerTaskId: selected }] }],
    checklistMappings: [{ id: 'check', taskIds: [selected] }],
    decisions: [],
  });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: plan(), addedTaskIds: ['replacement'] }), [],
  'the unique graph- and checklist-preserving candidate replaces the criterionless discovery');
  const foreignCriterion = plan();
  foreignCriterion.tasks.find(({ id }) => id === 'replacement').criterionIds.push('dependent');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: foreignCriterion, addedTaskIds: ['replacement'] })
    .some((error) => /criterionIds must equal its exact resulting owned criteria/u.test(error)),
  'criterionless discovery replacement cannot reference a criterion retained by another task');
  const retainedDiscovery = plan();
  retainedDiscovery.tasks[0] = structuredClone(dependent);
  retainedDiscovery.tasks.unshift(structuredClone(discovery));
  retainedDiscovery.checklistMappings = structuredClone(priorPlan.checklistMappings);
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: retainedDiscovery, addedTaskIds: ['replacement'] })
    .some((error) => /must be removed and replaced exactly/u.test(error)),
  'cadence-bound criterionless discovery cannot remain beside new remediation');
  const graphSelected = plan(['replacement', 'other'], 'replacement');
  graphSelected.tasks.find(({ id }) => id === 'other').dependsOn = ['replacement'];
  graphSelected.tasks.find(({ id }) => id === 'other').produces = [];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: graphSelected, addedTaskIds: ['replacement', 'other'] }), [],
  'incoming graph and checklist substitutions select one of multiple semantic candidates');
  const graphPrior = structuredClone(priorPlan); graphPrior.checklistMappings = [];
  const graphOnly = structuredClone(graphSelected); graphOnly.checklistMappings = [];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan: graphPrior,
    resultingPlan: graphOnly, addedTaskIds: ['replacement', 'other'] }), [],
  'incoming graph substitution independently selects the unique candidate');
  const checklistPrior = structuredClone(priorPlan);
  checklistPrior.tasks[1].dependsOn = []; checklistPrior.tasks[1].consumes = [];
  const checklistOnly = structuredClone(graphSelected);
  checklistOnly.tasks.find(({ id }) => id === 'dependent').dependsOn = [];
  checklistOnly.tasks.find(({ id }) => id === 'dependent').consumes = [];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan: checklistPrior,
    resultingPlan: checklistOnly, addedTaskIds: ['replacement', 'other'] }), [],
  'checklist substitution independently selects the unique candidate');
  const noIncomingPlan = structuredClone(priorPlan);
  noIncomingPlan.tasks = [discovery]; noIncomingPlan.criteria = [];
  noIncomingPlan.checklistMappings = [];
  const ambiguousPlan = { criteria: ['first', 'second'].map((id) => ({ id: `criterion-${id}`,
    description: responsibility, disposition: 'owned', ownerTaskId: id, deferredReason: null })),
    tasks: ['first', 'second'].map(replacement), checklistMappings: [], decisions: [] };
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan: noIncomingPlan,
    resultingPlan: ambiguousPlan, addedTaskIds: ['first', 'second'] })
    .some((error) => /replacement is ambiguous/u.test(error)),
  'multiple equally exact candidates fail explicitly');
  const absent = plan();
  absent.tasks.find(({ id }) => id === 'replacement').produces = [];
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: absent, addedTaskIds: ['replacement'] })
    .some((error) => /lacks one exact replacement/u.test(error)),
  'zero exact candidates retain the normal missing-replacement rejection');
  for (const changedEvidence of [{ ...evidence, cadence: { trigger: null } },
    { ...evidence, cadence: { trigger: 'worker-scope-discovery:other-task:result:wrong' } }]) {
    assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence: changedEvidence, priorPlan,
      resultingPlan: plan(), addedTaskIds: ['replacement'] })
      .some((error) => /lacks one exact replacement/u.test(error)),
    'absent or wrong cadence cannot authorize criterionless replacement');
  }
  const unrelatedPlan = structuredClone(priorPlan);
  unrelatedPlan.tasks.push({ id: 'unrelated-ownerless', objective: 'Unrelated.', criterionIds: [],
    anticipatedPaths: ['unrelated'], dependsOn: [], produces: [], consumes: [] });
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan: unrelatedPlan,
    resultingPlan: plan(), addedTaskIds: ['replacement'] })
    .some((error) => /removed task unrelated-ownerless lacks one exact replacement/u.test(error)),
  'the fallback never absorbs an unrelated ownerless task');

  const separatePath = 'separate/exact.json';
  const separatedEvidence = structuredClone(evidence);
  const separateMapping = { ...mapping, mechanism: separatePath };
  separatedEvidence.packet.changeInventory.paths.push(separatePath);
  separatedEvidence.packet.changeInventory.mappings.push(separateMapping);
  separatedEvidence.result.coverage.push({ ...separateMapping, classification: 'speculative' });
  separatedEvidence.result.unnecessaryWork.push(separatePath);
  const ownedPrior = { ...structuredClone(priorPlan), criteria: [], tasks: [discovery],
    checklistMappings: [] };
  const ownedSelection = {
    criteria: ['replacement', 'separate-remediation'].map((id) => ({ id: `criterion-${id}`,
      description: responsibility, disposition: 'owned', ownerTaskId: id, deferredReason: null })),
    tasks: [replacement('replacement'),
      { ...replacement('separate-remediation'), anticipatedPaths: [separatePath], produces: [] }],
    checklistMappings: [], decisions: [],
  };
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence: separatedEvidence,
    priorPlan: ownedPrior, resultingPlan: ownedSelection,
    addedTaskIds: ['replacement', 'separate-remediation'] }), [],
  'prior anticipated-path ownership uniquely selects the discovery replacement');
});

test('nonmaterial amendments preserve the exact ordered prior decision array', () => {
  const responsibility = 'Remove the exact path.'; const exactPath = 'owned/exact.mjs';
  const decisions = [
    { id: 'first', question: 'First?', resolution: 'Keep first.', status: 'resolved' },
    { id: 'second', question: 'Second?', resolution: 'Keep second.', status: 'resolved' },
  ];
  const priorPlan = { criteria: [], tasks: [], checklistMappings: [], decisions };
  const exact = { criteria: [{ id: 'removal', description: responsibility, disposition: 'owned',
    ownerTaskId: 'removal-task', deferredReason: null }], tasks: [{ id: 'removal-task',
      objective: responsibility, criterionIds: ['removal'], anticipatedPaths: [exactPath],
      dependsOn: [], consumes: [] }], checklistMappings: [], decisions: structuredClone(decisions) };
  const mapping = { mechanism: exactPath, sourceCriterionIds: ['source'], acceptedCriterionIds: [],
    invariantIds: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [exactPath],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...mapping, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [exactPath], mappings: [mapping] } }, cadence: { trigger: null } };
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: exact, addedTaskIds: ['removal-task'] }), []);
  for (const [label, mutate] of [
    ['mutation', (plan) => { plan.decisions[0].resolution = 'Rewrite first.'; }],
    ['deletion', (plan) => { plan.decisions.pop(); }],
    ['addition', (plan) => { plan.decisions.push({ ...decisions[0], id: 'third' }); }],
    ['reordering', (plan) => { plan.decisions.reverse(); }],
  ]) {
    const changed = structuredClone(exact); mutate(changed);
    assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: changed, addedTaskIds: ['removal-task'] })
      .some((error) => /decisions must preserve the exact ordered prior array/u.test(error)), label);
  }
});

test('nonmaterial amendments preserve every plan-level authority field except revision', () => {
  const responsibility = 'Remove the exact path.'; const path = 'owned/exact.mjs';
  const priorPlan = { schemaVersion: 7, planRevision: 1, changeId: 'authority-fields',
    source: { type: 'direct-request', identity: 'request' }, title: 'Authority title',
    objective: 'Authority objective', scope: ['scope'], nonGoals: ['non-goal'],
    planning: { reason: 'planning authority' }, expectedPrBaseBranch: 'main',
    scenarios: ['scenario-a'], productScenarioDisposition: { status: 'not-applicable' },
    specialization: { primary: 'ops-workflow', riskTags: ['workflow'] },
    criteria: [], tasks: [], checklistMappings: [], decisions: [{ id: 'decision' }] };
  const mapping = { mechanism: path, sourceCriterionIds: ['source'], acceptedCriterionIds: [],
    invariantIds: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [path],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...mapping, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [path], mappings: [mapping] } }, cadence: { trigger: null } };
  const exact = () => ({ ...structuredClone(priorPlan), planRevision: 2,
    criteria: [{ id: 'removal', description: responsibility, disposition: 'owned',
      ownerTaskId: 'removal-task', deferredReason: null }],
    tasks: [{ id: 'removal-task', objective: responsibility, criterionIds: ['removal'],
      anticipatedPaths: [path], dependsOn: [], produces: [], consumes: [] }] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: exact(), addedTaskIds: ['removal-task'] }), []);
  for (const [field, mutate] of [
    ['schemaVersion', (plan) => { plan.schemaVersion += 1; }],
    ['changeId', (plan) => { plan.changeId = 'changed'; }],
    ['source', (plan) => { plan.source.identity = 'changed'; }],
    ['title', (plan) => { plan.title = 'Changed'; }],
    ['objective', (plan) => { plan.objective = 'Changed'; }],
    ['scope', (plan) => { plan.scope.push('changed'); }],
    ['nonGoals', (plan) => { plan.nonGoals.push('changed'); }],
    ['planning', (plan) => { plan.planning.reason = 'changed'; }],
    ['expectedPrBaseBranch', (plan) => { plan.expectedPrBaseBranch = 'release'; }],
    ['scenarios', (plan) => { plan.scenarios.push('scenario-b'); }],
    ['productScenarioDisposition', (plan) => { plan.productScenarioDisposition.status = 'changed'; }],
    ['specialization', (plan) => { plan.specialization.riskTags.push('release'); }],
    ['decisions', (plan) => { plan.decisions.push({ id: 'changed' }); }],
  ]) {
    const changed = exact(); mutate(changed);
    assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: changed, addedTaskIds: ['removal-task'] })
      .some((error) => /preserve every plan-level authority field exactly/u.test(error)),
    `${field} remains immutable`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'plan-authority-receipt '));
  const receiptPath = join(directory, 'authority.json');
  const changed = exact(); changed.source.identity = 'receipt-tamper';
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: changed,
    addedTaskIds: ['removal-task'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /preserve every plan-level authority field exactly/u,
  'receipt-backed plan authority tampering fails closed');
});

test('fresh nonreplacement remediation tasks retain only exact row-local authority', () => {
  const responsibility = 'Apply the exact row-local correction.';
  const exactPath = 'owned/exact.mjs';
  const ownerSpecialization = specialization();
  const otherSpecialization = behaviorSpecialization();
  const ownerUnsplittable = { reason: 'Keep the exact owner authority serialized.',
    serializedDomains: ['workflow'], highestRiskSpecialization: 'ops-workflow' };
  const priorPlan = {
    specialization: ownerSpecialization,
    criteria: [
      { id: 'owned', description: 'Own the exact row.', disposition: 'owned',
        ownerTaskId: 'owner', deferredReason: null },
      { id: 'other', description: 'Remain unrelated.', disposition: 'owned',
        ownerTaskId: 'other-owner', deferredReason: null },
    ],
    tasks: [
      { id: 'owner', specialization: ownerSpecialization, criterionIds: ['owned'],
        anticipatedPaths: ['owned'], dependsOn: [], produces: [], consumes: [],
        unsplittable: ownerUnsplittable },
      { id: 'other-owner', specialization: otherSpecialization, criterionIds: ['other'],
        anticipatedPaths: ['other'], dependsOn: [], produces: ['other-artifact'], consumes: [] },
    ],
    checklistMappings: [{ id: 'unrelated-check', taskIds: ['other-owner'] }],
    decisions: [{ id: 'unrelated-decision' }],
  };
  const row = { mechanism: exactPath, sourceCriterionIds: ['source'],
    acceptedCriterionIds: ['owned'], invariantIds: [] };
  const evidence = { result: { verdict: 'minor-amendment-required', unnecessaryWork: [],
    smallerSufficientAlternative: null,
    coverage: [{ ...row, classification: 'necessary-minor-expansion' }],
    scopeDelta: { description: responsibility, sourceCriterionIds: ['source'],
      acceptedCriterionIds: ['owned'], invariantIds: [], materialSurfaces: [] } },
  packet: { changeInventory: { paths: [exactPath], mappings: [row] } }, cadence: { trigger: null } };
  const exact = () => ({ ...structuredClone(priorPlan),
    criteria: [...priorPlan.criteria, { id: 'remediation-criterion', description: responsibility,
      disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null }],
    tasks: [...priorPlan.tasks, { id: 'remediation', specialization: ownerSpecialization,
      objective: responsibility, criterionIds: ['remediation-criterion'], decisionIds: [],
      checklistItemIds: [], anticipatedPaths: [exactPath], dependsOn: ['owner'],
      produces: [], consumes: [], unsplittable: ownerUnsplittable }] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: exact(), addedTaskIds: ['remediation'] }), [],
  'the exact grounded owner dependency and specialization remain valid');
  for (const [label, pattern, mutate] of [
    ['dependency', /dependencies must equal its exact row-local owner carry/u,
      (task) => { task.dependsOn.push('other-owner'); }],
    ['produced artifact', /cannot introduce artifact authority/u,
      (task) => { task.produces.push('fresh-artifact'); }],
    ['consumed artifact', /cannot introduce artifact authority/u,
      (task) => { task.dependsOn.push('other-owner'); task.consumes.push({
        artifactId: 'other-artifact', producerTaskId: 'other-owner' }); }],
    ['decision', /decisionIds exceed its exact assessed rows/u,
      (task) => { task.decisionIds.push('unrelated-decision'); }],
    ['checklist', /cannot introduce checklist authority/u,
      (task) => { task.checklistItemIds.push('unrelated-check'); }],
    ['specialization', /specialization must equal its exact row-local authority/u,
      (task) => { task.specialization = otherSpecialization; }],
    ['unsplittable', /unsplittable must equal its exact row-local owner authority/u,
      (task) => { task.unsplittable = { ...ownerUnsplittable, reason: 'Invent different authority.' }; }],
  ]) {
    const candidate = exact(); mutate(candidate.tasks.at(-1));
    const directErrors = validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: candidate, addedTaskIds: ['remediation'] });
    assert.match(directErrors.join('\n'), pattern, `${label} authority is rejected directly`);
    const directory = mkdtempSync(join(tmpdir(), `fresh-${label}-authority `));
    const receiptPath = join(directory, 'authority.json');
    writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: candidate,
      addedTaskIds: ['remediation'] });
    assert.match(validateNonmaterialAmendmentTaskAuthority(
      JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), pattern,
    `${label} authority is rejected from receipt-backed evidence`);
  }
  const reorderedRetained = exact();
  [reorderedRetained.tasks[0], reorderedRetained.tasks[1]] =
    [reorderedRetained.tasks[1], reorderedRetained.tasks[0]];
  const orderPattern = /preserve the exact prior task-order backbone through replacements/u;
  assert.match(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: reorderedRetained, addedTaskIds: ['remediation'] }).join('\n'), orderPattern,
  'reordering retained tasks around fresh remediation is rejected directly');
  const orderDirectory = mkdtempSync(join(tmpdir(), 'fresh-retained-order-authority '));
  const orderReceiptPath = join(orderDirectory, 'authority.json');
  writeReceiptJson(orderReceiptPath, { evidence, priorPlan, resultingPlan: reorderedRetained,
    addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(orderReceiptPath, 'utf8'))).join('\n'), orderPattern,
  'receipt-backed retained-task reordering fails closed');
});

test('assessed replacements retain only complete row-local metadata authority', () => {
  const responsibility = 'Replace the exact assessed owner.';
  const path = 'owned/exact.mjs';
  const ownerSpecialization = specialization();
  const foreignSpecialization = behaviorSpecialization();
  const ownerUnsplittable = { reason: 'Keep the assessed owner serialized.',
    serializedDomains: ['workflow'], highestRiskSpecialization: 'ops-workflow' };
  const priorPlan = {
    specialization: ownerSpecialization,
    criteria: [
      { id: 'owned', description: 'Own the assessed row.', disposition: 'owned',
        ownerTaskId: 'owner', deferredReason: null },
      { id: 'other', description: 'Remain unrelated.', disposition: 'owned',
        ownerTaskId: 'other-owner', deferredReason: null },
    ],
    tasks: [
      { id: 'owner', specialization: ownerSpecialization, criterionIds: ['owned'],
        decisionIds: ['allowed-decision', 'inherited-only-decision'], anticipatedPaths: ['owned'], dependsOn: [],
        produces: ['owned-artifact'], consumes: [], unsplittable: ownerUnsplittable },
      { id: 'other-owner', specialization: foreignSpecialization, criterionIds: ['other'],
        decisionIds: [], anticipatedPaths: ['other'], dependsOn: [], produces: [], consumes: [],
        unsplittable: { ...ownerUnsplittable, reason: 'Conflicting owner authority.' } },
    ],
    checklistMappings: [{ id: 'owned-check', taskIds: ['owner'] }],
    decisions: [{ id: 'allowed-decision' }, { id: 'inherited-only-decision' },
      { id: 'row-added-decision' }, { id: 'unrelated-decision' }],
  };
  const row = { mechanism: path, sourceCriterionIds: ['source'],
    acceptedCriterionIds: ['owned'], invariantIds: [], decisionIds: ['row-added-decision'] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [path],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...row, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [path], mappings: [row] } }, cadence: { trigger: null } };
  const exact = () => {
    const plan = structuredClone(priorPlan);
    plan.criteria.find(({ id }) => id === 'owned').ownerTaskId = 'replacement';
    plan.criteria.push({ id: 'replacement-criterion', description: responsibility,
      disposition: 'owned', ownerTaskId: 'replacement', deferredReason: null });
    plan.tasks[0] = { ...priorPlan.tasks[0], id: 'replacement', objective: responsibility,
      criterionIds: ['owned', 'replacement-criterion'], anticipatedPaths: [path] };
    plan.checklistMappings[0].taskIds = ['replacement'];
    return plan;
  };
  const validate = (plan, rowEvidence = evidence) => validateNonmaterialAmendmentTaskAuthority({
    evidence: rowEvidence, priorPlan, resultingPlan: plan, addedTaskIds: ['replacement'],
  });
  assert.deepEqual(validate(exact()), [], 'exact original-owner metadata remains valid');
  const directory = mkdtempSync(join(tmpdir(), 'assessed-replacement-metadata '));
  const receiptPath = join(directory, 'authority.json');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: exact(),
    addedTaskIds: ['replacement'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed exact original-owner metadata remains valid');
  const authorizedAddition = exact();
  authorizedAddition.tasks[0].decisionIds.splice(1, 0, 'row-added-decision');
  assert.deepEqual(validate(authorizedAddition), [],
  'complete matched rows may add decision authority between ordered inherited decisions');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: authorizedAddition,
    addedTaskIds: ['replacement'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed complete rows may interleave authorized additions with inherited decisions');
  for (const [label, decisionIds] of [
    ['missing', ['allowed-decision']],
    ['reordered', ['inherited-only-decision', 'allowed-decision']],
    ['duplicated', ['allowed-decision', 'inherited-only-decision', 'allowed-decision']],
  ]) {
    const candidate = exact(); candidate.tasks[0].decisionIds = decisionIds;
    const pattern = /retain complete exact ordered inherited decisionIds without duplicates/u;
    assert.match(validate(candidate).join('\n'), pattern,
      `${label} inherited decision authority is rejected directly`);
    writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: candidate,
      addedTaskIds: ['replacement'] });
    assert.match(validateNonmaterialAmendmentTaskAuthority(
      JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), pattern,
    `${label} inherited decision authority is rejected from receipt-backed evidence`);
  }
  for (const [label, pattern, mutate] of [
    ['decision', /decisionIds exceed its exact assessed rows/u,
      (task) => { task.decisionIds = [...task.decisionIds, 'unrelated-decision']; }],
    ['specialization', /specialization must equal its exact row-local authority/u,
      (task) => { task.specialization = foreignSpecialization; }],
    ['unsplittable', /unsplittable must equal its exact row-local owner authority/u,
      (task) => { task.unsplittable = { ...ownerUnsplittable, reason: 'Invent authority.' }; }],
  ]) {
    const candidate = exact(); mutate(candidate.tasks.find(({ id }) => id === 'replacement'));
    assert.match(validate(candidate).join('\n'), pattern, `${label} is rejected directly`);
    writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: candidate,
      addedTaskIds: ['replacement'] });
    assert.match(validateNonmaterialAmendmentTaskAuthority(
      JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), pattern,
    `${label} is rejected from receipt-backed evidence`);
  }
  const conflictingEvidence = structuredClone(evidence);
  conflictingEvidence.result.coverage[0].acceptedCriterionIds.push('other');
  conflictingEvidence.packet.changeInventory.mappings[0].acceptedCriterionIds.push('other');
  assert.match(validate(exact(), conflictingEvidence).join('\n'),
    /unsplittable must equal its exact row-local owner authority/u,
  'conflicting original row-local owners fail closed');
  writeReceiptJson(receiptPath, { evidence: conflictingEvidence, priorPlan,
    resultingPlan: exact(), addedTaskIds: ['replacement'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'),
  /unsplittable must equal its exact row-local owner authority/u,
  'receipt-backed conflicting original row-local owners fail closed');

  const secondPath = 'separate/second.mjs';
  const partialPath = 'other/partial.mjs';
  const necessaryMechanism = 'necessary-owner-authority';
  const necessaryRow = { mechanism: necessaryMechanism, sourceCriterionIds: ['source'],
    acceptedCriterionIds: ['owned'], invariantIds: [], decisionIds: ['allowed-decision'] };
  const exactRow = { ...necessaryRow, mechanism: path };
  const secondRow = { ...necessaryRow, mechanism: secondPath };
  const overlappingRow = { mechanism: path, sourceCriterionIds: [],
    acceptedCriterionIds: ['owned', 'other'], invariantIds: [],
    decisionIds: ['unrelated-decision'] };
  const partialRow = { ...overlappingRow, mechanism: partialPath };
  const partialEvidence = { result: { verdict: 'minor-amendment-required',
    unnecessaryWork: [path, partialPath], smallerSufficientAlternative: responsibility,
    coverage: [{ ...necessaryRow, classification: 'necessary-minor-expansion' },
      { ...overlappingRow, classification: 'speculative' },
      { ...partialRow, classification: 'speculative' }],
    scopeDelta: { description: responsibility, sourceCriterionIds: ['source'],
      acceptedCriterionIds: ['owned'], invariantIds: [], materialSurfaces: [] } },
  packet: { changeInventory: { paths: [path, secondPath, partialPath],
    mappings: [necessaryRow, exactRow, secondRow, overlappingRow, partialRow] } },
  cadence: { trigger: null } };
  const partialPriorPlan = structuredClone(priorPlan);
  const partialOther = partialPriorPlan.tasks.find(({ id }) => id === 'other-owner');
  partialOther.specialization = ownerSpecialization;
  partialOther.unsplittable = ownerUnsplittable;
  const partialPlan = () => {
    const plan = exact();
    const other = plan.tasks.find(({ id }) => id === 'other-owner');
    other.specialization = ownerSpecialization;
    other.unsplittable = ownerUnsplittable;
    plan.tasks.find(({ id }) => id === 'replacement').anticipatedPaths = [path, secondPath];
    plan.criteria.push({ id: 'partial-criterion', description: responsibility,
      disposition: 'owned', ownerTaskId: 'partial-remediation', deferredReason: null });
    plan.tasks.push({ ...partialOther, id: 'partial-remediation', objective: responsibility,
      criterionIds: ['partial-criterion'], decisionIds: [], checklistItemIds: [],
      anticipatedPaths: [path, partialPath], dependsOn: ['replacement', 'other-owner'] });
    return plan;
  };
  const validatePartial = (plan) => validateNonmaterialAmendmentTaskAuthority({
    evidence: partialEvidence, priorPlan: partialPriorPlan, resultingPlan: plan,
    addedTaskIds: ['replacement', 'partial-remediation'],
  });
  assert.deepEqual(validatePartial(partialPlan()), [],
  'separate tasks represent both complete same-responsibility branches');
  for (const placement of ['before', 'between', 'after']) {
    const candidate = partialPlan();
    const fresh = candidate.tasks.find(({ id }) => id === 'partial-remediation');
    candidate.tasks = candidate.tasks.filter(({ id }) => id !== fresh.id);
    candidate.tasks.splice(placement === 'before' ? 0 : placement === 'between' ? 1 : 2, 0, fresh);
    assert.deepEqual(validatePartial(candidate), [],
      `fresh remediation may be inserted ${placement} the accepted task backbone`);
    writeReceiptJson(receiptPath, { evidence: partialEvidence, priorPlan: partialPriorPlan,
      resultingPlan: candidate, addedTaskIds: ['replacement', 'partial-remediation'] });
    assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
      JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
    `receipt-backed fresh remediation may be inserted ${placement} the accepted task backbone`);
  }
  const reorderedBackbone = partialPlan();
  reorderedBackbone.tasks = [reorderedBackbone.tasks[1], reorderedBackbone.tasks[0],
    reorderedBackbone.tasks[2]];
  const orderPattern = /preserve the exact prior task-order backbone through replacements/u;
  assert.match(validatePartial(reorderedBackbone).join('\n'), orderPattern,
    'reordered retained and replacement tasks are rejected directly');
  writeReceiptJson(receiptPath, { evidence: partialEvidence, priorPlan: partialPriorPlan,
    resultingPlan: reorderedBackbone, addedTaskIds: ['replacement', 'partial-remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), orderPattern,
  'reordered retained and replacement tasks are rejected from receipt-backed evidence');
  const partialDecision = partialPlan();
  partialDecision.tasks.find(({ id }) => id === 'replacement').decisionIds =
    [...partialPriorPlan.tasks[0].decisionIds, 'unrelated-decision'];
  const partialDecisionPattern = /decisionIds exceed its exact assessed rows/u;
  assert.match(validatePartial(partialDecision).join('\n'), partialDecisionPattern,
    'discarded partial branch cannot grant decision authority directly');
  writeReceiptJson(receiptPath, { evidence: partialEvidence, priorPlan: partialPriorPlan,
    resultingPlan: partialDecision, addedTaskIds: ['replacement', 'partial-remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), partialDecisionPattern,
  'discarded receipt-backed partial branch cannot grant decision authority');

  const ownerlessPrior = { specialization: ownerSpecialization, criteria: [],
    tasks: [{ id: 'discovery', criterionIds: [], decisionIds: [], anticipatedPaths: ['ownerless'],
      dependsOn: [], produces: [], consumes: [], unsplittable: null }],
    checklistMappings: [], decisions: [] };
  const ownerlessPath = 'ownerless/exact.mjs';
  const ownerlessRow = { mechanism: ownerlessPath, sourceCriterionIds: [],
    acceptedCriterionIds: [], invariantIds: [], decisionIds: [] };
  const ownerlessEvidence = { result: { verdict: 'trim-required',
    unnecessaryWork: [ownerlessPath], smallerSufficientAlternative: responsibility,
    coverage: [{ ...ownerlessRow, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [ownerlessPath], mappings: [ownerlessRow] } },
  cadence: { trigger: 'worker-scope-discovery:discovery:result:ownerless' } };
  const ownerlessPlan = { ...structuredClone(ownerlessPrior),
    criteria: [{ id: 'ownerless-criterion', description: responsibility, disposition: 'owned',
      ownerTaskId: 'ownerless-replacement', deferredReason: null }],
    tasks: [{ id: 'ownerless-replacement', objective: responsibility,
      specialization: ownerSpecialization, criterionIds: ['ownerless-criterion'], decisionIds: [],
      checklistItemIds: [], anticipatedPaths: [ownerlessPath], dependsOn: [], produces: [],
      consumes: [], unsplittable: null }] };
  const ownerlessValue = { evidence: ownerlessEvidence, priorPlan: ownerlessPrior,
    resultingPlan: ownerlessPlan, addedTaskIds: ['ownerless-replacement'] };
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(ownerlessValue), [],
  'ownerless assessed replacement retains the plan specialization fallback and null unsplittable');
  const foreignOwnerless = structuredClone(ownerlessValue);
  foreignOwnerless.resultingPlan.tasks[0].specialization = foreignSpecialization;
  assert.match(validateNonmaterialAmendmentTaskAuthority(foreignOwnerless).join('\n'),
    /specialization must equal its exact row-local authority/u,
  'ownerless assessed replacement rejects specialization outside the plan fallback');
  const inventedOwnerless = structuredClone(ownerlessValue);
  inventedOwnerless.resultingPlan.tasks[0].unsplittable = ownerUnsplittable;
  assert.match(validateNonmaterialAmendmentTaskAuthority(inventedOwnerless).join('\n'),
    /unsplittable must equal its exact row-local owner authority/u,
  'ownerless assessed replacement cannot invent unsplittable authority');
});

test('fresh remediation unsplittable authority requires exact agreeing row-local owners', () => {
  const responsibility = 'Apply the exact shared correction.';
  const paths = ['first/exact.mjs', 'second/exact.mjs'];
  const witness = { reason: 'Keep the shared owner authority serialized.',
    serializedDomains: ['workflow'], highestRiskSpecialization: 'ops-workflow' };
  const owner = (id, criterionId, path, unsplittable) => ({ id, criterionIds: [criterionId],
    anticipatedPaths: [path.split('/')[0]], dependsOn: [], produces: [], consumes: [], unsplittable });
  const priorPlan = {
    criteria: paths.map((path, index) => ({ id: `owned-${index}`, description: `Own ${path}.`,
      disposition: 'owned', ownerTaskId: `owner-${index}`, deferredReason: null })),
    tasks: paths.map((path, index) => owner(`owner-${index}`, `owned-${index}`, path, witness)),
    checklistMappings: [], decisions: [],
  };
  const rows = paths.map((mechanism, index) => ({ mechanism, sourceCriterionIds: ['source'],
    acceptedCriterionIds: [`owned-${index}`], invariantIds: [] }));
  const evidence = { result: { verdict: 'minor-amendment-required', unnecessaryWork: [],
    smallerSufficientAlternative: null,
    coverage: rows.map((row) => ({ ...row, classification: 'necessary-minor-expansion' })),
    scopeDelta: { description: responsibility, sourceCriterionIds: ['source'],
      acceptedCriterionIds: ['owned-0', 'owned-1'], invariantIds: [], materialSurfaces: [] } },
  packet: { changeInventory: { paths, mappings: rows } }, cadence: { trigger: null } };
  const planFor = (unsplittable = witness) => ({ ...structuredClone(priorPlan),
    criteria: [...priorPlan.criteria, { id: 'remediation-criterion', description: responsibility,
      disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null }],
    tasks: [...priorPlan.tasks, { id: 'remediation', objective: responsibility,
      criterionIds: ['remediation-criterion'], decisionIds: [], checklistItemIds: [],
      anticipatedPaths: paths, dependsOn: ['owner-0', 'owner-1'], produces: [], consumes: [],
      unsplittable }] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: planFor(), addedTaskIds: ['remediation'] }), [],
  'deep-equal owner witnesses authorize their exact shared value');
  const directory = mkdtempSync(join(tmpdir(), 'fresh-unsplittable-owner-authority '));
  const receiptPath = join(directory, 'authority.json');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: planFor(),
    addedTaskIds: ['remediation'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed deep-equal owner witnesses authorize their exact shared value');

  const conflicting = planFor();
  conflicting.tasks.find(({ id }) => id === 'owner-1').unsplittable =
    { ...witness, reason: 'Conflicting owner authority.' };
  const pattern = /unsplittable must equal its exact row-local owner authority/u;
  assert.match(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: conflicting, addedTaskIds: ['remediation'] }).join('\n'), pattern,
  'conflicting owners fail closed instead of selecting one witness');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan: conflicting,
    addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), pattern,
  'receipt-backed conflicting owner authority fails closed');

  const ownerlessPlan = planFor(null);
  ownerlessPlan.tasks.at(-1).dependsOn = [];
  const ownerlessEvidence = structuredClone(evidence);
  ownerlessEvidence.result.coverage = ownerlessEvidence.result.coverage.map((row) =>
    ({ ...row, acceptedCriterionIds: [] }));
  ownerlessEvidence.packet.changeInventory.mappings = ownerlessEvidence.packet.changeInventory.mappings
    .map((row) => ({ ...row, acceptedCriterionIds: [] }));
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence: ownerlessEvidence,
    priorPlan, resultingPlan: ownerlessPlan, addedTaskIds: ['remediation'] }), [],
  'ownerless fresh remediation requires null authority');
  writeReceiptJson(receiptPath, { evidence: ownerlessEvidence, priorPlan,
    resultingPlan: ownerlessPlan, addedTaskIds: ['remediation'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed ownerless fresh remediation requires null authority');
  ownerlessPlan.tasks.at(-1).unsplittable = witness;
  assert.match(validateNonmaterialAmendmentTaskAuthority({ evidence: ownerlessEvidence,
    priorPlan, resultingPlan: ownerlessPlan, addedTaskIds: ['remediation'] }).join('\n'), pattern,
  'ownerless fresh remediation cannot invent unsplittable authority');
  writeReceiptJson(receiptPath, { evidence: ownerlessEvidence, priorPlan,
    resultingPlan: ownerlessPlan, addedTaskIds: ['remediation'] });
  assert.match(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))).join('\n'), pattern,
  'receipt-backed ownerless fresh remediation cannot invent unsplittable authority');
});

test('necessary-minor path anchors intersect the exact coverage row and scope delta', () => {
  const responsibility = 'Apply the exact necessary correction.';
  const exactSourcePath = 'paths/exact-source.mjs';
  const siblingSourcePath = 'paths/sibling-source.mjs';
  const exactInvariantPath = 'paths/exact-invariant.mjs';
  const siblingInvariantPath = 'paths/sibling-invariant.mjs';
  const decisionPath = 'paths/decision.mjs';
  const coverage = { mechanism: 'logical-necessary', sourceCriterionIds: ['source-exact'],
    acceptedCriterionIds: [], invariantIds: ['invariant-exact'],
    decisionIds: ['decision-anchor'], classification: 'necessary-minor-expansion' };
  const mapping = (mechanism, sourceCriterionIds = [], invariantIds = [], decisionIds = []) => ({
    mechanism, sourceCriterionIds, acceptedCriterionIds: [], invariantIds, decisionIds });
  const evidence = { result: { verdict: 'minor-amendment-required', unnecessaryWork: [],
    smallerSufficientAlternative: null, coverage: [coverage],
    scopeDelta: { description: responsibility,
      sourceCriterionIds: ['source-exact', 'source-sibling'], acceptedCriterionIds: [],
      invariantIds: ['invariant-exact', 'invariant-sibling'], materialSurfaces: [] } },
  packet: { changeInventory: { paths: [exactSourcePath, siblingSourcePath,
    exactInvariantPath, siblingInvariantPath, decisionPath], mappings: [
    mapping('logical-necessary', ['source-exact', 'source-sibling'],
      ['invariant-exact', 'invariant-sibling'], ['decision-anchor']),
    mapping(exactSourcePath, ['source-exact']), mapping(siblingSourcePath, ['source-sibling']),
    mapping(exactInvariantPath, [], ['invariant-exact']),
    mapping(siblingInvariantPath, [], ['invariant-sibling']),
    mapping(decisionPath, [], [], ['decision-anchor']),
  ] } }, cadence: { trigger: null } };
  const priorPlan = { criteria: [], tasks: [], checklistMappings: [], decisions: [] };
  const planFor = (path) => ({ criteria: [{ id: 'remediation-criterion',
    description: responsibility, disposition: 'owned', ownerTaskId: 'remediation',
    deferredReason: null }], tasks: [{ id: 'remediation', objective: responsibility,
    criterionIds: ['remediation-criterion'], decisionIds: [], checklistItemIds: [],
    anticipatedPaths: [path], dependsOn: [], produces: [], consumes: [] }],
  checklistMappings: [], decisions: [] });
  for (const path of [exactSourcePath, exactInvariantPath]) {
    assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: planFor(path), addedTaskIds: ['remediation'] }), [],
    `${path} retains the exact row-and-delta anchor`);
  }
  for (const [label, path] of [
    ['source sibling', siblingSourcePath], ['invariant sibling', siblingInvariantPath],
    ['decision-only', decisionPath],
  ]) assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: planFor(path), addedTaskIds: ['remediation'] })
    .some((error) => /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error)),
  `${label} path cannot borrow necessary-minor authority`);
});

test('same-responsibility mixed minor authority stays branch-local', () => {
  const necessary = 'Apply only the exact assessed correction.';
  const removal = necessary;
  const task = (id, objective, criterionIds, anticipatedPaths, dependsOn = []) => ({
    id, title: `Task ${id}`, objective, rationale: `${id} remains bounded.`,
    specialization: specialization(), criterionIds, decisionIds: [], scenarioIds: [],
    checklistItemIds: [], dependsOn, anticipatedPaths, produces: [], consumes: [],
    validationIntent: [`Validate ${id}.`], unsplittable: null,
  });
  const priorPlan = {
    criteria: [
      { id: 'necessary-owned', description: 'Necessary owner.', disposition: 'owned',
        ownerTaskId: 'necessary-owner', deferredReason: null },
      { id: 'removal-owned', description: 'Removal owner.', disposition: 'owned',
        ownerTaskId: 'removal-owner', deferredReason: null },
      { id: 'sibling-owned', description: 'Sibling remains independent.', disposition: 'owned',
        ownerTaskId: 'sibling-owner', deferredReason: null },
      { id: 'sibling-owned-too', description: 'Sibling retains complete ownership.', disposition: 'owned',
        ownerTaskId: 'sibling-owner', deferredReason: null },
    ],
    tasks: [
      task('necessary-owner', 'Prior necessary work.', ['necessary-owned'], ['necessary/path']),
      task('removal-owner', 'Prior removal work.', ['removal-owned'], ['removal/path']),
      task('sibling-owner', 'Preserve the sibling.', ['sibling-owned', 'sibling-owned-too'],
        ['sibling/path'], ['necessary-owner']),
    ],
    checklistMappings: [{ id: 'check', taskIds: ['necessary-owner', 'sibling-owner'] }],
  };
  priorPlan.tasks[0].produces = ['necessary-artifact'];
  priorPlan.tasks[2].consumes = [{ artifactId: 'necessary-artifact', producerTaskId: 'necessary-owner' }];
  const evidence = {
    result: {
      verdict: 'minor-amendment-required', unnecessaryWork: ['removal/path/nested.txt'],
      smallerSufficientAlternative: removal,
      scopeDelta: { description: necessary, sourceCriterionIds: ['source'],
        acceptedCriterionIds: ['necessary-owned'], invariantIds: [], materialSurfaces: [] },
      coverage: [
        { mechanism: 'necessary-check', classification: 'necessary-minor-expansion',
          sourceCriterionIds: ['source'], acceptedCriterionIds: ['necessary-owned'], invariantIds: [] },
        { mechanism: 'removal/path/nested.txt', classification: 'speculative',
          sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [] },
      ],
    },
    packet: { changeInventory: {
      paths: ['necessary/path', 'removal/path/nested.txt'],
      mappings: [
        { mechanism: 'necessary-check', sourceCriterionIds: ['source'],
          acceptedCriterionIds: ['necessary-owned'], invariantIds: [] },
        { mechanism: 'necessary/path', sourceCriterionIds: ['source'],
          acceptedCriterionIds: ['necessary-owned'], invariantIds: [] },
        { mechanism: 'removal/path/nested.txt', sourceCriterionIds: [],
          acceptedCriterionIds: [], invariantIds: [] },
      ],
    } },
    cadence: { trigger: 'worker-scope-discovery:removal-owner:result:mixed' },
  };
  const criterion = (id, description, ownerTaskId) => ({ id, description, disposition: 'owned',
    ownerTaskId, deferredReason: null });
  const exactPlan = () => {
    const plan = structuredClone(priorPlan);
    plan.criteria.push(criterion('necessary-new', necessary, 'necessary-remediation'),
      criterion('removal-new', removal, 'removal-remediation'));
    plan.tasks.push(task('necessary-remediation', necessary, ['necessary-new'], ['necessary/path'],
      ['necessary-owner']),
    task('removal-remediation', removal, ['removal-new'], ['removal/path/nested.txt'],
      ['removal-owner']));
    return plan;
  };
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: exactPlan(), addedTaskIds: ['necessary-remediation', 'removal-remediation'] }), [],
  'two disjoint mixed-minor branches are accepted');

  const onlyNecessary = exactPlan();
  onlyNecessary.criteria.pop(); onlyNecessary.tasks.pop();
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: onlyNecessary, addedTaskIds: ['necessary-remediation'] })
    .some((error) => /complete removal remediation branch/u.test(error)));

  const onlyRemoval = exactPlan();
  onlyRemoval.criteria.splice(-2, 1); onlyRemoval.tasks.splice(-2, 1);
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: onlyRemoval, addedTaskIds: ['removal-remediation'] })
    .some((error) => /complete necessary remediation branch/u.test(error)));

  const union = exactPlan();
  union.criteria = union.criteria.filter(({ id }) => id !== 'removal-new');
  union.tasks = union.tasks.filter(({ id }) => id !== 'removal-remediation');
  union.criteria.push(criterion('union-removal', removal, 'necessary-remediation'));
  union.tasks.at(-1).criterionIds.push('union-removal');
  union.tasks.at(-1).anticipatedPaths.push('removal/path/nested.txt');
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: union, addedTaskIds: ['necessary-remediation'] })
    .some((error) => /match one exact assessed branch/u.test(error)));

  const continuity = exactPlan();
  continuity.tasks = continuity.tasks.filter(({ id }) => id !== 'sibling-owner');
  continuity.criteria = continuity.criteria.map((row) => row.id === 'sibling-owned'
    || row.id === 'sibling-owned-too' ? { ...row, ownerTaskId: 'sibling-replacement' } : row);
  continuity.criteria.push(criterion('sibling-duplicate', 'Sibling remains independent.',
    'sibling-replacement'));
  continuity.tasks.push({ ...priorPlan.tasks[2], id: 'sibling-replacement',
    criterionIds: ['sibling-owned', 'sibling-owned-too', 'sibling-duplicate'] });
  continuity.checklistMappings[0].taskIds = ['necessary-owner', 'sibling-replacement'];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: continuity,
    addedTaskIds: ['necessary-remediation', 'removal-remediation', 'sibling-replacement'] }), [],
  'one exact unrelated continuity replacement remains accepted beside both remediation branches');
  const insertedDuplicate = structuredClone(continuity);
  insertedDuplicate.tasks.find(({ id }) => id === 'sibling-replacement').criterionIds =
    ['sibling-owned', 'sibling-duplicate', 'sibling-owned-too'];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: insertedDuplicate,
    addedTaskIds: ['necessary-remediation', 'removal-remediation', 'sibling-replacement'] }), [],
  'the sole continuity duplicate may be inserted without reordering the complete prior IDs');

  const substitutedGraph = structuredClone(continuity);
  substitutedGraph.tasks = substitutedGraph.tasks.filter(({ id }) => id !== 'necessary-owner');
  substitutedGraph.criteria.find(({ id }) => id === 'necessary-owned').ownerTaskId = 'necessary-remediation';
  const assessedReplacement = substitutedGraph.tasks
    .find(({ id }) => id === 'necessary-remediation');
  substitutedGraph.tasks = substitutedGraph.tasks.filter(({ id }) => id !== assessedReplacement.id);
  substitutedGraph.tasks.unshift(assessedReplacement);
  assessedReplacement.criterionIds.unshift('necessary-owned');
  assessedReplacement.dependsOn = [];
  assessedReplacement.produces = ['necessary-artifact'];
  substitutedGraph.tasks.find(({ id }) => id === 'sibling-replacement').dependsOn = ['necessary-remediation'];
  substitutedGraph.tasks.find(({ id }) => id === 'sibling-replacement').consumes[0].producerTaskId =
    'necessary-remediation';
  substitutedGraph.checklistMappings[0].taskIds = ['necessary-remediation', 'sibling-replacement'];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: substitutedGraph,
    addedTaskIds: ['necessary-remediation', 'removal-remediation', 'sibling-replacement'] }), [],
  'dependency and checklist references substitute both exact owner replacements');

  const substitutedRemovalDependency = exactPlan();
  substitutedRemovalDependency.tasks = substitutedRemovalDependency.tasks
    .filter(({ id }) => id !== 'removal-owner');
  substitutedRemovalDependency.criteria
    .find(({ id }) => id === 'removal-owned').ownerTaskId = 'removal-owner-remediation';
  substitutedRemovalDependency.criteria.push(criterion('removal-owner-new', removal,
    'removal-owner-remediation'));
  substitutedRemovalDependency.tasks.splice(1, 0, task('removal-owner-remediation', removal,
    ['removal-owned', 'removal-owner-new'], ['removal/path/nested.txt']));
  substitutedRemovalDependency.tasks
    .find(({ id }) => id === 'removal-remediation').dependsOn = ['removal-owner-remediation'];
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: substitutedRemovalDependency,
    addedTaskIds: ['necessary-remediation', 'removal-remediation', 'removal-owner-remediation'] }), [],
  'citation-free mixed removal follows a validated owner replacement dependency');

  const mutated = exactPlan();
  mutated.tasks[2].title = 'Rewrite retained sibling';
  mutated.criteria[2].description = 'Rewrite retained criterion.';
  const mutationErrors = validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: mutated, addedTaskIds: ['necessary-remediation', 'removal-remediation'] });
  assert.ok(mutationErrors.some((error) => /retained task sibling-owner must remain exact/u.test(error)));
  assert.ok(mutationErrors.some((error) => /criterion sibling-owned may change only/u.test(error)));

  const absorbed = exactPlan();
  absorbed.tasks = absorbed.tasks.filter(({ id }) => id !== 'sibling-owner');
  absorbed.criteria = absorbed.criteria.map((row) => row.id === 'sibling-owned'
    || row.id === 'sibling-owned-too' ? { ...row, ownerTaskId: 'necessary-remediation' } : row);
  absorbed.tasks.at(-2).criterionIds.push('sibling-owned', 'sibling-owned-too');
  absorbed.checklistMappings[0].taskIds = ['necessary-owner', 'necessary-remediation'];
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: absorbed, addedTaskIds: ['necessary-remediation', 'removal-remediation'] }).length > 0,
  'an unrelated removed owner cannot be absorbed into assessed remediation');

  const crossBranchTransfer = exactPlan();
  crossBranchTransfer.tasks = crossBranchTransfer.tasks.filter(({ id }) => id !== 'necessary-owner');
  crossBranchTransfer.criteria.find(({ id }) => id === 'necessary-owned').ownerTaskId = 'removal-remediation';
  const removalTask = crossBranchTransfer.tasks.find(({ id }) => id === 'removal-remediation');
  removalTask.criterionIds.unshift('necessary-owned'); removalTask.dependsOn = [];
  crossBranchTransfer.checklistMappings[0].taskIds[0] = 'removal-remediation';
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: crossBranchTransfer,
    addedTaskIds: ['necessary-remediation', 'removal-remediation'] }).length > 0,
  'a necessary owner cannot transfer its authority into the independent removal branch');

  const partial = structuredClone(continuity);
  partial.criteria.find(({ id }) => id === 'sibling-owned-too').ownerTaskId = 'sibling-owner';
  assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan: partial,
    addedTaskIds: ['necessary-remediation', 'removal-remediation', 'sibling-replacement'] }).length > 0,
  'a removed owner cannot split or partially transfer its complete criterion set');

  for (const path of ['removal/path/other.txt', 'removal', 'removal/path-sibling/file.txt']) {
    const rejectedPath = exactPlan();
    rejectedPath.tasks.at(-1).anticipatedPaths = [path];
    assert.ok(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
      resultingPlan: rejectedPath,
      addedTaskIds: ['necessary-remediation', 'removal-remediation'] }).length > 0,
    `mixed citation-free removal rejects ${path}`);
  }
});

test('same-responsibility independently complete branches may share one task', () => {
  const responsibility = 'Apply only the exact assessed correction.';
  const paths = ['first/exact.mjs', 'second/exact.mjs'];
  const priorPlan = {
    specialization: specialization(),
    criteria: paths.map((path, index) => ({ id: `owned-${index}`, description: `Own ${path}.`,
      disposition: 'owned', ownerTaskId: `owner-${index}`, deferredReason: null })),
    tasks: paths.map((path, index) => ({ id: `owner-${index}`, specialization: specialization(),
      criterionIds: [`owned-${index}`], anticipatedPaths: [path.split('/')[0]], dependsOn: [],
      produces: [], consumes: [], unsplittable: null })),
    checklistMappings: [], decisions: [],
  };
  const necessaryRows = paths.map((path, index) => ({ mechanism: `necessary-${index}`,
    sourceCriterionIds: [`source-${index}`], acceptedCriterionIds: [`owned-${index}`],
    invariantIds: [], decisionIds: [] }));
  const removalRows = paths.map((mechanism) => ({ mechanism, sourceCriterionIds: [],
    acceptedCriterionIds: [], invariantIds: [], decisionIds: [] }));
  const mappings = [...necessaryRows, ...paths.map((mechanism, index) => ({ mechanism,
    sourceCriterionIds: [`source-${index}`], acceptedCriterionIds: [`owned-${index}`],
    invariantIds: [], decisionIds: [] })), ...removalRows];
  const evidence = { result: { verdict: 'minor-amendment-required',
    unnecessaryWork: paths, smallerSufficientAlternative: responsibility,
    scopeDelta: { description: responsibility,
      sourceCriterionIds: necessaryRows.flatMap(({ sourceCriterionIds }) => sourceCriterionIds),
      acceptedCriterionIds: necessaryRows.flatMap(({ acceptedCriterionIds }) => acceptedCriterionIds),
      invariantIds: [], materialSurfaces: [] },
    coverage: [...necessaryRows.map((row) => ({ ...row,
      classification: 'necessary-minor-expansion' })),
    ...removalRows.map((row) => ({ ...row, classification: 'speculative' }))] },
  packet: { changeInventory: { paths, mappings } }, cadence: { trigger: null } };
  const resultingPlan = structuredClone(priorPlan);
  resultingPlan.criteria.push({ id: 'remediation-criterion', description: responsibility,
    disposition: 'owned', ownerTaskId: 'remediation', deferredReason: null });
  resultingPlan.tasks.push({ id: 'remediation', specialization: specialization(),
    objective: responsibility, criterionIds: ['remediation-criterion'], decisionIds: [],
    checklistItemIds: [], anticipatedPaths: paths, dependsOn: ['owner-0', 'owner-1'],
    produces: [], consumes: [], unsplittable: null });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority({ evidence, priorPlan,
    resultingPlan, addedTaskIds: ['remediation'] }), [],
  'two independently complete branches may authorize the same complete task');

  const directory = mkdtempSync(join(tmpdir(), 'complete-branch-authority '));
  const receiptPath = join(directory, 'authority.json');
  writeReceiptJson(receiptPath, { evidence, priorPlan, resultingPlan,
    addedTaskIds: ['remediation'] });
  assert.deepEqual(validateNonmaterialAmendmentTaskAuthority(
    JSON.parse(readFileSync(receiptPath, 'utf8'))), [],
  'receipt-backed independently complete branches retain their shared representation');
});

function testMinimalClosure(state, plan, overrides = {}) {
  const planDigest = digestJson(plan);
  return {
    schemaVersion: 1, changeId: state.changeId, revision: 1,
    source: { type: state.source.kind, identity: state.source.reference, digest: plan.source.captureDigest },
    planningSha: state.planningSha, planDigest, previousContractDigest: null,
    outcome: 'Exercise the smallest sufficient durable test change.',
    requiredCriteria: [{ id: plan.criteria[0].id, text: plan.criteria[0].description }],
    invariants: [{ id: 'exact-test-authority', text: 'Bind exact test evidence.' }],
    nonGoals: [{ id: 'no-test-expansion', text: 'Do not expand test authority.' }],
    mandatoryConstraints: [{ id: 'receipt-test-authority', text: 'Persist receipt evidence.' }],
    optionalGuidance: [], authorizedShape: ['durable-test-change'], unauthorizedExpansion: [],
    deferredFollowups: [], operatorDecisionDigests: [], ...overrides,
  };
}

function testScopeEvidence(state, plan, closure, { boundary = 'admission', subjectDigest = digestJson(plan),
  subjectSha = state.planningSha, taskPacketDigest = null, amendmentDigests = [], revision = state.revision + 1,
  trigger = boundary === 'task' ? 'test-task-tripwire' : null, authorityDecisions = [] } = {}) {
  const criterion = plan.criteria[0];
  const binding = { phase: boundary === 'admission' ? 'plan' : boundary,
    source: closure.source, subject: { digest: subjectDigest, sha: subjectSha },
    planDigest: digestJson(plan), amendmentDigests, taskPacketDigest,
    ...(authorityDecisions.length > 0 ? { decisionDigests: authorityDecisions.map(({ digest }) => digest) } : {}) };
  const mapping = { mechanism: 'durable-test-change', sourceCriterionIds: [criterion.id],
    acceptedCriterionIds: [criterion.id], invariantIds: [], nonGoalIds: [], guidanceIds: [],
    rationale: 'The mechanism directly implements the accepted test criterion.' };
  const packet = { schemaVersion: 1, binding,
    sourceScope: { objective: plan.objective, requiredCriteria: [...closure.requiredCriteria],
      nonGoals: [...closure.nonGoals], implementationGuidance: [...closure.optionalGuidance] },
    acceptedScope: { criteria: plan.criteria.map(({ id, description }) => ({ id, text: description })),
      invariants: [...closure.invariants, ...closure.mandatoryConstraints],
      minimalClosure: closure.outcome, authorizedShape: [...closure.authorizedShape],
      unauthorizedShape: [...closure.unauthorizedExpansion], deferredShape: closure.deferredFollowups.map(({ id }) => id),
      authorityDecisions },
    changeInventory: { summary: 'Exercise one durable test mechanism.', paths: [], dependencies: [],
      publicSurfaces: [], persistentSurfaces: [], subsystems: [], mappings: [mapping] }, tripwires: [] };
  const result = { schemaVersion: 1, binding, verdict: 'within-scope', summary: 'The test mechanism is within scope.',
    coverage: [{ ...mapping, classification: 'required', rationale: mapping.rationale }], unnecessaryWork: [],
    smallerSufficientAlternative: null, scopeDelta: null, materialityTriggers: [], smallestExpansion: null,
    narrowAlternative: null, deferralConsequences: null, missingEvidence: [], humanDecision: false };
  return { schemaVersion: 1, changeId: state.changeId, evidenceId: `${boundary}-test-${revision}`,
    revision, cadence: { boundary, trigger },
    packet, packetDigest: digestJson(packet), result, resultDigest: digestJson(result),
    closureDigest: digestJson(closure) };
}

function materialScopeEvidence(state, plan, closure, mechanisms, amendmentDigests = [], authorityDecisions = []) {
  const taskPacketDigest = digestJson({ test: 'material-decision', mechanisms });
  const evidence = testScopeEvidence(state, plan, closure, {
    boundary: 'task', subjectDigest: taskPacketDigest, subjectSha: state.git.headSha, taskPacketDigest,
    amendmentDigests, authorityDecisions,
  });
  const materialMappings = mechanisms.map((mechanism) => ({
    mechanism, sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [], nonGoalIds: [], guidanceIds: [],
    rationale: `${mechanism} is a proposed material subsystem without accepted criterion authority.`,
  }));
  evidence.packet.acceptedScope.authorizedShape = [...closure.authorizedShape];
  evidence.packet.changeInventory.subsystems = [...mechanisms];
  evidence.packet.changeInventory.mappings.push(...materialMappings);
  evidence.result = {
    ...evidence.result,
    binding: evidence.packet.binding,
    verdict: 'human-decision-required',
    summary: 'The proposed subsystems require an exact human material-scope decision.',
    coverage: [evidence.result.coverage[0], ...materialMappings.map((mapping) => ({
      ...mapping, classification: 'material-scope-change',
    }))],
    scopeDelta: { description: 'Decide the exact proposed material subsystems.', sourceCriterionIds: [],
      acceptedCriterionIds: [], invariantIds: [], materialSurfaces: ['new-subsystem'] },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'The inventory proposes new subsystems.' }],
    smallestExpansion: 'Authorize only the selected proposed subsystems.',
    narrowAlternative: 'Remove the proposed subsystems and retain existing authorized shape.',
    deferralConsequences: 'The unapproved subsystems remain outside implementation authority.',
    humanDecision: true,
  };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function workerDiscoveryMaterialScopeEvidence(state, plan, closure, packet, blocked, scopeDiscovery) {
  const taskPacketDigest = implementationTaskDigest(packet);
  const resultDigest = digestJson(blocked);
  const discoveryDigest = digestJson(scopeDiscovery);
  const subjectDigest = digestJson({ taskPacketDigest, resultDigest, discoveryDigest });
  const trigger = `worker-scope-discovery:${packet.taskId}:${resultDigest}:${discoveryDigest}`;
  const evidence = testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest, trigger });
  const mapping = {
    mechanism: 'unowned-lifecycle-path', sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [],
    nonGoalIds: [], guidanceIds: [],
    rationale: 'The worker discovered a material path outside its immutable packet.',
  };
  evidence.packet.changeInventory.paths.push('unowned/lifecycle.json');
  evidence.packet.changeInventory.subsystems.push('unowned-lifecycle-path');
  evidence.packet.changeInventory.mappings.push(mapping);
  evidence.result = {
    ...evidence.result,
    binding: evidence.packet.binding,
    verdict: 'human-decision-required',
    summary: 'The discovered lifecycle path requires an exact human material-scope decision.',
    coverage: [...evidence.result.coverage, { ...mapping, classification: 'material-scope-change' }],
    scopeDelta: { description: 'Decide whether to authorize the discovered lifecycle path.',
      sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [], materialSurfaces: ['new-subsystem'] },
    materialityTriggers: [{ category: 'new-subsystem',
      evidence: 'The discovery requests a new durable lifecycle path.' }],
    smallestExpansion: 'Authorize only the discovered lifecycle path.',
    narrowAlternative: 'Reject the blocked task and replace it without the discovered path.',
    deferralConsequences: 'The unowned lifecycle path remains outside implementation authority.',
    humanDecision: true,
  };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function workerDiscoveryNonmaterialScopeEvidence(state, plan, closure, packet, blocked, scopeDiscovery, verdict) {
  const taskPacketDigest = implementationTaskDigest(packet);
  const resultDigest = digestJson(blocked);
  const discoveryDigest = digestJson(scopeDiscovery);
  const subjectDigest = digestJson({ taskPacketDigest, resultDigest, discoveryDigest });
  const trigger = `worker-scope-discovery:${packet.taskId}:${resultDigest}:${discoveryDigest}`;
  const evidence = testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest, trigger });
  const discoveryCriterionId = plan.criteria.find(({ ownerTaskId }) => ownerTaskId === packet.taskId).id;
  const mapping = {
    mechanism: verdict === 'trim-required'
      ? scopeDiscovery.requestedAuthority.find(({ field }) => field === 'paths').values[0]
      : 'unowned-lifecycle-path',
    sourceCriterionIds: verdict === 'minor-amendment-required' ? [plan.criteria[0].id] : [],
    acceptedCriterionIds: verdict === 'minor-amendment-required' ? [discoveryCriterionId] : [],
    invariantIds: [],
    nonGoalIds: [], guidanceIds: [],
    rationale: 'The worker discovery requires an exact bounded scope disposition.',
  };
  evidence.packet.changeInventory.paths.push('unowned/lifecycle.json');
  evidence.packet.changeInventory.mappings.push(mapping);
  evidence.result = verdict === 'minor-amendment-required'
    ? { ...evidence.result, binding: evidence.packet.binding, verdict,
      summary: 'The discovery requires one bounded adjacent lifecycle path.',
      coverage: [...evidence.result.coverage, { ...mapping, classification: 'necessary-minor-expansion' }],
      scopeDelta: { description: 'Add only the discovered lifecycle path.',
        sourceCriterionIds: [plan.criteria[0].id], acceptedCriterionIds: [discoveryCriterionId],
        invariantIds: [], materialSurfaces: [] } }
    : { ...evidence.result, binding: evidence.packet.binding, verdict,
      summary: verdict === 'trim-required'
        ? 'The discovered lifecycle path is unnecessary.'
        : 'The discovery assessment lacks sufficient exact evidence.',
      coverage: verdict === 'trim-required'
        ? [...evidence.result.coverage, { ...mapping, classification: 'speculative' }]
        : evidence.packet.changeInventory.mappings.map((entry) => ({
          ...entry, classification: 'insufficient-evidence',
        })),
      unnecessaryWork: verdict === 'trim-required' ? [mapping.mechanism] : [],
      smallerSufficientAlternative: verdict === 'trim-required'
        ? 'Replace the task without the unnecessary lifecycle path.' : null,
      missingEvidence: verdict === 'insufficient-evidence'
        ? ['Exact evidence for the discovered lifecycle path is missing.'] : [] };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function planningMaterialScopeEvidence(state, plan, closure, mechanism = 'material-alpha') {
  const evidence = testScopeEvidence(state, plan, closure);
  const mapping = {
    mechanism, sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [], nonGoalIds: [], guidanceIds: [],
    rationale: `${mechanism} is a proposed material subsystem without accepted criterion authority.`,
  };
  evidence.packet.changeInventory.subsystems = [mechanism];
  evidence.packet.changeInventory.mappings.push(mapping);
  evidence.result = {
    ...evidence.result,
    binding: evidence.packet.binding,
    verdict: 'human-decision-required',
    summary: 'The proposed subsystem requires an exact human material-scope decision.',
    coverage: [evidence.result.coverage[0], { ...mapping, classification: 'material-scope-change' }],
    scopeDelta: { description: 'Decide the exact proposed material subsystem.', sourceCriterionIds: [],
      acceptedCriterionIds: [], invariantIds: [], materialSurfaces: ['new-subsystem'] },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'The inventory proposes a new subsystem.' }],
    smallestExpansion: 'Authorize only the proposed subsystem.',
    narrowAlternative: 'Remove the proposed subsystem and retain existing authority.',
    deferralConsequences: 'The subsystem remains outside implementation authority.',
    humanDecision: true,
  };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function nonAdmittingPlanningEvidence(state, plan, closure, verdict) {
  const evidence = testScopeEvidence(state, plan, closure, {
    authorityDecisions: [{ id: 'planning-material-decision', digest: state.scope.decisionDigests[0],
      disposition: 'reject-use-narrow', authorizedShape: [] }],
  });
  const mapping = evidence.result.coverage[0];
  if (verdict === 'minor-amendment-required') {
    evidence.result = { ...evidence.result, verdict,
      coverage: [{ ...mapping, classification: 'necessary-minor-expansion',
        rationale: 'The revised candidate needs one bounded adjacent mechanism.' }],
      scopeDelta: { description: 'Add one bounded adjacent mechanism.',
        sourceCriterionIds: [...mapping.sourceCriterionIds], acceptedCriterionIds: [...mapping.acceptedCriterionIds],
        invariantIds: [], materialSurfaces: [] } };
  } else if (verdict === 'trim-required') {
    evidence.result = { ...evidence.result, verdict,
      coverage: [{ ...mapping, sourceCriterionIds: [], acceptedCriterionIds: [], classification: 'speculative',
        rationale: 'The revised candidate retains unnecessary machinery.' }],
      unnecessaryWork: [mapping.mechanism], smallerSufficientAlternative: 'Remove the unnecessary machinery.' };
  } else {
    evidence.result = { ...evidence.result, verdict,
      coverage: [{ ...mapping, classification: 'insufficient-evidence',
        rationale: 'The revised candidate lacks exact evidence.' }],
      missingEvidence: ['Exact evidence for the revised candidate is missing.'] };
  }
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function materialScopeDecision(state, evidence, disposition, approvedShape, decisionId) {
  return {
    schemaVersion: 1, changeId: state.changeId, decisionId, revision: state.revision + 1, disposition,
    evidence: {
      sourceDigest: state.plan.sourceCaptureDigest, planningSha: state.planningSha,
      planDigest: state.plan.effectiveDigest, amendmentDigests: evidence.packet.binding.amendmentDigests,
      closureDigest: state.scope.closureDigest, subjectDigest: evidence.packet.binding.subject.digest,
      subjectSha: evidence.packet.binding.subject.sha, assessmentPacketDigest: evidence.packetDigest,
      assessmentResultDigest: evidence.resultDigest,
    },
    rationale: `Apply the exact ${disposition} material disposition.`, approvedShape, deferredFollowups: [],
  };
}

function materialAmendment(state, plan, priorClosure, authorizedShape, id = 'apply-material-decision',
  closureOverrides = {}) {
  const resultingPlan = structuredClone(plan); resultingPlan.planRevision = state.plan.revision + 1;
  const minimalClosure = testMinimalClosure(state, resultingPlan, {
    revision: priorClosure.revision + 1, previousContractDigest: state.scope.closureDigest,
    authorizedShape, operatorDecisionDigests: [...state.scope.decisionDigests], ...closureOverrides,
  });
  const amendment = { id, reason: 'Apply the exact recorded material disposition.', authorization: 'operator',
    trigger: state.scope.currentEvidenceDigest, delta: { changed: ['authorizedShape'] },
    invalidatedEvidence: [state.scope.currentEvidenceDigest] };
  return { amendment, resultingPlan, minimalClosure };
}

async function materialDecisionFixture(name, mechanisms = ['material-alpha', 'material-beta'], closureOverrides = {}) {
  const fixture = repository(name);
  const planning = await initializeState({ cwd: fixture.cwd, changeId: name, mode: 'implement',
    baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = planFor(planning);
  const closure = testMinimalClosure(planning, plan, {
    authorizedShape: ['durable-test-change', 'unrelated-existing-shape', ...mechanisms],
    ...closureOverrides,
  });
  const admission = testScopeEvidence(planning, plan, closure);
  admission.packet.acceptedScope.authorizedShape = [...closure.authorizedShape];
  admission.packetDigest = digestJson(admission.packet);
  let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: admission, expectedRevision: planning.revision });
  const evidence = materialScopeEvidence(state, plan, closure, mechanisms);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  return { ...fixture, state, plan, closure, evidence, mechanisms };
}

function bindTask(options) {
  try {
    return bindTaskWithScope(options);
  } catch (error) {
    if (error.code !== 'TASK_SCOPE_REQUIRED' || !options.packet?.minimalityAuthority) throw error;
  }
  let state = loadState(options.cwd, options.changeId);
  const directory = changeDirectory(options.cwd, state.changeId);
  const plan = state.plan.amendmentCount === 0
    ? JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'))
    : JSON.parse(readFileSync(join(directory, 'plan', 'amendments', `${String(state.plan.amendmentCount).padStart(4, '0')}.json`), 'utf8')).resultingPlan;
  const closure = readdirSync(join(directory, 'scope', 'minimal-closure'))
    .filter((name) => name.endsWith('.json')).map((name) =>
      JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', name), 'utf8')))
    .find((candidate) => digestJson(candidate) === state.scope.closureDigest);
  const packetDigest = implementationTaskDigest(options.packet);
  const amendmentDigests = Array.from({ length: state.plan.amendmentCount }, (_, index) => {
    const record = JSON.parse(readFileSync(join(directory, 'plan', 'amendments',
      `${String(index + 1).padStart(4, '0')}.json`), 'utf8'));
    return digestJson(record);
  });
  state = assessScope({ cwd: options.cwd, changeId: options.changeId,
    scopeEvidence: testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest: packetDigest,
      subjectSha: options.packet.taskBaseSha, taskPacketDigest: packetDigest, amendmentDigests }),
    expectedRevision: state.revision });
  return bindTaskWithScope({ ...options, expectedRevision: state.revision });
}

function acceptPlan(options) {
  if (options.minimalClosure && options.scopeEvidence) return acceptPlanWithScope(options);
  const state = loadState(options.cwd, options.changeId);
  if (!state) return acceptPlanWithScope(options);
  const minimalClosure = testMinimalClosure(state, options.plan);
  return acceptPlanWithScope({ ...options, minimalClosure,
    scopeEvidence: testScopeEvidence(state, options.plan, minimalClosure) });
}

function amendPlan(options) {
  if (options.minimalClosure) return amendPlanWithScope(options);
  const state = loadState(options.cwd, options.changeId);
  if (!state) return amendPlanWithScope(options);
  const directory = changeDirectory(options.cwd, state.changeId);
  const priorClosure = readdirSync(join(directory, 'scope', 'minimal-closure'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', name), 'utf8')))
    .find((candidate) => digestJson(candidate) === state.scope.closureDigest);
  const evidenceDirectory = state.scope.currentBoundary === null ? null
    : join(directory, 'scope', 'evidence', state.scope.currentBoundary);
  const currentEvidence = evidenceDirectory === null ? null
    : readdirSync(evidenceDirectory).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(evidenceDirectory, name), 'utf8')))
      .find((candidate) => digestJson(candidate) === state.scope.currentEvidenceDigest);
  const previous = testMinimalClosure(state, options.resultingPlan);
  const minimalClosure = { ...previous, revision: priorClosure.revision + 1,
    previousContractDigest: state.scope.closureDigest, operatorDecisionDigests: [...state.scope.decisionDigests] };
  if (currentEvidence?.result?.verdict === 'minor-amendment-required') {
    const mechanisms = currentEvidence.result.coverage
      .filter(({ classification }) => classification === 'necessary-minor-expansion')
      .map(({ mechanism }) => mechanism);
    minimalClosure.authorizedShape = [...priorClosure.authorizedShape
      .filter((mechanism) => !currentEvidence.result.unnecessaryWork.includes(mechanism)),
      ...mechanisms.filter((mechanism) => !priorClosure.authorizedShape.includes(mechanism))];
    minimalClosure.unauthorizedExpansion = priorClosure.unauthorizedExpansion
      .filter((mechanism) => !mechanisms.includes(mechanism));
    minimalClosure.deferredFollowups = priorClosure.deferredFollowups
      .filter(({ id }) => !mechanisms.includes(id));
  } else if (currentEvidence?.result?.verdict === 'trim-required') {
    minimalClosure.authorizedShape = priorClosure.authorizedShape
      .filter((mechanism) => !currentEvidence.result.unnecessaryWork.includes(mechanism));
    minimalClosure.unauthorizedExpansion = [...priorClosure.unauthorizedExpansion];
    minimalClosure.deferredFollowups = [...priorClosure.deferredFollowups];
  }
  return amendPlanWithScope({ ...options, minimalClosure });
}

function recordVerifierResult(options) {
  const context = buildVerifierContext({ cwd: options.cwd, changeId: options.changeId });
  options.result.scopeEvidenceDigest = context.integratedScopeEvidenceDigest;
  return recordVerifierResultWithScope(options);
}

function recordFindingDisposition(options) {
  if (options.disposition.sourceKind === 'verifier') {
    const state = loadState(options.cwd, options.changeId);
    const path = join(changeDirectory(options.cwd, state.changeId), 'verification', 'rounds',
      String(state.verification.round).padStart(4, '0'), 'verifier-result.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    const legacy = { ...receipt }; delete legacy.scopeEvidenceDigest;
    if (options.disposition.sourceResultDigest === digestJson(legacy)) {
      options.disposition.sourceResultDigest = digestJson(receipt);
    }
  }
  return recordFindingDispositionWithScope(options);
}

function integratedScopeEvidenceFor(options) {
  let state = loadState(options.cwd, options.changeId);
  if (state.phase === 'integrated') {
    const directory = changeDirectory(options.cwd, state.changeId);
    const plan = state.plan.amendmentCount === 0
      ? JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'))
      : JSON.parse(readFileSync(join(directory, 'plan', 'amendments', `${String(state.plan.amendmentCount).padStart(4, '0')}.json`), 'utf8')).resultingPlan;
    const closureFiles = readdirSync(join(directory, 'scope', 'minimal-closure')).filter((name) => name.endsWith('.json')).sort();
    const closure = JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', closureFiles.at(-1)), 'utf8'));
    const authorityDecisions = state.scope.decisionDigests.map((digest) => {
      const decision = readdirSync(join(directory, 'scope', 'decisions'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(directory, 'scope', 'decisions', name), 'utf8')))
        .find((candidate) => digestJson(candidate) === digest);
      return { id: decision.decisionId, digest, disposition: decision.disposition,
        authorizedShape: [...decision.approvedShape] };
    });
    const identity = integratedScopeAssessmentIdentity({ cwd: options.cwd, changeId: options.changeId });
    return testScopeEvidence(state, plan, closure, { boundary: 'integrated-head',
      amendmentDigests: identity.amendmentDigests, subjectDigest: identity.subjectDigest,
      subjectSha: identity.subjectSha, taskPacketDigest: identity.taskPacketDigest, authorityDecisions });
  }
  return null;
}

function materialIntegratedScopeEvidence(options, mechanism = 'material-integrated-recovery') {
  const evidence = integratedScopeEvidenceFor(options);
  const mapping = {
    mechanism, sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [], nonGoalIds: [], guidanceIds: [],
    rationale: `${mechanism} is a proposed material subsystem without accepted criterion authority.`,
  };
  evidence.packet.changeInventory.subsystems = [mechanism];
  evidence.packet.changeInventory.mappings.push(mapping);
  evidence.result = {
    ...evidence.result,
    binding: evidence.packet.binding,
    verdict: 'human-decision-required',
    summary: 'The integrated candidate requires an exact human material-scope decision.',
    coverage: [...evidence.result.coverage, { ...mapping, classification: 'material-scope-change' }],
    scopeDelta: { description: 'Decide the exact integrated material subsystem.', sourceCriterionIds: [],
      acceptedCriterionIds: [], invariantIds: [], materialSurfaces: ['new-subsystem'] },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'The integrated inventory proposes a new subsystem.' }],
    smallestExpansion: 'Authorize only the proposed integrated subsystem.',
    narrowAlternative: 'Remove the proposed subsystem and retain existing authority.',
    deferralConsequences: 'The subsystem remains outside implementation authority.',
    humanDecision: true,
  };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  return evidence;
}

function finalizeIntegration(options) {
  let state = finalizeIntegrationWithScope(options);
  const scopeEvidence = integratedScopeEvidenceFor(options, state);
  state = assessScope({ cwd: options.cwd, changeId: options.changeId, scopeEvidence,
    expectedRevision: state.revision });
  return state;
}

function createValidationPlan(options) {
  return createValidationPlanWithScope(options);
}

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

test('plan admission rejects every contradictory scope semantic projection without durable mutation', async () => {
  const fixture = repository('semantic plan admission');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'semantic-plan-admission', mode: 'implement',
    baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = planFor(planning);
  const closure = testMinimalClosure(planning, plan, {
    optionalGuidance: [{ id: 'keep-local', text: 'Keep the implementation local.' }],
    unauthorizedExpansion: ['repository-wide-framework'],
    deferredFollowups: [{ id: 'later-delivery', text: 'Deliver through the later workflow.' }],
  });
  const exact = testScopeEvidence(planning, plan, closure);
  const mutations = [
    (packet) => { packet.sourceScope.objective = 'Contradict the accepted objective.'; },
    (packet) => { packet.sourceScope.requiredCriteria[0].text = 'Rewrite the source requirement.'; },
    (packet) => { packet.sourceScope.nonGoals[0].text = 'Rewrite the non-goal.'; },
    (packet) => { packet.sourceScope.implementationGuidance[0].text = 'Rewrite optional guidance.'; },
    (packet) => { packet.acceptedScope.criteria[0].text = 'Rewrite the effective-plan criterion.'; },
    (packet) => { packet.acceptedScope.invariants[0].text = 'Rewrite an invariant.'; },
    (packet) => { packet.acceptedScope.invariants[1].text = 'Rewrite a mandatory constraint.'; },
    (packet) => { packet.acceptedScope.minimalClosure = 'Replace the closure outcome.'; },
    (packet) => { packet.acceptedScope.authorizedShape = ['different-mechanism']; },
    (packet) => { packet.acceptedScope.unauthorizedShape = ['different-expansion']; },
    (packet) => { packet.acceptedScope.deferredShape = ['different-follow-up']; },
  ];
  const directory = changeDirectory(fixture.cwd, planning.changeId);
  const before = durableSnapshot(directory);
  const foreignClosure = { ...closure, operatorDecisionDigests: [`sha256:${'f'.repeat(64)}`] };
  assert.throws(() => acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: foreignClosure,
    scopeEvidence: testScopeEvidence(planning, plan, foreignClosure), expectedRevision: planning.revision }),
  (error) => error.code === 'PLAN_SCOPE_INVALID'
    && /exact ordered durable scope decision digests/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), before,
    'admission rejects foreign closure decision authority without durable mutation');
  const injectedAuthority = structuredClone(exact);
  const injectedDigest = `sha256:${'e'.repeat(64)}`;
  injectedAuthority.packet.binding.decisionDigests = [injectedDigest];
  injectedAuthority.packet.acceptedScope.authorityDecisions = [{
    id: 'injected-admission-authority', digest: injectedDigest,
    disposition: 'approve-material-amendment', authorizedShape: ['injected-shape'],
  }];
  injectedAuthority.result.binding = structuredClone(injectedAuthority.packet.binding);
  injectedAuthority.packetDigest = digestJson(injectedAuthority.packet);
  injectedAuthority.resultDigest = digestJson(injectedAuthority.result);
  assert.throws(() => acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: injectedAuthority, expectedRevision: planning.revision }),
  (error) => error.code === 'PLAN_SCOPE_INVALID'
    && /exact effective-plan and minimal-closure projection/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), before,
    'admission rejects injected authority against the exact empty decision projection atomically');
  for (const mutate of mutations) {
    const contradictory = structuredClone(exact);
    mutate(contradictory.packet);
    contradictory.packetDigest = digestJson(contradictory.packet);
    assert.throws(() => acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
      scopeEvidence: contradictory, expectedRevision: planning.revision }),
    (error) => error.code === 'PLAN_SCOPE_INVALID' && /projection/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before, 'semantic mismatch writes no durable bytes');
  }
  const accepted = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: exact, expectedRevision: planning.revision });
  assert.equal(accepted.phase, 'ready-to-implement');
});

test('later scope boundaries revalidate canonical semantic projections atomically', async () => {
  const taskFixture = repository('semantic task assessment');
  const planning = await initializeState({ cwd: taskFixture.cwd, changeId: 'semantic-task-assessment',
    mode: 'implement', baseBranch: 'main', planningRef: taskFixture.sha, source: descriptor });
  const plan = planFor(planning);
  const closure = testMinimalClosure(planning, plan);
  let state = acceptPlanWithScope({ cwd: taskFixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  const packetDigest = implementationTaskDigest(packet);
  const taskEvidence = testScopeEvidence(state, plan, closure, { boundary: 'task',
    subjectDigest: packetDigest, subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest });
  const taskDirectory = changeDirectory(taskFixture.cwd, state.changeId);
  const taskBefore = durableSnapshot(taskDirectory);
  for (const mutate of [
    (candidate) => { candidate.packet.sourceScope.objective = 'Invent a different task-boundary objective.'; },
    (candidate) => { candidate.packet.acceptedScope.criteria[0].text = 'Invent different task authority.'; },
  ]) {
    const contradictory = structuredClone(taskEvidence);
    mutate(contradictory);
    contradictory.packetDigest = digestJson(contradictory.packet);
    assert.throws(() => assessScope({ cwd: taskFixture.cwd, changeId: state.changeId,
      scopeEvidence: contradictory, expectedRevision: state.revision }),
    (error) => error.code === 'SCOPE_ASSESSMENT_INVALID' && /projection/u.test(error.message));
    assert.deepEqual(durableSnapshot(taskDirectory), taskBefore,
      'task-boundary semantic rejection leaves every durable byte unchanged');
  }
  state = assessScope({ cwd: taskFixture.cwd, changeId: state.changeId,
    scopeEvidence: taskEvidence, expectedRevision: state.revision });
  assert.equal(state.scope.currentBoundary, 'task');

  const integrated = await integratedSingleTaskFixture('semantic integrated assessment');
  const integratedDirectory = changeDirectory(integrated.cwd, integrated.state.changeId);
  const integratedEvidence = integratedScopeEvidenceFor({ cwd: integrated.cwd,
    changeId: integrated.state.changeId });
  const integratedBefore = durableSnapshot(integratedDirectory);
  for (const mutate of [
    (candidate) => { candidate.packet.sourceScope.objective = 'Invent a different integrated objective.'; },
    (candidate) => { candidate.packet.acceptedScope.criteria[0].text = 'Invent different integrated authority.'; },
  ]) {
    const contradictory = structuredClone(integratedEvidence);
    mutate(contradictory);
    contradictory.packetDigest = digestJson(contradictory.packet);
    assert.throws(() => assessScope({ cwd: integrated.cwd, changeId: integrated.state.changeId,
      scopeEvidence: contradictory, expectedRevision: integrated.state.revision }),
    (error) => error.code === 'SCOPE_ASSESSMENT_INVALID' && /projection/u.test(error.message));
    assert.deepEqual(durableSnapshot(integratedDirectory), integratedBefore,
      'integrated-head semantic rejection leaves every durable byte unchanged');
  }
  state = assessScope({ cwd: integrated.cwd, changeId: integrated.state.changeId,
    scopeEvidence: integratedEvidence, expectedRevision: integrated.state.revision });
  assert.equal(state.scope.currentBoundary, 'integrated-head');
});

test('integrated-head insufficient evidence admits only an exact blocked reassessment', async () => {
  const fixture = await integratedSingleTaskFixture('integrated insufficient evidence reassessment');
  const directory = changeDirectory(fixture.cwd, fixture.state.changeId);
  const withinScope = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: fixture.state.changeId });
  const insufficient = structuredClone(withinScope);
  const mapping = insufficient.result.coverage[0];
  insufficient.result = {
    ...insufficient.result,
    verdict: 'insufficient-evidence',
    coverage: [{ ...mapping, classification: 'insufficient-evidence',
      rationale: 'The integrated candidate needs exact supporting evidence.' }],
    missingEvidence: ['Exact integrated-head evidence is missing.'],
  };
  insufficient.resultDigest = digestJson(insufficient.result);
  let state = assessScope({ cwd: fixture.cwd, changeId: fixture.state.changeId,
    scopeEvidence: insufficient, expectedRevision: fixture.state.revision });
  const insufficientDigest = digestJson(insufficient);
  assert.equal(state.phase, 'blocked');
  assert.equal(state.scope.status, 'assessment-required');
  assert.equal(state.scope.currentBoundary, 'integrated-head');
  assert.equal(state.scope.currentSubjectSha, state.git.headSha);
  assert.equal(state.scope.currentEvidenceDigest, insufficientDigest);
  assert.deepEqual(state.blockedReasons,
    ['Scope assessment has insufficient evidence; authority remains unchanged.']);

  const corrected = structuredClone(withinScope);
  corrected.revision = state.revision + 1;
  corrected.evidenceId = `integrated-head-test-${corrected.revision}`;
  const staleSubject = structuredClone(corrected);
  staleSubject.packet.binding.subject.sha = 'f'.repeat(40);
  staleSubject.result.binding.subject.sha = 'f'.repeat(40);
  staleSubject.packetDigest = digestJson(staleSubject.packet);
  staleSubject.resultDigest = digestJson(staleSubject.result);
  const beforeStale = durableSnapshot(directory);
  assert.throws(() => assessScope({ cwd: fixture.cwd, changeId: state.changeId,
    scopeEvidence: staleSubject, expectedRevision: state.revision }),
  (error) => error.code === 'SCOPE_ASSESSMENT_INVALID');
  assert.deepEqual(durableSnapshot(directory), beforeStale,
    'a stale retry subject writes no evidence, receipt, event, transition, or state');

  const changedSubject = structuredClone(corrected);
  changedSubject.packet.binding.subject.digest = digestJson({ changed: true });
  changedSubject.result.binding.subject.digest = changedSubject.packet.binding.subject.digest;
  changedSubject.packetDigest = digestJson(changedSubject.packet);
  changedSubject.resultDigest = digestJson(changedSubject.result);
  assert.throws(() => assessScope({ cwd: fixture.cwd, changeId: state.changeId,
    scopeEvidence: changedSubject, expectedRevision: state.revision }),
  (error) => error.code === 'SCOPE_ASSESSMENT_INVALID');
  assert.deepEqual(durableSnapshot(directory), beforeStale,
    'a changed retry subject writes no evidence, receipt, event, transition, or state');

  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId,
    scopeEvidence: corrected, expectedRevision: state.revision });
  assert.equal(state.phase, 'integrated');
  assert.equal(state.scope.status, 'current');
  assert.equal(state.scope.currentEvidenceDigest, digestJson(corrected));
  assert.deepEqual(state.blockedReasons, []);
  assert.match(state.nextAction, /validation-plan/u);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
  assert.equal(existsSync(join(directory, 'scope', 'evidence', 'integrated-head',
    `${String(insufficient.revision).padStart(8, '0')}-${insufficient.evidenceId}.json`)), true,
  'the prior insufficient-evidence receipt remains preserved');

  const trimFixture = await integratedSingleTaskFixture('integrated trim retry remains blocked');
  const trimWithinScope = integratedScopeEvidenceFor({
    cwd: trimFixture.cwd, changeId: trimFixture.state.changeId,
  });
  const trim = structuredClone(trimWithinScope);
  trim.result = {
    ...trim.result,
    verdict: 'trim-required',
    coverage: [{ ...trim.result.coverage[0], sourceCriterionIds: [], acceptedCriterionIds: [],
      classification: 'speculative', rationale: 'The mechanism is unnecessary.' }],
    unnecessaryWork: [trim.result.coverage[0].mechanism],
    smallerSufficientAlternative: 'Remove the unnecessary mechanism.',
  };
  trim.resultDigest = digestJson(trim.result);
  const trimState = assessScope({ cwd: trimFixture.cwd, changeId: trimFixture.state.changeId,
    scopeEvidence: trim, expectedRevision: trimFixture.state.revision });
  const invalidTrimRetry = structuredClone(trimWithinScope);
  invalidTrimRetry.revision = trimState.revision + 1;
  invalidTrimRetry.evidenceId = `integrated-head-test-${invalidTrimRetry.revision}`;
  assert.throws(() => assessScope({ cwd: trimFixture.cwd, changeId: trimState.changeId,
    scopeEvidence: invalidTrimRetry, expectedRevision: trimState.revision }),
  (error) => error.code === 'INVALID_PHASE');
});

test('new bindings require minimality authority atomically while historical packet shapes remain readable', async () => {
  const fixture = repository('mandatory task minimality');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'mandatory-task-minimality', mode: 'implement',
    baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = planFor(planning);
  const state = acceptPlan({ cwd: fixture.cwd, plan, expectedRevision: planning.revision });
  const historicalPacket = packetFor(state, plan, 'state-task');
  delete historicalPacket.minimalityAuthority;
  assert.deepEqual(validateImplementationTask(historicalPacket), [],
    'the additive contract keeps historical packet documents structurally readable');
  assert.equal(implementationTaskDigest(historicalPacket), implementationTaskDigest(structuredClone(historicalPacket)),
    'historical packets retain deterministic canonical identities');
  const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => bindTaskWithScope({ cwd: fixture.cwd, packet: historicalPacket, expectedRevision: state.revision }),
    (error) => error.code === 'TASK_SCOPE_REQUIRED');
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
    'missing minimality authority writes no state, event, transition, receipt, or task sidecar bytes');
});

test('task scope cadence binds unchanged observations directly and gates exact changed tripwire IDs atomically', async () => {
  const unchanged = repository('conditional task scope unchanged');
  const unchangedPlanning = await initializeState({ cwd: unchanged.cwd, changeId: 'conditional-task-unchanged',
    mode: 'implement', baseBranch: 'main', planningRef: unchanged.sha, source: descriptor });
  const unchangedPlan = planFor(unchangedPlanning);
  const unchangedState = acceptPlan({ cwd: unchanged.cwd, plan: unchangedPlan,
    expectedRevision: unchangedPlanning.revision });
  const unchangedPacket = packetFor(unchangedState, unchangedPlan, 'state-task');
  const admissionDigest = unchangedState.scope.currentEvidenceDigest;
  const directlyBound = bindTaskWithScope({ cwd: unchanged.cwd, packet: unchangedPacket,
    expectedRevision: unchangedState.revision });
  assert.equal(directlyBound.execution.tasks[0].status, 'bound');
  assert.match(directlyBound.nextAction, /Bind or schedule/u);
  assert.match(directlyBound.nextAction, /only if binding reports exact changed tripwire IDs/u);
  assert.equal(directlyBound.scope.currentBoundary, 'admission');
  assert.equal(directlyBound.scope.currentEvidenceDigest, admissionDigest,
    'non-triggering binding leaves the existing scope evidence untouched');

  const changed = repository('conditional task scope changed');
  const changedPlanning = await initializeState({ cwd: changed.cwd, changeId: 'conditional-task-changed',
    mode: 'implement', baseBranch: 'main', planningRef: changed.sha, source: descriptor });
  const changedPlan = planFor(changedPlanning);
  let state = acceptPlan({ cwd: changed.cwd, plan: changedPlan, expectedRevision: changedPlanning.revision });
  const packet = packetFor(state, changedPlan, 'state-task');
  packet.minimalityAuthority.tripwires[0].observedInventory = ['changed-path'];
  const directory = changeDirectory(changed.cwd, state.changeId);
  const before = durableSnapshot(directory);
  assert.throws(() => bindTaskWithScope({ cwd: changed.cwd, packet, expectedRevision: state.revision }),
    (error) => error.code === 'TASK_SCOPE_REQUIRED');
  assert.deepEqual(durableSnapshot(directory), before, 'a changed observation fails without partial evidence');
  const packetDigest = implementationTaskDigest(packet);
  const closure = testMinimalClosure(state, changedPlan);
  const incorrect = testScopeEvidence(state, changedPlan, closure, { boundary: 'task',
    subjectDigest: packetDigest, subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest,
    trigger: 'task-tripwires:wrong-id' });
  state = assessScope({ cwd: changed.cwd, changeId: state.changeId, scopeEvidence: incorrect,
    expectedRevision: state.revision });
  assert.throws(() => bindTaskWithScope({ cwd: changed.cwd, packet, expectedRevision: state.revision }),
    (error) => error.code === 'TASK_SCOPE_REQUIRED');
  const exact = testScopeEvidence(state, changedPlan, closure, { boundary: 'task', subjectDigest: packetDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest,
    trigger: 'task-tripwires:test-task-paths' });
  state = assessScope({ cwd: changed.cwd, changeId: state.changeId, scopeEvidence: exact,
    expectedRevision: state.revision });
  state = bindTaskWithScope({ cwd: changed.cwd, packet, expectedRevision: state.revision });
  assert.equal(state.execution.tasks[0].status, 'bound');

  const missing = repository('conditional task scope missing observation');
  const missingPlanning = await initializeState({ cwd: missing.cwd, changeId: 'conditional-task-missing',
    mode: 'implement', baseBranch: 'main', planningRef: missing.sha, source: descriptor });
  const missingPlan = planFor(missingPlanning);
  const missingState = acceptPlan({ cwd: missing.cwd, plan: missingPlan, expectedRevision: missingPlanning.revision });
  const historical = packetFor(missingState, missingPlan, 'state-task');
  delete historical.minimalityAuthority.tripwires[0].observedInventory;
  assert.deepEqual(validateImplementationTask(historical), [], 'historical packet shape remains readable');
  assert.throws(() => bindTaskWithScope({ cwd: missing.cwd, packet: historical,
    expectedRevision: missingState.revision }), (error) => error.code === 'INVALID_TASK_PACKET');
});

test('structured worker discovery invalidates task scope and admits only its exact receipt-bound assessment', async () => {
  const fixture = repository('worker scope discovery assessment');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'worker-scope-discovery',
    mode: 'implement', baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = planFor(planning);
  let state = acceptPlan({ cwd: fixture.cwd, plan, expectedRevision: planning.revision });
  const closure = testMinimalClosure(state, plan);
  const packet = packetFor(state, plan, 'state-task');
  state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(fixture.cwd, state, packet);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: packet.taskId, workerId: 'discovery-worker',
    expectedRevision: state.revision });
  const scopeDiscovery = {
    schemaVersion: 1,
    summary: 'The worker found one unowned lifecycle path.',
    evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
      detail: 'The exact task cannot complete without authority for this additional state path.' }],
    triggeredTripwireIds: ['test-task-paths'],
    requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }],
  };
  const blocked = { ...resultFor(packet, 'blocked'), unexpectedDependencies: [scopeDiscovery.summary],
    scopeDiscovery, summary: scopeDiscovery.summary };
  state = acceptResult({ cwd: fixture.cwd, result: blocked, workerCwd: worker.path,
    expectedRevision: state.revision });
  assert.equal(state.phase, 'blocked');
  assert.equal(state.scope.status, 'assessment-required');
  assert.equal(state.scope.currentEvidenceDigest, null);
  assert.match(state.blockedReasons[0], /reported blocked scope discovery/u);
  assert.match(state.nextAction, /receipt-backed worker scope discovery/u);

  const packetDigest = implementationTaskDigest(packet);
  const resultDigest = digestJson(blocked);
  const discoveryDigest = digestJson(scopeDiscovery);
  const subjectDigest = digestJson({ taskPacketDigest: packetDigest, resultDigest, discoveryDigest });
  const trigger = `worker-scope-discovery:${packet.taskId}:${resultDigest}:${discoveryDigest}`;
  const stale = testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest: packetDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest, trigger });
  assert.throws(() => assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: stale,
    expectedRevision: state.revision }), (error) => error.code === 'SCOPE_ASSESSMENT_INVALID');
  const wrongTrigger = testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest, trigger: 'worker-scope-discovery:stale' });
  assert.throws(() => assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: wrongTrigger,
    expectedRevision: state.revision }), (error) => error.code === 'SCOPE_ASSESSMENT_INVALID');
  const exact = testScopeEvidence(state, plan, closure, { boundary: 'task', subjectDigest,
    subjectSha: packet.taskBaseSha, taskPacketDigest: packetDigest, trigger });
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: exact,
    expectedRevision: state.revision });
  assert.equal(state.phase, 'blocked', 'assessment never expands or executes the immutable worker packet');
  assert.equal(state.scope.status, 'current');
  assert.equal(state.scope.currentBoundary, 'task');
});

test('material decision supersedes only its exact discovery blocker before rejection and amendment', async () => {
  async function discoveryFixture(name, withFailedSibling = false, disposition = 'reject-use-narrow') {
    const fixture = repository(name);
    const planning = await initializeState({ cwd: fixture.cwd, changeId: name, mode: 'implement',
      baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
    const plan = withFailedSibling ? executionPlanFor(planning) : planFor(planning);
    const closure = testMinimalClosure(planning, plan);
    let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
      scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
    const packet = packetFor(state, plan, 'state-task');
    state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
    const worker = createWorkerFixture(fixture.cwd, state, packet);
    let sibling = null;
    let siblingWorker = null;
    if (withFailedSibling) {
      sibling = packetFor(state, plan, 'second-task');
      state = bindTaskWithScope({ cwd: fixture.cwd, packet: sibling, expectedRevision: state.revision });
      siblingWorker = createWorkerFixture(fixture.cwd, state, sibling);
    }
    state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
    state = startTask({ cwd: fixture.cwd, taskId: packet.taskId, workerId: `${name}-discovery-worker`,
      expectedRevision: state.revision });
    if (sibling) {
      state = startTask({ cwd: fixture.cwd, taskId: sibling.taskId, workerId: `${name}-sibling-worker`,
        expectedRevision: state.revision });
      state = acceptResult({ cwd: fixture.cwd, workerCwd: siblingWorker.path,
        expectedRevision: state.revision, result: { ...resultFor(sibling, 'failed'),
          validation: sibling.requiredValidation.unit.map(({ command }) => ({ command, result: 'failed',
            summary: 'Sibling validation failed.' })), unexpectedDependencies: [],
          summary: 'Sibling worker failed independently.' } });
    }
    const scopeDiscovery = {
      schemaVersion: 1,
      summary: 'The worker found one unowned lifecycle path.',
      evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
        detail: 'The immutable task cannot complete without additional path authority.' }],
      triggeredTripwireIds: ['test-task-paths'],
      requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }],
    };
    const blocked = { ...resultFor(packet, 'blocked'), unexpectedDependencies: [scopeDiscovery.summary],
      scopeDiscovery, summary: scopeDiscovery.summary };
    state = acceptResult({ cwd: fixture.cwd, result: blocked, workerCwd: worker.path,
      expectedRevision: state.revision });
    const evidence = workerDiscoveryMaterialScopeEvidence(state, plan, closure, packet, blocked, scopeDiscovery);
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });
    state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision,
      decision: materialScopeDecision(state, evidence, disposition, [], `${name}-decision`) });
    return { ...fixture, state, plan, closure, packet };
  }

  const exact = await discoveryFixture('material-discovery-rejection');
  let state = exact.state;
  const amendmentBlocker = 'Recorded material scope decision requires its exact authorized plan amendment before implementation can continue.';
  assert.deepEqual(state.blockedReasons, [amendmentBlocker]);
  assert.equal(validateState({ cwd: exact.cwd }).valid, true,
    'the exact material decision receipt supersedes its one discovery blocker');
  state = rejectTask({ cwd: exact.cwd, taskId: exact.packet.taskId,
    reason: 'Replace the over-scoped discovery task.', expectedRevision: state.revision });
  assert.deepEqual(state.blockedReasons, [amendmentBlocker,
    'Task state-task was explicitly rejected: Replace the over-scoped discovery task.']);
  assert.equal(validateState({ cwd: exact.cwd }).valid, true,
    'rejection regenerates receipt-backed blocker evidence while preserving amendment authority');
  removeTaskWorktree({ cwd: exact.cwd, changeId: state.changeId, taskId: exact.packet.taskId });

  const amended = materialAmendment(state, exact.plan, exact.closure,
    [...exact.closure.authorizedShape], 'replace-material-discovery-task');
  amended.resultingPlan.tasks[0].id = 'replacement-task';
  amended.resultingPlan.tasks[0].title = 'Implement replacement task';
  amended.resultingPlan.criteria[0].ownerTaskId = 'replacement-task';
  amended.resultingPlan.checklistMappings[0].taskIds = ['replacement-task'];
  amended.minimalClosure.planDigest = digestJson(amended.resultingPlan);
  amended.amendment.delta = { replacementTaskId: 'replacement-task' };
  const suffix = `${exact.packet.taskId}/0001.json`;
  amended.amendment.invalidatedEvidence.push(
    `implementation/tasks/${suffix}`,
    `implementation/provenance/${suffix}`,
    `implementation/planning-signals/${suffix}`,
    `implementation/specialist-routes/${suffix}`,
    `implementation/results/${suffix}`,
  );
  state = amendPlanWithScope({ cwd: exact.cwd, expectedRevision: state.revision, ...amended });
  assert.deepEqual(state.execution.tasks.map(({ id, status }) => ({ id, status })),
    [{ id: 'replacement-task', status: 'unbound' }]);

  const nearMiss = await discoveryFixture('material-discovery-sibling-missing', true);
  const directory = changeDirectory(nearMiss.cwd, nearMiss.state.changeId);
  const before = durableSnapshot(directory);
  assert.throws(() => validateState({ cwd: nearMiss.cwd }),
    (error) => error.code === 'TASK_RESULT_MISMATCH');
  assert.throws(() => rejectTask({ cwd: nearMiss.cwd, taskId: nearMiss.packet.taskId,
    reason: 'Do not absorb a missing sibling blocker.', expectedRevision: nearMiss.state.revision }),
  (error) => error.code === 'TASK_RESULT_MISMATCH');
  assert.deepEqual(durableSnapshot(directory), before,
    'an unrelated missing sibling blocker fails atomically without durable mutation');

  const abandoned = await discoveryFixture('material-discovery-abandonment', false, 'abandon-replan');
  assert.equal(abandoned.state.phase, 'abandoned');
  assert.equal(validateState({ cwd: abandoned.cwd }).valid, true,
    'the exact abandonment receipt remains valid in its terminal phase');
  const abandonedDirectory = changeDirectory(abandoned.cwd, abandoned.state.changeId);
  const beforeAbandonedRejection = durableSnapshot(abandonedDirectory);
  assert.throws(() => rejectTask({ cwd: abandoned.cwd, taskId: abandoned.packet.taskId,
    reason: 'Do not reopen terminal abandonment.', expectedRevision: abandoned.state.revision }),
  (error) => error.code === 'TASK_RESULT_MISMATCH');
  assert.deepEqual(durableSnapshot(abandonedDirectory), beforeAbandonedRejection,
    'task rejection cannot move terminal abandonment back to blocked');
});

test('minor and trim assessments supersede only their exact discovery blocker through rejection and amendment', async () => {
  async function discoveryFixture(name, verdict, siblingOutcome = null, crashAssessment = false,
    skipAssessment = false, discoveryTaskId = 'state-task') {
    const fixture = repository(name);
    const planning = await initializeState({ cwd: fixture.cwd, changeId: name, mode: 'implement',
      baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
    const plan = siblingOutcome ? executionPlanFor(planning) : planFor(planning);
    if (siblingOutcome === 'bound') {
      for (const [ordinal, taskId] of [['third', 'third-task'], ['fourth', 'fourth-task']]) {
        const criterionId = `${ordinal}-change`;
        plan.criteria.push({ id: criterionId, description: `${ordinal} task remains independent.`,
          disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
        plan.tasks.push({ ...plan.tasks[0], id: taskId, title: `Implement ${ordinal}`,
          objective: `Persist ${ordinal} file.`, criterionIds: [criterionId], checklistItemIds: [],
          anticipatedPaths: [`${ordinal}.txt`] });
      }
    }
    const closure = testMinimalClosure(planning, plan);
    let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
      scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
    const packet = packetFor(state, plan, discoveryTaskId);
    state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
    const worker = createWorkerFixture(fixture.cwd, state, packet);
    let sibling = null;
    let siblingWorker = null;
    const fillerWorkers = [];
    if (siblingOutcome) {
      if (siblingOutcome === 'bound') {
        for (const fillerTaskId of ['second-task', 'third-task']) {
          const filler = packetFor(state, plan, fillerTaskId);
          state = bindTaskWithScope({ cwd: fixture.cwd, packet: filler, expectedRevision: state.revision });
          fillerWorkers.push({ packet: filler, worker: createWorkerFixture(fixture.cwd, state, filler) });
        }
      }
      const siblingTaskId = siblingOutcome === 'bound' ? 'fourth-task'
        : discoveryTaskId === 'state-task' ? 'second-task' : 'state-task';
      sibling = packetFor(state, plan, siblingTaskId);
      if (siblingOutcome !== 'unbound') {
        state = bindTaskWithScope({ cwd: fixture.cwd, packet: sibling, expectedRevision: state.revision });
        siblingWorker = createWorkerFixture(fixture.cwd, state, sibling);
      }
    }
    state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
    state = startTask({ cwd: fixture.cwd, taskId: packet.taskId, workerId: `${name}-discovery-worker`,
      expectedRevision: state.revision });
    for (const { packet: filler, worker: fillerWorker } of fillerWorkers) {
      state = startTask({ cwd: fixture.cwd, taskId: filler.taskId,
        workerId: `${name}-${filler.taskId}-worker`, expectedRevision: state.revision });
      state = acceptResult({ cwd: fixture.cwd, workerCwd: fillerWorker.path,
        expectedRevision: state.revision, result: resultFor(filler, 'no-change') });
    }
    if (sibling && !['unbound', 'bound', 'scheduled'].includes(siblingOutcome)) {
      state = startTask({ cwd: fixture.cwd, taskId: sibling.taskId, workerId: `${name}-sibling-worker`,
        expectedRevision: state.revision });
      if (siblingOutcome === 'failed') {
        state = acceptResult({ cwd: fixture.cwd, workerCwd: siblingWorker.path,
          expectedRevision: state.revision, result: { ...resultFor(sibling, 'failed'),
            validation: sibling.requiredValidation.unit.map(({ command }) => ({ command, result: 'failed',
              summary: 'Sibling validation failed.' })), unexpectedDependencies: [],
            summary: 'Sibling worker failed independently.' } });
      } else if (siblingOutcome === 'blocked') {
        state = acceptResult({ cwd: fixture.cwd, workerCwd: siblingWorker.path,
          expectedRevision: state.revision, result: {
            ...resultFor(sibling, 'blocked'),
            summary: 'Sibling worker is blocked independently.',
          } });
      } else if (siblingOutcome === 'accepted') {
        const [siblingPath] = sibling.allowedPaths;
        writeFileSync(join(siblingWorker.path, siblingPath), 'accepted nonmaterial sibling\n');
        git(siblingWorker.path, 'add', siblingPath);
        git(siblingWorker.path, 'commit', '-m', 'test: accepted nonmaterial sibling');
        state = acceptResult({ cwd: fixture.cwd, workerCwd: siblingWorker.path,
          expectedRevision: state.revision,
          result: resultFor(sibling, 'implemented', git(siblingWorker.path, 'rev-parse', 'HEAD'), [siblingPath]) });
      } else if (siblingOutcome === 'no-change') {
        state = acceptResult({ cwd: fixture.cwd, workerCwd: siblingWorker.path,
          expectedRevision: state.revision, result: resultFor(sibling, 'no-change') });
      }
    }
    const scopeDiscovery = {
      schemaVersion: 1,
      summary: 'The worker found one unowned lifecycle path.',
      evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
        detail: 'The immutable task cannot complete without additional path authority.' }],
      triggeredTripwireIds: ['test-task-paths'],
      requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }],
    };
    const blocked = { ...resultFor(packet, 'blocked'), unexpectedDependencies: [scopeDiscovery.summary],
      scopeDiscovery, summary: scopeDiscovery.summary };
    state = acceptResult({ cwd: fixture.cwd, result: blocked, workerCwd: worker.path,
      expectedRevision: state.revision });
    if (skipAssessment) {
      return { ...fixture, state, plan, closure, packet, sibling, siblingWorker };
    }
    const evidence = workerDiscoveryNonmaterialScopeEvidence(
      state, plan, closure, packet, blocked, scopeDiscovery, verdict,
    );
    if (crashAssessment) {
      assert.throws(() => assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
        expectedRevision: state.revision,
        crashStep(step) { if (step === 'after-intent') throw new Error('pause nonmaterial assessment'); } }),
      /pause nonmaterial assessment/u);
      state = recoverState({ cwd: fixture.cwd }).state;
    } else {
      state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
        expectedRevision: state.revision });
    }
    return { ...fixture, state, plan, closure, packet, sibling, siblingWorker, evidence };
  }

  const blockers = {
    'minor-amendment-required': 'Scope assessment requires a bounded minor amendment before implementation can continue.',
    'trim-required': 'Scope assessment requires bounded removal or simplification of unnecessary machinery.',
  };

  const unsettledStatuses = ['bound', 'scheduled', 'running', 'accepted',
    'integration-pending', 'blocked', 'failed'];
  const amendmentCompatibleStatuses = ['unbound', 'rejected', 'integrated', 'no-change'];
  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    for (const targetStatus of [...unsettledStatuses, ...amendmentCompatibleStatuses]) {
      const initialStatus = ['integration-pending', 'integrated'].includes(targetStatus)
        ? 'accepted' : targetStatus === 'rejected' ? 'running' : targetStatus;
      const fixture = await discoveryFixture(
        `nonmaterial-${verdict}-${targetStatus}-sibling`, verdict, initialStatus,
      );
      let state = fixture.state;
      if (targetStatus === 'integration-pending') {
        assert.throws(() => integrateTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
          expectedRevision: state.revision,
          crashStep(step) {
            if (step === 'integration-operation-after-intent') throw new Error('pause matrix integration');
          } }), /pause matrix integration/u);
        state = recoverState({ cwd: fixture.cwd }).state;
      } else if (targetStatus === 'integrated') {
        state = integrateTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
          expectedRevision: state.revision });
      } else if (targetStatus === 'rejected') {
        state = rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
          reason: 'Reject the matrix sibling before discovery cleanup.', expectedRevision: state.revision });
      }
      assert.equal(state.execution.tasks.find(({ id }) => id === fixture.sibling.taskId).status,
        targetStatus, `${verdict} constructs receipt-valid ${targetStatus} sibling state`);
      assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
        `${verdict} ${targetStatus} sibling state is receipt-valid`);

      const directory = changeDirectory(fixture.cwd, state.changeId);
      if (unsettledStatuses.includes(targetStatus)) {
        const before = durableSnapshot(directory);
        if (verdict === 'minor-amendment-required' && targetStatus === 'bound') {
          writeFileSync(join(fixture.cwd, 'dirty-before-discovery-rejection.txt'), 'dirty\n');
        }
        assert.throws(() => rejectTask({ cwd: fixture.cwd, taskId: fixture.packet.taskId,
          reason: `Do not reject discovery with ${targetStatus} sibling.`, expectedRevision: state.revision }),
        (error) => error.code === 'TASK_STATE_CONFLICT');
        if (verdict === 'minor-amendment-required' && targetStatus === 'bound') {
          unlinkSync(join(fixture.cwd, 'dirty-before-discovery-rejection.txt'));
        }
        assert.deepEqual(durableSnapshot(directory), before,
          `${verdict} ${targetStatus} guard is atomic before receipts or state mutate`);

        if (['scheduled', 'running'].includes(targetStatus)) {
          assert.match(state.nextAction, /active-wave task result/u,
            `${verdict} ${targetStatus} sibling retains active-wave priority`);
          state = rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
            reason: `Settle the ${targetStatus} sibling.`, expectedRevision: state.revision });
        } else if (targetStatus === 'accepted') {
          assert.match(state.nextAction, new RegExp(`Integrate.*${fixture.sibling.taskId}`, 'u'));
          assert.throws(() => rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
            reason: 'Accepted siblings integrate first.', expectedRevision: state.revision }),
          (error) => error.code === 'TASK_STATE_CONFLICT');
          state = integrateTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
            expectedRevision: state.revision });
        } else if (targetStatus === 'integration-pending') {
          assert.match(state.nextAction, /reconcile-integration/u);
          state = rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
            reason: 'Reject the persisted sibling integration intent.', expectedRevision: state.revision });
        } else {
          assert.match(state.nextAction,
            new RegExp(`reject-task.*sibling task ${fixture.sibling.taskId}`, 'u'),
            `${verdict} ${targetStatus} sibling receives an executable rejection instruction`);
          if (verdict === 'trim-required' && targetStatus === 'failed') {
            assert.throws(() => rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
              reason: `Settle the ${targetStatus} sibling.`, expectedRevision: state.revision,
              crashStep(step) {
                if (step === 'after-intent') throw new Error('pause sibling rejection');
              } }), /pause sibling rejection/u);
            state = recoverState({ cwd: fixture.cwd }).state;
            assert.match(state.nextAction,
              new RegExp(`reject-task.*${fixture.packet.taskId}.*clean up.*amend-plan`, 'u'),
            'recovery reproduces the post-settlement discovery instruction');
          } else {
            state = rejectTask({ cwd: fixture.cwd, taskId: fixture.sibling.taskId,
              reason: `Settle the ${targetStatus} sibling.`, expectedRevision: state.revision });
          }
        }
        if (targetStatus !== 'accepted') {
          const reason = targetStatus === 'integration-pending'
            ? 'Reject the persisted sibling integration intent.' : `Settle the ${targetStatus} sibling.`;
          assert.equal(state.execution.tasks.find(({ id }) => id === fixture.sibling.taskId).status, 'rejected');
          assert.deepEqual(state.blockedReasons, [blockers[verdict],
            `Task ${fixture.sibling.taskId} was explicitly rejected: ${reason}`],
          `${verdict} ${targetStatus} settlement preserves only gate and canonical rejection`);
        }
        assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
      }

      state = rejectTask({ cwd: fixture.cwd, taskId: fixture.packet.taskId,
        reason: `Reject discovery after ${targetStatus} sibling disposition.`, expectedRevision: state.revision });
      assert.equal(state.execution.tasks.find(({ id }) => id === fixture.packet.taskId).status, 'rejected');
      assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
        `${verdict} ${targetStatus} sibling permits discovery rejection only when terminal-compatible`);
    }
  }

  const recoveredBound = await discoveryFixture(
    'nonmaterial-bound-sibling-assessment-recovery', 'trim-required', 'bound', true,
  );
  assert.match(recoveredBound.state.nextAction,
    new RegExp(`reject-task.*sibling task ${recoveredBound.sibling.taskId}`, 'u'),
  'assessment recovery reproduces the exact bound-sibling settlement instruction');
  assert.equal(validateState({ cwd: recoveredBound.cwd }).valid, true);

  {
    const fixture = repository('nonmaterial multi sibling plan order');
    const planning = await initializeState({ cwd: fixture.cwd,
      changeId: 'nonmaterial-multi-sibling-plan-order', mode: 'implement', baseBranch: 'main',
      planningRef: fixture.sha, source: descriptor });
    const plan = executionPlanFor(planning);
    plan.criteria.push({ id: 'third-change', description: 'Third task owns discovery.',
      disposition: 'owned', ownerTaskId: 'third-task', deferredReason: null });
    plan.tasks.push({ ...plan.tasks[0], id: 'third-task', title: 'Discover third',
      objective: 'Discover exact third-task scope.', criterionIds: ['third-change'], checklistItemIds: [],
      anticipatedPaths: ['third.txt'] });
    const closure = testMinimalClosure(planning, plan);
    let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
      scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
    const packets = plan.tasks.map(({ id }) => packetFor(state, plan, id));
    const workers = new Map();
    for (const packet of packets) {
      state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
      workers.set(packet.taskId, createWorkerFixture(fixture.cwd, state, packet));
    }
    state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
    for (const packet of packets) {
      state = startTask({ cwd: fixture.cwd, taskId: packet.taskId,
        workerId: `${packet.taskId}-worker`, expectedRevision: state.revision });
    }
    state = acceptResult({ cwd: fixture.cwd, workerCwd: workers.get('state-task').path,
      expectedRevision: state.revision, result: {
        ...resultFor(packets[0], 'failed'),
        validation: packets[0].requiredValidation.unit.map(({ command }) => ({
          command, result: 'failed', summary: 'First sibling validation failed.',
        })),
        summary: 'First sibling failed.',
      } });
    state = acceptResult({ cwd: fixture.cwd, workerCwd: workers.get('second-task').path,
      expectedRevision: state.revision,
      result: { ...resultFor(packets[1], 'blocked'), summary: 'Second sibling blocked.' } });
    const discovery = packets[2];
    const scopeDiscovery = { schemaVersion: 1, summary: 'Third task found unowned lifecycle work.',
      evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
        detail: 'Third task requires a bounded scope assessment.' }],
      triggeredTripwireIds: ['test-task-paths'],
      requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }] };
    const discoveryResult = { ...resultFor(discovery, 'blocked'),
      unexpectedDependencies: [scopeDiscovery.summary], scopeDiscovery, summary: scopeDiscovery.summary };
    state = acceptResult({ cwd: fixture.cwd, workerCwd: workers.get('third-task').path,
      expectedRevision: state.revision, result: discoveryResult });
    const evidence = workerDiscoveryNonmaterialScopeEvidence(
      state, plan, closure, discovery, discoveryResult, scopeDiscovery, 'trim-required',
    );
    state = assessScope({ cwd: fixture.cwd, scopeEvidence: evidence,
      expectedRevision: state.revision });
    assert.deepEqual(state.blockedReasons, [blockers['trim-required'],
      'Task state-task reported failed: First sibling failed.',
      'Task second-task reported blocked: Second sibling blocked.']);
    assert.match(state.nextAction, /reject-task.*sibling task state-task/u,
      'the first plan-order unsettled sibling is selected ahead of a later sibling and discovery');
    state = rejectTask({ cwd: fixture.cwd, taskId: 'state-task',
      reason: 'Settle first plan-order sibling.', expectedRevision: state.revision });
    assert.match(state.nextAction, /reject-task.*sibling task second-task/u,
      'the next plan-order sibling is selected after the first settles');
    assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
  }

  {
    const fixture = repository('nonmaterial capacity spanning cleanup');
    const planning = await initializeState({ cwd: fixture.cwd,
      changeId: 'nonmaterial-capacity-spanning-cleanup', mode: 'implement', baseBranch: 'main',
      planningRef: fixture.sha, source: descriptor });
    const plan = executionPlanFor(planning);
    for (const [ordinal, taskId] of [['third', 'third-task'], ['fourth', 'fourth-task'],
      ['fifth', 'fifth-task']]) {
      const criterionId = `${ordinal}-change`;
      plan.criteria.push({ id: criterionId, description: `${ordinal} task remains independent.`,
        disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
      plan.tasks.push({ ...plan.tasks[0], id: taskId, title: `Implement ${ordinal}`,
        objective: `Persist ${ordinal} file.`, criterionIds: [criterionId], checklistItemIds: [],
        anticipatedPaths: [`${ordinal}.txt`] });
    }
    const closure = testMinimalClosure(planning, plan);
    let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
      scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
    const packets = plan.tasks.map(({ id }) => packetFor(state, plan, id));
    const workers = new Map();
    for (const packet of packets) {
      state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
      workers.set(packet.taskId, createWorkerFixture(fixture.cwd, state, packet));
    }
    state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
    for (const taskId of ['state-task', 'second-task', 'third-task']) {
      state = startTask({ cwd: fixture.cwd, taskId, workerId: `${taskId}-worker`,
        expectedRevision: state.revision });
    }
    for (const taskId of ['second-task', 'third-task']) {
      state = rejectTask({ cwd: fixture.cwd, taskId,
        reason: `Settle active-wave sibling ${taskId}.`, expectedRevision: state.revision });
      assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
    }
    const discovery = packets[0];
    const scopeDiscovery = { schemaVersion: 1, summary: 'First task found bounded lifecycle work.',
      evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
        detail: 'First task requires a bounded scope assessment.' }],
      triggeredTripwireIds: ['test-task-paths'],
      requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }] };
    const discoveryResult = { ...resultFor(discovery, 'blocked'),
      unexpectedDependencies: [scopeDiscovery.summary], scopeDiscovery, summary: scopeDiscovery.summary };
    state = acceptResult({ cwd: fixture.cwd, workerCwd: workers.get(discovery.taskId).path,
      expectedRevision: state.revision, result: discoveryResult });
    state = assessScope({ cwd: fixture.cwd,
      scopeEvidence: workerDiscoveryNonmaterialScopeEvidence(
        state, plan, closure, discovery, discoveryResult, scopeDiscovery, 'trim-required'),
      expectedRevision: state.revision });
    assert.match(state.nextAction, /reject-task.*sibling task fourth-task/u,
      'capacity-spanning settlement selects the first remaining bound sibling');
    for (const taskId of ['fourth-task', 'fifth-task']) {
      if (taskId === 'fourth-task') {
        assert.throws(() => rejectTask({ cwd: fixture.cwd, taskId,
          reason: `Settle serial sibling ${taskId}.`, expectedRevision: state.revision,
          crashStep(step) {
            if (step === 'after-intent') throw new Error('pause capacity-spanning settlement');
          } }), /pause capacity-spanning settlement/u);
        state = recoverState({ cwd: fixture.cwd }).state;
        assert.match(state.nextAction, /reject-task.*sibling task fifth-task/u);
      } else {
        state = rejectTask({ cwd: fixture.cwd, taskId,
          reason: `Settle serial sibling ${taskId}.`, expectedRevision: state.revision });
      }
      assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
    }
    assert.match(state.nextAction, /reject-task.*state-task.*clean up every rejected-task worktree/u);
    assert.match(state.nextAction,
      /all 5 from the complete execution task set whose status is rejected, in accepted-plan order/u,
      'more than three cleanup targets retain one bounded complete-state selector');
    assert.match(state.nextAction, /replace every rejected task.*amend-plan/u);
    assert.ok(state.nextAction.length <= 1000);
    state = rejectTask({ cwd: fixture.cwd, taskId: discovery.taskId,
      reason: 'Settle discovery after all capacity-spanning siblings.', expectedRevision: state.revision });
    assert.doesNotMatch(state.nextAction, /change:state reject-task/u);
    assert.match(state.nextAction,
      /all 5 from the complete execution task set whose status is rejected, in accepted-plan order/u);
    assert.deepEqual(state.execution.tasks.map(({ id, status }) => ({ id, status })),
      ['state-task', 'second-task', 'third-task', 'fourth-task', 'fifth-task']
        .map((id) => ({ id, status: 'rejected' })),
    'all five cleanup targets remain explicit in execution-plan order');
    assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
  }

  const unbound = await discoveryFixture(
    'nonmaterial-unbound-retaining-amendment', 'minor-amendment-required', 'unbound',
  );
  let unboundState = rejectTask({ cwd: unbound.cwd, taskId: unbound.packet.taskId,
    reason: 'Replace the assessed discovery while retaining its unbound sibling.',
    expectedRevision: unbound.state.revision });
  removeTaskWorktree({ cwd: unbound.cwd, changeId: unboundState.changeId,
    taskId: unbound.packet.taskId });
  const unboundReplacementId = 'unbound-discovery-replacement';
  const unboundReplacementCriterionId = 'unbound-discovery-replacement-criterion';
  const unboundResponsibility = unbound.evidence.result.scopeDelta.description;
  const unboundPlan = structuredClone(unbound.plan);
  unboundPlan.planRevision = 2;
  unboundPlan.criteria = unboundPlan.criteria.map((criterion) => criterion.ownerTaskId === unbound.packet.taskId
    ? { ...criterion, ownerTaskId: unboundReplacementId } : criterion);
  unboundPlan.criteria.push({ id: unboundReplacementCriterionId,
    description: unboundResponsibility, disposition: 'owned',
    ownerTaskId: unboundReplacementId, deferredReason: null });
  unboundPlan.tasks = unboundPlan.tasks.map((task) => task.id === unbound.packet.taskId
    ? { ...task, id: unboundReplacementId,
      objective: unboundResponsibility, criterionIds: [...task.criterionIds, unboundReplacementCriterionId],
      decisionIds: [...task.decisionIds] }
    : task);
  unboundPlan.checklistMappings = unboundPlan.checklistMappings.map((mapping) => ({
    ...mapping,
    taskIds: mapping.taskIds.map((id) => id === unbound.packet.taskId ? unboundReplacementId : id),
  }));
  const unboundClosure = { ...structuredClone(unbound.closure), revision: 2,
    previousContractDigest: unboundState.scope.closureDigest, planDigest: digestJson(unboundPlan),
    authorizedShape: [...unbound.closure.authorizedShape, 'unowned-lifecycle-path'] };
  const unboundTrigger = unboundState.scope.currentEvidenceDigest;
  const unboundSuffix = `${unbound.packet.taskId}/0001.json`;
  unboundState = amendPlanWithScope({ cwd: unbound.cwd, expectedRevision: unboundState.revision,
    resultingPlan: unboundPlan, minimalClosure: unboundClosure,
    amendment: { id: 'retain-unbound-sibling-amendment',
      reason: 'Replace the rejected discovery without disturbing unbound sibling authority.',
      authorization: 'scope-review', trigger: unboundTrigger,
      delta: { addedTaskIds: [unboundReplacementId] }, invalidatedEvidence: [unboundTrigger,
        `implementation/tasks/${unboundSuffix}`, `implementation/provenance/${unboundSuffix}`,
        `implementation/planning-signals/${unboundSuffix}`,
        `implementation/specialist-routes/${unboundSuffix}`,
        `implementation/results/${unboundSuffix}`] } });
  assert.deepEqual(unboundState.execution.tasks.map(({ id, status }) => ({ id, status })), [
    { id: unboundReplacementId, status: 'unbound' },
    { id: unbound.sibling.taskId, status: 'unbound' },
  ], 'a real amendment replaces discovery while retaining an untouched unbound sibling');

  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const ordinary = repository(`ordinary-${verdict}-summary`);
    const ordinaryPlanning = await initializeState({ cwd: ordinary.cwd,
      changeId: `ordinary-${verdict}-summary`, mode: 'implement', baseBranch: 'main',
      planningRef: ordinary.sha, source: descriptor });
    const ordinaryPlan = planFor(ordinaryPlanning);
    const ordinaryClosure = testMinimalClosure(ordinaryPlanning, ordinaryPlan);
    let ordinaryState = acceptPlanWithScope({ cwd: ordinary.cwd, plan: ordinaryPlan,
      minimalClosure: ordinaryClosure,
      scopeEvidence: testScopeEvidence(ordinaryPlanning, ordinaryPlan, ordinaryClosure),
      expectedRevision: ordinaryPlanning.revision });
    const ordinaryPacket = packetFor(ordinaryState, ordinaryPlan, 'state-task');
    ordinaryState = bindTaskWithScope({ cwd: ordinary.cwd, packet: ordinaryPacket,
      expectedRevision: ordinaryState.revision });
    const ordinaryWorker = createWorkerFixture(ordinary.cwd, ordinaryState, ordinaryPacket);
    ordinaryState = scheduleWave({ cwd: ordinary.cwd, expectedRevision: ordinaryState.revision });
    ordinaryState = startTask({ cwd: ordinary.cwd, taskId: ordinaryPacket.taskId,
      workerId: `ordinary-${verdict}-worker`, expectedRevision: ordinaryState.revision });
    ordinaryState = acceptResult({ cwd: ordinary.cwd, workerCwd: ordinaryWorker.path,
      expectedRevision: ordinaryState.revision, result: {
        ...resultFor(ordinaryPacket, 'blocked'),
        summary: `Ordinary worker mentions ${blockers[verdict]}`,
      } });
    assert.equal(validateState({ cwd: ordinary.cwd }).valid, true);
    assert.doesNotMatch(ordinaryState.nextAction, /change:state (?:reject-task|amend-plan)/u,
      `${verdict} prose in a receipt-valid ordinary result cannot spoof scope remediation`);

    const unassessed = await discoveryFixture(
      `unassessed-${verdict}-discovery`, verdict, null, false, true,
    );
    assert.equal(validateState({ cwd: unassessed.cwd }).valid, true);
    assert.equal(unassessed.state.scope.currentEvidenceDigest, null);
    assert.equal(unassessed.state.scope.currentBoundary, null);
    assert.equal(unassessed.state.scope.currentSubjectSha, null);
    assert.match(unassessed.state.nextAction, /change:state assess-scope/u);
    assert.doesNotMatch(unassessed.state.nextAction, /change:state (?:reject-task|amend-plan)/u,
      `${verdict} fresh receipt-valid unassessed discovery cannot advertise destructive remediation`);

    const fixture = await discoveryFixture(`discovery-${verdict}`, verdict);
    let state = fixture.state;
    assert.deepEqual(state.blockedReasons, [blockers[verdict]]);
    assert.match(state.nextAction, new RegExp(`reject-task.*${fixture.packet.taskId}.*clean up.*amend-plan`, 'u'));
    const duplicatedGate = structuredClone(state);
    duplicatedGate.blockedReasons.push(blockers[verdict]);
    assert.doesNotMatch(nextActionFor(duplicatedGate), /change:state (?:reject-task|amend-plan)/u,
      `${verdict} requires exactly one strict canonical gate blocker`);
    assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
      `${verdict} supersedes its exact receipt-matched discovery blocker`);
    state = rejectTask({ cwd: fixture.cwd, taskId: fixture.packet.taskId,
      reason: `Replace the ${verdict} discovery task.`, expectedRevision: state.revision });
    assert.deepEqual(state.blockedReasons, [blockers[verdict],
      `Task state-task was explicitly rejected: Replace the ${verdict} discovery task.`]);
    assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
      `${verdict} rejection restores only the new receipt-backed task blocker`);
    removeTaskWorktree({ cwd: fixture.cwd, changeId: state.changeId, taskId: fixture.packet.taskId });

    const resultingPlan = structuredClone(fixture.plan);
    resultingPlan.planRevision = 2;
    const verdictLabel = verdict === 'minor-amendment-required' ? 'minor' : 'trim';
    const responsibility = verdict === 'minor-amendment-required'
      ? fixture.evidence.result.scopeDelta.description
      : fixture.evidence.result.smallerSufficientAlternative;
    const replacementTaskId = `${verdictLabel}-replacement`;
    const replacementCriterionId = `${verdictLabel}-replacement-criterion`;
    resultingPlan.criteria[0].ownerTaskId = replacementTaskId;
    resultingPlan.criteria.push({ id: replacementCriterionId,
      description: responsibility, disposition: 'owned',
      ownerTaskId: replacementTaskId, deferredReason: null });
    resultingPlan.tasks[0] = { ...resultingPlan.tasks[0], id: replacementTaskId,
      title: 'Apply bounded discovery remediation',
      objective: responsibility,
      decisionIds: [...resultingPlan.tasks[0].decisionIds],
      criterionIds: [resultingPlan.criteria[0].id, replacementCriterionId],
      anticipatedPaths: verdict === 'trim-required'
        ? ['unowned/lifecycle.json'] : resultingPlan.tasks[0].anticipatedPaths };
    resultingPlan.checklistMappings[0].taskIds = [replacementTaskId];
    const minimalClosure = { ...structuredClone(fixture.closure), revision: 2,
      previousContractDigest: state.scope.closureDigest, planDigest: digestJson(resultingPlan),
      authorizedShape: verdict === 'minor-amendment-required'
        ? [...fixture.closure.authorizedShape, 'unowned-lifecycle-path']
        : [...fixture.closure.authorizedShape] };
    const trigger = state.scope.currentEvidenceDigest;
    const suffix = `${fixture.packet.taskId}/0001.json`;
    state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, resultingPlan,
      minimalClosure, amendment: { id: `${verdictLabel}-replacement-amendment`,
        reason: 'Apply the exact nonmaterial remediation.', authorization: 'scope-review',
        trigger, delta: { addedTaskIds: [replacementTaskId] }, invalidatedEvidence: [trigger,
          `implementation/tasks/${suffix}`, `implementation/provenance/${suffix}`,
          `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`,
          `implementation/results/${suffix}`] } });
    assert.deepEqual(state.execution.tasks.map(({ id, status }) => ({ id, status })),
      [{ id: replacementTaskId, status: 'unbound' }],
      `${verdict} cleanup permits progress only under a new task ID`);
  }

  const identical = await discoveryFixture(
    'nonmaterial-discovery-identical-blocker-near-miss', 'trim-required', 'running',
  );
  const identicalDirectory = changeDirectory(identical.cwd, identical.state.changeId);
  const duplicatedState = structuredClone(identical.state);
  duplicatedState.blockedReasons.push(blockers['trim-required']);
  duplicatedState.nextAction = nextActionFor(duplicatedState);
  const transitionDirectory = join(identicalDirectory, 'transitions',
    String(duplicatedState.revision).padStart(8, '0'));
  const duplicatedIntent = JSON.parse(readFileSync(join(transitionDirectory, 'intent.json'), 'utf8'));
  duplicatedIntent.nextState = duplicatedState;
  duplicatedIntent.nextStateDigest = digestJson(duplicatedState);
  writeCompleteTransitionFixture(transitionDirectory, duplicatedIntent);
  writeFileSync(join(identicalDirectory, 'state.json'), `${JSON.stringify(duplicatedState)}\n`);
  const beforeIdenticalAcceptance = durableSnapshot(identicalDirectory);
  assert.throws(() => acceptResult({ cwd: identical.cwd, workerCwd: identical.siblingWorker.path,
    expectedRevision: duplicatedState.revision, result: resultFor(identical.sibling, 'no-change') }),
  (error) => error instanceof StateError);
  assert.deepEqual(durableSnapshot(identicalDirectory), beforeIdenticalAcceptance,
    'identical blocker text cannot stand in for one exact receipt-bound assessment identity');

  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const lateSibling = await discoveryFixture(
      `nonmaterial-discovery-late-sibling-${verdict}`, verdict, 'running', false, false,
      verdict === 'minor-amendment-required' ? 'second-task' : 'state-task',
    );
    const [lateSiblingPath] = lateSibling.sibling.allowedPaths;
    writeFileSync(join(lateSibling.siblingWorker.path, lateSiblingPath), 'late accepted nonmaterial sibling\n');
    git(lateSibling.siblingWorker.path, 'add', lateSiblingPath);
    git(lateSibling.siblingWorker.path, 'commit', '-m', 'test: late accepted nonmaterial sibling');
    let lateState = acceptResult({ cwd: lateSibling.cwd, workerCwd: lateSibling.siblingWorker.path,
      expectedRevision: lateSibling.state.revision,
      result: resultFor(lateSibling.sibling, 'implemented',
        git(lateSibling.siblingWorker.path, 'rev-parse', 'HEAD'), [lateSiblingPath]) });
    assert.deepEqual(lateState.blockedReasons, [blockers[verdict]],
      `${verdict} late sibling acceptance preserves only the receipt-bound nonmaterial gate`);
    assert.match(lateState.nextAction,
      new RegExp(`Integrate.*${lateSibling.sibling.taskId}.*before resolving`, 'u'));
    assert.equal(validateState({ cwd: lateSibling.cwd }).valid, true);
    assert.throws(() => integrateTask({ cwd: lateSibling.cwd, taskId: lateSibling.sibling.taskId,
      expectedRevision: lateState.revision,
      crashStep(step) {
        if (step === 'integration-operation-after-intent') throw new Error('pause sibling integration');
      } }), /pause sibling integration/u);
    lateState = recoverState({ cwd: lateSibling.cwd }).state;
    assert.equal(lateState.phase, 'integrating');
    assert.equal(lateState.execution.integrationIntent.taskId, lateSibling.sibling.taskId);
    const rejectionReason = `Replace the aborted ${verdict} sibling integration; Recorded material scope decision is unrelated prose.`;
    lateState = rejectTask({ cwd: lateSibling.cwd, taskId: lateSibling.sibling.taskId,
      reason: rejectionReason, expectedRevision: lateState.revision });
    assert.deepEqual(lateState.blockedReasons, [blockers[verdict],
      `Task ${lateSibling.sibling.taskId} was explicitly rejected: ${rejectionReason}`],
      `${verdict} intent rejection restores the scope gate and exact sibling rejection evidence`);
    const beforeDiscoveryRejection = lateState.nextAction;
    const rejectIndex = beforeDiscoveryRejection.indexOf(`reject-task for the exact assessed discovery task ${lateSibling.packet.taskId}`);
    const cleanupIndex = beforeDiscoveryRejection.indexOf('clean up every rejected-task worktree');
    const orderedCleanupIds = lateState.execution.tasks
      .filter((task) => ['blocked', 'rejected'].includes(task.status)).map((task) => task.id);
    const firstCleanupIndex = beforeDiscoveryRejection.indexOf(orderedCleanupIds[0], cleanupIndex);
    const secondCleanupIndex = beforeDiscoveryRejection.indexOf(orderedCleanupIds[1], cleanupIndex);
    const replacementIndex = beforeDiscoveryRejection.indexOf('replace every rejected task with a new task ID');
    const invalidationIndex = beforeDiscoveryRejection.indexOf('invalidate its task packet');
    const amendmentIndex = beforeDiscoveryRejection.indexOf('run change:state amend-plan');
    assert.ok(rejectIndex >= 0 && rejectIndex < cleanupIndex
      && cleanupIndex < firstCleanupIndex && firstCleanupIndex < secondCleanupIndex
      && secondCleanupIndex < replacementIndex && replacementIndex < invalidationIndex
      && invalidationIndex < amendmentIndex,
    `${verdict} orders assessed rejection, plan-order cleanup, replacement, invalidation, and amendment`);
    assert.doesNotMatch(beforeDiscoveryRejection, /exact current material decision/u,
      `${verdict} exact nonmaterial authority outranks receipt-valid unrelated material-decision prose`);
    assert.equal(validateState({ cwd: lateSibling.cwd }).valid, true);

    lateState = rejectTask({ cwd: lateSibling.cwd, taskId: lateSibling.packet.taskId,
      reason: `Replace the assessed ${verdict} discovery.`, expectedRevision: lateState.revision });
    assert.doesNotMatch(lateState.nextAction, /change:state reject-task/u,
      `${verdict} stops requesting discovery rejection after it is durably rejected`);
    const afterCleanupIndex = lateState.nextAction.indexOf('clean up every rejected-task worktree');
    const afterFirstIndex = lateState.nextAction.indexOf(orderedCleanupIds[0], afterCleanupIndex);
    const afterSecondIndex = lateState.nextAction.indexOf(orderedCleanupIds[1], afterCleanupIndex);
    const afterReplacementIndex = lateState.nextAction.indexOf('replace every rejected task with a new task ID');
    const afterInvalidationIndex = lateState.nextAction.indexOf('invalidate its task packet');
    const afterAmendmentIndex = lateState.nextAction.indexOf('run change:state amend-plan');
    assert.ok(afterCleanupIndex >= 0 && afterCleanupIndex < afterFirstIndex
      && afterFirstIndex < afterSecondIndex && afterSecondIndex < afterReplacementIndex
      && afterReplacementIndex < afterInvalidationIndex && afterInvalidationIndex < afterAmendmentIndex,
    `${verdict} preserves complete plan-order cleanup and amendment guidance after discovery rejection`);
    removeTaskWorktree({ cwd: lateSibling.cwd, changeId: lateState.changeId,
      taskId: lateSibling.packet.taskId });
    removeTaskWorktree({ cwd: lateSibling.cwd, changeId: lateState.changeId,
      taskId: lateSibling.sibling.taskId });

    const verdictLabel = verdict === 'minor-amendment-required' ? 'minor' : 'trim';
    const responsibility = verdict === 'minor-amendment-required'
      ? lateSibling.evidence.result.scopeDelta.description
      : lateSibling.evidence.result.smallerSufficientAlternative;
    const discoveryReplacementId = `${verdictLabel}-discovery-replacement`;
    const siblingReplacementId = `${verdictLabel}-sibling-replacement`;
    const discoveryCriterionId = `${verdictLabel}-discovery-transition-replacement`;
    const siblingCriterionId = `${verdictLabel}-sibling-transition-replacement`;
    const siblingPriorCriterion = lateSibling.plan.criteria
      .find(({ ownerTaskId }) => ownerTaskId === lateSibling.sibling.taskId);
    const resultingPlan = structuredClone(lateSibling.plan);
    resultingPlan.planRevision = 2;
    resultingPlan.criteria = resultingPlan.criteria.map((criterion) => ({
      ...criterion,
      ownerTaskId: criterion.ownerTaskId === lateSibling.packet.taskId
        ? discoveryReplacementId : siblingReplacementId,
    }));
    resultingPlan.criteria.push({ id: discoveryCriterionId,
      description: responsibility, disposition: 'owned',
      ownerTaskId: discoveryReplacementId, deferredReason: null },
    { ...siblingPriorCriterion, id: siblingCriterionId, ownerTaskId: siblingReplacementId });
    resultingPlan.tasks = resultingPlan.tasks.map((task) => task.id === lateSibling.packet.taskId
      ? { ...task, id: discoveryReplacementId,
        objective: responsibility, criterionIds: [...task.criterionIds, discoveryCriterionId],
        decisionIds: [...task.decisionIds],
        anticipatedPaths: verdict === 'trim-required'
          ? ['unowned/lifecycle.json'] : task.anticipatedPaths }
      : { ...task, id: siblingReplacementId,
        criterionIds: [...task.criterionIds, siblingCriterionId] });
    resultingPlan.checklistMappings = resultingPlan.checklistMappings.map((mapping) => ({
      ...mapping,
      taskIds: mapping.taskIds.map((id) => id === lateSibling.packet.taskId
        ? discoveryReplacementId : id === lateSibling.sibling.taskId ? siblingReplacementId : id),
    }));
    const minimalClosure = { ...structuredClone(lateSibling.closure), revision: 2,
      previousContractDigest: lateState.scope.closureDigest, planDigest: digestJson(resultingPlan),
      authorizedShape: verdict === 'minor-amendment-required'
        ? [...lateSibling.closure.authorizedShape, 'unowned-lifecycle-path']
        : [...lateSibling.closure.authorizedShape] };
    const trigger = lateState.scope.currentEvidenceDigest;
    const invalidatedEvidence = [trigger];
    for (const task of [lateSibling.packet, lateSibling.sibling]) {
      const suffix = `${task.taskId}/0001.json`;
      invalidatedEvidence.push(`implementation/tasks/${suffix}`,
        `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`,
        `implementation/specialist-routes/${suffix}`,
        `implementation/results/${suffix}`);
    }
    const absorbedPlan = structuredClone(resultingPlan);
    const absorbedSiblingCriterionIds = absorbedPlan.criteria
      .filter(({ ownerTaskId }) => ownerTaskId === siblingReplacementId).map(({ id }) => id);
    absorbedPlan.criteria = absorbedPlan.criteria.map((criterion) =>
      absorbedSiblingCriterionIds.includes(criterion.id)
        ? { ...criterion, ownerTaskId: discoveryReplacementId } : criterion);
    absorbedPlan.tasks = absorbedPlan.tasks.filter(({ id }) => id !== siblingReplacementId);
    absorbedPlan.tasks.find(({ id }) => id === discoveryReplacementId).criterionIds
      .push(...absorbedSiblingCriterionIds);
    absorbedPlan.checklistMappings = absorbedPlan.checklistMappings.map((mapping) => ({ ...mapping,
      taskIds: mapping.taskIds.map((id) => id === siblingReplacementId ? discoveryReplacementId : id),
    }));
    const absorbedClosure = { ...minimalClosure, planDigest: digestJson(absorbedPlan) };
    const absorptionBefore = durableSnapshot(changeDirectory(lateSibling.cwd, lateState.changeId));
    assert.throws(() => amendPlanWithScope({ cwd: lateSibling.cwd,
      expectedRevision: lateState.revision, resultingPlan: absorbedPlan, minimalClosure: absorbedClosure,
      amendment: { id: `${verdictLabel}-absorbed-transition-amendment`,
        reason: 'Do not absorb an unrelated rejected sibling into assessment remediation.',
        authorization: 'scope-review', trigger,
        delta: { addedTaskIds: [discoveryReplacementId] }, invalidatedEvidence,
      } }), (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(changeDirectory(lateSibling.cwd, lateState.changeId)),
      absorptionBefore, `${verdict} unrelated sibling absorption is rejected atomically`);
    lateState = amendPlanWithScope({ cwd: lateSibling.cwd, expectedRevision: lateState.revision,
      resultingPlan, minimalClosure, amendment: {
        id: `${verdictLabel}-transition-amendment`,
        reason: 'Replace every task rejected by the exact nonmaterial transition.',
        authorization: 'scope-review', trigger,
        delta: { addedTaskIds: [discoveryReplacementId, siblingReplacementId] },
        invalidatedEvidence,
      } });
    assert.deepEqual(lateState.execution.tasks.map(({ id, status }) => ({ id, status })),
      resultingPlan.tasks.map(({ id }) => ({ id, status: 'unbound' })),
      `${verdict} complete instruction leads to one valid replacement amendment`);

    const acceptedSibling = await discoveryFixture(
      `nonmaterial-discovery-accepted-sibling-${verdict}`, verdict, 'accepted',
    );
    let acceptedState = acceptedSibling.state;
    assert.equal(acceptedState.execution.tasks.find(({ id }) => id === acceptedSibling.sibling.taskId).status,
      'accepted');
    assert.match(acceptedState.nextAction,
      new RegExp(`Integrate.*${acceptedSibling.sibling.taskId}.*before resolving`, 'u'),
      `${verdict} prioritizes the dependency-ready accepted sibling`);
    assert.doesNotMatch(acceptedState.nextAction, /reject-task/u,
      `${verdict} does not advertise premature discovery rejection`);
    const acceptedDirectory = changeDirectory(acceptedSibling.cwd, acceptedState.changeId);
    const beforeAssessedRejection = durableSnapshot(acceptedDirectory);
    assert.throws(() => rejectTask({ cwd: acceptedSibling.cwd, taskId: acceptedSibling.packet.taskId,
      reason: 'Do not reject the discovery before integrating its accepted sibling.',
      expectedRevision: acceptedState.revision }),
    (error) => error.code === 'TASK_STATE_CONFLICT');
    assert.deepEqual(durableSnapshot(acceptedDirectory), beforeAssessedRejection,
      `${verdict} rejects premature discovery cleanup atomically`);
    acceptedState = integrateTask({ cwd: acceptedSibling.cwd, taskId: acceptedSibling.sibling.taskId,
      expectedRevision: acceptedState.revision });
    assert.equal(acceptedState.execution.tasks.find(({ id }) => id === acceptedSibling.sibling.taskId).status,
      'integrated');
    assert.equal(acceptedState.execution.tasks.find(({ id }) => id === acceptedSibling.packet.taskId).status,
      'blocked');
    assert.deepEqual(acceptedState.blockedReasons, [blockers[verdict]],
      'receipt-backed sibling integration preserves the exact nonmaterial amendment gate');
    assert.match(acceptedState.nextAction,
      new RegExp(`reject-task.*${acceptedSibling.packet.taskId}.*clean up.*amend-plan`, 'u'));
    assert.doesNotMatch(acceptedState.nextAction,
      new RegExp(`rejected-task worktree \\([^)]*${acceptedSibling.sibling.taskId}`, 'u'),
      `${verdict} never treats an integrated sibling as a cleanup target`);
    assert.equal(validateState({ cwd: acceptedSibling.cwd }).valid, true);

    const noChangeSibling = await discoveryFixture(
      `nonmaterial-discovery-no-change-sibling-${verdict}`, verdict, 'no-change',
    );
    assert.equal(validateState({ cwd: noChangeSibling.cwd }).valid, true);
    assert.doesNotMatch(noChangeSibling.state.nextAction,
      new RegExp(`rejected-task worktree \\([^)]*${noChangeSibling.sibling.taskId}`, 'u'),
      `${verdict} never treats a no-change sibling as a cleanup target`);
  }

  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const competing = await discoveryFixture(
      `nonmaterial-competing-discovery-${verdict}`, verdict, 'running',
    );
    const secondDiscovery = {
      schemaVersion: 1,
      summary: 'The sibling independently found another unowned lifecycle path.',
      evidence: [{ kind: 'state-path', identity: 'unowned/second-lifecycle.json',
        detail: 'The sibling cannot complete without separate path authority.' }],
      triggeredTripwireIds: ['test-task-paths'],
      requestedAuthority: [{ field: 'paths', values: ['unowned/second-lifecycle.json'] }],
    };
    const secondResult = { ...resultFor(competing.sibling, 'blocked'),
      unexpectedDependencies: [secondDiscovery.summary], scopeDiscovery: secondDiscovery,
      summary: secondDiscovery.summary };
    const directory = changeDirectory(competing.cwd, competing.state.changeId);
    const before = durableSnapshot(directory);
    assert.throws(() => acceptResult({ cwd: competing.cwd, workerCwd: competing.siblingWorker.path,
      expectedRevision: competing.state.revision, result: secondResult }),
    (error) => error.code === 'TASK_STATE_CONFLICT');
    assert.deepEqual(durableSnapshot(directory), before,
      `${verdict} competing discovery rejection is atomic across every durable artifact`);
    assert.equal(competing.state.execution.tasks.find(({ id }) => id === competing.packet.taskId).status,
      'blocked');
    assert.equal(competing.state.execution.tasks.find(({ id }) => id === competing.sibling.taskId).status,
      'running');
    assert.equal(validateState({ cwd: competing.cwd }).valid, true);

    assert.throws(() => rejectTask({ cwd: competing.cwd, taskId: competing.sibling.taskId,
      reason: 'Settle the competing discovery before amending assessed authority.',
      expectedRevision: competing.state.revision,
      crashStep(step) {
        if (step === 'after-intent') throw new Error('pause competing discovery rejection');
      } }), /pause competing discovery rejection/u);
    let recovered = recoverState({ cwd: competing.cwd }).state;
    assert.equal(recovered.execution.tasks.find(({ id }) => id === competing.sibling.taskId).status,
      'rejected', `${verdict} recovery commits the explicitly rejected sibling`);
    assert.match(recovered.nextAction,
      new RegExp(`reject-task.*${competing.packet.taskId}.*clean up.*${competing.sibling.taskId}.*amend-plan`, 'u'));
    recovered = rejectTask({ cwd: competing.cwd, taskId: competing.packet.taskId,
      reason: 'Replace the exact assessed discovery after sibling settlement.',
      expectedRevision: recovered.revision });
    assert.deepEqual(recovered.execution.tasks.map(({ id, status }) => ({ id, status })), [
      { id: competing.packet.taskId, status: 'rejected' },
      { id: competing.sibling.taskId, status: 'rejected' },
    ]);
    assert.match(recovered.nextAction,
      new RegExp(`clean up.*${competing.packet.taskId}.*${competing.sibling.taskId}.*amend-plan`, 'u'));
    assert.equal(validateState({ cwd: competing.cwd }).valid, true);
    removeTaskWorktree({ cwd: competing.cwd, changeId: recovered.changeId,
      taskId: competing.packet.taskId });
    removeTaskWorktree({ cwd: competing.cwd, changeId: recovered.changeId,
      taskId: competing.sibling.taskId });
  }

  const maximumIdState = structuredClone((await discoveryFixture(
    'nonmaterial-maximum-next-action', 'minor-amendment-required', 'accepted'
  )).state);
  const maximumIds = ['a'.repeat(128), 'b'.repeat(128), 'c'.repeat(128)];
  maximumIdState.execution.tasks[0].id = maximumIds[0];
  maximumIdState.execution.tasks[1].id = maximumIds[1];
  maximumIdState.execution.tasks[1].status = 'rejected';
  maximumIdState.execution.tasks.push({ ...maximumIdState.execution.tasks[1], id: maximumIds[2] });
  const maximumAction = nextActionFor(maximumIdState);
  assert.ok(maximumIds.every((id) => maximumAction.includes(id)));
  assert.ok(maximumAction.length <= 1000,
    'three maximum-length active-wave task IDs remain inside the persisted nextAction schema limit');

  const rejectedSibling = await discoveryFixture(
    'nonmaterial-discovery-rejected-sibling', 'minor-amendment-required', 'accepted',
  );
  const rejectedSiblingDirectory = changeDirectory(rejectedSibling.cwd, rejectedSibling.state.changeId);
  const beforeRejectedSibling = durableSnapshot(rejectedSiblingDirectory);
  assert.throws(() => rejectTask({ cwd: rejectedSibling.cwd, taskId: rejectedSibling.sibling.taskId,
    reason: 'Do not supersede the assessed task with a sibling rejection.',
    expectedRevision: rejectedSibling.state.revision }),
  (error) => error.code === 'TASK_STATE_CONFLICT');
  assert.deepEqual(durableSnapshot(rejectedSiblingDirectory), beforeRejectedSibling,
    'accepted sibling rejection leaves the assessed blocker and task unchanged');
  assert.equal(validateState({ cwd: rejectedSibling.cwd }).valid, true);

  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const recovered = await discoveryFixture(
      `nonmaterial-discovery-instruction-recovery-${verdict}`, verdict, 'accepted', true,
    );
    assert.match(recovered.state.nextAction,
      new RegExp(`Integrate.*${recovered.sibling.taskId}.*before resolving`, 'u'),
      `${verdict} recovery reproduces the accepted-sibling integration instruction`);
    let recoveredState = integrateTask({ cwd: recovered.cwd, taskId: recovered.sibling.taskId,
      expectedRevision: recovered.state.revision });
    assert.match(recoveredState.nextAction,
      new RegExp(`reject-task.*${recovered.packet.taskId}.*clean up.*amend-plan`, 'u'),
      `${verdict} recovery reaches the exact assessed-task cleanup sequence after integration`);
    assert.equal(validateState({ cwd: recovered.cwd }).valid, true);
  }

  const insufficient = await discoveryFixture('nonmaterial-discovery-insufficient-near-miss', 'insufficient-evidence');
  const insufficientDirectory = changeDirectory(insufficient.cwd, insufficient.state.changeId);
  const beforeInsufficientRejection = durableSnapshot(insufficientDirectory);
  assert.throws(() => validateState({ cwd: insufficient.cwd }),
    (error) => error.code === 'TASK_RESULT_MISMATCH');
  assert.throws(() => rejectTask({ cwd: insufficient.cwd, taskId: insufficient.packet.taskId,
    reason: 'Do not treat insufficient evidence as amendment authority.',
    expectedRevision: insufficient.state.revision }),
  (error) => error.code === 'TASK_RESULT_MISMATCH');
  assert.deepEqual(durableSnapshot(insufficientDirectory), beforeInsufficientRejection,
    'insufficient-evidence prose cannot supersede receipt-backed discovery evidence');
});

test('ordinary accepted tasks remain explicitly rejectable outside a nonmaterial discovery gate', async () => {
  const fixture = repository('ordinary accepted rejection');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'ordinary-accepted-rejection',
    mode: 'implement', baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = planFor(planning);
  plan.tasks[0].anticipatedPaths = ['ordinary-accepted.txt'];
  const closure = testMinimalClosure(planning, plan);
  let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(fixture.cwd, state, packet);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: packet.taskId,
    workerId: 'ordinary-accepted-worker', expectedRevision: state.revision });
  const [changedPath] = packet.allowedPaths;
  writeFileSync(join(worker.path, changedPath), 'ordinary accepted result\n');
  git(worker.path, 'add', changedPath);
  git(worker.path, 'commit', '-m', 'test: preserve ordinary accepted rejection');
  state = acceptResult({ cwd: fixture.cwd, workerCwd: worker.path,
    result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), [changedPath]),
    expectedRevision: state.revision });
  state = rejectTask({ cwd: fixture.cwd, taskId: packet.taskId,
    reason: 'Reject the ordinary accepted task.', expectedRevision: state.revision });
  assert.deepEqual(state.blockedReasons,
    ['Task state-task was explicitly rejected: Reject the ordinary accepted task.']);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
});

test('nonmaterial task-tripwire and integrated-head assessments retain direct amendment guidance', async () => {
  function withNonmaterialVerdict(evidence, verdict) {
    const mapping = evidence.result.coverage[0];
    evidence.result = verdict === 'minor-amendment-required'
      ? { ...evidence.result, verdict,
        coverage: [{ ...mapping, classification: 'necessary-minor-expansion',
          rationale: 'The exact assessment requires one bounded adjacent correction.' }],
        scopeDelta: { description: 'Add only the bounded adjacent correction.',
          sourceCriterionIds: [...mapping.sourceCriterionIds],
          acceptedCriterionIds: [...mapping.acceptedCriterionIds], invariantIds: [],
          materialSurfaces: [] } }
      : { ...evidence.result, verdict,
        coverage: [{ ...mapping, sourceCriterionIds: [], acceptedCriterionIds: [],
          classification: 'speculative', rationale: 'The exact mechanism is unnecessary.' }],
        unnecessaryWork: [mapping.mechanism],
        smallerSufficientAlternative: 'Remove only the unnecessary mechanism.' };
    evidence.resultDigest = digestJson(evidence.result);
    return evidence;
  }

  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const tripwire = repository(`direct task tripwire ${verdict}`);
    const planning = await initializeState({ cwd: tripwire.cwd,
      changeId: `direct-task-tripwire-${verdict}`, mode: 'implement', baseBranch: 'main',
      planningRef: tripwire.sha, source: descriptor });
    const plan = planFor(planning);
    const closure = testMinimalClosure(planning, plan);
    let state = acceptPlan({ cwd: tripwire.cwd, plan, expectedRevision: planning.revision });
    const packet = packetFor(state, plan, 'state-task');
    packet.minimalityAuthority.tripwires[0].observedInventory = ['changed-path'];
    const packetDigest = implementationTaskDigest(packet);
    const evidence = withNonmaterialVerdict(testScopeEvidence(state, plan, closure, {
      boundary: 'task', subjectDigest: packetDigest, subjectSha: packet.taskBaseSha,
      taskPacketDigest: packetDigest, trigger: 'task-tripwires:test-task-paths',
    }), verdict);
    state = assessScope({ cwd: tripwire.cwd, scopeEvidence: evidence,
      expectedRevision: state.revision });
    assert.equal(validateState({ cwd: tripwire.cwd }).valid, true);
    assert.match(state.nextAction, new RegExp(`^Run change:state amend-plan from the exact ${verdict}`, 'u'));
    assert.doesNotMatch(state.nextAction, /reject-task|clean up|worktree/u,
      `${verdict} task-tripwire guidance does not invent discovery cleanup`);

    const integrated = await integratedSingleTaskFixture(`direct integrated head ${verdict}`);
    const integratedEvidence = withNonmaterialVerdict(
      integratedScopeEvidenceFor({ cwd: integrated.cwd, changeId: integrated.state.changeId }), verdict,
    );
    const integratedState = assessScope({ cwd: integrated.cwd, scopeEvidence: integratedEvidence,
      expectedRevision: integrated.state.revision });
    assert.equal(validateState({ cwd: integrated.cwd }).valid, true);
    assert.match(integratedState.nextAction,
      new RegExp(`^Run change:state amend-plan from the exact ${verdict}`, 'u'));
    assert.doesNotMatch(integratedState.nextAction, /reject-task|clean up|worktree/u,
      `${verdict} integrated-head guidance does not invent discovery cleanup`);
  }
});

test('accepted material approval remains blocked until its exact approved shape is amended', async () => {
  const fixture = await materialDecisionFixture('material-approval');
  const directory = changeDirectory(fixture.cwd, fixture.state.changeId);
  const missingDecisionSnapshot = durableSnapshot(directory);
  const premature = materialAmendment(fixture.state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha']);
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: fixture.state.revision, ...premature }),
    (error) => error.code === 'INVALID_PHASE');
  assert.deepEqual(durableSnapshot(directory), missingDecisionSnapshot,
    'missing decision authority rejects without durable writes');

  let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], 'approve-alpha') });
  assert.equal(state.phase, 'blocked');
  assert.match(state.nextAction, /exact current material decision/u);
  const beforeMismatch = durableSnapshot(directory);
  const overbroad = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha', 'material-beta'], 'overbroad-approval');
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...overbroad }),
    (error) => error.code === 'SCOPE_AMENDMENT_INVALID');
  assert.deepEqual(durableSnapshot(directory), beforeMismatch,
    'an approval cannot retain an assessed mechanism outside approvedShape');
  const reordered = materialAmendment(state, fixture.plan, fixture.closure,
    ['unrelated-existing-shape', 'durable-test-change', 'material-alpha'], 'reordered-approval');
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...reordered }),
    (error) => error.code === 'SCOPE_AMENDMENT_INVALID' && /preserve unrelated authority in order/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), beforeMismatch,
    'an approval cannot reorder unrelated authority');

  const exact = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha']);
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact });
  assert.equal(state.phase, 'implementing');
  const amendedClosure = JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', '0002.json'), 'utf8'));
  assert.deepEqual(amendedClosure.authorizedShape,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha']);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
});

test('narrow material dispositions remove every assessed mechanism and preserve unrelated authority', async () => {
  for (const disposition of ['split-defer', 'reject-use-narrow']) {
    const fixture = await materialDecisionFixture(`material-${disposition}`);
    let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
      decision: materialScopeDecision(fixture.state, fixture.evidence, disposition, [], `${disposition}-decision`) });
    const directory = changeDirectory(fixture.cwd, state.changeId);
    const before = durableSnapshot(directory);
    const retaining = materialAmendment(state, fixture.plan, fixture.closure,
      ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], `${disposition}-retains-material`);
    assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...retaining }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID');
    assert.deepEqual(durableSnapshot(directory), before, `${disposition} rejects retained material atomically`);
    const narrowed = materialAmendment(state, fixture.plan, fixture.closure,
      ['durable-test-change', 'unrelated-existing-shape'], `${disposition}-narrows`);
    state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...narrowed });
    assert.equal(state.phase, 'implementing');
    const amendedClosure = JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', '0002.json'), 'utf8'));
    assert.deepEqual(amendedClosure.authorizedShape,
      ['durable-test-change', 'unrelated-existing-shape']);
  }
});

test('every material disposition preserves unrelated semantic closure fields exactly', async () => {
  for (const disposition of ['approve-material-amendment', 'reject-use-narrow', 'split-defer']) {
    const closureOverrides = {
      invariants: [
        { id: 'exact-test-authority', text: 'Bind exact test evidence.' },
        { id: 'stable-test-authority', text: 'Preserve stable test evidence.' },
      ],
      nonGoals: [
        { id: 'no-test-expansion', text: 'Do not expand test authority.' },
        { id: 'no-policy-rewrite', text: 'Do not rewrite policy authority.' },
      ],
      mandatoryConstraints: [
        { id: 'receipt-test-authority', text: 'Persist receipt evidence.' },
        { id: 'atomic-test-authority', text: 'Reject invalid evidence atomically.' },
      ],
      optionalGuidance: [
        { id: 'keep-local', text: 'Keep the implementation local.' },
        { id: 'keep-small', text: 'Keep the implementation small.' },
      ],
      unauthorizedExpansion: ['repository-wide-framework', 'unrelated-product-change'],
    };
    const fixture = await materialDecisionFixture(`material-${disposition}-semantic-preservation`,
      ['material-alpha'], closureOverrides);
    const approvedShape = disposition === 'approve-material-amendment' ? ['material-alpha'] : [];
    const decision = materialScopeDecision(fixture.state, fixture.evidence, disposition, approvedShape,
      `${disposition}-semantic-preservation`);
    const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision, decision });
    const directory = changeDirectory(fixture.cwd, state.changeId);
    const before = durableSnapshot(directory);
    const authorizedShape = disposition === 'approve-material-amendment'
      ? ['durable-test-change', 'unrelated-existing-shape', 'material-alpha']
      : ['durable-test-change', 'unrelated-existing-shape'];
    const semanticFields = [
      'outcome',
      'requiredCriteria',
      'invariants',
      'nonGoals',
      'mandatoryConstraints',
      'optionalGuidance',
      'unauthorizedExpansion',
    ];
    const preserved = Object.fromEntries(semanticFields.map((field) => [field, fixture.closure[field]]));
    const mismatches = {
      outcome: 'Rewrite the accepted material outcome.',
      requiredCriteria: fixture.closure.requiredCriteria.map((entry, index) => index === 0
        ? { ...entry, text: 'Rewrite the required criterion.' } : entry),
      invariants: [...fixture.closure.invariants].reverse(),
      nonGoals: fixture.closure.nonGoals.slice(0, -1),
      mandatoryConstraints: [
        ...fixture.closure.mandatoryConstraints,
        { id: 'extra-constraint', text: 'Add an unrelated constraint.' },
      ],
      optionalGuidance: fixture.closure.optionalGuidance.map((entry, index) => index === 0
        ? { ...entry, text: 'Rewrite optional guidance.' } : entry),
      unauthorizedExpansion: [...fixture.closure.unauthorizedExpansion].reverse(),
    };
    for (const [index, [field, value]] of Object.entries(mismatches).entries()) {
      const amendment = materialAmendment(state, fixture.plan, fixture.closure, authorizedShape,
        `${disposition}-semantic-mismatch-${index + 1}`, { ...preserved, [field]: value });
      assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...amendment }),
        (error) => error.code === 'SCOPE_AMENDMENT_INVALID'
          && error.message.includes(`preserve prior ${field} exactly`));
      assert.deepEqual(durableSnapshot(directory), before,
        `${disposition} ${field} mismatch writes no sidecar, state, event, transition, or plan bytes`);
    }
    const exact = materialAmendment(state, fixture.plan, fixture.closure, authorizedShape,
      `${disposition}-semantic-preservation-success`, preserved);
    const amended = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact });
    assert.equal(amended.phase, 'implementing');
    const amendedClosure = JSON.parse(readFileSync(join(directory,
      'scope', 'minimal-closure', '0002.json'), 'utf8'));
    for (const field of semanticFields) assert.deepEqual(amendedClosure[field], fixture.closure[field]);
  }
});

test('split-defer preserves the exact deferred prefix and appends only decision follow-ups in order', async () => {
  const priorFollowups = [{ id: 'existing-follow-up', text: 'Preserve the existing follow-up.' }];
  const fixture = await materialDecisionFixture('material-split-followups',
    ['material-alpha'], { deferredFollowups: priorFollowups });
  const decision = materialScopeDecision(fixture.state, fixture.evidence, 'split-defer', [], 'split-followups');
  const directory = changeDirectory(fixture.cwd, fixture.state.changeId);
  const beforeInvalidDecision = durableSnapshot(directory);
  assert.throws(() => recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: { ...decision, deferredFollowups: ['Issue #25'] } }),
  (error) => error.code === 'SCOPE_DECISION_INVALID');
  assert.deepEqual(durableSnapshot(directory), beforeInvalidDecision,
    'invalid split-defer identity changes no receipt, state revision, event, phase, or blocked reason');
  decision.deferredFollowups = ['follow-up-alpha', 'follow-up-beta'];
  const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision, decision });
  const before = durableSnapshot(directory);
  const exactFollowups = [...priorFollowups,
    { id: 'follow-up-alpha', text: 'follow-up-alpha' },
    { id: 'follow-up-beta', text: 'follow-up-beta' }];
  const mismatches = [
    exactFollowups.slice(1),
    [{ ...priorFollowups[0], text: 'Rewrite the existing follow-up.' }, ...exactFollowups.slice(1)],
    exactFollowups.slice(0, -1),
    [...exactFollowups, { id: 'extra-follow-up', text: 'extra-follow-up' }],
    [priorFollowups[0], exactFollowups[2], exactFollowups[1]],
  ];
  for (const [index, deferredFollowups] of mismatches.entries()) {
    const amendment = materialAmendment(state, fixture.plan, fixture.closure,
      ['durable-test-change', 'unrelated-existing-shape'], `invalid-split-followups-${index + 1}`,
      { deferredFollowups });
    assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...amendment }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID' && /deferred-follow-up prefix/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before, 'invalid split-defer follow-ups write no durable bytes');
  }
  const exact = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape'], 'exact-split-followups',
    { deferredFollowups: exactFollowups });
  const amended = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact });
  assert.equal(amended.phase, 'implementing');
  const amendedClosure = JSON.parse(readFileSync(join(directory,
    'scope', 'minimal-closure', '0002.json'), 'utf8'));
  assert.deepEqual(amendedClosure.deferredFollowups, exactFollowups);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
});

test('split-defer rejects an unrepresentable combined closure before recording its decision', async () => {
  const priorFollowups = Array.from({ length: 255 }, (_, index) => {
    const id = `prior-follow-up-${index + 1}`;
    return { id, text: id };
  });
  const fixture = await materialDecisionFixture('material-split-combined-capacity',
    ['material-alpha'], { deferredFollowups: priorFollowups });
  const directory = changeDirectory(fixture.cwd, fixture.state.changeId);
  const before = durableSnapshot(directory);
  const decision = materialScopeDecision(fixture.state, fixture.evidence,
    'split-defer', [], 'split-combined-capacity');
  const invalidAdditions = [
    ['prior-follow-up-1'],
    ['final-follow-up', 'overflow-follow-up'],
  ];
  for (const deferredFollowups of invalidAdditions) {
    assert.throws(() => recordScopeDecision({
      cwd: fixture.cwd,
      expectedRevision: fixture.state.revision,
      decision: { ...decision, deferredFollowups },
    }), (error) => error.code === 'SCOPE_DECISION_INVALID'
      && /projected split-defer closure/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before,
      'an invalid combined closure writes no decision receipt, state revision, event, phase, or blocked reason');
  }

  decision.deferredFollowups = ['final-follow-up'];
  const state = recordScopeDecision({
    cwd: fixture.cwd,
    expectedRevision: fixture.state.revision,
    decision,
  });
  const exactFollowups = [
    ...priorFollowups,
    { id: 'final-follow-up', text: 'final-follow-up' },
  ];
  assert.equal(exactFollowups.length, 256);
  const exact = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape'], 'exact-full-split-followups',
    { deferredFollowups: exactFollowups });
  const amended = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact });
  assert.equal(amended.phase, 'implementing');
  const amendedClosure = JSON.parse(readFileSync(join(directory,
    'scope', 'minimal-closure', '0002.json'), 'utf8'));
  assert.deepEqual(amendedClosure.deferredFollowups, exactFollowups);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
});

test('material dispositions other than split-defer cannot change deferred follow-ups', async () => {
  for (const disposition of ['approve-material-amendment', 'reject-use-narrow']) {
    const fixture = await materialDecisionFixture(`material-${disposition}-followups`, ['material-alpha'], {
      deferredFollowups: [{ id: 'existing-follow-up', text: 'Preserve the existing follow-up.' }],
    });
    const approvedShape = disposition === 'approve-material-amendment' ? ['material-alpha'] : [];
    const decision = materialScopeDecision(fixture.state, fixture.evidence, disposition, approvedShape,
      `${disposition}-followups`);
    const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision, decision });
    const authorizedShape = disposition === 'approve-material-amendment'
      ? ['durable-test-change', 'unrelated-existing-shape', 'material-alpha']
      : ['durable-test-change', 'unrelated-existing-shape'];
    const amendment = materialAmendment(state, fixture.plan, fixture.closure, authorizedShape,
      `${disposition}-changes-followups`, {
        deferredFollowups: [
          ...fixture.closure.deferredFollowups,
          { id: 'unauthorized-follow-up', text: 'unauthorized-follow-up' },
        ],
      });
    const directory = changeDirectory(fixture.cwd, state.changeId);
    const before = durableSnapshot(directory);
    assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...amendment }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID' && /cannot change deferred follow-ups/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before, `${disposition} follow-up change writes no durable bytes`);
  }
});

test('unknown and historical material approvals cannot authorize the current amendment', async () => {
  const unknown = await materialDecisionFixture('material-unknown-approval');
  let unknownState = recordScopeDecision({ cwd: unknown.cwd, expectedRevision: unknown.state.revision,
    decision: materialScopeDecision(unknown.state, unknown.evidence, 'approve-material-amendment',
      ['unknown-material-shape'], 'approve-unknown') });
  const unknownDirectory = changeDirectory(unknown.cwd, unknownState.changeId);
  const unknownBefore = durableSnapshot(unknownDirectory);
  const unknownAmendment = materialAmendment(unknownState, unknown.plan, unknown.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'unknown-material-shape']);
  assert.throws(() => amendPlanWithScope({ cwd: unknown.cwd, expectedRevision: unknownState.revision,
    ...unknownAmendment }), (error) => error.code === 'SCOPE_AMENDMENT_INVALID');
  assert.deepEqual(durableSnapshot(unknownDirectory), unknownBefore,
    'shape outside the assessed material set writes no durable bytes');

  const historical = await materialDecisionFixture('material-historical-approval', ['material-alpha']);
  let state = recordScopeDecision({ cwd: historical.cwd, expectedRevision: historical.state.revision,
    decision: materialScopeDecision(historical.state, historical.evidence, 'approve-material-amendment',
      ['material-alpha'], 'approve-historical-alpha') });
  const first = materialAmendment(state, historical.plan, historical.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'apply-historical-alpha');
  state = amendPlanWithScope({ cwd: historical.cwd, expectedRevision: state.revision, ...first });
  const historicalDirectory = changeDirectory(historical.cwd, state.changeId);
  const firstClosure = JSON.parse(readFileSync(join(historicalDirectory,
    'scope', 'minimal-closure', '0002.json'), 'utf8'));
  const firstAmendment = JSON.parse(readFileSync(join(historicalDirectory,
    'plan', 'amendments', '0001.json'), 'utf8'));
  const currentPlan = first.resultingPlan;
  const currentEvidence = materialScopeEvidence(state, currentPlan, firstClosure, ['material-gamma'],
    [digestJson(firstAmendment)], [{
      id: 'approve-historical-alpha',
      digest: state.scope.decisionDigests[0],
      disposition: 'approve-material-amendment',
      authorizedShape: ['material-alpha'],
    }]);
  state = assessScope({ cwd: historical.cwd, changeId: state.changeId, scopeEvidence: currentEvidence,
    expectedRevision: state.revision });
  state = recordScopeDecision({ cwd: historical.cwd, expectedRevision: state.revision,
    decision: materialScopeDecision(state, currentEvidence, 'approve-material-amendment',
      ['material-gamma'], 'approve-current-gamma') });
  const directory = changeDirectory(historical.cwd, state.changeId);
  const before = durableSnapshot(directory);
  const staleShape = materialAmendment(state, currentPlan, firstClosure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'reuse-historical-approval');
  assert.throws(() => amendPlanWithScope({ cwd: historical.cwd, expectedRevision: state.revision, ...staleShape }),
    (error) => error.code === 'SCOPE_AMENDMENT_INVALID');
  assert.deepEqual(durableSnapshot(directory), before, 'historical approval cannot stand in for current decision shape');
});

test('material closure authority requires unique IDs and exact ordered decision digests', async () => {
  const fixture = await materialDecisionFixture('exact-material-decision-authority', ['material-alpha']);
  const firstDecisionId = 'approve-exact-alpha';
  let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], firstDecisionId) });
  const first = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'apply-exact-alpha');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...first });

  const directory = changeDirectory(fixture.cwd, state.changeId);
  const firstClosure = JSON.parse(readFileSync(join(directory,
    'scope', 'minimal-closure', '0002.json'), 'utf8'));
  const firstAmendment = JSON.parse(readFileSync(join(directory,
    'plan', 'amendments', '0001.json'), 'utf8'));
  const secondEvidence = materialScopeEvidence(state, first.resultingPlan, firstClosure,
    ['material-beta'], [digestJson(firstAmendment)], [{
      id: firstDecisionId, digest: state.scope.decisionDigests[0],
      disposition: 'approve-material-amendment', authorizedShape: ['material-alpha'],
    }]);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: secondEvidence,
    expectedRevision: state.revision });

  const beforeDuplicate = durableSnapshot(directory);
  assert.throws(() => recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision,
    decision: materialScopeDecision(state, secondEvidence, 'approve-material-amendment',
      ['material-beta'], firstDecisionId) }),
  (error) => error.code === 'SCOPE_DECISION_INVALID' && /already recorded/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), beforeDuplicate,
    'a duplicate decision ID writes no receipt, transition, event, revision, or phase');

  state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision,
    decision: materialScopeDecision(state, secondEvidence, 'approve-material-amendment',
      ['material-beta'], 'approve-exact-beta') });
  const [firstDigest, secondDigest] = state.scope.decisionDigests;
  const beforeInvalidClosure = durableSnapshot(directory);
  const invalidSequences = [
    [firstDigest],
    [secondDigest, firstDigest],
    [firstDigest, secondDigest, `sha256:${'f'.repeat(64)}`],
  ];
  for (const [index, operatorDecisionDigests] of invalidSequences.entries()) {
    const invalid = materialAmendment(state, first.resultingPlan, firstClosure,
      ['durable-test-change', 'unrelated-existing-shape', 'material-alpha', 'material-beta'],
      `invalid-decision-sequence-${index + 1}`, { operatorDecisionDigests });
    assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...invalid }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID'
        && /exact ordered durable scope decision digests/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), beforeInvalidClosure,
      'missing, reordered, or extra decision authority writes no durable bytes');
  }

  const exact = materialAmendment(state, first.resultingPlan, firstClosure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha', 'material-beta'],
    'apply-exact-beta');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact });
  assert.deepEqual(state.scope.decisionDigests, [firstDigest, secondDigest]);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
    'unique multi-decision authority with exact digest order remains replayable');
});

test('revised planning verdicts retain incorporated material decision authority', async () => {
  for (const verdict of ['minor-amendment-required', 'trim-required', 'insufficient-evidence']) {
    const fixture = repository(`revised planning ${verdict}`);
    let state = await initializeState({ cwd: fixture.cwd, changeId: `revised-planning-${verdict}`,
      mode: 'implement', baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
    const firstPlan = planFor(state);
    const firstClosure = testMinimalClosure(state, firstPlan);
    const materialEvidence = planningMaterialScopeEvidence(state, firstPlan, firstClosure);
    state = acceptPlanWithScope({ cwd: fixture.cwd, plan: firstPlan, minimalClosure: firstClosure,
      scopeEvidence: materialEvidence, expectedRevision: state.revision });
    const decision = {
      schemaVersion: 1, changeId: state.changeId, decisionId: 'planning-material-decision',
      revision: state.revision + 1, disposition: 'reject-use-narrow',
      evidence: {
        sourceDigest: state.source.latestDigest, planningSha: state.planningSha,
        planDigest: state.scope.candidatePlanDigest, amendmentDigests: [],
        closureDigest: state.scope.closureDigest, subjectDigest: materialEvidence.packet.binding.subject.digest,
        subjectSha: materialEvidence.packet.binding.subject.sha,
        assessmentPacketDigest: materialEvidence.packetDigest,
        assessmentResultDigest: materialEvidence.resultDigest,
      },
      rationale: 'Use the narrow planning candidate.', approvedShape: [], deferredFollowups: [],
    };
    state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision, decision });

    const revisedPlan = structuredClone(firstPlan);
    revisedPlan.objective = `Exercise the revised ${verdict} planning candidate.`;
    const revisedClosure = testMinimalClosure(state, revisedPlan, {
      revision: 2, previousContractDigest: state.scope.closureDigest,
      operatorDecisionDigests: [...state.scope.decisionDigests],
    });
    const revisedEvidence = nonAdmittingPlanningEvidence(state, revisedPlan, revisedClosure, verdict);
    for (const authorityDecision of [
      { ...revisedEvidence.packet.acceptedScope.authorityDecisions[0], disposition: 'split-defer' },
      { ...revisedEvidence.packet.acceptedScope.authorityDecisions[0], disposition: 'approve-material-amendment',
        authorizedShape: ['forged-decision-shape'] },
    ]) {
      const forged = structuredClone(revisedEvidence);
      forged.packet.acceptedScope.authorityDecisions = [authorityDecision];
      forged.packetDigest = digestJson(forged.packet);
      const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
      assert.throws(() => acceptPlanWithScope({ cwd: fixture.cwd, plan: revisedPlan,
        minimalClosure: revisedClosure, scopeEvidence: forged, expectedRevision: state.revision }),
      (error) => error.code === 'PLAN_SCOPE_INVALID'
        && /exact effective-plan and minimal-closure projection/u.test(error.message));
      assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
        'forged decision disposition or detached authorized shape fails atomically');
    }
    state = acceptPlanWithScope({ cwd: fixture.cwd, plan: revisedPlan, minimalClosure: revisedClosure,
      scopeEvidence: revisedEvidence, expectedRevision: state.revision });

    assert.equal(state.phase, verdict === 'human-decision-required' ? 'awaiting-scope-decision' : 'planning');
    assert.equal(state.scope.currentEvidenceDigest, digestJson(revisedEvidence));
    assert.deepEqual(state.scope.decisionDigests, [digestJson(decision)]);
    assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
      `${verdict} replays with the full incorporated decision sequence`);
  }
});

test('ordinary abandonment retains incorporated material decision authority', async () => {
  const fixture = await materialDecisionFixture('post-material-ordinary-abandonment', ['material-alpha']);
  let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], 'approve-before-ordinary-abandonment') });
  const amendment = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'incorporate-before-abandonment');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...amendment });
  assert.throws(() => archiveState({ cwd: fixture.cwd, expectedRevision: state.revision,
    abandonReason: 'Stop this already-authorized implementation.',
    crashStep(step) { if (step === 'archive-after-intent') throw new Error('pause ordinary archive'); } }),
  /pause ordinary archive/u);

  const abandoned = loadState(fixture.cwd);
  assert.equal(abandoned.phase, 'abandoned');
  assert.deepEqual(abandoned.scope.decisionDigests, state.scope.decisionDigests);
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true,
    'ordinary abandonment replays the full incorporated decision sequence');
});

test('interrupted amendment recovery rejects non-exact decision authority before mutation', async () => {
  const fixture = await materialDecisionFixture('recovery-exact-decision-authority', ['material-alpha']);
  const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], 'recovery-approve-alpha') });
  const exact = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'recovery-apply-alpha');
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause amendment recovery'); } }),
  /pause amendment recovery/u);

  const directory = changeDirectory(fixture.cwd, state.changeId);
  const transitionDirectory = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'));
  const intentPath = join(transitionDirectory, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const closureRecord = intent.authoritativeEvidence.minimalClosureDigest;
  closureRecord.value.operatorDecisionDigests = [
    ...closureRecord.value.operatorDecisionDigests,
    `sha256:${'f'.repeat(64)}`,
  ];
  closureRecord.digest = digestJson(closureRecord.value);
  intent.evidence.minimalClosureDigest = closureRecord.digest;
  intent.nextState.scope.closureDigest = closureRecord.digest;
  intent.nextStateDigest = digestJson(intent.nextState);
  writeReceiptJson(intentPath, intent);

  const beforeRecovery = durableSnapshot(directory);
  assert.throws(() => recoverState({ cwd: fixture.cwd }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
      && /invalid minimal closure authority/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), beforeRecovery,
    'recovery rejects extra decision authority before sidecars, state, events, or completion mutate');
});

test('interrupted material amendment recovery rejects receipt-consistent semantic closure tampering', async () => {
  const fixture = await materialDecisionFixture('recovery-semantic-closure-preservation', ['material-alpha']);
  const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], 'recovery-preserve-semantic-closure') });
  const exact = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'recovery-semantic-amendment');
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...exact,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause semantic amendment recovery'); } }),
  /pause semantic amendment recovery/u);

  const directory = changeDirectory(fixture.cwd, state.changeId);
  const transitionDirectory = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'));
  const intentPath = join(transitionDirectory, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const closureRecord = intent.authoritativeEvidence.minimalClosureDigest;
  closureRecord.value.outcome = 'Receipt-consistent tampering rewrites the unrelated outcome.';
  closureRecord.digest = digestJson(closureRecord.value);
  intent.evidence.minimalClosureDigest = closureRecord.digest;
  intent.nextState.scope.closureDigest = closureRecord.digest;
  intent.nextStateDigest = digestJson(intent.nextState);
  writeReceiptJson(intentPath, intent);

  const beforeRecovery = durableSnapshot(directory);
  assert.throws(() => recoverState({ cwd: fixture.cwd }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
      && /exact decision authority/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), beforeRecovery,
    'recovery rejects semantic closure tampering before any durable mutation');
});

test('durable replay rejects receipt-consistent duplicate scope decision IDs', async () => {
  const fixture = await materialDecisionFixture('duplicate-decision-replay', ['material-alpha']);
  const duplicateId = 'duplicate-replay-id';
  let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], duplicateId) });
  const first = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'duplicate-replay-first');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...first });
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const firstClosure = JSON.parse(readFileSync(join(directory,
    'scope', 'minimal-closure', '0002.json'), 'utf8'));
  const firstAmendment = JSON.parse(readFileSync(join(directory,
    'plan', 'amendments', '0001.json'), 'utf8'));
  const evidence = materialScopeEvidence(state, first.resultingPlan, firstClosure,
    ['material-beta'], [digestJson(firstAmendment)], [{
      id: duplicateId, digest: state.scope.decisionDigests[0],
      disposition: 'approve-material-amendment', authorizedShape: ['material-alpha'],
    }]);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision,
    decision: materialScopeDecision(state, evidence, 'approve-material-amendment',
      ['material-beta'], 'unique-before-tamper') });

  const decisionPath = join(directory, 'scope', 'decisions',
    `${String(state.revision).padStart(8, '0')}-unique-before-tamper.json`);
  const duplicatedDecision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  duplicatedDecision.decisionId = duplicateId;
  const duplicatedDigest = digestJson(duplicatedDecision);
  writeReceiptJson(decisionPath, duplicatedDecision);

  const duplicatedState = structuredClone(state);
  duplicatedState.scope.decisionDigests[duplicatedState.scope.decisionDigests.length - 1] = duplicatedDigest;
  const transitionDirectory = join(directory, 'transitions', String(state.revision).padStart(8, '0'));
  const intent = JSON.parse(readFileSync(join(transitionDirectory, 'intent.json'), 'utf8'));
  intent.nextState = duplicatedState;
  intent.nextStateDigest = digestJson(duplicatedState);
  intent.evidence.scopeDecisionDigest = duplicatedDigest;
  intent.authoritativeEvidence.scopeDecisionDigest.value = duplicatedDecision;
  intent.authoritativeEvidence.scopeDecisionDigest.digest = duplicatedDigest;
  writeCompleteTransitionFixture(transitionDirectory, intent);
  writeFileSync(join(directory, 'state.json'), `${JSON.stringify(duplicatedState)}\n`);

  assert.throws(() => validateState({ cwd: fixture.cwd }),
    (error) => error.code === 'SCOPE_EVIDENCE_INVALID' && /duplicate decision IDs/u.test(error.message));
});

test('abandon material disposition remains terminal and cannot be amended', async () => {
  const fixture = await materialDecisionFixture('material-abandon');
  const state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'abandon-replan', [], 'abandon-material') });
  assert.equal(state.phase, 'abandoned');
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const before = durableSnapshot(directory);
  const amendment = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape']);
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...amendment }),
    (error) => error.code === 'INVALID_PHASE');
  assert.deepEqual(durableSnapshot(directory), before);
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
  const admitted = { ...resultFor(packet, 'failed'),
    validation: packet.requiredValidation.unit.map(({ command }) => ({ command, result: 'failed',
      summary: 'The exact worker validation failed.' })),
    unexpectedDependencies: [], summary: 'The immutable task must be rejected and replaced.' };
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

test('ordinary amendment 128 commits and amendment 129 rejects before durable mutation', async () => {
  assert.equal(nextPlanAmendmentNumber(127), 128);
  assert.throws(() => nextPlanAmendmentNumber(128),
    (error) => error.code === 'AMENDMENT_LIMIT_REACHED');
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => nextPlanAmendmentNumber(invalid),
      (error) => error.code === 'AMENDMENT_COUNT_INVALID');
  }

  const { cwd, sha } = repository('amendment count boundary');
  const planning = await initializeState({ cwd, changeId: 'amendment-count-boundary', mode: 'plan-only',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  let resultingPlan = planFor(planning);
  let state = acceptPlan({ cwd, plan: resultingPlan, expectedRevision: planning.revision });
  const directory = changeDirectory(cwd, state.changeId);
  const eventsPath = join(directory, 'events.jsonl');
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (let number = 1; number <= 128; number += 1) {
    const previousState = state;
    resultingPlan = structuredClone(resultingPlan);
    resultingPlan.planRevision += 1;
    resultingPlan.objective = `Exercise bounded amendment ${number}.`;
    const timestamp = new Date(Date.parse(previousState.updatedAt) + 1).toISOString();
    const record = {
      schemaVersion: 1, amendmentId: `bounded-amendment-${number}`, reason: `Exercise amendment ${number}.`,
      trigger: 'operator-decision', delta: { summary: `Amendment ${number}.` },
      previousDigest: previousState.plan.effectiveDigest, newDigest: digestJson(resultingPlan),
      repositorySha: previousState.git.headSha, authorization: 'operator', invalidatedEvidence: [],
      resultingPlan, createdAt: timestamp,
    };
    const closure = { ...testMinimalClosure(previousState, resultingPlan),
      revision: 2 + previousState.plan.amendmentCount,
      previousContractDigest: previousState.scope.closureDigest,
      operatorDecisionDigests: [...previousState.scope.decisionDigests] };
    const stem = `plan/amendments/${String(number).padStart(4, '0')}`;
    const closurePath = `scope/minimal-closure/${String(closure.revision).padStart(4, '0')}.json`;
    const evidence = {
      amendmentDigest: digestJson(record), planningEvidenceDigest: digestJson([]),
      minimalClosureDigest: digestJson(closure),
    };
    const evidencePaths = {
      amendmentDigest: `${stem}.json`, planningEvidenceDigest: `${stem}.evidence.json`,
      minimalClosureDigest: closurePath,
    };
    const authoritativeEvidence = {
      amendmentDigest: { path: evidencePaths.amendmentDigest, label: `plan amendment ${number}`,
        digest: evidence.amendmentDigest, value: record },
      planningEvidenceDigest: { path: evidencePaths.planningEvidenceDigest,
        label: `plan amendment ${number} planning evidence`, digest: evidence.planningEvidenceDigest, value: [] },
      minimalClosureDigest: { path: closurePath, label: `minimal closure revision ${closure.revision}`,
        digest: evidence.minimalClosureDigest, value: closure },
    };
    state = {
      ...previousState, phase: 'ready-to-implement', revision: previousState.revision + 1,
      plan: { ...previousState.plan, revision: resultingPlan.planRevision, effectiveDigest: record.newDigest,
        amendmentCount: number, sourceCaptureDigest: resultingPlan.source.captureDigest },
      execution: previousState.execution ? { ...previousState.execution, planDigest: record.newDigest } : previousState.execution,
      source: { ...previousState.source, classification: 'unchanged' },
      git: { ...previousState.git, observedAt: timestamp },
      unresolvedDecisionIds: resultingPlan.decisions.filter(({ status }) => status !== 'resolved').map(({ id }) => id),
      checklist: resultingPlan.checklistMappings.map(({ id, checked, status, externalChange }) =>
        ({ id, checked, status, externalChange })),
      blockedReasons: [], scope: { ...previousState.scope, status: 'assessment-required',
        closureDigest: evidence.minimalClosureDigest, candidatePlanDigest: null, currentEvidenceDigest: null,
        currentBoundary: null, currentSubjectSha: null }, updatedAt: timestamp,
    };
    state.nextAction = nextActionFor(state);
    const intent = {
      schemaVersion: 1, changeId: state.changeId, revision: state.revision, type: 'plan-amended',
      summary: `Appended plan amendment ${record.amendmentId}`,
      previousStateDigest: digestJson(previousState), nextStateDigest: digestJson(state), nextState: state,
      evidence, evidencePaths, authoritativeEvidence, createdAt: timestamp,
    };
    writeReceiptJson(join(directory, evidencePaths.amendmentDigest), record);
    writeReceiptJson(join(directory, evidencePaths.planningEvidenceDigest), []);
    writeReceiptJson(join(directory, closurePath), closure);
    writeCompleteTransitionFixture(join(directory, 'transitions', String(state.revision).padStart(8, '0')), intent);
    events.push({ revision: state.revision, type: intent.type, summary: intent.summary, at: timestamp });
  }
  writeFileSync(join(directory, 'state.json'), `${JSON.stringify(state)}\n`);
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  assert.equal(state.plan.amendmentCount, 128);
  assert.equal(validateState({ cwd }).valid, true, 'receipt-valid amendment 128 is representable');

  const rejectedPlan = structuredClone(resultingPlan);
  rejectedPlan.planRevision += 1;
  rejectedPlan.objective = 'Attempt unrepresentable amendment 129.';
  const before = durableSnapshot(directory);
  assert.throws(() => amendPlan({ cwd, expectedRevision: state.revision, resultingPlan: rejectedPlan,
    amendment: { id: 'bounded-amendment-129', reason: 'Attempt amendment 129.', authorization: 'operator',
      trigger: 'operator-decision', delta: { summary: 'Amendment 129.' }, invalidatedEvidence: [] } }),
  (error) => error.code === 'AMENDMENT_LIMIT_REACHED');
  assert.deepEqual(durableSnapshot(directory), before,
    'amendment 129 creates no sidecar, receipt, event, state, or interrupted transition intent');
});

test('two same-base workers integrate by delta, resume intent-only integration, clean up, and finalize', async () => {
  const { cwd, sha } = repository('execution integration');
  const planning = await initializeState({ cwd, changeId: 'execution-change', mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning);
  plan.tasks.find(({ id }) => id === 'second-task').anticipatedPaths = ['second.txt', 'review'];
  let state = acceptPlan({ cwd, plan, expectedRevision: 0 });
  const firstPacket = packetFor(state, plan, 'state-task');
  firstPacket.forbiddenPaths = ['second.txt'];
  state = bindTask({ cwd, packet: firstPacket, expectedRevision: state.revision });
  const firstWorktree = createWorkerFixture(cwd, state, firstPacket);
  const secondPacket = packetFor(state, plan, 'second-task');
  secondPacket.allowedPaths = ['second.txt', 'review/**'];
  secondPacket.forbiddenPaths = ['review/forbidden.txt'];
  secondPacket.requiredValidation.unit = [{ command: 'node --test second.test.mjs',
    reason: 'Exercise the second task independently.' }];
  state = bindTask({ cwd, packet: secondPacket, expectedRevision: state.revision });
  const secondWorktree = createWorkerFixture(cwd, state, secondPacket);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  assert.deepEqual(state.execution.activeWave, ['state-task', 'second-task']);
  state = startTask({ cwd, taskId: 'state-task', workerId: 'worker-one', expectedRevision: state.revision });
  state = startTask({ cwd, taskId: 'second-task', workerId: 'worker-two', expectedRevision: state.revision });
  writeFileSync(join(firstWorktree.path, 'first.txt'), 'first\n'); git(firstWorktree.path, 'add', 'first.txt'); git(firstWorktree.path, 'commit', '-m', 'test: first worker');
  writeFileSync(join(secondWorktree.path, 'second.txt'), 'second\n'); git(secondWorktree.path, 'add', 'second.txt'); git(secondWorktree.path, 'commit', '-m', 'test: second worker');
  const firstCommit = git(firstWorktree.path, 'rev-parse', 'HEAD'); const secondCommit = git(secondWorktree.path, 'rev-parse', 'HEAD');
  state = acceptResult({ cwd, result: resultFor(firstPacket, 'implemented', firstCommit, ['first.txt']), workerCwd: firstWorktree.path, expectedRevision: state.revision });
  state = acceptResult({ cwd, result: resultFor(secondPacket, 'implemented', secondCommit, ['second.txt']), workerCwd: secondWorktree.path, expectedRevision: state.revision });
  git(cwd, 'switch', '-c', 'alternate-central');
  assert.throws(() => integrateTask({ cwd, taskId: 'state-task', expectedRevision: state.revision }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = integrateTask({ cwd, taskId: 'state-task', expectedRevision: state.revision });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
  assert.throws(() => integrateTask({ cwd, taskId: 'second-task', expectedRevision: state.revision,
    crashStep(step) { if (step === 'after-complete') throw new Error('intent-only stop'); } }), /intent-only stop/u);
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), state.git.headSha);
  git(cwd, 'branch', '-f', 'alternate-central', 'HEAD');
  git(cwd, 'switch', 'alternate-central');
  assert.throws(() => reconcileIntegration({ cwd, expectedRevision: loadState(cwd).revision }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = reconcileIntegration({ cwd, expectedRevision: loadState(cwd).revision });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'second-task').status, 'integrated');
  assert.equal(readFileSync(join(cwd, 'first.txt'), 'utf8'), 'first\n');
  assert.equal(readFileSync(join(cwd, 'second.txt'), 'utf8'), 'second\n');
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'state-task' });
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'second-task' });
  git(cwd, 'branch', '-f', 'alternate-central', 'HEAD');
  git(cwd, 'switch', 'alternate-central');
  assert.throws(() => finalizeIntegration({ cwd, expectedRevision: state.revision }), (error) => error.code === 'CENTRAL_GIT_MISMATCH');
  git(cwd, 'switch', 'main');
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
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
    /Allowed paths: first\.txt; forbidden paths: second\.txt/u);
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

  const changePath = changeDirectory(cwd, state.changeId);
  const closure = testMinimalClosure(planning, plan);
  const integratedEvidenceDirectory = join(changePath, 'scope', 'evidence', 'integrated-head');
  const integratedScopeEvidenceValue = readdirSync(integratedEvidenceDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(integratedEvidenceDirectory, name), 'utf8')))
    .find((value) => digestJson(value) === state.scope.currentEvidenceDigest);
  const terminalTaskSetValue = state.execution.tasks.map((task) => {
    const integrationReceipt = readdirSync(join(changePath, 'transitions'))
      .map((name) => join(changePath, 'transitions', name))
      .filter((path) => existsSync(join(path, 'complete')))
      .map((path) => ({
        intent: JSON.parse(readFileSync(join(path, 'intent.json'), 'utf8')),
        receipt: JSON.parse(readFileSync(join(path, 'receipt.json'), 'utf8')),
      }))
      .find(({ intent }) => intent.type === 'task-integrated'
        && intent.nextState.execution.tasks.some(({ id, status }) => id === task.id && status === 'integrated'));
    return {
      taskId: task.id,
      binding: task.binding,
      packetDigest: task.packetDigest,
      resultDigest: task.resultDigest,
      provenanceDigest: digestJson(JSON.parse(readFileSync(join(changePath, 'implementation', 'provenance',
        task.id, `${String(task.binding).padStart(4, '0')}.json`), 'utf8'))),
      terminalStatus: task.status,
      integratedCommit: task.integratedCommit,
      integrationReceiptDigest: digestJson(integrationReceipt.receipt),
    };
  });
  const handoff = buildDevelopmentScopeHandoff({
    changeId: state.changeId,
    headSha: state.git.headSha,
    capturedAt: '2026-08-18T12:30:00.000Z',
    acceptedPlan: { value: plan, digest: digestJson(plan) },
    effectivePlan: { value: plan, digest: digestJson(plan) },
    minimalClosure: { value: closure, digest: digestJson(closure) },
    amendments: [],
    decisions: [],
    terminalTaskSet: { value: terminalTaskSetValue, digest: taskSetDigest(terminalTaskSetValue) },
    integratedScopeEvidence: {
      value: integratedScopeEvidenceValue,
      digest: digestJson(integratedScopeEvidenceValue),
    },
  });
  const activeHandoffAuthority = { value: handoff, digest: scopeAuthorityDigest(handoff) };
  writeFileSync(join(cwd, 'first.txt'), 'first\nreview remediation\n');
  writeFileSync(join(cwd, 'second.txt'), 'second\nreview remediation\n');
  git(cwd, 'add', 'first.txt', 'second.txt');
  git(cwd, 'commit', '-m', 'test: returned review remediation');
  const resumedHeadSha = git(cwd, 'rev-parse', 'HEAD');
  const scopeReturn = {
    schemaVersion: 1,
    repository: 'owner/repository',
    prNumber: 60,
    authorityDigest: activeHandoffAuthority.digest,
    journalDigest: `sha256:${'a'.repeat(64)}`,
    blockerId: 'scope-blocker',
    decisionId: 'scope-decision',
    reviewHeadSha: resumedHeadSha,
    livePrHeadSha: resumedHeadSha,
    rootCauseId: 'scope-root',
    findingIds: ['thread:PRRT_scope'],
    findingFingerprints: ['scope-fingerprint'],
    assessmentDigest: handoff.integratedHeadAssessment.digest,
    smallestExpansion: 'Apply only the returned bounded scope change.',
    narrowAlternative: 'Retain the already accepted development authority.',
    trimAlternative: 'Remove the returned expansion.',
    inventory: {
      paths: ['first.txt', 'second.txt'], dependencies: [], publicSurfaces: [],
      persistentSurfaces: [],
      validation: ['node --test .agents/skills/change-development/scripts/state/state.test.mjs',
        'node --test second.test.mjs'],
    },
    priorDecisionIds: [],
    createdAt: '2026-08-18T12:31:00.000Z',
  };
  const beforeForeignReturn = durableSnapshot(changePath);
  git(cwd, 'switch', '-c', 'nonancestor-return', `${state.git.headSha}^`);
  writeFileSync(join(cwd, 'first.txt'), 'nonancestor review remediation\n');
  git(cwd, 'add', 'first.txt');
  git(cwd, 'commit', '-m', 'test: nonancestor returned remediation');
  const nonancestorHead = git(cwd, 'rev-parse', 'HEAD');
  assert.throws(() => resumeScopeReturn({ cwd, expectedRevision: state.revision,
    activeHandoffAuthority, scopeReturn: { ...scopeReturn,
      reviewHeadSha: nonancestorHead, livePrHeadSha: nonancestorHead } }),
  (error) => error.code === 'SCOPE_RETURN_INVALID' && /must descend from the prior development HEAD/u.test(error.message));
  assert.deepEqual(durableSnapshot(changePath), beforeForeignReturn,
    'a nonancestor returned HEAD fails before durable mutation');
  git(cwd, 'switch', 'main');
  git(cwd, 'switch', '-c', 'forbidden-return', resumedHeadSha);
  mkdirSync(join(cwd, 'review'));
  writeFileSync(join(cwd, 'review', 'forbidden.txt'), 'forbidden review remediation\n');
  git(cwd, 'add', 'review/forbidden.txt');
  git(cwd, 'commit', '-m', 'test: forbidden returned remediation');
  const forbiddenHead = git(cwd, 'rev-parse', 'HEAD');
  assert.throws(() => resumeScopeReturn({ cwd, expectedRevision: state.revision,
    activeHandoffAuthority, scopeReturn: { ...scopeReturn,
      reviewHeadSha: forbiddenHead, livePrHeadSha: forbiddenHead,
      inventory: { ...scopeReturn.inventory,
        paths: ['first.txt', 'review/forbidden.txt', 'second.txt'] } } }),
  (error) => error.code === 'SCOPE_RETURN_INVALID' && /forbidden by every matching/u.test(error.message));
  assert.deepEqual(durableSnapshot(changePath), beforeForeignReturn,
    'a forbidden returned path fails before durable mutation');
  git(cwd, 'switch', 'main');
  git(cwd, 'switch', '-c', 'unowned-return', resumedHeadSha);
  writeFileSync(join(cwd, 'unowned.txt'), 'unowned review remediation\n');
  git(cwd, 'add', 'unowned.txt');
  git(cwd, 'commit', '-m', 'test: unowned returned remediation');
  const unownedHead = git(cwd, 'rev-parse', 'HEAD');
  assert.throws(() => resumeScopeReturn({ cwd, expectedRevision: state.revision,
    activeHandoffAuthority, scopeReturn: { ...scopeReturn,
      reviewHeadSha: unownedHead, livePrHeadSha: unownedHead,
      inventory: { ...scopeReturn.inventory, paths: ['first.txt', 'second.txt', 'unowned.txt'] } } }),
  (error) => error.code === 'SCOPE_RETURN_INVALID' && /changed path is unowned/u.test(error.message));
  assert.deepEqual(durableSnapshot(changePath), beforeForeignReturn,
    'an unowned returned path fails before durable mutation');
  git(cwd, 'switch', 'main');
  assert.throws(() => resumeScopeReturn({ cwd, expectedRevision: state.revision,
    activeHandoffAuthority, scopeReturn: { ...scopeReturn, authorityDigest: `sha256:${'b'.repeat(64)}` } }),
  (error) => error.code === 'SCOPE_RETURN_INVALID');
  assert.deepEqual(durableSnapshot(changePath), beforeForeignReturn,
    'foreign same-HEAD return authority cannot advance state, sidecars, transitions, or events');
  for (const inventory of [
    { ...scopeReturn.inventory, paths: ['first.txt'] },
    { ...scopeReturn.inventory, validation: ['node --test unrepresented.test.mjs'] },
    { ...scopeReturn.inventory, paths: ['first.txt'], validation: ['node --test second.test.mjs'] },
  ]) {
    assert.throws(() => resumeScopeReturn({ cwd, expectedRevision: state.revision,
      activeHandoffAuthority, scopeReturn: { ...scopeReturn, inventory } }),
    (error) => error.code === 'SCOPE_RETURN_INVALID');
    assert.deepEqual(durableSnapshot(changePath), beforeForeignReturn,
      'unowned or unrepresented resumed authority fails before durable mutation');
  }
  state = resumeScopeReturn({ cwd, expectedRevision: state.revision, activeHandoffAuthority, scopeReturn });
  assert.equal(state.phase, 'integrated');
  assert.equal(state.scope.status, 'assessment-required');
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
    'git', '--no-replace-objects', 'diff', '--check', state.planningSha, state.verification.headSha, '--',
  ]);
  const replacementCommit = git(fixture.cwd, 'commit-tree', `${state.planningSha}^{tree}`,
    '-p', state.planningSha, '-m', 'hide committed whitespace');
  const replacementRef = `refs/replace/${state.verification.headSha}`;
  const attempted = [];
  state = runValidation({
    cwd: fixture.cwd,
    expectedRevision: state.revision,
    runner(executable, argv, options) {
      attempted.push([executable, ...argv]);
      if (executable === 'git') {
        git(fixture.cwd, 'update-ref', replacementRef, replacementCommit);
        assert.equal(spawnSync('git', [
          'diff', '--check', state.planningSha, state.verification.headSha, '--',
        ], { cwd: fixture.cwd }).status, 0,
        'the replacement would hide the whitespace from an unprotected diff');
        const result = spawnSync(executable, argv, options);
        git(fixture.cwd, 'update-ref', '-d', replacementRef);
        return result;
      }
      return { status: 0, signal: null, stdout: 'passed', stderr: '' };
    },
  });
  assert.deepEqual(attempted.find((argv) => argv[0] === 'git'), diffCommand.argv);
  assert.equal(state.verification.validationStatus, 'failed');
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', replacementRef], {
    cwd: fixture.cwd,
  }).status, 1);

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

test('receipt-backed minor and trim remediation alone may revisit terminal owner paths', async () => {
  for (const verdict of ['minor-amendment-required', 'trim-required']) {
    const fixture = await integratedSingleTaskFixture(`scope ${verdict} overlap`);
    let state = fixture.state;
    const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
    const mapping = evidence.result.coverage[0];
    const unrelatedAssessedMapping = {
      mechanism: 'unrelated-assessed.txt', sourceCriterionIds: [...mapping.sourceCriterionIds],
      acceptedCriterionIds: [...mapping.acceptedCriterionIds], invariantIds: [], nonGoalIds: [],
      guidanceIds: [], rationale: 'This separately assessed path remains required without remediation.',
    };
    evidence.packet.changeInventory.paths.push(mapping.mechanism, unrelatedAssessedMapping.mechanism);
    evidence.packet.changeInventory.mappings.push(unrelatedAssessedMapping);
    evidence.result = verdict === 'minor-amendment-required'
      ? { ...evidence.result, verdict,
        coverage: [{ ...mapping, classification: 'necessary-minor-expansion',
          rationale: 'The adjacent remediation is necessary for the existing criterion.' },
        { ...unrelatedAssessedMapping, classification: 'required' }],
        scopeDelta: { description: 'Add the exact adjacent remediation.',
          sourceCriterionIds: [...mapping.sourceCriterionIds], acceptedCriterionIds: [...mapping.acceptedCriterionIds],
          invariantIds: [], materialSurfaces: [] } }
      : { ...evidence.result, verdict,
        coverage: [{ mechanism: mapping.mechanism, sourceCriterionIds: [],
          acceptedCriterionIds: [...mapping.acceptedCriterionIds],
          invariantIds: [], nonGoalIds: [], guidanceIds: [], classification: 'speculative',
          rationale: 'The exact machinery must be simplified.' },
        { ...unrelatedAssessedMapping, classification: 'required' }],
        unnecessaryWork: [mapping.mechanism], smallerSufficientAlternative: 'Use the bounded simplification task.' };
    evidence.packetDigest = digestJson(evidence.packet);
    evidence.resultDigest = digestJson(evidence.result);
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });
    assert.equal(state.phase, 'blocked');

    const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
    const resultingPlan = structuredClone(original); resultingPlan.planRevision = 2;
    const criterionId = `${verdict}-criterion`; const taskId = `${verdict}-task`;
    const responsibility = verdict === 'minor-amendment-required'
      ? evidence.result.scopeDelta.description : evidence.result.smallerSufficientAlternative;
    resultingPlan.criteria.push({ id: criterionId, description: responsibility,
      disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    resultingPlan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply bounded scope remediation',
      objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
      dependsOn: ['state-task'], anticipatedPaths: ['first.txt'] });
    const trigger = digestJson(evidence);
    const amendment = { id: `${verdict}-amendment`, reason: 'Apply the exact receipt-backed scope verdict.',
      authorization: 'scope-review', trigger, delta: { addedTaskIds: [taskId] }, invalidatedEvidence: [trigger] };

    const unrelatedOnly = structuredClone(original);
    unrelatedOnly.planRevision = 2;
    const unrelatedOnlyCriterionId = `${verdict}-sole-unrelated-criterion`;
    const unrelatedOnlyTaskId = `${verdict}-sole-unrelated-task`;
    unrelatedOnly.criteria.push({ id: unrelatedOnlyCriterionId,
      description: 'Invent unrelated nonmaterial authority.', disposition: 'owned',
      ownerTaskId: unrelatedOnlyTaskId, deferredReason: null });
    unrelatedOnly.tasks.push({ ...original.tasks[0], id: unrelatedOnlyTaskId,
      title: 'Attempt unrelated nonmaterial work', objective: 'Perform unrelated work.',
      criterionIds: [unrelatedOnlyCriterionId], checklistItemIds: [], dependsOn: ['state-task'],
      anticipatedPaths: ['first.txt'] });
    const unrelatedOnlyBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: { ...amendment, delta: { addedTaskIds: [unrelatedOnlyTaskId] } },
      resultingPlan: unrelatedOnly }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && /lack exact assessment authority/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), unrelatedOnlyBefore,
      `${verdict} rejects a sole unrelated task and invented criterion atomically`);

    const unrelatedPathPlan = structuredClone(original);
    unrelatedPathPlan.planRevision = 2;
    const unrelatedPathCriterionId = `${verdict}-unrelated-path-criterion`;
    const unrelatedPathTaskId = `${verdict}-unrelated-path-task`;
    unrelatedPathPlan.criteria.push({ id: unrelatedPathCriterionId, description: responsibility,
      disposition: 'owned', ownerTaskId: unrelatedPathTaskId, deferredReason: null });
    unrelatedPathPlan.tasks.push({ ...original.tasks[0], id: unrelatedPathTaskId,
      title: 'Attempt unrelated assessed path', objective: responsibility,
      criterionIds: [unrelatedPathCriterionId], checklistItemIds: [], dependsOn: ['state-task'],
      anticipatedPaths: [unrelatedAssessedMapping.mechanism] });
    const unrelatedPathBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: { ...amendment, delta: { addedTaskIds: [unrelatedPathTaskId] } },
      resultingPlan: unrelatedPathPlan }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), unrelatedPathBefore,
      `${verdict} rejects copied remediation prose on another assessed inventory path atomically`);

    for (const orphanCriterion of [
      { id: `${verdict}-deferred-orphan`, description: 'Defer an unrelated criterion.',
        disposition: 'deferred', ownerTaskId: null, deferredReason: 'This is not remediation work.' },
      { id: `${verdict}-unreferenced-orphan`, description: responsibility,
        disposition: 'owned', ownerTaskId: taskId, deferredReason: null },
    ]) {
      const orphanPlan = structuredClone(resultingPlan);
      orphanPlan.criteria.push(orphanCriterion);
      const orphanBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
      assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
        amendment, resultingPlan: orphanPlan }),
      (error) => error.code === 'INVALID_AMENDMENT'
        && /must be owned and referenced by one declared new remediation task/u.test(error.message));
      assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), orphanBefore,
        `${verdict} rejects ${orphanCriterion.id} without durable mutation`);
    }

    const missingIdsBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: { ...amendment, delta: { summary: 'Omit exact remediation task authority.' } }, resultingPlan }),
    (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), missingIdsBefore,
      `${verdict} requires explicit addedTaskIds without durable mutation`);

    for (const [label, addedTaskIds] of [
      ['missing', []],
      ['duplicate', [taskId, taskId]],
      ['extra', [taskId, 'state-task']],
    ]) {
      const exactSetBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
      assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
        amendment: { ...amendment, delta: { addedTaskIds } }, resultingPlan }),
      (error) => error.code === 'INVALID_AMENDMENT', `${verdict} rejects ${label} added-task authority`);
      assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), exactSetBefore,
        `${verdict} rejects ${label} added-task authority atomically`);
    }

    const unownedPlan = structuredClone(resultingPlan);
    const unownedTaskId = `${verdict}-unowned-task`;
    unownedPlan.tasks.push({ ...original.tasks[0], id: unownedTaskId, title: 'Attempt unowned remediation',
      objective: 'Attempt remediation without a genuinely new owned criterion.', criterionIds: [original.criteria[0].id],
      checklistItemIds: [], dependsOn: ['state-task'], anticipatedPaths: ['unowned.txt'] });
    const unownedBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: { ...amendment, delta: { addedTaskIds: [taskId, unownedTaskId] } }, resultingPlan: unownedPlan }),
    (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), unownedBefore,
      `${verdict} requires every declared new task to own a genuinely new criterion`);

    const unrelatedPlan = structuredClone(resultingPlan);
    const unrelatedCriterionId = `${verdict}-unrelated-criterion`; const unrelatedTaskId = `${verdict}-unrelated-task`;
    unrelatedPlan.criteria.push({ id: unrelatedCriterionId, description: 'Attempt unrelated overlapping work.',
      disposition: 'owned', ownerTaskId: unrelatedTaskId, deferredReason: null });
    unrelatedPlan.tasks.push({ ...original.tasks[0], id: unrelatedTaskId, title: 'Attempt unrelated overlap',
      objective: 'This unrelated task must remain blocked.', criterionIds: [unrelatedCriterionId], checklistItemIds: [],
      dependsOn: ['state-task'], anticipatedPaths: ['first.txt'] });
    const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment, resultingPlan: unrelatedPlan }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && error.message.includes('complete set of newly introduced tasks'));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `${verdict} unrelated overlap is rejected without durable mutation`);
    const closureDirectory = join(changeDirectory(fixture.cwd, state.changeId), 'scope', 'minimal-closure');
    const priorClosure = readdirSync(closureDirectory).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(closureDirectory, name), 'utf8')))
      .find((candidate) => digestJson(candidate) === state.scope.closureDigest);
    const exactClosure = testMinimalClosure(state, resultingPlan, {
      revision: priorClosure.revision + 1, previousContractDigest: state.scope.closureDigest,
      operatorDecisionDigests: [...state.scope.decisionDigests],
      authorizedShape: verdict === 'trim-required'
        ? priorClosure.authorizedShape.filter((mechanism) => mechanism !== mapping.mechanism)
        : [...priorClosure.authorizedShape],
      unauthorizedExpansion: [...priorClosure.unauthorizedExpansion],
      deferredFollowups: [...priorClosure.deferredFollowups],
    });
    for (const tamperedClosure of [
      { ...exactClosure, outcome: 'Rewrite an unrelated preserved closure field.' },
      { ...exactClosure, authorizedShape: [...exactClosure.authorizedShape, 'unrelated-authority'] },
      { ...exactClosure, unauthorizedExpansion: [...exactClosure.unauthorizedExpansion, 'unrelated-unauthorized'] },
      { ...exactClosure, deferredFollowups: [...exactClosure.deferredFollowups,
        { id: 'unrelated-followup', text: 'Unrelated follow-up.' }] },
    ]) {
      const closureBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
      assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision,
        amendment, resultingPlan, minimalClosure: tamperedClosure }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID');
      assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), closureBefore,
        `${verdict} preserves unrelated closure semantics atomically`);
    }
    const reservedBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: { ...amendment, delta: { ...amendment.delta, scopeRemediation: { forged: true } } },
      resultingPlan }),
    (error) => error.code === 'INVALID_AMENDMENT' && /reserved canonical/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), reservedBefore,
      `${verdict} rejects caller-supplied scopeRemediation atomically`);
    state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision, amendment, resultingPlan });
    assert.equal(state.execution.tasks.find(({ id }) => id === taskId).status, 'unbound');
    assert.equal(state.execution.tasks.find(({ id }) => id === 'state-task').status, 'integrated');
    const stored = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId),
      'plan', 'amendments', '0001.json'), 'utf8'));
    assert.equal(stored.delta.scopeRemediation.verdict, verdict);
    assert.equal(stored.delta.scopeRemediation.evidenceDigest, trigger);
    assert.deepEqual(stored.delta.scopeRemediation.unnecessaryWork,
      verdict === 'trim-required' ? [mapping.mechanism] : []);
    assert.deepEqual(stored.delta.scopeRemediation.scopeDelta, evidence.result.scopeDelta);
    assert.equal(stored.delta.scopeRemediation.smallerSufficientAlternative,
      evidence.result.smallerSufficientAlternative);
  }
});

test('receipt-backed same-responsibility mixed minor amendments require complete branches', async () => {
  const fixture = await integratedTwoTaskFixture('mixed minor disjoint branch authority');
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const baseMapping = evidence.packet.changeInventory.mappings[0];
  const necessaryPath = 'first.txt'; const removalPath = 'second.txt/nested-removal.txt';
  const speculativeMechanism = removalPath;
  const necessaryMapping = { ...baseMapping };
  const necessaryPathMapping = { ...baseMapping, mechanism: necessaryPath,
    rationale: 'The assessed necessary path shares exact source authority.' };
  const speculativeMapping = { ...baseMapping, mechanism: speculativeMechanism,
    sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [],
    rationale: 'The citation-free mechanism is unnecessary.' };
  const necessaryResponsibility = 'Apply only the exact assessed correction.';
  const removalResponsibility = necessaryResponsibility;
  evidence.packet.changeInventory.paths = [necessaryPath, removalPath];
  evidence.packet.changeInventory.mappings = [necessaryMapping, necessaryPathMapping, speculativeMapping];
  evidence.result = { ...evidence.result, verdict: 'minor-amendment-required',
    coverage: [
      { ...necessaryMapping, classification: 'necessary-minor-expansion' },
      { ...necessaryPathMapping, classification: 'required' },
      { ...speculativeMapping, classification: 'speculative' },
    ],
    unnecessaryWork: [speculativeMechanism], smallerSufficientAlternative: removalResponsibility,
    scopeDelta: { description: necessaryResponsibility,
      sourceCriterionIds: [...baseMapping.sourceCriterionIds],
      acceptedCriterionIds: [...baseMapping.acceptedCriterionIds], invariantIds: [], materialSurfaces: [] } };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const original = JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'));
  const planFor = (includeNecessary, includeRemoval, union = false) => {
    const plan = structuredClone(original); plan.planRevision = 2;
    const addedTaskIds = [];
    if (includeNecessary) {
      plan.criteria.push({ id: 'mixed-necessary-criterion', description: necessaryResponsibility,
        disposition: 'owned', ownerTaskId: 'mixed-necessary-task', deferredReason: null });
      plan.tasks.push({ ...original.tasks[0], id: 'mixed-necessary-task', title: 'Apply necessary branch',
        objective: necessaryResponsibility, criterionIds: ['mixed-necessary-criterion'],
        decisionIds: [], checklistItemIds: [], dependsOn: ['state-task'],
        anticipatedPaths: [necessaryPath], produces: [], consumes: [] });
      addedTaskIds.push('mixed-necessary-task');
    }
    if (includeRemoval) {
      const ownerTaskId = union ? 'mixed-necessary-task' : 'mixed-removal-task';
      plan.criteria.push({ id: 'mixed-removal-criterion', description: removalResponsibility,
        disposition: 'owned', ownerTaskId, deferredReason: null });
      if (union) {
        plan.tasks.at(-1).criterionIds.push('mixed-removal-criterion');
        plan.tasks.at(-1).anticipatedPaths.push(removalPath);
      } else {
        plan.tasks.push({ ...original.tasks[1], id: ownerTaskId, title: 'Apply removal branch',
          objective: removalResponsibility, criterionIds: ['mixed-removal-criterion'],
          decisionIds: [], checklistItemIds: [], dependsOn: ['second-task'],
          anticipatedPaths: [removalPath], produces: [], consumes: [] });
        addedTaskIds.push(ownerTaskId);
      }
    }
    return { plan, addedTaskIds };
  };
  const trigger = digestJson(evidence);
  const amendmentFor = (suffix, addedTaskIds) => ({ id: `mixed-${suffix}-amendment`,
    reason: 'Apply the exact mixed-minor assessment branches.', authorization: 'scope-review', trigger,
    delta: { addedTaskIds }, invalidatedEvidence: [trigger] });
  for (const [suffix, candidate] of [
    ['necessary-only', planFor(true, false)],
    ['removal-only', planFor(false, true)],
    ['cross-branch', planFor(true, true, true)],
    ['retained-criterion-mutation', (() => {
      const candidate = planFor(true, true);
      candidate.plan.criteria[0].description = 'Mutate a retained criterion.';
      return candidate;
    })()],
    ['prior-decision-mutation', (() => {
      const candidate = planFor(true, true);
      candidate.plan.decisions[0].resolution = 'Rewrite a prior decision.';
      return candidate;
    })()],
  ]) {
    const before = durableSnapshot(directory);
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(suffix, candidate.addedTaskIds), resultingPlan: candidate.plan }),
    (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(directory), before,
      `${suffix} mixed-minor authority is rejected atomically`);
  }
  const exact = planFor(true, true);
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor('disjoint', exact.addedTaskIds), resultingPlan: exact.plan });
  assert.deepEqual(state.execution.tasks.filter(({ id }) => exact.addedTaskIds.includes(id))
    .map(({ id, status }) => ({ id, status })), exact.addedTaskIds.map((id) => ({ id, status: 'unbound' })));
});

test('interrupted recovery rejects pooled same-responsibility branch authority', async () => {
  const fixture = await integratedTwoTaskFixture('mixed branch recovery authority');
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const base = evidence.packet.changeInventory.mappings[0];
  const necessaryPath = 'first.txt'; const removalPath = 'second.txt/nested-removal.txt';
  const responsibility = 'Apply only the exact assessed correction.';
  const necessaryMapping = { ...base };
  const necessaryPathMapping = { ...base, mechanism: necessaryPath,
    rationale: 'The assessed necessary path shares exact source authority.' };
  const removalMapping = { ...base, mechanism: removalPath, sourceCriterionIds: [],
    acceptedCriterionIds: [], invariantIds: [],
    rationale: 'The citation-free mechanism is unnecessary.' };
  evidence.packet.changeInventory.paths = [necessaryPath, removalPath];
  evidence.packet.changeInventory.mappings = [necessaryMapping, necessaryPathMapping, removalMapping];
  evidence.result = { ...evidence.result, verdict: 'minor-amendment-required',
    coverage: [{ ...necessaryMapping, classification: 'necessary-minor-expansion' },
      { ...necessaryPathMapping, classification: 'required' },
      { ...removalMapping, classification: 'speculative' }],
    unnecessaryWork: [removalPath], smallerSufficientAlternative: responsibility,
    scopeDelta: { description: responsibility,
      sourceCriterionIds: [...base.sourceCriterionIds],
      acceptedCriterionIds: [...base.acceptedCriterionIds], invariantIds: [], materialSurfaces: [] } };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const original = JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'));
  const resultingPlan = structuredClone(original); resultingPlan.planRevision = 2;
  resultingPlan.criteria.push({ id: 'recovery-necessary-criterion', description: responsibility,
    disposition: 'owned', ownerTaskId: 'recovery-necessary-task', deferredReason: null },
  { id: 'recovery-removal-criterion', description: responsibility,
    disposition: 'owned', ownerTaskId: 'recovery-removal-task', deferredReason: null });
  resultingPlan.tasks.push({ ...original.tasks[0], id: 'recovery-necessary-task',
    title: 'Apply necessary recovery branch', objective: responsibility,
    criterionIds: ['recovery-necessary-criterion'], decisionIds: [], checklistItemIds: [],
    dependsOn: ['state-task'], anticipatedPaths: [necessaryPath], produces: [], consumes: [] },
  { ...original.tasks[1], id: 'recovery-removal-task', title: 'Apply removal recovery branch',
    objective: responsibility, criterionIds: ['recovery-removal-criterion'], decisionIds: [],
    checklistItemIds: [], dependsOn: ['second-task'], anticipatedPaths: [removalPath],
    produces: [], consumes: [] });
  const trigger = digestJson(evidence);
  const amendment = { id: 'mixed-branch-recovery-amendment',
    reason: 'Apply the exact complete assessment branches.', authorization: 'scope-review', trigger,
    delta: { addedTaskIds: ['recovery-necessary-task', 'recovery-removal-task'] },
    invalidatedEvidence: [trigger] };
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment, resultingPlan,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause mixed branch recovery'); } }),
  /pause mixed branch recovery/u);

  const transition = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'));
  const intentPath = join(transition, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const record = intent.authoritativeEvidence.amendmentDigest;
  const pooled = record.value.resultingPlan;
  pooled.criteria.find(({ id }) => id === 'recovery-removal-criterion').ownerTaskId =
    'recovery-necessary-task';
  const pooledTask = pooled.tasks.find(({ id }) => id === 'recovery-necessary-task');
  pooledTask.criterionIds.push('recovery-removal-criterion');
  pooledTask.anticipatedPaths.push(removalPath);
  pooledTask.dependsOn.push('second-task');
  pooled.tasks = pooled.tasks.filter(({ id }) => id !== 'recovery-removal-task');
  record.value.delta.addedTaskIds = ['recovery-necessary-task'];
  record.value.newDigest = digestJson(pooled); record.digest = digestJson(record.value);
  intent.evidence.amendmentDigest = record.digest;
  const closure = intent.authoritativeEvidence.minimalClosureDigest;
  closure.value.planDigest = record.value.newDigest; closure.digest = digestJson(closure.value);
  intent.evidence.minimalClosureDigest = closure.digest;
  writeReceiptJson(intentPath, intent);
  const before = durableSnapshot(directory);
  assert.throws(() => recoverState({ cwd: fixture.cwd }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
      && /assessment-bound remediation projection/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), before,
    'pooled same-responsibility recovery fails before durable mutation');
});

test('receipt-backed amendments require every row-local trim and minor mechanism', async () => {
  for (const verdict of ['trim-required', 'minor-amendment-required']) {
    const fixture = await integratedTwoTaskFixture(`row-local durable ${verdict}`);
    let state = fixture.state;
    const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
    const base = evidence.packet.changeInventory.mappings[0];
    const responsibility = verdict === 'trim-required'
      ? 'Remove both exact row-local mechanisms.' : 'Add both exact row-local mechanisms.';
    const rows = [
      { ...base, mechanism: 'first.txt/row-local.mjs', acceptedCriterionIds: ['durable-state'],
        rationale: 'The first mechanism is grounded by its accepted owner.' },
      { ...base, mechanism: 'second.txt/row-local.mjs',
        sourceCriterionIds: verdict === 'trim-required' ? [] : [...base.sourceCriterionIds],
        acceptedCriterionIds: verdict === 'trim-required' ? [] : ['second-change'],
        invariantIds: [], rationale: 'The second mechanism has exact row-local authority.' },
    ];
    evidence.packet.changeInventory.paths = rows.map(({ mechanism }) => mechanism);
    evidence.packet.changeInventory.mappings = rows;
    evidence.result = { ...evidence.result, verdict,
      coverage: rows.map((row) => ({ ...row,
        classification: verdict === 'trim-required' ? 'speculative' : 'necessary-minor-expansion' })),
      unnecessaryWork: verdict === 'trim-required' ? rows.map(({ mechanism }) => mechanism) : [],
      smallerSufficientAlternative: verdict === 'trim-required' ? responsibility : null,
      scopeDelta: verdict === 'minor-amendment-required' ? { description: responsibility,
        sourceCriterionIds: [...base.sourceCriterionIds],
        acceptedCriterionIds: ['durable-state', 'second-change'], invariantIds: [],
        materialSurfaces: [] } : null };
    evidence.packetDigest = digestJson(evidence.packet);
    evidence.resultDigest = digestJson(evidence.result);
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });
    const directory = changeDirectory(fixture.cwd, state.changeId);
    const original = JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'));
    const candidate = (count) => {
      const plan = structuredClone(original); plan.planRevision = 2;
      const addedTaskIds = [];
      for (let index = 0; index < count; index += 1) {
        const taskId = `row-local-${verdict}-${index}`; const criterionId = `${taskId}-criterion`;
        plan.criteria.push({ id: criterionId, description: responsibility, disposition: 'owned',
          ownerTaskId: taskId, deferredReason: null });
        plan.tasks.push({ ...original.tasks[index], id: taskId, title: `Apply row ${index + 1}`,
          objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
          dependsOn: [original.tasks[index].id], anticipatedPaths: [rows[index].mechanism],
          produces: [], consumes: [] });
        addedTaskIds.push(taskId);
      }
      return { plan, addedTaskIds };
    };
    const trigger = digestJson(evidence);
    const amendment = (suffix, addedTaskIds) => ({ id: `row-local-${verdict}-${suffix}`,
      reason: 'Apply every exact mechanism-local remediation.', authorization: 'scope-review', trigger,
      delta: { addedTaskIds }, invalidatedEvidence: [trigger] });
    const omitted = candidate(1); const before = durableSnapshot(directory);
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendment('omitted', omitted.addedTaskIds), resultingPlan: omitted.plan }),
    (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(directory), before,
      `${verdict} omission fails before receipt-backed durable mutation`);
    if (verdict === 'trim-required') {
      const borrowed = candidate(2);
      borrowed.plan.tasks.find(({ id }) => id === `row-local-${verdict}-0`).dependsOn =
        ['second-task'];
      borrowed.plan.tasks.find(({ id }) => id === `row-local-${verdict}-0`).anticipatedPaths =
        ['second.txt/unrelated-borrow.mjs'];
      const borrowingBefore = durableSnapshot(directory);
      assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
        amendment: amendment('wrong-owner-borrow', borrowed.addedTaskIds),
        resultingPlan: borrowed.plan }), (error) => error.code === 'INVALID_AMENDMENT'
          && /not linked to the assessed accepted criteria/u.test(error.message));
      assert.deepEqual(durableSnapshot(directory), borrowingBefore,
        'a citation-free sibling cannot let a cited row borrow an unrelated owner path');
    }
    const complete = candidate(2);
    state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendment('complete', complete.addedTaskIds), resultingPlan: complete.plan });
    assert.deepEqual(state.execution.tasks.filter(({ id }) => complete.addedTaskIds.includes(id))
      .map(({ status }) => status), ['unbound', 'unbound']);
  }
});

test('receipt-backed remediation replacement substitutes dependent task and producer references', async () => {
  const fixture = repository('nonmaterial dependency substitution');
  const planning = await initializeState({ cwd: fixture.cwd, changeId: 'nonmaterial-dependency-substitution',
    mode: 'implement', baseBranch: 'main', planningRef: fixture.sha, source: descriptor });
  const plan = executionPlanFor(planning);
  plan.tasks[0].anticipatedPaths = ['first.txt']; plan.tasks[0].produces = ['state-artifact'];
  plan.tasks[1].anticipatedPaths = ['second.txt']; plan.tasks[1].dependsOn = ['state-task'];
  plan.tasks[1].consumes = [{ artifactId: 'state-artifact', producerTaskId: 'state-task' }];
  plan.criteria.push({ id: 'dependency-change', description: 'Dependency remains independent.',
    disposition: 'owned', ownerTaskId: 'dependency-task', deferredReason: null });
  plan.tasks.push({ ...plan.tasks[0], id: 'dependency-task', title: 'Keep dependency',
    objective: 'Keep the independent dependency.', criterionIds: ['dependency-change'],
    checklistItemIds: [], anticipatedPaths: ['dependency.txt'], produces: [] });
  const closure = testMinimalClosure(planning, plan);
  let state = acceptPlanWithScope({ cwd: fixture.cwd, plan, minimalClosure: closure,
    scopeEvidence: testScopeEvidence(planning, plan, closure), expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTaskWithScope({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(fixture.cwd, state, packet);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: packet.taskId, workerId: 'dependency-discovery-worker',
    expectedRevision: state.revision });
  const scopeDiscovery = { schemaVersion: 1, summary: 'The task found one bounded lifecycle dependency.',
    evidence: [{ kind: 'state-path', identity: 'unowned/lifecycle.json',
      detail: 'The task needs one assessed adjacent path.' }], triggeredTripwireIds: ['test-task-paths'],
    requestedAuthority: [{ field: 'paths', values: ['unowned/lifecycle.json'] }] };
  const blocked = { ...resultFor(packet, 'blocked'), unexpectedDependencies: [scopeDiscovery.summary],
    scopeDiscovery, summary: scopeDiscovery.summary };
  state = acceptResult({ cwd: fixture.cwd, workerCwd: worker.path, expectedRevision: state.revision,
    result: blocked });
  const evidence = workerDiscoveryNonmaterialScopeEvidence(
    state, plan, closure, packet, blocked, scopeDiscovery, 'minor-amendment-required');
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  state = rejectTask({ cwd: fixture.cwd, taskId: packet.taskId,
    reason: 'Replace the assessed dependency owner.', expectedRevision: state.revision });
  removeTaskWorktree({ cwd: fixture.cwd, changeId: state.changeId, taskId: packet.taskId });
  const replacementId = 'state-task-remediation'; const newCriterionId = 'state-remediation-criterion';
  const resultingPlan = structuredClone(plan); resultingPlan.planRevision = 2;
  resultingPlan.criteria[0].ownerTaskId = replacementId;
  resultingPlan.criteria.push({ id: newCriterionId, description: evidence.result.scopeDelta.description,
    disposition: 'owned', ownerTaskId: replacementId, deferredReason: null });
  resultingPlan.tasks[0] = { ...resultingPlan.tasks[0], id: replacementId,
    objective: evidence.result.scopeDelta.description,
    criterionIds: ['durable-state', newCriterionId],
    decisionIds: [...plan.tasks[0].decisionIds], dependsOn: [] };
  resultingPlan.tasks[1].dependsOn = [replacementId];
  resultingPlan.tasks[1].consumes[0].producerTaskId = replacementId;
  resultingPlan.checklistMappings[0].taskIds = [replacementId];
  const minimalClosure = { ...structuredClone(closure), revision: 2,
    previousContractDigest: state.scope.closureDigest, planDigest: digestJson(resultingPlan),
    authorizedShape: [...closure.authorizedShape, 'unowned-lifecycle-path'] };
  const trigger = state.scope.currentEvidenceDigest;
  const suffix = `${packet.taskId}/0001.json`;
  const continuityPlan = structuredClone(resultingPlan);
  const continuityId = 'dependency-continuity';
  continuityPlan.tasks = continuityPlan.tasks.filter(({ id }) => id !== 'dependency-task');
  continuityPlan.criteria.find(({ id }) => id === 'dependency-change').ownerTaskId = continuityId;
  continuityPlan.criteria.push({ ...plan.criteria.find(({ id }) => id === 'dependency-change'),
    id: 'dependency-change-copy', ownerTaskId: continuityId });
  continuityPlan.tasks.find(({ id }) => id === replacementId).dependsOn = [continuityId];
  continuityPlan.tasks.push({ ...plan.tasks.find(({ id }) => id === 'dependency-task'),
    id: continuityId, criterionIds: ['dependency-change', 'dependency-change-copy'],
    dependsOn: [replacementId] });
  const continuityBefore = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision,
    resultingPlan: continuityPlan, minimalClosure: { ...structuredClone(closure), revision: 2,
      previousContractDigest: state.scope.closureDigest, planDigest: digestJson(continuityPlan),
      authorizedShape: [...closure.authorizedShape, 'unowned-lifecycle-path'] },
    amendment: { id: 'changed-continuity-edge-amendment',
      reason: 'Continuity cannot invent a dependency edge.', authorization: 'scope-review', trigger,
      delta: { addedTaskIds: [replacementId, continuityId] }, invalidatedEvidence: [trigger,
        `implementation/tasks/${suffix}`, `implementation/provenance/${suffix}`,
        `implementation/planning-signals/${suffix}`, `implementation/specialist-routes/${suffix}`,
        `implementation/results/${suffix}`] } }),
  (error) => error.code === 'INVALID_AMENDMENT'
    && /must preserve dependency edges/u.test(error.message));
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), continuityBefore,
    'a continuity edge change fails before durable receipts or state mutate');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision,
    resultingPlan, minimalClosure, amendment: { id: 'dependency-substitution-amendment',
      reason: 'Replace the assessed owner while preserving dependent graph references.',
      authorization: 'scope-review', trigger, delta: { addedTaskIds: [replacementId] },
      invalidatedEvidence: [trigger, `implementation/tasks/${suffix}`,
        `implementation/provenance/${suffix}`, `implementation/planning-signals/${suffix}`,
        `implementation/specialist-routes/${suffix}`, `implementation/results/${suffix}`] } });
  assert.equal(state.execution.tasks.find(({ id }) => id === 'second-task').status, 'unbound');
  assert.equal(state.execution.tasks.find(({ id }) => id === replacementId).status, 'unbound');
});

test('durable assessed replacements preserve substituted edges and recovery revalidates them', async () => {
  const fixture = repository('durable assessed replacement edges');
  const planning = await initializeState({ cwd: fixture.cwd,
    changeId: 'durable-assessed-replacement-edges', mode: 'implement', baseBranch: 'main',
    planningRef: fixture.sha, source: descriptor });
  const plan = executionPlanFor(planning);
  plan.decisions.push({ id: 'unrelated-decision', question: 'Unrelated?',
    rationale: 'Remain outside the assessed rows.', status: 'resolved', resolution: 'No.' });
  plan.tasks[0].anticipatedPaths = ['first.txt']; plan.tasks[0].produces = ['artifact'];
  plan.tasks[1].anticipatedPaths = ['second.txt']; plan.tasks[1].dependsOn = ['state-task'];
  plan.tasks[1].consumes = [{ artifactId: 'artifact', producerTaskId: 'state-task' }];
  plan.criteria.push({ id: 'extra-change', description: 'Extra task remains independent.',
    disposition: 'owned', ownerTaskId: 'extra-task', deferredReason: null });
  plan.tasks.push({ ...plan.tasks[0], id: 'extra-task', title: 'Keep extra task',
    objective: 'Keep the extra task.', criterionIds: ['extra-change'], checklistItemIds: [],
    decisionIds: ['unrelated-decision'], anticipatedPaths: ['extra.txt'], produces: [] });
  let state = acceptPlan({ cwd: fixture.cwd, plan, expectedRevision: planning.revision });
  const packet = packetFor(state, plan, 'state-task');
  state = bindTask({ cwd: fixture.cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(fixture.cwd, state, packet);
  state = scheduleWave({ cwd: fixture.cwd, expectedRevision: state.revision });
  state = startTask({ cwd: fixture.cwd, taskId: packet.taskId,
    workerId: 'assessed-edge-discovery-worker', expectedRevision: state.revision });
  const scopeDiscovery = { schemaVersion: 1, summary: 'The graph owner found bounded remediation.',
    evidence: [{ kind: 'state-path', identity: 'first.txt/assessed.mjs',
      detail: 'Both adjacent graph owners require exact assessed replacement.' }],
    triggeredTripwireIds: ['test-task-paths'],
    requestedAuthority: [{ field: 'paths', values: ['first.txt/assessed.mjs'] }] };
  const blocked = { ...resultFor(packet, 'blocked'), unexpectedDependencies: [scopeDiscovery.summary],
    scopeDiscovery, summary: scopeDiscovery.summary };
  state = acceptResult({ cwd: fixture.cwd, workerCwd: worker.path,
    expectedRevision: state.revision, result: blocked });
  const evidence = workerDiscoveryNonmaterialScopeEvidence(
    state, plan, testMinimalClosure(planning, plan), packet, blocked, scopeDiscovery, 'trim-required');
  const base = evidence.packet.changeInventory.mappings.at(-1);
  const responsibility = 'Replace both assessed graph owners.';
  const rows = [
    { ...base, mechanism: 'first.txt/assessed.mjs', acceptedCriterionIds: ['durable-state'] },
    { ...base, mechanism: 'second.txt/assessed.mjs', acceptedCriterionIds: ['second-change'] },
  ];
  evidence.packet.changeInventory.paths = rows.map(({ mechanism }) => mechanism);
  evidence.packet.changeInventory.mappings = rows;
  evidence.result = { ...evidence.result, verdict: 'trim-required',
    coverage: rows.map((row) => ({ ...row, classification: 'speculative' })),
    unnecessaryWork: rows.map(({ mechanism }) => mechanism),
    smallerSufficientAlternative: responsibility, scopeDelta: null };
  evidence.packetDigest = digestJson(evidence.packet); evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  state = rejectTask({ cwd: fixture.cwd, taskId: packet.taskId,
    reason: 'Replace both assessed graph owners.', expectedRevision: state.revision });
  removeTaskWorktree({ cwd: fixture.cwd, changeId: state.changeId, taskId: packet.taskId });
  const exact = () => {
    const result = structuredClone(plan); result.planRevision = 2;
    result.criteria.find(({ id }) => id === 'durable-state').ownerTaskId = 'first-replacement';
    result.criteria.find(({ id }) => id === 'second-change').ownerTaskId = 'second-replacement';
    result.criteria.push({ id: 'first-replacement-new', description: responsibility,
      disposition: 'owned', ownerTaskId: 'first-replacement', deferredReason: null },
    { id: 'second-replacement-new', description: responsibility,
      disposition: 'owned', ownerTaskId: 'second-replacement', deferredReason: null });
    result.tasks[0] = { ...plan.tasks[0], id: 'first-replacement', objective: responsibility,
      criterionIds: ['durable-state', 'first-replacement-new'],
      checklistItemIds: [...plan.tasks[0].checklistItemIds],
      anticipatedPaths: [rows[0].mechanism], decisionIds: [...plan.tasks[0].decisionIds], dependsOn: [] };
    result.tasks[1] = { ...plan.tasks[1], id: 'second-replacement', objective: responsibility,
      criterionIds: ['second-change', 'second-replacement-new'], checklistItemIds: [],
      anticipatedPaths: [rows[1].mechanism], decisionIds: [...plan.tasks[1].decisionIds],
      dependsOn: ['first-replacement'],
      consumes: [{ artifactId: 'artifact', producerTaskId: 'first-replacement' }] };
    result.checklistMappings[0].taskIds = ['first-replacement'];
    return result;
  };
  const trigger = digestJson(evidence);
  const suffix = `${packet.taskId}/0001.json`;
  const invalidatedEvidence = [trigger, `implementation/tasks/${suffix}`,
    `implementation/provenance/${suffix}`, `implementation/planning-signals/${suffix}`,
    `implementation/specialist-routes/${suffix}`, `implementation/results/${suffix}`];
  const amendmentFor = (id) => ({ id, reason: 'Replace both assessed owners exactly.',
    authorization: 'scope-review', trigger,
    delta: { addedTaskIds: ['first-replacement', 'second-replacement'] }, invalidatedEvidence });
  for (const [label, mutate, pattern] of [
    ['inherited-decision', (candidate) => {
      candidate.tasks.find(({ id }) => id === 'second-replacement').decisionIds = [];
    }, /retain complete exact ordered inherited decisionIds without duplicates/u],
    ['task-order', (candidate) => {
      [candidate.tasks[0], candidate.tasks[1]] = [candidate.tasks[1], candidate.tasks[0]];
    }, /preserve the exact prior task-order backbone through replacements/u],
    ['dependency', (candidate) => {
      candidate.tasks.find(({ id }) => id === 'second-replacement').dependsOn = [];
    },
      /must preserve prior dependency edges/u],
    ['consume', (candidate) => {
      candidate.tasks.find(({ id }) => id === 'second-replacement').consumes = [];
    },
      /must preserve prior consume edges/u],
    ['decision', (candidate) => {
      const task = candidate.tasks.find(({ id }) => id === 'second-replacement');
      task.decisionIds = [...task.decisionIds, 'unrelated-decision'];
    }, /decisionIds exceed its exact assessed rows/u],
    ['specialization', (candidate) => {
      candidate.tasks.find(({ id }) => id === 'second-replacement').specialization =
        behaviorSpecialization();
    }, /specialization must equal its exact row-local authority/u],
    ['unsplittable', (candidate) => {
      candidate.tasks.find(({ id }) => id === 'second-replacement').unsplittable = {
        reason: 'Invent assessed replacement authority.', serializedDomains: ['workflow'],
        highestRiskSpecialization: 'ops-workflow' };
    }, /unsplittable must equal its exact row-local owner authority/u],
  ]) {
    const candidate = exact(); mutate(candidate); const before = durableSnapshot(
      changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(`drop-assessed-${label}`), resultingPlan: candidate }),
    (error) => error.code === 'INVALID_AMENDMENT' && pattern.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `dropping the substituted ${label} edge fails before durable mutation`);
  }
  const accepted = exact();
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor('preserve-assessed-edges'), resultingPlan: accepted,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause assessed edge recovery'); } }),
  /pause assessed edge recovery/u,
  'the exact substituted graph passes durable admission');
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const transition = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'));
  const intentPath = join(transition, 'intent.json');
  const pristineIntent = JSON.parse(readFileSync(intentPath, 'utf8'));
  for (const [label, mutate] of [
    ['inherited decision loss', (task) => { task.decisionIds = []; }],
    ['task-order drift', (unused, plan) => {
      [plan.tasks[0], plan.tasks[1]] = [plan.tasks[1], plan.tasks[0]];
    }],
    ['consume-edge removal', (task) => { task.consumes = []; }],
    ['unrelated decision', (task) => { task.decisionIds.push('unrelated-decision'); }],
    ['foreign specialization', (task) => { task.specialization = behaviorSpecialization(); }],
    ['invented unsplittable authority', (task) => {
      task.unsplittable = { reason: 'Invent assessed recovery authority.',
        serializedDomains: ['workflow'], highestRiskSpecialization: 'ops-workflow' };
    }],
  ]) {
    const intent = structuredClone(pristineIntent);
    const record = intent.authoritativeEvidence.amendmentDigest;
    const plan = record.value.resultingPlan;
    mutate(plan.tasks.find(({ id }) => id === 'second-replacement'), plan);
    record.value.newDigest = digestJson(plan); record.digest = digestJson(record.value);
    intent.evidence.amendmentDigest = record.digest;
    const closure = intent.authoritativeEvidence.minimalClosureDigest;
    closure.value.planDigest = record.value.newDigest; closure.digest = digestJson(closure.value);
    intent.evidence.minimalClosureDigest = closure.digest; writeReceiptJson(intentPath, intent);
    const beforeRecovery = durableSnapshot(directory);
    assert.throws(() => recoverState({ cwd: fixture.cwd }),
      (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
        && /assessment-bound remediation projection/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), beforeRecovery,
      `recovery rejects receipt-consistent assessed ${label} atomically`);
  }
});

// Current packet binding requires at least one acceptance criterion, so a fresh worker discovery
// cannot originate this historical zero-owned-criterion plan shape. Receipt-bound validator evidence
// keeps its recovery semantics covered without pretending this is a current full lifecycle fixture.
test('receipt-backed criterionless replacement preserves exact durable selection evidence', () => {
  const responsibility = 'Replace the criterionless discovery.';
  const path = 'discovery/exact.json';
  const mapping = { mechanism: path, sourceCriterionIds: [], acceptedCriterionIds: [],
    invariantIds: [] };
  const discovery = { id: 'discovery-task', objective: 'Discover scope.', criterionIds: [],
    anticipatedPaths: ['discovery'], dependsOn: [], produces: ['artifact'], consumes: [] };
  const dependent = { id: 'dependent', objective: 'Use discovery.', criterionIds: ['dependent'],
    anticipatedPaths: ['dependent'], dependsOn: ['discovery-task'], produces: [],
    consumes: [{ artifactId: 'artifact', producerTaskId: 'discovery-task' }] };
  const priorPlan = { criteria: [{ id: 'dependent', description: 'Use discovery.',
    disposition: 'owned', ownerTaskId: 'dependent', deferredReason: null }],
  tasks: [discovery, dependent], checklistMappings: [{ id: 'check', taskIds: ['discovery-task'] }],
  decisions: [] };
  const evidence = { result: { verdict: 'trim-required', unnecessaryWork: [path],
    smallerSufficientAlternative: responsibility,
    coverage: [{ ...mapping, classification: 'speculative' }] },
  packet: { changeInventory: { paths: [path], mappings: [mapping] } },
  cadence: { trigger: 'worker-scope-discovery:discovery-task:result:receipt' } };
  const replacement = (id) => ({ id, objective: responsibility, criterionIds: [`${id}-criterion`],
    anticipatedPaths: [path], dependsOn: [], produces: ['artifact'], consumes: [] });
  const plan = (ids, selected = ids[0], { graph = true, checklist = true } = {}) => ({
    criteria: [priorPlan.criteria[0], ...ids.map((id) => ({ id: `${id}-criterion`,
      description: responsibility, disposition: 'owned', ownerTaskId: id, deferredReason: null }))],
    tasks: [...ids.map(replacement), { ...dependent, dependsOn: graph ? [selected] : [],
      consumes: graph ? [{ artifactId: 'artifact', producerTaskId: selected }] : [] }],
    checklistMappings: checklist ? [{ id: 'check', taskIds: [selected] }] : [],
    decisions: [],
  });
  const graph = plan(['graph', 'graph-near']);
  graph.tasks.find(({ id }) => id === 'graph-near').dependsOn = ['graph'];
  graph.tasks.find(({ id }) => id === 'graph-near').produces = [];
  const checklistPrior = structuredClone(priorPlan);
  checklistPrior.tasks[1].dependsOn = []; checklistPrior.tasks[1].consumes = [];
  const checklist = plan(['checklist', 'checklist-near'], 'checklist', { graph: false });
  checklist.tasks.find(({ id }) => id === 'checklist-near').dependsOn = ['checklist'];
  checklist.tasks.find(({ id }) => id === 'checklist-near').produces = [];
  const noIncomingPrior = { ...structuredClone(priorPlan), tasks: [discovery],
    criteria: [], checklistMappings: [] };
  const ambiguous = { criteria: ['first', 'second'].map((id) => ({ id: `${id}-criterion`,
    description: responsibility, disposition: 'owned', ownerTaskId: id, deferredReason: null })),
    tasks: ['first', 'second'].map(replacement), checklistMappings: [], decisions: [] };
  const separatePath = 'separate/exact.json';
  const separatedEvidence = structuredClone(evidence);
  const separateMapping = { ...mapping, mechanism: separatePath, sourceCriterionIds: ['source'] };
  separatedEvidence.packet.changeInventory.paths.push(separatePath);
  separatedEvidence.packet.changeInventory.mappings.push(separateMapping);
  separatedEvidence.result.coverage.push({ ...separateMapping, classification: 'speculative' });
  separatedEvidence.result.unnecessaryWork.push(separatePath);
  const separatedPrior = { ...structuredClone(priorPlan), tasks: [discovery], criteria: [],
    checklistMappings: [] };
  const separated = { criteria: ['owned-replacement', 'separate-remediation'].map((id) => ({
    id: `${id}-criterion`, description: responsibility, disposition: 'owned', ownerTaskId: id,
    deferredReason: null })), tasks: [replacement('owned-replacement'),
    { ...replacement('separate-remediation'), anticipatedPaths: [separatePath] }],
  checklistMappings: [], decisions: [] };
  separated.tasks[1].produces = [];
  const absent = plan(['absent']); absent.tasks.find(({ id }) => id === 'absent').produces = [];
  const foreignCriterion = plan(['foreign-owner']);
  foreignCriterion.tasks.find(({ id }) => id === 'foreign-owner').criterionIds.push('dependent');
  const retainedDiscovery = plan(['retained-discovery']);
  retainedDiscovery.tasks[0] = structuredClone(dependent);
  retainedDiscovery.tasks.unshift(structuredClone(discovery));
  retainedDiscovery.checklistMappings = structuredClone(priorPlan.checklistMappings);
  const unrelatedPrior = structuredClone(priorPlan);
  unrelatedPrior.tasks.push({ id: 'unrelated-ownerless', objective: 'Unrelated.',
    criterionIds: [], anticipatedPaths: ['unrelated'], dependsOn: [], produces: [], consumes: [] });
  const rows = [
    ['unique', evidence, priorPlan, plan(['unique']), ['unique'], null],
    ['absent', evidence, priorPlan, absent, ['absent'], /lacks one exact replacement/u],
    ['foreign-owner', evidence, priorPlan, foreignCriterion, ['foreign-owner'],
      /criterionIds must equal its exact resulting owned criteria/u],
    ['retained-discovery', evidence, priorPlan, retainedDiscovery, ['retained-discovery'],
      /must be removed and replaced exactly/u],
    ['wrong-cadence', { ...evidence, cadence: { trigger:
      'worker-scope-discovery:wrong-task:result:wrong' } }, priorPlan, plan(['wrong-cadence']),
    ['wrong-cadence'], /lacks one exact replacement/u],
    ['unrelated', evidence, unrelatedPrior, plan(['unique']), ['unique'],
      /removed task unrelated-ownerless lacks one exact replacement/u],
    ['ambiguous', evidence, noIncomingPrior, ambiguous, ['first', 'second'],
      /replacement is ambiguous/u],
    ['graph-selected', evidence, priorPlan, graph, ['graph', 'graph-near'], null],
    ['checklist-selected', evidence, checklistPrior, checklist,
      ['checklist', 'checklist-near'], null],
    ['path-owned-selection', separatedEvidence, separatedPrior, separated,
      ['owned-replacement', 'separate-remediation'], null],
  ];
  const directory = mkdtempSync(join(tmpdir(), 'criterionless-receipts '));
  for (const [label, rowEvidence, rowPrior, resultingPlan, addedTaskIds, expected] of rows) {
    const value = { evidence: rowEvidence, priorPlan: rowPrior, resultingPlan, addedTaskIds };
    const pathName = join(directory, `${label}.json`);
    writeReceiptJson(pathName, value);
    const stored = JSON.parse(readFileSync(pathName, 'utf8'));
    assert.equal(readFileSync(pathName.slice(0, -5) + '.sha256', 'utf8').trim(),
      digestJson(stored), `${label} fixture retains exact receipt identity`);
    const errors = validateNonmaterialAmendmentTaskAuthority(stored);
    if (expected === null) assert.deepEqual(errors, [], `${label} receipt is admitted`);
    else assert.match(errors.join('\n'), expected, `${label} receipt fails closed`);
  }
  const tamperedPath = join(directory, 'unique.json');
  const tampered = JSON.parse(readFileSync(tamperedPath, 'utf8'));
  tampered.resultingPlan.checklistMappings[0].taskIds = ['missing'];
  writeFileSync(tamperedPath, `${JSON.stringify(tampered)}\n`);
  assert.notEqual(readFileSync(tamperedPath.slice(0, -5) + '.sha256', 'utf8').trim(),
    digestJson(tampered), 'receipt-consistent recovery cannot adopt tampered selection evidence');
});

test('receipt-backed minor remediation derives paths from exact source and invariant authority', async () => {
  for (const grounding of ['source', 'invariant']) {
    const fixture = await integratedSingleTaskFixture(`minor ${grounding} mapped path authority`);
    let state = fixture.state;
    const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
    const originalMapping = evidence.packet.changeInventory.mappings[0];
    const authorityId = grounding === 'source' ? originalMapping.sourceCriterionIds[0] : 'exact-test-authority';
    const groundingFields = grounding === 'source'
      ? { sourceCriterionIds: [authorityId], invariantIds: [] }
      : { sourceCriterionIds: [], invariantIds: [authorityId] };
    const necessaryMapping = { ...originalMapping, ...groundingFields };
    const eligibleMapping = { ...necessaryMapping,
      mechanism: `${grounding}-grounded-remediation.txt`,
      rationale: `This assessed path shares the exact ${grounding} authority.` };
    const unrelatedMapping = { ...originalMapping,
      mechanism: `${grounding}-unrelated-remediation.txt`,
      sourceCriterionIds: grounding === 'invariant' ? [...originalMapping.sourceCriterionIds] : [],
      acceptedCriterionIds: [], invariantIds: grounding === 'source' ? ['exact-test-authority'] : [],
      rationale: 'The unrelated assessed path shares no affirmative authority.' };
    evidence.packet.changeInventory.paths.push(eligibleMapping.mechanism, unrelatedMapping.mechanism);
    evidence.packet.changeInventory.mappings = [necessaryMapping, eligibleMapping, unrelatedMapping];
    evidence.result = { ...evidence.result, verdict: 'minor-amendment-required',
      coverage: [
        { ...necessaryMapping, classification: 'necessary-minor-expansion',
          rationale: `The adjacent mechanism is necessary under the exact ${grounding} authority.` },
        { ...eligibleMapping, classification: 'required' },
        { ...unrelatedMapping, classification: 'required' },
      ],
      scopeDelta: { description: `Add the exact ${grounding}-grounded remediation.`,
        sourceCriterionIds: grounding === 'source' ? [authorityId] : [],
        acceptedCriterionIds: [...originalMapping.acceptedCriterionIds],
        invariantIds: grounding === 'invariant' ? [authorityId] : [], materialSurfaces: [] } };
    evidence.packetDigest = digestJson(evidence.packet);
    evidence.resultDigest = digestJson(evidence.result);
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });
    assert.equal(state.phase, 'blocked');

    const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
    const responsibility = evidence.result.scopeDelta.description;
    const planForPath = (path, suffix) => {
      const plan = structuredClone(original); plan.planRevision = 2;
      const criterionId = `${grounding}-${suffix}-criterion`; const taskId = `${grounding}-${suffix}-task`;
      plan.criteria.push({ id: criterionId, description: responsibility,
        disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
      plan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply grounded remediation',
        objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
        dependsOn: ['state-task'], anticipatedPaths: [path] });
      return { plan, taskId };
    };
    const trigger = digestJson(evidence);
    const amendmentFor = (taskId) => ({ id: `${taskId}-amendment`,
      reason: `Apply only the exact ${grounding}-grounded path authority.`,
      authorization: 'scope-review', trigger, delta: { addedTaskIds: [taskId] },
      invalidatedEvidence: [trigger] });

    const rejected = planForPath(unrelatedMapping.mechanism, 'accepted-only');
    const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(rejected.taskId), resultingPlan: rejected.plan }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `${grounding} grounding rejects a path without shared affirmative authority`);

    const accepted = planForPath(eligibleMapping.mechanism, 'eligible');
    state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(accepted.taskId), resultingPlan: accepted.plan });
    assert.equal(state.execution.tasks.find(({ id }) => id === accepted.taskId).status, 'unbound');
  }
});

test('minor remediation inherits only accepted criteria cited by coverage and scope delta', async () => {
  const fixture = await integratedTwoTaskFixture('minor strict accepted criterion authority');
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const inventoryMapping = evidence.packet.changeInventory.mappings[0];
  evidence.packet.changeInventory.mappings[0] = { ...inventoryMapping,
    acceptedCriterionIds: ['durable-state', 'second-change'] };
  evidence.result = { ...evidence.result, verdict: 'minor-amendment-required',
    coverage: [{ ...evidence.result.coverage[0], classification: 'necessary-minor-expansion',
      acceptedCriterionIds: ['durable-state'], rationale: 'Only the first accepted criterion needs remediation.' }],
    scopeDelta: { description: 'Apply only the first criterion remediation.',
      sourceCriterionIds: [...inventoryMapping.sourceCriterionIds], acceptedCriterionIds: ['durable-state'],
      invariantIds: [], materialSurfaces: [] } };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });

  const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
  const responsibility = evidence.result.scopeDelta.description;
  const planForOwner = (ownerTaskId, path, suffix) => {
    const plan = structuredClone(original); plan.planRevision = 2;
    const criterionId = `strict-${suffix}-criterion`; const taskId = `strict-${suffix}-task`;
    plan.criteria.push({ id: criterionId, description: responsibility,
      disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    plan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply strict criterion remediation',
      objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
      dependsOn: [ownerTaskId], anticipatedPaths: [path] });
    return { plan, taskId };
  };
  const trigger = digestJson(evidence);
  const amendmentFor = (taskId) => ({ id: `${taskId}-amendment`, reason: 'Use only cited accepted authority.',
    authorization: 'scope-review', trigger, delta: { addedTaskIds: [taskId] }, invalidatedEvidence: [trigger] });
  const rejected = planForOwner('second-task', 'second.txt', 'uncited');
  const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor(rejected.taskId), resultingPlan: rejected.plan }),
  (error) => error.code === 'INVALID_AMENDMENT'
    && /is not linked to the assessed accepted criteria/u.test(error.message));
  assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
    'an inventory-only accepted criterion cannot over-inherit its terminal owner path');

  const accepted = planForOwner('state-task', 'first.txt', 'cited');
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor(accepted.taskId), resultingPlan: accepted.plan });
  assert.equal(state.execution.tasks.find(({ id }) => id === accepted.taskId).status, 'unbound');
});

test('citation-free trim paths require assessed inventory and an explicit owning dependency', async () => {
  const ownerPath = 'owned/subtree'; const otherOwnerPath = 'other/subtree';
  const trimPath = `${ownerPath}/nested.txt`;
  const sameOwnerSiblingPath = `${ownerPath}/required-sibling.txt`;
  const reversedPath = 'owned';
  const prefixCollisionPath = 'owned/subtree-other/nested.txt';
  const unrelatedOwnerPath = `${otherOwnerPath}/nested.txt`;
  const fixture = await integratedTwoTaskFixture('citation free trim path authority',
    [ownerPath, otherOwnerPath]);
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const trimMechanism = trimPath;
  const inventoryMapping = { ...evidence.packet.changeInventory.mappings[0], mechanism: trimMechanism };
  const assessedMappings = [
    { path: sameOwnerSiblingPath, criterionId: 'durable-state' },
    { path: reversedPath, criterionId: 'durable-state' },
    { path: prefixCollisionPath, criterionId: 'durable-state' },
    { path: unrelatedOwnerPath, criterionId: 'second-change' },
  ].map(({ path, criterionId }) => ({ ...inventoryMapping, mechanism: path, sourceCriterionIds: [],
    acceptedCriterionIds: [criterionId], rationale: `${path} remains separately assessed.` }));
  evidence.packet.changeInventory.paths = [trimPath, ...assessedMappings.map(({ mechanism }) => mechanism)];
  evidence.packet.changeInventory.mappings = [inventoryMapping, ...assessedMappings];
  evidence.result = { ...evidence.result, verdict: 'trim-required',
    coverage: [{ ...inventoryMapping, sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: [],
      classification: 'speculative', rationale: 'Remove the citation-free logical mechanism.' },
    ...assessedMappings.map((mapping) => ({ ...mapping, classification: 'required' }))],
    unnecessaryWork: [trimMechanism], smallerSufficientAlternative: 'Remove only the assessed nested path.' };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });

  const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
  const responsibility = evidence.result.smallerSufficientAlternative;
  const planForPath = (path, dependsOn, suffix) => {
    const plan = structuredClone(original); plan.planRevision = 2;
    const criterionId = `trim-${suffix}-criterion`; const taskId = `trim-${suffix}-task`;
    plan.criteria.push({ id: criterionId, description: responsibility,
      disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    plan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply citation-free trim',
      objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
      dependsOn, anticipatedPaths: [path] });
    return { plan, taskId };
  };
  const trigger = digestJson(evidence);
  const amendmentFor = (taskId) => ({ id: `${taskId}-amendment`, reason: 'Trim only the assessed owned path.',
    authorization: 'scope-review', trigger, delta: { addedTaskIds: [taskId] }, invalidatedEvidence: [trigger] });
  for (const [suffix, path, dependsOn] of [
    ['missing-owner', trimPath, []],
    ['unassessed', `${ownerPath}/other.txt`, ['state-task']],
    ['same-owner-required-sibling', sameOwnerSiblingPath, ['state-task']],
    ['reversed', reversedPath, ['state-task']],
    ['prefix-collision', prefixCollisionPath, ['state-task']],
    ['unrelated-owner', unrelatedOwnerPath, ['state-task']],
  ]) {
    const rejected = planForPath(path, dependsOn, suffix);
    const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(rejected.taskId), resultingPlan: rejected.plan }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `${suffix} citation-free trim authority is rejected atomically`);
  }

  const accepted = planForPath(trimPath, ['state-task'], 'owned');
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor(accepted.taskId), resultingPlan: accepted.plan });
  assert.equal(state.execution.tasks.find(({ id }) => id === accepted.taskId).status, 'unbound');
});

test('receipt-backed removal paths derive exact source and invariant authority', async () => {
  for (const grounding of ['source', 'invariant']) {
    const fixture = await integratedSingleTaskFixture(`removal ${grounding} mapped path authority`);
    let state = fixture.state;
    const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
    const baseMapping = evidence.packet.changeInventory.mappings[0];
    const authorityId = grounding === 'source' ? baseMapping.sourceCriterionIds[0] : 'exact-test-authority';
    const authority = grounding === 'source'
      ? { sourceCriterionIds: [authorityId], invariantIds: [] }
      : { sourceCriterionIds: [], invariantIds: [authorityId] };
    const mechanism = `${grounding}-grounded-removal`;
    const removalMapping = { ...baseMapping, ...authority, mechanism,
      acceptedCriterionIds: [], rationale: `Remove the exact ${grounding}-grounded mechanism.` };
    const eligibleMapping = { ...removalMapping, mechanism: `${grounding}-grounded-removal.txt`,
      rationale: `This assessed path shares the exact ${grounding} authority.` };
    const unrelatedMapping = { ...removalMapping, mechanism: `${grounding}-unrelated-removal.txt`,
      sourceCriterionIds: [], acceptedCriterionIds: [...baseMapping.acceptedCriterionIds], invariantIds: [],
      rationale: 'This assessed path has unrelated authority.' };
    evidence.packet.changeInventory.paths = [eligibleMapping.mechanism, unrelatedMapping.mechanism];
    evidence.packet.changeInventory.mappings = [removalMapping, eligibleMapping, unrelatedMapping];
    evidence.result = { ...evidence.result, verdict: 'trim-required',
      coverage: [{ ...removalMapping, classification: 'speculative' },
        { ...eligibleMapping, classification: 'required' },
        { ...unrelatedMapping, classification: 'required' }],
      unnecessaryWork: [mechanism],
      smallerSufficientAlternative: `Remove only the exact ${grounding}-grounded path.` };
    evidence.packetDigest = digestJson(evidence.packet);
    evidence.resultDigest = digestJson(evidence.result);
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });

    const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId),
      'plan', 'plan.json'), 'utf8'));
    const responsibility = evidence.result.smallerSufficientAlternative;
    const planForPath = (path, suffix) => {
      const plan = structuredClone(original); plan.planRevision = 2;
      const criterionId = `${grounding}-${suffix}-removal-criterion`;
      const taskId = `${grounding}-${suffix}-removal-task`;
      plan.criteria.push({ id: criterionId, description: responsibility,
        disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
      plan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply grounded removal',
        objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
        dependsOn: [],
        anticipatedPaths: [path] });
      return { plan, taskId };
    };
    const trigger = digestJson(evidence);
    const amendmentFor = (taskId) => ({ id: `${taskId}-amendment`,
      reason: `Use only exact ${grounding}-grounded removal authority.`, authorization: 'scope-review',
      trigger, delta: { addedTaskIds: [taskId] }, invalidatedEvidence: [trigger] });
    const rejected = planForPath(unrelatedMapping.mechanism, 'unrelated');
    const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(rejected.taskId), resultingPlan: rejected.plan }),
    (error) => error.code === 'INVALID_AMENDMENT');
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `${grounding}-unrelated removal path is rejected atomically`);
    const accepted = planForPath(eligibleMapping.mechanism, 'eligible');
    state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(accepted.taskId), resultingPlan: accepted.plan });
    assert.equal(state.execution.tasks.find(({ id }) => id === accepted.taskId).status, 'unbound');
  }
});

test('receipt-backed inherited remediation paths are directional and segment bounded', async () => {
  const inheritedPath = 'owned/subtree';
  const fixture = await integratedSingleTaskFixture('minor inherited path containment', specialization(),
    { ownedPath: inheritedPath });
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const mapping = evidence.result.coverage[0];
  evidence.packet.changeInventory.paths.push(mapping.mechanism);
  evidence.result = { ...evidence.result, verdict: 'minor-amendment-required',
    coverage: [{ ...mapping, classification: 'necessary-minor-expansion',
      rationale: 'The exact adjacent remediation is necessary.' }],
    scopeDelta: { description: 'Apply the exact inherited path remediation.',
      sourceCriterionIds: [...mapping.sourceCriterionIds],
      acceptedCriterionIds: [...mapping.acceptedCriterionIds], invariantIds: [], materialSurfaces: [] } };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });

  const original = JSON.parse(readFileSync(join(changeDirectory(fixture.cwd, state.changeId), 'plan', 'plan.json'), 'utf8'));
  const responsibility = evidence.result.scopeDelta.description;
  const planForPath = (path, suffix) => {
    const plan = structuredClone(original); plan.planRevision = 2;
    const criterionId = `inherited-${suffix}-criterion`; const taskId = `inherited-${suffix}-task`;
    plan.criteria.push({ id: criterionId, description: responsibility,
      disposition: 'owned', ownerTaskId: taskId, deferredReason: null });
    plan.tasks.push({ ...original.tasks[0], id: taskId, title: 'Apply inherited remediation',
      objective: responsibility, criterionIds: [criterionId], decisionIds: [], checklistItemIds: [],
      dependsOn: ['state-task'], anticipatedPaths: [path] });
    return { plan, taskId };
  };
  const trigger = digestJson(evidence);
  const amendmentFor = (taskId) => ({ id: `${taskId}-amendment`, reason: 'Use only inherited path authority.',
    authorization: 'scope-review', trigger, delta: { addedTaskIds: [taskId] }, invalidatedEvidence: [trigger] });
  for (const [suffix, path] of [
    ['reversed', 'owned'],
    ['prefix-collision', 'owned/subtree-sibling/file.txt'],
    ['unrelated', 'elsewhere/file.txt'],
  ]) {
    const rejected = planForPath(path, suffix);
    const before = durableSnapshot(changeDirectory(fixture.cwd, state.changeId));
    assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
      amendment: amendmentFor(rejected.taskId), resultingPlan: rejected.plan }),
    (error) => error.code === 'INVALID_AMENDMENT'
      && /anticipatedPaths exceed the exact assessed or inherited responsibility/u.test(error.message));
    assert.deepEqual(durableSnapshot(changeDirectory(fixture.cwd, state.changeId)), before,
      `${suffix} inherited path authority is rejected atomically`);
  }

  const accepted = planForPath(`${inheritedPath}/nested/file.txt`, 'descendant');
  state = amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment: amendmentFor(accepted.taskId), resultingPlan: accepted.plan });
  assert.equal(state.execution.tasks.find(({ id }) => id === accepted.taskId).status, 'unbound');
});

test('interrupted nonmaterial amendment recovery revalidates its canonical projection', async () => {
  const fixture = await integratedSingleTaskFixture('nonmaterial projection recovery', specialization(), {
    deferredCriterion: { id: 'deferred-recovery', description: 'Deferred recovery authority.',
      disposition: 'deferred', ownerTaskId: null, deferredReason: 'Await separate implementation.' },
  });
  let state = fixture.state;
  const evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
  const mapping = evidence.packet.changeInventory.mappings[0];
  const firstPath = 'first.txt/first-mechanism.mjs';
  const secondPath = 'first.txt/second-mechanism.mjs';
  const firstMapping = { ...mapping, mechanism: firstPath, sourceCriterionIds: [],
    acceptedCriterionIds: ['deferred-recovery'], invariantIds: [], decisionIds: [],
    rationale: 'The exact deferred-only assessed path carries its own authority.' };
  const secondMapping = { ...firstMapping, mechanism: secondPath,
    rationale: 'The assessed sibling shares only the deferred accepted criterion.' };
  evidence.packet.changeInventory.paths = [firstPath, secondPath];
  evidence.packet.changeInventory.mappings = [firstMapping, secondMapping];
  evidence.result = { ...evidence.result, verdict: 'trim-required',
    coverage: [{ ...firstMapping, sourceCriterionIds: [],
      acceptedCriterionIds: [...firstMapping.acceptedCriterionIds],
      classification: 'speculative', rationale: 'Remove the exact unnecessary mechanism.' },
    { ...secondMapping, classification: 'required' }],
    unnecessaryWork: [firstPath],
    smallerSufficientAlternative: 'Use only the bounded simplification task.' };
  evidence.packetDigest = digestJson(evidence.packet);
  evidence.resultDigest = digestJson(evidence.result);
  state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
    expectedRevision: state.revision });
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const original = JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'));
  const resultingPlan = structuredClone(original); resultingPlan.planRevision = 2;
  const responsibility = evidence.result.smallerSufficientAlternative;
  resultingPlan.criteria.push({ id: 'trim-recovery-first', description: responsibility,
    disposition: 'owned', ownerTaskId: 'trim-recovery-first-task', deferredReason: null });
  resultingPlan.tasks.push({ ...original.tasks[0], id: 'trim-recovery-first-task',
    title: 'Apply exact deferred-only trim', objective: responsibility,
    criterionIds: ['trim-recovery-first'], decisionIds: [], checklistItemIds: [], dependsOn: [],
    anticipatedPaths: [firstPath] });
  const amendment = { id: 'trim-recovery-amendment', reason: 'Apply the exact trim assessment.',
    authorization: 'scope-review', trigger: digestJson(evidence),
    delta: { addedTaskIds: ['trim-recovery-first-task'] },
    invalidatedEvidence: [digestJson(evidence)] };
  assert.throws(() => amendPlan({ cwd: fixture.cwd, expectedRevision: state.revision,
    amendment, resultingPlan,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause nonmaterial recovery'); } }),
  /pause nonmaterial recovery/u);
  const transition = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'));
  const intentPath = join(transition, 'intent.json');
  const pristineIntent = JSON.parse(readFileSync(intentPath, 'utf8'));
  for (const [label, mutate] of [
    ['accepted-criterion sibling', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').anticipatedPaths = [secondPath];
    }],
    ['mechanism witness', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').anticipatedPaths =
        ['outside/unassessed.mjs'];
    }],
    ['plan authority', (plan) => { plan.title = `${plan.title} changed`; }],
    ['mixed grounding carry', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').dependsOn = ['state-task'];
    }],
    ['fresh artifact production', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').produces = ['fresh-artifact'];
    }],
    ['fresh artifact consumption', (plan) => {
      plan.tasks.find(({ id }) => id === 'state-task').produces = ['foreign-artifact'];
      const task = plan.tasks.find(({ id }) => id === 'trim-recovery-first-task');
      task.dependsOn = ['state-task'];
      task.consumes = [{ artifactId: 'foreign-artifact', producerTaskId: 'state-task' }];
    }],
    ['fresh decision authority', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').decisionIds =
        [plan.decisions[0].id];
    }],
    ['fresh checklist authority', (plan) => {
      const task = plan.tasks.find(({ id }) => id === 'trim-recovery-first-task');
      task.checklistItemIds = [plan.checklistMappings[0].id];
      plan.checklistMappings[0].taskIds.push(task.id);
    }],
    ['fresh specialization authority', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').specialization =
        behaviorSpecialization();
    }],
    ['fresh unsplittable authority', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').unsplittable = {
        reason: 'Invent cross-domain serialization during recovery.',
        serializedDomains: ['workflow'], highestRiskSpecialization: 'ops-workflow',
      };
    }],
    ['retained foreign criterion ownership', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').criterionIds.push('durable-state');
    }],
    ['deferred criterion ownership', (plan) => {
      plan.tasks.find(({ id }) => id === 'trim-recovery-first-task').criterionIds.push('deferred-recovery');
    }],
    ['duplicate retained task identity', (plan) => {
      plan.tasks.push(structuredClone(plan.tasks.find(({ id }) => id === 'state-task')));
    }],
    ['duplicate retained criterion identity', (plan) => {
      plan.criteria.push(structuredClone(plan.criteria.find(({ id }) => id === 'durable-state')));
    }],
    ['duplicate new criterion identity', (plan) => {
      plan.criteria.push(structuredClone(plan.criteria
        .find(({ id }) => id === 'trim-recovery-first')));
    }],
    ['duplicate added task declaration', (plan, value) => {
      value.delta.addedTaskIds.push('trim-recovery-first-task');
    }],
  ]) {
    const intent = structuredClone(pristineIntent);
    const record = intent.authoritativeEvidence.amendmentDigest;
    mutate(record.value.resultingPlan, record.value);
    record.value.newDigest = digestJson(record.value.resultingPlan);
    record.digest = digestJson(record.value);
    intent.evidence.amendmentDigest = record.digest;
    const closure = intent.authoritativeEvidence.minimalClosureDigest;
    closure.value.planDigest = record.value.newDigest;
    closure.digest = digestJson(closure.value);
    intent.evidence.minimalClosureDigest = closure.digest;
    writeReceiptJson(intentPath, intent);
    const before = durableSnapshot(directory);
    assert.throws(() => recoverState({ cwd: fixture.cwd }),
      (error) => error.code === 'RECOVERY_EVIDENCE_INVALID'
        && /assessment-bound remediation projection/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before,
      `${label} tampering fails before sidecars, state, events, or completion mutate`);
  }
});

test('scope-blocked amendments require the exact active evidence trigger atomically', async () => {
  for (const verdict of ['human-decision-required', 'minor-amendment-required', 'trim-required']) {
    const fixture = await integratedSingleTaskFixture(`scope active trigger ${verdict}`);
    let state = fixture.state;
    let evidence;
    if (verdict === 'human-decision-required') {
      evidence = materialIntegratedScopeEvidence({ cwd: fixture.cwd, changeId: state.changeId },
        'active-trigger-material');
    } else {
      evidence = integratedScopeEvidenceFor({ cwd: fixture.cwd, changeId: state.changeId });
      const mapping = evidence.result.coverage[0];
      evidence.result = verdict === 'minor-amendment-required'
        ? { ...evidence.result, verdict,
          coverage: [{ ...mapping, classification: 'necessary-minor-expansion',
            rationale: 'The exact adjacent mechanism is required.' }],
          scopeDelta: { description: 'Add the exact adjacent mechanism.',
            sourceCriterionIds: [...mapping.sourceCriterionIds],
            acceptedCriterionIds: [...mapping.acceptedCriterionIds], invariantIds: [], materialSurfaces: [] } }
        : { ...evidence.result, verdict,
          coverage: [{ ...mapping, sourceCriterionIds: [], acceptedCriterionIds: [],
            classification: 'speculative', rationale: 'The mechanism is unnecessary.' }],
          unnecessaryWork: [mapping.mechanism],
          smallerSufficientAlternative: 'Remove the unnecessary mechanism.' };
      evidence.resultDigest = digestJson(evidence.result);
    }
    state = assessScope({ cwd: fixture.cwd, changeId: state.changeId, scopeEvidence: evidence,
      expectedRevision: state.revision });
    if (verdict === 'human-decision-required') {
      state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision,
        decision: materialScopeDecision(state, evidence, 'approve-material-amendment',
          ['active-trigger-material'], 'approve-active-trigger-material') });
    }

    const directory = changeDirectory(fixture.cwd, state.changeId);
    const plan = JSON.parse(readFileSync(join(directory, 'plan', 'plan.json'), 'utf8'));
    const closureName = readdirSync(join(directory, 'scope', 'minimal-closure'))
      .filter((name) => name.endsWith('.json')).sort().at(-1);
    const closure = JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', closureName), 'utf8'));
    const authorizedShape = verdict === 'human-decision-required'
      ? [...closure.authorizedShape, 'active-trigger-material'] : [...closure.authorizedShape];
    const candidate = materialAmendment(state, plan, closure, authorizedShape,
      `wrong-active-trigger-${verdict}`);
    candidate.amendment.trigger = `sha256:${verdict === 'human-decision-required' ? '1' : verdict === 'minor-amendment-required' ? '2' : '3'}`.padEnd(71, '0');
    const before = durableSnapshot(directory);
    assert.throws(() => amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...candidate }),
      (error) => error.code === 'SCOPE_AMENDMENT_INVALID'
        && /exact current scope evidence/u.test(error.message));
    assert.deepEqual(durableSnapshot(directory), before,
      `${verdict} rejects a non-current trigger without changing state, events, transitions, receipts, or plan bytes`);
  }
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
    (error) => ['AMENDMENT_CHAIN_INVALID', 'RECOVERY_EVIDENCE_INVALID', 'SCOPE_EVIDENCE_STALE'].includes(error.code));
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
    })), unexpectedDependencies: [], summary: 'Third worker validation failed.' } });
  state = acceptResult({ cwd, workerCwd: secondWorker.path, expectedRevision: state.revision,
    result: { ...resultFor(second, 'failed'), validation: second.requiredValidation.unit.map(({ command }) => ({
      command, result: 'failed', summary: 'Worker validation failed.',
    })), unexpectedDependencies: [], summary: 'Worker validation failed.' } });
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
    })), unexpectedDependencies: [], summary: 'Second worker validation failed.' } });
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
    })), unexpectedDependencies: [], summary: 'First worker validation failed.' } });
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
    })), unexpectedDependencies: [], summary: failureSummary } });
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
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const worker = createWorkerFixture(cwd, state, packet); state = scheduleWave({ cwd, expectedRevision: state.revision });
  writeFileSync(join(worker.path, 'prestart-dirty.txt'), 'dirty before start\n');
  assert.throws(() => startTask({ cwd, taskId: 'state-task', workerId: 'identity-worker', expectedRevision: state.revision }),
    (error) => error.code === 'WORKTREE_GIT_MISMATCH');
  unlinkSync(join(worker.path, 'prestart-dirty.txt'));
  state = startTask({ cwd, taskId: 'state-task', workerId: 'identity-worker', expectedRevision: state.revision });
  const result = resultFor(packet, 'no-change');
  const other = repository('wrong worker repository');
  for (const [label, workerCwd] of [['central path', cwd], ['wrong repository', other.cwd]]) {
    assert.throws(() => acceptResult({ cwd, result, workerCwd, expectedRevision: state.revision }),
      (error) => error.code === 'WORKTREE_IDENTITY_MISMATCH', label);
  }
  git(worker.path, 'switch', '-c', 'wrong-worker-branch');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: state.revision }),
    (error) => ['WORKTREE_REGISTRATION_MISMATCH', 'WORKTREE_GIT_MISMATCH'].includes(error.code));
  git(worker.path, 'switch', worker.branch);
  writeFileSync(join(worker.path, 'dirty.txt'), 'dirty\n');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: state.revision }),
    (error) => error.code === 'WORKTREE_GIT_MISMATCH');
  unlinkSync(join(worker.path, 'dirty.txt'));
  writeFileSync(join(worker.path, 'head.txt'), 'head\n'); git(worker.path, 'add', 'head.txt'); git(worker.path, 'commit', '-m', 'test: wrong worker head');
  assert.throws(() => acceptResult({ cwd, result, workerCwd: worker.path, expectedRevision: state.revision }),
    (error) => error.code === 'WORKTREE_HEAD_MISMATCH');
  git(worker.path, 'reset', '--hard', sha);
  assert.equal(loadState(cwd).revision, state.revision);
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
  const packet = packetFor(state, plan, 'state-task'); state = bindTask({ cwd, packet, expectedRevision: state.revision });
  createWorkerFixture(cwd, state, packet);
  const manifestPath = join(changeRoot(cwd), 'worktrees', 'manifests', state.changeId, 'state-task.json');
  const receiptPath = manifestPath.replace(/\.json$/u, '.sha256');
  const manifest = readFileSync(manifestPath); const receipt = readFileSync(receiptPath);
  unlinkSync(manifestPath); unlinkSync(receiptPath);
  assert.throws(() => scheduleWave({ cwd, expectedRevision: state.revision }), (error) => error.code === 'RECEIPT_MISSING');
  writeFileSync(manifestPath, manifest); writeFileSync(receiptPath, receipt);
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  assert.deepEqual(state.execution.activeWave, ['state-task']);
});
import { archiveDirectory } from '../paths.mjs';
import { loadRegistry, routeSpecialists } from '../../../aerstello-specialists/scripts/validate-registry.mjs';
import { digestJson, sourceChecklistBinding } from '../contracts/contracts.mjs';
import { implementationTaskDigest, validateImplementationTask } from '../implementation/contracts.mjs';
import { taskSetDigest } from '../scope/contracts.mjs';
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
    ...(state.scope ? { minimalityAuthority: {
      closureDigest: state.scope.closureDigest,
      criterionNeed: task.criterionIds.map((criterionId) => ({ criterionId,
        rationale: 'The exact accepted criterion requires this bounded task.' })),
      removalCounterfactual: 'Removing the task leaves its accepted criteria without an implementation owner.',
      forbiddenExpansion: ['Do not expand beyond the exact test packet.'],
      tripwires: [{ id: 'test-task-paths', category: 'git-paths', inventory: [...task.anticipatedPaths].sort(),
        observedInventory: [...task.anticipatedPaths].sort() }],
      discoveryReturn: { status: 'blocked', workerCommit: null, authority: 'unchanged' },
    } } : {}),
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
  ownedPath = 'first.txt',
  deferredCriterion = null,
} = {}) {
  const { cwd, sha } = repository(label);
  const planning = await initializeState({ cwd, changeId: label.replaceAll(' ', '-'), mode: 'implement', baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = planFor(planning);
  plan.specialization = specialize;
  plan.tasks[0].specialization = specialize;
  plan.tasks[0].anticipatedPaths = [ownedPath];
  if (deferredCriterion !== null) plan.criteria.push(deferredCriterion);
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
    mkdirSync(dirname(join(worker.path, ownedPath)), { recursive: true });
    writeFileSync(join(worker.path, ownedPath), workerContent); git(worker.path, 'add', ownedPath); git(worker.path, 'commit', '-m', 'test: lifecycle worker');
    state = acceptResult({ cwd, result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), [ownedPath]),
      workerCwd: worker.path, expectedRevision: state.revision });
    state = integrateTask({ cwd, taskId: 'state-task', expectedRevision: state.revision });
  }
  removeTaskWorktree({ cwd, changeId: state.changeId, taskId: 'state-task' });
  state = finalizeIntegration({ cwd, expectedRevision: state.revision });
  return { cwd, state };
}

async function integratedTwoTaskFixture(label, ownedPaths = ['first.txt', 'second.txt']) {
  const { cwd, sha } = repository(label);
  const planning = await initializeState({ cwd, changeId: label.replaceAll(' ', '-'), mode: 'implement',
    baseBranch: 'main', planningRef: sha, source: descriptor });
  const plan = executionPlanFor(planning);
  for (let index = 0; index < plan.tasks.length; index += 1) {
    plan.tasks[index].anticipatedPaths = [ownedPaths[index]];
  }
  let state = acceptPlan({ cwd, plan, expectedRevision: planning.revision });
  const packets = plan.tasks.map((task) => packetFor(state, plan, task.id));
  for (const packet of packets) state = bindTask({ cwd, packet, expectedRevision: state.revision });
  const workers = packets.map((packet) => createWorkerFixture(cwd, state, packet));
  state = scheduleWave({ cwd, expectedRevision: state.revision });
  for (const packet of packets) {
    state = startTask({ cwd, taskId: packet.taskId, workerId: `${packet.taskId}-worker`,
      expectedRevision: state.revision });
  }
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index]; const worker = workers[index]; const path = packet.allowedPaths[0];
    mkdirSync(dirname(join(worker.path, path)), { recursive: true });
    writeFileSync(join(worker.path, path), `${packet.taskId}\n`);
    git(worker.path, 'add', path); git(worker.path, 'commit', '-m', `test: ${packet.taskId} worker`);
    state = acceptResult({ cwd,
      result: resultFor(packet, 'implemented', git(worker.path, 'rev-parse', 'HEAD'), [path]),
      workerCwd: worker.path, expectedRevision: state.revision });
  }
  for (const packet of packets) {
    state = integrateTask({ cwd, taskId: packet.taskId, expectedRevision: state.revision });
    removeTaskWorktree({ cwd, changeId: state.changeId, taskId: packet.taskId });
  }
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
  const beforeScopeGate = durableSnapshot(changeDirectory(cwd, planning.changeId));
  assert.throws(() => acceptPlanWithScope({ cwd, plan: scenarioPlanFor(planning), expectedRevision: 0 }),
    (error) => error.code === 'PLAN_SCOPE_INVALID');
  assert.deepEqual(durableSnapshot(changeDirectory(cwd, planning.changeId)), beforeScopeGate,
    'missing admission scope authority cannot mutate plan, state, event, or transition evidence');
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
  const historicalPlan = structuredClone(safePlan); historicalPlan.planRevision = 2;
  historicalPlan.tasks[0].anticipatedPaths = ['.git/config'];
  const historicalDigest = digestJson(historicalPlan);
  const historicalState = structuredClone(accepted);
  delete historicalState.scope;
  historicalState.plan.originalDigest = digestJson(safePlan);
  historicalState.plan.effectiveDigest = historicalDigest;
  historicalState.plan.revision = 2;
  historicalState.plan.amendmentCount = 1;
  historicalState.execution.planDigest = historicalDigest;
  historicalState.execution.tasks[0].anticipatedPaths = ['.git/config'];
  const amendmentRecord = {
    schemaVersion: 1, amendmentId: 'historical-unsafe-path', reason: 'Historical accepted amendment.',
    trigger: 'historical-operator-decision', delta: { changed: ['anticipatedPaths'] },
    previousDigest: historicalState.plan.originalDigest, newDigest: historicalDigest,
    repositorySha: fixture.sha, authorization: 'operator', invalidatedEvidence: [],
    resultingPlan: historicalPlan, createdAt: accepted.updatedAt,
  };
  const amendmentPath = join(root, 'plan', 'amendments', '0001.json');
  const amendmentEvidencePath = join(root, 'plan', 'amendments', '0001.evidence.json');
  writeReceiptJson(amendmentPath, amendmentRecord);
  writeReceiptJson(amendmentEvidencePath, []);
  const transition = join(root, 'transitions', '00000001');
  const intentPath = join(transition, 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.nextState = historicalState;
  intent.nextStateDigest = digestJson(historicalState);
  for (const key of ['minimalClosureDigest', 'scopeAdmissionEvidenceDigest']) {
    delete intent.evidence[key]; delete intent.evidencePaths[key]; delete intent.authoritativeEvidence[key];
  }
  intent.evidence.amendmentDigest = digestJson(amendmentRecord);
  intent.evidence.amendmentPlanningEvidenceDigest = digestJson([]);
  intent.evidencePaths.amendmentDigest = 'plan/amendments/0001.json';
  intent.evidencePaths.amendmentPlanningEvidenceDigest = 'plan/amendments/0001.evidence.json';
  intent.authoritativeEvidence.amendmentDigest = {
    path: 'plan/amendments/0001.json', label: 'historical plan amendment',
    digest: intent.evidence.amendmentDigest, value: amendmentRecord,
  };
  intent.authoritativeEvidence.amendmentPlanningEvidenceDigest = {
    path: 'plan/amendments/0001.evidence.json', label: 'historical plan amendment evidence',
    digest: intent.evidence.amendmentPlanningEvidenceDigest, value: [],
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
  rmSync(join(root, 'scope'), { recursive: true });

  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
  const unsafePacket = packetFor(historicalState, historicalPlan, 'state-task');
  assert.throws(() => bindTask({ cwd: fixture.cwd, packet: unsafePacket, expectedRevision: historicalState.revision }),
    (error) => error instanceof StateError && error.code === 'SCOPE_ADOPTION_REQUIRED');
  const closure = testMinimalClosure(historicalState, historicalPlan);
  const foreignDecisionClosure = { ...closure, operatorDecisionDigests: [`sha256:${'f'.repeat(64)}`] };
  const beforeForeignDecisionAdoption = durableSnapshot(root);
  assert.throws(() => adoptScope({ cwd: fixture.cwd, expectedRevision: historicalState.revision,
    minimalClosure: foreignDecisionClosure, scopeEvidence: testScopeEvidence(historicalState,
      historicalPlan, foreignDecisionClosure, { amendmentDigests: [digestJson(amendmentRecord)] }) }),
  (error) => error.code === 'SCOPE_ADOPTION_INVALID'
    && /exact ordered durable scope decision digests/u.test(error.message));
  assert.deepEqual(durableSnapshot(root), beforeForeignDecisionAdoption,
    'legacy adoption rejects foreign decision authority without durable mutation');
  const staleOriginalEvidence = testScopeEvidence(historicalState, historicalPlan, closure, {
    subjectDigest: historicalState.plan.originalDigest,
    amendmentDigests: [digestJson(amendmentRecord)],
  });
  const beforeAdoption = durableSnapshot(root);
  assert.throws(() => adoptScope({ cwd: fixture.cwd, expectedRevision: historicalState.revision,
    minimalClosure: closure, scopeEvidence: staleOriginalEvidence }),
  (error) => error.code === 'SCOPE_ADOPTION_INVALID');
  assert.deepEqual(durableSnapshot(root), beforeAdoption,
    'legacy adoption rejects an assessment of the obsolete original plan without durable mutation');
  const adopted = adoptScope({ cwd: fixture.cwd, expectedRevision: historicalState.revision, minimalClosure: closure,
    scopeEvidence: testScopeEvidence(historicalState, historicalPlan, closure, {
      amendmentDigests: [digestJson(amendmentRecord)],
    }) });
  assert.throws(() => bindTask({ cwd: fixture.cwd, packet: unsafePacket, expectedRevision: adopted.revision }),
    (error) => error instanceof StateError && error.code === 'INVALID_TASK_PACKET');
  assert.equal(loadState(fixture.cwd).revision, adopted.revision);

  const amendedPlan = structuredClone(historicalPlan); amendedPlan.planRevision = 3;
  amendedPlan.tasks[0].anticipatedPaths = ['.gitignore'];
  const replacementClosure = testMinimalClosure(adopted, amendedPlan, {
    revision: 2, previousContractDigest: adopted.scope.closureDigest,
    operatorDecisionDigests: [...adopted.scope.decisionDigests],
  });
  const amended = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: adopted.revision,
    resultingPlan: amendedPlan, minimalClosure: replacementClosure,
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
  assert.match(nextActionFor({ ...state, phase: 'ready-to-implement', mode: 'full', schemaVersion: 2,
    scope: { status: 'assessment-required' } }), /only if binding reports exact changed tripwire IDs/u);
  assert.match(nextActionFor({ ...state, phase: 'implementing', mode: 'full', schemaVersion: 2,
    scope: { status: 'assessment-required' }, execution: { activeWave: [], tasks: [{ status: 'bound' }] } }),
  /Bind or schedule/u);
  assert.doesNotMatch(nextActionFor({ ...state, phase: 'blocked', scope: { status: 'assessment-required' },
    blockedReasons: ['Task state-task reported blocked: An ordinary blocker.'],
    execution: { activeWave: [], tasks: [{ status: 'blocked' }] } }), /assess-scope/u);
  assert.match(nextActionFor({ ...state, phase: 'blocked', scope: { status: 'assessment-required' },
    blockedReasons: ['Task state-task reported blocked scope discovery: One unexpected dependency.'],
    execution: { activeWave: [], tasks: [{ status: 'blocked' }] } }), /receipt-backed worker scope discovery/u);
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

test('interrupted scope decisions recover at the exact clean integrated HEAD', async () => {
  const fixture = await integratedSingleTaskFixture('integrated scope decision recovery');
  assert.notEqual(fixture.state.git.headSha, fixture.state.planningSha,
    'the fixture exercises an integrated HEAD beyond the immutable Planning SHA');
  const evidence = materialIntegratedScopeEvidence({ cwd: fixture.cwd });
  const state = assessScope({ cwd: fixture.cwd, scopeEvidence: evidence,
    expectedRevision: fixture.state.revision });
  const decision = materialScopeDecision(state, evidence, 'approve-material-amendment',
    ['material-integrated-recovery'], 'recover-integrated-scope-decision');
  assert.throws(() => recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision, decision,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause integrated scope decision'); } }),
  /pause integrated scope decision/u);

  const recovered = recoverState({ cwd: fixture.cwd });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state.git.headSha, fixture.state.git.headSha);
  assert.equal(recovered.state.scope.decisionDigests.at(-1), digestJson(decision));
  assert.equal(validateState({ cwd: fixture.cwd }).valid, true);
});

test('scope decision recovery rejects a receipt-consistent duplicate ID before mutation', async () => {
  const fixture = await materialDecisionFixture('duplicate-decision-recovery', ['material-alpha']);
  const duplicateId = 'duplicate-recovery-id';
  let state = recordScopeDecision({ cwd: fixture.cwd, expectedRevision: fixture.state.revision,
    decision: materialScopeDecision(fixture.state, fixture.evidence, 'approve-material-amendment',
      ['material-alpha'], duplicateId) });
  const first = materialAmendment(state, fixture.plan, fixture.closure,
    ['durable-test-change', 'unrelated-existing-shape', 'material-alpha'], 'duplicate-recovery-first');
  state = amendPlanWithScope({ cwd: fixture.cwd, expectedRevision: state.revision, ...first });
  const directory = changeDirectory(fixture.cwd, state.changeId);
  const firstClosure = JSON.parse(readFileSync(join(directory, 'scope', 'minimal-closure', '0002.json'), 'utf8'));
  const firstAmendment = JSON.parse(readFileSync(join(directory, 'plan', 'amendments', '0001.json'), 'utf8'));
  const evidence = materialScopeEvidence(state, first.resultingPlan, firstClosure,
    ['material-beta'], [digestJson(firstAmendment)], [{
      id: duplicateId, digest: state.scope.decisionDigests[0],
      disposition: 'approve-material-amendment', authorizedShape: ['material-alpha'],
    }]);
  state = assessScope({ cwd: fixture.cwd, scopeEvidence: evidence, expectedRevision: state.revision });
  const decision = materialScopeDecision(state, evidence, 'approve-material-amendment',
    ['material-beta'], 'unique-before-recovery-tamper');
  assert.throws(() => recordScopeDecision({ cwd: fixture.cwd, expectedRevision: state.revision, decision,
    crashStep(step) { if (step === 'after-intent') throw new Error('pause duplicate recovery'); } }),
  /pause duplicate recovery/u);

  const intentPath = join(directory, 'transitions', String(state.revision + 1).padStart(8, '0'), 'intent.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const duplicatedDecision = { ...decision, decisionId: duplicateId };
  const duplicatedDigest = digestJson(duplicatedDecision);
  const duplicatedPath = `scope/decisions/${String(duplicatedDecision.revision).padStart(8, '0')}-${duplicateId}.json`;
  intent.evidence.scopeDecisionDigest = duplicatedDigest;
  intent.evidencePaths.scopeDecisionDigest = duplicatedPath;
  intent.authoritativeEvidence.scopeDecisionDigest = {
    ...intent.authoritativeEvidence.scopeDecisionDigest,
    path: duplicatedPath, digest: duplicatedDigest, value: duplicatedDecision,
  };
  intent.nextState.scope.decisionDigests[intent.nextState.scope.decisionDigests.length - 1] = duplicatedDigest;
  intent.nextStateDigest = digestJson(intent.nextState);
  writeReceiptJson(intentPath, intent);

  const beforeRecovery = durableSnapshot(directory);
  assert.throws(() => recoverState({ cwd: fixture.cwd }),
    (error) => error.code === 'RECOVERY_EVIDENCE_INVALID' && /already recorded/u.test(error.message));
  assert.deepEqual(durableSnapshot(directory), beforeRecovery,
    'duplicate candidate evidence, state, event, receipt, and completion remain absent');
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
