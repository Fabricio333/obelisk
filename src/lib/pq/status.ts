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

export interface ThreadMarkInput extends MessageMarkInput {
  /**
   * False while a send is in flight or has failed. An unsettled message has
   * no established provenance yet — the bridge can't know whether a seal
   * will end up post-quantum until it has the peer's attestation — so it
   * neither shows a mark nor counts as a transition.
   */
  settled: boolean;
}

/**
 * Per-message marks for a whole thread, aggregated so only **transitions**
 * are shown.
 *
 * `messageMark` alone resolves a mark for essentially every message in a real
 * thread: all pre-NIP-17 history is NIP-04, so a pill would land on every
 * bubble in a Discord-style list, which is unreadable and stops carrying
 * information. Marking transitions instead means one pill at the head of each
 * run — "everything from here is NIP-04", then a fresh pill the moment the
 * thread changes protection level — which is the same information at a
 * hundredth of the density.
 *
 * A transition *to* a healthy message shows nothing, by construction: its mark
 * is `null`. That is the intended reading — marks simply stop.
 *
 * Pure, so the whole lattice is table-testable.
 */
export function threadMarks(messages: readonly ThreadMarkInput[]): PqMessageMark[] {
  let previous: PqMessageMark | undefined;
  return messages.map((m) => {
    if (!m.settled) return null;
    const mark = messageMark(m);
    const show = mark !== null && mark !== previous;
    previous = mark;
    return show ? mark : null;
  });
}
