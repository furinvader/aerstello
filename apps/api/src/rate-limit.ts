import { createHash } from 'node:crypto';
import type { FastifyRateLimitOptions, FastifyRateLimitStore } from '@fastify/rate-limit';
import type { FastifyInstance, RouteOptions, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';
import { pool } from './db.js';

interface RateLimitRequest {
  ip: string;
  method: string;
  url: string;
  body?: unknown;
}

const accessStatusPath = /^\/api\/v1\/public\/access-requests\/[0-9a-f-]+\/status(?:\?|$)/i;

export const accessStatusIpRateLimitGroup = 'access-status-ip';

export function isAccessStatusRequest(request: Pick<RateLimitRequest, 'method'|'url'>): boolean {
  return request.method === 'POST' && accessStatusPath.test(request.url);
}

export function ipRateLimitKey(request: Pick<RateLimitRequest, 'ip'>): string {
  return `ip:${request.ip}`;
}

export function ipRateLimitMax(request: Pick<RateLimitRequest, 'method'|'url'>, standardMax: number, accessStatusMax: number): number {
  return isAccessStatusRequest(request) ? accessStatusMax : standardMax;
}

export function rateLimitKey(request: RateLimitRequest): string {
  if (isAccessStatusRequest(request)) {
    const token = typeof request.body === 'object' && request.body !== null && 'token' in request.body
      ? (request.body as { token?: unknown }).token
      : undefined;
    const capability = typeof token === 'string' && token.length > 0
      ? createHash('sha256').update(token).digest('base64url')
      : 'missing';
    return `access-status:${capability}`;
  }
  return ipRateLimitKey(request);
}

type RateLimitCheck = ReturnType<FastifyInstance['createRateLimit']>;
type RateLimitResult = Awaited<ReturnType<RateLimitCheck>>;
type AppliedRateLimit = Extract<RateLimitResult, { isAllowed: false }>;
type GroupedRateLimitOptions = NonNullable<Parameters<FastifyInstance['createRateLimit']>[0]> & { groupId: string };

export function createGroupedRateLimit(app: FastifyInstance, options: GroupedRateLimitOptions): RateLimitCheck {
  return app.createRateLimit(options);
}

function exceededRateLimit(result: RateLimitResult): result is AppliedRateLimit {
  return !result.isAllowed && result.isExceeded;
}

export function createRateLimitPreHandler(...checks: RateLimitCheck[]): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const limits = [];
    for (const check of checks) limits.push(await check(request));
    const limit = limits.find(exceededRateLimit);
    if (!limit) return;

    reply.header('x-ratelimit-limit', limit.max);
    reply.header('x-ratelimit-remaining', 0);
    reply.header('x-ratelimit-reset', limit.ttlInSeconds);
    reply.header('retry-after', limit.ttlInSeconds);
    const error = new Error(`Rate limit exceeded, retry in ${limit.ttlInSeconds} seconds.`) as Error & { statusCode: number };
    error.statusCode = 429;
    throw error;
  };
}

type RateLimitDatabase = Pick<pg.Pool, 'query'>;
type StoreOptions = FastifyRateLimitOptions & {
  groupId?: string;
  timeWindow?: number;
  routeInfo?: { method?: string | string[]; url?: string };
};

export async function incrementRateLimitCounter(
  scope: string,
  key: string,
  timeWindowMs: number,
  client: RateLimitDatabase = pool,
): Promise<{ current: number; ttl: number }> {
  const keyHash = createHash('sha256').update(key).digest('base64url');
  const result = await client.query<{ current: number; ttl: number }>(
    `INSERT INTO rate_limit_counters(scope,key_hash,count,expires_at)
     VALUES ($1,$2,1,clock_timestamp()+($3::double precision*interval '1 millisecond'))
     ON CONFLICT (scope,key_hash) DO UPDATE SET
       count=CASE WHEN rate_limit_counters.expires_at<=clock_timestamp() THEN 1 ELSE rate_limit_counters.count+1 END,
       expires_at=CASE WHEN rate_limit_counters.expires_at<=clock_timestamp()
                       THEN clock_timestamp()+($3::double precision*interval '1 millisecond')
                       ELSE rate_limit_counters.expires_at END
     RETURNING count AS current,
       greatest(0,ceil(extract(epoch FROM (expires_at-clock_timestamp()))*1000))::int AS ttl`,
    [scope, keyHash, timeWindowMs],
  );
  const counter = result.rows[0];
  if (!counter) throw new Error('Could not persist rate-limit counter');
  return counter;
}

function rateLimitScope(options: StoreOptions): string {
  if (options.groupId) return `group:${options.groupId}`;
  const method = Array.isArray(options.routeInfo?.method) ? options.routeInfo.method.join(',') : options.routeInfo?.method;
  return method && options.routeInfo?.url ? `route:${method}:${options.routeInfo.url}` : 'global';
}

export class PostgresRateLimitStore implements FastifyRateLimitStore {
  private readonly options: StoreOptions;
  private readonly scope: string;

  constructor(options: FastifyRateLimitOptions) {
    this.options = options as StoreOptions;
    this.scope = rateLimitScope(this.options);
  }

  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void): void {
    void incrementRateLimitCounter(this.scope, key, this.options.timeWindow ?? 60_000)
      .then((result) => callback(null, result))
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error('Rate-limit store failed')));
  }

  child(routeOptions: RouteOptions & { path: string; prefix: string }): FastifyRateLimitStore {
    return new PostgresRateLimitStore({ ...this.options, ...routeOptions } as FastifyRateLimitOptions);
  }
}

export async function pruneExpiredRateLimitCounters(client: RateLimitDatabase = pool): Promise<void> {
  await client.query("DELETE FROM rate_limit_counters WHERE expires_at<clock_timestamp()-interval '1 hour'");
}
