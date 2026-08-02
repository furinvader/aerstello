import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Redirect, useLocation, useSearch } from 'wouter';
import { api, apiErrorMessage, json } from './api';
import { Button, Card, Field, Notice } from './components';
import { useI18n } from './i18n';
import type { Language } from '@sky-bar/shared';
import type { Room } from './types';

function PublicFrame({ children }: { children: React.ReactNode }) {
  const { language, setLanguage, t } = useI18n();
  return <main className="public-shell"><header className="public-brand"><img src="/sky-bar.svg" alt=""/><span>Sky Bar</span><select aria-label={t('language')} value={language} onChange={(e) => setLanguage(e.target.value as Language)}><option value="de">DE</option><option value="it">IT</option><option value="en">EN</option></select></header>{children}</main>;
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
interface AccessSubmission { key: string; mutationId: string; name: string; roomId: string; language: Language }

function loadDurableRecovery(key: string): string | null {
  const durable = localStorage.getItem(key);
  const legacy = sessionStorage.getItem(key);
  if (legacy) sessionStorage.removeItem(key);
  if (!durable && legacy) localStorage.setItem(key, legacy);
  return durable ?? legacy;
}

export function RequestAccessPage() {
  const { t, language, setLanguage, applyDefaultLanguage } = useI18n();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const bootstrap = useQuery<Bootstrap>({ queryKey: ['public-bootstrap'], queryFn: () => api('/public/bootstrap') });
  const submission = useRef<AccessSubmission | null>((() => {
    const raw=loadDurableRecovery('skybar-access-submission');
    if(!raw)return null;
    try{return JSON.parse(raw) as AccessSubmission;}catch{localStorage.removeItem('skybar-access-submission');return null;}
  })());
  const [name, setName] = useState(submission.current?.name ?? '');
  const [roomId, setRoomId] = useState(submission.current?.roomId ?? params.get('room') ?? '');
  const [pending, setPending] = useState<PendingAccess | null>(() => {
    const raw = loadDurableRecovery('skybar-pending');
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Omit<PendingAccess, 'grantId'> & { grantId?: string };
      const next = { ...stored, grantId: stored.grantId ?? crypto.randomUUID() };
      localStorage.setItem('skybar-pending', JSON.stringify(next));
      return next;
    } catch {
      localStorage.removeItem('skybar-pending');
      return null;
    }
  });
  const [terminalStatus, setTerminalStatus] = useState<'denied'|'expired'|'disabled'|null>(null);
  const [error, setError] = useState('');
  const [, navigate] = useLocation();
  useEffect(() => {
    if (bootstrap.data?.venue.defaultLanguage) applyDefaultLanguage(bootstrap.data.venue.defaultLanguage);
  }, [applyDefaultLanguage, bootstrap.data?.venue.defaultLanguage]);
  useEffect(() => {
    if (submission.current?.language) setLanguage(submission.current.language);
  }, [setLanguage]);
  useEffect(() => {
    if (!pending) return;
    const stopPolling = (status:'denied'|'expired'|'disabled',showError = false) => {
      localStorage.removeItem('skybar-pending');
      setPending(null);
      setTerminalStatus(status);
      if (showError) setError(t('requestFailed'));
    };
    const poll = async () => {
      try {
        const result = await api<{ status: string; granted: boolean }>(`/public/access-requests/${pending.id}/status`, { method:'POST', body:json({ token:pending.token, grantId:pending.grantId }) });
        if (result.status === 'approved' && result.granted) { localStorage.removeItem('skybar-pending'); setPending(null); navigate('/guest'); }
        else if (result.status === 'approved' && !result.granted) stopPolling('denied',true);
        else if (result.status==='denied'||result.status==='expired'||result.status==='disabled') stopPolling(result.status);
      } catch { /* Keep polling across transient network errors. */ }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2500); return () => clearInterval(timer);
  }, [pending, navigate, t]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setTerminalStatus(null);
    try {
      const key=JSON.stringify({name,roomId,language});
      if(submission.current?.key!==key) submission.current={key,mutationId:crypto.randomUUID(),name,roomId,language};
      localStorage.setItem('skybar-access-submission',JSON.stringify(submission.current));
      const result = await api<{ id: string; statusToken: string }>('/public/access-requests', { method: 'POST', body: json({ mutationId:submission.current.mutationId,name,roomId,language }) });
      localStorage.removeItem('skybar-access-submission');submission.current=null;
      const next = { id: result.id, token: result.statusToken, grantId: crypto.randomUUID() }; localStorage.setItem('skybar-pending', JSON.stringify(next)); setPending(next);
    } catch (caught) { setError(apiErrorMessage(caught, language, t('requestFailed'))); }
  };
  const terminalTitle=terminalStatus==='expired'?t('accessExpired'):terminalStatus==='disabled'?t('accessDisabled'):t('deny');
  const terminalMessage=terminalStatus==='expired'?t('requestExpired'):terminalStatus==='disabled'?t('requestDisabled'):t('requestDenied');
  return <PublicFrame><Card className="auth-card"><p className="eyebrow">{bootstrap.data?.venue.name || 'Sky Bar'}</p><h1>{t('guestAccess')}</h1>{pending || terminalStatus ? <div className="request-wait"><div className="pulse-orb"/><h2>{terminalStatus ? terminalTitle : t('pending')}</h2><p className="muted">{terminalStatus ? terminalMessage : t('requestWaiting')}</p>{terminalStatus && <Button onClick={() => { setTerminalStatus(null); setError(''); }}>{t('requestAccess')}</Button>}</div> : <form onSubmit={submit} className="stack"><Field label={t('name')}><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field><Field label={t('rooms')}><select value={roomId} onChange={(e) => setRoomId(e.target.value)} required><option value="">{t('selectRoom')}</option>{bootstrap.data?.rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}</select></Field><Field label={t('language')}><select value={language} onChange={(e) => setLanguage(e.target.value as Language)}><option value="de">Deutsch</option><option value="it">Italiano</option><option value="en">English</option></select></Field>{error && <Notice kind="error">{error}</Notice>}<Button type="submit">{t('requestAccess')}</Button></form>}<a className="text-link" href="/login">{t('hostLogin')} →</a></Card></PublicFrame>;
}
