import { describe, expect, it } from 'vitest';
import { channelCursorHasReadLatest, channelInitialAnchorFromCursor } from './channel-scroll-anchor';

const messages = [
  { id: 'm1', createdAt: 100, pubkey: 'alice' },
  { id: 'm2', createdAt: 200, pubkey: 'me' },
  { id: 'm3', createdAt: 300, pubkey: 'bob' },
  { id: 'm4', createdAt: 400, pubkey: 'carol' },
];

describe('channelInitialAnchorFromCursor', () => {
  it('defaults fresh channels without a cursor to the latest messages', () => {
    expect(channelInitialAnchorFromCursor(messages, undefined, 'me')).toEqual({ kind: 'bottom' });
    expect(channelInitialAnchorFromCursor(messages, 0, 'me')).toEqual({ kind: 'bottom' });
  });

  it('anchors to the first unread non-own message after the read cursor', () => {
    expect(channelInitialAnchorFromCursor(messages, 150_000, 'me')).toEqual({
      kind: 'message',
      messageId: 'm3',
    });
  });

  it('falls back to latest when the read boundary is older than loaded history', () => {
    expect(channelInitialAnchorFromCursor(messages, 50_000, 'me')).toEqual({ kind: 'bottom' });
  });

  it('falls back to latest when everything loaded is already read', () => {
    expect(channelInitialAnchorFromCursor(messages, 500_000, 'me')).toEqual({ kind: 'bottom' });
  });

  it('detects when the cursor covers every non-own message', () => {
    expect(channelCursorHasReadLatest(messages, 400_000, 'me')).toBe(true);
    expect(channelCursorHasReadLatest(messages, 250_000, 'me')).toBe(false);
    expect(channelCursorHasReadLatest([{ id: 'own', createdAt: 600, pubkey: 'me' }], 500_000, 'me')).toBe(true);
  });
});
