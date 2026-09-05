import type { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { MobileNoteToolbar } from '../../editor/mobile-note-toolbar';

it('switches between formatting and item actions without stacking them', async () => {
  const user = userEvent.setup();
  render(
    <MobileNoteToolbar formatting={<button>Bold</button>} actions={<button>Children</button>} />,
  );
  expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Children' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Item' }));
  expect(screen.getByRole('button', { name: 'Children' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();
});

it('remembers the visibility choice across toolbar mounts', async () => {
  const user = userEvent.setup();
  const view = render(<MobileNoteToolbar formatting={<button>Bold</button>} />);
  await user.click(screen.getByRole('checkbox', { name: 'Hide while writing' }));
  view.unmount();
  render(<MobileNoteToolbar formatting={<button>Bold</button>} />);
  expect(screen.getByRole('checkbox', { name: 'Hide while writing' })).toBeChecked();
  await user.click(screen.getByRole('checkbox', { name: 'Hide while writing' }));
});

it('hides on typing and lets the user reveal the tools', async () => {
  const listeners = new Set<() => void>();
  const editor = {
    isFocused: true,
    on: (_event: string, listener: () => void) => {
      listeners.add(listener);
    },
    off: (_event: string, listener: () => void) => {
      listeners.delete(listener);
    },
  } as unknown as Editor;
  const user = userEvent.setup();
  render(<MobileNoteToolbar formatting={<button>Bold</button>} editor={editor} />);
  await user.click(screen.getByRole('checkbox', { name: 'Hide while writing' }));
  act(() => {
    listeners.forEach((listener) => {
      listener();
    });
  });
  expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show writing tools' }));
  expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Hide while writing' }));
});
