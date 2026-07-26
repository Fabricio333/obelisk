import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import MessageContent from './MessageContent';
import { useChatStore } from '@/store/chat';

describe('MessageContent stickers', () => {
  it('renders nprofile entities with the shared clickable profile chip', () => {
    useChatStore.setState(useChatStore.getInitialState());
    const pubkey = 'c'.repeat(64);
    const nprofile = nip19.nprofileEncode({ pubkey, relays: ['wss://relay.example'] });

    render(<MessageContent content={`nostr:${nprofile}`} />);
    fireEvent.click(screen.getByTestId('mention-highlight'), { clientX: 80, clientY: 120 });

    expect(screen.queryByText(`nostr:${nprofile}`)).not.toBeInTheDocument();
    expect(useChatStore.getState().profilePopupPubkey).toBe(pubkey);
  });

  it('renders Nostr hashtags blue and feed media at the available width', () => {
    const { rerender } = render(<MessageContent content="[#Nostr](https://njump.me/t/Nostr)" />);
    expect(screen.getByTestId('nostr-hashtag')).toHaveClass('text-sky-400');
    expect(screen.getByTestId('nostr-hashtag')).toHaveAttribute('href', 'https://njump.me/t/Nostr');

    rerender(<MessageContent content="https://cdn.example/photo.jpg" wideMedia />);
    expect(screen.getByTestId('image-gallery')).toHaveClass('w-full', 'max-w-full');
  });

  it('uses the waveform player for uploaded audio files', () => {
    render(<MessageContent content="https://cdn.example/song.mp3" />);

    expect(screen.getByTestId('voice-message')).toBeInTheDocument();
    expect(screen.getByTestId('voice-waveform')).toBeInTheDocument();
    expect(screen.queryByTestId('audio-player')).not.toBeInTheDocument();
  });

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
    render(
      <MessageContent
        content={url}
        voiceNote={{ url, durationSeconds: 5 }}
        voiceAuthorPicture="https://cdn.example/avatar.webp"
        voiceTimestamp={1_700_000_000}
      />,
    );

    expect(screen.getByTestId("voice-message")).toHaveClass("bg-[#202c33]", "rounded-[18px]", "min-h-20", "gap-3");
    expect(screen.getByTestId("voice-waveform")).toHaveClass("absolute", "top-1/2", "-translate-y-1/2", "right-3");
    expect(screen.getByTestId("voice-waveform").children[0]?.children).toHaveLength(28);
    expect(screen.getByTestId("voice-time-row")).toHaveClass("absolute", "bottom-0", "right-3");
    expect(screen.getByTestId("voice-avatar")).toHaveClass("h-14", "w-14", "shrink-0");
    expect(screen.getByTestId("voice-progress-dot")).toHaveClass("bg-[#53bdeb]");
    expect(screen.getByLabelText("Play voice message")).toBeInTheDocument();
    expect(screen.getByAltText("Voice message sender")).toHaveAttribute("src", "https://cdn.example/avatar.webp");
    expect(screen.getByTestId("voice-mic-badge")).toBeInTheDocument();
    expect(screen.getByText("0:05")).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument();
  });

  it("cycles playback speed over the sender picture only while audio plays", () => {
    render(
      <MessageContent
        content="voice"
        voiceNote={{ url: "https://cdn.example/voice.webm", durationSeconds: 5 }}
        voiceAuthorPicture="https://cdn.example/avatar.webp"
      />,
    );

    const audio = screen.getByTestId("voice-message").querySelector("audio") as HTMLAudioElement;
    expect(screen.queryByRole("button", { name: /Playback speed/ })).not.toBeInTheDocument();

    fireEvent.play(audio);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1x" }));
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 1.5x" }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 2x" }));
    expect(audio.playbackRate).toBe(1);

    fireEvent.pause(audio);
    expect(screen.queryByRole("button", { name: /Playback speed/ })).not.toBeInTheDocument();
  });

  it("upgrades an untagged audio-only WebM without misclassifying real video", () => {
    const url = "https://cdn.example/legacy.webm";
    render(<MessageContent content={url} voiceAuthorPicture="https://cdn.example/avatar.webp" voiceTimestamp={1_700_000_000} />);

    const video = screen.getByTestId("video-player");
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 640 },
      duration: { configurable: true, value: 5 },
    });
    fireEvent.loadedMetadata(video);
    expect(screen.getByTestId("video-player")).toBeInTheDocument();

    Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument();
    expect(screen.getByTestId("voice-message")).toBeInTheDocument();
  });
});
