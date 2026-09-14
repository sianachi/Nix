import type { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { MobileNoteToolbar } from '../../editor/mobile-note-toolbar';
import { useMobileToolbarPreference } from '../../editor/mobile-toolbar-preference';
import { EditorPreferencesSection } from '../../settings/editor-preferences-section';

beforeEach(() => {
  useMobileToolbarPreference.setState({ visibility: 'always', saved: true });
});
it('opens item actions in a separate sheet', async () => {
  render(
    <MobileNoteToolbar formatting={<button>Bold</button>} actions={<button>Children</button>} />,
  );
  expect(screen.queryByRole('button', { name: 'Children' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Item' }));
  expect(screen.getByRole('dialog', { name: 'Item actions' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Children' })).toBeInTheDocument();
});
it('keeps visibility preferences in settings, outside the writing toolbar', async () => {
  render(
    <>
      <EditorPreferencesSection />
      <MobileNoteToolbar formatting={<button>Bold</button>} />
    </>,
  );
  await userEvent.click(screen.getByRole('checkbox', { name: 'Hide mobile tools while writing' }));
  expect(useMobileToolbarPreference.getState().visibility).toBe('while-writing');
});
it('hides on typing, reveals on demand, and releases its subscription', async () => {
  useMobileToolbarPreference.setState({ visibility: 'while-writing' });
  const listeners = new Set<() => void>();
  const blur = vi.fn();
  const editor = {
    isFocused: true,
    commands: { blur },
    on: (_: string, listener: () => void) => listeners.add(listener),
    off: (_: string, listener: () => void) => listeners.delete(listener),
  } as unknown as Editor;
  const view = render(<MobileNoteToolbar formatting={<button>Bold</button>} editor={editor} />);
  act(() => {
    listeners.forEach((listener) => {
      listener();
    });
  });
  expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Show writing tools' }));
  expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(blur).toHaveBeenCalledOnce();
  view.unmount();
  expect(listeners.size).toBe(0);
});
