import type { Page } from '@playwright/test';

import { ResourceRegistry, type ResourceRegistration } from './resource-registry.ts';

export async function registerRoute(
  resources: ResourceRegistry,
  page: Page,
  url: Parameters<Page['route']>[0],
  handler: Parameters<Page['route']>[1],
): Promise<ResourceRegistration<void>> {
  await page.route(url, handler);
  try {
    return resources.defer(`Playwright route ${String(url)}`, () => page.unroute(url, handler));
  } catch (error) {
    await page.unroute(url, handler);
    throw error;
  }
}
