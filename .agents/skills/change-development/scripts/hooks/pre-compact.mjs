#!/usr/bin/env node
import { checkpointGitMetadata, StateError } from '../state/state.mjs';

async function input() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

try {
  const event = await input();
  const result = checkpointGitMetadata({ cwd: event.cwd ?? process.cwd() });
  output(result.warning
    ? { continue: true, systemMessage: result.warning }
    : { continue: true });
} catch (error) {
  const code = error instanceof StateError ? error.code : 'CHANGE_PRE_COMPACT_ERROR';
  output({ continue: true, systemMessage: `${code}: change-development state was not checkpointed: ${error.message}` });
}
