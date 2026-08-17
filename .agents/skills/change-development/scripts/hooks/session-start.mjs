#!/usr/bin/env node
import { renderRecoverySummary, StateError } from '../state/state.mjs';

async function input() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

try {
  const event = await input();
  const summary = renderRecoverySummary({ cwd: event.cwd ?? process.cwd(), maxCharacters: 9000 });
  output(summary ? {
    continue: true,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: summary },
  } : { continue: true });
} catch (error) {
  const code = error instanceof StateError ? error.code : 'CHANGE_SESSION_START_ERROR';
  output({ continue: true, systemMessage: `${code}: change-development recovery context was not loaded: ${error.message}` });
}
