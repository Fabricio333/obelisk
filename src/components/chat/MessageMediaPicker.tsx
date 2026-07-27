'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import EmojiPicker, { MediaPickerSearch, RecentIcon, type PickedCustomEmoji } from './EmojiPicker';
import { uploadToBlossom } from '@/lib/blossom';
import { loadPersonalStickers } from '@/lib/personal-stickers';
import { normalizeCustomEmojiName, type CustomEmojiMap } from '@/lib/custom-emoji-tags';
import { mediaItemsFromPacks } from '@/lib/media-packs';
import { nostrActions, useMediaPacks, useMyMediaFavorites, useMyPubkey, type JsMediaItem, type JsMediaKind } from '@/lib/nostr-bridge';
import { useChatStore } from '@/store/chat';
import MediaLibraryModal from '@/components/media/MediaLibraryModal';
import { detectGifPresentation, inferMediaKind } from '@/lib/media-kind';

export type MediaPickerTab = 'emoji' | 'gif' | 'sticker';

const MEDIA_CATEGORIES = ['Recent', 'Trending', 'Reactions', 'Funny', 'Love', 'Celebration', 'Animals', 'Sports', 'Memes'] as const;
type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
type MediaEntry = PickedCustomEmoji & { categories?: readonly MediaCategory[]; kind?: JsMediaKind };
type RecentMediaEntry = MediaEntry & { tab: Exclude<MediaPickerTab, 'emoji'> };

const RECENT_MEDIA_KEY = 'obelisk:recent-media';
const GIPHY_KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY;
const giphy = (id: string) => 'https://media.giphy.com/media/' + id + '/giphy.gif';
const twemoji = (code: string) => 'https://cdn.jsdelivr.net/gh/jdecked/twemoji/assets/svg/' + code + '.svg';

const STARTER_GIFS: MediaEntry[] = [
  { name: 'applause', url: giphy('l3q2XhfQ8oCkm1Ts4'), categories: ['Reactions', 'Celebration'] },
  { name: 'mind_blown', url: giphy('26ufdipQqU2lhNA4g'), categories: ['Reactions', 'Memes'] },
  { name: 'laughing', url: giphy('10JhviFuU2gWD6'), categories: ['Funny', 'Memes'] },
  { name: 'yes', url: giphy('3o7abKhOpu0NwenH3O'), categories: ['Reactions'] },
  { name: 'celebrate', url: giphy('IwAZ6dvvvaTtdI8SD5'), categories: ['Celebration'] },
  { name: 'party', url: giphy('KzDqC8LvVC4lshCcGK'), categories: ['Celebration', 'Funny'] },
  { name: 'love', url: giphy('MDJ9IbxxvDUQM'), categories: ['Love'] },
  { name: 'facepalm', url: giphy('TJawtKM6OCKkvwCIqX'), categories: ['Reactions', 'Funny'] },
  { name: 'shrug', url: giphy('jPAdK8Nfzzwt2'), categories: ['Reactions', 'Memes'] },
  { name: 'popcorn', url: giphy('pUeXcg80cO8I8'), categories: ['Reactions', 'Memes'] },
  { name: 'thumbs_up', url: giphy('Od0QRnzwRBYmDU3eEO'), categories: ['Reactions'] },
  { name: 'happy_dance', url: giphy('artj92V8o75VPL7AeQ'), categories: ['Funny', 'Celebration'] },
  { name: 'dancing_cat', url: giphy('Qak74xcP7zKwzhIUry'), categories: ['Animals', 'Funny'] },
  { name: 'surprised_cat', url: giphy('u9vFMyx1Ix2l17Lc1n'), categories: ['Animals', 'Reactions'] },
  { name: 'basketball_hype', url: giphy('6UvClQVUrThCqeQHdX'), categories: ['Sports', 'Celebration'] },
  { name: 'soccer_celebration', url: giphy('XQs3F0TXdfy82jP4Qz'), categories: ['Sports', 'Celebration'] },
  { name: 'football_dance', url: giphy('xULW8x46jYrflDwdUI'), categories: ['Sports', 'Funny', 'Celebration'] },
  { name: 'dance_off', url: giphy('e62BYDU8YaoZz6dU2D'), categories: ['Funny', 'Celebration'] },
  { name: 'confetti_dance', url: giphy('9G5bX9nXYfmmatgn0B'), categories: ['Celebration'] },
  { name: 'sweet_hug', url: giphy('xd2aaDSJk8ovOFNvwC'), categories: ['Love', 'Animals'] },
  { name: 'subtle_wow', url: giphy('B11zhZWB5wfZtMl1D4'), categories: ['Reactions', 'Memes'] },
  { name: 'wait_what', url: giphy('JrekqK5AE0HRJIl13j'), categories: ['Reactions', 'Funny'] },
];

const STARTER_STICKERS: MediaEntry[] = [
  { name: 'laugh_cry', url: twemoji('1f602'), categories: ['Funny', 'Reactions'] },
  { name: 'heart', url: twemoji('2764'), categories: ['Love'] },
  { name: 'fire', url: twemoji('1f525'), categories: ['Reactions', 'Memes'] },
  { name: 'thumbs_up', url: twemoji('1f44d'), categories: ['Reactions'] },
  { name: 'party_popper', url: twemoji('1f389'), categories: ['Celebration'] },
  { name: 'cool', url: twemoji('1f60e'), categories: ['Funny', 'Memes'] },
  { name: 'rocket', url: twemoji('1f680'), categories: ['Celebration', 'Memes'] },
  { name: 'cat', url: twemoji('1f431'), categories: ['Animals'] },
  { name: 'football', url: twemoji('26bd'), categories: ['Sports'] },
  { name: 'hundred', url: twemoji('1f4af'), categories: ['Reactions', 'Memes'] },
  { name: 'eyes', url: twemoji('1f440'), categories: ['Reactions', 'Memes'] },
  { name: 'exploding_head', url: twemoji('1f92f'), categories: ['Reactions'] },
  { name: 'raised_hands', url: twemoji('1f64c'), categories: ['Celebration'] },
  { name: 'broken_heart', url: twemoji('1f494'), categories: ['Love'] },
  { name: 'clown', url: twemoji('1f921'), categories: ['Funny', 'Memes'] },
  { name: 'salute', url: twemoji('1fae1'), categories: ['Reactions'] },
  { name: 'clap', url: twemoji('1f44f'), categories: ['Reactions', 'Celebration'] },
  { name: 'party_face', url: twemoji('1f973'), categories: ['Funny', 'Celebration'] },
  { name: 'hearts_face', url: twemoji('1f970'), categories: ['Love'] },
  { name: 'heart_eyes', url: twemoji('1f60d'), categories: ['Love', 'Reactions'] },
  { name: 'loud_cry', url: twemoji('1f62d'), categories: ['Reactions', 'Memes'] },
  { name: 'angry', url: twemoji('1f621'), categories: ['Reactions'] },
  { name: 'thinking', url: twemoji('1f914'), categories: ['Reactions', 'Memes'] },
  { name: 'scream', url: twemoji('1f631'), categories: ['Reactions', 'Funny'] },
  { name: 'poop', url: twemoji('1f4a9'), categories: ['Funny', 'Memes'] },
  { name: 'dog', url: twemoji('1f436'), categories: ['Animals'] },
  { name: 'unicorn', url: twemoji('1f984'), categories: ['Animals', 'Memes'] },
  { name: 'basketball', url: twemoji('1f3c0'), categories: ['Sports'] },
  { name: 'trophy', url: twemoji('1f3c6'), categories: ['Sports', 'Celebration'] },
  { name: 'beers', url: twemoji('1f37b'), categories: ['Celebration'] },
  { name: 'diamond', url: twemoji('1f48e'), categories: ['Love', 'Memes'] },
  { name: 'sparkles', url: twemoji('2728'), categories: ['Celebration', 'Love'] },
];

function loadRecentMedia(): RecentMediaEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_MEDIA_KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(0, 24) : [];
  } catch {
    return [];
  }
}

function saveRecentMedia(entry: RecentMediaEntry): RecentMediaEntry[] {
  const next = [entry, ...loadRecentMedia().filter((item) => item.url !== entry.url)].slice(0, 24);
  localStorage.setItem(RECENT_MEDIA_KEY, JSON.stringify(next));
  return next;
}

export default function MessageMediaPicker({
  onPick,
  onClose,
  variant = 'popover',
  placement = 'above',
  customEmojis = {},
  initialTab = 'emoji',
}: {
  onPick: (emoji: string, custom?: PickedCustomEmoji, kind?: MediaPickerTab) => void;
  onClose: () => void;
  variant?: 'popover' | 'sheet';
  placement?: 'above' | 'below';
  customEmojis?: CustomEmojiMap;
  initialTab?: MediaPickerTab;
}) {
  const [tab, setTab] = useState<MediaPickerTab>(initialTab);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MediaCategory>('Trending');
  const [recentMedia, setRecentMedia] = useState<RecentMediaEntry[]>(loadRecentMedia);
  const [remote, setRemote] = useState<MediaEntry[]>([]);
  const [personal] = useState<CustomEmojiMap>(() => loadPersonalStickers());
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState<'mine' | 'favorites' | null>(null);
  const [kindOverrides, setKindOverrides] = useState<Record<string, JsMediaKind>>({});
  const mediaPacks = useMediaPacks();
  const mediaFavorites = useMyMediaFavorites();
  const myPubkey = useMyPubkey();
  const serverMediaKinds = useChatStore((state) => state.serverMediaKinds);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!GIPHY_KEY || tab === 'emoji' || category === 'Recent') return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRemote([]);
      const term = query.trim() || (category === 'Trending' ? '' : category);
      const kind = tab === 'gif' ? 'gifs' : 'stickers';
      const endpoint = term ? 'search' : 'trending';
      const url = new URL('https://api.giphy.com/v1/' + kind + '/' + endpoint);
      url.searchParams.set('api_key', GIPHY_KEY);
      url.searchParams.set('limit', '24');
      url.searchParams.set('rating', 'g');
      if (term) url.searchParams.set('q', term);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('GIPHY request failed');
        const payload = await response.json() as { data?: Array<{ id: string; title?: string; images?: { fixed_height?: { url?: string } } }> };
        setRemote((payload.data ?? []).flatMap((item) => {
          const mediaUrl = item.images?.fixed_height?.url;
          if (!mediaUrl) return [];
          return [{ name: normalizeCustomEmojiName(item.title || item.id) || item.id, url: mediaUrl, kind: tab === 'sticker' ? 'sticker' : 'gif', categories: [category] }];
        }));
      } catch {
        if (!controller.signal.aborted) setRemote([]);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [category, query, tab]);

  const personalEntries = useMemo(() => {
    const byUrl = new Map<string, MediaEntry>();
    for (const [name, url] of Object.entries(personal)) {
      const normalized = normalizeCustomEmojiName(name);
      if (normalized && url) byUrl.set(url, { name: normalized, url, kind: 'sticker' });
    }
    for (const item of [
      ...mediaItemsFromPacks(mediaFavorites.packAddresses, mediaPacks),
      ...mediaFavorites.items,
    ]) byUrl.set(item.url, { ...item, kind: kindOverrides[item.url] ?? item.kind });
    return Array.from(byUrl.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [kindOverrides, mediaFavorites, mediaPacks, personal]);
  const serverEntries = useMemo(() => {
    const personalUrls = new Set(personalEntries.map((entry) => entry.url));
    const starterUrls = new Set([...STARTER_GIFS, ...STARTER_STICKERS].map((entry) => entry.url));
    return Object.entries(customEmojis)
      .map(([name, url]) => {
        const normalized = normalizeCustomEmojiName(name);
        return { name: normalized, url, kind: kindOverrides[url] ?? serverMediaKinds[normalized] ?? (inferMediaKind(url) === 'gif' ? 'gif' : 'sticker') };
      })
      .filter((entry) => entry.name && entry.url && !personalUrls.has(entry.url) && !starterUrls.has(entry.url))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [customEmojis, kindOverrides, personalEntries, serverMediaKinds]);
  const emojiEntries = [...serverEntries, ...personalEntries.filter((entry) => entry.kind !== 'sticker')];
  const serverCustomEmojis = Object.fromEntries(emojiEntries.map((entry) => [entry.name, entry.url]));
  const serverCustomMediaKinds = Object.fromEntries([
    ...serverEntries.map((entry) => [entry.name, kindOverrides[entry.url] ?? serverMediaKinds[entry.name] ?? inferMediaKind(entry.url)]),
    ...personalEntries.filter((entry) => entry.kind !== 'sticker').map((entry) => [entry.name, entry.kind]),
  ]);
  const normalizedQuery = normalizeCustomEmojiName(query);
  const matchesQuery = (entry: MediaEntry) => !normalizedQuery || entry.name.includes(normalizedQuery);
  const matchesTab = (entry: MediaEntry) => entry.kind === tab;
  const recentVisible = recentMedia
    .map((entry) => ({ ...entry, kind: kindOverrides[entry.url] ?? entry.kind ?? entry.tab }))
    .filter((entry) => matchesTab(entry) && matchesQuery(entry));
  const serverVisible = serverEntries.filter((entry) => matchesTab(entry) && matchesQuery(entry));
  const personalVisible = personalEntries.filter((entry) => matchesTab(entry) && matchesQuery(entry));
  const starterEntries: MediaEntry[] = [
    ...STARTER_GIFS.map((entry) => ({ ...entry, kind: kindOverrides[entry.url] ?? 'gif' as const })),
    ...STARTER_STICKERS.map((entry) => ({ ...entry, kind: 'sticker' as const })),
  ];
  const defaultCatalog = [
    ...remote.map((entry) => ({ ...entry, kind: kindOverrides[entry.url] ?? entry.kind ?? tab })),
    ...starterEntries,
  ].filter((entry) => matchesTab(entry) && matchesQuery(entry));
  const defaultVisible = category === 'Trending' || category === 'Recent' || normalizedQuery
    ? defaultCatalog
    : defaultCatalog.filter((entry) => entry.categories?.includes(category));
  const favoriteUrls = new Set(mediaFavorites.items.map((item) => item.url));
  const isSheet = variant === 'sheet';
  const placementClass = placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1';
  const shellClass = isSheet
    ? 'flex h-full w-full flex-col overflow-hidden bg-lc-black text-lc-white'
    : `absolute left-0 ${placementClass} z-40 flex h-[520px] max-h-[calc(100vh-1rem)] w-[600px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl border border-lc-border bg-lc-black text-lc-white shadow-2xl`;

  const createMedia = async (file: File | undefined, kind: JsMediaKind) => {
    if (!file) return;
    setUploading(true);
    try {
      if (!myPubkey) throw new Error("Log in to create media.");
      const url = await uploadToBlossom(file);
      const name = normalizeCustomEmojiName(file.name) || kind;
      await nostrActions.saveMediaFavorites({
        items: [
          ...mediaFavorites.items.filter((item) => item.url !== url && item.name !== name),
          { name, url, kind },
        ],
        packAddresses: mediaFavorites.packAddresses,
      });
      setLibraryOpen("favorites");
    } finally {
      setUploading(false);
    }
  };

  const createControl = (kind: JsMediaKind, square = false) => {
    const label = kind === "gif" ? "GIF" : kind;
    return <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          void createMedia(event.target.files?.[0], kind);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        className={(square ? "aspect-square w-full " : "h-full ") + "flex min-h-0 min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-lc-border bg-lc-dark text-lc-muted hover:border-lc-green/50 hover:text-lc-white disabled:opacity-50"}
        aria-label={"Create " + label}
      >
        <span className="text-3xl font-light leading-none" aria-hidden="true">+</span>
        <span className="text-xs">{uploading ? "Creating…" : "Create"}</span>
      </button>
    </>;
  };

  if (tab === "emoji") {
    return (
      <div className={shellClass} data-testid="media-picker-shell">
        <div className="min-h-0 flex-1 [&_[role=dialog]]:static [&_[role=dialog]]:h-full [&_[role=dialog]]:w-full [&_[role=dialog]]:rounded-none [&_[role=dialog]]:border-0">
          <EmojiPicker
            variant="sheet"
            showClose={false}
            customEmojis={serverCustomEmojis}
            customMediaKinds={serverCustomMediaKinds}
            columns={isSheet ? 7 : 12}
            customEmojiAction={createControl("emoji", true)}
            onPick={onPick}
            onClose={onClose}
          >
            <PickerTabs tab={tab} onTab={setTab} />
          </EmojiPicker>
        </div>
        {libraryOpen && <MediaLibraryModal onClose={() => setLibraryOpen(null)} initialTab={libraryOpen} initialKind="emoji" />}
      </div>
    );
  }

  const classifyEntry = (entry: MediaEntry) => {
    if ((entry.kind ?? inferMediaKind(entry.url)) !== 'gif') return;
    void detectGifPresentation(entry.url).then((kind) => {
      if (kind === 'sticker') setKindOverrides((current) => current[entry.url] === kind ? current : { ...current, [entry.url]: kind });
    });
  };

  const toggleFavorite = async (entry: MediaEntry) => {
    const kind = kindOverrides[entry.url] ?? entry.kind ?? (tab === 'gif' ? 'gif' : 'sticker');
    const item: JsMediaItem = {
      name: entry.name,
      url: entry.url,
      kind,
      ...(entry.packAddress ? { packAddress: entry.packAddress } : {}),
    };
    const selected = favoriteUrls.has(entry.url);
    await nostrActions.saveMediaFavorites({
      items: selected
        ? mediaFavorites.items.filter((favorite) => favorite.url !== entry.url)
        : [...mediaFavorites.items, item],
      packAddresses: mediaFavorites.packAddresses,
    });
  };
  const favoriteMedia = (entry: MediaEntry) => {
    void toggleFavorite(entry).catch(() => {});
  };

  const pickMedia = (entry: MediaEntry) => {
    const kind = kindOverrides[entry.url] ?? entry.kind ?? (tab === 'gif' ? 'gif' : 'sticker');
    const presentation = kind === 'gif' ? 'gif' : 'sticker';
    const recent = { ...entry, kind, tab: presentation } as RecentMediaEntry;
    setRecentMedia(saveRecentMedia(recent));
    if (presentation === 'gif') onPick(entry.url, undefined, presentation);
    else onPick(':' + entry.name + ':', { name: entry.name, url: entry.url, ...(entry.packAddress ? { packAddress: entry.packAddress } : {}) }, presentation);
  };


  return (
    <div className={shellClass} data-testid="media-picker-shell">
      <div role="dialog" aria-label="Media picker" className="flex h-full w-full flex-col overflow-hidden bg-lc-black p-2 text-lc-white" onClick={(event) => event.stopPropagation()}>
      <nav className="mb-2 grid shrink-0 grid-cols-9 border-b border-lc-border px-1 pb-1" aria-label="Media categories">
        {MEDIA_CATEGORIES.map((value) => (
          <button
            type="button"
            key={value}
            onClick={() => { setCategory(value); setQuery(''); }}
            aria-label={value}
            aria-pressed={category === value}
            title={value}
            className={['flex h-10 min-w-0 items-center justify-center rounded-lg border-b-2', category === value ? 'border-lc-green bg-lc-green/10 text-lc-green' : 'border-transparent text-lc-muted hover:bg-white/5'].join(' ')}
          >
            <MediaCategoryIcon category={value} />
          </button>
        ))}
      </nav>
      <div className="my-2 flex items-center gap-2">
        <MediaPickerSearch
          value={query}
          onChange={setQuery}
          placeholder={tab === "gif" ? "Search GIFs" : "Search stickers"}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="media-grid">
        {category === 'Recent' ? (
          <MediaSection title={tab === 'gif' ? 'Recent GIFs' : 'Recent stickers'} entries={recentVisible} onPick={pickMedia} favoriteUrls={favoriteUrls} onFavorite={favoriteMedia} onMediaLoad={classifyEntry} />
        ) : (
          <>
            {(tab === "sticker" || tab === "gif" || personalVisible.length > 0) && (
              <MediaSection title={tab === 'gif' ? 'My GIFs' : 'My stickers'} entries={personalVisible} onPick={pickMedia} favoriteUrls={favoriteUrls} onFavorite={favoriteMedia} onMediaLoad={classifyEntry}>
                {createControl(tab)}
              </MediaSection>
            )}
            <MediaSection title={tab === 'gif' ? 'Default GIFs' : 'Default stickers'} entries={defaultVisible} onPick={pickMedia} favoriteUrls={favoriteUrls} onFavorite={favoriteMedia} onMediaLoad={classifyEntry} />
            {serverVisible.length > 0 && (
              <MediaSection title={tab === 'gif' ? 'Server GIFs' : 'Server stickers'} entries={serverVisible} onPick={pickMedia} favoriteUrls={favoriteUrls} onFavorite={favoriteMedia} onMediaLoad={classifyEntry} />
            )}
          </>
        )}
        {category === 'Recent' && recentVisible.length === 0 && (
          <div className="py-12 text-center text-sm text-lc-muted">No recent {tab === 'gif' ? 'GIFs' : 'stickers'}</div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 pb-1">
        <button type="button" onClick={() => setLibraryOpen("mine")} className="text-xs font-medium text-lc-green hover:underline" data-testid="manage-media-packs">
          Favorites &amp; packs
        </button>
        <span className="text-right text-[10px] text-lc-muted">{tab === 'gif' ? 'Powered by GIPHY' : 'Stickers by Twemoji'}</span>
      </div>
      <PickerTabs tab={tab} onTab={setTab} />
      {libraryOpen && <MediaLibraryModal onClose={() => setLibraryOpen(null)} initialTab={libraryOpen} initialKind={tab} />}
      </div>
    </div>
  );
}

function MediaSection({ title, entries, onPick, favoriteUrls, onFavorite, onMediaLoad, children }: {
  title: string;
  entries: readonly MediaEntry[];
  onPick: (entry: MediaEntry) => void;
  favoriteUrls: ReadonlySet<string>;
  onFavorite: (entry: MediaEntry) => void;
  onMediaLoad: (entry: MediaEntry) => void;
  children?: ReactNode;
}) {
  if (!children && entries.length === 0) return null;
  return (
    <section className="mb-3" data-testid={'media-section-' + normalizeCustomEmojiName(title)}>
      <h3 className="sticky top-0 z-10 mb-2 border-b border-lc-border bg-lc-black/95 py-2 text-[11px] font-bold uppercase tracking-wider text-lc-muted backdrop-blur">{title}</h3>
      <div className="grid grid-cols-4 auto-rows-[82px] content-start gap-2">
        {children}
        {entries.map((entry) => {
          const favorite = favoriteUrls.has(entry.url);
          return (
            <div key={entry.url} className="relative h-full min-h-0 min-w-0">
              <button
                type="button"
                onClick={() => onPick(entry)}
                title={':' + entry.name + ':'}
                className="flex h-full w-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border border-lc-border/60 bg-lc-dark p-2 hover:border-lc-green/50 hover:bg-lc-card"
              >
                <img src={entry.url} alt={':' + entry.name + ':'} onLoad={() => onMediaLoad(entry)} className="block max-h-full max-w-full object-contain" />
              </button>
              <button
                type="button"
                onClick={() => onFavorite(entry)}
                aria-label={(favorite ? 'Remove :' : 'Add :') + entry.name + ': ' + (favorite ? 'from favorites' : 'to favorites')}
                className={"absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full border bg-lc-black/85 text-sm " + (favorite ? "border-lc-green text-lc-green" : "border-white/20 text-lc-white")}
              >
                {favorite ? '★' : '☆'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MediaCategoryIcon({ category }: { category: MediaCategory }) {
  const props = { className: 'h-5 w-5', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (category === 'Recent') return <RecentIcon />;
  if (category === 'Trending') return <svg {...props}><path d="m4 16 5-5 4 4 7-8" /><path d="M15 7h5v5" /></svg>;
  if (category === 'Reactions') return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M9 10h.01M15 10h.01M8.5 14s1.2 2 3.5 2 3.5-2 3.5-2" /></svg>;
  if (category === 'Funny') return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="m8 10 2-1-2-1m8 2-2-1 2-1M8.5 14h7c-.8 2-2 3-3.5 3s-2.7-1-3.5-3Z" /></svg>;
  if (category === 'Love') return <svg {...props}><path d="M20 9c0 5-8 10-8 10S4 14 4 9a4 4 0 0 1 7-2.6A4 4 0 0 1 20 9Z" /></svg>;
  if (category === 'Celebration') return <svg {...props}><path d="m5 19 4-10 6 6-10 4ZM13 5l1-2m3 6 3-1m-2 5 2 1M9 4 8 2" /></svg>;
  if (category === 'Animals') return <svg {...props}><path d="m6 9-1-5 5 3h4l5-3-1 5a7 7 0 1 1-12 0Z" /><path d="M9 12h.01M15 12h.01M10 15h4" /></svg>;
  if (category === 'Sports') return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="m9 9 3-2 3 2-1 4h-4L9 9Zm1 4-3 2m7-2 3 2m-5-8V4m-2 15 2-3 2 3" /></svg>;
  return <svg {...props}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m7 15 3-3 3 3 2-2 2 2M8 9h.01" /></svg>;
}

function PickerTabs({
  tab,
  onTab,
}: {
  tab: MediaPickerTab;
  onTab: (tab: MediaPickerTab) => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center border-t border-white/10 px-2">
      {(['emoji', 'gif', 'sticker'] as const).map((value) => (
        <button
          type="button"
          key={value}
          onClick={() => onTab(value)}
          aria-pressed={tab === value}
          className={`h-full flex-1 border-b-2 text-xs font-semibold uppercase tracking-wide ${tab === value ? 'border-lc-green text-lc-green' : 'border-transparent text-lc-muted'}`}
        >
          {value === 'sticker' ? 'Stickers' : value}
        </button>
      ))}
    </div>
  );
}
