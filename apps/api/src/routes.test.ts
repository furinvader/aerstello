import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRealtimeRequest, guestRealtimeEvent, parseRealtimeScope, safeFastifyClientError } from './routes.js';

describe('realtime event scope', () => {
  it.each([
    { query: {}, label: 'missing' },
    { query: { scope: ['host', 'guest'] }, label: 'repeated' },
    { query: { scope: 'admin' }, label: 'invalid' },
    { query: { scope: 'host', extra: 'guest' }, label: 'ambiguous' },
  ])('rejects $label scope selection', ({ query }) => {
    expect(() => parseRealtimeScope(query)).toThrow(expect.objectContaining({
      statusCode: 400,
      code: 'INVALID_EVENT_SCOPE',
    }));
  });

  it.each(['host', 'guest'] as const)('authenticates only the selected %s scope', async (scope) => {
    const authenticators = { host: vi.fn().mockResolvedValue(true), guest: vi.fn().mockResolvedValue(true) };

    await expect(authenticateRealtimeRequest(scope, {} as FastifyRequest, authenticators)).resolves.toBe(true);

    expect(authenticators[scope]).toHaveBeenCalledOnce();
    expect(authenticators[scope === 'host' ? 'guest' : 'host']).not.toHaveBeenCalled();
  });
});

describe('guest realtime event filtering', () => {
  it('delivers only the guest own order invalidation without identifiers', () => {
    const own = guestRealtimeEvent({ id: '1', topic: 'orders.changed', payload: { guestId: 'guest-a', tabId: 'tab-a' } }, 'guest-a');
    expect(own).toEqual({ id: '1', topic: 'orders.changed', payload: {} });
    expect(guestRealtimeEvent({ id: '2', topic: 'orders.changed', payload: { guestId: 'guest-b' } }, 'guest-a')).toBeUndefined();
  });

  it('allows global catalog invalidation but rejects host-only topics', () => {
    expect(guestRealtimeEvent({ id: '3', topic: 'catalog.changed', payload: { productId: 'product-a' } }, 'guest-a'))
      .toEqual({ id: '3', topic: 'catalog.changed', payload: {} });
    expect(guestRealtimeEvent({ id: '4', topic: 'access-request.changed', payload: { id: 'request-a' } }, 'guest-a'))
      .toBeUndefined();
    expect(guestRealtimeEvent({ id: '5', topic: 'guests.changed', payload: { guestId: 'guest-a' } }, 'guest-a'))
      .toEqual({ id: '5', topic: 'guests.changed', payload: {} });
    expect(guestRealtimeEvent({ id: '6', topic: 'rooms.changed', payload: { roomId: 'room-a' } }, 'guest-a'))
      .toEqual({ id: '6', topic: 'rooms.changed', payload: {} });
  });
});

describe('request error responses', () => {
  it('preserves safe Fastify client errors', () => {
    expect(safeFastifyClientError({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      message: 'Body is not valid JSON',
    })).toEqual({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      message: 'Body is not valid JSON',
    });
    expect(safeFastifyClientError({ statusCode: 500, code: 'PRIVATE_FAILURE', message: 'secret' })).toBeUndefined();
  });
});
