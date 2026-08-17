#!/usr/bin/env node
import { validateImplementationResult } from '../implementation/contracts.mjs';
async function readInput() { let text = ''; for await (const chunk of process.stdin) text += chunk; return text.trim() ? JSON.parse(text) : {}; }
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
try {
  const input = await readInput();
  if (input.agent_type !== 'implementation_worker') output({ continue: true });
  else {
    let errors;
    try { errors = validateImplementationResult(JSON.parse(input.last_assistant_message ?? '')); }
    catch (error) { errors = [`Worker response is not raw JSON: ${error.message}`]; }
    if (errors.length === 0) output({ continue: true });
    else if (!input.stop_hook_active) output({ decision: 'block', reason: `Emit one corrected raw JSON implementation-result object. Validation errors: ${errors.join('; ')}` });
    else output({ continue: true, systemMessage: `implementation_worker returned an invalid result after one correction attempt: ${errors.join('; ')}` });
  }
} catch (error) { output({ continue: true, systemMessage: `IMPLEMENTATION_SUBAGENT_STOP_HOOK_ERROR: ${error.message}` }); }
