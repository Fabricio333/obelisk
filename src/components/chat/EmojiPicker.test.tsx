import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmojiPicker from './EmojiPicker';

describe('EmojiPicker', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders server GIFs separately from static server emojis', () => {
    const onPick = vi.fn();
    const gifUrl = 'https://cdn.example/emojis/party_dance.gif';
    const staticUrl = 'https://cdn.example/emojis/wave.webp';

    render(
      <EmojiPicker
        onPick={onPick}
        onClose={() => {}}
        skipRecent
        customEmojis={{
          party_dance: gifUrl,
          wave: staticUrl,
        }}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toHaveClass('bg-lc-black');
    expect(screen.getByText('Server GIFs')).toBeInTheDocument();
    expect(screen.getByText('Server emojis')).toBeInTheDocument();
    expect(screen.getByAltText(':party_dance:')).toHaveAttribute('src', gifUrl);
    expect(screen.getByAltText(':wave:')).toHaveAttribute('src', staticUrl);

    fireEvent.click(screen.getByTitle(':party_dance:'));

    expect(onPick).toHaveBeenCalledWith(
      ':party_dance:',
      expect.objectContaining({ name: 'party_dance', url: gifUrl }),
    );
  });

  it("honors explicit sticker metadata even when the asset is a GIF", () => {
    render(
      <EmojiPicker
        onPick={() => {}}
        onClose={() => {}}
        customEmojis={{ stamp: "https://cdn.example/stamp.gif", clip: "https://cdn.example/clip.webp" }}
        customMediaKinds={{ stamp: "sticker", clip: "gif" }}
      />,
    );

    expect(screen.getByText("Server stickers")).toBeInTheDocument();
    expect(within(screen.getByText("Server stickers").parentElement!).getByAltText(":stamp:")).toBeInTheDocument();
    expect(within(screen.getByText("Server GIFs").parentElement!).getByAltText(":clip:")).toBeInTheDocument();
  });

  it("jumps directly to classified emoji sections", () => {
    const { container } = render(
      <EmojiPicker onPick={() => {}} onClose={() => {}} skipRecent customEmojis={{}} />,
    );

    expect(screen.getByRole("navigation", { name: "Emoji categories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smileys & people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Animals & nature" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Symbols" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flags" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Emoji categories" }).querySelectorAll('button')).toHaveLength(9);

    const cars = container.querySelector<HTMLElement>('[data-emoji-category="Cars"]')!;
    expect(cars).toHaveTextContent("🚗");
    expect(container.querySelector<HTMLElement>("[data-emoji-category=\"Flags\"]")).toHaveTextContent("🇦🇷");
    const scroller = cars.parentElement!;
    scroller.scrollTo = vi.fn();
    Object.defineProperty(cars, "offsetTop", { configurable: true, value: 320 });
    fireEvent.click(screen.getByRole("button", { name: "Cars & travel" }));

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Cars & travel" })).toHaveAttribute("aria-pressed", "true");
  });

  it('uses a standard history icon and keeps recent emojis available', () => {
    const { container } = render(<EmojiPicker onPick={() => {}} onClose={() => {}} customEmojis={{}} />);
    const recentButton = screen.getByRole('button', { name: 'Recent' });
    expect(within(recentButton).getByTestId('recent-icon')).toBeInTheDocument();
    const recentSection = container.querySelector<HTMLElement>('[data-emoji-category="Recent"]')!;
    expect(recentSection).toHaveTextContent('No recent emojis');

    fireEvent.click(screen.getByTitle('grinning'));
    expect(within(recentSection).getByRole('button', { name: '😀' })).not.toHaveAttribute('title');
  });

  it('renders recent custom picks from their remembered URL', () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <EmojiPicker onPick={onPick} onClose={() => {}} customEmojis={{ party_dance: 'https://cdn.example/party_dance.gif' }} />,
    );

    fireEvent.click(screen.getByTitle(':party_dance:'));
    // The server emoji set no longer carries the shortcode — the recents grid
    // must still show the media, not the text `:party_dance:`.
    rerender(<EmojiPicker onPick={onPick} onClose={() => {}} customEmojis={{}} />);

    const recentSection = document.querySelector<HTMLElement>('[data-emoji-category="Recent"]')!;
    expect(within(recentSection).getByAltText(':party_dance:')).toHaveAttribute('src', 'https://cdn.example/party_dance.gif');
    expect(recentSection).not.toHaveTextContent(':party_dance:');

    fireEvent.click(within(recentSection).getByAltText(':party_dance:'));
    expect(onPick).toHaveBeenLastCalledWith(':party_dance:', expect.objectContaining({ name: 'party_dance', url: 'https://cdn.example/party_dance.gif' }));
  });

  it('drops recent shortcodes that cannot be resolved to media', () => {
    localStorage.setItem('obelisk:recent-emojis', JSON.stringify([':ghost_sticker:', '😀']));

    const { container } = render(<EmojiPicker onPick={() => {}} onClose={() => {}} customEmojis={{}} />);

    const recentSection = container.querySelector<HTMLElement>('[data-emoji-category="Recent"]')!;
    expect(recentSection).not.toHaveTextContent(':ghost_sticker:');
    expect(within(recentSection).getByRole('button', { name: '😀' })).toBeInTheDocument();
  });

  it('shows a glyph instead of the shortcode when custom media fails to load', () => {
    render(<EmojiPicker onPick={() => {}} onClose={() => {}} skipRecent customEmojis={{ wave: 'https://cdn.example/gone.webp' }} />);

    fireEvent.error(screen.getByAltText(':wave:'));

    const section = screen.getByText('Server emojis').parentElement!;
    expect(within(section).getByTestId('media-thumb-fallback')).toBeInTheDocument();
    expect(section).not.toHaveTextContent(':wave:');
  });

  it('positions popovers above or below the trigger', () => {
    const props = {
      onPick: vi.fn(),
      onClose: vi.fn(),
      skipRecent: true,
      customEmojis: {},
    };
    const { rerender } = render(<EmojiPicker {...props} placement="below" />);

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toHaveClass('top-full', 'mt-1');

    rerender(<EmojiPicker {...props} placement="above" />);

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toHaveClass('bottom-full', 'mb-1');
  });
});
