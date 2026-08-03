import { MAX_ORDER_BATCH_LINES, MAX_ORDER_LINE_QUANTITY } from '@sky-bar/shared';

export type OrderCart = Record<string, number>;

type RecoveredOrderDisplayItem = {
  productId: string;
  unitPriceCents?: number;
};

type CurrentOrderCatalog = {
  catalogVersion: number;
  data: ReadonlyArray<{ id: string; priceCents: number }>;
};

export type RecoveredOrderPriceState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; unitPrices: number[] };

function validPrice(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function resolveRecoveredOrderPrices(
  items: ReadonlyArray<RecoveredOrderDisplayItem>,
  body: unknown,
  currentCatalog: CurrentOrderCatalog | null | undefined,
): RecoveredOrderPriceState {
  const capturedPrices = items.map((item) => validPrice(item.unitPriceCents) ? item.unitPriceCents : undefined);
  if (capturedPrices.every((price): price is number => price !== undefined)) {
    return { status: 'ready', unitPrices: capturedPrices };
  }
  if (currentCatalog === undefined) return { status: 'loading' };
  if (currentCatalog === null) return { status: 'unavailable' };

  const commandCatalogVersion = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as { catalogVersion?: unknown }).catalogVersion
    : undefined;
  if (!Number.isSafeInteger(commandCatalogVersion)
    || Number(commandCatalogVersion) <= 0
    || commandCatalogVersion !== currentCatalog.catalogVersion) return { status: 'unavailable' };

  const currentPrices = new Map(currentCatalog.data.map((product) => [product.id, product.priceCents]));
  const resolved = capturedPrices.map((price, index) => price ?? currentPrices.get(items[index]!.productId));
  return resolved.every((price): price is number => validPrice(price))
    ? { status: 'ready', unitPrices: resolved }
    : { status: 'unavailable' };
}

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
