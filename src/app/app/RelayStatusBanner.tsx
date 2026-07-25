'use client';

/** Relay status row for the unified bottom-right activity stack. */

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

/** Shared relay row inside the bottom-right activity stack. */
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
      className={'pointer-events-auto flex items-start gap-3 rounded-xl border px-3 py-2 text-xs shadow-2xl backdrop-blur ' + SEVERITY_CLASSES[status.severity]}
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
        <div className="font-semibold leading-tight">{status.label}</div>
        {status.detail && <div className="mt-0.5 text-[11px] leading-snug opacity-80">{status.detail}</div>}
      </div>
    </div>
  );
}
