import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { normalizeGithubIssue } from './github.mjs';
import { parseChecklist } from './checklists.mjs';
import { captureSource, classifySourceDrift, refreshSource, validateSourceDescriptor } from './source.mjs';

const AT = '2026-08-17T00:00:00.000Z';
const LATER = '2026-08-18T00:00:00.000Z';
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function repository(t, files = { 'plan.md': '# Plan\n\n- [ ] Work\n' }) {
  const cwd = await mkdtemp(join(tmpdir(), 'change-source-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  run(cwd, ['init', '-q']);
  run(cwd, ['config', 'user.name', 'Source Test']);
  run(cwd, ['config', 'user.email', 'source@example.test']);
  for (const [path, value] of Object.entries(files)) await writeFile(join(cwd, path), value);
  run(cwd, ['add', '.']); run(cwd, ['commit', '-qm', 'base']);
  return { cwd, sha: run(cwd, ['rev-parse', 'HEAD']) };
}

function rawIssue({ body = '- [ ] Work', state = 'OPEN', comments = [], updatedAt = AT } = {}) {
  return { id: 'I_22', number: 22, url: 'https://github.test/o/r/issues/22', title: 'Plan', body, state,
    author: { login: 'owner', id: 'U_1' }, createdAt: AT, updatedAt, comments,
    commentsComplete: true };
}
function comment(id, body) {
  return { id, body, createdAt: AT, updatedAt: AT, author: { login: 'writer', id: 'U_2' } };
}
function issueReader(raw) {
  return async ({ repository, issueNumber, capturedAt }) => normalizeGithubIssue(raw,
    { repository, issueNumber, capturedAt });
}

test('source descriptors reject mixed and unknown source fields', () => {
  assert.deepEqual(validateSourceDescriptor({ type: 'github-issue', repository: 'o/r', issueNumber: 22 }),
    { type: 'github-issue', repository: 'o/r', issueNumber: 22, relationshipIntent: 'reference-only' });
  assert.throws(() => validateSourceDescriptor({ type: 'github-issue', repository: 'o/r', issueNumber: 22, path: 'x' }),
    /unknown fields/u);
  assert.throws(() => validateSourceDescriptor({ type: 'partial-implementation' }), /comparisonBase/u);
});

test('captures direct UTF-8 requests and tracked repository plans at an exact clean Planning SHA', async (t) => {
  const { cwd, sha } = await repository(t);
  const requestDirectory = await mkdtemp(join(tmpdir(), 'direct-request-'));
  t.after(() => rm(requestDirectory, { recursive: true, force: true }));
  const requestPath = join(requestDirectory, 'request.md');
  await writeFile(requestPath, 'Please implement this.\n');
  const direct = await captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'direct-request', path: requestPath }, now: AT });
  assert.equal(direct.source.text, 'Please implement this.\n');
  assert.match(direct.digest, /^sha256:[0-9a-f]{64}$/u);

  const plan = await captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'repository-plan', path: 'plan.md' }, now: AT });
  assert.equal(plan.source.text, '# Plan\n\n- [ ] Work\n');
  assert.match(plan.source.blobSha, /^[0-9a-f]{40}$/u);

  await writeFile(requestPath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'direct-request', path: requestPath }, now: AT }), /not valid UTF-8/u);
  await assert.rejects(captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'repository-plan', path: 'missing.md' }, now: AT }), /not tracked/u);
});

test('refreshable sources can be captured from a later clean integrated checkout without changing Planning SHA authority', async (t) => {
  const { cwd, sha } = await repository(t);
  await writeFile(join(cwd, 'integrated.txt'), 'integrated\n');
  run(cwd, ['add', '.']); run(cwd, ['commit', '-qm', 'integrated']);
  const original = await captureSource({ cwd, planningSha: sha, requirePlanningCheckout: false,
    descriptor: { type: 'repository-plan', path: 'plan.md' }, now: AT });
  const refreshed = await refreshSource({ cwd, planningSha: sha, requirePlanningCheckout: false,
    descriptor: original.descriptor, previousObservation: original, now: LATER });
  assert.equal(refreshed.observation.planningSha, sha);
  assert.equal(refreshed.classification, 'unchanged');
});

test('partial implementation captures committed summary metadata but never a raw diff', async (t) => {
  const { cwd, sha: base } = await repository(t);
  await writeFile(join(cwd, 'plan.md'), '# Changed\n');
  await writeFile(join(cwd, 'new.txt'), 'secret implementation content\n');
  run(cwd, ['add', '.']); run(cwd, ['commit', '-qm', 'partial']);
  const planningSha = run(cwd, ['rev-parse', 'HEAD']);
  const observation = await captureSource({ cwd, planningSha,
    descriptor: { type: 'partial-implementation', comparisonBase: base }, now: AT });
  assert.equal(observation.source.commitCount, 1);
  assert.deepEqual(observation.source.changes.map(({ path }) => path), ['new.txt', 'plan.md']);
  assert.equal(JSON.stringify(observation).includes('secret implementation content'), false);
  assert.equal(Object.hasOwn(observation.source, 'diff'), false);
  const refreshed = await refreshSource({ cwd, planningSha,
    descriptor: { type: 'partial-implementation', comparisonBase: base },
    previousObservation: observation, now: LATER });
  assert.equal(refreshed.classification, 'unchanged');
  assert.equal(refreshed.checklistComparison, null);
});

test('GitHub observations have deterministic content receipts and preserve relationship intent', async (t) => {
  const { cwd, sha } = await repository(t);
  const descriptor = { type: 'github-issue', repository: 'o/r', issueNumber: 22, relationshipIntent: 'resolves' };
  const first = await captureSource({ cwd, planningSha: sha, descriptor, githubReader: issueReader(rawIssue()), now: AT });
  const second = await captureSource({ cwd, planningSha: sha, descriptor, githubReader: issueReader(rawIssue()), now: LATER });
  assert.equal(first.source.relationshipIntent, 'resolves');
  assert.equal(first.digest, second.digest);
  assert.equal(first.materialDigest, second.materialDigest);
  assert.equal(classifySourceDrift(first, second), 'unchanged');
});

test('only issue checkbox changes are progress-only; issue state, body, and comments are material', async (t) => {
  const { cwd, sha } = await repository(t);
  const descriptor = { type: 'github-issue', repository: 'o/r', issueNumber: 22 };
  const original = await captureSource({ cwd, planningSha: sha, descriptor,
    githubReader: issueReader(rawIssue({ comments: [comment('C1', 'one')] })), now: AT });
  const progress = await captureSource({ cwd, planningSha: sha, descriptor,
    githubReader: issueReader(rawIssue({ body: '- [x] Work',
      comments: [comment('C1', 'one')], updatedAt: LATER })), now: LATER });
  assert.equal(classifySourceDrift(original, progress), 'progress-only');

  for (const changed of [
    rawIssue({ state: 'CLOSED', comments: [comment('C1', 'one')], updatedAt: LATER }),
    rawIssue({ body: '- [ ] Different', comments: [comment('C1', 'one')], updatedAt: LATER }),
    rawIssue({ comments: [comment('C1', 'edited')], updatedAt: LATER }),
    rawIssue({ comments: [], updatedAt: LATER }),
    rawIssue({ comments: [comment('C1', 'one'), comment('C2', 'new')], updatedAt: LATER }),
  ]) {
    const observation = await captureSource({ cwd, planningSha: sha, descriptor,
      githubReader: issueReader(changed), now: LATER });
    assert.equal(classifySourceDrift(original, observation), 'unreviewed-material');
  }
});

test('direct-request and repository-plan checkboxes share progress and mapping semantics', async (t) => {
  const { cwd, sha } = await repository(t);
  const requestDirectory = await mkdtemp(join(tmpdir(), 'direct-request-'));
  t.after(() => rm(requestDirectory, { recursive: true, force: true }));
  const requestPath = join(requestDirectory, 'request.md');
  await writeFile(requestPath, '# Request\n\n- [ ] Work\n');
  const directDescriptor = { type: 'direct-request', path: requestPath };
  const direct = await captureSource({ cwd, planningSha: sha, descriptor: directDescriptor, now: AT });
  await writeFile(requestPath, '# Request\n\n- [x] Work\n');
  const directRefresh = await refreshSource({ cwd, planningSha: sha, descriptor: directDescriptor,
    previousObservation: direct, now: LATER });
  assert.equal(directRefresh.classification, 'progress-only');
  assert.equal(directRefresh.checklistComparison.status, 'matched');
  assert.deepEqual(directRefresh.checklistComparison.changes.map(({ kind }) => kind), ['progress']);

  const planDescriptor = { type: 'repository-plan', path: 'plan.md' };
  const plan = await captureSource({ cwd, planningSha: sha, descriptor: planDescriptor, now: AT });
  const checkedPlan = structuredClone(plan);
  checkedPlan.source.text = checkedPlan.source.text.replace('- [ ]', '- [x]');
  checkedPlan.source.checklist = parseChecklist(checkedPlan.source.text);
  checkedPlan.source.textDigest = `sha256:${'a'.repeat(64)}`;
  checkedPlan.source.blobSha = 'b'.repeat(40);
  assert.equal(classifySourceDrift(plan, checkedPlan), 'progress-only');
  const planRefresh = await refreshSource({ cwd, planningSha: sha, descriptor: planDescriptor,
    previousObservation: plan, now: LATER });
  assert.equal(planRefresh.classification, 'unchanged');
  assert.equal(planRefresh.checklistComparison.status, 'matched');
});

test('refresh returns drift and checklist mapping without mutating the prior observation', async (t) => {
  const { cwd, sha } = await repository(t);
  const descriptor = { type: 'github-issue', repository: 'o/r', issueNumber: 22 };
  const previousObservation = await captureSource({ cwd, planningSha: sha, descriptor,
    githubReader: issueReader(rawIssue()), now: AT });
  const snapshot = structuredClone(previousObservation);
  const result = await refreshSource({ cwd, planningSha: sha, descriptor, previousObservation,
    githubReader: issueReader(rawIssue({ body: '- [x] Work', updatedAt: LATER })), now: LATER });
  assert.equal(result.classification, 'progress-only');
  assert.equal(result.checklistComparison.status, 'matched');
  assert.deepEqual(previousObservation, snapshot);
});

test('dirty or symbolic Planning snapshots fail closed', async (t) => {
  const { cwd, sha } = await repository(t);
  const requestDirectory = await mkdtemp(join(tmpdir(), 'direct-request-'));
  t.after(() => rm(requestDirectory, { recursive: true, force: true }));
  const path = join(requestDirectory, 'request.md'); await writeFile(path, 'request');
  await assert.rejects(captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'direct-request', path }, now: '2026-08-17' }),
  (error) => error.code === 'INVALID_CAPTURE_TIME');
  await assert.rejects(captureSource({ cwd, planningSha: sha,
    descriptor: { type: 'direct-request', path }, now: new Date(Number.NaN) }),
  (error) => error.code === 'INVALID_CAPTURE_TIME');
  await assert.rejects(captureSource({ cwd, planningSha: 'HEAD', descriptor: { type: 'direct-request', path }, now: AT }),
    /explicit full commit SHA/u);
  await writeFile(join(cwd, 'dirty.txt'), 'dirty');
  await assert.rejects(captureSource({ cwd, planningSha: sha, descriptor: { type: 'direct-request', path }, now: AT }),
    /current, committed, and clean/u);
});
