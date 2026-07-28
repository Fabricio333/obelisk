export interface GuideAssetMeta {
  alt: string;
  width: number;
  height: number;
  /**
   * If set, snap-guide-svgs also writes `<name>-banner.png` rendered at this
   * width — for reuse as repo logos / social banners outside this project.
   */
  bannerWidth?: number;
}

export const HERO_ASSET_META: Record<string, GuideAssetMeta> = {
  'what-is-obelisk': {
    width: 800,
    height: 400,
    alt: 'Obelisk overview: an obelisk monument surrounded by orbiting Nostr keys and floating chat bubbles, illustrating a Discord-like group chat where identity is a Nostr keypair.',
  },
  'how-obelisk-works': {
    width: 800,
    height: 400,
    alt: 'How Obelisk works: a browser client, the Obelisk app, and Nostr relays connected by flowing data lines that show NIP-29 group messages travelling over the relay network.',
  },
  wot: {
    width: 800,
    height: 400,
    alt: 'Nostr Web of Trust graph for spam protection: your pubkey at the center, lime-green high-trust nodes connected through your follows, and red-outlined spam nodes pushed to the periphery.',
  },
  'future-relays': {
    width: 800,
    height: 400,
    alt: 'The future of Nostr: a mesh of relay-based groups exchanging encrypted NIP-29 messages with no central server, every relay equal.',
  },
  'bitcoin-zaps': {
    width: 800,
    height: 400,
    alt: 'Bitcoin Lightning zaps in chat: a chat message with a glowing lightning bolt flowing into it, orbited by satoshi particles, representing a zap sent over Nostr Wallet Connect (NIP-47).',
  },
  'admin-cli': {
    width: 800,
    height: 400,
    alt: 'Obelisk admin CLI for coding agents: a terminal streaming admin commands wired to an AI agent that signs Nostr challenges and publishes NIP-29 events to the relay.',
  },
  'swap-anything': {
    width: 800,
    height: 400,
    alt: 'The Obelisk ecosystem: one self-hostable Nostr relay connected to a chat client, a voice SFU, and a bot runtime — every component independently replaceable, nothing locked together.',
  },
  'obelisk-bots': {
    width: 800,
    height: 400,
    alt: 'Obelisk zap bot hero: a stylish robot with black sunglasses listening for Nostr zap receipts and group reactions, then posting signed kind 9 announcements into NIP-29 groups.',
  },
};

export const DIAGRAM_ASSET_META: Record<string, GuideAssetMeta> = {
  'wot-graph': {
    width: 800,
    height: 320,
    alt: 'Web of Trust score computation: how Obelisk derives a trust score for a Nostr pubkey by walking the follow graph from your own follows outward.',
  },
  'relay-groups': {
    width: 800,
    height: 360,
    alt: 'NIP-29 relay-based group: the relay holds the membership list (kind 39002), admin list (kind 39001), and message events (kind 9), and the client subscribes by group id.',
  },
  'zap-flow': {
    width: 900,
    height: 360,
    alt: 'Lightning Zap sequence on Obelisk: client requests a zap, the Obelisk server brokers NWC make-invoice and pay-invoice between the receiver and sender wallets, then publishes the ⚡ message to the chat.',
  },
  'swap-matrix': {
    width: 790,
    height: 352,
    alt: 'Obelisk swap matrix: every layer of the stack — client, voice, bots, relay — has independent alternatives, so any one component can be replaced without changing the others.',
  },
  'mark-dex': {
    width: 120,
    height: 120,
    bannerWidth: 1600,
    alt: 'obelisk-dex logo mark: a chat bubble containing the Obelisk monument, representing the browser chat client that signs Nostr events and posts them to a relay.',
  },
  'mark-sfu': {
    width: 120,
    height: 120,
    bannerWidth: 1600,
    alt: 'obelisk-sfu logo mark: a central voice mixer hub connected by spokes to five peers, representing the Selective Forwarding Unit that mixes streams for large group calls.',
  },
  'mark-bots': {
    width: 120,
    height: 120,
    bannerWidth: 1600,
    alt: 'obelisk-bots logo mark: a small robot head with an antenna, representing the bot runtime where each bot has its own Nostr keypair and posts messages like any user.',
  },
  'mark-relay': {
    width: 120,
    height: 120,
    bannerWidth: 1600,
    alt: 'obelisk-relay logo mark: a relay tower broadcasting concentric signal arcs, representing the self-hostable Nostr relay with built-in whitelisting and admin UI.',
  },
};

export function isHero(name: string): boolean {
  return name in HERO_ASSET_META;
}

export function getAssetMeta(name: string): GuideAssetMeta | undefined {
  return HERO_ASSET_META[name] ?? DIAGRAM_ASSET_META[name];
}

export function snapshotPaths(name: string): { svg: string; png: string } {
  return {
    svg: `/og/guides/${name}.svg`,
    png: `/og/guides/${name}.png`,
  };
}

export function listAssetNames(): string[] {
  return [...Object.keys(HERO_ASSET_META), ...Object.keys(DIAGRAM_ASSET_META)];
}
