import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from '@playwright/test';

import { createBrowserContext } from '../support/browser-context.ts';
import { ResourceRegistry } from '../support/resource-registry.ts';

export const DEFAULT_GUEST_BASE_URL = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;

export interface GuestDeviceDriverOptions {
  readonly baseURL?: string;
  readonly contextOptions?: BrowserContextOptions;
}

export class GuestDeviceDriver {
  readonly #resources: ResourceRegistry;
  readonly #browser: Browser;
  readonly #baseURL: string;
  #context: BrowserContext | undefined;
  #page: Page | undefined;

  constructor(
    resources: ResourceRegistry,
    browser: Browser,
    options: Pick<GuestDeviceDriverOptions, 'baseURL'> = {},
  ) {
    this.#resources = resources;
    this.#browser = browser;
    this.#baseURL = options.baseURL ?? DEFAULT_GUEST_BASE_URL;
  }

  get page(): Page {
    if (!this.#page || this.#page.isClosed()) {
      throw new Error('Guest device page has not been created; call create() or reopen() first');
    }
    return this.#page;
  }

  async create(options: GuestDeviceDriverOptions = {}): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return this.#page;
    if (!this.#context) {
      this.#context = await createBrowserContext(this.#resources, this.#browser, {
        ...options.contextOptions,
        baseURL: options.baseURL ?? this.#baseURL,
      });
    }
    this.#page = await this.#context.newPage();
    return this.#page;
  }

  async closePage(): Promise<void> {
    const page = this.#page;
    this.#page = undefined;
    if (page && !page.isClosed()) await page.close();
  }

  async reopen(path?: string): Promise<Page> {
    await this.closePage();
    const page = await this.create();
    if (path !== undefined) await page.goto(path);
    return page;
  }
}
