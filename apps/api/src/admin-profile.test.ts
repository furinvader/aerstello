import { describe, expect, it } from 'vitest';
import { accountUpdateSchema } from '@aerstello/shared';
import { adminProfileSchema } from './admin-profile.js';

const valid = [
  ['admin@example.com', 'Demo Administrator', 'admin@example.com'],
  [" first.last+demo@example-host.test ", 'A', 'first.last+demo@example-host.test'],
  ['ADMIN@EXAMPLE.COM', 'Demo Administrator', 'admin@example.com'],
  ['admin@example.com', 'x'.repeat(120), 'admin@example.com'],
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
  ['admin@example.com', 'x'.repeat(121)],
] as const;

describe('administrator profile validation', () => {
  it.each(valid)('accepts and normalizes %s', (email, name, normalized) => {
    expect(adminProfileSchema.parse({ email, name })).toEqual({ email: normalized, name });
  });

  it.each(invalid)('rejects %s / %s', (email, name) => {
    expect(adminProfileSchema.safeParse({ email, name }).success).toBe(false);
  });

  it('matches the account update name boundary', () => {
    const command = {
      mutationId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 1,
    };
    expect(accountUpdateSchema.safeParse({ ...command, name: 'x'.repeat(120) }).success).toBe(true);
    expect(accountUpdateSchema.safeParse({ ...command, name: 'x'.repeat(121) }).success).toBe(false);
  });
});
