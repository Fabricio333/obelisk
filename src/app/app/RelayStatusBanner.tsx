'use client';

/**
 * Single source of truth for "what's wrong with the relay right now."
 * Merges connection state (`useConnectionState`) and NIP-42 access state
 * (`useRelayAccess`) into ONE banner so the chat pane never shows
 * stacked AUTH/connection signs. Mounted ONCE per shell:
 *
 *   - Desktop: `DesktopShell.tsx:ChatPanel`, just above the chat scroll.
 *   - Mobile:  `PhoneShell.tsx:ChannelScreen`, just above the messages.
 *
 * Returns `null` when the relay is fully healthy (`Connected` +
 * `access === 'ok'`) — nothing renders, no layout shift, no chrome.
 *
 * The component intentionally does NOT cover non-relay UI cases (e.g.
 * the user is logged out — LoginModal owns that surface).
 */

import {
  useConnectionState,
  useIsLoggedIn,
  useMyLoginMethod,
  useRelayAccess,
  useCurrentRelayUrl,
} from '@/lib/nostr-bridge';

type Severity = 'info' | 'warn' | 'error';

interface Status {
  state: string;
  severity: Severity;
  label: string;
  detail?: string;
  spinner?: boolean;
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function computeStatus(
  conn: string,
  access: ReturnType<typeof useRelayAccess>,
  loginMethod: ReturnType<typeof useMyLoginMethod>,
  host: string,
): Status | null {
  // ── Connection-state takes precedence ────────────────────────────
  if (conn === 'Offline') {
    return {
      state: 'offline',
      severity: 'warn',
      label: 'You’re offline',
      detail: 'Cached channels and messages remain available. Reconnecting when your network returns.',
    };
  }
  if (conn === 'Connecting') {
    return {
      state: 'connecting',
      severity: 'warn',
      label: `Connecting to ${host}…`,
      detail: 'Waiting for the relay handshake.',
      spinner: true,
    };
  }
  if (conn === 'Disconnected') {
    return {
      state: 'disconnected',
      severity: 'error',
      label: 'Connection lost',
      detail: 'Reconnecting in the background.',
      spinner: true,
    };
  }
  if (conn.startsWith('Error:')) {
    return {
      state: 'error',
      severity: 'error',
      label: `Cannot reach ${host}`,
      detail: conn.slice('Error:'.length).trim(),
    };
  }
  // conn === 'Connected' from here.
  if (access === 'authenticating') {
    const detail =
      loginMethod === 'bunker'
        ? 'Approve the signing request in your bunker app.'
        : loginMethod === 'nip07'
          ? 'Approve the signing request in your Nostr extension.'
          : 'Signing the relay AUTH challenge…';
    return {
      state: 'authenticating',
      severity: 'warn',
      label: `Authenticating with ${host}…`,
      detail,
      spinner: true,
    };
  }
  if (access === 'auth-required') {
    return {
      state: 'auth-required',
      severity: 'warn',
      label: `Not authenticated to ${host}`,
      detail:
        loginMethod === 'bunker' || loginMethod === 'nip07'
          ? 'NIP-42 AUTH did not complete. Reapprove the signing request.'
          : 'NIP-42 AUTH did not complete. Try reloading.',
    };
  }
  if (access === 'restricted') {
    return {
      state: 'restricted',
      severity: 'error',
      label: `Not whitelisted on ${host}`,
      detail:
        'Your pubkey is signed in, but this relay won’t serve or accept events. Ask the operator to add you, or switch relays.',
    };
  }
  if (access === 'unreachable') {
    return {
      state: 'unreachable',
      severity: 'error',
      label: `Cannot reach ${host}`,
      detail: 'The relay isn’t responding. Retrying in the background.',
    };
  }
  if (access === 'error') {
    return {
      state: 'error',
      severity: 'error',
      label: `Relay error on ${host}`,
      detail: 'The relay rejected the request. Try reloading or switching relays.',
    };
  }
  // 'ok' or 'unknown' — nothing to surface.
  return null;
}

const SEVERITY_CLASSES: Record<Severity, string> = {
  info: 'bg-lc-card/60 border-lc-border text-lc-white',
  warn: 'bg-yellow-500/10 border-yellow-500/40 text-yellow-200',
  error: 'bg-red-500/10 border-red-500/40 text-red-200',
};

const SPINNER_CLASSES: Record<Severity, string> = {
  info: 'border-lc-green/30 border-t-lc-green',
  warn: 'border-yellow-300/30 border-t-yellow-200',
  error: 'border-red-300/30 border-t-red-200',
};

function bannerTestId(state: string): 'connection-loss-banner' | 'relay-access-banner' {
  return state === 'disconnected' || state === 'offline' ? 'connection-loss-banner' : 'relay-access-banner';
}

/**
 * The unified desktop banner. Renders a full-width strip above the chat
 * pane. Mobile uses {@link RelayStatusBadge} for a tighter inline pill.
 */
export default function RelayStatusBanner() {
  const isLoggedIn = useIsLoggedIn();
  const conn = useConnectionState();
  const access = useRelayAccess();
  const loginMethod = useMyLoginMethod();
  const relay = useCurrentRelayUrl();
  if (!isLoggedIn || !relay) return null;
  const status = computeStatus(conn, access, loginMethod, shortHost(relay));
  if (!status) return null;
  return (
    <div
      data-testid={bannerTestId(status.state)}
      data-state={status.state}
      data-severity={status.severity}
      className={`flex items-start gap-3 border-b px-4 py-2.5 ${SEVERITY_CLASSES[status.severity]}`}
    >
      {status.spinner ? (
        <span
          className={`mt-1 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 ${SPINNER_CLASSES[status.severity]}`}
          aria-hidden
        />
      ) : (
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${status.severity === 'warn' ? 'bg-yellow-400' : 'bg-red-400'} animate-pulse`}
          aria-hidden
        />
      )}
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-tight">{status.label}</div>
        {status.detail && <div className="text-xs opacity-80 mt-0.5">{status.detail}</div>}
      </div>
    </div>
  );
}

/**
 * The mobile-styled badge. Identical signal source as {@link RelayStatusBanner}
 * — renders a single-line pill instead of a multi-line strip so it fits the
 * thinner mobile header / channel-list slot.
 */
export function RelayStatusBadge() {
  const isLoggedIn = useIsLoggedIn();
  const conn = useConnectionState();
  const access = useRelayAccess();
  const loginMethod = useMyLoginMethod();
  const relay = useCurrentRelayUrl();
  if (!isLoggedIn || !relay) return null;
  const status = computeStatus(conn, access, loginMethod, shortHost(relay));
  if (!status) return null;
  return (
    <div
      data-testid={bannerTestId(status.state)}
      data-state={status.state}
      data-severity={status.severity}
      className={`flex items-center gap-2 px-3 py-1.5 border-b text-xs ${SEVERITY_CLASSES[status.severity]}`}
    >
      {status.spinner ? (
        <span
          className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 ${SPINNER_CLASSES[status.severity]}`}
          aria-hidden
        />
      ) : (
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${status.severity === 'warn' ? 'bg-yellow-400' : 'bg-red-400'} animate-pulse`}
          aria-hidden
        />
      )}
      <span className="truncate">{status.label}</span>
    </div>
  );
}
