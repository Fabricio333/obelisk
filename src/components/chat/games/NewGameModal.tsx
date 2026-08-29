'use client';

import { useRef, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import { CR_SIZES, type CRSizeKey } from '@/lib/games/chain-reaction';
import { readResumeState, playerCountOf, normalizeSeed } from '@/lib/games/vesta/definition';
import { gameCatalog, gameSummary, type GameInfo } from '@/lib/games/catalog';
import { publishCreate, publishStart } from '@/lib/games/transport';
import { localSeatId } from '@/lib/games/protocol';
import { gameMarker } from '@/lib/games/protocol';
import { useGamesStore } from '@/store/games';
import { useMyPubkey } from '@/lib/nostr-bridge';
import { GameTypePreview } from './GamePreviews';

const TIMEOUTS: Array<{ label: string; seconds: number }> = [
  { label: 'No clock', seconds: 0 },
  { label: '30s', seconds: 30 },
  { label: '45s', seconds: 45 },
  { label: '2m', seconds: 120 },
  { label: '5m', seconds: 300 },
];

/**
 * Pick a game, set it up, open the table.
 *
 * Two steps, like the classic stack's picker: a list of what is playable with
 * a thumbnail each, then that game's own options. Everything shown comes from
 * the catalog keyed by game type — no screen hardcodes a game's name, which is
 * how a Vesta table used to end up captioned "Chain Reaction".
 *
 * Creating publishes the `create` event and then posts the `[[game:<id>]]`
 * marker as a chat message. Nobody is seated here beyond the host: who plays,
 * and which seats are local, is decided at `start` (see StartTableModal),
 * because until people have joined there is nobody to seat.
 */
export default function NewGameModal({
  channelId,
  onClose,
  onPostMarker,
}: {
  channelId: string;
  onClose: () => void;
  /** Posts the in-channel card. Given the table id once the relay accepts it. */
  onPostMarker: (marker: string) => void;
}) {
  const catalog = gameCatalog();
  const [selected, setSelected] = useState<GameInfo | null>(null);
  const [size, setSize] = useState<CRSizeKey>('medium');
  const [seed, setSeed] = useState(() => String(Math.floor(Date.now() / 1000) % 100000));
  const [resume, setResume] = useState<{ data: unknown; players: number; name: string } | null>(null);
  const [timeout, setTimeoutS] = useState(0);
  // 0 = a table other people join. Anything else opens and starts immediately
  // with that many players sharing this keyboard.
  const [localPlayers, setLocalPlayers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const setOpenGame = useGamesStore((s) => s.setOpenGame);
  const myPubkey = useMyPubkey();

  function choose(info: GameInfo) {
    setSelected(info);
    setResume(null);
    setError(null);
    // Each game brings its own sane clock: Chain Reaction is one click a turn,
    // a Vesta turn is a whole sequence of decisions.
    setTimeoutS(info.defaultTurnTimeoutS);
    setLocalPlayers(0);
  }

  async function loadSave(file: File) {
    setError(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const state = readResumeState(parsed);
      if (!state) {
        setError('That file is not a Vesta save.');
        return;
      }
      setResume({ data: parsed, players: playerCountOf(parsed) ?? state.players.length, name: file.name });
    } catch {
      setError('Could not read that file.');
    }
  }

  async function create() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const opts: Record<string, unknown> =
        selected.type === 'vesta'
          ? (resume ? { resume: resume.data } : { seed: normalizeSeed(seed) })
          : selected.type === 'chain-reaction'
            ? { size }
            // Stacker: the seed decides the piece order every player receives,
            // so it is the one thing the whole match has to agree on.
            : selected.type === 'stacker'
              ? { seed: normalizeSeed(seed) }
              : {};
      // The game published is the game selected — the whole table hangs off
      // this one string, so it comes straight from the chosen catalog entry.
      const gameId = await publishCreate(channelId, {
        game: selected.type,
        opts,
        turnTimeoutS: timeout,
      });

      // A table played on this machine has nobody to wait for: seat everyone
      // on the host's key and start it in the same breath. The seats are still
      // separate players — same rules, same events, one keyboard.
      if (localPlayers > 0 && myPubkey) {
        await publishStart(channelId, gameId, Array.from({ length: localPlayers }, (_, i) => ({
          id: localSeatId(myPubkey, i),
          by: myPubkey,
          label: `Player ${i + 1}`,
        })));
      }

      onPostMarker(gameMarker(gameId));
      setOpenGame(gameId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the table');
      setBusy(false);
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      testId="new-game-modal"
      panelClassName="w-full max-w-md mx-4 rounded-xl bg-lc-dark border border-lc-border p-5"
    >
      {!selected ? (
        <>
          <h2 className="text-sm font-semibold text-lc-white">Pick a game</h2>
          <div className="mt-3 space-y-2" data-testid="game-list">
            {catalog.map((info) => (
              <button
                key={info.type}
                type="button"
                onClick={() => choose(info)}
                className="flex w-full items-start gap-3 rounded-lg border border-lc-border p-3 text-left transition-colors hover:border-lc-green/60 hover:bg-lc-border/30"
                data-testid={`pick-${info.type}`}
              >
                <GameTypePreview type={info.type} size={56} icon={info.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-lc-white">
                    {info.icon} {info.displayName}
                  </span>
                  <span className="mt-0.5 block text-xs text-lc-muted">{info.description}</span>
                  <span className="mt-1 block text-[11px] text-lc-muted">{gameSummary(info)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onClose} className="lc-pill-secondary px-4 py-1.5 text-xs">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <GameTypePreview type={selected.type} size={44} icon={selected.icon} />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-lc-white" data-testid="config-title">
                {selected.icon} {selected.displayName}
              </h2>
              <p className="text-[11px] text-lc-muted">{selected.description}</p>
            </div>
          </div>

          {selected.type === 'chain-reaction' && (
            <>
              <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Board</p>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(Object.keys(CR_SIZES) as CRSizeKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSize(key)}
                    className={`rounded-lg border px-2 py-2 text-xs transition-colors ${
                      size === key ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-white hover:bg-lc-border/40'
                    }`}
                    data-testid={`game-size-${key}`}
                  >
                    {CR_SIZES[key].label}
                  </button>
                ))}
              </div>
            </>
          )}

          {selected.type === 'stacker' && (
            <>
              <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Piece seed</p>
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                className="mt-1 w-full rounded bg-lc-black/50 px-2 py-1 text-xs text-lc-white outline-none focus:ring-1 focus:ring-lc-green"
                aria-label="Piece seed"
                data-testid="stacker-seed"
              />
              <p className="mt-1 text-[10px] text-lc-muted">
                Everyone gets the same pieces in the same order, so the match is a race, not a lottery.
              </p>
            </>
          )}

          {selected.type === 'vesta' && (
            <>
              <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Board seed</p>
              <input
                value={seed}
                onChange={(e) => { setSeed(e.target.value); setResume(null); }}
                disabled={!!resume}
                className="mt-1 w-full rounded bg-lc-black/50 px-2 py-1 text-xs text-lc-white outline-none focus:ring-1 focus:ring-lc-green disabled:opacity-40"
                aria-label="Board seed"
                data-testid="vesta-seed"
              />
              <p className="mt-1 text-[10px] text-lc-muted">
                The same seed always builds the same board, on every client.
              </p>

              <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Or continue a saved game</p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadSave(file);
                  e.target.value = '';
                }}
                data-testid="vesta-import-input"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-1 rounded-full border border-lc-border px-3 py-1 text-xs text-lc-muted hover:text-lc-white"
                data-testid="vesta-import"
              >
                Load a Vesta save…
              </button>
              {resume && (
                <p className="mt-2 text-[11px] text-lc-green" data-testid="vesta-resume-note">
                  Resuming {resume.name} — {resume.players} players. The table needs exactly that many seats.
                </p>
              )}
            </>
          )}

          <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Who plays</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setLocalPlayers(0)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                localPlayers === 0 ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-muted hover:text-lc-white'
              }`}
              data-testid="players-online"
            >
              People in this channel
            </button>
            {(selected.realtime
              // Real-time games run every board at once, so there is no
              // keyboard to pass: the only thing "on this machine" can mean is
              // a solo run.
              ? [1]
              : Array.from(
                  { length: selected.maxPlayers - selected.minPlayers + 1 },
                  (_, i) => selected.minPlayers + i,
                )
            ).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setLocalPlayers(n)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  localPlayers === n ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-muted hover:text-lc-white'
                }`}
                data-testid={`players-local-${n}`}
              >
                {selected.realtime ? 'Just me' : `${n} on this machine`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-lc-muted">
            {localPlayers === 0
              ? 'The table waits in the channel until you start it.'
              : selected.realtime
                ? 'Starts straight away, on your own. Everyone else needs their own device — every board runs at the same time.'
                : `Starts straight away with ${localPlayers} players taking turns at this keyboard.`}
          </p>

          {selected.type !== 'stacker' && (
            <>
          <p className="mt-4 text-[10px] uppercase tracking-wide text-lc-muted">Turn clock</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {TIMEOUTS.map((t) => (
              <button
                key={t.seconds}
                type="button"
                onClick={() => setTimeoutS(t.seconds)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  timeout === t.seconds ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-muted hover:text-lc-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {selected.type === 'vesta' && timeout > 0 && (
            <p className="mt-1 text-[10px] text-lc-muted">
              The clock runs per action, and a Vesta turn is several — a short one will cut people off.
            </p>
          )}
            </>
          )}

          <p className="mt-3 text-[11px] text-lc-muted">
            {localPlayers > 0
              ? `${gameSummary(selected)}. Everyone plays here; the card in the channel lets others watch.`
              : `${gameSummary(selected)}. You are seated as the host; everyone else joins from the chat card.`}
          </p>

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          <div className="mt-5 flex justify-between">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="lc-pill-secondary px-4 py-1.5 text-xs"
              data-testid="game-back"
            >
              Back
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="lc-pill-primary px-4 py-1.5 text-xs"
              data-testid="game-create"
            >
              {busy ? 'Creating…' : localPlayers > 0 ? 'Start playing' : 'Create table'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
