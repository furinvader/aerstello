import type { JSHandle, Page } from '@playwright/test';

import { ResourceRegistry, type ResourceRegistration } from './resource-registry.ts';

export interface OwnedBrowserStream {
  readonly handle: JSHandle<EventSource>;
  dispose(): Promise<void>;
}

export function registerBrowserStream(
  resources: ResourceRegistry,
  label: string,
  close: () => void | Promise<void>,
): ResourceRegistration<void> {
  return resources.defer(label, close);
}

export async function createBrowserStream(
  resources: ResourceRegistry,
  page: Page,
  url: string,
  label = `browser stream ${url}`,
): Promise<OwnedBrowserStream> {
  const handle = await page.evaluateHandle((streamUrl) => new EventSource(streamUrl), url);
  let registration: ResourceRegistration<void>;
  try {
    registration = registerBrowserStream(resources, label, async () => {
      try {
        await handle.evaluate((stream) => stream.close());
      } finally {
        await handle.dispose();
      }
    });
  } catch (error) {
    try {
      await handle.evaluate((stream) => stream.close());
    } finally {
      await handle.dispose();
    }
    throw error;
  }
  return { handle, dispose: () => registration.dispose() };
}
