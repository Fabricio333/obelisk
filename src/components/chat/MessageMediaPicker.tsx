'use client';

import { useMemo, useRef, useState } from 'react';
import EmojiPicker, { MediaPickerSearch, type PickedCustomEmoji } from './EmojiPicker';
import { uploadToBlossom } from '@/lib/blossom';
import { loadPersonalStickers, savePersonalSticker } from '@/lib/personal-stickers';
import { normalizeCustomEmojiName, type CustomEmojiMap } from '@/lib/custom-emoji-tags';

export type MediaPickerTab = 'emoji' | 'gif' | 'sticker';

export default function MessageMediaPicker({
  onPick,
  onClose,
  variant = 'popover',
  placement = 'above',
  customEmojis = {},
  initialTab = 'emoji',
}: {
  onPick: (emoji: string, custom?: PickedCustomEmoji, kind?: MediaPickerTab) => void;
  onClose: () => void;
  variant?: 'popover' | 'sheet';
  placement?: 'above' | 'below';
  customEmojis?: CustomEmojiMap;
  initialTab?: MediaPickerTab;
}) {
  const [tab, setTab] = useState<MediaPickerTab>(initialTab);
  const [query, setQuery] = useState('');
  const [personal, setPersonal] = useState<CustomEmojiMap>(() => loadPersonalStickers());
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () => Object.entries({ ...customEmojis, ...personal })
      .map(([name, url]) => ({ name: normalizeCustomEmojiName(name), url }))
      .filter((entry) => entry.name && entry.url && (!query.trim() || entry.name.includes(normalizeCustomEmojiName(query))))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [customEmojis, personal, query],
  );
  const visible = entries.filter((entry) => /\.gif(?:$|[?#])/i.test(entry.url) === (tab === 'gif'));
  const isSheet = variant === 'sheet';
  const placementClass = placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1';
  const shellClass = isSheet
    ? 'flex h-full w-full flex-col overflow-hidden bg-lc-black text-lc-white'
    : `absolute left-0 ${placementClass} z-40 flex h-[430px] w-[380px] flex-col overflow-hidden rounded-2xl border border-lc-border bg-lc-black text-lc-white shadow-2xl`;

  if (tab === 'emoji') {
    return (
      <div className={shellClass}>
        <div className="min-h-0 flex-1 [&_[role=dialog]]:static [&_[role=dialog]]:h-full [&_[role=dialog]]:w-full [&_[role=dialog]]:rounded-none [&_[role=dialog]]:border-0">
          <EmojiPicker
            variant="sheet"
            showClose={false}
            customEmojis={{}}
            onPick={onPick}
            onClose={onClose}
          >
            <PickerTabs tab={tab} onTab={setTab} onClose={onClose} />
          </EmojiPicker>
        </div>
      </div>
    );
  }

  const createSticker = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadToBlossom(file);
      setPersonal(savePersonalSticker(file.name, url));
      setTab('sticker');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div role="dialog" aria-label="Media picker" className={shellClass} onClick={(event) => event.stopPropagation()}>
      <PickerTabs tab={tab} onTab={setTab} onClose={onClose} />
      <div className="border-b border-white/10 p-3">
        <MediaPickerSearch
          value={query}
          onChange={setQuery}
          placeholder={tab === "gif" ? "Search GIFs" : "Search stickers"}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-4 auto-rows-[82px] content-start gap-2 overflow-y-auto p-3" data-testid="media-grid">
        {tab === "sticker" && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(event) => {
                void createSticker(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-lc-border bg-lc-dark text-lc-muted hover:border-lc-green/50 hover:text-lc-white disabled:opacity-50"
              aria-label="Create sticker"
            >
              <span className="text-3xl font-light leading-none" aria-hidden="true">+</span>
              <span className="text-xs">{uploading ? "Creating…" : "Create"}</span>
            </button>
          </>
        )}
        {visible.map((entry) => (
          <button
            type="button"
            key={entry.name}
            onClick={() => onPick(`:${entry.name}:`, entry, tab)}
            title={`:${entry.name}:`}
            className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border border-lc-border/60 bg-lc-dark p-2 hover:border-lc-green/50 hover:bg-lc-card"
          >
            <img src={entry.url} alt={`:${entry.name}:`} className="block max-h-full max-w-full object-contain" />
          </button>
        ))}
        {visible.length === 0 && (
          <div className="col-span-full py-12 text-center text-sm text-lc-muted">
            {tab === 'gif' ? 'No GIFs available' : 'No stickers yet'}
          </div>
        )}
      </div>
    </div>
  );
}

function PickerTabs({
  tab,
  onTab,
  onClose,
}: {
  tab: MediaPickerTab;
  onTab: (tab: MediaPickerTab) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b border-white/10 px-2">
      {(['emoji', 'gif', 'sticker'] as const).map((value) => (
        <button
          type="button"
          key={value}
          onClick={() => onTab(value)}
          aria-pressed={tab === value}
          className={`h-full flex-1 border-b-2 text-xs font-semibold uppercase tracking-wide ${tab === value ? 'border-lc-green text-lc-green' : 'border-transparent text-lc-muted'}`}
        >
          {value === 'sticker' ? 'Stickers' : value}
        </button>
      ))}
      <button type="button" onClick={onClose} className="h-9 w-9 text-lc-muted hover:text-lc-white" aria-label="Close media picker">×</button>
    </div>
  );
}
