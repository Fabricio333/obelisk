import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { cookies, headers } from 'next/headers';
import { LocaleProvider } from '@/i18n/context';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER, isLocale, type Locale } from '@/i18n/index';
import ToastStack from '@/components/ToastStack';
import AppearancePreferencesRoot from '@/components/AppearancePreferencesRoot';
// SDK styles first so our globals.css overrides win at equal specificity
// (e.g. the la-crypta `--nui-overlay-bg` override that lets the login
// backdrop animation bleed through the modal overlay).
import '@nostr-wot/ui/styles.css';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});

const SITE_URL = process.env.CORS_ORIGIN || 'https://obelisk.ar';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Obelisk — Discord alternative with Nostr login. No email, no password.',
    template: '%s · Obelisk',
  },
  description:
    'The Discord alternative for crypto and privacy communities. Log in with your Nostr keys — no email, no password, no phone number. Servers, channels, voice and encrypted DMs, with Web of Trust spam resistance.',
  applicationName: 'Obelisk',
  keywords: [
    'Discord alternative',
    'Nostr login',
    'Nostr chat',
    'Nostr Discord',
    'no email no password chat',
    'private group chat',
    'crypto community chat',
    'decentralized Discord',
    'self-hosted chat',
    'sovereign identity chat',
    'NIP-07',
    'NIP-46 bunker',
    'Web of Trust',
    'open source Discord alternative',
    'La Crypta',
  ],
  authors: [{ name: 'La Crypta', url: 'https://lacrypta.ar' }],
  creator: 'La Crypta',
  publisher: 'La Crypta',
  category: 'social',
  referrer: 'origin-when-cross-origin',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  icons: {
    // Browser tab + legacy shortcut keep the small detail-rich favicon
    // (dark circle with green obelisk) — works well at 16/32px.
    icon: '/obelisk-favicon.png',
    shortcut: '/obelisk-favicon.png',
    // iOS home screen ("Add to Home Screen") uses the same vibrant icon
    // as the Android PWA so the installed-app look matches across
    // platforms. iOS rounds the corners automatically.
    apple: '/icon-512.png',
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: 'Obelisk — Discord alternative with Nostr login',
    description:
      'Group chat for crypto and privacy folks. Log in with your Nostr keys — no email, no password. Servers, voice, encrypted DMs, Web of Trust spam resistance.',
    siteName: 'Obelisk',
    url: SITE_URL,
    locale: 'en_US',
    alternateLocale: ['es_AR'],
    type: 'website',
    images: [{
      url: '/og/obelisk.png?v=2',
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: 'Obelisk — Group chat powered by Nostr identity',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Obelisk — Discord alternative with Nostr login',
    description:
      'Group chat for crypto and privacy folks. Log in with your Nostr keys — no email, no password.',
    creator: '@lacryptaar',
    images: ['/og/obelisk.png?v=2'],
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const headerLocale = requestHeaders.get(LOCALE_HEADER);
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(headerLocale)
    ? headerLocale
    : isLocale(cookieLocale)
      ? cookieLocale
      : DEFAULT_LOCALE;
  // Per-request CSP nonce minted by src/proxy.ts. Stamping it on every
  // inline <Script>/<script> we render keeps the strict CSP green; any
  // injected upstream script (Cloudflare, browser extensions) without
  // this nonce is correctly blocked.
  const nonce = requestHeaders.get('x-nonce') ?? undefined;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'Obelisk',
        description:
          'Discord alternative with Nostr login — no email, no password. Group chat for crypto and privacy communities.',
        inLanguage: locale === 'en' ? 'en' : 'es-AR',
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'La Crypta',
        url: 'https://lacrypta.ar',
        logo: `${SITE_URL}/obelisk.png`,
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Obelisk',
        applicationCategory: 'CommunicationApplication',
        operatingSystem: 'Web',
        description:
          'Discord alternative powered by Nostr identity. Log in with your keys — no email, no password. Includes servers, channels, voice, encrypted DMs and Web of Trust spam resistance.',
        url: SITE_URL,
        image: `${SITE_URL}/obelisk.png`,
        author: { '@id': `${SITE_URL}/#organization` },
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
      },
    ],
  };

  return (
    <html lang={locale}>
      <head>
        <script
          type="application/ld+json"
          nonce={nonce}
          // React 19 strips the nonce attribute from DOM nodes after CSP
          // evaluation (security: prevents JS from reading the nonce). The
          // SSR HTML keeps it (browser uses it during initial parse) but
          // hydration sees nonce="" on the live element. This is intended;
          // suppress the otherwise-confusing warning.
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-BZ4NB66WY0"
          strategy="afterInteractive"
          nonce={nonce}
        />
        {/* PWA route guard. When the app is opened in standalone mode
            (Add-to-home-screen / installed PWA) and lands on the public
            landing page, jump straight to /app so the marketing hero
            doesn't flash before the chat shell mounts. Rendered as a
            native <script> in <head> (not next/script) so it runs as the
            HTML is parsed — earlier than `beforeInteractive` — and
            sidesteps React 19's nonce-stripping hydration warning, same
            pattern as the JSON-LD block above. */}
        <script
          id="obelisk-pwa-route-guard"
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=(typeof matchMedia==='function'&&matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true;if(s&&location.pathname==='/'){location.replace('/app'+location.search+location.hash);}}catch(e){}})();`,
          }}
        />
        <Script id="google-analytics" strategy="afterInteractive" nonce={nonce}>
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-BZ4NB66WY0');
          `}
        </Script>
        {/* Register the minimal service worker so Chrome / Edge / Brave
            offer the "Install app" prompt. The worker itself is
            pass-through (see /public/sw.js) — registering it is the
            installability gate, not a behavior change. */}
        <Script id="obelisk-pwa-register" strategy="afterInteractive" nonce={nonce}>
          {`
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.addEventListener('message', function (event) {
                if (!event.data || event.data.type !== 'OBELISK_SW_UPDATED') return;
                var key = 'obelisk-sw-version';
                var nextVersion = String(event.data.version || '');
                try {
                  if (nextVersion && localStorage.getItem(key) === nextVersion) return;
                  if (nextVersion) localStorage.setItem(key, nextVersion);
                } catch (e) {}
                window.location.reload();
              });
              window.addEventListener('load', function () {
                navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(function (registration) {
                  registration.update().catch(function () {});
                }).catch(function () {
                  /* swallow — installability is a UX bonus, not a hard requirement */
                });
              });
            }
          `}
        </Script>
      </head>
      <body
        className={`${inter.className} bg-lc-black text-lc-white antialiased`}
        data-nui-root
        data-nui-theme="la-crypta"
      >
        <LocaleProvider initialLocale={locale}>
          <AppearancePreferencesRoot />
          {children}
          <ToastStack />
        </LocaleProvider>
      </body>
    </html>
  );
}
