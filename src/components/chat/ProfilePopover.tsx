'use client';

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useChatStore } from '@/store/chat';
import { useGroupMemberInfo, useMyPubkey, useUserMetadata } from '@/lib/nostr-bridge';
import { useToastStore } from '@/store/toast';
import { useModerationStore } from '@/store/moderation';
import { formatPubkey, hexToNpub, hexToNpub as pubkeyToNpub } from '@nostr-wot/data';
import {
  replaceShortcodes,
  CUSTOM_EMOJI_PLACEHOLDER_REGEX,
} from '@/lib/emoji-shortcodes';
import WotBadge from './WotBadge';
import UserAvatar from '@/components/UserAvatar';
import { useTranslation } from '@/i18n/context';

function renderWithEmojis(text: string, serverEmojis: Record<string, string>): ReactNode {
  if (!text) return text;
  const resolved = replaceShortcodes(text, serverEmojis);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  const re = new RegExp(CUSTOM_EMOJI_PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(resolved)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`t${i}`}>{resolved.slice(lastIndex, match.index)}</Fragment>);
    }
    const name = match[1];
    const url = serverEmojis[name];
    if (url) {
      nodes.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`e${i}`}
          src={url}
          alt={`:${name}:`}
          title={`:${name}:`}
          className="inline-block w-[1.1em] h-[1.1em] align-[-0.15em] object-contain"
        />,
      );
    }
    lastIndex = match.index + match[0].length;
    i++;
  }
  if (lastIndex < resolved.length) {
    nodes.push(<Fragment key={`t${i}`}>{resolved.slice(lastIndex)}</Fragment>);
  }
  return nodes.length ? nodes : resolved;
}

function shortNpub(pubkey: string): string {
  try {
    const npub = pubkeyToNpub(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  } catch {
    return formatPubkey(pubkey);
  }
}

const BASE_ROLE_LABEL: Record<string, { label: string; color: string }> = {
  owner: { label: 'Owner', color: '#f59e0b' },
  admin: { label: 'Admin', color: '#ef4444' },
  mod: { label: 'Moderador', color: '#3b82f6' },
  member: { label: 'Miembro', color: '#737373' },
};

export default function ProfilePopover({ pubkey, onClose, onExplore, onMessage }: {
  pubkey: string;
  onClose: () => void;
  onExplore: (pubkey: string) => void;
  onMessage?: (pubkey: string) => void;
}) {
  const { t } = useTranslation();
  const activeGroupId = useChatStore((s) => s.activeChannelId);
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const anchor = useChatStore((s) => s.profilePopupAnchor);
  const memberFromList = useGroupMemberInfo(activeGroupId).find((m) => m.pubkey === pubkey);
  // For arbitrary pubkeys (e.g. the search-bar dropdown), the active server's
  // memberList won't have an entry. Fall back to live Nostr kind:0 metadata so
  // the popover still renders avatar/name/nip05/about/website/lud16/banner.
  const meta = useUserMetadata(pubkey);
  const member = useMemo(() => {
    if (!memberFromList && !meta) return undefined;
    return {
      pubkey,
      displayName: meta?.displayName ?? meta?.name ?? memberFromList?.displayName ?? formatPubkey(pubkey),
      picture: meta?.picture ?? memberFromList?.picture,
      banner: meta?.banner ?? undefined,
      nip05: meta?.nip05 ?? memberFromList?.nip05,
      about: meta?.about ?? undefined,
      website: meta?.website ?? undefined,
      lud16: meta?.lud16 ?? undefined,
      role: memberFromList?.role,
    };
  }, [memberFromList, meta, pubkey]);
  const panelRef = useRef<HTMLDivElement>(null);
  const viewerPubkey = useMyPubkey();
  const isSelf = viewerPubkey === pubkey;
  const muted = useModerationStore((s) => s.mutedPubkeys.includes(pubkey));
  const blocked = useModerationStore((s) => s.blockedPubkeys.includes(pubkey));
  const toggleMute = useModerationStore((s) => s.toggleMute);
  const toggleBlock = useModerationStore((s) => s.toggleBlock);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return;
    const panel = panelRef.current;
    const place = () => {
      const left = anchor.x + panel.offsetWidth + 12 <= window.innerWidth
        ? anchor.x + 12
        : Math.max(12, anchor.x - panel.offsetWidth - 12);
      const bottomEdge = window.innerHeight - 88;
      const top = anchor.y + panel.offsetHeight + 8 <= bottomEdge
        ? anchor.y + 8
        : Math.max(12, anchor.y - panel.offsetHeight - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(panel);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  let npub = '';
  try { npub = hexToNpub(pubkey); } catch {}
  const safeFallback = npub ? formatPubkey(pubkey) : pubkey;
  const displayName = member?.displayName || safeFallback;
  const npubShort = npub ? shortNpub(pubkey) : pubkey;
  const baseRole = member?.role ? BASE_ROLE_LABEL[member.role] : undefined;
  return (
    <div
      className={`fixed inset-0 z-[100] flex p-4 ${anchor ? 'items-start justify-start bg-transparent' : 'items-center justify-center bg-black/60'}`}
      onClick={onClose}
      data-testid="profile-popover-backdrop"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto bg-lc-dark border border-lc-border rounded-xl shadow-2xl"
        style={anchor ? { position: 'fixed', maxHeight: 'calc(100dvh - 24px)' } : undefined}
        data-testid="profile-popover"
        role="dialog"
      >
        {/* Banner */}
        <div
          className="h-20 w-full bg-gradient-to-br from-lc-olive to-lc-black rounded-t-xl"
          style={
            member?.banner
              ? { backgroundImage: `url(${member.banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : undefined
          }
          data-testid="profile-banner"
        />

        {/* Avatar (overlaps banner) */}
        <div className="relative px-4">
          <div className="absolute -top-10 left-4">
            <UserAvatar
              pubkey={pubkey}
              picture={member?.picture ?? null}
              size={20}
              name={displayName || '?'}
              alt={displayName}
              className="border-4 border-lc-dark"
              initialClassName="text-2xl"
            />
          </div>
        </div>

        <div className="pt-12 pb-4 px-4 space-y-3">
          {/* Name + handle */}
          <div>
            <h3 className="text-lg font-semibold text-lc-white break-words flex items-center gap-2" data-testid="profile-name">
              <span>{renderWithEmojis(displayName, serverEmojis)}</span>
              <WotBadge pubkey={pubkey} />
            </h3>
            <div className="text-xs text-lc-muted break-all" data-testid="profile-handle">
              {member?.nip05 || npubShort}
            </div>
          </div>

          {/* About */}
          {member?.about && (
            <p className="text-sm text-lc-white/80 whitespace-pre-wrap break-words" data-testid="profile-about">
              {renderWithEmojis(member.about, serverEmojis)}
            </p>
          )}

          {/* Roles */}
          {baseRole && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-lc-muted font-semibold mb-1.5">Roles</div>
              <div className="flex flex-wrap gap-1.5" data-testid="profile-roles">
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border"
                  style={{ borderColor: baseRole.color, color: baseRole.color }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: baseRole.color }} />
                  {baseRole.label}
                </span>
              </div>
            </div>
          )}

          {/* Contact / links */}
          {(member?.website || member?.lud16) && (
            <div className="space-y-1.5" data-testid="profile-links">
              {member?.website && (
                <a
                  href={/^https?:\/\//i.test(member.website) ? member.website : `https://${member.website}`}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="flex items-center gap-2 text-xs text-lc-green hover:underline break-all"
                  data-testid="profile-website"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                  {member.website.replace(/^https?:\/\//i, '')}
                </a>
              )}
              {member?.lud16 && (
                <div
                  className="flex items-center gap-2 text-xs text-lc-white/80 break-all"
                  data-testid="profile-lud16"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-lc-green">
                    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
                  </svg>
                  {member.lud16}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="pt-3 border-t border-lc-border space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onExplore(pubkey);
                }}
                className="lc-pill-primary flex-1 text-xs"
                data-testid="profile-explore-btn"
              >
                {t('profileFeed.explore')}
              </button>
              {onMessage && !isSelf && (
                <button
                  type="button"
                  className="lc-pill-secondary flex-1 text-xs"
                  onClick={() => {
                    onClose();
                    onMessage(pubkey);
                  }}
                  data-testid="profile-message-btn"
                >
                  {t('mobile.profile.message')}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const channelId = useChatStore.getState().activeChannelId;
                  if (!channelId) return;
                  window.dispatchEvent(new CustomEvent('obelisk:zap-prefill', {
                    detail: { pubkey, displayName },
                  }));
                  onClose();
                }}
                className="lc-pill-primary text-xs flex-1"
                data-testid="profile-zap-btn"
              >
                ⚡ Zapear
              </button>
              {npub && (
                <>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(npub).catch(() => {});
                      useToastStore.getState().pushToast({
                        title: 'npub copiado',
                        body: `${npub.slice(0, 12)}…${npub.slice(-6)}`,
                      });
                    }}
                    className="lc-pill-secondary flex items-center gap-1.5 text-xs"
                    title={t('profileFeed.copyNpub')}
                    data-testid="profile-copy-npub-btn"
                  >
                    <span className="font-mono">…{npub.slice(-8)}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>
                  </button>
                </>
              )}
            </div>
            {!isSelf && (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const nowMuted = toggleMute(pubkey);
                    useToastStore.getState().pushToast({
                      title: nowMuted ? 'Usuario silenciado' : 'Silencio quitado',
                      body: nowMuted
                        ? `Ya no verás notificaciones de ${displayName}`
                        : `Volverás a recibir notificaciones de ${displayName}`,
                    });
                  }}
                  className={`text-xs flex-1 px-3 py-1.5 rounded-full border transition-colors ${
                    muted
                      ? 'border-lc-green/60 text-lc-green bg-lc-green/10 hover:bg-lc-green/20'
                      : 'border-lc-border text-lc-muted hover:text-lc-white hover:border-lc-white/40'
                  }`}
                  data-testid="profile-mute-btn"
                  title="Silenciar notificaciones de este usuario (solo en este dispositivo)"
                >
                  {muted ? '🔕 Silenciado' : '🔕 Silenciar'}
                </button>
                <button
                  onClick={() => {
                    if (!blocked && !window.confirm(`¿Bloquear a ${displayName}? Sus mensajes quedarán ocultos en este dispositivo.`)) {
                      return;
                    }
                    const nowBlocked = toggleBlock(pubkey);
                    useToastStore.getState().pushToast({
                      title: nowBlocked ? 'Usuario bloqueado' : 'Bloqueo quitado',
                      body: nowBlocked
                        ? `Los mensajes de ${displayName} quedarán ocultos`
                        : `Volverás a ver los mensajes de ${displayName}`,
                    });
                    if (nowBlocked) onClose();
                  }}
                  className={`text-xs flex-1 px-3 py-1.5 rounded-full border transition-colors ${
                    blocked
                      ? 'border-red-500/60 text-red-400 bg-red-500/10 hover:bg-red-500/20'
                      : 'border-lc-border text-lc-muted hover:text-red-400 hover:border-red-500/40'
                  }`}
                  data-testid="profile-block-btn"
                  title="Ocultar los mensajes de este usuario (solo en este dispositivo)"
                >
                  {blocked ? '🚫 Bloqueado' : '🚫 Bloquear'}
                </button>
              </div>
            )}
            {!isSelf && (muted || blocked) && (
              <p className="text-[10px] text-lc-muted leading-snug">
                {blocked
                  ? 'Bloqueo local: oculta los mensajes de este usuario solo en este dispositivo. El usuario no recibe notificación.'
                  : 'Silencio local: suprime menciones y notificaciones solo en este dispositivo.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
