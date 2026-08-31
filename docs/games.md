# Games on the relay

Two games share one runtime: **Chain Reaction**, ported from the classic
centralized stack, and **Vesta**, consumed as a tracked upstream package. The
runtime itself is game-agnostic — a pure engine plus a replayed event log.

Chain Reaction was ported from the classic centralized stack
([obelisk-app/obelisk-classic](https://github.com/obelisk-app/obelisk-classic))
to the relay-only one. The rules are byte-for-byte the same engine; everything
that used to be a Postgres row and a socket.io broadcast is now a Nostr event
log.

## What changed from classic

| Classic | Here |
|---|---|
| `prisma.game` row holds `state`, `currentTurn`, `turnDeadline` | The **log is the state** — every client replays kind 2390 events through the engine |
| API route validates the move, then broadcasts the settled board | Every client validates every move independently; an illegal one is dropped everywhere |
| `setTimeout` on the server fires `onTimeout` | Any player publishes a `timeout` claim once the deadline has passed; the deadline is derived from the log, so everyone agrees whether the claim is good |
| socket.io rooms (`channel:`, `server:`, `pubkey:`) | one REQ per channel on the active relay |
| server assigns seats | the host's `start` event freezes the seat order |

The engine (`src/lib/games/chain-reaction.ts`) came over unmodified. That is
the point of the port: the game rules were already pure, so they moved without
a rewrite, and the only new code is the part that used to be a server.

## Wire format

One stored kind — `KIND_GAME = 2390` — carries every op. Modeled on the voice
signaling transport (`src/lib/voice/transport.ts`): plaintext signed events,
addressed by tags, gated in the handler rather than trusted from the relay.

Common tags:

```
["h", <channelId>]   NIP-29 group scoping — the relay's channel write policy IS the game's
["t", "obelisk-game"]
["op", <op>]
["e", <gameId>, "", "root"]   every op but `create`
["n", "<turnIndex>"]          moves and timeout claims
```

`gameId` is the `create` event's own id. Nothing else needs to be agreed on.

| op | content | published by | accepted when |
|---|---|---|---|
| `create` | `{game, opts, turnTimeoutS}` | host | always; seats the host |
| `join` | `{}` | anyone in the channel | table is `waiting` and under `maxPlayers` |
| `start` | `{seats: [SeatSpec…]}` | host only | every seat's controller actually joined, count within min/max |
| `move` | `{n, action, seat?}` | the seat's controller | `n` is the current turn AND the engine validates the action |
| `timeout` | `{n}` | anyone | table has a clock, `n` is the current turn, and `created_at >= deadline` |
| `resign` | `{seat?}` | a seat's controller | table is in progress |
| `cancel` | `{}` | host only | table is `waiting` |

Unlike voice, this kind is **stored**: a spectator arriving at move 40 has to
be able to replay moves 1-39. Voice signaling can be ephemeral because SDP is
worthless a second later; a game log is the game.

## Determinism

`deriveSession` (`src/lib/games/session.ts`) is the whole trust model. Rules:

1. Events sort by `(created_at, id)`. The id is a hash, so the tiebreak is
   total and identical on every client — never "whoever the relay echoed
   first".
2. A move must come from the controller of the seat on move **and** carry the
   current sequence number. (Engines may allow specific out-of-turn actions —
   see `canAct` — but those are ordered by the same rule.) Duplicates, replays, and moves published against a stale board fail
   one of those tests, so clock skew cannot reorder a match.
3. Anything `validateAction` rejects is dropped. A client publishing an
   illegal cell has published noise.
4. Once a game is `finished` or `cancelled`, later events are inert.

A "waiting" table older than `WAITING_EXPIRY_MINUTES` (60) reads as cancelled.
That is derived from the clock, not published — no event, no signature, same
answer on any client whose clock is roughly right.

### What this does not defend against

- **A player who simply stops publishing.** That is what the turn clock is
  for. On a table created with `No clock`, a walk-away stalls the table
  forever — an accepted trade for a friendly game, not an oversight.
- **Collusion over the seat order.** The host picks it.
- **Privacy.** Moves are plaintext on a public relay, exactly like the chat
  messages next to them. A hidden-information game (poker, battleship) would
  need commit-reveal on top of this; Chain Reaction has no hidden state.

## Relay scope

Games follow the single-relay rule in [CLAUDE.md](../CLAUDE.md): a table lives
on the channel's relay, because the channel does. `subscribeChannelGames`
filters on kind + `since` and gates the `h` tag in the handler — a relay that
doesn't index `#h` for an unfamiliar kind would answer a tag-filtered REQ with
silence, and that failure looks exactly like "nobody is playing".

## UI

- `/play` in a channel composer opens the table picker (frontend-only, like
  `/zap`). Creating publishes the `create` event, then posts a
  `[[game:<id>]]` marker as an ordinary chat message.
- `MessageContent` hoists that marker into a `GameCard`. The card is a
  pointer, not a snapshot: an hour-old message shows the match as it stands
  now.
- `GameModal` is the table — roster while waiting, board while playing.
  Every button publishes one event and then does nothing; the UI moves when
  the event comes back off the relay. No optimistic board, because a board the
  relay hasn't accepted is a board the other players cannot see.
- Every client watching a table runs `useTurnClockEnforcer` and races to
  publish the timeout claim. The reducer accepts exactly one; the rest are
  harmless duplicates.

## Vesta

[fchurca/vesta](https://github.com/fchurca/vesta) — a settlement-building game
whose core module is already pure and log-shaped. It is a **tracked
dependency**, not a fork:

```json
"vesta": "github:fchurca/vesta#semver:^0"
```

`npm update vesta` pulls upstream's rule changes. Nothing in
`src/lib/games/vesta/` encodes a rule; it only translates vocabularies
(player index ↔ seat id, `move.player` ↔ who signed the event). Because the
package's `main` is `src/vesta.ts`, it is listed in `transpilePackages`
(next.config.ts) and inlined for Vitest.

Three things the relay forces that upstream's hot-seat client never needed:

**1. A move may not name its own player.** The seat comes from the signature.
Upstream had no reason to care — everyone shared a keyboard.

**2. Validation runs on every client.** Upstream splits `canBuildSettlement`
(the rules) from `placeSettlement` (does as it's told), and its UI calls the
guard first. Over a relay there is no UI in the path: a hostile client
publishes the move directly. So `checkRules` in `definition.ts` runs the
guards on every client for every move. Without it you could publish a
settlement onto an occupied vertex and everyone would agree you owned it.

**3. Dice cannot be self-reported.** `roll-dice` carries values upstream; we
ignore them and derive the roll from `entropy` — the id of the last accepted
event plus the turn index, both fixed before the roller published anything.
See `vesta/dice.ts`. The residual weakness is documented there: whoever
published the *previous* accepted event can grind it to steer the next roll.
Upstream's URD dependency (verifiable randomness) is the real fix, and
`dice.ts` is the single file that changes when it lands.

Vesta tables default to **no turn clock**. Our clock is per action, and a
Vesta turn is many actions (roll, build, trade, end), so a short timer would
guillotine people mid-thought. Timing out or resigning ends that seat's turn
rather than removing the player — Vesta has no elimination, and deleting a
player would rewrite everyone else's board.

### Seats, hot-seat, and remote players

A seat's identity stopped being a pubkey when Vesta arrived:

```json
["start", {"seats": [
  {"id": "<pubkey-a>",   "by": "<pubkey-a>", "label": "Ana"},
  {"id": "<pubkey-a>#1", "by": "<pubkey-a>", "label": "Beto"},
  {"id": "<pubkey-b>",   "by": "<pubkey-b>"}
]}]
```

`id` is what the engine sees as a player; `by` is who may publish its moves.
Two seats sharing a `by` are two people at one keyboard — Ana and Beto play
locally on Ana's machine, and their moves are signed by Ana's key. A move
names its seat when its signer holds more than one.

For an ordinary all-remote table `id === by`, so a Chain Reaction table reads
exactly as it did before seats existed — and a bare `["pk1","pk2"]` seat list
from an older client still parses (`parseSeats`).

The host can only seat people who joined: a seat whose `by` never published a
`join` is dropped. That stops a host dragging a bystander into a match.

### What lives here that upstream keeps in its UI

Vesta's client does real game sequencing between `applyMove` calls — it sets
`pendingSettlement`, flips `setupStep`, hands out second-round starting
resources, calls `nextTurn`, and decides when the robber may move. That is
fine for one browser with one player at a time. Over a relay there is no
shared client, so `sequence()` in `definition.ts` does all of it,
deterministically, on every replay.

The robber needs a flag that upstream keeps in the DOM ("a seven was rolled,
now place it"). Ours rides in the state under a namespaced `__obelisk` key,
because replay has to carry it — every one of upstream's reducers spreads the
previous state, so the field survives without touching their rules. A turn
cannot end while the robber is unplaced, and a steal is only legal once it
has landed.

### Resuming a saved game

Upstream exports `{startState, turns, endState}`. Passing that as
`opts.resume` on the `create` event starts the table from `endState` instead
of a fresh board (a serialized state is ~4 KB, comfortably inside one event).
`readResumeState` accepts a full record or a bare state.

### Playing it

`/play` opens the picker — every registered game with a thumbnail, its player
range, and its default clock — then that game's own options (board size for
Chain Reaction, seed or a loaded save for Vesta).

Names and icons come from `src/lib/games/catalog.ts`, keyed by game type.
Nothing user-facing hardcodes a game's name: the card and the modal both used
to say "Chain Reaction" outright, which made a Vesta table read as a Chain
Reaction table everywhere in chat.

Players join from the in-channel card; the host then hits Start, which opens
the seat assignment. There is one control per seat — **which account signs its
moves** — and everything follows from it:

- an account holding one seat plays it **remotely**, from their own client;
- an account holding several is playing them **on one machine**. They are
  still separate players with separate resources; they share a keyboard and a
  signature.

Seat order is turn order, and seats can be renamed. When the table resumes a
save, the rows are fixed to the saved players, in the save's order, each
showing the name it had — the host assigns each saved player to an account
rather than the mapping being implicit in row order.

The board highlights exactly the spots upstream's `getValidPositions` calls
legal, and every button is gated by the engine's own `validateAction` — a
rejected move over a relay is silent, so the UI never offers one.

## Stacker

Falling blocks with attacks — the multiplayer shape, where the lines you clear
bury somebody else. Named Stacker rather than the obvious thing because that
word is a trademark and this ships in a product.

It is the first **real-time** game here, and it does not fit the turn-based
runtime at all: there is no seat "to move", every board runs at once, and a
relay round-trip per input would make it feel terrible. So it splits the
difference:

| | where it lives |
|---|---|
| The board, gravity, input, 60 Hz loop | **local**, `stacker/engine.ts` + `useStackerLoop` |
| Attacks, top-outs, checkpoints | **on the relay**, kind 2390 |

`deriveSession` branches on `def.realtime` and builds a `session.match`
(`stacker/match.ts`) instead of a turn. Three new ops carry it:

| op | content | meaning |
|---|---|---|
| `attack` | `{seat, target, lines, hole, nonce}` | garbage from one seat to another |
| `topout` | `{seat}` | that player is out; last one standing wins |
| `checkpoint` | `{seat, frame, attacksSent, linesCleared, stackHeight, inputs}` | progress, plus the input log that produced it |

### Why it stays honest

Everyone starts from the same seed, so everyone gets the same pieces in the
same order — a match is a race, not a lottery. The seed comes from the create
event's opts, or from the table id (a hash: unpredictable before the table
existed, identical for everyone after).

Because the engine is a pure function of `(seed, inputs)`, a checkpoint's input
log can be replayed against the shared seed to reproduce the sender's board and
the attacks they claimed. `verifyCheckpoint` does exactly that, and the UI
marks a seat whose claims its own log does not support.

**This detects cheating rather than preventing it.** Garbage lands before the
checkpoint that justifies it arrives, so a modified client can land one round
of unearned attacks before it is flagged. Preventing that outright means
lockstep — a relay round-trip per frame — which would destroy the thing the
game is for. The trade is deliberate. It also only catches invented attacks,
not a human being assisted by a bot that plays legitimately well.

Incoming garbage is fed through the same input log as everything else, so a
replay reproduces the board that actually happened, garbage included.

### Feel

The numbers that decide whether this plays well are all in `useStackerLoop`:
DAS 10 frames, ARR 2, gravity from 48 frames down to 4 as lines pile up, lock
delay 30 frames with 15 slide resets. The engine state is mutable and read
through `useSyncExternalStore` — copying a 400-cell grid immutably sixty times
a second is how a game like this ends up stuttering.

### Sound

Effects are synthesized at runtime in `stacker/audio.ts` — line clears pitched
by how many lines, a distinct chime for spins, garbage rumble, a falling
top-out. No asset files, and they fire straight off engine events.

The music is the `ncc`-prefixed set from
[TETRA](https://github.com/soyezequiel/tetris-para-luna-negra) by
**soyezequiel**, a La Crypta hackathon project. That repo marks its
royalty-free tracks with that prefix — see `ROYALTY_FREE_PREFIX` in its
`src/audio/music.ts` — and they were generated with Suno. All three ship under
`public/games/stacker/` and are credited in the game UI, linking back to the
source.

It just plays: the playlist is shuffled once per session and advances on its
own, with no picker. `MUSIC_TRACKS` in `audio.ts` is the whole catalogue —
adding or removing a file there is the entire job.

**The rest of that folder is not ours to ship.** It holds commercial
recordings — Duel of the Fates, The Final Countdown, a Bonnie Tyler cover,
orchestral Tetris theme recordings — and no prefix or folder makes those
redistributable. The `ncc` marker is the uploader's statement about their own
generated tracks, not a licence covering anybody else's. If you hold licences
for others, or the author confirms a specific file is their own original, add
that file to `MUSIC_TRACKS`.

If the track cannot load or the browser refuses autoplay, a generative synth
bed plays instead, so the game is never silent because of a missing file.

## Adding another game

The runtime is game-agnostic. Port the engine from classic (`chess.ts`,
`tic-tac-toe.ts` are both already pure), make sure it obeys the contract in
`src/lib/games/types.ts` — no wall clock, no randomness, no mutation — and add
it to `src/lib/games/registry.ts`. Everything in `session.ts`, `transport.ts`,
and the store works unchanged; only the board component is new.
