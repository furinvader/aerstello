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
if (process.env.FAKE_FAIL_MATCH && joined.includes(process.env.FAKE_FAIL_MATCH)) {
  process.stderr.write('injected failure: ' + process.env.FAKE_FAIL_MATCH + '\n');
  process.exit(41);
}
if (tool === 'git') {
  if (args[0] === 'status' && process.env.FAKE_GIT_DIRTY === '1') process.stdout.write(' M dirty-file\n');
  else if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) process.stdout.write(process.env.FAKE_REPOSITORY_ROOT + '\n');
  else if (args[0] === 'rev-parse') process.stdout.write(process.env.FAKE_GIT_SHA + '\n');
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
  if (!existing.includes(name)) process.exit(1);
  if (args.includes('--format')) process.stdout.write((process.env.FAKE_VOLUME_PROJECT || 'sky-bar-demo') + '\n');
  else process.stdout.write('[{}]\n');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm') process.exit(0);
const command = args.join(' ');
if (/\bps\b/.test(command) && (args.includes('-q') || args.includes('--quiet'))) process.stdout.write('fake-container-id\n');
else if (/\binspect\b/.test(command) && command.includes('State.Health.Status')) process.stdout.write('healthy\n');
else if (/\bps\b/.test(command) && command.includes('--services')) process.stdout.write('db\napp\ncaddy\n');
else if ((/\bexec\b/.test(command) || /\brun\b/.test(command)) && /\bpsql\b/.test(command)) {
  process.stdout.write(process.env.FAKE_ADMIN_EXISTS === '0' ? '0\n' : '1\n');
} else if (/\bpg_dump\b/.test(command)) {
  process.stdout.write('PGDMP fake custom-format backup\n');
} else if (/\bpg_restore\b/.test(command)) {
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
  mkdirSync(join(directory, 'deploy/caddy'), { recursive: true });
  copyFileSync(join(repositoryRoot, 'scripts/demo-deploy.sh'), join(directory, 'scripts/demo-deploy.sh'));
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
  for (const tool of ['docker', 'curl', 'git']) {
    const path = join(fakeBin, tool);
    writeFileSync(path, fakeExecutableSource(), { mode: 0o755 });
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
  return { ...result, output: `${result.stdout}${result.stderr}` };
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
  assert.ok(readdirSync(join(fixture.directory, '.demo-backups', project)).some((name) => name.endsWith('.dump')));
  const state = join(fixture.directory, '.demo-state', project);
  assert.notEqual(stateSnapshot(state).current, 'generations/seed');
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
