'use client';

import { useTranslation } from '@/i18n/context';
import type { PqMessageMark as Mark } from '@/lib/pq/status';

/**
 * Per-message pill flagging what a single DM lacked (no gift wrap, or no
 * post-quantum envelope). Renders nothing for a healthy message — see
 * `messageMark()` (Task 1), which only returns a non-null mark for
 * deficient messages.
 */
export default function PqMessageMark({
  mark,
  onAccent = false,
}: {
  mark: Mark;
  /**
   * The default `text-lc-muted` (#a3a3a3) is roughly 2:1 contrast against
   * the `bg-lc-green` outgoing bubble (DesktopShell.tsx ~4333), a WCAG
   * failure. Set this on outgoing marks to switch to the darker on-accent
   * variant the timestamp row in the same bubble already uses
   * (`text-black/60`).
   */
  onAccent?: boolean;
}) {
  const { t } = useTranslation();
  if (mark === null) return null;

  const label = mark === 'no-giftwrap' ? t('pq.markNoGiftwrap') : t('pq.markNoPq');
  const detail = mark === 'no-giftwrap' ? t('pq.markNoGiftwrapDetail') : t('pq.markNoPqDetail');

  return (
    <span
      className={
        'inline-flex items-center rounded-full border border-lc-border px-1.5 py-0 text-[10px] uppercase tracking-wide ' +
        (onAccent ? 'text-black/60' : 'text-lc-muted')
      }
      data-testid="pq-mark"
      title={detail}
      aria-label={`${label}: ${detail}`}
    >
      {label}
    </span>
  );
}
