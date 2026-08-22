import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CANONICAL_LOGIN,
  CANONICAL_URL,
  actorObservation,
  isCanonicalActor,
  isViewerActor,
} from './actors.mjs';

const BOT = {
  __typename: 'Bot', login: CANONICAL_LOGIN, url: CANONICAL_URL, id: 'BOT_codex',
};
const VIEWER = {
  __typename: 'User', login: 'maintainer', url: 'https://github.com/maintainer', id: 'USER_1',
};

test('canonical Codex actor requires the exact Bot type, login, URL, and node identity', () => {
  assert.equal(isCanonicalActor(BOT), true);
  for (const actor of [
    null,
    { ...BOT, __typename: 'User' },
    { ...BOT, login: 'other-bot' },
    { ...BOT, url: 'https://github.com/apps/other-bot' },
  ]) assert.equal(isCanonicalActor(actor), false);

  assert.throws(
    () => isCanonicalActor({ ...BOT, id: undefined }),
    { name: 'GitHubWorkflowError', code: 'CANONICAL_ACTOR_INCOMPLETE', message: 'Canonical Bot actor has no node ID' },
  );
});

test('viewer actor recovery binds the current viewer login and node identity', () => {
  assert.equal(isViewerActor(VIEWER, VIEWER), true);
  assert.equal(isViewerActor({ ...VIEWER, id: 'USER_2' }, VIEWER), false);
  assert.equal(isViewerActor({ ...VIEWER, login: 'other' }, VIEWER), false);
  assert.equal(isViewerActor({ ...VIEWER, __typename: 'Bot', url: 'https://example.test/changed' }, VIEWER), true);
  assert.throws(
    () => isViewerActor({ ...VIEWER, id: undefined }, VIEWER),
    { name: 'GitHubWorkflowError', code: 'CANONICAL_ACTOR_INCOMPLETE', message: 'Viewer actor has no node ID' },
  );
});

test('actor observations retain the exact evidence shape without inventing identity', () => {
  assert.deepEqual(actorObservation(BOT), {
    type: 'Bot', login: CANONICAL_LOGIN, id: 'BOT_codex', url: CANONICAL_URL,
  });
  assert.deepEqual(actorObservation(null), { type: null, login: null, id: null, url: null });
  assert.deepEqual(actorObservation({ login: 'partial' }), {
    type: null, login: 'partial', id: null, url: null,
  });
});
