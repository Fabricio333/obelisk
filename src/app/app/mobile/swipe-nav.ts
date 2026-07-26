import { initialNav, urlFor, type NavState, type ScreenName } from './url-state';

// Top-level bottom-nav screens, left-to-right. Swipe-left advances; swipe-right
// retreats.
export const NAV_ORDER: ScreenName[] = ['server', 'dms-list', 'inbox', 'settings-profile'];

export function isAdjacentTabSwitch(from: ScreenName, to: ScreenName): boolean {
  return Math.abs(NAV_ORDER.indexOf(from) - NAV_ORDER.indexOf(to)) === 1;
}

// Sub-screens map back to the top-level tab they belong to. This lets us treat
// a horizontal swipe on a sub-screen as if the user were on its parent — both
// directions skip the parent and switch tabs (swipe-left → next top-level,
// swipe-right → previous top-level), so a horizontal gesture is always a tab
// switch and never a within-tab pop. To go back inside a tab the user uses the
// header back-button or re-taps the active bottom-nav item.
export const SUB_TO_NAV: Partial<Record<ScreenName, ScreenName>> = {
  channel: 'server',
  'voice-room': 'server',
  forum: 'server',
  'member-list': 'server',
  search: 'server',
  'dm-thread': 'dms-list',
  'compose-dm': 'dms-list',
  'profile-view': 'server',
  'settings-prefs': 'settings-profile',
  'profile-edit': 'settings-profile',
  'msg-actions': 'server',
  'zap-modal': 'server',
};

export type SwipeNavAction =
  | { kind: 'top-level'; target: ScreenName; dir: 'forward' | 'back' }
  | { kind: 'noop' };

// Snap decision after a drag ends. Either commit (slide to the neighbor we
// were partway towards) or revert (snap back to the current screen). Distance
// threshold = 1/3 of viewport width — close to the iOS standard. The velocity
// fallback lets fast flicks commit even if they didn't pass the distance bar,
// as long as the flick direction agrees with the displacement (otherwise a
// flick reversing direction would weirdly commit).
export function decideSnap(
  dx: number,
  velocityPxPerMs: number,
  width: number,
): 'commit' | 'revert' {
  if (dx === 0 || width <= 0) return 'revert';
  if (Math.abs(dx) > width / 3) return 'commit';
  if (Math.abs(velocityPxPerMs) > 0.4 && Math.sign(velocityPxPerMs) === Math.sign(dx)) {
    return 'commit';
  }
  return 'revert';
}

// Resolve the top-level tab a nav state belongs to. Returns null for
// top-level tabs themselves (they have no parent). Sub-screens prefer the
// dynamic `parentScreen` recorded at navigation time and fall back to the
// static SUB_TO_NAV map only when that's null — e.g. a cold deep-link reload
// without the `pr` URL param. See docs/mobile-navigation.md §3.
export function resolveParent(nav: NavState): ScreenName | null {
  if (NAV_ORDER.includes(nav.screen)) return null;
  if (nav.parentScreen) {
    // The parent may itself be a sub-screen (e.g. opened profile from
    // member-list which was opened from channel). Walk up until we hit a
    // top-level tab or run out of map.
    let cursor: ScreenName | null = nav.parentScreen;
    const visited = new Set<ScreenName>();
    while (cursor && !NAV_ORDER.includes(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      cursor = SUB_TO_NAV[cursor] ?? null;
    }
    if (cursor) return cursor;
  }
  return SUB_TO_NAV[nav.screen] ?? null;
}

// Visual neighbors for the drag-tracking carousel: which screen, if any, sits
// to the left/right of the current screen and should be rendered partially
// behind the active one while the user pans.
//
// On a top-level tab, neighbors are the previous/next entries in NAV_ORDER.
// On a sub-screen the parent tab is treated as the screen's anchor in
// NAV_ORDER, so the neighbors are the tabs immediately before and after the
// parent — matching the swipe behavior, which skips the parent in both
// directions. The parent itself sits at the active position behind the
// sub-screen overlay; the renderer in PhoneShell handles that placement
// directly rather than going through this function.
//
// Accepts either a NavState (preferred — respects dynamic parentScreen) or a
// bare ScreenName (falls back to the static SUB_TO_NAV map). The bare-name
// form is kept for tests and pre-NavState callers.
export function neighborsFor(arg: NavState | ScreenName): { left: ScreenName | null; right: ScreenName | null } {
  const screen: ScreenName = typeof arg === 'string' ? arg : arg.screen;
  const navIndex = NAV_ORDER.indexOf(screen);
  if (navIndex >= 0) {
    return {
      left: navIndex > 0 ? NAV_ORDER[navIndex - 1] : null,
      right: navIndex < NAV_ORDER.length - 1 ? NAV_ORDER[navIndex + 1] : null,
    };
  }
  const parent = typeof arg === 'string'
    ? SUB_TO_NAV[screen] ?? null
    : resolveParent(arg);
  if (!parent) return { left: null, right: null };
  const parentIdx = NAV_ORDER.indexOf(parent);
  return {
    left: parentIdx > 0 ? NAV_ORDER[parentIdx - 1] : null,
    right: parentIdx < NAV_ORDER.length - 1 ? NAV_ORDER[parentIdx + 1] : null,
  };
}

// Decide what a horizontal swipe means for the current screen.
//
// On a top-level tab (server / dms-list / inbox / settings-profile) swipe
// cycles through NAV_ORDER. On a sub-screen we anchor at the parent's index
// in NAV_ORDER and step past it: swipe-left → parentIdx + 1, swipe-right →
// parentIdx - 1, no-op at the ends. So a horizontal gesture is always a
// tab switch — popping back inside a tab (channel → channels list, prefs →
// you) goes through the header back-button, not a swipe.
// Initial history seed entries: the first one is replaced over the current
// browser entry, the rest are pushed in order. The guard sentinel sits behind
// everything so that a back-press past the user's screen stack arms the
// "press again to exit" toast. When a deep link drops the user straight onto
// a sub-screen (e.g. /app?c=…) we also seed the parent tab between the guard
// and the sub-screen — otherwise the very first back-press would land on the
// guard and show the exit toast, which reads as broken.
export interface SeedHistoryEntry {
  state: { nav?: NavState; guard?: boolean };
  url: string;
}

export function buildSeedHistory(parsed: NavState, relay: string | null): SeedHistoryEntry[] {
  const seedUrl = urlFor(parsed, relay);
  const parentScreen = SUB_TO_NAV[parsed.screen] ?? null;
  const parentNav: NavState | null = parentScreen
    ? { ...initialNav, screen: parentScreen }
    : null;
  const parentUrl = parentNav ? urlFor(parentNav, relay) : null;

  const entries: SeedHistoryEntry[] = [];
  // Guard URL matches the parent (or the parsed screen if no parent) so the
  // address bar doesn't flicker when the popstate handler re-pushes after
  // arming the toast.
  entries.push({ state: { guard: true }, url: parentUrl ?? seedUrl });
  if (parentNav && parentUrl) {
    entries.push({ state: { nav: parentNav }, url: parentUrl });
  }
  entries.push({ state: { nav: parsed }, url: seedUrl });
  return entries;
}

// Accepts either a NavState (respects dynamic parentScreen) or a bare
// ScreenName (static fallback). PhoneShell passes navRef.current; tests
// pass screen names.
// Decide what a tap on a bottom-nav tab means given the user's current nav.
//
// Three branches:
//   • noop   — user is already on that exact screen (e.g. bare Servers + tap
//              Servers). Prevents the phantom history entry that produced
//              the historic "press back twice" feel.
//   • pop    — user is on a sub-screen whose top-level tab equals the target.
//              The sub-screen is collapsed back to the bare tab.
//   • switch — different top-level tab. Direction follows NAV_ORDER spatial
//              position so tap and swipe agree on what "left/right" means.
//
// See docs/mobile-navigation.md §4 for the full transition matrix.
export type TabPressAction =
  | { kind: 'noop' }
  | { kind: 'pop'; target: ScreenName }
  | { kind: 'switch'; target: ScreenName; dir: 'forward' | 'back' };

export function decideTabPress(cur: NavState, target: ScreenName): TabPressAction {
  if (cur.screen === target) return { kind: 'noop' };
  const curTab = NAV_ORDER.includes(cur.screen) ? cur.screen : resolveParent(cur);
  if (curTab === target) return { kind: 'pop', target };
  const fromIdx = NAV_ORDER.indexOf(curTab ?? 'server');
  const toIdx = NAV_ORDER.indexOf(target);
  if (toIdx < 0) return { kind: 'noop' }; // defensive: caller passed a non-tab
  const dir: 'forward' | 'back' = toIdx > fromIdx ? 'forward' : 'back';
  return { kind: 'switch', target, dir };
}

export function decideSwipeNav(arg: NavState | ScreenName, goingRight: boolean): SwipeNavAction {
  const screen: ScreenName = typeof arg === 'string' ? arg : arg.screen;
  const navIndex = NAV_ORDER.indexOf(screen);
  if (navIndex >= 0) {
    const nextIdx = goingRight ? navIndex - 1 : navIndex + 1;
    if (nextIdx < 0 || nextIdx >= NAV_ORDER.length) return { kind: 'noop' };
    return {
      kind: 'top-level',
      target: NAV_ORDER[nextIdx],
      dir: goingRight ? 'back' : 'forward',
    };
  }
  const parent = typeof arg === 'string'
    ? SUB_TO_NAV[screen] ?? null
    : resolveParent(arg);
  if (!parent) return { kind: 'noop' };
  const parentIdx = NAV_ORDER.indexOf(parent);
  const nextIdx = goingRight ? parentIdx - 1 : parentIdx + 1;
  if (nextIdx < 0 || nextIdx >= NAV_ORDER.length) return { kind: 'noop' };
  return {
    kind: 'top-level',
    target: NAV_ORDER[nextIdx],
    dir: goingRight ? 'back' : 'forward',
  };
}
