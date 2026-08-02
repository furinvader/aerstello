import type { Language } from '@sky-bar/shared';

export function formatVenueDateTime(value: string, language: Language, venueTimezone: string): string {
  return new Date(value).toLocaleString(language, { timeZone: venueTimezone });
}
