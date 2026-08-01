import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MediaThumb from './MediaThumb';

describe('MediaThumb', () => {
  it('renders the media and reports loads', () => {
    const onLoad = vi.fn();
    render(<MediaThumb src="https://cdn.example/party.gif" alt=":party:" className="h-8 w-8" onLoad={onLoad} />);

    const image = screen.getByAltText(':party:');
    expect(image).toHaveAttribute('src', 'https://cdn.example/party.gif');
    expect(image).toHaveClass('h-8', 'w-8');
    fireEvent.load(image);
    expect(onLoad).toHaveBeenCalled();
  });

  it('swaps a broken source for a glyph instead of painting its name', () => {
    const onError = vi.fn();
    const { container } = render(<MediaThumb src="https://cdn.example/gone.gif" alt=":party_cat:" onError={onError} />);

    fireEvent.error(screen.getByAltText(':party_cat:'));

    expect(onError).toHaveBeenCalled();
    expect(screen.queryByAltText(':party_cat:')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(':party_cat:');
    const fallback = screen.getByTestId('media-thumb-fallback');
    expect(fallback).toHaveAccessibleName(':party_cat:');
    expect(fallback.querySelector('svg')).toBeInTheDocument();
  });

  it('hides the fallback from assistive tech for decorative media', () => {
    render(<MediaThumb src="https://cdn.example/gone.webp" alt="" />);

    fireEvent.error(screen.getByRole('presentation'));

    const fallback = screen.getByTestId('media-thumb-fallback');
    expect(fallback).toHaveAttribute('aria-hidden', 'true');
    expect(fallback).not.toHaveAttribute('title');
  });
});
