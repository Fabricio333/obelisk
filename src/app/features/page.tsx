import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import Footer from '@/components/Footer';
import Navbar from '@/components/Navbar';
import ShootingStars from '@/components/ShootingStars';

const FEATURES = [
  {
    title: 'Nostr relay-based groups',
    description: 'Servers, channels, membership, moderation, messages, and reactions are NIP-29 events. Obelisk has no chat backend or private database between you and the relay.',
    image: '/pictures-for-posts/dekstop-public-general-chat-view-with-member-list.png',
    alt: 'Obelisk NIP-29 group chat with channels and member list on desktop',
    width: 1470, height: 799,
  },
  {
    title: 'Voice messages',
    description: 'Record and send voice notes from the composer. Audio is uploaded to Blossom and delivered as a signed Nostr message with its duration intact.',
    image: '/pictures-for-posts/voice-messages.png',
    alt: 'Obelisk desktop message composer where voice notes can be recorded',
    width: 2940, height: 1678,
  },
  {
    title: 'Sticker marketplace',
    description: 'Discover media packs, keep favorites, create personal stickers, and let relay operators publish server-wide emoji, GIF, and sticker collections.',
    image: '/pictures-for-posts/desktop-forums-view.png',
    alt: 'Obelisk desktop interface with the shared media library available in chat',
    width: 1470, height: 799,
  },
  {
    title: 'Mobile PWA',
    description: 'Install Obelisk from the browser and use the complete responsive app: relays, channels, DMs, profiles, notifications, and calls.',
    image: '/pictures-for-posts/mobile-showcase-readme.png',
    alt: 'Obelisk mobile PWA showing login, channels, a video call, and a Nostr profile',
    width: 3320, height: 1840,
  },
  {
    title: 'Peer-to-peer video calls',
    description: 'Small voice channels connect browsers directly with WebRTC for audio, camera, and screen sharing. Nostr carries the signaling; media stays peer to peer.',
    image: '/pictures-for-posts/desktop-large-voice-channel-with-sfu-peer-trasmission-test.png',
    alt: 'Obelisk voice and video channel on desktop',
    width: 1470, height: 799,
  },
  {
    title: 'Big calls with SFU',
    description: 'Large rooms switch to a mediasoup SFU advertised by the channel. Choose which SFU server to use or host your own. Media remains DTLS-SRTP transport encrypted while avoiding a full mesh between every participant.',
    image: '/pictures-for-posts/desktop-large-voice-channel-with-sfu-peer-trasmission-test.png',
    alt: 'Large Obelisk voice channel using a mediasoup SFU on desktop',
    width: 1470, height: 799,
  },
  {
    title: 'Nostr profile explorer',
    description: 'Open any member’s portable kind-0 identity, follow them, inspect their NIP-05 name, and start a DM without creating another account.',
    image: '/pictures-for-posts/voice-messages.png',
    alt: 'Obelisk interface with portable Nostr profiles',
    width: 2940, height: 1678,
  },
] as const;

export const metadata: Metadata = {
  title: 'Features — relay-native chat, video, stickers, and mobile PWA',
  description: 'Explore Obelisk features: NIP-29 groups, voice messages, sticker packs, mobile PWA, P2P video, large SFU calls, and portable Nostr profiles.',
  alternates: { canonical: '/features' },
  openGraph: {
    title: 'Obelisk: the comeback',
    description: 'Relay-native groups, voice messages, sticker packs, mobile PWA, P2P video, large calls, and portable Nostr profiles.',
    url: '/features',
    type: 'website',
    images: ['/pictures-for-posts/mobile-showcase-readme.png'],
  },
};

export default function FeaturesPage() {
  return (
    <main className="min-h-screen bg-lc-black appearance-bg lc-grid-bg relative">
      <ShootingStars />
      <div className="relative z-10">
        <Navbar />
        <header className="px-6 pb-16 pt-32 text-center">
          <span className="inline-flex rounded-full border border-lc-green/20 bg-lc-olive/40 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-lc-green">The comeback</span>
          <h1 className="mx-auto mt-5 max-w-4xl text-4xl font-extrabold leading-[1.05] tracking-tight text-lc-white md:text-6xl">
            Discord-style community chat.<span className="text-lc-green lc-glow-text"> Relay native.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-lc-muted md:text-xl">
            Your Nostr key is your account. The browser talks directly to relays—no email, password, chat backend, or platform database.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/app" className="lc-pill lc-pill-primary px-8 py-3 text-base">Open Obelisk</Link>
            <a href="https://github.com/obelisk-app/obelisk" className="lc-pill lc-pill-secondary px-8 py-3 text-base" target="_blank" rel="noopener noreferrer">View source</a>
          </div>
        </header>

        <section className="mx-auto max-w-6xl space-y-24 px-6 py-12 lg:space-y-32">
          {FEATURES.map((feature, index) => (
            <article key={feature.title} className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-16">
              <figure className={index % 2 ? 'lg:order-2' : ''}>
                <div className="overflow-hidden rounded-2xl border border-lc-border bg-lc-dark shadow-[0_40px_120px_-40px_rgba(180,249,83,0.18)]">
                  <Image src={feature.image} alt={feature.alt} width={feature.width} height={feature.height} className="block h-auto w-full" sizes="(max-width: 1024px) 90vw, 680px" />
                </div>
              </figure>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lc-green">Feature {String(index + 1).padStart(2, '0')}</p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-lc-white md:text-4xl">{feature.title}</h2>
                <p className="mt-4 text-base leading-relaxed text-lc-muted md:text-lg">{feature.description}</p>
              </div>
            </article>
          ))}
        </section>

        <section className="px-6 py-24 text-center">
          <div className="lc-card lc-glow mx-auto max-w-3xl p-10 md:p-12">
            <h2 className="text-3xl font-bold text-lc-white md:text-4xl">Bring your keys. Keep your identity.</h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-lc-muted">Join the public relay or point Obelisk at another NIP-29 community.</p>
            <Link href="/app" className="lc-pill lc-pill-primary mt-8 inline-flex px-10 py-3.5 text-base">Launch the app</Link>
          </div>
        </section>
        <Footer />
      </div>
    </main>
  );
}
