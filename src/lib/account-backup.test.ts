import { describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import { backupMediaUrls, blossomHashFromUrl, buildAccountBackup } from './account-backup';

const pubkey = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const event = (kind: number, content: string, tags: string[][], created_at = 10): NostrEvent => ({
  id: `${kind}`.padStart(64, '0'),
  pubkey,
  sig: 'c'.repeat(128),
  kind,
  content,
  tags,
  created_at,
});

describe('account backup', () => {
  it('extracts Blossom hashes and only media URLs from message content', () => {
    const media = `https://blossom.example/${hash}`;
    expect(blossomHashFromUrl(`${media}.webp?x=1`)).toBe(hash);
    expect(backupMediaUrls([
      event(9, `see https://example.com and ${media}`, []),
    ])).toEqual([media]);
  });

  it('backs up profile, follows, favorites, packs, events, and media bytes', async () => {
    const media = `https://blossom.example/${hash}`;
    const events = [
      event(0, JSON.stringify({ name: 'Alice', picture: media }), [], 1),
      event(3, '', [['p', 'd'.repeat(64), 'wss://relay.example', 'Bob']], 2),
      event(10030, '', [['a', `30030:${pubkey}:cats`], ['emoji', 'party', media]], 3),
      event(30030, '', [['d', 'cats'], ['title', 'Cats'], ['emoji', 'party', media]], 4),
      event(9, media, [], 5),
    ];
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/webp' }),
      blob: async () => new Blob(['cat'], { type: 'image/webp' }),
    });

    const backup = await buildAccountBackup({
      pubkey,
      relays: ['wss://relay.example'],
      events,
      referencedMediaPackEvents: [],
      complete: true,
    }, fetcher);

    expect(backup.profile).toMatchObject({ name: 'Alice', picture: media });
    expect(backup.follows).toEqual([{ pubkey: 'd'.repeat(64), relay: 'wss://relay.example', petname: 'Bob' }]);
    expect(backup.favorites).toMatchObject({ packAddresses: [`30030:${pubkey}:cats`] });
    expect(backup.mediaPacks[0]).toMatchObject({ title: 'Cats' });
    expect(backup.events).toHaveLength(5);
    expect(backup.media).toEqual([expect.objectContaining({
      url: media,
      blossomHash: hash,
      contentType: 'image/webp',
      size: 3,
      dataBase64: 'Y2F0',
    })]);
    expect(backup.containsPrivateKeys).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps a recoverable manifest entry when a media host blocks download', async () => {
    const media = `https://blossom.example/${hash}`;
    const backup = await buildAccountBackup({
      pubkey,
      relays: [],
      events: [event(9, media, [])],
      referencedMediaPackEvents: [],
      complete: false,
    }, vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    expect(backup.relayQueryComplete).toBe(false);
    expect(backup.media[0]).toMatchObject({
      url: media,
      blossomHash: hash,
      dataBase64: null,
      error: 'Failed to fetch',
    });
  });
});
