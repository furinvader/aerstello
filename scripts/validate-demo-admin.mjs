#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const emailRules = JSON.parse(readFileSync(
  new URL('../packages/shared/src/login-email-rules.json', import.meta.url),
  'utf8',
));
const nameRules = JSON.parse(readFileSync(
  new URL('../apps/api/src/admin-profile-rules.json', import.meta.url),
  'utf8',
));
const email = argument('email');
const name = argument('name');
const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
const emailPattern = new RegExp(emailRules.pattern, emailRules.flags);
const namePattern = new RegExp(nameRules.namePattern);

if (normalizedEmail.length > emailRules.maxLength || !emailPattern.test(normalizedEmail)) {
  process.stderr.write('ADMIN_EMAIL is not accepted by the administrator bootstrap command.\n');
  process.exit(1);
}
if (typeof name !== 'string' || name.length > nameRules.nameMaxLength || !namePattern.test(name)) {
  process.stderr.write('ADMIN_NAME is not accepted by the administrator bootstrap command.\n');
  process.exit(1);
}
