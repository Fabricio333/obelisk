import { describe, it, expect } from 'vitest';
import { conversationStatus, messageMark, threadMarks, type ThreadMarkInput } from './status';

describe('conversationStatus', () => {
  const on = { enabled: true, selfHasKeys: true, peerHasKeys: true };

  it('is secured only when the preference is on and both parties advertise keys', () => {
    expect(conversationStatus(on)).toBe('secured');
  });

  it('is not secured when the preference is off, even if both have keys', () => {
    expect(conversationStatus({ ...on, enabled: false })).toBe('not-secured');
  });

  it('is not secured when the peer has no keys', () => {
    expect(conversationStatus({ ...on, peerHasKeys: false })).toBe('not-secured');
  });

  it('is not secured when we have no keys', () => {
    expect(conversationStatus({ ...on, selfHasKeys: false })).toBe('not-secured');
  });
});

describe('messageMark', () => {
  it('marks a nip04 message as not gift-wrapped', () => {
    expect(messageMark({ protocol: 'nip04', pq: false })).toBe('no-giftwrap');
  });

  it('marks a nip17 message without a post-quantum envelope', () => {
    expect(messageMark({ protocol: 'nip17', pq: false })).toBe('no-pq');
  });

  it('leaves a post-quantum nip17 message unmarked', () => {
    expect(messageMark({ protocol: 'nip17', pq: true })).toBeNull();
  });

  it('treats an undefined pq flag as not post-quantum', () => {
    expect(messageMark({ protocol: 'nip17', pq: undefined })).toBe('no-pq');
  });

  it('prefers the gift-wrap mark when a nip04 message is somehow flagged pq', () => {
    expect(messageMark({ protocol: 'nip04', pq: true })).toBe('no-giftwrap');
  });
});

describe('threadMarks', () => {
  const settled = (protocol: 'nip04' | 'nip17', pq?: boolean): ThreadMarkInput => ({
    protocol,
    pq,
    settled: true,
  });

  it('marks only the head of a run, not every message', () => {
    // The density problem this exists to solve: pre-NIP-17 history is all
    // NIP-04, so `messageMark` alone would put a pill on every bubble.
    expect(
      threadMarks([settled('nip04'), settled('nip04'), settled('nip04'), settled('nip04')]),
    ).toEqual(['no-giftwrap', null, null, null]);
  });

  it('marks each transition between protection levels', () => {
    expect(
      threadMarks([
        settled('nip04'),
        settled('nip04'),
        settled('nip17', false),
        settled('nip17', false),
        settled('nip17', true),
        settled('nip17', true),
      ]),
    ).toEqual(['no-giftwrap', null, 'no-pq', null, null, null]);
  });

  it('re-marks when a thread regresses to an earlier protection level', () => {
    expect(
      threadMarks([settled('nip17', true), settled('nip04'), settled('nip17', true), settled('nip17', false)]),
    ).toEqual([null, 'no-giftwrap', null, 'no-pq']);
  });

  it('stays silent for a fully post-quantum thread', () => {
    expect(threadMarks([settled('nip17', true), settled('nip17', true)])).toEqual([null, null]);
  });

  it('never marks an unsettled message and never lets it break a run', () => {
    // A pending send has no established provenance: the bridge does not know
    // whether the seal will be post-quantum until it has the peer's
    // attestation. Marking it would flash a claim that may be wrong.
    const marks = threadMarks([
      settled('nip04'),
      { protocol: 'nip17', pq: false, settled: false },
      settled('nip04'),
    ]);
    expect(marks).toEqual(['no-giftwrap', null, null]);
  });

  it('treats a missing pq flag on stored history as not post-quantum', () => {
    expect(threadMarks([settled('nip17', undefined)])).toEqual(['no-pq']);
  });

  it('returns an empty list for an empty thread', () => {
    expect(threadMarks([])).toEqual([]);
  });
});
