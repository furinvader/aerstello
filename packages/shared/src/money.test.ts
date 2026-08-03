import { describe, expect, it } from 'vitest';
import { localized, parseEuroCents, sumLineItems } from './money.js';

describe('money and localization', () => {
  it('sums integer-cent line items', () => {
    expect(sumLineItems([{ unitPriceCents: 250, quantity: 2 }, { unitPriceCents: 125, quantity: 1 }])).toBe(625);
  });

  it('falls back to German product text', () => {
    expect(localized({ de: 'Wasser', it: '', en: 'Water' }, 'it')).toBe('Wasser');
  });

  it('parses decimal prices without floating-point rounding', () => {
    expect(parseEuroCents('3.10')).toBe(310);
    expect(parseEuroCents('3,1')).toBe(310);
    expect(parseEuroCents('1.005')).toBeUndefined();
    expect(parseEuroCents('-1.00')).toBeUndefined();
  });
});
