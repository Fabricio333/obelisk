'use client';

/**
 * Discord-style server rail. Mirrors obelisk's identity bar:
 *   ┌──┐
 *   │▶ │  ← DM tile (paper-airplane icon, first slot)
 *   └──┘
 *   ────  ← hairline separator
 *   [Ø]   ← relay tiles (one per configured relay)
 *   [+]   ← add-relay button
 *
 * Active item shows a green vertical pill on the left.
 * Tiles morph from rounded-square to circle on hover.
 */

import { useEffect, useMemo, useState } from 'react';
import { nostrActions, useConfiguredRelays, useCurrentRelayUrl, useMyPubkey } from '@/lib/nostr-bridge';
import { faviconFor, fetchRelayInfo, SUGGESTED_RELAYS, type RelayInfo } from '@/lib/relay-info';
import { encodeRelayShareCode } from '@/lib/relay-share-link';
import { useHasAnyHighlights } from '@/lib/read-state/selectors';
import ModalShell from '@/components/ModalShell';


type RailMode = { kind: 'dm' } | { kind: 'relay'; url: string };

export default function ServerRail({
  mode,
  onPickDM,
  onPickRelay,
}: {
  mode: RailMode;
  onPickDM: () => void;
  onPickRelay: (url: string) => void;
}) {
  const relays = useConfiguredRelays();
  const currentRelay = useCurrentRelayUrl();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex w-[72px] shrink-0 flex-col items-center gap-2 py-3">
      <RailTile
        active={mode.kind === 'dm'}
        title="Direct messages"
        onClick={onPickDM}
        icon={
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        }
        emphasis
      />

      <div className="my-1 h-px w-8 bg-lc-border" />

      {relays.map((url) => {
        const active = mode.kind === 'relay' && currentRelay === url;
        return (
          <RelayTile
            key={url}
            url={url}
            active={active}
            onClick={() => onPickRelay(url)}
            onRemove={() => {
              if (relays.length <= 1) return;
              if (confirm(`Remove relay ${shortHost(url)}?`)) nostrActions.removeRelay(url);
            }}
          />
        );
      })}

      <button
        onClick={() => setAdding(true)}
        title="Add relay"
        aria-label="Add relay"
        className="group/tile relative flex h-12 w-12 items-center justify-center rounded-2xl bg-lc-card text-lc-green ring-1 ring-lc-border transition-all duration-150 hover:rounded-xl hover:bg-lc-green/15 hover:ring-lc-green"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {adding && <AddRelayModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function RailTile({
  active,
  title,
  onClick,
  icon,
  emphasis,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="relative">
      <span
        className={
          'absolute -left-3 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-lc-green transition-all ' +
          (active ? 'opacity-100' : 'opacity-0')
        }
      />
      <button
        onClick={onClick}
        title={title}
        aria-label={title}
        className={
          'group/tile relative flex h-12 w-12 items-center justify-center rounded-2xl ring-1 transition-all duration-150 hover:rounded-xl ' +
          (emphasis
            ? active
              ? 'bg-lc-green text-lc-black ring-lc-green'
              : 'bg-lc-green/10 text-lc-green ring-lc-green/30 hover:bg-lc-green hover:text-lc-black hover:ring-lc-green'
            : active
              ? 'bg-lc-green text-lc-black ring-lc-green'
              : 'bg-lc-card text-lc-white ring-lc-border hover:bg-lc-olive')
        }
      >
        {icon}
      </button>
    </div>
  );
}

function RelayTile({
  url,
  active,
  onClick,
  onRemove,
}: {
  url: string;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  const host = shortHost(url);
  const initials = letterFor(host);
  const accent = colorFor(host);
  const [menu, setMenu] = useState(false);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const myPubkey = useMyPubkey();
  // The bridge only has message data for the currently-active relay, so the
  // highlights signal is meaningful on the active tile only. Cross-relay
  // mention surveillance ships in a follow-up — see docs/read-state.md.
  const hasHighlights = useHasAnyHighlights(myPubkey);
  const showHighlight = active && hasHighlights;

  async function copyShareLink() {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://obelisk.ar';
    const link = `${origin}/r/${encodeRelayShareCode(url)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link', link);
    }
  }

  useEffect(() => {
    let alive = true;
    fetchRelayInfo(url).then((info) => {
      if (!alive) return;
      setIconUrl(info?.icon || faviconFor(url));
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <div className="relative">
      <span
        className={
          'absolute -left-3 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-lc-green transition-all ' +
          (active ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-50')
        }
      />
      <button
        onClick={onClick}
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
        title={url}
        aria-label={url}
        style={{
          background: active && !(iconUrl && !iconFailed) ? accent : undefined,
          color: active ? '#0a0a0a' : '#fff',
        }}
        className={
          'group/tile relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl font-bold text-base ring-1 transition-all duration-150 hover:rounded-xl ' +
          (active
            ? 'ring-lc-green'
            : 'bg-lc-card text-lc-white ring-lc-border hover:rounded-xl')
        }
      >
        {!active && !(iconUrl && !iconFailed) && (
          <span
            aria-hidden="true"
            style={{ background: accent }}
            className="pointer-events-none absolute inset-0 rounded-2xl opacity-30 transition-opacity duration-150 group-hover/tile:opacity-60 group-hover/tile:rounded-xl"
          />
        )}
        {iconUrl && !iconFailed ? (
          <img
            src={iconUrl}
            alt=""
            onError={() => setIconFailed(true)}
            className="relative h-full w-full object-cover"
          />
        ) : (
          <span className="relative">{initials}</span>
        )}
      </button>
      {showHighlight && (
        <span
          aria-label="Unread mentions or replies on this relay"
          title="Unread mentions or replies"
          className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-lc-green px-1 text-[9px] font-bold text-lc-black ring-2 ring-lc-black"
        >
          @
        </span>
      )}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
          <div className="absolute left-14 top-0 z-50 w-44 rounded-lg border border-lc-border bg-lc-dark p-1 shadow-2xl">
            <div className="px-3 py-2 text-[10px] font-mono text-lc-muted truncate">{url}</div>
            <button
              onClick={() => { setMenu(false); onClick(); }}
              className="block w-full rounded px-3 py-1.5 text-left text-sm text-lc-muted hover:bg-lc-card hover:text-lc-white"
            >
              Switch to relay
            </button>
            <button
              onClick={() => { void copyShareLink(); }}
              className="block w-full rounded px-3 py-1.5 text-left text-sm text-lc-muted hover:bg-lc-card hover:text-lc-white"
            >
              {copied ? 'Copied!' : 'Copy share link'}
            </button>
            <button
              onClick={() => { setMenu(false); onRemove(); }}
              className="block w-full rounded px-3 py-1.5 text-left text-sm text-red-400 hover:bg-lc-card"
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AddRelayModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'suggested' | 'custom'>('suggested');
  const configured = useConfiguredRelays();
  const configuredSet = useMemo(() => new Set(configured), [configured]);

  return (
    <ModalShell
      onClose={onClose}
      panelClassName="lc-card flex max-h-[85vh] w-full max-w-lg mx-4 flex-col overflow-hidden rounded-2xl border border-lc-border bg-lc-dark shadow-2xl"
    >
        <div className="flex items-start justify-between gap-4 px-6 pt-6">
          <div>
            <h2 className="text-lg font-bold text-lc-white">Add a Relay</h2>
            <p className="mt-1 text-sm text-lc-muted">
              Pick a popular relay or enter a custom URL to connect.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="mt-4 flex border-b border-lc-border px-6">
          <TabButton active={tab === 'suggested'} onClick={() => setTab('suggested')}>
            Suggested
          </TabButton>
          <TabButton active={tab === 'custom'} onClick={() => setTab('custom')}>
            Custom URL
          </TabButton>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === 'suggested' ? (
            <SuggestedRelayList configuredSet={configuredSet} onAdded={onClose} />
          ) : (
            <CustomRelayForm onAdded={onClose} />
          )}
        </div>
    </ModalShell>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'relative -mb-px flex-1 px-4 py-3 text-sm font-semibold transition-colors ' +
        (active ? 'text-lc-white' : 'text-lc-muted hover:text-lc-white')
      }
    >
      {children}
      <span
        className={
          'absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-opacity ' +
          (active ? 'bg-lc-green opacity-100' : 'opacity-0')
        }
      />
    </button>
  );
}

function SuggestedRelayList({
  configuredSet,
  onAdded,
}: {
  configuredSet: Set<string>;
  onAdded: () => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {SUGGESTED_RELAYS.map((r) => (
        <SuggestedRelayItem
          key={r.url}
          url={r.url}
          fallbackName={r.fallbackName}
          fallbackDescription={r.fallbackDescription}
          alreadyAdded={configuredSet.has(r.url)}
          onAdded={onAdded}
        />
      ))}
    </ul>
  );
}

function SuggestedRelayItem({
  url,
  fallbackName,
  fallbackDescription,
  alreadyAdded,
  onAdded,
}: {
  url: string;
  fallbackName?: string;
  fallbackDescription?: string;
  alreadyAdded: boolean;
  onAdded: () => void;
}) {
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRelayInfo(url).then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const name = info?.name || fallbackName || shortHost(url);
  const description = info?.description || fallbackDescription || '<an undescribed relay>';
  const icon = info?.icon || faviconFor(url);
  const initials = letterFor(shortHost(url));
  const accent = colorFor(shortHost(url));

  async function add() {
    setErr(null);
    setBusy(true);
    try {
      await nostrActions.addRelay(url);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-xl border border-lc-border bg-lc-card/60 p-3">
      <div
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl text-base font-bold text-white"
        style={{ background: icon && !iconFailed ? '#000' : accent }}
      >
        {icon && !iconFailed ? (
          <img
            src={icon}
            alt=""
            onError={() => setIconFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-lc-white">{name}</div>
        <div className="truncate font-mono text-xs text-lc-muted">{url}</div>
        <div className="mt-0.5 truncate text-xs text-lc-muted">{description}</div>
        {err && <div className="mt-1 text-xs text-red-400">{err}</div>}
      </div>
      <button
        onClick={add}
        disabled={alreadyAdded || busy}
        className="shrink-0 rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        {alreadyAdded ? 'Added' : busy ? 'Adding…' : 'Add'}
      </button>
    </li>
  );
}

function CustomRelayForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('wss://');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    let v = url.trim();
    if (!v) return;
    if (!v.startsWith('ws://') && !v.startsWith('wss://')) v = 'wss://' + v.replace(/^\/*/, '');
    try {
      new URL(v);
    } catch {
      setErr('Invalid URL');
      return;
    }
    setBusy(true);
    try {
      await nostrActions.addRelay(v);
      await nostrActions.switchRelay(v);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label className="block text-sm font-semibold text-lc-white">Relay URL</label>
      <p className="mt-1 text-xs text-lc-muted">
        Paste a NIP-29 group relay URL. Each relay is a separate &ldquo;server&rdquo; in the rail.
      </p>
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
        className="mt-3 w-full rounded border border-lc-border bg-lc-black px-3 py-2 font-mono text-sm text-lc-white outline-none focus:border-lc-green"
      />
      {err && <p className="mt-2 text-sm text-red-400">{err}</p>}
      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add relay'}
        </button>
      </div>
    </form>
  );
}

// -- helpers ---------------------------------------------------------

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
function letterFor(host: string): string {
  const segs = host.split('.');
  const significant = segs.length >= 2 ? segs[segs.length - 2] : segs[0];
  return (significant[0] || '?').toUpperCase();
}
function colorFor(host: string): string {
  // Stable hash → hue; saturated, dark enough for white text.
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 60% 45%)`;
}
