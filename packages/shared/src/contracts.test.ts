import { describe, expect, it } from 'vitest';
import { isValidTimeZone, productCreateSchema, productUpdateSchema, settleTabSchema, venueSettingsSchema } from './contracts.js';

describe('venue contracts', () => {
  it('accepts recognized IANA time zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects unknown time zones', () => {
    expect(venueSettingsSchema.safeParse({ name: 'Hotel Aurora', language: 'de', timezone: 'Europe/Definitely-Not-A-Zone', expectedVersion: 1 }).success).toBe(false);
  });

  it('requires an expected version when updating venue settings', () => {
    const venue = { name: 'Hotel Aurora', language: 'de', timezone: 'Europe/Berlin' };
    expect(venueSettingsSchema.safeParse(venue).success).toBe(false);
    expect(venueSettingsSchema.safeParse({ ...venue, expectedVersion: 1 }).success).toBe(true);
  });

  it('accepts aggregate settlement counts across multiple batches', () => {
    expect(settleTabSchema.safeParse({
      mutationId:'00000000-0000-4000-8000-000000000001',
      expectedItemCount:9_999,
      expectedTotalCents:0,
      paymentMethod:'cash',
    }).success).toBe(true);
  });

  it('requires an idempotency key when creating a product', () => {
    const product = { name: { de: 'Saft', it: '', en: '' }, priceCents: 300, categoryId: '00000000-0000-4000-8000-000000000002' };
    expect(productCreateSchema.safeParse(product).success).toBe(false);
    expect(productCreateSchema.safeParse({ ...product, mutationId: '00000000-0000-4000-8000-000000000003' }).success).toBe(true);
  });

  it('requires an expected version when updating a product', () => {
    const product = { name: { de: 'Saft', it: '', en: '' }, priceCents: 300, categoryId: '00000000-0000-4000-8000-000000000002' };
    expect(productUpdateSchema.safeParse(product).success).toBe(false);
    expect(productUpdateSchema.safeParse({ ...product, expectedVersion: 1 }).success).toBe(true);
  });
});
