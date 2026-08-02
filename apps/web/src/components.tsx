import { useEffect, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { apiErrorMessage } from './api';
import { useI18n } from './i18n';
import { isPermanentSyncConflict } from './offline';

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary'|'secondary'|'danger'|'ghost' }) {
  return <button className={`button button--${variant} ${className}`} {...props} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={t('close')}><X /></button></header>
      {children}
    </section>
  </div>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty"><span>✦</span><p>{children}</p></div>; }

export function Notice({ kind = 'success', children }: { kind?: 'success'|'error'; children: ReactNode }) {
  return <div className={`notice notice--${kind}`}>{kind === 'success' ? <CheckCircle2 /> : <AlertCircle />}<span>{children}</span></div>;
}

export function ConfirmForm({ label, placeholder, onConfirm, onCancel, onDefinitiveFailure }: { label: string; placeholder: string; onConfirm: (reason: string) => Promise<void>; onCancel: () => void; onDefinitiveFailure?: () => void }) {
  const { t, language } = useI18n();
  const [reason, setReason] = useState('');
  const [submittedReason, setSubmittedReason] = useState<string>();
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const frozenReason=submittedReason??reason;
    setSubmittedReason(frozenReason);
    try { await onConfirm(frozenReason); } catch (caught) {
      if(isPermanentSyncConflict(caught)){setSubmittedReason(undefined);onDefinitiveFailure?.()}
      setError(apiErrorMessage(caught, language, t('requestFailed')));
    }
  };
  return <form onSubmit={submit} className="stack"><Field label={label}><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} required minLength={2} autoFocus disabled={submittedReason!==undefined}/></Field>{error && <Notice kind="error">{error}</Notice>}<div className="form-actions"><Button type="button" variant="ghost" onClick={onCancel}>{t('cancel')}</Button><Button variant="danger" type="submit">{submittedReason===undefined?t('confirm'):t('retry')}</Button></div></form>;
}
