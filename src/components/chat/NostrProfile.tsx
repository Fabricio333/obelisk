'use client';

import { useEffect, useMemo, useState } from 'react';
import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { TextCoercingWebSocket, hexToNpub } from '@nostr-wot/data';
import { getBridge, nostrActions, useMyPubkey, useUserMetadata } from '@/lib/nostr-bridge';
import { usePreferences } from '@/lib/preferences';
import {
  filterProfileFeed,
  isReply,
  mediaUrls,
  toggledFollowTags,
  type ProfileFeedTab,
} from '@/lib/profile-feed';
import { isVideoUrl } from '@/lib/attachments';
import { useTranslation } from '@/i18n/context';
import MessageContent from './MessageContent';
import UserAvatar from '@/components/UserAvatar';

const FEED_LIMIT = 100;

type NostrProfileProps = {
  pubkey: string;
  onClose: () => void;
  onMessage?: (pubkey: string) => void;
};

export default function NostrProfile(props: NostrProfileProps) {
  const relays = usePreferences().profileFeedRelays;
  return <NostrProfileSession key={`${props.pubkey}:${relays.join(',')}`} {...props} relays={relays} />;
}

function NostrProfileSession({
  pubkey,
  onClose,
  onMessage,
  relays,
}: NostrProfileProps & { relays: string[] }) {
  const { t } = useTranslation();
  const meta = useUserMetadata(pubkey);
  const myPubkey = useMyPubkey();
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [contactEvent, setContactEvent] = useState<NostrEvent | null>(null);
  const [tab, setTab] = useState<ProfileFeedTab>('posts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState(false);
  const [contactsReady, setContactsReady] = useState(!myPubkey);

  useEffect(() => {
    void nostrActions.ensureUserMetadata(pubkey).catch(() => {});
  }, [pubkey]);

  useEffect(() => {
    const pool = new SimplePool({
      websocketImplementation: TextCoercingWebSocket as unknown as typeof WebSocket,
      enablePing: true,
    } as ConstructorParameters<typeof SimplePool>[0]);

    const notesSub = pool.subscribe(relays, { kinds: [1], authors: [pubkey], limit: FEED_LIMIT }, {
      onevent: (event) => {
        setNotes((current) => {
          if (current.some((note) => note.id === event.id)) return current;
          return [...current, event].sort((a, b) => b.created_at - a.created_at).slice(0, FEED_LIMIT);
        });
      },
      oneose: () => setLoading(false),
      onclose: () => {
        setLoading(false);
        setError(true);
      },
    });
    const contactsSub = myPubkey
      ? pool.subscribe(relays, { kinds: [3], authors: [myPubkey], limit: 1 }, {
          onevent: (event) => setContactEvent((current) => (
            !current || event.created_at > current.created_at ? event : current
          )),
          oneose: () => setContactsReady(true),
          onclose: () => setFollowError(true),
        })
      : null;

    return () => {
      notesSub.close();
      contactsSub?.close();
      pool.destroy();
    };
  }, [pubkey, myPubkey, relays]);

  const isMe = myPubkey === pubkey;
  const following = !!contactEvent?.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey);
  const visibleNotes = useMemo(() => filterProfileFeed(notes, tab), [notes, tab]);
  const media = useMemo(
    () => visibleNotes.flatMap((note) => mediaUrls(note).map((url) => ({ note, url }))),
    [visibleNotes],
  );
  const displayName = meta?.displayName || meta?.name || shortNpub(pubkey);

  const toggleFollow = async () => {
    if (!myPubkey || !contactsReady || followBusy) return;
    setFollowBusy(true);
    setFollowError(false);
    try {
      const bridge = await getBridge();
      const event = await bridge.publishEvent({
        kind: 3,
        content: contactEvent?.content ?? '',
        tags: toggledFollowTags(contactEvent?.tags ?? [], pubkey, !following),
        created_at: Math.max(Math.floor(Date.now() / 1000), (contactEvent?.created_at ?? 0) + 1),
      }, { extraRelays: relays, mode: 'replace' });
      setContactEvent(event);
    } catch {
      setFollowError(true);
    } finally {
      setFollowBusy(false);
    }
  };

  return (
    <div className="screen active profile-view-screen flex h-full min-h-0 flex-col overflow-y-auto bg-lc-black" data-testid="nostr-profile">
      <div
        className="profile-view-banner relative h-36 shrink-0 bg-gradient-to-br from-lc-olive to-lc-black bg-cover bg-center"
        style={meta?.banner ? { backgroundImage: `url(${meta.banner})` } : undefined}
        data-testid="nostr-profile-banner"
      >
        <div className="profile-view-topbar absolute inset-x-3 top-3 z-10 flex justify-between">
          <button
            type="button"
            onClick={onClose}
            className="back-btn flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-lc-white"
            aria-label={t('common.back')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      <UserAvatar
        pubkey={pubkey}
        picture={meta?.picture}
        size={20}
        name={displayName}
        alt={displayName}
        className="profile-view-avatar relative z-10 -mt-10 ml-5 border-4 border-lc-black"
        initialClassName="text-2xl"
      />

      <div className="profile-view-meta shrink-0 px-5 pb-1 pt-2">
        <div className="profile-view-name text-xl font-extrabold text-lc-white">{displayName}</div>
        {meta?.nip05 && <div className="profile-view-nip05 mt-1 text-xs text-lc-green">{meta.nip05}</div>}
        <div className="profile-view-npub mt-1 font-mono text-[10px] text-lc-muted">{shortNpub(pubkey)}</div>
      </div>
      {meta?.about && (
        <p className="profile-view-bio whitespace-pre-wrap px-5 py-2 text-sm text-lc-muted">{meta.about}</p>
      )}

      {!isMe && (
        <div className="profile-view-actions flex shrink-0 gap-2 px-5 py-3">
          <button
            type="button"
            className={`profile-action follow flex-1 ${following ? '!border-lc-border !bg-transparent !text-lc-white' : ''}`}
            onClick={() => void toggleFollow()}
            disabled={followBusy || !contactsReady}
            data-testid="profile-follow-button"
          >
            {!contactsReady
              ? '…'
              : followBusy
                ? t('common.saving')
                : t(following ? 'profileFeed.unfollow' : 'mobile.profile.follow')}
          </button>
          {onMessage && (
            <button type="button" className="profile-action flex-1" onClick={() => onMessage(pubkey)}>
              {t('mobile.profile.message')}
            </button>
          )}
        </div>
      )}
      {followError && <p className="px-5 pb-2 text-xs text-red-400">{t('profileFeed.followFailed')}</p>}

      <div className="profile-feed-tabs sticky top-0 z-[2] grid grid-cols-3 border-y border-lc-border bg-lc-black/95 backdrop-blur" role="tablist">
        {(['posts', 'replies', 'media'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`border-b-2 px-2 py-3 text-xs font-semibold ${
              tab === value ? 'border-lc-green text-lc-green' : 'border-transparent text-lc-muted'
            }`}
            data-testid={`profile-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
          >
            {t(`profileFeed.${value}`)}
          </button>
        ))}
      </div>

      <div className="profile-feed-content min-h-40 flex-1" aria-live="polite" role="tabpanel">
        {loading && notes.length === 0 ? (
          <div className="space-y-3 p-4" data-testid="profile-feed-loading">
            {[0, 1, 2].map((item) => <div key={item} className="lc-skeleton h-24 rounded-xl" />)}
          </div>
        ) : tab === 'media' ? (
          media.length > 0 ? (
            <div className="grid grid-cols-3 gap-0.5" data-testid="profile-media-grid">
              {media.map(({ note, url }) => (
                <a
                  key={`${note.id}:${url}`}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="aspect-square overflow-hidden bg-lc-dark"
                >
                  {isVideoUrl(url) ? (
                    <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                </a>
              ))}
            </div>
          ) : <EmptyFeed error={error} />
        ) : visibleNotes.length > 0 ? (
          <div className="divide-y divide-lc-border">
            {visibleNotes.map((note) => (
              <article key={note.id} className="px-5 py-4" data-testid="profile-note">
                <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-lc-muted">
                  <span>{isReply(note) ? `↩ ${t('profileFeed.reply')}` : t('profileFeed.post')}</span>
                  <time dateTime={new Date(note.created_at * 1000).toISOString()}>
                    {new Date(note.created_at * 1000).toLocaleDateString()}
                  </time>
                </div>
                <div className="break-words text-sm text-lc-white">
                  <MessageContent content={note.content} messageId={note.id} />
                </div>
              </article>
            ))}
          </div>
        ) : <EmptyFeed error={error} />}
      </div>
    </div>
  );
}

function EmptyFeed({ error }: { error: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-lc-muted" data-testid="profile-feed-empty">
      {t(error ? 'profileFeed.loadFailed' : 'profileFeed.empty')}
    </div>
  );
}

function shortNpub(pubkey: string): string {
  try {
    const npub = hexToNpub(pubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
  }
}
