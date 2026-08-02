import { createHash } from 'node:crypto';

interface RateLimitRequest {
  ip: string;
  method: string;
  url: string;
  body?: unknown;
}

const accessStatusPath = /^\/api\/v1\/public\/access-requests\/[0-9a-f-]+\/status(?:\?|$)/i;

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
    return `access-status:${request.ip}:${capability}`;
  }
  return ipRateLimitKey(request);
}
