#!/usr/bin/env node
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  DEFAULT_RELEASE_REF,
  formatReleaseState,
  inspectReleaseState,
  ReleaseStateOperationalError,
} from './lib/release-state.mjs';

function usage() {
  return `Usage: node scripts/release-state.mjs [options]\n\nOptions:\n  --base <ref>          Base ref or SHA (default: origin/main)\n  --head <ref>          Head ref or SHA (default: HEAD)\n  --release-ref <ref>   Protected release ref (default: origin/main)\n  --require-tag <tag>   Require one tag to be a valid production release\n  --json                Emit structured JSON\n  --check               Exit 1 for stale or inconsistent policy state\n  --help                Show this help\n`;
}

try {
  const options = parseOptions(process.argv.slice(2), {
    booleans: ['json', 'check', 'help'],
    values: ['base', 'head', 'release-ref', 'require-tag'],
  });
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);

  const state = inspectReleaseState({
    base: options.base ?? DEFAULT_RELEASE_REF,
    head: options.head ?? 'HEAD',
    releaseRef: options['release-ref'] ?? DEFAULT_RELEASE_REF,
    requireTag: options['require-tag'],
  });
  if (options.json) writeJson(state);
  else process.stdout.write(formatReleaseState(state));
  if (options.check && ['stale', 'inconsistent'].includes(state.status)) process.exitCode = 1;
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  } else if (error instanceof ReleaseStateOperationalError) {
    process.stderr.write(`Release-state operational error: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
