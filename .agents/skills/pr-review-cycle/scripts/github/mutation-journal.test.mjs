import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDefaultMutationJournal } from './mutation-journal.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aerstello-mutation-journal-'));
  const directory = join(root, 'state');
  mkdirSync(directory, { recursive: true });
  const calls = [];
  const operations = {
    stateDirectory(cwd, prNumber) {
      calls.push(['stateDirectory', cwd, prNumber]);
      return directory;
    },
    ensureGitHubMutationIntent(...args) {
      calls.push(['ensureGitHubMutationIntent', ...args]);
      return { ensured: true };
    },
    claimGitHubMutationDispatch(...args) {
      calls.push(['claimGitHubMutationDispatch', ...args]);
      return { claimed: true };
    },
    withGitHubRequestOwnerLock(...args) {
      calls.push(['withGitHubRequestOwnerLock', ...args]);
      return args[2]();
    },
  };
  return { root, directory, calls, operations };
}

test('looks up the first exact mutation intent and preserves malformed journal failure', () => {
  const setup = fixture();
  try {
    const path = join(setup.directory, 'events.ndjson');
    writeFileSync(path, [
      JSON.stringify({ type: 'other', details: { operationId: 'request:1' } }),
      JSON.stringify({ type: 'github-mutation-intent', details: { operationId: 'request:1', at: 'first' } }),
      JSON.stringify({ type: 'github-mutation-intent', details: { operationId: 'request:1', at: 'second' } }),
    ].join('\n'));
    const journal = createDefaultMutationJournal('/repo', 17, setup.operations);
    assert.deepEqual(journal.lookupIntent('request:1'), {
      operationId: 'request:1', at: 'first', isNew: false,
    });
    assert.equal(journal.lookupIntent('missing'), null);

    writeFileSync(path, '{not-json}\n');
    assert.throws(() => journal.lookupIntent('request:1'), SyntaxError);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test('returns null for a missing journal and forwards exact mutation authority', async () => {
  const setup = fixture();
  try {
    const journal = createDefaultMutationJournal('/repo', 17, setup.operations);
    assert.equal(journal.lookupIntent('request:1'), null);
    const intent = { operationId: 'request:1' };
    assert.deepEqual(journal.ensureIntent(intent), { ensured: true });
    assert.deepEqual(journal.claimDispatch(intent, 9), { claimed: true });
    assert.equal(await journal.withRequestOwner(() => 'owned'), 'owned');
    assert.deepEqual(setup.calls, [
      ['stateDirectory', '/repo', 17],
      ['ensureGitHubMutationIntent', '/repo', 17, intent],
      ['claimGitHubMutationDispatch', '/repo', 17, intent, 9],
      ['withGitHubRequestOwnerLock', '/repo', 17, setup.calls[3]?.[3]],
    ]);
    assert.equal(typeof setup.calls[3][3], 'function');
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});
