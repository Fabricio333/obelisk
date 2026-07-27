import { getPublicKey, finalizeEvent, nip04, nip44, generateSecretKey, nip19 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';
import { parseBunkerInput, BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var _sk, _pk;
var PrivateKeySigner = class {
  constructor(sk) {
    __privateAdd(this, _sk);
    __privateAdd(this, _pk);
    __privateSet(this, _sk, typeof sk === "string" ? hexToBytes(sk) : sk);
    if (__privateGet(this, _sk).length !== 32) {
      throw new Error("Private key must be 32 bytes");
    }
    __privateSet(this, _pk, getPublicKey(__privateGet(this, _sk)));
  }
  async getPublicKey() {
    return __privateGet(this, _pk);
  }
  async signEvent(template) {
    return finalizeEvent(template, __privateGet(this, _sk));
  }
  async nip04Encrypt(recipientPubkey, plaintext) {
    return nip04.encrypt(__privateGet(this, _sk), recipientPubkey, plaintext);
  }
  async nip04Decrypt(senderPubkey, ciphertext) {
    return nip04.decrypt(__privateGet(this, _sk), senderPubkey, ciphertext);
  }
  async nip44Encrypt(recipientPubkey, plaintext) {
    const conv = nip44.v2.utils.getConversationKey(__privateGet(this, _sk), recipientPubkey);
    return nip44.v2.encrypt(plaintext, conv);
  }
  async nip44Decrypt(senderPubkey, ciphertext) {
    const conv = nip44.v2.utils.getConversationKey(__privateGet(this, _sk), senderPubkey);
    return nip44.v2.decrypt(ciphertext, conv);
  }
};
_sk = new WeakMap();
_pk = new WeakMap();

// src/nip07/index.ts
function isNip07Available() {
  return typeof window !== "undefined" && Boolean(window.nostr);
}
var _ext;
var Nip07Signer = class {
  constructor() {
    __privateAdd(this, _ext);
    if (typeof window === "undefined") {
      throw new Error("Nip07Signer requires a browser environment (window.nostr)");
    }
    const ext = window.nostr;
    if (!ext) {
      throw new Error("No NIP-07 extension detected. Install Alby, nos2x, or similar.");
    }
    __privateSet(this, _ext, ext);
  }
  async getPublicKey() {
    return __privateGet(this, _ext).getPublicKey();
  }
  async signEvent(template) {
    return __privateGet(this, _ext).signEvent(template);
  }
  async nip04Encrypt(recipientPubkey, plaintext) {
    if (!__privateGet(this, _ext).nip04) throw new Error("NIP-04 not supported by this extension");
    return __privateGet(this, _ext).nip04.encrypt(recipientPubkey, plaintext);
  }
  async nip04Decrypt(senderPubkey, ciphertext) {
    if (!__privateGet(this, _ext).nip04) throw new Error("NIP-04 not supported by this extension");
    return __privateGet(this, _ext).nip04.decrypt(senderPubkey, ciphertext);
  }
  async nip44Encrypt(recipientPubkey, plaintext) {
    if (!__privateGet(this, _ext).nip44) throw new Error("NIP-44 not supported by this extension");
    return __privateGet(this, _ext).nip44.encrypt(recipientPubkey, plaintext);
  }
  async nip44Decrypt(senderPubkey, ciphertext) {
    if (!__privateGet(this, _ext).nip44) throw new Error("NIP-44 not supported by this extension");
    return __privateGet(this, _ext).nip44.decrypt(senderPubkey, ciphertext);
  }
  /** Returns the extension's recommended relay set (NIP-07 optional API). */
  async getExtensionRelays() {
    if (!__privateGet(this, _ext).getRelays) return null;
    try {
      return await __privateGet(this, _ext).getRelays();
    } catch (e) {
      return null;
    }
  }
};
_ext = new WeakMap();
function toBytes(sk) {
  return typeof sk === "string" ? hexToBytes(sk) : sk;
}
var _inner, _clientSk, _relays;
var _Nip46Signer = class _Nip46Signer {
  constructor(inner, clientSk, relays) {
    __privateAdd(this, _inner);
    __privateAdd(this, _clientSk);
    __privateAdd(this, _relays);
    __privateSet(this, _inner, inner);
    __privateSet(this, _clientSk, clientSk);
    __privateSet(this, _relays, relays);
  }
  /**
   * Connect using a bunker URI (`bunker://<pubkey>?relay=...&secret=...`)
   * or a NIP-05 identifier that resolves to one.
   */
  static async fromBunkerUri(uri, opts) {
    const bp = await parseBunkerInput(uri);
    if (!bp) throw new Error(`Invalid bunker URI: ${uri}`);
    if (bp.relays.length === 0) {
      throw new Error("Bunker URI is missing at least one ?relay=wss://\u2026 parameter");
    }
    const clientSk = (opts == null ? void 0 : opts.clientSecretKey) ? toBytes(opts.clientSecretKey) : generateSecretKey();
    const inner = BunkerSigner.fromBunker(clientSk, bp, {
      ...(opts == null ? void 0 : opts.pool) ? { pool: opts.pool } : {},
      ...(opts == null ? void 0 : opts.onAuthChallenge) ? { onauth: opts.onAuthChallenge } : {}
    });
    await inner.connect();
    return new _Nip46Signer(inner, clientSk, bp.relays);
  }
  /**
   * Start a `nostrconnect://` flow. Returns the URI to render as a QR plus a
   * `ready` promise that resolves when the bunker pairs.
   */
  static startNostrConnect(opts) {
    var _a, _b, _c, _d, _e;
    if (opts.relays.length === 0) {
      throw new Error("nostrconnect: at least one relay is required");
    }
    const clientSk = opts.clientSecretKey ? toBytes(opts.clientSecretKey) : generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const secret = (_a = opts.secret) != null ? _a : randomSecret(16);
    const uri = createNostrConnectURI({
      clientPubkey,
      relays: opts.relays,
      secret,
      ...opts.perms ? { perms: opts.perms.split(",").map((p) => p.trim()).filter(Boolean) } : {},
      ...((_b = opts.metadata) == null ? void 0 : _b.name) ? { name: opts.metadata.name } : {},
      ...((_c = opts.metadata) == null ? void 0 : _c.url) ? { url: opts.metadata.url } : {},
      ...((_d = opts.metadata) == null ? void 0 : _d.image) ? { image: opts.metadata.image } : {}
    });
    const pairTimeout = (_e = opts.pairTimeoutMs) != null ? _e : 5 * 6e4;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), pairTimeout);
    const bunkerParams = {
      ...opts.pool ? { pool: opts.pool } : {},
      ...opts.onAuthChallenge ? { onauth: opts.onAuthChallenge } : {}
    };
    let cancelled = false;
    let inner = null;
    const ready = (async () => {
      try {
        inner = await BunkerSigner.fromURI(clientSk, uri, bunkerParams, abort.signal);
        if (cancelled) {
          await inner.close().catch(() => {
          });
          throw new Error("nostrconnect: cancelled");
        }
        return new _Nip46Signer(inner, clientSk, opts.relays);
      } catch (err) {
        if (abort.signal.aborted && !cancelled) {
          throw new Error("nostrconnect: pairing timed out");
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();
    return {
      uri,
      clientPubkey,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        abort.abort();
        if (inner) void inner.close().catch(() => {
        });
      },
      ready
    };
  }
  async getPublicKey() {
    return __privateGet(this, _inner).getPublicKey();
  }
  async signEvent(template) {
    return await __privateGet(this, _inner).signEvent(template);
  }
  async nip04Encrypt(recipientPubkey, plaintext) {
    return __privateGet(this, _inner).nip04Encrypt(recipientPubkey, plaintext);
  }
  async nip04Decrypt(senderPubkey, ciphertext) {
    return __privateGet(this, _inner).nip04Decrypt(senderPubkey, ciphertext);
  }
  async nip44Encrypt(recipientPubkey, plaintext) {
    return __privateGet(this, _inner).nip44Encrypt(recipientPubkey, plaintext);
  }
  async nip44Decrypt(senderPubkey, ciphertext) {
    return __privateGet(this, _inner).nip44Decrypt(senderPubkey, ciphertext);
  }
  /** Persist the client key (nsec) so future sessions reuse the same client
   *  identity (bunker remembers paired clients). */
  exportClientNsec() {
    return nip19.nsecEncode(__privateGet(this, _clientSk));
  }
  /** The bunker's pubkey, once paired. */
  get bunkerPubkey() {
    return __privateGet(this, _inner).bp.pubkey;
  }
  /** The relays this signer talks to the bunker over. */
  get relays() {
    var _a;
    return [...(_a = __privateGet(this, _inner).bp.relays) != null ? _a : __privateGet(this, _relays)];
  }
  async close() {
    try {
      await __privateGet(this, _inner).close();
    } catch (e) {
    }
  }
};
_inner = new WeakMap();
_clientSk = new WeakMap();
_relays = new WeakMap();
var Nip46Signer = _Nip46Signer;
function randomSecret(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// src/nip55/index.ts
var _bridge, _userPubkey, _Nip55Signer_instances, callIntent_fn;
var Nip55Signer = class {
  /**
   * `userPubkey` must already be known — Amber returns it during the
   * initial pairing. Pass it in from your app's auth store.
   */
  constructor(userPubkey, bridge) {
    __privateAdd(this, _Nip55Signer_instances);
    __privateAdd(this, _bridge);
    __privateAdd(this, _userPubkey);
    __privateSet(this, _userPubkey, userPubkey);
    __privateSet(this, _bridge, bridge);
  }
  async getPublicKey() {
    return __privateGet(this, _userPubkey);
  }
  async signEvent(template) {
    const id = crypto.randomUUID();
    const payload = btoa(JSON.stringify({ ...template, pubkey: __privateGet(this, _userPubkey) }));
    const intent = `nostrsigner:${payload}?type=sign_event&id=${encodeURIComponent(id)}`;
    const response = await __privateGet(this, _bridge).request(intent, id);
    return JSON.parse(response);
  }
  async nip04Encrypt(recipientPubkey, plaintext) {
    return __privateMethod(this, _Nip55Signer_instances, callIntent_fn).call(this, "nip04_encrypt", { pubkey: recipientPubkey, plaintext });
  }
  async nip04Decrypt(senderPubkey, ciphertext) {
    return __privateMethod(this, _Nip55Signer_instances, callIntent_fn).call(this, "nip04_decrypt", { pubkey: senderPubkey, ciphertext });
  }
  async nip44Encrypt(recipientPubkey, plaintext) {
    return __privateMethod(this, _Nip55Signer_instances, callIntent_fn).call(this, "nip44_encrypt", { pubkey: recipientPubkey, plaintext });
  }
  async nip44Decrypt(senderPubkey, ciphertext) {
    return __privateMethod(this, _Nip55Signer_instances, callIntent_fn).call(this, "nip44_decrypt", { pubkey: senderPubkey, ciphertext });
  }
};
_bridge = new WeakMap();
_userPubkey = new WeakMap();
_Nip55Signer_instances = new WeakSet();
callIntent_fn = async function(type, params) {
  const id = crypto.randomUUID();
  const payload = btoa(JSON.stringify({ ...params, pubkey: __privateGet(this, _userPubkey) }));
  const intent = `nostrsigner:${payload}?type=${type}&id=${encodeURIComponent(id)}`;
  return __privateGet(this, _bridge).request(intent, id);
};

// src/ndk-adapter.ts
function ndkSignerAsNostrSigner(opts) {
  var _a;
  const { ndk, NDKEvent } = opts;
  const ndkSigner = (_a = opts.signer) != null ? _a : ndk.signer;
  if (!ndkSigner) {
    throw new Error("ndkSignerAsNostrSigner: NDK has no signer attached");
  }
  return {
    async getPublicKey() {
      const user = await ndkSigner.user();
      return user.pubkey;
    },
    async signEvent(template) {
      const ev = new NDKEvent(ndk);
      ev.kind = template.kind;
      ev.content = template.content;
      ev.tags = template.tags;
      ev.created_at = template.created_at;
      await ev.sign(ndkSigner);
      return ev.rawEvent();
    },
    ...ndkSigner.encrypt ? {
      async nip04Encrypt(pubkey, plaintext) {
        return ndkSigner.encrypt({ pubkey }, plaintext, "nip04");
      },
      async nip44Encrypt(pubkey, plaintext) {
        return ndkSigner.encrypt({ pubkey }, plaintext, "nip44");
      }
    } : {},
    ...ndkSigner.decrypt ? {
      async nip04Decrypt(pubkey, ciphertext) {
        return ndkSigner.decrypt({ pubkey }, ciphertext, "nip04");
      },
      async nip44Decrypt(pubkey, ciphertext) {
        return ndkSigner.decrypt({ pubkey }, ciphertext, "nip44");
      }
    } : {}
  };
}
async function nostrSignerAsNdkSigner(signer, opts = {}) {
  const pubkey = await signer.getPublicKey();
  const user = opts.NDKUser ? new opts.NDKUser({ pubkey }) : { pubkey };
  const wrapper = {
    get pubkey() {
      return pubkey;
    },
    get userSync() {
      return user;
    },
    async user() {
      return user;
    },
    async blockUntilReady() {
      return user;
    },
    async sign(event) {
      var _a, _b;
      if (typeof event.kind !== "number") {
        throw new Error("nostrSignerAsNdkSigner: event is missing `kind`");
      }
      const signed = await signer.signEvent({
        kind: event.kind,
        created_at: (_a = event.created_at) != null ? _a : Math.floor(Date.now() / 1e3),
        tags: (_b = event.tags) != null ? _b : [],
        content: event.content
      });
      return signed.sig;
    },
    async encrypt(recipient, value, scheme) {
      if (scheme === "nip44") {
        if (!signer.nip44Encrypt) {
          throw new Error("signer does not support NIP-44 encryption");
        }
        return signer.nip44Encrypt(recipient.pubkey, value);
      }
      if (!signer.nip04Encrypt) {
        throw new Error("signer does not support NIP-04 encryption");
      }
      return signer.nip04Encrypt(recipient.pubkey, value);
    },
    async decrypt(sender, value, scheme) {
      if (scheme === "nip44") {
        if (!signer.nip44Decrypt) {
          throw new Error("signer does not support NIP-44 decryption");
        }
        return signer.nip44Decrypt(sender.pubkey, value);
      }
      if (!signer.nip04Decrypt) {
        throw new Error("signer does not support NIP-04 decryption");
      }
      return signer.nip04Decrypt(sender.pubkey, value);
    },
    async encryptionEnabled(scheme) {
      const out = [];
      if (signer.nip04Encrypt) out.push("nip04");
      if (signer.nip44Encrypt) out.push("nip44");
      if (scheme) return out.includes(scheme) ? [scheme] : [];
      return out;
    },
    toPayload() {
      return JSON.stringify({ type: "nostr-as-ndk", pubkey });
    }
  };
  return wrapper;
}

export { Nip07Signer, Nip46Signer, Nip55Signer, PrivateKeySigner, isNip07Available, ndkSignerAsNostrSigner, nostrSignerAsNdkSigner };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map