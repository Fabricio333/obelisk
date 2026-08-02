import { describe, it, expect } from 'vitest';
import { MESSAGE_INPUT_PROPS } from './message-input-props';

describe('MESSAGE_INPUT_PROPS', () => {
  it('declares what the field is, so heuristics stop guessing', () => {
    expect(MESSAGE_INPUT_PROPS.type).toBe('text');
    expect(MESSAGE_INPUT_PROPS.name).toBe('message');
    expect(MESSAGE_INPUT_PROPS.autoComplete).toBe('off');
  });

  it('never declares a credential type', () => {
    // The whole point: a composer must never look like a login field.
    expect(MESSAGE_INPUT_PROPS.type).not.toBe('password');
    expect(String(MESSAGE_INPUT_PROPS.autoComplete)).not.toMatch(/password/);
  });

  it('carries an opt-out hook for each major password manager', () => {
    const props = MESSAGE_INPUT_PROPS as Record<string, unknown>;
    // These four are mutually unaware — missing one means that manager
    // still offers to fill the chat box.
    expect(props['data-1p-ignore']).toBeDefined();     // 1Password
    expect(props['data-lpignore']).toBe('true');       // LastPass
    expect(props['data-bwignore']).toBe('true');       // Bitwarden
    expect(props['data-form-type']).toBe('other');     // Dashlane
  });

  it('asks the mobile keyboard for a Send key', () => {
    expect(MESSAGE_INPUT_PROPS.enterKeyHint).toBe('send');
  });
});
