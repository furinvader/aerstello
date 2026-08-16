import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';

import { ResourceRegistry } from './resource-registry.ts';

export async function createBrowserContext(
  resources: ResourceRegistry,
  browser: Browser,
  options?: BrowserContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  try {
    resources.own('browser context', context, (ownedContext) => ownedContext.close());
  } catch (error) {
    await context.close();
    throw error;
  }
  return context;
}
