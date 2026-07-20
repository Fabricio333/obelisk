'use client';

import type { Filter } from 'nostr-tools';
import { getPreferences } from '@/lib/preferences';

export interface RelayDebugEvent {
  ts: number;
  kind: string;
  relay?: string;
  relays?: readonly string[];
  filter?: Filter;
  eventKind?: number;
  groupId?: string;
  status?: string;
  reason?: string;
  payload?: unknown;
}

const RING_SIZE = 1000;

interface RelayDebugBag {
  events: RelayDebugEvent[];
}

function enabled(): boolean {
  try {
    return getPreferences().developerRelayDebug;
  } catch {
    return false;
  }
}

function ensureBag(): RelayDebugBag {
  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    __obeliskRelayDebug?: RelayDebugBag;
  };
  if (!w.__obeliskRelayDebug) w.__obeliskRelayDebug = { events: [] };
  return w.__obeliskRelayDebug;
}

export function pushRelayDebug(ev: Omit<RelayDebugEvent, 'ts'>): void {
  if (!enabled()) return;
  const entry = { ts: Date.now(), ...ev };
  const bag = ensureBag();
  bag.events.push(entry);
  if (bag.events.length > RING_SIZE) bag.events.splice(0, bag.events.length - RING_SIZE);
  console.debug('[relay]', entry.kind, entry);
}

export function clearRelayDebug(): void {
  ensureBag().events.length = 0;
}
