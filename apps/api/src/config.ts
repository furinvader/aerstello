import { z } from 'zod';

const developmentSessionSecret = 'development-only-session-secret-change-me';
const publishedSessionSecretPlaceholder = 'replace-with-at-least-32-random-characters';
const developmentDatabaseUrl = 'postgres://skybar:skybar@localhost:5432/skybar';
const insecureProductionSessionSecrets = new Set([developmentSessionSecret, publishedSessionSecretPlaceholder]);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default(developmentDatabaseUrl),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32).default(developmentSessionSecret),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  ACCESS_STATUS_IP_LIMIT_MAX: z.coerce.number().int().positive().default(3000),
  LEGACY_BILL_TIMEZONE: z.string().trim().min(1).optional(),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && insecureProductionSessionSecrets.has(value.SESSION_SECRET)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['SESSION_SECRET'], message: 'SESSION_SECRET must be explicitly configured in production.' });
  }
  if (value.NODE_ENV === 'production' && value.DATABASE_URL === developmentDatabaseUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'DATABASE_URL must be explicitly configured in production.' });
  }
});

export const parseConfig = (environment: NodeJS.ProcessEnv) => configSchema.parse(environment);
export const config = parseConfig(process.env);
