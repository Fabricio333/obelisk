import { describe, it, expect, beforeEach } from 'vitest';
import { useDMStore, ensureDMStoreForAccount } from './dm';
import type { DMMessage } from './dm';

const makeMsg = (overrides: Partial<DMMessage> = {}): DMMessage => ({
  id: '1',
  senderPubkey: 'a',
  recipientPubkey: 'b',
  content: 'hi',
  createdAt: 0,
  protocol: 'nip17',
  ...overrides,
});

describe('useDMStore', () => {
  beforeEach(() => {
    useDMStore.setState({
      isDMMode: false,
      activeDMPubkey: null,
      threads: [],
      messages: [],
      isLoadingMessages: false,
      isLoadingThreads: false,
      hasMoreHistory: false,
      protocolOverrides: {},
      showProtocolPrompt: null,
    });
  });

  it('has correct initial state', () => {
    const state = useDMStore.getState();
    expect(state.isDMMode).toBe(false);
    expect(state.activeDMPubkey).toBeNull();
    expect(state.threads).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.hasMoreHistory).toBe(false);
  });

  it('toggles DM mode', () => {
    useDMStore.getState().setDMMode(true);
    expect(useDMStore.getState().isDMMode).toBe(true);
    useDMStore.getState().setDMMode(false);
    expect(useDMStore.getState().isDMMode).toBe(false);
  });

  it('sets active DM and clears messages + hasMoreHistory', () => {
    useDMStore.setState({
      messages: [makeMsg()],
      hasMoreHistory: true,
    });
    useDMStore.getState().setActiveDM('pk1');
    expect(useDMStore.getState().activeDMPubkey).toBe('pk1');
    expect(useDMStore.getState().messages).toEqual([]);
    expect(useDMStore.getState().isLoadingMessages).toBe(true);
    expect(useDMStore.getState().hasMoreHistory).toBe(false);
  });

  it('adds and updates threads', () => {
    useDMStore.getState().addThread({ pubkey: 'pk1', displayName: 'Alice' });
    useDMStore.getState().addThread({ pubkey: 'pk2', displayName: 'Bob' });
    expect(useDMStore.getState().threads).toHaveLength(2);

    useDMStore.getState().updateThread('pk1', { lastMessage: 'Hello' });
    expect(useDMStore.getState().threads.find((t) => t.pubkey === 'pk1')?.lastMessage).toBe('Hello');
  });

  it('deduplicates threads on addThread', () => {
    useDMStore.getState().addThread({ pubkey: 'pk1', displayName: 'Alice' });
    useDMStore.getState().addThread({ pubkey: 'pk1', displayName: 'Alice Updated' });
    expect(useDMStore.getState().threads).toHaveLength(1);
    expect(useDMStore.getState().threads[0].displayName).toBe('Alice Updated');
  });

  it('adds messages', () => {
    useDMStore.getState().addMessage({ id: '1', senderPubkey: 'a', recipientPubkey: 'b', content: 'hi', createdAt: 100, protocol: 'nip04' });
    useDMStore.getState().addMessage({ id: '2', senderPubkey: 'b', recipientPubkey: 'a', content: 'hello', createdAt: 101, protocol: 'nip17' });
    expect(useDMStore.getState().messages).toHaveLength(2);
  });

  it('deduplicates messages by id', () => {
    useDMStore.getState().addMessage({ id: '1', senderPubkey: 'a', recipientPubkey: 'b', content: 'hi', createdAt: 100, protocol: 'nip04' });
    useDMStore.getState().addMessage({ id: '1', senderPubkey: 'a', recipientPubkey: 'b', content: 'hi', createdAt: 100, protocol: 'nip04' });
    expect(useDMStore.getState().messages).toHaveLength(1);
  });

  it('prepends older messages without dupes', () => {
    useDMStore.setState({
      messages: [
        { id: '2', senderPubkey: 'a', recipientPubkey: 'b', content: 'two', createdAt: 200, protocol: 'nip17' },
      ],
    });
    useDMStore.getState().prependMessages([
      { id: '1', senderPubkey: 'a', recipientPubkey: 'b', content: 'one', createdAt: 100, protocol: 'nip17' },
      { id: '2', senderPubkey: 'a', recipientPubkey: 'b', content: 'two', createdAt: 200, protocol: 'nip17' },
    ]);
    const ids = useDMStore.getState().messages.map((m) => m.id);
    expect(ids).toEqual(['1', '2']);
  });

  it('replaceMessage swaps a pending message for the real one', () => {
    useDMStore.getState().addMessage({
      id: 'pending-1',
      senderPubkey: 'me',
      recipientPubkey: 'bob',
      content: 'optimistic',
      createdAt: 500,
      protocol: 'nip17',
      isPending: true,
    });
    useDMStore.getState().replaceMessage('pending-1', {
      id: 'real-abc',
      senderPubkey: 'me',
      recipientPubkey: 'bob',
      content: 'optimistic',
      createdAt: 500,
      protocol: 'nip17',
    });
    const msgs = useDMStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('real-abc');
    expect(msgs[0].isPending).toBeUndefined();
  });

  it('markMessageFailed sets sendError and clears pending', () => {
    useDMStore.getState().addMessage({
      id: 'pending-1',
      senderPubkey: 'me',
      recipientPubkey: 'bob',
      content: 'optimistic',
      createdAt: 500,
      protocol: 'nip17',
      isPending: true,
    });
    useDMStore.getState().markMessageFailed('pending-1', 'network down');
    const msg = useDMStore.getState().messages[0];
    expect(msg.isPending).toBe(false);
    expect(msg.sendError).toBe('network down');
  });

  it('sets protocol override and clears prompt', () => {
    useDMStore.setState({ showProtocolPrompt: 'pk1' });
    useDMStore.getState().setProtocolOverride('pk1', 'nip04');
    expect(useDMStore.getState().protocolOverrides['pk1']).toBe('nip04');
    expect(useDMStore.getState().showProtocolPrompt).toBeNull();
  });
});

describe('per-account DM store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persist key includes the active pubkey', async () => {
    ensureDMStoreForAccount('a'.repeat(64));
    useDMStore.getState().setProtocolOverride('b'.repeat(64), 'nip04');
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('obelisk-dm-store:' + 'a'.repeat(64))).not.toBeNull();
  });

  it('messages field is excluded from persisted state', async () => {
    ensureDMStoreForAccount('a'.repeat(64));
    useDMStore.getState().setMessages([{
      id: 'x', senderPubkey: 'a'.repeat(64), recipientPubkey: 'b'.repeat(64),
      content: 'plain-text-payload', createdAt: 1, protocol: 'nip04',
    }]);
    useDMStore.getState().setProtocolOverride('b'.repeat(64), 'nip04');
    await new Promise((r) => setTimeout(r, 0));
    const persisted = localStorage.getItem('obelisk-dm-store:' + 'a'.repeat(64)) ?? '';
    expect(persisted).not.toContain('plain-text-payload');
  });

  it('does not rehydrate plaintext left by an older app version', async () => {
    const pubkey = 'c'.repeat(64);
    localStorage.setItem(`obelisk-dm-store:${pubkey}`, JSON.stringify({
      state: {
        protocolOverrides: { ['d'.repeat(64)]: 'nip04' },
        threads: [{ pubkey: 'old-peer', lastMessage: 'old preview' }],
        messages: [makeMsg({ content: 'old decrypted message' })],
      },
      version: 0,
    }));

    ensureDMStoreForAccount(pubkey);
    await useDMStore.persist.rehydrate();

    expect(useDMStore.getState().threads).toEqual([]);
    expect(useDMStore.getState().messages).toEqual([]);
    expect(useDMStore.getState().protocolOverrides['d'.repeat(64)]).toBe('nip04');
  });
});
