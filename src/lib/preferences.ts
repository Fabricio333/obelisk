'use client';

import { useSyncExternalStore } from 'react';
import { createLocalStore } from './local-store';
import { DEFAULT_PROFILE_FEED_RELAYS, normalizeProfileFeedRelays } from './profile-feed';

export type BubbleAnimationStyle = 'float' | 'drift' | 'orbit' | 'still';

export interface Preferences {
  showActivityIndicator: boolean;
  developerRelayDebug: boolean;
  directMessagesEnabled: boolean;
  postQuantumEnabled: boolean;
  profileFeedRelays: string[];
  accentColor: string;
  backgroundColor: string;
  buttonColor: string;
  bubbleColor: string;
  bubbleAnimation: BubbleAnimationStyle;
}

const DEFAULTS: Preferences = {
  showActivityIndicator: true,
  developerRelayDebug: false,
  directMessagesEnabled: false,
  postQuantumEnabled: true,
  profileFeedRelays: [...DEFAULT_PROFILE_FEED_RELAYS],
  accentColor: '#b4f953',
  backgroundColor: '#0a0a0a',
  buttonColor: '#b4f953',
  bubbleColor: '#b4f953',
  bubbleAnimation: 'float',
};

export const APPEARANCE_DEFAULTS = {
  accentColor: DEFAULTS.accentColor,
  backgroundColor: DEFAULTS.backgroundColor,
  buttonColor: DEFAULTS.buttonColor,
  bubbleColor: DEFAULTS.bubbleColor,
  bubbleAnimation: DEFAULTS.bubbleAnimation,
} as const;

const COLOR_KEYS = new Set<keyof Preferences>(['accentColor', 'backgroundColor', 'buttonColor', 'bubbleColor']);
const BUBBLE_ANIMATION_VALUES = new Set<BubbleAnimationStyle>(['float', 'drift', 'orbit', 'still']);
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const store = createLocalStore<Partial<Preferences>>('obelisk:preferences', {});
let current: Preferences = normalizePreferences(store.load());
const listeners = new Set<() => void>();

export function getPreferences(): Preferences {
  return current;
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  const normalized = normalizePreferenceValue(key, value);
  if (current[key] === normalized) return;
  current = { ...current, [key]: normalized };
  store.save(current);
  listeners.forEach((l) => l());
}

export function resetAppearancePreferences(): void {
  current = {
    ...current,
    accentColor: APPEARANCE_DEFAULTS.accentColor,
    backgroundColor: APPEARANCE_DEFAULTS.backgroundColor,
    buttonColor: APPEARANCE_DEFAULTS.buttonColor,
    bubbleColor: APPEARANCE_DEFAULTS.bubbleColor,
    bubbleAnimation: APPEARANCE_DEFAULTS.bubbleAnimation,
  };
  store.save(current);
  listeners.forEach((l) => l());
}

export function getAppearanceCssVariables(prefs: Pick<Preferences, 'accentColor' | 'backgroundColor' | 'buttonColor' | 'bubbleColor'>): Record<string, string> {
  const accent = sanitizeHexColor(prefs.accentColor, APPEARANCE_DEFAULTS.accentColor);
  const background = sanitizeHexColor(prefs.backgroundColor, APPEARANCE_DEFAULTS.backgroundColor);
  const button = sanitizeHexColor(prefs.buttonColor, APPEARANCE_DEFAULTS.buttonColor);
  const bubble = sanitizeHexColor(prefs.bubbleColor, APPEARANCE_DEFAULTS.bubbleColor);

  return {
    '--obelisk-app-bg': background,
    '--obelisk-app-bg-soft': mixHex(background, '#ffffff', 0.035),
    '--obelisk-app-bg-panel': mixHex(background, '#ffffff', 0.065),
    '--obelisk-accent': accent,
    '--obelisk-accent-deep': mixHex(accent, '#000000', 0.22),
    '--obelisk-accent-soft': mixHex(accent, background, 0.18),
    '--obelisk-accent-ink': readableInk(accent),
    '--obelisk-button': button,
    '--obelisk-button-hover': mixHex(button, '#ffffff', 0.14),
    '--obelisk-button-ink': readableInk(button),
    '--obelisk-bubble': bubble,
    '--obelisk-bubble-soft': mixHex(bubble, background, 0.46),
    '--background': background,
    '--color-lc-black': background,
    '--color-lc-dark': mixHex(background, '#ffffff', 0.05),
    '--color-lc-card': mixHex(background, '#ffffff', 0.07),
    '--color-lc-green': accent,
    '--color-lc-green-dark': mixHex(accent, '#000000', 0.22),
    '--color-lc-olive': mixHex(accent, background, 0.22),
    '--color-lc-olive-dark': mixHex(accent, background, 0.14),
  };
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => DEFAULTS,
  );
}

function normalizePreferences(raw: Partial<Preferences>): Preferences {
  return {
    showActivityIndicator: typeof raw.showActivityIndicator === 'boolean'
      ? raw.showActivityIndicator
      : DEFAULTS.showActivityIndicator,
    developerRelayDebug: typeof raw.developerRelayDebug === 'boolean'
      ? raw.developerRelayDebug
      : DEFAULTS.developerRelayDebug,
    directMessagesEnabled: typeof raw.directMessagesEnabled === 'boolean'
      ? raw.directMessagesEnabled
      : DEFAULTS.directMessagesEnabled,
    postQuantumEnabled: typeof raw.postQuantumEnabled === 'boolean'
      ? raw.postQuantumEnabled
      : DEFAULTS.postQuantumEnabled,
    profileFeedRelays: normalizeProfileFeedRelays(raw.profileFeedRelays),
    accentColor: sanitizeHexColor(raw.accentColor, DEFAULTS.accentColor),
    backgroundColor: sanitizeHexColor(raw.backgroundColor, DEFAULTS.backgroundColor),
    buttonColor: sanitizeHexColor(raw.buttonColor, DEFAULTS.buttonColor),
    bubbleColor: sanitizeHexColor(raw.bubbleColor, DEFAULTS.bubbleColor),
    bubbleAnimation: normalizeBubbleAnimation(raw.bubbleAnimation),
  };
}

function normalizePreferenceValue<K extends keyof Preferences>(key: K, value: Preferences[K]): Preferences[K] {
  if (key === 'profileFeedRelays') {
    return normalizeProfileFeedRelays(value) as Preferences[K];
  }
  if (key === 'bubbleAnimation') {
    return normalizeBubbleAnimation(value) as Preferences[K];
  }
  if (!COLOR_KEYS.has(key)) return value;
  const fallback = DEFAULTS[key] as string;
  return sanitizeHexColor(value, fallback) as Preferences[K];
}

function sanitizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function normalizeBubbleAnimation(value: unknown): BubbleAnimationStyle {
  return BUBBLE_ANIMATION_VALUES.has(value as BubbleAnimationStyle)
    ? value as BubbleAnimationStyle
    : DEFAULTS.bubbleAnimation;
}

function parseHex(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHexPart(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
}

function mixHex(base: string, target: string, targetAmount: number): string {
  const [r1, g1, b1] = parseHex(base);
  const [r2, g2, b2] = parseHex(target);
  const baseAmount = 1 - targetAmount;
  return `#${toHexPart(r1 * baseAmount + r2 * targetAmount)}${toHexPart(g1 * baseAmount + g2 * targetAmount)}${toHexPart(b1 * baseAmount + b2 * targetAmount)}`;
}

function readableInk(hex: string): string {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.42 ? '#0a0a0a' : '#fafafa';
}
