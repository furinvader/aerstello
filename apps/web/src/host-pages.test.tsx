// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n';

const { apiMock, hostContextMock } = vi.hoisted(() => ({ apiMock: vi.fn(), hostContextMock: vi.fn() }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});
vi.mock('./host-shell', () => ({ useHostContext: hostContextMock }));

import { AccountPage, BillDetailPage, BillsPage, DashboardPage, GuestsPage, OrdersPage, ProductsPage, RequestsPage, RoomsPage, SettingsPage, TakeOrdersPage } from './host-pages';

function renderBillsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><BillsPage/></I18nProvider></QueryClientProvider>);
}

function renderBillDetailPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><BillDetailPage/></I18nProvider></QueryClientProvider>);
}

function renderOrdersPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><OrdersPage/></I18nProvider></QueryClientProvider>);
}

function renderDashboardPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><DashboardPage/></I18nProvider></QueryClientProvider>);
}

function renderRequestsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><RequestsPage/></I18nProvider></QueryClientProvider>);
}

function renderGuestsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><GuestsPage/></I18nProvider></QueryClientProvider>);
}

function renderSettingsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><SettingsPage/></I18nProvider></QueryClientProvider>);
}

function renderProductsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><ProductsPage/></I18nProvider></QueryClientProvider>);
}

function renderRoomsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><RoomsPage/></I18nProvider></QueryClientProvider>);
}

function renderAccountPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><I18nProvider><AccountPage/></I18nProvider></QueryClientProvider>);
}

function renderTakeOrdersPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}><I18nProvider><TakeOrdersPage/></I18nProvider></QueryClientProvider>);
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

describe('bill detail query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: { role: 'admin' } });
    localStorage.setItem('skybar-language', 'en');
    window.history.replaceState({}, '', '/app/bills/bill-1');
  });
  afterEach(cleanup);

  it('retries a failed request and renders the recovered bill snapshot', async () => {
    const bill={id:'bill-1',number:'2026-0001',venueName:'Hotel Aurora',venueTimezone:'Europe/Berlin',guestName:'Anna Berger',roomName:'101',hostName:'Alex Host',totalCents:420,paymentMethod:'cash',settledAt:'2026-08-04T10:00:00.000Z',items:[{productName:{de:'Helles',it:'Bionda',en:'Lager'},unitPriceCents:420,quantity:1,source:'host'}]};
    apiMock.mockRejectedValueOnce(new TypeError('Simulated bill detail outage')).mockResolvedValueOnce(bill);

    renderBillDetailPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByText('Hotel Aurora')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect((await screen.findAllByText('Hotel Aurora')).length).toBeGreaterThan(0);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock.mock.calls).toEqual([['/bills/bill-1'],['/bills/bill-1']]);
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

describe('access request query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: { id: 'host-1', role: 'admin' } });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows loading until a successful empty response arrives', async () => {
    let resolveRequests!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/access-requests'
      ? new Promise(resolve => { resolveRequests=resolve; })
      : Promise.resolve({ data: [] }));

    renderRequestsPage();

    expect(screen.getAllByText('Loading…')).toHaveLength(2);
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();

    resolveRequests({ data: [] });
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
  });

  it('retries a failed response and renders recovered request cards', async () => {
    const request={id:'request-1',name:'Luca Rossi',roomId:'room-102',roomName:'102',language:'it',status:'pending',requestedAt:'2026-08-05T10:00:00.000Z'};
    apiMock.mockImplementation((path:string) => path==='/access-requests'
      ? apiMock.mock.calls.filter(([calledPath])=>calledPath==='/access-requests').length===1
        ? Promise.reject(new TypeError('Simulated access request outage'))
        : Promise.resolve({ data: [request] })
      : Promise.resolve({ data: [] }));

    renderRequestsPage();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect(await screen.findByText('Luca Rossi')).toBeVisible();
    expect(screen.getByText(/102/)).toBeVisible();
    expect(apiMock.mock.calls.filter(([path])=>path==='/access-requests')).toHaveLength(2);
  });

  it('blocks approval until the failed guest directory recovers', async () => {
    const request={id:'request-1',name:'Luca Rossi',roomId:'room-102',roomName:'102',language:'it',status:'pending',requestedAt:'2026-08-05T10:00:00.000Z'};
    const guest={id:'guest-1',name:'Existing Luca',roomId:'room-102',roomName:'102',language:'it',itemCount:0,totalCents:0,version:1};
    let rejectGuests!: (reason: unknown) => void;
    apiMock.mockImplementation((path:string) => {
      if(path==='/access-requests')return Promise.resolve({ data: [request] });
      if(path==='/guests')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/guests').length===1
        ? new Promise((_,reject) => { rejectGuests=reject; })
        : Promise.resolve({ data: [guest] });
      return Promise.reject(new Error(`Unexpected API path ${path}`));
    });

    renderRequestsPage();

    const approve=await screen.findByRole('button',{name:'Approve'});
    expect(approve).toBeDisabled();
    expect(screen.getByText('Loading…')).toBeVisible();
    fireEvent.click(approve);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiMock.mock.calls.some(([path])=>path==='/access-requests/request-1/approve')).toBe(false);

    rejectGuests(new TypeError('Simulated guest directory outage'));
    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    await waitFor(()=>expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(await screen.findByRole('option',{name:'Link to Existing Luca'})).toBeInTheDocument();
  });
});

const directoryGuest={id:'guest-1',name:'Luca Rossi',roomId:'room-102',roomName:'102',language:'it',itemCount:0,totalCents:0,version:1};

describe('guest directory query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows loading until a successful empty response arrives', async () => {
    let resolveGuests!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/guests'
      ? new Promise(resolve => { resolveGuests=resolve; })
      : Promise.resolve({ data: [] }));

    renderGuestsPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
    resolveGuests({ data: [] });
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
  });

  it('retries a failed response and renders recovered guests', async () => {
    apiMock.mockImplementation((path:string) => path==='/guests'
      ? apiMock.mock.calls.filter(([calledPath])=>calledPath==='/guests').length===1
        ? Promise.reject(new TypeError('Simulated guest directory outage'))
        : Promise.resolve({ data: [directoryGuest] })
      : Promise.resolve({ data: [] }));

    renderGuestsPage();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));
    expect(await screen.findByText('Luca Rossi')).toBeVisible();
  });
});

describe('guest device query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows loading until a successful empty response arrives', async () => {
    let resolveSessions!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return Promise.resolve({ data: [directoryGuest] });
      if(path==='/guests/guest-1/sessions')return new Promise(resolve => { resolveSessions=resolve; });
      return Promise.resolve({ data: [] });
    });

    renderGuestsPage();
    fireEvent.click(await screen.findByRole('button',{name:'Logged-in devices Luca Rossi'}));
    const modal=within(screen.getByRole('dialog',{name:'Luca Rossi · Logged-in devices'}));

    expect(modal.getByText('Loading…')).toBeVisible();
    expect(modal.queryByText('Nothing here yet')).not.toBeInTheDocument();
    resolveSessions({ data: [] });
    expect(await modal.findByText('Nothing here yet')).toBeVisible();
  });

  it('retries a failed response and renders recovered devices', async () => {
    const session={id:'session-1',userAgent:'Luca Phone',createdAt:'2026-08-05T09:00:00.000Z',expiresAt:'2026-08-06T09:00:00.000Z'};
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return Promise.resolve({ data: [directoryGuest] });
      if(path==='/guests/guest-1/sessions')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/guests/guest-1/sessions').length===1
        ? Promise.reject(new TypeError('Simulated guest device outage'))
        : Promise.resolve({ data: [session] });
      return Promise.resolve({ data: [] });
    });

    renderGuestsPage();
    fireEvent.click(await screen.findByRole('button',{name:'Logged-in devices Luca Rossi'}));
    const modal=within(screen.getByRole('dialog',{name:'Luca Rossi · Logged-in devices'}));

    expect(await modal.findByText('The request could not be completed.')).toBeVisible();
    expect(modal.queryByText('Nothing here yet')).not.toBeInTheDocument();
    fireEvent.click(modal.getByRole('button',{name:'Retry'}));
    expect(await modal.findByText('Luca Phone')).toBeVisible();
  });
});

describe('venue settings query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: { role: 'admin' } });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('retries an initial failure and initializes the recovered settings form', async () => {
    const venue={name:'Hotel Aurora',defaultLanguage:'it',timezone:'Europe/Rome',version:3};
    apiMock.mockImplementation((path:string) => {
      if(path==='/rooms')return Promise.resolve({ data: [] });
      return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/venue').length===1
        ? Promise.reject(new TypeError('Simulated venue outage'))
        : Promise.resolve(venue);
    });

    renderSettingsPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByRole('textbox',{name:'Venue name'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect(await screen.findByDisplayValue('Hotel Aurora')).toBeVisible();
    expect(screen.getByDisplayValue('Europe/Rome')).toBeVisible();
    expect(screen.getByRole('combobox',{name:'Default language'})).toHaveValue('it');
    expect(apiMock.mock.calls.filter(([path])=>path==='/venue')).toHaveLength(2);
  });
});

const administrator={id:'host-1',email:'admin@skybar.test',name:'Mira Host',role:'admin' as const,language:'en' as const,version:1};

describe('catalog administration query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: administrator });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('withholds catalog controls until both queries succeed', async () => {
    let resolveCategories!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/products'
      ? Promise.resolve({ data: [], catalogVersion: 1 })
      : path==='/categories'
        ? new Promise(resolve => { resolveCategories=resolve; })
        : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderProductsPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByPlaceholderText('German name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Add'})).not.toBeInTheDocument();

    resolveCategories({ data: [] });
    expect(await screen.findByPlaceholderText('German name')).toBeVisible();
    expect(screen.getByRole('button',{name:'Add'})).toBeDisabled();
    expect(screen.getByText('Nothing here yet')).toBeVisible();
  });

  it('retries both catalog queries and renders coupled recovered data', async () => {
    const category={id:'category-1',name:{de:'Getränke',it:'Bevande',en:'Drinks'},position:0,version:1};
    const product={id:'product-1',categoryId:'category-1',name:{de:'Helles',it:'Bionda',en:'Lager'},priceCents:420,enabled:true,selfServiceOnly:false,position:0,version:2};
    apiMock.mockImplementation((path:string) => {
      if(path==='/products')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/products').length===1
        ? Promise.reject(new TypeError('Simulated product outage'))
        : Promise.resolve({ data: [product], catalogVersion: 2 });
      if(path==='/categories')return Promise.resolve({ data: [category] });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    renderProductsPage();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByPlaceholderText('German name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect(await screen.findByText('Lager')).toBeVisible();
    const categories=screen.getByRole('heading',{name:'Categories'}).closest('section')!;
    expect(within(categories).getByText('Drinks')).toBeVisible();
    expect(within(categories).getByText('1')).toBeVisible();
    expect(screen.getByPlaceholderText('German name')).toBeVisible();
    expect(screen.getByRole('button',{name:'Add'})).toBeEnabled();
    expect(apiMock.mock.calls.filter(([path])=>path==='/products')).toHaveLength(2);
    expect(apiMock.mock.calls.filter(([path])=>path==='/categories')).toHaveLength(2);
  });
});

describe('account session query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: administrator });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('shows session loading while profile controls remain usable', async () => {
    let resolveSessions!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/account/sessions'
      ? new Promise(resolve => { resolveSessions=resolve; })
      : path==='/hosts' ? Promise.resolve({ data: [] }) : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderAccountPage();
    const devices=within(screen.getByRole('heading',{name:'Logged-in devices'}).closest('section')!);

    expect(devices.getByText('Loading…')).toBeVisible();
    expect(devices.queryByText('Nothing here yet')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:'Name'})).toBeEnabled();

    resolveSessions({ data: [] });
    expect(await devices.findByText('Nothing here yet')).toBeVisible();
  });

  it('retries failed sessions and renders the recovered device', async () => {
    const session={id:'session-1',userAgent:'Firefox',createdAt:'2026-08-05T09:00:00.000Z',lastSeenAt:'2026-08-05T10:00:00.000Z',expiresAt:'2026-08-06T09:00:00.000Z',current:true};
    apiMock.mockImplementation((path:string) => {
      if(path==='/account/sessions')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/account/sessions').length===1
        ? Promise.reject(new TypeError('Simulated session outage'))
        : Promise.resolve({ data: [session] });
      if(path==='/hosts')return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    renderAccountPage();
    const devices=within(screen.getByRole('heading',{name:'Logged-in devices'}).closest('section')!);

    expect(await devices.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.getByRole('textbox',{name:'Name'})).toBeEnabled();
    fireEvent.click(devices.getByRole('button',{name:'Retry'}));

    expect(await devices.findByText('This device')).toBeVisible();
    expect(devices.getByRole('button',{name:'Log out'})).toBeVisible();
    expect(apiMock.mock.calls.filter(([path])=>path==='/account/sessions')).toHaveLength(2);
  });
});

describe('room management query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: administrator });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('withholds room mutation controls until loading succeeds', async () => {
    let resolveRooms!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/rooms'
      ? new Promise(resolve => { resolveRooms=resolve; })
      : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderRoomsPage();

    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByPlaceholderText('Room name')).not.toBeInTheDocument();
    expect(screen.queryByText('Display order')).not.toBeInTheDocument();

    resolveRooms({ data: [] });
    expect(await screen.findByPlaceholderText('Room name')).toBeVisible();
    expect(screen.getByText('Display order')).toBeVisible();
    expect(screen.getByText('Nothing here yet')).toBeVisible();
  });

  it('retries a failed room directory and renders recovered controls', async () => {
    const room={id:'room-1',name:'101',position:0,guestCount:2,version:1};
    apiMock.mockImplementation((path:string) => path==='/rooms'
      ? apiMock.mock.calls.filter(([calledPath])=>calledPath==='/rooms').length===1
        ? Promise.reject(new TypeError('Simulated room outage'))
        : Promise.resolve({ data: [room] })
      : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderRoomsPage();

    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByPlaceholderText('Room name')).not.toBeInTheDocument();
    expect(screen.queryByText('Display order')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect(await screen.findByText('101')).toBeVisible();
    expect(screen.getByText('2 Guests')).toBeVisible();
    expect(screen.getByPlaceholderText('Room name')).toBeVisible();
    expect(screen.getByRole('button',{name:'Archive 101'})).toBeVisible();
    expect(apiMock.mock.calls.filter(([path])=>path==='/rooms')).toHaveLength(2);
  });
});

const orderHost={...administrator,id:'00000000-0000-4000-8000-000000000001'};
const orderRoom={id:'00000000-0000-4000-8000-000000000002',name:'101',position:0,version:1};
const orderGuest={id:'00000000-0000-4000-8000-000000000003',name:'Anna Berger',roomId:orderRoom.id,roomName:'101',language:'de' as const,itemCount:0,totalCents:0,version:1};
const orderCategory={id:'00000000-0000-4000-8000-000000000004',name:{de:'Getränke',it:'Bevande',en:'Drinks'},position:0,version:1};
const orderProduct={id:'00000000-0000-4000-8000-000000000005',categoryId:orderCategory.id,name:{de:'Helles',it:'Bionda',en:'Lager'},priceCents:420,enabled:true,selfServiceOnly:false,position:0,version:1};

describe('take orders operational query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: orderHost });
    localStorage.clear();
    localStorage.setItem('skybar-language', 'en');
    window.history.replaceState({}, '', '/app/orders/new');
  });
  afterEach(cleanup);

  it('gates the guest picker through pending and successful-empty states', async () => {
    let resolveGuests!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return new Promise(resolve => { resolveGuests=resolve; });
      if(path==='/rooms')return Promise.resolve({ data: [orderRoom] });
      if(path==='/categories')return Promise.resolve({ data: [] });
      if(path==='/products')return Promise.resolve({ data: [], catalogVersion: 1 });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const rendered=renderTakeOrdersPage();
    const picker=within(rendered.container.querySelector<HTMLElement>('.guest-picker')!);

    expect(picker.getByText('Loading…')).toBeVisible();
    expect(picker.queryByText('Nothing here yet')).not.toBeInTheDocument();
    expect(picker.queryByRole('button',{name:'Add Guests'})).not.toBeInTheDocument();
    expect(picker.queryByLabelText('Search guests…')).not.toBeInTheDocument();

    resolveGuests({ data: [] });
    expect(await picker.findByText('Nothing here yet')).toBeVisible();
    expect(picker.getByRole('button',{name:'Add Guests'})).toBeEnabled();
  });

  it('retries a failed guest directory without disturbing recovered catalog UI', async () => {
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/guests').length===1
        ? Promise.reject(new TypeError('Simulated guest outage'))
        : Promise.resolve({ data: [orderGuest] });
      if(path==='/rooms')return Promise.resolve({ data: [orderRoom] });
      if(path==='/categories')return Promise.resolve({ data: [orderCategory] });
      if(path==='/products')return Promise.resolve({ data: [orderProduct], catalogVersion: 1 });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const rendered=renderTakeOrdersPage();
    const picker=within(rendered.container.querySelector<HTMLElement>('.guest-picker')!);

    expect(await picker.findByText('The request could not be completed.')).toBeVisible();
    expect(picker.queryByRole('button',{name:'Add Guests'})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:/Lager/})).toBeDisabled();
    fireEvent.click(picker.getByRole('button',{name:'Retry'}));

    expect(await picker.findByText('Anna Berger')).toBeVisible();
    expect(picker.getByRole('button',{name:'Add Guests'})).toBeEnabled();
    expect(apiMock.mock.calls.filter(([path])=>path==='/guests')).toHaveLength(2);
  });

  it('gates the coupled catalog and retries both prerequisites', async () => {
    let resolveCategories!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return Promise.resolve({ data: [orderGuest] });
      if(path==='/rooms')return Promise.resolve({ data: [orderRoom] });
      if(path==='/categories')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/categories').length===1
        ? new Promise(resolve => { resolveCategories=resolve; })
        : Promise.resolve({ data: [orderCategory] });
      if(path==='/products')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/products').length===1
        ? Promise.resolve({ data: [], catalogVersion: 1 })
        : Promise.resolve({ data: [orderProduct], catalogVersion: 2 });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const rendered=renderTakeOrdersPage();
    const catalog=within(rendered.container.querySelector<HTMLElement>('.catalog')!);

    expect(catalog.getByText('Loading…')).toBeVisible();
    expect(catalog.queryByText('Nothing here yet')).not.toBeInTheDocument();
    resolveCategories({ data: [] });
    expect(await catalog.findByText('Nothing here yet')).toBeVisible();

    const productCalls=apiMock.mock.calls.filter(([path])=>path==='/products').length;
    const categoryCalls=apiMock.mock.calls.filter(([path])=>path==='/categories').length;
    apiMock.mockImplementation((path:string) => {
      if(path==='/guests')return Promise.resolve({ data: [orderGuest] });
      if(path==='/rooms')return Promise.resolve({ data: [orderRoom] });
      if(path==='/categories')return Promise.resolve({ data: [orderCategory] });
      if(path==='/products')return Promise.reject(new TypeError('Simulated product outage'));
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    const client=new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanup();
    const failed=renderTakeOrdersPage(client);
    const failedCatalog=within(failed.container.querySelector<HTMLElement>('.catalog')!);
    expect(await failedCatalog.findByText('The request could not be completed.')).toBeVisible();
    apiMock.mockImplementation((path:string) => path==='/products'
      ? Promise.resolve({ data: [orderProduct], catalogVersion: 2 })
      : path==='/categories' ? Promise.resolve({ data: [orderCategory] })
        : path==='/guests' ? Promise.resolve({ data: [orderGuest] })
          : path==='/rooms' ? Promise.resolve({ data: [orderRoom] })
            : Promise.reject(new Error(`Unexpected API path: ${path}`)));
    fireEvent.click(failedCatalog.getByRole('button',{name:'Retry'}));

    expect(await failedCatalog.findByRole('button',{name:/Lager/})).toBeVisible();
    expect(apiMock.mock.calls.filter(([path])=>path==='/products').length).toBe(productCalls+2);
    expect(apiMock.mock.calls.filter(([path])=>path==='/categories').length).toBe(categoryCalls+2);
  });

  it('keeps cached ordering data and frozen uncertain snapshots usable during outages', async () => {
    const client=new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['rooms'],{data:[orderRoom]});
    client.setQueryData(['guests'],{data:[orderGuest]});
    client.setQueryData(['categories'],{data:[orderCategory]});
    client.setQueryData(['products'],{data:[orderProduct],catalogVersion:1});
    apiMock.mockRejectedValue(new TypeError('Simulated background outage'));

    renderTakeOrdersPage(client);
    fireEvent.click(screen.getByRole('button',{name:/Anna Berger/}));
    fireEvent.click(screen.getByRole('button',{name:/Lager/}));
    expect(screen.getByRole('button',{name:'Submit order'})).toBeEnabled();
    expect(screen.getAllByText('Lager')).toHaveLength(2);

    cleanup();
    localStorage.setItem(`skybar-uncertain-order:${orderHost.id}`,JSON.stringify({id:'00000000-0000-4000-8000-000000000006',hostId:orderHost.id,path:'/order-batches',method:'POST',createdAt:'2026-08-05T10:00:00.000Z',body:{mutationId:'00000000-0000-4000-8000-000000000006',originHostId:orderHost.id,guestId:orderGuest.id,catalogVersion:1,capturedAt:'2026-08-05T10:00:00.000Z',items:[{productId:orderProduct.id,quantity:1}]},display:{kind:'order',guestId:orderGuest.id,guestName:'Anna Berger',roomName:'101',items:[{productId:orderProduct.id,productName:{de:'Gesichertes Helles',it:'Bionda acquisita',en:'Captured Lager'},unitPriceCents:420,quantity:1}]}}));
    const emptyClient=new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTakeOrdersPage(emptyClient);

    expect(await screen.findByText('The result is still uncertain. The staged order stays locked until the same command is retried.')).toBeVisible();
    expect(screen.getByText('Captured Lager')).toBeVisible();
    const cart=within(document.querySelector<HTMLElement>('.cart-panel')!);
    expect(cart.getByRole('button',{name:'Retry'})).toBeEnabled();
  });
});

describe('settings room QR query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: administrator });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('preserves venue controls while rooms load, then enables successful-empty printing', async () => {
    let resolveRooms!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/venue'
      ? Promise.resolve({name:'Hotel Aurora',defaultLanguage:'en',timezone:'Europe/Berlin',version:1})
      : path==='/rooms' ? new Promise(resolve => { resolveRooms=resolve; })
        : Promise.reject(new Error(`Unexpected API path: ${path}`)));
    const print=vi.spyOn(window,'print').mockImplementation(()=>{});

    renderSettingsPage();
    expect(await screen.findByDisplayValue('Hotel Aurora')).toBeEnabled();
    const roomHeading=screen.getByRole('heading',{name:'Room QR codes'});
    expect(screen.getByText('Loading…')).toBeVisible();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Print'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Print'}));
    expect(print).not.toHaveBeenCalled();

    resolveRooms({ data: [] });
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
    expect(roomHeading).toBeVisible();
    expect(screen.getByRole('button',{name:'Print'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'Print'}));
    expect(print).toHaveBeenCalledOnce();
    print.mockRestore();
  });

  it('retries a failed room directory and renders recovered QR cards', async () => {
    apiMock.mockImplementation((path:string) => {
      if(path==='/venue')return Promise.resolve({name:'Hotel Aurora',defaultLanguage:'en',timezone:'Europe/Berlin',version:1});
      if(path==='/rooms')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/rooms').length===1
        ? Promise.reject(new TypeError('Simulated room QR outage'))
        : Promise.resolve({ data: [orderRoom] });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    renderSettingsPage();
    expect(await screen.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.getByRole('textbox',{name:'Venue name'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Print'})).toBeDisabled();
    expect(screen.queryByRole('heading',{name:'101'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Retry'}));

    expect(await screen.findByRole('heading',{name:'101'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Print'})).toBeEnabled();
  });
});

describe('administrator host directory query states', () => {
  beforeEach(() => {
    apiMock.mockReset();
    hostContextMock.mockReturnValue({ host: administrator });
    localStorage.setItem('skybar-language', 'en');
  });
  afterEach(cleanup);

  it('preserves profile and device controls while hosts load, then shows successful empty', async () => {
    let resolveHosts!: (value: unknown) => void;
    apiMock.mockImplementation((path:string) => path==='/account/sessions'
      ? Promise.resolve({ data: [] })
      : path==='/hosts' ? new Promise(resolve => { resolveHosts=resolve; })
        : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderAccountPage();
    const hostCard=within(screen.getByRole('heading',{name:'Host accounts'}).parentElement!.nextElementSibling as HTMLElement);
    expect(hostCard.getByText('Loading…')).toBeVisible();
    expect(hostCard.queryByText('Nothing here yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Add'})).not.toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:'Name'})).toBeEnabled();
    expect(await screen.findAllByText('Nothing here yet')).toHaveLength(1);

    resolveHosts({ data: [] });
    expect(await hostCard.findByText('Nothing here yet')).toBeVisible();
    expect(screen.getByRole('button',{name:'Add'})).toBeEnabled();
  });

  it('retries host failures before exposing host mutation actions', async () => {
    const managed={id:'host-2',name:'Pat Staff',email:'pat@example.test',role:'staff' as const,language:'en' as const,active:true,version:1};
    apiMock.mockImplementation((path:string) => {
      if(path==='/account/sessions')return Promise.resolve({ data: [] });
      if(path==='/hosts')return apiMock.mock.calls.filter(([calledPath])=>calledPath==='/hosts').length===1
        ? Promise.reject(new TypeError('Simulated host directory outage'))
        : Promise.resolve({ data: [managed] });
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    renderAccountPage();
    const hostCard=within(screen.getByRole('heading',{name:'Host accounts'}).parentElement!.nextElementSibling as HTMLElement);
    expect(await hostCard.findByText('The request could not be completed.')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Add'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Disable'})).not.toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:'Name'})).toBeEnabled();
    fireEvent.click(hostCard.getByRole('button',{name:'Retry'}));

    expect(await hostCard.findByText('Pat Staff')).toBeVisible();
    expect(screen.getByRole('button',{name:'Add'})).toBeEnabled();
    expect(hostCard.getByRole('button',{name:'Disable'})).toBeEnabled();
  });

  it('does not query or render host administration for staff', async () => {
    hostContextMock.mockReturnValue({ host: {...administrator,role:'staff'} });
    apiMock.mockImplementation((path:string) => path==='/account/sessions'
      ? Promise.resolve({ data: [] })
      : Promise.reject(new Error(`Unexpected API path: ${path}`)));

    renderAccountPage();
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
    expect(screen.queryByRole('heading',{name:'Host accounts'})).not.toBeInTheDocument();
    expect(apiMock.mock.calls.some(([path])=>path==='/hosts')).toBe(false);
  });
});
