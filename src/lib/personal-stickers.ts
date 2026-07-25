import { normalizeCustomEmojiName, type CustomEmojiMap } from './custom-emoji-tags';
import { createLocalStore } from './local-store';

const store = createLocalStore<CustomEmojiMap>('obelisk:personal-stickers', {});

export function loadPersonalStickers(): CustomEmojiMap {
  const saved = store.load();
  return Object.fromEntries(
    Object.entries(saved).filter(([name, url]) => normalizeCustomEmojiName(name) === name && typeof url === 'string' && url),
  );
}

export function savePersonalSticker(filename: string, url: string): CustomEmojiMap {
  const stickers = loadPersonalStickers();
  const base = normalizeCustomEmojiName(filename) || 'sticker';
  let name = base;
  for (let suffix = 2; stickers[name]; suffix += 1) name = `${base}_${suffix}`;
  const next = { ...stickers, [name]: url };
  store.save(next);
  return next;
}
