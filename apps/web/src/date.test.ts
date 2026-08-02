import { describe, expect, it } from 'vitest';
import { formatVenueDateTime } from './date';

describe('venue date formatting', () => {
  it('uses the snapshotted venue timezone across a UTC date boundary', () => {
    const formatted = formatVenueDateTime('2026-01-01T00:30:00.000Z', 'de', 'America/New_York');
    expect(formatted).toContain('31.12.2025');
  });
});
