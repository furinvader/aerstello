import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeState,
  loadState,
  stateDirectory,
} from '../../scripts/lib/pr-review-state.mjs';
import { createRepository, git } from './git-fixtures.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = join(testDirectory, '..', '..');
const hooksDirectory = join(repositoryDirectory, '.codex', 'hooks');
const repositories = [];

function repo() {
  const cwd = createRepository();
  repositories.push(cwd);
  return cwd;
}

function runHook(name, input, cwd = repositoryDirectory) {
  const result = spawnSync(process.execPath, [join(hooksDirectory, name)], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function init(cwd) {
  return initializeState({
    cwd,
    prNumber: 23,
    base: 'main',
    head: 'HEAD',
    releaseRef: 'main',
  });
}

function validWorkerResult() {
  return {
    schemaVersion: 2,
    taskId: 'task-1',
    status: 'implemented',
    commitSha: 'a'.repeat(40),
    changedPaths: ['src/example.ts'],
    validation: [{ command: 'npm test -- example', result: 'passed', summary: 'Focused test passed.' }],
    resolutionSummary: 'Resolved the bounded finding.',
    residualRisks: [],
    unexpectedDependencies: [],
  };
}

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop(), { recursive: true, force: true });
});

test('SessionStart without state is a valid no-op', () => {
  const cwd = repo();
  assert.deepEqual(runHook('session-start.mjs', {
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd,
  }, cwd), { continue: true });
});

test('SessionStart with state injects compact additional context', () => {
  const cwd = repo();
  init(cwd);
  const output = runHook('session-start.mjs', {
    hook_event_name: 'SessionStart',
    source: 'resume',
    cwd,
  }, cwd);
  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /example\/sky-bar#23/u);
  assert.ok(output.hookSpecificOutput.additionalContext.length < 9000);
});

test('PreCompact preserves evidence-identical state and refreshes an exact backup', () => {
  const cwd = repo();
  const state = init(cwd);
  const eventPath = join(stateDirectory(cwd, 23), 'events.ndjson');
  const events = readFileSync(eventPath, 'utf8');
  const output = runHook('pre-compact.mjs', {
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    cwd,
  }, cwd);
  assert.equal(output.continue, true);
  assert.deepEqual(loadState(cwd), state);
  assert.equal(readFileSync(eventPath, 'utf8'), events);
  const backupPath = join(stateDirectory(cwd, 23), 'state.backup.json');
  assert.ok(existsSync(backupPath));
  assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf8')), state);
});

test('valid worker result is accepted', () => {
  const output = runHook('subagent-stop.mjs', {
    hook_event_name: 'SubagentStop',
    agent_type: 'review_fix_worker',
    stop_hook_active: false,
    last_assistant_message: JSON.stringify(validWorkerResult()),
  });
  assert.deepEqual(output, { continue: true });
});

test('invalid worker result requests one correction', () => {
  const output = runHook('subagent-stop.mjs', {
    hook_event_name: 'SubagentStop',
    agent_type: 'review_fix_worker',
    stop_hook_active: false,
    last_assistant_message: 'not json',
  });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /corrected raw JSON/u);
});

test('repeated invalid worker result does not loop indefinitely', () => {
  const output = runHook('subagent-stop.mjs', {
    hook_event_name: 'SubagentStop',
    agent_type: 'review_fix_worker',
    stop_hook_active: true,
    last_assistant_message: '{}',
  });
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /after one correction attempt/u);
});

test('unrelated subagent types are unaffected', () => {
  const output = runHook('subagent-stop.mjs', {
    hook_event_name: 'SubagentStop',
    agent_type: 'integration_verifier',
    stop_hook_active: false,
    last_assistant_message: 'not json',
  });
  assert.deepEqual(output, { continue: true });
});
