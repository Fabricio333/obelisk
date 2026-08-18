import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { LocaleProvider } from '@/i18n/context';
import Footer from './Footer';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe('Footer', () => {
  it('renders the 4 guide links using the context locale', () => {
    render(
      <LocaleProvider initialLocale="en">
        <Footer />
      </LocaleProvider>,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('/guides/what-is-obelisk');
    expect(links).toContain('/guides/how-obelisk-works');
    expect(links).toContain('/guides/web-of-trust');
    expect(links).toContain('/guides/future-nostr-relays');
    expect(links).toContain('/guides');
  });

  it('respects localeOverride prop for URL-localized pages', () => {
    render(
      <LocaleProvider initialLocale="en">
        <Footer localeOverride="es" />
      </LocaleProvider>,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('/guides/es/what-is-obelisk');
    expect(links).not.toContain('/guides/what-is-obelisk');
    expect(links).toContain('/guides/es');
  });

  it('includes product, community, legal, and FAQ links', () => {
    render(
      <LocaleProvider initialLocale="en">
        <Footer />
      </LocaleProvider>,
    );
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toContain('/app');
    expect(links).toContain('/#faq');
    expect(links).toContain('/help');
    expect(links).toContain('https://github.com/obelisk-app/obelisk');
    expect(links).toContain('https://lacrypta.ar');
    expect(links).toContain('https://github.com/obelisk-app/obelisk/blob/main/LICENSE');
    expect(links).toContain('https://github.com/obelisk-app/obelisk/blob/main/ABUSE.md');
    expect(links).toContain('https://github.com/obelisk-app/obelisk/blob/main/SECURITY.md');
    expect(screen.getByText(/© \d{4} Fabricio Acosta · AGPL-3.0/)).toBeInTheDocument();
  });
});
