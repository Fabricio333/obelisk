import { fireEvent, render, screen } from '@testing-library/react';
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

  it("jumps directly to classified emoji sections", () => {
    const { container } = render(
      <EmojiPicker onPick={() => {}} onClose={() => {}} skipRecent customEmojis={{}} />,
    );

    expect(screen.getByRole("navigation", { name: "Emoji categories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smileys & people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Animals & nature" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Flags" })).toBeInTheDocument();

    const transport = container.querySelector<HTMLElement>("[data-emoji-category=\"Transport\"]")!;
    expect(transport).toHaveTextContent("🚗");
    expect(container.querySelector<HTMLElement>("[data-emoji-category=\"Flags\"]")).toHaveTextContent("🇦🇷");
    const scroller = transport.parentElement!;
    scroller.scrollTo = vi.fn();
    Object.defineProperty(transport, "offsetTop", { configurable: true, value: 320 });
    fireEvent.click(screen.getByRole("button", { name: "Cars & transport" }));

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Cars & transport" })).toHaveAttribute("aria-pressed", "true");
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
