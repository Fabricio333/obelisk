import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nip19 } from 'nostr-tools';

const metaByPubkey: Record<string, { displayName?: string; name?: string } | null> = {};

vi.mock('@/lib/nostr-bridge', () => ({
  useGroupMemberInfo: () => [],
  useMediaPacks: () => ({}),
  useUserMetadata: (pubkey: string | null) => (pubkey ? metaByPubkey[pubkey] ?? null : null),
}));

import MessageContent from './MessageContent';

const PUBKEY = 'd'.repeat(64);
const NPUB = nip19.npubEncode(PUBKEY);

describe('MessageContent mention names', () => {
  beforeEach(() => {
    for (const k of Object.keys(metaByPubkey)) delete metaByPubkey[k];
  });

  it('renders a mention as @DisplayName, never the raw npub', () => {
    metaByPubkey[PUBKEY] = { displayName: 'Fabricio' };

    render(<MessageContent content={`hey nostr:${NPUB} look`} />);

    const chip = screen.getByTestId('mention-highlight');
    expect(chip).toHaveTextContent('@Fabricio');
    expect(screen.queryByText(new RegExp(NPUB))).not.toBeInTheDocument();
  });

  it('resolves the name even when the user is not a member of this channel', () => {
    // Regression: `parseMentions` only knows the channel member list, so a
    // non-member mention fell back to `shortNpub` and shipped `@npub16dew…`
    // into the message body. The bridge's kind:0 cache knows them anyway.
    metaByPubkey[PUBKEY] = { name: 'satoshi' };

    render(<MessageContent content={`nostr:${NPUB}`} />);

    expect(screen.getByTestId('mention-highlight')).toHaveTextContent('@satoshi');
  });

  it('prefers displayName over name', () => {
    metaByPubkey[PUBKEY] = { displayName: 'Fabricio Acosta', name: 'fabri' };

    render(<MessageContent content={`nostr:${NPUB}`} />);

    expect(screen.getByTestId('mention-highlight')).toHaveTextContent('@Fabricio Acosta');
  });

  it('falls back to the short npub only when no profile is known at all', () => {
    // Still prefixed with @ and still a chip — it degrades, it does not
    // regress to raw `nostr:npub…` body text.
    render(<MessageContent content={`nostr:${NPUB}`} />);

    const chip = screen.getByTestId('mention-highlight');
    expect(chip.textContent?.startsWith('@')).toBe(true);
    expect(chip.textContent).not.toContain(`nostr:${NPUB}`);
  });
});
