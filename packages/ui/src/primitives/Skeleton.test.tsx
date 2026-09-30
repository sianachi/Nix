import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton, SkeletonLines } from './Skeleton';

describe('Skeleton', () => {
  it('is decoration only, hidden from assistive technology', () => {
    const { container } = render(<Skeleton className="w-24" />);

    const shape = container.firstElementChild;
    expect(shape).toHaveAttribute('aria-hidden', 'true');
    expect(shape).toHaveClass('w-24', 'animate-pulse', 'motion-reduce:animate-none');
  });

  it('draws lines of prose while announcing what is loading', () => {
    const { container } = render(<SkeletonLines label="Loading the note" lines={3} heading />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading the note');
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });
});
