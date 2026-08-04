'use client';

import ErrorPanel from '@/components/ErrorPanel';
// `global-error.tsx` replaces the root layout wholesale, so the layout's
// own `globals.css` import is not in play here — pull it in or the lc-*
// classes render unstyled.
import './globals.css';

/**
 * Last-resort boundary: catches throws in the root layout itself, which
 * `error.tsx` cannot see (it renders *inside* that layout).
 *
 * Because it replaces the layout, this file owns the `<html>` and `<body>`
 * tags, and nothing from the provider tree is available — which is exactly
 * why {@link ErrorPanel} takes no context and reads its locale off
 * `<html lang>`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body className="bg-lc-black text-lc-white antialiased">
        <ErrorPanel error={error} reset={reset} />
      </body>
    </html>
  );
}
