import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  KNOWN_PROJECTS,
  planRelatedE2E,
  readFeatureTags,
  runRelatedE2E,
} from '../../scripts/run-related-e2e.mjs';

const featureDirectory = new URL('../../specs/features', import.meta.url).pathname;
const playwrightConfig = new URL('../../playwright.config.ts', import.meta.url).pathname;
const quietLogger = { log() {}, error() {} };

test('every scenario has exactly one globally unique stable id', () => {
  const files = readdirSync(featureDirectory, { recursive: true })
    .filter((name) => name.endsWith('.feature'))
    .map((name) => ({ name, source: readFileSync(join(featureDirectory, name), 'utf8') }));

  const ids = new Map();
  let scenarioCount = 0;
  for (const { name, source } of files) {
    const lines = source.split(/\r?\n/);
    let pendingTags = [];
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith('@')) {
        pendingTags.push(...trimmed.split(/\s+/));
      } else if (/^Scenario(?: Outline)?:/.test(trimmed)) {
        scenarioCount += 1;
        const scenarioIds = pendingTags.filter((tag) => /^@id-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag));
        assert.equal(scenarioIds.length, 1, `${name}:${index + 1} must have exactly one @id- tag`);
        const [id] = scenarioIds;
        assert.equal(ids.has(id), false, `${id} is also used at ${ids.get(id)}`);
        ids.set(id, `${name}:${index + 1}`);
        pendingTags = [];
      } else if (trimmed && !trimmed.startsWith('#')) {
        pendingTags = [];
      }
    }
  }

  assert.ok(scenarioCount > 0, 'the Playwright feature tree must contain scenarios');
  assert.equal(ids.size, scenarioCount);
});

test('requires at least one selector and does not invoke a command', () => {
  const calls = [];
  assert.equal(runRelatedE2E([], {
    featureDirectory,
    runner: (...args) => calls.push(args),
    logger: quietLogger,
  }), 2);
  assert.deepEqual(calls, []);
});

test('declares the supported area and execution-scope tags', () => {
  const tags = readFeatureTags(featureDirectory);
  for (const tag of [
    '@area-auth', '@area-access', '@area-ordering', '@area-billing',
    '@area-management', '@area-localization', '@area-pwa', '@area-security',
    '@device-responsive', '@browser-webkit', '@browser-firefox', '@cross-device',
  ]) {
    assert.equal(tags.has(tag), true, `${tag} must be declared in a feature file`);
  }
});

test('builds the exact Cucumber OR expression and defaults to tablet Chromium', () => {
  const plan = planRelatedE2E([
    '--id', 'an-administrator-signs-in-and-sees-the-configured-venue',
    '--tag=area-auth',
  ], featureDirectory);
  assert.equal(plan.tagExpression, '@id-an-administrator-signs-in-and-sees-the-configured-venue or @area-auth');
  assert.deepEqual(plan.projects, ['tablet-chromium']);
});

test('accepts repeatable known projects', () => {
  const plan = planRelatedE2E([
    '--tag', 'device-responsive',
    '--project', 'mobile-webkit',
    '--project=desktop-firefox',
  ], featureDirectory);
  assert.deepEqual(plan.projects, ['mobile-webkit', 'desktop-firefox']);
  assert.deepEqual(KNOWN_PROJECTS, ['tablet-chromium', 'mobile-webkit', 'desktop-firefox']);
});

test('known project names stay aligned with Playwright configuration', () => {
  const source = readFileSync(playwrightConfig, 'utf8');
  const configuredProjects = [...source.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(configuredProjects, [...KNOWN_PROJECTS]);
});

test('rejects empty, unknown, and unsafe selectors and projects', () => {
  for (const arguments_ of [
    ['--id', ''],
    ['--tag', 'area-does-not-exist'],
    ['--tag', 'area-auth or @area-ordering'],
    ['--project', 'chromium'],
    ['--project', 'tablet-chromium;true'],
    ['--wat', 'area-auth'],
  ]) {
    assert.throws(() => planRelatedE2E(arguments_, featureDirectory));
  }
});

test('runs filtered generation once, then only the selected projects', () => {
  const calls = [];
  const status = runRelatedE2E([
    '--id', 'an-administrator-signs-in-and-sees-the-configured-venue',
    '--project', 'mobile-webkit',
  ], {
    featureDirectory,
    logger: quietLogger,
    runner(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ['bddgen', ['test', '--tags', '@id-an-administrator-signs-in-and-sees-the-configured-venue']],
    ['playwright', ['test', '--project', 'mobile-webkit']],
  ]);
  assert.equal(calls.flat(3).includes('--pass-with-no-tests'), false);
});

test('propagates generation failure without an unfiltered retry or Playwright run', () => {
  const calls = [];
  const status = runRelatedE2E(['--tag', 'area-auth'], {
    featureDirectory,
    logger: quietLogger,
    runner(command, args) {
      calls.push([command, args]);
      return { status: 7 };
    },
  });
  assert.equal(status, 7);
  assert.deepEqual(calls, [['bddgen', ['test', '--tags', '@area-auth']]]);
});
