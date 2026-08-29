import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SlashCommandAutocomplete, { SLASH_COMMANDS } from './SlashCommandAutocomplete';
import { gameCatalog } from '@/lib/games/catalog';

describe('/play command', () => {
  const play = SLASH_COMMANDS.find((c) => c.name === 'play')!;

  it('names every playable game, not just one of them', () => {
    for (const game of gameCatalog()) {
      expect(play.description).toContain(game.displayName);
    }
    expect(gameCatalog().length).toBeGreaterThan(1);
  });

  it('does not claim the picker only opens Chain Reaction', () => {
    expect(play.description).not.toMatch(/^Open a Chain Reaction/);
  });

  it('shows that description in the autocomplete', () => {
    render(
      <SlashCommandAutocomplete
        commands={[play]}
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('slash-option')).toHaveTextContent('Vesta');
    expect(screen.getByTestId('slash-option')).toHaveTextContent('Chain Reaction');
  });
});
