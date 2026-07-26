import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeFake = vi.hoisted(() => ({
  signEventTemplate: vi.fn(async (template: {
    kind: number; content: string; tags: string[][]; created_at?: number;
  }) => ({
    ...template,
    created_at: template.created_at ?? 1,
    pubkey: 'b'.repeat(64),
    id: 'event-id',
    sig: 'event-sig',
  })),
  publishEvent: vi.fn(),
  subscribeFilterWatched: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn(async () => bridgeFake),
  getBridgeImpl: vi.fn(() => bridgeFake),
}));

import { SfuRpc } from './sfu-rpc';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static deny = false;
  static unavailable = false;

  readonly url: string;
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Record<string, unknown>[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.unavailable) {
        this.onerror?.(new Event('error'));
        return;
      }
      this.message({
        type: 'auth',
        challenge: 'challenge-1',
        kind: 22242,
        relay: this.url,
        channelId: 'c'.repeat(64),
      });
    });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'auth') {
      if (FakeWebSocket.deny) {
        queueMicrotask(() => this.onclose?.({ code: 4403, reason: 'not whitelisted' } as CloseEvent));
      } else {
        queueMicrotask(() => this.message({ type: 'auth_ok' }));
      }
      return;
    }
    if (message.type === 'request') {
      queueMicrotask(() => this.message({
        type: 'response',
        requestId: message.requestId,
        ok: true,
        data: { transport: 'direct' },
      }));
    }
  }

  close(): void {
    this.readyState = 3;
  }

  private message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.deny = false;
  FakeWebSocket.unavailable = false;
  bridgeFake.signEventTemplate.mockClear();
  bridgeFake.publishEvent.mockClear();
  bridgeFake.subscribeFilterWatched.mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => vi.unstubAllGlobals());

describe('SfuRpc direct transport', () => {
  it('authenticates with a signed Nostr challenge and bypasses relay RPC', async () => {
    const rpc = new SfuRpc({
      channelId: 'c'.repeat(64),
      sfuPubkey: 'a'.repeat(64),
      sfuUrl: 'https://sfu.obelisk.ar',
      selfPubkey: 'b'.repeat(64),
      onNotification: vi.fn(),
    });

    await rpc.start();
    await expect(rpc.request('getRouterRtpCapabilities')).resolves.toEqual({ transport: 'direct' });

    expect(FakeWebSocket.instances[0]?.url).toBe(
      `wss://sfu.obelisk.ar/rpc?channelId=${'c'.repeat(64)}`,
    );
    expect(bridgeFake.signEventTemplate).toHaveBeenCalledWith(expect.objectContaining({
      kind: 22242,
      tags: expect.arrayContaining([
        ['challenge', 'challenge-1'],
        ['e', 'c'.repeat(64)],
      ]),
    }));
    expect(bridgeFake.publishEvent).not.toHaveBeenCalled();
    expect(bridgeFake.subscribeFilterWatched).not.toHaveBeenCalled();
    rpc.close();
  });

  it('starts the legacy relay path only when direct RPC is unavailable', async () => {
    FakeWebSocket.unavailable = true;
    const onRelayFallback = vi.fn(async () => undefined);
    const rpc = new SfuRpc({
      channelId: 'c'.repeat(64),
      sfuPubkey: 'a'.repeat(64),
      sfuUrl: 'https://old-sfu.example',
      selfPubkey: 'b'.repeat(64),
      onNotification: vi.fn(),
      onRelayFallback,
    });

    await rpc.start();
    expect(onRelayFallback).toHaveBeenCalledOnce();
    expect(bridgeFake.subscribeFilterWatched).toHaveBeenCalledOnce();
    rpc.close();
  });

  it('surfaces the SFU whitelist rejection without falling back to relays', async () => {
    FakeWebSocket.deny = true;
    const rpc = new SfuRpc({
      channelId: 'c'.repeat(64),
      sfuPubkey: 'a'.repeat(64),
      sfuUrl: 'https://sfu.obelisk.ar',
      selfPubkey: 'b'.repeat(64),
      onNotification: vi.fn(),
    });

    await expect(rpc.start()).rejects.toThrow('SFU access denied: not whitelisted');
    expect(bridgeFake.subscribeFilterWatched).not.toHaveBeenCalled();
  });
});
