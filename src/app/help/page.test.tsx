import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/context';
import HelpPage from './page';

vi.mock('@/components/Navbar', () => ({ default: () => <nav>Obelisk</nav> }));
vi.mock('@/components/Footer', () => ({ default: () => <footer /> }));

describe('HelpPage', () => {
  it('links each help topic and the guide index in the active locale', () => {
    render(
      <LocaleProvider initialLocale="es">
        <HelpPage />
      </LocaleProvider>,
    );

    expect(screen.getByRole('heading', { name: '¿Cómo podemos ayudarte?' })).toBeInTheDocument();
    expect(screen.getByTestId('help-topic-what-is-obelisk')).toHaveAttribute(
      'href',
      '/guides/es/what-is-obelisk',
    );
    expect(screen.getByRole('link', { name: 'Ver todas las guías →' })).toHaveAttribute(
      'href',
      '/guides/es',
    );
  });
});
