/**
 * Browser-side request/response RPC over direct WebSocket or kind 25050 — peer of
 * `services/sfu/src/nostr-rpc.ts`. Same envelope schema:
 *
 *   request:      { type:'request',  requestId, method, data? }
 *   response:     { type:'response', requestId, ok: true,  data? }
 *                 { type:'response', requestId, ok: false, error: { message, code? } }
 *   notification: { type:'notification', method, data? }
 *
 * Each `request()` call:
 *   - generates a fresh `requestId`
 *   - publishes a kind 25050 event to the SFU pubkey
 *   - resolves when the matching response arrives, or rejects on timeout
 *
 * Inbound notifications are dispatched to a single async handler so the
 * caller can decide what to do (newProducer → consume, producerClosed →
 * stop the consumer, etc).
 */
import { KIND_VOICE_SIGNAL } from '@/lib/nip-kinds';
import { getBridge, getBridgeImpl } from '@/lib/nostr-bridge/client';

// Build identity — bumped per-deploy. Same purpose as the marker in
// voice/client.ts: forces turbopack to mint a fresh chunk filename so
// sticky local caches can't pin a stale SfuRpc on the same URL.
if (typeof globalThis !== 'undefined') {
  (globalThis as { __obeliskSfuRpcBuild?: string }).__obeliskSfuRpcBuild =
    '2026-07-26T15:20:00Z-direct-websocket-rpc';
}

async function bridge() {
  await getBridge();
  const impl = getBridgeImpl();
  if (!impl) throw new Error('nostr bridge not initialized');
  return impl;
}

/**
 * 8-byte random hex — used as the per-connection identifier the SFU
 * disambiguates devices on. Collisions inside a single user's session
 * are infeasible. Falls back to a Date-based id in environments without
 * `crypto.getRandomValues` (older test runners), which is fine — the
 * SFU treats the value as opaque.
 */
function mintClientId(): string {
  try {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface RpcRequestEnvelope<T = unknown> {
  type: 'request';
  requestId: string;
  method: string;
  data?: T;
  /**
   * Per-connection id minted once per SfuRpc instance. The SFU keys its
   * peer table by `pubkey + clientId` so two devices signing with the
   * same Nostr pubkey don't collide on the same mediasoup transport
   * slot (the second device used to close + recreate the first device's
   * transports, kicking it).
   */
  clientId?: string;
}

export interface RpcResponseOk<T = unknown> {
  type: 'response';
  requestId: string;
  ok: true;
  data?: T;
}

export interface RpcResponseErr {
  type: 'response';
  requestId: string;
  ok: false;
  error: { message: string; code?: string };
}

export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseErr;

export interface RpcNotification<T = unknown> {
  type: 'notification';
  method: string;
  data?: T;
}

const DEFAULT_TIMEOUT_MS = 8000;
const SUBSCRIBE_SETTLE_MS = 100;
const SFU_RPC_WATCHDOG_MS = 800;
const SFU_RPC_MAX_SUBSCRIBE_ATTEMPTS = 8;
const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_RETRY_TIMEOUT_MS = 1800;
const DEFAULT_RETRY_DELAY_MS = 75;
const DIRECT_CONNECT_TIMEOUT_MS = 5000;
const AUTH_KIND = 22242;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRpcTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('rpc timeout:');
}

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class DirectRpcError extends Error {
  constructor(message: string, readonly closeCode = 0) {
    super(message);
  }
}

/**
 * RPC client bound to a single channel + remote (the SFU). Caller owns the
 * lifecycle — `start()` opens the inbound subscription, `close()` tears it
 * down and rejects every pending call.
 */
export class SfuRpc {
  private readonly channelId: string;
  private readonly sfuPubkey: string;
  private readonly selfPubkey: string;
  private readonly sfuUrl: string | null;
  private readonly onNotification: (n: RpcNotification) => void;
  private readonly onRelayFallback: (() => Promise<void>) | null;
  /**
   * Relays the RPC envelopes are published to. Defaults to whatever the
   * bridge has, but for SFUs that only listen on a permissioned trusted
   * relay (e.g. lacrypta-relay.obelisk.ar), the caller must pass that relay here
   * — otherwise envelopes go to the bridge default (public.obelisk.ar)
   * and the SFU never sees them. Browser stays on its bridge relays for
   * receiving; this only scopes outbound publishes.
   */
  private readonly publishRelays: readonly string[];

  private pending = new Map<string, PendingCall>();
  private signalUnsub: (() => void) | null = null;
  private socket: WebSocket | null = null;
  private transport: 'direct' | 'relay' | null = null;
  private closed = false;
  private nextId = 0;
  /**
   * Stable per-connection id, minted once per SfuRpc construction. Sent
   * in every request envelope so the SFU can distinguish two devices
   * sharing one Nostr pubkey. 8 random bytes hex is plenty — collisions
   * are infeasible within a single user's device fleet.
   */
  private readonly clientId: string;

  constructor(opts: {
    channelId: string;
    sfuPubkey: string;
    sfuUrl?: string;
    selfPubkey: string;
    onNotification: (n: RpcNotification) => void;
    onRelayFallback?: () => Promise<void>;
    publishRelays?: readonly string[];
  }) {
    this.channelId = opts.channelId;
    this.sfuPubkey = opts.sfuPubkey;
    this.selfPubkey = opts.selfPubkey;
    this.sfuUrl = opts.sfuUrl ?? null;
    this.onNotification = opts.onNotification;
    this.onRelayFallback = opts.onRelayFallback ?? null;
    this.publishRelays = opts.publishRelays ?? [];
    this.clientId = mintClientId();
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('SfuRpc already closed');
    if (this.sfuUrl && typeof WebSocket !== 'undefined') {
      try {
        await this.startDirect();
        return;
      } catch (err) {
        if (err instanceof DirectRpcError && err.closeCode >= 4401) throw err;
        console.warn('[sfu] direct RPC unavailable; falling back to Nostr relays', err);
        await this.onRelayFallback?.();
      }
    }
    await this.startRelay();
  }

  private async startRelay(): Promise<void> {
    const b = await bridge();
    const since = Math.floor(Date.now() / 1000) - 30;
    // Subscribe on the SFU's trusted relays in addition to the dex's
    // bridge defaults — the SFU only publishes responses where it itself
    // is connected (typically lacrypta-relay.obelisk.ar), and a dex tab opened on
    // public.obelisk.ar would otherwise time out every RPC. The bridge
    // merges with its own relay list so we don't drop events from
    // peers that publish to the default relays either.
    const watchOptions = this.publishRelays.length > 0
      ? {
          relays: this.publishRelays,
          watchdogMs: SFU_RPC_WATCHDOG_MS,
          maxAttempts: SFU_RPC_MAX_SUBSCRIBE_ATTEMPTS,
        }
      : {
          watchdogMs: SFU_RPC_WATCHDOG_MS,
          maxAttempts: SFU_RPC_MAX_SUBSCRIBE_ATTEMPTS,
        };
    this.signalUnsub = b.subscribeFilterWatched(
      {
        kinds: [KIND_VOICE_SIGNAL],
        '#e': [this.channelId],
        since,
      },
      (ev) => {
        // Only events FROM the SFU matter. Ignore mesh-style chatter from
        // other peers (mesh and SFU coexist on the same kind 25050).
        if (ev.pubkey !== this.sfuPubkey) return;
        const targets = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
        if (targets.length > 0 && !targets.includes(this.selfPubkey)) return;
        let parsed: unknown;
        try { parsed = JSON.parse(ev.content); } catch { return; }
        if (!parsed || typeof parsed !== 'object') return;
        const env = parsed as { type?: string };
        if (env.type === 'response') {
          this.handleResponse(parsed as RpcResponse);
        } else if (env.type === 'notification') {
          this.onNotification(parsed as RpcNotification);
        }
        // requests from SFU don't exist in v1 — server is response-only.
      },
      watchOptions,
    );
    // The bridge does not expose relay subscription readiness. Give AUTH
    // gated relays one tick to attach before the first startup RPC goes out.
    await sleep(SUBSCRIBE_SETTLE_MS);
    this.transport = 'relay';
  }

  private async startDirect(): Promise<void> {
    const endpoint = new URL('/rpc', this.sfuUrl!);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.searchParams.set('channelId', this.channelId);
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      let settled = false;
      const fail = (error: DirectRpcError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket = null;
        try { socket.close(); } catch { /* ignore */ }
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new DirectRpcError('SFU WebSocket authentication timed out')),
        DIRECT_CONNECT_TIMEOUT_MS,
      );
      socket.onerror = () => fail(new DirectRpcError('SFU WebSocket unavailable'));
      socket.onclose = (event) => {
        const message = event.reason || `SFU WebSocket closed (${event.code})`;
        const error = new DirectRpcError(
          event.code === 4403 ? `SFU access denied: ${message}` : message,
          event.code,
        );
        if (!authenticated) return fail(error);
        this.socket = null;
        this.failPending(error);
      };
      socket.onmessage = (event) => {
        void (async () => {
          if (typeof event.data !== 'string') throw new DirectRpcError('Invalid SFU WebSocket message');
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === 'auth') {
            if (
              message.kind !== AUTH_KIND ||
              message.channelId !== this.channelId ||
              typeof message.challenge !== 'string' ||
              typeof message.relay !== 'string'
            ) {
              throw new DirectRpcError('Invalid SFU authentication challenge');
            }
            const b = await bridge();
            const event = await b.signEventTemplate({
              kind: AUTH_KIND,
              content: '',
              tags: [
                ['challenge', message.challenge],
                ['e', this.channelId],
                ['relay', message.relay],
              ],
            });
            socket.send(JSON.stringify({ type: 'auth', event, clientId: this.clientId }));
            return;
          }
          if (message.type === 'auth_ok') {
            authenticated = true;
            settled = true;
            clearTimeout(timer);
            this.transport = 'direct';
            resolve();
            return;
          }
          if (!authenticated) throw new DirectRpcError('SFU WebSocket authentication required');
          this.handleInbound(message);
        })().catch((err) => fail(
          err instanceof DirectRpcError ? err : new DirectRpcError((err as Error).message),
        ));
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* ignore */ }
    this.signalUnsub?.();
    this.signalUnsub = null;
    this.failPending(new Error('rpc closed'));
  }

  /**
   * Issue an RPC call. Resolves with the `data` field of the response on
   * success; rejects with `Error` (and `.code` from the server) on failure.
   */
  async request<T = unknown>(method: string, data?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) throw new Error('rpc closed');
    const requestId = `${Date.now().toString(36)}-${(this.nextId++).toString(36)}`;
    const envelope: RpcRequestEnvelope = data === undefined
      ? { type: 'request', requestId, method, clientId: this.clientId }
      : { type: 'request', requestId, method, data, clientId: this.clientId };
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (d) => resolve(d as T),
        reject,
        timer,
      });
    });
    try {
      if (this.transport === 'direct') {
        if (!this.socket || this.socket.readyState !== 1) {
          throw new Error('SFU WebSocket disconnected');
        }
        this.socket.send(JSON.stringify(envelope));
      } else {
        const b = await bridge();
        await b.publishEvent({
          kind: KIND_VOICE_SIGNAL,
          content: JSON.stringify(envelope),
          tags: [
            ['p', this.sfuPubkey],
            ['e', this.channelId],
            ['t', 'obelisk-voice-signal'],
          ],
        }, this.publishRelays.length > 0 ? { extraRelays: [...this.publishRelays] } : undefined);
      }
    } catch (err) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
      throw err;
    }
    return result;
  }

  async requestWithRetry<T = unknown>(
    method: string,
    data?: unknown,
    opts: {
      attempts?: number;
      timeoutMs?: number;
      retryDelayMs?: number;
    } = {},
  ): Promise<T> {
    const attempts = Math.max(1, opts.attempts ?? DEFAULT_RETRY_ATTEMPTS);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
    const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.request<T>(method, data, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (this.closed || attempt >= attempts || !isRpcTimeout(err)) {
          throw err;
        }
        await sleep(retryDelayMs);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private handleInbound(message: Record<string, unknown>): void {
    if (message.type === 'response') {
      this.handleResponse(message as unknown as RpcResponse);
    } else if (message.type === 'notification') {
      this.onNotification(message as unknown as RpcNotification);
    }
  }

  private handleResponse(resp: RpcResponse): void {
    const pending = this.pending.get(resp.requestId);
    if (!pending) return; // late or unknown
    this.pending.delete(resp.requestId);
    clearTimeout(pending.timer);
    if (resp.ok) {
      pending.resolve(resp.data);
    } else {
      const err = new Error(resp.error.message);
      if (resp.error.code) (err as Error & { code: string }).code = resp.error.code;
      pending.reject(err);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
