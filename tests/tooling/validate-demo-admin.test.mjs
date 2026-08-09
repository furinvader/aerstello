import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const validator = join(repositoryRoot, 'scripts', 'validate-demo-admin.mjs');

const valid = [
  ['admin@example.com', 'Demo Administrator'],
  [' first.last+demo@example-host.test ', 'A'],
  ['ADMIN@EXAMPLE.COM', 'Demo Administrator'],
];

const invalid = [
  ['admin@example.1', 'Demo Administrator'],
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

function validate(email, name) {
  return spawnSync(process.execPath, [validator, '--email', email, '--name', name], {
    encoding: 'utf8',
  });
}

test('administrator deployment preflight accepts the login-valid corpus', () => {
  for (const [email, name] of valid) {
    const result = validate(email, name);
    assert.equal(result.status, 0, `${email} / ${name}: ${result.stderr}`);
  }
});

test('administrator deployment preflight rejects the login-invalid corpus', () => {
  for (const [email, name] of invalid) {
    const result = validate(email, name);
    assert.notEqual(result.status, 0, `${email} / ${name}`);
  }
});
