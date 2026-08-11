import { MAX_ORDER_BATCH_LINES, MAX_ORDER_LINE_QUANTITY } from '@aerstello/shared';

export type OrderCart = Record<string, number>;

export function updateOrderCart(current: OrderCart, productId: string, change: number): OrderCart {
  const currentQuantity = current[productId] ?? 0;
  if (change > 0 && currentQuantity === 0 && Object.keys(current).length >= MAX_ORDER_BATCH_LINES) return current;
  const quantity = Math.min(MAX_ORDER_LINE_QUANTITY, Math.max(0, currentQuantity + change));
  if (quantity === currentQuantity) return current;
  const next = { ...current, [productId]: quantity };
  if (quantity === 0) delete next[productId];
  return next;
}

export function canAddOrderProduct(cart: OrderCart, productId: string): boolean {
  const quantity = cart[productId] ?? 0;
  return quantity < MAX_ORDER_LINE_QUANTITY
    && (quantity > 0 || Object.keys(cart).length < MAX_ORDER_BATCH_LINES);
}
