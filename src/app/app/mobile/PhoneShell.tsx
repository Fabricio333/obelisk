'use client';

/**
 * Mobile shell for /app — full-screen, single-pane experience that runs
 * underneath ≤sm viewports. Implements the 17-screen layout from
 * /Volumes/Ext Disk/WebstormProjects/obelisk-mobile-design/obelisk-mobile.html
 * wired to the existing Nostr bridge.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  nostrActions,
  useIsLoggedIn,
  useIsRehydrating,
  useGroups,
  useGroupById,
  useChildrenByParent,
  useMessages,
  useMessagesByGroup,
  useMessagesStatus,
  useSignerReady,
  useMyPubkey,
  useMediaPacks,
  useMyFollows,
  useUserMetadata,
  useLoadEarlier,
  useDirectMessages,
  useAdmins,
  useAdminsByGroup,
  useMembers,
  useMembersByGroup,
  useMembershipReady,
  useGroupCreators,
  useReactions,
  useConfiguredRelays,
  useCurrentRelayUrl,
  useRelayAccess,
  useConnectionState,
  useGroupMetadataEose,
  useActiveCallByChannel,
  getBridge,
  getBridgeImpl,
  getBridgeSync,
  type JsGroup,
  type JsForumTag,
  type JsMessage,
  type JsDirectMessage,
  type JsUserMetadata,
} from '@/lib/nostr-bridge';
import LoginModal from '../LoginModal';
import DMOptInGate from '../DMOptInGate';
import VoiceRoom from '@/components/voice/VoiceRoom';
import VoiceStatusBar from '@/components/voice/VoiceStatusBar';
import BackgroundVoiceAudio from '@/components/voice/BackgroundVoiceAudio';
import { subscribeVoiceJump } from '@/lib/voice/jump-to-voice';
import MessageContent from '@/components/chat/MessageContent';
import { MentionText } from '@/components/chat/MentionText';
import MentionNavigator from '@/components/chat/MentionNavigator';
import HistoryPaginationStatus from '@/components/chat/HistoryPaginationStatus';
import EmojiPicker, { type PickedCustomEmoji } from '@/components/chat/EmojiPicker';
import MessageMediaPicker, { type MediaPickerTab } from '@/components/chat/MessageMediaPicker';
import { AttachmentMenu, FileDropZone, StickerIcon, VoiceNoteButton, VoiceNoteDraft } from '@/components/chat/ComposerActions';
import { uploadToBlossom } from '@/lib/blossom';
import { stickerTagsForContent, type MessageSticker } from '@/lib/sticker-tags';
import { voiceNoteTagForContent, type MessageVoiceNote } from '@/lib/voice-note-tags';
import { formatPubkey } from '@nostr-wot/data';
import { faviconFor, fetchRelayInfo, SUGGESTED_RELAYS } from '@/lib/relay-info';
import {
  applyLayout,
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
  relayMediaKindMap,
  resolveRelayEmojiSet,
  type RelayEmojiSet,
} from '@/lib/relay-emojis';
import {
  emojiTagsForContent,
  mergeCustomEmojiMaps,
  type CustomEmojiMap,
} from '@/lib/custom-emoji-tags';
import { groupReactions, resolveReactionEmoji } from '@/lib/emoji-shortcodes';
import BlossomImageInput, { ChannelAppearanceInput } from '@/components/BlossomImageInput';
import RelayAdminPanel from '@/components/admin/RelayAdminPanel';
import RelayEmojiAdminModal from '@/components/admin/RelayEmojiAdminModal';
import LanguagePreference from '@/components/LanguagePreference';
import MediaLibraryModal from '@/components/media/MediaLibraryModal';
import AppearancePreferenceControls from '@/components/AppearancePreferenceControls';
import ProfileFeedRelaySettings from '@/components/settings/ProfileFeedRelaySettings';
import AccountBackupExport from '@/components/settings/AccountBackupExport';
import DeveloperSignatureTest from '@/components/settings/DeveloperSignatureTest';
import { clearAllClientCacheExceptSession } from '@/lib/nostr-bridge/cache-clear';
import NostrProfile from '@/components/chat/NostrProfile';
import ProfilePopover from '@/components/chat/ProfilePopover';
import MobileSigningIndicator from '@/components/MobileSigningIndicator';
import { useTranslation } from '@/i18n/context';
import { npubToHex } from '@nostr-wot/data';
import {
  applyMentionToDraft,
  detectMentionQuery,
  filterMembers,
  relayMentionCandidates,
  type MemberInfo,
} from '@/lib/mentions';
import { useReadStateStore, type InboxEvent } from '@/store/read-state';
import {
  useChannelHighlights,
  useCachedChannelHighlights,
  useDMUnreadCount,
  useTotalDMUnread,
  useInboxUnreadCount,
} from '@/lib/read-state/selectors';
import { useChatStore } from '@/store/chat';
import { useDMStore } from '@/store/dm';
import { setDmOptInEnabled, useDmOptInEnabled } from '@/lib/dm/opt-in';
import { setPreference, usePreferences } from '@/lib/preferences';
import { useMessageZapStore } from '@/store/messageZap';
import { useNostrPresence, PRESENCE_WINDOW_MS } from '@/hooks/chat/useNostrPresence';
import MessageZapModal from '@/components/chat/MessageZapModal';
import { type ScreenName, type NavState, initialNav, urlFor, parseUrl } from './url-state';
import { buildSeedHistory, decideSnap, decideSwipeNav, decideTabPress, isAdjacentTabSwitch, neighborsFor, NAV_ORDER, resolveParent } from './swipe-nav';
import { useKeyboardInset } from './use-keyboard';
import { channelScrollPositionKey } from '@/lib/channel-scroll-position';
import { channelCursorHasReadLatest, channelInitialAnchorFromCursor } from '@/lib/channel-scroll-anchor';
import { useChannelScrollPosition } from '@/hooks/chat/useChannelScrollPosition';
import { useNostrUserSearch, type UserHit } from '@/lib/hooks/useNostrUserSearch';
// CSS is hoisted to AppGate.tsx so it lands in the route's eagerly-loaded
// stylesheet, not in this dynamic chunk's late-arriving sidecar.


// ───────────────────────────────────────────────────────────────────────────
// helpers

const PALETTES = [
  { from: '#4a78a8', to: '#7ec8ff', text: '#fff' },
  { from: '#a85a78', to: '#ff9ec5', text: '#fff' },
  { from: '#7a5aa8', to: '#c9a8ff', text: '#fff' },
  { from: '#6b8a2e', to: '#b4f953', text: '#0a0a0a' },
  { from: '#3a7050', to: '#8bc34a', text: '#0a0a0a' },
  { from: '#a87b3a', to: '#f0c14a', text: '#0a0a0a' },
];

function paletteFor(seed: string): { from: string; to: string; text: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

function avatarStyle(seed: string): React.CSSProperties {
  const p = paletteFor(seed);
  return { background: `linear-gradient(135deg, ${p.from}, ${p.to})`, color: p.text };
}

function initialsFor(name: string | null | undefined, fallback: string): string {
  const s = (name && name.trim()) || fallback;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return s.slice(0, 2).toUpperCase();
  if (parts.length === 1) return s.slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function shortNpub(pubkey: string | null | undefined): string {
  if (!pubkey) return '';
  try { return formatPubkey(pubkey); } catch { return pubkey.slice(0, 8) + '…'; }
}

function relativeTime(ts: number): string {
  const date = new Date(ts * 1000);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString();
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toDateString();
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function timeOfDay(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function shortHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function normalizeRelayUrl(url: string | null | undefined): string {
  return (url ?? '').replace(/\/+$/, '').toLowerCase();
}

const MOBILE_SWIPE_IGNORE_SELECTOR = [
  // Chrome controls own tap/scroll gestures. If a shaky tap on Search also
  // seeds the carousel, the delayed swipe commit can overwrite the click nav.
  '.spaces-strip',
  '.spaces-rail',
  '.dms-tabs',
  '.filter-tabs',
  '.cats-strip',
  '.search-filter-chips',
  '.forum-filter-row',
  '.emoji-sheet-host',
  '.sheet-host',
  '.bottom-nav',
  '.server-banner-actions',
  '.app-header .icon-btn',
  '.chat-actions .icon-btn',
  '.search-header',
  '[data-no-swipe]',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
].join(', ');

export function shouldIgnoreMobileSwipeTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return !!target.closest(MOBILE_SWIPE_IGNORE_SELECTOR);
}

// ───────────────────────────────────────────────────────────────────────────
// shared sub-components

function NameAvatar({
  pubkey,
  name,
  picture,
  size = 36,
  className = '',
}: {
  pubkey: string;
  name?: string | null;
  picture?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = initialsFor(name ?? '', shortNpub(pubkey).slice(0, 2).toUpperCase());
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.floor(size * 0.36)),
    ...avatarStyle(pubkey || name || 'x'),
  };
  return (
    <div className={className} style={style}>
      {picture ? <img src={picture} alt="" /> : initials}
    </div>
  );
}

function GroupAvatar({
  group,
  size = 56,
  className = 'space-icon',
}: {
  group: JsGroup;
  size?: number;
  className?: string;
}) {
  const initials = initialsFor(group.name, group.id.slice(0, 2).toUpperCase());
  const style: React.CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(12, Math.floor(size * 0.34)),
    ...avatarStyle(group.id),
  };
  return (
    <div className={className} style={style}>
      {group.picture ? <img src={group.picture} alt={group.name ?? ''} /> : initials}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// status bar (replicates the design — no real time, just a mock indicator)

function StatusBar() {
  return null; // OS chrome handles real status bar — design's faux bar just steals vertical space on real phones.
}

// ───────────────────────────────────────────────────────────────────────────
// bottom nav

interface NavTab { id: ScreenName; icon: ReactNode; label: string; badge?: number }

const NAV_ICONS: Record<'servers' | 'dms' | 'inbox' | 'you', ReactNode> = {
  servers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
  ),
  dms: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" /></svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>
  ),
  you: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
  ),
};

function BottomNav({
  nav,
  onTabPress,
  dmBadge,
  inboxBadge,
}: {
  nav: NavState;
  onTabPress: (target: ScreenName) => void;
  dmBadge?: number;
  inboxBadge?: number;
}) {
  const { t } = useTranslation();
  const tabs: NavTab[] = [
    { id: 'server', icon: NAV_ICONS.servers, label: t('mobile.nav.servers') },
    { id: 'dms-list', icon: NAV_ICONS.dms, label: 'DMs', badge: dmBadge },
    { id: 'inbox', icon: NAV_ICONS.inbox, label: t('inbox.title'), badge: inboxBadge },
    { id: 'settings-profile', icon: NAV_ICONS.you, label: t('settings.you') },
  ];
  // Active tab = the top-level tab the current nav resolves to. For sub-
  // screens with dynamic parents (profile-view from inbox, member-list from
  // channel, ...) this respects where the user actually came from rather
  // than the hardcoded static map. See docs/mobile-navigation.md §3.
  const activeTab = NAV_ORDER.includes(nav.screen) ? nav.screen : resolveParent(nav);
  return (
    <nav className="bottom-nav">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => onTabPress(t.id)}
          aria-label={t.label}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.badge !== undefined && t.badge > 0 && (
            <span className="nav-badge">{t.badge > 99 ? '99+' : t.badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

export function shouldHideMobileBottomNav(screen: ScreenName, kbInset: number): boolean {
  return (
    screen === 'voice-room' ||
    screen === 'profile-view' ||
    screen === 'search' ||
    screen === 'compose-dm' ||
    screen === 'profile-edit' ||
    kbInset > 0
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 01 — login

// nip07 is intentionally omitted on mobile — browser extensions don't run on
// phones, and showing the option just leads to "no extension" errors. The
// desktop shell still offers all four.
const MOBILE_LOGIN_METHODS = ['nip46', 'generate', 'import'] as const;

const LoginObeliskMark = () => (
  <svg className="login-mark" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
    <path d="M256,16 L220,72 L196,460 L200,464 L256,464 L256,72 Z" opacity="0.7" />
    <path d="M256,16 L292,72 L316,460 L312,464 L256,464 L256,72 Z" />
  </svg>
);

function LoginScreen() {
  // Mount the SDK login modal directly — no pre-picker. Going through an
  // intermediate screen made every method appear twice (once in our picker
  // and once in the SDK's flat list). The obelisk hero is forwarded via
  // `headerSlot` so we keep the brand at the top of the modal.
  return (
    <div className="screen login-screen active" data-screen="login">
      <LoginModal
        methods={[...MOBILE_LOGIN_METHODS]}
        headerSlot={<LoginObeliskMark />}
      />
    </div>
  );
}


export function RelayMenuSheet({
  close,
  relayUrl,
  label,
  iconUrl,
  isAdmin = false,
  branding,
  emojiSet,
  layout,
  rootChannels,
}: {
  close: () => void;
  relayUrl: string;
  label: string;
  iconUrl?: string | null;
  isAdmin?: boolean;
  branding?: RelayBranding;
  emojiSet?: RelayEmojiSet;
  layout?: ChannelLayout;
  rootChannels?: ReadonlyArray<JsGroup>;
}) {
  const relays = useConfiguredRelays();
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [adminPanel, setAdminPanel] = useState<null | 'branding' | 'emojis' | 'categories' | 'members'>(null);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1600);
  };

  const inviteText = `Join ${label} on Obelisk — ${relayUrl}`;

  const invite = async () => {
    setBusy('invite');
    try {
      await navigator.clipboard?.writeText(inviteText);
      flash('Invite copied');
    } catch { /* ignore */ }
    finally { setBusy(null); }
  };

  const share = async () => {
    setBusy('share');
    try {
      const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
      if (typeof nav.share === 'function') {
        await nav.share({ title: label, text: inviteText, url: relayUrl });
      } else {
        await navigator.clipboard?.writeText(inviteText);
        flash('Copied to clipboard');
      }
    } catch { /* user cancelled or unsupported */ }
    finally { setBusy(null); }
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard?.writeText(relayUrl);
      flash('Relay URL copied');
    } catch { /* ignore */ }
  };

  const leave = async () => {
    if (!window.confirm(`Leave ${label}? You can re-add it later.`)) return;
    setBusy('leave');
    try {
      const others = relays.filter((u) => u !== relayUrl);
      await nostrActions.removeRelay(relayUrl);
      if (others.length > 0) await nostrActions.switchRelay(others[0]);
      close();
    } catch (err) {
      console.warn('[mobile] leave relay failed', err);
    } finally { setBusy(null); }
  };

  const rowStyle: React.CSSProperties = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 12px',
    background: 'var(--app-surface)',
    border: '1px solid var(--app-line)',
    borderRadius: 12,
    color: 'var(--app-text)',
    textAlign: 'left',
    cursor: 'pointer',
  };

  const Row = ({
    icon,
    rowLabel,
    hint,
    onClick,
    danger,
  }: {
    icon: React.ReactNode;
    rowLabel: string;
    hint?: string;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      onClick={onClick}
      style={{ ...rowStyle, color: danger ? 'var(--presence-dnd, #ef4444)' : rowStyle.color }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'inline-flex' }}>{icon}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{rowLabel}</span>
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--app-text-mute)' }}>{hint}</span>
      )}
    </button>
  );

  return (
    <div className="sheet-host" data-screen="relay-menu">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '88%' }}>
        <div className="sheet-handle" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 4px 14px' }}>
          <div className="space-icon" style={{ width: 44, height: 44, ...(iconUrl ? {} : avatarStyle(relayUrl)) }}>
            {iconUrl ? <img src={iconUrl} alt="" /> : shortHost(relayUrl).slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--app-text-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortHost(relayUrl)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Row
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>}
            rowLabel="Invite people…"
            hint={busy === 'invite' ? '…' : 'copy link'}
            onClick={() => void invite()}
          />
          <Row
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>}
            rowLabel="Share this space"
            hint={busy === 'share' ? '…' : undefined}
            onClick={() => void share()}
          />
          <Row
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>}
            rowLabel="Copy relay URL"
            onClick={() => void copyUrl()}
          />
          {isAdmin && (
            <>
              <div
                data-testid="mobile-relay-admin-section"
                style={{
                  marginTop: 6,
                  padding: '0 4px',
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  color: 'var(--app-text-mute)',
                }}
              >
                Admin
              </div>
              <Row
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>}
                rowLabel="Edit branding"
                hint="name · icon · banner"
                onClick={() => setAdminPanel('branding')}
              />
              <Row
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>}
                rowLabel="Emoji, GIFs & stickers"
                hint="NIP-51"
                onClick={() => setAdminPanel('emojis')}
              />
              <Row
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>}
                rowLabel="Categories & order"
                hint="layout"
                onClick={() => setAdminPanel('categories')}
              />
              <Row
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>}
                rowLabel="Admins & members"
                hint="bulk cleanup"
                onClick={() => setAdminPanel('members')}
              />
            </>
          )}
          <Row
            icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>}
            rowLabel="Leave this space"
            hint={busy === 'leave' ? '…' : undefined}
            danger
            onClick={() => void leave()}
          />
        </div>
        {toast && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--accent, #b4f953)', textAlign: 'center' }}>{toast}</div>
        )}
        <button className="btn-cancel relay-menu-close" onClick={close}>Close</button>
      </div>
      {adminPanel === 'branding' && branding && (
        <EditBrandingSheet
          relayUrl={relayUrl}
          branding={branding}
          close={() => setAdminPanel(null)}
        />
      )}
      {adminPanel === 'emojis' && emojiSet && (
        <RelayEmojiAdminModal
          relayUrl={relayUrl}
          emojiSet={emojiSet}
          configuredRelays={relays}
          onClose={() => setAdminPanel(null)}
        />
      )}
      {adminPanel === 'categories' && layout && (
        <ManageCategoriesSheet
          relayUrl={relayUrl}
          layout={layout}
          channels={rootChannels ?? []}
          close={() => setAdminPanel(null)}
        />
      )}
      {adminPanel === 'members' && (
        <RelayAdminPanel onClose={() => setAdminPanel(null)} />
      )}
    </div>
  );
}

function AddRelaySheet({ close }: { close: () => void }) {
  const [tab, setTab] = useState<'suggested' | 'custom'>('suggested');
  const configured = useConfiguredRelays();
  const configuredSet = useMemo(() => new Set(configured), [configured]);

  return (
    <div className="sheet-host" data-screen="add-relay">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '88%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Add a relay
        </div>
        <div className="dms-tabs native-scroll-x" style={{ padding: 0 }}>
          <button className={`filter-tab ${tab === 'suggested' ? 'active' : ''}`} onClick={() => setTab('suggested')}>
            Suggested
          </button>
          <button className={`filter-tab ${tab === 'custom' ? 'active' : ''}`} onClick={() => setTab('custom')}>
            Custom URL
          </button>
        </div>
        <div style={{ overflowY: 'auto', maxHeight: '54vh', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 2 }}>
          {tab === 'suggested' ? (
            SUGGESTED_RELAYS.map((r) => (
              <SuggestedRelayItem
                key={r.url}
                url={r.url}
                fallbackName={r.fallbackName}
                fallbackDescription={r.fallbackDescription}
                alreadyAdded={configuredSet.has(r.url)}
                onAdded={close}
              />
            ))
          ) : (
            <CustomRelayForm onAdded={close} />
          )}
        </div>
        <button className="btn-cancel" onClick={close}>Close</button>
      </div>
    </div>
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
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  const [name, setName] = useState<string>(fallbackName ?? shortHost(url));
  const [description, setDescription] = useState<string>(fallbackDescription ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRelayInfo(url).then((info) => {
      if (!alive) return;
      setIconUrl(info?.icon || faviconFor(url));
      if (info?.name) setName(info.name);
      if (info?.description) setDescription(info.description);
    });
    return () => { alive = false; };
  }, [url]);

  const add = async () => {
    if (alreadyAdded || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await nostrActions.addRelay(url);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: 12,
      background: 'var(--app-surface)',
      border: '1px solid var(--app-line)',
      borderRadius: 12,
    }}>
      <div className="space-icon" style={{ width: 44, height: 44, ...(iconUrl && !iconFailed ? {} : avatarStyle(url)) }}>
        {iconUrl && !iconFailed ? (
          <img src={iconUrl} alt="" onError={() => setIconFailed(true)} />
        ) : (
          shortHost(url).slice(0, 1).toUpperCase()
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--app-text-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortHost(url)}</div>
        {description && (
          <div style={{ fontSize: 11.5, color: 'var(--app-text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {description}
          </div>
        )}
        {err && <div style={{ fontSize: 11, color: 'var(--presence-dnd)', marginTop: 2 }}>{err}</div>}
      </div>
      <button
        onClick={() => void add()}
        disabled={alreadyAdded || busy}
        style={{
          padding: '8px 14px',
          background: alreadyAdded ? 'var(--app-surface-2)' : 'var(--accent)',
          color: alreadyAdded ? 'var(--app-text-mute)' : 'var(--accent-ink)',
          border: 'none',
          borderRadius: 999,
          fontWeight: 700,
          fontSize: 12,
          flexShrink: 0,
          opacity: busy ? 0.5 : 1,
        }}
      >
        {alreadyAdded ? 'Added' : busy ? '…' : 'Add'}
      </button>
    </div>
  );
}

function CustomRelayForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('wss://');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    let v = url.trim();
    if (!v) return;
    if (!v.startsWith('ws://') && !v.startsWith('wss://')) v = 'wss://' + v.replace(/^\/*/, '');
    try { new URL(v); } catch { setErr('Invalid URL'); return; }
    setBusy(true);
    try {
      await nostrActions.addRelay(v);
      await nostrActions.switchRelay(v);
      onAdded();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: "'JetBrains Mono', monospace" }}>
        Relay URL
      </label>
      <p style={{ fontSize: 12, color: 'var(--app-text-dim)', margin: 0, lineHeight: 1.5 }}>
        Paste a NIP-29 group relay URL. Each relay is a separate &ldquo;server&rdquo; in the rail.
      </p>
      <div className="setup-input-wrap">
        <input
          autoFocus
          className="setup-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
        />
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{err}</div>}
      <button
        type="submit"
        disabled={busy || !url.trim()}
        className="btn-primary"
        style={{ marginTop: 4 }}
      >
        {busy ? 'Adding…' : 'Add relay'}
      </button>
    </form>
  );
}

// Bottom-sheet for creating a new channel on the active relay. Mirrors the
// desktop CreateGroupSection's minimal form (just the name) — the relay
// decides who is allowed to publish kind 9007, so we don't gate the UI by
// admin role and let the publish error surface inline if it's rejected.
export function CreateChannelSheet({
  relayLabel,
  close,
  onCreated,
}: {
  relayLabel: string;
  close: () => void;
  onCreated: (groupId: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await nostrActions.createGroup({
        name: name.trim(),
        isPublic: true,
        isOpen: true,
      });
      onCreated(id);
      close();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-host" data-screen="create-channel">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '88%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          New channel
        </div>
        <p style={{ fontSize: 12, color: 'var(--app-text-dim)', margin: 0, lineHeight: 1.5 }}>
          Channels are public and open by default — anyone the relay accepts can
          read and post. You can lock it down later in <strong>Channel settings</strong>.
        </p>
        <form
          onSubmit={submit}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label
            style={{
              fontSize: 10,
              color: 'var(--app-text-dim)',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            Channel name · on {relayLabel}
          </label>
          <div className="setup-input-wrap">
            <input
              className="setup-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="general"
              spellCheck={false}
              data-testid="mobile-create-channel-input"
            />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{err}</div>}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="btn-primary"
            style={{ marginTop: 4 }}
            data-testid="mobile-create-channel-submit"
          >
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </form>
        <button className="btn-cancel" type="button" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

// Bottom-sheet for editing kind 30078 relay branding (name, description,
// icon, banner). Mobile-native counterpart of the desktop RelayBrandingModal,
// reusing publishBranding so a write here is indistinguishable from desktop.
function EditBrandingSheet({
  relayUrl,
  branding,
  close,
}: {
  relayUrl: string;
  branding: RelayBranding;
  close: () => void;
}) {
  const [icon, setIcon] = useState(branding.icon);
  const [banner, setBanner] = useState(branding.banner);
  const [name, setName] = useState(branding.name);
  const [description, setDescription] = useState(branding.description);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
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
      close();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-host" data-screen="edit-branding" style={{ zIndex: 20 }}>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '94%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
          Edit branding
        </div>
        <p style={{ fontSize: 11, color: 'var(--app-text-dim)', margin: 0, lineHeight: 1.5 }}>
          Shown to everyone on this relay · NIP-78 kind 30078.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: "'JetBrains Mono', monospace" }}>
              Display name
            </label>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={shortHost(relayUrl)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: "'JetBrains Mono', monospace" }}>
              Description
            </label>
            <div className="setup-input-wrap">
              <textarea
                className="setup-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What's this space about?"
              />
            </div>
          </div>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{err}</div>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="btn-primary"
          data-testid="mobile-branding-save"
        >
          {saving ? 'Saving…' : 'Save branding'}
        </button>
        <button className="btn-cancel" type="button" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

// Bottom-sheet for the kind 30078 channel-layout doc — categories + their
// position, plus per-channel category assignment. Mirrors the desktop
// ManageLayoutModal but uses up/down buttons instead of drag handles since
// touch reordering on mobile is fiddly without a dedicated drag library.
function ManageCategoriesSheet({
  relayUrl,
  layout,
  channels,
  close,
}: {
  relayUrl: string;
  layout: ChannelLayout;
  channels: ReadonlyArray<JsGroup>;
  close: () => void;
}) {
  const {
    draft,
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
  } = useChannelLayoutEditor(relayUrl, layout, channels, close);
  const channelsById = useMemo(
    () => Object.fromEntries(channels.map((group) => [group.id, group])),
    [channels],
  );

  const arrowBtnStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    borderRadius: 8,
    border: '1px solid var(--app-line)',
    background: 'var(--app-surface)',
    color: 'var(--app-text-dim)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const catOptions = [
    { id: '__none__', name: 'Uncategorized' },
    ...draft.categories.map((c) => ({ id: c.id, name: c.name })),
  ];

  return (
    <div className="sheet-host" data-screen="manage-categories" style={{ zIndex: 20 }}>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '94%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          Categories &amp; order
        </div>
        <p style={{ fontSize: 11, color: 'var(--app-text-dim)', margin: 0, lineHeight: 1.5 }}>
          Shared layout for everyone on this relay · any group admin can edit · NIP-78 kind 30078.
        </p>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            New category
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="setup-input-wrap" style={{ flex: 1 }}>
              <input
                className="setup-input"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory();
                  }
                }}
                placeholder="e.g. General, Trading, Voice"
              />
            </div>
            <button
              type="button"
              onClick={addCategory}
              disabled={!newCatName.trim()}
              className="btn-primary"
              style={{ width: 'auto', padding: '0 18px', boxShadow: 'none' }}
            >
              Add
            </button>
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            Categories
          </label>
          {draft.categories.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--app-text-mute)', padding: '6px 4px' }}>
              No categories yet. Channels render under &ldquo;Uncategorized&rdquo; until you add one.
            </div>
          ) : (
            draft.categories.map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  background: 'var(--app-surface)',
                  border: '1px solid var(--app-line)',
                  borderRadius: 12,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button type="button" style={arrowBtnStyle} onClick={() => moveCategory(c.id, -1)} disabled={i === 0} aria-label="Move category up">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                  </button>
                  <button type="button" style={arrowBtnStyle} onClick={() => moveCategory(c.id, 1)} disabled={i === draft.categories.length - 1} aria-label="Move category down">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                </div>
                <input
                  className="setup-input"
                  style={{ flex: 1 }}
                  value={c.name}
                  onChange={(e) => renameCategory(c.id, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => deleteCategory(c.id)}
                  style={{
                    border: '1px solid var(--app-line)',
                    borderRadius: 8,
                    padding: '6px 10px',
                    background: 'transparent',
                    color: 'var(--presence-dnd, #ef4444)',
                    fontSize: 11,
                  }}
                  aria-label="Delete category"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            Channels · {channels.length}
          </label>
          {channels.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--app-text-mute)', padding: '6px 4px' }}>
              No channels on this relay yet.
            </div>
          ) : (
            <>
              {laidOut.categories.map((cat) => (
                <CategoryChannelsBlock
                  key={cat.id}
                  catName={cat.name}
                  channelIds={cat.channelIds}
                  channelsById={channelsById}
                  catOptions={catOptions}
                  currentCatId={cat.id}
                  onAssign={setChannelCategory}
                  onMove={moveChannel}
                />
              ))}
              {laidOut.uncategorized.length > 0 && (
                <CategoryChannelsBlock
                  catName="Uncategorized"
                  channelIds={laidOut.uncategorized}
                  channelsById={channelsById}
                  catOptions={catOptions}
                  currentCatId="__none__"
                  onAssign={setChannelCategory}
                  onMove={moveChannel}
                />
              )}
            </>
          )}
        </section>

        {err && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{err}</div>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="btn-primary"
          data-testid="mobile-categories-save"
        >
          {saving ? 'Saving…' : 'Publish layout'}
        </button>
        <button className="btn-cancel" type="button" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

function CategoryChannelsBlock({
  catName,
  channelIds,
  channelsById,
  catOptions,
  currentCatId,
  onAssign,
  onMove,
}: {
  catName: string;
  channelIds: ReadonlyArray<string>;
  channelsById: Record<string, JsGroup>;
  catOptions: ReadonlyArray<{ id: string; name: string }>;
  currentCatId: string;
  onAssign: (channelId: string, categoryId: string | null) => void;
  onMove: (channelId: string, delta: number) => void;
}) {
  if (channelIds.length === 0) return null;
  return (
    <div
      style={{
        background: 'var(--app-surface)',
        border: '1px solid var(--app-line)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--app-text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          borderBottom: '1px solid var(--app-line)',
        }}
      >
        {catName} · {channelIds.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {channelIds.map((id, i) => {
          const g = channelsById[id];
          if (!g) return null;
          return (
            <div
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                borderTop: i === 0 ? 'none' : '1px solid var(--app-line)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  #{g.name ?? g.id.slice(0, 8)}
                </div>
              </div>
              <select
                value={currentCatId}
                onChange={(e) => onAssign(id, e.target.value === '__none__' ? null : e.target.value)}
                style={{
                  background: 'var(--app-surface-2)',
                  color: 'var(--app-text)',
                  border: '1px solid var(--app-line)',
                  borderRadius: 8,
                  padding: '4px 6px',
                  fontSize: 11,
                  maxWidth: 110,
                }}
                aria-label={`Category for ${g.name ?? g.id.slice(0, 8)}`}
              >
                {catOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.name}</option>
                ))}
              </select>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button
                  type="button"
                  onClick={() => onMove(id, -1)}
                  disabled={i === 0}
                  style={{
                    width: 26,
                    height: 22,
                    borderRadius: 6,
                    border: '1px solid var(--app-line)',
                    background: 'var(--app-surface-2)',
                    color: 'var(--app-text-dim)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  aria-label={`Move ${g.name ?? g.id.slice(0, 8)} up`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => onMove(id, 1)}
                  disabled={i === channelIds.length - 1}
                  style={{
                    width: 26,
                    height: 22,
                    borderRadius: 6,
                    border: '1px solid var(--app-line)',
                    background: 'var(--app-surface-2)',
                    color: 'var(--app-text-dim)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  aria-label={`Move ${g.name ?? g.id.slice(0, 8)} down`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Bottom-sheet for per-channel admin settings (kind 9002 metadata edits +
// kind 9000/9001/9003 member management). Mirrors the desktop
// ChannelSettingsModal but trimmed to fit a phone — SFU pin + advanced fields
// stay desktop-only for now; admins can still toggle the channel kind to
// voice-sfu which falls through to the env-var defaults.
export function ChannelSettingsSheet({
  group,
  close,
}: {
  group: JsGroup;
  close: () => void;
}) {
  const [name, setName] = useState(group.name ?? '');
  const [about, setAbout] = useState(group.about ?? '');
  const [picture, setPicture] = useState(group.picture ?? '');
  const [banner, setBanner] = useState(group.banner ?? '');
  const [access, setAccess] = useState<'public' | 'read-only' | 'private'>(
    !group.isPublic ? 'private' : group.isRestricted ? 'read-only' : 'public',
  );
  const [channelKind, setChannelKind] = useState<JsGroup['kind']>(group.kind);
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaErr, setMetaErr] = useState<string | null>(null);

  const [newMember, setNewMember] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberErr, setMemberErr] = useState<string | null>(null);

  const members = useMembers(group.id);
  const admins = useAdmins(group.id);
  const adminSet = useMemo(() => new Set(admins), [admins]);
  const allPubkeys = useMemo(() => {
    const set = new Set<string>([...admins, ...members]);
    return Array.from(set);
  }, [admins, members]);

  const saveMeta = async () => {
    setSavingMeta(true);
    setMetaErr(null);
    try {
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
        // Preserve the admin-curated forum tag set as-is — mobile doesn't
        // expose a tag editor (desktop does), and NIP-29 9002 is a full
        // replacement so we'd otherwise drop them on every mobile save.
        forumTags: group.forumTags,
      });
      close();
    } catch (ex) {
      setMetaErr((ex as Error).message);
    } finally {
      setSavingMeta(false);
    }
  };

  const addMember = async (e: React.FormEvent) => {
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
      await nostrActions.putUser(group.id, hex.toLowerCase(), makeAdmin ? ['admin'] : []);
      setNewMember('');
      setMakeAdmin(false);
    } catch (ex) {
      setMemberErr((ex as Error).message);
    } finally {
      setMemberBusy(false);
    }
  };

  const togglePillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '10px 12px',
    borderRadius: 12,
    border: `1px solid ${active ? 'var(--accent)' : 'var(--app-line)'}`,
    background: active ? 'rgba(180, 249, 83, 0.08)' : 'var(--app-surface)',
    color: active ? 'var(--accent)' : 'var(--app-text-dim)',
    fontWeight: 600,
    fontSize: 12,
    textAlign: 'center',
    cursor: 'pointer',
  });

  return (
    <div className="sheet-host" data-screen="channel-settings">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y" style={{ maxHeight: '94%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          Channel settings · #{group.name ?? group.id.slice(0, 8)}
        </div>

        {/* Appearance */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ChannelAppearanceInput
            picture={picture}
            banner={banner}
            onPictureChange={setPicture}
            onBannerChange={setBanner}
          />
        </section>

        {/* Basics */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Name</label>
          <div className="setup-input-wrap">
            <input
              className="setup-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="mobile-channel-settings-name"
            />
          </div>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Description</label>
          <div className="setup-input-wrap">
            <textarea
              className="setup-textarea"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              rows={2}
              placeholder="What's this channel about?"
            />
          </div>
        </section>


        {/* Access */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Access</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" data-testid="mobile-channel-access-public" style={togglePillStyle(access === 'public')} onClick={() => setAccess('public')}>
              <div style={{ fontSize: 16 }}>🌐</div>
              <div>Public</div>
              <div style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>everyone reads and posts</div>
            </button>
            <button type="button" data-testid="mobile-channel-access-read-only" style={togglePillStyle(access === 'read-only')} onClick={() => setAccess('read-only')}>
              <div style={{ fontSize: 16 }}>👁</div>
              <div>Read-only</div>
              <div style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>members post</div>
            </button>
            <button type="button" data-testid="mobile-channel-access-private" style={togglePillStyle(access === 'private')} onClick={() => setAccess('private')}>
              <div style={{ fontSize: 16 }}>🔒</div>
              <div>Private</div>
              <div style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>hidden; members only</div>
            </button>
          </div>
        </section>

        {/* Channel kind */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Channel type</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['text', 'voice', 'voice-sfu', 'forum'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setChannelKind(k)}
                style={{
                  flex: '1 1 calc(50% - 6px)',
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: `1px solid ${channelKind === k ? 'var(--accent)' : 'var(--app-line)'}`,
                  background: channelKind === k ? 'rgba(180, 249, 83, 0.08)' : 'var(--app-surface)',
                  color: channelKind === k ? 'var(--accent)' : 'var(--app-text-dim)',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {k === 'voice-sfu' ? 'Voice (SFU)' : k.charAt(0).toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          {channelKind === 'voice-sfu' && (
            <p style={{ fontSize: 11, color: 'var(--app-text-dim)', margin: 0 }}>
              SFU pin (pubkey/url) is desktop-only for now. Falls back to the
              relay&apos;s advertisement or env-var defaults.
            </p>
          )}
        </section>

        {metaErr && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{metaErr}</div>}
        <button
          type="button"
          onClick={() => void saveMeta()}
          disabled={savingMeta}
          className="btn-primary"
          data-testid="mobile-channel-settings-save"
        >
          {savingMeta ? 'Saving…' : 'Save channel'}
        </button>

        {/* Members */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            Add member · NIP-29 kind 9000
          </label>
          <form onSubmit={addMember} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={newMember}
                onChange={(e) => setNewMember(e.target.value)}
                placeholder="npub1… or 64-char hex"
                spellCheck={false}
                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--app-text-dim)' }}>
              <input
                type="checkbox"
                checked={makeAdmin}
                onChange={(e) => setMakeAdmin(e.target.checked)}
              />
              Make admin
            </label>
            {memberErr && <div style={{ fontSize: 12, color: 'var(--presence-dnd)' }}>{memberErr}</div>}
            <button
              type="submit"
              disabled={memberBusy || !newMember.trim()}
              className="btn-primary"
              style={{ width: 'auto', alignSelf: 'flex-start', padding: '0 18px', boxShadow: 'none' }}
            >
              {memberBusy ? 'Adding…' : 'Add'}
            </button>
          </form>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            Members · {allPubkeys.length}
          </label>
          {allPubkeys.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--app-text-mute)', padding: '6px 4px' }}>
              No members listed yet. Public channels do not require a member list.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '40vh', overflowY: 'auto' }}>
              {allPubkeys.map((pk) => (
                <ManageMemberRowMobile
                  key={pk}
                  groupId={group.id}
                  pubkey={pk}
                  isAdmin={adminSet.has(pk)}
                />
              ))}
            </div>
          )}
        </section>

        <button className="btn-cancel" type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}

function ManageMemberRowMobile({
  groupId,
  pubkey,
  isAdmin,
}: {
  groupId: string;
  pubkey: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const meta = useUserMetadata(pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(pubkey);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        background: 'var(--app-surface)',
        border: '1px solid var(--app-line)',
        borderRadius: 12,
      }}
    >
      <div className="msg-ava" style={{ ...avatarStyle(pubkey), width: 32, height: 32 }}>
        {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(pubkey))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
          {isAdmin && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>admin</span>}
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'var(--app-text-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {shortNpub(pubkey)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Demote ${name}? They keep channel access but lose admin rights.`)) {
                void nostrActions.removePermission(groupId, pubkey, ['admin']);
              }
            }}
            style={{
              border: '1px solid var(--app-line)',
              borderRadius: 8,
              padding: '4px 8px',
              background: 'transparent',
              color: 'var(--app-text-dim)',
              fontSize: 11,
            }}
            aria-label={`Demote ${name}`}
          >
            Demote
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Kick ${name} from this channel?`)) {
              void nostrActions.removeUser(groupId, pubkey);
            }
          }}
          style={{
            border: '1px solid var(--app-line)',
            borderRadius: 8,
            padding: '4px 8px',
            background: 'transparent',
            color: 'var(--presence-dnd, #ef4444)',
            fontSize: 11,
          }}
          aria-label={`Kick ${name}`}
        >
          Kick
        </button>
      </div>
    </div>
  );
}

// Relay tile in the spaces strip — fetches NIP-11 icon, falls back to favicon,
// then to a letter on a gradient. Same pattern the desktop ServerRail uses.
export function RelayTile({
  url,
  active,
  onClick,
  onLongPress,
}: {
  url: string;
  active: boolean;
  onClick: () => void;
  onLongPress?: (info: { url: string; label: string; iconUrl: string | null }) => void;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const [nip11Name, setNip11Name] = useState<string>('');
  const [operator, setOperator] = useState<string | null>(null);

  // Tile icon is the domain favicon — not NIP-11 metadata, not kind-30078
  // branding. The relay's metadata is used only for the name + operator pubkey.
  const iconUrl = faviconFor(url);

  useEffect(() => {
    let alive = true;
    fetchRelayInfo(url).then((info) => {
      if (!alive) return;
      if (info?.name) setNip11Name(info.name);
      if (info?.pubkey) setOperator(info.pubkey);
    });
    return () => { alive = false; };
  }, [url]);

  // Operator-published kind-30078 branding only contributes the NAME — the
  // tile icon stays as the relay's own NIP-11 `icon` (favicon fallback). The
  // branding image is the desktop banner, not a circular space-icon.
  const branding = useRelayBranding(url, operator ? [operator] : []);
  const label = branding.name || nip11Name || shortHost(url);
  const showImage = iconUrl && !iconFailed;

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressFired = useRef(false);
  const fireLongPress = () => {
    pressFired.current = true;
    onLongPress?.({ url, label, iconUrl: showImage ? iconUrl : null });
  };
  const startPress = () => {
    if (!onLongPress) return;
    pressFired.current = false;
    pressTimer.current = setTimeout(fireLongPress, 500);
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <button
      className={`space ${active ? 'active' : ''}`}
      onClick={() => {
        if (pressFired.current) { pressFired.current = false; return; }
        onClick();
      }}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
      onContextMenu={onLongPress ? (e) => { e.preventDefault(); fireLongPress(); } : undefined}
    >
      <div className="space-icon" style={!showImage ? avatarStyle(url) : undefined}>
        {showImage ? (
          <img src={iconUrl} alt="" onError={() => setIconFailed(true)} />
        ) : (
          label.slice(0, 1).toUpperCase()
        )}
      </div>
      <span className="space-name">{label}</span>
    </button>
  );
}


export function MobileServerRail({
  relays,
  activeRelay,
  onSelectRelay,
  onAddRelay,
  onLongPress,
}: {
  relays: ReadonlyArray<string>;
  activeRelay: string | null;
  onSelectRelay: (url: string) => void;
  onAddRelay: () => void;
  onLongPress?: (info: { url: string; label: string; iconUrl: string | null }) => void;
}) {
  const activeKey = normalizeRelayUrl(activeRelay);
  return (
    <aside className="spaces-rail" data-testid="mobile-server-rail" aria-label="Servers">
      <div className="spaces-rail-scroll native-scroll-y" data-no-swipe>
        {relays.map((url) => {
          const isActive = normalizeRelayUrl(url) === activeKey;
          return (
            <RelayTile
              key={url}
              url={url}
              active={isActive}
              onClick={() => onSelectRelay(url)}
              onLongPress={onLongPress}
            />
          );
        })}
        <button className="space space-add" onClick={onAddRelay} aria-label="Add relay">
          <div className="space-icon s-add">+</div>
          <span className="space-name">&nbsp;</span>
        </button>
      </div>
    </aside>
  );
}

export function MobileServerBanner({
  label,
  relayUrl,
  iconUrl,
  bannerUrl,
  onSearch,
  onCreateChannel,
  onOpenMenu,
}: {
  label: string;
  relayUrl: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  onSearch: () => void;
  onCreateChannel: () => void;
  onOpenMenu: () => void;
}) {
  const host = relayUrl ? shortHost(relayUrl) : '';
  const iconFallback = relayUrl ? shortHost(relayUrl).slice(0, 1).toUpperCase() : 'O';
  return (
    <header className="server-banner" data-testid="mobile-server-banner">
      {bannerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="server-banner-img" src={bannerUrl} alt="" aria-hidden="true" />
      ) : (
        <div className="server-banner-fallback" aria-hidden="true" />
      )}
      <div className="server-banner-shade" aria-hidden="true" />
      <div className="server-banner-actions">
        <MobileSigningIndicator />
        <button className="icon-btn action-search" aria-label="Search this server" onClick={onSearch}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        </button>
        <button
          className="icon-btn action-create"
          aria-label="Create channel"
          data-testid="mobile-create-channel-btn"
          onClick={onCreateChannel}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button className="icon-btn action-menu" aria-label="Space menu" onClick={onOpenMenu}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
        </button>
      </div>
      <div className="server-banner-meta">
        <div className="server-banner-icon" style={iconUrl ? undefined : avatarStyle(relayUrl || label)}>
          {iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconUrl} alt="" />
          ) : (
            iconFallback
          )}
        </div>
        <div className="server-banner-copy">
          <h2>{label}</h2>
          {host && <span>{host}</span>}
        </div>
      </div>
    </header>
  );
}

// Single row in the channel list — picks the right icon for text/voice/forum
// and surfaces the live-call indicator on voice channels. The `unread` and
// `mentioned` variants are derived from the read-state cursor (per-channel
// unix-ms read marker) compared against bridge-supplied `messages.createdAt`.
function ChannelRow({
  group,
  live,
  active,
  onClick,
  expandable,
  expanded,
  onToggleExpand,
  indent,
}: {
  group: JsGroup;
  live: boolean;
  active?: boolean;
  onClick: () => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  indent?: boolean;
}) {
  const myPubkey = useMyPubkey();
  const highlights = useCachedChannelHighlights(group.id, myPubkey);
  const unread = highlights.unread;
  const mentionsOrReplies = highlights.mentions + highlights.replies;
  const name = group.name ?? group.id.slice(0, 8);
  if (group.kind === 'voice' || group.kind === 'voice-sfu') {
    return (
      <button className={`ch-row voice ${active ? 'active' : ''}`} onClick={onClick}>
        <span className="ch-icon" style={{ color: live ? 'var(--accent)' : 'var(--app-text-mute)' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>
        </span>
        <div className="ch-body">
          <div className="ch-row-top">
            <span className="ch-name">{name}</span>
            {live && <span className="voice-live-dot" />}
            {live && <span className="ch-meta" style={{ marginLeft: 'auto', color: 'var(--accent)' }}>live</span>}
          </div>
        </div>
      </button>
    );
  }
  const cls = ['ch-row'];
  if (active) cls.push('active');
  if (unread && unread > 0) cls.push('unread');
  if (indent) cls.push('ch-thread');
  if (group.kind === 'forum') {
    // When the forum has thread children, split into two click zones: the row
    // body navigates into the forum view (matches desktop), and the chevron
    // button toggles inline thread expansion (matches the user expectation
    // that an arrow icon means "expand"). Without children there's nothing
    // to expand, so we keep the old single-button behaviour.
    if (expandable && onToggleExpand) {
      cls.push('ch-row-split');
      return (
        <div className={cls.join(String.fromCharCode(10))}>
          <button className="ch-row-body" onClick={onClick}>
            <span className="ch-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h18" /></svg>
            </span>
            <span className="ch-name">{name}</span>
            {unread > 0 && <span className="ch-meta">{unread > 99 ? '99+' : unread}</span>}
            {mentionsOrReplies > 0 && (
              <span className="mention-pill" aria-label={`${mentionsOrReplies} mentions or replies`}>
                {mentionsOrReplies > 99 ? '99+' : mentionsOrReplies}
              </span>
            )}
          </button>
          <button
            className="ch-chevron-btn"
            onClick={onToggleExpand}
            aria-label={expanded ? 'Collapse threads' : 'Expand threads'}
            aria-expanded={!!expanded}
          >
            <span className={`ch-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
            </span>
          </button>
        </div>
      );
    }
    return (
      <button className={cls.join(String.fromCharCode(10))} onClick={onClick}>
        <span className="ch-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 12h18M3 19h18" /></svg>
        </span>
        <span className="ch-name">{name}</span>
        {unread > 0 && <span className="ch-meta">{unread > 99 ? '99+' : unread}</span>}
        {mentionsOrReplies > 0 && (
          <span className="mention-pill" aria-label={`${mentionsOrReplies} mentions or replies`}>
            {mentionsOrReplies > 99 ? '99+' : mentionsOrReplies}
          </span>
        )}
        <span className="ch-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
        </span>
      </button>
    );
  }
  return (
    <button className={cls.join(String.fromCharCode(10))} onClick={onClick}>
      <span className="ch-icon">#</span>
      <span className="ch-name">{name}</span>
      {unread > 0 && <span className="ch-meta">{unread > 99 ? '99+' : unread}</span>}
      {mentionsOrReplies > 0 && (
        <span className="mention-pill" aria-label={`${mentionsOrReplies} mentions or replies`}>
          {mentionsOrReplies > 99 ? '99+' : mentionsOrReplies}
        </span>
      )}
    </button>
  );
}

// Renders a forum's thread children only after they have at least one message
// (mirrors desktop's ForumChildGroupNode — empty/aborted threads stay hidden
// so the inline expansion doesn't accumulate noise).
function ForumThreadChildRow({
  group,
  active,
  onClick,
}: {
  group: JsGroup;
  active: boolean;
  onClick: () => void;
}) {
  const messages = useMessages(group.id);
  if (messages.length === 0) return null;
  return (
    <ChannelRow
      group={group}
      live={false}
      active={active}
      onClick={onClick}
      indent
    />
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 03 — server (groups + channels)

/**
 * Differentiated empty state for the channel list. Without this the user
 * can't tell whether the relay is still loading, blocked them, or genuinely
 * has no channels — all three previously rendered as "No channels yet".
 *
 * Precedence (highest first):
 *   - Whitelisting required — relay is rejecting reads with auth-required
 *     or restricted. Even if we're "connected", the user won't see channels
 *     until they're whitelisted.
 *   - Network issue       — connection failed / dropped, or relay is
 *     unreachable.
 *   - Channels loading    — connecting, authenticating, or connected but
 *     the kind 39000 EOSE hasn't had time to land. We give it ~4s before
 *     declaring "No channels found".
 *   - No channels found   — we've waited long enough and the relay
 *     genuinely returned zero groups.
 */
function ChannelListEmptyState({
  relayAccess,
  connectionState,
  metadataEose,
}: {
  relayAccess: import('@/lib/nostr-bridge').RelayAccessState;
  connectionState: string;
  metadataEose: boolean;
}) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), 6000);
    return () => clearTimeout(t);
  }, [connectionState, relayAccess]);

  let label = 'Channels loading…';
  if (connectionState === 'Offline') {
    label = 'You’re offline';
  } else if (relayAccess === 'auth-required' || relayAccess === 'restricted') {
    label = 'Whitelisting required';
  } else if (
    relayAccess === 'unreachable'
    || relayAccess === 'error'
    || connectionState === 'Disconnected'
    || connectionState.startsWith('Error')
  ) {
    label = 'Network issue';
  } else if (
    connectionState !== 'Connected'
    || relayAccess === 'unknown'
    || relayAccess === 'authenticating'
    || (!metadataEose && !waited)
  ) {
    label = 'Channels loading…';
  } else if (metadataEose) {
    // Relay finished its kind 39000 stream and returned zero events.
    label = 'No channels found';
  } else {
    // Connected for >6s, ok access, but no EOSE for kind 39000. Most
    // relays that silently filter unauthorized reads behave this way —
    // they accept the REQ but never close it. Treat as a whitelist
    // symptom rather than mislabeling as "No channels found".
    label = 'Whitelisting required';
  }

  const isLoading = label === 'Channels loading…';
  return (
    <div
      style={{ padding: '10px 12px', color: 'var(--app-text-mute)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}
      data-testid={isLoading ? 'channels-loading' : 'channels-empty'}
      data-state={label}
    >
      {isLoading && <div className="lc-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden="true" />}
      <span>{label}</span>
    </div>
  );
}

// Preserve vertical scroll position across remounts when the user navigates
// between top-level tabs (e.g., server ↔ dms-list). Each screen unmounts on
// tab switch, so without this the scroll resets to 0 on every return.
const screenScrollMemo = new Map<string, number>();
function useScreenScrollMemo(key: string, ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = screenScrollMemo.get(key);
    if (saved != null) el.scrollTop = saved;
    const onScroll = () => { screenScrollMemo.set(key, el.scrollTop); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, [key, ref]);
}

function ServerScreen({
  go,
  selectGroup,
}: {
  go: (s: ScreenName) => void;
  selectGroup: (groupId: string, kind: JsGroup['kind']) => void;
}) {
  const groups = useGroups();
  const relay = useCurrentRelayUrl();
  const relayAccess = useRelayAccess(relay || null);
  const connectionState = useConnectionState();
  const metadataEose = useGroupMetadataEose();
  const relays = useConfiguredRelays();
  const myPubkey = useMyPubkey();
  const calls = useActiveCallByChannel();
  const operatorPubkey = useRelayOperatorPubkey(relay || null);
  const [addRelayOpen, setAddRelayOpen] = useState(false);
  const [relayMenuFor, setRelayMenuFor] = useState<{ url: string; label: string; iconUrl: string | null } | null>(null);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
  // Mirror desktop's per-forum collapsed flag from localStorage so toggles
  // survive reloads and stay in sync across surfaces (key:
  // `obelisk-dex/forum-collapsed/<id>` = '1' means collapsed; missing = expanded).
  const [forumCollapsed, setForumCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    const out: Record<string, boolean> = {};
    try {
      const prefix = 'obelisk-dex/forum-collapsed/';
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        if (window.localStorage.getItem(key) === '1') out[key.slice(prefix.length)] = true;
      }
    } catch {}
    return out;
  });
  const toggleForumCollapsed = useCallback((id: string) => {
    setForumCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      if (typeof window !== 'undefined') {
        const key = `obelisk-dex/forum-collapsed/${id}`;
        if (next[id]) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      }
      return next;
    });
  }, []);
  const channelListRef = useRef<HTMLDivElement>(null);
  useScreenScrollMemo(`server:${relay ?? ''}`, channelListRef);

  // NIP-11 name + icon for the active relay header. Mirrors RelayTopBar on
  // desktop — both surfaces show the operator-set name (e.g. "Obelisk Public
  // Relay") and fall back to the URL host until the doc resolves.
  const [activeRelayInfo, setActiveRelayInfo] = useState<{ name?: string; icon?: string } | null>(null);
  useEffect(() => {
    if (!relay) { setActiveRelayInfo(null); return; }
    let alive = true;
    fetchRelayInfo(relay).then((info) => {
      if (!alive) return;
      setActiveRelayInfo({ name: info?.name, icon: info?.icon || faviconFor(relay) || undefined });
    });
    return () => { alive = false; };
  }, [relay]);

  // Match the desktop's exact roots/layout pipeline so categories render the
  // same as ServerRail. Critically: a group whose parent isn't in the local
  // store still counts as a root.
  const groupsById = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.id, g])),
    [groups],
  );
  const roots = useMemo(
    () => groups.filter((g) => !g.parent || !groupsById[g.parent]),
    [groups, groupsById],
  );
  const childrenByParent = useChildrenByParent();

  // Relay-wide settings trust the validated human operator identity only.
  const relayAuthors = useMemo(() => operatorPubkey ? [operatorPubkey] : [], [operatorPubkey]);
  const layout = useChannelLayout(relay || null, relayAuthors);
  const laidOut = useMemo(
    () => applyLayout(layout, roots.map((g) => g.id)),
    [layout, roots],
  );
  const branding = useRelayBranding(relay || null, relayAuthors);
  const emojiSet = useRelayEmojiSet(relay || null, relayAuthors);
  const mediaPacks = useMediaPacks();
  const resolvedEmojiSet = useMemo(() => resolveRelayEmojiSet(emojiSet, mediaPacks), [emojiSet, mediaPacks]);
  const setServerEmojis = useChatStore((s) => s.setServerEmojis);
  useEffect(() => {
    setServerEmojis(relayEmojiMap(resolvedEmojiSet), relayMediaKindMap(resolvedEmojiSet));
  }, [resolvedEmojiSet, setServerEmojis]);

  // Renders a single channel row, plus — for forum containers with thread
  // children — the inline thread list when the user has expanded it. Used by
  // both the categorised and uncategorised lists below.
  const renderChannel = (g: JsGroup) => {
    if (g.kind === 'forum') {
      const childIds = childrenByParent[g.id] ?? [];
      const expandable = childIds.length > 0;
      const isExpanded = expandable && !forumCollapsed[g.id];
      return (
        <Fragment key={g.id}>
          <ChannelRow
            group={g}
            live={!!calls[g.id]}
            onClick={() => selectGroup(g.id, g.kind)}
            expandable={expandable}
            expanded={isExpanded}
            onToggleExpand={expandable ? () => toggleForumCollapsed(g.id) : undefined}
          />
          {isExpanded && (
            <div className="forum-threads">
              {childIds.map((cid) => {
                const child = groupsById[cid];
                if (!child) return null;
                return (
                  <ForumThreadChildRow
                    key={cid}
                    group={child}
                    active={false}
                    onClick={() => selectGroup(child.id, child.kind)}
                  />
                );
              })}
            </div>
          )}
        </Fragment>
      );
    }
    return (
      <ChannelRow
        key={g.id}
        group={g}
        live={!!calls[g.id]}
        onClick={() => selectGroup(g.id, g.kind)}
      />
    );
  };

  // Active "space" label — prefer the operator-published kind-30078 branding
  // name (matches desktop banner), fall back to NIP-11 doc, then to the URL
  // host while everything resolves.
  const activeSpaceLabel = branding.name || activeRelayInfo?.name || (relay ? shortHost(relay) : 'Obelisk');
  const activeSpaceIcon = branding.icon || activeRelayInfo?.icon || null;
  const activeSpaceBanner = branding.banner || null;
  const openActiveRelayMenu = () => {
    if (!relay) return;
    setRelayMenuFor({ url: relay, label: activeSpaceLabel, iconUrl: activeSpaceIcon });
  };

  return (
    <div className="screen active" data-screen="server">
      <div className="server-mobile-layout">
        <MobileServerRail
          relays={relays}
          activeRelay={relay}
          onSelectRelay={(url) => {
            if (normalizeRelayUrl(url) !== normalizeRelayUrl(relay)) void nostrActions.switchRelay(url);
          }}
          onAddRelay={() => setAddRelayOpen(true)}
          onLongPress={(info) => setRelayMenuFor(info)}
        />

        <section className="server-channel-pane" data-testid="mobile-channel-menu">
          <MobileServerBanner
            label={activeSpaceLabel}
            relayUrl={relay}
            iconUrl={activeSpaceIcon}
            bannerUrl={activeSpaceBanner}
            onSearch={() => go('search')}
            onCreateChannel={() => { if (relay) setCreateChannelOpen(true); }}
            onOpenMenu={openActiveRelayMenu}
          />

          <div className="channel-list native-scroll-y" ref={channelListRef}>
        {laidOut.categories.map((cat) => {
          const list = cat.channelIds
            .map((id) => groupsById[id])
            .filter((g): g is JsGroup => !!g);
          const collapsed = !!collapsedCats[cat.id];
          return (
            <div key={cat.id} data-cat-id={cat.id}>
              <button
                className="channel-section-label collapsible"
                onClick={() => setCollapsedCats((c) => ({ ...c, [cat.id]: !c[cat.id] }))}
              >
                <span>{cat.name} · {list.length}</span>
                <span className={`cat-caret ${collapsed ? '' : 'expanded'}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
                </span>
              </button>
              {!collapsed && list.map(renderChannel)}
              {!collapsed && list.length === 0 && (
                <div className="cat-empty">No channels here yet.</div>
              )}
            </div>
          );
        })}
        {laidOut.uncategorized.length > 0 && (
          <div data-cat-id="__other">
            {laidOut.categories.length > 0 && (
              <button
                className="channel-section-label collapsible"
                onClick={() => setCollapsedCats((c) => ({ ...c, __other: !c.__other }))}
              >
                <span>Uncategorized · {laidOut.uncategorized.length}</span>
                <span className={`cat-caret ${collapsedCats.__other ? '' : 'expanded'}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
                </span>
              </button>
            )}
            {!collapsedCats.__other && laidOut.uncategorized
              .map((id) => groupsById[id])
              .filter((g): g is JsGroup => !!g)
              .map(renderChannel)}
          </div>
        )}
        {roots.length === 0 && (
          <ChannelListEmptyState
            relayAccess={relayAccess}
            connectionState={connectionState}
            metadataEose={metadataEose}
          />
        )}
          </div>
        </section>
      </div>

      {addRelayOpen && <AddRelaySheet close={() => setAddRelayOpen(false)} />}
      {createChannelOpen && relay && (
        <CreateChannelSheet
          relayLabel={activeSpaceLabel}
          close={() => setCreateChannelOpen(false)}
          onCreated={(id) => selectGroup(id, 'text')}
        />
      )}
      {relayMenuFor && (
        <RelayMenuSheet
          close={() => setRelayMenuFor(null)}
          relayUrl={relayMenuFor.url}
          label={relayMenuFor.label}
          iconUrl={relayMenuFor.iconUrl}
          isAdmin={!!myPubkey && relayAuthors.includes(myPubkey)}
          branding={branding}
          emojiSet={emojiSet}
          layout={layout}
          rootChannels={roots}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 04 — channel (chat)

function ReplyAuthorName({ pubkey }: { pubkey: string }) {
  const meta = useUserMetadata(pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(pubkey);
  return <span className="composer-reply-author">{name}</span>;
}

/**
 * Mention popover anchored above the mobile composer. Mirrors the desktop
 * `MentionAutocomplete` shape but uses mobile CSS variables and tap-friendly
 * row sizing. Keeps focus on the input across tap (preventDefault on
 * mousedown) so the soft keyboard doesn't dismiss mid-selection.
 */
export function MobileMentionAutocomplete({
  members,
  selectedIndex,
  onSelect,
  onHover,
}: {
  members: MemberInfo[];
  selectedIndex: number;
  onSelect: (m: MemberInfo) => void;
  onHover: (i: number) => void;
}) {
  if (members.length === 0) return null;
  return (
    <div className="composer-mention-popup" data-testid="mobile-mention-autocomplete">
      {members.map((m, i) => (
        <button
          key={m.pubkey}
          type="button"
          className={`composer-mention-row ${i === selectedIndex ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(m); }}
          onMouseEnter={() => onHover(i)}
          data-testid="mobile-mention-option"
        >
          {m.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={m.picture} alt="" className="composer-mention-avatar" />
          ) : (
            <div className="composer-mention-avatar fallback">
              {m.displayName[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span className="composer-mention-name">{m.displayName}</span>
          <span className="composer-mention-key">{m.pubkey.slice(0, 8)}…</span>
        </button>
      ))}
    </div>
  );
}

function ChannelScreen({
  groupId,
  go,
  back,
  openMsgActions,
  openZap,
  openProfile,
  openMembers,
}: {
  groupId: string;
  go: (s: ScreenName) => void;
  back: () => void;
  openMsgActions: (m: { id: string; pubkey: string; content: string; groupId: string; canModerate: boolean; canDeleteOwn: boolean }) => void;
  openZap: (m: { id: string; pubkey: string; content: string }) => void;
  openProfile: (pubkey: string) => void;
  openMembers: () => void;
}) {
  const { t } = useTranslation();
  // Raw lookup — bypasses WoT filtering. Mirrors desktop ChatPanel: the
  // user explicitly navigated to this groupId; hiding it because a WoT
  // verdict hasn't resolved yet causes a false "Channel not visible"
  // verdict.
  const group = useGroupById(groupId);
  const groups = useGroups();
  const parentGroup = group?.parent ? groups.find((g) => g.id === group.parent) ?? null : null;
  const headerLabel = parentGroup
    ? `${parentGroup.name ?? parentGroup.id.slice(0, 8)}/${group?.name ?? groupId.slice(0, 8)}`
    : (group?.name ?? groupId.slice(0, 8));
  const messages = useMessages(groupId);
  // Retry-backed confidence: bridge owns the dwell + retry ladder so
  // this surface never needs to second-guess an empty EOSE. See
  // `MessagesStatus` in src/lib/nostr-bridge/types.ts.
  const messagesStatus = useMessagesStatus(groupId);
  const reactions = useReactions(groupId);
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const myPubkey = useMyPubkey();
  const relay = useCurrentRelayUrl();
  // Focused fetch of kind 39000 for this groupId — guarantees the channel
  // metadata is fetched even if the global stream missed it. The mobile
  // chat header reads `group.name` for the title; without this fetch the
  // user can stare at the channel id slice forever on a slow / silently-
  // filtering relay.
  useEffect(() => {
    if (!groupId) return;
    if (group) return;
    void nostrActions.fetchGroupMetadata(groupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);
  const channelAdmins = useAdmins(groupId);
  const isChannelAdmin = !!myPubkey && channelAdmins.includes(myPubkey);
  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<MediaPickerTab>('emoji');
  const [draftCustomEmojis, setDraftCustomEmojis] = useState<CustomEmojiMap>({});
  const [draftSticker, setDraftSticker] = useState<MessageSticker | null>(null);
  const [draftVoiceNote, setDraftVoiceNote] = useState<MessageVoiceNote | null>(null);
  const [uploading, setUploading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replyingTo, setReplyingTo] = useState<JsMessage | null>(null);
  const readCursorMs = useReadStateStore((s) => s.groupCursors[groupId]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const scrollKey = useMemo(() => channelScrollPositionKey(relay, groupId), [relay, groupId]);
  const initialAnchor = useMemo(
    () => channelInitialAnchorFromCursor(messages, readCursorMs, myPubkey),
    [messages, myPubkey, readCursorMs],
  );
  const initialAnchorMessageId = initialAnchor.kind === 'message' ? initialAnchor.messageId : null;
  const readThroughLatest = useMemo(
    () => channelCursorHasReadLatest(messages, readCursorMs, myPubkey),
    [messages, myPubkey, readCursorMs],
  );
  const getInitialAnchorElement = useCallback(() => {
    if (!initialAnchorMessageId) return null;
    const scroller = messagesRef.current;
    if (!scroller) return null;
    const target = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(initialAnchorMessageId)}"]`);
    if (!target || !scroller.contains(target)) return null;
    return target;
  }, [initialAnchorMessageId]);
  const scrollKeyRef = useRef(scrollKey);
  useEffect(() => {
    scrollKeyRef.current = scrollKey;
  }, [scrollKey]);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const channelHighlights = useChannelHighlights(groupId, myPubkey);

  // ── @-mention autocomplete ───────────────────────────────────────────
  // Mentions span the whole relay (every visible group's members + admins
  // + creator), not just the current channel — typing `@alice` should find
  // Alice even if she's only in a sister channel. Visible groups already
  // exclude WoT-hidden ones via useGroups() above.
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
  const filteredMentionMembers = useMemo<MemberInfo[]>(() => {
    if (mentionQuery === null) return [];
    // Materialize MemberInfo[] only when the popup is open. metaMap can
    // tick on every kind:0 ingest; eager rebuilds would churn for nothing
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
    return filterMembers(candidates, mentionQuery).slice(0, 6);
  }, [mentionCandidatePubkeys, metaMap, mentionQuery]);
  // Close the popup whenever we change channels — stale @-state from a
  // previous channel shouldn't bleed into a fresh composer.
  useEffect(() => { setMentionQuery(null); }, [groupId]);

  function handleDraftInput(value: string, cursor: number) {
    setDraft(value);
    setDraftSticker(null);
    setDraftVoiceNote(null);
    const q = detectMentionQuery(value, cursor);
    if (q !== mentionQuery) {
      setMentionQuery(q);
      if (q !== null) setMentionIndex(0);
    }
  }
  function pickMention(member: MemberInfo) {
    const ta = composerInputRef.current;
    const cursor = ta?.selectionStart ?? draft.length;
    const { next, cursor: nextCursor } = applyMentionToDraft(draft, cursor, member.pubkey);
    setDraft(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const el = composerInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  }

  // Reset reply target whenever the user navigates to a different channel.
  useEffect(() => { setReplyingTo(null); }, [groupId]);

  // Listen for "Reply" taps from the message-actions sheet. The sheet is
  // mounted at the PhoneShell level so it can't call setState here directly
  // — same indirection the quick-react buttons use.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ msgId: string }>;
      const target = messages.find((m) => m.id === ev.detail.msgId);
      if (target) setReplyingTo(target);
    };
    window.addEventListener('obelisk-mobile:reply', handler);
    return () => window.removeEventListener('obelisk-mobile:reply', handler);
  }, [messages]);

  const handleAttach = async (files: File[]) => {
    if (!files.length || uploading) return;
    setDraftSticker(null);
    setDraftVoiceNote(null);
    setUploading(true);
    try {
      const urls = await Promise.all(files.slice(0, 4).map(uploadToBlossom));
      setDraft((current) => current.trim() ? [current.trim(), ...urls].join(String.fromCharCode(10)) : urls.join(String.fromCharCode(10)));
    } catch (err) {
      console.warn('[mobile] blossom upload failed', err);
    } finally {
      setUploading(false);
    }
  };

  const handleVoiceRecorded = async (file: File, durationSeconds: number) => {
    if (uploading) return;
    setUploading(true);
    try {
      const url = await uploadToBlossom(file);
      setDraft(url);
      setDraftSticker(null);
      setDraftVoiceNote({ url, durationSeconds });
    } catch (err) {
      console.warn("[mobile] blossom voice upload failed", err);
    } finally {
      setUploading(false);
    }
  };

  useChannelScrollPosition({
    scrollKey,
    scrollRef: messagesRef,
    itemCount: messages.length,
    initialAnchorKey: initialAnchorMessageId,
    getInitialAnchorElement,
    ignoreSavedOnInitialRestore: readThroughLatest,
    nearBottomPx: 200,
    onNearBottomChange: (near) => {
      const cur = useChatStore.getState().isNearBottom;
      if (cur !== near) useChatStore.setState({ isNearBottom: near });
    },
  });

  // Auto-scroll to bottom when new messages arrive (only if already near).
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [messages.length]);

  // Top-of-list pagination. Live REQ caps at the background limit; older
  // history is paged in here when the user scrolls near the top. Anchor
  // by pre-load scrollHeight to keep the viewport on the same message.
  const { loadEarlier, loading: loadingEarlier, reachedStart } = useLoadEarlier(groupId);
  const [nearHistoryTop, setNearHistoryTop] = useState(false);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      setNearHistoryTop(el.scrollTop < 80);
      if (el.scrollTop < 80 && !loadingEarlier && !reachedStart) {
        const loadKey = scrollKeyRef.current;
        const prevHeight = el.scrollHeight;
        const prevTop = el.scrollTop;
        void loadEarlier().then((result) => {
          if (result !== 'added') return;
          requestAnimationFrame(() => {
            const e = messagesRef.current;
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
  }, [loadEarlier, loadingEarlier, reachedStart]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    const replyToCopy = replyingTo ? { id: replyingTo.id, pubkey: replyingTo.pubkey } : null;
    // Optimistic — placeholder appears in-list with a spinner; failures
    // surface a retry button on the bubble itself, not in the composer.
    setDraft('');
    setDraftCustomEmojis({});
    setDraftSticker(null);
    setDraftVoiceNote(null);
    setReplyingTo(null);
    const voiceTag = voiceNoteTagForContent(text, draftVoiceNote);
    const emojiTags = [
      ...emojiTagsForContent(text, mergeCustomEmojiMaps(serverEmojis, draftCustomEmojis)),
      ...stickerTagsForContent(text, draftSticker).filter((tag) => tag[0] === 'sticker'),
      ...(voiceTag ? [voiceTag] : []),
    ];
    nostrActions.sendMessage(groupId, text, replyToCopy, emojiTags).catch((err) => {
      console.warn('[mobile] sendMessage scheduling failed', err);
    });
  };

  // Group consecutive messages and pre-compute day dividers
  const renderable = useMemo(() => {
    const out: Array<
      | { type: 'divider'; key: string; label: string }
      | { type: 'msg'; key: string; msg: JsMessage }
    > = [];
    let lastDay: string | null = null;
    for (const m of messages) {
      const k = dayKey(m.createdAt);
      if (k !== lastDay) {
        out.push({ type: 'divider', key: `d-${k}`, label: dayLabel(m.createdAt) });
        lastDay = k;
      }
      out.push({ type: 'msg', key: m.id, msg: m });
    }
    return out;
  }, [messages]);

  return (
    <FileDropZone
      className="screen active"
      data-screen="channel"
      disabled={uploading}
      onFiles={(files) => void handleAttach(files)}
    >
      <div className="chat-header chat-header-compact">
        <div className="chat-row">
          <div className="chat-title-block">
            <button className="back-btn" onClick={back} aria-label={t('common.back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <div className="chat-channel"><span className="hash">#</span>{headerLabel}</div>
          </div>
          <div className="chat-actions">
            <MobileSigningIndicator />
            <button className="icon-btn action-search" onClick={() => go('search')} aria-label={t('common.search')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            </button>
            {isChannelAdmin && (
              <button
                className="icon-btn action-menu"
                onClick={() => setSettingsOpen(true)}
                aria-label={t('desktop.channel.settings')}
                data-testid="mobile-channel-settings-btn"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              </button>
            )}
            <button className="icon-btn action-members" onClick={openMembers} aria-label={t('mobile.members.members')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="4" /><path d="M3 21a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="3" /><path d="M23 19a4 4 0 0 0-7-2.65" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div className="messages-wrap relative flex min-h-0 flex-1 flex-col">
      <div className="messages native-scroll-y" ref={messagesRef}>
        {renderable.length === 0 ? (
          // Bridge-owned confidence: only render "No messages yet" once
          // the retry ladder has exhausted (status === 'empty-confirmed').
          // 'loading' and 'empty-unconfirmed' both keep the spinner up.
          messagesStatus !== 'empty-confirmed' ? (
            <div className="empty-state" data-testid="messages-loading">
              <div className="lc-spinner" aria-hidden="true" />
              <div className="empty-state-title">{t('mobile.channel.loadingMessages')}</div>
            </div>
          ) : (
            <div className="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              <div className="empty-state-title">{t('mobile.channel.noMessages')}</div>
              <div className="empty-state-desc">{t('mobile.channel.noMessagesDescription')}</div>
            </div>
          )
        ) : (
          <>
            {renderable.map((it) =>
              it.type === 'divider' ? (
                <div key={it.key} className="day-divider">{it.label}</div>
              ) : (
                <ChannelMessage
                  key={it.key}
                  msg={it.msg}
                  parent={
                    it.msg.replyToId
                      ? messages.find((x) => x.id === it.msg.replyToId) ?? null
                      : null
                  }
                  myPubkey={myPubkey}
                  isAdmin={isChannelAdmin}
                  groupId={groupId}
                  reactions={reactions[it.msg.id] ?? []}
                  onLongPress={() => openMsgActions({
                    id: it.msg.id,
                    pubkey: it.msg.pubkey,
                    content: it.msg.content,
                    groupId,
                    canModerate: isChannelAdmin,
                    canDeleteOwn: it.msg.pubkey === myPubkey,
                  })}
                  onAvatar={() => openProfile(it.msg.pubkey)}
                />
              ),
            )}
          </>
        )}
      </div>
      {renderable.length > 0 && (
        <HistoryPaginationStatus
          loading={loadingEarlier}
          reachedStart={reachedStart}
          atTop={nearHistoryTop}
          loadingLabel={t('mobile.channel.loadingEarlier')}
          endLabel={t('mobile.channel.noEarlierMessages')}
        />
      )}
      <MentionNavigator scrollRef={messagesRef} eventIds={channelHighlights.eventIds} />
      </div>

      <div className="composer">
        {replyingTo && (
          <div className="composer-reply" data-testid="mobile-reply-preview">
            <div className="composer-reply-info">
              <span className="composer-reply-label">
                {t('mobile.channel.replyingTo')} <ReplyAuthorName pubkey={replyingTo.pubkey} />
              </span>
              <span className="composer-reply-text"><MentionText content={replyingTo.content.slice(0, 80)} /></span>
            </div>
            <button
              type="button"
              className="composer-reply-close"
              onClick={() => setReplyingTo(null)}
              aria-label={t('mobile.channel.cancelReply')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        )}
        {mentionQuery !== null && filteredMentionMembers.length > 0 && (
          <MobileMentionAutocomplete
            members={filteredMentionMembers}
            selectedIndex={mentionIndex}
            onSelect={pickMention}
            onHover={setMentionIndex}
          />
        )}
        <div className="composer-inner">
          {!draftVoiceNote && (<>
          <AttachmentMenu
            disabled={uploading}
            onFiles={(files) => void handleAttach(files)}
            onContact={(value) => {
              setDraftSticker(null);
              setDraftVoiceNote(null);
              setDraft((current) => current + (current ? ' ' : '') + 'nostr:' + value);
            }}
            onNewSticker={() => { setPickerTab("sticker"); setEmojiOpen(true); }}
          />
          <button
            type="button"
            className="composer-emoji"
            aria-label="Open emoji, GIF, and sticker picker"
            onClick={() => { setPickerTab("emoji"); setEmojiOpen(true); }}
          >
            <StickerIcon />
          </button>
          </>)}
          {draftVoiceNote && (
            <VoiceNoteDraft
              note={draftVoiceNote}
              onDiscard={() => { setDraft(''); setDraftVoiceNote(null); }}
            />
          )}
          <input
            ref={composerInputRef}
            className={draftVoiceNote ? "hidden" : "composer-input"}
            value={draft}
            onChange={(e) => handleDraftInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onSelect={(e) => {
              const t = e.currentTarget;
              handleDraftInput(t.value, t.selectionStart ?? t.value.length);
            }}
            placeholder={t('mobile.channel.messagePlaceholder').replace('{name}', group?.name ?? 'channel')}
            onKeyDown={(e) => {
              if (mentionQuery !== null && filteredMentionMembers.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % filteredMentionMembers.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickMention(filteredMentionMembers[mentionIndex]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionQuery(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-btns">
            {draft.trim() ? (
              <button className="composer-send" onClick={() => send()} aria-label={t("common.send")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2z" /></svg>
              </button>
            ) : (
              <VoiceNoteButton disabled={uploading} onRecorded={(file, duration) => void handleVoiceRecorded(file, duration)} />
            )}
          </div>
        </div>
        {emojiOpen && (
          <div className="emoji-sheet-host" onClick={() => setEmojiOpen(false)}>
            <div className="emoji-sheet native-scroll-y" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle" />
              <MessageMediaPicker
                variant="sheet"
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
                }}
                onClose={() => setEmojiOpen(false)}
              />
            </div>
          </div>
        )}
      </div>
      {settingsOpen && group && (
        <ChannelSettingsSheet
          group={group}
          close={() => setSettingsOpen(false)}
        />
      )}
    </FileDropZone>
  );
}

function MobileReplyPreviewRow({
  parent,
  onJump,
}: {
  parent: JsMessage;
  onJump: () => void;
}) {
  const meta = useUserMetadata(parent.pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(parent.pubkey);
  const preview = parent.content.replace(/\s+/g, ' ').slice(0, 120);
  return (
    <button
      type="button"
      className="msg-reply-row"
      onClick={(e) => { e.stopPropagation(); onJump(); }}
    >
      <span className="msg-reply-arrow">↩</span>
      <span className="msg-reply-name">{name}</span>
      <span className="msg-reply-text"><MentionText content={preview} /></span>
    </button>
  );
}

export function ChannelMessage({
  msg,
  parent,
  myPubkey,
  isAdmin,
  groupId,
  reactions,
  onLongPress,
  onAvatar,
}: {
  msg: JsMessage;
  parent?: JsMessage | null;
  myPubkey: string | null;
  isAdmin?: boolean;
  groupId: string;
  reactions: ReadonlyArray<{
    id: string;
    pubkey: string;
    emoji: string;
    customEmojis?: Readonly<Record<string, string>>;
  }>;
  onLongPress: () => void;
  onAvatar: () => void;
}) {
  const meta = useUserMetadata(msg.pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(msg.pubkey);
  const serverEmojis = useChatStore((s) => s.serverEmojis);

  const grouped = useMemo(
    () => groupReactions(reactions, myPubkey, serverEmojis),
    [reactions, myPubkey, serverEmojis],
  );

  const handleReaction = async (
    emoji: string,
    mine: boolean,
    customEmojis?: CustomEmojiMap,
    reactionId?: string | null,
    reactionIds?: ReadonlyArray<string>,
  ) => {
    try {
      if (isAdmin && reactionIds && reactionIds.length > 0) {
        await Promise.all(reactionIds.map((id) => nostrActions.deleteGroupEvent(groupId, id)));
        return;
      }
      if (mine && reactionId) {
        await nostrActions.removeReaction(groupId, reactionId);
        return;
      }
      if (mine) return;
      const emojiTags = emojiTagsForContent(emoji, mergeCustomEmojiMaps(serverEmojis, customEmojis));
      await nostrActions.sendReaction(msg.id, msg.pubkey, emoji, groupId, emojiTags);
    } catch (err) { console.warn('[mobile] sendReaction failed', err); }
  };

  // Long-press for the action sheet — a 500ms touch hold
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPress = () => {
    pressTimer.current = setTimeout(() => onLongPress(), 500);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const onRetry = () => {
    if (!msg.clientTag) return;
    void nostrActions.retryMessage(groupId, msg.clientTag);
  };
  const onDismissFailed = () => {
    if (!msg.clientTag) return;
    void nostrActions.cancelPendingMessage(groupId, msg.clientTag);
  };

  const onJumpToParent = () => {
    if (!parent) return;
    const el = document.querySelector(`[data-msg-id="${parent.id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('msg-flash');
      setTimeout(() => el.classList.remove('msg-flash'), 1200);
    }
  };

  return (
    <div
      data-msg-id={msg.id}
      className={'msg' + (msg.pending ? ' pending' : '') + (msg.failed ? ' failed' : '')}
    >
      <div className="msg-ava" style={avatarStyle(msg.pubkey)} onClick={onAvatar} role="button">
        {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(msg.pubkey))}
      </div>
      <div className="msg-body">
        {parent && <MobileReplyPreviewRow parent={parent} onJump={onJumpToParent} />}
        {msg.replyToId && !parent && (
          <div className="msg-reply-row msg-reply-row-missing">↩ replying to a message</div>
        )}
        <div className="msg-head">
          <span className="msg-name" onClick={onAvatar} role="button">{name}</span>
          <span className="msg-time">{timeOfDay(msg.createdAt)}</span>
          {msg.pending && <span className="msg-spinner" aria-label="Sending" role="status" />}
          <button
            type="button"
            className="msg-more"
            aria-label="Message actions"
            data-testid="mobile-msg-more"
            onClick={onLongPress}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
        </div>
        <div
          className="msg-text"
          onTouchStart={startPress}
          onTouchEnd={cancelPress}
          onTouchMove={cancelPress}
          onTouchCancel={cancelPress}
          onContextMenu={(e) => { e.preventDefault(); onLongPress(); }}
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
          <div className="msg-failed" data-testid="mobile-msg-failed">
            <span className="msg-failed-label">Couldn’t send</span>
            <button
              type="button"
              className="msg-retry"
              onClick={onRetry}
              data-testid="mobile-msg-retry"
            >
              Retry
            </button>
            <button
              type="button"
              className="msg-dismiss"
              onClick={onDismissFailed}
              aria-label="Dismiss failed message"
            >
              ✕
            </button>
          </div>
        )}
        {grouped.length > 0 && (
          <div className="reactions">
            {grouped.map((r) => {
              const resolved = resolveReactionEmoji(r.emoji, r.customEmojis);
              return (
                <button
                  key={r.emoji}
                  className={`reaction ${r.mine ? 'mine' : ''}`}
                  title={isAdmin ? 'Remove reactions for everyone' : r.mine ? 'Remove your reaction' : 'React'}
                  onClick={() => void handleReaction(r.emoji, r.mine, r.customEmojis, r.myReactionId, isAdmin ? r.reactionIds : undefined)}
                >
                  {resolved.kind === 'custom' ? (
                    <img src={resolved.url} alt={`:${resolved.name}:`} style={{ width: 16, height: 16, objectFit: 'contain' }} />
                  ) : resolved.char}{' '}
                  {r.count}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 05 — voice room

function VoiceRoomScreen({ groupId, back, openChat }: { groupId: string; back: () => void; openChat: () => void }) {
  const groups = useGroups();
  const group = groups.find((g) => g.id === groupId) ?? null;
  const activeCallByChannel = useActiveCallByChannel();
  const call = activeCallByChannel[groupId] ?? null;
  const isSfu = group?.kind === 'voice-sfu';
  // Status only shows once a call exists; the topology (SFU vs P2P) is now
  // expressed by the inline tag next to the title, so the subtitle stays
  // empty on the idle "no one's here" view instead of repeating "SFU room".
  const sub =
    call?.status === 'connected' ? 'Live · connected' :
    call?.status === 'starting' ? 'Starting…' :
    call?.status ? call.status :
    null;

  return (
    <div className="screen voice-room-screen active" data-screen="voice-room">
      <div className="voice-room-topbar">
        <button className="back-btn" onClick={back} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="voice-room-meta">
          <div className="voice-room-title">
            <svg className="voice-room-mic-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            </svg>
            <span className="voice-room-name">{group?.name ?? 'Voice channel'}</span>
            {isSfu && <span className="voice-sfu-pill" title="Routed through an SFU">SFU</span>}
          </div>
          {sub && <div className="voice-room-sub">{sub}</div>}
        </div>
      </div>
      <div className="voice-room-stage">
        <VoiceRoom
          channelId={groupId}
          channelName={group?.name ?? undefined}
          chatSlot={null}
          isChatOpen={false}
          onToggleChat={openChat}
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 06 — DMs list

function MobileDmOptInScreen({
  onSecondary,
  secondaryLabel = 'Not now',
}: {
  onSecondary: () => void;
  secondaryLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="screen active" data-screen="dms-list">
      <div className="app-header">
        <h2>{t('dm.title')}</h2>
      </div>
      <DMOptInGate
        surface="mobile"
        secondaryLabel={secondaryLabel}
        onSecondary={onSecondary}
      />
    </div>
  );
}

export function DmsListScreen({
  go,
  selectPeer,
  myFollows,
}: {
  go: (s: ScreenName) => void;
  selectPeer: (peer: string) => void;
  myFollows: ReadonlyArray<string>;
}) {
  const { t } = useTranslation();
  const dms = useDirectMessages();
  const [tab, setTab] = useState<'follows' | 'others'>('follows');

  // Each row computes its own unread via `useDMUnreadCount` against the
  // persisted read-state cursor. The 24h heuristic that used to live here
  // is gone — `useReadStateStore.dmCursors` is the single source of truth
  // (with a 24h bootstrap fallback baked into the selector for first-paint).
  const peers = useMemo(() => {
    const list: Array<{ peer: string; latest: JsDirectMessage }> = [];
    for (const [peer, msgs] of Object.entries(dms)) {
      if (msgs.length === 0) continue;
      const sorted = [...msgs].sort((a, b) => b.createdAt - a.createdAt);
      list.push({ peer, latest: sorted[0] });
    }
    list.sort((a, b) => b.latest.createdAt - a.latest.createdAt);
    return list;
  }, [dms]);

  const followsSet = useMemo(() => new Set(myFollows), [myFollows]);
  const filtered = peers.filter((p) =>
    tab === 'follows' ? followsSet.has(p.peer) : !followsSet.has(p.peer),
  );

  const followsCount = peers.filter((p) => followsSet.has(p.peer)).length;
  const othersCount = peers.length - followsCount;

  const listRef = useRef<HTMLDivElement>(null);
  useScreenScrollMemo(`dms-list:${tab}`, listRef);

  return (
    <div className="screen active" data-screen="dms-list">
      <div className="app-header">
        <h2>{t('dm.title')}</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <MobileSigningIndicator />
          <button className="icon-btn action-search" onClick={() => go('compose-dm')} aria-label={t('common.search')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          </button>
          <button className="icon-btn action-create" onClick={() => go('compose-dm')} aria-label={t('dm.newMessage')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>

      <div className="dms-tabs native-scroll-x">
        <button className={`filter-tab ${tab === 'follows' ? 'active' : ''}`} onClick={() => setTab('follows')}>
          {t('dm.follows')} · {followsCount}
        </button>
        <button className={`filter-tab ${tab === 'others' ? 'active' : ''}`} onClick={() => setTab('others')}>
          {t('dm.others')} · {othersCount}
        </button>
      </div>

      <div className="dms-list-rows native-scroll-y" ref={listRef}>
        {filtered.length === 0 && (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="3" y="11" width="18" height="9" rx="1.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            <div className="empty-state-title">{t('dm.noConversations')}</div>
            <div className="empty-state-desc">{t('dm.emptyMobileDescription')}</div>
          </div>
        )}
        {filtered.map((p) => (
          <DmRow key={p.peer} peer={p.peer} latest={p.latest} youPrefix={t('dm.youPrefix')} onClick={() => selectPeer(p.peer)} />
        ))}
      </div>
    </div>
  );
}

function DmRow({
  peer,
  latest,
  youPrefix,
  onClick,
}: {
  peer: string;
  latest: JsDirectMessage;
  youPrefix: string;
  onClick: () => void;
}) {
  const meta = useUserMetadata(peer);
  const unreadCount = useDMUnreadCount(peer);
  const name = meta?.displayName || meta?.name || shortNpub(peer);
  return (
    <button className={`dm-row ${unreadCount > 0 ? 'unread' : ''}`} onClick={onClick}>
      <div className="dm-ava-list" style={avatarStyle(peer)}>
        {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(peer))}
      </div>
      <div className="dm-meta">
        <div className="dm-row-top">
          <span className="dm-name">{name}</span>
          <span className="dm-time">{relativeTime(latest.createdAt)}</span>
        </div>
        <div className="dm-preview">
          <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="9" rx="1.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          {latest.outgoing ? youPrefix : ''}{latest.content}
        </div>
      </div>
      {unreadCount > 0 && <span className="unread-dot" />}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 07 — DM thread

function DmThreadScreen({
  peer,
  back,
  openProfile,
}: {
  peer: string;
  back: () => void;
  openProfile: (pubkey: string) => void;
}) {
  const { t } = useTranslation();
  const dms = useDirectMessages();
  const meta = useUserMetadata(peer);
  const myPubkey = useMyPubkey();
  const [draft, setDraft] = useState('');
  const msgsRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => {
    const list = (dms[peer] ?? []).filter((message) => message.counterparty === peer);
    return [...list].sort((a, b) => a.createdAt - b.createdAt);
  }, [dms, peer]);

  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    // Optimistic — placeholder appears with a spinner; the bubble surfaces a
    // retry button on failure so we don't gate the composer on send state.
    setDraft('');
    nostrActions.sendDirectMessage(peer, text).catch((err) => {
      console.warn('[mobile] sendDirectMessage scheduling failed', err);
    });
  };

  const onRetry = (clientTag: string) => {
    void nostrActions.retryDirectMessage(peer, clientTag);
  };
  const onDismiss = (clientTag: string) => {
    void nostrActions.cancelPendingDirectMessage(peer, clientTag);
  };

  const peerName = meta?.displayName || meta?.name || shortNpub(peer);

  // Day dividers + bubbles
  const grouped = useMemo(() => {
    const out: Array<
      | { type: 'divider'; key: string; label: string }
      | { type: 'msg'; key: string; msg: JsDirectMessage }
    > = [];
    let lastDay: string | null = null;
    for (const m of messages) {
      const k = dayKey(m.createdAt);
      if (k !== lastDay) {
        out.push({ type: 'divider', key: `d-${k}`, label: dayLabel(m.createdAt) });
        lastDay = k;
      }
      out.push({ type: 'msg', key: m.id, msg: m });
    }
    return out;
  }, [messages]);

  return (
    <div className="screen active" data-screen="dm-thread">
      <div className="dm-header">
        <button className="back-btn" onClick={back} aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="dm-ava-list" style={avatarStyle(peer)} onClick={() => openProfile(peer)}>
          {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(peerName, shortNpub(peer))}
        </div>
        <div className="dm-header-meta" onClick={() => openProfile(peer)}>
          <div className="dm-header-name">{peerName}</div>
          <div className="dm-header-pubkey">
            <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="9" rx="1.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortNpub(peer)} · NIP-04</span>
          </div>
        </div>
      </div>

      <div className="dm-messages native-scroll-y" ref={msgsRef}>
        <div className="dm-encryption-pill">
          <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="9" rx="1.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          {t('dm.encryptedPill')}
        </div>
        {grouped.map((it) =>
          it.type === 'divider' ? (
            <div key={it.key} className="day-divider">{it.label}</div>
          ) : (
            <div
              key={it.key}
              className={
                'dm-bubble '
                + (it.msg.outgoing ? 'outgoing delivered' : 'incoming')
                + (it.msg.pending ? ' pending' : '')
                + (it.msg.failed ? ' failed' : '')
              }
            >
              <div className="dm-bubble-text">{it.msg.content}</div>
              <div className="dm-bubble-meta">
                {it.msg.pending && <span className="dm-bubble-spinner" aria-label={t('common.sending')} role="status" />}
                <span className="dm-bubble-time">{timeOfDay(it.msg.createdAt)}</span>
              </div>
              {it.msg.failed && it.msg.clientTag && (
                <div className="dm-bubble-failed" data-testid="mobile-dm-failed">
                  <span className="dm-bubble-failed-label">{t('dm.failedSend')}</span>
                  <button
                    type="button"
                    className="dm-bubble-retry"
                    onClick={() => onRetry(it.msg.clientTag!)}
                    data-testid="mobile-dm-retry"
                  >
                    {t('common.retry')}
                  </button>
                  <button
                    type="button"
                    className="dm-bubble-dismiss"
                    onClick={() => onDismiss(it.msg.clientTag!)}
                    aria-label={t('dm.dismissFailed')}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          <button className="composer-attach" aria-label={t('dm.attach')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <input
            className="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('dm.placeholderEncrypted')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-btns">
            {draft.trim() ? (
              <button className="composer-send" onClick={() => send()} aria-label={t('common.send')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 14-7-7 14-2-5-5-2z" /></svg>
              </button>
            ) : (
              <button className="composer-emoji" aria-label="Emoji">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 08 — inbox (mentions, replies, DMs, zaps)

type InboxFilter = 'all' | 'mentions' | 'replies' | 'dms' | 'zaps';

function InboxScreen({
  selectGroup,
  selectPeer,
}: {
  go: (s: ScreenName) => void;
  selectGroup: (groupId: string, kind: JsGroup['kind']) => void;
  selectPeer: (peer: string) => void;
}) {
  const { t } = useTranslation();
  const events = useReadStateStore((s) => s.inboxEvents);
  const markInboxRead = useReadStateStore((s) => s.advanceInboxRead);
  const markAllAsRead = useReadStateStore((s) => s.markAllAsRead);
  const groups = useGroups();
  // Read the bridge's loaded peers + groups imperatively at click time so
  // the inbox screen doesn't re-render on every message arrival just to
  // keep these snapshots in sync. The "Mark all read" button needs them to
  // advance the cursors that feed the browser-tab `(N)` badge.
  const handleMarkAll = () => {
    const impl = getBridgeImpl();
    const peers = impl ? Object.keys(impl.dmsByPeer.get()) : [];
    const groupIds = impl ? Object.keys(impl.messagesByGroup.get()) : [];
    markAllAsRead(peers, groupIds);
  };

  const [tab, setTab] = useState<InboxFilter>('all');
  const filtered = useMemo(() => {
    if (tab === 'all') return events;
    const want = tab === 'dms' ? 'dm' : tab === 'mentions' ? 'mention' : tab === 'replies' ? 'reply' : 'zap';
    return events.filter((e) => e.type === want);
  }, [events, tab]);

  const handleJump = (e: InboxEvent) => {
    if (e.type === 'dm') {
      selectPeer(e.senderPubkey);
    } else if (e.channelId) {
      const g = groups.find((x) => x.id === e.channelId);
      selectGroup(e.channelId, g?.kind ?? 'text');
    }
    markInboxRead();
  };

  return (
    <div className="screen active" data-screen="inbox">
      <div className="app-header">
        <h2>{t('inbox.title')}</h2>
        <button className="mark-all-read" onClick={handleMarkAll}>{t('inbox.markAllRead')}</button>
      </div>
      <div className="filter-tabs native-scroll-x">
        <button className={`filter-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>{t('mobile.inbox.all')} · {events.length}</button>
        <button className={`filter-tab ${tab === 'mentions' ? 'active' : ''}`} onClick={() => setTab('mentions')}>{t('mobile.inbox.mentions')}</button>
        <button className={`filter-tab ${tab === 'replies' ? 'active' : ''}`} onClick={() => setTab('replies')}>{t('mobile.inbox.replies')}</button>
        <button className={`filter-tab ${tab === 'dms' ? 'active' : ''}`} onClick={() => setTab('dms')}>DMs</button>
        <button className={`filter-tab ${tab === 'zaps' ? 'active' : ''}`} onClick={() => setTab('zaps')}>{t('mobile.inbox.zaps')}</button>
      </div>
      <div className="activity-list native-scroll-y">
        {filtered.length === 0 && (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>
            <div className="empty-state-title">{t('mobile.inbox.caughtUp')}</div>
            <div className="empty-state-desc">{t('mobile.inbox.emptyDescription')}</div>
          </div>
        )}
        {filtered.map((e) => (
          <InboxCard key={e.id} event={e} onJump={() => handleJump(e)} />
        ))}
      </div>
    </div>
  );
}

function InboxCard({ event, onJump }: { event: InboxEvent; onJump: () => void }) {
  const { t } = useTranslation();
  const meta = useUserMetadata(event.senderPubkey);
  const inboxLastReadAt = useReadStateStore((s) => s.inboxLastReadAt);
  const name = meta?.displayName || meta?.name || shortNpub(event.senderPubkey);
  const tsSec = Math.floor(new Date(event.createdAt).getTime() / 1000);
  const isRead = Date.parse(event.createdAt) <= inboxLastReadAt;
  const typeLabel: Record<InboxEvent['type'], string> = {
    mention: t('mobile.inbox.type.mention'),
    reply: t('mobile.inbox.type.reply'),
    dm: t('inbox.type.dm'),
    zap: t('mobile.inbox.type.zap'),
    everyone: t('mobile.inbox.type.everyone'),
    message: t('mobile.inbox.type.message'),
  };
  return (
    <button
      className={`mention-card ${event.type === 'mention' ? 'urgent' : ''}`}
      style={isRead ? { opacity: 0.65 } : undefined}
      onClick={onJump}
    >
      <div className="mc-context">
        <span className={`notif-type ${event.type}`}>
          {event.type === 'dm' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="9" rx="1.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          )}
          {typeLabel[event.type]}
        </span>
        <span className="mc-time">{relativeTime(tsSec)}</span>
      </div>
      <div className="mc-msg" style={{ marginTop: 6 }}>
        <div className="mc-ava" style={avatarStyle(event.senderPubkey)}>
          {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(event.senderPubkey))}
        </div>
        <div className="mc-body">
          <div className="mc-name" style={{ color: 'var(--app-text)' }}>{name}</div>
          <div className="mc-text" style={{ color: 'var(--app-text-dim)' }}><MentionText content={event.preview ?? ''} /></div>
        </div>
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 09 — profile view

function ProfileViewScreen({
  pubkey,
  back,
  openDm,
}: {
  pubkey: string;
  back: () => void;
  openDm: (peer: string) => void;
}) {
  return <NostrProfile pubkey={pubkey} onClose={back} onMessage={openDm} />;
}

// ───────────────────────────────────────────────────────────────────────────
// 10 — member list

function MemberListScreen({ groupId, back, openProfile }: { groupId: string; back: () => void; openProfile: (p: string) => void }) {
  const { t } = useTranslation();
  const groups = useGroups();
  const group = groups.find((g) => g.id === groupId) ?? null;
  const parentGroup = group?.parent ? groups.find((g) => g.id === group.parent) ?? null : null;
  const headerLabel = parentGroup
    ? `${parentGroup.name ?? parentGroup.id.slice(0, 8)}/${group?.name ?? groupId.slice(0, 8)}`
    : (group?.name ?? groupId.slice(0, 8));
  const admins = useAdmins(groupId);
  const members = useMembers(groupId);
  const membershipReady = useMembershipReady(groupId);

  const adminSet = useMemo(() => new Set(admins), [admins]);
  const nonAdminMembers = useMemo(() => members.filter((m) => !adminSet.has(m)), [members, adminSet]);

  const allPubkeys = useMemo(() => {
    const set = new Set<string>([...admins, ...members]);
    return [...set];
  }, [admins, members]);
  useNostrPresence(allPubkeys);
  // presenceTick re-renders the list on the offline-fade timer.
  useChatStore((s) => s.presenceTick);
  const lastActivityAt = useChatStore((s) => s.lastActivityAt);

  const isOnline = useCallback(
    (pubkey: string) => {
      const at = lastActivityAt[pubkey];
      return !!at && at >= Date.now() - PRESENCE_WINDOW_MS;
    },
    [lastActivityAt],
  );

  const onlineCount = useMemo(
    () => allPubkeys.reduce((n, pk) => (isOnline(pk) ? n + 1 : n), 0),
    [allPubkeys, isOnline],
  );

  return (
    <div className="screen member-list-screen active" data-screen="member-list">
      <div className="chat-header chat-header-compact">
        <div className="chat-row">
          <div className="chat-title-block">
            <button className="back-btn" onClick={back} aria-label={t('common.back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <div className="chat-channel"><span className="hash">#</span>{headerLabel} · {t('mobile.members.label')}</div>
          </div>
          <div className="member-presence-count">{onlineCount}/{allPubkeys.length}</div>
        </div>
      </div>
      <div className="search-body">
        {admins.length > 0 && (
          <>
            <div className="member-section-label">{t('mobile.members.admins')} · {admins.length}</div>
            {admins.map((p) => <MemberRow key={p} pubkey={p} role="admin" online={isOnline(p)} onClick={() => openProfile(p)} />)}
          </>
        )}
        {nonAdminMembers.length > 0 && (
          <>
            <div className="member-section-label">{t('mobile.members.members')} · {nonAdminMembers.length}</div>
            {nonAdminMembers.map((p) => <MemberRow key={p} pubkey={p} online={isOnline(p)} onClick={() => openProfile(p)} />)}
          </>
        )}
        {members.length === 0 && admins.length === 0 && !membershipReady && (
          <div
            className="empty-state"
            data-testid="members-loading"
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}
          >
            <div className="lc-spinner" aria-hidden="true" />
            <div className="empty-state-title">{t('mobile.members.loading')}</div>
          </div>
        )}
        {members.length === 0 && admins.length === 0 && membershipReady && (
          <div className="empty-state">
            <div className="empty-state-title">{t('mobile.members.empty')}</div>
            <div className="empty-state-desc">{t('mobile.members.emptyDescription')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function MemberRow({ pubkey, role, online, onClick }: { pubkey: string; role?: 'admin'; online: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const meta = useUserMetadata(pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(pubkey);
  return (
    <button className="member-row" onClick={onClick}>
      <div className={`dm-ava-list ${online ? '' : 'offline'}`} style={{ ...avatarStyle(pubkey), width: 36, height: 36, fontSize: 12 }}>
        {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(pubkey))}
      </div>
      <div className="member-row-meta">
        <span className="member-row-name">{name}</span>
        <span className="member-row-nip">{meta?.nip05 ?? shortNpub(pubkey)}</span>
      </div>
      {role === 'admin' && <span className="role-badge b-core">{t('mobile.members.admin')}</span>}
      <span className={`member-row-presence ${online ? 'on' : 'off'}`} />
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 11 — compose DM (search + open thread)

export function ComposeDmScreen({ back, selectPeer }: { back: () => void; selectPeer: (peer: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const dms = useDirectMessages();
  const { directHit, nip05Hit, nostrResults, loading } = useNostrUserSearch(query);
  const recent = useMemo(() => Object.keys(dms).slice(0, 20), [dms]);
  const results = useMemo(() => {
    const seen = new Set<string>();
    return [directHit, nip05Hit, ...nostrResults].filter((hit): hit is UserHit =>
      !!hit && !seen.has(hit.pubkey) && !!seen.add(hit.pubkey),
    );
  }, [directHit, nip05Hit, nostrResults]);
  const decoded = npubToHex(query);
  const searching = query.trim().length >= 2;

  return (
    <div className="screen compose-dm-screen active" data-screen="compose-dm">
      <div className="compose-dm-header">
        <button className="compose-dm-cancel" onClick={back}>{t('common.cancel')}</button>
        <h2>{t('dm.newMessage')}</h2>
        <button
          className={`compose-dm-next ${decoded ? 'active' : ''}`}
          disabled={!decoded}
          onClick={() => decoded && selectPeer(decoded)}
        >
          {t('dm.compose.next')}
        </button>
      </div>
      <div className="compose-dm-to">
        <span className="compose-dm-to-label">{t('dm.compose.to')}</span>
        <input
          className="compose-dm-to-input"
          placeholder={t('dm.compose.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="search-section-label">
        {searching ? t('search.users') : t('dm.compose.recent')}
      </div>
      <div className="compose-dm-body">
        {searching && loading && <div className="empty-state-desc">{t('search.searching')}</div>}
        {searching && !loading && results.length === 0 && (
          <div className="empty-state-desc">{t('search.noMatches')}</div>
        )}
        {searching && results.map((hit) => (
          <ComposeUserRow key={hit.pubkey} hit={hit} onClick={() => selectPeer(hit.pubkey)} />
        ))}
        {!searching && recent.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">{t('dm.compose.noRecent')}</div>
            <div className="empty-state-desc">{t('dm.compose.noRecentDescription')}</div>
          </div>
        )}
        {!searching && recent.map((p) => <ComposeRecentRow key={p} peer={p} onClick={() => selectPeer(p)} />)}
      </div>
    </div>
  );
}

function ComposeUserRow({ hit, onClick }: { hit: UserHit; onClick: () => void }) {
  const name = hit.displayName || shortNpub(hit.pubkey);
  return (
    <button className="dm-row" onClick={onClick} data-testid="mobile-user-search-result">
      <div className="dm-ava-list" style={avatarStyle(hit.pubkey)}>
        {hit.picture ? <img src={hit.picture} alt="" /> : initialsFor(name, shortNpub(hit.pubkey))}
      </div>
      <div className="dm-meta">
        <div className="dm-row-top"><span className="dm-name">{name}</span></div>
        <div className="dm-preview">{hit.nip05 ?? shortNpub(hit.pubkey)}</div>
      </div>
    </button>
  );
}

function ComposeRecentRow({ peer, onClick }: { peer: string; onClick: () => void }) {
  const meta = useUserMetadata(peer);
  const name = meta?.displayName || meta?.name || shortNpub(peer);
  return (
    <button className="dm-row" onClick={onClick}>
      <div className="dm-ava-list" style={avatarStyle(peer)}>
        {meta?.picture ? <img src={meta.picture} alt="" /> : initialsFor(name, shortNpub(peer))}
      </div>
      <div className="dm-meta">
        <div className="dm-row-top">
          <span className="dm-name">{name}</span>
        </div>
        <div className="dm-preview">{meta?.nip05 ?? shortNpub(peer)}</div>
      </div>
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 12 — search

export function SearchScreen({
  back,
  selectGroup,
}: {
  back: () => void;
  selectGroup: (groupId: string, kind: JsGroup['kind']) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<'all' | 'from' | 'in' | 'mentions' | 'has-image'>('all');
  const groups = useGroups();
  const relay = useCurrentRelayUrl();

  return (
    <div className="screen search-screen active" data-screen="search">
      <div className="search-header">
        <button className="back-btn" onClick={back} aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <div className="search-input-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            type="search"
            name="obelisk-mobile-search"
            aria-label={t('mobile.search.aria')}
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('mobile.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query && <button className="search-clear" onClick={() => setQuery('')}>×</button>}
        </div>
      </div>
      <div className="search-context-pill">in:{shortHost(relay)}</div>
      <div className="search-filter-chips">
        <button className={`search-chip ${chip === 'all' ? 'active' : ''}`} onClick={() => setChip('all')}>{t('mobile.search.all')}</button>
        <button className={`search-chip ${chip === 'from' ? 'active' : ''}`} onClick={() => setChip('from')}>from:</button>
        <button className={`search-chip ${chip === 'in' ? 'active' : ''}`} onClick={() => setChip('in')}>in:#channel</button>
        <button className={`search-chip ${chip === 'mentions' ? 'active' : ''}`} onClick={() => setChip('mentions')}>mentions:@you</button>
        <button className={`search-chip ${chip === 'has-image' ? 'active' : ''}`} onClick={() => setChip('has-image')}>has:image</button>
      </div>
      <div className="search-section-label">{t('search.channels')}</div>
      <div className="search-body">
        {groups
          .filter((g) => !query || (g.name ?? '').toLowerCase().includes(query.toLowerCase()))
          .slice(0, 30)
          .map((g) => (
            <button key={g.id} className="ch-row" onClick={() => selectGroup(g.id, g.kind)}>
              <span className="ch-icon">#</span>
              <span className="ch-name">{g.name ?? g.id.slice(0, 8)}</span>
            </button>
          ))}
        {!query && (
          <div className="search-empty">
            <div className="search-empty-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            </div>
            {t('mobile.search.channelsHelp')}<br />{t('mobile.search.serverSideHelp')}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 13 — forum (channel-of-channels)

type MobileForumSortBy = 'recent' | 'created';
type MobileForumTagMatch = 'any' | 'all';

interface MobileForumPrefs {
  readonly sortBy: MobileForumSortBy;
  readonly tagMatch: MobileForumTagMatch;
}

const MOBILE_FORUM_DEFAULT_PREFS: MobileForumPrefs = { sortBy: 'recent', tagMatch: 'any' };

function mobileForumPrefsKey(forumGroupId: string): string {
  return `obelisk-dex/forum-prefs-mobile/${forumGroupId}`;
}

function loadMobileForumPrefs(forumGroupId: string): MobileForumPrefs {
  if (typeof window === 'undefined') return MOBILE_FORUM_DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(mobileForumPrefsKey(forumGroupId));
    if (!raw) return MOBILE_FORUM_DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<MobileForumPrefs>;
    return {
      sortBy: parsed.sortBy === 'created' ? 'created' : 'recent',
      tagMatch: parsed.tagMatch === 'all' ? 'all' : 'any',
    };
  } catch {
    return MOBILE_FORUM_DEFAULT_PREFS;
  }
}

function saveMobileForumPrefs(forumGroupId: string, prefs: MobileForumPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(mobileForumPrefsKey(forumGroupId), JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

/**
 * Mobile equivalent of `src/components/chat/ForumView`. Same Discord-style
 * chrome (search-or-create, sort sheet, tag chips) and same UX rule that
 * empty / aborted threads stay hidden until their first message — but laid
 * out for a phone screen and styled with the mobile CSS primitives.
 *
 * Gallery view is intentionally not exposed on mobile: at the column count
 * a phone can sensibly show, gallery cards land at roughly the same size as
 * list cards and the toggle isn't worth the dropdown real-estate.
 */
function ForumScreen({
  groupId,
  back,
  selectChild,
}: {
  groupId: string;
  back: () => void;
  selectChild: (childId: string) => void;
}) {
  const groups = useGroups();
  const childrenByParent = useChildrenByParent();
  const groupMetadataEose = useGroupMetadataEose();
  const messagesByGroup = useMessagesByGroup();
  const group = groups.find((g) => g.id === groupId);
  const relay = useCurrentRelayUrl();
  const forumTags: ReadonlyArray<JsForumTag> = group?.forumTags ?? [];
  const childIds = childrenByParent[groupId] ?? [];
  const children = useMemo<JsGroup[]>(() => {
    const byId = new Map(groups.map((g) => [g.id, g] as const));
    return childIds.map((id) => byId.get(id)).filter(Boolean) as JsGroup[];
  }, [childIds, groups]);

  const [prefs, setPrefs] = useState<MobileForumPrefs>(() => loadMobileForumPrefs(groupId));
  useEffect(() => {
    setPrefs(loadMobileForumPrefs(groupId));
  }, [groupId]);
  const updatePrefs = (patch: Partial<MobileForumPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveMobileForumPrefs(groupId, next);
      return next;
    });
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<ReadonlyArray<string>>([]);
  const [showNewThread, setShowNewThread] = useState(false);
  const [showSort, setShowSort] = useState(false);
  const [prefillTitle, setPrefillTitle] = useState('');

  useEffect(() => {
    setSearchQuery('');
    setSelectedTagIds([]);
  }, [groupId]);

  const exactMatch = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return children.some((t) => (t.name ?? '').toLowerCase() === q);
  }, [children, searchQuery]);

  const visibleThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = children.filter((t) => {
      if (q && !(t.name ?? '').toLowerCase().includes(q)) return false;
      if (selectedTagIds.length > 0) {
        const set = new Set(t.topics);
        if (prefs.tagMatch === 'all') {
          for (const id of selectedTagIds) if (!set.has(id)) return false;
        } else {
          if (!selectedTagIds.some((id) => set.has(id))) return false;
        }
      }
      return true;
    });
    filtered.sort((a, b) => {
      const aMsgs = messagesByGroup[a.id] ?? [];
      const bMsgs = messagesByGroup[b.id] ?? [];
      const aT = prefs.sortBy === 'recent'
        ? aMsgs[aMsgs.length - 1]?.createdAt ?? 0
        : aMsgs[0]?.createdAt ?? 0;
      const bT = prefs.sortBy === 'recent'
        ? bMsgs[bMsgs.length - 1]?.createdAt ?? 0
        : bMsgs[0]?.createdAt ?? 0;
      return bT - aT;
    });
    return filtered;
  }, [children, searchQuery, selectedTagIds, prefs, messagesByGroup]);

  const threadsLoading = children.length === 0 && !groupMetadataEose;
  const openNewThread = (initial = '') => {
    setPrefillTitle(initial);
    setShowNewThread(true);
  };
  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allActive = selectedTagIds.length === 0;
  const canCreateFromSearch = !exactMatch && searchQuery.trim().length > 0;

  return (
    <div className="screen forum-screen active" data-screen="forum">
      <div className="chat-header">
        <div className="chat-breadcrumb">
          <button className="back-btn" onClick={back} style={{ marginLeft: -6 }} aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <span className="space-name-bc">{shortHost(relay)}</span>
          <span className="sep">/</span>
          <span>{group?.name ?? 'forum'}</span>
        </div>
        <div className="chat-row">
          <div className="chat-title-block">
            <div className="chat-channel"><span className="hash">#</span>{group?.name ?? 'forum'}</div>
            <span className="role-badge" style={{ marginLeft: 6 }}>forum</span>
          </div>
        </div>
      </div>

      <div className="forum-chrome" data-testid="mobile-forum-chrome">
        <form
          className="forum-search-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreateFromSearch) openNewThread(searchQuery.trim());
          }}
        >
          <div className="search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={canCreateFromSearch ? 'Tap + to create…' : 'Search or create a post…'}
              aria-label="Search or create a thread"
              data-testid="mobile-forum-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="forum-new-pill"
            onClick={() => openNewThread('')}
            data-testid="mobile-forum-new-thread-btn"
            aria-label="New thread"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </form>
        <div className="forum-filter-row">
          <button
            type="button"
            className="forum-chip muted"
            onClick={() => setShowSort(true)}
            data-testid="mobile-forum-sort-trigger"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16" /><path d="m3 8 4-4 4 4" /><path d="M17 20V4" /><path d="m21 16-4 4-4-4" /></svg>
            Sort
          </button>
          {forumTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={`forum-chip ${selectedTagIds.includes(tag.id) ? 'active' : ''}`}
              onClick={() => toggleTag(tag.id)}
              data-testid={`mobile-forum-tag-${tag.id}`}
              aria-pressed={selectedTagIds.includes(tag.id)}
            >
              {tag.emoji && <span>{tag.emoji}</span>}
              <span>{tag.name}</span>
            </button>
          ))}
          <button
            type="button"
            className={`forum-chip ${allActive ? '' : 'muted'}`}
            onClick={() => setSelectedTagIds([])}
            data-testid="mobile-forum-tag-all"
            aria-pressed={allActive}
          >
            All
          </button>
        </div>
      </div>

      <div className="forum-list native-scroll-y">
        {threadsLoading ? (
          <div className="empty-state" data-testid="mobile-forum-loading">
            <div className="empty-state-title">Loading threads…</div>
          </div>
        ) : children.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No threads yet</div>
            <div className="empty-state-desc">Tap + to start one.</div>
          </div>
        ) : visibleThreads.length === 0 ? (
          <div className="empty-state" data-testid="mobile-forum-no-matches">
            <div className="empty-state-title">
              No threads match {searchQuery.trim() ? `"${searchQuery.trim()}"` : 'the selected tags'}.
            </div>
            {searchQuery.trim() && (
              <button
                type="button"
                className="forum-new-pill"
                onClick={() => openNewThread(searchQuery.trim())}
                style={{ marginTop: 10 }}
              >
                Create &ldquo;{searchQuery.trim()}&rdquo;
              </button>
            )}
          </div>
        ) : (
          visibleThreads.map((c) => (
            <MobileForumCard
              key={c.id}
              group={c}
              forumTags={forumTags}
              onClick={() => selectChild(c.id)}
            />
          ))
        )}
      </div>

      {showNewThread && (
        <NewThreadSheet
          forumGroupId={groupId}
          forumTags={forumTags}
          initialTitle={prefillTitle}
          isPublic={group?.isPublic ?? true}
          isHidden={group?.isHidden ?? false}
          isRestricted={group?.isRestricted ?? false}
          isOpen={group?.isOpen ?? true}
          close={() => setShowNewThread(false)}
          onCreated={(childId) => {
            setShowNewThread(false);
            setSearchQuery('');
            selectChild(childId);
          }}
        />
      )}
      {showSort && (
        <ForumSortSheet
          prefs={prefs}
          onChange={updatePrefs}
          close={() => setShowSort(false)}
        />
      )}
    </div>
  );
}

function resolveMobileTopics(
  topics: ReadonlyArray<string>,
  forumTags: ReadonlyArray<JsForumTag>,
): JsForumTag[] {
  if (topics.length === 0 || forumTags.length === 0) return [];
  const byId = new Map(forumTags.map((t) => [t.id, t] as const));
  const seen = new Set<string>();
  const out: JsForumTag[] = [];
  for (const id of topics) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ft = byId.get(id);
    if (ft) out.push(ft);
  }
  return out;
}

function MobileForumCard({
  group,
  forumTags,
  onClick,
}: {
  group: JsGroup;
  forumTags: ReadonlyArray<JsForumTag>;
  onClick: () => void;
}) {
  const messages = useMessages(group.id);
  // Bridge-owned retry ladder replaces the old UI dwell timer — see
  // src/lib/nostr-bridge/types.ts MessagesStatus.
  const messagesStatus = useMessagesStatus(group.id);
  const op = messages[0] ?? null;
  const lastMsg = messages[messages.length - 1] ?? null;
  const opMeta = useUserMetadata(op?.pubkey ?? null);
  const lastMeta = useUserMetadata(lastMsg?.pubkey ?? null);
  const tags = useMemo(() => resolveMobileTopics(group.topics, forumTags), [group.topics, forumTags]);
  // Hide truly-empty threads (matches the desktop forum UX rule).
  if (!op || !lastMsg) {
    if (messagesStatus === 'empty-confirmed') return null;
    // Skeleton-ish: render the card with whatever we have so the user knows
    // the thread exists and is incoming.
    return (
      <button className="forum-card" onClick={onClick} data-testid="mobile-forum-card-skeleton" data-thread-id={group.id}>
        <div className="forum-card-row">
          <div className="dm-ava-list" style={{ ...avatarStyle(group.id), width: 36, height: 36, fontSize: 12 }}>
            {group.picture ? <img src={group.picture} alt="" /> : initialsFor(group.name, group.id.slice(0, 2).toUpperCase())}
          </div>
          <div className="forum-card-body">
            <div className="forum-card-title">{group.name ?? group.id.slice(0, 8)}</div>
            <div className="forum-card-preview" style={{ opacity: 0.6 }}>Loading…</div>
          </div>
        </div>
      </button>
    );
  }
  const opName = opMeta?.displayName || opMeta?.name || `${op.pubkey.slice(0, 8)}…`;
  const lastName = lastMeta?.displayName || lastMeta?.name || `${lastMsg.pubkey.slice(0, 8)}…`;
  return (
    <button
      className="forum-card"
      onClick={onClick}
      data-testid="mobile-forum-card"
      data-thread-id={group.id}
    >
      <div className="forum-card-row">
        <div className="dm-ava-list" style={{ ...avatarStyle(group.id), width: 36, height: 36, fontSize: 12 }}>
          {opMeta?.picture ? (
            <img src={opMeta.picture} alt="" />
          ) : group.picture ? (
            <img src={group.picture} alt="" />
          ) : (
            initialsFor(group.name, group.id.slice(0, 2).toUpperCase())
          )}
        </div>
        <div className="forum-card-body">
          <div className="forum-card-title">{group.name ?? group.id.slice(0, 8)}</div>
          <div className="forum-card-preview">{op.content}</div>
          {tags.length > 0 && (
            <div className="forum-card-tags">
              {tags.map((t) => (
                <span key={t.id} className="forum-card-tag" data-testid={`mobile-thread-tag-${t.id}`}>
                  {t.emoji && <span>{t.emoji}</span>}
                  <span>{t.name}</span>
                </span>
              ))}
            </div>
          )}
          <div className="forum-card-meta">
            <span><strong>OP</strong> {opName}</span>
            <span>{messages.length} {messages.length === 1 ? 'msg' : 'msgs'}</span>
            <span>last {lastName}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function ForumSortSheet({
  prefs,
  onChange,
  close,
}: {
  prefs: MobileForumPrefs;
  onChange: (p: Partial<MobileForumPrefs>) => void;
  close: () => void;
}) {
  return (
    <div className="sheet-host" data-screen="forum-sort" data-testid="mobile-forum-sort-sheet">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y">
        <div className="sheet-handle" />
        <div className="zap-title">Sort &amp; view</div>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Sort by</label>
          <SortSheetRow
            label="Recently active"
            checked={prefs.sortBy === 'recent'}
            onClick={() => onChange({ sortBy: 'recent' })}
            testId="mobile-forum-sort-recent"
          />
          <SortSheetRow
            label="Creation date"
            checked={prefs.sortBy === 'created'}
            onClick={() => onChange({ sortBy: 'created' })}
            testId="mobile-forum-sort-created"
          />
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: 12 }}>Tag matching</label>
          <SortSheetRow
            label="Match any"
            checked={prefs.tagMatch === 'any'}
            onClick={() => onChange({ tagMatch: 'any' })}
            testId="mobile-forum-match-any"
          />
          <SortSheetRow
            label="Match all"
            checked={prefs.tagMatch === 'all'}
            onClick={() => onChange({ tagMatch: 'all' })}
            testId="mobile-forum-match-all"
          />
        </section>
        <div className="setup-actions">
          <button
            type="button"
            className="forum-new-pill"
            onClick={close}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function SortSheetRow({
  label,
  checked,
  onClick,
  testId,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 4px',
        background: 'transparent',
        border: 'none',
        color: 'var(--app-text)',
        fontSize: 14,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span>{label}</span>
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          border: `2px solid ${checked ? 'var(--accent)' : 'var(--app-line)'}`,
          background: checked ? 'var(--accent)' : 'transparent',
          flexShrink: 0,
        }}
      />
    </button>
  );
}

function NewThreadSheet({
  forumGroupId,
  forumTags,
  initialTitle,
  isPublic,
  isHidden,
  isRestricted,
  isOpen,
  close,
  onCreated,
}: {
  forumGroupId: string;
  forumTags: ReadonlyArray<JsForumTag>;
  initialTitle: string;
  isPublic: boolean;
  isHidden: boolean;
  isRestricted: boolean;
  isOpen: boolean;
  close: () => void;
  onCreated: (childId: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<ReadonlyArray<string>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = useSignerReady();
  const myPubkey = useMyPubkey();
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const MAX_TAGS = 5;

  const toggleTag = (id: string) => {
    setSelectedTagIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TAGS) return prev;
      return [...prev, id];
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim() || submitting || !myPubkey) return;
    setSubmitting(true);
    setError(null);
    try {
      const childId = await nostrActions.createGroup({
        name: title.trim(),
        about: undefined,
        isPublic,
        isHidden,
        isRestricted,
        isOpen,
        parent: forumGroupId,
        topics: selectedTagIds,
      });
      await nostrActions.sendMessage(
        childId,
        body.trim(),
        null,
        emojiTagsForContent(body.trim(), serverEmojis),
      );
      onCreated(childId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sheet-host" data-screen="new-thread" data-testid="mobile-new-thread-sheet">
      <div className="sheet-backdrop" onClick={close} />
      <form className="sheet native-scroll-y" onSubmit={onSubmit} style={{ maxHeight: '92%' }}>
        <div className="sheet-handle" />
        <div className="zap-title">New thread</div>
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em' }}>Title</label>
          <div className="setup-input-wrap">
            <input
              autoFocus
              className="setup-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Thread title"
              maxLength={140}
              data-testid="mobile-new-thread-title"
            />
          </div>
          <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: 6 }}>First message</label>
          <textarea
            className="setup-textarea"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What's the post about?"
            rows={5}
            data-testid="mobile-new-thread-body"
          />
          {forumTags.length > 0 && (
            <>
              <label style={{ fontSize: 10, color: 'var(--app-text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: 6 }}>
                Tags ({selectedTagIds.length}/{MAX_TAGS})
              </label>
              <div className="forum-filter-row" style={{ flexWrap: 'wrap', overflow: 'visible', margin: 0, padding: 0 }} data-testid="mobile-new-thread-tag-picker">
                {forumTags.map((tag) => {
                  const active = selectedTagIds.includes(tag.id);
                  const disabled = !active && selectedTagIds.length >= MAX_TAGS;
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      disabled={disabled}
                      className={`forum-chip ${active ? 'active' : ''}`}
                      style={{ opacity: disabled ? 0.4 : 1 }}
                      data-testid={`mobile-new-thread-tag-${tag.id}`}
                      aria-pressed={active}
                    >
                      {tag.emoji && <span>{tag.emoji}</span>}
                      <span>{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {error && <div style={{ color: '#fca5a5', fontSize: 12 }}>{error}</div>}
        </section>
        <div className="setup-actions" style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={close}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: 12,
              background: 'transparent',
              border: '1px solid var(--app-line)',
              color: 'var(--app-text-dim)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready || submitting || !title.trim() || !body.trim()}
            className="forum-new-pill"
            style={{ flex: 1, justifyContent: 'center', padding: '12px' }}
            data-testid="mobile-new-thread-submit"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 14 — message actions sheet (over channel)

export function MessageActionsSheet({
  msg,
  close,
  onZap,
}: {
  msg: {
    id: string;
    pubkey: string;
    content: string;
    groupId?: string;
    canModerate?: boolean;
    canDeleteOwn?: boolean;
  };
  close: () => void;
  onZap: () => void;
}) {
  const meta = useUserMetadata(msg.pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(msg.pubkey);
  const [pickerOpen, setPickerOpen] = useState(false);
  const canDeleteMessage = !!msg.groupId && (msg.canModerate || msg.canDeleteOwn);
  const deleteMessage = async () => {
    if (!msg.groupId) return;
    const label = msg.canModerate ? 'Delete this message for everyone?' : 'Delete your message?';
    if (typeof window !== 'undefined' && !window.confirm(label)) return;
    if (msg.canModerate) await nostrActions.deleteGroupEvent(msg.groupId, msg.id);
    else await nostrActions.removeMessage(msg.groupId, msg.id);
    close();
  };
  const emitReaction = (emoji: string, custom?: PickedCustomEmoji) => {
    try {
      window.dispatchEvent(new CustomEvent('obelisk-mobile:react', {
        detail: {
          msg,
          emoji,
          customEmojis: custom ? { [custom.name]: custom.url } : undefined,
        },
      }));
    } catch { /* ignore */ }
  };

  return (
    <div className="sheet-host" data-screen="msg-actions">
      <div className="ma-context">
        <div className="ma-context-msg">
          <div className="ma-context-msg-name">{name}</div>
          <div className="ma-context-msg-text">{msg.content}</div>
        </div>
      </div>
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y">
        <div className="sheet-handle" />
        <div className="ma-quick-reactions">
          {['👍', '❤️', '🚀', '🔥', '👀', '+'].map((e) => (
            <button key={e} className="ma-quick-react" onClick={() => {
              if (e === '+') {
                setPickerOpen(true);
                return;
              }
              emitReaction(e);
              close();
            }}>{e}</button>
          ))}
        </div>
        {pickerOpen && (
          <div className="emoji-sheet-host" onClick={() => setPickerOpen(false)}>
            <div className="emoji-sheet native-scroll-y" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-handle" />
              <EmojiPicker
                variant="sheet"
                onPick={(emoji, custom) => {
                  emitReaction(emoji, custom);
                  close();
                }}
                onClose={() => setPickerOpen(false)}
              />
            </div>
          </div>
        )}
        <div className="ma-action-list native-scroll-y">
          <button
            className="ma-action"
            data-testid="mobile-msg-actions-reply"
            onClick={() => {
              try {
                window.dispatchEvent(
                  new CustomEvent('obelisk-mobile:reply', { detail: { msgId: msg.id } }),
                );
              } catch { /* ignore */ }
              close();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
            Reply
          </button>
          <button className="ma-action" onClick={() => { try { navigator.clipboard?.writeText(msg.content); } catch { /* ignore */ } close(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Copy text
          </button>
          <button className="ma-action zap" onClick={onZap}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-2 8 10-12h-7l2-8z" /></svg>
            Send zap
          </button>
          <button className="ma-action" onClick={() => { try { navigator.clipboard?.writeText(msg.id); } catch { /* ignore */ } close(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Copy event id
          </button>
          {canDeleteMessage && (
            <button
              className="ma-action danger"
              data-testid="mobile-msg-actions-delete"
              onClick={() => { void deleteMessage(); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" /></svg>
              {msg.canModerate ? 'Delete for everyone' : 'Delete message'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 15 — zap modal sheet

function ZapModalSheet({
  msg,
  close,
}: {
  msg: { id: string; pubkey: string; content: string };
  close: () => void;
}) {
  const meta = useUserMetadata(msg.pubkey);
  const name = meta?.displayName || meta?.name || shortNpub(msg.pubkey);
  const [amount, setAmount] = useState(2100);
  const presets = [
    { v: 21, label: '21' },
    { v: 100, label: '100' },
    { v: 500, label: '500' },
    { v: 2100, label: '2.1k' },
    { v: 5000, label: '5k' },
  ];

  return (
    <div className="sheet-host" data-screen="zap-modal">
      <div className="sheet-backdrop" onClick={close} />
      <div className="sheet native-scroll-y">
        <div className="sheet-handle" />
        <div className="zap-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-2 8 10-12h-7l2-8z" /></svg>
          Send a zap
        </div>
        <div className="zap-recipient">
          <NameAvatar pubkey={msg.pubkey} name={name} picture={meta?.picture} className="me-avatar" size={40} />
          <div>
            <div style={{ fontWeight: 700, color: 'var(--app-text)', fontSize: 14 }}>{name}</div>
            {meta?.nip05 && <div style={{ fontSize: 11, color: 'var(--accent)' }}>{meta.nip05}</div>}
          </div>
        </div>
        <div className="zap-amounts">
          {presets.map((p) => (
            <button
              key={p.v}
              className={`zap-amount ${amount === p.v ? 'active' : ''}`}
              onClick={() => setAmount(p.v)}
            >
              {p.label}
              <span className="zap-amount-sub">sats</span>
            </button>
          ))}
          <button className="zap-amount">···<span className="zap-amount-sub">custom</span></button>
        </div>
        <div className="zap-memo">"{msg.content.slice(0, 80)}{msg.content.length > 80 ? '…' : ''}"</div>
        <div className="zap-wallet">
          <span className="settings-status-dot ok" />
          Wallet · NWC · check on settings
        </div>
        <button className="btn-primary" onClick={close}>⚡ Send {amount.toLocaleString()} sats</button>
        <button className="btn-cancel" onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 16 — settings · profile

function DisconnectConfirmSheet({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="sheet-host" data-screen="disconnect-confirm">
      <div className="sheet-backdrop" onClick={onCancel} />
      <div className="sheet native-scroll-y">
        <div className="sheet-handle" />
        <div className="confirm-sheet-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </div>
        <div className="confirm-sheet-title">{t('mobile.settings.disconnectTitle')}</div>
        <div className="confirm-sheet-desc">
          {t('mobile.settings.disconnectDescription')}
        </div>
        <button className="settings-btn-danger" onClick={onConfirm} data-testid="disconnect-confirm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {t('mobile.settings.disconnectConfirm')}
        </button>
        <button className="btn-cancel" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

export function SettingsProfileScreen({ go }: { go: (s: ScreenName) => void }) {
  const { t } = useTranslation();
  const myPubkey = useMyPubkey();

  return (
    <div className="screen active" data-screen="settings-profile">
      <div className="app-header">
        <h2>{t("settings.you")}</h2>
      </div>
      <div className="settings-tabs native-scroll-x">
        <button className="settings-tab active">{t("settings.profile")}</button>
        <button className="settings-tab" onClick={() => go("settings-prefs")}>{t("settings.preferences")}</button>
      </div>
      <div className="min-h-0 flex-1">
        {myPubkey && (
          <NostrProfile
            pubkey={myPubkey}
            onClose={() => {}}
            settingsMode
            onEditProfile={() => go("profile-edit")}
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 16b — settings · profile · edit

export function EditProfileScreen({ go }: { go: (s: ScreenName, dir?: 'forward' | 'back') => void }) {
  const { t } = useTranslation();
  const myPubkey = useMyPubkey();
  const meta = useUserMetadata(myPubkey);
  const signerReady = useSignerReady();

  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [picture, setPicture] = useState('');
  const [banner, setBanner] = useState('');
  const [nip05, setNip05] = useState('');
  const [lud16, setLud16] = useState('');
  const [website, setWebsite] = useState('');
  const [picturePreview, setPicturePreview] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [pictureFile, setPictureFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const markDirty = () => { dirtyRef.current = true; };

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  // Hydrate from kind:0 once it lands. Don't clobber user edits.
  useEffect(() => {
    if (!meta || dirtyRef.current) return;
    setName(meta.displayName || meta.name || '');
    setAbout(meta.about || '');
    setPicture(meta.picture || '');
    setBanner(meta.banner || '');
    setNip05(meta.nip05 || '');
    setLud16(meta.lud16 || '');
    setWebsite(meta.website || '');
  }, [meta]);

  // Clean up object URLs on unmount.
  useEffect(() => {
    return () => {
      if (picturePreview) URL.revokeObjectURL(picturePreview);
      if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    };
  }, [picturePreview, bannerPreview]);

  const pickAvatar = (file: File) => {
    if (!file.type.startsWith('image/')) { setError(t('mobile.settings.imageOnly')); return; }
    if (file.size > 10 * 1024 * 1024) { setError(t('mobile.settings.imageTooLarge')); return; }
    setError(null);
    markDirty();
    setPictureFile(file);
    if (picturePreview) URL.revokeObjectURL(picturePreview);
    setPicturePreview(URL.createObjectURL(file));
  };

  const pickBanner = (file: File) => {
    if (!file.type.startsWith('image/')) { setError(t('mobile.settings.imageOnly')); return; }
    if (file.size > 10 * 1024 * 1024) { setError(t('mobile.settings.imageTooLarge')); return; }
    setError(null);
    markDirty();
    setBannerFile(file);
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    setBannerPreview(URL.createObjectURL(file));
  };

  const nameTrimmed = name.trim();
  const nameValid = nameTrimmed.length > 0;
  const busy = saving || uploadingAvatar || uploadingBanner;

  const save = async () => {
    if (!nameValid || busy) return;
    setSaving(true);
    setError(null);
    try {
      let finalPicture = picture;
      let finalBanner = banner;
      if (pictureFile) {
        setUploadingAvatar(true);
        try { finalPicture = await uploadToBlossom(pictureFile); }
        finally { setUploadingAvatar(false); }
      }
      if (bannerFile) {
        setUploadingBanner(true);
        try { finalBanner = await uploadToBlossom(bannerFile); }
        finally { setUploadingBanner(false); }
      }
      if (!signerReady) throw new Error(t('user.notSignedIn'));
      await nostrActions.editUserMetadata({
        name: nameTrimmed,
        displayName: nameTrimmed,
        about: about.trim(),
        picture: finalPicture.trim(),
        banner: finalBanner.trim(),
        nip05: nip05.trim(),
        lud16: lud16.trim(),
        website: website.trim(),
      });
      go('settings-profile', 'back');
    } catch (err) {
      console.warn('[mobile] publishProfile failed', err);
      setError(err instanceof Error ? err.message : t('mobile.settings.publishFailed'));
    } finally {
      setSaving(false);
    }
  };

  const currentBanner = bannerPreview || banner;
  const currentPicture = picturePreview || picture;

  return (
    <div className="screen active" data-screen="profile-edit">
      <div className="setup-header">
        <button
          className="back-btn"
          onClick={() => go('settings-profile', 'back')}
          aria-label={t('common.back')}
          disabled={busy}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <h2>{t('mobile.settings.editProfile')}</h2>
        <button
          className="setup-skip save-action"
          onClick={save}
          disabled={!nameValid || busy}
          data-testid="save-profile"
        >
          {saving ? t('common.saving') : uploadingAvatar || uploadingBanner ? t('common.uploading') : t('common.save')}
        </button>
      </div>
      <div className="setup-body edit-profile-body">
        {error && <div className="edit-error" role="alert">{error}</div>}

        <button
          type="button"
          className={`edit-banner-tap ${currentBanner ? '' : 'empty'} ${uploadingBanner ? 'uploading' : ''}`}
          onClick={() => bannerInputRef.current?.click()}
          aria-label={t('mobile.settings.changeBannerImage')}
          data-testid="edit-banner-tap"
        >
          {currentBanner && <img src={currentBanner} alt="" />}
          <div className="edit-banner-overlay">
            {uploadingBanner ? (
              <span className="edit-uploading-spinner" aria-hidden="true" />
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{currentBanner ? t('mobile.settings.changeBanner') : t('mobile.settings.addBanner')}</span>
              </>
            )}
          </div>
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pickBanner(f); e.target.value = ''; }}
          />
        </button>

        <div className="edit-avatar-row">
          <button
            type="button"
            className={`edit-avatar-tap ${currentPicture ? '' : 'empty'} ${uploadingAvatar ? 'uploading' : ''}`}
            onClick={() => avatarInputRef.current?.click()}
            aria-label={t('mobile.settings.changeProfilePicture')}
            data-testid="edit-avatar-tap"
          >
            <NameAvatar pubkey={myPubkey ?? ''} name={name} picture={currentPicture} size={88} className="me-avatar" />
            <div className="edit-avatar-overlay">
              {uploadingAvatar ? (
                <span className="edit-uploading-spinner" aria-hidden="true" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              )}
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) pickAvatar(f); e.target.value = ''; }}
            />
          </button>
          <div className="edit-avatar-tip">
            {t('mobile.settings.uploadTip')}
          </div>
        </div>

        <div className="edit-fields">
          <div className="setup-field">
            <label>{t('mobile.settings.displayName')}</label>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={name}
                onChange={(e) => { markDirty(); setName(e.target.value); }}
                placeholder={t('mobile.settings.yourName')}
                maxLength={50}
                data-testid="edit-name"
              />
            </div>
          </div>
          <div className="setup-field">
            <label>{t('user.about')}</label>
            <textarea
              className="setup-textarea"
              value={about}
              onChange={(e) => { markDirty(); setAbout(e.target.value); }}
              placeholder={t('mobile.settings.aboutPlaceholder')}
              maxLength={500}
              rows={3}
              data-testid="edit-about"
            />
          </div>
          <div className="setup-field">
            <label>NIP-05</label>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={nip05}
                onChange={(e) => { markDirty(); setNip05(e.target.value); }}
                placeholder="you@domain.com"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
          </div>
          <div className="setup-field">
            <label>{t('mobile.settings.lightningAddress')}</label>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={lud16}
                onChange={(e) => { markDirty(); setLud16(e.target.value); }}
                placeholder="you@walletofsatoshi.com"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
          </div>
          <div className="setup-field">
            <label>{t('user.field.website')}</label>
            <div className="setup-input-wrap">
              <input
                className="setup-input"
                value={website}
                onChange={(e) => { markDirty(); setWebsite(e.target.value); }}
                placeholder="https://…"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
          </div>
        </div>
      </div>
      <div className="setup-actions">
        <button
          className="btn-primary"
          onClick={save}
          disabled={!nameValid || busy}
        >
          {saving ? t('common.saving') : uploadingAvatar || uploadingBanner ? t('common.uploading') : t('mobile.settings.saveChanges')}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 17 — settings · preferences

export function SettingsPrefsScreen({ go }: { go: (s: ScreenName) => void }) {
  const { t } = useTranslation();
  const dmOptInEnabled = useDmOptInEnabled();
  const prefs = usePreferences();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  const clearLocalCache = () => {
    if (!window.confirm(t('preferences.localData.confirm.description'))) return;
    clearAllClientCacheExceptSession();
    setTimeout(() => window.location.reload(), 0);
  };

  if (appearanceOpen) {
    return (
      <div className="screen active" data-screen="settings-appearance">
        <div className="app-header">
          <button className="back-btn" type="button" onClick={() => setAppearanceOpen(false)} aria-label={t('common.back')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <h2>{t('preferences.appearance.title')}</h2>
        </div>
        <div className="settings-body">
          <AppearancePreferenceControls variant="mobile" />
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="screen active" data-screen="settings-prefs">
      <div className="app-header">
        <h2>{t('settings.you')}</h2>
      </div>
      <div className="settings-tabs native-scroll-x">
        <button className="settings-tab" onClick={() => go('settings-profile')}>{t('settings.profile')}</button>
        <button className="settings-tab active">{t('settings.preferences')}</button>
      </div>
      <div className="settings-body">
        <div className="settings-section">
          <div className="settings-section-title">{t('preferences.mobile.app')}</div>
          <LanguagePreference variant="mobile" />
          <button
            type="button"
            className="settings-row action"
            onClick={() => setAppearanceOpen(true)}
            data-testid="mobile-appearance-submenu"
          >
            <span>{t('preferences.appearance.title')}</span>
            <span className="settings-row-meta muted" aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-row action" onClick={() => setMediaLibraryOpen(true)} data-testid="mobile-media-library">
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block' }}>Emoji, GIFs &amp; stickers</span>
              <span className="settings-row-meta muted" style={{ display: 'block', maxWidth: '100%', marginTop: 3 }}>Create packs and manage favorites.</span>
            </span>
            <span className="settings-row-meta muted" aria-hidden="true">›</span>
          </button>
          <button
            type="button"
            className="settings-row action"
            onClick={() => setDmOptInEnabled(!dmOptInEnabled)}
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block' }}>{t('preferences.directMessages.label')}</span>
              <span className="settings-row-meta muted" style={{ display: 'block', maxWidth: '100%', marginTop: 3 }}>
                {t('preferences.directMessages.mobileDescription')}
              </span>
            </span>
            <span
              className={`toggle ${dmOptInEnabled ? 'on' : ''}`}
              role="switch"
              aria-checked={dmOptInEnabled}
              data-testid="mobile-dm-opt-in-toggle"
            />
          </button>
          <button
            type="button"
            className="settings-row action"
            onClick={() => setPreference("developerRelayDebug", !prefs.developerRelayDebug)}
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: "block" }}>Developer relay logs</span>
              <span className="settings-row-meta muted" style={{ display: "block", maxWidth: "100%", marginTop: 3 }}>
                Browser console.
              </span>
            </span>
            <span
              className={"toggle " + (prefs.developerRelayDebug ? "on" : "")}
              role="switch"
              aria-checked={prefs.developerRelayDebug}
              data-testid="mobile-developer-relay-debug-toggle"
            />
          </button>
          <div className="settings-row">
            <span>{t("preferences.mobile.version")}</span>
            <span className="settings-row-meta muted">obelisk · mobile</span>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">{t("preferences.backup.advanced")}</div>
          <AccountBackupExport mobile />
          <button
            type="button"
            className="settings-btn-danger"
            onClick={clearLocalCache}
            data-testid="mobile-clear-cache-button"
          >
            {t('preferences.localData.clear.button')}
          </button>
        </div>
        <ProfileFeedRelaySettings mobile />
        <DeveloperSignatureTest mobile />
        <div className="settings-section">
          <div className="settings-section-title">{t("mobile.settings.identity")}</div>
          <button
            className="settings-btn-danger"
            onClick={() => setConfirmingLogout(true)}
            data-testid="disconnect-btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t("mobile.settings.disconnect")}
          </button>
        </div>
      </div>
    </div>
      {mediaLibraryOpen && <MediaLibraryModal onClose={() => setMediaLibraryOpen(false)} />}
      {confirmingLogout && (
        <DisconnectConfirmSheet
          onConfirm={() => { setConfirmingLogout(false); void nostrActions.logout(); }}
          onCancel={() => setConfirmingLogout(false)}
        />
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// rehydrating

function RehydratingScreen() {
  const { t } = useTranslation();
  return (
    <div className="screen active">
      <div className="conn-screen">
        <div className="conn-spinner" />
        <div style={{ color: 'var(--app-text-dim)', fontSize: 13 }}>{t('common.reconnecting')}</div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// shell — owns nav state

export default function MobileShell() {
  const { t } = useTranslation();
  const isLoggedIn = useIsLoggedIn();
  const isRehydrating = useIsRehydrating();
  const dmOptInEnabled = useDmOptInEnabled();
  const myPubkey = useMyPubkey();
  const groups = useGroups();
  const myFollows = useMyFollows();
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const profilePopupPubkey = useChatStore((s) => s.profilePopupPubkey);
  const closeProfilePopup = useChatStore((s) => s.closeProfilePopup);

  const [nav, setNav] = useState<NavState>(initialNav);
  const navRef = useRef<NavState>(initialNav);
  const currentRelayUrl = useCurrentRelayUrl();
  const relayRef = useRef<string | null>(currentRelayUrl ?? null);
  const didInitRef = useRef(false);
  const exitArmedRef = useRef<number>(0);
  const [exitToast, setExitToast] = useState(false);
  const router = useRouter();
  // Slide direction for the screen-mount animation. 'forward' slides in
  // from the right (push), 'back' slides in from the left (pop). Cleared
  // after each animation so a same-screen rerender doesn't replay.
  const [slideDir, setSlideDir] = useState<'forward' | 'back' | null>(null);

  // Drag-carousel state — when the user pans horizontally, mount neighbors
  // on either side and translate the layer with the finger. `isDragging`
  // gates neighbor rendering; the layer's transform is set imperatively via
  // `dragLayerRef` to avoid re-rendering on every touchmove.
  const [isDragging, setIsDragging] = useState(false);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const screensHostRef = useRef<HTMLDivElement>(null);
  // Pending animation timer for tap-switches. Rapid direct navigation (search,
  // channel row, DM row) must cancel it so the delayed tab switch cannot
  // overwrite the user's latest tap.
  const tabAnimTimerRef = useRef<number | null>(null);
  // After a drag-commit we suppress the next slide-from-x animation so the
  // newly-mounted screen doesn't double-animate (the drag layer already
  // animated it into place).
  const suppressSlideRef = useRef(false);

  // ── navigation helpers ───────────────────────────────────────────────
  // We update `useChatStore.activeChannelId` / `useDMStore.activeDMPubkey`
  // via `setState` rather than calling the slice's `setActiveChannel` /
  // `setActiveDM` actions — those actions ALSO blow away `messages` and
  // re-flip `isLoadingMessages: true`, which is fine for the desktop chat
  // panel (its source of truth) but would be redundant churn on mobile,
  // where messages come from the bridge hook instead. We only need the
  // active id so `read-gates.isUserWatching*` knows the user is here.
  // Push a new nav state into the browser history. The popstate handler is
  // the single mechanism for "back" — every back-button (device, browser,
  // swipe-back) pops one entry, and the listener replays the previous nav.
  const pushNav = useCallback((updater: (n: NavState) => NavState, dir: 'forward' | 'back' = 'forward') => {
    setSlideDir(dir);
    setNav((n) => {
      const next = updater(n);
      navRef.current = next;
      if (typeof window !== 'undefined') {
        try {
          window.history.pushState({ nav: next }, '', urlFor(next, relayRef.current));
        } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const cancelPendingTabTransition = useCallback(() => {
    if (tabAnimTimerRef.current !== null) {
      window.clearTimeout(tabAnimTimerRef.current);
      tabAnimTimerRef.current = null;
    }
    setIsDragging(false);
    const layer = dragLayerRef.current;
    if (layer) {
      layer.style.transition = 'none';
      layer.style.transform = '';
    }
  }, []);

  const go = useCallback((screen: ScreenName, dir: 'forward' | 'back' = 'forward') => {
    if (dir === 'back' && typeof window !== 'undefined') {
      window.history.back();
      return;
    }
    cancelPendingTabTransition();
    // Sibling tabs in the settings group (Profile ↔ Preferences) toggle
    // in-place. They visually share the `.settings-tabs` strip, so a slide
    // animation reads as broken — the user tapped a tab, not navigated to
    // a new screen. Suppress the slide for that one pair.
    const prev = navRef.current.screen;
    const isSettingsTabSwitch =
      (prev === 'settings-profile' && screen === 'settings-prefs') ||
      (prev === 'settings-prefs' && screen === 'settings-profile');
    if (isSettingsTabSwitch) suppressSlideRef.current = true;

    if (screen !== 'channel') useChatStore.setState({ activeChannelId: null });
    if (screen !== 'dm-thread') useDMStore.setState({ activeDMPubkey: null });
    pushNav((n) => {
      if (NAV_ORDER.includes(screen)) return { ...initialNav, screen };
      return {
        ...n,
        screen,
        baseScreen: null,
        msgContext: null,
        // Sub-screen targets record where we came from so the bottom-nav
        // highlight + swipe-back behave correctly for screens reachable from
        // multiple tabs (search, etc).
        parentScreen: n.screen,
      };
    }, dir);
  }, [cancelPendingTabTransition, pushNav]);

  // VoiceStatusBar "jump back to call": the bar lives outside the screens host
  // and can't reach `pushNav` directly, so it dispatches through the
  // jump-to-voice pub/sub. Mirror the DesktopShell handler — switch relay
  // first if the call's home relay differs, then push the voice-room screen.
  useEffect(() => {
    return subscribeVoiceJump(async ({ channelId, relayUrl }) => {
      if (relayUrl && currentRelayUrl && relayUrl !== currentRelayUrl) {
        try { await nostrActions.switchRelay(relayUrl); }
        catch (err) { console.warn('[mobile] switchRelay for voice jump failed', err); }
      }
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      // Voice jump originates from outside the shell (status bar etc.) — no
      // meaningful entry parent. Anchor to 'server' so the highlight + swipe
      // behave like opening voice from the channel list.
      pushNav((n) => ({
        ...n,
        screen: 'voice-room',
        groupId: channelId,
        dmPeer: null,
        profilePubkey: null,
        forumGroupId: null,
        baseScreen: null,
        msgContext: null,
        parentScreen: 'server',
      }));
    });
  }, [currentRelayUrl, pushNav]);

  // ── initial URL parse + history seeding ─────────────────────────────
  useEffect(() => {
    if (didInitRef.current) return;
    if (!isLoggedIn) return;
    if (typeof window === 'undefined') return;
    didInitRef.current = true;
    const { nav: parsed, relay } = parseUrl(window.location.search);
    if (relay) {
      const cur = (currentRelayUrl ?? '').replace(/\/+$/, '').toLowerCase();
      const next = relay.replace(/\/+$/, '').toLowerCase();
      if (next !== cur) {
        void nostrActions.switchRelay(relay).catch((err) => {
          console.warn('[mobile] switchRelay from deep-link failed', err);
        });
      }
    }
    setNav(parsed);
    navRef.current = parsed;
    if (parsed.screen === 'channel' && parsed.groupId) {
      useChatStore.setState({ activeChannelId: parsed.groupId });
    } else if (dmOptInEnabled && parsed.screen === 'dm-thread' && parsed.dmPeer) {
      useDMStore.setState({ activeDMPubkey: parsed.dmPeer });
    }
    // Guard entry: a sentinel sits BEHIND the current nav so the first
    // press of back lands on the guard (we re-push and arm the toast),
    // and a second press within 2 s confirms exit to the landing page.
    // For sub-screens (e.g. deep-linked into a channel) `buildSeedHistory`
    // also seeds the parent tab between the guard and the sub-screen, so
    // the channel header's back arrow climbs up to the channel list rather
    // than dropping straight onto the guard and showing the exit toast.
    const entries = buildSeedHistory(parsed, relay ?? currentRelayUrl ?? null);
    try {
      window.history.replaceState(entries[0].state, '', entries[0].url);
      for (let i = 1; i < entries.length; i++) {
        window.history.pushState(entries[i].state, '', entries[i].url);
      }
    } catch { /* ignore */ }
  }, [isLoggedIn, currentRelayUrl, dmOptInEnabled]);

  // Keep relayRef + URL relay param in sync without pushing history entries.
  useEffect(() => {
    relayRef.current = currentRelayUrl ?? null;
    if (typeof window === 'undefined') return;
    if (!didInitRef.current) return;
    const url = urlFor(navRef.current, currentRelayUrl ?? null);
    try {
      window.history.replaceState(window.history.state, '', url);
    } catch { /* ignore */ }
  }, [currentRelayUrl]);

  // ── popstate: drives all "back" navigation ──────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: PopStateEvent) => {
      const s = (e.state ?? null) as { nav?: NavState; guard?: boolean } | null;
      if (s?.guard) {
        const now = Date.now();
        if (now - exitArmedRef.current < 2000) {
          exitArmedRef.current = 0;
          router.push('/');
          return;
        }
        exitArmedRef.current = now;
        setExitToast(true);
        window.setTimeout(() => setExitToast(false), 2000);
        // Re-push current nav so the user stays on their screen.
        try {
          window.history.pushState({ nav: navRef.current }, '', urlFor(navRef.current, relayRef.current));
        } catch { /* ignore */ }
        return;
      }
      if (s?.nav) {
        const next = s.nav;
        const prev = navRef.current.screen;
        const isSettingsTabSwitch =
          (prev === 'settings-profile' && next.screen === 'settings-prefs') ||
          (prev === 'settings-prefs' && next.screen === 'settings-profile');
        // Sheets (msg-actions / zap-modal) float over a base screen with their
        // own vertical slide-up animation. Any popstate that opens or closes a
        // sheet (or hops between two sheets) must NOT also animate the base
        // layer — otherwise the channel underneath slides laterally while the
        // sheet appears/disappears, which reads as a glitchy refresh.
        const isSheetTransition =
          prev === 'msg-actions' || prev === 'zap-modal' ||
          next.screen === 'msg-actions' || next.screen === 'zap-modal';
        if (isSettingsTabSwitch || isSheetTransition) {
          suppressSlideRef.current = true;
          setSlideDir(null);
        } else {
          setSlideDir('back');
        }
        setNav(next);
        navRef.current = next;
        useChatStore.setState({ activeChannelId: next.screen === 'channel' ? next.groupId : null });
        useDMStore.setState({ activeDMPubkey: dmOptInEnabled && next.screen === 'dm-thread' ? next.dmPeer : null });
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [router, dmOptInEnabled]);

  // ── horizontal swipe navigation (drag-tracking carousel) ────────────
  // The user pans horizontally; the active screen translates with the finger
  // and the neighboring screen reveals from the side. On release we either
  // commit (if dragged ≥ ⅓ viewport, or flicked with enough velocity) or
  // snap back. Touches that start inside another horizontal scroller (relay
  // strip, tab strips) are ignored so those keep their own scroll behavior.
  // Vertical scrollers (`.messages`, voice stage) are NOT excluded — the
  // direction-detection below commits to 'horizontal' only when |dx| > 1.2×|dy|
  // so a clean vertical scroll is left alone.
  type DragInfo = {
    startX: number;
    startY: number;
    startT: number;
    width: number;
    ignored: boolean;
    decided: 'horizontal' | 'vertical' | null;
    dx: number;
    velocity: number; // px/ms at last move
    lastX: number;
    lastT: number;
  };
  const dragRef = useRef<DragInfo | null>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) { dragRef.current = null; return; }
    const t = e.touches[0];
    const ignored = shouldIgnoreMobileSwipeTarget(e.target);
    const width = screensHostRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
    const now = Date.now();
    dragRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      startT: now,
      width,
      ignored,
      decided: null,
      dx: 0,
      velocity: 0,
      lastX: t.clientX,
      lastT: now,
    };
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.ignored) return;
    const t = e.touches[0];
    const dx = t.clientX - drag.startX;
    const dy = t.clientY - drag.startY;
    const now = Date.now();
    const dtSinceLast = Math.max(1, now - drag.lastT);
    drag.velocity = (t.clientX - drag.lastX) / dtSinceLast;
    drag.lastX = t.clientX;
    drag.lastT = now;
    drag.dx = dx;
    if (drag.decided === null) {
      // Wait for enough movement to disambiguate intent. Then commit to one
      // axis: horizontal (drag the carousel) or vertical (let the scroller
      // inside the screen own the gesture).
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        drag.decided = 'horizontal';
        setIsDragging(true);
      } else {
        drag.decided = 'vertical';
      }
    }
    if (drag.decided !== 'horizontal') return;
    // Rubber-band when there's no neighbor on the side we're pulling from.
    const neighbors = neighborsFor(navRef.current);
    let displayDx = dx;
    if (dx > 0 && !neighbors.left) displayDx = dx * 0.3;
    else if (dx < 0 && !neighbors.right) displayDx = dx * 0.3;
    const layer = dragLayerRef.current;
    if (layer) {
      layer.style.transition = 'none';
      layer.style.transform = `translateX(${displayDx}px)`;
    }
  }, []);

  const finishDrag = useCallback((dx: number, velocity: number, width: number) => {
    const goingRight = dx > 0;
    const action = decideSwipeNav(navRef.current, goingRight);
    const hasTarget = action.kind === 'top-level';
    const snap = hasTarget ? decideSnap(dx, velocity, width) : 'revert';
    const layer = dragLayerRef.current;
    const TRANSITION = 'transform 180ms cubic-bezier(0.2, 0.85, 0.25, 1)';
    if (snap === 'commit' && action.kind === 'top-level') {
      // Animate first, push after. Top-level tab switches always land on the
      // actual tab, not a remembered thread/channel/voice room.
      const targetTx = goingRight ? width : -width;
      if (layer) {
        layer.style.transition = TRANSITION;
        layer.style.transform = `translateX(${targetTx}px)`;
      }

      window.setTimeout(() => {
        suppressSlideRef.current = true;
        useChatStore.setState({ activeChannelId: null });
        useDMStore.setState({ activeDMPubkey: null });
        pushNav(
          () => ({ ...initialNav, screen: action.target }),
          action.dir,
        );
        setIsDragging(false);
      }, 180);
    } else {
      if (layer) {
        layer.style.transition = TRANSITION;
        layer.style.transform = 'translateX(0)';
      }
      window.setTimeout(() => {
        setIsDragging(false);
      }, 180);
    }
  }, [pushNav]);

  const onTouchEnd = useCallback((_e: React.TouchEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.ignored) return;
    if (drag.decided !== 'horizontal') return;
    finishDrag(drag.dx, drag.velocity, drag.width);
  }, [finishDrag]);

  const onTouchCancel = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.ignored || drag.decided !== 'horizontal') return;
    // Treat cancel as revert.
    finishDrag(0, 0, drag.width);
  }, [finishDrag]);

  // After isDragging flips back to false, reset the drag-layer transform so
  // the next render starts at translateX(0). Done in a layout effect so the
  // browser never paints the transient "screen swapped but layer still
  // translated" state.
  useLayoutEffect(() => {
    if (isDragging) return;
    const layer = dragLayerRef.current;
    if (layer) {
      layer.style.transition = 'none';
      layer.style.transform = '';
    }
    if (suppressSlideRef.current) {
      // Clear after the post-commit render commits, so a subsequent tap-nav
      // can still play its slide animation. ALSO null out slideDir so that
      // any later unrelated re-render doesn't re-add the slide-forward/back
      // class to the screen-anim wrapper and replay the slide as a ghostly
      // reverse motion.
      const id = requestAnimationFrame(() => {
        suppressSlideRef.current = false;
        setSlideDir(null);
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isDragging, nav.screen]);

  // After a tap-nav slide animation completes, clear slideDir. Without this,
  // the screen-anim wrapper keeps the slide-forward/back class indefinitely,
  // and any subsequent className flip (e.g., after a drag-commit's brief ''
  // suppression) re-triggers the animation as a ghost slide.
  //
  // We listen for `animationend` on the live `.screen-anim` element rather
  // than using a fixed timer. Timers race with rapid re-navigation: a new
  // `setSlideDir(...)` while the previous animation is still in flight used
  // to leave the class on, producing the "repeated animation" glitch users
  // saw. The event-based path scopes cleanup to the actual element that
  // animated, so re-mounts (different key → fresh DOM node) get a fresh
  // listener and stale ones don't interfere. The setTimeout fallback covers
  // `prefers-reduced-motion`, hidden tabs, and other environments where
  // `animationend` may not fire reliably.
  useEffect(() => {
    if (slideDir === null) return;
    const host = screensHostRef.current;
    const el = host?.querySelector('.drag-overlay .screen-anim') as HTMLElement | null;
    const onEnd = () => setSlideDir(null);
    el?.addEventListener('animationend', onEnd, { once: true });
    const fallback = window.setTimeout(() => setSlideDir(null), 360);
    return () => {
      el?.removeEventListener('animationend', onEnd);
      clearTimeout(fallback);
    };
  }, [slideDir, nav.screen]);

  // Must be called unconditionally — there's an early return for the guest
  // (logged-out) branch further down, and React requires the same hook order
  // on every render. Without hoisting this, logging in/out flips the hook
  // count and trips React error #310.
  const kbInset = useKeyboardInset();

  const selectGroup = useCallback((groupId: string, kind: JsGroup['kind']) => {
    cancelPendingTabTransition();
    if (kind === 'voice' || kind === 'voice-sfu') {
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav((n) => ({
        ...n,
        screen: 'voice-room',
        groupId,
        dmPeer: null,
        profilePubkey: null,
        forumGroupId: null,
        baseScreen: null,
        msgContext: null,
        parentScreen: 'server',
      }));
    } else if (kind === 'forum') {
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav((n) => ({
        ...n,
        screen: 'forum',
        groupId,
        forumGroupId: groupId,
        dmPeer: null,
        profilePubkey: null,
        baseScreen: null,
        msgContext: null,
        parentScreen: 'server',
      }));
    } else {
      // Pure navigation. The cursor is advanced by `useAutoMarkRead` once the
      // user is actually watching the channel (visible + focused + active).
      useChatStore.setState({ activeChannelId: groupId });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav((n) => ({
        ...n,
        screen: 'channel',
        groupId,
        dmPeer: null,
        profilePubkey: null,
        forumGroupId: null,
        baseScreen: null,
        msgContext: null,
        parentScreen: 'server',
      }));
    }
  }, [cancelPendingTabTransition, pushNav]);
  const selectPeer = useCallback((peer: string) => {
    cancelPendingTabTransition();
    if (!dmOptInEnabled) {
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav((n) => ({
        ...n,
        screen: 'dm-thread',
        groupId: null,
        dmPeer: peer,
        profilePubkey: null,
        forumGroupId: null,
        baseScreen: null,
        msgContext: null,
        parentScreen: n.screen,
      }));
      return;
    }
    // Pure navigation. The cursor is advanced by `useAutoMarkRead` once the
    // DM thread is open, focused, and visible.
    useChatStore.setState({ activeChannelId: null });
    useDMStore.setState({ activeDMPubkey: peer });
    pushNav((n) => ({
      ...n,
      screen: 'dm-thread',
      groupId: null,
      dmPeer: peer,
      profilePubkey: null,
      forumGroupId: null,
      baseScreen: null,
      msgContext: null,
      parentScreen: 'dms-list',
    }));
  }, [cancelPendingTabTransition, dmOptInEnabled, pushNav]);
  // Cross-context screens: stamp parentScreen with the current screen so the
  // bottom-nav highlight + swipe direction reflect where the user came from.
  // E.g. profile-view from Inbox keeps Inbox as parent; from a channel keeps
  // 'channel' (which resolveParent walks up to 'server'). See
  // docs/mobile-navigation.md §3.
  const openProfile = useCallback((pubkey: string) => {
    useChatStore.getState().openProfilePopup(pubkey);
  }, []);
  const exploreProfile = useCallback((pubkey: string) => {
    closeProfilePopup();
    pushNav((n) => ({ ...n, screen: 'profile-view', profilePubkey: pubkey, parentScreen: n.screen }));
  }, [closeProfilePopup, pushNav]);
  const openMembers = useCallback(() => {
    pushNav((n) => ({ ...n, screen: 'member-list', parentScreen: n.screen }));
  }, [pushNav]);
  const openMsgActions = useCallback((msg: {
    id: string;
    pubkey: string;
    content: string;
    groupId: string;
    canModerate: boolean;
    canDeleteOwn: boolean;
  }) => {
    // The sheet animates in vertically on top of the base screen — suppress the
    // default forward slide so the underlying channel doesn't lateral-slide too.
    suppressSlideRef.current = true;
    pushNav((n) => ({ ...n, baseScreen: n.screen, screen: 'msg-actions', msgContext: msg, parentScreen: n.screen }));
  }, [pushNav]);
  const closeSheet = useCallback(() => {
    if (typeof window !== 'undefined') window.history.back();
  }, []);
  const openSharedZap = useMessageZapStore((s) => s.open);
  const openZap = useCallback((msg: { id: string; pubkey: string; content: string }) => {
    const groupId = navRef.current.groupId;
    if (!groupId || msg.pubkey === myPubkey) return;
    openSharedZap({
      messageId: msg.id,
      recipientPubkey: msg.pubkey,
      recipientLud16: null,
      displayName: shortNpub(msg.pubkey),
      groupId,
    });
    if (navRef.current.screen === 'msg-actions' || navRef.current.screen === 'zap-modal') {
      closeSheet();
    }
  }, [closeSheet, myPubkey, openSharedZap]);
  const backFromChannel = useCallback(() => {
    if (typeof window !== 'undefined') window.history.back();
  }, []);
  const backFromProfile = useCallback(() => {
    if (typeof window !== 'undefined') window.history.back();
  }, []);

  // ── bottom-nav: direction-aware tab switching ───────────────────────
  // Tap-switch animation. Top-level buttons are literal: DMs opens DMs,
  // Servers opens the channel list, etc. Sub-screens can still be popped by
  // tapping their active tab, but cross-tab switches never restore a hidden
  // thread/channel/voice-room.
  const commitCarouselTransition = useCallback((target: ScreenName, dir: 'forward' | 'back') => {
    const current = NAV_ORDER.includes(navRef.current.screen)
      ? navRef.current.screen
      : resolveParent(navRef.current) ?? 'server';
    if (!isAdjacentTabSwitch(current, target)) {
      suppressSlideRef.current = true;
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav(() => ({ ...initialNav, screen: target }), dir);
      return;
    }

    const layer = dragLayerRef.current;
    const width = screensHostRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
    const TRANSITION = 'transform 180ms cubic-bezier(0.2, 0.85, 0.25, 1)';

    const targetTx = dir === 'forward' ? -width : width;
    setIsDragging(true);
    if (layer && width > 0) {
      layer.style.transition = 'none';
      layer.style.transform = 'translateX(0)';
      void layer.offsetHeight;
      layer.style.transition = TRANSITION;
      layer.style.transform = `translateX(${targetTx}px)`;
    }

    if (tabAnimTimerRef.current !== null) {
      window.clearTimeout(tabAnimTimerRef.current);
    }
    tabAnimTimerRef.current = window.setTimeout(() => {
      tabAnimTimerRef.current = null;
      // Push the bare target now that the animation is done.
      // suppressSlideRef must be set BEFORE pushNav so the screen-anim
      // wrapper (if any sub-screen is involved) doesn't re-animate.
      suppressSlideRef.current = true;
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      pushNav(
        () => ({ ...initialNav, screen: target }),
        dir,
      );
      setIsDragging(false);
    }, 180);
  }, [pushNav]);

  // Pop to the bare top-level tab while on a sub-screen. The parent tab
  // is already at drag-curr behind the overlay, so we just slide the
  // overlay off to the right and then `replaceState` (not pushState) to
  // collapse the sub-screen entry. Using replaceState fixes the
  // "press back twice" feel — the back-stack from the bare tab leads to
  // whatever preceded the sub-screen, not back into it.
  const popToBareTab = useCallback((target: ScreenName) => {
    const overlay = screensHostRef.current?.querySelector('.drag-overlay') as HTMLElement | null;
    if (overlay) {
      overlay.style.transition = 'transform 180ms cubic-bezier(0.2, 0.85, 0.25, 1)';
      overlay.style.transform = 'translateX(100%)';
    }
    if (tabAnimTimerRef.current !== null) {
      window.clearTimeout(tabAnimTimerRef.current);
    }
    tabAnimTimerRef.current = window.setTimeout(() => {
      tabAnimTimerRef.current = null;
      suppressSlideRef.current = true;
      useChatStore.setState({ activeChannelId: null });
      useDMStore.setState({ activeDMPubkey: null });
      const bare: NavState = { ...initialNav, screen: target };
      setNav(bare);
      navRef.current = bare;
      setSlideDir(null);
      if (typeof window !== 'undefined') {
        try {
          window.history.replaceState({ nav: bare }, '', urlFor(bare, relayRef.current));
        } catch { /* ignore */ }
      }
      // Clear the inline transform on the (now unmounting) overlay so a
      // future overlay mounts at the correct starting position.
      if (overlay) {
        overlay.style.transition = '';
        overlay.style.transform = '';
      }
    }, 180);
  }, []);

  const onTabPress = useCallback((target: ScreenName) => {
    const action = decideTabPress(navRef.current, target);
    switch (action.kind) {
      case 'noop':
        return;
      case 'pop':
        popToBareTab(action.target);
        return;
      case 'switch':
        commitCarouselTransition(action.target, action.dir);
        return;
    }
  }, [commitCarouselTransition, popToBareTab]);

  // Renders one of the four top-level tab screens — used to mount the
  // neighbor screens in the drag carousel slots without duplicating the
  // big switch in the main body builder. Sub-screen neighbors fall back
  // to their NAV_ORDER parent (which is always one of these four).
  const renderTopLevelScreen = useCallback((screen: ScreenName): ReactNode => {
    switch (screen) {
      case 'server':
        return <ServerScreen go={go} selectGroup={selectGroup} />;
      case 'dms-list':
        return dmOptInEnabled
          ? <DmsListScreen go={go} selectPeer={selectPeer} myFollows={myFollows} />
          : <MobileDmOptInScreen onSecondary={() => go('server')} />;
      case 'inbox':
        return <InboxScreen go={go} selectGroup={selectGroup} selectPeer={selectPeer} />;
      case 'settings-profile':
        return <SettingsProfileScreen go={go} />;
      default:
        return null;
    }
  }, [dmOptInEnabled, go, selectGroup, selectPeer, myFollows]);

  const dragNeighbors = useMemo(() => neighborsFor(nav), [nav]);


  // Mirror the watched channel into the bridge. Without this:
  //   1) the active-channel priority gate (background message-queue drain
  //      pauses while the active channel is in 'loading') never engages
  //      on mobile — the watched channel doesn't get its bandwidth boost.
  //   2) Re-entering a channel that was previously declared
  //      `empty-confirmed` doesn't auto-restart its kind 9 sub, so the
  //      user sees "No messages yet" flash before the bridge gets a
  //      chance to recover.
  //
  // useLayoutEffect (not useEffect): the bridge's setActiveGroup flips
  // status to 'loading' synchronously when it restarts a stale empty
  // channel. Running before paint means the chat panel's first paint
  // already reflects 'loading' instead of the stale 'empty-confirmed'.
  // Sync `getBridgeSync` is used over async `nostrActions.setActiveGroup`
  // so the status flip lands in this commit, not a later microtask.
  useLayoutEffect(() => {
    const bridge = getBridgeSync();
    if (!bridge) return;
    if (nav.screen === 'channel' && nav.groupId) {
      bridge.setActiveGroup(nav.groupId);
    } else {
      bridge.setActiveGroup(null);
    }
  }, [nav.screen, nav.groupId]);

  useEffect(() => {
    useDMStore.setState({
      activeDMPubkey: dmOptInEnabled && nav.screen === 'dm-thread' ? nav.dmPeer : null,
    });
  }, [dmOptInEnabled, nav.screen, nav.dmPeer]);

  // Listen for reaction emit from msg-actions sheet
  useEffect(() => {
    const handler = async (e: Event) => {
      const ev = e as CustomEvent<{
        msg: { id: string; pubkey: string };
        emoji: string;
        customEmojis?: CustomEmojiMap;
      }>;
      const groupId = nav.groupId;
      if (!groupId) return;
      try {
        const emojiTags = emojiTagsForContent(
          ev.detail.emoji,
          mergeCustomEmojiMaps(serverEmojis, ev.detail.customEmojis),
        );
        await nostrActions.sendReaction(
          ev.detail.msg.id,
          ev.detail.msg.pubkey,
          ev.detail.emoji,
          groupId,
          emojiTags,
        );
      } catch (err) { console.warn('[mobile] react failed', err); }
    };
    window.addEventListener('obelisk-mobile:react', handler);
    return () => window.removeEventListener('obelisk-mobile:react', handler);
  }, [nav.groupId, serverEmojis]);

  // ── DM and inbox badges ─────────────────────────────────────────────
  // Both totals are derived from the persisted read-state cursor; they
  // survive reloads and converge across tabs via Zustand persist's
  // `storage`-event sync.
  const dmBadge = useTotalDMUnread();
  const inboxBadge = useInboxUnreadCount();

  // ── render ──────────────────────────────────────────────────────────

  // Guests: full-screen login
  if (!isLoggedIn) {
    if (isRehydrating) {
      return (
        <div className="obelisk-mobile" data-obelisk-app>
          <div className="screens-host">
            <RehydratingScreen />
          </div>
        </div>
      );
    }
    return (
      <div className="obelisk-mobile" data-obelisk-app>
        <div className="screens-host">
          <LoginScreen />
        </div>
      </div>
    );
  }

  // pick screen
  let body: ReactNode;
  switch (nav.screen) {
    case 'server':
      body = <ServerScreen go={go} selectGroup={selectGroup} />;
      break;
    case 'channel':
      body = nav.groupId ? (
        <ChannelScreen
          groupId={nav.groupId}
          go={go}
          back={backFromChannel}
          openMsgActions={openMsgActions}
          openZap={openZap}
          openProfile={openProfile}
          openMembers={openMembers}
        />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noChannelSelected')} />;
      break;
    case 'voice-room':
      body = nav.groupId ? (
        <VoiceRoomScreen
          groupId={nav.groupId}
          back={() => go('server', 'back')}
          openChat={() => { pushNav((n) => ({ ...n, screen: 'channel' })); }}
        />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noVoiceChannel')} />;
      break;
    case 'dms-list':
      body = dmOptInEnabled
        ? <DmsListScreen go={go} selectPeer={selectPeer} myFollows={myFollows} />
        : <MobileDmOptInScreen onSecondary={() => go('server')} />;
      break;
    case 'dm-thread':
      body = !dmOptInEnabled ? (
        <MobileDmOptInScreen secondaryLabel={t('common.back')} onSecondary={() => go('dms-list', 'back')} />
      ) : nav.dmPeer ? (
        <DmThreadScreen peer={nav.dmPeer} back={() => go('dms-list', 'back')} openProfile={openProfile} />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noConversation')} />;
      break;
    case 'inbox':
      body = <InboxScreen go={go} selectGroup={selectGroup} selectPeer={selectPeer} />;
      break;
    case 'profile-view':
      body = nav.profilePubkey ? (
        <ProfileViewScreen pubkey={nav.profilePubkey} back={backFromProfile} openDm={selectPeer} />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noProfileSelected')} />;
      break;
    case 'member-list':
      body = nav.groupId ? (
        <MemberListScreen groupId={nav.groupId} back={() => { if (typeof window !== 'undefined') window.history.back(); }} openProfile={openProfile} />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noChannel')} />;
      break;
    case 'compose-dm':
      body = dmOptInEnabled
        ? <ComposeDmScreen back={() => go('dms-list', 'back')} selectPeer={selectPeer} />
        : <MobileDmOptInScreen secondaryLabel={t('common.back')} onSecondary={() => go('dms-list', 'back')} />;
      break;
    case 'search':
      body = <SearchScreen back={() => go('server', 'back')} selectGroup={selectGroup} />;
      break;
    case 'forum':
      body = nav.groupId ? (
        <ForumScreen groupId={nav.groupId} back={() => go('server', 'back')} selectChild={(childId) => selectGroup(childId, 'text')} />
      ) : <EmptyScreen go={go} title={t('mobile.empty.noForum')} />;
      break;
    case 'settings-profile':
      body = <SettingsProfileScreen go={go} />;
      break;
    case 'settings-prefs':
      body = <SettingsPrefsScreen go={go} />;
      break;
    case 'profile-edit':
      body = <EditProfileScreen go={go} />;
      break;
    case 'msg-actions':
    case 'zap-modal':
      // Sheets float over the underlying screen (typically `channel`). Render
      // that base screen as the body here so it stays mounted in the same
      // sub-overlay slot — otherwise opening the actions sheet remounts
      // ChannelScreen and wipes local state like `replyingTo`.
      if ((nav.baseScreen === 'channel' || !nav.baseScreen) && nav.groupId) {
        body = (
          <ChannelScreen
            groupId={nav.groupId}
            go={go}
            back={backFromChannel}
            openMsgActions={openMsgActions}
            openZap={openZap}
            openProfile={openProfile}
            openMembers={openMembers}
          />
        );
      } else if (nav.baseScreen === 'dm-thread' && nav.dmPeer) {
        body = dmOptInEnabled
          ? <DmThreadScreen peer={nav.dmPeer} back={() => go('dms-list', 'back')} openProfile={openProfile} />
          : <MobileDmOptInScreen secondaryLabel={t('common.back')} onSecondary={() => go('dms-list', 'back')} />;
      } else {
        body = null;
      }
      break;
    default:
      body = <EmptyScreen go={go} title={t('mobile.empty.unknownScreen')} />;
  }

  // Bottom nav visibility — hide on: voice-room (full-bleed), profile-view,
  // dm-thread (composer takes the bar role), search/compose-dm/member-list
  // (modal-ish flows), forum (back-nav). Hide nav only when the screen owns
  // the full viewport (voice-room takes the whole stage; sheets float over
  // the previous screen so the nav under them stays meaningful but covered
  // by the sheet backdrop). Also hide when the on-screen keyboard is open
  // so the nav doesn't wedge between the composer and the keyboard.
  // (kbInset is already declared above the guest-branch early return so the
  // hook count stays stable across login state transitions.)
  const hideNav = shouldHideMobileBottomNav(nav.screen, kbInset);

  // Sheet screens (msg-actions / zap-modal) render the underlying screen as
  // `body` (see switch above) so the sub-overlay slot stays mounted. The key
  // for that slot is derived from `baseScreen` so opening/closing a sheet
  // doesn't remount the underlying screen and lose its local state.
  const overlayScreenKey =
    nav.screen === 'msg-actions' || nav.screen === 'zap-modal'
      ? (nav.baseScreen ?? 'channel')
      : nav.screen;

  const slideClass = suppressSlideRef.current
    ? ''
    : slideDir === 'forward' ? 'slide-forward' : slideDir === 'back' ? 'slide-back' : '';
  return (
    <div
      className="obelisk-mobile"
      data-obelisk-app
      style={kbInset > 0 ? ({ ['--kb-inset' as string]: `${kbInset}px` } as React.CSSProperties) : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <MessageZapModal />
      <BackgroundVoiceAudio />
      <div className="screens-host" ref={screensHostRef}>
        <div ref={dragLayerRef} className={`drag-layer ${isDragging ? 'is-dragging' : ''}`}>
          {/* All four top-level screens are persistently mounted with stable
           * keys per screen name. Their on-screen position is controlled by a
           * role class (drag-prev / drag-curr / drag-next / drag-hidden), so a
           * swipe-commit only flips classes — it does NOT remount any screen.
           * Without this, every commit unmounted the neighbor (key changed)
           * and remounted the new active screen, which caused titles +
           * skeleton states to flash on every horizontal nav. */}
          {NAV_ORDER.map((s) => {
            // When the active screen is a sub-screen overlay, its parent
            // top-level tab sits at translateX(0) behind the overlay so the
            // user sees the overlay slide in over it. The parent is *not* a
            // drag neighbor anymore — horizontal swipes skip past the parent
            // in both directions to switch tabs (see swipe-nav.ts) — so it
            // stays at drag-curr regardless of drag state. The actual
            // neighbors revealed by a drag are the previous/next top-level
            // tabs around the parent.
            const subScreenParent = resolveParent(nav);
            const role =
              s === nav.screen
                ? 'drag-curr'
                : s === subScreenParent
                ? 'drag-curr'
                : s === dragNeighbors.left
                ? 'drag-prev'
                : s === dragNeighbors.right
                ? 'drag-next'
                : 'drag-hidden';
            return (
              <div key={s} className={`drag-slot ${role}`} aria-hidden={role !== 'drag-curr'}>
                {renderTopLevelScreen(s)}
              </div>
            );
          })}
          {/* Sub-screens (channel, forum, voice-room, dm-thread, profile-view,
           * search, settings-prefs, ...) ride on top of the persistent slots
           * as a single overlay. Different sub-screens use different keys so
           * navigating between them does remount — that's correct: a forum is
           * not a channel. */}
          {!NAV_ORDER.includes(overlayScreenKey as ScreenName) && body && (
            <div className="drag-slot drag-overlay" key={`sub-${overlayScreenKey}`}>
              <div className={`screen-anim ${slideClass}`}>{body}</div>
            </div>
          )}
        </div>
        {nav.screen === 'msg-actions' && nav.msgContext && (
          <MessageActionsSheet
            msg={nav.msgContext}
            close={closeSheet}
            onZap={() => openZap(nav.msgContext!)}
          />
        )}
        {nav.screen === 'zap-modal' && nav.msgContext && (
          <ZapModalSheet msg={nav.msgContext} close={closeSheet} />
        )}
      </div>
      <MobileVoiceStatusSlot screen={nav.screen} kbInset={kbInset} />
      {!hideNav && <BottomNav nav={nav} onTabPress={onTabPress} dmBadge={dmBadge} inboxBadge={inboxBadge} />}
      {exitToast && (
        <div className="mobile-exit-toast" role="status" aria-live="polite">
          {t('mobile.navigation.pressBackAgain')}
        </div>
      )}
      {profilePopupPubkey && (
        <ProfilePopover
          pubkey={profilePopupPubkey}
          onClose={closeProfilePopup}
          onExplore={exploreProfile}
          onMessage={selectPeer}
        />
      )}
    </div>
  );
}

/**
 * Persistent host for the in-call control bar. The bar stays mounted for the
 * lifetime of the call so navigating out of voice-room reveals it via CSS
 * instead of a fresh mount — the previous conditional remount had a
 * perceptible lag (useGroups + useVoiceStore selectors set up subscriptions
 * async, so the bar would flash in ~1s after the user left the room and the
 * call looked ended in the meantime).
 */
export function MobileVoiceStatusSlot({
  screen,
  kbInset,
}: {
  screen: ScreenName;
  kbInset: number;
}) {
  const hidden = screen === 'voice-room' || kbInset > 0;
  return (
    <div
      className={'mobile-voice-status-slot' + (hidden ? ' is-hidden' : '')}
      data-testid="mobile-voice-status-slot"
    >
      <VoiceStatusBar />
    </div>
  );
}

function EmptyScreen({ go, title }: { go: (s: ScreenName) => void; title: string }) {
  const { t } = useTranslation();
  return (
    <div className="screen active">
      <div className="empty-state">
        <div className="empty-state-title">{title}</div>
        <button className="btn-primary" style={{ width: 'auto', padding: '10px 18px' }} onClick={() => go('server')}>
          {t('mobile.empty.backHome')}
        </button>
      </div>
    </div>
  );
}
