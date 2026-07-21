/**
 * `:name:` → unicode emoji resolution. The shortcode map is derived from the
 * EmojiPicker's keyword data so both the picker and the autocomplete stay in
 * sync. Curated aliases handle common Discord/Slack shortcuts (`+1`, `heart`,
 * `fire`) that aren't necessarily the canonical first keyword.
 *
 * Resolution happens at render time in `MessageContent.tsx`: the raw text
 * (with `:smile:` etc.) is kept in the DB, and the renderer swaps it at
 * render time. This keeps messages portable across future custom/unicode
 * emoji sets without re-writing stored content.
 */

import { UNICODE_EMOJI_ENTRIES, type EmojiEntry } from '@/components/chat/emoji-data';
import {
  mergeCustomEmojiMaps,
  normalizeCustomEmojiName,
  type CustomEmojiMap,
} from '@/lib/custom-emoji-tags';

export type { EmojiEntry };

// name → unicode char. Built once on module load. The first-keyword of each
// EmojiEntry becomes its canonical shortcode; curated aliases below take
// precedence (they overwrite any colliding first-keyword entry) so common
// shortcuts like `:heart:` resolve to the red heart ❤️ rather than whatever
// the first heart-related entry in the picker happens to be.
const MAP: Record<string, string> = {};

for (const entry of UNICODE_EMOJI_ENTRIES) {
  const canonical = entry.keywords[0];
  if (canonical && !MAP[canonical]) {
    MAP[canonical] = entry.char;
  }
}

// Curated aliases — these intentionally override the first-keyword mapping
// for common shortcuts used across Slack/Discord/GitHub. Keep the list
// small; bloat hurts render-time allocations on every message.
const ALIASES: Record<string, string> = {
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  heart: '❤️',
  fire: '🔥',
  tada: '🎉',
  rocket: '🚀',
  eyes: '👀',
  ok: '👌',
  wave: '👋',
  pray: '🙏',
  muscle: '💪',
  clap: '👏',
  sparkles: '✨',
  star: '⭐',
  check: '✅',
  x: '❌',
  warning: '⚠️',
  bulb: '💡',
  coffee: '☕',
  pizza: '🍕',
  cake: '🎂',
  beer: '🍺',
};

for (const [alias, char] of Object.entries(ALIASES)) {
  MAP[alias] = char;
}

// Rocket isn't in the curated picker dataset but we alias it above, so expose
// it for consistency. This const stays private — callers should use the
// resolver functions below to avoid accidental mutation.

export const UNICODE_SHORTCODES: Readonly<Record<string, string>> = MAP;

/**
 * Resolve a bare shortcode name (without colons) to a unicode emoji char,
 * or null if no mapping exists.
 */
export function resolveUnicodeShortcode(name: string): string | null {
  return MAP[name.toLowerCase()] || null;
}

/**
 * Filter available shortcode names by a prefix/substring query. Used by the
 * composer autocomplete. Returns up to `limit` results, sorted so exact-prefix
 * matches come first, then substring matches, alphabetically within each.
 */
export function searchShortcodes(
  query: string,
  customEmojis: CustomEmojiMap = {},
  limit = 8,
): Array<{ name: string; char: string; isCustom: boolean }> {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  // Four buckets: custom-prefix, unicode-prefix, custom-infix, unicode-infix.
  // Keeping them separate preserves the "customs beat unicodes" ordering even
  // after alphabetical sorting within each bucket.
  const customPrefix: Array<{ name: string; char: string; isCustom: boolean }> = [];
  const unicodePrefix: Array<{ name: string; char: string; isCustom: boolean }> = [];
  const customInfix: Array<{ name: string; char: string; isCustom: boolean }> = [];
  const unicodeInfix: Array<{ name: string; char: string; isCustom: boolean }> = [];

  for (const [name, url] of Object.entries(customEmojis)) {
    if (seen.has(name)) continue;
    if (name.startsWith(q)) {
      customPrefix.push({ name, char: url, isCustom: true });
      seen.add(name);
    } else if (q && name.includes(q)) {
      customInfix.push({ name, char: url, isCustom: true });
      seen.add(name);
    }
  }

  for (const [name, char] of Object.entries(MAP)) {
    if (seen.has(name)) continue;
    if (name.startsWith(q)) {
      unicodePrefix.push({ name, char, isCustom: false });
      seen.add(name);
    } else if (q && name.includes(q)) {
      unicodeInfix.push({ name, char, isCustom: false });
      seen.add(name);
    }
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  customPrefix.sort(byName);
  unicodePrefix.sort(byName);
  customInfix.sort(byName);
  unicodeInfix.sort(byName);

  return [...customPrefix, ...unicodePrefix, ...customInfix, ...unicodeInfix].slice(0, limit);
}

/**
 * Replace `:name:` tokens in `text` with the resolved unicode/custom emoji.
 * Custom emojis are encoded as placeholder tokens `\u3008EMOJI:<name>\u3009`
 * so the downstream `MessageContent` renderer can swap them for `<img>`
 * elements — mirroring the mention placeholder strategy.
 *
 * Tokens are only replaced when word-bounded (preceded by start-of-string,
 * whitespace, or `>`, and followed by end/whitespace/punctuation) so that
 * URLs like `http://x.com/:colon:` don't match. Fenced code blocks and
 * inline backtick spans are preserved by splitting on them and only
 * running the replacement on the text-between-code segments.
 */
export const CUSTOM_EMOJI_PLACEHOLDER_PREFIX = '\u3008EMOJI:';
export const CUSTOM_EMOJI_PLACEHOLDER_SUFFIX = '\u3009';
export const CUSTOM_EMOJI_PLACEHOLDER_REGEX = /\u3008EMOJI:([a-z0-9_-]+)\u3009/g;

const SHORTCODE_TOKEN_REGEX =
  /(^|[\s>(])(:([a-z0-9_+-]{1,64}):)(?=$|[\s.,!?;:)])/g;

export function replaceShortcodes(
  text: string,
  customEmojis: CustomEmojiMap = {},
): string {
  if (!text || !text.includes(':')) return text;

  // Split on fenced (```…```) and inline (`…`) code spans so we can skip them.
  // Odd-indexed segments are code and preserved as-is.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (!seg || !seg.includes(':')) continue;
    parts[i] = seg.replace(SHORTCODE_TOKEN_REGEX, (_match, pre: string, _full: string, name: string) => {
      const lower = normalizeCustomEmojiName(name);
      const unicode = MAP[lower];
      if (unicode) return `${pre}${unicode}`;
      if (customEmojis[lower]) {
        return `${pre}${CUSTOM_EMOJI_PLACEHOLDER_PREFIX}${lower}${CUSTOM_EMOJI_PLACEHOLDER_SUFFIX}`;
      }
      return `${pre}:${name}:`;
    });
  }
  return parts.join('');
}

/**
 * Resolve a reaction string to either a unicode char or a custom-emoji URL.
 * Used by `MessageArea.ReactionsDisplay` so custom reactions render as
 * `<img>` without needing a schema change (the column stays a bare String).
 */
export function resolveReactionEmoji(
  emoji: string,
  customEmojis: CustomEmojiMap = {},
): { kind: 'unicode'; char: string } | { kind: 'custom'; name: string; url: string } {
  const m = /^:([a-z0-9_+-]{1,64}):$/i.exec(emoji);
  if (m) {
    const name = normalizeCustomEmojiName(m[1]);
    if (customEmojis[name]) {
      return { kind: 'custom', name, url: customEmojis[name] };
    }
    const unicode = MAP[name];
    if (unicode) return { kind: 'unicode', char: unicode };
  }
  return { kind: 'unicode', char: emoji };
}

export interface GroupedReaction {
  emoji: string;
  customEmojis: CustomEmojiMap;
  pubkeys: Set<string>;
  reactionIds: string[];
  myReactionId: string | null;
  count: number;
  mine: boolean;
}

export function groupReactions(
  reactions: ReadonlyArray<{ id: string; pubkey: string; emoji: string; customEmojis?: Readonly<Record<string, string>> }>,
  myPubkey: string | null,
  serverEmojis: CustomEmojiMap,
): GroupedReaction[] {
  const groups = new Map<string, GroupedReaction>();
  for (const reaction of reactions) {
    const customEmojis = mergeCustomEmojiMaps(serverEmojis, reaction.customEmojis);
    const resolved = resolveReactionEmoji(reaction.emoji, customEmojis);
    const key = resolved.kind === 'custom'
      ? "custom:" + resolved.name + ":" + resolved.url
      : "unicode:" + resolved.char;
    let group = groups.get(key);
    if (!group) {
      group = {
        emoji: resolved.kind === 'custom' ? ":" + resolved.name + ":" : resolved.char,
        customEmojis: resolved.kind === 'custom' ? { [resolved.name]: resolved.url } : {},
        pubkeys: new Set(),
        reactionIds: [],
        myReactionId: null,
        count: 0,
        mine: false,
      };
      groups.set(key, group);
    }
    group.reactionIds.push(reaction.id);
    group.pubkeys.add(reaction.pubkey);
    group.count = group.pubkeys.size;
    if (reaction.pubkey === myPubkey) {
      group.mine = true;
      group.myReactionId = reaction.id;
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}
