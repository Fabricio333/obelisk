'use client';

import { useEffect, useState } from 'react';

interface HistoryPaginationStatusProps {
  readonly loading: boolean;
  readonly reachedStart: boolean;
  readonly atTop: boolean;
  readonly loadingLabel: string;
  readonly endLabel: string;
}

export default function HistoryPaginationStatus({
  loading,
  reachedStart,
  atTop,
  loadingLabel,
  endLabel,
}: HistoryPaginationStatusProps) {
  const [showLoading, setShowLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [lastMode, setLastMode] = useState<'loading' | 'end'>('loading');

  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 180);
    return () => clearTimeout(timer);
  }, [loading]);

  const visibleLoading = loading && showLoading;
  const active = atTop && (visibleLoading || reachedStart);

  useEffect(() => {
    if (visibleLoading) setLastMode('loading');
    else if (atTop && reachedStart) setLastMode('end');
  }, [atTop, reachedStart, visibleLoading]);

  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 180);
    return () => clearTimeout(timer);
  }, [active]);

  if (!mounted) return null;
  const mode = active ? (visibleLoading ? 'loading' : 'end') : lastMode;
  return (
    <div
      className={[
        'pointer-events-none absolute left-1/2 top-3 z-20 flex min-h-8 -translate-x-1/2 items-center justify-center gap-2',
        'rounded-full border border-lc-border bg-lc-dark/95 px-3 py-1.5 text-center text-xs text-lc-muted shadow-lg backdrop-blur',
        'transition-all duration-200 ease-out',
        active ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0',
      ].join(' ')}
      role={mode === 'loading' ? 'status' : undefined}
      data-testid={mode === 'loading' ? 'messages-history-loading' : 'messages-history-end'}
    >
      {mode === 'loading' && (
        <span
          className="lc-spinner"
          style={{ width: 14, height: 14, borderWidth: 2 }}
          aria-hidden="true"
        />
      )}
      <span>{mode === 'loading' ? loadingLabel : endLabel}</span>
    </div>
  );
}
