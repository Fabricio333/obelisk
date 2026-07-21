"use client";

import { getPreferences } from "@/lib/preferences";

export function pushRelayDebug(entry: { kind: string; [key: string]: unknown }): void {
  if (getPreferences().developerRelayDebug) console.debug("[relay]", entry.kind, entry);
}
