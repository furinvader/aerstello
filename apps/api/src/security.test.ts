import { describe, expect, it, vi } from 'vitest';
import { createHostSession, hashPassword, hashToken, lockVerifiedHostLogin, recordHostSessionActivity, verifyPassword } from './security.js';

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

  it.each([
    { skew: 'ahead', applicationNow: new Date('2026-08-03T14:00:00.000Z') },
    { skew: 'behind', applicationNow: new Date('2026-08-03T10:00:00.000Z') },
  ])('uses the database expiry when the application clock is $skew', async ({ applicationNow }) => {
    vi.useFakeTimers();
    vi.setSystemTime(applicationNow);
    try {
      const databaseExpiry = new Date('2026-09-02T12:00:00.000Z');
      const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({ rows: [{ expiresAt: databaseExpiry }] }));
      const setCookie = vi.fn((_name: string, _token: string, _options: { expires: Date }) => undefined);

      await createHostSession(
        { query } as never,
        'host-a',
        { headers: { 'user-agent': 'Clock skew test agent' } } as never,
        { setCookie } as never,
      );

      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(/now\(\)\+interval '30 days'[\s\S]*RETURNING expires_at AS "expiresAt"/),
        ['host-a', expect.stringMatching(/^[0-9a-f]{64}$/), 'Clock skew test agent'],
      );
      expect(setCookie).toHaveBeenCalledWith(
        'skybar_host',
        expect.any(String),
        expect.objectContaining({ expires: databaseExpiry }),
      );
      expect(setCookie.mock.calls[0]![2].expires).toBe(databaseExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains nonessential last-seen update failures', async () => {
    const warn=vi.fn();
    recordHostSessionActivity('session-a',{warn},()=>Promise.reject(new Error('database unavailable')));
    await vi.waitFor(()=>expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({sessionId:'session-a'}),
      'Could not update host session activity',
    ));
  });

  it('locks and rechecks the verified password hash before session creation', async () => {
    const current = {
      id: 'host-a', email: 'host@example.test', name: 'Host', passwordHash: 'verified-hash', role: 'admin', language: 'de',
    };
    const query = vi.fn(async () => ({ rows: [current] }));

    await expect(lockVerifiedHostLogin({ query } as never, current.id, current.passwordHash)).resolves.toEqual(current);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [current.id, current.passwordHash]);
  });

  it('rejects a verified login after the password hash changes', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(lockVerifiedHostLogin({ query } as never, 'host-a', 'stale-hash')).resolves.toBeUndefined();
  });
});
