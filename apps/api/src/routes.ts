import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { z, type ZodType } from 'zod';
import {
  MAX_MONEY_CENTS,
  accessApprovalSchema,
  accessRequestSchema,
  categoryCreateSchema,
  guestCreateSchema,
  guestInputSchema,
  languageSchema,
  loginSchema,
  orderBatchSchema,
  productCreateSchema,
  productInputSchema,
  roomCreateSchema,
  roomInputSchema,
  settleTabSchema,
  venueSettingsSchema,
  voidSchema,
} from '@sky-bar/shared';
import { audit, emitEvent, eventBus, publishEvent, storeEvent, type RealtimeEvent } from './events.js';
import { pool, transaction } from './db.js';
import { config } from './config.js';
import { rateLimitKey } from './rate-limit.js';
import {
  accessStatusToken,
  authenticateHost,
  authenticateGuest,
  clearGuestCookie,
  clearHostCookie,
  createHostSession,
  guestGrantToken,
  guestSessionIsActive,
  hashPassword,
  hashToken,
  hostSessionIsActive,
  newToken,
  requireAdmin,
  requireGuest,
  requireHost,
  setGuestCookie,
  verifyPassword,
} from './security.js';

class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

function body<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const result = schema.safeParse(request.body);
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}

function query<T>(schema: ZodType<T>, request: FastifyRequest): T {
  const result = schema.safeParse(request.query);
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Invalid query.');
  return result.data;
}

function id(request: FastifyRequest): string {
  const value = (request.params as { id?: string }).id;
  if (!value || !z.string().uuid().safeParse(value).success) throw new HttpError(400, 'INVALID_ID', 'A valid identifier is required.');
  return value;
}

function mapList<T>(rows: T[]) { return { data: rows }; }

export function guestRealtimeEvent(event: RealtimeEvent, guestId: string): RealtimeEvent | undefined {
  const isOwnOrder=event.topic==='orders.changed'&&event.payload.guestId===guestId;
  const isOwnAccess=event.topic==='guest-access.changed'&&event.payload.guestId===guestId;
  const isPublicInvalidation=['catalog.changed','guests.changed','rooms.changed'].includes(event.topic);
  return isOwnOrder||isOwnAccess||isPublicInvalidation?{...event,payload:{}}:undefined;
}

async function activeTab(guestId: string, client: pg.Pool | pg.PoolClient = pool): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO order_tabs(guest_id,status) VALUES ($1,'open')
     ON CONFLICT (guest_id) WHERE status='open' DO UPDATE SET guest_id=excluded.guest_id RETURNING id`,
    [guestId],
  );
  const tabId = result.rows[0]?.id;
  if (!tabId) throw new HttpError(500, 'TAB_ERROR', 'Could not open a tab.');
  return tabId;
}

async function ensureTabTotalWithinRange(tabId: string, additionalCents: bigint, client: pg.PoolClient): Promise<void> {
  await client.query('SELECT id FROM order_tabs WHERE id=$1 FOR UPDATE', [tabId]);
  const current = await client.query<{ totalCents: string }>(
    `SELECT COALESCE(sum(unit_price_cents::bigint*quantity),0)::text AS "totalCents"
       FROM order_items WHERE tab_id=$1 AND status IN ('open','provisional')`,
    [tabId],
  );
  if (BigInt(current.rows[0]?.totalCents ?? '0') + additionalCents > BigInt(MAX_MONEY_CENTS)) {
    throw new HttpError(409, 'TAB_TOTAL_LIMIT', 'The open tab has reached its maximum total.');
  }
}

async function tabDetail(guestId: string) {
  const tab = await pool.query(
    `SELECT t.id,g.id AS "guestId",g.name AS "guestName",r.name AS "roomName",t.opened_at AS "openedAt"
       FROM order_tabs t JOIN guests g ON g.id=t.guest_id JOIN rooms r ON r.id=g.room_id
      WHERE t.guest_id=$1 AND t.status='open'`,
    [guestId],
  );
  if (!tab.rows[0]) return { id: null, guestId, items: [], itemCount: 0, totalCents: 0 };
  await pool.query(`UPDATE order_items SET status='open' WHERE tab_id=$1 AND status='provisional' AND provisional_until<=now()`, [tab.rows[0].id]);
  const items = await pool.query(
    `SELECT id,product_id AS "productId",product_name AS "productName",unit_price_cents AS "unitPriceCents",quantity,
            source,status,provisional_until AS "provisionalUntil",created_at AS "createdAt"
       FROM order_items WHERE tab_id=$1 AND status IN ('open','provisional') ORDER BY created_at`,
    [tab.rows[0].id],
  );
  const totalCents = items.rows.reduce((sum, item) => sum + Number(item.unitPriceCents) * Number(item.quantity), 0);
  const itemCount = items.rows.reduce((sum, item) => sum + Number(item.quantity), 0);
  return { ...tab.rows[0], items: items.rows, totalCents, itemCount };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const dummyPasswordHash = await hashPassword(newToken());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as { code?: string }).code === '23505') {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: 'This change conflicts with existing data.' } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (request.url.startsWith('/api/v1/public/') || request.url === '/api/v1/auth/login') return;
    if ((request.cookies.skybar_host || request.cookies.skybar_guest) && request.headers['x-skybar-csrf'] !== '1') {
      await reply.code(403).send({ error: { code: 'CSRF', message: 'Missing request verification header.' } });
    }
  });

  app.get('/api/v1/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.get('/api/v1/public/bootstrap', async () => {
    const [venue, rooms] = await Promise.all([
      pool.query('SELECT name,default_language AS "defaultLanguage",timezone FROM venue_settings WHERE id=1'),
      pool.query('SELECT id,name FROM rooms WHERE archived_at IS NULL ORDER BY position,name'),
    ]);
    return { venue: venue.rows[0], rooms: rooms.rows };
  });

  app.post('/api/v1/public/access-requests', async (request, reply) => {
    const input = body(accessRequestSchema, request);
    const token = accessStatusToken(input.mutationId);
    const result = await transaction(async (client) => {
      const findExisting=async()=> (await client.query<{ id: string; name: string; roomId: string; language: string }>(
        `SELECT id,name,room_id AS "roomId",language FROM access_requests WHERE mutation_id=$1 FOR UPDATE`,
        [input.mutationId],
      )).rows[0];
      const validate=(stored:{ id: string; name: string; roomId: string; language: string })=>{
        if (stored.name !== input.name || stored.roomId !== input.roomId || stored.language !== input.language) {
          throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another access request.');
        }
        return stored;
      };
      const existing=await findExisting();
      if(existing)return validate(existing);
      const room = await client.query('SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [input.roomId]);
      if (!room.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
      const inserted = await client.query<{ id: string; name: string; roomId: string; language: string }>(
        `INSERT INTO access_requests(mutation_id,name,room_id,language,status_token_hash)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (mutation_id) DO NOTHING
         RETURNING id,name,room_id AS "roomId",language`,
        [input.mutationId, input.name, input.roomId, input.language, hashToken(token)],
      );
      const stored = inserted.rows[0] ?? await findExisting();
      if (!stored) throw new HttpError(500, 'REQUEST_ERROR', 'Could not create the request.');
      return validate(stored);
    });
    const requestId = result.id;
    await emitEvent('access-request.changed', { id: requestId });
    return reply.code(201).send({ id: requestId, statusToken: token, status: 'pending' });
  });

  app.post('/api/v1/public/access-requests/:id/status', { preHandler: app.rateLimit({
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    groupId: 'access-status-capability',
    keyGenerator: rateLimitKey,
  }) }, async (request, reply) => {
    const requestId = id(request);
    const { token, grantId } = body(z.object({
      token: z.string().min(1).max(256),
      grantId: z.string().uuid(),
    }), request);
    const grant = await transaction(async (client) => {
      const result = await client.query<{
        status: string; guestId: string | null; expiresAt: Date | null; statusTokenConsumedAt: Date | null; grantExchangeId: string | null;
      }>(
        `SELECT status,guest_id AS "guestId",expires_at AS "expiresAt",
                status_token_consumed_at AS "statusTokenConsumedAt",grant_exchange_id AS "grantExchangeId"
           FROM access_requests WHERE id=$1 AND status_token_hash=$2 FOR UPDATE`,
        [requestId, hashToken(token)],
      );
      const access = result.rows[0];
      if (!access) throw new HttpError(404, 'REQUEST_NOT_FOUND', 'Request not found.');
      if (access.status === 'approved' && access.expiresAt && access.expiresAt.getTime() <= Date.now()) {
        return { access: { ...access, status: 'expired' }, guestToken:undefined };
      }
      if (access.status === 'approved' && access.guestId) {
        const activeGuest = await client.query('SELECT id FROM guests WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [access.guestId]);
        if (!activeGuest.rowCount) return { access: { ...access, status: 'disabled' }, guestToken:undefined };
      }
      if (access.status === 'approved' && access.guestId && access.expiresAt && !access.statusTokenConsumedAt) {
        const guestToken=guestGrantToken(requestId, grantId);
        await client.query(
          `INSERT INTO guest_sessions(guest_id,request_id,token_hash,user_agent,expires_at) VALUES ($1,$2,$3,$4,$5)`,
          [access.guestId, requestId, hashToken(guestToken), request.headers['user-agent']?.slice(0, 300) ?? 'Unknown device', access.expiresAt],
        );
        await client.query('UPDATE access_requests SET status_token_consumed_at=now(),grant_exchange_id=$2 WHERE id=$1', [requestId, grantId]);
        return { access, guestToken };
      }
      if (access.status === 'approved' && access.guestId && access.expiresAt && access.grantExchangeId === grantId) {
        const guestToken=guestGrantToken(requestId, grantId);
        const session = await client.query(
          `SELECT 1 FROM guest_sessions WHERE request_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now()`,
          [requestId, hashToken(guestToken)],
        );
        if (session.rowCount) return { access, guestToken };
      }
      return { access, guestToken:undefined };
    });
    if (grant.guestToken && grant.access.expiresAt) setGuestCookie(reply, grant.guestToken, new Date(grant.access.expiresAt));
    return { status: grant.access.status, expiresAt: grant.access.expiresAt, granted: Boolean(grant.guestToken) };
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = body(loginSchema, request);
    const result = await pool.query<{
      id: string; email: string; name: string; passwordHash: string; role: string; language: string;
    }>(
      `SELECT id,email,name,password_hash AS "passwordHash",role,language FROM hosts WHERE lower(email)=lower($1) AND active=true`,
      [input.email],
    );
    const host = result.rows[0];
    const validPassword = await verifyPassword(host?.passwordHash ?? dummyPasswordHash, input.password);
    if (!host || !validPassword) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    await createHostSession(pool, host.id, request, reply);
    await audit('host.login', 'host', host.id, {}, { hostId: host.id });
    return { host: { id: host.id, email: host.email, name: host.name, role: host.role, language: host.language } };
  });

  app.post('/api/v1/auth/logout', { preHandler: requireHost }, async (request, reply) => {
    await pool.query('UPDATE host_sessions SET revoked_at=now() WHERE id=$1', [request.hostIdentity!.sessionId]);
    clearHostCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', async (request) => {
    const host = await authenticateHost(request);
    if (!host) throw new HttpError(401, 'UNAUTHENTICATED', 'Host authentication required.');
    const venue = await pool.query('SELECT name,default_language AS "defaultLanguage",timezone,version FROM venue_settings WHERE id=1');
    return { host, venue: venue.rows[0] };
  });

  app.get('/api/v1/account/sessions', { preHandler: requireHost }, async (request) => mapList((await pool.query(
    `SELECT id,user_agent AS "userAgent",created_at AS "createdAt",last_seen_at AS "lastSeenAt",expires_at AS "expiresAt",
            (id=$2) AS current FROM host_sessions WHERE host_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC`,
    [request.hostIdentity!.id, request.hostIdentity!.sessionId],
  )).rows));

  app.delete('/api/v1/account/sessions/:id', { preHandler: requireHost }, async (request, reply) => {
    const sessionId = id(request);
    await pool.query('UPDATE host_sessions SET revoked_at=now() WHERE id=$1 AND host_id=$2', [sessionId, request.hostIdentity!.id]);
    if (sessionId === request.hostIdentity!.sessionId) clearHostCookie(reply);
    return reply.code(204).send();
  });

  app.patch('/api/v1/account', { preHandler: requireHost }, async (request) => {
    const schema = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      language: languageSchema.optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(12).max(256).optional(),
    });
    const input = body(schema, request);
    let expectedPasswordHash: string | undefined;
    let newPasswordHash: string | undefined;
    if (input.newPassword) {
      const current = await pool.query<{ passwordHash: string }>('SELECT password_hash AS "passwordHash" FROM hosts WHERE id=$1', [request.hostIdentity!.id]);
      if (!input.currentPassword || !(await verifyPassword(current.rows[0]!.passwordHash, input.currentPassword))) {
        throw new HttpError(400, 'INVALID_PASSWORD', 'Current password is incorrect.');
      }
      expectedPasswordHash = current.rows[0]!.passwordHash;
      newPasswordHash = await hashPassword(input.newPassword);
    }
    const authEvent = await transaction(async (client) => {
      let event: RealtimeEvent | undefined;
      if (newPasswordHash) {
        const updated = await client.query(
          'UPDATE hosts SET password_hash=$1 WHERE id=$2 AND password_hash=$3',
          [newPasswordHash, request.hostIdentity!.id, expectedPasswordHash],
        );
        if (!updated.rowCount) throw new HttpError(409, 'PASSWORD_CHANGED', 'The password changed in another session. Try again.');
        await client.query('UPDATE host_sessions SET revoked_at=now() WHERE host_id=$1 AND id<>$2', [request.hostIdentity!.id, request.hostIdentity!.sessionId]);
        event = await storeEvent('host-auth.changed', { hostId: request.hostIdentity!.id }, client);
      }
      await client.query('UPDATE hosts SET name=COALESCE($1,name),language=COALESCE($2,language) WHERE id=$3', [input.name ?? null, input.language ?? null, request.hostIdentity!.id]);
      return event;
    });
    if (authEvent) {
      try { publishEvent(authEvent); }
      catch (error) { app.log.error(error, 'Could not publish committed host authorization event'); }
    }
    return { ok: true };
  });

  app.get('/api/v1/hosts', { preHandler: requireAdmin }, async () => mapList((await pool.query(
    `SELECT id,email,name,role,language,active,created_at AS "createdAt" FROM hosts ORDER BY active DESC,name`,
  )).rows));

  app.post('/api/v1/hosts', { preHandler: requireAdmin }, async (request, reply) => {
    const input = body(z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      name: z.string().trim().min(1).max(120),
      password: z.string().min(12).max(256),
      role: z.enum(['admin','staff']),
      language: languageSchema.default('de'),
    }), request);
    const result = await pool.query(
      `INSERT INTO hosts(email,name,password_hash,role,language) VALUES (lower($1),$2,$3,$4,$5)
       RETURNING id,email,name,role,language,active`,
      [input.email,input.name,await hashPassword(input.password),input.role,input.language],
    );
    await audit('host.created','host',result.rows[0].id,{email:input.email,role:input.role},{hostId:request.hostIdentity!.id});
    return reply.code(201).send(result.rows[0]);
  });

  app.patch('/api/v1/hosts/:id', { preHandler: requireAdmin }, async (request) => {
    const hostId=id(request);
    const input=body(z.object({active:z.boolean().optional(),role:z.enum(['admin','staff']).optional()}),request);
    if(hostId===request.hostIdentity!.id && input.active===false) throw new HttpError(409,'SELF_DISABLE','You cannot disable your own account.');
    const updated = await transaction(async (client) => {
      const admins=await client.query<{id:string}>(`SELECT id FROM hosts WHERE role='admin' AND active=true ORDER BY id FOR UPDATE`);
      const target=await client.query<{role:'admin'|'staff';active:boolean}>('SELECT role,active FROM hosts WHERE id=$1 FOR UPDATE',[hostId]);
      const current=target.rows[0];
      if(!current) throw new HttpError(404,'HOST_NOT_FOUND','Host not found.');
      const remainsActiveAdmin=(input.active??current.active)&&(input.role??current.role)==='admin';
      if(current.active&&current.role==='admin'&&!remainsActiveAdmin&&(admins.rowCount??0)<=1){
        throw new HttpError(409,'LAST_ADMIN','At least one active administrator is required.');
      }
      const result=await client.query(
        `UPDATE hosts SET active=COALESCE($1,active),role=COALESCE($2,role) WHERE id=$3
         RETURNING id,email,name,role,language,active`,[input.active??null,input.role??null,hostId]);
      if(input.active===false) await client.query('UPDATE host_sessions SET revoked_at=now() WHERE host_id=$1 AND revoked_at IS NULL',[hostId]);
      await audit('host.updated','host',hostId,input,{hostId:request.hostIdentity!.id},client);
      const event=await storeEvent('host-auth.changed',{hostId},client);
      return {host:result.rows[0],event};
    });
    try { publishEvent(updated.event); }
    catch (error) { app.log.error(error, 'Could not publish committed host authorization event'); }
    return updated.host;
  });

  app.get('/api/v1/venue', { preHandler: requireHost }, async () => (await pool.query(
    'SELECT name,default_language AS "defaultLanguage",timezone,version FROM venue_settings WHERE id=1',
  )).rows[0]);

  app.put('/api/v1/venue', { preHandler: requireAdmin }, async (request) => {
    const input = body(venueSettingsSchema, request);
    const previous = await pool.query<{ name: string }>('SELECT name FROM venue_settings WHERE id=1');
    const result = await pool.query(
      `UPDATE venue_settings SET name=$1,default_language=$2,timezone=$3,version=version+1,updated_at=now()
       WHERE id=1 RETURNING name,default_language AS "defaultLanguage",timezone,version`,
      [input.name, input.language, input.timezone],
    );
    await audit('venue.updated', 'venue', '1', { oldName: previous.rows[0]?.name, newName: input.name }, { hostId: request.hostIdentity!.id });
    await emitEvent('venue.changed', {});
    return result.rows[0];
  });

  app.get('/api/v1/dashboard', { preHandler: requireHost }, async () => {
    const result = await pool.query(
      `WITH active_orders AS (
         SELECT COALESCE(sum(quantity),0)::int AS "openItemCount",
                COALESCE(sum(unit_price_cents::bigint*quantity),0)::float8 AS "openValueCents"
           FROM order_items WHERE status IN ('open','provisional')
       ) SELECT
        (SELECT count(*)::int FROM access_requests WHERE status='pending') AS "pendingRequests",
        (SELECT count(*)::int FROM rooms WHERE archived_at IS NULL) AS "activeRooms",
        (SELECT count(*)::int FROM guests WHERE archived_at IS NULL) AS "activeGuests",
        active_orders."openItemCount",active_orders."openValueCents",
        (SELECT COALESCE(sum(b.total_cents::bigint),0)::float8
           FROM bills b CROSS JOIN venue_settings v
          WHERE b.settled_at >= (date_trunc('day',now() AT TIME ZONE v.timezone) AT TIME ZONE v.timezone)
            AND b.voided_at IS NULL) AS "todaySalesCents"
        FROM active_orders`,
    );
    return result.rows[0];
  });

  app.get('/api/v1/rooms', { preHandler: requireHost }, async () => mapList((await pool.query(
    `SELECT r.id,r.name,r.position,r.version,count(g.id)::int AS "guestCount"
       FROM rooms r LEFT JOIN guests g ON g.room_id=r.id AND g.archived_at IS NULL
      WHERE r.archived_at IS NULL GROUP BY r.id ORDER BY r.position,r.name`,
  )).rows));

  app.post('/api/v1/rooms', { preHandler: requireAdmin }, async (request, reply) => {
    const input = body(roomCreateSchema, request);
    const created = await transaction(async (client) => {
      await client.query('LOCK TABLE rooms IN SHARE ROW EXCLUSIVE MODE');
      const replay = await client.query<{ id:string;name:string;position:number;version:number;hostId:string;commandName:string }>(
        `SELECT id,name,position,version,created_by_host AS "hostId",create_name AS "commandName"
           FROM rooms WHERE create_mutation_id=$1`,
        [input.mutationId],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This room creation belongs to another host.');
        if (replay.rows[0].commandName !== input.name) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different room creation command.');
        const { hostId: _hostId, commandName: _commandName, ...room } = replay.rows[0];
        return { room, event: undefined };
      }
      const result = await client.query<{ id:string;name:string;position:number;version:number }>(
        `INSERT INTO rooms(name,position,create_mutation_id,create_name,created_by_host)
         VALUES ($1,(SELECT COALESCE(max(position),-1)+1 FROM rooms),$2,$1,$3) RETURNING id,name,position,version`,
        [input.name,input.mutationId,request.hostIdentity!.id],
      );
      return { room: result.rows[0]!, event: await storeEvent('rooms.changed', {}, client) };
    });
    if (created.event) {
      try { publishEvent(created.event); }
      catch (error) { app.log.error(error, 'Could not publish committed room event'); }
    }
    return reply.code(201).send(created.room);
  });

  app.patch('/api/v1/rooms/:id', { preHandler: requireAdmin }, async (request) => {
    const input = body(roomInputSchema, request);
    const result = await pool.query('UPDATE rooms SET name=$1,version=version+1 WHERE id=$2 AND archived_at IS NULL RETURNING id,name,position,version', [input.name, id(request)]);
    if (!result.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
    await emitEvent('rooms.changed', {});
    return result.rows[0];
  });

  app.put('/api/v1/rooms/order', { preHandler: requireAdmin }, async (request) => {
    const ids = body(z.object({ ids: z.array(z.string().uuid()) }), request).ids;
    await transaction(async (client) => {
      for (const [position, roomId] of ids.entries()) await client.query('UPDATE rooms SET position=$1 WHERE id=$2 AND archived_at IS NULL', [position, roomId]);
    });
    await emitEvent('rooms.changed', {});
    return { ok: true };
  });

  app.delete('/api/v1/rooms/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const roomId = id(request);
    await transaction(async (client) => {
      const room = await client.query('SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [roomId]);
      if (!room.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
      const active = await client.query('SELECT 1 FROM guests WHERE room_id=$1 AND archived_at IS NULL LIMIT 1', [roomId]);
      if (active.rowCount) throw new HttpError(409, 'ROOM_HAS_GUESTS', 'Move or archive active guests first.');
      const pending = await client.query(`SELECT 1 FROM access_requests WHERE room_id=$1 AND status='pending' LIMIT 1`, [roomId]);
      if (pending.rowCount) throw new HttpError(409, 'ROOM_HAS_REQUESTS', 'Resolve pending access requests first.');
      await client.query('UPDATE rooms SET archived_at=now(),version=version+1 WHERE id=$1', [roomId]);
    });
    await emitEvent('rooms.changed', {});
    return reply.code(204).send();
  });

  app.get('/api/v1/guests', { preHandler: requireHost }, async () => mapList((await pool.query(
    `SELECT g.id,g.name,g.language,g.room_id AS "roomId",r.name AS "roomName",g.version,
            COALESCE(sum(CASE WHEN oi.status IN ('open','provisional') THEN oi.unit_price_cents*oi.quantity ELSE 0 END),0)::int AS "totalCents",
            COALESCE(sum(CASE WHEN oi.status IN ('open','provisional') THEN oi.quantity ELSE 0 END),0)::int AS "itemCount"
       FROM guests g JOIN rooms r ON r.id=g.room_id LEFT JOIN order_tabs t ON t.guest_id=g.id AND t.status='open'
       LEFT JOIN order_items oi ON oi.tab_id=t.id WHERE g.archived_at IS NULL GROUP BY g.id,r.name,r.position ORDER BY r.position,g.name`,
  )).rows));

  app.post('/api/v1/guests', { preHandler: requireHost }, async (request, reply) => {
    const input = body(guestCreateSchema, request);
    const result = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.mutationId]);
      const replay = await client.query<{id:string;name:string;roomId:string;language:string;version:number;hostId:string;commandName:string;commandRoomId:string;commandLanguage:string}>(
        `SELECT id,name,room_id AS "roomId",language,version,created_by_host AS "hostId",create_name AS "commandName",
                create_room_id AS "commandRoomId",create_language AS "commandLanguage"
           FROM guests WHERE create_mutation_id=$1`,[input.mutationId],
      );
      if(replay.rows[0]){
        const prior=replay.rows[0];
        if(prior.hostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','This guest creation belongs to another host.');
        if(prior.commandName!==input.name||prior.commandRoomId!==input.roomId||prior.commandLanguage!==input.language) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to a different guest creation command.');
        const {hostId:_hostId,commandName:_commandName,commandRoomId:_commandRoomId,commandLanguage:_commandLanguage,...guest}=prior;
        return {guest,event:undefined};
      }
      const room = await client.query('SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [input.roomId]);
      if (!room.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
      const created = await client.query<{id:string;name:string;roomId:string;language:string;version:number}>(
        `INSERT INTO guests(name,room_id,language,create_mutation_id,create_name,create_room_id,create_language,created_by_host)
         VALUES ($1,$2,$3,$4,$1,$2,$3,$5) RETURNING id,name,room_id AS "roomId",language,version`,
        [input.name,input.roomId,input.language,input.mutationId,request.hostIdentity!.id],
      );
      const event = await storeEvent('guests.changed', {}, client);
      return { guest:created.rows[0]!, event };
    });
    if(result.event){try { publishEvent(result.event); }
    catch (error) { app.log.error(error, 'Could not publish committed guest event'); }}
    return reply.code(201).send(result.guest);
  });

  app.patch('/api/v1/guests/:id', { preHandler: requireHost }, async (request) => {
    const input = body(guestInputSchema, request);
    const guestId = id(request);
    const result = await transaction(async (client) => {
      const room = await client.query('SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [input.roomId]);
      if (!room.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
      return client.query(
        'UPDATE guests SET name=$1,room_id=$2,language=$3,version=version+1 WHERE id=$4 AND archived_at IS NULL RETURNING id,name,room_id AS "roomId",language,version',
        [input.name, input.roomId, input.language, guestId],
      );
    });
    if (!result.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
    await emitEvent('guests.changed', {});
    return result.rows[0];
  });

  app.delete('/api/v1/guests/:id', { preHandler: requireHost }, async (request, reply) => {
    const guestId = id(request);
    await transaction(async (client) => {
      const guest = await client.query('SELECT id FROM guests WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [guestId]);
      if (!guest.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
      const open = await client.query(`SELECT 1 FROM order_tabs t JOIN order_items i ON i.tab_id=t.id WHERE t.guest_id=$1 AND i.status IN ('open','provisional') LIMIT 1`, [guestId]);
      if (open.rowCount) throw new HttpError(409, 'GUEST_HAS_ORDERS', 'Settle or void open orders first.');
      await client.query('UPDATE guests SET archived_at=now(),version=version+1 WHERE id=$1', [guestId]);
      await client.query('UPDATE guest_sessions SET revoked_at=now() WHERE guest_id=$1 AND revoked_at IS NULL', [guestId]);
    });
    await emitEvent('guests.changed', {});
    return reply.code(204).send();
  });

  app.get('/api/v1/guests/:id/sessions', { preHandler: requireHost }, async (request) => mapList((await pool.query(
    `SELECT id,user_agent AS "userAgent",created_at AS "createdAt",expires_at AS "expiresAt"
       FROM guest_sessions WHERE guest_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`,[id(request)],
  )).rows));

  app.delete('/api/v1/guests/:guestId/sessions/:id', { preHandler: requireHost }, async (request, reply) => {
    const params=request.params as {guestId:string;id:string};
    if(!z.string().uuid().safeParse(params.guestId).success||!z.string().uuid().safeParse(params.id).success) throw new HttpError(400,'INVALID_ID','A valid identifier is required.');
    await pool.query('UPDATE guest_sessions SET revoked_at=now() WHERE id=$1 AND guest_id=$2',[params.id,params.guestId]);
    await audit('guest-session.revoked','guest-session',params.id,{guestId:params.guestId},{hostId:request.hostIdentity!.id});
    await emitEvent('guest-access.changed',{guestId:params.guestId});
    return reply.code(204).send();
  });

  app.get('/api/v1/categories', { preHandler: requireHost }, async () => mapList((await pool.query(
    'SELECT id,name,position,version FROM categories WHERE archived_at IS NULL ORDER BY position',
  )).rows));

  app.post('/api/v1/categories', { preHandler: requireAdmin }, async (request, reply) => {
    const input = body(categoryCreateSchema, request);
    const created = await transaction(async (client) => {
      await client.query('LOCK TABLE categories IN SHARE ROW EXCLUSIVE MODE');
      const replay = await client.query<{id:string;name:Record<string,string>;position:number;version:number;hostId:string;commandName:Record<string,string>}>(
        `SELECT id,name,position,version,created_by_host AS "hostId",create_name AS "commandName"
           FROM categories WHERE create_mutation_id=$1`,[input.mutationId],
      );
      if(replay.rows[0]){
        if(replay.rows[0].hostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','This category creation belongs to another host.');
        if(!isDeepStrictEqual(replay.rows[0].commandName,input.name)) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to a different category creation command.');
        const {hostId:_hostId,commandName:_commandName,...category}=replay.rows[0];
        return {category,event:undefined};
      }
      const result=await client.query<{id:string;name:Record<string,string>;position:number;version:number}>(
        `INSERT INTO categories(name,position,create_mutation_id,create_name,created_by_host)
         VALUES ($1,(SELECT COALESCE(max(position),-1)+1 FROM categories),$2,$1,$3)
         RETURNING id,name,position,version`,[JSON.stringify(input.name),input.mutationId,request.hostIdentity!.id],
      );
      return {category:result.rows[0]!,event:await storeEvent('catalog.changed',{},client)};
    });
    if(created.event){try{publishEvent(created.event)}catch(error){app.log.error(error,'Could not publish committed catalog event')}}
    return reply.code(201).send(created.category);
  });

  app.get('/api/v1/products', { preHandler: requireHost }, async () => {
    const result = await pool.query<{ catalogVersion: number; data: unknown[] }>(
      `SELECT v.catalog_version AS "catalogVersion",
              COALESCE((
                SELECT jsonb_agg(to_jsonb(catalog_product) ORDER BY catalog_product."categoryId",catalog_product.position)
                  FROM (
                    SELECT p.id,p.category_id AS "categoryId",p.name,p.description,p.price_cents AS "priceCents",p.enabled,
                           p.self_service_only AS "selfServiceOnly",p.position,p.version
                      FROM products p WHERE p.archived_at IS NULL
                  ) catalog_product
              ),'[]'::jsonb) AS data
         FROM venue_settings v WHERE v.id=1`,
    );
    return result.rows[0] ?? { catalogVersion: 1, data: [] };
  });

  app.post('/api/v1/products', { preHandler: requireAdmin }, async (request, reply) => {
    const input = body(productCreateSchema, request);
    const result = await transaction(async (client) => {
      type ProductCreateReplay = {
        hostId: string; productId: string | null; commandCategoryId: string; commandName: Record<string, string>;
        commandDescription: Record<string, string> | null; commandPriceCents: number; commandEnabled: boolean;
        commandSelfServiceOnly: boolean; id: string; categoryId: string; name: Record<string, string>;
        description: Record<string, string> | null; priceCents: number; enabled: boolean; selfServiceOnly: boolean;
        position: number; version: number;
      };
      const findReplay = async () => (await client.query<ProductCreateReplay>(
        `SELECT c.host_id AS "hostId",c.product_id AS "productId",c.category_id AS "commandCategoryId",c.name AS "commandName",
                c.description AS "commandDescription",c.price_cents AS "commandPriceCents",c.enabled AS "commandEnabled",
                c.self_service_only AS "commandSelfServiceOnly",p.id,p.category_id AS "categoryId",p.name,p.description,
                p.price_cents AS "priceCents",p.enabled,p.self_service_only AS "selfServiceOnly",p.position,p.version
           FROM product_create_commands c LEFT JOIN products p ON p.id=c.product_id WHERE c.mutation_id=$1`,
        [input.mutationId],
      )).rows[0];
      const replayProduct = (stored: ProductCreateReplay) => {
        if (stored.hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This product creation belongs to another host.');
        if (stored.commandCategoryId !== input.categoryId
          || !isDeepStrictEqual(stored.commandName, input.name)
          || !isDeepStrictEqual(stored.commandDescription, input.description ?? null)
          || stored.commandPriceCents !== input.priceCents
          || stored.commandEnabled !== input.enabled
          || stored.commandSelfServiceOnly !== input.selfServiceOnly) {
          throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different product creation command.');
        }
        if (!stored.productId) throw new HttpError(409, 'MUTATION_PENDING', 'This product creation is still being processed.');
        return {
          id: stored.id, categoryId: stored.categoryId, name: stored.name, description: stored.description,
          priceCents: stored.priceCents, enabled: stored.enabled, selfServiceOnly: stored.selfServiceOnly,
          position: stored.position, version: stored.version,
        };
      };
      const reserved = await client.query(
        `INSERT INTO product_create_commands(mutation_id,host_id,category_id,name,description,price_cents,enabled,self_service_only)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (mutation_id) DO NOTHING RETURNING mutation_id`,
        [input.mutationId, request.hostIdentity!.id, input.categoryId, JSON.stringify(input.name), input.description ? JSON.stringify(input.description) : null, input.priceCents, input.enabled, input.selfServiceOnly],
      );
      if (!reserved.rowCount) {
        const replay = await findReplay();
        if (!replay) throw new HttpError(409, 'MUTATION_PENDING', 'This product creation is still being processed.');
        return { product: replayProduct(replay), event: undefined };
      }
      const version = (await client.query<{ catalogVersion: number }>(
        'UPDATE venue_settings SET catalog_version=catalog_version+1 WHERE id=1 RETURNING catalog_version AS "catalogVersion"',
      )).rows[0]!.catalogVersion;
      const product = (await client.query(
        `INSERT INTO products(category_id,name,description,price_cents,enabled,self_service_only,position,catalog_version)
         VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(position),-1)+1 FROM products WHERE category_id=$1),$7)
         RETURNING id,category_id AS "categoryId",name,description,price_cents AS "priceCents",enabled,self_service_only AS "selfServiceOnly",position,version`,
        [input.categoryId, JSON.stringify(input.name), input.description ? JSON.stringify(input.description) : null, input.priceCents, input.enabled, input.selfServiceOnly, version],
      )).rows[0];
      await client.query('INSERT INTO product_versions(product_id,catalog_version,name,price_cents,enabled,self_service_only) VALUES ($1,$2,$3,$4,$5,$6)', [product.id, version, JSON.stringify(input.name), input.priceCents, input.enabled, input.selfServiceOnly]);
      await client.query('UPDATE product_create_commands SET product_id=$1 WHERE mutation_id=$2', [product.id, input.mutationId]);
      const event = await storeEvent('catalog.changed', {}, client);
      return { product, event };
    });
    if (result.event) {
      try { publishEvent(result.event); }
      catch (error) { app.log.error(error, 'Could not publish committed catalog event'); }
    }
    return reply.code(201).send(result.product);
  });

  app.patch('/api/v1/products/:id', { preHandler: requireAdmin }, async (request) => {
    const productId = id(request);
    const input = body(productInputSchema, request);
    const result = await transaction(async (client) => {
      const version = (await client.query<{ catalogVersion: number }>('UPDATE venue_settings SET catalog_version=catalog_version+1 WHERE id=1 RETURNING catalog_version AS "catalogVersion"')).rows[0]!.catalogVersion;
      const productResult = await client.query(
        `UPDATE products SET category_id=$1,name=$2,description=$3,price_cents=$4,enabled=$5,self_service_only=$6,
                catalog_version=$7,version=version+1 WHERE id=$8 AND archived_at IS NULL
         RETURNING id,category_id AS "categoryId",name,description,price_cents AS "priceCents",enabled,self_service_only AS "selfServiceOnly",position,version`,
        [input.categoryId, JSON.stringify(input.name), input.description ? JSON.stringify(input.description) : null, input.priceCents, input.enabled, input.selfServiceOnly, version, productId],
      );
      if (!productResult.rowCount) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
      await client.query('INSERT INTO product_versions(product_id,catalog_version,name,price_cents,enabled,self_service_only) VALUES ($1,$2,$3,$4,$5,$6)', [productId, version, JSON.stringify(input.name), input.priceCents, input.enabled, input.selfServiceOnly]);
      return productResult.rows[0];
    });
    await emitEvent('catalog.changed', {});
    return result;
  });

  app.delete('/api/v1/products/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const productId=id(request);
    await transaction(async (client) => {
      const version=(await client.query<{catalogVersion:number}>('UPDATE venue_settings SET catalog_version=catalog_version+1 WHERE id=1 RETURNING catalog_version AS "catalogVersion"')).rows[0]!.catalogVersion;
      const product=await client.query<{name:Record<string,string>;priceCents:number;selfServiceOnly:boolean}>(
        `UPDATE products SET archived_at=now(),enabled=false,catalog_version=$1,version=version+1
          WHERE id=$2 AND archived_at IS NULL
          RETURNING name,price_cents AS "priceCents",self_service_only AS "selfServiceOnly"`,[version,productId]);
      if(!product.rowCount) throw new HttpError(404,'PRODUCT_NOT_FOUND','Product not found.');
      const archived=product.rows[0]!;
      await client.query(
        'INSERT INTO product_versions(product_id,catalog_version,name,price_cents,enabled,self_service_only) VALUES ($1,$2,$3,$4,false,$5)',
        [productId,version,JSON.stringify(archived.name),archived.priceCents,archived.selfServiceOnly]);
    });
    await emitEvent('catalog.changed', {});
    return reply.code(204).send();
  });

  app.get('/api/v1/access-requests', { preHandler: requireHost }, async () => mapList((await pool.query(
    `SELECT a.id,a.name,a.room_id AS "roomId",r.name AS "roomName",a.language,a.status,a.requested_at AS "requestedAt"
       FROM access_requests a JOIN rooms r ON r.id=a.room_id WHERE a.status='pending' ORDER BY a.requested_at`,
  )).rows));

  app.post('/api/v1/access-requests/:id/approve', { preHandler: requireHost }, async (request) => {
    const requestId = id(request);
    const input = body(accessApprovalSchema, request);
    const result = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.mutationId]);
      const replay=await client.query<{requestId:string;guestId:string;hostId:string;commandGuestId:string|null;commandExpiresAt:Date}>(
        `SELECT id AS "requestId",guest_id AS "guestId",resolved_by AS "hostId",approval_linked_guest_id AS "commandGuestId",
                approval_expires_at AS "commandExpiresAt" FROM access_requests WHERE approval_mutation_id=$1`,[input.mutationId],
      );
      if(replay.rows[0]){
        const prior=replay.rows[0];
        if(prior.requestId!==requestId) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to another access approval.');
        if(prior.hostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','This access approval belongs to another host.');
        if(prior.commandGuestId!==(input.guestId??null)||prior.commandExpiresAt.getTime()!==new Date(input.expiresAt).getTime()) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to a different access approval command.');
        return {guestId:prior.guestId,events:[] as RealtimeEvent[]};
      }
      if (new Date(input.expiresAt) <= new Date()) throw new HttpError(400, 'INVALID_EXPIRY', 'Expiry must be in the future.');
      const pending = await client.query<{ name: string; roomId: string; language: string }>(
        `SELECT name,room_id AS "roomId",language FROM access_requests WHERE id=$1 AND status='pending' FOR UPDATE`, [requestId],
      );
      const access = pending.rows[0];
      if (!access) throw new HttpError(409, 'REQUEST_RESOLVED', 'This request is no longer pending.');
      const room = await client.query('SELECT id FROM rooms WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [access.roomId]);
      if (!room.rowCount) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found.');
      let guestId = input.guestId;
      if (guestId) {
        const guest = await client.query('SELECT id FROM guests WHERE id=$1 AND room_id=$2 AND archived_at IS NULL FOR UPDATE', [guestId, access.roomId]);
        if (!guest.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
      } else {
        guestId = (await client.query<{ id: string }>('INSERT INTO guests(name,room_id,language) VALUES ($1,$2,$3) RETURNING id', [access.name, access.roomId, access.language])).rows[0]!.id;
      }
      await client.query(
        `UPDATE access_requests SET status='approved',guest_id=$1,expires_at=$2,resolved_at=now(),resolved_by=$3,
                approval_mutation_id=$4,approval_linked_guest_id=$5,approval_expires_at=$2 WHERE id=$6`,
        [guestId,input.expiresAt,request.hostIdentity!.id,input.mutationId,input.guestId??null,requestId],
      );
      await audit('access.approved', 'access-request', requestId, { guestId, expiresAt: input.expiresAt }, { hostId: request.hostIdentity!.id }, client);
      const events=[await storeEvent('access-request.changed',{id:requestId},client),await storeEvent('guests.changed',{},client)];
      return { guestId,events };
    });
    for(const event of result.events){try{publishEvent(event)}catch(error){app.log.error(error,'Could not publish committed access approval event')}}
    return {guestId:result.guestId};
  });

  app.post('/api/v1/access-requests/:id/deny', { preHandler: requireHost }, async (request) => {
    const requestId = id(request);
    const result = await pool.query(`UPDATE access_requests SET status='denied',resolved_at=now(),resolved_by=$1 WHERE id=$2 AND status='pending' RETURNING id`, [request.hostIdentity!.id, requestId]);
    if (!result.rowCount) throw new HttpError(409, 'REQUEST_RESOLVED', 'This request is no longer pending.');
    await audit('access.denied', 'access-request', requestId, {}, { hostId: request.hostIdentity!.id });
    await emitEvent('access-request.changed', { id: requestId });
    return { ok: true };
  });

  app.get('/api/v1/orders', { preHandler: requireHost }, async () => mapList((await pool.query(
    `SELECT t.id,t.guest_id AS "guestId",g.name AS "guestName",r.name AS "roomName",t.opened_at AS "openedAt",
            COALESCE(sum(CASE WHEN i.status IN ('open','provisional') THEN i.quantity ELSE 0 END),0)::int AS "itemCount",
            COALESCE(sum(CASE WHEN i.status IN ('open','provisional') THEN i.unit_price_cents*i.quantity ELSE 0 END),0)::int AS "totalCents"
       FROM order_tabs t JOIN guests g ON g.id=t.guest_id JOIN rooms r ON r.id=g.room_id
       LEFT JOIN order_items i ON i.tab_id=t.id WHERE t.status='open' GROUP BY t.id,g.name,r.name
       HAVING count(i.id) FILTER (WHERE i.status IN ('open','provisional'))>0 ORDER BY t.opened_at`,
  )).rows));

  app.get('/api/v1/guests/:id/tab', { preHandler: requireHost }, async (request) => tabDetail(id(request)));

  app.post('/api/v1/order-batches', { preHandler: requireHost }, async (request, reply) => {
    const input = body(orderBatchSchema, request);
    if(input.originHostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','Queued orders can only be submitted by their originating host.');
    const result = await transaction(async (client) => {
      const replay = async () => {
        const duplicate = await client.query<{ tabId: string; hostId: string; guestId: string; command: unknown }>(
          `SELECT b.tab_id AS "tabId",b.host_id AS "hostId",t.guest_id AS "guestId",b.command
             FROM order_batches b JOIN order_tabs t ON t.id=b.tab_id WHERE b.mutation_id=$1`,
          [input.mutationId],
        );
        if (!duplicate.rows[0]) return undefined;
        if (duplicate.rows[0].hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This order belongs to another host.');
        if (duplicate.rows[0].guestId !== input.guestId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another guest.');
        if (duplicate.rows[0].command!==null&&!isDeepStrictEqual(duplicate.rows[0].command, input)) {
          throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different order command.');
        }
        return { tabId: duplicate.rows[0].tabId };
      };
      const duplicate = await replay();
      if (duplicate) return duplicate;
      const guest = await client.query('SELECT id FROM guests WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [input.guestId]);
      if (!guest.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
      const serializedDuplicate = await replay();
      if (serializedDuplicate) return serializedDuplicate;
      const tabId = await activeTab(input.guestId, client);
      const resolvedLines: { productId: string; quantity: number; name: Record<string, string>; priceCents: number }[] = [];
      let additionalCents = 0n;
      for (const line of input.items) {
        const product = await client.query<{ name: Record<string, string>; priceCents: number; enabled:boolean; selfServiceOnly:boolean }>(
          `SELECT name,price_cents AS "priceCents",enabled,self_service_only AS "selfServiceOnly" FROM product_versions
            WHERE product_id=$1 AND catalog_version<=$2 ORDER BY catalog_version DESC LIMIT 1`,
          [line.productId, input.catalogVersion],
        );
        const snapshot = product.rows[0];
        if (!snapshot||!snapshot.enabled||snapshot.selfServiceOnly) throw new HttpError(409, 'CATALOG_CONFLICT', 'A selected product is unavailable in the captured catalog.');
        resolvedLines.push({ productId: line.productId, quantity: line.quantity, name: snapshot.name, priceCents: snapshot.priceCents });
        additionalCents += BigInt(snapshot.priceCents) * BigInt(line.quantity);
      }
      await ensureTabTotalWithinRange(tabId, additionalCents, client);
      const batch = await client.query<{ id: string }>(
        'INSERT INTO order_batches(mutation_id,tab_id,host_id,command,captured_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [input.mutationId, tabId, request.hostIdentity!.id, JSON.stringify(input), input.capturedAt],
      );
      for (const line of resolvedLines) {
        await client.query(
          `INSERT INTO order_items(tab_id,batch_id,product_id,product_name,unit_price_cents,quantity,source,status,submitted_by_host)
           VALUES ($1,$2,$3,$4,$5,$6,'host','open',$7)`,
          [tabId, batch.rows[0]!.id, line.productId, JSON.stringify(line.name), line.priceCents, line.quantity, request.hostIdentity!.id],
        );
      }
      await audit('order.batch-created', 'tab', tabId, { mutationId: input.mutationId }, { hostId: request.hostIdentity!.id }, client);
      return { tabId };
    });
    await emitEvent('orders.changed', { guestId: input.guestId });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/order-items/:id/void', { preHandler: requireHost }, async (request) => {
    const itemId = id(request);
    const input = body(voidSchema, request);
    const result = await transaction(async (client) => {
      const duplicate=await client.query<{itemId:string;tabId:string;guestId:string;hostId:string;reason:string}>(
        `SELECT i.id AS "itemId",i.tab_id AS "tabId",t.guest_id AS "guestId",i.voided_by_host AS "hostId",i.void_reason AS reason FROM order_items i JOIN order_tabs t ON t.id=i.tab_id
          WHERE i.host_void_mutation_id=$1`,[input.mutationId]);
      if(duplicate.rows[0]){
        if(duplicate.rows[0].itemId!==itemId) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to another item.');
        if(duplicate.rows[0].hostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','This void belongs to another host.');
        if(duplicate.rows[0].reason!==input.reason) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to a different void command.');
        return duplicate.rows[0];
      }
      const updated=await client.query<{tabId:string}>(
        `UPDATE order_items SET status='voided',voided_at=now(),voided_by_host=$1,void_reason=$2,host_void_mutation_id=$3
          WHERE id=$4 AND status IN ('open','provisional') RETURNING tab_id AS "tabId"`,
        [request.hostIdentity!.id,input.reason,input.mutationId,itemId]);
      if(!updated.rowCount){
        const replay=await client.query<{itemId:string;tabId:string;guestId:string;hostId:string;reason:string}>(
          `SELECT i.id AS "itemId",i.tab_id AS "tabId",t.guest_id AS "guestId",i.voided_by_host AS "hostId",i.void_reason AS reason FROM order_items i JOIN order_tabs t ON t.id=i.tab_id
            WHERE i.host_void_mutation_id=$1`,[input.mutationId]);
        if(replay.rows[0]){
          if(replay.rows[0].itemId!==itemId) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to another item.');
          if(replay.rows[0].hostId!==request.hostIdentity!.id) throw new HttpError(403,'HOST_MISMATCH','This void belongs to another host.');
          if(replay.rows[0].reason!==input.reason) throw new HttpError(409,'MUTATION_REUSED','This mutation identifier belongs to a different void command.');
          return replay.rows[0];
        }
        throw new HttpError(409,'ITEM_NOT_OPEN','The item is no longer open.');
      }
      const tab=await client.query<{guestId:string}>('SELECT guest_id AS "guestId" FROM order_tabs WHERE id=$1',[updated.rows[0]!.tabId]);
      await audit('order-item.voided','order-item',itemId,{reason:input.reason,mutationId:input.mutationId},{hostId:request.hostIdentity!.id},client);
      return {tabId:updated.rows[0]!.tabId,guestId:tab.rows[0]!.guestId};
    });
    await emitEvent('orders.changed', { guestId: result.guestId });
    return { ok: true };
  });

  app.post('/api/v1/tabs/:id/settle', { preHandler: requireHost }, async (request) => {
    const tabId = id(request);
    const input = body(settleTabSchema, request);
    const bill = await transaction(async (client) => {
      const replay = async () => {
        const duplicate = await client.query<{ id: string; number: string; guestId: string; hostId: string; tabId: string; totalCents: number; itemCount: number; paymentMethod: string; paymentNote: string | null }>(
          `SELECT b.id,b.number::text AS number,b.guest_id AS "guestId",b.host_id AS "hostId",b.tab_id AS "tabId",
                  b.total_cents AS "totalCents",b.payment_method AS "paymentMethod",b.payment_note AS "paymentNote",
                  COALESCE((SELECT sum(bi.quantity)::int FROM bill_items bi WHERE bi.bill_id=b.id),0) AS "itemCount"
             FROM bills b WHERE b.mutation_id=$1`,
          [input.mutationId],
        );
        if (!duplicate.rows[0]) return undefined;
        if (duplicate.rows[0].hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This settlement belongs to another host.');
        if (duplicate.rows[0].tabId !== tabId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another tab.');
        if (duplicate.rows[0].totalCents !== input.expectedTotalCents
          || duplicate.rows[0].itemCount !== input.expectedItemCount
          || duplicate.rows[0].paymentMethod !== input.paymentMethod
          || duplicate.rows[0].paymentNote !== (input.note ?? null)) {
          throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different settlement command.');
        }
        return duplicate.rows[0];
      };
      const duplicate = await replay();
      if (duplicate) return duplicate;
      const tab = await client.query<{
        guestId: string; guestName: string; roomName: string; venueName: string; venueTimezone: string;
      }>(
        `SELECT t.guest_id AS "guestId",g.name AS "guestName",r.name AS "roomName",v.name AS "venueName",v.timezone AS "venueTimezone"
           FROM order_tabs t JOIN guests g ON g.id=t.guest_id JOIN rooms r ON r.id=g.room_id CROSS JOIN venue_settings v
          WHERE t.id=$1 AND t.status='open' FOR UPDATE OF t`,
        [tabId],
      );
      const current = tab.rows[0];
      if (!current) {
        const serializedDuplicate = await replay();
        if (serializedDuplicate) return serializedDuplicate;
        throw new HttpError(409, 'TAB_NOT_OPEN', 'The tab is no longer open.');
      }
      if (!current.venueName.trim()) throw new HttpError(409, 'VENUE_REQUIRED', 'Set the venue name before billing.');
      const provisional = await client.query(`SELECT 1 FROM order_items WHERE tab_id=$1 AND status='provisional' AND provisional_until>now() LIMIT 1`, [tabId]);
      if (provisional.rowCount) throw new HttpError(409, 'UNDO_PENDING', 'Wait for the guest undo window to finish.');
      await client.query(`UPDATE order_items SET status='open' WHERE tab_id=$1 AND status='provisional'`, [tabId]);
      const items = await client.query<{
        id: string; productName: Record<string, string>; unitPriceCents: number; quantity: number; source: string;
      }>(
        `SELECT id,product_name AS "productName",unit_price_cents AS "unitPriceCents",quantity,source
           FROM order_items WHERE tab_id=$1 AND status='open' FOR UPDATE`,
        [tabId],
      );
      if (!items.rowCount) throw new HttpError(409, 'EMPTY_TAB', 'There are no open items to bill.');
      const exactTotal = items.rows.reduce((sum, item) => sum + BigInt(item.unitPriceCents) * BigInt(item.quantity), 0n);
      if (exactTotal > BigInt(MAX_MONEY_CENTS)) throw new HttpError(409, 'TAB_TOTAL_LIMIT', 'The open tab exceeds the maximum bill total.');
      const total = Number(exactTotal);
      const itemCount = items.rows.reduce((sum, item) => sum + item.quantity, 0);
      if (itemCount !== input.expectedItemCount || total !== input.expectedTotalCents) {
        throw new HttpError(409, 'TAB_CHANGED', 'The tab changed after settlement was opened. Review the current items and total.');
      }
      const created = await client.query<{ id: string; number: string }>(
        `INSERT INTO bills(tab_id,guest_id,host_id,mutation_id,venue_name,venue_timezone,guest_name,room_name,total_cents,payment_method,payment_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,number::text AS number`,
        [tabId, current.guestId, request.hostIdentity!.id, input.mutationId, current.venueName, current.venueTimezone, current.guestName, current.roomName, total, input.paymentMethod, input.note ?? null],
      );
      const newBill = created.rows[0]!;
      for (const item of items.rows) {
        await client.query(
          `INSERT INTO bill_items(bill_id,original_order_item_id,product_name,unit_price_cents,quantity,source) VALUES ($1,$2,$3,$4,$5,$6)`,
          [newBill.id, item.id, JSON.stringify(item.productName), item.unitPriceCents, item.quantity, item.source],
        );
      }
      await client.query(`UPDATE order_items SET status='billed',bill_id=$1 WHERE tab_id=$2 AND status='open'`, [newBill.id, tabId]);
      await client.query(`UPDATE order_tabs SET status='billed',closed_at=now() WHERE id=$1`, [tabId]);
      await audit('bill.settled', 'bill', newBill.id, { totalCents: total, paymentMethod: input.paymentMethod }, { hostId: request.hostIdentity!.id }, client);
      return { ...newBill, guestId: current.guestId };
    });
    await emitEvent('orders.changed', { guestId: bill.guestId });
    await emitEvent('bills.changed', { id: bill.id });
    return bill;
  });

  app.get('/api/v1/bills', { preHandler: requireHost }, async (request) => {
    const input = query(z.object({
      search: z.string().trim().max(120).default(''),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }), request);
    const search = input.search ?? '';
    const requestedPage = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const offset = (requestedPage - 1) * pageSize;
    const result = await pool.query<{ data: unknown[]; total: number }>(
      `WITH filtered AS (
         SELECT id,number::text AS number,venue_name AS "venueName",venue_timezone AS "venueTimezone",guest_name AS "guestName",room_name AS "roomName",total_cents AS "totalCents",
                payment_method AS "paymentMethod",settled_at AS "settledAt",voided_at AS "voidedAt",
                CASE WHEN number::text=$1 THEN 0 ELSE 1 END AS search_rank
           FROM bills
          WHERE $1='' OR number::text ILIKE '%'||$1||'%' OR guest_name ILIKE '%'||$1||'%' OR room_name ILIKE '%'||$1||'%'
       ), bill_page AS (
         SELECT id,number,"venueName","venueTimezone","guestName","roomName","totalCents","paymentMethod","settledAt","voidedAt"
           FROM filtered ORDER BY search_rank,"settledAt" DESC,id DESC LIMIT $2 OFFSET $3
       )
       SELECT COALESCE((SELECT jsonb_agg(to_jsonb(bill_page) ORDER BY "settledAt" DESC,id DESC) FROM bill_page),'[]'::jsonb) AS data,
              (SELECT count(*)::int FROM filtered) AS total`,
      [search, pageSize, offset],
    );
    const page = result.rows[0] ?? { data: [], total: 0 };
    return {
      data: page.data,
      pagination: {
        page: requestedPage,
        pageSize,
        total: page.total,
        totalPages: Math.max(1, Math.ceil(page.total / pageSize)),
      },
    };
  });

  app.get('/api/v1/bills/:id', { preHandler: requireHost }, async (request) => {
    const billId = id(request);
    const bill = await pool.query(
      `SELECT b.id,b.number::text AS number,b.venue_name AS "venueName",b.venue_timezone AS "venueTimezone",b.guest_name AS "guestName",b.room_name AS "roomName",
              b.total_cents AS "totalCents",b.payment_method AS "paymentMethod",b.payment_note AS "paymentNote",
              b.settled_at AS "settledAt",b.voided_at AS "voidedAt",b.void_reason AS "voidReason",h.name AS "hostName"
         FROM bills b JOIN hosts h ON h.id=b.host_id WHERE b.id=$1`, [billId],
    );
    if (!bill.rows[0]) throw new HttpError(404, 'BILL_NOT_FOUND', 'Bill not found.');
    const items = await pool.query(
      `SELECT product_name AS "productName",unit_price_cents AS "unitPriceCents",quantity,source FROM bill_items WHERE bill_id=$1`, [billId],
    );
    return { ...bill.rows[0], items: items.rows };
  });

  app.post('/api/v1/bills/:id/void', { preHandler: requireAdmin }, async (request) => {
    const billId = id(request);
    const input = body(voidSchema, request);
    const voided = await transaction(async (client) => {
      const duplicate = await client.query<{ billId: string; guestId: string; hostId: string; reason: string }>(
        `SELECT id AS "billId",guest_id AS "guestId",voided_by AS "hostId",void_reason AS reason FROM bills WHERE void_mutation_id=$1`,
        [input.mutationId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].billId !== billId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another bill.');
        if (duplicate.rows[0].hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This bill void belongs to another host.');
        if (duplicate.rows[0].reason !== input.reason) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different bill-void command.');
        return { guestId: duplicate.rows[0].guestId };
      }
      const owner = await client.query<{ guestId: string }>('SELECT guest_id AS "guestId" FROM bills WHERE id=$1', [billId]);
      if (!owner.rows[0]) throw new HttpError(404, 'BILL_NOT_FOUND', 'Bill not found.');
      const guest = await client.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE', [owner.rows[0].guestId]);
      if (!guest.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
      const result = await client.query<{ tabId: string; guestId: string; totalCents: number }>(
        `UPDATE bills SET voided_at=now(),void_reason=$1,voided_by=$2,void_mutation_id=$3
          WHERE id=$4 AND voided_at IS NULL
          RETURNING tab_id AS "tabId",guest_id AS "guestId",total_cents AS "totalCents"`,
        [input.reason, request.hostIdentity!.id, input.mutationId, billId],
      );
      const bill = result.rows[0];
      if (!bill) {
        const replay = await client.query<{ billId: string; guestId: string; hostId: string; reason: string }>(
          `SELECT id AS "billId",guest_id AS "guestId",voided_by AS "hostId",void_reason AS reason FROM bills WHERE void_mutation_id=$1`,
          [input.mutationId],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].billId !== billId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another bill.');
          if (replay.rows[0].hostId !== request.hostIdentity!.id) throw new HttpError(403, 'HOST_MISMATCH', 'This bill void belongs to another host.');
          if (replay.rows[0].reason !== input.reason) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to a different bill-void command.');
          return { guestId: replay.rows[0].guestId };
        }
        throw new HttpError(409, 'BILL_NOT_ACTIVE', 'The bill has already been voided.');
      }
      const open = await client.query<{ id: string }>(`SELECT id FROM order_tabs WHERE guest_id=$1 AND status='open' FOR UPDATE`, [bill.guestId]);
      const destination = open.rows[0]?.id ?? bill.tabId;
      await ensureTabTotalWithinRange(destination, BigInt(bill.totalCents), client);
      if (!open.rows[0]) await client.query(`UPDATE order_tabs SET status='open',closed_at=NULL WHERE id=$1`, [bill.tabId]);
      await client.query(`UPDATE order_items SET tab_id=$1,status='open',bill_id=NULL WHERE bill_id=$2`, [destination, billId]);
      await audit('bill.voided', 'bill', billId, { reason: input.reason, mutationId: input.mutationId }, { hostId: request.hostIdentity!.id }, client);
      return { guestId: bill.guestId };
    });
    await emitEvent('bills.changed', { id: billId });
    await emitEvent('orders.changed', { guestId: voided.guestId });
    return { ok: true };
  });

  app.get('/api/v1/events', { preHandler: async (request,reply)=>{
    if(await authenticateHost(request)) return;
    if(await authenticateGuest(request)) return;
    await reply.code(401).send({error:{code:'UNAUTHENTICATED',message:'Authentication required.'}});
  } }, async (request, reply) => {
    reply.hijack();
    const origin = request.headers.origin;
    if (origin) reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.write('retry: 3000\n\n');
    let closed = false;
    const authorized = () => request.hostIdentity
      ? hostSessionIsActive(request.hostIdentity.sessionId)
      : guestSessionIsActive(request.guestIdentity!.sessionId);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      clearInterval(revalidate);
      eventBus.off('event', listener);
    };
    const closeStream = () => {
      cleanup();
      if (!reply.raw.destroyed) reply.raw.end();
    };
    const listener = (event: RealtimeEvent) => {
      if(request.guestIdentity){
        const visible=guestRealtimeEvent(event,request.guestIdentity.id);
        if(!visible) return;
        void authorized().then((active) => {
          if (!active) return closeStream();
          if (!closed) reply.raw.write(`id: ${visible.id}\nevent: ${visible.topic}\ndata: ${JSON.stringify(visible.payload)}\n\n`);
        }).catch(closeStream);
        return;
      }
      void authorized().then((active) => {
        if (!active) return closeStream();
        if (!closed) reply.raw.write(`id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      }).catch(closeStream);
    };
    const keepAlive = setInterval(() => { if (!closed) reply.raw.write(': keepalive\n\n'); }, 20_000);
    const revalidate = setInterval(() => {
      void authorized().then((active) => { if (!active) closeStream(); }).catch(closeStream);
    }, 15_000);
    keepAlive.unref();
    revalidate.unref();
    eventBus.on('event', listener);
    request.raw.on('close', cleanup);
  });

  app.get('/api/v1/guest/me', { preHandler: requireGuest }, async (request) => ({ guest: request.guestIdentity }));
  app.post('/api/v1/guest/logout', { preHandler: requireGuest }, async (request, reply) => {
    await pool.query('UPDATE guest_sessions SET revoked_at=now() WHERE id=$1', [request.guestIdentity!.sessionId]);
    clearGuestCookie(reply);
    return reply.code(204).send();
  });
  app.get('/api/v1/guest/tab', { preHandler: requireGuest }, async (request) => tabDetail(request.guestIdentity!.id));
  app.get('/api/v1/guest/catalog', { preHandler: requireGuest }, async () => {
    const result = await pool.query(
      `SELECT p.id,p.name,p.description,p.price_cents AS "priceCents",p.category_id AS "categoryId",c.name AS "categoryName"
         FROM products p JOIN categories c ON c.id=p.category_id
        WHERE p.archived_at IS NULL AND p.enabled=true AND p.self_service_only=true AND c.archived_at IS NULL
        ORDER BY c.position,p.position`,
    );
    return mapList(result.rows);
  });

  app.post('/api/v1/guest/items', { preHandler: requireGuest }, async (request, reply) => {
    const input = body(z.object({ mutationId: z.string().uuid(), productId: z.string().uuid() }), request);
    const item = await transaction(async (client) => {
      const replay = async () => {
        const duplicate = await client.query<{ id: string; provisionalUntil: string; sessionId: string; productId: string }>(
          `SELECT id,provisional_until AS "provisionalUntil",submitted_by_guest_session AS "sessionId",product_id AS "productId"
             FROM order_items WHERE guest_mutation_id=$1`,
          [input.mutationId],
        );
        if (!duplicate.rows[0]) return undefined;
        if (duplicate.rows[0].sessionId !== request.guestIdentity!.sessionId) throw new HttpError(403, 'GUEST_MISMATCH', 'This item belongs to another guest device.');
        if (duplicate.rows[0].productId !== input.productId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another product.');
        return duplicate.rows[0];
      };
      const duplicate = await replay();
      if (duplicate) return duplicate;
      const guest = await client.query('SELECT id FROM guests WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [request.guestIdentity!.id]);
      if (!guest.rowCount) throw new HttpError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
      const serializedDuplicate = await replay();
      if (serializedDuplicate) return serializedDuplicate;
      const product = await client.query<{ name: Record<string, string>; priceCents: number }>(
        `SELECT name,price_cents AS "priceCents" FROM products WHERE id=$1 AND enabled=true AND self_service_only=true AND archived_at IS NULL`,
        [input.productId],
      );
      const selected = product.rows[0];
      if (!selected) throw new HttpError(404, 'PRODUCT_NOT_AVAILABLE', 'This self-service product is unavailable.');
      const tabId = await activeTab(request.guestIdentity!.id, client);
      await ensureTabTotalWithinRange(tabId, BigInt(selected.priceCents), client);
      const result = await client.query(
        `INSERT INTO order_items(tab_id,product_id,product_name,unit_price_cents,quantity,source,status,submitted_by_guest_session,provisional_until,guest_mutation_id)
         VALUES ($1,$2,$3,$4,1,'guest','provisional',$5,now()+interval '10 seconds',$6)
         RETURNING id,provisional_until AS "provisionalUntil"`,
        [tabId, input.productId, JSON.stringify(selected.name), selected.priceCents, request.guestIdentity!.sessionId, input.mutationId],
      );
      await audit('guest-item.submitted', 'order-item', result.rows[0].id, {}, { guestSessionId: request.guestIdentity!.sessionId }, client);
      return result.rows[0];
    });
    await emitEvent('orders.changed', { guestId: request.guestIdentity!.id });
    return reply.code(201).send(item);
  });

  app.post('/api/v1/guest/items/:id/undo', { preHandler: requireGuest }, async (request) => {
    const itemId = id(request);
    const input = body(z.object({ mutationId: z.string().uuid() }), request);
    await transaction(async (client) => {
      const duplicate = await client.query<{ itemId: string; sessionId: string }>(
        `SELECT id AS "itemId",submitted_by_guest_session AS "sessionId" FROM order_items WHERE guest_undo_mutation_id=$1`,
        [input.mutationId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].itemId !== itemId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another item.');
        if (duplicate.rows[0].sessionId !== request.guestIdentity!.sessionId) throw new HttpError(403, 'GUEST_MISMATCH', 'This undo belongs to another guest device.');
        return;
      }
      const result = await client.query(
        `UPDATE order_items SET status='voided',voided_at=now(),void_reason='guest-undo',guest_undo_mutation_id=$1
          WHERE id=$2 AND submitted_by_guest_session=$3 AND status='provisional' AND provisional_until>now() RETURNING id`,
        [input.mutationId, itemId, request.guestIdentity!.sessionId],
      );
      if (!result.rowCount) {
        const replay = await client.query<{ itemId: string; sessionId: string }>(
          `SELECT id AS "itemId",submitted_by_guest_session AS "sessionId" FROM order_items WHERE guest_undo_mutation_id=$1`,
          [input.mutationId],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].itemId !== itemId) throw new HttpError(409, 'MUTATION_REUSED', 'This mutation identifier belongs to another item.');
          if (replay.rows[0].sessionId !== request.guestIdentity!.sessionId) throw new HttpError(403, 'GUEST_MISMATCH', 'This undo belongs to another guest device.');
          return;
        }
        throw new HttpError(409, 'UNDO_EXPIRED', 'The undo window has expired.');
      }
      await audit('guest-item.undone', 'order-item', itemId, { mutationId: input.mutationId }, { guestSessionId: request.guestIdentity!.sessionId }, client);
    });
    await emitEvent('orders.changed', { guestId: request.guestIdentity!.id });
    return { ok: true };
  });
}
