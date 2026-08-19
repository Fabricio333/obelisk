'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from '@/i18n/context';
import type { PqProtectionLevel } from '@/lib/pq/status';

/**
 * The protection indicator for a DM thread: one small shield in the header,
 * with the explanation behind a hover or a tap.
 *
 * This replaces a full-width banner that sat permanently above every
 * conversation. The banner was accurate but disproportionate — a standing
 * yellow warning for the ordinary case, which is the state almost every Nostr
 * conversation is in and will stay in for a while. A warning that never goes
 * away stops being read, and this one also had nothing good to say about the
 * gift wrap that *was* protecting the user.
 *
 * So the shield reports all three rungs, and only the top one is coloured.
 * `wrapped` and `basic` are neutral: they are states to understand, not
 * alarms.
 */

const SIZE = 16;

function ShieldQuantum() {
  // Shield with a tick: everything the wrap gives, plus quantum protection.
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 11.5l2 2 4-4" />
    </svg>
  );
}

function ShieldWrapped() {
  // Plain shield: contents locked and the social graph hidden.
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LockBasic() {
  // A padlock rather than a shield: the contents are locked, but the envelope
  // is not — deliberately a different silhouette, not a dimmer shield, so the
  // two are distinguishable without relying on colour.
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 018 0v4" />
    </svg>
  );
}

const ICONS: Record<PqProtectionLevel, () => React.ReactElement> = {
  quantum: ShieldQuantum,
  wrapped: ShieldWrapped,
  basic: LockBasic,
};

const TONE: Record<PqProtectionLevel, string> = {
  quantum: 'text-lc-green',
  // Neutral on purpose. These are not warnings.
  wrapped: 'text-lc-muted hover:text-lc-white',
  basic: 'text-lc-muted hover:text-lc-white',
};

export default function PqShield({
  level,
  guideHref,
}: {
  level: PqProtectionLevel;
  guideHref: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelId = useId();

  // Pointer users get it on hover, but the panel holds a link, so touch and
  // keyboard need a real toggle — hover alone would put that link out of reach
  // on a phone, which is where this is most likely to be read.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const Icon = ICONS[level];
  const label = t(`pq.level.${level}`);
  const detail = t(`pq.level.${level}Detail`);

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        data-testid="pq-shield"
        data-level={level}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        // The visible panel is hover-dependent, so the button carries the
        // whole statement itself for anyone who never sees it.
        aria-label={`${label}. ${detail}`}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Keep it open while focus is inside the panel, or the guide link
          // can never be reached by keyboard.
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
        className={`rounded p-1 transition-colors ${TONE[level]}`}
      >
        <Icon />
      </button>

      {open && (
        <span
          id={panelId}
          role="tooltip"
          className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-lc-border bg-lc-dark p-3 text-left shadow-lg"
        >
          <span className={`block text-xs font-semibold ${level === 'quantum' ? 'text-lc-green' : 'text-lc-white'}`}>
            {label}
          </span>
          <span className="mt-1 block text-xs leading-snug text-lc-muted">{detail}</span>
          {level !== 'quantum' && (
            <Link
              href={guideHref}
              className="mt-2 inline-block text-xs font-medium text-lc-green underline underline-offset-2 hover:text-lc-green/80"
            >
              {t('pq.learnHow')}
            </Link>
          )}
        </span>
      )}
    </span>
  );
}
