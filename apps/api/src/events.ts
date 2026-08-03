import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { pool } from './db.js';

export interface RealtimeEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(1000);
const realtimeRelayWakeBus = new EventEmitter();
export const realtimeEventRetention = 10_000;
export const realtimeRelayBatchSize = 1_000;
const publishedEventKeys = new Set<string>();
const publishedEventOrder: string[] = [];

export async function storeEvent(topic: string, payload: Record<string, unknown>, client: pg.Pool | pg.PoolClient = pool): Promise<RealtimeEvent> {
  const result = await client.query<RealtimeEvent>(
    `WITH inserted AS (
       INSERT INTO realtime_events(topic,payload) VALUES ($1,$2) RETURNING id,topic,payload,created_at
     ), pruned AS (
       DELETE FROM realtime_events WHERE id <= (SELECT id FROM inserted)-$3::bigint
     ) SELECT id::text AS id,topic,payload,created_at::text AS "createdAt" FROM inserted`,
    [topic, JSON.stringify(payload), realtimeEventRetention],
  );
  const event = result.rows[0];
  if (!event) throw new Error('Could not persist realtime event');
  return event;
}

export function publishEvent(event: RealtimeEvent): void {
  const key=`${event.id}:${event.createdAt}`;
  if(publishedEventKeys.has(key))return;
  publishedEventKeys.add(key);
  publishedEventOrder.push(key);
  if(publishedEventOrder.length>realtimeEventRetention){
    const expired=publishedEventOrder.shift();
    if(expired)publishedEventKeys.delete(expired);
  }
  eventBus.emit('event', event);
}

type EventDatabase = Pick<pg.Pool, 'query'>;

export async function latestRealtimeEventId(client: EventDatabase = pool): Promise<string> {
  const result=await client.query<{id:string}>('SELECT COALESCE(max(id),0)::text AS id FROM realtime_events');
  return result.rows[0]?.id??'0';
}

export async function relayEventsAfter(cursor: string, client: EventDatabase = pool): Promise<string> {
  const result=await client.query<RealtimeEvent>(
    `WITH boundary AS (SELECT COALESCE(max(id),0) AS max_id FROM realtime_events)
     SELECT event.id::text AS id,event.topic,event.payload,event.created_at::text AS "createdAt"
       FROM realtime_events event CROSS JOIN boundary
      WHERE event.id > CASE WHEN boundary.max_id < $1::bigint THEN 0 ELSE $1::bigint END
      ORDER BY event.id
      LIMIT $2`,
    [cursor,realtimeRelayBatchSize],
  );
  for(const event of result.rows)publishEvent(event);
  return result.rows.at(-1)?.id??cursor;
}

export function requestRealtimeRelay(): void {
  realtimeRelayWakeBus.emit('wake');
}

export async function startRealtimeRelay(
  log: { warn: (bindings: Record<string, unknown>, message: string) => void },
  client: EventDatabase = pool,
  intervalMs = 250,
): Promise<() => void> {
  let cursor=await latestRealtimeEventId(client);
  let polling=false;
  let pending=false;
  const poll=async()=>{
    if(polling){pending=true;return}
    polling=true;
    try{
      do{
        pending=false;
        try{cursor=await relayEventsAfter(cursor,client)}
        catch(error){log.warn({error},'Could not relay persisted realtime events')}
      }while(pending)
    }
    finally{polling=false}
  };
  const wake=()=>void poll();
  realtimeRelayWakeBus.on('wake',wake);
  const timer=setInterval(()=>void poll(),intervalMs);
  timer.unref();
  return ()=>{
    clearInterval(timer);
    realtimeRelayWakeBus.off('wake',wake);
  };
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
    `INSERT INTO audit_events(actor_host_id,actor_guest_session_id,action,entity_type,entity_id,detail,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
    [actor.hostId ?? null, actor.guestSessionId ?? null, action, entityType, entityId, JSON.stringify(detail)],
  );
}
