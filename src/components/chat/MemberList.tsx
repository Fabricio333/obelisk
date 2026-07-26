'use client';

import { useMemo, useState } from 'react';
import { useChatStore } from '@/store/chat';
import { useGroupMemberInfo } from '@/lib/nostr-bridge';
import type { JsMemberInfo } from '@/lib/nostr-bridge';
import { shortNpub } from '@/lib/mentions';
import { useNostrPresence, PRESENCE_WINDOW_MS } from '@/hooks/chat/useNostrPresence';

function MemberItem({ member, isOnline }: { member: JsMemberInfo; isOnline: boolean }) {
  const name = member.displayName || shortNpub(member.pubkey);
  const openProfilePopup = useChatStore((state) => state.openProfilePopup);

  return (
    <button
      type="button"
      onClick={(event) => openProfilePopup(member.pubkey, { x: event.clientX, y: event.clientY })}
      className="w-full text-left flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors group cursor-pointer"
      data-testid="member-item"
    >
      <div className={`relative shrink-0 ${isOnline ? '' : 'opacity-60'}`}>
        {member.picture ? (
          <img src={member.picture} alt="" className="w-8 h-8 rounded-full object-cover" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-lc-olive flex items-center justify-center">
            <span className="text-xs font-medium text-lc-green">{name.slice(0, 2).toUpperCase()}</span>
          </div>
        )}
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-lc-dark ${
            isOnline ? 'bg-lc-green' : 'bg-lc-muted'
          }`}
          title={isOnline ? 'Online' : 'Offline'}
        />
      </div>
      {member.role === 'admin' && <span title="Admin" aria-label="Role: Admin">🛡️</span>}
      <span className={`text-sm truncate ${isOnline ? 'text-lc-white' : 'text-lc-muted'}`}>
        {name}
      </span>
    </button>
  );
}

export default function MemberList({ groupId }: { groupId: string }) {
  const memberList = useGroupMemberInfo(groupId);
  const lastActivityAt = useChatStore((state) => state.lastActivityAt);
  const presenceTick = useChatStore((state) => state.presenceTick);
  const [offlineCollapsed, setOfflineCollapsed] = useState(false);

  const memberPubkeys = useMemo(() => memberList.map((member) => member.pubkey), [memberList]);
  useNostrPresence(memberPubkeys);

  const onlinePubkeys = useMemo(() => {
    if (!presenceTick) return new Set<string>();
    const cutoff = presenceTick - PRESENCE_WINDOW_MS;
    return new Set(memberPubkeys.filter((pubkey) => (lastActivityAt[pubkey] ?? 0) >= cutoff));
  }, [lastActivityAt, memberPubkeys, presenceTick]);

  const { admins, members, offline } = useMemo(() => {
    const groups = { admins: [] as JsMemberInfo[], members: [] as JsMemberInfo[], offline: [] as JsMemberInfo[] };
    for (const member of memberList) {
      if (!onlinePubkeys.has(member.pubkey)) groups.offline.push(member);
      else if (member.role === 'admin') groups.admins.push(member);
      else groups.members.push(member);
    }
    return groups;
  }, [memberList, onlinePubkeys]);

  const onlineGroups = [
    { label: 'Admin', members: admins },
    { label: 'Member', members },
  ].filter((group) => group.members.length > 0);

  return (
    <div className="w-60 h-full bg-lc-dark border-l border-lc-border flex flex-col shrink-0">
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2" data-testid="member-list">
        {onlineGroups.map((group) => (
          <div key={group.label}>
            <div className="px-2 py-1 text-[10px] font-semibold text-lc-muted uppercase tracking-wider">
              {group.label} — {group.members.length}
            </div>
            {group.members.map((member) => <MemberItem key={member.pubkey} member={member} isOnline />)}
          </div>
        ))}

        {offline.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setOfflineCollapsed((collapsed) => !collapsed)}
              className="flex items-center gap-1.5 px-2 py-1 w-full text-left"
              data-testid="offline-toggle"
            >
              <span className="text-[10px] text-lc-muted">{offlineCollapsed ? '▸' : '▾'}</span>
              <span className="text-[10px] font-semibold text-lc-muted uppercase tracking-wider">
                Offline — {offline.length}
              </span>
            </button>
            {!offlineCollapsed && offline.map((member) => (
              <MemberItem key={member.pubkey} member={member} isOnline={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
