import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const valid = [
  ['admin@example.com', 'Demo Administrator'],
  [' first.last+demo@example-host.test ', 'A'],
  ['ADMIN@EXAMPLE.COM', 'Demo Administrator'],
];

const invalid = [
  ['admin@example.1', 'Demo Administrator'],
  ['admin@example.c', 'Demo Administrator'],
  ['a..b@example.com', 'Demo Administrator'],
  ['.admin@example.com', 'Demo Administrator'],
  ['admin.@example.com', 'Demo Administrator'],
  ['admin@-example.com', 'Demo Administrator'],
  ['admin@example', 'Demo Administrator'],
  ['admin @example.com', 'Demo Administrator'],
  [`${'a'.repeat(244)}@example.com`, 'Demo Administrator'],
  ['admin@example.com', '   '],
  ['admin@example.com', 'x'.repeat(201)],
];

function validate(validator, email, name) {
  return spawnSync(process.execPath, [validator, '--email', email, '--name', name], {
    encoding: 'utf8',
  });
}

function hermeticValidator(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sky-bar-admin-validator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const relativeFiles = [
    'scripts/validate-demo-admin.mjs',
    'packages/shared/src/login-email-rules.json',
    'apps/api/src/admin-profile-rules.json',
  ];
  for (const relative of relativeFiles) {
    const destination = join(directory, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relative), destination);
  }
  return join(directory, 'scripts', 'validate-demo-admin.mjs');
}

test('administrator deployment preflight accepts the login-valid corpus without dependencies', (t) => {
  const validator = hermeticValidator(t);
  for (const [email, name] of valid) {
    const result = validate(validator, email, name);
    assert.equal(result.status, 0, `${email} / ${name}: ${result.stderr}`);
  }
});

test('administrator deployment preflight rejects the login-invalid corpus without dependencies', (t) => {
  const validator = hermeticValidator(t);
  for (const [email, name] of invalid) {
    const result = validate(validator, email, name);
    assert.notEqual(result.status, 0, `${email} / ${name}`);
  }
});
