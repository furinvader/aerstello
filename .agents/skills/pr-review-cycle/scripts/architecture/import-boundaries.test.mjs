import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatBoundaryDiagnostic, scanImportBoundaries } from './import-boundaries.mjs';

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
