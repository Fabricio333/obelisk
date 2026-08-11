import { beforeEach, describe, expect, it } from "vitest";
import { clearAllClientCacheExceptSession } from "./cache-clear";

const PUBKEY = "a".repeat(64);
const wiped = [
  "obelisk-cache-v4/public.obelisk.ar/39000/group-1",
  "obelisk-cache-v3/public.obelisk.ar/39000/group-1",
  "obelisk-cache-v2/old-key",
  "obelisk-cache/older-key",
  "obelisk-read-state:" + PUBKEY,
  "obelisk-dm-store:" + PUBKEY,
  "obelisk-forum-follow:" + PUBKEY,
  "obelisk-dex/forum-collapsed/group-1",
  "obelisk-dex/mobile-setup-seen/" + PUBKEY,
  "obelisk-dex/just-generated/" + PUBKEY,
  "obelisk:relay-info-v3",
  "obelisk:relay-info-v2",
  "obelisk:voice-chat-width",
  "obelisk/profile-sync-cache/v1",
  "obelisk/profile-sync-state/v1",
];

const preserved = [
  "obelisk-dex/session",
  "obelisk-dex/relays",
  "obelisk:preferences",
  "unrelated-key",
];

describe("clearAllClientCacheExceptSession", () => {
  beforeEach(() => localStorage.clear());

  it.each(wiped)("removes %s", (key) => {
    localStorage.setItem(key, "value");
    expect(clearAllClientCacheExceptSession()).toBe(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("preserves session, relay configuration, preferences, and unrelated data", () => {
    preserved.forEach((key) => localStorage.setItem(key, "value"));
    expect(clearAllClientCacheExceptSession()).toBe(0);
    preserved.forEach((key) => expect(localStorage.getItem(key)).toBe("value"));
  });

  it("is idempotent", () => {
    localStorage.setItem(wiped[0], "value");
    expect(clearAllClientCacheExceptSession()).toBe(1);
    expect(clearAllClientCacheExceptSession()).toBe(0);
  });
});
