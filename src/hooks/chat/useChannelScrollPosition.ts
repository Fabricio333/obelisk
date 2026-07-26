'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
  CHANNEL_SCROLL_NEAR_BOTTOM_PX,
  getChannelScrollPosition,
  rememberChannelScrollPosition,
  restoreChannelScrollPosition,
} from '@/lib/channel-scroll-position';

interface UseChannelScrollPositionOptions {
  readonly scrollKey: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly itemCount: number;
  readonly disabled?: boolean;
  readonly initialAnchorKey?: string | null;
  readonly getInitialAnchorElement?: () => HTMLElement | null;
  readonly ignoreSavedOnInitialRestore?: boolean;
  readonly nearBottomPx?: number;
  readonly onNearBottomChange?: (nearBottom: boolean) => void;
}

export function useChannelScrollPosition({
  scrollKey,
  scrollRef,
  itemCount,
  disabled = false,
  initialAnchorKey = null,
  getInitialAnchorElement,
  ignoreSavedOnInitialRestore = false,
  nearBottomPx = CHANNEL_SCROLL_NEAR_BOTTOM_PX,
  onNearBottomChange,
}: UseChannelScrollPositionOptions): void {
  const restoredKeyRef = useRef<string | null>(null);
  const onNearBottomChangeRef = useRef(onNearBottomChange);
  const getInitialAnchorElementRef = useRef(getInitialAnchorElement);
  getInitialAnchorElementRef.current = getInitialAnchorElement;

  useEffect(() => {
    onNearBottomChangeRef.current = onNearBottomChange;
  }, [onNearBottomChange]);

  useLayoutEffect(() => {
    if (!scrollKey) return;
    return () => {
      const el = scrollRef.current;
      if (el) rememberChannelScrollPosition(scrollKey, el, nearBottomPx);
    };
  }, [nearBottomPx, scrollKey, scrollRef]);

  useLayoutEffect(() => {
    if (!scrollKey) {
      restoredKeyRef.current = null;
      return;
    }

    if (disabled) {
      restoredKeyRef.current = scrollKey;
      return;
    }

    if (itemCount <= 0) return;

    const applyRestore = () => {
      const el = scrollRef.current;
      if (!el) return;
      const result = restoreChannelScrollPosition(scrollKey, el, nearBottomPx, {
        initialAnchorElement: getInitialAnchorElementRef.current?.() ?? null,
        ignoreSaved: ignoreSavedOnInitialRestore,
      });
      onNearBottomChangeRef.current?.(result.nearBottom);
      if (result.complete) restoredKeyRef.current = scrollKey;
    };

    let frame: number | null = null;
    if (restoredKeyRef.current !== scrollKey) {
      applyRestore();
      frame = requestAnimationFrame(applyRestore);
    }

    const el = scrollRef.current;
    const observer = el && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const saved = getChannelScrollPosition(scrollKey);
          if (!saved || saved.nearBottom) applyRestore();
        })
      : null;
    if (el && observer) {
      observer.observe(el);
      for (const child of el.children) observer.observe(child);
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [disabled, ignoreSavedOnInitialRestore, initialAnchorKey, itemCount, nearBottomPx, scrollKey, scrollRef]);

  useEffect(() => {
    if (!scrollKey) return;
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const snapshot = rememberChannelScrollPosition(scrollKey, el, nearBottomPx);
      if (snapshot) onNearBottomChangeRef.current?.(snapshot.nearBottom);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [nearBottomPx, scrollKey, scrollRef]);
}
