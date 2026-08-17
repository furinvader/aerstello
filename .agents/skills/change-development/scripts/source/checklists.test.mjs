import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { compareChecklistMappings, parseChecklist } from './checklists.mjs';

test('real issue 22 fixture exposes thirteen unique legacy acceptance items', async () => {
  const body = await readFile(new URL('./fixtures/issue-22.md', import.meta.url), 'utf8');
  const entries = parseChecklist(body);
  assert.equal(entries.length, 13);
  assert.equal(new Set(entries.map(({ id }) => id)).size, 13);
  assert.ok(entries.every(({ checklistItemId }) => /^legacy-[1-9][0-9]*-[0-9a-f]{64}$/u.test(checklistItemId)));
  assert.ok(entries.every(({ identityType, ambiguous, section }) => identityType === 'legacy'
    && !ambiguous && section === 'Acceptance criteria'));
});

test('task examples in fences, indentation, and blockquotes are excluded', () => {
  const entries = parseChecklist(`
\`\`\`markdown
- [ ] <!-- aerstello:item=fenced --> no
\`\`\`
    - [ ] indented
> - [ ] quoted
- [x] <!-- aerstello:item=real-item --> Real
`);
  assert.deepEqual(entries.map(({ stableId, checked }) => ({ stableId, checked })),
    [{ stableId: 'real-item', checked: true }]);
});

test('stable markers survive movement while malformed, duplicate, and orphan markers are ambiguous', () => {
  const previous = parseChecklist('- [ ] <!-- aerstello:item=one --> One\n- [ ] <!-- aerstello:item=two --> Two');
  const current = parseChecklist('- [x] <!-- aerstello:item=two --> Two\n- [ ] <!-- aerstello:item=one --> One');
  const comparison = compareChecklistMappings(previous, current);
  assert.equal(comparison.status, 'matched');
  assert.deepEqual(comparison.changes.map(({ kind }) => kind).sort(), ['moved', 'moved', 'progress']);
  assert.deepEqual(previous.map(({ checklistItemId, identityKind }) => ({ checklistItemId, identityKind })), [
    { checklistItemId: 'one', identityKind: 'stable-marker' },
    { checklistItemId: 'two', identityKind: 'stable-marker' },
  ]);

  const invalid = parseChecklist(`
- [ ] <!-- aerstello:item=Bad_Id --> bad
- [ ] <!-- aerstello:item=unterminated
- [ ] <!-- aerstello:item=dup --> first
- [ ] <!-- aerstello:item=dup --> second
<!-- aerstello:item=orphan -->
`);
  assert.ok(invalid.every(({ ambiguous }) => ambiguous));
  assert.ok(invalid.some(({ ambiguityReasons }) => ambiguityReasons.includes('orphan-stable-marker')));

  const duplicateStable = invalid.filter(({ stableId }) => stableId === 'dup');
  assert.equal(duplicateStable.length, 2);
  assert.equal(new Set(duplicateStable.map(({ checklistItemId }) => checklistItemId)).size, 2);
  assert.ok(duplicateStable.every(({ checklistItemId, identity }) =>
    /^ambiguous-stable-[0-9a-f]{64}$/u.test(checklistItemId) && identity.stableId === 'dup'));

  const repeatedOrphans = parseChecklist('<!-- aerstello:item=orphan -->\n<!-- aerstello:item=orphan -->');
  assert.equal(repeatedOrphans.every(({ ambiguous }) => ambiguous), true);
  assert.equal(new Set(repeatedOrphans.map(({ checklistItemId }) => checklistItemId)).size, 2);
  assert.ok(repeatedOrphans.every(({ checklistItemId }) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(checklistItemId)));
});

test('legacy entries bind exact text and ordinal and fail closed on duplicates or reorder', () => {
  const duplicates = parseChecklist('- [ ] same\n- [ ] same');
  assert.equal(duplicates.every(({ ambiguous }) => ambiguous), true);
  assert.equal(new Set(duplicates.map(({ checklistItemId }) => checklistItemId)).size, 2);
  assert.ok(duplicates.every(({ checklistItemId }) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(checklistItemId)));
  const before = parseChecklist('- [ ] Alpha\n- [ ] Beta');
  const after = parseChecklist('- [ ] Beta\n- [ ] Alpha');
  const comparison = compareChecklistMappings(before, after);
  assert.equal(comparison.status, 'ambiguous');
  assert.equal(comparison.ambiguous.length, 2);
});
