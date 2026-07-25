'use client';

import { useActivityLog, dismissActivity, type ActivityEntry } from '@/lib/activity-log';
import { usePreferences } from '@/lib/preferences';
import RelayStatusBanner from '@/app/app/RelayStatusBanner';

export default function ActivityIndicator() {
  const items = useActivityLog();
  const { showActivityIndicator } = usePreferences();
  // Only show one row to avoid a stack of notifications. A pending
  // "Waiting for ... signature" always wins over anything else — the user
  // is staring at an extension/bunker prompt and needs to know the app is
  // blocked on their action, even if a later activity (e.g. "Publishing to
  // relays") was pushed after the sign waiter.
  const pendingSign = items.find((e) => e.status === 'pending' && e.operation === 'sign');
  const visible = !showActivityIndicator ? [] : pendingSign ? [pendingSign] : items.slice(0, 1);
  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-[60] flex max-w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
      aria-live="polite"
    >
      <RelayStatusBanner />
      {visible.map((e) => (
        <ActivityRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const color =
    entry.status === 'error'
      ? 'border-red-500/40 bg-red-950/80 text-red-100'
      : entry.status === 'ok'
        ? 'border-lc-green/40 bg-lc-card/95 text-lc-white'
        : 'border-lc-border bg-lc-card/95 text-lc-white';
  return (
    <div
      className={
        'pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2 text-xs shadow-2xl backdrop-blur ' +
        color
      }
      role={entry.status === 'error' ? 'alert' : 'status'}
    >
      <StatusGlyph status={entry.status} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold leading-tight">{entry.label}</div>
        {activityDetail(entry) ? (
          <div className="mt-0.5 break-words text-[11px] leading-snug opacity-80">
            {activityDetail(entry)}
          </div>
        ) : null}
      </div>
      {entry.status === 'error' ? (
        <button
          type="button"
          onClick={() => dismissActivity(entry.id)}
          className="-mr-1 -mt-0.5 rounded p-0.5 text-red-200/80 hover:bg-red-500/20 hover:text-red-100"
          aria-label="Dismiss"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
    </div>
  );
}

function activityDetail(entry: ActivityEntry): string | undefined {
  const kind = entry.eventKind == null ? null : 'kind ' + entry.eventKind;
  if (entry.description && kind) return entry.description + ' · ' + kind;
  return entry.description ?? kind ?? entry.detail;
}

function StatusGlyph({ status }: { status: ActivityEntry['status'] }) {
  if (status === 'pending') {
    return (
      <span
        className="mt-0.5 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-lc-green/30 border-t-lc-green"
        aria-hidden
      />
    );
  }
  if (status === 'ok') {
    return (
      <span className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full bg-lc-green" aria-hidden />
    );
  }
  return (
    <span className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full bg-red-500" aria-hidden />
  );
}
