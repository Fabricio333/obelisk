/**
 * Shared avatar primitive — picture-with-initial-fallback circle.
 *
 * Three places used to hand-roll the same picture/initials pair:
 * `DMList`'s `Avatar`, `UserPanel`'s settings header + profile-card variant,
 * and `NostrProfile`'s banner-overlapping avatar. They all share the
 * "render `picture` if present, otherwise a circle with the first character
 * of name (or pubkey)" pattern.
 *
 * `size` is a Tailwind scale (e.g. `8` → 32px, `20` → 80px); the component
 * maps it to inline width/height so callers can pass any value without
 * needing a Tailwind class for it.
 */
import type { CSSProperties } from 'react';

export interface UserAvatarProps {
  /** Hex pubkey — only used to derive a fallback initial when `name` is empty. */
  pubkey: string;
  /** Profile picture URL. `null` / `undefined` → initial circle. */
  picture: string | null | undefined;
  /** Tailwind size scale: `8` ⇒ 32px, `20` ⇒ 80px. */
  size: number;
  /**
   * Display name used to derive the initial. Falls back to the first hex
   * character of `pubkey` when empty — matches the legacy DMList behavior.
   */
  name?: string;
  /** Extra classes (e.g. ring color, border). Merged onto the root element. */
  className?: string;
  /** Optional alt text on the `<img>` variant. */
  alt?: string;
  /** Optional Tailwind text-size override for the initial fallback. */
  initialClassName?: string;
}

export default function UserAvatar({
  pubkey,
  picture,
  size,
  name,
  className = '',
  alt = '',
  initialClassName = 'text-xs',
}: UserAvatarProps) {
  const px = `${size * 4}px`;
  const style: CSSProperties = { width: px, height: px };
  if (picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={picture}
        alt={alt}
        style={style}
        className={`shrink-0 rounded-full bg-lc-olive object-cover ${className}`}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  const initial = (name?.trim()?.[0] ?? pubkey.slice(0, 1)).toUpperCase();
  return (
    <div
      style={style}
      className={`flex shrink-0 items-center justify-center rounded-full bg-lc-olive font-semibold text-lc-green ${initialClassName} ${className}`}
    >
      {initial}
    </div>
  );
}
