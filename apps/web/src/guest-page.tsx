import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect } from 'wouter';
import { Clock3, LogOut, Plus, ReceiptText } from 'lucide-react';
import { formatMoney, localized, type LocalizedText } from '@sky-bar/shared';
import { api, json } from './api';
import { Button, Card, Empty, Notice } from './components';
import { useI18n } from './i18n';
import type { Product, Tab } from './types';

export function GuestPage() {
  const { t, language, setLanguage } = useI18n();
  const client = useQueryClient();
  const me = useQuery<{ guest: { id: string; name: string; roomName: string; expiresAt: string } }>({ queryKey: ['guest-me'], queryFn: () => api('/guest/me'), retry: false });
  const tab = useQuery<Tab>({ queryKey: ['guest-tab'], queryFn: () => api('/guest/tab'), enabled: me.isSuccess });
  const catalog = useQuery<{ data: (Product & { categoryName: LocalizedText })[] }>({ queryKey: ['guest-catalog'], queryFn: () => api('/guest/catalog'), enabled: me.isSuccess });
  const [undo, setUndo] = useState<{ id: string; until: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!me.isSuccess) return;
    const events = new EventSource('/api/v1/events');
    const refresh = () => { void client.invalidateQueries({ queryKey: ['guest-tab'] }); void client.invalidateQueries({ queryKey: ['guest-catalog'] }); };
    events.addEventListener('open', refresh);
    events.addEventListener('orders.changed', refresh);
    events.addEventListener('catalog.changed', refresh);
    return () => events.close();
  }, [me.isSuccess, client]);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => {
      setUndo((current) => current?.id === undo.id ? null : current);
    }, Math.max(0, undo.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [undo]);
  const add = useMutation({ mutationFn: (productId: string) => api<{ id: string; provisionalUntil: string }>('/guest/items', { method: 'POST', body: json({ mutationId: crypto.randomUUID(), productId }) }), onSuccess: (item) => { setUndo({ id: item.id, until: new Date(item.provisionalUntil).getTime() }); void client.invalidateQueries({ queryKey: ['guest-tab'] }); }, onError: (caught) => setError(caught.message) });
  const undoItem = async () => { if (!undo) return; await api(`/guest/items/${undo.id}/undo`, { method: 'POST', body: json({}) }); setUndo(null); await client.invalidateQueries({ queryKey: ['guest-tab'] }); };
  if (me.isLoading) return <div className="splash">Sky Bar</div>;
  if (me.isError) return <Redirect to="/guest/request" />;
  const guest = me.data!.guest;
  const categories = [...new Set(catalog.data?.data.map((product) => localized(product.categoryName, language)) ?? [])];
  return <main className="guest-shell"><header className="guest-header"><div><p className="eyebrow">{guest.roomName}</p><h1>{guest.name}</h1></div><div className="guest-header-actions"><select aria-label={t('language')} value={language} onChange={(event)=>setLanguage(event.target.value as 'de'|'it'|'en')}><option value="de">DE</option><option value="it">IT</option><option value="en">EN</option></select><Button variant="ghost" aria-label={t('logout')} onClick={() => void api('/guest/logout', { method:'POST' }).then(() => location.assign('/guest/request'))}><LogOut/></Button></div></header><section className="guest-total"><ReceiptText/><div><span>{tab.data?.itemCount ?? 0} {t('items')}</span><strong>{formatMoney(tab.data?.totalCents ?? 0, language)}</strong></div></section>{error && <Notice kind="error">{error}</Notice>}<div className="guest-tabs"><section><h2>{t('selfService')}</h2>{categories.map((category) => <div key={category} className="catalog-group"><h3>{category}</h3><div className="product-grid">{catalog.data?.data.filter((product) => localized(product.categoryName, language) === category).map((product) => <button className="product-tile" key={product.id} onClick={() => add.mutate(product.id)} disabled={add.isPending}><span>{localized(product.name, language)}</span><strong>{formatMoney(product.priceCents, language)}</strong><Plus/></button>)}</div></div>)}</section><section><h2>{t('orders')}</h2><Card>{tab.data?.items.length ? <div className="line-list">{tab.data.items.map((item) => <div className="line-item" key={item.id}><div><strong>{item.quantity} × {localized(item.productName, language)}</strong><span>{item.source === 'guest' ? t('selfService') : t('host')}{item.status === 'provisional' && <> · <Clock3 size={13}/> 10s</>}</span></div><strong>{formatMoney(item.unitPriceCents * item.quantity, language)}</strong></div>)}</div> : <Empty>{t('empty')}</Empty>}</Card></section></div>{undo && undo.until > Date.now() && <div className="undo-toast"><span>{t('itemAdded')}</span><Button variant="secondary" onClick={() => void undoItem()}>{t('undo')}</Button></div>}</main>;
}
