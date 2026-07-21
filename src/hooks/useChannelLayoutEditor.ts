'use client';

import { useMemo, useState } from 'react';
import {
  applyLayout,
  newCategoryId,
  publishLayout,
  type ChannelLayout,
} from '@/lib/channel-layout';

export function useChannelLayoutEditor(
  relayUrl: string,
  layout: ChannelLayout,
  channels: ReadonlyArray<{ id: string }>,
  onSaved: () => void,
) {
  const [draft, setDraft] = useState(layout);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const laidOut = useMemo(
    () => applyLayout(draft, channels.map((channel) => channel.id)),
    [channels, draft],
  );

  function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    setDraft((current) => ({
      ...current,
      categories: [
        ...current.categories,
        { id: newCategoryId(), name, position: current.categories.length },
      ],
    }));
    setNewCategoryName('');
  }

  function renameCategory(id: string, name: string) {
    setDraft((current) => ({
      ...current,
      categories: current.categories.map((category) =>
        category.id === id ? { ...category, name } : category,
      ),
    }));
  }

  function deleteCategory(id: string) {
    setDraft((current) => ({
      ...current,
      categories: current.categories.filter((category) => category.id !== id),
      channels: current.channels.map((channel) =>
        channel.categoryId === id ? { ...channel, categoryId: null } : channel,
      ),
    }));
  }

  function moveCategory(id: string, delta: number) {
    setDraft((current) => {
      const categories = [...current.categories];
      const from = categories.findIndex((category) => category.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= categories.length) return current;
      [categories[from], categories[to]] = [categories[to], categories[from]];
      return {
        ...current,
        categories: categories.map((category, position) => ({ ...category, position })),
      };
    });
  }

  function setChannelCategory(channelId: string, categoryId: string | null) {
    setDraft((current) => {
      const others = current.channels.filter((channel) => channel.id !== channelId);
      const position = others.filter((channel) => channel.categoryId === categoryId).length;
      return { ...current, channels: [...others, { id: channelId, categoryId, position }] };
    });
  }

  function moveChannel(channelId: string, delta: number) {
    setDraft((current) => {
      const channel = current.channels.find((item) => item.id === channelId);
      const categoryId = channel?.categoryId ?? null;
      const bucket = laidOut.categories.find((category) => category.id === categoryId)?.channelIds
        ?? (categoryId === null ? laidOut.uncategorized : []);
      const from = bucket.indexOf(channelId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= bucket.length) return current;
      const order = [...bucket];
      [order[from], order[to]] = [order[to], order[from]];
      return {
        ...current,
        channels: [
          ...current.channels.filter((item) => item.categoryId !== categoryId),
          ...order.map((id, position) => ({ id, categoryId, position })),
        ],
      };
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await publishLayout(relayUrl, {
        categories: draft.categories.map((category, position) => ({ ...category, position })),
        channels: draft.channels.map((channel, position) => ({ ...channel, position })),
        updatedAt: Math.floor(Date.now() / 1000),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return {
    draft,
    error,
    laidOut,
    newCategoryName,
    saving,
    setNewCategoryName,
    addCategory,
    deleteCategory,
    moveCategory,
    moveChannel,
    renameCategory,
    save,
    setChannelCategory,
  };
}
