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
  // `autocomplete="off"` on its own is read by several Android IMEs
  // (Gboard, SwiftKey) as "sensitive field": they drop suggestions, the
  // emoji key, and personalised learning — which is precisely what a
  // password field looks like from the user's side. Asserting the prose
  // behaviours positively cancels that inference. These are the defaults
  // for a text input, but stating them beats leaving the keyboard to
  // guess from a field we have just told to skip autofill.
  inputMode: 'text',
  autoCorrect: 'on',
  autoCapitalize: 'sentences',
  spellCheck: true,
  'data-1p-ignore': '',        // 1Password
  'data-lpignore': 'true',     // LastPass
  'data-bwignore': 'true',     // Bitwarden
  'data-form-type': 'other',   // Dashlane
} as InputHTMLAttributes<HTMLInputElement>;
