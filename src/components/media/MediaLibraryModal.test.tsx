import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaLibraryModal from './MediaLibraryModal';

const author = 'a'.repeat(64);
const pack = {
  address: `30030:${author}:cats`,
  identifier: 'cats',
  author,
  title: 'Cat pack',
  description: 'Cats for every chat',
  image: '',
  items: Array.from({ length: 6 }, (_, index) => ({
    name: index === 0 ? 'party_cat' : 'cat_' + (index + 1),
    url: 'https://cdn.example/cat-' + (index + 1) + '.webp',
    kind: 'sticker' as const,
  })),
  createdAt: 10,
};

const mocks = vi.hoisted(() => ({
  saveMediaPack: vi.fn().mockResolvedValue(undefined),
  saveMediaFavorites: vi.fn().mockResolvedValue(undefined),
  deleteMediaPack: vi.fn().mockResolvedValue(undefined),
  imported: false,
  publishRelayEmojiSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    saveMediaPack: (...args: unknown[]) => mocks.saveMediaPack(...args),
    saveMediaFavorites: (...args: unknown[]) => mocks.saveMediaFavorites(...args),
    deleteMediaPack: (...args: unknown[]) => mocks.deleteMediaPack(...args),
  },
  useMediaPacks: () => ({
    [pack.address]: pack,
    ...(mocks.imported ? {
      [`${pack.address.split(':').slice(0, 2).join(':')}:server-relay_example`]: {
        ...pack,
        address: `30030:${author}:server-relay_example`,
        identifier: 'server-relay_example',
      },
    } : {}),
  }),
  useMyMediaFavorites: () => ({ items: [], packAddresses: [], createdAt: 0 }),
  useMyPubkey: () => author,
}));

vi.mock('@/lib/relay-emojis', () => ({
  publishRelayEmojiSet: (...args: unknown[]) => mocks.publishRelayEmojiSet(...args),
}));

vi.mock('@/lib/blossom', () => ({ uploadToBlossom: vi.fn() }));

describe('MediaLibraryModal', () => {
  beforeEach(() => {
    mocks.saveMediaPack.mockClear();
    mocks.saveMediaFavorites.mockClear();
    mocks.deleteMediaPack.mockClear();
    mocks.imported = false;
    mocks.publishRelayEmojiSet.mockClear();
  });

  it('explores a complete pack in place and favorites either the pack or one item', async () => {
    render(<MediaLibraryModal onClose={() => {}} />);

    expect(screen.getByText('Cat pack')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Cat pack' }));
    expect(mocks.saveMediaFavorites).toHaveBeenCalledWith({
      items: [],
      packAddresses: [pack.address],
    });

    expect(screen.queryByAltText(':cat_6:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View pack' }));
    const viewer = screen.getByTestId('media-pack-viewer');
    expect(within(viewer).getByAltText(':cat_6:')).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Open :party_cat: actions' }));
    const menu = screen.getByTestId('media-item-menu');
    expect(within(menu).getByRole('button', { name: 'View Cat pack' })).toBeInTheDocument();
    await waitFor(() => expect(within(menu).getByRole('button', { name: 'Add item to favorites' })).not.toBeDisabled());
    fireEvent.click(within(menu).getByRole('button', { name: 'Add item to favorites' }));
    expect(mocks.saveMediaFavorites).toHaveBeenLastCalledWith({
      items: [pack.items[0]],
      packAddresses: [],
    });
  });

  it('deletes an owned pack after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MediaLibraryModal onClose={() => {}} initialTab="mine" />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.deleteMediaPack).toHaveBeenCalledWith(pack.address));
  });

  it('creates and edits an independent named pack', async () => {
    render(<MediaLibraryModal onClose={() => {}} initialTab="mine" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Create pack' })[0]);
    const editor = screen.getByTestId('media-pack-editor');
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Pack name' }), { target: { value: 'My reactions' } });
    fireEvent.change(within(editor).getByRole('combobox', { name: 'New item type' }), { target: { value: 'emoji' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add URL' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Item 1 shortcode' }), { target: { value: 'wow' } });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Item 1 URL' }), { target: { value: 'https://cdn.example/wow.webp' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save pack' }));

    expect(mocks.saveMediaPack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My reactions',
      items: [{ name: 'wow', url: 'https://cdn.example/wow.webp', kind: 'emoji' }],
    }));
  });

  it('creates a typed pack from server settings and adds it to that server', async () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: 'wss://relay.example',
      emojiSet: { title: 'Server favorites', emojis: [], updatedAt: 1 },
    }} />);

    expect(screen.queryByRole('button', { name: 'Favorites' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Cat pack' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add pack to server' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open :party_cat: actions' })[0]);
    const menu = screen.getByTestId('media-item-menu');
    expect(within(menu).queryByRole('button', { name: 'Add item to favorites' })).toBeNull();
    expect(within(menu).getByRole('button', { name: 'Add item to server' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('button', { name: 'Close media actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'GIFs' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Create pack' })[0]);
    const editor = screen.getByTestId('media-pack-editor');
    expect(within(editor).getByRole('combobox', { name: 'New item type' })).toHaveValue('gif');
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Pack name' }), { target: { value: 'Server GIFs' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Add URL' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Item 1 shortcode' }), { target: { value: 'dance' } });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Item 1 URL' }), { target: { value: 'https://cdn.example/dance.gif' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save & add to server' }));

    await waitFor(() => expect(mocks.publishRelayEmojiSet).toHaveBeenCalledWith(
      'wss://relay.example',
      expect.objectContaining({
        emojis: [],
        packAddresses: [expect.stringMatching(new RegExp('^30030:' + author + ':'))],
      }),
    ));
    expect(mocks.saveMediaPack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Server GIFs',
      items: [{ name: 'dance', url: 'https://cdn.example/dance.gif', kind: 'gif' }],
    }));
  });

  it('removes a selected live pack from the server', async () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: 'wss://relay.example',
      emojiSet: { title: 'Server favorites', emojis: [], packAddresses: [pack.address], updatedAt: 1 },
    }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove pack from server' }));
    await waitFor(() => expect(mocks.publishRelayEmojiSet).toHaveBeenCalledWith(
      'wss://relay.example',
      expect.objectContaining({ packAddresses: [] }),
    ));
  });

  it('removes an item from the current server favorites', async () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: 'wss://relay.example',
      emojiSet: {
        title: 'Server favorites',
        emojis: [{ name: 'wave', url: 'https://cdn.example/wave.webp', kind: 'sticker' }],
        updatedAt: 1,
      },
    }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove :wave: from server' }));
    await waitFor(() => expect(mocks.publishRelayEmojiSet).toHaveBeenCalledWith(
      'wss://relay.example',
      expect.objectContaining({ emojis: [] }),
    ));
  });

  it('migrates every legacy server item into an editable pack without deleting the old list', () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: 'wss://relay.example',
      emojiSet: {
        title: 'Old server list',
        emojis: [
          { name: 'wave', url: 'https://cdn.example/wave.webp' },
          { name: 'dance', url: 'https://cdn.example/dance.gif' },
        ],
        updatedAt: 1,
      },
    }} />);

    expect(screen.getByText('2 items selected for this server.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import existing list once' }));

    expect(mocks.saveMediaPack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Old server list',
      items: [
        { name: 'wave', url: 'https://cdn.example/wave.webp', kind: 'emoji' },
        { name: 'dance', url: 'https://cdn.example/dance.gif', kind: 'gif' },
      ],
    }));
    expect(mocks.publishRelayEmojiSet).not.toHaveBeenCalled();
  });

  it('hides the one-time import after its deterministic pack exists', () => {
    mocks.imported = true;
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: 'wss://relay.example',
      emojiSet: {
        title: 'Old server list',
        emojis: [{ name: 'wave', url: 'https://cdn.example/wave.webp' }],
        updatedAt: 1,
      },
    }} />);

    expect(screen.queryByRole('button', { name: 'Import existing list once' })).toBeNull();
  });
});
