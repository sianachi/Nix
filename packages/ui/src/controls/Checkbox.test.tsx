import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('is a checkbox named by its visible label', () => {
    render(<Checkbox label="Insert as inline link" />);

    expect(screen.getByRole('checkbox', { name: 'Insert as inline link' })).toBeInTheDocument();
  });

  it('renders unnamed when the caller supplies its own accessible name instead', () => {
    render(<Checkbox aria-label="Select row" />);

    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeInTheDocument();
  });

  it('is reachable and toggled from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Insert as inline link" />);

    await user.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();

    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('reports every change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Insert as inline link" onChange={onChange} />);

    await user.click(screen.getByRole('checkbox'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('cannot be toggled when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Insert as inline link" disabled onChange={onChange} />);

    await user.click(screen.getByRole('checkbox'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('sets the indeterminate DOM property, which has no HTML attribute of its own', () => {
    render(<Checkbox label="Some selected" indeterminate />);

    expect(screen.getByRole('checkbox')).toHaveProperty('indeterminate', true);
  });

  it('clears indeterminate when the caller says the mix has resolved', () => {
    const { rerender } = render(<Checkbox label="Some selected" indeterminate />);
    expect(screen.getByRole('checkbox')).toHaveProperty('indeterminate', true);

    rerender(<Checkbox label="Some selected" indeterminate={false} />);
    expect(screen.getByRole('checkbox')).toHaveProperty('indeterminate', false);
  });

  it('hands the underlying input to a caller-supplied ref without losing indeterminate', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Checkbox label="Some selected" indeterminate ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current?.indeterminate).toBe(true);
  });

  it('clicking the visible label toggles the control, since both sit in one <label>', async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Insert as inline link" />);

    await user.click(screen.getByText('Insert as inline link'));

    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
