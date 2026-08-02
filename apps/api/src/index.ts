import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { startRealtimeRelay } from './events.js';
import { ipRateLimitKey, ipRateLimitMax } from './rate-limit.js';
import { registerRoutes } from './routes.js';

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  trustProxy: config.TRUST_PROXY === 'true',
});

await app.register(cookie);
await app.register(cors, {
  origin: config.NODE_ENV === 'production' ? false : config.WEB_ORIGIN,
  credentials: true,
});
await app.register(rateLimit, {
  global: true,
  max: (request) => ipRateLimitMax(request, config.RATE_LIMIT_MAX, config.ACCESS_STATUS_IP_LIMIT_MAX),
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: ipRateLimitKey,
});

await registerRoutes(app);

if (config.NODE_ENV === 'production') {
  const candidates = [resolve('apps/web/dist'), resolve('../web/dist')];
  let webRoot: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      webRoot = candidate;
      break;
    } catch {
      // Continue to the workspace-local candidate.
    }
  }
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
      return reply.sendFile('index.html');
    });
  }
}

let stopRealtimeRelay: (()=>void)|undefined;

async function shutdown(signal: string) {
  app.log.info({ signal }, 'Shutting down');
  stopRealtimeRelay?.();
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await migrate();
stopRealtimeRelay=await startRealtimeRelay(app.log);
await app.listen({ port: config.PORT, host: '0.0.0.0' });
