// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { LaunchPage, RequestAccessPage } from './auth-pages';
import { I18nProvider } from './i18n';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'Authentication required.', 401);

function renderPage(page: React.ReactNode, path = '/') {
  window.history.replaceState({}, '', path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider>{page}</I18nProvider></QueryClientProvider>);
}

describe('public launch identity resolution', () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.setItem('aerstello-language', 'en');
  });

  afterEach(() => cleanup());

  it.each([
    { successfulPath: '/auth/me', failedPath: '/guest/me', destination: '/app' },
    { successfulPath: '/guest/me', failedPath: '/auth/me', destination: '/guest' },
  ])('uses the successful identity when $failedPath has a transient outage', async ({ successfulPath, failedPath, destination }) => {
    apiMock.mockImplementation((path: string) => path === successfulPath
      ? Promise.resolve({ identity: true })
      : path === failedPath ? Promise.reject(new TypeError('Network unavailable')) : Promise.reject(new Error(`Unexpected path: ${path}`)));

    renderPage(<LaunchPage />);

    await waitFor(() => expect(window.location.pathname).toBe(destination));
  });

  it.each([
    { outagePath: '/auth/me', unauthenticatedPath: '/guest/me' },
    { outagePath: '/guest/me', unauthenticatedPath: '/auth/me' },
  ])('shows retry when $outagePath fails transiently', async ({ outagePath, unauthenticatedPath }) => {
    apiMock.mockImplementation((path: string) => path === outagePath
      ? Promise.reject(new TypeError('Network unavailable'))
      : path === unauthenticatedPath ? Promise.reject(unauthenticated()) : Promise.reject(new Error(`Unexpected path: ${path}`)));

    renderPage(<LaunchPage />);

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(window.location.pathname).toBe('/');
  });

  it('redirects to login only when both identities are unauthenticated', async () => {
    apiMock.mockRejectedValue(unauthenticated());

    renderPage(<LaunchPage />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });

  it('retries identity resolution and redirects after recovery', async () => {
    let hostAttempts = 0;
    apiMock.mockImplementation((path: string) => {
      if (path === '/auth/me') return ++hostAttempts === 1 ? Promise.reject(new TypeError('Network unavailable')) : Promise.resolve({ host: true });
      if (path === '/guest/me') return Promise.reject(unauthenticated());
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    renderPage(<LaunchPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect(hostAttempts).toBe(2);
  });
});

describe('guest request bootstrap states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.clear();
    localStorage.setItem('aerstello-language', 'en');
  });

  afterEach(() => cleanup());

  it('shows loading without exposing the access form', () => {
    apiMock.mockReturnValue(new Promise(() => undefined));

    renderPage(<RequestAccessPage />, '/guest/request');

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('shows a localized failure and retries bootstrap before rendering the form', async () => {
    let attempts = 0;
    apiMock.mockImplementation((path: string) => {
      if (path !== '/public/bootstrap') return Promise.reject(new Error(`Unexpected path: ${path}`));
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new TypeError('Network unavailable'))
        : Promise.resolve({ venue: { name: 'Hotel Aurora', defaultLanguage: 'en' }, rooms: [{ id: 'room-1', name: '101' }] });
    });

    renderPage(<RequestAccessPage />, '/guest/request');

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Request access' })).toBeVisible();
    expect(screen.getByRole('option', { name: '101' })).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('renders the access form only after bootstrap succeeds', async () => {
    apiMock.mockResolvedValue({ venue: { name: 'Hotel Aurora', defaultLanguage: 'en' }, rooms: [{ id: 'room-1', name: '101' }] });

    renderPage(<RequestAccessPage />, '/guest/request');

    expect(await screen.findByRole('heading', { name: 'Guest access' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeVisible();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});
