import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nip19 } from 'nostr-tools';
import { describe, expect, it, vi } from 'vitest';
import GeneratedProfileEnhancements, { randomProfileName } from './GeneratedProfileEnhancements';

const uploadToBlossom = vi.fn()
  .mockResolvedValueOnce('https://cdn.example/avatar.jpg')
  .mockResolvedValueOnce('https://cdn.example/banner.jpg');
vi.mock('@/lib/blossom', () => ({ uploadToBlossom }));

describe('GeneratedProfileEnhancements', () => {
  it('renders media previews and puts random-name control inside the name field', async () => {
    expect(randomProfileName(() => 0)).toBe('Brave Badger');
    const onDraftChange = vi.fn();
    const nsec = nip19.nsecEncode(new Uint8Array(32).fill(1));
    render(
      <div className="nui-modal-overlay">
        <GeneratedProfileEnhancements onDraftChange={onDraftChange} />
        <div className="obelisk-login-modal">
          <div className="nui-key-display">{nsec}</div>
          <label><input placeholder="Satoshi" /></label>
          <label><input placeholder="Builder, chef, occasional cyclist." /></label>
          <label><span>Picture URL</span><input type="url" placeholder="https://example.com/avatar.jpg" /></label>
        </div>
      </div>,
    );

    const randomButton = await screen.findByRole('button', { name: /generate a random name/i });
    fireEvent.click(randomButton);
    expect(screen.getByPlaceholderText('Satoshi')).not.toHaveValue('');
    expect(onDraftChange).toHaveBeenCalledWith({ name: expect.any(String) });

    const urlInput = screen.getByPlaceholderText('https://example.com/avatar.jpg');
    expect(urlInput).not.toBeVisible();
    expect(screen.getByText('Upload banner')).toBeInTheDocument();

    const avatarPicker = document.querySelector<HTMLInputElement>('[data-kind="picture"] input[type="file"]');
    const avatar = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(avatarPicker!, { target: { files: [avatar] } });
    await waitFor(() => expect(urlInput).toHaveValue('https://cdn.example/avatar.jpg'));
    expect(document.querySelector('[data-kind="picture"] img')).toHaveAttribute('src', 'https://cdn.example/avatar.jpg');

    const bannerPicker = document.querySelector<HTMLInputElement>('[data-kind="banner"] input[type="file"]');
    const banner = new File(['banner'], 'banner.png', { type: 'image/png' });
    fireEvent.change(bannerPicker!, { target: { files: [banner] } });
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({ banner: 'https://cdn.example/banner.jpg' }));
    expect(document.querySelector('[data-kind="banner"] img')).toHaveAttribute('src', 'https://cdn.example/banner.jpg');
  });
});
