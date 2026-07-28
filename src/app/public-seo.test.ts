import { describe, expect, it } from 'vitest';
import { metadata as features } from './features/page';
import { metadata as help } from './help/layout';

describe('public page SEO metadata', () => {
  it.each([
    ['features', features, '/features'],
    ['help', help, '/help'],
  ])('%s has unique canonical and social metadata', (_name, metadata, canonical) => {
    expect(metadata.title).toBeTruthy();
    expect(metadata.description).toBeTruthy();
    expect(metadata.alternates?.canonical).toBe(canonical);
    expect(metadata.openGraph?.images).toBeTruthy();
    expect(metadata.twitter?.images).toBeTruthy();
  });
});
