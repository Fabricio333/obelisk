import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Event as NostrEvent } from 'nostr-tools';
import { parseMediaFavorites, parseMediaPack } from '@/lib/media-packs';
import { nostrActions } from '@/lib/nostr-bridge';

export interface AccountBackupSource {
  pubkey: string;
  relays: string[];
  events: NostrEvent[];
  referencedMediaPackEvents: NostrEvent[];
  complete: boolean;
}

export interface AccountBackup {
  format: 'obelisk-account-backup';
  version: 1;
  exportedAt: string;
  pubkey: string;
  relays: string[];
  relayQueryComplete: boolean;
  containsPrivateKeys: false;
  profile: Record<string, unknown> | null;
  follows: Array<{ pubkey: string; relay?: string; petname?: string }>;
  favorites: ReturnType<typeof parseMediaFavorites> | null;
  mediaPacks: NonNullable<ReturnType<typeof parseMediaPack>>[];
  events: NostrEvent[];
  referencedMediaPackEvents: NostrEvent[];
  media: Array<{
    url: string;
    blossomHash: string | null;
    sha256: string | null;
    contentType: string | null;
    size: number | null;
    dataBase64: string | null;
    error?: string;
  }>;
}

const MEDIA_EXTENSION_RE = /\.(?:avif|bmp|docx?|gif|jpe?g|json|m4a|mkv|mov|mp3|mp4|oga|ogg|ogv|pdf|png|svg|tar|txt|wav|weba|webm|webp|xlsx?|zip)(?:$|[?#])/i;
const URL_RE = /https?:\/\/[^\s<>"']+/g;

function newest(events: readonly NostrEvent[], kind: number): NostrEvent | null {
  return events
    .filter((event) => event.kind === kind)
    .reduce<NostrEvent | null>((latest, event) => !latest || event.created_at > latest.created_at ? event : latest, null);
}

function httpUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function blossomHashFromUrl(value: string): string | null {
  const url = httpUrl(value);
  if (!url) return null;
  const filename = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  return filename.match(/^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i)?.[1]?.toLowerCase() ?? null;
}

export function backupMediaUrls(events: readonly NostrEvent[]): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined, explicit = false) => {
    const url = httpUrl(value?.replace(/[),.;]+$/, ''));
    if (url && (explicit || blossomHashFromUrl(url) || MEDIA_EXTENSION_RE.test(url))) urls.add(url);
  };

  for (const event of events) {
    if (event.kind === 0) {
      try {
        const profile = JSON.parse(event.content) as Record<string, unknown>;
        for (const key of ['picture', 'banner']) if (typeof profile[key] === 'string') add(profile[key] as string, true);
      } catch {
        // The signed event is still preserved below even if its metadata is malformed.
      }
    }
    for (const tag of event.tags) {
      if (tag[0] === 'emoji' || tag[0] === 'sticker') add(tag[2], true);
      else if (tag[0] === 'voice' || ['image', 'banner', 'thumb', 'url'].includes(tag[0])) add(tag[1], true);
      else if (tag[0] === 'imeta') {
        for (const field of tag.slice(1)) if (field.startsWith('url ')) add(field.slice(4), true);
      }
    }
    for (const match of event.content.match(URL_RE) ?? []) add(match);
  }
  return Array.from(urls);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function backupMedia(url: string, fetcher: typeof fetch): Promise<AccountBackup['media'][number]> {
  const blossomHash = blossomHashFromUrl(url);
  try {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      url,
      blossomHash,
      sha256: bytesToHex(sha256(bytes)),
      contentType: blob.type || response.headers.get('content-type'),
      size: bytes.length,
      dataBase64: base64(bytes),
    };
  } catch (error) {
    return {
      url,
      blossomHash,
      sha256: null,
      contentType: null,
      size: null,
      dataBase64: null,
      error: error instanceof Error ? error.message : 'Download failed',
    };
  }
}

export async function buildAccountBackup(
  source: AccountBackupSource,
  fetcher: typeof fetch = fetch,
): Promise<AccountBackup> {
  const allEvents = [...source.events, ...source.referencedMediaPackEvents];
  const profileEvent = newest(source.events, 0);
  const contactEvent = newest(source.events, 3);
  const favoriteEvent = newest(source.events, 10030);
  const packs = new Map<string, NonNullable<ReturnType<typeof parseMediaPack>>>();
  for (const event of allEvents) {
    if (event.kind !== 30030) continue;
    const pack = parseMediaPack(event);
    const current = pack && packs.get(pack.address);
    if (pack && (!current || pack.createdAt > current.createdAt)) packs.set(pack.address, pack);
  }

  let profile: Record<string, unknown> | null = null;
  if (profileEvent) {
    try { profile = JSON.parse(profileEvent.content) as Record<string, unknown>; } catch { /* preserved in events */ }
  }
  const follows = contactEvent
    ? Array.from(new Map(contactEvent.tags
        .filter((tag) => tag[0] === 'p' && /^[0-9a-f]{64}$/i.test(tag[1] ?? ''))
        .map((tag) => [tag[1], {
          pubkey: tag[1],
          ...(tag[2] ? { relay: tag[2] } : {}),
          ...(tag[3] ? { petname: tag[3] } : {}),
        }])).values())
    : [];

  const media = [];
  for (const url of backupMediaUrls(allEvents)) media.push(await backupMedia(url, fetcher));

  return {
    format: 'obelisk-account-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    pubkey: source.pubkey,
    relays: source.relays,
    relayQueryComplete: source.complete,
    containsPrivateKeys: false,
    profile,
    follows,
    favorites: favoriteEvent ? parseMediaFavorites(favoriteEvent) : null,
    mediaPacks: Array.from(packs.values()),
    events: source.events,
    referencedMediaPackEvents: source.referencedMediaPackEvents,
    media,
  };
}

export async function downloadAccountBackup(): Promise<AccountBackup> {
  const backup = await buildAccountBackup(await nostrActions.exportAccountData());
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `obelisk-backup-${backup.pubkey.slice(0, 12)}-${backup.exportedAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  return backup;
}
