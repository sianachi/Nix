import { nixSchema } from '@nix/editor-schema';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { snapshotMarkdown } from '../../editor/markdown-mode';
import { MarkdownLossesDialog, MarkdownModePanel } from '../../editor/markdown-mode-panel';

function note(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
    fragment,
  );
  return { doc, fragment };
}

it('applies edited Markdown to the note and closes, and cancels without writing', async () => {
  const user = userEvent.setup();
  const { doc, fragment } = note();
  const onClose = vi.fn();
  render(
    <MarkdownModePanel doc={doc} fragment={fragment} snapshot={snapshotMarkdown(fragment)} onClose={onClose} />,
  );
  const box = screen.getByRole('textbox', { name: 'Note as Markdown' });
  expect(box).toHaveDisplayValue(/^Body\s*$/);
  await user.clear(box);
  await user.type(box, '# Title');
  await user.click(screen.getByRole('button', { name: 'Apply Markdown' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  const json = yXmlFragmentToProseMirrorRootNode(fragment, nixSchema).toJSON() as { content: { type: string }[] };
  expect(json.content[0]?.type).toBe('heading');
});

it('warns when a colleague changed the note and asks before replacing their change', async () => {
  const user = userEvent.setup();
  const { doc, fragment } = note();
  render(
    <MarkdownModePanel doc={doc} fragment={fragment} snapshot={snapshotMarkdown(fragment)} onClose={vi.fn()} />,
  );
  const other = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    nixSchema,
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Theirs' }] }] },
    other.getXmlFragment('default'),
  );
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');
  expect(await screen.findByText(/Someone changed this note/)).toBeVisible();

  await user.type(screen.getByRole('textbox', { name: 'Note as Markdown' }), ' more');
  await user.click(screen.getByRole('button', { name: 'Apply Markdown' }));
  expect(screen.getByRole('dialog', { name: 'Replace their change?' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('lists the losses before entering and lets the person cancel', async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(
    <MarkdownLossesDialog
      snapshot={{ markdown: '', losses: [{ kind: 'columns', detail: 'Columns are flattened.' }] }}
      onContinue={vi.fn()}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByText('Columns are flattened.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalled();
});
