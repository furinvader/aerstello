#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { loginEmailSchema } from '../packages/shared/src/contracts.ts';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const rules = JSON.parse(readFileSync(
  new URL('../apps/api/src/admin-profile-rules.json', import.meta.url),
  'utf8',
));
const email = argument('email');
const name = argument('name');
const namePattern = new RegExp(rules.namePattern);

if (!loginEmailSchema.safeParse(email).success) {
  process.stderr.write('ADMIN_EMAIL is not accepted by the administrator bootstrap command.\n');
  process.exit(1);
}
if (typeof name !== 'string' || name.length > rules.nameMaxLength || !namePattern.test(name)) {
  process.stderr.write('ADMIN_NAME is not accepted by the administrator bootstrap command.\n');
  process.exit(1);
}
