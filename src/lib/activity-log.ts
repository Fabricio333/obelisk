'use client';

import { useSyncExternalStore } from 'react';

export type ActivityStatus = 'pending' | 'ok' | 'error';

export type ActivityOperation = 'connect' | 'subscribe' | 'query' | 'sign' | 'publish';

export interface ActivityMeta {
  operation?: ActivityOperation;
  eventKind?: number;
  description?: string;
}

export interface ActivityEntry {
  id: number;
  label: string;
  status: ActivityStatus;
  detail?: string;
  operation?: ActivityOperation;
  eventKind?: number;
  description?: string;
  startedAt: number;
  endedAt?: number;
}

type Listener = () => void;

let nextId = 1;
const entries = new Map<number, ActivityEntry>();
const listeners = new Set<Listener>();
let snapshot: ActivityEntry[] = [];

function emit() {
  snapshot = Array.from(entries.values()).sort((a, b) => b.startedAt - a.startedAt);
  listeners.forEach((l) => l());
}

export function pushActivity(label: string, detail?: string, meta?: ActivityMeta): number {
  const id = nextId++;
  entries.set(id, { id, label, status: 'pending', detail, ...meta, startedAt: Date.now() });
  emit();
  return id;
}

export function resolveActivity(id: number, detail?: string) {
  const e = entries.get(id);
  if (!e) return;
  entries.set(id, { ...e, status: 'ok', endedAt: Date.now(), detail: detail ?? e.detail });
  emit();
  // Auto-prune successful entries shortly after they complete so the UI
  // shows what's currently happening, not a long history.
  setTimeout(() => {
    entries.delete(id);
    emit();
  }, 1500);
}

export function failActivity(id: number, detail: string) {
  const e = entries.get(id);
  if (!e) return;
  entries.set(id, { ...e, status: 'error', endedAt: Date.now(), detail });
  emit();
  // Errors linger longer so the user can read them, then auto-clear.
  setTimeout(() => {
    entries.delete(id);
    emit();
  }, 8000);
}

export function dismissActivity(id: number) {
  entries.delete(id);
  emit();
}

export async function trackActivity<T>(
  label: string,
  fn: () => Promise<T>,
  detail?: string,
  meta?: ActivityMeta,
): Promise<T> {
  const id = pushActivity(label, detail, meta);
  try {
    const out = await fn();
    resolveActivity(id);
    return out;
  } catch (e) {
    failActivity(id, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return snapshot;
}

export function useActivityLog(): ActivityEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
