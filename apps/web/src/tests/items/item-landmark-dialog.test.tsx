import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ItemLandmarkDialog } from '../../items/item-landmark-dialog';

describe('personal item landmarks', () => {
  it('saves the chosen icon and colour only when Save is pressed', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const close = vi.fn();
    render(<ItemLandmarkDialog title="Journal" onSave={save} onClose={close} />);
    expect(screen.getByRole('dialog', { name: 'Icon for Journal' })).toHaveTextContent(
      'in this browser',
    );
    await user.click(screen.getByRole('button', { name: 'Notebook' }));
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Notebook' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Save icon' }));
    expect(save).toHaveBeenCalledWith({ icon: 'notebook', tone: 'accent' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('discards an unsaved choice when closed', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const close = vi.fn();
    render(<ItemLandmarkDialog title="Journal" onSave={save} onClose={close} />);
    await user.click(screen.getByRole('button', { name: 'Wallet' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(save).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('resets a saved landmark to the ordinary page icon', async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(
      <ItemLandmarkDialog
        title="Journal"
        landmark={{ icon: 'heart', tone: 'accent' }}
        onSave={save}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Heart' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Reset icon' }));
    expect(save).toHaveBeenCalledWith(null);
  });
});
