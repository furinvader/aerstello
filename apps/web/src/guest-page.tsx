import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect } from 'wouter';
import { Clock3, LogOut, Plus, ReceiptText } from 'lucide-react';
import { formatMoney, localized, type GuestItemCreated, type LocalizedText, type Tab } from '@sky-bar/shared';
import { ApiError, api, apiErrorMessage, json } from './api';
import { Button, Card, Empty, Notice } from './components';
import { useI18n } from './i18n';
import { isPermanentSyncConflict } from './offline';
import type { Product } from './types';

interface TimedTab extends Tab { receivedAtMonotonic: number }
interface TimedGuestItem extends GuestItemCreated { receivedAtMonotonic: number }
interface ProvisionalEntry { id: string; expiresAtMonotonic: number }
interface UndoEntry extends ProvisionalEntry { productId: string; mutationId: string }
interface PendingAddStore { sessionId: string; entries: [string,string,number,number][] }
const pendingAddKey='skybar-guest-pending-adds';

function loadPendingAdds(): PendingAddStore {
  const raw=localStorage.getItem(pendingAddKey);
  if(!raw)return {sessionId:'',entries:[]};
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      const pending = stored as PendingAddStore;
      if (typeof pending.sessionId === 'string' && Array.isArray(pending.entries) && pending.entries.every((entry) =>
        Array.isArray(entry)
        && entry.length === 4
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && Number.isSafeInteger(entry[2])
        && entry[2] >= 0
        && Number.isSafeInteger(entry[3])
        && entry[3] > 0
      )) return pending;
    }
  } catch { /* Remove malformed recovery state below. */ }
  localStorage.removeItem(pendingAddKey);return {sessionId:'',entries:[]};
}

function persistPendingAdds(store: PendingAddStore): void {
  if(store.entries.length)localStorage.setItem(pendingAddKey,JSON.stringify(store));
  else localStorage.removeItem(pendingAddKey);
}

export function GuestPage() {
  const { t, language, setLanguage } = useI18n();
  const client = useQueryClient();
  const me = useQuery<{ guest: { id: string; name: string; roomName: string; sessionId: string; expiresAt: string } }>({ queryKey: ['guest-me'], queryFn: () => api('/guest/me'), retry: false });
  const tab = useQuery<TimedTab>({ queryKey: ['guest-tab'], queryFn: async () => ({...await api<Tab>('/guest/tab'),receivedAtMonotonic:performance.now()}), enabled: me.isSuccess });
  const catalog = useQuery<{ data: (Product & { categoryName: LocalizedText })[] }>({ queryKey: ['guest-catalog'], queryFn: () => api('/guest/catalog'), enabled: me.isSuccess });
  const [provisionals, setProvisionals] = useState<ProvisionalEntry[]>([]);
  const [undos, setUndos] = useState<UndoEntry[]>([]);
  const [error, setError] = useState('');
  const pendingAdds = useRef<PendingAddStore>(loadPendingAdds());
  const pendingUndos = useRef(new Set<string>());
  useEffect(() => {
    if (!me.isSuccess) return;
    const events = new EventSource('/api/v1/events');
    const refresh = () => { void client.invalidateQueries({ queryKey: ['guest-tab'] }); void client.invalidateQueries({ queryKey: ['guest-catalog'] }); };
    const refreshIdentity = () => { void client.invalidateQueries({ queryKey: ['guest-me'] }); };
    const revalidateSession = async () => {
      try { await api('/guest/me'); }
      catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          events.close();
          client.clear();
          globalThis.location.assign('/guest/request');
        }
      }
    };
    events.addEventListener('open', refresh);
    events.addEventListener('error', () => void revalidateSession());
    events.addEventListener('orders.changed', refresh);
    events.addEventListener('catalog.changed', refresh);
    events.addEventListener('guests.changed', refreshIdentity);
    events.addEventListener('rooms.changed', refreshIdentity);
    return () => events.close();
  }, [me.isSuccess, client]);
  useEffect(() => {
    if(!tab.data)return;
    const active=tab.data.items.filter((item)=>item.status==='provisional'&&item.provisionalRemainingMs>0);
    setProvisionals((current)=>active.map((item)=>current.find((entry)=>entry.id===item.id)??{
      id:item.id,
      expiresAtMonotonic:tab.data!.receivedAtMonotonic+item.provisionalRemainingMs,
    }));
    setUndos((current)=>{
      const activeEntries=active.filter((item)=>item.canUndo).map((item)=>current.find((entry)=>entry.id===item.id)??{
        id:item.id,
        productId:item.productId,
        expiresAtMonotonic:tab.data!.receivedAtMonotonic+item.provisionalRemainingMs,
        mutationId:crypto.randomUUID(),
      });
      const activeIds=new Set(activeEntries.map((entry)=>entry.id));
      return [...activeEntries,...current.filter((entry)=>pendingUndos.current.has(entry.id)&&!activeIds.has(entry.id))];
    });
  }, [tab.data]);
  useEffect(() => {
    const deadlines=[...provisionals.map((entry)=>entry.expiresAtMonotonic),...undos.map((entry)=>entry.expiresAtMonotonic)];
    if (!deadlines.length) return;
    const nextExpiry=Math.min(...deadlines);
    const timer = window.setTimeout(() => {
      const now=performance.now();
      setProvisionals((current)=>current.filter((entry)=>entry.expiresAtMonotonic>now));
      setUndos((current) => current.filter((entry)=>entry.expiresAtMonotonic>now));
      void client.invalidateQueries({ queryKey: ['guest-tab'] });
    }, Math.max(0, Math.ceil(nextExpiry-performance.now())));
    return () => window.clearTimeout(timer);
  }, [provisionals,undos,client]);
  const add = useMutation({
    mutationFn: async (product: Pick<Product,'id'|'priceCents'|'version'>):Promise<TimedGuestItem> => {
      const sessionId=me.data!.guest.sessionId;
      if(pendingAdds.current.sessionId!==sessionId)pendingAdds.current={sessionId,entries:[]};
      const existing=pendingAdds.current.entries.find(entry=>entry[0]===product.id);
      const mutationId=existing?.[1]??crypto.randomUUID();
      const expectedPriceCents=existing?.[2]??product.priceCents;
      const expectedProductVersion=existing?.[3]??product.version;
      const entries=[...pendingAdds.current.entries.filter(entry=>entry[0]!==product.id),[product.id,mutationId,expectedPriceCents,expectedProductVersion] as [string,string,number,number]];
      pendingAdds.current={sessionId,entries};
      persistPendingAdds(pendingAdds.current);
      const item=await api<GuestItemCreated>('/guest/items', { method: 'POST', body: json({ mutationId,productId:product.id,expectedPriceCents,expectedProductVersion }) });
      return {...item,receivedAtMonotonic:performance.now()};
    },
    onSuccess: (item,product) => {
      pendingAdds.current={...pendingAdds.current,entries:pendingAdds.current.entries.filter(entry=>entry[0]!==product.id)};
      persistPendingAdds(pendingAdds.current);setError('');
      if(item.provisionalRemainingMs>0){
        const expiresAtMonotonic=item.receivedAtMonotonic+item.provisionalRemainingMs;
        setProvisionals((current)=>[...current.filter((entry)=>entry.id!==item.id),{id:item.id,expiresAtMonotonic}]);
        setUndos((current)=>[...current.filter((entry)=>entry.id!==item.id),{id:item.id,productId:product.id,expiresAtMonotonic,mutationId:crypto.randomUUID()}]);
      }
      void client.invalidateQueries({ queryKey: ['guest-tab'] });
    },
    onError: (caught,product) => {
      if(isPermanentSyncConflict(caught)){
        pendingAdds.current={...pendingAdds.current,entries:pendingAdds.current.entries.filter(entry=>entry[0]!==product.id)};
        persistPendingAdds(pendingAdds.current);
      }
      setError(apiErrorMessage(caught, language, t('requestFailed')));
    },
  });
  const undoItem = async (undo:UndoEntry) => { pendingUndos.current.add(undo.id);try { await api(`/guest/items/${undo.id}/undo`, { method: 'POST', body: json({ mutationId: undo.mutationId }) }); pendingUndos.current.delete(undo.id);setUndos((current)=>current.filter((entry)=>entry.id!==undo.id)); setError(''); await client.invalidateQueries({ queryKey: ['guest-tab'] }); } catch (caught) { setError(apiErrorMessage(caught, language, t('requestFailed'))); } };
  const logout=async()=>{try{await api('/guest/logout',{method:'POST'})}catch{/* Clear cached guest data after an uncertain response. */}finally{client.clear();globalThis.location.assign('/guest/request')}};
  if (me.isLoading) return <div className="splash">Sky Bar</div>;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Redirect to="/guest/request" />;
    return <main className="guest-shell"><Card><Notice kind="error">{t('requestFailed')}</Notice><Button onClick={() => void me.refetch()}>{t('retry')}</Button></Card></main>;
  }
  const guest = me.data!.guest;
  const categories = [...new Map((catalog.data?.data??[]).map((product)=>[product.categoryId,product.categoryName])).entries()];
  const activeProvisionalIds=new Set(provisionals.map((entry)=>entry.id));
  return <main className="guest-shell">
    <header className="guest-header"><div><p className="eyebrow">{guest.roomName}</p><h1>{guest.name}</h1></div><div className="guest-header-actions"><select aria-label={t('language')} value={language} onChange={(event)=>setLanguage(event.target.value as 'de'|'it'|'en')}><option value="de">DE</option><option value="it">IT</option><option value="en">EN</option></select><Button variant="ghost" aria-label={t('logout')} onClick={() => void logout()}><LogOut/></Button></div></header>
    <section className="guest-total"><ReceiptText/>{tab.isError?<div><span>{t('requestFailed')}</span></div>:tab.data?<div><span>{tab.data.itemCount} {t('items')}</span><strong>{formatMoney(tab.data.totalCents, language)}</strong></div>:<div><span>{t('loading')}</span></div>}</section>
    {error && <Notice kind="error">{error}</Notice>}
    <div className="guest-tabs">
      <section><h2>{t('selfService')}</h2>{categories.map(([categoryId,categoryName]) => <div key={categoryId} className="catalog-group"><h3>{localized(categoryName,language)}</h3><div className="product-grid">{catalog.data?.data.filter((product) => product.categoryId===categoryId).map((product) => <button className="product-tile" key={product.id} onClick={() => add.mutate(product)} disabled={add.isPending}><span>{localized(product.name, language)}</span><strong>{formatMoney(product.priceCents, language)}</strong><Plus/></button>)}</div></div>)}</section>
      <section><h2>{t('orders')}</h2><Card>{tab.isError?<Notice kind="error">{t('requestFailed')}</Notice>:!tab.data?<p className="muted">{t('loading')}</p>:tab.data.items.length ? <div className="line-list">{tab.data.items.map((item) => <div className="line-item" key={item.id}><div><strong>{item.quantity} × {localized(item.productName, language)}</strong><span>{item.source === 'guest' ? t('selfService') : t('host')}{activeProvisionalIds.has(item.id) && <> · <Clock3 size={13}/> 10s</>}</span></div><strong>{formatMoney(item.unitPriceCents * item.quantity, language)}</strong></div>)}</div> : <Empty>{t('empty')}</Empty>}</Card></section>
    </div>
    {undos.length>0&&<div className="undo-stack">{undos.map((undo)=>{const product=catalog.data?.data.find((item)=>item.id===undo.productId);return <div className="undo-toast" key={undo.id}><span>{t('itemAdded')}{product?` · ${localized(product.name,language)}`:''}</span><Button variant="secondary" onClick={() => void undoItem(undo)}>{t('undo')}</Button></div>})}</div>}
  </main>;
}
