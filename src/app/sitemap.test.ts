import { describe, it, expect, beforeAll } from 'vitest';
import sitemap from './sitemap';
import { snapshotPaths } from '@/components/guides/svg/asset-meta';

let entries: Awaited<ReturnType<typeof sitemap>>;

function isArticleEntry(url: string) {
  // article URLs: /guides/<slug> (en) or /guides/es/<slug> — slug must not be the bare locale 'es'.
  if (!url.includes('/guides/')) return false;
  if (url.endsWith('/guides') || url.endsWith('/guides/es')) return false;
  return true;
}

beforeAll(async () => {
  entries = await sitemap();
});

describe('sitemap.images (Google image-sitemap extension)', () => {
  it('includes public feature and help pages', () => {
    expect(entries.some((e) => e.url.endsWith('/features'))).toBe(true);
    expect(entries.some((e) => e.url.endsWith('/help'))).toBe(true);
  });

  it('every guide article entry declares at least one image', () => {
    const articleEntries = entries.filter((e) => isArticleEntry(e.url));
    expect(articleEntries.length).toBeGreaterThan(0);
    for (const e of articleEntries) {
      expect(e.images).toBeDefined();
      expect(Array.isArray(e.images)).toBe(true);
      expect((e.images ?? []).length).toBeGreaterThan(0);
    }
  });

  it('the swap-anything guide declares both its hero and inline diagram', () => {
    const en = entries.find((e) => e.url.endsWith('/guides/swap-anything'));
    expect(en).toBeDefined();
    const imgs = en!.images ?? [];
    expect(imgs.some((u) => u.endsWith(snapshotPaths('swap-anything').png))).toBe(true);
    expect(imgs.some((u) => u.endsWith(snapshotPaths('swap-matrix').png))).toBe(true);
  });

  it('image URLs are absolute (start with the site origin)', () => {
    const articleEntries = entries.filter((e) => isArticleEntry(e.url));
    for (const e of articleEntries) {
      for (const url of e.images ?? []) {
        expect(url.startsWith('http')).toBe(true);
      }
    }
  });
});
