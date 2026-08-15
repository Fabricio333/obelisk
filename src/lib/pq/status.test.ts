import { describe, it, expect } from 'vitest';
import { conversationStatus, messageMark } from './status';

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
