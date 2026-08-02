import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { pool } from './db.js';

export interface RealtimeEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(1000);
export const realtimeEventRetention = 10_000;

export async function storeEvent(topic: string, payload: Record<string, unknown>, client: pg.Pool | pg.PoolClient = pool): Promise<RealtimeEvent> {
  const result = await client.query<RealtimeEvent>(
    `WITH inserted AS (
       INSERT INTO realtime_events(topic,payload) VALUES ($1,$2) RETURNING id,topic,payload
     ), pruned AS (
       DELETE FROM realtime_events WHERE id <= (SELECT id FROM inserted)-$3::bigint
     ) SELECT id::text AS id,topic,payload FROM inserted`,
    [topic, JSON.stringify(payload), realtimeEventRetention],
  );
  const event = result.rows[0];
  if (!event) throw new Error('Could not persist realtime event');
  return event;
}

export function publishEvent(event: RealtimeEvent): void {
  eventBus.emit('event', event);
}

export async function emitEvent(topic: string, payload: Record<string, unknown>, client: pg.Pool | pg.PoolClient = pool): Promise<void> {
  publishEvent(await storeEvent(topic, payload, client));
}

export async function audit(
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  actor: { hostId?: string; guestSessionId?: string },
  client: pg.Pool | pg.PoolClient = pool,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(actor_host_id,actor_guest_session_id,action,entity_type,entity_id,detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.hostId ?? null, actor.guestSessionId ?? null, action, entityType, entityId, JSON.stringify(detail)],
  );
}
