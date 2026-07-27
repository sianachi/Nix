import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Blueprint } from './Blueprint';

describe('Blueprint', () => {
  it('renders its content inside a hairline frame', () => {
    const { container } = render(
      <Blueprint>
        <p>Contract draft</p>
      </Blueprint>,
    );

    const frame = container.firstElementChild;
    expect(frame?.className).toContain('border-divider');
    expect(frame).toHaveTextContent('Contract draft');
  });

  it('turns its corner on the scale, with no way to ask for a different radius', () => {
    const { container } = render(<Blueprint />);

    // A token step rather than a literal: the radius is a themed value like the border colour, and
    // a caller passing `rounded-xl` through className would be restyling the frame's contract.
    expect(container.firstElementChild?.className).toContain('rounded-md');
    expect(container.firstElementChild?.className).not.toMatch(/rounded-\[/);
  });

  it('draws no decoration of its own', () => {
    const { container } = render(<Blueprint />);

    // It used to draw four "+" registration marks straddling the corners. They went when the
    // corners rounded: a crosshair registers a corner, so on a curve it sits beside the thing it
    // is pointing at. See ADR-0011.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it('leaves the accessibility tree to its content', () => {
    const { container } = render(
      <Blueprint>
        <button type="button">Open</button>
      </Blueprint>,
    );

    // The only thing a screen reader or a pointer finds is the content.
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    for (const mark of container.querySelectorAll('[aria-hidden="true"]')) {
      expect(mark.className).toContain('pointer-events-none');
    }
  });

  it('carries no surface fill: a card is a line drawing', () => {
    const { container } = render(<Blueprint />);

    expect(container.firstElementChild?.className).not.toMatch(/(^|\s)bg-/);
  });

  it('accepts a layout class without losing the frame', () => {
    const { container } = render(<Blueprint className="w-full" />);

    const className = container.firstElementChild?.className ?? '';
    expect(className).toContain('w-full');
    expect(className).toContain('border-divider');
  });
});
