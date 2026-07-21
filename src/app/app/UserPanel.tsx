'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hexToNpub } from '@nostr-wot/data';
import { nostrActions } from '@/lib/nostr-bridge';
import { useProfile, usePublishProfile } from '@nostr-wot/data/react';
import BlossomImageInput from '@/components/BlossomImageInput';
import { usePreferences, setPreference } from '@/lib/preferences';
import { setDmOptInEnabled } from '@/lib/dm/opt-in';
import WotSettings from '@/components/settings/WotSettings';
import LanguagePreference from '@/components/LanguagePreference';
import AppearancePreferenceControls from '@/components/AppearancePreferenceControls';
import UserAvatar from '@/components/UserAvatar';
import ModalShell from '@/components/ModalShell';
import { clearAllClientCacheExceptSession } from '@/lib/nostr-bridge/cache-clear';
import { useTranslation } from '@/i18n/context';

interface UserPanelProps {
  pubkey: string;
  isMe: boolean;
  onClose: () => void;
  onLogout?: () => void;
  /** Anchor (the trigger element) — panel is positioned relative to it. */
  anchor?: { x: number; y: number; placement?: 'top' | 'bottom' };
  /** Open directly into the fullscreen edit modal. */
  initialEditing?: boolean;
}

export default function UserPanel({ pubkey, isMe, onClose, onLogout, anchor, initialEditing = false }: UserPanelProps) {
  const { t } = useTranslation();
  const meta = useProfile(pubkey);
  const [editing, setEditing] = useState(initialEditing);
  const [settingsTab, setSettingsTab] = useState<'profile' | 'preferences'>('profile');

  useEffect(() => {
    nostrActions.ensureUserMetadata(pubkey).catch(() => {});
  }, [pubkey]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [editing]);

  const npub = (() => {
    try { return hexToNpub(pubkey); } catch { return null; }
  })();
  const displayName = meta?.displayName || meta?.name || pubkey.slice(0, 10);

  if (typeof document === 'undefined') return null;

  // Position: by default fixed bottom-left of viewport (Discord-style). If
  // an anchor is provided, place above/below it.
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        left: Math.max(8, Math.min(window.innerWidth - 348, anchor.x)),
        ...(anchor.placement === 'top'
          ? { bottom: window.innerHeight - anchor.y + 8 }
          : { top: anchor.y + 8 }),
      }
    : { position: 'fixed', left: 8, bottom: 72 };

  if (editing && isMe) {
    return createPortal(
      <div
        className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm p-10 md:p-24 flex items-stretch justify-stretch"
        data-testid="user-edit-modal"
      >
        <div className="relative flex w-full rounded-2xl overflow-hidden border border-lc-border shadow-2xl bg-lc-black">
          <button
            onClick={() => { setEditing(false); onClose(); }}
            className="absolute top-5 right-5 z-10 w-12 h-12 rounded-full bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/30 flex items-center justify-center transition-colors ring-2 ring-red-500/30 hover:ring-red-500/60"
            aria-label={t('common.close')}
            title={`${t('common.close')} (Esc)`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
          <aside className="w-64 shrink-0 bg-lc-dark border-r border-lc-border flex flex-col">
            <div className="px-5 py-5 border-b border-lc-border">
              <div className="text-[10px] uppercase tracking-wider text-lc-muted font-semibold mb-2">{t('user.settings')}</div>
              <div className="flex items-center gap-2 min-w-0">
                <UserAvatar pubkey={pubkey} picture={meta?.picture ?? null} size={8} name={displayName} initialClassName="text-sm" />
                <div className="min-w-0">
                  <div className="text-sm text-lc-white truncate">{displayName}</div>
                  {meta?.nip05 && <div className="text-[10px] text-lc-green truncate">{meta.nip05}</div>}
                </div>
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto p-2 space-y-1">
              <button
                type="button"
                onClick={() => setSettingsTab('profile')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm ${settingsTab === 'profile' ? 'bg-lc-green/15 text-lc-green' : 'text-lc-white hover:bg-lc-border/40'}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span>{t('settings.profile')}</span>
              </button>
              <button
                type="button"
                onClick={() => setSettingsTab('preferences')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm ${settingsTab === 'preferences' ? 'bg-lc-green/15 text-lc-green' : 'text-lc-white hover:bg-lc-border/40'}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                <span>{t('settings.preferences')}</span>
              </button>
            </nav>
          </aside>
          <main className="flex-1 min-w-0 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-10 py-10">
              {settingsTab === 'profile' ? (
                <>
                  <div className="mb-6">
                    <div className="text-xs uppercase tracking-wider text-lc-muted font-semibold">{t('settings.profile')}</div>
                    <h2 className="text-lc-white text-xl font-semibold mt-2">{t('user.editProfile')}</h2>
                  </div>
                  <EditProfileForm
                    initial={meta}
                    onCancel={() => { setEditing(false); onClose(); }}
                    onSaved={() => { setEditing(false); onClose(); }}
                  />
                </>
              ) : (
                <>
                  <div className="mb-6">
                    <div className="text-xs uppercase tracking-wider text-lc-muted font-semibold">{t('settings.preferences')}</div>
                    <h2 className="text-lc-white text-xl font-semibold mt-2">{t('user.appPreferences')}</h2>
                  </div>
                  <PreferencesPanel />
                </>
              )}
            </div>
          </main>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[65]" onClick={onClose} />
      <div
        style={style}
        className="z-[70] w-[340px] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-lc-border bg-lc-dark shadow-2xl"
      >
        {/* Banner */}
        {meta?.banner ? (
          <div className="h-28 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={meta.banner} alt="" className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="h-20 bg-gradient-to-r from-lc-olive/30 to-lc-dark" />
        )}

        {/* Avatar + name */}
        <div className="relative -mt-10 px-5">
          <UserAvatar
            pubkey={pubkey}
            picture={meta?.picture ?? null}
            size={20}
            name={displayName}
            alt={displayName}
            className="ring-4 ring-lc-dark"
            initialClassName="text-2xl"
          />
          <div className="mt-3">
            <div className="text-lg font-semibold text-lc-white">{displayName}</div>
            {meta?.nip05 && <div className="truncate text-xs text-lc-green">{meta.nip05}</div>}
            {npub && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-lc-muted">
                {npub.slice(0, 24)}…
              </div>
            )}
          </div>
        </div>

        {/* About */}
        {meta?.about && (
          <div className="mt-2 px-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-lc-muted">
              {t('user.about')}
            </div>
            <div className="mt-0.5 line-clamp-3 text-xs text-lc-muted">{meta.about}</div>
          </div>
        )}

        <div className="mt-3 border-t border-lc-border" />

        {(
          <>
            {npub && (
              <button
                onClick={() => navigator.clipboard?.writeText(npub).catch(() => {})}
                className="flex w-full items-center gap-2 p-3 text-left text-sm text-lc-white transition hover:bg-lc-border/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                {t('user.copyNpub')}
              </button>
            )}
            <button
              onClick={() => navigator.clipboard?.writeText(pubkey).catch(() => {})}
              className="flex w-full items-center gap-2 p-3 text-left text-sm text-lc-white transition hover:bg-lc-border/50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              {t('user.copyPubkeyHex')}
            </button>
            {npub && (
              <a
                href={`https://njump.me/${npub}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center gap-2 p-3 text-left text-sm text-lc-white transition hover:bg-lc-border/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                {t('user.openNostrClient')}
              </a>
            )}

            {isMe && (
              <>
                <div className="border-t border-lc-border" />
                <button
                  onClick={() => setEditing(true)}
                  className="flex w-full items-center gap-2 p-3 text-left text-sm text-lc-white transition hover:bg-lc-border/50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                  {t('user.editProfile')}
                </button>
                <div className="border-t border-lc-border" />
                <button
                  onClick={onLogout}
                  className="flex w-full items-center gap-2 p-3 text-left text-xs text-red-400 transition hover:bg-lc-border/50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  {t('user.logOut')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

function EditProfileForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: { displayName: string | null; name: string | null; about: string | null; picture: string | null; banner: string | null; nip05: string | null; website: string | null } | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const publishProfile = usePublishProfile();
  const [name, setName] = useState(initial?.displayName || initial?.name || '');
  const [about, setAbout] = useState(initial?.about || '');
  const [picture, setPicture] = useState(initial?.picture || '');
  const [banner, setBanner] = useState(initial?.banner || '');
  const [nip05, setNip05] = useState(initial?.nip05 || '');
  const [website, setWebsite] = useState(initial?.website || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  // Track whether the user has typed into any field. Once true, we stop
  // overwriting their edits when fresh kind:0 metadata arrives from a relay.
  const dirtyRef = useRef(false);
  const markDirty = () => { dirtyRef.current = true; };

  useEffect(() => { firstField.current?.focus(); }, []);

  // Hydrate fields when metadata arrives. The editor often opens before the
  // bridge has the kind:0 cached (cold relay or first paint), so `initial`
  // is null on mount and the fields stay empty until the user refreshes.
  // Re-syncing whenever `initial` changes fills them in as soon as the
  // metadata lands — without clobbering whatever the user has already typed.
  useEffect(() => {
    if (!initial || dirtyRef.current) return;
    setName(initial.displayName || initial.name || '');
    setAbout(initial.about || '');
    setPicture(initial.picture || '');
    setBanner(initial.banner || '');
    setNip05(initial.nip05 || '');
    setWebsite(initial.website || '');
  }, [initial]);

  const save = async () => {
    if (!name.trim()) { setError(t('user.nameRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      if (!publishProfile) throw new Error(t('user.notSignedIn'));
      await publishProfile({
        name: name.trim(),
        display_name: name.trim(),
        about: about.trim(),
        picture: picture.trim(),
        banner: banner.trim(),
        nip05: nip05.trim(),
        website: website.trim(),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('user.publishFailed'));
    } finally {
      setSaving(false);
    }
  };

  const fieldCls = 'w-full rounded-md border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white placeholder:text-lc-muted focus:border-lc-green focus:outline-none';

  return (
    <div className="space-y-3 p-4">
      <Field label={t('user.field.name')}>
        <input ref={firstField} value={name} onChange={(e) => { markDirty(); setName(e.target.value); }} className={fieldCls} />
      </Field>
      <Field label={t('user.about')}>
        <textarea value={about} onChange={(e) => { markDirty(); setAbout(e.target.value); }} rows={2} className={fieldCls} />
      </Field>
      <BlossomImageInput
        label={t('user.field.picture')}
        value={picture}
        onChange={(url) => { markDirty(); setPicture(url); }}
        shape="square"
      />
      <BlossomImageInput
        label={t('user.field.banner')}
        value={banner}
        onChange={(url) => { markDirty(); setBanner(url); }}
        shape="wide"
        accept="image/*"
      />
      <Field label="NIP-05">
        <input value={nip05} onChange={(e) => { markDirty(); setNip05(e.target.value); }} placeholder="you@example.com" className={fieldCls} />
      </Field>
      <Field label={t('user.field.website')}>
        <input value={website} onChange={(e) => { markDirty(); setWebsite(e.target.value); }} placeholder="https://…" className={fieldCls} />
      </Field>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-lc-green px-3 py-1.5 text-sm font-semibold text-lc-black hover:bg-lc-green/90 disabled:opacity-50"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-lc-border px-3 py-1.5 text-sm text-lc-white hover:bg-lc-border/40"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export function PreferencesPanel() {
  const prefs = usePreferences();
  const { t } = useTranslation();
  return (
    <div className="space-y-4 p-4">
      <LanguagePreference />
      <AppearancePreferenceControls />
      <ToggleRow
        label="Developer relay logs"
        description="Log relay calls to the console."
        checked={prefs.developerRelayDebug}
        onChange={(v) => setPreference('developerRelayDebug', v)}
      />
      <ToggleRow
        label={t('preferences.activity.label')}
        description={t('preferences.activity.description')}
        checked={prefs.showActivityIndicator}
        onChange={(v) => setPreference('showActivityIndicator', v)}
      />
      <ToggleRow
        label={t('preferences.directMessages.label')}
        description={t('preferences.directMessages.description')}
        checked={prefs.directMessagesEnabled}
        onChange={setDmOptInEnabled}
      />
      <WotSettings />
      <LocalDataSection />
    </div>
  );
}

function LocalDataSection() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const onConfirm = () => {
    setClearing(true);
    const removed = clearAllClientCacheExceptSession();
    // Tiny pause so the modal copy reads naturally before the reload.
    setTimeout(() => {
      // Reload from server to rebuild every store from scratch. We keep the
      // session + preferences so the user lands back in the same place.
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
      // Defensive: if the reload didn't fire (e.g. test harness), reset state.
      setClearing(false);
      setConfirming(false);
      void removed;
    }, 200);
  };

  return (
    <div className="pt-2 border-t border-lc-border">
      <div className="text-xs uppercase tracking-wider text-lc-muted font-semibold pt-2 pb-2">
        {t('preferences.localData.title')}
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-lc-white">{t('preferences.localData.clear.title')}</div>
          <div className="text-xs text-lc-muted mt-0.5">
            {t('preferences.localData.clear.description')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={clearing}
          className="shrink-0 rounded-md border border-lc-border bg-lc-black px-3 py-1.5 text-sm text-lc-white hover:bg-lc-border/40 disabled:opacity-50"
          data-testid="clear-cache-button"
        >
          {t('preferences.localData.clear.button')}
        </button>
      </div>
      {confirming && (
        <ModalShell
          onClose={() => !clearing && setConfirming(false)}
          testId="clear-cache-confirm"
          panelClassName="w-full max-w-md mx-4 rounded-xl bg-lc-dark border border-lc-border p-6 shadow-xl"
        >
          <div className="text-lg font-semibold text-lc-white mb-2">{t('preferences.localData.confirm.title')}</div>
          <div className="text-sm text-lc-muted mb-4">
            {t('preferences.localData.confirm.description')}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={clearing}
              className="rounded-md border border-lc-border px-3 py-1.5 text-sm text-lc-white hover:bg-lc-border/40 disabled:opacity-50"
            >
              {t('preferences.localData.confirm.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={clearing}
              className="rounded-md bg-lc-green px-3 py-1.5 text-sm font-semibold text-lc-black hover:bg-lc-green/90 disabled:opacity-50"
              data-testid="clear-cache-confirm-button"
            >
              {clearing ? t('preferences.localData.confirm.clearing') : t('preferences.localData.confirm.action')}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <div className="min-w-0">
        <div className="text-sm text-lc-white">{label}</div>
        {description && <div className="text-xs text-lc-muted mt-0.5">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-lc-green' : 'bg-lc-border'}`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-lc-black transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </button>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-lc-muted">{label}</span>
      {children}
    </label>
  );
}
