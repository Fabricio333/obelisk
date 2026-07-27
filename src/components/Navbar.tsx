'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hexToNpub } from '@nostr-wot/data';
import { getBridge, useIsLoggedIn, useMyPubkey, useUserMetadata } from '@/lib/nostr-bridge';
import { useTranslation } from '@/i18n/context';
import ObeliskIcon from './ObeliskIcon';
import LanguageToggle from './LanguageToggle';
import { guidesHref } from '@/lib/guide-urls';

const SIMPLE_LINKS = [
  { href: '/features', key: 'nav.features' },
  { href: '/#how-it-works', key: 'nav.howItWorks' },
  { href: '/#roadmap', key: 'nav.roadmap' },
];

const GUIDE_ITEMS = [
  { slug: 'what-is-obelisk', tKey: 'learn.card.whatIsObelisk.title' },
  { slug: 'how-obelisk-works', tKey: 'learn.card.howObeliskWorks.title' },
  { slug: 'web-of-trust', tKey: 'learn.card.webOfTrust.title' },
  { slug: 'future-nostr-relays', tKey: 'learn.card.futureNostrRelays.title' },
] as const;

export default function Navbar(_props: { onLoginSuccess?: () => void } = {}) {
  const [showMenu, setShowMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [guidesOpen, setGuidesOpen] = useState(false);
  const myPubkey = useMyPubkey();
  const isConnected = useIsLoggedIn();
  const profile = useUserMetadata(myPubkey);
  const npub = myPubkey ? safeNpub(myPubkey) : '';
  const { t, locale } = useTranslation();
  const router = useRouter();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleLogout = async () => {
    const bridge = await getBridge();
    await bridge.logout();
    setShowMenu(false);
    router.push('/');
  };

  return (
    <>
      <nav className={`fixed top-0 left-0 right-0 z-40 transition-all duration-300 ${
        scrolled ? 'bg-lc-black/95 backdrop-blur-xl' : 'bg-transparent'
      }`}>
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3">
            <ObeliskIcon className="w-12 h-12 text-lc-green" />
            <span className="font-extrabold text-2xl text-lc-white tracking-tight">Obelisk</span>
          </Link>

          {/* Nav links */}
          <div className="hidden md:flex items-center gap-1">
            {SIMPLE_LINKS.map(({ href, key }) => (
              <a
                key={href}
                href={href}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-lc-muted hover:text-lc-white transition-colors"
              >
                {t(key)}
              </a>
            ))}

            {/* Guides dropdown */}
            <div
              className="relative"
              onMouseEnter={() => setGuidesOpen(true)}
              onMouseLeave={() => setGuidesOpen(false)}
              onFocus={() => setGuidesOpen(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setGuidesOpen(false);
              }}
            >
              <Link
                href={guidesHref(locale)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-lc-muted hover:text-lc-white transition-colors inline-flex items-center gap-1"
                aria-haspopup="true"
                aria-expanded={guidesOpen}
                data-testid="nav-guides-link"
              >
                {t('nav.guides')}
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className={`transition-transform ${guidesOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                >
                  <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>

              {guidesOpen && (
                <div
                  className="absolute left-0 top-full pt-2 w-72"
                  data-testid="nav-guides-dropdown"
                >
                  <div className="bg-lc-dark border border-lc-border rounded-xl shadow-2xl overflow-hidden">
                    {GUIDE_ITEMS.map((g) => (
                      <Link
                        key={g.slug}
                        href={guidesHref(locale, g.slug)}
                        className="block px-4 py-3 text-sm text-lc-muted hover:bg-lc-border/50 hover:text-lc-white transition"
                      >
                        {t(g.tKey)}
                      </Link>
                    ))}
                    <Link
                      href={guidesHref(locale)}
                      className="block px-4 py-3 text-sm font-semibold text-lc-green hover:bg-lc-border/50 border-t border-lc-border/50"
                    >
                      {t('footer.allGuides')} →
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <Link
              href="/#faq"
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-lc-muted hover:text-lc-white transition-colors"
            >
              {t('nav.faq')}
            </Link>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            <LanguageToggle />
            {isConnected && profile ? (
              <>
                <Link
                  href="/app"
                  className="lc-pill lc-pill-primary text-sm"
                  data-testid="nav-app-pill"
                >
                  {t('nav.app')}
                </Link>
                <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="flex items-center gap-2.5 py-1.5 pl-1.5 pr-4 bg-lc-dark hover:bg-lc-border rounded-full transition-all duration-200 border border-lc-border/50"
                >
                  {profile?.picture ? (
                    <img
                      src={profile.picture}
                      alt={profile.name || 'Profile'}
                      className="w-8 h-8 rounded-full object-cover ring-1 ring-lc-border"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-lc-olive flex items-center justify-center text-lc-green text-sm font-semibold">
                      {((profile?.name ?? profile?.displayName ?? 'N')[0] ?? 'N').toUpperCase()}
                    </div>
                  )}
                  <span className="text-sm text-lc-white font-medium max-w-[120px] truncate">
                    {profile?.displayName || profile?.name || 'Anon'}
                  </span>
                </button>

                {showMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                    <div className="absolute right-0 mt-2 w-56 bg-lc-dark border border-lc-border rounded-xl shadow-2xl overflow-hidden z-50">
                      <div className="p-4 border-b border-lc-border">
                        <div className="text-sm text-lc-white font-semibold truncate">
                          {profile?.displayName || profile?.name || 'Anon'}
                        </div>
                        <div className="text-xs text-lc-muted truncate mt-0.5 font-mono">
                          {npub ? `${npub.slice(0, 20)}...` : ''}
                        </div>
                      </div>
                      <a
                        href="/app"
                        className="w-full p-3 text-left text-sm text-lc-muted hover:bg-lc-border/50 hover:text-lc-white transition flex items-center gap-2"
                        data-testid="nav-profile-link"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
                          <circle cx="12" cy="7" r="4"/>
                        </svg>
                        Profile
                      </a>
                      <button
                        onClick={() => void handleLogout()}
                        className="w-full p-3 text-left text-sm text-red-400 hover:bg-lc-border/50 transition flex items-center gap-2"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                          <polyline points="16 17 21 12 16 7"/>
                          <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                        {t('nav.disconnect')}
                      </button>
                    </div>
                  </>
                )}
                </div>
              </>
            ) : (
              <button
                onClick={() => router.push('/app')}
                className="lc-pill lc-pill-primary text-sm flex items-center gap-2"
              >
                {t('nav.launchApp')}
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* LoginModal removed: the bridge-backed login lives at /app. Old modal called dead /api/auth/challenge. */}
    </>
  );
}

function safeNpub(pubkeyHex: string): string {
  try { return hexToNpub(pubkeyHex); } catch { return ''; }
}
