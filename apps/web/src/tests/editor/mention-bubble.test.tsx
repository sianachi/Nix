import type { Mentions } from '@nix/api-client';
import { nixEditingExtensions } from '@nix/editor-schema';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MentionBubble } from '../../editor/mention-bubble';
import {
  IDLE_MS,
  mentionsIn,
  setMentionContext,
  UnlinkedMentions,
} from '../../editor/unlinked-mentions';
import { readDismissals } from '../../lib/suggestion-dismissals';

/**
 * The "Link to" bubble against a real editor: it appears when the caret is moved into an
 * underlined phrase, not while somebody types through one.
 */

const WORKSPACE = 'w-1';
const ATLAS = 'item-atlas';

let captured: Editor | null = null;

/** An in-memory `Storage`: the test environment's global is not a usable one. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const ANSWER: Mentions = {
  mentions: [
    {
      item: {
        id: ATLAS,
        workspaceId: WORKSPACE,
        type: 'note',
        title: 'Project Atlas',
        parentId: null,
        updatedAt: '2026-09-01T00:00:00Z',
      },
      phrase: 'Project Atlas',
    },
  ],
  truncated: false,
};

function Harness(): ReactNode {
  const editor = useEditor({
    extensions: [...nixEditingExtensions, UnlinkedMentions],
    content: '<p>Notes on Project Atlas</p>',
    onCreate: ({ editor: created }) => {
      captured = created;
      setMentionContext(created, {
        enabled: true,
        workspaceId: WORKSPACE,
        currentItemId: 'note',
        find: () => Promise.resolve(ANSWER),
      });
    },
  });
  return (
    <>
      <EditorContent editor={editor} />
      <MentionBubble editor={editor} />
    </>
  );
}

/** Renders, types at the end, and lets the lookup answer: the caret ends beside the mention. */
async function underlinedByTyping(): Promise<Editor> {
  render(<Harness />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const editor = captured;
  if (editor === null) throw new Error('The editor never reported itself created.');
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0 });
  act(() => {
    editor.commands.focus();
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' today');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
  });
  expect(mentionsIn(editor.state)).toHaveLength(1);
  return editor;
}

function moveCaretInto(editor: Editor): void {
  act(() => {
    editor.commands.setTextSelection(12);
  });
}

beforeEach(() => {
  captured = null;
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the mention bubble', () => {
  it('stays out of the way while somebody is typing', async () => {
    const editor = await underlinedByTyping();
    // Deleting back to the end of the title leaves the caret touching it, by an edit.
    act(() => {
      editor.commands.deleteRange({ from: 23, to: editor.state.doc.content.size - 1 });
    });
    expect(mentionsIn(editor.state)).toHaveLength(1);
    expect(editor.state.selection.head).toBe(23);

    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
  });

  it('appears when the caret is moved into an underlined phrase', async () => {
    const editor = await underlinedByTyping();

    moveCaretInto(editor);

    expect(screen.getByRole('button', { name: 'Link to Project Atlas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t suggest this' })).toBeInTheDocument();
  });

  it('hides for that mention on Escape', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.keyDown(editor.view.dom, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
    act(() => {
      editor.commands.setTextSelection(13);
    });
    expect(screen.queryByRole('button', { name: /Link to/ })).not.toBeInTheDocument();
  });

  it('stops suggesting the item in this workspace when asked to', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Don’t suggest this' }));

    expect(readDismissals().has(`mention:${WORKSPACE}:${ATLAS}`)).toBe(true);
    expect(mentionsIn(editor.state)).toHaveLength(0);
  });

  it('links the mention from its button', async () => {
    const editor = await underlinedByTyping();
    moveCaretInto(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Link to Project Atlas' }));

    const references: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'reference') references.push(String(node.attrs.targetId));
    });
    expect(references).toEqual([ATLAS]);
  });
});
