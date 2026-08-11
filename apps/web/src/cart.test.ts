import { describe, expect, it } from 'vitest';
import { MAX_ORDER_BATCH_LINES, MAX_ORDER_LINE_QUANTITY } from '@aerstello/shared';
import { canAddOrderProduct, updateOrderCart } from './cart';

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
