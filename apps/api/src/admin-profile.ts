import { loginEmailSchema } from '@aerstello/shared';
import { z } from 'zod';
import rules from './admin-profile-rules.json' with { type: 'json' };

export const adminProfileSchema = z.object({
  email: loginEmailSchema,
  name: z.string().max(rules.nameMaxLength).regex(new RegExp(rules.namePattern)),
});
