'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  nostrActions,
  useIsLoggedIn,
  useIsRehydrating,
  useConnectionState,
  useCurrentRelayUrl,
  useConfiguredRelays,
  useGroups,
  useGroupById,
  useMessages,
  useMessagesStatus,
  useGroupMetadataEose,
  useLoadEarlier,
  useReactions,
  useChildrenByParent,
  useAdminsByGroup,
  useMembersByGroup,
  useGroupCreators,
  useActiveCall,
  useDirectMessages,
  useAdmins,
  useMembers,
  useMembershipReady,
  useGroupCreator,
  useMyMutes,
  useRelayAccess,
  useMyLoginMethod,
  useMyPubkey,
  useUserMetadata as useProfile,
  type JsGroup,
  type JsForumTag,
  type JsMessage,
  type JsUserMetadata,
} from '@/lib/nostr-bridge';
import { getBridge, getBridgeImpl, getBridgeSync } from '@/lib/nostr-bridge';
import { initializeWot, useWotEnabled, wotEngine } from '@/lib/wot';
import { wotColorClass } from '@/lib/wot/colors';
import { faviconFor, fetchRelayInfo } from '@/lib/relay-info';
import ServerRail from './ServerRail';
import DMList from './DMList';
import { DMOptInBoundary } from './DMOptInGate';
import LoginModal from './LoginModal';
import ShootingStars from '@/components/ShootingStars';
import UserPanel from './UserPanel';
import SearchBar from './SearchBar';
import MessageContent from '@/components/chat/MessageContent';
import NostrProfile from '@/components/chat/NostrProfile';
import ProfilePopover from '@/components/chat/ProfilePopover';
import { MentionText } from '@/components/chat/MentionText';
import MentionNavigator from '@/components/chat/MentionNavigator';
import HistoryPaginationStatus from '@/components/chat/HistoryPaginationStatus';
import MemberList from '@/components/chat/MemberList';
import RelayAdminPanel from '@/components/admin/RelayAdminPanel';
import VoiceRoom from '@/components/voice/VoiceRoom';
import ForumView from '@/components/chat/ForumView';
import VoiceStatusBar from '@/components/voice/VoiceStatusBar';
import BackgroundVoiceAudio from '@/components/voice/BackgroundVoiceAudio';
import { useVoiceStore } from '@/store/voice';
import { useReadStateStore, type InboxEvent } from '@/store/read-state';
import { useInboxUnreadCount, useChannelHighlights, useCachedChannelHighlights } from '@/lib/read-state/selectors';
import { subscribeVoiceJump } from '@/lib/voice/jump-to-voice';
import { useVoiceChatPane } from '@/hooks/chat/useVoiceChatPane';
import { useChatStore } from '@/store/chat';
import { useDMStore } from '@/store/dm';
import type { MemberInfo } from '@/lib/mentions';
import { useToastStore } from '@/store/toast';
import EmojiPicker from '@/components/chat/EmojiPicker';
import MessageMediaPicker, { type MediaPickerTab } from '@/components/chat/MessageMediaPicker';
import { AttachmentMenu, FileDropZone, StickerIcon, VoiceNoteButton, VoiceNoteDraft } from '@/components/chat/ComposerActions';
import { useMessageZaps, type MessageZapTotal } from '@/hooks/chat/useMessageZaps';
import { useMessageZapStore } from '@/store/messageZap';
import MessageZapModal from '@/components/chat/MessageZapModal';
import ModalShell from '@/components/ModalShell';
import { parseZapCommand } from '@/lib/wallet/parse-zap-command';
import MentionAutocomplete from '@/components/chat/MentionAutocomplete';
import SlashCommandAutocomplete, { SLASH_COMMANDS, type SlashCommand } from '@/components/chat/SlashCommandAutocomplete';
import SlashCommandScaffold, { scaffoldMentionSlotQuery, scaffoldMentionSlotRange } from '@/components/chat/SlashCommandScaffold';
import { applyMentionToDraft, filterMembers, relayMentionCandidates } from '@/lib/mentions';
import { npubToHex } from '@nostr-wot/data';
import {
  applyLayout,
  relayOperatorAuthors,
  useChannelLayout,
  useRelayOperatorPubkey,
  type ChannelLayout,
} from '@/lib/channel-layout';
import { useChannelLayoutEditor } from '@/hooks/useChannelLayoutEditor';
import {
  useRelayBranding,
  publishBranding,
  type RelayBranding,
} from '@/lib/relay-branding';
import {
  useRelayEmojiSet,
  relayEmojiMap,
} from '@/lib/relay-emojis';
import {
  emojiTagsForContent,
  mergeCustomEmojiMaps,
  type CustomEmojiMap,
} from '@/lib/custom-emoji-tags';
import { groupReactions, resolveReactionEmoji } from '@/lib/emoji-shortcodes';
import { channelScrollPositionKey } from '@/lib/channel-scroll-position';
import { channelInitialAnchorFromCursor } from '@/lib/channel-scroll-anchor';
import { useChannelScrollPosition } from '@/hooks/chat/useChannelScrollPosition';
import RelayEmojiAdminModal from '@/components/admin/RelayEmojiAdminModal';
import BlossomImageInput, { ChannelAppearanceInput } from '@/components/BlossomImageInput';
import { extractUrls, isImageUrl } from '@/lib/markdown';
import { stickerTagsForContent, type MessageSticker } from '@/lib/sticker-tags';
import { voiceNoteTagForContent, type MessageVoiceNote } from '@/lib/voice-note-tags';
import { useTranslation } from '@/i18n/context';

type View =
  | { kind: 'group'; groupId: string }
  | { kind: 'dm'; peer: string | null }
  | { kind: 'empty' };

const SIDEBAR_KEY = 'obelisk-dex/sidebar-width';
const PROFILE_PANE_KEY = 'obelisk-dex/profile-pane-width';
const SHOW_MEMBERS_KEY = 'obelisk-dex/show-members';

export default function AppShell() {
  const { t } = useTranslation();
  const isLoggedIn = useIsLoggedIn();
  const isRehydrating = useIsRehydrating();
  const conn = useConnectionState();
  const relay = useCurrentRelayUrl();
  const profilePopupPubkey = useChatStore((state) => state.profilePopupPubkey);
  const closeProfilePopup = useChatStore((state) => state.closeProfilePopup);
  const [exploredProfilePubkey, setExploredProfilePubkey] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // useLayoutEffect (not useEffect): we need the bridge's setActiveGroup
  // to run BEFORE the browser paints. If it runs in useEffect, the chat
  // panel renders once with the stale per-group status (e.g.
  // 'empty-confirmed' from a previous visit) BEFORE the bridge restarts
  // the sub and flips status to 'loading' — the user sees a one-frame
  // flash of "No messages yet" → spinner. useLayoutEffect schedules the
  // state change before paint so only the final state ('loading') hits
  // the screen. Using `getBridgeSync` keeps the call truly synchronous —
  // the async `nostrActions.setActiveGroup` indirection would defer the
  // status flip to a microtask, after the first paint had already
  // landed.
  useLayoutEffect(() => {
    const bridge = getBridgeSync();
    if (view.kind === 'group') {
      bridge?.setActiveGroup(view.groupId);
      // Mirror into the chat store so `isUserWatchingChannel` returns true
      // here too. Without this, desktop's read-state machinery is silently
      // disabled (the gate stays false → cursor never advances → unread
      // counts never clear). Mobile sets these in `selectGroup`; desktop
      // routes through `setView` instead, so we mirror in the same effect.
      useChatStore.setState({ activeChannelId: view.groupId });
    } else {
      bridge?.setActiveGroup(null);
      useChatStore.setState({ activeChannelId: null });
    }
  }, [view]);

  // Probe the nostr-wot extension on mount (and on visibility change). Without
  // this the engine stays disabled until the user opens the Preferences tab,
  // so a persisted "WoT on" toggle wouldn't take effect on cold load.
  useEffect(() => {
    initializeWot();
  }, []);

  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);

  // Deep-link: ?c=<groupId>[&m=<messageId>][&relay=<host>] auto-selects a
  // channel on first render, switches to the requested relay, and (when m is
  // present) scrolls/flashes the target message. We also accept ';' as a
  // separator so URLs typed casually as `?c=X;relay=Y` still parse.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const search = window.location.search.replace(/;/g, '&');
    const params = new URLSearchParams(search);
    const c = params.get('c');
    const m = params.get('m');
    const r = params.get('relay');
    if (r) {
      const wss = /^wss?:\/\//.test(r) ? r : `wss://${r}`;
      const cur = (relay || '').replace(/\/+$/, '').toLowerCase();
      const next = wss.replace(/\/+$/, '').toLowerCase();
      if (next !== cur) {
        void nostrActions.switchRelay(wss).catch((err) => {
          console.warn('[appshell] switchRelay from deep-link failed', err);
        });
      }
    }
    if (c) setView({ kind: 'group', groupId: c });
    if (m) setPendingMessageId(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in sync with the active group + relay so refresh / share works.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (view.kind === 'group') url.searchParams.set('c', view.groupId);
    else url.searchParams.delete('c');
    if (relay) url.searchParams.set('relay', shortHost(relay));
    else url.searchParams.delete('relay');
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [view, relay]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 264;
    const v = window.localStorage.getItem(SIDEBAR_KEY);
    const n = v ? parseInt(v, 10) : 264;
    return Number.isFinite(n) ? Math.max(200, Math.min(500, n)) : 264;
  });
  const [showMembers, setShowMembers] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = window.localStorage.getItem(SHOW_MEMBERS_KEY);
    return v === null ? true : v === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SHOW_MEMBERS_KEY, showMembers ? '1' : '0');
  }, [showMembers]);

  // Voice status bar "jump back to call" → switch relay if the call lives
  // on a different one (so `useGroups()` resolves the channel before we set
  // the view), then set the view to the call's channel. Cross-relay jumps
  // currently tear down voice signaling because the bridge pool resets on
  // switchRelay — tracked in docs/sfu-known-bugs.md.
  useEffect(() => {
    return subscribeVoiceJump(async ({ channelId, relayUrl }) => {
      if (relayUrl && relayUrl !== relay) {
        try { await nostrActions.switchRelay(relayUrl); }
        catch (err) { console.warn('[appshell] switchRelay for voice jump failed', err); }
      }
      setView({ kind: 'group', groupId: channelId });
      setSidebarOpen(false);
    });
  }, [relay]);

  if (!isLoggedIn) {
    // A stored session is being reconnected (cold load → relay handshake +
    // optional NIP-46 bunker pre-warm). Show a connecting screen instead of
    // the LoginModal so the user isn't told they're logged out when they're
    // not. See `useIsRehydrating` and docs/data-system.md §3.
    if (isRehydrating) return <RehydratingScreen />;
    // Defer LoginModal until after mount: the underlying nui Modal portal +
    // a NIP-07 extension that injects DOM before React hydrates produce a
    // server/client mismatch on the modal-overlay div. Rendering a no-op
    // placeholder for the first paint sidesteps the hydration warning.
    if (!mounted) return null;
    return (
      <>
        {/* Animated backdrop — matrix grid + shooting stars + green corner
            glows. Sits behind the SDK modal (z-index 0; modal portal is at
            9999). The la-crypta overlay is dimmed in globals.css so the
            animation bleeds through around the centered card. */}
        <div className="lc-login-backdrop" aria-hidden="true">
          <div className="appearance-bg lc-grid-bg absolute inset-0" />
          <ShootingStars />
        </div>
        <LoginModal />
      </>
    );
  }

  const railMode: { kind: 'dm' } | { kind: 'relay'; url: string } =
    view.kind === 'dm' ? { kind: 'dm' } : { kind: 'relay', url: relay };

  const closeDrawer = () => setSidebarOpen(false);
  const leaveDms = () => {
    setView({ kind: 'empty' });
    closeDrawer();
  };

  return (
    <div
      className="obelisk-desktop-bg flex w-screen flex-col overflow-hidden text-lc-white"
      data-obelisk-app
      style={{ height: '100dvh' }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (!t) return;
        if (t.clientX <= 24 && !sidebarOpen) {
          (e.currentTarget as HTMLElement).dataset.swipeStart = String(t.clientX);
        }
      }}
      onTouchMove={(e) => {
        const start = (e.currentTarget as HTMLElement).dataset.swipeStart;
        if (start === undefined) return;
        const t = e.touches[0];
        if (!t) return;
        if (t.clientX - parseFloat(start) > 50) {
          setSidebarOpen(true);
          delete (e.currentTarget as HTMLElement).dataset.swipeStart;
        }
      }}
      onTouchEnd={(e) => { delete (e.currentTarget as HTMLElement).dataset.swipeStart; }}
    >
      <MessageZapModal />
      <RelayAccessModal />
      <BackgroundVoiceAudio />
      <DirectMessageSubscriptionAnchor />
      <RelayTopBar
        relay={relay}
        onOpenSidebar={() => setSidebarOpen(true)}
        onJumpToChannel={(channelId) => setView({ kind: 'group', groupId: channelId })}
        onJumpToDm={(peer) => setView({ kind: 'dm', peer })}
      />
      <MobileVoiceStatusBar currentView={view} />
      <div className="flex flex-1 overflow-hidden relative min-h-0">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={closeDrawer}
            aria-hidden
          />
        )}
        {/* Sidebar drawer: fixed on mobile, inline on desktop */}
        <div
          className={
            'flex max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl ' +
            'max-md:transform max-md:transition-transform max-md:duration-200 max-md:ease-in-out ' +
            (sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full')
          }
        >
          <ServerRail
            mode={railMode}
            onPickDM={() => { setView({ kind: 'dm', peer: null }); closeDrawer(); }}
            onPickRelay={async (url) => {
              setView({ kind: 'empty' });
              try {
                if (url !== relay) await nostrActions.switchRelay(url);
              } catch (err) {
                console.warn('[appshell] switchRelay from rail failed', err);
              } finally {
                closeDrawer();
              }
            }}
          />
          <ResizablePane storageKey={SIDEBAR_KEY} defaultWidth={264} min={200} max={500} onWidthChange={setSidebarWidth}>
            {view.kind === 'dm' ? (
              <DMOptInBoundary surface="sidebar" secondaryLabel={t('dm.optIn.notNow')} onSecondary={leaveDms}>
                <DMList
                  activePeer={view.peer}
                  onPick={(p) => { setView({ kind: 'dm', peer: p }); closeDrawer(); }}
                />
              </DMOptInBoundary>
            ) : (
              <Sidebar
                relay={relay}
                conn={conn}
                view={view}
                setView={(v) => { setView(v); closeDrawer(); }}
              />
            )}
          </ResizablePane>
        </div>
        <main className="flex flex-1 flex-col overflow-hidden min-w-0 border-t border-r border-lc-border">
          {view.kind === 'group' ? (
            <ChatLayout
              groupId={view.groupId}
              showMembers={exploredProfilePubkey ? false : showMembers}
              onToggleMembers={() => setShowMembers((v) => !v)}
              pendingMessageId={pendingMessageId}
              onConsumePendingMessageId={() => setPendingMessageId(null)}
              onSelectGroup={(gid) => setView({ kind: 'group', groupId: gid })}
            />
          ) : view.kind === 'dm' ? (
            <DMOptInBoundary surface="desktop" secondaryLabel={t('dm.optIn.continueWithout')} onSecondary={leaveDms}>
              <DMPanel peer={view.peer} onPickPeer={(p) => setView({ kind: 'dm', peer: p })} />
            </DMOptInBoundary>
          ) : (
            <EmptyState />
          )}
        </main>
        {exploredProfilePubkey && (
          <ResizablePane storageKey={PROFILE_PANE_KEY} defaultWidth={520} min={340} max={900} side="left">
          <aside className="h-full min-w-0 flex-1 overflow-hidden bg-lc-black" data-testid="desktop-profile-pane">
            <NostrProfile
              pubkey={exploredProfilePubkey}
              onClose={() => setExploredProfilePubkey(null)}
              onMessage={(peer) => {
                setView({ kind: 'dm', peer });
                setExploredProfilePubkey(null);
              }}
            />
          </aside>
          </ResizablePane>
        )}
        {profilePopupPubkey && (
          <ProfilePopover
            pubkey={profilePopupPubkey}
            onClose={closeProfilePopup}
            onExplore={setExploredProfilePubkey}
            onMessage={(peer) => setView({ kind: 'dm', peer })}
          />
        )}
        <FloatingUserPanel sidebarWidth={sidebarWidth} />
      </div>
    </div>
  );
}

function DirectMessageSubscriptionAnchor() {
  useDirectMessages();
  return null;
}

function RehydratingScreen() {
  const { t } = useTranslation();
  return (
    <div
      className="appearance-bg lc-grid-bg fixed inset-0 z-50 flex items-center justify-center bg-lc-black p-4"
      data-testid="rehydrating-screen"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="lc-spinner" />
        <div className="text-sm text-lc-muted">{t('common.reconnecting')}</div>
      </div>
    </div>
  );
}

function FloatingUserPanel({ sidebarWidth }: { sidebarWidth: number }) {
  // Server rail is 72px wide; panel sits 8px from left with 8px right gap to
  // the sidebar's right edge, so it spans the full sidebar+rail width.
  const width = 72 + sidebarWidth - 16;
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-2 z-30 hidden md:flex flex-col gap-2"
      style={{ width: `${width}px` }}
    >
      <div className="pointer-events-auto empty:hidden [&>[data-testid=voice-status-bar]]:!p-0 [&_[data-testid=voice-status-bar]>div]:bg-lc-card/95 [&_[data-testid=voice-status-bar]>div]:shadow-2xl [&_[data-testid=voice-status-bar]>div]:backdrop-blur">
        <VoiceStatusBar />
      </div>
      <div className="pointer-events-auto flex min-h-[3.5rem] items-center rounded-xl border border-lc-border bg-lc-card/95 px-4 shadow-2xl backdrop-blur">
        <SidebarMe />
      </div>
    </div>
  );
}

function RelayTopBar({
  relay,
  onOpenSidebar,
  onJumpToChannel,
  onJumpToDm,
}: {
  relay: string;
  onOpenSidebar?: () => void;
  onJumpToChannel?: (channelId: string) => void;
  onJumpToDm?: (peer: string) => void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<{ name?: string; icon?: string } | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const inboxEvents = useReadStateStore((s) => s.inboxEvents);
  const inboxLastReadAt = useReadStateStore((s) => s.inboxLastReadAt);
  const unreadInboxCount = useInboxUnreadCount();
  const markInboxRead = useReadStateStore((s) => s.advanceInboxRead);
  const markAllAsRead = useReadStateStore((s) => s.markAllAsRead);
  const clearInboxEvents = useReadStateStore((s) => s.clearInboxEvents);
  // Snapshot the bridge's loaded peers + groups at click time so "Mark all
  // read" advances the cursors that drive the tab-title `(N)` badge —
  // otherwise the badge stays stuck on unread chat traffic the user has
  // acknowledged by emptying the inbox. Read imperatively to avoid
  // re-rendering the top bar on every message arrival.
  const handleMarkAllAsRead = () => {
    const impl = getBridgeImpl();
    const peers = impl ? Object.keys(impl.dmsByPeer.get()) : [];
    const groupIds = impl ? Object.keys(impl.messagesByGroup.get()) : [];
    markAllAsRead(peers, groupIds);
  };
  useEffect(() => {
    let alive = true;
    setIconFailed(false);
    fetchRelayInfo(relay).then((r) => {
      if (!alive) return;
      setInfo({ name: r?.name, icon: r?.icon || faviconFor(relay) || undefined });
    });
    return () => {
      alive = false;
    };
  }, [relay]);

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!notifOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-notif-popover]') || t.closest('[data-notif-trigger]')) return;
      setNotifOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotifOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [notifOpen]);

  const handleEventClick = (e: InboxEvent) => {
    if (e.type === 'dm' && onJumpToDm) onJumpToDm(e.senderPubkey);
    else if (e.channelId && onJumpToChannel) onJumpToChannel(e.channelId);
    setNotifOpen(false);
    markInboxRead();
  };

  const displayName = info?.name || shortHost(relay);
  const iconUrl = info?.icon;
  return (
    <div
      className="h-14 md:h-10 shrink-0 px-3"
      style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {onOpenSidebar && (
        <button
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="absolute left-2 top-1/2 -translate-y-1/2 p-3 md:p-1.5 rounded-lg text-lc-muted hover:text-lc-white hover:bg-lc-border/50 transition-colors md:hidden"
        >
          <svg className="w-7 h-7 md:w-5 md:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      )}
      <div className="absolute right-2 md:right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
        <button
          data-notif-trigger
          onClick={() => setNotifOpen((v) => !v)}
          className="relative p-2.5 md:p-1.5 rounded-lg text-lc-muted hover:text-lc-white hover:bg-lc-border/40 transition-colors"
          title={t('common.notifications')}
          aria-label={t('common.notifications')}
        >
          <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
          </svg>
          {unreadInboxCount > 0 && (
            <span className="absolute top-0.5 right-0.5 md:top-0 md:right-0 min-w-[16px] h-[16px] md:min-w-[14px] md:h-[14px] px-1 rounded-full bg-lc-green text-lc-black text-[10px] md:text-[9px] font-bold flex items-center justify-center leading-none">
              {unreadInboxCount > 99 ? '99+' : unreadInboxCount}
            </span>
          )}
        </button>
        <a
          href="/help"
          className="p-2.5 md:p-1.5 rounded-lg text-lc-muted hover:text-lc-white hover:bg-lc-border/40 transition-colors inline-flex"
          title={t('common.help')}
          aria-label={t('common.help')}
        >
          <svg className="w-6 h-6 md:w-4 md:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </a>
      </div>
      {notifOpen && typeof document !== 'undefined' && createPortal(
        <div
          data-notif-popover
          className="fixed right-2 md:right-3 top-[3.75rem] md:top-11 z-[60] w-[min(380px,calc(100vw-1rem))] max-h-[70vh] overflow-hidden rounded-xl border border-lc-border bg-lc-dark shadow-2xl flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-lc-border">
            <span className="text-sm font-semibold text-lc-white">{t('common.notifications')}</span>
            <div className="flex gap-2">
              {inboxEvents.length > 0 && unreadInboxCount > 0 && (
                <button
                  onClick={handleMarkAllAsRead}
                  className="text-xs text-lc-green hover:underline"
                  title={t('desktop.inbox.markReadTitle')}
                >
                  {t('desktop.inbox.markRead')}
                </button>
              )}
              {inboxEvents.length > 0 && (
                <button
                  onClick={clearInboxEvents}
                  className="text-xs text-lc-muted hover:text-lc-white"
                  title={t('common.clear')}
                >
                  {t('common.clear')}
                </button>
              )}
            </div>
          </div>
          <div className="overflow-y-auto flex-1">
            {inboxEvents.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-lc-muted">
                {t('desktop.inbox.caughtUp')}
              </div>
            ) : (
              <ul className="flex flex-col">
                {inboxEvents.map((e) => {
                  const isRead = Date.parse(e.createdAt) <= inboxLastReadAt;
                  return (
                  <li key={e.id}>
                    <button
                      onClick={() => handleEventClick(e)}
                      className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-lc-card/60 transition-colors ${isRead ? '' : 'bg-lc-olive/30'}`}
                    >
                      <span className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${isRead ? 'bg-transparent' : 'bg-lc-green'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs uppercase tracking-wider text-lc-muted font-mono mb-0.5">
                          {e.type === 'dm' ? t('inbox.type.dm') : e.type === 'mention' ? t('desktop.inbox.type.mention') : e.type === 'reply' ? t('desktop.inbox.type.reply') : e.type === 'everyone' ? t('desktop.inbox.type.everyone') : t('inbox.type.message')}
                          <span className="ml-2 text-lc-muted/70 normal-case tracking-normal">{new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {e.preview && (
                          <div className="text-sm text-lc-white truncate"><MentionText content={e.preview} /></div>
                        )}
                      </div>
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
      <div className="flex items-center gap-2 min-w-0 max-w-[55%]">
        {iconUrl && !iconFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={iconUrl}
            alt=""
            onError={() => setIconFailed(true)}
            className="w-7 h-7 md:w-5 md:h-5 rounded-full shrink-0 object-cover"
          />
        ) : (
          <div className="w-7 h-7 md:w-5 md:h-5 rounded-full bg-lc-olive flex items-center justify-center text-lc-green text-xs md:text-[10px] font-bold shrink-0">
            {displayName[0]?.toUpperCase() || 'R'}
          </div>
        )}
        <span className="text-sm md:text-xs font-semibold text-lc-white truncate">{displayName}</span>
      </div>
    </div>
  );
}

// -- Resizable pane -----------------------------------------------------

function ResizablePane({
  storageKey,
  defaultWidth,
  min,
  max,
  side = 'right',
  children,
  onWidthChange,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  side?: 'right' | 'left';
  children: React.ReactNode;
  onWidthChange?: (w: number) => void;
}) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const v = window.localStorage.getItem(storageKey);
    const n = v ? parseInt(v, 10) : defaultWidth;
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : defaultWidth;
  });
  const startRef = useRef<{ x: number; w: number } | null>(null);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    startRef.current = { x: e.clientX, w: width };
    function onMove(ev: MouseEvent) {
      if (!startRef.current) return;
      const delta = ev.clientX - startRef.current.x;
      const next = side === 'right'
        ? startRef.current.w + delta
        : startRef.current.w - delta;
      const clamped = Math.max(min, Math.min(max, next));
      setWidth(clamped);
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.localStorage.setItem(storageKey, String(width));
      startRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(width));
    onWidthChange?.(width);
  }, [storageKey, width, onWidthChange]);

  const handle = (
    <div
      onMouseDown={onMouseDown}
      className="group/handle relative z-20 w-0 cursor-col-resize max-md:hidden"
      title="Drag to resize"
    >
      <div className="absolute inset-y-0 -left-2 right-0 w-4" />
      <div className="pointer-events-none absolute inset-y-0 -left-px w-px bg-lc-green opacity-0 transition-opacity group-hover/handle:opacity-100 group-active/handle:opacity-100" />
    </div>
  );

  return (
    <>
      {side === 'left' && handle}
      <div
        style={{ ['--pane-w' as string]: `${width}px` }}
        className="flex shrink-0 flex-col overflow-hidden bg-lc-dark border-l border-t border-r border-lc-border rounded-tl-xl w-[var(--pane-w)] max-md:w-[min(72vw,300px)]"
      >
        {children}
      </div>
      {side === 'right' && handle}
    </>
  );
}

// -- Login --------------------------------------------------------------

// -- Sidebar ------------------------------------------------------------

function Sidebar({
  relay,
  conn,
  view,
  setView,
}: {
  relay: string;
  conn: string;
  view: View;
  setView: (v: View) => void;
}) {
  const groups = useGroups();
  const childrenByParent = useChildrenByParent();
  const groupsById = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups]);
  const roots = useMemo(
    () => groups.filter((g) => !g.parent || !groupsById[g.parent]),
    [groups, groupsById],
  );
  const myPubkey = useMyPubkey();
  const operatorPubkey = useRelayOperatorPubkey(relay || null);
  // Push the relay operator into the WoT engine so useGroups exempts the
  // operator from filtering on their own relay. Updated whenever the active
  // relay or its NIP-11 advertisement changes.
  useEffect(() => {
    wotEngine.setOperatorPubkeys(operatorPubkey ? [operatorPubkey] : []);
  }, [operatorPubkey]);
  const adminsByGroup = useAdminsByGroup();
  const membersByGroup = useMembersByGroup();
  const creatorsByGroup = useGroupCreators();
  const wotEnabled = useWotEnabled();
  // Re-render the rail when verdicts resolve so channel-name colors update.
  const [, forceWotRerender] = useState(0);
  useEffect(() => {
    if (!wotEnabled) return;
    return wotEngine.on('verdicts-changed', () => forceWotRerender((n) => n + 1));
  }, [wotEnabled]);
  const groupDistanceById = useMemo(() => {
    const out: Record<string, number | null> = {};
    if (!wotEnabled) return out;
    for (const g of groups) {
      const creator = creatorsByGroup[g.id];
      const principals = creator
        ? [creator, ...(adminsByGroup[g.id] ?? []), ...(membersByGroup[g.id] ?? [])]
        : [...(adminsByGroup[g.id] ?? []), ...(membersByGroup[g.id] ?? [])];
      let best: number | null = null;
      for (const pk of principals) {
        const d = wotEngine.getDistance(pk);
        if (d === null) continue;
        if (best === null || d < best) best = d;
      }
      out[g.id] = best;
    }
    return out;
  }, [wotEnabled, groups, creatorsByGroup, adminsByGroup, membersByGroup]);
  // Read-side surface (cached channels from seedCacheForRelay) renders
  // unconditionally — hiding it on AUTH failure made the site feel broken
  // (empty sidebar with no explanation). The RelayAccessBanner above the
  // list explains the situation when access != 'ok'. Write-side actions
  // (CreateGroupSection) and any UI that would let the user act on a
  // channel they can't actually read still gate on `channelsVisible`.
  const relayAccess = useRelayAccess(relay || null);
  const channelsVisible = relayAccess === 'ok';
  // A channel admin must not gain relay-wide settings authority.
  const relayAuthors = useMemo(() => relayOperatorAuthors(operatorPubkey), [operatorPubkey]);
  const layout = useChannelLayout(relay || null, relayAuthors);
  const isRelayOperator = !!myPubkey && myPubkey === operatorPubkey;
  const laidOut = useMemo(
    () => applyLayout(layout, roots.map((g) => g.id)),
    [layout, roots],
  );
  const branding = useRelayBranding(relay || null, relayAuthors);
  const emojiSet = useRelayEmojiSet(relay || null, relayAuthors);
  const setServerEmojis = useChatStore((s) => s.setServerEmojis);
  useEffect(() => {
    setServerEmojis(relayEmojiMap(emojiSet));
  }, [emojiSet, setServerEmojis]);
  // 1500ms grace period for the title — keeps a skeleton in place while
  // we wait for branding. If nothing arrives by then, fall back to the
  // shortHost() label so the user isn't staring at shimmer forever.
  const [brandingGraceElapsed, setBrandingGraceElapsed] = useState(branding.updatedAt > 0);
  useEffect(() => {
    if (branding.updatedAt > 0) {
      setBrandingGraceElapsed(true);
      return;
    }
    setBrandingGraceElapsed(false);
    const t = setTimeout(() => setBrandingGraceElapsed(true), 1500);
    return () => clearTimeout(t);
  }, [branding.updatedAt, relay]);
  const brandingLoaded = branding.updatedAt > 0;
  const showTitleSkeleton = !brandingLoaded && !brandingGraceElapsed;
  const groupMetadataEoseGlobal = useGroupMetadataEose();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [brandingOpen, setBrandingOpen] = useState(false);
  const [emojisOpen, setEmojisOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const configuredRelays = useConfiguredRelays();
  // The desktop FloatingUserPanel (SidebarMe pill, plus VoiceStatusBar when a
  // call is active) sits absolutely over the bottom of the channel list. Pad
  // the scroll container so the last channels can be scrolled clear of it.
  const inVoice = useVoiceStore((s) => !!s.currentVoiceChannelId);

  // Creator-admin claim used to live here as a blanket loop that published a
  // kind 9000 ['admin'] for every visible group on every login (gated only by
  // sessionStorage). With 1000 channels that meant 1000 events per device per
  // session, polluting the relay-wide moderation log that other NIP-29 clients
  // render as an activity feed. The claim is now lazy: see the settings-open
  // path further down which calls `nostrActions.claimCreatorAdmin(groupId)`
  // exactly once, only when the local user is the kind 9007 creator and isn't
  // already in 39001.

  const toggleCollapsed = (id: string) =>
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <>
      <div
        className="group relative shrink-0 border-b border-transparent shadow-sm transition-colors hover:border-lc-border"
        data-testid="sidebar-header"
      >
        {/* Banner slot — always present so swapping in the real image
            doesn't shift layout. Three states:
              - branding not loaded yet: lc-banner-placeholder (transparent feel)
              - branding loaded + has banner URL: image fades in
              - branding loaded + no banner URL: nothing rendered (clean) */}
        {!brandingLoaded && (
          <div
            aria-hidden
            data-testid="sidebar-banner-placeholder"
            className="lc-banner-placeholder absolute inset-0 h-full w-full"
          />
        )}
        {brandingLoaded && branding.banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.banner}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {brandingLoaded && branding.banner && (
          <div
            aria-hidden
            className="absolute inset-0 bg-gradient-to-b from-lc-black/85 via-lc-black/40 to-transparent"
          />
        )}
        <div className="relative flex h-14 items-center gap-3 overflow-hidden px-4">
          {!brandingLoaded && (
            <div
              aria-hidden
              data-testid="sidebar-icon-skeleton"
              className="lc-skeleton h-9 w-9 shrink-0 rounded-lg border border-lc-border"
            />
          )}
          {brandingLoaded && branding.icon && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.icon}
              alt=""
              className="h-9 w-9 shrink-0 rounded-lg border border-lc-border bg-lc-black object-cover"
            />
          )}
          <div className="min-w-0 flex-1 truncate text-base font-bold text-lc-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            {showTitleSkeleton ? (
              <span
                aria-hidden
                data-testid="sidebar-title-skeleton"
                className="lc-skeleton inline-block h-4 w-32 align-middle"
              />
            ) : (
              branding.name || shortHost(relay)
            )}
          </div>
          <span
            title={conn}
            aria-label={conn}
            className={
              'inline-block h-2.5 w-2.5 shrink-0 rounded-full ' +
              (conn === 'Connected' ? 'bg-lc-green' : conn === 'Connecting' ? 'bg-yellow-500' : 'bg-red-500')
            }
          />
          {isRelayOperator && (
            <button
              onClick={() => setSettingsOpen(true)}
              title="Server settings"
              aria-label="Server settings"
              className="shrink-0 rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09A1.65 1.65 0 0019.4 15z" />
              </svg>
            </button>
          )}
        </div>
        {/* Banner-height spacer. Reserved while branding is still loading
            so the placeholder occupies the same vertical space the real
            banner would — no layout shift when the image arrives. After
            branding loads we only keep the spacer if there's an actual
            banner URL (kept-clean fallback for branding-without-banner). */}
        {(!brandingLoaded || (brandingLoaded && branding.banner)) && (
          <div aria-hidden className="relative h-24" />
        )}
      </div>

      {channelsVisible && (
        <CreateGroupSection
          count={groups.length}
          onCreated={(id) => setView({ kind: 'group', groupId: id })}
        />
      )}

      <div className={`flex-1 overflow-y-auto px-2 pb-2 ${inVoice ? 'md:pb-52' : 'md:pb-20'}`}>
        {/* Relay/AUTH state lives in the unified bottom-right activity stack. */}
        {groups.length === 0 && channelsVisible && !groupMetadataEoseGlobal && (
          <div
            className="px-2 py-3 flex items-center gap-2 text-xs text-lc-muted"
            data-testid="channels-loading"
          >
            <div className="lc-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            <span>Loading channels…</span>
          </div>
        )}
        {groups.length === 0 && channelsVisible && groupMetadataEoseGlobal && (
          <div
            className="px-2 py-3 text-xs text-lc-muted"
            data-testid="channels-empty"
          >
            No channels on this relay yet.
          </div>
        )}
        {laidOut.categories.map((cat) => (
          <CategorySection
            key={cat.id}
            name={cat.name}
            collapsed={!!collapsed[cat.id]}
            onToggle={() => toggleCollapsed(cat.id)}
            channelCount={cat.channelIds.length}
          >
            {cat.channelIds.map((id) => {
              const g = groupsById[id];
              if (!g) return null;
              return (
                <GroupNode
                  key={id}
                  group={g}
                  depth={0}
                  childrenByParent={childrenByParent}
                  groupsById={groupsById}
                  view={view}
                  onSelect={(gid) => setView({ kind: 'group', groupId: gid })}
                  distanceById={groupDistanceById}
                />
              );
            })}
          </CategorySection>
        ))}
        {laidOut.uncategorized.length > 0 && (
          laidOut.categories.length > 0 ? (
            <CategorySection
              name="Uncategorized"
              collapsed={!!collapsed['__uncat__']}
              onToggle={() => toggleCollapsed('__uncat__')}
              channelCount={laidOut.uncategorized.length}
            >
              {laidOut.uncategorized.map((id) => {
                const g = groupsById[id];
                if (!g) return null;
                return (
                  <GroupNode
                    key={id}
                    group={g}
                    depth={0}
                    childrenByParent={childrenByParent}
                    groupsById={groupsById}
                    view={view}
                    onSelect={(gid) => setView({ kind: 'group', groupId: gid })}
                    distanceById={groupDistanceById}
                  />
                );
              })}
            </CategorySection>
          ) : (
            laidOut.uncategorized.map((id) => {
              const g = groupsById[id];
              if (!g) return null;
              return (
                <GroupNode
                  key={id}
                  group={g}
                  depth={0}
                  childrenByParent={childrenByParent}
                  groupsById={groupsById}
                  view={view}
                  onSelect={(gid) => setView({ kind: 'group', groupId: gid })}
                  distanceById={groupDistanceById}
                />
              );
            })
          )
        )}
      </div>
      {settingsOpen && isRelayOperator && (
        <RelaySettingsModal
          onClose={() => setSettingsOpen(false)}
          onBranding={() => setBrandingOpen(true)}
          onEmojis={() => setEmojisOpen(true)}
          onLayout={() => setLayoutOpen(true)}
          onMembers={() => setAdminPanelOpen(true)}
        />
      )}
      {layoutOpen && relay && isRelayOperator && (
        <ManageLayoutModal
          relayUrl={relay}
          layout={layout}
          channels={roots}
          onClose={() => setLayoutOpen(false)}
        />
      )}
      {brandingOpen && relay && isRelayOperator && (
        <RelayBrandingModal
          relayUrl={relay}
          branding={branding}
          onClose={() => setBrandingOpen(false)}
        />
      )}
      {emojisOpen && relay && isRelayOperator && (
        <RelayEmojiAdminModal
          relayUrl={relay}
          emojiSet={emojiSet}
          configuredRelays={configuredRelays}
          onClose={() => setEmojisOpen(false)}
        />
      )}
      {adminPanelOpen && isRelayOperator && (
        <RelayAdminPanel onClose={() => setAdminPanelOpen(false)} />
      )}

      <div className="shrink-0 border-t border-lc-border bg-lc-card/50 md:hidden">
        <VoiceStatusBar />
        <div className="p-2">
          <SidebarMe />
        </div>
      </div>
    </>
  );
}

function RelaySettingsModal({
  onClose,
  onBranding,
  onEmojis,
  onLayout,
  onMembers,
}: {
  onClose: () => void;
  onBranding: () => void;
  onEmojis: () => void;
  onLayout: () => void;
  onMembers: () => void;
}) {
  const items = [
    ['Server profile & banner', 'Name, icon, banner, and description.', onBranding],
    ['Emojis', 'Custom emoji available across the relay.', onEmojis],
    ['Channels & categories', 'Category names and channel ordering.', onLayout],
    ['Members & roles', 'Review and moderate membership across channels.', onMembers],
  ] as const;

  return (
    <ModalShell onClose={onClose} panelClassName="lc-card w-full max-w-lg mx-4 overflow-hidden bg-lc-dark">
      <header className="flex items-start justify-between border-b border-lc-border px-5 py-4">
        <div>
          <h2 className="text-base font-bold text-lc-white">Server settings</h2>
          <p className="mt-1 text-xs text-lc-muted">Available only to the relay operator.</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white" aria-label="Close">
          ✕
        </button>
      </header>
      <div className="grid gap-2 p-4">
        {items.map(([title, description, action]) => (
          <button
            key={title}
            onClick={() => { onClose(); action(); }}
            className="rounded-lg border border-lc-border p-4 text-left hover:border-lc-green/50 hover:bg-lc-card"
          >
            <span className="block text-sm font-semibold text-lc-white">{title}</span>
            <span className="mt-1 block text-xs text-lc-muted">{description}</span>
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

function CreateGroupSection({ count, onCreated }: { count: number; onCreated: (groupId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await nostrActions.createGroup({ name: name.trim(), isPublic: true, isOpen: true });
      setName('');
      setOpen(false);
      onCreated(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 shrink-0">
      <div className="flex items-center justify-between px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-lc-muted">
        <span className="truncate">Channels · {count}</span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded px-1 text-base leading-none text-lc-muted hover:text-lc-green"
          title={open ? 'Cancel' : 'Create channel'}
          aria-label={open ? 'Cancel' : 'Create channel'}
        >
          {open ? '×' : '+'}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="mb-1 flex flex-col gap-1 px-3 pb-1">
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="channel name"
              className="min-w-0 flex-1 rounded border border-lc-border bg-lc-black px-2 py-1 text-xs text-lc-white outline-none focus:border-lc-green"
            />
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="shrink-0 rounded bg-lc-green px-2 py-1 text-[11px] font-semibold text-lc-black disabled:opacity-50"
            >
              {busy ? '…' : 'Create'}
            </button>
          </div>
          {err && <span className="break-words text-[10px] text-red-400">{err}</span>}
        </form>
      )}
    </div>
  );
}


function GroupNode({
  group,
  depth,
  childrenByParent,
  groupsById,
  view,
  onSelect,
  distanceById,
}: {
  group: JsGroup;
  depth: number;
  childrenByParent: Readonly<Record<string, ReadonlyArray<string>>>;
  groupsById: Record<string, JsGroup>;
  view: View;
  onSelect: (id: string) => void;
  distanceById?: Readonly<Record<string, number | null>>;
}) {
  const childIds = childrenByParent[group.id] ?? [];
  const active = view.kind === 'group' && view.groupId === group.id;
  const myPubkey = useMyPubkey();
  const highlights = useCachedChannelHighlights(group.id, myPubkey);
  // When the user is actively viewing the channel, the auto-mark hook is
  // about to advance the cursor — suppress the badge to avoid a brief
  // count flash. Matches the existing favicon-badge subtraction at
  // useFaviconBadge.ts.
  const showBadges = !active;
  const unread = showBadges ? highlights.unread : 0;
  const mentionsOrReplies = showBadges ? (highlights.mentions + highlights.replies) : 0;
  // Forum containers default to expanded so newly-created threads are
  // immediately visible. Persisted per-group in localStorage so the user's
  // choice survives reloads. Non-forum groups stay always-expanded (no
  // toggle rendered) — collapsing arbitrary nesting isn't part of this UX.
  const isCollapsible = group.kind === 'forum' && childIds.length > 0;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(`obelisk-dex/forum-collapsed/${group.id}`) === '1';
  });
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (typeof window !== 'undefined') {
      const key = `obelisk-dex/forum-collapsed/${group.id}`;
      if (next) window.localStorage.setItem(key, '1');
      else window.localStorage.removeItem(key);
    }
  };
  return (
    <>
      <div
        style={{ paddingLeft: `${0.5 + Math.max(0, depth - 1) * 0.85}rem` }}
        className={
          'flex w-full items-center gap-1 rounded text-left text-base transition ' +
          (active
            ? 'bg-lc-olive text-lc-white'
            : 'text-lc-muted hover:bg-lc-card hover:text-lc-white')
        }
      >
        {depth > 0 && !isCollapsible && <span className="pl-1 text-lc-muted lc-tree-marker">↳</span>}
        <button
          onClick={() => onSelect(group.id)}
          className="flex flex-1 items-center gap-2 truncate px-1 py-1.5 text-left"
        >
          <span className="text-lc-muted">#</span>
          <span
            className={`flex-1 truncate ${unread > 0 ? 'font-semibold text-lc-white' : ''} ${distanceById ? wotColorClass(distanceById[group.id] ?? null) : ''}`}
            title={distanceById && distanceById[group.id] != null ? `WoT ${distanceById[group.id]}°` : undefined}
          >
            {group.name ?? group.id.slice(0, 12)}
          </span>
          {!group.isPublic && <span title="Private" className="text-[10px]">🔒</span>}
          {!group.isOpen && <span title="Closed (invite only)" className="text-[10px]">⊝</span>}
          <ActiveCallBadge groupId={group.id} kind={group.kind} />
          {unread > 0 && (
            <span
              aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
              className="text-xs tabular-nums text-lc-muted"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          {mentionsOrReplies > 0 && (
            <span
              aria-label={`${mentionsOrReplies} mention${mentionsOrReplies === 1 ? '' : 's'} or reply`}
              className="rounded-full bg-lc-green px-1.5 py-px text-[10px] font-bold text-lc-black"
            >
              {mentionsOrReplies > 99 ? '99+' : mentionsOrReplies}
            </span>
          )}
        </button>
        {isCollapsible && (
          <button
            onClick={toggleCollapsed}
            className="flex shrink-0 items-center justify-center px-2 py-1.5 text-lc-white/70 hover:text-lc-green"
            aria-label={collapsed ? 'Expand threads' : 'Collapse threads'}
            title={collapsed ? 'Expand threads' : 'Collapse threads'}
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && (group.kind === 'forum' ? (
        // Forum threads get the Discord-style L-rail treatment: wrap them in
        // .lc-forum-threads so each row's ::before/::after can paint a
        // continuous vertical rail terminating in an L-corner at the last row.
        <div className="lc-forum-threads">
          {childIds.map((cid) => {
            const child = groupsById[cid];
            if (!child) return null;
            // For forum-container children (threads), only render in the
            // sidebar once the thread has ≥ 1 message — empty/aborted threads
            // stay hidden so the sidebar doesn't accumulate noise.
            return (
              <ForumChildGroupNode
                key={cid}
                group={child}
                depth={depth + 1}
                childrenByParent={childrenByParent}
                groupsById={groupsById}
                view={view}
                onSelect={onSelect}
                distanceById={distanceById}
              />
            );
          })}
        </div>
      ) : (
        childIds.map((cid) => {
          const child = groupsById[cid];
          if (!child) return null;
          return (
            <GroupNode
              key={cid}
              group={child}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              groupsById={groupsById}
              view={view}
              onSelect={onSelect}
              distanceById={distanceById}
            />
          );
        })
      ))}
    </>
  );
}

function ForumChildGroupNode(props: {
  group: JsGroup;
  depth: number;
  childrenByParent: Readonly<Record<string, ReadonlyArray<string>>>;
  groupsById: Record<string, JsGroup>;
  view: View;
  onSelect: (id: string) => void;
  distanceById?: Readonly<Record<string, number | null>>;
}) {
  const messages = useMessages(props.group.id);
  if (messages.length === 0) return null;
  return (
    <div className="lc-thread-row">
      <GroupNode {...props} />
    </div>
  );
}

function CategorySection({
  name,
  collapsed,
  onToggle,
  channelCount,
  children,
}: {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  channelCount: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-lc-muted hover:text-lc-white"
      >
        <span className="inline-flex w-4 items-center justify-center">
          <svg
            className={`h-3 w-3 transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
        <span className="truncate">{name}</span>
        <span className="ml-auto text-[10px] font-normal opacity-60">{channelCount}</span>
      </button>
      {!collapsed && <div>{children}</div>}
    </div>
  );
}

function RelayBrandingModal({
  relayUrl,
  branding,
  onClose,
}: {
  relayUrl: string;
  branding: RelayBranding;
  onClose: () => void;
}) {
  const [icon, setIcon] = useState(branding.icon);
  const [banner, setBanner] = useState(branding.banner);
  const [name, setName] = useState(branding.name);
  const [description, setDescription] = useState(branding.description);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await publishBranding(relayUrl, {
        icon: icon.trim(),
        banner: banner.trim(),
        name: name.trim(),
        description: description.trim(),
        updatedAt: Math.floor(Date.now() / 1000),
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      panelClassName="lc-card flex max-h-[90vh] w-full max-w-lg mx-4 flex-col overflow-hidden bg-lc-dark"
    >
        <header className="flex shrink-0 items-center justify-between border-b border-lc-border px-5 py-3">
          <div>
            <div className="text-base font-bold text-lc-white">Relay branding</div>
            <div className="text-[11px] text-lc-muted">Shown to everyone on {shortHost(relayUrl)} · NIP-78 kind 30078</div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <BlossomImageInput
            label="Icon"
            value={icon}
            onChange={setIcon}
            shape="square"
            hint="Square logo shown next to the relay name."
          />
          <BlossomImageInput
            label="Banner"
            value={banner}
            onChange={setBanner}
            shape="wide"
            hint="Wide image shown above the relay name."
          />
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wider text-lc-muted">Display name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={shortHost(relayUrl)}
              className={inputClasses}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs uppercase tracking-wider text-lc-muted">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={inputClasses}
            />
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-lc-border px-5 py-3">
          <button onClick={onClose} className="lc-pill lc-pill-secondary text-xs">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
    </ModalShell>
  );
}

function ManageLayoutModal({
  relayUrl,
  layout,
  channels,
  onClose,
}: {
  relayUrl: string;
  layout: ChannelLayout;
  channels: ReadonlyArray<JsGroup>;
  onClose: () => void;
}) {
  const {
    error: err,
    laidOut,
    newCategoryName: newCatName,
    saving,
    setNewCategoryName: setNewCatName,
    addCategory,
    deleteCategory,
    moveCategory,
    moveChannel,
    renameCategory,
    save,
    setChannelCategory,
  } = useChannelLayoutEditor(relayUrl, layout, channels, onClose);
  const channelsById = useMemo(
    () => Object.fromEntries(channels.map((group) => [group.id, group])),
    [channels],
  );

  return (
    <ModalShell
      onClose={onClose}
      panelClassName="lc-card flex max-h-[90vh] w-full max-w-2xl mx-4 flex-col overflow-hidden bg-lc-dark"
    >
        <header className="flex shrink-0 items-center justify-between border-b border-lc-border px-5 py-3">
          <div>
            <div className="text-base font-bold text-lc-white">Categories &amp; order</div>
            <div className="text-[11px] text-lc-muted">Shared layout for {shortHost(relayUrl)} · operator only · NIP-78 kind 30078</div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Add category */}
          <section className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-lc-muted">New category</div>
            <div className="flex gap-2">
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory();
                  }
                }}
                placeholder="e.g. General, Trading, Voice"
                className={inputClasses + ' flex-1'}
              />
              <button
                type="button"
                onClick={addCategory}
                disabled={!newCatName.trim()}
                className="shrink-0 rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </section>

          {/* Categories list */}
          <section className="space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-lc-muted">Categories</div>
            {laidOut.categories.length === 0 && (
              <div className="rounded-lg border border-dashed border-lc-border p-3 text-center text-xs text-lc-muted">
                No categories yet. Add one above to start organizing.
              </div>
            )}
            {laidOut.categories.map((cat, idx) => (
              <div key={cat.id} className="rounded-xl border border-lc-border bg-lc-black/40 p-3">
                <div className="flex items-center gap-2">
                  <input
                    value={cat.name}
                    onChange={(e) => renameCategory(cat.id, e.target.value)}
                    className="flex-1 rounded-lg border border-lc-border bg-lc-black px-2 py-1 text-sm font-semibold text-lc-white outline-none focus:border-lc-green"
                  />
                  <button
                    type="button"
                    onClick={() => moveCategory(cat.id, -1)}
                    disabled={idx === 0}
                    className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white disabled:opacity-30"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => moveCategory(cat.id, +1)}
                    disabled={idx === laidOut.categories.length - 1}
                    className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white disabled:opacity-30"
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteCategory(cat.id)}
                    className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-lc-card"
                    title="Delete category"
                  >
                    Delete
                  </button>
                </div>
                <div className="mt-2 space-y-1">
                  {cat.channelIds.length === 0 ? (
                    <div className="rounded border border-dashed border-lc-border px-2 py-2 text-center text-[11px] text-lc-muted">
                      Drop channels here using the dropdown below
                    </div>
                  ) : (
                    cat.channelIds.map((id, i) => (
                      <ChannelOrderRow
                        key={id}
                        channel={channelsById[id]}
                        bucket={cat.id}
                        first={i === 0}
                        last={i === cat.channelIds.length - 1}
                        categories={laidOut.categories}
                        onMove={(d) => moveChannel(id, d)}
                        onChangeCategory={(catId) => setChannelCategory(id, catId)}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </section>

          {/* Uncategorized channels */}
          <section className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-lc-muted">
              Uncategorized · {laidOut.uncategorized.length}
            </div>
            <div className="space-y-1">
              {laidOut.uncategorized.length === 0 ? (
                <div className="rounded border border-dashed border-lc-border px-2 py-2 text-center text-[11px] text-lc-muted">
                  All channels are placed in categories.
                </div>
              ) : (
                laidOut.uncategorized.map((id, i) => (
                  <ChannelOrderRow
                    key={id}
                    channel={channelsById[id]}
                    bucket={null}
                    first={i === 0}
                    last={i === laidOut.uncategorized.length - 1}
                    categories={laidOut.categories}
                    onMove={(d) => moveChannel(id, d)}
                    onChangeCategory={(catId) => setChannelCategory(id, catId)}
                  />
                ))
              )}
            </div>
          </section>

          {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-lc-border bg-lc-dark px-5 py-3">
          <div className="text-[11px] text-lc-muted">
            Saved as a single replaceable kind 30078 event signed by you.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-sm font-medium text-lc-muted hover:bg-lc-card hover:text-lc-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
            >
              {saving ? 'Publishing…' : 'Publish layout'}
            </button>
          </div>
        </footer>
    </ModalShell>
  );
}

function ChannelOrderRow({
  channel,
  bucket,
  first,
  last,
  categories,
  onMove,
  onChangeCategory,
}: {
  channel: JsGroup | undefined;
  bucket: string | null;
  first: boolean;
  last: boolean;
  categories: ReadonlyArray<{ id: string; name: string }>;
  onMove: (delta: number) => void;
  onChangeCategory: (catId: string | null) => void;
}) {
  if (!channel) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-lc-border bg-lc-black px-2 py-1.5">
      <span className="text-lc-muted">#</span>
      <span className="flex-1 truncate text-sm text-lc-white">
        {channel.name ?? channel.id.slice(0, 12)}
      </span>
      <select
        value={bucket ?? ''}
        onChange={(e) => onChangeCategory(e.target.value || null)}
        className="rounded border border-lc-border bg-lc-dark px-1.5 py-0.5 text-xs text-lc-white outline-none focus:border-lc-green"
      >
        <option value="">— uncategorized —</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={first}
        className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white disabled:opacity-30"
        title="Move up"
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => onMove(+1)}
        disabled={last}
        className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white disabled:opacity-30"
        title="Move down"
      >
        ▼
      </button>
    </div>
  );
}


export function SidebarMe() {
  const myPubkey = useMyPubkey();
  const meta = useProfile(myPubkey);
  const [editing, setEditing] = useState(false);
  if (!myPubkey) return null;
  return (
    <div className="relative flex w-full items-center gap-2">
      <button
        type="button"
        onClick={(event) => useChatStore.getState().openProfilePopup(myPubkey, { x: event.clientX, y: event.clientY })}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:bg-lc-card/50"
        title="Profile"
        data-testid="sidebar-profile-button"
      >
        <Avatar pubkey={myPubkey} size={8} picture={meta?.picture ?? null} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-lc-white">
            {meta?.displayName || meta?.name || 'You'}
          </div>
          <div className="truncate font-mono text-[10px] text-lc-muted">{myPubkey.slice(0, 16)}…</div>
        </div>
      </button>
      <button
        onClick={() => setEditing(true)}
        className="shrink-0 rounded p-1.5 text-lc-muted hover:bg-lc-card hover:text-lc-white transition-colors"
        title="Settings"
        aria-label="Settings"
        data-testid="user-settings-button"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
      {editing && (
        <UserPanel
          pubkey={myPubkey}
          isMe
          initialEditing
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// -- Chat layout (chat + member list) -----------------------------------

function ChatLayout({
  groupId,
  showMembers,
  onToggleMembers,
  pendingMessageId,
  onConsumePendingMessageId,
  onSelectGroup,
}: {
  groupId: string;
  showMembers: boolean;
  onToggleMembers: () => void;
  pendingMessageId: string | null;
  onConsumePendingMessageId: () => void;
  onSelectGroup: (groupId: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChatPanel
        groupId={groupId}
        showMembers={showMembers}
        onToggleMembers={onToggleMembers}
        pendingMessageId={pendingMessageId}
        onConsumePendingMessageId={onConsumePendingMessageId}
        onSelectGroup={onSelectGroup}
      />
    </div>
  );
}

function ChatPanel({
  groupId,
  showMembers,
  onToggleMembers,
  pendingMessageId,
  onConsumePendingMessageId,
  onSelectGroup,
}: {
  groupId: string;
  showMembers: boolean;
  onToggleMembers: () => void;
  pendingMessageId: string | null;
  onConsumePendingMessageId: () => void;
  onSelectGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const messages = useMessages(groupId);
  // Retry-backed confidence enum — the bridge runs an internal retry
  // ladder on empty EOSE before promoting to `empty-confirmed`, so the
  // UI doesn't need its own dwell timer or auto-refresh effect. See
  // `MessagesStatus` in src/lib/nostr-bridge/types.ts.
  const messagesStatus = useMessagesStatus(groupId);
  const groupMetadataEose = useGroupMetadataEose();
  // Grace window for the *channel-missing* verdict (kind 39000), which
  // still uses the simpler "EOSE + dwell" gate. The bridge owns kind 9
  // confidence directly; this timer only matters for the
  // "Channel not visible on this relay" copy.
  const [channelMissingGrace, setChannelMissingGrace] = useState(false);
  useEffect(() => {
    setChannelMissingGrace(false);
    const t = setTimeout(() => setChannelMissingGrace(true), 5000);
    return () => clearTimeout(t);
  }, [groupId]);
  // Force-fetch kind 39000 for the channel if the bridge doesn't have it
  // yet. Without this the user would stare at "Loading channel info…"
  // for the entire global-metadata stream — or, worse, hit "Channel not
  // visible" if the stream EOSE'd before this specific id arrived. The
  // focused querySync is cheap (limit: 1) and unblocks the chat pane on
  // every navigation, with or without cache.
  //
  // `metadataFetchDone` flips true after the focused query resolves
  // (either way). It gates the final "channel not visible" verdict so
  // we never declare a channel missing until we've actually tried.
  const [metadataFetchDone, setMetadataFetchDone] = useState(false);
  useEffect(() => {
    setMetadataFetchDone(false);
    if (!groupId) {
      setMetadataFetchDone(true);
      return;
    }
    if (group) {
      setMetadataFetchDone(true);
      return;
    }
    let cancelled = false;
    void nostrActions
      .fetchGroupMetadata(groupId)
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setMetadataFetchDone(true);
      });
    return () => {
      cancelled = true;
    };
    // Only re-fire on groupId change. `group` is read for the early-exit
    // — if it arrives mid-fetch, we still flip done on resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);
  const reactions = useReactions(groupId);
  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const zapTotals = useMessageZaps(messageIds);
  // Raw lookup — bypasses WoT filtering. The user explicitly navigated to
  // this groupId; WoT-hiding it would cause a false "Channel not visible"
  // state in the chat pane. The sidebar still uses WoT-filtered
  // `useGroups()` for discovery, but click-through stays accessible.
  const group = useGroupById(groupId);
  const groups = useGroups();
  const admins = useAdmins(groupId);
  const myPubkey = useMyPubkey();
  const isAdmin = !!myPubkey && admins.includes(myPubkey);
  const groupCreator = useGroupCreator(groupId);
  const relay = useCurrentRelayUrl();
  const readCursorMs = useReadStateStore((s) => s.groupCursors[groupId]);
  // The compose form is gated on positive AUTH evidence so the user
  // doesn't type into a channel the relay won't accept events from. The
  // message list itself renders unconditionally — a cached or partial
  // history is more useful than an empty pane, and RelayAccessBanner
  // explains the situation in-place.
  const relayAccess = useRelayAccess(relay || null);
  const messagesVisible = relayAccess === 'ok';
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<JsMessage | null>(null);
  useEffect(() => { setReplyingTo(null); }, [groupId]);

  // Lazy creator-admin claim. The blanket login-time loop that used to
  // publish a kind 9000 ['admin'] for every visible group has been removed.
  // Instead, when the active session opens a channel they themselves
  // created (kind 9007 author == myPubkey) and the relay hasn't already
  // listed them in 39001, fire exactly one kind 9000 ['admin']. The
  // localStorage key persists across sessions so this never re-fires.
  useEffect(() => {
    if (!myPubkey || !groupCreator) return;
    if (groupCreator !== myPubkey) return;
    if (admins.includes(myPubkey)) return;
    // Same gate as the lazy member putUser: don't fire kind 9000 against
    // a relay that's already telling us we can't write. Otherwise the
    // user sees a "Publishing to relays / restricted: not whitelisted"
    // toast every time they open a channel they happen to have created
    // on a different relay.
    if (relayAccess !== 'ok') return;
    const key = `obelisk:claimed-admin:${relay}:${groupId}:${myPubkey}`;
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(key)) return;
      localStorage?.setItem(key, '1');
    } catch {}
    void nostrActions.claimCreatorAdmin(groupId).catch((err) => {
      console.debug('[appshell] claimCreatorAdmin skipped (relay declined)', err);
    });
  }, [groupId, myPubkey, groupCreator, admins, relay, relayAccess]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const voiceMainRef = useRef<HTMLDivElement>(null);
  const scrollKey = useMemo(() => channelScrollPositionKey(relay, groupId), [relay, groupId]);
  const initialAnchor = useMemo(
    () => channelInitialAnchorFromCursor(messages, readCursorMs, myPubkey),
    [messages, myPubkey, readCursorMs],
  );
  const initialAnchorMessageId = initialAnchor.kind === 'message' ? initialAnchor.messageId : null;
  const getInitialAnchorElement = useCallback(() => {
    if (!initialAnchorMessageId) return null;
    const scroller = scrollRef.current;
    if (!scroller) return null;
    const target = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(initialAnchorMessageId)}"]`);
    if (!target || !scroller.contains(target)) return null;
    return target;
  }, [initialAnchorMessageId]);
  const scrollKeyRef = useRef(scrollKey);
  useEffect(() => {
    scrollKeyRef.current = scrollKey;
  }, [scrollKey]);
  // Highlights drive the floating mention/reply navigator at the bottom-right
  // of the message viewport — same data the channel-row badges read.
  const channelHighlights = useChannelHighlights(groupId, myPubkey);
  const [showSettings, setShowSettings] = useState(false);
  const voiceChatOpen = useVoiceStore((s) => s.isVoiceChatOpen);
  const setVoiceChatOpen = useVoiceStore((s) => s.setVoiceChatOpen);
  const { voiceChatWidth, onVoiceChatResize: onResize } = useVoiceChatPane(voiceChatOpen, voiceMainRef);

  // "Stick to bottom" — auto-scroll on new messages only when the user is
  // already near the bottom. Reading mid-history without being yanked down
  // by every incoming message is a basic chat-UX expectation; the previous
  // unconditional `scrollTop = scrollHeight` broke that, and combined with
  // the now-removed messagesVisible unmount it also re-rendered users to
  // the top of the channel on AUTH flicker.
  const stickToBottomRef = useRef(true);
  const setNearBottom = useCallback((near: boolean) => {
    stickToBottomRef.current = near;
    const cur = useChatStore.getState().isNearBottom;
    if (cur !== near) useChatStore.setState({ isNearBottom: near });
  }, []);
  useChannelScrollPosition({
    scrollKey,
    scrollRef,
    itemCount: messages.length,
    disabled: !!pendingMessageId,
    initialAnchorKey: initialAnchorMessageId,
    getInitialAnchorElement,
    nearBottomPx: 100,
    onNearBottomChange: setNearBottom,
  });
  const { loadEarlier, loading: loadingEarlier, reachedStart } = useLoadEarlier(groupId);
  const [nearHistoryTop, setNearHistoryTop] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = dist < 100;
      setNearBottom(near);
      setNearHistoryTop(el.scrollTop < 80);
      // Top-of-list pagination. Anchor by pre-load scrollHeight so the
      // viewport stays on the same message after the older page is
      // prepended instead of snapping to the new top.
      if (el.scrollTop < 80 && !loadingEarlier && !reachedStart) {
        const loadKey = scrollKeyRef.current;
        const prevHeight = el.scrollHeight;
        const prevTop = el.scrollTop;
        void loadEarlier().then((result) => {
          if (result !== 'added') return;
          requestAnimationFrame(() => {
            const e = scrollRef.current;
            if (!e) return;
            if (loadKey && scrollKeyRef.current !== loadKey) return;
            e.scrollTop = e.scrollHeight - prevHeight + prevTop;
          });
        });
      }
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loadEarlier, loadingEarlier, reachedStart, setNearBottom]);
  // New messages: stick to bottom only if the user was already there.
  useEffect(() => {
    if (pendingMessageId) return;
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingMessageId]);

  useEffect(() => {
    if (!pendingMessageId) return;
    const exists = messages.some((m) => m.id === pendingMessageId);
    if (!exists) return; // message not loaded yet — try again on next batch
    const el = document.querySelector(`[data-msg-id="${pendingMessageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-1', 'ring-lc-green');
    setTimeout(() => el.classList.remove('ring-1', 'ring-lc-green'), 1800);
    // Strip ?m= so a refresh doesn't re-trigger.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('m');
      window.history.replaceState(null, '', url.pathname + url.search);
    }
    onConsumePendingMessageId();
  }, [pendingMessageId, messages, onConsumePendingMessageId]);

  // ── @-mention autocomplete ────────────────────────────────────────────
  // Mentions span the whole relay (every visible group's members + admins +
  // creator), not just the current channel — typing `@alice` should find
  // Alice even if she's only in a sister channel. WoT-hidden groups are
  // already excluded by `useGroups` above, so spam-channel rolls don't
  // pollute the autocomplete when WoT is on.
  const inputRef = useRef<HTMLInputElement>(null);
  const memberPubkeys = useMembers(groupId);
  const membersByGroup = useMembersByGroup();
  const adminsByGroup = useAdminsByGroup();
  const creatorsByGroup = useGroupCreators();
  const visibleGroupIds = useMemo(() => groups.map((g) => g.id), [groups]);
  const mentionCandidatePubkeys = useMemo(
    () => relayMentionCandidates(visibleGroupIds, membersByGroup, adminsByGroup, creatorsByGroup),
    [visibleGroupIds, membersByGroup, adminsByGroup, creatorsByGroup],
  );
  const [metaMap, setMetaMap] = useState<Record<string, JsUserMetadata>>({});
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void getBridge().then(() => {
      const impl = getBridgeImpl();
      if (!impl) return;
      unsub = impl.userMetadata.subscribe((m) => setMetaMap(m));
    });
    return () => { unsub?.(); };
  }, []);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const filteredMembers = useMemo(() => {
    if (mentionQuery === null) return [];
    // Materialize MemberInfo[] only when the autocomplete is open. On a
    // busy relay the candidate set can be hundreds of pubkeys, and metaMap
    // updates on every kind:0 ingest — rebuilding eagerly would churn even
    // when no mention is in progress.
    const candidates: MemberInfo[] = mentionCandidatePubkeys.map((pk) => {
      const m = metaMap[pk];
      return {
        pubkey: pk,
        displayName: m?.displayName || m?.name || `${pk.slice(0, 8)}…`,
        picture: m?.picture ?? undefined,
        lud16: m?.lud16 ?? undefined,
      };
    });
    return filterMembers(candidates, mentionQuery).slice(0, 8);
  }, [mentionCandidatePubkeys, metaMap, mentionQuery]);
  const slashResults = useMemo<SlashCommand[]>(
    () => slashQuery === null ? [] : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery.toLowerCase())),
    [slashQuery],
  );
  const activeSlashCommand = useMemo<SlashCommand | null>(() => {
    const m = /^\/([a-zA-Z]+)(?:\s|$)/.exec(draft);
    if (!m) return null;
    return SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase()) ?? null;
  }, [draft]);
  function detectMention(value: string, cursor: number) {
    setCaret(cursor);
    const sm = /^\/([a-zA-Z]*)$/.exec(value);
    if (sm) {
      setSlashQuery(sm[1]);
      setSlashIndex(0);
      setMentionQuery(null);
      return;
    }
    setSlashQuery(null);
    const m0 = /^\/([a-zA-Z]+)(?:\s|$)/.exec(value);
    const cmd = m0 ? SLASH_COMMANDS.find((c) => c.name === m0[1].toLowerCase()) : null;
    if (cmd) {
      const slot = scaffoldMentionSlotQuery(value, cursor);
      if (slot !== null) {
        setMentionQuery(slot);
        setMentionIndex(0);
        return;
      }
    }
    const before = value.slice(0, cursor);
    const m = before.match(/(?:^|\s)@(\w*)$/);
    if (m) {
      setMentionQuery(m[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }
  function insertSlashCommand(cmd: SlashCommand) {
    const next = `/${cmd.name} `;
    setDraft(next);
    setSlashQuery(null);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }
  function applyMention(member: MemberInfo) {
    const ta = inputRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? draft.length;
    // When the picker is opened by a slash-command slot, replace whatever
    // partial token the user already typed (e.g. `/zap dum` → the `dum`
    // token) instead of appending another mention token after it.
    const slotRange = scaffoldMentionSlotRange(draft, cursor);
    const { next, cursor: nextCursor } = applyMentionToDraft(draft, cursor, member.pubkey, slotRange);
    setDraft(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(nextCursor, nextCursor);
      setCaret(nextCursor);
    });
  }
  function onMentionKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (slashQuery !== null && slashResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashResults.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashResults.length) % slashResults.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertSlashCommand(slashResults[slashIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return; }
    }
    if (mentionQuery === null || filteredMembers.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % filteredMembers.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + filteredMembers.length) % filteredMembers.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(filteredMembers[mentionIndex]); }
    else if (e.key === 'Escape') { e.preventDefault(); setMentionQuery(null); }
  }

  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<MediaPickerTab>('emoji');
  const [draftCustomEmojis, setDraftCustomEmojis] = useState<CustomEmojiMap>({});
  const [draftSticker, setDraftSticker] = useState<MessageSticker | null>(null);
  const [draftVoiceNote, setDraftVoiceNote] = useState<MessageVoiceNote | null>(null);
  const emojiBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!emojiOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (emojiBtnRef.current && !emojiBtnRef.current.contains(e.target as Node)) {
        setEmojiOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [emojiOpen]);
  async function onPickFiles(files: File[]) {
    if (files.length === 0) return;
    setDraftSticker(null);
    setDraftVoiceNote(null);
    // Cap at 4 — matches the gallery's 2x2 matrix renderer.
    const batch = files.slice(0, 4);
    setUploadingMedia(true);
    setSendError(null);
    try {
      const { uploadToBlossom } = await import('@/lib/blossom');
      const urls = await Promise.all(batch.map((f) => uploadToBlossom(f)));
      // Inline-attach: append each Blossom URL on its own line. Renderers
      // detect bare image/video URLs and render them as media (NIP-92-style).
      setDraft((d) => {
        const base = d.trim();
        return base ? `${base}\n${urls.join('\n')}` : urls.join('\n');
      });
    } catch (err) {
      setSendError((err as Error).message || 'Upload failed');
    } finally {
      setUploadingMedia(false);
    }
  }

  async function onVoiceRecorded(file: File, durationSeconds: number) {
    setUploadingMedia(true);
    setSendError(null);
    try {
      const { uploadToBlossom } = await import("@/lib/blossom");
      const url = await uploadToBlossom(file);
      setDraft(url);
      setDraftSticker(null);
      setDraftVoiceNote({ url, durationSeconds });
    } catch (err) {
      setSendError((err as Error).message || "Upload failed");
    } finally {
      setUploadingMedia(false);
    }
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;

    // /zap [user] [amount] — frontend-only.
    //   /zap                → reply target (or last channel msg from someone else)
    //   /zap 100            → same target, with amount preset
    //   /zap <npub|hex|@name> [amount] → target that channel member
    if (/^\/zap(\s|$)/.test(content)) {
      const parsed = parseZapCommand(content, groupId, messages, myPubkey, replyingTo);
      if (!parsed.ok) {
        setSendError(parsed.error);
        return;
      }
      useMessageZapStore.getState().open(parsed.target);
      setDraft('');
      setReplyingTo(null);
      return;
    }

    setSendError(null);
    const replyToCopy = replyingTo ? { id: replyingTo.id, pubkey: replyingTo.pubkey } : null;
    // Open groups use the NIP-29 join request before their first message.
    // Await it so browser extensions never receive two signature requests at once.
    if (
      myPubkey
      && relayAccess === 'ok'
      && group?.isOpen
      && !memberPubkeys.includes(myPubkey)
      && !admins.includes(myPubkey)
    ) {
      try {
        await nostrActions.joinGroup(groupId);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : 'Could not join this channel');
        return;
      }
    }

    // Clear only after the prerequisite signature succeeds, preserving the
    // draft if the user rejects the join request in their extension.
    setDraft('');
    setDraftCustomEmojis({});
    setDraftSticker(null);
    setDraftVoiceNote(null);
    setReplyingTo(null);

    // Fire-and-forget — bridge inserts the pending placeholder synchronously
    // and surfaces send failures via the bubble's `failed` flag (with retry).
    const voiceTag = voiceNoteTagForContent(content, draftVoiceNote);
    const emojiTags = [
      ...emojiTagsForContent(content, mergeCustomEmojiMaps(serverEmojis, draftCustomEmojis)),
      ...stickerTagsForContent(content, draftSticker).filter((tag) => tag[0] === 'sticker'),
      ...(voiceTag ? [voiceTag] : []),
    ];
    nostrActions.sendMessage(groupId, content, replyToCopy, emojiTags).catch((err) => {
      console.error('send failed', err);
    });
  }

  return (
    <FileDropZone
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      disabled={uploadingMedia}
      onFiles={(files) => void onPickFiles(files)}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-lc-border bg-lc-dark px-5 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-xl text-lc-muted">#</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-bold text-lc-white">
                {group?.name ?? groupId.slice(0, 12)}
              </span>
              {isAdmin && (
                <span className="rounded-full bg-lc-green/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-lc-green">
                  Admin
                </span>
              )}
            </div>
            {group?.about && <div className="truncate text-xs text-lc-muted">{group.about}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-md p-2 text-lc-muted hover:bg-lc-card hover:text-lc-white"
              title={t('desktop.channel.settings')}
              aria-label={t('desktop.channel.settings')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          )}
          <button
            onClick={onToggleMembers}
            className={
              'rounded-md p-2 hover:bg-lc-card ' +
              (showMembers ? 'text-lc-green' : 'text-lc-muted hover:text-lc-white')
            }
            title={showMembers ? t('desktop.channel.hideMembers') : t('desktop.channel.showMembers')}
            aria-label={showMembers ? t('desktop.channel.hideMembers') : t('desktop.channel.showMembers')}
            aria-pressed={showMembers}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          <CopyInviteLinkButton groupId={groupId} />
          <SearchBar
            serverName={group?.name ?? t('common.channel')}
            activeGroupId={groupId}
          />
        </div>
      </header>
      {/* Channel banner intentionally hidden — re-enable once we have a proper layout. */}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
      {(() => {
        const textBody = (
      <>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4" data-testid={messagesVisible ? undefined : 'messages-gated-by-auth'}>
        {messages.length === 0 ? (
          // Three distinct empty states. Without the status-gated split, a
          // freshly-opened channel briefly renders "No messages yet" while
          // history is still streaming — confusing for an active relay.
          //   1. group missing + 39000 EOSE not yet:                          loading
          //   2. group missing + 39000 EOSE + missing-grace passed:           not visible
          //   3. group present + status === 'loading' | 'empty-unconfirmed':  loading
          //   4. group present + status === 'empty-confirmed':                welcome
          (() => {
            // Trust the bridge's confidence enum: it has already run a
            // retry ladder against auth-gated / silent-filtering relays
            // before reaching `empty-confirmed`. No UI dwell timer
            // needed on this branch.
            const groupKnownEmpty = group && messagesStatus === 'empty-confirmed';
            // Never declare a channel "missing" until the focused
            // metadataFetch has had its chance, AND the global stream has
            // EOSE'd, AND the missing-grace window has passed. Three
            // gates so the user never sees "not visible" on a channel
            // the relay still hasn't been asked about properly.
            const channelKnownMissing =
              !group && groupMetadataEose && channelMissingGrace && metadataFetchDone;
            if (!groupKnownEmpty && !channelKnownMissing) {
              // Split the copy by which tier we're still waiting on:
              //   - !group → kind 39000 hasn't ingested this groupId yet
              //   - group && status !== 'empty-confirmed' → kind 9 still
              //     loading or in the retry ladder
              const stage = !group ? t('desktop.channel.loadingInfo') : t('desktop.channel.loadingMessages');
              return (
                <div
                  className="flex h-full items-center justify-center text-sm text-lc-muted"
                  data-testid="messages-loading"
                  data-stage={!group ? 'channel-info' : 'messages'}
                >
                  <div className="flex flex-col items-center gap-3">
                    <div className="lc-spinner" aria-hidden="true" />
                    <div>{stage}</div>
                  </div>
                </div>
              );
            }
            return (
              <div className="flex h-full items-center justify-center text-sm text-lc-muted">
                <div className="max-w-md text-center">
                  {group ? (
                    <>
                      <div className="text-base font-medium text-lc-white">
                        {t('desktop.channel.welcome').replace('{name}', group.name ?? t('common.channel'))}
                      </div>
                      <div className="mt-1">{t('desktop.channel.noMessages')}</div>
                    </>
                  ) : (
                    <>
                      <div className="text-base font-medium text-lc-white">
                        {t('desktop.channel.notVisible')}
                      </div>
                      <div className="mt-1">
                        {t('desktop.channel.notVisibleDescription').replace('{id}', `${groupId.slice(0, 16)}...`)}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          <>
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped =
                prev && prev.pubkey === m.pubkey && m.createdAt - prev.createdAt < 300;
              return (
                <MessageRow
                  key={m.id}
                  msg={m}
                  allMessages={messages}
                  reactions={reactions[m.id] ?? []}
                  zapTotal={zapTotals.get(m.id) ?? null}
                  groupId={groupId}
                  grouped={!!grouped}
                  isAdmin={isAdmin}
                  onReply={setReplyingTo}
                />
              );
            })}
          </>
        )}
      </div>
      {messages.length > 0 && (
        <HistoryPaginationStatus
          loading={loadingEarlier}
          reachedStart={reachedStart}
          atTop={nearHistoryTop}
          loadingLabel={t('desktop.channel.loadingEarlier')}
          endLabel={t('desktop.channel.noEarlierMessages')}
        />
      )}
      <MentionNavigator scrollRef={scrollRef} eventIds={channelHighlights.eventIds} />
      </div>

      <form onSubmit={onSend} className="shrink-0 px-5 pt-3 pb-3">
        {replyingTo && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-t-md border border-b-0 border-lc-border bg-lc-card/60 px-3 py-1.5 text-xs text-lc-muted">
            <span className="truncate">
              {t('desktop.composer.replyingTo')} <ReplyAuthorName pubkey={replyingTo.pubkey} />
              <span className="ml-2 truncate text-lc-muted"><MentionText content={replyingTo.content.slice(0, 80)} /></span>
            </span>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="text-lc-muted hover:text-lc-white"
              aria-label={t('desktop.composer.cancelReply')}
            >
              ✕
            </button>
          </div>
        )}
        {sendError && (
          <p className="mb-2 break-words text-xs text-red-400">{sendError}</p>
        )}
        {activeSlashCommand && (
          <SlashCommandScaffold command={activeSlashCommand} content={draft} caret={caret} />
        )}
        {(() => {
          const pendingImages = extractUrls(draft).filter(isImageUrl).slice(0, 4);
          if (pendingImages.length === 0 && !uploadingMedia) return null;
          const removeUrl = (url: string) => {
            setDraft((d) =>
              d
                .split('\n')
                .filter((line) => line.trim() !== url)
                .join('\n')
                .replace(/\n{3,}/g, '\n\n'),
            );
          };
          return (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-lc-border bg-lc-card/50 p-2">
              {pendingImages.map((url) => (
                <div key={url} className="group relative h-16 w-16 overflow-hidden rounded-lg bg-lc-black">
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeUrl(url)}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] text-lc-white opacity-90 hover:bg-black"
                    aria-label={t('desktop.composer.removeAttachment')}
                  >
                    ×
                  </button>
                </div>
              ))}
              {uploadingMedia && (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-lc-border text-[10px] uppercase tracking-wider text-lc-muted">
                  …
                </div>
              )}
            </div>
          );
        })()}
        <div className="flex min-h-[3.5rem] items-center gap-1 rounded-xl border border-lc-border bg-lc-card px-2 focus-within:border-lc-green">
          {!draftVoiceNote && (<>
          <AttachmentMenu
            disabled={uploadingMedia}
            onFiles={(files) => void onPickFiles(files)}
            onContact={(value) => {
              setDraftSticker(null);
              setDraftVoiceNote(null);
              setDraft((current) => current + (current ? ' ' : '') + 'nostr:' + value);
            }}
            onNewSticker={() => { setPickerTab("sticker"); setEmojiOpen(true); }}
          />
          <div ref={emojiBtnRef} className="relative">
            <button
              type="button"
              onClick={() => { setPickerTab("emoji"); setEmojiOpen((value) => !value); }}
              className="flex h-9 w-9 items-center justify-center rounded-full text-lc-muted hover:bg-white/5 hover:text-lc-white"
              aria-label="Open emoji, GIF, and sticker picker"
              aria-haspopup="dialog"
              aria-expanded={emojiOpen}
            >
              <StickerIcon />
            </button>
            {emojiOpen && (
              <MessageMediaPicker
                initialTab={pickerTab}
                customEmojis={mergeCustomEmojiMaps(serverEmojis, draftCustomEmojis)}
                onPick={(emoji, custom, kind) => {
                  if (kind === 'sticker') setDraft(emoji);
                  else if (kind === 'gif') setDraft((current) => current.trim() ? [current.trim(), emoji].join(String.fromCharCode(10)) : emoji);
                  else setDraft((current) => current + emoji);
                  setDraftSticker(kind === 'sticker' && custom ? custom : null);
                  setDraftVoiceNote(null);
                  if (custom) setDraftCustomEmojis((current) => ({ ...current, [custom.name]: custom.url }));
                  setEmojiOpen(false);
                  inputRef.current?.focus();
                }}
                onClose={() => setEmojiOpen(false)}
              />
            )}
          </div>
          </>)}
          <div className="relative flex-1">
            {slashQuery !== null && slashResults.length > 0 && (
              <SlashCommandAutocomplete
                commands={slashResults}
                selectedIndex={slashIndex}
                onSelect={insertSlashCommand}
                onClose={() => setSlashQuery(null)}
              />
            )}
            {mentionQuery !== null && filteredMembers.length > 0 && (
              <MentionAutocomplete
                members={filteredMembers}
                selectedIndex={mentionIndex}
                onSelect={applyMention}
                onHover={setMentionIndex}
                onClose={() => setMentionQuery(null)}
              />
            )}
            {draftVoiceNote && (
              <VoiceNoteDraft
                note={draftVoiceNote}
                onDiscard={() => { setDraft(''); setDraftVoiceNote(null); }}
              />
            )}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftSticker(null);
                setDraftVoiceNote(null);
                detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onMentionKeyDown}
              onSelect={(e) => {
                const t = e.currentTarget;
                detectMention(t.value, t.selectionStart ?? t.value.length);
              }}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData?.items ?? []);
                const files: File[] = [];
                for (const it of items) {
                  if (it.kind === 'file') {
                    const f = it.getAsFile();
                    if (f && (f.type.startsWith('image/') || f.type.startsWith('video/'))) {
                      files.push(f);
                    }
                  }
                }
                if (files.length > 0) {
                  e.preventDefault();
                  void onPickFiles(files);
                }
              }}
              placeholder={t('desktop.composer.placeholder').replace('{name}', group?.name ?? groupId.slice(0, 8))}
              className={(draftVoiceNote ? "hidden " : "") + "w-full bg-transparent text-sm text-lc-white outline-none placeholder:text-lc-muted disabled:opacity-50"}
            />
          </div>
          {draft.trim() ? (
            <button
              type="submit"
              disabled={uploadingMedia}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lc-green text-lc-black disabled:opacity-30"
              aria-label={t("common.send")}
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2z" /></svg>
            </button>
          ) : (
            <VoiceNoteButton disabled={uploadingMedia} onRecorded={(file, duration) => void onVoiceRecorded(file, duration)} />
          )}
        </div>
      </form>
      </>
        );
        if (group?.kind === 'forum') {
          return (
            <ForumView
              groupId={groupId}
              channelName={group?.name ?? undefined}
              onSelectThread={onSelectGroup}
            />
          );
        }
        if (group?.kind === 'voice' || group?.kind === 'voice-sfu') {
          return (
            <VoiceRoom
              channelId={groupId}
              channelName={group?.name ?? undefined}
              isChatOpen={voiceChatOpen}
              onToggleChat={() => setVoiceChatOpen(!voiceChatOpen)}
              chatSlot={
                <aside
                  id="voice-chat-rail"
                  style={{ width: voiceChatWidth }}
                  className="relative flex flex-col min-h-0 shrink-0 my-0 rounded-xl border border-lc-border bg-lc-dark shadow-xl overflow-hidden"
                >
                  <div
                    onMouseDown={onResize}
                    className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-lc-green/40 active:bg-lc-green/60 z-10"
                    title={t('desktop.voiceChat.dragResize')}
                  />
                  <div className="h-12 px-4 border-b border-lc-border flex items-center justify-between shrink-0">
                    <span className="text-sm font-semibold text-lc-white">{t('desktop.voiceChat.chat')}</span>
                    <button
                      onClick={() => setVoiceChatOpen(false)}
                      className="text-lc-muted hover:text-lc-white"
                      title={t('desktop.voiceChat.hideChat')}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col min-h-0">{textBody}</div>
                </aside>
              }
            />
          );
        }
        return textBody;
      })()}
        </div>
        {showMembers && group?.kind === 'text' && <MembersPanel groupId={groupId} />}
      </div>

      {showSettings && group && (
        <ChannelSettingsModal group={group} onClose={() => setShowSettings(false)} />
      )}
    </FileDropZone>
  );
}

const QUICK_REACTIONS = ['🔥', '⚡', '😂', '🤔'];

function CopyInviteLinkButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const relay = useCurrentRelayUrl();
  const onCopy = async () => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('c', groupId);
    if (relay) url.searchParams.set('relay', shortHost(relay));
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={onCopy}
      className={
        'rounded-md p-2 hover:bg-lc-card hover:text-lc-white ' +
        (copied ? 'text-lc-green' : 'text-lc-muted')
      }
      title={copied ? t('desktop.invite.copiedTitle') : t('desktop.invite.copy')}
      aria-label={t('desktop.invite.copy')}
    >
      {copied ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      )}
    </button>
  );
}

function ReplyAuthorName({ pubkey }: { pubkey: string }) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  return <span className="font-semibold text-lc-white">{name}</span>;
}

function PubkeyName({ pubkey }: { pubkey: string }) {
  const meta = useProfile(pubkey);
  return <>{meta?.displayName || meta?.name || pubkey.slice(0, 10)}</>;
}

function HoverCardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none invisible absolute bottom-full left-0 z-30 mb-1 w-56 rounded-md border border-lc-border bg-lc-dark p-2 text-xs text-lc-white opacity-0 shadow-2xl transition-opacity group-hover/pill:visible group-hover/pill:opacity-100"
    >
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-lc-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function ReactorHoverCard({
  emoji,
  pubkeys,
}: {
  emoji: string;
  pubkeys: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const list = useMemo(() => Array.from(pubkeys), [pubkeys]);
  const shown = list.slice(0, 20);
  const extra = list.length - shown.length;
  const reactionLabel = t(list.length === 1 ? 'desktop.reactions.one' : 'desktop.reactions.many');
  return (
    <HoverCardShell title={`${emoji} ${list.length} ${reactionLabel}`}>
      <ul className="space-y-0.5">
        {shown.map((pk) => (
          <li key={pk} className="truncate">
            <PubkeyName pubkey={pk} />
          </li>
        ))}
        {extra > 0 && <li className="text-lc-muted">{t('desktop.reactions.andMore').replace('{count}', String(extra))}</li>}
      </ul>
    </HoverCardShell>
  );
}

function ZapperHoverCard({ zapTotal }: { zapTotal: MessageZapTotal }) {
  const { t } = useTranslation();
  const entries = useMemo(
    () => Array.from(zapTotal.zapperAmounts.entries()).sort((a, b) => b[1] - a[1]),
    [zapTotal],
  );
  const shown = entries.slice(0, 20);
  const extra = entries.length - shown.length;
  return (
    <HoverCardShell
      title={`⚡ ${zapTotal.totalSats.toLocaleString()} sats · ${zapTotal.count} ${t(zapTotal.count === 1 ? 'desktop.zaps.one' : 'desktop.zaps.many')}`}
    >
      <ul className="space-y-0.5">
        {shown.map(([pk, sats]) => (
          <li key={pk} className="flex items-center justify-between gap-2 truncate">
            <span className="truncate"><PubkeyName pubkey={pk} /></span>
            <span className="shrink-0 text-yellow-300">{sats.toLocaleString()}</span>
          </li>
        ))}
        {extra > 0 && <li className="text-lc-muted">{t('desktop.reactions.andMore').replace('{count}', String(extra))}</li>}
      </ul>
    </HoverCardShell>
  );
}

function ReplyPreviewRow({
  parent,
  onJump,
}: {
  parent: JsMessage;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const meta = useProfile(parent.pubkey);
  const name = meta?.displayName || meta?.name || parent.pubkey.slice(0, 8);
  const preview = parent.content.replace(/\s+/g, ' ').slice(0, 120);
  return (
    <button
      type="button"
      onClick={onJump}
      className="mb-1 flex max-w-full items-center gap-2 truncate text-xs text-lc-muted hover:text-lc-white"
      title={t('desktop.message.jumpToReply')}
    >
      <span className="text-lc-green">↩</span>
      <span className="font-semibold text-lc-white/80">{name}</span>
      <span className="truncate text-lc-muted"><MentionText content={preview} /></span>
    </button>
  );
}

function MessageRow({
  msg,
  allMessages,
  reactions,
  zapTotal,
  groupId,
  grouped,
  isAdmin,
  onReply,
}: {
  msg: JsMessage;
  allMessages: ReadonlyArray<JsMessage>;
  reactions: ReadonlyArray<{
    id: string;
    emoji: string;
    pubkey: string;
    customEmojis?: Readonly<Record<string, string>>;
  }>;
  zapTotal: MessageZapTotal | null;
  groupId: string;
  grouped: boolean;
  isAdmin: boolean;
  onReply: (m: JsMessage) => void;
}) {
  const { t } = useTranslation();
  const parent = msg.replyToId
    ? allMessages.find((x) => x.id === msg.replyToId) ?? null
    : null;
  const onJumpToParent = () => {
    if (!parent) return;
    const el = document.querySelector(`[data-msg-id="${parent.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-1', 'ring-lc-green');
      setTimeout(() => el.classList.remove('ring-1', 'ring-lc-green'), 1200);
    }
  };
  const meta = useProfile(msg.pubkey);
  const relay = useCurrentRelayUrl();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('down');
  const [panelPinned, setPanelPinned] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPlacement, setPickerPlacement] = useState<'above' | 'below'>('above');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const myPubkey = useMyPubkey();
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const myMutes = useMyMutes();
  const isMuted = myMutes.includes(msg.pubkey);
  const toggleMute = async () => {
    try {
      await nostrActions.setMuted(msg.pubkey, !isMuted);
    } catch (e) {
      useToastStore.getState().pushToast({
        title: t('desktop.message.muteFailed'),
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const closeAll = () => { setMenuOpen(false); setPanelPinned(false); setPickerOpen(false); };
  const updatePickerPlacement = () => {
    if (!menuRef.current || typeof window === 'undefined') return;
    const rect = menuRef.current.getBoundingClientRect();
    const estimatedPickerHeight = 440;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    setPickerPlacement(spaceAbove < estimatedPickerHeight && spaceBelow > spaceAbove ? 'below' : 'above');
  };
  useEffect(() => {
    if (!menuOpen && !panelPinned && !pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeAll();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen, panelPinned, pickerOpen]);
  const counts = useMemo(
    () => groupReactions(reactions, myPubkey, serverEmojis),
    [reactions, myPubkey, serverEmojis],
  );
  const myReactedEmojis = useMemo(
    () => new Set(counts.filter((reaction) => reaction.mine).map((reaction) => reaction.emoji)),
    [counts],
  );
  const onReactionClick = (
    emoji: string,
    customEmojis?: CustomEmojiMap,
    reactionId?: string | null,
    reactionIds?: ReadonlyArray<string>,
  ) => {
    if (isAdmin && reactionIds && reactionIds.length > 0) {
      void Promise.all(reactionIds.map((id) => nostrActions.deleteGroupEvent(groupId, id)));
      return;
    }
    if (reactionId) {
      void nostrActions.removeReaction(groupId, reactionId);
      return;
    }
    if (myReactedEmojis.has(emoji)) return;
    const emojiTags = emojiTagsForContent(emoji, mergeCustomEmojiMaps(serverEmojis, customEmojis));
    void nostrActions.sendReaction(msg.id, msg.pubkey, emoji, groupId, emojiTags);
  };
  const openZap = useMessageZapStore((s) => s.open);
  const onZapClick = () => {
    if (msg.pubkey === myPubkey) {
      useToastStore.getState().pushToast({ title: `⚠️ ${t('desktop.message.cannotZapSelf')}`, body: '' });
      return;
    }
    openZap({
      messageId: msg.id,
      recipientPubkey: msg.pubkey,
      recipientLud16: meta?.lud16 ?? null,
      displayName: meta?.displayName || meta?.name || msg.pubkey.slice(0, 8),
      groupId,
    });
  };
  const displayName = meta?.displayName || meta?.name || msg.pubkey.slice(0, 8);
  const openProfile = (event: React.MouseEvent<HTMLElement>) => useChatStore.getState().openProfilePopup(
    msg.pubkey,
    { x: event.clientX, y: event.clientY },
  );

  const onRetry = () => {
    if (!msg.clientTag) return;
    void nostrActions.retryMessage(groupId, msg.clientTag);
  };
  const onDismissFailed = () => {
    if (!msg.clientTag) return;
    void nostrActions.cancelPendingMessage(groupId, msg.clientTag);
  };
  const canDeleteMessage = isAdmin || msg.pubkey === myPubkey;
  const deleteMessage = () => {
    const label = isAdmin ? t('desktop.message.confirmDeleteEveryone') : t('desktop.message.confirmDeleteOwn');
    if (!confirm(label)) return;
    if (isAdmin) void nostrActions.deleteGroupEvent(groupId, msg.id);
    else void nostrActions.removeMessage(groupId, msg.id);
  };

  return (
    <div data-msg-id={msg.id} className={'group relative flex gap-3 rounded px-2 py-0.5 hover:bg-lc-card/40 ' + (grouped ? 'mt-0' : 'mt-3') + (msg.pending ? ' opacity-60' : '')}>
      <div className="w-10 shrink-0">
        {!grouped && (
          <button onClick={openProfile} className="rounded-full transition hover:opacity-80">
            <Avatar pubkey={msg.pubkey} size={10} picture={meta?.picture ?? null} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <button onClick={openProfile} className="text-sm font-bold text-lc-white hover:underline">{displayName}</button>
            <span className="text-[10px] text-lc-muted">
              {new Date(msg.createdAt * 1000).toLocaleString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })}
            </span>
            {msg.pending && (
              <span
                className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-lc-muted/40 border-t-lc-muted"
                aria-label={t('common.sending')}
                role="status"
              />
            )}
          </div>
        )}
        {parent && <ReplyPreviewRow parent={parent} onJump={onJumpToParent} />}
        {msg.replyToId && !parent && (
          <div className="mb-1 text-xs italic text-lc-muted">↩ {t('desktop.message.replyingToMessage')}</div>
        )}
        <div
          className="break-words text-sm text-lc-white cursor-pointer"
          onClick={(e) => {
            // Don't hijack clicks on links/buttons inside the message content.
            const t = e.target as HTMLElement;
            if (t.closest('a, button, input, textarea, [data-no-msg-menu]')) return;
            setPanelPinned((v) => !v);
          }}
        >
          <MessageContent
            content={msg.content}
            messageId={msg.id}
            channelId={groupId}
            customEmojis={msg.customEmojis as CustomEmojiMap | undefined}
            sticker={msg.sticker}
            voiceNote={msg.voiceNote}
            voiceAuthorPicture={meta?.picture}
            voiceTimestamp={msg.createdAt}
          />
        </div>
        {msg.failed && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-red-400" data-testid="message-failed">
            <span aria-hidden="true">!</span>
            <span>{t('dm.failedSend')}</span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded bg-red-500/10 px-2 py-0.5 font-semibold text-red-300 hover:bg-red-500/20"
              data-testid="message-retry"
            >
              {t('common.retry')}
            </button>
            <button
              type="button"
              onClick={onDismissFailed}
              className="text-red-400/70 hover:text-red-300"
              aria-label={t('dm.dismissFailed')}
            >
              ✕
            </button>
          </div>
        )}
        {grouped && msg.pending && (
          <span
            className="ml-2 inline-block h-2.5 w-2.5 animate-spin rounded-full border border-lc-muted/40 border-t-lc-muted align-middle"
            aria-label={t('common.sending')}
            role="status"
          />
        )}
        {(counts.length > 0 || (zapTotal && zapTotal.totalSats > 0)) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {zapTotal && zapTotal.totalSats > 0 && (
              <div className="group/pill relative">
                <button
                  onClick={onZapClick}
                  disabled={msg.pubkey === myPubkey}
                  className="inline-flex items-center gap-1 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200 hover:border-yellow-500 disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" aria-hidden="true">
                    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
                  </svg>
                  {zapTotal.totalSats.toLocaleString()}
                </button>
                <ZapperHoverCard zapTotal={zapTotal} />
              </div>
            )}
            {counts.map(({ emoji, customEmojis, pubkeys, reactionIds, count, myReactionId }) => {
              const mine = myReactedEmojis.has(emoji);
              const resolved = resolveReactionEmoji(emoji, customEmojis);
              const removeForEveryone = isAdmin;
              return (
                <div key={emoji} className="group/pill relative">
                  <button
                    onClick={() => onReactionClick(emoji, customEmojis, myReactionId, removeForEveryone ? reactionIds : undefined)}
                    title={removeForEveryone ? t('desktop.reactions.removeEveryone') : mine ? t('desktop.reactions.removeOwn') : t('desktop.reactions.react')}
                    className={
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-lc-white ' +
                      (removeForEveryone || mine
                        ? 'border-lc-green/60 bg-lc-green/10 hover:border-red-400'
                        : 'border-lc-border bg-lc-card hover:border-lc-green')
                    }
                  >
                    {resolved.kind === 'custom' ? (
                      <img src={resolved.url} alt={`:${resolved.name}:`} className="h-4 w-4 object-contain" />
                    ) : (
                      <span>{resolved.char}</span>
                    )}
                    <span>{count}</span>
                  </button>
                  {pubkeys.size > 0 && (
                    <ReactorHoverCard emoji={emoji} pubkeys={pubkeys} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div ref={menuRef} className="absolute right-3 top-0 flex items-start gap-1" data-no-msg-menu>
        {/* Frequent emoji panel — visible on hover, click to pin */}
        <div
          className={
            'rounded-md border border-lc-border bg-lc-dark p-0.5 shadow-md ' +
            (menuOpen ? 'hidden' : (panelPinned || pickerOpen ? 'flex' : 'hidden group-hover:flex'))
          }
        >
          {QUICK_REACTIONS.map((e) => {
            const mine = myReactedEmojis.has(e);
            return (
              <button
                key={e}
                onClick={() => { onReactionClick(e); closeAll(); }}
                disabled={mine}
                className="rounded px-1.5 py-0.5 text-sm hover:bg-lc-card disabled:opacity-40 disabled:cursor-default"
                title={mine ? t('desktop.reactions.alreadyReacted') : t('desktop.reactions.reactEmoji').replace('{emoji}', e)}
              >
                {e}
              </button>
            );
          })}
          <button
            onClick={() => {
              updatePickerPlacement();
              setPickerOpen((v) => !v);
              setPanelPinned(true);
            }}
            className="rounded px-1.5 py-0.5 text-sm text-lc-muted hover:bg-lc-card hover:text-lc-white"
            title={t('desktop.reactions.moreEmojis')}
            aria-label={t('desktop.reactions.openEmojiPicker')}
          >
            ➕
          </button>
        </div>
        {/* ⋯ menu trigger */}
        <div
          className={
            'rounded-md border border-lc-border bg-lc-dark p-0.5 shadow-md ' +
            (menuOpen || panelPinned ? 'flex' : 'hidden group-hover:flex')
          }
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!menuOpen && menuRef.current) {
                const rect = menuRef.current.getBoundingClientRect();
                const estimatedMenuHeight = isAdmin ? 280 : 240;
                const spaceBelow = window.innerHeight - rect.bottom;
                setMenuPlacement(spaceBelow < estimatedMenuHeight ? 'up' : 'down');
              }
              setMenuOpen((v) => !v);
              setPickerOpen(false);
            }}
            className="rounded px-1.5 py-0.5 text-sm text-lc-muted hover:bg-lc-card hover:text-lc-white"
            title={t('desktop.message.moreActions')}
            aria-label={t('desktop.message.moreActions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⋯
          </button>
        </div>
        {menuOpen && (
          <div
            role="menu"
            className={
              'absolute right-0 z-20 w-48 rounded-md border border-lc-border bg-lc-dark p-1 shadow-2xl ' +
              (menuPlacement === 'up' ? 'bottom-full mb-1' : 'top-7')
            }
          >
            <button
              role="menuitem"
              onClick={() => { onReply(msg); setMenuOpen(false); }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-lc-white hover:bg-lc-card"
            >
              <span className="w-4 text-center">↩</span> {t('desktop.message.reply')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                updatePickerPlacement();
                setMenuOpen(false);
                setPickerOpen(true);
                setPanelPinned(true);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-lc-white hover:bg-lc-card"
            >
              <span className="w-4 text-center">😊</span> {t('desktop.reactions.react')}
            </button>
            <button
              role="menuitem"
              onClick={() => { onZapClick(); setMenuOpen(false); }}
              disabled={msg.pubkey === myPubkey}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-yellow-400 hover:bg-lc-card disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" aria-hidden="true" className="ml-0.5">
                <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
              </svg>
              {t('desktop.message.zap')}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  const url = new URL(window.location.href);
                  url.search = '';
                  url.searchParams.set('c', groupId);
                  url.searchParams.set('m', msg.id);
                  if (relay) url.searchParams.set('relay', shortHost(relay));
                  navigator.clipboard.writeText(url.toString());
                  useToastStore.getState().pushToast({ title: `🔗 ${t('desktop.message.linkCopied')}`, body: '' });
                }
                setMenuOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-lc-white hover:bg-lc-card"
            >
              <span className="w-4 text-center">🔗</span> {t('desktop.message.copyLink')}
            </button>
            <button
              role="menuitem"
              onClick={() => { void toggleMute(); setMenuOpen(false); }}
              disabled={msg.pubkey === myPubkey}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-lc-card disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <span className="w-4 text-center">🔕</span>
              {isMuted ? t('desktop.message.unmuteUser') : t('desktop.message.muteUser')}
            </button>
            {canDeleteMessage && (
              <button
                role="menuitem"
                onClick={() => {
                  deleteMessage();
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-lc-card"
              >
                <span className="w-4 text-center">🗑</span>
                {isAdmin ? t('desktop.message.deleteEveryone') : t('desktop.message.deleteMessage')}
              </button>
            )}
          </div>
        )}
        {pickerOpen && (
          <EmojiPicker
            disabledEmojis={myReactedEmojis}
            placement={pickerPlacement}
            onPick={(e, custom) => {
              onReactionClick(e, custom ? { [custom.name]: custom.url } : undefined);
              closeAll();
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// -- Members panel ------------------------------------------------------

function MembersPanel({ groupId }: { groupId: string }) {
  // Members are P3 in the priority orchestrator — the lazy per-group
  // admin/member REQs fire when this panel mounts. Surface a loading state
  // until {@link useMembershipReady} flips, so the user knows the empty
  // pane is "still loading" not "no members."
  const ready = useMembershipReady(groupId);
  return (
    <>
      {ready ? (
        <MemberList groupId={groupId} />
      ) : (
        <div
          className="w-60 h-full bg-lc-dark border-l border-lc-border flex flex-col items-center justify-center gap-3 text-sm text-lc-muted"
          data-testid="members-loading"
        >
          <div className="lc-spinner" aria-hidden="true" />
          <div>Loading members…</div>
        </div>
      )}
    </>
  );
}

// -- Channel settings (admin) -------------------------------------------

function ChannelSettingsModal({ group, onClose }: { group: JsGroup; onClose: () => void }) {
  const [name, setName] = useState(group.name ?? '');
  const [about, setAbout] = useState(group.about ?? '');
  const [picture, setPicture] = useState(group.picture ?? '');
  const [banner, setBanner] = useState(group.banner ?? '');
  const [access, setAccess] = useState<'public' | 'read-only' | 'private'>(
    !group.isPublic ? 'private' : group.isRestricted ? 'read-only' : 'public',
  );
  const [channelKind, setChannelKind] = useState<'text' | 'voice' | 'voice-sfu' | 'forum'>(group.kind);
  // Forum-container curated tags. Initialized from the relay's current
  // metadata so the admin sees the existing set on open; mutated through
  // the Forum tags section below and republished on save. NIP-29 9002 is a
  // full replacement, so we always send the full intended set.
  const [forumTags, setForumTags] = useState<ReadonlyArray<JsForumTag>>(group.forumTags);
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaErr, setMetaErr] = useState<string | null>(null);
  const [newMember, setNewMember] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberErr, setMemberErr] = useState<string | null>(null);
  const members = useMembers(group.id);
  const admins = useAdmins(group.id);
  const adminSet = useMemo(() => new Set(admins), [admins]);

  // A channel admin only chooses the SFU URL. `/info` supplies the identity
  // and relay compatibility fallback stored in the signed NIP-78 pin.
  const [sfuUrl, setSfuUrl] = useState('');
  const [sfuChecking, setSfuChecking] = useState(false);
  const [sfuVerified, setSfuVerified] = useState<{
    pubkey: string; cap: number | null; region: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { resolveSfuPin } = await import('@/lib/voice/sfu-pin');
      const pin = await resolveSfuPin(group.id, 800);
      if (cancelled) return;
      setSfuUrl(pin?.url ?? process.env.NEXT_PUBLIC_SFU_URL ?? 'https://sfu.obelisk.ar');
      setSfuVerified(null);
    })();
    return () => { cancelled = true; };
  }, [group.id]);

  async function verifySfu() {
    const url = sfuUrl.trim();
    if (!url) throw new Error('SFU URL is required');
    setSfuChecking(true);
    setMetaErr(null);
    try {
      const { fetchSfuInfo } = await import('@/lib/voice/sfu-pin');
      const info = await fetchSfuInfo(url);
      setSfuUrl(info.url);
      setSfuVerified({ pubkey: info.pubkey, cap: info.cap, region: info.region });
      return info;
    } catch (err) {
      setSfuVerified(null);
      setMetaErr((err as Error).message);
      throw err;
    } finally {
      setSfuChecking(false);
    }
  }

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    setSavingMeta(true);
    setMetaErr(null);
    try {
      // Validate first so a bad SFU URL cannot leave the channel metadata
      // switched to voice-sfu without a usable pin.
      const verifiedSfu = channelKind === 'voice-sfu' && sfuUrl.trim()
        ? await verifySfu()
        : null;
      await nostrActions.editGroupMetadata({
        groupId: group.id,
        name,
        about,
        picture: picture || undefined,
        banner: banner || undefined,
        isPublic: access !== 'private',
        isHidden: access === 'private',
        isRestricted: access !== 'public',
        isOpen: access === 'public',
        kind: channelKind,
        // Only meaningful for forums; harmless on other kinds (the chip
        // bar only renders for `kind === 'forum'`). Passing the full set
        // every time keeps NIP-29 9002's full-replacement semantics from
        // dropping admin-curated tags.
        forumTags,
      });
      if (verifiedSfu) {
        const { publishSfuPin } = await import('@/lib/voice/sfu-pin');
        await publishSfuPin(group.id, {
          pubkey: verifiedSfu.pubkey,
          url: verifiedSfu.url,
          trustedRelays: verifiedSfu.trustedRelays,
          relays: verifiedSfu.relays,
        });
      }
      onClose();
    } catch (err) {
      setMetaErr((err as Error).message);
    } finally {
      setSavingMeta(false);
    }
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    setMemberErr(null);
    let hex = newMember.trim();
    if (!hex) return;
    if (hex.startsWith('npub1')) {
      const decoded = npubToHex(hex);
      if (!decoded) {
        setMemberErr('Not an npub');
        return;
      }
      hex = decoded;
    }
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      setMemberErr('Provide an npub or 64-char hex pubkey');
      return;
    }
    setMemberBusy(true);
    try {
      await nostrActions.putUser(group.id, hex, makeAdmin ? ['admin'] : []);
      setNewMember('');
      setMakeAdmin(false);
    } catch (err) {
      setMemberErr((err as Error).message);
    } finally {
      setMemberBusy(false);
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      panelClassName="lc-card flex max-h-[90vh] w-full max-w-xl mx-4 flex-col overflow-hidden bg-lc-dark"
    >
        <header className="flex shrink-0 items-center justify-between border-b border-lc-border px-5 py-3">
          <div className="text-base font-bold text-lc-white">Channel settings · #{group.name ?? group.id.slice(0, 8)}</div>
          <button onClick={onClose} className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          <form onSubmit={saveMeta} id="channel-meta-form" className="space-y-7 p-5">
            {/* Appearance ----------------------------------------------- */}
            <section className="space-y-4">
              <SectionHeader title="Appearance" />
              <ChannelAppearanceInput
                picture={picture}
                banner={banner}
                onPictureChange={setPicture}
                onBannerChange={setBanner}
              />
            </section>

            {/* Basics --------------------------------------------------- */}
            <section className="space-y-3">
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />
              </Field>
              <Field label="Description">
                <textarea
                  value={about}
                  onChange={(e) => setAbout(e.target.value)}
                  rows={2}
                  placeholder="What's this channel about?"
                  className={inputClasses}
                />
              </Field>
            </section>

            {/* Access --------------------------------------------------- */}
            <section className="space-y-3">
              <SectionHeader title="Access" hint="Relay-enforced NIP-29 permissions" />
              <div className="grid gap-2 sm:grid-cols-3">
                <ToggleCard
                  active={access === 'public'}
                  onClick={() => setAccess('public')}
                  icon="🌐"
                  title="Public"
                  subtitle="Everyone can read and post"
                />
                <ToggleCard
                  active={access === 'read-only'}
                  onClick={() => setAccess('read-only')}
                  icon="👁"
                  title="Read-only"
                  subtitle="Everyone reads; members post"
                />
                <ToggleCard
                  active={access === 'private'}
                  onClick={() => setAccess('private')}
                  icon="🔒"
                  title="Private"
                  subtitle="Hidden; members only"
                />
              </div>
            </section>

            {/* Channel type --------------------------------------------- */}
            <section className="space-y-3">
              <SectionHeader title="Channel type" />
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <ToggleCard
                  active={channelKind === 'text'}
                  onClick={() => setChannelKind('text')}
                  icon="💬"
                  title="Text"
                  subtitle="Messages, threads, reactions"
                />
                <ToggleCard
                  active={channelKind === 'voice'}
                  onClick={() => setChannelKind('voice')}
                  icon="🎙️"
                  title="Voice / Video"
                  subtitle="P2P mesh, up to 8 people"
                />
                <ToggleCard
                  active={channelKind === 'voice-sfu'}
                  onClick={() => setChannelKind('voice-sfu')}
                  icon="📡"
                  title="Big-room voice"
                  subtitle="SFU-routed, up to 50 people"
                />
                <ToggleCard
                  active={channelKind === 'forum'}
                  onClick={() => setChannelKind('forum')}
                  icon="📋"
                  title="Forum"
                  subtitle="Threaded posts with replies"
                />
              </div>
              {channelKind === 'voice' && (
                <p className="text-[11px] text-lc-muted">
                  Adds a <code className="text-lc-white/80">[&quot;t&quot;,&quot;voice&quot;]</code> tag. Members open{' '}
                  <code className="text-lc-white/80">/voice/{group.id.slice(0, 8)}…</code> to join.
                </p>
              )}
              {channelKind === 'voice-sfu' && (
                <>
                  <p className="text-[11px] text-lc-muted">
                    Adds a <code className="text-lc-white/80">[&quot;t&quot;,&quot;voice-sfu&quot;]</code> tag.
                    Same join surface as voice, but the channel signals to operators &ldquo;expect a big
                    room&rdquo;. An authorized SFU joins and forwards everyone&rsquo;s media so the room scales
                    past the 8-peer mesh ceiling.
                  </p>
                  <div className="space-y-2 rounded-lg border border-lc-border bg-lc-black/40 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-lc-muted">SFU operator (kind 30078 pin)</p>
                    <p className="text-[11px] text-lc-muted">
                      Enter one SFU URL. Obelisk verifies its <code className="text-lc-white/80">/info</code>{' '}
                      descriptor and stores the returned identity automatically. Calls authenticate directly
                      to the SFU; Nostr relays are only a compatibility fallback.
                    </p>
                    <div>
                      <label className="text-[11px] text-lc-muted">SFU URL</label>
                      <div className="flex gap-2">
                        <input
                          value={sfuUrl}
                          onChange={(e) => { setSfuUrl(e.target.value); setSfuVerified(null); }}
                          spellCheck={false}
                          className={inputClasses + ' min-w-0 flex-1 font-mono text-xs'}
                          placeholder="https://sfu.obelisk.ar"
                        />
                        <button
                          type="button"
                          onClick={() => { void verifySfu().catch(() => undefined); }}
                          disabled={sfuChecking}
                          className="lc-pill-secondary shrink-0 px-3 py-1.5 text-xs disabled:opacity-50"
                        >
                          {sfuChecking ? 'Checking…' : 'Verify'}
                        </button>
                      </div>
                    </div>
                    {sfuVerified && (
                      <div className="rounded-md border border-lc-green/30 bg-lc-green/5 p-2 text-[11px] text-lc-muted">
                        <span className="text-lc-green">Verified</span>
                        {sfuVerified.region ? ` · ${sfuVerified.region}` : ''}
                        {sfuVerified.cap ? ` · up to ${sfuVerified.cap} participants` : ''}
                        <div className="mt-1 break-all font-mono text-lc-white/70">{sfuVerified.pubkey}</div>
                      </div>
                    )}
                    <p className="text-[10px] text-lc-muted">
                      The SFU checks your signed Nostr identity and whitelist when you join. The full pubkey
                      above is available for advanced verification.
                    </p>
                  </div>
                </>
              )}
              {channelKind === 'forum' && (
                <p className="text-[11px] text-lc-muted">
                  Adds a <code className="text-lc-white/80">[&quot;t&quot;,&quot;forum&quot;]</code> tag. The
                  channel renders as a list of threaded posts (NIP-29 kind 11) with replies (kind 12)
                  instead of a chat stream.
                </p>
              )}
            </section>

            {channelKind === 'forum' && (
              <section className="space-y-3" data-testid="forum-tags-editor">
                <SectionHeader
                  title="Forum tags"
                  hint="Curated; emit as forum-tag NIP-29 metadata"
                />
                <p className="text-[11px] text-lc-muted">
                  Pick a small set of categories so members can browse threads by topic.
                  Each thread creator picks from this list — they can&apos;t invent new tags.
                  Emoji is optional but helps the chip row scan at a glance.
                </p>
                <ForumTagsEditor value={forumTags} onChange={setForumTags} />
              </section>
            )}

            {metaErr && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{metaErr}</div>
            )}
          </form>

          <div className="border-t border-lc-border" />

          <section className="space-y-3 p-5">
            <div className="flex min-w-0 items-center gap-3">
              <SectionHeader title="Members" hint="NIP-29 kind 9000 / 9001" />
              <span className="shrink-0 rounded-full bg-lc-card px-2 py-0.5 text-[11px] font-semibold text-lc-muted">
                {members.length}
              </span>
            </div>
            <form onSubmit={addMember} className="flex flex-wrap items-center gap-2">
              <input
                value={newMember}
                onChange={(e) => setNewMember(e.target.value)}
                placeholder="npub1… or hex pubkey"
                spellCheck={false}
                className={inputClasses + ' flex-1 min-w-[12rem]'}
              />
              <label className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-lc-border bg-lc-black px-2.5 py-1.5 text-xs text-lc-muted">
                <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
                admin
              </label>
              <button
                type="submit"
                disabled={memberBusy || !newMember.trim()}
                className="shrink-0 rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
              >
                {memberBusy ? '…' : 'Add'}
              </button>
            </form>
            {memberErr && <div className="text-sm text-red-400">{memberErr}</div>}
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {members.map((pk) => (
                <ManageMemberRow key={pk} groupId={group.id} pubkey={pk} isAdmin={adminSet.has(pk)} />
              ))}
              {members.length === 0 && (
                <div className="rounded-lg border border-dashed border-lc-border px-3 py-4 text-center text-xs text-lc-muted">
                  No members yet. {access === 'public'
                    ? 'Not required — relay whitelist controls access.'
                    : 'Add at least one to grant access.'}
                </div>
              )}
            </div>
          </section>
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-lc-border bg-lc-dark px-5 py-3">
          <div className="text-[11px] text-lc-muted">Changes publish as NIP-29 kind 9002.</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-sm font-medium text-lc-muted hover:bg-lc-card hover:text-lc-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="channel-meta-form"
              disabled={savingMeta}
              className="rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black disabled:opacity-50"
            >
              {savingMeta ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </footer>
    </ModalShell>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="shrink-0 text-sm font-bold text-lc-white">{title}</h3>
      {hint && <span className="break-words text-right text-[11px] text-lc-muted">{hint}</span>}
    </div>
  );
}

function ToggleCard({
  active,
  onClick,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ' +
        (active
          ? 'border-lc-green bg-lc-green/10 text-lc-white'
          : 'border-lc-border bg-lc-black hover:border-lc-muted text-lc-white/80')
      }
    >
      <div className="text-xl leading-none">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[11px] text-lc-muted">{subtitle}</div>
      </div>
      <div
        className={
          'mt-0.5 h-4 w-4 shrink-0 rounded-full border ' +
          (active ? 'border-lc-green bg-lc-green' : 'border-lc-border')
        }
      />
    </button>
  );
}

function newForumTagId(): string {
  // 8-char URL-safe slug. Only needs uniqueness within one forum's tag set;
  // collision risk inside a typical < 20-tag list is negligible.
  return Math.random().toString(36).slice(2, 10);
}

function ForumTagsEditor({
  value,
  onChange,
}: {
  value: ReadonlyArray<JsForumTag>;
  onChange: (next: ReadonlyArray<JsForumTag>) => void;
}) {
  const MAX = 20;
  const updateAt = (idx: number, patch: Partial<JsForumTag>) => {
    const next = value.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    onChange(next);
  };
  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };
  const addTag = () => {
    if (value.length >= MAX) return;
    onChange([...value, { id: newForumTagId(), name: '', emoji: null }]);
  };
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="rounded-lg border border-dashed border-lc-border px-3 py-3 text-center text-xs text-lc-muted">
          No tags yet. Add one to give thread creators something to pick.
        </div>
      )}
      {value.map((tag, idx) => (
        <div
          key={tag.id}
          className="flex items-center gap-2 rounded-lg border border-lc-border bg-lc-black px-2 py-1.5"
          data-testid={`forum-tag-row-${tag.id}`}
        >
          <input
            type="text"
            value={tag.emoji ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              // Keep it short — a single grapheme is the visual target, but
              // browsers and emoji selectors vary, so we cap at 4 code units
              // rather than insisting on grapheme-cluster math here.
              updateAt(idx, { emoji: v ? v.slice(0, 4) : null });
            }}
            placeholder="🌐"
            maxLength={4}
            className="w-12 shrink-0 rounded-md border border-lc-border bg-lc-dark px-2 py-1 text-center text-sm text-lc-white outline-none focus:border-lc-green/60"
            aria-label="Tag emoji"
            data-testid={`forum-tag-emoji-${tag.id}`}
          />
          <input
            type="text"
            value={tag.name}
            onChange={(e) => updateAt(idx, { name: e.target.value })}
            placeholder="Tag name"
            maxLength={40}
            className="flex-1 min-w-0 rounded-md border border-lc-border bg-lc-dark px-2 py-1 text-sm text-lc-white outline-none focus:border-lc-green/60"
            aria-label="Tag name"
            data-testid={`forum-tag-name-${tag.id}`}
          />
          <button
            type="button"
            onClick={() => removeAt(idx)}
            className="shrink-0 rounded-md p-1 text-lc-muted hover:bg-lc-card hover:text-red-300"
            aria-label="Remove tag"
            data-testid={`forum-tag-remove-${tag.id}`}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addTag}
        disabled={value.length >= MAX}
        className="lc-pill-secondary text-xs px-3 py-1.5 disabled:opacity-40"
        data-testid="forum-tag-add"
      >
        + Add tag
      </button>
      {value.length >= MAX && (
        <p className="text-[11px] text-lc-muted">Maximum {MAX} tags reached.</p>
      )}
    </div>
  );
}

function ManageMemberRow({ groupId, pubkey, isAdmin }: { groupId: string; pubkey: string; isAdmin: boolean }) {
  const meta = useProfile(pubkey);
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-lc-card">
      <Avatar pubkey={pubkey} size={7} picture={meta?.picture ?? null} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-lc-white">
          {meta?.displayName || meta?.name || pubkey.slice(0, 10)}
          {isAdmin && <span className="ml-1 text-xs">👑</span>}
        </div>
        <div className="truncate font-mono text-[10px] text-lc-muted">{pubkey.slice(0, 32)}…</div>
      </div>
      {isAdmin && (
        <button
          onClick={() => {
            if (confirm(`Demote ${meta?.name || pubkey.slice(0, 12)} to plain member?`)) {
              nostrActions.removePermission(groupId, pubkey, ['admin']);
            }
          }}
          className="rounded px-2 py-0.5 text-xs text-lc-muted hover:bg-lc-dark hover:text-lc-white"
          title="Strip admin role; keep them in the channel as a regular member."
        >
          Demote
        </button>
      )}
      <button
        onClick={() => {
          if (confirm(`Remove ${meta?.name || pubkey.slice(0, 12)} from channel?`)) {
            nostrActions.removeUser(groupId, pubkey);
          }
        }}
        className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-lc-dark"
      >
        Remove
      </button>
    </div>
  );
}

const inputClasses =
  'w-full rounded border border-lc-border bg-lc-black px-2 py-1.5 text-sm text-lc-white outline-none focus:border-lc-green';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-lc-muted">{label}</div>
      {children}
    </label>
  );
}

// -- DMs ----------------------------------------------------------------

function DMPanel({ peer }: { peer: string | null; onPickPeer: (p: string) => void }) {
  const { t } = useTranslation();
  const dms = useDirectMessages();
  const meta = useProfile(peer);
  const thread = peer ? dms[peer] ?? [] : [];
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Mirror the open peer into the DM store so `isUserWatchingDM` reflects
  // desktop's "I'm reading this conversation" state. Without this, the
  // read-state cursor never advances on desktop and unread badges leak in.
  useEffect(() => {
    useDMStore.setState({ activeDMPubkey: peer });
    return () => {
      // Clear when the panel unmounts (user navigated away from DMs).
      if (useDMStore.getState().activeDMPubkey === peer) {
        useDMStore.setState({ activeDMPubkey: null });
      }
    };
  }, [peer]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = dist < 100;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [peer]);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.length]);

  function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!peer) return;
    const content = draft.trim();
    if (!content) return;
    // Optimistic — bridge inserts a pending placeholder; the bubble surfaces
    // its own retry button on failure, so we don't need a form-level error.
    setDraft('');
    nostrActions.sendDirectMessage(peer, content).catch((err) => {
      console.warn('[desktop] sendDirectMessage scheduling failed', err);
    });
  }

  if (!peer) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-lc-muted">
        {t('dm.pickConversation')}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-lc-border bg-lc-dark px-5 py-3">
        <button
          type="button"
          onClick={(event) => useChatStore.getState().openProfilePopup(peer, { x: event.clientX, y: event.clientY })}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left hover:opacity-80"
        >
          <Avatar pubkey={peer} size={9} picture={meta?.picture ?? null} />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-lc-white">
              {meta?.displayName || meta?.name || peer.slice(0, 16) + '…'}
            </div>
            <div className="truncate font-mono text-[10px] text-lc-muted">{peer}</div>
          </div>
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {thread.length === 0 ? (
          <div className="text-sm text-lc-muted">{t('dm.emptyEncrypted')}</div>
        ) : (
          thread.map((m) => {
            const onRetryDM = () => {
              if (!m.clientTag || !peer) return;
              void nostrActions.retryDirectMessage(peer, m.clientTag);
            };
            const onDismissDM = () => {
              if (!m.clientTag || !peer) return;
              void nostrActions.cancelPendingDirectMessage(peer, m.clientTag);
            };
            return (
              <div
                key={m.id}
                className={
                  'mb-2 max-w-md rounded-2xl px-4 py-2 text-sm shadow-sm ' +
                  (m.outgoing
                    ? 'ml-auto bg-lc-green text-lc-black'
                    : 'bg-lc-card text-lc-white') +
                  (m.pending ? ' opacity-60' : '') +
                  (m.failed ? ' ring-1 ring-red-500/60' : '')
                }
              >
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                <div className={'mt-1 flex items-center justify-end gap-1.5 text-[10px] ' + (m.outgoing ? 'text-black/60' : 'text-lc-muted')}>
                  {m.pending && (
                    <span
                      className={'inline-block h-2.5 w-2.5 animate-spin rounded-full border ' + (m.outgoing ? 'border-black/30 border-t-black/70' : 'border-lc-muted/40 border-t-lc-muted')}
                      aria-label={t('common.sending')}
                      role="status"
                    />
                  )}
                  <span>
                    {new Date(m.createdAt * 1000).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {m.failed && (
                  <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px] text-red-500" data-testid="dm-failed">
                    <span>{t('dm.failedSend')}</span>
                    <button
                      type="button"
                      onClick={onRetryDM}
                      className="rounded bg-red-500/15 px-2 py-0.5 font-semibold text-red-500 hover:bg-red-500/25"
                      data-testid="dm-retry"
                    >
                      {t('common.retry')}
                    </button>
                    <button
                      type="button"
                      onClick={onDismissDM}
                      className="text-red-500/70 hover:text-red-500"
                      aria-label={t('dm.dismissFailed')}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <form onSubmit={onSend} className="shrink-0 px-5 pt-3 pb-3">
        <div className="flex min-h-[3.5rem] items-center gap-2 rounded-xl border border-lc-border bg-lc-card px-4 focus-within:border-lc-green">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('dm.placeholderEncrypted')}
            className="flex-1 bg-transparent text-sm text-lc-white outline-none placeholder:text-lc-muted disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="text-xs font-semibold text-lc-green disabled:opacity-30"
          >
            {t('common.send')}
          </button>
        </div>
      </form>
    </div>
  );
}

// -- Helpers ------------------------------------------------------------

function Avatar({ pubkey, size, picture }: { pubkey: string; size: number; picture: string | null }) {
  const px = `${size * 4}px`;
  if (picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={picture}
        alt=""
        style={{ width: px, height: px }}
        className="rounded-full bg-lc-card object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  return (
    <div
      style={{ width: px, height: px, background: `hsl(${hue} 60% 30%)` }}
      className="flex items-center justify-center rounded-full font-mono text-[10px] font-bold text-lc-white"
    >
      {pubkey.slice(0, 2).toUpperCase()}
    </div>
  );
}

function RelayAccessModal() {
  const relay = useCurrentRelayUrl();
  const access = useRelayAccess();
  const loginMethod = useMyLoginMethod();
  const isLoggedIn = useIsLoggedIn();
  // Track which (relay, state) tuple the user has dismissed so the modal
  // doesn't keep popping back. A real state change (e.g. ok -> restricted
  // again on a new relay, or auth-required after restricted) re-arms it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const surfaceable =
    access === 'restricted' || access === 'auth-required' || access === 'unreachable';
  const key = relay && surfaceable ? `${relay}|${access}` : null;
  if (!isLoggedIn) return null;
  if (!key) return null;
  if (dismissed === key) return null;

  const host = shortHost(relay);
  const isAuth = access === 'auth-required';
  const isUnreachable = access === 'unreachable';
  const title = isAuth
    ? `Not authenticated to ${host}`
    : isUnreachable
      ? `Cannot reach ${host}`
      : `Not whitelisted on ${host}`;
  const body = isAuth
    ? loginMethod === 'bunker'
      ? 'Approve the signing request in your bunker app to complete NIP-42 AUTH.'
      : loginMethod === 'nip07'
        ? 'Approve the signing request in your Nostr extension to complete NIP-42 AUTH.'
        : 'NIP-42 AUTH did not complete. Try reloading or switching login methods.'
    : isUnreachable
      ? 'The relay isn’t responding. It may be offline, blocked by your network, or briefly unavailable. We’ll keep trying in the background — switch relays if you need to keep working.'
      : 'This relay accepted your signature but won’t serve or accept events from your pubkey. Ask the operator to add you to its allowlist, or switch relays.';

  const tone = isAuth ? 'yellow' : 'red';

  return (
    <ModalShell
      onClose={() => setDismissed(key)}
      panelClassName={
        'max-w-md mx-4 rounded-xl border bg-lc-card p-6 shadow-2xl ' +
        (tone === 'yellow' ? 'border-yellow-500/50' : 'border-red-500/50')
      }
    >
        <div className={'text-xl font-bold ' + (tone === 'yellow' ? 'text-yellow-200' : 'text-red-300')}>
          {title}
        </div>
        <div className="mt-3 text-sm text-lc-white/90">{body}</div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => setDismissed(key)}
            className="rounded-lg bg-lc-green px-4 py-1.5 text-sm font-semibold text-lc-black"
          >
            Got it
          </button>
        </div>
    </ModalShell>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  // Relay/AUTH state lives in the unified bottom-right activity stack.
  // The empty state only owns the channel-selection prompt.
  return (
    <div className="flex h-full items-center justify-center text-lc-muted">
      <div className="text-center">
        <div className="text-lg font-medium text-lc-white">{t('desktop.empty.title')}</div>
        <div className="mt-1 text-sm">{t('desktop.empty.description')}</div>
      </div>
    </div>
  );
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * "LIVE" pill rendered next to a voice channel's name when the SFU has
 * published a current kind 31314 active-call announcement for it. Only
 * shown for voice / voice-sfu channels — text and forum channels can't
 * have an SFU room. Re-evaluates every 15s via {@link useActiveCall} so
 * a stale (expired) announcement fades without needing a manual refresh.
 */
function ActiveCallBadge({ groupId, kind }: { groupId: string; kind: JsGroup['kind'] }) {
  const active = useActiveCall(groupId);
  if (kind !== 'voice' && kind !== 'voice-sfu') return null;
  if (!active) return null;
  return (
    <span
      title="Live call in progress"
      className="ml-1 inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-red-300"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
      Live
    </span>
  );
}

function MobileVoiceStatusBar({ currentView }: { currentView: View }) {
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const viewingActiveCall =
    currentView.kind === 'group' &&
    !!currentVoiceChannelId &&
    currentView.groupId === currentVoiceChannelId;
  if (viewingActiveCall) return null;
  return <div className="md:hidden"><VoiceStatusBar /></div>;
}

// silence unused-import warning when JsUserMetadata is referenced indirectly
export type { JsUserMetadata };
