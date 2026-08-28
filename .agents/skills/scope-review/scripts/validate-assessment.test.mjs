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

function mixedMinorPacket(speculativeCount, identityBytes = 1) {
  const necessary = 'necessary-minor-work';
  const speculative = Array.from(
    { length: speculativeCount },
    (_, index) => `speculative-${String(index).padStart(3, '0')}`,
  );
  return packet({
    binding: binding({
      source: { ...binding().source, identity: 'i'.repeat(identityBytes) },
      amendmentDigests: [],
    }),
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
      unauthorizedShape: [necessary],
      deferredShape: [],
    },
    changeInventory: {
      summary: 'x',
      paths: [],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: [],
      mappings: [
        {
          mechanism: necessary,
          sourceCriterionIds: ['x'],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          rationale: 'x',
        },
        ...speculative.map((mechanism) => ({
          mechanism,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          rationale: 'x',
        })),
      ],
    },
  });
}

function mixedMinorResult(input) {
  const [necessary, ...speculative] = input.changeInventory.mappings;
  return result('minor-amendment-required', {
    binding: input.binding,
    summary: 'x',
    coverage: [
      {
        ...necessary,
        sourceCriterionIds: ['x'],
        classification: 'necessary-minor-expansion',
        rationale: 'x',
      },
      ...speculative.map((mapping) => ({
        ...mapping,
        classification: 'speculative',
        rationale: 'x',
      })),
    ],
    unnecessaryWork: speculative.map(({ mechanism }) => mechanism),
    smallerSufficientAlternative: speculative.length > 0 ? 'x' : null,
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: ['x'],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: [],
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
    const errors = validateScopeAssessmentApplicability(input, assessment);
    assert.ok(
      errors.includes(
        `$ changeInventory.publicSurfaces material surface ${JSON.stringify(surface)} lacks accepted-scope authorization and requires human-decision-required material-scope-change coverage with category public-surface`,
      ),
      `${assessment.verdict}: missing material-surface rejection`,
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
    const errors = validateScopeAssessmentApplicability(input, candidate);
    assert.ok(
      errors.includes(
        `$ changeInventory.publicSurfaces material surface ${JSON.stringify(surface)} lacks explicit authoritative-source or approved-decision support and requires human-decision-required material-scope-change coverage with category public-surface`,
      ),
      `${candidate.verdict}: missing material-surface rejection`,
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

test('an exact approved decision can supply material source authority', () => {
  const surface = 'decision-authorized-public-api';
  const decisionDigest = `sha256:${'e'.repeat(64)}`;
  const decisionId = 'approve-public-api';
  const input = packet({
    binding: binding({ decisionDigests: [decisionDigest] }),
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [...packet().acceptedScope.authorizedShape, surface],
      authorityDecisions: [{
        id: decisionId,
        digest: decisionDigest,
        disposition: 'approve-material-amendment',
        authorizedShape: [surface],
      }],
    },
    changeInventory: {
      ...packet().changeInventory,
      publicSurfaces: [surface],
      mappings: [
        ...packet().changeInventory.mappings,
        {
          mechanism: surface,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          decisionIds: [decisionId],
          rationale: 'The exact approved decision authorizes this material surface.',
        },
      ],
    },
  });
  const assessment = result('within-scope', {
    binding: input.binding,
    coverage: [
      ...result('within-scope').coverage,
      {
        mechanism: surface,
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        decisionIds: [decisionId],
        classification: 'required',
        rationale: 'The approved decision and accepted shape provide exact authority.',
      },
    ],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);

  const stale = structuredClone(input);
  stale.binding.decisionDigests = [`sha256:${'f'.repeat(64)}`];
  assert.ok(validateAssessmentPacket(stale).includes(
    '$ binding.decisionDigests must exactly match acceptedScope.authorityDecisions digests in order',
  ));
});

test('dual-authorized material inventory cannot be relabeled with its native category', () => {
  const cases = [
    ['dependencies', 'new-dependency'],
    ['publicSurfaces', 'public-surface'],
    ['persistentSurfaces', 'persistent-surface'],
    ['subsystems', 'new-subsystem'],
  ];
  for (const [field, category] of cases) {
    const surface = `authorized-${field}`;
    const mapping = {
      mechanism: surface,
      sourceCriterionIds: ['direct-fix'],
      acceptedCriterionIds: ['direct-fix'],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      rationale: 'Both exact authorities support the inventory surface.',
    };
    const input = packet({
      acceptedScope: {
        ...packet().acceptedScope,
        authorizedShape: [surface],
      },
      changeInventory: {
        ...packet().changeInventory,
        dependencies: [],
        publicSurfaces: [],
        persistentSurfaces: [],
        subsystems: [],
        [field]: [surface],
        mappings: [mapping],
      },
    });
    const nativeRelabel = result('human-decision-required', {
      coverage: [{ ...mapping, classification: 'material-scope-change' }],
      scopeDelta: {
        description: 'Relabel the authorized surface and add a policy.',
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        materialSurfaces: [category, 'policy-change'],
      },
      materialityTriggers: [
        { category, evidence: 'The native inventory category is claimed.' },
        { category: 'policy-change', evidence: 'A distinct policy expansion is also claimed.' },
      ],
      smallestExpansion: 'Add only the proposed policy.',
      narrowAlternative: 'Keep the authorized inventory surface without policy expansion.',
      deferralConsequences: 'The authorized surface remains ordinary scoped work.',
      humanDecision: true,
    });
    assert.deepEqual(validateScopeAssessmentApplicability(input, result('within-scope', {
      coverage: [{ ...mapping, classification: 'implementation-choice' }],
    })), [], field);
    assert.match(
      validateScopeAssessmentApplicability(input, nativeRelabel).join('\n'),
      new RegExp(`cannot be relabeled material-scope-change with native category ${category}`, 'u'),
      field,
    );

    const distinctExpansion = {
      ...nativeRelabel,
      scopeDelta: { ...nativeRelabel.scopeDelta, materialSurfaces: ['policy-change'] },
      materialityTriggers: [nativeRelabel.materialityTriggers[1]],
    };
    assert.deepEqual(validateScopeAssessmentApplicability(input, distinctExpansion), [], field);
  }
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
        [`$ coverage[0] ${classification} classification lacks positive source, accepted-criterion, invariant, or approved-decision authority`],
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

test('mixed minor assessment retains necessary work and removes independent speculation', () => {
  const input = mixedMinorPacket(2);
  const assessment = mixedMinorResult(input);

  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentResult(assessment), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, {
    ...assessment,
    unnecessaryWork: [...assessment.unnecessaryWork].reverse(),
  }), []);

  const correspondenceFailures = [
    { ...assessment, unnecessaryWork: assessment.unnecessaryWork.slice(1) },
    { ...assessment, unnecessaryWork: [...assessment.unnecessaryWork, 'extra-work'] },
    { ...assessment, smallerSufficientAlternative: null },
  ];
  for (const candidate of correspondenceFailures) {
    assert.notDeepEqual(validateScopeAssessmentResult(candidate), []);
  }

  const pureMinor = mixedMinorResult(mixedMinorPacket(0));
  assert.deepEqual(validateScopeAssessmentResult(pureMinor), []);
  assert.notDeepEqual(
    validateScopeAssessmentResult({ ...pureMinor, smallerSufficientAlternative: 'Remove nothing.' }),
    [],
  );

  const deferredInput = mixedMinorPacket(1);
  deferredInput.acceptedScope.deferredShape = deferredInput.acceptedScope.unauthorizedShape;
  deferredInput.acceptedScope.unauthorizedShape = [];
  assert.deepEqual(
    validateScopeAssessmentApplicability(deferredInput, mixedMinorResult(deferredInput)),
    [],
  );
});

test('mixed minor cannot trim a deficient material inventory surface', () => {
  const input = mixedMinorPacket(1);
  const speculative = input.changeInventory.mappings[1].mechanism;
  input.changeInventory.publicSurfaces = [speculative];
  const assessment = mixedMinorResult(input);
  assert.match(
    validateScopeAssessmentApplicability(input, assessment).join('\n'),
    /requires human-decision-required material-scope-change coverage with category public-surface/u,
  );
});

test('supported authorized material inventory remains a feasible minor anchor', () => {
  const mechanism = 'supported-subsystem';
  const mapping = {
    mechanism,
    sourceCriterionIds: ['supported-scope'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'The source supports the accepted material inventory mechanism.',
  };
  const input = packet({
    sourceScope: {
      ...packet().sourceScope,
      requiredCriteria: [{ id: 'supported-scope', text: 'Support the named subsystem.' }],
    },
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [mechanism],
    },
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [mechanism],
      mappings: [mapping],
    },
  });
  const assessment = result('minor-amendment-required', {
    coverage: [{ ...mapping, classification: 'necessary-minor-expansion' }],
    scopeDelta: {
      description: 'Record the already supported subsystem as a bounded minor amendment.',
      sourceCriterionIds: ['supported-scope'],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: [],
    },
  });

  assert.deepEqual(validateAssessmentPacket(input), []);
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

test('task-packet identity requires an accepted-plan identity in every assessment phase', () => {
  for (const phase of ['plan', 'task', 'integrated-head', 'review-finding']) {
    const staleBinding = binding({
      phase,
      subject: phase === 'plan'
        ? { digest: `sha256:${B}`, sha: null }
        : binding().subject,
      planDigest: null,
      amendmentDigests: [],
      taskPacketDigest: `sha256:${A}`,
    });
    const stalePacket = packet({ binding: staleBinding });
    const staleResult = result('within-scope', { binding: staleBinding });

    assert.notDeepEqual(validateAssessmentPacket(stalePacket), [], `${phase}: packet`);
    assert.notDeepEqual(validateScopeAssessmentResult(staleResult), [], `${phase}: result`);
    assert.notDeepEqual(
      validateScopeAssessmentApplicability(stalePacket, staleResult),
      [],
      `${phase}: applicability`,
    );
  }
});

test('code phases require insufficient evidence when plan or task artifacts are absent', () => {
  const artifactCases = [
    {
      label: 'plan',
      overrides: { planDigest: null, amendmentDigests: [], taskPacketDigest: null },
    },
    {
      label: 'task packet',
      overrides: { taskPacketDigest: null },
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
    {
      label: 'plan',
      overrides: { planDigest: null, amendmentDigests: [], taskPacketDigest: null },
    },
    { label: 'task packet', overrides: { taskPacketDigest: null } },
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
  const affirmativeErrors = validateScopeAssessmentApplicability(input, affirmative);
  assert.ok(
    affirmativeErrors.includes(
      `$ changeInventory.subsystems material surface ${JSON.stringify(unsupportedSurface)} lacks explicit authoritative-source or approved-decision support and accepted-scope authorization and requires human-decision-required material-scope-change coverage with category new-subsystem`,
    ),
  );
  assert.match(affirmativeErrors.join('\n'), /is not mapped to mechanism/u);
});

test('coverage authority is a same-mechanism same-field subset for every verdict', () => {
  const fields = [
    ['sourceCriterionIds', 'other-source'],
    ['acceptedCriterionIds', 'other-accepted'],
    ['invariantIds', 'other-invariant'],
    ['nonGoalIds', 'other-non-goal'],
    ['guidanceIds', 'other-guidance'],
  ];
  const secondMapping = {
    mechanism: 'second-mechanism',
    sourceCriterionIds: ['other-source'],
    acceptedCriterionIds: ['other-accepted'],
    invariantIds: ['other-invariant'],
    nonGoalIds: ['other-non-goal'],
    guidanceIds: ['other-guidance'],
    rationale: 'The second mechanism owns separate authority in every namespace.',
  };
  const input = packet({
    sourceScope: {
      ...packet().sourceScope,
      requiredCriteria: [
        ...packet().sourceScope.requiredCriteria,
        { id: 'other-source', text: 'Authorize only the second mechanism.' },
      ],
      nonGoals: [
        ...packet().sourceScope.nonGoals,
        { id: 'other-non-goal', text: 'Constrain only the second mechanism.' },
      ],
      implementationGuidance: [{ id: 'other-guidance', text: 'Guide only the second mechanism.' }],
    },
    acceptedScope: {
      ...packet().acceptedScope,
      criteria: [
        ...packet().acceptedScope.criteria,
        { id: 'other-accepted', text: 'Accept only the second mechanism.' },
      ],
      invariants: [
        ...packet().acceptedScope.invariants,
        { id: 'other-invariant', text: 'Constrain only the second mechanism.' },
      ],
    },
    changeInventory: {
      ...packet().changeInventory,
      mappings: [...packet().changeInventory.mappings, secondMapping],
    },
  });
  const verdictShapes = [
    ['within-scope', {}],
    ['trim-required', {
      unnecessaryWork: ['direct-local-fix'],
      smallerSufficientAlternative: 'x',
    }],
    ['minor-amendment-required', {
      scopeDelta: {
        description: 'x',
        sourceCriterionIds: ['other-source'],
        acceptedCriterionIds: [],
        invariantIds: [],
        materialSurfaces: [],
      },
    }],
    ['human-decision-required', {
      scopeDelta: {
        description: 'x',
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        materialSurfaces: ['policy-change'],
      },
      materialityTriggers: [{ category: 'policy-change', evidence: 'x' }],
      smallestExpansion: 'x',
      narrowAlternative: 'x',
      deferralConsequences: 'x',
      humanDecision: true,
    }],
    ['insufficient-evidence', { missingEvidence: ['x'] }],
  ];

  for (const [field, borrowedId] of fields) {
    for (const [verdict, shape] of verdictShapes) {
      let firstClassification = 'required';
      let secondClassification = 'required';
      if (verdict === 'trim-required') firstClassification = 'speculative';
      if (verdict === 'minor-amendment-required') {
        firstClassification = 'necessary-minor-expansion';
        secondClassification = 'necessary-minor-expansion';
      }
      if (verdict === 'human-decision-required') firstClassification = 'material-scope-change';
      if (verdict === 'insufficient-evidence') {
        firstClassification = 'insufficient-evidence';
        secondClassification = 'insufficient-evidence';
      }
      const first = {
        ...result('within-scope').coverage[0],
        [field]: [borrowedId],
        classification: firstClassification,
      };
      const second = { ...secondMapping, classification: secondClassification };
      const assessment = result(verdict, { ...shape, coverage: [first, second] });
      assert.match(
        validateScopeAssessmentApplicability(input, assessment).join('\n'),
        new RegExp(`coverage\\[0\\]\\.${field} authority .* is not mapped`, 'u'),
        `${verdict}:${field}`,
      );
    }
  }

  const supportedSubset = result('within-scope', {
    coverage: [
      result('within-scope').coverage[0],
      {
        ...secondMapping,
        acceptedCriterionIds: [],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        classification: 'required',
      },
    ],
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, supportedSubset), []);
});

test('minor scope deltas are grounded bidirectionally by necessary mechanisms', () => {
  const sharedCriterion = { id: 'shared-minor', text: 'Ground both minor mechanisms.' };
  const mappings = ['minor-one', 'minor-two'].map((mechanism, index) => ({
    mechanism,
    sourceCriterionIds: [`source-${index + 1}`],
    acceptedCriterionIds: ['shared-minor'],
    invariantIds: [`invariant-${index + 1}`],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'The minor mechanism has packet-local authority.',
  }));
  const input = packet({
    sourceScope: {
      ...packet().sourceScope,
      requiredCriteria: [
        { id: 'source-1', text: 'Ground the first mechanism.' },
        { id: 'source-2', text: 'Ground the second mechanism.' },
      ],
    },
    acceptedScope: {
      ...packet().acceptedScope,
      criteria: [sharedCriterion],
      invariants: [
        { id: 'invariant-1', text: 'Constrain the first mechanism.' },
        { id: 'invariant-2', text: 'Constrain the second mechanism.' },
      ],
      authorizedShape: [],
    },
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [],
      mappings,
    },
  });
  const coverage = mappings.map((mapping) => ({
    ...mapping,
    sourceCriterionIds: [],
    invariantIds: [],
    classification: 'necessary-minor-expansion',
  }));
  const valid = result('minor-amendment-required', {
    coverage,
    scopeDelta: {
      description: 'Admit both bounded mechanisms.',
      sourceCriterionIds: [],
      acceptedCriterionIds: ['shared-minor'],
      invariantIds: [],
      materialSurfaces: [],
    },
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, valid), []);

  const ungroundedRow = {
    ...valid,
    coverage: [
      coverage[0],
      { ...coverage[1], acceptedCriterionIds: [], invariantIds: ['invariant-2'] },
    ],
  };
  assert.match(
    validateScopeAssessmentApplicability(input, ungroundedRow).join('\n'),
    /minor-two.*share same-field positive authority/u,
  );

  const mappingOnlyDelta = {
    ...valid,
    scopeDelta: { ...valid.scopeDelta, sourceCriterionIds: ['source-1'] },
  };
  assert.match(
    validateScopeAssessmentApplicability(input, mappingOnlyDelta).join('\n'),
    /scopeDelta\.sourceCriterionIds authority .* is not supported/u,
  );

  const namespacePacket = packet({
    sourceScope: {
      ...packet().sourceScope,
      requiredCriteria: [{ id: 'same-id', text: 'Source namespace.' }],
    },
    acceptedScope: {
      ...packet().acceptedScope,
      criteria: [{ id: 'same-id', text: 'Accepted namespace.' }],
      authorizedShape: [],
    },
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [],
      mappings: [{
        ...packet().changeInventory.mappings[0],
        sourceCriterionIds: ['same-id'],
        acceptedCriterionIds: ['same-id'],
      }],
    },
  });
  const namespaceCrossing = result('minor-amendment-required', {
    coverage: [{
      ...result('within-scope').coverage[0],
      sourceCriterionIds: ['same-id'],
      acceptedCriterionIds: [],
      classification: 'necessary-minor-expansion',
    }],
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: [],
      acceptedCriterionIds: ['same-id'],
      invariantIds: [],
      materialSurfaces: [],
    },
  });
  assert.match(
    validateScopeAssessmentApplicability(namespacePacket, namespaceCrossing).join('\n'),
    /share same-field positive authority/u,
  );
});

test('minor amendments accept exact invariant-only authority and reject empty grounding', () => {
  const mechanism = 'invariant-bound-helper';
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [],
      unauthorizedShape: [mechanism],
    },
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [],
      mappings: [{
        ...packet().changeInventory.mappings[0],
        mechanism,
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: ['exact-subject'],
      }],
    },
  });
  const assessment = result('minor-amendment-required', {
    coverage: [{
      ...input.changeInventory.mappings[0],
      classification: 'necessary-minor-expansion',
    }],
    scopeDelta: {
      description: 'Add only the invariant-bound helper.',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: ['exact-subject'],
      materialSurfaces: [],
    },
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);

  const emptyDelta = {
    ...assessment,
    scopeDelta: { ...assessment.scopeDelta, invariantIds: [] },
  };
  assert.notDeepEqual(validateScopeAssessmentResult(emptyDelta), []);
  assert.notDeepEqual(validateScopeAssessmentApplicability(input, emptyDelta), []);
});

test('human decisions retain independent speculative nonmaterial coverage', () => {
  const material = 'new-material-subsystem';
  const helper = 'removable-local-helper';
  const input = packet({
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [material],
      mappings: [
        {
          ...packet().changeInventory.mappings[0],
          mechanism: material,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
        },
        {
          ...packet().changeInventory.mappings[0],
          mechanism: helper,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
        },
      ],
    },
  });
  const assessment = result('human-decision-required', {
    coverage: [
      {
        ...input.changeInventory.mappings[0],
        classification: 'material-scope-change',
      },
      {
        ...input.changeInventory.mappings[1],
        classification: 'speculative',
      },
    ],
    scopeDelta: {
      description: 'Decide the subsystem while retaining the smaller local alternative.',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-subsystem'],
    },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'The inventory adds a subsystem.' }],
    smallestExpansion: 'Add only the proposed subsystem.',
    narrowAlternative: 'Remove both the subsystem and independent helper.',
    deferralConsequences: 'Neither optional mechanism is added.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);

  const materialAsSpeculative = {
    ...assessment,
    coverage: [
      { ...assessment.coverage[0], classification: 'speculative' },
      { ...assessment.coverage[1], classification: 'material-scope-change' },
    ],
  };
  const errors = validateScopeAssessmentApplicability(input, materialAsSpeculative).join('\n');
  assert.match(errors, /speculative mechanism .* must be independent removable nonmaterial work/u);
  assert.match(errors, /requires human-decision-required material-scope-change coverage/u);
});

test('human decisions allow grounded rejected work to remain counterfactually speculative', () => {
  const variants = [
    { disposition: 'unauthorizedShape', field: 'sourceCriterionIds', id: 'direct-fix' },
    { disposition: 'deferredShape', field: 'sourceCriterionIds', id: 'direct-fix' },
    { disposition: 'unauthorizedShape', field: 'acceptedCriterionIds', id: 'direct-fix' },
    { disposition: 'deferredShape', field: 'acceptedCriterionIds', id: 'direct-fix' },
    { disposition: 'unauthorizedShape', field: 'invariantIds', id: 'exact-subject' },
    { disposition: 'deferredShape', field: 'invariantIds', id: 'exact-subject' },
  ];

  for (const { disposition, field, id } of variants) {
    const material = `material-${disposition}-${field}`;
    const removable = `removable-${disposition}-${field}`;
    const acceptedScope = {
      ...packet().acceptedScope,
      authorizedShape: [],
      unauthorizedShape: [],
      deferredShape: [],
      [disposition]: [removable],
    };
    const removableMapping = {
      ...packet().changeInventory.mappings[0],
      mechanism: removable,
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      [field]: [id],
      rationale: 'The authority records relevance; removal preserves minimal closure.',
    };
    const input = packet({
      acceptedScope,
      changeInventory: {
        ...packet().changeInventory,
        subsystems: [material],
        mappings: [
          {
            ...packet().changeInventory.mappings[0],
            mechanism: material,
            sourceCriterionIds: [],
            acceptedCriterionIds: [],
            invariantIds: [],
          },
          removableMapping,
        ],
      },
    });
    const speculative = result('human-decision-required', {
      coverage: [
        { ...input.changeInventory.mappings[0], classification: 'material-scope-change' },
        {
          ...removableMapping,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
          classification: 'speculative',
          rationale: 'Removing this mechanism preserves the outcome, scope, and closure.',
        },
      ],
      scopeDelta: {
        description: 'Decide only the material subsystem.',
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        materialSurfaces: ['new-subsystem'],
      },
      materialityTriggers: [{ category: 'new-subsystem', evidence: 'A subsystem is proposed.' }],
      smallestExpansion: 'Add only the subsystem.',
      narrowAlternative: 'Keep the bounded implementation.',
      deferralConsequences: 'The subsystem remains absent.',
      humanDecision: true,
    });
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, speculative),
      [],
      `${disposition} ${field} speculative`,
    );

    const necessary = {
      ...speculative,
      coverage: [
        speculative.coverage[0],
        {
          ...speculative.coverage[1],
          [field]: [id],
          classification: 'necessary-minor-expansion',
          rationale: 'The removal counterfactual establishes this minor mechanism is necessary.',
        },
      ],
      scopeDelta: {
        ...speculative.scopeDelta,
        [field]: [id],
      },
    };
    assert.deepEqual(
      validateScopeAssessmentApplicability(input, necessary),
      [],
      `${disposition} ${field} necessary minor`,
    );

    const borrowedField = field === 'sourceCriterionIds'
      ? 'acceptedCriterionIds'
      : 'sourceCriterionIds';
    const borrowed = {
      ...necessary,
      scopeDelta: {
        ...necessary.scopeDelta,
        [field]: [],
        [borrowedField]: ['direct-fix'],
      },
    };
    assert.match(
      validateScopeAssessmentApplicability(input, borrowed).join('\n'),
      /share same-field positive authority/u,
      `${disposition} ${field} borrowed authority`,
    );

    for (const classification of ['required', 'implementation-choice']) {
      const affirmative = {
        ...speculative,
        coverage: [
          speculative.coverage[0],
          { ...necessary.coverage[1], classification },
        ],
      };
      assert.match(
        validateScopeAssessmentApplicability(input, affirmative).join('\n'),
        new RegExp(`despite acceptedScope\\.${disposition}`, 'u'),
        `${disposition} ${field} ${classification}`,
      );
    }
  }
});

test('human decisions preserve grounded minor work beside material and speculative work', () => {
  const material = 'new-material-subsystem';
  const minor = 'invariant-bound-follow-up';
  const speculative = 'unsupported-local-helper';
  const input = packet({
    acceptedScope: {
      ...packet().acceptedScope,
      authorizedShape: [],
      unauthorizedShape: [minor],
    },
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [material],
      mappings: [
        {
          ...packet().changeInventory.mappings[0],
          mechanism: material,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
        },
        {
          ...packet().changeInventory.mappings[0],
          mechanism: minor,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: ['exact-subject'],
        },
        {
          ...packet().changeInventory.mappings[0],
          mechanism: speculative,
          sourceCriterionIds: [],
          acceptedCriterionIds: [],
          invariantIds: [],
        },
      ],
    },
  });
  const assessment = result('human-decision-required', {
    coverage: [
      { ...input.changeInventory.mappings[0], classification: 'material-scope-change' },
      { ...input.changeInventory.mappings[1], classification: 'necessary-minor-expansion' },
      { ...input.changeInventory.mappings[2], classification: 'speculative' },
    ],
    scopeDelta: {
      description: 'Decide the subsystem and retain the invariant-bound minor follow-up.',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: ['exact-subject'],
      materialSurfaces: ['new-subsystem'],
    },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'A new subsystem is proposed.' }],
    smallestExpansion: 'Add only the subsystem and grounded follow-up.',
    narrowAlternative: 'Retain the existing bounded implementation.',
    deferralConsequences: 'The material subsystem remains absent.',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);
  assert.deepEqual(validateAssessmentPacket(input), []);

  const deltaOnly = {
    ...assessment,
    coverage: [
      assessment.coverage[0],
      { ...assessment.coverage[1], invariantIds: [] },
      assessment.coverage[2],
    ],
  };
  assert.match(
    validateScopeAssessmentApplicability(input, deltaOnly).join('\n'),
    /share same-field positive authority/u,
  );

  const relabeledMinor = {
    ...assessment,
    coverage: [
      assessment.coverage[0],
      { ...assessment.coverage[1], classification: 'speculative' },
      assessment.coverage[2],
    ],
  };
  assert.deepEqual(validateScopeAssessmentApplicability(input, relabeledMinor), []);

  const materialRelabel = {
    ...assessment,
    coverage: [
      assessment.coverage[0],
      { ...assessment.coverage[1], classification: 'material-scope-change' },
      assessment.coverage[2],
    ],
  };
  assert.match(
    validateScopeAssessmentApplicability(input, materialRelabel).join('\n'),
    /requires a distinct non-native material category/u,
  );

  const distinctNonNativeExpansion = {
    ...materialRelabel,
    scopeDelta: {
      ...materialRelabel.scopeDelta,
      materialSurfaces: ['new-subsystem', 'policy-change'],
    },
    materialityTriggers: [
      ...materialRelabel.materialityTriggers,
      { category: 'policy-change', evidence: 'The grounded row is separately proposed as policy.' },
    ],
  };
  assert.deepEqual(
    validateScopeAssessmentApplicability(input, distinctNonNativeExpansion),
    [],
  );

  const unsupportedMaterialRelabel = {
    ...assessment,
    coverage: [
      assessment.coverage[0],
      assessment.coverage[1],
      { ...assessment.coverage[2], classification: 'material-scope-change' },
    ],
  };
  assert.match(
    validateScopeAssessmentApplicability(input, unsupportedMaterialRelabel).join('\n'),
    /independent unsupported work must remain speculative/u,
  );

  const distinctUnsupportedExpansion = {
    ...unsupportedMaterialRelabel,
    scopeDelta: {
      ...unsupportedMaterialRelabel.scopeDelta,
      materialSurfaces: ['new-subsystem', 'policy-change'],
    },
    materialityTriggers: [
      ...unsupportedMaterialRelabel.materialityTriggers,
      { category: 'policy-change', evidence: 'The unsupported row is separately proposed as policy.' },
    ],
  };
  assert.deepEqual(
    validateScopeAssessmentApplicability(input, distinctUnsupportedExpansion),
    [],
  );
});

test('human representability uses only forced categories and a one-trigger fallback', () => {
  const mechanisms = Array.from({ length: 118 }, (_, index) => `m${index}`);
  const input = compactPacket(mechanisms, {
    source: { ...binding().source, identity: 'i'.repeat(512) },
    amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
  });
  const coverage = mechanisms.map((mechanism, index) => ({
    mechanism,
    sourceCriterionIds: [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    classification: index === 0 ? 'material-scope-change' : 'speculative',
    rationale: 'x',
  }));
  const assessment = result('human-decision-required', {
    binding: input.binding,
    summary: 'x',
    coverage,
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-criterion'],
    },
    materialityTriggers: [{ category: 'new-criterion', evidence: 'x' }],
    smallestExpansion: 'x',
    narrowAlternative: 'x',
    deferralConsequences: 'x',
    humanDecision: true,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(assessment)) < SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES);
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, assessment), []);

  const forced = packet({
    changeInventory: {
      ...packet().changeInventory,
      dependencies: ['forced-surface'],
      publicSurfaces: ['forced-surface'],
      subsystems: ['forced-surface'],
      mappings: [{
        ...packet().changeInventory.mappings[0],
        mechanism: 'forced-surface',
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
      }],
    },
  });
  const forcedAssessment = result('human-decision-required', {
    coverage: [{
      ...forced.changeInventory.mappings[0],
      classification: 'material-scope-change',
    }],
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-dependency', 'public-surface', 'new-subsystem'],
    },
    materialityTriggers: [
      { category: 'new-subsystem', evidence: 'x' },
      { category: 'new-dependency', evidence: 'x' },
      { category: 'public-surface', evidence: 'x' },
    ],
    smallestExpansion: 'x',
    narrowAlternative: 'x',
    deferralConsequences: 'x',
    humanDecision: true,
  });
  assert.deepEqual(validateScopeAssessmentApplicability(forced, forcedAssessment), []);
});

test('generic-trigger human representability projects grounded rejected rows as speculative', () => {
  const mechanisms = Array.from(
    { length: 128 },
    (_, index) => `m${String(index).padStart(3, '0')}`,
  );
  const input = compactPacket(mechanisms, {
    source: { ...binding().source, identity: 'i'.repeat(512) },
    amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
  });
  input.acceptedScope.unauthorizedShape = mechanisms;

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.doesNotMatch(
    validateAssessmentPacket(input).join('\n'),
    /schema-minimal human-decision-required result/u,
  );

  const smallInput = compactPacket(['material-anchor', 'grounded-minor']);
  smallInput.acceptedScope.unauthorizedShape = ['material-anchor', 'grounded-minor'];
  const applicableProjection = result('human-decision-required', {
    binding: smallInput.binding,
    coverage: [
      {
        ...smallInput.changeInventory.mappings[0],
        sourceCriterionIds: [],
        classification: 'material-scope-change',
      },
      {
        ...smallInput.changeInventory.mappings[1],
        classification: 'necessary-minor-expansion',
      },
    ],
    scopeDelta: {
      description: 'Represent one distinct material anchor and one grounded minor row.',
      sourceCriterionIds: ['x'],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-criterion'],
    },
    materialityTriggers: [{ category: 'new-criterion', evidence: 'A distinct criterion is proposed.' }],
    smallestExpansion: 'Add only the distinct criterion and grounded minor row.',
    narrowAlternative: 'Keep the current accepted scope.',
    deferralConsequences: 'The distinct criterion remains absent.',
    humanDecision: true,
  });
  assert.deepEqual(
    validateScopeAssessmentApplicability(smallInput, applicableProjection),
    [],
  );
});

test('grounded speculative human projection accepts 32768 bytes and rejects 32769', () => {
  const makeInput = (count, identityBytes) => {
    const material = 'forced-material';
    const removable = Array.from(
      { length: count },
      (_, index) => `grounded-${String(index).padStart(3, '0')}`,
    );
    const input = compactPacket([material, ...removable], {
      source: { ...binding().source, identity: 'i'.repeat(identityBytes) },
      amendmentDigests: [],
    });
    input.acceptedScope.deferredShape = removable;
    input.changeInventory.subsystems = [material];
    input.changeInventory.mappings[0] = {
      ...input.changeInventory.mappings[0],
      sourceCriterionIds: [],
    };
    return input;
  };
  const projectedResult = (input) => result('human-decision-required', {
    binding: input.binding,
    summary: 'x',
    coverage: input.changeInventory.mappings.map((mapping, index) => ({
      mechanism: mapping.mechanism,
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      nonGoalIds: [],
      guidanceIds: [],
      classification: index === 0 ? 'material-scope-change' : 'speculative',
      rationale: 'x',
    })),
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: [],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-subsystem'],
    },
    materialityTriggers: [{ category: 'new-subsystem', evidence: 'x' }],
    smallestExpansion: 'x',
    narrowAlternative: 'x',
    deferralConsequences: 'x',
    humanDecision: true,
  });

  let boundary = null;
  for (let count = 100; count <= 254 && boundary === null; count += 1) {
    const shortest = makeInput(count, 1);
    const identityBytes = 1 + SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES
      - Buffer.byteLength(JSON.stringify(projectedResult(shortest)));
    if (identityBytes < 1 || identityBytes >= 512) continue;
    boundary = {
      at: makeInput(count, identityBytes),
      over: makeInput(count, identityBytes + 1),
    };
  }

  assert.ok(boundary, 'a grounded-speculative human boundary must be constructible');
  assert.equal(
    Buffer.byteLength(JSON.stringify(projectedResult(boundary.at))),
    SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(boundary.at)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.doesNotMatch(
    validateAssessmentPacket(boundary.at).join('\n'),
    /schema-minimal human-decision-required result/u,
  );
  assert.match(
    validateAssessmentPacket(boundary.over).join('\n'),
    /schema-minimal human-decision-required result.*requires 32769 bytes/u,
  );
});

test('generic human representability globally minimizes asymmetric anchor scenarios', () => {
  const mechanisms = Array.from(
    { length: 128 },
    (_, index) => `m${index}`,
  );
  const longAuthority = 'a'.repeat(128);
  const mappings = mechanisms.map((mechanism, index) => ({
    mechanism,
    sourceCriterionIds: index === 0 ? ['x'] : index === 1 ? [longAuthority] : [],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'x',
  }));
  const input = packet({
    binding: binding({
      source: { ...binding().source, identity: 'i'.repeat(500) },
      amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
    }),
    sourceScope: {
      objective: 'x',
      requiredCriteria: [
        { id: 'x', text: 'x' },
        { id: longAuthority, text: 'x' },
      ],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: mechanisms.slice(0, 2),
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
  const witness = result('human-decision-required', {
    binding: input.binding,
    summary: 'x',
    coverage: mappings.map((mapping, index) => ({
      ...mapping,
      sourceCriterionIds: index === 0 ? ['x'] : [],
      classification: index === 1
        ? 'material-scope-change'
        : index === 0
          ? 'necessary-minor-expansion'
          : 'speculative',
      rationale: 'x',
    })),
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: ['x'],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: ['new-criterion'],
    },
    materialityTriggers: [{ category: 'new-criterion', evidence: 'x' }],
    smallestExpansion: 'x',
    narrowAlternative: 'x',
    deferralConsequences: 'x',
    humanDecision: true,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(witness)) <= SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES);
  assert.deepEqual(validateScopeAssessmentResult(witness), []);
  const correspondenceInput = {
    ...input,
    binding: binding({
      source: { ...binding().source, identity: 'i' },
      amendmentDigests: [],
    }),
  };
  const correspondenceWitness = { ...witness, binding: correspondenceInput.binding };
  assert.deepEqual(
    validateScopeAssessmentApplicability(correspondenceInput, correspondenceWitness),
    [],
  );
  const startedAt = Date.now();
  const packetErrors = validateAssessmentPacket(input);
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.doesNotMatch(packetErrors.join('\n'), /human-decision-required/u);
  assert.ok(elapsedMilliseconds < 5000, `anchor scenarios took ${elapsedMilliseconds}ms`);
});

test('minor representability jointly minimizes shared mapping authority', () => {
  const mechanisms = Array.from({ length: 114 }, (_, index) => `m${index}`);
  const sourceCriteria = [
    { id: 'shared', text: 'x' },
    ...mechanisms.map((_, index) => ({ id: `a${index}`, text: 'x' })),
  ];
  const mappings = mechanisms.map((mechanism, index) => ({
    mechanism,
    sourceCriterionIds: [`a${index}`, 'shared'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'x',
  }));
  const input = packet({
    binding: binding({
      source: { ...binding().source, identity: 'i'.repeat(512) },
      amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
    }),
    sourceScope: {
      objective: 'x',
      requiredCriteria: sourceCriteria,
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: mechanisms,
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
  const witness = result('minor-amendment-required', {
    binding: input.binding,
    summary: 'x',
    coverage: mappings.map((mapping) => ({
      ...mapping,
      sourceCriterionIds: ['shared'],
      classification: 'necessary-minor-expansion',
    })),
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: ['shared'],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: [],
    },
  });

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(witness)) < SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES);
  assert.deepEqual(validateScopeAssessmentResult(witness), []);
  assert.deepEqual(validateAssessmentPacket(input), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, witness), []);
});

test('minor representability accepts the official grounded mixed projection', () => {
  const mechanisms = Array.from(
    { length: 165 },
    (_, index) => `m${String(index).padStart(3, '0')}`,
  );
  const input = packet({
    binding: binding({
      source: { ...binding().source, identity: 'i' },
      amendmentDigests: [],
    }),
    sourceScope: {
      objective: 'x',
      requiredCriteria: mechanisms.map((_, index) => ({
        id: `s${String(index).padStart(3, '0')}`,
        text: 'x',
      })),
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: mechanisms.map((_, index) => ({
        id: `i${String(index).padStart(3, '0')}`,
        text: 'x',
      })),
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: mechanisms,
      deferredShape: [],
    },
    changeInventory: {
      summary: 'x',
      paths: [],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: [],
      mappings: mechanisms.map((mechanism, index) => ({
        mechanism,
        sourceCriterionIds: [`s${String(index).padStart(3, '0')}`],
        acceptedCriterionIds: [],
        invariantIds: [`i${String(index).padStart(3, '0')}`],
        nonGoalIds: [],
        guidanceIds: [],
        rationale: 'x',
      })),
    },
  });
  const [necessary, ...speculative] = input.changeInventory.mappings;
  const witness = result('minor-amendment-required', {
    binding: input.binding,
    summary: 'x',
    coverage: [
      {
        ...necessary,
        invariantIds: [],
        classification: 'necessary-minor-expansion',
      },
      ...speculative.map((mapping) => ({
        ...mapping,
        sourceCriterionIds: [],
        invariantIds: [],
        classification: 'speculative',
      })),
    ],
    unnecessaryWork: speculative.map(({ mechanism }) => mechanism),
    smallerSufficientAlternative: 'x',
    scopeDelta: {
      description: 'x',
      sourceCriterionIds: [necessary.sourceCriterionIds[0]],
      acceptedCriterionIds: [],
      invariantIds: [],
      materialSurfaces: [],
    },
  });

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  assert.equal(Buffer.byteLength(JSON.stringify(witness)), 29970);
  assert.deepEqual(validateScopeAssessmentResult(witness), []);
  assert.deepEqual(validateScopeAssessmentApplicability(input, witness), []);
  assert.deepEqual(validateAssessmentPacket(input), []);
});

test('mixed shared-authority subset beats single-anchor and all-necessary projections', () => {
  const mechanisms = [`${'l'.repeat(500)}-one`, `${'l'.repeat(500)}-two`, 's-one', 's-two'];
  const mappings = mechanisms.map((mechanism) => ({
    mechanism,
    sourceCriterionIds: ['shared'],
    acceptedCriterionIds: [],
    invariantIds: [],
    nonGoalIds: [],
    guidanceIds: [],
    rationale: 'x',
  }));
  const input = packet({
    sourceScope: {
      objective: 'x',
      requiredCriteria: [{ id: 'shared', text: 'x' }],
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: mechanisms,
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
  const projection = (necessaryIndexes) => {
    const necessary = new Set(necessaryIndexes);
    const speculative = mappings.filter((_, index) => !necessary.has(index));
    return result('minor-amendment-required', {
      coverage: mappings.map((mapping, index) => ({
        ...mapping,
        sourceCriterionIds: necessary.has(index) ? ['shared'] : [],
        classification: necessary.has(index) ? 'necessary-minor-expansion' : 'speculative',
      })),
      unnecessaryWork: speculative.map(({ mechanism }) => mechanism),
      smallerSufficientAlternative: speculative.length > 0 ? 'x' : null,
      scopeDelta: {
        description: 'x',
        sourceCriterionIds: ['shared'],
        acceptedCriterionIds: [],
        invariantIds: [],
        materialSurfaces: [],
      },
    });
  };
  const mixed = projection([0, 1]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(mixed)) < Buffer.byteLength(JSON.stringify(projection([0]))),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(mixed)) < Buffer.byteLength(JSON.stringify(projection([0, 1, 2, 3]))),
  );
  assert.deepEqual(validateScopeAssessmentApplicability(input, mixed), []);
  assert.doesNotMatch(
    validateAssessmentPacket(input).join('\n'),
    /schema-minimal minor-amendment-required/u,
  );
});

test('randomized small minor projections match a brute-force oracle at the byte boundary', () => {
  let randomState = 0x54c0de;
  const random = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState;
  };
  for (let example = 0; example < 5; example += 1) {
    const count = 3 + (random() % 4);
    const groundedMechanisms = Array.from({ length: count }, (_, index) => `r${example}-${index}`);
    const sourceCriteria = groundedMechanisms.map((_, index) => ({
      id: `s${example}-${index}`,
      text: 'x',
    }));
    const invariants = groundedMechanisms.map((_, index) => ({
      id: `i${example}-${index}`,
      text: 'x',
    }));
    const groundedMappings = groundedMechanisms.map((mechanism, index) => ({
      mechanism,
      sourceCriterionIds: random() % 2 === 0 ? [sourceCriteria[index].id] : [],
      acceptedCriterionIds: [],
      invariantIds: random() % 2 === 0 ? [invariants[index].id] : [],
      nonGoalIds: [],
      guidanceIds: [],
      rationale: 'x',
    }));
    if (groundedMappings.every(({ sourceCriterionIds, invariantIds }) => (
      sourceCriterionIds.length === 0 && invariantIds.length === 0
    ))) groundedMappings[0].sourceCriterionIds = [sourceCriteria[0].id];
    const fillerCount = 90;
    const buildInput = (fillerLength, identityBytes = 1) => {
      const fillerMappings = Array.from({ length: fillerCount }, (_, index) => ({
        mechanism: `f${example}-${index}-${'z'.repeat(fillerLength)}`,
        sourceCriterionIds: [],
        acceptedCriterionIds: [],
        invariantIds: [],
        nonGoalIds: [],
        guidanceIds: [],
        rationale: 'x',
      }));
      const mappings = [...groundedMappings, ...fillerMappings];
      return packet({
        binding: binding({
          source: { ...binding().source, identity: 'i'.repeat(identityBytes) },
          amendmentDigests: [],
        }),
        sourceScope: {
          objective: 'x',
          requiredCriteria: sourceCriteria,
          nonGoals: [],
          implementationGuidance: [],
        },
        acceptedScope: {
          criteria: [{ id: 'x', text: 'x' }],
          invariants,
          minimalClosure: 'x',
          authorizedShape: [],
          unauthorizedShape: mappings.filter((_, index) => index % 2 === 0)
            .map(({ mechanism }) => mechanism),
          deferredShape: mappings.filter((_, index) => index % 2 === 1)
            .map(({ mechanism }) => mechanism),
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
    };
    const bruteForceMinimum = (input) => {
      const fillerMappings = input.changeInventory.mappings.slice(groundedMappings.length);
      const fillerChoices = fillerMappings.map((mapping) => ({
        classification: 'speculative',
        coverage: { ...mapping, classification: 'speculative' },
      }));
      let oracle = null;
      const choices = [];
      const visit = (index) => {
        if (index === groundedMappings.length) {
          if (!choices.some(({ classification }) => (
            classification === 'necessary-minor-expansion'
          ))) return;
          const completeChoices = [...choices, ...fillerChoices];
          const necessary = completeChoices.filter(({ classification }) => (
            classification === 'necessary-minor-expansion'
          ));
          const speculative = completeChoices.filter(({ classification }) => (
            classification === 'speculative'
          ));
          const assessment = result('minor-amendment-required', {
            binding: input.binding,
            summary: 'x',
            coverage: completeChoices.map(({ coverage }) => coverage),
            unnecessaryWork: speculative.map(({ coverage }) => coverage.mechanism),
            smallerSufficientAlternative: speculative.length > 0 ? 'x' : null,
            scopeDelta: {
              description: 'x',
              sourceCriterionIds: [...new Set(necessary.flatMap(
                ({ coverage }) => coverage.sourceCriterionIds,
              ))],
              acceptedCriterionIds: [],
              invariantIds: [...new Set(necessary.flatMap(
                ({ coverage }) => coverage.invariantIds,
              ))],
              materialSurfaces: [],
            },
          });
          const bytes = Buffer.byteLength(JSON.stringify(assessment));
          if (!oracle || bytes < oracle.bytes) oracle = { assessment, bytes };
          return;
        }
        const mapping = groundedMappings[index];
        choices.push({
          classification: 'speculative',
          coverage: {
            ...mapping,
            sourceCriterionIds: [],
            invariantIds: [],
            classification: 'speculative',
          },
        });
        visit(index + 1);
        choices.pop();
        for (const [field, ids] of [
          ['sourceCriterionIds', mapping.sourceCriterionIds],
          ['invariantIds', mapping.invariantIds],
        ]) {
          for (const id of ids) {
            choices.push({
              classification: 'necessary-minor-expansion',
              coverage: {
                ...mapping,
                sourceCriterionIds: [],
                invariantIds: [],
                [field]: [id],
                classification: 'necessary-minor-expansion',
              },
            });
            visit(index + 1);
            choices.pop();
          }
        }
      };
      visit(0);
      return oracle;
    };
    let fillerLength = 40;
    let input = buildInput(fillerLength);
    let oracle = bruteForceMinimum(input);
    while (SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES - oracle.bytes > 511) {
      fillerLength += 1;
      input = buildInput(fillerLength);
      oracle = bruteForceMinimum(input);
    }
    const identityBytes = 1 + SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES - oracle.bytes;
    assert.ok(identityBytes >= 1 && identityBytes < 512, `example ${example}`);
    const at = buildInput(fillerLength, identityBytes);
    const over = buildInput(fillerLength, identityBytes + 1);
    const atOracle = bruteForceMinimum(at);
    assert.equal(atOracle.bytes, SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES, `example ${example}`);
    assert.deepEqual(validateScopeAssessmentApplicability(at, atOracle.assessment), []);
    assert.doesNotMatch(
      validateAssessmentPacket(at).join('\n'),
      /schema-minimal minor-amendment-required/u,
      `at ${example}`,
    );
    assert.match(
      validateAssessmentPacket(over).join('\n'),
      /schema-minimal minor-amendment-required result.*requires 32769 bytes/u,
      `over ${example}`,
    );
  }
});

test('minor representability bounds cyclic shared-authority search promptly', () => {
  const count = 100;
  const token = (index) => `t${String((index + count) % count).padStart(3, '0')}`;
  const mechanisms = Array.from(
    { length: count },
    (_, index) => `m${String(index).padStart(3, '0')}${'x'.repeat(140)}`,
  );
  const input = packet({
    binding: binding({
      source: { ...binding().source, identity: 'i'.repeat(512) },
      amendmentDigests: Array.from({ length: 128 }, () => `sha256:${D}`),
    }),
    sourceScope: {
      objective: 'x',
      requiredCriteria: Array.from({ length: count }, (_, index) => ({
        id: token(index),
        text: 'x',
      })),
      nonGoals: [],
      implementationGuidance: [],
    },
    acceptedScope: {
      criteria: [{ id: 'x', text: 'x' }],
      invariants: [],
      minimalClosure: 'x',
      authorizedShape: [],
      unauthorizedShape: mechanisms,
      deferredShape: [],
    },
    changeInventory: {
      summary: 'x',
      paths: [],
      dependencies: [],
      publicSurfaces: [],
      persistentSurfaces: [],
      subsystems: [],
      mappings: [
        ...mechanisms.map((mechanism, index) => ({
          mechanism,
          sourceCriterionIds: [token(index), token(index + 1), token(index + 7)],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          rationale: 'x',
        })),
        {
          mechanism: 'ordinary-anchor',
          sourceCriterionIds: [token(0)],
          acceptedCriterionIds: [],
          invariantIds: [],
          nonGoalIds: [],
          guidanceIds: [],
          rationale: 'x',
        },
      ],
    },
  });
  const startedAt = Date.now();
  const errors = validateAssessmentPacket(input);
  const elapsedMilliseconds = Date.now() - startedAt;

  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ASSESSMENT_PACKET_LIMIT_BYTES);
  const minorError = errors.find((error) => error.includes('minor-amendment-required'));
  if (minorError) assert.match(minorError, /certified lower bound/u);
  assert.ok(elapsedMilliseconds < 5000, `cyclic proof took ${elapsedMilliseconds}ms`);
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

test('mixed minor representability accounts for exact removal details at 32768 bytes', () => {
  let boundary = null;
  for (let count = 80; count <= 200 && boundary === null; count += 1) {
    const base = mixedMinorPacket(count, 1);
    const baseBytes = Buffer.byteLength(JSON.stringify(mixedMinorResult(base)));
    const identityBytes = 1 + SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES - baseBytes;
    if (identityBytes < 1 || identityBytes >= 512) continue;
    boundary = {
      at: mixedMinorPacket(count, identityBytes),
      over: mixedMinorPacket(count, identityBytes + 1),
    };
  }

  assert.ok(boundary, 'a mixed-minor one-byte boundary must be constructible');
  assert.equal(
    Buffer.byteLength(JSON.stringify(mixedMinorResult(boundary.at))),
    SCOPE_ASSESSMENT_RESULT_LIMIT_BYTES,
  );
  assert.deepEqual(validateAssessmentPacket(boundary.at), []);
  assert.match(
    validateAssessmentPacket(boundary.over).join('\n'),
    /schema-minimal minor-amendment-required result.*requires 32769 bytes/u,
  );
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

test('source-draft bindings reject every downstream artifact identity independently', () => {
  const draftBinding = binding({
    phase: 'source-draft',
    subject: { digest: `sha256:${B}`, sha: null },
    planDigest: null,
    amendmentDigests: [],
    taskPacketDigest: null,
  });
  const draftPacket = packet({
    binding: draftBinding,
    acceptedScope: null,
    changeInventory: {
      ...packet().changeInventory,
      subsystems: [],
      mappings: [{
        ...packet().changeInventory.mappings[0],
        acceptedCriterionIds: [],
        invariantIds: [],
      }],
    },
  });
  const draftResult = result('within-scope', {
    binding: draftBinding,
    coverage: [{
      ...result('within-scope').coverage[0],
      acceptedCriterionIds: [],
      invariantIds: [],
    }],
  });
  assert.deepEqual(validateAssessmentPacket(draftPacket), []);
  assert.deepEqual(validateScopeAssessmentResult(draftResult), []);
  assert.deepEqual(validateScopeAssessmentApplicability(draftPacket, draftResult), []);

  const staleBindings = [
    { ...draftBinding, planDigest: `sha256:${C}` },
    { ...draftBinding, amendmentDigests: [`sha256:${D}`] },
    { ...draftBinding, taskPacketDigest: `sha256:${A}` },
  ];
  for (const staleBinding of staleBindings) {
    const stalePacket = { ...draftPacket, binding: staleBinding };
    const staleResult = { ...draftResult, binding: staleBinding };
    assert.notDeepEqual(validateAssessmentPacket(stalePacket), []);
    assert.notDeepEqual(validateScopeAssessmentResult(staleResult), []);
    assert.notDeepEqual(validateScopeAssessmentApplicability(stalePacket, staleResult), []);
  }
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
