'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGamesStore, selectChannelSessions, selectSession } from '@/store/games';
import { subscribeChannelGames, publishTimeout } from '@/lib/games/transport';
import { controllerOf, isTurnExpired, seatsControlledBy, type GameSession } from '@/lib/games/session';

/**
 * Subscribe to the active channel's game log. One sub per channel, on the
 * active relay only (the transport enforces that) — a table belongs to the
 * channel it was created in, and following a user across relays would open
 * sockets to relays they haven't authenticated against.
 */
export function useChannelGamesSubscription(channelId: string | null): void {
  useEffect(() => {
    if (!channelId) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;

    void subscribeChannelGames(channelId, (ev) => {
      useGamesStore.getState().ingest(ev);
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unsub = fn;
    }).catch((err) => {
      console.warn('[games] subscription failed', err);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [channelId]);
}

/**
 * How often session derivation re-runs against the wall clock. See
 * `useGameSession` — this is not the turn clock, which ticks every second.
 */
export const SESSION_CLOCK_MS = 30_000;

/** A ticking "now" in unix seconds. Drives the turn clock without a re-derive storm. */
export function useNowSeconds(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * One table, replayed from its log. `null` until the create event lands.
 *
 * The clock is deliberately NOT a dependency once a table has started. `now`
 * only decides one thing — whether a table nobody started has gone stale — so
 * re-deriving a live match every second meant replaying the entire event log
 * once a second underneath a game running at 60 frames a second. Waiting
 * tables still follow the clock; their logs are a handful of events.
 */
export function useGameSession(gameId: string | null): GameSession | null {
  const logs = useGamesStore((s) => s.logs);
  // A coarse clock on purpose: `now` decides exactly one thing, whether a
  // table nobody started has gone stale after an hour, and a 30-second
  // granularity is plenty for an hour-long threshold. On a one-second clock
  // this replayed the entire event log every second underneath a game running
  // at sixty frames a second.
  const now = useNowSeconds(SESSION_CLOCK_MS);
  return useMemo(
    () => (gameId ? selectSession({ logs }, gameId, now) : null),
    [logs, gameId, now],
  );
}

/** Every table in a channel, newest first. */
export function useChannelSessions(channelId: string | null): GameSession[] {
  const logs = useGamesStore((s) => s.logs);
  const channelOf = useGamesStore((s) => s.channelOf);
  const now = useNowSeconds(SESSION_CLOCK_MS);
  return useMemo(
    () => (channelId ? selectChannelSessions({ logs, channelOf }, channelId, now) : []),
    [logs, channelOf, channelId, now],
  );
}

/**
 * Publish the timeout claim when the clock runs out on someone else's turn.
 *
 * Somebody has to say it out loud — the deadline is derivable from the log,
 * but a state transition only exists once it is an event. Every client at the
 * table races to publish; the reducer accepts exactly one (first by
 * `created_at`, then by id), so the duplicates are harmless noise.
 *
 * Only clients watching the table claim, and never against their own turn:
 * losing on time should cost you a move you didn't make, not a move your own
 * browser reported you for.
 */
export function useTurnClockEnforcer(
  session: GameSession | null,
  myPubkey: string | null,
  enabled: boolean,
): void {
  const now = useNowSeconds();
  // A ref, not state: "we already claimed this turn" is bookkeeping for the
  // effect, and nothing renders differently because of it. Re-rendering on
  // every claim would just be a cascade.
  const claimed = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !session || !myPubkey || !session.currentTurn) return;
    if (session.status !== 'in_progress') return;
    // Seats, not pubkeys: on a hot-seat table one account holds several seats,
    // and comparing a pubkey to a seat id would have this client reporting
    // its own players for running out the clock.
    if (seatsControlledBy(session, myPubkey).length === 0) return;
    if (controllerOf(session, session.currentTurn) === myPubkey) return;
    if (!isTurnExpired(session, now)) return;

    const key = `${session.id}:${session.turnIndex}`;
    if (claimed.current === key) return;
    claimed.current = key;
    publishTimeout(session.channelId, session.id, session.turnIndex).catch((err) => {
      console.warn('[games] timeout claim failed', err);
    });
  }, [enabled, session, myPubkey, now]);
}
