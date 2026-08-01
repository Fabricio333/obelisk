import { describe, expect, it, vi } from 'vitest';

vi.mock('html-to-image', () => ({ toPng: vi.fn() }));
vi.mock('next/image', () => ({ default: () => null }));

import { ASSETS } from './MediaKit';

describe('media kit assets', () => {
  it('no longer offers the deprecated /obelisk.png artwork', () => {
    expect(ASSETS.map((asset) => asset.src)).not.toContain('/obelisk.png');
  });

  it('serves the shipped icon as the downloadable logo', () => {
    const logo = ASSETS.find((asset) => asset.label === 'Obelisk Logo (PNG)');
    expect(logo?.src).toBe('/icon-512.png');
    expect(logo?.download).toBe('obelisk-logo.png');
  });

  it('lists every asset once', () => {
    const sources = ASSETS.map((asset) => asset.src);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
