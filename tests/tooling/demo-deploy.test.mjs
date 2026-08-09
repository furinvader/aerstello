import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gitSha = '0123456789abcdef0123456789abcdef01234567';
const project = 'sky-bar-demo';
const dbVolume = `${project}-postgres-data`;
const migrationPath = 'apps/api/migrations/0001_initial.sql';

const validEnvironment = {
  COMPOSE_PROJECT_NAME: project,
  SKY_BAR_DOMAIN: 'demo.example.test',
  ACME_EMAIL: 'ops@example.test',
  ADMIN_EMAIL: 'admin@example.test',
  ADMIN_NAME: 'Demo Administrator',
  POSTGRES_PASSWORD: 'a'.repeat(64),
  SESSION_SECRET: 'b'.repeat(64),
  ACCESS_CAPABILITY_KEYS: `v1:${'c'.repeat(64)}`,
  LOG_LEVEL: 'info',
  RATE_LIMIT_MAX: '300',
  ACCESS_STATUS_IP_LIMIT_MAX: '3000',
};

function shellEnvironment(values = validEnvironment) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function fakeExecutableSource() {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const safeConfigKeys = [
  'COMPOSE_PROJECT_NAME', 'SKY_BAR_DOMAIN', 'ACME_EMAIL', 'ADMIN_EMAIL', 'ADMIN_NAME',
  'LOG_LEVEL', 'RATE_LIMIT_MAX', 'ACCESS_STATUS_IP_LIMIT_MAX',
];
const secretConfigKeys = ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'ACCESS_CAPABILITY_KEYS'];
const record = {
  tool,
  args,
  safeConfig: Object.fromEntries(safeConfigKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])),
  secretHashes: Object.fromEntries(secretConfigKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, crypto.createHash('sha256').update(process.env[key]).digest('hex')])),
};
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(record) + '\n');
if (process.env.FAKE_FORBIDDEN_SECRET_FILE) {
  const forbidden = fs.readFileSync(process.env.FAKE_FORBIDDEN_SECRET_FILE, 'utf8').trim();
  const leaked = Object.entries(process.env).some(([key, value]) =>
    key !== 'FAKE_FORBIDDEN_SECRET_FILE' && value && value.includes(forbidden));
  if (leaked) {
    process.stderr.write('administrator password leaked through a child-process environment\n');
    process.exit(86);
  }
}
const joined = [tool, ...args].join(' ');
if (process.env.FAKE_FAIL_SCHEMA_QUERY_AT && joined.includes('SELECT name FROM schema_migrations')) {
  const counterPath = process.env.FAKE_COMMAND_LOG + '.schema-query-count';
  let count = 0;
  try { count = Number(fs.readFileSync(counterPath, 'utf8')); } catch {}
  count += 1;
  fs.writeFileSync(counterPath, String(count));
  if (count === Number(process.env.FAKE_FAIL_SCHEMA_QUERY_AT)) {
    process.stderr.write('injected schema_migrations query failure\n');
    process.exit(44);
  }
}
if (process.env.FAKE_FAIL_MATCH && joined.includes(process.env.FAKE_FAIL_MATCH)) {
  process.stderr.write('injected failure: ' + process.env.FAKE_FAIL_MATCH + '\n');
  process.exit(41);
}
if (tool === 'git') {
  if (args[0] === 'status' && process.env.FAKE_GIT_DIRTY === '1') process.stdout.write(' M dirty-file\n');
  else if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) process.stdout.write(process.env.FAKE_REPOSITORY_ROOT + '\n');
  else if (args[0] === 'rev-parse') process.stdout.write(process.env.FAKE_GIT_SHA + '\n');
  else if (args[0] === 'cat-file' && process.env.FAKE_GIT_SOURCE_MISSING === '1') process.exit(1);
  else if (args[0] === 'merge-base' && process.env.FAKE_GIT_SOURCE_ANCESTOR === '0') process.exit(1);
  else if (args[0] === 'ls-tree') {
    const sourceSha = args.find((arg) => /^[0-9a-f]{40,64}$/.test(arg)) || '';
    const configuredPaths = sourceSha.startsWith('d')
      ? process.env.FAKE_GIT_BASELINE_SOURCE_PATHS
      : process.env.FAKE_GIT_SOURCE_PATHS;
    const configuredJson = sourceSha.startsWith('d')
      ? process.env.FAKE_GIT_BASELINE_SOURCE_PATHS_JSON
      : process.env.FAKE_GIT_SOURCE_PATHS_JSON;
    const paths = configuredJson
      ? JSON.parse(configuredJson)
      : (configuredPaths || 'apps/api/migrations/0001_initial.sql').split(',').filter(Boolean);
    for (const migration of paths) {
      process.stdout.write('100644 blob ' + 'a'.repeat(40) + '\t' + migration + '\0');
    }
  }
  else if (args[0] === 'show') {
    const spec = args[1] || '';
    const migration = spec.slice(spec.indexOf(':') + 1);
    if (process.env.FAKE_GIT_SOURCE_CONTENTS_JSON) {
      const sources = JSON.parse(process.env.FAKE_GIT_SOURCE_CONTENTS_JSON);
      if (Object.hasOwn(sources, migration)) {
        process.stdout.write(sources[migration]);
        process.exit(0);
      }
    }
    const source = path.join(process.env.FAKE_REPOSITORY_ROOT, migration);
    if (!fs.existsSync(source)) process.exit(1);
    process.stdout.write(process.env.FAKE_GIT_SOURCE_CONTENT || fs.readFileSync(source));
  }
  process.exit(0);
}
if (tool === 'node') {
  if (args.some((arg) => arg.includes('release-state.mjs')) && process.env.FAKE_RELEASE_POLICY_FAIL === '1') {
    process.stderr.write('injected release policy failure\n');
    process.exit(42);
  }
  if (args.some((arg) => arg.includes('validate-demo-admin.mjs'))) {
    const email = args[args.indexOf('--email') + 1] || '';
    const name = args[args.indexOf('--name') + 1] || '';
    if (email.includes('..') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/\S/.test(name) || name.length > 200) {
      process.stderr.write('administrator profile validation failed\n');
      process.exit(1);
    }
  }
  process.exit(0);
}
if (tool === 'curl') {
  if (process.env.FAKE_CURL_FAIL === '1') process.exit(22);
  process.stdout.write('{"status":"ok"}\n');
  process.exit(0);
}
if (tool !== 'docker') process.exit(0);
if (args[0] === 'info') {
  process.stdout.write('27.0.0\n');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'inspect') {
  const existing = (process.env.FAKE_EXISTING_VOLUMES || '').split(',').filter(Boolean);
  const name = args.find((arg) => existing.includes(arg)) || args.at(-1);
  const created = fs.existsSync(process.env.FAKE_COMMAND_LOG + '.volume-created');
  if (!existing.includes(name) && !(created && name.endsWith('-postgres-data'))) process.exit(1);
  let restoreToken = process.env.FAKE_VOLUME_RESTORE_TOKEN || '';
  try { restoreToken ||= fs.readFileSync(process.env.FAKE_COMMAND_LOG + '.volume-token', 'utf8'); } catch {}
  let volumeIdentity = process.env.FAKE_VOLUME_IDENTITY || '2026-08-09T00:00:00Z|/var/lib/docker/volumes/sky-bar-demo-postgres-data/_data';
  if (process.env.FAKE_REPLACE_VOLUME_AFTER_PG_DUMP === '1' &&
      fs.existsSync(process.env.FAKE_COMMAND_LOG + '.pg-dump-complete')) {
    volumeIdentity = '2026-08-10T00:00:00Z|/var/lib/docker/volumes/safety-race-replacement/_data';
  }
  let restoreStarts = 0;
  try { restoreStarts = Number(fs.readFileSync(process.env.FAKE_COMMAND_LOG + '.restore-start-count', 'utf8')); } catch {}
  if (process.env.FAKE_REPLACE_VOLUME_AFTER_RESTORE_START === '1' && restoreStarts >= 2) {
    volumeIdentity = '2026-08-11T00:00:00Z|/var/lib/docker/volumes/startup-race-replacement/_data';
  }
  if (args.includes('--format')) process.stdout.write(
    (process.env.FAKE_VOLUME_PROJECT || 'sky-bar-demo') + '|' +
    (process.env.FAKE_VOLUME_LOGICAL || 'postgres-data') + '|' +
    restoreToken + '|' +
    volumeIdentity + '\n');
  else process.stdout.write('[{}]\n');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm') {
  fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.volume-removed', '1');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'create') {
  fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.volume-created', '1');
  const tokenLabel = args.find((arg) => arg.startsWith('sky-bar.restore-token='));
  if (tokenLabel) fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.volume-token', tokenLabel.slice(tokenLabel.indexOf('=') + 1));
  process.stdout.write(args.at(-1) + '\n');
  process.exit(0);
}
const command = args.join(' ');
if (/\bup\b/.test(command) && command.endsWith(' db')) {
  fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.volume-created', '1');
  if (command.includes('--no-deps')) {
    const counterPath = process.env.FAKE_COMMAND_LOG + '.restore-start-count';
    let count = 0;
    try { count = Number(fs.readFileSync(counterPath, 'utf8')); } catch {}
    count += 1;
    fs.writeFileSync(counterPath, String(count));
    if (process.env.FAKE_MUTATE_DESTINATION_VOLUME_AFTER_RESTORE_START === '1' && count >= 2) {
      const transactionVolume = path.join(process.env.FAKE_REPOSITORY_ROOT, '.demo-state',
        process.env.COMPOSE_PROJECT_NAME, 'restore-transaction', 'destination-volume');
      fs.writeFileSync(transactionVolume, 'foreign-project-postgres-data\n');
    }
  }
}
if (command.includes('npm run db:migrate')) {
  try { fs.unlinkSync(process.env.FAKE_COMMAND_LOG + '.volume-removed'); } catch {}
}
if (/\bps\b/.test(command) && (args.includes('-q') || args.includes('--quiet'))) process.stdout.write('fake-container-id\n');
else if (/\binspect\b/.test(command) && command.includes('State.Health.Status')) process.stdout.write('healthy\n');
else if (/\bps\b/.test(command) && command.includes('--services')) process.stdout.write('db\napp\ncaddy\n');
else if ((/\bexec\b/.test(command) || /\brun\b/.test(command)) && /\bpsql\b/.test(command)) {
  if (command.includes('to_regclass')) {
    const recreated = fs.existsSync(process.env.FAKE_COMMAND_LOG + '.volume-removed');
    process.stdout.write(process.env.FAKE_SCHEMA_TABLE === '0' || recreated ? 'missing\n' : 'present\n');
  }
  else if (command.includes('SELECT name FROM schema_migrations')) {
    const restoredPath = process.env.FAKE_COMMAND_LOG + '.restored-migrations';
    if (process.env.FAKE_SCHEMA_MIGRATIONS !== '__EMPTY__') {
      const names = fs.existsSync(restoredPath)
        ? fs.readFileSync(restoredPath, 'utf8')
        : (process.env.FAKE_SCHEMA_MIGRATIONS || '0001_initial.sql');
      if (names) process.stdout.write(names.replace(/\n$/, '') + '\n');
    }
  } else process.stdout.write(process.env.FAKE_ADMIN_EXISTS === '0' ? '0\n' : '1\n');
} else if (/\bpg_dump\b/.test(command)) {
  fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.pg-dump-complete', '1');
  process.stdout.write('PGDMP fake custom-format backup\n');
} else if (/\bpg_restore\b/.test(command)) {
  if (!command.includes('--list') && process.env.FAKE_RESTORED_SCHEMA_MIGRATIONS !== undefined) {
    fs.writeFileSync(process.env.FAKE_COMMAND_LOG + '.restored-migrations', process.env.FAKE_RESTORED_SCHEMA_MIGRATIONS);
  }
  process.stdout.write('; Archive created at 2026-08-08\n');
}
process.exit(0);
`;
}

function makeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sky-bar-demo-deploy-'));
  const secretsDirectory = mkdtempSync(join(tmpdir(), 'sky-bar-demo-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.after(() => rmSync(secretsDirectory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  mkdirSync(join(directory, 'apps/api/migrations'), { recursive: true });
  mkdirSync(join(directory, 'apps/api/src'), { recursive: true });
  mkdirSync(join(directory, 'deploy/caddy'), { recursive: true });
  copyFileSync(join(repositoryRoot, 'scripts/demo-deploy.sh'), join(directory, 'scripts/demo-deploy.sh'));
  copyFileSync(join(repositoryRoot, 'scripts/validate-demo-admin.mjs'), join(directory, 'scripts/validate-demo-admin.mjs'));
  copyFileSync(join(repositoryRoot, 'apps/api/src/admin-profile-rules.json'),
    join(directory, 'apps/api/src/admin-profile-rules.json'));
  chmodSync(join(directory, 'scripts/demo-deploy.sh'), 0o755);
  for (const file of ['.env.demo.example', 'compose.demo.yml']) {
    copyFileSync(join(repositoryRoot, file), join(directory, file));
  }
  cpSync(join(repositoryRoot, 'deploy/caddy'), join(directory, 'deploy/caddy'), { recursive: true });
  writeFileSync(join(directory, migrationPath), '-- initial schema\nSELECT 1;\n');
  writeFileSync(join(directory, 'package.json'), '{"name":"fixture","private":true}\n');
  writeFileSync(join(directory, 'Dockerfile'), 'FROM scratch\n');
  const environmentPath = join(directory, '.env.demo');
  writeFileSync(environmentPath, shellEnvironment(), { mode: 0o600 });

  const fakeBin = join(directory, 'fake-bin');
  mkdirSync(fakeBin);
  for (const tool of ['docker', 'curl', 'git', 'node']) {
    const path = join(fakeBin, tool);
    const source = fakeExecutableSource().replace('#!/usr/bin/env node', `#!${process.execPath}`);
    writeFileSync(path, source, { mode: 0o755 });
  }
  const commandLog = join(directory, 'commands.jsonl');
  writeFileSync(commandLog, '');
  return { directory, environmentPath, fakeBin, commandLog, secretsDirectory };
}

function run(fixture, args, environment = {}) {
  const result = spawnSync('bash', [join(fixture.directory, 'scripts/demo-deploy.sh'), ...args], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      DOCKER_HOST: 'unix:///dev/sky-bar-tests-must-never-use-real-docker.sock',
      FAKE_COMMAND_LOG: fixture.commandLog,
      FAKE_REPOSITORY_ROOT: fixture.directory,
      FAKE_GIT_SHA: gitSha,
      ...environment,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  const diagnostic = result.status !== 0 && output === ''
    ? `command log before silent exit:\n${readFileSync(fixture.commandLog, 'utf8')}`
    : output;
  return { ...result, output: diagnostic };
}

function commands(fixture, tool = undefined) {
  const entries = readFileSync(fixture.commandLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return tool ? entries.filter((entry) => entry.tool === tool) : entries;
}

function dockerLines(fixture) {
  return commands(fixture, 'docker').map(({ args }) => args.join(' '));
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function seedState(fixture, entries = [[migrationPath, hashFile(join(fixture.directory, migrationPath))]]) {
  const state = join(fixture.directory, '.demo-state', project);
  const generation = join(state, 'generations', 'seed');
  mkdirSync(generation, { recursive: true });
  writeFileSync(join(generation, 'deployed-sha'), `${'f'.repeat(40)}\n`);
  writeFileSync(join(generation, 'migrations.sha256'), entries.map(([path, digest]) => `${digest}  ${path}`).join('\n') + '\n');
  symlinkSync('generations/seed', join(state, 'current'));
  return state;
}

function stateSnapshot(state) {
  if (!existsSync(state)) return null;
  const current = join(state, 'current');
  return {
    current: lstatSync(current).isSymbolicLink() ? readlinkSync(current) : readFileSync(current, 'utf8'),
    generations: readdirSync(join(state, 'generations')).sort(),
  };
}

function passwordFile(fixture, value = 'correct horse battery staple') {
  const path = join(fixture.secretsDirectory, 'admin-password');
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function commonPersistArgs(fixture) {
  return ['--env-file', fixture.environmentPath, '--db-mode', 'persist'];
}

function backupBundles(fixture) {
  const directory = join(fixture.directory, '.demo-backups', project);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.bundle')).sort()
    .map((name) => join(directory, name));
}

test('administrator preflight validator enforces the shared invalid corpus', () => {
  const validator = join(repositoryRoot, 'scripts/validate-demo-admin.mjs');
  const invalid = [
    ['a..b@example.com', 'Demo Administrator'],
    ['.admin@example.com', 'Demo Administrator'],
    ['admin.@example.com', 'Demo Administrator'],
    ['admin@-example.com', 'Demo Administrator'],
    ['admin@example', 'Demo Administrator'],
    ['admin @example.com', 'Demo Administrator'],
    ['admin@example.com', '   '],
    ['admin@example.com', 'x'.repeat(201)],
  ];
  for (const [email, name] of invalid) {
    const result = spawnSync(process.execPath, [validator, '--email', email, '--name', name], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${email} / ${name}`);
  }
  const valid = spawnSync(process.execPath, [validator,
    '--email', 'first.last+demo@example-host.test', '--name', 'Demo Administrator'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
});

test('init-env creates private distinct secrets, reports human fields, and never overwrites', (t) => {
  const fixture = makeFixture(t);
  rmSync(fixture.environmentPath);
  const first = run(fixture, ['--init-env', '--env-file', fixture.environmentPath]);
  assert.equal(first.status, 0, first.output);
  assert.equal(statSync(fixture.environmentPath).mode & 0o777, 0o600);
  const values = Object.fromEntries(readFileSync(fixture.environmentPath, 'utf8')
    .split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  assert.match(values.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
  assert.match(values.SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.match(values.ACCESS_CAPABILITY_KEYS, /^v1:[a-f0-9]{64}$/);
  assert.equal(new Set([
    values.POSTGRES_PASSWORD,
    values.SESSION_SECRET,
    values.ACCESS_CAPABILITY_KEYS.slice(3),
  ]).size, 3);
  assert.match(first.output, /SKY_BAR_DOMAIN/);
  assert.doesNotMatch(first.output, new RegExp(values.POSTGRES_PASSWORD));
  const before = readFileSync(fixture.environmentPath);
  const second = run(fixture, ['--init-env', '--env-file', fixture.environmentPath]);
  assert.notEqual(second.status, 0);
  assert.deepEqual(readFileSync(fixture.environmentPath), before);
});

test('environment parsing rejects missing, malformed, insecure, and executable values without sourcing them', async (t) => {
  const cases = [
    ['missing domain', { ...validEnvironment, SKY_BAR_DOMAIN: '' }],
    ['unsafe project', { ...validEnvironment, COMPOSE_PROJECT_NAME: '../other-stack' }],
    ['invalid email', { ...validEnvironment, ADMIN_EMAIL: 'not-an-email' }],
    ['URI-unsafe database password', { ...validEnvironment, POSTGRES_PASSWORD: 'x/y?z' }],
    ['short session secret', { ...validEnvironment, SESSION_SECRET: 'short' }],
    ['malformed capability key', { ...validEnvironment, ACCESS_CAPABILITY_KEYS: 'not-versioned' }],
    ['leading empty capability key', { ...validEnvironment, ACCESS_CAPABILITY_KEYS: `,v1:${'c'.repeat(64)}` }],
    ['trailing empty capability key', { ...validEnvironment, ACCESS_CAPABILITY_KEYS: `v1:${'c'.repeat(64)},` }],
    ['repeated empty capability key', { ...validEnvironment, ACCESS_CAPABILITY_KEYS: `v2:${'d'.repeat(64)},,v1:${'c'.repeat(64)}` }],
    ['invalid positive limit', { ...validEnvironment, RATE_LIMIT_MAX: '0' }],
    ['literal comment metacharacter', { ...validEnvironment, ADMIN_NAME: 'Demo#comment' }],
    ['literal quote metacharacter', { ...validEnvironment, ADMIN_NAME: '"Demo"' }],
    ['literal escape metacharacter', { ...validEnvironment, ADMIN_NAME: 'Demo\\Admin' }],
    ['leading whitespace', { ...validEnvironment, ADMIN_NAME: ' Demo Administrator' }],
  ];
  for (const [name, values] of cases) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      writeFileSync(fixture.environmentPath, shellEnvironment(values), { mode: 0o600 });
      const result = run(fixture, ['--check', '--env-file', fixture.environmentPath]);
      assert.notEqual(result.status, 0, result.output);
      assert.equal(commands(fixture, 'docker').length, 0, 'invalid configuration reached Docker');
    });
  }
  await t.test('dotenv command syntax is data, not code', (st) => {
    const fixture = makeFixture(st);
    const marker = join(fixture.directory, 'sourced-env-marker');
    writeFileSync(fixture.environmentPath,
      shellEnvironment({ ...validEnvironment, ADMIN_NAME: `$(touch ${marker})` }), { mode: 0o600 });
    const result = run(fixture, ['--check', '--env-file', fixture.environmentPath]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
  });
  await t.test('group-readable env file is rejected', (st) => {
    const fixture = makeFixture(st);
    chmodSync(fixture.environmentPath, 0o640);
    const result = run(fixture, ['--check', '--env-file', fixture.environmentPath]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /permission|0600|group|world/i);
  });
});

test('validated env-file values override conflicting ambient allowlisted variables for every Compose call', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--check', '--env-file', fixture.environmentPath], {
    COMPOSE_PROJECT_NAME: 'ambient-project',
    SKY_BAR_DOMAIN: 'ambient.invalid.test',
    POSTGRES_PASSWORD: 'z'.repeat(64),
    SESSION_SECRET: 'y'.repeat(64),
    ACCESS_CAPABILITY_KEYS: `ambient:${'x'.repeat(64)}`,
    LOG_LEVEL: 'debug',
    RATE_LIMIT_MAX: '999',
  });
  assert.equal(result.status, 0, result.output);
  const composeCalls = commands(fixture, 'docker')
    .filter(({ args }) => args[0] === 'compose' && args.includes('--env-file'));
  assert.ok(composeCalls.length >= 2);
  const expectedSecretHashes = Object.fromEntries(
    ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'ACCESS_CAPABILITY_KEYS']
      .map((key) => [key, createHash('sha256').update(validEnvironment[key]).digest('hex')]),
  );
  for (const call of composeCalls) {
    assert.equal(call.safeConfig.COMPOSE_PROJECT_NAME, validEnvironment.COMPOSE_PROJECT_NAME);
    assert.equal(call.safeConfig.SKY_BAR_DOMAIN, validEnvironment.SKY_BAR_DOMAIN);
    assert.equal(call.safeConfig.LOG_LEVEL, validEnvironment.LOG_LEVEL);
    assert.equal(call.safeConfig.RATE_LIMIT_MAX, validEnvironment.RATE_LIMIT_MAX);
    assert.deepEqual(call.secretHashes, expectedSecretHashes);
  }
  const logged = readFileSync(fixture.commandLog, 'utf8');
  for (const secretKey of ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'ACCESS_CAPABILITY_KEYS']) {
    assert.doesNotMatch(logged, new RegExp(validEnvironment[secretKey]));
  }
});

test('root Docker build context excludes env files including example-shaped names without re-inclusion', () => {
  const rules = readFileSync(join(repositoryRoot, '.dockerignore'), 'utf8')
    .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const requiredRule of ['.env', '.env.*', '*.env', '*.env.*']) {
    assert.ok(rules.includes(requiredRule), `missing Docker ignore rule: ${requiredRule}`);
  }
  const envReinclusions = rules.filter((rule) => rule.startsWith('!') && /(^|[./*])env([.*]|$)/i.test(rule.slice(1)));
  assert.deepEqual(envReinclusions, [], `env files were re-included: ${envReinclusions.join(', ')}`);
});

test('non-interactive deployment requires an explicit database mode', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--env-file', fixture.environmentPath], {
    FAKE_EXISTING_VOLUMES: dbVolume,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /db-mode|non-interactive|persist|rewrite/i);
  assert.equal(dockerLines(fixture).some((line) => /\b(up|run|down)\b/.test(line)), false);
});

test('preflight rejects a dirty worktree before deployment mutation', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, commonPersistArgs(fixture), { FAKE_GIT_DIRTY: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /clean|dirty|worktree|uncommitted/i);
  assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec|down)\b|volume rm/.test(line)), false);
});

test('release policy and canonical administrator validation fail before Docker mutation', async (t) => {
  await t.test('release policy failure', (st) => {
    const fixture = makeFixture(st);
    const result = run(fixture, commonPersistArgs(fixture), { FAKE_RELEASE_POLICY_FAIL: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(commands(fixture, 'docker').length, 0);
  });
  await t.test('administrator email rejected by bootstrap rules', (st) => {
    const fixture = makeFixture(st);
    writeFileSync(fixture.environmentPath,
      shellEnvironment({ ...validEnvironment, ADMIN_EMAIL: 'a..b@example.com' }), { mode: 0o600 });
    const result = run(fixture, commonPersistArgs(fixture));
    assert.notEqual(result.status, 0);
    assert.match(result.output, /administrator profile|ADMIN_EMAIL/i);
    assert.equal(commands(fixture, 'docker').length, 0);
  });
});

test('--check validates Compose and Caddy without container, volume, backup, or state mutation', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--check', '--env-file', fixture.environmentPath]);
  assert.equal(result.status, 0, result.output);
  const lines = dockerLines(fixture);
  assert.ok(lines.some((line) => line.includes('compose') && line.includes('config')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('build') && line.includes('caddy')), lines.join('\n'));
  assert.equal(lines.some((line) => /\b(up|run|exec|down|start|stop|restart)\b/.test(line)), false, lines.join('\n'));
  assert.equal(lines.some((line) => line.startsWith('volume ')), false, lines.join('\n'));
  assert.equal(existsSync(join(fixture.directory, '.demo-state')), false);
  assert.equal(existsSync(join(fixture.directory, '.demo-backups')), false);
});

test('persist backs up first, always runs the exact compiled migration command, and never deletes volumes', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const result = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(result.status, 0, result.output);
  const lines = dockerLines(fixture);
  const backup = lines.findIndex((line) => line.includes('pg_dump'));
  const validate = lines.findIndex((line) => line.includes('pg_restore') && line.includes('--list'));
  const migrate = lines.findIndex((line) => line.includes('run --rm --no-deps app npm run db:migrate'));
  assert.ok(backup >= 0, lines.join('\n'));
  assert.ok(validate > backup, lines.join('\n'));
  assert.ok(migrate > validate, lines.join('\n'));
  assert.equal(lines.some((line) => line.startsWith('volume rm')), false, lines.join('\n'));
  assert.equal(lines.some((line) => /down.*(?:-v|--volumes)/.test(line)), false, lines.join('\n'));
  const bundles = readdirSync(join(fixture.directory, '.demo-backups', project))
    .filter((name) => name.endsWith('.bundle'));
  assert.equal(bundles.length, 1);
  const bundle = join(fixture.directory, '.demo-backups', project, bundles[0]);
  assert.ok(existsSync(join(bundle, 'database.dump')));
  assert.ok(existsSync(join(bundle, 'dump.sha256')));
  assert.ok(existsSync(join(bundle, 'database-migrations.txt')));
  assert.ok(existsSync(join(bundle, 'state', 'current', 'migrations.sha256')));
  assert.ok(existsSync(join(bundle, 'state', 'pending', 'migrations.sha256')));
  assert.match(readFileSync(join(bundle, 'metadata'), 'utf8'), /databaseState=current/);
  const state = join(fixture.directory, '.demo-state', project);
  assert.notEqual(stateSnapshot(state).current, 'generations/seed');
});

test('schema migration query failures cannot become an empty migration result', async (t) => {
  await t.test('pre-backup source classification', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    const result = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_FAIL_SCHEMA_QUERY_AT: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /read applied database migrations|schema_migrations query failure/i);
    assert.equal(dockerLines(fixture).some((line) => line.includes('pg_dump')), false);
  });

  await t.test('post-restore verification', (st) => {
    const fixture = makeFixture(st);
    const state = seedState(fixture);
    const deployed = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_ADMIN_EXISTS: '1',
    });
    assert.equal(deployed.status, 0, deployed.output);
    const [bundle] = backupBundles(fixture);
    const before = stateSnapshot(state);
    writeFileSync(fixture.commandLog, '');
    const restored = run(fixture, [...commonPersistArgs(fixture),
      '--restore-backup', bundle, '--confirm-restore', project], {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_GIT_SHA: 'f'.repeat(40),
      FAKE_FAIL_SCHEMA_QUERY_AT: '2',
      FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    });
    assert.notEqual(restored.status, 0);
    assert.match(restored.output, /read applied database migrations|schema_migrations query failure/i);
    assert.ok(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')));
    const transaction = join(state, 'restore-transaction');
    assert.equal(readFileSync(join(transaction, 'phase'), 'utf8').trim(), 'restoring');
    assert.deepEqual(stateSnapshot(state), before, 'failed verification must not publish restored state');
  });
});

test('backup creation or validation failure aborts before migration/deletion and preserves deployment state', async (t) => {
  for (const failure of ['pg_dump', 'pg_restore --list']) {
    await t.test(failure, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const before = stateSnapshot(state);
      const result = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_FAIL_MATCH: failure,
      });
      assert.notEqual(result.status, 0);
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => line.includes('npm run db:migrate')), false, lines.join('\n'));
      assert.equal(lines.some((line) => line.startsWith('volume rm')), false, lines.join('\n'));
      assert.deepEqual(stateSnapshot(state), before);
    });
  }
});

test('rewrite requires exact confirmation and deletes only the deterministic PostgreSQL volume', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const missingConfirmation = run(fixture,
    ['--env-file', fixture.environmentPath, '--db-mode', 'rewrite'],
    { FAKE_EXISTING_VOLUMES: dbVolume });
  assert.notEqual(missingConfirmation.status, 0);
  assert.equal(dockerLines(fixture).some((line) => line.startsWith('volume rm')), false);

  writeFileSync(fixture.commandLog, '');
  const secret = 'admin password only on stdin';
  const secretFile = passwordFile(fixture, secret);
  const result = run(fixture, [
    '--env-file', fixture.environmentPath,
    '--db-mode', 'rewrite',
    '--confirm-rewrite', project,
    '--admin-password-file', secretFile,
  ], { FAKE_EXISTING_VOLUMES: dbVolume, FAKE_ADMIN_EXISTS: '0' });
  assert.equal(result.status, 0, result.output);
  const lines = dockerLines(fixture);
  const removals = lines.filter((line) => line.startsWith('volume rm'));
  assert.equal(removals.length, 1, lines.join('\n'));
  assert.match(removals[0], new RegExp(`${dbVolume}$`));
  assert.doesNotMatch(removals[0], /caddy-(?:data|config)/);
  assert.equal(lines.some((line) => /down.*(?:-v|--volumes)/.test(line)), false);
  assert.equal(lines.some((line) => /volume prune/.test(line)), false);
  assert.ok(lines.some((line) => line.includes('admin:create')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('admin:create') && line.includes('--password-stdin')), lines.join('\n'));
  assert.doesNotMatch(`${result.output}\n${readFileSync(fixture.commandLog, 'utf8')}`, new RegExp(secret));
});

test('rewrite refuses a PostgreSQL volume owned by another Compose project', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, [
    '--env-file', fixture.environmentPath,
    '--db-mode', 'rewrite',
    '--confirm-rewrite', project,
    '--admin-password-file', passwordFile(fixture),
  ], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_VOLUME_PROJECT: 'some-other-project',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /label|owned|project|refus/i);
  assert.equal(dockerLines(fixture).some((line) => line.startsWith('volume rm')), false);
});

test('existing PostgreSQL volumes require exact project and logical ownership labels', async (t) => {
  for (const [name, environment] of [
    ['missing project', { FAKE_VOLUME_PROJECT: '<no value>' }],
    ['missing logical name', { FAKE_VOLUME_LOGICAL: '<no value>' }],
    ['foreign logical name', { FAKE_VOLUME_LOGICAL: 'other-data' }],
  ]) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      seedState(fixture);
      const result = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        ...environment,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.output, /ownership|label|refus/i);
      assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec|down)\b|volume rm/.test(line)), false);
    });
  }
});

test('state without its PostgreSQL volume cannot silently create a replacement database', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const before = stateSnapshot(state);
  const result = run(fixture, commonPersistArgs(fixture));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /missing|rewrite|confirm|volume/i);
  assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec)\b/.test(line)), false);
  assert.deepEqual(stateSnapshot(state), before);
});

test('persist migration manifest permits unchanged/new files and rejects modified, renamed, deleted, and duplicate entries', async (t) => {
  await t.test('unchanged plus new migration succeeds', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    writeFileSync(join(fixture.directory, 'apps/api/migrations/0002_forward.sql'), 'SELECT 2;\n');
    const result = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_ADMIN_EXISTS: '1',
    });
    assert.equal(result.status, 0, result.output);
  });

  const mutations = [
    ['modified', (fixture) => writeFileSync(join(fixture.directory, migrationPath), 'SELECT 999;\n')],
    ['deleted', (fixture) => rmSync(join(fixture.directory, migrationPath))],
    ['renamed', (fixture) => {
      const old = join(fixture.directory, migrationPath);
      const renamed = join(fixture.directory, 'apps/api/migrations/0001_renamed.sql');
      copyFileSync(old, renamed);
      rmSync(old);
    }],
    ['duplicate manifest entry', (fixture) => {
      const digest = hashFile(join(fixture.directory, migrationPath));
      const generation = join(fixture.directory, '.demo-state', project, 'generations', 'seed');
      writeFileSync(join(generation, 'migrations.sha256'), `${digest}  ${migrationPath}\n${digest}  ${migrationPath}\n`);
    }],
    ['duplicate recorded numeric prefix', (fixture) => {
      const digest = hashFile(join(fixture.directory, migrationPath));
      const generation = join(fixture.directory, '.demo-state', project, 'generations', 'seed');
      writeFileSync(join(generation, 'migrations.sha256'),
        `${digest}  ${migrationPath}\n${'e'.repeat(64)}  apps/api/migrations/0001_other.sql\n`);
    }],
    ['malformed manifest entry', (fixture) => {
      const generation = join(fixture.directory, '.demo-state', project, 'generations', 'seed');
      writeFileSync(join(generation, 'migrations.sha256'), 'not-a-sha256 manifest line\n');
    }],
    ['manifest path outside the migrations directory', (fixture) => {
      const generation = join(fixture.directory, '.demo-state', project, 'generations', 'seed');
      writeFileSync(join(generation, 'migrations.sha256'), `${'d'.repeat(64)}  ../../outside.sql\n`);
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      mutate(fixture);
      const before = stateSnapshot(state);
      const result = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /rewrite|forward migration|manifest|migration/i);
      assert.equal(dockerLines(fixture).some((line) => line.includes('npm run db:migrate')), false);
      assert.deepEqual(stateSnapshot(state), before);
    });
  }
});

test('current migration files with a duplicate numeric prefix are rejected before database mutation', (t) => {
  const fixture = makeFixture(t);
  writeFileSync(join(fixture.directory, 'apps/api/migrations/0001_duplicate.sql'), 'SELECT 2;\n');
  const result = run(fixture, commonPersistArgs(fixture));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /duplicate numeric prefix 0001/i);
  assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec|down)\b|volume rm/.test(line)), false);
});

test('symlinked and non-regular SQL migration entries are rejected before database mutation', async (t) => {
  await t.test('symlink', (st) => {
    const fixture = makeFixture(st);
    symlinkSync('0001_initial.sql', join(fixture.directory, 'apps/api/migrations/0002_link.sql'));
    const result = run(fixture, commonPersistArgs(fixture));
    assert.notEqual(result.status, 0);
    assert.match(result.output, /regular|symlink/i);
    assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec|down)\b|volume rm/.test(line)), false);
  });
  await t.test('directory', (st) => {
    const fixture = makeFixture(st);
    mkdirSync(join(fixture.directory, 'apps/api/migrations/0002_directory.sql'));
    const result = run(fixture, commonPersistArgs(fixture));
    assert.notEqual(result.status, 0);
    assert.match(result.output, /regular|symlink/i);
    assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec|down)\b|volume rm/.test(line)), false);
  });
});

test('an unmanaged existing database requires explicit adoption and publishes the baseline only after health succeeds', (t) => {
  const fixture = makeFixture(t);
  const rejected = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /adopt-existing-db|rewrite|manifest|state/i);
  assert.equal(existsSync(join(fixture.directory, '.demo-state', project, 'current')), false);

  writeFileSync(fixture.commandLog, '');
  const adopted = run(fixture, [...commonPersistArgs(fixture), '--adopt-existing-db'], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(adopted.status, 0, adopted.output);
  assert.ok(existsSync(join(fixture.directory, '.demo-state', project, 'current')));
});

test('persist preserves an active administrator without requesting or resetting its password', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const result = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(dockerLines(fixture).some((line) => line.includes('admin:create')), false, dockerLines(fixture).join('\n'));
  assert.doesNotMatch(result.output, /administrator password|admin password/i);
});

test('administrator password files are protected and their contents never enter arguments, output, env, or state', (t) => {
  const fixture = makeFixture(t);
  const exposed = passwordFile(fixture, 'bad permissions');
  chmodSync(exposed, 0o644);
  const rejected = run(fixture, [
    '--env-file', fixture.environmentPath, '--db-mode', 'persist', '--admin-password-file', exposed,
  ], { FAKE_ADMIN_EXISTS: '0' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /permission|0600|group|world/i);

  writeFileSync(fixture.commandLog, '');
  const secret = 'this value must remain entirely private';
  const protectedFile = passwordFile(fixture, secret);
  const result = run(fixture, [
    '--env-file', fixture.environmentPath, '--db-mode', 'persist', '--admin-password-file', protectedFile,
  ], { FAKE_ADMIN_EXISTS: '0', FAKE_FORBIDDEN_SECRET_FILE: protectedFile });
  assert.equal(result.status, 0, result.output);
  assert.ok(dockerLines(fixture).some((line) => line.includes('admin:create')));
  assert.ok(dockerLines(fixture).some((line) => line.includes('--password-stdin')));
  const stateRoot = join(fixture.directory, '.demo-state');
  const stateText = existsSync(stateRoot)
    ? readdirSync(join(stateRoot, project, 'generations'), { withFileTypes: true })
      .flatMap((entry) => readdirSync(join(stateRoot, project, 'generations', entry.name))
        .map((file) => readFileSync(join(stateRoot, project, 'generations', entry.name, file), 'utf8'))).join('\n')
    : '';
  assert.doesNotMatch(`${result.output}\n${readFileSync(fixture.commandLog, 'utf8')}\n${stateText}`, new RegExp(secret));
  assert.equal(Object.values(validEnvironment).includes(secret), false);
});

test('failed migration, application health, or external HTTPS health never publishes new state', async (t) => {
  const failures = [
    ['migration', { FAKE_FAIL_MATCH: 'npm run db:migrate' }],
    ['application start', { FAKE_FAIL_MATCH: 'up -d app' }],
    ['external health', { FAKE_CURL_FAIL: '1' }],
  ];
  for (const [name, injected] of failures) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const before = stateSnapshot(state);
      const result = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
        ...injected,
      });
      assert.notEqual(result.status, 0, result.output);
      assert.deepEqual(stateSnapshot(state), before);
    });
  }
});

test('pending state resumes an interrupted first deployment and rejects source drift', (t) => {
  const fixture = makeFixture(t);
  const secretFile = passwordFile(fixture);
  const first = run(fixture, [...commonPersistArgs(fixture), '--admin-password-file', secretFile], {
    FAKE_ADMIN_EXISTS: '0',
    FAKE_SCHEMA_TABLE: '0',
    FAKE_CURL_FAIL: '1',
  });
  assert.notEqual(first.status, 0);
  const pending = join(fixture.directory, '.demo-state', project, 'pending');
  assert.ok(existsSync(join(pending, 'deployed-sha')));
  assert.equal(existsSync(join(fixture.directory, '.demo-state', project, 'current')), false);

  writeFileSync(fixture.commandLog, '');
  const resumed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(resumed.status, 0, resumed.output);
  assert.equal(existsSync(pending), false);
  assert.ok(existsSync(join(fixture.directory, '.demo-state', project, 'current')));
});

test('pending source mismatch and database migration drift fail before migration or app start', async (t) => {
  await t.test('pending manifest mismatch', (st) => {
    const fixture = makeFixture(st);
    const pending = join(fixture.directory, '.demo-state', project, 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'deployed-sha'), `${gitSha}\n`);
    writeFileSync(join(pending, 'migrations.sha256'), `${'e'.repeat(64)}  ${migrationPath}\n`);
    const result = run(fixture, commonPersistArgs(fixture), { FAKE_EXISTING_VOLUMES: dbVolume });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /pending.*manifest|different.*checkout/i);
    assert.equal(dockerLines(fixture).some((line) => /\b(up|run|exec)\b/.test(line)), false);
  });
  await t.test('database contains migration absent from checkout', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    const result = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql\n0002_removed.sql',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /absent.*checkout|ambiguous rollback/i);
    const lines = dockerLines(fixture);
    assert.equal(lines.some((line) => line.includes('npm run db:migrate')), false);
    assert.equal(lines.some((line) => line.includes('up -d app')), false);
  });
  await t.test('database is older than current state', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    const result = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_SCHEMA_MIGRATIONS: '__EMPTY__',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /older.*state|missing/i);
    assert.equal(dockerLines(fixture).some((line) => line.includes('npm run db:migrate')), false);
  });
});

test('HTTPS health probes local Caddy with configured hostname and SNI', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const result = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(result.status, 0, result.output);
  const health = commands(fixture, 'curl').find(({ args }) => args.some((arg) => arg.includes('/api/v1/health')));
  assert.ok(health);
  assert.ok(health.args.includes('--noproxy'));
  assert.ok(health.args.includes('*'));
  assert.ok(health.args.includes('--resolve'));
  assert.ok(health.args.includes(`${validEnvironment.SKY_BAR_DOMAIN}:443:127.0.0.1`));
  assert.ok(health.args.includes(`https://${validEnvironment.SKY_BAR_DOMAIN}/api/v1/health`));
});

test('guarded restore rejects tampering before replacement and creates safety backup first', async (t) => {
  await t.test('tampered dump', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    const deployed = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_ADMIN_EXISTS: '1',
    });
    assert.equal(deployed.status, 0, deployed.output);
    const [bundle] = backupBundles(fixture);
    assert.ok(bundle);
    const dump = join(bundle, 'database.dump');
    writeFileSync(dump, `${readFileSync(dump, 'utf8')}tampered\n`);
    writeFileSync(fixture.commandLog, '');
    const restored = run(fixture, [...commonPersistArgs(fixture),
      '--restore-backup', bundle, '--confirm-restore', project], {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_GIT_SHA: 'f'.repeat(40),
      FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    });
    assert.notEqual(restored.status, 0);
    assert.match(restored.output, /digest|tamper|backup/i);
    assert.equal(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
  });

  await t.test('matching bundle', (st) => {
    const fixture = makeFixture(st);
    seedState(fixture);
    const deployed = run(fixture, commonPersistArgs(fixture), {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_ADMIN_EXISTS: '1',
    });
    assert.equal(deployed.status, 0, deployed.output);
    const [bundle] = backupBundles(fixture);
    assert.ok(bundle);
    writeFileSync(fixture.commandLog, '');
    const restored = run(fixture, [...commonPersistArgs(fixture),
      '--restore-backup', bundle, '--confirm-restore', project], {
      FAKE_EXISTING_VOLUMES: dbVolume,
      FAKE_GIT_SHA: 'f'.repeat(40),
      FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    });
    assert.equal(restored.status, 0, restored.output);
    const lines = dockerLines(fixture);
    const safetyDump = lines.findIndex((line) => line.includes('pg_dump'));
    const destructiveRestore = lines.findIndex((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list'));
    assert.ok(safetyDump >= 0, lines.join('\n'));
    assert.ok(destructiveRestore > safetyDump, lines.join('\n'));
    assert.ok(lines.slice(0, destructiveRestore).some((line) => line.includes('stop app caddy')));
    assert.equal(backupBundles(fixture).length, 2);
  });
});

test('guarded restore recovers a missing destination without inventing a safety backup', async (t) => {
  for (const [name, removeState, interruption] of [
    ['fresh state after transaction publication', true, 'after-transaction'],
    ['retained state after database drop', false, 'after-drop'],
  ]) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const deployed = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.equal(deployed.status, 0, deployed.output);
      const [bundle] = backupBundles(fixture);
      rmSync(`${fixture.commandLog}.volume-created`, { force: true });
      if (removeState) rmSync(state, { recursive: true });
      writeFileSync(fixture.commandLog, '');
      const restoreArgs = [...commonPersistArgs(fixture),
        '--restore-backup', bundle, '--confirm-restore', project];
      const interrupted = run(fixture, restoreArgs, {
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
        SKY_BAR_TEST_FAIL_RESTORE: interruption,
      });
      assert.notEqual(interrupted.status, 0);
      const transaction = join(fixture.directory, '.demo-state', project, 'restore-transaction');
      assert.equal(readFileSync(join(transaction, 'safety-backup-kind'), 'utf8').trim(), 'absent');
      assert.equal(readFileSync(join(transaction, 'safety-backup-path'), 'utf8').trim(), 'absent');
      assert.equal(readFileSync(join(transaction, 'destination-volume'), 'utf8').trim(), dbVolume);
      const destinationIdentity = readFileSync(join(transaction, 'destination-volume-identity'), 'utf8').trim();
      assert.equal(destinationIdentity === 'unbound', interruption === 'after-transaction');
      assert.match(readFileSync(join(transaction, 'destination-volume-restore-token'), 'utf8').trim(), /^restore-[0-9a-f]{32}$/);
      assert.equal(dockerLines(fixture).some((line) => line.includes('pg_dump')), false);

      writeFileSync(fixture.commandLog, '');
      const recovered = run(fixture, restoreArgs, {
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
      });
      assert.equal(recovered.status, 0, recovered.output);
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => line.includes('pg_dump')), false);
      const drop = lines.findIndex((line) => line.includes('DROP DATABASE IF EXISTS skybar'));
      const create = lines.findIndex((line) => line.includes('CREATE DATABASE skybar OWNER skybar'));
      const restore = lines.findIndex((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list'));
      assert.ok(drop >= 0 && create > drop && restore > create, lines.join('\n'));
      assert.equal(lines[restore].includes('--clean'), false);
      assert.equal(existsSync(transaction), false);
    });
  }
});

test('missing-destination binding and retirement recovery stay bound to the requested bundle', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  rmSync(state, { recursive: true });
  rmSync(`${fixture.commandLog}.volume-created`, { force: true });
  rmSync(`${fixture.commandLog}.volume-token`, { force: true });
  const restoreArgs = [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project];

  writeFileSync(fixture.commandLog, '');
  const bindingInterrupted = run(fixture, restoreArgs, {
    FAKE_GIT_SHA: 'f'.repeat(40),
    SKY_BAR_TEST_FAIL_RESTORE_BIND: 'after-identity-staging',
  });
  assert.notEqual(bindingInterrupted.status, 0);
  assert.match(bindingInterrupted.output, /identity interruption.*atomic binding/i);
  const transaction = join(state, 'restore-transaction');
  const identityStaging = join(transaction, '.destination-volume-identity.next');
  assert.equal(readFileSync(join(transaction, 'destination-volume-identity'), 'utf8').trim(), 'unbound');
  assert.ok(existsSync(identityStaging));
  assert.equal(statSync(identityStaging).mode & 0o777, 0o600);
  assert.equal(readdirSync(transaction).some((name) => /^\.destination-volume-identity\.\d+$/.test(name)), false);

  writeFileSync(fixture.commandLog, '');
  const retirementInterrupted = run(fixture, restoreArgs, {
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    SKY_BAR_TEST_FAIL_RESTORE_RETIREMENT: 'after-rename',
  });
  assert.notEqual(retirementInterrupted.status, 0);
  assert.match(retirementInterrupted.output, /retirement interruption/i);
  const [retirement] = readdirSync(state)
    .filter((name) => /^\.restore-transaction-completed\.\d+\.\d+$/.test(name));
  assert.ok(retirement);
  assert.equal(existsSync(join(state, retirement, '.destination-volume-identity.next')), false);
  assert.equal(existsSync(transaction), false);
  const beforeCleanup = stateSnapshot(state);
  const retirementPath = join(state, retirement);
  const otherBundle = `${bundle}-different`;
  const missingBundle = join(fixture.directory, 'missing-restore.bundle');
  cpSync(bundle, otherBundle, { recursive: true });

  const assertNoRestoreMutation = () => {
    const lines = dockerLines(fixture);
    assert.equal(lines.some((line) => /\b(up|stop|run|exec|down)\b/.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => /^volume (?:create|rm)\b/.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => /\b(?:pg_dump|pg_restore)\b|DROP DATABASE|CREATE DATABASE/.test(line)),
      false, lines.join('\n'));
  };

  const secondRetirement = join(state, '.restore-transaction-completed.999999999.1');
  cpSync(retirementPath, secondRetirement, { recursive: true });
  chmodSync(secondRetirement, 0o700);
  chmodSync(join(secondRetirement, 'current'), 0o700);
  writeFileSync(join(secondRetirement, 'bundle-path'), `${otherBundle}\n`);
  writeFileSync(fixture.commandLog, '');
  const ambiguous = run(fixture, restoreArgs, { FAKE_GIT_SHA: 'f'.repeat(40) });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.output, /different source-bound bundle.*requested restore/i);
  assert.ok(existsSync(retirementPath));
  assert.ok(existsSync(secondRetirement));
  assert.deepEqual(stateSnapshot(state), beforeCleanup);
  assertNoRestoreMutation();
  rmSync(secondRetirement, { recursive: true });

  for (const requestedBundle of [otherBundle, missingBundle]) {
    writeFileSync(fixture.commandLog, '');
    const rejected = run(fixture, [...commonPersistArgs(fixture),
      '--restore-backup', requestedBundle, '--confirm-restore', project], {
      FAKE_GIT_SHA: 'f'.repeat(40),
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /different source-bound bundle.*requested restore/i);
    assert.ok(existsSync(retirementPath));
    assert.equal(readFileSync(join(retirementPath, 'bundle-path'), 'utf8').trim(), bundle);
    assert.deepEqual(stateSnapshot(state), beforeCleanup);
    assertNoRestoreMutation();
  }

  writeFileSync(fixture.commandLog, '');
  const recovered = run(fixture, restoreArgs, { FAKE_GIT_SHA: 'f'.repeat(40) });
  assert.equal(recovered.status, 0, recovered.output);
  assert.match(recovered.output, /Recovered completed restore transaction retirement/i);
  assert.equal(existsSync(retirementPath), false);
  assert.deepEqual(stateSnapshot(state), beforeCleanup);
  assertNoRestoreMutation();
});

test('retry rejects unsafe fixed destination identity staging records', async (t) => {
  for (const kind of ['symlink', 'non-private file']) {
    await t.test(kind, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const deployed = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.equal(deployed.status, 0, deployed.output);
      const [bundle] = backupBundles(fixture);
      rmSync(state, { recursive: true });
      rmSync(`${fixture.commandLog}.volume-created`, { force: true });
      rmSync(`${fixture.commandLog}.volume-token`, { force: true });
      const restoreArgs = [...commonPersistArgs(fixture),
        '--restore-backup', bundle, '--confirm-restore', project];
      writeFileSync(fixture.commandLog, '');
      const interrupted = run(fixture, restoreArgs, {
        FAKE_GIT_SHA: 'f'.repeat(40),
        SKY_BAR_TEST_FAIL_RESTORE_BIND: 'after-identity-staging',
      });
      assert.notEqual(interrupted.status, 0);
      const transaction = join(state, 'restore-transaction');
      const identityStaging = join(transaction, '.destination-volume-identity.next');
      if (kind === 'symlink') {
        rmSync(identityStaging);
        symlinkSync('destination-volume-identity', identityStaging);
      } else {
        chmodSync(identityStaging, 0o644);
      }

      writeFileSync(fixture.commandLog, '');
      const rejected = run(fixture, restoreArgs, { FAKE_GIT_SHA: 'f'.repeat(40) });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.output, /identity staging record.*(?:symlink|group|world)/i);
      assert.equal(readFileSync(join(transaction, 'destination-volume-identity'), 'utf8').trim(), 'unbound');
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => line.includes('stop app caddy')), false);
      assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
      assert.equal(lines.some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
    });
  }
});

test('guarded restore rejects unrelated bundle history before database mutation', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  writeFileSync(join(bundle, 'state', 'current', 'deployed-sha'), `${'e'.repeat(40)}\n`);
  writeFileSync(fixture.commandLog, '');
  const rejected = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_GIT_SOURCE_ANCESTOR: '0',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /not an ancestor/i);
  const lines = dockerLines(fixture);
  assert.equal(lines.some((line) => line.includes('pg_dump')), false);
  assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
  assert.equal(lines.some((line) => line.includes('stop app caddy')), false);
});

test('guarded restore authenticates an older manifest against its recorded commit', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  writeFileSync(join(bundle, 'state', 'current', 'deployed-sha'), `${'e'.repeat(40)}\n`);
  writeFileSync(fixture.commandLog, '');
  const rejected = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_GIT_SOURCE_CONTENT: '-- different historical migration\n',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /recorded source commit/i);
  const lines = dockerLines(fixture);
  assert.equal(lines.some((line) => line.includes('pg_dump')), false);
  assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
});

test('historical source authentication cannot omit a pathological SQL pathname', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  writeFileSync(join(bundle, 'state', 'current', 'deployed-sha'), `${'e'.repeat(40)}\n`);
  const pathologicalPath = 'apps/api/migrations/nested/0002_"quoted\\path\nwith-tab\t.sql';
  writeFileSync(fixture.commandLog, '');
  const rejected = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_GIT_SOURCE_PATHS_JSON: JSON.stringify([migrationPath, pathologicalPath]),
    FAKE_GIT_SOURCE_CONTENTS_JSON: JSON.stringify({
      [migrationPath]: readFileSync(join(fixture.directory, migrationPath), 'utf8'),
      [pathologicalPath]: 'SELECT 2;\n',
    }),
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /does not match.*recorded source commit/i);
  const gitTree = commands(fixture, 'git').find(({ args }) => args[0] === 'ls-tree');
  assert.ok(gitTree?.args.includes('-rz'), JSON.stringify(gitTree));
  const lines = dockerLines(fixture);
  assert.equal(lines.some((line) => line.includes('pg_dump')), false);
  assert.equal(lines.some((line) => line.includes('stop app caddy')), false);
  assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
  assert.equal(existsSync(join(fixture.directory, '.demo-state', project, 'restore-transaction')), false);
});

test('guarded restore rejects destination replacement at both destructive boundaries', async (t) => {
  for (const [name, injection, expected] of [
    ['during safety-backup preparation', { FAKE_REPLACE_VOLUME_AFTER_PG_DUMP: '1' }, /safety-backup preparation/i],
    ['after restore database startup', { FAKE_REPLACE_VOLUME_AFTER_RESTORE_START: '1' }, /volume identity changed/i],
    ['destination name after restore database startup',
      { FAKE_MUTATE_DESTINATION_VOLUME_AFTER_RESTORE_START: '1' }, /destination volume differs/i],
  ]) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      seedState(fixture);
      const deployed = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.equal(deployed.status, 0, deployed.output);
      const [bundle] = backupBundles(fixture);
      rmSync(`${fixture.commandLog}.pg-dump-complete`, { force: true });
      rmSync(`${fixture.commandLog}.restore-start-count`, { force: true });
      writeFileSync(fixture.commandLog, '');
      const rejected = run(fixture, [...commonPersistArgs(fixture),
        '--restore-backup', bundle, '--confirm-restore', project], {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
        ...injection,
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.output, expected);
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
      assert.equal(lines.some((line) => line.includes('CREATE DATABASE')), false);
      assert.equal(lines.some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
      if (name === 'during safety-backup preparation') {
        assert.equal(existsSync(join(fixture.directory, '.demo-state', project, 'restore-transaction')), false);
        assert.equal(lines.some((line) => line.includes('stop app caddy')), false);
      }
    });
  }
});

test('confirmed pre-release rewrites preserve restorable old source identity', async (t) => {
  const cases = [
    ['modified', (fixture) => {
      writeFileSync(join(fixture.directory, migrationPath), 'SELECT 999;\n');
      return '0001_initial.sql';
    }],
    ['renamed', (fixture) => {
      rmSync(join(fixture.directory, migrationPath));
      writeFileSync(join(fixture.directory, 'apps/api/migrations/0001_renamed.sql'), 'SELECT 1;\n');
      return '0001_renamed.sql';
    }],
    ['removed and replaced', (fixture) => {
      rmSync(join(fixture.directory, migrationPath));
      writeFileSync(join(fixture.directory, 'apps/api/migrations/0002_replacement.sql'), 'SELECT 2;\n');
      return '0002_replacement.sql';
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const oldManifest = readFileSync(join(state, 'generations', 'seed', 'migrations.sha256'), 'utf8');
      const newDatabaseMigration = mutate(fixture);
      const rewritten = run(fixture, [
        '--env-file', fixture.environmentPath,
        '--db-mode', 'rewrite',
        '--confirm-rewrite', project,
        '--admin-password-file', passwordFile(fixture),
      ], {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
        FAKE_ADMIN_EXISTS: '0',
      });
      assert.equal(rewritten.status, 0, rewritten.output);
      const [oldBundle] = backupBundles(fixture);
      assert.ok(oldBundle);
      assert.match(readFileSync(join(oldBundle, 'metadata'), 'utf8'), /databaseState=current/);
      assert.equal(readFileSync(join(oldBundle, 'state', 'current', 'migrations.sha256'), 'utf8'), oldManifest);

      for (const entry of readdirSync(join(fixture.directory, 'apps/api/migrations'))) {
        rmSync(join(fixture.directory, 'apps/api/migrations', entry), { recursive: true, force: true });
      }
      writeFileSync(join(fixture.directory, migrationPath), '-- initial schema\nSELECT 1;\n');
      writeFileSync(fixture.commandLog, '');
      const restored = run(fixture, [...commonPersistArgs(fixture),
        '--restore-backup', oldBundle, '--confirm-restore', project], {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_SCHEMA_MIGRATIONS: newDatabaseMigration,
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
      });
      assert.equal(restored.status, 0, restored.output);
      const current = join(state, readlinkSync(join(state, 'current')));
      assert.equal(readFileSync(join(current, 'migrations.sha256'), 'utf8'), oldManifest);
      assert.equal(existsSync(join(state, 'pending')), false);
    });
  }
});

test('interrupted rewrite binds the replacement database to candidate pending state', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  writeFileSync(join(fixture.directory, migrationPath), 'SELECT 999;\n');
  const rewritten = run(fixture, [
    '--env-file', fixture.environmentPath,
    '--db-mode', 'rewrite',
    '--confirm-rewrite', project,
    '--admin-password-file', passwordFile(fixture),
  ], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_ADMIN_EXISTS: '0',
    FAKE_CURL_FAIL: '1',
  });
  assert.notEqual(rewritten.status, 0);
  assert.ok(existsSync(join(state, 'rewrite-replacement')));
  assert.ok(existsSync(join(state, 'pending', 'migrations.sha256')));
  assert.equal(readlinkSync(join(state, 'current')), 'generations/seed');

  writeFileSync(fixture.commandLog, '');
  const resumed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(resumed.status, 0, resumed.output);
  assert.equal(existsSync(join(state, 'rewrite-replacement')), false);
  assert.equal(existsSync(join(state, 'pending')), false);
  assert.notEqual(readlinkSync(join(state, 'current')), 'generations/seed');
});

test('interrupted restore publication recovers before ordinary state validation', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  assert.ok(bundle);
  assert.ok(existsSync(join(bundle, 'state', 'pending')), 'fixture must cover bundled pending discard');

  const pending = join(state, 'pending');
  mkdirSync(pending);
  writeFileSync(join(pending, 'deployed-sha'), `${gitSha}\n`);
  writeFileSync(join(pending, 'migrations.sha256'),
    `${hashFile(join(fixture.directory, migrationPath))}  ${migrationPath}\n` +
    `${'d'.repeat(64)}  apps/api/migrations/0002_unrelated.sql\n`);
  writeFileSync(fixture.commandLog, '');
  const restoreArgs = [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project];
  const interrupted = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION: 'after-current',
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.output, /publication interruption/i);
  const transaction = join(state, 'restore-transaction');
  assert.ok(existsSync(transaction));
  assert.ok(existsSync(pending), 'failure should expose the mixed pair guarded by the durable transaction');

  cpSync(join(transaction, 'current'), join(transaction, 'pending'), { recursive: true });
  writeFileSync(fixture.commandLog, '');
  const tampered = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
  });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.output, /current-selected.*unexpected pending state/i);
  rmSync(join(transaction, 'pending'), { recursive: true });

  writeFileSync(fixture.commandLog, '');
  const recovered = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
  });
  assert.equal(recovered.status, 0, recovered.output);
  assert.match(recovered.output, /Recovered interrupted restore state publication/i);
  assert.equal(existsSync(join(state, 'restore-transaction')), false);
  assert.equal(existsSync(pending), false);
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false,
    'publication recovery must not restore the database a second time');
});

test('database-restored recovery rejects a missing or replaced destination volume', async (t) => {
  for (const replacement of ['missing', 'same-name replacement']) {
    await t.test(replacement, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const deployed = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.equal(deployed.status, 0, deployed.output);
      const [bundle] = backupBundles(fixture);
      const before = stateSnapshot(state);
      writeFileSync(fixture.commandLog, '');
      const restoreArgs = [...commonPersistArgs(fixture),
        '--restore-backup', bundle, '--confirm-restore', project];
      const interrupted = run(fixture, restoreArgs, {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
        SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION: 'before-current',
      });
      assert.notEqual(interrupted.status, 0);
      const transaction = join(state, 'restore-transaction');
      assert.equal(readFileSync(join(transaction, 'phase'), 'utf8').trim(), 'database-restored');
      rmSync(`${fixture.commandLog}.volume-created`, { force: true });
      writeFileSync(fixture.commandLog, '');
      const retryEnvironment = replacement === 'missing'
        ? { FAKE_GIT_SHA: 'f'.repeat(40) }
        : {
            FAKE_EXISTING_VOLUMES: dbVolume,
            FAKE_GIT_SHA: 'f'.repeat(40),
            FAKE_VOLUME_IDENTITY: '2026-08-10T00:00:00Z|/var/lib/docker/volumes/replacement/_data',
          };
      const rejected = run(fixture, restoreArgs, retryEnvironment);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.output, /volume.*(?:disappeared|identity changed)/i);
      assert.deepEqual(stateSnapshot(state), before);
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
      assert.equal(lines.some((line) => line.includes('up -d app caddy')), false);
    });
  }
});

test('current-selected recovery discards bundled and live pending state across publication interruptions', async (t) => {
  for (const interruption of ['before-current', 'after-current']) {
    await t.test(interruption, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const deployed = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.equal(deployed.status, 0, deployed.output);
      const [bundle] = backupBundles(fixture);
      assert.ok(existsSync(join(bundle, 'state', 'pending')));
      const livePending = join(state, 'pending');
      mkdirSync(livePending);
      writeFileSync(join(livePending, 'deployed-sha'), `${gitSha}\n`);
      writeFileSync(join(livePending, 'migrations.sha256'),
        `${hashFile(join(fixture.directory, migrationPath))}  ${migrationPath}\n`);
      const restoreArgs = [...commonPersistArgs(fixture),
        '--restore-backup', bundle, '--confirm-restore', project];
      writeFileSync(fixture.commandLog, '');
      const interrupted = run(fixture, restoreArgs, {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_GIT_SHA: 'f'.repeat(40),
        FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
        SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION: interruption,
      });
      assert.notEqual(interrupted.status, 0);
      writeFileSync(fixture.commandLog, '');
      const recovered = run(fixture, restoreArgs, {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_GIT_SHA: 'f'.repeat(40),
      });
      assert.equal(recovered.status, 0, recovered.output);
      assert.equal(existsSync(livePending), false);
      assert.equal(existsSync(join(state, 'rewrite-replacement')), false);
      assert.equal(existsSync(join(state, 'restore-transaction')), false);
      assert.equal(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
    });
  }
});

test('pending-selected restore recovers after marker publication removes old pending state', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  assert.ok(bundle);

  const pendingPath = 'apps/api/migrations/0002_pending.sql';
  writeFileSync(join(fixture.directory, pendingPath), '-- pending schema\nSELECT 2;\n');
  const pendingManifest = `${hashFile(join(fixture.directory, migrationPath))}  ${migrationPath}\n` +
    `${hashFile(join(fixture.directory, pendingPath))}  ${pendingPath}\n`;
  writeFileSync(join(bundle, 'state', 'current', 'deployed-sha'), `${'d'.repeat(40)}\n`);
  const bundlePending = join(bundle, 'state', 'pending');
  writeFileSync(join(bundlePending, 'deployed-sha'), `${'e'.repeat(40)}\n`);
  writeFileSync(join(bundlePending, 'migrations.sha256'), pendingManifest);
  writeFileSync(join(bundle, 'metadata'), `schemaVersion=1\nproject=${project}\ndatabaseState=pending\n`);
  writeFileSync(join(bundle, 'database-migrations.txt'), '0001_initial.sql\n');

  const livePending = join(state, 'pending');
  mkdirSync(livePending, { mode: 0o700 });
  writeFileSync(join(livePending, 'deployed-sha'), `${'f'.repeat(40)}\n`);
  writeFileSync(join(livePending, 'migrations.sha256'), pendingManifest);
  const restoreArgs = [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project];
  writeFileSync(fixture.commandLog, '');
  const interrupted = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_GIT_SOURCE_PATHS: `${migrationPath},${pendingPath}`,
    FAKE_GIT_BASELINE_SOURCE_PATHS: migrationPath,
    SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION: 'after-pending-removal',
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.output, /pending state removal/i);
  assert.ok(existsSync(join(state, 'rewrite-replacement')));
  assert.equal(existsSync(livePending), false);
  assert.ok(existsSync(join(state, 'restore-transaction')));

  writeFileSync(fixture.commandLog, '');
  const recovered = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_GIT_SOURCE_PATHS: `${migrationPath},${pendingPath}`,
    FAKE_GIT_BASELINE_SOURCE_PATHS: migrationPath,
  });
  assert.equal(recovered.status, 0, recovered.output);
  assert.match(recovered.output, /Recovered interrupted restore state publication/i);
  assert.equal(readFileSync(join(livePending, 'migrations.sha256'), 'utf8'), pendingManifest);
  assert.equal(readFileSync(join(livePending, 'deployed-sha'), 'utf8').trim(), 'f'.repeat(40));
  assert.equal(existsSync(join(state, 'rewrite-replacement')), true);
  assert.equal(existsSync(join(state, 'restore-transaction')), false);
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false,
    'publication recovery must not restore the database a second time');
});

test('pending-only source-bound bundle stages no invented current baseline', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  rmSync(join(bundle, 'state', 'current'), { recursive: true });
  writeFileSync(join(bundle, 'metadata'), `schemaVersion=1\nproject=${project}\ndatabaseState=pending\n`);
  writeFileSync(fixture.commandLog, '');
  const restored = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
  });
  assert.equal(restored.status, 0, restored.output);
  assert.equal(existsSync(join(state, 'current')), false);
  assert.equal(existsSync(join(state, 'pending')), true);
  assert.equal(existsSync(join(state, 'rewrite-replacement')), true);
});

test('interrupted pending restore rejects a symlinked optional current baseline', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  writeFileSync(join(bundle, 'metadata'), `schemaVersion=1\nproject=${project}\ndatabaseState=pending\n`);
  const restoreArgs = [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project];
  writeFileSync(fixture.commandLog, '');
  const interrupted = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    SKY_BAR_TEST_FAIL_RESTORE: 'after-transaction',
  });
  assert.notEqual(interrupted.status, 0);
  const transaction = join(fixture.directory, '.demo-state', project, 'restore-transaction');
  const transactionCurrent = join(transaction, 'current');
  rmSync(transactionCurrent, { recursive: true });
  symlinkSync(join(bundle, 'state', 'current'), transactionCurrent);

  writeFileSync(fixture.commandLog, '');
  const rejected = run(fixture, restoreArgs, { FAKE_EXISTING_VOLUMES: dbVolume });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /current baseline.*directory.*symbolic link/i);
  const lines = dockerLines(fixture);
  assert.equal(lines.some((line) => line.includes('stop app caddy')), false);
  assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
  assert.equal(lines.some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false);
});

test('pending-selected restore rejects an incompatible bundled current baseline', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  const pendingPath = 'apps/api/migrations/0002_pending.sql';
  writeFileSync(join(fixture.directory, pendingPath), 'SELECT 2;\n');
  writeFileSync(join(bundle, 'state', 'current', 'deployed-sha'), `${'d'.repeat(40)}\n`);
  const bundlePending = join(bundle, 'state', 'pending');
  writeFileSync(join(bundlePending, 'deployed-sha'), `${'e'.repeat(40)}\n`);
  writeFileSync(join(bundlePending, 'migrations.sha256'),
    `${hashFile(join(fixture.directory, pendingPath))}  ${pendingPath}\n`);
  writeFileSync(join(bundle, 'metadata'), `schemaVersion=1\nproject=${project}\ndatabaseState=pending\n`);
  writeFileSync(join(bundle, 'database-migrations.txt'), '');
  writeFileSync(fixture.commandLog, '');
  const rejected = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_GIT_SOURCE_PATHS: pendingPath,
    FAKE_GIT_BASELINE_SOURCE_PATHS: migrationPath,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /current baseline.*pending candidate/i);
  const lines = dockerLines(fixture);
  assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
  assert.equal(existsSync(join(fixture.directory, '.demo-state', project, 'restore-transaction')), false);
});

test('restoring-phase retry is bound to the original bundle and reuses its safety backup', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  assert.ok(bundle);
  const restoreArgs = [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project];
  writeFileSync(fixture.commandLog, '');
  const interrupted = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_FAIL_MATCH: 'pg_restore -U',
  });
  assert.notEqual(interrupted.status, 0);
  const transaction = join(fixture.directory, '.demo-state', project, 'restore-transaction');
  assert.equal(readFileSync(join(transaction, 'phase'), 'utf8').trim(), 'restoring');
  const afterSafety = backupBundles(fixture).length;
  assert.equal(afterSafety, 2);

  const copiedBundle = `${bundle}-copy`;
  cpSync(bundle, copiedBundle, { recursive: true });
  writeFileSync(fixture.commandLog, '');
  const wrongRetry = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', copiedBundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
  });
  assert.notEqual(wrongRetry.status, 0);
  assert.match(wrongRetry.output, /original.*bundle|restore transaction|identity/i);
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_dump')), false);

  const safetyBundle = readFileSync(join(transaction, 'safety-backup-path'), 'utf8').trim();
  const safetyDump = join(safetyBundle, 'database.dump');
  const safetyDigest = join(safetyBundle, 'dump.sha256');
  const originalSafetyDump = readFileSync(safetyDump);
  const originalSafetyDigest = readFileSync(safetyDigest);
  writeFileSync(safetyDump, Buffer.concat([originalSafetyDump, Buffer.from('altered')]));
  writeFileSync(safetyDigest, `${hashFile(safetyDump)}  database.dump\n`);
  writeFileSync(fixture.commandLog, '');
  const alteredSafetyRetry = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
  });
  assert.notEqual(alteredSafetyRetry.status, 0);
  assert.match(alteredSafetyRetry.output, /safety backup identity changed/i);
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')), false,
    'an altered safety bundle must fail before destructive target restore');
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_dump')), false);
  writeFileSync(safetyDump, originalSafetyDump);
  writeFileSync(safetyDigest, originalSafetyDigest);

  writeFileSync(fixture.commandLog, '');
  const resumed = run(fixture, restoreArgs, {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
  });
  assert.equal(resumed.status, 0, resumed.output);
  assert.equal(backupBundles(fixture).length, afterSafety);
  assert.equal(dockerLines(fixture).some((line) => line.includes('pg_dump')), false,
    'restoring retry must reuse the completed safety backup');
  assert.ok(dockerLines(fixture).some((line) => line.includes('pg_restore -U skybar -d skybar') && !line.includes('--list')));
  assert.equal(existsSync(transaction), false);
});

test('older bundle rollback preserves a safety bundle for the later live migration state', (t) => {
  const fixture = makeFixture(t);
  seedState(fixture);
  const first = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(first.status, 0, first.output);
  const [olderBundle] = backupBundles(fixture);
  assert.ok(olderBundle);

  writeFileSync(join(fixture.directory, 'apps/api/migrations/0002_forward.sql'), 'SELECT 2;\n');
  writeFileSync(fixture.commandLog, '');
  const later = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql',
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(later.status, 0, later.output);
  writeFileSync(join(olderBundle, 'state', 'current', 'deployed-sha'), `${'e'.repeat(40)}\n`);

  const beforeRestore = new Set(backupBundles(fixture));
  writeFileSync(fixture.commandLog, '');
  const restored = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', olderBundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_GIT_SHA: 'f'.repeat(40),
    FAKE_SCHEMA_MIGRATIONS: '0001_initial.sql\n0002_forward.sql',
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
  });
  assert.equal(restored.status, 0, restored.output);
  const restoredCurrent = join(fixture.directory, '.demo-state', project,
    readlinkSync(join(fixture.directory, '.demo-state', project, 'current')));
  assert.equal(readFileSync(join(restoredCurrent, 'deployed-sha'), 'utf8').trim(), 'e'.repeat(40));
  assert.doesNotMatch(readFileSync(join(restoredCurrent, 'migrations.sha256'), 'utf8'), /0002_forward\.sql/);
  const safetyBundles = backupBundles(fixture).filter((bundle) => !beforeRestore.has(bundle));
  assert.equal(safetyBundles.length, 1);
  assert.match(readFileSync(join(safetyBundles[0], 'metadata'), 'utf8'), /databaseState=current/);
  assert.match(readFileSync(join(safetyBundles[0], 'state', 'current', 'migrations.sha256'), 'utf8'),
    /0002_forward\.sql/);
  assert.deepEqual(readFileSync(join(safetyBundles[0], 'database-migrations.txt'), 'utf8').trim().split('\n'),
    ['0001_initial.sql', '0002_forward.sql']);
});

test('completed restore retirement is crash-recoverable and removes previous pending state', (t) => {
  const fixture = makeFixture(t);
  const state = seedState(fixture);
  const deployed = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(deployed.status, 0, deployed.output);
  const [bundle] = backupBundles(fixture);
  const livePending = join(state, 'pending');
  mkdirSync(livePending, { mode: 0o700 });
  writeFileSync(join(livePending, 'deployed-sha'), `${gitSha}\n`);
  writeFileSync(join(livePending, 'migrations.sha256'),
    `${hashFile(join(fixture.directory, migrationPath))}  ${migrationPath}\n`);
  writeFileSync(fixture.commandLog, '');
  const interrupted = run(fixture, [...commonPersistArgs(fixture),
    '--restore-backup', bundle, '--confirm-restore', project], {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_RESTORED_SCHEMA_MIGRATIONS: '0001_initial.sql',
    SKY_BAR_TEST_FAIL_RESTORE_RETIREMENT: 'after-rename',
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.output, /retirement interruption/i);
  assert.equal(existsSync(join(state, 'restore-transaction')), false);
  const [retirement] = readdirSync(state)
    .filter((name) => /^\.restore-transaction-completed\.\d+\.\d+$/.test(name));
  assert.ok(retirement);
  assert.ok(existsSync(join(state, retirement, 'previous-pending')));

  writeFileSync(fixture.commandLog, '');
  const recovered = run(fixture, commonPersistArgs(fixture), {
    FAKE_EXISTING_VOLUMES: dbVolume,
    FAKE_ADMIN_EXISTS: '1',
  });
  assert.equal(recovered.status, 0, recovered.output);
  assert.equal(existsSync(join(state, retirement)), false);
  assert.equal(readdirSync(state).some((name) => name.startsWith('.restore-transaction-completed.')), false);
  assert.equal(existsSync(livePending), false);
});

test('completed restore retirement recovery rejects matching malformed entries', async (t) => {
  for (const kind of ['file', 'symlink', 'malformed directory']) {
    await t.test(kind, (st) => {
      const fixture = makeFixture(st);
      const state = seedState(fixture);
      const retirement = join(state, '.restore-transaction-completed.12.34');
      if (kind === 'file') writeFileSync(retirement, 'not a transaction\n');
      else if (kind === 'symlink') symlinkSync('generations/seed', retirement);
      else mkdirSync(retirement, { mode: 0o700 });
      writeFileSync(fixture.commandLog, '');
      const rejected = run(fixture, commonPersistArgs(fixture), {
        FAKE_EXISTING_VOLUMES: dbVolume,
        FAKE_ADMIN_EXISTS: '1',
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.output, kind === 'malformed directory'
        ? /completed restore transaction phase record.*regular/i
        : /completed restore transaction retirement.*directory.*symbolic link/i);
      assert.ok(existsSync(retirement));
      const lines = dockerLines(fixture);
      assert.equal(lines.some((line) => /\b(up|run|exec|stop)\b/.test(line)), false);
      assert.equal(lines.some((line) => line.includes('DROP DATABASE')), false);
    });
  }
});
