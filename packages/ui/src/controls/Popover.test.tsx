import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Popover } from './Popover';

function Subject(props: { readonly onOpenChange?: (open: boolean) => void }) {
  return (
    <>
      <Popover
        label="Filter"
        trigger={(trigger) => <button {...trigger}>Filter</button>}
        {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}
      >
        {({ close }) => (
          <>
            <label>
              Status
              <input />
            </label>
            <button type="button" onClick={close}>
              Done
            </button>
          </>
        )}
      </Popover>
      <button type="button">Elsewhere</button>
    </>
  );
}

describe('Popover', () => {
  it('discloses a labelled dialog, not a menu, and moves focus into it', async () => {
    const user = userEvent.setup();
    render(<Subject />);

    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeVisible();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Status' })).toHaveFocus();
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<Subject />);

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
  });

  it('closes on a press outside it, and from its own content', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<Subject onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([true, false, true, false]);
  });
});
