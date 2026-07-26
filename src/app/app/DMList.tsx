'use client';

/**
 * DM list sidebar — visual mirror of obelisk's DMList.tsx, dropping the
 * obelisk-API user search. Uses the bridge's reactive DM thread map +
 * NIP-02 follows to split Follows / Others.
 */

import { useMemo, useState } from 'react';
import {
  nostrActions,
  useDirectMessages,
  useMyFollows,
  type JsDirectMessage,
} from '@/lib/nostr-bridge';
import { useUserMetadata as useProfile } from '@/lib/nostr-bridge';
import { useDMUnreadCount } from '@/lib/read-state/selectors';
import DMComposer from './DMComposer';
import UserAvatar from '@/components/UserAvatar';
import { useTranslation } from '@/i18n/context';

type Tab = 'follows' | 'others';

export default function DMList({
  activePeer,
  onPick,
}: {
  activePeer: string | null;
  onPick: (peer: string) => void;
}) {
  const { t } = useTranslation();
  const dms = useDirectMessages();
  const follows = useMyFollows();
  const followSet = useMemo(() => new Set(follows), [follows]);
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);

  const peers = useMemo(() => {
    return Object.entries(dms).map(([pubkey, msgs]) => {
      const last = msgs[msgs.length - 1];
      return {
        pubkey,
        last,
        sortKey: last?.createdAt ?? 0,
      };
    }).sort((a, b) => b.sortKey - a.sortKey);
  }, [dms]);

  const followsThreads = useMemo(() => peers.filter((p) => followSet.has(p.pubkey)), [peers, followSet]);
  const othersThreads = useMemo(() => peers.filter((p) => !followSet.has(p.pubkey)), [peers, followSet]);

  const effectiveTab: Tab = tab ?? (followsThreads.length > 0 || othersThreads.length === 0 ? 'follows' : 'others');
  const visible = effectiveTab === 'follows' ? followsThreads : othersThreads;

  return (
    <aside className="relative flex h-full w-full flex-col overflow-hidden bg-lc-dark">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-lc-border px-4 shadow-sm">
        <h3 className="truncate text-sm font-bold text-lc-white">{t('dm.title')}</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => alert(t('dm.clearCacheAlert'))}
            className="p-1 text-lc-muted transition-colors hover:text-red-400"
            title={t('dm.clearCacheTitle')}
            aria-label={t('dm.clearCache')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
            </svg>
          </button>
          <button
            onClick={() => setComposing((v) => !v)}
            className={`p-1 transition-colors ${composing ? 'text-lc-green' : 'text-lc-muted hover:text-lc-green'}`}
            title={t('dm.new')}
            aria-label={t('dm.new')}
            aria-pressed={composing}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </div>

      {composing && (
        <DMComposer
          onClose={() => setComposing(false)}
          onPicked={(pk) => { setComposing(false); onPick(pk); }}
        />
      )}

      <div className="flex shrink-0 border-b border-lc-border" role="tablist">
        {(['follows', 'others'] as const).map((tabId) => {
          const active = effectiveTab === tabId;
          const count = tabId === 'follows' ? followsThreads.length : othersThreads.length;
          return (
            <button
              key={tabId}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(tabId)}
              className={`relative flex-1 py-2 text-xs font-medium capitalize transition-colors ${
                active ? '-mb-px border-b-2 border-lc-green text-lc-green' : 'text-lc-muted hover:text-lc-white'
              }`}
            >
              {tabId === 'follows' ? t('dm.follows') : t('dm.others')} <span className="text-[10px] opacity-70">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {peers.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-lc-muted">{t('dm.noConversations')}</p>
            <button
              onClick={() => setComposing(true)}
              className="mt-2 text-xs text-lc-green hover:underline"
            >
              {t('dm.startConversation')}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-lc-muted">
              {effectiveTab === 'follows'
                ? t('dm.noFollows')
                : t('dm.everyoneInFollows')}
            </p>
          </div>
        ) : (
          visible.map((p) => (
            <DMRow
              key={p.pubkey}
              pubkey={p.pubkey}
              last={p.last}
              youPrefix={t('dm.youPrefix')}
              active={activePeer === p.pubkey}
              onClick={() => onPick(p.pubkey)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function DMRow({
  pubkey,
  last,
  youPrefix,
  active,
  onClick,
}: {
  pubkey: string;
  last: JsDirectMessage | undefined;
  youPrefix: string;
  active: boolean;
  onClick: () => void;
}) {
  const meta = useProfile(pubkey);
  const unread = useDMUnreadCount(pubkey);
  const display = meta?.displayName || meta?.name || npubLike(pubkey);
  const preview = last
    ? (last.outgoing ? youPrefix : '') + last.content.replace(/\s+/g, ' ').slice(0, 60)
    : null;
  return (
    <button
      onClick={onClick}
      className={
        'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors ' +
        (active ? 'bg-lc-border/40' : 'hover:bg-lc-border/20')
      }
    >
      <UserAvatar pubkey={pubkey} size={8} picture={meta?.picture ?? null} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span
            className={
              'truncate text-sm ' +
              (unread > 0 ? 'font-bold text-lc-white' : 'font-medium text-lc-white')
            }
          >
            {display}
          </span>
          {unread > 0 && (
            <span className="shrink-0 rounded-full bg-lc-green px-1.5 py-px text-[10px] font-bold text-lc-black">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
        {preview && (
          <p
            className={
              'truncate text-xs ' + (unread > 0 ? 'text-lc-white' : 'text-lc-muted')
            }
          >
            {preview}
          </p>
        )}
      </div>
    </button>
  );
}

export { default as Avatar } from '@/components/UserAvatar';

function npubLike(pubkey: string): string {
  // Pretty-print a hex pubkey like "npub1xxxx…yyyy" without bech32.
  return 'npub1' + pubkey.slice(0, 6) + '…' + pubkey.slice(-4);
}
