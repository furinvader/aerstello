import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createRateLimitPreHandler, incrementRateLimitCounter, ipRateLimitKey, ipRateLimitMax, isAccessStatusRequest, rateLimitKey } from './rate-limit.js';

describe('rate limit keys', () => {
  const url = '/api/v1/public/access-requests/0198b529-e428-7000-8000-000000000001/status';

  it('separates access-status pollers behind the same address by capability', () => {
    const first = rateLimitKey({ ip: '192.0.2.1', method: 'POST', url, body: { token: 'first-capability' } });
    const second = rateLimitKey({ ip: '192.0.2.1', method: 'POST', url, body: { token: 'second-capability' } });
    expect(first).not.toBe(second);
    expect(first).not.toContain('first-capability');
    expect(ipRateLimitKey({ ip: '192.0.2.1' })).toBe('ip:192.0.2.1');
    expect(isAccessStatusRequest({ method: 'POST', url })).toBe(true);
    expect(ipRateLimitMax({ method: 'POST', url }, 300, 3000)).toBe(3000);
  });

  it('keeps ordinary requests in the shared address bucket', () => {
    expect(rateLimitKey({ ip: '192.0.2.1', method: 'POST', url: '/api/v1/auth/login' }))
      .toBe('ip:192.0.2.1');
  });

  it('applies the address ceiling after checking distinct capabilities', async () => {
    const app = Fastify();
    await app.register(rateLimit, {
      global: true,
      max: 2,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: ipRateLimitKey,
    });
    const limits = createRateLimitPreHandler(
      app.createRateLimit({ max: 2, timeWindow: '1 minute', keyGenerator: ipRateLimitKey }),
      app.createRateLimit({ max: 10, timeWindow: '1 minute', keyGenerator: rateLimitKey }),
    );
    app.post(url, { config: { rateLimit: false }, preHandler: limits }, async () => ({ ok: true }));

    const statuses = [];
    for (const token of ['first', 'second', 'third']) {
      const response = await app.inject({ method: 'POST', url, payload: { token } });
      statuses.push(response.statusCode);
    }
    await app.close();

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('counts capability-rejected attempts toward the address ceiling', async () => {
    const app = Fastify();
    await app.register(rateLimit, {
      global: true,
      max: 99,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: ipRateLimitKey,
    });
    const limits = createRateLimitPreHandler(
      app.createRateLimit({ max: 3, timeWindow: '1 minute', keyGenerator: ipRateLimitKey }),
      app.createRateLimit({ max: 1, timeWindow: '1 minute', keyGenerator: rateLimitKey }),
    );
    app.post(url, { config: { rateLimit: false }, preHandler: limits }, async () => ({ ok: true }));

    const statuses = [];
    for (const token of ['same', 'same', 'rotated', 'another']) {
      statuses.push((await app.inject({ method: 'POST', url, payload: { token } })).statusCode);
    }
    await app.close();

    expect(statuses).toEqual([200, 429, 200, 429]);
  });

  it('increments a durable hashed counter shared by replicas', async () => {
    const calls: unknown[][]=[];
    const database={query:async(_sql:string,parameters?:unknown[])=>{calls.push(parameters??[]);return {rows:[{current:2,ttl:59_000}]}}};
    await expect(incrementRateLimitCounter('global','ip:192.0.2.1',60_000,database as never))
      .resolves.toEqual({current:2,ttl:59_000});
    expect(calls[0]?.[0]).toBe('global');
    expect(calls[0]?.[1]).not.toBe('ip:192.0.2.1');
    expect(calls[0]?.[2]).toBe(60_000);
  });
});
