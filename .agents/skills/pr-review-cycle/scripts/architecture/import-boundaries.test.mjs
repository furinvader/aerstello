import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatBoundaryDiagnostic, scanImportBoundaries } from './import-boundaries.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
const scan = (name, files) => scanImportBoundaries({ rootDirectory: join(fixtureRoot, name), files });

test('scanner accepts a resolved acyclic downward dependency', () => {
  assert.deepEqual(scan('valid', ['contracts/shape.mjs', 'state/service.mjs']), []);
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

test('scanner rejects dynamic loaders, own facades, reversed layers, and cycles', () => {
  assert.equal(scan('dynamic', ['github/loader.mjs'])[0].rule, 'hidden-module-loading');
  assert.equal(scan('create-require-alias', ['github/loader.mjs'])[0].rule, 'hidden-module-loading');
  assert.deepEqual(scan('create-require-text', ['github/loader.mjs']), []);
  assert.equal(scan('facade', ['state/owner.mjs', 'state/state.mjs'])[0].rule, 'own-facade-import');
  assert.equal(scan('layer', ['contracts/shape.mjs', 'state/service.mjs'])[0].rule, 'layer-direction');
  assert.equal(scan('cycle', ['github/one.mjs', 'github/two.mjs'])[0].rule, 'static-import-cycle');
});

test('scanner rejects unauthorized privileged facade symbols', () => {
  assert.equal(scanImportBoundaries({
    rootDirectory: join(fixtureRoot, 'facade'),
    files: ['state/owner.mjs', 'state/state.mjs'],
    privilegedFacadeExports: { load: [] },
  }).find(({ rule }) => rule === 'privileged-state-facade-consumer')?.rule,
  'privileged-state-facade-consumer');
});

test('scanner reports symlinks and other non-regular production entries', () => {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'aerstello-pr-review-architecture-'));
  try {
    mkdirSync(join(rootDirectory, 'state'));
    writeFileSync(join(rootDirectory, 'state', 'owner.mjs'), 'export const owner = true;\n');
    symlinkSync('owner.mjs', join(rootDirectory, 'state', 'alias.mjs'));
    assert.equal(
      scanImportBoundaries({ rootDirectory })[0].rule,
      'non-regular-canonical-entry',
    );
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('scanner rejects generic owner names and unauthorized protected-state consumers', () => {
  assert.equal(scan('generic', ['state/helpers.mjs'])[0].rule, 'generic-owner-name');
  assert.equal(scan('privileged', ['github/consumer.mjs', 'state/checkpoint.mjs'])[0].rule, 'privileged-state-consumer');
});
