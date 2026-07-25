import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageMediaPicker from './MessageMediaPicker';

vi.mock('@/lib/blossom', () => ({
  uploadToBlossom: vi.fn().mockResolvedValue('https://cdn.example/mine.webp'),
}));

describe('MessageMediaPicker', () => {
  beforeEach(() => localStorage.clear());

  it('separates emoji, GIF, and sticker views', () => {
    render(
      <MessageMediaPicker
        onPick={() => {}}
        onClose={() => {}}
        customEmojis={{
          dance: 'https://cdn.example/dance.gif',
          wave: 'https://cdn.example/wave.webp',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'gif' }));
    expect(screen.getByAltText(':dance:')).toBeInTheDocument();
    expect(screen.queryByAltText(':wave:')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
    expect(screen.getByAltText(':wave:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
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
