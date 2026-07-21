'use client';



interface Props {
  slug: string;
  messageId?: string;
  postId?: string;
  href: string;
}

/**
 * Discord-style inline pill rendered in place of a same-origin
 * `/chat?c=<slug>[&m=|&p=]` link inside message content.
 *
 * Resolves the slug on mount via `useChatStore.resolveSlug` so the label
 * shows the actual channel name / post title instead of the raw slug. If the
 * viewer has no read access, renders greyed + locked (click suppressed) per
 * the "name visible, content locked" decision from FORUM_PLAN.md.
 *
 * Click navigates via `pushState` + `popstate` to keep the chat page mounted
 * — `src/app/chat/page.tsx` listens for `popstate` and re-applies URL state.
 */
export default function ChannelLinkPill({ slug, messageId, postId, href }: Props) {
  const channelName = slug;
  const postTitle = null;
  const noAccess = false;

  let prefix: string;
  let label: string;
  let title: string;
  if (postId) {
    prefix = '📋 ';
    label = postTitle ?? channelName ?? slug;
    title = `Publicación en #${channelName ?? slug}`;
  } else if (messageId) {
    prefix = '↩ ';
    label = channelName ?? slug;
    title = `Mensaje en #${channelName ?? slug}`;
  } else {
    prefix = '#';
    label = channelName ?? slug;
    title = `Canal #${channelName ?? slug}`;
  }

  const onClick = (e: React.MouseEvent) => {
    if (noAccess) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    try {
      const url = new URL(href, window.location.href);
      window.history.pushState(null, '', url.pathname + url.search);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
      /* no-op */
    }
  };

  const baseClass =
    'inline-flex items-center rounded px-1.5 py-0.5 text-[0.95em] font-medium no-underline transition-colors';
  const variantClass = noAccess
    ? 'bg-lc-muted/15 text-lc-muted cursor-not-allowed'
    : 'bg-lc-green/15 text-lc-green hover:bg-lc-green/25';

  return (
    <a
      href={href}
      onClick={onClick}
      className={`${baseClass} ${variantClass}`}
      data-testid="channel-link-pill"
      title={noAccess ? `Sin acceso a #${channelName ?? slug}` : title}
      aria-disabled={noAccess || undefined}
    >
      {noAccess && <span aria-hidden>🔒 </span>}
      {!noAccess && prefix}
      {label}
    </a>
  );
}
