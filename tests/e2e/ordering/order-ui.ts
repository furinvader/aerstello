import type { Page } from '@playwright/test';

export async function chooseOrder(page: Page, product: string, guest: string, room: string): Promise<void> {
  await page.goto('/app/orders/new');
  await page.locator('.room-chips').getByRole('button', { name: room, exact: true }).click();
  await page.locator('.guest-list').getByRole('button', { name: new RegExp(guest) }).click();
  await page.locator('.product-tile').getByText(product, { exact: true }).click();
}

export const emptyDashboardStats = Object.freeze({ pendingRequests: 0, activeRooms: 0, activeGuests: 0, openItemCount: 0, openValueCents: 0, todaySalesCents: 0 });
export const dashboardMetric = (page: Page, label: RegExp) => page.locator('.metric-grid .metric').filter({ hasText: label });
export const openOrdersMetric = (page: Page) => dashboardMetric(page, /Offene Bestellungen|Ordini aperti|Open orders/);
export const todayMetric = (page: Page) => dashboardMetric(page, /Heute|Oggi|Today/);
export const requestFailedMessage = /Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/;
export const openOrdersPageCard = (page: Page) => page.locator('.app-content>.card');
export const dashboardOrderList = (page: Page) => page.locator('.section-heading+.card');
