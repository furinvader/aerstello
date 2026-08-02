import { describe, expect, it } from 'vitest';
import { rateLimitKey } from './rate-limit.js';

describe('rate limit keys', () => {
  const url = '/api/v1/public/access-requests/0198b529-e428-7000-8000-000000000001/status';

  it('separates access-status pollers behind the same address by capability', () => {
    const first = rateLimitKey({ ip: '192.0.2.1', method: 'POST', url, body: { token: 'first-capability' } });
    const second = rateLimitKey({ ip: '192.0.2.1', method: 'POST', url, body: { token: 'second-capability' } });
    expect(first).not.toBe(second);
    expect(first).not.toContain('first-capability');
  });

  it('keeps ordinary requests in the shared address bucket', () => {
    expect(rateLimitKey({ ip: '192.0.2.1', method: 'POST', url: '/api/v1/auth/login' }))
      .toBe('ip:192.0.2.1');
  });
});
