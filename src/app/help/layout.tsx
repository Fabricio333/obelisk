import type { Metadata } from 'next';

const SITE_URL = process.env.CORS_ORIGIN || 'https://obelisk.ar';

export const metadata: Metadata = {
  title: 'Help — Nostr login, relays, communities, and Bitcoin zaps',
  description:
    'Get help with Obelisk: learn Nostr identity, relay-based groups, community administration, privacy, Lightning payments, and Bitcoin zaps.',
  alternates: { canonical: '/help' },
  keywords: [
    'Obelisk help',
    'Nostr chat help',
    'Nostr login guide',
    'NIP-29 community guide',
    'Nostr relay help',
    'Bitcoin zaps guide',
  ],
  openGraph: {
    title: 'Obelisk Help — guides for Nostr chat and communities',
    description:
      'Guides for Nostr identity, relay-based groups, community administration, privacy, Lightning payments, and Bitcoin zaps.',
    url: SITE_URL + '/help',
    siteName: 'Obelisk',
    type: 'website',
    images: [{
      url: '/og/obelisk.png?v=2',
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: 'Obelisk — group chat powered by Nostr identity',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Obelisk Help — Nostr chat and community guides',
    description:
      'Learn Nostr identity, relay-based groups, community administration, privacy, Lightning payments, and Bitcoin zaps.',
    images: ['/og/obelisk.png?v=2'],
  },
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
