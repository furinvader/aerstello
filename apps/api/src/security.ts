import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { config, type AccessCapabilityKey } from './config.js';
import { pool } from './db.js';

export interface HostIdentity {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'staff';
  language: 'de' | 'it' | 'en';
  version: number;
  sessionId: string;
}

export interface VerifiedHostLogin {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'staff';
  language: 'de' | 'it' | 'en';
}

export interface GuestIdentity {
  id: string;
  name: string;
  language: 'de' | 'it' | 'en';
  roomId: string;
  roomName: string;
  sessionId: string;
  expiresAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    hostIdentity?: HostIdentity;
    guestIdentity?: GuestIdentity;
  }
}

const hostCookie = 'aerstello_host';
const guestCookie = 'aerstello_guest';

export function hashToken(token: string, secret = config.SESSION_SECRET): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function guestGrantToken(requestId: string, grantExchangeId: string): string {
  return createHmac('sha256', config.SESSION_SECRET)
    .update(`guest-grant:${requestId}:${grantExchangeId}`)
    .digest('base64url');
}

export function accessStatusToken(mutationId: string, key = config.ACCESS_CAPABILITY_KEYS[0]!): string {
  return createHmac('sha256', key.secret)
    .update(`access-status:${mutationId}`)
    .digest('base64url');
}

export interface AccessStatusCapability {
  keyId: string;
  token: string;
  verifier: string;
}

function accessStatusVerifier(token: string, key: AccessCapabilityKey): string {
  return hashToken(token, key.secret);
}

function sameVerifier(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && leftBytes.length > 0 && timingSafeEqual(leftBytes, rightBytes);
}

export function issueAccessStatusCapability(
  mutationId: string,
  keys: readonly AccessCapabilityKey[] = config.ACCESS_CAPABILITY_KEYS,
): AccessStatusCapability {
  const key = keys[0];
  if (!key) throw new Error('No access capability key is configured.');
  const token = accessStatusToken(mutationId, key);
  return { keyId: key.id, token, verifier: accessStatusVerifier(token, key) };
}

export function accessStatusVerifierCandidates(
  token: string,
  keys: readonly AccessCapabilityKey[] = config.ACCESS_CAPABILITY_KEYS,
): Array<{ keyId: string; verifier: string }> {
  return keys.map((key) => ({ keyId: key.id, verifier: accessStatusVerifier(token, key) }));
}

export function recoverAccessStatusCapability(
  mutationId: string,
  storedVerifier: string,
  storedKeyId: string,
  keys: readonly AccessCapabilityKey[] = config.ACCESS_CAPABILITY_KEYS,
): AccessStatusCapability | undefined {
  const key = keys.find((candidate) => candidate.id === storedKeyId);
  if (!key) return undefined;
  const token = accessStatusToken(mutationId, key);
  const verifier = accessStatusVerifier(token, key);
  return sameVerifier(verifier, storedVerifier) ? { keyId: key.id, token, verifier } : undefined;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

function cookieOptions(expires: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    expires,
  };
}

export async function createHostSession(client: pg.Pool | pg.PoolClient, hostId: string, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = newToken();
  const result = await client.query<{ expiresAt: Date }>(
    `INSERT INTO host_sessions(host_id, token_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,now()+interval '30 days')
     RETURNING expires_at AS "expiresAt"`,
    [hostId, hashToken(token), request.headers['user-agent']?.slice(0, 300) ?? 'Unknown device'],
  );
  const expires = result.rows[0]!.expiresAt;
  reply.setCookie(hostCookie, token, cookieOptions(expires));
}

export async function lockVerifiedHostLogin(
  client: pg.PoolClient,
  hostId: string,
  verifiedPasswordHash: string,
): Promise<VerifiedHostLogin | undefined> {
  const result = await client.query<VerifiedHostLogin>(
    `SELECT id,email,name,password_hash AS "passwordHash",role,language
       FROM hosts
      WHERE id=$1 AND active=true AND password_hash=$2
      FOR UPDATE`,
    [hostId, verifiedPasswordHash],
  );
  return result.rows[0];
}

export function setGuestCookie(reply: FastifyReply, token: string, expires: Date): void {
  reply.setCookie(guestCookie, token, cookieOptions(expires));
}

export function clearHostCookie(reply: FastifyReply): void {
  reply.clearCookie(hostCookie, { path: '/' });
}

export function clearGuestCookie(reply: FastifyReply): void {
  reply.clearCookie(guestCookie, { path: '/' });
}

export function recordHostSessionActivity(
  sessionId: string,
  log: { warn: (bindings: Record<string, unknown>, message: string) => void },
  update: () => Promise<unknown> = () => pool.query('UPDATE host_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now()-interval \'5 minutes\'', [sessionId]),
): void {
  void update().catch((error: unknown) => log.warn({ error, sessionId }, 'Could not update host session activity'));
}

export async function authenticateHost(request: FastifyRequest): Promise<HostIdentity | undefined> {
  const token = request.cookies[hostCookie];
  if (!token) return undefined;
  const result = await pool.query<HostIdentity>(
    `SELECT h.id, h.email, h.name, h.role, h.language, h.version, s.id AS "sessionId"
       FROM host_sessions s JOIN hosts h ON h.id=s.host_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND h.active=true`,
    [hashToken(token)],
  );
  const identity = result.rows[0];
  if (identity) {
    request.hostIdentity = identity;
    recordHostSessionActivity(identity.sessionId, request.log);
  }
  return identity;
}

export async function authenticateGuest(request: FastifyRequest): Promise<GuestIdentity | undefined> {
  const token = request.cookies[guestCookie];
  if (!token) return undefined;
  const result = await pool.query<GuestIdentity>(
    `SELECT g.id,g.name,g.language,g.room_id AS "roomId",r.name AS "roomName",s.id AS "sessionId",s.expires_at AS "expiresAt"
       FROM guest_sessions s JOIN guests g ON g.id=s.guest_id JOIN rooms r ON r.id=g.room_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND g.archived_at IS NULL`,
    [hashToken(token)],
  );
  const identity = result.rows[0];
  if (identity) request.guestIdentity = identity;
  return identity;
}

export async function hostSessionIsActive(sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM host_sessions s JOIN hosts h ON h.id=s.host_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND h.active=true`,
    [sessionId],
  );
  return Boolean(result.rowCount);
}

export async function guestSessionIsActive(sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM guest_sessions s JOIN guests g ON g.id=s.guest_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND g.archived_at IS NULL`,
    [sessionId],
  );
  return Boolean(result.rowCount);
}

export async function requireHost(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await authenticateHost(request))) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Host authentication required.' } });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = await authenticateHost(request);
  if (!identity) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Host authentication required.' } });
  } else if (identity.role !== 'admin') {
    await reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Administrator permission required.' } });
  }
}

export async function requireGuest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await authenticateGuest(request))) {
    await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Guest access required.' } });
  }
}
