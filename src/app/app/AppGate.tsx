'use client';

/**
 * Viewport gate for /app — renders the mobile shell on phones (≤sm) and the
 * existing desktop AppShell on tablets and up. The breakpoint matches
 * Tailwind's `sm` (640px) so it composes with the existing `sm:`/`md:` rules
 * elsewhere in the app.
 *
 * SSR returns `null` for the first paint; the client picks the right shell
 * once `window.matchMedia` resolves. This avoids hydration mismatches when
 * the user-agent and viewport disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
// Hoist the mobile shell's stylesheet up to the eagerly-loaded route bundle
// so it's in place before the dynamic PhoneShell chunk hydrates. Without
// this, Next.js loads the CSS only when the dynamic chunk arrives — which
// in practice means the first paint of the mobile UI is unstyled (SVG
// icons render at default browser size, etc.).
import './mobile/mobile-shell.css';
import { useIsLoggedIn, useMyPubkey } from '@/lib/nostr-bridge';
import ProfileEditor from '@/components/ProfileEditor';
import ReadStateRoot from '@/lib/read-state/root';

const AppShell = dynamic(() => import('./DesktopShell'), { ssr: false });
const MobileShell = dynamic(() => import('./mobile/PhoneShell'), { ssr: false });

const MOBILE_QUERY = '(max-width: 1023px)';

function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      setIsMobile(false);
      return;
    }
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

/**
 * First-time-after-login profile setup gate. Shown only for freshly generated
 * keys (LoginModal writes the `obelisk-dex/just-generated/{pubkey}` flag on
 * `generate`). Mounted in both shells via AppGate so it fires on desktop and
 * mobile alike. Uses ProfileEditor in setup mode, which uploads avatars to
 * Blossom rather than asking for a pasted URL.
 *
 * Previous iterations probed relays (via fetchProfile / useProfile) to detect
 * "empty kind:0 → show setup" but every variant was racy: a hard refresh with
 * a cold relay would resolve to empty before the user's real kind:0 arrived,
 * falsely prompting existing users into a setup flow that could overwrite
 * their profile. Existing users edit via UserPanel; we never auto-prompt.
 */
function ProfileSetupGate() {
  const myPubkey = useMyPubkey();
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    if (!myPubkey) return;
    if (typeof window === 'undefined') return;
    // Only auto-prompt for freshly generated keys (set by LoginModal). Probing
    // relays on every cold start was racy: a hard refresh with no warm relay
    // could resolve `fetchProfile` to empty before the user's kind:0 lands,
    // falsely showing setup to an existing user. Existing users edit their
    // profile from UserPanel; we never auto-prompt them.
    const justGenKey = `obelisk-dex/just-generated/${myPubkey}`;
    if (window.localStorage.getItem(justGenKey)) {
      try { window.localStorage.removeItem(justGenKey); } catch { /* ignore */ }
      setShowSetup(true);
    }
  }, [myPubkey]);

  const dismiss = useCallback(() => {
    setShowSetup(false);
  }, []);

  if (!showSetup) return null;
  return <ProfileEditor mode="setup" onComplete={dismiss} onSkip={dismiss} />;
}

export default function AppGate() {
  const isMobile = useIsMobile();
  const loggedIn = useIsLoggedIn();
  if (isMobile === null) return null;
  return (
    <>
      {loggedIn ? <ReadStateRoot /> : null}
      {isMobile ? <MobileShell /> : <AppShell />}
      {loggedIn ? <ProfileSetupGate /> : null}
    </>
  );
}
