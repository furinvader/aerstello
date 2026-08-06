import { describe, expect, it } from 'vitest';
import { formatVenueDateTime, toLocalDateTimeInputValue } from './date';

describe('venue date formatting', () => {
  it('uses the snapshotted venue timezone across a UTC date boundary', () => {
    const formatted = formatVenueDateTime('2026-01-01T00:30:00.000Z', 'de', 'America/New_York');
    expect(formatted).toContain('31.12.2025');
  });

  it('creates datetime-local values from local rather than UTC components', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(toLocalDateTimeInputValue(new Date('2026-01-01T00:30:00.000Z'))).toBe('2026-01-01T14:30');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
