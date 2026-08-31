'use client';

import { useCallback, useMemo, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import UserAvatar from '@/components/UserAvatar';
import { useGroupMemberInfo, useMyPubkey } from '@/lib/nostr-bridge';
import { useGamesStore } from '@/store/games';
import { canJoin, canStart, turnSecondsLeft } from '@/lib/games/session';
import {
  publishAttack,
  publishCancel,
  publishCheckpoint,
  publishJoin,
  publishMove,
  publishResign,
  publishStart,
  publishTopOut,
} from '@/lib/games/transport';
import { useGameSession, useNowSeconds, useTurnClockEnforcer } from '@/hooks/chat/useChannelGames';
import ChainReactionBoard, { SEAT_COLORS } from './ChainReactionBoard';
import GameOverOverlay from './GameOverOverlay';
import VestaTable from './vesta/VestaTable';
import StackerTable from './stacker/StackerTable';
import StartTableModal from './StartTableModal';
import GameResults from './GameResults';
import type { GameState } from 'vesta';
import type { VestaAction } from '@/lib/games/vesta/definition';
import { seatsControlledBy } from '@/lib/games/session';
import { gameIcon, gameName } from '@/lib/games/catalog';
import { seatDisplayLabel } from '@/lib/games/seat-label';

/**
 * The table itself: roster while waiting, board while playing, result when
 * done. Every button here publishes one event and then does nothing — the UI
 * updates when that event comes back off the relay, exactly like a chat
 * message. There is no optimistic local board, because a board the relay
 * hasn't accepted is a board the other players cannot see.
 */
export default function GameModal({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const session = useGameSession(gameId);
  const myPubkey = useMyPubkey();
  const memberList = useGroupMemberInfo(session?.channelId ?? null);
  const now = useNowSeconds();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seatPickerOpen, setSeatPickerOpen] = useState(false);
  // Phones get fullscreen by default: a 20-row well plus rails does not fit
  // in a dialog on a handset, and the board was being cut off top and bottom.
  const [fullscreen, setFullscreen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768,
  );

  // Every client watching a table helps enforce its clock.
  useTurnClockEnforcer(session, myPubkey, true);

  /**
   * A person's name — the same string for everybody looking.
   *
   * Deliberately NOT "you" for the current user: this feeds the seat labels
   * that get published in the `start` event, and a viewer-relative word there
   * is written into shared state. It was, and every other player at the table
   * saw a player called "Vos".
   *
   * Marking which seat is yours is a rendering job, done per viewer below.
   */
  const nameOf = useCallback(
    (pubkey: string) => memberList.find((m) => m.pubkey === pubkey)?.displayName ?? pubkey.slice(0, 8),
    [memberList],
  );

  // A seat can carry its own name — that is how two people sharing one
  // account show up as two players rather than twice as the same person.
  const seatLabelFor = useCallback((seatId: string) => {
    const seat = session?.seats.find((s2) => s2.id === seatId);
    // Tables created before this was fixed carry a literal "Vos" as somebody's
    // name. `seatDisplayLabel` treats those as absent and falls back to the
    // profile, so nobody is shown a name that means "you" about someone else.
    return seatDisplayLabel(seat?.label, nameOf(seat?.by ?? seatId));
  }, [session, nameOf]);

  const pictureOf = useCallback(
    (pubkey: string) => memberList.find((m) => m.pubkey === pubkey)?.picture ?? null,
    [memberList],
  );

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relay rejected that');
    } finally {
      setBusy(false);
    }
  }, []);

  const onAction = useCallback(async (action: { cell: number }, seat: string) => {
    if (!session) return;
    await run(() => publishMove(session.channelId, session.id, session.turnIndex, action, seat));
  }, [session, run]);

  // Vesta moves name their seat: one account can hold several of them.
  const onSeatAction = useCallback(async (action: VestaAction, seat: string) => {
    if (!session) return;
    await run(() => publishMove(session.channelId, session.id, session.turnIndex, action, seat));
  }, [session, run]);

  const secondsLeft = session ? turnSecondsLeft(session, now) : null;
  const mySeats = session ? seatsControlledBy(session, myPubkey) : [];

  const roster = useMemo(
    () => (session ? (session.status === 'waiting' ? session.joined : session.participants) : []),
    [session],
  );

  if (!session) {
    return (
      <ModalShell onClose={onClose} testId="game-modal" panelClassName="w-full max-w-md mx-4 rounded-xl bg-lc-dark border border-lc-border p-6">
        <div className="lc-skeleton h-40 w-full rounded-lg" />
        <p className="mt-3 text-center text-xs text-lc-muted">Loading the table from the relay…</p>
      </ModalShell>
    );
  }

  // Resigning names a seat, because one account can hold several: the seat on
  // move if it is ours, else our only one.
  const resignSeat = session.currentTurn && mySeats.includes(session.currentTurn)
    ? session.currentTurn
    : mySeats.length === 1 ? mySeats[0] : null;

  return (
    <ModalShell
      onClose={onClose}
      testId="game-modal"
      panelClassName={
        fullscreen
          ? 'relative flex h-[100dvh] w-screen flex-col overflow-y-auto bg-lc-dark p-3'
          : 'relative max-h-[92vh] w-full max-w-3xl mx-4 overflow-y-auto rounded-xl bg-lc-dark border border-lc-border p-5'
      }
    >
      {seatPickerOpen && (
        <StartTableModal
          session={session}
          nameOf={nameOf}
          onClose={() => setSeatPickerOpen(false)}
          onStart={(seats) => {
            setSeatPickerOpen(false);
            void run(() => publishStart(session.channelId, session.id, seats));
          }}
        />
      )}

      <GameOverOverlay
        session={session}
        myPubkey={myPubkey}
        nameOf={nameOf}
        pictureOf={pictureOf}
        onClose={onClose}
      />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-lc-white" data-testid="game-modal-title">
            {gameIcon(session.game)} {gameName(session.game)}
          </h2>
          <p className="text-[11px] text-lc-muted">
            {session.status === 'waiting' && `Waiting for players · ${session.joined.length}/${session.maxPlayers}`}
            {session.status === 'in_progress' && (
              session.match
                ? `${session.match.alive.length} still standing`
                : session.currentTurn && mySeats.includes(session.currentTurn)
                  ? 'Your turn'
                  : `${seatLabelFor(session.currentTurn ?? '')}'s turn`
            )}
            {session.status === 'finished' && (
              session.draw ? 'Draw' : session.winner ? `${nameOf(session.winner)} won` : 'Game over'
            )}
            {session.status === 'cancelled' && 'Table cancelled'}
            {session.status === 'in_progress' && secondsLeft !== null && ` · ${secondsLeft}s`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setFullscreen((v) => !v)}
            className="text-lc-muted hover:text-lc-white text-sm leading-none"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            data-testid="game-fullscreen"
          >
            {fullscreen ? '🗗' : '⛶'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-lc-muted hover:text-lc-white text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      <div className="mt-4">
        {session.status === 'waiting' || session.status === 'cancelled' ? (
          <ul className="space-y-2" data-testid="game-roster">
            {roster.map((pk, i) => (
              <li key={pk} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: SEAT_COLORS[i]?.hex }} />
                <UserAvatar pubkey={pk} picture={pictureOf(pk)} size={6} name={nameOf(pk)} />
                <span className="text-xs text-lc-white">{nameOf(pk)}</span>
                {pk === myPubkey && (
                  <span className="text-[10px] text-lc-muted">(you)</span>
                )}
                {pk === session.createdBy && (
                  <span className="rounded-full border border-lc-border px-1.5 text-[10px] text-lc-muted">host</span>
                )}
              </li>
            ))}
          </ul>
        ) : session.match ? (
          <StackerTable
            session={session}
            match={session.match}
            mySeats={mySeats}
            seatLabel={seatLabelFor}
            onAttack={(seat, target, lines, hole, nonce) => {
              // Fire and forget: a dropped attack must never stall the board.
              publishAttack(session.channelId, session.id, { seat, target, lines, hole, nonce })
                .catch((err) => console.warn('[stacker] attack failed to publish', err));
            }}
            onCheckpoint={(seat, payload) => {
              publishCheckpoint(session.channelId, session.id, { seat, ...payload })
                .catch((err) => console.warn('[stacker] checkpoint failed to publish', err));
            }}
            onTopOut={(seat) => {
              publishTopOut(session.channelId, session.id, seat)
                .catch((err) => console.warn('[stacker] topout failed to publish', err));
            }}
            fullscreen={fullscreen}
          />
        ) : session.game === 'vesta' ? (
          <VestaTable
            session={session}
            state={session.state as GameState}
            mySeats={mySeats}
            seatLabel={seatLabelFor}
            onAction={onSeatAction}
            busy={busy}
          />
        ) : (
          // Deliberately the same element in the same place whether the table
          // is running or finished: swapping it for a results panel unmounted
          // the board mid-animation, so the winning explosion — the one worth
          // watching — was the one nobody ever saw.
          <ChainReactionBoard
            game={session}
            mySeats={mySeats}
            onAction={onAction}
            maxWidth={fullscreen ? 560 : 420}
            seatLabel={seatLabelFor}
          />
        )}
      </div>

      {session.status === 'finished' && (
        <div className="mt-4">
          <GameResults session={session} seatLabel={seatLabelFor} myPubkey={myPubkey} />
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canJoin(session, myPubkey) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => publishJoin(session.channelId, session.id))}
            className="lc-pill-primary px-4 py-1.5 text-xs"
            data-testid="game-join"
          >
            Join
          </button>
        )}
        {canStart(session, myPubkey) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setSeatPickerOpen(true)}
            className="lc-pill-primary px-4 py-1.5 text-xs"
            data-testid="game-start"
          >
            Start ({session.joined.length})
          </button>
        )}
        {session.status === 'waiting' && myPubkey === session.createdBy && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => publishCancel(session.channelId, session.id))}
            className="lc-pill-secondary px-4 py-1.5 text-xs"
          >
            Cancel table
          </button>
        )}
        {session.status === 'in_progress' && resignSeat && !session.eliminated.includes(resignSeat) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => publishResign(session.channelId, session.id, resignSeat))}
            className="lc-pill-secondary px-4 py-1.5 text-xs"
            data-testid="game-resign"
          >
            Resign
          </button>
        )}
        {session.status === 'waiting' && session.joined.length < session.minPlayers && (
          <span className="text-[11px] text-lc-muted">
            Needs {session.minPlayers} players to start.
          </span>
        )}
      </div>
    </ModalShell>
  );
}

/** Mounts the modal for whatever table the store says is open. */
export function GameModalHost() {
  const openGameId = useGamesStore((s) => s.openGameId);
  const setOpenGame = useGamesStore((s) => s.setOpenGame);
  if (!openGameId) return null;
  return <GameModal gameId={openGameId} onClose={() => setOpenGame(null)} />;
}
