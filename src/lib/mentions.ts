import {
  shortNpub,
  extractMentionPubkeys,
  findNpubMentions,
  hexToNpub,
} from '@nostr-wot/data';
import { nip19 } from 'nostr-tools';

// Re-export so existing call sites keep working.
export { shortNpub, extractMentionPubkeys };

export interface MemberCustomRoleInfo {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  priority: number;
}

export interface MemberInfo {
  pubkey: string;
  displayName: string;
  picture?: string;
  role?: string; // base role: owner | admin | mod | member
  customRoles?: MemberCustomRoleInfo[];
  banner?: string;
  nip05?: string;
  about?: string;
  website?: string;
  lud16?: string;
  joinedAt?: string;
  // Prebuilt server bots surface as pseudo-members with these two fields.
  // Regular Nostr members always have isBot=false/undefined.
  isBot?: boolean;
  botType?: string;
  statusText?: string | null;
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; pubkey: string; displayName: string };

function findNprofileMentions(content: string) {
  const matches: Array<{ pubkey: string; raw: string; start: number; end: number }> = [];
  const pattern = /(?:nostr:)?nprofile1[023456789acdefghjklmnpqrstuvwxyz]+/gi;
  for (const match of content.matchAll(pattern)) {
    try {
      const decoded = nip19.decode(match[0].replace(/^nostr:/i, ''));
      if (decoded.type === 'nprofile') {
        matches.push({ pubkey: decoded.data.pubkey, raw: match[0], start: match.index, end: match.index + match[0].length });
      }
    } catch {}
  }
  return matches;
}

/**
 * Serialize a pubkey into a mention token for storage in message content.
 * Uses the legacy `nostr:npub1<64hex>` form (NOT bech32) so server-side
 * notification fan-out and existing stored messages stay compatible.
 */
export function serializeMention(pubkey: string): string {
  return `nostr:npub1${pubkey}`;
}

/**
 * Parse message content into segments of text and mentions.
 */
export function parseMentions(content: string, members: MemberInfo[]): MentionSegment[] {
  const memberMap = new Map(members.map(m => [m.pubkey, m]));
  const segments: MentionSegment[] = [];
  const matches = [...findNpubMentions(content), ...findNprofileMentions(content)].sort((a, b) => a.start - b.start);
  let lastIndex = 0;

  for (const m of matches) {
    if (m.start > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, m.start) });
    }
    const member = memberMap.get(m.pubkey);
    segments.push({
      type: 'mention',
      pubkey: m.pubkey,
      displayName: member?.displayName || shortNpub(m.pubkey),
    });
    lastIndex = m.end;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', text: content.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', text: content });
  }

  return segments;
}

// Matches the literal `@everyone` when it isn't embedded inside another
// word or email-like token. Used by parser + renderer + server fan-out.
const EVERYONE_REGEX = /(?<![\w@])@everyone(?![\w.])/;
const EVERYONE_REGEX_GLOBAL = /(?<![\w@])@everyone(?![\w.])/g;

export { EVERYONE_REGEX_GLOBAL };

/**
 * Does this message contain an `@everyone` broadcast token?
 *
 * Returns true only when the token stands on its own — not inside words
 * (`@everyones`), identifiers (`foo@everyone`), or domain-like strings
 * (`@everyone.com`). The server uses this to decide whether to fan out
 * notifications to all members; gated on the author's role separately.
 */
export function hasEveryoneMention(content: string): boolean {
  return EVERYONE_REGEX.test(content);
}

/**
 * Extract the unique set of mentioned pubkeys (hex) for a full message —
 * combines `extractMentionPubkeys(content)` with any `["p", <hex>]` tags.
 *
 * NIP-29 group messages routinely carry `#p` tags for their mention targets
 * (some clients tag without inlining a token in content; others do both).
 * Using only the content regex misses the tag-only case, so the read-state
 * "channel has mention" selector and the inbox push at ingest both feed
 * through this helper.
 *
 * Hex tag values are lowercased; values that aren't 64-char hex are
 * silently dropped.
 */
export function extractMentionPubkeysFromMessage(
  content: string,
  tags: ReadonlyArray<ReadonlyArray<string>>,
): string[] {
  const found = new Set<string>(extractMentionPubkeys(content));
  for (const t of tags) {
    if (t[0] === 'p' && typeof t[1] === 'string' && /^[a-f0-9]{64}$/i.test(t[1])) {
      found.add(t[1].toLowerCase());
    }
  }
  return [...found];
}

/**
 * Transform canonical message content (containing `nostr:npub1<hex>` or
 * bech32 mention tokens) into a human-friendly form suitable for a textarea:
 * each mention becomes `@DisplayName` (or `@npub1abc…` for unknown members).
 *
 * Collisions are disambiguated with a `#N` suffix, starting at `#2`. The
 * caller gets back a `Map<displayToken, canonicalToken>` that must be passed
 * to `displayTokensToContent` on submit to reconstruct the canonical form.
 */
export function contentToDisplayTokens(
  content: string,
  members: MemberInfo[],
): { display: string; map: Map<string, string> } {
  const memberMap = new Map(members.map((m) => [m.pubkey, m]));
  const nameUsage = new Map<string, number>();
  const map = new Map<string, string>();

  let display = '';
  let lastIndex = 0;
  for (const m of findNpubMentions(content)) {
    display += content.slice(lastIndex, m.start);

    const member = memberMap.get(m.pubkey);
    const baseName = member?.displayName || shortNpub(m.pubkey);
    const count = (nameUsage.get(baseName) || 0) + 1;
    nameUsage.set(baseName, count);
    const displayToken = count === 1 ? `@${baseName}` : `@${baseName}#${count}`;

    map.set(displayToken, serializeMention(m.pubkey));
    display += displayToken;

    lastIndex = m.end;
  }

  display += content.slice(lastIndex);
  return { display, map };
}

/**
 * Reverse of `contentToDisplayTokens`: replace each `@DisplayName` token from
 * the map with the canonical `nostr:npub1<hex>` form so the payload the server
 * receives matches the historical format.
 *
 * Longer tokens are replaced first so that `@Alice#2` is not clobbered by an
 * earlier `@Alice` replacement.
 */
export function displayTokensToContent(
  display: string,
  map: Map<string, string>,
): string {
  if (map.size === 0) return display;
  const tokens = [...map.keys()].sort((a, b) => b.length - a.length);
  let result = display;
  for (const token of tokens) {
    const raw = map.get(token)!;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), raw);
  }
  return result;
}

/**
 * Filter members by query string (matches displayName or pubkey prefix).
 */
export function filterMembers(members: MemberInfo[], query: string): MemberInfo[] {
  const q = query.toLowerCase();
  return members.filter(m =>
    m.displayName.toLowerCase().includes(q) ||
    m.pubkey.toLowerCase().startsWith(q)
  );
}

/**
 * Build the deduped set of mentionable pubkeys for a relay by unioning the
 * members, admins, and creator of every supplied group. The mention
 * autocomplete uses this so `@`-mentions reach anyone on the relay, not just
 * the current channel's roster — typing `@alice` finds Alice even if she's
 * only in a sister channel.
 *
 * `groupIds` is intentionally explicit (not derived from the maps) so the
 * caller can pass the WoT-filtered visible groups from `useGroups()`. That
 * keeps spam-channel rolls out of the autocomplete when WoT is enabled.
 */
export function relayMentionCandidates(
  groupIds: ReadonlyArray<string>,
  membersByGroup: Readonly<Record<string, ReadonlyArray<string>>>,
  adminsByGroup: Readonly<Record<string, ReadonlyArray<string>>>,
  creatorsByGroup: Readonly<Record<string, string>>,
): string[] {
  const set = new Set<string>();
  for (const id of groupIds) {
    for (const pk of membersByGroup[id] ?? []) set.add(pk);
    for (const pk of adminsByGroup[id] ?? []) set.add(pk);
    const creator = creatorsByGroup[id];
    if (creator) set.add(creator);
  }
  return Array.from(set);
}

/**
 * Detect an in-progress `@`-mention query at the cursor. Returns the partial
 * username typed after the most recent `@` (possibly empty), or `null` when
 * the cursor is not currently sitting in a mention slot.
 *
 * Matches `@` at start-of-input or after whitespace so emails/handles inside
 * words don't trigger the popup. Word characters only — once the user types
 * anything else, the slot closes.
 */
export function detectMentionQuery(value: string, cursor: number): string | null {
  const before = value.slice(0, cursor);
  const m = before.match(/(?:^|\s)@(\w*)$/);
  return m ? m[1] : null;
}

/**
 * A mention the composer is holding as readable `@Name` text, plus the
 * pubkey it must be turned back into before the event is published.
 */
export interface DraftMention {
  /** Exact literal inserted into the draft, e.g. `@Fabricio Acosta`. */
  readonly token: string;
  readonly pubkey: string;
}

/**
 * Insert a mention at `cursor`, replacing the in-progress `@query` slot if
 * one is open. Returns the new draft, the caret position after the inserted
 * token, and — for prose mentions — the {@link DraftMention} the caller must
 * keep so {@link resolveDraftMentions} can restore the npub at send time.
 *
 * Two token shapes, deliberately:
 *
 * - **Prose** (`displayName` given, no `slotRange`) inserts `@Display Name`.
 *   A composer is a plain `<input>` and cannot render a chip, so pasting a
 *   63-character `nostr:npub1…` into the middle of a sentence is the only
 *   thing the user would see. They type prose; they should read prose.
 * - **Slash-command slot** (`slotRange` given) keeps `nostr:npub1…`. Those
 *   slots are machine-parsed and whitespace-tokenized by
 *   `SlashCommandScaffold`, so a display name containing a space would split
 *   into two arguments and the command would resolve the wrong user.
 *
 * `slotRange` is the absolute char range of the slot's existing token.
 * Without it a partial name typed into the slot would be left in place and
 * the token appended after it — `/zap dum nostr:npub…`, which the parser
 * rejects as an unknown user.
 */
export function applyMentionToDraft(
  draft: string,
  cursor: number,
  pubkey: string,
  opts?: {
    displayName?: string | null;
    slotRange?: { start: number; end: number } | null;
  },
): { next: string; cursor: number; mention: DraftMention | null } {
  const slotRange = opts?.slotRange ?? null;
  const displayName = opts?.displayName ?? null;
  // Slash slots must stay machine-readable; prose gets the readable form.
  const useProse = !slotRange && !!displayName;
  const bare = useProse ? `@${displayName}` : `nostr:${hexToNpub(pubkey)}`;
  const token = `${bare} `;
  const mention: DraftMention | null = useProse ? { token: bare, pubkey } : null;

  if (slotRange) {
    const replaced = draft.slice(0, slotRange.start) + token + draft.slice(slotRange.end);
    return { next: replaced, cursor: slotRange.start + token.length, mention };
  }

  const before = draft.slice(0, cursor);
  const after = draft.slice(cursor);
  let replaced: string;
  if (/@(\w*)$/.test(before)) {
    replaced = before.replace(/@(\w*)$/, () => token);
  } else {
    const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    replaced = before + sep + token;
  }
  return { next: replaced + after, cursor: replaced.length, mention };
}

/**
 * Turn the composer's readable `@Name` tokens back into `nostr:npub1…`
 * immediately before publishing.
 *
 * This has to happen: `#p` tags and mention notifications are both derived
 * from `nostr:` tokens in the event content (see
 * `extractMentionPubkeysFromMessage`), and every other Nostr client needs
 * the NIP-19 form to link the mention at all.
 *
 * Longest token first, so `@Fab` cannot eat the prefix of `@Fabricio`.
 * Replacement is literal, not regex, so names containing `.` `(` `+` etc.
 * are safe. A token the user has since edited simply no longer matches and
 * is left as written — the mention degrades to plain text rather than
 * resolving to the wrong person.
 */
export function resolveDraftMentions(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
): string {
  if (mentions.length === 0) return text;
  const seen = new Set<string>();
  const ordered = [...mentions]
    .filter((m) => {
      const key = `${m.token} ${m.pubkey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.token.length - a.token.length);

  let out = text;
  for (const m of ordered) {
    if (!out.includes(m.token)) continue;
    // split/join is a literal replace-all — no regex escaping to get wrong.
    out = out.split(m.token).join(`nostr:${hexToNpub(m.pubkey)}`);
  }
  return out;
}
