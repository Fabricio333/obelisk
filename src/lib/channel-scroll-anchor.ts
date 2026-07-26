import type { JsMessage } from '@/lib/nostr-bridge/types';

export type ChannelInitialAnchor =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'message'; readonly messageId: string };

export function channelCursorHasReadLatest(
  messages: ReadonlyArray<Pick<JsMessage, 'createdAt' | 'pubkey'>>,
  cursorMs: number | null | undefined,
  ownPubkey: string | null | undefined,
): boolean {
  if (!cursorMs || cursorMs <= 0 || messages.length === 0) return false;
  return !messages.some((message) =>
    message.createdAt * 1000 > cursorMs && (!ownPubkey || message.pubkey !== ownPubkey));
}

export function channelInitialAnchorFromCursor(
  messages: ReadonlyArray<Pick<JsMessage, 'id' | 'createdAt' | 'pubkey'>>,
  cursorMs: number | null | undefined,
  ownPubkey: string | null | undefined,
): ChannelInitialAnchor {
  if (!cursorMs || cursorMs <= 0 || messages.length === 0) return { kind: 'bottom' };
  if (messages[0].createdAt * 1000 > cursorMs) return { kind: 'bottom' };

  for (const message of messages) {
    if (message.createdAt * 1000 <= cursorMs) continue;
    if (ownPubkey && message.pubkey === ownPubkey) continue;
    return { kind: 'message', messageId: message.id };
  }

  return { kind: 'bottom' };
}
