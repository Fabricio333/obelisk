'use client';

import { useState } from 'react';
import { downloadAccountBackup } from '@/lib/account-backup';
import { useTranslation } from '@/i18n/context';

export default function AccountBackupExport({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const download = async () => {
    setStatus('working');
    setMessage('');
    try {
      const backup = await downloadAccountBackup();
      const failed = backup.media.filter((item) => item.error).length;
      setStatus('done');
      setMessage(failed
        ? t('preferences.backup.partial').replace('{{count}}', String(failed))
        : t('preferences.backup.done'));
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : t('preferences.backup.error'));
    }
  };

  return (
    <div>
      <button
        type="button"
        className={mobile
          ? 'settings-row action'
          : 'flex w-full items-center justify-between rounded-lg border border-lc-border bg-lc-black p-4 text-left hover:border-lc-green/50 disabled:opacity-60'}
        onClick={() => void download()}
        disabled={status === 'working'}
        data-testid={mobile ? 'mobile-download-backup' : 'desktop-download-backup'}
      >
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className={mobile ? '' : 'block text-sm font-semibold text-lc-white'}>
            {status === 'working' ? t('preferences.backup.working') : t('preferences.backup.action')}
          </span>
          <span className={mobile ? 'settings-row-meta muted' : 'mt-1 block text-xs text-lc-muted'} style={mobile ? { display: 'block', maxWidth: '100%', marginTop: 3 } : undefined}>
            {t('preferences.backup.description')}
          </span>
        </span>
        <span className={mobile ? 'settings-row-meta muted' : 'text-lc-muted'} aria-hidden="true">↓</span>
      </button>
      {message && (
        <p className={mobile ? 'px-4 py-2 text-xs' : 'mt-2 px-1 text-xs'} role={status === 'error' ? 'alert' : 'status'}>
          {message}
        </p>
      )}
    </div>
  );
}
