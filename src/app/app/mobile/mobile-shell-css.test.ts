import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, 'mobile-shell.css'), 'utf8');

const ruleBody = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
};

describe('mobile shell CSS', () => {
  it('rounds the mobile server channel pane top-left corner like desktop', () => {
    const pane = ruleBody('.obelisk-mobile .server-channel-pane');
    expect(pane).toContain('border-top-left-radius: 0.75rem');
    expect(pane).toContain('border-left: 1px solid var(--app-line-soft)');
    expect(pane).toContain('border-top: 1px solid var(--app-line-soft)');
    expect(pane).toContain('overflow: hidden');
  });

  it('uses compositor-only page transitions with containment and no laggy CSS animations', () => {
    const anim = ruleBody('.obelisk-mobile .screen-anim');
    expect(anim).toContain('will-change: transform, opacity');
    expect(anim).toContain('contain: layout paint style');
    expect(anim).toContain('backface-visibility: hidden');
    expect(anim).toContain('transform: translate3d(0, 0, 0)');

    expect(ruleBody('.obelisk-mobile .screen-anim.slide-forward')).not.toContain('animation:');
    expect(ruleBody('.obelisk-mobile .screen-anim.slide-back')).not.toContain('animation:');
    expect(css).not.toContain('@keyframes obelisk-slide-from-right');
    expect(css).not.toContain('@keyframes obelisk-slide-from-left');
  });

  it('locks the mobile PWA shell to native-feeling touch and viewport behavior', () => {
    const root = ruleBody('.obelisk-mobile');
    expect(root).toContain('height: calc(100dvh - var(--kb-inset, 0px))');
    expect(root).toContain('overscroll-behavior: none');
    expect(root).toContain('touch-action: manipulation');
    expect(root).toContain('-webkit-tap-highlight-color: transparent');
    expect(root).toContain('-webkit-touch-callout: none');
    expect(root).toContain('user-select: none');

    const host = ruleBody('.obelisk-mobile .screens-host');
    expect(host).toContain('min-width: 0');
    expect(host).toContain('min-height: 0');
    expect(host).toContain('overflow: hidden');
  });

  it('keeps scroll surfaces momentum-friendly without blocking vertical pans in horizontal lists', () => {
    const nativeY = ruleBody('.obelisk-mobile :where(.native-scroll-y)');
    expect(nativeY).toContain('-webkit-overflow-scrolling: touch');
    expect(nativeY).toContain('overscroll-behavior-y: contain');
    expect(nativeY).toContain('scroll-behavior: smooth');

    const nativeX = ruleBody('.obelisk-mobile :where(.native-scroll-x)');
    expect(nativeX).toContain('-webkit-overflow-scrolling: touch');
    expect(nativeX).toContain('touch-action: pan-x pan-y');
    expect(nativeX).toContain('overscroll-behavior-x: contain');
    expect(nativeX).toContain('overscroll-behavior-y: auto');
    expect(css).not.toContain('touch-action: pan-x;');
  });

  it('restores selection only where mobile users need text entry or message copy', () => {
    const selectable = ruleBody(`.obelisk-mobile input,
.obelisk-mobile textarea,
.obelisk-mobile [contenteditable='true'],
.obelisk-mobile [data-testid="message-content"]`);
    expect(selectable).toContain('user-select: text');
    expect(selectable).toContain('-webkit-user-select: text');
  });

  it('keeps reply previews and message headers from expanding mobile rows', () => {
    const reply = ruleBody('.obelisk-mobile .msg-reply-row');
    expect(reply).toContain('display: grid');
    expect(reply).toContain('grid-template-columns: auto minmax(0, min(36%, 11rem)) minmax(0, 1fr)');
    expect(reply).toContain('min-width: 0');
    expect(reply).toContain('min-height: 0');
    expect(reply).toContain('white-space: nowrap');

    const replyName = ruleBody('.obelisk-mobile .msg-reply-row .msg-reply-name');
    expect(replyName).toContain('min-width: 0');
    expect(replyName).toContain('overflow: hidden');
    expect(replyName).toContain('text-overflow: ellipsis');

    const head = ruleBody('.obelisk-mobile .msg-head');
    expect(head).toContain('flex-wrap: nowrap');
    expect(head).toContain('min-width: 0');

    const name = ruleBody('.obelisk-mobile .msg-name');
    expect(name).toContain('display: block');
    expect(name).toContain('flex: 1 1 auto');
    expect(name).toContain('min-width: 0');
    expect(name).toContain('min-height: 0');
    expect(name).toContain('text-overflow: ellipsis');
    expect(name).toContain('max-width: none');

    const avatar = ruleBody('.obelisk-mobile .msg > .msg-ava');
    expect(avatar).toContain('min-width: 36px');
    expect(avatar).toContain('min-height: 36px');

    const more = ruleBody('.obelisk-mobile .msg-more');
    expect(more).toContain('min-width: 28px');
    expect(more).toContain('min-height: 28px');
  });

  it('constrains composer reply author previews on narrow screens', () => {
    const reply = ruleBody('.obelisk-mobile .composer-reply');
    expect(reply).toContain('min-width: 0');

    const label = ruleBody('.obelisk-mobile .composer-reply-label');
    expect(label).toContain('display: block');
    expect(label).toContain('text-overflow: ellipsis');

    const author = ruleBody('.obelisk-mobile .composer-reply-author');
    expect(author).toContain('max-width: min(44vw, 12rem)');
    expect(author).toContain('overflow: hidden');
    expect(author).toContain('text-overflow: ellipsis');

    const close = ruleBody('.obelisk-mobile .composer-reply-close');
    expect(close).toContain('min-width: 28px');
    expect(close).toContain('min-height: 28px');
  });

  it('gives chat operations consistent lightweight tap feedback', () => {
    expect(css).toContain('.obelisk-mobile .ma-action,');
    expect(css).toContain('.obelisk-mobile .composer-send,');
    expect(css).toContain('.obelisk-mobile .reaction,');
    expect(css).toContain('.obelisk-mobile .btn-primary,');
    expect(css).toContain('transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(css).toContain('.obelisk-mobile .ma-action:active,');
    expect(css).toContain('.obelisk-mobile .composer-send:active,');
    expect(css).toContain('.obelisk-mobile .reaction:active,');
  });

  it('keeps mobile action glyphs white over their colored squares', () => {
    for (const action of ['search', 'create', 'menu']) {
      expect(ruleBody(`.obelisk-mobile .icon-btn.action-${action}`))
        .toContain('color: var(--app-text)');
    }
  });

  it("renders every mobile back button as a colored circle", () => {
    const back = ruleBody(".obelisk-mobile .back-btn");
    expect(back).toContain("border-radius: 999px");
    expect(back).toContain("background: rgba(96, 165, 250, 0.18)");
    expect(back).toContain("color: var(--app-text)");
    expect(ruleBody(".obelisk-mobile .voice-room-topbar .back-btn"))
      .toContain("background: rgba(96, 165, 250, 0.18)");
    expect(ruleBody(`.obelisk-mobile .profile-view-topbar .icon-btn,
.obelisk-mobile .profile-view-topbar .back-btn`))
      .toContain("background: rgba(96, 165, 250, 0.18)");
  });

});
