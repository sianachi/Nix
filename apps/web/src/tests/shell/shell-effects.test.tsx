import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@nix/ui';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useShellShortcuts } from '../../shell/shell-effects';

function Harness({
  onNewNote,
  children,
}: {
  readonly onNewNote: () => void;
  readonly children: ReactNode;
}): ReactNode {
  useShellShortcuts({
    search: () => undefined,
    'new-note': onNewNote,
    'toggle-sidebar': () => undefined,
    zen: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    shortcuts: () => undefined,
  });
  return children;
}

describe('shell shortcuts', () => {
  it('creates a note from a text field on the page', async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    render(
      <Harness onNewNote={onNewNote}>
        <input aria-label="Page field" />
      </Harness>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Page field' }));
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');

    expect(onNewNote).toHaveBeenCalledOnce();
  });

  it('does not create a note from a field inside a native modal', async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    const onClose = vi.fn();
    render(
      <Harness onNewNote={onNewNote}>
        <Dialog open title="Rename note" onClose={onClose}>
          <input aria-label="Note title" />
        </Dialog>
      </Harness>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Note title' }));
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');

    expect(onNewNote).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Rename note' })).toBeInTheDocument();
    // jsdom reports native dismissal through cancel rather than translating Escape.
    fireEvent(
      screen.getByRole('dialog', { name: 'Rename note' }),
      new Event('cancel', { cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not create a note from a field inside an ARIA modal', async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    render(
      <Harness onNewNote={onNewNote}>
        <div role="dialog" aria-modal="true" aria-label="Edit note">
          <input aria-label="Note title" />
        </div>
      </Harness>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Note title' }));
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');

    expect(onNewNote).not.toHaveBeenCalled();
  });

  it('leaves a modal control free to handle its own shortcut', async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    const onLocalShortcut = vi.fn();
    render(
      <Harness onNewNote={onNewNote}>
        <Dialog open title="Edit note" onClose={() => undefined}>
          <input
            aria-label="Note title"
            onKeyDown={(event) => {
              if (event.ctrlKey && event.altKey && event.key === 'n') {
                event.preventDefault();
                onLocalShortcut();
              }
            }}
          />
        </Dialog>
      </Harness>,
    );

    await user.click(screen.getByRole('textbox', { name: 'Note title' }));
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');

    expect(onLocalShortcut).toHaveBeenCalledOnce();
    expect(onNewNote).not.toHaveBeenCalled();
  });
});
