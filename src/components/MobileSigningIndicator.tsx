'use client';

import { useEffect, useState } from 'react';
import { useActivityLog, type ActivityEntry } from '@/lib/activity-log';
import { useTranslation } from '@/i18n/context';

export default function MobileSigningIndicator() {
  const { t } = useTranslation();
  const activities = useActivityLog();
  const [open, setOpen] = useState(false);
  const signing = activities.find((entry) => entry.operation === 'sign' && entry.status === 'pending')
    ?? activities.find((entry) => entry.operation === 'sign')
    ?? null;
  const status = signing?.status ?? 'idle';
  const color = status === 'pending'
    ? 'bg-amber-400 animate-pulse'
    : status === 'ok'
      ? 'bg-lc-green'
      : status === 'error'
        ? 'bg-red-500'
        : 'bg-lc-muted';

  return (
    <>
      <button
        type="button"
        className="icon-btn action-sign"
        onClick={() => setOpen(true)}
        aria-label={t('mobile.signing.label')}
        data-testid="mobile-signing-indicator"
        data-status={status}
      >
        <span className={`h-3.5 w-3.5 rounded-full border-2 border-black/40 shadow-[0_0_8px_currentColor] ${color}`} aria-hidden="true" />
      </button>
      {open && <SigningPopup entry={signing} onClose={() => setOpen(false)} />}
    </>
  );
}

function SigningPopup({ entry, onClose }: { entry: ActivityEntry | null; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const statusKey = entry ? `mobile.signing.${entry.status}` : 'mobile.signing.idle';
  const kind = entry?.eventKind == null ? null : `kind ${entry.eventKind}`;
  const detail = [entry?.description, kind].filter(Boolean).join(' · ') || entry?.detail;

  return (
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/70 p-5"
      onClick={onClose}
      data-testid="mobile-signing-popup-backdrop"
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-lc-border bg-lc-dark p-4 text-lc-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-signing-title"
        onClick={(event) => event.stopPropagation()}
        data-testid="mobile-signing-popup"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="mobile-signing-title" className="text-base font-semibold">{t('mobile.signing.title')}</h2>
            <p className="mt-1 text-xs text-lc-green">{t(statusKey)}</p>
          </div>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full bg-lc-black text-xl" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        {entry ? (
          <div className="mt-4 rounded-xl border border-lc-border bg-lc-black p-3">
            <div className="text-sm font-medium">{entry.label}</div>
            {detail && <div className="mt-1 break-words text-xs text-lc-muted">{detail}</div>}
          </div>
        ) : (
          <p className="mt-4 text-sm text-lc-muted">{t('mobile.signing.none')}</p>
        )}
      </div>
    </div>
  );
}
