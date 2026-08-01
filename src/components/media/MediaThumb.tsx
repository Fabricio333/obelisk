'use client';

import { useState, type ReactEventHandler } from 'react';

/**
 * Picker/library thumbnail that never degrades into its own shortcode.
 *
 * A bare `<img>` paints its `alt` text when the source fails (dead GIPHY link,
 * pruned Blossom blob, pack host offline), so broken media showed up in the
 * emoji/GIF/sticker grids as the literal text `:party_cat:` where the media
 * should be. Render a neutral glyph instead and keep the name for assistive
 * tech and the tooltip only.
 */
export default function MediaThumb({ src, alt, className, onLoad, onError }: {
  src: string;
  alt: string;
  className?: string;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  onError?: () => void;
}) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  if (brokenSrc === src) {
    return (
      <span
        data-testid="media-thumb-fallback"
        className={'flex items-center justify-center text-lc-muted ' + (className ?? '')}
        {...(alt ? { role: 'img', 'aria-label': alt, title: alt } : { 'aria-hidden': true })}
      >
        <svg viewBox="0 0 24 24" className="h-[1.25em] w-[1.25em]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m4 17 4.5-4.5 3 3 2-2L20 18" />
          <path d="m3 3 18 18" />
        </svg>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onLoad={onLoad}
      onError={() => {
        setBrokenSrc(src);
        onError?.();
      }}
    />
  );
}
