'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkSpoiler from '@/lib/remark-spoiler';
import { preprocessForMarkdown, MENTION_PLACEHOLDER_REGEX, EVERYONE_PLACEHOLDER, isImageUrl, extractYouTubeId, extractUrls } from '@/lib/markdown';
import { isUploadUrl, filenameFromUrl, isVideoUrl, isAudioUrl } from '@/lib/attachments';
import { useChatStore } from '@/store/chat';
import { useGroupMemberInfo } from '@/lib/nostr-bridge';
import {
  replaceShortcodes,
  CUSTOM_EMOJI_PLACEHOLDER_REGEX,
} from '@/lib/emoji-shortcodes';
import { mergeCustomEmojiMaps, type CustomEmojiMap } from '@/lib/custom-emoji-tags';
import type { MemberInfo } from '@/lib/mentions';
import SpoilerText from './SpoilerText';
import CodeBlock from './CodeBlock';
import ChannelLinkPill from './ChannelLinkPill';
import YouTubeEmbed from './YouTubeEmbed';
import LinkPreview from './LinkPreview';
import AttachmentCard from './AttachmentCard';
import ImageGallery from './ImageGallery';
import InvoiceCard from './InvoiceCard';
import { INVOICE_REGEX } from '@/lib/bolt11';
import ShootingStars from '../ShootingStars';
import type { Components } from 'react-markdown';
import type { MessageSticker } from '@/lib/sticker-tags';
import type { MessageVoiceNote } from '@/lib/voice-note-tags';

function MentionChip({ pubkey, displayName }: { pubkey: string; displayName: string }) {
  const openProfilePopup = useChatStore((s) => s.openProfilePopup);
  return (
    <button
      type="button"
      onClick={() => openProfilePopup(pubkey)}
      className="bg-lc-green/20 text-lc-green rounded px-1 py-0.5 text-sm font-medium hover:bg-lc-green/30 transition-colors cursor-pointer"
      title={pubkey}
      data-testid="mention-highlight"
    >
      @{displayName}
    </button>
  );
}

function EveryoneChip() {
  return (
    <span
      className="bg-lc-green/20 text-lc-green rounded px-1 py-0.5 text-sm font-semibold"
      data-testid="everyone-mention"
    >
      @everyone
    </span>
  );
}

function CustomEmojiImg({ name, url }: { name: string; url: string }) {
  return (
    <img
      src={url}
      alt={`:${name}:`}
      title={`:${name}:`}
      className="inline-block w-5 h-5 align-text-bottom object-contain"
      data-testid="custom-emoji"
    />
  );
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}

function VoiceMessage({ note }: { note: MessageVoiceNote }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(note.durationSeconds);
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  return (
    <span className="mt-1 flex w-[min(19rem,78vw)] items-center gap-3 rounded-2xl border border-lc-border bg-lc-card px-3 py-2.5 shadow-sm" data-testid="voice-message">
      <audio
        ref={audioRef}
        src={note.url}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
      />
      <button type="button" onClick={toggle} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lc-green text-lc-black" aria-label={playing ? "Pause voice message" : "Play voice message"}>
        {playing ? (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
        ) : (
          <svg className="ml-0.5 h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7z" /></svg>
        )}
      </button>
      <span className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={0.1}
          value={Math.min(current, Math.max(duration, 1))}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = next;
            setCurrent(next);
          }}
          className="h-1.5 w-full cursor-pointer accent-lc-green"
          aria-label="Voice message progress"
        />
        <span className="mt-1 flex justify-between font-mono text-[11px] text-lc-muted">
          <span>{formatAudioTime(current)}</span>
          <span>{formatAudioTime(duration)}</span>
        </span>
      </span>
      <svg className="h-5 w-5 shrink-0 text-lc-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M11 5 6 9H3v6h3l5 4zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" />
      </svg>
    </span>
  );
}

function StickerImg({ sticker }: { sticker: MessageSticker }) {
  return (
    <a
      href={sticker.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 block h-44 w-44 max-w-full overflow-hidden rounded-2xl bg-transparent p-1"
      data-testid="message-sticker"
    >
      <img
        src={sticker.url}
        alt={`Sticker :${sticker.name}:`}
        loading="lazy"
        className="block h-full w-full object-contain"
      />
    </a>
  );
}

/**
 * Welcome banner wrapper — the welcome bot posts a markdown image pointing
 * at /api/welcome-banner. We detect that URL and render the image inside a
 * container with the same canvas-based shooting-stars effect the landing
 * page uses. The canvas sits BEHIND the <img> so the streaks only show
 * through the banner's transparent background — they never overlap the
 * avatar, text, or glow, which are baked into the PNG.
 */
function WelcomeBanner({ src, alt }: { src: string; alt: string }) {
  return (
    <span
      className="relative block mt-1 max-w-sm rounded-2xl overflow-hidden bg-lc-dark"
      data-testid="welcome-banner"
    >
      {/* Canvas shooting stars sit at the bottom of the stacking order —
          behind the <img>. The banner PNG has a transparent background, so
          stars show through empty areas but are hidden behind any baked-in
          pixel (avatar, text, glow). */}
      <ShootingStars contained count={4} />
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="relative z-[1] block w-full"
        data-testid="welcome-banner-img"
      />
    </span>
  );
}


/**
 * Swap mention + custom-emoji placeholders in a text string with their
 * respective components. Both placeholder kinds coexist in the same string
 * so we need a single scanning pass that picks whichever token appears next
 * at each step.
 */
function renderWithMentions(
  text: string,
  mentions: Map<string, { pubkey: string; displayName: string }>,
  serverEmojis: Record<string, string>,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let idx = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    // Scan for the next `\u3008` which is our shared placeholder prefix marker.
    const start = text.indexOf('\u3008', i);
    if (start === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (start > i) parts.push(text.slice(i, start));

    // @everyone broadcast: \u3008EVERYONE\u3009
    if (text.startsWith(EVERYONE_PLACEHOLDER, start)) {
      parts.push(<EveryoneChip key={`ev-${idx++}-${start}`} />);
      i = start + EVERYONE_PLACEHOLDER.length;
      continue;
    }

    // Mention: \u3008MENTION:<key>\u3009
    MENTION_PLACEHOLDER_REGEX.lastIndex = start;
    const mm = MENTION_PLACEHOLDER_REGEX.exec(text);
    if (mm && mm.index === start) {
      const mentionData = mentions.get(mm[1]);
      if (mentionData) {
        parts.push(
          <MentionChip
            key={`m-${idx++}-${mm[1]}`}
            pubkey={mentionData.pubkey}
            displayName={mentionData.displayName}
          />,
        );
      }
      i = start + mm[0].length;
      continue;
    }

    // Custom emoji: \u3008EMOJI:<name>\u3009
    CUSTOM_EMOJI_PLACEHOLDER_REGEX.lastIndex = start;
    const em = CUSTOM_EMOJI_PLACEHOLDER_REGEX.exec(text);
    if (em && em.index === start) {
      const name = em[1];
      const url = serverEmojis[name];
      if (url) {
        parts.push(<CustomEmojiImg key={`e-${idx++}-${name}`} name={name} url={url} />);
      } else {
        // Emoji no longer exists on this server — fall back to the raw `:name:`
        parts.push(`:${name}:`);
      }
      i = start + em[0].length;
      continue;
    }

    // Lone `\u3008` that doesn't match either placeholder — emit verbatim and
    // advance by one to avoid an infinite loop.
    parts.push('\u3008');
    i = start + 1;
  }

  return parts.length > 0 ? parts : [text];
}

// Matches `![alt](url)` when the url points at /api/welcome-banner. We detect
// this before markdown parsing so the banner can be hoisted out and rendered
// by <WelcomeBanner> (with animated stars) instead of a generic <img>.
const WELCOME_BANNER_MD_REGEX = /!\[([^\]]*)\]\(([^)\s]*\/api\/welcome-banner[^)\s]*)\)/;

export default function MessageContent({
  content,
  messageId,
  channelId,
  customEmojis,
  sticker,
  voiceNote,
}: {
  content: string;
  messageId?: string;
  channelId?: string;
  customEmojis?: CustomEmojiMap;
  sticker?: MessageSticker;
  voiceNote?: MessageVoiceNote;
}) {
  const serverEmojis = useChatStore((s) => s.serverEmojis);
  const memberList = useGroupMemberInfo(channelId ?? null);
  const mergedEmojis = useMemo(
    () => mergeCustomEmojiMaps(serverEmojis, customEmojis),
    [serverEmojis, customEmojis],
  );

  // Hoist image + video + audio URLs out of the message body so we can
  // render them as a gallery / inline player below the text. Without this,
  // each URL would render inline wherever it appears in the markdown.
  const { imageUrls, videoUrls, audioUrls, youtubeUrls } = useMemo(() => {
    const urls = voiceNote ? [] : extractUrls(content);
    return {
      imageUrls: urls.filter(isImageUrl),
      videoUrls: urls.filter(isVideoUrl),
      audioUrls: urls.filter(isAudioUrl),
      youtubeUrls: urls.filter((u) => !!extractYouTubeId(u)),
    };
  }, [content, voiceNote]);

  // Detect and hoist the welcome banner markdown image. Relative URLs don't
  // match `extractUrls` (which requires http(s)://), so the generic strip
  // pipeline above misses it. We parse it out ourselves.
  const welcomeBanner = useMemo(() => {
    const m = content.match(WELCOME_BANNER_MD_REGEX);
    if (!m) return null;
    return { alt: m[1], src: m[2], raw: m[0] };
  }, [content]);

  // Hoist BOLT11 invoices out of the body so each renders as an InvoiceCard
  // below the text instead of a raw lnbc… blob inline.
  const invoices = useMemo(() => {
    const matches = content.match(INVOICE_REGEX) || [];
    const seen = new Set<string>();
    return matches.filter((m) => { const k = m.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [content]);

  const bodyContent = useMemo(() => {
    if (sticker || voiceNote) return '';
    const toStrip = [...imageUrls, ...videoUrls, ...audioUrls, ...youtubeUrls];
    let stripped = content;
    if (welcomeBanner) stripped = stripped.split(welcomeBanner.raw).join('');
    for (const url of toStrip) {
      stripped = stripped.split(url).join('');
    }
    for (const inv of invoices) {
      stripped = stripped.split(inv).join('');
    }
    // collapse stray whitespace/newlines left behind
    return stripped.replace(/\n{3,}/g, '\n\n').trim();
  }, [content, imageUrls, videoUrls, audioUrls, youtubeUrls, welcomeBanner, invoices, sticker, voiceNote]);

  // Resolve `:name:` shortcodes before markdown parsing. Unicode shortcodes
  // are replaced inline (no placeholder — the char is just a char), while
  // custom server emojis are replaced with placeholder tokens that
  // `processChildren` below swaps for <img> elements, mirroring mentions.
  const shortcodeResolved = useMemo(
    () => replaceShortcodes(bodyContent, mergedEmojis),
    [bodyContent, mergedEmojis],
  );

  const { text, mentions } = useMemo(
    () => preprocessForMarkdown(shortcodeResolved, memberList as MemberInfo[]),
    [shortcodeResolved, memberList]
  );

  // Collect non-image, non-video, non-youtube, non-upload URLs for link previews.
  // Same-origin /chat links (channel/message/post deep-links) are rendered as
  // ChannelLinkPill inline and must NOT also get a preview card.
  const previewUrls = useMemo(() => {
    const urls = extractUrls(bodyContent);
    return urls.filter((u) => {
      if (isImageUrl(u) || isVideoUrl(u) || extractYouTubeId(u) || isUploadUrl(u)) return false;
      if (typeof window !== 'undefined') {
        try {
          const parsed = new URL(u, window.location.href);
          if (parsed.origin === window.location.origin && parsed.pathname === '/chat') {
            return false;
          }
        } catch {
          /* fall through */
        }
      }
      return true;
    });
  }, [bodyContent]);

  const components: Components = useMemo(() => ({
    // Code blocks and inline code
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      const codeStr = String(children).replace(/\n$/, '');
      // Fenced code block (has language class or is inside pre)
      if (match || (props.node?.position && codeStr.includes('\n'))) {
        return <CodeBlock code={codeStr} language={match?.[1]} />;
      }
      // Inline code
      return (
        <code className="bg-lc-dark text-lc-green px-1.5 py-0.5 rounded text-[0.85em] font-mono" {...props}>
          {children}
        </code>
      );
    },
    // Pre — just pass through, CodeBlock handles styling
    pre({ children }) {
      return <>{children}</>;
    },
    // Links — handle images, YouTube, regular links
    a({ href, children }) {
      if (!href) return <>{children}</>;

      // Image URL — render only the image, suppress raw URL text
      if (isImageUrl(href)) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={href}
              alt=""
              loading="lazy"
              className="mt-1 max-w-sm max-h-80 rounded-lg object-contain bg-lc-black/50"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </a>
        );
      }

      // Uploaded attachment (non-image): render as download card only
      if (isUploadUrl(href)) {
        return <AttachmentCard url={href} name={filenameFromUrl(href)} />;
      }

      // YouTube URL — raw pastes are hoisted out of the body and rendered
      // as a real embed. Explicit `[label](yt-url)` markdown links fall
      // through to a plain link so we never put a <div> inside <p>.

      // Same-origin /chat?c=<slug>[&m=|&p=] links render as a Discord-style
      // pill (#slug, with ↩ prefix for deep-links to specific messages or
      // posts) and navigate smoothly via pushState + popstate — no full
      // reload.
      try {
        const url = new URL(href, typeof window !== 'undefined' ? window.location.href : 'http://x');
        if (
          typeof window !== 'undefined' &&
          url.origin === window.location.origin &&
          url.pathname === '/chat'
        ) {
          const sp = url.searchParams;
          const slug = sp.get('c');
          const messageId = sp.get('m') || undefined;
          const postId = sp.get('p') || undefined;
          const onClick = (e: React.MouseEvent) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            window.history.pushState(null, '', url.pathname + url.search);
            window.dispatchEvent(new PopStateEvent('popstate'));
          };
          if (slug) {
            return (
              <ChannelLinkPill
                href={href}
                slug={slug}
                messageId={messageId}
                postId={postId}
              />
            );
          }
          // Fallback: other /chat URLs without a slug (e.g. profile deep-links)
          return (
            <a
              href={href}
              className="text-lc-green/80 hover:underline break-all"
              onClick={onClick}
            >
              {children}
            </a>
          );
        }
      } catch {
        // fall through to external-link rendering
      }

      // Regular link
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-lc-green/80 hover:underline break-all">
          {children}
        </a>
      );
    },
    // Blockquote
    blockquote({ children }) {
      return (
        <blockquote className="border-l-2 border-lc-green/40 pl-3 my-1 text-lc-muted italic">
          {children}
        </blockquote>
      );
    },
    // Headings (limited like Discord)
    h1({ children }) { return <p className="text-lg font-bold text-lc-white">{processChildren(children, mentions, mergedEmojis)}</p>; },
    h2({ children }) { return <p className="text-base font-bold text-lc-white">{processChildren(children, mentions, mergedEmojis)}</p>; },
    h3({ children }) { return <p className="text-sm font-bold text-lc-white">{processChildren(children, mentions, mergedEmojis)}</p>; },
    // Text formatting
    strong({ children }) { return <strong className="font-bold text-lc-white">{processChildren(children, mentions, mergedEmojis)}</strong>; },
    em({ children }) { return <em className="italic text-lc-white/80">{processChildren(children, mentions, mergedEmojis)}</em>; },
    del({ children }) { return <del className="line-through text-lc-muted">{processChildren(children, mentions, mergedEmojis)}</del>; },
    // Lists
    ul({ children }) { return <ul className="list-disc list-inside my-1 text-lc-white/90">{children}</ul>; },
    ol({ children }) { return <ol className="list-decimal list-inside my-1 text-lc-white/90">{children}</ol>; },
    li({ children }) { return <li className="text-sm">{processChildren(children, mentions, mergedEmojis)}</li>; },
    // Paragraph — swap mention placeholders
    p({ children }) {
      return <p className="my-0">{processChildren(children, mentions, mergedEmojis)}</p>;
    },
    // Spoiler nodes (from our remark plugin)
    spoiler({ children }: { children?: ReactNode }) {
      return <SpoilerText>{children}</SpoilerText>;
    },
  }), [mentions, mergedEmojis]);

  return (
    <span data-testid="message-content">
      {sticker && <StickerImg sticker={sticker} />}
      {voiceNote && <VoiceMessage note={voiceNote} />}
      {text && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkSpoiler]}
          components={components}
          // Allow our custom spoiler element
          allowedElements={undefined}
        >
          {text}
        </ReactMarkdown>
      )}
      {/* Welcome bot banner — hoisted so it renders with animated stars
          instead of as a generic markdown <img>. */}
      {welcomeBanner && (
        <WelcomeBanner src={welcomeBanner.src} alt={welcomeBanner.alt} />
      )}
      {/* Image matrix hoisted out of the body text */}
      {imageUrls.length > 0 && <ImageGallery urls={imageUrls} />}
      {/* YouTube embeds hoisted so they render outside the markdown <p>
          (the player swaps in a <div> on click, which is invalid inside <p>) */}
      {youtubeUrls.map((url) => {
        const id = extractYouTubeId(url);
        return id ? <YouTubeEmbed key={url} videoId={id} /> : null;
      })}
      {/* Videos: inline native player, one per video */}
      {videoUrls.map((url) => (
        <video
          key={url}
          src={url}
          controls
          preload="metadata"
          className="mt-1 max-w-sm max-h-80 rounded-lg bg-lc-black/50"
          data-testid="video-player"
        />
      ))}
      {/* Audio: native <audio controls>, one per file. Matches the video
          hoisting pattern so an `.mp3` upload renders as an inline player. */}
      {audioUrls.map((url) => (
        <audio
          key={url}
          src={url}
          controls
          preload="metadata"
          className="mt-1 max-w-sm block"
          data-testid="audio-player"
        />
      ))}
      {/* Invoice cards hoisted out of the body text */}
      {invoices.map((inv) => (
        <InvoiceCard key={inv} invoice={inv} messageId={messageId} channelId={channelId} />
      ))}
      {/* Link previews for non-image, non-youtube URLs */}
      {previewUrls.map((url) => (
        <LinkPreview key={url} url={url} />
      ))}
    </span>
  );
}

/**
 * Process React children, replacing string nodes that contain mention or
 * custom-emoji placeholders with their corresponding components.
 */
function processChildren(
  children: ReactNode,
  mentions: Map<string, { pubkey: string; displayName: string }>,
  serverEmojis: Record<string, string>,
): ReactNode {
  const hasPlaceholder = (s: string) =>
    s.includes('\u3008MENTION:') || s.includes('\u3008EMOJI:') || s.includes(EVERYONE_PLACEHOLDER);

  if (typeof children === 'string') {
    if (hasPlaceholder(children)) {
      return renderWithMentions(children, mentions, serverEmojis);
    }
    return children;
  }

  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string' && hasPlaceholder(child)) {
        return <span key={i}>{renderWithMentions(child, mentions, serverEmojis)}</span>;
      }
      return child;
    });
  }

  return children;
}
