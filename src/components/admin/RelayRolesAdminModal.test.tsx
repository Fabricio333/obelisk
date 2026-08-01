import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import RelayRolesAdminModal, { parsePubkeyInput } from './RelayRolesAdminModal';
import * as roles from '@/lib/relay-roles';
import type { RelayRoles } from '@/lib/relay-roles';

const PEOPLE = [
  { pubkey: 'b'.repeat(64), displayName: 'Bob Builder', nip05: 'bob@obelisk.ar', role: 'member' as const },
  { pubkey: 'c'.repeat(64), displayName: 'Carol Danvers', role: 'admin' as const },
];

vi.mock('@/lib/nostr-bridge', () => ({
  useUserMetadata: () => ({ displayName: 'Alice' }),
  useRelayPeople: () => PEOPLE,
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
    fireEvent.click(within(panel).getByRole('button', { name: 'Grant Moderator to Bob Builder' }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, 'mod', [ALICE, BOB]));

    fireEvent.click(within(panel).getByRole('button', { name: /^Revoke Moderator from/ }));

    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(RELAY, 'mod', []));
  });

  it('searches relay members by name and NIP-05', () => {
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '1 members' }));
    const panel = screen.getByTestId('role-members-mod');
    // Everyone on the relay is offered until the search narrows it.
    expect(within(panel).getByText('Bob Builder')).toBeInTheDocument();
    expect(within(panel).getByText('Carol Danvers')).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: 'carol' } });
    expect(within(panel).queryByText('Bob Builder')).not.toBeInTheDocument();
    expect(within(panel).getByText('Carol Danvers')).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: 'bob@obelisk' } });
    expect(within(panel).getByText('Bob Builder')).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: 'nobody here' } });
    expect(within(panel).getByText('No members match that search.')).toBeInTheDocument();
  });

  it('hides existing holders from the candidate list', () => {
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={{ ...SAVED, holders: { mod: [ALICE, BOB], og: [] } }} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '2 members' }));
    const candidates = screen.getByTestId('role-candidates-mod');
    expect(within(candidates).queryByText('Bob Builder')).not.toBeInTheDocument();
    expect(within(candidates).getByText('Carol Danvers')).toBeInTheDocument();
  });

  it('still grants to a pubkey pasted for a stranger', async () => {
    const publish = vi.spyOn(roles, 'publishRoleHolders').mockResolvedValue(undefined);
    const stranger = 'd'.repeat(64);
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: '1 members' }));
    const panel = screen.getByTestId('role-members-mod');
    fireEvent.change(within(panel).getByLabelText('Grant Moderator to'), { target: { value: nip19.npubEncode(stranger) } });
    fireEvent.click(within(panel).getByRole('button', { name: /not a member of this relay yet/ }));

    await waitFor(() => expect(publish).toHaveBeenCalledWith(RELAY, 'mod', [ALICE, stranger]));
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

  it('opens the emoji picker in a fixed layer the panel cannot clip', () => {
    render(<RelayRolesAdminModal relayUrl={RELAY} roles={SAVED} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'og emoji' }));

    // Absolutely positioned inside the row it would be clipped by the panel's
    // overflow-hidden, and right-aligned it would run off the left edge.
    const popover = screen.getByTestId('role-emoji-popover-og');
    expect(popover).toHaveClass('fixed');
    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toHaveClass('left-0', 'top-full');
    expect(screen.getByRole('button', { name: 'og emoji' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('role-emoji-backdrop'));
    expect(screen.queryByTestId('role-emoji-popover-og')).not.toBeInTheDocument();
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
