// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});

import { BillsPage } from './host-pages';

function renderBillsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><BillsPage/></I18nProvider></QueryClientProvider>);
}

describe('bill archive query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows loading until a successful empty response arrives', async () => {
    let resolveRequest!: (value: unknown) => void;
    apiMock.mockReturnValue(new Promise(resolve => { resolveRequest=resolve; }));

    renderBillsPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();

    resolveRequest({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } });
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
  });

  it('shows a failed initial response without an empty archive', async () => {
    apiMock.mockRejectedValue(new TypeError('Simulated bill archive outage'));

    renderBillsPage();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
  });
});
