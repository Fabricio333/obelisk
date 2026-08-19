import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import PqShield from './PqShield';
import type { PqProtectionLevel } from '@/lib/pq/status';

function renderShield(level: PqProtectionLevel, locale: 'en' | 'es' = 'en') {
  return render(
    <LocaleProvider initialLocale={locale}>
      <PqShield level={level} guideHref="/guides/quantum-safe-dms" />
    </LocaleProvider>,
  );
}

describe('PqShield', () => {
  it('renders a single control per level, not a banner', () => {
    // The whole point of replacing the notice: one small control in the
    // header, no standing block of text above the conversation.
    for (const level of ['quantum', 'wrapped', 'basic'] as const) {
      const { unmount } = renderShield(level);
      expect(screen.getByTestId('pq-shield')).toHaveAttribute('data-level', level);
      unmount();
    }
  });

  it('keeps the explanation reachable without hover, via aria-label', () => {
    // The panel only exists while open, so a user who never hovers would
    // otherwise get an unlabelled icon button.
    renderShield('wrapped');
    expect(screen.getByTestId('pq-shield')).toHaveAttribute(
      'aria-label',
      'Safe. Your messages are locked, and nobody can see who you are talking to. One day a quantum computer could open them, though.',
    );
  });

  it('stays closed until asked', () => {
    renderShield('basic');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on click, which is the only route a touch user has', () => {
    renderShield('basic');
    fireEvent.click(screen.getByTestId('pq-shield'));
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Basic');
    expect(panel).toHaveTextContent('the servers that carry them can see who you are talking to');
  });

  it('closes again on a second click', () => {
    renderShield('basic');
    const button = screen.getByTestId('pq-shield');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape', () => {
    renderShield('wrapped');
    fireEvent.click(screen.getByTestId('pq-shield'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('offers the guide when protection is short of quantum', () => {
    for (const level of ['wrapped', 'basic'] as const) {
      const { unmount } = renderShield(level);
      fireEvent.click(screen.getByTestId('pq-shield'));
      expect(screen.getByRole('link', { name: 'How to get extra safe' })).toHaveAttribute(
        'href',
        '/guides/quantum-safe-dms',
      );
      unmount();
    }
  });

  it('does not nag the user who already has quantum protection', () => {
    renderShield('quantum');
    fireEvent.click(screen.getByTestId('pq-shield'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Extra safe');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('speaks Spanish, in the voseo the rest of the product uses', () => {
    renderShield('basic', 'es');
    fireEvent.click(screen.getByTestId('pq-shield'));
    const panel = screen.getByRole('tooltip');
    expect(panel).toHaveTextContent('Básico');
    expect(panel).toHaveTextContent('con quién hablás');
  });
});
