'use client';

import Link from 'next/link';
import { useTranslation } from '@/i18n/context';
import type { PqConversationStatus } from '@/lib/pq/status';

/**
 * Conversation-level notice for whether this DM thread is currently
 * post-quantum secured. Presentational only — the caller resolves
 * `status` via `conversationStatus()` (Task 1) and passes it down.
 */
export default function PqConversationNotice({
  status,
  guideHref,
}: {
  status: PqConversationStatus;
  guideHref: string;
}) {
  const { t } = useTranslation();
  const secured = status === 'secured';

  return (
    <div
      role="status"
      className={
        secured
          ? 'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-lc-green/30 bg-lc-green/10 px-3 py-2 text-xs'
          // Not-secured is a security warning, not ambient status text — reuse
          // the `warn` severity RelayStatusBanner already established
          // (RelayStatusBanner.tsx:130) instead of the muted `info` classes,
          // so this doesn't read as furniture.
          : 'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200'
      }
    >
      <span className={secured ? 'font-semibold text-lc-green' : 'font-semibold text-yellow-200'}>
        {secured ? t('pq.secured') : t('pq.notSecured')}
      </span>
      <span className={secured ? 'text-lc-muted' : 'text-yellow-200/80'}>
        {secured ? t('pq.securedDetail') : t('pq.notSecuredDetail')}
      </span>
      {!secured && (
        <Link href={guideHref} className="font-medium text-lc-green underline underline-offset-2 hover:text-lc-green/80">
          {t('pq.learnHow')}
        </Link>
      )}
    </div>
  );
}
