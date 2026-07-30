import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useRef } from 'react';
import { useHistoryPagination, type HistoryLoadResult } from './useHistoryPagination';

const ROW_HEIGHT = 100;
const VIEWPORT = 300;

/**
 * jsdom has no layout, so the scroller reports metrics derived from the
 * rendered row count and every row reports a `data-top` we control. Rects are
 * viewport-relative (they shift with scrollTop) exactly like the real thing,
 * which is what the hook's anchor arithmetic assumes.
 */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroller = this.closest('[data-testid="scroller"]') as HTMLElement | null;
    const top = scroller === this || !scroller ? 0 : Number(this.dataset.top ?? 0) - scroller.scrollTop;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

function Harness({
  ids,
  loadEarlier,
  loading = false,
  reachedStart = false,
  sessionKey = 'relay::g1',
  onAtTop,
}: {
  ids: readonly string[];
  loadEarlier: () => Promise<HistoryLoadResult>;
  loading?: boolean;
  reachedStart?: boolean;
  sessionKey?: string;
  onAtTop?: (atTop: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const initedRef = useRef(false);

  // Stable so React doesn't detach/reattach (and re-seed scrollTop) on every
  // render — the metric setup must happen exactly once per node. Metrics are
  // derived from the committed rows, so they are already current by the time
  // any layout effect reads them (mirrors real layout).
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (node && !initedRef.current) {
      initedRef.current = true;
      const rows = () => node.querySelectorAll('[data-top]').length;
      Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => rows() * ROW_HEIGHT });
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: VIEWPORT });
      // Channel entry lands at the bottom (useChannelScrollPosition does this
      // for real, in a layout effect that runs before the hook's).
      node.scrollTop = Math.max(0, rows() * ROW_HEIGHT - VIEWPORT);
    }
    if (node) ref.current = node;
  }, []);

  const { atTop } = useHistoryPagination({
    scrollRef: ref,
    itemCount: ids.length,
    loadEarlier,
    loading,
    reachedStart,
    sessionKey,
  });
  onAtTop?.(atTop);

  return (
    <div data-testid="scroller" ref={attach}>
      {ids.map((id, i) => (
        <div key={id} data-testid={`row-${id}`} data-top={i * ROW_HEIGHT} />
      ))}
    </div>
  );
}

function idsFrom(oldest: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `m${oldest + i}`);
}

describe('useHistoryPagination', () => {
  let frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    frames = [];
    stubLayout();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const flushFrames = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  const scroller = () => screen.getByTestId('scroller') as HTMLDivElement;

  const scrollTo = (top: number) => {
    const el = scroller();
    act(() => {
      el.scrollTop = top;
      fireEvent.scroll(el);
    });
  };

  it('pulls the next page before the scroller reaches the very top', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'unavailable');
    render(<Harness ids={idsFrom(0, 50)} loadEarlier={loadEarlier} />);
    // Bottom of a 5000px list.
    scrollTo(4700);
    expect(loadEarlier).not.toHaveBeenCalled();

    // Still 400px of runway above — the old 80px trigger waited until the
    // scroller was pinned, where no further scroll events fire.
    await act(async () => {
      scrollTo(400);
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });

  it('leaves mid-history reading alone', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'added');
    render(<Harness ids={idsFrom(0, 50)} loadEarlier={loadEarlier} />);

    await act(async () => {
      scrollTo(2000);
    });
    expect(loadEarlier).not.toHaveBeenCalled();
  });

  it('keeps the viewport on the same message after older history is prepended', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'added');
    const { rerender } = render(<Harness ids={idsFrom(10, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(200);
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    // 10 older messages land at the front (1000px of new content above).
    await act(async () => {
      rerender(<Harness ids={idsFrom(0, 30)} loadEarlier={loadEarlier} />);
    });

    // Exactly one page of correction — not two. The reader is still looking
    // at m10, 200px down from the top of the viewport.
    expect(el.scrollTop).toBe(1200);
    expect(Number(screen.getByTestId('row-m10').dataset.top) - el.scrollTop).toBe(-200);
  });

  it('takes anchoring off the browser for the load, and gives it back after', async () => {
    // Chromium adjusts scrollTop itself when content is prepended above the
    // viewport — except at offset 0. Correcting on top of that adjustment
    // threw the reader a full page down into already-read messages, so the
    // browser must be held off for exactly the length of the page load.
    let resolve!: (r: HistoryLoadResult) => void;
    const loadEarlier = vi.fn(() => new Promise<HistoryLoadResult>((r) => { resolve = r; }));
    const { rerender } = render(<Harness ids={idsFrom(10, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(400);
    });
    expect(el.style.overflowAnchor).toBe('none');

    await act(async () => {
      resolve('added');
    });
    await act(async () => {
      rerender(<Harness ids={idsFrom(0, 30)} loadEarlier={loadEarlier} />);
    });

    expect(el.scrollTop).toBe(1400);
    expect(el.style.overflowAnchor).toBe('');
  });

  it('gives anchoring back when a page brings nothing', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'end');
    render(<Harness ids={idsFrom(0, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(0);
    });

    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(el.style.overflowAnchor).toBe('');
    expect(el.scrollTop).toBe(0);
  });

  it('corrects the prepend even when the DOM commits after the load resolves', async () => {
    // A bare requestAnimationFrame can beat React's commit; when it did, the
    // correction read the pre-prepend height, left scrollTop at 0, and no
    // scroll event could ever fire again.
    let resolve!: (r: HistoryLoadResult) => void;
    const loadEarlier = vi.fn(() => new Promise<HistoryLoadResult>((r) => { resolve = r; }));
    const { rerender } = render(<Harness ids={idsFrom(10, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    scrollTo(0);
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve('added');
    });
    act(() => flushFrames());
    expect(el.scrollTop).toBe(0);

    await act(async () => {
      rerender(<Harness ids={idsFrom(0, 30)} loadEarlier={loadEarlier} />);
    });

    expect(el.scrollTop).toBe(1000);
  });

  it('keeps paginating while pinned at the top, with no scroll event to ride on', async () => {
    // Regression: a browser stops emitting `scroll` once scrollTop is 0, so a
    // page that brought nothing used to strand the user until they scrolled
    // back down and up again.
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'unavailable');
    render(<Harness ids={idsFrom(0, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(0);
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.wheel(el, { deltaY: -120 });
      flushFrames();
    });
    expect(loadEarlier).toHaveBeenCalledTimes(2);

    await act(async () => {
      fireEvent.touchMove(el);
      flushFrames();
    });
    expect(loadEarlier).toHaveBeenCalledTimes(3);
  });

  it('coalesces a burst of wheel events into one check', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'unavailable');
    render(<Harness ids={idsFrom(0, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();
    el.scrollTop = 0;

    await act(async () => {
      for (let i = 0; i < 20; i++) fireEvent.wheel(el, { deltaY: -40 });
      flushFrames();
    });

    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });

  it('does not let its own correction trigger the next page', async () => {
    // The correction moves scrollTop, which fires a scroll event. Treating
    // that as user intent is how a short page becomes a self-feeding loop of
    // relay queries and re-renders.
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'added');
    const { rerender } = render(<Harness ids={idsFrom(18, 12)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(0);
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    // A 2-message page (200px) leaves the scroller inside the prefetch zone.
    await act(async () => {
      rerender(<Harness ids={idsFrom(16, 14)} loadEarlier={loadEarlier} />);
    });
    expect(el.scrollTop).toBe(200);

    // The browser dispatches the correction's own scroll event afterwards.
    await act(async () => {
      fireEvent.scroll(el);
      flushFrames();
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    // A real gesture still gets the next page.
    await act(async () => {
      fireEvent.wheel(el, { deltaY: -120 });
      flushFrames();
    });
    expect(loadEarlier).toHaveBeenCalledTimes(2);
  });

  it('holds off the next page until the last one has been anchored', async () => {
    // Between "relay answered" and "rows committed" the correction is still
    // owed. A scroll event in that window used to start another page, whose
    // capture (taken pre-commit) would discard the first page's anchor and
    // snap the reader to the top.
    let resolve!: (r: HistoryLoadResult) => void;
    const loadEarlier = vi.fn(() => new Promise<HistoryLoadResult>((r) => { resolve = r; }));
    const { rerender } = render(<Harness ids={idsFrom(10, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    await act(async () => {
      scrollTo(0);
    });
    await act(async () => {
      resolve('added');
    });

    // User is still scrolling; the rows haven't rendered yet.
    await act(async () => {
      fireEvent.scroll(el);
      fireEvent.wheel(el, { deltaY: -120 });
      flushFrames();
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(<Harness ids={idsFrom(0, 30)} loadEarlier={loadEarlier} />);
    });
    expect(el.scrollTop).toBe(1000);
  });

  it('never overlaps requests', async () => {
    let resolve!: (r: HistoryLoadResult) => void;
    const loadEarlier = vi.fn(() => new Promise<HistoryLoadResult>((r) => { resolve = r; }));
    render(<Harness ids={idsFrom(0, 50)} loadEarlier={loadEarlier} />);

    scrollTo(500);
    scrollTo(300);
    scrollTo(100);
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve('end');
    });
  });

  it('stops asking once the relay reports the start of history', async () => {
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'end');
    render(<Harness ids={idsFrom(0, 50)} loadEarlier={loadEarlier} reachedStart />);

    await act(async () => {
      scrollTo(0);
      fireEvent.wheel(scroller(), { deltaY: -120 });
      flushFrames();
    });
    expect(loadEarlier).not.toHaveBeenCalled();
  });

  it('drops a correction that arrives after the user switched channels', async () => {
    let resolve!: (r: HistoryLoadResult) => void;
    const loadEarlier = vi.fn(() => new Promise<HistoryLoadResult>((r) => { resolve = r; }));
    const { rerender } = render(<Harness ids={idsFrom(10, 20)} loadEarlier={loadEarlier} />);
    const el = scroller();

    scrollTo(200);
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    // Channel switch: useChannelScrollPosition re-seeds the scroller, and the
    // in-flight page must not yank it.
    await act(async () => {
      rerender(<Harness ids={idsFrom(0, 30)} loadEarlier={loadEarlier} sessionKey="relay::g2" />);
    });
    await act(async () => {
      resolve('added');
    });
    act(() => flushFrames());

    expect(el.scrollTop).toBe(200);
    expect(el.style.overflowAnchor).toBe('');
  });

  it('reports at-top only within the status-pill window', async () => {
    const seen: boolean[] = [];
    const loadEarlier = vi.fn(async (): Promise<HistoryLoadResult> => 'end');
    render(<Harness ids={idsFrom(0, 50)} loadEarlier={loadEarlier} reachedStart onAtTop={(v) => seen.push(v)} />);

    scrollTo(400);
    expect(seen.at(-1)).toBe(false);

    scrollTo(20);
    expect(seen.at(-1)).toBe(true);
  });
});
