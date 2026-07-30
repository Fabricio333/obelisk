'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export type HistoryLoadResult = 'added' | 'end' | 'unavailable' | null;

/**
 * How far from the top of the scroller the next page starts loading.
 *
 * A browser only emits `scroll` while `scrollTop` actually changes, so a
 * trigger that waits for the very top strands the user once the scroller is
 * pinned at 0: wheeling further up is silent, and the only way to get another
 * event is to scroll back down first. Starting a screenful early keeps the
 * load inside the region where the scroller can still move.
 */
export const HISTORY_PREFETCH_PX = 600;

/** How close to the top counts as "at the top" for the status pill. */
export const HISTORY_AT_TOP_PX = 80;

/**
 * Safety valve: if a page reports 'added' but never produces a rendered row
 * (every message filtered by mute / WoT, say), give up waiting and hand
 * anchoring back to the browser.
 */
const ANCHOR_RELEASE_MS = 2000;

interface PendingPage {
  /** Channel identity at capture time; a switch abandons the correction. */
  readonly key: string | null;
  /** A row that exists on both sides of the prepend, if the list has one. */
  readonly node: Element | null;
  /** `node`'s offset inside the scrolled content — independent of scrollTop. */
  readonly contentOffset: number;
  /** Fallback baseline for when the captured row is gone by commit time. */
  readonly scrollHeight: number;
  /** Only correct once the rendered list has actually grown past this. */
  readonly itemCount: number;
}

export interface UseHistoryPaginationOptions {
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** Rendered message count — drives the post-prepend correction. */
  readonly itemCount: number;
  readonly loadEarlier: () => Promise<HistoryLoadResult>;
  readonly loading: boolean;
  readonly reachedStart: boolean;
  /** Channel identity (scroll key / group id). Anchors don't cross it. */
  readonly sessionKey?: string | null;
  readonly prefetchPx?: number;
  readonly atTopPx?: number;
}

/** Offset of `node` within the scroller's content box, ignoring scrollTop. */
function contentOffsetOf(scroller: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * Top-of-list history pagination with scroll anchoring — the "scroll up for
 * older messages" half of normal chat scrolling.
 *
 * ## Who moves the scroller
 *
 * Browsers implement CSS scroll anchoring: when content is inserted above the
 * viewport of a scroll container, the browser silently adds the inserted
 * height to `scrollTop` so the visible content stays put. Verified in
 * Chromium: prepending 1000px at `scrollTop: 400` leaves the container at
 * 1400 with no help from us — *except* at `scrollTop: 0`, where anchoring is
 * suppressed and the content visibly jumps. Safari implements no anchoring at
 * all. So neither "always correct" nor "never correct" is right, and a
 * correction that assumes the browser did nothing double-counts on the very
 * path this hook prefetches into (that regression threw the reader a full page
 * back into already-read messages on every load).
 *
 * This hook takes the ambiguity away: it sets `overflow-anchor: none` for the
 * duration of a page load, so the browser provably does not touch `scrollTop`,
 * then applies the one correction itself and hands anchoring back. Measuring
 * the anchor row in *content* space (invariant under scrolling) means a user
 * who keeps scrolling while the page is in flight keeps their scrolling —
 * the correction only ever adds the height that was prepended.
 *
 * ## What triggers a page
 *
 * User intent only: a scroll the hook didn't cause, a wheel, or a touch drag.
 * There is deliberately no "keep loading until the viewport is full" chain —
 * a page that fails to move the scroller out of the prefetch zone would
 * otherwise re-trigger itself, and 50 messages a round trip is a lot of relay
 * traffic and re-rendering to spend on a loop the user never asked for.
 */
export function useHistoryPagination({
  scrollRef,
  itemCount,
  loadEarlier,
  loading,
  reachedStart,
  sessionKey = null,
  prefetchPx = HISTORY_PREFETCH_PX,
  atTopPx = HISTORY_AT_TOP_PX,
}: UseHistoryPaginationOptions): { atTop: boolean } {
  const [atTop, setAtTop] = useState(false);
  const pendingRef = useRef<PendingPage | null>(null);
  const inFlightRef = useRef(false);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** scrollTop we just wrote ourselves, so its scroll event can't re-trigger. */
  const selfScrollTopRef = useRef<number | null>(null);
  /** Coalesces high-frequency wheel / touchmove into one check per frame. */
  const checkQueuedRef = useRef(false);
  const maybeLoadRef = useRef<() => void>(() => {});

  // Latest-value mirrors. Every decision runs from a DOM event or a settled
  // promise — i.e. always after a commit — so these refresh in a layout
  // effect rather than during render.
  const loadEarlierRef = useRef(loadEarlier);
  const loadingRef = useRef(loading);
  const reachedStartRef = useRef(reachedStart);
  const itemCountRef = useRef(itemCount);
  const sessionKeyRef = useRef(sessionKey);

  /** Hand anchoring back to the browser and forget the pending page. */
  const release = useCallback(() => {
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    pendingRef.current = null;
    const el = scrollRef.current;
    if (el) el.style.overflowAnchor = '';
  }, [scrollRef]);

  // Declared before the correction effect below so it wins the same commit: a
  // channel switch swaps the message list and the scroll key together, and a
  // stale anchor must be dropped before anything can apply it. The rows it
  // pointed at are gone and useChannelScrollPosition has already re-seeded the
  // scroller for the new channel.
  useLayoutEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    inFlightRef.current = false;
    release();
  }, [release, sessionKey]);

  const maybeLoad = useCallback(() => {
    if (reachedStartRef.current || inFlightRef.current || loadingRef.current) return;
    // A page that has landed but not yet committed still owes a correction.
    // Starting the next one here would overwrite its anchor with a capture
    // taken before its rows rendered, and the viewport would snap to the top.
    if (pendingRef.current) return;
    if (itemCountRef.current <= 0) return;
    const el = scrollRef.current;
    if (!el || el.scrollTop > prefetchPx) return;

    // Take anchoring away from the browser for this page so exactly one actor
    // moves the scroller. Restored by `release`, on every exit path.
    el.style.overflowAnchor = 'none';
    const node = el.firstElementChild;
    pendingRef.current = {
      key: sessionKeyRef.current,
      node,
      contentOffset: node ? contentOffsetOf(el, node) : 0,
      scrollHeight: el.scrollHeight,
      itemCount: itemCountRef.current,
    };
    inFlightRef.current = true;

    void loadEarlierRef.current()
      .then((result) => {
        inFlightRef.current = false;
        // Nothing landed (end of history, relay hiccup, or a retry window):
        // no correction is owed, so give anchoring back immediately.
        if (result !== 'added') {
          release();
          return;
        }
        releaseTimerRef.current = setTimeout(release, ANCHOR_RELEASE_MS);
      })
      .catch(() => {
        inFlightRef.current = false;
        release();
      });
  }, [prefetchPx, release, scrollRef]);

  useLayoutEffect(() => {
    loadEarlierRef.current = loadEarlier;
    loadingRef.current = loading;
    reachedStartRef.current = reachedStart;
    itemCountRef.current = itemCount;
    maybeLoadRef.current = maybeLoad;
  });

  // The correction. Runs synchronously after the prepend commits and before
  // paint, so the reader never sees the intermediate position.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const el = scrollRef.current;
    if (!el || pending.key !== sessionKeyRef.current) {
      release();
      return;
    }
    if (itemCount <= pending.itemCount) return; // page hasn't rendered yet
    const hasNode = !!pending.node && el.contains(pending.node);
    const delta = hasNode
      ? contentOffsetOf(el, pending.node as Element) - pending.contentOffset
      : el.scrollHeight - pending.scrollHeight;
    if (delta > 0) {
      el.scrollTop += delta;
      selfScrollTopRef.current = el.scrollTop;
    }
    release();
  }, [itemCount, release, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      setAtTop(el.scrollTop < atTopPx);
      // Our own correction fires a scroll event too. Letting that count as
      // intent is how a short page turns into a self-feeding load loop.
      const self = selfScrollTopRef.current !== null && Math.abs(el.scrollTop - selfScrollTopRef.current) < 1;
      selfScrollTopRef.current = null;
      if (!self) maybeLoadRef.current();
    };
    // Wheel and touch are what keep pagination alive when the scroller is
    // pinned at 0 (or inside a retry window) and no scroll event can fire.
    // Coalesced to one check per frame — these fire far too often to spend a
    // layout read on each one.
    const onIntent = () => {
      if (checkQueuedRef.current) return;
      checkQueuedRef.current = true;
      requestAnimationFrame(() => {
        checkQueuedRef.current = false;
        maybeLoadRef.current();
      });
    };

    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onIntent, { passive: true });
    el.addEventListener('touchmove', onIntent, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onIntent);
      el.removeEventListener('touchmove', onIntent);
    };
  }, [atTopPx, scrollRef]);

  useEffect(() => release, [release]);

  return { atTop };
}
