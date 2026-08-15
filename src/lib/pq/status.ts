import type { DMProtocol } from '@/store/dm';

/** Whether a conversation can carry post-quantum protection right now. */
export type PqConversationStatus = 'secured' | 'not-secured';

/**
 * What a single message lacked. `null` means it lacked nothing — only
 * deficient messages are marked, so a healthy thread stays quiet.
 */
export type PqMessageMark = 'no-giftwrap' | 'no-pq' | null;

export interface ConversationStatusInput {
  /** The `postQuantumEnabled` preference. */
  enabled: boolean;
  /** We advertise a usable post-quantum attestation. */
  selfHasKeys: boolean;
  /** The peer advertises a usable post-quantum attestation. */
  peerHasKeys: boolean;
}

export interface MessageMarkInput {
  protocol: DMProtocol;
  pq: boolean | undefined;
}

/**
 * Capability-and-configuration state, deliberately not a claim about the
 * messages already in the thread. We can verify a peer published an
 * attestation; we cannot verify their client uses it.
 */
export function conversationStatus(input: ConversationStatusInput): PqConversationStatus {
  const { enabled, selfHasKeys, peerHasKeys } = input;
  return enabled && selfHasKeys && peerHasKeys ? 'secured' : 'not-secured';
}

export function messageMark(input: MessageMarkInput): PqMessageMark {
  // Gift-wrap is the stronger claim: a nip04 message leaks metadata to relays
  // whatever its payload, so that mark wins.
  if (input.protocol === 'nip04') return 'no-giftwrap';
  return input.pq === true ? null : 'no-pq';
}
