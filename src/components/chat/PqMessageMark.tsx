'use client';

import { useTranslation } from '@/i18n/context';
import type { PqMessageMark as Mark } from '@/lib/pq/status';

/**
 * Per-message pill flagging what a single DM lacked (no gift wrap, or no
 * post-quantum envelope). Renders nothing for a healthy message — see
 * `messageMark()` (Task 1), which only returns a non-null mark for
 * deficient messages.
 */
export default function PqMessageMark({ mark }: { mark: Mark }) {
  const { t } = useTranslation();
  if (mark === null) return null;

  return (
    <span
      className="inline-flex items-center rounded-full border border-lc-border px-1.5 py-0 text-[10px] uppercase tracking-wide text-lc-muted"
      data-testid="pq-mark"
      title={mark === 'no-giftwrap' ? t('pq.markNoGiftwrapDetail') : undefined}
    >
      {mark === 'no-giftwrap' ? t('pq.markNoGiftwrap') : t('pq.markNoPq')}
    </span>
  );
}
