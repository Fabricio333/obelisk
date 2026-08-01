'use client';

import { useChatStore } from '@/store/chat';
import type { RelayRole } from '@/lib/relay-roles';

/**
 * The badge shown next to a user's name. A user can hold any number of relay
 * roles; only the highest-tier one renders — the store keeps each pubkey's
 * roles most-senior-first, so the badge is simply the head of that list and
 * falls back to the next role when an operator revokes the top one.
 */
export function useTopRole(pubkey: string): RelayRole | null {
  return useChatStore((state) => state.rolesByPubkey[pubkey]?.[0] ?? null);
}

export default function RoleBadge({ pubkey, className }: { pubkey: string; className?: string }) {
  const role = useTopRole(pubkey);
  if (!role) return null;
  return (
    <span
      data-testid="role-badge"
      data-role-id={role.id}
      title={`Role: ${role.name}`}
      className={'shrink-0 truncate rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase leading-normal tracking-wide ' + (className ?? '')}
      style={{ color: role.color, borderColor: `${role.color}59`, backgroundColor: `${role.color}1f` }}
    >
      {role.name}
    </span>
  );
}
