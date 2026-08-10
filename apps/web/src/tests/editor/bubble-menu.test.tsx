import { nixExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode } from 'react';

import { BubbleMenu } from '../../editor/bubble-menu';

/**
 * The bubble menu against a real editor: shown over a real selection, applying the mark through
 * the schema's own command, and read back out of the document's HTML.
 *
 * The colour classes themselves are `prose.ts`'s to render and its tests' to assert; here the
 * contract is the attribute the mark writes, because that is what the stylesheet hooks onto.
 */

let captured: Editor | null = null;

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixExtensions],
    onCreate: ({ editor: created }) => {
      captured = created;
    },
  });

  return (
    <>
      <EditorContent editor={editor} />
      <BubbleMenu editor={editor} />
    </>
  );
}

beforeEach(() => {
  captured = null;
});

/** Renders the harness with `content` in the document and nothing selected yet. */
async function editorWith(content: string): Promise<Editor> {
  render(<Harness />);

  await waitFor(() => {
    expect(captured).not.toBeNull();
  });

  const editor = captured;
  if (editor === null) {
    throw new Error('The editor never reported itself created.');
  }

  // jsdom performs no layout, so the selection has no coordinates to measure. The menu only
  // uses them to position its floating box, which these tests do not assert on.
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  });

  act(() => {
    editor.commands.insertContent(content);
  });

  return editor;
}

/** Selects the given document range, which is what makes the menu appear. */
function select(editor: Editor, from: number, to: number): void {
  act(() => {
    editor.commands.setTextSelection({ from, to });
  });
}

describe('the selection bubble menu', () => {
  it('stays hidden while the selection is a caret', async () => {
    await editorWith('some words');

    expect(screen.queryByRole('toolbar', { name: 'Text colour' })).not.toBeInTheDocument();
  });

  it('appears over selected text with the three colour choices', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    const toolbar = await screen.findByRole('toolbar', { name: 'Text colour' });
    expect(toolbar).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Default colour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accent colour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Muted colour' })).toBeInTheDocument();
  });

  it('applies the accent colour to the selected text as a token name, never a value', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));

    // The document stores the role's name; what it looks like is the stylesheet's decision at
    // render, which is the whole point of a token-named palette.
    expect(editor.getHTML()).toContain('data-text-color="accent"');
    expect(editor.getHTML()).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it('applies the muted colour to the selected text', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Muted colour' }));

    expect(editor.getHTML()).toContain('data-text-color="muted"');
  });

  it('presses the applied colour and releases it when the colour changes', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    // Unmarked text is the default colour, and the menu says so from the start.
    expect(await screen.findByRole('button', { name: 'Default colour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accent colour' }));

    expect(screen.getByRole('button', { name: 'Accent colour' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('removes the mark entirely when the default colour is chosen', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    expect(editor.getHTML()).toContain('data-text-color="accent"');

    fireEvent.click(screen.getByRole('button', { name: 'Default colour' }));

    // Cleared, not stored: writing `text: "default"` would pin today's meaning of ordinary
    // text into the document forever.
    expect(editor.getHTML()).not.toContain('data-text-color');
    expect(editor.getHTML()).not.toContain('textColor');
  });

  it('presses nothing over a selection that mixes coloured and plain text', async () => {
    const editor = await editorWith('some words');

    // Colour the first word only, then select across the boundary.
    select(editor, 1, 5);
    fireEvent.click(await screen.findByRole('button', { name: 'Accent colour' }));
    select(editor, 1, 11);

    // The selection is neither all default nor all accent. Saying "Default colour, pressed"
    // over it would be a lie, and so would "Accent colour, pressed".
    for (const name of ['Default colour', 'Accent colour', 'Muted colour']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('is reachable with the keyboard: Tab reaches the row and Enter applies a colour', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Text colour' });

    // The menu sits after the editable region in the DOM, so Tab from the text reaches it.
    act(() => {
      editor.view.dom.focus();
    });
    await user.tab();

    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveFocus();

    await user.keyboard('{ArrowRight}{Enter}');

    expect(editor.getHTML()).toContain('data-text-color="accent"');
  });

  it('costs one tab stop, roving between its buttons with the arrow keys', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Text colour' });

    act(() => {
      editor.view.dom.focus();
    });
    await user.tab();

    // One stop: the other two buttons are out of the Tab order, as `role="toolbar"` requires.
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Accent colour' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Muted colour' })).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Accent colour' })).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Muted colour' })).toHaveFocus();

    // Home and End are the row's ends, and the arrows wrap around them.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Muted colour' })).toHaveFocus();
  });

  it('keeps the selection when a button is pressed with the pointer', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    const button = await screen.findByRole('button', { name: 'Accent colour' });
    fireEvent.mouseDown(button);

    // The press must not blur the editor: a collapsing selection would take the range being
    // coloured with it, and the click would land on a caret.
    expect(editor.state.selection.empty).toBe(false);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);
  });

  it('stays open when focus moves from the text into the menu', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Text colour' });

    act(() => {
      editor.view.dom.focus();
    });
    await user.tab();

    // Focus arriving in the menu is not focus leaving the editing surface; closing here would
    // shut the menu on the keyboard user in the act of reaching it.
    expect(screen.getByRole('toolbar', { name: 'Text colour' })).toBeInTheDocument();
  });

  it('closes on Escape and puts the caret back in the text', async () => {
    const user = userEvent.setup();
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Text colour' });

    act(() => {
      editor.view.dom.focus();
    });
    await user.tab();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('toolbar', { name: 'Text colour' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(editor.view.dom).toHaveFocus();
    });
    // Dismissing the menu is not an edit: the selection it was offered over is untouched.
    expect(editor.getHTML()).not.toContain('data-text-color');
  });

  it('disables the colours where a mark cannot go, rather than doing nothing quietly', async () => {
    const editor = await editorWith('some words');

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.commands.toggleCodeBlock();
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });

    // A code block admits no marks, so the commands are no-ops there. Saying so is the honest
    // state; a button that looks live and changes nothing teaches people to distrust the menu.
    for (const name of ['Accent colour', 'Muted colour']) {
      expect(await screen.findByRole('button', { name })).toBeDisabled();
    }
  });

  it('announces itself politely when it opens, because it opens away from the focus', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);

    await screen.findByRole('toolbar', { name: 'Text colour' });
    expect(screen.getByText('Text colour options available')).toBeInTheDocument();
  });

  it('closes when the selection collapses back to a caret', async () => {
    const editor = await editorWith('some words');
    select(editor, 1, 5);
    await screen.findByRole('toolbar', { name: 'Text colour' });

    select(editor, 3, 3);

    expect(screen.queryByRole('toolbar', { name: 'Text colour' })).not.toBeInTheDocument();
  });
});
