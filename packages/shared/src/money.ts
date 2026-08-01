export function formatMoney(cents: number, language: string = 'de'): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100);
}

export function sumLineItems(items: ReadonlyArray<{ unitPriceCents: number; quantity: number }>): number {
  return items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);
}

export function localized(text: { de: string; it?: string; en?: string }, language: string): string {
  const candidate = language === 'it' ? text.it : language === 'en' ? text.en : text.de;
  return candidate?.trim() || text.de;
}
