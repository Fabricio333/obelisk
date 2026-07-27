import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OBELISK_SIGNING_KINDS } from '@/lib/nostr-signing-kinds';
import DeveloperSignatureTest from './DeveloperSignatureTest';

const signEventTemplate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: { signEventTemplate: (...args: unknown[]) => signEventTemplate(...args) },
  useSignerReady: () => true,
}));

describe('DeveloperSignatureTest', () => {
  beforeEach(() => signEventTemplate.mockReset().mockResolvedValue({ id: 'signed' }));

  it('requests every required signature without publishing anything', async () => {
    render(<DeveloperSignatureTest />);
    fireEvent.click(screen.getByTestId('request-mock-signatures'));

    await waitFor(() => expect(signEventTemplate).toHaveBeenCalledTimes(OBELISK_SIGNING_KINDS.length));
    expect(signEventTemplate.mock.calls.map(([template]) => template.kind)).toEqual(OBELISK_SIGNING_KINDS);
    expect(signEventTemplate.mock.calls.every(([template]) => template.content.includes('not published'))).toBe(true);
    expect(await screen.findByRole('status')).toHaveTextContent(`${OBELISK_SIGNING_KINDS.length} accepted · 0 rejected`);
  });
});
