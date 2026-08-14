#!/usr/bin/env node
import { checkpointGitMetadata, StateError } from '../state/state.mjs';

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
  const result = checkpointGitMetadata({
    cwd: input.cwd ?? process.cwd(),
    sessionId: input.session_id,
    backup: true,
  });
  output(result.warning
    ? { continue: true, systemMessage: result.warning }
    : { continue: true });
} catch (error) {
  const label = error instanceof StateError ? error.code : 'PRE_COMPACT_HOOK_ERROR';
  output({
    continue: true,
    systemMessage: `${label}: active PR state was not checkpointed: ${error.message}`,
  });
}
