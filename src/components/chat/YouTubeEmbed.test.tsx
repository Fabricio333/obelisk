import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import YouTubeEmbed from './YouTubeEmbed';

describe('YouTubeEmbed', () => {
  it('renders thumbnail by default', () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    const btn = screen.getByTestId('youtube-thumbnail');
    expect(btn).toBeInTheDocument();
    const img = btn.querySelector('img');
    expect(img?.src).toContain('dQw4w9WgXcQ');
  });

  it('loads iframe on click', async () => {
    const user = userEvent.setup();
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    await user.click(screen.getByTestId('youtube-thumbnail'));
    const iframe = screen.getByTestId('youtube-iframe').querySelector('iframe');
    expect(iframe?.src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('defaults to the chat-bubble mq thumbnail', () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    const img = screen.getByTestId('youtube-thumbnail').querySelector('img');
    expect(img?.src).toContain('/mqdefault.jpg');
  });

  it('serves a maxres thumbnail when asked, for full-width surfaces', () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" thumbnailRes="maxres" />);
    const img = screen.getByTestId('youtube-thumbnail').querySelector('img');
    expect(img?.src).toContain('/maxresdefault.jpg');
  });

  it('falls back to hqdefault when maxres does not exist for the upload', () => {
    // Not every video has a maxres still; YouTube 404s rather than
    // substituting, so the facade would render a broken image.
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" thumbnailRes="maxres" />);
    const img = screen.getByTestId('youtube-thumbnail').querySelector('img')!;
    fireEvent.error(img);
    expect(img.src).toContain('/hqdefault.jpg');
  });

  it('applies caller sizing and title to both the facade and the player', async () => {
    const user = userEvent.setup();
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" className="w-full" title="Obelisk walkthrough" />);

    const btn = screen.getByTestId('youtube-thumbnail');
    expect(btn.className).toContain('w-full');
    expect(btn.getAttribute('aria-label')).toBe('Obelisk walkthrough');

    await user.click(btn);
    const wrapper = screen.getByTestId('youtube-iframe');
    expect(wrapper.className).toContain('w-full');
    expect(wrapper.querySelector('iframe')?.title).toBe('Obelisk walkthrough');
  });
});
