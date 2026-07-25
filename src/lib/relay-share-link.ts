/**
 * Share-link encoding for relay invites.
 *
 * Format: `obelisk.ar/r/<code>` where `<code>` is either:
 *   - a known short alias (e.g. `lacrypta` → `wss://lacrypta-relay.obelisk.ar`)
 *   - a base64url-encoded `wss://...` URL
 *
 * Visiting the link adds the relay to the user's configured list and switches
 * to it. Idempotent: re-visiting is a no-op if already configured + active.
 */

const ALIASES: Record<string, string> = {
  lacrypta: 'wss://lacrypta-relay.obelisk.ar',
  public: 'wss://public.obelisk.ar',
  obelisk: 'wss://lacrypta-relay.obelisk.ar',
};

function base64urlEncode(input: string): string {
  if (typeof window === 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string | null {
  try {
    let s = input.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof window === 'undefined') return Buffer.from(s, 'base64').toString('utf8');
    return atob(s);
  } catch {
    return null;
  }
}

/** Decode a share code. Returns the relay URL or null if invalid. */
export function decodeRelayShareCode(code: string): string | null {
  if (!code) return null;
  const alias = ALIASES[code.toLowerCase()];
  if (alias) return alias;
  const decoded = base64urlDecode(code);
  if (!decoded) return null;
  if (!decoded.startsWith('ws://') && !decoded.startsWith('wss://')) return null;
  try {
    new URL(decoded);
  } catch {
    return null;
  }
  return decoded;
}

/** Encode a relay URL into a share code (base64url). Use an alias when possible. */
export function encodeRelayShareCode(url: string): string {
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (target === url) return alias;
  }
  return base64urlEncode(url);
}
