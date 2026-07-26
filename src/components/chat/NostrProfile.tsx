'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { TextCoercingWebSocket, hexToNpub } from '@nostr-wot/data';
import { getBridge, nostrActions, useMyPubkey, useUserMetadata } from '@/lib/nostr-bridge';
import { usePreferences } from '@/lib/preferences';
import {
  filterProfileFeed,
  hashtagTags,
  isReply,
  linkifyHashtags,
  mediaUrls,
  profileReplyTags,
  toggledFollowTags,
  type ProfileFeedTab,
} from '@/lib/profile-feed';
import { isVideoUrl } from '@/lib/attachments';
import { useTranslation } from '@/i18n/context';
import MessageContent from './MessageContent';
import UserAvatar from '@/components/UserAvatar';
import { uploadToBlossom } from '@/lib/blossom';
import { useModerationStore } from '@/store/moderation';
import { useToastStore } from '@/store/toast';

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
  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedMedia, setExpandedMedia] = useState<string | null>(null);

  useEffect(() => {
    void nostrActions.ensureUserMetadata(pubkey).catch(() => {});
  }, [pubkey]);

  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let receivedNote = false;
    let reachedEose = false;
    const pool = new SimplePool({
      websocketImplementation: TextCoercingWebSocket as unknown as typeof WebSocket,
      enablePing: true,
    } as ConstructorParameters<typeof SimplePool>[0]);

    const notesSub = pool.subscribe(relays, { kinds: [1], authors: [pubkey], limit: FEED_LIMIT }, {
      onevent: (event) => {
        receivedNote = true;
        if (closeTimer) clearTimeout(closeTimer);
        setLoading(false);
        setError(false);
        setNotes((current) => {
          if (current.some((note) => note.id === event.id)) return current;
          return [...current, event].sort((a, b) => b.created_at - a.created_at).slice(0, FEED_LIMIT);
        });
      },
      oneose: () => {
        reachedEose = true;
        if (closeTimer) clearTimeout(closeTimer);
        setLoading(false);
        setError(false);
      },
      onclose: () => {
        if (receivedNote || reachedEose || closeTimer) return;
        closeTimer = setTimeout(() => {
          setLoading(false);
          setError(true);
        }, 8000);
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
      if (closeTimer) clearTimeout(closeTimer);
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
            className="back-btn flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-lc-white md:hidden"
            aria-label={t('common.back')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto hidden h-9 w-9 items-center justify-center rounded-full bg-black/60 text-xl leading-none text-lc-white md:flex"
            aria-label={t('common.close')}
            data-testid="profile-explore-close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>

      <UserAvatar
        pubkey={pubkey}
        picture={meta?.picture}
        size={28}
        name={displayName}
        alt={displayName}
        className="profile-view-avatar relative z-10 -mt-14 ml-5 border-4 border-lc-black"
        initialClassName="text-3xl"
      />

      <div className="profile-view-meta shrink-0 px-5 pb-1 pt-2">
        <div className="profile-view-name text-xl font-extrabold text-lc-white">{displayName}</div>
        {meta?.nip05 && <div className="profile-view-nip05 mt-1 text-xs text-lc-green">{meta.nip05}</div>}
        <div className="profile-view-npub mt-1 font-mono text-[10px] text-lc-muted">{shortNpub(pubkey)}</div>
      </div>
      {meta?.about && (
        <p className="profile-view-bio whitespace-pre-wrap px-5 py-2 text-sm text-lc-muted">{meta.about}</p>
      )}

      {!isMe ? (
        <div className="profile-view-actions flex shrink-0 gap-2 px-5 py-3">
          <button
            type="button"
            className={`lc-pill-primary flex-1 text-xs disabled:opacity-50 ${following ? '!border !border-lc-border !bg-transparent !text-lc-white' : ''}`}
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
            <button type="button" className="lc-pill-secondary flex-1 text-xs" onClick={() => onMessage(pubkey)}>
              {t('mobile.profile.message')}
            </button>
          )}
          <ProfileMoreMenu pubkey={pubkey} displayName={displayName} />
        </div>
      ) : (
        <div className="px-5 py-3">
          <button
            type="button"
            className="lc-pill-primary flex items-center gap-2 px-4 py-2 text-xs"
            onClick={() => setComposerOpen((open) => !open)}
            aria-expanded={composerOpen}
            data-testid="profile-create-post"
          >
            <span className="text-lg leading-none" aria-hidden="true">+</span>
            {t('profileFeed.createPost')}
          </button>
        </div>
      )}
      {followError && <p className="px-5 pb-2 text-xs text-red-400">{t('profileFeed.followFailed')}</p>}
      {isMe && composerOpen && (
        <ProfileComposer
          relays={relays}
          onPublished={(event) => {
            setNotes((current) => [event, ...current.filter((note) => note.id !== event.id)].slice(0, FEED_LIMIT));
            setComposerOpen(false);
            setTab('posts');
          }}
        />
      )}

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
                <button
                  type="button"
                  key={`${note.id}:${url}`}
                  className="aspect-square overflow-hidden bg-lc-dark"
                  onClick={() => setExpandedMedia(url)}
                  aria-label={t('profileFeed.openMedia')}
                >
                  {isVideoUrl(url) ? (
                    <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          ) : <EmptyFeed error={error} />
        ) : visibleNotes.length > 0 ? (
          <div className="divide-y divide-lc-border">
            {visibleNotes.map((note) => (
              <ProfileNote
                key={note.id}
                note={note}
                displayName={displayName}
                picture={meta?.picture}
                relays={relays}
                canInteract={!!myPubkey}
              />
            ))}
          </div>
        ) : <EmptyFeed error={error} />}
      </div>
      {expandedMedia && (
        <ProfileMediaLightbox url={expandedMedia} onClose={() => setExpandedMedia(null)} />
      )}
    </div>
  );
}

function ProfileMediaLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('profileFeed.media')}
      onClick={onClose}
      data-testid="profile-media-lightbox"
    >
      <button
        type="button"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-2xl text-white"
        onClick={onClose}
        aria-label={t('common.close')}
      >
        ×
      </button>
      {isVideoUrl(url) ? (
        <video src={url} controls autoPlay className="max-h-full max-w-full object-contain" onClick={(event) => event.stopPropagation()} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="max-h-full max-w-full object-contain" onClick={(event) => event.stopPropagation()} />
      )}
    </div>
  );
}

function ProfileMoreMenu({ pubkey, displayName }: { pubkey: string; displayName: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const muted = useModerationStore((state) => state.mutedPubkeys.includes(pubkey));
  const toggleMute = useModerationStore((state) => state.toggleMute);
  const npub = hexToNpub(pubkey);
  const profileUrl = `https://njump.me/${npub}`;
  const notify = (title: string) => useToastStore.getState().pushToast({ title, body: displayName });

  const copyNpub = () => {
    navigator.clipboard?.writeText(npub).catch(() => {});
    notify(t('profileFeed.npubCopied'));
    setOpen(false);
  };
  const shareProfile = async () => {
    try {
      if (navigator.share) await navigator.share({ title: displayName, url: profileUrl });
      else await navigator.clipboard?.writeText(profileUrl);
      notify(t('profileFeed.profileShared'));
    } catch {
      // Native share cancellation needs no error UI.
    }
    setOpen(false);
  };

  return (
    <div className="relative md:hidden">
      <button
        type="button"
        className="lc-pill-secondary h-full px-4 text-base leading-none"
        onClick={() => setOpen((value) => !value)}
        aria-label={t('mobile.profile.more')}
        aria-expanded={open}
        data-testid="profile-more-button"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-44 overflow-hidden rounded-xl border border-lc-border bg-lc-dark py-1 shadow-2xl" data-testid="profile-more-menu">
          <button type="button" className="block w-full px-4 py-2 text-left text-xs text-lc-white hover:bg-white/5" onClick={copyNpub}>
            {t('profileFeed.copyNpub')}
          </button>
          <button
            type="button"
            className="block w-full px-4 py-2 text-left text-xs text-lc-white hover:bg-white/5"
            onClick={() => {
              toggleMute(pubkey);
              setOpen(false);
            }}
          >
            {t(muted ? 'profileFeed.unmute' : 'profileFeed.mute')}
          </button>
          <button type="button" className="block w-full px-4 py-2 text-left text-xs text-lc-white hover:bg-white/5" onClick={() => void shareProfile()}>
            {t('profileFeed.shareProfile')}
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileNote({
  note,
  displayName,
  picture,
  relays,
  canInteract,
}: {
  note: NostrEvent;
  displayName: string;
  picture?: string | null;
  relays: string[];
  canInteract: boolean;
}) {
  const { t } = useTranslation();
  const [replyOpen, setReplyOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [reacted, setReacted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const publishReaction = async () => {
    if (!canInteract || busy || reacted) return;
    setBusy(true);
    setStatus(null);
    try {
      const bridge = await getBridge();
      await bridge.publishEvent({
        kind: 7,
        content: '❤️',
        tags: [['e', note.id], ['p', note.pubkey]],
      }, { extraRelays: relays, mode: 'replace' });
      setReacted(true);
      setStatus(t('profileFeed.reactionSent'));
    } catch {
      setStatus(t('profileFeed.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const publishReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = reply.trim();
    if (!content || !canInteract || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const bridge = await getBridge();
      await bridge.publishEvent({
        kind: 1,
        content,
        tags: [...profileReplyTags(note), ...hashtagTags(content)],
      }, { extraRelays: relays, mode: 'replace' });
      setReply('');
      setReplyOpen(false);
      setStatus(t('profileFeed.replySent'));
    } catch {
      setStatus(t('profileFeed.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="px-5 py-4" data-testid="profile-note">
      <header className="mb-3 flex items-center gap-3">
        <UserAvatar pubkey={note.pubkey} picture={picture} size={10} name={displayName} alt={displayName} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-lc-white">{displayName}</div>
          <div className="flex items-center gap-2 text-[10px] text-lc-muted">
            <span>{isReply(note) ? `↩ ${t('profileFeed.reply')}` : t('profileFeed.post')}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(note.created_at * 1000).toISOString()}>
              {new Date(note.created_at * 1000).toLocaleDateString()}
            </time>
          </div>
        </div>
      </header>
      <div className="break-words text-sm text-lc-white">
        <MessageContent content={linkifyHashtags(note.content)} messageId={note.id} wideMedia />
      </div>
      <div className="mt-3 flex items-center gap-4 border-t border-lc-border/70 pt-2 text-xs">
        <button
          type="button"
          className="text-lc-muted hover:text-sky-400 disabled:opacity-40"
          onClick={() => setReplyOpen((open) => !open)}
          disabled={!canInteract || busy}
          data-testid="profile-note-reply"
        >
          ↩ {t('profileFeed.replyAction')}
        </button>
        <button
          type="button"
          className={reacted ? 'text-red-400' : 'text-lc-muted hover:text-red-400 disabled:opacity-40'}
          onClick={() => void publishReaction()}
          disabled={!canInteract || busy || reacted}
          data-testid="profile-note-react"
        >
          {reacted ? '♥' : '♡'} {t('profileFeed.react')}
        </button>
      </div>
      {replyOpen && (
        <form className="mt-3 flex gap-2" onSubmit={(event) => void publishReply(event)}>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            className="min-h-20 min-w-0 flex-1 resize-y rounded-xl border border-lc-border bg-lc-dark px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green"
            placeholder={t('profileFeed.replyPlaceholder')}
            data-testid="profile-reply-input"
          />
          <button type="submit" className="lc-pill-primary self-end px-4 py-2 text-xs" disabled={!reply.trim() || busy}>
            {t('common.send')}
          </button>
        </form>
      )}
      {status && <p className="mt-2 text-[11px] text-lc-muted" role="status">{status}</p>}
    </article>
  );
}

function ProfileComposer({
  relays,
  onPublished,
}: {
  relays: string[];
  onPublished: (event: NostrEvent) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const wrapSelection = (before: string, after = before) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = draft.slice(start, end);
    const next = draft.slice(0, start) + before + selected + after + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, end + before.length);
    });
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const urls = await Promise.all([...files].slice(0, 4).map((file) => uploadToBlossom(file)));
      setDraft((current) => [current.trim(), ...urls].filter(Boolean).join('\n'));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('profileFeed.actionFailed'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const publish = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const bridge = await getBridge();
      const published = await bridge.publishEvent({
        kind: 1,
        content,
        tags: hashtagTags(content),
      }, { extraRelays: relays, mode: 'replace' });
      setDraft('');
      onPublished(published);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : t('profileFeed.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mx-5 mb-4 rounded-xl border border-lc-border bg-lc-dark p-3" onSubmit={(event) => void publish(event)} data-testid="profile-composer">
      <div className="mb-2 flex items-center gap-1">
        <button type="button" className="rounded px-2 py-1 text-sm font-bold text-lc-muted hover:bg-white/5 hover:text-lc-white" onClick={() => wrapSelection('**')}>B</button>
        <button type="button" className="rounded px-2 py-1 text-sm italic text-lc-muted hover:bg-white/5 hover:text-lc-white" onClick={() => wrapSelection('_')}>I</button>
        <button type="button" className="rounded px-2 py-1 text-xs text-lc-muted hover:bg-white/5 hover:text-lc-white" onClick={() => wrapSelection('[', '](https://)')}>Link</button>
        <button type="button" className="ml-auto rounded px-2 py-1 text-xs text-lc-muted hover:bg-white/5 hover:text-lc-white" onClick={() => fileRef.current?.click()} disabled={busy}>
          + {t('profileFeed.upload')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={(event) => void uploadFiles(event.target.files)}
          data-testid="profile-post-files"
        />
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-28 w-full resize-y rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green"
        placeholder={t('profileFeed.postPlaceholder')}
        data-testid="profile-post-input"
      />
      {draft.trim() && (
        <div className="mt-2 rounded-lg border border-lc-border/70 bg-lc-black p-3 text-sm text-lc-white" data-testid="profile-post-preview">
          <MessageContent content={linkifyHashtags(draft)} wideMedia />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400" role="alert">{error}</p>}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[10px] text-lc-muted">{t('profileFeed.markdownHint')}</span>
        <button type="submit" className="lc-pill-primary px-5 py-2 text-xs" disabled={!draft.trim() || busy}>
          {busy ? t('common.saving') : t('profileFeed.publish')}
        </button>
      </div>
    </form>
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
