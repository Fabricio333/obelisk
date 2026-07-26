import { beforeEach, describe, expect, it } from 'vitest';
import {
  channelScrollPositionKey,
  clearChannelScrollPositions,
  getChannelScrollPosition,
  rememberChannelScrollPosition,
  restoreChannelScrollPosition,
  type ChannelScrollElement,
} from './channel-scroll-position';

function scroller(scrollTop: number, scrollHeight = 1000, clientHeight = 200): ChannelScrollElement {
  return { scrollTop, scrollHeight, clientHeight };
}

describe('channel scroll positions', () => {
  beforeEach(() => {
    clearChannelScrollPositions();
  });

  it('keys positions by normalized relay and group id', () => {
    expect(channelScrollPositionKey('WSS://Relay.Example//', 'group-1')).toBe('wss://relay.example::group-1');
    expect(channelScrollPositionKey(null, 'group-1')).toBe('unknown-relay::group-1');
    expect(channelScrollPositionKey('wss://relay.example', null)).toBeNull();
  });

  it('restores first channel open to the latest message', () => {
    const el = scroller(0);

    const result = restoreChannelScrollPosition('relay::group-1', el);

    expect(result.source).toBe('bottom');
    expect(result.scrollTop).toBe(800);
    expect(el.scrollTop).toBe(800);
    expect(getChannelScrollPosition('relay::group-1')?.nearBottom).toBe(true);
  });

  it('restores a saved mid-history position on channel re-entry', () => {
    rememberChannelScrollPosition('relay::group-1', scroller(260));
    const el = scroller(0);

    const result = restoreChannelScrollPosition('relay::group-1', el);

    expect(result.source).toBe('saved');
    expect(result.scrollTop).toBe(260);
    expect(result.nearBottom).toBe(false);
    expect(el.scrollTop).toBe(260);
  });

  it('can ignore a stale saved position and restore the latest message', () => {
    rememberChannelScrollPosition('relay::group-1', scroller(0));
    const el = scroller(0);

    const result = restoreChannelScrollPosition('relay::group-1', el, undefined, { ignoreSaved: true });

    expect(result.source).toBe('bottom');
    expect(el.scrollTop).toBe(800);
  });

  it('uses an initial read-cursor anchor when no saved position exists', () => {
    const el = scroller(0);

    const result = restoreChannelScrollPosition('relay::group-1', el, undefined, {
      initialAnchorElement: { offsetTop: 360 },
    });

    expect(result.source).toBe('anchor');
    expect(result.scrollTop).toBe(360);
    expect(result.nearBottom).toBe(false);
    expect(el.scrollTop).toBe(360);
  });

  it('keeps bottom-locked channels at the new latest message', () => {
    rememberChannelScrollPosition('relay::group-1', scroller(790));
    const el = scroller(0, 1400, 200);

    const result = restoreChannelScrollPosition('relay::group-1', el);

    expect(result.source).toBe('saved');
    expect(result.scrollTop).toBe(1200);
    expect(result.nearBottom).toBe(true);
  });

  it('clamps stale saved positions when the rendered history is shorter', () => {
    rememberChannelScrollPosition('relay::group-1', scroller(760));
    const el = scroller(0, 600, 200);

    const result = restoreChannelScrollPosition('relay::group-1', el);

    expect(result.scrollTop).toBe(400);
    expect(el.scrollTop).toBe(400);
  });
});
