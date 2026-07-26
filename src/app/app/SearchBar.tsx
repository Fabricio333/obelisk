'use client';

/**
 * Discord-style search bar that runs NIP-50 queries against the active relay.
 *
 * Filter token grammar (matches the dropdown options shown in the UI):
 *   from:<npub|hex>      → author filter
 *   in:<groupId>         → restrict to a NIP-29 group (`#h`)
 *   mentions:<npub|hex>  → `#p` filter
 *   has:link|image|file  → client-side content filter (link / image url / file-ish url)
 *
 * Anything outside tokens is sent as the NIP-50 `search` term. Relays without
 * NIP-50 support will still honour author / `#h` / `#p` / time filters.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  nostrActions,
  useGroups,
  type JsGroup,
  type JsMessage,
} from '@/lib/nostr-bridge';
import { useUserMetadata as useProfile } from '@/lib/nostr-bridge';
import { useNostrUserSearch, type UserHit } from '@/lib/hooks/useNostrUserSearch';
import { searchGroups } from '@/lib/group-search';
import { formatPubkey } from '@nostr-wot/data';
import { useChatStore } from '@/store/chat';
import { useTranslation } from '@/i18n/context';

const HISTORY_KEY = 'obelisk-dex/search-history';
const HISTORY_MAX = 10;

interface ParsedQuery {
  query: string;
  authors: string[];
  mentions: string[];
  groupIds: string[];
  has: Array<'link' | 'image' | 'file'>;
}

function decodeNpub(s: string): string | null {
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith('npub1')) {
    try {
      // Lazy import — keeps initial bundle slim.
      const { nip19 } = require('nostr-tools');
      const decoded = nip19.decode(s);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch { /* ignore */ }
  }
  return null;
}

function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.match(/\S+/g) ?? [];
  const out: ParsedQuery = { query: '', authors: [], mentions: [], groupIds: [], has: [] };
  const remaining: string[] = [];
  for (const tk of tokens) {
    const m = tk.match(/^(from|in|mentions|has):(.+)$/i);
    if (!m) { remaining.push(tk); continue; }
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'from') {
      const hex = decodeNpub(val);
      if (hex) out.authors.push(hex);
    } else if (key === 'mentions') {
      const hex = decodeNpub(val);
      if (hex) out.mentions.push(hex);
    } else if (key === 'in') {
      out.groupIds.push(val);
    } else if (key === 'has') {
      const v = val.toLowerCase();
      if (v === 'link' || v === 'image' || v === 'file') out.has.push(v);
    }
  }
  out.query = remaining.join(' ').trim();
  return out;
}

function loadHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch { return []; }
}

function pushHistory(q: string) {
  if (typeof window === 'undefined') return;
  const trimmed = q.trim();
  if (!trimmed) return;
  const cur = loadHistory().filter((x) => x !== trimmed);
  const next = [trimmed, ...cur].slice(0, HISTORY_MAX);
  try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

function clearHistory() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}

export default function SearchBar({
  serverName,
  activeGroupId,
  onJump,
}: {
  serverName: string;
  activeGroupId: string | null;
  onJump?: (msg: JsMessage & { groupId: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState('');
  const [open, setOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<JsMessage & { groupId: string | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setHistory(loadHistory()); }, [open]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function runSearch(text: string) {
    setRaw(text);
    setOpen(true);
    setError(null);
    const parsed = parseQuery(text);
    if (!parsed.query && parsed.authors.length === 0 && parsed.mentions.length === 0 && parsed.has.length === 0) {
      setResults([]);
      return;
    }
    setBusy(true);
    try {
      const r = await nostrActions.searchMessages({
        query: parsed.query || undefined,
        authors: parsed.authors.length > 0 ? parsed.authors : undefined,
        mentions: parsed.mentions.length > 0 ? parsed.mentions : undefined,
        groupIds: parsed.groupIds.length > 0
          ? parsed.groupIds
          : activeGroupId ? [activeGroupId] : undefined,
        has: parsed.has.length > 0 ? parsed.has : undefined,
        limit: 30,
      });
      setResults(r);
      pushHistory(text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function applyFilter(token: string) {
    const next = raw.trim() ? `${raw.trim()} ${token}` : token;
    setRaw(next);
    setOpen(true);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setMobileExpanded(true);
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className={
          'sm:hidden rounded-md p-2 text-lc-muted hover:text-lc-white hover:bg-lc-card ' +
          (mobileExpanded ? 'hidden' : '')
        }
        aria-label={t('search.open')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      <form
        onSubmit={(e) => { e.preventDefault(); runSearch(raw); }}
        className={
          'items-center gap-2 rounded-md border border-lc-border bg-lc-dark sm:bg-lc-black/40 focus-within:border-lc-green/60 ' +
          'max-sm:fixed max-sm:inset-x-2 max-sm:top-2 max-sm:z-50 max-sm:px-3 max-sm:py-2.5 max-sm:shadow-2xl ' +
          'sm:px-3 sm:py-2 sm:w-56 md:w-80 ' +
          (mobileExpanded ? 'flex' : 'hidden sm:flex')
        }
      >
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={t('search.placeholderIn').replace('{server}', serverName)}
          className="flex-1 min-w-0 bg-transparent text-sm sm:text-xs text-lc-white outline-none placeholder:text-lc-muted"
        />
        <button type="submit" className="text-lc-muted hover:text-lc-white shrink-0" aria-label={t('common.search')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => { setMobileExpanded(false); setOpen(false); setRaw(''); }}
          className="sm:hidden text-lc-muted hover:text-lc-white shrink-0"
          aria-label={t('search.close')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </form>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-[420px] max-h-[70vh] overflow-y-auto rounded-xl border border-lc-border bg-lc-dark shadow-2xl z-50">
          {!raw.trim() ? (
            <FilterAndHistoryPane
              history={history}
              t={t}
              onPickFilter={applyFilter}
              onPickHistory={(h) => runSearch(h)}
              onClearHistory={() => { clearHistory(); setHistory([]); }}
            />
          ) : (
            <ResultsPane
              raw={raw}
              parsed={parseQuery(raw)}
              busy={busy}
              error={error}
              results={results}
              onPickFilter={applyFilter}
              t={t}
              onJump={(m) => { onJump?.(m); setOpen(false); }}
              onClose={() => setOpen(false)}
              onPreviewUser={(pk) => { useChatStore.getState().openProfilePopup(pk); setOpen(false); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FilterAndHistoryPane({
  history, t, onPickFilter, onPickHistory, onClearHistory,
}: {
  history: string[];
  t: (key: string) => string;
  onPickFilter: (token: string) => void;
  onPickHistory: (q: string) => void;
  onClearHistory: () => void;
}) {
  return (
    <>
      <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted border-b border-lc-border">{t('search.filters.title')}</div>
      <FilterRow icon="👤" title={t('search.filters.fromUser.title')} hint={t('search.filters.fromUser.example')} onClick={() => onPickFilter('from:')} />
      <FilterRow icon="#" title={t('search.filters.inChannel.title')} hint={t('search.filters.inChannel.example')} onClick={() => onPickFilter('in:')} />
      <FilterRow icon="🔗" title={t('search.filters.has.title')} hint={t('search.filters.has.example')} onClick={() => onPickFilter('has:link')} />
      <FilterRow icon="@" title={t('search.filters.mentions.title')} hint={t('search.filters.mentions.example')} onClick={() => onPickFilter('mentions:')} />
      {history.length > 0 && (
        <>
          <div className="flex items-center justify-between px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted border-t border-lc-border">
            <span>{t('search.history.title')}</span>
            <button onClick={onClearHistory} className="text-lc-muted hover:text-lc-white" aria-label={t('search.history.clear')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/>
              </svg>
            </button>
          </div>
          {history.map((h) => (
            <button
              key={h}
              onClick={() => onPickHistory(h)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-lc-white hover:bg-lc-card"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-lc-muted">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span className="truncate">{h}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function FilterRow({ icon, title, hint, onClick }: { icon: string; title: string; hint: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-lc-card">
      <span className="mt-0.5 w-6 text-center text-base text-lc-muted">{icon}</span>
      <span className="flex-1 min-w-0">
        <div className="text-sm text-lc-white">{title}</div>
        <div className="text-xs text-lc-muted">{hint}</div>
      </span>
    </button>
  );
}

function ResultsPane({ raw, parsed, busy, error, results, t, onPickFilter, onJump, onClose, onPreviewUser }: {
  raw: string;
  parsed: ParsedQuery;
  busy: boolean;
  error: string | null;
  results: ReadonlyArray<JsMessage & { groupId: string | null }>;
  t: (key: string) => string;
  onPickFilter: (token: string) => void;
  onJump: (m: JsMessage & { groupId: string | null }) => void;
  onClose: () => void;
  onPreviewUser: (pubkey: string) => void;
}) {
  // When the user is composing a structured token query (`from:`, `in:`,
  // `mentions:`, `has:`), they're searching messages — hide the entity
  // sections to avoid noise. Otherwise show Users + Channels alongside
  // Messages so a single bar covers all three discovery paths.
  // Detect structured tokens on the raw text — even an unresolved `from:foo`
  // means the user is composing a message-search query, so we should hide
  // entity sections rather than try to NIP-50-search the literal token.
  const hasStructuredTokens = /(^|\s)(from|in|mentions|has):/i.test(raw);
  const showEntities = !hasStructuredTokens && raw.trim().length >= 1;
  const userQuery = showEntities ? parsed.query : '';

  return (
    <>
      {showEntities && <UsersSection query={userQuery} t={t} onPreviewUser={onPreviewUser} />}
      {showEntities && <ChannelsSection query={userQuery} t={t} onClose={onClose} />}
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted border-b border-lc-border">
        <span data-testid="search-messages-header">{busy ? t('search.messagesSearching') : t('search.messagesHeader').replace('{count}', String(results.length))}</span>
      </div>
      {error && <div className="px-3 py-2 text-xs text-red-400">{error}</div>}
      {!busy && results.length === 0 && !error && (
        <div className="px-3 py-3 text-center text-xs text-lc-muted">
          {t('search.messagesPrompt')}
        </div>
      )}
      {results.map((m) => <ResultRow key={m.id} msg={m} t={t} onJump={() => onJump(m)} onAuthor={(pk) => onPickFilter(`from:${pk}`)} />)}
    </>
  );
}

function UsersSection({ query, t, onPreviewUser }: { query: string; t: (key: string) => string; onPreviewUser: (pubkey: string) => void }) {
  const { directHit, nip05Hit, nostrResults, loading } = useNostrUserSearch(query);

  const rows: Array<{ key: string; hit: UserHit; badge?: string }> = [];
  if (directHit) rows.push({ key: `direct-${directHit.pubkey}`, hit: directHit, badge: 'npub' });
  if (nip05Hit && nip05Hit.pubkey !== directHit?.pubkey) {
    rows.push({ key: `nip05-${nip05Hit.pubkey}`, hit: nip05Hit, badge: 'NIP-05' });
  }
  for (const r of nostrResults) {
    if (r.pubkey === directHit?.pubkey || r.pubkey === nip05Hit?.pubkey) continue;
    rows.push({ key: `nostr-${r.pubkey}`, hit: r });
  }

  return (
    <section data-testid="search-users-section">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted border-b border-lc-border">
        <span>{t('search.users')}</span>
        {loading && <span className="text-[10px] normal-case font-normal text-lc-muted">{t('search.searching')}</span>}
      </div>
      {rows.length === 0 && !loading && (
        <div className="px-3 py-2 text-xs text-lc-muted">{t('search.noMatches')}</div>
      )}
      {rows.map((r) => (
        <UserResultRow key={r.key} hit={r.hit} badge={r.badge} onPick={() => onPreviewUser(r.hit.pubkey)} />
      ))}
    </section>
  );
}

function UserResultRow({ hit, badge, onPick }: { hit: UserHit; badge?: string; onPick: () => void }) {
  const name = hit.displayName ?? formatPubkey(hit.pubkey);
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-lc-card border-b border-lc-border/40 last:border-b-0"
      data-testid="search-user-row"
      data-pubkey={hit.pubkey}
    >
      {hit.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={hit.picture} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-lc-olive flex items-center justify-center text-lc-green text-xs font-semibold shrink-0">
          {(name[0] || '?').toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-lc-white truncate">{name}</span>
          {badge && (
            <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-lc-green/15 text-lc-green border border-lc-green/30 shrink-0">
              {badge}
            </span>
          )}
        </div>
        <div className="text-[11px] text-lc-muted truncate">
          {hit.nip05 ?? formatPubkey(hit.pubkey)}
        </div>
      </div>
    </button>
  );
}

function ChannelsSection({ query, t, onClose }: { query: string; t: (key: string) => string; onClose: () => void }) {
  const groups = useGroups();
  const matches = useMemo(() => searchGroups(groups, query), [groups, query]);
  if (matches.length === 0) return null;

  const pick = (g: JsGroup) => {
    void nostrActions.setActiveGroup(g.id);
    onClose();
  };

  return (
    <section data-testid="search-channels-section">
      <div className="flex items-center px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted border-b border-lc-border">
        <span>{t('search.channels')}</span>
      </div>
      {matches.slice(0, 10).map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => pick(g)}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-lc-card border-b border-lc-border/40 last:border-b-0"
          data-testid="search-channel-row"
          data-group-id={g.id}
        >
          {g.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={g.picture} alt="" className="w-7 h-7 rounded-md object-cover shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-md bg-lc-olive flex items-center justify-center text-lc-green text-xs font-semibold shrink-0">
              #
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm text-lc-white truncate">#{g.name ?? g.id.slice(0, 8)}</div>
            {g.about && <div className="text-[11px] text-lc-muted truncate">{g.about}</div>}
          </div>
        </button>
      ))}
    </section>
  );
}

function ResultRow({ msg, t, onJump, onAuthor }: {
  msg: JsMessage & { groupId: string | null };
  t: (key: string) => string;
  onJump: () => void;
  onAuthor: (pk: string) => void;
}) {
  const meta = useProfile(msg.pubkey);
  const groups = useGroups();
  const groupName = useMemo(
    () => groups.find((g) => g.id === msg.groupId)?.name ?? msg.groupId?.slice(0, 8) ?? '?',
    [groups, msg.groupId],
  );
  const name = meta?.displayName || meta?.name || msg.pubkey.slice(0, 8);
  return (
    <div className="px-3 py-2 hover:bg-lc-card border-b border-lc-border/40 last:border-b-0">
      <div className="flex items-baseline gap-2 text-xs">
        <button onClick={() => onAuthor(msg.pubkey)} className="font-semibold text-lc-white hover:underline truncate">{name}</button>
        <span className="text-lc-muted">{t('search.in')}</span>
        <span className="text-lc-green truncate">#{groupName}</span>
        <span className="ml-auto text-[10px] text-lc-muted">
          {new Date(msg.createdAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <button onClick={onJump} className="mt-0.5 block w-full text-left text-sm text-lc-white/90 line-clamp-2">{msg.content}</button>
    </div>
  );
}
