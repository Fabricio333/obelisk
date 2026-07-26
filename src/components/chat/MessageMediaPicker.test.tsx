import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageMediaPicker from './MessageMediaPicker';

vi.mock('@/lib/blossom', () => ({
  uploadToBlossom: vi.fn().mockResolvedValue('https://cdn.example/mine.webp'),
}));

describe('MessageMediaPicker', () => {
  beforeEach(() => localStorage.clear());

  it('separates emoji, GIF, and sticker views', () => {
    const onPick = vi.fn();
    render(
      <MessageMediaPicker
        onPick={onPick}
        onClose={() => {}}
        customEmojis={{
          dance: 'https://cdn.example/dance.gif',
          wave: 'https://cdn.example/wave.webp',
          applause_copy: 'https://media.giphy.com/media/l3q2XhfQ8oCkm1Ts4/giphy.gif',
        }}
      />,
    );

    expect(screen.getByRole('searchbox', { name: 'Search emoji' }).parentElement).toHaveClass('rounded-xl', 'border-lc-green/80');
    expect(screen.getByText('Server GIFs')).toBeInTheDocument();
    expect(screen.getByText('Server emojis')).toBeInTheDocument();
    expect(screen.getByAltText(':dance:')).toBeInTheDocument();
    expect(screen.getByAltText(':wave:')).toBeInTheDocument();
    const categoryNav = screen.getByRole('navigation', { name: 'Emoji categories' });
    const emojiTab = screen.getByRole('button', { name: 'emoji' });
    expect(categoryNav).toHaveClass('grid-cols-9');
    expect(categoryNav.compareDocumentPosition(emojiTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close emoji picker' })).not.toBeInTheDocument();
    const shell = screen.getByTestId('media-picker-shell');
    const shellClass = shell.className;
    expect(shell).toHaveClass('h-[520px]', 'w-[600px]');
    expect(screen.getByTitle('grinning').parentElement).toHaveClass('grid-cols-12');
    expect(screen.getByText('Smileys & people')).toHaveClass('sticky', 'border-b');
    expect(screen.getByText('Smileys & people').parentElement?.parentElement).toHaveClass('overflow-y-auto');
    fireEvent.click(screen.getByRole('button', { name: 'gif' }));
    expect(screen.getByTestId('media-picker-shell')).toHaveAttribute('class', shellClass);
    const mediaCategories = screen.getByRole('navigation', { name: 'Media categories' });
    expect(within(mediaCategories).getAllByRole('button')).toHaveLength(9);
    expect(mediaCategories.querySelectorAll('svg')).toHaveLength(9);
    expect(within(screen.getByRole('button', { name: 'Recent' })).getByTestId('recent-icon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close media picker' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search GIFs' }).parentElement).toHaveClass('rounded-xl', 'border-lc-green/80');
    expect(within(screen.getByTestId('media-section-server_gifs')).getByAltText(':dance:')).toBeInTheDocument();
    const defaultGifs = screen.getByTestId('media-section-default_gifs');
    expect(within(defaultGifs).getByAltText(':applause:')).toBeInTheDocument();
    expect(within(defaultGifs).getAllByRole('img')).toHaveLength(22);
    expect(screen.queryByAltText(':applause_copy:')).not.toBeInTheDocument();
    fireEvent.click(screen.getByAltText(':applause:'));
    expect(onPick).toHaveBeenCalledWith(expect.stringContaining('/giphy.gif'), undefined, 'gif');
    fireEvent.click(screen.getByRole('button', { name: 'Animals' }));
    expect(screen.getByAltText(':dancing_cat:')).toBeInTheDocument();
    expect(screen.queryByAltText(':applause:')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Trending' }));
    expect(screen.queryByAltText(':wave:')).not.toBeInTheDocument();
    fireEvent.click(screen.getByAltText(':dance:'));
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(screen.getByAltText(':dance:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Trending' }));
    const gifTab = screen.getByRole('button', { name: 'gif' });
    expect(screen.getByTestId('media-grid').compareDocumentPosition(gifTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
    expect(screen.getByRole('searchbox', { name: 'Search stickers' }).parentElement).toHaveClass('rounded-xl', 'border-lc-green/80');
    expect(within(screen.getByTestId('media-section-server_stickers')).getByAltText(':wave:')).toBeInTheDocument();
    const defaultSticker = within(screen.getByTestId('media-section-default_stickers')).getByAltText(':laugh_cry:');
    expect(defaultSticker).toBeInTheDocument();
    fireEvent.click(defaultSticker);
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(within(screen.getByTestId('media-section-recent_stickers')).getByAltText(':laugh_cry:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Trending' }));
    expect(screen.getByTestId('media-section-my_stickers')).toBeInTheDocument();
    expect(within(screen.getByTestId('media-grid')).getAllByRole('button')[0]).toHaveAccessibleName('Create sticker');
  });

  it('returns a picked sticker with its portable NIP-30 metadata', () => {
    const onPick = vi.fn();
    render(
      <MessageMediaPicker
        initialTab="sticker"
        onPick={onPick}
        onClose={() => {}}
        customEmojis={{ wave: 'https://cdn.example/wave.webp' }}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Media picker' })).toHaveClass('bg-lc-black');
    expect(screen.getByTitle(':wave:')).toHaveClass('min-w-0', 'overflow-hidden');
    fireEvent.click(screen.getByTitle(':wave:'));
    expect(onPick).toHaveBeenCalledWith(
      ':wave:',
      { name: 'wave', url: 'https://cdn.example/wave.webp' },
      'sticker',
    );
  });
});
