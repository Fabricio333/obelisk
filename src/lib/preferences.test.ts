import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('preferences store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('persists appearance colors in the existing preferences blob', async () => {
    const { getPreferences, setPreference } = await import('./preferences');

    expect(getPreferences()).toMatchObject({
      directMessagesEnabled: false,
      developerRelayDebug: false,
      profileFeedRelays: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
      ],
      accentColor: '#b4f953',
      backgroundColor: '#0a0a0a',
      buttonColor: '#b4f953',
      bubbleColor: '#b4f953',
      bubbleAnimation: 'float',
    });

    setPreference('directMessagesEnabled', true);
    setPreference('developerRelayDebug', true);
    setPreference('profileFeedRelays', ['wss://one.example', 'wss://two.example', 'wss://three.example']);
    setPreference('accentColor', '#7ec8ff');
    setPreference('backgroundColor', '#111827');
    setPreference('buttonColor', '#f0c14a');
    setPreference('bubbleColor', '#ff7ad9');
    setPreference('bubbleAnimation', 'drift');

    expect(getPreferences()).toMatchObject({
      directMessagesEnabled: true,
      developerRelayDebug: true,
      profileFeedRelays: ['wss://one.example', 'wss://two.example', 'wss://three.example'],
      accentColor: '#7ec8ff',
      backgroundColor: '#111827',
      buttonColor: '#f0c14a',
      bubbleColor: '#ff7ad9',
      bubbleAnimation: 'drift',
    });
    expect(JSON.parse(localStorage.getItem('obelisk:preferences') ?? '{}')).toMatchObject({
      directMessagesEnabled: true,
      developerRelayDebug: true,
      profileFeedRelays: ['wss://one.example', 'wss://two.example', 'wss://three.example'],
      accentColor: '#7ec8ff',
      backgroundColor: '#111827',
      buttonColor: '#f0c14a',
      bubbleColor: '#ff7ad9',
      bubbleAnimation: 'drift',
    });
  });

  it('stores DM opt-in as a non-secret boolean preference', async () => {
    const { DM_OPT_IN_PREFERENCE_KEY, DM_OPT_IN_STORAGE_KEY, setDmOptInEnabled } = await import('./dm/opt-in');

    expect(DM_OPT_IN_STORAGE_KEY).toBe('obelisk:preferences');
    expect(DM_OPT_IN_PREFERENCE_KEY).toBe('directMessagesEnabled');
    expect(`${DM_OPT_IN_STORAGE_KEY}:${DM_OPT_IN_PREFERENCE_KEY}`).not.toMatch(/session|secret|nsec|private|token/i);

    setDmOptInEnabled(true);

    const stored = JSON.parse(localStorage.getItem(DM_OPT_IN_STORAGE_KEY) ?? '{}');
    expect(stored[DM_OPT_IN_PREFERENCE_KEY]).toBe(true);
    expect(typeof stored[DM_OPT_IN_PREFERENCE_KEY]).toBe('boolean');
    expect(JSON.stringify(stored)).not.toMatch(/nsec|private|secret/i);
  });

  it('sanitizes invalid persisted color values and can reset appearance defaults', async () => {
    localStorage.setItem('obelisk:preferences', JSON.stringify({
      showActivityIndicator: false,
      developerRelayDebug: 'yes',
      accentColor: 'red',
      backgroundColor: '#111111',
      buttonColor: 'url(javascript:bad)',
      bubbleColor: 'pink',
      bubbleAnimation: 'teleport',
      profileFeedRelays: ['https://bad.example', 'wss://duplicate.example', 'wss://duplicate.example'],
    }));

    const { getPreferences, resetAppearancePreferences } = await import('./preferences');
    expect(getPreferences()).toMatchObject({
      showActivityIndicator: false,
      developerRelayDebug: false,
      accentColor: '#b4f953',
      backgroundColor: '#111111',
      buttonColor: '#b4f953',
      bubbleColor: '#b4f953',
      bubbleAnimation: 'float',
      profileFeedRelays: [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
      ],
    });

    resetAppearancePreferences();

    expect(getPreferences()).toMatchObject({
      showActivityIndicator: false,
      developerRelayDebug: false,
      accentColor: '#b4f953',
      backgroundColor: '#0a0a0a',
      buttonColor: '#b4f953',
      bubbleColor: '#b4f953',
      bubbleAnimation: 'float',
    });
  });

  describe('postQuantumEnabled', () => {
    it('defaults to false', async () => {
      const { getPreferences } = await import('./preferences');
      expect(getPreferences().postQuantumEnabled).toBe(false);
    });

    it('round-trips through setPreference', async () => {
      const { getPreferences, setPreference } = await import('./preferences');
      setPreference('postQuantumEnabled', true);
      expect(getPreferences().postQuantumEnabled).toBe(true);
    });

    it('falls back to the default when storage holds a non-boolean', async () => {
      localStorage.setItem('obelisk:preferences', JSON.stringify({ postQuantumEnabled: 'yes' }));
      const { getPreferences } = await import('./preferences');
      expect(getPreferences().postQuantumEnabled).toBe(false);
    });
  });
});
