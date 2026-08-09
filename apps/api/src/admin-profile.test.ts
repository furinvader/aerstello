import { describe, expect, it } from 'vitest';
import { adminProfileSchema } from './admin-profile.js';

const valid = [
  ['admin@example.test', 'Demo Administrator'],
  ["first.last+demo@example-host.test", 'A'],
] as const;

const invalid = [
  ['a..b@example.com', 'Demo Administrator'],
  ['.admin@example.com', 'Demo Administrator'],
  ['admin.@example.com', 'Demo Administrator'],
  ['admin@-example.com', 'Demo Administrator'],
  ['admin@example', 'Demo Administrator'],
  ['admin @example.com', 'Demo Administrator'],
  ['admin@example.com', '   '],
  ['admin@example.com', 'x'.repeat(201)],
] as const;

describe('administrator profile validation', () => {
  it.each(valid)('accepts %s', (email, name) => {
    expect(adminProfileSchema.safeParse({ email, name }).success).toBe(true);
  });

  it.each(invalid)('rejects %s / %s', (email, name) => {
    expect(adminProfileSchema.safeParse({ email, name }).success).toBe(false);
  });
});
