#!/usr/bin/env node
import { parseOptions, UsageError, writeJson } from './lib/cli.mjs';
import {
  checkReleasedMigrations,
  DEFAULT_RELEASE_REF,
  ReleaseStateOperationalError,
} from './lib/release-state.mjs';

function usage() {
  return `Usage: node scripts/check-released-migrations.mjs [options]\n\nOptions:\n  --base <ref>          Base ref or SHA (default: origin/main)\n  --head <ref>          Head ref or SHA (default: HEAD)\n  --release-ref <ref>   Protected release ref (default: origin/main)\n  --require-tag <tag>   Require one tag to be a valid production release\n  --json                Emit structured JSON\n  --help                Show this help\n`;
}

try {
  const options = parseOptions(process.argv.slice(2), {
    booleans: ['json', 'help'],
    values: ['base', 'head', 'release-ref', 'require-tag'],
  });
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (options._.length > 0) throw new UsageError(`Unexpected argument ${options._[0]}`);
  const result = checkReleasedMigrations({
    base: options.base ?? DEFAULT_RELEASE_REF,
    head: options.head ?? 'HEAD',
    releaseRef: options['release-ref'] ?? DEFAULT_RELEASE_REF,
    requireTag: options['require-tag'],
  });
  if (options.json) {
    writeJson(result);
  } else if (result.ok) {
    process.stdout.write(
      `Released migration check passed (${result.releaseState.frozenMigrations.length} frozen migration(s)).\n`,
    );
  } else {
    process.stderr.write('Released migration check failed:\n');
    for (const violation of result.violations) process.stderr.write(`- ${violation.message}\n`);
    for (const error of result.releaseState.errors) process.stderr.write(`- ${error.message}\n`);
  }
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  } else if (error instanceof ReleaseStateOperationalError) {
    process.stderr.write(`Migration-policy operational error: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
