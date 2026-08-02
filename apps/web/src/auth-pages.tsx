import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Redirect, useLocation, useSearch } from 'wouter';
import { api, apiErrorMessage, json } from './api';
import { Button, Card, Field, Notice } from './components';
import { useI18n } from './i18n';
import type { Language } from '@sky-bar/shared';
import type { Room } from './types';

function PublicFrame({ children }: { children: React.ReactNode }) {
  const { language, setLanguage } = useI18n();
  return <main className="public-shell"><header className="public-brand"><img src="/sky-bar.svg" alt=""/><span>Sky Bar</span><select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value as Language)}><option value="de">DE</option><option value="it">IT</option><option value="en">EN</option></select></header>{children}</main>;
}

export function LoginPage() {
  const [, navigate] = useLocation();
  const { t, language, setLanguage } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me'), retry: false });
  if (me.isSuccess) return <Redirect to="/app" />;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result=await api<{host:{language:Language}}>('/auth/login', { method: 'POST', body: json({ email, password }) }); setLanguage(result.host.language); navigate('/app'); }
    catch (caught) { setError(apiErrorMessage(caught, language, t('requestFailed'))); }
    finally { setBusy(false); }
  };
  return <PublicFrame><Card className="auth-card"><p className="eyebrow">Sky Bar · Host</p><h1>{t('welcome')}</h1><p className="muted">{t('signInDescription')}</p><form onSubmit={submit} className="stack"><Field label={t('email')}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></Field><Field label={t('password')}><input type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>{error && <Notice kind="error">{error}</Notice>}<Button disabled={busy} type="submit">{busy ? '…' : t('signIn')}</Button></form><a className="text-link" href="/guest/request">{t('guestAccess')} →</a></Card></PublicFrame>;
}

interface Bootstrap { venue: { name: string; defaultLanguage: Language }; rooms: Pick<Room, 'id'|'name'>[] }
interface PendingAccess { id: string; token: string; grantId: string }
export function RequestAccessPage() {
  const { t, language, setLanguage, applyDefaultLanguage } = useI18n();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const bootstrap = useQuery<Bootstrap>({ queryKey: ['public-bootstrap'], queryFn: () => api('/public/bootstrap') });
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState(params.get('room') ?? '');
  const [pending, setPending] = useState<PendingAccess | null>(() => {
    const raw = sessionStorage.getItem('skybar-pending');
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Omit<PendingAccess, 'grantId'> & { grantId?: string };
      const next = { ...stored, grantId: stored.grantId ?? crypto.randomUUID() };
      sessionStorage.setItem('skybar-pending', JSON.stringify(next));
      return next;
    } catch {
      sessionStorage.removeItem('skybar-pending');
      return null;
    }
  });
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState('');
  const [, navigate] = useLocation();
  useEffect(() => {
    if (bootstrap.data?.venue.defaultLanguage) applyDefaultLanguage(bootstrap.data.venue.defaultLanguage);
  }, [applyDefaultLanguage, bootstrap.data?.venue.defaultLanguage]);
  useEffect(() => {
    if (!pending) return;
    const poll = async () => {
      try {
        const result = await api<{ status: string; granted: boolean }>(`/public/access-requests/${pending.id}/status?token=${encodeURIComponent(pending.token)}&grantId=${pending.grantId}`);
        setStatus(result.status);
        if (result.status === 'approved' && result.granted) { sessionStorage.removeItem('skybar-pending'); navigate('/guest'); }
        if (result.status === 'approved' && !result.granted) { setStatus('denied'); sessionStorage.removeItem('skybar-pending'); setPending(null); setError(t('requestFailed')); }
        if (result.status === 'expired') { setStatus('denied'); sessionStorage.removeItem('skybar-pending'); }
      } catch { /* Keep polling across transient network errors. */ }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2500); return () => clearInterval(timer);
  }, [pending, navigate, t]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const result = await api<{ id: string; statusToken: string }>('/public/access-requests', { method: 'POST', body: json({ name, roomId, language }) });
      const next = { id: result.id, token: result.statusToken, grantId: crypto.randomUUID() }; sessionStorage.setItem('skybar-pending', JSON.stringify(next)); setPending(next);
    } catch (caught) { setError(apiErrorMessage(caught, language, t('requestFailed'))); }
  };
  return <PublicFrame><Card className="auth-card"><p className="eyebrow">{bootstrap.data?.venue.name || 'Sky Bar'}</p><h1>{t('guestAccess')}</h1>{pending ? <div className="request-wait"><div className="pulse-orb"/><h2>{status === 'denied' ? t('deny') : t('pending')}</h2><p className="muted">{status === 'denied' ? t('requestDenied') : t('requestWaiting')}</p>{status === 'denied' && <Button onClick={() => { setPending(null); sessionStorage.removeItem('skybar-pending'); }}>{t('requestAccess')}</Button>}</div> : <form onSubmit={submit} className="stack"><Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field><Field label={t('rooms')}><select value={roomId} onChange={(e) => setRoomId(e.target.value)} required><option value="">{t('selectRoom')}</option>{bootstrap.data?.rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}</select></Field><Field label={t('language')}><select value={language} onChange={(e) => setLanguage(e.target.value as Language)}><option value="de">Deutsch</option><option value="it">Italiano</option><option value="en">English</option></select></Field>{error && <Notice kind="error">{error}</Notice>}<Button type="submit">{t('requestAccess')}</Button></form>}<a className="text-link" href="/login">{t('hostLogin')} →</a></Card></PublicFrame>;
}
