import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import RelayRolesAdminModal, { parsePubkeyInput } from './RelayRolesAdminModal';
import * as roles from '@/lib/relay-roles';
import type { RelayRoles } from '@/lib/relay-roles';

vi.mock('@/lib/nostr-bridge', () => ({
  useUserMetadata: () => ({ displayName: 'Alice' }),
}));

const RELAY = 'wss://relay.test';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

const SAVED: RelayRoles = {
  roles: [
    { id: 'mod', name: 'Moderator', tier: 2, color: '#ff0000', emoji: '🛡️' },
    { id: 'og', name: 'OG', tier: 1, color: '#00ff00', emoji: '' },
  ],
  holders: { mod: [ALICE], og: [] },
  updatedAt: 10,
};

afterEach(() => vi.restoreAllMocks());

describe('RelayRolesAdminModal', () => {
  it('publishes a new role at the bottom of the ladder', async () => {
    const publish = vi.spyOn(roles, 'publishRoleCatalog').mockResolvedValue(undefined);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('New role name'), { target: { value: 'Contributor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, [
      { id: 'mod', name: 'Moderator', tier: 3, color: '#ff0000', emoji: '🛡️' },
      { id: 'og', name: 'OG', tier: 2, color: '#00ff00', emoji: '' },
      { id: 'contributor', name: 'Contributor', tier: 1, color: roles.DEFAULT_ROLE_COLOR, emoji: '' },
    ]));
  });

  it('re-tiers roles when the operator moves one up', async () => {
    const publish = vi.spyOn(roles, 'publishRoleCatalog').mockResolvedValue(undefined);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move OG up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, [
      { id: 'og', name: 'OG', tier: 2, color: '#00ff00', emoji: '' },
      { id: 'mod', name: 'Moderator', tier: 1, color: '#ff0000', emoji: '🛡️' },
    ]));
  });

  it('grants and revokes a role for one member', async () => {
    const publish = vi.spyOn(roles, 'publishRoleHolders').mockResolvedValue(undefined);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '1 members' }));
    const panel = screen.getByTestId('role-members-mod');
    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: BOB } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, 'mod', [ALICE, BOB]));

    fireEvent.click(within(panel).getByRole('button', { name: /^Revoke Moderator from/ }));

    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(RELAY, 'mod', []));
  });

  it('rejects an unparseable pubkey instead of publishing it', async () => {
    const publish = vi.spyOn(roles, 'publishRoleHolders').mockResolvedValue(undefined);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '1 members' }));
    const panel = screen.getByTestId('role-members-mod');
    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: 'alice@example.com' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Grant' }));

    expect(publish).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Enter an npub or a 64-character hex pubkey.');
  });

  it('defers assignment until a freshly added role exists on the relay', () => {
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('New role name'), { target: { value: 'Contributor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));

    const row = screen.getByTestId('role-row-contributor');
    expect(within(row).getByRole('button', { name: '0 members' })).toBeDisabled();
  });

  it('picks a badge emoji for a role and clears it again', async () => {
    const publish = vi.spyOn(roles, 'publishRoleCatalog').mockResolvedValue(undefined);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'og emoji' }));
    fireEvent.click(screen.getByTitle('grinning'));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, [
      { id: 'mod', name: 'Moderator', tier: 2, color: '#ff0000', emoji: '🛡️' },
      { id: 'og', name: 'OG', tier: 1, color: '#00ff00', emoji: '😀' },
    ]));

    // Clearing puts the draft back to what the relay already has, so the row
    // returns to its placeholder and there is nothing left to publish.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save roles' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Clear og emoji' }));

    expect(screen.getByRole('button', { name: 'og emoji' })).toHaveTextContent('+');
    expect(screen.queryByRole('button', { name: 'Clear og emoji' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save roles' })).toBeDisabled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('shows the saved emoji on its role row', () => {
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    expect(screen.getByRole('button', { name: 'mod emoji' })).toHaveTextContent('🛡️');
    expect(screen.getByRole('button', { name: 'og emoji' })).toHaveTextContent('+');
  });

  it('accepts npub and hex pubkeys', () => {
    expect(parsePubkeyInput(' ' + ALICE.toUpperCase() + ' ')).toBe(ALICE);
    expect(parsePubkeyInput(nip19.npubEncode(BOB))).toBe(BOB);
    expect(parsePubkeyInput(nip19.nprofileEncode({ pubkey: BOB, relays: [RELAY] }))).toBe(BOB);
    expect(parsePubkeyInput('nope')).toBeNull();
  });
});
