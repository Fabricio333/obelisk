import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MessageContent from './MessageContent';

describe('MessageContent stickers', () => {
  it('renders tagged stickers as large media instead of inline custom emoji', () => {
    render(
      <MessageContent
        content=":party_cat:"
        customEmojis={{ party_cat: 'https://cdn.example/party.webp' }}
        sticker={{ name: 'party_cat', url: 'https://cdn.example/party.webp' }}
      />,
    );

    expect(screen.getByTestId('message-sticker')).toHaveClass('h-44', 'w-44');
    expect(screen.getByAltText('Sticker :party_cat:')).toHaveAttribute('src', 'https://cdn.example/party.webp');
    expect(screen.queryByTestId('custom-emoji')).not.toBeInTheDocument();
  });

  it("renders tagged voice notes with the compact player and no video canvas", () => {
    const url = "https://cdn.example/voice.webm";
    render(<MessageContent content={url} voiceNote={{ url, durationSeconds: 5 }} />);

    expect(screen.getByTestId("voice-message")).toHaveClass("bg-lc-card", "rounded-2xl");
    expect(screen.getByLabelText("Play voice message")).toBeInTheDocument();
    expect(screen.getByText("0:05")).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument();
  });
});
