'use client';

import { useState } from 'react';
import { parseProfileFeedRelays } from '@/lib/profile-feed';
import { setPreference, usePreferences } from '@/lib/preferences';
import { useTranslation } from '@/i18n/context';

export default function ProfileFeedRelaySettings({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const relays = usePreferences().profileFeedRelays;
  const [draft, setDraft] = useState(relays.join('\n'));
  const [status, setStatus] = useState<'idle' | 'error' | 'saved'>('idle');

  const save = () => {
    const parsed = parseProfileFeedRelays(draft);
    if (!parsed) {
      setStatus('error');
      return;
    }
    setPreference('profileFeedRelays', parsed);
    setStatus('saved');
  };

  const fields = (
    <>
      <p className="text-xs text-lc-muted">{t('preferences.profileFeed.description')}</p>
      {draft.split('\n').map((relay, index) => (
        <input
          key={index}
          value={relay}
          onChange={(event) => {
            const next = draft.split('\n');
            next[index] = event.target.value;
            setDraft(next.join('\n'));
            setStatus('idle');
          }}
          aria-label={`${t('preferences.profileFeed.relay')} ${index + 1}`}
          className="w-full rounded-lg border border-lc-border bg-lc-black px-3 py-2 font-mono text-xs text-lc-white outline-none focus:border-lc-green"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
      ))}
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} className="lc-pill-secondary px-4 py-2 text-xs">
          {t('common.save')}
        </button>
        {status !== 'idle' && (
          <span className={`text-xs ${status === 'error' ? 'text-red-400' : 'text-lc-green'}`}>
            {t(status === 'error' ? 'preferences.profileFeed.invalid' : 'preferences.profileFeed.saved')}
          </span>
        )}
      </div>
    </>
  );

  return mobile ? (
    <div className="settings-section" data-testid="profile-feed-relay-settings">
      <div className="settings-section-title">{t('preferences.profileFeed.title')}</div>
      <div className="settings-row !block space-y-2">{fields}</div>
    </div>
  ) : (
    <div className="space-y-2 border-t border-lc-border pt-4" data-testid="profile-feed-relay-settings">
      <div className="text-xs font-semibold uppercase tracking-wider text-lc-muted">
        {t('preferences.profileFeed.title')}
      </div>
      {fields}
    </div>
  );
}
