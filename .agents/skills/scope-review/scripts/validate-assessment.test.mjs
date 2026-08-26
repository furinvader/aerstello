import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ASSESSMENT_PACKET_LIMIT_BYTES,
  SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES,
  validateAssessmentPacket,
  validateScopeAssessmentApplicability,
  validateScopeAssessmentResult,
} from './validate-assessment.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const SHA = '1'.repeat(40);
const assessmentSchema = JSON.parse(readFileSync(
  new URL('../schemas/scope-assessment.schema.json', import.meta.url),
  'utf8',
));

function binding(overrides = {}) {
  return {
    phase: 'task',
    source: { type: 'github-issue', identity: 'furinvader/aerstello#54', digest: `sha256:${A}` },
    subject: { digest: `sha256:${B}`, sha: SHA },
    planDigest: `sha256:${C}`,
    amendmentDigests: [`sha256:${D}`],
    taskPacketDigest: `sha256:${A}`,
    ...overrides,
  };
}

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    binding: binding(),
    sourceScope: {
      objective: 'Correct the bounded defect without generic runtime machinery.',
      requiredCriteria: [{ id: 'direct-fix', text: 'Correct the bounded defect.' }],
      nonGoals: [{ id: 'no-generic-runtime', text: 'Do not add generic runtime machinery.' }],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'direct-fix', text: 'Apply the direct bounded correction.' }],
      invariants: [{ id: 'exact-subject', text: 'Bind conclusions to the exact subject.' }],
      minimalClosure: 'The direct fix and focused proof are sufficient.',
      authorizedShape: ['direct-local-fix'],
      unauthorizedShape: ['generic-repository-checker'],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'Apply one direct local fix with no new surface.',
      paths: ['src/direct-fix.ts'],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: ['direct-local-fix'],
      mappings: [{
        mechanism: 'direct-local-fix',
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        rationale: 'The local change directly implements the accepted criterion.',
      }],
    },
    tripwires: [],
    ...overrides,
  };
}

function result(verdict, overrides = {}) {
  return {
    schemaVersion: 1,
    binding: binding(),
    verdict,
    summary: 'The exact subject was assessed against accepted scope.',
    coverage: [{
      mechanism: 'direct-local-fix',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      classification: 'required',
      rationale: 'This is the smallest direct implementation.',
    }],
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

function nonHumanAssessments(coverage, challengedMechanism) {
  const classify = (classification) => coverage.map((entry) => (
    entry.mechanism === challengedMechanism ? { ...entry, classification } : entry
  ));
  return [
    result('within-scope', { coverage }),
    result('trim-required', {
      coverage: classify('speculative'),
      unnecessaryWork: [challengedMechanism],
      smallerSufficientAlternative: 'Keep only the authorized material shape.',
    }),
    result('minor-amendment-required', {
      coverage: classify('necessary-minor-expansion'),
      scopeDelta: {
        description: `Add ${challengedMechanism} as a minor expansion.`,
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        materialSurfaces: [],
      },
    }),
  ];
}

function compactPacket(mechanisms, bindingOverrides = {}) {
  const mappings = mechanisms.map((mechanism) => ({
    mechanism,
    sourceCriterionIds: ['x'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'x',
  }));
  return packet({
    binding: binding(bindingOverrides),
    sourceScope: {
      objective: 'x',
      requiredCriteria: [{ id: 'x', text: 'x' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: [],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'x',
      paths: [],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: [],
      mappings,
    },
  });
}

test('direct local fix is a valid within-scope assessment', () => {
  const input = packet();
  const assessment = result('within-scope');
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentResult(assessment), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('authorized and unauthorized accepted shapes must be disjoint', () => {
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      unauthorizedShape: ['direct-local-fix'],
    },
  });
  assert.deepEqual(
    validateAssessmentPacket(input),
    ['$ acceptedScope.authorizedShape overlaps acceptedScope.unauthorizedShape at "direct-local-fix"'],
  );
});

test('authorized and deferred accepted shapes must be disjoint', () => {
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      deferredShape: ['direct-local-fix'],
    },
  });
  assert.deepEqual(
    validateAssessmentPacket(input),
    ['$ acceptedScope.authorizedShape overlaps acceptedScope.deferredShape at "direct-local-fix"'],
  );
});

test('unauthorized and deferred accepted shapes must be disjoint', () => {
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      deferredShape: ['generic-repository-checker'],
    },
  });
  assert.deepEqual(
    validateAssessmentPacket(input),
    ['$ acceptedScope.unauthorizedShape overlaps acceptedScope.deferredShape at "generic-repository-checker"'],
  );
});

test('applicability fails closed for contradictory accepted-shape authority', () => {
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      unauthorizedShape: ['direct-local-fix'],
    },
  });
  assert.deepEqual(
    validateScopeAssessmentApplicability(input, result('within-scope')),
    ['packet: $ acceptedScope.authorizedShape overlaps acceptedScope.unauthorizedShape at "direct-local-fix"'],
  );
});

test('unmapped material inventory fails closed for every compact inventory field', () => {
  const materialInventoryFields = [
    'dependencies',
    'publicSurfaces',
    'persistentSurfaces',
    'subsystems',
  ];
  for (const field of materialInventoryFields) {
    const surface = `unmapped-${field}`;
    const input = packet({
      changeInventory: {
        ...packet().changeInventory,
        [field]: [...packet().changeInventory[field], surface],
      },
    });
    const expected = `$ changeInventory.${field} entry ${JSON.stringify(surface)} requires exactly one changeInventory.mappings row`;
    assert.deepEqual(validateAssessmentPacket(input), [expected], field);
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, result('within-scope')),
      [`packet: ${expected}`],
      field,
    );
  }
});

test('material inventory requires exactly one mapping row', () => {
  const duplicate = packet({
    changeInventory: {
      ...packet().changeInventory,
      mappings: [
        ...packet().changeInventory.mappings,
        { ...packet().changeInventory.mappings[0] },
      ],
    },
  });
  assert.deepEqual(
    validateAssessmentPacket(duplicate),
    ['$ changeInventory.mappings contains duplicate mechanism direct-local-fix'],
  );
});

test('source-only material authority cannot produce a non-human verdict', () => {
  const surface = 'source-only-public-api';
  const surfaceMapping = {
    mechanism: surface,
    sourceCriterionIds: ['direct-fix'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'The source names the surface but accepted scope does not authorize it.',
  };
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      publicSurfaces: [surface],
      mappings: [...packet().changeInventory.mappings, surfaceMapping],
    },
  });
  const surfaceCoverage = {
    ...surfaceMapping,
    classification: 'required',
    rationale: 'The surface is source-required but is not accepted-scope-authorized.',
  };
  const cases = nonHumanAssessments(
    [...result('within-scope').coverage, surfaceCoverage],
    surface,
  );

  for (const assessment of cases) {
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, assessment),
      [
        `$ changeInventory.publicSurfaces material surface ${JSON.stringify(surface)} lacks accepted-scope authorization and requires human-decision-required material-scope-change coverage with category public-surface`,
      ],
      assessment.verdict,
    );
  }
});

test('accepted-only material authority lacks authoritative-source support', () => {
  const surface = 'accepted-only-public-api';
  const surfaceMapping = {
    mechanism: surface,
    sourceCriterionIds: [],
    acceptedCriterionIds: ['direct-fix'],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'Accepted scope names the surface but the authoritative source does not.',
  };
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [...packet().acceptedScope.authorizedShape, surface],
    },
    changeInventory: {
      ...packet().changeInventory,
      publicSurfaces: [surface],
      mappings: [...packet().changeInventory.mappings, surfaceMapping],
    },
  });
  const assessment = result('within-scope', {
    coverage: [
      ...result('within-scope').coverage,
      {
        ...surfaceMapping,
        classification: 'implementation-choice',
        rationale: 'Accepted scope authorizes the surface without source authority.',
      },
    ],
  });
  for (const candidate of nonHumanAssessments(assessment.coverage, surface)) {
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, candidate),
      [
        `$ changeInventory.publicSurfaces material surface ${JSON.stringify(surface)} lacks explicit authoritative-source support and requires human-decision-required material-scope-change coverage with category public-surface`,
      ],
      candidate.verdict,
    );
  }
});

test('exact source and accepted-scope authority allow a material surface', () => {
  const surface = 'authorized-public-api';
  const surfaceMapping = {
    mechanism: surface,
    sourceCriterionIds: ['direct-fix'],
    acceptedCriterionIds: ['direct-fix'],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'Both authorities explicitly support the exact public surface.',
  };
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [...packet().acceptedScope.authorizedShape, surface],
    },
    changeInventory: {
      ...packet().changeInventory,
      publicSurfaces: [surface],
      mappings: [...packet().changeInventory.mappings, surfaceMapping],
    },
  });
  const assessment = result('within-scope', {
    coverage: [
      ...result('within-scope').coverage,
      { ...surfaceMapping, classification: 'required' },
    ],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('non-overlapping accepted shapes preserve material inventory authority', () => {
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: ['direct-local-fix'],
      unauthorizedShape: ['generic-repository-checker'],
      deferredShape: ['future-repository-policy'],
    },
  });
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, result('within-scope')), []);
});

test('affirmative coverage requires positive authority rather than non-goals or guidance', () => {
  const authorityCases = [
    { sourceCriterionIds: ['direct-fix'], acceptedCriterionIds: [], invariantIds: [] },
    { sourceCriterionIds: [], acceptedCriterionIds: ['direct-fix'], invariantIds: [] },
    { sourceCriterionIds: [], acceptedCriterionIds: [], invariantIds: ['exact-subject'] },
  ];
  for (const classification of ['required', 'implementation-choice']) {
    for (const authority of authorityCases) {
      const assessment = result('within-scope', {
        coverage: [{
          ...result('within-scope').coverage[0],
          ...authority,
          classification,
        }],
      });
      assert.deepEqual(validateScopeAssessmentResult(assessment), []);
    }

    for (const unsupported of [
      { nonGoalIds: ['no-generic-runtime'], guidanceIds: [] },
      { nonGoalIds: [], guidanceIds: ['optional-helper'] },
    ]) {
      const assessment = result('within-scope', {
        coverage: [{
          ...result('within-scope').coverage[0],
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
          ...unsupported,
          classification,
        }],
      });
      assert.deepEqual(
        validateScopeAssessmentResult(assessment),
        [`$ coverage[0] ${classification} classification lacks positive source, accepted-criterion, or invariant authority`],
      );
    }
  }
});

test('accepted unauthorized and deferred shapes reject affirmative coverage only', () => {
  for (const [shapeField, classification] of [
    ['unauthorizedShape', 'required'],
    ['deferredShape', 'implementation-choice'],
  ]) {
    const mechanism = `${shapeField}-mechanism`;
    const mapping = {
      ...packet().changeInventory.mappings[0],
      mechanism,
    };
    const input = packet({
      acceptedScope: {
        ...packet().acceptedScope,
        [shapeField]: [mechanism],
      },
      changeInventory: {
        ...packet().changeInventory,
        subsystems: [],
        mappings: [mapping],
      },
    });
    const affirmative = result('within-scope', {
      coverage: [{ ...result('within-scope').coverage[0], mechanism, classification }],
    });
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, affirmative),
      [`$ coverage mechanism ${JSON.stringify(mechanism)} is ${classification} despite acceptedScope.${shapeField}`],
    );

    const trimmed = result('trim-required', {
      coverage: [{
        ...result('within-scope').coverage[0],
        mechanism,
        classification: 'speculative',
      }],
      unnecessaryWork: [mechanism],
      smallerSufficientAlternative: 'Omit the explicitly unaccepted mechanism.',
    });
    assert.deepEqual(validateScopeAssessmentApplicability(input, trimmed), []);

    const minor = result('minor-amendment-required', {
      coverage: [{
        ...result('within-scope').coverage[0],
        mechanism,
        classification: 'necessary-minor-expansion',
      }],
      scopeDelta: {
        description: 'Admit the mechanism through a bounded minor amendment.',
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        materialSurfaces: [],
      },
    });
    assert.deepEqual(validateScopeAssessmentApplicability(input, minor), []);
  }
});

test('trim unnecessary work exactly matches speculative mechanisms without order significance', () => {
  const speculativeCoverage = ['speculative-a', 'speculative-b'].map((mechanism) => ({
    ...result('within-scope').coverage[0],
    mechanism,
    classification: 'speculative',
  }));
  const valid = result('trim-required', {
    coverage: [result('within-scope').coverage[0], ...speculativeCoverage],
    unnecessaryWork: ['speculative-b', 'speculative-a'],
    smallerSufficientAlternative: 'Retain only the direct local fix.',
  });
  assert.deepEqual(validateScopeAssessmentResult(valid), []);

  for (const unnecessaryWork of [
    ['speculative-a'],
    ['speculative-a', 'speculative-b', 'unrelated'],
    ['speculative-a', 'speculative-a'],
  ]) {
    assert.match(
      validateScopeAssessmentResult({ ...valid, unnecessaryWork }).join('\n'),
      /unnecessaryWork must exactly match speculative coverage mechanisms/u,
    );
  }
});

test('human material surfaces and trigger categories correspond exactly and uniquely', () => {
  const materialSurfaces = ['new-subsystem', 'public-surface'];
  const valid = result('human-decision-required', {
    coverage: [{ ...result('within-scope').coverage[0], classification: 'material-scope-change' }],
    scopeDelta: {
      description: 'Add one subsystem and public surface.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces,
    },
    materialityTriggers: [...materialSurfaces].reverse().map((category) => ({
      category,
      evidence: `Exact evidence for ${category}.`,
    })),
    smallestExpansion: 'Add only the named surfaces.',
    narrowAlternative: 'Retain the local implementation.',
    deferralConsequences: 'The material surfaces remain absent.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentResult(valid), []);

  for (const materialityTriggers of [
    valid.materialityTriggers.slice(0, 1),
    [...valid.materialityTriggers, { category: 'new-dependency', evidence: 'Unrelated dependency.' }],
    [
      { category: 'new-subsystem', evidence: 'First subsystem trigger.' },
      { category: 'new-subsystem', evidence: 'Duplicate subsystem trigger.' },
    ],
  ]) {
    assert.match(
      validateScopeAssessmentResult({ ...valid, materialityTriggers }).join('\n'),
      /materialityTriggers categories must exactly match scopeDelta\.materialSurfaces/u,
    );
  }
});

test('unauthorized material inventory uses field-specific human-decision categories', () => {
  const inventoryCategories = new Map([
    ['dependencies', 'new-dependency'],
    ['publicSurfaces', 'public-surface'],
    ['persistentSurfaces', 'persistent-surface'],
    ['subsystems', 'new-subsystem'],
  ]);
  for (const [field, category] of inventoryCategories) {
    const surface = `material-${field}`;
    const mapping = {
      mechanism: surface,
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      rationale: 'The source supports the mechanism but accepted shape does not authorize it.',
    };
    const input = packet({
      changeInventory: {
        ...packet().changeInventory,
        [field]: [surface],
        mappings: [...packet().changeInventory.mappings, mapping],
      },
    });
    const assessment = result('human-decision-required', {
      coverage: [
        result('within-scope').coverage[0],
        { ...mapping, classification: 'material-scope-change' },
      ],
      scopeDelta: {
        description: `Add the unauthorized ${field} surface.`,
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        materialSurfaces: [category],
      },
      materialityTriggers: [{ category, evidence: `The inventory adds ${surface}.` }],
      smallestExpansion: `Add only ${surface}.`,
      narrowAlternative: 'Retain the direct local fix.',
      deferralConsequences: 'The unauthorized material surface remains absent.',
      humanDecision: true,
    });
    assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), [], field);

    const missingCategory = {
      ...assessment,
      scopeDelta: { ...assessment.scopeDelta, materialSurfaces: ['policy-change'] },
      materialityTriggers: [{ category: 'policy-change', evidence: 'A different category.' }],
    };
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, missingCategory),
      [`$ changeInventory.${field} material surface ${JSON.stringify(surface)} lacks accepted-scope authorization and requires human-decision-required material-scope-change coverage with category ${category}`],
    );
  }
});

test('unnecessary generic checker requires trimming to the direct fix', () => {
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      paths: ['src/direct-fix.ts', 'scripts/generic-checker.mjs'],
      mappings: [
        packet().changeInventory.mappings[0],
        {
          mechanism: 'generic-repository-checker',
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: ['no-generic-runtime'],
          guidanceIds: [],
          rationale: 'The checker is proposed around a bounded fix but is not requested.',
        },
      ],
    },
  });
  const assessment = result('trim-required', {
    coverage: [
      result('within-scope').coverage[0],
      {
        mechanism: 'generic-repository-checker',
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        nonGoalIds: ['no-generic-runtime'],
        guidanceIds: [],
        classification: 'speculative',
        rationale: 'No accepted criterion requires generic enforcement.',
      },
    ],
    unnecessaryWork: ['generic-repository-checker'],
    smallerSufficientAlternative: 'Keep only the direct local fix and its focused test.',
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('unsupported mapping rows remain representable as exact speculative trimming', () => {
  const unsupported = {
    mechanism: 'unsupported-local-helper',
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'No supplied authority supports this local helper.',
  };
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      mappings: [...packet().changeInventory.mappings, unsupported],
    },
  });
  const assessment = result('trim-required', {
    coverage: [
      result('within-scope').coverage[0],
      { ...unsupported, classification: 'speculative' },
    ],
    unnecessaryWork: [unsupported.mechanism],
    smallerSufficientAlternative: 'Keep only the mapped direct local fix.',
  });

  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('necessary adjacent helper and focused test require a minor amendment', () => {
  const input = packet({
    sourceScope: {
      ...packet().sourceScope,
      implementationGuidance: [{ id: 'adjacent-helper', text: 'Prefer a small adjacent helper when needed.' }],
    },
    changeInventory: {
      ...packet().changeInventory,
      paths: ['src/direct-fix.ts', 'src/direct-helper.ts', 'src/direct-helper.test.ts'],
      mappings: [
        packet().changeInventory.mappings[0],
        {
          mechanism: 'adjacent-helper-and-test',
          sourceCriterionIds: ['direct-fix'],
          acceptedCriterionIds: ['direct-fix'],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: ['adjacent-helper'],
          rationale: 'The adjacent mechanism is necessary to express and prove the existing criterion.',
        },
      ],
    },
  });
  const assessment = result('minor-amendment-required', {
    coverage: [
      result('within-scope').coverage[0],
      {
        mechanism: 'adjacent-helper-and-test',
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: ['adjacent-helper'],
        classification: 'necessary-minor-expansion',
        rationale: 'It adds no material surface and serves an existing criterion.',
      },
    ],
    scopeDelta: {
      description: 'Add the adjacent helper and focused test needed by the direct fix.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces: [],
    },
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('material subsystem expansion requires an unauthorizing human decision', () => {
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      paths: ['src/direct-fix.ts', '.agents/skills/policy/**'],
      subsystems: ['direct-local-fix', 'new-policy-subsystem'],
      mappings: [
        packet().changeInventory.mappings[0],
        {
          mechanism: 'new-policy-subsystem',
          sourceCriterionIds: ['direct-fix'],
          acceptedCriterionIds: ['direct-fix'],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          rationale: 'The proposal turns a direct fix into repository-wide policy enforcement.',
        },
      ],
    },
  });
  const assessment = result('human-decision-required', {
    coverage: [
      result('within-scope').coverage[0],
      {
        mechanism: 'new-policy-subsystem',
        sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        classification: 'material-scope-change',
        rationale: 'This creates a new subsystem and repository-wide enforcement.',
      },
    ],
    scopeDelta: {
      description: 'Create a reusable policy subsystem for all repository changes.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces: ['new-subsystem', 'repository-wide-enforcement'],
    },
    materialityTriggers: [
      { category: 'new-subsystem', evidence: 'A separately owned policy capability is proposed.' },
      { category: 'repository-wide-enforcement', evidence: 'The checker would gate all repository changes.' },
    ],
    smallestExpansion: 'Add only the reusable policy evaluator and its direct contract.',
    narrowAlternative: 'Retain the direct local fix without generic enforcement.',
    deferralConsequences: 'The direct defect can be fixed now; generic enforcement remains absent.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('missing exact evidence fails closed with insufficient-evidence', () => {
  const draftBinding = binding({ phase: 'plan', subject: { digest: `sha256:${B}`, sha: null } });
  const input = packet({ binding: draftBinding });
  const assessment = result('insufficient-evidence', {
    binding: draftBinding,
    coverage: [{
      ...result('within-scope').coverage[0],
      classification: 'insufficient-evidence',
      rationale: 'No exact implementation SHA is available for the requested code comparison.',
    }],
    missingEvidence: ['Exact implementation subject SHA'],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('source and plan drafts use null identities instead of invented artifact digests', () => {
  const sourceBinding = binding({
    phase: 'source-draft', subject: { digest: `sha256:${B}`, sha: null },
    planDigest: null, amendmentDigests: [], taskPacketDigest: null,
  });
  const sourceMapping = {
    ...packet().changeInventory.mappings[0],
    acceptedCriterionIds: [],
  };
  const sourceInput = packet({
    binding: sourceBinding,
    acceptedScope: null,
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [],
      mappings: [sourceMapping],
    },
  });
  const sourceAssessment = result('within-scope', {
    binding: sourceBinding,
    coverage: [{
      ...result('within-scope').coverage[0],
      acceptedCriterionIds: [],
    }],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(sourceInput, sourceAssessment), []);

  const planBinding = binding({
    phase: 'plan', subject: { digest: `sha256:${B}`, sha: null },
    planDigest: null, amendmentDigests: [], taskPacketDigest: null,
  });
  assert.deepEqual(
    validateScopeAssessmentApplicability(
      packet({ binding: planBinding }),
      result('within-scope', { binding: planBinding }),
    ),
    [],
  );
});

test('code phases require insufficient evidence when plan or task artifacts are absent', () => {
  const artifactCases = [
    {
      label: 'plan',
      overrides: { planDigest: null, amendmentDigests: [] },
    },
    {
      label: 'task packet',
      overrides: { taskPacketDigest: null },
    },
    {
      label: 'plan and task packet',
      overrides: { planDigest: null, amendmentDigests: [], taskPacketDigest: null },
    },
  ];

  for (const phase of ['task', 'integrated-head', 'review-finding']) {
    for (const { label, overrides } of artifactCases) {
      const exactBinding = binding({ phase, ...overrides });
      const input = packet({ binding: exactBinding });
      const affirmative = result('within-scope', { binding: exactBinding });

      assert.deepEqual(validateAssessmentPacket(input), [], `${phase}: missing ${label} packet`);
      assert.deepEqual(validateScopeAssessmentResult(affirmative), [], `${phase}: missing ${label} result`);
      assert.deepEqual(
        validateScopeAssessmentApplicability(input, affirmative),
        ['$ code-phase assessment with an absent plan or task-packet identity requires insufficient-evidence'],
        `${phase}: missing ${label} affirmative verdict`,
      );

      const insufficient = result('insufficient-evidence', {
        binding: exactBinding,
        coverage: [{
          ...result('within-scope').coverage[0],
          classification: 'insufficient-evidence',
          rationale: `The exact ${label} identity is absent.`,
        }],
        missingEvidence: [`Exact ${label} identity`],
      });
      assert.deepEqual(
        validateScopeAssessmentApplicability(input, insufficient),
        [],
        `${phase}: missing ${label} insufficient-evidence verdict`,
      );
    }
  }
});

test('missing code artifacts preserve insufficient-evidence material representability', () => {
  const artifactCases = [
    { label: 'plan', overrides: { planDigest: null, amendmentDigests: [] } },
    { label: 'task packet', overrides: { taskPacketDigest: null } },
    {
      label: 'plan and task packet',
      overrides: { planDigest: null, amendmentDigests: [], taskPacketDigest: null },
    },
  ];
  const unsupportedSurface = 'unmapped-material-subsystem';
  const unsupportedMapping = {
    mechanism: unsupportedSurface,
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'The exact authority for this material subsystem is unavailable.',
  };

  for (const phase of ['task', 'integrated-head', 'review-finding']) {
    for (const { label, overrides } of artifactCases) {
      const exactBinding = binding({ phase, ...overrides });
      const input = packet({
        binding: exactBinding,
        changeInventory: {
          ...packet().changeInventory,
          subsystems: [...packet().changeInventory.subsystems, unsupportedSurface],
          mappings: [...packet().changeInventory.mappings, unsupportedMapping],
        },
      });
      const insufficient = result('insufficient-evidence', {
        binding: exactBinding,
        coverage: [result('within-scope').coverage[0], unsupportedMapping].map((entry) => ({
          ...entry,
          classification: 'insufficient-evidence',
          rationale: `The exact ${label} identity is absent.`,
        })),
        missingEvidence: [`Exact ${label} identity`],
      });
      assert.deepEqual(
        validateScopeAssessmentApplicability(input, insufficient),
        [],
        `${phase}: missing ${label} insufficient-evidence material verdict`,
      );

      const affirmative = result('within-scope', {
        binding: exactBinding,
        coverage: [
          result('within-scope').coverage[0],
          {
            ...unsupportedMapping,
            sourceCriterionIds: ['direct-fix'],
            classification: 'required',
          },
        ],
      });
      const affirmativeErrors = validateScopeAssessmentApplicability(input, affirmative);
      assert.ok(
        affirmativeErrors.includes(
          '$ code-phase assessment with an absent plan or task-packet identity requires insufficient-evidence',
        ),
        `${phase}: missing ${label} affirmative identity rejection`,
      );
      assert.ok(
        affirmativeErrors.some((error) => error.includes(unsupportedSurface)),
        `${phase}: missing ${label} affirmative material rejection`,
      );
    }
  }
});

test('arbitrary missing evidence takes precedence over affirmative material enforcement', () => {
  const unsupportedSurface = 'unsupported-material-subsystem';
  const unsupportedMapping = {
    mechanism: unsupportedSurface,
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'No supplied authority supports this material subsystem.',
  };
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [...packet().changeInventory.subsystems, unsupportedSurface],
      mappings: [...packet().changeInventory.mappings, unsupportedMapping],
    },
  });
  const insufficient = result('insufficient-evidence', {
    coverage: [result('within-scope').coverage[0], unsupportedMapping].map((entry) => ({
      ...entry,
      classification: 'insufficient-evidence',
      rationale: 'Other exact evidence is absent.',
    })),
    missingEvidence: ['Other exact evidence'],
  });
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, insufficient), []);

  const affirmative = result('within-scope', {
    coverage: [
      result('within-scope').coverage[0],
      {
        ...unsupportedMapping,
        sourceCriterionIds: ['direct-fix'],
        classification: 'required',
      },
    ],
  });
  assert.deepEqual(
    validateScopeAssessmentApplicability(input, affirmative),
    [
      `$ changeInventory.subsystems material surface ${JSON.stringify(unsupportedSurface)} lacks explicit authoritative-source support and accepted-scope authorization and requires human-decision-required material-scope-change coverage with category new-subsystem`,
    ],
  );
});

test('trim-required represents 129 exact speculative mechanisms within its byte envelope', () => {
  assert.equal(assessmentSchema.properties.unnecessaryWork.maxItems, 256);
  assert.equal(assessmentSchema.properties.coverage.maxItems, 256);
  assert.equal(assessmentSchema.$defs.changeInventory.properties.mappings.maxItems, 256);

  const mechanisms = Array.from({ length: 129 }, (_, index) => `m${index}`);
  const mappings = mechanisms.map((mechanism) => ({
    mechanism,
    sourceCriterionIds: ['x'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'x',
  }));
  const input = packet({
    sourceScope: {
      objective: 'x',
      requiredCriteria: [{ id: 'x', text: 'x' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: [],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'x',
      paths: [],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: [],
      mappings,
    },
  });
  const coverage = mechanisms.map((mechanism) => ({
    mechanism,
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    classification: 'speculative',
    rationale: 'x',
  }));
  const assessment = result('trim-required', {
    coverage,
    unnecessaryWork: [...mechanisms].reverse(),
    smallerSufficientAlternative: 'x',
  });

  assert.ok(
    Buffer.byteLength(JSON.stringify(assessment)) < SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES,
  );
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentResult(assessment), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
});

test('packet validation rejects the official 200-mechanism result counterexample', () => {
  const input = compactPacket(Array.from({ length: 200 }, (_, index) => `m${index}`));
  const errors = validateAssessmentPacket(input);

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.match(errors.join('\n'), /cannot represent a schema-minimal .* result within 32768 bytes/u);
});

test('representability covers schema-minimal forms of every verdict', () => {
  const mechanisms = Array.from({ length: 256 }, (_, index) => `mechanism-${index}`);
  const errors = validateAssessmentPacket(compactPacket(mechanisms)).join('\n');

  for (const verdict of [
    'within-scope',
    'trim-required',
    'minor-amendment-required',
    'human-decision-required',
    'insufficient-evidence',
  ]) {
    assert.match(errors, new RegExp(`schema-minimal ${verdict} result`, 'u'), verdict);
  }
});

test('representability accepts exactly 32768 bytes and rejects the next byte', () => {
  let boundary = null;
  for (let count = 129; count <= 200 && boundary === null; count += 1) {
    const mechanisms = Array.from({ length: count }, (_, index) => `m${index}`);
    const shortest = compactPacket(mechanisms, {
      source: { ...binding().source, identity: 'i' },
    });
    const longest = compactPacket(mechanisms, {
      source: { ...binding().source, identity: 'i'.repeat(512) },
    });
    if (validateAssessmentPacket(shortest).length > 0) continue;
    if (!validateAssessmentPacket(longest).some((error) => error.includes('cannot represent'))) continue;

    for (let identityBytes = 2; identityBytes <= 512; identityBytes += 1) {
      const over = compactPacket(mechanisms, {
        source: { ...binding().source, identity: 'i'.repeat(identityBytes) },
      });
      const overErrors = validateAssessmentPacket(over);
      if (!overErrors.some((error) => error.includes('cannot represent'))) continue;
      boundary = {
        at: compactPacket(mechanisms, {
          source: { ...binding().source, identity: 'i'.repeat(identityBytes - 1) },
        }),
        overErrors,
      };
      break;
    }
  }

  assert.ok(boundary, 'a one-byte binding boundary must be discoverable');
  assert.deepEqual(validateAssessmentPacket(boundary.at), []);
  assert.match(boundary.overErrors.join('\n'), /requires 32769 bytes/u);
});

test('escaped mechanism identities and maximal binding metadata use serialized bytes', () => {
  const mechanisms = Array.from(
    { length: 129 },
    (_, index) => `m${index}-${'"\\'.repeat(12)}`,
  );
  const input = compactPacket(mechanisms, {
    source: { ...binding().source, identity: 'i'.repeat(512) },
    amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
  });
  const errors = validateAssessmentPacket(input);

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.match(errors.join('\n'), /cannot represent a schema-minimal .* result within 32768 bytes/u);
});

test('all named materiality triggers are valid evidence categories', () => {
  const categories = [
    'new-subsystem', 'new-dependency', 'public-surface', 'persistent-surface',
    'cross-capability-work', 'policy-change', 'repository-wide-enforcement',
    'independent-workstream', 'new-criterion', 'non-goal-reversal', 'sensitive-policy',
    'replaces-accepted-approach', 'repeated-expansion',
  ];
  const assessment = result('human-decision-required', {
    coverage: [{ ...result('within-scope').coverage[0], classification: 'material-scope-change' }],
    scopeDelta: {
      description: 'The proposed shape crosses every named material boundary.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces: categories,
    },
    materialityTriggers: categories.map((category) => ({
      category,
      evidence: `Exact evidence for ${category}.`,
    })),
    smallestExpansion: 'Admit only the specifically approved material surfaces.',
    narrowAlternative: 'Keep the direct local fix.',
    deferralConsequences: 'The broader capability remains unavailable.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentResult(assessment), []);
});

test('every verdict rejects contradictory result shapes', () => {
  const contradictions = [
    result('within-scope', { unnecessaryWork: ['extra checker'] }),
    result('trim-required', { smallerSufficientAlternative: 'Use the direct fix.' }),
    result('minor-amendment-required', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'necessary-minor-expansion' }],
      scopeDelta: {
        description: 'Add a repository policy.', sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'], invariantIds: [],
        materialSurfaces: ['policy-change'],
      },
    }),
    result('human-decision-required', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'material-scope-change' }],
      scopeDelta: {
        description: 'Expand scope.', sourceCriterionIds: [], acceptedCriterionIds: [],
        invariantIds: [], materialSurfaces: [],
      },
      smallestExpansion: 'Smallest expansion.', narrowAlternative: 'Narrow alternative.',
      deferralConsequences: 'Consequences.', humanDecision: true,
    }),
    result('insufficient-evidence', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'insufficient-evidence' }],
    }),
  ];
  for (const assessment of contradictions) {
    assert.notDeepEqual(validateScopeAssessmentResult(assessment), [], assessment.verdict);
  }
});

test('verdicts reject classifications that contradict their conclusions', () => {
  const mixed = [
    result('trim-required', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'material-scope-change' }],
      unnecessaryWork: ['direct-local-fix'],
      smallerSufficientAlternative: 'Use a smaller fix.',
    }),
    result('minor-amendment-required', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'speculative' }],
      scopeDelta: {
        description: 'Add one helper.', sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'], invariantIds: [],
        materialSurfaces: [],
      },
    }),
    result('human-decision-required', {
      coverage: [{ ...result('within-scope').coverage[0], classification: 'insufficient-evidence' }],
      scopeDelta: {
        description: 'Expand scope.', sourceCriterionIds: ['direct-fix'],
        acceptedCriterionIds: ['direct-fix'], invariantIds: [],
        materialSurfaces: ['new-subsystem'],
      },
      materialityTriggers: [{ category: 'new-subsystem', evidence: 'A new subsystem is proposed.' }],
      smallestExpansion: 'Add one subsystem.', narrowAlternative: 'Keep the local fix.',
      deferralConsequences: 'The subsystem remains unavailable.', humanDecision: true,
    }),
    result('insufficient-evidence', {
      coverage: [
        { ...result('within-scope').coverage[0], classification: 'insufficient-evidence' },
        { ...result('within-scope').coverage[0], mechanism: 'affirmative-claim' },
      ],
      missingEvidence: ['Exact evidence is absent.'],
    }),
  ];
  for (const assessment of mixed) {
    assert.notDeepEqual(validateScopeAssessmentResult(assessment), [], assessment.verdict);
  }
});

test('quantitative tripwires are verdict-neutral observations', () => {
  const input = packet({
    tripwires: [{ id: 'large-diff', category: 'line-count', evidence: 'The exact subject changes 900 lines.' }],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, result('within-scope')), []);
});

test('closed contracts and phase-specific identities reject invalid input', () => {
  assert.match(validateAssessmentPacket({ ...packet(), extra: true }).join('\n'), /additionalProperties/u);
  assert.match(validateScopeAssessmentResult({ ...result('within-scope'), extra: true }).join('\n'), /additionalProperties/u);
  const missingTaskSha = packet({ binding: binding({ subject: { digest: `sha256:${B}`, sha: null } }) });
  assert.notDeepEqual(validateAssessmentPacket(missingTaskSha), []);
  const missingInventoryPaths = packet({
    changeInventory: { ...packet().changeInventory },
  });
  delete missingInventoryPaths.changeInventory.paths;
  assert.notDeepEqual(validateAssessmentPacket(missingInventoryPaths), []);
  const missingSourceObjective = packet({ sourceScope: { ...packet().sourceScope } });
  delete missingSourceObjective.sourceScope.objective;
  assert.notDeepEqual(validateAssessmentPacket(missingSourceObjective), []);
  const sourceDraftWithAcceptedScope = packet({
    binding: binding({ phase: 'source-draft', subject: { digest: `sha256:${B}`, sha: null } }),
  });
  assert.notDeepEqual(validateAssessmentPacket(sourceDraftWithAcceptedScope), []);
  const amendmentWithoutPlan = packet({
    binding: binding({
      phase: 'plan',
      subject: { digest: `sha256:${B}`, sha: null },
      planDigest: null,
      amendmentDigests: [`sha256:${D}`],
    }),
  });
  assert.notDeepEqual(validateAssessmentPacket(amendmentWithoutPlan), []);
});

test('pure validators return errors instead of throwing for malformed nested JSON', () => {
  const malformedPacket = packet({
    sourceScope: {
      objective: 'Malformed nested packet.',
      requiredCriteria: [null],
      nonGoals: [17],
      implementationGuidance: [null],
    },
    acceptedScope: {
      ...packet().acceptedScope,
      criteria: [null],
      invariants: [false],
    },
    changeInventory: { ...packet().changeInventory, mappings: [null] },
  });
  const malformedResult = result('within-scope', { coverage: [null] });
  const malformedTrimResult = result('trim-required', {
    coverage: [null],
    unnecessaryWork: ['unknown-work'],
    smallerSufficientAlternative: 'Use valid evidence instead.',
  });
  const malformedHumanResult = result('human-decision-required', {
    coverage: [null],
    scopeDelta: null,
    materialityTriggers: [null],
    smallestExpansion: 'Use valid evidence instead.',
    narrowAlternative: 'Retain the direct fix.',
    deferralConsequences: 'No material expansion is accepted.',
    humanDecision: true,
  });
  assert.doesNotThrow(() => validateAssessmentPacket(malformedPacket));
  assert.doesNotThrow(() => validateScopeAssessmentResult(malformedResult));
  assert.doesNotThrow(() => validateScopeAssessmentResult(malformedTrimResult));
  assert.doesNotThrow(() => validateScopeAssessmentResult(malformedHumanResult));
  assert.doesNotThrow(() => validateScopeAssessmentApplicability(malformedPacket, malformedResult));
  assert.notDeepEqual(validateAssessmentPacket(malformedPacket), []);
  assert.notDeepEqual(validateScopeAssessmentResult(malformedResult), []);
});

test('result correspondence is total for missing, null, and wrong containers', () => {
  const trimBase = result('trim-required', {
    coverage: [{
      ...result('within-scope').coverage[0],
      classification: 'speculative',
    }],
    unnecessaryWork: ['direct-local-fix'],
    smallerSufficientAlternative: 'Retain only supported work.',
  });
  const humanBase = result('human-decision-required', {
    coverage: [{ ...result('within-scope').coverage[0], classification: 'material-scope-change' }],
    scopeDelta: {
      description: 'Add one material surface.',
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      materialSurfaces: ['new-subsystem'],
    },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'A subsystem is proposed.' }],
    smallestExpansion: 'Add only the named subsystem.',
    narrowAlternative: 'Retain the direct fix.',
    deferralConsequences: 'The subsystem remains absent.',
    humanDecision: true,
  });
  const malformed = [];
  for (const value of [null, undefined, 'not-an-array', { wrong: 'container' }]) {
    for (const field of ['coverage', 'unnecessaryWork']) {
      const candidate = { ...trimBase, [field]: value };
      if (value === undefined) delete candidate[field];
      malformed.push(candidate);
    }
    for (const field of ['coverage', 'materialityTriggers', 'scopeDelta']) {
      const candidate = { ...humanBase, [field]: value };
      if (value === undefined) delete candidate[field];
      malformed.push(candidate);
    }
  }
  for (const candidate of malformed) {
    assert.doesNotThrow(() => validateScopeAssessmentResult(candidate));
    assert.notDeepEqual(validateScopeAssessmentResult(candidate), []);
  }
});

test('every echoed identity mismatch makes a valid assessment stale without mutation', () => {
  const originalPacket = packet();
  const originalResult = result('within-scope');
  const packetSnapshot = JSON.stringify(originalPacket);
  const resultSnapshot = JSON.stringify(originalResult);
  const staleBindings = [
    binding({ phase: 'integrated-head' }),
    binding({ source: { ...binding().source, type: 'direct-request' } }),
    binding({ source: { ...binding().source, identity: 'request:54' } }),
    binding({ source: { ...binding().source, digest: `sha256:${B}` } }),
    binding({ subject: { ...binding().subject, digest: `sha256:${C}` } }),
    binding({ subject: { ...binding().subject, sha: '2'.repeat(40) } }),
    binding({ planDigest: `sha256:${D}` }),
    binding({ amendmentDigests: [`sha256:${A}`] }),
    binding({ taskPacketDigest: `sha256:${B}` }),
  ];
  for (const staleBinding of staleBindings) {
    assert.match(
      validateScopeAssessmentApplicability(originalPacket, { ...originalResult, binding: staleBinding }).join('\n'),
      /does not exactly match/u,
    );
  }
  assert.equal(JSON.stringify(originalPacket), packetSnapshot);
  assert.equal(JSON.stringify(originalResult), resultSnapshot);
});

test('binding object insertion order does not make exact values stale', () => {
  const reordered = {
    taskPacketDigest: `sha256:${A}`,
    amendmentDigests: [`sha256:${D}`],
    planDigest: `sha256:${C}`,
    subject: { sha: SHA, digest: `sha256:${B}` },
    source: { digest: `sha256:${A}`, identity: 'furinvader/aerstello#54', type: 'github-issue' },
    phase: 'task',
  };
  assert.deepEqual(
    validateScopeAssessmentApplicability(packet(), result('within-scope', { binding: reordered })),
    [],
  );
});

test('packet and result context envelopes are enforced independently', () => {
  const criteria = Array.from({ length: 20 }, (_, index) => ({
    id: `criterion-${index}`,
    text: `${index}-${'x'.repeat(3997)}`,
  }));
  const oversizedPacket = packet({
    acceptedScope: { ...packet().acceptedScope, criteria },
  });
  const packetErrors = validateAssessmentPacket(oversizedPacket);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedPacket)) > ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.match(packetErrors.join('\n'), /assessment packet exceeds/u);

  const coverage = Array.from({ length: 10 }, (_, index) => ({
    mechanism: `mechanism-${index}`,
    sourceCriterionIds: ['direct-fix'],
    acceptedCriterionIds: ['direct-fix'],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    classification: 'required',
    rationale: `${index}-${'y'.repeat(3997)}`,
  }));
  const oversizedResult = result('within-scope', { coverage });
  const resultErrors = validateScopeAssessmentResult(oversizedResult);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedResult)) > SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES);
  assert.match(resultErrors.join('\n'), /scope assessment result exceeds/u);
});
