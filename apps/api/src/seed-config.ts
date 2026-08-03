import { z } from 'zod';

const seedEnvironmentSchema = z.object({
  NODE_ENV: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
});

export function seedPassword(environment: NodeJS.ProcessEnv): string {
  if (environment.NODE_ENV === 'production') throw new Error('The development seed is disabled in production.');
  return seedEnvironmentSchema.parse(environment).SEED_ADMIN_PASSWORD;
}
