/** Control messages and timing shared by the simple-peer mesh adapter. */
export const CONTROL_CHANNEL_LABEL = 'obelisk-control';
export const PING_INTERVAL_MS = 2500;
export const DEAD_PEER_TIMEOUT_MS = 20_000;
export const PEER_SNAPSHOT_INTERVAL_MS = 5_000;

export type ControlMessage =
  | { type: 'hello'; peers: string[]; sessionId: string; build: string }
  | { type: 'peerSnapshot'; peers: string[]; ts: number }
  | { type: 'peerAdded'; pubkey: string }
  | { type: 'peerRemoved'; pubkey: string }
  | { type: 'bye'; reason: string }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number };
