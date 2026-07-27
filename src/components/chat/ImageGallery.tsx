'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MediaLibraryModal from '@/components/media/MediaLibraryModal';
import { normalizeCustomEmojiName } from '@/lib/custom-emoji-tags';
import { inferMediaKind } from '@/lib/media-kind';
import { useMediaPacks, useMyMediaFavorites, type JsMediaItem, type JsMediaPack } from '@/lib/nostr-bridge';
import { useChatStore } from '@/store/chat';

interface ImageGalleryProps {
  urls: string[];
  wide?: boolean;
}

/**
 * Discord-style image matrix:
 *   1  → single large image (natural aspect)
 *   2  → side-by-side squares
 *   3  → one big left, two stacked right
 *   4  → 2×2 grid
 *   5+ → 2×2 grid of the first 4 images, last tile shows "+N more" overlay
 *       that opens the full lightbox carousel.
 *
 * Tapping any tile opens the lightbox on that index. Lightbox supports
 * prev/next + keyboard arrows + Esc.
 */
export default function ImageGallery({ urls, wide = false }: ImageGalleryProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<{ pack?: JsMediaPack; item: JsMediaItem } | null>(null);
  const packs = useMediaPacks();
  const favorites = useMyMediaFavorites();
  const serverEmojis = useChatStore((state) => state.serverEmojis);
  const serverMediaKinds = useChatStore((state) => state.serverMediaKinds);

  const gifSelections = useMemo(() => {
    const selections = new Map<string, { pack?: JsMediaPack; item: JsMediaItem }>();
    for (const pack of Object.values(packs)) {
      for (const item of pack.items) if (item.kind === 'gif') selections.set(item.url, { pack, item });
    }
    for (const item of favorites.items) {
      if (item.kind === 'gif' && !selections.has(item.url)) selections.set(item.url, { item });
    }
    for (const [name, url] of Object.entries(serverEmojis)) {
      if (serverMediaKinds[name] === 'gif' && !selections.has(url)) selections.set(url, { item: { name, url, kind: 'gif' } });
    }
    for (const url of urls) {
      if (inferMediaKind(url) !== 'gif' || selections.has(url)) continue;
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const filename = parts.at(-1) ?? '';
      const rawName = /^giphy\.gif$/i.test(filename) ? parts.at(-2) : filename;
      selections.set(url, { item: { name: normalizeCustomEmojiName(rawName ?? '') || 'gif', url, kind: 'gif' } });
    }
    return selections;
  }, [favorites.items, packs, serverEmojis, serverMediaKinds, urls]);

  const open = (i: number) => {
    const selection = gifSelections.get(urls[i]);
    if (selection) setSelectedMedia(selection);
    else setLightboxIndex(i);
  };
  const close = useCallback(() => setLightboxIndex(null), []);
  const next = useCallback(
    () => setLightboxIndex((i) => (i === null ? null : (i + 1) % urls.length)),
    [urls.length],
  );
  const prev = useCallback(
    () =>
      setLightboxIndex((i) =>
        i === null ? null : (i - 1 + urls.length) % urls.length,
      ),
    [urls.length],
  );

  useEffect(() => {
    if (lightboxIndex === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightboxIndex, close, next, prev]);

  if (urls.length === 0) return null;

  // ── Single image: keep natural aspect, bounded.
  if (urls.length === 1) {
    return (
      <>
        <div
          className={`mt-1 overflow-hidden rounded-lg bg-lc-black/50 cursor-pointer ${wide ? 'w-full max-w-full' : 'w-fit max-w-sm'}`}
          onClick={() => open(0)}
          data-testid="image-gallery"
          data-count="1"
        >
          <img
            src={urls[0]}
            alt=""
            loading="lazy"
            className={`${wide ? 'max-h-[32rem] w-full' : 'max-h-80 w-auto'} object-contain`}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
        {lightboxIndex !== null && (
          <Lightbox
            urls={urls}
            index={lightboxIndex}
            onClose={close}
            onPrev={prev}
            onNext={next}
          />
        )}
        {selectedMedia && <MediaLibraryModal onClose={() => setSelectedMedia(null)} initialSelection={selectedMedia} />}
      </>
    );
  }

  // ── 2+ images: fixed-height matrix so tiles align cleanly.
  const shown = urls.slice(0, 4);
  const overflow = urls.length - 4;

  // Layout classes per count — approximates Discord's dynamic grid.
  const gridClass =
    urls.length === 2
      ? 'grid-cols-2 grid-rows-1'
      : urls.length === 3
        ? 'grid-cols-2 grid-rows-2'
        : 'grid-cols-2 grid-rows-2';

  return (
    <>
      <div
        className={`mt-1 grid ${wide ? 'w-full max-w-full' : 'max-w-sm'} ${gridClass} gap-1 rounded-lg overflow-hidden`}
        style={{ aspectRatio: urls.length === 2 ? '2 / 1' : '1 / 1' }}
        data-testid="image-gallery"
        data-count={urls.length}
      >
        {shown.map((url, i) => {
          // 3-image layout: first tile spans both rows
          const spanClass =
            urls.length === 3 && i === 0 ? 'row-span-2' : '';
          const isLastOverflow = i === 3 && overflow > 0;
          return (
            <button
              key={`${url}-${i}`}
              type="button"
              onClick={() => open(i)}
              className={`relative overflow-hidden bg-lc-black/50 ${spanClass}`}
              data-testid="gallery-tile"
            >
              <img
                src={url}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              {isLastOverflow && (
                <div
                  className="absolute inset-0 bg-black/60 flex items-center justify-center text-lc-white text-xl font-bold"
                  data-testid="overflow-overlay"
                >
                  +{overflow}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {lightboxIndex !== null && (
        <Lightbox
          urls={urls}
          index={lightboxIndex}
          onClose={close}
          onPrev={prev}
          onNext={next}
        />
      )}
      {selectedMedia && <MediaLibraryModal onClose={() => setSelectedMedia(null)} initialSelection={selectedMedia} />}
    </>
  );
}

interface LightboxProps {
  urls: string[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function Lightbox({ urls, index, onClose, onPrev, onNext }: LightboxProps) {
  // Zoom + pan state. `scale` is clamped to [1, 5]; panning is only enabled
  // when scale > 1. Resets whenever the shown index changes.
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragging = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);

  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, [index]);

  const isZoomed = scale > 1;

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY / 500; // 500 ≈ one mousewheel notch == ~0.2 scale
    setScale((s) => {
      const next = Math.max(1, Math.min(5, s + delta));
      if (next === 1) {
        setTx(0);
        setTy(0);
      }
      return next;
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!isZoomed) return;
    e.stopPropagation();
    dragging.current = true;
    didDrag.current = false;
    lastPoint.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current || !lastPoint.current) return;
    const dx = e.clientX - lastPoint.current.x;
    const dy = e.clientY - lastPoint.current.y;
    lastPoint.current = { x: e.clientX, y: e.clientY };
    if (Math.abs(dx) + Math.abs(dy) > 2) didDrag.current = true;
    setTx((v) => v + dx);
    setTy((v) => v + dy);
  };
  const onMouseUp = () => {
    dragging.current = false;
    lastPoint.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale(1);
    setTx(0);
    setTy(0);
  };

  // Backdrop click closes only when we're neither zoomed nor dragging —
  // prevents accidental closes mid-pan.
  const handleBackdropClick = () => {
    if (isZoomed || didDrag.current) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center"
      onClick={handleBackdropClick}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onMouseMove={onMouseMove}
      data-testid="lightbox"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-lc-black/70 text-lc-white flex items-center justify-center hover:bg-lc-black z-10"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {urls.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className={`absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-lc-black/70 text-lc-white flex items-center justify-center hover:bg-lc-black ${isZoomed ? 'pointer-events-none opacity-50' : ''}`}
            data-testid="lightbox-prev"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className={`absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-lc-black/70 text-lc-white flex items-center justify-center hover:bg-lc-black ${isZoomed ? 'pointer-events-none opacity-50' : ''}`}
            data-testid="lightbox-next"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </>
      )}

      <div
        className="max-w-[90vw] max-h-[90vh]"
        onWheel={onWheel}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        style={{
          cursor: isZoomed ? (dragging.current ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        data-testid="lightbox-viewport"
      >
        <img
          src={urls[index]}
          alt=""
          draggable={false}
          className="max-w-[90vw] max-h-[90vh] object-contain select-none"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: dragging.current ? 'none' : 'transform 0.1s ease-out',
          }}
        />
      </div>

      {urls.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-lc-white bg-lc-black/70 px-3 py-1 rounded-full">
          {index + 1} / {urls.length}
        </div>
      )}
    </div>
  );
}
