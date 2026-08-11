import {
  GitError,
  assertSafeGitValue,
  blobAtPath,
  gitText,
  isAncestor,
  listTree,
  readTreeFile,
  resolveCommit,
  runGit,
} from './git.mjs';

export const RELEASE_STATE_SCHEMA_VERSION = 1;
export const PRODUCT = 'aerstello';
export const DEFAULT_RELEASE_REF = 'origin/main';
export const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const MARKER_PREFIX = '.release/markers/';
const MIGRATION_PREFIX = 'apps/api/migrations/';

export class ReleaseStateOperationalError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ReleaseStateOperationalError';
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function releaseError(code, message, details = {}) {
  return { code, message, ...details };
}

function isValidReleasedAt(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(RELEASED_AT_PATTERN);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth && !Number.isNaN(Date.parse(value));
}

export function validateReleaseMarker(marker, { expectedTag } = {}) {
  const errors = [];
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
    return ['Marker must be a JSON object'];
  }
  const keys = new Set(Object.keys(marker));
  for (const key of ['schemaVersion', 'product', 'version', 'tag', 'channel', 'releasedAt']) {
    if (!keys.has(key)) errors.push(`Missing required field ${key}`);
  }
  for (const key of keys) {
    if (!['schemaVersion', 'product', 'version', 'tag', 'channel', 'releasedAt'].includes(key)) {
      errors.push(`Unsupported field ${key}`);
    }
  }
  if (marker.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (marker.product !== PRODUCT) errors.push(`product must equal ${PRODUCT}`);
  if (typeof marker.version !== 'string' || !STABLE_VERSION_PATTERN.test(marker.version)) {
    errors.push('version must be a stable MAJOR.MINOR.PATCH version');
  }
  if (typeof marker.tag !== 'string' || !STABLE_TAG_PATTERN.test(marker.tag)) {
    errors.push('tag must be vMAJOR.MINOR.PATCH');
  }
  if (typeof marker.version === 'string' && typeof marker.tag === 'string' && marker.tag !== `v${marker.version}`) {
    errors.push('tag must equal v plus version');
  }
  if (expectedTag && marker.tag !== expectedTag) errors.push(`tag must equal ${expectedTag}`);
  if (marker.channel !== 'production') errors.push('channel must equal production');
  if (!isValidReleasedAt(marker.releasedAt)) {
    errors.push('releasedAt must be a valid ISO-8601 date-time');
  }
  return errors;
}

function parseMarker(buffer, path, expectedTag) {
  let marker;
  try {
    marker = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return {
      marker: null,
      errors: [`Marker is not valid JSON: ${error.message}`],
      path,
    };
  }
  return { marker, errors: validateReleaseMarker(marker, { expectedTag }), path };
}

function stableTags(cwd) {
  const text = gitText(['for-each-ref', '--format=%(refname)', 'refs/tags'], { cwd });
  if (!text) return [];
  return text
    .split('\n')
    .filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length))
    .filter((tag) => STABLE_TAG_PATTERN.test(tag))
    .sort();
}

function migrationsAt(cwd, commit) {
  return listTree(cwd, commit, MIGRATION_PREFIX)
    .filter((entry) => (
      entry.type === 'blob'
      && entry.path.startsWith(MIGRATION_PREFIX)
      && entry.path.endsWith('.sql')
    ))
    .map((entry) => ({ path: entry.path, blob: entry.object }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function markerFilesAt(cwd, commit) {
  return listTree(cwd, commit, MARKER_PREFIX)
    .filter((entry) => entry.type === 'blob' && entry.path.endsWith('.json'))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeRelease(release) {
  return {
    version: release.version,
    tag: release.tag,
    commit: release.commit,
    releasedAt: release.releasedAt,
  };
}

export function inspectReleaseState({
  cwd = process.cwd(),
  base = DEFAULT_RELEASE_REF,
  head = 'HEAD',
  releaseRef = DEFAULT_RELEASE_REF,
  requireTag,
} = {}) {
  try {
    assertSafeGitValue(base, 'Base ref');
    assertSafeGitValue(head, 'Head ref');
    assertSafeGitValue(releaseRef, 'Release ref');
    if (requireTag !== undefined) assertSafeGitValue(requireTag, 'Required tag');

    const baseSha = resolveCommit(cwd, base);
    const headSha = resolveCommit(cwd, head);
    const releaseSha = resolveCommit(cwd, releaseRef);
    const tags = stableTags(cwd);
    const tagSet = new Set(tags);
    const errors = [];
    const validReleases = [];

    for (const tag of tags) {
      const tagRef = `refs/tags/${tag}`;
      const typeResult = runGit(['cat-file', '-t', tagRef], { cwd, allowFailure: true });
      const objectType = typeResult.status === 0 ? String(typeResult.stdout).trim() : null;
      if (objectType !== 'tag') {
        errors.push(releaseError(
          'LIGHTWEIGHT_RELEASE_TAG',
          `${tag} is not an annotated tag`,
          { tag },
        ));
        continue;
      }

      const commit = resolveCommit(cwd, tagRef);
      if (!isAncestor(cwd, commit, releaseSha)) {
        errors.push(releaseError(
          'RELEASE_TAG_NOT_REACHABLE',
          `${tag} is not reachable from ${releaseRef}`,
          { tag, commit, releaseRef },
        ));
        continue;
      }

      const markerPath = `${MARKER_PREFIX}${tag}.json`;
      const markerBuffer = readTreeFile(cwd, commit, markerPath);
      if (markerBuffer === null) {
        errors.push(releaseError(
          'RELEASE_MARKER_MISSING',
          `${tag} does not contain ${markerPath}`,
          { tag, commit, path: markerPath },
        ));
        continue;
      }

      const parsed = parseMarker(markerBuffer, markerPath, tag);
      if (parsed.errors.length > 0) {
        errors.push(releaseError(
          'RELEASE_MARKER_INVALID',
          `${markerPath} is invalid: ${parsed.errors.join('; ')}`,
          { tag, commit, path: markerPath, validationErrors: parsed.errors },
        ));
        continue;
      }

      validReleases.push({
        version: parsed.marker.version,
        tag,
        commit,
        releasedAt: parsed.marker.releasedAt,
        migrations: migrationsAt(cwd, commit),
      });
    }

    validReleases.sort((left, right) => compareVersions(left.version, right.version));

    const pendingMarkers = [];
    for (const entry of markerFilesAt(cwd, headSha)) {
      const fileName = entry.path.slice(MARKER_PREFIX.length, -'.json'.length);
      if (!STABLE_TAG_PATTERN.test(fileName)) {
        errors.push(releaseError(
          'RELEASE_MARKER_PATH_INVALID',
          `${entry.path} must be named ${MARKER_PREFIX}vMAJOR.MINOR.PATCH.json`,
          { path: entry.path },
        ));
        continue;
      }
      if (tagSet.has(fileName)) continue;
      const buffer = readTreeFile(cwd, headSha, entry.path);
      const parsed = parseMarker(buffer, entry.path, fileName);
      pendingMarkers.push({
        path: entry.path,
        tag: fileName,
        version: parsed.marker?.version ?? fileName.slice(1),
        valid: parsed.errors.length === 0,
        errors: parsed.errors,
      });
      if (parsed.errors.length > 0) {
        errors.push(releaseError(
          'PENDING_MARKER_INVALID',
          `${entry.path} is invalid: ${parsed.errors.join('; ')}`,
          { path: entry.path, tag: fileName, validationErrors: parsed.errors },
        ));
      }
    }

    const frozenByPath = new Map();
    for (const release of validReleases) {
      for (const migration of release.migrations) {
        const existing = frozenByPath.get(migration.path);
        if (!existing) {
          frozenByPath.set(migration.path, {
            path: migration.path,
            firstReleasedIn: release.tag,
            blob: migration.blob,
          });
        } else if (existing.blob !== migration.blob) {
          errors.push(releaseError(
            'FROZEN_MIGRATION_HISTORY_CONFLICT',
            `${migration.path} has different content in ${existing.firstReleasedIn} and ${release.tag}`,
            {
              path: migration.path,
              firstTag: existing.firstReleasedIn,
              firstBlob: existing.blob,
              conflictingTag: release.tag,
              conflictingBlob: migration.blob,
            },
          ));
        }
      }
    }

    if (requireTag) {
      if (!STABLE_TAG_PATTERN.test(requireTag)) {
        errors.push(releaseError(
          'REQUIRED_TAG_NOT_STABLE',
          `${requireTag} is not a stable vMAJOR.MINOR.PATCH tag`,
          { tag: requireTag },
        ));
      } else if (!validReleases.some((release) => release.tag === requireTag)) {
        errors.push(releaseError(
          'REQUIRED_RELEASE_TAG_INVALID',
          `${requireTag} is not a valid production release`,
          { tag: requireTag },
        ));
      }
    }

    const latest = validReleases.at(-1) ?? null;
    const baseReleases = validReleases
      .filter((release) => isAncestor(cwd, release.commit, baseSha))
      .map(summarizeRelease);
    const headContainsReleaseBaseline = latest
      ? isAncestor(cwd, latest.commit, headSha)
      : true;
    const status = errors.length > 0
      ? 'inconsistent'
      : latest === null
        ? 'pre-release'
        : headContainsReleaseBaseline
          ? 'released'
          : 'stale';

    return {
      schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
      product: PRODUCT,
      status,
      baseSha,
      headSha,
      releaseRef,
      releaseRefSha: releaseSha,
      latestRelease: latest ? summarizeRelease(latest) : null,
      applicableRelease: latest ? summarizeRelease(latest) : null,
      baseReleases,
      headContainsReleaseBaseline,
      pendingMarkers,
      frozenMigrations: [...frozenByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
      errors,
    };
  } catch (error) {
    if (error instanceof ReleaseStateOperationalError) throw error;
    if (error instanceof GitError || error instanceof SyntaxError) {
      throw new ReleaseStateOperationalError(error.message, error);
    }
    throw error;
  }
}

export function checkReleasedMigrations(options = {}) {
  const state = inspectReleaseState(options);
  const violations = [];
  if (state.status === 'inconsistent') {
    violations.push({
      code: 'RELEASE_STATE_INCONSISTENT',
      message: 'Release metadata is inconsistent; migration policy cannot be evaluated safely',
    });
  }
  if (state.status === 'stale') {
    violations.push({
      code: 'HEAD_MISSING_RELEASE_BASELINE',
      message: `Head ${state.headSha} does not contain release baseline ${state.latestRelease.tag}`,
      tag: state.latestRelease.tag,
      commit: state.latestRelease.commit,
    });
  }
  for (const migration of state.frozenMigrations) {
    const actualBlob = blobAtPath(options.cwd ?? process.cwd(), state.headSha, migration.path);
    if (actualBlob === null) {
      violations.push({
        code: 'RELEASED_MIGRATION_DELETED',
        message: `${migration.path} was released in ${migration.firstReleasedIn} and may not be deleted`,
        path: migration.path,
        expectedBlob: migration.blob,
      });
    } else if (actualBlob !== migration.blob) {
      violations.push({
        code: 'RELEASED_MIGRATION_MODIFIED',
        message: `${migration.path} was released in ${migration.firstReleasedIn} and may not be modified`,
        path: migration.path,
        expectedBlob: migration.blob,
        actualBlob,
      });
    }
  }
  return { ok: violations.length === 0, releaseState: state, violations };
}

export function formatReleaseState(state) {
  const lines = [
    `Release status: ${state.status}`,
    `Release ref: ${state.releaseRef} (${state.releaseRefSha})`,
    `Base: ${state.baseSha}`,
    `Head: ${state.headSha}`,
  ];
  if (state.latestRelease) {
    lines.push(`Latest release: ${state.latestRelease.tag} (${state.latestRelease.commit})`);
  } else {
    lines.push('Latest release: none');
  }
  lines.push(`Frozen migrations: ${state.frozenMigrations.length}`);
  lines.push(`Pending markers: ${state.pendingMarkers.length}`);
  for (const error of state.errors) lines.push(`ERROR ${error.code}: ${error.message}`);
  return `${lines.join('\n')}\n`;
}
