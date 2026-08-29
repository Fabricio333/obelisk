import { describe, it, expect, beforeEach } from 'vitest';
import { useGamesStore, selectSession, selectChannelSessions } from './games';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { chainReaction } from '@/lib/games/chain-reaction';

const CH = 'channel-1';
const OTHER = 'channel-2';
const HOST = 'pk-host';
const B = 'pk-b';

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

const create = (channel: string, id: string, at = 1000) =>
  parsed(id, HOST, at, buildCreate(channel, { game: chainReaction.type, turnTimeoutS: 45 }));

describe('games store', () => {
  beforeEach(() => {
    useGamesStore.setState({ logs: {}, channelOf: {}, openGameId: null });
  });

  it('ingests an event and maps the table to its channel', () => {
    useGamesStore.getState().ingest(create(CH, 'g1'));
    const s = useGamesStore.getState();
    expect(s.logs.g1).toHaveLength(1);
    expect(s.channelOf.g1).toBe(CH);
  });

  it('drops duplicate ids — relays re-deliver on reconnect', () => {
    const ev = create(CH, 'g1');
    useGamesStore.getState().ingestMany([ev, ev, ev]);
    expect(useGamesStore.getState().logs.g1).toHaveLength(1);
  });

  it('keeps the same object identity when nothing new arrived', () => {
    const ev = create(CH, 'g1');
    useGamesStore.getState().ingest(ev);
    const before = useGamesStore.getState().logs;
    useGamesStore.getState().ingest(ev);
    expect(useGamesStore.getState().logs).toBe(before);
  });

  it('derives a session from the stored log', () => {
    useGamesStore.getState().ingestMany([
      create(CH, 'g1'),
      parsed('j1', B, 1001, buildGameOp(CH, 'g1', 'join')),
      parsed('s1', HOST, 1002, buildGameOp(CH, 'g1', 'start', { seats: [HOST, B] })),
    ]);
    const session = selectSession(useGamesStore.getState(), 'g1', 1010)!;
    expect(session.status).toBe('in_progress');
    expect(session.participants).toEqual([HOST, B]);
  });

  it('returns null for a table whose create has not arrived yet', () => {
    useGamesStore.getState().ingest(parsed('j1', B, 1001, buildGameOp(CH, 'orphan', 'join')));
    expect(selectSession(useGamesStore.getState(), 'orphan', 1010)).toBeNull();
  });

  it('lists a channel\'s tables newest first, and only that channel\'s', () => {
    useGamesStore.getState().ingestMany([
      create(CH, 'g1', 1000),
      create(CH, 'g2', 2000),
      create(OTHER, 'g3', 3000),
    ]);
    const list = selectChannelSessions(useGamesStore.getState(), CH, 3100);
    expect(list.map((s) => s.id)).toEqual(['g2', 'g1']);
  });

  it('clearChannel drops only that channel\'s tables', () => {
    useGamesStore.getState().ingestMany([create(CH, 'g1'), create(OTHER, 'g3')]);
    useGamesStore.getState().clearChannel(CH);
    const s = useGamesStore.getState();
    expect(s.logs.g1).toBeUndefined();
    expect(s.logs.g3).toBeDefined();
  });

  it('tracks which table the modal has open', () => {
    useGamesStore.getState().setOpenGame('g1');
    expect(useGamesStore.getState().openGameId).toBe('g1');
    useGamesStore.getState().setOpenGame(null);
    expect(useGamesStore.getState().openGameId).toBeNull();
  });
});
