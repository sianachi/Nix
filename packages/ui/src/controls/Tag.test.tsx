import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tag } from './Tag';

describe('Tag', () => {
  it('renders its text', () => {
    render(<Tag>Draft</Tag>);

    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('is never a filled accent object, in any tone', () => {
    // The one solid accent object on a screen is the primary button. A filled tag would compete
    // with the action the design wants read first.
    for (const tone of ['neutral', 'accent', 'muted'] as const) {
      const { unmount } = render(<Tag tone={tone}>Draft</Tag>);

      expect(screen.getByText('Draft').className).not.toContain('bg-accent-700');
      unmount();
    }
  });

  it('keeps square corners', () => {
    render(<Tag>Draft</Tag>);

    expect(screen.getByText('Draft').className).toContain('rounded-none');
  });

  it('can carry an accessible name of its own when the text is an abbreviation', () => {
    render(<Tag aria-label="Read only">RO</Tag>);

    expect(screen.getByLabelText('Read only')).toBeInTheDocument();
  });
});
