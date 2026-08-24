import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { gitText } from '../../../../scripts/lib/git.mjs';
import {
  formatBoundaryDiagnostic,
  scanImportBoundaries,
} from './architecture/import-boundaries.mjs';
import {
  featureDirectory,
  gitCommonDirectory,
  prReviewStateSchemaPath,
  repositoryDirectory as resolveRepositoryDirectory,
  repositoryRoot,
  reviewFixResultSchemaPath,
  reviewFixTaskSchemaPath,
  reviewRoot,
  schemaDirectory,
  scriptsDirectory,
  skillDirectory,
} from './paths.mjs';

const repositoryDirectory = resolveRepositoryDirectory();


const EXPECTED_ADAPTERS = [
  '.codex/agents/integration-verifier.toml',
  '.codex/agents/review-fix-worker.toml',
  '.codex/config.toml',
  '.codex/hooks.json',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'package.json',
];

const EXPECTED_ADAPTER_TARGETS = {
  '.codex/agents/integration-verifier.toml': [
    'README.md',
    'references/orchestration.md',
  ],
  '.codex/agents/review-fix-worker.toml': [
    'README.md',
    'references/orchestration.md',
    'schemas/review-fix-result.schema.json',
  ],
  '.codex/config.toml': [],
  '.codex/hooks.json': [
    'scripts/hooks/pre-compact.mjs',
    'scripts/hooks/session-start.mjs',
    'scripts/hooks/subagent-stop.mjs',
  ],
  'AGENTS.md': ['README.md'],
  'CONTRIBUTING.md': ['README.md'],
  'README.md': ['README.md'],
  'package.json': [
    'scripts/github/cli.mjs',
    'scripts/state/cli.mjs',
    'scripts/worktree/cli.mjs',
  ],
};

const EXPECTED_NEUTRAL_DEPENDENCIES = [
  'scripts/lib/cli.mjs',
  'scripts/lib/git.mjs',
  'tests/support/git-fixtures.mjs',
];

const EXPECTED_SEPARATE_CAPABILITIES = {
  changeDevelopment: [
    '.agents/skills/change-development/**',
    '.codex/agents/implementation-worker.toml',
  ],
  specialists: [
    '.agents/skills/aerstello-specialists/**',
    '.codex/agents/behavior-mapper.toml',
    '.codex/agents/offline-realtime-reviewer.toml',
    '.codex/agents/security-reviewer.toml',
  ],
  release: [
    '.release/**',
    'scripts/check-released-migrations.mjs',
    'scripts/lib/release-state.mjs',
    'scripts/lib/release-state.test.mjs',
    'scripts/release-state.mjs',
  ],
  relatedE2E: [
    'playwright.config.ts',
    'scripts/run-related-e2e.mjs',
    'scripts/run-related-e2e.test.mjs',
    'specs/features/**',
  ],
};

const EXPECTED_OBSOLETE_PATHS = [
  '.agents/skills/pr-review-cycle/scripts/contracts/state-contracts.test.mjs',
  '.agents/skills/pr-review-cycle/scripts/contracts/task-worker-contracts.test.mjs',
  '.agents/skills/pr-review-cycle/scripts/github/github.test.mjs',
  '.agents/skills/pr-review-cycle/scripts/state/state.test.mjs',
  '.codex/hooks/pre-compact.mjs',
  '.codex/hooks/session-start.mjs',
  '.codex/hooks/subagent-stop.mjs',
  'docs/agents/pr-review-cycle.md',
  'docs/agents/pr-review-state.schema.json',
  'docs/agents/review-fix-result.schema.json',
  'docs/agents/review-fix-task.schema.json',
  'scripts/lib/contracts.mjs',
  'scripts/lib/pr-review-github.mjs',
  'scripts/lib/pr-review-state.mjs',
  'scripts/lib/pr-review-worktree.mjs',
  'scripts/pr-review-github.mjs',
  'scripts/pr-review-state.mjs',
  'scripts/pr-review-worktree.mjs',
  'tests/tooling/contracts.test.mjs',
  'tests/tooling/fixtures/hold-state-lock.mjs',
  'tests/tooling/git-fixtures.mjs',
  'tests/tooling/hooks.test.mjs',
  'tests/tooling/pr-review-github.test.mjs',
  'tests/tooling/pr-review-state.test.mjs',
  'tests/tooling/related-e2e.test.mjs',
  'tests/tooling/release-state.test.mjs',
  'tests/tooling/worktree.test.mjs',
];

function sorted(values) {
  return [...values].sort();
}

function posixRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function filesBelow(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(posixRelative(directory, path));
      else throw new Error(`non-regular canonical entry: ${posixRelative(directory, path)}`);
    }
  }
  return sorted(files);
}

function repositoryFiles() {
  return gitText(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryDirectory },
  ).split('\0').filter(Boolean);
}

function readRepositoryFile(path) {
  return readFileSync(join(repositoryDirectory, path), 'utf8');
}

function loadOwnership() {
  return JSON.parse(readFileSync(join(skillDirectory, 'ownership.json'), 'utf8'));
}

const contractsDirectory = join(scriptsDirectory, 'contracts');
const specialistRegistryModule = join(
  repositoryDirectory,
  '.agents/skills/aerstello-specialists/scripts/validate-registry.mjs',
);

function contractModule(fileName) {
  return join(contractsDirectory, fileName);
}

const PRODUCTION_CONTRACT_IMPORTS = new Map([
  ['primitives.mjs', new Map()],
  ['contract-identities.mjs', new Map([
    ['node:crypto', ['createHash']],
    [contractModule('primitives.mjs'), ['isObject']],
  ])],
  ['targeted-validation.mjs', new Map([
    ['node:fs', ['readdirSync', 'readFileSync']],
    ['node:path', ['join']],
    [join(scriptsDirectory, 'paths.mjs'), ['featureDirectory']],
    [contractModule('primitives.mjs'), [
      'isSha', 'isString', 'parseRepositoryPath', 'rejectUnknownFields', 'requireFields',
      'validateStringList',
    ]],
  ])],
  ['task-packet.mjs', new Map([
    [specialistRegistryModule, ['validateSpecialization']],
    [contractModule('contract-identities.mjs'), ['sha256CanonicalContractJson']],
    [contractModule('primitives.mjs'), [
      'findRawFields', 'isSha', 'isString', 'parseRepositoryPath', 'rejectUnknownFields',
      'requireFields', 'validateStringList',
    ]],
    [contractModule('targeted-validation.mjs'), ['validateAffectedAreas', 'validateRequiredValidation']],
  ])],
  ['task-packet-union.mjs', new Map([
    [contractModule('targeted-validation.mjs'), ['unionValidationSelections']],
    [contractModule('task-packet.mjs'), ['validateTaskPacket']],
  ])],
  ['worker-result.mjs', new Map([
    [specialistRegistryModule, ['loadRegistry']],
    [contractModule('contract-identities.mjs'), ['validatedWorkerResultDigest']],
    [contractModule('primitives.mjs'), [
      'findRawFields', 'isSha', 'isString', 'parseRepositoryPath', 'pathMatchesOwnership',
      'rejectUnknownFields', 'requireFields', 'validateValidationEntry',
    ]],
    [contractModule('task-packet.mjs'), ['validateTaskPacket']],
  ])],
  ['review-evidence.mjs', new Map([
    [contractModule('contract-identities.mjs'), ['staleDiscoveryDispositionId']],
    [contractModule('primitives.mjs'), [
      'isDateTime', 'isHttpsUrl', 'isObject', 'isSha', 'isString', 'rejectUnknownFields',
      'requireFields', 'validateStringList',
    ]],
  ])],
  ['thread-proof.mjs', new Map([
    ['node:util', ['isDeepStrictEqual']],
    [contractModule('primitives.mjs'), [
      'isDateTime', 'isHttpsUrl', 'isObject', 'isSha', 'isString', 'rejectUnknownFields',
      'requireFields', 'validateStringList',
    ]],
  ])],
  ['gates.mjs', new Map([
    [contractModule('primitives.mjs'), ['isObject']],
  ])],
  ['state-v1.mjs', new Map([
    [contractModule('primitives.mjs'), [
      'findRawFields', 'isDateTime', 'isObject', 'isSha', 'isString', 'rejectUnknownFields',
      'requireFields',
    ]],
  ])],
  ['state-v3.mjs', new Map([
    [contractModule('gates.mjs'), ['completionStateGate', 'reviewReadyStateGate', 'reviewRequestUsage']],
    [contractModule('primitives.mjs'), [
      'findRawFields', 'isDateTime', 'isObject', 'isSha', 'isString', 'rejectUnknownFields',
      'requireFields', 'validateStringList',
    ]],
    [contractModule('review-evidence.mjs'), [
      'validateReviewHistory', 'validateReviewOutcome', 'validateReviewRequest',
      'validateStaleDiscoveryDispositions', 'validateVerificationEscalation',
    ]],
    [contractModule('thread-proof.mjs'), ['validateCiProof', 'validateProof', 'validateThreadStatus']],
  ])],
  ['contracts.mjs', new Map([
    [contractModule('contract-identities.mjs'), ['staleDiscoveryDispositionId']],
    [contractModule('gates.mjs'), ['completionGate', 'reviewRequestGate', 'reviewRequestUsage']],
    [contractModule('review-evidence.mjs'), ['buildStaleDiscoveryDisposition']],
    [contractModule('state-v1.mjs'), ['validatePrReviewStateV1']],
    [contractModule('state-v3.mjs'), [
      'FINDING_DISPOSITIONS', 'STATE_PHASES', 'TASK_STATUSES', 'validatePrReviewState',
    ]],
    [contractModule('targeted-validation.mjs'), [
      'parseTargetedValidationCommand', 'unionInitialValidationSelection',
      'validateInitialValidationSelection',
    ]],
    [contractModule('task-packet-union.mjs'), ['unionRequiredValidation']],
    [contractModule('task-packet.mjs'), ['validateTaskPacket']],
    [contractModule('thread-proof.mjs'), ['taskHasCanonicalThreadCoverage']],
    [contractModule('worker-result.mjs'), [
      'validateWorkerResult', 'validateWorkerResultAgainstTask', 'workerResultDigest',
    ]],
  ])],
]);

const CONTRACT_FACADE_EXPORTS = [
  'buildStaleDiscoveryDisposition',
  'completionGate',
  'FINDING_DISPOSITIONS',
  'parseTargetedValidationCommand',
  'reviewRequestGate',
  'reviewRequestUsage',
  'staleDiscoveryDispositionId',
  'STATE_PHASES',
  'TASK_STATUSES',
  'taskHasCanonicalThreadCoverage',
  'unionInitialValidationSelection',
  'unionRequiredValidation',
  'validateInitialValidationSelection',
  'validatePrReviewState',
  'validatePrReviewStateV1',
  'validateTaskPacket',
  'validateWorkerResult',
  'validateWorkerResultAgainstTask',
  'workerResultDigest',
];

const githubDirectory = join(scriptsDirectory, 'github');

function githubModule(path) {
  return join(githubDirectory, path);
}

const importedAs = (imported, local = imported) => ({ imported, local });

const stateModuleDirectory = join(scriptsDirectory, 'state');
const stateModule = (path) => join(stateModuleDirectory, path);

const PRODUCTION_STATE_IMPORTS = new Map([
  ['errors.mjs', new Map()],
  ['atomic-io.mjs', new Map([
    ['node:fs', ['closeSync', 'existsSync', 'fsyncSync', 'mkdirSync', 'openSync', 'readFileSync', 'renameSync', 'rmSync', 'writeFileSync']],
    ['node:crypto', ['randomUUID']],
    ['node:path', ['basename', 'dirname', 'join']],
    [stateModule('errors.mjs'), ['StateError']],
  ])],
  ['locations.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:path', ['join']],
    [join(scriptsDirectory, 'paths.mjs'), ['reviewRoot', 'specialistReviewDirectory', 'taskBindingProvenanceDirectory', 'taskPacketDirectory', 'workerResultDirectory']],
    [stateModule('errors.mjs'), ['StateError']],
  ])],
  ['locks.mjs', new Map([
    ['node:fs', ['lstatSync', 'mkdirSync']],
    ['node:path', ['dirname']],
    ['node:sqlite', ['DatabaseSync']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['legacyLockPath', 'legacyRequestOwnerLockPath', 'lockPath', 'requestOwnerLockPath']],
  ])],
  ['journal.mjs', new Map([
    ['node:fs', ['existsSync', 'mkdirSync', 'readFileSync']],
    ['node:path', ['join']],
    [stateModule('atomic-io.mjs'), ['atomicWriteText']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['stateDirectory']],
    [stateModule('locks.mjs'), ['withStateLock']],
  ])],
  ['git-authority.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:fs', ['existsSync', 'mkdtempSync', 'mkdirSync', 'readFileSync', 'rmSync', 'statSync', 'writeFileSync']],
    ['node:os', ['tmpdir']],
    ['node:path', ['dirname', 'join', 'resolve']],
    ['node:child_process', ['spawnSync']],
    [join(repositoryDirectory, 'scripts', 'lib', 'git.mjs'), ['gitText', 'resolveCommit', 'runGit']],
    [stateModule('errors.mjs'), ['StateError']],
  ])],
  ['migrations.mjs', new Map([
    ['node:fs', ['existsSync', 'readFileSync']],
    ['node:path', ['join']],
    [join(repositoryDirectory, 'scripts', 'lib', 'git.mjs'), ['runGit']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validatePrReviewState', 'validatePrReviewStateV1']],
    [stateModule('atomic-io.mjs'), ['atomicWriteJson', 'atomicWriteText', 'serializeJson']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('journal.mjs'), ['appendEvent']],
    [stateModule('locations.mjs'), ['activePointerPath', 'parsePrNumber', 'stateDirectory', 'statePath']],
    [stateModule('locks.mjs'), ['withStateLock']],
  ])],
  ['state-store.mjs', new Map([
    ['node:fs', ['existsSync', 'readFileSync']],
    ['node:path', ['join']],
    [join(repositoryDirectory, 'scripts', 'lib', 'git.mjs'), ['gitText', 'resolveCommit', 'runGit']],
    [join(repositoryDirectory, 'scripts', 'lib', 'release-state.mjs'), ['inspectReleaseState']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validatePrReviewState', 'validatePrReviewStateV1']],
    [join(scriptsDirectory, 'paths.mjs'), ['repositoryRoot']],
    [stateModule('atomic-io.mjs'), ['atomicWriteJson', 'serializeJson']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('git-authority.mjs'), ['gitSnapshot']],
    [stateModule('journal.mjs'), ['appendEvent']],
    [stateModule('locations.mjs'), ['activePointerPath', 'parsePrNumber', 'stateDirectory', 'statePath']],
    [stateModule('locks.mjs'), ['withStateLock']],
    [stateModule('migrations.mjs'), ['migratePrReviewStateV2']],
  ])],
  ['evidence/task-packets.mjs', new Map([
    ['node:fs', ['existsSync']],
    ['node:path', ['join', 'resolve']],
    [join(repositoryDirectory, 'scripts', 'lib', 'git.mjs'), ['runGit']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validateTaskPacket']],
    [join(scriptsDirectory, 'contracts', 'task-packet.mjs'), [importedAs('taskPacketDigest', 'internalTaskPacketDigest')]],
    [stateModule('atomic-io.mjs'), ['atomicWriteText', 'canonicalSerializedJson', 'readJsonSidecar']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['stateDirectory', 'taskPacketSidecarPath']],
    [stateModule('migrations.mjs'), ['migratePrReviewStateV2']],
  ])],
  ['evidence/specialist-bundle-store.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:fs', ['existsSync', 'readFileSync', 'statSync']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validateTaskPacket']],
    [join(skillDirectory, '..', 'aerstello-specialists', 'scripts', 'validate-registry.mjs'), ['isSpecialistEvidenceApplicable', 'loadRegistry', 'requiredSpecialistIds', 'routeSpecialists', 'validateSpecialistEvidence']],
    [stateModule('atomic-io.mjs'), ['atomicWriteText', 'canonicalSerializedJson', 'readJsonSidecar']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['specialistPlanReceiptPath', 'specialistReviewBundlePath']],
    [stateModule('evidence/task-packets.mjs'), ['taskPacketDigest']],
  ])],
  ['evidence/task-binding.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:fs', ['existsSync', 'readFileSync', 'readdirSync', 'statSync']],
    [join(scriptsDirectory, 'paths.mjs'), ['specialistReviewDirectory']],
    [join(skillDirectory, '..', 'aerstello-specialists', 'scripts', 'validate-registry.mjs'), ['isSpecialistEvidenceApplicable']],
    [stateModule('atomic-io.mjs'), ['atomicWriteText', 'canonicalJson', 'canonicalSerializedJson', 'readJsonSidecar']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['specialistReviewBundlePath', 'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath']],
    [stateModule('evidence/specialist-bundle-store.mjs'), ['conciseSpecialistPayloadErrors', 'normalizedRequiredSpecialistIds', 'readSpecialistBundle', 'specialistPlanDigest', 'specialistRouteFor']],
    [stateModule('evidence/task-packets.mjs'), ['assertBoundTaskPacket', 'readTaskPacketSidecar', 'taskPacketDigest']],
  ])],
  ['evidence/worker-results.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:fs', ['existsSync', 'readFileSync', 'statSync']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validateWorkerResultAgainstTask', 'workerResultDigest']],
    [stateModule('atomic-io.mjs'), ['atomicWriteText', 'canonicalJson', 'canonicalSerializedJson', 'readJsonSidecar']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('git-authority.mjs'), ['inspectWorkerCommitAuthority']],
    [stateModule('locations.mjs'), ['workerResultEnvelopePath', 'workerResultReceiptPath']],
    [stateModule('evidence/task-binding.mjs'), ['readBoundTaskBindingProvenance']],
    [stateModule('evidence/task-packets.mjs'), ['taskPacketDigest']],
  ])],
  ['evidence/specialist-bundles.mjs', new Map([
    ['node:fs', ['existsSync', 'readdirSync']],
    ['node:path', ['join']],
    [join(skillDirectory, '..', 'aerstello-specialists', 'scripts', 'validate-registry.mjs'), ['isSpecialistEvidenceApplicable', 'validateSpecialistEvidence']],
    [join(scriptsDirectory, 'paths.mjs'), ['specialistReviewDirectory']],
    [stateModule('atomic-io.mjs'), ['atomicWriteText', 'canonicalJson', 'canonicalSerializedJson']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('git-authority.mjs'), ['gitSnapshot']],
    [stateModule('locations.mjs'), ['specialistPlanReceiptPath', 'specialistReviewBundlePath', 'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath']],
    [stateModule('locks.mjs'), ['withStateLock']],
    [stateModule('state-store.mjs'), ['activePrNumber', 'loadState']],
    [stateModule('evidence/task-binding.mjs'), ['loadBoundTaskPacketEntries', 'readBoundTaskBindingProvenance', 'recoverHistoricalTaskBindingPlanning', 'taskBindingProvenanceDigest']],
    [stateModule('evidence/specialist-bundle-store.mjs'), ['conciseSpecialistPayloadErrors', 'normalizedRequiredSpecialistIds', 'readSpecialistBundle', 'specialistPhaseForStage', 'specialistPlanningErrors', 'specialistRouteFor', 'validateSpecialistBundle', 'writeNewSpecialistBundle']],
    [stateModule('evidence/task-packets.mjs'), ['assertBoundTaskPacket', 'assertTaskPacketHead', 'hasCompletedHistoricalV2TaskProof', 'readTaskPacketSidecar', 'taskPacketDigest']],
    [stateModule('evidence/worker-results.mjs'), ['readAcceptedWorkerResult']],
  ])],
  ['evidence/validation-plans.mjs', new Map([
    ['node:fs', ['existsSync', 'readFileSync']],
    ['node:path', ['join']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['parseTargetedValidationCommand', 'unionInitialValidationSelection', 'unionRequiredValidation', 'validateInitialValidationSelection', 'reviewRequestUsage']],
    [stateModule('atomic-io.mjs'), ['atomicWriteJson', 'canonicalSerializedJson', 'readJsonSidecar', 'serializeJson']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('git-authority.mjs'), ['gitSnapshot']],
    [stateModule('journal.mjs'), ['appendEvent']],
    [stateModule('locations.mjs'), ['stateDirectory', 'validationPlanPath']],
    [stateModule('migrations.mjs'), ['migratePrReviewStateV2']],
    [stateModule('state-store.mjs'), ['loadState', 'readStateDocument']],
    [stateModule('evidence/task-binding.mjs'), ['loadBoundTaskPackets', 'readBoundTaskBindingProvenance']],
    [stateModule('evidence/task-packets.mjs'), ['assertBoundTaskPacket', 'readTaskPacketSidecar', 'taskPacketDigest']],
  ])],
  ['reconciliation.mjs', new Map([
    ['node:fs', ['existsSync', 'readdirSync']],
    ['node:path', ['join']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validateTaskPacket']],
    [join(scriptsDirectory, 'paths.mjs'), ['taskBindingProvenanceDirectory', 'taskPacketDirectory', 'workerResultDirectory']],
    [stateModule('atomic-io.mjs'), ['readJsonSidecar']],
    [stateModule('git-authority.mjs'), ['gitSnapshot']],
    [stateModule('locations.mjs'), ['taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath', 'workerResultEnvelopePath', 'workerResultReceiptPath']],
    [stateModule('state-store.mjs'), ['loadState']],
    [stateModule('evidence/task-binding.mjs'), ['assertTaskBindingProvenanceSource', 'buildTaskBindingProvenance', 'readBoundTaskBindingProvenance', 'recoverHistoricalTaskBindingPlanning', 'validateTaskBindingProvenance', 'verifyTaskBindingProvenanceReceipt']],
    [stateModule('evidence/specialist-bundles.mjs'), ['readSpecialistStatus']],
    [stateModule('evidence/task-packets.mjs'), ['hasCompletedHistoricalV2TaskProof', 'readTaskPacketSidecar']],
    [stateModule('evidence/worker-results.mjs'), ['readAcceptedWorkerResult']],
  ])],
  ['recovery.mjs', new Map([
    ['node:fs', ['existsSync', 'readFileSync']],
    [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestUsage']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('locations.mjs'), ['validationPlanPath']],
    [stateModule('reconciliation.mjs'), ['reconcileState']],
    [stateModule('state-store.mjs'), ['loadState']],
    [stateModule('evidence/specialist-bundles.mjs'), ['readSpecialistStatus']],
    [stateModule('evidence/validation-plans.mjs'), ['actionablePacketValidationTaskIds', 'readValidationPlan', 'validateValidationPlan']],
  ])],
  ['archive.mjs', new Map([
    ['node:crypto', ['randomUUID']],
    ['node:fs', ['closeSync', 'cpSync', 'existsSync', 'fsyncSync', 'mkdirSync', 'openSync', 'renameSync', 'rmSync', 'unlinkSync', 'writeFileSync']],
    ['node:path', ['dirname', 'join']],
    [join(scriptsDirectory, 'paths.mjs'), ['reviewRoot']],
    [stateModule('atomic-io.mjs'), ['atomicWriteJson']],
    [stateModule('errors.mjs'), ['StateError']],
    [stateModule('journal.mjs'), ['prepareEvent']],
    [stateModule('locations.mjs'), ['activePointerPath', 'parsePrNumber', 'stateDirectory']],
    [stateModule('locks.mjs'), ['withStateLock']],
    [stateModule('reconciliation.mjs'), ['reconcileState']],
    [stateModule('state-store.mjs'), ['activePrNumber', 'loadState', 'validateStateForWrite']],
  ])],
  ['state.mjs', new Map()],
]);

// The facade is a pure explicit re-export surface. Extracted transition, checkpoint, and service
// modules use exact dependency allowlists so additions cannot acquire persistence authority by drift.
PRODUCTION_STATE_IMPORTS.set('transition-policy.mjs', new Map([
  ['node:crypto', ['createHash']],
  [stateModule('atomic-io.mjs'), ['canonicalJson']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('git-authority.mjs'), ['assertIntegratedWorkerCommit']],
  [stateModule('evidence/task-packets.mjs'), [importedAs('readTaskPacketSidecar', 'readBoundTaskPacketSidecar')]],
  [stateModule('evidence/worker-results.mjs'), ['readAcceptedWorkerResult']],
]));
PRODUCTION_STATE_IMPORTS.set('checkpoint.mjs', new Map([
  ['node:fs', ['readFileSync']],
  ['node:util', ['isDeepStrictEqual']],
  [stateModule('atomic-io.mjs'), ['atomicWriteJson', 'atomicWriteText']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('journal.mjs'), ['appendEvent', 'prepareEvent']],
  [stateModule('locations.mjs'), ['statePath']],
  [stateModule('locks.mjs'), ['withStateLock']],
  [stateModule('state-store.mjs'), ['activePrNumber', 'loadState', 'validateStateForWrite']],
  [stateModule('transition-policy.mjs'), ['createTransitionPolicy']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/review.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestGate', 'reviewRequestUsage', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/review-policy.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestUsage', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/completion.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['completionGate', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/validation.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['parseTargetedValidationCommand', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/tasks.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['staleDiscoveryDispositionId', 'taskHasCanonicalThreadCoverage', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/git-metadata.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestUsage', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('transitions/transactional-evidence.mjs', new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestUsage', 'validatePrReviewState']],
  [stateModule('errors.mjs'), ['StateError']],
]));
PRODUCTION_STATE_IMPORTS.set('services/review.mjs', new Map([
  ['node:fs', ['existsSync', 'readFileSync']],
  ['node:path', ['join']],
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['reviewRequestGate', 'reviewRequestUsage']],
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('locations.mjs'), ['stateDirectory']],
  [stateModule('state-store.mjs'), ['activePrNumber', 'loadState']],
  [stateModule('services/completion.mjs'), ['gitAwareGateContext']],
  [stateModule('transitions/review.mjs'), ['buildReviewOutcomeTransition', 'buildReviewRequestTransition', 'buildVerificationEscalationTransition']],
  [stateModule('transitions/review-policy.mjs'), ['buildReviewRequestLimitTransition']],
]));
PRODUCTION_STATE_IMPORTS.set('services/completion.mjs', new Map([
  [join(repositoryDirectory, 'scripts', 'lib', 'git.mjs'), ['runGit']],
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['completionGate']],
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('git-authority.mjs'), ['gitSnapshot']],
  [stateModule('state-store.mjs'), ['activePrNumber']],
  [stateModule('transitions/completion.mjs'), ['buildCompletionTransition']],
]));
PRODUCTION_STATE_IMPORTS.set('services/git-metadata.mjs', new Map([
  ['node:path', ['join', 'resolve']],
  [join(scriptsDirectory, 'paths.mjs'), ['repositoryRoot']],
  [stateModule('atomic-io.mjs'), ['atomicWriteJson']],
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction']],
  [stateModule('git-authority.mjs'), ['gitSnapshot']],
  [stateModule('locations.mjs'), ['stateDirectory']],
  [stateModule('state-store.mjs'), ['activePrNumber']],
  [stateModule('transitions/git-metadata.mjs'), ['buildGitMetadataTransition']],
]));
PRODUCTION_STATE_IMPORTS.set('services/archive-import.mjs', new Map([
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('state-store.mjs'), ['activePrNumber']],
  [stateModule('transitions/tasks.mjs'), ['completeIntegratedTasks']],
]));
PRODUCTION_STATE_IMPORTS.set('services/validation.mjs', new Map([
  ['node:child_process', ['spawnSync']],
  [stateModule('atomic-io.mjs'), ['canonicalJson']],
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction', 'checkpointStateTransaction']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('evidence/validation-plans.mjs'), ['actionableIntegratedTaskIds', 'actionablePacketValidationTaskIds', 'assertCleanExactIntegrationHead', 'buildTargetedValidationPlanUnlocked', 'executeTargetedValidationFacts', 'isCleanTasklessReviewValidationRecovery', 'isNativeTasklessPendingReviewHeadDriftValidationRecovery', 'isNativeTasklessReviewHeadDriftValidationRecovery', 'readV2CompletedTaskValidationRecoveryEvidence', 'readValidationPlan']],
  [stateModule('state-store.mjs'), ['activePrNumber', 'loadState']],
  [stateModule('transitions/review.mjs'), ['buildReviewOutcomeTransition']],
  [stateModule('transitions/validation.mjs'), ['buildCiValidationTransition', 'buildTargetedValidationTransition']],
  [stateModule('transitions/transactional-evidence.mjs'), ['buildTargetedValidationResetTransition']],
]));
PRODUCTION_STATE_IMPORTS.set('services/tasks.mjs', new Map([
  ['node:fs', ['existsSync']],
  ['node:path', ['join', 'resolve']],
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['validateTaskPacket']],
  [stateModule('atomic-io.mjs'), ['canonicalSerializedJson', 'readJsonSidecar']],
  [stateModule('checkpoint.mjs'), ['checkpointProtectedStateTransaction']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('git-authority.mjs'), ['assertIntegratedWorkerCommit']],
  [stateModule('locations.mjs'), ['stateDirectory', 'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath']],
  [stateModule('migrations.mjs'), ['migratePrReviewStateV2']],
  [stateModule('recovery.mjs'), [importedAs('truncate', 'truncateSummary')]],
  [stateModule('state-store.mjs'), ['activePrNumber', 'loadState', 'readStateDocument']],
  [stateModule('evidence/task-binding.mjs'), ['assertBehaviorMapperPlanningComplete', 'buildTaskBindingProvenance', 'persistImmutableTaskBindingProvenance', 'readBoundTaskBindingProvenance', 'recoverHistoricalTaskBindingPlanning']],
  [stateModule('evidence/task-packets.mjs'), ['assertTaskPacketHead', 'persistImmutableTaskPacketSidecar', importedAs('readTaskPacketSidecar', 'readBoundTaskPacketSidecar'), 'taskPacketDigest']],
  [stateModule('evidence/worker-results.mjs'), ['persistWorkerResultEvidence', 'proveWorkerResultEvidence', 'readAcceptedWorkerResult']],
  [stateModule('evidence/validation-plans.mjs'), ['isNativeTasklessPendingReviewHeadDriftValidationRecovery']],
  [stateModule('transitions/review-policy.mjs'), ['reviewLimitNextAction']],
  [stateModule('transitions/tasks.mjs'), ['completeIntegratedTasks']],
  [stateModule('transitions/transactional-evidence.mjs'), ['buildTaskPacketBindingTransition', 'buildTaskPacketReplanTransition', 'buildWorkerResultTransition']],
]));

const PRODUCTION_STATE_EXPORTS = new Map([
  ['errors.mjs', ['StateError']],
  ['atomic-io.mjs', ['serializeJson', 'canonicalJson', 'canonicalSerializedJson', 'atomicWriteText', 'atomicWriteJson', 'readJsonSidecar']],
  ['locations.mjs', ['parsePrNumber', 'stateDirectory', 'statePath', 'validationPlanPath', 'taskPacketSidecarPath', 'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'workerResultEnvelopePath', 'workerResultReceiptPath', 'specialistReviewBundlePath', 'specialistPlanReceiptPath', 'activePointerPath', 'lockPath', 'requestOwnerLockPath', 'legacyLockPath', 'legacyRequestOwnerLockPath']],
  ['locks.mjs', ['withStateLock', 'withGitHubRequestOwnerLock']],
  ['journal.mjs', ['prepareEvent', 'appendEvent', 'ensureGitHubMutationIntent']],
  ['git-authority.mjs', ['inspectWorkerCommitAuthority', 'assertIntegratedWorkerCommit', 'gitSnapshot']],
  ['migrations.mjs', ['validateIntegrationMap', 'migrateTaskV1', 'migrateValidationProof', 'migratePrReviewStateV2', 'migratePrReviewStateV1', 'migrateState']],
  ['state-store.mjs', ['ACTIVE_STATE_LIMIT_BYTES', 'validateStateForWrite', 'readStateDocument', 'parseState', 'activePrNumber', 'locateState', 'loadState', 'claimGitHubMutationDispatch', 'originRepository', 'initializeState']],
  ['evidence/task-packets.mjs', ['taskPacketDigest', 'persistImmutableTaskPacketSidecar', 'readTaskPacketSidecar', 'hasCompletedHistoricalV2TaskProof', 'assertTaskPacketHead', 'assertBoundTaskPacket', 'assertTaskPacketBound']],
  ['evidence/specialist-bundle-store.mjs', ['specialistPlanningErrors', 'specialistRouteFor', 'specialistPhaseForStage', 'normalizedRequiredSpecialistIds', 'canonicalBundleTaskRoute', 'specialistPlanDigest', 'verifySpecialistPlanReceipt', 'persistSpecialistPlanReceipt', 'conciseSpecialistPayloadErrors', 'validateSpecialistBundle', 'readSpecialistBundle', 'writeNewSpecialistBundle']],
  ['evidence/task-binding.mjs', ['loadBoundTaskPackets', 'assertTaskPacketBound', 'assertBehaviorMapperBundleComplete', 'assertBehaviorMapperPlanningComplete', 'recoverHistoricalTaskBindingPlanning', 'taskBindingProvenanceDigest', 'verifyTaskBindingProvenanceReceipt', 'persistTaskBindingProvenanceReceipt', 'validateTaskBindingProvenance', 'buildTaskBindingProvenance', 'assertTaskBindingProvenanceSource', 'persistImmutableTaskBindingProvenance', 'readBoundTaskBindingProvenance', 'loadBoundTaskPacketEntries']],
  ['evidence/worker-results.mjs', ['buildWorkerResultEnvelope', 'workerResultEnvelopeDigest', 'verifyWorkerResultReceipt', 'persistWorkerResultEvidence', 'readAcceptedWorkerResult', 'proveWorkerResultEvidence']],
  ['evidence/specialist-bundles.mjs', ['planSpecialists', 'recordSpecialistReview', 'specialistContext', 'readSpecialistStatus']],
  ['evidence/validation-plans.mjs', ['relatedE2EMetadata', 'validateValidationPlan', 'readValidationPlan', 'assertCleanExactIntegrationHead', 'actionableIntegratedTaskIds', 'actionablePacketValidationTaskIds', 'isPristineTasklessValidationSelection', 'isCleanTasklessReviewValidationRecovery', 'hasRemainingReviewAllowance', 'isNativeTasklessReviewHeadDriftValidationRecovery', 'isNativeTasklessPendingReviewHeadDriftValidationRecovery', 'readV2CompletedTaskValidationRecoveryEvidence', 'buildTargetedValidationPlanUnlocked', 'executeTargetedValidationFacts']],
  ['reconciliation.mjs', ['reconcileState']],
  ['recovery.mjs', ['truncate', 'validationPlanRecoverySummary', 'staleDiscoveryRecoverySummary', 'renderRecoverySummary']],
  ['archive.mjs', ['archiveState']],
  ['state.mjs', [
    'completionGate', 'reviewRequestGate', 'reviewRequestUsage', 'gitCommonDirectory',
    'repositoryRoot', 'reviewRoot', 'StateError', 'activePointerPath',
    'specialistPlanReceiptPath', 'specialistReviewBundlePath', 'stateDirectory', 'statePath',
    'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath',
    'validationPlanPath', 'workerResultEnvelopePath', 'workerResultReceiptPath', 'atomicWriteJson',
    'inspectWorkerCommitAuthority', 'appendEvent', 'claimGitHubMutationDispatch',
    'ensureGitHubMutationIntent', 'migratePrReviewStateV1', 'migratePrReviewStateV2', 'migrateState',
    'activePrNumber', 'initializeState', 'loadState', 'locateState', 'archiveState',
    'assertTaskPacketBound', 'loadBoundTaskPackets', 'planSpecialists', 'readSpecialistStatus',
    'recordSpecialistReview', 'specialistContext', 'taskPacketDigest', 'reconcileState',
    'renderRecoverySummary', 'withGitHubRequestOwnerLock', 'withStateLock', 'ACTIVE_STATE_LIMIT_BYTES',
    'assertReviewRequestAllowed', 'assertCompletionAllowed', 'gitAwareGateContext',
    'buildTargetedValidationPlan', 'checkpointState', 'checkpointReviewRequestLimit',
    'buildReviewRequestTransition', 'buildReviewOutcomeTransition',
    'buildVerificationEscalationTransition', 'buildCompletionTransition', 'buildCiValidationTransition',
    'checkpointTargetedValidationReset', 'checkpointTargetedValidation',
    'executeTargetedValidationPlan', 'completeIntegratedTasks', 'checkpointTaskPacketReplan',
    'checkpointTaskPacketBinding', 'checkpointWorkerResultAcceptance', 'checkpointWorkerResultBackfill',
    'checkpointReviewRequest', 'checkpointReviewOutcome', 'checkpointVerificationEscalation',
    'checkpointCompletion', 'checkpointCiValidation', 'checkpointTaskCompletion',
    'checkpointArchiveTaskCompletion', 'checkpointGitMetadata',
  ]],
]);

PRODUCTION_STATE_EXPORTS.set('transition-policy.mjs', ['createTransitionPolicy']);
PRODUCTION_STATE_EXPORTS.set('checkpoint.mjs', [
  'checkpointState', 'checkpointProtectedState', 'checkpointStateTransaction',
  'checkpointProtectedStateTransaction',
]);
PRODUCTION_STATE_EXPORTS.set('transitions/review.mjs', [
  'buildReviewRequestTransition', 'buildReviewOutcomeTransition',
  'buildVerificationEscalationTransition',
]);
PRODUCTION_STATE_EXPORTS.set('transitions/review-policy.mjs', [
  'reviewLimitNextAction', 'triageNextAction', 'buildReviewRequestLimitTransition',
]);
PRODUCTION_STATE_EXPORTS.set('transitions/completion.mjs', ['buildCompletionTransition']);
PRODUCTION_STATE_EXPORTS.set('transitions/validation.mjs', [
  'buildTargetedValidationTransition', 'buildCiValidationTransition',
]);
PRODUCTION_STATE_EXPORTS.set('transitions/tasks.mjs', ['completeIntegratedTasks']);
PRODUCTION_STATE_EXPORTS.set('transitions/git-metadata.mjs', ['buildGitMetadataTransition']);
PRODUCTION_STATE_EXPORTS.set('transitions/transactional-evidence.mjs', [
  'buildTaskPacketReplanTransition', 'buildTaskPacketBindingTransition',
  'buildWorkerResultTransition', 'buildTargetedValidationResetTransition',
]);
PRODUCTION_STATE_EXPORTS.set('services/review.mjs', [
  'assertReviewRequestAllowed', 'checkpointReviewRequestLimit', 'checkpointReviewRequest',
  'checkpointReviewOutcome', 'checkpointVerificationEscalation',
]);
PRODUCTION_STATE_EXPORTS.set('services/completion.mjs', [
  'assertCompletionAllowed', 'gitAwareGateContext', 'checkpointCompletion',
]);
PRODUCTION_STATE_EXPORTS.set('services/git-metadata.mjs', ['checkpointGitMetadata']);
PRODUCTION_STATE_EXPORTS.set('services/archive-import.mjs', ['checkpointArchiveTaskCompletion']);
PRODUCTION_STATE_EXPORTS.set('services/validation.mjs', [
  'buildTargetedValidationPlan', 'checkpointTargetedValidationReset',
  'checkpointTargetedValidation', 'executeTargetedValidationPlan', 'checkpointCiValidation',
]);
PRODUCTION_STATE_EXPORTS.set('services/tasks.mjs', [
  'checkpointTaskPacketReplan', 'checkpointTaskPacketBinding',
  'checkpointWorkerResultAcceptance', 'checkpointWorkerResultBackfill',
  'checkpointTaskCompletion',
]);

const STATE_FACADE_SOURCE_EXPORTS = new Map([
  [join(scriptsDirectory, 'contracts', 'contracts.mjs'), ['completionGate', 'reviewRequestGate', 'reviewRequestUsage']],
  [join(scriptsDirectory, 'paths.mjs'), ['gitCommonDirectory', 'repositoryRoot', 'reviewRoot']],
  [stateModule('errors.mjs'), ['StateError']],
  [stateModule('locations.mjs'), ['activePointerPath', 'specialistPlanReceiptPath', 'specialistReviewBundlePath', 'stateDirectory', 'statePath', 'taskBindingProvenancePath', 'taskBindingProvenanceReceiptPath', 'taskPacketSidecarPath', 'validationPlanPath', 'workerResultEnvelopePath', 'workerResultReceiptPath']],
  [stateModule('atomic-io.mjs'), ['atomicWriteJson']],
  [stateModule('git-authority.mjs'), ['inspectWorkerCommitAuthority']],
  [stateModule('journal.mjs'), ['appendEvent', 'ensureGitHubMutationIntent']],
  [stateModule('migrations.mjs'), ['migratePrReviewStateV1', 'migratePrReviewStateV2', 'migrateState']],
  [stateModule('state-store.mjs'), ['activePrNumber', 'claimGitHubMutationDispatch', 'initializeState', 'loadState', 'locateState', 'ACTIVE_STATE_LIMIT_BYTES']],
  [stateModule('archive.mjs'), ['archiveState']],
  [stateModule('evidence/task-binding.mjs'), ['assertTaskPacketBound', 'loadBoundTaskPackets']],
  [stateModule('evidence/specialist-bundles.mjs'), ['planSpecialists', 'readSpecialistStatus', 'recordSpecialistReview', 'specialistContext']],
  [stateModule('evidence/task-packets.mjs'), ['taskPacketDigest']],
  [stateModule('reconciliation.mjs'), ['reconcileState']],
  [stateModule('recovery.mjs'), ['renderRecoverySummary']],
  [stateModule('locks.mjs'), ['withGitHubRequestOwnerLock', 'withStateLock']],
  [stateModule('checkpoint.mjs'), ['checkpointState']],
  [stateModule('transitions/review.mjs'), ['buildReviewOutcomeTransition', 'buildReviewRequestTransition', 'buildVerificationEscalationTransition']],
  [stateModule('transitions/completion.mjs'), ['buildCompletionTransition']],
  [stateModule('transitions/validation.mjs'), ['buildCiValidationTransition']],
  [stateModule('transitions/tasks.mjs'), ['completeIntegratedTasks']],
  [stateModule('services/review.mjs'), ['assertReviewRequestAllowed', 'checkpointReviewOutcome', 'checkpointReviewRequest', 'checkpointReviewRequestLimit', 'checkpointVerificationEscalation']],
  [stateModule('services/completion.mjs'), ['assertCompletionAllowed', 'checkpointCompletion', 'gitAwareGateContext']],
  [stateModule('services/git-metadata.mjs'), ['checkpointGitMetadata']],
  [stateModule('services/archive-import.mjs'), ['checkpointArchiveTaskCompletion']],
  [stateModule('services/validation.mjs'), ['buildTargetedValidationPlan', 'checkpointCiValidation', 'checkpointTargetedValidation', 'checkpointTargetedValidationReset', 'executeTargetedValidationPlan']],
  [stateModule('services/tasks.mjs'), ['checkpointTaskCompletion', 'checkpointTaskPacketBinding', 'checkpointTaskPacketReplan', 'checkpointWorkerResultAcceptance', 'checkpointWorkerResultBackfill']],
]);

const PRODUCTION_STATE_SOURCE_EXPORTS = new Map([
  ['state.mjs', STATE_FACADE_SOURCE_EXPORTS],
]);

const PROTECTED_STATE_AUTHORITY_PATTERN = /^(?:checkpoint|build.*Transition$|completeIntegratedTasks$)/u;

const EVIDENCE_CALLBACK_CAPABILITIES = new Map([
  ['evidence/specialist-bundles.mjs', [
    { owner: 'planSpecialists', parameterIndex: 0, property: 'now', local: 'now', callShape: 'direct', calls: 1, closure: 'withStateLock' },
    { owner: 'recordSpecialistReview', parameterIndex: 0, property: 'now', local: 'now', callShape: 'direct', calls: 1, closure: 'withStateLock' },
  ]],
  ['evidence/validation-plans.mjs', [
    { owner: 'buildTargetedValidationPlanUnlocked', parameterIndex: 0, property: 'now', local: 'now', callShape: 'direct', calls: 1 },
    { owner: 'executeTargetedValidationFacts', parameterIndex: 0, property: 'beforeCommand', local: 'beforeCommand', callShape: 'optional-direct', calls: 1 },
    { owner: 'executeTargetedValidationFacts', parameterIndex: 0, property: 'runCommand', local: 'runCommand', callShape: 'direct', calls: 1 },
    { owner: 'executeTargetedValidationFacts', parameterIndex: 0, property: 'now', local: 'now', callShape: 'direct', calls: 1 },
    { owner: 'executeTargetedValidationFacts', parameterIndex: 0, property: 'onCommandRecorded', local: 'onCommandRecorded', callShape: 'optional-direct', calls: 1 },
  ]],
  ['evidence/worker-results.mjs', [
    { owner: 'persistWorkerResultEvidence', parameterIndex: 4, property: null, local: 'onStep', callShape: 'optional-direct', calls: 2 },
  ]],
]);

const STATE_ADAPTER_OPERATIONS = [
  'checkpointCiValidation',
  'checkpointCompletion',
  'checkpointReviewOutcome',
  'checkpointReviewRequest',
  'checkpointTaskCompletion',
  'checkpointVerificationEscalation',
  'loadState',
  'readSpecialistStatus',
];

const PRODUCTION_GITHUB_IMPORTS = new Map([
  ['errors.mjs', new Map()],
  ['graphql/operations.mjs', new Map()],
  ['graphql/client.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('graphql/operations.mjs'), ['OPERATIONS']],
  ])],
  ['graphql/pull-request-reader.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('graphql/client.mjs'), ['MAX_NODES', 'MAX_PAGES', 'execute', 'paginate']],
  ])],
  ['evidence/primitives.mjs', new Map()],
  ['evidence/actors.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
  ])],
  ['evidence/ci.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/primitives.mjs'), ['httpsUrl']],
  ])],
  ['evidence/review-response.mjs', new Map([
    ['node:crypto', ['createHash']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['actorObservation', 'isCanonicalActor']],
  ])],
  ['status-renderer.mjs', new Map()],
  ['mutation-journal.mjs', new Map([
    ['node:fs', ['existsSync', 'readFileSync']],
    ['node:path', ['join']],
    [join(scriptsDirectory, 'state', 'state.mjs'), [
      'claimGitHubMutationDispatch', 'ensureGitHubMutationIntent', 'stateDirectory',
      'withGitHubRequestOwnerLock',
    ]],
  ])],
  ['adapters/gh-cli.mjs', new Map([
    ['node:child_process', ['execFileSync']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
  ])],
  ['adapters/git.mjs', new Map([
    ['node:child_process', ['execFileSync']],
    ['node:fs', ['lstatSync']],
    ['node:path', ['join']],
  ])],
  ['adapters/state.mjs', new Map([
    [join(scriptsDirectory, 'state', 'state.mjs'), STATE_ADAPTER_OPERATIONS],
  ])],
  ['snapshot.mjs', new Map([
    [githubModule('evidence/actors.mjs'), ['isCanonicalActor']],
    [githubModule('graphql/pull-request-reader.mjs'), [
      importedAs('readLiveSnapshot', 'readPullRequestLiveSnapshot'),
    ]],
  ])],
  ['mutation-readiness.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
  ])],
  ['threads/canonical-roots.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
  ])],
  ['threads/replies.mjs', new Map([
    ['node:crypto', ['createHash']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['isViewerActor']],
  ])],
  ['mutations/thread-reply-resolve.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('graphql/client.mjs'), ['executeMutation']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/replies.mjs'), ['deterministicReply', 'exactRepliesFor', 'intentFor']],
  ])],
  ['threads/recovery.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['isViewerActor']],
    [githubModule('mutations/thread-reply-resolve.mjs'), ['lookupThreadMutationIntent']],
    [githubModule('threads/replies.mjs'), [
      'AGGREGATE_REPLY_HEADER_PATTERN', 'replyMarker', 'replyTaskLine',
    ]],
  ])],
  ['threads/proof.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:util', ['isDeepStrictEqual']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['isViewerActor']],
    [githubModule('threads/canonical-roots.mjs'), ['buildCanonicalRootPlan', 'dispositionForTask']],
    [githubModule('threads/recovery.mjs'), ['assertPriorHeadRecoveryLive']],
    [githubModule('threads/replies.mjs'), [
      'AGGREGATE_REPLY_HEADER_PATTERN', 'FULL_GIT_SHA_PATTERN',
      'aggregateHistoricalReplyBodyIsAdmissible', 'exactRepliesFor', 'replyMarker',
    ]],
  ])],
  ['archive/store.mjs', new Map([
    ['node:fs', [
      importedAs('constants', 'fsConstants'), 'closeSync', 'fstatSync', 'lstatSync', 'openSync',
      'readdirSync', 'readFileSync', 'statSync',
    ]],
    ['node:path', ['join']],
    ['node:worker_threads', ['isMainThread']],
    [join(scriptsDirectory, 'state', 'state.mjs'), ['reviewRoot']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
  ])],
  ['archive/evidence.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:util', ['isDeepStrictEqual']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['isCanonicalActor', 'isViewerActor']],
    [githubModule('evidence/primitives.mjs'), ['httpsUrl']],
    [githubModule('evidence/review-response.mjs'), ['canonicalJson']],
    [githubModule('graphql/client.mjs'), ['MAX_NODES']],
    [githubModule('threads/replies.mjs'), ['deterministicReply', 'intentFor']],
  ])],
  ['archive/lineage.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:util', ['isDeepStrictEqual']],
    [contractModule('contracts.mjs'), ['validatePrReviewState']],
    [githubModule('archive/evidence.mjs'), [
      'archiveBatchProofProjection', 'archiveContentFingerprint', 'assertArchiveEventList',
      'assertArchiveInventory', 'assertArchiveReplyBody', 'assertTerminalArchive', 'parsedTime',
      'projectedArchivedTask', 'stableCommentEvidence', 'validateArchiveBatchLive',
    ]],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/review-response.mjs'), ['canonicalJson']],
    [githubModule('graphql/client.mjs'), ['MAX_NODES']],
    [githubModule('threads/replies.mjs'), ['aggregateHistoricalReplyBodyIsAdmissible', 'intentFor']],
  ])],
  ['archive/adoption.mjs', new Map([
    ['node:crypto', ['createHash']],
    ['node:util', ['isDeepStrictEqual']],
    [githubModule('archive/lineage.mjs'), ['selectArchiveForBatch', 'validateArchiveBatchLineage']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/review-response.mjs'), ['canonicalJson']],
    [githubModule('threads/canonical-roots.mjs'), ['buildCanonicalRootPlan', 'canonicalRootsForTask']],
    [githubModule('threads/proof.mjs'), ['buildThreadProof']],
  ])],
  ['mutations/draft-review-request.mjs', new Map([
    [contractModule('contracts.mjs'), ['reviewRequestGate']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['actorObservation', 'isViewerActor']],
    [githubModule('graphql/client.mjs'), ['MAX_NODES', 'executeMutation']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady', 'assertPullRequestReady']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/proof.mjs'), ['assertLiveThreadProof']],
    [githubModule('threads/replies.mjs'), ['intentFor']],
  ])],
  ['workflow/context.mjs', new Map([
    [contractModule('contracts.mjs'), ['validatePrReviewState']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
  ])],
  ['workflow/refresh-threads.mjs', new Map([
    [contractModule('contracts.mjs'), ['buildStaleDiscoveryDisposition', 'reviewRequestUsage']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/review-response.mjs'), ['classifyPendingReviewResponse']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/draft-review-request.mjs'), ['assertRecordedRequestComment']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/canonical-roots.mjs'), ['buildCanonicalRootPlan']],
  ])],
  ['workflow/status.mjs', new Map([
    [contractModule('contracts.mjs'), ['reviewRequestUsage']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/ci.mjs'), ['ciEvidenceFromRollup']],
    [githubModule('evidence/review-response.mjs'), ['classifyPendingReviewResponse']],
    [githubModule('graphql/pull-request-reader.mjs'), ['readPullRequestChecks']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/draft-review-request.mjs'), ['assertRecordedRequestComment']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('workflow/refresh-threads.mjs'), ['tasklessPendingReviewHeadDriftRefreshAllowed']],
  ])],
  ['workflow/request.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/draft-review-request.mjs'), ['lookupOptionalMutationJournalIntent']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
  ])],
  ['workflow/collect.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/review-response.mjs'), ['classifyPendingReviewResponse']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/draft-review-request.mjs'), [
      'assertRecordedRequestComment', 'requestAnchorObservation',
    ]],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('workflow/refresh-threads.mjs'), ['samePendingResponseObservation']],
  ])],
  ['workflow/resolve.mjs', new Map([
    ['node:util', ['isDeepStrictEqual']],
    [join(scriptsDirectory, 'state', 'state.mjs'), ['checkpointArchiveTaskCompletion']],
    [githubModule('archive/adoption.mjs'), [
      'adoptArchiveBatch', 'archiveAdoptionVerifierBootstrapPlan', 'archiveBatchAdoptionReady',
    ]],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('graphql/client.mjs'), ['executeMutation']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/thread-reply-resolve.mjs'), [
      'lookupThreadMutationIntent', 'postThreadReply', 'resolveThread',
    ]],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/canonical-roots.mjs'), ['buildCanonicalRootPlan']],
    [githubModule('threads/proof.mjs'), [
      'assertExistingThreadProof', 'assertLiveThreadProof', 'assertRecordedThreadsLive',
      'buildThreadProof',
    ]],
    [githubModule('threads/recovery.mjs'), [
      'assertPriorHeadRecoveryLive', 'journaledPriorHeadRecovery',
    ]],
    [githubModule('threads/replies.mjs'), ['exactRepliesFor']],
  ])],
  ['workflow/collect-ci.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/ci.mjs'), ['ciEvidenceFromRollup']],
    [githubModule('graphql/pull-request-reader.mjs'), ['readPullRequestChecks', 'readPullRequestMetadata']],
    [githubModule('mutation-readiness.mjs'), ['assertPullRequestReady']],
  ])],
  ['workflow/complete.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['isCanonicalActor']],
    [githubModule('evidence/ci.mjs'), ['ciEvidenceFromRollup']],
    [githubModule('evidence/review-response.mjs'), [
      'classifyPendingReviewResponse', 'classifyReviewSubmission', 'classifyStructuralIssueComments',
    ]],
    [githubModule('graphql/pull-request-reader.mjs'), ['readPullRequestChecks']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady']],
    [githubModule('mutations/draft-review-request.mjs'), ['assertRecordedRequestComment', 'sameTimestamp']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/proof.mjs'), ['assertLiveThreadProof']],
    [githubModule('workflow/collect-ci.mjs'), ['sameCiEvidence']],
    [githubModule('workflow/refresh-threads.mjs'), ['samePendingResponseObservation']],
  ])],
  ['workflow/advance.mjs', new Map([
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/ci.mjs'), ['ciEvidenceFromRollup']],
    [githubModule('evidence/review-response.mjs'), ['classifyPendingReviewResponse']],
    [githubModule('graphql/pull-request-reader.mjs'), ['readPullRequestChecks']],
    [githubModule('mutation-readiness.mjs'), ['assertMutationReady', 'assertPullRequestReady']],
    [githubModule('mutations/draft-review-request.mjs'), ['assertRecordedRequestComment']],
    [githubModule('snapshot.mjs'), ['readLiveSnapshot']],
    [githubModule('threads/proof.mjs'), ['assertLiveThreadProof']],
    [githubModule('workflow/complete.mjs'), ['isTransientCiError']],
    [githubModule('workflow/refresh-threads.mjs'), ['samePendingResponseObservation']],
  ])],
  ['create-workflow.mjs', new Map([
    [githubModule('mutations/draft-review-request.mjs'), ['createRequestReviewUnlocked']],
    [githubModule('workflow/advance.mjs'), ['createAdvanceUseCase']],
    [githubModule('workflow/collect-ci.mjs'), ['createCollectCiUseCase']],
    [githubModule('workflow/collect.mjs'), ['createCollectUseCase']],
    [githubModule('workflow/complete.mjs'), ['createCompletionUseCases']],
    [githubModule('workflow/context.mjs'), ['createWorkflowContext']],
    [githubModule('workflow/refresh-threads.mjs'), ['createRefreshThreadsUseCase']],
    [githubModule('workflow/request.mjs'), ['createRequestUseCase']],
    [githubModule('workflow/resolve.mjs'), ['createResolveUseCases']],
    [githubModule('workflow/status.mjs'), ['createStatusUseCase']],
  ])],
  ['github.mjs', new Map([
    [githubModule('create-workflow.mjs'), ['createGitHubReviewWorkflow']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('evidence/actors.mjs'), ['CANONICAL_LOGIN', 'CANONICAL_URL']],
    [githubModule('evidence/ci.mjs'), [
      'FULL_VALIDATION_CHECK', 'FULL_VALIDATION_WORKFLOW', 'FULL_VALIDATION_WORKFLOW_PATH',
      'GITHUB_ACTIONS_APP',
    ]],
    [githubModule('graphql/operations.mjs'), ['PAGE_SIZE']],
    [githubModule('graphql/pull-request-reader.mjs'), [
      'readPullRequestChecks', 'readPullRequestMetadata', 'readRequestReactions',
      'readReviewThreads', 'readReviews', 'readThreadComments', 'readTopLevelComments',
    ]],
    [githubModule('mutations/draft-review-request.mjs'), ['REQUEST_BODY']],
  ])],
  ['cli.mjs', new Map([
    ['node:url', ['pathToFileURL']],
    [join(repositoryDirectory, 'scripts', 'lib', 'cli.mjs'), ['UsageError', 'parseOptions', 'writeJson']],
    [githubModule('adapters/gh-cli.mjs'), ['buildGhGraphqlArgs', 'createDefaultGitHubClient']],
    [githubModule('adapters/git.mjs'), ['createDefaultGitAdapter']],
    [githubModule('adapters/state.mjs'), ['createDefaultStateAdapter']],
    [githubModule('archive/store.mjs'), ['createDefaultArchiveStore', 'terminateOnFatalArchiveCwd']],
    [githubModule('create-workflow.mjs'), ['createGitHubReviewWorkflow']],
    [githubModule('errors.mjs'), ['GitHubWorkflowError']],
    [githubModule('mutation-journal.mjs'), ['createDefaultMutationJournal']],
    [githubModule('status-renderer.mjs'), ['renderHumanStatus']],
  ])],
]);

const PRODUCTION_GITHUB_EXPORTS = new Map([
  ['errors.mjs', ['GitHubWorkflowError']],
  ['graphql/operations.mjs', ['OPERATIONS', 'PAGE_SIZE']],
  ['graphql/client.mjs', [
    'MAX_NODES', 'MAX_PAGES', 'MIN_GRAPHQL_REMAINING', 'assertGraphqlResult', 'execute',
    'executeMutation', 'paginate',
  ]],
  ['graphql/pull-request-reader.mjs', [
    'readLiveSnapshot', 'readPullRequestChecks', 'readPullRequestMetadata', 'readRequestReactions',
    'readReviewThreads', 'readReviews', 'readThreadComments', 'readTopLevelComments',
  ]],
  ['evidence/primitives.mjs', ['httpsUrl']],
  ['evidence/actors.mjs', [
    'CANONICAL_LOGIN', 'CANONICAL_URL', 'actorObservation', 'isCanonicalActor', 'isViewerActor',
  ]],
  ['evidence/ci.mjs', [
    'FULL_VALIDATION_CHECK', 'FULL_VALIDATION_WORKFLOW', 'FULL_VALIDATION_WORKFLOW_PATH',
    'GITHUB_ACTIONS_APP', 'ciEvidenceFromRollup',
  ]],
  ['evidence/review-response.mjs', [
    'canonicalJson', 'canonicalRootEvidence', 'canonicalRootState', 'classifyPendingReviewResponse',
    'classifyReviewSubmission', 'classifyStructuralIssueComments', 'outcomeFromCanonicalResponse',
    'responseFingerprint', 'responseObservation',
  ]],
  ['status-renderer.mjs', ['renderHumanStatus']],
  ['mutation-journal.mjs', ['createDefaultMutationJournal']],
  ['adapters/gh-cli.mjs', ['buildGhGraphqlArgs', 'createDefaultGitHubClient']],
  ['adapters/git.mjs', ['createDefaultGitAdapter']],
  ['adapters/state.mjs', ['createDefaultStateAdapter']],
  ['snapshot.mjs', ['readLiveSnapshot']],
  ['mutation-readiness.mjs', ['assertMutationReady', 'assertPullRequestReady']],
  ['threads/canonical-roots.mjs', [
    'buildCanonicalRootPlan', 'canonicalRootsForTask', 'dispositionForTask',
  ]],
  ['threads/replies.mjs', [
    'AGGREGATE_REPLY_HEADER_PATTERN', 'FULL_GIT_SHA_PATTERN', 'aggregateHistoricalReplyBody',
    'aggregateHistoricalReplyBodyIsAdmissible', 'deterministicReply', 'exactRepliesFor',
    'intentFor', 'operationToken', 'replyMarker', 'replyTaskLine',
  ]],
  ['mutations/thread-reply-resolve.mjs', [
    'journalThreadMutationIntent', 'lookupThreadMutationIntent', 'postThreadReply',
    'resolveThread', 'threadOperationId',
  ]],
  ['threads/recovery.mjs', [
    'assertPriorHeadRecoveryLive', 'completedThreadlessRecoveryReady',
    'journaledPriorHeadRecovery', 'priorHeadRecoveryCandidate',
  ]],
  ['threads/proof.mjs', [
    'assertExistingThreadProof', 'assertLiveThreadProof', 'assertRecordedReply',
    'assertRecordedThreadsLive', 'buildThreadProof',
  ]],
  ['archive/store.mjs', ['createDefaultArchiveStore', 'terminateOnFatalArchiveCwd']],
  ['archive/evidence.mjs', [
    'archiveBatchProofProjection', 'archiveContentFingerprint', 'archiveIntent',
    'assertArchiveEventList', 'assertArchiveInventory', 'assertArchiveReplyBody',
    'assertTerminalArchive', 'hasExactKeys', 'parsedTime', 'projectedArchivedTask',
    'stableCommentEvidence', 'validateArchiveBatchLive',
  ]],
  ['archive/lineage.mjs', [
    'activeArchiveCarrierKind', 'aggregateAncestryRelations', 'aggregateArchiveIntentFootprint',
    'aggregateAuthorityByRoot', 'aggregateCanonicalRootIndex', 'aggregateFullAuthorityProjection',
    'aggregateHistoricalProjection', 'aggregateInventoryFingerprint', 'aggregateProofCore',
    'aggregateSelectedThreadIds', 'archiveLineageFingerprint',
    'archiveReferencesAnchoredHistoricalTasks', 'archiveReferencesSelectedRoots',
    'archivedIntentSummaryReference', 'archivedOperationReference', 'assertAggregateReplayCarrier',
    'assertCompleteSelectedArchiveIntentFootprint', 'assertHistoricalCarrierSlice',
    'assertReplayArchiveBounds', 'boundedAggregateSelectedRows', 'eventCarriesSelectedArchiveIntent',
    'exactlyMatchesArchiveIntentCorrelation', 'indexedAggregateArchiveIntentFootprints',
    'normalizedAggregateRootAuthority', 'normalizedArchiveOriginAuthority',
    'selectArchiveForBatch', 'selectLegacyArchiveForBatch', 'selectedArchiveIntentCorrelations',
    'selectedArchiveIntentFootprint', 'selectedCarrierProofRows', 'singleRootProjection',
    'taskCanonicalRootIds', 'unambiguousSelectedArchiveIntentRoot',
    'validateAggregateArchiveLineage', 'validateAggregateRootOrigin',
    'validateArchiveBatchLineage', 'validatedAggregateCarrier',
  ]],
  ['archive/adoption.mjs', [
    'adoptArchiveBatch', 'archiveAdoptionEvidenceMap', 'archiveAdoptionVerifierBootstrapPlan',
    'archiveBatchAdoptionReady', 'archiveBootstrapScaffoldIsPristine',
    'archiveImportCompletionEnvelope', 'immutableSourcesDeclareMultiRootArchiveBatch',
    'prepareArchiveBatchAdoption', 'verificationProofIsPristine',
  ]],
  ['mutations/draft-review-request.mjs', [
    'REQUEST_BODY', 'assertRecordedRequestComment', 'createRequestReviewUnlocked',
    'exactViewerRequestCandidates', 'journalRequestIntent', 'lookupOptionalMutationJournalIntent',
    'lookupRequestJournalIntent', 'parsedTime', 'requestAnchorObservation',
    'requestRecoveryAtOrAfter', 'sameTimestamp',
  ]],
  ['workflow/context.mjs', [
    'createWorkflowContext', 'escalationFor', 'sameEscalationIntent', 'validateWorkflowState',
  ]],
  ['workflow/refresh-threads.mjs', [
    'createRefreshThreadsUseCase', 'dispositionForPendingResponse',
    'samePendingResponseObservation', 'tasklessPendingReviewHeadDriftRefreshAllowed',
    'tasklessReviewHeadDriftRefreshAllowed',
  ]],
  ['workflow/status.mjs', [
    'codexReviewStatus', 'createStatusUseCase', 'reviewObservation',
    'staleDiscoveryNextAction', 'staleDiscoveryStatus',
  ]],
  ['workflow/request.mjs', ['createRequestUseCase']],
  ['workflow/collect.mjs', ['createCollectUseCase', 'sameRequestBoundOutcome']],
  ['workflow/resolve.mjs', [
    'archiveTaskCheckpoint', 'createResolveUseCases', 'normalizeVerifyResolveTaskIds',
    'taskIsEligibleForVerifyResolve',
  ]],
  ['workflow/collect-ci.mjs', ['createCollectCiUseCase', 'sameCiEvidence']],
  ['workflow/complete.mjs', [
    'createCompleteUseCase', 'createCompletionUseCases', 'isTransientCiError',
  ]],
  ['workflow/advance.mjs', ['createAdvanceUseCase']],
  ['create-workflow.mjs', ['createGitHubReviewWorkflow']],
  ['github.mjs', [
    'GitHubWorkflowError', 'createGitHubReviewWorkflow', 'githubReviewConstants',
    'readPullRequestChecks', 'readPullRequestMetadata', 'readRequestReactions', 'readReviewThreads',
    'readReviews', 'readThreadComments', 'readTopLevelComments',
  ]],
  ['cli.mjs', [
    'buildGhGraphqlArgs', 'createDefaultArchiveStore', 'createDefaultGitAdapter',
    'createDefaultGitHubClient', 'renderHumanStatus', 'runCli', 'terminateOnFatalArchiveCwd', 'usage',
  ]],
]);

const FOCUSED_GITHUB_TEST_IMPORTS = new Map([
  ['graphql/operations.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('graphql/operations.mjs'),
  ]],
  ['graphql/client.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('graphql/client.mjs'), githubModule('graphql/operations.mjs'),
  ]],
  ['graphql/pull-request-reader.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('graphql/client.mjs'), githubModule('graphql/pull-request-reader.mjs'),
  ]],
  ['evidence/actors.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('evidence/actors.mjs'),
  ]],
  ['evidence/ci.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('evidence/ci.mjs'),
  ]],
  ['evidence/review-response.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('evidence/review-response.mjs'),
  ]],
  ['status-renderer.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('status-renderer.mjs'),
  ]],
  ['mutation-journal.test.mjs', [
    'node:assert/strict', 'node:fs', 'node:os', 'node:path', 'node:test',
    githubModule('mutation-journal.mjs'),
  ]],
  ['adapters/gh-cli.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('adapters/gh-cli.mjs'),
  ]],
  ['adapters/git.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('adapters/git.mjs'),
  ]],
  ['adapters/state.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('adapters/state.mjs'),
  ]],
  ['snapshot.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'), githubModule('snapshot.mjs'),
  ]],
  ['mutation-readiness.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('mutation-readiness.mjs'),
  ]],
  ['threads/canonical-roots.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('threads/canonical-roots.mjs'),
  ]],
  ['threads/replies.test.mjs', [
    'node:assert/strict', 'node:crypto', 'node:test', githubModule('threads/replies.mjs'),
  ]],
  ['mutations/thread-reply-resolve.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('threads/replies.mjs'),
    githubModule('mutations/thread-reply-resolve.mjs'),
  ]],
  ['threads/proof.test.mjs', [
    'node:assert/strict', 'node:crypto', 'node:test', githubModule('threads/proof.mjs'),
    githubModule('threads/replies.mjs'),
  ]],
  ['threads/recovery.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('threads/recovery.mjs'),
    githubModule('threads/replies.mjs'),
  ]],
  ['archive/store.test.mjs', [
    githubModule('archive/store.mjs'), githubModule('test-support/workflow-harness.mjs'),
  ]],
  ['archive/evidence.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('archive/evidence.mjs'),
    githubModule('errors.mjs'), githubModule('test-support/workflow-harness.mjs'),
  ]],
  ['archive/lineage.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('archive/lineage.mjs'),
    githubModule('snapshot.mjs'), githubModule('test-support/workflow-harness.mjs'),
    githubModule('threads/canonical-roots.mjs'),
  ]],
  ['archive/adoption.test.mjs', [
    githubModule('archive/adoption.mjs'), githubModule('snapshot.mjs'),
    githubModule('test-support/workflow-harness.mjs'), githubModule('threads/canonical-roots.mjs'),
  ]],
  ['mutations/draft-review-request.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('mutations/draft-review-request.mjs'),
    githubModule('test-support/workflow-harness.mjs'), githubModule('workflow/context.mjs'),
  ]],
  ['workflow/context.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('errors.mjs'),
    githubModule('test-support/workflow-harness.mjs'), githubModule('workflow/context.mjs'),
  ]],
  ['workflow/status.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/context.mjs'), githubModule('workflow/status.mjs'),
  ]],
  ['workflow/refresh-threads.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/context.mjs'), githubModule('workflow/refresh-threads.mjs'),
  ]],
  ['workflow/request.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('mutations/draft-review-request.mjs'),
    githubModule('test-support/workflow-harness.mjs'), githubModule('workflow/context.mjs'),
    githubModule('workflow/request.mjs'),
  ]],
  ['workflow/collect.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/collect.mjs'), githubModule('workflow/context.mjs'),
  ]],
  ['workflow/resolve.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/context.mjs'), githubModule('workflow/resolve.mjs'),
  ]],
  ['workflow/collect-ci.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/collect-ci.mjs'), githubModule('workflow/context.mjs'),
  ]],
  ['workflow/complete.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/complete.mjs'), githubModule('workflow/context.mjs'),
  ]],
  ['workflow/advance.test.mjs', [
    'node:assert/strict', 'node:test', githubModule('test-support/workflow-harness.mjs'),
    githubModule('workflow/advance.mjs'), githubModule('workflow/collect-ci.mjs'),
    githubModule('workflow/collect.mjs'), githubModule('workflow/complete.mjs'),
    githubModule('workflow/context.mjs'),
  ]],
  ['create-workflow.test.mjs', [
    'node:assert/strict', 'node:fs', 'node:test', githubModule('create-workflow.mjs'),
    githubModule('errors.mjs'),
  ]],
]);

const FOCUSED_GITHUB_TEST_OWNERS = new Map([
  ['graphql/operations.test.mjs', 'graphql/operations.mjs'],
  ['graphql/client.test.mjs', 'graphql/client.mjs'],
  ['graphql/pull-request-reader.test.mjs', 'graphql/pull-request-reader.mjs'],
  ['evidence/actors.test.mjs', 'evidence/actors.mjs'],
  ['evidence/ci.test.mjs', 'evidence/ci.mjs'],
  ['evidence/review-response.test.mjs', 'evidence/review-response.mjs'],
  ['status-renderer.test.mjs', 'status-renderer.mjs'],
  ['mutation-journal.test.mjs', 'mutation-journal.mjs'],
  ['adapters/gh-cli.test.mjs', 'adapters/gh-cli.mjs'],
  ['adapters/git.test.mjs', 'adapters/git.mjs'],
  ['adapters/state.test.mjs', 'adapters/state.mjs'],
  ['snapshot.test.mjs', 'snapshot.mjs'],
  ['mutation-readiness.test.mjs', 'mutation-readiness.mjs'],
  ['threads/canonical-roots.test.mjs', 'threads/canonical-roots.mjs'],
  ['threads/replies.test.mjs', 'threads/replies.mjs'],
  ['mutations/thread-reply-resolve.test.mjs', 'mutations/thread-reply-resolve.mjs'],
  ['threads/proof.test.mjs', 'threads/proof.mjs'],
  ['threads/recovery.test.mjs', 'threads/recovery.mjs'],
  ['archive/store.test.mjs', 'archive/store.mjs'],
  ['archive/evidence.test.mjs', 'archive/evidence.mjs'],
  ['archive/lineage.test.mjs', 'archive/lineage.mjs'],
  ['archive/adoption.test.mjs', 'archive/adoption.mjs'],
  ['mutations/draft-review-request.test.mjs', 'mutations/draft-review-request.mjs'],
  ['workflow/context.test.mjs', 'workflow/context.mjs'],
  ['workflow/status.test.mjs', 'workflow/status.mjs'],
  ['workflow/refresh-threads.test.mjs', 'workflow/refresh-threads.mjs'],
  ['workflow/request.test.mjs', 'workflow/request.mjs'],
  ['workflow/collect.test.mjs', 'workflow/collect.mjs'],
  ['workflow/resolve.test.mjs', 'workflow/resolve.mjs'],
  ['workflow/collect-ci.test.mjs', 'workflow/collect-ci.mjs'],
  ['workflow/complete.test.mjs', 'workflow/complete.mjs'],
  ['workflow/advance.test.mjs', 'workflow/advance.mjs'],
  ['create-workflow.test.mjs', 'create-workflow.mjs'],
]);

function normalizedModuleTarget(importer, specifier) {
  return specifier.startsWith('.') ? resolve(dirname(importer), specifier) : specifier;
}

function namedBindings(importClause) {
  if (!importClause?.namedBindings || !ts.isNamedImports(importClause.namedBindings)) return null;
  return importClause.namedBindings.elements.map((element) => ({
    imported: element.propertyName?.text ?? element.name.text,
    local: element.name.text,
  }));
}

function parseModule(importer, source) {
  return ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function inspectProductionContractSource(importer, source) {
  const errors = [];
  const fileName = posixRelative(contractsDirectory, importer);
  const allowlist = PRODUCTION_CONTRACT_IMPORTS.get(fileName);
  if (!allowlist) return [`unknown production contract module ${fileName}`];
  const parsed = parseModule(importer, source);
  for (const diagnostic of parsed.parseDiagnostics) {
    errors.push(`syntax error: ${diagnostic.messageText}`);
  }

  const exportDeclarations = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('dynamic import is forbidden');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      errors.push('CommonJS require is forbidden');
    }
    if (ts.isIdentifier(node) && node.text === 'createRequire') {
      errors.push('createRequire is forbidden');
    }
    if (ts.isImportEqualsDeclaration(node)) errors.push('CommonJS import assignment is forbidden');
    if (ts.isExportAssignment(node)) errors.push('default export assignment is forbidden');
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : null;
      if (specifier === null) {
        errors.push('import specifier must be a string literal');
        continue;
      }
      const target = normalizedModuleTarget(importer, specifier);
      const expectedNames = allowlist.get(target);
      if (!expectedNames) errors.push(`unapproved dependency ${specifier} resolves to ${target}`);
      if (!statement.importClause) {
        errors.push(`side-effect import is forbidden: ${specifier}`);
        continue;
      }
      if (statement.importClause.name) errors.push(`default import is forbidden: ${specifier}`);
      if (statement.importClause.namedBindings
          && ts.isNamespaceImport(statement.importClause.namedBindings)) {
        errors.push(`namespace import is forbidden: ${specifier}`);
      }
      const bindings = namedBindings(statement.importClause);
      if (bindings === null) continue;
      for (const binding of bindings) {
        if (binding.imported !== binding.local) errors.push(`aliased import is forbidden: ${binding.imported}`);
      }
      if (expectedNames && JSON.stringify(sorted(bindings.map(({ imported }) => imported)))
          !== JSON.stringify(sorted(expectedNames))) {
        errors.push(`named imports from ${specifier} must be exactly ${sorted(expectedNames).join(', ')}`);
      }
    }
    if (ts.isExportDeclaration(statement)) exportDeclarations.push(statement);
  }

  for (const declaration of exportDeclarations) {
    if (!declaration.exportClause || !ts.isNamedExports(declaration.exportClause)) {
      errors.push('export-star is forbidden');
      continue;
    }
    const names = declaration.exportClause.elements.map((element) => element.name.text);
    if (declaration.exportClause.elements.some((element) => (
      element.propertyName && element.propertyName.text !== element.name.text
    ))) errors.push('aliased export is forbidden');
    if (fileName === 'contracts.mjs') {
      if (declaration.moduleSpecifier) errors.push('contracts facade exports must be local');
      if (JSON.stringify(sorted(names)) !== JSON.stringify(sorted(CONTRACT_FACADE_EXPORTS))) {
        errors.push('contracts facade export list is not exact');
      }
    } else if (fileName === 'review-evidence.mjs') {
      const specifier = ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text : null;
      const target = specifier === null ? null : normalizedModuleTarget(importer, specifier);
      if (target !== contractModule('contract-identities.mjs')
          || JSON.stringify(names) !== JSON.stringify(['staleDiscoveryDispositionId'])) {
        errors.push('review-evidence re-export is not exact');
      }
    } else {
      errors.push(`named export declarations are forbidden in ${fileName}`);
    }
  }
  if (fileName === 'contracts.mjs' && exportDeclarations.length !== 1) {
    errors.push('contracts facade must have exactly one explicit export list');
  }
  if (fileName === 'review-evidence.mjs' && exportDeclarations.length !== 1) {
    errors.push('review-evidence must have exactly one explicit identity re-export');
  }
  return errors;
}

function validateProductionContractSource(importer, source) {
  const errors = inspectProductionContractSource(importer, source);
  const expectedTargets = PRODUCTION_CONTRACT_IMPORTS.get(posixRelative(contractsDirectory, importer));
  if (!expectedTargets) return errors;
  const parsed = parseModule(importer, source);
  const actualTargets = parsed.statements.filter(ts.isImportDeclaration).flatMap((statement) => (
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [normalizedModuleTarget(importer, statement.moduleSpecifier.text)] : []
  ));
  if (JSON.stringify(sorted(actualTargets)) !== JSON.stringify(sorted(expectedTargets.keys()))) {
    errors.push('production import targets must exactly match the module allowlist');
  }
  return errors;
}

function expectedBindingPairs(values) {
  return values.map((value) => (
    typeof value === 'string' ? importedAs(value) : value
  ));
}

function bindingKey({ imported, local }) {
  return `${imported}\0${local}`;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function inlineExportNames(statement, errors) {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    errors.push('default export is forbidden');
  }
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (!statement.name) {
      errors.push('exported declaration must have a stable name');
      return [];
    }
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    const names = [];
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        errors.push('exported variable must have a stable identifier');
      } else names.push(declaration.name.text);
    }
    return names;
  }
  errors.push('unsupported exported declaration');
  return [];
}

function inspectProductionGitHubSource(importer, source) {
  const errors = [];
  const fileName = posixRelative(githubDirectory, importer);
  const allowlist = PRODUCTION_GITHUB_IMPORTS.get(fileName);
  const expectedExports = PRODUCTION_GITHUB_EXPORTS.get(fileName);
  if (!allowlist || !expectedExports) return [`unknown production GitHub module ${fileName}`];
  const parsed = parseModule(importer, source);
  for (const diagnostic of parsed.parseDiagnostics) errors.push(`syntax error: ${diagnostic.messageText}`);

  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('dynamic import is forbidden');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') errors.push('CommonJS require is forbidden');
    if (ts.isIdentifier(node) && node.text === 'createRequire') errors.push('createRequire is forbidden');
    if (ts.isImportEqualsDeclaration(node)) errors.push('CommonJS import assignment is forbidden');
    if (ts.isExportAssignment(node)) errors.push('default export assignment is forbidden');
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  const exportDeclarations = [];
  const exports = [];
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : null;
      if (specifier === null) {
        errors.push('import specifier must be a string literal');
        continue;
      }
      const target = normalizedModuleTarget(importer, specifier);
      const expected = allowlist.get(target);
      if (!expected) errors.push(`unapproved GitHub dependency ${specifier} resolves to ${target}`);
      if (!statement.importClause) {
        errors.push(`side-effect import is forbidden: ${specifier}`);
        continue;
      }
      if (statement.importClause.name) errors.push(`default import is forbidden: ${specifier}`);
      if (statement.importClause.namedBindings
          && ts.isNamespaceImport(statement.importClause.namedBindings)) {
        errors.push(`namespace import is forbidden: ${specifier}`);
      }
      const bindings = namedBindings(statement.importClause);
      if (bindings === null) continue;
      if (expected && JSON.stringify(sorted(bindings.map(bindingKey)))
          !== JSON.stringify(sorted(expectedBindingPairs(expected).map(bindingKey)))) {
        errors.push(`named imports from ${specifier} do not match the exact GitHub module allowlist`);
      }
    }
    if (ts.isExportDeclaration(statement)) {
      exportDeclarations.push(statement);
      if (statement.moduleSpecifier) errors.push('source re-export is forbidden');
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        errors.push('export-star is forbidden');
      } else {
        for (const element of statement.exportClause.elements) {
          if (element.propertyName && element.propertyName.text !== element.name.text) {
            errors.push('aliased export is forbidden');
          }
          exports.push(element.name.text);
        }
      }
    } else exports.push(...inlineExportNames(statement, errors));
  }

  const expectedExportSet = new Set(expectedExports);
  for (const name of exports) {
    if (!expectedExportSet.has(name)) errors.push(`unexpected GitHub module export ${name}`);
  }
  const expectedExportDeclarations = ['github.mjs', 'cli.mjs'].includes(fileName) ? 1 : 0;
  if (exportDeclarations.length !== expectedExportDeclarations) {
    errors.push(`${fileName} must have exactly ${expectedExportDeclarations} explicit local export lists`);
  }
  return errors;
}

function validateProductionGitHubSource(importer, source) {
  const errors = inspectProductionGitHubSource(importer, source);
  const fileName = posixRelative(githubDirectory, importer);
  const expectedTargets = PRODUCTION_GITHUB_IMPORTS.get(fileName);
  const expectedExports = PRODUCTION_GITHUB_EXPORTS.get(fileName);
  if (!expectedTargets || !expectedExports) return errors;
  const parsed = parseModule(importer, source);
  const actualTargets = parsed.statements.filter(ts.isImportDeclaration).flatMap((statement) => (
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [normalizedModuleTarget(importer, statement.moduleSpecifier.text)] : []
  ));
  if (JSON.stringify(sorted(actualTargets)) !== JSON.stringify(sorted(expectedTargets.keys()))) {
    errors.push('GitHub production import targets must exactly match the module allowlist');
  }
  const exportErrors = [];
  const actualExports = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause
        && ts.isNamedExports(statement.exportClause)) {
      actualExports.push(...statement.exportClause.elements.map((element) => element.name.text));
    } else actualExports.push(...inlineExportNames(statement, exportErrors));
  }
  if (JSON.stringify(sorted(actualExports)) !== JSON.stringify(sorted(expectedExports))) {
    errors.push('GitHub production exports must exactly match the module export allowlist');
  }
  return [...errors, ...exportErrors];
}

function productionGitHubFiles() {
  return filesBelow(githubDirectory).filter((path) => path.endsWith('.mjs')
    && !path.endsWith('.test.mjs')
    && !path.startsWith('test-support/')
    && path !== 'archive/archive-fixture-loader.mjs');
}

function productionGitHubCycle(imports = PRODUCTION_GITHUB_IMPORTS) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(fileName) {
    if (active.has(fileName)) {
      const start = stack.indexOf(fileName);
      return [...stack.slice(start), fileName];
    }
    if (visited.has(fileName)) return null;
    active.add(fileName);
    stack.push(fileName);
    for (const target of imports.get(fileName)?.keys() ?? []) {
      if (typeof target !== 'string' || !target.startsWith(`${githubDirectory}${sep}`)) continue;
      const dependency = posixRelative(githubDirectory, target);
      if (!imports.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(fileName);
    visited.add(fileName);
    return null;
  }
  for (const fileName of imports.keys()) {
    const cycle = visit(fileName);
    if (cycle) return cycle;
  }
  return null;
}

function inspectEvidenceCallbackCapabilities(fileName, parsed) {
  const capabilities = EVIDENCE_CALLBACK_CAPABILITIES.get(fileName) ?? [];
  const errors = [];
  const nodeScopes = new WeakMap();
  const bindings = [];
  const parameterBindings = [];

  function createScope(parent, functionNode = parent?.functionNode ?? null) {
    return { parent, functionNode, bindings: new Map() };
  }

  const sourceScope = createScope(null);

  function registerBinding(scope, identifier, details = {}) {
    const binding = { scope, identifier, sourceNodes: [], memberSourceNodes: new Map(), ...details };
    scope.bindings.set(identifier.text, binding);
    bindings.push(binding);
    return binding;
  }

  function registerBindingName(scope, name, details = {}, property = null) {
    if (ts.isIdentifier(name)) {
      return [registerBinding(scope, name, { ...details, property })];
    }
    if (ts.isObjectBindingPattern(name)) {
      return name.elements.flatMap((element) => {
        const elementProperty = element.propertyName
          && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : null;
        const registered = registerBindingName(scope, element.name, details, elementProperty);
        if (element.initializer) {
          for (const binding of registered) binding.sourceNodes.push(element.initializer);
        }
        return registered;
      });
    }
    if (ts.isArrayBindingPattern(name)) {
      return name.elements.flatMap((element, index) => ts.isBindingElement(element)
        ? registerBindingName(scope, element.name, details, String(index)) : []);
    }
    return [];
  }

  function functionOwner(node) {
    return ts.isFunctionDeclaration(node) && node.parent === parsed && node.name
      ? node.name.text : null;
  }

  function visit(node, scope) {
    nodeScopes.set(node, scope);
    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        registerBinding(scope, node.name, { kind: 'function', functionNode: node });
      }
      const functionScope = createScope(scope, node);
      nodeScopes.set(node, functionScope);
      if (!ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        registerBinding(functionScope, node.name, { kind: 'function' });
      }
      const owner = functionOwner(node);
      for (const [parameterIndex, parameter] of node.parameters.entries()) {
        nodeScopes.set(parameter, functionScope);
        const registered = registerBindingName(functionScope, parameter.name, {
          kind: 'parameter', functionNode: node, owner, parameter, parameterIndex,
        });
        parameterBindings.push(...registered);
        if (parameter.initializer) visit(parameter.initializer, functionScope);
      }
      if (node.body) visit(node.body, functionScope);
      return;
    }
    if (ts.isBlock(node) || ts.isCatchClause(node)) {
      const blockScope = createScope(scope);
      nodeScopes.set(node, blockScope);
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        registerBindingName(blockScope, node.variableDeclaration.name, { kind: 'catch' });
      }
      ts.forEachChild(node, (child) => visit(child, blockScope));
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const registered = registerBindingName(scope, node.name, { kind: 'variable' });
      if (node.initializer) {
        for (const binding of registered) {
          binding.sourceNodes.push(node.initializer);
          if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(node.initializer)) {
            for (const property of node.initializer.properties) {
              const key = property.name && (ts.isIdentifier(property.name)
                || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
                ? property.name.text : '*';
              const sourceNode = ts.isShorthandPropertyAssignment(property) ? property.name
                : ts.isPropertyAssignment(property) ? property.initializer
                  : ts.isSpreadAssignment(property) ? property.expression : null;
              if (sourceNode) {
                const sources = binding.memberSourceNodes.get(key) ?? [];
                sources.push(sourceNode);
                binding.memberSourceNodes.set(key, sources);
              }
            }
          } else if (ts.isIdentifier(node.name) && ts.isArrayLiteralExpression(node.initializer)) {
            for (const [index, element] of node.initializer.elements.entries()) {
              const sources = binding.memberSourceNodes.get(String(index)) ?? [];
              sources.push(ts.isSpreadElement(element) ? element.expression : element);
              binding.memberSourceNodes.set(String(index), sources);
            }
          }
        }
      }
    } else if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      registerBinding(scope, node.name, { kind: 'declaration', declarationNode: node });
    } else if (ts.isImportClause(node) && node.name) {
      registerBinding(scope, node.name, { kind: 'import' });
    } else if (ts.isImportSpecifier(node)) {
      registerBinding(scope, node.name, { kind: 'import' });
    } else if (ts.isNamespaceImport(node)) {
      registerBinding(scope, node.name, { kind: 'import' });
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(parsed, sourceScope);

  function resolveIdentifier(identifier) {
    let scope = nodeScopes.get(identifier);
    while (scope) {
      const binding = scope.bindings.get(identifier.text);
      if (binding) return binding;
      scope = scope.parent;
    }
    return null;
  }

  function assignmentTargets(node) {
    if (ts.isIdentifier(node)) return [resolveIdentifier(node)].filter(Boolean);
    if (ts.isParenthesizedExpression(node)) return assignmentTargets(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const targets = assignmentTargets(node.left);
      for (const target of targets) target.sourceNodes.push(node.right);
      return targets;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let root = node.expression;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
        root = root.expression;
      }
      return ts.isIdentifier(root) ? [resolveIdentifier(root)].filter(Boolean) : [];
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) => ts.isSpreadElement(element)
        ? assignmentTargets(element.expression) : assignmentTargets(element));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return assignmentTargets(property.name);
        if (ts.isPropertyAssignment(property)) return assignmentTargets(property.initializer);
        if (ts.isSpreadAssignment(property)) return assignmentTargets(property.expression);
        return [];
      });
    }
    return [];
  }

  const unmodelledAssignments = [];
  function memberAssignmentTarget(node) {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
    const path = [];
    let root = node;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      path.unshift(ts.isPropertyAccessExpression(root) ? root.name.text
        : ts.isStringLiteral(root.argumentExpression) || ts.isNumericLiteral(root.argumentExpression)
          ? root.argumentExpression.text : '*');
      root = root.expression;
    }
    if (!ts.isIdentifier(root)) return null;
    const binding = resolveIdentifier(root);
    if (!binding) return null;
    return { binding, key: path.join('.') };
  }

  function visitAssignments(node) {
    if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const targets = assignmentTargets(node.left);
      if (targets.length === 0) unmodelledAssignments.push(node);
      for (const target of targets) target.sourceNodes.push(node.right);
      const memberTarget = memberAssignmentTarget(node.left);
      if (memberTarget) {
        const sources = memberTarget.binding.memberSourceNodes.get(memberTarget.key) ?? [];
        sources.push(node.right);
        memberTarget.binding.memberSourceNodes.set(memberTarget.key, sources);
      }
    }
    ts.forEachChild(node, visitAssignments);
  }
  visitAssignments(parsed);

  function isReferenceIdentifier(node) {
    const parent = node.parent;
    if (!parent) return false;
    const binding = resolveIdentifier(node);
    if (binding?.identifier === node) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node && !parent.name.getText().startsWith('[')) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
    if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
    return true;
  }

  const originsByBinding = new Map(bindings.map((binding) => [
    binding, binding.kind === 'parameter' ? new Set([binding]) : new Set(),
  ]));
  let callbackParameters = new Set();

  function staticPropertyKey(name) {
    if (!name) return '*';
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)
        && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) {
      return name.expression.text;
    }
    return '*';
  }

  function ownedReturnExpressions(functionNode) {
    if (ts.isArrowFunction(functionNode) && !ts.isBlock(functionNode.body)) {
      return [functionNode.body];
    }
    if (!functionNode.body) return [];
    const returned = [];
    function visitReturn(node) {
      if (node !== functionNode.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        if (node.expression) returned.push(node.expression);
        return;
      }
      ts.forEachChild(node, visitReturn);
    }
    visitReturn(functionNode.body);
    return returned;
  }

  function classValues(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    seen.add(node);
    if (ts.isParenthesizedExpression(node)) return classValues(node.expression, seen);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return [node];
    if (ts.isIdentifier(node)) {
      const binding = resolveIdentifier(node);
      if (!binding || seen.has(binding)) return [];
      seen.add(binding);
      const declarations = binding.declarationNode
        && (ts.isClassDeclaration(binding.declarationNode)
          || ts.isClassExpression(binding.declarationNode)) ? [binding.declarationNode] : [];
      for (const sourceNode of binding.sourceNodes) {
        declarations.push(...classValues(sourceNode, seen));
      }
      return declarations;
    }
    if (ts.isConditionalExpression(node)) {
      return [node.whenTrue, node.whenFalse].flatMap((branch) => classValues(branch, seen));
    }
    if (ts.isBinaryExpression(node)) {
      return [node.left, node.right].flatMap((operand) => classValues(operand, seen));
    }
    if (ts.isCallExpression(node)) {
      return callableReturnExpressions(node.expression, seen).flatMap((returned) => (
        classValues(returned, seen)
      ));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const { root, path } = memberExpressionParts(node);
      return classSlotDeclarations(root, path, seen);
    }
    return [];
  }

  function classSlotDeclarationsFromBinding(binding, path, seen = new Set()) {
    if (!binding || seen.has(binding)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    if (path.length === 0) {
      const declarations = binding.declarationNode
        && (ts.isClassDeclaration(binding.declarationNode)
          || ts.isClassExpression(binding.declarationNode)) ? [binding.declarationNode] : [];
      for (const sourceNode of binding.sourceNodes) {
        declarations.push(...classValues(sourceNode, nextSeen));
      }
      return declarations;
    }
    const [key, ...rest] = path;
    const declarations = [];
    if (binding.declarationNode && ts.isClassDeclaration(binding.declarationNode)) {
      declarations.push(...classMemberSlotDeclarations(
        binding.declarationNode, path, true, nextSeen,
      ));
    }
    for (const sourceNode of binding.memberSourceNodes.get(path.join('.')) ?? []) {
      declarations.push(...classValues(sourceNode, nextSeen));
    }
    const memberKeys = key === '*' ? [...binding.memberSourceNodes.keys()]
      .filter((memberKey) => !memberKey.includes('.')) : [key, '*'];
    for (const memberKey of memberKeys) {
      for (const sourceNode of binding.memberSourceNodes.get(memberKey) ?? []) {
        declarations.push(...classSlotDeclarations(sourceNode, rest, nextSeen));
      }
    }
    for (const sourceNode of binding.sourceNodes) {
      declarations.push(...classSlotDeclarations(sourceNode, path, nextSeen));
    }
    return declarations;
  }

  function classMemberSlotDeclarations(classNode, path, requireStatic, seen) {
    if (path.length === 0) return [];
    const [key, ...rest] = path;
    const declarations = [];
    for (const member of classNode.members) {
      if (isStaticClassMember(member) !== requireStatic) continue;
      const memberKey = staticPropertyKey(member.name);
      if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
      if (ts.isGetAccessorDeclaration(member)) {
        for (const returned of ownedReturnExpressions(member)) {
          declarations.push(...classSlotDeclarations(returned, rest, seen));
        }
        continue;
      }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        declarations.push(...classSlotDeclarations(member.initializer, rest, seen));
      }
    }
    return declarations;
  }

  function classSlotDeclarations(node, path, seen = new Set()) {
    if (!node) return [];
    if (path.length === 0) return classValues(node, seen);
    if (seen.has(node)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (ts.isParenthesizedExpression(node)) {
      return classSlotDeclarations(node.expression, path, nextSeen);
    }
    if (ts.isIdentifier(node)) {
      return classSlotDeclarationsFromBinding(resolveIdentifier(node), path, nextSeen);
    }
    if (ts.isCallExpression(node)) {
      return callableReturnExpressions(node.expression, nextSeen).flatMap((returned) => (
        classSlotDeclarations(returned, path, nextSeen)
      ));
    }
    if (ts.isNewExpression(node)) {
      return classValues(node.expression, nextSeen).flatMap((classNode) => (
        classMemberSlotDeclarations(classNode, path, false, nextSeen)
      ));
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return classMemberSlotDeclarations(node, path, true, nextSeen);
    }
    if (ts.isConditionalExpression(node)) {
      return [node.whenTrue, node.whenFalse].flatMap((branch) => (
        classSlotDeclarations(branch, path, nextSeen)
      ));
    }
    if (ts.isBinaryExpression(node)) {
      return [node.left, node.right].flatMap((operand) => (
        classSlotDeclarations(operand, path, nextSeen)
      ));
    }
    const [key, ...rest] = path;
    if (ts.isObjectLiteralExpression(node)) {
      const declarations = [];
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          declarations.push(...classSlotDeclarations(property.expression, path, nextSeen));
          continue;
        }
        const memberKey = staticPropertyKey(property.name);
        if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
        if (ts.isGetAccessorDeclaration(property)) {
          for (const returned of ownedReturnExpressions(property)) {
            declarations.push(...classSlotDeclarations(returned, rest, nextSeen));
          }
          continue;
        }
        const value = ts.isShorthandPropertyAssignment(property) ? property.name
          : ts.isPropertyAssignment(property) ? property.initializer : null;
        if (value) declarations.push(...classSlotDeclarations(value, rest, nextSeen));
      }
      return declarations;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element, index) => {
        if (key !== '*' && key !== String(index)) return [];
        const value = ts.isSpreadElement(element) ? element.expression : element;
        return classSlotDeclarations(value, rest, nextSeen);
      });
    }
    return [];
  }

  function isStaticClassMember(member) {
    return member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
      ?? false;
  }

  function functionClassSlotValues(classNode, path, requireStatic, seen) {
    if (path.length === 0) return [];
    const [key, ...rest] = path;
    const values = [];
    for (const member of classNode.members) {
      if (isStaticClassMember(member) !== requireStatic) continue;
      const memberKey = staticPropertyKey(member.name);
      if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
      if (rest.length === 0 && ts.isMethodDeclaration(member)) {
        values.push(member);
        continue;
      }
      if (ts.isGetAccessorDeclaration(member)) {
        for (const returned of ownedReturnExpressions(member)) {
          values.push(...functionSlotValues(returned, rest, seen));
        }
        continue;
      }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        values.push(...functionSlotValues(member.initializer, rest, seen));
      }
    }
    return values;
  }

  function functionValues(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (ts.isParenthesizedExpression(node)) {
      return functionValues(node.expression, nextSeen);
    }
    if (ts.isFunctionLike(node)) return [node];
    if (ts.isIdentifier(node)) {
      const binding = resolveIdentifier(node);
      if (!binding || nextSeen.has(binding)) return [];
      nextSeen.add(binding);
      const values = binding.functionNode ? [binding.functionNode] : [];
      for (const sourceNode of binding.sourceNodes) {
        values.push(...functionValues(sourceNode, nextSeen));
      }
      return values;
    }
    if (ts.isConditionalExpression(node)) {
      return [node.whenTrue, node.whenFalse].flatMap((branch) => (
        functionValues(branch, nextSeen)
      ));
    }
    if (ts.isBinaryExpression(node)) {
      return [node.left, node.right].flatMap((operand) => (
        functionValues(operand, nextSeen)
      ));
    }
    if (ts.isCallExpression(node)) {
      return callableReturnExpressions(node.expression, nextSeen).flatMap((returned) => (
        functionValues(returned, nextSeen)
      ));
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const { root, path } = memberExpressionParts(node);
      return functionSlotValues(root, path, nextSeen);
    }
    return [];
  }

  function functionSlotValuesFromBinding(binding, path, seen = new Set()) {
    if (!binding || seen.has(binding)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    if (path.length === 0) {
      const values = binding.functionNode ? [binding.functionNode] : [];
      for (const sourceNode of binding.sourceNodes) {
        values.push(...functionValues(sourceNode, nextSeen));
      }
      return values;
    }
    const [key, ...rest] = path;
    const values = [];
    if (binding.declarationNode && ts.isClassDeclaration(binding.declarationNode)) {
      values.push(...functionClassSlotValues(
        binding.declarationNode, path, true, nextSeen,
      ));
    }
    for (const sourceNode of binding.memberSourceNodes.get(path.join('.')) ?? []) {
      values.push(...functionValues(sourceNode, nextSeen));
    }
    const memberKeys = key === '*' ? [...binding.memberSourceNodes.keys()]
      .filter((memberKey) => !memberKey.includes('.')) : [key, '*'];
    for (const memberKey of memberKeys) {
      for (const sourceNode of binding.memberSourceNodes.get(memberKey) ?? []) {
        values.push(...functionSlotValues(sourceNode, rest, nextSeen));
      }
    }
    for (const sourceNode of binding.sourceNodes) {
      values.push(...functionSlotValues(sourceNode, path, nextSeen));
    }
    return values;
  }

  function functionSlotValues(node, path, seen = new Set()) {
    if (!node) return [];
    if (path.length === 0) return functionValues(node, seen);
    if (seen.has(node)) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (ts.isParenthesizedExpression(node)) {
      return functionSlotValues(node.expression, path, nextSeen);
    }
    if (ts.isIdentifier(node)) {
      return functionSlotValuesFromBinding(resolveIdentifier(node), path, nextSeen);
    }
    if (ts.isCallExpression(node)) {
      return callableReturnExpressions(node.expression, nextSeen).flatMap((returned) => (
        functionSlotValues(returned, path, nextSeen)
      ));
    }
    if (ts.isNewExpression(node)) {
      return classValues(node.expression).flatMap((classNode) => (
        functionClassSlotValues(classNode, path, false, nextSeen)
      ));
    }
    if (ts.isClassExpression(node) || ts.isClassDeclaration(node)) {
      return functionClassSlotValues(node, path, true, nextSeen);
    }
    if (ts.isConditionalExpression(node)) {
      return [node.whenTrue, node.whenFalse].flatMap((branch) => (
        functionSlotValues(branch, path, nextSeen)
      ));
    }
    if (ts.isBinaryExpression(node)) {
      return [node.left, node.right].flatMap((operand) => (
        functionSlotValues(operand, path, nextSeen)
      ));
    }
    const [key, ...rest] = path;
    if (ts.isObjectLiteralExpression(node)) {
      const values = [];
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          values.push(...functionSlotValues(property.expression, path, nextSeen));
          continue;
        }
        const memberKey = staticPropertyKey(property.name);
        if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
        if (rest.length === 0 && ts.isMethodDeclaration(property)) {
          values.push(property);
          continue;
        }
        if (ts.isGetAccessorDeclaration(property)) {
          for (const returned of ownedReturnExpressions(property)) {
            values.push(...functionSlotValues(returned, rest, nextSeen));
          }
          continue;
        }
        const value = ts.isShorthandPropertyAssignment(property) ? property.name
          : ts.isPropertyAssignment(property) ? property.initializer : null;
        if (value) values.push(...functionSlotValues(value, rest, nextSeen));
      }
      return values;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element, index) => {
        if (key !== '*' && key !== String(index)) return [];
        const value = ts.isSpreadElement(element) ? element.expression : element;
        return functionSlotValues(value, rest, nextSeen);
      });
    }
    return [];
  }

  function callableReturnExpressions(node, seen = new Set()) {
    return functionValues(node, seen).flatMap(ownedReturnExpressions);
  }

  const activeCallableReturnNodes = new Set();
  function callableReturnOrigins(node) {
    if (activeCallableReturnNodes.has(node)) return new Set();
    activeCallableReturnNodes.add(node);
    const origins = new Set();
    try {
      for (const returned of callableReturnExpressions(node)) {
        for (const origin of returnedValueOrigins(returned)) origins.add(origin);
      }
    } finally {
      activeCallableReturnNodes.delete(node);
    }
    return origins;
  }

  function returnedValueOrigins(node) {
    if (ts.isParenthesizedExpression(node)) return returnedValueOrigins(node.expression);
    if (ts.isIdentifier(node)) return expressionOrigins(node);
    if (ts.isConditionalExpression(node)) {
      return new Set([
        ...returnedValueOrigins(node.whenTrue), ...returnedValueOrigins(node.whenFalse),
      ]);
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return returnedValueOrigins(node.right);
      }
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return new Set([
          ...returnedValueOrigins(node.left), ...returnedValueOrigins(node.right),
        ]);
      }
    }
    if (ts.isCallExpression(node)) return expressionOrigins(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return executableExpressionOrigins(node);
    }
    return new Set([...expressionOrigins(node)]
      .filter((origin) => callbackParameters.has(origin)));
  }

  function expressionOrigins(node) {
    const origins = new Set();
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      return new Set(originsByBinding.get(resolveIdentifier(node)) ?? []);
    }
    if (ts.isFunctionLike(node) || ts.isClassExpression(node)) return origins;
    if (ts.isConditionalExpression(node)) {
      for (const branch of [node.whenTrue, node.whenFalse]) {
        for (const origin of expressionOrigins(branch)) origins.add(origin);
      }
      return origins;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)
          && ['call', 'apply', 'bind'].includes(callee.name.text)) {
        return expressionOrigins(callee.expression);
      }
      if (ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
          && ['call', 'apply', 'bind'].includes(callee.argumentExpression.text)) {
        return expressionOrigins(callee.expression);
      }
      for (const argument of node.arguments) {
        for (const origin of expressionOrigins(argument)) origins.add(origin);
      }
      for (const origin of callableReturnOrigins(callee)) origins.add(origin);
      return origins;
    }
    ts.forEachChild(node, (child) => {
      for (const origin of expressionOrigins(child)) origins.add(origin);
    });
    return origins;
  }

  function recomputeOrigins() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const binding of bindings) {
        const origins = originsByBinding.get(binding);
        for (const sourceNode of binding.sourceNodes) {
          for (const origin of expressionOrigins(sourceNode)) {
            if (!origins.has(origin)) {
              origins.add(origin);
              changed = true;
            }
          }
        }
      }
    }
  }

  function originParameters(binding) {
    return new Set(originsByBinding.get(binding) ?? []);
  }

  function classSlotOrigins(classNode, path, requireStatic, seen) {
    if (path.length === 0) return new Set();
    const [key, ...rest] = path;
    const origins = new Set();
    for (const member of classNode.members) {
      if (isStaticClassMember(member) !== requireStatic) continue;
      const memberKey = staticPropertyKey(member.name);
      if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
      if (ts.isGetAccessorDeclaration(member)) {
        for (const returned of ownedReturnExpressions(member)) {
          for (const origin of slotOriginsFromExpression(returned, rest, seen)) origins.add(origin);
        }
        continue;
      }
      if (rest.length === 0 && ts.isMethodDeclaration(member)) {
        for (const origin of callableReturnOrigins(member)) origins.add(origin);
        continue;
      }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        if (rest.length === 0 && ts.isFunctionLike(member.initializer)) {
          for (const origin of callableReturnOrigins(member.initializer)) origins.add(origin);
        }
        for (const origin of slotOriginsFromExpression(member.initializer, rest, seen)) {
          origins.add(origin);
        }
      }
    }
    return origins;
  }

  function slotOriginsFromBinding(binding, path, seen = new Map()) {
    if (!binding) return new Set();
    const pathKey = path.join('\0');
    const seenPaths = seen.get(binding) ?? new Set();
    if (seenPaths.has(pathKey)) return new Set();
    seenPaths.add(pathKey);
    seen.set(binding, seenPaths);
    if (path.length === 0) return originParameters(binding);
    const origins = new Set();
    const [key, ...rest] = path;
    if (binding.declarationNode && ts.isClassDeclaration(binding.declarationNode)) {
      for (const origin of classSlotOrigins(binding.declarationNode, path, true, seen)) {
        origins.add(origin);
      }
    }
    const exactPath = path.join('.');
    for (const sourceNode of binding.memberSourceNodes.get(exactPath) ?? []) {
      for (const origin of expressionOrigins(sourceNode)) origins.add(origin);
    }
    const memberKeys = key === '*' ? [...binding.memberSourceNodes.keys()
      ].filter((memberKey) => !memberKey.includes('.')) : [key, '*'];
    for (const memberKey of memberKeys) {
      for (const sourceNode of binding.memberSourceNodes.get(memberKey) ?? []) {
        for (const origin of slotOriginsFromExpression(sourceNode, rest, seen)) origins.add(origin);
      }
    }
    for (const sourceNode of binding.sourceNodes) {
      for (const origin of slotOriginsFromExpression(sourceNode, path, seen)) {
        origins.add(origin);
      }
    }
    return origins;
  }

  function slotOriginsFromExpression(node, path, seen = new Map()) {
    if (path.length === 0) return expressionOrigins(node);
    if (ts.isParenthesizedExpression(node)) {
      return slotOriginsFromExpression(node.expression, path, seen);
    }
    if (ts.isIdentifier(node)) {
      return slotOriginsFromBinding(resolveIdentifier(node), path, seen);
    }
    if (ts.isCallExpression(node)) {
      const origins = new Set();
      for (const returned of callableReturnExpressions(node.expression)) {
        for (const origin of slotOriginsFromExpression(returned, path, seen)) origins.add(origin);
      }
      return origins;
    }
    if (ts.isNewExpression(node)) {
      const origins = new Set();
      for (const classNode of classValues(node.expression)) {
        for (const origin of classSlotOrigins(classNode, path, false, seen)) origins.add(origin);
      }
      return origins;
    }
    if (ts.isClassExpression(node) || ts.isClassDeclaration(node)) {
      return classSlotOrigins(node, path, true, seen);
    }
    if (ts.isConditionalExpression(node)) {
      const origins = new Set();
      for (const branch of [node.whenTrue, node.whenFalse]) {
        for (const origin of slotOriginsFromExpression(branch, path, seen)) origins.add(origin);
      }
      return origins;
    }
    if (ts.isBinaryExpression(node)) {
      const origins = new Set();
      for (const operand of [node.left, node.right]) {
        for (const origin of slotOriginsFromExpression(operand, path, seen)) origins.add(origin);
      }
      return origins;
    }
    const [key, ...rest] = path;
    if (ts.isObjectLiteralExpression(node)) {
      const origins = new Set();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const origin of slotOriginsFromExpression(property.expression, path, seen)) {
            origins.add(origin);
          }
          continue;
        }
        const memberKey = staticPropertyKey(property.name);
        if (key !== '*' && memberKey !== key && memberKey !== '*') continue;
        if (ts.isGetAccessorDeclaration(property)) {
          for (const returned of ownedReturnExpressions(property)) {
            for (const origin of slotOriginsFromExpression(returned, rest, seen)) {
              origins.add(origin);
            }
          }
          continue;
        }
        if (rest.length === 0 && ts.isMethodDeclaration(property)) {
          for (const origin of callableReturnOrigins(property)) origins.add(origin);
          continue;
        }
        const value = ts.isShorthandPropertyAssignment(property) ? property.name
          : ts.isPropertyAssignment(property) ? property.initializer : null;
        if (value) {
          if (rest.length === 0 && ts.isFunctionLike(value)) {
            for (const origin of callableReturnOrigins(value)) origins.add(origin);
          }
          for (const origin of slotOriginsFromExpression(value, rest, seen)) origins.add(origin);
        }
      }
      return origins;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const origins = new Set();
      for (const [index, element] of node.elements.entries()) {
        if (key !== '*' && key !== String(index)) continue;
        const value = ts.isSpreadElement(element) ? element.expression : element;
        for (const origin of slotOriginsFromExpression(value, rest, seen)) origins.add(origin);
      }
      return origins;
    }
    return new Set([...expressionOrigins(node)]
      .filter((origin) => callbackParameters.has(origin)));
  }

  function memberExpressionParts(node) {
    const path = [];
    let root = node;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      path.unshift(ts.isPropertyAccessExpression(root) ? root.name.text
        : ts.isStringLiteral(root.argumentExpression) || ts.isNumericLiteral(root.argumentExpression)
          ? root.argumentExpression.text : '*');
      root = root.expression;
    }
    return { root, path };
  }

  function executableExpressionOrigins(node) {
    if (ts.isParenthesizedExpression(node)) return executableExpressionOrigins(node.expression);
    if (ts.isIdentifier(node)) return originParameters(resolveIdentifier(node));
    if (ts.isCallExpression(node)) {
      const origins = expressionOrigins(node);
      for (const returned of callableReturnExpressions(node.expression)) {
        for (const origin of executableExpressionOrigins(returned)) origins.add(origin);
        for (const origin of callableReturnOrigins(returned)) origins.add(origin);
      }
      return origins;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const { root, path } = memberExpressionParts(node);
      const member = slotOriginsFromExpression(root, path);
      if (member.size > 0) return member;
      return new Set([...expressionOrigins(root)].filter((origin) => callbackParameters.has(origin)));
    }
    return expressionOrigins(node);
  }

  function capabilityForParameter(binding) {
    return capabilities.find((capability) => capability.owner === binding.owner
      && capability.parameterIndex === binding.parameterIndex
      && capability.property === binding.property
      && capability.local === binding.identifier.text) ?? null;
  }

  const capabilityBindings = new Map();
  for (const capability of capabilities) {
    const matches = parameterBindings.filter((binding) => (
      capabilityForParameter(binding) === capability
    ));
    if (matches.length !== 1) {
      errors.push(`evidence callback capability ${capability.owner}.${capability.local} must have one exact parameter binding`);
    } else capabilityBindings.set(matches[0], { capability, calls: 0 });
  }

  callbackParameters = new Set(capabilityBindings.keys());

  function invocationOrigins(node) {
    const callee = node.expression;
    const returnedOrigins = ts.isPropertyAccessExpression(callee)
      || ts.isElementAccessExpression(callee) ? callableReturnOrigins(callee) : new Set();
    function withReturned(origins) {
      return new Set([...origins, ...returnedOrigins]);
    }
    if (ts.isIdentifier(callee)) return withReturned(originParameters(resolveIdentifier(callee)));
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const property = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isStringLiteral(callee.argumentExpression) || ts.isNumericLiteral(callee.argumentExpression)
          ? callee.argumentExpression.text : null;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Reflect'
          && ['apply', 'construct'].includes(property) && node.arguments[0]) {
        return withReturned(expressionOrigins(node.arguments[0]));
      }
      if (['call', 'apply', 'bind'].includes(property)) {
        const receiverOrigins = expressionOrigins(callee.expression);
        if (receiverOrigins.size > 0) return withReturned(receiverOrigins);
        let receiverRoot = callee.expression;
        while (ts.isPropertyAccessExpression(receiverRoot)
            || ts.isElementAccessExpression(receiverRoot)) {
          receiverRoot = receiverRoot.expression;
        }
        if (ts.isIdentifier(receiverRoot) && receiverRoot.text === 'Function'
            && node.arguments[0]) return withReturned(expressionOrigins(node.arguments[0]));
      }
      return withReturned(executableExpressionOrigins(callee));
    }
    return withReturned(executableExpressionOrigins(callee));
  }

  function classifyInvokedParameters(node) {
    let changed = false;
    if (ts.isCallExpression(node)) {
      for (const origin of invocationOrigins(node)) {
        if (!callbackParameters.has(origin)) {
          callbackParameters.add(origin);
          changed = true;
        }
      }
    } else if (ts.isNewExpression(node)) {
      for (const origin of executableExpressionOrigins(node.expression)) {
        if (!callbackParameters.has(origin)) {
          callbackParameters.add(origin);
          changed = true;
        }
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      for (const origin of executableExpressionOrigins(node.tag)) {
        if (!callbackParameters.has(origin)) {
          callbackParameters.add(origin);
          changed = true;
        }
      }
    }
    ts.forEachChild(node, (child) => {
      if (classifyInvokedParameters(child)) changed = true;
    });
    return changed;
  }
  let callbackFlowChanged = true;
  while (callbackFlowChanged) {
    recomputeOrigins();
    callbackFlowChanged = classifyInvokedParameters(parsed);
  }
  recomputeOrigins();

  function isBelow(node, ancestor) {
    for (let current = node.parent; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }
  for (const [authorizedBinding, { capability }] of capabilityBindings) {
    if (bindings.some((binding) => binding !== authorizedBinding
        && binding.identifier.text === capability.local
        && isBelow(binding.identifier, authorizedBinding.functionNode))) {
      errors.push(`evidence callback capability ${capability.owner}.${capability.local} may not be shadowed`);
    }
  }

  function nestedFunctionsBetween(node, owner) {
    const nested = [];
    for (let current = node.parent; current && current !== owner; current = current.parent) {
      if (ts.isFunctionLike(current)) nested.push(current);
    }
    return nested;
  }

  function permittedClosure(node, owner, capability) {
    const nested = nestedFunctionsBetween(node, owner);
    if (!capability.closure) return nested.length === 0;
    if (nested.length !== 1) return false;
    const closure = nested[0];
    const call = closure.parent;
    const calleeBinding = ts.isCallExpression(call) && ts.isIdentifier(call.expression)
      ? resolveIdentifier(call.expression) : null;
    return ts.isCallExpression(call) && call.arguments.includes(closure)
      && calleeBinding?.kind === 'import'
      && calleeBinding.identifier.text === capability.closure;
  }

  function visitUses(node) {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      const binding = resolveIdentifier(node);
      const authorized = capabilityBindings.get(binding);
      if (authorized) {
        const parent = node.parent;
        const directCall = ts.isCallExpression(parent) && parent.expression === node;
        const actualShape = directCall && parent.questionDotToken
          ? 'optional-direct' : directCall ? 'direct' : null;
        if (actualShape === authorized.capability.callShape
            && permittedClosure(parent, binding.functionNode, authorized.capability)) {
          authorized.calls += 1;
        } else {
          errors.push(`evidence callback capability ${authorized.capability.owner}.${authorized.capability.local} has an unauthorized use`);
        }
      } else if (binding?.kind === 'parameter' && callbackParameters.has(binding)) {
        errors.push(`evidence module may not use callback parameter ${binding.property ?? binding.identifier.text}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const directBinding = ts.isIdentifier(node.expression)
        ? resolveIdentifier(node.expression) : null;
      for (const origin of invocationOrigins(node)) {
        if (!capabilityBindings.has(origin)) {
          errors.push(`evidence module may not invoke function parameter ${origin.property ?? origin.identifier.text} via ${node.expression.getText()}`);
        } else if (directBinding !== origin) {
          errors.push(`evidence callback derived from ${origin.property ?? origin.identifier.text} may not be invoked through an alias`);
        }
      }
    } else if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const executable = ts.isNewExpression(node) ? node.expression : node.tag;
      for (const origin of executableExpressionOrigins(executable)) {
        if (!capabilityBindings.has(origin)) {
          errors.push(`evidence module may not execute function parameter ${origin.property ?? origin.identifier.text}`);
        } else {
          errors.push(`evidence callback derived from ${origin.property ?? origin.identifier.text} has an unauthorized executable use`);
        }
      }
    }
    ts.forEachChild(node, visitUses);
  }
  visitUses(parsed);

  for (const assignment of unmodelledAssignments) {
    const origins = expressionOrigins(assignment.right);
    if ([...origins].some((origin) => callbackParameters.has(origin))) {
      errors.push('evidence callback has an unmodelled assignment target');
    }
  }

  for (const { capability, calls } of capabilityBindings.values()) {
    if (calls !== capability.calls) {
      errors.push(`evidence callback capability ${capability.owner}.${capability.local} must have exactly ${capability.calls} authorized call(s)`);
    }
  }
  return errors;
}

function isNonOptionalDirectEvalCall(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken) return false;
  let expression = node.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && expression.text === 'eval';
}

function inspectProductionStateSource(importer, source) {
  const errors = [];
  const fileName = posixRelative(stateModuleDirectory, importer);
  const allowlist = PRODUCTION_STATE_IMPORTS.get(fileName);
  const expectedExports = PRODUCTION_STATE_EXPORTS.get(fileName);
  if (!allowlist || !expectedExports) return [`unknown production state module ${fileName}`];
  const parsed = parseModule(importer, source);
  for (const diagnostic of parsed.parseDiagnostics) errors.push(`syntax error: ${diagnostic.messageText}`);
  const evidenceModule = fileName.startsWith('evidence/');

  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('dynamic import is forbidden');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') errors.push('CommonJS require is forbidden');
    if (ts.isIdentifier(node) && node.text === 'createRequire') errors.push('createRequire is forbidden');
    if (ts.isImportEqualsDeclaration(node)) errors.push('CommonJS import assignment is forbidden');
    if (ts.isExportAssignment(node)) errors.push('default export assignment is forbidden');
    if (evidenceModule && ts.isCallExpression(node)) {
      if (isNonOptionalDirectEvalCall(node)) {
        errors.push('evidence module may not use non-optional direct eval');
      }
      const authorityName = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isElementAccessExpression(node.expression)
              && ts.isStringLiteral(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text : null;
      if (authorityName && PROTECTED_STATE_AUTHORITY_PATTERN.test(authorityName)) {
        errors.push(`evidence module may not invoke protected state authority ${authorityName}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (evidenceModule) errors.push(...inspectEvidenceCallbackCapabilities(fileName, parsed));

  const exports = [];
  const sourceExports = new Map();
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : null;
      if (specifier === null) {
        errors.push('import specifier must be a string literal');
        continue;
      }
      const target = normalizedModuleTarget(importer, specifier);
      const expected = allowlist.get(target);
      if (fileName !== 'state.mjs' && target === stateModule('state.mjs')) {
        errors.push('internal state module may not import the public state.mjs facade');
      }
      if (!expected) errors.push(`unapproved state dependency ${specifier} resolves to ${target}`);
      if (!statement.importClause) {
        errors.push(`side-effect import is forbidden: ${specifier}`);
        continue;
      }
      if (statement.importClause.name) errors.push(`default import is forbidden: ${specifier}`);
      if (statement.importClause.namedBindings
          && ts.isNamespaceImport(statement.importClause.namedBindings)) {
        errors.push(`namespace import is forbidden: ${specifier}`);
      }
      const bindings = namedBindings(statement.importClause);
      if (bindings === null) continue;
      if (evidenceModule) {
        for (const { imported } of bindings) {
          if (PROTECTED_STATE_AUTHORITY_PATTERN.test(imported)) {
            errors.push(`evidence module may not import protected state authority ${imported}`);
          }
        }
      }
      if (expected && JSON.stringify(sorted(bindings.map(bindingKey)))
          !== JSON.stringify(sorted(expectedBindingPairs(expected).map(bindingKey)))) {
        errors.push(`named imports from ${specifier} do not match the exact state module allowlist`);
      }
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        errors.push(statement.exportClause ? 'namespace export is forbidden' : 'export-star is forbidden');
        continue;
      }
      const names = statement.exportClause.elements.map((element) => element.name.text);
      for (const element of statement.exportClause.elements) {
        if (element.propertyName && element.propertyName.text !== element.name.text) {
          errors.push('aliased export is forbidden');
        }
      }
      exports.push(...names);
      if (fileName !== 'state.mjs') {
        errors.push(`explicit export declarations are forbidden in ${fileName}`);
        continue;
      }
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
        errors.push('state facade exports must name a source module');
        continue;
      }
      const target = normalizedModuleTarget(importer, statement.moduleSpecifier.text);
      const accumulated = sourceExports.get(target) ?? [];
      accumulated.push(...names);
      sourceExports.set(target, accumulated);
    } else exports.push(...inlineExportNames(statement, errors));
  }

  const expectedExportSet = new Set(expectedExports);
  for (const name of exports) {
    if (!expectedExportSet.has(name)) errors.push(`unexpected state module export ${name}`);
  }
  if (fileName === 'state.mjs') {
    if (JSON.stringify(sorted(sourceExports.keys()))
        !== JSON.stringify(sorted(STATE_FACADE_SOURCE_EXPORTS.keys()))) {
      errors.push('state facade source export targets do not match the exact allowlist');
    }
    for (const [target, expectedNames] of STATE_FACADE_SOURCE_EXPORTS) {
      if (JSON.stringify(sorted(sourceExports.get(target) ?? []))
          !== JSON.stringify(sorted(expectedNames))) {
        errors.push(`state facade source exports from ${target} do not match the exact allowlist`);
      }
    }
  }
  return errors;
}

function inspectExactConsumerSource(importer, source, expectedImports) {
  const errors = [];
  const parsed = parseModule(importer, source);
  for (const diagnostic of parsed.parseDiagnostics) errors.push(`syntax error: ${diagnostic.messageText}`);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('exact consumer dynamic import is forbidden');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') errors.push('exact consumer CommonJS require is forbidden');
    if (ts.isImportEqualsDeclaration(node)) errors.push('exact consumer import assignment is forbidden');
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  const actualImports = [];
  for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      errors.push('exact consumer import specifier must be a string literal');
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!statement.importClause) {
      errors.push(`exact consumer side-effect import is forbidden: ${specifier}`);
      continue;
    }
    if (statement.importClause.name) errors.push(`exact consumer default import is forbidden: ${specifier}`);
    if (statement.importClause.namedBindings
        && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      errors.push(`exact consumer namespace import is forbidden: ${specifier}`);
    }
    const bindings = namedBindings(statement.importClause);
    if (bindings === null) continue;
    if (bindings.some(({ imported, local }) => imported !== local)) {
      errors.push(`exact consumer aliased import is forbidden: ${specifier}`);
    }
    actualImports.push({ specifier, names: sorted(bindings.map(({ imported }) => imported)) });
  }
  const normalizedExpected = expectedImports.map(({ specifier, names }) => ({
    specifier, names: sorted(names),
  })).sort((left, right) => left.specifier.localeCompare(right.specifier));
  actualImports.sort((left, right) => left.specifier.localeCompare(right.specifier));
  if (JSON.stringify(actualImports) !== JSON.stringify(normalizedExpected)) {
    errors.push('exact consumer imports do not match the ownership manifest');
  }
  return errors;
}

function validateProductionStateSource(importer, source) {
  const errors = inspectProductionStateSource(importer, source);
  const fileName = posixRelative(stateModuleDirectory, importer);
  const expectedTargets = PRODUCTION_STATE_IMPORTS.get(fileName);
  const expectedExports = PRODUCTION_STATE_EXPORTS.get(fileName);
  if (!expectedTargets || !expectedExports) return errors;
  const parsed = parseModule(importer, source);
  const actualTargets = parsed.statements.filter(ts.isImportDeclaration).flatMap((statement) => (
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [normalizedModuleTarget(importer, statement.moduleSpecifier.text)] : []
  ));
  if (JSON.stringify(sorted(actualTargets)) !== JSON.stringify(sorted(expectedTargets.keys()))) {
    errors.push('state production import targets must exactly match the module allowlist');
  }
  const exportErrors = [];
  const actualExports = [];
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause
        && ts.isNamedExports(statement.exportClause)) {
      actualExports.push(...statement.exportClause.elements.map((element) => element.name.text));
    } else actualExports.push(...inlineExportNames(statement, exportErrors));
  }
  if (JSON.stringify(sorted(actualExports)) !== JSON.stringify(sorted(expectedExports))) {
    errors.push('state production exports must exactly match the module export allowlist');
  }
  return [...errors, ...exportErrors];
}

function productionStateFiles() {
  return filesBelow(stateModuleDirectory).filter((path) => path.endsWith('.mjs')
    && !path.endsWith('.test.mjs')
    && !path.startsWith('test-support/')
    && !path.startsWith('fixtures/')
    && path !== 'cli.mjs');
}

function productionStateCycle(
  imports = PRODUCTION_STATE_IMPORTS,
  sourceExports = PRODUCTION_STATE_SOURCE_EXPORTS,
) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  function visit(fileName) {
    if (active.has(fileName)) return [...stack.slice(stack.indexOf(fileName)), fileName];
    if (visited.has(fileName)) return null;
    active.add(fileName);
    stack.push(fileName);
    const targets = new Set([
      ...(imports.get(fileName)?.keys() ?? []),
      ...(sourceExports.get(fileName)?.keys() ?? []),
    ]);
    for (const target of targets) {
      if (typeof target !== 'string' || !target.startsWith(`${stateModuleDirectory}${sep}`)) continue;
      const dependency = posixRelative(stateModuleDirectory, target);
      if (!imports.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(fileName);
    visited.add(fileName);
    return null;
  }
  for (const fileName of imports.keys()) {
    const cycle = visit(fileName);
    if (cycle) return cycle;
  }
  return null;
}

function inspectFocusedGitHubTestSource(importer, source) {
  const errors = [];
  const fileName = posixRelative(githubDirectory, importer);
  const allowedTargets = FOCUSED_GITHUB_TEST_IMPORTS.get(fileName);
  if (!allowedTargets) return { errors: [`unknown focused GitHub test ${fileName}`], targets: [] };
  const allowed = new Set(allowedTargets);
  const parsed = parseModule(importer, source);
  for (const diagnostic of parsed.parseDiagnostics) errors.push(`syntax error: ${diagnostic.messageText}`);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('focused GitHub tests may not use dynamic import');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') errors.push('focused GitHub tests may not use require');
    if (ts.isIdentifier(node) && node.text === 'createRequire') {
      errors.push('focused GitHub tests may not use createRequire');
    }
    if (ts.isImportEqualsDeclaration(node)) errors.push('focused GitHub tests may not use import assignment');
    if (ts.isExportAssignment(node) || ts.isExportDeclaration(node)
        || hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      errors.push('focused GitHub tests may not export declarations');
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  const targets = [];
  for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      errors.push('test import specifier must be a string literal');
      continue;
    }
    const target = normalizedModuleTarget(importer, statement.moduleSpecifier.text);
    targets.push(target);
    if (!allowed.has(target)) errors.push(`focused GitHub test has unapproved dependency ${target}`);
    if (!statement.importClause) errors.push(`focused GitHub test side-effect import is forbidden: ${target}`);
  }
  return { errors, targets };
}

function validateFocusedGitHubTestSource(importer, source) {
  const result = inspectFocusedGitHubTestSource(importer, source);
  const fileName = posixRelative(githubDirectory, importer);
  const expectedTargets = FOCUSED_GITHUB_TEST_IMPORTS.get(fileName);
  if (expectedTargets
      && JSON.stringify(sorted(result.targets)) !== JSON.stringify(sorted(expectedTargets))) {
    result.errors.push('focused GitHub test imports must exactly match its module allowlist');
  }
  return result;
}

function forbiddenWorkflowTarget(target) {
  if (!target.startsWith(`${scriptsDirectory}${sep}`)) return false;
  const localPath = posixRelative(scriptsDirectory, target);
  return /^(?:state|github|hooks|worktree)\//u.test(localPath)
    || /(?:^|\/)cli\.mjs$/u.test(localPath);
}

function testImportTargets(importer, source) {
  const parsed = parseModule(importer, source);
  const errors = parsed.parseDiagnostics.map((diagnostic) => `syntax error: ${diagnostic.messageText}`);
  const targets = [];
  for (const statement of parsed.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      errors.push('test import specifier must be a string literal');
      continue;
    }
    const target = normalizedModuleTarget(importer, statement.moduleSpecifier.text);
    targets.push(target);
    if (forbiddenWorkflowTarget(target)) errors.push(`test import reaches forbidden workflow layer: ${target}`);
  }
  return { errors, targets };
}

test('path discovery anchors checked-in resources to the skill and Git top level', () => {
  assert.equal(scriptsDirectory, dirname(fileURLToPath(import.meta.url)));
  assert.equal(skillDirectory, dirname(scriptsDirectory));
  assert.equal(schemaDirectory, join(skillDirectory, 'schemas'));
  assert.equal(repositoryDirectory, repositoryRoot(skillDirectory));
  assert.equal(repositoryRoot(join(repositoryDirectory, 'specs')), repositoryDirectory);
  assert.equal(featureDirectory(), join(repositoryDirectory, 'specs', 'features'));
  assert.equal(prReviewStateSchemaPath, join(schemaDirectory, 'pr-review-state.schema.json'));
  assert.equal(reviewFixTaskSchemaPath, join(schemaDirectory, 'review-fix-task.schema.json'));
  assert.equal(reviewFixResultSchemaPath, join(schemaDirectory, 'review-fix-result.schema.json'));

  const commonDirectory = gitCommonDirectory(join(repositoryDirectory, 'specs'));
  assert.equal(reviewRoot(join(repositoryDirectory, 'specs')), join(commonDirectory, 'codex', 'pr-review'));
});

test('ownership manifest names the complete canonical skill and no obsolete path exists', () => {
  const ownership = loadOwnership();
  assert.equal(ownership.schemaVersion, 1);
  assert.equal(ownership.skillRoot, '.agents/skills/pr-review-cycle');
  assert.deepEqual(
    Object.keys(ownership.architecturePolicies),
    ['privilegedStateFacadeExports', 'exactConsumers'],
  );
  assert.deepEqual(
    Object.keys(ownership.architecturePolicies.privilegedStateFacadeExports),
    ['atomicWriteJson', 'statePath'],
  );
  for (const [name, consumers] of Object.entries(
    ownership.architecturePolicies.privilegedStateFacadeExports,
  )) {
    assert.ok(PRODUCTION_STATE_EXPORTS.get('state.mjs').includes(name));
    assert.deepEqual(consumers, sorted(consumers));
    assert.equal(new Set(consumers).size, consumers.length);
    for (const consumer of consumers) {
      assert.ok(ownership.canonicalFiles.includes(`scripts/${consumer}`), `unknown privileged consumer ${consumer}`);
    }
  }
  assert.deepEqual(
    ownership.architecturePolicies.exactConsumers.map(({ path }) => path),
    sorted(ownership.architecturePolicies.exactConsumers.map(({ path }) => path)),
    'exact consumer inventory must be sorted for deterministic review',
  );
  assert.equal(
    new Set(ownership.architecturePolicies.exactConsumers.map(({ path }) => path)).size,
    ownership.architecturePolicies.exactConsumers.length,
  );
  for (const consumer of ownership.architecturePolicies.exactConsumers) {
    assert.deepEqual(Object.keys(consumer), ['path', 'imports']);
    for (const dependency of consumer.imports) {
      assert.deepEqual(Object.keys(dependency), ['specifier', 'names']);
    }
  }
  assert.deepEqual(
    ownership.canonicalFiles,
    sorted(ownership.canonicalFiles),
    'canonical inventory must be sorted for deterministic review',
  );
  assert.equal(new Set(ownership.canonicalFiles).size, ownership.canonicalFiles.length);
  assert.deepEqual(filesBelow(skillDirectory), ownership.canonicalFiles);
  assert.deepEqual(
    sorted(ownership.permittedExternalAdapters.map((adapter) => adapter.path)),
    EXPECTED_ADAPTERS,
  );
  assert.deepEqual(sorted(ownership.neutralSharedDependencies), EXPECTED_NEUTRAL_DEPENDENCIES);
  assert.deepEqual(ownership.separateCapabilities, EXPECTED_SEPARATE_CAPABILITIES);
  assert.deepEqual(sorted(ownership.obsoletePaths), EXPECTED_OBSOLETE_PATHS);

  const specialistOwnership = JSON.parse(readRepositoryFile(
    '.agents/skills/aerstello-specialists/ownership.json',
  ));
  assert.deepEqual(specialistOwnership.permittedWorkflowConsumers, [
    {
      path: '.codex/agents/development-integration-verifier.toml',
      targets: ['references/reviewer-contracts.md'],
    },
    {
      path: '.codex/agents/implementation-worker.toml',
      targets: ['registry.json'],
    },
    {
      path: '.codex/agents/integration-verifier.toml',
      targets: ['references/reviewer-contracts.md'],
    },
    {
      path: '.codex/agents/review-fix-worker.toml',
      targets: ['registry.json'],
    },
    {
      path: '.agents/skills/pr-review-cycle/ownership.json',
      targets: [],
    },
    {
      path: '.agents/skills/change-development/ownership.json',
      targets: [
        'SKILL.md',
        'references/reviewer-contracts.md',
        'registry.json',
        'scripts/validate-registry.mjs',
      ],
    },
  ]);

  for (const path of ownership.canonicalFiles) {
    assert.equal(lstatSync(join(skillDirectory, path)).isFile(), true, `missing canonical regular file ${path}`);
  }
  for (const adapter of ownership.permittedExternalAdapters) {
    assert.equal(statSync(join(repositoryDirectory, adapter.path)).isFile(), true, `missing adapter ${adapter.path}`);
    assert.deepEqual(adapter.targets, EXPECTED_ADAPTER_TARGETS[adapter.path]);
    const source = readRepositoryFile(adapter.path);
    for (const target of adapter.targets) {
      assert.ok(ownership.canonicalFiles.includes(target), `unknown adapter target ${target}`);
      assert.ok(
        source.includes(`${ownership.skillRoot}/${target}`),
        `${adapter.path} does not target ${target}`,
      );
    }
  }
  for (const path of ownership.neutralSharedDependencies) {
    assert.equal(statSync(join(repositoryDirectory, path)).isFile(), true, `missing shared dependency ${path}`);
  }
  for (const path of ownership.obsoletePaths) {
    assert.equal(existsSync(join(repositoryDirectory, path)), false, `obsolete path exists: ${path}`);
  }

  const unexpectedOwnedPaths = repositoryFiles().filter((path) => (
    !path.startsWith(`${ownership.skillRoot}/`)
    && (/(?:^|\/)(?:pr-review|review-fix)[^/]*\.(?:mjs|json|md)$/u.test(path)
      || /^\.codex\/hooks\/.*\.mjs$/u.test(path))
  ));
  assert.deepEqual(unexpectedOwnedPaths, []);
});

test('repository-wide architecture guards cover imports, authority, adjacency, and documentation', () => {
  const ownership = loadOwnership();
  const diagnostics = scanImportBoundaries({
    rootDirectory: scriptsDirectory,
    privilegedFacadeExports: ownership.architecturePolicies.privilegedStateFacadeExports,
  });
  assert.deepEqual(diagnostics.map(formatBoundaryDiagnostic), []);

  for (const path of ownership.canonicalFiles.filter((value) => !value.includes('/fixtures/'))) {
    assert.doesNotMatch(
      path.split('/').at(-1),
      /^(?:common|helper|helpers|misc|util|utils)\.mjs$/u,
      `generic helper dumping ground is forbidden: ${path}`,
    );
  }

  const fixtureOwners = new Map([
    ['scripts/architecture/fixtures/', 'scripts/architecture/import-boundaries.test.mjs'],
    ['scripts/github/archive/fixtures/', 'scripts/github/archive/fixture-integrity.test.mjs'],
    ['scripts/state/fixtures/', 'scripts/state/locks-and-barriers.test.mjs'],
  ]);
  for (const path of ownership.canonicalFiles.filter((value) => value.includes('/fixtures/'))) {
    const owner = [...fixtureOwners].find(([prefix]) => path.startsWith(prefix))?.[1];
    assert.ok(owner, `detached immutable fixture has no declared owner: ${path}`);
    assert.ok(ownership.canonicalFiles.includes(owner), `fixture owner is not canonical: ${owner}`);
  }

  for (const path of ownership.canonicalFiles.filter((value) => value.endsWith('.md'))) {
    const sourcePath = join(skillDirectory, path);
    const source = readFileSync(sourcePath, 'utf8');
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1].split('#', 1)[0];
      if (target === '' || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      const resolved = resolve(dirname(sourcePath), decodeURIComponent(target));
      assert.equal(existsSync(resolved), true, `unresolved documentation link ${path} -> ${target}`);
    }
  }
});

test('ownership manifest closes CLI, worktree, and hook dependency surfaces', () => {
  const ownership = loadOwnership();
  for (const consumer of ownership.architecturePolicies.exactConsumers) {
    assert.ok(ownership.canonicalFiles.includes(consumer.path), `unknown exact consumer ${consumer.path}`);
    assert.equal(new Set(consumer.imports.map(({ specifier }) => specifier)).size, consumer.imports.length);
    for (const dependency of consumer.imports) {
      assert.deepEqual(dependency.names, sorted(dependency.names));
      assert.equal(new Set(dependency.names).size, dependency.names.length);
    }
    const path = join(skillDirectory, consumer.path);
    assert.deepEqual(
      inspectExactConsumerSource(path, readFileSync(path, 'utf8'), consumer.imports),
      [],
      consumer.path,
    );
  }

  const stateCli = ownership.architecturePolicies.exactConsumers
    .find(({ path }) => path === 'scripts/state/cli.mjs');
  assert.match(
    inspectExactConsumerSource(
      stateModule('cli.mjs'),
      "import { checkpointState } from './checkpoint.mjs';",
      stateCli.imports,
    ).join('\n'),
    /do not match the ownership manifest/u,
  );
  assert.match(
    inspectExactConsumerSource(
      stateModule('cli.mjs'),
      "const hidden = await import('./state.mjs');",
      stateCli.imports,
    ).join('\n'),
    /dynamic import is forbidden/u,
  );
});

test('production contract modules obey the exact AST dependency and façade boundaries', () => {
  const productionFiles = sorted(readdirSync(contractsDirectory)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')));
  assert.deepEqual(productionFiles, sorted(PRODUCTION_CONTRACT_IMPORTS.keys()));

  for (const fileName of productionFiles) {
    const path = contractModule(fileName);
    assert.deepEqual(
      validateProductionContractSource(path, readFileSync(path, 'utf8')),
      [],
      fileName,
    );
  }
});

test('focused contract tests directly own their production module without higher-layer imports', () => {
  const focusedTestFiles = sorted(readdirSync(contractsDirectory)
    .filter((name) => name.endsWith('.test.mjs')));
  const expectedFocusedTests = sorted([...PRODUCTION_CONTRACT_IMPORTS.keys()]
    .filter((name) => name !== 'contract-identities.mjs')
    .map((name) => name.replace(/\.mjs$/u, '.test.mjs')));
  assert.deepEqual(focusedTestFiles, expectedFocusedTests);

  for (const testFileName of focusedTestFiles) {
    const importer = contractModule(testFileName);
    const { errors, targets } = testImportTargets(importer, readFileSync(importer, 'utf8'));
    const owner = contractModule(testFileName.replace(/\.test\.mjs$/u, '.mjs'));
    assert.deepEqual(errors, [], testFileName);
    assert.ok(targets.includes(owner), `${testFileName} must directly import its production owner`);
  }
});

test('extracted state production modules obey exact AST dependency and export boundaries', () => {
  const productionFiles = productionStateFiles();
  assert.deepEqual(sorted(PRODUCTION_STATE_IMPORTS.keys()), sorted(PRODUCTION_STATE_EXPORTS.keys()));
  assert.deepEqual(sorted(PRODUCTION_STATE_IMPORTS.keys()), productionFiles);
  assert.deepEqual(sorted(PRODUCTION_STATE_EXPORTS.keys()), productionFiles);
  assert.equal(productionStateCycle(), null, 'state production dependency graph must be acyclic');
  for (const fileName of sorted(PRODUCTION_STATE_IMPORTS.keys())) {
    const path = stateModule(fileName);
    assert.equal(statSync(path).isFile(), true, `missing state production module ${fileName}`);
    assert.deepEqual(
      validateProductionStateSource(path, readFileSync(path, 'utf8')),
      [],
      fileName,
    );
  }
});

test('state AST guards reject normalized facade and module-system escape hatches', () => {
  const atomicIoPath = stateModule('atomic-io.mjs');
  const rejectedSources = [
    ["const dependency = await import('./errors.mjs');", /dynamic import is forbidden/u],
    ["const dependency = require('./errors.mjs');", /CommonJS require is forbidden/u],
    ["import { createRequire } from 'node:module';", /createRequire is forbidden/u],
    ["import dependency = require('./errors.mjs');", /CommonJS import assignment is forbidden/u],
    ["import dependency from './errors.mjs';", /default import is forbidden/u],
    ["export default function leaked() {}", /default export is forbidden/u],
    ["import * as dependency from './errors.mjs';", /namespace import is forbidden/u],
    ["export * as dependency from './errors.mjs';", /namespace export is forbidden/u],
    ["import './errors.mjs';", /side-effect import is forbidden/u],
    ["export * from './errors.mjs';", /export-star is forbidden/u],
    ["import { StateError as WorkflowError } from './errors.mjs';", /do not match the exact/u],
    ["import { loadState } from './nested/../state.mjs';", /may not import the public state\.mjs facade/u],
  ];
  for (const [source, expected] of rejectedSources) {
    assert.match(inspectProductionStateSource(atomicIoPath, source).join('\n'), expected, source);
  }
});

test('checkpoint, services, transitions, CLI, and hooks cannot bypass state authority', () => {
  const policyTarget = stateModule('transition-policy.mjs');
  assert.deepEqual(
    [...PRODUCTION_STATE_IMPORTS].filter(([, imports]) => imports.has(policyTarget))
      .map(([fileName]) => fileName),
    ['checkpoint.mjs'],
  );
  for (const fileName of PRODUCTION_STATE_IMPORTS.keys()) {
    if (!fileName.startsWith('services/')) continue;
    const targets = PRODUCTION_STATE_IMPORTS.get(fileName);
    for (const forbidden of ['transition-policy.mjs', 'locks.mjs', 'journal.mjs']) {
      assert.equal(targets.has(stateModule(forbidden)), false, `${fileName} must not own ${forbidden}`);
    }
  }
  for (const fileName of PRODUCTION_STATE_IMPORTS.keys()) {
    if (!fileName.startsWith('transitions/')) continue;
    for (const target of PRODUCTION_STATE_IMPORTS.get(fileName).keys()) {
      assert.equal(target.startsWith('node:fs'), false, `${fileName} must stay I/O-free`);
      assert.equal(target.startsWith('node:child_process'), false, `${fileName} must stay I/O-free`);
      assert.notEqual(target, stateModule('atomic-io.mjs'), `${fileName} must stay I/O-free`);
      assert.notEqual(target, stateModule('checkpoint.mjs'), `${fileName} must stay I/O-free`);
      assert.notEqual(target, stateModule('journal.mjs'), `${fileName} must stay I/O-free`);
      assert.notEqual(target, stateModule('locks.mjs'), `${fileName} must stay I/O-free`);
      assert.notEqual(target, stateModule('state-store.mjs'), `${fileName} must stay I/O-free`);
    }
  }

  const servicePath = stateModule('services/review.mjs');
  for (const [source, expected] of [
    ["import { createTransitionPolicy } from '../nested/../transition-policy.mjs';", /unapproved state dependency/u],
    ["import { withStateLock } from '../locks.mjs';", /unapproved state dependency/u],
    ["import { appendEvent } from '../journal.mjs';", /unapproved state dependency/u],
    ["import { atomicWriteJson as write } from '../atomic-io.mjs';", /unapproved state dependency|aliased/u],
    ["const owner = await import('../transition-policy.mjs');", /dynamic import is forbidden/u],
    ["const owner = require('../checkpoint.mjs');", /CommonJS require is forbidden/u],
  ]) assert.match(inspectProductionStateSource(servicePath, source).join('\n'), expected, source);

});

test('state evidence AST guards reject protected transition and checkpoint authority', () => {
  const evidencePath = stateModule('evidence/task-packets.mjs');
  const rejectedSources = [
    ["import { checkpointState } from '../state.mjs';", /may not import protected state authority checkpointState/u],
    ['checkpointCompletion();', /may not invoke protected state authority checkpointCompletion/u],
    ['lifecycle.buildCompletionTransition();', /may not invoke protected state authority buildCompletionTransition/u],
    ["lifecycle['checkpointState']();", /may not invoke protected state authority checkpointState/u],
    ['authority.completeIntegratedTasks();', /may not invoke protected state authority completeIntegratedTasks/u],
  ];
  for (const [source, expected] of rejectedSources) {
    assert.match(inspectProductionStateSource(evidencePath, source).join('\n'), expected, source);
  }
});

test('state evidence AST guards reject lexical direct eval without broadening dynamic-code policy', () => {
  const workerResultsPath = stateModule('evidence/worker-results.mjs');
  const exactWorker = (body = '') => `
    export function persistWorkerResultEvidence(cwd, state, task, envelope, onStep) {
      onStep?.('receipt-durable'); onStep?.('envelope-durable'); ${body}
    }
  `;
  const rejectedSources = new Map([
    ['authorized callback owner', exactWorker("eval(\"onStep?.('hidden')\");")],
    ['parenthesized callee', exactWorker("(((eval)))(\"onStep?.('hidden')\");")],
    ['nested closure', exactWorker("(() => { eval(\"onStep?.('hidden')\"); })();")],
    ['arbitrary function parameter', `${exactWorker()}
      function arbitrary(progress) { eval('progress()'); }
    `],
  ]);
  for (const [name, source] of rejectedSources) {
    assert.match(
      inspectProductionStateSource(workerResultsPath, source).join('\n'),
      /evidence module may not use non-optional direct eval/u,
      name,
    );
  }

  for (const fileName of PRODUCTION_STATE_IMPORTS.keys()) {
    if (!fileName.startsWith('evidence/')) continue;
    assert.match(
      inspectProductionStateSource(
        stateModule(fileName), "eval('lexically captured callback()');",
      ).join('\n'),
      /evidence module may not use non-optional direct eval/u,
      fileName,
    );
  }

  const safeSource = `${exactWorker()}
    function evaluate() { return true; }
    function permittedDynamicCode(evaluator, source) {
      evaluator.eval(source); evaluate(source); eval?.(source); (0, eval)(source);
      globalThis.eval(source); Function(source); return "eval('inert callback()')";
    }
  `;
  assert.deepEqual(
    inspectProductionStateSource(workerResultsPath, safeSource),
    [],
    'indirect/global eval, Function constructors, property calls, and inert strings stay outside the guard',
  );
});

test('state evidence callback capabilities bind exact owners, parameters, and call shapes', () => {
  const positiveSources = new Map([
    [stateModule('evidence/specialist-bundles.mjs'), `
      import { withStateLock } from '../locks.mjs';
      export function planSpecialists({ now = utcNow } = {}) {
        return withStateLock(null, null, () => { const timestamp = now(); return timestamp; });
      }
      export function recordSpecialistReview({ now = utcNow } = {}) {
        return withStateLock(null, null, () => ({ recordedAt: now() }));
      }
    `],
    [stateModule('evidence/validation-plans.mjs'), `
      export function buildTargetedValidationPlanUnlocked({ now = utcNow }) { return now(); }
      export function executeTargetedValidationFacts({
        runCommand, now = utcNow, beforeCommand, onCommandRecorded,
      }) {
        beforeCommand?.(); runCommand(); const completedAt = now(); onCommandRecorded?.();
        return completedAt;
      }
    `],
    [stateModule('evidence/worker-results.mjs'), `
      export function persistWorkerResultEvidence(cwd, state, task, envelope, onStep) {
        onStep?.('receipt-durable'); onStep?.('envelope-durable');
      }
    `],
  ]);
  for (const [path, source] of positiveSources) {
    assert.deepEqual(inspectProductionStateSource(path, source), [], path);
  }
  const unrelatedDataSource = `${positiveSources.get(stateModule('evidence/worker-results.mjs'))}
    function moveUnrelatedData(now, handlerValue, input) {
      const stored = { now, handlerValue };
      const selected = input ? now : handlerValue;
      return { selected, stored };
    }
    function useSafeLocalClosures(value, condition) {
      const predicate = () => condition;
      const localFactory = () => () => true;
      const box = {
        get callback() { return () => true; },
        method() { return () => true; },
        arrow: () => () => true,
        fn: function localFunction() { return () => true; },
      };
      predicate(); localFactory()(); box.callback(); box.method()(); box.arrow()(); box.fn()();
      class LocalBox {
        get callback() { return () => true; }
        method() { return () => true; }
        ['arrow'] = () => () => true;
        set stored(fn) { this.local = () => true; }
      }
      const localBox = new LocalBox();
      localBox.callback(); localBox.method()(); localBox['arrow']()();
      localBox.stored = () => true;
      const makeLocalBox = () => class {
        get callback() { return () => true; }
        method() { return () => true; }
        field = () => true;
      };
      const makeLocalBoxFactory = () => makeLocalBox;
      const returnedBox = new (makeLocalBox())();
      returnedBox.callback(); returnedBox.method()(); returnedBox.field();
      new (makeLocalBoxFactory()())().field();
      const safeHolder = { Box: class { callback = () => true; } };
      const safeFactory = () => ({ Box: class { method() { return () => true; } } });
      const safeArray = [class { get callback() { return () => true; } }];
      const safeKey = condition ? 'Box' : 'Box';
      new safeHolder.Box().callback(); new (safeFactory().Box)().method()();
      new safeHolder[safeKey]().callback(); new safeArray[0]().callback();
      const safeGetterHolder = { get Box() { return class { callback = () => true; }; } };
      class SafeClassHolder {
        static get Box() { return class { method() { return () => true; } }; }
        static Field = class { callback = () => true; };
        get Box() { return class { callback = () => true; }; }
        Field = class { callback = () => true; };
      }
      new safeGetterHolder.Box().callback(); new SafeClassHolder.Box().method()();
      new SafeClassHolder.Field().callback();
      const safeClassHolder = new SafeClassHolder();
      new safeClassHolder.Box().callback(); new safeClassHolder.Field().callback();
      const safeFactoryGetterHolder = {
        get Box() { return () => class { callback = () => true; }; },
      };
      class SafeFactoryClassHolder {
        static get Box() { return () => class { callback = () => true; }; }
        get Box() { return () => class { callback = () => true; }; }
      }
      new (safeFactoryGetterHolder.Box())().callback();
      new (SafeFactoryClassHolder.Box())().callback();
      new (new SafeFactoryClassHolder().Box())().callback();
      return value;
    }
  `;
  assert.deepEqual(
    inspectProductionStateSource(
      stateModule('evidence/worker-results.mjs'), unrelatedDataSource,
    ),
    [],
    'ordinary parameter data flow must not be classified by callback-like spelling',
  );
});

test('state evidence callback capabilities fail closed on indirection and escape', () => {
  const workerResultsPath = stateModule('evidence/worker-results.mjs');
  const workerSource = (body, prefix = '') => `${prefix}
    export function persistWorkerResultEvidence(cwd, state, task, envelope, onStep) {
      ${body}
    }
  `;
  const rejectedSources = new Map([
    ['arbitrary owner', 'function arbitrary(cwd, state, task, envelope, onStep) { onStep?.(); }'],
    ['wrong parameter slot', 'export function persistWorkerResultEvidence(cwd, state, task, onStep) { onStep?.(); }'],
    ['wrong direct shape', workerSource("onStep('receipt'); onStep?.('envelope');")],
    ['declaration alias', workerSource("const escaped = onStep; escaped(); onStep?.('a'); onStep?.('b');")],
    ['assignment alias', workerSource("let escaped; escaped = onStep; escaped(); onStep?.('a'); onStep?.('b');")],
    ['object storage', workerSource("const stored = { onStep }; onStep?.('a'); onStep?.('b'); return stored;")],
    ['array storage', workerSource("const stored = [onStep]; onStep?.('a'); onStep?.('b'); return stored;")],
    ['destructuring storage', workerSource("const { callback } = { callback: onStep }; onStep?.('a'); onStep?.('b'); return callback;")],
    ['call indirection', workerSource("onStep.call(null); onStep?.('a'); onStep?.('b');")],
    ['apply indirection', workerSource("onStep.apply(null, []); onStep?.('a'); onStep?.('b');")],
    ['bind indirection', workerSource("onStep.bind(null)(); onStep?.('a'); onStep?.('b');")],
    ['computed call indirection', workerSource("onStep['call'](null); onStep?.('a'); onStep?.('b');")],
    ['computed apply indirection', workerSource("onStep['apply'](null, []); onStep?.('a'); onStep?.('b');")],
    ['computed bind indirection', workerSource("onStep['bind'](null)(); onStep?.('a'); onStep?.('b');")],
    ['Reflect indirection', workerSource("Reflect.apply(onStep, null, []); onStep?.('a'); onStep?.('b');")],
    ['Function prototype indirection', workerSource("Function.prototype.call.call(onStep, null); onStep?.('a'); onStep?.('b');")],
    ['local callback forwarding', workerSource("consume(onStep); onStep?.('a'); onStep?.('b');")],
    ['imported callback forwarding', workerSource("consume(onStep); onStep?.('a'); onStep?.('b');", "import { consume } from './consumer.mjs';")],
    ['property callback forwarding', workerSource("consumer.consume(onStep); onStep?.('a'); onStep?.('b');")],
    ['callback return', workerSource("onStep?.('a'); onStep?.('b'); return onStep;")],
    ['callback yield', `
      export function* persistWorkerResultEvidence(cwd, state, task, envelope, onStep) {
        onStep?.('a'); onStep?.('b'); yield onStep;
      }
    `],
    ['nested closure escape', workerSource("onStep?.('a'); onStep?.('b'); return () => onStep?.('later');")],
    ['shadowed callback name', workerSource("onStep?.('a'); onStep?.('b'); { const onStep = () => {}; onStep(); }")],
  ]);
  for (const [name, source] of rejectedSources) {
    assert.match(
      inspectProductionStateSource(workerResultsPath, source).join('\n'),
      /evidence callback|may not invoke function parameter/u,
      name,
    );
  }
  const exactWorker = workerSource("onStep?.('a'); onStep?.('b');");
  for (const source of [
    `${exactWorker} function arbitrary(onProgress) { const escaped = onProgress; escaped(); }`,
    `${exactWorker} function arbitrary(onProgress, condition) {
      const escaped = condition ? onProgress : () => {}; escaped();
    }`,
  ]) {
    assert.match(
      inspectProductionStateSource(workerResultsPath, source).join('\n'),
      /may not invoke function parameter onProgress/u,
      source,
    );
  }

  const arbitrarySource = (body, prefix = '') => `${exactWorker} ${prefix}
    function arbitrary(progress, consume, condition) {
      ${body}
    }
  `;
  const arbitraryCallbackEscapes = new Map([
    ['direct call', 'progress.call(null);'],
    ['direct apply', 'progress.apply(null, []);'],
    ['direct bind', 'progress.bind(null);'],
    ['computed call', "progress['call'](null);"],
    ['computed apply', "progress['apply'](null, []);"],
    ['computed bind', "progress['bind'](null);"],
    ['Reflect apply', 'Reflect.apply(progress, null, []);'],
    ['Function prototype call', 'Function.prototype.call.call(progress, null);'],
    ['Function prototype apply', 'Function.prototype.apply.call(progress, null, []);'],
    ['nested closure', 'return () => progress();'],
    ['declaration alias', 'const escaped = progress; escaped();'],
    ['assignment alias', 'let escaped; escaped = progress; escaped();'],
    ['new expression', 'new progress();'],
    ['tagged template', 'progress`value`;'],
    ['member new expression', 'const box = { callback: progress }; new box.callback();'],
    ['member tagged template', 'const box = { callback: progress }; box.callback`value`;'],
    ['computed member new expression', "const box = { callback: progress }; new box['callback']();"],
    ['computed member tagged template', "const box = { callback: progress }; box['callback']`value`;"],
    ['dynamic member new expression', 'const box = { callback: progress }; new box[key]();'],
    ['conditional new expression', 'new (condition ? progress : class {})();'],
    ['conditional tagged template', '(condition ? progress : String.raw)`value`;'],
  ]);
  for (const [name, body] of arbitraryCallbackEscapes) {
    const output = inspectProductionStateSource(
      workerResultsPath, arbitrarySource(body),
    ).join('\n');
    assert.match(output, /may not use callback parameter progress/u, name);
  }

  const factoryReturnedClassSource = (member, sink) => `
    ${exactWorker} function arbitrary(progress) {
      const makeBox = () => class { ${member} }; ${sink}
    }
  `;
  const flowSources = new Map([
    ['branch and safe overwrite', `
      ${exactWorker} function arbitrary(value, condition) {
        let escaped; if (condition) escaped = value; else escaped = () => {};
        escaped = () => {}; escaped();
      }
    `],
    ['conditional and logical RHS', `
      ${exactWorker} function arbitrary(value, condition) {
        let escaped; escaped ||= condition ? value : () => {}; escaped();
      }
    `],
    ['destructuring assignment', `
      ${exactWorker} function arbitrary(value) {
        let escaped; [escaped] = [value]; escaped();
      }
    `],
    ['member assignment', `
      ${exactWorker} function arbitrary(value) {
        const stored = {}; stored.callback = value; stored.callback();
      }
    `],
    ['computed member assignment', `
      ${exactWorker} function arbitrary(value, key) {
        const stored = {}; stored[key] = value; stored[key]();
      }
    `],
    ['object container alias', `
      ${exactWorker} function arbitrary(value) {
        const stored = { callback: value }; const alias = stored; alias.callback();
      }
    `],
    ['array container alias', `
      ${exactWorker} function arbitrary(value) {
        const stored = [value]; const alias = stored; alias[0]();
      }
    `],
    ['conditional callee expression', `
      ${exactWorker} function arbitrary(value, condition) {
        (condition ? value : () => {})();
      }
    `],
    ['inline object member call', `
      ${exactWorker} function arbitrary(value) {
        ({ callback: value }).callback();
      }
    `],
    ['conditional container alias call', `
      ${exactWorker} function arbitrary(value, condition) {
        const box = { callback: value }; const alias = condition ? box : {};
        alias.callback();
      }
    `],
    ['nested container member call', `
      ${exactWorker} function arbitrary(value) {
        const box = { inner: { callback: value } }; box.inner.callback();
      }
    `],
    ['inline object member new', `
      ${exactWorker} function arbitrary(value) {
        new ({ callback: value }).callback();
      }
    `],
    ['inline object member tag', `
      ${exactWorker} function arbitrary(value) {
        ({ callback: value }).callback\`value\`;
      }
    `],
    ['inline computed member call', `
      ${exactWorker} function arbitrary(value) {
        ({ callback: value })['callback']();
      }
    `],
    ['inline computed member new', `
      ${exactWorker} function arbitrary(value) {
        new ({ callback: value })['callback']();
      }
    `],
    ['inline computed member tag', `
      ${exactWorker} function arbitrary(value) {
        ({ callback: value })['callback']\`value\`;
      }
    `],
    ['inline getter member call', `
      ${exactWorker} function arbitrary(progress) {
        ({ get callback() { return progress; } }).callback();
      }
    `],
    ['inline computed getter member call', `
      ${exactWorker} function arbitrary(progress) {
        ({ get ['callback']() { return progress; } })['callback']();
      }
    `],
    ['inline getter returned arrow call chain', `
      ${exactWorker} function arbitrary(progress) {
        ({ get callback() { return () => progress; } }).callback()();
      }
    `],
    ['inline method return call', `
      ${exactWorker} function arbitrary(progress) {
        ({ callback() { return progress; } }).callback()();
      }
    `],
    ['inline method direct return escape', `
      ${exactWorker} function arbitrary(progress) {
        ({ callback() { return progress; } }).callback();
      }
    `],
    ['inline computed method return call', `
      ${exactWorker} function arbitrary(progress) {
        ({ ['callback']() { return progress; } })['callback']()();
      }
    `],
    ['inline arrow property return call', `
      ${exactWorker} function arbitrary(progress) {
        ({ callback: () => progress }).callback()();
      }
    `],
    ['inline arrow property direct return escape', `
      ${exactWorker} function arbitrary(progress) {
        ({ callback: () => progress }).callback();
      }
    `],
    ['inline computed arrow property return call', `
      ${exactWorker} function arbitrary(progress) {
        ({ ['callback']: () => progress })['callback']()();
      }
    `],
    ['inline function property return call', `
      ${exactWorker} function arbitrary(progress) {
        ({ callback: function factory() { return progress; } }).callback()();
      }
    `],
    ['IIFE return call', `
      ${exactWorker} function arbitrary(progress) {
        (() => progress)()();
      }
    `],
    ['IIFE returned arrow call chain', `
      ${exactWorker} function arbitrary(progress) {
        (() => () => progress)()()();
      }
    `],
    ['named block factory return call', `
      ${exactWorker} function arbitrary(progress) {
        function factory() { if (true) { return progress; } return () => {}; }
        factory()();
      }
    `],
    ['conditional factory return call', `
      ${exactWorker} function arbitrary(progress, condition) {
        const factory = () => condition ? progress : () => {}; factory()();
      }
    `],
    ['factory returned object member call', `
      ${exactWorker} function arbitrary(progress) {
        const factory = () => ({ callback: progress, data: 'safe' });
        factory().callback();
      }
    `],
    ['class instance getter member call', `
      ${exactWorker} function arbitrary(progress) {
        class Box { get callback() { return progress; } }
        new Box().callback();
      }
    `],
    ['class getter returned arrow call chain', `
      ${exactWorker} function arbitrary(progress) {
        class Box { get callback() { return () => progress; } }
        new Box().callback()();
      }
    `],
    ['class instance method return call', `
      ${exactWorker} function arbitrary(progress) {
        class Box { callback() { return progress; } }
        new Box().callback()();
      }
    `],
    ['class computed method return call', `
      ${exactWorker} function arbitrary(progress) {
        class Box { ['callback']() { return progress; } }
        new Box()['callback']()();
      }
    `],
    ['class arrow field return call', `
      ${exactWorker} function arbitrary(progress) {
        class Box { callback = () => progress; }
        new Box().callback()();
      }
    `],
    ['class static method return call', `
      ${exactWorker} function arbitrary(progress) {
        class Box { static callback() { return progress; } }
        Box.callback()();
      }
    `],
    ['class expression getter member call', `
      ${exactWorker} function arbitrary(progress) {
        const Box = class { get ['callback']() { return progress; } };
        new Box()['callback']();
      }
    `],
    ['factory class getter call', factoryReturnedClassSource(
      'get callback() { return progress; }', 'new (makeBox())().callback();',
    )],
    ['factory class getter new', factoryReturnedClassSource(
      'get callback() { return progress; }', 'new (new (makeBox())().callback)();',
    )],
    ['factory class getter tag', factoryReturnedClassSource(
      'get callback() { return progress; }', 'new (makeBox())().callback`value`;',
    )],
    ['factory class method call', factoryReturnedClassSource(
      'callback() { return progress; }', 'new (makeBox())().callback()();',
    )],
    ['factory class method new', factoryReturnedClassSource(
      'callback() { return progress; }', 'new (new (makeBox())().callback())();',
    )],
    ['factory class method tag', factoryReturnedClassSource(
      'callback() { return progress; }', 'new (makeBox())().callback()`value`;',
    )],
    ['factory class field call', factoryReturnedClassSource(
      'callback = progress;', 'new (makeBox())().callback();',
    )],
    ['factory class field new', factoryReturnedClassSource(
      'callback = progress;', 'new (new (makeBox())().callback)();',
    )],
    ['factory class field tag', factoryReturnedClassSource(
      'callback = progress;', 'new (makeBox())().callback`value`;',
    )],
    ['conditional factory class getter call', `
      ${exactWorker} function arbitrary(progress, condition) {
        const makeBox = condition ? () => class {
          get callback() { return progress; }
        } : () => class {};
        new (makeBox())().callback();
      }
    `],
    ['chained factory class field call', `
      ${exactWorker} function arbitrary(progress) {
        const makeFactory = () => () => class { callback = progress; };
        new (makeFactory()())().callback();
      }
    `],
    ['holder class getter call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { get callback() { return progress; } } };
        new holder.Box().callback();
      }
    `],
    ['holder computed class getter call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { get callback() { return progress; } } };
        new holder['Box']().callback();
      }
    `],
    ['holder wildcard class getter call', `
      ${exactWorker} function arbitrary(progress, key) {
        const holder = { Box: class { get callback() { return progress; } } };
        new holder[key]().callback();
      }
    `],
    ['holder class method call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback() { return progress; } } };
        new holder.Box().callback()();
      }
    `],
    ['holder class method new', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback() { return progress; } } };
        new (new holder.Box().callback())();
      }
    `],
    ['holder class method tag', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback() { return progress; } } };
        new holder.Box().callback()\`value\`;
      }
    `],
    ['holder class field call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback = progress; } };
        new holder.Box().callback();
      }
    `],
    ['holder class field new', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback = progress; } };
        new (new holder.Box().callback)();
      }
    `],
    ['holder class field tag', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box: class { callback = progress; } };
        new holder.Box().callback\`value\`;
      }
    `],
    ['factory returned constructor slot call', `
      ${exactWorker} function arbitrary(progress) {
        const make = () => ({ Box: class { callback = progress; } });
        new (make().Box)().callback();
      }
    `],
    ['factory returned computed constructor slot call', `
      ${exactWorker} function arbitrary(progress) {
        const make = () => ({ Box: class { callback = progress; } });
        new (make()['Box'])().callback();
      }
    `],
    ['factory returned wildcard constructor slot call', `
      ${exactWorker} function arbitrary(progress, key) {
        const make = () => ({ Box: class { callback = progress; } });
        new (make()[key])().callback();
      }
    `],
    ['array constructor slot call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = [class { get callback() { return progress; } }];
        new holder[0]().callback();
      }
    `],
    ['conditional constructor container call', `
      ${exactWorker} function arbitrary(progress, condition) {
        const holder = condition
          ? { Box: class { callback = progress; } } : { Box: class {} };
        new holder.Box().callback();
      }
    `],
    ['assigned constructor slot call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = {}; holder.Box = class { callback = progress; };
        new holder.Box().callback();
      }
    `],
    ['object getter class getter call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { get Box() {
          return class { get callback() { return progress; } };
        } };
        new holder.Box().callback();
      }
    `],
    ['computed object getter class method new', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { get ['Box']() {
          return class { callback() { return progress; } };
        } };
        new (new holder['Box']().callback())();
      }
    `],
    ['wildcard object getter class field tag', `
      ${exactWorker} function arbitrary(progress, key) {
        const holder = { get Box() { return class { callback = progress; }; } };
        new holder[key]().callback\`value\`;
      }
    `],
    ['factory object getter class field call', `
      ${exactWorker} function arbitrary(progress) {
        const make = () => ({ get Box() { return class { callback = progress; }; } });
        new (make().Box)().callback();
      }
    `],
    ['factory computed getter class method tag', `
      ${exactWorker} function arbitrary(progress) {
        const make = () => ({ get ['Box']() {
          return class { callback() { return progress; } };
        } });
        new (make()['Box'])().callback()\`value\`;
      }
    `],
    ['object method class field new', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { Box() { return class { callback = progress; }; } };
        new (new (holder.Box())().callback)();
      }
    `],
    ['static getter class getter call', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static get Box() {
          return class { get callback() { return progress; } };
        } }
        new Holder.Box().callback();
      }
    `],
    ['computed static getter class method new', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static get ['Box']() {
          return class { callback() { return progress; } };
        } }
        new (new Holder['Box']().callback())();
      }
    `],
    ['static field class field tag', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static Box = class { callback = progress; }; }
        new Holder.Box().callback\`value\`;
      }
    `],
    ['static method class field call', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static Box() { return class { callback = progress; }; } }
        new (Holder.Box())().callback();
      }
    `],
    ['instance getter class field call', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { get Box() { return class { callback = progress; }; } }
        new (new Holder().Box)().callback();
      }
    `],
    ['instance field class getter tag', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { Box = class { get callback() { return progress; } }; }
        new (new Holder().Box)().callback\`value\`;
      }
    `],
    ['object getter returned factory class call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { get Box() {
          return () => class { callback = progress; };
        } };
        new (holder.Box())().callback();
      }
    `],
    ['computed object getter returned factory class new', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { get ['Box']() {
          return () => class { callback() { return progress; } };
        } };
        new (new (holder['Box']())().callback())();
      }
    `],
    ['factory object wildcard getter returned factory class call', `
      ${exactWorker} function arbitrary(progress, key) {
        const make = () => ({ get Box() {
          return () => class { callback = progress; };
        } });
        new (make()[key]())().callback();
      }
    `],
    ['factory object getter returned factory class tag', `
      ${exactWorker} function arbitrary(progress) {
        const make = () => ({ get Box() {
          return () => class { callback = progress; };
        } });
        new (make().Box())().callback\`value\`;
      }
    `],
    ['static getter returned factory class call', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static get Box() {
          return () => class { callback = progress; };
        } }
        new (Holder.Box())().callback();
      }
    `],
    ['computed static getter returned factory class new', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { static get ['Box']() {
          return () => class { callback() { return progress; } };
        } }
        new (new (Holder['Box']())().callback())();
      }
    `],
    ['instance getter returned factory class tag', `
      ${exactWorker} function arbitrary(progress) {
        class Holder { get Box() {
          return () => class { callback = progress; };
        } }
        new (new Holder().Box())().callback\`value\`;
      }
    `],
    ['getter returned multi-call factory class call', `
      ${exactWorker} function arbitrary(progress) {
        const holder = { get Box() {
          return () => () => class { callback = progress; };
        } };
        new (holder.Box()())().callback();
      }
    `],
    ['call-result alias', `
      ${exactWorker} function arbitrary(progress, identity) {
        const escaped = identity(progress); escaped();
      }
    `],
  ]);
  for (const [name, source] of flowSources) {
    assert.match(
      inspectProductionStateSource(workerResultsPath, source).join('\n'),
      /may not (?:use callback|invoke function) parameter (?:value|progress)/u,
      name,
    );
  }
});

test('state dependency cycle detection includes façade source re-export edges', () => {
  const imports = new Map([
    ['facade.mjs', new Map()],
    ['owner.mjs', new Map([[stateModule('facade.mjs'), []]])],
  ]);
  const sourceExports = new Map([
    ['facade.mjs', new Map([[stateModule('owner.mjs'), ['owner']]])],
  ]);
  assert.equal(productionStateCycle(imports, new Map()), null);
  assert.deepEqual(
    productionStateCycle(imports, sourceExports),
    ['facade.mjs', 'owner.mjs', 'facade.mjs'],
  );
});

test('contract AST guards reject normalized boundary and module-system escape hatches', () => {
  const gatesPath = contractModule('gates.mjs');
  const rejectedSources = [
    ["import { validatePrReviewState } from './nested/../../state/state.mjs';", /unapproved dependency/u],
    ["import { githubStatus } from '../github/github.mjs';", /unapproved dependency/u],
    ["import { runHook } from '../hooks/session-start.mjs';", /unapproved dependency/u],
    ["import { createWorktree } from '../worktree/worktree.mjs';", /unapproved dependency/u],
    ["import { main } from '../state/cli.mjs';", /unapproved dependency/u],
    ["import { reviewRequestGate } from './contracts.mjs';", /unapproved dependency/u],
    ["export * from './primitives.mjs';", /export-star is forbidden/u],
    ["const contracts = await import('./primitives.mjs');", /dynamic import is forbidden/u],
    ["const contracts = require('./primitives.mjs');", /CommonJS require is forbidden/u],
    ["import { createRequire } from 'node:module';", /createRequire is forbidden/u],
    ["import primitives from './primitives.mjs';", /default import is forbidden/u],
    ["import * as primitives from './primitives.mjs';", /namespace import is forbidden/u],
    ["import './primitives.mjs';", /side-effect import is forbidden/u],
  ];
  for (const [source, expected] of rejectedSources) {
    assert.match(inspectProductionContractSource(gatesPath, source).join('\n'), expected, source);
  }

  for (const [importer, source] of [
    [gatesPath, "import { isObject } from './primitives.mjs';"],
    [contractModule('contract-identities.mjs'), "import { createHash } from 'node:crypto';"],
    [contractModule('targeted-validation.mjs'), "import { featureDirectory } from '../paths.mjs';"],
    [contractModule('task-packet.mjs'), "import { validateSpecialization } from '../../../aerstello-specialists/scripts/validate-registry.mjs';"],
  ]) assert.deepEqual(inspectProductionContractSource(importer, source), []);

  const legitimateTest = testImportTargets(
    contractModule('state-v3.test.mjs'),
    "import assert from 'node:assert/strict';\nimport Ajv2020 from 'ajv/dist/2020.js';\nimport { prReviewStateSchemaPath } from '../paths.mjs';\nimport { validatePrReviewState } from './state-v3.mjs';",
  );
  assert.deepEqual(legitimateTest.errors, []);
  assert.match(testImportTargets(
    contractModule('state-v3.test.mjs'),
    "import { validateState } from './nested/../../state/state.mjs';",
  ).errors.join('\n'), /forbidden workflow layer/u);
});

test('extracted GitHub production modules obey exact AST dependency and export boundaries', () => {
  const productionFiles = productionGitHubFiles();
  assert.deepEqual(
    sorted(PRODUCTION_GITHUB_IMPORTS.keys()),
    sorted(PRODUCTION_GITHUB_EXPORTS.keys()),
  );
  assert.deepEqual(sorted(PRODUCTION_GITHUB_IMPORTS.keys()), productionFiles);
  assert.deepEqual(sorted(PRODUCTION_GITHUB_EXPORTS.keys()), productionFiles);
  assert.equal(productionGitHubCycle(), null, 'GitHub production dependency graph must be acyclic');
  for (const fileName of sorted(PRODUCTION_GITHUB_IMPORTS.keys())) {
    const path = githubModule(fileName);
    assert.equal(statSync(path).isFile(), true, `missing GitHub production module ${fileName}`);
    assert.deepEqual(
      validateProductionGitHubSource(path, readFileSync(path, 'utf8')),
      [],
      fileName,
    );
  }
});

test('focused GitHub tests directly own exact lower-layer modules', () => {
  assert.deepEqual(
    sorted(FOCUSED_GITHUB_TEST_IMPORTS.keys()),
    sorted(FOCUSED_GITHUB_TEST_OWNERS.keys()),
  );
  for (const fileName of sorted(FOCUSED_GITHUB_TEST_IMPORTS.keys())) {
    const path = githubModule(fileName);
    assert.equal(statSync(path).isFile(), true, `missing focused GitHub test ${fileName}`);
    const { errors, targets } = validateFocusedGitHubTestSource(path, readFileSync(path, 'utf8'));
    assert.deepEqual(errors, [], fileName);
    assert.ok(
      targets.includes(githubModule(FOCUSED_GITHUB_TEST_OWNERS.get(fileName))),
      `${fileName} must directly import its production owner`,
    );
  }
});

test('GitHub AST guards reject dependency, export, and module-system escape hatches', () => {
  const ciPath = githubModule('evidence/ci.mjs');
  const rejectedProductionSources = [
    ["import { validateState } from './nested/../../../state/state.mjs';", /unapproved GitHub dependency/u],
    ["import { createGitHubReviewWorkflow } from '../github.mjs';", /unapproved GitHub dependency/u],
    ["import { runCli } from '../cli.mjs';", /unapproved GitHub dependency/u],
    ["import { loadArchiveFixture } from '../archive/archive-fixture-loader.mjs';", /unapproved GitHub dependency/u],
    ["import { runHook } from '../../hooks/session-start.mjs';", /unapproved GitHub dependency/u],
    ["import { createWorktree } from '../../worktree/worktree.mjs';", /unapproved GitHub dependency/u],
    ["import { adoptArchiveBatch } from '../archive/adoption.mjs';", /unapproved GitHub dependency/u],
    ["import { postThreadReply } from '../mutations/thread-reply-resolve.mjs';", /unapproved GitHub dependency/u],
    ["import { createStatusUseCase } from '../workflow/status.mjs';", /unapproved GitHub dependency/u],
    ["import { workflow } from '../test-support/workflow-harness.mjs';", /unapproved GitHub dependency/u],
    ["export * from './primitives.mjs';", /export-star is forbidden/u],
    ["export { httpsUrl } from './primitives.mjs';", /source re-export is forbidden/u],
    ["const dependency = await import('./primitives.mjs');", /dynamic import is forbidden/u],
    ["const dependency = require('./primitives.mjs');", /CommonJS require is forbidden/u],
    ["import dependency = require('./primitives.mjs');", /CommonJS import assignment is forbidden/u],
    ["import { createRequire } from 'node:module';", /createRequire is forbidden/u],
    ["import dependency from './primitives.mjs';", /default import is forbidden/u],
    ["import * as dependency from './primitives.mjs';", /namespace import is forbidden/u],
    ["import './primitives.mjs';", /side-effect import is forbidden/u],
    ["import { httpsUrl as url } from './primitives.mjs';", /do not match the exact/u],
    ["export default function leaked() {}", /default export is forbidden/u],
    ["export const leaked = true;", /unexpected GitHub module export leaked/u],
  ];
  for (const [source, expected] of rejectedProductionSources) {
    assert.match(inspectProductionGitHubSource(ciPath, source).join('\n'), expected, source);
  }

  const duplicatedActorDependency = [
    "import { GitHubWorkflowError } from '../errors.mjs';",
    "import { GitHubWorkflowError } from '../errors.mjs';",
    'export const CANONICAL_LOGIN = "login";',
    'export const CANONICAL_URL = "url";',
    'export function actorObservation() {}',
    'export function isCanonicalActor() {}',
    'export function isViewerActor() {}',
  ].join('\n');
  assert.match(
    validateProductionGitHubSource(
      githubModule('evidence/actors.mjs'), duplicatedActorDependency,
    ).join('\n'),
    /import targets must exactly match/u,
  );

  const cyclicImports = new Map([
    ['one.mjs', new Map([[githubModule('two.mjs'), ['two']]])],
    ['two.mjs', new Map([[githubModule('one.mjs'), ['one']]])],
  ]);
  assert.deepEqual(productionGitHubCycle(cyclicImports), ['one.mjs', 'two.mjs', 'one.mjs']);

  for (const [importer, source] of [
    [githubModule('graphql/client.mjs'), [
      "import { GitHubWorkflowError } from '../errors.mjs';",
      "import { OPERATIONS } from './operations.mjs';",
    ].join('\n')],
    [githubModule('evidence/review-response.mjs'), [
      "import { createHash } from 'node:crypto';",
      "import { GitHubWorkflowError } from '../errors.mjs';",
      "import { actorObservation, isCanonicalActor } from './actors.mjs';",
    ].join('\n')],
    [githubModule('adapters/gh-cli.mjs'), [
      "import { execFileSync } from 'node:child_process';",
      "import { GitHubWorkflowError } from '../errors.mjs';",
    ].join('\n')],
    [githubModule('adapters/state.mjs'), [
      `import { ${STATE_ADAPTER_OPERATIONS.join(', ')} } from '../../state/state.mjs';`,
    ].join('\n')],
  ]) assert.deepEqual(inspectProductionGitHubSource(importer, source), []);

  const focusedPath = githubModule('evidence/ci.test.mjs');
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "import { createGitHubReviewWorkflow } from '../github.mjs';",
  ).errors.join('\n'), /unapproved dependency/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "import { validateState } from './nested/../../../state/state.mjs';",
  ).errors.join('\n'), /unapproved dependency/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "const dependency = await import('./ci.mjs');",
  ).errors.join('\n'), /may not use dynamic import/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "const dependency = require('./ci.mjs');",
  ).errors.join('\n'), /may not use require/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "import { createRequire } from 'node:module';",
  ).errors.join('\n'), /may not use createRequire/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "import dependency = require('./ci.mjs');",
  ).errors.join('\n'), /may not use import assignment/u);
  assert.match(inspectFocusedGitHubTestSource(
    focusedPath,
    "export { ciEvidenceFromRollup } from './ci.mjs';",
  ).errors.join('\n'), /may not export/u);
});

test('hooks and npm façades target only canonical skill entrypoints', () => {
  const hooks = JSON.parse(readRepositoryFile('.codex/hooks.json'));
  assert.deepEqual(hooks.hooks.SubagentStop.map(({ matcher }) => matcher), [
    '^review_fix_worker$', '^implementation_worker$',
  ]);
  assert.equal(hooks.hooks.SubagentStop[0].matcher, '^review_fix_worker$');
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.agents/skills/pr-review-cycle/scripts/hooks/session-start.mjs"',
  );
  assert.equal(
    hooks.hooks.PreCompact[0].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.agents/skills/pr-review-cycle/scripts/hooks/pre-compact.mjs"',
  );
  assert.equal(
    hooks.hooks.SubagentStop[0].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.agents/skills/pr-review-cycle/scripts/hooks/subagent-stop.mjs"',
  );
  assert.equal(
    hooks.hooks.SubagentStop[1].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.agents/skills/change-development/scripts/hooks/subagent-stop.mjs"',
  );

  const scripts = JSON.parse(readRepositoryFile('package.json')).scripts;
  assert.equal(scripts['review:state'], 'node .agents/skills/pr-review-cycle/scripts/state/cli.mjs');
  assert.equal(scripts['review:github'], 'node .agents/skills/pr-review-cycle/scripts/github/cli.mjs');
  assert.equal(scripts['review:worktree'], 'node .agents/skills/pr-review-cycle/scripts/worktree/cli.mjs');
  assert.equal(
    scripts['review:status'],
    'node .agents/skills/pr-review-cycle/scripts/github/cli.mjs status --human',
  );
  assert.equal(
    scripts['test:pr-review'],
    'node --test ".agents/skills/pr-review-cycle/scripts/**/*.test.mjs"',
  );
  assert.equal(
    scripts['test:specialists'],
    'node --test ".agents/skills/aerstello-specialists/scripts/**/*.test.mjs"',
  );
  assert.equal(
    scripts['test:tooling'],
    'npm run test:change-development && npm run test:pr-review && npm run test:specialists && node --test "scripts/**/*.test.mjs" && npm run test:e2e:structure',
  );
  assert.equal(scripts['check:workflow'], 'npm run test:tooling');
  assert.equal(scripts.test, 'npm run test:tooling && npm run test --workspaces --if-present');
  assert.equal(scripts['check:full'], 'npm run typecheck && npm run test && npm run build');
  assert.equal(scripts['test:e2e:related'], 'node scripts/run-related-e2e.mjs');
  assert.equal(scripts['test:e2e:full'], 'bddgen && playwright test');
  assert.equal(scripts['release:state'], 'node scripts/release-state.mjs --json');
  assert.equal(scripts['check:release-state'], 'node scripts/release-state.mjs --check');
  assert.equal(scripts['check:released-migrations'], 'node scripts/check-released-migrations.mjs');

  const workflow = readRepositoryFile('.github/workflows/ci.yml');
  assert.match(workflow, /^name:\s*CI\s*$/mu);
  assert.match(workflow, /Full validation/u);
  assert.match(workflow, /npm run check:full/u);
  assert.match(workflow, /npm run test:e2e:full/u);
});

test('agent configuration preserves the global thread cap and read-only verifier boundary', () => {
  const config = readRepositoryFile('.codex/config.toml');
  assert.match(config, /^max_concurrent_threads_per_session = 4$/mu);
  for (const [role, configFile] of [
    ['review_fix_worker', 'agents/review-fix-worker.toml'],
    ['integration_verifier', 'agents/integration-verifier.toml'],
    ['behavior_mapper', 'agents/behavior-mapper.toml'],
    ['security_reviewer', 'agents/security-reviewer.toml'],
    ['offline_realtime_reviewer', 'agents/offline-realtime-reviewer.toml'],
    ['implementation_worker', 'agents/implementation-worker.toml'],
  ]) {
    assert.match(
      config,
      new RegExp(`^\\[agents\\.${role}\\][\\s\\S]*?^config_file = "${configFile}"$`, 'mu'),
    );
  }

  const verifier = readRepositoryFile('.codex/agents/integration-verifier.toml');
  assert.match(verifier, /^sandbox_mode = "read-only"$/mu);
  assert.match(verifier, /^\[agents\]\nenabled = false$/mu);
  assert.match(verifier, /Never edit files/u);
  assert.match(verifier, /delegate/u);
});

test('root npm façades remain available from a nested workspace directory', () => {
  const workspaceDirectory = join(repositoryDirectory, 'apps', 'api');
  const facades = [
    {
      script: 'review:state',
      usage: 'Usage: node .agents/skills/pr-review-cycle/scripts/state/cli.mjs <command> [options]',
    },
    {
      script: 'review:github',
      usage: 'Usage: node .agents/skills/pr-review-cycle/scripts/github/cli.mjs <command> [--pr <number>] [options]',
    },
    {
      script: 'review:worktree',
      usage: 'Usage: node .agents/skills/pr-review-cycle/scripts/worktree/cli.mjs <create|inspect|remove> [options]',
    },
  ];

  for (const { script, usage } of facades) {
    const result = spawnSync(
      'npm',
      ['--prefix', repositoryDirectory, 'run', script, '--', '--help'],
      { cwd: workspaceDirectory, encoding: 'utf8' },
    );
    assert.equal(result.error, undefined, `${script} failed to start`);
    assert.equal(result.status, 0, `${script} failed:\n${result.stderr}`);
    assert.equal(result.signal, null, `${script} terminated by ${result.signal}`);
    assert.ok(result.stdout.includes(`${usage}\n`), `${script} did not print canonical usage`);
    if (script === 'review:github') assert.match(result.stdout, /advance --pr <number>/u);
  }

  const status = spawnSync(
    'npm',
    ['--prefix', repositoryDirectory, 'run', 'review:status'],
    { cwd: workspaceDirectory, encoding: 'utf8' },
  );
  assert.equal(status.error, undefined, 'review:status failed to start');
  assert.equal(status.signal, null, `review:status terminated by ${status.signal}`);
  assert.ok([0, 1].includes(status.status), `review:status failed unexpectedly:\n${status.stderr}`);
  if (status.status === 1) assert.match(status.stderr, /STATE_NOT_FOUND/u);
});

test('schemas and operator documentation have one canonical copy', () => {
  const files = repositoryFiles();
  const schemaIds = new Map([
    ['https://aerstello.local/schemas/pr-review-state.schema.json', 'schemas/pr-review-state.schema.json'],
    ['https://aerstello.local/schemas/review-fix-task.schema.json', 'schemas/review-fix-task.schema.json'],
    ['https://aerstello.local/schemas/review-fix-result.schema.json', 'schemas/review-fix-result.schema.json'],
  ]);
  for (const [id, expectedSkillPath] of schemaIds) {
    const matches = files.filter((path) => {
      if (!path.endsWith('.schema.json')) return false;
      try {
        return JSON.parse(readRepositoryFile(path)).$id === id;
      } catch {
        return false;
      }
    });
    assert.deepEqual(matches, [`.agents/skills/pr-review-cycle/${expectedSkillPath}`]);
  }

  const guideHeading = '# PR review-cycle operator guide';
  const guideCopies = files.filter((path) => path.endsWith('.md')
    && readRepositoryFile(path).split(/\r?\n/u).includes(guideHeading));
  assert.deepEqual(guideCopies, ['.agents/skills/pr-review-cycle/README.md']);

  const stateSchema = JSON.parse(readRepositoryFile(
    '.agents/skills/pr-review-cycle/schemas/pr-review-state.schema.json',
  ));
  assert.ok(Object.hasOwn(stateSchema.properties, 'reviewRequestLimit'));
  assert.equal(stateSchema.required.includes('reviewRequestLimit'), false);
  for (const volatile of ['pullRequest', 'state', 'isDraft', 'reviewObservation', 'pullRequestReadiness']) {
    assert.equal(Object.hasOwn(stateSchema.properties, volatile), false);
  }
  for (const path of [
    '.agents/skills/pr-review-cycle/SKILL.md',
    '.agents/skills/pr-review-cycle/README.md',
    '.agents/skills/pr-review-cycle/references/github-review.md',
  ]) {
    const source = readRepositoryFile(path);
    assert.doesNotMatch(source, /three discovery reviews, only one|Run at most three discovery|round limits/u);
  }
  assert.match(
    readRepositoryFile('.agents/skills/pr-review-cycle/references/state-and-contracts.md'),
    /missing or\s+`null` means no configured request-count cap/u,
  );
  const githubUsage = readRepositoryFile('.agents/skills/pr-review-cycle/scripts/github/cli.mjs');
  assert.match(githubUsage, /advance --pr <number>/u);
  assert.match(githubUsage, /Read-only diagnostic/u);
  const readme = readRepositoryFile('.agents/skills/pr-review-cycle/README.md');
  const skill = readRepositoryFile('.agents/skills/pr-review-cycle/SKILL.md');
  const githubGuide = readRepositoryFile('.agents/skills/pr-review-cycle/references/github-review.md');
  const stateGuide = readRepositoryFile('.agents/skills/pr-review-cycle/references/state-and-contracts.md');
  for (const source of [readme, skill, githubGuide]) {
    assert.match(source, /npm run review:github -- advance --pr/u);
  }
  assert.match(githubGuide, /supported helper commands/u);
  assert.match(githubGuide, /request-owner lock/u);
  assert.match(githubGuide, /durable dispatch\s+marker/u);
  assert.match(githubGuide, /intentionally \*\*uncertain\*\*[\s\S]*returns waiting/u);
  assert.match(githubGuide, /clientMutationId` is a\s+correlation value, not GitHub idempotency/u);
  assert.match(githubGuide, /npm run review:github -- request --pr <number>/u);
  assert.match(githubGuide, /cannot be reconciled by `advance`/u);
  for (const value of ['not-applicable', 'waiting', 'collectable', 'ambiguous', 'stale', 'already-ready', 'marked-ready', 'recovered-ready', 'performedTransitions', 'cycle-completion']) {
    assert.match(githubGuide, new RegExp(value, 'u'));
  }
  assert.match(stateGuide, /volatile GitHub evidence/u);
  assert.match(stateGuide, /not a state schema addition/u);
  assert.match(stateGuide, /ready:<pr>:<pr-node>:<head>/u);
  assert.match(readme, /issue\s+#?25/iu);
});

test('external adapters link to the canonical guide without obsolete references', () => {
  const adapterPaths = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'README.md',
    '.codex/agents/integration-verifier.toml',
    '.codex/agents/review-fix-worker.toml',
  ];
  for (const path of adapterPaths) {
    const source = readRepositoryFile(path);
    assert.match(source, /\.agents\/skills\/pr-review-cycle\/README\.md/u, `missing canonical guide link in ${path}`);
    for (const obsolete of [
      'docs/agents/pr-review-cycle.md',
      'docs/agents/pr-review-state.schema.json',
      'docs/agents/review-fix-task.schema.json',
      'docs/agents/review-fix-result.schema.json',
      'scripts/pr-review-state.mjs',
      'scripts/pr-review-github.mjs',
      'scripts/pr-review-worktree.mjs',
      '.codex/hooks/session-start.mjs',
      '.codex/hooks/pre-compact.mjs',
      '.codex/hooks/subagent-stop.mjs',
    ]) {
      assert.equal(source.includes(obsolete), false, `obsolete reference ${obsolete} in ${path}`);
    }
  }
});

test('skill frontmatter has only name and description and no TODOs', () => {
  const skill = readFileSync(join(repositoryDirectory, '.agents/skills/pr-review-cycle/SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  const keys = frontmatter.split('\n').map((line) => line.split(':', 1)[0]);
  assert.deepEqual(keys, ['name', 'description']);
  assert.doesNotMatch(skill, /TODO/u);
  assert.ok(skill.split('\n').length < 500);
});

test('custom agent required fields are declared at the TOML root', () => {
  const agentsDirectory = join(repositoryDirectory, '.codex', 'agents');
  for (const fileName of readdirSync(agentsDirectory).filter((name) => name.endsWith('.toml'))) {
    const source = readFileSync(join(agentsDirectory, fileName), 'utf8');
    const firstTable = source.search(/^\s*\[/mu);
    const rootSource = firstTable === -1 ? source : source.slice(0, firstTable);
    for (const field of ['name', 'description', 'developer_instructions']) {
      assert.match(
        rootSource,
        new RegExp(`^${field}\\s*=`, 'mu'),
        `${fileName} must declare ${field} before its first TOML table`,
      );
    }
  }
});
