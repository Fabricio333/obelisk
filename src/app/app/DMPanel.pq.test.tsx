/**
 * Post-quantum indicators mounted in the desktop DM thread.
 *
 * The UX audit's finding was that the post-quantum journey "dead-ends with
 * zero feedback": `PqConversationNotice` and `PqMessageMark` existed, were
 * tested, and were mounted nowhere. These tests pin the mount, the density
 * decision (marks aggregate to protocol transitions rather than one pill per
 * bubble), and the on-accent contrast variant for outgoing bubbles.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import type { JsDirectMessage } from '@/lib/nostr-bridge';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

const dms = vi.hoisted(() => ({ current: {} as Record<string, JsDirectMessage[]> }));
const hasUsableKeys = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => ME,
  useUserMetadata: () => ({ displayName: 'Bob', picture: null }),
  useDirectMessages: () => dms.current,
  getBridgeImpl: () => null,
  nostrActions: {
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    retryDirectMessage: vi.fn(),
    cancelPendingDirectMessage: vi.fn(),
  },
}));

vi.mock('@/lib/pq/attestations', () => ({
  hasUsableKeys: (pk: string) => hasUsableKeys(pk),
  getAttestation: vi.fn(),
  clearAttestationCache: vi.fn(),
}));

import { DMPanel } from './DesktopShell';
import { setPreference } from '@/lib/preferences';

function msg(over: Partial<JsDirectMessage> & { id: string }): JsDirectMessage {
  return {
    counterparty: PEER,
    outgoing: false,
    content: 'hi',
    createdAt: 1,
    ...over,
  } as JsDirectMessage;
}

function renderPanel() {
  return render(
    <LocaleProvider>
      <DMPanel peer={PEER} onPickPeer={() => {}} />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  hasUsableKeys.mockReset();
  hasUsableKeys.mockResolvedValue(false);
  dms.current = {};
  setPreference('postQuantumEnabled', true);
});

afterEach(() => {
  setPreference('postQuantumEnabled', false);
});

describe('DMPanel — conversation notice', () => {
  it('warns when the conversation cannot be quantum-secured', async () => {
    renderPanel();

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Not quantum-safe');
    expect(notice).toHaveTextContent('How to get quantum-safe');
  });

  it('confirms when both parties advertise post-quantum keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    renderPanel();

    expect(await screen.findByText('Quantum-ready')).toBeInTheDocument();
  });

  it('stays silent while the user has post-quantum turned off', async () => {
    setPreference('postQuantumEnabled', false);
    dms.current = { [PEER]: [msg({ id: '1', protocol: 'nip04' })] };
    renderPanel();

    // Give the (skipped) lookups a chance to resolve before asserting absence.
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('pq-mark')).toHaveLength(0);
  });
});

describe('DMPanel — per-message marks', () => {
  it('marks only the head of a run of same-protection messages', async () => {
    dms.current = {
      [PEER]: [
        msg({ id: '1', protocol: 'nip04', content: 'one' }),
        msg({ id: '2', protocol: 'nip04', content: 'two' }),
        msg({ id: '3', protocol: 'nip04', content: 'three' }),
      ],
    };
    renderPanel();

    await screen.findByText('one');
    // Three NIP-04 messages, one pill — not three.
    expect(screen.getAllByTestId('pq-mark')).toHaveLength(1);
    expect(screen.getByTestId('pq-mark')).toHaveTextContent('Not gift-wrapped');
  });

  it('marks the transition from NIP-04 history to NIP-17', async () => {
    dms.current = {
      [PEER]: [
        msg({ id: '1', protocol: 'nip04', content: 'old' }),
        msg({ id: '2', protocol: 'nip17', pq: false, content: 'newer' }),
        msg({ id: '3', protocol: 'nip17', pq: true, content: 'protected' }),
      ],
    };
    renderPanel();

    await screen.findByText('old');
    const marks = screen.getAllByTestId('pq-mark');
    expect(marks.map((m) => m.textContent)).toEqual(['Not gift-wrapped', 'Not quantum-safe']);
  });

  it('uses the on-accent variant for outgoing bubbles', async () => {
    dms.current = {
      [PEER]: [msg({ id: '1', protocol: 'nip04', outgoing: true, content: 'mine' })],
    };
    renderPanel();

    await screen.findByText('mine');
    // `text-lc-muted` is roughly 2:1 on the `bg-lc-green` outgoing bubble.
    expect(screen.getByTestId('pq-mark').className).toContain('text-black/60');
    expect(screen.getByTestId('pq-mark').className).not.toContain('text-lc-muted');
  });

  it('does not mark an in-flight message, and does not let it break the run', async () => {
    dms.current = {
      [PEER]: [
        msg({ id: '1', protocol: 'nip04', content: 'old' }),
        msg({ id: '2', protocol: 'nip17', pq: false, pending: true, outgoing: true, content: 'sending' }),
        msg({ id: '3', protocol: 'nip04', content: 'later' }),
      ],
    };
    renderPanel();

    await screen.findByText('sending');
    expect(screen.getAllByTestId('pq-mark')).toHaveLength(1);
  });

  it('stays quiet for a fully post-quantum thread', async () => {
    hasUsableKeys.mockResolvedValue(true);
    dms.current = {
      [PEER]: [
        msg({ id: '1', protocol: 'nip17', pq: true, content: 'a' }),
        msg({ id: '2', protocol: 'nip17', pq: true, content: 'b' }),
      ],
    };
    renderPanel();

    await screen.findByText('a');
    expect(screen.queryAllByTestId('pq-mark')).toHaveLength(0);
  });
});
