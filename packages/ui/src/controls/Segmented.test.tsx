import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Segmented } from './Segmented';

const GRAINS = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
] as const;

describe('Segmented', () => {
  it('announces the set and which member is current', () => {
    render(<Segmented label="Calendar grain" options={GRAINS} value="week" onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'Calendar grain' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-current', 'true');
  });

  it('marks the current member with more than colour', () => {
    render(<Segmented label="Calendar grain" options={GRAINS} value="week" onChange={vi.fn()} />);

    // A person who cannot see the fill still gets `aria-current`, which is the half that reaches
    // them. The others carry nothing rather than `aria-current="false"`, which would say they are
    // all current in some sense.
    expect(screen.getByRole('button', { name: 'Month' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Day' })).not.toHaveAttribute('aria-current');
  });

  it('is not a tablist, and does not claim to be', () => {
    render(<Segmented label="Calendar grain" options={GRAINS} value="week" onChange={vi.fn()} />);

    // Calling these tabs would owe roving tabindex, arrow-key movement, and panels wired by id.
    // Announcing "tab, 2 of 3" while the arrow keys do nothing is worse than not claiming it.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('reports the value that was chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Segmented label="Calendar grain" options={GRAINS} value="week" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Day' }));

    expect(onChange).toHaveBeenCalledWith('day');
  });

  it('holds no state of its own', async () => {
    const user = userEvent.setup();
    render(<Segmented label="Calendar grain" options={GRAINS} value="week" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Day' }));

    // Controlled: the caller owns the value, which here lives in the address. A control that also
    // remembered would disagree with the URL the moment somebody used the back button.
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-current', 'true');
  });

  it('reaches every member from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Segmented label="Calendar grain" options={GRAINS} value="month" onChange={vi.fn()} />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Month' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Week' })).toHaveFocus();
  });
});
