import { describe, expect, it } from 'vitest';
import { buildSeedHistory, decideSnap, decideSwipeNav, decideTabPress, isAdjacentTabSwitch, NAV_ORDER, neighborsFor, resolveParent } from './swipe-nav';
import { initialNav, type NavState, type ScreenName } from './url-state';

const navOf = (screen: ScreenName, parentScreen: ScreenName | null = null): NavState => ({
  ...initialNav,
  screen,
  parentScreen,
});

describe('mobile swipe-nav', () => {
  describe('top-level screens cycle through NAV_ORDER', () => {
    it('swipe-left from server goes to dms-list', () => {
      expect(decideSwipeNav('server', false)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'forward',
      });
    });

    it('swipe-right from server is a no-op (already first tab)', () => {
      expect(decideSwipeNav('server', true)).toEqual({ kind: 'noop' });
    });

    it('swipe-right from dms-list goes back to server', () => {
      expect(decideSwipeNav('dms-list', true)).toEqual({
        kind: 'top-level',
        target: 'server',
        dir: 'back',
      });
    });

    it('swipe-left from inbox goes to settings-profile', () => {
      expect(decideSwipeNav('inbox', false)).toEqual({
        kind: 'top-level',
        target: 'settings-profile',
        dir: 'forward',
      });
    });

    it('swipe-left from settings-profile is a no-op (last tab)', () => {
      expect(decideSwipeNav('settings-profile', false)).toEqual({ kind: 'noop' });
    });
  });

  describe('sub-screens of server: horizontal swipe always switches tabs (skips parent)', () => {
    it('swipe-right from channel is a no-op (server parent is first tab)', () => {
      expect(decideSwipeNav('channel', true)).toEqual({ kind: 'noop' });
    });

    it('swipe-left from channel jumps to dms-list (past server parent)', () => {
      expect(decideSwipeNav('channel', false)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'forward',
      });
    });

    it('swipe-left from voice-room jumps to dms-list', () => {
      expect(decideSwipeNav('voice-room', false)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'forward',
      });
    });

    it('swipe-right from voice-room is a no-op', () => {
      expect(decideSwipeNav('voice-room', true)).toEqual({ kind: 'noop' });
    });

    it('swipe-left from forum jumps to dms-list', () => {
      expect(decideSwipeNav('forum', false)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'forward',
      });
    });

    it('swipe-right from forum is a no-op', () => {
      expect(decideSwipeNav('forum', true)).toEqual({ kind: 'noop' });
    });

    it('swipe-left from member-list jumps to dms-list', () => {
      expect(decideSwipeNav('member-list', false)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'forward',
      });
    });

    it('swipe-right from member-list is a no-op', () => {
      expect(decideSwipeNav('member-list', true)).toEqual({ kind: 'noop' });
    });
  });

  describe('sub-screens of dms-list', () => {
    it('swipe-right from dm-thread jumps to server (before dms-list parent)', () => {
      expect(decideSwipeNav('dm-thread', true)).toEqual({
        kind: 'top-level',
        target: 'server',
        dir: 'back',
      });
    });

    it('swipe-left from dm-thread jumps to inbox (past dms-list parent)', () => {
      expect(decideSwipeNav('dm-thread', false)).toEqual({
        kind: 'top-level',
        target: 'inbox',
        dir: 'forward',
      });
    });

    it('swipe-right from compose-dm jumps to server', () => {
      expect(decideSwipeNav('compose-dm', true)).toEqual({
        kind: 'top-level',
        target: 'server',
        dir: 'back',
      });
    });

    it('swipe-left from compose-dm jumps to inbox', () => {
      expect(decideSwipeNav('compose-dm', false)).toEqual({
        kind: 'top-level',
        target: 'inbox',
        dir: 'forward',
      });
    });
  });

  describe('settings-prefs is a sub of settings-profile (last tab)', () => {
    it('swipe-right jumps to inbox (before settings-profile parent)', () => {
      expect(decideSwipeNav('settings-prefs', true)).toEqual({
        kind: 'top-level',
        target: 'inbox',
        dir: 'back',
      });
    });

    it('swipe-left is a no-op (no tab past settings-profile)', () => {
      expect(decideSwipeNav('settings-prefs', false)).toEqual({ kind: 'noop' });
    });
  });

  describe('profile-edit is a sub of settings-profile', () => {
    it('swipe-right jumps to inbox', () => {
      expect(decideSwipeNav('profile-edit', true)).toEqual({
        kind: 'top-level',
        target: 'inbox',
        dir: 'back',
      });
    });

    it('swipe-left is a no-op (no tab past settings-profile)', () => {
      expect(decideSwipeNav('profile-edit', false)).toEqual({ kind: 'noop' });
    });

    it('neighbors: left = inbox, right = null', () => {
      expect(neighborsFor('profile-edit')).toEqual({ left: 'inbox', right: null });
    });
  });

  describe('untyped / standalone screens', () => {
    it('login screen is a no-op in either direction', () => {
      expect(decideSwipeNav('login', true)).toEqual({ kind: 'noop' });
      expect(decideSwipeNav('login', false)).toEqual({ kind: 'noop' });
    });
  });

  it('NAV_ORDER has exactly the 4 expected top-level tabs', () => {
    expect(NAV_ORDER).toEqual(['server', 'dms-list', 'inbox', 'settings-profile']);
  });

  it('only slides between adjacent bottom-nav tabs', () => {
    expect(isAdjacentTabSwitch('server', 'dms-list')).toBe(true);
    expect(isAdjacentTabSwitch('server', 'inbox')).toBe(false);
    expect(isAdjacentTabSwitch('server', 'settings-profile')).toBe(false);
  });

  describe('neighborsFor — drag-carousel reveal', () => {
    it('first top-level tab has no left neighbor', () => {
      expect(neighborsFor('server')).toEqual({ left: null, right: 'dms-list' });
    });

    it('middle top-level tabs have both neighbors', () => {
      expect(neighborsFor('dms-list')).toEqual({ left: 'server', right: 'inbox' });
      expect(neighborsFor('inbox')).toEqual({ left: 'dms-list', right: 'settings-profile' });
    });

    it('last top-level tab has no right neighbor', () => {
      expect(neighborsFor('settings-profile')).toEqual({ left: 'inbox', right: null });
    });

    it('sub-screen of server: no left (parent is first tab), right = next top-level', () => {
      expect(neighborsFor('channel')).toEqual({ left: null, right: 'dms-list' });
      expect(neighborsFor('voice-room')).toEqual({ left: null, right: 'dms-list' });
      expect(neighborsFor('member-list')).toEqual({ left: null, right: 'dms-list' });
      expect(neighborsFor('forum')).toEqual({ left: null, right: 'dms-list' });
    });

    it('sub-screen of dms-list: left = server, right = inbox', () => {
      expect(neighborsFor('dm-thread')).toEqual({ left: 'server', right: 'inbox' });
      expect(neighborsFor('compose-dm')).toEqual({ left: 'server', right: 'inbox' });
    });

    it('settings-prefs: left = inbox, right = null (last tab)', () => {
      expect(neighborsFor('settings-prefs')).toEqual({ left: 'inbox', right: null });
    });

    it('untyped screens have no neighbors', () => {
      expect(neighborsFor('login')).toEqual({ left: null, right: null });
      expect(neighborsFor('profile-setup')).toEqual({ left: null, right: null });
    });
  });

  describe('buildSeedHistory — initial popstate seeding', () => {
    it('top-level tab seeds [guard, parsed] only', () => {
      const parsed: NavState = { ...initialNav, screen: 'server' };
      const entries = buildSeedHistory(parsed, null);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ state: { guard: true }, url: '/app' });
      expect(entries[1]).toEqual({ state: { nav: parsed }, url: '/app' });
    });

    it('top-level inbox: guard sits behind, no parent in between', () => {
      const parsed: NavState = { ...initialNav, screen: 'inbox' };
      const entries = buildSeedHistory(parsed, null);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ state: { guard: true }, url: '/app?s=inbox' });
      expect(entries[1].state.nav?.screen).toBe('inbox');
    });

    it('deep-linked channel seeds [guard, server, channel] so back climbs to the channel list', () => {
      const parsed: NavState = { ...initialNav, screen: 'channel', groupId: 'gid' };
      const entries = buildSeedHistory(parsed, null);
      expect(entries).toHaveLength(3);
      expect(entries[0].state).toEqual({ guard: true });
      expect(entries[1].state.nav?.screen).toBe('server');
      expect(entries[1].state.nav?.groupId).toBe(null);
      expect(entries[2].state.nav).toEqual(parsed);
      // Guard URL matches the parent's URL so the popstate re-push doesn't
      // flicker the address bar.
      expect(entries[0].url).toBe(entries[1].url);
      expect(entries[2].url).toBe('/app?c=gid&s=channel');
    });

    it('deep-linked dm-thread seeds dms-list as the parent', () => {
      const parsed: NavState = { ...initialNav, screen: 'dm-thread', dmPeer: 'pk' };
      const entries = buildSeedHistory(parsed, null);
      expect(entries).toHaveLength(3);
      expect(entries[1].state.nav?.screen).toBe('dms-list');
      expect(entries[1].state.nav?.dmPeer).toBe(null);
      expect(entries[2].state.nav).toEqual(parsed);
    });

    it('deep-linked settings-prefs seeds settings-profile as the parent', () => {
      const parsed: NavState = { ...initialNav, screen: 'settings-prefs' };
      const entries = buildSeedHistory(parsed, null);
      expect(entries).toHaveLength(3);
      expect(entries[1].state.nav?.screen).toBe('settings-profile');
      expect(entries[2].state.nav?.screen).toBe('settings-prefs');
    });

    it('relay query param is preserved on every seeded URL', () => {
      const parsed: NavState = { ...initialNav, screen: 'channel', groupId: 'gid' };
      const entries = buildSeedHistory(parsed, 'wss://lacrypta-relay.obelisk.ar');
      for (const e of entries) {
        expect(e.url).toContain('relay=lacrypta-relay.obelisk.ar');
      }
    });
  });

  describe('resolveParent — dynamic over static parent', () => {
    it('top-level tabs have no parent', () => {
      expect(resolveParent(navOf('server'))).toBe(null);
      expect(resolveParent(navOf('dms-list'))).toBe(null);
      expect(resolveParent(navOf('inbox'))).toBe(null);
      expect(resolveParent(navOf('settings-profile'))).toBe(null);
    });

    it('static fallback when parentScreen is null', () => {
      expect(resolveParent(navOf('channel'))).toBe('server');
      expect(resolveParent(navOf('dm-thread'))).toBe('dms-list');
      expect(resolveParent(navOf('settings-prefs'))).toBe('settings-profile');
    });

    it('dynamic parentScreen overrides the static map', () => {
      expect(resolveParent(navOf('profile-view', 'inbox'))).toBe('inbox');
      expect(resolveParent(navOf('profile-view', 'dms-list'))).toBe('dms-list');
      expect(resolveParent(navOf('profile-view', 'server'))).toBe('server');
      expect(resolveParent(navOf('member-list', 'channel'))).toBe('server');
      expect(resolveParent(navOf('msg-actions', 'dm-thread'))).toBe('dms-list');
    });

    it('walks up nested parents until it hits a top-level tab', () => {
      // profile-view opened from msg-actions which was opened from dm-thread
      const nav = navOf('profile-view', 'msg-actions');
      expect(resolveParent(nav)).toBe('server'); // static fallback for msg-actions
    });

    it('decideSwipeNav respects dynamic parent for profile-view from inbox', () => {
      // From a profile reached via an inbox mention, swipe-right should go
      // toward Servers (Inbox's left neighbor), not whatever SUB_TO_NAV said.
      expect(decideSwipeNav(navOf('profile-view', 'inbox'), true)).toEqual({
        kind: 'top-level',
        target: 'dms-list',
        dir: 'back',
      });
      expect(decideSwipeNav(navOf('profile-view', 'inbox'), false)).toEqual({
        kind: 'top-level',
        target: 'settings-profile',
        dir: 'forward',
      });
    });

    it('decideSwipeNav with dynamic parent dm-thread', () => {
      // From a profile reached via a DM peer info tap, neighbors should be
      // Servers (left of DMs) and Inbox (right of DMs).
      expect(decideSwipeNav(navOf('profile-view', 'dms-list'), true)).toEqual({
        kind: 'top-level',
        target: 'server',
        dir: 'back',
      });
      expect(decideSwipeNav(navOf('profile-view', 'dms-list'), false)).toEqual({
        kind: 'top-level',
        target: 'inbox',
        dir: 'forward',
      });
    });

    it('neighborsFor with dynamic parent profile-view from inbox', () => {
      expect(neighborsFor(navOf('profile-view', 'inbox'))).toEqual({
        left: 'dms-list',
        right: 'settings-profile',
      });
    });
  });

  describe('decideTabPress — bottom-nav tap decision', () => {
    it('noop: tapping the same exact screen', () => {
      expect(decideTabPress(navOf('server'), 'server')).toEqual({ kind: 'noop' });
      expect(decideTabPress(navOf('dms-list'), 'dms-list')).toEqual({ kind: 'noop' });
      expect(decideTabPress(navOf('inbox'), 'inbox')).toEqual({ kind: 'noop' });
      expect(decideTabPress(navOf('settings-profile'), 'settings-profile')).toEqual({ kind: 'noop' });
    });

    it('pop: tap parent tab while on its sub-screen (static parent)', () => {
      expect(decideTabPress(navOf('channel'), 'server')).toEqual({ kind: 'pop', target: 'server' });
      expect(decideTabPress(navOf('voice-room'), 'server')).toEqual({ kind: 'pop', target: 'server' });
      expect(decideTabPress(navOf('forum'), 'server')).toEqual({ kind: 'pop', target: 'server' });
      expect(decideTabPress(navOf('dm-thread'), 'dms-list')).toEqual({ kind: 'pop', target: 'dms-list' });
      expect(decideTabPress(navOf('compose-dm'), 'dms-list')).toEqual({ kind: 'pop', target: 'dms-list' });
      expect(decideTabPress(navOf('settings-prefs'), 'settings-profile')).toEqual({ kind: 'pop', target: 'settings-profile' });
    });

    it('pop: tap parent tab while on its sub-screen (dynamic parent)', () => {
      // profile-view from inbox → Inbox is the resolved parent, so tap Inbox = pop.
      expect(decideTabPress(navOf('profile-view', 'inbox'), 'inbox')).toEqual({
        kind: 'pop',
        target: 'inbox',
      });
      // profile-view from inbox → tap Servers = switch (not pop) because
      // resolved parent is Inbox, not Servers.
      expect(decideTabPress(navOf('profile-view', 'inbox'), 'server')).toEqual({
        kind: 'switch',
        target: 'server',
        dir: 'back',
      });
    });

    it('switch forward: target tab is to the right in NAV_ORDER', () => {
      expect(decideTabPress(navOf('server'), 'dms-list')).toEqual({ kind: 'switch', target: 'dms-list', dir: 'forward' });
      expect(decideTabPress(navOf('server'), 'inbox')).toEqual({ kind: 'switch', target: 'inbox', dir: 'forward' });
      expect(decideTabPress(navOf('dms-list'), 'settings-profile')).toEqual({ kind: 'switch', target: 'settings-profile', dir: 'forward' });
    });

    it('switch back: target tab is to the left in NAV_ORDER', () => {
      expect(decideTabPress(navOf('inbox'), 'server')).toEqual({ kind: 'switch', target: 'server', dir: 'back' });
      expect(decideTabPress(navOf('settings-profile'), 'dms-list')).toEqual({ kind: 'switch', target: 'dms-list', dir: 'back' });
      expect(decideTabPress(navOf('dms-list'), 'server')).toEqual({ kind: 'switch', target: 'server', dir: 'back' });
    });

    it('switch direction from a sub-screen uses the resolved parent index', () => {
      // From a channel under Servers, tap DMs → forward (server idx 0 → dms idx 1).
      expect(decideTabPress(navOf('channel'), 'dms-list')).toEqual({ kind: 'switch', target: 'dms-list', dir: 'forward' });
      // From a dm-thread under DMs, tap Servers → back (dms idx 1 → server idx 0).
      expect(decideTabPress(navOf('dm-thread'), 'server')).toEqual({ kind: 'switch', target: 'server', dir: 'back' });
      // From a profile-view reached from Inbox, tap Servers → back (inbox idx 2 → server idx 0).
      expect(decideTabPress(navOf('profile-view', 'inbox'), 'server')).toEqual({ kind: 'switch', target: 'server', dir: 'back' });
      // From a profile-view reached from Inbox, tap You → forward.
      expect(decideTabPress(navOf('profile-view', 'inbox'), 'settings-profile')).toEqual({ kind: 'switch', target: 'settings-profile', dir: 'forward' });
    });
  });

  describe('decideSnap — drag-release commit/revert decision', () => {
    const W = 400; // viewport width

    it('zero dx never commits', () => {
      expect(decideSnap(0, 0, W)).toBe('revert');
      expect(decideSnap(0, 1.0, W)).toBe('revert');
    });

    it('commits when dragged past 1/3 of viewport', () => {
      expect(decideSnap(W / 3 + 1, 0, W)).toBe('commit');
      expect(decideSnap(-(W / 3 + 1), 0, W)).toBe('commit');
    });

    it('reverts when dragged less than 1/3 with no flick', () => {
      expect(decideSnap(W / 4, 0, W)).toBe('revert');
      expect(decideSnap(-(W / 4), 0, W)).toBe('revert');
    });

    it('flicks commit even with small displacement when direction agrees', () => {
      expect(decideSnap(30, 0.6, W)).toBe('commit');
      expect(decideSnap(-30, -0.6, W)).toBe('commit');
    });

    it('flicks reverse-direction (against drag) revert', () => {
      expect(decideSnap(30, -0.6, W)).toBe('revert');
      expect(decideSnap(-30, 0.6, W)).toBe('revert');
    });

    it('slow drag below velocity threshold reverts even with direction agreement', () => {
      expect(decideSnap(30, 0.3, W)).toBe('revert');
    });

    it('zero or negative width reverts safely', () => {
      expect(decideSnap(100, 0, 0)).toBe('revert');
      expect(decideSnap(100, 0, -10)).toBe('revert');
    });
  });
});
