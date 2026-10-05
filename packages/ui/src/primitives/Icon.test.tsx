import { render, screen } from '@testing-library/react';
import { Plus, Search } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { Icon, ICON_STROKE_WIDTH, type IconSize } from './Icon';

describe('Icon', () => {
  it('locks every glyph to the design system stroke width', () => {
    const { container } = render(<Icon icon={Plus} />);

    expect(container.querySelector('svg')).toHaveAttribute(
      'stroke-width',
      String(ICON_STROKE_WIDTH),
    );
  });

  it('hides a decorative glyph from assistive technology', () => {
    const { container } = render(<Icon icon={Plus} />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('exposes a labelled glyph as a named image', () => {
    render(<Icon icon={Search} label="Search" />);

    expect(screen.getByRole('img', { name: 'Search' })).toBeInTheDocument();
  });

  it.each<[IconSize, string]>([
    ['sm', '16'],
    ['md', '20'],
    ['lg', '24'],
  ])('renders the %s interface size at %spx', (size, px) => {
    const { container } = render(<Icon icon={Plus} size={size} />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', px);
    expect(svg).toHaveAttribute('height', px);
  });

  it('defaults to the medium interface size', () => {
    const { container } = render(<Icon icon={Plus} />);

    expect(container.querySelector('svg')).toHaveAttribute('width', '20');
  });
});
