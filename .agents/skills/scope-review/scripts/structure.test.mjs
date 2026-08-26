import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateScopeAssessmentApplicability,
  validateScopeAssessmentResult,
} from './validate-assessment.mjs';

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

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

function assessmentResult(verdict, overrides = {}) {
  return {
    schemaVersion: 1,
    binding: {
      phase: 'task',
      source: { type: 'github-issue', identity: 'furinvader/aerstello#54', digest: DIGEST_A },
      subject: { digest: DIGEST_B, sha: '1'.repeat(40) },
      planDigest: DIGEST_C,
      amendmentDigests: [],
      taskPacketDigest: DIGEST_A,
    },
    verdict,
    summary: 'Assess the exact mechanism against the accepted scope.',
    coverage: [],
    unnecessaryWork: [],
    smallerSufficientAlternative: null,
    scopeDelta: null,
    materialityTriggers: [],
    smallestExpansion: null,
    narrowAlternative: null,
    deferralConsequences: null,
    missingEvidence: [],
    humanDecision: false,
    ...overrides,
  };
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
  assert.match(skill, /\[operative minimality rules\]\(README\.md#operative-minimality-rules\)/u);
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
  for (const rule of [
    /Map every implementation mechanism to exact source authority/u,
    /Apply the removal counterfactual/u,
    /Prefer the smallest local, direct fix/u,
    /Do not accept infrastructure for hypothetical future consumers/u,
    /optional implementation guidance and indicative directory trees as\s+non-mandatory unless the authoritative source explicitly makes them a\s+closure criterion/u,
    /Do not assume broad source language makes an expansion safe/u,
    /Findings in newly introduced machinery do not by themselves justify\s+hardening/u,
    /quantitative size measurements\s+only as tripwires/u,
  ]) {
    assert.match(readme, rule);
  }
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
  assert.match(contract, /both the\s+authoritative source and accepted scope provide that exact authority/u);
  assert.match(contract, /must cite positive\s+authority through a source-required criterion, accepted criterion, or invariant/u);
  assert.match(contract, /same\s+authority field of that mechanism's `changeInventory\.mappings` row/u);
  assert.match(contract, /Positive authority in an inventory mapping establishes relevance and\s+traceability, not counterfactual necessity/u);
  assert.match(contract, /removing it preserves the authoritative outcome, accepted scope, and\s+minimal closure/u);
  assert.match(contract, /each `necessary-minor-expansion` row must share\s+at least one positive authority ID/u);
  assert.match(contract, /including invariant-only grounding/u);
  assert.match(contract, /every positive ID in `scopeDelta` must be\s+used by at least one `necessary-minor-expansion` row/u);
  assert.match(contract, /independent removable\s+nonmaterial mechanism as `speculative`/u);
  assert.match(contract, /mixed coverage does not change authority-before-materiality or\s+materiality-before-trimming precedence/u);
  assert.match(contract, /distinct non-native material\s+category may\s+instead identify a genuine additional `material-scope-change`/u);
  assert.match(contract, /none of those rows may be relabeled `material-scope-change`\s+using only those forced native categories/u);
  assert.match(contract, /byte-minimal speculative projection\s+for removable rejected or deferred nonmaterial rows, regardless of mapping\s+authority/u);
  assert.match(contract, /byte-minimal stable material anchor because that\s+selection leaves the projected grounded-minor set unchanged/u);
  assert.match(contract, /`source-draft` requires both downstream digests to be null/u);
  assert.match(contract, /cannot be classified `required` or\s+`implementation-choice`/u);
  assert.match(contract, /`unnecessaryWork` must name the\s+complete set of `speculative` coverage mechanisms exactly once/u);
  assert.match(contract, /`scopeDelta\.materialSurfaces` and the categories\s+in `materialityTriggers` must be the same order-insensitive set/u);
  assert.match(contract, /dependency, public surface, persistent surface, or\s+subsystem in the material inventory/u);
  assert.match(contract, /must not relabel that surface\s+`material-scope-change` while claiming its inventory field's native materiality\s+category/u);
  assert.match(contract, /Necessary-minor precedence does not hide independent removable work/u);
  assert.match(contract, /`unnecessaryWork` is the order-insensitive exact set of speculative mechanisms/u);
  assert.match(contract, /pure minor result has\s+neither speculative work nor a smaller alternative/u);
  assert.match(contract, /generic repository checker/u);
  assert.match(contract, /adjacent helper/u);
  assert.match(contract, /new subsystem/u);
  assert.match(contract, /insufficient-evidence/u);
});

test('minor verdict schema permits only exact speculative-removal correspondence', () => {
  const schema = JSON.parse(readFileSync(join(skillDirectory, 'schemas/scope-assessment.schema.json'), 'utf8'));
  const minorCoverage = schema.$defs.minorCoverage.allOf[1].properties.classification.enum;
  assert.deepEqual(minorCoverage, [
    'required',
    'implementation-choice',
    'speculative',
    'necessary-minor-expansion',
  ]);
  const minorVerdict = schema.oneOf.find(
    ({ properties }) => properties.verdict.const === 'minor-amendment-required',
  ).properties;
  assert.equal(minorVerdict.unnecessaryWork.maxItems, 256);
  assert.equal(minorVerdict.smallerSufficientAlternative.$ref, '#/$defs/nullableText');
  assert.equal(schema.$defs.minorScopeDelta.allOf[1].anyOf.length, 3);
  assert.equal(
    schema.$defs.minorScopeDelta.allOf[1].anyOf[2].properties.invariantIds.minItems,
    1,
  );
  const materialCoverage = schema.$defs.materialCoverage.allOf[1].properties.classification.enum;
  assert.equal(materialCoverage.includes('necessary-minor-expansion'), true);
});

test('materiality takes precedence over trimming at the executable result boundary', () => {
  const authorizedMechanism = 'public-scope-assessment-api';
  const authorizedCriterion = 'public-scope-api';
  const authorizedResult = assessmentResult('within-scope', {
    coverage: [{
      mechanism: authorizedMechanism,
      sourceCriterionIds: [authorizedCriterion],
      acceptedCriterionIds: [authorizedCriterion],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      classification: 'required',
      rationale: 'Both authorities explicitly require and authorize the public surface.',
    }],
  });
  const authorizedPacket = {
    schemaVersion: 1,
    binding: authorizedResult.binding,
    sourceScope: {
      objective: 'Provide the public scope-assessment API required by the issue.',
      requiredCriteria: [{
        id: authorizedCriterion,
        text: 'Expose a public scope-assessment API and schema.',
      }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{
        id: authorizedCriterion,
        text: 'Implement the explicitly required public scope-assessment API.',
      }],
      invariants: [],
      minimalClosure: 'The named public API and its schema satisfy the required surface.',
      authorizedShape: [authorizedMechanism],
      unauthorizedShape: [],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'Add the explicitly authorized public scope-assessment API.',
      paths: ['schemas/public-scope-assessment.json'],
      dependencies: [],
      publicSurfaces: [authorizedMechanism],
      persistentSurfaces: [],
      subsystems: [],
      mappings: [{
        mechanism: authorizedMechanism,
        sourceCriterionIds: [authorizedCriterion],
        acceptedCriterionIds: [authorizedCriterion],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        rationale: 'The exact public surface maps to both explicit authorities.',
      }],
    },
    tripwires: [],
  };
  assert.deepEqual(
    validateScopeAssessmentApplicability(authorizedPacket, authorizedResult),
    [],
  );

  const localTrim = assessmentResult('trim-required', {
    coverage: [{
      mechanism: 'local-unenforced-checker',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      nonGoalIds: ['no-generic-checker'],
      guidanceIds: [],
      classification: 'speculative',
      rationale: 'The local helper is removable and creates no material commitment.',
    }],
    unnecessaryWork: ['local-unenforced-checker'],
    smallerSufficientAlternative: 'Remove the checker and retain the sufficient direct fix.',
  });
  assert.deepEqual(validateScopeAssessmentResult(localTrim), []);

  const materialExpansion = assessmentResult('human-decision-required', {
    coverage: [{
      mechanism: 'repository-wide-enforcement',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      classification: 'material-scope-change',
      rationale: 'The mechanism commits the repository to new enforcement policy.',
    }],
    scopeDelta: {
      description: 'Add repository-wide policy enforcement.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces: ['repository-wide-enforcement'],
    },
    materialityTriggers: [{
      category: 'repository-wide-enforcement',
      evidence: 'The checker would enforce policy across the repository.',
    }],
    smallestExpansion: 'Add only the specifically approved enforcement surface.',
    narrowAlternative: 'Retain the direct local fix without repository enforcement.',
    deferralConsequences: 'The local defect is fixed while repository enforcement remains absent.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentResult(materialExpansion), []);

  const materialTrim = assessmentResult('trim-required', {
    coverage: materialExpansion.coverage,
    unnecessaryWork: ['repository-wide-enforcement'],
    smallerSufficientAlternative: 'Remove repository-wide enforcement.',
    materialityTriggers: materialExpansion.materialityTriggers,
  });
  assert.notDeepEqual(validateScopeAssessmentResult(materialTrim), []);
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
