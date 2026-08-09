import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('root Docker builds exclude private local runtime data', () => {
  const patterns = new Set(
    readFileSync(join(repositoryRoot, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );

  for (const pattern of [
    '.env',
    '.env.*',
    '*.env',
    '*.env.*',
    '.demo-state',
    '.demo-backups',
    '*.backup',
    '*.dump',
    'postgres-data/',
  ]) {
    assert.ok(patterns.has(pattern), `missing private build-context exclusion: ${pattern}`);
  }
});
