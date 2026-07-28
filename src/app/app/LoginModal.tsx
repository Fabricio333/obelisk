'use client';

/**
 * Production login modal — thin wrapper around `@nostr-wot/ui`'s
 * `<LoginWidget>`. Updates to the fork's UI flow into obelisk-dex via
 * the `file:../nostr-wot-sdk/packages/ui` dep.
 *
 * The SDK builds its own `NostrSigner` and now hands the bridging
 * material directly through `onLogin` (`nsec` for generate/import,
 * `bunkerUri` and its paired signer for nip46). We route each method to the existing bridge
 * entrypoint without touching the SDK's localStorage:
 *   - nip07              → bridge.loginWithNip07(pubkey)
 *   - import / generate  → bridge.loginWithNsec(skHex, pkHex) using args.nsec
 *   - nip46              → bridge.loginWithBunker(args.bunkerUri)
 *
 * The bridge receives the final signer only after the generated-key backup,
 * profile, and public-profile sharing steps are complete.
 */

import {
  LoginModal as SdkLoginModal,
  Modal,
  type LoginMethodId,
} from '@nostr-wot/ui';
import { nip19 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { getPool, nsecToBytes, nsecToHex as sdkNsecToHex } from '@nostr-wot/data';
import { useCallback, useEffect, useRef, useState, type ReactNode, type SVGProps } from 'react';
import { nostrActions } from '@/lib/nostr-bridge';
import { OBELISK_NIP46_PERMISSIONS } from '@/lib/nostr-signing-kinds';
import GeneratedProfileEnhancements from './GeneratedProfileEnhancements';

const NIP46_PERMS = OBELISK_NIP46_PERMISSIONS;

const NIP46_METADATA = {
  name: 'Obelisk',
  url: 'https://obelisk.ar',
};

const iconBase = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
};
const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...iconBase} {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
);
const ShieldIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...iconBase} {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const SparkleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...iconBase} {...p}>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
    <path d="M19 15l.7 1.7L21.5 17.5l-1.8.8L19 20l-.7-1.7L16.5 17.5l1.8-.8z" />
  </svg>
);
const KeyIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...iconBase} {...p}>
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

function nsecToHex(nsec: string): { skHex: string; pkHex: string } {
  const sk = nsecToBytes(nsec);
  if (!sk) throw new Error('Invalid nsec');
  const skHex = sdkNsecToHex(nsec);
  if (!skHex) throw new Error('Invalid nsec');
  const pkHex = getPublicKey(sk);
  return { skHex, pkHex };
}

function nsecToSkHex(nsec: string): string {
  const skHex = sdkNsecToHex(nsec);
  if (!skHex) throw new Error('Invalid nsec');
  return skHex;
}

export function signerAppHref(uri: string, userAgent: string): string {
  if (!/Android/i.test(userAgent)) return uri;
  return `intent://${uri.slice('nostrconnect://'.length)}#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;end`;
}

export async function copyConnectionUri(uri: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(uri);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = uri;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try { return document.execCommand('copy'); }
    catch { return false; }
    finally { textarea.remove(); }
  }
}

export function isTransientNip46Error(message: string): boolean {
  return /subscription closed before (?:the )?connection was established/i.test(message);
}

async function routeToBridge(args: {
  method: LoginMethodId;
  pubkey: string;
  nsec?: string;
  bunkerUri?: string;
  clientNsec?: string;
  signer?: unknown;
}): Promise<void> {
  const { method, pubkey, nsec, bunkerUri, clientNsec, signer } = args;
  switch (method) {
    case 'nip07':
      await nostrActions.loginWithNip07(pubkey);
      return;

    case 'import':
    case 'generate': {
      if (!nsec) throw new Error('SDK did not provide an nsec for the bridge');
      const { skHex, pkHex } = nsecToHex(nsec);
      await nostrActions.loginWithNsec(skHex, pkHex);
      return;
    }

    case 'nip46': {
      if (!bunkerUri) throw new Error('SDK did not provide a bunker URI');
      if (!signer) throw new Error('SDK did not provide the paired remote signer');
      // The SDK has already paired the remote signer with `clientNsec`.
      // We must reuse that client identity — a fresh key would be
      // rejected by the signer ("no secret") since it never authorized it.
      await nostrActions.loginWithBunker(bunkerUri, {
        ...(clientNsec ? { clientSecretHex: nsecToSkHex(clientNsec) } : {}),
        signer: signer as NonNullable<Parameters<typeof nostrActions.loginWithBunker>[1]>['signer'],
      });
      return;
    }
  }
}

/**
 * Local patch for an "Open in signer app" deep-link button inside the SDK's
 * NIP-46 QR view. The fork at `../nostr-wot-sdk` already implements this
 * (Nip46Method.tsx:323-331) but it's missing from the published npm v0.6.0
 * that we currently consume. This sidecar finds the rendered `nostrconnect://`
 * URI in the DOM and inserts a tappable `<a>` below the QR — useful on mobile
 * where the user can't scan their own screen but can hand off to Amber, Nsec.app,
 * Keychat, etc. via the registered URL scheme.
 *
 * The SDK remounts its modal when a cancelled connection rotates the QR, so
 * the observer lives on document.body and follows the replacement overlay.
 *
 * TODO: once @nostr-wot/ui publishes a version with the native button, delete
 *       this component and the matching `.nui-open-signer` CSS rule.
 */
function Nip46SignerDeepLink(): null {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let injected: HTMLElement | null = null;

    const removeInjected = () => {
      if (injected && injected.isConnected) injected.remove();
      injected = null;
    };

    const sync = () => {
      const qrWrap = document.querySelector<HTMLElement>('.nui-modal .nui-qr-wrap');
      const uri = qrWrap?.querySelector<HTMLElement>('.nui-key-display')?.textContent?.trim();
      const pasteTab = document.querySelector<HTMLButtonElement>('.nui-modal .nui-tabs [role="tab"]:last-child');
      if (pasteTab?.textContent?.trim() === 'Paste URI') pasteTab.textContent = 'Use bunker URI';

      if (!qrWrap || !uri || !uri.startsWith('nostrconnect://')) {
        removeInjected();
        return;
      }
      if (injected && injected.isConnected && injected.dataset.nostrconnect === uri) return;

      removeInjected();
      const actions = document.createElement('div');
      actions.className = 'nui-signer-actions';
      actions.dataset.nostrconnect = uri;
      const a = document.createElement('a');
      a.href = signerAppHref(uri, navigator.userAgent);
      a.className = 'nui-open-signer';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', () => { void copyConnectionUri(uri); });
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗'; // ↗
      const label = document.createElement('span');
      label.textContent = 'Open in signer app';
      a.append(arrow, label);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'nui-copy-signer';
      copy.textContent = 'Copy connection URI';
      copy.addEventListener('click', async () => {
        copy.textContent = await copyConnectionUri(uri) ? 'Copied' : 'Copy failed — select URI below';
      });
      const hint = document.createElement('p');
      hint.className = 'nui-signer-copy-hint';
      hint.textContent = 'Fallback: copy it, then in Amber open New application → Paste from clipboard.';
      actions.append(a, copy, hint);
      const qr = qrWrap.querySelector('.nui-qr');
      if (qr) qr.insertAdjacentElement('afterend', actions);
      else qrWrap.append(actions);
      injected = actions;
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    sync();

    return () => {
      observer.disconnect();
      removeInjected();
    };
  }, []);

  return null;
}

interface LoginModalProps {
  onSuccess?: () => void;
  /** When provided, restrict the SDK modal to these methods (forwarded as-is). */
  methods?: LoginMethodId[];
  /** Lets the host dismiss the modal. Defaults to a no-op when the modal is the
   * only visible UI (desktop AppShell). */
  onClose?: () => void;
  /** Passed through so a host can override the SDK's default copy. */
  title?: string;
  subtitle?: string;
  /** Optional node rendered above the title — e.g. the obelisk hero mark on mobile. */
  headerSlot?: ReactNode;
}

type LoginArgs = Parameters<typeof routeToBridge>[0];
type GeneratedProfileDraft = { name?: string; about?: string; picture?: string; banner?: string };

const GENERATED_PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

async function publishGeneratedProfile(nsec: string, profile: GeneratedProfileDraft): Promise<void> {
  const secretKey = nsecToBytes(nsec);
  if (!secretKey || !Object.values(profile).some(Boolean)) return;
  const content = {
    ...(profile.name ? { name: profile.name, display_name: profile.name } : {}),
    ...(profile.about ? { about: profile.about } : {}),
    ...(profile.picture ? { picture: profile.picture } : {}),
    ...(profile.banner ? { banner: profile.banner } : {}),
  };
  const event = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(content),
  }, secretKey);
  try { await Promise.allSettled(getPool().publish(GENERATED_PROFILE_RELAYS, event)); } catch { /* non-fatal */ }
}

export default function LoginModal({
  onSuccess,
  methods,
  onClose,
  title = 'Connect to Nostr',
  subtitle = 'Choose your login method',
  headerSlot,
}: LoginModalProps = {}) {
  const [generatedLogin, setGeneratedLogin] = useState<LoginArgs | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState('');
  const [generatedProfile, setGeneratedProfile] = useState<GeneratedProfileDraft>({});
  const [nip46Retry, setNip46Retry] = useState(0);
  const [hideTransientError, setHideTransientError] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateGeneratedProfile = useCallback((patch: GeneratedProfileDraft) => {
    setGeneratedProfile((current) => ({ ...current, ...patch }));
  }, []);
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const handleSdkError = (message: string) => {
    if (!isTransientNip46Error(message)) return;
    setHideTransientError(true);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      setNip46Retry((current) => current + 1);
      setHideTransientError(false);
    }, Math.min(5_000, 250 * 2 ** nip46Retry));
  };

  if (generatedLogin) {
    const npub = nip19.npubEncode(generatedLogin.pubkey);
    const finish = async () => {
      setFinishing(true);
      setFinishError('');
      try {
        await routeToBridge(generatedLogin);
        onSuccess?.();
      } catch (error) {
        setFinishError(error instanceof Error ? error.message : String(error));
        setFinishing(false);
      }
    };

    const backFromGenerated = () => setGeneratedLogin(null);

    return (
      <Modal
        open
        onClose={onClose ?? backFromGenerated}
        aria-label="Share your Nostr profile"
        classes={{ modal: 'obelisk-login-modal obelisk-share-modal' }}
      >
        <button type="button" className="nui-back obelisk-flow-back" aria-label="Back" onClick={backFromGenerated}>
          ‹
        </button>
        <div className="nui-form obelisk-npub-share" data-testid="generated-npub-step">
          <div className="nui-form-head">
            <span className="obelisk-step-done" aria-hidden="true">✓</span>
            <h3 className="nui-form-title">Your profile is ready</h3>
            <p className="nui-form-sub">
              Your npub is your public profile address. Share it so people can find
              and follow you. It is safe to share — your nsec is the key that stays private.
            </p>
          </div>
          <div className="nui-key-display">{npub}</div>
          <button
            type="button"
            className="nui-back obelisk-copy-npub"
            onClick={() => navigator.clipboard?.writeText(npub).catch(() => {})}
          >
            Copy my npub
          </button>
          {finishError && <p className="nui-error" role="alert">{finishError}</p>}
          <button type="button" className="nui-login-button" disabled={finishing} onClick={() => void finish()}>
            {finishing ? 'Connecting…' : 'Enter Obelisk'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <>
      <Nip46SignerDeepLink />
      <GeneratedProfileEnhancements onDraftChange={updateGeneratedProfile} />
      <SdkLoginModal
        key={nip46Retry}
        open
        onClose={onClose ?? (() => { /* AppShell only mounts this when logged out — no dismiss */ })}
        title={title}
        subtitle={subtitle}
        flatLayout
        showRememberToggle
        profileSetup
        nip46Relays={['wss://public.obelisk.ar']}
        nip46Perms={NIP46_PERMS}
        nip46Metadata={NIP46_METADATA}
        methods={methods}
        modalClasses={{ modal: 'obelisk-login-modal' }}
        {...(hideTransientError ? { styles: { error: { display: 'none' } } } : {})}
        onError={handleSdkError}
        methodIcons={{
          nip07: <LockIcon />,
          nip46: <ShieldIcon />,
          generate: <SparkleIcon />,
          import: <KeyIcon />,
        }}
        {...(headerSlot ? { slots: { header: headerSlot } } : {})}
        onLogin={async ({ pubkey, method, nsec, bunkerUri, clientNsec, signer }) => {
          const args: LoginArgs = {
            method,
            pubkey,
            ...(nsec ? { nsec } : {}),
            ...(bunkerUri ? { bunkerUri } : {}),
            ...(clientNsec ? { clientNsec } : {}),
            ...(signer ? { signer } : {}),
          };
          if (method === 'generate') {
            if (nsec) await publishGeneratedProfile(nsec, generatedProfile);
            setGeneratedLogin(args);
            return;
          }
          await routeToBridge(args);
          onSuccess?.();
        }}
      />
    </>
  );
}
