import type { Locator,Page } from '@playwright/test';

export async function installQueryOutage(page: Page, paths: string[]): Promise<void> {
  await page.addInitScript((targetPaths) => {
    const originalFetch = window.fetch.bind(window);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const state = { active: true, attempts: 0, observed: {} as Record<string, number>, release, restore: () => { window.fetch = originalFetch; } };
    Object.assign(window, { __aerstelloQueryOutage: state });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const requestPath = new URL(url, window.location.href).pathname;
      state.observed[requestPath] = (state.observed[requestPath] ?? 0) + 1;
      if (targetPaths.includes(requestPath)) {
        state.attempts += 1;
        if (state.active) {
          await pending;
          return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Simulated query outage' } }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
      }
      return originalFetch(input, init);
    };
  }, paths);
}

export async function releaseQueryOutage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __aerstelloQueryOutage: { release: () => void } }).__aerstelloQueryOutage.release();
  });
}

export async function retryQueryOutage(page: Page, retry: Locator): Promise<void> {
  await retry.evaluate((button) => button.addEventListener('click', () => {
    (window as unknown as { __aerstelloQueryOutage: { active: boolean } }).__aerstelloQueryOutage.active = false;
  }, { capture: true, once: true }));
  await retry.click();
}

export async function restoreQueryOutage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __aerstelloQueryOutage: { restore: () => void } }).__aerstelloQueryOutage;
    state.restore();
    delete (window as unknown as { __aerstelloQueryOutage?: unknown }).__aerstelloQueryOutage;
  });
}

export async function installLiveQueryFailure(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((targetPaths) => {
    const originalFetch = window.fetch.bind(window);
    const state = { attempts: 0, restore: () => { window.fetch = originalFetch; } };
    Object.assign(window, { __aerstelloLiveQueryFailure: state });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      if (targetPaths.includes(new URL(url, window.location.href).pathname)) {
        state.attempts += 1;
        return new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Simulated background query outage' } }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
  }, paths);
}

export async function restoreLiveQueryFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __aerstelloLiveQueryFailure: { restore: () => void } }).__aerstelloLiveQueryFailure;
    state.restore();
    delete (window as unknown as { __aerstelloLiveQueryFailure?: unknown }).__aerstelloLiveQueryFailure;
  });
}
