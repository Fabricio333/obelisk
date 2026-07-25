import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sw = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');

describe('service worker cache policy', () => {
  it('caches only safe same-origin app shell and static assets', () => {
    expect(sw).toContain("const CACHE_VERSION = 'obelisk-v7-static-shell-cache'");
    expect(sw).toContain("const STATIC_CACHE = `${CACHE_VERSION}:static`");
    expect(sw).toContain("const SHELL_CACHE = `${CACHE_VERSION}:shell`");
    expect(sw).toContain("const APP_SHELL_KEY = '/app'");
    expect(sw).toContain("url.pathname.startsWith('/_next/static/')");
    expect(sw).toContain("url.pathname === '/manifest.webmanifest'");
    expect(sw).toContain('PUBLIC_ASSET_RE.test(url.pathname)');
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain('isAppShellNavigation(url)');
  });

  it('does not cache auth/session/storage/API routes or non-GET traffic', () => {
    expect(sw).toContain("if (request.method !== 'GET') return true");
    expect(sw).toContain('if (!sameOrigin(url)) return true');
    expect(sw).toContain("if (url.pathname === '/sw.js') return true");
    expect(sw).toContain("if (url.pathname.startsWith('/_next/data/')) return true");
    expect(sw).toContain('const BYPASS_PATH_RE = /(?:^|\\/)(?:api|auth|session|storage)(?:\\/|$)/i');
    expect(sw).not.toMatch(/\blocalStorage\./);
    expect(sw).not.toMatch(/\bindexedDB\./);
  });

  it('uses cache-first assets and network-first navigation fallback', () => {
    expect(sw).toContain('event.waitUntil(fetchAndCache(event.request, cache).catch(() => undefined))');
    expect(sw).toContain('const response = await fetch(event.request)');
    expect(sw).toContain('await putIfCacheable(cache, APP_SHELL_KEY, response)');
    expect(sw).toContain('const cached = await cache.match(APP_SHELL_KEY) || await caches.match(APP_SHELL_KEY)');
  });
});
