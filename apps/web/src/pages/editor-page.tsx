import { Button, Icon } from '@nix/ui';
import { Settings2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router';

import type { ShellContext } from '../app/app-shell';
import { NoteEditor } from '../editor/note-editor';
import { PropertyPanel } from '../properties/property-panel';
import { useItemProperties } from '../properties/use-item-properties';
import { useSelectedItem } from '../routing/selected-item';
import { ContainerView } from '../views/container-view';
import { DOCUMENT_VIEW, type View } from '../views/container-model';
import { SchemaEditor } from '../views/schema-editor';
import { useContainer } from '../views/use-container';
import { ViewEditor } from '../views/view-editor';
import { useViewState } from '../views/view-state';
import { ViewSwitcher } from '../views/view-switcher';

/**
 * One item, open.
 *
 * **There is one kind of item, and this is its one screen.** It used to fork: a folder opened into
 * its views and could not hold a document, a note opened into an editor and could not hold
 * anything. That split was never in the schema - every row has always had a parent, a property
 * schema and a views column - so it was the interface refusing what the data allowed.
 *
 * What is left is two axes, and keeping them distinct is the thing to preserve here:
 *
 * - the item's **body**, which is its own content, and
 * - its **views**, which are ways of looking at its children.
 *
 * Only one is on screen at a time, so one switcher chooses, and the item remembers the choice. An
 * item nobody has configured a view on shows its body and no chrome whatsoever, which is every
 * plain note - the switcher returns nothing rather than offering a single "Document" tab.
 *
 * The tree is not here. It belongs to the shell, because it is how you move around the product
 * rather than part of this screen.
 */
export function EditorPage(): ReactNode {
  const { tree, selectedId } = useOutletContext<ShellContext>();
  const { select } = useSelectedItem();
  const item = selectedId === null ? null : tree.find(selectedId);

  if (selectedId === null || item === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="max-w-sm text-sm text-muted">
          {tree.status === 'loading'
            ? 'Loading the workspace…'
            : tree.childrenOf(null).length === 0
              ? 'This workspace has no items yet. Create a note to begin.'
              : 'Select a note from the tree, or create one.'}
        </p>
      </div>
    );
  }

  // Keyed on the item throughout: switching notes has to build a new Yjs document and a new title
  // draft rather than reuse one, which is the failure that would otherwise carry one note's text
  // into another.
  return <OpenItem key={item.id} tree={tree} itemId={item.id} title={item.title} onOpen={select} />;
}

interface OpenItemProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly onOpen: (itemId: string) => void;
}

function OpenItem({ tree, itemId, title, onOpen }: OpenItemProps): ReactNode {
  const container = useContainer(itemId);
  const { viewId, selectView } = useViewState();
  const [editing, setEditing] = useState<'schema' | 'views' | null>(null);

  const views = useMemo(() => container.views?.views ?? [], [container.views]);
  const unrenderable = container.views?.unrenderable ?? [];

  // What the item says opens, unless the address says otherwise. The URL wins because it is the
  // more specific statement - somebody chose it, possibly in a link they were handed - and the
  // stored default is the starting point rather than the authority.
  const activeId = viewId ?? container.views?.default ?? DOCUMENT_VIEW;

  const active = useMemo<View | null>(
    () => views.find((view) => view.id === activeId) ?? null,
    [activeId, views],
  );

  // The body, when nothing else was chosen or when what was chosen is not a view this item has.
  const showingDocument = active === null;

  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <ItemHeader tree={tree} itemId={itemId} title={title} onNavigate={onOpen} />

      <div className="flex items-center border-b border-divider">
        <div className="min-w-0 flex-1">
          <ViewSwitcher
            views={views}
            unrenderable={unrenderable}
            activeViewId={showingDocument ? DOCUMENT_VIEW : activeId}
            documentLabel="Document"
            onSelect={(chosen) => {
              selectView(chosen);

              // The deliberate click, and the only place the stored default is written. Arriving at
              // a URL that already carries ?view= runs none of this - otherwise following somebody
              // else's link would rewrite what this item opens as, for everybody, on behalf of the
              // person who followed it.
              void container.setDefaultView(chosen);
            }}
          />
        </div>

        {/* Both editors live here rather than in a settings page, because they configure this item
            and nothing else. Somebody who wants a board wants it for the item they are looking at,
            and sending them elsewhere to say so loses their place. */}
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              setEditing('schema');
            }}
          >
            <Icon icon={Settings2} size="sm" />
            Properties
          </Button>

          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              setEditing('views');
            }}
          >
            Views
          </Button>
        </div>
      </div>

      <SchemaEditor
        container={container}
        open={editing === 'schema'}
        onClose={() => {
          setEditing(null);
        }}
      />

      <ViewEditor
        container={container}
        open={editing === 'views'}
        onClose={() => {
          setEditing(null);
        }}
      />

      {showingDocument ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <NoteEditor itemId={itemId} />
          </div>

          <ItemProperties itemId={itemId} onSaved={tree.reload} />
        </div>
      ) : (
        <section aria-label="Container" className="flex min-h-0 flex-1 flex-col">
          {/* A refused write. Reported once, by the view that made it - the renderer knows what
              snapped back and where, which is what somebody needs, and a second banner above it
              said the same thing in different words. */}
          {container.writeError === null ? null : (
            <p
              role="alert"
              className="flex items-center gap-2 border-b border-divider px-4 py-2 text-sm text-foreground"
            >
              <Icon icon={TriangleAlert} size="sm" />
              {container.writeError}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            <ContainerView container={container} view={active} onOpen={onOpen} />
          </div>
        </section>
      )}
    </article>
  );
}

/**
 * The item's properties, beside its body.
 *
 * Beside rather than above, because a property panel that pushed the document down the page would
 * cost every reader the top of every note to serve the far rarer act of editing a field.
 */
function ItemProperties({
  itemId,
  onSaved,
}: {
  readonly itemId: string;
  readonly onSaved: () => Promise<void>;
}): ReactNode {
  const { loading, schema, item, write } = useItemProperties(itemId);

  // An item under no schema has nothing to show, and a panel saying so on every note would be a
  // permanent apology. The Properties editor above is where somebody goes to change that.
  if (!loading && (schema === null || schema.properties.length === 0)) {
    return null;
  }

  // Still arriving. The panel draws its own loading state, but it needs an item to draw values
  // from, and inventing an empty one would flash a panel of blank fields over real values.
  if (item === null) {
    return (
      <aside
        aria-label="Properties"
        className="w-[280px] shrink-0 border-l border-divider px-4 py-4"
      >
        <p className="text-sm text-muted">Loading this item&rsquo;s properties…</p>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Properties"
      className="w-[280px] shrink-0 overflow-y-auto border-l border-divider px-4 py-4"
    >
      <PropertyPanel
        item={item}
        properties={schema?.properties ?? []}
        loading={loading}
        onChange={async (changes) => {
          const refusal = await write(changes);

          // Reloaded on success so the tree - and anything reading a title or a property from it -
          // matches what was just written, rather than only this panel knowing.
          if (refusal === null) {
            await onSaved();
          }

          return refusal;
        }}
      />
    </aside>
  );
}

interface ItemHeaderProps {
  readonly tree: ShellContext['tree'];
  readonly itemId: string;
  readonly title: string;
  readonly onNavigate: (itemId: string) => void;
}

function ItemHeader({ tree, itemId, title, onNavigate }: ItemHeaderProps): ReactNode {
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
        className="w-full bg-transparent font-heading text-2xl uppercase outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </header>
  );
}
