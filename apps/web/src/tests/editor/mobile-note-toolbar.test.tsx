import { nixEditingExtensions } from '@nix/editor-schema';
import { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
    state: { selection: { empty: true } },
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

it('reveals writing tools for selected text and keeps them open after formatting', async () => {
  useMobileToolbarPreference.setState({ visibility: 'while-writing' });
  const editor = new Editor({
    extensions: [...nixEditingExtensions],
    content: '<p>Some words</p>',
  });
  document.body.append(editor.view.dom);
  const view = render(
    <MobileNoteToolbar
      editor={editor}
      formatting={<button onClick={() => editor.chain().focus().toggleBold().run()}>Bold</button>}
    />,
  );
  act(() => {
    editor.view.focus();
    editor.commands.setTextSelection(2);
    editor.commands.insertContent('x');
  });
  expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();

  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
  });
  const bold = screen.getByRole('button', { name: 'Bold' });
  expect(fireEvent.mouseDown(bold)).toBe(false);
  await userEvent.click(bold);
  expect(editor.isActive('bold')).toBe(true);
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(5);
  expect(bold).toBeInTheDocument();
  view.unmount();
  editor.destroy();
});
