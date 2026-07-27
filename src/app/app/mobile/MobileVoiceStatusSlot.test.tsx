import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// VoiceStatusBar reads from the bridge and the voice store. We mock the
// bridge wholesale and stub the store import so the slot can mount in
// isolation without booting nostr-tools / SimplePool.
vi.mock('@/lib/nostr-bridge', () => ({
  useGroups: () => [],
}));

vi.mock('@/lib/voice/active-client', () => ({
  getActiveVoiceClient: () => null,
  setActiveVoiceClient: () => {},
}));

vi.mock('@/lib/voice/jump-to-voice', () => ({
  requestVoiceJump: () => {},
}));

import { useVoiceStore } from '@/store/voice';
import { MobileVoiceStatusSlot, shouldHideMobileBottomNav } from './PhoneShell';

describe('MobileVoiceStatusSlot', () => {
  it('stays mounted across screens during a call so the bar can show via CSS', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'group-1' });
    const { rerender } = render(<MobileVoiceStatusSlot screen="voice-room" kbInset={0} />);
    const slot = screen.getByTestId('mobile-voice-status-slot');
    expect(slot.classList.contains('is-hidden')).toBe(true);
    expect(screen.getByTestId('voice-status-bar')).toBeTruthy();

    rerender(<MobileVoiceStatusSlot screen="server" kbInset={0} />);
    expect(slot.classList.contains('is-hidden')).toBe(false);
    expect(screen.getByTestId('voice-status-bar')).toBeTruthy();

    useVoiceStore.getState().leaveVoice();
  });

  it('hides the slot while the on-screen keyboard is open', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'group-1' });
    render(<MobileVoiceStatusSlot screen="channel" kbInset={320} />);
    const slot = screen.getByTestId('mobile-voice-status-slot');
    expect(slot.classList.contains('is-hidden')).toBe(true);
    useVoiceStore.getState().leaveVoice();
  });

  it('renders an empty slot when there is no active call', () => {
    useVoiceStore.getState().leaveVoice();
    render(<MobileVoiceStatusSlot screen="server" kbInset={0} />);
    const slot = screen.getByTestId('mobile-voice-status-slot');
    expect(slot.classList.contains('is-hidden')).toBe(false);
    expect(slot.children.length).toBe(0);
  });
});

describe('shouldHideMobileBottomNav', () => {
  it('hides on full-screen/transient mobile routes and while the keyboard is open', () => {
    expect(shouldHideMobileBottomNav('search', 0)).toBe(true);
    expect(shouldHideMobileBottomNav('channel', 280)).toBe(true);
  });

  it('keeps top-level tabs visible when there is no keyboard inset', () => {
    expect(shouldHideMobileBottomNav('server', 0)).toBe(false);
    expect(shouldHideMobileBottomNav('dms-list', 0)).toBe(false);
    expect(shouldHideMobileBottomNav('inbox', 0)).toBe(false);
    expect(shouldHideMobileBottomNav('voice-room', 0)).toBe(false);
  });
});
