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
    mocks.publishRelayEmojiSet.mockClear();
  });

  it('opens directly on a sticker detail and explores its source pack', () => {
    const onClose = vi.fn();
    render(<MediaLibraryModal onClose={onClose} initialSelection={{ pack, item: pack.items[0] }} />);

    expect(screen.getByTestId('media-item-menu')).toBeInTheDocument();
    expect(screen.queryByTestId('media-library-modal')).toBeNull();
    expect(screen.queryByText('Marketplace')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add item to favorites' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Cat pack' }));
    expect(within(screen.getByTestId('media-pack-viewer')).getByAltText(':cat_6:')).toBeInTheDocument();
    expect(screen.queryByTestId('media-library-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close pack viewer' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('explores a complete pack in place and favorites either the pack or one item', async () => {
    render(<MediaLibraryModal onClose={() => {}} />);

    const modal = screen.getByTestId('media-library-modal');
    expect(modal.firstElementChild).toHaveClass('h-[calc(100dvh_-_1rem)]', 'max-h-[calc(100%_-_1rem)]');
    expect(modal.querySelector('main')).toHaveClass('min-h-0');
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

  it("server settings only track existing whole packs", async () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: "wss://relay.example",
      emojiSet: {
        title: "Legacy server favorites",
        emojis: [{ name: "wave", url: "https://cdn.example/wave.webp", kind: "sticker" }],
        updatedAt: 1,
      },
    }} />);

    expect(within(screen.getByTestId("server-pack-summary")).getByRole("heading", { name: "Server packs" })).toBeInTheDocument();
    expect(screen.getByText("0 packs selected. Add or remove existing packs below.")).toBeInTheDocument();
    expect(screen.getByText("Legacy individual items will be removed on the next pack change.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create pack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Cat pack" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Open :party_cat: actions" })[0]);
    const menu = screen.getByTestId("media-item-menu");
    expect(within(menu).getByRole("button", { name: "View Cat pack" })).toBeInTheDocument();
    expect(within(menu).queryByRole("button", { name: "Add item to favorites" })).toBeNull();
    expect(within(menu).queryByRole("button", { name: "Add item to server" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Close media actions" }));

    fireEvent.click(screen.getByRole("button", { name: "Add pack to server" }));
    await waitFor(() => expect(mocks.publishRelayEmojiSet).toHaveBeenCalledWith(
      "wss://relay.example",
      expect.objectContaining({ emojis: [], packAddresses: [pack.address] }),
    ));
    expect(mocks.saveMediaPack).not.toHaveBeenCalled();
  });

  it("removes a selected live pack from the server", async () => {
    render(<MediaLibraryModal onClose={() => {}} server={{
      relayUrl: "wss://relay.example",
      emojiSet: { title: "Server packs", emojis: [], packAddresses: [pack.address], updatedAt: 1 },
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove pack from server" }));
    await waitFor(() => expect(mocks.publishRelayEmojiSet).toHaveBeenCalledWith(
      "wss://relay.example",
      expect.objectContaining({ emojis: [], packAddresses: [] }),
    ));
  });
});
