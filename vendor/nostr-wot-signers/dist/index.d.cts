import * as nostr_tools from 'nostr-tools';
import { EventTemplate, Event, SimplePool } from 'nostr-tools';

/**
 * Common interface every signer implements. Designed to be a thin layer
 * over nostr-tools — `signEvent` returns a fully-formed signed Event,
 * matching `nostr-tools/finalizeEvent` output shape.
 */
interface NostrSigner {
    /** Returns the signer's hex pubkey. */
    getPublicKey(): Promise<string>;
    /** Sign an event template, returning a finalized Event. */
    signEvent(template: EventTemplate): Promise<Event>;
    /** NIP-04 encrypt to `recipientPubkey`. Optional — not all signers
     *  support this. Throws if unsupported. */
    nip04Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
    nip04Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;
    /** NIP-44 v2 encryption. Optional — modern preferred path. */
    nip44Encrypt?(recipientPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt?(senderPubkey: string, ciphertext: string): Promise<string>;
    /** Optional disposal hook — for signers that hold a connection
     *  (NIP-46) or extension permission. */
    close?(): Promise<void> | void;
}
type SignerCapabilities = {
    nip04: boolean;
    nip44: boolean;
};

/**
 * Sign with a private key held in memory. Useful for tests, CLIs, and
 * any non-interactive context. Never expose the secret across UI
 * boundaries — for browser apps, prefer NIP-07 / NIP-46 / NIP-55.
 *
 * Accepts either a 32-byte Uint8Array or a 64-char hex string.
 */
declare class PrivateKeySigner implements NostrSigner {
    #private;
    constructor(sk: Uint8Array | string);
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<nostr_tools.VerifiedEvent>;
    nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
}

/**
 * NIP-07 — browser extension signer (Alby, nos2x, Flamingo, Nostore).
 * Reads / writes via `window.nostr` injected by the extension.
 *
 * Throws synchronously from the constructor if `window.nostr` isn't
 * available; UI code can catch + fall back to a different signer.
 */
interface Nip07Window {
    nostr?: {
        getPublicKey(): Promise<string>;
        signEvent(template: EventTemplate): Promise<Event>;
        nip04?: {
            encrypt(pubkey: string, plaintext: string): Promise<string>;
            decrypt(pubkey: string, ciphertext: string): Promise<string>;
        };
        nip44?: {
            encrypt(pubkey: string, plaintext: string): Promise<string>;
            decrypt(pubkey: string, ciphertext: string): Promise<string>;
        };
        getRelays?(): Promise<Record<string, {
            read: boolean;
            write: boolean;
        }>>;
    };
}
declare function isNip07Available(): boolean;
declare class Nip07Signer implements NostrSigner {
    #private;
    constructor();
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
    nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    /** Returns the extension's recommended relay set (NIP-07 optional API). */
    getExtensionRelays(): Promise<Record<string, {
        read: boolean;
        write: boolean;
    }> | null>;
}

/**
 * NIP-46 — Nostr Connect remote signer (a.k.a. bunker).
 *
 * Thin adapter over `nostr-tools/nip46`'s {@link BunkerSigner} so we get the
 * battle-tested handshake (Amber, Nsec.app, Keychat all interoperate) while
 * exposing our own {@link NostrSigner} surface — same public API the SDK has
 * always shipped.
 *
 * Two pairing modes:
 *
 *   - **bunker-initiated** (`bunker://`): the bunker generates the URI
 *     including its own pubkey + secret; user pastes/scans on the desktop.
 *     → {@link Nip46Signer.fromBunkerUri}
 *
 *   - **client-initiated** (`nostrconnect://`): the client (this signer)
 *     generates the URI and renders it as a QR; the bunker scans, then
 *     pings us. → {@link Nip46Signer.startNostrConnect} returns
 *     `{ uri, ready }` — render `uri` as a QR; `ready` resolves once paired.
 *
 * The bunker may also respond to any request with `result: "auth_url"`
 * (and the URL in `error`), meaning "tell the user to approve at this URL".
 * Pass `onAuthChallenge` on construction to surface those prompts; the
 * underlying request stays pending until the bunker eventually responds with
 * the real result.
 */
interface Nip46Options {
    /** Relays the bunker is listening on. */
    relays: string[];
    /** Optional client secret key. If absent, a fresh ephemeral key is
     *  generated. Persist the resulting nsec to keep the same client identity
     *  across page loads (the bunker remembers paired clients). */
    clientSecretKey?: Uint8Array | string;
    /** Pool to use; defaults to a fresh internal pool. */
    pool?: SimplePool;
    /** Surfaced when the bunker responds with `result: "auth_url"`. */
    onAuthChallenge?: (url: string) => void;
}
interface NostrConnectOptions extends Nip46Options {
    /** Random secret bound into the URI; bunker echoes it on connect. Auto-generated if absent. */
    secret?: string;
    /** Comma-separated permissions, e.g. "sign_event:1,nip44_encrypt". */
    perms?: string;
    /** App metadata advertised to the user during pairing. */
    metadata?: {
        name?: string;
        url?: string;
        description?: string;
        image?: string;
    };
    /** Time budget waiting for the bunker to scan + connect. Default 5 min. */
    pairTimeoutMs?: number;
}
interface NostrConnectHandle {
    /** Render this as a QR. The bunker scans → `ready` resolves. */
    uri: string;
    /** The ephemeral client pubkey (advertised in the URI). */
    clientPubkey: string;
    /** Cancel pairing. Rejects any in-flight `ready`. */
    cancel: () => void;
    /** Resolves with the paired signer, or rejects on timeout/cancel. */
    ready: Promise<Nip46Signer>;
}
declare class Nip46Signer implements NostrSigner {
    #private;
    private constructor();
    /**
     * Connect using a bunker URI (`bunker://<pubkey>?relay=...&secret=...`)
     * or a NIP-05 identifier that resolves to one.
     */
    static fromBunkerUri(uri: string, opts?: Partial<Nip46Options>): Promise<Nip46Signer>;
    /**
     * Start a `nostrconnect://` flow. Returns the URI to render as a QR plus a
     * `ready` promise that resolves when the bunker pairs.
     */
    static startNostrConnect(opts: NostrConnectOptions): NostrConnectHandle;
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
    nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    /** Persist the client key (nsec) so future sessions reuse the same client
     *  identity (bunker remembers paired clients). */
    exportClientNsec(): string;
    /** The bunker's pubkey, once paired. */
    get bunkerPubkey(): string;
    /** The relays this signer talks to the bunker over. */
    get relays(): string[];
    close(): Promise<void>;
}

/**
 * NIP-55 — Android external signer (Amber, Plebstr, etc).
 *
 * The signer app receives sign requests via Android `Intent`s; the
 * caller (a webview or a TWA) opens an intent URI and reads the result.
 *
 * Implementation detail: mobile Nostr clients deep-link to
 * `nostrsigner:<base64-payload>?type=sign_event&id=<request-id>`. The
 * signer responds via either intent results (native app) or a custom
 * URL scheme back to the caller. This SDK provides a thin browser shim
 * that opens the intent and waits for the response via postMessage,
 * URL hash, or a polling approach.
 *
 * Browser usage requires the page to be embedded in a TWA / Custom Tab
 * (so Android resolves `nostrsigner:` to Amber). Pure web pages can't
 * use NIP-55 — fall back to NIP-07 / NIP-46.
 *
 * Status: skeleton API; full bridge implementation is out of scope for
 * v0.1 since it requires either a native bridge or a TWA-aware
 * runtime. The signer shape exists so apps can wire UI today and the
 * underlying transport can be filled in later.
 */
interface Nip55Bridge {
    /** Open a `nostrsigner:` intent and return the response payload. */
    request(intentUri: string, requestId: string): Promise<string>;
    /** Optional: returns true when running inside an environment that can
     *  resolve nostrsigner: intents (Amber installed, TWA active). */
    isAvailable?(): boolean;
}
declare class Nip55Signer implements NostrSigner {
    #private;
    /**
     * `userPubkey` must already be known — Amber returns it during the
     * initial pairing. Pass it in from your app's auth store.
     */
    constructor(userPubkey: string, bridge: Nip55Bridge);
    getPublicKey(): Promise<string>;
    signEvent(template: EventTemplate): Promise<Event>;
    nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
    nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
    nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
}

/**
 * NDK ↔ NostrSigner adapter.
 *
 * NDK (`@nostr-dev-kit/ndk`) ships its own `NDKSigner` interface. This
 * adapter wraps any `NDKSigner` so it satisfies the SDK's `NostrSigner`
 * contract — letting NDK-using apps adopt `@nostr-wot/*` packages
 * without rewriting their auth layer.
 *
 * `NDKSigner` is typed loosely (`unknown`-ish) here so this module
 * doesn't pull NDK in as a dependency. The caller passes a real NDK
 * instance + signer at construction time.
 */

/** Minimal subset of NDK we need. Compatible with NDK v2.x. */
interface NdkLike {
    signer: NdkSignerLike | undefined;
}
interface NdkSignerLike {
    user(): Promise<{
        pubkey: string;
    }>;
    encrypt?(user: {
        pubkey: string;
    }, plaintext: string, scheme?: "nip04" | "nip44"): Promise<string>;
    decrypt?(user: {
        pubkey: string;
    }, ciphertext: string, scheme?: "nip04" | "nip44"): Promise<string>;
}
/**
 * NDK event class shape. Keep it minimal; the adapter only needs to
 * construct, populate, sign, and serialize.
 */
interface NdkEventCtor {
    new (ndk: NdkLike): NdkEventLike;
}
interface NdkEventLike {
    kind?: number;
    content?: string;
    tags?: string[][];
    created_at?: number;
    sign(signer?: NdkSignerLike): Promise<string>;
    rawEvent(): Event;
}
interface NdkAdapterOptions {
    /** The NDK instance (must have a `signer` set). */
    ndk: NdkLike;
    /** Optional explicit signer override; defaults to `ndk.signer`. */
    signer?: NdkSignerLike;
    /** The NDK `NDKEvent` constructor — pass `NDKEvent` from your
     *  `@nostr-dev-kit/ndk` import. Avoids us depending on NDK directly. */
    NDKEvent: NdkEventCtor;
}
/**
 * Wrap an NDK signer so it satisfies `NostrSigner`. The returned object
 * delegates `signEvent` through `NDKEvent` (so signed events come back
 * with NDK's verification + caching pipeline applied) and proxies
 * encrypt/decrypt through `NDKSigner.encrypt/decrypt`.
 *
 * NDK ≥ 2.10 takes a third argument `scheme` on encrypt/decrypt for
 * NIP-44 support; older versions only support NIP-04 and ignore the
 * extra argument. This adapter targets the modern API and falls back
 * gracefully when a method is missing.
 */
declare function ndkSignerAsNostrSigner(opts: NdkAdapterOptions): NostrSigner;
/** Minimal NDKUser shape. Real NDKUser instances satisfy this. */
interface NdkUserLike {
    pubkey: string;
}
/** Minimal NDKSigner shape we produce. Compatible with NDK ≥ 2.x. */
interface NdkSignerOut {
    readonly pubkey: string;
    readonly userSync: NdkUserLike;
    user(): Promise<NdkUserLike>;
    blockUntilReady(): Promise<NdkUserLike>;
    sign(event: {
        kind?: number;
        created_at?: number;
        tags?: string[][];
        content: string;
    }): Promise<string>;
    encrypt(recipient: NdkUserLike, value: string, scheme?: "nip04" | "nip44"): Promise<string>;
    decrypt(sender: NdkUserLike, value: string, scheme?: "nip04" | "nip44"): Promise<string>;
    encryptionEnabled(scheme?: "nip04" | "nip44"): Promise<("nip04" | "nip44")[]>;
    toPayload(): string;
}
interface NostrAsNdkOptions {
    /**
     * Optional `NDKUser` constructor. When supplied, `user()` and
     * `userSync` return real NDKUser instances; otherwise they return
     * a plain `{ pubkey }` object that satisfies the NDKUser shape used
     * by every standard NDK code path.
     */
    NDKUser?: new (init: {
        pubkey: string;
    }) => NdkUserLike;
}
/**
 * Wrap a `NostrSigner` so it satisfies NDK's `NDKSigner` interface.
 * The pubkey is resolved synchronously up front, so the resulting
 * signer can be used immediately by NDK code paths that depend on the
 * sync `pubkey` getter.
 *
 * Encryption/decryption methods on the wrapped signer are conditionally
 * available — if the underlying `NostrSigner` doesn't implement
 * `nip04Encrypt`, calling `encrypt(..., 'nip04')` on the wrapper throws.
 *
 * `toPayload()` returns a sentinel string; consumers that round-trip
 * NDK signers via `toPayload`/`ndkSignerFromPayload` should persist
 * via the SDK's `SignerStorage` instead.
 */
declare function nostrSignerAsNdkSigner(signer: NostrSigner, opts?: NostrAsNdkOptions): Promise<NdkSignerOut>;

export { type NdkAdapterOptions, type NdkEventCtor, type NdkEventLike, type NdkLike, type NdkSignerLike, type NdkSignerOut, type NdkUserLike, Nip07Signer, type Nip07Window, type Nip46Options, Nip46Signer, type Nip55Bridge, Nip55Signer, type NostrAsNdkOptions, type NostrConnectHandle, type NostrConnectOptions, type NostrSigner, PrivateKeySigner, type SignerCapabilities, isNip07Available, ndkSignerAsNostrSigner, nostrSignerAsNdkSigner };
