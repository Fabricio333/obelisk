import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Inter: () => ({ className: 'inter' }),
}));

import { metadata } from './layout';

describe('root social metadata', () => {
  it('uses the static Open Graph image', () => {
    expect(metadata.openGraph?.images).toEqual(['/og/obelisk.png']);
    expect(metadata.twitter?.images).toEqual(['/og/obelisk.png']);
  });
});
