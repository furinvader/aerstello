import { describe, expect, it } from 'vitest';
import { MAX_ORDER_BATCH_LINES, MAX_ORDER_LINE_QUANTITY } from '@sky-bar/shared';
import { canAddOrderProduct, resolveRecoveredOrderPrices, updateOrderCart } from './cart';

describe('order cart limits', () => {
  it('caps a product at the API line quantity limit', () => {
    const cart = updateOrderCart({ beer: MAX_ORDER_LINE_QUANTITY }, 'beer', 1);
    expect(cart).toEqual({ beer: MAX_ORDER_LINE_QUANTITY });
    expect(canAddOrderProduct(cart, 'beer')).toBe(false);
  });

  it('does not add a distinct product beyond the API batch line limit', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_ORDER_BATCH_LINES }, (_, index) => [`product-${index}`, 1]));
    expect(updateOrderCart(full, 'one-too-many', 1)).toBe(full);
    expect(canAddOrderProduct(full, 'one-too-many')).toBe(false);
    expect(canAddOrderProduct(full, 'product-0')).toBe(true);
  });
});

describe('recovered order prices', () => {
  const catalog = {
    catalogVersion: 7,
    data: [{ id: 'beer', priceCents: 420 }, { id: 'water', priceCents: 0 }],
  };

  it('keeps explicitly captured integer-cent prices without consulting a changed catalog', () => {
    expect(resolveRecoveredOrderPrices(
      [{ productId: 'beer', unitPriceCents: 420 }, { productId: 'water', unitPriceCents: 0 }],
      { catalogVersion: 6 },
      catalog,
    )).toEqual({ status: 'ready', unitPrices: [420, 0] });
  });

  it('recovers a legacy display price only from the command catalog version', () => {
    expect(resolveRecoveredOrderPrices(
      [{ productId: 'beer' }],
      { catalogVersion: 7 },
      catalog,
    )).toEqual({ status: 'ready', unitPrices: [420] });
  });

  it('blocks a legacy retry instead of substituting a changed price or zero', () => {
    expect(resolveRecoveredOrderPrices(
      [{ productId: 'beer' }],
      { catalogVersion: 6 },
      catalog,
    )).toEqual({ status: 'unavailable' });
    expect(resolveRecoveredOrderPrices(
      [{ productId: 'archived-product' }],
      { catalogVersion: 7 },
      catalog,
    )).toEqual({ status: 'unavailable' });
  });

  it('waits for the catalog before deciding whether an old display is safe', () => {
    expect(resolveRecoveredOrderPrices(
      [{ productId: 'beer' }],
      { catalogVersion: 7 },
      undefined,
    )).toEqual({ status: 'loading' });
  });
});
