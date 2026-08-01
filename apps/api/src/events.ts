import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { pool } from './db.js';

export interface RealtimeEvent {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
}

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(1000);

export async function emitEvent(topic: string, payload: Record<string, unknown>, client: pg.Pool | pg.PoolClient = pool): Promise<void> {
  const result = await client.query<RealtimeEvent>(
    'INSERT INTO realtime_events(topic,payload) VALUES ($1,$2) RETURNING id,topic,payload',
    [topic, JSON.stringify(payload)],
  );
  const event = result.rows[0];
  if (event) eventBus.emit('event', event);
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
