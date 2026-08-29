'use client';

import { useMemo, useState } from 'react';
import type { GameState, HexCoord, TradeResource } from 'vesta';
import { getRobbableVertices, computeRates } from 'vesta';
import type { GameSession } from '@/lib/games/session';
import { vesta, isRobberPending, isStealPending, type VestaAction } from '@/lib/games/vesta/definition';
import VestaBoard, { VESTA_PLAYER_COLORS, type PickMode } from './VestaBoard';

const RESOURCES: TradeResource[] = ['brick', 'lumber', 'wool', 'grain', 'ore'];

const RESOURCE_EMOJI: Record<string, string> = {
  brick: '🧱', lumber: '🪵', wool: '🐑', grain: '🌾', ore: '🪨',
};

const DEV_EMOJI: Record<string, string> = {
  victory: '🪙', knight: '💂', 'road-build': '🌉', 'year-of-plenty': '🧺', monopoly: '👑',
};

export interface VestaTableProps {
  session: GameSession;
  state: GameState;
  /** Seats this account may act for. Several means hot-seat on this machine. */
  mySeats: string[];
  seatLabel: (seatId: string) => string;
  onAction: (action: VestaAction, seat: string) => Promise<void>;
  busy?: boolean;
}

/**
 * The Vesta table: board plus the controls for whatever the game is currently
 * waiting on.
 *
 * Every button is gated by the engine's own `validateAction`, so the UI can
 * never offer a move the reducer would drop — which matters more here than in
 * Chain Reaction, because a rejected move over a relay is silent. If it is not
 * offered, it is not legal.
 */
export default function VestaTable({ session, state, mySeats, seatLabel, onAction, busy }: VestaTableProps) {
  const [pick, setPick] = useState<PickMode>('none');
  const [stealDone, setStealDone] = useState<string | null>(null);
  const [tradePartner, setTradePartner] = useState<number | 'bank' | null>(null);
  const [give, setGive] = useState<Partial<Record<TradeResource, number>>>({});
  const [take, setTake] = useState<Partial<Record<TradeResource, number>>>({});
  const [discard, setDiscard] = useState<Partial<Record<TradeResource, number>>>({});

  const participants = session.participants;
  const turnSeat = session.currentTurn;
  const turnIdx = turnSeat ? participants.indexOf(turnSeat) : -1;

  // The seat this account is acting as right now: the one on move if we hold
  // it, otherwise our only seat (hot-seat players answering a trade).
  const actingSeat = useMemo(() => {
    if (turnSeat && mySeats.includes(turnSeat)) return turnSeat;
    return mySeats.length === 1 ? mySeats[0] : null;
  }, [turnSeat, mySeats]);

  const actingIdx = actingSeat ? participants.indexOf(actingSeat) : -1;
  const myTurn = !!turnSeat && mySeats.includes(turnSeat);
  const isSetup = state.phase === 'initial_first' || state.phase === 'initial_second';

  const can = (action: VestaAction, seat = actingSeat): boolean => {
    if (!seat) return false;
    return vesta.validateAction(state, action, seat, participants).ok;
  };

  const send = async (action: VestaAction, seat = actingSeat) => {
    if (!seat) return;
    setPick('none');
    await onAction(action, seat);
  };

  // The board asks for what the rules are waiting on, and only falls back to
  // the player's chosen build mode when nothing is outstanding.
  const robberPending = isRobberPending(state) && myTurn;
  const forcedPick: PickMode = isSetup && myTurn
    ? (state.setupStep === 'settlement' ? 'initial-settlement' : 'initial-road')
    : robberPending ? 'robber' : 'none';
  const mode: PickMode = forcedPick !== 'none' ? forcedPick : pick;

  // Who the robber can take from, straight off the board it is standing on.
  const stealVictims = isStealPending(state) && myTurn && actingIdx >= 0
    ? getRobbableVertices(state, actingIdx, state.board.robber.q, state.board.robber.r)
        .map((v) => v.owner)
        .filter((owner, i, arr) => arr.indexOf(owner) === i)
    : [];
  const stealKey = `${state.board.robber.q},${state.board.robber.r}`;
  const showSteal = stealVictims.length > 0 && stealDone !== stealKey;

  const sevenRolled = state.dice !== null && state.dice[0] + state.dice[1] === 7;
  const myHandSize = actingIdx >= 0
    ? RESOURCES.reduce((n, r) => n + (state.players[actingIdx]?.resources[r] ?? 0), 0)
    : 0;
  const mustDiscard = sevenRolled && myHandSize > 7;

  const pendingTrade = state.pendingTrade;
  const iAmTradeTarget = !!pendingTrade && pendingTrade.to === actingIdx;
  const iAmProposer = !!pendingTrade && pendingTrade.from === actingIdx;

  const rates = actingIdx >= 0 ? computeRates(state, actingIdx) : null;

  return (
    <div className="space-y-3">
      <VestaBoard
        state={state}
        mode={mode}
        onPickVertex={(spot) => {
          if (mode === 'city') void send({ type: 'place-city', ...spot } as VestaAction);
          else void send({ type: 'place-settlement', ...spot } as VestaAction);
        }}
        onPickEdge={(edge) => void send({ type: 'place-road', ...edge } as VestaAction)}
        onPickHex={(hex: HexCoord) => void send({ type: 'move-robber', q: hex.q, r: hex.r } as VestaAction)}
      />

      {/* Players */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {participants.map((seat, i) => {
          const p = state.players[i];
          if (!p) return null;
          const onMove = i === turnIdx;
          const mine = mySeats.includes(seat);
          return (
            <div
              key={seat}
              className={`rounded-lg border p-2 ${onMove ? 'border-lc-white' : 'border-lc-border'}`}
              data-testid={`vesta-player-${i}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: VESTA_PLAYER_COLORS[i] }} />
                <span className={`truncate text-[11px] ${mine ? 'text-lc-white' : 'text-lc-muted'}`}>
                  {seatLabel(seat)}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-lc-muted">
                <span>{p.vp} VP</span>
                <span>
                  {mine
                    ? RESOURCES.map((r) => `${RESOURCE_EMOJI[r]}${p.resources[r] ?? 0}`).join(' ')
                    : `🎴 ${RESOURCES.reduce((n, r) => n + (p.resources[r] ?? 0), 0)}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Status line */}
      <div className="rounded-lg border border-lc-border bg-lc-black/40 p-2 text-center text-[11px] text-lc-muted">
        {state.winner !== null && state.winner !== undefined
          ? `${seatLabel(participants[state.winner] ?? '')} wins`
          : isSetup
            ? `Setup — ${seatLabel(turnSeat ?? '')} places a ${state.setupStep}`
            : state.dice
              ? `🎲 ${state.dice[0]} + ${state.dice[1]} = ${state.dice[0] + state.dice[1]}`
              : `${seatLabel(turnSeat ?? '')} to roll`}
      </div>

      {/* The seven: everyone over seven cards discards, whoever's turn it is */}
      {mustDiscard && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3" data-testid="vesta-discard">
          <p className="text-[11px] text-lc-white">
            A seven — discard {Math.floor(myHandSize / 2)} of your {myHandSize} cards.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {RESOURCES.map((r) => (
              <Counter
                key={r}
                label={`${RESOURCE_EMOJI[r]}`}
                value={discard[r] ?? 0}
                max={state.players[actingIdx]?.resources[r] ?? 0}
                onChange={(v) => setDiscard((d) => ({ ...d, [r]: v }))}
              />
            ))}
          </div>
          <button
            type="button"
            disabled={busy || sum(discard) !== Math.floor(myHandSize / 2)}
            onClick={() => {
              void send({ type: 'discard-resources', resources: filled(discard) } as VestaAction);
              setDiscard({});
            }}
            className="lc-pill-primary mt-2 px-4 py-1 text-xs"
          >
            Discard {sum(discard)}/{Math.floor(myHandSize / 2)}
          </button>
        </div>
      )}

      {/* Someone offered us a trade */}
      {pendingTrade && (iAmTradeTarget || iAmProposer) && (
        <div className="rounded-lg border border-lc-border p-3" data-testid="vesta-trade-offer">
          <p className="text-[11px] text-lc-white">
            {seatLabel(participants[pendingTrade.from] ?? '')} offers{' '}
            {describe(pendingTrade.give)} for {describe(pendingTrade.take)}
          </p>
          <div className="mt-2 flex gap-2">
            {iAmTradeTarget && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send({ type: 'accept-trade' } as VestaAction)}
                  className="lc-pill-primary px-3 py-1 text-xs"
                >
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void send({ type: 'reject-trade' } as VestaAction)}
                  className="lc-pill-secondary px-3 py-1 text-xs"
                >
                  Reject
                </button>
              </>
            )}
            {iAmProposer && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void send({ type: 'cancel-proposal' } as VestaAction)}
                className="lc-pill-secondary px-3 py-1 text-xs"
              >
                Withdraw
              </button>
            )}
          </div>
        </div>
      )}

      {/* The robber is out and wants a target */}
      {robberPending && (
        <p className="rounded-lg border border-lc-green/40 bg-lc-green/10 p-2 text-center text-[11px] text-lc-green" data-testid="vesta-robber-prompt">
          Pick a tile for the robber.
        </p>
      )}

      {/* Who to rob */}
      {showSteal && (
        <div className="rounded-lg border border-lc-border p-3" data-testid="vesta-steal">
          <p className="text-[11px] text-lc-white">Steal from…</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {stealVictims.map((victim) => (
              <div key={victim} className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-lc-muted">{seatLabel(participants[victim] ?? '')}:</span>
                {RESOURCES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={busy || !can({ type: 'steal-resource', victim, resource: r } as VestaAction)}
                    onClick={() => void send({ type: 'steal-resource', victim, resource: r } as VestaAction)}
                    className="rounded border border-lc-border px-1.5 py-0.5 text-[11px] disabled:opacity-30"
                  >
                    {RESOURCE_EMOJI[r]}
                  </button>
                ))}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setStealDone(stealKey)}
              className="lc-pill-secondary px-3 py-0.5 text-[11px]"
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* Turn actions */}
      {myTurn && state.winner === null && !isSetup && (
        <div className="flex flex-wrap gap-2" data-testid="vesta-actions">
          <Action label="🎲 Roll" enabled={!busy && can({ type: 'roll-dice' } as VestaAction)} onClick={() => void send({ type: 'roll-dice' } as VestaAction)} />
          <Toggle label="🛖 Settlement" active={pick === 'settlement'} enabled={!busy && state.rolled} onClick={() => setPick(pick === 'settlement' ? 'none' : 'settlement')} />
          <Toggle label="🛣 Road" active={pick === 'road'} enabled={!busy && state.rolled} onClick={() => setPick(pick === 'road' ? 'none' : 'road')} />
          <Toggle label="🏯 City" active={pick === 'city'} enabled={!busy && state.rolled} onClick={() => setPick(pick === 'city' ? 'none' : 'city')} />
          <Action label="🎴 Dev card" enabled={!busy && can({ type: 'buy-dev-card' } as VestaAction)} onClick={() => void send({ type: 'buy-dev-card' } as VestaAction)} />
          <Action label="↪ End turn" enabled={!busy && can({ type: 'end-turn' } as VestaAction)} onClick={() => void send({ type: 'end-turn' } as VestaAction)} />
        </div>
      )}

      {/* Development cards in hand */}
      {actingIdx >= 0 && (state.players[actingIdx]?.hand.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="vesta-hand">
          {state.players[actingIdx]!.hand.map((card, i) => (
            <button
              key={`${card.cardType}-${i}`}
              type="button"
              disabled={busy || !myTurn || !card.available || !can({ type: 'play-dev-card', cardType: card.cardType } as VestaAction)}
              onClick={() => void send({ type: 'play-dev-card', cardType: card.cardType } as VestaAction)}
              className="rounded-full border border-lc-border px-2.5 py-1 text-[11px] text-lc-white disabled:opacity-30"
            >
              {DEV_EMOJI[card.cardType] ?? '🎴'} {card.cardType}
            </button>
          ))}
        </div>
      )}

      {/* Trading */}
      {myTurn && state.rolled && !isSetup && state.winner === null && (
        <details className="rounded-lg border border-lc-border p-2" data-testid="vesta-trade">
          <summary className="cursor-pointer text-[11px] text-lc-muted">Trade</summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] uppercase tracking-wide text-lc-muted">With</span>
              <Chip label={`Bank${rates ? '' : ''}`} active={tradePartner === 'bank'} onClick={() => setTradePartner('bank')} />
              {participants.map((seat, i) => i === actingIdx ? null : (
                <Chip key={seat} label={seatLabel(seat)} active={tradePartner === i} onClick={() => setTradePartner(i)} />
              ))}
            </div>
            <Row label="Give" values={give} setValues={setGive} max={(r) => state.players[actingIdx]?.resources[r] ?? 0} />
            <Row label="Take" values={take} setValues={setTake} max={() => 19} />
            {rates && tradePartner === 'bank' && (
              <p className="text-[10px] text-lc-muted">
                Bank rates: {RESOURCES.map((r) => `${RESOURCE_EMOJI[r]}${rates[r]}:1`).join('  ')}
              </p>
            )}
            <button
              type="button"
              disabled={
                busy || tradePartner === null
                || !can(tradeAction(tradePartner, give, take))
              }
              onClick={() => {
                void send(tradeAction(tradePartner!, give, take));
                setGive({});
                setTake({});
              }}
              className="lc-pill-primary px-4 py-1 text-xs"
            >
              {tradePartner === 'bank' ? 'Trade with bank' : 'Offer trade'}
            </button>
          </div>
        </details>
      )}

      {!myTurn && state.winner === null && (
        <p className="text-center text-[11px] text-lc-muted">
          Waiting for {seatLabel(turnSeat ?? '')}…
        </p>
      )}
    </div>
  );
}

function tradeAction(
  partner: number | 'bank' | null,
  give: Partial<Record<TradeResource, number>>,
  take: Partial<Record<TradeResource, number>>,
): VestaAction {
  if (partner === 'bank') {
    return { type: 'trade', partner: 'bank', give: filled(give), take: filled(take) } as VestaAction;
  }
  return { type: 'propose-trade', partner: partner ?? 0, give: filled(give), take: filled(take) } as VestaAction;
}

function filled(v: Partial<Record<TradeResource, number>>): Record<TradeResource, number> {
  const out = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 } as Record<TradeResource, number>;
  for (const r of RESOURCES) out[r] = v[r] ?? 0;
  return out;
}

function sum(v: Partial<Record<TradeResource, number>>): number {
  return RESOURCES.reduce((n, r) => n + (v[r] ?? 0), 0);
}

function describe(v: Partial<Record<TradeResource, number>>): string {
  const parts = RESOURCES.filter((r) => (v[r] ?? 0) > 0).map((r) => `${v[r]}${RESOURCE_EMOJI[r]}`);
  return parts.length > 0 ? parts.join(' ') : 'nothing';
}

function Action({ label, enabled, onClick }: { label: string; enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className="rounded-full border border-lc-border px-3 py-1 text-[11px] text-lc-white transition-colors hover:border-lc-green disabled:opacity-30 disabled:hover:border-lc-border"
    >
      {label}
    </button>
  );
}

function Toggle({ label, active, enabled, onClick }: { label: string; active: boolean; enabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11px] transition-colors disabled:opacity-30 ${
        active ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-white'
      }`}
    >
      {label}
    </button>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[10px] ${
        active ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-muted'
      }`}
    >
      {label}
    </button>
  );
}

function Counter({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-lc-border px-1.5 py-0.5 text-[11px]">
      <span>{label}</span>
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} className="px-1 text-lc-muted">−</button>
      <span className="w-3 text-center text-lc-white">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} className="px-1 text-lc-muted">+</button>
    </span>
  );
}

function Row({
  label,
  values,
  setValues,
  max,
}: {
  label: string;
  values: Partial<Record<TradeResource, number>>;
  setValues: (fn: (v: Partial<Record<TradeResource, number>>) => Partial<Record<TradeResource, number>>) => void;
  max: (r: TradeResource) => number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-9 text-[10px] uppercase tracking-wide text-lc-muted">{label}</span>
      {RESOURCES.map((r) => (
        <Counter
          key={r}
          label={RESOURCE_EMOJI[r]}
          value={values[r] ?? 0}
          max={max(r)}
          onChange={(v) => setValues((cur) => ({ ...cur, [r]: v }))}
        />
      ))}
    </div>
  );
}
