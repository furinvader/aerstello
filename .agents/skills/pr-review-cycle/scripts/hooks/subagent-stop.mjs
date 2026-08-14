#!/usr/bin/env node
import { validateWorkerResult } from '../contracts/contracts.mjs';

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
  if (input.agent_type !== 'review_fix_worker') {
    output({ continue: true });
  } else {
    let result;
    let errors;
    try {
      result = JSON.parse(input.last_assistant_message ?? '');
      errors = validateWorkerResult(result);
    } catch (error) {
      errors = [`Worker response is not raw JSON: ${error.message}`];
    }

    if (errors.length === 0) {
      output({ continue: true });
    } else if (!input.stop_hook_active) {
      output({
        decision: 'block',
        reason: `Emit one corrected raw JSON worker-result object. Validation errors: ${errors.join('; ')}`,
      });
    } else {
      output({
        continue: true,
        systemMessage: `review_fix_worker returned an invalid result after one correction attempt: ${errors.join('; ')}`,
      });
    }
  }
} catch (error) {
  output({ continue: true, systemMessage: `SUBAGENT_STOP_HOOK_ERROR: ${error.message}` });
}
