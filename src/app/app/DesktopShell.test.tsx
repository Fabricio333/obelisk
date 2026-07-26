import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/store/chat';
import { SidebarMe } from './DesktopShell';

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => 'a'.repeat(64),
  useUserMetadata: () => ({ displayName: 'Alice', picture: null }),
}));

describe('SidebarMe', () => {
  beforeEach(() => useChatStore.setState(useChatStore.getInitialState()));

  it('opens my profile in the shared anchored preview', () => {
    render(<SidebarMe />);
    fireEvent.click(screen.getByTestId('sidebar-profile-button'), { clientX: 120, clientY: 700 });

    expect(useChatStore.getState().profilePopupPubkey).toBe('a'.repeat(64));
    expect(useChatStore.getState().profilePopupAnchor).toEqual({ x: 120, y: 700 });
  });
});
