import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

const repositoryDirectory = fileURLToPath(new URL('../../../../..', import.meta.url));
const canonicalConfig = join(
  repositoryDirectory,
  '.agents/skills/pr-review-cycle/eslint.config.mjs',
);
const productionProbe = join(
  repositoryDirectory,
  '.agents/skills/pr-review-cycle/scripts/github/policy-probe.mjs',
);

const eslint = new ESLint({
  cwd: repositoryDirectory,
  overrideConfigFile: canonicalConfig,
  warnIgnored: false,
});

async function lint(source, filePath = productionProbe) {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages ?? [];
}

test('production PR-review modules satisfy the canonical source policy', async () => {
  const results = await eslint.lintFiles([
    '.agents/skills/pr-review-cycle/**/*.mjs',
  ]);
  assert.deepEqual(
    results.flatMap((result) => result.messages.map((message) => ({
      filePath: result.filePath,
      ruleId: message.ruleId,
      severity: message.severity,
    }))),
    [],
  );
});

test('static imports and re-exports cannot expose module or process APIs', async () => {
  const sources = [
    "import moduleApi from 'module';\nexport { moduleApi };\n",
    "export * from 'node:module';\n",
    "import processApi from 'process';\nexport { processApi };\n",
    "export { default as processApi } from 'node:process';\n",
  ];
  for (const source of sources) {
    assert.equal((await lint(source))[0]?.ruleId, 'no-restricted-imports');
  }
});

test('dynamic code and hidden loader identifiers fail closed in dead or shadowed code', async () => {
  const cases = [
    "if (false) import('./hidden.mjs');\n",
    'function local(require) { return require; }\n',
    "globalThis.eval('hidden');\n",
    'function Function() {}\n',
    'const getBuiltinModule = null;\n',
  ];
  for (const source of cases) {
    assert.equal((await lint(source))[0]?.ruleId, 'no-restricted-syntax');
  }
});

test('every static getBuiltinModule name is rejected without overmatching templates', async () => {
  for (const source of [
    "const value = 'getBuiltinModule';\n",
    'const value = `getBuiltinModule`;\n',
    "const value = { 'getBuiltinModule': true };\n",
  ]) {
    assert.equal((await lint(source))[0]?.ruleId, 'no-restricted-syntax');
  }

  assert.deepEqual(await lint([
    "const name = 'BuiltinModule';",
    'const interpolated = `get${name}`;',
    'const unrelated = `getBuiltinModules`;',
    'export { interpolated, unrelated };',
  ].join('\n')), []);
});

test('inline configuration cannot suppress the production policy', async () => {
  const messages = await lint([
    '/* eslint-disable no-restricted-syntax */',
    'const require = null;',
  ].join('\n'));
  assert.equal(messages.some(({ severity }) => severity === 1), true);
  assert.equal(messages.some(({ ruleId }) => ruleId === 'no-restricted-syntax'), true);
});

test('tests, fixtures, test-support, and configuration remain outside production scope', async () => {
  const excluded = [
    join(dirname(productionProbe), 'policy-probe.test.mjs'),
    join(dirname(productionProbe), 'fixtures/policy-probe.mjs'),
    join(dirname(productionProbe), 'test-support/policy-probe.mjs'),
    canonicalConfig,
    join(repositoryDirectory, 'eslint.config.mjs'),
  ];
  for (const filePath of excluded) {
    assert.deepEqual(await lint('const require = null;\n', filePath), []);
  }
});
