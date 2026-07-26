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

  it('is square-cornered, with no way to ask for a radius', () => {
    const { container } = render(<Blueprint />);

    expect(container.firstElementChild?.className).toContain('rounded-none');
  });

  it('draws four registration marks', () => {
    const { container } = render(<Blueprint />);

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('keeps the registration marks out of the accessibility tree and out of pointer events', () => {
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
