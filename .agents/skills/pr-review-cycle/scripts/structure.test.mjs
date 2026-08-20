import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  'scripts/contracts/contracts.mjs',
  'scripts/contracts/contracts.test.mjs',
  'scripts/github/cli.mjs',
  'scripts/github/github.mjs',
  'scripts/github/github.test.mjs',
  'scripts/hooks/hooks.test.mjs',
  'scripts/hooks/pre-compact.mjs',
  'scripts/hooks/session-start.mjs',
  'scripts/hooks/subagent-stop.mjs',
  'scripts/paths.mjs',
  'scripts/state/cli.mjs',
  'scripts/state/fixtures/hold-state-lock.mjs',
  'scripts/state/state.mjs',
  'scripts/state/state.test.mjs',
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
