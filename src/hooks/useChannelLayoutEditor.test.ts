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
});
