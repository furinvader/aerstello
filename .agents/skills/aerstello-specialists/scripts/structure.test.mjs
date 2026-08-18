import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  profilesDirectory,
  registryPath,
  registrySchemaPath,
  repositoryRoot,
  scriptsDirectory,
  skillDirectory,
} from './paths.mjs';

const EXPECTED_FILES = [
  'README.md', 'SKILL.md', 'agents/openai.yaml', 'ownership.json',
  'profiles/api.md', 'profiles/behavior-tests.md', 'profiles/contracts.md',
  'profiles/data-integrity.md', 'profiles/ops-workflow.md', 'profiles/web.md',
  'references/reviewer-contracts.md', 'references/routing.md', 'registry.json',
  'schemas/registry.schema.json', 'scripts/paths.mjs', 'scripts/structure.test.mjs',
  'scripts/validate-registry.mjs', 'scripts/validate-registry.test.mjs',
];

const EXPECTED_EXTERNAL_ADAPTERS = [
  { path: '.codex/agents/behavior-mapper.toml', targets: ['references/routing.md', 'references/reviewer-contracts.md'] },
  { path: '.codex/agents/security-reviewer.toml', targets: ['references/reviewer-contracts.md'] },
  { path: '.codex/agents/offline-realtime-reviewer.toml', targets: ['references/reviewer-contracts.md'] },
  { path: '.codex/config.toml', targets: [] },
  { path: 'AGENTS.md', targets: ['README.md'] },
];

const EXPECTED_WORKFLOW_CONSUMERS = [
  { path: '.codex/agents/development-integration-verifier.toml', targets: ['references/reviewer-contracts.md'] },
  { path: '.codex/agents/implementation-worker.toml', targets: ['registry.json'] },
  { path: '.codex/agents/integration-verifier.toml', targets: ['references/reviewer-contracts.md'] },
  { path: '.codex/agents/review-fix-worker.toml', targets: ['registry.json'] },
  { path: '.agents/skills/pr-review-cycle/ownership.json', targets: [] },
  {
    path: '.agents/skills/change-development/ownership.json',
    targets: ['SKILL.md', 'references/reviewer-contracts.md', 'registry.json', 'scripts/validate-registry.mjs'],
  },
];

function filesBelow(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(relative(directory, path).split(sep).join('/'));
    }
  }
  return files.sort();
}

test('path helpers anchor canonical files to the skill and support repository subdirectories', () => {
  assert.equal(scriptsDirectory, dirname(fileURLToPath(import.meta.url)));
  assert.equal(skillDirectory, dirname(scriptsDirectory));
  assert.equal(profilesDirectory, join(skillDirectory, 'profiles'));
  assert.equal(registryPath, join(skillDirectory, 'registry.json'));
  assert.equal(registrySchemaPath, join(skillDirectory, 'schemas', 'registry.schema.json'));
  const root = repositoryRoot();
  assert.equal(repositoryRoot(join(root, 'apps', 'web')), root);
});

test('ownership manifest covers every canonical file and keeps duplicate locations absent', () => {
  const ownership = JSON.parse(readFileSync(join(skillDirectory, 'ownership.json'), 'utf8'));
  assert.equal(ownership.schemaVersion, 1);
  assert.equal(ownership.skillRoot, '.agents/skills/aerstello-specialists');
  assert.deepEqual(ownership.canonicalFiles, EXPECTED_FILES);
  assert.deepEqual(filesBelow(skillDirectory), EXPECTED_FILES);
  assert.deepEqual(ownership.permittedExternalAdapters, EXPECTED_EXTERNAL_ADAPTERS);
  assert.deepEqual(ownership.permittedWorkflowConsumers, EXPECTED_WORKFLOW_CONSUMERS);
  for (const obsoletePath of ownership.obsoletePaths) {
    assert.equal(existsSync(join(repositoryRoot(), obsoletePath)), false, `obsolete specialist path exists: ${obsoletePath}`);
  }
  for (const adapter of [
    ...ownership.permittedExternalAdapters, ...ownership.permittedWorkflowConsumers,
  ]) {
    const adapterPath = join(repositoryRoot(), adapter.path);
    assert.equal(existsSync(adapterPath), true, `missing external adapter ${adapter.path}`);
    const adapterSource = readFileSync(adapterPath, 'utf8');
    for (const target of adapter.targets) {
      assert.ok(ownership.canonicalFiles.includes(target), `unknown adapter target ${target}`);
      assert.ok(
        adapterSource.includes(`${ownership.skillRoot}/${target}`),
        `${adapter.path} does not target ${target}`,
      );
    }
  }
});

test('profile and skill Markdown links resolve from canonical files', () => {
  const markdownFiles = EXPECTED_FILES.filter((path) => path.endsWith('.md'));
  for (const markdownFile of markdownFiles) {
    const path = join(skillDirectory, markdownFile);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/gu)) {
      const target = resolve(dirname(path), match[1]);
      assert.equal(existsSync(target), true, `${markdownFile} has a broken link to ${match[1]}`);
    }
  }
});

test('every profile links repository rules, architecture, features, and concrete subsystem sources', () => {
  for (const profile of readdirSync(profilesDirectory).filter((name) => name.endsWith('.md'))) {
    const source = readFileSync(join(profilesDirectory, profile), 'utf8');
    assert.match(source, /\(\.\.\/\.\.\/\.\.\/\.\.\/AGENTS\.md\)/u, `${profile} must link AGENTS.md`);
    assert.match(source, /\(\.\.\/\.\.\/\.\.\/\.\.\/docs\/architecture\.md\)/u, `${profile} must link architecture`);
    assert.match(source, /\(\.\.\/\.\.\/\.\.\/\.\.\/specs\/features\)/u, `${profile} must link feature scenarios`);
    assert.match(
      source,
      /\(\.\.\/\.\.\/\.\.\/\.\.\/(?:apps|packages|tests|scripts|\.codex)\//u,
      `${profile} must link a concrete subsystem source`,
    );
  }
});

function assertReadOnlyAgent(path, expectedName) {
  const source = readFileSync(join(repositoryRoot(), path), 'utf8');
  assert.match(source, new RegExp(`^name = "${expectedName}"$`, 'mu'));
  assert.match(source, /^sandbox_mode = "read-only"$/mu);
  assert.match(source, /^\[agents\]\nenabled = false$/mu);
  assert.match(source, /Remain read-only\./u);
  assert.match(source, /Never[^.]*\b(?:write|post) to GitHub\b/u);
  assert.match(source, /Never[^.]*\bdelegate\b/u);
}

test('the three reusable specialist adapters remain read-only and non-delegating', () => {
  assertReadOnlyAgent('.codex/agents/behavior-mapper.toml', 'behavior_mapper');
  assertReadOnlyAgent('.codex/agents/security-reviewer.toml', 'security_reviewer');
  assertReadOnlyAgent('.codex/agents/offline-realtime-reviewer.toml', 'offline_realtime_reviewer');
  assert.deepEqual(
    EXPECTED_EXTERNAL_ADAPTERS.filter(({ path }) => path.startsWith('.codex/agents/'))
      .map(({ path }) => path),
    [
      '.codex/agents/behavior-mapper.toml',
      '.codex/agents/security-reviewer.toml',
      '.codex/agents/offline-realtime-reviewer.toml',
    ],
  );
});

test('the PR integration verifier remains a read-only workflow consumer', () => {
  assertReadOnlyAgent('.codex/agents/integration-verifier.toml', 'integration_verifier');
  assert.ok(EXPECTED_WORKFLOW_CONSUMERS.some(({ path }) =>
    path === '.codex/agents/integration-verifier.toml'));
});

test('the development integration verifier is a distinct read-only workflow consumer', () => {
  assertReadOnlyAgent('.codex/agents/development-integration-verifier.toml', 'development_integration_verifier');
  assert.ok(EXPECTED_WORKFLOW_CONSUMERS.some(({ path }) =>
    path === '.codex/agents/development-integration-verifier.toml'));
  assert.equal(readFileSync(registryPath, 'utf8').includes('development_integration_verifier'), false);
});

test('the implementation worker consumes one profile as guidance without lifecycle authority', () => {
  const source = readFileSync(join(repositoryRoot(), '.codex/agents/implementation-worker.toml'), 'utf8');
  assert.match(source, /^name = "implementation_worker"$/mu);
  assert.match(source, /^model_reasoning_effort = "medium"$/mu);
  assert.match(source, /^\[agents\]\nenabled = false$/mu);
  assert.match(source, /exactly the Aerstello specialist profile named by the packet/u);
  assert.match(source, /guidance only/u);
  assert.match(source, /Do not delegate/u);
  assert.match(source, /Do not integrate commits/u);
  assert.match(source, /edit central change-development state/u);
  assert.match(source, /push/u);
  assert.match(source, /GitHub/u);
});

test('hook role boundary and four-thread cap remain authoritative', () => {
  const hooks = JSON.parse(readFileSync(join(repositoryRoot(), '.codex', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.SubagentStop.map(({ matcher }) => matcher), [
    '^review_fix_worker$', '^implementation_worker$',
  ]);
  const config = readFileSync(join(repositoryRoot(), '.codex', 'config.toml'), 'utf8');
  assert.match(config, /^max_concurrent_threads_per_session = 4$/mu);
  const registrations = [
    ['review_fix_worker', 'agents/review-fix-worker.toml'],
    ['integration_verifier', 'agents/integration-verifier.toml'],
    ['development_integration_verifier', 'agents/development-integration-verifier.toml'],
    ['behavior_mapper', 'agents/behavior-mapper.toml'],
    ['security_reviewer', 'agents/security-reviewer.toml'],
    ['offline_realtime_reviewer', 'agents/offline-realtime-reviewer.toml'],
    ['implementation_worker', 'agents/implementation-worker.toml'],
  ];
  for (const [role, configFile] of registrations) {
    assert.match(
      config,
      new RegExp(`^\\[agents\\.${role}\\][\\s\\S]*?^config_file = "${configFile}"$`, 'mu'),
      `missing project registration for ${role}`,
    );
  }
});

test('agent metadata exposes only the required generated interface fields', () => {
  const metadata = readFileSync(join(skillDirectory, 'agents', 'openai.yaml'), 'utf8');
  assert.match(metadata, /display_name: "Aerstello Specialists"/u);
  assert.match(metadata, /short_description: "[^"]{25,64}"/u);
  assert.match(metadata, /default_prompt: "Use \$aerstello-specialists/u);
  assert.equal(metadata.includes('TODO'), false);
});
