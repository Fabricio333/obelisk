'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { toPng } from 'html-to-image';

type Color = { name: string; token: string; hex: string; usage: string };

const COLORS: Color[] = [
  { name: 'Black', token: 'lc-black', hex: '#0a0a0a', usage: 'Background' },
  { name: 'Dark', token: 'lc-dark', hex: '#171717', usage: 'Cards' },
  { name: 'Border', token: 'lc-border', hex: '#262626', usage: 'Dividers' },
  { name: 'Muted', token: 'lc-muted', hex: '#a3a3a3', usage: 'Secondary text' },
  { name: 'White', token: 'lc-white', hex: '#fafafa', usage: 'Primary text' },
  { name: 'Green', token: 'lc-green', hex: '#b4f953', usage: 'Accent / CTA' },
];

const COPY = {
  name: 'Obelisk',
  tagline: 'Group chat powered by Nostr identity',
  taglineEs: 'Chat grupal con identidad Nostr',
  shortPitch:
    'Obelisk is a Discord-style group chat where identity comes from your Nostr keypair. No emails, no passwords — cryptographic identity only.',
  shortPitchEs:
    'Obelisk es un chat grupal estilo Discord donde la identidad viene de tu llave Nostr. Sin emails, sin contraseñas — solo identidad criptográfica.',
  oneLiner: 'No emails. No passwords. Cryptographic identity.',
  oneLinerEs: 'Sin emails. Sin contraseñas. Identidad criptográfica.',
  longPitch:
    'Obelisk is a fully relay-only group chat application built on Nostr. It implements NIP-29 for groups, NIP-04/NIP-17 for direct messages, P2P and SFU voice via WebRTC signaled over Nostr, and Lightning payments via NIP-47 (Nostr Wallet Connect). No backend, no database: the client talks directly to relays.',
  longPitchEs:
    'Obelisk es una aplicación de chat grupal completamente sobre relays Nostr. Implementa NIP-29 para grupos, NIP-04/NIP-17 para mensajes directos, voz P2P y SFU vía WebRTC señalizado por Nostr, y pagos Lightning vía NIP-47 (Nostr Wallet Connect). Sin backend, sin base de datos: el cliente habla directamente con los relays.',
};

const LINKS = {
  site: 'https://obelisk.ar',
  github: 'https://github.com/Fabricio333/obelisk',
  defaultRelay: 'wss://public.obelisk.ar',
};

const ASSETS = [
  {
    src: '/obelisk.png',
    label: 'Obelisk Logo (PNG)',
    bg: 'bg-lc-black',
    download: 'obelisk.png',
  },
  {
    src: '/obelisk-favicon.png',
    label: 'Favicon (PNG)',
    bg: 'bg-lc-black',
    download: 'obelisk-favicon.png',
  },
  {
    src: '/icon-192.png',
    label: 'App Icon — 192px (PNG)',
    bg: 'bg-lc-black',
    download: 'icon-192.png',
  },
  {
    src: '/icon-512.png',
    label: 'App Icon — 512px (PNG)',
    bg: 'bg-lc-black',
    download: 'icon-512.png',
  },
  {
    src: '/obelisk.gif',
    label: 'Animated Obelisk (GIF)',
    bg: 'bg-lc-black',
    download: 'obelisk.gif',
  },
  {
    src: '/obelisk-lg.gif',
    label: 'Animated Obelisk — Large',
    bg: 'bg-lc-black',
    download: 'obelisk-lg.gif',
  },
  {
    src: '/obelisk-md.gif',
    label: 'Animated Obelisk — Medium',
    bg: 'bg-lc-black',
    download: 'obelisk-md.gif',
  },
  {
    src: '/obelisk-sm.gif',
    label: 'Animated Obelisk — Small',
    bg: 'bg-lc-black',
    download: 'obelisk-sm.gif',
  },
  {
    src: '/lacrypta-logo.png',
    label: 'La Crypta Logo (PNG)',
    bg: 'bg-lc-black',
    download: 'lacrypta-logo.png',
  },
  {
    src: '/lacrypta-banner.png',
    label: 'La Crypta Banner (PNG)',
    bg: 'bg-lc-black',
    download: 'lacrypta-banner.png',
  },
  {
    src: '/nostr-wot-logo.png',
    label: 'Nostr WoT Logo (PNG)',
    bg: 'bg-lc-black',
    download: 'nostr-wot-logo.png',
  },
  {
    src: '/nostr-wot-logo.svg',
    label: 'Nostr WoT Logo (SVG)',
    bg: 'bg-lc-black',
    download: 'nostr-wot-logo.svg',
  },
  {
    src: '/nostr-wot-logo-clean.png',
    label: 'Nostr WoT Logo — Clean (PNG)',
    bg: 'bg-lc-black',
    download: 'nostr-wot-logo-clean.png',
  },
];

const OG_IMAGE_URL = '/og/obelisk.png';

const EMBED_HTML_BANNER = `<a href="https://obelisk.ar" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none;font-family:Inter,system-ui,sans-serif;background:#0a0a0a;border:1px solid #262626;border-radius:12px;padding:14px 20px;color:#fafafa;">
  <span style="display:flex;align-items:center;gap:12px;">
    <span style="display:inline-block;width:10px;height:10px;border-radius:9999px;background:#b4f953;box-shadow:0 0 12px #b4f953;"></span>
    <span style="font-weight:700;letter-spacing:-0.01em;">Obelisk</span>
    <span style="color:#a3a3a3;">— Group chat powered by Nostr identity</span>
  </span>
</a>`;

const EMBED_BADGE = `<a href="https://obelisk.ar" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#b4f953;color:#0a0a0a;font-family:Inter,system-ui,sans-serif;font-weight:700;font-size:13px;border-radius:9999px;text-decoration:none;">
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2 L8 8 L7 22 H17 L16 8 Z"/></svg>
  Powered by Obelisk
</a>`;

const EMBED_OG = `<!-- Add to <head> for sharing previews -->
<meta property="og:title" content="Obelisk — Group chat powered by Nostr identity" />
<meta property="og:description" content="No emails. No passwords. Cryptographic identity." />
<meta property="og:image" content="https://obelisk.ar/og/obelisk.png" />
<meta property="og:url" content="https://obelisk.ar" />
<meta name="twitter:card" content="summary_large_image" />`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="lc-pill-secondary text-xs px-3 py-1"
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-6">
        <h2 className="text-2xl sm:text-3xl font-bold text-lc-white tracking-tight">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-sm sm:text-base text-lc-muted max-w-3xl">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="lc-card overflow-x-auto p-4 text-xs sm:text-sm text-lc-white whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
      <div className="absolute top-3 right-3">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

// Obelisk silhouette — same artwork as /og/obelisk.png so banners stay
// visually identical to the share preview.
function ObeliskMark({
  width = '100%',
  height = '100%',
  style,
}: {
  width?: number | string;
  height?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={width}
      height={height}
      preserveAspectRatio="xMidYMid meet"
      style={style}
      aria-hidden
    >
      <path
        d="M 256,16 L 220,72 L 196,460 L 200,464 L 256,464 L 256,72 Z"
        fill="#a3a3a3"
        opacity={0.7}
      />
      <path
        d="M 256,16 L 292,72 L 316,460 L 312,464 L 256,464 L 256,72 Z"
        fill="#fafafa"
      />
    </svg>
  );
}

const GRID_OVERLAY: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(rgba(180,249,83,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(180,249,83,0.04) 1px, transparent 1px)',
  backgroundSize: '40px 40px',
};

const GLOW_GRADIENT =
  'radial-gradient(circle, rgba(180,249,83,0.35) 0%, rgba(180,249,83,0.1) 40%, transparent 70%)';

// --- Banner compositions ---------------------------------------------------

function HeroBanner() {
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: '1200 / 630',
        background:
          'radial-gradient(circle at 50% 30%, #1a2a10 0%, #0a0a0a 60%)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={GRID_OVERLAY}
      />
      {/* Glow halo */}
      <div
        className="absolute rounded-full"
        style={{
          width: '28%',
          aspectRatio: '1',
          top: '12.7%',
          left: '50%',
          transform: 'translateX(-50%)',
          background: GLOW_GRADIENT,
        }}
      />
      {/* Green orb */}
      <div
        className="absolute rounded-full"
        style={{
          width: '10.8%',
          aspectRatio: '1',
          top: '22.2%',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#b4f953',
          boxShadow: '0 0 60px rgba(180,249,83,0.5)',
        }}
      />
      {/* Obelisk piercing the orb (apex sits inside the orb) */}
      <div
        className="absolute"
        style={{
          width: '23.3%',
          aspectRatio: '1',
          top: '23%',
          left: '50%',
          transform: 'translateX(-50%)',
        }}
      >
        <ObeliskMark />
      </div>
      {/* Title */}
      <div
        className="absolute flex flex-col items-center w-full"
        style={{ top: '69%' }}
      >
        <span className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight">
          Obelisk
        </span>
        <span className="mt-1 text-lc-muted text-xs sm:text-sm md:text-base lg:text-lg">
          {COPY.tagline}
        </span>
      </div>
      <p
        className="absolute text-center text-lc-green font-semibold text-[10px] sm:text-xs md:text-sm w-full"
        style={{ bottom: '5.7%' }}
      >
        {COPY.oneLiner}
      </p>
    </div>
  );
}

// Reusable horizontal "obelisk inside green orb" composition for short-height
// banners — column on the left, text on the right.
function HorizontalBanner({
  aspect,
  columnLeft,
  columnWidth,
  textLeft,
  bgGradient,
  titleClass,
  taglineClass,
  oneLinerClass,
  showOneLiner = true,
}: {
  aspect: string;
  columnLeft: string;
  columnWidth: string;
  textLeft: string;
  bgGradient: string;
  titleClass: string;
  taglineClass: string;
  oneLinerClass: string;
  showOneLiner?: boolean;
}) {
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{ aspectRatio: aspect, background: bgGradient }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={GRID_OVERLAY}
      />
      {/* Composition column */}
      <div
        className="absolute"
        style={{
          left: columnLeft,
          top: 0,
          height: '100%',
          width: columnWidth,
        }}
      >
        {/* Glow */}
        <div
          className="absolute rounded-full"
          style={{
            height: '120%',
            aspectRatio: '1',
            top: '-10%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: GLOW_GRADIENT,
          }}
        />
        {/* Orb */}
        <div
          className="absolute rounded-full"
          style={{
            height: '36%',
            aspectRatio: '1',
            top: '20%',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#b4f953',
            boxShadow: '0 0 50px rgba(180,249,83,0.5)',
          }}
        />
        {/* Obelisk piercing the orb */}
        <div
          className="absolute"
          style={{
            height: '84%',
            aspectRatio: '1',
            top: '8%',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <ObeliskMark />
        </div>
      </div>
      {/* Text */}
      <div
        className="absolute"
        style={{ left: textLeft, top: '50%', transform: 'translateY(-50%)' }}
      >
        <div className={`font-extrabold tracking-tight ${titleClass}`}>
          Obelisk
        </div>
        <div className={`mt-1 text-lc-muted ${taglineClass}`}>
          {COPY.tagline}
        </div>
        {showOneLiner && (
          <div
            className={`mt-3 text-lc-green font-semibold ${oneLinerClass}`}
          >
            {COPY.oneLiner}
          </div>
        )}
      </div>
    </div>
  );
}

function XHeaderBanner() {
  return (
    <HorizontalBanner
      aspect="1500 / 500"
      columnLeft="6%"
      columnWidth="22%"
      textLeft="34%"
      bgGradient="radial-gradient(ellipse at 18% 50%, #1a2a10 0%, #0a0a0a 60%)"
      titleClass="text-3xl sm:text-5xl md:text-6xl lg:text-7xl"
      taglineClass="text-xs sm:text-base md:text-xl lg:text-2xl"
      oneLinerClass="text-[10px] sm:text-xs md:text-sm lg:text-base"
    />
  );
}

function LinkedInBanner() {
  return (
    <HorizontalBanner
      aspect="1584 / 396"
      columnLeft="6%"
      columnWidth="18%"
      textLeft="29%"
      bgGradient="radial-gradient(ellipse at 16% 50%, #1a2a10 0%, #0a0a0a 60%)"
      titleClass="text-2xl sm:text-4xl md:text-5xl lg:text-6xl"
      taglineClass="text-[10px] sm:text-sm md:text-lg lg:text-xl"
      oneLinerClass="text-[9px] sm:text-xs md:text-sm"
      showOneLiner={false}
    />
  );
}

// GitHub social preview is 1280 × 640 — basically the OG composition with
// slightly different aspect, so we reuse the hero composition.
function GitHubSocialBanner() {
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: '1280 / 640',
        background:
          'radial-gradient(circle at 50% 30%, #1a2a10 0%, #0a0a0a 60%)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={GRID_OVERLAY}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: '28%',
          aspectRatio: '1',
          top: '10%',
          left: '50%',
          transform: 'translateX(-50%)',
          background: GLOW_GRADIENT,
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: '10.5%',
          aspectRatio: '1',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#b4f953',
          boxShadow: '0 0 60px rgba(180,249,83,0.5)',
        }}
      />
      <div
        className="absolute"
        style={{
          width: '22%',
          aspectRatio: '1',
          top: '21%',
          left: '50%',
          transform: 'translateX(-50%)',
        }}
      >
        <ObeliskMark />
      </div>
      <div
        className="absolute flex flex-col items-center w-full"
        style={{ top: '67%' }}
      >
        <span className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight">
          Obelisk
        </span>
        <span className="mt-1 text-lc-muted text-xs sm:text-sm md:text-base lg:text-lg">
          {COPY.tagline}
        </span>
      </div>
      <p
        className="absolute text-center text-lc-green font-semibold text-[10px] sm:text-xs md:text-sm w-full"
        style={{ bottom: '6%' }}
      >
        {COPY.oneLiner}
      </p>
    </div>
  );
}

// Square 1080×1080 for Instagram / Mastodon avatars or post thumbnails.
function SquareBanner() {
  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: '1 / 1',
        background:
          'radial-gradient(circle at 50% 35%, #1a2a10 0%, #0a0a0a 60%)',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={GRID_OVERLAY}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: '54%',
          aspectRatio: '1',
          top: '12%',
          left: '50%',
          transform: 'translateX(-50%)',
          background: GLOW_GRADIENT,
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          width: '20%',
          aspectRatio: '1',
          top: '22%',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#b4f953',
          boxShadow: '0 0 60px rgba(180,249,83,0.5)',
        }}
      />
      <div
        className="absolute"
        style={{
          width: '42%',
          aspectRatio: '1',
          top: '23%',
          left: '50%',
          transform: 'translateX(-50%)',
        }}
      >
        <ObeliskMark />
      </div>
      <div
        className="absolute flex flex-col items-center w-full"
        style={{ top: '70%' }}
      >
        <span className="text-3xl sm:text-5xl md:text-6xl font-extrabold tracking-tight">
          Obelisk
        </span>
        <span className="mt-1 text-lc-muted text-xs sm:text-sm md:text-base">
          {COPY.tagline}
        </span>
      </div>
      <p
        className="absolute text-center text-lc-green font-semibold text-[10px] sm:text-xs md:text-sm w-full"
        style={{ bottom: '6%' }}
      >
        {COPY.oneLiner}
      </p>
    </div>
  );
}

// Rasterize a DOM node to PNG and trigger a download. `pixelWidth` lets us
// upscale to the banner's intended export size regardless of how wide the
// preview is rendered on screen.
function DownloadPngButton({
  targetRef,
  filename,
  pixelWidth,
  label = 'Download PNG',
}: {
  targetRef: React.RefObject<HTMLElement | null>;
  filename: string;
  pixelWidth?: number;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        const node = targetRef.current;
        if (!node) return;
        setBusy(true);
        try {
          const rect = node.getBoundingClientRect();
          const pixelRatio = pixelWidth
            ? Math.max(1, pixelWidth / rect.width)
            : 2;
          const dataUrl = await toPng(node, {
            pixelRatio,
            cacheBust: true,
            backgroundColor: '#0a0a0a',
          });
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally {
          setBusy(false);
        }
      }}
      className="lc-pill-primary text-xs px-3 py-1 disabled:opacity-60"
    >
      {busy ? 'Rendering…' : label}
    </button>
  );
}

function BannerCard({
  title,
  spec,
  children,
  filename,
  pixelWidth,
  extra,
}: {
  title: string;
  spec: string;
  filename: string;
  pixelWidth?: number;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="lc-card overflow-hidden">
      <div ref={ref}>{children}</div>
      <div className="border-t border-lc-border p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-lc-muted">
        <span>
          <span className="text-lc-white font-semibold">{title}</span> · {spec}
        </span>
        <div className="flex items-center gap-2">
          {extra}
          <DownloadPngButton
            targetRef={ref}
            filename={filename}
            pixelWidth={pixelWidth}
          />
        </div>
      </div>
    </div>
  );
}

function EmbedPreview({
  title,
  html,
  filename,
  pixelWidth,
}: {
  title: string;
  html: string;
  filename: string;
  pixelWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        <DownloadPngButton
          targetRef={ref}
          filename={filename}
          pixelWidth={pixelWidth}
        />
      </div>
      <div className="lc-card p-6 mb-3 flex justify-center">
        <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <CodeBlock code={html} />
    </div>
  );
}

export default function MediaKit() {
  return (
    <main className="min-h-screen bg-lc-black text-lc-white">
      {/* Hero */}
      <header className="border-b border-lc-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-20">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-lc-green">
            <span className="inline-block w-2 h-2 rounded-full bg-lc-green lc-glow" />
            Press &amp; Media
          </div>
          <h1 className="mt-4 text-4xl sm:text-6xl font-extrabold tracking-tight">
            Obelisk Media Kit
          </h1>
          <p className="mt-4 max-w-2xl text-base sm:text-lg text-lc-muted">
            Logos, banners, icons, palette and copy ready to use. Everything
            you need to write about, embed or share Obelisk.
          </p>

          <nav className="mt-8 flex flex-wrap gap-2 text-sm">
            {[
              ['#about', 'About Obelisk'],
              ['#logos', 'Logos & icons'],
              ['#banners', 'Banners'],
              ['#colors', 'Colors'],
              ['#typography', 'Typography'],
              ['#copy', 'Copy'],
              ['#embeds', 'HTML embeds'],
              ['#og', 'Open Graph'],
              ['#contact', 'Contact'],
              ['#guidelines', 'Guidelines'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="lc-pill-secondary px-3 py-1"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 space-y-16">
        {/* About */}
        <Section
          id="about"
          title="About Obelisk"
          description="Short and long pitch — English and Spanish, ready to copy."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="lc-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-lc-green">
                  EN — Short pitch
                </span>
                <CopyButton text={COPY.shortPitch} />
              </div>
              <p className="text-sm text-lc-white">{COPY.shortPitch}</p>
            </div>
            <div className="lc-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-lc-green">
                  ES — Pitch corto
                </span>
                <CopyButton text={COPY.shortPitchEs} />
              </div>
              <p className="text-sm text-lc-white">{COPY.shortPitchEs}</p>
            </div>
            <div className="lc-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-lc-green">
                  EN — Long pitch
                </span>
                <CopyButton text={COPY.longPitch} />
              </div>
              <p className="text-sm text-lc-white">{COPY.longPitch}</p>
            </div>
            <div className="lc-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-widest text-lc-green">
                  ES — Pitch largo
                </span>
                <CopyButton text={COPY.longPitchEs} />
              </div>
              <p className="text-sm text-lc-white">{COPY.longPitchEs}</p>
            </div>
          </div>
        </Section>

        {/* Logos */}
        <Section
          id="logos"
          title="Logos & icons"
          description="Right-click → Save image as… or use the Download button."
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ASSETS.map((a) => (
              <div key={a.src} className="lc-card overflow-hidden">
                <div
                  className={`${a.bg} flex items-center justify-center p-6 h-48`}
                >
                  <Image
                    src={a.src}
                    alt={a.label}
                    width={180}
                    height={180}
                    className="max-h-full max-w-full object-contain"
                    unoptimized
                  />
                </div>
                <div className="border-t border-lc-border p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {a.label}
                    </div>
                    <div className="text-xs text-lc-muted truncate">
                      {a.src}
                    </div>
                  </div>
                  <a
                    href={a.src}
                    download={a.download}
                    className="lc-pill-primary text-xs px-3 py-1 shrink-0"
                  >
                    Download
                  </a>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Banners */}
        <Section
          id="banners"
          title="Banners"
          description="Banners rendered in HTML/CSS — copy the snippets, screenshot them, or use the linked PNGs."
        >
          <div className="space-y-6">
            <BannerCard
              title="Hero / Open Graph"
              spec="1200 × 630 — share preview"
              filename="obelisk-hero-1200x630.png"
              pixelWidth={1200}
              extra={
                <a
                  href={OG_IMAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lc-pill-secondary px-3 py-1"
                >
                  Open OG PNG
                </a>
              }
            >
              <HeroBanner />
            </BannerCard>

            <BannerCard
              title="X (Twitter) header"
              spec="1500 × 500 — profile cover (3:1)"
              filename="obelisk-x-header-1500x500.png"
              pixelWidth={1500}
            >
              <XHeaderBanner />
            </BannerCard>

            <BannerCard
              title="LinkedIn cover"
              spec="1584 × 396 — profile background (4:1)"
              filename="obelisk-linkedin-1584x396.png"
              pixelWidth={1584}
            >
              <LinkedInBanner />
            </BannerCard>

            <BannerCard
              title="GitHub social preview"
              spec="1280 × 640 — repository preview"
              filename="obelisk-github-1280x640.png"
              pixelWidth={1280}
            >
              <GitHubSocialBanner />
            </BannerCard>

            <BannerCard
              title="Square / Instagram"
              spec="1080 × 1080 — post or avatar"
              filename="obelisk-square-1080x1080.png"
              pixelWidth={1080}
            >
              <SquareBanner />
            </BannerCard>

            {/* Wide pill — footer / sponsor row */}
            <BannerCard
              title="Wide pill"
              spec="footer / sponsor row"
              filename="obelisk-wide-pill.png"
              pixelWidth={1600}
            >
              <div className="flex items-center gap-4 p-6 sm:p-8 bg-lc-black">
                <div className="shrink-0 w-12 h-12 rounded-full bg-lc-green flex items-center justify-center text-lc-black font-extrabold">
                  ◊
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-lc-white font-bold text-lg">
                    Obelisk
                  </div>
                  <div className="text-lc-muted text-sm truncate">
                    {COPY.tagline}
                  </div>
                </div>
                <a
                  href={LINKS.site}
                  className="lc-pill-primary px-4 py-2 text-sm hidden sm:inline-block"
                >
                  Open app →
                </a>
              </div>
            </BannerCard>

            {/* Minimal mono — for print / merch */}
            <BannerCard
              title="Minimal mono"
              spec="for print / merch"
              filename="obelisk-minimal-mono.png"
              pixelWidth={1600}
            >
              <div className="p-10 sm:p-14 bg-lc-white text-lc-black text-center">
                <div className="text-3xl sm:text-5xl font-extrabold tracking-tight">
                  OBELISK
                </div>
                <div className="mt-2 text-xs sm:text-sm uppercase tracking-[0.4em] text-neutral-600">
                  Nostr-native group chat
                </div>
              </div>
            </BannerCard>
          </div>
        </Section>

        {/* Colors */}
        <Section
          id="colors"
          title="Palette — La Crypta"
          description="Design-system tokens. Tap the HEX to copy it."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COLORS.map((c) => (
              <div key={c.token} className="lc-card overflow-hidden">
                <div
                  className="h-24 border-b border-lc-border"
                  style={{ backgroundColor: c.hex }}
                />
                <div className="p-4 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    <div className="text-xs text-lc-muted">
                      {c.token} · {c.usage}
                    </div>
                  </div>
                  <CopyButton text={c.hex} />
                </div>
                <div className="px-4 pb-4 -mt-2 text-xs text-lc-muted font-mono">
                  {c.hex}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Typography */}
        <Section
          id="typography"
          title="Typography"
          description="System UI / Inter for everything. Weights: 400, 600, 700, 800."
        >
          <div className="lc-card p-6 space-y-4">
            <div className="text-5xl font-extrabold tracking-tight">
              Aa — Obelisk
            </div>
            <div className="text-2xl font-bold">
              Heading · 700 · tracking-tight
            </div>
            <div className="text-base">Body · 400 · text-lc-white</div>
            <div className="text-sm text-lc-muted">
              Muted · 400 · text-lc-muted — used for secondary descriptions
            </div>
            <div className="text-xs uppercase tracking-widest text-lc-green">
              Eyebrow · uppercase · tracking-widest · lc-green
            </div>
          </div>
        </Section>

        {/* Copy */}
        <Section
          id="copy"
          title="Short copy"
          description="Quick-use phrases."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ['Name', COPY.name],
              ['Tagline (EN)', COPY.tagline],
              ['Tagline (ES)', COPY.taglineEs],
              ['One-liner (EN)', COPY.oneLiner],
              ['One-liner (ES)', COPY.oneLinerEs],
              ['URL', LINKS.site],
              ['Default relay', LINKS.defaultRelay],
              ['GitHub', LINKS.github],
            ].map(([label, value]) => (
              <div
                key={label}
                className="lc-card p-4 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-widest text-lc-green">
                    {label}
                  </div>
                  <div className="text-sm truncate">{value}</div>
                </div>
                <CopyButton text={value} />
              </div>
            ))}
          </div>
        </Section>

        {/* Embeds */}
        <Section
          id="embeds"
          title="HTML embeds"
          description="Paste these snippets anywhere to link to Obelisk with style."
        >
          <div className="space-y-6">
            <EmbedPreview
              title="Banner pill"
              html={EMBED_HTML_BANNER}
              filename="obelisk-banner-pill.png"
              pixelWidth={1200}
            />
            <EmbedPreview
              title='"Powered by Obelisk" badge'
              html={EMBED_BADGE}
              filename="obelisk-powered-by-badge.png"
              pixelWidth={600}
            />
          </div>
        </Section>

        {/* OG */}
        <Section
          id="og"
          title="Open Graph"
          description="Runtime-generated share preview and ready-to-paste meta tags."
        >
          <div className="lc-card overflow-hidden mb-4">
            <div className="aspect-[1200/630] relative bg-lc-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={OG_IMAGE_URL}
                alt="Open Graph preview"
                className="absolute inset-0 w-full h-full object-cover"
              />
            </div>
            <div className="border-t border-lc-border p-3 flex items-center justify-between text-xs text-lc-muted">
              <span>1200 × 630 · /og/obelisk.png</span>
              <a
                href={OG_IMAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="lc-pill-secondary px-3 py-1"
              >
                Open in new tab
              </a>
            </div>
          </div>
          <CodeBlock code={EMBED_OG} />
        </Section>

        {/* Contact */}
        <Section
          id="contact"
          title="Contact &amp; links"
          description="Where to find us if you need anything else for a story or integration."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <a
              href={LINKS.site}
              target="_blank"
              rel="noopener noreferrer"
              className="lc-card p-5 hover:border-lc-green transition-colors"
            >
              <div className="text-xs uppercase tracking-widest text-lc-green mb-1">
                Website
              </div>
              <div className="text-sm text-lc-white truncate">
                {LINKS.site}
              </div>
            </a>
            <a
              href={LINKS.github}
              target="_blank"
              rel="noopener noreferrer"
              className="lc-card p-5 hover:border-lc-green transition-colors"
            >
              <div className="text-xs uppercase tracking-widest text-lc-green mb-1">
                GitHub
              </div>
              <div className="text-sm text-lc-white truncate">
                {LINKS.github}
              </div>
            </a>
            <div className="lc-card p-5">
              <div className="text-xs uppercase tracking-widest text-lc-green mb-1">
                Default relay
              </div>
              <div className="text-sm text-lc-white truncate font-mono">
                {LINKS.defaultRelay}
              </div>
            </div>
          </div>
        </Section>

        {/* Guidelines */}
        <Section
          id="guidelines"
          title="Brand guidelines"
          description="Simple rules to keep the brand consistent."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="lc-card p-5">
              <div className="text-lc-green font-semibold mb-2">✓ Do</div>
              <ul className="space-y-1 text-sm text-lc-white list-disc list-inside">
                <li>
                  Use the logo on dark backgrounds (#0a0a0a) whenever possible.
                </li>
                <li>
                  Respect the clear-space area: at least the symbol&apos;s
                  height around it.
                </li>
                <li>
                  Use lime green (#b4f953) only for accents and CTAs.
                </li>
                <li>
                  Write &quot;Obelisk&quot; with a capital O.
                </li>
              </ul>
            </div>
            <div className="lc-card p-5">
              <div className="text-red-400 font-semibold mb-2">✕ Don&apos;t</div>
              <ul className="space-y-1 text-sm text-lc-white list-disc list-inside">
                <li>Don&apos;t skew or rotate the logo.</li>
                <li>
                  Don&apos;t replace the green with other bright colors.
                </li>
                <li>
                  Don&apos;t place the logo on low-contrast backgrounds
                  (mid-grays).
                </li>
                <li>
                  Don&apos;t add your own shadows, outlines, or gradients.
                </li>
              </ul>
            </div>
          </div>
        </Section>

        <footer className="pt-8 border-t border-lc-border text-sm text-lc-muted flex flex-wrap items-center justify-between gap-3">
          <span>
            Need anything else? Open an issue or reach out via Nostr.
          </span>
          <Link href="/" className="lc-pill-secondary px-4 py-1">
            ← Back to home
          </Link>
        </footer>
      </div>
    </main>
  );
}
