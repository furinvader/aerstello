import { describe, expect, it, vi } from 'vitest';
import { audit, eventBus, publishEvent, realtimeEventRetention, realtimeRelayBatchSize, relayEventsAfter, requestRealtimeRelay, startRealtimeRelay, storeEvent, type RealtimeEvent } from './events.js';

describe('audit events', () => {
  it('timestamps inserts with the database wall clock', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };

    await audit('bill.voided', 'bill', 'bill-1', { reason: 'Correction' }, { hostId: 'host-1' }, client as never);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/detail,created_at\)\s+VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,clock_timestamp\(\)\)/),
      ['host-1', null, 'bill.voided', 'bill', 'bill-1', '{"reason":"Correction"}'],
    );
  });
});

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

  it('wakes the ordered relay after a local transaction commits', async () => {
    const event: RealtimeEvent = { id: '43', topic: 'rooms.changed', payload: {}, createdAt: '2026-08-02 20:02:00+00' };
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: '42' }] })
      .mockResolvedValueOnce({ rows: [event] }) };
    const listener = vi.fn();
    eventBus.on('event',listener);
    const stop=await startRealtimeRelay({warn:vi.fn()},client as never,60_000);
    try{
      requestRealtimeRelay();
      await vi.waitFor(()=>expect(listener).toHaveBeenCalledWith(event));
      expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY event.id'),['42',realtimeRelayBatchSize]);
    }finally{
      stop();
      eventBus.off('event',listener);
    }
  });
});
