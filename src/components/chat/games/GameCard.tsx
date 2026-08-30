'use client';

import { useGroupMemberInfo, useMyPubkey } from '@/lib/nostr-bridge';
import { useGamesStore } from '@/store/games';
import { useGameSession } from '@/hooks/chat/useChannelGames';
import { canJoin } from '@/lib/games/session';
import { gameIcon, gameName } from '@/lib/games/catalog';
import { SEAT_COLORS } from './ChainReactionBoard';

/**
 * In-channel card for a table, rendered from the `[[game:<id>]]` marker the
 * host posts as an ordinary chat message. The card is a pointer, not a copy:
 * status comes from replaying the table's own event log, so a message from an
 * hour ago shows the match as it stands now.
 */
export default function GameCard({ gameId }: { gameId: string }) {
  const session = useGameSession(gameId);
  const myPubkey = useMyPubkey();
  const memberList = useGroupMemberInfo(session?.channelId ?? null);
  const setOpenGame = useGamesStore((s) => s.setOpenGame);

  if (!session) {
    return (
      <span className="mt-1 block max-w-sm rounded-lg border border-lc-border bg-lc-dark p-3" data-testid="game-card-loading">
        <span className="lc-skeleton block h-4 w-32 rounded" />
      </span>
    );
  }

  // A finished table says who took it — the result is the whole point of
  // looking at a game card after the fact.
  // Rendered per viewer and never published, so naming the reader is safe
  // here — unlike the seat labels that travel in the `start` event.
  const nameOf = (pubkey: string) => {
    if (pubkey === myPubkey) return 'you';
    return memberList.find((m) => m.pubkey === pubkey)?.displayName ?? pubkey.slice(0, 8);
  };

  const label =
    session.status === 'waiting' ? `Open table · ${session.joined.length}/${session.maxPlayers}`
    : session.status === 'in_progress' ? 'In progress'
    : session.status === 'finished'
      ? (session.draw || !session.winner ? 'Finished · draw' : `🏆 ${nameOf(session.winner)} won`)
    : 'Cancelled';

  const seats = session.status === 'waiting' ? session.joined : session.participants;

  return (
    <button
      type="button"
      onClick={() => setOpenGame(gameId)}
      className="mt-1 flex w-full max-w-sm items-center gap-3 rounded-lg border border-lc-border bg-lc-dark p-3 text-left transition-colors hover:border-lc-green/60"
      data-testid="game-card"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lc-green/15 text-base">
        {gameIcon(session.game)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-lc-white" data-testid="game-card-name">
          {gameName(session.game)}
        </span>
        <span className="block text-[11px] text-lc-muted">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {seats.slice(0, SEAT_COLORS.length).map((pk, i) => (
          <span key={pk} className="h-2 w-2 rounded-full" style={{ background: SEAT_COLORS[i]?.hex }} />
        ))}
      </span>
      <span className="shrink-0 rounded-full border border-lc-border px-2 py-0.5 text-[10px] text-lc-white">
        {canJoin(session, myPubkey) ? 'Join'
          : session.status === 'finished' ? 'Result'
          : 'Open'}
      </span>
    </button>
  );
}
