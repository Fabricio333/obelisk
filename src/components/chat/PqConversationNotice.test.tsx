import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import PqConversationNotice from './PqConversationNotice';

describe('PqConversationNotice', () => {
  it('shows the secured state without a guide link', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqConversationNotice status="secured" guideHref="/guides/en/quantum-safe-dms" />
      </LocaleProvider>,
    );
    expect(screen.getByText('Quantum-ready')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the warning and links to the guide when not secured', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqConversationNotice status="not-secured" guideHref="/guides/en/quantum-safe-dms" />
      </LocaleProvider>,
    );
    expect(screen.getByText(/Not quantum-safe/i)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/guides/en/quantum-safe-dms');
  });

  it('styles the not-secured state as a warning, not muted info furniture', () => {
    render(
      <LocaleProvider initialLocale="en">
        <PqConversationNotice status="not-secured" guideHref="/guides/en/quantum-safe-dms" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('status')).toHaveClass('bg-yellow-500/10', 'border-yellow-500/40');
  });
});
