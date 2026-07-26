export const CHANNEL_SCROLL_NEAR_BOTTOM_PX = 120;

export interface ChannelScrollSnapshot {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly nearBottom: boolean;
  readonly updatedAt: number;
}

export interface ChannelScrollRestoreResult {
  readonly source: 'saved' | 'anchor' | 'bottom';
  readonly scrollTop: number;
  readonly nearBottom: boolean;
  readonly complete: boolean;
}

export interface ChannelScrollElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface ChannelScrollAnchorElement {
  readonly offsetTop: number;
}

const positions = new Map<string, ChannelScrollSnapshot>();

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxScrollTop(el: ChannelScrollElement): number {
  return Math.max(0, finiteNumber(el.scrollHeight) - finiteNumber(el.clientHeight));
}

function distanceFromBottom(el: ChannelScrollElement): number {
  return maxScrollTop(el) - finiteNumber(el.scrollTop);
}

export function channelScrollPositionKey(
  relayUrl: string | null | undefined,
  groupId: string | null | undefined,
): string | null {
  if (!groupId) return null;
  const relay = (relayUrl ?? 'unknown-relay').replace(/\/+$/, '').toLowerCase();
  return `${relay || 'unknown-relay'}::${groupId}`;
}

export function isChannelScrollNearBottom(
  el: ChannelScrollElement,
  nearBottomPx = CHANNEL_SCROLL_NEAR_BOTTOM_PX,
): boolean {
  return distanceFromBottom(el) <= nearBottomPx;
}

export function getChannelScrollPosition(key: string | null | undefined): ChannelScrollSnapshot | null {
  if (!key) return null;
  return positions.get(key) ?? null;
}

export function rememberChannelScrollPosition(
  key: string | null | undefined,
  el: ChannelScrollElement,
  nearBottomPx = CHANNEL_SCROLL_NEAR_BOTTOM_PX,
): ChannelScrollSnapshot | null {
  if (!key) return null;
  const maxTop = maxScrollTop(el);
  const scrollTop = clamp(finiteNumber(el.scrollTop), 0, maxTop);
  const snapshot: ChannelScrollSnapshot = {
    scrollTop,
    scrollHeight: finiteNumber(el.scrollHeight),
    clientHeight: finiteNumber(el.clientHeight),
    nearBottom: maxTop - scrollTop <= nearBottomPx,
    updatedAt: Date.now(),
  };
  positions.set(key, snapshot);
  return snapshot;
}

export function restoreChannelScrollPosition(
  key: string,
  el: ChannelScrollElement,
  nearBottomPx = CHANNEL_SCROLL_NEAR_BOTTOM_PX,
  opts?: {
    readonly initialAnchorElement?: ChannelScrollAnchorElement | null;
    readonly ignoreSaved?: boolean;
  },
): ChannelScrollRestoreResult {
  const saved = opts?.ignoreSaved ? undefined : positions.get(key);
  const maxTop = maxScrollTop(el);
  const anchor = opts?.initialAnchorElement ?? null;
  const source: ChannelScrollRestoreResult['source'] = saved ? 'saved' : anchor ? 'anchor' : 'bottom';
  const desiredScrollTop = saved
    ? saved.nearBottom
      ? maxTop
      : finiteNumber(saved.scrollTop)
    : anchor
      ? finiteNumber(anchor.offsetTop)
      : maxTop;
  const scrollTop = clamp(desiredScrollTop, 0, maxTop);
  const complete = saved
    ? saved.nearBottom || scrollTop === desiredScrollTop
    : anchor
      ? desiredScrollTop >= maxTop || scrollTop === desiredScrollTop
      : maxTop > 0;

  el.scrollTop = scrollTop;
  const snapshot = complete ? rememberChannelScrollPosition(key, el, nearBottomPx) : null;
  return {
    source,
    scrollTop,
    nearBottom: snapshot?.nearBottom ?? isChannelScrollNearBottom(el, nearBottomPx),
    complete,
  };
}

export function clearChannelScrollPositions(): void {
  positions.clear();
}
