import type { Language } from '@sky-bar/shared';

export function formatVenueDateTime(value: string, language: Language, venueTimezone: string): string {
  return new Date(value).toLocaleString(language, { timeZone: venueTimezone });
}

export function toLocalDateTimeInputValue(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
