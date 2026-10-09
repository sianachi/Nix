import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Input } from './Input';

describe('Input', () => {
  it('is a text box by default', () => {
    render(<Input aria-label="Title" />);

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveAttribute('type', 'text');
  });

  it('accepts typing and reports every keystroke', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="Title" onChange={onChange} />);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Notes');

    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('is reachable and focusable by keyboard', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Title" />);

    await user.tab();

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });

  it('cannot be typed into when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="Title" disabled onChange={onChange} />);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Notes');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports invalidity through aria-invalid so it is announced, not only drawn', () => {
    render(<Input aria-label="Title" aria-invalid />);

    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInvalid();
  });

  it('turns the same corner in every tone', () => {
    const { rerender } = render(<Input aria-label="Title" />);
    expect(screen.getByRole('textbox', { name: 'Title' }).className).toContain('rounded-md');

    rerender(<Input aria-label="Title" tone="plain" />);
    expect(screen.getByRole('textbox', { name: 'Title' }).className).toContain('rounded-md');
  });

  it('uses the touch height and readable type when any pointer is coarse', () => {
    render(<Input aria-label="Title" />);

    const className = screen.getByRole('textbox', { name: 'Title' }).className;
    expect(className).toContain('h-(--control-md)');
    expect(className).toContain('any-pointer-coarse:h-(--control-lg)');
    expect(className).toContain('any-pointer-coarse:text-lg');
    expect(className).toContain('min-w-0');
  });

  it('draws focus as one ring flush with the field, not a halo offset from it', () => {
    render(<Input aria-label="Title" />);

    const className = screen.getByRole('textbox', { name: 'Title' }).className;
    // An offset ring around a framed field reads as a second frame: a box inside a box.
    expect(className).toContain('focus-visible:outline-offset-0');
    expect(className).toContain('focus-visible:border-accent');
    expect(className).not.toContain('focus-visible:outline-offset-2');
  });
});
