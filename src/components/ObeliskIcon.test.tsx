import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import ObeliskIcon from './ObeliskIcon';

describe('ObeliskIcon', () => {
  it('draws the mark as a silhouette with the left face cut out', () => {
    const { container } = render(<ObeliskIcon />);
    const svg = container.querySelector('svg')!;
    const path = svg.querySelector('path')!;

    // evenodd + a second subpath is what makes the slim left face hollow the
    // way the shipped icon and favicon do; a single filled subpath would put
    // the deprecated solid-face artwork back.
    expect(svg).toHaveAttribute('fill-rule', 'evenodd');
    expect(path.getAttribute('d')!.match(/M /g)).toHaveLength(2);
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('passes styling through to the svg', () => {
    const { container } = render(<ObeliskIcon className="w-12 text-lc-green" />);
    expect(container.querySelector('svg')).toHaveClass('w-12', 'text-lc-green');
  });
});
