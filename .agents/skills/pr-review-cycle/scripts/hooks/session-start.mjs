#!/usr/bin/env node
import { renderRecoverySummary, StateError } from '../state/state.mjs';

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const input = await readInput();
  const summary = renderRecoverySummary({ cwd: input.cwd ?? process.cwd(), maxCharacters: 9000 });
  if (!summary) output({ continue: true });
  else {
    output({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: summary,
      },
    });
  }
} catch (error) {
  const label = error instanceof StateError ? error.code : 'SESSION_START_HOOK_ERROR';
  output({
    continue: true,
    systemMessage: `${label}: PR review recovery context was not loaded: ${error.message}`,
  });
}
