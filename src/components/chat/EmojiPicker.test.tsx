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
