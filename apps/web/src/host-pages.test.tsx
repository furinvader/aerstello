// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n';

const { apiMock, hostContextMock } = vi.hoisted(() => ({ apiMock: vi.fn(), hostContextMock: vi.fn() }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});
vi.mock('./host-shell', () => ({ useHostContext: hostContextMock }));

import { BillsPage, DashboardPage, OrdersPage } from './host-pages';

function renderBillsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><BillsPage/></I18nProvider></QueryClientProvider>);
}

function renderOrdersPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><OrdersPage/></I18nProvider></QueryClientProvider>);
}

function renderDashboardPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><DashboardPage/></I18nProvider></QueryClientProvider>);
}

describe('bill archive query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ venue: { name: 'Hotel Aurora' } });
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

const emptyDashboardStats={pendingRequests:0,activeRooms:0,activeGuests:0,openItemCount:0,openValueCents:0,todaySalesCents:0};
const openOrderSurfaces=[
  {name:'open orders page',render:renderOrdersPage,orderList:(container:HTMLElement)=>container.querySelector<HTMLElement>('.card')!},
  {name:'dashboard open orders',render:renderDashboardPage,orderList:(container:HTMLElement)=>container.querySelector<HTMLElement>('.section-heading+.card')!},
];

describe.each(openOrderSurfaces)('$name query states',({render:renderOpenOrders,orderList}) => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ venue: { name: 'Hotel Aurora' } });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows loading until a successful empty response arrives', async () => {
    let resolveRequest!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/orders'
      ? new Promise(resolve => { resolveRequest=resolve; })
      : Promise.resolve(emptyDashboardStats));

    const rendered=renderOpenOrders();
    const orders=within(orderList(rendered.container));

    expect(orders.getByText('Loading…')).toBeVisible();
    expect(orders.queryByText('Nothing here yet')).not.toBeInTheDocument();

    resolveRequest({ data: [] });
    expect(await orders.findByText('Nothing here yet')).toBeVisible();
  });

  it('shows a failed initial response without a successful empty state', async () => {
    apiMock.mockImplementation((path:string) => path==='/orders'
      ? Promise.reject(new TypeError('Simulated open orders outage'))
      : Promise.resolve(emptyDashboardStats));

    const rendered=renderOpenOrders();
    const orders=within(orderList(rendered.container));

    expect(await orders.findByText('The request could not be completed.')).toBeVisible();
    expect(orders.queryByText('Nothing here yet')).not.toBeInTheDocument();
  });
});
