import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import PqMessageMark from './PqMessageMark';

describe('PqMessageMark', () => {
  it('renders nothing for a healthy message', () => {
    const { container } = render(
      <LocaleProvider initialLocale="en">
        <PqMessageMark mark={null} />
      </LocaleProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('exposes the gift-wrap detail via title and aria-label, not just title', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqMessageMark mark="no-giftwrap" />
      </LocaleProvider>,
    );
    const mark = screen.getByTestId('pq-mark');
    // Plain language on purpose: "relays" is jargon to everyone outside Nostr,
    // and this string is aimed at a reader who has never heard the word.
    const detail = 'The servers that carried this message could see who you were talking to.';
    expect(mark).toHaveAttribute('title', detail);
    expect(mark).toHaveAttribute('aria-label', expect.stringContaining(detail));
  });

  it('exposes a detail for the no-pq mark too', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqMessageMark mark="no-pq" />
      </LocaleProvider>,
    );
    const mark = screen.getByTestId('pq-mark');
    expect(mark.getAttribute('title')).toBeTruthy();
    expect(mark.getAttribute('aria-label')).toBeTruthy();
  });

  it('defaults to the muted color', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqMessageMark mark="no-pq" />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('pq-mark')).toHaveClass('text-lc-muted');
  });

  it('switches to the on-accent color for outgoing bubbles', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqMessageMark mark="no-pq" onAccent />
      </LocaleProvider>,
    );
    const mark = screen.getByTestId('pq-mark');
    expect(mark).toHaveClass('text-black/60');
    expect(mark).not.toHaveClass('text-lc-muted');
  });
});
