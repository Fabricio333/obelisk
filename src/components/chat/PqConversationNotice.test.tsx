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
    expect(screen.getByText(/Quantum-secured/i)).toBeInTheDocument();
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
});
