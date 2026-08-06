// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestPage } from './guest-page';
import { I18nProvider } from './i18n';

const { apiMock, eventSourceUrls } = vi.hoisted(() => ({ apiMock: vi.fn(), eventSourceUrls: [] as string[] }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, api: apiMock };
});

const guestIdentity={id:'guest-1',name:'Grace',roomId:'room-12',roomName:'12',language:'en' as const,sessionId:'session-1',expiresAt:'2099-01-01T00:00:00.000Z'};

describe('guest realtime events', () => {
  beforeEach(() => {
    apiMock.mockReset();
    eventSourceUrls.length = 0;
    localStorage.setItem('skybar-language', 'en');
    apiMock.mockImplementation((path: string) => {
      if (path === '/guest/me') return Promise.resolve({ guest: guestIdentity });
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
    const selfService = screen.getByRole('heading', { name: 'Self-service' }).closest('section')!;
    expect(await within(selfService).findByText('Nothing here yet')).toBeVisible();
    expect(eventSourceUrls).toEqual(['/api/v1/events?scope=guest']);
  });

  it('shows catalog loading without a successful empty state', async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === '/guest/me') return Promise.resolve({ guest: guestIdentity });
      if (path === '/guest/tab') return Promise.resolve({ id: 'tab-1', guestId: 'guest-1', status: 'open', items: [], itemCount: 0, totalCents: 0 });
      if (path === '/guest/catalog') return new Promise(() => undefined);
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage /></I18nProvider></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Grace' })).toBeVisible();
    const selfService = screen.getByRole('heading', { name: 'Self-service' }).closest('section')!;
    expect(within(selfService).getByText('Loading…')).toBeVisible();
    expect(within(selfService).queryByText('Nothing here yet')).not.toBeInTheDocument();
  });

  it('retries a failed catalog and renders recovered products', async () => {
    let catalogAttempts = 0;
    apiMock.mockImplementation((path: string) => {
      if (path === '/guest/me') return Promise.resolve({ guest: guestIdentity });
      if (path === '/guest/tab') return Promise.resolve({ id: 'tab-1', guestId: 'guest-1', status: 'open', items: [], itemCount: 0, totalCents: 0 });
      if (path === '/guest/catalog') {
        catalogAttempts += 1;
        return catalogAttempts === 1
          ? Promise.reject(new TypeError('Network unavailable'))
          : Promise.resolve({ data: [{ id: 'product-1', categoryId: 'category-1', categoryName: { de: 'Getränke', it: 'Bevande', en: 'Drinks' }, name: { de: 'Mineralwasser', it: 'Acqua minerale', en: 'Mineral water' }, priceCents: 260, enabled: true, selfServiceOnly: true, position: 0, version: 3 }] });
      }
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage /></I18nProvider></QueryClientProvider>);

    const selfService = (await screen.findByRole('heading', { name: 'Self-service' })).closest('section')!;
    expect(await within(selfService).findByText('The request could not be completed.')).toBeVisible();
    expect(within(selfService).queryByText('Nothing here yet')).not.toBeInTheDocument();
    fireEvent.click(within(selfService).getByRole('button', { name: 'Retry' }));

    expect(await within(selfService).findByRole('heading', { name: 'Drinks' })).toBeVisible();
    expect(within(selfService).getByText('Mineral water')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Grace' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Open orders' })).toBeVisible();
    expect(catalogAttempts).toBe(2);
    expect(apiMock.mock.calls.filter(([path]) => path === '/guest/me')).toHaveLength(1);
    expect(apiMock.mock.calls.filter(([path]) => path === '/guest/tab')).toHaveLength(1);
  });

  it('restores the persisted guest language before showing the authenticated shell', async () => {
    localStorage.setItem('skybar-language','en');
    apiMock.mockImplementation((path: string) => {
      if(path==='/guest/me')return Promise.resolve({guest:{...guestIdentity,language:'it'}});
      if(path==='/guest/tab')return Promise.resolve({id:'tab-1',guestId:'guest-1',status:'open',items:[],itemCount:0,totalCents:0});
      if(path==='/guest/catalog')return Promise.resolve({data:[]});
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });

    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage/></I18nProvider></QueryClientProvider>);

    const selector=await screen.findByRole('combobox',{name:'Lingua'});
    expect(selector).toHaveValue('it');
    expect(screen.getByRole('heading',{name:'Self-service'})).toHaveTextContent('Self-service');
    expect(localStorage.getItem('skybar-language')).toBe('it');
    expect(document.documentElement.lang).toBe('it');
  });

  it('keeps a manual language choice across an unchanged identity refetch', async () => {
    const identity={...guestIdentity,language:'it' as const};
    apiMock.mockImplementation((path: string) => {
      if(path==='/guest/me')return Promise.resolve({guest:identity});
      if(path==='/guest/tab')return Promise.resolve({id:'tab-1',guestId:'guest-1',status:'open',items:[],itemCount:0,totalCents:0});
      if(path==='/guest/catalog')return Promise.resolve({data:[]});
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage/></I18nProvider></QueryClientProvider>);

    fireEvent.change(await screen.findByRole('combobox',{name:'Lingua'}),{target:{value:'en'}});
    expect(screen.getByRole('combobox',{name:'Language'})).toHaveValue('en');
    await client.invalidateQueries({queryKey:['guest-me']});
    await waitFor(()=>expect(apiMock.mock.calls.filter(([path])=>path==='/guest/me')).toHaveLength(2));

    expect(screen.getByRole('combobox',{name:'Language'})).toHaveValue('en');
    expect(localStorage.getItem('skybar-language')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('applies repeated persisted-language changes and a new session', async () => {
    let identity={...guestIdentity,language:'it' as 'de'|'it'|'en'};
    apiMock.mockImplementation((path: string) => {
      if(path==='/guest/me')return Promise.resolve({guest:identity});
      if(path==='/guest/tab')return Promise.resolve({id:'tab-1',guestId:'guest-1',status:'open',items:[],itemCount:0,totalCents:0});
      if(path==='/guest/catalog')return Promise.resolve({data:[]});
      return Promise.reject(new Error(`Unexpected API path: ${path}`));
    });
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><I18nProvider><GuestPage/></I18nProvider></QueryClientProvider>);
    expect(await screen.findByRole('combobox',{name:'Lingua'})).toHaveValue('it');

    fireEvent.change(screen.getByRole('combobox',{name:'Lingua'}),{target:{value:'en'}});
    identity={...identity,language:'de'};
    await client.invalidateQueries({queryKey:['guest-me']});
    expect(await screen.findByRole('combobox',{name:'Sprache'})).toHaveValue('de');

    fireEvent.change(screen.getByRole('combobox',{name:'Sprache'}),{target:{value:'en'}});
    identity={...identity,language:'it'};
    await client.invalidateQueries({queryKey:['guest-me']});
    expect(await screen.findByRole('combobox',{name:'Lingua'})).toHaveValue('it');

    fireEvent.change(screen.getByRole('combobox',{name:'Lingua'}),{target:{value:'en'}});
    identity={...identity,sessionId:'session-2',language:'de'};
    await client.invalidateQueries({queryKey:['guest-me']});
    expect(await screen.findByRole('combobox',{name:'Sprache'})).toHaveValue('de');
    expect(localStorage.getItem('skybar-language')).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });
});
