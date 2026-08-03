export function formatMoney(cents: number, language: string = 'de'): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100);
}

export function parseEuroCents(value: string): number | undefined {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const euros = Number.parseInt(match[1]!, 10);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = euros * 100 + (fraction ? Number.parseInt(fraction, 10) : 0);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export function sumLineItems(items: ReadonlyArray<{ unitPriceCents: number; quantity: number }>): number {
  return items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);
}

export function localized(text: { de: string; it?: string; en?: string }, language: string): string {
  const candidate = language === 'it' ? text.it : language === 'en' ? text.en : text.de;
  return candidate?.trim() || text.de;
}
