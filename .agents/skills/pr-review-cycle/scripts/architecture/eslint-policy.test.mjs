import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

import canonicalPolicy from '../../eslint.config.mjs';
import rootPolicy from '../../../../../eslint.config.mjs';

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

test('the root ESLint adapter re-exports the exact canonical policy', () => {
  assert.strictEqual(rootPolicy, canonicalPolicy);
});

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

test('static imports and re-exports cannot expose Node VM APIs', async () => {
  for (const modulePath of ['vm', 'node:vm']) {
    const sources = [
      `import '${modulePath}';\n`,
      `import vmApi from '${modulePath}';\nexport { vmApi };\n`,
      `import * as vmApi from '${modulePath}';\nexport { vmApi };\n`,
      `import { Script } from '${modulePath}';\nexport { Script };\n`,
      `export * from '${modulePath}';\n`,
      `export { Script } from '${modulePath}';\n`,
    ];
    for (const source of sources) {
      assert.equal((await lint(source))[0]?.ruleId, 'no-restricted-imports');
    }
  }
});

test('VM-like safe module specifiers remain available', async () => {
  assert.deepEqual(await lint([
    "import fs from 'node:fs';",
    "import localVm from './vm.mjs';",
    "import browserVm from 'vm-browserify';",
    "import scopedVm from '@scope/vm';",
    'export { fs, localVm, browserVm, scopedVm };',
  ].join('\n')), []);
});

test('dynamic code and hidden loader identifiers fail closed in dead or shadowed code', async () => {
  const cases = [
    "if (false) import('./hidden.mjs');\n",
    'function local(require) { return require; }\n',
    "globalThis.eval('hidden');\n",
    'function Function() {}\n',
    'const getBuiltinModule = null;\n',
    'const createRequire = null;\n',
  ];
  for (const source of cases) {
    assert.equal((await lint(source))[0]?.ruleId, 'no-restricted-syntax');
  }
});

test('computed access cannot reconstruct dynamic code or hidden module loaders', async () => {
  const cases = [
    "globalThis.process['getBuiltin' + 'Module']('node:module')['create' + 'Require'](import.meta.url);\n",
    "process['get' + 'BuiltinModule']('node:module');\n",
    "process?.[`get${'Builtin'}Module`]('node:module');\n",
    "globalThis.process?.['create' + `Require`](import.meta.url);\n",
    "module['re' + 'quire']('./hidden.mjs');\n",
    "value['e' + 'val']('hidden');\n",
    "value[`Func${'tion'}`]('hidden');\n",
    'process.argv[propertyName];\n',
    'globalThis?.[propertyName];\n',
    'module?.exports[propertyName];\n',
  ];
  for (const source of cases) {
    assert.equal(
      (await lint(source))[0]?.ruleId,
      'pr-review/computed-loader-access',
      source,
    );
  }
});

test('computed-key controls remain available outside privileged loader access', async () => {
  assert.deepEqual(await lint([
    "const expected = options['expected-revision'];",
    'const selected = value[field];',
    'const previous = historyIndexes[index - 1];',
    'const executable = process.argv[1];',
    'export { expected, selected, previous, executable };',
  ].join('\n')), []);
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

test('production modules named eslint.config.mjs remain inside production scope', async () => {
  const nestedConfig = join(dirname(productionProbe), 'eslint.config.mjs');
  assert.equal(
    (await lint('const require = null;\n', nestedConfig))[0]?.ruleId,
    'no-restricted-syntax',
  );
});

test('tests, fixtures, test-support, and canonical configuration remain outside production scope', async () => {
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
