import { describe, expect, it } from 'vitest';
import { isValidTimeZone, venueSettingsSchema } from './contracts.js';

describe('venue contracts', () => {
  it('accepts recognized IANA time zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects unknown time zones', () => {
    expect(venueSettingsSchema.safeParse({ name: 'Hotel Aurora', language: 'de', timezone: 'Europe/Definitely-Not-A-Zone' }).success).toBe(false);
  });
});
