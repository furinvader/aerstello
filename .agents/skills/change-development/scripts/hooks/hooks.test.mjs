import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { changeDirectory, initializeState, loadState } from '../state/state.mjs';
import { initializeState as initializePrState, loadState as loadPrState } from '../../../pr-review-cycle/scripts/state/state.mjs';

const directory = new URL('.', import.meta.url);

function hook(name, cwd, input = { cwd }) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(name, directory))], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function validImplementationResult() {
  return {
    schemaVersion: 1,
    changeId: 'issue-23',
    taskId: 'worker-layer',
    planDigest: `sha256:${'a'.repeat(64)}`,
    packetDigest: `sha256:${'b'.repeat(64)}`,
    specialization: 'ops-workflow',
    taskBaseSha: 'c'.repeat(40),
    status: 'implemented',
    workerCommit: 'd'.repeat(40),
    changedPaths: ['scripts/example.mjs'],
    validation: [{ command: 'node --test scripts/example.test.mjs', result: 'passed', summary: 'Focused test passed.' }],
    unexpectedDependencies: [],
    summary: 'Implemented the bound worker layer.',
  };
}

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'active change hooks '));
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Hook Test');
  git(cwd, 'config', 'user.email', 'hooks@example.invalid');
  writeFileSync(join(cwd, 'request.md'), '# Hook request\n'); git(cwd, 'add', 'request.md');
  git(cwd, 'commit', '-m', 'test: seed hook repository');
  return { cwd, sha: git(cwd, 'rev-parse', 'HEAD') };
}

function runConcurrent(path, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('change-development hooks fail open when no state exists, including paths with spaces', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'change hooks '));
  const session = hook('session-start.mjs', cwd);
  const compact = hook('pre-compact.mjs', cwd);
  assert.equal(session.status, 0);
  assert.equal(compact.status, 0);
  assert.equal(JSON.parse(session.stdout).continue, true);
  assert.equal(JSON.parse(compact.stdout).continue, true);
  assert.ok(session.stdout.length < 10_000);
});

test('hooks are exact no-ops in a genuine repository with no change state', () => {
  const { cwd } = repository();
  for (const name of ['session-start.mjs', 'pre-compact.mjs']) {
    const result = hook(name, cwd);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
  }
});

test('active hooks emit bounded context and PreCompact checkpoints only local Git evidence', async () => {
  const { cwd, sha } = repository();
  await initializeState({ cwd, changeId: 'hook-change', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'direct-request', path: 'request.md', relationshipIntent: 'reference-only' } });
  const session = hook('session-start.mjs', cwd);
  assert.equal(session.status, 0);
  const context = JSON.parse(session.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /hook-change/u); assert.ok(context.length <= 9000);

  writeFileSync(join(cwd, 'dirty.txt'), 'local drift');
  const compact = hook('pre-compact.mjs', cwd);
  assert.equal(compact.status, 0);
  assert.equal(JSON.parse(compact.stdout).continue, true);
  const state = loadState(cwd);
  assert.equal(state.phase, 'blocked');
  assert.match(state.blockedReasons[0], /Planning SHA/u);

  const prHook = fileURLToPath(new URL('../../../pr-review-cycle/scripts/hooks/session-start.mjs', import.meta.url));
  const concurrent = spawnSync(process.execPath, [prHook], { cwd, input: JSON.stringify({ cwd }), encoding: 'utf8' });
  assert.equal(concurrent.status, 0);
  assert.equal(JSON.parse(concurrent.stdout).continue, true);
});

test('PR and change hook pairs run concurrently against separate durable roots', async () => {
  const { cwd, sha } = repository();
  await initializeState({ cwd, changeId: 'concurrent-hooks', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'direct-request', path: 'request.md', relationshipIntent: 'reference-only' } });
  initializePrState({ cwd, prNumber: 23, repository: 'example/aerstello', base: 'main', head: 'HEAD', releaseRef: 'main' });
  const changeBefore = loadState(cwd); const prBefore = loadPrState(cwd);
  const changeHooks = ['session-start.mjs', 'pre-compact.mjs'].map((name) => fileURLToPath(new URL(name, import.meta.url)));
  const prHooks = ['session-start.mjs', 'pre-compact.mjs'].map((name) => fileURLToPath(new URL(`../../../pr-review-cycle/scripts/hooks/${name}`, import.meta.url)));
  const results = await Promise.all([...changeHooks, ...prHooks].map((path) => runConcurrent(path, cwd, { cwd })));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).continue, true);
  }
  assert.deepEqual(loadState(cwd), changeBefore);
  assert.deepEqual(loadPrState(cwd), prBefore);
});

test('PreCompact fails open without advancing state when durable evidence is corrupt', async () => {
  const { cwd, sha } = repository();
  await initializeState({ cwd, changeId: 'corrupt-hook', mode: 'plan-only', baseBranch: 'main', planningRef: sha,
    source: { type: 'direct-request', path: 'request.md', relationshipIntent: 'reference-only' } });
  const before = loadState(cwd);
  const observation = join(changeDirectory(cwd, 'corrupt-hook'), 'source', 'initial.json');
  const tampered = JSON.parse(readFileSync(observation, 'utf8')); tampered.capturedAt = '2026-08-17T00:00:00.000Z';
  writeFileSync(observation, JSON.stringify(tampered));
  const output = JSON.parse(hook('pre-compact.mjs', cwd).stdout);
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /not checkpointed/u);
  assert.deepEqual(loadState(cwd), before);
});

test('implementation worker stop hook accepts exact raw result JSON', () => {
  const output = JSON.parse(hook('subagent-stop.mjs', process.cwd(), {
    agent_type: 'implementation_worker', last_assistant_message: JSON.stringify(validImplementationResult()),
  }).stdout);
  assert.deepEqual(output, { continue: true });
});

test('implementation worker stop hook accepts fail-closed discovery and rejects authority-expanding success', () => {
  const discovery = {
    schemaVersion: 1, summary: 'An unowned state path is required.',
    evidence: [{ kind: 'state-path', identity: '.agents/skills/change-development/scripts/state/state.mjs',
      detail: 'The packet does not own the lifecycle state module.' }],
    triggeredTripwireIds: ['state-paths'],
    requestedAuthority: [{ field: 'paths', values: ['.agents/skills/change-development/scripts/state/state.mjs'] }],
  };
  const blocked = validImplementationResult();
  Object.assign(blocked, { status: 'blocked', workerCommit: null, changedPaths: [], validation: [],
    unexpectedDependencies: [discovery.summary], scopeDiscovery: discovery });
  assert.deepEqual(JSON.parse(hook('subagent-stop.mjs', process.cwd(), {
    agent_type: 'implementation_worker', last_assistant_message: JSON.stringify(blocked),
  }).stdout), { continue: true });

  const expanded = validImplementationResult();
  Object.assign(expanded, { unexpectedDependencies: [discovery.summary], scopeDiscovery: discovery });
  const output = JSON.parse(hook('subagent-stop.mjs', process.cwd(), {
    agent_type: 'implementation_worker', stop_hook_active: false,
    last_assistant_message: JSON.stringify(expanded),
  }).stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /corrected raw JSON implementation-result/u);
});

test('implementation worker stop hook requests one correction and then warns without looping', () => {
  const first = JSON.parse(hook('subagent-stop.mjs', process.cwd(), {
    agent_type: 'implementation_worker', stop_hook_active: false, last_assistant_message: 'not json',
  }).stdout);
  assert.equal(first.decision, 'block'); assert.match(first.reason, /corrected raw JSON implementation-result/u);
  const second = JSON.parse(hook('subagent-stop.mjs', process.cwd(), {
    agent_type: 'implementation_worker', stop_hook_active: true, last_assistant_message: '{}',
  }).stdout);
  assert.equal(second.continue, true); assert.match(second.systemMessage, /after one correction attempt/u);
});

test('implementation worker stop hook ignores every other exact agent type', () => {
  for (const agent_type of ['review_fix_worker', 'behavior_mapper', 'implementation-worker', '']) {
    const output = JSON.parse(hook('subagent-stop.mjs', process.cwd(), { agent_type, last_assistant_message: 'not json' }).stdout);
    assert.deepEqual(output, { continue: true });
  }
});
