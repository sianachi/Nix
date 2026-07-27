import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';

import type { ShellContext } from '../app/app-shell';
import { NoteEditor } from '../editor/note-editor';
import { useSelectedItem } from '../routing/selected-item';
import { ContainerPage } from './container-page';

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
  const { select } = useSelectedItem();
  const item = selectedId === null ? null : tree.find(selectedId);

  if (selectedId === null || item === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-sm text-sm text-neutral-700">
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
    // A folder is not a document, so it opens into its views rather than into an editor. Which
    // view is a property of the folder and of the URL - see ContainerPage - and switching between
    // them does not navigate anywhere, because the same folder is still open.
    return (
      <article className="flex min-w-0 flex-1 flex-col">
        <NoteHeader
          key={item.id}
          tree={tree}
          itemId={item.id}
          title={item.title}
          onNavigate={select}
        />
        <ContainerPage key={item.id} containerId={item.id} onOpen={select} />
      </article>
    );
  }

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <NoteHeader
        key={item.id}
        tree={tree}
        itemId={item.id}
        title={item.title}
        onNavigate={select}
      />
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
  readonly onNavigate: (itemId: string) => void;
}

function NoteHeader({ tree, itemId, title, onNavigate }: NoteHeaderProps): ReactNode {
  const trail = tree.breadcrumbs(itemId);
  // Keyed on the item by its caller, so the draft is rebuilt rather than carried. A title held in
  // state and not reset is the classic mirrored-prop bug: navigating from one note to another would
  // leave the previous note's name in the field, and the next blur would save it onto the new one.
  const [draft, setDraft] = useState(title);
  const titleRef = useRef<HTMLInputElement>(null);

  // A freshly created item arrives called "Untitled note" and the next thing anybody does is name
  // it. Selecting the placeholder means that is one keystroke rather than a click, a select-all and
  // a keystroke - and because the text is selected rather than cleared, somebody who came here to
  // read instead of rename loses nothing by clicking away.
  useEffect(() => {
    if (title.startsWith('Untitled')) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [itemId, title]);

  return (
    <header className="border-b border-divider px-8 pb-3 pt-4">
      {trail.length > 1 ? (
        <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center text-xs">
          {trail.slice(0, -1).map((ancestor) => (
            <span key={ancestor.id} className="flex items-center">
              {/* Navigable, not decorative. A trail that shows where you are and cannot take you
                  there is a label pretending to be a control, and everybody tries to click it. */}
              <button
                type="button"
                onClick={() => {
                  onNavigate(ancestor.id);
                }}
                className="text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {ancestor.title || 'Untitled'}
              </button>
              <span aria-hidden="true" className="px-1 text-muted">
                /
              </span>
            </span>
          ))}
        </nav>
      ) : null}

      <input
        ref={titleRef}
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
