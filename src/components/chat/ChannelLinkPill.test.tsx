import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChannelLinkPill from './ChannelLinkPill';

describe('ChannelLinkPill', () => {
  const originalPush = window.history.pushState;

  beforeEach(() => {
    window.history.pushState = vi.fn();
  });

  afterEach(() => {
    window.history.pushState = originalPush;
    vi.restoreAllMocks();
  });

  it('uses the relay channel slug directly', () => {
    render(<ChannelLinkPill slug="general" href="/app?c=general" />);
    expect(screen.getByTestId('channel-link-pill')).toHaveTextContent('#general');
  });

  it('keeps post and message link prefixes', () => {
    const { rerender } = render(
      <ChannelLinkPill slug="forum" postId="post" href="/app?c=forum&p=post" />,
    );
    expect(screen.getByTestId('channel-link-pill')).toHaveTextContent('📋 forum');

    rerender(<ChannelLinkPill slug="general" messageId="message" href="/app?c=general&m=message" />);
    expect(screen.getByTestId('channel-link-pill')).toHaveTextContent('↩ general');
  });

  it('navigates without remounting unless a modifier key is held', () => {
    const listener = vi.fn();
    window.addEventListener('popstate', listener);
    render(<ChannelLinkPill slug="general" href="/app?c=general" />);

    fireEvent.click(screen.getByTestId('channel-link-pill'));
    expect(window.history.pushState).toHaveBeenCalledWith(null, '', '/app?c=general');
    expect(listener).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId('channel-link-pill'), { metaKey: true });
    expect(window.history.pushState).toHaveBeenCalledOnce();
    window.removeEventListener('popstate', listener);
  });
});
