import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const repositoryRoot = new URL('../', import.meta.url);
const readRepositoryFile = (path) => readFileSync(new URL(path, repositoryRoot), 'utf8');

test('development PostgreSQL is reachable only through a loopback override', () => {
  const productionCompose = readRepositoryFile('docker-compose.yml');
  const developmentCompose = readRepositoryFile('docker-compose.dev.yml');
  const apiConfig = readRepositoryFile('apps/api/src/config.ts');
  const productionDatabase = productionCompose.match(/  db:\n(?<service>[\s\S]*?)\n  app:/u)?.groups?.service;

  assert.ok(productionDatabase, 'production Compose must define the database before the app');
  assert.doesNotMatch(productionDatabase, /^    ports:/mu);
  assert.match(developmentCompose, /^      - "127\.0\.0\.1:5432:5432"$/mu);
  assert.match(apiConfig, /developmentDatabaseUrl = '[^']+@localhost:5432\/[^']+'/u);
});

test('local entrypoints start the reachable database before host-side commands', () => {
  const packageJson = JSON.parse(readRepositoryFile('package.json'));
  const justfile = readRepositoryFile('justfile');
  const readme = readRepositoryFile('README.md');

  assert.equal(
    packageJson.scripts['db:start:dev'],
    'docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait db',
  );
  assert.equal(justfile.match(/^    npm run db:start:dev$/gmu)?.length, 3);
  assert.match(readme, /^npm run db:start:dev$/mu);
});
