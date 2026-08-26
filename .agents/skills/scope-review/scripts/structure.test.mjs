import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const skillDirectory = dirname(scriptsDirectory);
const repositoryDirectory = resolve(skillDirectory, '../../..');

const EXPECTED_FILES = [
  'README.md',
  'SKILL.md',
  'agents/openai.yaml',
  'ownership.json',
  'references/assessment-contract.md',
  'schemas/scope-assessment.schema.json',
  'scripts/structure.test.mjs',
  'scripts/validate-assessment.mjs',
  'scripts/validate-assessment.test.mjs',
];

const EXPECTED_ADAPTERS = [
  {
    path: 'AGENTS.md',
    targets: ['README.md'],
  },
  {
    path: 'package.json',
    targets: ['scripts/structure.test.mjs', 'scripts/validate-assessment.test.mjs'],
  },
  {
    path: '.agents/skills/pr-review-cycle/scripts/structure.test.mjs',
    targets: [],
  },
];

function sorted(values) {
  return [...values].sort();
}

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
  return sorted(files);
}

function readRepositoryFile(path) {
  return readFileSync(join(repositoryDirectory, path), 'utf8');
}

test('ownership names the complete capability and every real consumer', () => {
  const ownership = JSON.parse(readFileSync(join(skillDirectory, 'ownership.json'), 'utf8'));
  assert.equal(ownership.schemaVersion, 1);
  assert.equal(ownership.skillRoot, '.agents/skills/scope-review');
  assert.deepEqual(ownership.canonicalFiles, EXPECTED_FILES);
  assert.deepEqual(filesBelow(skillDirectory), EXPECTED_FILES);
  assert.deepEqual(ownership.permittedExternalAdapters, EXPECTED_ADAPTERS);
  assert.deepEqual(ownership.consumedCapabilities, { jsonSchemaValidation: ['package.json'] });

  for (const path of ownership.canonicalFiles) {
    assert.equal(statSync(join(skillDirectory, path)).isFile(), true, `missing canonical file ${path}`);
  }
  for (const adapter of ownership.permittedExternalAdapters) {
    const source = readRepositoryFile(adapter.path);
    for (const target of adapter.targets) {
      assert.ok(ownership.canonicalFiles.includes(target), `unknown adapter target ${target}`);
      assert.ok(source.includes(`${ownership.skillRoot}/${target}`), `${adapter.path} does not target ${target}`);
    }
  }
  for (const path of ownership.consumedCapabilities.jsonSchemaValidation) {
    assert.equal(statSync(join(repositoryDirectory, path)).isFile(), true, `missing dependency ${path}`);
  }
  for (const path of ownership.obsoletePaths) {
    assert.equal(existsSync(join(repositoryDirectory, path)), false, `obsolete path exists: ${path}`);
  }
});

test('skill metadata is concise, automatic, and routes detail to the reference', () => {
  const skill = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: scope-review\ndescription: .+\n---\n/u);
  assert.match(skill, /references\/assessment-contract\.md/u);
  assert.match(skill, /read-only/u);
  assert.doesNotMatch(skill, /spawn|delegate to|GitHub mutation/u);

  const metadata = readFileSync(join(skillDirectory, 'agents/openai.yaml'), 'utf8');
  assert.match(metadata, /display_name: "Scope Review"/u);
  assert.match(metadata, /default_prompt: "Use \$scope-review/u);
  assert.doesNotMatch(metadata, /allow_implicit_invocation:\s*false/u);
});

test('documentation links resolve and defines invocation and authority boundaries', () => {
  const readme = readFileSync(join(skillDirectory, 'README.md'), 'utf8');
  const contract = readFileSync(join(skillDirectory, 'references/assessment-contract.md'), 'utf8');
  for (const target of [
    'references/assessment-contract.md',
    'schemas/scope-assessment.schema.json',
    'scripts/validate-assessment.mjs',
  ]) {
    assert.equal(statSync(join(skillDirectory, target)).isFile(), true, `broken documentation link ${target}`);
  }
  assert.match(readme, /subsystem, dependency, public or persistent surface/u);
  assert.match(contract, /authoritative source/u);
  assert.match(contract, /accepted plan/u);
  assert.match(contract, /append-only amendments/u);
  assert.match(contract, /implementation shape/u);
  assert.match(contract, /optional implementation guidance distinct from requirements/u);
  assert.match(contract, /source objective, required criteria, non-goals/u);
  assert.match(contract, /minimal sufficient closure/u);
  assert.match(contract, /authorized, unauthorized, and deferred implementation shape/u);
  assert.match(contract, /only `source-draft` uses null/u);
  assert.match(contract, /paths, dependencies, public surfaces, persistent surfaces, subsystems/u);
  assert.match(contract, /independent workstream, new criterion, non-goal reversal, sensitive policy/u);
  assert.match(contract, /without authorizing either/u);
  assert.match(contract, /generic repository checker/u);
  assert.match(contract, /adjacent helper/u);
  assert.match(contract, /new subsystem/u);
  assert.match(contract, /insufficient-evidence/u);
});

test('root guidance and npm wiring make focused scope review discoverable', () => {
  const agents = readRepositoryFile('AGENTS.md');
  assert.match(agents, /Scope assessment/u);
  assert.match(agents, /\.agents\/skills\/scope-review\/README\.md/u);
  assert.match(agents, /creating or materially editing an implementation issue or plan/u);
  assert.match(agents, /draft commitment boundary/u);
  assert.match(agents, /subsystem, dependency, public or persistent surface/u);

  const scripts = JSON.parse(readRepositoryFile('package.json')).scripts;
  assert.equal(
    scripts['test:scope-review'],
    'node --test .agents/skills/scope-review/scripts/validate-assessment.test.mjs .agents/skills/scope-review/scripts/structure.test.mjs',
  );
  assert.equal(
    scripts['test:tooling'],
    'npm run test:change-development && npm run test:pr-review && npm run test:specialists && npm run test:scope-review && node --test "scripts/**/*.test.mjs" && npm run test:e2e:structure',
  );
  assert.equal(scripts['check:workflow'], 'npm run test:tooling');
});

test('the capability exposes no mutable or delegated runtime surface', () => {
  assert.deepEqual(readdirSync(join(skillDirectory, 'schemas')), ['scope-assessment.schema.json']);
  for (const name of ['cli.mjs', 'hooks', 'state', 'worktree', 'workers', 'fixtures', 'paths.mjs']) {
    assert.equal(existsSync(join(skillDirectory, name)), false, `forbidden runtime surface ${name}`);
    assert.equal(existsSync(join(scriptsDirectory, name)), false, `forbidden script surface ${name}`);
  }
});
