import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FeaturesPage from './page';

vi.mock('@/components/Navbar', () => ({ default: () => <nav>Obelisk</nav> }));
vi.mock('@/components/Footer', () => ({ default: () => <footer /> }));
vi.mock('@/components/ShootingStars', () => ({ default: () => null }));

describe('FeaturesPage', () => {
  it('shows every comeback feature with a screenshot and working calls to action', () => {
    render(<FeaturesPage />);
    for (const title of ['Nostr relay-based groups', 'Voice messages', 'Sticker marketplace', 'Mobile PWA', 'Peer-to-peer video calls', 'Big calls with SFU', 'Nostr profile explorer']) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('img')).toHaveLength(7);
    expect(screen.getAllByRole('img').filter((image) => image.getAttribute('src')?.includes('voice-messages.png'))).toHaveLength(2);
    expect(screen.getAllByRole('img').filter((image) => image.getAttribute('src')?.includes('desktop-large-voice-channel-with-sfu-peer-trasmission-test.png'))).toHaveLength(2);
    expect(screen.getByText(/Choose which SFU server to use or host your own/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /open obelisk|launch the app/i })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'View source' })).toHaveAttribute('href', 'https://github.com/obelisk-app/obelisk');
  });
});
