import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelLayout } from '@/lib/channel-layout';
import { useChannelLayoutEditor } from './useChannelLayoutEditor';

const emptyLayout: ChannelLayout = { categories: [], channels: [], updatedAt: 0 };

describe('useChannelLayoutEditor', () => {
  it('shares category creation and assignment behavior across responsive editors', () => {
    const { result } = renderHook(() =>
      useChannelLayoutEditor(
        'wss://relay.test',
        emptyLayout,
        [{ id: 'one' }, { id: 'two' }],
        vi.fn(),
      ),
    );

    act(() => {
      result.current.setNewCategoryName('General');
    });
    act(() => {
      result.current.addCategory();
    });

    const category = result.current.draft.categories[0];
    expect(category.name).toBe('General');

    act(() => {
      result.current.setChannelCategory('one', category.id);
    });
    expect(result.current.laidOut.categories[0].channelIds).toEqual(['one']);
    expect(result.current.laidOut.uncategorized).toEqual(['two']);
  });

  it('places a grabbed channel before another channel across categories', () => {
    const layout: ChannelLayout = {
      categories: [
        { id: 'general', name: 'General', position: 0 },
        { id: 'voice', name: 'Voice', position: 1 },
      ],
      channels: [
        { id: 'one', categoryId: 'general', position: 0 },
        { id: 'two', categoryId: 'voice', position: 1 },
        { id: 'three', categoryId: 'voice', position: 2 },
      ],
      updatedAt: 0,
    };
    const { result } = renderHook(() =>
      useChannelLayoutEditor('wss://relay.test', layout, [{ id: 'one' }, { id: 'two' }, { id: 'three' }], vi.fn()),
    );

    act(() => result.current.placeChannel('one', 'voice', 'three'));

    expect(result.current.laidOut.categories[0].channelIds).toEqual([]);
    expect(result.current.laidOut.categories[1].channelIds).toEqual(['two', 'one', 'three']);
  });

  it('inserts a grabbed category at its dropped position', () => {
    const layout: ChannelLayout = {
      categories: ['one', 'two', 'three'].map((id, position) => ({ id, name: id, position })),
      channels: [],
      updatedAt: 0,
    };
    const { result } = renderHook(() => useChannelLayoutEditor('wss://relay.test', layout, [], vi.fn()));

    act(() => result.current.placeCategory('one', 2));

    expect(result.current.laidOut.categories.map((category) => category.id)).toEqual(['two', 'three', 'one']);
  });
});
