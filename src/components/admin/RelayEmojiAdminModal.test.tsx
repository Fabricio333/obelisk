import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RelayEmojiAdminModal from './RelayEmojiAdminModal';

vi.mock('@/components/media/MediaLibraryModal', () => ({
  default: ({ server, initialTab }: { server: { relayUrl: string; emojiSet: { emojis: unknown[] } }; initialTab: string }) => (
    <div data-testid="media-library-stub">{initialTab}:{server.relayUrl}:{server.emojiSet.emojis.length}</div>
  ),
}));

describe('RelayEmojiAdminModal', () => {
  it('opens server settings directly in the pack library', () => {
    render(
      <RelayEmojiAdminModal
        relayUrl="wss://relay.example"
        configuredRelays={[]}
        emojiSet={{ title: 'Server media', emojis: [{ name: 'wave', url: 'https://cdn.example/wave.webp' }], updatedAt: 1 }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('media-library-stub')).toHaveTextContent('server:wss://relay.example:1');
  });
});
