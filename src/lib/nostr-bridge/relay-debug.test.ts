import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPreference } from "@/lib/preferences";
import { pushRelayDebug } from "./relay-debug";

describe("relay debug log", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("logs only when enabled", () => {
    const entry = { kind: "sub-start", relay: "wss://relay.example" };
    pushRelayDebug(entry);
    expect(console.debug).not.toHaveBeenCalled();

    setPreference("developerRelayDebug", true);
    pushRelayDebug(entry);
    expect(console.debug).toHaveBeenCalledWith("[relay]", entry.kind, entry);
  });
});
