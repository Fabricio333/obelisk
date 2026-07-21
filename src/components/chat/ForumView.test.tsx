import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { JsGroup, JsMessage, JsForumTag } from '@/lib/nostr-bridge';
import ForumView from './ForumView';

// -- Bridge mocks ---------------------------------------------------------
// The bridge surface is large, so we use module-scoped mocks updated per
// test. Each ForumView test sets up the forum container, its children, and
// the per-child messages map before rendering.

let mockGroups: JsGroup[] = [];
let mockChildrenByParent: Record<string, string[]> = {};
let mockMessagesByGroup: Record<string, JsMessage[]> = {};
let mockGroupMetadataEose = true;
// Default to 'empty-confirmed' so empty-thread cards behave the same way
// they used to under `mockMessagesEoseByGroup.get(id) ?? true` (i.e. the
// "EOSE has arrived" default). Override per-test if you need to render a
// skeleton state ('loading' | 'empty-unconfirmed').
const mockMessagesStatusByGroup = new Map<string, 'loading' | 'empty-unconfirmed' | 'empty-confirmed' | 'has-messages'>();

const mockCreateGroup = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('@/lib/nostr-bridge', () => ({
  useGroups: () => mockGroups,
  useChildrenByParent: () => mockChildrenByParent,
  useGroupMetadataEose: () => mockGroupMetadataEose,
  useMessagesByGroup: () => mockMessagesByGroup,
  useMessages: (groupId: string) => mockMessagesByGroup[groupId] ?? [],
  useMessagesStatus: (groupId: string) =>
    mockMessagesStatusByGroup.get(groupId) ?? 'empty-confirmed',
  useSignerReady: () => true,
  useMyPubkey: () => 'a'.repeat(64),
  useUserMetadata: () => null,
  nostrActions: {
    createGroup: (...a: unknown[]) => mockCreateGroup(...a),
    sendMessage: (...a: unknown[]) => mockSendMessage(...a),
  },
}));

function makeForum(opts: {
  id: string;
  name?: string;
  forumTags?: ReadonlyArray<JsForumTag>;
}): JsGroup {
  return {
    id: opts.id,
    name: opts.name ?? 'plaza',
    about: null,
    picture: null,
    banner: null,
    isPublic: true,
    isOpen: true,
    parent: null,
    kind: 'forum',
    forumTags: opts.forumTags ?? [],
    topics: [],
  };
}

function makeThread(opts: {
  id: string;
  name: string;
  parent: string;
  topics?: ReadonlyArray<string>;
}): JsGroup {
  return {
    id: opts.id,
    name: opts.name,
    about: null,
    picture: null,
    banner: null,
    isPublic: true,
    isOpen: true,
    parent: opts.parent,
    kind: 'text',
    forumTags: [],
    topics: opts.topics ?? [],
  };
}

function makeMsg(opts: {
  id: string;
  content: string;
  createdAt?: number;
  pubkey?: string;
}): JsMessage {
  return {
    id: opts.id,
    pubkey: opts.pubkey ?? 'b'.repeat(64),
    content: opts.content,
    createdAt: opts.createdAt ?? 1700_000_000,
    kind: 9,
    replyToId: null,
    mentions: [],
  };
}

beforeEach(() => {
  mockGroups = [];
  mockChildrenByParent = {};
  mockMessagesByGroup = {};
  mockGroupMetadataEose = true;
  mockMessagesStatusByGroup.clear();
  mockCreateGroup.mockReset();
  mockSendMessage.mockReset();
  if (typeof window !== 'undefined') window.localStorage.clear();
});

describe('ForumView chrome', () => {
  const onSelectThread = vi.fn();
  beforeEach(() => {
    onSelectThread.mockReset();
  });

  it('renders the forum tag chips from forum.forumTags', () => {
    const forum = makeForum({
      id: 'forum-1',
      forumTags: [
        { id: 'tag-a', name: 'LaCrypta', emoji: '📜' },
        { id: 'tag-b', name: 'trabajo', emoji: null },
      ],
    });
    mockGroups = [forum];

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);

    expect(screen.getByTestId('forum-tag-tag-a')).toBeTruthy();
    expect(screen.getByTestId('forum-tag-tag-b')).toBeTruthy();
    // The "All" chip is active by default (no tag selected).
    expect(screen.getByTestId('forum-tag-all').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders only the trailing "All" chip when the forum has no curated tags', () => {
    const forum = makeForum({ id: 'forum-empty', forumTags: [] });
    mockGroups = [forum];

    render(<ForumView groupId="forum-empty" onSelectThread={onSelectThread} />);

    expect(screen.queryByTestId('forum-tag-tag-a')).toBeNull();
    expect(screen.getByTestId('forum-tag-all')).toBeTruthy();
  });

  it('Sort & view menu opens, exposes the four radio sets, and closes via Reset', () => {
    mockGroups = [makeForum({ id: 'forum-1' })];

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    expect(screen.queryByTestId('forum-sortview-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    expect(screen.getByTestId('forum-sortview-menu')).toBeTruthy();
    // Defaults: Recently active, List, Match any.
    expect(screen.getByTestId('forum-sort-recent').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-view-list').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-match-any').getAttribute('data-checked')).toBe('true');
    // Switching to Gallery + Match all + Creation date should be reflected.
    fireEvent.click(screen.getByTestId('forum-view-gallery'));
    fireEvent.click(screen.getByTestId('forum-match-all'));
    fireEvent.click(screen.getByTestId('forum-sort-created'));
    expect(screen.getByTestId('forum-view-gallery').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-match-all').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-sort-created').getAttribute('data-checked')).toBe('true');
    // Reset returns to defaults.
    fireEvent.click(screen.getByTestId('forum-sortview-reset'));
    expect(screen.getByTestId('forum-sort-recent').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-view-list').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('forum-match-any').getAttribute('data-checked')).toBe('true');
  });

  it('persists view preferences to localStorage per forum id', () => {
    mockGroups = [makeForum({ id: 'forum-1' })];

    const { unmount } = render(
      <ForumView groupId="forum-1" onSelectThread={onSelectThread} />,
    );
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    fireEvent.click(screen.getByTestId('forum-view-gallery'));
    unmount();

    // Same forum on remount → gallery sticks.
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    expect(screen.getByTestId('forum-view-gallery').getAttribute('data-checked')).toBe('true');
  });
});

describe('ForumView thread filtering & sorting', () => {
  const onSelectThread = vi.fn();
  beforeEach(() => {
    onSelectThread.mockReset();
    // Standard fixture: forum with 3 tags, 4 threads:
    //   - thread-old (tag-a) — first activity old
    //   - thread-mid (tag-b) — middle activity
    //   - thread-new (tag-a, tag-b) — most recent activity
    //   - thread-untagged (no tags)
    const forum = makeForum({
      id: 'forum-1',
      forumTags: [
        { id: 'tag-a', name: 'tagA', emoji: null },
        { id: 'tag-b', name: 'tagB', emoji: null },
        { id: 'tag-c', name: 'tagC', emoji: null },
      ],
    });
    const t1 = makeThread({ id: 'thread-old', name: 'older thread', parent: 'forum-1', topics: ['tag-a'] });
    const t2 = makeThread({ id: 'thread-mid', name: 'middle thread', parent: 'forum-1', topics: ['tag-b'] });
    const t3 = makeThread({ id: 'thread-new', name: 'newest thread', parent: 'forum-1', topics: ['tag-a', 'tag-b'] });
    const t4 = makeThread({ id: 'thread-untagged', name: 'untagged thread', parent: 'forum-1' });
    mockGroups = [forum, t1, t2, t3, t4];
    mockChildrenByParent = { 'forum-1': [t1.id, t2.id, t3.id, t4.id] };
    mockMessagesByGroup = {
      'thread-old': [makeMsg({ id: 'm-old-1', content: 'old', createdAt: 100 })],
      'thread-mid': [makeMsg({ id: 'm-mid-1', content: 'mid', createdAt: 500 })],
      'thread-new': [makeMsg({ id: 'm-new-1', content: 'new', createdAt: 1000 })],
      'thread-untagged': [makeMsg({ id: 'm-u-1', content: 'untagged', createdAt: 750 })],
    };
  });

  it('renders every thread by default, sorted by most-recent activity', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    const cards = screen.getAllByTestId('thread-card');
    expect(cards.map((c) => c.getAttribute('data-thread-id'))).toEqual([
      'thread-new',
      'thread-untagged',
      'thread-mid',
      'thread-old',
    ]);
  });

  it('search input filters thread cards by title (case-insensitive substring)', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.change(screen.getByTestId('forum-search-input'), { target: { value: 'NEW' } });
    const cards = screen.getAllByTestId('thread-card');
    expect(cards.map((c) => c.getAttribute('data-thread-id'))).toEqual(['thread-new']);
  });

  it('with no exact match, search shows a "Create" CTA prefilled with the query', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.change(screen.getByTestId('forum-search-input'), {
      target: { value: 'something completely new' },
    });
    const create = screen.getByTestId('forum-create-from-search');
    expect(create.textContent).toContain('something completely new');
  });

  it('clicking a tag chip filters threads to those carrying that topic (match-any)', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-tag-tag-a'));
    const cards = screen.getAllByTestId('thread-card');
    expect(cards.map((c) => c.getAttribute('data-thread-id')).sort()).toEqual([
      'thread-new',
      'thread-old',
    ]);
  });

  it('match-all narrows to threads carrying every selected tag', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    fireEvent.click(screen.getByTestId('forum-match-all'));
    fireEvent.click(screen.getByTestId('forum-tag-tag-a'));
    fireEvent.click(screen.getByTestId('forum-tag-tag-b'));
    const cards = screen.getAllByTestId('thread-card');
    expect(cards.map((c) => c.getAttribute('data-thread-id'))).toEqual(['thread-new']);
  });

  it('"All" chip clears the active tag filter', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-tag-tag-a'));
    expect(screen.getAllByTestId('thread-card')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('forum-tag-all'));
    expect(screen.getAllByTestId('thread-card')).toHaveLength(4);
  });

  it('sort-by-creation reorders by first message createdAt (newest first)', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    fireEvent.click(screen.getByTestId('forum-sort-created'));
    const cards = screen.getAllByTestId('thread-card');
    // Same data set in this fixture since each thread has exactly one
    // message, so first.createdAt === last.createdAt. The ordering should
    // still be newest first.
    expect(cards.map((c) => c.getAttribute('data-thread-id'))).toEqual([
      'thread-new',
      'thread-untagged',
      'thread-mid',
      'thread-old',
    ]);
  });

  it('switching to gallery swaps the list for the grid (thread-gallery-card)', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-sortview-trigger'));
    fireEvent.click(screen.getByTestId('forum-view-gallery'));
    expect(screen.queryAllByTestId('thread-card')).toHaveLength(0);
    expect(screen.getAllByTestId('thread-gallery-card')).toHaveLength(4);
    expect(screen.getByTestId('forum-gallery')).toBeTruthy();
  });

  it('clicking a thread card calls onSelectThread with that group id', () => {
    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    const target = screen.getAllByTestId('thread-card').find((c) =>
      c.getAttribute('data-thread-id') === 'thread-new',
    )!;
    fireEvent.click(target);
    expect(onSelectThread).toHaveBeenCalledWith('thread-new');
  });
});

describe('ForumView empty / loading states', () => {
  const onSelectThread = vi.fn();
  beforeEach(() => onSelectThread.mockReset());

  it('shows "Loading threads…" until kind 39000 EOSE arrives', () => {
    mockGroups = [makeForum({ id: 'forum-1' })];
    mockChildrenByParent = {};
    mockGroupMetadataEose = false;

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    expect(screen.getByTestId('threads-loading')).toBeTruthy();
  });

  it('shows the "No matching threads" CTA with a create button when search misses', () => {
    const forum = makeForum({ id: 'forum-1' });
    const t = makeThread({ id: 't1', name: 'some thread', parent: 'forum-1' });
    mockGroups = [forum, t];
    mockChildrenByParent = { 'forum-1': [t.id] };
    mockMessagesByGroup = { t1: [makeMsg({ id: 'm1', content: 'hi' })] };

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.change(screen.getByTestId('forum-search-input'), {
      target: { value: 'nothing matches this' },
    });
    expect(screen.getByTestId('forum-no-matches')).toBeTruthy();
    expect(screen.getByTestId('forum-create-from-search')).toBeTruthy();
  });
});

describe('NewThreadModal tag picker', () => {
  const onSelectThread = vi.fn();
  beforeEach(() => onSelectThread.mockReset());

  it('opens the modal when the "New thread" button is clicked', () => {
    mockGroups = [
      makeForum({
        id: 'forum-1',
        forumTags: [
          { id: 'tag-a', name: 'tagA', emoji: '📜' },
          { id: 'tag-b', name: 'tagB', emoji: null },
        ],
      }),
    ];

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-new-thread-btn'));
    expect(screen.getByTestId('new-thread-modal')).toBeTruthy();
    const picker = screen.getByTestId('new-thread-tag-picker');
    expect(within(picker).getByTestId('new-thread-tag-tag-a')).toBeTruthy();
    expect(within(picker).getByTestId('new-thread-tag-tag-b')).toBeTruthy();
  });

  it('Enter on a no-match search prefills the modal title with the typed query', () => {
    mockGroups = [makeForum({ id: 'forum-1' })];

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    const input = screen.getByTestId('forum-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'cool new title' } });
    fireEvent.submit(input.closest('form')!);
    const title = screen.getByTestId('new-thread-title') as HTMLInputElement;
    expect(title.value).toBe('cool new title');
  });

  it('publishes selected topic ids when creating a thread', async () => {
    mockCreateGroup.mockResolvedValue('child-1');
    mockSendMessage.mockResolvedValue(undefined);
    mockGroups = [
      makeForum({
        id: 'forum-1',
        forumTags: [
          { id: 'tag-a', name: 'tagA', emoji: null },
          { id: 'tag-b', name: 'tagB', emoji: null },
        ],
      }),
    ];

    render(<ForumView groupId="forum-1" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId('forum-new-thread-btn'));
    fireEvent.change(screen.getByTestId('new-thread-title'), { target: { value: 'a' } });
    fireEvent.change(screen.getByTestId('new-thread-body'), { target: { value: 'b' } });
    fireEvent.click(screen.getByTestId('new-thread-tag-tag-b'));
    fireEvent.click(screen.getByTestId('new-thread-submit'));
    // Wait for the async submit handler to call createGroup.
    await screen.findByTestId('new-thread-modal'); // still mounted while submitting
    // microtask drain
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreateGroup).toHaveBeenCalledTimes(1);
    const args = mockCreateGroup.mock.calls[0][0];
    expect(args.parent).toBe('forum-1');
    expect(args.topics).toEqual(['tag-b']);
    expect(args.name).toBe('a');
  });
});
