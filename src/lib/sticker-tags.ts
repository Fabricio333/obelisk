import { isValidCustomEmojiName, normalizeCustomEmojiName } from './custom-emoji-tags';

export interface MessageSticker {
  readonly name: string;
  readonly url: string;
  readonly packAddress?: string;
}

const PACK_ADDRESS_RE = /^30030:[0-9a-f]{64}:.+$/;

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function stickerFromTags(
  content: string,
  tags: ReadonlyArray<ReadonlyArray<string>>,
): MessageSticker | null {
  const tag = tags.find((candidate) => candidate[0] === 'sticker');
  const name = normalizeCustomEmojiName(tag?.[1] ?? '');
  const url = tag?.[2]?.trim() ?? '';
  if (!isValidCustomEmojiName(name) || !isHttpUrl(url)) return null;
  const packAddress = tag?.[3]?.trim() ?? '';
  return content.trim() === ':' + name + ':'
    ? { name, url, ...(PACK_ADDRESS_RE.test(packAddress) ? { packAddress } : {}) }
    : null;
}

export function stickerTagsForContent(
  content: string,
  sticker: MessageSticker | null | undefined,
): string[][] {
  if (!sticker) return [];
  const name = normalizeCustomEmojiName(sticker.name);
  const url = sticker.url.trim();
  if (!isValidCustomEmojiName(name) || !isHttpUrl(url) || content.trim() !== ':' + name + ':') return [];
  const packAddress = PACK_ADDRESS_RE.test(sticker.packAddress ?? '') ? sticker.packAddress : undefined;
  return [
    ['emoji', name, url, ...(packAddress ? [packAddress] : [])],
    ['sticker', name, url, ...(packAddress ? [packAddress] : [])],
  ];
}
