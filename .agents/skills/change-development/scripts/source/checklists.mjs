import { createHash } from 'node:crypto';

const TASK_ITEM = /^ {0,3}[-+*]\s+\[([ xX])\]\s*(.*)$/u;
const MARKER = /<!--\s*aerstello:item=([^\s>]*)\s*-->/gu;
const MARKER_HINT = /<!--[^>]*aerstello:item(?:=|\s|-->|$)[^>]*-->/gu;
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function visibleText(value) {
  return value.replace(MARKER_HINT, '').replace(/\s+/gu, ' ').trim();
}

function uniqueReceiptId(prefix, seed, used) {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${prefix}-${hash(`${seed}\0${attempt}`)}`;
    if (!used.has(candidate)) return candidate;
  }
}

function candidateLines(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const candidates = [];
  const orphanMarkers = [];
  let fence = null;
  let section = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.character
          && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    if (/^(?: {4,}|\t)/u.test(line) || /^ {0,3}>/u.test(line)) continue;
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) section = heading[1];
    const task = line.match(TASK_ITEM);
    if (task) candidates.push({ line: index + 1, checked: task[1].toLowerCase() === 'x', rawText: task[2], section });
    else if (line.includes('aerstello:item')) orphanMarkers.push({ line: index + 1, section, rawText: line });
  }
  return { candidates, orphanMarkers };
}

export function parseChecklist(markdown) {
  const { candidates, orphanMarkers } = candidateLines(markdown);
  const items = candidates.map((candidate, index) => {
    const exactMarkers = [...candidate.rawText.matchAll(MARKER)].map((match) => match[1]);
    const markerHints = [...candidate.rawText.matchAll(MARKER_HINT)];
    const malformed = (candidate.rawText.includes('aerstello:item') && markerHints.length === 0)
      || markerHints.length !== exactMarkers.length
      || exactMarkers.some((id) => !STABLE_ID.test(id));
    const text = visibleText(candidate.rawText);
    const position = index + 1;
    const reasons = [];
    if (malformed) reasons.push('malformed-stable-marker');
    if (exactMarkers.length > 1) reasons.push('multiple-stable-markers');
    const stableId = !malformed && exactMarkers.length === 1 ? exactMarkers[0] : null;
    const textDigest = hash(text);
    return {
      id: stableId ? `stable:${stableId}` : `legacy:${position}:${textDigest}`,
      checklistItemId: stableId ?? `legacy-${position}-${textDigest}`,
      identityType: stableId ? 'stable' : 'legacy',
      identityKind: stableId ? 'stable-marker' : 'legacy-position',
      identity: stableId ? { kind: 'stable-marker', stableId }
        : { kind: 'legacy-position', textDigest: `sha256:${textDigest}`, position,
          line: candidate.line, section: candidate.section },
      stableId, text,
      checked: candidate.checked, position, line: candidate.line,
      section: candidate.section,
      ambiguous: reasons.length > 0, ambiguityReasons: reasons,
    };
  });

  for (const orphan of orphanMarkers) {
    const orphanDigest = hash(orphan.rawText);
    items.push({
      id: `legacy:orphan-marker:${orphan.line}:${orphanDigest}`,
      checklistItemId: `legacy-orphan-${orphan.line}-${orphanDigest}`,
      identityType: 'legacy', identityKind: 'legacy-position',
      identity: { kind: 'legacy-position', textDigest: `sha256:${orphanDigest}`,
        position: null, line: orphan.line, section: orphan.section },
      stableId: null, text: orphan.rawText.trim(), checked: false,
      position: null, line: orphan.line, section: orphan.section, ambiguous: true,
      ambiguityReasons: ['orphan-stable-marker'],
    });
  }

  const stableCounts = new Map();
  const legacyCounts = new Map();
  for (const item of items) {
    if (item.stableId) stableCounts.set(item.stableId, (stableCounts.get(item.stableId) ?? 0) + 1);
    else legacyCounts.set(item.text, (legacyCounts.get(item.text) ?? 0) + 1);
  }
  for (const item of items) {
    if (item.stableId && stableCounts.get(item.stableId) > 1) {
      item.ambiguous = true;
      item.ambiguityReasons.push('duplicate-stable-id');
    }
    if (!item.stableId && legacyCounts.get(item.text) > 1) {
      item.ambiguous = true;
      item.ambiguityReasons.push('duplicate-legacy-text');
    }
  }

  // A duplicated marker keeps its shared source identity, but durable state needs a
  // distinct schema-safe status ID for every ambiguous occurrence.
  const usedChecklistItemIds = new Set(items
    .filter((item) => item.stableId && stableCounts.get(item.stableId) === 1)
    .map((item) => item.checklistItemId));
  for (const [index, item] of items.entries()) {
    if (item.stableId && stableCounts.get(item.stableId) > 1) {
      item.checklistItemId = uniqueReceiptId('ambiguous-stable',
        `${item.stableId}\0${item.position}\0${item.line}`, usedChecklistItemIds);
    } else if (!item.stableId && usedChecklistItemIds.has(item.checklistItemId)) {
      item.checklistItemId = uniqueReceiptId('ambiguous-item',
        `${item.id}\0${index}`, usedChecklistItemIds);
    }
    usedChecklistItemIds.add(item.checklistItemId);
  }
  return items;
}

export function compareChecklistMappings(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) {
    throw new TypeError('previous and current checklist mappings must be arrays');
  }
  const changes = [];
  const ambiguous = [];
  const previousStable = new Map(previous.filter((item) => item.stableId).map((item) => [item.stableId, item]));
  const currentStable = new Map(current.filter((item) => item.stableId).map((item) => [item.stableId, item]));
  for (const item of [...previous, ...current]) {
    if (item.ambiguous) ambiguous.push({ id: item.id, reasons: [...item.ambiguityReasons] });
  }
  for (const [id, before] of previousStable) {
    const after = currentStable.get(id);
    if (!after) changes.push({ kind: 'removed', identityType: 'stable', id, before });
    else {
      if (before.text !== after.text) changes.push({ kind: 'text-changed', identityType: 'stable', id, before, after });
      if (before.checked !== after.checked) changes.push({ kind: 'progress', identityType: 'stable', id, before, after });
      if (before.position !== after.position) changes.push({ kind: 'moved', identityType: 'stable', id, before, after });
    }
  }
  for (const [id, after] of currentStable) {
    if (!previousStable.has(id)) changes.push({ kind: 'added', identityType: 'stable', id, after });
  }
  const previousLegacy = previous.filter((item) => !item.stableId);
  const currentLegacy = current.filter((item) => !item.stableId);
  const positions = new Set([...previousLegacy, ...currentLegacy].map((item) => item.position));
  for (const position of [...positions].sort((a, b) => a - b)) {
    const before = previousLegacy.find((item) => item.position === position);
    const after = currentLegacy.find((item) => item.position === position);
    if (!before || !after || before.text !== after.text || before.section !== after.section) {
      const reason = !before ? 'legacy-added' : !after ? 'legacy-removed' : 'legacy-text-or-order-changed';
      ambiguous.push({ id: before?.id ?? after?.id, position, reasons: [reason] });
      changes.push({ kind: reason, identityType: 'legacy', position, before, after });
    } else if (before.checked !== after.checked) {
      changes.push({ kind: 'progress', identityType: 'legacy', id: before.id, before, after });
    }
  }
  return { status: ambiguous.length > 0 ? 'ambiguous' : 'matched', ambiguous, changes };
}

export function normalizeChecklistProgress(markdown) {
  const includedLines = new Set(candidateLines(markdown).candidates.map(({ line }) => line));
  return String(markdown ?? '').replace(/\r\n?/gu, '\n').split('\n').map((line, index) => {
    if (!includedLines.has(index + 1)) return line;
    return line.replace(/^( {0,3}[-+*]\s+\[)[ xX](\])/u, '$1 $2');
  }).join('\n');
}
