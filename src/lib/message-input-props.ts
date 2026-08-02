import type { InputHTMLAttributes } from 'react';

/**
 * Attributes every message composer spreads onto its `<input>`.
 *
 * A bare, unnamed text input — especially a lone one inside a `<form>`,
 * which is what the desktop composer is — trips the heuristics password
 * managers and mobile keyboards use to spot credential fields. The result
 * is a chat box that offers to save a password, autofills a stored login,
 * or pops "Strong Password" over the conversation.
 *
 * There is no standard `autocomplete` token for "chat message", so this
 * works from both ends: name and type say what the field *is*, and the
 * vendor opt-out attributes say what it is *not*. Each `data-*` key below
 * is the documented ignore hook for one manager — they are mutually
 * unaware, so all four are needed to cover the common installs.
 *
 * `enterKeyHint` is here for the same reason: credential fields get a
 * "Go"/"Done" return key, message fields get "Send".
 */
export const MESSAGE_INPUT_PROPS = {
  type: 'text',
  name: 'message',
  autoComplete: 'off',
  enterKeyHint: 'send',
  'data-1p-ignore': '',        // 1Password
  'data-lpignore': 'true',     // LastPass
  'data-bwignore': 'true',     // Bitwarden
  'data-form-type': 'other',   // Dashlane
} as InputHTMLAttributes<HTMLInputElement>;
