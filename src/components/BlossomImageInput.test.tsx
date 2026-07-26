import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const uploadToBlossom = vi.fn();

vi.mock('@/lib/blossom', () => ({ uploadToBlossom }));

import { ChannelAppearanceInput } from './BlossomImageInput';

describe('ChannelAppearanceInput', () => {
  it('shows a social header preview and only file upload controls', async () => {
    uploadToBlossom.mockResolvedValueOnce('https://cdn.example/new-picture.jpg');
    const onPictureChange = vi.fn();

    render(
      <ChannelAppearanceInput
        picture="https://cdn.example/picture.jpg"
        banner="https://cdn.example/banner.jpg"
        onPictureChange={onPictureChange}
        onBannerChange={() => {}}
      />,
    );

    expect(screen.getByAltText('Channel banner preview')).toHaveAttribute('src', 'https://cdn.example/banner.jpg');
    expect(screen.getByAltText('Channel profile picture preview')).toHaveAttribute('src', 'https://cdn.example/picture.jpg');
    expect(screen.getByTestId('channel-appearance-preview')).toHaveClass('aspect-[4/1]');
    expect(screen.getByAltText('Channel profile picture preview').parentElement).toHaveClass('h-24', 'w-24');
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.change(screen.getByLabelText('Upload profile picture'), {
      target: { files: [new File(['picture'], 'picture.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(onPictureChange).toHaveBeenCalledWith('https://cdn.example/new-picture.jpg'));
  });
});
