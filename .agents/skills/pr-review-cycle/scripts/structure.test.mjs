import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { gitText } from '../../../../scripts/lib/git.mjs';
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

const EXPECTED_CANONICAL_FILES = [
  'README.md',
  'SKILL.md',
  'agents/openai.yaml',
  'ownership.json',
  'references/github-review.md',
  'references/orchestration.md',
  'references/state-and-contracts.md',
  'schemas/pr-review-state.schema.json',
  'schemas/review-fix-result.schema.json',
  'schemas/review-fix-task.schema.json',
  'scripts/contracts/contract-identities.mjs',
  'scripts/contracts/contracts.mjs',
  'scripts/contracts/contracts.test.mjs',
  'scripts/contracts/gates.mjs',
  'scripts/contracts/gates.test.mjs',
  'scripts/contracts/primitives.mjs',
  'scripts/contracts/primitives.test.mjs',
  'scripts/contracts/review-evidence.mjs',
  'scripts/contracts/review-evidence.test.mjs',
  'scripts/contracts/state-v1.mjs',
  'scripts/contracts/state-v1.test.mjs',
  'scripts/contracts/state-v3.mjs',
  'scripts/contracts/state-v3.test.mjs',
  'scripts/contracts/targeted-validation.mjs',
  'scripts/contracts/targeted-validation.test.mjs',
  'scripts/contracts/task-packet-union.mjs',
  'scripts/contracts/task-packet-union.test.mjs',
  'scripts/contracts/task-packet.mjs',
  'scripts/contracts/task-packet.test.mjs',
  'scripts/contracts/thread-proof.mjs',
  'scripts/contracts/thread-proof.test.mjs',
  'scripts/contracts/worker-result.mjs',
  'scripts/contracts/worker-result.test.mjs',
  'scripts/github/archive/adoption.test.mjs',
  'scripts/github/archive/archive-fixture-loader.mjs',
  'scripts/github/archive/fixture-integrity.test.mjs',
  'scripts/github/archive/fixtures/pr-35-2026-08-19T16-31-55-612Z/events.ndjson',
  'scripts/github/archive/fixtures/pr-35-2026-08-19T16-31-55-612Z/state.json',
  'scripts/github/archive/fixtures/pr-35-2026-08-20T09-39-32-610Z/events.ndjson',
  'scripts/github/archive/fixtures/pr-35-2026-08-20T09-39-32-610Z/state.json',
  'scripts/github/archive/store.test.mjs',
  'scripts/github/ci.test.mjs',
  'scripts/github/cli.mjs',
  'scripts/github/cli.test.mjs',
  'scripts/github/facade.test.mjs',
  'scripts/github/github.mjs',
  'scripts/github/live-evidence.test.mjs',
  'scripts/github/recovery.test.mjs',
  'scripts/github/request.test.mjs',
  'scripts/github/review-response.test.mjs',
  'scripts/github/test-support/workflow-harness.mjs',
  'scripts/github/threads.test.mjs',
  'scripts/github/workflow.test.mjs',
  'scripts/hooks/hooks.test.mjs',
  'scripts/hooks/pre-compact.mjs',
  'scripts/hooks/session-start.mjs',
  'scripts/hooks/subagent-stop.mjs',
  'scripts/paths.mjs',
  'scripts/state/archive.test.mjs',
  'scripts/state/cli.mjs',
  'scripts/state/cli.test.mjs',
  'scripts/state/facade.test.mjs',
  'scripts/state/fixtures/hold-state-lock.mjs',
  'scripts/state/locks-and-barriers.test.mjs',
  'scripts/state/review-transitions.test.mjs',
  'scripts/state/schema-migration-and-recovery.test.mjs',
  'scripts/state/specialist-evidence.test.mjs',
  'scripts/state/state-loading-and-persistence.test.mjs',
  'scripts/state/state.mjs',
  'scripts/state/task-completion.test.mjs',
  'scripts/state/task-packets.test.mjs',
  'scripts/state/test-support/state-harness.mjs',
  'scripts/state/validation-plans.test.mjs',
  'scripts/state/worker-evidence.test.mjs',
  'scripts/state/worker-git-authority.test.mjs',
  'scripts/structure.test.mjs',
  'scripts/worktree/cli.mjs',
  'scripts/worktree/worktree.mjs',
  'scripts/worktree/worktree.test.mjs',
];

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
  assert.deepEqual(sorted(ownership.canonicalFiles), EXPECTED_CANONICAL_FILES);
  assert.deepEqual(filesBelow(skillDirectory), EXPECTED_CANONICAL_FILES);
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
    assert.equal(statSync(join(skillDirectory, path)).isFile(), true, `missing canonical file ${path}`);
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

  const guideHeading = '# How the PR review cycle works';
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
  assert.match(readme, /issue\s+25/iu);
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
