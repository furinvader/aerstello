#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KNOWN_PROJECTS = Object.freeze([
  'tablet-chromium',
  'mobile-webkit',
  'desktop-firefox',
]);

const DEFAULT_PROJECTS = Object.freeze(['tablet-chromium']);
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function readFeatureTags(featureDirectory = resolve('specs/features')) {
  const tags = new Set();
  const directories = [featureDirectory];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.feature')) continue;
      const source = readFileSync(entryPath, 'utf8');
      for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('@')) continue;
        for (const tag of trimmed.split(/\s+/)) {
          if (/^@[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) tags.add(tag);
        }
      }
    }
  }
  return tags;
}

function readValue(arguments_, index, option) {
  const argument = arguments_[index];
  const equalsAt = argument.indexOf('=');
  if (equalsAt !== -1) {
    const value = argument.slice(equalsAt + 1);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 0 };
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return { value, consumed: 1 };
}

function normalizeSlug(rawValue, option) {
  const value = rawValue.startsWith('@') ? rawValue.slice(1) : rawValue;
  if (!SAFE_SLUG.test(value)) {
    throw new Error(`${option} contains an unsafe selector: ${rawValue}`);
  }
  return value;
}

export function planRelatedE2E(arguments_, featureDirectory = resolve('specs/features')) {
  const selectors = [];
  const projects = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const option = argument.split('=', 1)[0];
    if (!['--id', '--tag', '--project'].includes(option)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const { value, consumed } = readValue(arguments_, index, option);
    index += consumed;

    if (option === '--project') {
      const project = normalizeSlug(value, option);
      if (!KNOWN_PROJECTS.includes(project)) {
        throw new Error(`unknown project: ${value}`);
      }
      projects.push(project);
      continue;
    }

    const slug = normalizeSlug(value, option);
    selectors.push(option === '--id' && !slug.startsWith('id-') ? `@id-${slug}` : `@${slug}`);
  }

  if (selectors.length === 0) {
    throw new Error('at least one --id or --tag selector is required');
  }

  const knownTags = readFeatureTags(featureDirectory);
  for (const selector of selectors) {
    if (!knownTags.has(selector)) throw new Error(`unknown selector: ${selector}`);
  }

  const uniqueSelectors = [...new Set(selectors)];
  const uniqueProjects = projects.length > 0 ? [...new Set(projects)] : [...DEFAULT_PROJECTS];
  return {
    selectors: uniqueSelectors,
    projects: uniqueProjects,
    tagExpression: uniqueSelectors.join(' or '),
  };
}

function execute(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' });
}

export function runRelatedE2E(arguments_, options = {}) {
  const featureDirectory = options.featureDirectory ?? resolve('specs/features');
  const runner = options.runner ?? execute;
  const logger = options.logger ?? console;
  let plan;
  try {
    plan = planRelatedE2E(arguments_, featureDirectory);
  } catch (error) {
    logger.error(`Related E2E refused: ${error.message}`);
    return 2;
  }

  logger.log(`Related E2E scope: ${plan.selectors.join(', ')} | projects: ${plan.projects.join(', ')}`);
  const generation = runner('bddgen', ['test', '--tags', plan.tagExpression]);
  if (generation.error) {
    logger.error(`Related E2E failed: could not start bddgen (${generation.error.message})`);
    return 1;
  }
  if (generation.status !== 0) {
    logger.error(`Related E2E failed: bddgen exited with status ${generation.status ?? 'unknown'}`);
    return generation.status ?? 1;
  }

  const projectArguments = plan.projects.flatMap((project) => ['--project', project]);
  const test = runner('playwright', ['test', ...projectArguments]);
  if (test.error) {
    logger.error(`Related E2E failed: could not start Playwright (${test.error.message})`);
    return 1;
  }
  if (test.status !== 0) {
    logger.error(`Related E2E failed: Playwright exited with status ${test.status ?? 'unknown'}`);
    return test.status ?? 1;
  }

  logger.log(`Related E2E passed: ${plan.selectors.length} selector(s), ${plan.projects.length} project(s)`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runRelatedE2E(process.argv.slice(2));
