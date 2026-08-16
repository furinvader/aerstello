import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { checkE2EStructure, inspectE2EStructure } from './check-e2e-structure.mjs';

const VALID_CONFIG = `
import { defineBddConfig } from 'playwright-bdd';
const testDir = defineBddConfig({
  features: 'specs/features/**/*.feature',
  steps: ['tests/e2e/fixtures/test.ts', 'tests/e2e/**/*.steps.ts'],
});
export default { testDir };
`;
const VALID_FIXTURE = `
import { test as base } from 'playwright-bdd';
export const test = base.extend<{ answer: number }>({ answer: async ({}, use) => use(42) });
`;
const VALID_STEPS = `
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
const { Given, When, Then } = createBdd(test);
Given('a valid step', async ({ answer }) => answer);
`;

function write(root, path, source) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aerstello-e2e-structure-'));
  write(root, 'playwright.config.ts', VALID_CONFIG);
  write(root, 'tests/e2e/fixtures/test.ts', VALID_FIXTURE);
  write(root, 'tests/e2e/capabilities/authentication.steps.ts', VALID_STEPS);
  return root;
}

function withFixture(run) {
  const root = fixture();
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('accepts canonical discovery, fixture extension, and isolated step modules', () => {
  withFixture((root) => {
    assert.deepEqual(inspectE2EStructure(root), []);
    assert.doesNotThrow(() => checkE2EStructure(root));
  });
});

test('requires exact ordered feature and step discovery configuration', () => {
  const invalidConfigs = [
    VALID_CONFIG.replace("features: 'specs/features/**/*.feature'", "features: ['specs/features/**/*.feature']"),
    VALID_CONFIG.replace(
      "['tests/e2e/fixtures/test.ts', 'tests/e2e/**/*.steps.ts']",
      "['tests/e2e/**/*.steps.ts', 'tests/e2e/fixtures/test.ts']",
    ),
    VALID_CONFIG.replace("'tests/e2e/**/*.steps.ts'", "'tests/e2e/steps/**/*.ts'"),
  ];
  for (const config of invalidConfigs) {
    withFixture((root) => {
      write(root, 'playwright.config.ts', config);
      assert.match(checkFailure(root), /defineBddConfig\.(?:features|steps)/u);
    });
  }
});

test('rejects the monolith and registrations outside *.steps.ts files', () => {
  withFixture((root) => {
    write(root, 'tests/e2e/steps/app.steps.ts', VALID_STEPS);
    write(root, 'tests/e2e/support/register.ts', `
      import { createBdd } from 'playwright-bdd';
      createBdd();
      Given('hidden registration', () => {});
    `);
    const failure = checkFailure(root);
    assert.match(failure, /app\.steps\.ts is forbidden/u);
    assert.match(failure, /registers BDD steps outside/u);
  });
});

test('requires each step module to use the canonical unaliased test and createBdd(test)', () => {
  const invalidSteps = [
    VALID_STEPS.replace("import { test } from '../fixtures/test';", "import { test as e2eTest } from '../fixtures/test';")
      .replace('createBdd(test)', 'createBdd(e2eTest)'),
    VALID_STEPS.replace("from '../fixtures/test'", "from '../fixtures/not-test'"),
    VALID_STEPS.replace('createBdd(test)', 'createBdd()'),
    VALID_STEPS.replace('createBdd(test)', 'createBdd(test, {})'),
    VALID_STEPS.replace("import { createBdd }", "import { createBdd as makeBdd }")
      .replace('createBdd(test)', 'makeBdd(test)'),
    VALID_STEPS.replace(
      "import { createBdd } from 'playwright-bdd';",
      "import { createBdd, test as packageTest } from 'playwright-bdd';",
    ),
    `${VALID_STEPS}\nimport { test as playwrightTest } from '@playwright/test';`,
  ];
  for (const steps of invalidSteps) {
    withFixture((root) => {
      write(root, 'tests/e2e/capabilities/authentication.steps.ts', steps);
      assert.match(checkFailure(root), /must/u);
    });
  }
});

test('requires at least one capability registration module', () => {
  withFixture((root) => {
    rmSync(join(root, 'tests/e2e/capabilities/authentication.steps.ts'));
    assert.match(checkFailure(root), /at least one \*\.steps\.ts/u);
  });
});

test('requires the canonical fixture test to extend playwright-bdd test', () => {
  const invalidFixtures = [
    `export const test = {};`,
    `import { test as base } from '@playwright/test'; export const test = base.extend({});`,
    `import { test as base } from 'playwright-bdd'; export const test = base;`,
  ];
  for (const source of invalidFixtures) {
    withFixture((root) => {
      write(root, 'tests/e2e/fixtures/test.ts', source);
      assert.match(checkFailure(root), /must export const test/u);
    });
  }
});

test('rejects top-level mutable step state and exported mutable E2E singletons', () => {
  const invalidDeclarations = [
    'let currentGuest;',
    'var retryCount = 0;',
    'const values = [];',
    'const value = {};',
    'const values = new Map();',
    'const values = new Set<string>();',
    'export const shared = [] as string[];',
  ];
  for (const declaration of invalidDeclarations) {
    withFixture((root) => {
      write(root, 'tests/e2e/capabilities/authentication.steps.ts', `${VALID_STEPS}\n${declaration}`);
      assert.match(checkFailure(root), /mutable/u);
    });
  }

  withFixture((root) => {
    write(root, 'tests/e2e/support/shared.ts', 'export let sharedStatus = 0;');
    assert.match(checkFailure(root), /exports mutable E2E state/u);
  });
  withFixture((root) => {
    write(root, 'tests/e2e/support/shared.ts', 'const sharedStatuses = []; export { sharedStatuses };');
    assert.match(checkFailure(root), /exports mutable E2E state/u);
  });
  withFixture((root) => {
    write(root, 'tests/e2e/support/shared.ts', 'export const sharedStatuses = new URLSearchParams();');
    assert.match(checkFailure(root), /exports mutable E2E state/u);
  });
});

test('allows immutable module constants and function-local mutable state', () => {
  withFixture((root) => {
    write(root, 'tests/e2e/capabilities/authentication.steps.ts', `${VALID_STEPS}
      const timeoutMs = 1_000;
      const label = 'stable';
      function localState() { let attempt = 0; const values = []; return { attempt, values }; }
    `);
    assert.deepEqual(inspectE2EStructure(root), []);
  });
});

function checkFailure(root) {
  try {
    checkE2EStructure(root);
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail('expected the E2E structure check to fail');
}
