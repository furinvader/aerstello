import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { gitText } from '../../../../scripts/lib/git.mjs';
import { repositoryRoot, skillDirectory } from './paths.mjs';

const repositoryDirectory = repositoryRoot(skillDirectory);

const EXPECTED_CANONICAL_FILES = [
  'README.md',
  'SKILL.md',
  'agents/openai.yaml',
  'ownership.json',
  'references/implementation.md',
  'references/planning.md',
  'references/state-and-recovery.md',
  'references/verification.md',
  'schemas/development-finding-disposition.schema.json',
  'schemas/development-specialist-result.schema.json',
  'schemas/development-state.schema.json',
  'schemas/development-validation-plan.schema.json',
  'schemas/development-validation-result.schema.json',
  'schemas/development-verification-result.schema.json',
  'schemas/development-verifier-context.schema.json',
  'schemas/implementation-plan.schema.json',
  'schemas/implementation-result.schema.json',
  'schemas/implementation-task.schema.json',
  'scripts/contracts/contracts.mjs',
  'scripts/contracts/contracts.test.mjs',
  'scripts/hooks/hooks.test.mjs',
  'scripts/hooks/pre-compact.mjs',
  'scripts/hooks/session-start.mjs',
  'scripts/hooks/subagent-stop.mjs',
  'scripts/implementation/contracts.mjs',
  'scripts/implementation/contracts.test.mjs',
  'scripts/implementation/execution.test.mjs',
  'scripts/paths.mjs',
  'scripts/source/checklists.mjs',
  'scripts/source/checklists.test.mjs',
  'scripts/source/fixtures/issue-22.md',
  'scripts/source/gh-adapter.mjs',
  'scripts/source/github.mjs',
  'scripts/source/github.test.mjs',
  'scripts/source/source.mjs',
  'scripts/source/source.test.mjs',
  'scripts/state/cli.mjs',
  'scripts/state/fixtures/hold-change-lock.mjs',
  'scripts/state/state.mjs',
  'scripts/state/state.test.mjs',
  'scripts/structure.test.mjs',
  'scripts/verification/contracts.mjs',
  'scripts/verification/contracts.test.mjs',
  'scripts/worktree/cli.mjs',
  'scripts/worktree/worktree.mjs',
  'scripts/worktree/worktree.test.mjs',
];

const DOCUMENTATION_FILES = [
  'README.md',
  'SKILL.md',
  'references/implementation.md',
  'references/planning.md',
  'references/state-and-recovery.md',
  'references/verification.md',
];

const EXPECTED_ADAPTERS = {
  '.codex/agents/development-integration-verifier.toml': [
    'README.md',
    'references/verification.md',
    'schemas/development-verification-result.schema.json',
    'schemas/development-verifier-context.schema.json',
  ],
  '.codex/agents/implementation-worker.toml': [
    'schemas/implementation-result.schema.json',
    'schemas/implementation-task.schema.json',
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
  'package-lock.json': ['scripts/contracts/contracts.mjs'],
  'package.json': [
    'scripts/contracts/contracts.mjs',
    'scripts/state/cli.mjs',
    'scripts/worktree/cli.mjs',
  ],
};

const EXPECTED_NEUTRAL_DEPENDENCIES = [
  'scripts/lib/cli.mjs',
  'scripts/lib/git.mjs',
  'tests/support/git-fixtures.mjs',
];

const EXPECTED_CONSUMED_CAPABILITIES = {
  specialists: [
    '.agents/skills/aerstello-specialists/SKILL.md',
    '.agents/skills/aerstello-specialists/references/reviewer-contracts.md',
    '.agents/skills/aerstello-specialists/registry.json',
    '.agents/skills/aerstello-specialists/scripts/validate-registry.mjs',
  ],
};

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

test('ownership inventory is exhaustive and external integration stays narrow', () => {
  const ownership = loadOwnership();
  assert.equal(ownership.schemaVersion, 1);
  assert.equal(ownership.skillRoot, '.agents/skills/change-development');
  assert.deepEqual(ownership.canonicalFiles, EXPECTED_CANONICAL_FILES);
  assert.deepEqual(filesBelow(skillDirectory), EXPECTED_CANONICAL_FILES);
  assert.deepEqual(
    Object.fromEntries(ownership.permittedExternalAdapters.map(({ path, targets }) => [path, targets])),
    EXPECTED_ADAPTERS,
  );
  assert.deepEqual(ownership.neutralSharedDependencies, EXPECTED_NEUTRAL_DEPENDENCIES);
  assert.deepEqual(ownership.consumedCapabilities, EXPECTED_CONSUMED_CAPABILITIES);

  for (const path of ownership.canonicalFiles) {
    assert.equal(statSync(join(skillDirectory, path)).isFile(), true, `missing ${path}`);
  }
  for (const adapter of ownership.permittedExternalAdapters) {
    const source = readRepositoryFile(adapter.path);
    for (const target of adapter.targets) {
      assert.ok(ownership.canonicalFiles.includes(target), `unknown target ${target}`);
      if (target !== 'scripts/contracts/contracts.mjs') {
        assert.ok(source.includes(`${ownership.skillRoot}/${target}`), `${adapter.path} misses ${target}`);
      }
    }
    for (const obsoletePath of ownership.obsoletePaths) {
      assert.equal(
        source.includes(obsoletePath),
        false,
        `${adapter.path} contains obsolete reference ${obsoletePath}`,
      );
    }
  }
  const packageManifest = JSON.parse(readRepositoryFile('package.json'));
  const packageLock = JSON.parse(readRepositoryFile('package-lock.json'));
  for (const [name, version] of [['ajv', '8.20.0'], ['ajv-formats', '3.0.1']]) {
    assert.equal(packageManifest.devDependencies[name], version, `${name} must be a direct exact dependency`);
    assert.equal(packageLock.packages[''].devDependencies[name], version, `${name} must be locked at the root`);
  }
  for (const path of ownership.neutralSharedDependencies) {
    assert.equal(statSync(join(repositoryDirectory, path)).isFile(), true, `missing neutral dependency ${path}`);
  }
  for (const path of ownership.obsoletePaths) {
    assert.equal(existsSync(join(repositoryDirectory, path)), false, `obsolete path exists: ${path}`);
  }
});

test('canonical Markdown links resolve and root discovery points to the operator guide', () => {
  for (const markdownFile of DOCUMENTATION_FILES) {
    const path = join(skillDirectory, markdownFile);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
      assert.equal(
        existsSync(resolve(dirname(path), match[1])),
        true,
        `${markdownFile} has a broken link to ${match[1]}`,
      );
    }
  }
  for (const path of ['README.md', 'AGENTS.md']) {
    assert.match(
      readRepositoryFile(path),
      /\.agents\/skills\/change-development\/README\.md/u,
      `${path} must link the canonical guide`,
    );
  }
});

test('operator docs expose exact source descriptors and durable state layout', () => {
  const guide = readFileSync(join(skillDirectory, 'README.md'), 'utf8');
  for (const fragment of [
    '--change-id issue-22', '--expected-revision', '--expected-pr-base-branch',
    '"type": "github-issue"', '"type": "direct-request"',
    '"type": "repository-plan"', '"type": "partial-implementation"',
  ]) assert.ok(guide.includes(fragment), `operator guide misses ${fragment}`);

  const stateReference = readFileSync(
    join(skillDirectory, 'references', 'state-and-recovery.md'),
    'utf8',
  );
  for (const fragment of [
    'locks/', '<change-id>.lock/', 'archive-lifecycle.json', 'archive-receipt.json[.sha256]',
    'worktree.json[.sha256]', 'source/', 'initial.json[.sha256]',
    'observations/<revision>.json[.sha256]', 'plan/', 'planning-evidence.json[.sha256]',
    'amendments/', 'decisions/<decision-id>.json[.sha256]',
    'transitions/', '.<eight-digit-revision>.<pid>.<uuid>.pending/',
    '<eight-digit-revision>/', 'intent.json[.sha256]',
    'receipt.json[.sha256]', 'complete',
  ]) assert.ok(stateReference.includes(fragment), `state reference misses ${fragment}`);
  assert.equal(stateReference.includes('archive-intent.json'), false);
  assert.match(stateReference, /`authoritativeEvidence`[^.]*exact path, label, canonical digest, and complete value/u);
  assert.match(stateReference, /`events\.jsonl` is canonically reconstructed and atomically rewritten/u);
  assert.match(stateReference, /pending transition directory is transient staging and does not establish an intent/u);
  assert.match(stateReference, /reconstruct the exact deterministic transition receipt/u);
  assert.match(stateReference, /missing or tampered committed intent, its SHA-256 receipt, or its authoritative evidence bundle blocks recovery/u);
  assert.equal(/\n├── lifecycle\.lock\//u.test(stateReference), false);
  assert.equal(/\n\s*├── change\.lock\//u.test(stateReference), false);
  assert.match(stateReference, /PreCompact[^.]*local filesystem and Git observation/u);
  assert.match(stateReference, /no source refresh or network work/u);
  assert.match(stateReference, /all linked worktrees share the common-directory state/u);

  const planningReference = readFileSync(
    join(skillDirectory, 'references', 'planning.md'),
    'utf8',
  );
  assert.match(planningReference, /Checklist mappings bind each source identity to its `criterionIds` and `taskIds`/u);
  assert.match(planningReference, /Decisions, scenarios, and the product-scenario disposition remain separate plan records/u);
});

test('schema identifiers and the operator guide each have one canonical copy', () => {
  const files = repositoryFiles();
  const schemaPaths = [
    '.agents/skills/change-development/schemas/development-finding-disposition.schema.json',
    '.agents/skills/change-development/schemas/development-specialist-result.schema.json',
    '.agents/skills/change-development/schemas/development-state.schema.json',
    '.agents/skills/change-development/schemas/development-validation-plan.schema.json',
    '.agents/skills/change-development/schemas/development-validation-result.schema.json',
    '.agents/skills/change-development/schemas/development-verification-result.schema.json',
    '.agents/skills/change-development/schemas/development-verifier-context.schema.json',
    '.agents/skills/change-development/schemas/implementation-plan.schema.json',
    '.agents/skills/change-development/schemas/implementation-result.schema.json',
    '.agents/skills/change-development/schemas/implementation-task.schema.json',
  ];
  const ids = schemaPaths.map((path) => JSON.parse(readRepositoryFile(path)).$id);
  assert.equal(ids.every((id) => typeof id === 'string' && id.length > 0), true);
  assert.equal(new Set(ids).size, ids.length, 'change-development schema IDs must be unique');
  for (const [index, id] of ids.entries()) {
    const matches = files.filter((path) => {
      if (!path.endsWith('.schema.json')) return false;
      try {
        return JSON.parse(readRepositoryFile(path)).$id === id;
      } catch {
        return false;
      }
    });
    assert.deepEqual(matches, [schemaPaths[index]]);
  }

  const heading = '# How change development works';
  const copies = files.filter((path) => path.endsWith('.md')
    && readRepositoryFile(path).split(/\r?\n/u).includes(heading));
  assert.deepEqual(copies, ['.agents/skills/change-development/README.md']);
});

test('skill and generated interface metadata satisfy the public contract', () => {
  const skill = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
  assert.ok(frontmatter, 'SKILL.md must have YAML frontmatter');
  assert.deepEqual(
    frontmatter.split('\n').map((line) => line.match(/^([a-z_-]+):/u)?.[1]),
    ['name', 'description'],
  );
  assert.match(frontmatter, /^name: change-development$/mu);
  assert.equal(skill.includes('TODO'), false);

  const metadata = readFileSync(join(skillDirectory, 'agents', 'openai.yaml'), 'utf8');
  assert.equal(metadata, `interface:\n  display_name: "Change Development"\n  short_description: "Plan and implement durable Aerstello changes"\n  default_prompt: "Use $change-development to plan, implement, or resume this Aerstello change with durable provenance, immutable task packets, isolated workers, and exact integration."\n`);
});

test('one thin implementation worker is the only ordinary development writer', () => {
  const agentDirectory = join(repositoryDirectory, '.codex', 'agents');
  const developmentWriters = readdirSync(agentDirectory)
    .filter((name) => name.endsWith('.toml'))
    .filter((name) => readFileSync(join(agentDirectory, name), 'utf8')
      .includes('.agents/skills/change-development/schemas/implementation-task.schema.json'));
  assert.deepEqual(developmentWriters, ['implementation-worker.toml']);

  const worker = readFileSync(join(agentDirectory, developmentWriters[0]), 'utf8');
  assert.match(worker, /^name = "implementation_worker"$/mu);
  assert.match(worker, /^model_reasoning_effort = "medium"$/mu);
  assert.match(worker, /^\[agents\]\nenabled = false$/mu);
  assert.match(worker, /Read root AGENTS\.md and exactly the Aerstello specialist profile/u);
  assert.match(worker, /Do not delegate/u);
  assert.match(worker, /Do not integrate commits/u);
  assert.match(worker, /edit central change-development state/u);
  assert.match(worker, /push/u);
  assert.match(worker, /GitHub/u);
});

test('development final verifier is exact-HEAD read-only and has no hook authority', () => {
  const verifier = readRepositoryFile('.codex/agents/development-integration-verifier.toml');
  assert.match(verifier, /^name = "development_integration_verifier"$/mu);
  assert.match(verifier, /^model_reasoning_effort = "high"$/mu);
  assert.match(verifier, /^sandbox_mode = "read-only"$/mu);
  assert.match(verifier, /^\[agents\]\nenabled = false$/mu);
  for (const target of [
    '.agents/skills/change-development/README.md',
    '.agents/skills/change-development/references/verification.md',
    '.agents/skills/change-development/schemas/development-verifier-context.schema.json',
    '.agents/skills/change-development/schemas/development-verification-result.schema.json',
    '.agents/skills/aerstello-specialists/references/reviewer-contracts.md',
  ]) assert.ok(verifier.includes(target), `development verifier misses ${target}`);
  for (const fragment of [
    'generated, ready development-verifier context', 'exact clean checkout HEAD',
    'original accepted plan and effective plan', 'integration receipt order',
    'Remain read-only', 'Never edit files or change-development state',
    'invoke a specialist, or delegate', 'Return only one raw JSON object',
  ]) assert.ok(verifier.includes(fragment), `development verifier misses ${fragment}`);

  const config = readRepositoryFile('.codex/config.toml');
  assert.match(config, /^\[agents\.development_integration_verifier\][\s\S]*?^config_file = "agents\/development-integration-verifier\.toml"$/mu);
  assert.equal(readRepositoryFile('.codex/hooks.json').includes('development_integration_verifier'), false);
});

test('change hooks share matcher groups with unchanged first PR handlers', () => {
  const hooks = JSON.parse(readRepositoryFile('.codex/hooks.json'));
  assert.match(hooks.description, /change-development/u);
  assert.match(hooks.description, /PR-review/u);
  assert.equal(hooks.hooks.SessionStart.length, 1);
  assert.equal(hooks.hooks.SessionStart[0].matcher, '^(startup|resume|compact)$');
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks.map(({ command }) => command), [
    'node "$(git rev-parse --show-toplevel)/.agents/skills/pr-review-cycle/scripts/hooks/session-start.mjs"',
    'node "$(git rev-parse --show-toplevel)/.agents/skills/change-development/scripts/hooks/session-start.mjs"',
  ]);
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks.map(({ additionalContextLimit }) => additionalContextLimit), [2500, 2500]);
  assert.deepEqual(hooks.hooks.SessionStart[0].hooks.map(({ timeout }) => timeout), [10, 10]);

  assert.equal(hooks.hooks.PreCompact.length, 1);
  assert.equal(hooks.hooks.PreCompact[0].matcher, '^(manual|auto)$');
  assert.deepEqual(hooks.hooks.PreCompact[0].hooks.map(({ command }) => command), [
    'node "$(git rev-parse --show-toplevel)/.agents/skills/pr-review-cycle/scripts/hooks/pre-compact.mjs"',
    'node "$(git rev-parse --show-toplevel)/.agents/skills/change-development/scripts/hooks/pre-compact.mjs"',
  ]);
  assert.equal(hooks.hooks.PreCompact[0].hooks.every((hook) => !('additionalContextLimit' in hook)), true);
  assert.deepEqual(hooks.hooks.SubagentStop.map(({ matcher }) => matcher), [
    '^review_fix_worker$',
    '^implementation_worker$',
  ]);
  assert.equal(
    hooks.hooks.SubagentStop[1].hooks[0].command,
    'node "$(git rev-parse --show-toplevel)/.agents/skills/change-development/scripts/hooks/subagent-stop.mjs"',
  );
});

test('root npm façades target the canonical CLI and run bounded commands from a nested workspace', () => {
  const scripts = JSON.parse(readRepositoryFile('package.json')).scripts;
  assert.equal(scripts['change:state'], 'node .agents/skills/change-development/scripts/state/cli.mjs');
  assert.equal(scripts['change:worktree'], 'node .agents/skills/change-development/scripts/worktree/cli.mjs');
  assert.equal(scripts['change:status'], 'node .agents/skills/change-development/scripts/state/cli.mjs status --human');
  assert.equal(scripts['test:change-development'], 'node --test ".agents/skills/change-development/scripts/**/*.test.mjs"');
  assert.match(scripts['test:tooling'], /npm run test:change-development/u);

  const stateResult = spawnSync(
    'npm',
    ['--prefix', repositoryDirectory, 'run', 'change:state', '--', '--help'],
    { cwd: join(repositoryDirectory, 'apps', 'api'), encoding: 'utf8' },
  );
  assert.equal(stateResult.error, undefined);
  assert.equal(stateResult.status, 0, stateResult.stderr);
  assert.match(stateResult.stdout, /change-development\/scripts\/state\/cli\.mjs/u);

  const worktreeResult = spawnSync(
    'npm',
    ['--prefix', repositoryDirectory, 'run', 'change:worktree', '--', '--help'],
    { cwd: join(repositoryDirectory, 'apps', 'api'), encoding: 'utf8' },
  );
  assert.equal(worktreeResult.error, undefined);
  assert.equal(worktreeResult.status, 0, worktreeResult.stderr);
  assert.match(worktreeResult.stdout, /change-development\/scripts\/worktree\/cli\.mjs/u);

  const statusResult = spawnSync(
    'npm',
    [
      '--prefix', repositoryDirectory, 'run', 'change:status', '--',
      '--change-id', 'structure-test-no-state',
    ],
    { cwd: join(repositoryDirectory, 'apps', 'api'), encoding: 'utf8' },
  );
  assert.equal(statusResult.error, undefined);
  assert.equal(statusResult.status, 0, statusResult.stderr);
  assert.match(statusResult.stdout, /(?:No active change-development state\.|Change: )/u);
  assert.ok(statusResult.stdout.length < 2500, 'human status façade must remain bounded');
});
