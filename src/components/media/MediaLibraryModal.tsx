'use client';

import { useMemo, useRef, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import { uploadToBlossom } from '@/lib/blossom';
import { isValidCustomEmojiName, normalizeCustomEmojiName } from '@/lib/custom-emoji-tags';
import { nostrActions, useMediaPacks, useMyMediaFavorites, useMyPubkey } from '@/lib/nostr-bridge';
import type { JsMediaItem, JsMediaKind, JsMediaPack } from '@/lib/nostr-bridge';
import { publishRelayEmojiSet, type RelayEmojiSet } from '@/lib/relay-emojis';
import { mediaPackAddress } from '@/lib/media-packs';

type LibraryTab = 'discover' | 'mine' | 'favorites' | 'server';
type MediaFilter = 'all' | JsMediaKind;
type EditablePack = Pick<JsMediaPack, 'identifier' | 'title' | 'description' | 'image' | 'items'>;
type SelectedMedia = { pack: JsMediaPack; item: JsMediaItem };

const fieldClass = 'w-full rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green';
const tabClass = 'w-full rounded-lg px-3 py-2 text-left text-sm transition';

function inferredKind(url: string): JsMediaKind {
  return /\.gif(?:$|[?#])/i.test(url) ? 'gif' : 'emoji';
}

function uniqueName(raw: string, used: Set<string>): string {
  const base = normalizeCustomEmojiName(raw) || 'media';
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

function newPack(): EditablePack {
  return {
    identifier: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'New pack',
    description: '',
    image: '',
    items: [],
  };
}

function serverImport(relayUrl: string): { host: string; identifier: string } {
  let host = 'server';
  try { host = new URL(relayUrl).host; } catch { /* use fallback */ }
  return { host, identifier: 'server-' + (normalizeCustomEmojiName(host) || 'emojis') };
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export default function MediaLibraryModal({
  onClose,
  server,
  initialTab = server ? 'server' : 'discover',
  initialSelection,
}: {
  onClose: () => void;
  server?: { relayUrl: string; emojiSet: RelayEmojiSet };
  initialTab?: LibraryTab;
  initialSelection?: SelectedMedia;
}) {
  const myPubkey = useMyPubkey();
  const launchedFromItem = !!initialSelection;
  const packsByAddress = useMediaPacks();
  const favorites = useMyMediaFavorites();
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [kindFilter, setKindFilter] = useState<MediaFilter>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<EditablePack | null>(null);
  const [viewingPack, setViewingPack] = useState<JsMediaPack | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<SelectedMedia | null>(initialSelection ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const packs = useMemo(() => Object.values(packsByAddress)
    .filter((pack) => pack.items.length > 0)
    .sort((a, b) => b.createdAt - a.createdAt), [packsByAddress]);
  const importedServerPack = server && myPubkey
    ? packsByAddress[mediaPackAddress(myPubkey, serverImport(server.relayUrl).identifier)]
    : undefined;
  const visiblePacks = useMemo(() => {
    const value = query.trim().toLowerCase();
    const source = tab === 'mine'
      ? packs.filter((pack) => pack.author === myPubkey)
      : tab === 'favorites'
        ? packs.filter((pack) => favorites.packAddresses.includes(pack.address))
        : packs;
    const matchingKind = kindFilter === 'all'
      ? source
      : source.filter((pack) => pack.items.some((item) => item.kind === kindFilter));
    return value
      ? matchingKind.filter((pack) => `${pack.title} ${pack.description} ${pack.items.map((item) => item.name).join(' ')}`.toLowerCase().includes(value))
      : matchingKind;
  }, [favorites.packAddresses, kindFilter, myPubkey, packs, query, tab]);

  const saveFavorites = async (next: { items: readonly JsMediaItem[]; packAddresses: readonly string[] }) => {
    setBusy(true);
    setMessage(null);
    try {
      await nostrActions.saveMediaFavorites(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save favorites.');
    } finally {
      setBusy(false);
    }
  };

  const togglePack = (pack: JsMediaPack) => {
    const selected = favorites.packAddresses.includes(pack.address);
    void saveFavorites({
      items: favorites.items,
      packAddresses: selected
        ? favorites.packAddresses.filter((address) => address !== pack.address)
        : [...favorites.packAddresses, pack.address],
    });
  };

  const toggleItem = (item: JsMediaItem) => {
    const selected = favorites.items.some((favorite) => favorite.url === item.url);
    void saveFavorites({
      packAddresses: favorites.packAddresses,
      items: selected
        ? favorites.items.filter((favorite) => favorite.url !== item.url)
        : [...favorites.items, item],
    });
  };

  const deletePack = async (pack: JsMediaPack) => {
    if (!window.confirm('Delete “' + pack.title + '”? This sends a Nostr deletion request and cannot be undone.')) return;
    setBusy(true);
    setMessage(null);
    try {
      await nostrActions.deleteMediaPack(pack.address);
      setMessage('Deleted “' + pack.title + '”.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete pack.');
    } finally {
      setBusy(false);
    }
  };

  const updateServerItems = async (
    items: readonly JsMediaItem[],
    success: string,
    packAddresses = server?.emojiSet.packAddresses ?? [],
  ) => {
    if (!server) return;
    setBusy(true);
    setMessage(null);
    try {
      await publishRelayEmojiSet(server.relayUrl, {
        ...server.emojiSet,
        title: server.emojiSet.title || "Server favorites",
        emojis: items,
        packAddresses,
      });
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update server favorites.");
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const addPackToServer = async (pack: Pick<JsMediaPack, "title" | "items"> & { address?: string; identifier?: string }) => {
    if (!server) return;
    const address = pack.address ?? (myPubkey && pack.identifier ? mediaPackAddress(myPubkey, pack.identifier) : "");
    if (!address || server.emojiSet.packAddresses?.includes(address)) return;
    const packNames = new Set(pack.items.map((item) => item.name));
    const packUrls = new Set(pack.items.map((item) => item.url));
    await updateServerItems(
      server.emojiSet.emojis.filter((item) => !packNames.has(item.name) && !packUrls.has(item.url)),
      "Added pack “" + pack.title + "” to this server.",
      [...(server.emojiSet.packAddresses ?? []), address],
    );
  };

  const removePackFromServer = async (pack: JsMediaPack) => {
    if (!server) return;
    await updateServerItems(
      server.emojiSet.emojis,
      "Removed pack “" + pack.title + "” from this server.",
      (server.emojiSet.packAddresses ?? []).filter((address) => address !== pack.address),
    );
  };

  const toggleServerPack = async (pack: JsMediaPack) => {
    if (server?.emojiSet.packAddresses?.includes(pack.address)) await removePackFromServer(pack);
    else await addPackToServer(pack);
  };

  const addServerItem = async (item: JsMediaItem, packTitle: string) => {
    if (!server) return;
    const byName = new Map(server.emojiSet.emojis.map((value) => [value.name, value]));
    byName.set(item.name, item);
    await updateServerItems(
      Array.from(byName.values()).map((value) => ({ ...value, kind: value.kind ?? inferredKind(value.url) })),
      "Added :" + item.name + ": from “" + packTitle + "” to this server.",
    );
  };

  const removeServerItem = async (item: JsMediaItem) => {
    if (!server) return;
    await updateServerItems(
      server.emojiSet.emojis
        .filter((value) => value.name !== item.name)
        .map((value) => ({ ...value, kind: value.kind ?? inferredKind(value.url) })),
      "Removed :" + item.name + ": from this server.",
    );
  };

  const migrateLegacy = async () => {
    if (!server || server.emojiSet.emojis.length === 0) return;
    const imported = serverImport(server.relayUrl);
    setBusy(true);
    setMessage(null);
    try {
      await nostrActions.saveMediaPack({
        identifier: imported.identifier,
        title: server.emojiSet.title || imported.host + ' media',
        description: 'Imported from ' + imported.host + '.',
        image: '',
        items: server.emojiSet.emojis.map((item) => ({
          name: item.name,
          url: item.url,
          kind: item.kind ?? inferredKind(item.url),
        })),
      });
      setMessage(`Imported all ${server.emojiSet.emojis.length} existing server items into an editable pack.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not migrate the server list.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      closeOnEscape={!editing && !viewingPack && !selectedMedia}
      testId="media-library-modal"
      panelClassName="lc-card mx-3 flex h-[min(780px,94vh)] w-full max-w-6xl overflow-hidden bg-lc-dark"
    >
      <aside className="hidden w-52 shrink-0 flex-col border-r border-lc-border bg-lc-black/40 p-3 sm:flex">
        <div className="px-2 pb-4 pt-2">
          <div className="text-base font-bold text-lc-white">Media library</div>
          <div className="mt-1 text-xs text-lc-muted">Emoji · GIFs · Stickers</div>
        </div>
        <LibraryTabs tab={tab} setTab={setTab} server={!!server} />
        <button type="button" onClick={() => setEditing(newPack())} className="mt-auto rounded-lg bg-lc-green px-3 py-2 text-sm font-semibold text-lc-black">
          Create pack
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-lc-border p-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-lc-white sm:hidden">Media library</div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search packs and media"
              aria-label="Search packs and media"
              className={`${fieldClass} mt-2 sm:mt-0`}
            />
          </div>
          <button type="button" onClick={() => setEditing(newPack())} className="rounded-lg border border-lc-green px-3 py-2 text-sm text-lc-green sm:hidden">Create pack</button>
          <button type="button" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-lc-muted hover:bg-white/5 hover:text-lc-white" aria-label="Close media library">✕</button>
        </header>

        <div className="shrink-0 overflow-x-auto border-b border-lc-border p-2 sm:hidden">
          <div className="flex min-w-max gap-1"><LibraryTabs tab={tab} setTab={setTab} server={!!server} mobile /></div>
        </div>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-lc-border px-4 py-2" role="group" aria-label="Filter packs by media type">
          {([['all', 'All'], ['emoji', 'Emoji'], ['gif', 'GIFs'], ['sticker', 'Stickers']] as Array<[MediaFilter, string]>).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setKindFilter(value)} aria-pressed={kindFilter === value} className={`rounded-full border px-3 py-1 text-xs ${kindFilter === value ? 'border-lc-green bg-lc-green/10 text-lc-green' : 'border-lc-border text-lc-muted'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'server' && server && (
            <section className="mb-5 rounded-xl border border-lc-border bg-lc-black/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-lc-white">This server’s favorites</h2>
                  <p className="mt-1 text-xs text-lc-muted">{server.emojiSet.emojis.length} items selected for this server.</p>
                </div>
                {!importedServerPack && <button type="button" disabled={busy || server.emojiSet.emojis.length === 0} onClick={() => void migrateLegacy()} className="rounded-lg border border-lc-green px-3 py-2 text-sm text-lc-green disabled:opacity-40">
                  Import existing list once
                </button>}
              </div>
              <MediaGrid
                items={server.emojiSet.emojis
                  .map((item) => ({ ...item, kind: item.kind ?? inferredKind(item.url) }))
                  .filter((item) => kindFilter === "all" || item.kind === kindFilter)}
                busy={busy}
                onRemove={(item) => void removeServerItem(item).catch(() => {})}
              />
            </section>
          )}

          {tab === 'favorites' && favorites.items.length > 0 && (
            <section className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-lc-white">Individual favorites</h2>
              <MediaGrid items={favorites.items.filter((item) => kindFilter === "all" || item.kind === kindFilter)} favorites={favorites.items} onFavorite={toggleItem} />
            </section>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visiblePacks.map((pack) => (
              <PackCard
                key={pack.address}
                pack={pack}
                mine={pack.author === myPubkey}
                favorite={favorites.packAddresses.includes(pack.address)}
                itemFavorites={favorites.items}
                busy={busy}
                server={!!server}
                serverSelected={server?.emojiSet.packAddresses?.includes(pack.address) ?? false}
                onView={() => setViewingPack(pack)}
                onOpenItem={(item) => setSelectedMedia({ pack, item })}
                onEdit={() => setEditing(pack)}
                onDelete={() => void deletePack(pack)}
                onFavorite={() => togglePack(pack)}
                onServer={() => void toggleServerPack(pack).catch(() => {})}
              />
            ))}
          </div>
          {visiblePacks.length === 0 && (
            <div className="py-16 text-center text-sm text-lc-muted">
              {tab === 'mine' ? 'Create your first reusable media pack.' : tab === 'favorites' ? 'Favorite a pack or individual item to keep it across servers.' : 'No packs found.'}
            </div>
          )}
        </div>
        {message && <div className="shrink-0 border-t border-lc-border px-4 py-2 text-xs text-lc-green">{message}</div>}
      </main>

      {editing && <PackEditor
        pack={editing}
        initialKind={kindFilter === 'all' ? 'sticker' : kindFilter}
        addToServer={!!server}
        onClose={() => setEditing(null)}
        onSaved={async (saved) => {
          if (server) await addPackToServer(saved);
          setEditing(null);
          setTab(server ? 'server' : 'mine');
        }}
      />}
      {viewingPack && <PackViewer
        pack={viewingPack}
        favorite={favorites.packAddresses.includes(viewingPack.address)}
        itemFavorites={favorites.items}
        busy={busy}
        server={!!server}
        serverSelected={server?.emojiSet.packAddresses?.includes(viewingPack.address) ?? false}
        closeOnEscape={!selectedMedia}
        onClose={launchedFromItem ? onClose : () => setViewingPack(null)}
        onOpenItem={(item) => setSelectedMedia({ pack: viewingPack, item })}
        onFavorite={() => togglePack(viewingPack)}
        onServer={() => void toggleServerPack(viewingPack).catch(() => {})}
      />}
      {selectedMedia && <MediaItemMenu
        selection={selectedMedia}
        favorite={favorites.items.some((item) => item.url === selectedMedia.item.url)}
        busy={busy}
        server={!!server}
        onClose={launchedFromItem ? onClose : () => setSelectedMedia(null)}
        onViewPack={() => {
          setViewingPack(selectedMedia.pack);
          setSelectedMedia(null);
        }}
        onFavorite={() => {
          toggleItem(selectedMedia.item);
          if (launchedFromItem) onClose();
          else setSelectedMedia(null);
        }}
        onServer={() => {
          const { item, pack } = selectedMedia;
          void addServerItem(item, pack.title)
            .then(() => setSelectedMedia(null))
            .catch(() => {});
        }}
      />}
    </ModalShell>
  );
}

function LibraryTabs({ tab, setTab, server, mobile = false }: {
  tab: LibraryTab;
  setTab: (tab: LibraryTab) => void;
  server: boolean;
  mobile?: boolean;
}) {
  return <>{([
    ['discover', 'Marketplace'],
    ['mine', 'My packs'],
    ...(server ? [['server', 'Server favorites']] : [['favorites', 'Favorites']]),
  ] as Array<[LibraryTab, string]>).map(([value, label]) => (
    <button key={value} type="button" onClick={() => setTab(value)} className={`${mobile ? 'rounded-lg px-3 py-2 text-sm' : tabClass} ${tab === value ? 'bg-lc-green/15 text-lc-green' : 'text-lc-muted hover:bg-white/5 hover:text-lc-white'}`}>
      {label}
    </button>
  ))}</>;
}

function PackCard({ pack, mine, favorite, itemFavorites, busy, server, serverSelected, onView, onOpenItem, onEdit, onDelete, onFavorite, onServer }: {
  pack: JsMediaPack;
  mine: boolean;
  favorite: boolean;
  itemFavorites: readonly JsMediaItem[];
  busy: boolean;
  server: boolean;
  serverSelected: boolean;
  onView: () => void;
  onOpenItem: (item: JsMediaItem) => void;
  onEdit: () => void;
  onDelete: () => void;
  onFavorite: () => void;
  onServer: () => void;
}) {
  return (
    <article className="overflow-hidden rounded-xl border border-lc-border bg-lc-black/40">
      <div className="flex min-h-24 items-center gap-2 bg-lc-black p-3">
        {pack.items.slice(0, 5).map((item) => (
          <button key={item.url} type="button" onClick={() => onOpenItem(item)} title="Open media actions" aria-label={"Open :" + item.name + ": actions"} className="group relative flex h-14 min-w-0 flex-1 items-center justify-center rounded-lg bg-lc-dark p-1">
            <img src={item.url} alt={":" + item.name + ":"} className="max-h-full max-w-full object-contain" />
            {!server && itemFavorites.some((saved) => saved.url === item.url) && <span className="absolute right-1 top-1 text-xs text-lc-green">★</span>}
          </button>
        ))}
      </div>
      <div className="p-3">
        <h3 className="truncate text-sm font-semibold text-lc-white">{pack.title}</h3>
        <p className="mt-1 line-clamp-2 text-xs text-lc-muted">{pack.description || pack.items.length + " items"}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onView} className="rounded-lg border border-lc-border px-2 py-1 text-xs text-lc-white">View pack</button>
          {!server && <button type="button" disabled={busy} onClick={onFavorite} className={"rounded-lg border px-2 py-1 text-xs " + (favorite ? "border-lc-green bg-lc-green/10 text-lc-green" : "border-lc-border text-lc-white")} aria-label={favorite ? "Remove " + pack.title + " from saved packs" : "Save " + pack.title}>{favorite ? "★ Saved" : "☆ Save pack"}</button>}
          {mine && !server && <button type="button" onClick={onEdit} className="rounded-lg border border-lc-border px-2 py-1 text-xs text-lc-white">Edit</button>}
          {mine && !server && <button type="button" disabled={busy} onClick={onDelete} className="rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-300">Delete</button>}
          {server && <button type="button" disabled={busy} onClick={onServer} className={"rounded-lg px-2 py-1 text-xs font-semibold " + (serverSelected ? "border border-red-500/30 text-red-300" : "bg-lc-green text-lc-black")}>{serverSelected ? "Remove pack from server" : "Add pack to server"}</button>}
          <span className="ml-auto self-center text-[10px] uppercase tracking-wide text-lc-muted">{pack.items.length} items</span>
        </div>
      </div>
    </article>
  );
}

function PackViewer({ pack, favorite, itemFavorites, busy, server, serverSelected, closeOnEscape, onClose, onOpenItem, onFavorite, onServer }: {
  pack: JsMediaPack;
  favorite: boolean;
  itemFavorites: readonly JsMediaItem[];
  busy: boolean;
  server: boolean;
  serverSelected: boolean;
  closeOnEscape: boolean;
  onClose: () => void;
  onOpenItem: (item: JsMediaItem) => void;
  onFavorite: () => void;
  onServer: () => void;
}) {
  return (
    <ModalShell onClose={onClose} closeOnEscape={closeOnEscape} testId="media-pack-viewer" panelClassName="lc-card mx-3 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden bg-lc-dark">
      <header className="flex items-start justify-between gap-4 border-b border-lc-border p-4">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-lc-white">{pack.title}</h2>
          <p className="mt-1 text-xs text-lc-muted">{pack.description ? pack.description + " · " : ""}{pack.items.length} items</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close pack viewer" className="text-lc-muted">✕</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <MediaGrid items={pack.items} favorites={server ? [] : itemFavorites} onOpen={onOpenItem} />
      </div>
      <footer className="flex justify-end border-t border-lc-border p-4">
        {server
          ? <button type="button" disabled={busy} onClick={onServer} className={"rounded-lg px-3 py-2 text-sm font-semibold " + (serverSelected ? "border border-red-500/30 text-red-300" : "bg-lc-green text-lc-black")}>{serverSelected ? "Remove pack from server" : "Add pack to server"}</button>
          : <button type="button" disabled={busy} onClick={onFavorite} className={"rounded-lg border px-3 py-2 text-sm " + (favorite ? "border-lc-green bg-lc-green/10 text-lc-green" : "border-lc-border text-lc-white")} aria-label={favorite ? "Remove " + pack.title + " from saved packs" : "Save " + pack.title}>{favorite ? "★ Saved" : "☆ Save pack"}</button>}
      </footer>
    </ModalShell>
  );
}

function MediaItemMenu({ selection, favorite, busy, server, onClose, onViewPack, onFavorite, onServer }: {
  selection: SelectedMedia;
  favorite: boolean;
  busy: boolean;
  server: boolean;
  onClose: () => void;
  onViewPack: () => void;
  onFavorite: () => void;
  onServer: () => void;
}) {
  const { item, pack } = selection;
  return (
    <ModalShell onClose={onClose} testId="media-item-menu" panelClassName="lc-card mx-3 w-full max-w-sm overflow-hidden bg-lc-dark">
      <header className="flex items-center justify-between border-b border-lc-border p-4">
        <div>
          <h2 className="font-semibold text-lc-white">:{item.name}:</h2>
          <p className="mt-1 text-xs capitalize text-lc-muted">{item.kind} from {pack.title}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close media actions" className="text-lc-muted">✕</button>
      </header>
      <div className="flex h-64 items-center justify-center bg-lc-black p-6">
        <img src={item.url} alt={":" + item.name + ":"} className="max-h-full max-w-full object-contain" />
      </div>
      <div className="grid gap-2 p-4">
        <button type="button" onClick={onViewPack} className="rounded-lg border border-lc-border px-3 py-2 text-sm text-lc-white">View {pack.title}</button>
        {server
          ? <button type="button" disabled={busy} onClick={onServer} className="rounded-lg bg-lc-green px-3 py-2 text-sm font-semibold text-lc-black">Add item to server</button>
          : <button type="button" disabled={busy} onClick={onFavorite} className="rounded-lg bg-lc-green px-3 py-2 text-sm font-semibold text-lc-black">{favorite ? "Remove item from favorites" : "Add item to favorites"}</button>}
      </div>
    </ModalShell>
  );
}

function MediaGrid({ items, favorites = [], busy = false, onOpen, onFavorite, onRemove }: {
  items: readonly JsMediaItem[];
  favorites?: readonly JsMediaItem[];
  busy?: boolean;
  onOpen?: (item: JsMediaItem) => void;
  onFavorite?: (item: JsMediaItem) => void;
  onRemove?: (item: JsMediaItem) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
      {items.map((item) => {
        const favorite = favorites.some((value) => value.url === item.url);
        return <div key={item.url} className="relative">
          {onOpen ? (
            <button type="button" onClick={() => onOpen(item)} title={"Open :" + item.name + ": actions"} aria-label={"Open :" + item.name + ": actions"} className="relative flex aspect-square w-full items-center justify-center rounded-lg border border-lc-border bg-lc-dark p-2 hover:border-lc-green/50">
              <img src={item.url} alt={":" + item.name + ":"} className="max-h-full max-w-full object-contain" />
              {favorite && <span className="absolute right-1 top-1 text-xs text-lc-green">★</span>}
            </button>
          ) : onFavorite ? (
            <button type="button" onClick={() => onFavorite(item)} title={(favorite ? "Remove favorite :" : "Favorite :") + item.name + ":"} className="relative flex aspect-square w-full items-center justify-center rounded-lg border border-lc-border bg-lc-dark p-2 hover:border-lc-green/50">
              <img src={item.url} alt={":" + item.name + ":"} className="max-h-full max-w-full object-contain" />
              <span className={"absolute right-1 top-1 text-xs " + (favorite ? "text-lc-green" : "text-white/50")}>★</span>
            </button>
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-lc-border bg-lc-dark p-2">
              <img src={item.url} alt={":" + item.name + ":"} className="max-h-full max-w-full object-contain" />
            </div>
          )}
          {onRemove && <button type="button" disabled={busy} onClick={() => onRemove(item)} aria-label={"Remove :" + item.name + ": from server"} className="absolute left-1 top-1 rounded bg-lc-black/80 px-1 text-xs text-red-300">✕</button>}
        </div>;
      })}
    </div>
  );
}

function PackEditor({ pack, initialKind, addToServer, onClose, onSaved }: {
  pack: EditablePack;
  initialKind: JsMediaKind;
  addToServer: boolean;
  onClose: () => void;
  onSaved: (pack: EditablePack) => Promise<void>;
}) {
  const [draft, setDraft] = useState<EditablePack>({ ...pack, items: [...pack.items] });
  const [newItemKind, setNewItemKind] = useState<JsMediaKind>(initialKind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    const images = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    setBusy(true);
    setError(null);
    const used = new Set(draft.items.map((item) => item.name));
    try {
      const added: JsMediaItem[] = [];
      for (const file of images) {
        const url = await uploadToBlossom(file);
        added.push({ name: uniqueName(file.name, used), url, kind: newItemKind });
      }
      setDraft((current) => ({ ...current, items: [...current.items, ...added] }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const title = draft.title.trim();
    if (!title) return setError('Pack name is required.');
    const names = new Set<string>();
    for (const item of draft.items) {
      const name = normalizeCustomEmojiName(item.name);
      if (!isValidCustomEmojiName(name) || !validHttpUrl(item.url)) return setError('Every item needs a unique shortcode and HTTP(S) image URL.');
      if (names.has(name)) return setError(`Duplicate shortcode: :${name}:`);
      names.add(name);
    }
    setBusy(true);
    setError(null);
    try {
      const saved = { ...draft, title, items: draft.items.map((item) => ({ ...item, name: normalizeCustomEmojiName(item.name) })) };
      await nostrActions.saveMediaPack(saved);
      await onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save pack.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose} testId="media-pack-editor" panelClassName="lc-card mx-3 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden bg-lc-dark">
      <header className="flex items-center justify-between border-b border-lc-border p-4">
        <h2 className="font-semibold text-lc-white">Edit media pack</h2>
        <button type="button" onClick={onClose} aria-label="Close pack editor" className="text-lc-muted">✕</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className={fieldClass} placeholder="Pack name" aria-label="Pack name" />
          <input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className={fieldClass} placeholder="Description" aria-label="Pack description" />
        </div>
        <div className="my-4 flex flex-wrap items-end gap-2">
          <input ref={inputRef} type="file" multiple accept="image/*" className="hidden" onChange={(event) => { void addFiles(event.target.files); event.target.value = ''; }} />
          <label className="text-xs text-lc-muted">
            <span className="mb-1 block">New items are</span>
            <select value={newItemKind} onChange={(event) => setNewItemKind(event.target.value as JsMediaKind)} aria-label="New item type" className="rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white">
              <option value="emoji">Emoji</option><option value="gif">GIF</option><option value="sticker">Sticker</option>
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="rounded-lg border border-lc-green px-3 py-2 text-sm text-lc-green">Upload media</button>
          <button type="button" onClick={() => setDraft({ ...draft, items: [...draft.items, { name: '', url: '', kind: newItemKind }] })} className="rounded-lg border border-lc-border px-3 py-2 text-sm text-lc-white">Add URL</button>
        </div>
        <div className="space-y-2">
          {draft.items.map((item, index) => (
            <div key={`${index}-${item.url}`} className="grid items-center gap-2 rounded-lg border border-lc-border p-2 sm:grid-cols-[3rem_10rem_7rem_minmax(0,1fr)_auto]">
              <div className="flex h-12 w-12 items-center justify-center rounded bg-lc-black p-1">{item.url && <img src={item.url} alt="" className="max-h-full max-w-full object-contain" />}</div>
              <input value={item.name} onChange={(event) => setDraft({ ...draft, items: draft.items.map((value, itemIndex) => itemIndex === index ? { ...value, name: event.target.value } : value) })} className={fieldClass} placeholder="shortcode" aria-label={`Item ${index + 1} shortcode`} />
              <select value={item.kind} onChange={(event) => setDraft({ ...draft, items: draft.items.map((value, itemIndex) => itemIndex === index ? { ...value, kind: event.target.value as JsMediaKind } : value) })} className={fieldClass} aria-label={`Item ${index + 1} type`}>
                <option value="emoji">Emoji</option><option value="gif">GIF</option><option value="sticker">Sticker</option>
              </select>
              <input value={item.url} onChange={(event) => setDraft({ ...draft, items: draft.items.map((value, itemIndex) => itemIndex === index ? { ...value, url: event.target.value } : value) })} className={fieldClass} placeholder="https://…" aria-label={`Item ${index + 1} URL`} />
              <button type="button" onClick={() => setDraft({ ...draft, items: draft.items.filter((_, itemIndex) => itemIndex !== index) })} className="px-2 py-1 text-xs text-red-300">Remove</button>
            </div>
          ))}
          {draft.items.length === 0 && <div className="py-10 text-center text-sm text-lc-muted">Upload emoji, GIFs, or stickers into this pack.</div>}
        </div>
      </div>
      {error && <div className="border-t border-lc-border px-4 py-2 text-xs text-red-300" role="alert">{error}</div>}
      <footer className="flex justify-end gap-2 border-t border-lc-border p-4">
        <button type="button" onClick={onClose} className="rounded-lg border border-lc-border px-4 py-2 text-sm text-lc-white">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-lc-green px-4 py-2 text-sm font-semibold text-lc-black disabled:opacity-40">{busy ? 'Saving…' : addToServer ? 'Save & add to server' : 'Save pack'}</button>
      </footer>
    </ModalShell>
  );
}
