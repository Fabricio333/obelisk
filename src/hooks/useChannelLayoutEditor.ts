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

  function placeCategory(id: string, targetIndex: number) {
    setDraft((current) => {
      const categories = [...current.categories];
      const from = categories.findIndex((category) => category.id === id);
      if (from < 0 || targetIndex < 0 || targetIndex >= categories.length) return current;
      const [category] = categories.splice(from, 1);
      categories.splice(targetIndex, 0, category);
      return { ...current, categories: categories.map((item, position) => ({ ...item, position })) };
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

  function placeChannel(channelId: string, categoryId: string | null, beforeChannelId?: string) {
    setDraft((current) => {
      const currentLayout = applyLayout(current, channels.map((channel) => channel.id));
      const buckets = new Map(currentLayout.categories.map((category) => [category.id, [...category.channelIds]]));
      const uncategorized = [...currentLayout.uncategorized];
      for (const bucket of [...buckets.values(), uncategorized]) {
        const index = bucket.indexOf(channelId);
        if (index >= 0) bucket.splice(index, 1);
      }
      const target = categoryId === null ? uncategorized : buckets.get(categoryId);
      if (!target) return current;
      const targetIndex = beforeChannelId ? target.indexOf(beforeChannelId) : -1;
      target.splice(targetIndex < 0 ? target.length : targetIndex, 0, channelId);
      const ordered = [
        ...current.categories.flatMap((category) => (buckets.get(category.id) ?? []).map((id) => ({ id, categoryId: category.id }))),
        ...uncategorized.map((id) => ({ id, categoryId: null })),
      ];
      return { ...current, channels: ordered.map((channel, position) => ({ ...channel, position })) };
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
    placeCategory,
    moveChannel,
    placeChannel,
    renameCategory,
    save,
    setChannelCategory,
  };
}
