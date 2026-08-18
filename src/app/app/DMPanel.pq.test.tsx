/**
 * Post-quantum indicators mounted in the desktop DM thread.
 *
 * The UX audit's finding was that the post-quantum journey "dead-ends with
 * zero feedback": the indicators existed, were tested, and were mounted
 * nowhere. These tests pin the mount, the density decision (marks aggregate to
 * protocol transitions rather than one pill per bubble), and the on-accent
 * contrast variant for outgoing bubbles.
 *
 * The conversation-level indicator is now `PqShield`, a single header icon,
 * rather than the full-width banner it replaced. Two of its three states
 * describe the gift wrap rather than post-quantum, so unlike the per-message
 * marks it is NOT gated on the `postQuantumEnabled` preference.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

describe('DMPanel — conversation shield', () => {
  it('reports the wrap when post-quantum is not established', async () => {
    renderPanel();

    const shield = await screen.findByTestId('pq-shield');
    // 'wrapped', not a warning: the thread IS hiding who you talk to, which
    // the banner this replaced never said.
    expect(shield).toHaveAttribute('data-level', 'wrapped');
    expect(shield.getAttribute('aria-label')).toContain('Safe');
  });

  it('offers the guide only from inside the panel, not as standing text', async () => {
    renderPanel();

    const shield = await screen.findByTestId('pq-shield');
    expect(screen.queryByText('How to get extra safe')).not.toBeInTheDocument();
    fireEvent.click(shield);
    expect(screen.getByRole('link', { name: 'How to get extra safe' })).toBeInTheDocument();
  });

  it('confirms when both parties advertise post-quantum keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('pq-shield')).toHaveAttribute('data-level', 'quantum'),
    );
  });

  it('still reports the wrap when the user has post-quantum turned off', async () => {
    // The preference silences the per-message marks, but not the shield: a
    // user who turned post-quantum off still benefits from knowing whether
    // the wrap is hiding who they talk to.
    setPreference('postQuantumEnabled', false);
    dms.current = { [PEER]: [msg({ id: '1', protocol: 'nip04' })] };
    renderPanel();

    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
    expect(screen.getByTestId('pq-shield')).toHaveAttribute('data-level', 'wrapped');
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
    expect(screen.getByTestId('pq-mark')).toHaveTextContent('Who you talk to is visible');
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
    expect(marks.map((m) => m.textContent)).toEqual(['Who you talk to is visible', 'Not extra safe']);
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
