import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, verifyPassword } from './security.js';

describe('security primitives', () => {
  it('hashes opaque tokens deterministically without retaining the token', () => {
    const token = 'a-private-device-session-token';
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it('uses a one-way password hash', async () => {
    const password = 'a-secure-test-password';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });
});
