import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('relay debug log', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    delete (window as unknown as { __obeliskRelayDebug?: unknown }).__obeliskRelayDebug;
  });

  it('does nothing until developer relay debug is enabled', async () => {
    const { pushRelayDebug } = await import('./relay-debug');

    pushRelayDebug({ kind: 'sub-start', relay: 'wss://relay.example' });

    expect(console.debug).not.toHaveBeenCalled();
    expect((window as unknown as { __obeliskRelayDebug?: { events: unknown[] } }).__obeliskRelayDebug).toBeUndefined();
  });

  it('writes console entries and keeps a bounded window ring when enabled', async () => {
    const { setPreference } = await import('@/lib/preferences');
    const { pushRelayDebug } = await import('./relay-debug');
    setPreference('developerRelayDebug', true);

    for (let i = 0; i < 1002; i++) {
      pushRelayDebug({ kind: 'query-start', relay: 'wss://relay.example', payload: { i } });
    }

    const bag = (window as unknown as { __obeliskRelayDebug: { events: Array<{ payload: { i: number } }> } }).__obeliskRelayDebug;
    expect(console.debug).toHaveBeenCalled();
    expect(bag.events).toHaveLength(1000);
    expect(bag.events[0].payload.i).toBe(2);
  });
});
