import type { JsMediaKind } from '@/lib/nostr-bridge/types';

export function inferMediaKind(url: string): JsMediaKind {
  return /\.gif(?:$|[?#])/i.test(url) ? 'gif' : 'emoji';
}

export function isStickerLikeImage(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): boolean {
  if (width <= 0 || height <= 0 || width > 512 || height > 512 || rgba.length < 4) return false;
  let transparent = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] < 224) transparent += 1;
  }
  return transparent / (rgba.length / 4) >= 0.08;
}

const detected = new Map<string, Promise<JsMediaKind>>();

export function detectGifPresentation(url: string): Promise<JsMediaKind> {
  if (inferMediaKind(url) !== 'gif' || typeof Image === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(inferMediaKind(url));
  }
  const cached = detected.get(url);
  if (cached) return cached;
  const pending = new Promise<JsMediaKind>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const scale = Math.min(1, 64 / image.naturalWidth, 64 / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve('gif');
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        resolve(isStickerLikeImage(image.naturalWidth, image.naturalHeight, pixels) ? 'sticker' : 'gif');
      } catch {
        resolve('gif');
      }
    };
    image.onerror = () => resolve('gif');
    image.src = url;
  });
  detected.set(url, pending);
  return pending;
}
