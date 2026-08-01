import { describe, expect, it } from 'vitest';
import { localized, sumLineItems } from './money.js';

describe('money and localization', () => {
  it('sums integer-cent line items', () => {
    expect(sumLineItems([{ unitPriceCents: 250, quantity: 2 }, { unitPriceCents: 125, quantity: 1 }])).toBe(625);
  });

  it('falls back to German product text', () => {
    expect(localized({ de: 'Wasser', it: '', en: 'Water' }, 'it')).toBe('Wasser');
  });
});
