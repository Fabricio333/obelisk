import { describe, expect, it } from 'vitest';
import type { VoicePresence } from './types';
import { transitiveParticipants } from './transport';

function presence(pubkey: string, connectedTo: string[], knownPeers: string[] = []): VoicePresence {
  return {
    pubkey,
    channelId: 'room',
    createdAt: 1,
    expiresAt: 9999999999,
    connectedTo,
    knownPeers,
    videoTracks: [],
    isSfu: false,
  };
}

describe('four-peer mesh convergence', () => {
  it('makes peers connected through one participant directly discoverable', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((value) => value.repeat(64));
    const discovered = transitiveParticipants([
      presence(a, [b, c], [d]),
      presence(b, [a]),
    ]);
    expect(new Set(discovered)).toEqual(new Set([a, b, c, d]));
  });
});
