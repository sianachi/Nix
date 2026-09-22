import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LockDialog } from '../../locks/lock-dialog';
import { LockedBody } from '../../locks/locked-body';

/**
 * The two places somebody meets a lock: the prompt that stands where the body would be, and the
 * dialog that sets, changes and removes it.
 */

describe('the locked body', () => {
  it('names what is locked and says a lock hides the text rather than encrypting it', () => {
    render(<LockedBody title="Diary" noun="note" onUnlock={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Diary is locked' })).toBeInTheDocument();
    expect(screen.getByText(/it is not encryption/)).toBeInTheDocument();
    // A first visit does not pull focus into the form.
    expect(screen.getByLabelText('Password')).not.toHaveFocus();
  });

  it('says why it closed and takes focus when it replaces a body that ran out of time', () => {
    render(<LockedBody title="Diary" noun="note" reason="expired" onUnlock={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('locked again after 15 minutes');
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('opens with the right password', async () => {
    const onUnlock = vi.fn(() => Promise.resolve(null));
    render(<LockedBody title="Diary" noun="note" onUnlock={onUnlock} />);

    await userEvent.type(screen.getByLabelText('Password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(onUnlock).toHaveBeenCalledWith('hunter22');
  });

  it('says why a wrong password was refused, clears the field and keeps focus on it', async () => {
    render(
      <LockedBody
        title="Diary"
        noun="note"
        onUnlock={() => Promise.resolve('That password is not right.')}
      />,
    );
    const field = screen.getByLabelText('Password');

    await userEvent.type(field, 'guess');
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('That password is not right.')).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('asks for a password before asking the server', async () => {
    const onUnlock = vi.fn();
    render(<LockedBody title="Diary" noun="note" onUnlock={onUnlock} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(screen.getByText('Enter the password.')).toBeInTheDocument();
    expect(onUnlock).not.toHaveBeenCalled();
  });
});

describe('the lock dialog', () => {
  function renderDialog(locked: boolean) {
    const handlers = {
      onClose: vi.fn(),
      onSetLock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
      onRemoveLock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
      onRelock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
    };
    render(<LockDialog title="Diary" noun="note" locked={locked} {...handlers} />);
    return handlers;
  }

  it('says what a lock costs before it is set, and starts in the password field', () => {
    renderDialog(false);

    expect(
      screen.getByText(/does not appear in search and it cannot be exported/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nobody can open this note or remove the lock/)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('locks an unlocked note once the password is confirmed', async () => {
    const handlers = renderDialog(false);

    await userEvent.type(screen.getByLabelText('Password'), 'hunter22');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Lock note' }));

    expect(handlers.onSetLock).toHaveBeenCalledWith('hunter22', undefined);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('refuses a short password or a mismatched confirmation without asking the server', async () => {
    const handlers = renderDialog(false);

    await userEvent.type(screen.getByLabelText('Password'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Lock note' }));
    expect(screen.getByText('Use a password of 4 to 256 characters.')).toBeInTheDocument();

    expect(screen.getByLabelText('Password')).toHaveFocus();

    await userEvent.type(screen.getByLabelText('Password'), 'd');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'abcx');
    await userEvent.click(screen.getByRole('button', { name: 'Lock note' }));
    expect(screen.getByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toHaveFocus();

    expect(handlers.onSetLock).not.toHaveBeenCalled();
  });

  it('offers relocking, changing and removing for a note that is locked and open', async () => {
    const handlers = renderDialog(true);

    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lock now' }));

    expect(handlers.onRelock).toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove lock' })).toBeInTheDocument();
  });

  it('returns focus to the button that opened a form when it is cancelled', async () => {
    renderDialog(true);

    await userEvent.click(screen.getByRole('button', { name: 'Remove lock' }));
    expect(screen.getByLabelText('Current password')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Remove lock' })).toHaveFocus();
  });

  it('shows why locking again failed and stays open', async () => {
    const handlers = renderDialog(true);
    handlers.onRelock.mockResolvedValueOnce('This could not be locked again. Try again.');

    await userEvent.click(screen.getByRole('button', { name: 'Lock now' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be locked again');
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('changes a password by sending the current one with the new one', async () => {
    const handlers = renderDialog(true);

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await userEvent.type(screen.getByLabelText('Current password'), 'hunter22');
    await userEvent.type(screen.getByLabelText('New password'), 'rotated!');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'rotated!');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(handlers.onSetLock).toHaveBeenCalledWith('rotated!', 'hunter22');
  });

  it('removes a lock only with its password, and reports a refusal on that field', async () => {
    const handlers = renderDialog(true);
    handlers.onRemoveLock.mockResolvedValueOnce('That password is not right.');

    await userEvent.click(screen.getByRole('button', { name: 'Remove lock' }));
    await userEvent.type(screen.getByLabelText('Current password'), 'guess');
    await userEvent.click(screen.getByRole('button', { name: 'Remove lock' }));

    expect(handlers.onRemoveLock).toHaveBeenCalledWith('guess');
    expect(await screen.findByText('That password is not right.')).toBeInTheDocument();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});
