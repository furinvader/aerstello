import type { Page } from '@playwright/test';

export const csrfHeaders = Object.freeze({ 'x-aerstello-csrf': '1' } as const);

export async function operationalData(page: Page) {
  const request = page.context().request;
  const me = await (await request.get('/api/v1/auth/me')).json() as { host: { id: string; version: number } };
  const guests = await (await request.get('/api/v1/guests')).json() as { data: { id: string; name: string }[] };
  const products = await (await request.get('/api/v1/products')).json() as {
    catalogVersion: number;
    data: { id: string; name: { de: string }; description?: { de: string; it?: string; en?: string }; priceCents: number; categoryId: string; enabled: boolean; selfServiceOnly: boolean; version: number }[];
  };
  return { request, me, guests, products };
}
