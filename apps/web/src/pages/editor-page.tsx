import { useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';

import type { ShellContext } from '../app/app-shell';
import { NoteEditor } from '../editor/note-editor';

/**
 * The note being written: a title, a trail of where it sits, and the body.
 *
 * The tree is not here - it belongs to the shell, because it is how you move around the product
 * rather than part of this screen. What is left is the document itself, which is what this screen
 * is for.
 *
 * Nothing is open until something is selected, and the empty state says which of the two reasons
 * applies: an empty workspace and an unopened note are different situations with different next
 * steps, and one message covering both helps with neither.
 */
export function EditorPage(): ReactNode {
  const { tree, selectedId } = useOutletContext<ShellContext>();
  const item = selectedId === null ? null : tree.find(selectedId);

  if (selectedId === null || item === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-sm text-sm text-foreground/60">
          {tree.status === 'loading'
            ? 'Loading the workspace…'
            : tree.childrenOf(null).length === 0
              ? 'This workspace has no items yet. Create a note to begin.'
              : 'Select a note from the tree, or create one.'}
        </p>
      </div>
    );
  }

  if (item.type === 'folder') {
    const children = tree.childrenOf(item.id);

    return (
      <article className="flex min-w-0 flex-1 flex-col">
        <NoteHeader tree={tree} itemId={item.id} title={item.title} />
        <div className="px-8 py-6">
          <p className="text-sm text-foreground/60">
            {children.length === 0
              ? 'This folder is empty.'
              : `${String(children.length)} item${children.length === 1 ? '' : 's'} inside.`}
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <NoteHeader tree={tree} itemId={item.id} title={item.title} />
      {/* Keyed on the item so switching notes builds a new Yjs document rather than reusing one -
          the failure that would otherwise carry one note's text into another. */}
      <NoteEditor key={item.id} itemId={item.id} />
    </article>
  );
}

interface NoteHeaderProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
}

function NoteHeader({ tree, itemId, title }: NoteHeaderProps): ReactNode {
  const trail = tree.breadcrumbs(itemId);
  const [draft, setDraft] = useState(title);

  return (
    <header className="border-b border-divider px-8 pb-3 pt-4">
      {trail.length > 1 ? (
        <nav aria-label="Breadcrumb" className="mb-1 text-[11px] text-foreground/60">
          {trail.slice(0, -1).map((ancestor) => (
            <span key={ancestor.id}>
              {ancestor.title || 'Untitled'}
              <span aria-hidden="true"> / </span>
            </span>
          ))}
        </nav>
      ) : null}

      <input
        aria-label="Note title"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          // On blur rather than on every keystroke: a rename is a write to the item row, and one
          // per character would be a request per character.
          if (draft !== title) {
            void tree.rename(itemId, draft);
          }
        }}
        className="w-full bg-transparent font-heading text-[26px] uppercase leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </header>
  );
}
