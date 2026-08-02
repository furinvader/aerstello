import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localized } from '@sky-bar/shared';
import { Link, Redirect, useLocation } from 'wouter';
import { BedDouble, Boxes, Building2, ClipboardList, CreditCard, Gauge, GlassWater, LogOut, Settings, UserRound, UserRoundCheck } from 'lucide-react';
import { ApiError, api, apiErrorCodeMessage } from './api';
import { Button, Modal } from './components';
import { useI18n } from './i18n';
import { discardMutationConflict, flushQueue, mutationConflicts, pendingMutationCount, retryMutationConflict, type QueuedMutation } from './offline';
import type { Host, Venue } from './types';

const HostContext = createContext<{host:Host;venue:Venue}|null>(null);
export function useHostContext(){const value=useContext(HostContext);if(!value)throw new Error('Host context is missing');return value}

export function useHostMe() {
  return useQuery<{ host: Host; venue: Venue }>({ queryKey: ['me'], queryFn: () => api('/auth/me'), retry: false });
}

export function HostShell({children}:{children:ReactNode}) {
  const { t, setLanguage, language } = useI18n();
  const client = useQueryClient();
  const [currentPath] = useLocation();
  const me = useHostMe();
  const requests = useQuery<{ data: unknown[] }>({ queryKey: ['requests'], queryFn: () => api('/access-requests'), enabled: me.isSuccess });
  const [online, setOnline] = useState(navigator.onLine);
  const [queued, setQueued] = useState(0);
  const [conflicts, setConflicts] = useState<QueuedMutation[]>([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const hostId = me.data?.host.id;
  useEffect(() => {
    if (!hostId) { setQueued(0); setConflicts([]); return; }
    let syncing = false;
    const sync = async () => {
      if (syncing) return;
      syncing = true;
      try {
        setOnline(navigator.onLine);
        if (navigator.onLine && await flushQueue(hostId) > 0) await client.invalidateQueries();
        setQueued(await pendingMutationCount(hostId));
        setConflicts(await mutationConflicts(hostId));
      } finally { syncing = false; }
    };
    window.addEventListener('online', sync); window.addEventListener('offline', sync); void sync();
    const timer = window.setInterval(() => void sync(), 5000);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); clearInterval(timer); };
  }, [client, hostId]);
  useEffect(() => {
    if (!me.isSuccess) return;
    const events = new EventSource('/api/v1/events');
    const refresh = () => void client.invalidateQueries();
    const revalidateSession = async () => {
      try { await api('/auth/me'); }
      catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          events.close();
          client.clear();
          globalThis.location.assign('/login');
        }
      }
    };
    events.addEventListener('open', refresh);
    events.addEventListener('error', () => void revalidateSession());
    ['access-request.changed','orders.changed','bills.changed','rooms.changed','guests.changed','catalog.changed','venue.changed','host-auth.changed'].forEach((event) => events.addEventListener(event, refresh));
    return () => events.close();
  }, [me.isSuccess, client]);
  useLayoutEffect(() => { if (me.data?.host.language && language !== me.data.host.language) setLanguage(me.data.host.language); }, [me.data?.host.language, language, setLanguage]);
  if (me.isLoading) return <div className="splash"><img src="/sky-bar.svg" alt=""/><span>Sky Bar</span></div>;
  if (me.isError) return <Redirect to="/login" />;
  if (language !== me.data!.host.language) return <div className="splash"><img src="/sky-bar.svg" alt=""/><span>Sky Bar</span></div>;
  if (!me.data!.venue.name && currentPath !== '/app/settings') return <Redirect to="/app/settings" />;
  const discardConflict=async(mutationId:string)=>{await discardMutationConflict(mutationId,hostId!);const remaining=await mutationConflicts(hostId!);setConflicts(remaining);if(!remaining.length)setShowConflicts(false)};
  const retryConflict=async(mutationId:string)=>{await retryMutationConflict(mutationId,hostId!);if(navigator.onLine&&await flushQueue(hostId!)>0)await client.invalidateQueries();setQueued(await pendingMutationCount(hostId!));setConflicts(await mutationConflicts(hostId!))};
  const nav = [
    { to:'/app', end:true, label:t('dashboard'), icon:Gauge },
    { to:'/app/orders/new', label:t('takeOrders'), icon:GlassWater, primary:true },
    { to:'/app/orders', label:t('orders'), icon:ClipboardList },
    { to:'/app/bills', label:t('bills'), icon:CreditCard },
    { to:'/app/guests', label:t('guests'), icon:UserRound },
    { to:'/app/rooms', label:t('rooms'), icon:BedDouble, admin:true },
    { to:'/app/products', label:t('products'), icon:Boxes, admin:true },
    { to:'/app/requests', label:t('requests'), icon:UserRoundCheck, badge:requests.data?.data.length },
    { to:'/app/settings', label:t('settings'), icon:Building2, admin:true },
    { to:'/app/account', label:t('account'), icon:Settings },
  ];
  return <HostContext.Provider value={{host:me.data!.host,venue:me.data!.venue}}><div className="app-shell"><aside className="sidebar"><div className="brand"><img src="/sky-bar.svg" alt=""/><div><strong>{me.data!.venue.name || 'Venue setup'}</strong><span>Sky Bar</span></div></div><nav aria-label="Primary">{nav.filter((item) => !item.admin || me.data!.host.role === 'admin').map(({ icon:Icon, ...item }) => {const active=currentPath===item.to||(!item.end&&item.to!=='/app/orders'&&currentPath.startsWith(`${item.to}/`));return <Link key={item.to} href={item.to} className={`${item.primary ? 'nav-primary ' : ''}${active ? 'active' : ''}`}><Icon/><span>{item.label}</span>{Boolean(item.badge) && <b className="badge">{item.badge}</b>}</Link>})}</nav><div className="sidebar-footer"><div className={`sync-state ${online ? '' : 'offline'}`}><span/>{online ? `${t('synced')}${queued ? ` · ${queued}`:''}` : t('offline')}</div><Button variant="ghost" onClick={() => void api('/auth/logout',{method:'POST'}).then(() => globalThis.location.assign('/login'))}><LogOut/> {t('logout')}</Button></div></aside><main className="app-content">{conflicts.length>0&&<button className="sync-conflict-banner" role="alert" onClick={()=>setShowConflicts(true)}>{conflicts.length} {t('syncConflicts')} · {t('review')}</button>}{children}</main></div>{showConflicts&&<Modal title={t('syncConflicts')} onClose={()=>setShowConflicts(false)}><p className="muted">{t('syncConflictHelp')}</p><div className="conflict-list">{conflicts.map(conflict=>{const display=conflict.display;return <div key={conflict.id}><div className="grow"><strong>{display?`${display.guestName} · ${display.roomName}`:new Date(conflict.createdAt).toLocaleString(language)}</strong><span>{new Date(conflict.createdAt).toLocaleString(language)} · {apiErrorCodeMessage(conflict.errorCode,language,t('requestFailed'))}</span>{display?.kind==='order'&&<ul>{display.items.map(item=><li key={item.productId}>{item.quantity} × {localized(item.productName,language)}</li>)}</ul>}{display?.kind==='void'&&<span>{t('queuedRemoval')}: {display.quantity} × {localized(display.productName,language)}</span>}{!display&&<code>{conflict.path}</code>}</div><div className="conflict-actions"><Button variant="secondary" onClick={()=>void retryConflict(conflict.id)}>{t('retry')}</Button><Button variant="danger" onClick={()=>void discardConflict(conflict.id)}>{t('discard')}</Button></div></div>})}</div></Modal>}</HostContext.Provider>;
}
