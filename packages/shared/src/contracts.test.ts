import { describe, expect, it } from 'vitest';
import { isValidTimeZone, settleTabSchema, venueSettingsSchema } from './contracts.js';

describe('venue contracts', () => {
  it('accepts recognized IANA time zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects unknown time zones', () => {
    expect(venueSettingsSchema.safeParse({ name: 'Hotel Aurora', language: 'de', timezone: 'Europe/Definitely-Not-A-Zone' }).success).toBe(false);
  });

  it('accepts aggregate settlement counts across multiple batches', () => {
    expect(settleTabSchema.safeParse({
      mutationId:'00000000-0000-4000-8000-000000000001',
      expectedItemCount:9_999,
      expectedTotalCents:0,
      paymentMethod:'cash',
    }).success).toBe(true);
  });
});
