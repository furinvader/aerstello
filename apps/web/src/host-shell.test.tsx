// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { HostShell } from './host-shell';
import { I18nProvider } from './i18n';

const { apiMock, eventSourceUrls } = vi.hoisted(() => ({ apiMock: vi.fn(), eventSourceUrls: [] as string[] }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});
vi.mock('./offline', () => ({
  discardMutationConflict: vi.fn(),
  flushQueue: vi.fn().mockResolvedValue(0),
  mutationConflicts: vi.fn().mockResolvedValue([]),
  pendingMutationCount: vi.fn().mockResolvedValue(0),
  retryMutationConflict: vi.fn(),
}));

const identity = {
  host: { id: 'host-1', email: 'admin@example.test', name: 'Ada', role: 'admin' as const, language: 'en' as const, version: 1, sessionId: 'session-1' },
  venue: { name: 'Hotel Aurora', defaultLanguage: 'de' as const, timezone: 'Europe/Berlin', version: 1 },
};

function renderHostShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['recovery'], { mutationId: 'preserved' });
  const rendered = render(<QueryClientProvider client={client}><I18nProvider><HostShell><h1>Requested bill</h1></HostShell></I18nProvider></QueryClientProvider>);
  return { ...rendered, client };
}

describe('host identity query failures', () => {
  beforeEach(() => {
    apiMock.mockReset();
    eventSourceUrls.length = 0;
    localStorage.setItem('aerstello-language', 'en');
    window.history.replaceState({}, '', '/app/bills/42');
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

  it.each([
    ['a non-401 response', new ApiError('SERVICE_UNAVAILABLE', 'Unavailable', 503)],
    ['a network failure', new TypeError('Network unavailable')],
  ])('keeps the requested route and offers retry after %s', async (_description, failure) => {
    apiMock.mockImplementation((path: string) => {
      if (path === '/auth/me') return Promise.reject(failure);
      return Promise.resolve({ data: [] });
    });

    const { client } = renderHostShell();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(window.location.pathname).toBe('/app/bills/42');
    expect(client.getQueryData(['recovery'])).toEqual({ mutationId: 'preserved' });
  });

  it('refetches identity and renders the requested host content after success', async () => {
    let identityAttempts = 0;
    apiMock.mockImplementation((path: string) => {
      if (path === '/auth/me') {
        identityAttempts += 1;
        return identityAttempts === 1 ? Promise.reject(new TypeError('Network unavailable')) : Promise.resolve(identity);
      }
      return Promise.resolve({ data: [] });
    });

    renderHostShell();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Requested bill' })).toBeVisible();
    expect(window.location.pathname).toBe('/app/bills/42');
    expect(identityAttempts).toBe(2);
    expect(screen.getByText('Hotel Aurora')).toBeVisible();
    expect(eventSourceUrls).toEqual(['/api/v1/events?scope=host']);
  });

  it('redirects an unauthenticated host to login', async () => {
    apiMock.mockRejectedValue(new ApiError('UNAUTHORIZED', 'Unauthorized', 401));

    renderHostShell();

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByText('The request could not be completed.')).not.toBeInTheDocument();
  });
});
