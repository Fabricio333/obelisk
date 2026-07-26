import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {},
  useConfiguredRelays: () => [],
  useCurrentRelayUrl: () => '',
  useMyPubkey: () => null,
}));

vi.mock('@/lib/read-state/selectors', () => ({ useHasAnyHighlights: () => false }));

import ServerRail from './ServerRail';

describe('ServerRail', () => {
  it('leaves its background transparent for the animated app backdrop', () => {
    render(<ServerRail mode={{ kind: 'dm' }} onPickDM={() => {}} onPickRelay={() => {}} />);

    const rail = screen.getByTitle('Direct messages').parentElement;
    expect(rail).not.toHaveClass('bg-lc-black');
  });
});
