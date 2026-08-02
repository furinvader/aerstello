import { describe, expect, it, vi } from 'vitest';
import { eventBus, publishEvent, realtimeEventRetention, realtimeRelayBatchSize, relayEventsAfter, storeEvent, type RealtimeEvent } from './events.js';

describe('realtime event publication', () => {
  it('can store an event in a transaction before publishing it after commit', async () => {
    const event: RealtimeEvent = { id: '1', topic: 'guests.changed', payload: {}, createdAt: '2026-08-02 20:00:00+00' };
    const client = { query: vi.fn(async () => ({ rows: [event] })) };
    const listener = vi.fn();
    eventBus.on('event', listener);
    try {
      await expect(storeEvent(event.topic, event.payload, client as never)).resolves.toEqual(event);
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM realtime_events'), [event.topic, '{}', realtimeEventRetention]);
      expect(listener).not.toHaveBeenCalled();
      publishEvent(event);
      expect(listener).toHaveBeenCalledWith(event);
    } finally {
      eventBus.off('event', listener);
    }
  });

  it('relays a persisted event written by another API replica', async () => {
    const event: RealtimeEvent = { id: '42', topic: 'rooms.changed', payload: {}, createdAt: '2026-08-02 20:01:00+00' };
    const client = { query: vi.fn(async () => ({ rows: [event] })) };
    const listener = vi.fn();
    eventBus.on('event', listener);
    try {
      await expect(relayEventsAfter('41', client as never)).resolves.toBe('42');
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('realtime_events'), ['41', realtimeRelayBatchSize]);
      expect(listener).toHaveBeenCalledWith(event);
    } finally {
      eventBus.off('event', listener);
    }
  });
});
