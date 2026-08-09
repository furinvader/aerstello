import { z } from 'zod';
import rules from './admin-profile-rules.json' with { type: 'json' };

export const adminProfileSchema = z.object({
  email: z.string().max(rules.emailMaxLength).regex(new RegExp(rules.emailPattern, rules.emailFlags)),
  name: z.string().max(rules.nameMaxLength).regex(new RegExp(rules.namePattern)),
});
