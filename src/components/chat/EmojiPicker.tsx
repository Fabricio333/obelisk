'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EMOJI_CATEGORIES,
  EMOJI_CATEGORY_NAMES,
  SEARCHABLE_EMOJI,
  normalizeEmojiKeyword,
} from '@/components/chat/emoji-data';
import { loadRecentEmojis, pushRecentEmoji } from '@/lib/recent-emojis';
import { normalizeCustomEmojiName, type CustomEmojiMap } from '@/lib/custom-emoji-tags';
import { useChatStore } from '@/store/chat';

const EMOJI_CATEGORY_META: Record<string, { icon: string; label: string }> = {
  Smileys: { icon: "😀", label: "Smileys & people" },
  Gestures: { icon: "👋", label: "People & gestures" },
  Objects: { icon: "💡", label: "Objects" },
  Food: { icon: "🍔", label: "Food & drink" },
  Animals: { icon: "🐻", label: "Animals & nature" },
  Nature: { icon: "🌿", label: "Plants & weather" },
  Transport: { icon: "🚗", label: "Cars & transport" },
  Flags: { icon: "🏳️", label: "Flags" },
  Activities: { icon: "⚽", label: "Activities" },
};

export interface PickedCustomEmoji {
  readonly name: string;
  readonly url: string;
}

interface CustomEmojiEntry extends PickedCustomEmoji {
  readonly isGif: boolean;
}

function isGifEmojiUrl(url: string): boolean {
  try {
    return /\.gif$/i.test(new URL(url).pathname);
  } catch {
    return /\.gif(?:$|[?#])/i.test(url);
  }
}

export interface EmojiPickerProps {
  onPick: (emoji: string, custom?: PickedCustomEmoji) => void;
  onClose: () => void;
  /** Emojis disabled (e.g. ones the user already reacted with). */
  disabledEmojis?: ReadonlySet<string>;
  /** When true, picking does not record in recents (useful for previews). */
  skipRecent?: boolean;
  /**
   * `popover` (default): small absolute-positioned floating panel for desktop.
   * `sheet`: fills its parent (used inside the mobile bottom-sheet host).
   */
  variant?: 'popover' | 'sheet';
  /** Popover direction relative to the trigger. Ignored for sheet variant. */
  placement?: 'above' | 'below';
  showClose?: boolean;
  className?: string;
  customEmojis?: CustomEmojiMap;
  children?: ReactNode;
}

export function MediaPickerSearch({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl border border-lc-green/80 bg-lc-dark px-3 text-lc-muted focus-within:border-lc-green">
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-lc-white outline-none placeholder:text-lc-muted"
      />
    </label>
  );
}

export default function EmojiPicker({
  onPick,
  onClose,
  disabledEmojis,
  skipRecent = false,
  variant = 'popover',
  placement = 'above',
  showClose = true,
  className,
  customEmojis: customEmojisProp,
  children,
}: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>(() => loadRecentEmojis());
  const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORY_NAMES[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const storeCustomEmojis = useChatStore((s) => s.serverEmojis);
  const customEmojis = customEmojisProp ?? storeCustomEmojis;

  const q = normalizeEmojiKeyword(query.trim());
  const filtered = useMemo(() => {
    if (!q) return null;
    return SEARCHABLE_EMOJI.filter((e) => e.haystack.includes(q)).slice(0, 80);
  }, [q]);
  const customEntries = useMemo<CustomEmojiEntry[]>(
    () => Object.entries(customEmojis)
      .map(([name, url]) => ({
        name: normalizeCustomEmojiName(name),
        url,
        isGif: isGifEmojiUrl(url),
      }))
      .filter((e) => e.name && e.url)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [customEmojis],
  );
  const customGifEntries = useMemo(
    () => customEntries.filter((e) => e.isGif),
    [customEntries],
  );
  const customEmojiEntries = useMemo(
    () => customEntries.filter((e) => !e.isGif),
    [customEntries],
  );
  const filteredCustomGifEntries = useMemo(() => {
    const list = q ? customGifEntries.filter((e) => e.name.includes(q)) : customGifEntries;
    return list.slice(0, 80);
  }, [customGifEntries, q]);
  const filteredCustomEmojiEntries = useMemo(() => {
    const list = q ? customEmojiEntries.filter((e) => e.name.includes(q)) : customEmojiEntries;
    return list.slice(0, 80);
  }, [customEmojiEntries, q]);
  const filteredCustomCount = filteredCustomGifEntries.length + filteredCustomEmojiEntries.length;

  const disabled = disabledEmojis ?? new Set<string>();

  const handlePick = (emoji: string) => {
    if (!skipRecent) setRecents(pushRecentEmoji(emoji));
    onPick(emoji);
  };
  const handlePickCustom = (emoji: PickedCustomEmoji) => {
    const shortcode = `:${emoji.name}:`;
    if (!skipRecent) setRecents(pushRecentEmoji(shortcode));
    onPick(shortcode, emoji);
  };

  const jumpToCategory = (category: string) => {
    setActiveCategory(category);
    const scroller = scrollRef.current;
    const target = scroller?.querySelector<HTMLElement>(`[data-emoji-category="${category}"]`);
    if (scroller && target) scroller.scrollTo({ top: target.offsetTop, behavior: "smooth" });
  };

  const isSheet = variant === 'sheet';
  const popoverPlacementClass = placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1';
  const containerClass = isSheet
    ? 'flex h-full w-full flex-col bg-lc-black p-3 text-lc-white '
    : `absolute right-0 ${popoverPlacementClass} z-30 flex h-[430px] w-[360px] flex-col overflow-hidden rounded-lg border border-lc-border bg-lc-black text-lc-white shadow-2xl `;
  const gridClass = isSheet
    ? 'grid grid-cols-7 gap-1.5'
    : 'grid grid-cols-8 gap-1 px-3';
  const emojiBtnClass = isSheet
    ? 'flex aspect-square items-center justify-center rounded-md text-2xl active:bg-[#3f4147] disabled:cursor-default disabled:opacity-40'
    : 'flex aspect-square items-center justify-center rounded-md text-2xl hover:bg-[#3f4147] disabled:cursor-default disabled:opacity-40';
  const scrollClass = isSheet
    ? 'relative min-h-0 flex-1 overflow-y-auto'
    : 'relative min-h-0 flex-1 overflow-y-auto pb-3';
  const sectionTitleClass = isSheet
    ? 'mb-2 px-1 text-[11px] font-bold uppercase tracking-wider text-[#b5bac1]'
    : 'sticky top-0 z-10 mb-2 bg-lc-black/95 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-[#b5bac1] backdrop-blur';
  const customImageClass = isSheet
    ? 'h-[1.45em] w-[1.45em] object-contain'
    : 'h-8 w-8 object-contain';

  const renderCustomSection = (title: string, entries: ReadonlyArray<CustomEmojiEntry>) => {
    if (entries.length === 0) return null;
    return (
      <div className="mb-2">
        <div className={sectionTitleClass}>{title}</div>
        <div className={gridClass}>
          {entries.map((e) => {
            const shortcode = `:${e.name}:`;
            const mine = disabled.has(shortcode);
            return (
              <button
                key={`custom-${e.name}`}
                onClick={() => handlePickCustom(e)}
                disabled={mine}
                className={emojiBtnClass}
                title={mine ? 'Already reacted' : shortcode}
              >
                <img src={e.url} alt={shortcode} className={customImageClass} />
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label="Emoji picker"
      className={containerClass + (className ?? '')}
      onClick={(e) => e.stopPropagation()}
    >
      {!filtered && (
        <nav className="mb-2 flex shrink-0 gap-1 overflow-x-auto border-b border-lc-border px-1 pb-1" aria-label="Emoji categories">
          {EMOJI_CATEGORY_NAMES.map((category) => {
            const meta = EMOJI_CATEGORY_META[category] ?? { icon: "•", label: category };
            return (
              <button
                type="button"
                key={category}
                onClick={() => jumpToCategory(category)}
                aria-label={meta.label}
                aria-pressed={activeCategory === category}
                title={meta.label}
                className={`flex h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border-b-2 text-xl ${activeCategory === category ? "border-lc-green bg-lc-green/10" : "border-transparent hover:bg-white/5"}`}
              >
                <span aria-hidden="true">{meta.icon}</span>
              </button>
            );
          })}
        </nav>
      )}
      {children}
      <div className={isSheet ? 'my-2 flex items-center gap-2' : 'border-b border-black/20 p-3'}>
        {!isSheet && (
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-lc-white">Emoji</div>
              <div className="text-[11px] text-[#b5bac1]">Server emojis, GIFs, and unicode</div>
            </div>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded text-[#b5bac1] hover:bg-[#3f4147] hover:text-lc-white"
              aria-label="Close emoji picker"
              title="Close"
            >
              x
            </button>
          </div>
        )}
        <MediaPickerSearch
          autoFocus={!isSheet}
          value={query}
          onChange={setQuery}
          placeholder="Search emoji"
        />
        {isSheet && showClose && (
          <button
            onClick={onClose}
            className="h-9 w-9 rounded text-lc-muted hover:bg-[#3f4147] hover:text-lc-white"
            aria-label="Close emoji picker"
            title="Close"
          >
            x
          </button>
        )}
      </div>
      <div ref={scrollRef} className={scrollClass}>
        {filtered ? (
          <>
            {renderCustomSection('Server GIFs', filteredCustomGifEntries)}
            {renderCustomSection('Server emojis', filteredCustomEmojiEntries)}
            <div className={gridClass}>
              {filtered.length === 0 && filteredCustomCount === 0 && (
                <div className="col-span-8 py-4 text-center text-xs text-lc-muted">No matches</div>
              )}
              {filtered.map((e) => {
                const mine = disabled.has(e.char);
                return (
                  <button
                    key={e.char}
                    onClick={() => handlePick(e.char)}
                    disabled={mine}
                    className={emojiBtnClass}
                    title={mine ? 'Already reacted' : e.keywords[0]}
                  >
                    {e.char}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            {recents.length > 0 && (
              <div className="mb-2">
                <div className={sectionTitleClass}>Frequently used</div>
                <div className={gridClass}>
                  {recents.map((char) => {
                    const customMatch = /^:([a-z0-9_]{1,64}):$/i.exec(char);
                    const custom = customMatch ? customEntries.find((e) => e.name === normalizeCustomEmojiName(customMatch[1])) : null;
                    const mine = disabled.has(char);
                    return (
                      <button
                        key={`recent-${char}`}
                        onClick={() => custom ? handlePickCustom(custom) : handlePick(char)}
                        disabled={mine}
                        className={emojiBtnClass}
                        title={mine ? 'Already reacted' : 'Recent'}
                      >
                        {custom ? (
                          <img src={custom.url} alt={char} className={customImageClass} />
                        ) : char}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {renderCustomSection('Server GIFs', customGifEntries)}
            {renderCustomSection('Server emojis', customEmojiEntries)}
            {EMOJI_CATEGORY_NAMES.map((cat) => (
              <div key={cat} className="mb-2 scroll-mt-1" data-emoji-category={cat}>
                <div className={sectionTitleClass}>{EMOJI_CATEGORY_META[cat]?.label ?? cat}</div>
                <div className={gridClass}>
                  {EMOJI_CATEGORIES[cat].map((e) => {
                    const mine = disabled.has(e.char);
                    return (
                      <button
                        key={e.char}
                        onClick={() => handlePick(e.char)}
                        disabled={mine}
                        className={emojiBtnClass}
                        title={mine ? 'Already reacted' : e.keywords[0]}
                      >
                        {e.char}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
