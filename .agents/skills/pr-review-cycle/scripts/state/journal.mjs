import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteText } from './atomic-io.mjs';
import { StateError } from './errors.mjs';
import { stateDirectory } from './locations.mjs';
import { withStateLock } from './locks.mjs';

function utcNow() { return new Date().toISOString(); }

export function prepareEvent({ type, summary, details } = {}) {
  if (typeof type !== 'string' || type.length < 1 || type.length > 128
      || typeof summary !== 'string' || summary.length < 1 || summary.length > 1000) {
    throw new StateError('Events require a concise type and summary', 'INVALID_EVENT');
  }
  const event = { schemaVersion: 1, type, summary, at: utcNow() };
  if (details !== undefined) {
    const serialized = JSON.stringify(details);
    if (serialized.length > 4000 || /(?:rawLog|stackTrace|transcript|fullDiff)/iu.test(serialized)) {
      throw new StateError('Event details must be concise and may not contain raw artifacts', 'INVALID_EVENT');
    }
    event.details = details;
  }
  return event;
}

export function appendEvent(cwd, prNumber, input = {}) {
  const event = prepareEvent(input);
  const directory = stateDirectory(cwd, prNumber);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'events.ndjson');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  atomicWriteText(path, `${existing}${JSON.stringify(event)}\n`);
}

export function ensureGitHubMutationIntent(cwd, prNumber, intent) {
  if (!intent || typeof intent.operationId !== 'string' || intent.operationId.length === 0
      || typeof intent.type !== 'string' || intent.type.length === 0
      || typeof intent.clientMutationId !== 'string' || intent.clientMutationId.length === 0
      || typeof intent.at !== 'string' || !Number.isFinite(Date.parse(intent.at))) {
    throw new StateError('GitHub mutation intent is invalid', 'INVALID_EVENT');
  }
  return withStateLock(cwd, prNumber, () => {
    const path = join(stateDirectory(cwd, prNumber), 'events.ndjson');
    let events = [];
    if (existsSync(path)) {
      try {
        events = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        throw new StateError('GitHub mutation intent journal is malformed', 'INTENT_RECOVERY_INVALID');
      }
    }
    const found = events.find((event) => event.type === 'github-mutation-intent' && event.details?.operationId === intent.operationId);
    if (found) {
      if (!found.details || found.details.type !== intent.type
          || found.details.operationId !== intent.operationId
          || typeof found.details.clientMutationId !== 'string'
          || found.details.clientMutationId !== intent.clientMutationId
          || typeof found.details.at !== 'string' || !Number.isFinite(Date.parse(found.details.at))) {
        throw new StateError('GitHub mutation intent conflicts', 'INTENT_CONFLICT');
      }
      return { ...found.details, isNew: false };
    }
    appendEvent(cwd, prNumber, { type: 'github-mutation-intent', summary: `Intent ${intent.type} ${intent.operationId}`.slice(0, 1000), details: intent });
    return { ...intent, isNew: true };
  });
}
