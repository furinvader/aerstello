import { describe, expect, it } from 'vitest';
import { adminProfileSchema } from './admin-profile.js';

const valid = [
  ['admin@example.com', 'Demo Administrator', 'admin@example.com'],
  [" first.last+demo@example-host.test ", 'A', 'first.last+demo@example-host.test'],
  ['ADMIN@EXAMPLE.COM', 'Demo Administrator', 'admin@example.com'],
] as const;

const invalid = [
  ['admin@example.1', 'Demo Administrator'],
  ['admin@example.c', 'Demo Administrator'],
  ['a..b@example.com', 'Demo Administrator'],
  ['.admin@example.com', 'Demo Administrator'],
  ['admin.@example.com', 'Demo Administrator'],
  ['admin@-example.com', 'Demo Administrator'],
  ['admin@example', 'Demo Administrator'],
  ['admin @example.com', 'Demo Administrator'],
  [`${'a'.repeat(244)}@example.com`, 'Demo Administrator'],
  ['admin@example.com', '   '],
  ['admin@example.com', 'x'.repeat(201)],
] as const;

describe('administrator profile validation', () => {
  it.each(valid)('accepts and normalizes %s', (email, name, normalized) => {
    expect(adminProfileSchema.parse({ email, name })).toEqual({ email: normalized, name });
  });

  it.each(invalid)('rejects %s / %s', (email, name) => {
    expect(adminProfileSchema.safeParse({ email, name }).success).toBe(false);
  });
});
