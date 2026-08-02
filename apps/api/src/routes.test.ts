import { describe, expect, it } from 'vitest';
import { guestRealtimeEvent } from './routes.js';

describe('guest realtime event filtering', () => {
  it('delivers only the guest own order invalidation without identifiers', () => {
    const own = guestRealtimeEvent({ id: 1, topic: 'orders.changed', payload: { guestId: 'guest-a', tabId: 'tab-a' } }, 'guest-a');
    expect(own).toEqual({ id: 1, topic: 'orders.changed', payload: {} });
    expect(guestRealtimeEvent({ id: 2, topic: 'orders.changed', payload: { guestId: 'guest-b' } }, 'guest-a')).toBeUndefined();
  });

  it('allows global catalog invalidation but rejects host-only topics', () => {
    expect(guestRealtimeEvent({ id: 3, topic: 'catalog.changed', payload: { productId: 'product-a' } }, 'guest-a'))
      .toEqual({ id: 3, topic: 'catalog.changed', payload: {} });
    expect(guestRealtimeEvent({ id: 4, topic: 'access-request.changed', payload: { id: 'request-a' } }, 'guest-a'))
      .toBeUndefined();
    expect(guestRealtimeEvent({ id: 5, topic: 'guests.changed', payload: { guestId: 'guest-a' } }, 'guest-a'))
      .toEqual({ id: 5, topic: 'guests.changed', payload: {} });
    expect(guestRealtimeEvent({ id: 6, topic: 'rooms.changed', payload: { roomId: 'room-a' } }, 'guest-a'))
      .toEqual({ id: 6, topic: 'rooms.changed', payload: {} });
  });
});
