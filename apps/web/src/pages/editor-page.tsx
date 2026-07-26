import { Button, Icon } from '@nix/ui';
import { FilePlus, Folder, StickyNote } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useWorkspaceTree, type TreeItem } from '../items/use-workspace-tree';

/**
 * The editor screen: a tree on the left, the note being written on the right.
 *
 * This is the screen that makes the product real, so its states are the ones most worth being
 * honest about. Loading, empty, error and saving are all distinct, and none of them is a spinner
 * standing in for the others - a person who has just typed a sentence needs to know whether it is
 * saved, and "something is happening" does not answer that.
 */
export function EditorPage(): ReactNode {
  const tree = useWorkspaceTree();
  const [draft, setDraft] = useState('');
  const selectedId = tree.selected?.id ?? '';

  return (
    <>
      <aside className="w-[264px] shrink-0 border-r border-divider bg-neutral-100">
        <div className="flex items-center border-b border-divider px-4 py-3">
          <span className="text-[11px] uppercase tracking-[0.08em] text-foreground/60">Tree</span>
          <Button
            variant="ghost"
            className="ml-auto px-2 py-1 text-[11px]"
            onClick={() => void tree.createNote('Untitled note')}
            disabled={tree.status === 'loading' || tree.isCreating}
          >
            <Icon icon={FilePlus} size="sm" />
            {tree.isCreating ? 'Creating…' : 'New note'}
          </Button>
        </div>

        <TreeBody tree={tree} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Note">
        {tree.selected === null ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="max-w-sm text-sm text-foreground/60">
              {tree.status === 'ready' && tree.items.length === 0
                ? 'This workspace has no items yet. Create a note to begin.'
                : 'Select a note from the tree, or create one.'}
            </p>
          </div>
        ) : (
          <NoteEditor
            key={tree.selected.id}
            item={tree.selected}
            draft={draft}
            onDraftChange={setDraft}
            onRename={(title) => {
              void tree.rename(selectedId, title);
            }}
            isSaving={tree.isRenaming}
            savedAt={tree.lastSavedAt}
          />
        )}
      </section>
    </>
  );
}

function TreeBody({ tree }: { readonly tree: ReturnType<typeof useWorkspaceTree> }): ReactNode {
  if (tree.status === 'loading') {
    return <p className="px-4 py-3 text-[12px] text-foreground/60">Loading the tree…</p>;
  }

  if (tree.status === 'error') {
    return (
      <div role="alert" className="px-4 py-3">
        <p className="mb-2 text-[12px] text-foreground/70">{tree.error}</p>
        <Button
          variant="secondary"
          className="px-2 py-1 text-[11px]"
          onClick={() => void tree.reload()}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (tree.items.length === 0) {
    return (
      <p className="px-4 py-3 text-[12px] text-foreground/60">
        Nothing here yet. &ldquo;New note&rdquo; creates the first item.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {tree.items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => {
              tree.select(item.id);
            }}
            aria-current={tree.selected?.id === item.id ? 'true' : undefined}
            className={[
              'flex w-full items-center gap-2 border-b border-divider px-4 py-2 text-left text-[13px]',
              'hover:bg-accent-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              tree.selected?.id === item.id ? 'bg-accent-100' : '',
            ].join(' ')}
          >
            <Icon icon={item.type === 'folder' ? Folder : StickyNote} size="sm" />
            <span className="truncate">{item.title || 'Untitled'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

interface NoteEditorProps {
  readonly item: TreeItem;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onRename: (title: string) => void;
  readonly isSaving: boolean;
  readonly savedAt: string | null;
}

function NoteEditor({
  item,
  draft,
  onDraftChange,
  onRename,
  isSaving,
  savedAt,
}: NoteEditorProps): ReactNode {
  const [title, setTitle] = useState(item.title);

  return (
    <article className="flex flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-divider px-8 py-4">
        <input
          aria-label="Note title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onBlur={() => {
            if (title !== item.title) {
              onRename(title);
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-heading text-[26px] uppercase leading-none outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        {/* The one state a writer actually needs, said plainly. */}
        <span className="shrink-0 text-[11px] text-foreground/60">
          {isSaving ? 'Saving…' : savedAt === null ? 'Not saved yet' : `Title saved ${savedAt}`}
        </span>
      </div>

      <textarea
        aria-label="Note body"
        value={draft}
        onChange={(event) => {
          onDraftChange(event.target.value);
        }}
        placeholder="Write…"
        className="min-h-0 flex-1 resize-none bg-transparent px-8 py-6 text-[15px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />

      <footer className="border-t border-divider px-8 py-2 text-[11px] text-foreground/60">
        {/* Honest about what is and is not persisted yet: the title round-trips to Core, the body
            does not, because the collaborative document store is a later milestone. Saying so is
            better than a "saved" indicator that covers only half the screen. */}
        Body text is local to this browser until the collaboration service lands. The title is
        stored.
      </footer>
    </article>
  );
}
