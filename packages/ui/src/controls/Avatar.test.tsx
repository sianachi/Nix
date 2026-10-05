import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar, initialsOf } from './Avatar';

describe('Avatar', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('Grace Brewster Murray Hopper')).toBe('GH');
    expect(initialsOf('  plato ')).toBe('p');
    expect(initialsOf('')).toBe('?');
  });

  it('is decoration beside a visible name, and hidden from assistive technology', () => {
    const { container } = render(<Avatar name="Ada Lovelace" />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('names itself when it stands alone', () => {
    render(<Avatar name="Ada Lovelace" labelled />);

    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL');
  });
});
