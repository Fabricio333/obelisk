import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Inter: () => ({ className: 'inter' }),
}));

import { metadata } from './layout';

describe('root social metadata', () => {
  it('uses the static Open Graph image', () => {
    expect(metadata.openGraph?.images).toEqual([{
      url: '/og/obelisk.png?v=2',
      width: 1200,
      height: 630,
      type: 'image/png',
      alt: 'Obelisk — Group chat powered by Nostr identity',
    }]);
    expect(metadata.twitter?.images).toEqual(['/og/obelisk.png?v=2']);
  });
});
