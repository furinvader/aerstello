// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestPage } from './guest-page';
import { I18nProvider } from './i18n';

const { apiMock, eventSourceUrls } = vi.hoisted(() => ({ apiMock: vi.fn(), eventSourceUrls: [] as string[] }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});

describe('guest realtime events', () => {
  beforeEach(() => {
    eventSourceUrls.length = 0;
    localStorage.setItem('skybar-language', 'en');
    apiMock.mockImplementation((path: string) => {
      if (path === '/guest/me') return Promise.resolve({ guest: { id: 'guest-1', name: 'Grace', roomName: '12', sessionId: 'session-1', expiresAt: '2099-01-01T00:00:00.000Z' } });
      if (path === '/guest/tab') return Promise.resolve({ id: 'tab-1', guestId: 'guest-1', status: 'open', items: [], itemCount: 0, totalCents: 0 });
      if (path === '/guest/catalog') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    vi.stubGlobal('EventSource', class {
      constructor(url: string) { eventSourceUrls.push(url); }
      addEventListener() {}
      close() {}
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens a guest-scoped event stream', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage /></I18nProvider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Grace' })).toBeVisible();
    expect(eventSourceUrls).toEqual(['/api/v1/events?scope=guest']);
  });
});
