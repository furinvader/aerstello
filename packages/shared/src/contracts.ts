import { z } from 'zod';

export const languageSchema = z.enum(['de', 'it', 'en']);
export type Language = z.infer<typeof languageSchema>;

export const hostRoleSchema = z.enum(['admin', 'staff']);
export type HostRole = z.infer<typeof hostRoleSchema>;

export const localizedTextSchema = z.object({
  de: z.string().trim().min(1).max(120),
  it: z.string().trim().max(120).default(''),
  en: z.string().trim().max(120).default(''),
});
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export const venueSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  language: languageSchema.default('de'),
  timezone: z.string().trim().min(1).default('Europe/Berlin'),
});

export const roomInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const guestInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  roomId: z.string().uuid(),
  language: languageSchema.default('de'),
});

export const categoryInputSchema = z.object({
  name: localizedTextSchema,
});

export const productInputSchema = z.object({
  name: localizedTextSchema,
  description: localizedTextSchema.optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  categoryId: z.string().uuid(),
  enabled: z.boolean().default(true),
  selfServiceOnly: z.boolean().default(false),
});

export const orderBatchSchema = z.object({
  mutationId: z.string().uuid(),
  originHostId: z.string().uuid(),
  guestId: z.string().uuid(),
  catalogVersion: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99),
  })).min(1).max(100),
});

export const settleTabSchema = z.object({
  mutationId: z.string().uuid(),
  paymentMethod: z.enum(['cash', 'card', 'other']),
  note: z.string().trim().max(240).optional(),
});

export const voidSchema = z.object({
  mutationId: z.string().uuid(),
  reason: z.string().trim().min(2).max(240),
});

export const accessRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  roomId: z.string().uuid(),
  language: languageSchema.default('de'),
});

export const accessApprovalSchema = z.object({
  guestId: z.string().uuid().optional(),
  expiresAt: z.string().datetime(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(256),
});

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface ApiErrorBody {
  error: { code: string; message: string };
}
