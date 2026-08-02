import { describe, expect, it, vi } from 'vitest';
import { eventBus, publishEvent, storeEvent, type RealtimeEvent } from './events.js';

describe('realtime event publication', () => {
  it('can store an event in a transaction before publishing it after commit', async () => {
    const event: RealtimeEvent = { id: '1', topic: 'guests.changed', payload: {} };
    const client = { query: vi.fn(async () => ({ rows: [event] })) };
    const listener = vi.fn();
    eventBus.on('event', listener);
    try {
      await expect(storeEvent(event.topic, event.payload, client as never)).resolves.toEqual(event);
      expect(listener).not.toHaveBeenCalled();
      publishEvent(event);
      expect(listener).toHaveBeenCalledWith(event);
    } finally {
      eventBus.off('event', listener);
    }
  });
});
