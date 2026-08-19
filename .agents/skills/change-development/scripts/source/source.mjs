import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { blobAtPath, gitBuffer, gitText, readTreeFile, resolveCommit, runGit } from '../../../../../scripts/lib/git.mjs';
import { compareChecklistMappings, normalizeChecklistProgress, parseChecklist } from './checklists.mjs';
import { isRfc3339DateTime, readGithubIssue } from './github.mjs';

const SOURCE_TYPES = new Set(['github-issue', 'direct-request', 'repository-plan', 'partial-implementation']);
const RELATIONSHIPS = new Set(['reference-only', 'partial', 'resolves']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class SourceCaptureError extends Error {
  constructor(message, code = 'SOURCE_CAPTURE_ERROR') { super(message); this.name = 'SourceCaptureError'; this.code = code; }
}

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined)
    .sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

function withoutReceipts(observation) {
  const { digest: ignoredDigest, materialDigest: ignoredMaterial, progressDigest: ignoredProgress,
    capturedAt: ignoredCapturedAt, ...content } = observation;
  return content.sourceType === 'github-issue'
    ? { ...content, source: { ...content.source, capturedAt: undefined } } : content;
}

function materialProjection(observation) {
  const base = withoutReceipts(observation);
  if (!Array.isArray(base.source?.checklist)) return base;
  const source = base.source;
  const projected = { ...source, checklist: source.checklist.map(({ checked, ...entry }) => entry) };
  if (typeof source.body === 'string') {
    projected.body = normalizeChecklistProgress(source.body);
    projected.bodyDigest = undefined;
    projected.updatedAt = undefined;
    projected.capturedAt = undefined;
  } else if (typeof source.text === 'string') {
    projected.text = normalizeChecklistProgress(source.text);
    projected.textDigest = undefined;
    projected.blobSha = undefined;
  }
  return { ...base, source: projected };
}

function progressProjection(observation) {
  if (!Array.isArray(observation.source?.checklist)) return { sourceType: observation.sourceType };
  return { sourceType: observation.sourceType,
    checklist: observation.source.checklist.map(({ id, checked }) => ({ id, checked })) };
}

export function sourceObservationDigest(observation) { return digest(withoutReceipts(observation)); }
export function materialDigest(observation) { return digest(materialProjection(observation)); }
export function progressDigest(observation) { return digest(progressProjection(observation)); }

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new SourceCaptureError(`${label} must be a non-empty single-line string`, 'INVALID_SOURCE_DESCRIPTOR');
  }
  return value;
}

function safeRepositoryPath(value, label) {
  requiredString(value, label);
  if (isAbsolute(value) || value.split(/[\\/]/u).includes('..')) {
    throw new SourceCaptureError(`${label} must be a repository-relative path`, 'INVALID_SOURCE_DESCRIPTOR');
  }
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertExactKeys(descriptor, allowed) {
  const unknown = Object.keys(descriptor).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new SourceCaptureError(`source descriptor has unknown fields: ${unknown.sort().join(', ')}`,
      'INVALID_SOURCE_DESCRIPTOR');
  }
}

export function validateSourceDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || !SOURCE_TYPES.has(descriptor.type)) {
    throw new SourceCaptureError('source descriptor type is invalid', 'INVALID_SOURCE_DESCRIPTOR');
  }
  const relationshipIntent = descriptor.relationshipIntent ?? 'reference-only';
  if (!RELATIONSHIPS.has(relationshipIntent)) throw new SourceCaptureError('relationshipIntent is invalid', 'INVALID_SOURCE_DESCRIPTOR');
  if (descriptor.type === 'github-issue') {
    assertExactKeys(descriptor, ['type', 'repository', 'issueNumber', 'relationshipIntent']);
    const repository = requiredString(descriptor.repository, 'repository');
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new SourceCaptureError('repository must be owner/name', 'INVALID_SOURCE_DESCRIPTOR');
    const issueNumber = Number(descriptor.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new SourceCaptureError('issueNumber must be a positive integer', 'INVALID_SOURCE_DESCRIPTOR');
    return { type: descriptor.type, repository, issueNumber, relationshipIntent };
  }
  if (descriptor.type === 'direct-request') {
    assertExactKeys(descriptor, ['type', 'path', 'relationshipIntent']);
    return { type: descriptor.type, path: requiredString(descriptor.path, 'path'), relationshipIntent };
  }
  if (descriptor.type === 'repository-plan') {
    assertExactKeys(descriptor, ['type', 'path', 'relationshipIntent']);
    return { type: descriptor.type, path: safeRepositoryPath(descriptor.path, 'path'), relationshipIntent };
  }
  assertExactKeys(descriptor, ['type', 'comparisonBase', 'relationshipIntent']);
  return { type: descriptor.type, comparisonBase: requiredString(descriptor.comparisonBase, 'comparisonBase'), relationshipIntent };
}

function assertPlanningSnapshot(cwd, planningSha, requireCheckout = true) {
  const resolved = resolveCommit(cwd, requiredString(planningSha, 'planningSha'));
  if (planningSha !== resolved) throw new SourceCaptureError('Planning SHA must be an explicit full commit SHA', 'INVALID_PLANNING_SNAPSHOT');
  if (requireCheckout) {
    const head = resolveCommit(cwd, 'HEAD');
    const dirty = gitBuffer(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
    if (head !== resolved || dirty.length > 0) throw new SourceCaptureError('Planning snapshot must be current, committed, and clean', 'INVALID_PLANNING_SNAPSHOT');
  }
  return resolved;
}

function decodeUtf8(bytes, label) {
  try { return UTF8.decode(bytes); } catch { throw new SourceCaptureError(`${label} is not valid UTF-8`, 'INVALID_UTF8_SOURCE'); }
}

function requestPath(cwd, path) {
  const target = resolve(cwd, path);
  const relation = relative(cwd, target);
  return { target, displayPath: relation && !relation.startsWith(`..${sep}`) ? relation : target };
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]; const path = fields[index++];
    if (!status || path === undefined) throw new SourceCaptureError('Git diff summary was truncated', 'PARTIAL_DIFF_FAILED');
    if (/^[RC]/u.test(status)) {
      const newPath = fields[index++];
      if (newPath === undefined) throw new SourceCaptureError('Git rename summary was truncated', 'PARTIAL_DIFF_FAILED');
      changes.push({ status, path, newPath });
    } else changes.push({ status, path });
  }
  return changes;
}

async function captureContent({ cwd, planningSha, descriptor, githubReader, capturedAt }) {
  if (descriptor.type === 'github-issue') {
    const reader = githubReader ?? readGithubIssue;
    const issue = await reader({ repository: descriptor.repository, issueNumber: descriptor.issueNumber, capturedAt });
    return { ...issue, relationshipIntent: descriptor.relationshipIntent };
  }
  if (descriptor.type === 'direct-request') {
    const { target, displayPath } = requestPath(cwd, descriptor.path);
    const text = decodeUtf8(await readFile(target), 'Direct request');
    return { path: displayPath, text, textDigest: digest(text), checklist: parseChecklist(text) };
  }
  if (descriptor.type === 'repository-plan') {
    if (blobAtPath(cwd, planningSha, descriptor.path) === null) {
      throw new SourceCaptureError('Repository plan is not tracked as a file at the Planning SHA', 'SOURCE_NOT_TRACKED');
    }
    const bytes = readTreeFile(cwd, planningSha, descriptor.path);
    if (bytes === null) throw new SourceCaptureError('Repository plan is not tracked at the Planning SHA', 'SOURCE_NOT_TRACKED');
    const text = decodeUtf8(bytes, 'Repository plan');
    return { path: descriptor.path, blobSha: gitText(['rev-parse', `${planningSha}:${descriptor.path}`], { cwd }),
      text, textDigest: digest(text), checklist: parseChecklist(text) };
  }
  const comparisonBaseSha = resolveCommit(cwd, descriptor.comparisonBase);
  const ancestor = runGit(['merge-base', '--is-ancestor', comparisonBaseSha, planningSha], { cwd, allowFailure: true });
  if (ancestor.status !== 0) throw new SourceCaptureError('Partial implementation comparison base must be an ancestor', 'INVALID_COMPARISON_BASE');
  const changes = parseNameStatus(gitBuffer(['diff', '--name-status', '-z', '--find-renames', comparisonBaseSha, planningSha], { cwd }));
  if (changes.length === 0) throw new SourceCaptureError('Partial implementation has no committed changes', 'EMPTY_PARTIAL_IMPLEMENTATION');
  return { comparisonBaseSha, planningSha,
    commitCount: Number(gitText(['rev-list', '--count', `${comparisonBaseSha}..${planningSha}`], { cwd })),
    changes, summaryDigest: digest(changes) };
}

export async function captureSource({ cwd = process.cwd(), planningSha, descriptor, githubReader, now = () => new Date(), requirePlanningCheckout = true }) {
  const exactPlanningSha = assertPlanningSnapshot(cwd, planningSha, requirePlanningCheckout);
  const normalizedDescriptor = validateSourceDescriptor(descriptor);
  const capturedAt = typeof now === 'function' ? now() : now;
  if (capturedAt instanceof Date && !Number.isFinite(capturedAt.getTime())) {
    throw new SourceCaptureError('capture timestamp must be an RFC3339 date-time', 'INVALID_CAPTURE_TIME');
  }
  const timestamp = capturedAt instanceof Date ? capturedAt.toISOString() : String(capturedAt);
  if (!isRfc3339DateTime(timestamp)) {
    throw new SourceCaptureError('capture timestamp must be an RFC3339 date-time', 'INVALID_CAPTURE_TIME');
  }
  const observation = { schemaVersion: 1, sourceType: normalizedDescriptor.type, planningSha: exactPlanningSha,
    descriptor: normalizedDescriptor, capturedAt: timestamp,
    source: await captureContent({ cwd, planningSha: exactPlanningSha, descriptor: normalizedDescriptor, githubReader, capturedAt: timestamp }) };
  observation.materialDigest = materialDigest(observation);
  observation.progressDigest = progressDigest(observation);
  observation.digest = sourceObservationDigest(observation);
  return observation;
}

export function classifySourceDrift(previous, current) {
  if (!previous || !current) throw new TypeError('previous and current observations are required');
  if (previous.sourceType !== current.sourceType || previous.planningSha !== current.planningSha
      || canonical(previous.descriptor) !== canonical(current.descriptor)) return 'unreviewed-material';
  if (materialDigest(previous) !== materialDigest(current)) return 'unreviewed-material';
  if (progressDigest(previous) !== progressDigest(current)) return 'progress-only';
  return 'unchanged';
}

export async function refreshSource(options) {
  const current = await captureSource(options);
  const classification = classifySourceDrift(options.previousObservation, current);
  const checklistComparison = Array.isArray(options.previousObservation.source?.checklist)
      && Array.isArray(current.source?.checklist)
    ? compareChecklistMappings(options.previousObservation.source.checklist, current.source.checklist) : null;
  return { observation: current, classification, checklistComparison };
}
