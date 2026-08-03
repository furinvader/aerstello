import { z } from 'zod';

const developmentSessionSecret = 'development-only-session-secret-change-me';
const publishedSessionSecretPlaceholder = 'replace-with-at-least-32-random-characters';
const publishedAccessCapabilityPlaceholder = `v1:${publishedSessionSecretPlaceholder}`;
const developmentDatabaseUrl = 'postgres://skybar:skybar@localhost:5432/skybar';
const insecureProductionSessionSecrets = new Set([developmentSessionSecret, publishedSessionSecretPlaceholder]);

function containsPublishedCapabilitySecret(value: string | undefined): boolean {
  return Boolean(value?.split(',').some((entry) => insecureProductionSessionSecrets.has(entry.slice(entry.indexOf(':') + 1))));
}

export interface AccessCapabilityKey {
  id: string;
  secret: string;
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default(developmentDatabaseUrl),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32).default(developmentSessionSecret),
  ACCESS_CAPABILITY_KEYS: z.string().max(4096).optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  ACCESS_STATUS_IP_LIMIT_MAX: z.coerce.number().int().positive().default(3000),
  LEGACY_BILL_TIMEZONE: z.preprocess((value) => value === '' ? undefined : value, z.string().trim().min(1).optional()),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && insecureProductionSessionSecrets.has(value.SESSION_SECRET)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['SESSION_SECRET'], message: 'SESSION_SECRET must be explicitly configured in production.' });
  }
  if (value.NODE_ENV === 'production' && (
    !value.ACCESS_CAPABILITY_KEYS
    || value.ACCESS_CAPABILITY_KEYS === publishedAccessCapabilityPlaceholder
    || containsPublishedCapabilitySecret(value.ACCESS_CAPABILITY_KEYS)
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ACCESS_CAPABILITY_KEYS'],
      message: 'ACCESS_CAPABILITY_KEYS must be explicitly configured in production.',
    });
  }
  if (value.NODE_ENV === 'production' && value.DATABASE_URL === developmentDatabaseUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'DATABASE_URL must be explicitly configured in production.' });
  }
});

function parseAccessCapabilityKeys(value: string): AccessCapabilityKey[] {
  const entries = value.split(',');
  if (entries.length === 0 || entries.length > 8) throw new Error('ACCESS_CAPABILITY_KEYS must contain between one and eight keys.');
  const keys = entries.map((entry, index) => {
    const separator = entry.indexOf(':');
    const id = separator < 0 ? '' : entry.slice(0, separator);
    const secret = separator < 0 ? '' : entry.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new Error(`ACCESS_CAPABILITY_KEYS entry ${index + 1} has an invalid key identifier.`);
    }
    if (secret.length < 32 || /[\s,]/.test(secret)) {
      throw new Error(`ACCESS_CAPABILITY_KEYS entry ${index + 1} must contain a non-whitespace secret of at least 32 characters.`);
    }
    return { id, secret };
  });
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error('ACCESS_CAPABILITY_KEYS key identifiers must be unique.');
  if (new Set(keys.map((key) => key.secret)).size !== keys.length) throw new Error('ACCESS_CAPABILITY_KEYS secrets must be unique.');
  return keys;
}

export const parseConfig = (environment: NodeJS.ProcessEnv) => {
  const parsed = configSchema.parse(environment);
  const { ACCESS_CAPABILITY_KEYS: configuredKeys, ...values } = parsed;
  return {
    ...values,
    ACCESS_CAPABILITY_KEYS: parseAccessCapabilityKeys(configuredKeys ?? `development-v1:${parsed.SESSION_SECRET}`),
  };
};
export const config = parseConfig(process.env);
