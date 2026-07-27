/**
 * Promise-returning action wrappers around the bridge. Components import
 * from here instead of touching getBridge() directly.
 */
import { getBridge } from './client';

export const nostrActions = {
  loginWithNsec: async (privKeyHex: string, pubKeyHex: string) =>
    (await getBridge()).loginWithNsec(privKeyHex, pubKeyHex),

  loginWithNip07: async (pubkeyHex: string) =>
    (await getBridge()).loginWithNip07(pubkeyHex),

  loginWithBunker: async (
    bunkerUrl: string,
    options?: { onAuthUrl?: (url: string) => void; clientSecretHex?: string },
  ) => (await getBridge()).loginWithBunker(bunkerUrl, options),

  createNostrConnectSession: async (options?: { relay?: string; onAuthUrl?: (url: string) => void }) =>
    (await getBridge()).createNostrConnectSession(options),

  logout: async () => (await getBridge()).logout(),

  connect: async () => (await getBridge()).connect(),
  switchRelay: async (url: string) => (await getBridge()).switchRelay(url),
  addRelay: async (url: string) => (await getBridge()).addRelay(url),
  removeRelay: async (url: string) => (await getBridge()).removeRelay(url),

  saveMediaPack: async (pack: Parameters<Awaited<ReturnType<typeof getBridge>>['saveMediaPack']>[0]) =>
    (await getBridge()).saveMediaPack(pack),
  deleteMediaPack: async (address: string) => (await getBridge()).deleteMediaPack(address),
  saveMediaFavorites: async (favorites: Parameters<Awaited<ReturnType<typeof getBridge>>['saveMediaFavorites']>[0]) =>
    (await getBridge()).saveMediaFavorites(favorites),

  sendMessage: async (
    groupId: string,
    content: string,
    replyTo?: { id: string; pubkey: string } | null,
    emojiTags?: ReadonlyArray<ReadonlyArray<string>>,
  ) => (await getBridge()).sendMessage(groupId, content, replyTo, emojiTags),
  sendReaction: async (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    groupId: string,
    emojiTags?: ReadonlyArray<ReadonlyArray<string>>,
  ) => (await getBridge()).sendReaction(targetEventId, targetPubkey, emoji, groupId, emojiTags),
  removeReaction: async (groupId: string, reactionEventId: string) =>
    (await getBridge()).removeReaction(groupId, reactionEventId),
  removeMessage: async (groupId: string, eventId: string) =>
    (await getBridge()).removeMessage(groupId, eventId),
  sendDirectMessage: async (recipientPubkey: string, content: string) =>
    (await getBridge()).sendDirectMessage(recipientPubkey, content),
  retryMessage: async (groupId: string, clientTag: string) =>
    (await getBridge()).retryMessage(groupId, clientTag),
  retryDirectMessage: async (counterparty: string, clientTag: string) =>
    (await getBridge()).retryDirectMessage(counterparty, clientTag),
  cancelPendingMessage: async (groupId: string, clientTag: string) =>
    (await getBridge()).cancelPendingMessage(groupId, clientTag),
  cancelPendingDirectMessage: async (counterparty: string, clientTag: string) =>
    (await getBridge()).cancelPendingDirectMessage(counterparty, clientTag),
  joinGroup: async (groupId: string) => (await getBridge()).joinGroup(groupId),
  leaveGroup: async (groupId: string) => (await getBridge()).leaveGroup(groupId),
  createGroup: async (opts: Parameters<Awaited<ReturnType<typeof getBridge>>['createGroup']>[0]) =>
    (await getBridge()).createGroup(opts),
  editGroupMetadata: async (
    opts: Parameters<Awaited<ReturnType<typeof getBridge>>['editGroupMetadata']>[0],
  ) => (await getBridge()).editGroupMetadata(opts),
  editUserMetadata: async (
    opts: Parameters<Awaited<ReturnType<typeof getBridge>>['editUserMetadata']>[0],
    options?: Parameters<Awaited<ReturnType<typeof getBridge>>['editUserMetadata']>[1],
  ) => (await getBridge()).editUserMetadata(opts, options),
  putUser: async (
    groupId: string,
    pubkey: string,
    roles?: ReadonlyArray<string>,
    opts?: { quiet?: boolean },
  ) => (await getBridge()).putUser(groupId, pubkey, roles, opts),
  removeUser: async (groupId: string, pubkey: string) =>
    (await getBridge()).removeUser(groupId, pubkey),
  removePermission: async (
    groupId: string,
    pubkey: string,
    permissions: ReadonlyArray<string>,
  ) => (await getBridge()).removePermission(groupId, pubkey, permissions),
  claimCreatorAdmin: async (groupId: string) =>
    (await getBridge()).claimCreatorAdmin(groupId),
  deleteGroupEvent: async (groupId: string, eventId: string) =>
    (await getBridge()).deleteGroupEvent(groupId, eventId),
  loadMoreMessages: async (groupId: string) =>
    (await getBridge()).loadMoreMessages(groupId),
  refreshGroupMessages: async (groupId: string) =>
    (await getBridge()).refreshGroupMessages(groupId),
  fetchGroupMetadata: async (groupId: string) =>
    (await getBridge()).fetchGroupMetadata(groupId),

  setActiveGroup: async (groupId: string | null) =>
    (await getBridge()).setActiveGroup(groupId),
  ensureUserMetadata: async (pubkey: string) =>
    (await getBridge()).ensureUserMetadata(pubkey),
  searchMessages: async (
    opts: Parameters<Awaited<ReturnType<typeof getBridge>>['searchMessages']>[0],
  ) => (await getBridge()).searchMessages(opts),

  setMuted: async (pubkey: string, muted: boolean) =>
    (await getBridge()).setMuted(pubkey, muted),

  signEventTemplate: async (
    template: Parameters<Awaited<ReturnType<typeof getBridge>>['signEventTemplate']>[0],
  ) => (await getBridge()).signEventTemplate(template),
};
