import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatBoundaryDiagnostic,
  scanImportBoundaries,
  scanInboundCapabilityImports,
} from './import-boundaries.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
const scan = (name, files) => scanImportBoundaries({ rootDirectory: join(fixtureRoot, name), files });

function withSources(sources, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'aerstello-pr-review-architecture-'));
  try {
    for (const [path, source] of Object.entries(sources)) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('scanner accepts clean acyclic production modules', () => {
  assert.deepEqual(scan('valid', ['contracts/shape.mjs', 'state/service.mjs']), []);
});

test('scanner rejects escaped relative imports unless the resolved dependency is permitted', () => {
  withSources({
    'neighbor/private.mjs': 'export const privateValue = true;\n',
    'scripts/state/allowed.mjs': "import { shared } from '../../shared/neutral.mjs';\nexport { shared };\n",
    'scripts/state/rejected.mjs': "import { privateValue } from '../../neighbor/private.mjs';\nexport { privateValue };\n",
    'shared/neutral.mjs': 'export const shared = true;\n',
  }, (directory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory: join(directory, 'scripts'),
      files: ['state/allowed.mjs', 'state/rejected.mjs'],
      permittedNeutralDependencies: [join(directory, 'shared/neutral.mjs')],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [{
      rule: 'escaped-capability-import', importer: 'state/rejected.mjs', target: '../neighbor/private.mjs',
    }]);
  });
});

test('scanner rejects absolute filesystem paths and file URLs in static module declarations', () => {
  withSources({
    'github/file-url.mjs': "export * as state from 'FiLe:///private/state.mjs';\n",
    'github/posix.mjs': "import '/proc/self/cwd/private/state.mjs';\n",
    'github/unc.mjs': String.raw`export * from '\\\\server\\share\\state.mjs';`,
    'github/windows-drive.mjs': String.raw`export { state } from 'C:\\private\\state.mjs';`,
    'github/windows-rooted.mjs': String.raw`export { state as default } from '\\private\\state.mjs';`,
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory,
      files: [
        'github/file-url.mjs',
        'github/posix.mjs',
        'github/unc.mjs',
        'github/windows-drive.mjs',
        'github/windows-rooted.mjs',
      ],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      { rule: 'absolute-filesystem-import', importer: 'github/file-url.mjs', target: 'FiLe:///private/state.mjs' },
      { rule: 'absolute-filesystem-import', importer: 'github/posix.mjs', target: '/proc/self/cwd/private/state.mjs' },
      { rule: 'absolute-filesystem-import', importer: 'github/unc.mjs', target: String.raw`\\server\share\state.mjs` },
      { rule: 'absolute-filesystem-import', importer: 'github/windows-drive.mjs', target: String.raw`C:\private\state.mjs` },
      { rule: 'absolute-filesystem-import', importer: 'github/windows-rooted.mjs', target: String.raw`\private\state.mjs` },
    ]);
  });
});

test('scanner rejects executable data URLs in static module declarations', () => {
  withSources({
    'github/import.mjs': "import 'data:text/javascript,export%20default%201';\n",
    'github/named-export.mjs': "export { default as value } from 'DaTa:application/javascript,export%20default%202';\n",
    'github/namespace-export.mjs': "export * as inline from 'DATA:text/ecmascript;base64,ZXhwb3J0IGRlZmF1bHQgMzs=';\n",
    'github/wildcard-export.mjs': "export * from 'data:application/javascript;charset=utf-8;base64,ZXhwb3J0IGNvbnN0IHZhbHVlID0gNDs=';\n",
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory,
      files: [
        'github/import.mjs',
        'github/named-export.mjs',
        'github/namespace-export.mjs',
        'github/wildcard-export.mjs',
      ],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      {
        rule: 'inline-data-import',
        importer: 'github/import.mjs',
        target: 'data:text/javascript,export%20default%201',
      },
      {
        rule: 'inline-data-import',
        importer: 'github/named-export.mjs',
        target: 'DaTa:application/javascript,export%20default%202',
      },
      {
        rule: 'inline-data-import',
        importer: 'github/namespace-export.mjs',
        target: 'DATA:text/ecmascript;base64,ZXhwb3J0IGRlZmF1bHQgMzs=',
      },
      {
        rule: 'inline-data-import',
        importer: 'github/wildcard-export.mjs',
        target: 'data:application/javascript;charset=utf-8;base64,ZXhwb3J0IGNvbnN0IHZhbHVlID0gNDs=',
      },
    ]);
  });
});

test('scanner rejects package import aliases across static module declarations', () => {
  withSources({
    'github/import.mjs': "import '#state';\n",
    'github/named-export.mjs': "export { state } from '#state/named';\n",
    'github/namespace-export.mjs': "export * as state from '#state/namespace';\n",
    'github/wildcard-export.mjs': "export * from '#state/wildcard';\n",
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory,
      files: [
        'github/import.mjs',
        'github/named-export.mjs',
        'github/namespace-export.mjs',
        'github/wildcard-export.mjs',
      ],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      { rule: 'package-import-alias', importer: 'github/import.mjs', target: '#state' },
      { rule: 'package-import-alias', importer: 'github/named-export.mjs', target: '#state/named' },
      { rule: 'package-import-alias', importer: 'github/namespace-export.mjs', target: '#state/namespace' },
      { rule: 'package-import-alias', importer: 'github/wildcard-export.mjs', target: '#state/wildcard' },
    ]);
  });
});

test('scanner keeps packages, built-ins, and unrelated schemes external', () => {
  withSources({
    'github/packages.mjs': [
      "import 'node:fs';",
      "export { version } from 'typescript';",
      "export * from '@scope/package/subpath';",
      "export * from 'custom:package';",
    ].join('\n'),
  }, (rootDirectory) => {
    assert.deepEqual(scanImportBoundaries({
      rootDirectory,
      files: ['github/packages.mjs'],
    }), []);
  });
});

test('scanner reports alternate production source extensions while retaining exclusions', () => {
  withSources({
    'fixtures/fixture.js': 'export const ignoredFixture = true;\n',
    'github/owner.cjs': 'module.exports = {};\n',
    'github/owner.cts': 'export const owner = true;\n',
    'github/owner.js': 'export const owner = true;\n',
    'github/owner.mjs': 'export const owner = true;\n',
    'github/owner.mts': 'export const owner = true;\n',
    'github/owner.test.cjs': 'module.exports = {};\n',
    'github/owner.test.cts': 'export const owner = true;\n',
    'github/owner.test.js': 'export const owner = true;\n',
    'github/owner.test.mjs': 'export const owner = true;\n',
    'github/owner.test.mts': 'export const owner = true;\n',
    'github/owner.test.ts': 'export const owner = true;\n',
    'github/owner.ts': 'export const owner = true;\n',
    'test-support/support.ts': 'export const ignoredSupport = true;\n',
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({ rootDirectory });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      {
        rule: 'unsupported-production-source-extension',
        importer: 'github/owner.cjs',
        target: 'github/owner.cjs',
      },
      {
        rule: 'unsupported-production-source-extension',
        importer: 'github/owner.cts',
        target: 'github/owner.cts',
      },
      {
        rule: 'unsupported-production-source-extension',
        importer: 'github/owner.js',
        target: 'github/owner.js',
      },
      {
        rule: 'unsupported-production-source-extension',
        importer: 'github/owner.mts',
        target: 'github/owner.mts',
      },
      {
        rule: 'unsupported-production-source-extension',
        importer: 'github/owner.ts',
        target: 'github/owner.ts',
      },
    ]);
  });
});

test('scanner reports malformed and unresolved imports with actionable locations', () => {
  const malformed = scan('malformed', ['state/broken.mjs']);
  assert.equal(malformed[0].rule, 'syntax');
  assert.match(formatBoundaryDiagnostic(malformed[0]), /^\[syntax\] state\/broken\.mjs:\d+:\d+ -> state\/broken\.mjs:/u);
  const unresolved = scan('unresolved', ['state/service.mjs']);
  assert.deepEqual(unresolved.map(({ rule, importer, target }) => ({ rule, importer, target })), [{
    rule: 'unresolved-internal-import', importer: 'state/service.mjs', target: 'state/missing.mjs',
  }]);
});

test('scanner enforces facades, layer direction, and cycles without loader interpretation', () => {
  assert.deepEqual(scan('dynamic', ['github/loader.mjs']), []);
  assert.deepEqual(scan('create-require-alias', ['github/loader.mjs']), []);
  assert.equal(scan('facade', ['state/owner.mjs', 'state/state.mjs'])[0].rule, 'own-facade-import');
  assert.equal(scan('layer', ['contracts/shape.mjs', 'state/service.mjs'])[0].rule, 'layer-direction');
  assert.equal(scan('cycle', ['github/one.mjs', 'github/two.mjs'])[0].rule, 'static-import-cycle');
});

test('scanner rejects privileged facade named, namespace, and wildcard access', () => {
  withSources({
    'github/named.mjs': "import { atomicWriteJson } from '../state/state.mjs';\nexport { atomicWriteJson };\n",
    'github/namespace.mjs': "import * as state from '../state/state.mjs';\nexport const write = state.atomicWriteJson;\n",
    'github/wildcard.mjs': "export * from '../state/state.mjs';\n",
    'state/state.mjs': 'export function atomicWriteJson() {}\n',
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory,
      files: ['github/named.mjs', 'github/namespace.mjs', 'github/wildcard.mjs', 'state/state.mjs'],
      privilegedFacadeExports: { atomicWriteJson: [] },
    });
    assert.deepEqual(diagnostics.map(({ rule, importer }) => ({ rule, importer })), [
      { rule: 'privileged-state-facade-consumer', importer: 'github/named.mjs' },
      { rule: 'privileged-state-facade-consumer', importer: 'github/namespace.mjs' },
      { rule: 'privileged-state-facade-consumer', importer: 'github/wildcard.mjs' },
    ]);
  });
});

test('scanner allows public facades and rejects cross-layer private implementations', () => {
  withSources({
    'github/private-consumer.mjs': "import { checkpoint } from '../state/checkpoint.mjs';\nexport { checkpoint };\n",
    'github/public-consumer.mjs': "import { loadState } from '../state/state.mjs';\nexport { loadState };\n",
    'state/checkpoint.mjs': 'export function checkpoint() {}\n',
    'state/state.mjs': 'export function loadState() {}\n',
  }, (rootDirectory) => {
    const diagnostics = scanImportBoundaries({
      rootDirectory,
      files: ['github/private-consumer.mjs', 'github/public-consumer.mjs', 'state/checkpoint.mjs', 'state/state.mjs'],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      { rule: 'private-layer-import', importer: 'github/private-consumer.mjs', target: 'state/checkpoint.mjs' },
      { rule: 'privileged-state-consumer', importer: 'github/private-consumer.mjs', target: 'state/checkpoint.mjs' },
    ]);
  });
});

test('scanner reports symlinks and other non-regular production entries', () => {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'aerstello-pr-review-architecture-'));
  try {
    mkdirSync(join(rootDirectory, 'state'));
    writeFileSync(join(rootDirectory, 'state', 'owner.mjs'), 'export const owner = true;\n');
    symlinkSync('owner.mjs', join(rootDirectory, 'state', 'alias.mjs'));
    assert.equal(scanImportBoundaries({ rootDirectory })[0].rule, 'non-regular-canonical-entry');
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('scanner rejects generic owner names and unauthorized protected-state consumers', () => {
  assert.equal(scan('generic', ['state/helpers.mjs'])[0].rule, 'generic-owner-name');
  assert.equal(
    scan('privileged', ['github/consumer.mjs', 'state/checkpoint.mjs'])
      .find(({ rule }) => rule === 'privileged-state-consumer')?.rule,
    'privileged-state-consumer',
  );
});

test('inbound scanner rejects undeclared repository imports into the protected capability', () => {
  withSources({
    '.agents/skills/other/scripts/sibling.mts': "export * from '../../pr-review-cycle/scripts/state/checkpoint.mjs';\n",
    '.agents/skills/other/scripts/sibling.test.ts': "export * from '../../pr-review-cycle/scripts/state/checkpoint.mjs';\n",
    '.agents/skills/pr-review-cycle/scripts/internal.mjs': "import './state/checkpoint.mjs';\n",
    'scripts/nested/consumer.test.mjs': "import '../../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs';\n",
    'scripts/nested/consumer.tsx': "import '../../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs';\n",
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: [
        '.agents/skills/other/scripts/sibling.mts',
        '.agents/skills/other/scripts/sibling.test.ts',
        '.agents/skills/pr-review-cycle/scripts/internal.mjs',
        'scripts/nested/consumer.test.mjs',
        'scripts/nested/consumer.tsx',
      ],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      {
        rule: 'undeclared-capability-import',
        importer: '.agents/skills/other/scripts/sibling.mts',
        target: '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      },
      {
        rule: 'undeclared-capability-import',
        importer: '.agents/skills/other/scripts/sibling.test.ts',
        target: '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      },
      {
        rule: 'undeclared-capability-import',
        importer: 'scripts/nested/consumer.test.mjs',
        target: '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      },
      {
        rule: 'undeclared-capability-import',
        importer: 'scripts/nested/consumer.tsx',
        target: '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      },
    ]);
  });
});

test('inbound scanner permits exact adapters and ignores unrelated static edges', () => {
  withSources({
    'eslint.config.mjs': "export { default } from './.agents/skills/pr-review-cycle/eslint.config.mjs';\n",
    'scripts/consumer.cjs': [
      "import 'node:fs';",
      "export * from '@scope/package';",
      "export * from './local.cjs';",
    ].join('\n'),
    'scripts/ignored.json': 'not JavaScript',
    'scripts/local.cjs': 'module.exports = {};\n',
  }, (repositoryDirectory) => {
    assert.deepEqual(scanInboundCapabilityImports({
      repositoryDirectory,
      files: [
        'eslint.config.mjs',
        'scripts/consumer.cjs',
        'scripts/ignored.json',
        'scripts/local.cjs',
      ],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [{ path: 'eslint.config.mjs', targets: ['eslint.config.mjs'] }],
    }), []);
  });
});

test('inbound scanner fails closed on opaque outside package import aliases', () => {
  withSources({
    'scripts/import.cts': "import '#private/import';\n",
    'scripts/re-export.js': "export * from '#private/export';\n",
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/import.cts', 'scripts/re-export.js'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer, target }) => ({ rule, importer, target })), [
      {
        rule: 'opaque-package-import-alias',
        importer: 'scripts/import.cts',
        target: '#private/import',
      },
      {
        rule: 'opaque-package-import-alias',
        importer: 'scripts/re-export.js',
        target: '#private/export',
      },
    ]);
  });
});

test('inbound scanner rejects literal dynamic imports at any AST depth', () => {
  withSources({
    'scripts/consumer.mjs': [
      "await import('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      'async function nested() {',
      '  return import(`../.agents/skills/pr-review-cycle/scripts/github/github.mjs`);',
      '}',
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/consumer.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics.map(({ rule, target }) => ({ rule, target })), [
      {
        rule: 'undeclared-capability-import',
        target: '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      },
      {
        rule: 'undeclared-capability-import',
        target: '.agents/skills/pr-review-cycle/scripts/github/github.mjs',
      },
    ]);
  });
});

test('inbound scanner rejects direct CommonJS loader spellings and import-equals', () => {
  withSources({
    'scripts/commonjs.cts': [
      "require('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      "require?.(`../.agents/skills/pr-review-cycle/scripts/state/state.mjs`);",
      "module.require('../.agents/skills/pr-review-cycle/scripts/github/github.mjs');",
      "module?.require?.('../.agents/skills/pr-review-cycle/scripts/contracts/contracts.mjs');",
      "module['require']('../.agents/skills/pr-review-cycle/scripts/worktree/worktree.mjs');",
      "module?.['require']?.(`../.agents/skills/pr-review-cycle/scripts/paths.mjs`);",
      "import state = require('../.agents/skills/pr-review-cycle/scripts/state/state.mjs');",
      'import github = require(`../.agents/skills/pr-review-cycle/scripts/github/github.mjs`);',
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/commonjs.cts'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 8);
    assert.ok(diagnostics.every(({ rule }) => rule === 'undeclared-capability-import'));
  });
});

test('inbound scanner applies aliases and exact adapters to executable literal edges', () => {
  withSources({
    'scripts/adapter.mjs': "await import('../.agents/skills/pr-review-cycle/eslint.config.mjs');\n",
    'scripts/aliases.ts': [
      "import('#dynamic');",
      "require(`#require`);",
      "module.require('#module');",
      "import state = require('#equals');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/adapter.mjs', 'scripts/aliases.ts'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [{ path: 'scripts/adapter.mjs', targets: ['eslint.config.mjs'] }],
    });
    assert.deepEqual(diagnostics.map(({ rule, target }) => ({ rule, target })), [
      { rule: 'opaque-package-import-alias', target: '#dynamic' },
      { rule: 'opaque-package-import-alias', target: '#require' },
      { rule: 'opaque-package-import-alias', target: '#module' },
      { rule: 'opaque-package-import-alias', target: '#equals' },
    ]);
  });
});

test('inbound scanner ignores unrelated and non-direct executable load forms', () => {
  withSources({
    'scripts/controls.cjs': [
      "import('node:fs');",
      "require('@scope/package');",
      "module.require('./local.cjs');",
      "loader('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
    ].join('\n'),
    'scripts/local.cjs': 'module.exports = {};\n',
  }, (repositoryDirectory) => {
    assert.deepEqual(scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/controls.cjs', 'scripts/local.cjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    }), []);
  });
});

test('inbound scanner rejects non-regular repository entries before filtering or reading', () => {
  const repositoryDirectory = mkdtempSync(join(tmpdir(), 'aerstello-pr-review-inbound-'));
  try {
    mkdirSync(join(repositoryDirectory, '.agents/skills/pr-review-cycle/scripts/state'), { recursive: true });
    mkdirSync(join(repositoryDirectory, 'scripts/directory'), { recursive: true });
    writeFileSync(
      join(repositoryDirectory, '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs'),
      'export const checkpoint = true;\n',
    );
    symlinkSync(
      '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      join(repositoryDirectory, 'source-link'),
    );
    symlinkSync(
      '.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs',
      join(repositoryDirectory, 'source-link.mjs'),
    );
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/directory', 'source-link', 'source-link.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer }) => ({ rule, importer })), [
      { rule: 'non-regular-repository-entry', importer: 'scripts/directory' },
      { rule: 'non-regular-repository-entry', importer: 'source-link' },
      { rule: 'non-regular-repository-entry', importer: 'source-link.mjs' },
    ]);
  } finally {
    rmSync(repositoryDirectory, { recursive: true, force: true });
  }
});

test('inbound scanner accepts the five canonical change-development createRequire shapes', () => {
  const canonicalSource = [
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    "const Ajv2020 = require('ajv/dist/2020').default;",
    "const addFormats = require(`ajv-formats`).default;",
  ].join('\n');
  const files = [
    '.agents/skills/change-development/scripts/contracts/contracts.mjs',
    '.agents/skills/change-development/scripts/contracts/contracts.test.mjs',
    '.agents/skills/change-development/scripts/implementation/contracts.mjs',
    '.agents/skills/change-development/scripts/implementation/contracts.test.mjs',
    '.agents/skills/change-development/scripts/verification/contracts.mjs',
  ];
  withSources(Object.fromEntries(files.map((path) => [path, canonicalSource])), (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files,
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics, []);
  });
});

test('inbound scanner rejects escaped loader acquisition and helper source shapes', () => {
  withSources({
    'scripts/loaders.mjs': [
      "import { createRequire as buildRequire } from 'node:module';",
      "import * as ModuleApi from 'node:module';",
      "import ModuleDefault from 'module';",
      "import { createRequire } from 'node:module';",
      'const load = createRequire(import.meta.url);',
      "load('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      'const copiedRequire = require;',
      'const copiedModuleRequire = module.require;',
      'const copiedCreateRequire = createRequire;',
      'const copiedResolve = require.resolve;',
      'const copiedBuiltin = process.getBuiltinModule;',
      'const copiedLoad = ModuleApi._load;',
      "const { createRequire: commonJsCreateRequire } = require('node:module');",
      "require.resolve('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      "module.require.call(null, '../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      "module['require'].bind(module, '../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      "require['resolve']('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
      "module.require['apply'](module, ['../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs']);",
      "process.getBuiltinModule('module');",
      "ModuleApi._load('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/loaders.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 19);
    assert.ok(diagnostics.every(({ rule }) => rule === 'unsupported-module-loader-shape'));
  });
});

test('inbound scanner rejects opaque and unsafe direct executable specifiers', () => {
  withSources({
    'scripts/opaque.cts': [
      'import(path);',
      'require(path);',
      'module.require(path);',
      'import state = require(path);',
      'module[\'require\'](`../.agents/skills/pr-review-cycle/${path}.mjs`);',
    ].join('\n'),
    'scripts/unsafe.cts': [
      "import('/private/checkpoint.mjs');",
      "require('FiLe:///private/checkpoint.mjs');",
      "module.require('DATA:text/javascript,export%20default%201');",
      String.raw`import state = require('C:\\private\\checkpoint.mjs');`,
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/opaque.cts', 'scripts/unsafe.cts'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual([...new Set(diagnostics.map(({ rule }) => rule))], [
      'absolute-filesystem-import',
      'inline-data-import',
      'opaque-executable-module-specifier',
    ]);
    assert.equal(diagnostics.filter(({ rule }) => rule === 'absolute-filesystem-import').length, 3);
    assert.equal(diagnostics.filter(({ rule }) => rule === 'inline-data-import').length, 1);
    assert.equal(diagnostics.filter(({ rule }) => rule === 'opaque-executable-module-specifier').length, 5);
  });
});

test('inbound scanner rejects createRequire acquired through executable module APIs', () => {
  withSources({
    'scripts/dynamic-api.mjs': [
      "const { createRequire } = await import('node:module');",
      'const load = createRequire(import.meta.url);',
      "load('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/dynamic-api.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 3);
    assert.ok(diagnostics.every(({ rule }) => rule === 'unsupported-module-loader-shape'));
  });
});

test('inbound scanner rejects createRequire re-exports and aliased local imports', () => {
  withSources({
    'scripts/bridge.mjs': "export { createRequire } from 'node:module';\n",
    'scripts/consumer.mjs': [
      "import { createRequire as makeLoader } from './bridge.mjs';",
      'const load = makeLoader(import.meta.url);',
      "load('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/bridge.mjs', 'scripts/consumer.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.deepEqual(diagnostics.map(({ rule, importer }) => ({ rule, importer })), [
      { rule: 'unsupported-module-loader-shape', importer: 'scripts/bridge.mjs' },
      { rule: 'unsupported-module-loader-shape', importer: 'scripts/consumer.mjs' },
    ]);
  });
});

test('inbound scanner rejects loader references passed or exposed as values', () => {
  withSources({
    'scripts/exposures.mjs': [
      'forward(module.require);',
      'forward(require);',
      'forward(createRequire);',
      'const exposed = { createRequire };',
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/exposures.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 4);
    assert.ok(diagnostics.every(({ rule }) => rule === 'unsupported-module-loader-shape'));
  });
});

test('inbound scanner rejects direct executable access to Node module loader APIs', () => {
  withSources({
    'scripts/module-api.cts': [
      "export default import('node:module');",
      "require('node:module');",
      "module.require('module');",
      "import moduleApi = require('node:module');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/module-api.cts'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 4);
    assert.ok(diagnostics.every(({ rule }) => rule === 'unsupported-module-loader-shape'));
  });
});

test('inbound scanner reserves loader capabilities in import, export, and binding elements', () => {
  withSources({
    'scripts/bridge.mjs': 'export const value = true;\n',
    'scripts/elements.mjs': [
      "import { require as importedRequire } from './bridge.mjs';",
      "import { getBuiltinModule } from 'node:module';",
      "export { _load } from './bridge.mjs';",
      'const { require: load } = module;',
      "load('../.agents/skills/pr-review-cycle/scripts/state/checkpoint.mjs');",
    ].join('\n'),
  }, (repositoryDirectory) => {
    const diagnostics = scanInboundCapabilityImports({
      repositoryDirectory,
      files: ['scripts/bridge.mjs', 'scripts/elements.mjs'],
      capabilityRoot: '.agents/skills/pr-review-cycle',
      permittedExternalAdapters: [],
    });
    assert.equal(diagnostics.length, 4);
    assert.ok(diagnostics.every(({ rule }) => rule === 'unsupported-module-loader-shape'));
  });
});
