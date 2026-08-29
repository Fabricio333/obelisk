'use client';

import { useEffect, useRef } from 'react';
import { gameCatalog } from '@/lib/games/catalog';

export interface SlashCommandParam {
  name: string;
  description: string;
  kind: 'mention' | 'number' | 'string';
  optional?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  params?: SlashCommandParam[];
}

interface Props {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onClose: () => void;
}

export default function SlashCommandAutocomplete({ commands, selectedIndex, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 overflow-y-auto rounded-xl border border-lc-border bg-lc-dark shadow-lg"
      data-testid="slash-autocomplete"
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-lc-muted border-b border-lc-border">
        Commands matching /{commands[0]?.name.slice(0, 0)}
      </div>
      {commands.map((cmd, i) => {
        const required = (cmd.params ?? []).filter((p) => !p.optional);
        const optional = (cmd.params ?? []).filter((p) => p.optional);
        return (
          <button
            key={cmd.name}
            ref={(el) => { itemRefs.current[i] = el; }}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
              i === selectedIndex ? 'bg-lc-border/60' : 'hover:bg-lc-border/40'
            }`}
            data-testid="slash-option"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-lc-green/20 text-lc-green">
              ⚡
            </span>
            <span className="font-mono text-sm text-lc-white">/{cmd.name}</span>
            {required.map((p) => (
              <span key={p.name} className="rounded bg-lc-border/70 px-1.5 py-0.5 text-[10px] font-mono text-lc-muted">
                {p.name}
              </span>
            ))}
            {optional.length > 0 && (
              <span className="text-[10px] text-lc-muted">+{optional.length} optional</span>
            )}
            <span className="ml-2 truncate text-xs text-lc-muted">{cmd.description}</span>
          </button>
        );
      })}
    </div>
  );
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'zap',
    description: 'Send sats to a user in this channel',
    params: [
      { name: 'user', description: 'User to zap (mention, npub, or display name)', kind: 'mention', optional: true },
      { name: 'amount', description: 'Amount in sats', kind: 'number', optional: true },
    ],
  },
  {
    name: 'play',
    // Built from the catalog rather than written out, so adding a game to the
    // registry updates the command instead of leaving this line stale — which
    // is exactly what happened when Vesta arrived and this still said
    // "Chain Reaction".
    description: `Play a game in this channel — ${playableGameNames()}`,
  },
];

function playableGameNames(): string {
  const names = gameCatalog().map((g) => `${g.icon} ${g.displayName}`);
  if (names.length <= 1) return names[0] ?? 'no games available';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
