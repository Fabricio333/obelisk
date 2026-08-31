import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishEvent = vi.hoisted(() => vi.fn());
const dropRelayConnection = vi.hoisted(() => vi.fn());
const subscribeFilterWatched = vi.hoisted(() => vi.fn(() => () => {}));
const getPublicKey = vi.hoisted(() => vi.fn(() => 'pk-me'));

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn(async () => ({})),
  getBridgeImpl: () => ({ publishEvent, dropRelayConnection, subscribeFilterWatched, getPublicKey }),
}));

import { publishJoin, publishCreate, looksLikeLostConfirmation } from './transport';

const CH = 'channel-1';
const GAME = 'g'.repeat(64);

describe('publishing a game event when the relay never answers', () => {
  beforeEach(() => {
    publishEvent.mockReset();
    dropRelayConnection.mockReset();
    subscribeFilterWatched.mockReset();
    subscribeFilterWatched.mockImplementation(() => () => {});
  });

  it('recognises a lost confirmation, and only that', () => {
    expect(looksLikeLostConfirmation('wss://relay: publish timed out')).toBe(true);
    expect(looksLikeLostConfirmation('no relay accepted')).toBe(true);
    // A refusal with a reason is not a lost confirmation.
    expect(looksLikeLostConfirmation('blocked: not a member')).toBe(false);
    expect(looksLikeLostConfirmation('invalid: bad signature')).toBe(false);
  });

  it('drops the dead connection before retrying, then succeeds', async () => {
    publishEvent
      .mockRejectedValueOnce(new Error('wss://public.obelisk.ar: publish timed out'))
      .mockResolvedValueOnce({ id: 'ok' });

    await publishJoin(CH, GAME);

    // Retrying on the same pooled socket would have died the same way, so the
    // connection has to be dropped between the two attempts.
    expect(dropRelayConnection).toHaveBeenCalledTimes(1);
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(dropRelayConnection.mock.invocationCallOrder[0])
      .toBeLessThan(publishEvent.mock.invocationCallOrder[1]);
  });

  it('does not retry a refusal that came with a reason', async () => {
    publishEvent.mockRejectedValue(new Error('blocked: you are not a member of this group'));
    await expect(publishJoin(CH, GAME)).rejects.toThrow(/not a member/);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(dropRelayConnection).not.toHaveBeenCalled();
  });

  it('publishes once when the relay answers first time', async () => {
    publishEvent.mockResolvedValue({ id: 'ok' });
    await publishJoin(CH, GAME);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(dropRelayConnection).not.toHaveBeenCalled();
  });

  describe('creating a table', () => {
    it('returns the id when the retry lands', async () => {
      publishEvent
        .mockRejectedValueOnce(new Error('publish timed out'))
        .mockResolvedValueOnce({ id: 'table-id' });

      await expect(publishCreate(CH, { game: 'stacker', turnTimeoutS: 0 })).resolves.toBe('table-id');
    });

    it('recovers the table when both attempts time out but the event landed', async () => {
      publishEvent.mockRejectedValue(new Error('publish timed out'));
      // The event was stored; only the OK was lost. The nonce lets us find it.
      subscribeFilterWatched.mockImplementation((_filter: unknown, onEvent: (ev: unknown) => void) => {
        const template = publishEvent.mock.calls[0][0] as { content: string; tags: string[][] };
        const nonce = (JSON.parse(template.content) as { nonce: string }).nonce;
        setTimeout(() => onEvent({
          id: 'recovered-id',
          pubkey: 'pk-me',
          created_at: Math.floor(Date.now() / 1000),
          kind: 2390,
          tags: template.tags,
          content: JSON.stringify({ game: 'stacker', opts: {}, turnTimeoutS: 0, nonce }),
        }), 0);
        return () => {};
      });

      await expect(publishCreate(CH, { game: 'stacker', turnTimeoutS: 0 })).resolves.toBe('recovered-id');
    });

    it('says so plainly when the table really did not land', async () => {
      publishEvent.mockRejectedValue(new Error('publish timed out'));
      await expect(publishCreate(CH, { game: 'stacker', turnTimeoutS: 0 }, ))
        .rejects.toThrow(/never confirmed/i);
    }, 10000);
  });
});
