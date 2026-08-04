'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { clearAllClientCacheExceptSession } from '@/lib/nostr-bridge/cache-clear';

/**
 * The recovery UI behind `app/error.tsx` and `app/global-error.tsx`.
 *
 * Deliberately dependency-free: no `useTranslation`, no Zustand store, no
 * bridge. An error boundary that throws while rendering its own fallback
 * escalates to the next boundary up — and at the root there is none, which
 * lands the user on exactly the blank client-side-exception screen this
 * component exists to replace. So locale comes off `<html lang>` (stamped
 * by the root layout, and still readable in `global-error.tsx` where the
 * layout — and therefore `LocaleProvider` — is gone) rather than context,
 * and the only import is a pure localStorage helper with no module-level
 * side effects.
 */

type Copy = {
  title: string;
  body: string;
  retry: string;
  reload: string;
  clear: string;
  clearing: string;
  cleared: (n: number) => string;
  home: string;
  details: string;
};

const COPY: Record<'en' | 'es', Copy> = {
  en: {
    title: 'Something broke on this screen',
    body:
      'The chat surface hit an error and stopped rendering. Your keys and your messages are safe — nothing was lost, this is only the view. Try again first; if it keeps happening, clearing the local cache rebuilds it from the relay.',
    retry: 'Try again',
    reload: 'Reload the page',
    clear: 'Clear local cache and reload',
    clearing: 'Clearing…',
    cleared: (n) => `Cleared ${n} ${n === 1 ? 'entry' : 'entries'} — reloading…`,
    home: 'Back to home',
    details: 'Error details',
  },
  es: {
    title: 'Algo se rompió en esta pantalla',
    body:
      'El chat encontró un error y dejó de renderizar. Tus claves y tus mensajes están a salvo — no se perdió nada, es solo la vista. Probá de nuevo; si sigue pasando, limpiar el caché local lo reconstruye desde el relay.',
    retry: 'Probar de nuevo',
    reload: 'Recargar la página',
    clear: 'Limpiar caché local y recargar',
    clearing: 'Limpiando…',
    cleared: (n) => `Se limpiaron ${n} ${n === 1 ? 'entrada' : 'entradas'} — recargando…`,
    home: 'Volver al inicio',
    details: 'Detalles del error',
  },
};

/** Locale off `<html lang>` — set by the root layout, no provider needed. */
function readLocale(): 'en' | 'es' {
  if (typeof document === 'undefined') return 'es';
  return document.documentElement.lang === 'en' ? 'en' : 'es';
}

/** `<html lang>` is fixed for the life of the document — nothing to watch. */
const subscribeToNothing = () => () => {};
// Mirrors i18n's DEFAULT_LOCALE, duplicated on purpose: importing it would
// pull both JSON dictionaries into the error chunk, and this component's
// whole contract is that it loads and renders with nothing else available.
const serverLocale = (): 'en' | 'es' => 'es';

export default function ErrorPanel({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  // `useSyncExternalStore` (rather than state + effect) so the server
  // snapshot and the client snapshot are declared separately: SSR renders
  // the default locale, the client reads `<html lang>`, and React
  // reconciles the difference itself instead of us flashing one then the
  // other through a post-mount setState.
  const locale = useSyncExternalStore(subscribeToNothing, readLocale, serverLocale);
  const [clearedCount, setClearedCount] = useState<number | null>(null);
  const t = COPY[locale];

  // Next.js swallows the original error in production builds, so without
  // this the console shows only a digest and the stack is unrecoverable.
  useEffect(() => {
    console.error('[obelisk] render error boundary caught:', error);
  }, [error]);

  const onClear = () => {
    let removed = 0;
    try {
      removed = clearAllClientCacheExceptSession();
    } catch {
      // Never block recovery on the wipe — reload regardless.
    }
    setClearedCount(removed);
    // Let the "cleared N" line paint before the navigation kills it.
    setTimeout(() => window.location.reload(), 400);
  };

  const detail = [error?.message, error?.digest && `digest: ${error.digest}`]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      data-testid="error-panel"
      className="flex min-h-screen w-full items-center justify-center bg-lc-black px-4 py-10 text-lc-white"
    >
      <div className="lc-card w-full max-w-lg p-6 sm:p-8">
        <h1 className="text-xl font-semibold sm:text-2xl">{t.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-lc-muted">{t.body}</p>

        {detail && (
          <details className="mt-5 rounded-xl border border-lc-border bg-lc-black/60">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-lc-muted">
              {t.details}
            </summary>
            <pre
              data-testid="error-panel-detail"
              className="overflow-x-auto whitespace-pre-wrap break-words px-4 pb-3 text-xs text-lc-muted"
            >
              {detail}
            </pre>
          </details>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          {reset && (
            <button type="button" onClick={reset} className="lc-pill-primary" data-testid="error-retry">
              {t.retry}
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="lc-pill-secondary"
            data-testid="error-reload"
          >
            {t.reload}
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-lc-border pt-4 text-xs">
          <button
            type="button"
            onClick={onClear}
            disabled={clearedCount !== null}
            className="text-lc-muted underline underline-offset-4 transition-colors hover:text-lc-white disabled:opacity-60"
            data-testid="error-clear-cache"
          >
            {clearedCount === null ? t.clear : t.clearing}
          </button>
          {/* A hard navigation, not next/link: client-side routing would
              carry the broken JS state into the landing page, and the
              router is exactly what we cannot assume is healthy here. */}
          <button
            type="button"
            onClick={() => { window.location.href = '/'; }}
            className="text-lc-muted underline underline-offset-4 transition-colors hover:text-lc-white"
            data-testid="error-home"
          >
            {t.home}
          </button>
        </div>

        {clearedCount !== null && (
          <p className="mt-3 text-xs text-lc-green" data-testid="error-cleared-note">
            {t.cleared(clearedCount)}
          </p>
        )}
      </div>
    </div>
  );
}
